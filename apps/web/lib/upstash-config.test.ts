import { describe, expect, it } from 'vitest';
import { isUpstashRedisConfigured, resolveUpstashRedisConfig } from './upstash-config';

describe('upstash configuration', () => {
  it('prefers the native Upstash credential pair', () => {
    expect(
      resolveUpstashRedisConfig({
        UPSTASH_REDIS_REST_URL: ' https://native.example.com/// ',
        UPSTASH_REDIS_REST_TOKEN: ' native-token ',
        KV_REST_API_URL: 'https://marketplace.example.com',
        KV_REST_API_TOKEN: 'marketplace-token',
      })
    ).toEqual({
      url: 'https://native.example.com',
      token: 'native-token',
      source: 'upstash',
    });
  });

  it('supports the Vercel Marketplace credential pair', () => {
    expect(
      resolveUpstashRedisConfig({
        KV_REST_API_URL: 'https://marketplace.example.com/',
        KV_REST_API_TOKEN: 'marketplace-token',
      })
    ).toEqual({
      url: 'https://marketplace.example.com',
      token: 'marketplace-token',
      source: 'vercel-kv',
    });
  });

  it('does not combine credentials from different pairs', () => {
    const environment = {
      UPSTASH_REDIS_REST_URL: 'https://native.example.com',
      KV_REST_API_TOKEN: 'marketplace-token',
    };
    expect(resolveUpstashRedisConfig(environment)).toBeNull();
    expect(isUpstashRedisConfigured(environment)).toBe(false);
  });

  it('falls back to a complete Marketplace pair when the native pair is incomplete', () => {
    expect(
      resolveUpstashRedisConfig({
        UPSTASH_REDIS_REST_URL: 'https://native.example.com',
        KV_REST_API_URL: 'https://marketplace.example.com',
        KV_REST_API_TOKEN: 'marketplace-token',
      })?.source
    ).toBe('vercel-kv');
  });
});
