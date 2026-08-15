import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AES_GCM_IV_LENGTH_BYTES,
  AES_GCM_TAG_LENGTH_BYTES,
  CONFIDENTIAL_ENVELOPE_ALGORITHM,
  CONFIDENTIAL_ENVELOPE_INFO,
  CONFIDENTIAL_ENVELOPE_VERSION,
  X25519_PUBLIC_KEY_LENGTH_BYTES,
  decodeBase64,
  decryptConfidentialEnvelope,
  encodeBase64,
  encryptConfidentialEnvelope,
  generateConfidentialKeyMaterial,
  parseConfidentialEnvelope,
} from './confidential-envelope.js';

/**
 * Golden vector pinning the v2 confidential envelope wire format. The
 * envelope was produced by `encryptConfidentialEnvelope` and verified
 * against the deployed worker decryptor (`decryptEncryptedToken` in
 * workers/nitro-worker/src/oracle/crypto.js) at the time this module was
 * consolidated into packages/shared. The keypair is a TEST FIXTURE — it
 * must never be used outside tests. Any change that breaks this vector
 * breaks decryption of live client traffic; do not regenerate it without
 * a coordinated envelope-format rotation.
 *
 * The same vector is replayed by the consumer-repo drift guards
 * (neo-os-devpack shared/test, neo-abstract-account
 * sdk/js/tests), so all three repos pin identical bytes.
 */
export const CONFIDENTIAL_ENVELOPE_GOLDEN_VECTOR = {
  publicKeyRaw: 'X+mfM9Lg+Tm9GBzniOC0vwDcZE857Za9AbdJCD7IsWM=',
  privateKeyPkcs8: 'MC4CAQAwBQYDK2VuBCIEIPBjP3AKvOssGMkua0kFSHbkLd7KkMfh1/8GqVrfajFy',
  plaintext:
    '{"kind":"morpheus.confidential.golden.v1","message":"morpheus envelope golden vector","nonce":"0x0123456789abcdef"}',
  envelope:
    'eyJ2IjoyLCJhbGciOiJYMjU1MTktSEtERi1TSEEyNTYtQUVTLTI1Ni1HQ00iLCJlcGsiOiJMcnU0NTdSOWNOVUNWNXlZNG85dit4TlVwVm4yNTdUcFJNVDAyUWhlTmhFPSIsIml2IjoiL1MvUTAvWG83MlAydmQ3ciIsImN0IjoiWjllbFNUc0ZNK2crbzYzMWtFdmFMMXkralFIZnh0MldseDdJSkNpYldoL2RYaTFVaFpOY0VzaEk3d1JEMEg3QTIvTWF4TEYyNDBQaGF1M3VUVlZDUWpMOGFtMU94aGFpODNzQTBwc3IyVkpROE1EYVpsZ3RxdjVjS3hlZTNzbmMyR2s0Mm4rZ2NIYVJyVkhnc21Md3U0NjhGZz09IiwidGFnIjoiWE14UDhuQll1MkxrMWF0bEFhNzduUT09In0=',
};

const GOLDEN = CONFIDENTIAL_ENVELOPE_GOLDEN_VECTOR;

function tamperEnvelopeTag(envelopeBase64) {
  const parsed = JSON.parse(new TextDecoder().decode(decodeBase64(envelopeBase64)));
  const tagBytes = decodeBase64(parsed.tag);
  tagBytes[0] ^= 0xff;
  parsed.tag = encodeBase64(tagBytes);
  return encodeBase64(new TextEncoder().encode(JSON.stringify(parsed)));
}

test('envelope literals stay pinned to the deployed decryptor contract', () => {
  assert.equal(CONFIDENTIAL_ENVELOPE_VERSION, 2);
  assert.equal(CONFIDENTIAL_ENVELOPE_ALGORITHM, 'X25519-HKDF-SHA256-AES-256-GCM');
  assert.equal(CONFIDENTIAL_ENVELOPE_INFO, 'morpheus-confidential-payload-v2');
  assert.equal(X25519_PUBLIC_KEY_LENGTH_BYTES, 32);
  assert.equal(AES_GCM_IV_LENGTH_BYTES, 12);
  assert.equal(AES_GCM_TAG_LENGTH_BYTES, 16);
});

test('golden vector decrypts with the canonical implementation', async () => {
  const parsed = parseConfidentialEnvelope(GOLDEN.envelope);
  assert.ok(parsed, 'golden envelope must parse as a v2 envelope');
  assert.equal(parsed.v, CONFIDENTIAL_ENVELOPE_VERSION);
  assert.equal(parsed.alg, CONFIDENTIAL_ENVELOPE_ALGORITHM);
  assert.equal(decodeBase64(parsed.epk).length, X25519_PUBLIC_KEY_LENGTH_BYTES);
  assert.equal(decodeBase64(parsed.iv).length, AES_GCM_IV_LENGTH_BYTES);
  assert.equal(decodeBase64(parsed.tag).length, AES_GCM_TAG_LENGTH_BYTES);

  const plaintext = await decryptConfidentialEnvelope(GOLDEN.envelope, {
    privateKeyPkcs8: GOLDEN.privateKeyPkcs8,
    publicKeyRaw: GOLDEN.publicKeyRaw,
  });
  assert.equal(plaintext, GOLDEN.plaintext);
});

test('encrypt -> decrypt roundtrip with fresh key material', async () => {
  const keyMaterial = await generateConfidentialKeyMaterial();
  const plaintext = JSON.stringify({ hello: 'morpheus', n: 42 });
  const envelope = await encryptConfidentialEnvelope(keyMaterial.publicKeyRaw, plaintext);

  const parsed = parseConfidentialEnvelope(envelope);
  assert.ok(parsed);
  assert.equal(parsed.v, CONFIDENTIAL_ENVELOPE_VERSION);
  assert.equal(parsed.alg, CONFIDENTIAL_ENVELOPE_ALGORITHM);

  assert.equal(await decryptConfidentialEnvelope(envelope, keyMaterial), plaintext);
});

test('decrypt accepts worker-style byte key material fields', async () => {
  const plaintext = await decryptConfidentialEnvelope(GOLDEN.envelope, {
    privateKeyPkcs8Bytes: decodeBase64(GOLDEN.privateKeyPkcs8),
    publicKeyRawBytes: decodeBase64(GOLDEN.publicKeyRaw),
  });
  assert.equal(plaintext, GOLDEN.plaintext);
});

test('tampered tag and malformed envelopes fail closed', async () => {
  const keyMaterial = {
    privateKeyPkcs8: GOLDEN.privateKeyPkcs8,
    publicKeyRaw: GOLDEN.publicKeyRaw,
  };
  await assert.rejects(
    decryptConfidentialEnvelope(tamperEnvelopeTag(GOLDEN.envelope), keyMaterial)
  );
  await assert.rejects(decryptConfidentialEnvelope('not-an-envelope', keyMaterial), {
    message: `unsupported confidential payload format; expected ${CONFIDENTIAL_ENVELOPE_ALGORITHM}`,
  });

  assert.equal(parseConfidentialEnvelope(''), null);
  assert.equal(parseConfidentialEnvelope(encodeBase64(new TextEncoder().encode('[]'))), null);
  const wrongVersion = JSON.parse(new TextDecoder().decode(decodeBase64(GOLDEN.envelope)));
  wrongVersion.v = 1;
  assert.equal(
    parseConfidentialEnvelope(encodeBase64(new TextEncoder().encode(JSON.stringify(wrongVersion)))),
    null
  );
  const wrongAlg = JSON.parse(new TextDecoder().decode(decodeBase64(GOLDEN.envelope)));
  wrongAlg.alg = 'X25519-HKDF-SHA512-AES-256-GCM';
  assert.equal(
    parseConfidentialEnvelope(encodeBase64(new TextEncoder().encode(JSON.stringify(wrongAlg)))),
    null
  );
});

test('worker decryptor parity: nitro-worker decrypts canonical envelopes (read-only import)', async (t) => {
  const previousKeyMaterialJson = process.env.MORPHEUS_ORACLE_KEY_MATERIAL_JSON;
  process.env.MORPHEUS_ORACLE_KEY_MATERIAL_JSON = JSON.stringify({
    public_key_raw: GOLDEN.publicKeyRaw,
    private_key_pkcs8: GOLDEN.privateKeyPkcs8,
  });

  const worker = await import('../../../workers/nitro-worker/src/oracle/crypto.js');
  worker.__resetOracleKeyMaterialForTests();
  t.after(() => {
    worker.__resetOracleKeyMaterialForTests();
    if (previousKeyMaterialJson === undefined) {
      delete process.env.MORPHEUS_ORACLE_KEY_MATERIAL_JSON;
    } else {
      process.env.MORPHEUS_ORACLE_KEY_MATERIAL_JSON = previousKeyMaterialJson;
    }
  });

  assert.equal(await worker.decryptEncryptedToken(GOLDEN.envelope), GOLDEN.plaintext);

  const freshPlaintext = JSON.stringify({ source: 'canonical-envelope', check: 'worker-parity' });
  const freshEnvelope = await encryptConfidentialEnvelope(GOLDEN.publicKeyRaw, freshPlaintext);
  assert.equal(await worker.decryptEncryptedToken(freshEnvelope), freshPlaintext);

  await assert.rejects(worker.decryptEncryptedToken(tamperEnvelopeTag(GOLDEN.envelope)));
});

// The package is `"private": true`, so the canonical envelope cannot be shared
// as an npm dependency with the browser-only / example consumers — they vendor
// the wire format verbatim. This parity guard reads each in-repo vendored copy
// as source text and asserts it still pins the four wire-format literals that
// the golden vector above (CONFIDENTIAL_ENVELOPE_GOLDEN_VECTOR) and the deployed
// worker decryptor depend on: a drift in any of these in a vendored copy would
// silently produce envelopes that the oracle can no longer decrypt.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const VENDORED_ENVELOPE_COPIES = [
  'apps/web/lib/browser-encryption.ts',
  'examples/browser-encryption/encrypt-oracle-payload.js',
  'examples/scripts/common.mjs',
];

test('vendored confidential-envelope copies stay byte-compatible with the golden wire format', async () => {
  for (const relative of VENDORED_ENVELOPE_COPIES) {
    const source = await readFile(path.join(REPO_ROOT, relative), 'utf8');

    assert.ok(
      source.includes(CONFIDENTIAL_ENVELOPE_ALGORITHM),
      `${relative} must pin the canonical envelope algorithm`
    );
    assert.ok(
      source.includes(CONFIDENTIAL_ENVELOPE_INFO),
      `${relative} must pin the canonical HKDF info string`
    );
    assert.match(
      source,
      /(?:ENVELOPE_VERSION = 2|v:\s*2)\b/,
      `${relative} must pin envelope version ${CONFIDENTIAL_ENVELOPE_VERSION}`
    );
    assert.match(
      source,
      /(?:TAG_LENGTH_BYTES = 16|\b16\b)/,
      `${relative} must pin the ${AES_GCM_TAG_LENGTH_BYTES}-byte AES-GCM tag length`
    );
  }
});
