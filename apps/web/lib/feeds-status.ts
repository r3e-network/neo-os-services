import { DEFAULT_FEED_SYMBOLS, getFeedDescriptor, normalizeFeedSymbol } from '@/lib/feed-defaults';
import { fetchOnchainState } from '@/lib/onchain-state';

const STATUS_CACHE_TTL_MS = 30_000;

export type FeedsStatusBody = {
  generated_at: string;
  network: string;
  configured_pair_count: number;
  synced_configured_pair_count: number;
  configured: Array<Record<string, unknown>>;
};

export type FeedsStatusOptions = {
  quoteTimeoutMs?: number;
};

let cachedStatus: { body: FeedsStatusBody; expiresAt: number } | null = null;

// Re-homed (2026-06): the per-pair status is derived entirely from the on-chain
// MorpheusDataFeed (the trustless source the box updates) instead of a live quote
// fetched from the retired runtime. The `live` overlay now reflects the on-chain
// record; delta_pct is 0 for a synced pair (chain IS the source of record) and null
// when the pair is not yet on-chain. The FeedsStatusBody shape is preserved.
export async function buildFeedsStatusBody(
  _options: FeedsStatusOptions = {}
): Promise<FeedsStatusBody> {
  const onchain = await fetchOnchainState(200);
  const chainRecords = Array.isArray(onchain.neo_n3?.datafeed?.records)
    ? onchain.neo_n3.datafeed.records
    : [];

  const configured = DEFAULT_FEED_SYMBOLS.map((pair) => {
    const descriptor = getFeedDescriptor(pair);
    const chainRecord =
      chainRecords.find((entry) => normalizeFeedSymbol(entry.pair) === pair) || null;
    const live = chainRecord
      ? {
          price: Number(chainRecord.price_display),
          price_display: chainRecord.price_display,
          timestamp: Number(chainRecord.timestamp),
          timestamp_iso: chainRecord.timestamp_iso,
          round_id: chainRecord.round_id,
          source: 'onchain',
        }
      : { error: 'not_synced', source: 'onchain' };

    return {
      pair,
      storage_pair: pair,
      synced: Boolean(chainRecord),
      descriptor,
      chain: chainRecord,
      live,
      delta_pct: chainRecord ? 0 : null,
    };
  });

  return {
    generated_at: new Date().toISOString(),
    network: onchain.network,
    configured_pair_count: DEFAULT_FEED_SYMBOLS.length,
    synced_configured_pair_count: configured.filter((entry) => entry.synced).length,
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
