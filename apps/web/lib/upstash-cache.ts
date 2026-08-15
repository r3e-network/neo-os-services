import { Redis } from '@upstash/redis';
import { resolveUpstashRedisConfig } from './upstash-config';

/**
 * Cache entry stored by the in-memory fallback backend.
 */
type MemoryCacheEntry<T> = {
  value: T;
  expiresAt: number;
};

/**
 * Generic cache backend contract. Both the Upstash Redis and the in-memory
 * fallback implement this interface so callers can switch transparently.
 */
interface CacheBackend<T> {
  get(key: string): Promise<T | undefined>;
  set(key: string, value: T, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): void;
}

/**
 * Returns true when either a complete native Upstash pair or a complete Vercel
 * Marketplace KV REST pair is configured, enabling the Redis-backed cache.
 */
export function isRedisCacheConfigured(): boolean {
  return Boolean(resolveUpstashRedisConfig());
}

let sharedRedisClient: Redis | null = null;

function getSharedRedisClient(): Redis | null {
  const config = resolveUpstashRedisConfig();
  if (!config) return null;
  if (!sharedRedisClient) {
    sharedRedisClient = new Redis({ url: config.url, token: config.token });
  }
  return sharedRedisClient;
}

/**
 * In-memory cache backend with TTL sweep on read. This is the fallback when
 * Upstash Redis is not configured. It is process-local and therefore not shared
 * across serverless instances, which is acceptable for development and for the
 * existing Supabase lookup caches.
 */
class MemoryCacheBackend<T> implements CacheBackend<T> {
  private store = new Map<string, MemoryCacheEntry<T>>();

  async get(key: string): Promise<T | undefined> {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  async set(key: string, value: T, ttlSeconds: number): Promise<void> {
    const ttlMs = Math.max(Math.trunc(ttlSeconds), 0) * 1000;
    this.store.set(key, {
      value,
      expiresAt: Date.now() + ttlMs,
    });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }
}

/**
 * Upstash Redis cache backend. Values are JSON-serialized by the Upstash client
 * and TTL is enforced with Redis `EX` (expire in seconds).
 */
class UpstashCacheBackend<T> implements CacheBackend<T> {
  constructor(private readonly redis: Redis) {}

  async get(key: string): Promise<T | undefined> {
    const value = await this.redis.get<T>(key);
    if (value === null || value === undefined) return undefined;
    return value;
  }

  async set(key: string, value: T, ttlSeconds: number): Promise<void> {
    const ttl = Math.max(Math.trunc(ttlSeconds), 0);
    if (ttl <= 0) {
      await this.redis.set(key, value);
      return;
    }
    await this.redis.set(key, value, { ex: ttl });
  }

  async delete(key: string): Promise<void> {
    await this.redis.del(key);
  }

  clear(): void {
    // Redis is a shared remote store; clearing it on the backend would affect
    // every running instance, so this is intentionally a no-op for the shared
    // backend. Test reset should target individual keys.
  }
}

const memoryBackends = new Map<string, MemoryCacheBackend<unknown>>();

function getBackend(namespace: string): CacheBackend<unknown> {
  const redis = getSharedRedisClient();
  if (redis) {
    return new UpstashCacheBackend(redis);
  }

  let backend = memoryBackends.get(namespace);
  if (!backend) {
    backend = new MemoryCacheBackend<unknown>();
    memoryBackends.set(namespace, backend);
  }
  return backend;
}

function buildKey(namespace: string, key: string): string {
  return `${namespace}:${key}`;
}

/**
 * Read a value from the cache. When Upstash Redis is configured the request is
 * served from Redis; otherwise the in-memory fallback is used with TTL sweep.
 */
export async function getCache<T>(key: string, namespace = 'morpheus'): Promise<T | undefined> {
  const backend = getBackend(namespace);
  return (await backend.get(buildKey(namespace, key))) as T | undefined;
}

/**
 * Write a value to the cache with a TTL in seconds. When Upstash Redis is
 * configured the value is stored in Redis with `EX`; otherwise it is stored in
 * the in-memory fallback and expires after `ttlSeconds`.
 */
export async function setCache<T>(
  key: string,
  value: T,
  ttlSeconds: number,
  namespace = 'morpheus'
): Promise<void> {
  const backend = getBackend(namespace);
  await backend.set(buildKey(namespace, key), value, ttlSeconds);
}

/**
 * Remove a single key from the cache.
 */
export async function deleteCache(key: string, namespace = 'morpheus'): Promise<void> {
  const backend = getBackend(namespace);
  await backend.delete(buildKey(namespace, key));
}

/**
 * Test-only: clear all in-memory fallback caches. This does not delete shared
 * Redis keys; use `deleteCache` or flush the Redis database independently.
 */
export function __resetMemoryCaches(): void {
  for (const backend of memoryBackends.values()) {
    backend.clear();
  }
  memoryBackends.clear();
}

/**
 * Test-only: reset the shared Redis client singleton so tests that toggle env
 * vars see the new configuration.
 */
export function __resetRedisClient(): void {
  sharedRedisClient = null;
}
