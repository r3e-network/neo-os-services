/**
 * TWAP Calculation Engine
 * Computes Time-Weighted Average Prices for trading operations
 */

import { RedisClientType } from 'redis';
import { createClient } from 'redis';
import BigNumber from 'bignumber.js';
import { TWAPSample } from './types';

export class TWAPCalculator {
  private redis: RedisClientType;
  private sampleWindowSeconds: number = 5 * 60; // 5 minutes default

  constructor(redisUrl: string) {
    this.redis = createClient({ url: redisUrl });
  }

  /**
   * Calculate TWAP for a given time window
   */
  async calculateTWAP(
    tokenPairId: string,
    windowSeconds: number = this.sampleWindowSeconds,
    bucketSizeSeconds: number = 60 // 1 minute buckets
  ): Promise<TWAPSample> {
    const endTime = Date.now();
    const startTime = endTime - windowSeconds * 1000;

    // Query price ticks from Redis/DB
    const prices = await this.queryPriceHistory(tokenPairId, startTime, endTime, bucketSizeSeconds);

    if (prices.length === 0) {
      throw new Error(`No price data available for ${tokenPairId} in window`);
    }

    // Weight by volume for volume-weighted TWAP
    const twap = this.calculateVolumeWeightedTWAP(prices);

    return {
      averagePrice: twap.toFixed(6),
      windowStart: startTime,
      windowEnd: endTime,
      sampleCount: prices.length,
    };
  }

  private async queryPriceHistory(
    tokenPairId: string,
    startTime: number,
    endTime: number,
    _bucketSize: number
  ): Promise<{ price: BigNumber; volume: BigNumber }[]> {
    // Query all price sources
    const keys = await this.redis.keys(`price:${tokenPairId}:*`);
    const values = await Promise.all(keys.map((key) => this.redis.get(key)));

    const prices = values
      .map((v) => (v ? JSON.parse(v) : null))
      .filter((p) => p !== null && p.timestamp >= startTime && p.timestamp <= endTime)
      .map((p) => ({
        price: new BigNumber(p.price),
        volume: new BigNumber(p.volume || '0'),
      }));

    return prices;
  }

  private calculateVolumeWeightedTWAP(
    samples: { price: BigNumber; volume: BigNumber }[]
  ): BigNumber {
    const totalVolume = samples.reduce((sum, s) => sum.plus(s.volume), new BigNumber(0));

    if (totalVolume.isZero()) {
      // Equal weight if no volume data
      const totalPrice = samples.reduce((sum, s) => sum.plus(s.price), new BigNumber(0));
      return totalPrice.div(samples.length);
    }

    // Volume-weighted calculation
    const weightedSum = samples.reduce(
      (sum, s) => sum.plus(s.price.multipliedBy(s.volume)),
      new BigNumber(0)
    );

    return weightedSum.dividedBy(totalVolume);
  }

  /**
   * Calculate simple arithmetic mean TWAP
   */
  async calculateSimpleTWAP(tokenPairId: string, windowSeconds: number): Promise<number> {
    const samples = await this.calculateTWAP(tokenPairId, windowSeconds);
    return parseFloat(samples.averagePrice);
  }

  /**
   * Update cache with latest TWAP value
   */
  async cacheTWAPResult(sample: TWAPSample, ttlSeconds: number = 300): Promise<void> {
    const key = `twap:${sample.windowStart}:${sample.windowEnd}`;
    await this.redis.setEx(key, ttlSeconds, JSON.stringify(sample));
  }

  /**
   * Get cached TWAP result if available
   */
  async getCachedTWAP(windowStart: number, windowEnd: number): Promise<TWAPSample | null> {
    const key = `twap:${windowStart}:${windowEnd}`;
    const cached = await this.redis.get(key);
    return cached ? JSON.parse(cached) : null;
  }
}
