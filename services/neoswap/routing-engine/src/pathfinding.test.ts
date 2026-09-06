import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PathfindingEngine } from './pathfinding';
import BigNumber from 'bignumber.js';

describe('PathfindingEngine', () => {
  let engine: PathfindingEngine;

  beforeEach(() => {
    engine = new PathfindingEngine();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('findBestRoutes', () => {
    it('should return multiple routes when available', async () => {
      const routes = engine.findBestRoutes(
        'token-a',
        'token-b',
        '1000000'
      );

      expect(routes).toBeInstanceOf(Array);
      expect(routes.length).toBeGreaterThan(0);
      
      if (routes.length > 0) {
        const route = routes[0];
        expect(route).toHaveProperty('poolPath');
        expect(route).toHaveProperty('inAmount');
        expect(route).toHaveProperty('outAmount');
        expect(route).toHaveProperty('priceImpact');
        expect(route).toHaveProperty('gasEstimate');
        expect(route).toHaveProperty('protocolFeeBps');
      }
    });

    it('should sort routes by output amount descending', () => {
      const routes = engine.findBestRoutes('token-a', 'token-b', '1000000');
      
      if (routes.length > 1) {
        for (let i = 1; i < routes.length; i++) {
          expect(new BigNumber(routes[i - 1].outAmount).gte(routes[i].outAmount)).toBe(true);
        }
      }
    });
  });

  describe('calculatePoolOutput', () => {
    it('should calculate correct output using constant product formula', () => {
      const mockPool = {
        reserveIn: '1000000',
        reserveOut: '1000000',
        feeTier: 30,
      };

      const inputAmount = new BigNumber('10000');
      const result = engine['calculatePoolOutput'](mockPool as any, inputAmount.toString());
      
      // Should be less than input due to fees
      expect(result.isLessThan(inputAmount)).toBe(true);
      
      // Should be reasonable (not zero, not infinite)
      expect(result.isGreaterThan(0)).toBe(true);
      expect(result.isLessThan(inputAmount.times(2))).toBe(true);
    });

    it('should throw error for zero liquidity pools', () => {
      const zeroLiquidityPool = {
        reserveIn: '0',
        reserveOut: '0',
        feeTier: 30,
      };

      expect(() => {
        engine['calculatePoolOutput'](zeroLiquidityPool as any, '10000');
      }).toThrow('Pool has zero liquidity');
    });
  });

  describe('bfsPaths', () => {
    it('should find paths within max depth', () => {
      const paths = engine['bfsPaths']('token-start', 'token-end', 3);
      
      // All paths should be <= 3 hops
      paths.forEach((path: string[]) => {
        expect(path.length).toBeLessThanOrEqual(4); // Start + 3 hops
      });
    });

    it('should avoid visiting same node twice in a path', () => {
      const paths = engine['bfsPaths']('token-a', 'token-d', 5);
      
      paths.forEach((path: string[]) => {
        const uniqueNodes = new Set(path);
        expect(uniqueNodes.size).toBe(path.length);
      });
    });
  });
});

describe('Price Impact Calculation', () => {
  it('should calculate positive price impact for large swaps', () => {
    const engine = new PathfindingEngine();
    
    // Mock mid-price and implied price
    const inputAmount = '1000000';
    const outputAmount = '980000'; // Slightly less due to slippage
    
    const priceImpact = engine['calculatePriceImpact'](inputAmount, outputAmount);
    
    expect(priceImpact).toBeGreaterThan(0);
    expect(priceImpact).toBeLessThan(10); // Should be < 10%
  });

  it('should return near-zero impact for small swaps', () => {
    const engine = new PathfindingEngine();
    
    const inputAmount = '1000';
    const outputAmount = '999';
    
    const priceImpact = engine['calculatePriceImpact'](inputAmount, outputAmount);
    
    expect(priceImpact).toBeLessThan(1); // < 1% for small swaps
  });
});
