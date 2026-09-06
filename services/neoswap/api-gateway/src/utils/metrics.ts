import { createClient } from 'redis';
import promClient, { Counter, Histogram, Gauge } from 'prom-client';

const metricRegistry = new promClient.Registry();

// Request metrics
export const requestCounter = new Counter({
  name: 'neoswap_api_requests_total',
  help: 'Total API requests',
  labelNames: ['method', 'endpoint', 'status_code'] as const,
  registers: [metricRegistry],
});

export const latencyHistogram = new Histogram({
  name: 'neoswap_api_request_duration_seconds',
  help: 'API request latency',
  labelNames: ['endpoint'] as const,
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0],
  registers: [metricRegistry],
});

export const cacheHitRateGauge = new Gauge({
  name: 'neoswap_cache_hit_rate',
  help: 'Cache hit rate percentage',
  labelNames: ['cache_type'] as const,
  registers: [metricRegistry],
});

export const concurrentConnectionsGauge = new Gauge({
  name: 'neoswap_api_concurrent_connections',
  help: 'Active WebSocket connections',
  labelNames: [],
  registers: [metricRegistry],
});

// Create Redis client
export async function createRedisClient(redisUrl: string) {
  return createClient({ url: redisUrl });
}

// Cache configuration
export const CACHE_CONFIG = {
  ROUTE_CACHE_TTL: 10, // 10 seconds for routes
  POOL_INFO_TTL: 300, // 5 minutes for pool info
  RATE_LIMIT_WINDOW_MS: 60 * 1000, // 1 minute window
};

// Tenant isolation configuration
export const TENANT_CONFIG = {
  rateLimits: {
    free: { maxRequests: 100, windowMs: 60 * 1000 },
    standard: { maxRequests: 1000, windowMs: 60 * 1000 },
    premium: { maxRequests: 10000, windowMs: 60 * 1000 },
  },
};

export async function getMetrics(): Promise<string> {
  return await metricRegistry.metrics();
}
