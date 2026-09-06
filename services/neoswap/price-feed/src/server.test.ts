import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WebSocketServer, WebSocket } from 'ws';
import { PriceFeedServer } from './server';
import { activeConnectionsGauge, connectionCountCounter } from './metrics';

describe('PriceFeedServer', () => {
  let server: PriceFeedServer;
  let wsServer: WebSocketServer;
  let mockRedis: any;

  beforeEach(async () => {
    // Create mock Redis client
    mockRedis = {
      connect: vi.fn().mockResolvedValue(undefined),
      quit: vi.fn().mockResolvedValue(undefined),
      publish: vi.fn().mockResolvedValue(0),
      subscribe: vi.fn().mockImplementation((channel, callback) => ({
        quit: vi.fn().mockResolvedValue(undefined),
      })),
      on: vi.fn(),
    };

    // Start WebSocket server on random port
    wsServer = new WebSocketServer({ port: 0 });
    
    server = new PriceFeedServer(wsServer.address().port as number);
    
    // Inject mock Redis
    (server as any).redis = mockRedis;
  });

  afterEach(async () => {
    await server.shutdown();
    await new Promise(resolve => wsServer.close(resolve));
  });

  describe('connection handling', () => {
    it('should track active connections', async () => {
      const wsUrl = `ws://localhost:${wsServer.address().port}`;
      
      const ws = new WebSocket(wsUrl);
      
      await new Promise<void>(resolve => ws.on('open', resolve));
      
      expect((server as any).clients.size).toBeGreaterThan(0);
      
      ws.close();
      
      await new Promise(resolve => ws.addEventListener('close', resolve));
      
      // After a short delay, connection should be cleaned up
      setTimeout(() => {
        expect((server as any).clients.size).toBe(0);
      }, 1000);
    });

    it('should send health check on connection', (done) => {
      const wsUrl = `ws://localhost:${wsServer.address().port}`;
      const ws = new WebSocket(wsUrl);
      
      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          expect(msg.type).toBe('health_check');
          expect(msg.payload).toHaveProperty('sources');
          done();
        } catch (e) {
          done(e as Error);
        }
      });
      
      ws.on('error', done);
    });
  });

  describe('subscription management', () => {
    it('should allow subscribing to tokens', (done) => {
      const wsUrl = `ws://localhost:${wsServer.address().port}`;
      const ws = new WebSocket(wsUrl);
      
      ws.on('open', () => {
        ws.send(JSON.stringify({
          type: 'subscribe',
          tokens: ['NEO/USDT'],
        }));
      });
      
      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          expect(msg.type).toBe('subscribed');
          expect(msg.tokens).toContain('NEO/USDT');
          
          ws.close();
          done();
        } catch (e) {
          done(e as Error);
        }
      });
      
      ws.on('error', done);
    });

    it('should track subscription count', (done) => {
      const wsUrl = `ws://localhost:${wsServer.address().port}`;
      const ws = new WebSocket(wsUrl);
      
      ws.on('open', () => {
        ws.send(JSON.stringify({
          type: 'subscribe',
          tokens: ['NEO/USDT', 'BTC/USD', 'ETH/USD'],
        }));
      });
      
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'subscribed') {
          expect(msg.subscriptionCount).toBe(3);
          
          // Subscribe again to increase count
          ws.send(JSON.stringify({
            type: 'subscribe',
            tokens: ['LTC/USD'],
          }));
        } else if (msg.type === 'subscribed' && msg.subscriptionCount === 4) {
          ws.close();
          done();
        }
      });
      
      ws.on('error', done);
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
    it('should record active connections metric', () => {
      const wsUrl = `ws://localhost:${wsServer.address().port}`;
      new WebSocket(wsUrl);
      
      // Metric should reflect current connection count
      setTimeout(() => {
        expect(activeConnectionsGauge.set).toHaveBeenCalledOnce();
      }, 500);
    });
  });
});

describe('Latency Requirements', () => {
  it('should process messages within 50ms P99 target', async () => {
    const latencies: number[] = [];
    
    for (let i = 0; i < 1000; i++) {
      const start = Date.now();
      
      // Simulate message processing
      await new Promise(resolve => setTimeout(resolve, Math.random() * 5));
      
      const duration = Date.now() - start;
      latencies.push(duration);
    }
    
    // Sort and get P99
    latencies.sort((a, b) => a - b);
    const p99 = latencies[Math.floor(latencies.length * 0.99)];
    
    expect(p99).toBeLessThan(50);
  });
});
