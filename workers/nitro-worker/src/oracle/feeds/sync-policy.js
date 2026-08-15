import { envForNetwork, parseDurationMs, trimString } from '../../platform/core.js';
import { getFeedPairConfig } from '../feed-registry.js';
import {
  DEFAULT_FEED_SUBMISSION_WAIT_TIMEOUT_MS,
  MAINNET_FEED_CHANGE_THRESHOLD_BPS,
  MAINNET_FEED_MIN_UPDATE_INTERVAL_MS,
  MAINNET_FEED_STALE_AFTER_MS,
  normalizeBooleanLike,
  resolveFeedNetwork,
  resolveFeedScope,
} from './shared.js';
import { decimalToIntegerString } from './decimal.js';

export function resolvePairThresholdBps(storagePair, payload = {}, _targetChain = 'neo_n3') {
  const config = getFeedPairConfig(storagePair);
  const raw =
    config?.threshold_bps ??
    config?.feed_change_threshold_bps ??
    payload?.pair_feed_change_threshold_bps ??
    payload?.feed_change_threshold_bps_by_pair?.[storagePair] ??
    null;
  if (raw === '' || raw === undefined || raw === null) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(parsed, 0);
}

export function buildSyncPolicy(targetChain, payload = {}) {
  const network = resolveFeedScope(payload, targetChain).network;
  const thresholdCandidate =
    payload.feed_change_threshold_bps ??
    envForNetwork(network, 'MORPHEUS_FEED_CHANGE_THRESHOLD_BPS');
  const intervalCandidate =
    payload.feed_min_update_interval_ms ??
    envForNetwork(network, 'MORPHEUS_FEED_MIN_UPDATE_INTERVAL_MS');
  const staleCandidate =
    payload.feed_stale_after_ms ?? envForNetwork(network, 'MORPHEUS_FEED_STALE_AFTER_MS');
  const thresholdSource =
    thresholdCandidate === '' || thresholdCandidate === undefined || thresholdCandidate === null
      ? `${MAINNET_FEED_CHANGE_THRESHOLD_BPS}`
      : thresholdCandidate;
  const intervalSource =
    intervalCandidate === '' || intervalCandidate === undefined || intervalCandidate === null
      ? `${MAINNET_FEED_MIN_UPDATE_INTERVAL_MS}ms`
      : intervalCandidate;
  const staleSource =
    staleCandidate === '' || staleCandidate === undefined || staleCandidate === null
      ? `${MAINNET_FEED_STALE_AFTER_MS}ms`
      : staleCandidate;
  const thresholdBps = Number(thresholdSource || 0);
  const minUpdateIntervalMs = parseDurationMs(intervalSource, MAINNET_FEED_MIN_UPDATE_INTERVAL_MS);
  const staleAfterMs = parseDurationMs(staleSource, MAINNET_FEED_STALE_AFTER_MS);
  return {
    thresholdBps: Math.max(Number.isFinite(thresholdBps) ? thresholdBps : 0, 0),
    minUpdateIntervalMs: Math.max(minUpdateIntervalMs, 0),
    staleAfterMs: Math.max(staleAfterMs, 0),
  };
}

export function resolveFeedSubmissionWait(payload = {}) {
  return normalizeBooleanLike(payload.wait, false);
}

export function resolveFeedSubmissionWaitTimeoutMs(payload = {}) {
  const network = resolveFeedNetwork(payload);
  const source =
    payload.timeout_ms ??
    payload.timeoutMs ??
    payload.feed_submission_wait_timeout_ms ??
    payload.feedSubmissionWaitTimeoutMs ??
    envForNetwork(network, 'MORPHEUS_FEED_SUBMISSION_WAIT_TIMEOUT_MS');
  return Math.min(
    parseDurationMs(source, DEFAULT_FEED_SUBMISSION_WAIT_TIMEOUT_MS),
    DEFAULT_FEED_SUBMISSION_WAIT_TIMEOUT_MS
  );
}

export function resolveFeedSubmissionIssue(
  targetChain,
  { hasNeoN3DataFeedTarget = false, neoContext = null } = {}
) {
  if (targetChain === 'neo_n3') {
    if (!hasNeoN3DataFeedTarget) return 'Neo N3 datafeed contract hash is not configured';
    if (!neoContext) return 'Neo N3 signing key is not configured';
    if (!trimString(neoContext.rpcUrl)) return 'NEO_RPC_URL is required for Neo N3 feed submission';
    return '';
  }

  return '';
}

export function shouldLoadOnchainFeedBaseline(payload = {}, state = {}) {
  const hasLocalRecords = Object.keys(state.records || {}).length > 0;
  const explicitRefresh = payload.refresh_onchain_baseline ?? payload.refreshOnchainBaseline;
  if (explicitRefresh !== undefined && explicitRefresh !== null && explicitRefresh !== '') {
    return normalizeBooleanLike(explicitRefresh, false);
  }
  return Boolean(payload.force) || !hasLocalRecords;
}

function computeChangeBps(previousPrice, nextPrice) {
  const previous = Number(previousPrice);
  const next = Number(nextPrice);
  if (!Number.isFinite(previous) || !Number.isFinite(next) || previous <= 0)
    return Number.POSITIVE_INFINITY;
  return Math.abs((next - previous) / previous) * 10_000;
}

function normalizeTimestampMs(value) {
  if (value === undefined || value === null || value === '') return 0;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 10_000_000_000 ? value : value * 1000;
  }
  const raw = trimString(value);
  if (!raw) return 0;
  const numeric = Number(raw);
  if (Number.isFinite(numeric)) {
    return numeric > 10_000_000_000 ? numeric : numeric * 1000;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function resolvePreviousSubmittedAtMs(previousRecord = {}) {
  const candidates = [
    previousRecord.last_submitted_at_ms,
    previousRecord.submitted_at_ms,
    previousRecord.timestamp_ms,
    previousRecord.timestamp,
    previousRecord.submitted_at,
  ];
  for (const candidate of candidates) {
    const timestampMs = normalizeTimestampMs(candidate);
    if (timestampMs > 0) return timestampMs;
  }
  return 0;
}

export function shouldSubmitFeed(storageKey, quote, previousRecord, policy, force = false) {
  if (force) return { allow: true, reason: 'forced' };
  if (!previousRecord) return { allow: true, reason: 'first-observation' };

  const now = Date.now();
  const lastSubmittedAt = normalizeTimestampMs(previousRecord.last_submitted_at_ms);
  if (
    policy.minUpdateIntervalMs > 0 &&
    lastSubmittedAt > 0 &&
    now - lastSubmittedAt < policy.minUpdateIntervalMs
  ) {
    return { allow: false, reason: 'min-update-interval', storage_key: storageKey };
  }

  const previousPriceUnits = String(
    previousRecord.price_units ??
      previousRecord.price_cents ??
      decimalToIntegerString(previousRecord.price ?? '0', quote.decimals)
  );
  const nextPriceUnits = decimalToIntegerString(quote.price, quote.decimals);
  const changeBps = computeChangeBps(previousPriceUnits, nextPriceUnits);
  const previousSubmittedAtMs = resolvePreviousSubmittedAtMs(previousRecord);
  const staleAgeMs = previousSubmittedAtMs > 0 ? now - previousSubmittedAtMs : 0;
  if (policy.staleAfterMs > 0 && staleAgeMs >= policy.staleAfterMs) {
    return {
      allow: true,
      reason: 'stale-refresh',
      stale_age_ms: staleAgeMs,
      stale_after_ms: policy.staleAfterMs,
      change_bps: changeBps,
      comparison_basis: 'current-chain-price',
      current_chain_price_units: previousPriceUnits,
      candidate_price_units: nextPriceUnits,
      storage_key: storageKey,
    };
  }

  if (policy.thresholdBps > 0 && changeBps < policy.thresholdBps) {
    return {
      allow: false,
      reason: 'price-change-below-threshold',
      change_bps: changeBps,
      comparison_basis: 'current-chain-price',
      current_chain_price_units: previousPriceUnits,
      candidate_price_units: nextPriceUnits,
      storage_key: storageKey,
    };
  }

  return {
    allow: true,
    reason: 'threshold-met',
    change_bps: changeBps,
    comparison_basis: 'current-chain-price',
    current_chain_price_units: previousPriceUnits,
    candidate_price_units: nextPriceUnits,
    storage_key: storageKey,
  };
}
