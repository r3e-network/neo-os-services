import assert from 'node:assert/strict';
import { readFuzzSeed } from './seed.mjs';
import {
  CONFIDENTIAL_ENVELOPE_ALGORITHM,
  CONFIDENTIAL_ENVELOPE_VERSION,
  parseConfidentialEnvelope,
} from '../packages/shared/src/confidential-envelope.js';
import { decodeCoseSign1 } from '../packages/shared/src/cbor.js';
import {
  decodePayloadText,
  resolveKernelIntent,
  isOperatorOnlyRequestType,
  normalizeRequestType,
  buildWorkerPayload,
  buildFulfillmentDigestBytes,
} from '../workers/morpheus-relayer/src/router.js';
import {
  buildPreparedFulfillment,
  buildPreparedFulfillmentRetryMeta,
  buildCallbackPendingWorkerResponse,
} from '../workers/morpheus-relayer/src/fulfillment/delivery.js';
import { handlePaymasterAuthorize } from '../workers/nitro-worker/src/paymaster/index.js';
import {
  decimalToIntegerString,
  integerToDecimalString,
} from '../workers/nitro-worker/src/oracle/feeds/decimal.js';
import { clampFeedTimestampSec } from '../workers/nitro-worker/src/oracle/feeds/shared.js';

// Committed seeds: a failing input replays with FUZZ_SEED=<seed>. The three
// values are fixed so a CI run and a local run explore the same streams.
const seeds = process.env.FUZZ_SEED ? [readFuzzSeed()] : [20261005, 20260928, 4294967295];
const seconds = Number(process.env.FUZZ_SECONDS || 0);
assert(Number.isFinite(seconds) && seconds >= 0 && seconds <= 600);
const start = performance.now();
const states = seeds.map((seed) => ({ seed, state: seed, cases: 0 }));
const targets = {
  body: 0,
  intent: 0,
  delivery: 0,
  prepared: 0,
  envelope: 0,
  cose: 0,
  price: 0,
  feed: 0,
  sponsor: 0,
};
// Outcome counters exist so a generator that silently stops exploring, or an
// implementation that answers every input the same way, cannot pass unnoticed.
const outcomes = {
  jsonBody: 0,
  rawFallback: 0,
  envelopeAccepted: 0,
  envelopeRejected: 0,
  feedClamped: 0,
  feedRejected: 0,
  sponsorRefused: 0,
};
const atoms = [null, true, false, 0, -1, 1e100, '', 'é00000', '💰', '\u0000', '1e309'];
const kinds = [
  'random',
  'price',
  'session.finalize',
  'automation_execute',
  'feed',
  'paymaster',
  'unknown',
  '',
];
function next(s) {
  let x = s.state;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  s.state = x >>> 0;
  return s.state;
}
function value(s, depth = 0) {
  const n = next(s);
  if (n % 7 === 0) {
    const alphabet = ['0', '9', '-', '+', '.', 'e', 'é', '💰', '\0', '中'];
    return Array.from({ length: next(s) % 48 }, () => alphabet[next(s) % alphabet.length]).join('');
  }
  if (depth === 3 || n % 3 === 0) return atoms[n % atoms.length];
  if (n % 3 === 1) return [value(s, depth + 1), value(s, depth + 1)];
  return { type: value(s, depth + 1), value: value(s, depth + 1) };
}
function rejected(fn, prefix) {
  assert.throws(fn, (error) => error.constructor === Error && prefix.test(error.message));
}
function fail(seed, index, target, input, error) {
  console.error(
    JSON.stringify({
      seed,
      case: index,
      target,
      input,
      error: String(error?.stack || error),
    })
  );
  process.exit(1);
}

// Positive controls exercise the same targets as the malformed corpus, so an
// implementation that rejects or mangles everything cannot pass.
const validEnvelope = {
  v: CONFIDENTIAL_ENVELOPE_VERSION,
  alg: CONFIDENTIAL_ENVELOPE_ALGORITHM,
  epk: 'AQ==',
  iv: 'Ag==',
  ct: 'Aw==',
  tag: 'BA==',
};
const validEnvelopeBase64 = Buffer.from(JSON.stringify(validEnvelope)).toString('base64');
assert.deepEqual(parseConfidentialEnvelope(validEnvelopeBase64), validEnvelope);
assert.deepEqual(decodeCoseSign1(Buffer.from('8440a041a040', 'hex')).payload, {});
assert.equal(resolveKernelIntent('session.finalize').workerRoute, '/session/finalize');
assert.equal(resolveKernelIntent('FEED.PUBLISH').operatorOnly, true);
assert.equal(decimalToIntegerString('1.25'), '1250000');
assert.equal(decimalToIntegerString(integerToDecimalString('1250000')), '1250000');
assert.equal(
  clampFeedTimestampSec({
    upstreamSec: 100,
    prevTs: 0,
    nowSec: 1000,
    maxFutureSeconds: 60,
    futureSkewSeconds: 5,
  }),
  100
);
assert.equal(resolveKernelIntent(42).workerRoute, '/oracle/smart-fetch');
assert.deepEqual(decodePayloadText(''), {});
// Regression (CU-179): a request body of literal JSON `null` decodes to null
// and must still produce a worker envelope instead of dereferencing null.
const nullBodyEnvelope = buildWorkerPayload('neo_n3', 'oracle.fetch', decodePayloadText('null'), '1');
assert.equal(nullBodyEnvelope.request_id, '1');
assert.equal(nullBodyEnvelope.target_chain, 'neo_n3');

function exerciseBody(s, text) {
  const decoded = decodePayloadText(text);
  // Trimming around a payload must not change what it decodes to.
  assert.deepEqual(decodePayloadText(`  ${text}  `), decoded);
  if (decoded && typeof decoded === 'object' && !Array.isArray(decoded) && 'raw_payload' in decoded) {
    outcomes.rawFallback += 1;
  } else {
    outcomes.jsonBody += 1;
  }
  // A truncated payload must fall back to the raw text rather than throw.
  const cut = text.slice(0, 1 + (next(s) % Math.max(1, text.length)));
  const truncated = decodePayloadText(cut);
  if (truncated && typeof truncated === 'object' && 'raw_payload' in truncated) {
    assert.equal(truncated.raw_payload, cut.trim());
    outcomes.rawFallback += 1;
  }
  // Regression (CU-179): a request body of literal JSON `null` decodes to null
  // and must still produce a worker envelope instead of dereferencing null.
  const envelope = buildWorkerPayload('neo_n3', 'oracle.fetch', decoded, '1');
  assert.equal(envelope.request_id, '1');
  assert.equal(envelope.target_chain, 'neo_n3');
  targets.body += 1;
  return decoded;
}

function exerciseIntent(kind) {
  const intent = resolveKernelIntent(kind);
  // Request types are case-insensitive: normalization happens before routing.
  assert.deepEqual(resolveKernelIntent(String(kind).toUpperCase()), intent);
  assert.equal(intent.operatorOnly, normalizeRequestType(kind).includes('feed'));
  assert.equal(isOperatorOnlyRequestType(kind), intent.operatorOnly);
  assert.match(intent.workerRoute, /^\/[a-z]/);
  assert.ok(intent.moduleId.length > 0);
  targets.intent += 1;
  return intent;
}

function exerciseDelivery(kind, text, decoded, index) {
  const intent = resolveKernelIntent(kind);
  const payload = buildWorkerPayload('neo_n3', kind, decoded, String(index), {
    requester: 'requester',
    callbackContract: 'callback',
    callbackMethod: 'method',
  });
  assert.equal(payload.request_id, String(index));
  assert.equal(payload.request_source, 'morpheus-relayer:neo_n3');
  assert.equal(payload.legacy_request_type, normalizeRequestType(kind));
  assert.equal(payload.kernel_module_id, intent.moduleId);
  assert.equal(payload.kernel_operation, intent.operation);
  assert.equal(payload.requester, 'requester');
  const options = { appId: `app-${index}`, moduleId: intent.moduleId, operation: intent.operation };
  const digest = buildFulfillmentDigestBytes(String(index), kind, true, text, '', '', options);
  assert.equal(digest.length, 32);
  // Binding: a different request id, result or envelope tuple changes the digest.
  assert(
    !digest.equals(buildFulfillmentDigestBytes(String(index + 1), kind, true, text, '', '', options))
  );
  assert(
    !digest.equals(
      buildFulfillmentDigestBytes(String(index), kind, true, `${text} `, '', '', options)
    )
  );
  assert(
    !digest.equals(
      buildFulfillmentDigestBytes(String(index), kind, true, text, '', '', {
        ...options,
        operation: `${options.operation}.other`,
      })
    )
  );
  targets.delivery += 1;
}

function exercisePrepared(kind, text, decoded) {
  const retry = buildPreparedFulfillmentRetryMeta({
    success: decoded,
    result: decoded,
    result_bytes_base64: decoded,
    error: decoded,
    route: decoded,
    module_id: decoded,
    operation: decoded,
    worker_status: decoded,
    worker_response: decoded,
    verification_signature: decoded,
    trust_tier: decoded,
  });
  // The retry record is persisted and replayed: every field must keep its type.
  assert.equal(typeof retry.success, 'boolean');
  for (const field of [
    'result',
    'result_bytes_base64',
    'error',
    'route',
    'module_id',
    'operation',
    'verification_signature',
    'trust_tier',
  ]) {
    assert.equal(typeof retry[field], 'string', `retry.${field}`);
  }
  assert.ok(retry.worker_status === null || Number.isFinite(retry.worker_status));
  assert.ok(
    retry.worker_response === null || typeof retry.worker_response === 'object',
    'retry.worker_response'
  );
  const prepared = buildPreparedFulfillment(
    { success: true, result: text, result_bytes_base64: '' },
    { route: kind, module_id: 'module', operation: 'operation', worker_status: decoded }
  );
  assert.equal(prepared.route, kind);
  assert.equal(prepared.module_id, 'module');
  assert.equal(prepared.success, true);
  assert.equal(typeof prepared.trust_tier, 'string');
  const callback = buildCallbackPendingWorkerResponse(
    { ...prepared, worker_response: decoded && typeof decoded === 'object' ? decoded : null },
    resolveKernelIntent(kind)
  );
  assert.equal(callback.retry_meta.module_id, prepared.module_id);
  assert.equal(callback.retry_meta.operation, prepared.operation);
  assert.equal(typeof callback.retry_meta.prepared_fulfillment, 'object');
  targets.prepared += 1;
}

function exerciseEnvelope(text) {
  const parsed = parseConfidentialEnvelope(Buffer.from(text).toString('base64'));
  if (parsed === null) outcomes.envelopeRejected += 1;
  else {
    // Anything accepted must be a complete envelope; partial ones fail closed.
    outcomes.envelopeAccepted += 1;
    assert.equal(Number(parsed.v ?? parsed.version), 2);
    assert.equal(String(parsed.alg ?? parsed.algorithm), CONFIDENTIAL_ENVELOPE_ALGORITHM);
    assert.ok(parsed.epk && parsed.iv && parsed.ct && parsed.tag);
  }
  for (const invalid of [
    { ...validEnvelope, v: 3 },
    { ...validEnvelope, alg: 'X25519-OTHER' },
    { ...validEnvelope, epk: '' },
    { ...validEnvelope, ct: '' },
    { ...validEnvelope, tag: '   ' },
  ]) {
    assert.equal(
      parseConfidentialEnvelope(Buffer.from(JSON.stringify(invalid)).toString('base64')),
      null
    );
  }
  // A valid envelope is accepted even while the malformed corpus is rejected.
  assert.notEqual(parseConfidentialEnvelope(validEnvelopeBase64), null);
  outcomes.envelopeAccepted += 1;
  targets.envelope += 1;
}

function exerciseCose(bytes) {
  try {
    const decoded = decodeCoseSign1(bytes);
    assert(Buffer.isBuffer(decoded.payloadBytes));
    assert.ok(decoded.payload && typeof decoded.payload === 'object');
    assert.deepEqual(decodeCoseSign1(bytes).payload, decoded.payload);
  } catch (error) {
    // The decoder's own rejection is expected; native Type/Range errors are failures.
    assert.equal(error.constructor, Error);
    assert.match(error.message, /^(cbor|cose):/);
  }
  targets.cose += 1;
}

function exercisePrice(s, text) {
  const integer = String(next(s) % 1000000000);
  assert.equal(decimalToIntegerString(integerToDecimalString(integer)), integer);
  rejected(() => decimalToIntegerString(`${text}x`), /^invalid decimal value:/);
  targets.price += 1;
}

function exerciseFeed(s) {
  const upstreamSec = next(s) % 2000000000;
  const prevTs = next(s) % 2000000000;
  const nowSec = next(s) % 2000000000;
  const maxFutureSeconds = 1 + (next(s) % 600);
  const futureSkewSeconds = next(s) % 300;
  let clamped;
  let rejection = null;
  try {
    clamped = clampFeedTimestampSec({
      upstreamSec,
      prevTs,
      nowSec,
      maxFutureSeconds,
      futureSkewSeconds,
    });
  } catch (error) {
    rejection = error;
  }
  if (rejection) {
    // Only the documented feed-timestamp rejection is allowed, and only for a
    // timestamp beyond the caller's future tolerance.
    outcomes.feedRejected += 1;
    assert.equal(rejection.constructor.name, 'FeedTimestampError');
    assert.ok(upstreamSec > nowSec + maxFutureSeconds, 'rejected a timestamp inside the tolerance');
  } else {
    outcomes.feedClamped += 1;
    assert.ok(Number.isInteger(clamped));
    // Strictly monotonic above the last anchored timestamp, and never beyond
    // the caller's future tolerance or the upstream value itself. The monotonic
    // floor can exceed both when prevTs is already ahead of them.
    assert.ok(clamped >= Math.max(Math.floor(prevTs), 0) + 1, `not monotonic: ${clamped}`);
    assert.ok(
      clamped <= Math.max(Math.floor(prevTs) + 1, Math.floor(nowSec) + futureSkewSeconds),
      `beyond the future tolerance: ${clamped}`
    );
    assert.ok(
      clamped <= Math.max(Math.floor(prevTs) + 1, Math.floor(upstreamSec)),
      `beyond the upstream timestamp: ${clamped}`
    );
  }
  targets.feed += 1;
}

async function exerciseSponsor(decoded) {
  const payload =
    decoded && typeof decoded === 'object' && !Array.isArray(decoded) ? decoded : { value: decoded };
  const response = await handlePaymasterAuthorize(payload);
  assert.ok(Number.isInteger(response.status), 'sponsor status');
  assert.ok(response.status === 200 || response.status === 400, `sponsor status ${response.status}`);
  // Sponsorship is not enabled in this suite: no input may be approved.
  assert.notEqual(response.body?.approved, true, 'sponsor approved with the policy disabled');
  if (response.status === 200) {
    outcomes.sponsorRefused += 1;
    assert.equal(response.body.mode, 'paymaster_authorize');
  }
  targets.sponsor += 1;
}

let caseIndex = 0;
do {
  for (const s of states) {
    for (let batch = 0; batch < 100; batch++) {
      const input = value(s);
      const text = JSON.stringify(input);
      const kind = kinds[next(s) % kinds.length];
      const bytes = Buffer.from(Array.from({ length: next(s) % 96 }, () => next(s) & 255));
      try {
        const decoded = exerciseBody(s, text);
        exerciseIntent(kind);
        exerciseDelivery(kind, text, decoded, caseIndex);
        exercisePrepared(kind, text, decoded);
        exerciseEnvelope(text);
        exerciseCose(bytes);
        exercisePrice(s, text);
        exerciseFeed(s);
        await exerciseSponsor(decoded);
      } catch (error) {
        fail(s.seed, s.cases, 'services-node', { input, text, kind }, error);
      }
      s.cases++;
      caseIndex++;
    }
  }
} while (performance.now() - start < seconds * 1000);

// The receipt is machine-checked by run-services-inputs.mjs: a truncated or
// replaced suite fails the run instead of passing with no cases explored.
console.log(
  `SERVICES_INPUTS_RECEIPT ${JSON.stringify({
    suite: 'services-node',
    elapsedSeconds: (performance.now() - start) / 1000,
    seeds: states.map(({ seed, cases }) => ({ seed, cases })),
    targets,
    outcomes,
  })}`
);
