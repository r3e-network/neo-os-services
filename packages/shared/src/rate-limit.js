/**
 * Upstash Redis REST API rate limiting factory
 * Provides a flexible rate limiting interface using Upstash Redis
 */

/**
 * Apply Upstash rate limiting using a fixed-window counter algorithm
 *
 * @param {Object} env - Environment object with UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN
 * @param {string} key - Rate limit key (e.g., "morpheus:ratelimit:route:ip")
 * @param {Object} config - Rate limit configuration
 * @param {number} config.max - Maximum requests allowed within the window
 * @param {number} config.windowMs - Window duration in milliseconds
 * @returns {Promise<Object|null>} Returns rate limit result or null if Upstash is not configured
 */
export async function applyUpstashRateLimit(env, key, { max, windowMs }) {
  const redisUrl = String(env.UPSTASH_REDIS_REST_URL || '').trim();
  const redisToken = String(env.UPSTASH_REDIS_REST_TOKEN || '').trim();

  if (!redisUrl || !redisToken) return null;

  const url = redisUrl.replace(/\/$/, '');
  const response = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${redisToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify([
      ['INCR', key],
      ['PTTL', key],
    ]),
  });

  if (!response.ok) {
    throw new Error(`upstash pipeline failed (${response.status})`);
  }

  const result = await response.json();
  const count = Number(result?.[0]?.result || 0);
  let ttl = Number(result?.[1]?.result || -1);

  if (count <= 1 || ttl < 0) {
    await fetch(`${url}/pipeline`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${redisToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify([['PEXPIRE', key, String(windowMs)]]),
    });
    ttl = windowMs;
  }

  if (count <= max) return null;

  return {
    allowed: false,
    count,
    remaining: 0,
    retryAfter: Math.max(Math.ceil(ttl / 1000), 1),
  };
}
