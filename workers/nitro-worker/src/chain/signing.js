import {
  REPLAY_WINDOW_MS,
  env,
  resolvePayloadNetwork,
  sha256Hex,
  stableStringify,
  strip0x,
  trimString,
} from '../platform/core.js';
import { wallet as neoWallet } from '@cityofzion/neon-js';
import {
  deriveNeoN3PrivateKeyHex,
  maybeBuildDstackAttestation,
  shouldUseDerivedKeys,
} from '../platform/nitro-signer.js';
import {
  normalizeMorpheusNetwork,
  reportPinnedNeoN3Role,
} from '../../../../scripts/lib-neo-signers.mjs';

// The pinned worker / oracle_verifier signer is resolved from process env via
// reportPinnedNeoN3Role, which scans NEO_N3_SIGNER_ENV_KEYS and derives up to six
// secp256r1 accounts to find the role match. Env is immutable for the process
// lifetime, so memoize the resolved key per (role, network) to skip that scan on
// every signed response, and cache the derived neon-js Account per key so its
// secp256r1 public-key derivation is paid once. Both are cleared between tests
// (which vary the signer env per case) via __resetSigningCachesForTests.
const envRoleKeyCache = new Map();
const signingAccountCache = new Map();
const MAX_SIGNING_ACCOUNT_CACHE = 32;

function resolveEnvRoleKey(role, network) {
  const cacheKey = `${role}:${network}`;
  if (envRoleKeyCache.has(cacheKey)) return envRoleKeyCache.get(cacheKey);
  const report = reportPinnedNeoN3Role(network, role, { env, allowMissing: true });
  if (report.issues.length > 0) {
    throw new Error(report.issues.join('; '));
  }
  const key = report.materialized?.private_key || report.materialized?.wif || '';
  envRoleKeyCache.set(cacheKey, key);
  return key;
}

function signingAccountFor(privateKey) {
  const key = trimString(privateKey);
  if (!key) return null;
  const cached = signingAccountCache.get(key);
  if (cached) return cached;
  const account = new neoWallet.Account(key);
  // Bound memory: caller-supplied keys (maybeSignNeoN3Bytes lane) would otherwise
  // grow this unbounded; the hot worker/verifier lane reuses a tiny fixed key set,
  // so a small LRU-style cap keeps the common path cached without leaking.
  if (signingAccountCache.size >= MAX_SIGNING_ACCOUNT_CACHE) {
    const oldest = signingAccountCache.keys().next().value;
    if (oldest !== undefined) signingAccountCache.delete(oldest);
  }
  signingAccountCache.set(key, account);
  return account;
}

export function __resetSigningCachesForTests() {
  envRoleKeyCache.clear();
  signingAccountCache.clear();
}

function hasCallerSuppliedKeyMaterial(payload = {}) {
  return Boolean(
    trimString(payload.private_key) || trimString(payload.signing_key) || trimString(payload.wif)
  );
}

// The enclave-resident signing lanes (sign/payload + signed-result envelopes)
// must sign with the worker's own key, never with raw key material a caller put
// in the request body. Accepting caller-supplied keys here is a key-confusion
// hazard (a caller could substitute an arbitrary key for the enclave's, or probe
// the signing path with attacker-controlled material). Reject by default; an
// operator can deliberately re-open the legacy behavior with
// MORPHEUS_ALLOW_CALLER_SIGNING_KEY=true.
function allowCallerSuppliedSigningKey() {
  const raw = trimString(env('MORPHEUS_ALLOW_CALLER_SIGNING_KEY')).toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function rejectCallerSuppliedSigningKey(payload = {}) {
  if (hasCallerSuppliedKeyMaterial(payload) && !allowCallerSuppliedSigningKey()) {
    throw new Error(
      'caller-supplied signing key material (private_key/signing_key/wif) is not accepted ' +
        'on this signing lane; the enclave-resident key is used instead'
    );
  }
}

function resolveKeySource(payload = {}) {
  if (hasCallerSuppliedKeyMaterial(payload)) {
    return 'caller';
  }
  return 'worker';
}

function resolveOracleVerifierRole(payload = {}) {
  const explicit = trimString(payload.dstack_key_role || payload.key_role || '');
  return explicit.toLowerCase() === 'oracle_verifier';
}

function resolveRequestedNeoN3DerivedRole(payload = {}) {
  const explicit = trimString(payload.dstack_key_role || payload.key_role || '');
  return explicit || 'worker';
}

function resolveNeoN3OracleVerifierKey(payload = {}) {
  const network = resolvePayloadNetwork(
    payload,
    normalizeMorpheusNetwork(env('MORPHEUS_NETWORK', 'NEXT_PUBLIC_MORPHEUS_NETWORK') || 'testnet')
  );
  return resolveEnvRoleKey('oracle_verifier', network);
}

function resolveNeoN3WorkerKey(payload = {}) {
  const network = resolvePayloadNetwork(
    payload,
    normalizeMorpheusNetwork(env('MORPHEUS_NETWORK', 'NEXT_PUBLIC_MORPHEUS_NETWORK') || 'testnet')
  );
  return resolveEnvRoleKey('worker', network);
}

const seenRequestIds = new Map();
const MAX_SEEN_REQUEST_IDS = 50_000;

export function pruneSeenRequestIds() {
  const cutoff = Date.now() - REPLAY_WINDOW_MS;
  for (const [requestId, createdAt] of seenRequestIds.entries()) {
    if (createdAt < cutoff) seenRequestIds.delete(requestId);
  }
}

export function rememberRequestId(requestId) {
  pruneSeenRequestIds();
  if (seenRequestIds.size >= MAX_SEEN_REQUEST_IDS) {
    const entries = [...seenRequestIds.entries()].sort((a, b) => a[1] - b[1]);
    const toDelete = Math.ceil(entries.length * 0.25);
    for (let i = 0; i < toDelete; i++) seenRequestIds.delete(entries[i][0]);
  }
  if (seenRequestIds.has(requestId)) return false;
  seenRequestIds.set(requestId, Date.now());
  return true;
}

export function forgetRequestId(requestId) {
  if (requestId) seenRequestIds.delete(requestId);
}

export function resolveSigningBytes(payload) {
  if (trimString(payload.data_hex)) {
    return { bytes: Buffer.from(strip0x(payload.data_hex), 'hex'), source: 'data_hex' };
  }
  if (trimString(payload.data_base64)) {
    return { bytes: Buffer.from(payload.data_base64, 'base64'), source: 'data_base64' };
  }
  if (typeof payload.message === 'string') {
    return { bytes: Buffer.from(payload.message, 'utf8'), source: 'message' };
  }
  if (typeof payload.data === 'string') {
    return { bytes: Buffer.from(payload.data, 'utf8'), source: 'data:string' };
  }
  if (payload.data !== undefined) {
    return { bytes: Buffer.from(stableStringify(payload.data), 'utf8'), source: 'data:json' };
  }
  throw new Error('one of data, message, data_hex, or data_base64 is required');
}

export async function maybeSignNeoN3Bytes(bytes, payload = {}) {
  rejectCallerSuppliedSigningKey(payload);
  const keySource = resolveKeySource(payload);
  const useOracleVerifierRole = resolveOracleVerifierRole(payload);
  const requestScopedKey =
    trimString(payload.private_key) || trimString(payload.signing_key) || trimString(payload.wif);
  const configuredOracleVerifierKey = useOracleVerifierRole
    ? resolveNeoN3OracleVerifierKey(payload)
    : '';
  let privateKey =
    requestScopedKey || configuredOracleVerifierKey || resolveNeoN3WorkerKey(payload);

  const allowDerivedOverride =
    !requestScopedKey && (!useOracleVerifierRole || !configuredOracleVerifierKey);
  if (shouldUseDerivedKeys(payload) && allowDerivedOverride) {
    const requestedRole = resolveRequestedNeoN3DerivedRole(payload);
    try {
      privateKey = await deriveNeoN3PrivateKeyHex(requestedRole);
    } catch {
      // If the dedicated oracle_verifier path is absent, reuse the worker role.
      if (useOracleVerifierRole && requestedRole !== 'worker') {
        try {
          privateKey = await deriveNeoN3PrivateKeyHex('worker');
        } catch {
          // fall back to explicit/env key material if available
        }
      }
    }
  }
  if (!privateKey) return null;

  const account = signingAccountFor(privateKey);
  const payloadBuffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return {
    signature: neoWallet.sign(payloadBuffer.toString('hex'), account.privateKey),
    public_key: account.publicKey,
    address: account.address,
    script_hash: `0x${account.scriptHash}`,
    key_source: keySource,
  };
}

async function maybeSignWorkerNeoN3Bytes(bytes, payload = {}) {
  let privateKey = resolveNeoN3WorkerKey(payload);
  if (shouldUseDerivedKeys(payload)) {
    try {
      privateKey = await deriveNeoN3PrivateKeyHex(
        trimString(payload.dstack_key_role || payload.key_role || 'worker') || 'worker'
      );
    } catch {
      // fall back to configured worker key material if available
    }
  }
  if (!privateKey) return null;

  const account = signingAccountFor(privateKey);
  const payloadBuffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return {
    signature: neoWallet.sign(payloadBuffer.toString('hex'), account.privateKey),
    public_key: account.publicKey,
    address: account.address,
    script_hash: `0x${account.scriptHash}`,
  };
}

export async function buildSignedResultEnvelope(result, payload = {}) {
  // This lane always signs with the enclave-resident worker key
  // (maybeSignWorkerNeoN3Bytes ignores any caller-supplied key). Reject
  // caller-supplied key material so the request can't masquerade as a
  // caller-keyed signature or attempt key confusion.
  rejectCallerSuppliedSigningKey(payload);
  const keySource = hasCallerSuppliedKeyMaterial(payload) ? 'caller' : 'worker';
  const payloadBytes = Buffer.from(stableStringify(result), 'utf8');
  const outputHash = sha256Hex(payloadBytes);
  const signature = await maybeSignWorkerNeoN3Bytes(payloadBytes, payload);
  const teeAttestation = await maybeBuildDstackAttestation(payload, outputHash, keySource);
  return {
    output_hash: outputHash,
    attestation_hash: outputHash,
    signature: signature?.signature || null,
    public_key: signature?.public_key || null,
    signer_address: signature?.address || null,
    signer_script_hash: signature?.script_hash || null,
    key_source: keySource,
    tee_attestation: teeAttestation,
  };
}

export function buildVerificationEnvelope(signed) {
  return {
    output_hash: signed.output_hash,
    attestation_hash: signed.attestation_hash,
    signature: signed.signature,
    public_key: signed.public_key,
    signer_address: signed.signer_address || null,
    signer_script_hash: signed.signer_script_hash || null,
    tee_attestation: signed.tee_attestation ?? null,
  };
}

// D5 — canonical signed-result envelope fields shared by every fulfillment lane
// (oracle.query / smart-fetch / compute / vrf / neodid / feeds). Returns the
// SAME keys each lane already emits so the on-chain verification surface is
// uniform: output_hash + signature + public_key + attestation_hash +
// verification (+ tee_attestation). Additive — callers spread their lane-specific
// fields alongside this; existing keys are preserved.
export function buildLaneSignedEnvelope(signed) {
  return {
    output_hash: signed.output_hash,
    signature: signed.signature || null,
    public_key: signed.public_key || null,
    attestation_hash: signed.attestation_hash,
    tee_attestation: signed.tee_attestation ?? null,
    verification: buildVerificationEnvelope(signed),
  };
}
