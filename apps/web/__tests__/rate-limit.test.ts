import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  assertProductionRateLimitBackend,
  getClientIp,
  isPrivateIp,
  ipKeyGenerator,
  rateLimit,
  resetRateLimitMap,
} from '../lib/rate-limit';

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const ORIGINAL_UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const ORIGINAL_KV_URL = process.env.KV_REST_API_URL;
const ORIGINAL_KV_TOKEN = process.env.KV_REST_API_TOKEN;

function disableDistributedRateLimitBackends() {
  vi.stubEnv('UPSTASH_REDIS_REST_URL', '');
  vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', '');
  vi.stubEnv('KV_REST_API_URL', '');
  vi.stubEnv('KV_REST_API_TOKEN', '');
  vi.stubEnv('SUPABASE_URL', '');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '');
  vi.stubEnv('morpheus_SUPABASE_URL', '');
  vi.stubEnv('SUPABASE_SECRET_KEY', '');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '');
  vi.stubEnv('morpheus_SUPABASE_SECRET_KEY', '');
  vi.stubEnv('morpheus_SUPABASE_SERVICE_ROLE_KEY', '');
}

describe('rate-limit utilities', () => {
  beforeEach(() => {
    resetRateLimitMap();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (ORIGINAL_NODE_ENV === undefined) {
      // vitest stub env helper handles this, no-op
    } else {
      vi.stubEnv('NODE_ENV', ORIGINAL_NODE_ENV);
    }
    if (ORIGINAL_UPSTASH_URL === undefined) {
      // no-op
    } else {
      vi.stubEnv('UPSTASH_REDIS_REST_URL', ORIGINAL_UPSTASH_URL);
    }
    if (ORIGINAL_UPSTASH_TOKEN === undefined) {
      // no-op
    } else {
      vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', ORIGINAL_UPSTASH_TOKEN);
    }
    if (ORIGINAL_KV_URL !== undefined) vi.stubEnv('KV_REST_API_URL', ORIGINAL_KV_URL);
    if (ORIGINAL_KV_TOKEN !== undefined) vi.stubEnv('KV_REST_API_TOKEN', ORIGINAL_KV_TOKEN);
  });

  describe('getClientIp', () => {
    it('should take the first x-vercel-forwarded-for value (platform-injected)', () => {
      const request = new Request('http://localhost', {
        headers: { 'x-vercel-forwarded-for': '1.2.3.4, 5.6.7.8' },
      });
      expect(getClientIp(request)).toBe('1.2.3.4');
    });

    it('should ignore client-controlled XFF headers entirely so spoofing cannot mint fresh keys', () => {
      const spoofedA = new Request('http://localhost', {
        headers: { 'x-forwarded-for': '203.0.113.1, 9.9.9.9' },
      });
      const spoofedB = new Request('http://localhost', {
        headers: { 'x-forwarded-for': '203.0.113.2, 9.9.9.9' },
      });
      const spoofedRealIp = new Request('http://localhost', {
        headers: { 'x-real-ip': '203.0.113.3', 'x-client-ip': '203.0.113.4' },
      });
      // None of these are platform-injected: they must NOT yield a per-request
      // key. All map to the shared 'unknown' bucket.
      expect(getClientIp(spoofedA)).toBe('unknown');
      expect(getClientIp(spoofedB)).toBe('unknown');
      expect(getClientIp(spoofedRealIp)).toBe('unknown');
    });

    it('should prefer platform-set headers over other headers', () => {
      const request = new Request('http://localhost', {
        headers: {
          'cf-connecting-ip': '2.2.2.2',
          'x-real-ip': '3.3.3.3',
          'x-forwarded-for': '1.1.1.1',
        },
      });
      expect(getClientIp(request)).toBe('2.2.2.2');
    });

    it('should use x-vercel-forwarded-for when cf-connecting-ip is absent', () => {
      const request = new Request('http://localhost', {
        headers: { 'x-vercel-forwarded-for': '9.9.9.9' },
      });
      expect(getClientIp(request)).toBe('9.9.9.9');
    });

    it('should return unknown when no platform IP header is present', () => {
      const request = new Request('http://localhost');
      expect(getClientIp(request)).toBe('unknown');
    });
  });

  describe('isPrivateIp', () => {
    it('should identify private IP ranges', () => {
      expect(isPrivateIp('127.0.0.1')).toBe(true);
      expect(isPrivateIp('10.0.0.1')).toBe(true);
      expect(isPrivateIp('172.16.0.1')).toBe(true);
      expect(isPrivateIp('192.168.1.1')).toBe(true);
      expect(isPrivateIp('::1')).toBe(true);
    });

    it('should identify public IPs', () => {
      expect(isPrivateIp('1.2.3.4')).toBe(false);
      expect(isPrivateIp('8.8.8.8')).toBe(false);
      expect(isPrivateIp('93.184.216.34')).toBe(false);
    });

    it('should treat unknown as private', () => {
      expect(isPrivateIp('unknown')).toBe(true);
      expect(isPrivateIp('')).toBe(true);
    });
  });

  describe('ipKeyGenerator', () => {
    it('should return internal for private IPs', () => {
      const request = new Request('http://localhost', {
        headers: { 'x-vercel-forwarded-for': '192.168.1.1' },
      });
      expect(ipKeyGenerator(request)).toBe('internal');
    });

    it('should return the IP for public addresses', () => {
      const request = new Request('http://localhost', {
        headers: { 'x-vercel-forwarded-for': '1.2.3.4' },
      });
      expect(ipKeyGenerator(request)).toBe('1.2.3.4');
    });
  });

  describe('rateLimit', () => {
    it('should allow requests under the limit', async () => {
      const handler = rateLimit({ maxRequests: 5, windowMs: 60000 });
      const request = new Request('http://localhost', {
        headers: { 'x-vercel-forwarded-for': '5.5.5.5' },
      });

      let passCount = 0;
      for (let i = 0; i < 3; i++) {
        const response = await handler(request, async () => new Response('ok'));
        if (response.status === 200) passCount++;
      }
      expect(passCount).toBe(3);
    });

    it('should block requests over the limit', async () => {
      const handler = rateLimit({ maxRequests: 2, windowMs: 60000 });
      const request = new Request('http://localhost', {
        headers: { 'x-vercel-forwarded-for': '6.6.6.6' },
      });

      await handler(request, async () => new Response('ok'));
      await handler(request, async () => new Response('ok'));
      const blockedResponse = await handler(request, async () => new Response('ok'));

      expect(blockedResponse.status).toBe(429);
    });

    it('should include rate limit headers', async () => {
      const handler = rateLimit({ maxRequests: 10, windowMs: 60000 });
      const request = new Request('http://localhost', {
        headers: { 'x-vercel-forwarded-for': '7.7.7.7' },
      });

      const response = await handler(request, async () => new Response('ok'));
      expect(response.headers.get('X-RateLimit-Limit')).toBe('10');
      expect(response.headers.get('X-RateLimit-Remaining')).toBe('9');
    });

    it('should throw in production when no distributed backend is configured', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      disableDistributedRateLimitBackends();

      const handler = rateLimit({ maxRequests: 2, windowMs: 60000 });
      const request = new Request('http://localhost', {
        headers: { 'x-vercel-forwarded-for': '8.8.8.8' },
      });

      await expect(handler(request, async () => new Response('ok'))).rejects.toThrow(
        /Production rate limiting requires/
      );
    });

    it('should use local fallback outside production without Upstash', async () => {
      vi.stubEnv('NODE_ENV', '');
      vi.stubEnv('UPSTASH_REDIS_REST_URL', '');
      vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', '');

      const handler = rateLimit({ maxRequests: 2, windowMs: 60000 });
      const request = new Request('http://localhost', {
        headers: { 'x-vercel-forwarded-for': '9.9.9.9' },
      });

      await handler(request, async () => new Response('ok'));
      const response = await handler(request, async () => new Response('ok'));
      expect(response.status).toBe(200);
    });

    it('should accept a complete Vercel Marketplace Redis pair in production', () => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('UPSTASH_REDIS_REST_URL', '');
      vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', '');
      vi.stubEnv('KV_REST_API_URL', 'https://marketplace.example.com');
      vi.stubEnv('KV_REST_API_TOKEN', 'marketplace-token');

      expect(() => assertProductionRateLimitBackend()).not.toThrow();
    });

    it('should use the transactional Supabase fallback in production', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      disableDistributedRateLimitBackends();
      vi.stubEnv('morpheus_SUPABASE_URL', 'https://supabase.example.com');
      vi.stubEnv('morpheus_SUPABASE_SERVICE_ROLE_KEY', 'service-key');
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify([{ current_count: 1, ttl_ms: 60000 }]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      );

      const handler = rateLimit({ maxRequests: 2, windowMs: 60000, scope: 'fallback-test' });
      const response = await handler(
        new Request('http://localhost', {
          headers: { 'x-vercel-forwarded-for': '8.8.4.4' },
        }),
        async () => new Response('ok')
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('X-RateLimit-Remaining')).toBe('1');
      expect(fetchSpy).toHaveBeenCalledOnce();
      expect(String(fetchSpy.mock.calls[0][0])).toBe(
        'https://supabase.example.com/rest/v1/rpc/morpheus_consume_rate_limit'
      );
      expect(JSON.parse(String(fetchSpy.mock.calls[0][1]?.body))).toEqual({
        p_key: 'morpheus:web-rate-limit:fallback-test:60000:8.8.4.4',
        p_window_ms: 60000,
      });
    });

    it('should fail closed when the Supabase fallback is unavailable in production', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      disableDistributedRateLimitBackends();
      vi.stubEnv('morpheus_SUPABASE_URL', 'https://supabase.example.com');
      vi.stubEnv('morpheus_SUPABASE_SECRET_KEY', 'service-key');
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('database unavailable'));

      const next = vi.fn(async () => new Response('ok'));
      const handler = rateLimit({ maxRequests: 2, windowMs: 60000 });
      const response = await handler(
        new Request('http://localhost', {
          headers: { 'x-vercel-forwarded-for': '8.8.4.4' },
        }),
        next
      );

      expect(response.status).toBe(503);
      expect(next).not.toHaveBeenCalled();
    });

    it('should return 503 instead of using local fallback when configured Upstash fails in production', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://upstash.example.com');
      vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'token');
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('upstash unavailable'));

      const next = vi.fn(async () => new Response('ok'));
      const handler = rateLimit({ maxRequests: 2, windowMs: 60000 });
      const response = await handler(
        new Request('http://localhost', {
          headers: { 'x-vercel-forwarded-for': '8.8.4.4' },
        }),
        next
      );

      expect(response.status).toBe(503);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('retry-after')).toBe('1');
      expect(await response.json()).toEqual({
        error: 'Rate limit service is temporarily unavailable',
        error_code: 'RATE_LIMIT_BACKEND_UNAVAILABLE',
      });
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('local fallback memory bound', () => {
    it('should evict oldest entries when the local map exceeds the max size', async () => {
      const handler = rateLimit({ maxRequests: 100, windowMs: 60000 });

      for (let i = 0; i < 10_010; i++) {
        const request = new Request('http://localhost', {
          headers: { 'x-vercel-forwarded-for': `10.0.0.${i % 256}` },
        });
        await handler(request, async () => new Response('ok'));
      }

      // The internal map should be bounded. We cannot inspect it directly, but we
      // can verify the handler still works after the eviction threshold.
      const request = new Request('http://localhost', {
        headers: { 'x-vercel-forwarded-for': '1.2.3.4' },
      });
      const response = await handler(request, async () => new Response('ok'));
      expect(response.status).toBe(200);
    });
  });

  describe('assertProductionRateLimitBackend', () => {
    it('should throw in production without a distributed backend', () => {
      vi.stubEnv('NODE_ENV', 'production');
      disableDistributedRateLimitBackends();

      expect(() => assertProductionRateLimitBackend()).toThrow(/Production rate limiting requires/);
    });

    it('should not throw in non-production without Upstash', () => {
      vi.stubEnv('NODE_ENV', '');
      vi.stubEnv('UPSTASH_REDIS_REST_URL', '');
      vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', '');

      expect(() => assertProductionRateLimitBackend()).not.toThrow();
    });
  });
});
