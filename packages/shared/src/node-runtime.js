/**
 * Node-only runtime helpers shared by the workers (nitro-worker and
 * morpheus-relayer). Kept out of utils.js so the Cloudflare Worker consumers
 * of `@r3e-network/neo-os-services-shared/utils` never pull in node:crypto or
 * process.env access.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import { stableStringify } from './utils.js';

let runtimeConfigCache;

function getRuntimeConfig() {
  if (runtimeConfigCache !== undefined) return runtimeConfigCache;
  const raw = String(process.env.MORPHEUS_RUNTIME_CONFIG_JSON || '').trim();
  if (!raw) {
    runtimeConfigCache = {};
    return runtimeConfigCache;
  }
  try {
    runtimeConfigCache = JSON.parse(raw);
  } catch {
    runtimeConfigCache = {};
  }
  return runtimeConfigCache;
}

/**
 * Resolve the first non-empty value among the given names, checking
 * process.env first and the cached MORPHEUS_RUNTIME_CONFIG_JSON document as a
 * fallback for each name in turn.
 */
export function env(...names) {
  const runtimeConfig = getRuntimeConfig();
  for (const name of names) {
    const value = String(process.env[name] || runtimeConfig[name] || '').trim();
    if (value) return value;
  }
  return '';
}

export function ensureBuffer(input) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) return Buffer.from(input);
  if (input instanceof ArrayBuffer) return Buffer.from(input);
  if (typeof input === 'string') return Buffer.from(input, 'utf8');
  return Buffer.from(stableStringify(input), 'utf8');
}

export function sha256Hex(input) {
  return createHash('sha256').update(ensureBuffer(input)).digest('hex');
}

/**
 * SECURITY (S4): canonical message for a manual relayer action (retry/replay).
 * The event is serialized deterministically (sorted keys, via stableStringify)
 * so the same object verifies identically after a jsonb round-trip through
 * Postgres.
 */
export function manualActionCanonical(action, network, eventKey, event) {
  return [
    'morpheus-manual-action-v1',
    String(action || ''),
    String(network || ''),
    String(eventKey || ''),
    stableStringify(event ?? null),
  ].join('\n');
}

/**
 * HMAC-SHA256 hex signature over `manualActionCanonical(...)`. Callers must
 * supply the shared MORPHEUS_MANUAL_ACTION_HMAC_SECRET.
 */
export function signManualAction(secret, action, network, eventKey, event) {
  return createHmac('sha256', String(secret))
    .update(manualActionCanonical(action, network, eventKey, event), 'utf8')
    .digest('hex');
}

/**
 * Constant-time verification of an HMAC signature over a manual action.
 * A non-hex or wrong-length signature fails closed.
 */
export function verifyManualActionSignature(secret, action, network, eventKey, event, signature) {
  const expected = signManualAction(secret, action, network, eventKey, event);
  const sig = String(signature || '');
  if (!/^[a-f0-9]{64}$/i.test(sig) || expected.length !== sig.length) return false;
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(sig, 'hex');
  return timingSafeEqual(a, b);
}
