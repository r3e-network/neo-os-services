/**
 * TWAP Oracle Aggregator Service - Main Entry Point
 */

import { RedisClientType } from 'redis';
import { createClient } from 'redis';
import { PriceSubscriptionsManager } from './subscriptions';
import { TWAPCalculator } from './twap-calculator';
import { getMetrics } from './metrics';
import { WebSocketServer } from 'ws';
import type { Server as HttpServer } from 'http';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';

export class OracleAggregatorService {
  private redis: RedisClientType;
  private subscriptionsManager: PriceSubscriptionsManager;
  private twapCalculator: TWAPCalculator;
  private wsServer: WebSocketServer | null = null;
  private httpServer: HttpServer | null = null;
  private running: boolean = false;

  constructor(config: { redisUrl: string }) {
    this.redis = createClient({ url: config.redisUrl });
    this.subscriptionsManager = new PriceSubscriptionsManager(config.redisUrl);
    this.twapCalculator = new TWAPCalculator(config.redisUrl);
  }

  async start(): Promise<void> {
    this.running = true;

    // Connect Redis
    await this.redis.connect();
    console.log('Oracle Aggregator: Redis connected');

    // Start price source subscriptions
    for (const sourceId of ['stealex', 'uniswap-v3', 'curve', 'balancer']) {
      try {
        await this.subscriptionsManager.startSubscription(sourceId);
      } catch (error) {
        console.error(`Failed to start ${sourceId}:`, error);
      }
    }

    // Start WebSocket server
    this.startWebSocketServer();

    // Start HTTP metrics server
    this.startHTTPLServer();

    console.log('Oracle Aggregator started successfully');
  }

  private startWebSocketServer(): void {
    const wss = new WebSocketServer({ port: parseInt(process.env.WS_PORT || '8080') });

    wss.on('connection', (socket) => {
      const clientId = crypto.randomUUID();
      
      socket.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          
          if (message.type === 'subscribe' && message.tokenPair) {
            const unsubscribe = this.subscriptionsManager.subscribe(
              message.tokenPair,
              (msg) => socket.send(msg)
            );
            
            // Register cleanup
            socket.on('close', () => unsubscribe());
            console.log(`Client ${clientId} subscribed to ${message.tokenPair}`);
          } else if (message.type === 'request_twap') {
            this.handleTWAPRequest(socket, message);
          }
        } catch (error) {
          console.error('Invalid WebSocket message:', error);
          socket.send(JSON.stringify({ type: 'error', message: 'Invalid request' }));
        }
      });

      // Send initial health status
      socket.send(JSON.stringify({
        type: 'health_check',
        payload: this.subscriptionsManager.getHealthStatus(),
      }));

      console.log(`Connected client: ${clientId}`);
    });

    wss.on('listening', () => {
      console.log(`WebSocket server listening on port ${process.env.WS_PORT || 8080}`);
    });

    this.wsServer = wss;
  }

  private handleTWAPRequest(socket: any, message: { tokenPair: string; windowSeconds?: number }): void {
    const windowSeconds = message.windowSeconds || 300;
    
    this.twapCalculator.calculateTWAP(message.tokenPair, windowSeconds)
      .then(twap => {
        socket.send(JSON.stringify({
          type: 'twap_update',
          payload: twap,
        }));
      })
      .catch(error => {
        socket.send(JSON.stringify({
          type: 'error',
          message: `TWAP calculation failed: ${error.message}`,
        }));
      });
  }

  private startHTTPLServer(): void {
    // Simple HTTP server for health checks and metrics
    this.httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      res.setHeader('Content-Type', 'application/json');

      if (req.url === '/health') {
        res.writeHead(200);
        res.end(JSON.stringify({
          status: 'healthy',
          timestamp: Date.now(),
        }));
      } else if (req.url === '/metrics') {
        res.writeHead(200);
        const metrics = await getMetrics();
        res.end(metrics);
      } else {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Not found' }));
      }
    });

    const httpServer = this.httpServer;
    httpServer.listen(parseInt(process.env.METRICS_PORT || '9090'), () => {
      console.log(`HTTP metrics server listening on port ${process.env.METRICS_PORT || 9090}`);
    });
  }

  /**
   * Calculate TWAP for a token pair
   */
  async getTWAP(tokenPairId: string, windowSeconds: number = 300): Promise<any> {
    return await this.twapCalculator.calculateTWAP(tokenPairId, windowSeconds);
  }

  /**
   * Get current price tick
   */
  async getPriceTick(tokenPairId: string, sourceId?: string): Promise<any> {
    const key = sourceId 
      ? `price:${tokenPairId}:${sourceId}`
      : `price:${tokenPairId}:*`;

    const keys = await this.redis.keys(key);
    if (keys.length === 0) {
      throw new Error(`No price data available for ${tokenPairId}`);
    }

    const firstKey = keys[0];
    if (!firstKey) throw new Error(`No price data available for ${tokenPairId}`);
    const value = await this.redis.get(firstKey);
    if (!value) throw new Error(`Price data is empty for ${tokenPairId}`);
    return JSON.parse(value);
  }

  /**
   * Graceful shutdown
   */
  async shutdown(): Promise<void> {
    this.running = false;

    if (this.wsServer) {
      const wsServer = this.wsServer;
      this.wsServer = null;
      await new Promise<void>((resolve) => wsServer.close(() => resolve()));
    }

    if (this.httpServer) {
      const httpServer = this.httpServer;
      this.httpServer = null;
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }

    if (this.redis.isOpen) await this.redis.quit();
    
    console.log('Oracle Aggregator shutdown complete');
  }
}

// Export service instance for use elsewhere
let serviceInstance: OracleAggregatorService | null = null;

export function getService(): OracleAggregatorService {
  if (!serviceInstance) {
    throw new Error('OracleAggregatorService not initialized. Call start() first.');
  }
  return serviceInstance;
}

export async function initializeService(config: { redisUrl: string }): Promise<OracleAggregatorService> {
  serviceInstance = new OracleAggregatorService(config);
  await serviceInstance.start();
  return serviceInstance;
}
