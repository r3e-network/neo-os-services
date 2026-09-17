/**
 * Multi-Source Price Feed Subscriptions
 * Subscribes to StealthEX, Uniswap V3, Curve, and other DEX price feeds
 */

import { createClient } from 'redis';
import type { RedisClientType } from 'redis';
import { PriceTick, PriceSource, HealthStatus, TWAPSample } from './types';

export class PriceSubscriptionsManager {
  private redis: RedisClientType;
  private subscriptions: Map<string, Set<(msg: string) => void>> = new Map();
  private sources: Map<string, PriceSource> = new Map();

  constructor(redisUrl: string) {
    this.redis = createClient({ url: redisUrl });
    this.initializeSources();
  }

  private initializeSources(): void {
    // Initialize known price sources
    const sourceConfigs = [
      {
        id: 'stealex',
        name: 'StealthEX',
        url: 'wss://api.stealex.com/v1/quotes',
        latencyMs: 500,
      },
      {
        id: 'uniswap-v3',
        name: 'Uniswap V3',
        url: 'wss://live-uniswap-api.herokuapp.com',
        latencyMs: 200,
      },
      {
        id: 'curve',
        name: 'Curve Finance',
        url: 'wss://api.curve.finance/api/ws',
        latencyMs: 300,
      },
      {
        id: 'balancer',
        name: 'Balancer',
        url: 'wss://gateway.balancer.fi/subscriptions',
        latencyMs: 250,
      },
    ];

    for (const config of sourceConfigs) {
      this.sources.set(config.id, {
        ...config,
        isHealthy: false,
        lastUpdate: 0,
      });
    }
  }

  async startSubscription(sourceId: string): Promise<void> {
    if (!this.sources.has(sourceId)) {
      throw new Error(`Unknown source: ${sourceId}`);
    }

    const source = this.sources.get(sourceId)!;
    
    this.updateSourceHealth(sourceId, false);
    throw new Error(`Price source transport is not configured for ${source.name}`);
  }

  async emitPriceUpdate(tick: PriceTick): Promise<void> {
    const key = `${tick.tokenPairId}:${tick.sourceId}`;
    
    // Store in Redis with TTL
    await this.redis.setEx(
      `price:${key}`,
      60, // 1 minute TTL
      JSON.stringify(tick)
    );

    // Broadcast to all subscribers
    const subscribers = this.subscriptions.get(tick.tokenPairId);
    if (subscribers) {
      const message = JSON.stringify({
        type: 'price_update',
        payload: tick,
      });

      for (const subscriber of subscribers) {
        try {
          subscriber(message);
        } catch (error) {
          console.error('Subscriber error:', error);
        }
      }
    }

    // Record metrics
    console.log(`Price tick received: ${tick.tokenPairId} @ ${tick.price} (${tick.sourceId})`);
  }

  subscribe(tokenPairId: string, callback: (msg: string) => void): () => void {
    if (!this.subscriptions.has(tokenPairId)) {
      this.subscriptions.set(tokenPairId, new Set());
    }

    this.subscriptions.get(tokenPairId)!.add(callback);

    // Return unsubscribe function
    return () => {
      this.subscriptions.get(tokenPairId)?.delete(callback);
    };
  }

  async getTWAPValues(tokenPairId: string, windowSizeSeconds: number): Promise<TWAPSample[]> {
    const startTime = Date.now() - windowSizeSeconds * 1000;
    const endTime = Date.now();
    const keys = await this.redis.keys(`price:${tokenPairId}:*`);
    const values = await Promise.all(keys.map(key => this.redis.get(key)));

    return values.flatMap(value => {
      if (!value) return [];
      try {
        const tick = JSON.parse(value) as PriceTick;
        const price = Number(tick.price);
        if (tick.timestamp < startTime || tick.timestamp > endTime || !Number.isFinite(price) || price < 0) {
          return [];
        }
        return [{
          averagePrice: tick.price,
          windowStart: tick.timestamp,
          windowEnd: tick.timestamp,
          sampleCount: 1,
        }];
      } catch {
        return [];
      }
    });
  }

  private updateSourceHealth(sourceId: string, healthy: boolean): void {
    const source = this.sources.get(sourceId);
    if (source) {
      source.isHealthy = healthy;
      source.lastUpdate = Date.now();
    }
  }

  getHealthStatus(): HealthStatus {
    const sources: Record<string, boolean> = {};
    let totalLatency = 0;
    let count = 0;

    for (const [id, source] of this.sources.entries()) {
      sources[id] = source.isHealthy;
      totalLatency += source.latencyMs;
      count++;
    }

    return {
      sources,
      avgLatency: totalLatency / count,
      lastUpdate: Date.now(),
    };
  }

  async shutdown(): Promise<void> {
    await this.redis.quit();
  }
}
