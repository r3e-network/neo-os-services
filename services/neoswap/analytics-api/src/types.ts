// Types for Analytics API

export interface TransactionRecord {
  id: string;
  timestamp: number;
  userId: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  amountOut: string;
  feeAmount: string;
  txHash?: string;
  poolIds: string[];
}

export interface PnLResult {
  realizedPnL: string;
  unrealizedPnL: string;
  totalVolume: string;
  totalFees: string;
  averageExecutionPrice: string;
  slippageLoss: string;
}

export interface HistoricalDataPoint {
  timestamp: number;
  volume: string;
  trades: number;
  uniqueUsers: number;
  avgPrice: string;
}

export interface ExportRequest {
  format: 'csv' | 'pdf';
  startDate: number;
  endDate: number;
  userId?: string;
  tokens?: string[];
}
