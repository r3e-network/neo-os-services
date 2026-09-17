import { createHash, createPublicKey, timingSafeEqual, X509Certificate } from 'node:crypto';
import { SignedAttestation } from '@0xsequence/tee-verifier';
import { decode as decodeCbor } from 'cbor2';

const AWS_NITRO_ROOT_SHA256 = '641a0321a3e244efe456463195d606317ed7cdcc3c1756e09893f3c68f79bb5b';
const AWS_NITRO_ROOT_G1_PEM = `-----BEGIN CERTIFICATE-----
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

const MAX_DOCUMENT_BYTES = 128 * 1024;
const MAX_CERTIFICATE_BYTES = 16 * 1024;
const MAX_CERTIFICATES = 10;
const MAX_ATTESTATION_AGE_MS = 5 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 30 * 1000;
const PCR_BYTES = 48;
const COSE_ES384 = -35;
const REQUIRED_PAYLOAD_KEYS = new Set([
  'module_id',
  'timestamp',
  'digest',
  'pcrs',
  'certificate',
  'cabundle',
  'public_key',
  'user_data',
  'nonce',
]);

const PINNED_ROOT = new X509Certificate(AWS_NITRO_ROOT_G1_PEM);
if (sha256Hex(PINNED_ROOT.raw) !== AWS_NITRO_ROOT_SHA256) {
  throw new Error('embedded AWS Nitro root fingerprint mismatch');
}

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

function equalBytes(left, right) {
  return left.length === right.length && timingSafeEqual(left, right);
}

function requireBytes(value, field, { exactLength, maxLength } = {}) {
  if (!(value instanceof Uint8Array)) throw new Error(`${field} must be a byte string`);
  const bytes = Buffer.from(value);
  if (exactLength !== undefined && bytes.length !== exactLength) {
    throw new Error(`${field} must be exactly ${exactLength} bytes`);
  }
  if (maxLength !== undefined && (bytes.length === 0 || bytes.length > maxLength)) {
    throw new Error(`${field} has an invalid length`);
  }
  return bytes;
}

function decodeCanonicalBase64(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new Error('attestation_document must be canonical standard base64');
  }
  const bytes = Buffer.from(value, 'base64');
  if (
    bytes.length === 0 ||
    bytes.length > MAX_DOCUMENT_BYTES ||
    bytes.toString('base64') !== value
  ) {
    throw new Error('attestation_document is noncanonical or too large');
  }
  return bytes;
}

function decodeStrictCbor(bytes, field) {
  try {
    return decodeCbor(bytes, {
      maxDepth: 16,
      preferMap: true,
      rejectBigInts: true,
      rejectDuplicateKeys: true,
      rejectFloats: true,
      rejectSimple: true,
      rejectUndefined: true,
    });
  } catch (error) {
    throw new Error(`${field} is invalid CBOR: ${error.message}`);
  }
}

function requireExactMapKeys(map, expected, field) {
  if (!(map instanceof Map) || map.size !== expected.size) {
    throw new Error(`${field} does not contain the exact required fields`);
  }
  for (const key of map.keys()) {
    if (typeof key !== 'string' || !expected.has(key)) {
      throw new Error(`${field} contains an unexpected field`);
    }
  }
}

function decodeCoseAndPayload(documentBytes) {
  const cose = decodeStrictCbor(documentBytes, 'attestation document');
  if (!Array.isArray(cose) || cose.length !== 4) {
    throw new Error('attestation document must be a four-element COSE_Sign1 array');
  }
  const [protectedBytesValue, unprotected, payloadValue, signatureValue] = cose;
  const protectedBytes = requireBytes(protectedBytesValue, 'COSE protected header', {
    maxLength: 256,
  });
  if (!(unprotected instanceof Map) || unprotected.size !== 0) {
    throw new Error('COSE unprotected header must be an empty map');
  }
  const protectedHeader = decodeStrictCbor(protectedBytes, 'COSE protected header');
  if (
    !(protectedHeader instanceof Map) ||
    protectedHeader.size !== 1 ||
    protectedHeader.get(1) !== COSE_ES384
  ) {
    throw new Error('COSE protected header must contain only ES384 algorithm -35');
  }
  const payloadBytes = requireBytes(payloadValue, 'COSE payload', {
    maxLength: MAX_DOCUMENT_BYTES,
  });
  requireBytes(signatureValue, 'COSE ES384 signature', { exactLength: 96 });

  const payload = decodeStrictCbor(payloadBytes, 'Nitro payload');
  requireExactMapKeys(payload, REQUIRED_PAYLOAD_KEYS, 'Nitro payload');
  return payload;
}

function canonicalHex(value, bytes, field) {
  if (typeof value !== 'string' || value.length !== bytes * 2 || !/^[0-9a-f]+$/.test(value)) {
    throw new Error(`${field} must be canonical lowercase ${bytes}-byte hex`);
  }
  return Buffer.from(value, 'hex');
}

function validateExpected(expected) {
  if (!expected || typeof expected !== 'object') throw new Error('expected claims are required');
  return {
    nonce: canonicalHex(expected.nonceHex, 32, 'expected.nonceHex'),
    userData: canonicalHex(expected.userDataHex, 32, 'expected.userDataHex'),
    pcrs: [0, 1, 2].map((index) => {
      const pcr = canonicalHex(
        expected.pcrs?.[`pcr${index}`],
        PCR_BYTES,
        `expected.pcrs.pcr${index}`
      );
      if (pcr.every((byte) => byte === 0)) {
        throw new Error(`expected.pcrs.pcr${index} must not admit a debug enclave`);
      }
      return pcr;
    }),
  };
}

function validateTimestamp(timestamp, nowMs) {
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0) {
    throw new Error('trusted coordinator nowMs must be a positive safe integer');
  }
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
    throw new Error('Nitro timestamp must be a positive integer in milliseconds');
  }
  if (timestamp > nowMs + MAX_FUTURE_SKEW_MS) {
    throw new Error('Nitro timestamp is too far in the future');
  }
  if (timestamp < nowMs - MAX_ATTESTATION_AGE_MS) {
    throw new Error('Nitro attestation is expired');
  }
}

function validateModuleId(value) {
  if (
    typeof value !== 'string' ||
    Buffer.byteLength(value, 'utf8') > 256 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value)
  ) {
    throw new Error('module_id must be a nonempty canonical identifier of at most 256 bytes');
  }
  return value;
}

function validatePcrs(value, expectedPcrs) {
  if (!(value instanceof Map)) throw new Error('pcrs must be a CBOR map');
  const claims = {};
  for (const [index, digest] of value) {
    if (!Number.isSafeInteger(index) || index < 0 || index > 31) {
      throw new Error('pcrs contains an invalid register index');
    }
    requireBytes(digest, `PCR${index}`, { exactLength: PCR_BYTES });
  }
  for (let index = 0; index < 3; index += 1) {
    const actual = requireBytes(value.get(index), `PCR${index}`, { exactLength: PCR_BYTES });
    if (!equalBytes(actual, expectedPcrs[index])) throw new Error(`PCR${index} pin mismatch`);
    claims[`pcr${index}`] = actual.toString('hex');
  }
  return Object.freeze(claims);
}

function validateBoundBytes(payload, expected) {
  const nonce = requireBytes(payload.get('nonce'), 'nonce', { exactLength: 32 });
  const userData = requireBytes(payload.get('user_data'), 'user_data', { exactLength: 32 });
  if (!equalBytes(nonce, expected.nonce)) throw new Error('nonce does not exactly match challenge');
  if (!equalBytes(userData, expected.userData)) {
    throw new Error('user_data does not exactly match challenge binding');
  }
}

function validateSessionPublicKey(value) {
  const der = requireBytes(value, 'public_key', { maxLength: 4096 });
  let key;
  try {
    key = createPublicKey({ key: der, format: 'der', type: 'spki' });
  } catch {
    throw new Error('public_key is not SPKI DER');
  }
  const canonicalDer = Buffer.from(key.export({ format: 'der', type: 'spki' }));
  if (
    !equalBytes(der, canonicalDer) ||
    key.asymmetricKeyType !== 'rsa' ||
    !Number.isInteger(key.asymmetricKeyDetails?.modulusLength) ||
    key.asymmetricKeyDetails.modulusLength !== 3072 ||
    key.asymmetricKeyDetails.publicExponent !== 65_537n
  ) {
    throw new Error('public_key must be canonical RSA-3072 SPKI DER with exponent 65537');
  }
  return {
    publicKeyDerBase64: der.toString('base64'),
    publicKeySha256: sha256Hex(der),
  };
}

function parseCertificates(payload) {
  const leafDer = requireBytes(payload.get('certificate'), 'certificate', {
    maxLength: MAX_CERTIFICATE_BYTES,
  });
  const bundleValue = payload.get('cabundle');
  if (
    !Array.isArray(bundleValue) ||
    bundleValue.length === 0 ||
    bundleValue.length > MAX_CERTIFICATES
  ) {
    throw new Error('cabundle must contain a bounded root-first certificate chain');
  }
  const bundleDer = bundleValue.map((value, index) =>
    requireBytes(value, `cabundle[${index}]`, { maxLength: MAX_CERTIFICATE_BYTES })
  );
  let leaf;
  let bundle;
  try {
    leaf = new X509Certificate(leafDer);
    bundle = bundleDer.map((der) => new X509Certificate(der));
  } catch {
    throw new Error('certificate chain contains invalid X.509 DER');
  }
  return { leaf, bundle };
}

function certificateValidAt(certificate, nowMs) {
  const validFrom = certificate.validFromDate?.getTime();
  const validTo = certificate.validToDate?.getTime();
  return (
    Number.isFinite(validFrom) && Number.isFinite(validTo) && nowMs >= validFrom && nowMs <= validTo
  );
}

function validateOrderedCertificateChain({ leaf, bundle }, nowMs) {
  const root = bundle[0];
  if (!equalBytes(root.raw, PINNED_ROOT.raw) || sha256Hex(root.raw) !== AWS_NITRO_ROOT_SHA256) {
    throw new Error('certificate chain is not anchored by the pinned AWS Nitro root G1');
  }
  const chain = [leaf, ...bundle.slice(1).reverse(), root];
  const fingerprints = new Set(chain.map((certificate) => sha256Hex(certificate.raw)));
  if (fingerprints.size !== chain.length) throw new Error('certificate chain contains duplicates');
  if (leaf.ca) throw new Error('attestation certificate must not be a CA');
  if (
    leaf.publicKey.asymmetricKeyType !== 'ec' ||
    leaf.publicKey.asymmetricKeyDetails?.namedCurve !== 'secp384r1'
  ) {
    throw new Error('attestation certificate key must be P-384');
  }
  for (const certificate of chain) {
    if (!certificateValidAt(certificate, nowMs)) {
      throw new Error('certificate chain is not valid at trusted coordinator time');
    }
  }
  for (let index = 0; index < chain.length - 1; index += 1) {
    const child = chain[index];
    const issuer = chain[index + 1];
    if (!issuer.ca || !child.checkIssued(issuer) || !child.verify(issuer.publicKey)) {
      throw new Error(`certificate chain link ${index} is invalid`);
    }
  }
  if (!root.ca || !root.checkIssued(root) || !root.verify(root.publicKey)) {
    throw new Error('pinned AWS Nitro root is not a valid self-signed CA');
  }
}

function rejected(error) {
  return {
    verified: false,
    statusCode: 403,
    code: 'nitro_attestation_rejected',
    message: `Nitro attestation rejected: ${error instanceof Error ? error.message : 'unknown error'}`,
  };
}

export async function verifyNitroAttestation({ attestationDocument, expected, nowMs } = {}) {
  try {
    const expectedClaims = validateExpected(expected);
    const documentBytes = decodeCanonicalBase64(attestationDocument);
    const payload = decodeCoseAndPayload(documentBytes);
    if (payload.get('digest') !== 'SHA384') throw new Error('digest must be SHA384');
    const moduleId = validateModuleId(payload.get('module_id'));
    validateTimestamp(payload.get('timestamp'), nowMs);
    const pcrs = validatePcrs(payload.get('pcrs'), expectedClaims.pcrs);
    validateBoundBytes(payload, expectedClaims);
    const publicKey = validateSessionPublicKey(payload.get('public_key'));
    const certificates = parseCertificates(payload);
    validateOrderedCertificateChain(certificates, nowMs);

    const attestation = SignedAttestation.fromDocument(attestationDocument);
    if (!(await attestation.verifyRootOfTrust(new Date(nowMs)))) {
      throw new Error('audited verifier rejected the full certificate path');
    }
    if (!(await attestation.verifySignature())) {
      throw new Error('COSE ES384 signature verification failed');
    }

    return {
      verified: true,
      claims: {
        nonceHex: expectedClaims.nonce.toString('hex'),
        userDataHex: expectedClaims.userData.toString('hex'),
        pcrs,
        moduleId,
        ...publicKey,
      },
    };
  } catch (error) {
    return rejected(error);
  }
}
