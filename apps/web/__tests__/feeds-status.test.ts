import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_FEED_SYMBOLS } from '../lib/feed-defaults';

const SAMPLE = DEFAULT_FEED_SYMBOLS[0];

const fetchOnchainState = vi.fn(async () => ({
  network: 'testnet',
  generated_at: '2026-06-11T00:00:00.000Z',
  neo_n3: {
    oracle: null,
    datafeed: {
      records: [
        {
          pair: SAMPLE,
          round_id: '7',
          price_units: '2287000',
          price_display: '2.287000',
          price_scale_decimals: 6,
          timestamp: '1781523281',
          timestamp_iso: '2026-06-15T11:34:41.000Z',
        },
      ],
    },
    error: null,
  },
}));

vi.mock('@/lib/onchain-state', () => ({ fetchOnchainState }));

describe('feeds status builder (on-chain re-home)', () => {
  beforeEach(async () => {
    const { resetFeedsStatusCache } = await import('../lib/feeds-status');
    resetFeedsStatusCache();
    fetchOnchainState.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('derives the live overlay from on-chain records with no per-pair upstream calls', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { buildFeedsStatusBody } = await import('../lib/feeds-status');
    const body = await buildFeedsStatusBody();

    expect(body.configured).toHaveLength(DEFAULT_FEED_SYMBOLS.length);
    // No per-pair runtime quote fan-out — everything comes from one on-chain read.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fetchOnchainState).toHaveBeenCalledTimes(1);

    const synced = body.configured.find((entry) => entry.pair === SAMPLE) as Record<string, any>;
    expect(synced.synced).toBe(true);
    expect(synced.live.source).toBe('onchain');
    expect(synced.live.price).toBe(2.287);
    expect(synced.delta_pct).toBe(0);

    const notSynced = body.configured.find((entry) => entry.pair !== SAMPLE) as Record<string, any>;
    expect(notSynced.synced).toBe(false);
    expect(notSynced.live.error).toBe('not_synced');
    expect(notSynced.delta_pct).toBeNull();

    expect(body.synced_configured_pair_count).toBe(1);
  });

  it('serves repeat callers from the short server-side cache', async () => {
    vi.stubGlobal('fetch', vi.fn());

    const { getFeedsStatusBody } = await import('../lib/feeds-status');
    const first = await getFeedsStatusBody();
    const second = await getFeedsStatusBody();

    expect(first.cache).toBe('miss');
    expect(second.cache).toBe('hit');
    expect(second.body).toBe(first.body);
    expect(fetchOnchainState).toHaveBeenCalledTimes(1);
  });
});
