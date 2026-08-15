import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockRedis = {
  get: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
};

vi.mock('@upstash/redis', () => ({
  Redis: vi.fn(function () {
    return mockRedis;
  }),
}));

import {
  deleteCache,
  getCache,
  isRedisCacheConfigured,
  setCache,
  __resetMemoryCaches,
  __resetRedisClient,
} from '../lib/upstash-cache';

const originalUrl = process.env.UPSTASH_REDIS_REST_URL;
const originalToken = process.env.UPSTASH_REDIS_REST_TOKEN;
const originalKvUrl = process.env.KV_REST_API_URL;
const originalKvToken = process.env.KV_REST_API_TOKEN;

describe('upstash-cache', () => {
  beforeEach(() => {
    __resetMemoryCaches();
    __resetRedisClient();
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
    mockRedis.get.mockReset();
    mockRedis.set.mockReset();
    mockRedis.del.mockReset();
  });

  afterEach(() => {
    __resetMemoryCaches();
    __resetRedisClient();
    if (originalUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = originalUrl;
    if (originalToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = originalToken;
    if (originalKvUrl === undefined) delete process.env.KV_REST_API_URL;
    else process.env.KV_REST_API_URL = originalKvUrl;
    if (originalKvToken === undefined) delete process.env.KV_REST_API_TOKEN;
    else process.env.KV_REST_API_TOKEN = originalKvToken;
  });

  describe('configuration detection', () => {
    it('reports Redis as not configured when env vars are absent', () => {
      expect(isRedisCacheConfigured()).toBe(false);
    });

    it('reports Redis as configured when both env vars are present', () => {
      process.env.UPSTASH_REDIS_REST_URL = 'https://upstash.example.com';
      process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
      expect(isRedisCacheConfigured()).toBe(true);
    });

    it('reports Redis as not configured when only the URL is present', () => {
      process.env.UPSTASH_REDIS_REST_URL = 'https://upstash.example.com';
      expect(isRedisCacheConfigured()).toBe(false);
    });

    it('reports Redis as not configured when only the token is present', () => {
      process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
      expect(isRedisCacheConfigured()).toBe(false);
    });

    it('reports Redis as configured with the Vercel Marketplace pair', () => {
      process.env.KV_REST_API_URL = 'https://marketplace.example.com';
      process.env.KV_REST_API_TOKEN = 'marketplace-token';
      expect(isRedisCacheConfigured()).toBe(true);
    });
  });

  describe('in-memory fallback', () => {
    it('returns undefined for a missing key', async () => {
      const value = await getCache('missing', 'test-ns');
      expect(value).toBeUndefined();
    });

    it('stores and retrieves a value', async () => {
      await setCache('key-1', { hello: 'world' }, 60, 'test-ns');
      const value = await getCache<{ hello: string }>('key-1', 'test-ns');
      expect(value).toEqual({ hello: 'world' });
    });

    it('stores and retrieves null as a valid cached value', async () => {
      await setCache('key-null', null, 60, 'test-ns');
      const value = await getCache<null>('key-null', 'test-ns');
      expect(value).toBeNull();
    });

    it('isolates namespaces', async () => {
      await setCache('shared-key', 'a', 60, 'ns-a');
      await setCache('shared-key', 'b', 60, 'ns-b');
      const a = await getCache<string>('shared-key', 'ns-a');
      const b = await getCache<string>('shared-key', 'ns-b');
      expect(a).toBe('a');
      expect(b).toBe('b');
    });

    it('deletes a key', async () => {
      await setCache('delete-me', 'value', 60, 'test-ns');
      expect(await getCache<string>('delete-me', 'test-ns')).toBe('value');
      await deleteCache('delete-me', 'test-ns');
      expect(await getCache<string>('delete-me', 'test-ns')).toBeUndefined();
    });

    it('expires entries after the TTL', async () => {
      await setCache('short', 'value', 1, 'test-ns');
      expect(await getCache<string>('short', 'test-ns')).toBe('value');
      await new Promise((resolve) => setTimeout(resolve, 1100));
      expect(await getCache<string>('short', 'test-ns')).toBeUndefined();
    });

    it('treats a TTL of zero as immediately expired on next read', async () => {
      await setCache('zero', 'value', 0, 'test-ns');
      expect(await getCache<string>('zero', 'test-ns')).toBeUndefined();
    });
  });

  describe('Upstash Redis backend', () => {
    beforeEach(() => {
      process.env.UPSTASH_REDIS_REST_URL = 'https://upstash.example.com';
      process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
    });

    it('uses the Upstash backend when env vars are present', async () => {
      mockRedis.get.mockResolvedValueOnce({ provider_id: 'twelvedata', enabled: true });

      const value = await getCache('testnet:demo:twelvedata', 'morpheus:provider-config');

      expect(mockRedis.get).toHaveBeenCalledWith(
        'morpheus:provider-config:testnet:demo:twelvedata'
      );
      expect(value).toEqual({ provider_id: 'twelvedata', enabled: true });
    });

    it('writes values through the Upstash backend with EX', async () => {
      await setCache('testnet:demo:twelvedata', { enabled: true }, 30, 'morpheus:provider-config');

      expect(mockRedis.set).toHaveBeenCalledWith(
        'morpheus:provider-config:testnet:demo:twelvedata',
        { enabled: true },
        { ex: 30 }
      );
    });

    it('deletes keys through the Upstash backend', async () => {
      await deleteCache('testnet:demo:twelvedata', 'morpheus:provider-config');
      expect(mockRedis.del).toHaveBeenCalledWith(
        'morpheus:provider-config:testnet:demo:twelvedata'
      );
    });

    it('returns undefined when Redis reports a null value', async () => {
      mockRedis.get.mockResolvedValueOnce(null);
      const value = await getCache('missing', 'morpheus:provider-config');
      expect(value).toBeUndefined();
    });
  });
});
