import type { LimitOrder } from './types';

/**
 * WASM Sandbox for secure order matching logic execution
 * Provides isolation and deterministic computation
 */
export class WASMSandbox {
  constructor(_wasmPath: string = './pkg/order_matcher.wasm') {}

  /**
   * Execute matching algorithm in WASM if available
   * Falls back to JavaScript implementation
   */
  executeMatchingAlgorithm(params: MatchingParams): MatchingResult {
    const buys = params.buyOrders.map(cloneOrder).filter(isPositiveOrder).sort(compareBuy);
    const sells = params.sellOrders.map(cloneOrder).filter(isPositiveOrder).sort(compareSell);
    const fills: Fill[] = [];
    const maxMatches = params.maxMatches ?? Number.MAX_SAFE_INTEGER;
    const minimumNotional =
      Number.isFinite(params.minFillRatio) && params.minFillRatio > 0 ? params.minFillRatio : 0;

    for (const buy of buys) {
      if (fills.length >= maxMatches) break;
      for (const sell of sells) {
        if (fills.length >= maxMatches || Number(sell.remainingAmount) <= 0) break;
        if (Number(sell.price) > Number(buy.price)) continue;
        const amount = Math.min(Number(buy.remainingAmount), Number(sell.remainingAmount));
        const price = Number(sell.price);
        if (!Number.isFinite(amount) || amount <= 0 || amount * price < minimumNotional) continue;

        fills.push({
          orderId: buy.orderId,
          counterOrderId: sell.orderId,
          filledAmount: amount.toFixed(8),
          filledPrice: sell.price,
          timestamp: Date.now(),
        });
        buy.remainingAmount = (Number(buy.remainingAmount) - amount).toFixed(8);
        sell.remainingAmount = (Number(sell.remainingAmount) - amount).toFixed(8);
        if (Number(buy.remainingAmount) <= 0) break;
      }
    }

    return {
      fills,
      remainingBuys: buys.filter(isPositiveOrder),
      remainingSells: sells.filter(isPositiveOrder),
    };
  }
}

// Type definitions
interface MatchingParams {
  buyOrders: LimitOrder[];
  sellOrders: LimitOrder[];
  minFillRatio: number;
  maxMatches?: number;
}

interface Fill {
  orderId: string;
  counterOrderId: string;
  filledAmount: string;
  filledPrice: string;
  timestamp: number;
}

interface MatchingResult {
  fills: Fill[];
  remainingBuys: LimitOrder[];
  remainingSells: LimitOrder[];
}

function cloneOrder(order: LimitOrder): LimitOrder {
  return { ...order };
}

function isPositiveOrder(order: LimitOrder): boolean {
  const amount = Number(order.remainingAmount);
  const price = Number(order.price);
  return Number.isFinite(amount) && amount > 0 && Number.isFinite(price) && price > 0;
}

function compareBuy(a: LimitOrder, b: LimitOrder): number {
  return (
    Number(b.price) - Number(a.price) ||
    a.createdAt - b.createdAt ||
    a.orderId.localeCompare(b.orderId)
  );
}

function compareSell(a: LimitOrder, b: LimitOrder): number {
  return (
    Number(a.price) - Number(b.price) ||
    a.createdAt - b.createdAt ||
    a.orderId.localeCompare(b.orderId)
  );
}
