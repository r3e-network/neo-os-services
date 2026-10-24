import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createCipheriv,
  createHash,
  createSign,
  generateKeyPairSync,
  randomBytes,
} from 'node:crypto';
import { rpc as neoRpc, tx as neoTx, wallet as neoWallet } from '@cityofzion/neon-js';
import { exportJWK, SignJWT } from 'jose';
import { getFeedProvidersForPair } from './src/oracle/feed-registry.js';
import {
  neoNetworkMagicLe4,
  encodeUint256Word,
} from '@r3e-network/neo-os-services-shared/neo-encoding';
import { isolateAwsCredentials } from './src/test-support/aws-credentials.mjs';

// Nothing in this file may reach AWS: the worker's Secrets Manager client falls
// back to the SDK's default credential chain when no secrets provider is
// installed (see src/test-support/aws-credentials.mjs).
test.after(isolateAwsCredentials());

const originalFetch = global.fetch;
const originalRuntimeToken = process.env.MORPHEUS_RUNTIME_TOKEN;
const originalNeoN3Key = process.env.MORPHEUS_WORKER_NEO_N3_PRIVATE_KEY;
const originalNeoRpc = process.env.NEO_RPC_URL;
const originalEvmRpc = process.env.EVM_RPC_URL;
const originalTwelveData = process.env.TWELVEDATA_API_KEY;
const originalFeedStatePath = process.env.MORPHEUS_FEED_STATE_PATH;
const originalSupabaseUrl = process.env.SUPABASE_URL;
const originalSupabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const originalUseDerivedKeys = process.env.NITRO_USE_DERIVED_KEYS;
const originalOracleKeystorePath = process.env.NITRO_ORACLE_KEYSTORE_PATH;
const originalEnableUserScripts = process.env.MORPHEUS_ENABLE_UNTRUSTED_SCRIPTS;
const originalOracleHash = process.env.CONTRACT_MORPHEUS_ORACLE_HASH;
const originalNeoDidSecretSalt = process.env.NEODID_SECRET_SALT;
const originalWeb3AuthClientId = process.env.WEB3AUTH_CLIENT_ID;
const originalNextPublicWeb3AuthClientId = process.env.NEXT_PUBLIC_WEB3AUTH_CLIENT_ID;
const originalWeb3AuthJwksUrl = process.env.WEB3AUTH_JWKS_URL;
const originalAllowUnpinnedSigners = process.env.MORPHEUS_ALLOW_UNPINNED_SIGNERS;

process.env.MORPHEUS_RUNTIME_TOKEN = 'worker-test-secret';
process.env.MORPHEUS_WORKER_NEO_N3_PRIVATE_KEY =
  '1111111111111111111111111111111111111111111111111111111111111111';
process.env.NEO_RPC_URL = 'https://neo-rpc.test';
process.env.EVM_RPC_URL = '';
process.env.TWELVEDATA_API_KEY = 'test-twelvedata-key';
const workerTestFeedStateDir = await fs.mkdtemp(
  path.join(os.tmpdir(), 'morpheus-worker-feed-state-')
);
process.env.MORPHEUS_FEED_STATE_PATH = path.join(workerTestFeedStateDir, 'feed-state.json');
process.env.SUPABASE_URL = '';
process.env.SUPABASE_SERVICE_ROLE_KEY = '';
process.env.MORPHEUS_ENABLE_UNTRUSTED_SCRIPTS = 'true';
process.env.MORPHEUS_ALLOW_EPHEMERAL_KEY = 'true';
process.env.CONTRACT_MORPHEUS_ORACLE_HASH = '0xf54d8584ef82315c1800373272ab08ae0db2d5ef';
process.env.NEODID_SECRET_SALT = 'worker-test-neodid-salt';
process.env.MORPHEUS_ALLOW_UNPINNED_SIGNERS = 'true';
process.env.SIGNER_SERVICE_URL = 'https://custody.test';
process.env.SIGNER_SERVICE_TOKEN = 'custody-worker-test-token';
process.env.SIGNER_ROLE_WORKER_KEY_ID = 'key-worker';
process.env.SIGNER_ROLE_UPDATER_KEY_ID = 'key-updater';
process.env.SIGNER_ROLE_ORACLE_VERIFIER_KEY_ID = 'key-oracle-verifier';
delete process.env.WEB3AUTH_CLIENT_ID;
delete process.env.NEXT_PUBLIC_WEB3AUTH_CLIENT_ID;
delete process.env.WEB3AUTH_JWKS_URL;

// Keep unit tests hermetic even when a developer machine has real Morpheus/Neo secrets exported.
// These secrets can change default validation behavior or trigger pinned-signer drift checks.
const WORKER_TEST_ENV_KEEP = new Set([
  'MORPHEUS_RUNTIME_TOKEN',
  'MORPHEUS_WORKER_NEO_N3_PRIVATE_KEY',
  'NEO_RPC_URL',
  'EVM_RPC_URL',
  'TWELVEDATA_API_KEY',
  'MORPHEUS_FEED_STATE_PATH',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'NITRO_USE_DERIVED_KEYS',
  'NITRO_ORACLE_KEYSTORE_PATH',
  'MORPHEUS_ENABLE_UNTRUSTED_SCRIPTS',
  'CONTRACT_MORPHEUS_ORACLE_HASH',
  'NEODID_SECRET_SALT',
  'MORPHEUS_ALLOW_UNPINNED_SIGNERS',
  'SIGNER_SERVICE_URL',
  'SIGNER_SERVICE_TOKEN',
  'SIGNER_ROLE_WORKER_KEY_ID',
  'SIGNER_ROLE_UPDATER_KEY_ID',
  'SIGNER_ROLE_ORACLE_VERIFIER_KEY_ID',
]);
for (const key of Object.keys(process.env)) {
  if (WORKER_TEST_ENV_KEEP.has(key)) continue;
  if (
    key === 'NEO_TESTNET_WIF' ||
    key === 'NEO_N3_WIF' ||
    key.startsWith('MORPHEUS_WORKER_NEO_N3_') ||
    key.startsWith('MORPHEUS_RELAYER_NEO_N3_') ||
    key.startsWith('MORPHEUS_UPDATER_NEO_N3_') ||
    key.startsWith('SIGNER_SERVICE_') ||
    key.startsWith('SIGNER_ROLE_') ||
    key === 'SIGNER_CUSTODY_TIMEOUT_MS' ||
    key.startsWith('MORPHEUS_ORACLE_VERIFIER_') ||
    key.startsWith('MORPHEUS_ORACLE_VERIFIER_') ||
    key.startsWith('MORPHEUS_FEED_') ||
    key.startsWith('TURNSTILE_') ||
    key.startsWith('MORPHEUS_TURNSTILE_') ||
    key.startsWith('UPSTASH_REDIS_')
  ) {
    delete process.env[key];
  }
}
const baselineEnv = { ...process.env };

const { default: handler, __resetHealthReadinessCacheForTests } = await import('./src/worker.js');
const {
  __resetDstackClientStateForTests,
  __setSecretsProviderForTests,
  __resetSecretsProviderStateForTests,
  deriveKeyBytes,
} = await import('./src/platform/nitro-signer.js');
const { __resetOracleKeyMaterialForTests, decryptEncryptedToken } =
  await import('./src/oracle/crypto.js');
const { __drainOracleFeedBackgroundTasksForTests, __resetFeedStateForTests } =
  await import('./src/oracle/feeds.js');
const { allowlistAllows, createByteArrayParam } = await import('./src/platform/allowlist.js');
const { loadNeoN3Context, relayNeoN3Invocation } = await import('./src/chain/neo-n3.js');
const { __resetNeoDidStateForTests } = await import('./src/neodid/index.js');
const { __resetSigningCachesForTests } = await import('./src/chain/signing.js');
const { __setCustodyTransportForTests, __resetCustodyTransportForTests } =
  await import('./src/platform/custody.js');
const { createUpstashRestMock } = await import('./src/test-support/upstash-rest-mock.mjs');
const { buildSponsorshipFixture, sponsorshipPayload, sponsorshipStorageKey } =
  await import('./src/test-support/sponsorship-fixtures.mjs');
const { __resetOracleFetchDispatchersForTests } = await import('./src/oracle/fetch.js');

function authHeaders() {
  return {
    authorization: 'Bearer worker-test-secret',
    'content-type': 'application/json',
  };
}

// Custody test transport: the worker sign lanes are custody-only, so the harness
// swaps the HTTP transport for a deterministic in-process signer service that
// speaks the §5 shapes. key-worker carries the same identity the legacy
// local-key tests asserted against, so envelope assertions keep holding.
const custodyWorkerAccount = new neoWallet.Account(process.env.MORPHEUS_WORKER_NEO_N3_PRIVATE_KEY);
const custodyOracleVerifierAccount = new neoWallet.Account(
  '68e15083a6fd187b6f5f6136bada4eb00f096e5e21d82c74edf6f086e80539ba'
);
// Distinct updater identity: the tx-relay lane signs oracle-contract
// invocations as the updater account, not the worker's own key.
const custodyUpdaterAccount = new neoWallet.Account(
  'c0941cd6a267c0ef4c86b52b1a1b9d0dbb8f9a2c8b6e8ff0d9d16b1a5f6d1a02'
);
const custodyKeyAccounts = {
  'key-worker': custodyWorkerAccount,
  'key-updater': custodyUpdaterAccount,
  'key-oracle-verifier': custodyOracleVerifierAccount,
};

function installCustodyTransportForTests() {
  __setCustodyTransportForTests(async (method, pathname, body = {}) => {
    const keyMatch = pathname.match(/^\/keys\/(.+)$/);
    if (method === 'GET' && keyMatch) {
      const account = custodyKeyAccounts[decodeURIComponent(keyMatch[1])];
      if (!account) return { allowed: false, code: 'key_not_found', message: 'unknown key id' };
      return {
        key_id: decodeURIComponent(keyMatch[1]),
        label: 'worker-test',
        network: 'testnet',
        network_magic: 894710606,
        public_key: account.publicKey,
        script_hash: `0x${account.scriptHash}`,
        address: account.address,
        verification_script: `0c21${account.publicKey}4156e7b327`,
        signing_enabled: true,
      };
    }
    if (method === 'POST' && pathname === '/sign/raw') {
      const account = custodyKeyAccounts[body.key_id];
      if (!account) return { allowed: false, code: 'key_not_found', message: 'unknown key id' };
      const dataHex = String(body.data_hex || '');
      const signature = neoWallet.sign(dataHex, account.privateKey);
      return {
        allowed: true,
        key_id: body.key_id,
        script_hash: `0x${account.scriptHash}`,
        address: account.address,
        digest: createHash('sha256').update(Buffer.from(dataHex, 'hex')).digest('hex'),
        signature,
        public_key: account.publicKey,
        invocation_script: `0c40${signature}`,
        verification_script: `0c21${account.publicKey}4156e7b327`,
      };
    }
    if (method === 'POST' && pathname === '/sign/transaction') {
      const account = custodyKeyAccounts[body.key_id];
      if (!account) return { allowed: false, code: 'key_not_found', message: 'unknown key id' };
      const unsignedHex = String(body.unsigned_hex || '');
      const signature = neoWallet.sign(unsignedHex, account.privateKey);
      return {
        allowed: true,
        key_id: body.key_id,
        script_hash: `0x${account.scriptHash}`,
        address: account.address,
        digest: createHash('sha256').update(Buffer.from(unsignedHex, 'hex')).digest('hex'),
        invocation_script: `0c40${signature}`,
        verification_script: `0c21${account.publicKey}4156e7b327`,
      };
    }
    return {
      allowed: false,
      code: 'not_found',
      message: `unexpected custody route ${method} ${pathname}`,
    };
  });
}

function restoreBaselineEnv() {
  for (const key of Object.keys(process.env)) {
    if (!Object.prototype.hasOwnProperty.call(baselineEnv, key)) {
      delete process.env[key];
    }
  }
  for (const [key, value] of Object.entries(baselineEnv)) {
    process.env[key] = value;
  }
}

async function resetWorkerTestFeedStateDir() {
  await fs.rm(workerTestFeedStateDir, { recursive: true, force: true });
  await fs.mkdir(workerTestFeedStateDir, { recursive: true });
}

async function restorePerTestState() {
  global.fetch = originalFetch;
  restoreBaselineEnv();
  // NeoDID unverified-uid opt-in is fail-closed by default; clear any per-test
  // override so each test starts from the secure default.
  delete process.env.MORPHEUS_NEODID_ALLOW_UNVERIFIED_UID;
  await resetWorkerTestFeedStateDir();
  __resetDstackClientStateForTests();
  __resetOracleKeyMaterialForTests();
  __resetFeedStateForTests();
  __resetNeoDidStateForTests();
  // The sign lanes are custody-only: reset the transport seam and re-install
  // the deterministic custody stub so no test is served a prior test's override.
  __resetSigningCachesForTests();
  __resetCustodyTransportForTests();
  installCustodyTransportForTests();
  // Retire any pooled oracle-fetch dispatchers so a real-undici path in one test
  // cannot leak an open connection pool into the next.
  await __resetOracleFetchDispatchersForTests();
}

test.beforeEach(async () => {
  await restorePerTestState();
});

test.afterEach(async () => {
  await restorePerTestState();
});

async function buildWeb3AuthFixture({
  claims = {},
  clientId = 'worker-test-web3auth-client',
  jwksUrl = 'https://jwks.test/web3auth.json',
  kid = 'worker-test-web3auth-key',
} = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = await exportJWK(publicKey);
  jwk.use = 'sig';
  jwk.alg = 'ES256';
  jwk.kid = kid;
  const token = await new SignJWT(claims)
    .setProtectedHeader({ alg: 'ES256', kid })
    .setIssuer('https://api-auth.web3auth.io')
    .setAudience(clientId)
    .setIssuedAt()
    .setExpirationTime('2h')
    .sign(privateKey);
  // The worker now resolves the JWKS URL and client id (audience) ONLY from
  // server-side env — never the request body — so a caller can't substitute
  // their own trust anchor. Pin the env to this fixture so the in-TEE verifier
  // accepts this token; the request-body web3auth_* fields are ignored.
  process.env.WEB3AUTH_JWKS_URL = jwksUrl;
  process.env.WEB3AUTH_CLIENT_ID = clientId;
  delete process.env.NEXT_PUBLIC_WEB3AUTH_CLIENT_ID;
  delete process.env.VITE_WEB3AUTH_CLIENT_ID;
  return {
    token,
    clientId,
    jwksUrl,
    jwks: { keys: [jwk] },
  };
}

function installWeb3AuthJwksFetch(jwksUrl, jwks) {
  global.fetch = async (url) => {
    const value = String(url);
    if (value === jwksUrl) {
      return new Response(JSON.stringify(jwks), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected fetch ${value}`);
  };
}

function computeExpectedMasterNullifier(provider, providerUid) {
  return createHash('sha256')
    .update(
      Buffer.concat([
        Buffer.from(provider, 'utf8'),
        Buffer.from([0x1f]),
        Buffer.from(providerUid, 'utf8'),
        Buffer.from([0x1f]),
        Buffer.from(
          createHash('sha256').update(process.env.NEODID_SECRET_SALT).digest('hex'),
          'hex'
        ),
      ])
    )
    .digest('hex');
}

const TEST_WASM_OK_BASE64 =
  'AGFzbQEAAAABEANgAAF/YAF/AX9gAn9/AX8CGAEIbW9ycGhldXMLbm93X3NlY29uZHMAAAMEAwEAAgUDAQABBgwCfwFBgAgLfwFBAAsHJQQGbWVtb3J5AgAFYWxsb2MAAQpyZXN1bHRfbGVuAAIDcnVuAAMKSQMRAQF/IwAhASMAIABqJAAgAQsEACMBCzAAQQQkAUGAEEH0ADoAAEGBEEHyADoAAEGCEEH1ADoAAEGDEEHlADoAABAAGkGAEAsAQwRuYW1lAQYBAANub3cCHwQAAAECAARzaXplAQRhZGRyAgADAgADcHRyAQNsZW4HEwIABGhlYXABCnJlc3VsdF9sZW4=';
const TEST_WASM_LOOP_BASE64 =
  'AGFzbQEAAAABEANgAX8Bf2AAAX9gAn9/AX8DBAMAAQIFAwEAAQYHAX8BQYAICwclBAZtZW1vcnkCAAVhbGxvYwAACnJlc3VsdF9sZW4AAQNydW4AAgoVAwQAIwALBABBAAsJAANADAALQQALACcEbmFtZQIXAwABAARzaXplAQACAgADcHRyAQNsZW4HBwEABGhlYXA=';
const TEST_ORACLE_ENCRYPTION_ALGORITHM = 'X25519-HKDF-SHA256-AES-256-GCM';
const TEST_ORACLE_ENCRYPTION_INFO = 'morpheus-confidential-payload-v2';
const AES_GCM_TAG_LENGTH_BYTES = 16;
const NEODID_BINDING_DOMAIN = Buffer.from('neodid-binding-v1', 'utf8');
const NEODID_ACTION_DOMAIN = Buffer.from('neodid-action-v1', 'utf8');
const NEODID_RECOVERY_DOMAIN = Buffer.from('neodid-recovery-v2', 'utf8');
const NEODID_ZKLOGIN_DOMAIN = Buffer.from('neodid-zklogin-v1', 'utf8');
// Matches the worker default network (testnet) and NeoDIDRegistry.NetworkMagicLe4().
const TESTNET_NEO_NETWORK_MAGIC = 894710606;

function encodeLengthPrefixedAscii(value = '') {
  const body = Buffer.from(String(value || ''), 'utf8');
  return Buffer.concat([Buffer.from([body.length]), body]);
}

function aaActionV3Payload() {
  return {
    provider: 'twitter',
    provider_uid: 'user-42',
    network: 'neo3-testnet',
    aa_contract: `0x${'11'.repeat(20)}`,
    verifier_contract: `0x${'33'.repeat(20)}`,
    account_id_raw: `0x${'22'.repeat(20)}`,
    account_id: 'acct-1',
    disposable_account: `0x${'44'.repeat(20)}`,
    expires_at: '1735689600',
    session_nonce: '7',
    callback_encoding: 'neo_n3_action_v3',
  };
}

function recoveryV3Payload() {
  return {
    provider: 'twitter',
    provider_uid: 'user-42',
    network: 'neo3-testnet',
    aa_contract: `0x${'33'.repeat(20)}`,
    account_id_raw: `0x${'66'.repeat(20)}`,
    account_address: `0x${'44'.repeat(20)}`,
    account_id: 'acct-1',
    new_owner: `0x${'55'.repeat(20)}`,
    recovery_nonce: '7',
    expires_at: '1735689600',
    callback_encoding: 'neo_n3_recovery_v3',
  };
}

function issueNeoDidTicket(route, payload) {
  return handler(
    new Request(`http://local/neodid/${route}`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(payload),
    })
  );
}

async function encryptForOracle(publicKeyBase64, plaintext) {
  const recipientPublicKeyBytes = Buffer.from(publicKeyBase64, 'base64');
  const recipientKey = await globalThis.crypto.subtle.importKey(
    'raw',
    recipientPublicKeyBytes,
    { name: 'X25519' },
    false,
    []
  );
  const ephemeralKeyPair = await globalThis.crypto.subtle.generateKey({ name: 'X25519' }, true, [
    'deriveBits',
  ]);
  const ephemeralPublicKeyBytes = new Uint8Array(
    await globalThis.crypto.subtle.exportKey('raw', ephemeralKeyPair.publicKey)
  );
  const sharedSecret = new Uint8Array(
    await globalThis.crypto.subtle.deriveBits(
      { name: 'X25519', public: recipientKey },
      ephemeralKeyPair.privateKey,
      256
    )
  );
  const keyMaterial = await globalThis.crypto.subtle.importKey('raw', sharedSecret, 'HKDF', false, [
    'deriveKey',
  ]);
  const info = new Uint8Array([
    ...new TextEncoder().encode(TEST_ORACLE_ENCRYPTION_INFO),
    ...ephemeralPublicKeyBytes,
    ...recipientPublicKeyBytes,
  ]);
  const aesKey = await globalThis.crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: recipientPublicKeyBytes,
      info,
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt']
  );
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const encryptedBytes = new Uint8Array(
    await globalThis.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      aesKey,
      new TextEncoder().encode(plaintext)
    )
  );
  const ciphertextBytes = encryptedBytes.slice(0, encryptedBytes.length - AES_GCM_TAG_LENGTH_BYTES);
  const tagBytes = encryptedBytes.slice(encryptedBytes.length - AES_GCM_TAG_LENGTH_BYTES);
  return Buffer.from(
    JSON.stringify({
      v: 2,
      alg: TEST_ORACLE_ENCRYPTION_ALGORITHM,
      epk: Buffer.from(ephemeralPublicKeyBytes).toString('base64'),
      iv: Buffer.from(iv).toString('base64'),
      ct: Buffer.from(ciphertextBytes).toString('base64'),
      tag: Buffer.from(tagBytes).toString('base64'),
    })
  ).toString('base64');
}

test('oracle query loads project provider defaults inside worker', async () => {
  process.env.SUPABASE_URL = 'https://supabase.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';

  global.fetch = async (url) => {
    const value = String(url);
    if (value.startsWith('https://supabase.test/rest/v1/morpheus_projects')) {
      return new Response(JSON.stringify([{ id: 'project-demo-id', slug: 'demo' }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (value.startsWith('https://supabase.test/rest/v1/morpheus_provider_configs')) {
      return new Response(
        JSON.stringify([
          {
            provider_id: 'twelvedata',
            enabled: true,
            config: { symbol: 'GAS-USD', endpoint: 'price', interval: '5min' },
          },
        ]),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }
      );
    }
    assert.match(value, /api\.twelvedata\.com\/price/);
    assert.match(value, /symbol=GAS%2FUSD/);
    assert.match(value, /interval=5min/);
    return new Response(JSON.stringify({ price: '3.21' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const res = await handler(
    new Request('http://local/oracle/query', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        provider: 'twelvedata',
        project_slug: 'demo',
        target_chain: 'neo_n3',
      }),
    })
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.mode, 'fetch');
  assert.match(body.body, /3\.21/);
});

test('oracle query rejects disabled project provider inside worker', async () => {
  process.env.SUPABASE_URL = 'https://supabase.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';

  global.fetch = async (url) => {
    const value = String(url);
    if (value.startsWith('https://supabase.test/rest/v1/morpheus_projects')) {
      return new Response(
        JSON.stringify([{ id: 'project-demo-disabled-id', slug: 'demo-disabled' }]),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }
      );
    }
    if (value.startsWith('https://supabase.test/rest/v1/morpheus_provider_configs')) {
      return new Response(
        JSON.stringify([
          {
            provider_id: 'twelvedata',
            enabled: false,
            config: { symbol: 'NEO-USD' },
          },
        ]),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }
      );
    }
    throw new Error(`unexpected fetch ${value}`);
  };

  const res = await handler(
    new Request('http://local/oracle/query', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        provider: 'twelvedata',
        project_slug: 'demo-disabled',
        target_chain: 'neo_n3',
      }),
    })
  );
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /disabled/);
});

test('neodid providers endpoint lists supported social providers', async () => {
  const res = await handler(
    new Request('http://local/neodid/providers', { headers: authHeaders() })
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.providers));
  assert.ok(body.providers.some((item) => item.id === 'web3auth'));
  assert.ok(body.providers.some((item) => item.id === 'twitter'));
  assert.ok(body.providers.some((item) => item.id === 'github'));
  assert.ok(body.providers.some((item) => item.id === 'google'));
  assert.ok(body.providers.some((item) => item.id === 'binance'));
  assert.ok(body.providers.some((item) => item.id === 'okx'));
  assert.ok(body.providers.some((item) => item.id === 'email'));
});

test('neodid providers report whether provider_uid is derived in the enclave (E3)', async () => {
  const res = await handler(
    new Request('http://local/neodid/providers', { headers: authHeaders() })
  );
  const body = await res.json();
  const web3auth = body.providers.find((item) => item.id === 'web3auth');
  const twitter = body.providers.find((item) => item.id === 'twitter');
  assert.equal(web3auth.derives_provider_uid_in_tee, true);
  assert.equal(twitter.derives_provider_uid_in_tee, false);
});

test('neodid runtime surfaces the provider_uid trust posture and flag state (E3)', async () => {
  const res = await handler(
    new Request('http://local/neodid/runtime', {
      method: 'POST',
      headers: authHeaders(),
      body: '{}',
    })
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.provider_uid_verification, 'runtime exposes provider_uid_verification');
  assert.ok(body.provider_uid_verification.tee_verified_providers.includes('web3auth'));
  assert.ok(!body.provider_uid_verification.tee_verified_providers.includes('twitter'));
  // Secure default (finding 24/33): unverified provider_uid is denied unless the
  // operator explicitly opts back in.
  assert.equal(body.provider_uid_verification.unverified_provider_uid_allowed, false);
});

test('neodid bind rejects an unverified provider_uid by default (E3, fail-closed)', async () => {
  const previous = process.env.MORPHEUS_NEODID_ALLOW_UNVERIFIED_UID;
  delete process.env.MORPHEUS_NEODID_ALLOW_UNVERIFIED_UID;
  try {
    const res = await handler(
      new Request('http://local/neodid/bind', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          vault_account: '0x6d0656f6dd91469db1c90cc1e574380613f43738',
          provider: 'twitter',
          provider_uid: 'twitter_uid_unverified',
          claim_type: 'Twitter_Verified',
        }),
      })
    );
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /not verified in the enclave|unverified provider_uid is disabled/i);
  } finally {
    if (previous === undefined) delete process.env.MORPHEUS_NEODID_ALLOW_UNVERIFIED_UID;
    else process.env.MORPHEUS_NEODID_ALLOW_UNVERIFIED_UID = previous;
  }
});

test('neodid bind allows an unverified provider_uid only with the explicit opt-in (E3)', async () => {
  const previous = process.env.MORPHEUS_NEODID_ALLOW_UNVERIFIED_UID;
  process.env.MORPHEUS_NEODID_ALLOW_UNVERIFIED_UID = 'true';
  try {
    const res = await handler(
      new Request('http://local/neodid/bind', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          vault_account: '0x6d0656f6dd91469db1c90cc1e574380613f43738',
          provider: 'twitter',
          provider_uid: 'twitter_uid_unverified',
          claim_type: 'Twitter_Verified',
        }),
      })
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.mode, 'neodid_bind');
    assert.match(body.master_nullifier, /^0x[0-9a-f]{64}$/);
  } finally {
    if (previous === undefined) delete process.env.MORPHEUS_NEODID_ALLOW_UNVERIFIED_UID;
    else process.env.MORPHEUS_NEODID_ALLOW_UNVERIFIED_UID = previous;
  }
});

test('neodid bind rejects an unverified provider_uid when default-deny is enabled (E3)', async () => {
  const previous = process.env.MORPHEUS_NEODID_ALLOW_UNVERIFIED_UID;
  process.env.MORPHEUS_NEODID_ALLOW_UNVERIFIED_UID = 'false';
  try {
    const res = await handler(
      new Request('http://local/neodid/bind', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          vault_account: '0x6d0656f6dd91469db1c90cc1e574380613f43738',
          provider: 'twitter',
          provider_uid: 'twitter_uid_unverified',
          claim_type: 'Twitter_Verified',
        }),
      })
    );
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /not verified in the enclave|unverified provider_uid is disabled/i);
  } finally {
    if (previous === undefined) delete process.env.MORPHEUS_NEODID_ALLOW_UNVERIFIED_UID;
    else process.env.MORPHEUS_NEODID_ALLOW_UNVERIFIED_UID = previous;
  }
});

test('neodid web3auth uid derivation is unaffected by default-deny (E3, TEE-verified)', async () => {
  const previous = process.env.MORPHEUS_NEODID_ALLOW_UNVERIFIED_UID;
  process.env.MORPHEUS_NEODID_ALLOW_UNVERIFIED_UID = 'false';
  __resetNeoDidStateForTests();
  const fixture = await buildWeb3AuthFixture({
    claims: { verifier: 'google', verifierId: 'tee@example.com' },
    clientId: 'worker-test-web3auth-tee',
    jwksUrl: 'https://jwks.test/web3auth-tee.json',
    kid: 'worker-test-web3auth-tee',
  });
  installWeb3AuthJwksFetch(fixture.jwksUrl, fixture.jwks);
  try {
    const res = await handler(
      new Request('http://local/neodid/bind', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          vault_account: '0x6d0656f6dd91469db1c90cc1e574380613f43738',
          provider: 'web3auth',
          id_token: fixture.token,
          web3auth_client_id: fixture.clientId,
          web3auth_jwks_url: fixture.jwksUrl,
          claim_type: 'Web3Auth_PrimaryIdentity',
        }),
      })
    );
    // web3auth derives the uid in-TEE so default-deny does not block it.
    assert.equal(res.status, 200);
  } finally {
    if (previous === undefined) delete process.env.MORPHEUS_NEODID_ALLOW_UNVERIFIED_UID;
    else process.env.MORPHEUS_NEODID_ALLOW_UNVERIFIED_UID = previous;
    __resetNeoDidStateForTests();
  }
});

test('neodid bind returns deterministic master nullifier and ticket signature', async () => {
  process.env.MORPHEUS_NEODID_ALLOW_UNVERIFIED_UID = 'true';
  const payload = {
    vault_account: '0x6d0656f6dd91469db1c90cc1e574380613f43738',
    provider: 'twitter',
    provider_uid: 'twitter_uid_12345',
    claim_type: 'Twitter_VIP',
    claim_value: 'followers_gt_1000',
    metadata: { tier: 'vip' },
  };

  const firstRes = await handler(
    new Request('http://local/neodid/bind', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(payload),
    })
  );
  assert.equal(firstRes.status, 200);
  const first = await firstRes.json();
  assert.equal(first.mode, 'neodid_bind');
  assert.match(first.master_nullifier, /^0x[0-9a-f]{64}$/);
  assert.match(first.metadata_hash, /^0x[0-9a-f]{64}$/);
  assert.match(first.digest, /^0x[0-9a-f]{64}$/);
  assert.equal(first.binding_mode, 'commitment-v1');
  assert.match(first.claim_commitment, /^0x[0-9a-f]{64}$/);
  assert.match(first.commitment_digest, /^0x[0-9a-f]{64}$/);
  assert.ok(first.commitment_signature);
  assert.ok(first.commitment_public_key);
  assert.ok(first.signature);
  assert.ok(first.public_key);

  const secondRes = await handler(
    new Request('http://local/neodid/bind', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(payload),
    })
  );
  assert.equal(secondRes.status, 200);
  const second = await secondRes.json();
  assert.equal(second.master_nullifier, first.master_nullifier);
});

test('neodid digest signing is custody-side and rejects caller key material', async () => {
  process.env.MORPHEUS_NEODID_ALLOW_UNVERIFIED_UID = 'true';
  const payload = {
    vault_account: '0x6d0656f6dd91469db1c90cc1e574380613f43738',
    provider: 'twitter',
    provider_uid: 'twitter_uid_custody_lane',
    claim_type: 'Twitter_VIP',
    claim_value: 'followers_gt_1000',
  };

  // A caller key in the body must not become the signer (key-confusion guard).
  // The guard's message names key-material literals, so M-06 sanitization masks
  // it to 'internal error' on the caller-facing surface.
  const rejected = await handler(
    new Request('http://local/neodid/bind', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ ...payload, private_key: custodyWorkerAccount.privateKey }),
    })
  );
  assert.equal(rejected.status, 400);
  const rejectedBody = await rejected.json();
  assert.equal(rejectedBody.error, 'internal error');

  // The clean request is signed by the custody worker key.
  const res = await handler(
    new Request('http://local/neodid/bind', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(payload),
    })
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.public_key, custodyWorkerAccount.publicKey);
  assert.match(body.signature, /^[0-9a-f]{128}$/);
});

test('neodid bind verifies web3auth id_token and derives provider uid inside the worker', async () => {
  __resetNeoDidStateForTests();
  const fixture = await buildWeb3AuthFixture({
    claims: {
      aggregateVerifier: 'google-oauth',
      aggregateVerifierId: 'alice@example.com',
    },
    clientId: 'worker-test-web3auth-client-bind',
    jwksUrl: 'https://jwks.test/web3auth-bind.json',
    kid: 'worker-test-web3auth-bind',
  });
  installWeb3AuthJwksFetch(fixture.jwksUrl, fixture.jwks);

  const res = await handler(
    new Request('http://local/neodid/bind', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        vault_account: '0x6d0656f6dd91469db1c90cc1e574380613f43738',
        provider: 'web3auth',
        id_token: fixture.token,
        web3auth_client_id: fixture.clientId,
        web3auth_jwks_url: fixture.jwksUrl,
        claim_type: 'Web3Auth_PrimaryIdentity',
        claim_value: 'linked_social_root',
      }),
    })
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  const expectedProviderUid = 'web3auth:google-oauth:alice@example.com';
  assert.equal(body.provider, 'web3auth');
  assert.equal(
    body.master_nullifier,
    `0x${computeExpectedMasterNullifier('web3auth', expectedProviderUid)}`
  );
});

test('neodid bind rejects a mismatched explicit web3auth provider_uid', async () => {
  __resetNeoDidStateForTests();
  const fixture = await buildWeb3AuthFixture({
    claims: {
      verifier: 'google',
      verifierId: 'alice@example.com',
    },
    clientId: 'worker-test-web3auth-client-mismatch',
    jwksUrl: 'https://jwks.test/web3auth-mismatch.json',
    kid: 'worker-test-web3auth-mismatch',
  });
  installWeb3AuthJwksFetch(fixture.jwksUrl, fixture.jwks);

  const res = await handler(
    new Request('http://local/neodid/bind', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        vault_account: '0x6d0656f6dd91469db1c90cc1e574380613f43738',
        provider: 'web3auth',
        provider_uid: 'web3auth:google:bob@example.com',
        id_token: fixture.token,
        web3auth_client_id: fixture.clientId,
        web3auth_jwks_url: fixture.jwksUrl,
        claim_type: 'Web3Auth_PrimaryIdentity',
      }),
    })
  );
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /provider_uid does not match verified id_token/);
});

test('neodid bind requires a web3auth client id so audience is always verified', async () => {
  __resetNeoDidStateForTests();
  const fixture = await buildWeb3AuthFixture({
    claims: {
      verifier: 'google',
      verifierId: 'alice@example.com',
    },
    clientId: 'worker-test-web3auth-client-required',
    jwksUrl: 'https://jwks.test/web3auth-required.json',
    kid: 'worker-test-web3auth-required',
  });
  installWeb3AuthJwksFetch(fixture.jwksUrl, fixture.jwks);
  // No server-side client id configured → audience cannot be verified.
  delete process.env.WEB3AUTH_CLIENT_ID;

  const res = await handler(
    new Request('http://local/neodid/bind', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        vault_account: '0x6d0656f6dd91469db1c90cc1e574380613f43738',
        provider: 'web3auth',
        id_token: fixture.token,
        // Even a caller-supplied client id must NOT satisfy the audience check.
        web3auth_client_id: fixture.clientId,
        web3auth_jwks_url: fixture.jwksUrl,
        claim_type: 'Web3Auth_PrimaryIdentity',
      }),
    })
  );
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /WEB3AUTH_CLIENT_ID is required/);
});

test('neodid web3auth verification ignores caller-supplied jwks_url/client_id (env is the trust anchor)', async () => {
  __resetNeoDidStateForTests();
  // Legit, server-pinned verifier config (buildWeb3AuthFixture pins env to it).
  const legit = await buildWeb3AuthFixture({
    claims: { aggregateVerifier: 'google-oauth', aggregateVerifierId: 'victim@example.com' },
    clientId: 'worker-test-web3auth-legit',
    jwksUrl: 'https://jwks.test/web3auth-legit.json',
    kid: 'worker-test-web3auth-legit',
  });
  // Attacker self-hosts their own JWKS + audience and signs an id_token for the
  // victim's uid — the verifier-confusion the fix must block.
  const attacker = await buildWeb3AuthFixture({
    claims: { aggregateVerifier: 'google-oauth', aggregateVerifierId: 'victim@example.com' },
    clientId: 'attacker-client',
    jwksUrl: 'https://attacker.test/jwks.json',
    kid: 'attacker-key',
  });
  // buildWeb3AuthFixture pins env to the LAST fixture built; restore the server
  // config to the legit anchor so the test reflects a real (env-configured) deploy.
  process.env.WEB3AUTH_JWKS_URL = legit.jwksUrl;
  process.env.WEB3AUTH_CLIENT_ID = legit.clientId;
  global.fetch = async (url) => {
    const value = String(url);
    if (value === legit.jwksUrl) {
      return new Response(JSON.stringify(legit.jwks), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (value === attacker.jwksUrl) {
      // Reaching here means the env pin was bypassed (the bug). Serve it so the
      // assertion below — not an unexpected-fetch throw — reports the regression.
      return new Response(JSON.stringify(attacker.jwks), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected fetch ${value}`);
  };

  const res = await handler(
    new Request('http://local/neodid/bind', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        vault_account: '0x6d0656f6dd91469db1c90cc1e574380613f43738',
        provider: 'web3auth',
        id_token: attacker.token,
        // Malicious trust-anchor overrides — must be ignored by the worker.
        web3auth_jwks_url: attacker.jwksUrl,
        web3auth_client_id: attacker.clientId,
        claim_type: 'Web3Auth_PrimaryIdentity',
      }),
    })
  );
  // The attacker token is signed by a key absent from the env-pinned legit JWKS,
  // so verification must fail. A vulnerable worker would fetch the attacker JWKS
  // (caller-controlled) and accept the forged identity.
  assert.equal(res.status, 400);
  const forged = await res.json();
  assert.ok(forged.error, 'expected a web3auth verification error');
});

test('neodid bind digest binds the network magic for on-chain parity (finding 45)', async () => {
  process.env.MORPHEUS_NEODID_ALLOW_UNVERIFIED_UID = 'true';
  const vault = '0x6d0656f6dd91469db1c90cc1e574380613f43738';
  const res = await handler(
    new Request('http://local/neodid/bind', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        vault_account: vault,
        provider: 'twitter',
        provider_uid: 'twitter_uid_magic',
        claim_type: 'Twitter_VIP',
        claim_value: 'followers_gt_1000',
        metadata: { tier: 'vip' },
      }),
    })
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  const fields = [
    NEODID_BINDING_DOMAIN,
    Buffer.from(vault.replace(/^0x/, ''), 'hex'),
    encodeLengthPrefixedAscii('twitter'),
    encodeLengthPrefixedAscii('Twitter_VIP'),
    encodeLengthPrefixedAscii('followers_gt_1000'),
    Buffer.from(body.master_nullifier.replace(/^0x/, ''), 'hex'),
    Buffer.from(body.metadata_hash.replace(/^0x/, ''), 'hex'),
  ];
  const withMagic = createHash('sha256')
    .update(Buffer.concat([...fields, neoNetworkMagicLe4(TESTNET_NEO_NETWORK_MAGIC)]))
    .digest('hex');
  const withoutMagic = createHash('sha256').update(Buffer.concat(fields)).digest('hex');
  // The worker digest must match the contract layout (NetworkMagicLe4 appended)…
  assert.equal(body.digest, `0x${withMagic}`, 'bind digest must append the LE4 network magic');
  // …and must NOT match the pre-fix layout (proves the magic is actually bound).
  assert.notEqual(body.digest, `0x${withoutMagic}`);
});

test('neodid action-ticket generates action-specific nullifiers', async () => {
  process.env.MORPHEUS_NEODID_ALLOW_UNVERIFIED_UID = 'true';
  const common = {
    provider: 'twitter',
    provider_uid: 'twitter_uid_12345',
    disposable_account: '0x89b05cac00804648c666b47ecb1c57bc185821b7',
  };

  const firstRes = await handler(
    new Request('http://local/neodid/action-ticket', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ ...common, action_id: 'DAO_Vote_42' }),
    })
  );
  assert.equal(firstRes.status, 200);
  const first = await firstRes.json();
  assert.equal(first.mode, 'neodid_action_ticket');
  assert.match(first.action_nullifier, /^0x[0-9a-f]{64}$/);
  assert.ok(first.signature);
  const expectedDigest = createHash('sha256')
    .update(
      Buffer.concat([
        NEODID_ACTION_DOMAIN,
        Buffer.from(common.disposable_account.replace(/^0x/, ''), 'hex'),
        encodeLengthPrefixedAscii('DAO_Vote_42'),
        Buffer.from(first.action_nullifier.replace(/^0x/, ''), 'hex'),
        // Network magic bound into the digest (matches NeoDIDRegistry).
        neoNetworkMagicLe4(TESTNET_NEO_NETWORK_MAGIC),
      ])
    )
    .digest('hex');
  assert.equal(first.digest, `0x${expectedDigest}`);

  const secondRes = await handler(
    new Request('http://local/neodid/action-ticket', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ ...common, action_id: 'Airdrop_Season_1' }),
    })
  );
  assert.equal(secondRes.status, 200);
  const second = await secondRes.json();
  assert.notEqual(first.action_nullifier, second.action_nullifier);
});

test('neodid action-ticket accepts okex alias and normalizes to okx', async () => {
  process.env.MORPHEUS_NEODID_ALLOW_UNVERIFIED_UID = 'true';
  const res = await handler(
    new Request('http://local/neodid/action-ticket', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        provider: 'okex',
        provider_uid: 'exchange_uid_123',
        disposable_account: '0x89b05cac00804648c666b47ecb1c57bc185821b7',
        action_id: 'DAO_Vote_42',
      }),
    })
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.mode, 'neodid_action_ticket');
  assert.ok(body.signature);
});

test('neodid action-ticket preserves the legacy v1 golden with default and explicit v1 encoding', async () => {
  process.env.MORPHEUS_NEODID_ALLOW_UNVERIFIED_UID = 'true';
  process.env.NEODID_SECRET_SALT = 'unit-test-salt-text';
  delete process.env.MORPHEUS_NETWORK;
  const legacy = {
    provider: 'twitter',
    provider_uid: 'user-42',
    action_id: 'act-1',
    disposable_account: `0x${'22'.repeat(20)}`,
  };
  for (const callbackEncoding of [undefined, 'neo_n3_action_v1']) {
    const res = await issueNeoDidTicket('action-ticket', {
      ...legacy,
      ...(callbackEncoding ? { callback_encoding: callbackEncoding } : {}),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.action_id, 'act-1');
    assert.equal(
      body.action_nullifier,
      '0x09991669650a654a54ace219dc7d0958330d2ff772f05117d949548c691a429d'
    );
    assert.equal(body.digest, '0xe1edd51a9b3fa5a1c3c62a947a72633b4a55a3ac487eb38cfbdcfb3c38953e53');
  }
});

test('neodid action v3 matches the Rust golden and binds action id and digest to the raw account', async () => {
  process.env.MORPHEUS_NEODID_ALLOW_UNVERIFIED_UID = 'true';
  process.env.NEODID_SECRET_SALT = 'unit-test-salt-text';
  const actionId = 'aa_proxy:ca0d3b5865caf8b07c0a2b2eb7ea05ded9b7f4eb81a657ed64316af587553557';
  const res = await issueNeoDidTicket('action-ticket', aaActionV3Payload());
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.action_id, actionId);
  assert.equal(
    body.action_nullifier,
    '0x41a081d59869e15b50c01d3143eeddbcf46c27e804240d83516c9c5325335d05'
  );
  assert.equal(body.digest, '0x6997b70a6dd9a8d54c56c9c5792ebec5c780ee884d73464ec4d9eed6b9b405ae');

  const explicitRes = await issueNeoDidTicket('action-ticket', {
    ...aaActionV3Payload(),
    action_id: actionId,
  });
  assert.equal(explicitRes.status, 200);
  assert.equal((await explicitRes.json()).digest, body.digest);

  const defaultNoncePayload = aaActionV3Payload();
  delete defaultNoncePayload.session_nonce;
  const defaultNonceRes = await issueNeoDidTicket('action-ticket', defaultNoncePayload);
  assert.equal(defaultNonceRes.status, 200);
  const defaultNonce = await defaultNonceRes.json();
  assert.equal(
    defaultNonce.action_id,
    'aa_proxy:23c9db0c12665b099e7e384173cd2474110a94c7d73b87a27b22b139650d66ae'
  );
  assert.equal(
    defaultNonce.digest,
    '0x7dec99dc9584272e21cd46e5780dd33667e70ff18ad8433cbab6ef1d05e5dadb'
  );

  const otherRawRes = await issueNeoDidTicket('action-ticket', {
    ...aaActionV3Payload(),
    account_id_raw: `0x${'55'.repeat(20)}`,
  });
  assert.equal(otherRawRes.status, 200);
  const otherRaw = await otherRawRes.json();
  assert.notEqual(otherRaw.action_id, body.action_id);
  assert.notEqual(otherRaw.digest, body.digest);

  const foreignRes = await issueNeoDidTicket('action-ticket', {
    ...aaActionV3Payload(),
    action_id: 'aa_proxy:foreign',
  });
  assert.equal(foreignRes.status, 400);
  assert.match((await foreignRes.json()).error, /action_id.*derived AA action/);
});

test('neodid action v3 rejects missing context and non-decimal nonce or expiry', async () => {
  process.env.MORPHEUS_NEODID_ALLOW_UNVERIFIED_UID = 'true';
  for (const field of [
    'network',
    'aa_contract',
    'verifier_contract',
    'account_id_raw',
    'account_id',
    'disposable_account',
    'expires_at',
  ]) {
    const payload = aaActionV3Payload();
    delete payload[field];
    const res = await issueNeoDidTicket('action-ticket', payload);
    assert.equal(res.status, 400, field);
    assert.match((await res.json()).error, new RegExp(field), field);
  }
  for (const field of ['session_nonce', 'expires_at']) {
    const res = await issueNeoDidTicket('action-ticket', {
      ...aaActionV3Payload(),
      [field]: 'not-decimal',
    });
    assert.equal(res.status, 400, field);
    assert.match((await res.json()).error, new RegExp(`${field} must be a decimal string`));
  }
});

test('neodid recovery-ticket rejects an unverified provider_uid by default (E3 fail-closed)', async () => {
  const keyRes = await handler(
    new Request('http://local/oracle/public-key', { headers: authHeaders() })
  );
  assert.equal(keyRes.status, 200);
  const keyMeta = await keyRes.json();
  const encryptedParams = await encryptForOracle(
    keyMeta.public_key,
    JSON.stringify({ provider_uid: 'github_uid_777' })
  );
  const res = await handler(
    new Request('http://local/neodid/recovery-ticket', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        provider: 'github',
        aa_contract: '0xf54d8584ef82315c1800373272ab08ae0db2d5ef',
        account_id_raw: '0x0268a387913b250166ddec032b03332690a1ef78',
        account_id: 'aa-social-recovery-demo',
        new_owner: '0x89b05cac00804648c666b47ecb1c57bc185821b7',
        recovery_nonce: '7',
        expires_at: '1735689600',
        encrypted_params: encryptedParams,
      }),
    })
  );
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /requires a TEE-verified provider_uid/i);
});

test('neodid recovery-ticket supports confidential provider payloads and binds AA recovery context', async () => {
  const previousAllowlist = process.env.MORPHEUS_NEODID_RECOVERY_ALLOW_UNVERIFIED_PROVIDERS;
  process.env.MORPHEUS_NEODID_RECOVERY_ALLOW_UNVERIFIED_PROVIDERS = 'github';
  try {
    const keyRes = await handler(
      new Request('http://local/oracle/public-key', { headers: authHeaders() })
    );
    assert.equal(keyRes.status, 200);
    const keyMeta = await keyRes.json();
    const encryptedParams = await encryptForOracle(
      keyMeta.public_key,
      JSON.stringify({
        provider_uid: 'github_uid_777',
      })
    );

    const res = await handler(
      new Request('http://local/neodid/recovery-ticket', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          provider: 'github',
          aa_contract: '0xf54d8584ef82315c1800373272ab08ae0db2d5ef',
          account_id_raw: '0x0268a387913b250166ddec032b03332690a1ef78',
          verifier_contract: '0x03013f49c42a14546c8bbe58f9d434c3517fccab',
          account_address: '0x6d0656f6dd91469db1c90cc1e574380613f43738',
          account_id: 'aa-social-recovery-demo',
          new_owner: '0x89b05cac00804648c666b47ecb1c57bc185821b7',
          recovery_nonce: '7',
          expires_at: '1735689600',
          encrypted_params: encryptedParams,
        }),
      })
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.mode, 'neodid_recovery_ticket');
    assert.equal(body.provider, 'github');
    assert.equal(body.account_id, 'aa-social-recovery-demo');
    assert.equal(body.recovery_nonce, '7');
    assert.equal(body.expires_at, '1735689600');
    assert.match(body.master_nullifier, /^0x[0-9a-f]{64}$/);
    assert.match(body.action_nullifier, /^0x[0-9a-f]{64}$/);
    assert.match(body.digest, /^0x[0-9a-f]{64}$/);
    assert.ok(body.signature);
    assert.ok(body.public_key);
    const expectedRecoveryDigest = createHash('sha256')
      .update(
        Buffer.concat([
          NEODID_RECOVERY_DOMAIN,
          encodeLengthPrefixedAscii('neo_n3'),
          Buffer.from('0xf54d8584ef82315c1800373272ab08ae0db2d5ef'.replace(/^0x/, ''), 'hex'),
          Buffer.from('0x0268a387913b250166ddec032b03332690a1ef78'.replace(/^0x/, ''), 'hex'),
          Buffer.from('0x03013f49c42a14546c8bbe58f9d434c3517fccab'.replace(/^0x/, ''), 'hex'),
          Buffer.from('0x6d0656f6dd91469db1c90cc1e574380613f43738'.replace(/^0x/, ''), 'hex'),
          encodeLengthPrefixedAscii('aa-social-recovery-demo'),
          Buffer.from('0x89b05cac00804648c666b47ecb1c57bc185821b7'.replace(/^0x/, ''), 'hex'),
          encodeLengthPrefixedAscii('7'),
          encodeLengthPrefixedAscii('1735689600'),
          encodeLengthPrefixedAscii(body.action_id),
          Buffer.from(body.master_nullifier.replace(/^0x/, ''), 'hex'),
          Buffer.from(body.action_nullifier.replace(/^0x/, ''), 'hex'),
        ])
      )
      .digest('hex');
    assert.equal(body.digest, `0x${expectedRecoveryDigest}`);

    const secondRes = await handler(
      new Request('http://local/neodid/recovery-ticket', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          provider: 'github',
          aa_contract: '0xf54d8584ef82315c1800373272ab08ae0db2d5ef',
          account_id_raw: '0x0268a387913b250166ddec032b03332690a1ef78',
          account_id: 'aa-social-recovery-demo',
          new_owner: '0x89b05cac00804648c666b47ecb1c57bc185821b7',
          recovery_nonce: '8',
          expires_at: '1735689600',
          encrypted_params: encryptedParams,
        }),
      })
    );
    assert.equal(secondRes.status, 200);
    const second = await secondRes.json();
    assert.notEqual(body.action_nullifier, second.action_nullifier);
  } finally {
    if (previousAllowlist === undefined) {
      delete process.env.MORPHEUS_NEODID_RECOVERY_ALLOW_UNVERIFIED_PROVIDERS;
    } else {
      process.env.MORPHEUS_NEODID_RECOVERY_ALLOW_UNVERIFIED_PROVIDERS = previousAllowlist;
    }
  }
});

test('neodid recovery action id matches the Rust golden and rejects foreign or cross-account bindings', async () => {
  process.env.MORPHEUS_NEODID_RECOVERY_ALLOW_UNVERIFIED_PROVIDERS = 'twitter';
  process.env.NEODID_SECRET_SALT = 'unit-test-salt-text';
  const actionId = 'aa_recovery:a01b356e0ca61b0e9d44433ff86628e8d299bb045ae410a000e0bac5cfef80f8';
  const res = await issueNeoDidTicket('recovery-ticket', recoveryV3Payload());
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.action_id, actionId);
  assert.equal(body.callback_encoding, 'neo_n3_recovery_v3');
  assert.equal(
    body.action_nullifier,
    '0x4751923c6caacd2506e954a94a46badfd16b49fbbc49fc56ebab154e4500cd2f'
  );
  assert.equal(body.digest, '0x052563ca766bef9e5fb108668d46e6f834a7099b06aea69e03dc334a96624f8a');

  const explicitRes = await issueNeoDidTicket('recovery-ticket', {
    ...recoveryV3Payload(),
    action_id: actionId,
  });
  assert.equal(explicitRes.status, 200);
  assert.equal((await explicitRes.json()).digest, body.digest);

  const otherRawRes = await issueNeoDidTicket('recovery-ticket', {
    ...recoveryV3Payload(),
    account_id_raw: `0x${'67'.repeat(20)}`,
  });
  assert.equal(otherRawRes.status, 200);
  const otherRaw = await otherRawRes.json();
  assert.equal(otherRaw.account_id, body.account_id);
  assert.notEqual(otherRaw.action_id, body.action_id);
  assert.notEqual(otherRaw.digest, body.digest);

  const foreignRes = await issueNeoDidTicket('recovery-ticket', {
    ...recoveryV3Payload(),
    action_id: 'aa_recovery:foreign',
  });
  assert.equal(foreignRes.status, 400);
  assert.match((await foreignRes.json()).error, /action_id.*derived recovery action/);

  const missingRaw = recoveryV3Payload();
  delete missingRaw.account_id_raw;
  const missingRawRes = await issueNeoDidTicket('recovery-ticket', missingRaw);
  assert.equal(missingRawRes.status, 400);
  assert.match((await missingRawRes.json()).error, /account_id_raw/);

  const badNonceRes = await issueNeoDidTicket('recovery-ticket', {
    ...recoveryV3Payload(),
    recovery_nonce: 'n-1',
  });
  assert.equal(badNonceRes.status, 400);
  assert.match((await badNonceRes.json()).error, /recovery_nonce must be a decimal string/);
});

test('neodid recovery-ticket accepts confidential web3auth id_token payloads', async () => {
  __resetNeoDidStateForTests();
  const fixture = await buildWeb3AuthFixture({
    claims: {
      aggregateVerifier: 'web3auth-google',
      aggregateVerifierId: 'alice@example.com',
    },
    clientId: 'worker-test-web3auth-client-recovery',
    jwksUrl: 'https://jwks.test/web3auth-recovery.json',
    kid: 'worker-test-web3auth-recovery',
  });
  installWeb3AuthJwksFetch(fixture.jwksUrl, fixture.jwks);

  const keyRes = await handler(
    new Request('http://local/oracle/public-key', { headers: authHeaders() })
  );
  assert.equal(keyRes.status, 200);
  const keyMeta = await keyRes.json();
  const encryptedParams = await encryptForOracle(
    keyMeta.public_key,
    JSON.stringify({
      id_token: fixture.token,
      web3auth_client_id: fixture.clientId,
      web3auth_jwks_url: fixture.jwksUrl,
    })
  );

  const res = await handler(
    new Request('http://local/neodid/recovery-ticket', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        provider: 'web3auth',
        aa_contract: '0xf54d8584ef82315c1800373272ab08ae0db2d5ef',
        account_id_raw: '0x0268a387913b250166ddec032b03332690a1ef78',
        verifier_contract: '0x03013f49c42a14546c8bbe58f9d434c3517fccab',
        account_address: '0x6d0656f6dd91469db1c90cc1e574380613f43738',
        account_id: 'aa-social-recovery-demo',
        new_owner: '0x89b05cac00804648c666b47ecb1c57bc185821b7',
        recovery_nonce: '7',
        expires_at: '1735689600',
        encrypted_params: encryptedParams,
      }),
    })
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.provider, 'web3auth');
  assert.match(body.master_nullifier, /^0x[0-9a-f]{64}$/);
  assert.match(body.action_nullifier, /^0x[0-9a-f]{64}$/);
});

test('neodid recovery-ticket resolves encrypted_params_ref under the worker network when network names the chain family', async () => {
  __resetNeoDidStateForTests();
  process.env.SUPABASE_URL = 'https://supabase.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
  const fixture = await buildWeb3AuthFixture({
    claims: {
      aggregateVerifier: 'web3auth-google',
      aggregateVerifierId: 'alice@example.com',
    },
    clientId: 'worker-test-web3auth-client-recovery-ref',
    jwksUrl: 'https://jwks.test/web3auth-recovery-ref.json',
    kid: 'worker-test-web3auth-recovery-ref',
  });

  const keyRes = await handler(
    new Request('http://local/oracle/public-key', { headers: authHeaders() })
  );
  assert.equal(keyRes.status, 200);
  const keyMeta = await keyRes.json();
  const encryptedParams = await encryptForOracle(
    keyMeta.public_key,
    JSON.stringify({
      id_token: fixture.token,
      web3auth_client_id: fixture.clientId,
      web3auth_jwks_url: fixture.jwksUrl,
    })
  );

  const secretLookups = [];
  global.fetch = async (url) => {
    const value = String(url);
    if (value === fixture.jwksUrl) {
      return new Response(JSON.stringify(fixture.jwks), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (value.startsWith('https://supabase.test/rest/v1/morpheus_encrypted_secrets')) {
      secretLookups.push(new URL(value).searchParams.get('network'));
      return new Response(
        JSON.stringify([
          { id: '55555555-5555-5555-5555-555555555555', ciphertext: encryptedParams },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    throw new Error(`unexpected fetch ${value}`);
  };

  // The documented Large-JWT recovery request: "network": "neo_n3" names the
  // ticket's chain family, so the ref is looked up under the worker network.
  const recovery = {
    provider: 'web3auth',
    network: 'neo_n3',
    aa_contract: '0xf54d8584ef82315c1800373272ab08ae0db2d5ef',
    account_id_raw: '0x0268a387913b250166ddec032b03332690a1ef78',
    verifier_contract: '0x03013f49c42a14546c8bbe58f9d434c3517fccab',
    account_id: 'aa-social-recovery-demo',
    new_owner: '0x89b05cac00804648c666b47ecb1c57bc185821b7',
    recovery_nonce: '7',
    expires_at: '1735689600',
    encrypted_params_ref: '55555555-5555-5555-5555-555555555555',
    request_id: 'neodid-recovery-ref',
  };
  const res = await handler(
    new Request('http://local/neodid/recovery-ticket', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(recovery),
    })
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.network, 'neo_n3');
  assert.equal(body.provider, 'web3auth');
  assert.ok(secretLookups.length > 0);
  assert.ok(secretLookups.every((network) => network === 'eq.testnet'));

  // Only the recovery lane reads network as a chain family; on a bind ticket
  // the same label is still an unsupported network, refused before any lookup.
  secretLookups.length = 0;
  const bindRes = await handler(
    new Request('http://local/neodid/bind', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        provider: 'web3auth',
        network: 'neo_n3',
        vault_account: '0x6d0656f6dd91469db1c90cc1e574380613f43738',
        encrypted_params_ref: '55555555-5555-5555-5555-555555555555',
        request_id: 'neodid-bind-ref',
      }),
    })
  );
  assert.equal(bindRes.status, 400);
  assert.match((await bindRes.json()).error, /unsupported Neo network: neo_n3/);
  assert.deepEqual(secretLookups, []);
});

test('neodid zklogin-ticket binds a web3auth identity root to an AA operation digest', async () => {
  __resetNeoDidStateForTests();
  const fixture = await buildWeb3AuthFixture({
    claims: {
      aggregateVerifier: 'web3auth-google',
      aggregateVerifierId: 'alice@example.com',
    },
    clientId: 'worker-test-web3auth-client-zklogin',
    jwksUrl: 'https://jwks.test/web3auth-zklogin.json',
    kid: 'worker-test-web3auth-zklogin',
  });
  installWeb3AuthJwksFetch(fixture.jwksUrl, fixture.jwks);

  const keyRes = await handler(
    new Request('http://local/oracle/public-key', { headers: authHeaders() })
  );
  assert.equal(keyRes.status, 200);
  const keyMeta = await keyRes.json();
  const encryptedParams = await encryptForOracle(
    keyMeta.public_key,
    JSON.stringify({
      id_token: fixture.token,
      web3auth_client_id: fixture.clientId,
      web3auth_jwks_url: fixture.jwksUrl,
    })
  );

  const res = await handler(
    new Request('http://local/neodid/zklogin-ticket', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        provider: 'web3auth',
        verifier_contract: '0x03013f49c42a14546c8bbe58f9d434c3517fccab',
        account_id_hash: '0xf951cd3eb5196dacde99b339c5dcca37ac38cc22',
        target_contract: '0xd2a4cff31913016155e38e474a2c06d08be276cf',
        method: 'transfer',
        args_hash: `0x${'12'.repeat(32)}`,
        nonce: '4',
        deadline: '1710001234',
        encrypted_params: encryptedParams,
      }),
    })
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.mode, 'neodid_zklogin_ticket');
  assert.equal(body.provider, 'web3auth');
  assert.equal(body.method, 'transfer');
  assert.equal(body.nonce, '4');
  assert.equal(body.deadline, '1710001234');
  assert.match(body.master_nullifier, /^0x[0-9a-f]{64}$/);
  assert.match(body.action_nullifier, /^0x[0-9a-f]{64}$/);
  assert.match(body.digest, /^0x[0-9a-f]{64}$/);
  assert.ok(body.signature);
  assert.ok(body.public_key);

  const expectedDigest = createHash('sha256')
    .update(
      Buffer.concat([
        NEODID_ZKLOGIN_DOMAIN,
        Buffer.from('0x03013f49c42a14546c8bbe58f9d434c3517fccab'.replace(/^0x/, ''), 'hex'),
        Buffer.from('0xf951cd3eb5196dacde99b339c5dcca37ac38cc22'.replace(/^0x/, ''), 'hex'),
        Buffer.from('0xd2a4cff31913016155e38e474a2c06d08be276cf'.replace(/^0x/, ''), 'hex'),
        encodeLengthPrefixedAscii('transfer'),
        Buffer.from('12'.repeat(32), 'hex'),
        encodeUint256Word('4'),
        encodeUint256Word('1710001234'),
        encodeLengthPrefixedAscii('web3auth'),
        Buffer.from(body.master_nullifier.replace(/^0x/, ''), 'hex'),
        Buffer.from(body.action_nullifier.replace(/^0x/, ''), 'hex'),
      ])
    )
    .digest('hex');
  assert.equal(body.digest, `0x${expectedDigest}`);
});

test('neodid bind resolves encrypted_params_ref through Supabase ciphertext storage', async () => {
  __resetNeoDidStateForTests();
  process.env.SUPABASE_URL = 'https://supabase.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';

  const fixture = await buildWeb3AuthFixture({
    claims: {
      aggregateVerifier: 'google-oauth',
      aggregateVerifierId: 'alice@example.com',
    },
    clientId: 'worker-test-web3auth-client-ref',
    jwksUrl: 'https://jwks.test/web3auth-ref.json',
    kid: 'worker-test-web3auth-ref',
  });

  const keyRes = await handler(
    new Request('http://local/oracle/public-key', { headers: authHeaders() })
  );
  assert.equal(keyRes.status, 200);
  const keyMeta = await keyRes.json();
  const encryptedParams = await encryptForOracle(
    keyMeta.public_key,
    JSON.stringify({
      id_token: fixture.token,
      web3auth_client_id: fixture.clientId,
      web3auth_jwks_url: fixture.jwksUrl,
    })
  );

  global.fetch = async (url) => {
    const value = String(url);
    if (value === fixture.jwksUrl) {
      return new Response(JSON.stringify(fixture.jwks), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (value.startsWith('https://supabase.test/rest/v1/morpheus_encrypted_secrets')) {
      return new Response(
        JSON.stringify([
          {
            id: '11111111-1111-1111-1111-111111111111',
            ciphertext: encryptedParams,
          },
        ]),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }
      );
    }
    throw new Error(`unexpected fetch ${value}`);
  };

  const res = await handler(
    new Request('http://local/neodid/bind', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        vault_account: '0x6d0656f6dd91469db1c90cc1e574380613f43738',
        provider: 'web3auth',
        encrypted_params_ref: '11111111-1111-1111-1111-111111111111',
        request_id: 'neodid-ref-resolution',
        claim_type: 'Web3Auth_PrimaryIdentity',
        claim_value: 'ref-test',
      }),
    })
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.provider, 'web3auth');
  assert.match(body.master_nullifier, /^0x[0-9a-f]{64}$/);
});

test('encrypted_params_ref enforces requester and callback scope when metadata bindings are present', async () => {
  __resetNeoDidStateForTests();
  process.env.SUPABASE_URL = 'https://supabase.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';

  const fixture = await buildWeb3AuthFixture({
    claims: {
      aggregateVerifier: 'google-oauth',
      aggregateVerifierId: 'alice@example.com',
    },
    clientId: 'worker-test-web3auth-client-ref-scope',
    jwksUrl: 'https://jwks.test/web3auth-ref-scope.json',
    kid: 'worker-test-web3auth-ref-scope',
  });

  const keyRes = await handler(
    new Request('http://local/oracle/public-key', { headers: authHeaders() })
  );
  assert.equal(keyRes.status, 200);
  const keyMeta = await keyRes.json();
  const encryptedParams = await encryptForOracle(
    keyMeta.public_key,
    JSON.stringify({
      id_token: fixture.token,
      web3auth_client_id: fixture.clientId,
      web3auth_jwks_url: fixture.jwksUrl,
    })
  );

  global.fetch = async (url) => {
    const value = String(url);
    if (value === fixture.jwksUrl) {
      return new Response(JSON.stringify(fixture.jwks), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (value.startsWith('https://supabase.test/rest/v1/morpheus_encrypted_secrets')) {
      return new Response(
        JSON.stringify([
          {
            id: '22222222-2222-2222-2222-222222222222',
            ciphertext: encryptedParams,
            metadata: {
              bound_requester: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              bound_callback_contract: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            },
          },
        ]),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }
      );
    }
    throw new Error(`unexpected fetch ${value}`);
  };

  const success = await handler(
    new Request('http://local/neodid/bind', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        vault_account: '0x6d0656f6dd91469db1c90cc1e574380613f43738',
        provider: 'web3auth',
        encrypted_params_ref: '22222222-2222-2222-2222-222222222222',
        request_id: 'neodid-ref-scope',
        claim_type: 'Web3Auth_PrimaryIdentity',
        claim_value: 'ref-scope',
        requester: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        callback_contract: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      }),
    })
  );
  assert.equal(success.status, 200);
  const successBody = await success.json();
  assert.equal(successBody.provider, 'web3auth');
  assert.match(successBody.master_nullifier, /^0x[0-9a-f]{64}$/);

  const deniedRequester = await handler(
    new Request('http://local/neodid/bind', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        vault_account: '0x6d0656f6dd91469db1c90cc1e574380613f43738',
        provider: 'web3auth',
        encrypted_params_ref: '22222222-2222-2222-2222-222222222222',
        request_id: 'neodid-ref-scope',
        claim_type: 'Web3Auth_PrimaryIdentity',
        claim_value: 'ref-scope',
        requester: '0xcccccccccccccccccccccccccccccccccccccccc',
        callback_contract: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      }),
    })
  );
  assert.equal(deniedRequester.status, 400);
  const deniedRequesterBody = await deniedRequester.json();
  assert.match(deniedRequesterBody.error, /encrypted ref requester mismatch/i);

  const deniedCallback = await handler(
    new Request('http://local/neodid/bind', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        vault_account: '0x6d0656f6dd91469db1c90cc1e574380613f43738',
        provider: 'web3auth',
        encrypted_params_ref: '22222222-2222-2222-2222-222222222222',
        request_id: 'neodid-ref-scope',
        claim_type: 'Web3Auth_PrimaryIdentity',
        claim_value: 'ref-scope',
        requester: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        callback_contract: '0xcccccccccccccccccccccccccccccccccccccccc',
      }),
    })
  );
  assert.equal(deniedCallback.status, 400);
  const deniedCallbackBody = await deniedCallback.json();
  assert.match(deniedCallbackBody.error, /encrypted ref callback mismatch/i);
});

test('encrypted_params_ref is idempotent for the same request_id but rejects replay across request ids', async () => {
  __resetNeoDidStateForTests();
  process.env.SUPABASE_URL = 'https://supabase.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';

  const fixture = await buildWeb3AuthFixture({
    claims: {
      aggregateVerifier: 'google-oauth',
      aggregateVerifierId: 'alice@example.com',
    },
    clientId: 'worker-test-web3auth-client-ref-replay',
    jwksUrl: 'https://jwks.test/web3auth-ref-replay.json',
    kid: 'worker-test-web3auth-ref-replay',
  });

  const keyRes = await handler(
    new Request('http://local/oracle/public-key', { headers: authHeaders() })
  );
  assert.equal(keyRes.status, 200);
  const keyMeta = await keyRes.json();
  const encryptedParams = await encryptForOracle(
    keyMeta.public_key,
    JSON.stringify({
      id_token: fixture.token,
      web3auth_client_id: fixture.clientId,
      web3auth_jwks_url: fixture.jwksUrl,
    })
  );

  const secretRow = {
    id: '33333333-3333-3333-3333-333333333333',
    ciphertext: encryptedParams,
    metadata: {
      bound_requester: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      bound_callback_contract: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    },
  };

  global.fetch = async (url, init = {}) => {
    const value = String(url);
    if (value === fixture.jwksUrl) {
      return new Response(JSON.stringify(fixture.jwks), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (value.startsWith('https://supabase.test/rest/v1/morpheus_encrypted_secrets')) {
      const method = String(init?.method || 'GET').toUpperCase();
      if (method === 'GET') {
        return new Response(JSON.stringify([secretRow]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (method === 'PATCH') {
        const parsedUrl = new URL(value);
        const requestBody = JSON.parse(String(init.body || '{}'));
        const claimedRequestId = requestBody?.metadata?._consumed_request_id || null;
        const requiredNullClaim =
          parsedUrl.searchParams.get('metadata->>_consumed_request_id') === 'is.null';
        if (requiredNullClaim && secretRow.metadata._consumed_request_id !== undefined) {
          return new Response(JSON.stringify([]), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        secretRow.metadata = {
          ...secretRow.metadata,
          _consumed_request_id: claimedRequestId,
          _consumed_at: '2026-03-15T00:00:00.000Z',
        };
        return new Response(JSON.stringify([secretRow]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
    }
    throw new Error(`unexpected fetch ${value}`);
  };

  const baseBody = {
    vault_account: '0x6d0656f6dd91469db1c90cc1e574380613f43738',
    provider: 'web3auth',
    encrypted_params_ref: '33333333-3333-3333-3333-333333333333',
    claim_type: 'Web3Auth_PrimaryIdentity',
    claim_value: 'ref-replay',
    requester: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    callback_contract: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  };

  const first = await handler(
    new Request('http://local/neodid/bind', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        ...baseBody,
        request_id: 'oracle-request-1',
      }),
    })
  );
  assert.equal(first.status, 200);

  const retrySameRequest = await handler(
    new Request('http://local/neodid/bind', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        ...baseBody,
        request_id: 'oracle-request-1',
      }),
    })
  );
  assert.equal(retrySameRequest.status, 200);

  const replayDifferentRequest = await handler(
    new Request('http://local/neodid/bind', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        ...baseBody,
        request_id: 'oracle-request-2',
      }),
    })
  );
  assert.equal(replayDifferentRequest.status, 400);
  const replayBody = await replayDifferentRequest.json();
  assert.match(replayBody.error, /encrypted ref already consumed by another request/i);
});

test.after(() => {
  global.fetch = originalFetch;
  if (originalRuntimeToken === undefined) {
    delete process.env.MORPHEUS_RUNTIME_TOKEN;
  } else {
    process.env.MORPHEUS_RUNTIME_TOKEN = originalRuntimeToken;
  }
  process.env.MORPHEUS_WORKER_NEO_N3_PRIVATE_KEY = originalNeoN3Key;
  process.env.NEO_RPC_URL = originalNeoRpc;
  process.env.EVM_RPC_URL = originalEvmRpc;
  process.env.TWELVEDATA_API_KEY = originalTwelveData;
  process.env.MORPHEUS_FEED_STATE_PATH = originalFeedStatePath;
  process.env.SUPABASE_URL = originalSupabaseUrl;
  process.env.SUPABASE_SERVICE_ROLE_KEY = originalSupabaseServiceRoleKey;
  process.env.NITRO_USE_DERIVED_KEYS = originalUseDerivedKeys;
  process.env.NITRO_ORACLE_KEYSTORE_PATH = originalOracleKeystorePath;
  process.env.MORPHEUS_ENABLE_UNTRUSTED_SCRIPTS = originalEnableUserScripts;
  process.env.CONTRACT_MORPHEUS_ORACLE_HASH = originalOracleHash;
  process.env.NEODID_SECRET_SALT = originalNeoDidSecretSalt;
  process.env.WEB3AUTH_CLIENT_ID = originalWeb3AuthClientId;
  process.env.NEXT_PUBLIC_WEB3AUTH_CLIENT_ID = originalNextPublicWeb3AuthClientId;
  process.env.WEB3AUTH_JWKS_URL = originalWeb3AuthJwksUrl;
  if (originalAllowUnpinnedSigners === undefined) {
    delete process.env.MORPHEUS_ALLOW_UNPINNED_SIGNERS;
  } else {
    process.env.MORPHEUS_ALLOW_UNPINNED_SIGNERS = originalAllowUnpinnedSigners;
  }
  __resetDstackClientStateForTests();
  __resetOracleKeyMaterialForTests();
  __resetFeedStateForTests();
  __resetNeoDidStateForTests();
});

test('txproxy allowlist permits Oracle fulfillRequest and both automation queue lanes', async () => {
  assert.equal(
    allowlistAllows('0xf54d8584ef82315c1800373272ab08ae0db2d5ef', 'fulfillRequest'),
    true
  );
  assert.equal(
    allowlistAllows('0xf54d8584ef82315c1800373272ab08ae0db2d5ef', 'queueAutomationRequest'),
    true
  );
  // R-01: the upgraded kernel queues an automation execution under the job owner's
  // spend approval through queueAutomationExecution; the control plane relays it here.
  assert.equal(
    allowlistAllows('0xf54d8584ef82315c1800373272ab08ae0db2d5ef', 'queueAutomationExecution'),
    true
  );
  // Only the listed oracle methods: an admin entry point is still refused.
  assert.equal(allowlistAllows('0xf54d8584ef82315c1800373272ab08ae0db2d5ef', 'update'), false);
});

test('createByteArrayParam decodes base64 payloads into raw bytes', async () => {
  const expected = '04030201';
  assert.equal(createByteArrayParam(Buffer.from('01020304', 'hex')).value.toString(), expected);
  assert.equal(createByteArrayParam('01020304').value.toString(), expected);
  assert.equal(
    createByteArrayParam(Buffer.from('01020304', 'hex').toString('base64')).value.toString(),
    expected
  );
});

test('providers endpoint lists builtin sources', async () => {
  const res = await handler(new Request('http://local/providers', { headers: authHeaders() }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.providers));
  assert.equal(body.providers[0].id, 'twelvedata');
  assert.ok(body.providers.some((provider) => provider.id === 'binance-spot'));
});

test('feeds catalog lists default symbols', async () => {
  const res = await handler(new Request('http://local/feeds/catalog', { headers: authHeaders() }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.pairs));
  assert.ok(body.pairs.includes('TWELVEDATA:NEO-USD'));
  assert.ok(body.pairs.includes('TWELVEDATA:PAXG-USD'));
  assert.ok(body.pairs.includes('TWELVEDATA:WTI-USD'));
  assert.ok(body.pairs.includes('TWELVEDATA:AAPL-USD'));
  assert.ok(body.pairs.includes('TWELVEDATA:EUR-USD'));
  assert.ok(body.pairs.includes('TWELVEDATA:JPY-USD'));
});

test('oracle feed with wait:false returns accepted before provider and chain work completes', async () => {
  process.env.MORPHEUS_FEED_BOOTSTRAP_SUPABASE_ENABLED = 'false';
  process.env.MORPHEUS_FEED_SNAPSHOT_SUPABASE_ENABLED = 'false';
  process.env.MORPHEUS_FEED_PROVIDERS = 'twelvedata';
  delete process.env.CONTRACT_PRICEFEED_HASH;
  delete process.env.CONTRACT_MORPHEUS_DATAFEED_HASH;

  let resolveProvider;
  let providerRequested = false;
  const providerResponse = new Promise((resolve) => {
    resolveProvider = resolve;
  });
  global.fetch = async (url) => {
    const value = String(url);
    if (value.includes('api.twelvedata.com')) {
      providerRequested = true;
      await providerResponse;
      return new Response(JSON.stringify({ price: '45.67' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected fetch ${value}`);
  };

  const res = await handler(
    new Request('http://local/oracle/feed', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        wait: false,
        network: 'testnet',
        target_chain: 'neo_n3',
        symbols: ['TWELVEDATA:NEO-USD'],
      }),
    })
  );
  const body = await res.json();

  assert.equal(res.status, 202);
  assert.equal(body.accepted, true);
  assert.equal(body.status, 'accepted');
  assert.equal(body.wait, false);
  assert.ok(body.request_id);

  resolveProvider();
  await __drainOracleFeedBackgroundTasksForTests();
  assert.equal(providerRequested, true);
});

test('loadNeoN3Context resolves the tx-relay signing identity from the custody service', async () => {
  const context = await loadNeoN3Context({}, { required: true, requireRpc: false });
  assert.equal(context.account, null);
  const identity = await context.resolveSigningIdentity();
  assert.equal(identity.keyId, 'key-updater');
  assert.equal(identity.account.address, custodyUpdaterAccount.address);
  assert.equal(identity.account.publicKey, custodyUpdaterAccount.publicKey);
  assert.equal(identity.scriptHash, `0x${custodyUpdaterAccount.scriptHash}`);
  assert.equal(await context.resolveSigningIdentity(), identity);
});

test('loadNeoN3Context keeps read-only contexts free of custody resolution', async () => {
  const context = await loadNeoN3Context({}, { required: false, requireRpc: false });
  assert.equal(context.account, null);
  assert.equal(context.custody, null);
});

test('relayNeoN3Invocation builds, fees, and custody-signs the relay transaction', async () => {
  const rpcCalls = [];
  const originalInvokeFunction = neoRpc.RPCClient.prototype.invokeFunction;
  const originalGetBlockCount = neoRpc.RPCClient.prototype.getBlockCount;
  const originalCalculateNetworkFee = neoRpc.RPCClient.prototype.calculateNetworkFee;
  const originalSendRawTransaction = neoRpc.RPCClient.prototype.sendRawTransaction;
  neoRpc.RPCClient.prototype.invokeFunction = async function (_hash, operation, _params, _signers) {
    rpcCalls.push({ method: 'invokeFunction', operation });
    return { state: 'HALT', gasconsumed: '1000000' };
  };
  neoRpc.RPCClient.prototype.getBlockCount = async function () {
    rpcCalls.push({ method: 'getblockcount' });
    return 1000;
  };
  neoRpc.RPCClient.prototype.calculateNetworkFee = async function (serialized) {
    rpcCalls.push({ method: 'calculatenetworkfee', serialized });
    return 100000;
  };
  neoRpc.RPCClient.prototype.sendRawTransaction = async function (serialized) {
    rpcCalls.push({ method: 'sendrawtransaction', serialized });
    return '0x' + 'ab'.repeat(32);
  };
  try {
    const result = await relayNeoN3Invocation({
      network: 'mainnet',
      contract_hash: '0xf54d8584ef82315c1800373272ab08ae0db2d5ef',
      method: 'fulfillRequest',
      params: [],
      request_id: 'relay-custody-e2e',
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.request_id, 'relay-custody-e2e');
    assert.match(result.body.tx_hash, /^0x[0-9a-f]{64}$/);
    assert.equal(result.body.vm_state, 'HALT');

    assert.ok(
      rpcCalls.some(
        (call) => call.method === 'invokeFunction' && call.operation === 'fulfillRequest'
      ),
      'invokescript simulation should run against the allowlisted method'
    );
    assert.ok(rpcCalls.some((call) => call.method === 'getblockcount'));
    const feeCall = rpcCalls.find((call) => call.method === 'calculatenetworkfee');
    assert.ok(feeCall, 'calculatenetworkfee should be called before signing');
    const sendCall = rpcCalls.find((call) => call.method === 'sendrawtransaction');
    assert.ok(sendCall, 'sendrawtransaction should be called');
    const broadcastTx = neoTx.Transaction.deserialize(
      Buffer.from(sendCall.serialized, 'base64').toString('hex')
    );
    assert.equal(broadcastTx.witnesses.length, 1);
    assert.equal(
      String(broadcastTx.witnesses[0].scriptHash).toLowerCase().replace(/^0x/, ''),
      custodyUpdaterAccount.scriptHash.toLowerCase()
    );
    assert.equal(
      broadcastTx.witnesses[0].verificationScript.toString(),
      `0c21${custodyUpdaterAccount.publicKey}4156e7b327`
    );
  } finally {
    neoRpc.RPCClient.prototype.invokeFunction = originalInvokeFunction;
    neoRpc.RPCClient.prototype.getBlockCount = originalGetBlockCount;
    neoRpc.RPCClient.prototype.calculateNetworkFee = originalCalculateNetworkFee;
    neoRpc.RPCClient.prototype.sendRawTransaction = originalSendRawTransaction;
  }
});

test('feed quote supports twelvedata provider', async () => {
  global.fetch = async (url) => {
    assert.match(String(url), /api\.twelvedata\.com\/price/);
    assert.match(String(url), /apikey=test-twelvedata-key/);
    return new Response(JSON.stringify({ price: '45.67' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const res = await handler(
    new Request('http://local/feeds/price/NEO-USD?provider=twelvedata', { headers: authHeaders() })
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.provider, 'twelvedata');
  assert.equal(body.price, '45.67');
});

test('feed quote infers provider from canonical prefixed symbol without provider field', async () => {
  global.fetch = async (url) => {
    assert.match(String(url), /api\.twelvedata\.com\/price/);
    assert.match(String(url), /BTC-USD|BTC%2FUSD/);
    return new Response(JSON.stringify({ price: '70123.5' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const res = await handler(
    new Request('http://local/feeds/price/TWELVEDATA:BTC-USD', { headers: authHeaders() })
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.pair, 'TWELVEDATA:BTC-USD');
  assert.equal(body.provider_pair, 'BTC-USD');
  assert.equal(body.price, '70123.5');
});

test('feed quote expands bare asset symbols to USD pairs without producing undefined quotes', async () => {
  global.fetch = async (url) => {
    assert.match(String(url), /api\.twelvedata\.com\/price/);
    assert.match(String(url), /GAS%2FUSD|GAS-USD/);
    return new Response(JSON.stringify({ price: '4.56' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const res = await handler(
    new Request('http://local/feeds/price/GAS', { headers: authHeaders() })
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.pair, 'TWELVEDATA:GAS-USD');
  assert.equal(body.providers_requested[0], 'twelvedata');
  assert.equal(body.quotes[0].provider_pair, 'GAS-USD');
  assert.equal(body.quotes[0].pair, 'TWELVEDATA:GAS-USD');
  assert.equal(body.quotes[0].price, '4.56');
});

test('feed quote preserves explicit TwelveData stock symbols without appending /USD', async () => {
  global.fetch = async (url) => {
    assert.match(String(url), /api\.twelvedata\.com\/price/);
    assert.match(String(url), /symbol=AAPL(&|%26|$)/);
    return new Response(JSON.stringify({ price: '260.72' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const res = await handler(
    new Request('http://local/feeds/price/AAPL-USD?provider=twelvedata', { headers: authHeaders() })
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.pair, 'TWELVEDATA:AAPL-USD');
  assert.equal(body.price, '260.72');
});

test('feed quote can invert forex units for direct JPY-USD pricing under 1e6 USD scale', async () => {
  global.fetch = async (url) => {
    assert.match(String(url), /api\.twelvedata\.com\/price/);
    assert.match(String(url), /USD%2FJPY/);
    return new Response(JSON.stringify({ price: '150.0000' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const res = await handler(
    new Request('http://local/feeds/price/JPY-USD?provider=twelvedata', { headers: authHeaders() })
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.pair, 'TWELVEDATA:JPY-USD');
  assert.equal(body.display_symbol, 'TWELVEDATA:JPY-USD');
  assert.equal(body.unit_label, null);
  assert.equal(body.raw_price, '150.0000');
  assert.equal(body.price_transform, 'inverse');
  assert.equal(body.price_multiplier, 1);
  assert.equal(body.price, '0.006666666667');
});

// CORN-USD is the regression subject on purpose: the registry symbol C_1 is CBOT
// corn futures (~479 US cents/bushel) while the bare ticker CORN is the Teucrium
// Corn Fund ETF (~$18.9). Deriving the provider symbol from the pair name instead
// of reading it from the registry is what put the ETF price on a futures series.
test('feed quote preserves explicit TwelveData futures symbols', async () => {
  global.fetch = async (url) => {
    assert.match(String(url), /api\.twelvedata\.com\/price/);
    assert.match(String(url), /symbol=C_1(&|%26|$)/);
    assert.doesNotMatch(String(url), /symbol=CORN(&|%26|$)/);
    return new Response(JSON.stringify({ price: '479.06777' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const res = await handler(
    new Request('http://local/feeds/price/CORN-USD?provider=twelvedata', {
      headers: authHeaders(),
    })
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.pair, 'TWELVEDATA:CORN-USD');
  assert.equal(body.price, '479.06777');
});

test('feed quote supports coinbase-spot provider', async () => {
  global.fetch = async (url) => {
    assert.match(String(url), /api\.coinbase\.com\/v2\/prices\/NEO-USD\/spot/);
    return new Response(JSON.stringify({ data: { amount: '99.01' } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const res = await handler(
    new Request('http://local/feeds/price/NEO-USD?provider=coinbase-spot', {
      headers: authHeaders(),
    })
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.provider, 'coinbase-spot');
  assert.equal(body.price, '99.01');
});

test('feed quote supports binance-spot provider', async () => {
  global.fetch = async (url) => {
    assert.match(String(url), /api1\.binance\.com\/api\/v3\/ticker\/price\?symbol=NEOUSDT/);
    return new Response(JSON.stringify({ price: '88.12' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const res = await handler(
    new Request('http://local/feeds/price/NEO-USD?provider=binance-spot', {
      headers: authHeaders(),
    })
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.provider, 'binance-spot');
  assert.equal(body.price, '88.12');
});

test('feed quote returns all available providers when provider is omitted', async () => {
  global.fetch = async (url) => {
    const value = String(url);
    if (value.includes('api.twelvedata.com')) {
      return new Response(JSON.stringify({ price: '45.67' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (value.includes('api1.binance.com')) {
      return new Response(JSON.stringify({ price: '45.70' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected fetch ${value}`);
  };

  const res = await handler(
    new Request('http://local/feeds/price/NEO-USD', { headers: authHeaders() })
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.pair, 'NEO-USD');
  // The registry is the source of truth for which providers serve a pair; the
  // handler must request every one of them, and only the two mocked above can
  // answer, so exactly those two quotes come back.
  const registryProviders = getFeedProvidersForPair('NEO-USD');
  assert.ok(registryProviders.length >= 2, 'registry lists the two mocked providers');
  assert.deepEqual(body.providers_requested, registryProviders);
  assert.deepEqual(body.quotes.map((quote) => quote.provider).sort(), [
    'binance-spot',
    'twelvedata',
  ]);
});

test('oracle query supports builtin provider mode', async () => {
  global.fetch = async (url) => {
    assert.match(String(url), /api\.twelvedata\.com\/price/);
    return new Response(JSON.stringify({ price: '11.11' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const res = await handler(
    new Request('http://local/oracle/query', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ provider: 'twelvedata', symbol: 'NEO-USD', target_chain: 'neo_n3' }),
    })
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.mode, 'fetch');
  assert.match(body.body, /11\.11/);
});

test('oracle query surfaces a builtin provider upstream 429 as a retryable 502 (D4)', async () => {
  global.fetch = async (url) => {
    assert.match(String(url), /api\.twelvedata\.com\/price/);
    return new Response(JSON.stringify({ code: 429, message: 'rate limited', status: 'error' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const res = await handler(
    new Request('http://local/oracle/query', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ provider: 'twelvedata', symbol: 'NEO-USD', target_chain: 'neo_n3' }),
    })
  );
  // An upstream data-source failure is a gateway fault (retryable), not a 400
  // "bad request" that the relayer would burn into a permanent failure callback.
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.match(body.error, /429/);
  assert.equal(body.kind, 'upstream_http_error');
  assert.equal(body.error_code, 'upstream_http_error');
});

test('oracle query surfaces a direct-URL upstream 503 as a retryable 502 (D4)', async () => {
  global.fetch = async (url) => {
    assert.equal(String(url), 'https://api.example.com/feed');
    return new Response('service unavailable', {
      status: 503,
      headers: { 'content-type': 'text/plain' },
    });
  };

  const res = await handler(
    new Request('http://local/oracle/query', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ url: 'https://api.example.com/feed', target_chain: 'neo_n3' }),
    })
  );
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.kind, 'upstream_http_error');
  assert.equal(body.upstream_status, 503);
});

test('health endpoint works without auth', async () => {
  const res = await handler(new Request('http://local/health'));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
});

test('health endpoint exposes a readiness probe (F4)', async () => {
  __resetHealthReadinessCacheForTests();
  const res = await handler(new Request('http://local/health'));
  assert.equal(res.status, 200);
  const body = await res.json();
  // Backward-compatible additive fields.
  assert.equal(body.status, 'ok');
  assert.equal(body.runtime, 'nitro-worker');
  assert.ok(body.readiness && typeof body.readiness === 'object', 'readiness object present');
  assert.ok('ready' in body, 'top-level ready flag present');
  assert.ok('signing_key' in body.readiness.checks);
  assert.ok('dstack' in body.readiness.checks);
  assert.ok('feed_fresh' in body.readiness.checks);
  assert.equal(typeof body.readiness.feed_state_write_failures, 'number');
});

test('health endpoint returns 503 in strict mode when not ready (F4)', async () => {
  const previous = process.env.MORPHEUS_WORKER_HEALTH_STRICT;
  process.env.MORPHEUS_WORKER_HEALTH_STRICT = 'true';
  __resetHealthReadinessCacheForTests();
  try {
    // No reachable dstack/signer in the test env → not ready → strict 503.
    const res = await handler(new Request('http://local/health'));
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.status, 'degraded');
    assert.equal(body.ready, false);
    // Even when degraded, the discoverable feature list is still served.
    assert.ok(Array.isArray(body.features) && body.features.length >= 20);
  } finally {
    if (previous === undefined) delete process.env.MORPHEUS_WORKER_HEALTH_STRICT;
    else process.env.MORPHEUS_WORKER_HEALTH_STRICT = previous;
    __resetHealthReadinessCacheForTests();
  }
});

test('info endpoint works without auth', async () => {
  const res = await handler(new Request('http://local/info'));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Object.prototype.hasOwnProperty.call(body, 'dstack'));
});

test('attestation endpoint works without auth', async () => {
  const res = await handler(new Request('http://local/attestation?report_data=test-report'));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Object.prototype.hasOwnProperty.call(body, 'attestation'));
});

test('oracle public key endpoint returns X25519 metadata', async () => {
  const res = await handler(
    new Request('http://local/oracle/public-key', { headers: authHeaders() })
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.algorithm, TEST_ORACLE_ENCRYPTION_ALGORITHM);
  assert.ok(body.public_key);
  assert.equal(body.public_key_format, 'raw');
  assert.equal(body.recommended_payload_encryption, TEST_ORACLE_ENCRYPTION_ALGORITHM);
  assert.ok(Array.isArray(body.supported_payload_encryption));
  assert.deepEqual(body.supported_payload_encryption, [TEST_ORACLE_ENCRYPTION_ALGORITHM]);
});

test('oracle public key prefers a Secrets Manager sealed keystore', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'morpheus-oracle-key-'));
  const keystorePath = path.join(tempDir, 'oracle-key.json');
  process.env.NITRO_USE_DERIVED_KEYS = 'false';
  process.env.NITRO_ORACLE_KEYSTORE_PATH = keystorePath;

  // Nitro: the X25519 wrap key comes from Secrets Manager (read via the box instance role).
  __setSecretsProviderForTests(() => ({
    getSecret: async () => Buffer.from('11'.repeat(32), 'hex').toString('base64'),
  }));

  // Build a sealed keystore using the same wrap key the enclave will derive in-TEE.
  const wrapKey = (
    await deriveKeyBytes('morpheus/oracle/encryption/wrap/v1', 'oracle-encryption-wrap')
  ).subarray(0, 32);
  const kp = generateKeyPairSync('x25519');
  const pkcs8 = kp.privateKey.export({ type: 'pkcs8', format: 'der' });
  const rawPub = Buffer.from(kp.publicKey.export({ format: 'jwk' }).x, 'base64url');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', wrapKey, iv);
  const ciphertext = Buffer.concat([cipher.update(pkcs8), cipher.final()]);
  const keystore = {
    algorithm: 'X25519-HKDF-SHA256-AES-256-GCM',
    version: 2,
    public_key_raw: rawPub.toString('base64'),
    sealed_private_key: {
      iv: iv.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
    },
  };
  process.env.MORPHEUS_ORACLE_SEALED_KEYSTORE_BASE64 = Buffer.from(
    JSON.stringify(keystore)
  ).toString('base64');

  __resetOracleKeyMaterialForTests();
  const first = await handler(
    new Request('http://local/oracle/public-key', { headers: authHeaders() })
  );
  assert.equal(first.status, 200);
  const firstBody = await first.json();
  assert.match(firstBody.key_source, /nitro-sealed/);
  assert.ok(firstBody.public_key);

  __resetOracleKeyMaterialForTests();
  const second = await handler(
    new Request('http://local/oracle/public-key', { headers: authHeaders() })
  );
  assert.equal(second.status, 200);
  const secondBody = await second.json();
  assert.equal(secondBody.public_key, firstBody.public_key);
  assert.match(secondBody.key_source, /nitro-sealed/);
});

test('oracle key material can be restored explicitly from env configuration', async () => {
  const keyPair = await globalThis.crypto.subtle.generateKey({ name: 'X25519' }, true, [
    'deriveBits',
  ]);
  const publicKeyRaw = Buffer.from(
    await globalThis.crypto.subtle.exportKey('raw', keyPair.publicKey)
  ).toString('base64');
  const privateKeyPkcs8 = Buffer.from(
    await globalThis.crypto.subtle.exportKey('pkcs8', keyPair.privateKey)
  ).toString('base64');

  process.env.MORPHEUS_ORACLE_KEY_MATERIAL_JSON = JSON.stringify({
    public_key_raw: publicKeyRaw,
    private_key_pkcs8: privateKeyPkcs8,
  });
  __resetOracleKeyMaterialForTests();

  const keyRes = await handler(
    new Request('http://local/oracle/public-key', { headers: authHeaders() })
  );
  assert.equal(keyRes.status, 200);
  const keyBody = await keyRes.json();
  assert.equal(keyBody.public_key, publicKeyRaw);
  assert.equal(keyBody.key_source, 'configured-env');

  const ciphertext = await encryptForOracle(publicKeyRaw, 'configured-secret');
  const plaintext = await decryptEncryptedToken(ciphertext, {});
  assert.equal(plaintext, 'configured-secret');
});

test('oracle query supports plain fetch mode', async () => {
  global.fetch = async (url) => {
    assert.equal(url, 'https://api.example.com/plain');
    return new Response(JSON.stringify({ ok: true, value: 7 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const res = await handler(
    new Request('http://local/oracle/query', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ url: 'https://api.example.com/plain', target_chain: 'neo_n3' }),
    })
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.mode, 'fetch');
  assert.equal(body.status_code, 200);
  assert.match(body.body, /"ok":true/);
});

test('oracle smart fetch supports encrypted_payload alias and script_base64', async () => {
  const keyRes = await handler(
    new Request('http://local/oracle/public-key', { headers: authHeaders() })
  );
  const keyBody = await keyRes.json();
  const ciphertext = await encryptForOracle(keyBody.public_key, 'secret-token');

  global.fetch = async (url, init) => {
    assert.equal(url, 'https://api.example.com/private');
    assert.equal(init.headers.get('Authorization'), 'Bearer secret-token');
    return new Response(JSON.stringify({ ok: true, age: 82 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const res = await handler(
    new Request('http://local/oracle/smart-fetch', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        url: 'https://api.example.com/private',
        encrypted_payload: ciphertext,
        script_base64: Buffer.from('function process(data) { return data.age > 80; }').toString(
          'base64'
        ),
        target_chain: 'neo_n3',
      }),
    })
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.mode, 'fetch+compute');
  assert.equal(body.result, true);
  assert.equal(body.target_chain, 'neo_n3');
});

test('oracle smart fetch resolves encrypted_token_ref through Supabase ciphertext storage', async () => {
  process.env.SUPABASE_URL = 'https://supabase.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';

  const keyRes = await handler(
    new Request('http://local/oracle/public-key', { headers: authHeaders() })
  );
  assert.equal(keyRes.status, 200);
  const keyBody = await keyRes.json();
  const ciphertext = await encryptForOracle(keyBody.public_key, 'secret-token-by-ref');

  global.fetch = async (url, init) => {
    const value = String(url);
    if (value.startsWith('https://supabase.test/rest/v1/morpheus_encrypted_secrets')) {
      return new Response(
        JSON.stringify([
          {
            id: '44444444-4444-4444-4444-444444444444',
            ciphertext,
          },
        ]),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }
      );
    }
    assert.equal(value, 'https://api.example.com/private-ref');
    assert.equal(init.headers.get('Authorization'), 'Bearer secret-token-by-ref');
    return new Response(JSON.stringify({ ok: true, age: 84 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const res = await handler(
    new Request('http://local/oracle/smart-fetch', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        url: 'https://api.example.com/private-ref',
        encrypted_token_ref: '44444444-4444-4444-4444-444444444444',
        request_id: 'oracle-token-ref-resolution',
        script:
          'function process(data, context) { return data.age === 84 && context.encrypted_token_present; }',
        target_chain: 'neo_n3',
      }),
    })
  );
  const responseText = await res.text();
  assert.equal(res.status, 200, responseText);
  const body = JSON.parse(responseText);
  assert.equal(body.mode, 'fetch+compute');
  assert.equal(body.result, true);
  assert.equal(body.target_chain, 'neo_n3');
});

test('oracle smart fetch supports encrypted JSON payload patches', async () => {
  const keyRes = await handler(
    new Request('http://local/oracle/public-key', { headers: authHeaders() })
  );
  const keyBody = await keyRes.json();
  const ciphertext = await encryptForOracle(
    keyBody.public_key,
    JSON.stringify({
      headers: { 'x-api-key': 'sealed-secret' },
      script: 'function process(data) { return data.age > 80; }',
    })
  );

  global.fetch = async (url, init) => {
    assert.equal(url, 'https://api.example.com/private-patch');
    assert.equal(init.headers.get('x-api-key'), 'sealed-secret');
    assert.equal(init.headers.has('Authorization'), false);
    return new Response(JSON.stringify({ ok: true, age: 83 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const res = await handler(
    new Request('http://local/oracle/smart-fetch', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        url: 'https://api.example.com/private-patch',
        encrypted_payload: ciphertext,
        target_chain: 'neo_n3',
      }),
    })
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.mode, 'fetch+compute');
  assert.equal(body.result, true);
  assert.equal(body.target_chain, 'neo_n3');
});

test('compute execute supports builtin heavy functions', async () => {
  const res = await handler(
    new Request('http://local/compute/execute', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        mode: 'builtin',
        function: 'math.modexp',
        input: { base: '2', exponent: '10', modulus: '17' },
        target_chain: 'neo_n3',
      }),
    })
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.mode, 'builtin');
  assert.equal(body.function, 'math.modexp');
  assert.equal(body.result.value, '4');
  assert.ok(body.signature);
});

test('compute execute rejects zerc20 verification without a verifying key', async () => {
  const res = await handler(
    new Request('http://local/compute/execute', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        mode: 'builtin',
        function: 'zkp.zerc20.single_withdraw.verify',
        input: {
          public_inputs: {
            recipient: `0x${'11'.repeat(20)}`,
            withdraw_value: '1000000',
            tree_root: `0x${'22'.repeat(32)}`,
            path_indices: '0x01',
            blacklisted_root: `0x${'33'.repeat(32)}`,
          },
          expected_recipient: `0x${'11'.repeat(20)}`,
          expected_withdraw_value: '1000000',
        },
        target_chain: 'neo_n3',
      }),
    })
  );
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /verifying_key is required for zERC20 proof verification/i);
});

test('compute execute rejects oversized zkp verification payloads before snarkjs verify runs', async () => {
  const previous = process.env.COMPUTE_MAX_ZKP_VERIFY_INPUT_BYTES;
  process.env.COMPUTE_MAX_ZKP_VERIFY_INPUT_BYTES = '4096';
  try {
    const res = await handler(
      new Request('http://local/compute/execute', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          mode: 'builtin',
          function: 'zkp.groth16.verify',
          input: {
            verifying_key: { huge: 'x'.repeat(7000) },
            public_signals: ['1'],
            proof: {
              pi_a: ['1', '2'],
              pi_b: [
                ['1', '2'],
                ['3', '4'],
              ],
              pi_c: ['5', '6'],
            },
          },
          target_chain: 'neo_n3',
        }),
      })
    );
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /zkp verification input exceeds max size/i);
  } finally {
    if (previous === undefined) delete process.env.COMPUTE_MAX_ZKP_VERIFY_INPUT_BYTES;
    else process.env.COMPUTE_MAX_ZKP_VERIFY_INPUT_BYTES = previous;
  }
});

test('compute execute rejects groth16 verification when the verifier runtime is disabled', async () => {
  const previousRuntime = process.env.MORPHEUS_ZKP_VERIFY_RUNTIME;
  delete process.env.MORPHEUS_ZKP_VERIFY_RUNTIME;
  try {
    const res = await handler(
      new Request('http://local/compute/execute', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          mode: 'builtin',
          function: 'zkp.groth16.verify',
          input: {
            verifying_key: { vk_alpha_1: ['1', '2'] },
            public_signals: ['1'],
            proof: {
              pi_a: ['1', '2'],
              pi_b: [
                ['1', '2'],
                ['3', '4'],
              ],
              pi_c: ['5', '6'],
            },
          },
          target_chain: 'neo_n3',
        }),
      })
    );
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /groth16 verification runtime disabled/i);
  } finally {
    if (previousRuntime !== undefined) process.env.MORPHEUS_ZKP_VERIFY_RUNTIME = previousRuntime;
  }
});

test(
  'compute execute can use an external groth16 verifier command when explicitly enabled',
  {
    // The stub below is a `#!/bin/sh` script; Windows cannot spawn it, so the CLI
    // path is only exercisable on a POSIX host. Skipped, not failing, so a local
    // run of this suite stays readable.
    skip:
      process.platform === 'win32' ? 'requires a POSIX /bin/sh to spawn the snarkjs stub' : false,
  },
  async () => {
    const previousRuntime = process.env.MORPHEUS_ZKP_VERIFY_RUNTIME;
    const previousBin = process.env.MORPHEUS_SNARKJS_BIN;
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'morpheus-snarkjs-'));
    const stub = path.join(tempDir, 'snarkjs');
    await fs.writeFile(stub, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    process.env.MORPHEUS_ZKP_VERIFY_RUNTIME = 'cli';
    process.env.MORPHEUS_SNARKJS_BIN = stub;
    try {
      const res = await handler(
        new Request('http://local/compute/execute', {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({
            mode: 'builtin',
            function: 'zkp.groth16.verify',
            input: {
              verifying_key: { vk_alpha_1: ['1', '2'] },
              public_signals: ['1'],
              proof: {
                pi_a: ['1', '2'],
                pi_b: [
                  ['1', '2'],
                  ['3', '4'],
                ],
                pi_c: ['5', '6'],
              },
            },
            target_chain: 'neo_n3',
          }),
        })
      );
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.function, 'zkp.groth16.verify');
      assert.equal(body.result.is_valid, true);
    } finally {
      if (previousRuntime === undefined) delete process.env.MORPHEUS_ZKP_VERIFY_RUNTIME;
      else process.env.MORPHEUS_ZKP_VERIFY_RUNTIME = previousRuntime;
      if (previousBin === undefined) delete process.env.MORPHEUS_SNARKJS_BIN;
      else process.env.MORPHEUS_SNARKJS_BIN = previousBin;
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }
);

test('compute execute reports groth16 verifier runtime timeouts instead of invalid proofs', async () => {
  const previousRuntime = process.env.MORPHEUS_ZKP_VERIFY_RUNTIME;
  const previousBin = process.env.MORPHEUS_SNARKJS_BIN;
  const previousTimeout = process.env.MORPHEUS_ZKP_VERIFY_TIMEOUT_MS;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'morpheus-snarkjs-timeout-'));
  const stub = path.join(tempDir, 'snarkjs');
  await fs.writeFile(stub, '#!/usr/bin/env node\nsetTimeout(() => {}, 1000);\n', {
    mode: 0o755,
  });
  process.env.MORPHEUS_ZKP_VERIFY_RUNTIME = 'cli';
  process.env.MORPHEUS_SNARKJS_BIN = stub;
  process.env.MORPHEUS_ZKP_VERIFY_TIMEOUT_MS = '25';
  try {
    const res = await handler(
      new Request('http://local/compute/execute', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          mode: 'builtin',
          function: 'zkp.groth16.verify',
          input: {
            verifying_key: { vk_alpha_1: ['1', '2'] },
            public_signals: ['1'],
            proof: {
              pi_a: ['1', '2'],
              pi_b: [
                ['1', '2'],
                ['3', '4'],
              ],
              pi_c: ['5', '6'],
            },
          },
          target_chain: 'neo_n3',
        }),
      })
    );
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /groth16 verifier runtime failed/i);
  } finally {
    if (previousRuntime === undefined) delete process.env.MORPHEUS_ZKP_VERIFY_RUNTIME;
    else process.env.MORPHEUS_ZKP_VERIFY_RUNTIME = previousRuntime;
    if (previousBin === undefined) delete process.env.MORPHEUS_SNARKJS_BIN;
    else process.env.MORPHEUS_SNARKJS_BIN = previousBin;
    if (previousTimeout === undefined) delete process.env.MORPHEUS_ZKP_VERIFY_TIMEOUT_MS;
    else process.env.MORPHEUS_ZKP_VERIFY_TIMEOUT_MS = previousTimeout;
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('paymaster authorize enforces network-specific policy', async () => {
  const snapshot = {
    testnetEnabled: process.env.MORPHEUS_PAYMASTER_TESTNET_ENABLED,
    testnetPolicyId: process.env.MORPHEUS_PAYMASTER_TESTNET_POLICY_ID,
    testnetMaxGas: process.env.MORPHEUS_PAYMASTER_TESTNET_MAX_GAS_UNITS,
    testnetAllowTargets: process.env.MORPHEUS_PAYMASTER_TESTNET_ALLOW_TARGETS,
    testnetAllowUserOpTargets: process.env.MORPHEUS_PAYMASTER_TESTNET_ALLOW_USEROP_TARGETS,
    testnetAllowMethods: process.env.MORPHEUS_PAYMASTER_TESTNET_ALLOW_METHODS,
    testnetAllowAccounts: process.env.MORPHEUS_PAYMASTER_TESTNET_ALLOW_ACCOUNTS,
    testnetBlockAccounts: process.env.MORPHEUS_PAYMASTER_TESTNET_BLOCK_ACCOUNTS,
    testnetAllowDapps: process.env.MORPHEUS_PAYMASTER_TESTNET_ALLOW_DAPPS,
    genericAaCoreHash: process.env.AA_CORE_HASH_TESTNET,
    mainnetEnabled: process.env.MORPHEUS_PAYMASTER_MAINNET_ENABLED,
  };

  process.env.MORPHEUS_PAYMASTER_TESTNET_ENABLED = 'true';
  process.env.MORPHEUS_PAYMASTER_TESTNET_POLICY_ID = 'testnet-aa';
  process.env.MORPHEUS_PAYMASTER_TESTNET_MAX_GAS_UNITS = '500000';
  process.env.MORPHEUS_PAYMASTER_TESTNET_ALLOW_TARGETS = `0x${'aa'.repeat(20)}`;
  process.env.MORPHEUS_PAYMASTER_TESTNET_ALLOW_USEROP_TARGETS = `0x${'11'.repeat(20)}`;
  process.env.MORPHEUS_PAYMASTER_TESTNET_ALLOW_METHODS = 'executeUserOp';
  process.env.MORPHEUS_PAYMASTER_TESTNET_ALLOW_ACCOUNTS = 'aa-test-account';
  process.env.MORPHEUS_PAYMASTER_TESTNET_BLOCK_ACCOUNTS = '';
  process.env.MORPHEUS_PAYMASTER_TESTNET_ALLOW_DAPPS = 'demo-dapp';
  process.env.AA_CORE_HASH_TESTNET = `0x${'aa'.repeat(20)}`;
  process.env.MORPHEUS_PAYMASTER_MAINNET_ENABLED = 'false';

  try {
    const approved = await handler(
      new Request('http://local/paymaster/authorize', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          network: 'testnet',
          target_chain: 'neo_n3',
          account_id: 'aa-test-account',
          dapp_id: 'demo-dapp',
          target_contract: `0x${'aa'.repeat(20)}`,
          method: 'executeUserOp',
          userop_target_contract: `0x${'11'.repeat(20)}`,
          userop_method: 'symbol',
          estimated_gas_units: 120000,
          operation_hash: `0x${'44'.repeat(32)}`,
        }),
      })
    );
    assert.equal(approved.status, 200);
    const approvedBody = await approved.json();
    assert.equal(approvedBody.approved, true);
    assert.equal(approvedBody.network, 'testnet');
    assert.equal(approvedBody.policy_id, 'testnet-aa');
    assert.ok(approvedBody.sponsorship_id);
    assert.equal(approvedBody.operation_hash, `0x${'44'.repeat(32)}`);
    assert.ok(approvedBody.approval_digest);
    assert.ok(approvedBody.signature);

    const deniedUserOpTarget = await handler(
      new Request('http://local/paymaster/authorize', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          network: 'testnet',
          target_chain: 'neo_n3',
          account_id: 'aa-test-account',
          dapp_id: 'demo-dapp',
          target_contract: `0x${'aa'.repeat(20)}`,
          method: 'executeUserOp',
          userop_target_contract: `0x${'22'.repeat(20)}`,
          userop_method: 'symbol',
          estimated_gas_units: 120000,
          operation_hash: `0x${'45'.repeat(32)}`,
        }),
      })
    );
    const deniedUserOpTargetBody = await deniedUserOpTarget.json();
    assert.equal(deniedUserOpTargetBody.approved, false);
    assert.match(deniedUserOpTargetBody.reason, /userop_target_contract is not allowlisted/i);

    const denied = await handler(
      new Request('http://local/paymaster/authorize', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          network: 'mainnet',
          target_chain: 'neo_n3',
          account_id: 'aa-test-account',
          dapp_id: 'demo-dapp',
          target_contract: `0x${'aa'.repeat(20)}`,
          method: 'executeUserOp',
          estimated_gas_units: 120000,
          operation_hash: `0x${'44'.repeat(32)}`,
        }),
      })
    );
    assert.equal(denied.status, 200);
    const deniedBody = await denied.json();
    assert.equal(deniedBody.approved, false);
    assert.match(deniedBody.reason, /disabled/i);

    const deniedDapp = await handler(
      new Request('http://local/paymaster/authorize', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          network: 'testnet',
          target_chain: 'neo_n3',
          account_id: 'aa-test-account',
          dapp_id: 'rogue-dapp',
          target_contract: `0x${'aa'.repeat(20)}`,
          method: 'executeUserOp',
          estimated_gas_units: 120000,
          operation_hash: `0x${'55'.repeat(32)}`,
        }),
      })
    );
    assert.equal(deniedDapp.status, 200);
    const deniedDappBody = await deniedDapp.json();
    assert.equal(deniedDappBody.approved, false);
    assert.match(deniedDappBody.reason, /dapp_id is not allowlisted/i);
  } finally {
    process.env.MORPHEUS_PAYMASTER_TESTNET_ENABLED = snapshot.testnetEnabled;
    process.env.MORPHEUS_PAYMASTER_TESTNET_POLICY_ID = snapshot.testnetPolicyId;
    process.env.MORPHEUS_PAYMASTER_TESTNET_MAX_GAS_UNITS = snapshot.testnetMaxGas;
    process.env.MORPHEUS_PAYMASTER_TESTNET_ALLOW_TARGETS = snapshot.testnetAllowTargets;
    process.env.MORPHEUS_PAYMASTER_TESTNET_ALLOW_USEROP_TARGETS =
      snapshot.testnetAllowUserOpTargets;
    process.env.MORPHEUS_PAYMASTER_TESTNET_ALLOW_METHODS = snapshot.testnetAllowMethods;
    process.env.MORPHEUS_PAYMASTER_TESTNET_ALLOW_ACCOUNTS = snapshot.testnetAllowAccounts;
    process.env.MORPHEUS_PAYMASTER_TESTNET_BLOCK_ACCOUNTS = snapshot.testnetBlockAccounts;
    process.env.MORPHEUS_PAYMASTER_TESTNET_ALLOW_DAPPS = snapshot.testnetAllowDapps;
    process.env.AA_CORE_HASH_TESTNET = snapshot.genericAaCoreHash;
    process.env.MORPHEUS_PAYMASTER_MAINNET_ENABLED = snapshot.mainnetEnabled;
  }
});

test('relay response idempotency replays a result without replaying its sponsorship approval', async () => {
  const upstash = createUpstashRestMock();
  upstash.install();
  process.env.MORPHEUS_ALLOW_TRANSACTION_SPONSORSHIP = 'true';
  process.env.MORPHEUS_UPSTASH_GUARDS_ENABLED = 'true';
  process.env.MORPHEUS_UPSTASH_FAIL_CLOSED = 'true';
  process.env.UPSTASH_REDIS_REST_URL = 'https://mock-upstash.example.com';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
  const fixture = buildSponsorshipFixture({ id: 'approval-response-idempotency' });
  upstash.putJson(sponsorshipStorageKey(fixture.approval.sponsorship_id), fixture.approval);
  let signCalls = 0;
  __setCustodyTransportForTests(async (method, pathname) => {
    if (method === 'GET' && pathname === '/keys/key-updater') {
      return {
        allowed: true,
        key_id: 'key-updater',
        public_key: fixture.sponsorAccount.publicKey,
        script_hash: `0x${fixture.sponsorAccount.scriptHash}`,
        address: fixture.sponsorAccount.address,
      };
    }
    if (method === 'POST' && pathname === '/sign/transaction') {
      signCalls += 1;
      return {
        allowed: true,
        key_id: 'key-updater',
        address: fixture.sponsorAccount.address,
        script_hash: `0x${fixture.sponsorAccount.scriptHash}`,
        invocation_script: `0c40${'00'.repeat(64)}`,
        verification_script: `0c21${fixture.sponsorAccount.publicKey}4156e7b327`,
      };
    }
    return { allowed: false, code: 'unexpected', message: `${method} ${pathname}` };
  });
  const payload = sponsorshipPayload(fixture);
  const request = (idempotencyKey) =>
    new Request('http://local/relay/transaction', {
      method: 'POST',
      headers: { ...authHeaders(), 'idempotency-key': idempotencyKey },
      body: JSON.stringify(payload),
    });

  const first = await handler(request('sponsor-response-1'));
  assert.equal(first.status, 200);
  const firstBody = await first.json();
  assert.equal(firstBody.sponsorship_id, fixture.approval.sponsorship_id);
  assert.equal(signCalls, 1);

  const cached = await handler(request('sponsor-response-1'));
  assert.equal(cached.status, 200);
  assert.deepEqual(await cached.json(), firstBody);
  assert.equal(signCalls, 1, 'a cached response must not consume or sign again');

  const approvalReplay = await handler(request('sponsor-response-2'));
  assert.equal(approvalReplay.status, 400);
  assert.match((await approvalReplay.json()).error, /already consumed/);
  assert.equal(signCalls, 1, 'a new request must not replay the consumed approval');
});

test('paymaster authorize can consult AA hook allowlist state', async () => {
  const snapshot = {
    testnetEnabled: process.env.MORPHEUS_PAYMASTER_TESTNET_ENABLED,
    testnetPolicyId: process.env.MORPHEUS_PAYMASTER_TESTNET_POLICY_ID,
    testnetMaxGas: process.env.MORPHEUS_PAYMASTER_TESTNET_MAX_GAS_UNITS,
    testnetAllowTargets: process.env.MORPHEUS_PAYMASTER_TESTNET_ALLOW_TARGETS,
    testnetAllowUserOpTargets: process.env.MORPHEUS_PAYMASTER_TESTNET_ALLOW_USEROP_TARGETS,
    testnetAllowMethods: process.env.MORPHEUS_PAYMASTER_TESTNET_ALLOW_METHODS,
    testnetAllowAccounts: process.env.MORPHEUS_PAYMASTER_TESTNET_ALLOW_ACCOUNTS,
    testnetBlockAccounts: process.env.MORPHEUS_PAYMASTER_TESTNET_BLOCK_ACCOUNTS,
    testnetAllowDapps: process.env.MORPHEUS_PAYMASTER_TESTNET_ALLOW_DAPPS,
    testnetAaCoreHash: process.env.MORPHEUS_PAYMASTER_TESTNET_AA_CORE_HASH,
    testnetWhitelistHookHash: process.env.MORPHEUS_PAYMASTER_TESTNET_WHITELIST_HOOK_HASH,
    testnetMultiHookHash: process.env.MORPHEUS_PAYMASTER_TESTNET_MULTI_HOOK_HASH,
    testnetNeoRpcUrl: process.env.MORPHEUS_PAYMASTER_TESTNET_NEO_RPC_URL,
  };

  const aaCoreHash = `0x${'aa'.repeat(20)}`;
  const whitelistHookHash = `0x${'bb'.repeat(20)}`;
  const downstreamAllowed = `0x${'11'.repeat(20)}`;
  const downstreamDenied = `0x${'22'.repeat(20)}`;

  process.env.MORPHEUS_PAYMASTER_TESTNET_ENABLED = 'true';
  process.env.MORPHEUS_PAYMASTER_TESTNET_POLICY_ID = 'testnet-aa';
  process.env.MORPHEUS_PAYMASTER_TESTNET_MAX_GAS_UNITS = '500000';
  process.env.MORPHEUS_PAYMASTER_TESTNET_ALLOW_TARGETS = aaCoreHash;
  process.env.MORPHEUS_PAYMASTER_TESTNET_ALLOW_USEROP_TARGETS = '';
  process.env.MORPHEUS_PAYMASTER_TESTNET_ALLOW_METHODS = 'executeUserOp';
  process.env.MORPHEUS_PAYMASTER_TESTNET_ALLOW_ACCOUNTS = '';
  process.env.MORPHEUS_PAYMASTER_TESTNET_BLOCK_ACCOUNTS = '';
  process.env.MORPHEUS_PAYMASTER_TESTNET_ALLOW_DAPPS = 'demo-dapp';
  process.env.MORPHEUS_PAYMASTER_TESTNET_AA_CORE_HASH = aaCoreHash;
  process.env.MORPHEUS_PAYMASTER_TESTNET_WHITELIST_HOOK_HASH = whitelistHookHash;
  process.env.MORPHEUS_PAYMASTER_TESTNET_MULTI_HOOK_HASH = '';
  process.env.MORPHEUS_PAYMASTER_TESTNET_NEO_RPC_URL = 'https://neo-rpc.test';

  global.fetch = async (_url, options = {}) => {
    const body = JSON.parse(String(options.body || '{}'));
    if (body.method !== 'invokefunction') {
      throw new Error(`unexpected rpc method ${body.method}`);
    }
    const [, operation, args] = body.params;
    if (operation === 'getHook') {
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: {
            state: 'HALT',
            stack: [{ type: 'Hash160', value: whitelistHookHash }],
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (operation === 'isWhitelisted') {
      const targetHash = args?.[1]?.value;
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: {
            state: 'HALT',
            stack: [
              {
                type: 'Boolean',
                value: String(targetHash).toLowerCase() === downstreamAllowed.toLowerCase(),
              },
            ],
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    throw new Error(`unexpected operation ${operation}`);
  };

  try {
    const approved = await handler(
      new Request('http://local/paymaster/authorize', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          network: 'testnet',
          target_chain: 'neo_n3',
          account_id: 'aa-test-account',
          dapp_id: 'demo-dapp',
          target_contract: aaCoreHash,
          method: 'executeUserOp',
          userop_target_contract: downstreamAllowed,
          userop_method: 'claimRewards',
          estimated_gas_units: 120000,
          operation_hash: `0x${'44'.repeat(32)}`,
        }),
      })
    );
    assert.equal(approved.status, 200);
    const approvedBody = await approved.json();
    assert.equal(approvedBody.approved, true);
    assert.equal(approvedBody.onchain_policy.source, 'aa_hook');
    assert.equal(approvedBody.userop_target_contract, downstreamAllowed);
    assert.equal(approvedBody.userop_method, 'claimRewards');

    const missingHookContext = await handler(
      new Request('http://local/paymaster/authorize', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          network: 'testnet',
          target_chain: 'neo_n3',
          account_id: 'aa-test-account',
          dapp_id: 'demo-dapp',
          target_contract: aaCoreHash,
          method: 'executeUserOp',
          estimated_gas_units: 120000,
          operation_hash: `0x${'66'.repeat(32)}`,
        }),
      })
    );
    const missingHookContextBody = await missingHookContext.json();
    assert.equal(missingHookContextBody.approved, false);
    assert.match(missingHookContextBody.reason, /userop_target_contract is required/i);

    const denied = await handler(
      new Request('http://local/paymaster/authorize', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          network: 'testnet',
          target_chain: 'neo_n3',
          account_id: 'aa-test-account',
          dapp_id: 'demo-dapp',
          target_contract: aaCoreHash,
          method: 'executeUserOp',
          userop_target_contract: downstreamDenied,
          userop_method: 'claimRewards',
          estimated_gas_units: 120000,
          operation_hash: `0x${'55'.repeat(32)}`,
        }),
      })
    );
    assert.equal(denied.status, 200);
    const deniedBody = await denied.json();
    assert.equal(deniedBody.approved, false);
    assert.match(deniedBody.reason, /userop_target_contract is not allowlisted/i);
  } finally {
    process.env.MORPHEUS_PAYMASTER_TESTNET_ENABLED = snapshot.testnetEnabled;
    process.env.MORPHEUS_PAYMASTER_TESTNET_POLICY_ID = snapshot.testnetPolicyId;
    process.env.MORPHEUS_PAYMASTER_TESTNET_MAX_GAS_UNITS = snapshot.testnetMaxGas;
    process.env.MORPHEUS_PAYMASTER_TESTNET_ALLOW_TARGETS = snapshot.testnetAllowTargets;
    process.env.MORPHEUS_PAYMASTER_TESTNET_ALLOW_USEROP_TARGETS =
      snapshot.testnetAllowUserOpTargets;
    process.env.MORPHEUS_PAYMASTER_TESTNET_ALLOW_METHODS = snapshot.testnetAllowMethods;
    process.env.MORPHEUS_PAYMASTER_TESTNET_ALLOW_ACCOUNTS = snapshot.testnetAllowAccounts;
    process.env.MORPHEUS_PAYMASTER_TESTNET_BLOCK_ACCOUNTS = snapshot.testnetBlockAccounts;
    process.env.MORPHEUS_PAYMASTER_TESTNET_ALLOW_DAPPS = snapshot.testnetAllowDapps;
    process.env.MORPHEUS_PAYMASTER_TESTNET_AA_CORE_HASH = snapshot.testnetAaCoreHash;
    process.env.MORPHEUS_PAYMASTER_TESTNET_WHITELIST_HOOK_HASH = snapshot.testnetWhitelistHookHash;
    process.env.MORPHEUS_PAYMASTER_TESTNET_MULTI_HOOK_HASH = snapshot.testnetMultiHookHash;
    process.env.MORPHEUS_PAYMASTER_TESTNET_NEO_RPC_URL = snapshot.testnetNeoRpcUrl;
    global.fetch = originalFetch;
  }
});

test('compute execute supports encrypted confidential payload patches', async () => {
  const keyRes = await handler(
    new Request('http://local/oracle/public-key', { headers: authHeaders() })
  );
  const keyBody = await keyRes.json();
  const ciphertext = await encryptForOracle(
    keyBody.public_key,
    JSON.stringify({
      mode: 'builtin',
      function: 'math.modexp',
      input: { base: '2', exponent: '10', modulus: '17' },
      target_chain: 'neo_n3',
    })
  );

  const res = await handler(
    new Request('http://local/compute/execute', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ encrypted_payload: ciphertext }),
    })
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.mode, 'builtin');
  assert.equal(body.function, 'math.modexp');
  assert.equal(body.result.value, '4');
  assert.equal(body.target_chain, 'neo_n3');
});

test('compute execute resolves encrypted_input_ref through Supabase ciphertext storage', async () => {
  process.env.SUPABASE_URL = 'https://supabase.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';

  const keyRes = await handler(
    new Request('http://local/oracle/public-key', { headers: authHeaders() })
  );
  assert.equal(keyRes.status, 200);
  const keyBody = await keyRes.json();
  const ciphertext = await encryptForOracle(
    keyBody.public_key,
    JSON.stringify({
      mode: 'builtin',
      function: 'math.modexp',
      input: { base: '3', exponent: '7', modulus: '11' },
      target_chain: 'neo_n3',
    })
  );

  global.fetch = async (url, init = {}) => {
    const value = String(url);
    if (value.startsWith('https://supabase.test/rest/v1/morpheus_encrypted_secrets')) {
      if ((init.method || 'GET').toUpperCase() === 'PATCH') {
        const body = JSON.parse(init.body);
        assert.equal(body.metadata._consumed_request_id, 'compute-ref-1');
        return new Response(
          JSON.stringify([
            {
              id: '55555555-5555-5555-5555-555555555555',
              ciphertext,
              metadata: body.metadata,
            },
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response(
        JSON.stringify([
          {
            id: '55555555-5555-5555-5555-555555555555',
            ciphertext,
            metadata: {
              bound_requester: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              bound_callback_contract: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            },
          },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    throw new Error(`unexpected fetch ${value}`);
  };

  const res = await handler(
    new Request('http://local/compute/execute', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        encrypted_input_ref: '55555555-5555-5555-5555-555555555555',
        request_id: 'compute-ref-1',
        requester: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        callback_contract: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      }),
    })
  );
  const responseText = await res.text();
  assert.equal(res.status, 200, responseText);
  const body = JSON.parse(responseText);
  assert.equal(body.mode, 'builtin');
  assert.equal(body.function, 'math.modexp');
  assert.equal(body.result.value, '9');
  assert.equal(body.target_chain, 'neo_n3');
});

test('compute execute supports X25519 encrypted payloads larger than raw RSA limits', async () => {
  const keyRes = await handler(
    new Request('http://local/oracle/public-key', { headers: authHeaders() })
  );
  const keyBody = await keyRes.json();
  const ciphertext = await encryptForOracle(
    keyBody.public_key,
    JSON.stringify({
      mode: 'builtin',
      function: 'hash.sha256',
      input: {
        message: 'neo-morpheus',
        note: 'x'.repeat(2048),
      },
      target_chain: 'neo_n3',
    })
  );

  const res = await handler(
    new Request('http://local/compute/execute', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ encrypted_input: ciphertext }),
    })
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.mode, 'builtin');
  assert.equal(body.function, 'hash.sha256');
  assert.ok(body.result.digest);
});

test('compute execute supports wasm runtime', async () => {
  const res = await handler(
    new Request('http://local/compute/execute', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        wasm_base64: TEST_WASM_OK_BASE64,
        target_chain: 'neo_n3',
      }),
    })
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.runtime, 'wasm');
  assert.equal(body.result, true);
});

test('compute builtins support rsa verification and canonical polynomial order', async () => {
  const payloadString = JSON.stringify({ hello: 'neo-morpheus' });
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const signer = createSign('RSA-SHA256');
  signer.update(payloadString);
  signer.end();
  const signatureHex = signer.sign(privateKey).toString('hex');

  const rsaRes = await handler(
    new Request('http://local/compute/execute', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        mode: 'builtin',
        function: 'crypto.rsa_verify',
        input: {
          public_key: publicKey.export({ type: 'spki', format: 'pem' }),
          signature: signatureHex,
          payload: payloadString,
        },
        target_chain: 'neo_n3',
      }),
    })
  );
  assert.equal(rsaRes.status, 200);
  const rsaBody = await rsaRes.json();
  assert.equal(rsaBody.result.is_valid, true);

  const polynomialRes = await handler(
    new Request('http://local/compute/execute', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        mode: 'builtin',
        function: 'math.polynomial',
        input: { coefficients: [2, 3], x: 5 },
        target_chain: 'neo_n3',
      }),
    })
  );
  assert.equal(polynomialRes.status, 200);
  const polynomialBody = await polynomialRes.json();
  assert.equal(polynomialBody.result.value, '13');
});

test('oracle smart fetch enforces script timeout', async () => {
  global.fetch = async () =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  const res = await handler(
    new Request('http://local/oracle/smart-fetch', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        url: 'https://api.example.com/slow-script',
        script: 'function process(data) { while (true) {} }',
        script_timeout_ms: 50,
        target_chain: 'neo_n3',
      }),
    })
  );
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /timed out/);
});

test('oracle smart fetch supports wasm runtime', async () => {
  global.fetch = async () =>
    new Response(JSON.stringify({ ok: true, price: '1.23' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  const res = await handler(
    new Request('http://local/oracle/smart-fetch', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        url: 'https://api.example.com/wasm',
        wasm_base64: TEST_WASM_OK_BASE64,
        target_chain: 'neo_n3',
      }),
    })
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.mode, 'fetch+compute');
  assert.equal(body.result, true);
});

test('oracle fetch enforces upstream timeout (surfaces as 504, D4)', async () => {
  global.fetch = async (_url, init) =>
    await new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    });

  const res = await handler(
    new Request('http://local/oracle/query', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        url: 'https://api.example.com/hanging',
        oracle_timeout_ms: 50,
        target_chain: 'neo_n3',
      }),
    })
  );
  // An upstream fetch timeout is a gateway timeout (retryable), not a 400.
  assert.equal(res.status, 504);
  const body = await res.json();
  assert.match(body.error, /timed out/);
  assert.equal(body.kind, 'upstream_timeout');
});

test('oracle smart fetch rejects oversized upstream responses', async () => {
  process.env.ORACLE_MAX_UPSTREAM_BODY_BYTES = '128';
  global.fetch = async () =>
    new Response('x'.repeat(8192), {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    });

  const res = await handler(
    new Request('http://local/oracle/smart-fetch', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        url: 'https://api.example.com/large',
        target_chain: 'neo_n3',
      }),
    })
  );
  delete process.env.ORACLE_MAX_UPSTREAM_BODY_BYTES;
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /upstream response exceeds max size/i);
});

test('builtin providers are not constrained by the generic upstream body cap', async () => {
  process.env.ORACLE_MAX_UPSTREAM_BODY_BYTES = '128';
  delete process.env.ORACLE_MAX_PROVIDER_BODY_BYTES;
  global.fetch = async (url) => {
    assert.match(String(url), /api\.twelvedata\.com\/price/);
    return new Response(
      JSON.stringify({
        price: '2.673',
        padding: 'x'.repeat(6000),
      }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }
    );
  };

  const res = await handler(
    new Request('http://local/oracle/smart-fetch', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        provider: 'twelvedata',
        symbol: 'NEO-USD',
        json_path: 'price',
        target_chain: 'neo_n3',
      }),
    })
  );
  delete process.env.ORACLE_MAX_UPSTREAM_BODY_BYTES;
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.result, '2.673');
});

test('compute script enforces timeout', async () => {
  const res = await handler(
    new Request('http://local/compute/execute', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        mode: 'script',
        script: 'function process(input) { while (true) {} }',
        script_timeout_ms: 50,
        target_chain: 'neo_n3',
      }),
    })
  );
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /timed out/);
});

test('compute wasm enforces timeout', async () => {
  const res = await handler(
    new Request('http://local/compute/execute', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        wasm_base64: TEST_WASM_LOOP_BASE64,
        wasm_timeout_ms: 50,
        target_chain: 'neo_n3',
      }),
    })
  );
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /timed out/);
});

test('compute script rejects invalid entry point identifiers', async () => {
  const res = await handler(
    new Request('http://local/compute/execute', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        mode: 'script',
        script: 'function safe(input) { return input; }',
        entry_point: 'safe();evil',
        target_chain: 'neo_n3',
      }),
    })
  );
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /valid identifier/);
});

test('compute script rejects oversized input payloads', async () => {
  process.env.COMPUTE_MAX_INPUT_BYTES = '1024';
  const res = await handler(
    new Request('http://local/compute/execute', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        mode: 'script',
        script: 'function process(input) { return input.payload.length; }',
        input: { payload: 'x'.repeat(3000) },
        target_chain: 'neo_n3',
      }),
    })
  );
  delete process.env.COMPUTE_MAX_INPUT_BYTES;
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /compute input exceeds max size/i);
});

test('compute script rejects oversized result payloads', async () => {
  process.env.SCRIPT_WORKER_MAX_RESULT_BYTES = '1024';
  const res = await handler(
    new Request('http://local/compute/execute', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        mode: 'script',
        script: 'function process(input) { return "x".repeat(4000); }',
        target_chain: 'neo_n3',
      }),
    })
  );
  delete process.env.SCRIPT_WORKER_MAX_RESULT_BYTES;
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /script result exceeds max size/i);
});

test('compute execute resolves script_ref from a Neo N3 contract getter', async () => {
  const originalInvokeFunction = neoRpc.RPCClient.prototype.invokeFunction;
  neoRpc.RPCClient.prototype.invokeFunction = async function (_hash, method) {
    assert.equal(method, 'getScript');
    return {
      state: 'HALT',
      stack: [
        {
          type: 'ByteString',
          value: Buffer.from(
            'function process(input) { return input.value * 2; }',
            'utf8'
          ).toString('base64'),
        },
      ],
    };
  };
  try {
    const res = await handler(
      new Request('http://local/compute/execute', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          mode: 'script',
          script_ref: {
            contract_hash: '0x1111111111111111111111111111111111111111',
            method: 'getScript',
            script_name: 'double',
          },
          input: { value: 7 },
          target_chain: 'neo_n3',
        }),
      })
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.result, 14);
  } finally {
    neoRpc.RPCClient.prototype.invokeFunction = originalInvokeFunction;
  }
});

test('compute script blocks constructor escape patterns', async () => {
  const res = await handler(
    new Request('http://local/compute/execute', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        mode: 'script',
        script: 'function process(input) { return this.constructor.constructor(\"return 1\")(); }',
        target_chain: 'neo_n3',
      }),
    })
  );
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /constructor introspection is not allowed/);
});

test('oracle smart fetch blocks global object access in user script', async () => {
  global.fetch = async () =>
    new Response(JSON.stringify({ ok: true, price: '1.23' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  const res = await handler(
    new Request('http://local/oracle/smart-fetch', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        provider: 'twelvedata',
        symbol: 'NEO-USD',
        script: 'function process(data) { return globalThis.process; }',
        target_chain: 'neo_n3',
      }),
    })
  );
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /global object access is not allowed/);
});

test('oracle smart fetch resolves script_ref from a Neo N3 contract getter', async () => {
  const originalInvokeFunction = neoRpc.RPCClient.prototype.invokeFunction;
  neoRpc.RPCClient.prototype.invokeFunction = async function (_hash, method) {
    assert.equal(method, 'getScript');
    return {
      state: 'HALT',
      stack: [
        {
          type: 'String',
          value: 'function process(data) { return Number(data.price) > 1; }',
        },
      ],
    };
  };
  global.fetch = async () =>
    new Response(JSON.stringify({ price: '1.23' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  try {
    const res = await handler(
      new Request('http://local/oracle/smart-fetch', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          url: 'https://api.example.com/script-ref',
          script_ref: {
            contract_hash: '0x2222222222222222222222222222222222222222',
            method: 'getScript',
            script_name: 'greaterThanOne',
          },
          target_chain: 'neo_n3',
        }),
      })
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.result, true);
  } finally {
    neoRpc.RPCClient.prototype.invokeFunction = originalInvokeFunction;
  }
});

test('oracle smart fetch uses compact programmable context for large custom URL payloads', async () => {
  const previousMax = process.env.ORACLE_MAX_SCRIPT_INPUT_BYTES;
  process.env.ORACLE_MAX_SCRIPT_INPUT_BYTES = '1024';
  global.fetch = async () =>
    new Response(
      JSON.stringify({
        args: { probe: 'neo-morpheus' },
        noise: 'x'.repeat(700),
      }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }
    );
  try {
    const res = await handler(
      new Request('http://local/oracle/smart-fetch', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          url: 'https://api.example.com/compact-context',
          script: 'function process(data) { return data.args.probe + \"-script\"; }',
          target_chain: 'neo_n3',
        }),
      })
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.result, 'neo-morpheus-script');
  } finally {
    if (previousMax === undefined) delete process.env.ORACLE_MAX_SCRIPT_INPUT_BYTES;
    else process.env.ORACLE_MAX_SCRIPT_INPUT_BYTES = previousMax;
  }
});

test('sign-payload supports neo_n3', async () => {
  global.fetch = originalFetch;

  const neoN3Res = await handler(
    new Request('http://local/sign/payload', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ target_chain: 'neo_n3', message: 'hello neo n3' }),
    })
  );
  assert.equal(neoN3Res.status, 200);
  const neoN3 = await neoN3Res.json();
  assert.ok(neoN3.signature);
  assert.ok(neoN3.public_key);
  assert.ok(neoN3.address);
});

test('sign-payload rejects caller key material even when the retired escape hatch is set', async () => {
  global.fetch = originalFetch;
  process.env.MORPHEUS_ALLOW_CALLER_SIGNING_KEY = 'true';
  const res = await handler(
    new Request('http://local/sign/payload', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        target_chain: 'neo_n3',
        message: 'must use custody',
        private_key: '1'.repeat(64),
      }),
    })
  );
  assert.equal(res.status, 400);
  const body = await res.json();
  // The API error redactor treats private-key terminology as sensitive.
  assert.equal(body.error, 'internal error');
});

test('sign-payload signs every network-scoped path with the provisioned custody key', async () => {
  global.fetch = originalFetch;
  // The custody key row binds the network (docs/SIGNER_SERVICE.md §5), so the
  // request path's network inference no longer selects signing material: both
  // paths sign under the same provisioned worker key id.
  try {
    const mainnetRes = await handler(
      new Request('http://local/mainnet/sign/payload', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ target_chain: 'neo_n3', message: 'hello mainnet' }),
      })
    );
    assert.equal(mainnetRes.status, 200);
    const mainnetBody = await mainnetRes.json();
    assert.equal(mainnetBody.public_key, custodyWorkerAccount.publicKey);
    assert.equal(mainnetBody.address, custodyWorkerAccount.address);

    const testnetRes = await handler(
      new Request('http://local/testnet/sign/payload', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ target_chain: 'neo_n3', message: 'hello testnet' }),
      })
    );
    assert.equal(testnetRes.status, 200);
    const testnetBody = await testnetRes.json();
    assert.equal(testnetBody.public_key, custodyWorkerAccount.publicKey);
    assert.equal(testnetBody.address, custodyWorkerAccount.address);
  } finally {
    installCustodyTransportForTests();
  }
});

test('sign-payload maps the oracle_verifier key_role to its provisioned custody key', async () => {
  global.fetch = originalFetch;
  const res = await handler(
    new Request('http://local/sign/payload', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        target_chain: 'neo_n3',
        key_role: 'oracle_verifier',
        message: 'oracle verifier path',
      }),
    })
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.public_key, custodyOracleVerifierAccount.publicKey);
  assert.equal(body.address, custodyOracleVerifierAccount.address);
});

test('sign-payload ignores derived-key mode and signs through custody', async () => {
  global.fetch = originalFetch;
  // The Neo N3 sign lane has no local or Secrets-Manager-derived fallback: even
  // with NITRO_USE_DERIVED_KEYS set and a secrets provider installed, the
  // signature comes from the provisioned custody worker key.
  const previousUseDerivedKeys = process.env.NITRO_USE_DERIVED_KEYS;
  process.env.NITRO_USE_DERIVED_KEYS = 'true';
  __setSecretsProviderForTests(() => ({
    getSecret: async () => Buffer.from('99'.repeat(32), 'hex').toString('base64'),
  }));
  try {
    const res = await handler(
      new Request('http://local/sign/payload', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ target_chain: 'neo_n3', message: 'derived mode is inert' }),
      })
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.public_key, custodyWorkerAccount.publicKey);
    assert.equal(body.address, custodyWorkerAccount.address);
  } finally {
    if (previousUseDerivedKeys === undefined) delete process.env.NITRO_USE_DERIVED_KEYS;
    else process.env.NITRO_USE_DERIVED_KEYS = previousUseDerivedKeys;
    __resetSecretsProviderStateForTests();
    installCustodyTransportForTests();
  }
});

test('sign-payload surfaces a custody refusal envelope as 503', async () => {
  global.fetch = originalFetch;
  // A 2xx refusal envelope (§5) is a no from the enclave: the lane fail-closes
  // instead of returning an unsigned or mis-keyed result.
  __setCustodyTransportForTests(async (method, pathname) => {
    if (method === 'GET' && pathname === '/keys/key-worker') {
      return {
        key_id: 'key-worker',
        network: 'testnet',
        network_magic: 894710606,
        public_key: custodyWorkerAccount.publicKey,
        script_hash: `0x${custodyWorkerAccount.scriptHash}`,
        address: custodyWorkerAccount.address,
        signing_enabled: true,
      };
    }
    if (pathname === '/sign/raw') {
      return { allowed: false, code: 'policy_denied', message: 'role boundary exceeded' };
    }
    throw new Error(`unexpected custody route ${method} ${pathname}`);
  });
  try {
    const res = await handler(
      new Request('http://local/sign/payload', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ target_chain: 'neo_n3', message: 'refusal envelope' }),
      })
    );
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.match(body.error, /custody refused: policy_denied/);
  } finally {
    installCustodyTransportForTests();
  }
});

test('signed worker responses fail 503 for disabled, wrong-network, unreachable, or incomplete custody', async () => {
  global.fetch = originalFetch;
  const ready = {
    key_id: 'key-worker',
    network: 'testnet',
    network_magic: 894710606,
    public_key: custodyWorkerAccount.publicKey,
    script_hash: `0x${custodyWorkerAccount.scriptHash}`,
    address: custodyWorkerAccount.address,
    signing_enabled: true,
  };
  const cases = [
    { label: 'disabled', key: { ...ready, signing_enabled: false } },
    { label: 'wrong-network', key: { ...ready, network: 'mainnet', network_magic: 860833102 } },
    { label: 'incomplete', key: { ...ready, public_key: '' } },
    { label: 'unreachable', error: new Error('connection refused') },
  ];
  try {
    for (const testCase of cases) {
      let signCalls = 0;
      __setCustodyTransportForTests(async (method, pathname) => {
        if (method === 'GET' && pathname === '/keys/key-worker') {
          if (testCase.error) throw testCase.error;
          return testCase.key;
        }
        if (pathname === '/sign/raw') signCalls += 1;
        throw new Error(`unexpected custody route ${method} ${pathname}`);
      });
      const res = await handler(
        new Request('http://local/sign/payload', {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({ target_chain: 'neo_n3', message: testCase.label }),
        })
      );
      assert.equal(res.status, 503, testCase.label);
      const body = await res.json();
      assert.ok(body.error, testCase.label);
      assert.equal(signCalls, 0, `${testCase.label} must fail before raw signing`);
    }
  } finally {
    installCustodyTransportForTests();
  }
});

test('the custody sign lane never caches key identity across sign calls', async () => {
  const { buildSignedResultEnvelope } = await import('./src/chain/signing.js');
  const result = { probe: 'custody-rotation' };

  const first = await buildSignedResultEnvelope(result, {});
  assert.equal(first.public_key, custodyWorkerAccount.publicKey);
  assert.equal(first.key_source, 'custody');

  // Rotate the provisioned key id: with no cross-call cache, the very next
  // envelope is served by the new key (a rotated key can never keep signing
  // under a stale identity).
  custodyKeyAccounts['key-rotated'] = new neoWallet.Account('3'.repeat(64));
  process.env.SIGNER_ROLE_WORKER_KEY_ID = 'key-rotated';
  try {
    const afterRotation = await buildSignedResultEnvelope(result, {});
    assert.equal(afterRotation.public_key, custodyKeyAccounts['key-rotated'].publicKey);
  } finally {
    delete custodyKeyAccounts['key-rotated'];
    process.env.SIGNER_ROLE_WORKER_KEY_ID = 'key-worker';
  }
});
