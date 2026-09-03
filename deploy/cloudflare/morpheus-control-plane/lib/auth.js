import {
  findCredentialDomainCollisions,
  formatCredentialDomainCollisions,
} from '@r3e-network/neo-os-services-shared/credential-separation';
import {
  json,
  timingSafeCompare,
  trimString,
  getClientIp,
} from '@r3e-network/neo-os-services-shared/utils';
import { applyUpstashRateLimit } from '@r3e-network/neo-os-services-shared/rate-limit';

const RATE_LIMITS = {
  oracle_request: { limit: 30, windowMs: 60_000 },
  feed_tick: { limit: 60, windowMs: 60_000 },
  callback_broadcast: { limit: 60, windowMs: 60_000 },
  automation_execute: { limit: 30, windowMs: 60_000 },
};

function resolveAcceptedKeys(env) {
  // Only explicitly-configured control-plane API keys are accepted as ingress
  // keys; no legacy token fallbacks (a leaked stale token must not authenticate).
  // The low-privilege provider-config key is intentionally excluded — it manages
  // provider configuration, not control-plane job ingress (audit finding 37).
  const runtimeTokens = new Set(
    [env.MORPHEUS_RUNTIME_TOKEN, env.NITRO_API_TOKEN, env.NITRO_SHARED_SECRET]
      .map((value) => trimString(value))
      .filter(Boolean)
  );
  return [env.MORPHEUS_CONTROL_PLANE_API_KEY, env.MORPHEUS_OPERATOR_API_KEY]
    .map((v) => trimString(v))
    .filter((value) => value && !runtimeTokens.has(value));
}

function validateAuth(request, env) {
  // Pairwise separation across runtime/workflow/operator/relayer/signing/relay/
  // custody domains. Overlap is a deploy mistake — refuse all ingress rather
  // than silently promote a shared secret into control-plane authority.
  const collisions = findCredentialDomainCollisions(env);
  if (collisions.length > 0) {
    return json(503, {
      error: 'auth_credential_collision',
      message: `credentials must be pairwise distinct across trust domains: ${formatCredentialDomainCollisions(collisions)}`,
    });
  }

  const keys = resolveAcceptedKeys(env);
  if (keys.length === 0) {
    // Fail closed: an empty accepted-key set means a deploy/secret mistake, not
    // an open ingress. Local/dev must opt in to anonymous access explicitly.
    if (trimString(env.MORPHEUS_CONTROL_PLANE_ALLOW_ANONYMOUS) === '1') return null;
    return json(503, { error: 'auth_not_configured' });
  }
  const bearer = trimString(request.headers.get('authorization'));
  const admin = trimString(request.headers.get('x-admin-api-key'));
  for (const key of keys) {
    if (timingSafeCompare(bearer, `Bearer ${key}`)) return null;
    if (timingSafeCompare(admin, key)) return null;
  }
  return json(401, { error: 'unauthorized' });
}

async function applyRateLimit(request, env, queueName) {
  const config = RATE_LIMITS[queueName];
  if (!config) return null;

  const key = `morpheus:control-plane:${queueName}:${getClientIp(request)}`;
  let result;
  try {
    result = await applyUpstashRateLimit(env, key, {
      max: config.limit,
      windowMs: config.windowMs,
    });
  } catch (error) {
    // Upstash is the rate-limit source of truth. A throw here (network error or
    // 5xx from the pipeline call) must fail closed with a retryable 503 rather
    // than surface as an opaque 500 — letting the exception escape would also
    // bypass the limiter entirely (fail open), which is the worse outcome on a
    // job-ingest control plane.
    return json(503, {
      error: 'rate_limit_backend_unavailable',
      queue: queueName,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  if (!result) return null;
  if (result.allowed === false) {
    return json(
      429,
      { error: 'rate_limit_exceeded', queue: queueName },
      { 'retry-after': String(result.retryAfter) }
    );
  }
  return json(503, { error: 'rate_limit_backend_unavailable', queue: queueName });
}

export { validateAuth, applyRateLimit };
