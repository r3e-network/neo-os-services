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

test('validateSponsorOperation binds sponsorship to the unsigned transaction hash and call target', async () => {
  const { tx, sc, u } = await import('@cityofzion/neon-js');
  const { validateSponsorOperation } = await import(`./neo-n3.js?spend-gate=${Date.now()}`);
  const contract = '0x0123456789abcdef0123456789abcdef01234567';
  const transaction = new tx.Transaction({
    nonce: 1,
    validUntilBlock: 100,
    signers: [{ account: `0x${'cd'.repeat(20)}`, scopes: tx.WitnessScope.CalledByEntry }],
    script: new sc.ScriptBuilder().emitAppCall(contract, 'executeUserOp', []).build(),
  });
  const approvedHash = `0x${transaction.hash()}`;
  const result = validateSponsorOperation(transaction, {
    operation_hash: approvedHash,
    target_contract: contract,
    method: 'executeUserOp',
  });
  assert.equal(result.target_contract, contract);
  assert.equal(result.method, 'executeUserOp');
  assert.throws(
    () =>
      validateSponsorOperation(transaction, {
        operation_hash: approvedHash,
        target_contract: '0x1123456789abcdef0123456789abcdef01234567',
        method: 'executeUserOp',
      }),
    /target_contract does not match/
  );
  transaction.networkFee = u.BigInteger.fromNumber(1);
  assert.throws(
    () =>
      validateSponsorOperation(transaction, {
        operation_hash: approvedHash,
        target_contract: contract,
        method: 'executeUserOp',
      }),
    /operation_hash does not match/
  );
});

test('relayNeoN3Invocation applies the allowlist for the request network', async () => {
  delete process.env.CONTRACT_MORPHEUS_ORACLE_HASH;
  process.env.CONTRACT_MORPHEUS_ORACLE_HASH_MAINNET = '0x1111111111111111111111111111111111111111';
  process.env.CONTRACT_MORPHEUS_ORACLE_HASH_TESTNET = '0x2222222222222222222222222222222222222222';

  const { relayNeoN3Invocation } = await import(`./neo-n3.js?shared-worker=${Date.now()}`);
  const result = await relayNeoN3Invocation({
    network: 'mainnet',
    contract_hash: '0x1111111111111111111111111111111111111111',
    method: 'fulfillRequest',
    params: [],
  });

  assert.notEqual(result.status, 403);
});
