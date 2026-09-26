/**
 * Export golden vectors from the Node implementations into
 * crates/neo-os-core/tests/vectors/ so the Rust ports are verified against
 * the JS oracle byte-for-byte (see docs/SIGNER_SERVICE.md sibling plan: a hash
 * mismatch is a merge blocker).
 *
 * The oracle is ALWAYS the real production module — this script imports
 * packages/shared and workers/morpheus-relayer sources and records their
 * output; it never re-derives anything. Re-run after touching any pinned
 * implementation and commit the refreshed JSON together with the change:
 *
 *   node scripts/export-rust-vectors.mjs           # regenerate + overwrite
 *   node scripts/export-rust-vectors.mjs --check   # verify committed files match
 *
 * Encoding conventions (the Rust side reconstructs values from these):
 * - JS scalars are tagged so non-JSON values survive the round trip:
 *   {__t:'undefined'} | {__t:'null'} | {__t:'bool',v} | {__t:'number',v} |
 *   {__t:'bigint',v} | {__t:'string',v}
 *   `number` v is the JSON.stringify output form ('0.1', '1e+21', 'null' for
 *   NaN/Infinity) — the JS double formatter itself is pinned separately when
 *   the wasm lane is ported; here it is canonical input, not a test subject.
 * - CBOR byte strings: {__t:'bytes', hex}
 * - stableStringify key order is pinned by Intl.Collator('en',
 *   {sensitivity:'variant', caseFirst:'false'}) — the collation corpus below is
 *   the acceptance gate for reproducing that collation in Rust. It inherits the
 *   documented residual ICU-version axis of the Node runtime (packages/shared/
 *   src/utils.js), consistent across the deployed Node 22 runtimes.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { STABLE_STRINGIFY_GOLDEN_VECTORS } from '../packages/shared/src/stable-stringify-vectors.mjs';
import { stableStringify } from '../packages/shared/src/utils.js';
import { cborRead, decodeCoseSign1, decodeCoseSign1Payload } from '../packages/shared/src/cbor.js';
import {
  buildCoseSign1SigStructure,
  coseEs384SignatureToDer,
} from '../packages/shared/src/cose-verify.js';
import {
  buildFulfillmentDigestBytes,
  encodeFulfillmentResult,
  buildOnchainResultEnvelope,
  buildWorkerPayload,
} from '../workers/morpheus-relayer/src/router.js';
import { buildNeoXDigest, resolveResultBytesHex } from '../workers/morpheus-relayer/src/neox.js';
import { computeRetryDelayMs } from '../workers/morpheus-relayer/src/lib/retry.js';
import {
  isSecretName,
  redactSecretValues,
} from '../workers/morpheus-relayer/src/lib/secret-redaction.js';
import {
  buildEventKey,
  collectActiveRequestIds,
  createEmptyRelayerState,
  enqueueRetryItem,
  enforceRetryQueueLimit,
  getDueRetryItems,
  incrementLabeledFailure,
  recordProcessedEvent,
  scheduleRetry,
  snapshotMetrics,
} from '../workers/morpheus-relayer/src/state.js';
import { normalizeMorpheusNetwork } from '../packages/shared/src/neo-signers-core.js';
import {
  createRelayerConfig,
  env,
  envNetworkScoped,
} from '../workers/morpheus-relayer/src/config.js';
import { sc, tx, u, wallet } from '@cityofzion/neon-js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vectorsDir = path.join(repoRoot, 'crates', 'neo-os-core', 'tests', 'vectors');

// ── value tagging ────────────────────────────────────────────────────────────

function tag(value) {
  if (value === undefined) return { __t: 'undefined' };
  if (value === null) return { __t: 'null' };
  switch (typeof value) {
    case 'boolean':
      return { __t: 'bool', v: value };
    case 'number':
      return { __t: 'number', v: JSON.stringify(value) };
    case 'bigint':
      return { __t: 'bigint', v: value.toString() };
    case 'string':
      return { __t: 'string', v: value };
    default:
      break;
  }
  if (Array.isArray(value)) return { __t: 'array', v: value.map(tag) };
  const entries = Object.entries(value).map(([k, v]) => [k, tag(v)]);
  return { __t: 'object', v: Object.fromEntries(entries) };
}

function tagBytes(buffer) {
  return { __t: 'bytes', hex: buffer.toString('hex') };
}

// CBOR decoded values carry Buffers and undefined; tag them the same way.
function tagCbor(value) {
  if (Buffer.isBuffer(value)) return tagBytes(value);
  if (value === undefined) return { __t: 'undefined' };
  if (Array.isArray(value)) return value.map(tagCbor);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, tagCbor(v)]));
  }
  return value;
}

const utf8 = (s) => Buffer.from(s, 'utf8');
// CBOR text string (major 3) for keys ≤ 23 bytes: header byte 0x60|len + utf8 body.
const text = (s) => Buffer.concat([Buffer.from([0x60 | Buffer.byteLength(s)]), utf8(s)]);
const hexBuf = (h) => Buffer.from(h, 'hex');

// ── stableStringify family ───────────────────────────────────────────────────

function stableStringifyFamily() {
  // The pinned vectors double as a drift alarm for the JS oracle itself: if the
  // implementation stops reproducing them, exporting would silently bless a
  // changed collation. Fail loudly here instead.
  for (const vector of STABLE_STRINGIFY_GOLDEN_VECTORS) {
    const actual = stableStringify(vector.input);
    if (actual !== vector.expected) {
      throw new Error(
        `stableStringify drifted from its pinned golden vectors (${vector.name}): ` +
          `expected ${vector.expected}, got ${actual}`
      );
    }
  }
  const cases = STABLE_STRINGIFY_GOLDEN_VECTORS.map((vector) => ({
    name: vector.name,
    input: tag(vector.input),
    expected: vector.expected,
  }));
  return { family: 'stable_stringify', cases };
}

// Deterministic LCG so regeneration produces identical files.
function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const COLLATION_ALPHABET = [
  'alpha',
  'Beta',
  'GAMMA',
  'delta',
  'Epsilon',
  'zeta',
  'a1',
  'A1',
  'a_1',
  'a.1',
  'a-1',
  'a:b',
  '10',
  '2',
  'x',
  'X',
  '_x',
  'ZZZ',
  'zzz',
  'aa',
  'AA',
  'Ab',
  'aB',
  'ключ',
  '键',
  'café',
  'naïve',
  'éclair',
  'e\u0301clair',
  '🚀',
  'emoji',
  '🙂',
];

function collationFamily() {
  const random = lcg(0x4d4f5243);
  const cases = [];
  for (let round = 0; round < 150; round += 1) {
    const count = 2 + Math.floor(random() * 6);
    const picked = new Set();
    while (picked.size < count) {
      picked.add(COLLATION_ALPHABET[Math.floor(random() * COLLATION_ALPHABET.length)]);
    }
    const keys = [...picked];
    const value = {};
    keys.forEach((key, index) => {
      value[key] = index;
    });
    cases.push({ name: `corpus-${round}`, keys, expected: stableStringify(value) });
  }
  return { family: 'key_collation_corpus', cases };
}

// ── CBOR / COSE families ─────────────────────────────────────────────────────

function cborFamily() {
  const ok = (name, bytes, note) => {
    const hex = bytes.toString('hex');
    const { value } = cborRead(bytes, 0);
    return { name, hex, decoded: tagCbor(value), note: note || null };
  };
  const err = (name, bytes, _error) => {
    const hex = bytes.toString('hex');
    try {
      cborRead(bytes, 0);
    } catch (caught) {
      return { name, hex, error: caught.message };
    }
    throw new Error(`cbor case ${name} was expected to fail`);
  };
  const errCose = (name, bytes, _error) => {
    const hex = bytes.toString('hex');
    try {
      decodeCoseSign1(bytes);
    } catch (caught) {
      return { name, hex, error: caught.message };
    }
    throw new Error(`cose case ${name} was expected to fail`);
  };

  const attestationPayloadInner = Buffer.concat([
    Buffer.from([0xa2]),
    Buffer.from([0x60 | Buffer.byteLength('pcrs')]),
    utf8('pcrs'),
    Buffer.from([0xbf, 0x00, 0x41, 0xbb, 0xff]), // {_ 0: h'BB'}
    text('x'),
    Buffer.from([0x41, 0xaa]), // h'AA'
  ]);
  const cose = (payloadInner) =>
    Buffer.concat([
      Buffer.from([0x84, 0x40, 0xa0, 0x40 | payloadInner.length]),
      payloadInner,
      Buffer.from([0x40]),
    ]);

  const cases = [
    ok('definite map', Buffer.from([0xa1, 0x61, 0x61, 0x01])),
    ok('indefinite map', Buffer.from([0xbf, 0x61, 0x61, 0x01, 0xff])),
    ok('definite array', Buffer.from([0x83, 0x01, 0x02, 0x03])),
    ok('indefinite array', Buffer.from([0x9f, 0x01, 0x02, 0x03, 0xff])),
    ok('definite byte string', Buffer.from([0x45, 0x01, 0x02, 0x03, 0x04, 0x05])),
    ok(
      'indefinite byte string chunks',
      Buffer.from([0x5f, 0x42, 0x01, 0x02, 0x43, 0x03, 0x04, 0x05, 0xff])
    ),
    ok('indefinite text string chunks', Buffer.from([0x7f, 0x62, 0x61, 0x62, 0x61, 0x63, 0xff])),
    ok('uint8 length', Buffer.from([0x18, 0x64])),
    ok('uint16 length', Buffer.from([0x19, 0x01, 0x00])),
    ok('uint32 length', Buffer.from([0x1a, 0x00, 0x01, 0x00, 0x00])),
    ok('negative integer', Buffer.from([0x29])),
    ok('true', Buffer.from([0xf5])),
    ok('false', Buffer.from([0xf4])),
    ok('null', Buffer.from([0xf6])),
    ok('undefined', Buffer.from([0xf7])),
    // The shared decoder decodes "just enough": floats fall back to null.
    ok('half float decodes as null', Buffer.from([0xf9, 0x3c, 0x00])),
    ok('single float decodes as null', Buffer.from([0xfa, 0x3f, 0x80, 0x00, 0x00])),
    ok('tag passthrough', Buffer.from([0xc1, 0x01])),
    ok('nested containers', Buffer.from([0x82, 0xa1, 0x61, 0x61, 0x81, 0x01, 0x02])),
    {
      name: 'cose sign1 definite payload',
      ...(() => {
        const input = Buffer.from([0x84, 0x40, 0xa0, 0x44, 0xa1, 0x61, 0x61, 0x01, 0x40]);
        const decoded = decodeCoseSign1(input);
        return {
          hex: input.toString('hex'),
          protected_header_hex: decoded.protectedHeaderBytes.toString('hex'),
          payload_bytes_hex: decoded.payloadBytes.toString('hex'),
          payload: tagCbor(decoded.payload),
          signature_hex: decoded.signature.toString('hex'),
        };
      })(),
    },
    {
      name: 'cose sign1 indefinite payload map (the producer/verifier case)',
      ...(() => {
        const input = Buffer.from([0x84, 0x40, 0xa0, 0x45, 0xbf, 0x61, 0x61, 0x01, 0xff, 0x40]);
        const decoded = decodeCoseSign1(input);
        return {
          hex: input.toString('hex'),
          protected_header_hex: decoded.protectedHeaderBytes.toString('hex'),
          payload_bytes_hex: decoded.payloadBytes.toString('hex'),
          payload: tagCbor(decoded.payload),
          signature_hex: decoded.signature.toString('hex'),
        };
      })(),
    },
    {
      name: 'cose sign1 attestation-shaped payload',
      ...(() => {
        const input = cose(attestationPayloadInner);
        const decoded = decodeCoseSign1Payload(input);
        return { hex: input.toString('hex'), payload: tagCbor(decoded) };
      })(),
    },
    err('reserved minor 28', Buffer.from([0x1c]), 'unsupported minor 28'),
    err(
      'oversized declared string',
      Buffer.from([0x5a, 0x7f, 0xff, 0xff, 0xff]),
      'string length exceeds limit'
    ),
    err(
      'excessive nesting',
      Buffer.concat([Buffer.alloc(34, 0x81), Buffer.from([0x00])]),
      'nesting depth exceeds limit'
    ),
    err(
      'array length over limit',
      Buffer.from([0x9a, 0x00, 0x00, 0x20, 0x00]),
      'array length exceeds limit'
    ),
    errCose('not a 4-element cose', Buffer.from([0x83, 0x40, 0xa0, 0x40]), '4-element COSE_Sign1'),
    errCose(
      'payload not a byte string',
      Buffer.from([0x84, 0x40, 0xa0, 0x01, 0x40]),
      'not a byte string'
    ),
    err('truncated input', Buffer.from([0x82, 0x01]), 'truncated'),
  ];
  return { family: 'cbor_decode', cases };
}

function coseFamily() {
  const sigCases = [
    { name: 'empty protected and payload', protected: '', payload: '' },
    { name: 'attestation-shaped', protected: 'a161613824', payload: 'a1616101' },
    {
      name: '256+ byte payload (second length class)',
      protected: Buffer.concat([
        Buffer.from([0xa2, 0x01, 0x38, 0x24, 0x02]),
        utf8('ES384'),
      ]).toString('hex'),
      payload: Buffer.concat([
        Buffer.from([0xa1]),
        utf8('user_data'),
        Buffer.from([0x44, 0xde, 0xad, 0xbe, 0xef]),
      ]).toString('hex'),
    },
  ];

  const derCases = [
    { name: 'high-bit set both halves', raw: 'ff'.repeat(96) },
    {
      name: 'leading zero trimmed',
      raw: '00'.repeat(40) + 'ff'.repeat(8) + '00'.repeat(40) + 'ee'.repeat(8),
    },
    { name: 'exactly 48/48 bytes', raw: '80'.repeat(96) },
  ];

  return {
    family: 'cose_sign1',
    cases: [
      ...sigCases.map((c) => ({
        name: c.name,
        kind: 'sig_structure',
        protected_hex: c.protected,
        payload_hex: c.payload,
        expected_hex: buildCoseSign1SigStructure(hexBuf(c.protected), hexBuf(c.payload)).toString(
          'hex'
        ),
      })),
      ...derCases.map((c) => ({
        name: c.name,
        kind: 'es384_to_der',
        raw_hex: c.raw,
        expected_hex: coseEs384SignatureToDer(hexBuf(c.raw))?.toString('hex') ?? null,
      })),
      {
        name: 'not a 96-byte signature',
        kind: 'es384_to_der',
        raw_hex: 'ff'.repeat(95),
        expected_hex: null,
      },
    ],
  };
}

// ── fulfillment digest / envelope families ───────────────────────────────────

const N3_HASH = 'a'.repeat(40);
const N3_HASH_UPPER = N3_HASH.toUpperCase();
const N3_MAGIC_TESTNET = 860833102;
const SIG_64 = 'b'.repeat(128);
const NULLIFIER = 'c'.repeat(64);

function digestFamily() {
  const base = {
    chain: 'neo_n3',
    appId: 'app:1',
    moduleId: 'oracle.fetch',
    operation: 'privacy_oracle',
  };
  const cases = [
    { name: 'n3 minimal', args: ['42', 'oracle/query', true, 'hello', '', '', base] },
    { name: 'n3 unicode result', args: ['42', 'oracle/query', true, '价格 π 🚀', '', '', base] },
    {
      name: 'n3 whitespace identifiers verbatim',
      args: [
        '42',
        'oracle/query',
        true,
        'r',
        '',
        '',
        { ...base, appId: ' app:1 ', moduleId: ' oracle.fetch ', operation: ' privacy_oracle ' },
      ],
    },
    { name: 'n3 numeric zero requestId', args: [0, 'oracle/query', true, 'r', '', '', base] },
    {
      name: 'n3 uint64-max requestId string',
      args: ['18446744073709551615', 'oracle/query', true, 'r', '', '', base],
    },
    {
      name: 'n3 resultBytesBase64 wins over result',
      args: ['7', 'oracle/query', true, 'ignored', '', hexBuf('deadbeef').toString('base64'), base],
    },
    {
      name: 'n3 empty resultBytesBase64 falls back',
      args: ['7', 'oracle/query', true, 'kept', '', '', base],
    },
    {
      name: 'n3 failure with error text',
      args: ['9', 'oracle/query', false, '', 'boom 💥', '', base],
    },
    {
      name: 'n3 empty identifiers',
      args: [
        '1',
        'oracle/query',
        true,
        'r',
        '',
        '',
        { ...base, appId: '', moduleId: '', operation: '' },
      ],
    },
    {
      name: 'n3 unicode identifiers',
      args: [
        '2',
        'oracle/query',
        true,
        'r',
        '',
        '',
        { ...base, appId: '应用', moduleId: '模块', operation: '操作' },
      ],
    },
    {
      name: 'n3 deployment bound',
      args: [
        '3',
        'oracle/query',
        true,
        'r',
        '',
        '',
        { ...base, contractScriptHash: N3_HASH, networkMagic: N3_MAGIC_TESTNET },
      ],
    },
    {
      name: 'n3 deployment bound upper hex',
      args: [
        '3',
        'oracle/query',
        true,
        'r',
        '',
        '',
        { ...base, contractScriptHash: N3_HASH_UPPER, networkMagic: N3_MAGIC_TESTNET },
      ],
    },
    {
      name: 'n3 deployment bound other magic',
      args: [
        '3',
        'oracle/query',
        true,
        'r',
        '',
        '',
        { ...base, contractScriptHash: N3_HASH, networkMagic: 1234567890 },
      ],
    },
    {
      name: 'n3 scripthash wrong length stays unbound',
      args: [
        '3',
        'oracle/query',
        true,
        'r',
        '',
        '',
        { ...base, contractScriptHash: 'a'.repeat(39), networkMagic: N3_MAGIC_TESTNET },
      ],
    },
    {
      name: 'n3 missing magic stays unbound',
      args: ['3', 'oracle/query', true, 'r', '', '', { ...base, contractScriptHash: N3_HASH }],
    },
    { name: 'n3 long result', args: ['4', 'oracle/query', true, 'r'.repeat(2048), '', '', base] },
    {
      name: 'legacy domain',
      args: ['42', 'oracle/query', true, 'hello', '', '', { chain: 'legacy' }],
    },
    {
      name: 'legacy with resultBytesBase64',
      args: [
        '5',
        'oracle/query',
        false,
        'x',
        'e',
        hexBuf('cafe').toString('base64'),
        { chain: 'legacy' },
      ],
    },
    {
      name: 'n3 bigint-ish numeric requestId stays string',
      args: [123456789012345678901234567890n, 'oracle/query', true, 'r', '', '', base],
    },
  ];
  return {
    family: 'fulfillment_digest',
    cases: cases.map(({ name, args }) => ({
      name,
      request_id: tag(args[0]),
      request_type: args[1],
      success: args[2],
      result: args[3],
      error: args[4],
      result_bytes_base64: args[5],
      options: args[6],
      digest_hex: buildFulfillmentDigestBytes(...args).toString('hex'),
    })),
  };
}

function envelopeFamily() {
  const responses = {
    plainOk: {
      ok: true,
      status: 200,
      body: {
        request_id: 'req:1',
        result: { price: '12.34', pair: 'NEO-USD', round_id: 7 },
        verification: {
          output_hash: 'a'.repeat(64),
          signature: `0x${SIG_64}`,
          public_key: 'pk-1',
          tee_attestation: {
            app_id: 'morpheus-oracle',
            instance_id: 'i-1',
            compose_hash: 'compose',
            report_data: 'report',
            quote: 'Q'.repeat(96),
            event_log: 'E'.repeat(48),
          },
        },
      },
    },
    errorWithBody: { ok: false, status: 502, body: { error: 'upstream exploded' } },
    errorNoBody: { ok: false, status: 500 },
    rng: { ok: true, status: 200, body: { randomness: 'ab'.repeat(32) } },
    rngNonHex: { ok: true, status: 200, body: { randomness: 'zz'.repeat(32) } },
    recoveryV1: {
      ok: true,
      status: 200,
      body: {
        callback_encoding: 'neo_n3_recovery_v1',
        new_owner: N3_HASH,
        recovery_nonce: 'n-1',
        expires_at: '2026-01-01T00:00:00Z',
        action_id: 'action-1',
        master_nullifier: NULLIFIER,
        action_nullifier: 'd'.repeat(64),
        signature: SIG_64,
      },
    },
    recoveryV3: {
      ok: true,
      status: 200,
      body: null, // filled in below — built from recoveryV1.body
    },
    actionV1: {
      ok: true,
      status: 200,
      body: {
        callback_encoding: 'neo_n3_action_v1',
        disposable_account: N3_HASH,
        action_id: 'action-2',
        action_nullifier: 'd'.repeat(64),
        signature: SIG_64,
      },
    },
    gameResult: {
      ok: true,
      status: 200,
      body: {
        callback_encoding: 'game_result_v1',
        result_bytes_base64: Buffer.concat([Buffer.from([0x02]), Buffer.alloc(78, 0x11)]).toString(
          'base64'
        ),
      },
    },
    gameResultWrongFirstByte: {
      ok: true,
      status: 200,
      body: {
        callback_encoding: 'game_result_v1',
        result_bytes_base64: Buffer.concat([Buffer.from([0x01]), Buffer.alloc(78, 0x11)]).toString(
          'base64'
        ),
      },
    },
    oversizedResult: {
      ok: true,
      status: 200,
      body: {
        request_id: 'req:big',
        result: {
          price: '12.34',
          pair: 'NEO-USD',
          round_id: 7,
          request_source: 'provider',
          target_chain_id: 12227330,
          sources: ['a', 'b', 'c'],
          extra: 'x'.repeat(400),
        },
      },
    },
  };
  responses.recoveryV3.body = {
    ...responses.recoveryV1.body,
    callback_encoding: 'neo_n3_recovery_v3',
  };
  responses.actionV3 = {
    ok: true,
    status: 200,
    body: { ...responses.actionV1.body, callback_encoding: 'neo_n3_action_v3' },
  };

  const lanes = [
    { name: 'plain ok', requestType: 'oracle/query', response: responses.plainOk },
    { name: 'error with body', requestType: 'oracle/query', response: responses.errorWithBody },
    { name: 'error without body', requestType: 'oracle/query', response: responses.errorNoBody },
    { name: 'rng compact bytes', requestType: 'rng', response: responses.rng },
    {
      name: 'rng non-hex falls back to envelope',
      requestType: 'rng',
      response: responses.rngNonHex,
    },
    {
      name: 'recovery ticket v1',
      requestType: 'neodid_recovery_ticket',
      response: responses.recoveryV1,
    },
    {
      name: 'recovery ticket v3',
      requestType: 'neodid_recovery_ticket',
      response: responses.recoveryV3,
    },
    { name: 'action ticket v1', requestType: 'neodid_action_ticket', response: responses.actionV1 },
    { name: 'action ticket v3', requestType: 'neodid_action_ticket', response: responses.actionV3 },
    { name: 'game result codec', requestType: 'game/finalize', response: responses.gameResult },
    {
      name: 'game result wrong first byte',
      requestType: 'game/finalize',
      response: responses.gameResultWrongFirstByte,
    },
    {
      name: 'oversized result trims',
      requestType: 'oracle/query',
      response: responses.oversizedResult,
    },
  ];

  return {
    family: 'fulfillment_envelope',
    cases: lanes.map(({ name, requestType, response }) => ({
      name,
      request_type: requestType,
      worker_response: response,
      encoded: encodeFulfillmentResult(requestType, response),
      envelope: buildOnchainResultEnvelope(requestType, response),
      envelope_with_trust_tier: buildOnchainResultEnvelope(
        requestType,
        response,
        'enclave-attested'
      ),
    })),
  };
}

function workerPayloadFamily() {
  const cases = [
    {
      name: 'oracle query',
      args: ['neo_n3', 'oracle/query', { url: 'https://example.com' }, '42', {}],
    },
    {
      name: 'target chain override and context',
      args: [
        'neo_n3',
        'neodid/action',
        { target_chain: 'neo_x', requester: 'req-on-chain' },
        '43',
        { requester: 'ctx-wins?', callbackContract: N3_HASH, callbackMethod: 'onCallback' },
      ],
    },
    {
      name: 'game finalize',
      args: ['neo_n3', 'session.finalize', { session_id: 's-1' }, '44', {}],
    },
  ];
  return {
    family: 'worker_payload',
    cases: cases.map(({ name, args }) => ({ name, args, payload: buildWorkerPayload(...args) })),
  };
}

function neoxFamily() {
  const config = {
    neox: { chainId: '12227330', oracleContract: '0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B' },
  };
  const digestCases = [
    {
      name: 'minimal',
      fulfillment: {
        requestId: '7',
        appId: 'app:1',
        moduleId: 'oracle.fetch',
        operation: 'privacy_oracle',
        success: true,
        error: '',
      },
      resultBytesHex: `0x${utf8('hello').toString('hex')}`,
    },
    {
      name: 'unicode identifiers',
      fulfillment: {
        requestId: '8',
        appId: '应用',
        moduleId: '模块',
        operation: '操作',
        success: true,
        error: '',
      },
      resultBytesHex: `0x${utf8('价格').toString('hex')}`,
    },
    {
      name: 'failure with error',
      fulfillment: {
        requestId: '9',
        appId: 'app:1',
        moduleId: 'oracle.fetch',
        operation: 'privacy_oracle',
        success: false,
        error: 'boom',
      },
      resultBytesHex: '0x',
    },
    {
      name: 'whitespace ids verbatim',
      fulfillment: {
        requestId: ' 10 ',
        appId: ' app ',
        moduleId: ' module ',
        operation: ' op ',
        success: true,
        error: '',
      },
      resultBytesHex: `0x${utf8('r').toString('hex')}`,
    },
    {
      name: '32-byte result',
      fulfillment: {
        requestId: '11',
        appId: 'app:1',
        moduleId: 'random.generate',
        operation: 'rng',
        success: true,
        error: '',
      },
      resultBytesHex: `0x${'ab'.repeat(32)}`,
    },
  ];
  const resolveCases = [
    {
      name: 'compact bytes win',
      result: 'ignored',
      resultBytesBase64: hexBuf('deadbeef').toString('base64'),
    },
    { name: 'utf8 fallback', result: 'kept', resultBytesBase64: '' },
    { name: 'both empty', result: '', resultBytesBase64: '' },
  ];
  return {
    family: 'neox_digest',
    cases: [
      ...digestCases.map(({ name, fulfillment, resultBytesHex }) => ({
        name,
        kind: 'digest',
        config,
        fulfillment,
        result_bytes_hex: resultBytesHex,
        expected: buildNeoXDigest(config, fulfillment, resultBytesHex),
      })),
      ...resolveCases.map(({ name, result, resultBytesBase64 }) => ({
        name,
        kind: 'resolve_result_bytes',
        result,
        result_bytes_base64: resultBytesBase64,
        expected: resolveResultBytesHex(result, resultBytesBase64),
      })),
    ],
  };
}

// ── retry backoff family ─────────────────────────────────────────────────────

function retryBackoffFamily() {
  const cases = [
    // [name, base, max, attempts, rng]
    ['attempt 1 rng 0', 1000, 8000, 1, 0],
    ['attempt 1 rng near 1', 1000, 8000, 1, 0.999999],
    ['doubling attempt 4', 1000, 8000, 4, 0.25],
    ['ceiling clamp attempt 12', 1000, 8000, 12, 0.5],
    ['base above max', 9000, 8000, 1, 0.5],
    ['attempt 0 floors the exponent', 1000, 8000, 0, 0.5],
    ['fractional attempts', 1000, 8000, 2.5, 0.5],
    ['defaults 5000/10000 attempt 3', 5000, 10000, 3, 0.75],
    ['half-jitter rounding boundary', 1001, 600000, 1, 0],
    ['max ceiling exact', 1000, 32, 5, 0],
    ['large base equals max', 600000, 600000, 1, 0.999],
    ['sub-second base', 250, 600000, 7, 0.125],
  ];
  return {
    family: 'retry_backoff',
    cases: cases.map(([name, base, max, attempts, rng]) => ({
      name,
      base_delay_ms: tag(base),
      max_delay_ms: tag(max),
      attempts: tag(attempts),
      rng: tag(rng),
      expected: tag(
        computeRetryDelayMs({ retryBaseDelayMs: base, retryMaxDelayMs: max }, attempts, () => rng)
      ),
    })),
  };
}

// ── secret redaction family ──────────────────────────────────────────────────

function secretRedactionFamily() {
  const wif = 'KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn';
  const hex64 = 'b'.repeat(64);
  const hex63 = 'c'.repeat(63);
  const redactCases = [
    ['bearer redacted', `Authorization: Bearer ${'a'.repeat(24)}`],
    ['bearer short credential kept', 'Bearer short'],
    ['basic scheme', `Authorization: Basic ${'ab'.repeat(16)}`],
    ['wif standalone', wif],
    ['wif in prose', `the key ${wif} leaked`],
    ['key context hex with 0x prefix', `token=0x${hex64}`],
    ['key context hex plain', `private_key: ${hex64}`],
    ['key context hex uppercase', `SECRET=${hex64.toUpperCase()}`],
    ['63 hex digits survive', `seed: ${hex63}`],
    ['bare 64 hex survives', hex64],
    ['two secrets in one line', `a=1 token=${hex64} Bearer ${'z'.repeat(20)} b=2`],
    ['prose untouched', 'plain text with no secrets at all'],
    ['bearer exactly 20 chars', `Bearer ${'q'.repeat(20)}`],
    ['bearer 19 chars kept', `Bearer ${'q'.repeat(19)}`],
  ];
  const nameCases = [
    ['NEO_N3_WIF', 'NEO_N3_WIF', true],
    ['MORPHEUS_N3_PRIVATE_KEY', 'MORPHEUS_N3_PRIVATE_KEY', true],
    ['camelCase privateKey', 'privateKey', true],
    ['compact privatekey', 'privatekey', true],
    ['FOO_API_KEY', 'FOO_API_KEY', true],
    ['service role key env', 'SUPABASE_SERVICE_ROLE_KEY', true],
    ['camel serviceRoleKey', 'serviceRoleKey', true],
    ['SIGNER_SERVICE_TOKEN', 'SIGNER_SERVICE_TOKEN', true],
    ['seed', 'seed', true],
    ['MNEMONIC', 'MNEMONIC', true],
    ['authorization', 'authorization', true],
    ['plain envelope', 'plain envelope', true],
    ['PASSWORD_FIELD', 'PASSWORD_FIELD', true],
    ['passphrase', 'passphrase', true],
    ['plaintext_value', 'plaintext_value', true],
    ['NEOX_UPDATER_PK is not name-secret', 'NEOX_UPDATER_PK', false],
    ['cert pem name', 'MORPHEUS_NITRO_ROOT_CERT_PEM', false],
    ['bare PK', 'PK', false],
    ['unrelated env', 'MORPHEUS_RELAYER_POLL_INTERVAL_MS', false],
    ['empty name', '', false],
  ];
  return {
    family: 'secret_redaction',
    cases: [
      ...redactCases.map(([name, input]) => ({
        name,
        kind: 'redact',
        input,
        expected: redactSecretValues(input),
      })),
      ...nameCases.map(([name, input]) => ({
        name,
        kind: 'is_secret_name',
        input,
        expected: isSecretName(input),
      })),
    ],
  };
}

// ── env alias / network-scoped family ────────────────────────────────────────

// Runs each case with an ISOLATED process.env so the exported vectors are
// reproducible on any machine (the relayer's host-signer scan walks every env
// key, so leaking the developer's real environment into a case would make the
// vectors machine-dependent and could even trip the host-key gates).
function withIsolatedEnv(caseEnv, runtimeConfig, run) {
  const savedEnv = process.env;
  try {
    process.env = { ...caseEnv };
    if (runtimeConfig === null) {
      delete process.env.MORPHEUS_RUNTIME_CONFIG_JSON;
    } else {
      process.env.MORPHEUS_RUNTIME_CONFIG_JSON = JSON.stringify(runtimeConfig);
    }
    return run();
  } finally {
    process.env = savedEnv;
  }
}

function envForNetworkFamily() {
  const cases = [];
  const runCase = (name, caseEnv, runtimeConfig, calls) => {
    const expected = withIsolatedEnv(caseEnv, runtimeConfig, () =>
      calls.map((call) =>
        call.kind === 'env'
          ? tag(env(...call.names))
          : tag(envNetworkScoped(call.network, call.generic_key))
      )
    );
    cases.push({
      name,
      process_env: caseEnv,
      runtime_config: runtimeConfig === null ? null : runtimeConfig,
      calls,
      expected,
    });
  };

  runCase('alias chain first set wins', { A_PRIMARY: 'p', A_SECONDARY: 's' }, null, [
    { kind: 'env', names: ['A_PRIMARY', 'A_SECONDARY'] },
    { kind: 'env', names: ['A_SECONDARY', 'A_PRIMARY'] },
    { kind: 'env', names: ['A_MISSING'] },
  ]);
  runCase(
    'runtime config fallback and coercion',
    {},
    { B: 'from-runtime', N: 42, Z: 0, E: '', NL: null, NEG: -3.5 },
    [
      { kind: 'env', names: ['B'] },
      { kind: 'env', names: ['N'] },
      { kind: 'env', names: ['Z'] },
      { kind: 'env', names: ['NEG'] },
      { kind: 'env', names: ['E'] },
      { kind: 'env', names: ['NL'] },
      { kind: 'env', names: ['MISSING_BOTH'] },
    ]
  );
  runCase('process env beats runtime config', { K: 'direct' }, { K: 'from-runtime' }, [
    { kind: 'env', names: ['K'] },
  ]);
  runCase(
    'whitespace trims and blank skips',
    { W: '  padded  ', BLANK: '   ' },
    { RW: '  rt-padded  ' },
    [
      { kind: 'env', names: ['W'] },
      { kind: 'env', names: ['BLANK', 'RW'] },
      { kind: 'env', names: ['BLANK'] },
    ]
  );
  runCase('network scoped testnet suffix wins', { MY_KEY_TESTNET: 'tn', MY_KEY: 'generic' }, null, [
    { kind: 'env_network_scoped', network: 'testnet', generic_key: 'MY_KEY' },
  ]);
  runCase('network scoped mainnet suffix wins', { MY_KEY_MAINNET: 'mn', MY_KEY: 'generic' }, null, [
    { kind: 'env_network_scoped', network: 'mainnet', generic_key: 'MY_KEY' },
  ]);
  runCase('network scoped falls back to generic', { ONLY_GENERIC: 'g' }, null, [
    { kind: 'env_network_scoped', network: 'testnet', generic_key: 'ONLY_GENERIC' },
  ]);
  runCase(
    'network scoped reads runtime config',
    {},
    { SCOPED_TESTNET: 'rt-tn', PLAIN_SCOPED: 'rt-plain' },
    [
      { kind: 'env_network_scoped', network: 'testnet', generic_key: 'SCOPED' },
      { kind: 'env_network_scoped', network: 'testnet', generic_key: 'PLAIN_SCOPED' },
    ]
  );
  runCase('non-mainnet network uses testnet suffix', { SUFFIXED_TESTNET: 't' }, null, [
    { kind: 'env_network_scoped', network: 'weird-network', generic_key: 'SUFFIXED' },
  ]);
  runCase('empty process value defers to runtime', { P2: '' }, { P2: 'rt-val' }, [
    { kind: 'env', names: ['P2'] },
  ]);
  return { family: 'env_for_network', cases };
}

// ── state machine family ─────────────────────────────────────────────────────

const STATE_T0 = Date.UTC(2026, 0, 15, 12, 0, 0); // fixed epoch: 2026-01-15T12:00:00Z

function stateEvent(overrides = {}) {
  return {
    chain: 'neo_n3',
    requestType: 'oracle/query',
    requestId: '41',
    txHash: '0xabc',
    logIndex: 3,
    blockNumber: 100,
    ...overrides,
  };
}

function statePruneFamily() {
  const cases = [];
  const run = (name, ops) => {
    const { returns, state } = withIsolatedEnv({}, null, () => {
      const freshState = createEmptyRelayerState();
      const opReturns = [];
      for (const op of ops) {
        switch (op.op) {
          case 'build_key':
            opReturns.push(tag(buildEventKey(op.event)));
            break;
          case 'enqueue_retry':
            opReturns.push(
              tag(enqueueRetryItem(freshState, op.chain, op.event, op.options || {}, op.now_ms))
            );
            break;
          case 'enforce_limit':
            opReturns.push(
              tag(enforceRetryQueueLimit(freshState, op.chain, op.limits || {}, op.now_ms))
            );
            break;
          case 'record_processed':
            opReturns.push(
              tag(
                recordProcessedEvent(
                  freshState,
                  op.chain,
                  op.event,
                  op.status,
                  op.meta || {},
                  op.limits || {},
                  op.now_ms
                )
              )
            );
            break;
          case 'schedule_retry':
            opReturns.push(
              tag(
                scheduleRetry(
                  freshState,
                  op.chain,
                  op.event,
                  op.error || 'boom',
                  op.config,
                  () => op.rng,
                  op.now_ms
                )
              )
            );
            break;
          case 'due_items':
            opReturns.push({
              __t: 'array',
              v: getDueRetryItems(freshState, op.chain, op.now_ms).map((item) => tag(item)),
            });
            break;
          case 'collect_active':
            opReturns.push({
              __t: 'array',
              v: [...collectActiveRequestIds(freshState, op.chain)].map((id) => tag(id)),
            });
            break;
          case 'increment_labeled':
            opReturns.push(
              tag(
                incrementLabeledFailure(
                  freshState,
                  op.chain,
                  op.module,
                  op.operation,
                  op.delta ?? 1
                )
              )
            );
            break;
          case 'snapshot':
            opReturns.push(tag(snapshotMetrics(freshState, op.now_ms)));
            break;
          default:
            throw new Error(`state_prune case ${name}: unknown op ${op.op}`);
        }
      }
      return { returns: opReturns, state: freshState };
    });
    cases.push({ name, ops, expected_returns: returns, expected_state: tag(state) });
  };

  run('empty state snapshot pins the metrics contract', [{ op: 'snapshot', now_ms: STATE_T0 }]);

  run('build event key mixed operators', [
    {
      op: 'build_key',
      event: stateEvent({ requestId: 0, txHash: '', logIndex: 0, blockNumber: 42 }),
    },
    { op: 'build_key', event: stateEvent({ requestId: '7', logIndex: null, blockNumber: null }) },
    { op: 'build_key', event: undefined },
  ]);

  run(
    'schedule retry backoff then exhaust',
    (() => {
      const config = {
        maxRetries: 2,
        retryBaseDelayMs: 1000,
        retryMaxDelayMs: 8000,
        retryQueueLimit: 0,
        deadLetterLimit: 500,
      };
      return [
        {
          op: 'schedule_retry',
          chain: 'neo_n3',
          event: stateEvent(),
          config,
          rng: 0.25,
          now_ms: STATE_T0,
        },
        {
          op: 'schedule_retry',
          chain: 'neo_n3',
          event: stateEvent(),
          config,
          rng: 0.25,
          now_ms: STATE_T0 + 1000,
        },
        {
          op: 'schedule_retry',
          chain: 'neo_n3',
          event: stateEvent(),
          config,
          rng: 0.25,
          now_ms: STATE_T0 + 2000,
        },
        { op: 'collect_active', chain: 'neo_n3' },
      ];
    })()
  );

  run(
    'retry queue limit sheds oldest into dead letters',
    (() => {
      const limits = { retryQueueLimit: 2, deadLetterLimit: 500 };
      return [
        {
          op: 'enqueue_retry',
          chain: 'neo_n3',
          event: stateEvent({ requestId: '1' }),
          options: { attempts: 1 },
          now_ms: STATE_T0,
        },
        {
          op: 'enqueue_retry',
          chain: 'neo_n3',
          event: stateEvent({ requestId: '2', requestType: 'rng' }),
          options: { attempts: 2, last_error: 'second' },
          now_ms: STATE_T0 + 10,
        },
        {
          op: 'enqueue_retry',
          chain: 'neox',
          event: { ...stateEvent({ requestId: '3' }), chain: 'neox' },
          options: {},
          now_ms: STATE_T0 + 20,
        },
        { op: 'enforce_limit', chain: 'neo_n3', limits, now_ms: STATE_T0 + 30 },
        { op: 'snapshot', now_ms: STATE_T0 + 30 },
      ];
    })()
  );

  run(
    'record processed clears retry and evicts lru',
    (() => {
      const limits = { processedCacheSize: 2, deadLetterLimit: 500 };
      return [
        {
          op: 'record_processed',
          chain: 'neo_n3',
          event: stateEvent({ requestId: '1' }),
          status: 'ok',
          meta: {},
          limits,
          now_ms: STATE_T0,
        },
        {
          op: 'record_processed',
          chain: 'neo_n3',
          event: stateEvent({ requestId: '2', requestType: 'rng' }),
          status: 'ok',
          meta: { price: '12.34' },
          limits,
          now_ms: STATE_T0 + 10,
        },
        {
          op: 'record_processed',
          chain: 'neo_n3',
          event: stateEvent({ requestId: '3' }),
          status: 'exhausted',
          meta: { note: 'gave up' },
          limits,
          now_ms: STATE_T0 + 20,
        },
        { op: 'snapshot', now_ms: STATE_T0 + 25 },
      ];
    })()
  );

  run(
    'due retry items filter by time',
    (() => {
      const config = {
        maxRetries: 5,
        retryBaseDelayMs: 1000,
        retryMaxDelayMs: 8000,
        retryQueueLimit: 0,
        deadLetterLimit: 500,
      };
      return [
        {
          op: 'schedule_retry',
          chain: 'neo_n3',
          event: stateEvent({ requestId: '1' }),
          config,
          rng: 0,
          now_ms: STATE_T0,
        },
        {
          op: 'schedule_retry',
          chain: 'neo_n3',
          event: stateEvent({ requestId: '2' }),
          config,
          rng: 0.999,
          now_ms: STATE_T0,
        },
        { op: 'due_items', chain: 'neo_n3', now_ms: STATE_T0 + 700 },
        { op: 'due_items', chain: 'neo_n3', now_ms: STATE_T0 + 100000 },
        { op: 'due_items', chain: 'neox', now_ms: STATE_T0 + 100000 },
      ];
    })()
  );

  run('labeled failures expand in snapshot', [
    {
      op: 'increment_labeled',
      chain: 'neo_n3',
      module: 'oracle.fetch',
      operation: 'privacy_oracle',
      delta: 2,
    },
    {
      op: 'increment_labeled',
      chain: 'neox',
      module: 'oracle.fetch',
      operation: 'privacy_oracle',
      delta: 1,
    },
    {
      op: 'increment_labeled',
      chain: 'neo_n3',
      module: 'rng.generate',
      operation: 'rng',
      delta: 1,
    },
    { op: 'snapshot', now_ms: STATE_T0 },
  ]);

  return { family: 'state_prune', cases };
}

// ── config resolution family ─────────────────────────────────────────────────

// The JS oracle reads its registry from disk; the Rust port takes it as an
// argument. Each case embeds the exact registry object the oracle loaded so
// both sides derive from identical inputs. repoRoot/stateFile/instanceId are
// machine-specific and stripped from the expected output (the Rust port
// leaves them to the caller shell).
function loadRegistryFor(network) {
  const registryPath = path.resolve(repoRoot, 'config', 'networks', `${network}.json`);
  try {
    return JSON.parse(readFileSync(registryPath, 'utf8'));
  } catch (error) {
    throw new Error(`cannot load reviewed network registry ${registryPath}: ${error.message}`);
  }
}

function configResolutionFamily() {
  const cases = [];
  const run = (name, caseEnv, runtimeConfig) => {
    const { expected, network, registry } = withIsolatedEnv(caseEnv, runtimeConfig, () => {
      const networkName = normalizeMorpheusNetwork(
        env('MORPHEUS_NETWORK', 'NEXT_PUBLIC_MORPHEUS_NETWORK') || 'testnet'
      );
      const caseRegistry = loadRegistryFor(networkName);
      let caseExpected;
      try {
        const config = createRelayerConfig();
        delete config.repoRoot;
        delete config.stateFile;
        delete config.instanceId;
        caseExpected = tag(config);
      } catch (caught) {
        caseExpected = { __t: 'error', v: caught.message };
      }
      return { expected: caseExpected, network: networkName, registry: caseRegistry };
    });
    cases.push({
      name,
      process_env: caseEnv,
      runtime_config: runtimeConfig === null ? null : runtimeConfig,
      network,
      registry,
      expected,
    });
  };

  run('defaults are testnet combined', {}, null);
  run('mainnet via MORPHEUS_NETWORK', { MORPHEUS_NETWORK: 'mainnet' }, null);
  run(
    'explicit overrides and aliases',
    {
      NEXT_PUBLIC_MORPHEUS_NETWORK: 'mainnet',
      MORPHEUS_RELAYER_MODE: 'oracle',
      NODE_ENV: 'production',
      MORPHEUS_RELAYER_MAX_RETRIES: '7',
      MORPHEUS_RELAYER_MAX_CALLBACK_RETRIES: '3',
      MORPHEUS_RELAYER_RETRY_BASE_DELAY_MS: '250',
      MORPHEUS_RELAYER_RETRY_MAX_DELAY_MS: '900000',
      MORPHEUS_RELAYER_CONCURRENCY: '2',
      MORPHEUS_RELAYER_MAX_BLOCKS_PER_TICK: '500',
      MORPHEUS_RELAYER_DEAD_LETTER_LIMIT: '50',
      MORPHEUS_RELAYER_PROCESSED_CACHE_SIZE: '100',
      MORPHEUS_RELAYER_NEO_N3_START_REQUEST_ID: '42',
      MORPHEUS_RELAYER_NEOX_START_BLOCK: '12345',
      MORPHEUS_RELAYER_LOG_LEVEL: 'debug',
      LOG_FORMAT: 'pretty',
      MORPHEUS_FEED_SYNC_ENABLED: 'false',
      MORPHEUS_AUTOMATION_ENABLED: 'false',
      MORPHEUS_RELAYER_ENCLAVE_FULFILL: 'true',
      SIGNER_SERVICE_URL: 'https://custody.internal',
      MORPHEUS_EXPECTED_PCR0: 'a'.repeat(64),
    },
    null
  );
  run(
    'runtime config supplies values',
    {},
    {
      MORPHEUS_RELAYER_MAX_RETRIES: 9,
      MORPHEUS_RELAYER_POLL_INTERVAL_MS: '1500',
      MORPHEUS_RELAYER_RETRY_BASE_DELAY_MS: 250,
      SUPABASE_URL: 'https://supabase.example',
      SUPABASE_SERVICE_ROLE_KEY: 'service-role',
      MORPHEUS_DURABLE_QUEUE_ENABLED: 'false',
      MORPHEUS_RELAYER_ALLOW_RUNTIME_FALLBACKS: 'false',
      MORPHEUS_RELAYER_NEO_N3_START_REQUEST_ID: 'abc',
    }
  );
  run(
    'process env beats runtime config',
    { MORPHEUS_RELAYER_MAX_RETRIES: '3' },
    {
      MORPHEUS_RELAYER_MAX_RETRIES: 9,
      MORPHEUS_RELAYER_CONCURRENCY: 8,
    }
  );
  run('production flips the fail-closed defaults', { NODE_ENV: 'production' }, null);
  run(
    'gate: neo n3 host signing key configured',
    { MORPHEUS_RELAYER_NEO_N3_PRIVATE_KEY: 'ff'.repeat(32) },
    null
  );
  run(
    'gate: production neox host signing key',
    { NODE_ENV: 'production', MORPHEUS_RELAYER_NEOX_UPDATER_PK: '02ab' },
    null
  );
  run(
    'gate: development neox host key without opt-in',
    { NODE_ENV: 'development', MORPHEUS_RELAYER_NEOX_UPDATER_PK: '02ab' },
    null
  );
  run(
    'development neox host key with explicit opt-in',
    {
      NODE_ENV: 'development',
      MORPHEUS_RELAYER_NEOX_UPDATER_PK: '02ab',
      MORPHEUS_ALLOW_INSECURE_HOST_EVM_SIGNER: 'true',
    },
    null
  );
  run(
    'gate: neox active chain in production',
    { NODE_ENV: 'production', MORPHEUS_ACTIVE_CHAINS: 'neo_n3,neox' },
    null
  );
  run(
    'active chains filter keeps supported only',
    { NODE_ENV: 'development', MORPHEUS_ACTIVE_CHAINS: 'Neo_N3, bogus, neox' },
    null
  );

  return { family: 'config_resolution', cases };
}

// Golden vectors for the Rust n3_tx extensions (crates/neo-os-core/src/n3_tx.rs),
// harvested from the repo's own neon-js with the fixtures the fulfillment /
// automation / fee-top-up lanes drive. Pins: HexBytes (verbatim) and Hash160
// (reversed) parameter encodings, PUSHF/PUSHNULL, PUSHDATA2 for >255-byte
// payloads, witness framing in serialize(true), the display transaction hash,
// and script-hash derivation from a public key / a base58check address.
// Emitted flat (no `cases` wrapper) because the Rust fixture reads top-level
// fields; consumers tolerate the extra `family` key (serde_json::Value .get()).
function n3ExtensionFamily() {
  const out = {};

  // fulfillRequest-shaped script: the exact args buildFulfillRequestParams
  // builds (integer, boolean, byteArray LE-hex, string, byteArray LE-hex).
  const fulfillArgs = [
    sc.ContractParam.integer('12345'),
    sc.ContractParam.boolean(true),
    sc.ContractParam.byteArray(u.HexString.fromHex('aabbccdd', true)),
    sc.ContractParam.string(''),
    sc.ContractParam.byteArray(
      u.HexString.fromHex(
        '0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f3031',
        true
      )
    ),
  ];
  const oracleHash = '0x' + 'ab'.repeat(20);
  out.fulfill_script_hex = sc.createScript({
    scriptHash: oracleHash,
    operation: 'fulfillRequest',
    args: fulfillArgs,
  });

  // queueAutomationRequest shape (hash160 + string + byteArray + hash160 + string).
  const queueArgs = [
    sc.ContractParam.hash160('NbrXdur6FV9bx33ME1jxjoKyQMBLZCWtDL'),
    sc.ContractParam.string('oracle.fetch'),
    sc.ContractParam.byteArray(Buffer.from('{"k":1}', 'utf8').toString('base64')),
    sc.ContractParam.hash160('0x' + 'cd'.repeat(20)),
    sc.ContractParam.string('onMiniAppResult'),
  ];
  out.queue_script_hex = sc.createScript({
    scriptHash: oracleHash,
    operation: 'queueAutomationRequest',
    args: queueArgs,
  });

  // Hash160 emission, isolated: from an address (base58check) and from an
  // ASYMMETRIC 0x-hex (palindromes cannot pin the reversal direction).
  out.hash160_from_address_hex = sc.createScript({
    scriptHash: '0x' + 'ab'.repeat(20),
    operation: 'x',
    args: [sc.ContractParam.hash160('NbrXdur6FV9bx33ME1jxjoKyQMBLZCWtDL')],
  });
  out.hash160_from_0xhex_hex = sc.createScript({
    scriptHash: '0x' + 'ab'.repeat(20),
    operation: 'x',
    args: [sc.ContractParam.hash160('0x0102030405060708090a0b0c0d0e0f1011121314')],
  });

  // boolean false / null (Any) emission, isolated.
  out.bool_false_and_null_hex = sc.createScript({
    scriptHash: '0x' + 'ab'.repeat(20),
    operation: 'x',
    args: [sc.ContractParam.boolean(false), sc.ContractParam.any(null)],
  });

  // PUSHDATA2: a >255-byte string argument.
  out.pushdata2_hex = sc.createScript({
    scriptHash: '0x' + 'ab'.repeat(20),
    operation: 'x',
    args: [sc.ContractParam.string('A'.repeat(300))],
  });

  // Transaction: serialize(false), serialize(true), hash(), and the signing
  // message for a fixed fixture with a witness attached.
  const signerAccount = '5c2047b1c6b4b6e4b3a1c9d5e7f0a2b4c6d8e0f1';
  const magic = 860833102;
  const feedScriptHex = sc.createScript({
    scriptHash: 'ab'.repeat(20),
    operation: 'fulfillRequest',
    args: fulfillArgs,
  });
  const transaction = new tx.Transaction({
    version: 0,
    nonce: 305419896, // 0x12345678
    script: u.HexString.fromHex(feedScriptHex),
    validUntilBlock: 1000,
    signers: [{ account: signerAccount, scopes: tx.WitnessScope.CalledByEntry }],
    attributes: [],
    witnesses: [],
  });
  out.tx_unsigned_hex = transaction.serialize(false);
  out.tx_message_for_signing_hex = transaction.getMessageForSigning(magic);

  const invocation = '40' + 'de'.repeat(64);
  const verification =
    '0c210315b41fcf6671b6400237730bc8a261dcb64e25cc17de9878576c78eace1c91464156e7b327';
  transaction.witnesses = [
    new tx.Witness({
      invocationScript: u.HexString.fromHex(invocation),
      verificationScript: u.HexString.fromHex(verification),
    }),
  ];
  out.witness_invocation_hex = invocation;
  out.witness_verification_hex = verification;
  out.tx_signed_hex = transaction.serialize(true);
  out.tx_hash_hex = `0x${transaction.hash()}`;

  // script-hash derivation: from public key and from an address.
  const publicKey = '0315b41fcf6671b6400237730bc8a261dcb64e25cc17de9878576c78eace1c9146';
  out.verification_script_hex = `0c21${publicKey}4156e7b327`;
  out.script_hash_from_public_key = wallet.getScriptHashFromPublicKey(publicKey);
  out.script_hash_from_address = wallet.getScriptHashFromAddress(
    'NeFG5A79AJovUz4BStpnmFyQChLvQkuW72'
  );
  out.address_from_script_hash = wallet.getAddressFromScriptHash(
    '3124a38a74f447b120b551db00f513ec674318c9'
  );

  // GAS transfer script (fee top-up lane): hash160 x2 + integer + any(null).
  out.gas_transfer_script_hex = sc.createScript({
    scriptHash: 'd2a4cff31913016155e38e474a2c06d08be276cf',
    operation: 'transfer',
    args: [
      sc.ContractParam.hash160(`0x${signerAccount}`),
      sc.ContractParam.hash160('0x' + 'ef'.repeat(20)),
      sc.ContractParam.integer('100000000'),
      sc.ContractParam.any(null),
    ],
  });

  return { family: 'n3_extension', ...out };
}

// ── driver ───────────────────────────────────────────────────────────────────

const FAMILIES = [
  stableStringifyFamily,
  collationFamily,
  cborFamily,
  coseFamily,
  digestFamily,
  envelopeFamily,
  workerPayloadFamily,
  neoxFamily,
  retryBackoffFamily,
  secretRedactionFamily,
  envForNetworkFamily,
  statePruneFamily,
  configResolutionFamily,
  n3ExtensionFamily,
];

function render(family) {
  return `${JSON.stringify(family, null, 2)}\n`;
}

function buildAll() {
  return FAMILIES.map((build) => {
    const family = build();
    return { filename: `${family.family}.json`, contents: render(family) };
  });
}

const check = process.argv.includes('--check');
if (check) {
  let drift = 0;
  for (const { filename, contents } of buildAll()) {
    const existingPath = path.join(vectorsDir, filename);
    let existing;
    try {
      existing = readFileSync(existingPath, 'utf8');
    } catch {
      console.error(`MISSING: ${filename}`);
      drift += 1;
      continue;
    }
    if (existing !== contents) {
      console.error(`DRIFT: ${filename} no longer matches the JS oracle`);
      drift += 1;
    }
  }
  if (drift > 0) {
    console.error(
      `\n${drift} vector file(s) drifted. Re-run: node scripts/export-rust-vectors.mjs`
    );
    process.exit(1);
  }
  console.log('all vector files match the JS oracle');
} else {
  mkdirSync(vectorsDir, { recursive: true });
  for (const { filename, contents } of buildAll()) {
    writeFileSync(path.join(vectorsDir, filename), contents);
    console.log(`wrote ${filename}`);
  }
}
