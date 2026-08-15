import test from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';

import { __handleOracleDecryptForTests } from './capabilities.js';

// E5 — /oracle/decrypt per-request gating. The binding path is opt-in: a request
// with no binding fields keeps the legacy (token-only) behavior unless the
// MORPHEUS_ORACLE_DECRYPT_REQUIRE_BINDING flag is set. When binding fields are
// present, the worker re-reads the message from a TRUSTED worker-configured
// contract and refuses to decrypt a ciphertext that is not the on-chain envelope
// or whose time-lock has not expired — so a worker-token leak cannot decrypt
// arbitrary captured ciphertext.

const ENV_KEYS = [
  'NEOX_MESSAGE_RPC',
  'NEOX_MESSAGE_CONTRACT',
  'NEOX_MESSAGE_CHAIN_ID',
  'NEOX_CHAIN_ID',
  'MORPHEUS_ORACLE_DECRYPT_REQUIRE_BINDING',
];
const saved = {};

test.beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
});

test.afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function makeReader(message) {
  return async () => message;
}

const CONTRACT = '0x1111111111111111111111111111111111111111';

test('opt-out (flag=false) keeps the legacy bare-envelope path reachable (E5/C3)', async () => {
  // C3 flipped the default to require binding; an operator opts OUT for a transition
  // window via the explicit false flag. Then a bare envelope (no binding fields)
  // reaches the crypto layer and fails there (400), NOT at the binding gate — the
  // gate did not change the opted-out legacy path's reachability.
  process.env.MORPHEUS_ORACLE_DECRYPT_REQUIRE_BINDING = 'false';
  const res = await __handleOracleDecryptForTests({ payload: { envelope: 'not-a-real-envelope' } });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.doesNotMatch(body.error || '', /binding|messageId|time-lock|on-chain/i);
});

test('binding is REQUIRED BY DEFAULT now: a bare envelope is rejected when the flag is unset (C3)', async () => {
  // The new default (flag unset) requires binding, so a bare ciphertext with no
  // (chain, message_id, contract) fields is rejected before any decryption.
  delete process.env.MORPHEUS_ORACLE_DECRYPT_REQUIRE_BINDING;
  const res = await __handleOracleDecryptForTests({ payload: { envelope: 'x'.repeat(40) } });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /binding fields/i);
});

test('require-binding flag rejects a bare envelope with no binding fields (E5)', async () => {
  process.env.MORPHEUS_ORACLE_DECRYPT_REQUIRE_BINDING = 'true';
  const res = await __handleOracleDecryptForTests({ payload: { envelope: 'x'.repeat(40) } });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /binding fields/i);
});

test('gated decrypt rejects a ciphertext that is not the on-chain envelope (E5)', async () => {
  process.env.NEOX_MESSAGE_RPC = 'https://neox.example/rpc';
  process.env.NEOX_MESSAGE_CONTRACT = CONTRACT;
  process.env.NEOX_MESSAGE_CHAIN_ID = '47763';

  const onchainEnvelope = 'the-real-on-chain-envelope';
  const reader = makeReader({
    recipient: '0x2222222222222222222222222222222222222222',
    envelope: ethers.toUtf8Bytes(onchainEnvelope),
    unlockTime: 1n,
  });

  const res = await __handleOracleDecryptForTests(
    { payload: { chain: 'neox', messageId: '7', envelope: 'a-DIFFERENT-captured-ciphertext' } },
    { readMessage: reader }
  );
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.match(body.error, /does not match the on-chain message/i);
});

test('gated decrypt rejects when the time-lock has not expired (E5)', async () => {
  process.env.NEOX_MESSAGE_RPC = 'https://neox.example/rpc';
  process.env.NEOX_MESSAGE_CONTRACT = CONTRACT;

  const onchainEnvelope = 'sealed-envelope-locked';
  const future = BigInt(Math.floor(Date.now() / 1000) + 86_400);
  const reader = makeReader({
    recipient: '0x2222222222222222222222222222222222222222',
    envelope: ethers.toUtf8Bytes(onchainEnvelope),
    unlockTime: future,
  });

  const res = await __handleOracleDecryptForTests(
    { payload: { chain: 'neox', messageId: '7', envelope: onchainEnvelope } },
    { readMessage: reader }
  );
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.match(body.error, /time-lock has not expired/i);
});

test('gated decrypt rejects a contract that does not match the worker contract (E5)', async () => {
  process.env.NEOX_MESSAGE_RPC = 'https://neox.example/rpc';
  process.env.NEOX_MESSAGE_CONTRACT = CONTRACT;

  const reader = makeReader({
    recipient: '0x2222222222222222222222222222222222222222',
    envelope: ethers.toUtf8Bytes('anything'),
    unlockTime: 1n,
  });

  const res = await __handleOracleDecryptForTests(
    {
      payload: {
        chain: 'neox',
        contract: '0x9999999999999999999999999999999999999999',
        messageId: '7',
        envelope: 'anything',
      },
    },
    { readMessage: reader }
  );
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.match(body.error, /does not match the worker-configured/i);
});

test('gated decrypt passes the binding gate for a matching, time-expired envelope (E5)', async () => {
  process.env.NEOX_MESSAGE_RPC = 'https://neox.example/rpc';
  process.env.NEOX_MESSAGE_CONTRACT = CONTRACT;

  const onchainEnvelope = 'sealed-but-fake-ciphertext';
  const past = BigInt(Math.floor(Date.now() / 1000) - 10);
  const reader = makeReader({
    recipient: '0x2222222222222222222222222222222222222222',
    envelope: ethers.toUtf8Bytes(onchainEnvelope),
    unlockTime: past,
  });

  const res = await __handleOracleDecryptForTests(
    { payload: { chain: 'neox', messageId: '7', envelope: onchainEnvelope } },
    { readMessage: reader }
  );
  // The gate passed; decryption of the (fake) envelope then fails at the crypto
  // layer with a 400 — crucially NOT a 403 binding rejection.
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.doesNotMatch(body.error || '', /does not match|time-lock|not configured/i);
});

test('gated decrypt requires the neox chain (E5)', async () => {
  const res = await __handleOracleDecryptForTests({
    payload: { chain: 'neo_n3', messageId: '7', envelope: 'x' },
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /neox chain only/i);
});
