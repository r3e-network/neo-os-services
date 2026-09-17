import { Pool, QueryResult } from 'pg';
import { PnLResult, HistoricalDataPoint, TransactionRecord } from './types';

export class AnalyticsDatabase {
  private pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    });

    // Initialize TimescaleDB hypertables if needed
    this.initializeTimescale();
  }

  private async initializeTimescale(): Promise<void> {
    try {
      const client = await this.pool.connect();

      // Create trades table (TimescaleDB hypertable)
      await client.query(`
        CREATE TABLE IF NOT EXISTS trades (
          id SERIAL PRIMARY KEY,
          timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          user_id TEXT NOT NULL,
          token_in TEXT NOT NULL,
          token_out TEXT NOT NULL,
          amount_in NUMERIC(36,18) NOT NULL,
          amount_out NUMERIC(36,18) NOT NULL,
          fee_amount NUMERIC(36,18) NOT NULL,
          tx_hash TEXT,
          pool_ids TEXT[]
        );
      `);

      // Create TimescaleDB hypertable for time-series optimization
      await client
        .query(
          `
        SELECT create_hypertable('trades', 'timestamp');
      `
        )
        .catch((err) => {
          console.log('TimescaleDB extension may not be installed:', err.message);
        });

      // Add indexes
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_trades_user ON trades(user_id);
        CREATE INDEX IF NOT EXISTS idx_trades_tokens ON trades(token_in, token_out);
        CREATE INDEX IF NOT EXISTS idx_trades_timestamp ON trades(timestamp DESC);
      `);

      client.release();
      console.log('Analytics database initialized successfully');
    } catch (error) {
      console.error('Failed to initialize analytics database:', error);
      throw error;
    }
  }

  /**
   * Query transaction history with pagination
   */
  async getTransactionHistory(
    userId: string,
    limit: number = 50,
    offset: number = 0
  ): Promise<TransactionRecord[]> {
    const startTime = Date.now();

    const result: QueryResult<TransactionRecord> = await this.pool.query(
      `
      SELECT 
        id::text as id,
        EXTRACT(EPOCH FROM timestamp) * 1000 AS timestamp,
        user_id::text as userId,
        token_in::text as tokenIn,
        token_out::text as tokenOut,
        amount_in::text as amountIn,
        amount_out::text as amountOut,
        fee_amount::text as feeAmount,
        tx_hash::text as txHash,
        array_to_json(pool_ids)::text as poolIds
      FROM trades
      WHERE user_id = $1
      ORDER BY timestamp DESC
      LIMIT $2 OFFSET $3
    `,
      [userId, limit, offset]
    );

    const duration = (Date.now() - startTime) / 1000;
    console.log(`Transaction history query took ${duration}s`);

    return result.rows;
  }

  /**
   * Calculate PnL for a specific user
   */
  async calculatePnL(userId: string, startDate?: number, endDate?: number): Promise<PnLResult> {
    const filters = ['user_id = $1'];
    const params: Array<string | number> = [userId];
    if (startDate !== undefined) {
      params.push(startDate);
      filters.push(`timestamp >= TO_TIMESTAMP($${params.length} / 1000.0)`);
    }
    if (endDate !== undefined) {
      params.push(endDate);
      filters.push(`timestamp <= TO_TIMESTAMP($${params.length} / 1000.0)`);
    }

    // Derive only from the immutable trades table. There is no position or
    // slippage ledger in this service's schema, so unsupported PnL fields stay
    // explicitly zero instead of returning fabricated values.
    const ledgerQuery = await this.pool.query(
      `
      SELECT
        COALESCE(SUM(amount_in), 0)::text AS total_volume,
        COALESCE(SUM(fee_amount), 0)::text AS total_fees,
        COALESCE(SUM(amount_out) / NULLIF(SUM(amount_in), 0), 0)::text AS average_execution_price
      FROM trades
      WHERE ${filters.join(' AND ')}
    `,
      params
    );
    const ledger = ledgerQuery.rows[0] ?? {};

    return {
      realizedPnL: '0.00000000',
      unrealizedPnL: '0.00000000',
      totalVolume: ledger.total_volume || '0',
      totalFees: ledger.total_fees || '0',
      averageExecutionPrice: ledger.average_execution_price || '0',
      slippageLoss: '0',
    };
  }

  /**
   * Get historical metrics for dashboard
   */
  async getHistoricalMetrics(
    metricType: 'volume' | 'trades' | 'users',
    interval: '1h' | '24h' | '7d' | '30d',
    startDate?: number,
    endDate?: number
  ): Promise<HistoricalDataPoint[]> {
    const granularity = { '1h': 'hour', '24h': 'day', '7d': 'day', '30d': 'day' }[interval];
    const filters: string[] = [];
    const params: Array<string | number> = [granularity];
    if (startDate !== undefined) {
      params.push(startDate);
      filters.push(`timestamp >= TO_TIMESTAMP($${params.length} / 1000.0)`);
    }
    if (endDate !== undefined) {
      params.push(endDate);
      filters.push(`timestamp <= TO_TIMESTAMP($${params.length} / 1000.0)`);
    }

    const result = await this.pool.query(
      `
      SELECT
        date_trunc($1, timestamp) AS bucket,
        COALESCE(SUM(amount_in), 0)::text AS volume,
        COUNT(*)::int AS trades,
        COUNT(DISTINCT user_id)::int AS unique_users,
        COALESCE(SUM(amount_out) / NULLIF(SUM(amount_in), 0), 0)::text AS avg_price
      FROM trades
      ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
      GROUP BY bucket
      ORDER BY bucket ASC
    `,
      params
    );

    return result.rows.map((row) => ({
      timestamp: Math.floor(Date.parse(row.bucket) * 1000),
      volume: row.volume || '0',
      trades: Number(row.trades || 0),
      uniqueUsers: Number(row.unique_users || 0),
      avgPrice: row.avg_price?.toString() || '0',
    }));
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
