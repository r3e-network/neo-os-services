import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createCipheriv, generateKeyPairSync } from 'node:crypto';
import fs, { writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveEncryptedTokenCiphertext } from './crypto.js';
import { isolateAwsCredentials } from '../test-support/aws-credentials.mjs';

// Nothing in this file may reach AWS: the worker's Secrets Manager client falls
// back to the SDK's default credential chain when no secrets provider is
// installed (see test-support/aws-credentials.mjs).
test.after(isolateAwsCredentials());

const originalFetch = global.fetch;
const originalSupabaseUrl = process.env.SUPABASE_URL;
const originalSupabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

function saveKeyMaterialEnv() {
  return {
    plain: process.env.MORPHEUS_ORACLE_KEY_MATERIAL_BASE64,
    sealedJson: process.env.MORPHEUS_ORACLE_SEALED_KEYSTORE_JSON,
    sealedBase64: process.env.MORPHEUS_ORACLE_SEALED_KEYSTORE_BASE64,
    keystorePath: process.env.NITRO_ORACLE_KEYSTORE_PATH,
    allowEphemeral: process.env.MORPHEUS_ALLOW_EPHEMERAL_KEY,
    nodeEnv: process.env.NODE_ENV,
  };
}

function restoreKeyMaterialEnv(saved) {
  if (saved.plain === undefined) delete process.env.MORPHEUS_ORACLE_KEY_MATERIAL_BASE64;
  else process.env.MORPHEUS_ORACLE_KEY_MATERIAL_BASE64 = saved.plain;
  if (saved.sealedJson === undefined) delete process.env.MORPHEUS_ORACLE_SEALED_KEYSTORE_JSON;
  else process.env.MORPHEUS_ORACLE_SEALED_KEYSTORE_JSON = saved.sealedJson;
  if (saved.sealedBase64 === undefined) delete process.env.MORPHEUS_ORACLE_SEALED_KEYSTORE_BASE64;
  else process.env.MORPHEUS_ORACLE_SEALED_KEYSTORE_BASE64 = saved.sealedBase64;
  if (saved.keystorePath === undefined) delete process.env.NITRO_ORACLE_KEYSTORE_PATH;
  else process.env.NITRO_ORACLE_KEYSTORE_PATH = saved.keystorePath;
  if (saved.allowEphemeral === undefined) delete process.env.MORPHEUS_ALLOW_EPHEMERAL_KEY;
  else process.env.MORPHEUS_ALLOW_EPHEMERAL_KEY = saved.allowEphemeral;
  if (saved.nodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = saved.nodeEnv;
}

test.afterEach(() => {
  global.fetch = originalFetch;
  if (originalSupabaseUrl === undefined) delete process.env.SUPABASE_URL;
  else process.env.SUPABASE_URL = originalSupabaseUrl;
  if (originalSupabaseServiceRoleKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  else process.env.SUPABASE_SERVICE_ROLE_KEY = originalSupabaseServiceRoleKey;
});

test('encrypted ref lookup and claim fetches are bounded by abort signals', async () => {
  process.env.SUPABASE_URL = 'https://mock-supabase.example.com';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role';

  const calls = [];
  global.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const row = { id: 'ref-1', ciphertext: 'sealed-token', network: 'testnet', metadata: {} };
    if ((init.method || 'GET') === 'PATCH') {
      return new Response(
        JSON.stringify([
          { ...row, metadata: { _consumed_request_id: 'req-1', _consumed_at: 'now' } },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    return new Response(JSON.stringify([row]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const ciphertext = await resolveEncryptedTokenCiphertext({
    encrypted_token_ref: 'ref-1',
    request_id: 'req-1',
  });
  assert.equal(ciphertext, 'sealed-token');
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.ok(
      call.init.signal instanceof AbortSignal,
      `expected abort signal on ${call.init.method || 'GET'} ${call.url}`
    );
  }
});

test('encrypted refs fail closed before lookup when request_id is missing', async () => {
  process.env.SUPABASE_URL = 'https://mock-supabase.example.com';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role';
  let fetchCalls = 0;
  global.fetch = async () => {
    fetchCalls += 1;
    return new Response('[]', { status: 200 });
  };

  await assert.rejects(
    () => resolveEncryptedTokenCiphertext({ encrypted_token_ref: 'ref-without-request' }),
    /request_id is required when resolving an encrypted ref/
  );
  assert.equal(fetchCalls, 0);
});

test('enclave unseals the X25519 keystore from env ciphertext — RC2 no host unseal', async () => {
  const signer = await import('../platform/nitro-signer.js');
  const cryptoMod = await import('./crypto.js');

  // Deterministic Secrets Manager master so the in-TEE wrap key is reproducible.
  signer.__setSecretsProviderForTests(() => ({
    getSecret: async () => Buffer.alloc(48, 7).toString('base64'),
  }));
  const saved = saveKeyMaterialEnv();
  try {
    // The same wrap key the enclave will derive itself (via the mocked SDK).
    const wrapKey = (
      await signer.deriveKeyBytes('morpheus/oracle/encryption/wrap/v1', 'oracle-encryption-wrap')
    ).subarray(0, 32);

    // A real X25519 "oracle decryption key", sealed with the wrap key.
    const kp = generateKeyPairSync('x25519');
    const pkcs8 = kp.privateKey.export({ type: 'pkcs8', format: 'der' });
    const rawPub = Buffer.from(kp.publicKey.export({ format: 'jwk' }).x, 'base64url');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', wrapKey, iv);
    const ct = Buffer.concat([cipher.update(pkcs8), cipher.final()]);
    const keystore = {
      algorithm: 'x25519-hkdf-sha256-aes-256-gcm',
      version: 2,
      public_key_raw: rawPub.toString('base64'),
      sealed_private_key: {
        iv: iv.toString('base64'),
        ciphertext: ct.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
      },
    };

    // No host plaintext injected — only the ciphertext keystore in env.
    delete process.env.MORPHEUS_ORACLE_KEY_MATERIAL_BASE64;
    delete process.env.MORPHEUS_ALLOW_EPHEMERAL_KEY;
    delete process.env.MORPHEUS_ORACLE_SEALED_KEYSTORE_JSON;
    delete process.env.NITRO_ORACLE_KEYSTORE_PATH;
    process.env.MORPHEUS_ORACLE_SEALED_KEYSTORE_BASE64 = Buffer.from(
      JSON.stringify(keystore)
    ).toString('base64');
    cryptoMod.__resetOracleKeyMaterialForTests();

    const km = await cryptoMod.ensureOracleKeyMaterial();
    // source proves the env-sealed path ran AND the in-TEE AES-GCM unseal succeeded
    // (a wrong wrap key would throw -> ephemeral/throw, never this source).
    assert.equal(km.source, 'nitro-sealed-env');
  } finally {
    restoreKeyMaterialEnv(saved);
    delete process.env.MORPHEUS_ALLOW_EPHEMERAL_KEY;
    cryptoMod.__resetOracleKeyMaterialForTests();
    signer.__resetSecretsProviderStateForTests();
  }
});

test('loadStableOracleKeyMaterial returns undefined sentinel when keystore file is missing', async () => {
  const signer = await import('../platform/nitro-signer.js');
  signer.__setSecretsProviderForTests(() => ({
    getSecret: async () => Buffer.alloc(48, 7).toString('base64'),
  }));

  // Use a fresh module URL to avoid cached state from earlier tests.
  const cryptoMod = await import(`./crypto.js?test=missing-${Date.now()}`);
  const saved = saveKeyMaterialEnv();
  try {
    delete process.env.MORPHEUS_ORACLE_KEY_MATERIAL_BASE64;
    delete process.env.MORPHEUS_ORACLE_SEALED_KEYSTORE_JSON;
    delete process.env.MORPHEUS_ORACLE_SEALED_KEYSTORE_BASE64;
    process.env.NITRO_ORACLE_KEYSTORE_PATH = path.join(
      tmpdir(),
      `missing-keystore-${Date.now()}.json`
    );
    cryptoMod.__resetOracleKeyMaterialForTests();

    const result = await cryptoMod.__loadStableOracleKeyMaterialForTests();
    assert.equal(result, undefined);
  } finally {
    restoreKeyMaterialEnv(saved);
    cryptoMod.__resetOracleKeyMaterialForTests();
    signer.__resetSecretsProviderStateForTests();
  }
});

test('loadStableOracleKeyMaterial throws a descriptive error on corrupted JSON', async () => {
  const signer = await import('../platform/nitro-signer.js');
  signer.__setSecretsProviderForTests(() => ({
    getSecret: async () => Buffer.alloc(48, 7).toString('base64'),
  }));

  const cryptoMod = await import(`./crypto.js?test=corrupt-${Date.now()}`);
  const saved = saveKeyMaterialEnv();
  const tmpFile = path.join(tmpdir(), `corrupt-keystore-${Date.now()}.json`);
  await writeFile(tmpFile, 'this is not valid json {');

  try {
    delete process.env.MORPHEUS_ORACLE_KEY_MATERIAL_BASE64;
    delete process.env.MORPHEUS_ORACLE_SEALED_KEYSTORE_JSON;
    delete process.env.MORPHEUS_ORACLE_SEALED_KEYSTORE_BASE64;
    process.env.NITRO_ORACLE_KEYSTORE_PATH = tmpFile;
    cryptoMod.__resetOracleKeyMaterialForTests();

    await assert.rejects(
      () => cryptoMod.__loadStableOracleKeyMaterialForTests(),
      /keystore at .* contains invalid JSON/
    );
  } finally {
    restoreKeyMaterialEnv(saved);
    cryptoMod.__resetOracleKeyMaterialForTests();
    signer.__resetSecretsProviderStateForTests();
    await rm(tmpFile, { force: true });
  }
});

test('loadStableOracleKeyMaterial re-throws non-ENOENT read errors', async () => {
  const signer = await import('../platform/nitro-signer.js');
  signer.__setSecretsProviderForTests(() => ({
    getSecret: async () => Buffer.alloc(48, 7).toString('base64'),
  }));

  // Import before mocking: on Node 22 the ESM loader reads module source
  // through fs/promises.readFile, so an unscoped mock fails the import itself.
  const cryptoMod = await import(`./crypto.js?test=permission-${Date.now()}`);
  const saved = saveKeyMaterialEnv();
  const keystorePath = path.join(tmpdir(), `permission-keystore-${Date.now()}.json`);
  const originalReadFile = fs.readFile;
  try {
    test.mock.method(fs, 'readFile', async (file, ...rest) => {
      if (String(file) !== keystorePath) return originalReadFile.call(fs, file, ...rest);
      const error = new Error('EACCES: permission denied');
      error.code = 'EACCES';
      throw error;
    });
    delete process.env.MORPHEUS_ORACLE_KEY_MATERIAL_BASE64;
    delete process.env.MORPHEUS_ORACLE_SEALED_KEYSTORE_JSON;
    delete process.env.MORPHEUS_ORACLE_SEALED_KEYSTORE_BASE64;
    process.env.NITRO_ORACLE_KEYSTORE_PATH = keystorePath;
    cryptoMod.__resetOracleKeyMaterialForTests();

    await assert.rejects(
      () => cryptoMod.__loadStableOracleKeyMaterialForTests(),
      /EACCES: permission denied/
    );
  } finally {
    test.mock.restoreAll();
    restoreKeyMaterialEnv(saved);
    cryptoMod.__resetOracleKeyMaterialForTests();
    signer.__resetSecretsProviderStateForTests();
  }
});

test('ensureOracleKeyMaterial logs stable-source failures before a development fallback', async () => {
  const signer = await import('../platform/nitro-signer.js');
  signer.__setSecretsProviderForTests(() => ({
    getSecret: async () => Buffer.alloc(48, 7).toString('base64'),
  }));

  const cryptoMod = await import(`./crypto.js?test=logged-fallback-${Date.now()}`);
  const saved = saveKeyMaterialEnv();
  const tmpFile = path.join(tmpdir(), `logged-fallback-keystore-${Date.now()}.json`);
  await writeFile(tmpFile, 'not-json');
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    delete process.env.MORPHEUS_ORACLE_KEY_MATERIAL_BASE64;
    delete process.env.MORPHEUS_ORACLE_SEALED_KEYSTORE_JSON;
    delete process.env.MORPHEUS_ORACLE_SEALED_KEYSTORE_BASE64;
    process.env.NITRO_ORACLE_KEYSTORE_PATH = tmpFile;
    process.env.MORPHEUS_ALLOW_EPHEMERAL_KEY = 'true';
    delete process.env.NODE_ENV;
    cryptoMod.__resetOracleKeyMaterialForTests();

    const result = await cryptoMod.ensureOracleKeyMaterial();
    assert.equal(result.source, 'ephemeral-memory');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /oracle\.key_material\.stable_source_failed/);
    assert.match(warnings[0], /invalid JSON/);
  } finally {
    console.warn = originalWarn;
    restoreKeyMaterialEnv(saved);
    cryptoMod.__resetOracleKeyMaterialForTests();
    signer.__resetSecretsProviderStateForTests();
    await rm(tmpFile, { force: true });
  }
});

test('ensureOracleKeyMaterial rejects ephemeral-key opt-in in production', async () => {
  const cryptoMod = await import(`./crypto.js?test=production-ephemeral-${Date.now()}`);
  const saved = saveKeyMaterialEnv();
  try {
    delete process.env.MORPHEUS_ORACLE_KEY_MATERIAL_BASE64;
    delete process.env.MORPHEUS_ORACLE_SEALED_KEYSTORE_JSON;
    delete process.env.MORPHEUS_ORACLE_SEALED_KEYSTORE_BASE64;
    process.env.MORPHEUS_ALLOW_EPHEMERAL_KEY = 'true';
    process.env.NODE_ENV = 'production';
    cryptoMod.__resetOracleKeyMaterialForTests();

    await assert.rejects(
      () => cryptoMod.ensureOracleKeyMaterial(),
      /MORPHEUS_ALLOW_EPHEMERAL_KEY is not allowed when NODE_ENV=production/
    );
  } finally {
    restoreKeyMaterialEnv(saved);
    cryptoMod.__resetOracleKeyMaterialForTests();
  }
});
