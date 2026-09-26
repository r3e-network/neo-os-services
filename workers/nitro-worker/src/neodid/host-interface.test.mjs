// The NeoDID lane in ./index.js is a pinned copy of neo-os-did
// (vendor/neo-os-did.pin.json); this test file is owned by this repository.
// It proves the lane runs on this worker's own module instances: a seam
// installed on platform/custody.js, platform/nitro-signer.js or
// oracle/crypto.js is the one the lane uses. These tests fail against a lane
// that imports a second, vendored copy of those modules, which is what the
// removed process-global bridges used to paper over.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { wallet as neoWallet } from '@cityofzion/neon-js';
import { encryptConfidentialEnvelope } from '@r3e-network/neo-os-services-shared/confidential-envelope';

import {
  __resetCustodyTransportForTests,
  __setCustodyTransportForTests,
} from '../platform/custody.js';
import {
  __resetSecretsProviderStateForTests,
  __setSecretsProviderForTests,
} from '../platform/nitro-signer.js';
import { __resetOracleKeyMaterialForTests, ensureOracleKeyMaterial } from '../oracle/crypto.js';
import { __resetNeoDidStateForTests, handleNeoDidBind, handleNeoDidRuntime } from './index.js';

const WORKER_SRC = fileURLToPath(new URL('..', import.meta.url));
const LANE_URL = new URL('./index.js', import.meta.url);
const KEY_ID = 'key-neodid-host-interface';
const VAULT = '0x6d0656f6dd91469db1c90cc1e574380613f43738';
const workerAccount = new neoWallet.Account(
  createHash('sha256').update('neodid-host-interface-worker').digest('hex')
);

const sha256 = (bytes) => createHash('sha256').update(bytes).digest();

function masterNullifier(provider, providerUid, saltBytes) {
  return createHash('sha256')
    .update(Buffer.from(provider, 'utf8'))
    .update(Buffer.from([0x1f]))
    .update(Buffer.from(providerUid, 'utf8'))
    .update(Buffer.from([0x1f]))
    .update(saltBytes)
    .digest('hex');
}

const ENV_KEYS = [
  'SIGNER_SERVICE_URL',
  'SIGNER_SERVICE_TOKEN',
  'SIGNER_ROLE_WORKER_KEY_ID',
  'MORPHEUS_NETWORK',
  'NEODID_SECRET_SALT',
  'NITRO_NEODID_SALT_PATH',
  'NITRO_NEODID_SALT_SECRET_ID',
  'MORPHEUS_NEODID_ALLOW_UNVERIFIED_UID',
  'MORPHEUS_ALLOW_EPHEMERAL_KEY',
  'MORPHEUS_ORACLE_KEY_MATERIAL_JSON',
  'MORPHEUS_ORACLE_KEY_MATERIAL_BASE64',
  'MORPHEUS_ORACLE_PUBLIC_KEY_RAW',
  'MORPHEUS_ORACLE_PRIVATE_KEY_PKCS8',
  'MORPHEUS_ORACLE_SEALED_KEYSTORE_JSON',
  'MORPHEUS_ORACLE_SEALED_KEYSTORE_BASE64',
  'NITRO_ORACLE_KEYSTORE_PATH',
  'NITRO_EMIT_ATTESTATION',
  'NODE_ENV',
];

// Every test starts from cleared seams and a known environment, and puts both
// back when it ends.
function prepare(t) {
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.SIGNER_ROLE_WORKER_KEY_ID = KEY_ID;
  process.env.MORPHEUS_NETWORK = 'testnet';
  process.env.MORPHEUS_NEODID_ALLOW_UNVERIFIED_UID = 'true';
  // No test here may reach a network: the runtime lane probes the Nitro health
  // endpoint and must see that probe fail, not a real server.
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('network access is not allowed in this test');
  });
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    __resetCustodyTransportForTests();
    __resetSecretsProviderStateForTests();
    __resetOracleKeyMaterialForTests();
    __resetNeoDidStateForTests();
  });
}

// Deterministic custody signer speaking the §5 shapes for one worker key,
// recording every call it answers.
function installCustody(calls = []) {
  __setCustodyTransportForTests(async (method, pathname, body = {}) => {
    calls.push({ method, pathname, body });
    if (method === 'GET' && pathname === `/keys/${KEY_ID}`) {
      return {
        key_id: KEY_ID,
        network: 'testnet',
        network_magic: 894710606,
        public_key: workerAccount.publicKey,
        address: workerAccount.address,
        script_hash: `0x${workerAccount.scriptHash}`,
        signing_enabled: true,
      };
    }
    if (method === 'POST' && pathname === '/sign/raw' && body.key_id === KEY_ID) {
      return {
        allowed: true,
        key_id: KEY_ID,
        signature: neoWallet.sign(String(body.data_hex), workerAccount.privateKey),
        public_key: workerAccount.publicKey,
        address: workerAccount.address,
        script_hash: `0x${workerAccount.scriptHash}`,
      };
    }
    return { allowed: false, code: 'not_found', message: `unexpected ${method} ${pathname}` };
  });
  return calls;
}

test('the pinned lane imports the platform, chain and oracle modules of this worker', () => {
  const source = readFileSync(LANE_URL, 'utf8');
  const relative = [...source.matchAll(/from '(\.{1,2}\/[^']+)'/g)].map((match) => match[1]);
  assert.deepEqual(relative.sort(), [
    '../chain/index.js',
    '../oracle/crypto.js',
    '../platform/core.js',
    '../platform/nitro-signer.js',
  ]);
  for (const specifier of relative) {
    const resolved = fileURLToPath(new URL(specifier, LANE_URL));
    assert.ok(resolved.startsWith(WORKER_SRC), `${specifier} resolves outside ${WORKER_SRC}`);
  }
});

test('the lane signs through the custody transport installed on platform/custody.js', async (t) => {
  prepare(t);
  // With the platform seam cleared and no custody service configured, the lane
  // cannot sign at all ...
  await assert.rejects(handleNeoDidRuntime({}), /custody signer service is not configured/);

  // ... and the transport installed on the platform module is the one it signs with.
  const calls = installCustody();
  const response = await handleNeoDidRuntime({});
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.verification_public_key, workerAccount.publicKey);
  assert.deepEqual(
    calls.map(({ method, pathname }) => `${method} ${pathname}`),
    [`GET /keys/${KEY_ID}`, 'POST /sign/raw']
  );
  assert.equal(calls[1].body.data_hex, sha256('neodid-runtime').toString('hex'));
});

test('the lane derives its nullifier salt through the secrets provider installed on platform/nitro-signer.js', async (t) => {
  prepare(t);
  const master = Buffer.alloc(32, 0x5a);
  const requested = [];
  __setSecretsProviderForTests(() => ({
    async getSecret(secretId) {
      requested.push(secretId);
      return master.toString('base64');
    },
  }));
  installCustody();

  const response = await handleNeoDidBind({
    provider: 'twitter',
    provider_uid: 'twitter-uid-1',
    vault_account: VAULT,
    claim_type: 'Twitter_VIP',
    claim_value: 'true',
  });
  assert.equal(response.status, 200);
  const body = await response.json();

  // deriveKeyBytes('morpheus/neodid/nullifier/v1', 'neodid-nullifier-salt') over
  // the provider's master, then the lane's sha256-of-hex salt normalization.
  const derived = sha256(
    Buffer.concat([master, Buffer.from('\0morpheus/neodid/nullifier/v1\0neodid-nullifier-salt')])
  );
  const salt = sha256(Buffer.from(derived.toString('hex'), 'utf8'));
  assert.deepEqual(requested, ['morpheus/neodid-salt']);
  assert.equal(body.master_nullifier, `0x${masterNullifier('twitter', 'twitter-uid-1', salt)}`);
});

test('the lane decrypts confidential payloads with the key material of oracle/crypto.js', async (t) => {
  prepare(t);
  process.env.NEODID_SECRET_SALT = 'host-interface-salt';
  process.env.MORPHEUS_ALLOW_EPHEMERAL_KEY = 'true';
  process.env.NITRO_ORACLE_KEYSTORE_PATH = join(tmpdir(), `neodid-no-keystore-${process.pid}.json`);
  // The oracle wrap key is derived before the (absent) keystore is read, so the
  // secrets seam keeps that derivation in-process.
  __setSecretsProviderForTests(() => ({
    getSecret: async () => Buffer.alloc(32, 0x11).toString('base64'),
  }));
  installCustody();

  // An ephemeral key exists once per crypto module instance; a payload sealed to
  // this instance's key opens only in this instance.
  const keyMaterial = await ensureOracleKeyMaterial();
  assert.equal(keyMaterial.source, 'ephemeral-memory');
  const encryptedParams = await encryptConfidentialEnvelope(
    keyMaterial.publicKeyRawBytes,
    JSON.stringify({ provider_uid: 'uid-from-ciphertext' })
  );

  const response = await handleNeoDidBind({
    provider: 'twitter',
    vault_account: VAULT,
    encrypted_params: encryptedParams,
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  const salt = sha256(Buffer.from('host-interface-salt', 'utf8'));
  assert.equal(
    body.master_nullifier,
    `0x${masterNullifier('twitter', 'uid-from-ciphertext', salt)}`
  );
});
