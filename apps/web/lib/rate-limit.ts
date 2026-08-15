import { isUpstashConfigured } from './upstash';
import { isSupabaseRateLimitConfigured } from './supabase-rate-limit';

export interface RateLimitOptions {
  windowMs?: number;
  maxRequests?: number;
  keyGenerator?: (request: Request) => string;
  scope?: string;
}

interface RateLimitRecord {
  count: number;
  windowStart: number;
  lastAccessed: number;
}

const DEFAULT_WINDOW_MS = 60 * 1000;
const DEFAULT_MAX_REQUESTS = 100;
const MAX_LOCAL_ENTRIES = 10_000;

const PRIVATE_IPS = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^::1$/,
  /^[fF][cCdD][0-9a-fA-F]{2}:/,
];

let rateLimitMap = new Map<string, RateLimitRecord>();

function isProduction() {
  return process.env.NODE_ENV === 'production';
}

function requireDistributedBackendInProduction() {
  if (isProduction() && !isUpstashConfigured() && !isSupabaseRateLimitConfigured()) {
    throw new Error(
      'Production rate limiting requires a distributed backend: a complete Redis REST ' +
        'credential pair ' +
        '(UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN or ' +
        'KV_REST_API_URL/KV_REST_API_TOKEN), or a Supabase URL/service-role pair. ' +
        'In-memory rate limiting is not allowed in production because it is not shared across serverless instances.'
    );
  }
}

function rateLimitBackendUnavailableResponse() {
  return Response.json(
    {
      error: 'Rate limit service is temporarily unavailable',
      error_code: 'RATE_LIMIT_BACKEND_UNAVAILABLE',
    },
    {
      status: 503,
      headers: {
        'cache-control': 'no-store',
        'retry-after': '1',
      },
    }
  );
}

/**
 * Throws if the production backend is not configured. Call this during startup
 * or before handling the first request when running in production.
 */
export function assertProductionRateLimitBackend(): void {
  requireDistributedBackendInProduction();
}

function evictOldestIfNeeded() {
  if (rateLimitMap.size < MAX_LOCAL_ENTRIES) return;

  let oldestKey: string | null = null;
  let oldestAccessed = Infinity;
  for (const [key, record] of rateLimitMap.entries()) {
    if (record.lastAccessed < oldestAccessed) {
      oldestAccessed = record.lastAccessed;
      oldestKey = key;
    }
  }
  if (oldestKey !== null) {
    rateLimitMap.delete(oldestKey);
  }
}

function incrementLocalCounter(key: string, windowMs: number, now: number) {
  const windowStart = now - windowMs;

  let record = rateLimitMap.get(key);
  if (!record || record.windowStart < windowStart) {
    record = { count: 0, windowStart: now, lastAccessed: now };
    evictOldestIfNeeded();
    rateLimitMap.set(key, record);
  } else {
    record.lastAccessed = now;
  }

  record.count += 1;

  return {
    count: record.count,
    resetAt: record.windowStart + windowMs,
  };
}

export function getClientIp(request: Request): string {
  // SECURITY (S2): only platform-injected IP headers are trusted. Vercel sets
  // `x-vercel-forwarded-for`; Cloudflare sets `cf-connecting-ip` when the app is
  // fronted by Cloudflare. `x-real-ip`, `x-client-ip` and a bare
  // `x-forwarded-for` are client-controllable when not rewritten by the edge and
  // MUST NOT feed rate-limit keys (each forged value would mint a fresh bucket).
  // Absent a platform header we return 'unknown' so all callers share one bucket
  // (over-limiting) rather than letting the limiter be bypassed.
  const platformIp =
    request.headers.get('cf-connecting-ip')?.trim() ||
    request.headers.get('x-vercel-forwarded-for')?.trim();
  if (platformIp) {
    return platformIp.split(',')[0].trim();
  }
  return 'unknown';
}

export function isPrivateIp(ip: string): boolean {
  if (!ip || ip === 'unknown') return true;
  return PRIVATE_IPS.some((regex) => regex.test(ip));
}

export function ipKeyGenerator(request: Request): string {
  const ip = getClientIp(request);
  return isPrivateIp(ip) ? 'internal' : ip;
}

/**
 * Enforce a rate limit for an already-authenticated principal (e.g. user.id).
 * Returns a 429 response when over the limit, or null when allowed. Unlike the
 * request-keyed `rateLimit` middleware, this is called AFTER authentication so
 * the key is a trusted identifier — never an unvalidated client-supplied token
 * (an attacker could otherwise mint a fresh key per request to bypass limits).
 */
export async function enforceRateLimit(
  key: string,
  options: RateLimitOptions = {}
): Promise<Response | null> {
  const windowMs = options.windowMs || DEFAULT_WINDOW_MS;
  const maxRequests = options.maxRequests || DEFAULT_MAX_REQUESTS;
  const scope = String(options.scope || 'default').trim() || 'default';
  const now = Date.now();
  let count = 0;
  let resetAt = now + windowMs;

  const hasRedisBackend = isUpstashConfigured();
  const hasSupabaseBackend = isSupabaseRateLimitConfigured();
  if (hasRedisBackend || hasSupabaseBackend) {
    try {
      const counterKey = `morpheus:web-rate-limit:${scope}:${windowMs}:${key}`;
      const shared = hasRedisBackend
        ? await import('./upstash').then(({ incrementFixedWindowCounter }) =>
            incrementFixedWindowCounter(counterKey, windowMs)
          )
        : await import('./supabase-rate-limit').then(({ incrementSupabaseFixedWindowCounter }) =>
            incrementSupabaseFixedWindowCounter(counterKey, windowMs)
          );
      count = shared.current;
      resetAt = now + Math.max(shared.ttlMs, 0);
    } catch {
      if (isProduction()) return rateLimitBackendUnavailableResponse();
      const local = incrementLocalCounter(key, windowMs, now);
      count = local.count;
      resetAt = local.resetAt;
    }
  } else {
    requireDistributedBackendInProduction();
    const local = incrementLocalCounter(key, windowMs, now);
    count = local.count;
    resetAt = local.resetAt;
  }

  if (count > maxRequests) {
    const retryAfterSeconds = Math.max(1, Math.ceil((resetAt - now) / 1000));
    return new Response(
      JSON.stringify({ error: 'Too many requests', retryAfter: retryAfterSeconds }),
      {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'X-RateLimit-Limit': String(maxRequests),
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': new Date(resetAt).toISOString(),
          'Retry-After': String(retryAfterSeconds),
        },
      }
    );
  }
  return null;
}

export function rateLimit(options: RateLimitOptions = {}) {
  const windowMs = options.windowMs || DEFAULT_WINDOW_MS;
  const maxRequests = options.maxRequests || DEFAULT_MAX_REQUESTS;
  const keyGenerator = options.keyGenerator || ipKeyGenerator;
  const scope = String(options.scope || 'default').trim() || 'default';

  return async function rateLimitMiddleware(
    request: Request,
    next: (request: Request) => Promise<Response>
  ): Promise<Response> {
    const key = keyGenerator(request);
    const now = Date.now();
    let count = 0;
    let resetAt = now + windowMs;

    const hasRedisBackend = isUpstashConfigured();
    const hasSupabaseBackend = isSupabaseRateLimitConfigured();
    if (hasRedisBackend || hasSupabaseBackend) {
      try {
        const counterKey = `morpheus:web-rate-limit:${scope}:${windowMs}:${key}`;
        const shared = hasRedisBackend
          ? await import('./upstash').then(({ incrementFixedWindowCounter }) =>
              incrementFixedWindowCounter(counterKey, windowMs)
            )
          : await import('./supabase-rate-limit').then(({ incrementSupabaseFixedWindowCounter }) =>
              incrementSupabaseFixedWindowCounter(counterKey, windowMs)
            );
        count = shared.current;
        resetAt = now + Math.max(shared.ttlMs, 0);
      } catch {
        // A process-local counter cannot enforce a distributed production
        // limit. Fail closed while the configured shared backend is unavailable.
        if (isProduction()) {
          return rateLimitBackendUnavailableResponse();
        }
        const local = incrementLocalCounter(key, windowMs, now);
        count = local.count;
        resetAt = local.resetAt;
      }
    } else {
      requireDistributedBackendInProduction();
      const local = incrementLocalCounter(key, windowMs, now);
      count = local.count;
      resetAt = local.resetAt;
    }

    const remaining = Math.max(0, maxRequests - count);
    const resetTime = new Date(resetAt).toISOString();

    if (count > maxRequests) {
      const retryAfterSeconds = Math.max(1, Math.ceil((resetAt - now) / 1000));
      return new Response(
        JSON.stringify({
          error: 'Too many requests',
          retryAfter: retryAfterSeconds,
        }),
        {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'X-RateLimit-Limit': String(maxRequests),
            'X-RateLimit-Remaining': '0',
            'X-RateLimit-Reset': resetTime,
            'Retry-After': String(retryAfterSeconds),
          },
        }
      );
    }

    const response = await next(request);
    const newHeaders = new Headers(response.headers);
    newHeaders.set('X-RateLimit-Limit', String(maxRequests));
    newHeaders.set('X-RateLimit-Remaining', String(remaining));
    newHeaders.set('X-RateLimit-Reset', resetTime);

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders,
    });
  };
}

export function createRateLimitedHandler(
  handler: (request: Request) => Promise<Response>,
  options: RateLimitOptions = {}
) {
  const limiter = rateLimit(options);
  return async function limitedHandler(request: Request): Promise<Response> {
    return limiter(request, () => handler(request));
  };
}

export function resetRateLimitMap(): void {
  rateLimitMap = new Map<string, RateLimitRecord>();
}
