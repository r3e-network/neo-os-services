import Database from 'better-sqlite3';

export class OrderBookDatabase {
  private db: Database;
  private static DB_PATH = process.env.ORDER_BOOK_DB_PATH || ':memory:';

  constructor() {
    this.db = new Database(OrderBookDatabase.DB_PATH);
    this.initializeSchema();
  }

  private initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        token_id TEXT NOT NULL,
        order_type TEXT NOT NULL CHECK(order_type IN ('buy', 'sell')),
        amount TEXT NOT NULL,
        price TEXT NOT NULL,
        remaining_amount TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('open', 'partially_filled', 'filled', 'cancelled')),
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        UNIQUE(user_id, id)
      );

      CREATE INDEX IF NOT EXISTS idx_orders_token ON orders(token_id);
      CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
      CREATE INDEX IF NOT EXISTS idx_orders_price ON orders(price);
      CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);

      CREATE TABLE IF NOT EXISTS fills (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL,
        counter_order_id TEXT NOT NULL,
        filled_amount TEXT NOT NULL,
        filled_price TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        fee_amount TEXT NOT NULL,
        tx_hash TEXT,
        FOREIGN KEY (order_id) REFERENCES orders(id),
        FOREIGN KEY (counter_order_id) REFERENCES orders(id)
      );

      CREATE INDEX IF NOT EXISTS idx_fills_order ON fills(order_id);
      CREATE INDEX IF NOT EXISTS idx_fills_timestamp ON fills(timestamp);
    `);
  }

  insertOrder(order: Order): boolean {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO orders 
      (id, user_id, token_id, order_type, amount, price, remaining_amount, status, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    try {
      stmt.run(
        order.orderId,
        order.userId,
        order.tokenId,
        order.orderType,
        order.amount,
        order.price,
        order.remainingAmount,
        order.status,
        order.createdAt,
        order.expiresAt || null
      );
      return true;
    } catch (error) {
      console.error('Failed to insert order:', error);
      return false;
    }
  }

  updateOrderStatus(orderId: string, status: string, remainingAmount: string): boolean {
    const stmt = this.db.prepare(`
      UPDATE orders SET status = ?, remaining_amount = ? WHERE id = ?
    `);

    const result = stmt.run(status, remainingAmount, orderId);
    return result.changes > 0;
  }

  getOpenOrdersByToken(tokenId: string): LimitOrder[] {
    const stmt = this.db.prepare(`
      SELECT * FROM orders 
      WHERE token_id = ? AND status IN ('open', 'partially_filled')
      ORDER BY price ASC, created_at ASC
    `);

    return stmt.all(tokenId) as LimitOrder[];
  }

  getOpenOrdersByUser(userId: string): LimitOrder[] {
    const stmt = this.db.prepare(`
      SELECT * FROM orders 
      WHERE user_id = ? AND status = 'open'
      ORDER BY created_at DESC
    `);

    return stmt.all(userId) as LimitOrder[];
  }

  insertFill(fill: Omit<FillEvent, 'fillId'>): boolean {
    const fillId = generateUUID();
    const stmt = this.db.prepare(`
      INSERT INTO fills (id, order_id, counter_order_id, filled_amount, filled_price, timestamp, fee_amount, tx_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    try {
      stmt.run(
        fillId,
        fill.orderId,
        fill.counterOrderId,
        fill.filledAmount,
        fill.filledPrice,
        fill.timestamp,
        fill.feeAmount,
        fill.txHash || null
      );
      return true;
    } catch (error) {
      console.error('Failed to insert fill:', error);
      return false;
    }
  }

  getFillsForOrder(orderId: string, limit: number = 100): FillEvent[] {
    const stmt = this.db.prepare(`
      SELECT * FROM fills 
      WHERE order_id = ? OR counter_order_id = ?
      ORDER BY timestamp DESC 
      LIMIT ?
    `);

    return stmt.all(orderId, orderId, limit) as FillEvent[];
  }

  getOrderById(orderId: string): LimitOrder | undefined {
    const stmt = this.db.prepare('SELECT * FROM orders WHERE id = ?');
    return stmt.get(orderId) as LimitOrder | undefined;
  }

  close(): void {
    this.db.close();
  }
}

function generateUUID(): string {
  return crypto.randomUUID();
}
