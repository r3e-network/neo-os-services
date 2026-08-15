import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto';
import { cborRead, decodeCoseSign1, decodeCoseSign1Payload } from './cbor.js';
import { buildCoseSign1SigStructure } from './cose-verify.js';

const B = (...bytes) => Buffer.from(bytes);
const decode = (buf) => cborRead(buf, 0).value;

// ── definite vs indefinite must decode identically (the core fix) ────────────
// Before this shared codec, the relayer threw "unsupported minor 31" on the
// indefinite forms and the enclave decoded them to empty containers.

test('definite and indefinite maps decode identically', () => {
  const definite = B(0xa1, 0x61, 0x61, 0x01); // {a: 1}
  const indefinite = B(0xbf, 0x61, 0x61, 0x01, 0xff); // {_ a: 1 } (0xbf .. 0xff)
  assert.deepEqual(decode(definite), { a: 1 });
  assert.deepEqual(decode(indefinite), { a: 1 });
  assert.deepEqual(decode(indefinite), decode(definite));
});

test('definite and indefinite arrays decode identically', () => {
  const definite = B(0x83, 0x01, 0x02, 0x03); // [1,2,3]
  const indefinite = B(0x9f, 0x01, 0x02, 0x03, 0xff); // [_ 1,2,3]
  assert.deepEqual(decode(definite), [1, 2, 3]);
  assert.deepEqual(decode(indefinite), [1, 2, 3]);
});

test('definite and indefinite byte strings decode identically (chunks concatenated)', () => {
  const definite = B(0x45, 0x01, 0x02, 0x03, 0x04, 0x05); // h'0102030405'
  // indefinite: two chunks h'0102' + h'030405'
  const indefinite = B(0x5f, 0x42, 0x01, 0x02, 0x43, 0x03, 0x04, 0x05, 0xff);
  assert.deepEqual(decode(definite), B(0x01, 0x02, 0x03, 0x04, 0x05));
  assert.deepEqual(decode(indefinite), B(0x01, 0x02, 0x03, 0x04, 0x05));
});

test('indefinite text string concatenates chunks', () => {
  // (_ "ab", "c") => "abc"
  const indefinite = B(0x7f, 0x62, 0x61, 0x62, 0x61, 0x63, 0xff);
  assert.equal(decode(indefinite), 'abc');
});

// ── COSE_Sign1 decoding ──────────────────────────────────────────────────────

test('decodeCoseSign1 extracts the four elements and the raw payload bytes', () => {
  // [ h'' (protected), {} (unprotected), h'A1616101' (payload = {a:1}), h'' (sig) ]
  const cose = B(0x84, 0x40, 0xa0, 0x44, 0xa1, 0x61, 0x61, 0x01, 0x40);
  const decoded = decodeCoseSign1(cose);
  assert.deepEqual(decoded.protectedHeaderBytes, Buffer.alloc(0));
  // The raw payload byte string must be preserved exactly — ES384 verification
  // recomputes the Sig_structure over these bytes, so they cannot be re-encoded.
  assert.deepEqual(decoded.payloadBytes, B(0xa1, 0x61, 0x61, 0x01));
  assert.deepEqual(decoded.payload, { a: 1 });
  assert.deepEqual(decoded.signature, Buffer.alloc(0));
});

test('decodeCoseSign1Payload returns the same map decodeCoseSign1 does', () => {
  const cose = B(0x84, 0x40, 0xa0, 0x44, 0xa1, 0x61, 0x61, 0x01, 0x40);
  assert.deepEqual(decodeCoseSign1Payload(cose), { a: 1 });
});

test('COSE_Sign1 with an INDEFINITE-length payload map decodes correctly (the bug)', () => {
  // payload bstr wraps an indefinite map {_ a:1}: 0xBF 61 61 01 0xFF (5 bytes).
  // Previously: relayer threw on 0xBF; enclave produced {}. Now both read {a:1}.
  const cose = B(0x84, 0x40, 0xa0, 0x45, 0xbf, 0x61, 0x61, 0x01, 0xff, 0x40);
  assert.deepEqual(decodeCoseSign1Payload(cose), { a: 1 });
});

test('attestation-shaped payload with indefinite pcrs map and byte fields', () => {
  // payload = { "pcrs": {_ 0: h'BB' }, "x": h'AA' }
  // "pcrs" = 0x64 70 63 72 73 ; indefinite map 0xBF 00 41 BB 0xFF ; "x"=0x61 78 ; h'AA'=0x41 AA
  const payloadInner = B(
    0xa2,
    0x64,
    0x70,
    0x63,
    0x72,
    0x73, // "pcrs"
    0xbf,
    0x00,
    0x41,
    0xbb,
    0xff, // {_ 0: h'BB' }
    0x61,
    0x78, // "x"
    0x41,
    0xaa // h'AA'
  );
  const cose = Buffer.concat([
    B(0x84, 0x40, 0xa0),
    B(0x40 | payloadInner.length),
    payloadInner,
    B(0x40),
  ]);
  const payload = decodeCoseSign1Payload(cose);
  assert.deepEqual(payload.pcrs, { 0: B(0xbb) });
  assert.deepEqual(payload.x, B(0xaa));
});

// ── structural guards preserved ──────────────────────────────────────────────

test('rejects a non-4-element COSE_Sign1', () => {
  assert.throws(() => decodeCoseSign1(B(0x83, 0x40, 0xa0, 0x40)), /4-element COSE_Sign1/);
});

test('rejects a payload that is not a byte string', () => {
  // [ h'', {}, 1, h'' ] — payload is uint, not bstr
  assert.throws(() => decodeCoseSign1(B(0x84, 0x40, 0xa0, 0x01, 0x40)), /not a byte string/);
});

test('still rejects truly reserved minors (28-30) rather than silently accepting', () => {
  assert.throws(() => decode(B(0x1c)), /unsupported minor 28/);
});

test('round-trips uints across the 1/2/4-byte length encodings', () => {
  assert.equal(decode(B(0x18, 0x64)), 100); // uint8 100
  assert.equal(decode(B(0x19, 0x01, 0x00)), 256); // uint16 256
  assert.equal(decode(B(0x1a, 0x00, 0x01, 0x00, 0x00)), 65536); // uint32 65536
});

test('rejects oversized declared strings before allocation or slicing', () => {
  assert.throws(() => decode(B(0x5a, 0x7f, 0xff, 0xff, 0xff)), /string length exceeds limit/);
});

test('rejects excessive nesting and collection counts', () => {
  const nested = Buffer.concat([Buffer.alloc(34, 0x81), B(0x00)]);
  assert.throws(() => decode(nested), /nesting depth exceeds limit/);
  assert.throws(() => decode(B(0x9a, 0x00, 0x00, 0x20, 0x00)), /array length exceeds limit/);
});

// ── end-to-end ES384 signature verification (closes the raw-bytes → verify loop) ──
// The structural tests above prove decodeCoseSign1 preserves the raw payload/protected
// bytes. This test closes the remaining gap: it signs a REAL COSE_Sign1 with a P-384
// key, decodes it via the shared codec, rebuilds the Sig_structure with the REAL
// production encoder (buildCoseSign1SigStructure from shared/cose-verify — the same one
// the relayer submits on-chain with), and asserts Node's crypto.verify returns true. If
// decodeCoseSign1 ever re-serialized/truncated the bytes, OR the encoder's length-class
// thresholds drifted, this signature would stop verifying. This pins the exact property
// the ES384 verification path depends on — by construction, not by a mirror.

// Minimal CBOR encoder for the COSE_Sign1 wrapper [protected(bstr), unprotected(map),
// payload(bstr), signature(bstr)] and the protected-header map {1:-35, 2:"ES384" etc}.
function encHead(major, len) {
  if (len < 24) return Buffer.from([(major << 5) | len]);
  if (len < 256) return Buffer.from([(major << 5) | 24, len]);
  if (len < 65536) return Buffer.from([(major << 5) | 25, (len >> 8) & 0xff, len & 0xff]);
  const b = Buffer.alloc(5);
  b[0] = (major << 5) | 26;
  b.writeUInt32BE(len, 1);
  return b;
}
// Encode a CBOR byte string (major 2) — used for protected header, payload, signature.
const encBstr = (b) => Buffer.concat([encHead(2, b.length), b]);
// Encode a CBOR text string (major 3) — used for map keys like "user_data".
const encText = (s) => {
  const b = Buffer.from(s, 'utf8');
  return Buffer.concat([encHead(3, b.length), b]);
};
// Encode a CBOR map from already-encoded key/value items.
const encMap = (pairs) => Buffer.concat([Buffer.from([0xa0 | pairs.length]), ...pairs.flat()]);

test('a real ES384-signed COSE_Sign1 verifies through decodeCoseSign1 raw bytes', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'P-384',
  });

  // Protected header (alg ES384 = -35, per RFC 8152). This is the byte string the
  // decoder must return VERBATIM so the verifier can put it back into the Sig_structure.
  // {1: -35}  →  0xa1 (map1) 01 (uint1) 38 24 (negint, -1-36 = -35)
  const protectedHeaderMap = encMap([[Buffer.from([0x01]), Buffer.from([0x38, 0x24])]]);
  const unprotectedMap = Buffer.from([0xa0]); // {}

  // Two attestation-shaped payloads with the SAME logical content but different CBOR
  // encodings, to prove BOTH decode paths feed verifying bytes. The indefinite form is
  // exactly the producer/verifier-disagreement case PR #10 unified.
  const userData = encBstr(B(0xde, 0xad, 0xbe, 0xef)); // h'deadbeef' as a CBOR bstr
  const pcrValue = encBstr(B(0xaa)); // h'aa' as a CBOR bstr
  // definite pcrs map {0: h'aa'}  →  0xa1 00 41 aa
  const pcrsDefinite = encMap([[Buffer.from([0x00]), pcrValue]]);
  // indefinite pcrs map {_ 0: h'aa'}  →  0xbf 00 41 aa 0xff
  const pcrsIndefinite = Buffer.concat([
    Buffer.from([0xbf]),
    Buffer.from([0x00]),
    pcrValue,
    Buffer.from([0xff]),
  ]);

  const payloadDefinite = encMap([
    [encText('user_data'), userData],
    [encText('pcrs'), pcrsDefinite],
  ]);
  const payloadIndefinite = encMap([
    [encText('user_data'), userData],
    [encText('pcrs'), pcrsIndefinite],
  ]);

  // Sig_structure = ["Signature1", body_protected(bstr), external_aad(bstr""), payload(bstr)]
  for (const { name, payloadBytes } of [
    { name: 'definite-length payload', payloadBytes: payloadDefinite },
    { name: 'indefinite-length payload (PR #10 fix)', payloadBytes: payloadIndefinite },
  ]) {
    const sigStructure = buildCoseSign1SigStructure(protectedHeaderMap, payloadBytes);
    const der = cryptoSign('sha384', sigStructure, { key: privateKey, dsaEncoding: 'der' });

    // Wrap into a COSE_Sign1 [protected, unprotected, payload, signature].
    const cose = Buffer.concat([
      Buffer.from([0x84]), // array(4)
      encBstr(protectedHeaderMap),
      unprotectedMap,
      encBstr(payloadBytes),
      encBstr(der), // any 96-byte r||s works for verify; reuse der for simplicity
    ]);

    // Decode via the shared codec — this is the function under test.
    const decoded = decodeCoseSign1(cose);

    // Reconstruct the Sig_structure from the decoder's RAW output (not from re-encoded
    // bytes) via the REAL production encoder (shared/cose-verify), and assert the
    // signature verifies. Because this uses the actual encoder the relayer submits with,
    // a drift in the encoder's length-class thresholds or field order would fail this
    // test — the byte-exactness property is now pinned by construction, not by a mirror.
    const rebuilt = buildCoseSign1SigStructure(decoded.protectedHeaderBytes, decoded.payloadBytes);
    assert.deepEqual(rebuilt, sigStructure, `${name}: rebuilt Sig_structure must match`);
    assert.deepEqual(
      decoded.protectedHeaderBytes,
      protectedHeaderMap,
      `${name}: protected bytes verbatim`
    );
    assert.deepEqual(decoded.payloadBytes, payloadBytes, `${name}: payload bytes verbatim`);

    const okDer = cryptoVerify('sha384', rebuilt, { key: publicKey, dsaEncoding: 'der' }, der);
    assert.ok(okDer, `${name}: ES384 signature must verify over the decoder's raw bytes`);
  }
});
