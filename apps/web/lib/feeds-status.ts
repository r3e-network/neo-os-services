import { DEFAULT_FEED_SYMBOLS, getFeedDescriptor, normalizeFeedSymbol } from '@/lib/feed-defaults';
import { classifyFeedAge } from '@/lib/feed-freshness';
import { fetchOnchainState } from '@/lib/onchain-state';

const STATUS_CACHE_TTL_MS = 30_000;

export type FeedsStatusBody = {
  generated_at: string;
  network: string;
  /** 'ok' when every configured pair is synced and within its budget. */
  status: 'ok' | 'degraded';
  configured_pair_count: number;
  /** Back-compat: a chain record exists at ANY age. Not a health signal. */
  synced_configured_pair_count: number;
  /** Synced AND within its staleness budget. This is the health signal. */
  fresh_configured_pair_count: number;
  stale_configured_pair_count: number;
  not_synced_configured_pair_count: number;
  /** Age of the oldest synced pair, and which pair that is. */
  max_age_seconds: number | null;
  oldest_pair: string | null;
  /** Human-readable problems, empty when healthy. Mirrors feed-monitor.mjs. */
  alerts: string[];
  configured: Array<Record<string, unknown>>;
};

export type FeedsStatusOptions = {
  quoteTimeoutMs?: number;
};

let cachedStatus: { body: FeedsStatusBody; expiresAt: number } | null = null;

// Re-homed (2026-06): the per-pair status is derived entirely from the on-chain
// MorpheusDataFeed (the trustless source the box updates) instead of a live quote
// fetched from the retired runtime. The `live` overlay reflects the on-chain record.
//
// Freshness added (2026-08). Two things were wrong here and they compounded:
//
//   1. `synced` meant "a chain record exists at any age", so this page reported
//      33/33 synced while every mainnet pair was 19+ days stale (and six
//      commodity pairs 72 days, two 158 days). `synced` is kept for wire
//      compatibility but is no longer the health signal — `fresh` is.
//   2. `delta_pct` was hardcoded to 0 for every synced pair. That is an
//      assertion of "0% drift from the true price", which this builder has no
//      basis to make: after the 2026-06 re-home there is no reference quote in
//      the request path at all, only the chain record being compared with
//      itself. It now reports null with an explicit `delta_basis`, because a
//      fabricated 0 is worse than an honest gap — it is precisely what made the
//      status page structurally incapable of showing the outage. Restoring a
//      real delta needs an upstream quote (provider key + per-pair fan-out) and
//      is deliberately not faked here in the meantime.
export async function buildFeedsStatusBody(
  _options: FeedsStatusOptions = {}
): Promise<FeedsStatusBody> {
  const onchain = await fetchOnchainState(200);
  const chainRecords = Array.isArray(onchain.neo_n3?.datafeed?.records)
    ? onchain.neo_n3.datafeed.records
    : [];
  const nowMs = Date.now();

  const configured = DEFAULT_FEED_SYMBOLS.map((pair) => {
    const descriptor = getFeedDescriptor(pair);
    const chainRecord =
      chainRecords.find((entry) => normalizeFeedSymbol(entry.pair) === pair) || null;
    const age = chainRecord ? classifyFeedAge(chainRecord.timestamp, { pair, nowMs }) : null;
    const fresh = Boolean(chainRecord && age && !age.stale);
    const live = chainRecord
      ? {
          price: Number(chainRecord.price_display),
          price_display: chainRecord.price_display,
          timestamp: Number(chainRecord.timestamp),
          timestamp_iso: chainRecord.timestamp_iso,
          round_id: chainRecord.round_id,
          source: 'onchain',
          ...(fresh ? {} : { error: 'stale' }),
        }
      : { error: 'not_synced', source: 'onchain' };

    return {
      pair,
      storage_pair: pair,
      synced: Boolean(chainRecord),
      fresh,
      status: !chainRecord ? 'not_synced' : fresh ? 'fresh' : 'stale',
      age_seconds: age ? age.age_seconds : null,
      stale_after_seconds: age ? age.stale_after_seconds : null,
      stale: chainRecord ? Boolean(age?.stale) : null,
      market_closed: age ? age.market_closed : null,
      descriptor,
      chain: chainRecord,
      live,
      delta_pct: null,
      delta_basis: 'no_reference_quote',
    };
  });

  const syncedEntries = configured.filter((entry) => entry.synced);
  const staleEntries = syncedEntries.filter((entry) => !entry.fresh);
  const notSynced = configured.filter((entry) => !entry.synced);
  const oldest = syncedEntries.reduce<(typeof configured)[number] | null>((worst, entry) => {
    if (typeof entry.age_seconds !== 'number') return worst;
    if (!worst || typeof worst.age_seconds !== 'number') return entry;
    return entry.age_seconds > worst.age_seconds ? entry : worst;
  }, null);

  const alerts: string[] = [];
  for (const entry of staleEntries) {
    const minutes = typeof entry.age_seconds === 'number' ? Math.round(entry.age_seconds / 60) : -1;
    alerts.push(
      `FEED STALE ${entry.pair} age=${minutes < 0 ? 'unknown' : `${minutes}min`} limit=${
        typeof entry.stale_after_seconds === 'number'
          ? `${Math.round(entry.stale_after_seconds / 60)}min`
          : 'unknown'
      }`
    );
  }
  for (const entry of notSynced) alerts.push(`FEED NOT SYNCED ${entry.pair}`);

  return {
    generated_at: new Date().toISOString(),
    network: onchain.network,
    status: alerts.length ? 'degraded' : 'ok',
    configured_pair_count: DEFAULT_FEED_SYMBOLS.length,
    synced_configured_pair_count: syncedEntries.length,
    fresh_configured_pair_count: syncedEntries.length - staleEntries.length,
    stale_configured_pair_count: staleEntries.length,
    not_synced_configured_pair_count: notSynced.length,
    max_age_seconds: oldest && typeof oldest.age_seconds === 'number' ? oldest.age_seconds : null,
    oldest_pair: oldest ? oldest.pair : null,
    alerts,
    configured,
  };
}

export async function getFeedsStatusBody(
  options: FeedsStatusOptions = {}
): Promise<{ body: FeedsStatusBody; cache: 'hit' | 'miss' }> {
  const now = Date.now();
  if (cachedStatus && cachedStatus.expiresAt > now) {
    return { body: cachedStatus.body, cache: 'hit' };
  }
  const body = await buildFeedsStatusBody(options);
  cachedStatus = { body, expiresAt: now + STATUS_CACHE_TTL_MS };
  return { body, cache: 'miss' };
}

export function resetFeedsStatusCache() {
  cachedStatus = null;
}
