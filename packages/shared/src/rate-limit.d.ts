export type UpstashRateLimitConfig = {
  max: number;
  windowMs: number;
};

export type UpstashRateLimitResult = {
  allowed: boolean;
  count: number;
  remaining: number;
  retryAfter: number;
};

/**
 * Is an Upstash backend configured for this environment? A lane that declares a
 * limit must fail closed when this is false: `applyUpstashRateLimit` returns
 * `null` for both "under the limit" and "no backend", so its return value alone
 * cannot distinguish an enforced allow from an unenforced one.
 */
export function upstashConfigured(env: {
  UPSTASH_REDIS_REST_URL?: string;
  UPSTASH_REDIS_REST_TOKEN?: string;
}): boolean;

/**
 * Apply Upstash rate limiting using a fixed-window counter algorithm.
 * Returns `null` when Upstash is not configured or the request is under the
 * limit; returns a result object describing the rejection when the limit is
 * exceeded.
 */
export function applyUpstashRateLimit(
  env: {
    UPSTASH_REDIS_REST_URL?: string;
    UPSTASH_REDIS_REST_TOKEN?: string;
  },
  key: string,
  config: UpstashRateLimitConfig
): Promise<UpstashRateLimitResult | null>;
