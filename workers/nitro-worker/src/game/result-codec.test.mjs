// RESULT CODEC golden vector — the fixed 79-byte finalize result the contract
// parses by offset and the kernel hashes SHA256(result). This vector is the
// cross-pin the contract team and the relayer digest test must reproduce
// byte-for-byte (fixed inputs -> fixed 79-byte hex -> fixed SHA256). Any change
// to the codec breaks these constants intentionally.
//
// Layout (big-endian, NOT StdLib.Serialize):
//   byte[0]        = 0x02                       // finalize tag
//   bytes[1..33]   = commitment (32)
//   bytes[33..65]  = answerHash (32)
//   bytes[65..73]  = elapsedMs  (uint64 BE, 8)
//   byte[73]       = undos      (uint8)
//   bytes[74..78]  = score      (uint32 BE, 4)
//   byte[78]       = difficulty (uint8)
//   total 79 bytes
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildResultBytes, RESULT_BYTES_LENGTH, RESULT_FINALIZE_TAG } from './session.js';

// ── Golden vector (cross-pinned with the contract + relayer) ─────────────────
const GOLDEN_INPUTS = {
  commitment: Buffer.alloc(32, 0xab),
  answerHash: Buffer.alloc(32, 0xcd),
  elapsedMs: 123456, // 0x1E240
  undos: 2,
  score: 20, // 0x14
  difficulty: 1,
};

const GOLDEN_HEX =
  '02' +
  'ab'.repeat(32) +
  'cd'.repeat(32) +
  '000000000001e240' + // elapsedMs uint64 BE
  '02' + // undos
  '00000014' + // score uint32 BE
  '01'; // difficulty

const GOLDEN_SHA256 = 'f8ddd711f6ece1740fd322f71e9cc7407e6820656227bb8c4d0716e7970c2488';

test('RESULT CODEC: the golden vector encodes to the pinned 79-byte hex', () => {
  const bytes = buildResultBytes(GOLDEN_INPUTS);
  assert.equal(bytes.length, RESULT_BYTES_LENGTH);
  assert.equal(bytes.length, 79);
  assert.equal(bytes.toString('hex'), GOLDEN_HEX);
  assert.equal(bytes[0], RESULT_FINALIZE_TAG);
  assert.equal(bytes[0], 0x02);
});

test('RESULT CODEC: SHA256(result) matches the pinned kernel-digest input', () => {
  const bytes = buildResultBytes(GOLDEN_INPUTS);
  const sha = createHash('sha256').update(bytes).digest('hex');
  assert.equal(sha, GOLDEN_SHA256);
});

test('RESULT CODEC: field offsets round-trip (contract parses by offset)', () => {
  const bytes = buildResultBytes(GOLDEN_INPUTS);
  assert.equal(bytes[0], 0x02, 'tag');
  assert.equal(bytes.slice(1, 33).toString('hex'), 'ab'.repeat(32), 'commitment');
  assert.equal(bytes.slice(33, 65).toString('hex'), 'cd'.repeat(32), 'answerHash');
  assert.equal(Number(bytes.readBigUInt64BE(65)), 123456, 'elapsedMs');
  assert.equal(bytes[73], 2, 'undos');
  assert.equal(bytes.readUInt32BE(74), 20, 'score');
  assert.equal(bytes[78], 1, 'difficulty');
});

test('RESULT CODEC: accepts hex-string commitment/answerHash inputs identically', () => {
  const fromHex = buildResultBytes({
    ...GOLDEN_INPUTS,
    commitment: 'ab'.repeat(32),
    answerHash: 'cd'.repeat(32),
  });
  assert.equal(fromHex.toString('hex'), GOLDEN_HEX);
});

test('RESULT CODEC: boundary values (max uint64 elapsed, max uint32 score) encode', () => {
  const bytes = buildResultBytes({
    commitment: Buffer.alloc(32, 0),
    answerHash: Buffer.alloc(32, 0),
    elapsedMs: Number.MAX_SAFE_INTEGER,
    undos: 3,
    score: 0xffffffff,
    difficulty: 2,
  });
  assert.equal(bytes.length, 79);
  assert.equal(bytes.readUInt32BE(74), 0xffffffff);
  assert.equal(Number(bytes.readBigUInt64BE(65)), Number.MAX_SAFE_INTEGER);
});

test('RESULT CODEC: rejects malformed field sizes / ranges', () => {
  const base = { ...GOLDEN_INPUTS };
  assert.throws(() => buildResultBytes({ ...base, commitment: Buffer.alloc(31) }), /commitment/);
  assert.throws(() => buildResultBytes({ ...base, answerHash: Buffer.alloc(33) }), /answerHash/);
  assert.throws(() => buildResultBytes({ ...base, score: 0x1_0000_0000 }), /score/);
  assert.throws(() => buildResultBytes({ ...base, undos: 256 }), /undos/);
  assert.throws(() => buildResultBytes({ ...base, difficulty: 256 }), /difficulty/);
});
