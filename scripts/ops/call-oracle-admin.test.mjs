import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const SCRIPT = fileURLToPath(new URL('./call-oracle-admin.mjs', import.meta.url));

test('refuses to run without explicit operator targets and apply mode', () => {
  const env = { ...process.env };
  for (const key of [
    'NITRO_RUNTIME_URL',
    'MORPHEUS_RUNTIME_URL',
    'NITRO_API_TOKEN',
    'MORPHEUS_RUNTIME_TOKEN',
    'ORACLE_CONTRACT',
    'CONTRACT_MORPHEUS_ORACLE_HASH',
    'NEO_RPC_URL',
    'NEO_ADMIN_ADDRESS',
    'MORPHEUS_ORACLE_NEW_UPDATER',
    'MORPHEUS_ORACLE_NEW_VERIFIER_PUBKEY',
  ]) {
    delete env[key];
  }
  const result = spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    env,
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--apply|explicit/i);
});

test('does not broadcast in dry-run mode', () => {
  // Argument/config validation happens before any RPC call. This regression
  // pins the explicit dry-run default without requiring a live signer.
  const result = spawnSync(process.execPath, [SCRIPT, '--dry-run'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      MORPHEUS_ORACLE_NEW_UPDATER: '0x13314ea551ae127cb7ccc9a02f64106a34ff91eb',
      MORPHEUS_ORACLE_NEW_VERIFIER_PUBKEY:
        '03b8e849395076b0b17e204a86813e057d622acf9856ea8007287d5d4245b91318',
      NEO_ADMIN_ADDRESS: 'NUVmRwZDoSZMKcPj9UCQLHkpno2TPqYVxC',
      NITRO_API_TOKEN: '',
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /runtime token|ORACLE_CONTRACT|NEO_RPC_URL/i);
});
