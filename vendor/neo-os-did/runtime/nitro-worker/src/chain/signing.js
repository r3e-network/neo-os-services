// Worker Neo N3 signing lanes (docs/SIGNER_SERVICE.md §5). The worker holds no
// key material: signatures come from the custody signer service, which signs the
// exact submitted bytes inside the attested boundary under the role's allow_raw
// key. Caller-supplied key material is rejected unconditionally; there is no
// local-signing path or environment escape hatch.
import {
  REPLAY_WINDOW_MS,
  env,
  normalizeMorpheusNetwork,
  sha256Hex,
  stableStringify,
  strip0x,
  trimString,
} from '../platform/core.js';
import { custodyKeyId, custodyKeyInfo, custodySignRaw } from '../platform/custody.js';
import { maybeBuildDstackAttestation } from '../platform/nitro-signer.js';

function hasCallerSuppliedKeyMaterial(payload = {}) {
  return Boolean(
    trimString(payload.private_key) || trimString(payload.signing_key) || trimString(payload.wif)
  );
}

// The enclave-resident signing lanes (sign/payload + signed-result envelopes)
// must sign with the custody key, never with raw key material a caller put in
// the request body. Accepting caller-supplied keys here is a key-confusion
// hazard (a caller could substitute an arbitrary key for the enclave's, or probe
// the signing path with attacker-controlled material). This boundary is
// unconditional and cannot be weakened by runtime configuration.
export function rejectCallerSuppliedSigningKey(payload = {}) {
  if (hasCallerSuppliedKeyMaterial(payload)) {
    throw new Error(
      'caller-supplied signing key material (private_key/signing_key/wif) is not accepted ' +
        'on this signing lane; the custody signer service key is used instead'
    );
  }
}

const seenRequestIds = new Map();
const MAX_SEEN_REQUEST_IDS = 50_000;

export function __resetSigningCachesForTests() {
  seenRequestIds.clear();
}

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

// Role for the custody lane: an explicit dstack_key_role/key_role selects the
// provisioned key (oracle_verifier, updater, ...); default is the worker key.
// Constrained exactly like the derived-key path it replaces.
function resolveCustodyRole(payload = {}) {
  const role = trimString(payload.dstack_key_role || payload.key_role || '') || 'worker';
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(role)) {
    throw new Error('invalid key role: must be 1-64 alphanumeric/dash/underscore chars');
  }
  return role;
}

// Custody lane: the enclave signs the exact bytes under the role's allow_raw key
// boundary and returns the signature together with the key's public identity.
// Nothing is cached across calls, so a rotated key can never keep signing under
// a stale identity, and there is no local or derived-key fallback: provisioning
// SIGNER_ROLE_{ROLE}_KEY_ID is required.
export async function custodySignBytes(role, bytes) {
  const keyId = custodyKeyId(role);
  const key = await custodyKeyInfo(keyId);
  const network = normalizeMorpheusNetwork(env('MORPHEUS_NETWORK'), 'testnet');
  const expectedMagic = network === 'mainnet' ? 860833102 : 894710606;
  const ready =
    key &&
    key.signing_enabled === true &&
    trimString(key.network) === network &&
    Number(key.network_magic) === expectedMagic &&
    trimString(key.public_key) &&
    trimString(key.address) &&
    trimString(key.script_hash);
  if (!ready) {
    const error = new Error(
      `custody key for role ${role} is missing, disabled, incomplete, or bound to the wrong network`
    );
    error.status = 503;
    throw error;
  }
  const payloadBuffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const signed = await custodySignRaw(keyId, payloadBuffer.toString('hex'));
  const signature = trimString(signed.signature || '');
  const publicKey = trimString(signed.public_key || '');
  if (!signature || !publicKey) {
    const error = new Error('custody signer returned an incomplete signature envelope');
    error.status = 503;
    throw error;
  }
  if (
    publicKey !== trimString(key.public_key) ||
    trimString(signed.address) !== trimString(key.address) ||
    trimString(signed.script_hash) !== trimString(key.script_hash)
  ) {
    const error = new Error('custody signer response contradicts the pinned key identity');
    error.status = 503;
    throw error;
  }
  return {
    signature,
    public_key: publicKey,
    address: trimString(signed.address || ''),
    script_hash: trimString(signed.script_hash || ''),
    key_source: 'custody',
  };
}

export async function maybeSignNeoN3Bytes(bytes, payload = {}) {
  rejectCallerSuppliedSigningKey(payload);
  return custodySignBytes(resolveCustodyRole(payload), bytes);
}

async function maybeSignWorkerNeoN3Bytes(bytes) {
  return custodySignBytes('worker', bytes);
}

export async function buildSignedResultEnvelope(result, payload = {}) {
  // This lane always signs with the custody worker key (maybeSignWorkerNeoN3Bytes
  // never touches caller material). Reject caller-supplied key material so the
  // request can't masquerade as a caller-keyed signature or attempt key confusion.
  rejectCallerSuppliedSigningKey(payload);
  const keySource = 'custody';
  const payloadBytes = Buffer.from(stableStringify(result), 'utf8');
  const outputHash = sha256Hex(payloadBytes);
  const signature = await maybeSignWorkerNeoN3Bytes(payloadBytes);
  const teeAttestation = await maybeBuildDstackAttestation(payload, outputHash, keySource);
  return {
    output_hash: outputHash,
    attestation_hash: outputHash,
    signature: signature.signature,
    public_key: signature.public_key,
    signer_address: signature.address,
    signer_script_hash: signature.script_hash,
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
  if (!trimString(signed?.signature) || !trimString(signed?.public_key)) {
    const error = new Error('signed result envelope requires custody signature and public key');
    error.status = 503;
    throw error;
  }
  return {
    output_hash: signed.output_hash,
    signature: signed.signature,
    public_key: signed.public_key,
    attestation_hash: signed.attestation_hash,
    tee_attestation: signed.tee_attestation ?? null,
    verification: buildVerificationEnvelope(signed),
  };
}
