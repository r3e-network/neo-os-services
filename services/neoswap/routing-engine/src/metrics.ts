import { Redis } from 'redis';
import promClient, { Counter, Gauge, Histogram } from 'prom-client';

// Register metrics
export const metricRegistry = new promClient.Registry();
metricClient.register.setDefaultMetrics({ register: metricRegistry });

// Request metrics
export const requestCounter = new Counter({
  name: 'neoswap_routing_requests_total',
  help: 'Total routing requests',
  labelNames: ['status', 'token_pair'] as const,
  registers: [metricRegistry],
});

export const latencyHistogram = new Histogram({
  name: 'neoswap_routing_latency_seconds',
  help: 'Routing latency in seconds',
  labelNames: ['step'] as const,
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0],
  registers: [metricRegistry],
});

// Pool metrics
export const poolLiquidityGauge = new Gauge({
  name: 'neoswap_pool_liquidity_usd',
  help: 'Current pool liquidity in USD',
  labelNames: ['pool_id', 'token_a', 'token_b'] as const,
  registers: [metricRegistry],
});

export const volumeHistogram = new Histogram({
  name: 'neoswap_pool_volume_24h_usd',
  help: '24h trading volume in USD',
  labelNames: ['pool_id'] as const,
  buckets: [100, 1000, 10000, 100000, 1000000, 10000000],
  registers: [metricRegistry],
});

// MEV metrics
export const mevDetectionsCounter = new Counter({
  name: 'neoswap_mev_detections_total',
  help: 'Total MEV patterns detected',
  labelNames: ['risk_level', 'pattern_type'] as const,
  registers: [metricRegistry],
});

export const frontRunProtectionGauge = new Gauge({
  name: 'neoswap_front_run_protection_success_rate',
  help: 'Front-run protection success rate',
  labelNames: [],
  registers: [metricRegistry],
});

// Redis client factory
export function createRedisClient(url: string): Redis {
  return Redis.createClient({ url });
}

// TTL configuration for caching
export const CACHE_TTL = {
  ROUTES: 10, // 10 seconds
  POOLS: 300, // 5 minutes
  TOKENS: 600, // 10 minutes
};

// Initialize metrics endpoint handler
export async function getMetrics(): Promise<string> {
  return await metricRegistry.metrics();
}
