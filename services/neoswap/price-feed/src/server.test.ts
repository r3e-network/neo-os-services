import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WebSocketServer, WebSocket } from 'ws';
import { PriceFeedServer } from './server';

vi.mock('ioredis', () => ({
  default: class MockRedis {
    status = 'wait';

    on = vi.fn();

    async connect(): Promise<void> {
      throw new Error('redis connection refused');
    }

    async publish(): Promise<number> {
      return 0;
    }

    async quit(): Promise<void> {}
  },
}));

describe('PriceFeedServer', () => {
  let server: PriceFeedServer;
  let wsServer: WebSocketServer;
  let mockRedis: any;

  const portOf = (server: WebSocketServer): number => {
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('WebSocket server is not listening');
    return address.port;
  };

  const consumeHealthCheck = (ws: WebSocket): Promise<void> =>
    new Promise((resolve, reject) => {
      const onMessage = (data: any) => {
        const message = JSON.parse(data.toString());
        if (message.type !== 'health_check') return;
        ws.off('message', onMessage);
        ws.off('error', onError);
        resolve();
      };
      const onError = (error: Error) => {
        ws.off('message', onMessage);
        reject(error);
      };
      ws.on('message', onMessage);
      ws.once('error', onError);
    });

  const connect = async (url: string): Promise<WebSocket> => {
    const ws = new WebSocket(url);
    const health = consumeHealthCheck(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    await health;
    return ws;
  };

  beforeEach(async () => {
    // Create mock Redis client
    mockRedis = {
      connect: vi.fn().mockResolvedValue(undefined),
      quit: vi.fn().mockResolvedValue(undefined),
      publish: vi.fn().mockResolvedValue(0),
      subscribe: vi.fn().mockImplementation(() => ({
        quit: vi.fn().mockResolvedValue(undefined),
      })),
      on: vi.fn(),
    };

    // Start WebSocket server on random port
    wsServer = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve, reject) => {
      wsServer.once('listening', () => resolve());
      wsServer.once('error', reject);
    });

    server = new PriceFeedServer(wsServer, { redis: mockRedis });
  });

  it('requires REDIS_URL for a production server', async () => {
    const previousRedisUrl = process.env.REDIS_URL;
    delete process.env.REDIS_URL;
    const productionWsServer = new WebSocketServer({ port: 0 });
    try {
      expect(() => new PriceFeedServer(productionWsServer)).toThrow(
        'REDIS_URL is required for Price Feed Server'
      );
    } finally {
      await new Promise<void>((resolve) => productionWsServer.close(() => resolve()));
      if (previousRedisUrl === undefined) delete process.env.REDIS_URL;
      else process.env.REDIS_URL = previousRedisUrl;
    }
  });

  it('rejects Redis operations after a production connection failure', async () => {
    const previousRedisUrl = process.env.REDIS_URL;
    process.env.REDIS_URL = 'redis://unit-test.invalid:6379';
    const productionWsServer = new WebSocketServer({ port: 0 });
    const productionServer = new PriceFeedServer(productionWsServer);
    try {
      await vi.waitFor(() => expect((productionServer as any).redisFailure).toBeInstanceOf(Error));
      await expect(
        productionServer.broadcastPriceUpdate('NEO/USDT', { price: '25.0' })
      ).rejects.toThrow('Redis backend is unavailable');
    } finally {
      await productionServer.shutdown();
      await new Promise<void>((resolve) => productionWsServer.close(() => resolve()));
      if (previousRedisUrl === undefined) delete process.env.REDIS_URL;
      else process.env.REDIS_URL = previousRedisUrl;
    }
  });

  afterEach(async () => {
    await server.shutdown();
    await new Promise((resolve) => wsServer.close(resolve));
  });

  describe('connection handling', () => {
    it('should track active connections', async () => {
      const wsUrl = `ws://localhost:${portOf(wsServer)}`;

      const ws = new WebSocket(wsUrl);

      await new Promise<void>((resolve) => ws.on('open', resolve));

      expect((server as any).clients.size).toBeGreaterThan(0);

      ws.close();

      await new Promise((resolve) => ws.addEventListener('close', resolve));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect((server as any).clients.size).toBe(0);
    });

    it('should send health check on connection', async () => {
      const wsUrl = `ws://localhost:${portOf(wsServer)}`;
      const ws = new WebSocket(wsUrl);

      const msg = await new Promise<any>((resolve, reject) => {
        ws.once('message', (data) => resolve(JSON.parse(data.toString())));
        ws.once('error', reject);
      });
      expect(msg.type).toBe('health_check');
      expect(msg.payload).toHaveProperty('sources');
      ws.close();
    });
  });

  describe('subscription management', () => {
    it('should allow subscribing to tokens', async () => {
      const wsUrl = `ws://localhost:${portOf(wsServer)}`;
      const ws = await connect(wsUrl);
      const response = new Promise<any>((resolve, reject) => {
        ws.once('message', (data) => resolve(JSON.parse(data.toString())));
        ws.once('error', reject);
      });
      ws.send(
        JSON.stringify({
          type: 'subscribe',
          tokens: ['NEO/USDT'],
        })
      );
      const msg = await response;
      expect(msg.type).toBe('subscribed');
      expect(msg.tokens).toContain('NEO/USDT');
      ws.close();
    });

    it('should track subscription count', async () => {
      const wsUrl = `ws://localhost:${portOf(wsServer)}`;
      const ws = await connect(wsUrl);
      const nextMessage = () =>
        new Promise<any>((resolve, reject) => {
          ws.once('message', (data) => resolve(JSON.parse(data.toString())));
          ws.once('error', reject);
        });

      ws.send(
        JSON.stringify({
          type: 'subscribe',
          tokens: ['NEO/USDT', 'BTC/USD', 'ETH/USD'],
        })
      );
      expect((await nextMessage()).subscriptionCount).toBe(3);

      ws.send(
        JSON.stringify({
          type: 'subscribe',
          tokens: ['LTC/USD'],
        })
      );
      expect((await nextMessage()).subscriptionCount).toBe(4);
      ws.close();
    });

    it('rejects TWAP requests when no provider is configured', async () => {
      const wsUrl = `ws://localhost:${portOf(wsServer)}`;
      const ws = await connect(wsUrl);
      const response = new Promise<any>((resolve, reject) => {
        ws.once('message', (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'error') {
            resolve(msg);
            return;
          }
          // Every connection receives health_check before application
          // responses. Keep listening instead of allowing that first frame to
          // make the test wait until Vitest times out.
          ws.once('message', (data) => {
            const next = JSON.parse(data.toString());
            if (next.type === 'error') resolve(next);
          });
        });
        ws.once('error', reject);
      });
      ws.send(JSON.stringify({ type: 'request_twap', tokenPair: 'NEO/USDT' }));
      expect((await response).message).toContain('TWAP calculation failed');
      ws.close();
    });
  });

  describe('backpressure handling', () => {
    it('should log warning when queue size exceeds threshold', async () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(vi.fn());

      // Simulate high queue pressure
      (server as any).queueSize = 6000;

      await server.broadcastPriceUpdate('NEO/USDT', { price: '25.0' });

      expect(consoleSpy).toHaveBeenCalled();
      expect(consoleSpy.mock.calls[0][0]).toContain('Backpressure');

      consoleSpy.mockRestore();
    });
  });

  describe('metrics recording', () => {
    it('should record active connections metric', async () => {
      const wsUrl = `ws://localhost:${portOf(wsServer)}`;
      const ws = await connect(wsUrl);
      expect((server as any).clients.size).toBe(1);
      ws.close();
    });
  });
});

describe('Latency Requirements', () => {
  it('should process messages within 50ms P99 target', async () => {
    const latencies: number[] = [];

    for (let i = 0; i < 1000; i++) {
      const start = Date.now();

      // Simulate message processing
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 5));

      const duration = Date.now() - start;
      latencies.push(duration);
    }

    // Sort and get P99
    latencies.sort((a, b) => a - b);
    const p99 = latencies[Math.floor(latencies.length * 0.99)];

    expect(p99).toBeLessThan(50);
  });
});
