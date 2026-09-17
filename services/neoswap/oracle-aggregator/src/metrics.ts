import { RedisClientType } from 'redis';
import { createClient } from 'redis';
import promClient, { Counter, Gauge, Histogram } from 'prom-client';

const metricRegistry = new promClient.Registry();
promClient.collectDefaultMetrics({ register: metricRegistry });

// Source health metrics
export const sourceHealthGauge = new Gauge({
  name: 'neoswap_oracle_sources_healthy_total',
  help: 'Number of healthy price sources',
  labelNames: ['source_id'] as const,
  registers: [metricRegistry],
});

export const sourceLatencyHistogram = new Histogram({
  name: 'neoswap_oracle_source_latency_seconds',
  help: 'Price feed latency in seconds',
  labelNames: ['source_id'] as const,
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0],
  registers: [metricRegistry],
});

// Data freshness metrics
export const twapStalenessGauge = new Gauge({
  name: 'neoswap_twap_staleness_seconds',
  help: 'Age of the most recent TWAP update in seconds',
  labelNames: ['token_pair'] as const,
  registers: [metricRegistry],
});

export const subscriptionCountGauge = new Gauge({
  name: 'neoswap_oracle_subscriptions_total',
  help: 'Current WebSocket subscriptions',
  labelNames: ['channel'] as const,
  registers: [metricRegistry],
});

// Create Redis client
export function createRedisClient(redisUrl: string): RedisClientType {
  return createClient({ url: redisUrl });
}

// Cache TTL configuration
export const CACHE_TTL = {
  PRICE_TICKS: 60, // 1 minute for individual ticks
  TWAP_SAMPLES: 300, // 5 minutes for TWAP values
  SOURCE_HEALTH: 30, // 30 seconds for source health
};

// Shutdown handler
export async function shutdownRedis(client: RedisClientType): Promise<void> {
  if (client.isOpen) {
    await client.quit();
  }
}

// Export metrics endpoint
export async function getMetrics(): Promise<string> {
  return await metricRegistry.metrics();
}
