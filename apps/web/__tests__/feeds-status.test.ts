import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_FEED_SYMBOLS } from '../lib/feed-defaults';

const SAMPLE = DEFAULT_FEED_SYMBOLS[0];
const SECOND = DEFAULT_FEED_SYMBOLS[1];

// Wednesday, so no TradFi market-closed widening is in play.
const NOW_MS = Date.UTC(2026, 7, 12, 12, 0, 0);
const NOW_SEC = Math.floor(NOW_MS / 1000);

function record(pair: string, timestamp: number) {
  return {
    pair,
    round_id: '7',
    price_units: '2287000',
    price_display: '2.287000',
    price_scale_decimals: 6,
    timestamp: String(timestamp),
    timestamp_iso: new Date(timestamp * 1000).toISOString(),
  };
}

let records: ReturnType<typeof record>[] = [];

const fetchOnchainState = vi.fn(async () => ({
  network: 'testnet',
  generated_at: '2026-06-11T00:00:00.000Z',
  neo_n3: { oracle: null, datafeed: { records }, error: null },
}));

vi.mock('@/lib/onchain-state', () => ({ fetchOnchainState }));

describe('feeds status builder (on-chain re-home)', () => {
  beforeEach(async () => {
    const { resetFeedsStatusCache } = await import('../lib/feeds-status');
    resetFeedsStatusCache();
    fetchOnchainState.mockClear();
    records = [record(SAMPLE, NOW_SEC - 60)];
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
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
    expect(synced.fresh).toBe(true);
    expect(synced.status).toBe('fresh');
    expect(synced.age_seconds).toBe(60);
    expect(synced.live.source).toBe('onchain');
    expect(synced.live.price).toBe(2.287);

    const notSynced = body.configured.find((entry) => entry.pair !== SAMPLE) as Record<string, any>;
    expect(notSynced.synced).toBe(false);
    expect(notSynced.status).toBe('not_synced');
    expect(notSynced.live.error).toBe('not_synced');
    expect(notSynced.age_seconds).toBeNull();

    expect(body.synced_configured_pair_count).toBe(1);
    expect(body.fresh_configured_pair_count).toBe(1);
    expect(body.stale_configured_pair_count).toBe(0);
  });

  // The regression this page was structurally incapable of showing: on
  // 2026-08-17 every mainnet pair carried a 19-day-old record and this builder
  // still counted all of them as "synced" with delta_pct 0.
  it('counts an aged record as stale rather than as a healthy synced pair', async () => {
    records = [record(SAMPLE, NOW_SEC - 1_652_577), record(SECOND, NOW_SEC - 120)];

    const { buildFeedsStatusBody } = await import('../lib/feeds-status');
    const body = await buildFeedsStatusBody();

    const stale = body.configured.find((entry) => entry.pair === SAMPLE) as Record<string, any>;
    expect(stale.synced).toBe(true); // back-compat field: a record does exist
    expect(stale.fresh).toBe(false); // …but it is not healthy
    expect(stale.status).toBe('stale');
    expect(stale.stale).toBe(true);
    expect(stale.age_seconds).toBe(1652577);
    expect(stale.stale_after_seconds).toBe(2700);
    expect(stale.live.error).toBe('stale');

    expect(body.status).toBe('degraded');
    expect(body.synced_configured_pair_count).toBe(2);
    expect(body.fresh_configured_pair_count).toBe(1);
    expect(body.stale_configured_pair_count).toBe(1);
    expect(body.max_age_seconds).toBe(1652577);
    expect(body.oldest_pair).toBe(SAMPLE);
    expect(body.alerts.some((alert) => alert.startsWith(`FEED STALE ${SAMPLE}`))).toBe(true);
  });

  it('never reports a fabricated zero delta', async () => {
    const { buildFeedsStatusBody } = await import('../lib/feeds-status');
    const body = await buildFeedsStatusBody();
    for (const entry of body.configured as Array<Record<string, any>>) {
      expect(entry.delta_pct).toBeNull();
      expect(entry.delta_basis).toBe('no_reference_quote');
    }
  });

  it('reports degraded while any configured pair is missing from the chain', async () => {
    const { buildFeedsStatusBody } = await import('../lib/feeds-status');
    const body = await buildFeedsStatusBody();
    expect(body.status).toBe('degraded');
    expect(body.not_synced_configured_pair_count).toBe(DEFAULT_FEED_SYMBOLS.length - 1);
    expect(body.alerts.some((alert) => alert.startsWith('FEED NOT SYNCED'))).toBe(true);
  });

  it('reports ok only when every configured pair is synced and fresh', async () => {
    records = DEFAULT_FEED_SYMBOLS.map((pair) => record(pair, NOW_SEC - 30));

    const { buildFeedsStatusBody } = await import('../lib/feeds-status');
    const body = await buildFeedsStatusBody();

    expect(body.status).toBe('ok');
    expect(body.alerts).toEqual([]);
    expect(body.fresh_configured_pair_count).toBe(DEFAULT_FEED_SYMBOLS.length);
    expect(body.stale_configured_pair_count).toBe(0);
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
