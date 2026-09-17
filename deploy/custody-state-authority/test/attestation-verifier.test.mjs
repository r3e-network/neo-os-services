import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, webcrypto, X509Certificate } from 'node:crypto';
import { test } from 'node:test';
import { SignedAttestation } from '@0xsequence/tee-verifier';
import { encode as encodeCbor } from 'cbor2';
import { verifyNitroAttestation } from '../src/attestation.mjs';

const NOW_MS = Date.UTC(2026, 8, 11, 8, 0, 0);
const PCRS = Object.freeze({
  pcr0: '11'.repeat(48),
  pcr1: '22'.repeat(48),
  pcr2: '33'.repeat(48),
});
const NONCE = Buffer.from('44'.repeat(32), 'hex');
const USER_DATA = Buffer.from('55'.repeat(32), 'hex');

function cborBytes(value) {
  return Uint8Array.from(value);
}

function derLength(value) {
  if (value < 0x80) return Buffer.from([value]);
  const bytes = [];
  for (let remaining = value; remaining > 0; remaining = Math.floor(remaining / 256)) {
    bytes.unshift(remaining & 0xff);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function der(tag, content) {
  return Buffer.concat([Buffer.from([tag]), derLength(content.length), content]);
}

function sequence(...items) {
  return der(0x30, Buffer.concat(items));
}

function set(...items) {
  return der(0x31, Buffer.concat(items));
}

function integer(value) {
  let bytes = [];
  for (let remaining = value; remaining > 0; remaining = Math.floor(remaining / 256)) {
    bytes.unshift(remaining & 0xff);
  }
  if (bytes.length === 0) bytes = [0];
  if (bytes[0] & 0x80) bytes.unshift(0);
  return der(0x02, Buffer.from(bytes));
}

function integerBytes(value) {
  let bytes = Buffer.from(value);
  while (bytes.length > 1 && bytes[0] === 0) bytes = bytes.subarray(1);
  if (bytes[0] & 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes]);
  return der(0x02, bytes);
}

function oid(value) {
  const parts = value.split('.').map(Number);
  const bytes = [parts[0] * 40 + parts[1]];
  for (const part of parts.slice(2)) {
    const encoded = [part & 0x7f];
    for (let remaining = part >> 7; remaining > 0; remaining >>= 7) {
      encoded.unshift((remaining & 0x7f) | 0x80);
    }
    bytes.push(...encoded);
  }
  return der(0x06, Buffer.from(bytes));
}

function utf8(value) {
  return der(0x0c, Buffer.from(value, 'utf8'));
}

function bitString(value) {
  return der(0x03, Buffer.concat([Buffer.from([0]), value]));
}

function octetString(value) {
  return der(0x04, value);
}

function boolean(value) {
  return der(0x01, Buffer.from([value ? 0xff : 0]));
}

function utcTime(value) {
  const encoded = value.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z';
  return der(0x17, Buffer.from(encoded, 'ascii'));
}

const OIDS = Object.freeze({
  commonName: '2.5.4.3',
  ecPublicKey: '1.2.840.10045.2.1',
  p384: '1.3.132.0.34',
  ecdsaSha384: '1.2.840.10045.4.3.3',
  basicConstraints: '2.5.29.19',
  keyUsage: '2.5.29.15',
});

function name(commonName) {
  return sequence(set(sequence(oid(OIDS.commonName), utf8(commonName))));
}

function signatureAlgorithm() {
  return sequence(oid(OIDS.ecdsaSha384));
}

function extension(extensionOid, critical, value) {
  return sequence(oid(extensionOid), ...(critical ? [boolean(true)] : []), octetString(value));
}

async function rawEcPublicKey(key) {
  const jwk = await webcrypto.subtle.exportKey('jwk', key);
  return Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(jwk.x, 'base64url'),
    Buffer.from(jwk.y, 'base64url'),
  ]);
}

async function makeCertificate({ subject, issuer, subjectKey, issuerKey, serial, isCa }) {
  const subjectPublicKey = await rawEcPublicKey(subjectKey);
  const extensions = [
    extension(OIDS.basicConstraints, true, sequence(boolean(isCa))),
    extension(OIDS.keyUsage, true, bitString(Buffer.from([isCa ? 0x06 : 0x80]))),
  ];
  const tbs = sequence(
    der(0xa0, integer(2)),
    integer(serial),
    signatureAlgorithm(),
    name(issuer),
    sequence(
      utcTime(new Date(NOW_MS - 60 * 60 * 1000)),
      utcTime(new Date(NOW_MS + 60 * 60 * 1000))
    ),
    name(subject),
    sequence(sequence(oid(OIDS.ecPublicKey), oid(OIDS.p384)), bitString(subjectPublicKey)),
    der(0xa3, sequence(...extensions))
  );
  const signature = Buffer.from(
    await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-384' }, issuerKey, tbs)
  );
  return sequence(
    tbs,
    signatureAlgorithm(),
    bitString(
      sequence(integerBytes(signature.subarray(0, 48)), integerBytes(signature.subarray(48)))
    )
  );
}

async function generateFixture() {
  const rootKeys = await webcrypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-384' },
    true,
    ['sign', 'verify']
  );
  const leafKeys = await webcrypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-384' },
    true,
    ['sign', 'verify']
  );
  const intermediateKeys = await webcrypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-384' },
    true,
    ['sign', 'verify']
  );
  const rootDer = await makeCertificate({
    subject: 'Generated Nitro Test Root',
    issuer: 'Generated Nitro Test Root',
    subjectKey: rootKeys.publicKey,
    issuerKey: rootKeys.privateKey,
    serial: 1,
    isCa: true,
  });
  const intermediateDer = await makeCertificate({
    subject: 'Generated Nitro Test Intermediate',
    issuer: 'Generated Nitro Test Root',
    subjectKey: intermediateKeys.publicKey,
    issuerKey: rootKeys.privateKey,
    serial: 2,
    isCa: true,
  });
  const leafDer = await makeCertificate({
    subject: 'Generated Nitro Test Leaf',
    issuer: 'Generated Nitro Test Intermediate',
    subjectKey: leafKeys.publicKey,
    issuerKey: intermediateKeys.privateKey,
    serial: 3,
    isCa: false,
  });
  const { publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 3072,
    publicExponent: 0x10001,
  });
  return {
    rootDer,
    intermediateDer,
    leafDer,
    leafPrivateKey: leafKeys.privateKey,
    sessionPublicKeyDer: publicKey.export({ format: 'der', type: 'spki' }),
  };
}

const fixture = await generateFixture();

function expected(overrides = {}) {
  return {
    nonceHex: NONCE.toString('hex'),
    userDataHex: USER_DATA.toString('hex'),
    pcrs: PCRS,
    ...overrides,
  };
}

async function buildDocument({
  timestamp = NOW_MS,
  pcrs = PCRS,
  nonce = NONCE,
  userData = USER_DATA,
  publicKey = fixture.sessionPublicKeyDer,
  protectedAlgorithm = -35,
  mutateSignature = false,
} = {}) {
  const protectedHeader = encodeCbor(new Map([[1, protectedAlgorithm]]));
  const payload = encodeCbor(
    new Map([
      ['module_id', 'i-test.enc-generated'],
      ['timestamp', timestamp],
      ['digest', 'SHA384'],
      [
        'pcrs',
        new Map([
          [0, cborBytes(Buffer.from(pcrs.pcr0, 'hex'))],
          [1, cborBytes(Buffer.from(pcrs.pcr1, 'hex'))],
          [2, cborBytes(Buffer.from(pcrs.pcr2, 'hex'))],
        ]),
      ],
      ['certificate', cborBytes(fixture.leafDer)],
      ['cabundle', [cborBytes(fixture.rootDer), cborBytes(fixture.intermediateDer)]],
      ['public_key', cborBytes(publicKey)],
      ['user_data', cborBytes(userData)],
      ['nonce', cborBytes(nonce)],
    ])
  );
  const signatureStructure = encodeCbor(['Signature1', protectedHeader, new Uint8Array(), payload]);
  const signature = new Uint8Array(
    await webcrypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-384' },
      fixture.leafPrivateKey,
      signatureStructure
    )
  );
  if (mutateSignature) signature[0] ^= 0x80;
  return Buffer.from(encodeCbor([protectedHeader, new Map(), payload, signature])).toString(
    'base64'
  );
}

async function verify(document, overrides = {}) {
  return verifyNitroAttestation({
    attestationDocument: document,
    expected: expected(),
    nowMs: NOW_MS,
    ...overrides,
  });
}

async function assertRejected(document, pattern, overrides) {
  const result = await verify(document, overrides);
  assert.equal(result.verified, false);
  assert.equal(result.statusCode, 403);
  assert.equal(result.code, 'nitro_attestation_rejected');
  assert.match(result.message, pattern);
}

test('generated fixture has a valid certificate path and COSE ES384 signature', async () => {
  const document = await buildDocument();
  const attestation = SignedAttestation.fromDocument(document);
  assert.equal(await attestation.verifyRootOfTrust(new Date(NOW_MS)), true);
  assert.equal(await attestation.verifySignature(), true);
  assert.equal(new X509Certificate(fixture.rootDer).ca, true);
});

test('production verifier rejects a generated chain that is not rooted at AWS G1', async () => {
  await assertRejected(await buildDocument(), /not anchored by the pinned AWS Nitro root G1/);
});

test('rejects noncanonical base64 before parsing CBOR', async () => {
  const document = await buildDocument();
  await assertRejected(`${document}\n`, /canonical standard base64/);
});

test('rejects expired and future-dated attestations using coordinator time', async () => {
  await assertRejected(
    await buildDocument({ timestamp: NOW_MS - 5 * 60 * 1000 - 1 }),
    /attestation is expired/
  );
  await assertRejected(
    await buildDocument({ timestamp: NOW_MS + 30 * 1000 + 1 }),
    /timestamp is too far in the future/
  );
});

test('rejects missing trusted coordinator time', async () => {
  await assertRejected(await buildDocument(), /trusted coordinator nowMs/, { nowMs: undefined });
});

test('rejects mutated PCR, nonce, and user_data bytes', async () => {
  await assertRejected(
    await buildDocument({ pcrs: { ...PCRS, pcr1: '99'.repeat(48) } }),
    /PCR1 pin mismatch/
  );
  await assertRejected(await buildDocument({ nonce: Buffer.alloc(32, 0x66) }), /nonce does not/);
  await assertRejected(
    await buildDocument({ userData: Buffer.alloc(32, 0x77) }),
    /user_data does not/
  );
});

test('rejects wrong protected COSE algorithm and a mutated signature', async () => {
  await assertRejected(await buildDocument({ protectedAlgorithm: -7 }), /ES384 algorithm -35/);

  const document = await buildDocument({ mutateSignature: true });
  const attestation = SignedAttestation.fromDocument(document);
  assert.equal(await attestation.verifySignature(), false);
  await assertRejected(document, /not anchored by the pinned AWS Nitro root G1/);
});

test('rejects a non-RSA-3072 session key before trust evaluation', async () => {
  const { publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicExponent: 0x10001,
  });
  await assertRejected(
    await buildDocument({ publicKey: publicKey.export({ format: 'der', type: 'spki' }) }),
    /canonical RSA-3072 SPKI DER with exponent 65537/
  );
});

test('rejects an RSA session key whose exponent is not 65537', async () => {
  const { publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 3072,
    publicExponent: 3,
  });
  await assertRejected(
    await buildDocument({ publicKey: publicKey.export({ format: 'der', type: 'spki' }) }),
    /canonical RSA-3072 SPKI DER with exponent 65537/
  );
});

test('rejects noncanonical SPKI DER with trailing data', async () => {
  const noncanonical = Buffer.concat([fixture.sessionPublicKeyDer, Buffer.from([0])]);
  await assertRejected(await buildDocument({ publicKey: noncanonical }), /canonical RSA-3072 SPKI/);
});

test('rejects a noncanonical expected PCR pin', async () => {
  await assertRejected(await buildDocument(), /canonical lowercase 48-byte hex/, {
    expected: expected({ pcrs: { ...PCRS, pcr0: 'AB'.repeat(48) } }),
  });
});

test('rejects an all-zero PCR pin that could admit a debug enclave', async () => {
  await assertRejected(await buildDocument(), /must not admit a debug enclave/, {
    expected: expected({ pcrs: { ...PCRS, pcr0: '00'.repeat(48) } }),
  });
});

test('public key fixture fingerprint is deterministic over canonical SPKI DER', () => {
  const canonical = fixture.sessionPublicKeyDer.toString('base64');
  assert.equal(Buffer.from(canonical, 'base64').toString('base64'), canonical);
  assert.equal(
    createHash('sha256').update(fixture.sessionPublicKeyDer).digest('hex'),
    createHash('sha256').update(Buffer.from(canonical, 'base64')).digest('hex')
  );
});
