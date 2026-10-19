import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('hosted native candidate offline behavioral controls', () => {
  // python3 follows the supported caller PATH (3.13 locally, 3.12 on hosted
  // Ubuntu). Do not hardcode macOS /usr/bin/python3 or invoke a native build.
  const result = spawnSync(
    'python3',
    ['-B', new URL('./hosted_native_candidate_test.py', import.meta.url).pathname, '-v'],
    {
      encoding: 'utf8',
      timeout: 120000,
      maxBuffer: 2 * 1024 * 1024,
      env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1' },
    }
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /Ran [1-9][0-9]* tests/);
  assert.match(result.stderr, /\nOK\n/);
});
