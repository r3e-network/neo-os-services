import test from 'node:test';
import assert from 'node:assert/strict';

import {
  consumeSponsorshipApproval,
  persistSponsorshipApproval,
  readSponsorshipApproval,
  sponsorshipApprovalDigest,
} from './approvals.js';
import { handlePaymasterAuthorize } from './index.js';
import {
  __resetCustodyTransportForTests,
  __setCustodyTransportForTests,
} from '../platform/custody.js';
import { createUpstashRestMock } from '../test-support/upstash-rest-mock.mjs';

const originalEnv = { ...process.env };
const upstash = createUpstashRestMock();

function validApproval(overrides = {}) {
  const approval = {
    mode: 'paymaster_authorize',
    approved: true,
    network: 'testnet',
    target_chain: 'neo_n3',
    policy_id: 'test-policy',
    sponsorship_id: 'approval-1',
    account_id: `0x${'cd'.repeat(20)}`,
    dapp_id: 'demo-dapp',
    target_contract: `0x${'aa'.repeat(20)}`,
    method: 'transfer',
    userop_target_contract: '',
    userop_method: '',
    estimated_gas_units: 1_000_000,
    operation_hash: `0x${'44'.repeat(32)}`,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    policy: { policy_id: 'test-policy', max_gas_units: 2_000_000 },
    onchain_policy: null,
    ...overrides,
  };
  return { ...approval, approval_digest: sponsorshipApprovalDigest(approval) };
}

function authorizePayload(overrides = {}) {
  return {
    network: 'testnet',
    target_chain: 'neo_n3',
    account_id: `0x${'cd'.repeat(20)}`,
    dapp_id: 'demo-dapp',
    target_contract: `0x${'aa'.repeat(20)}`,
    method: 'transfer',
    estimated_gas_units: 1_000_000,
    operation_hash: `0x${'44'.repeat(32)}`,
    ...overrides,
  };
}

function approvalStorageKey(id = 'approval-1') {
  return `morpheus:paymaster:approval:${id}`;
}

test.beforeEach(() => {
  process.env = { ...originalEnv };
  delete process.env.MORPHEUS_RUNTIME_CONFIG_JSON;
  delete process.env.MORPHEUS_ALLOW_TRANSACTION_SPONSORSHIP;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  process.env.MORPHEUS_NETWORK = 'testnet';
  process.env.MORPHEUS_PAYMASTER_TESTNET_ENABLED = 'true';
  process.env.MORPHEUS_PAYMASTER_TESTNET_POLICY_ID = 'test-policy';
  process.env.MORPHEUS_PAYMASTER_TESTNET_MAX_GAS_UNITS = '2000000';
  process.env.SIGNER_ROLE_WORKER_KEY_ID = 'key-worker';
  upstash.clear();
  upstash.install();
  __setCustodyTransportForTests(async (method) => {
    const identity = {
      public_key: `02${'11'.repeat(32)}`,
      address: 'Ntest',
      script_hash: `0x${'22'.repeat(20)}`,
    };
    if (method === 'GET') {
      return {
        allowed: true,
        ...identity,
        key_id: 'key-worker',
        label: 'test',
        network: 'testnet',
        network_magic: 894710606,
        signing_enabled: true,
      };
    }
    return { allowed: true, ...identity, signature: '00' };
  });
});

test.afterEach(() => {
  process.env = { ...originalEnv };
  upstash.restore();
  __resetCustodyTransportForTests();
});

test('authorize-only remains available without Upstash while sponsorship is disabled', async () => {
  const response = await handlePaymasterAuthorize(authorizePayload());
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.approved, true);
  assert.ok(body.signature);
  assert.equal(upstash.commands.length, 0);
});

test('invalid gas returns before custody signing', async () => {
  let custodyCalls = 0;
  __setCustodyTransportForTests(async () => {
    custodyCalls += 1;
    throw new Error('custody must not be called');
  });
  const response = await handlePaymasterAuthorize(authorizePayload({ estimated_gas_units: 0 }));
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /estimated_gas_units must be a positive number/);
  assert.equal(custodyCalls, 0);
});

test('enabled sponsorship fails closed without storage and denied verdicts stay authorize-only', async () => {
  process.env.MORPHEUS_ALLOW_TRANSACTION_SPONSORSHIP = 'true';
  const missing = await handlePaymasterAuthorize(authorizePayload());
  assert.equal(missing.status, 503);
  assert.match((await missing.json()).error, /storage failed/);

  process.env.MORPHEUS_PAYMASTER_TESTNET_ENABLED = 'false';
  const denied = await handlePaymasterAuthorize(authorizePayload());
  assert.equal(denied.status, 200);
  assert.equal((await denied.json()).approved, false);
  assert.equal(upstash.commands.length, 0);
});

test('enabled sponsorship stores the complete approved result with SET NX PX', async () => {
  process.env.MORPHEUS_ALLOW_TRANSACTION_SPONSORSHIP = 'true';
  process.env.UPSTASH_REDIS_REST_URL = 'https://mock-upstash.example.com';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
  const response = await handlePaymasterAuthorize(authorizePayload());
  assert.equal(response.status, 200);
  const body = await response.json();
  const key = approvalStorageKey(body.sponsorship_id);
  const stored = upstash.getJson(key);
  assert.equal(stored.mode, 'paymaster_authorize');
  assert.equal(stored.approved, true);
  assert.equal(stored.sponsorship_id, body.sponsorship_id);
  assert.equal(stored.approval_digest, body.approval_digest);
  assert.equal(stored.expires_at, body.expires_at);
  assert.equal(stored.account_id, body.account_id);
  assert.equal(stored.dapp_id, body.dapp_id);
  assert.equal(stored.target_contract, body.target_contract);
  assert.equal(stored.method, body.method);
  assert.equal(stored.estimated_gas_units, body.estimated_gas_units);
  assert.equal(stored.operation_hash, body.operation_hash);
  assert.deepEqual(stored.policy, body.policy);
  assert.equal(stored.onchain_policy, null);
  const set = upstash.commands.find(({ op }) => op === 'SET');
  assert.deepEqual(set.entry.slice(3), ['NX', 'PX', set.entry[5]]);
  assert.ok(Number(set.entry[5]) > 0);
  await assert.rejects(persistSponsorshipApproval(stored), /already exists/);
});

test('enabled sponsorship does not return an approval when Redis fails', async () => {
  process.env.MORPHEUS_ALLOW_TRANSACTION_SPONSORSHIP = 'true';
  process.env.UPSTASH_REDIS_REST_URL = 'https://mock-upstash.example.com';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
  upstash.failNext();
  const response = await handlePaymasterAuthorize(authorizePayload());
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /injected storage failure/);
});

test('consume compares the complete record returned by atomic GETDEL with the verified read', async () => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://mock-upstash.example.com';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
  const approval = validApproval();
  const key = approvalStorageKey();
  upstash.putJson(key, approval);
  const read = await readSponsorshipApproval(approval.sponsorship_id, 'testnet');
  const replacement = validApproval({ dapp_id: 'replaced-dapp' });
  upstash.putJson(key, replacement);
  await assert.rejects(
    consumeSponsorshipApproval(approval.sponsorship_id, 'testnet', read),
    /differs from the verified approval/
  );
  assert.equal(upstash.getJson(key), null);
});

test('expired and forged stored approvals are rejected before consumption', async () => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://mock-upstash.example.com';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
  const key = approvalStorageKey();
  upstash.putJson(key, validApproval({ expires_at: new Date(Date.now() - 1).toISOString() }));
  await assert.rejects(readSponsorshipApproval('approval-1', 'testnet'), /expired/);
  const forged = validApproval();
  forged.approval_digest = '00'.repeat(32);
  upstash.putJson(key, forged);
  await assert.rejects(readSponsorshipApproval('approval-1', 'testnet'), /approval_digest/);
  assert.equal(upstash.commands.filter(({ op }) => op === 'EVAL').length, 0);
});
