import {
  json,
  trimString,
  getClientIp,
  timingSafeCompare,
} from '@r3e-network/neo-os-services-shared/utils';
import { applyUpstashRateLimit } from '@r3e-network/neo-os-services-shared/rate-limit';
import { buildPublicRuntimeStatusSnapshot } from '../../../packages/shared/src/public-runtime.js';
import runtimeCatalog from '../../../apps/web/public/morpheus-runtime-catalog.json' with { type: 'json' };

const CACHE_RULES = [
  { match: (url, req) => req.method === 'GET' && url.pathname.endsWith('/health'), ttl: 15 },
  { match: (url, req) => req.method === 'GET' && url.pathname.endsWith('/providers'), ttl: 60 },
  {
    match: (url, req) => req.method === 'GET' && url.pathname.endsWith('/feeds/catalog'),
    ttl: 300,
  },
  {
    match: (url, req) => req.method === 'GET' && url.pathname.endsWith('/oracle/public-key'),
    ttl: 300,
  },
  {
    match: (url, req) => req.method === 'GET' && /\/feeds\/price(?:\/|$)/.test(url.pathname),
    ttl: 15,
  },
];

const TURNSTILE_PROTECTED_PATHS = [
  '/paymaster/authorize',
  '/relay/transaction',
  '/compute/execute',
  '/vrf/random',
];

const RUNTIME_AUTH_REQUIRED_PATHS = [
  '/info',
  '/keys/derived',
  '/runtime/keys/derived',
  '/oracle/query',
  '/oracle/smart-fetch',
  '/compute/execute',
  '/neodid/bind',
];

const UPSTASH_ROUTE_LIMITS = {
  paymaster: { limit: 20, windowMs: 60_000 },
  relay: { limit: 20, windowMs: 60_000 },
  compute: { limit: 10, windowMs: 60_000 },
  vrf: { limit: 15, windowMs: 60_000 },
  'oracle-query': { limit: 30, windowMs: 60_000 },
  // Confidential decrypt/reveal passthrough lanes. The box self-gates access
  // in-TEE, but the lane is still public, so it carries its own edge rate limit
  // rather than being silently uncapped.
  confidential: { limit: 15, windowMs: 60_000 },
};

function stripLeadingSlash(value) {
  return String(value || '').replace(/^\/+/, '');
}

function resolveNetworkRoute(url, env) {
  const path = url.pathname || '/';
  if (path === '/' || path === '') {
    return {
      network: 'testnet',
      forwardedPath: '/',
      routePrefix: '/',
      originBaseUrl: trimString(env.MORPHEUS_TESTNET_ORIGIN_URL || env.MORPHEUS_ORIGIN_URL).replace(
        /\/$/,
        ''
      ),
    };
  }

  const segments = stripLeadingSlash(path).split('/');
  const prefix = segments[0]?.toLowerCase();
  if (prefix === 'mainnet' || prefix === 'testnet') {
    const rest = segments.slice(1).join('/');
    const forwardedPath = `/${rest}`.replace(/\/+$/, '') || '/';
    const originBaseUrl = resolveOriginBaseUrl(env, prefix, forwardedPath);
    return {
      network: prefix,
      forwardedPath,
      routePrefix: `/${prefix}`,
      originBaseUrl,
    };
  }

  return {
    network: 'testnet',
    forwardedPath: path,
    routePrefix: '',
    originBaseUrl: resolveOriginBaseUrl(env, 'testnet', path),
  };
}

function resolveOriginBaseUrl(env, network, forwardedPath) {
  const normalized = network === 'mainnet' ? 'MAINNET' : 'TESTNET';
  if (String(forwardedPath || '').replace(/\/+$/, '') === '/oracle/feed') {
    const feedOrigin = trimString(
      env[`MORPHEUS_${normalized}_FEED_ORIGIN_URL`] ||
        env[`MORPHEUS_${normalized}_DATAFEED_ORIGIN_URL`] ||
        env.MORPHEUS_FEED_ORIGIN_URL ||
        env.MORPHEUS_DATAFEED_ORIGIN_URL
    );
    if (feedOrigin) return feedOrigin.replace(/\/$/, '');
  }
  return network === 'mainnet'
    ? trimString(env.MORPHEUS_MAINNET_ORIGIN_URL || env.MORPHEUS_ORIGIN_URL).replace(/\/$/, '')
    : trimString(env.MORPHEUS_TESTNET_ORIGIN_URL || env.MORPHEUS_ORIGIN_URL).replace(/\/$/, '');
}

// Map the legacy runtime path shape (what external callers hit:
// oracle.meshmini.app/<net>/<path>) onto the apps/web public API routes that now
// serve these trustlessly (on-chain reads + the attested box health). Returns the
// apps/web path (+ ?network) for the supported public routes, or null for routes
// that still require the full runtime (compute / AA / signing) — those get a clean
// 503 instead of proxying the retired origin.
function mapToAppBackendPath(forwardedPath, network) {
  const p = String(forwardedPath || '/').replace(/\/+$/, '') || '/';
  const net = network === 'mainnet' ? 'mainnet' : 'testnet';
  const q = `?network=${net}`;
  if (p === '/' || p === '/health') return `/api/runtime/health${q}`;
  if (p === '/info') return `/api/runtime/info${q}`;
  if (p === '/v1/status' || p === '/status') return `/api/runtime/status${q}`;
  if (p === '/oracle/public-key') return `/api/oracle/public-key${q}`;
  if (p === '/providers') return `/api/providers${q}`;
  if (p === '/neodid/providers') return '/api/neodid/providers';
  if (p === '/feeds/catalog') return '/api/feeds/catalog';
  if (p === '/feeds/status') return '/api/feeds/status';
  const feed = p.match(/^\/(?:feeds\/price|prices)\/(.+)$/);
  if (feed) {
    // The symbol segment is interpolated into the origin path, so restrict it to
    // a safe charset (alphanumeric plus - _ . and the provider-prefix colon,
    // e.g. TWELVEDATA:NEO-USD). Rejecting '/' (and any other character) prevents
    // path traversal / origin-path injection; an out-of-charset symbol is treated
    // as an unsupported route (clean 503 rather than a forged origin request).
    const symbol = feed[1];
    if (!/^[A-Za-z0-9._:-]+$/.test(symbol)) return null;
    return `/api/feeds/${symbol}${q}`;
  }
  return null;
}

// Confidential routes that the in-TEE worker SELF-GATES (recipient EIP-191
// signature for /oracle/message-reveal; time-lock re-assertion for /oracle/decrypt),
// so the edge can expose them to public clients by proxying to the attested box
// with the box runtime token — public callers never hold the token, and the box
// enforces per-message access IN-TEE. These are NOT in RUNTIME_AUTH_REQUIRED_PATHS
// (the edge does not require a client token; the box does the gating).
const RUNTIME_BOX_PASSTHROUGH = ['/oracle/decrypt', '/oracle/message-reveal'];

function isRuntimeBoxPassthrough(forwardedPath) {
  const p = String(forwardedPath || '/').replace(/\/+$/, '') || '/';
  return RUNTIME_BOX_PASSTHROUGH.includes(p);
}

function buildRuntimeBoxRequest(request, env, network, forwardedPath, search) {
  const base = trimString(env.MORPHEUS_RUNTIME_BOX_URL);
  if (!base) return null;
  const token =
    trimString(env.MORPHEUS_RUNTIME_BOX_TOKEN) ||
    trimString(env.MORPHEUS_RUNTIME_TOKEN) ||
    trimString(env.MORPHEUS_ORIGIN_TOKEN);
  const net = network === 'mainnet' ? 'mainnet' : 'testnet';
  const target = `${base.replace(/\/+$/, '')}/${net}${forwardedPath}${search || ''}`;
  const headers = new Headers(request.headers);
  headers.delete('host');
  if (token) {
    headers.set('authorization', `Bearer ${token}`);
    headers.set('x-morpheus-runtime-token', token);
  }
  headers.set('x-forwarded-proto', 'https');
  headers.set('x-morpheus-network', net);
  return new Request(target, {
    method: request.method,
    headers,
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
    duplex: request.method === 'GET' || request.method === 'HEAD' ? undefined : 'half',
    redirect: 'manual',
  });
}

function shouldProtectWithTurnstile(pathname) {
  return TURNSTILE_PROTECTED_PATHS.some((path) => pathname.endsWith(path));
}

function requiresTrustedRuntimeAuth(pathname) {
  return RUNTIME_AUTH_REQUIRED_PATHS.some((path) => pathname.endsWith(path));
}

function extractTrustedAuthToken(request) {
  const authorization = trimString(request.headers.get('authorization'));
  if (authorization.toLowerCase().startsWith('bearer ')) {
    return trimString(authorization.slice(7));
  }
  return (
    trimString(request.headers.get('x-morpheus-runtime-token')) ||
    trimString(request.headers.get('x-api-key'))
  );
}

function isTrustedAutomationRequest(request, env) {
  const token = extractTrustedAuthToken(request);
  if (!token) return false;
  const trustedTokens = [
    env.MORPHEUS_RUNTIME_TOKEN,
    env.MORPHEUS_EDGE_RUNTIME_TOKEN,
    env.MORPHEUS_ORIGIN_TOKEN,
  ]
    .map(trimString)
    .filter(Boolean);
  // Constant-time compare against every configured trusted token so a remote
  // attacker cannot use response-timing to recover the secret byte-by-byte.
  // Always walk the full list (no early `return true`) to keep the per-token
  // cost uniform; timingSafeCompare itself short-circuits only on length
  // mismatch, which leaks length but not content.
  let matched = false;
  for (const candidate of trustedTokens) {
    if (timingSafeCompare(token, candidate)) matched = true;
  }
  return matched;
}

function resolveCacheRule(url, request) {
  return CACHE_RULES.find((rule) => rule.match(url, request)) || null;
}

async function verifyTurnstile(request, env) {
  const secret = trimString(env.TURNSTILE_WORKER_SECRET || env.TURNSTILE_SECRET_KEY);
  if (!secret) return null;

  const url = new URL(request.url);
  if (!shouldProtectWithTurnstile(url.pathname)) return null;
  if (isTrustedAutomationRequest(request, env)) return null;

  const cloned = request.clone();
  const contentType = trimString(cloned.headers.get('content-type')).toLowerCase();
  let token =
    trimString(request.headers.get('cf-turnstile-token')) ||
    trimString(request.headers.get('x-turnstile-token'));

  if (!token && contentType.includes('application/json')) {
    const body = await cloned.json().catch(() => ({}));
    token = trimString(body.turnstile_token || body.turnstileToken);
  }

  if (!token) {
    return json(403, { error: 'turnstile_required' });
  }

  const formData = new URLSearchParams();
  formData.set('secret', secret);
  formData.set('response', token);
  formData.set('remoteip', getClientIp(request));

  const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: formData,
  });
  const payload = await response.json().catch(() => ({}));
  if (!payload.success) {
    return json(403, {
      error: 'turnstile_failed',
      details: payload['error-codes'] || [],
    });
  }
  return null;
}

async function applyNativeRateLimit(request, env, routeKey) {
  if (isTrustedAutomationRequest(request, env)) return null;
  if (!env.MORPHEUS_RATE_LIMITER || typeof env.MORPHEUS_RATE_LIMITER.limit !== 'function') {
    return applyUpstashRateLimitImpl(request, env, routeKey);
  }
  const verdict = await env.MORPHEUS_RATE_LIMITER.limit({
    key: `${routeKey}:${getClientIp(request)}`,
  });
  if (verdict?.success) return null;
  const retryAfter = verdict?.retryAfter ?? 60;
  return json(
    429,
    { error: 'rate_limit_exceeded', route: routeKey },
    { 'retry-after': String(retryAfter) }
  );
}

function routeLimitConfig(routeKey, env) {
  const defaults = UPSTASH_ROUTE_LIMITS[routeKey];
  if (!defaults) return null;
  const upper = routeKey.toUpperCase().replace(/-/g, '_');
  return {
    limit: Number(env[`MORPHEUS_RATE_LIMIT_${upper}_MAX`] || defaults.limit),
    windowMs: Number(env[`MORPHEUS_RATE_LIMIT_${upper}_WINDOW_MS`] || defaults.windowMs),
  };
}

function upstashConfigured(env) {
  return Boolean(
    trimString(env.UPSTASH_REDIS_REST_URL) && trimString(env.UPSTASH_REDIS_REST_TOKEN)
  );
}

async function applyUpstashRateLimitImpl(request, env, routeKey) {
  if (isTrustedAutomationRequest(request, env)) return null;
  const config = routeLimitConfig(routeKey, env);
  // A null config means the route has NO limit intended -> allow. This is the
  // only legitimate fail-open case.
  if (!config) return null;

  // The route HAS a configured limit. If no limiter backend is available at all
  // (neither the native binding — checked by the caller — nor Upstash), we must
  // FAIL CLOSED: a configured limit with no enforcement backend would otherwise
  // silently allow unbounded traffic on a protected lane.
  if (!upstashConfigured(env)) {
    return json(
      503,
      { error: 'rate_limit_backend_unavailable', route: routeKey },
      { 'cache-control': 'no-store' }
    );
  }

  const key = `morpheus:edge:ratelimit:${routeKey}:${getClientIp(request)}`;
  let result;
  try {
    result = await applyUpstashRateLimit(env, key, {
      max: config.limit,
      windowMs: config.windowMs,
    });
  } catch (error) {
    // The Upstash backend is the rate-limit source of truth; if it is
    // unreachable or 5xx we must fail closed rather than let the throw surface
    // as an opaque 500 (which would also fail *open*, silently dropping the
    // limit). Returning 503 keeps the protected lanes guarded during an
    // Upstash outage and gives callers a retryable, machine-readable signal.
    return json(503, {
      error: 'rate_limit_backend_unavailable',
      route: routeKey,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  // result === null here means Upstash is configured AND the request is within
  // the limit (allowed) -> proceed.
  if (!result) return null;
  if (result.allowed === false) {
    return json(
      429,
      { error: 'rate_limit_exceeded', route: routeKey },
      { 'retry-after': String(result.retryAfter) }
    );
  }
  return json(503, { error: 'rate_limit_backend_unavailable', route: routeKey });
}

function buildOriginRequest(request, env, appPath) {
  const incomingUrl = new URL(request.url);
  const routing = resolveNetworkRoute(incomingUrl, env);
  const originBaseUrl = routing.originBaseUrl;
  if (!originBaseUrl) {
    throw new Error(`origin URL is required for network ${routing.network}`);
  }

  // appPath is the apps/web route the edge path maps to (carries ?network); merge
  // any other incoming query params onto it.
  const target = new URL(`${originBaseUrl}${appPath}`);
  for (const [k, v] of incomingUrl.searchParams) {
    if (!target.searchParams.has(k)) target.searchParams.set(k, v);
  }
  const targetUrl = target.toString();
  const headers = new Headers(request.headers);
  headers.delete('host');
  if (!headers.has('authorization') && trimString(env.MORPHEUS_ORIGIN_TOKEN)) {
    headers.set('authorization', `Bearer ${trimString(env.MORPHEUS_ORIGIN_TOKEN)}`);
  }
  headers.set('x-forwarded-proto', 'https');
  headers.set('x-edge-route', incomingUrl.pathname);
  headers.set('x-morpheus-network', routing.network);

  return new Request(targetUrl, {
    method: request.method,
    headers,
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
    duplex: request.method === 'GET' || request.method === 'HEAD' ? undefined : 'half',
    // SECURITY (S14): never follow redirects — the Authorization (origin token)
    // header is attached above and a 3xx Location pointing at an external host
    // would otherwise be fetched with the credential. Return the redirect to the
    // caller instead.
    redirect: 'manual',
  });
}

function matchPublicRuntimeRoute(path) {
  if (path === '/api/runtime/catalog') return 'runtime-catalog';
  if (path === '/api/runtime/status') return 'runtime-status';
  return null;
}

function maybeParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text || null;
  }
}

// Cloudflare workers have a wall-clock budget (~30s); a hung origin must fail
// fast to the existing 503 origin_unavailable path instead of stalling the
// worker to that limit. Both timeouts are env-tunable and clamped below the CF
// cap. Proxy default 10s (>= the longest legit origin op), probe default 5s.
const DEFAULT_PROXY_TIMEOUT_MS = 10_000;
const DEFAULT_PROBE_TIMEOUT_MS = 5_000;
const MAX_ORIGIN_TIMEOUT_MS = 25_000;

function resolveOriginTimeoutMs(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.max(Math.round(parsed), 1000), MAX_ORIGIN_TIMEOUT_MS);
}

function decorateGatewayResponse(response, routing, routeKey) {
  response.headers.set('x-morpheus-edge', 'cloudflare');
  response.headers.set('x-morpheus-route', routeKey);
  response.headers.set('x-morpheus-network', routing.network);
  return response;
}

async function enforceHealthNetwork(response, routing) {
  if (routing.forwardedPath !== '/health' || !response.ok) return response;

  const body = await response
    .clone()
    .json()
    .catch(() => null);
  const actualNetwork = trimString(body?.network).toLowerCase();
  if (actualNetwork === routing.network) return response;

  return json(
    503,
    {
      ...(body && typeof body === 'object' && !Array.isArray(body) ? body : {}),
      status: 'degraded',
      ready: false,
      error: 'runtime_network_mismatch',
      requested_network: routing.network,
      actual_network: actualNetwork || null,
      network: actualNetwork || null,
    },
    { 'cache-control': 'no-store' }
  );
}

function buildOriginProbeRequest(request, routing, env, targetPath) {
  if (!routing.originBaseUrl) {
    throw new Error('origin URL is required for network ' + routing.network);
  }

  // Status probes use the same apps/web backend routes as ordinary public
  // traffic. The legacy /health and /info paths are edge-facing aliases;
  // probing them directly on a Next origin returns a misleading 404.
  const appPath = mapToAppBackendPath(targetPath, routing.network);
  if (!appPath) {
    throw new Error(`unsupported runtime probe path: ${targetPath}`);
  }

  const headers = new Headers(request.headers);
  headers.delete('host');
  if (!headers.has('authorization') && trimString(env.MORPHEUS_ORIGIN_TOKEN)) {
    headers.set('authorization', 'Bearer ' + trimString(env.MORPHEUS_ORIGIN_TOKEN));
  }
  headers.set('x-forwarded-proto', 'https');
  headers.set('x-edge-route', new URL(request.url).pathname);
  headers.set('x-morpheus-network', routing.network);

  const target = new URL(routing.originBaseUrl + appPath);

  return new Request(target.toString(), {
    method: 'GET',
    headers,
    // SECURITY (S14): do not follow redirects with the origin credential
    // attached; surface 3xx to the caller instead.
    redirect: 'manual',
  });
}

async function readOriginRuntimeProbe(request, routing, env, targetPath) {
  const timeoutMs = resolveOriginTimeoutMs(
    env.MORPHEUS_EDGE_PROBE_TIMEOUT_MS,
    DEFAULT_PROBE_TIMEOUT_MS
  );
  try {
    const response = await fetch(buildOriginProbeRequest(request, routing, env, targetPath), {
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    const body = maybeParseJson(text);
    const runtime = trimString(response.headers.get('x-morpheus-runtime')) || null;

    if (targetPath === '/health' && response.ok) {
      const actualNetwork = trimString(body?.network).toLowerCase();
      if (actualNetwork !== routing.network) {
        return {
          ok: false,
          status: 503,
          runtime,
          body: {
            ...(body && typeof body === 'object' && !Array.isArray(body) ? body : {}),
            status: 'degraded',
            ready: false,
            error: 'runtime_network_mismatch',
            requested_network: routing.network,
            actual_network: actualNetwork || null,
          },
        };
      }
    }

    return {
      ok: response.ok,
      status: response.status,
      // The runtime discriminator the origin self-reports (the box's real TEE
      // runtime vs the emergency Vercel shim). Surfaced so the two public
      // surfaces cannot silently disagree about which runtime answered.
      runtime,
      body,
    };
  } catch (error) {
    // A hung /health or /info now aborts at timeoutMs and resolves to down,
    // instead of stalling Promise.all to the Cloudflare wall-clock limit.
    return {
      ok: false,
      status: 503,
      runtime: null,
      body: {
        error: 'origin_unavailable',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

// Capability fields derived from the shared runtime catalog (the single source
// of truth both the box and the emergency Vercel shim must agree with). The edge
// surfaces this canonical set on the runtime-status route so a consumer can
// detect when the runtime that actually answered (x-morpheus-runtime) diverges
// from the contracted capabilities — instead of the box and shim silently
// disagreeing on what the platform supports.
function deriveCatalogCapabilities(catalog) {
  const workflows = Array.isArray(catalog?.workflows) ? catalog.workflows : [];
  const automation =
    catalog?.automation && typeof catalog.automation === 'object' ? catalog.automation : {};
  return {
    catalogVersion: trimString(catalog?.envelope?.version) || null,
    executionPlane: trimString(catalog?.topology?.executionPlane) || null,
    teeRequired: workflows.some((wf) => wf?.execution?.teeRequired === true),
    workflowIds: workflows.map((wf) => trimString(wf?.id)).filter(Boolean),
    capabilityIds: workflows.map((wf) => trimString(wf?.capabilityId)).filter(Boolean),
    automationTriggerKinds: Array.isArray(automation.triggerKinds) ? automation.triggerKinds : [],
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const routing = resolveNetworkRoute(url, env);

    if (url.pathname === '/' || url.pathname === '') {
      return json(200, {
        service: 'morpheus-edge-gateway',
        domain: url.host,
        routes: {
          mainnet: `${url.origin}/mainnet/health`,
          testnet: `${url.origin}/testnet/health`,
        },
        default_network: routing.network,
      });
    }

    const publicRuntimeRoute = matchPublicRuntimeRoute(routing.forwardedPath);
    if (publicRuntimeRoute === 'runtime-catalog') {
      return decorateGatewayResponse(
        Response.json(structuredClone(runtimeCatalog), {
          headers: {
            'cache-control': 'public, max-age=60, stale-while-revalidate=300',
          },
        }),
        routing,
        publicRuntimeRoute
      );
    }
    if (publicRuntimeRoute === 'runtime-status') {
      const checkedAt = new Date().toISOString();
      const [health, info] = await Promise.all([
        readOriginRuntimeProbe(request, routing, env, '/health'),
        readOriginRuntimeProbe(request, routing, env, '/info'),
      ]);
      const snapshot = buildPublicRuntimeStatusSnapshot({
        catalog: runtimeCatalog,
        checkedAt,
        health,
        info,
      });
      // The runtime that actually answered (box TEE runtime vs emergency shim),
      // plus the canonical capability set both surfaces must honor. Together
      // these let a consumer detect a shim/box divergence instead of trusting
      // whichever surface they happened to reach.
      const originRuntime = health.runtime || info.runtime || null;
      snapshot.runtime.origin = originRuntime;
      snapshot.runtime.capabilities = deriveCatalogCapabilities(runtimeCatalog);
      const statusCode = snapshot.runtime.status === 'down' ? 503 : 200;
      const response = decorateGatewayResponse(
        Response.json(snapshot, {
          status: statusCode,
          headers: {
            'cache-control': 'no-store',
          },
        }),
        routing,
        publicRuntimeRoute
      );
      // Discriminator header so the runtime identity travels with the response
      // (caches, proxies, and clients can branch on it without parsing the body).
      response.headers.set('x-morpheus-runtime', originRuntime || 'unknown');
      return response;
    }

    if (
      requiresTrustedRuntimeAuth(routing.forwardedPath) &&
      !isTrustedAutomationRequest(request, env)
    ) {
      return decorateGatewayResponse(
        json(401, { error: 'unauthorized' }, { 'cache-control': 'no-store' }),
        routing,
        'origin-auth-required'
      );
    }

    const turnstileRequest =
      routing.routePrefix && url.pathname.startsWith(routing.routePrefix)
        ? new Request(`${url.origin}${routing.forwardedPath}${url.search}`, request)
        : request;
    const turnstileFailure = await verifyTurnstile(turnstileRequest, env);
    if (turnstileFailure) return turnstileFailure;

    const routeKey = isRuntimeBoxPassthrough(routing.forwardedPath)
      ? 'confidential'
      : routing.forwardedPath.endsWith('/paymaster/authorize')
        ? 'paymaster'
        : routing.forwardedPath.endsWith('/relay/transaction')
          ? 'relay'
          : routing.forwardedPath.endsWith('/compute/execute')
            ? 'compute'
            : routing.forwardedPath.endsWith('/vrf/random')
              ? 'vrf'
              : routing.forwardedPath.endsWith('/oracle/feed')
                ? 'oracle-feed'
                : routing.forwardedPath.endsWith('/oracle/query')
                  ? 'oracle-query'
                  : routing.forwardedPath.endsWith('/oracle/smart-fetch')
                    ? 'oracle-query'
                    : routing.forwardedPath.endsWith('/feeds/price') ||
                        /\/feeds\/price\//.test(routing.forwardedPath)
                      ? 'feeds-price'
                      : 'origin';

    const rateLimited = await applyNativeRateLimit(request, env, routeKey);
    if (rateLimited) return rateLimited;

    const cacheRule = resolveCacheRule(url, request);
    const cache = caches.default;
    if (cacheRule) {
      const cached = await cache.match(request);
      if (cached) return cached;
    }

    // Confidential reveal/decrypt: proxy to the attested box (the in-TEE worker
    // self-gates recipient/time-lock access), supplying the box runtime token.
    if (isRuntimeBoxPassthrough(routing.forwardedPath)) {
      const boxRequest = buildRuntimeBoxRequest(
        request,
        env,
        routing.network,
        routing.forwardedPath,
        url.search
      );
      if (!boxRequest) {
        return decorateGatewayResponse(
          json(
            503,
            { error: 'runtime_box_unconfigured', route: routing.forwardedPath },
            { 'cache-control': 'no-store' }
          ),
          routing,
          'runtime-box-unconfigured'
        );
      }
      const boxTimeoutMs = resolveOriginTimeoutMs(
        env.MORPHEUS_EDGE_ORIGIN_TIMEOUT_MS,
        DEFAULT_PROXY_TIMEOUT_MS
      );
      try {
        const boxResponse = await fetch(boxRequest, { signal: AbortSignal.timeout(boxTimeoutMs) });
        return decorateGatewayResponse(
          new Response(boxResponse.body, boxResponse),
          routing,
          'runtime-box'
        );
      } catch {
        return decorateGatewayResponse(
          json(
            503,
            {
              error: 'runtime_box_unavailable',
              route: routing.forwardedPath,
              message: 'confidential runtime temporarily unavailable',
            },
            { 'cache-control': 'no-store' }
          ),
          routing,
          'runtime-box-unavailable'
        );
      }
    }

    // Map the legacy runtime path onto the apps/web public API. Routes that still
    // need the full runtime (compute/AA/signing) are not mapped -> clean 503 rather
    // than proxying the retired origin.
    const appPath = mapToAppBackendPath(routing.forwardedPath, routing.network);
    if (appPath === null) {
      return decorateGatewayResponse(
        json(
          503,
          {
            error: 'runtime_route_unavailable',
            network: routing.network,
            route: routing.forwardedPath,
            message:
              'This oracle route requires the full runtime (restoration in progress). Public routes available: /health, /v1/status, /oracle/public-key, /providers, /feeds/catalog, /feeds/price/<symbol>.',
          },
          { 'cache-control': 'no-store' }
        ),
        routing,
        'runtime-route-unavailable'
      );
    }

    const originRequest = buildOriginRequest(request, env, appPath);
    const originTimeoutMs = resolveOriginTimeoutMs(
      env.MORPHEUS_EDGE_ORIGIN_TIMEOUT_MS,
      DEFAULT_PROXY_TIMEOUT_MS
    );
    let originResponse;
    try {
      // A hung origin aborts at originTimeoutMs and falls through to the 503
      // origin_unavailable path below, instead of stalling to the CF wall clock.
      originResponse = await fetch(originRequest, {
        signal: AbortSignal.timeout(originTimeoutMs),
      });
    } catch (error) {
      // Keep the internal failure detail (which can include the origin hostname)
      // in server logs only; clients get a generic, route-scoped message.
      console.error('origin_unavailable', {
        route: routeKey,
        network: routing.network,
        detail: error instanceof Error ? error.message : String(error),
      });
      return json(
        503,
        {
          error: 'origin_unavailable',
          network: routing.network,
          route: routeKey,
          message: 'upstream origin temporarily unavailable',
        },
        { 'cache-control': 'no-store' }
      );
    }
    if (originResponse.status >= 520) {
      return json(
        503,
        {
          error: 'origin_unavailable',
          network: routing.network,
          route: routeKey,
          upstream_status: originResponse.status,
        },
        { 'cache-control': 'no-store' }
      );
    }
    const networkCheckedResponse = await enforceHealthNetwork(originResponse, routing);
    const response = new Response(networkCheckedResponse.body, networkCheckedResponse);
    response.headers.set('x-morpheus-edge', 'cloudflare');
    response.headers.set('x-morpheus-route', routeKey);
    response.headers.set('x-morpheus-network', routing.network);

    if (cacheRule && networkCheckedResponse.ok) {
      response.headers.set('cache-control', `public, max-age=${cacheRule.ttl}`);
      ctx.waitUntil(cache.put(request, response.clone()));
    } else {
      response.headers.set('cache-control', 'no-store');
    }

    return response;
  },
};
