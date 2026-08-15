import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sendHeartbeat = vi.fn(async () => true);
const recordOperationLog = vi.fn(
  () =>
    new Promise<void>(() => {
      // Keep pending to prove the health route does not wait on operation logging.
    })
);

vi.mock('@/lib/heartbeat', () => ({ sendHeartbeat }));
vi.mock('@/lib/operation-logs', () => ({ recordOperationLog }));

describe('cron health route', () => {
  beforeEach(() => {
    vi.resetModules();
    sendHeartbeat.mockClear();
    recordOperationLog.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('rejects unauthenticated requests without firing the heartbeat', async () => {
    vi.stubEnv('MORPHEUS_CRON_SECRET', 'cron-secret');
    vi.stubEnv('MORPHEUS_BETTERSTACK_CRON_HEALTH_HEARTBEAT_URL', 'https://heartbeat.example');

    const { GET } = await import('../app/api/cron/health/route');
    const response = await GET(new Request('https://example.test/api/cron/health'));

    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({ error: 'unauthorized' });
    expect(sendHeartbeat).not.toHaveBeenCalled();
    expect(recordOperationLog).toHaveBeenCalledWith(
      expect.objectContaining({
        route: '/api/cron/health',
        httpStatus: 401,
        error: 'unauthorized',
      })
    );
  });

  it('waits for BetterStack heartbeat for authorized cron requests but does not block on operation logging', async () => {
    vi.stubEnv('MORPHEUS_CRON_SECRET', 'cron-secret');
    vi.stubEnv('MORPHEUS_BETTERSTACK_CRON_HEALTH_HEARTBEAT_URL', 'https://heartbeat.example');

    const { GET } = await import('../app/api/cron/health/route');
    const response = await GET(
      new Request('https://example.test/api/cron/health', {
        headers: { authorization: 'Bearer cron-secret' },
      })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({
      status: 'ok',
      service: 'morpheus-cron',
      heartbeat_sent: true,
    });
    expect(sendHeartbeat).toHaveBeenCalledWith('https://heartbeat.example', {
      status: 'ok',
      service: 'morpheus-cron',
    });
    expect(recordOperationLog).toHaveBeenCalledWith(
      expect.objectContaining({
        route: '/api/cron/health',
        method: 'GET',
        category: 'system',
        httpStatus: 200,
      })
    );
  });

  it('accepts the x-morpheus-cron header secret', async () => {
    vi.stubEnv('MORPHEUS_CRON_SECRET', 'cron-secret');

    const { GET } = await import('../app/api/cron/health/route');
    const response = await GET(
      new Request('https://example.test/api/cron/health', {
        headers: { 'x-morpheus-cron': 'cron-secret' },
      })
    );

    expect(response.status).toBe(200);
  });

  it('accepts Vercel CRON_SECRET when the legacy operator secret is also set', async () => {
    vi.stubEnv('MORPHEUS_CRON_SECRET', 'operator-secret');
    vi.stubEnv('CRON_SECRET', 'vercel-secret');

    const { GET } = await import('../app/api/cron/health/route');
    const response = await GET(
      new Request('https://example.test/api/cron/health', {
        headers: { authorization: 'Bearer vercel-secret' },
      })
    );

    expect(response.status).toBe(200);
  });
});
