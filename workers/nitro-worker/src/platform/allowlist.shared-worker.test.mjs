import test from 'node:test';
import assert from 'node:assert/strict';

const ORIGINALS = {
  CONTRACT_MORPHEUS_ORACLE_HASH: process.env.CONTRACT_MORPHEUS_ORACLE_HASH,
  CONTRACT_MORPHEUS_ORACLE_HASH_MAINNET: process.env.CONTRACT_MORPHEUS_ORACLE_HASH_MAINNET,
  CONTRACT_MORPHEUS_ORACLE_HASH_TESTNET: process.env.CONTRACT_MORPHEUS_ORACLE_HASH_TESTNET,
};

test.afterEach(() => {
  for (const [key, value] of Object.entries(ORIGINALS)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('txproxy allowlist resolves Morpheus Oracle contract per network in a shared worker', async () => {
  delete process.env.CONTRACT_MORPHEUS_ORACLE_HASH;
  process.env.CONTRACT_MORPHEUS_ORACLE_HASH_MAINNET = '0x1111111111111111111111111111111111111111';
  process.env.CONTRACT_MORPHEUS_ORACLE_HASH_TESTNET = '0x2222222222222222222222222222222222222222';

  const { allowlistAllows } = await import(`./allowlist.js?shared-worker=${Date.now()}`);

  assert.equal(
    allowlistAllows('0x1111111111111111111111111111111111111111', 'fulfillRequest', {
      network: 'mainnet',
    }),
    true
  );
  assert.equal(
    allowlistAllows('0x2222222222222222222222222222222222222222', 'fulfillRequest', {
      network: 'testnet',
    }),
    true
  );
  assert.equal(
    allowlistAllows('0x1111111111111111111111111111111111111111', 'fulfillRequest', {
      network: 'testnet',
    }),
    false
  );
});
