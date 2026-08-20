import { KNOWN_FEED_PROVIDER_PREFIXES } from './feed-defaults';
import { trimString } from './strings';

// Shared staleness policy for everything this app serves off the on-chain
// MorpheusDataFeed.
//
// Why this exists (2026-08): the serving path had no age check at all. On
// 2026-08-17 `getLatest("TWELVEDATA:BTC-USD")` returned a 2026-07-29 timestamp
// — 19.1 days, 612x the budget below — and `/api/feeds/[symbol]` still answered
// HTTP 200 `status:"ok"` with `cache-control: public, max-age=15`, while
// `lib/feeds-status.ts` counted the pair as "synced" because a record existed
// at any age. The only staleness budget in the repo lived in
// `deploy/feed-pusher/feed-monitor.mjs`, which writes a JSON file on a box and
// exits non-zero — a signal nothing was subscribed to.
//
// The numbers here deliberately mirror that monitor (MAX_STALE_SEC + 900 s of
// margin, plus the TradFi market-closed widening) so the public API, the
// operator status page and the box monitor cannot disagree about what "stale"
// means. `__tests__/feed-freshness.test.ts` imports the monitor's own
// `staleAgeLimit()` and asserts the two agree; if someone retunes one side, that
// test fails rather than silently reopening this hole.

// The pusher's force-refresh interval. A flat symbol legitimately ages up to
// this long before its scheduled heartbeat write.
export const DEFAULT_FEED_MAX_STALE_SECONDS = 1800;
// One push cycle of margin on top, matching feed-monitor.mjs `MAX_AGE`.
export const FEED_STALE_MARGIN_SECONDS = 900;
// TradFi (forex/commodity) pairs do not trade across a market close, so their
// on-chain price legitimately ages from Friday close to Monday open.
export const DEFAULT_TRADFI_WEEKEND_AGE_SECONDS = 270_000;
export const DEFAULT_TRADFI_PAIRS = ['EUR-USD', 'GBP-USD', 'JPY-USD', 'CNY-USD', 'WTI-USD'];

export type FeedAgeClassification = {
  /** Seconds between the on-chain record timestamp and `now`. Null if unparseable. */
  age_seconds: number | null;
  /** The budget this pair was judged against, after any market-closed widening. */
  stale_after_seconds: number;
  /** True when the record is older than its budget, or has no usable timestamp. */
  stale: boolean;
  timestamp: number | null;
  timestamp_iso: string | null;
  /** True when the TradFi widening was applied for this pair at this instant. */
  market_closed: boolean;
};

function positiveNumberFromEnv(name: string, fallback: number) {
  const parsed = Number(trimString(process.env[name] || ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function csvSetFromEnv(name: string, fallback: string[]) {
  const raw = trimString(process.env[name] || '');
  const values = (raw ? raw.split(',') : fallback)
    .map((entry) => trimString(entry).toUpperCase())
    .filter(Boolean);
  return new Set(values);
}

/** Strip the provider prefix so `TWELVEDATA:EUR-USD` matches the bare TradFi list. */
export function bareFeedPair(pair: unknown) {
  const normalized = trimString(pair).toUpperCase();
  for (const prefix of KNOWN_FEED_PROVIDER_PREFIXES) {
    if (normalized.startsWith(prefix)) return normalized.slice(prefix.length);
  }
  return normalized;
}

/** Base staleness budget for a continuously traded pair, in seconds. */
export function feedStaleAfterSeconds() {
  const maxStale = positiveNumberFromEnv(
    'MORPHEUS_FEED_MAX_STALE_SEC',
    DEFAULT_FEED_MAX_STALE_SECONDS
  );
  return positiveNumberFromEnv(
    'MORPHEUS_FEED_STALE_AFTER_SEC',
    maxStale + FEED_STALE_MARGIN_SECONDS
  );
}

/** Weekend or configured UTC holiday — same predicate as feed-monitor.mjs. */
export function isTradFiMarketClosed(date: Date) {
  const day = date.getUTCDay();
  if (day === 0 || day === 6) return true;
  const holidays = csvSetFromEnv('MORPHEUS_FEED_TRADFI_HOLIDAYS', []);
  return holidays.has(date.toISOString().slice(0, 10));
}

/** Per-pair budget: TradFi pairs widen while their market is closed. */
export function staleAfterSecondsForPair(pair: unknown, date: Date) {
  const base = feedStaleAfterSeconds();
  const tradfiPairs = csvSetFromEnv('MORPHEUS_FEED_TRADFI_PAIRS', DEFAULT_TRADFI_PAIRS);
  if (!tradfiPairs.has(bareFeedPair(pair)) || !isTradFiMarketClosed(date)) return base;
  const weekendAge = positiveNumberFromEnv(
    'MORPHEUS_FEED_TRADFI_WEEKEND_AGE_SEC',
    DEFAULT_TRADFI_WEEKEND_AGE_SECONDS
  );
  return Math.max(base, weekendAge);
}

/**
 * Classify one on-chain record's age against its budget.
 *
 * Fails closed: a missing, non-numeric, non-positive or future-dated timestamp
 * is reported stale rather than fresh. Serving a price whose age we cannot
 * establish is the exact failure this module exists to stop.
 */
export function classifyFeedAge(
  timestampSeconds: unknown,
  options: { pair?: unknown; nowMs?: number } = {}
): FeedAgeClassification {
  const nowMs = options.nowMs ?? Date.now();
  const date = new Date(nowMs);
  const staleAfter = staleAfterSecondsForPair(options.pair ?? '', date);
  const marketClosed =
    csvSetFromEnv('MORPHEUS_FEED_TRADFI_PAIRS', DEFAULT_TRADFI_PAIRS).has(
      bareFeedPair(options.pair ?? '')
    ) && isTradFiMarketClosed(date);

  const timestamp = Number(timestampSeconds);
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return {
      age_seconds: null,
      stale_after_seconds: staleAfter,
      stale: true,
      timestamp: null,
      timestamp_iso: null,
      market_closed: marketClosed,
    };
  }

  const ageSeconds = Math.floor(nowMs / 1000) - timestamp;
  return {
    age_seconds: ageSeconds,
    stale_after_seconds: staleAfter,
    // A record timestamped in the future is a clock or pusher fault, not
    // freshness — treat it as stale so it cannot be served as ok.
    stale: ageSeconds > staleAfter || ageSeconds < 0,
    timestamp,
    timestamp_iso: new Date(timestamp * 1000).toISOString(),
    market_closed: marketClosed,
  };
}
