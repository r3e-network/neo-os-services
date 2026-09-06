import { v4 as uuidv4 } from 'uuid';
import { Redis } from 'redis';
import { PathfindingEngine } from './pathfinding';
import { MEVRiskScanner } from './mev-scanner';
import { CACHE_TTL, requestCounter, latencyHistogram, getMetrics } from './metrics';
import { RouteRequestSchema, RouteResponseSchema } from './validation';
import type { RouteRequest, RouteResponse, SwapRoute } from './types';

export class RoutingEngineService {
  private redis: Redis | null = null;
  private pathfinding: PathfindingEngine;
  private mevScanner: MEVRiskScanner;
  private poolCache: Map<string, any> = new Map();

  constructor(config: { redisUrl?: string }) {
    this.pathfinding = new PathfindingEngine();
    this.mevScanner = new MEVRiskScanner();
    
    if (config.redisUrl) {
      this.redis = this.createRedisClient(config.redisUrl);
      this.connectRedis();
    }
  }

  private async connectRedis(): Promise<void> {
    if (!this.redis) return;
    
    this.redis.on('connect', () => console.log('Redis connected'));
    this.redis.on('error', (err) => console.error('Redis error:', err));
    
    try {
      await this.redis.connect();
      console.log('Routing Engine: Redis connection established');
    } catch (error) {
      console.error('Failed to connect Redis:', error);
    }
  }

  /**
   * Main entry point: Calculate optimal routing paths
   */
  async calculateRoutes(request: RouteRequest): Promise<RouteResponse> {
    const startTime = Date.now();
    const requestId = uuidv4();
    
    try {
      // Validate request
      const validated = RouteRequestSchema.parse(request);
      
      // Check cache first
      const cacheKey = `route:${validated.tokenIn}:${validated.tokenOut}:${validated.amount}`;
      const cached = await this.getCachedRoute(cacheKey);
      if (cached) {
        return cached;
      }

      // Find best routes using pathfinding
      const routes = await this.findOptimalRoutes(validated);
      
      // MEV scanning
      const mevResult = await this.mevScanner.scanRoute(routes[0]);
      
      const response: RouteResponse = {
        requestId,
        timestamp: Date.now(),
        bestRoute: routes[0],
        alternativeRoutes: routes.slice(1, 4), // Top 3 alternatives
        mevScan: mevResult,
        totalLiquidity: this.aggregateLiquidity(routes).toString(),
      };

      // Cache the result
      await this.cacheRoute(cacheKey, response);
      
      // Record metrics
      const duration = (Date.now() - startTime) / 1000;
      requestCounter.inc({ status: 'success', token_pair: `${validated.tokenIn}/${validated.tokenOut}` });
      latencyHistogram.observe(duration, 'routing');

      return response;

    } catch (error) {
      console.error('Routing calculation failed:', error);
      requestCounter.inc({ status: 'error', token_pair: `${request.tokenIn}/${request.tokenOut}` });
      throw error;
    }
  }

  private async findOptimalRoutes(request: RouteRequest): Promise<SwapRoute[]> {
    // Get pool information
    const pools = await this.getPoolData();
    
    // Build graph
    this.buildGraph(pools);
    
    // Find all possible routes
    const rawRoutes = this.pathfinding.findBestRoutes(
      request.tokenIn,
      request.tokenOut,
      request.amount
    );
    
    // Filter by excluded/include pools
    return rawRoutes.filter(route => {
      if (request.excludePools?.some(id => route.poolPath.includes(id))) {
        return false;
      }
      if (request.includePools && !request.includePools.some(id => route.poolPath.includes(id))) {
        return false;
      }
      return true;
    }).slice(0, request.maxHops || 4);
  }

  private buildGraph(pools: any[]): void {
    for (const pool of pools) {
      const poolId = pool.id;
      
      // Create bidirectional edges
      if (!this.pathfinding.adjacencyMatrix.has(poolId)) {
        this.pathfinding.adjacencyMatrix.set(poolId, new Map());
      }
      
      // Add connections to input/output tokens
      const addConnection = (token: string) => {
        const key = `${token}:${poolId}`;
        const weight = 1 / pool.liquidity; // Lower weight = better
        
        if (!this.pathfinding.adjacencyMatrix.has(key)) {
          this.pathfinding.adjacencyMatrix.set(key, new Map());
        }
        
        this.pathfinding.adjacencyMatrix.get(key)!.set(poolId, weight);
      };
      
      addConnection(pool.tokenIn);
      addConnection(pool.tokenOut);
      
      // Cache pool data
      this.poolCache.set(poolId, pool);
      this.pathfinding.pools.set(poolId, pool);
    }
  }

  private async getPoolData(): Promise<any[]> {
    // In production, this would fetch from Neo blockchain or database
    // For now, return mock data
    return [
      {
        id: 'pool-1',
        tokenIn: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        tokenOut: '0xffffffffffffffffffffffffffffffffffffffffffff',
        reserveIn: '10000000000000',
        reserveOut: '9850000000000',
        liquidity: '10000000',
        feeTier: 30,
      },
      {
        id: 'pool-2',
        tokenIn: '0xffffffffffffffffffffffffffffffffffffffffffff',
        tokenOut: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        reserveIn: '9800000000000',
        reserveOut: '9950000000000',
        liquidity: '9500000',
        feeTier: 30,
      },
    ];
  }

  private aggregateLiquidity(routes: SwapRoute[]): string {
    const BigNumber = require('bignumber.js');
    const total = routes.reduce((sum, route) => {
      return sum.plus(new BigNumber(route.outAmount));
    }, new BigNumber(0));
    
    return total.toFixed(8);
  }

  private async getCachedRoute(key: string): Promise<RouteResponse | null> {
    if (!this.redis) return null;
    
    try {
      const cached = await this.redis.get(key);
      if (cached) {
        return JSON.parse(cached);
      }
    } catch (error) {
      console.error('Cache read failed:', error);
    }
    
    return null;
  }

  private async cacheRoute(key: string, route: RouteResponse): Promise<void> {
    if (!this.redis) return;
    
    try {
      await this.redis.setex(key, CACHE_TTL.ROUTES, JSON.stringify(route));
    } catch (error) {
      console.error('Cache write failed:', error);
    }
  }

  /**
   * Health check endpoint
   */
  async healthCheck(): Promise<{
    status: 'healthy' | 'degraded' | 'unhealthy';
    components: Record<string, 'ok' | 'error'>;
    timestamp: number;
  }> {
    const components: Record<string, 'ok' | 'error'> = {};
    
    // Check Redis
    try {
      if (this.redis) {
        await this.redis.ping();
        components.redis = 'ok';
      } else {
        components.redis = 'ok'; // Optional
      }
    } catch {
      components.redis = 'error';
    }
    
    // Overall status
    const unhealthy = Object.values(components).filter(v => v === 'error').length;
    
    return {
      status: unhealthy === 0 ? 'healthy' : unhealthy > 1 ? 'unhealthy' : 'degraded',
      components,
      timestamp: Date.now(),
    };
  }

  /**
   * Shutdown gracefully
   */
  async shutdown(): Promise<void> {
    if (this.redis) {
      await this.redis.quit();
    }
  }

  createRedisClient(url: string): any {
    const { createClient } = require('redis');
    return createClient({ url });
  }
}

// Export metrics endpoint
async function metricsHandler(): Promise<string> {
  return await getMetrics();
}

export { metricsHandler };
