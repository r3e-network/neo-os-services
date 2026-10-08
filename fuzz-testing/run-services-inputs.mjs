import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Build separately: the 55-second CI watchdog covers randomized execution,
// including both process startups, but not dependency installation/compilation.
const [buildLog, rawSeconds = '3'] = process.argv.slice(2);
const seconds = Number(rawSeconds);
assert(
  buildLog && Number.isInteger(seconds) && seconds >= 0 && seconds <= 600,
  'usage: node fuzz-testing/run-services-inputs.mjs <cargo-json-log> [seconds-per-suite]'
);
// Committed seeds. A run must explore these streams; a suite that prints no
// receipt, or one for other seeds, fails instead of passing silently.
const COMMITTED_SEEDS = [20261005, 20260928, 4294967295];
const expectedSeeds = process.env.FUZZ_SEED ? [Number(process.env.FUZZ_SEED)] : COMMITTED_SEEDS;
const allSeeds = expectedSeeds.length === COMMITTED_SEEDS.length;
const caseFloor = 100 * expectedSeeds.length;
const binaries = readFileSync(buildLog, 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line))
  .filter(
    (entry) =>
      entry.reason === 'compiler-artifact' &&
      entry.target.name === 'randomized_inputs' &&
      entry.executable
  )
  .map((entry) => entry.executable);
assert.equal(binaries.length, 1, 'expected exactly one built Rust randomized test');
const root = fileURLToPath(new URL('../', import.meta.url));
const started = Date.now();
const deadline = started + (seconds <= 3 ? 55000 : seconds * 2000 + 15000);

function receiptOf(stdout, suite) {
  const marker = 'SERVICES_INPUTS_RECEIPT ';
  // `--nocapture` interleaves the libtest progress prefix with the receipt, so
  // locate the marker inside the line instead of requiring it at the start.
  const line = stdout.split('\n').find((candidate) => candidate.includes(marker));
  assert.ok(line, `${suite} printed no receipt; it did not run its corpus`);
  const receipt = JSON.parse(line.slice(line.indexOf(marker) + marker.length));
  assert.equal(receipt.suite, suite, `${suite} receipt names ${receipt.suite}`);
  return receipt;
}

function checkReceipt(receipt, { minimumCases, targets = [] }) {
  assert.deepEqual(
    receipt.seeds.map(({ seed }) => seed).sort((a, b) => a - b),
    [...expectedSeeds].sort((a, b) => a - b),
    'receipt must report the committed seeds'
  );
  const cases = receipt.seeds.reduce((total, { cases: count }) => total + count, 0);
  assert.ok(cases >= minimumCases, `explored ${cases} cases, expected at least ${minimumCases}`);
  for (const target of targets) {
    assert.ok(
      receipt.targets?.[target] >= caseFloor,
      `target ${target} explored ${receipt.targets?.[target]} cases, expected at least ${caseFloor}`
    );
  }
}

const node = spawnSync(process.execPath, ['fuzz-testing/services-inputs.mjs'], {
  cwd: root,
  env: {
    ...process.env,
    FUZZ_SECONDS: String(seconds),
    UV_THREADPOOL_SIZE: '1',
    RAYON_NUM_THREADS: '1',
  },
  encoding: 'utf8',
  timeout: Math.max(1, deadline - Date.now()),
  killSignal: 'SIGKILL',
});
process.stdout.write(node.stdout || '');
process.stderr.write(node.stderr || '');
if (node.error || node.status !== 0) {
  console.error(`randomized Node suite failed: ${node.error?.code || node.signal || node.status}`);
  process.exit(1);
}
const nodeReceipt = receiptOf(node.stdout || '', 'services-node');
checkReceipt(nodeReceipt, {
  minimumCases: caseFloor,
  targets: [
    'body',
    'intent',
    'delivery',
    'prepared',
    'envelope',
    'cose',
    'price',
    'feed',
    'sponsor',
  ],
});
// Both branches of the feed clamp and both body shapes must appear: a generator
// stuck on one side would otherwise pass every assertion vacuously.
assert.ok(nodeReceipt.outcomes.jsonBody > 0, 'no JSON body cases were generated');
assert.ok(nodeReceipt.outcomes.envelopeRejected > 0, 'no malformed envelope was generated');
if (allSeeds) {
  assert.ok(nodeReceipt.outcomes.rawFallback > 0, 'no raw-payload fallback case was generated');
  assert.ok(nodeReceipt.outcomes.feedClamped > 0, 'the feed clamp never accepted a timestamp');
  assert.ok(nodeReceipt.outcomes.feedRejected > 0, 'the feed clamp never rejected a timestamp');
}

const rust = spawnSync(binaries[0], ['--nocapture', '--test-threads=1'], {
  cwd: root,
  env: {
    ...process.env,
    FUZZ_SECONDS: String(seconds),
    UV_THREADPOOL_SIZE: '1',
    RAYON_NUM_THREADS: '1',
  },
  encoding: 'utf8',
  timeout: Math.max(1, deadline - Date.now()),
  killSignal: 'SIGKILL',
});
process.stdout.write(rust.stdout || '');
process.stderr.write(rust.stderr || '');
if (rust.error || rust.status !== 0) {
  console.error(`randomized Rust suite failed: ${rust.error?.code || rust.signal || rust.status}`);
  process.exit(1);
}
checkReceipt(receiptOf(rust.stdout || '', 'services-rust'), { minimumCases: caseFloor });

console.log(
  JSON.stringify({
    suite: 'services-combined',
    elapsedSeconds: (Date.now() - started) / 1000,
    secondsPerSuite: seconds,
    seeds: expectedSeeds,
  })
);
