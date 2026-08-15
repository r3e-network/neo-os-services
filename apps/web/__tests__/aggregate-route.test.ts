import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchOnchainState = vi.fn();
const buildRuntimeStatusSnapshotForNetwork = vi.fn();

vi.mock('@/lib/onchain-state', () => ({ fetchOnchainState }));
vi.mock('@/lib/runtime-status', () => ({ buildRuntimeStatusSnapshotForNetwork }));
vi.mock('@/components/dashboard/networkSelection', () => ({
  getDashboardNetworkConfig: vi.fn((networkOverride?: string | null) => ({
    networkKey: networkOverride === 'mainnet' ? 'mainnet' : 'testnet',
    label: networkOverride === 'mainnet' ? 'Mainnet' : 'Testnet',
    name: networkOverride === 'mainnet' ? 'Neo N3 Mainnet' : 'Neo N3 Testnet',
    networkMagic: 877933390,
    oracleContract: '0xoracle',
    datafeedContract: '0xdatafeed',
    callbackConsumer: '0xconsumer',
    oracleDomain: 'oracle.example',
    datafeedDomain: 'datafeed.example',
    oracleAttestationExplorerUrl: 'https://attest.oracle',
    datafeedAttestationExplorerUrl: 'https://attest.datafeed',
  })),
}));

describe('onchain aggregate route', () => {
  beforeEach(() => {
    vi.resetModules();
    fetchOnchainState.mockReset();
    buildRuntimeStatusSnapshotForNetwork.mockReset();
    vi.stubEnv('MORPHEUS_NETWORK', 'testnet');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('returns all expected top-level keys with defaults applied', async () => {
    fetchOnchainState.mockResolvedValue({
      network: 'testnet',
      generated_at: '2026-06-11T00:00:00.000Z',
      neo_n3: {
        oracle: { request_fee_display: '0.01 GAS' },
        datafeed: { pair_count: 1, records: [] },
        error: null,
      },
    });
    buildRuntimeStatusSnapshotForNetwork.mockResolvedValue({
      runtime: { status: 'operational', info: { appId: 'test-app' } },
      catalog: {},
    });

    const { GET } = await import('../app/api/onchain/aggregate/route');
    const response = await GET(new Request('https://example.test/api/onchain/aggregate'));

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe(
      'public, s-maxage=5, stale-while-revalidate=10'
    );
    expect(response.headers.get('x-request-id')).toBeTruthy();

    const body = await response.json();
    expect(body).toHaveProperty('onchainState');
    expect(body).toHaveProperty('runtimeStatus');
    expect(body).toHaveProperty('quotes');
    expect(body).toHaveProperty('providers');
    expect(body).toHaveProperty('networkConfig');
    expect(body).toHaveProperty('generated_at');
    expect(body.networkConfig.networkKey).toBe('testnet');
    expect(Array.isArray(body.providers)).toBe(true);
    expect(body.providers.map((p: { id: string }) => p.id)).toEqual([
      'twelvedata',
      'binance-spot',
      'coinbase-spot',
    ]);
    expect(fetchOnchainState).toHaveBeenCalledWith(50, undefined);
  });

  it('validates and applies custom network, pairs and limit query params', async () => {
    fetchOnchainState.mockResolvedValue({
      network: 'mainnet',
      generated_at: '2026-06-11T00:00:00.000Z',
      neo_n3: {
        oracle: {},
        datafeed: { pair_count: 0, records: [] },
        error: null,
      },
    });
    buildRuntimeStatusSnapshotForNetwork.mockResolvedValue({
      runtime: { status: 'operational' },
    });

    const { GET } = await import('../app/api/onchain/aggregate/route');
    const response = await GET(
      new Request(
        'https://example.test/api/onchain/aggregate?network=mainnet&pairs=NEO-USD,BTC-USD&limit=10'
      )
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.networkConfig.networkKey).toBe('mainnet');
    expect(body.quotes).toHaveProperty('TWELVEDATA:NEO-USD');
    expect(body.quotes).toHaveProperty('TWELVEDATA:BTC-USD');
    expect(fetchOnchainState).toHaveBeenCalledWith(10, 'mainnet');
  });

  it('returns 400 for an invalid network query param', async () => {
    const { GET } = await import('../app/api/onchain/aggregate/route');
    const response = await GET(
      new Request('https://example.test/api/onchain/aggregate?network=banana')
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('unknown network');
    expect(fetchOnchainState).not.toHaveBeenCalled();
  });

  it('returns 400 for an out-of-range limit', async () => {
    const { GET } = await import('../app/api/onchain/aggregate/route');
    const response = await GET(new Request('https://example.test/api/onchain/aggregate?limit=999'));

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('Invalid query parameters');
    expect(body.issues).toBeDefined();
  });

  it('returns JSON error without stack traces on internal failure', async () => {
    fetchOnchainState.mockRejectedValue(new Error('boom'));

    const { GET } = await import('../app/api/onchain/aggregate/route');
    const response = await GET(new Request('https://example.test/api/onchain/aggregate'));

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBe('Failed to aggregate dashboard data');
    expect(body.stack).toBeUndefined();
    expect(body.message).toBeUndefined();
  });
});
