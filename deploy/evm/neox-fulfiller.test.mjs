import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const fulfiller = fileURLToPath(new URL('./neox-fulfiller.mjs', import.meta.url));

function run(overrides) {
  return spawnSync(process.execPath, [fulfiller], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH || '',
      ...overrides,
    },
  });
}

test('Neo X host fulfiller fails closed in production before reading a private key', () => {
  const result = run({
    NODE_ENV: 'production',
    NEOX_RELAYER_PK: '0xhost-key-must-not-be-used',
    MORPHEUS_ALLOW_INSECURE_HOST_EVM_SIGNER: 'true',
  });

  assert.equal(result.status, 78, result.stderr || result.stdout);
  assert.match(result.stderr, /production signing is disabled.*no custody\/enclave/i);
});

test('Neo X host fulfiller requires explicit opt-in outside production', () => {
  const result = run({
    NODE_ENV: 'development',
    NEOX_RELAYER_PK: '0xhost-key-must-not-be-used',
  });

  assert.equal(result.status, 78, result.stderr || result.stdout);
  assert.match(result.stderr, /development-only.*explicit non-production test/i);
});
