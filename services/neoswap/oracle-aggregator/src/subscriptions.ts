/**
 * Multi-Source Price Feed Subscriptions
 * Subscribes to StealthEX, Uniswap V3, Curve, and other DEX price feeds
 */

import { createClient } from 'redis';
import type { RedisClientType } from 'redis';
import { PriceTick, PriceSource, HealthStatus } from '../types';

export class PriceSubscriptionsManager {
  private redis: RedisClientType;
  private subscriptions: Map<string, Set<() => void>> = new Map();
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
        wsUrl: 'wss://api.stealex.com/v1/quotes',
        latencyMs: 500,
      },
      {
        id: 'uniswap-v3',
        name: 'Uniswap V3',
        wsUrl: 'wss://live-uniswap-api.herokuapp.com',
        latencyMs: 200,
      },
      {
        id: 'curve',
        name: 'Curve Finance',
        wsUrl: 'wss://api.curve.finance/api/ws',
        latencyMs: 300,
      },
      {
        id: 'balancer',
        name: 'Balancer',
        wsUrl: 'wss://gateway.baolancer.fi/subscriptions',
        latencyMs: 250,
      },
    ];

    for (const config of sourceConfigs) {
      this.sources.set(config.id, {
        ...config,
        isHealthy: true,
        lastUpdate: Date.now(),
      });
    }
  }

  async startSubscription(sourceId: string): Promise<void> {
    if (!this.sources.has(sourceId)) {
      throw new Error(`Unknown source: ${sourceId}`);
    }

    const source = this.sources.get(sourceId)!;
    
    try {
      // Connect to WebSocket
      // This would be implemented with actual WebSocket clients
      
      // Simulate receiving price data
      setInterval(async () => {
        await this.emitPriceUpdate({
          tokenPairId: 'NEO/USDT',
          price: (Math.random() * 10 + 20).toFixed(6),
          volume: (Math.random() * 10000).toFixed(2),
          timestamp: Date.now(),
          sourceId,
        });
      }, source.latencyMs * 5);

      console.log(`Started subscription to ${source.name}`);

    } catch (error) {
      console.error(`Failed to subscribe to ${source.name}:`, error);
      this.updateSourceHealth(sourceId, false);
    }
  }

  async emitPriceUpdate(tick: PriceTick): Promise<void> {
    const key = `${tick.tokenPairId}:${tick.sourceId}`;
    
    // Store in Redis with TTL
    await this.redis.setex(
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

  getTWAPValues(tokenPairId: string, windowSizeSeconds: number): Promise<TWAPSample[]> {
    // Query historical price data
    const startTime = Date.now() - windowSizeSeconds * 1000;
    const samples: TWAPSample[] = [];

    // In production, this would query TimescaleDB or Timescale-compatible storage
    // For now, return mock sample
    samples.push({
      averagePrice: '25.5',
      windowStart: startTime,
      windowEnd: Date.now(),
      sampleCount: 60,
    });

    return Promise.resolve(samples);
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
