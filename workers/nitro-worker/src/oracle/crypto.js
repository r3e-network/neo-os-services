import fs from 'node:fs/promises';
import path from 'node:path';
import { createDecipheriv, webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  assertUntrustedScriptsEnabled,
  assertWasmModuleSizeAllowed,
  decodeBase64,
  enforceSerializedSizeLimit,
  env,
  getSupabaseRestConfig,
  normalizeBoolean,
  normalizeMorpheusNetwork,
  normalizeTargetChain,
  cappedDurationMs,
  resolveMaxBytes,
  resolvePayloadNetwork,
  resolveWasmModuleBase64,
  requestLog,
  trimString,
} from '../platform/core.js';
import { deriveKeyBytes } from '../platform/nitro-signer.js';
import { runScriptWithTimeout } from '../platform/script-runner.js';
import { runWasmWithTimeout } from '../platform/wasm-runner.js';
import { validateUserScriptSource } from '../platform/script-policy.js';
import { resolveScriptSource } from '../platform/script-source.js';

let oracleKeyMaterialPromise;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const ORACLE_ENVELOPE_VERSION = 2;
const ORACLE_ENVELOPE_ALGORITHM = 'X25519-HKDF-SHA256-AES-256-GCM';
const ORACLE_ENVELOPE_INFO = 'morpheus-confidential-payload-v2';
const AES_GCM_IV_LENGTH_BYTES = 12;
const AES_GCM_TAG_LENGTH_BYTES = 16;

function getSubtle() {
  return globalThis.crypto?.subtle || webcrypto.subtle;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeHash160(value) {
  const raw = trimString(value).replace(/^0x/i, '').toLowerCase();
  return /^[0-9a-f]{40}$/.test(raw) ? `0x${raw}` : '';
}

function mergeConfidentialValue(baseValue, patchValue) {
  if (!isPlainObject(baseValue) || !isPlainObject(patchValue)) {
    return patchValue;
  }

  const merged = { ...baseValue };
  for (const [key, value] of Object.entries(patchValue)) {
    merged[key] = mergeConfidentialValue(baseValue[key], value);
  }
  return merged;
}

function getOracleKeyStorePath() {
  return (
    trimString(env('NITRO_ORACLE_KEYSTORE_PATH', 'MORPHEUS_ORACLE_KEYSTORE_PATH')) ||
    '/data/morpheus/oracle-key.json'
  );
}

export function resolveAllowEphemeralOracleKey() {
  const requested = normalizeBoolean(env('MORPHEUS_ALLOW_EPHEMERAL_KEY'), false);
  if (!requested) return false;
  return trimString(env('NODE_ENV')).toLowerCase() !== 'production';
}

function assertEphemeralKeyPolicy() {
  if (
    normalizeBoolean(env('MORPHEUS_ALLOW_EPHEMERAL_KEY'), false) &&
    trimString(env('NODE_ENV')).toLowerCase() === 'production'
  ) {
    throw new Error('MORPHEUS_ALLOW_EPHEMERAL_KEY is not allowed when NODE_ENV=production');
  }
}

function parseConfiguredOracleKeyMaterial() {
  const rawJson = trimString(env('MORPHEUS_ORACLE_KEY_MATERIAL_JSON') || '');
  const rawBase64 = trimString(env('MORPHEUS_ORACLE_KEY_MATERIAL_BASE64') || '');
  const explicitPublicKey = trimString(env('MORPHEUS_ORACLE_PUBLIC_KEY_RAW') || '');
  const explicitPrivateKey = trimString(env('MORPHEUS_ORACLE_PRIVATE_KEY_PKCS8') || '');

  let parsed = null;
  if (rawJson) {
    try {
      parsed = JSON.parse(rawJson);
    } catch {
      throw new Error('MORPHEUS_ORACLE_KEY_MATERIAL_JSON is not valid JSON');
    }
  } else if (rawBase64) {
    try {
      parsed = JSON.parse(Buffer.from(rawBase64, 'base64').toString('utf8'));
    } catch {
      throw new Error('MORPHEUS_ORACLE_KEY_MATERIAL_BASE64 is not valid base64 JSON');
    }
  } else if (explicitPublicKey && explicitPrivateKey) {
    parsed = {
      public_key_raw: explicitPublicKey,
      private_key_pkcs8: explicitPrivateKey,
    };
  } else {
    return null;
  }

  const publicKeyRaw = trimString(
    parsed?.public_key_raw || parsed?.publicKeyRaw || parsed?.public_key || ''
  );
  const privateKeyPkcs8 = trimString(
    parsed?.private_key_pkcs8 || parsed?.privateKeyPkcs8 || parsed?.private_key || ''
  );
  if (!publicKeyRaw || !privateKeyPkcs8) {
    throw new Error('configured oracle key material requires public_key_raw and private_key_pkcs8');
  }

  return formatKeyMaterial({
    publicKeyRawBytes: Buffer.from(publicKeyRaw, 'base64'),
    privateKeyPkcs8Bytes: Buffer.from(privateKeyPkcs8, 'base64'),
    source: 'configured-env',
  });
}

// A SEALED keystore (ciphertext) injected via env. The host passes only this
// ciphertext (never the plaintext key); the enclave unseals it in-TEE with the
// wrap key it derives ITSELF from Secrets Manager (reachable now that the SDK
// egresses via the vsock proxy). This is the no-host-unseal path for RC2.
function parseSealedKeystoreFromEnv() {
  const rawJson = trimString(env('MORPHEUS_ORACLE_SEALED_KEYSTORE_JSON') || '');
  const rawBase64 = trimString(env('MORPHEUS_ORACLE_SEALED_KEYSTORE_BASE64') || '');
  let parsed = null;
  if (rawJson) {
    try {
      parsed = JSON.parse(rawJson);
    } catch {
      throw new Error('MORPHEUS_ORACLE_SEALED_KEYSTORE_JSON is not valid JSON');
    }
  } else if (rawBase64) {
    try {
      parsed = JSON.parse(Buffer.from(rawBase64, 'base64').toString('utf8'));
    } catch {
      throw new Error('MORPHEUS_ORACLE_SEALED_KEYSTORE_BASE64 is not valid base64 JSON');
    }
  } else {
    return null;
  }
  const publicKeyRaw = trimString(parsed?.public_key_raw || parsed?.publicKeyRaw || '');
  const sealedPrivateKey = parsed?.sealed_private_key || parsed?.sealedPrivateKey || null;
  if (!publicKeyRaw || !sealedPrivateKey) {
    throw new Error('sealed oracle keystore requires public_key_raw and sealed_private_key');
  }
  return { public_key_raw: publicKeyRaw, sealed_private_key: sealedPrivateKey };
}

export function __resetOracleKeyMaterialForTests() {
  oracleKeyMaterialPromise = undefined;
}

export function __loadStableOracleKeyMaterialForTests() {
  return loadStableOracleKeyMaterial();
}

function formatKeyMaterial({ publicKeyRawBytes, privateKeyPkcs8Bytes, source }) {
  return {
    algorithm: ORACLE_ENVELOPE_ALGORITHM,
    source,
    key_format: 'raw',
    publicKeyRawBytes,
    privateKeyPkcs8Bytes,
    publicKeyRaw: Buffer.from(publicKeyRawBytes).toString('base64'),
  };
}

async function generateX25519KeyMaterial() {
  const subtle = getSubtle();
  const keyPair = await subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
  return {
    publicKeyRawBytes: Buffer.from(await subtle.exportKey('raw', keyPair.publicKey)),
    privateKeyPkcs8Bytes: Buffer.from(await subtle.exportKey('pkcs8', keyPair.privateKey)),
  };
}

function resolveAbsoluteKeystorePath(filePath) {
  if (path.isAbsolute(filePath)) return filePath;
  return path.resolve(repoRoot, filePath);
}

async function deriveOracleWrapKey() {
  const keyPath =
    trimString(
      env('NITRO_DSTACK_ORACLE_ENCRYPTION_KEY_PATH', 'MORPHEUS_ORACLE_ENCRYPTION_KEY_PATH')
    ) || 'morpheus/oracle/encryption/wrap/v1';
  const bytes = await deriveKeyBytes(keyPath, 'oracle-encryption-wrap');
  if (bytes.length < 32) {
    throw new Error(
      `oracle wrap key derivation produced ${bytes.length} bytes, expected at least 32`
    );
  }
  return Buffer.from(bytes).subarray(0, 32);
}

function decryptPrivateKey(sealed, wrapKey) {
  const decipher = createDecipheriv('aes-256-gcm', wrapKey, Buffer.from(sealed.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(sealed.ciphertext, 'base64')),
    decipher.final(),
  ]);
}

async function loadStableOracleKeyMaterial() {
  const wrapKey = await deriveOracleWrapKey();

  // Preferred (RC2): a sealed keystore injected via env. The enclave unseals the
  // ciphertext in-TEE with the wrap key it derives itself — the host never holds
  // the plaintext key. No host file needed (the enclave has no access to host
  // files anyway).
  const sealedFromEnv = parseSealedKeystoreFromEnv();
  if (sealedFromEnv) {
    const publicKeyRawBytes = Buffer.from(sealedFromEnv.public_key_raw, 'base64');
    const privateKeyPkcs8Bytes = decryptPrivateKey(sealedFromEnv.sealed_private_key, wrapKey);
    return formatKeyMaterial({
      publicKeyRawBytes,
      privateKeyPkcs8Bytes,
      source: 'nitro-sealed-env',
    });
  }

  const keystorePath = resolveAbsoluteKeystorePath(getOracleKeyStorePath());
  try {
    const raw = await fs.readFile(keystorePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!trimString(parsed.public_key_raw) || !parsed.sealed_private_key) {
      throw new Error('legacy or malformed X25519 keystore');
    }
    const publicKeyRawBytes = Buffer.from(parsed.public_key_raw, 'base64');
    const privateKeyPkcs8Bytes = decryptPrivateKey(parsed.sealed_private_key, wrapKey);
    return formatKeyMaterial({ publicKeyRawBytes, privateKeyPkcs8Bytes, source: 'nitro-sealed' });
  } catch (error) {
    // FOOTGUN: A missing keystore file is the expected cold-start state (the
    // enclave boots before the sealed keystore or host file is mounted). We
    // return undefined so the caller can fall back to ephemeral provisioning or
    // retry. Any other error — corrupt JSON, permission denied, etc. — is a
    // real problem and must surface immediately; swallowing it would hide
    // data-loss or permission bugs.
    if (error?.code === 'ENOENT') {
      return undefined;
    }
    if (error instanceof SyntaxError) {
      throw new Error(`keystore at ${keystorePath} contains invalid JSON: ${error.message}`);
    }
    throw error;
  }
}

export function resolveEncryptedPayload(payload) {
  const encryptedInputs =
    payload && typeof payload.encrypted_inputs === 'object' ? payload.encrypted_inputs : {};
  return trimString(
    payload.encrypted_payload ||
      payload.encrypted_token ||
      encryptedInputs.payload ||
      encryptedInputs.api_token ||
      encryptedInputs.token ||
      ''
  );
}

function resolveEncryptedTokenRef(payload) {
  const encryptedInputs = isPlainObject(payload?.encrypted_inputs) ? payload.encrypted_inputs : {};
  return trimString(
    payload?.encrypted_token_ref || encryptedInputs.api_token_ref || encryptedInputs.token_ref || ''
  );
}

export async function resolveEncryptedTokenCiphertext(payload = {}) {
  const directCiphertext = resolveEncryptedPayload(payload);
  if (directCiphertext) return directCiphertext;
  const encryptedTokenRef = resolveEncryptedTokenRef(payload);
  if (!encryptedTokenRef) return '';
  return loadEncryptedCiphertextByRef(encryptedTokenRef, payload);
}

function resolveEncryptedConfidentialPayload(payload) {
  const encryptedInputs = isPlainObject(payload?.encrypted_inputs) ? payload.encrypted_inputs : {};
  return trimString(
    payload?.encrypted_params ||
      payload?.encrypted_input ||
      encryptedInputs.params ||
      encryptedInputs.input ||
      payload?.encrypted_payload ||
      encryptedInputs.payload ||
      ''
  );
}

function resolveEncryptedConfidentialRef(payload) {
  const encryptedInputs = isPlainObject(payload?.encrypted_inputs) ? payload.encrypted_inputs : {};
  return trimString(
    payload?.encrypted_params_ref ||
      payload?.encrypted_input_ref ||
      payload?.encrypted_payload_ref ||
      encryptedInputs.params_ref ||
      encryptedInputs.input_ref ||
      encryptedInputs.payload_ref ||
      ''
  );
}

function namesTargetChain(label) {
  if (typeof label !== 'string' || !label.trim()) return false;
  try {
    normalizeTargetChain(label);
    return true;
  } catch {
    return false;
  }
}

/**
 * The network whose encrypted secrets an encrypted ref is looked up in: the
 * payload's network, or this worker's MORPHEUS_NETWORK when it names none. A
 * recovery ticket names its chain family in `network` (`neo_n3` by default,
 * and the documented request sends it); for such a caller
 * (`networkNamesChainFamily`), a label that normalizeTargetChain accepts names
 * no Morpheus network, so the ref is looked up under this worker's network, the
 * rule the enclave host applies when it signs a recovery ticket. Any other
 * explicit label goes through the strict resolvePayloadNetwork. Recognized
 * AA-v3/v4 callback/result encodings carry an opaque signed AA network label
 * instead; their refs stay in the worker deployment and all deployment aliases
 * must agree with it. The ticket payload itself is never rewritten.
 */
function resolveEncryptedRefNetwork(payload, { networkNamesChainFamily = false } = {}) {
  const workerNetwork = normalizeMorpheusNetwork(
    env('MORPHEUS_NETWORK') || env('NEXT_PUBLIC_MORPHEUS_NETWORK') || 'testnet'
  );
  const encoding = trimString(payload?.callback_encoding || payload?.result_encoding || '');
  if (
    encoding === 'neo_n3_action_v3' ||
    encoding === 'neo_n3_recovery_v3' ||
    encoding === 'neo_n3_action_v4'
  ) {
    // AA network text is an opaque signed domain, never a storage deployment.
    // Check every actual deployment assertion; do not let first-alias wins
    // hide a conflict or use a ticket label to read another deployment's refs.
    for (const key of ['morpheus_network', 'runtime_network', 'environment']) {
      const value = payload?.[key];
      if (value === undefined || value === null || value === '') continue;
      if (normalizeMorpheusNetwork(value) !== workerNetwork) {
        throw new Error(`encrypted ref ${key} does not match worker network`);
      }
    }
    return workerNetwork;
  }
  if (networkNamesChainFamily && namesTargetChain(payload?.network)) {
    const withoutChainFamily = { ...payload };
    delete withoutChainFamily.network;
    return resolvePayloadNetwork(withoutChainFamily, workerNetwork);
  }
  return resolvePayloadNetwork(payload, workerNetwork);
}

async function loadEncryptedCiphertextByRef(ref, payload = {}, options = {}) {
  const requestId = resolveEncryptedRefRequestId(payload);
  if (!requestId) {
    throw new Error('request_id is required when resolving an encrypted ref');
  }
  const restConfig = getSupabaseRestConfig();
  if (!restConfig)
    throw new Error(
      'SUPABASE_URL and a Supabase secret or service-role key are required for encrypted ref resolution'
    );
  const network = resolveEncryptedRefNetwork(payload, options);

  const url = new URL(`${restConfig.restUrl}/morpheus_encrypted_secrets`);
  url.searchParams.set('select', 'id,ciphertext,network,metadata');
  url.searchParams.set('id', `eq.${ref}`);
  url.searchParams.set('network', `eq.${network}`);
  url.searchParams.set('limit', '1');

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      apikey: restConfig.apiKey,
      authorization: `Bearer ${restConfig.apiKey}`,
      accept: 'application/json',
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`encrypted ref lookup failed: ${response.status} ${text}`.trim());
  }

  const rows = await response.json().catch(() => []);
  const row = Array.isArray(rows) ? rows[0] : null;
  assertEncryptedRefScope(row, payload);
  const claimedRow = await claimEncryptedRef(row, payload, restConfig, network);
  const effectiveRow = claimedRow || row;
  const ciphertext = trimString(effectiveRow?.ciphertext || '');
  if (!ciphertext) {
    throw new Error(`encrypted ref not found: ${ref}`);
  }
  return ciphertext;
}

function assertEncryptedRefScope(row, payload = {}) {
  const metadata = isPlainObject(row?.metadata) ? row.metadata : {};
  const boundRequester = normalizeHash160(metadata.bound_requester || metadata.requester || '');
  const boundCallbackContract = normalizeHash160(
    metadata.bound_callback_contract || metadata.callback_contract || ''
  );
  const expectedRequester = normalizeHash160(
    payload.requester || payload.requester_script_hash || ''
  );
  const expectedCallbackContract = normalizeHash160(
    payload.callback_contract || payload.callbackContract || ''
  );

  if (boundRequester) {
    if (!expectedRequester) {
      throw new Error('encrypted ref requester binding present but requester context is missing');
    }
    if (boundRequester !== expectedRequester) {
      throw new Error('encrypted ref requester mismatch');
    }
  }

  if (boundCallbackContract) {
    if (!expectedCallbackContract) {
      throw new Error('encrypted ref callback binding present but callback context is missing');
    }
    if (boundCallbackContract !== expectedCallbackContract) {
      throw new Error('encrypted ref callback mismatch');
    }
  }
}

function resolveEncryptedRefRequestId(payload = {}) {
  return trimString(payload.request_id || payload.requestId || '');
}

function readEncryptedRefConsumedRequestId(row) {
  const metadata = isPlainObject(row?.metadata) ? row.metadata : {};
  return trimString(row?.consumed_request_id || metadata._consumed_request_id || '');
}

function buildEncryptedRefClaimUrl(restUrl, ref, network, payload = {}) {
  const url = new URL(`${restUrl}/morpheus_encrypted_secrets`);
  url.searchParams.set('select', 'id,ciphertext,metadata');
  url.searchParams.set('id', `eq.${ref}`);
  url.searchParams.set('network', `eq.${network}`);
  url.searchParams.set('metadata->>_consumed_request_id', 'is.null');

  const metadata = isPlainObject(payload?.metadata) ? payload.metadata : {};
  const boundRequester = normalizeHash160(
    metadata.bound_requester || payload.requester || payload.requester_script_hash || ''
  );
  const boundCallbackContract = normalizeHash160(
    metadata.bound_callback_contract || payload.callback_contract || payload.callbackContract || ''
  );
  if (boundRequester) {
    url.searchParams.set('metadata->>bound_requester', `eq.${boundRequester}`);
  }
  if (boundCallbackContract) {
    url.searchParams.set('metadata->>bound_callback_contract', `eq.${boundCallbackContract}`);
  }
  return url;
}

async function claimEncryptedRef(row, payload = {}, restConfig, network) {
  if (!row || typeof row !== 'object') return row;

  const requestId = resolveEncryptedRefRequestId(payload);
  const consumedRequestId = readEncryptedRefConsumedRequestId(row);
  if (!requestId) {
    throw new Error('request_id is required when resolving an encrypted ref');
  }
  if (consumedRequestId) {
    if (consumedRequestId === requestId) return row;
    throw new Error('encrypted ref already consumed by another request');
  }

  const ref = trimString(row.id || '');
  if (!ref) return row;
  const claimUrl = buildEncryptedRefClaimUrl(restConfig.restUrl, ref, network, payload);
  const metadata = isPlainObject(row.metadata) ? row.metadata : {};
  const claimResponse = await fetch(claimUrl.toString(), {
    method: 'PATCH',
    headers: {
      apikey: restConfig.apiKey,
      authorization: `Bearer ${restConfig.apiKey}`,
      accept: 'application/json',
      'content-type': 'application/json',
      prefer: 'return=representation',
    },
    body: JSON.stringify({
      metadata: {
        ...metadata,
        _consumed_request_id: requestId,
        _consumed_at: new Date().toISOString(),
      },
      updated_at: new Date().toISOString(),
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!claimResponse.ok) {
    const text = await claimResponse.text().catch(() => '');
    throw new Error(`encrypted ref claim failed: ${claimResponse.status} ${text}`.trim());
  }

  const claimedRows = await claimResponse.json().catch(() => []);
  const claimedRow = Array.isArray(claimedRows) ? claimedRows[0] : null;
  if (!claimedRow) {
    throw new Error('encrypted ref already consumed by another request');
  }
  return claimedRow;
}

function parseX25519Envelope(ciphertext) {
  try {
    const decoded = Buffer.from(decodeBase64(ciphertext)).toString('utf8');
    const parsed = JSON.parse(decoded);
    if (!isPlainObject(parsed)) return null;
    if (Number(parsed.v ?? parsed.version) !== ORACLE_ENVELOPE_VERSION) return null;
    if (trimString(parsed.alg ?? parsed.algorithm) !== ORACLE_ENVELOPE_ALGORITHM) return null;
    if (
      !trimString(parsed.epk) ||
      !trimString(parsed.iv) ||
      !trimString(parsed.ct) ||
      !trimString(parsed.tag)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function importX25519PrivateKey(privateKeyPkcs8Bytes) {
  return getSubtle().importKey('pkcs8', privateKeyPkcs8Bytes, { name: 'X25519' }, false, [
    'deriveBits',
  ]);
}

async function importX25519PublicKey(publicKeyRawBytes) {
  return getSubtle().importKey('raw', publicKeyRawBytes, { name: 'X25519' }, false, []);
}

async function deriveAesKey(
  sharedSecretBytes,
  senderPublicKeyBytes,
  recipientPublicKeyBytes,
  usage
) {
  const subtle = getSubtle();
  const keyMaterial = await subtle.importKey('raw', sharedSecretBytes, 'HKDF', false, [
    'deriveKey',
  ]);
  const info = new Uint8Array([
    ...Buffer.from(ORACLE_ENVELOPE_INFO, 'utf8'),
    ...senderPublicKeyBytes,
    ...recipientPublicKeyBytes,
  ]);
  return subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: recipientPublicKeyBytes,
      info,
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    [usage]
  );
}

async function decryptX25519Envelope(envelope, keyMaterial) {
  const senderPublicKeyBytes = decodeBase64(envelope.epk);
  if (senderPublicKeyBytes.length !== 32) {
    throw new Error('invalid X25519 envelope public key length');
  }

  const iv = decodeBase64(envelope.iv);
  if (iv.length !== AES_GCM_IV_LENGTH_BYTES) {
    throw new Error('invalid X25519 envelope iv length');
  }

  const tag = decodeBase64(envelope.tag);
  if (tag.length !== AES_GCM_TAG_LENGTH_BYTES) {
    throw new Error('invalid X25519 envelope tag length');
  }

  const subtle = getSubtle();
  const [privateKey, senderPublicKey] = await Promise.all([
    importX25519PrivateKey(keyMaterial.privateKeyPkcs8Bytes),
    importX25519PublicKey(senderPublicKeyBytes),
  ]);
  const sharedSecretBytes = new Uint8Array(
    await subtle.deriveBits({ name: 'X25519', public: senderPublicKey }, privateKey, 256)
  );
  const aesKey = await deriveAesKey(
    sharedSecretBytes,
    senderPublicKeyBytes,
    keyMaterial.publicKeyRawBytes,
    'decrypt'
  );
  const plaintext = await subtle.decrypt(
    { name: 'AES-GCM', iv, tagLength: AES_GCM_TAG_LENGTH_BYTES * 8 },
    aesKey,
    Buffer.concat([decodeBase64(envelope.ct), tag])
  );
  return Buffer.from(plaintext).toString('utf8');
}

export async function ensureOracleKeyMaterial(_payload = {}) {
  if (!oracleKeyMaterialPromise) {
    const pending = (async () => {
      assertEphemeralKeyPolicy();
      let lastStableKeyMaterialError;
      try {
        const configured = parseConfiguredOracleKeyMaterial();
        if (configured) return configured;
      } catch (error) {
        requestLog('warn', 'oracle.key_material.configured_source_failed', {
          error: error instanceof Error ? error.message : String(error),
          fallback: 'stable-keystore',
        });
      }

      try {
        const stable = await loadStableOracleKeyMaterial();
        if (stable) return stable;
      } catch (error) {
        lastStableKeyMaterialError = error;
        requestLog('warn', 'oracle.key_material.stable_source_failed', {
          error: error instanceof Error ? error.message : String(error),
          fallback: 'ephemeral-memory',
        });
      }

      if (!resolveAllowEphemeralOracleKey()) {
        const unavailable = new Error(
          'oracle key material unavailable: no configured key, Secrets Manager sealed keystore, or ephemeral key not allowed'
        );
        if (lastStableKeyMaterialError) unavailable.cause = lastStableKeyMaterialError;
        throw unavailable;
      }

      const generated = await generateX25519KeyMaterial();
      return formatKeyMaterial({
        publicKeyRawBytes: generated.publicKeyRawBytes,
        privateKeyPkcs8Bytes: generated.privateKeyPkcs8Bytes,
        source: 'ephemeral-memory',
      });
    })();
    // Do NOT cache a REJECTED resolution. The enclave answers /health (and the
    // public gateway starts routing) before provision-enclave-compute.sh injects
    // MORPHEUS_ORACLE_KEY_MATERIAL_BASE64; an encrypted request in that boot
    // window would otherwise permanently poison the decrypt lane (a cached
    // rejection) until the next enclave restart. Clear the singleton on failure
    // so the next call retries once provisioning has landed.
    pending.catch(() => {
      if (oracleKeyMaterialPromise === pending) oracleKeyMaterialPromise = undefined;
    });
    oracleKeyMaterialPromise = pending;
  }

  return oracleKeyMaterialPromise;
}

export async function decryptEncryptedToken(ciphertext, payload = {}) {
  if (!ciphertext) return null;
  const keyMaterial = await ensureOracleKeyMaterial(payload);
  const envelope = parseX25519Envelope(ciphertext);
  if (!envelope) {
    throw new Error(
      `unsupported confidential payload format; expected ${ORACLE_ENVELOPE_ALGORITHM}`
    );
  }
  return decryptX25519Envelope(envelope, keyMaterial);
}

/**
 * Merge a confidential patch (direct ciphertext or an encrypted ref) into the
 * payload. `options.networkNamesChainFamily` marks a caller whose `network`
 * field names a chain family rather than a Morpheus network (the NeoDID
 * recovery ticket); it only changes which network an encrypted ref is looked
 * up in (see resolveEncryptedRefNetwork).
 */
export async function resolveConfidentialPayload(payload = {}, options = {}) {
  let ciphertext = resolveEncryptedConfidentialPayload(payload);
  const encryptedRef = resolveEncryptedConfidentialRef(payload);
  if (!ciphertext && encryptedRef) {
    ciphertext = await loadEncryptedCiphertextByRef(encryptedRef, payload, options);
  }
  if (!ciphertext) return payload;

  const plaintext = await decryptEncryptedToken(ciphertext, payload);
  if (!plaintext) return payload;

  let parsed;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    return payload;
  }

  if (!isPlainObject(parsed)) return payload;

  const mergedPayload = { ...payload };
  delete mergedPayload.encrypted_params;
  delete mergedPayload.encrypted_input;
  if (mergedPayload.encrypted_payload === ciphertext) {
    delete mergedPayload.encrypted_payload;
  }

  if (isPlainObject(mergedPayload.encrypted_inputs)) {
    const encryptedInputs = { ...mergedPayload.encrypted_inputs };
    if (encryptedInputs.params === ciphertext) delete encryptedInputs.params;
    if (encryptedInputs.input === ciphertext) delete encryptedInputs.input;
    if (encryptedInputs.payload === ciphertext) delete encryptedInputs.payload;
    if (Object.keys(encryptedInputs).length > 0) {
      mergedPayload.encrypted_inputs = encryptedInputs;
    } else {
      delete mergedPayload.encrypted_inputs;
    }
  }

  return mergeConfidentialValue(mergedPayload, parsed);
}

export async function executeProgrammableOracle(payload, context) {
  const maxScriptInputBytes = resolveMaxBytes(
    env('ORACLE_MAX_SCRIPT_INPUT_BYTES'),
    128 * 1024,
    1024
  );
  const programmableContext = {
    target_chain: context.target_chain,
    target_chain_id: context.target_chain_id,
    request_source: context.request_source,
    upstream_status: context.upstream_status,
    provider: context.provider ?? null,
    provider_pair: context.provider_pair ?? null,
    selected_value: context.selected_value ?? null,
    encrypted_token_present: Boolean(context.encrypted_token_present),
  };
  const wasmModuleBase64 = resolveWasmModuleBase64(payload);
  if (wasmModuleBase64) {
    // SECURITY (S1): gate WASM execution behind the same opt-in switch as
    // scripts (default off) and bound the decoded module size.
    assertUntrustedScriptsEnabled();
    assertWasmModuleSizeAllowed(wasmModuleBase64);
    enforceSerializedSizeLimit(
      { data: context.data, context: programmableContext },
      'oracle programmable input',
      maxScriptInputBytes
    );
    const timeoutMs = cappedDurationMs(
      payload.wasm_timeout_ms ||
        payload.script_timeout_ms ||
        payload.oracle_script_timeout_ms ||
        env('ORACLE_WASM_TIMEOUT_MS', 'MORPHEUS_WASM_TIMEOUT_MS') ||
        10_000,
      10_000,
      10_000
    );
    return {
      executed: true,
      runtime: 'wasm',
      result: await runWasmWithTimeout({
        mode: 'oracle',
        moduleBase64: wasmModuleBase64,
        entryPoint:
          trimString(
            payload.wasm_entry || payload.wasm_entry_point || payload.entry_point || 'run'
          ) || 'run',
        input: { data: context.data, context: programmableContext },
        timeoutMs,
      }),
    };
  }

  const script = await resolveScriptSource(payload);
  if (!script) {
    return {
      executed: false,
      result: context.selected_value ?? context.data ?? context.raw_response,
    };
  }

  assertUntrustedScriptsEnabled();
  validateUserScriptSource(script);
  enforceSerializedSizeLimit(
    { data: context.data, context: programmableContext },
    'oracle programmable input',
    maxScriptInputBytes
  );

  const timeoutMs = cappedDurationMs(
    payload.script_timeout_ms ||
      payload.oracle_script_timeout_ms ||
      env('ORACLE_SCRIPT_TIMEOUT_MS'),
    2000,
    10_000
  );

  return {
    executed: true,
    runtime: 'script',
    result: await runScriptWithTimeout({
      mode: 'oracle',
      script,
      data: context.data,
      context: programmableContext,
      timeoutMs,
    }),
  };
}
