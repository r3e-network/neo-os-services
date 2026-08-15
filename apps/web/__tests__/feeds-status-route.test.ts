import { beforeEach, describe, expect, it, vi } from 'vitest';

const getFeedsStatusBody = vi.fn(async () => ({
  body: {
    generated_at: '2026-06-11T00:00:00.000Z',
    network: 'testnet',
    configured_pair_count: 0,
    synced_configured_pair_count: 0,
    configured: [],
  },
  cache: 'miss' as const,
}));
const recordOperationLog = vi.fn(async () => {});

vi.mock('@/lib/feeds-status', () => ({ getFeedsStatusBody }));
vi.mock('@/lib/operation-logs', () => ({ recordOperationLog }));

describe('feeds status route', () => {
  beforeEach(async () => {
    vi.resetModules();
    getFeedsStatusBody.mockClear();
    recordOperationLog.mockClear();
  });

  it('serves the status body with rate-limit headers', async () => {
    const { GET } = await import('../app/api/feeds/status/route');
    const response = await GET(new Request('https://example.test/api/feeds/status'));

    expect(response.status).toBe(200);
    expect(response.headers.get('X-RateLimit-Limit')).toBe('30');
    const body = await response.json();
    expect(body.network).toBe('testnet');
    expect(getFeedsStatusBody).toHaveBeenCalledTimes(1);
    expect(recordOperationLog).toHaveBeenCalledWith(
      expect.objectContaining({
        route: '/api/feeds/status',
        httpStatus: 200,
        metadata: { cache: 'miss' },
      })
    );
  });

  it('rejects callers that exhaust the per-key budget with 429', async () => {
    const { GET } = await import('../app/api/feeds/status/route');
    const { resetRateLimitMap } = await import('../lib/rate-limit');
    resetRateLimitMap();

    let lastStatus = 0;
    for (let i = 0; i < 31; i++) {
      const response = await GET(
        new Request('https://example.test/api/feeds/status', {
          headers: { 'x-real-ip': '8.8.4.4' },
        })
      );
      lastStatus = response.status;
    }
    expect(lastStatus).toBe(429);
  });
});
