import { Pool } from 'pg';
import promClient, { Counter, Gauge, Histogram } from 'prom-client';

const metricRegistry = new promClient.Registry();

// Query performance metrics
export const queryDurationHistogram = new Histogram({
  name: 'neoswap_analytics_query_duration_seconds',
  help: 'Database query duration in seconds',
  labelNames: ['query_type'] as const,
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0],
  registers: [metricRegistry],
});

// Cache metrics
export const cacheHitGauge = new Gauge({
  name: 'neoswap_analytics_cache_hits_total',
  help: 'Analytics cache hits',
  labelNames: ['cache_key'] as const,
  registers: [metricRegistry],
});

export const cacheMissGauge = new Gauge({
  name: 'neoswap_analytics_cache_misses_total',
  help: 'Analytics cache misses',
  labelNames: ['cache_key'] as const,
  registers: [metricRegistry],
});

// Export metrics
export const exportCounter = new Counter({
  name: 'neoswap_analytics_exports_total',
  help: 'Total exports generated',
  labelNames: ['format', 'data_type'] as const,
  registers: [metricRegistry],
});

// Database health
export const databaseConnectionsGauge = new Gauge({
  name: 'neoswap_analytics_db_connections_active',
  help: 'Active database connections',
  labelNames: [],
  registers: [metricRegistry],
});

// Create PostgreSQL connection pool
export function createPostgresPool(connectionString: string): Pool {
  return new Pool({
    connectionString,
    max: 20, // Maximum pool size
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
  });
}

// Metrics endpoint
export async function getMetrics(): Promise<string> {
  return await metricRegistry.metrics();
}
