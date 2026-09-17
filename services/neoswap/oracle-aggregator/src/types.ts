// Types for TWAP Oracle Aggregator

export interface PriceSource {
  id: string;
  name: string;
  url: string;
  latencyMs: number;
  isHealthy: boolean;
  lastUpdate?: number;
}

export interface PriceTick {
  tokenPairId: string;
  price: string;
  volume: string;
  timestamp: number;
  sourceId: string;
}

export interface TWAPSample {
  averagePrice: string;
  windowStart: number;
  windowEnd: number;
  sampleCount: number;
}

export interface SubscriptionMessage {
  type: 'price_update' | 'twap_update' | 'health_check';
  payload: PriceTick | TWAPSample | HealthStatus;
}

export interface HealthStatus {
  sources: Record<string, boolean>;
  avgLatency: number;
  lastUpdate: number;
}
