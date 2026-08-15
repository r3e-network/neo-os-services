/**
 * REAL AWS Nitro Enclaves remote-attestation verifier (server-side, Node).
 *
 * This is the measurement-chain layer that the legacy hash-binding verifier
 * (`./attestation.ts` `verifyAttestation`) never performed. It parses the raw
 * AWS NSM attestation document (a CBOR-encoded COSE_Sign1, RFC 8152) and
 * cryptographically verifies:
 *
 *   1. CBOR/COSE structure         — base64 -> COSE_Sign1 [protected, unprotected, payload, signature]
 *   2. NSM payload sanity          — digest === "SHA384", module_id present, timestamp within skew
 *   3. X.509 cert chain            — leaf(certificate) -> cabundle... -> PINNED AWS Nitro root,
 *                                    validity windows vs the doc timestamp, issuer signatures, CA basicConstraints
 *   4. COSE_Sign1 signature        — Sig_structure ["Signature1", protected, b"", payload] ES384 (alg from PROTECTED header only)
 *   5. PCR0/1/2                    — equal to the published, pinned measurement manifest
 *   6. binding                     — user_data == sha256(expected fulfillment digest), public_key == signer, nonce == caller nonce
 *
 * `measurement_chain_verified` is true ONLY when every required check passes.
 *
 * Zero new npm dependencies: CBOR + COSE are hand-rolled (a few hundred lines,
 * matching the repo's hand-rolled-crypto house style); the cert chain uses
 * Node's built-in `crypto.X509Certificate`; ES384 uses WebCrypto P-384.
 *
 * SECURITY NOTES (each maps to a known attack the adversarial tests exercise):
 *   - The COSE algorithm is read ONLY from the protected (signed) header. A
 *     forged `alg` in the unprotected header is ignored.
 *   - The trust anchor is the PINNED root whose DER SHA-256 is asserted at load.
 *     A self-signed / attacker root never matches and the chain fails closed.
 *   - PCR mismatch, expired leaf, tampered payload, replayed/zeroed nonce, and
 *     user_data/public_key mismatches each flip a specific boolean to false and
 *     prevent `measurement_chain_verified`.
 */

import { createHash, webcrypto, X509Certificate } from 'node:crypto';

import { buildCoseSign1SigStructure } from '@r3e-network/neo-os-services-shared/cose-verify';

// ---------------------------------------------------------------------------
// Pinned AWS Nitro Enclaves root(s)
// ---------------------------------------------------------------------------

/**
 * DER SHA-256 fingerprints of every accepted AWS Nitro Enclaves root.
 * Published by AWS; the G1 value below is the one shipped in
 * `aws-nitro-root.pem`. Add (never replace) entries on a G1->G2 rotation.
 */
export const AWS_NITRO_ROOT_FINGERPRINTS_SHA256: readonly string[] = [
  '641a0321a3e244efe456463195d606317ed7cdcc3c1756e09893f3c68f79bb5b', // AWS Nitro Enclaves Root G1
];

/**
 * Pinned AWS Nitro Enclaves Root G1 certificate, inlined so the verifier never
 * depends on a filesystem read or a bundler asset path (works identically in
 * Next.js server routes, vitest, and offline). The canonical, reviewable copy
 * lives at `lib/attestation/aws-nitro-root.pem`; a test asserts the two agree
 * byte-for-byte, and `loadPinnedRoots()` asserts this constant's DER SHA-256
 * against AWS_NITRO_ROOT_FINGERPRINTS_SHA256 at load — so neither can drift.
 */
export const AWS_NITRO_ROOT_G1_PEM = `-----BEGIN CERTIFICATE-----
MIICETCCAZagAwIBAgIRAPkxdWgbkK/hHUbMtOTn+FYwCgYIKoZIzj0EAwMwSTEL
MAkGA1UEBhMCVVMxDzANBgNVBAoMBkFtYXpvbjEMMAoGA1UECwwDQVdTMRswGQYD
VQQDDBJhd3Mubml0cm8tZW5jbGF2ZXMwHhcNMTkxMDI4MTMyODA1WhcNNDkxMDI4
MTQyODA1WjBJMQswCQYDVQQGEwJVUzEPMA0GA1UECgwGQW1hem9uMQwwCgYDVQQL
DANBV1MxGzAZBgNVBAMMEmF3cy5uaXRyby1lbmNsYXZlczB2MBAGByqGSM49AgEG
BSuBBAAiA2IABPwCVOumCMHzaHDimtqQvkY4MpJzbolL//Zy2YlES1BR5TSksfbb
48C8WBoyt7F2Bw7eEtaaP+ohG2bnUs990d0JX28TcPQXCEPZ3BABIeTPYwEoCWZE
h8l5YoQwTcU/9KNCMEAwDwYDVR0TAQH/BAUwAwEB/zAdBgNVHQ4EFgQUkCW1DdkF
R+eWw5b6cp3PmanfS5YwDgYDVR0PAQH/BAQDAgGGMAoGCCqGSM49BAMDA2kAMGYC
MQCjfy+Rocm9Xue4YnwWmNJVA44fA0P5W2OpYow9OYCVRaEevL8uO1XYru5xtMPW
rfMCMQCi85sWBbJwKKXdS6BptQFuZbT73o/gBh1qUxl/nNr12UO8Yfwr6wPLb+6N
IwLz3/Y=
-----END CERTIFICATE-----`;

/** Lazily-loaded, fingerprint-asserted pinned roots. */
let cachedPinnedRoots: X509Certificate[] | null = null;

function loadPinnedRoots(): X509Certificate[] {
  if (cachedPinnedRoots) return cachedPinnedRoots;
  const roots = parsePemCertificates(AWS_NITRO_ROOT_G1_PEM).map((der) => new X509Certificate(der));
  if (roots.length === 0) {
    throw new Error('pinned AWS Nitro root PEM contains no certificate');
  }
  for (const root of roots) {
    const fp = sha256Hex(root.raw);
    if (!AWS_NITRO_ROOT_FINGERPRINTS_SHA256.includes(fp)) {
      throw new Error(
        `pinned AWS Nitro root fingerprint mismatch: got ${fp}, expected one of ${AWS_NITRO_ROOT_FINGERPRINTS_SHA256.join(
          ', '
        )}`
      );
    }
  }
  cachedPinnedRoots = roots;
  return roots;
}

/**
 * Override the pinned roots (TEST ONLY). Pass a PEM string containing the test
 * root(s) and an array of accepted DER-SHA256 fingerprints; pass `null` to
 * restore the production pinned root. Marked clearly so production code never
 * uses it.
 */
export function __setPinnedRootsForTest(
  pem: string | null,
  acceptedFingerprints?: readonly string[]
): void {
  if (pem === null) {
    cachedPinnedRoots = null;
    return;
  }
  const roots = parsePemCertificates(pem).map((der) => new X509Certificate(der));
  if (acceptedFingerprints) {
    for (const root of roots) {
      const fp = sha256Hex(root.raw);
      if (!acceptedFingerprints.includes(fp)) {
        throw new Error(`test root fingerprint ${fp} not in accepted list`);
      }
    }
  }
  cachedPinnedRoots = roots;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const DEFAULT_TIMESTAMP_SKEW_MS = 5 * 60 * 1000; // 5 min clock skew either side
const DEFAULT_MAX_AGE_MS = 12 * 60 * 60 * 1000; // doc considered stale after 12h
const MAX_ATTESTATION_DOCUMENT_BYTES = 128 * 1024;

function sha256Hex(value: Uint8Array | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeHex(value: unknown): string {
  return String(value ?? '')
    .trim()
    .replace(/^0x/i, '')
    .toLowerCase();
}

function hexToBytes(hex: string): Buffer {
  const clean = normalizeHex(hex);
  if (clean.length % 2 !== 0 || !/^[0-9a-f]*$/.test(clean)) {
    throw new Error('invalid hex string');
  }
  return Buffer.from(clean, 'hex');
}

/** Constant-time-ish equality for short fixed-length comparisons. */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

function parsePemCertificates(pem: string): Buffer[] {
  const blocks: Buffer[] = [];
  const regex = /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(pem)) !== null) {
    const b64 = match[1].replace(/\s+/g, '');
    blocks.push(Buffer.from(b64, 'base64'));
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Minimal CBOR decoder (RFC 8949 subset sufficient for COSE_Sign1 + NSM doc)
//
// Supports: unsigned/negative ints, byte strings, text strings, arrays, maps,
// tags (skipped/unwrapped), simple values false/true/null/undefined, and the
// IEEE-754 float widths. Indefinite-length items are rejected (NSM docs are
// definite-length). Trailing bytes after the top-level item are rejected.
// ---------------------------------------------------------------------------

class CborDecoder {
  private readonly buf: Buffer;
  private pos = 0;

  constructor(buf: Buffer) {
    this.buf = buf;
  }

  static decodeFirst(buf: Buffer): unknown {
    const dec = new CborDecoder(buf);
    const value = dec.readValue();
    if (dec.pos !== buf.length) {
      throw new Error(`trailing bytes after CBOR item (${buf.length - dec.pos} remaining)`);
    }
    return value;
  }

  private require(n: number): void {
    if (this.pos + n > this.buf.length) throw new Error('unexpected end of CBOR input');
  }

  private readUint(info: number): number {
    if (info < 24) return info;
    if (info === 24) {
      this.require(1);
      const v = this.buf.readUInt8(this.pos);
      this.pos += 1;
      return v;
    }
    if (info === 25) {
      this.require(2);
      const v = this.buf.readUInt16BE(this.pos);
      this.pos += 2;
      return v;
    }
    if (info === 26) {
      this.require(4);
      const v = this.buf.readUInt32BE(this.pos);
      this.pos += 4;
      return v;
    }
    if (info === 27) {
      this.require(8);
      const hi = this.buf.readUInt32BE(this.pos);
      const lo = this.buf.readUInt32BE(this.pos + 4);
      this.pos += 8;
      const v = hi * 0x100000000 + lo;
      if (!Number.isSafeInteger(v)) {
        // timestamp (ms) and lengths stay well within 2^53; reject the rest.
        throw new Error('CBOR integer exceeds safe integer range');
      }
      return v;
    }
    throw new Error(`unsupported CBOR additional info ${info}`);
  }

  private readValue(): unknown {
    this.require(1);
    const initial = this.buf.readUInt8(this.pos);
    this.pos += 1;
    const major = initial >> 5;
    const info = initial & 0x1f;

    switch (major) {
      case 0: // unsigned int
        return this.readUint(info);
      case 1: // negative int
        return -1 - this.readUint(info);
      case 2: {
        // byte string. AWS NSM attestation documents are emitted with
        // INDEFINITE-LENGTH encoding (RFC 8949 §3.2.3): the payload map, the
        // `pcrs` map, and the `cabundle` array all use major-type+31 framing with
        // a 0xff break. Indefinite byte/text strings are a concatenation of
        // definite-length chunks until the break.
        if (info === 31) {
          const chunks: Buffer[] = [];
          for (;;) {
            this.require(1);
            if (this.buf.readUInt8(this.pos) === 0xff) {
              this.pos += 1;
              break;
            }
            const chunk = this.readValue();
            if (!Buffer.isBuffer(chunk)) {
              throw new Error('indefinite byte string contains a non-byte-string chunk');
            }
            chunks.push(chunk);
          }
          return Buffer.concat(chunks);
        }
        const len = this.readUint(info);
        this.require(len);
        const out = this.buf.subarray(this.pos, this.pos + len);
        this.pos += len;
        return Buffer.from(out);
      }
      case 3: {
        // text string
        if (info === 31) {
          const parts: string[] = [];
          for (;;) {
            this.require(1);
            if (this.buf.readUInt8(this.pos) === 0xff) {
              this.pos += 1;
              break;
            }
            const chunk = this.readValue();
            if (typeof chunk !== 'string') {
              throw new Error('indefinite text string contains a non-text-string chunk');
            }
            parts.push(chunk);
          }
          return parts.join('');
        }
        const len = this.readUint(info);
        this.require(len);
        const out = this.buf.toString('utf8', this.pos, this.pos + len);
        this.pos += len;
        return out;
      }
      case 4: {
        // array (definite or indefinite, terminated by the 0xff break)
        if (info === 31) {
          const arr: unknown[] = [];
          for (;;) {
            this.require(1);
            if (this.buf.readUInt8(this.pos) === 0xff) {
              this.pos += 1;
              break;
            }
            arr.push(this.readValue());
          }
          return arr;
        }
        const len = this.readUint(info);
        const arr: unknown[] = new Array(len);
        for (let i = 0; i < len; i += 1) arr[i] = this.readValue();
        return arr;
      }
      case 5: {
        // map -> Map (keys may be ints, as in COSE headers; definite or
        // indefinite, terminated by the 0xff break).
        if (info === 31) {
          const map = new Map<unknown, unknown>();
          for (;;) {
            this.require(1);
            if (this.buf.readUInt8(this.pos) === 0xff) {
              this.pos += 1;
              break;
            }
            const key = this.readValue();
            const value = this.readValue();
            map.set(key, value);
          }
          return map;
        }
        const len = this.readUint(info);
        const map = new Map<unknown, unknown>();
        for (let i = 0; i < len; i += 1) {
          const key = this.readValue();
          const value = this.readValue();
          map.set(key, value);
        }
        return map;
      }
      case 6: {
        // tag — unwrap (the inner value is what we care about)
        this.readUint(info);
        return this.readValue();
      }
      case 7: {
        // simple / float
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22) return null;
        if (info === 23) return undefined;
        if (info === 25) {
          this.require(2);
          const v = readFloat16(this.buf, this.pos);
          this.pos += 2;
          return v;
        }
        if (info === 26) {
          this.require(4);
          const v = this.buf.readFloatBE(this.pos);
          this.pos += 4;
          return v;
        }
        if (info === 27) {
          this.require(8);
          const v = this.buf.readDoubleBE(this.pos);
          this.pos += 8;
          return v;
        }
        throw new Error(`unsupported CBOR simple value ${info}`);
      }
      default:
        throw new Error(`unsupported CBOR major type ${major}`);
    }
  }
}

function readFloat16(buf: Buffer, offset: number): number {
  const half = buf.readUInt16BE(offset);
  const exp = (half >> 10) & 0x1f;
  const mant = half & 0x3ff;
  const sign = half & 0x8000 ? -1 : 1;
  if (exp === 0) return sign * 2 ** -14 * (mant / 1024);
  if (exp === 0x1f) return mant ? NaN : sign * Infinity;
  return sign * 2 ** (exp - 15) * (1 + mant / 1024);
}

// ---------------------------------------------------------------------------
// COSE Sig_structure encoder: single-sourced in @r3e-network/neo-os-services-shared/cose-verify
// (buildCoseSign1SigStructure). Previously this file carried its own copy with an
// extra 64-bit length branch that is never reached for NSM-sized payloads (< 64KB),
// so the two produced byte-identical Sig_structure bytes — but two copies can drift
// silently. The decode side (CborDecoder) stays local for now (see roadmap 1.1c-HOLD:
// NsmAttestationDocument.pcrs is a Map and tests pin Map semantics).

// ---------------------------------------------------------------------------
// COSE_Sign1 + NSM document structures
// ---------------------------------------------------------------------------

interface CoseSign1 {
  protectedHeaderRaw: Buffer; // the raw bstr contents (the encoded protected map)
  protectedHeader: Map<number, unknown>;
  unprotectedHeader: Map<unknown, unknown>;
  payload: Buffer;
  signature: Buffer;
}

function decodeCoseSign1(doc: Buffer): CoseSign1 {
  const decoded = CborDecoder.decodeFirst(doc);
  if (!Array.isArray(decoded) || decoded.length !== 4) {
    throw new Error('attestation document is not a 4-element COSE_Sign1 array');
  }
  const [prot, unprot, payload, signature] = decoded;
  if (!Buffer.isBuffer(prot)) throw new Error('COSE protected header is not a byte string');
  if (!Buffer.isBuffer(payload)) throw new Error('COSE payload is not a byte string');
  if (!Buffer.isBuffer(signature)) throw new Error('COSE signature is not a byte string');

  // The protected header is a bstr wrapping a CBOR map. Empty bstr => empty map.
  let protectedHeader: Map<number, unknown>;
  if (prot.length === 0) {
    protectedHeader = new Map();
  } else {
    const innerMap = CborDecoder.decodeFirst(prot);
    if (!(innerMap instanceof Map)) throw new Error('COSE protected header is not a map');
    protectedHeader = new Map();
    for (const [k, v] of innerMap.entries()) {
      protectedHeader.set(typeof k === 'number' ? k : Number(k), v);
    }
  }

  const unprotectedHeader =
    unprot instanceof Map ? (unprot as Map<unknown, unknown>) : new Map<unknown, unknown>();

  return {
    protectedHeaderRaw: prot,
    protectedHeader,
    unprotectedHeader,
    payload,
    signature,
  };
}

export interface NsmAttestationDocument {
  module_id: string;
  timestamp: number;
  digest: string;
  pcrs: Map<number, Buffer>;
  certificate: Buffer;
  cabundle: Buffer[];
  public_key: Buffer | null;
  user_data: Buffer | null;
  nonce: Buffer | null;
}

function decodeNsmPayload(payload: Buffer): NsmAttestationDocument {
  const decoded = CborDecoder.decodeFirst(payload);
  if (!(decoded instanceof Map)) throw new Error('NSM payload is not a CBOR map');
  const get = (key: string) => decoded.get(key);

  const moduleId = get('module_id');
  const timestamp = get('timestamp');
  const digest = get('digest');
  const pcrsRaw = get('pcrs');
  const certificate = get('certificate');
  const cabundle = get('cabundle');

  if (typeof moduleId !== 'string') throw new Error('NSM doc missing module_id');
  if (typeof timestamp !== 'number') throw new Error('NSM doc missing timestamp');
  if (typeof digest !== 'string') throw new Error('NSM doc missing digest');
  if (!(pcrsRaw instanceof Map)) throw new Error('NSM doc missing pcrs map');
  if (!Buffer.isBuffer(certificate)) throw new Error('NSM doc missing certificate');
  if (!Array.isArray(cabundle)) throw new Error('NSM doc missing cabundle');

  const pcrs = new Map<number, Buffer>();
  for (const [k, v] of pcrsRaw.entries()) {
    if (typeof k === 'number' && Buffer.isBuffer(v)) pcrs.set(k, Buffer.from(v));
  }

  const cabundleBuffers: Buffer[] = [];
  for (const entry of cabundle) {
    if (!Buffer.isBuffer(entry)) throw new Error('NSM cabundle entry is not a byte string');
    cabundleBuffers.push(Buffer.from(entry));
  }

  const optionalBytes = (value: unknown): Buffer | null =>
    Buffer.isBuffer(value) ? Buffer.from(value) : null;

  return {
    module_id: moduleId,
    timestamp,
    digest,
    pcrs,
    certificate: Buffer.from(certificate),
    cabundle: cabundleBuffers,
    public_key: optionalBytes(get('public_key')),
    user_data: optionalBytes(get('user_data')),
    nonce: optionalBytes(get('nonce')),
  };
}

// ---------------------------------------------------------------------------
// ES384 (COSE alg -35) signature verification against the leaf cert key
// ---------------------------------------------------------------------------

const COSE_ALG_ES384 = -35;
const COSE_HEADER_ALG = 1;

async function verifyCoseEs384(cose: CoseSign1, leaf: X509Certificate): Promise<boolean> {
  // The algorithm MUST come from the protected (integrity-protected) header.
  const alg = cose.protectedHeader.get(COSE_HEADER_ALG);
  if (alg !== COSE_ALG_ES384) {
    throw new Error(`unexpected/forbidden COSE alg in protected header: ${String(alg)} (want -35)`);
  }

  const sigStructure = buildCoseSign1SigStructure(cose.protectedHeaderRaw, cose.payload);

  // AWS NSM COSE signatures are raw P-384 r||s (96 bytes). WebCrypto ECDSA
  // verify consumes exactly that fixed-width concatenation.
  if (cose.signature.length !== 96) {
    throw new Error(`unexpected ES384 signature length ${cose.signature.length} (want 96)`);
  }

  // Export the leaf SPKI to a WebCrypto P-384 verify key.
  const spki = leaf.publicKey.export({ type: 'spki', format: 'der' });
  const key = await webcrypto.subtle.importKey(
    'spki',
    spki as unknown as ArrayBuffer,
    { name: 'ECDSA', namedCurve: 'P-384' },
    false,
    ['verify']
  );

  return webcrypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-384' },
    key,
    cose.signature as unknown as ArrayBuffer,
    sigStructure as unknown as ArrayBuffer
  );
}

// ---------------------------------------------------------------------------
// X.509 chain verification: leaf -> cabundle... -> pinned root
// ---------------------------------------------------------------------------

interface ChainResult {
  cert_chain_ok: boolean;
  root_pinned_ok: boolean;
  errors: string[];
  leaf: X509Certificate | null;
}

function withinValidity(cert: X509Certificate, atMs: number): boolean {
  const from = cert.validFromDate?.getTime();
  const to = cert.validToDate?.getTime();
  if (
    typeof from !== 'number' ||
    typeof to !== 'number' ||
    Number.isNaN(from) ||
    Number.isNaN(to)
  ) {
    return false;
  }
  return atMs >= from && atMs <= to;
}

function verifyCertChain(doc: NsmAttestationDocument): ChainResult {
  const errors: string[] = [];
  const pinnedRoots = loadPinnedRoots();

  let leaf: X509Certificate;
  try {
    leaf = new X509Certificate(doc.certificate);
  } catch (error) {
    return {
      cert_chain_ok: false,
      root_pinned_ok: false,
      errors: [`leaf certificate parse failed: ${(error as Error).message}`],
      leaf: null,
    };
  }

  // cabundle is ordered root-first per AWS; build leaf -> ... -> root by
  // walking from the leaf up through reversed intermediates.
  let intermediates: X509Certificate[] = [];
  try {
    intermediates = doc.cabundle.map((der) => new X509Certificate(der));
  } catch (error) {
    return {
      cert_chain_ok: false,
      root_pinned_ok: false,
      errors: [`cabundle parse failed: ${(error as Error).message}`],
      leaf,
    };
  }

  // Ordered from leaf's issuer downward to the self-signed root.
  const upward = [...intermediates].reverse();
  // Full ordered chain we will validate link-by-link: [leaf, ...upward].
  const ordered = [leaf, ...upward];
  const atMs = doc.timestamp;

  // 1) Every cert must be within its validity window at the doc timestamp.
  for (const cert of ordered) {
    if (!withinValidity(cert, atMs)) {
      errors.push(`certificate ${cert.subject.replace(/\n/g, ' ')} not valid at doc timestamp`);
    }
  }

  // 2) Each non-root cert must be signed by the next cert up; EVERY issuer
  //    (every parent — both intermediates and the root) must be a CA. Verify
  //    issuance both by name (checkIssued) and signature.
  for (let i = 0; i < ordered.length - 1; i += 1) {
    const child = ordered[i];
    const parent = ordered[i + 1];
    if (!parent.ca) {
      errors.push(`issuer ${parent.subject.replace(/\n/g, ' ')} is not a CA (basicConstraints)`);
    }
    let issued = false;
    try {
      issued = child.checkIssued(parent);
    } catch {
      issued = false;
    }
    if (!issued) {
      errors.push(`certificate ${i} is not issued by certificate ${i + 1} (name/AKI mismatch)`);
    }
    let sigOk = false;
    try {
      sigOk = child.verify(parent.publicKey);
    } catch {
      sigOk = false;
    }
    if (!sigOk) {
      errors.push(`certificate ${i} signature does not verify against issuer ${i + 1}`);
    }
  }

  // 3) The top of the supplied chain must be a PINNED root: its DER must match
  //    a pinned root EXACTLY (this is the trust anchor — not merely "valid").
  const top = ordered[ordered.length - 1];
  const topFp = sha256Hex(top.raw);
  const matchedRoot = pinnedRoots.find((root) => sha256Hex(root.raw) === topFp) ?? null;
  const root_pinned_ok = matchedRoot !== null;
  if (!root_pinned_ok) {
    errors.push('chain does not terminate at a pinned AWS Nitro root');
  } else {
    // Belt-and-braces: the pinned root must self-verify (it is self-signed) and
    // be within validity at the doc timestamp.
    let rootSelfOk = false;
    try {
      rootSelfOk = matchedRoot.verify(matchedRoot.publicKey);
    } catch {
      rootSelfOk = false;
    }
    if (!rootSelfOk) errors.push('pinned root self-signature failed to verify');
    if (!withinValidity(matchedRoot, atMs)) errors.push('pinned root not valid at doc timestamp');
  }

  // A single supplied cert (leaf only, no cabundle) can only be trusted if it
  // IS a pinned root — otherwise there is no anchor.
  const cert_chain_ok = errors.length === 0 && ordered.length >= 1 && root_pinned_ok;

  return { cert_chain_ok, root_pinned_ok, errors, leaf };
}

// ---------------------------------------------------------------------------
// Public verifier
// ---------------------------------------------------------------------------

export interface ExpectedPcrs {
  pcr0?: string;
  pcr1?: string;
  pcr2?: string;
}

export interface VerifyNitroOptions {
  /** Pinned measurement manifest values (hex, 48-byte SHA-384) to compare. */
  expectedPcrs?: ExpectedPcrs;
  /** Override pinned root PEM (TEST ONLY); production uses the committed pin. */
  awsRootPem?: string;
  /** Accepted DER-SHA256 fingerprints for `awsRootPem` (TEST ONLY). */
  awsRootFingerprintsSha256?: readonly string[];
  /** Hex of the fulfillment digest; user_data must equal sha256(thoseBytes). */
  expectedUserDataHex?: string;
  /** Expected signer public key (hex); compared to doc.public_key. */
  expectedSignerPublicKey?: string;
  /** Caller freshness nonce (hex); compared to doc.nonce. */
  nonce?: string;
  /** Current time (ms) for freshness/validity (defaults to Date.now()). */
  now?: number;
  /** Allowable clock skew (ms) for the timestamp window. */
  timestampSkewMs?: number;
  /** Max document age (ms) before it is considered stale. */
  maxAgeMs?: number;
}

export interface NitroVerificationResult {
  cose_signature_ok: boolean;
  cert_chain_ok: boolean;
  root_pinned_ok: boolean;
  pcr0_match: boolean;
  pcr1_match: boolean;
  pcr2_match: boolean;
  user_data_bound_ok: boolean;
  public_key_bound_ok: boolean;
  nonce_match: boolean;
  timestamp_fresh: boolean;
  measurement_chain_verified: boolean;
  errors: string[];
  document?: {
    module_id: string;
    timestamp: number;
    digest: string;
    pcr0: string | null;
    pcr1: string | null;
    pcr2: string | null;
    public_key: string | null;
    user_data: string | null;
    nonce: string | null;
  };
}

function failResult(error: string): NitroVerificationResult {
  return {
    cose_signature_ok: false,
    cert_chain_ok: false,
    root_pinned_ok: false,
    pcr0_match: false,
    pcr1_match: false,
    pcr2_match: false,
    user_data_bound_ok: false,
    public_key_bound_ok: false,
    nonce_match: false,
    timestamp_fresh: false,
    measurement_chain_verified: false,
    errors: [error],
  };
}

/**
 * Verify a raw AWS Nitro NSM attestation document end-to-end.
 *
 * @param documentB64 base64 of the COSE_Sign1 attestation document.
 * @param options binding + pinning parameters (see {@link VerifyNitroOptions}).
 *
 * Returns granular booleans; `measurement_chain_verified` is true ONLY when
 * the COSE signature, pinned-root cert chain, all three PCRs, and every
 * requested binding (user_data / public_key / nonce) and freshness pass.
 */
export async function verifyNitroAttestationDocument(
  documentB64: string,
  options: VerifyNitroOptions = {}
): Promise<NitroVerificationResult> {
  const errors: string[] = [];

  // Optional test-only root override.
  if (typeof options.awsRootPem === 'string') {
    try {
      __setPinnedRootsForTest(options.awsRootPem, options.awsRootFingerprintsSha256);
    } catch (error) {
      return failResult(`root pin override rejected: ${(error as Error).message}`);
    }
  }

  // 1) base64 -> COSE_Sign1.
  let docBytes: Buffer;
  try {
    if (typeof documentB64 !== 'string' || documentB64.trim() === '') {
      throw new Error('attestation document is empty');
    }
    if (documentB64.length > MAX_ATTESTATION_DOCUMENT_BYTES * 2) {
      throw new Error('attestation document is too large');
    }
    docBytes = Buffer.from(documentB64, 'base64');
    if (docBytes.length === 0) throw new Error('attestation document decoded to zero bytes');
    if (docBytes.length > MAX_ATTESTATION_DOCUMENT_BYTES) {
      throw new Error('attestation document is too large');
    }
  } catch (error) {
    return failResult(`base64 decode failed: ${(error as Error).message}`);
  }

  let cose: CoseSign1;
  try {
    cose = decodeCoseSign1(docBytes);
  } catch (error) {
    return failResult(`COSE_Sign1 decode failed: ${(error as Error).message}`);
  }

  // 2) CBOR-decode the NSM payload + sanity checks.
  let doc: NsmAttestationDocument;
  try {
    doc = decodeNsmPayload(cose.payload);
  } catch (error) {
    return failResult(`NSM payload decode failed: ${(error as Error).message}`);
  }

  if (doc.digest !== 'SHA384') errors.push(`unexpected digest algorithm ${doc.digest}`);
  if (!doc.module_id || doc.module_id.trim() === '') errors.push('empty module_id');

  const now = typeof options.now === 'number' ? options.now : Date.now();
  const skew = options.timestampSkewMs ?? DEFAULT_TIMESTAMP_SKEW_MS;
  const maxAge = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  // Fresh: not from the future (beyond skew) and not older than maxAge (+skew).
  const timestamp_fresh =
    doc.timestamp <= now + skew && doc.timestamp >= now - maxAge - skew && doc.timestamp > 0;
  if (!timestamp_fresh) errors.push('attestation timestamp outside freshness window');

  // 3) Cert chain to the pinned root.
  const chain = verifyCertChain(doc);
  errors.push(...chain.errors);

  // 4) COSE signature with the leaf key (alg from protected header only).
  let cose_signature_ok = false;
  if (chain.leaf) {
    try {
      cose_signature_ok = await verifyCoseEs384(cose, chain.leaf);
    } catch (error) {
      errors.push(`COSE signature verification failed: ${(error as Error).message}`);
      cose_signature_ok = false;
    }
  } else {
    errors.push('no leaf certificate available for COSE verification');
  }

  // 5) PCR0/1/2 == pinned manifest. If an expected value is provided it MUST
  //    match; missing actual or missing expected => not matched.
  const pcrMatch = (index: number, expected?: string): boolean => {
    if (!expected) return false;
    const actual = doc.pcrs.get(index);
    if (!actual) return false;
    let expectedBytes: Buffer;
    try {
      expectedBytes = hexToBytes(expected);
    } catch {
      errors.push(`invalid expected PCR${index} hex`);
      return false;
    }
    if (expectedBytes.length !== actual.length) {
      errors.push(`PCR${index} length mismatch`);
      return false;
    }
    return bytesEqual(actual, expectedBytes);
  };

  const expectedPcrs = options.expectedPcrs ?? {};
  const pcr0_match = pcrMatch(0, expectedPcrs.pcr0);
  const pcr1_match = pcrMatch(1, expectedPcrs.pcr1);
  const pcr2_match = pcrMatch(2, expectedPcrs.pcr2);
  if (expectedPcrs.pcr0 && !pcr0_match) errors.push('PCR0 mismatch');
  if (expectedPcrs.pcr1 && !pcr1_match) errors.push('PCR1 mismatch');
  if (expectedPcrs.pcr2 && !pcr2_match) errors.push('PCR2 mismatch');

  // 6) Bindings.
  //    user_data must equal sha256(expectedFulfillmentDigestBytes).
  let user_data_bound_ok = false;
  if (options.expectedUserDataHex) {
    try {
      const expectedDigestBytes = hexToBytes(options.expectedUserDataHex);
      const expectedCommit = createHash('sha256').update(expectedDigestBytes).digest();
      user_data_bound_ok = doc.user_data ? bytesEqual(doc.user_data, expectedCommit) : false;
      if (!user_data_bound_ok) errors.push('user_data does not bind expected fulfillment digest');
    } catch (error) {
      errors.push(`expectedUserDataHex invalid: ${(error as Error).message}`);
    }
  }

  let public_key_bound_ok = false;
  if (options.expectedSignerPublicKey) {
    try {
      const expectedPk = hexToBytes(options.expectedSignerPublicKey);
      public_key_bound_ok = doc.public_key ? bytesEqual(doc.public_key, expectedPk) : false;
      if (!public_key_bound_ok) errors.push('public_key does not match expected signer');
    } catch (error) {
      errors.push(`expectedSignerPublicKey invalid: ${(error as Error).message}`);
    }
  }

  let nonce_match = false;
  if (options.nonce) {
    try {
      const expectedNonce = hexToBytes(options.nonce);
      // A zeroed / empty nonce never satisfies a non-empty caller nonce.
      nonce_match =
        doc.nonce && doc.nonce.length > 0 ? bytesEqual(doc.nonce, expectedNonce) : false;
      if (!nonce_match) errors.push('nonce mismatch (possible replay)');
    } catch (error) {
      errors.push(`nonce invalid: ${(error as Error).message}`);
    }
  }

  // Required-binding gating: any binding the caller ASKED to check must pass.
  const userDataRequiredOk = options.expectedUserDataHex ? user_data_bound_ok : true;
  const publicKeyRequiredOk = options.expectedSignerPublicKey ? public_key_bound_ok : true;
  const nonceRequiredOk = options.nonce ? nonce_match : true;
  // PCRs are always required for a measurement-verified result.
  const pcrsRequiredOk = pcr0_match && pcr1_match && pcr2_match;

  const sanityOk = doc.digest === 'SHA384' && Boolean(doc.module_id);

  const measurement_chain_verified =
    cose_signature_ok &&
    chain.cert_chain_ok &&
    chain.root_pinned_ok &&
    pcrsRequiredOk &&
    userDataRequiredOk &&
    publicKeyRequiredOk &&
    nonceRequiredOk &&
    timestamp_fresh &&
    sanityOk;

  const toHex = (b: Buffer | null) => (b ? b.toString('hex') : null);

  return {
    cose_signature_ok,
    cert_chain_ok: chain.cert_chain_ok,
    root_pinned_ok: chain.root_pinned_ok,
    pcr0_match,
    pcr1_match,
    pcr2_match,
    user_data_bound_ok,
    public_key_bound_ok,
    nonce_match,
    timestamp_fresh,
    measurement_chain_verified,
    errors,
    document: {
      module_id: doc.module_id,
      timestamp: doc.timestamp,
      digest: doc.digest,
      pcr0: toHex(doc.pcrs.get(0) ?? null),
      pcr1: toHex(doc.pcrs.get(1) ?? null),
      pcr2: toHex(doc.pcrs.get(2) ?? null),
      public_key: toHex(doc.public_key),
      user_data: toHex(doc.user_data),
      nonce: toHex(doc.nonce),
    },
  };
}

/**
 * Convenience: decode an attestation document WITHOUT verifying it (for the
 * measurements/diagnostics surfaces). Throws on malformed input.
 */
export function decodeNitroAttestationDocument(documentB64: string): NsmAttestationDocument {
  const docBytes = Buffer.from(documentB64, 'base64');
  const cose = decodeCoseSign1(docBytes);
  return decodeNsmPayload(cose.payload);
}

/** Exported for tests + diagnostics. */
export const __internals = {
  CborDecoder,
  decodeCoseSign1,
  decodeNsmPayload,
  sha256Hex,
};
