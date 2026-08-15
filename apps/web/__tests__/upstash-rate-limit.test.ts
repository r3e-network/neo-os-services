import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rateLimit, resetRateLimitMap } from '../lib/rate-limit';

describe('upstash-backed rate limits', () => {
  const originalFetch = global.fetch;
  const originalUrl = process.env.UPSTASH_REDIS_REST_URL;
  const originalToken = process.env.UPSTASH_REDIS_REST_TOKEN;

  beforeEach(() => {
    resetRateLimitMap();
    process.env.UPSTASH_REDIS_REST_URL = 'https://upstash.example.com';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = originalUrl;
    if (originalToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = originalToken;
  });

  it('uses Upstash when configured and allows requests under the shared limit', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ result: [{ result: 1 }, { result: 60000 }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const handler = rateLimit({ maxRequests: 2, windowMs: 60000, scope: 'oracle_query' });
    const response = await handler(
      new Request('http://localhost', { headers: { 'x-forwarded-for': '1.2.3.4' } }),
      async () => new Response('ok')
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(response.headers.get('X-RateLimit-Remaining')).toBe('1');
  });

  it('blocks requests when the shared Upstash counter exceeds the limit', async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ result: [{ result: 3 }, { result: 42000 }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    ) as unknown as typeof fetch;

    const handler = rateLimit({ maxRequests: 2, windowMs: 60000, scope: 'compute_execute' });
    const response = await handler(
      new Request('http://localhost', { headers: { 'x-forwarded-for': '1.2.3.4' } }),
      async () => new Response('ok')
    );

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('42');
  });
});
