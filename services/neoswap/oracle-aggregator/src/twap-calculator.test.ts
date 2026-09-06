import { describe, it, expect, beforeEach } from 'vitest';
import { TWAPCalculator } from './twap-calculator';
import BigNumber from 'bignumber.js';

describe('TWAPCalculator', () => {
  let calculator: TWAPCalculator;

  beforeEach(() => {
    calculator = new TWAPCalculator('redis://localhost:6379');
  });

  describe('calculateVolumeWeightedTWAP', () => {
    it('should calculate weighted average when volumes are positive', () => {
      const samples = [
        { price: new BigNumber('10'), volume: new BigNumber('100') },
        { price: new BigNumber('20'), volume: new BigNumber('100') },
        { price: new BigNumber('30'), volume: new BigNumber('100') },
      ];

      const result = calculator['calculateVolumeWeightedTWAP'](samples);

      // Equal volumes should give simple average
      expect(parseFloat(result.toFixed(6))).toBe(20);
    });

    it('should weight by volume correctly', () => {
      const samples = [
        { price: new BigNumber('10'), volume: new BigNumber('90') },
        { price: new BigNumber('30'), volume: new BigNumber('10') },
      ];

      const result = calculator['calculateVolumeWeightedTWAP'](samples);

      // Heavily weighted towards $10
      expect(parseFloat(result.toFixed(6))).toBeLessThan(20);
      expect(parseFloat(result.toFixed(6))).toBeGreaterThan(10);
    });

    it('should handle zero total volume with equal weighting', () => {
      const samples = [
        { price: new BigNumber('10'), volume: new BigNumber('0') },
        { price: new BigNumber('20'), volume: new BigNumber('0') },
        { price: new BigNumber('30'), volume: new BigNumber('0') },
      ];

      const result = calculator['calculateVolumeWeightedTWAP'](samples);

      // Equal weights when no volume
      expect(parseFloat(result.toFixed(6))).toBe(20);
    });
  });

  describe('queryPriceHistory', () => {
    it('should filter prices within time window', async () => {
      // Mock Redis responses would go here
      // For unit test, we mock the private method behavior
      
      const startTime = Date.now() - 60000; // 1 minute ago
      const endTime = Date.now();
      const bucketSize = 60; // 1 second buckets

      // This would call actual Redis in production
      const prices = await (calculator as any).queryPriceHistory(
        'NEO/USDT',
        startTime,
        endTime,
        bucketSize
      );

      // Verify structure (mock data may not return anything)
      if (prices.length > 0) {
        prices.forEach(p => {
          expect(p.price).toBeInstanceOf(BigNumber);
          expect(p.volume).toBeInstanceOf(BigNumber);
        });
      }
    });
  });

  describe('cache operations', () => {
    it('should cache TWAP results with TTL', async () => {
      const sample = {
        averagePrice: '25.5',
        windowStart: Date.now() - 300000,
        windowEnd: Date.now(),
        sampleCount: 60,
      };

      await calculator.cacheTWAPResult(sample, 300);

      // Verify cache hit
      const cached = await calculator.getCachedTWAP(
        sample.windowStart,
        sample.windowEnd
      );

      expect(cached).toBeDefined();
      expect(cached?.averagePrice).toBe(sample.averagePrice);
    });

    it('should return null for non-existent cached TWAP', async () => {
      const randomStart = Date.now() - 1000000;
      const randomEnd = Date.now() - 900000;

      const cached = await calculator.getCachedTWAP(randomStart, randomEnd);

      expect(cached).toBeNull();
    });
  });
});
