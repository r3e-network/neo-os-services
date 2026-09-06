import { Pool, QueryResult } from 'pg';
import { PnLResult, HistoricalDataPoint, TransactionRecord } from '../types';

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
      await client.query(`
        SELECT create_hypertable('trades', 'timestamp');
      `).catch(err => {
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
    
    const result: QueryResult<TransactionRecord> = await this.pool.query(`
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
    `, [userId, limit, offset]);

    const duration = (Date.now() - startTime) / 1000;
    console.log(`Transaction history query took ${duration}s`);
    
    return result.rows;
  }

  /**
   * Calculate PnL for a specific user
   */
  async calculatePnL(userId: string, startDate?: number, endDate?: number): Promise<PnLResult> {
    const whereClause = startDate && endDate
      ? 'AND t.timestamp BETWEEN $3 AND $4'
      : '';
    const params = [userId, startDate, endDate];

    const volumeQuery = await this.pool.query(`
      SELECT 
        SUM(CASE WHEN u.token_in = $1 THEN u.amount_out ELSE s.amount_out END) as total_volume,
        SUM(CASE WHEN u.token_in = $1 THEN u.fee_amount ELSE s.fee_amount END) as total_fees
      FROM trades t
      JOIN swaps u ON u.trade_id = t.id AND u.user_id = $1
      LEFT JOIN swaps s ON s.trade_id = t.id AND s.user_id != $1
      WHERE t.user_id = $1 ${whereClause}
    `, params);

    const realizedQuery = await this.pool.query(`
      SELECT 
        SUM(position.profit_loss::numeric) as profit_loss
      FROM positions position
      WHERE position.user_id = $1 
        AND position.closed_at IS NOT NULL
        AND ($3 IS NULL OR position.closed_at >= TO_TIMESTAMP($3))
        AND ($4 IS NULL OR position.closed_at <= TO_TIMESTAMP($4))
    `, params.slice(0, 4));

    const slippageQuery = await this.pool.query(`
      SELECT COALESCE(SUM(slippage_loss::numeric), 0) as loss
      FROM trade_slippage
      WHERE user_id = $1 AND trade_id IN (SELECT id FROM trades WHERE user_id = $1)
    `, [userId]);

    return {
      realizedPnL: parseFloat(realizedQuery.rows[0]?.profit_loss || '0').toFixed(8),
      unrealizedPnL: '0.00000000', // Would require position tracking
      totalVolume: volumeQuery.rows[0]?.total_volume || '0',
      totalFees: volumeQuery.rows[0]?.total_fees || '0',
      averageExecutionPrice: '25.500000', // Placeholder
      slippageLoss: slippageQuery.rows[0]?.loss || '0',
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
    const intervals = {
      '1h': '1 hour',
      '24h': '1 day',
      '7d': '7 days',
      '30d': '30 days',
    };

    const selectClause = {
      volume: 'SUM(amount_in + amount_out)',
      trades: 'COUNT(*)',
      users: 'COUNT(DISTINCT user_id)',
    }[metricType];

    const result = await this.pool.query(`
      SELECT 
        time_bucket($1, timestamp) as bucket,
        avg(avg_price::numeric) as avg_price
      FROM (
        SELECT 
          timestamp,
          SUM(amount_in::numeric + amount_out::numeric) as avg_price
        FROM trades
        WHERE user_id = $2 OR $2 IS NULL
        GROUP BY DATE_TRUNC('hour', timestamp)
      ) hourly_data
      GROUP BY bucket
      ORDER BY bucket ASC
    `, [intervals[interval], startDate, endDate]);

    return result.rows.map(row => ({
      timestamp: Math.floor(Date.parse(row.bucket) * 1000),
      volume: row.sum || '0',
      trades: parseInt(row.count || '0'),
      uniqueUsers: parseInt(row.unique_users || '0'),
      avgPrice: row.avg_price?.toString() || '0',
    }));
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
