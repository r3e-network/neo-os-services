import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = path.join(REPO_ROOT, 'scripts', 'check-feed-pair-registries.mjs');

function runCheck(extraArgs = []) {
  return spawnSync(process.execPath, [CHECK, '--json', ...extraArgs], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, FEED_PUSHER_SKIP_MAIN: '1' },
  });
}

// Static mode reads four checked-in registries and makes no network calls, so it is
// safe to run in CI. `--onchain` is deliberately not exercised here.
test('the advertised, pushed, worker and runtime feed registries agree', () => {
  const result = runCheck();
  const report = JSON.parse(result.stdout);
  assert.deepEqual(
    report.failures,
    [],
    `feed pair registries disagree:\n  ${report.failures.join('\n  ')}`
  );
  assert.equal(report.status, 'pass');
  assert.equal(result.status, 0);
});

// Guards against the check quietly becoming a no-op: if it ever reports zero pairs
// (a parser that stopped matching, an empty registry) it would "pass" while proving
// nothing. Every registry must contribute the same non-trivial count.
test('the check actually compared a non-trivial, equal number of pairs', () => {
  const report = JSON.parse(runCheck().stdout);
  assert.ok(report.advertised_pair_count > 20, 'advertised set looks empty or truncated');
  assert.equal(report.pushed_pair_count, report.advertised_pair_count);
  assert.equal(report.worker_pair_count, report.advertised_pair_count);
  assert.equal(report.runtime_pair_count, report.advertised_pair_count);
});

// The two known wrong-asset mappings must stay retired. TwelveData resolves HG1 to
// Homag Group AG rather than copper, and FLM/USD to FolmCoin rather than Flamingo
// Finance; both were publishing the wrong instrument under a right-looking pair name.
test('the known unsourceable pairs stay retired', () => {
  const report = JSON.parse(runCheck().stdout);
  for (const pair of ['COPPER-USD', 'FLM-USD', '1000FLM-USD', '1000JPY-USD']) {
    assert.ok(report.retired_pairs.includes(pair), `${pair} must remain retired`);
  }
});
