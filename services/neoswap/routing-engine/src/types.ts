// Types and interfaces for the routing engine

export interface SwapRoute {
  poolPath: string[];
  inAmount: string;
  outAmount: string;
  priceImpact: number;
  gasEstimate: string;
  protocolFeeBps: number;
}

export interface PoolInfo {
  id: string;
  tokenIn: string;
  tokenOut: string;
  liquidity: string;
  feeTier: number;
  tvl: string;
  volume24h: string;
}

export interface MEVScanResult {
  isSuspicious: boolean;
  riskLevel: 'low' | 'medium' | 'high';
  detectedPatterns: string[];
  suggestedSlippage: number;
}

export interface RouteRequest {
  tokenIn: string;
  tokenOut: string;
  amount: string;
  maxHops?: number;
  excludePools?: string[];
  includePools?: string[];
}

export interface RouteResponse {
  requestId: string;
  timestamp: number;
  bestRoute: SwapRoute;
  alternativeRoutes: SwapRoute[];
  mevScan: MEVScanResult;
  totalLiquidity: string;
}
