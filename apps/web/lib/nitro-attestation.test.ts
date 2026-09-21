/**
 * Adversarial tests for the REAL AWS Nitro attestation verifier.
 *
 * There is no offline real AWS Nitro document available in this environment, so
 * the suite builds a SYNTHETIC-but-structurally-faithful fixture entirely
 * in-process (zero external deps, zero system binaries):
 *
 *   - generates an ES384 (P-384) cert chain: test root -> intermediate -> leaf
 *     (hand-built X.509 DER, accepted by Node's crypto.X509Certificate),
 *   - crafts a COSE_Sign1 over an NSM-shaped CBOR payload (module_id, timestamp,
 *     digest=SHA384, pcrs, certificate, cabundle, public_key, user_data, nonce),
 *   - pins the TEST root (clearly marked test-only) so every verification branch
 *     is exercised.
 *
 * The production AWS Nitro Enclaves Root G1 stays pinned in
 * `aws-nitro-root.pem`; a dedicated test asserts its fingerprint loads.
 *
 * Each adversarial vector flips exactly one thing and asserts the right boolean
 * goes false AND measurement_chain_verified is denied:
 *   valid doc | tampered payload | wrong/self-signed root | mismatched PCR0 |
 *   expired leaf cert | replayed/zeroed nonce | wrong alg (protected vs
 *   unprotected) | user_data mismatch | public_key mismatch.
 */

import { webcrypto, X509Certificate, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  verifyNitroAttestationDocument,
  decodeNitroAttestationDocument,
  AWS_NITRO_ROOT_FINGERPRINTS_SHA256,
  AWS_NITRO_ROOT_G1_PEM,
  __setPinnedRootsForTest,
  __internals,
} from './nitro-attestation';
import { ACTIVE_NITRO_MEASUREMENT } from './nitro-measurements';

// ===========================================================================
// Minimal DER + X.509 cert builder (TEST ONLY)
// ===========================================================================

function len(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  let x = n;
  while (x > 0) {
    bytes.unshift(x & 0xff);
    x >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
function tlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), len(content.length), content]);
}
function seq(...items: Buffer[]): Buffer {
  return tlv(0x30, Buffer.concat(items));
}
function set(...items: Buffer[]): Buffer {
  return tlv(0x31, Buffer.concat(items));
}
function intBytes(buf: Buffer): Buffer {
  let b = Buffer.from(buf);
  let i = 0;
  while (i < b.length - 1 && b[i] === 0) i += 1;
  b = b.subarray(i);
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return tlv(0x02, b);
}
function intNum(n: number): Buffer {
  const bytes: number[] = [];
  let x = n;
  if (x === 0) bytes.push(0);
  while (x > 0) {
    bytes.unshift(x & 0xff);
    x = Math.floor(x / 256);
  }
  let buf = Buffer.from(bytes);
  if (buf[0] & 0x80) buf = Buffer.concat([Buffer.from([0]), buf]);
  return tlv(0x02, buf);
}
function oid(str: string): Buffer {
  const parts = str.split('.').map(Number);
  const out = [40 * parts[0] + parts[1]];
  for (let i = 2; i < parts.length; i += 1) {
    let v = parts[i];
    const tmp = [v & 0x7f];
    v >>= 7;
    while (v > 0) {
      tmp.unshift((v & 0x7f) | 0x80);
      v >>= 7;
    }
    out.push(...tmp);
  }
  return tlv(0x06, Buffer.from(out));
}
function utf8(s: string): Buffer {
  return tlv(0x0c, Buffer.from(s, 'utf8'));
}
function bitString(buf: Buffer): Buffer {
  return tlv(0x03, Buffer.concat([Buffer.from([0]), buf]));
}
function boolDer(b: boolean): Buffer {
  return tlv(0x01, Buffer.from([b ? 0xff : 0]));
}
function octet(buf: Buffer): Buffer {
  return tlv(0x04, buf);
}
function utcTime(date: Date): Buffer {
  const s = date.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z';
  return tlv(0x17, Buffer.from(s, 'ascii'));
}

const OID = {
  cn: '2.5.4.3',
  ecPublicKey: '1.2.840.10045.2.1',
  p384: '1.3.132.0.34',
  ecdsaSha384: '1.2.840.10045.4.3.3',
  basicConstraints: '2.5.29.19',
  keyUsage: '2.5.29.15',
};

function nameCN(cn: string): Buffer {
  return seq(set(seq(oid(OID.cn), utf8(cn))));
}
function algEcdsaSha384(): Buffer {
  return seq(oid(OID.ecdsaSha384));
}
function spki(rawPub: Buffer): Buffer {
  return seq(seq(oid(OID.ecPublicKey), oid(OID.p384)), bitString(rawPub));
}
function ext(extOid: string, critical: boolean, value: Buffer): Buffer {
  return seq(oid(extOid), ...(critical ? [boolDer(true)] : []), octet(value));
}
function bcCA(isCA: boolean): Buffer {
  return ext(OID.basicConstraints, true, seq(boolDer(isCA)));
}
function kuCertSign(): Buffer {
  return ext(OID.keyUsage, true, bitString(Buffer.from([0x06])));
}

async function rawPub(key: CryptoKey): Promise<Buffer> {
  const jwk = await webcrypto.subtle.exportKey('jwk', key);
  const x = Buffer.from(jwk.x as string, 'base64url');
  const y = Buffer.from(jwk.y as string, 'base64url');
  return Buffer.concat([Buffer.from([0x04]), x, y]);
}

interface MakeCertArgs {
  subject: string;
  issuer: string;
  subjectKey: CryptoKey;
  issuerKey: CryptoKey;
  serial: number;
  isCA: boolean;
  notBefore: Date;
  notAfter: Date;
}

async function makeCert(args: MakeCertArgs): Promise<Buffer> {
  const subjPubRaw = await rawPub(args.subjectKey);
  const exts = [bcCA(args.isCA), kuCertSign()];
  const tbs = seq(
    tlv(0xa0, intNum(2)), // version v3
    intNum(args.serial),
    algEcdsaSha384(),
    nameCN(args.issuer),
    seq(utcTime(args.notBefore), utcTime(args.notAfter)),
    nameCN(args.subject),
    spki(subjPubRaw),
    tlv(0xa3, seq(...exts))
  );
  const rawSig = Buffer.from(
    await webcrypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-384' },
      args.issuerKey,
      tbs as unknown as ArrayBuffer
    )
  );
  const r = rawSig.subarray(0, 48);
  const s = rawSig.subarray(48, 96);
  const derSig = seq(intBytes(r), intBytes(s));
  return seq(tbs, algEcdsaSha384(), bitString(derSig));
}

function pem(der: Buffer): string {
  const b64 = der.toString('base64').replace(/(.{64})/g, '$1\n');
  return `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`;
}

// ===========================================================================
// Minimal CBOR encoder (TEST ONLY) — full enough for the NSM doc + COSE_Sign1
// ===========================================================================

function cborHead(major: number, length: number): Buffer {
  const mt = major << 5;
  if (length < 24) return Buffer.from([mt | length]);
  if (length < 0x100) return Buffer.from([mt | 24, length]);
  if (length < 0x10000) {
    const b = Buffer.alloc(3);
    b[0] = mt | 25;
    b.writeUInt16BE(length, 1);
    return b;
  }
  if (length < 0x100000000) {
    const b = Buffer.alloc(5);
    b[0] = mt | 26;
    b.writeUInt32BE(length, 1);
    return b;
  }
  // 64-bit argument (needed for ms timestamps ~1.78e12).
  const b = Buffer.alloc(9);
  b[0] = mt | 27;
  b.writeBigUInt64BE(BigInt(length), 1);
  return b;
}
function cUint(n: number): Buffer {
  return cborHead(0, n);
}
function cBytes(buf: Buffer): Buffer {
  return Buffer.concat([cborHead(2, buf.length), buf]);
}
function cText(s: string): Buffer {
  const u = Buffer.from(s, 'utf8');
  return Buffer.concat([cborHead(3, u.length), u]);
}
function cArray(items: Buffer[]): Buffer {
  return Buffer.concat([cborHead(4, items.length), ...items]);
}
type CborMapEntry = [Buffer, Buffer];
function cMap(entries: CborMapEntry[]): Buffer {
  return Buffer.concat([cborHead(5, entries.length), ...entries.flat()]);
}

// ===========================================================================
// Synthetic NSM document + COSE_Sign1 builder
// ===========================================================================

const COSE_ALG_ES384 = -35;

function cNegInt(n: number): Buffer {
  // n is the negative integer (e.g. -35). CBOR major 1: value = -1 - argument.
  const arg = -1 - n;
  return cborHead(1, arg);
}

interface DocFields {
  moduleId: string;
  timestamp: number;
  pcrs: Record<number, Buffer>;
  certificate: Buffer; // DER leaf
  cabundle: Buffer[]; // DER intermediates, root-first
  publicKey?: Buffer | null;
  userData?: Buffer | null;
  nonce?: Buffer | null;
}

function buildNsmPayload(fields: DocFields): Buffer {
  const pcrEntries: CborMapEntry[] = Object.entries(fields.pcrs).map(([k, v]) => [
    cUint(Number(k)),
    cBytes(v),
  ]);
  const entries: CborMapEntry[] = [
    [cText('module_id'), cText(fields.moduleId)],
    [cText('timestamp'), cUint(fields.timestamp)],
    [cText('digest'), cText('SHA384')],
    [cText('pcrs'), cMap(pcrEntries)],
    [cText('certificate'), cBytes(fields.certificate)],
    [cText('cabundle'), cArray(fields.cabundle.map((c) => cBytes(c)))],
  ];
  if (fields.publicKey) entries.push([cText('public_key'), cBytes(fields.publicKey)]);
  if (fields.userData) entries.push([cText('user_data'), cBytes(fields.userData)]);
  if (fields.nonce) entries.push([cText('nonce'), cBytes(fields.nonce)]);
  return cMap(entries);
}

interface CoseOptions {
  /** protected-header alg (defaults ES384). */
  protectedAlg?: number;
  /** unprotected-header alg (forged-alg test); not used by verifier. */
  unprotectedAlg?: number;
  /** tamper the payload AFTER signing (signature stays over the original). */
  tamperPayload?: boolean;
}

async function buildCoseSign1(
  payload: Buffer,
  leafKey: CryptoKey,
  options: CoseOptions = {}
): Promise<Buffer> {
  const protMap = cMap([[cUint(1), cNegInt(options.protectedAlg ?? COSE_ALG_ES384)]]);
  const protectedBstr = protMap; // the bstr CONTENT is the encoded map

  const sigStructure = cArray([
    cText('Signature1'),
    cBytes(protectedBstr),
    cBytes(Buffer.alloc(0)),
    cBytes(payload),
  ]);
  const rawSig = Buffer.from(
    await webcrypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-384' },
      leafKey,
      sigStructure as unknown as ArrayBuffer
    )
  );

  const unprotEntries: CborMapEntry[] = [];
  if (typeof options.unprotectedAlg === 'number') {
    unprotEntries.push([cUint(1), cNegInt(options.unprotectedAlg)]);
  }

  let finalPayload = payload;
  if (options.tamperPayload) {
    // Flip a byte deep inside the payload so the signature no longer matches.
    finalPayload = Buffer.from(payload);
    finalPayload[finalPayload.length - 5] ^= 0xff;
  }

  return cArray([cBytes(protectedBstr), cMap(unprotEntries), cBytes(finalPayload), cBytes(rawSig)]);
}

// ===========================================================================
// Fixture context
// ===========================================================================

interface Fixture {
  rootKey: CryptoKeyPair;
  intKey: CryptoKeyPair;
  leafKey: CryptoKeyPair;
  rootDer: Buffer;
  intDer: Buffer;
  leafDer: Buffer;
  testRootPem: string;
  testRootFingerprint: string;
  signerPublicKey: Buffer;
  fulfillmentDigest: Buffer; // the bytes whose sha256 goes into user_data
  userData: Buffer; // sha256(fulfillmentDigest)
  nonce: Buffer;
  now: number;
}

let fx: Fixture;

async function genP384(): Promise<CryptoKeyPair> {
  return webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-384' }, true, [
    'sign',
    'verify',
  ]);
}

beforeAll(async () => {
  const now = Date.now();
  const nb = new Date(now - 3600 * 1000);
  const na = new Date(now + 3600 * 1000);

  const rootKey = await genP384();
  const intKey = await genP384();
  const leafKey = await genP384();

  const rootDer = await makeCert({
    subject: 'TEST Nitro Root',
    issuer: 'TEST Nitro Root',
    subjectKey: rootKey.publicKey,
    issuerKey: rootKey.privateKey,
    serial: 1,
    isCA: true,
    notBefore: nb,
    notAfter: na,
  });
  const intDer = await makeCert({
    subject: 'TEST Nitro Intermediate',
    issuer: 'TEST Nitro Root',
    subjectKey: intKey.publicKey,
    issuerKey: rootKey.privateKey,
    serial: 2,
    isCA: true,
    notBefore: nb,
    notAfter: na,
  });
  const leafDer = await makeCert({
    subject: 'TEST Nitro Leaf',
    issuer: 'TEST Nitro Intermediate',
    subjectKey: leafKey.publicKey,
    issuerKey: intKey.privateKey,
    serial: 3,
    isCA: false,
    notBefore: nb,
    notAfter: na,
  });

  const testRootPem = pem(rootDer);
  const testRootFingerprint = createHash('sha256')
    .update(new X509Certificate(rootDer).raw)
    .digest('hex');

  const signerPublicKey = Buffer.from(
    '03a1b2c3d4e5f6071829303142535465768798a0b1c2d3e4f50617283940515263',
    'hex'
  );
  const fulfillmentDigest = createHash('sha256').update('fulfillment-digest-fixture').digest();
  const userData = createHash('sha256').update(fulfillmentDigest).digest();
  const nonce = Buffer.from('a1a2a3a4a5a6a7a8b1b2b3b4b5b6b7b8', 'hex');

  fx = {
    rootKey,
    intKey,
    leafKey,
    rootDer,
    intDer,
    leafDer,
    testRootPem,
    testRootFingerprint,
    signerPublicKey,
    fulfillmentDigest,
    userData,
    nonce,
    now,
  };
});

afterEach(() => {
  // Restore the production pinned root after any test-only override.
  __setPinnedRootsForTest(null);
});

const PCR0 = Buffer.alloc(48, 0x11);
const PCR1 = Buffer.alloc(48, 0x22);
const PCR2 = Buffer.alloc(48, 0x33);

function baseDocFields(overrides: Partial<DocFields> = {}): DocFields {
  return {
    moduleId: 'i-0abc.enclave-test',
    timestamp: fx.now,
    pcrs: { 0: PCR0, 1: PCR1, 2: PCR2 },
    certificate: fx.leafDer,
    cabundle: [fx.rootDer, fx.intDer], // root-first per AWS convention
    publicKey: fx.signerPublicKey,
    userData: fx.userData,
    nonce: fx.nonce,
    ...overrides,
  };
}

function baseExpected() {
  return {
    expectedPcrs: {
      pcr0: PCR0.toString('hex'),
      pcr1: PCR1.toString('hex'),
      pcr2: PCR2.toString('hex'),
    },
    awsRootPem: fx.testRootPem,
    awsRootFingerprintsSha256: [fx.testRootFingerprint],
    expectedUserDataHex: fx.fulfillmentDigest.toString('hex'),
    expectedSignerPublicKey: fx.signerPublicKey.toString('hex'),
    nonce: fx.nonce.toString('hex'),
    now: fx.now,
  };
}

async function buildValidDocB64(
  fieldOverrides: Partial<DocFields> = {},
  coseOptions: CoseOptions = {}
): Promise<string> {
  const payload = buildNsmPayload(baseDocFields(fieldOverrides));
  const cose = await buildCoseSign1(payload, fx.leafKey.privateKey, coseOptions);
  return cose.toString('base64');
}

// ===========================================================================
// Tests
// ===========================================================================

describe('AWS Nitro production root pin', () => {
  it('declares the published G1 fingerprint', () => {
    expect(AWS_NITRO_ROOT_FINGERPRINTS_SHA256).toContain(
      '641a0321a3e244efe456463195d606317ed7cdcc3c1756e09893f3c68f79bb5b'
    );
  });

  it("the inlined root constant's DER SHA-256 matches the published G1 fingerprint", () => {
    const cert = new X509Certificate(AWS_NITRO_ROOT_G1_PEM);
    const fp = createHash('sha256').update(cert.raw).digest('hex');
    expect(fp).toBe('641a0321a3e244efe456463195d606317ed7cdcc3c1756e09893f3c68f79bb5b');
    expect(AWS_NITRO_ROOT_FINGERPRINTS_SHA256).toContain(fp);
  });

  it('the committed aws-nitro-root.pem and the inlined constant are the SAME certificate', () => {
    // Guards against the file and the inlined constant drifting apart.
    const pemPath = fileURLToPath(new URL('./attestation/aws-nitro-root.pem', import.meta.url));
    const fileCert = new X509Certificate(readFileSync(pemPath, 'utf8'));
    const inlineCert = new X509Certificate(AWS_NITRO_ROOT_G1_PEM);
    expect(Buffer.from(fileCert.raw).toString('hex')).toBe(
      Buffer.from(inlineCert.raw).toString('hex')
    );
  });
});

describe('verifyNitroAttestationDocument — happy path (synthetic, test root pinned)', () => {
  it('verifies a valid document end-to-end', async () => {
    const b64 = await buildValidDocB64();
    const result = await verifyNitroAttestationDocument(b64, baseExpected());

    expect(result.errors).toEqual([]);
    expect(result.cose_signature_ok).toBe(true);
    expect(result.cert_chain_ok).toBe(true);
    expect(result.root_pinned_ok).toBe(true);
    expect(result.pcr0_match).toBe(true);
    expect(result.pcr1_match).toBe(true);
    expect(result.pcr2_match).toBe(true);
    expect(result.user_data_bound_ok).toBe(true);
    expect(result.public_key_bound_ok).toBe(true);
    expect(result.nonce_match).toBe(true);
    expect(result.timestamp_fresh).toBe(true);
    expect(result.measurement_chain_verified).toBe(true);
  });

  it('decodes the document fields (diagnostics helper)', async () => {
    const b64 = await buildValidDocB64();
    const doc = decodeNitroAttestationDocument(b64);
    expect(doc.digest).toBe('SHA384');
    expect(doc.module_id).toBe('i-0abc.enclave-test');
    expect(doc.pcrs.get(0)?.toString('hex')).toBe(PCR0.toString('hex'));
    expect(doc.public_key?.toString('hex')).toBe(fx.signerPublicKey.toString('hex'));
  });
});

describe('verifyNitroAttestationDocument — adversarial vectors (all must be REJECTED)', () => {
  it('rejects a tampered payload (cose_signature_ok=false)', async () => {
    const b64 = await buildValidDocB64({}, { tamperPayload: true });
    const result = await verifyNitroAttestationDocument(b64, baseExpected());
    expect(result.cose_signature_ok).toBe(false);
    expect(result.measurement_chain_verified).toBe(false);
  });

  it('rejects a wrong / self-signed root (root_pinned_ok=false)', async () => {
    // Build a doc chained to a DIFFERENT (attacker) root, but pin the real test root.
    const evilRoot = await genP384();
    const evilLeaf = await genP384();
    const nb = new Date(fx.now - 3600e3);
    const na = new Date(fx.now + 3600e3);
    const evilRootDer = await makeCert({
      subject: 'EVIL Root',
      issuer: 'EVIL Root',
      subjectKey: evilRoot.publicKey,
      issuerKey: evilRoot.privateKey,
      serial: 9,
      isCA: true,
      notBefore: nb,
      notAfter: na,
    });
    const evilLeafDer = await makeCert({
      subject: 'EVIL Leaf',
      issuer: 'EVIL Root',
      subjectKey: evilLeaf.publicKey,
      issuerKey: evilRoot.privateKey,
      serial: 10,
      isCA: false,
      notBefore: nb,
      notAfter: na,
    });
    const payload = buildNsmPayload(
      baseDocFields({ certificate: evilLeafDer, cabundle: [evilRootDer] })
    );
    const cose = await buildCoseSign1(payload, evilLeaf.privateKey);
    const result = await verifyNitroAttestationDocument(cose.toString('base64'), baseExpected());

    expect(result.root_pinned_ok).toBe(false);
    expect(result.cert_chain_ok).toBe(false);
    expect(result.measurement_chain_verified).toBe(false);
  });

  it('rejects a self-signed leaf masquerading as root with no chain', async () => {
    // A lone self-signed cert (leaf == its own issuer) that is NOT a pinned root.
    const selfKey = await genP384();
    const nb = new Date(fx.now - 3600e3);
    const na = new Date(fx.now + 3600e3);
    const selfDer = await makeCert({
      subject: 'SELF Signed',
      issuer: 'SELF Signed',
      subjectKey: selfKey.publicKey,
      issuerKey: selfKey.privateKey,
      serial: 11,
      isCA: true,
      notBefore: nb,
      notAfter: na,
    });
    const payload = buildNsmPayload(baseDocFields({ certificate: selfDer, cabundle: [] }));
    const cose = await buildCoseSign1(payload, selfKey.privateKey);
    const result = await verifyNitroAttestationDocument(cose.toString('base64'), baseExpected());

    expect(result.root_pinned_ok).toBe(false);
    expect(result.cert_chain_ok).toBe(false);
    expect(result.measurement_chain_verified).toBe(false);
  });

  it('rejects a mismatched PCR0 (pcr0_match=false)', async () => {
    const b64 = await buildValidDocB64({
      pcrs: { 0: Buffer.alloc(48, 0xaa), 1: PCR1, 2: PCR2 },
    });
    const result = await verifyNitroAttestationDocument(b64, baseExpected());
    expect(result.pcr0_match).toBe(false);
    expect(result.pcr1_match).toBe(true);
    expect(result.measurement_chain_verified).toBe(false);
  });

  it('rejects an expired leaf cert (cert_chain_ok=false)', async () => {
    const expiredLeaf = await genP384();
    const past = new Date(fx.now - 2 * 24 * 3600e3);
    const alsoPast = new Date(fx.now - 1 * 24 * 3600e3); // notAfter still in the past
    const expiredLeafDer = await makeCert({
      subject: 'EXPIRED Leaf',
      issuer: 'TEST Nitro Intermediate',
      subjectKey: expiredLeaf.publicKey,
      issuerKey: fx.intKey.privateKey,
      serial: 12,
      isCA: false,
      notBefore: past,
      notAfter: alsoPast,
    });
    const payload = buildNsmPayload(
      baseDocFields({ certificate: expiredLeafDer, cabundle: [fx.rootDer, fx.intDer] })
    );
    const cose = await buildCoseSign1(payload, expiredLeaf.privateKey);
    const result = await verifyNitroAttestationDocument(cose.toString('base64'), baseExpected());

    expect(result.cert_chain_ok).toBe(false);
    expect(result.errors.some((e) => /not valid at doc timestamp/.test(e))).toBe(true);
    expect(result.measurement_chain_verified).toBe(false);
  });

  it('rejects a replayed/wrong nonce (nonce_match=false)', async () => {
    const b64 = await buildValidDocB64();
    const result = await verifyNitroAttestationDocument(b64, {
      ...baseExpected(),
      nonce: 'deadbeefdeadbeefdeadbeefdeadbeef', // caller expects a different (fresh) nonce
    });
    expect(result.nonce_match).toBe(false);
    expect(result.measurement_chain_verified).toBe(false);
  });

  it('rejects a zeroed/empty document nonce against a real caller nonce', async () => {
    // Document carries no nonce; caller supplies one => must not match.
    const b64 = await buildValidDocB64({ nonce: null });
    const result = await verifyNitroAttestationDocument(b64, baseExpected());
    expect(result.nonce_match).toBe(false);
    expect(result.measurement_chain_verified).toBe(false);
  });

  it('rejects a forged alg in the UNPROTECTED header (alg taken from protected only)', async () => {
    // Protected header says ES384 and the signature is real ES384, but the
    // unprotected header lies with a different alg. The verifier must IGNORE the
    // unprotected alg and still verify against the protected ES384 — i.e. this
    // particular doc still verifies (proving we read the right header).
    const b64 = await buildValidDocB64({}, { unprotectedAlg: -7 /* ES256 lie */ });
    const result = await verifyNitroAttestationDocument(b64, baseExpected());
    expect(result.cose_signature_ok).toBe(true);
    expect(result.measurement_chain_verified).toBe(true);
  });

  it('rejects a wrong alg in the PROTECTED header (must be ES384/-35)', async () => {
    // Protected header claims ES256 (-7); verifier must refuse rather than
    // attempt a P-256 verify on a P-384 signature.
    const b64 = await buildValidDocB64({}, { protectedAlg: -7 });
    const result = await verifyNitroAttestationDocument(b64, baseExpected());
    expect(result.cose_signature_ok).toBe(false);
    expect(result.errors.some((e) => /COSE alg/.test(e))).toBe(true);
    expect(result.measurement_chain_verified).toBe(false);
  });

  it('rejects a user_data mismatch (user_data_bound_ok=false)', async () => {
    const wrongUserData = createHash('sha256').update('a-different-digest').digest();
    const b64 = await buildValidDocB64({ userData: wrongUserData });
    const result = await verifyNitroAttestationDocument(b64, baseExpected());
    expect(result.user_data_bound_ok).toBe(false);
    expect(result.measurement_chain_verified).toBe(false);
  });

  it('rejects a public_key mismatch (public_key_bound_ok=false)', async () => {
    const wrongPk = Buffer.alloc(33, 0x02);
    const b64 = await buildValidDocB64({ publicKey: wrongPk });
    const result = await verifyNitroAttestationDocument(b64, baseExpected());
    expect(result.public_key_bound_ok).toBe(false);
    expect(result.measurement_chain_verified).toBe(false);
  });

  it('rejects a stale timestamp (timestamp_fresh=false)', async () => {
    const stale = fx.now - 48 * 3600 * 1000; // 48h old, beyond default 12h max age
    // Rebuild the chain with validity windows that COVER the stale timestamp so
    // ONLY freshness fails (isolating the timestamp_fresh check).
    const leaf = await genP384();
    const nb = new Date(stale - 3600e3);
    const na = new Date(fx.now + 3600e3);
    const intDer = await makeCert({
      subject: 'TEST Nitro Intermediate',
      issuer: 'TEST Nitro Root',
      subjectKey: fx.intKey.publicKey,
      issuerKey: fx.rootKey.privateKey,
      serial: 20,
      isCA: true,
      notBefore: nb,
      notAfter: na,
    });
    const rootDer = await makeCert({
      subject: 'TEST Nitro Root',
      issuer: 'TEST Nitro Root',
      subjectKey: fx.rootKey.publicKey,
      issuerKey: fx.rootKey.privateKey,
      serial: 21,
      isCA: true,
      notBefore: nb,
      notAfter: na,
    });
    const leafDer = await makeCert({
      subject: 'TEST Nitro Leaf',
      issuer: 'TEST Nitro Intermediate',
      subjectKey: leaf.publicKey,
      issuerKey: fx.intKey.privateKey,
      serial: 22,
      isCA: false,
      notBefore: nb,
      notAfter: na,
    });
    const rootFp = createHash('sha256').update(new X509Certificate(rootDer).raw).digest('hex');
    const payload = buildNsmPayload(
      baseDocFields({ timestamp: stale, certificate: leafDer, cabundle: [rootDer, intDer] })
    );
    const cose = await buildCoseSign1(payload, leaf.privateKey);
    const result = await verifyNitroAttestationDocument(cose.toString('base64'), {
      ...baseExpected(),
      awsRootPem: pem(rootDer),
      awsRootFingerprintsSha256: [rootFp],
    });
    expect(result.timestamp_fresh).toBe(false);
    expect(result.measurement_chain_verified).toBe(false);
  });

  it('rejects a non-CA intermediate issuer (basicConstraints CA:FALSE)', async () => {
    // Intermediate is issued by the root but is NOT a CA — it must not be
    // accepted as an issuer of the leaf.
    const badInt = await genP384();
    const leaf = await genP384();
    const nb = new Date(fx.now - 3600e3);
    const na = new Date(fx.now + 3600e3);
    const badIntDer = await makeCert({
      subject: 'NON-CA Intermediate',
      issuer: 'TEST Nitro Root',
      subjectKey: badInt.publicKey,
      issuerKey: fx.rootKey.privateKey,
      serial: 30,
      isCA: false, // <-- not a CA
      notBefore: nb,
      notAfter: na,
    });
    const leafDer = await makeCert({
      subject: 'TEST Nitro Leaf',
      issuer: 'NON-CA Intermediate',
      subjectKey: leaf.publicKey,
      issuerKey: badInt.privateKey,
      serial: 31,
      isCA: false,
      notBefore: nb,
      notAfter: na,
    });
    const payload = buildNsmPayload(
      baseDocFields({ certificate: leafDer, cabundle: [fx.rootDer, badIntDer] })
    );
    const cose = await buildCoseSign1(payload, leaf.privateKey);
    const result = await verifyNitroAttestationDocument(cose.toString('base64'), baseExpected());

    expect(result.cert_chain_ok).toBe(false);
    expect(result.errors.some((e) => /is not a CA/.test(e))).toBe(true);
    expect(result.measurement_chain_verified).toBe(false);
  });

  it('rejects garbage / non-CBOR input gracefully', async () => {
    const result = await verifyNitroAttestationDocument('not-base64-or-cbor!!!', baseExpected());
    expect(result.measurement_chain_verified).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('rejects an empty document', async () => {
    const result = await verifyNitroAttestationDocument('', baseExpected());
    expect(result.measurement_chain_verified).toBe(false);
  });

  it('denies measurement_chain_verified when expected PCRs are not supplied', async () => {
    // Even a structurally perfect doc must NOT be measurement-verified without
    // a pinned PCR manifest to compare against.
    const b64 = await buildValidDocB64();
    const result = await verifyNitroAttestationDocument(b64, {
      ...baseExpected(),
      expectedPcrs: {},
    });
    expect(result.cose_signature_ok).toBe(true);
    expect(result.cert_chain_ok).toBe(true);
    expect(result.pcr0_match).toBe(false);
    expect(result.measurement_chain_verified).toBe(false);
  });

  it('rejects a synthetic doc against the PRODUCTION pinned root (no test override)', async () => {
    // Same synthetic doc, but verified WITHOUT awsRootPem -> the real AWS Nitro
    // root is the anchor, which the synthetic chain can never terminate at.
    const b64 = await buildValidDocB64();
    const { awsRootPem: _omitRoot, awsRootFingerprintsSha256: _omitFp, ...rest } = baseExpected();
    const result = await verifyNitroAttestationDocument(b64, rest);
    expect(result.root_pinned_ok).toBe(false);
    expect(result.measurement_chain_verified).toBe(false);
  });
});

// ===========================================================================
// Route integration: the /api/attestation/verify + /measurements handlers
// ===========================================================================

describe('attestation route integration', () => {
  it('verify route: no document -> legacy binding holds but measurement chain is NOT verified', async () => {
    const { POST } = await import('@/app/api/attestation/verify/route');
    const outputHash = createHash('sha256').update('result-x').digest('hex');
    const body = {
      verification: {
        output_hash: `0x${outputHash}`,
        attestation_hash: `0x${outputHash}`,
      },
      attestation: { output_hash: `0x${outputHash}`, quote: 'present', event_log: [] },
      expected_output_hash: outputHash,
    };
    const res = await POST(
      new Request('http://x/api/attestation/verify', {
        method: 'POST',
        body: JSON.stringify(body),
      })
    );
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.binding_ok).toBe(true);
    expect(json.binding_consistent).toBe(true);
    expect(json.ok).toBe(false);
    expect(res.status).toBe(400);
    // Legacy presence-only no longer flips these; without a verified Nitro doc:
    expect(json.full_attestation_ok).toBe(false);
    expect(json.measurement_chain_verified).toBe(false);
    expect(json.nitro_attestation).toBeNull();
  });

  it('verify route: malformed attestation_document -> measurement chain denied', async () => {
    const { POST } = await import('@/app/api/attestation/verify/route');
    const body = {
      verification: { output_hash: '0x' + 'ab'.repeat(32) },
      attestation_document: 'this-is-not-a-valid-cose-document',
    };
    const res = await POST(
      new Request('http://x/api/attestation/verify', {
        method: 'POST',
        body: JSON.stringify(body),
      })
    );
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.measurement_chain_verified).toBe(false);
    const nitro = json.nitro_attestation as Record<string, unknown> | null;
    expect(nitro).not.toBeNull();
    expect(nitro?.measurement_chain_verified).toBe(false);
    expect((nitro?.errors as unknown[]).length).toBeGreaterThan(0);
  });

  it('verify route: caller-supplied PCRs cannot replace the committed pin', async () => {
    const { POST } = await import('@/app/api/attestation/verify/route');
    const res = await POST(
      new Request('http://x/api/attestation/verify', {
        method: 'POST',
        body: JSON.stringify({
          verification: { output_hash: '0x' + 'ab'.repeat(32) },
          expected_pcr0: 'aa'.repeat(48),
          expected_pcr1: 'bb'.repeat(48),
          expected_pcr2: 'cc'.repeat(48),
        }),
      })
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error_code: 'PCR_PIN_MISMATCH' });
  });

  it('verify route: oversized request bodies are rejected before parsing', async () => {
    const { POST } = await import('@/app/api/attestation/verify/route');
    const res = await POST(
      new Request('http://x/api/attestation/verify', {
        method: 'POST',
        body: JSON.stringify({ padding: 'x'.repeat(300 * 1024) }),
      })
    );
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error_code: 'PAYLOAD_TOO_LARGE' });
  });

  it('measurements route: serves the pinned root fingerprint (manifest list may be empty pre-Phase-1)', async () => {
    const { GET } = await import('@/app/api/attestation/measurements/route');
    const res = await GET(new Request('http://x/api/attestation/measurements'));
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(json.hash_algorithm).toBe('SHA384');
    expect(json.pinned_root_fingerprints_sha256).toContain(
      '641a0321a3e244efe456463195d606317ed7cdcc3c1756e09893f3c68f79bb5b'
    );
    expect(Array.isArray(json.measurements)).toBe(true);
  });
});

// ===========================================================================
// SVC-A-2: a GENUINE attestation document must not verify an envelope it was
// never issued for. The document below is real in every cryptographic sense —
// correct COSE signature, chain to the pinned test root, the pinned production
// PCRs, a fresh timestamp. The only thing wrong with it is that it belongs to
// a DIFFERENT result. Before the fix the route asked for no binding at all, so
// it happily reported full_attestation_ok over a harvested document.
// ===========================================================================

describe('attestation route — harvested-document replay (SVC-A-2)', () => {
  const PINNED_PCRS = {
    0: Buffer.from(ACTIVE_NITRO_MEASUREMENT.pcr0, 'hex'),
    1: Buffer.from(ACTIVE_NITRO_MEASUREMENT.pcr1, 'hex'),
    2: Buffer.from(ACTIVE_NITRO_MEASUREMENT.pcr2, 'hex'),
  };

  /** The enclave commits `output_hash` into the NSM document's nonce field. */
  async function genuineLaneDocument(outputHashHex: string): Promise<string> {
    return buildValidDocB64({
      pcrs: PINNED_PCRS,
      userData: undefined,
      nonce: Buffer.from(outputHashHex, 'hex'),
    });
  }

  function laneEnvelope(outputHashHex: string, documentB64: string) {
    return {
      verification: {
        output_hash: `0x${outputHashHex}`,
        attestation_hash: `0x${outputHashHex}`,
        tee_attestation: {
          runtime: 'aws-nitro',
          report_data: `0x${outputHashHex}`,
          quote: 'present',
          event_log: [],
        },
      },
      attestation_document: documentB64,
    };
  }

  async function postVerify(body: unknown) {
    const { POST } = await import('@/app/api/attestation/verify/route');
    __setPinnedRootsForTest(fx.testRootPem, [fx.testRootFingerprint]);
    const res = await POST(
      new Request('http://x/api/attestation/verify', {
        method: 'POST',
        body: JSON.stringify(body),
      })
    );
    return { res, json: (await res.json()) as Record<string, unknown> };
  }

  it('rejects a genuine document replayed onto an attacker-authored result', async () => {
    const harvestedHash = createHash('sha256').update('the-result-the-enclave-ran').digest('hex');
    const forgedHash = createHash('sha256').update('the-result-the-attacker-wants').digest('hex');
    const harvestedDocument = await genuineLaneDocument(harvestedHash);

    const { res, json } = await postVerify({
      ...laneEnvelope(forgedHash, harvestedDocument),
      expected_output_hash: forgedHash,
    });

    // The document itself is genuine: signature, chain, PCRs all check out.
    const nitro = json.nitro_attestation as Record<string, unknown>;
    expect(nitro.cose_signature_ok).toBe(true);
    expect(nitro.root_pinned_ok).toBe(true);
    expect(nitro.pcr0_match).toBe(true);
    // ...but it is not bound to the result being verified.
    expect(nitro.nonce_match).toBe(false);
    expect(json.result_binding_source).toBe('report_data');
    expect(json.result_binding_verified).toBe(false);
    expect(json.measurement_chain_verified).toBe(false);
    expect(json.full_attestation_ok).toBe(false);
    expect(json.ok).toBe(false);
    expect(String(json.attestation_scope)).not.toContain('result binding');
    expect(res.status).toBe(400);
  });

  it('accepts the same document over the result it was actually issued for', async () => {
    const outputHash = createHash('sha256').update('the-result-the-enclave-ran').digest('hex');
    const document = await genuineLaneDocument(outputHash);

    const { res, json } = await postVerify({
      ...laneEnvelope(outputHash, document),
      expected_output_hash: outputHash,
    });

    expect(json.result_binding_source).toBe('report_data');
    expect(json.result_binding_verified).toBe(true);
    expect(json.measurement_chain_verified).toBe(true);
    expect(json.full_attestation_ok).toBe(true);
    expect(String(json.attestation_scope)).toContain('result binding');
    expect(res.status).toBe(200);
  });

  it('denies the trust decision when the envelope carries no binding at all', async () => {
    const outputHash = createHash('sha256').update('unbound-case').digest('hex');
    // A verified document with NO report_data/fulfillment digest to tie it to
    // the envelope: the chain verifies, the result claim does not.
    const document = await buildValidDocB64({
      pcrs: PINNED_PCRS,
      userData: undefined,
      nonce: undefined,
    });

    const { res, json } = await postVerify({
      verification: { output_hash: `0x${outputHash}`, attestation_hash: `0x${outputHash}` },
      attestation_document: document,
      expected_output_hash: outputHash,
    });

    const nitro = json.nitro_attestation as Record<string, unknown>;
    expect(nitro.measurement_chain_verified).toBe(true);
    expect(json.result_binding_source).toBe('none');
    expect(json.result_binding_checked).toBe(false);
    expect(json.nitro_chain_verified).toBe(true);
    expect(json.result_binding_verified).toBe(false);
    expect(json.measurement_chain_verified).toBe(false);
    expect(json.full_attestation_ok).toBe(false);
    expect(String(json.attestation_scope)).toContain('NOT bound to this result');
    expect(res.status).toBe(400);
  });

  it('a caller-supplied expected_user_data_hex cannot manufacture a result binding', async () => {
    const outputHash = createHash('sha256').update('caller-forged-binding').digest('hex');
    const preimage = createHash('sha256').update('attacker-chosen-digest').digest();
    const document = await buildValidDocB64({
      pcrs: PINNED_PCRS,
      userData: createHash('sha256').update(preimage).digest(),
      nonce: undefined,
    });

    // The caller asks for exactly the binding the document happens to satisfy.
    const { res, json } = await postVerify({
      verification: { output_hash: `0x${outputHash}`, attestation_hash: `0x${outputHash}` },
      attestation_document: document,
      expected_output_hash: outputHash,
      expected_user_data_hex: preimage.toString('hex'),
    });

    const nitro = json.nitro_attestation as Record<string, unknown>;
    expect(nitro.user_data_bound_ok).toBe(true);
    expect(nitro.measurement_chain_verified).toBe(true);
    // The envelope never claimed that digest, so it is not a RESULT binding.
    expect(json.result_binding_source).toBe('none');
    expect(json.result_binding_verified).toBe(false);
    expect(json.full_attestation_ok).toBe(false);
    expect(res.status).toBe(400);
  });

  it('a caller-supplied nonce that contradicts the envelope is a hard 400', async () => {
    const outputHash = createHash('sha256').update('conflicting-binding').digest('hex');
    const document = await genuineLaneDocument(outputHash);
    const { res, json } = await postVerify({
      ...laneEnvelope(outputHash, document),
      expected_output_hash: outputHash,
      nonce: 'dd'.repeat(32),
    });
    expect(res.status).toBe(400);
    expect(json.error_code).toBe('BINDING_CONFLICT');
  });

  it('a fulfil-shaped envelope checks its digest but is never called a result binding', async () => {
    const digest = createHash('sha256').update('fulfilment-digest').digest();
    const outputHash = createHash('sha256').update('fulfil-result').digest('hex');
    const document = await buildValidDocB64({
      pcrs: PINNED_PCRS,
      userData: createHash('sha256').update(digest).digest(),
      nonce: undefined,
    });

    const ok = await postVerify({
      envelope: {
        fulfillment_digest_hex: digest.toString('hex'),
        verification: { output_hash: `0x${outputHash}`, attestation_hash: `0x${outputHash}` },
        attestation_doc_base64: document,
      },
      expected_output_hash: outputHash,
    });
    expect(ok.json.result_binding_source).toBe('fulfillment_digest');
    expect((ok.json.nitro_attestation as Record<string, unknown>).user_data_bound_ok).toBe(true);
    // The verifier cannot recompute the digest from the result, so it refuses
    // to call this a verified result binding.
    expect(ok.json.result_binding_verified).toBe(false);
    expect(ok.json.full_attestation_ok).toBe(false);

    // And a digest the document does not commit to fails outright.
    const tampered = await postVerify({
      envelope: {
        fulfillment_digest_hex: 'ab'.repeat(32),
        verification: { output_hash: `0x${outputHash}`, attestation_hash: `0x${outputHash}` },
        attestation_doc_base64: document,
      },
      expected_output_hash: outputHash,
    });
    expect((tampered.json.nitro_attestation as Record<string, unknown>).user_data_bound_ok).toBe(
      false
    );
    expect(tampered.json.full_attestation_ok).toBe(false);
  });
});

describe('CBOR decoder — indefinite-length (real AWS NSM docs use it)', () => {
  const { CborDecoder } = __internals;
  const B = (...n: number[]) => Buffer.from(n);

  it('decodes an indefinite-length map (0xbf … 0xff)', () => {
    // { "a": 1, "b": [2, 3] } with the map AND the array indefinite-length
    const buf = B(0xbf, 0x61, 0x61, 0x01, 0x61, 0x62, 0x9f, 0x02, 0x03, 0xff, 0xff);
    const m = CborDecoder.decodeFirst(buf) as Map<unknown, unknown>;
    expect(m.get('a')).toBe(1);
    expect(m.get('b')).toEqual([2, 3]);
  });

  it('decodes an indefinite-length byte string (chunked, 0x5f … 0xff)', () => {
    // 0x5f [42 0102] [43 030405] ff  -> bytes 01 02 03 04 05
    const buf = B(0x5f, 0x42, 0x01, 0x02, 0x43, 0x03, 0x04, 0x05, 0xff);
    const out = CborDecoder.decodeFirst(buf) as Buffer;
    expect(Buffer.isBuffer(out)).toBe(true);
    expect(out.equals(B(0x01, 0x02, 0x03, 0x04, 0x05))).toBe(true);
  });

  it('decodes the NSM doc shape: indefinite pcrs map of byte strings', () => {
    // { 0: h'AA…(48)', 1: h'BB…(48)' } as an indefinite map of definite bstrs
    const pcr0 = Buffer.alloc(48, 0xaa);
    const pcr1 = Buffer.alloc(48, 0xbb);
    const buf = Buffer.concat([
      B(0xbf),
      B(0x00),
      B(0x58, 48),
      pcr0,
      B(0x01),
      B(0x58, 48),
      pcr1,
      B(0xff),
    ]);
    const m = CborDecoder.decodeFirst(buf) as Map<unknown, unknown>;
    expect((m.get(0) as Buffer).equals(pcr0)).toBe(true);
    expect((m.get(1) as Buffer).equals(pcr1)).toBe(true);
  });

  it('still decodes definite-length maps/arrays (no regression)', () => {
    // {1: -35} definite (COSE protected header shape)
    const m = CborDecoder.decodeFirst(B(0xa1, 0x01, 0x38, 0x22)) as Map<unknown, unknown>;
    expect(m.get(1)).toBe(-35);
    expect(CborDecoder.decodeFirst(B(0x83, 0x01, 0x02, 0x03))).toEqual([1, 2, 3]);
  });
});
