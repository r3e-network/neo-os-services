// AWS Nitro signer + Secrets Manager adapter. Key material (X25519 encryption
// wrap key, NeoDID nullifier salt) lives in AWS Secrets Manager and is read via
// the instance role; deterministic per-(path,purpose) sub-keys are derived from
// those masters. Neo N3 fulfillment signing is performed by the relayer through
// the 8787 enclave, so the worker itself only needs derived/wrap key material.
import { wallet as neoWallet } from '@cityofzion/neon-js';
import { env, normalizeBoolean, sha256Hex, stableStringify, trimString } from './core.js';

const derivedKeyCache = new Map();
const MAX_DERIVED_KEY_CACHE_SIZE = 64;
const secretCache = new Map(); // secretId -> Promise<Buffer>
let secretsClientPromise;
let secretsFactoryForTests = null;

// Secret IDs (overridable via env); created on the box: 32 random bytes, base64.
function x25519SecretId() {
  return (
    trimString(env('NITRO_X25519_SECRET_ID', 'MORPHEUS_X25519_SECRET_ID')) || 'morpheus/x25519-wrap'
  );
}
function neodidSaltSecretId() {
  return (
    trimString(env('NITRO_NEODID_SALT_SECRET_ID', 'MORPHEUS_NEODID_SALT_SECRET_ID')) ||
    'morpheus/neodid-salt'
  );
}

export function shouldUseDerivedKeys(payload = {}) {
  return normalizeBoolean(payload.use_derived_keys ?? env('NITRO_USE_DERIVED_KEYS'), false);
}

export function validateKeyRole(role) {
  if (typeof role !== 'string' || role.length === 0 || role.length > 64) {
    throw new Error('invalid key role: must be 1-64 alphanumeric/dash/underscore chars');
  }
  if (/[/\\]/.test(role) || role.includes('..')) {
    throw new Error('invalid key role: must be 1-64 alphanumeric/dash/underscore chars');
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(role)) {
    throw new Error('invalid key role: must be 1-64 alphanumeric/dash/underscore chars');
  }
}

export function shouldEmitAttestation(payload = {}) {
  return normalizeBoolean(
    payload.include_attestation ?? payload.emit_attestation ?? env('NITRO_EMIT_ATTESTATION'),
    false
  );
}

function resetCaches() {
  derivedKeyCache.clear();
  secretCache.clear();
  secretsClientPromise = undefined;
}

// Test seam: inject a fake { getSecret(id) -> base64 } provider.
export function __setSecretsProviderForTests(factory) {
  secretsFactoryForTests = factory;
  resetCaches();
}
export function __resetSecretsProviderStateForTests() {
  secretsFactoryForTests = null;
  resetCaches();
}
// Back-compat aliases for the prior dstack test seams.
export const __setDstackClientFactoryForTests = __setSecretsProviderForTests;
export const __resetDstackClientStateForTests = __resetSecretsProviderStateForTests;

async function getSecretsClient() {
  if (secretsFactoryForTests) return secretsFactoryForTests();
  if (!secretsClientPromise) {
    secretsClientPromise = (async () => {
      const region = trimString(env('AWS_REGION', 'NITRO_AWS_REGION')) || 'us-east-1';
      // Lazy import so HTTP/compute lanes (which need no key material) don't require the SDK.
      const mod = await import('@aws-sdk/client-secrets-manager');
      const clientConfig = { region };
      // In the Nitro enclave there is NO NIC: egress is HTTPS_PROXY -> vsock -> the
      // host allow-list proxy. The AWS SDK's default node:https transport ignores
      // HTTPS_PROXY, so Secrets Manager would be unreachable in-enclave (which is why
      // the X25519 key was historically unsealed on the HOST and injected). When a
      // proxy is configured, use the fetch-based handler — Node 22's global fetch
      // honors NODE_USE_ENV_PROXY/HTTPS_PROXY, so the call routes through the egress.
      // This lets the enclave read the key masters ITSELF (no host-side unseal).
      if (trimString(env('HTTPS_PROXY', 'https_proxy'))) {
        try {
          const { FetchHttpHandler } = await import('@smithy/fetch-http-handler');
          clientConfig.requestHandler = new FetchHttpHandler();
        } catch {
          // Fall back to the default node:https handler if the fetch handler is
          // unavailable (host-tier callers have a NIC and need no proxy anyway).
        }
      }
      const client = new mod.SecretsManagerClient(clientConfig);
      return {
        async getSecret(secretId) {
          const out = await client.send(new mod.GetSecretValueCommand({ SecretId: secretId }));
          return trimString(out.SecretString || '');
        },
      };
    })();
  }
  return secretsClientPromise;
}

async function fetchSecretBytes(secretId) {
  if (!secretCache.has(secretId)) {
    if (secretCache.size >= MAX_DERIVED_KEY_CACHE_SIZE) {
      secretCache.delete(secretCache.keys().next().value);
    }
    secretCache.set(
      secretId,
      (async () => {
        const provider = await getSecretsClient();
        const b64 = await provider.getSecret(secretId);
        if (!b64) throw new Error(`secret ${secretId} is empty or unavailable`);
        const buf = Buffer.from(b64, 'base64');
        if (buf.length < 16) throw new Error(`secret ${secretId} decoded too short`);
        return buf;
      })()
    );
  }
  return secretCache.get(secretId);
}

function selectMasterSecretId(path, purpose) {
  const probe = `${path || ''}:${purpose || ''}`.toLowerCase();
  if (probe.includes('neodid') || probe.includes('nullifier')) return neodidSaltSecretId();
  return x25519SecretId();
}

// Deterministic per-(path,purpose) 32-byte sub-key derived from a Secrets Manager master.
// Stable across calls (so seal/unseal and salt derivations round-trip), HKDF-style via sha256.
export async function deriveKeyBytes(path, purpose = '') {
  const keyPath = trimString(path);
  if (!keyPath) throw new Error('derived key path required');
  const cacheKey = `${keyPath}:${purpose}`;
  if (!derivedKeyCache.has(cacheKey)) {
    if (derivedKeyCache.size >= MAX_DERIVED_KEY_CACHE_SIZE) {
      derivedKeyCache.delete(derivedKeyCache.keys().next().value);
    }
    derivedKeyCache.set(
      cacheKey,
      (async () => {
        const master = await fetchSecretBytes(selectMasterSecretId(keyPath, purpose));
        const material = Buffer.concat([
          master,
          Buffer.from(`\x00${keyPath}\x00${purpose}`, 'utf8'),
        ]);
        return Buffer.from(sha256Hex(material), 'hex');
      })()
    );
  }
  return derivedKeyCache.get(cacheKey);
}

function normalizePrivateKeyHex(buffer, label) {
  let current = Buffer.from(buffer);
  for (let round = 0; round < 4; round += 1) {
    const hex = current.toString('hex');
    if (/^[0-9a-f]{64}$/i.test(hex) && !/^0+$/.test(hex)) return hex.toLowerCase();
    current = Buffer.from(sha256Hex(Buffer.concat([current, Buffer.from(label)])), 'hex');
  }
  throw new Error(`unable to derive usable private key for ${label}`);
}

export async function deriveNeoN3PrivateKeyHex(role = 'worker') {
  validateKeyRole(role);
  const keyPath =
    trimString(env(`NITRO_${role.toUpperCase()}_NEO_N3_KEY_PATH`)) ||
    `morpheus/neo-n3/${role}/signing/v1`;
  return normalizePrivateKeyHex(await deriveKeyBytes(keyPath, 'neo-n3-signing'), `neo-n3:${role}`);
}

export async function getNitroInfo({ required = false } = {}) {
  // The Nitro signer (8787) holds the Neo signing keys; surface a light runtime marker.
  const endpoint =
    trimString(env('NITRO_SIGNER_ENDPOINT', 'MORPHEUS_NITRO_SIGNER_ENDPOINT')) ||
    'http://127.0.0.1:8787';
  try {
    const res = await fetch(new URL('/health', endpoint).toString(), {
      method: 'GET',
      signal: AbortSignal.timeout(10_000),
    });
    const body = await res.json().catch(() => ({}));
    return {
      runtime: body.runtime || 'aws-nitro-signer',
      network: body.network || null,
      client_kind: 'nitro',
    };
  } catch {
    if (required) throw new Error('Nitro signer health endpoint is unavailable');
    return { runtime: 'aws-nitro-signer', network: null, client_kind: 'nitro' };
  }
}
export const getDstackInfo = getNitroInfo;

export async function getDerivedKeySummary(role = 'worker') {
  const [neoN3PrivateKey, info] = await Promise.all([
    deriveNeoN3PrivateKeyHex(role),
    getNitroInfo({ required: false }),
  ]);
  const neoN3Account = new neoWallet.Account(neoN3PrivateKey);
  return {
    role,
    client_kind: info?.client_kind || 'nitro',
    runtime: info?.runtime || 'aws-nitro-signer',
    neo_n3: {
      address: neoN3Account.address,
      public_key: neoN3Account.publicKey,
      script_hash: `0x${neoN3Account.scriptHash}`,
      key_path:
        trimString(env(`NITRO_${role.toUpperCase()}_NEO_N3_KEY_PATH`)) ||
        `morpheus/neo-n3/${role}/signing/v1`,
    },
  };
}

function normalizeReportData(input) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) return Buffer.from(input);
  if (typeof input === 'string') {
    const raw = trimString(input);
    if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
    return Buffer.from(sha256Hex(raw), 'hex');
  }
  return Buffer.from(sha256Hex(stableStringify(input)), 'hex');
}

// NSM attestation (optional). Routes to the enclave's attestation endpoint if present;
// returns null otherwise. Attestation is optional metadata, never required for fulfillment.
export async function buildNitroAttestation(reportInput, { required = false } = {}) {
  const endpoint =
    trimString(env('NITRO_ATTEST_ENDPOINT', 'NITRO_SIGNER_ENDPOINT')) || 'http://127.0.0.1:8787';
  const reportData = normalizeReportData(reportInput);
  try {
    const res = await fetch(new URL('/attest', endpoint).toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ report_data_hex: reportData.toString('hex') }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`attest status ${res.status}`);
    const body = await res.json();
    return {
      runtime: 'aws-nitro',
      attestation_document: body.attestation_document || body.document || null,
      report_data: `0x${reportData.toString('hex')}`,
    };
  } catch {
    if (required) throw new Error('Nitro attestation is unavailable');
    return null;
  }
}
export const buildDstackAttestation = buildNitroAttestation;

export async function maybeBuildNitroAttestation(payload, reportInput, keySource) {
  if (keySource === 'caller') return null;
  if (!shouldEmitAttestation(payload)) return null;
  try {
    return await buildNitroAttestation(reportInput, { required: false });
  } catch {
    return null;
  }
}
export const maybeBuildDstackAttestation = maybeBuildNitroAttestation;
