// COSE_Sign1 Sig_structure encoder + ES384 raw(r||s) → DER converter.
//
// This is the single source for the ENCODE/VERIFY side of COSE_Sign1, mirroring
// how @r3e-network/neo-os-services-shared/cbor is the single source for the DECODE side.
// Previously the encoder lived verifier-only in workers/morpheus-relayer/src/attestation.js,
// a second copy existed in apps/web/lib/nitro-attestation.ts, and a THIRD copy was
// re-inlined in the shared cbor test ("mirrors ... so the test reconstructs the SAME
// bytes"). Three copies can drift silently — that is the risk this module removes.
//
// The functions are byte-exact copies of the relayer originals (the only copy that
// was ever exercised against real AWS Nitro attestation documents on the submit
// path). Do NOT "canonicalize" the length-class thresholds here without regenerating
// the verify-passing ES384 fixture in cbor.test.mjs — those bytes are signature-load-bearing.

/**
 * Minimal deterministic CBOR encoder for a Sig_structure array (RFC 8152 §4.4):
 * a fixed-length array of text strings + byte strings. Self-contained so no CBOR
 * library is bundled. Only the majors needed by Sig_structure are supported
 * (array=4, byte string=2, text string=3); lengths up to 32-bit (0x1a).
 *
 * @param {Array<string|Buffer|Uint8Array>} items
 * @returns {Buffer}
 */
export function cborEncodeSigStructure(items) {
  const head = (major, len) => {
    if (len < 24) return Buffer.from([(major << 5) | len]);
    if (len < 256) return Buffer.from([(major << 5) | 24, len]);
    if (len < 65536) return Buffer.from([(major << 5) | 25, (len >> 8) & 0xff, len & 0xff]);
    const b = Buffer.alloc(5);
    b[0] = (major << 5) | 26;
    b.writeUInt32BE(len, 1);
    return b;
  };
  const parts = [head(4, items.length)];
  for (const item of items) {
    if (typeof item === 'string') {
      const b = Buffer.from(item, 'utf8');
      parts.push(head(3, b.length), b);
    } else {
      const b = Buffer.isBuffer(item) ? item : Buffer.from(item || []);
      parts.push(head(2, b.length), b);
    }
  }
  return Buffer.concat(parts);
}

/**
 * Build the COSE Sig_structure for a COSE_Sign1 (RFC 8152 §4.4):
 *   Sig_structure = [ "Signature1", body_protected(bstr), external_aad(bstr ""), payload(bstr) ]
 * This is the exact byte string the enclave's ES384 signature is computed over.
 *
 * @param {Buffer} protectedHeaderBytes — raw protected-header bstr (as returned by
 *   decodeCoseSign1's `protectedHeaderBytes`); must be the ORIGINAL wire bytes, never
 *   re-serialized, or the signature will not verify.
 * @param {Buffer} payloadBytes — raw payload bstr (as returned by `payloadBytes`).
 * @returns {Buffer}
 */
export function buildCoseSign1SigStructure(protectedHeaderBytes, payloadBytes) {
  return cborEncodeSigStructure([
    'Signature1',
    protectedHeaderBytes,
    Buffer.alloc(0),
    payloadBytes,
  ]);
}

/**
 * Convert a 96-byte COSE raw (r||s) ES384 signature into the DER-encoded ECDSA
 * signature Node's crypto.verify expects (with dsaEncoding:'der'). Returns null if
 * the input is not a 96-byte raw signature (e.g. a placeholder), so the caller can
 * treat it as unverifiable rather than throwing.
 *
 * DER for ECDSA: SEQUENCE { INTEGER r, INTEGER s }, each INTEGER minimally encoded
 * with a leading 0x00 if the high bit would otherwise be set (to keep it positive).
 *
 * @param {Buffer} rawSignature
 * @returns {Buffer|null}
 */
export function coseEs384SignatureToDer(rawSignature) {
  if (!Buffer.isBuffer(rawSignature) || rawSignature.length !== 96) return null;
  const encodeInt = (bytes) => {
    let i = 0;
    while (i < bytes.length - 1 && bytes[i] === 0) i += 1;
    let trimmed = bytes.subarray(i);
    if (trimmed[0] & 0x80) trimmed = Buffer.concat([Buffer.from([0]), trimmed]);
    return Buffer.concat([Buffer.from([0x02, trimmed.length]), trimmed]);
  };
  const r = encodeInt(rawSignature.subarray(0, 48));
  const s = encodeInt(rawSignature.subarray(48, 96));
  const body = Buffer.concat([r, s]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}
