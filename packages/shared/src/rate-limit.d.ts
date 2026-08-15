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
