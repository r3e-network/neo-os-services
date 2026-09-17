import { v4 as uuidv4 } from 'uuid';
import { createClient } from 'redis';
import type { RedisClientType } from 'redis';
import { PathfindingEngine } from './pathfinding';
import { MEVRiskScanner } from './mev-scanner';
import { CACHE_TTL, requestCounter, latencyHistogram, getMetrics } from './metrics';
import { RouteRequestSchema, RouteResponseSchema } from './validation';
import type { RouteRequest, RouteResponse, SwapRoute } from './types';

export class RoutingEngineService {
  private redis: RedisClientType | null = null;
  private pathfinding: PathfindingEngine;
  private mevScanner: MEVRiskScanner;
  private readonly poolProvider?: () => Promise<RoutingPool[]>;

  constructor(config: { redisUrl?: string; poolProvider?: () => Promise<RoutingPool[]> }) {
    this.pathfinding = new PathfindingEngine();
    this.mevScanner = new MEVRiskScanner();
    this.poolProvider = config.poolProvider;

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
      if (routes.length === 0) throw new Error('No viable swap route');

      // MEV scanning
      const mevResult = await this.mevScanner.scanRoute(routes[0]);

      const response: RouteResponse = RouteResponseSchema.parse({
        requestId,
        timestamp: Date.now(),
        bestRoute: routes[0],
        alternativeRoutes: routes.slice(1, 4), // Top 3 alternatives
        mevScan: mevResult,
        totalLiquidity: this.aggregateLiquidity(routes).toString(),
      });

      // Cache the result
      await this.cacheRoute(cacheKey, response);

      // Record metrics
      const duration = (Date.now() - startTime) / 1000;
      requestCounter.inc({
        status: 'success',
        token_pair: `${validated.tokenIn}/${validated.tokenOut}`,
      });
      latencyHistogram.observe({ step: 'routing' }, duration);

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
    this.pathfinding.setPools(pools);

    // Find all possible routes
    const rawRoutes = this.pathfinding.findBestRoutes(
      request.tokenIn,
      request.tokenOut,
      request.amount,
      request.maxHops
    );

    // Filter by excluded/include pools
    return rawRoutes.filter((route) => {
      if (request.excludePools?.some((id) => route.poolPath.includes(id))) {
        return false;
      }
      if (request.includePools && !request.includePools.some((id) => route.poolPath.includes(id))) {
        return false;
      }
      return true;
    });
  }

  private async getPoolData(): Promise<RoutingPool[]> {
    if (!this.poolProvider) {
      throw new Error('Routing pool provider is not configured');
    }
    const pools = await this.poolProvider();
    if (!Array.isArray(pools)) throw new Error('Routing pool provider returned invalid data');
    return pools;
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
      await this.redis.setEx(key, CACHE_TTL.ROUTES, JSON.stringify(route));
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
    const unhealthy = Object.values(components).filter((v) => v === 'error').length;

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

  createRedisClient(url: string): RedisClientType {
    return createClient({ url });
  }
}

type RoutingPool = {
  id: string;
  tokenIn: string;
  tokenOut: string;
  liquidity?: string;
  feeTier?: number;
  reserveIn: string;
  reserveOut: string;
};

// Export metrics endpoint
async function metricsHandler(): Promise<string> {
  return await getMetrics();
}

export { metricsHandler };
