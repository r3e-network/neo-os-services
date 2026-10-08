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
for (const [command, args] of [
  [process.execPath, ['fuzz-testing/services-inputs.mjs']],
  [binaries[0], ['--nocapture', '--test-threads=1']],
]) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: {
      ...process.env,
      FUZZ_SECONDS: String(seconds),
      UV_THREADPOOL_SIZE: '1',
      RAYON_NUM_THREADS: '1',
    },
    stdio: 'inherit',
    timeout: Math.max(1, deadline - Date.now()),
    killSignal: 'SIGKILL',
  });
  if (result.error || result.status !== 0) {
    console.error(
      `randomized suite failed: ${result.error?.code || result.signal || result.status}`
    );
    process.exit(1);
  }
}
console.log(
  JSON.stringify({
    suite: 'services-combined',
    elapsedSeconds: (Date.now() - started) / 1000,
    secondsPerSuite: seconds,
  })
);
