import {
  env,
  normalizeMorpheusNetwork,
  resolvePayloadNetwork,
  trimString,
} from '../../platform/core.js';

export const DEFAULT_FEED_STATE_PATH = '/data/morpheus-feed-state.json';
export const MAINNET_FEED_CHANGE_THRESHOLD_BPS = 10;
export const MAINNET_FEED_MIN_UPDATE_INTERVAL_MS = 60_000;
export const MAINNET_FEED_STALE_AFTER_MS = 300_000;
export const DEFAULT_FEED_PROVIDER_TIMEOUT_MS = 8_000;
export const MAX_FEED_PROVIDER_TIMEOUT_MS = 10_000;
export const DEFAULT_FEED_SUBMISSION_WAIT_TIMEOUT_MS = 8_000;
export const FEED_PRICE_DECIMALS = 6;

export function resolveFeedNetwork(input = {}) {
  return resolvePayloadNetwork(
    input,
    normalizeMorpheusNetwork(env('MORPHEUS_NETWORK', 'NEXT_PUBLIC_MORPHEUS_NETWORK') || 'testnet')
  );
}

export function resolveFeedTargetChain(_value = 'neo_n3') {
  return 'neo_n3';
}

export function resolveFeedScope(input = {}, fallbackTargetChain = 'neo_n3') {
  const source = input && typeof input === 'object' ? input : {};
  return {
    network: resolveFeedNetwork(source),
    targetChain: resolveFeedTargetChain(
      source.target_chain ?? source.targetChain ?? fallbackTargetChain
    ),
  };
}

export function isEnabled(rawValue, fallback = true) {
  const normalized = trimString(rawValue).toLowerCase();
  if (!normalized) return fallback;
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

export function normalizeBooleanLike(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const normalized = trimString(value).toLowerCase();
  if (!normalized) return fallback;
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

export function hasOwnPayloadKey(payload = {}, key) {
  return Object.prototype.hasOwnProperty.call(payload, key);
}

// --- B9: feed timestamp clamp (strict-monotonic MorpheusDataFeed protection) ---
//
// MorpheusDataFeed.UpdateFeedInternal enforces `timestamp >= existing.Timestamp`.
// An unbounded upstream provider timestamp that lands far in the future would be
// accepted once, then PERMANENTLY stall the feed: every subsequent real-clock
// timestamp is < the poisoned value, so all updates revert "stale timestamp"
// until an admin runs AdminResetFeed. We defend the submission lane by:
//   1. rejecting an upstream timestamp more than ~5 minutes in the future (a
//      clearly-bad/poisoned observation — fail loudly instead of anchoring it),
//   2. clamping the submitted timestamp to
//        max(prevTs + 1, min(upstream, now + skew))
//      so it is never more than a small skew window ahead of the local clock and
//      is always strictly above the last on-chain timestamp (monotonic-safe).
export const FEED_TIMESTAMP_MAX_FUTURE_SECONDS = 300; // 5 min hard reject
export const FEED_TIMESTAMP_FUTURE_SKEW_SECONDS = 60; // tolerated clock-skew clamp window

export function resolveFeedTimestampMaxFutureSeconds() {
  const raw = Number(env('MORPHEUS_FEED_TIMESTAMP_MAX_FUTURE_SECONDS'));
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : FEED_TIMESTAMP_MAX_FUTURE_SECONDS;
}

export function resolveFeedTimestampFutureSkewSeconds() {
  const raw = Number(env('MORPHEUS_FEED_TIMESTAMP_FUTURE_SKEW_SECONDS'));
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : FEED_TIMESTAMP_FUTURE_SKEW_SECONDS;
}

export class FeedTimestampError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FeedTimestampError';
    this.code = 'feed_timestamp_rejected';
  }
}

/**
 * Clamp an upstream feed observation timestamp to a value safe to anchor on the
 * strictly-monotonic MorpheusDataFeed. Throws FeedTimestampError when the
 * upstream timestamp is too far in the future to trust.
 *
 * @returns {number} the safe timestamp in unix seconds.
 */
export function clampFeedTimestampSec({
  upstreamSec,
  prevTs = 0,
  nowSec = Math.floor(Date.now() / 1000),
  maxFutureSeconds = resolveFeedTimestampMaxFutureSeconds(),
  futureSkewSeconds = resolveFeedTimestampFutureSkewSeconds(),
} = {}) {
  const now = Number.isFinite(nowSec) ? Math.floor(nowSec) : Math.floor(Date.now() / 1000);
  const upstream = Number.isFinite(upstreamSec) ? Math.floor(upstreamSec) : now;
  const previous = Number.isFinite(Number(prevTs)) ? Math.max(Math.floor(Number(prevTs)), 0) : 0;

  if (upstream > now + maxFutureSeconds) {
    throw new FeedTimestampError(
      `upstream feed timestamp ${upstream} is more than ${maxFutureSeconds}s in the future (now ${now})`
    );
  }

  // Cap a (mildly) future or skewed upstream value to now + skew, never anchor a
  // value the chain would treat as "from the future" beyond the tolerance.
  const capped = Math.min(upstream, now + futureSkewSeconds);
  // Enforce strict monotonicity above the last anchored on-chain timestamp.
  return Math.max(previous + 1, capped);
}
