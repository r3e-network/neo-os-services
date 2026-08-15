import { json, normalizeBoolean, parseDurationMs, sha256Hex, trimString } from './core.js';
import {
  claimIdempotencyLock,
  incrementFixedWindowCounter,
  isUpstashEnabled,
  releaseIdempotencyLock,
  upstashGetJson,
  upstashSetJson,
} from './upstash.js';
import { resolveRouteName } from '../capabilities.js';
import { evaluatePolicyDecision } from './policy-engine.js';

function firstTruthy(...values) {
  for (const value of values) {
    const trimmed = trimString(value);
    if (trimmed) return trimmed;
  }
  return '';
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function resolveRequestPolicyDecision(payload = {}) {
  const explicit = isPlainObject(payload.policy_decision) ? payload.policy_decision : {};
  const hasPolicySignals =
    Object.keys(explicit).length > 0 ||
    payload.provider_enabled !== undefined ||
    payload.providerEnabled !== undefined ||
    payload.require_attestation !== undefined ||
    payload.requireAttestation !== undefined ||
    payload.attestation_available !== undefined ||
    payload.attestationAvailable !== undefined ||
    payload.scope_paused !== undefined ||
    payload.scopePaused !== undefined ||
    payload.risk_action !== undefined ||
    payload.paused_action !== undefined ||
    payload.require_human_approval !== undefined ||
    payload.requireHumanApproval !== undefined;

  if (!hasPolicySignals) return null;

  return evaluatePolicyDecision({
    ...payload,
    ...explicit,
    workflow_id: explicit.workflow_id || payload.workflow_id || payload.workflowId || '',
    workflowId: explicit.workflowId || payload.workflowId || '',
    provider:
      explicit.provider || payload.provider || payload.provider_id || payload.providerId || '',
    scope: explicit.scope || payload.scope || '',
    scope_id: explicit.scope_id || explicit.scopeId || payload.scope_id || payload.scopeId || '',
  });
}

function extractTrustedAuthToken(request) {
  const bearer = trimString(request.headers.get('authorization'));
  if (bearer.toLowerCase().startsWith('bearer ')) {
    return trimString(bearer.slice(7));
  }
  return firstTruthy(
    request.headers.get('x-nitro-token'),
    request.headers.get('x-morpheus-runtime-token'),
    request.headers.get('x-api-key')
  );
}

// The rate-limit bypass must be gated on a credential that is SEPARATE from the
// service signing/auth tokens (MORPHEUS_RUNTIME_TOKEN / NITRO_API_TOKEN /
// NITRO_SHARED_SECRET). Those tokens authorize signing; reusing
// them to also grant unlimited rate means a single leaked signing token both
// signs AND removes the abuse ceiling. The bypass therefore requires its own
// dedicated token(s) — if none are configured, there is no bypass (fail closed),
// so every request is rate limited.
function trustedRateLimitBypassTokens() {
  return [
    process.env.MORPHEUS_RATE_LIMIT_BYPASS_TOKEN,
    process.env.MORPHEUS_RATE_LIMIT_BYPASS_TOKENS,
  ]
    .flatMap((value) => trimString(value).split(','))
    .map((value) => trimString(value))
    .filter(Boolean);
}

function isTrustedServiceRequest(request) {
  const token = extractTrustedAuthToken(request);
  if (!token) return false;
  const trusted = trustedRateLimitBypassTokens();
  if (trusted.length === 0) return false;
  return trusted.includes(token);
}

function routePolicy(name) {
  const enabled = normalizeBoolean(process.env.MORPHEUS_UPSTASH_GUARDS_ENABLED, false);
  if (!enabled || !name) return null;

  const defaults = {
    paymaster_authorize: { max: 20, window: '1m', idempotencyTtl: '15m', lockTtl: '30s' },
    relay_transaction: { max: 20, window: '1m', idempotencyTtl: '15m', lockTtl: '30s' },
    txproxy_invoke: { max: 30, window: '1m', idempotencyTtl: '5m', lockTtl: '15s' },
    compute_execute: { max: 10, window: '1m', idempotencyTtl: '10m', lockTtl: '30s' },
    vrf_random: { max: 15, window: '1m', idempotencyTtl: '10m', lockTtl: '30s' },
    oracle_query: { max: 30, window: '1m', idempotencyTtl: '30s', lockTtl: '10s' },
    oracle_smart_fetch: { max: 30, window: '1m', idempotencyTtl: '30s', lockTtl: '10s' },
    oracle_feed: { max: 20, window: '1m', idempotencyTtl: '2m', lockTtl: '15s' },
    neodid_action_ticket: { max: 12, window: '1m', idempotencyTtl: '5m', lockTtl: '15s' },
    neodid_recovery_ticket: { max: 6, window: '1m', idempotencyTtl: '5m', lockTtl: '15s' },
    neodid_zklogin_ticket: { max: 8, window: '1m', idempotencyTtl: '5m', lockTtl: '15s' },
    session_start: { max: 12, window: '1m', idempotencyTtl: '5m', lockTtl: '15s' },
    session_step: { max: 600, window: '1m', idempotencyTtl: '30s', lockTtl: '5s' },
    session_finalize: { max: 12, window: '1m', idempotencyTtl: '5m', lockTtl: '15s' },
  };

  const current = defaults[name];
  if (!current) return null;

  const upper = name.toUpperCase();
  return {
    name,
    max: Number(process.env[`MORPHEUS_RATE_LIMIT_${upper}_MAX`] || current.max),
    windowMs: parseDurationMs(
      process.env[`MORPHEUS_RATE_LIMIT_${upper}_WINDOW_MS`] || current.window,
      parseDurationMs(current.window, 60_000)
    ),
    idempotencyTtlMs: parseDurationMs(
      process.env[`MORPHEUS_IDEMPOTENCY_${upper}_TTL_MS`] || current.idempotencyTtl,
      parseDurationMs(current.idempotencyTtl, 60_000)
    ),
    lockTtlMs: parseDurationMs(
      process.env[`MORPHEUS_IDEMPOTENCY_${upper}_LOCK_TTL_MS`] || current.lockTtl,
      parseDurationMs(current.lockTtl, 15_000)
    ),
  };
}

function getClientIp(request) {
  const headers = request.headers;
  // SECURITY (S2): only platform-injected IP headers are trusted
  // (Cloudflare cf-connecting-ip / Vercel x-vercel-forwarded-for). x-real-ip,
  // x-client-ip and a bare x-forwarded-for are client-controllable when the
  // request does not pass through a trusted proxy and must not feed rate-limit
  // keys. Absent a platform header, share the 'unknown' bucket (over-limit) so
  // the limiter cannot be bypassed by forging a per-request IP.
  const platform = firstTruthy(
    headers.get('cf-connecting-ip'),
    headers.get('x-vercel-forwarded-for')
  );
  if (platform) return trimString(platform.split(',')[0]);
  return 'unknown';
}

function payloadIdentity(payload = {}) {
  const paymaster =
    payload?.paymaster && typeof payload.paymaster === 'object' ? payload.paymaster : {};
  const metaInvocation =
    payload?.metaInvocation && typeof payload.metaInvocation === 'object'
      ? payload.metaInvocation
      : {};
  const firstArg = Array.isArray(metaInvocation.args) ? metaInvocation.args[0] : null;
  return {
    accountId: firstTruthy(
      payload.account_id,
      payload.accountId,
      paymaster.account_id,
      paymaster.accountId,
      firstArg?.value
    ).toLowerCase(),
    dappId: firstTruthy(
      payload.dapp_id,
      payload.dappId,
      paymaster.dapp_id,
      paymaster.dappId
    ).toLowerCase(),
    operationHash: firstTruthy(
      payload.operation_hash,
      payload.operationHash,
      payload.request_id,
      payload.requestId,
      payload.idempotency_key,
      paymaster.operation_hash,
      paymaster.operationHash
    ).toLowerCase(),
  };
}

function deriveIdempotencyKey(routeName, payload = {}, request) {
  const explicit = firstTruthy(
    request.headers.get('idempotency-key'),
    request.headers.get('x-idempotency-key'),
    payload.idempotency_key,
    payload.idempotencyKey
  );
  if (explicit) return explicit;

  const workflowId = firstTruthy(payload.workflow_id, payload.workflowId);
  const executionId = firstTruthy(payload.execution_id, payload.executionId);
  if (workflowId && executionId) {
    return ['workflow', workflowId, executionId].join(':');
  }

  const identity = payloadIdentity(payload);
  if (identity.operationHash) return identity.operationHash;

  if (routeName === 'oracle_query' || routeName === 'oracle_smart_fetch') {
    return sha256Hex({
      routeName,
      provider: payload.provider,
      symbol: payload.symbol,
      url: payload.url,
      method: payload.method,
      json_path: payload.json_path,
      script: payload.script,
      script_base64: payload.script_base64,
      headers: payload.headers,
      body: payload.body,
      encrypted_params: payload.encrypted_params,
      encrypted_params_ref: payload.encrypted_params_ref,
      encrypted_input: payload.encrypted_input,
      encrypted_input_ref: payload.encrypted_input_ref,
      encrypted_payload: payload.encrypted_payload,
      encrypted_payload_ref: payload.encrypted_payload_ref,
      encrypted_token_ref: payload.encrypted_token_ref,
      project_slug: payload.project_slug,
    });
  }

  return '';
}

function buildRateLimitKey(routeName, request, payload = {}) {
  const clientIp = getClientIp(request);
  const identity = payloadIdentity(payload);
  return [
    'morpheus',
    'ratelimit',
    routeName,
    clientIp || 'unknown',
    identity.accountId || 'anon',
    identity.dappId || 'none',
  ].join(':');
}

/**
 * SECURITY (S6): the idempotency cache/lock keys are scoped to the calling
 * principal (account + dapp). The idempotency-key header alone is
 * attacker-controlled; without principal scoping an unauthenticated caller
 * could pre-compute (or guess) a victim's cache key and read/poison the cached
 * response — e.g. an oracle or compute result — across accounts. Binding
 * account + dapp keeps every cache entry principal-scoped while preserving the
 * idempotency contract that a repeated request (same key, same execution)
 * returns the same cached result for its owner.
 */
function buildIdempotencyScope(payload = {}) {
  const identity = payloadIdentity(payload);
  return {
    accountId: identity.accountId || 'anon',
    dappId: identity.dappId || 'none',
  };
}

function buildResponseCacheKey(routeName, idempotencyKey, payload) {
  const scope = buildIdempotencyScope(payload);
  return (
    `morpheus:idem:response:${routeName}:${scope.accountId}:${scope.dappId}:` +
    sha256Hex(idempotencyKey)
  );
}

function buildLockKey(routeName, idempotencyKey, payload) {
  const scope = buildIdempotencyScope(payload);
  return (
    `morpheus:idem:lock:${routeName}:${scope.accountId}:${scope.dappId}:` +
    sha256Hex(idempotencyKey)
  );
}

export async function applyRequestGuards({ request, path, payload }) {
  // Resolve with the payload so action-routed requests (capabilities matched
  // via payload.action on an unrecognized path) hit the same limiter as the
  // capability the dispatcher will execute.
  const routeName = resolveRouteName(path, payload);
  const requestPolicyDecision = resolveRequestPolicyDecision(payload);
  if (requestPolicyDecision && !requestPolicyDecision.allow) {
    return {
      ok: false,
      routeName,
      response: json(requestPolicyDecision.httpStatus || 403, {
        error: 'policy_denied',
        route: routeName,
        reason: requestPolicyDecision.reason,
        decision: requestPolicyDecision.decision,
      }),
    };
  }

  const policy = routePolicy(routeName);
  if (!policy || !isUpstashEnabled()) {
    return { ok: true, routeName, policyDecision: requestPolicyDecision };
  }

  if (!isTrustedServiceRequest(request)) {
    const rateLimit = await incrementFixedWindowCounter(
      buildRateLimitKey(routeName, request, payload),
      {
        max: policy.max,
        windowMs: policy.windowMs,
      }
    );
    if (!rateLimit.allowed) {
      return {
        ok: false,
        routeName,
        response: json(
          429,
          {
            error: 'rate_limit_exceeded',
            route: routeName,
            retry_after: rateLimit.retryAfter,
          },
          { 'retry-after': String(rateLimit.retryAfter) }
        ),
      };
    }
  }

  const idempotencyKey = deriveIdempotencyKey(routeName, payload, request);
  if (!idempotencyKey) {
    return { ok: true, routeName };
  }

  const responseCacheKey = buildResponseCacheKey(routeName, idempotencyKey, payload);
  const cached = await upstashGetJson(responseCacheKey);
  if (cached?.status && cached.body !== undefined) {
    return {
      ok: false,
      routeName,
      response: json(cached.status, cached.body, cached.headers || {}),
      cached: true,
    };
  }

  const lockKey = buildLockKey(routeName, idempotencyKey, payload);
  const lockOwnerToken = await claimIdempotencyLock(lockKey, policy.lockTtlMs);
  if (!lockOwnerToken) {
    return {
      ok: false,
      routeName,
      response: json(
        409,
        {
          error: 'request_in_progress',
          route: routeName,
        },
        { 'retry-after': String(Math.max(Math.ceil(policy.lockTtlMs / 1000), 1)) }
      ),
    };
  }

  return {
    ok: true,
    routeName,
    policyDecision: requestPolicyDecision,
    idempotency: {
      responseCacheKey,
      lockKey,
      lockOwnerToken,
      ttlMs: policy.idempotencyTtlMs,
    },
  };
}

// Only successes and deterministic client rejections are safe to replay for an
// idempotency key. The worker's top-level catch maps transient upstream
// failures (RPC errors, oracle fetch timeouts) to 400, so other 4xx statuses
// are never cached — replaying them would turn a momentary blip into a sticky
// failure for the route's full idempotency TTL.
const CACHEABLE_CLIENT_ERROR_STATUSES = new Set([403, 404, 405, 410, 413, 422]);

function isCacheableGuardStatus(status) {
  return (status >= 200 && status < 300) || CACHEABLE_CLIENT_ERROR_STATUSES.has(status);
}

export async function persistGuardResult(guard, response) {
  if (!guard?.idempotency || !response) return;
  try {
    const cloned = response.clone();
    const bodyText = await cloned.text();
    const body = bodyText ? JSON.parse(bodyText) : null;
    if (isCacheableGuardStatus(response.status)) {
      await upstashSetJson(
        guard.idempotency.responseCacheKey,
        {
          status: response.status,
          headers: {
            'content-type': response.headers.get('content-type') || 'application/json',
          },
          body,
        },
        { ttlMs: guard.idempotency.ttlMs }
      );
    }
  } catch {
    // Best-effort cache population only.
  }
}

// Releasing the idempotency lock must run in a finally that always executes —
// including when the capability handler throws and the request short-circuits to
// the worker's outer catch. Keeping this separate from persistGuardResult (which
// only runs on the success path) prevents a thrown handler from holding the lock
// until its TTL and blocking legitimate retries of the same idempotency key.
export async function releaseGuardLock(guard) {
  const lockKey = guard?.idempotency?.lockKey;
  const lockOwnerToken = guard?.idempotency?.lockOwnerToken;
  if (!lockKey || !lockOwnerToken) return;
  await releaseIdempotencyLock(lockKey, lockOwnerToken).catch(() => {});
}
