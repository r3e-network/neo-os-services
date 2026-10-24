// Generic game.session routing in the relayer. The relayer carries the
// confidential-session finalize GENERICALLY — one branch mapping the kernel
// operation session.finalize (module game.session) to the worker /session/finalize
// route, and one compact-callback encoding (game_result_v1) that forwards the
// fixed 79-byte RESULT CODEC verbatim into the fulfillment. NO per-game code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  buildFulfillmentDigestBytes,
  buildWorkerPayload,
  encodeFulfillmentResult,
  isOperatorOnlyRequestType,
  resolveKernelIntent,
  resolveWorkerRoute,
} from './router.js';

// The golden 79-byte result the worker builds (cross-pinned with the worker's
// result-codec.test.mjs and the contract team). SHA256 of these bytes is the
// fulfillment-digest input.
const GOLDEN_RESULT_HEX =
  '02' + 'ab'.repeat(32) + 'cd'.repeat(32) + '000000000001e240' + '02' + '00000014' + '01';
const GOLDEN_RESULT = Buffer.from(GOLDEN_RESULT_HEX, 'hex');
const GOLDEN_SHA256 = 'f8ddd711f6ece1740fd322f71e9cc7407e6820656227bb8c4d0716e7970c2488';

test('resolveKernelIntent maps session.finalize to module game.session + /session/finalize', () => {
  assert.deepEqual(resolveKernelIntent('session.finalize'), {
    legacyRequestType: 'session.finalize',
    moduleId: 'game.session',
    operation: 'session.finalize',
    workerRoute: '/session/finalize',
    operatorOnly: false,
  });
});

test('resolveKernelIntent routes session.start/step to the direct enclave loop route', () => {
  for (const op of ['session.start', 'session.step']) {
    const intent = resolveKernelIntent(op);
    assert.equal(intent.moduleId, 'game.session');
    assert.equal(intent.operation, op);
    assert.equal(intent.workerRoute, '/session/step');
    assert.equal(intent.operatorOnly, false);
  }
});

test('the game.session branch is game-agnostic (no appId in the intent)', () => {
  // The same intent is produced regardless of which game submitted it — routing
  // never depends on appId (the worker loads the engine by (appId, engineHash)).
  const a = resolveKernelIntent('session.finalize');
  const b = resolveKernelIntent('session.finalize');
  assert.deepEqual(a, b);
  assert.equal(resolveWorkerRoute('session.finalize'), '/session/finalize');
  assert.equal(isOperatorOnlyRequestType('session.finalize'), false); // permissionless settle
});

test('buildWorkerPayload carries the game.session kernel intent for finalize', () => {
  const payload = buildWorkerPayload(
    'neo_n3',
    'session.finalize',
    { app_id: 'miniapp-snake-bounty' },
    '123',
    {
      requester: '0xabc',
    }
  );
  assert.equal(payload.kernel_module_id, 'game.session');
  assert.equal(payload.kernel_operation, 'session.finalize');
  assert.equal(payload.legacy_request_type, 'session.finalize');
  assert.equal(payload.request_id, '123');
});

test('encodeFulfillmentResult forwards the 79-byte result via game_result_v1', () => {
  const workerResponse = {
    ok: true,
    status: 200,
    body: {
      result_bytes_base64: GOLDEN_RESULT.toString('base64'),
      callback_encoding: 'game_result_v1',
      problem_hash: 'ab'.repeat(32),
      answer_hash: 'cd'.repeat(32),
      score: 20,
      undos: 2,
      difficulty: 1,
    },
  };
  const fulfillment = encodeFulfillmentResult('session.finalize', workerResponse);
  assert.equal(fulfillment.success, true);
  assert.equal(fulfillment.result, ''); // compact-callback path — result string empty
  assert.ok(fulfillment.result_bytes_base64, 'result bytes must be forwarded');
  const bytes = Buffer.from(fulfillment.result_bytes_base64, 'base64');
  assert.equal(bytes.length, 79);
  assert.ok(bytes.equals(GOLDEN_RESULT));
});

test('encodeFulfillmentResult ignores a malformed result_bytes (wrong length / tag)', () => {
  // A body claiming game_result_v1 but carrying non-codec bytes must NOT be
  // treated as the compact callback (fail-closed to the JSON envelope path).
  const bad = Buffer.from('deadbeef', 'hex');
  const fulfillment = encodeFulfillmentResult('session.finalize', {
    ok: true,
    status: 200,
    body: { result_bytes_base64: bad.toString('base64'), callback_encoding: 'game_result_v1' },
  });
  assert.notEqual(fulfillment.result_bytes_base64, bad.toString('base64'));
});

test('buildFulfillmentDigestBytes binds SHA256(result) over the 79-byte codec', () => {
  const fulfillment = encodeFulfillmentResult('session.finalize', {
    ok: true,
    status: 200,
    body: {
      result_bytes_base64: GOLDEN_RESULT.toString('base64'),
      callback_encoding: 'game_result_v1',
    },
  });

  // The kernel ComputeFulfillmentDigest hashes SHA256(result) generically; the
  // digest must therefore incorporate the SHA256 of the exact 79 codec bytes.
  const digest = buildFulfillmentDigestBytes(
    '99',
    'session.finalize',
    true,
    fulfillment.result,
    fulfillment.error,
    fulfillment.result_bytes_base64,
    {
      chain: 'neo_n3',
      appId: 'miniapp-color-clash',
      moduleId: 'game.session',
      operation: 'session.finalize',
    }
  );

  // Independently recompute the expected digest with SHA256(GOLDEN_RESULT) inline
  // to prove the codec bytes (not a JSON envelope) drive the signature.
  const DOMAIN = Buffer.from('miniapp-os-fulfillment-v2', 'utf8');
  const u256 = (v) => Buffer.from(BigInt(v).toString(16).padStart(64, '0'), 'hex');
  const sha = (b) => createHash('sha256').update(b).digest();
  const expected = createHash('sha256')
    .update(
      Buffer.concat([
        DOMAIN,
        u256('99'),
        sha(Buffer.from('miniapp-color-clash', 'utf8')),
        sha(Buffer.from('game.session', 'utf8')),
        sha(Buffer.from('session.finalize', 'utf8')),
        sha(Buffer.from('', 'utf8')),
        Buffer.from([1]),
        sha(GOLDEN_RESULT),
        sha(Buffer.from('', 'utf8')),
      ])
    )
    .digest();
  assert.equal(digest.toString('hex'), expected.toString('hex'));

  // And the SHA256 of the result bytes matches the cross-pinned golden vector.
  assert.equal(createHash('sha256').update(GOLDEN_RESULT).digest('hex'), GOLDEN_SHA256);
});

test('a game.session finalize failure produces a plain failure (no result bytes)', () => {
  const fulfillment = encodeFulfillmentResult('session.finalize', {
    ok: false,
    status: 403,
    body: { error: 'target not reached' },
  });
  assert.equal(fulfillment.success, false);
  assert.equal(fulfillment.result, '');
  assert.match(fulfillment.error, /target not reached/);
  assert.ok(!fulfillment.result_bytes_base64);
});
