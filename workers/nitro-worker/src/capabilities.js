import { ethers } from 'ethers';
import { getWorkflowDefinition } from '@r3e-network/neo-os-services-shared';
import { env, json, jsonError, sanitizeErrorMessage, trimString } from './platform/core.js';
import { getDerivedKeySummary } from './platform/nitro-signer.js';
import {
  ensureOracleKeyMaterial,
  buildOracleResponse,
  handleOracleFeedRequest,
  handleFeedsPrice,
  listFeedSymbols,
  handleVrf,
  decryptEncryptedToken,
  handleMessageReveal,
  UpstreamFetchError,
  readMessageFromChain,
  resolveNeoxMessageChainContext,
  parseMessageId,
  NEOX_DECRYPT_CHAIN_ALIASES,
} from './oracle/index.js';
import {
  handleComputeExecute,
  handleComputeFunctions,
  handleComputeJobs,
} from './compute/index.js';
import { handleSignPayload, handleRelayTransaction, handleTxProxyInvoke } from './chain/index.js';
import {
  handleNeoDidProviders,
  handleNeoDidRuntime,
  handleNeoDidBind,
  handleNeoDidActionTicket,
  handleNeoDidRecoveryTicket,
  handleNeoDidZkLoginTicket,
} from './neodid/index.js';
import { handlePaymasterAuthorize } from './paymaster/index.js';
import { handleProvidersList, getProviderHealth } from './oracle/providers.js';
import { handleSessionStart, handleSessionStep, handleSessionFinalize } from './game/session.js';

// ---------------------------------------------------------------------------
// Thin wrapper handlers for inline logic previously in worker.js
// ---------------------------------------------------------------------------

async function handleKeysDerived({ payload }) {
  const role =
    typeof payload.role === 'string' && payload.role.trim() ? payload.role.trim() : 'worker';
  return json(200, { derived: await getDerivedKeySummary(role) });
}

async function handleOraclePublicKey({ payload }) {
  const keyMaterial = await ensureOracleKeyMaterial(payload);
  return json(200, {
    algorithm: keyMaterial.algorithm,
    public_key: keyMaterial.publicKeyRaw,
    public_key_format: keyMaterial.key_format,
    key_source: keyMaterial.source,
    recommended_payload_encryption: keyMaterial.algorithm,
    supported_payload_encryption: [keyMaterial.algorithm],
  });
}

// Decrypt an X25519-HKDF-SHA256-AES-256-GCM envelope (sealed to the oracle key)
// inside the enclave and return the plaintext. Token-protected — only trusted
// callers (the relayer's time-locked reveal lane, or an auth proxy that has
// already verified the recipient) reach this; it is never a public decryption
// oracle. Used by Neo Message (recipient reveal + time-locked reveal).
//
// E5 — per-request gating. Defended by the shared worker token alone, a token
// leak would let an attacker decrypt ANY captured ciphertext, defeating the
// time-lock. When binding fields (chain + messageId) are supplied, the worker
// re-derives the trust DECISION inside the enclave like message-reveal: it reads
// the message from a TRUSTED worker-configured contract (never the caller's), and
// will only decrypt when the supplied envelope IS the on-chain stored envelope
// for that messageId AND its time-lock has actually expired. The binding path is
// opt-in for backward compatibility (the relayer currently posts only {envelope}
// after the kernel/contract already gated unlock); operators can require it via
// MORPHEUS_ORACLE_DECRYPT_REQUIRE_BINDING controls the gate. C3 — now that the
// relayer's confidential.decrypt lane sends the (chain, message_id, contract)
// binding, this DEFAULTS TO TRUE (require binding): a bare ciphertext with no
// binding fields is rejected so a worker-token leak cannot decrypt arbitrary
// captured ciphertext. An operator can explicitly opt OUT (set the flag to
// 0/false/no/off) for a transition window where a caller cannot yet send binding;
// when fields ARE present the gate always verifies regardless of the flag.
// SECURITY (S21): in production the opt-out is IGNORED (fail closed) — turning
// off binding would turn the worker into a free decryption oracle.
function decryptBindingRequired() {
  if (trimString(env('NODE_ENV')).toLowerCase() === 'production') return true;
  const raw = trimString(env('MORPHEUS_ORACLE_DECRYPT_REQUIRE_BINDING')).toLowerCase();
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') return false;
  // Default (unset) and any truthy value require binding.
  return true;
}

function extractDecryptCiphertext(payload) {
  return (
    (typeof payload.envelope === 'string' && payload.envelope.trim()) ||
    (typeof payload.ciphertext === 'string' && payload.ciphertext.trim()) ||
    (typeof payload.sealed === 'string' && payload.sealed.trim()) ||
    (typeof payload.encrypted_payload === 'string' && payload.encrypted_payload.trim()) ||
    ''
  );
}

function hasDecryptBindingFields(payload) {
  return (
    payload.messageId !== undefined || payload.message_id !== undefined || payload.id !== undefined
  );
}

// Enforce the (chain, contract, messageId) binding + unlockTime re-assertion.
// Returns null when the request passes the gate, or a Response describing the
// rejection. `readMessage` is injectable for tests.
async function assertDecryptBinding(
  payload,
  ciphertext,
  { readMessage = readMessageFromChain } = {}
) {
  const chain = trimString(payload.chain || payload.network || 'neox').toLowerCase();
  if (!NEOX_DECRYPT_CHAIN_ALIASES.has(chain)) {
    return json(400, { error: 'gated decrypt currently supports the neox chain only' });
  }

  const messageId = parseMessageId(payload.messageId ?? payload.message_id ?? payload.id);
  if (messageId === null) return json(400, { error: 'valid messageId required for gated decrypt' });

  const { rpcUrl, contract, chainId } = resolveNeoxMessageChainContext();
  if (!rpcUrl || !contract) {
    return json(503, { error: 'gated decrypt is not configured on this worker' });
  }
  // If the caller names a contract it MUST match the trusted worker contract;
  // the read itself always uses the worker-configured address.
  const requestedContract = trimString(payload.contract || payload.contract_address || '');
  if (requestedContract && requestedContract.toLowerCase() !== contract.toLowerCase()) {
    return json(403, { error: 'contract does not match the worker-configured message contract' });
  }

  let message;
  try {
    message = await readMessage({ rpcUrl, chainId, contract, messageId });
  } catch (error) {
    return json(502, { error: `failed to read message on-chain: ${sanitizeErrorMessage(error)}` });
  }

  // Bind the ciphertext to the on-chain stored envelope for this messageId so a
  // captured/foreign ciphertext cannot be decrypted via a valid messageId.
  let storedEnvelope;
  try {
    storedEnvelope = ethers.toUtf8String(message.envelope);
  } catch {
    return json(400, { error: 'stored envelope is not decodable' });
  }
  if (trimString(storedEnvelope) !== trimString(ciphertext)) {
    return json(403, { error: 'envelope does not match the on-chain message for this messageId' });
  }

  // Re-assert the time-lock inside the enclave: this lane is for time-locked
  // messages whose unlock has passed (recipient-only messages use message-reveal).
  const unlockTime = Number(message.unlockTime || 0);
  if (unlockTime <= 0) {
    return json(403, { error: 'message is not time-locked; use the recipient reveal lane' });
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (nowSeconds < unlockTime) {
    return json(403, { error: 'message time-lock has not expired yet' });
  }

  return null;
}

async function handleOracleDecrypt({ payload }, deps = {}) {
  const ciphertext = extractDecryptCiphertext(payload);
  if (!ciphertext) {
    return json(400, { error: 'sealed envelope required (field: envelope)' });
  }

  if (hasDecryptBindingFields(payload)) {
    const rejection = await assertDecryptBinding(payload, ciphertext, deps);
    if (rejection) return rejection;
  } else if (decryptBindingRequired()) {
    return json(400, {
      error: 'gated decrypt requires (chain, contract, messageId) binding fields',
    });
  }

  try {
    const plaintext = await decryptEncryptedToken(ciphertext, payload);
    if (plaintext == null) return json(400, { error: 'decryption returned empty result' });
    return json(200, { plaintext });
  } catch (error) {
    return jsonError(400, error);
  }
}

// Test hook: drive the gated decrypt lane with an injected on-chain reader.
export function __handleOracleDecryptForTests(args, deps = {}) {
  return handleOracleDecrypt(args, deps);
}

function handleFeedsCatalog() {
  return json(200, { pairs: listFeedSymbols() });
}

function handleFeedsPriceByPath({ path, url }) {
  return handleFeedsPrice(
    decodeURIComponent(path.split('/').pop() || 'NEO-USD'),
    Object.fromEntries(url.searchParams.entries())
  );
}

async function handleFeedsPriceByQuery({ url, payload }) {
  return handleFeedsPrice(url.searchParams.get('symbol') || payload.symbol || 'NEO-USD', {
    ...Object.fromEntries(url.searchParams.entries()),
    ...payload,
  });
}

function handleComputeJobsById({ path }) {
  return handleComputeJobs(path.split('/').pop() || null);
}

// D4 — an upstream data-source failure (the *provider* is down/slow, not a bad
// request) must surface as a gateway error (502/504) with a machine-readable
// `kind`, so the relayer treats it as retryable rather than a permanent 400.
// All other errors keep their existing 400 semantics via the worker catch.
function buildUpstreamErrorResponse(error) {
  return json(error.httpStatus || 502, {
    error: sanitizeErrorMessage(error),
    error_code: error.kind || 'upstream_error',
    kind: error.kind || 'upstream_error',
    ...(error.upstreamStatus != null ? { upstream_status: error.upstreamStatus } : {}),
  });
}

async function handleOracleQuery({ payload }) {
  try {
    return json(200, await buildOracleResponse(payload, 'query'));
  } catch (error) {
    if (error instanceof UpstreamFetchError) return buildUpstreamErrorResponse(error);
    throw error;
  }
}

async function handleOracleSmartFetch({ payload }) {
  try {
    return json(200, await buildOracleResponse(payload, 'smart-fetch'));
  } catch (error) {
    if (error instanceof UpstreamFetchError) return buildUpstreamErrorResponse(error);
    throw error;
  }
}

async function handleOracleHeartbeat() {
  const providers = getProviderHealth();
  return json(200, {
    status: 'ok',
    providers,
    timestamp: Math.floor(Date.now() / 1000),
  });
}

// ---------------------------------------------------------------------------
// Capability registry
//
// Each capability: { id, paths, actions?, featurePath, handler }
//   paths: [{ match } | { pattern }] — match is path.endsWith(), pattern is RegExp.test()
//   actions: payload.action values that also trigger this capability
//   featurePath: human-readable path for the health/features endpoint
//   handler: async ({ path, url, payload, request }) => Response
//
// Order matters: more specific patterns (regex) MUST precede general exact
// matches within the same domain so the resolver picks the right one.
// ---------------------------------------------------------------------------

const CAPABILITIES = [
  {
    id: 'keys_derived',
    paths: [{ match: '/keys/derived' }],
    featurePath: 'keys/derived',
    handler: handleKeysDerived,
  },
  {
    id: 'neodid_providers',
    paths: [{ match: '/neodid/providers' }],
    featurePath: 'neodid/providers',
    handler: () => handleNeoDidProviders(),
  },
  {
    id: 'neodid_runtime',
    paths: [{ match: '/neodid/runtime' }],
    featurePath: 'neodid/runtime',
    handler: async ({ payload }) => handleNeoDidRuntime(payload),
  },
  {
    id: 'neodid_bind',
    workflow: getWorkflowDefinition('neodid.bind'),
    paths: [{ match: '/neodid/bind' }],
    featurePath: 'neodid/bind',
    handler: async ({ payload }) => handleNeoDidBind(payload),
  },
  {
    id: 'neodid_action_ticket',
    workflow: getWorkflowDefinition('neodid.action_ticket'),
    paths: [{ match: '/neodid/action-ticket' }],
    featurePath: 'neodid/action-ticket',
    handler: async ({ payload }) => handleNeoDidActionTicket(payload),
  },
  {
    id: 'neodid_recovery_ticket',
    workflow: getWorkflowDefinition('neodid.recovery_ticket'),
    paths: [{ match: '/neodid/recovery-ticket' }],
    featurePath: 'neodid/recovery-ticket',
    handler: async ({ payload }) => handleNeoDidRecoveryTicket(payload),
  },
  {
    id: 'neodid_zklogin_ticket',
    paths: [{ match: '/neodid/zklogin-ticket' }],
    featurePath: 'neodid/zklogin-ticket',
    handler: async ({ payload }) => handleNeoDidZkLoginTicket(payload),
  },
  {
    id: 'providers',
    paths: [{ match: '/providers' }],
    featurePath: 'providers',
    handler: async () => handleProvidersList(),
  },
  {
    id: 'oracle_public_key',
    paths: [{ match: '/oracle/public-key' }],
    featurePath: 'oracle/public-key',
    handler: handleOraclePublicKey,
  },
  {
    id: 'oracle_decrypt',
    paths: [{ match: '/oracle/decrypt' }],
    actions: ['decrypt'],
    featurePath: 'oracle/decrypt',
    handler: handleOracleDecrypt,
  },
  {
    id: 'oracle_message_reveal',
    paths: [{ match: '/oracle/message-reveal' }],
    actions: ['message_reveal'],
    featurePath: 'oracle/message-reveal',
    handler: async ({ payload }) => handleMessageReveal(payload),
  },
  {
    id: 'oracle_heartbeat',
    paths: [{ match: '/oracle/heartbeat' }],
    featurePath: 'oracle/heartbeat',
    handler: () => handleOracleHeartbeat(),
  },
  {
    id: 'oracle_query',
    workflow: getWorkflowDefinition('oracle.query'),
    paths: [{ match: '/oracle/query' }],
    featurePath: 'oracle/query',
    handler: handleOracleQuery,
  },
  {
    id: 'oracle_smart_fetch',
    workflow: getWorkflowDefinition('oracle.smart_fetch'),
    paths: [{ match: '/oracle/smart-fetch' }],
    featurePath: 'oracle/smart-fetch',
    handler: handleOracleSmartFetch,
  },
  {
    id: 'feeds_catalog',
    paths: [{ match: '/feeds/catalog' }],
    featurePath: 'feeds/catalog',
    handler: handleFeedsCatalog,
  },
  {
    id: 'feeds_price_symbol',
    paths: [{ pattern: /\/feeds\/price\/.+/ }],
    featurePath: 'feeds/price/:symbol',
    handler: handleFeedsPriceByPath,
  },
  {
    id: 'feeds_price',
    paths: [{ match: '/feeds/price' }],
    featurePath: 'feeds/price',
    handler: handleFeedsPriceByQuery,
  },
  {
    id: 'vrf_random',
    paths: [{ match: '/vrf/random' }],
    featurePath: 'vrf/random',
    handler: async ({ payload }) => handleVrf(payload),
  },
  {
    id: 'oracle_feed',
    workflow: getWorkflowDefinition('feed.sync'),
    paths: [{ match: '/oracle/feed' }],
    actions: ['oracle_feed'],
    featurePath: 'oracle/feed',
    handler: async ({ payload }) => handleOracleFeedRequest(payload),
  },
  {
    id: 'txproxy_invoke',
    paths: [{ match: '/txproxy/invoke' }],
    featurePath: 'txproxy/invoke',
    handler: async ({ payload }) => handleTxProxyInvoke(payload),
  },
  {
    id: 'sign_payload',
    paths: [{ match: '/sign/payload' }],
    actions: ['sign_payload'],
    featurePath: 'sign/payload',
    handler: async ({ payload }) => handleSignPayload(payload),
  },
  {
    id: 'relay_transaction',
    paths: [{ match: '/relay/transaction' }],
    actions: ['relay_transaction'],
    featurePath: 'relay/transaction',
    handler: async ({ payload }) => handleRelayTransaction(payload),
  },
  {
    id: 'paymaster_authorize',
    workflow: getWorkflowDefinition('paymaster.authorize'),
    paths: [{ match: '/paymaster/authorize' }],
    featurePath: 'paymaster/authorize',
    handler: async ({ payload }) => handlePaymasterAuthorize(payload),
  },
  {
    id: 'session_start',
    paths: [{ match: '/session/start' }],
    featurePath: 'session/start',
    handler: async ({ payload }) => handleSessionStart(payload),
  },
  {
    id: 'session_step',
    paths: [{ match: '/session/step' }],
    featurePath: 'session/step',
    handler: async ({ payload }) => handleSessionStep(payload),
  },
  {
    id: 'session_finalize',
    paths: [{ match: '/session/finalize' }],
    featurePath: 'session/finalize',
    handler: async ({ payload }) => handleSessionFinalize(payload),
  },
  {
    id: 'compute_functions',
    paths: [{ match: '/compute/functions' }],
    featurePath: 'compute/functions',
    handler: () => handleComputeFunctions(),
  },
  {
    id: 'compute_execute',
    workflow: getWorkflowDefinition('compute.execute'),
    paths: [{ match: '/compute/execute' }],
    featurePath: 'compute/execute',
    handler: async ({ payload }) => handleComputeExecute(payload),
  },
  {
    id: 'compute_jobs_id',
    paths: [{ pattern: /\/compute\/jobs\/.+/ }],
    featurePath: 'compute/jobs/:id',
    handler: handleComputeJobsById,
  },
  {
    id: 'compute_jobs',
    paths: [{ match: '/compute/jobs' }],
    featurePath: 'compute/jobs',
    handler: () => handleComputeJobs(),
  },
];

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

/**
 * SECURITY (S19): path matching for a capability route. A bare `endsWith`
 * would let an arbitrary prefix (`/foo/compute/execute`) hit a sensitive
 * capability, and `/evil/health` would hit the unauthenticated health branch.
 * Only an exact path or a known network prefix (`/mainnet/...`,
 * `/testnet/...`) is accepted.
 */
export function isRoutablePath(path, route) {
  if (route.pattern && route.pattern.test(path)) return true;
  if (!route.match) return false;
  if (path === route.match) return true;
  const segments = String(path || '')
    .split('/')
    .filter(Boolean);
  const first = (segments[0] || '').toLowerCase();
  if (first === 'mainnet' || first === 'testnet') {
    return `/${segments.slice(1).join('/')}` === route.match;
  }
  return false;
}

/**
 * Resolve a capability by path first, then by payload.action fallback.
 * Returns { capability, matchedBy } or null.
 */
export function resolveCapability(path, payload = {}) {
  // Phase 1: path-based matching (first match wins)
  for (const cap of CAPABILITIES) {
    for (const route of cap.paths) {
      if (isRoutablePath(path, route)) {
        return { capability: cap, matchedBy: 'path' };
      }
    }
  }

  // Phase 2: action-based fallback — only for capabilities that explicitly
  // declare actions; sensitive signing / relay capabilities are path-only
  // (their actions list is empty), so an arbitrary `payload.action` cannot
  // reach them.
  const action = payload.action;
  if (action) {
    for (const cap of CAPABILITIES) {
      if (cap.actions && cap.actions.includes(action)) {
        return { capability: cap, matchedBy: 'action' };
      }
    }
  }

  return null;
}

/**
 * Resolve a route name for rate-limiting / overload-guard purposes.
 * Returns the capability id string or '' if not found.
 */
export function resolveRouteName(path, payload = {}) {
  const result = resolveCapability(path, payload);
  return result ? result.capability.id : '';
}

/**
 * Return the list of feature paths for the /health endpoint.
 */
export function listCapabilityFeatures() {
  return CAPABILITIES.map((cap) => cap.featurePath);
}
