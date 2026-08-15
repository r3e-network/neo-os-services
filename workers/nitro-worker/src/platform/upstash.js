import { randomUUID } from 'node:crypto';

import { env, parseDurationMs, stableStringify, trimString } from './core.js';

function resolveConfig() {
  const url = trimString(env('UPSTASH_REDIS_REST_URL')).replace(/\/$/, '');
  const token = trimString(env('UPSTASH_REDIS_REST_TOKEN'));
  return {
    enabled: Boolean(url && token),
    url,
    token,
    failClosed: trimString(env('MORPHEUS_UPSTASH_FAIL_CLOSED')).toLowerCase() === 'true',
    defaultTtlMs: parseDurationMs(env('MORPHEUS_UPSTASH_DEFAULT_TTL_MS') || '5m', 5 * 60_000),
  };
}

async function upstashRequest(pathname, { method = 'GET', body = null } = {}) {
  const config = resolveConfig();
  if (!config.enabled) return null;

  const response = await fetch(`${config.url}${pathname}`, {
    method,
    headers: {
      authorization: `Bearer ${config.token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(10_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      payload?.error || payload?.message || `upstash request failed (${response.status})`
    );
  }
  return payload;
}

function parsePipelineResult(entry) {
  if (!entry || typeof entry !== 'object') return null;
  return entry.result ?? null;
}

async function safeUpstash(operation, fallback) {
  const config = resolveConfig();
  if (!config.enabled) return fallback;
  try {
    return await operation();
  } catch (error) {
    if (config.failClosed) throw error;
    return fallback;
  }
}

export function isUpstashEnabled() {
  return resolveConfig().enabled;
}

export async function upstashPipeline(commands = []) {
  return safeUpstash(async () => {
    const payload = await upstashRequest('/pipeline', {
      method: 'POST',
      body: commands,
    });
    return Array.isArray(payload) ? payload : [];
  }, []);
}

export async function upstashGetString(key) {
  return safeUpstash(async () => {
    const payload = await upstashRequest(`/get/${encodeURIComponent(key)}`);
    return payload?.result ?? null;
  }, null);
}

export async function upstashSetString(key, value, { ttlMs = 0, nx = false } = {}) {
  return safeUpstash(async () => {
    const command = ['SET', key, String(value)];
    if (nx) command.push('NX');
    if (ttlMs > 0) command.push('PX', String(ttlMs));
    const [result] = await upstashPipeline([command]);
    return parsePipelineResult(result);
  }, null);
}

export async function upstashDelete(key) {
  return safeUpstash(async () => {
    const [result] = await upstashPipeline([['DEL', key]]);
    return Number(parsePipelineResult(result) || 0);
  }, 0);
}

export async function upstashGetJson(key) {
  const value = await upstashGetString(key);
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export async function upstashSetJson(key, value, { ttlMs = 0, nx = false } = {}) {
  const resolvedTtlMs = ttlMs > 0 ? ttlMs : resolveConfig().defaultTtlMs;
  return upstashSetString(key, stableStringify(value), { ttlMs: resolvedTtlMs, nx });
}

export async function incrementFixedWindowCounter(key, { max, windowMs }) {
  const fallback = {
    allowed: true,
    remaining: Math.max(Number(max || 1) - 1, 0),
    count: 1,
    retryAfter: 0,
    source: 'disabled',
  };

  return safeUpstash(async () => {
    const [incrEntry, ttlEntry] = await upstashPipeline([
      ['INCR', key],
      ['PTTL', key],
    ]);
    const count = Number(parsePipelineResult(incrEntry) || 0);
    let ttl = Number(parsePipelineResult(ttlEntry) || -1);
    if (count <= 1 || ttl < 0) {
      await upstashPipeline([['PEXPIRE', key, String(windowMs)]]);
      ttl = windowMs;
    }

    const allowed = count <= max;
    return {
      allowed,
      remaining: allowed ? Math.max(max - count, 0) : 0,
      count,
      retryAfter: allowed ? 0 : Math.max(Math.ceil(ttl / 1000), 1),
      source: 'upstash',
    };
  }, fallback);
}

export async function claimIdempotencyLock(key, ttlMs) {
  const ownerToken = randomUUID();
  const result = await upstashSetString(key, ownerToken, { ttlMs, nx: true });
  return result === 'OK' ? ownerToken : '';
}

export async function releaseIdempotencyLock(key, ownerToken) {
  if (!trimString(key) || !trimString(ownerToken)) return false;
  const script = [
    "if redis.call('GET', KEYS[1]) == ARGV[1] then",
    "  return redis.call('DEL', KEYS[1])",
    'end',
    'return 0',
  ].join('\n');
  return safeUpstash(async () => {
    const [result] = await upstashPipeline([['EVAL', script, '1', key, ownerToken]]);
    return Number(parsePipelineResult(result) || 0) === 1;
  }, false);
}
