// Core types for order matching

export interface LimitOrder {
  orderId: string;
  userId: string;
  tokenId: string;
  orderType: 'buy' | 'sell';
  amount: string;
  price: string;
  remainingAmount: string;
  status: 'open' | 'partially_filled' | 'filled' | 'cancelled';
  createdAt: number;
  expiresAt?: number;
}

export interface FillEvent {
  fillId: string;
  orderId: string;
  counterOrderId: string;
  filledAmount: string;
  filledPrice: string;
  timestamp: number;
  feeAmount: string;
  txHash?: string;
}

export interface MatchRequest {
  orders: LimitOrder[];
  maxMatches: number;
  priority: 'price_time' | 'volume_weighted';
}

export interface MatchResult {
  matches: FillEvent[];
  remainingOrders: LimitOrder[];
  totalFilledVolume: string;
  avgFillPrice: string;
}

export interface DualSignature {
  signature1: Buffer;
  signature2: Buffer;
  message: Buffer;
}
