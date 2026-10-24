import test from 'node:test';
import assert from 'node:assert/strict';

import {
  __resetCustodyTransportForTests,
  __setCustodyTransportForTests,
} from '../platform/custody.js';
import { createUpstashRestMock } from '../test-support/upstash-rest-mock.mjs';
import {
  buildSponsorshipFixture,
  sponsorshipPayload,
  sponsorshipStorageKey,
} from '../test-support/sponsorship-fixtures.mjs';

const originalEnv = { ...process.env };
const upstash = createUpstashRestMock();

function installSponsorshipRuntime(fixture) {
  delete process.env.MORPHEUS_RUNTIME_CONFIG_JSON;
  process.env.MORPHEUS_NETWORK = 'testnet';
  process.env.NEO_RPC_URL = 'https://neo-rpc.test';
  process.env.MORPHEUS_ALLOW_TRANSACTION_SPONSORSHIP = 'true';
  process.env.MORPHEUS_MAX_SPONSOR_FEE_GAS = '10';
  process.env.UPSTASH_REDIS_REST_URL = 'https://mock-upstash.example.com';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
  process.env.SIGNER_ROLE_UPDATER_KEY_ID = 'key-updater';
  upstash.install();
  upstash.putJson(sponsorshipStorageKey(fixture.approval.sponsorship_id), fixture.approval);
  const state = { keyInfoCalls: 0, signCalls: 0, failSign: false };
  __setCustodyTransportForTests(async (method, pathname) => {
    if (method === 'GET' && pathname === '/keys/key-updater') {
      state.keyInfoCalls += 1;
      return {
        allowed: true,
        key_id: 'key-updater',
        public_key: fixture.sponsorAccount.publicKey,
        script_hash: `0x${fixture.sponsorAccount.scriptHash}`,
        address: fixture.sponsorAccount.address,
      };
    }
    if (method === 'POST' && pathname === '/sign/transaction') {
      state.signCalls += 1;
      if (state.failSign) throw new Error('injected custody signature failure');
      return {
        allowed: true,
        key_id: 'key-updater',
        address: fixture.sponsorAccount.address,
        script_hash: `0x${fixture.sponsorAccount.scriptHash}`,
        invocation_script: `0c40${'00'.repeat(64)}`,
        verification_script: `0c21${fixture.sponsorAccount.publicKey}4156e7b327`,
      };
    }
    return { allowed: false, code: 'unexpected', message: `${method} ${pathname}` };
  });
  return state;
}

test.afterEach(() => {
  process.env = { ...originalEnv };
  upstash.restore();
  upstash.clear();
  __resetCustodyTransportForTests();
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

test('sponsor guard refuses any user signer scope that carries the Global bit', async () => {
  const { tx, sc, wallet: neoWallet } = await import('@cityofzion/neon-js');
  const { assertSponsorWitnesses } = await import(`./neo-n3.js?sponsor-scope=${Date.now()}`);
  const contract = '0x0123456789abcdef0123456789abcdef01234567';
  const userScriptHash = '11'.repeat(20);
  const userAddress = neoWallet.getAddressFromScriptHash(userScriptHash);
  const sponsorScriptHash = 'cd'.repeat(20);

  const buildTransaction = (userScopes) =>
    new tx.Transaction({
      nonce: 1,
      validUntilBlock: 100,
      signers: [
        { account: userScriptHash, scopes: userScopes },
        { account: sponsorScriptHash, scopes: tx.WitnessScope.None },
      ],
      script: new sc.ScriptBuilder().emitAppCall(contract, 'executeUserOp', []).build(),
    });

  assert.throws(
    () =>
      assertSponsorWitnesses(
        buildTransaction(tx.WitnessScope.Global),
        sponsorScriptHash,
        userAddress
      ),
    /non-global witness scope/
  );
  // The composite 0x81 (Global | CalledByEntry) once slipped past an equality
  // check against the bare 0x80 enum value.
  assert.throws(
    () => assertSponsorWitnesses(buildTransaction(0x81), sponsorScriptHash, userAddress),
    /non-global witness scope/
  );
  assert.throws(
    () => assertSponsorWitnesses(buildTransaction('Global'), sponsorScriptHash, userAddress),
    /non-global witness scope/
  );
  assert.doesNotThrow(() =>
    assertSponsorWitnesses(
      buildTransaction(tx.WitnessScope.CalledByEntry),
      sponsorScriptHash,
      userAddress
    )
  );

  const deserialized = tx.Transaction.deserialize(buildTransaction(0x81).serialize(true));
  assert.throws(
    () => assertSponsorWitnesses(deserialized, sponsorScriptHash, userAddress),
    /non-global witness scope/
  );
});

test('sponsorship signs the final operation once and rejects approval replay', async () => {
  const fixture = buildSponsorshipFixture();
  const state = installSponsorshipRuntime(fixture);
  const { sponsorNeoN3Transaction } = await import(`./neo-n3.js?sponsor-once=${Date.now()}`);
  const payload = sponsorshipPayload(fixture);
  const result = await sponsorNeoN3Transaction(payload);
  assert.equal(result.sponsorship_id, fixture.approval.sponsorship_id);
  assert.equal(result.operation_hash, fixture.operationHash);
  assert.equal(result.network_fee, String(fixture.networkFee));
  assert.equal(state.signCalls, 1);
  assert.equal(upstash.getJson(sponsorshipStorageKey(fixture.approval.sponsorship_id)), null);

  await assert.rejects(sponsorNeoN3Transaction(payload), /missing, expired, or already consumed/);
  assert.equal(state.signCalls, 1);
});

test('concurrent sponsorship relay admits exactly one custody signature', async () => {
  const fixture = buildSponsorshipFixture({ id: 'approval-concurrent' });
  const state = installSponsorshipRuntime(fixture);
  const { sponsorNeoN3Transaction } = await import(`./neo-n3.js?sponsor-race=${Date.now()}`);
  const payload = sponsorshipPayload(fixture);
  const results = await Promise.allSettled([
    sponsorNeoN3Transaction(payload),
    sponsorNeoN3Transaction(payload),
  ]);
  assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1);
  assert.equal(results.filter(({ status }) => status === 'rejected').length, 1);
  assert.equal(state.signCalls, 1);
});

test('a consumed approval is not restored when custody signing fails', async () => {
  const fixture = buildSponsorshipFixture({ id: 'approval-sign-failure' });
  const state = installSponsorshipRuntime(fixture);
  state.failSign = true;
  const { sponsorNeoN3Transaction } = await import(`./neo-n3.js?sponsor-failure=${Date.now()}`);
  const payload = sponsorshipPayload(fixture);
  await assert.rejects(sponsorNeoN3Transaction(payload), /custody signature failure/);
  assert.equal(state.signCalls, 1);
  assert.equal(upstash.getJson(sponsorshipStorageKey(fixture.approval.sponsorship_id)), null);
  await assert.rejects(sponsorNeoN3Transaction(payload), /missing, expired, or already consumed/);
  assert.equal(state.signCalls, 1);
});

test('missing, forged, expired, network, user, and dapp mismatches never reach custody signing', async () => {
  const { sponsorNeoN3Transaction } = await import(`./neo-n3.js?sponsor-bindings=${Date.now()}`);
  const cases = [
    { name: 'missing', missing: true, expected: /missing, expired, or already consumed/ },
    {
      name: 'forged',
      payload: { approval_digest: '00'.repeat(32) },
      expected: /approval_digest does not match/,
    },
    {
      name: 'expired',
      expired: true,
      expected: /expired/,
    },
    {
      name: 'network',
      payload: { network: 'mainnet' },
      expected: /network does not match/,
    },
    {
      name: 'user',
      user: true,
      expected: /does not belong to the supplied user_address/,
    },
    {
      name: 'dapp',
      payload: { dapp_id: 'rogue-dapp' },
      expected: /dapp_id does not match/,
    },
  ];
  for (const testCase of cases) {
    const fixture = buildSponsorshipFixture({ id: `approval-${testCase.name}` });
    if (testCase.expired) {
      fixture.approval.expires_at = new Date(Date.now() - 1).toISOString();
    }
    const state = installSponsorshipRuntime(fixture);
    const key = sponsorshipStorageKey(fixture.approval.sponsorship_id);
    if (testCase.missing) upstash.expire(key);
    const payload = sponsorshipPayload(fixture, {
      ...testCase.payload,
      ...(testCase.user ? { user_address: fixture.sponsorAccount.address } : {}),
    });
    await assert.rejects(sponsorNeoN3Transaction(payload), testCase.expected, testCase.name);
    assert.equal(state.signCalls, 0, testCase.name);
    if (!testCase.missing) assert.ok(upstash.getJson(key), testCase.name);
    upstash.clear();
  }
});

test('transaction, target, method, fee, and cap mismatches precede consumption and signing', async () => {
  const { sponsorNeoN3Transaction } = await import(`./neo-n3.js?sponsor-final=${Date.now()}`);
  const { sponsorshipApprovalDigest } = await import('../paymaster/approvals.js');
  const cases = [
    {
      name: 'transaction',
      mutate: (fixture) => {
        fixture.transaction.nonce += 1;
      },
      expected: /operation_hash does not match the unsigned transaction/,
    },
    {
      name: 'target',
      payload: { target_contract: `0x${'bb'.repeat(20)}` },
      expected: /target_contract does not match/,
    },
    {
      name: 'method',
      payload: { method: 'otherMethod' },
      expected: /method does not match/,
    },
    {
      name: 'fee',
      mutate: (fixture) => {
        fixture.approval.estimated_gas_units = fixture.networkFee - 1;
        fixture.approval.approval_digest = sponsorshipApprovalDigest(fixture.approval);
      },
      expected: /exceeds approved estimated_gas_units/,
    },
    {
      name: 'cap',
      maxFeeGas: '0.000001',
      expected: /exceeds cap/,
    },
  ];
  for (const testCase of cases) {
    const fixture = buildSponsorshipFixture({ id: `approval-${testCase.name}` });
    testCase.mutate?.(fixture);
    const state = installSponsorshipRuntime(fixture);
    if (testCase.maxFeeGas) process.env.MORPHEUS_MAX_SPONSOR_FEE_GAS = testCase.maxFeeGas;
    const key = sponsorshipStorageKey(fixture.approval.sponsorship_id);
    await assert.rejects(
      sponsorNeoN3Transaction(sponsorshipPayload(fixture, testCase.payload)),
      testCase.expected,
      testCase.name
    );
    assert.equal(state.signCalls, 0, testCase.name);
    assert.ok(upstash.getJson(key), testCase.name);
    upstash.clear();
  }
});

test('relay fails closed when approval storage is missing or unavailable', async () => {
  const { sponsorNeoN3Transaction } = await import(`./neo-n3.js?sponsor-storage=${Date.now()}`);
  for (const mode of ['missing-config', 'redis-failure']) {
    const fixture = buildSponsorshipFixture({ id: `approval-${mode}` });
    const state = installSponsorshipRuntime(fixture);
    if (mode === 'missing-config') delete process.env.UPSTASH_REDIS_REST_URL;
    else upstash.failNext();
    await assert.rejects(
      sponsorNeoN3Transaction(sponsorshipPayload(fixture)),
      /sponsorship approval storage failed/
    );
    assert.equal(state.signCalls, 0, mode);
    assert.ok(upstash.getJson(sponsorshipStorageKey(fixture.approval.sponsorship_id)), mode);
    upstash.clear();
  }
});

test('the sponsorship compatibility lane remains disabled by default', async () => {
  const fixture = buildSponsorshipFixture({ id: 'approval-disabled' });
  const state = installSponsorshipRuntime(fixture);
  delete process.env.MORPHEUS_ALLOW_TRANSACTION_SPONSORSHIP;
  const { sponsorNeoN3Transaction } = await import(`./neo-n3.js?sponsor-disabled=${Date.now()}`);
  await assert.rejects(sponsorNeoN3Transaction(sponsorshipPayload(fixture)), /disabled/);
  assert.equal(state.signCalls, 0);
  assert.ok(upstash.getJson(sponsorshipStorageKey(fixture.approval.sponsorship_id)));
});
