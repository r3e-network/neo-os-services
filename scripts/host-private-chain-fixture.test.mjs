import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('host private-chain fixture preserves the exact chain payload without running the driver', () => {
  const result = spawnSync(
    'python3',
    ['-B', fileURLToPath(new URL('./lib/host_private_chain_fixture_test.py', import.meta.url))],
    {
      encoding: 'utf8',
      timeout: 10_000,
    }
  );
  assert.equal(result.status, 0, `${result.error || ''}\n${result.stdout}\n${result.stderr}`);
});
