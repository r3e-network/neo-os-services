import assert from 'node:assert/strict';
import { readFuzzSeed } from './seed.mjs';
import { parseConfidentialEnvelope } from '../packages/shared/src/confidential-envelope.js';
import { decodeCoseSign1 } from '../packages/shared/src/cbor.js';
import {
  decodePayloadText,
  resolveKernelIntent,
  buildWorkerPayload,
  buildFulfillmentDigestBytes,
} from '../workers/morpheus-relayer/src/router.js';
import {
  decimalToIntegerString,
  integerToDecimalString,
} from '../workers/nitro-worker/src/oracle/feeds/decimal.js';

const seeds = process.env.FUZZ_SEED ? [readFuzzSeed()] : [20261005, 20260928, 4294967295];
const seconds = Number(process.env.FUZZ_SECONDS || 0);
assert(Number.isFinite(seconds) && seconds >= 0 && seconds <= 600);
const start = performance.now();
const states = seeds.map((seed) => ({ seed, state: seed, cases: 0 }));
const counts = { body: 0, intent: 0, delivery: 0, envelope: 0, cose: 0, price: 0 };
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
// Positive controls exercise the same targets as the malformed corpus.
const validEnvelope = {
  v: 2,
  alg: 'X25519-HKDF-SHA256-AES-256-GCM',
  epk: 'AQ==',
  iv: 'Ag==',
  ct: 'Aw==',
  tag: 'BA==',
};
assert.deepEqual(
  parseConfidentialEnvelope(Buffer.from(JSON.stringify(validEnvelope)).toString('base64')),
  validEnvelope
);
assert.deepEqual(decodeCoseSign1(Buffer.from('8440a041a040', 'hex')).payload, {});
assert.equal(resolveKernelIntent('session.finalize').workerRoute, '/session/finalize');
assert.equal(decimalToIntegerString('1.25'), '1250000');

do {
  for (const s of states) {
    for (let batch = 0; batch < 100; batch++) {
      const input = value(s);
      const text = JSON.stringify(input);
      const kind = kinds[next(s) % kinds.length];
      const bytes = Buffer.from(Array.from({ length: next(s) % 96 }, () => next(s) & 255));
      try {
        assert.deepEqual(decodePayloadText(text), input);
        assert.deepEqual(decodePayloadText(`${text}!`), { raw_payload: `${text}!` });
        counts.body++;
        const intent = resolveKernelIntent(kind);
        assert.deepEqual(resolveKernelIntent(kind.toUpperCase()), intent);
        assert.equal(intent.operatorOnly, kind === 'feed');
        assert(intent.workerRoute.startsWith('/'));
        counts.intent++;
        // The delivery builder takes an object after the body decoder; fuzz its fields.
        const body = { value: input, request_id: input, kernel_module_id: input };
        const payload = buildWorkerPayload('neo_n3', kind, body, String(s.cases));
        assert.equal(payload.request_id, String(s.cases));
        assert.equal(payload.kernel_module_id, intent.moduleId);
        const digest = buildFulfillmentDigestBytes(String(s.cases), kind, true, text, '', '');
        assert.equal(digest.length, 32);
        assert(
          !digest.equals(buildFulfillmentDigestBytes(String(s.cases + 1), kind, true, text, '', ''))
        );
        counts.delivery++;
        assert.equal(parseConfidentialEnvelope(Buffer.from(text).toString('base64')), null);
        const invalid = { ...validEnvelope, v: 3, ct: text };
        assert.equal(
          parseConfidentialEnvelope(Buffer.from(JSON.stringify(invalid)).toString('base64')),
          null
        );
        counts.envelope++;
        try {
          const decoded = decodeCoseSign1(bytes);
          assert(Buffer.isBuffer(decoded.payloadBytes));
          assert(decoded.payload && typeof decoded.payload === 'object');
        } catch (error) {
          // Parser's explicit rejection is expected; native Type/Range errors are failures.
          assert.equal(error.constructor, Error);
          assert.match(error.message, /^(cbor|cose):/);
        }
        counts.cose++;
        const integer = String(next(s) % 1000000000);
        assert.equal(decimalToIntegerString(integerToDecimalString(integer)), integer);
        rejected(() => decimalToIntegerString(`${text}x`), /^invalid decimal value:/);
        counts.price++;
      } catch (error) {
        console.error(
          JSON.stringify({
            seed: s.seed,
            case: s.cases,
            input,
            kind,
            bytes: bytes.toString('hex'),
            error: error.stack,
          })
        );
        process.exit(1);
      }
      s.cases++;
    }
  }
} while (performance.now() - start < seconds * 1000);
console.log(
  JSON.stringify({
    suite: 'services-node',
    elapsedSeconds: (performance.now() - start) / 1000,
    seeds: states.map(({ seed, cases }) => ({ seed, cases })),
    counts,
  })
);
