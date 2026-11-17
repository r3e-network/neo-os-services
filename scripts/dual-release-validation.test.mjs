import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Mirrors the GIT_* allowlist enforced by scripts/lib/dual_release_validation.py's
// Capture guard: any non-allowlisted GIT_* variable inherited from the invoking
// shell (e.g. GIT_PAGER exported by harness sandboxes) is stripped here so the
// child's environment-override refusal never trips on harness noise.
const GIT_ENV_ALLOWLIST = new Set([
  'GIT_CONFIG_NOSYSTEM',
  'GIT_CONFIG_GLOBAL',
  'GIT_OPTIONAL_LOCKS',
  'GIT_TERMINAL_PROMPT',
]);

function sanitizedEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_') && !GIT_ENV_ALLOWLIST.has(key)) delete env[key];
  }
  return env;
}

test('dual release byte-binding, source coverage and provenance refusal controls', () => {
  const run = spawnSync(
    'python3',
    ['-B', fileURLToPath(new URL('./lib/dual_release_validation_test.py', import.meta.url))],
    { encoding: 'utf8', timeout: 300_000, env: sanitizedEnv() }
  );
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
});

test('dual source committed CLI and provenance drift controls', () => {
  const run = spawnSync(
    'python3',
    ['-B', fileURLToPath(new URL('./lib/dual_release_provenance_test.py', import.meta.url))],
    {
      encoding: 'utf8',
      timeout: 300_000,
      // setup-node's executable may be outside the fixture's restricted PATH.
      env: { ...sanitizedEnv(), DUAL_RELEASE_TEST_NODE: process.execPath },
    }
  );
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
});

test('verified Python input frames execute without waiting for pipe closure', () => {
  const run = spawnSync(
    'python3',
    ['-B', fileURLToPath(new URL('./lib/dual_release_bootstrap_test.py', import.meta.url))],
    { encoding: 'utf8', timeout: 30_000, env: sanitizedEnv() }
  );
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
});
