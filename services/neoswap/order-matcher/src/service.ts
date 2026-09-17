import { v4 as uuidv4 } from 'uuid';
import { OrderBookDatabase } from './database';
import { DualSignatureVerifier } from './sigs-verifier';
import { WASMSandbox } from './wasm-sandbox';
import type {
  MatchRequest,
  MatchResult,
  LimitOrder as TypeLimitOrder,
  FillEvent as TypeFillEvent,
} from './types';

export class OrderMatcherService {
  private db: OrderBookDatabase;
  private sigVerifier: DualSignatureVerifier;
  private wasmSandbox: WASMSandbox;
  private orderTimestamps: Map<string, number> = new Map();

  constructor(_config: { dbPath?: string }) {
    this.db = new OrderBookDatabase(_config.dbPath);
    this.sigVerifier = new DualSignatureVerifier();
    this.wasmSandbox = new WASMSandbox('./pkg/order_matcher.wasm');
  }

  /**
   * Create and submit a limit order
   */
  async submitOrder(
    userId: string,
    tokenId: string,
    orderType: 'buy' | 'sell',
    amount: string,
    price: string,
    expiresAt?: number,
    signatures?: { sig1: Buffer; sig2: Buffer }
  ): Promise<{ orderId: string; status: string }> {
    const orderId = uuidv4();
    const timestamp = Date.now();

    // Require dual signature for large orders (threshold: $10k)
    const thresholdAmount = 10000; // $10k in USD equivalent
    if (signatures && parseFloat(amount) * parseFloat(price) > thresholdAmount) {
      const message = Buffer.from(`${orderId}:${userId}:${tokenId}`, 'utf-8');
      const isValid = this.sigVerifier.verifyDualSignature(
        message,
        signatures.sig1,
        signatures.sig2,
        userId,
        [userId.toLowerCase()]
      );

      if (!isValid) {
        throw new Error('Invalid dual signature for large order');
      }
    }

    const order: TypeLimitOrder = {
      orderId,
      userId,
      tokenId,
      orderType,
      amount,
      price,
      remainingAmount: amount,
      status: 'open',
      createdAt: timestamp,
      expiresAt,
    };

    this.orderTimestamps.set(orderId, timestamp);
    this.db.insertOrder(order);

    // Attempt to match immediately
    await this.attemptMatch(order);

    return {
      orderId,
      status: order.status,
    };
  }

  /**
   * Cancel an existing order
   */
  async cancelOrder(orderId: string, userId: string): Promise<boolean> {
    const order = this.db.getOrderById(orderId);

    if (!order) return false;
    if (order.userId !== userId) return false;
    if (order.status !== 'open') return false;

    // Update order status
    this.db.updateOrderStatus(orderId, 'cancelled', '0');

    return true;
  }

  /**
   * Attempt to match order against orderbook
   */
  private async attemptMatch(newOrder: TypeLimitOrder): Promise<void> {
    const oppositeOrders =
      newOrder.orderType === 'buy'
        ? this.db.getOpenOrdersByToken(newOrder.tokenId).filter((o) => o.orderType === 'sell')
        : this.db.getOpenOrdersByToken(newOrder.tokenId).filter((o) => o.orderType === 'buy');

    // Filter by price compatibility
    const compatibleOrders = oppositeOrders.filter((other) =>
      newOrder.orderType === 'buy'
        ? parseFloat(other.price) <= parseFloat(newOrder.price)
        : parseFloat(other.price) >= parseFloat(newOrder.price)
    );

    // Use WASM sandbox for matching if available
    const params = {
      buyOrders:
        newOrder.orderType === 'buy'
          ? [newOrder]
          : compatibleOrders.filter((o) => o.orderType === 'buy'),
      sellOrders:
        newOrder.orderType === 'sell'
          ? [newOrder]
          : compatibleOrders.filter((o) => o.orderType === 'sell'),
      minFillRatio: 0.01, // 1% minimum fill ratio
    };

    const result = this.wasmSandbox.executeMatchingAlgorithm(params);

    // Process fills
    for (const fill of result.fills) {
      await this.processFill({
        ...fill,
        feeAmount: this.calculateFee(fill.filledAmount, fill.filledPrice),
      });
    }

    // Update remaining orders
    for (const order of [...result.remainingBuys, ...result.remainingSells]) {
      this.db.updateOrderStatus(
        order.orderId,
        parseFloat(order.remainingAmount) > 0 ? 'partially_filled' : 'filled',
        order.remainingAmount
      );
    }
  }

  private calculateFee(filledAmount: string, filledPrice: string): string {
    // Standard trading fee: 0.3%
    const amount = parseFloat(filledAmount);
    const price = parseFloat(filledPrice);
    const volume = amount * price;
    const feeRate = 0.003; // 0.3%

    return (volume * feeRate).toFixed(8);
  }

  private async processFill(fill: Omit<TypeFillEvent, 'fillId'>): Promise<void> {
    const fillEvent: TypeFillEvent = {
      ...fill,
      fillId: uuidv4(),
    };

    this.db.insertFill(fillEvent);

    console.log(
      `Fill executed: ${fillEvent.fillId} - Amount: ${fillEvent.filledAmount}, Price: ${fillEvent.filledPrice}`
    );
  }

  /**
   * Get order history for a user
   */
  getOrderHistory(userId: string, limit: number = 50): TypeLimitOrder[] {
    return this.db.getOpenOrdersByUser(userId).slice(0, limit);
  }

  /**
   * Get active orderbook for a token
   */
  getActiveOrderbook(tokenId: string): { buys: TypeLimitOrder[]; sells: TypeLimitOrder[] } {
    const allOrders = this.db.getOpenOrdersByToken(tokenId);
    const buys = allOrders.filter((o) => o.orderType === 'buy').reverse();
    const sells = allOrders.filter((o) => o.orderType === 'sell');

    return { buys, sells };
  }

  /**
   * Execute batch matching using WASM
   */
  async executeBatchMatch(request: MatchRequest): Promise<MatchResult> {
    const startTime = Date.now();

    try {
      const params = {
        buyOrders: request.orders.filter((o) => o.orderType === 'buy'),
        sellOrders: request.orders.filter((o) => o.orderType === 'sell'),
        minFillRatio: 0.01,
        maxMatches: request.maxMatches || 10,
      };

      const result = this.wasmSandbox.executeMatchingAlgorithm(params);

      return {
        matches: result.fills.map((f) => ({
          fillId: uuidv4(),
          orderId: f.orderId,
          counterOrderId: f.counterOrderId,
          filledAmount: f.filledAmount,
          filledPrice: f.filledPrice,
          timestamp: f.timestamp,
          feeAmount: this.calculateFee(f.filledAmount, f.filledPrice),
        })),
        remainingOrders: [...result.remainingBuys, ...result.remainingSells],
        totalFilledVolume: result.fills
          .reduce((sum, f) => sum + parseFloat(f.filledAmount), 0)
          .toFixed(8),
        avgFillPrice:
          result.fills.length > 0
            ? (
                result.fills.reduce((sum, f) => sum + parseFloat(f.filledPrice), 0) /
                result.fills.length
              ).toFixed(6)
            : '0',
      };
    } finally {
      const duration = Date.now() - startTime;
      console.log(`Batch matching completed in ${duration}ms`);
    }
  }

  /**
   * Shutdown gracefully
   */
  async shutdown(): Promise<void> {
    this.db.close();
    console.log('Order Matcher shutdown complete');
  }
}

// Export for testing
export { OrderBookDatabase };
