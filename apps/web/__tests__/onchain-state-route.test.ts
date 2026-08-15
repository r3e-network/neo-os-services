import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchOnchainState = vi.fn();
const recordOperationLog = vi.fn(async () => {});

vi.mock('@/lib/onchain-state', () => ({ fetchOnchainState }));
vi.mock('@/lib/operation-logs', () => ({ recordOperationLog }));

describe('onchain state route', () => {
  beforeEach(() => {
    vi.resetModules();
    fetchOnchainState.mockReset();
    recordOperationLog.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns 200 with ok:true when the chain read succeeds', async () => {
    fetchOnchainState.mockResolvedValue({
      network: 'testnet',
      generated_at: '2026-06-11T00:00:00.000Z',
      neo_n3: { oracle: {}, datafeed: { records: [] }, error: null },
    });

    const { GET } = await import('../app/api/onchain/state/route');
    const response = await GET(new Request('https://example.test/api/onchain/state?limit=1'));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(recordOperationLog).toHaveBeenCalledWith(
      expect.objectContaining({ route: '/api/onchain/state', httpStatus: 200, error: null })
    );
  });

  it('returns 503 with ok:false when the chain read failed', async () => {
    fetchOnchainState.mockResolvedValue({
      network: 'testnet',
      generated_at: '2026-06-11T00:00:00.000Z',
      neo_n3: { oracle: null, datafeed: null, error: 'rpc request failed with status 502' },
    });

    const { GET } = await import('../app/api/onchain/state/route');
    const response = await GET(new Request('https://example.test/api/onchain/state?limit=1'));

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.neo_n3.error).toBe('rpc request failed with status 502');
    expect(recordOperationLog).toHaveBeenCalledWith(
      expect.objectContaining({
        httpStatus: 503,
        error: 'rpc request failed with status 502',
      })
    );
  });

  it('returns 400 for an unknown network query param without touching the chain', async () => {
    const { GET } = await import('../app/api/onchain/state/route');
    const response = await GET(
      new Request('https://example.test/api/onchain/state?network=banana')
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('unknown network');
    expect(fetchOnchainState).not.toHaveBeenCalled();
  });
});
