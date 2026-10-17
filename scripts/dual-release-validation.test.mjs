import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('dual release byte-binding, source coverage and provenance refusal controls', () => {
  const run = spawnSync(
    'python3',
    ['-B', fileURLToPath(new URL('./lib/dual_release_validation_test.py', import.meta.url))],
    { encoding: 'utf8', timeout: 120_000 }
  );
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
});

test('dual source committed CLI and provenance drift controls', () => {
  const run = spawnSync(
    'python3',
    ['-B', fileURLToPath(new URL('./lib/dual_release_provenance_test.py', import.meta.url))],
    { encoding: 'utf8', timeout: 120_000 }
  );
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
});
