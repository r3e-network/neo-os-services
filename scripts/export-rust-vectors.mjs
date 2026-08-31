/**
 * Export golden vectors from the Node implementations into
 * crates/morpheus-core/tests/vectors/ so the Rust ports are verified against
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

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vectorsDir = path.join(repoRoot, 'crates', 'morpheus-core', 'tests', 'vectors');

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
  const err = (name, bytes, error) => {
    const hex = bytes.toString('hex');
    try {
      cborRead(bytes, 0);
    } catch (caught) {
      return { name, hex, error: caught.message };
    }
    throw new Error(`cbor case ${name} was expected to fail`);
  };
  const errCose = (name, bytes, error) => {
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
