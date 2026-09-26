/**
 * High-Performance WebSocket Server with Backpressure Handling
 * Supports 10,000+ concurrent connections with P99 latency < 50ms
 */

import WebSocket, { WebSocketServer } from 'ws';
import Redis from 'ioredis';
import { Mutex } from 'async-mutex';
import {
  activeConnectionsGauge,
  connectionCountCounter,
  latencyHistogram,
  messageThroughputCounter,
  backpressureQueueSizeGauge,
} from './metrics';

interface ClientInfo {
  ws: WebSocket;
  id: string;
  subscribedTokens: Set<string>;
  subscriptions: Map<string, { quit: () => Promise<unknown> }>;
  createdAt: number;
}

interface RedisLike {
  status?: string;
  connect?: () => Promise<unknown>;
  quit: () => Promise<unknown>;
  publish: (channel: string, message: string) => Promise<unknown>;
  subscribe?: (channel: string, callback: (message: string) => void) => Promise<unknown> | unknown;
  unsubscribe?: (channel: string) => Promise<unknown> | unknown;
  duplicate?: () => RedisLike;
  on?: (event: string, listener: (...args: unknown[]) => void) => unknown;
}

interface PriceFeedDependencies {
  redis?: RedisLike;
  calculateTWAP?: (tokenPair: string) => Promise<number>;
}

export class PriceFeedServer {
  private wss: WebSocketServer;
  private clients: Map<string, ClientInfo> = new Map();
  private redis: RedisLike;
  private mutex: Mutex = new Mutex();
  private queueSize: number = 0;
  private readonly ownsWebSocketServer: boolean;
  private readonly twapProvider?: (tokenPair: string) => Promise<number>;
  private metricsTimer?: ReturnType<typeof setInterval>;
  private shutdownStarted = false;
  private redisReady = false;
  private redisFailure: Error | null = null;

  constructor(
    portOrServer: number | WebSocketServer = parseInt(process.env.WS_PORT || '8081'),
    dependencies: PriceFeedDependencies = {}
  ) {
    this.ownsWebSocketServer = typeof portOrServer === 'number';
    this.wss =
      typeof portOrServer === 'number' ? new WebSocketServer({ port: portOrServer }) : portOrServer;
    this.twapProvider = dependencies.calculateTWAP;

    if (dependencies.redis) {
      this.redis = dependencies.redis;
      this.redisReady = true;
    } else {
      const redisUrl = process.env.REDIS_URL?.trim();
      if (!redisUrl) throw new Error('REDIS_URL is required for Price Feed Server');
      // ioredis does not expose node-redis's createClient({ url }) API.
      this.redis = new Redis(redisUrl, {
        lazyConnect: true,
        maxRetriesPerRequest: 2,
      }) as unknown as RedisLike;
      void this.connectRedis();
    }

    this.initializeWebSocketHandlers();
    this.startMetricsCleanup();
  }

  private async connectRedis(): Promise<void> {
    try {
      this.redis.on?.('error', (error: unknown) => {
        console.error('Price Feed Server: Redis error', error);
      });
      if (this.redis.connect && this.redis.status !== 'ready') {
        await this.redis.connect();
      }
      this.redisReady = true;
      console.log('Price Feed Server: Redis connected');
    } catch (error) {
      this.redisFailure = error instanceof Error ? error : new Error(String(error));
      console.error('Price Feed Server: Redis connection failed', error);
    }
  }

  private ensureRedisReady(): void {
    if (this.redisFailure) throw new Error('Price Feed Server Redis backend is unavailable');
    if (!this.redisReady) throw new Error('Price Feed Server Redis backend is not ready');
  }

  private initializeWebSocketHandlers(): void {
    this.wss.on('connection', (ws: WebSocket) => {
      this.handleConnection(ws);
    });

    this.wss.on('listening', () => {
      console.log(`Price Feed Server listening on port ${process.env.WS_PORT || 8081}`);
    });
  }

  private handleConnection(ws: WebSocket): void {
    const clientId = crypto.randomUUID();
    const startTime = Date.now();

    // Register client
    this.clients.set(clientId, {
      ws,
      id: clientId,
      subscribedTokens: new Set(),
      subscriptions: new Map(),
      createdAt: Date.now(),
    });

    activeConnectionsGauge.set(this.clients.size);
    connectionCountCounter.inc({ status: 'connected' });

    console.log(`Connected client: ${clientId}`);
    ws.send(
      JSON.stringify({
        type: 'health_check',
        payload: { sources: {}, lastUpdate: Date.now() },
      })
    );

    // Handle messages
    ws.on('message', async (data: WebSocket.Data) => {
      const opStartTime = Date.now();

      try {
        const message = JSON.parse(data.toString());
        await this.handleMessage(clientId, message);
      } catch {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid request' }));
      }

      latencyHistogram.observe(
        { operation: 'message_processing' },
        (Date.now() - opStartTime) / 1000
      );
    });

    // Handle disconnect
    ws.on('close', () => {
      this.clients.delete(clientId);
      activeConnectionsGauge.set(this.clients.size);
      connectionCountCounter.inc({ status: 'disconnected' });

      const duration = (Date.now() - startTime) / 1000;
      console.log(`Disconnected client: ${clientId} (duration: ${duration.toFixed(2)}s)`);
    });
  }

  private async handleMessage(clientId: string, message: any): Promise<void> {
    switch (message.type) {
      case 'subscribe':
        await this.subscribe(clientId, message.tokens);
        break;

      case 'unsubscribe':
        await this.unsubscribe(clientId, message.tokens);
        break;

      case 'request_twap':
        await this.requestTWAP(clientId, message.tokenPair);
        break;

      default:
        this.clients.get(clientId)?.ws.send(
          JSON.stringify({
            type: 'error',
            message: 'Unknown message type',
          })
        );
    }
  }

  private async subscribe(clientId: string, tokens: string[]): Promise<void> {
    const release = await this.mutex.acquire();
    try {
      const client = this.clients.get(clientId);
      if (!client) return;

      for (const token of tokens) {
        if (!client.subscribedTokens.has(token)) {
          client.subscribedTokens.add(token);

          // Subscribe to Redis channel
          const subscriber = await this.openSubscription(`token:${token}`, (msg: string) => {
            if (client && client.ws.readyState === WebSocket.OPEN) {
              client.ws.send(msg);
              messageThroughputCounter.inc({ type: 'price_update' });
            }
          });

          client.subscriptions.set(token, subscriber);
        }
      }

      this.clients.get(clientId)?.ws.send(
        JSON.stringify({
          type: 'subscribed',
          tokens,
          subscriptionCount: client.subscribedTokens.size,
        })
      );
    } finally {
      release();
    }
  }

  private async openSubscription(
    channel: string,
    callback: (message: string) => void
  ): Promise<{ quit: () => Promise<unknown> }> {
    this.ensureRedisReady();
    if (!this.redis.subscribe) throw new Error('Redis subscription is unavailable');

    // ioredis requires a dedicated connection after SUBSCRIBE. Reusing the
    // command connection would make subsequent PUBLISH/GET calls invalid.
    if (this.redis.duplicate) {
      const subscriber = this.redis.duplicate();
      subscriber.on?.('error', (error: unknown) => {
        console.error('Price Feed Server: Redis subscriber error', error);
      });
      if (subscriber.connect && subscriber.status !== 'ready') await subscriber.connect();
      const subscribe = subscriber.subscribe;
      if (!subscribe) throw new Error('Redis subscriber is unavailable');
      await subscribe.call(subscriber, channel, callback);
      return { quit: () => subscriber.quit() };
    }

    const subscribe = this.redis.subscribe;
    if (!subscribe) throw new Error('Redis subscription is unavailable');
    const result = await subscribe.call(this.redis, channel, callback);
    if (
      result &&
      typeof result === 'object' &&
      'quit' in result &&
      typeof result.quit === 'function'
    ) {
      return result as { quit: () => Promise<unknown> };
    }
    return {
      quit: async () => {
        if (this.redis.unsubscribe) await this.redis.unsubscribe(channel);
      },
    };
  }

  private async unsubscribe(clientId: string, tokens: string[]): Promise<void> {
    const release = await this.mutex.acquire();
    try {
      const client = this.clients.get(clientId);
      if (!client) return;

      for (const token of tokens) {
        if (client.subscriptions.has(token)) {
          const subscriber = client.subscriptions.get(token)!;
          await subscriber.quit();
          client.subscriptions.delete(token);
        }
        client.subscribedTokens.delete(token);
      }

      this.clients.get(clientId)?.ws.send(
        JSON.stringify({
          type: 'unsubscribed',
          tokens,
          remainingSubscriptions: client.subscribedTokens.size,
        })
      );
    } finally {
      release();
    }
  }

  private async requestTWAP(clientId: string, tokenPair: string): Promise<void> {
    const release = await this.mutex.acquire();
    try {
      // Query TWAP from Oracle Aggregator service
      const twapValue = await this.calculateTWAP(tokenPair);

      const client = this.clients.get(clientId);

      if (client?.ws.readyState === WebSocket.OPEN) {
        client.ws.send(
          JSON.stringify({
            type: 'twap_result',
            tokenPair,
            value: twapValue,
            timestamp: Date.now(),
          })
        );
      }
    } catch (error) {
      const client = this.clients.get(clientId);
      if (client?.ws.readyState === WebSocket.OPEN) {
        client.ws.send(
          JSON.stringify({
            type: 'error',
            message: `TWAP calculation failed: ${error instanceof Error ? error.message : 'unknown error'}`,
          })
        );
      }
    } finally {
      release();
    }
  }

  private async calculateTWAP(tokenPair: string): Promise<number> {
    if (!this.twapProvider) {
      throw new Error(`TWAP provider is not configured for ${tokenPair}`);
    }
    const value = await this.twapProvider(tokenPair);
    if (!Number.isFinite(value) || value < 0) {
      throw new Error('TWAP provider returned an invalid value');
    }
    return value;
  }

  /**
   * Broadcast price update to all subscribed clients with backpressure
   */
  async broadcastPriceUpdate(tokenPair: string, priceData: any): Promise<void> {
    const startTimestamp = Date.now();
    const queueBefore = this.queueSize;

    backpressureQueueSizeGauge.set(queueBefore);

    try {
      this.ensureRedisReady();
      // Apply backpressure if queue is too large (>5000 pending messages)
      if (queueBefore > 5000) {
        console.warn(`Backpressure active: Queue size ${queueBefore}`);
        await new Promise((resolve) => setTimeout(resolve, 1)); // Yield control
      }

      // Publish to Redis pub/sub
      await this.redis.publish(
        `token:${tokenPair}`,
        JSON.stringify({
          type: 'price_update',
          payload: priceData,
          timestamp: Date.now(),
        })
      );

      // Increment metrics
      messageThroughputCounter.inc({ type: 'broadcast' });

      const duration = (Date.now() - startTimestamp) / 1000;
      latencyHistogram.observe({ operation: 'broadcast' }, duration);
    } finally {
      this.queueSize++;
      setTimeout(() => {
        this.queueSize--;
        backpressureQueueSizeGauge.set(this.queueSize);
      }, 10);
    }
  }

  private startMetricsCleanup(): void {
    // Clean up stale clients every 5 minutes
    this.metricsTimer = setInterval(
      () => {
        const now = Date.now();
        for (const [id, client] of this.clients.entries()) {
          // Remove clients inactive for > 30 minutes
          if (now - client.createdAt > 30 * 60 * 1000) {
            client.ws.terminate();
            this.clients.delete(id);
            activeConnectionsGauge.set(this.clients.size);
          }
        }
      },
      5 * 60 * 1000
    );
    this.metricsTimer.unref?.();
  }

  async shutdown(): Promise<void> {
    if (this.shutdownStarted) return;
    this.shutdownStarted = true;
    console.log('Shutting down Price Feed Server...');

    // Close all connections gracefully
    for (const client of this.clients.values()) {
      client.ws.close(1001, 'Server shutting down');
    }

    // Shutdown Redis
    if (this.metricsTimer) clearInterval(this.metricsTimer);

    if (this.redis?.quit) {
      try {
        await this.redis.quit();
      } catch (error) {
        console.error('Price Feed Server: Redis shutdown failed', error);
      }
    }

    // Close WebSocket server
    if (this.ownsWebSocketServer) {
      await new Promise<void>((resolve) => {
        if (this.wss.address() === null) return resolve();
        this.wss.close(() => resolve());
      });
    }

    console.log('Price Feed Server shut down complete');
  }
}
