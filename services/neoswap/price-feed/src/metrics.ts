import promClient, { Gauge, Histogram, Counter } from 'prom-client';

const metricRegistry = new promClient.Registry();
metricRegistry.setDefaultMetrics({ register: metricRegistry });

// Connection metrics
export const activeConnectionsGauge = new Gauge({
  name: 'neoswap_price_feed_active_connections',
  help: 'Current number of active connections',
  labelNames: [],
  registers: [metricRegistry],
});

export const connectionCountCounter = new Counter({
  name: 'neoswap_price_feed_connections_total',
  help: 'Total connection count',
  labelNames: ['status'] as const,
  registers: [metricRegistry],
});

// Performance metrics
export const latencyHistogram = new Histogram({
  name: 'neoswap_price_feed_latency_seconds',
  help: 'Message processing latency in seconds',
  labelNames: ['operation'] as const,
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1], // P99 < 50ms target
  registers: [metricRegistry],
});

// Throughput metrics
export const messageThroughputCounter = new Counter({
  name: 'neoswap_price_feed_messages_total',
  help: 'Total messages sent',
  labelNames: ['type'] as const,
  registers: [metricRegistry],
});

// Backpressure metrics
export const backpressureQueueSizeGauge = new Gauge({
  name: 'neoswap_price_feed_queue_size',
  help: 'Current message queue size for backpressure handling',
  labelNames: [],
  registers: [metricRegistry],
});

// Redis client factory
export function createRedisClient(url: string): any {
  const { createClient } = require('ioredis');
  return createClient({ url });
}

// Metrics endpoint
export async function getMetrics(): Promise<string> {
  return await metricRegistry.metrics();
}
