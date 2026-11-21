// Type declarations for the COSE-Sign1 Sig_structure encoder + ES384 DER converter.
// See cose-verify.js for the runtime. These mirror the runtime signatures so strict
// TypeScript consumers (apps/web) can import from '@r3e-network/neo-os-services-shared/cose-verify'.

/// <reference types="node" />

/**
 * Minimal deterministic CBOR encoder for a Sig_structure array (RFC 8152 §4.4):
 * a fixed-length array of text strings + byte strings. Only the majors needed by
 * Sig_structure are supported (array=4, byte string=2, text string=3).
 */
export function cborEncodeSigStructure(items: Array<string | Buffer | Uint8Array>): Buffer;

/**
 * Build the COSE Sig_structure for a COSE_Sign1 (RFC 8152 §4.4):
 *   Sig_structure = [ "Signature1", body_protected(bstr), external_aad(bstr ""), payload(bstr) ]
 * The protected header + payload MUST be the original wire bytes (never re-serialized)
 * or the ES384 signature will not verify.
 */
export function buildCoseSign1SigStructure(
  protectedHeaderBytes: Buffer,
  payloadBytes: Buffer
): Buffer;

/**
 * Convert a 96-byte COSE raw (r||s) ES384 signature into the DER-encoded ECDSA
 * signature Node's crypto.verify expects (with dsaEncoding:'der'). Returns null if
 * the input is not a 96-byte raw signature (e.g. a placeholder).
 */
export function coseEs384SignatureToDer(rawSignature: Buffer): Buffer | null;
