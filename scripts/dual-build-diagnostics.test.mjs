import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

test('dual build failure diagnostics preserve cause without raw child output', () => {
  const result = spawnSync(
    'python3',
    ['-B', fileURLToPath(new URL('./lib/dual_build_diagnostics_test.py', import.meta.url))],
    { encoding: 'utf8', timeout: 120_000 }
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /Ran [1-9][0-9]* tests/);
});
