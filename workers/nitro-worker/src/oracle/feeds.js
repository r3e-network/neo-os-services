import { randomUUID } from 'node:crypto';
import {
  env,
  envForNetwork,
  json,
  jsonError,
  parseDurationMs,
  trimString,
} from '../platform/core.js';
import {
  aggregateQuotes,
  countDistinctProviders,
  meetsMinProviders,
  CANONICAL_AGGREGATE_MIN_PROVIDERS,
} from './aggregation.js';
import {
  buildSignedResultEnvelope,
  buildVerificationEnvelope,
  isConfiguredHash160,
  loadNeoN3Context,
  normalizeNeoHash160,
} from '../chain/index.js';
import {
  buildProviderRequest,
  fetchProviderJSON,
  inferProviderIdFromPairSymbol,
  resolveProviderPayload,
} from './providers.js';
import {
  applyFeedProviderDefaults,
  getDefaultFeedSymbols,
  getFeedDisplaySymbol,
  normalizeFeedPairSymbol,
  getFeedProvidersForPair,
  getFeedPriceMultiplier,
  getFeedPriceTransform,
  getFeedStoragePair,
  getFeedUnitLabel,
  getSourceSetIdForProvider,
} from './feed-registry.js';
import {
  FEED_PRICE_DECIMALS,
  DEFAULT_FEED_PROVIDER_TIMEOUT_MS,
  MAX_FEED_PROVIDER_TIMEOUT_MS,
  isEnabled,
  normalizeBooleanLike,
  hasOwnPayloadKey,
  resolveFeedNetwork,
  resolveFeedScope,
  clampFeedTimestampSec,
  FeedTimestampError,
} from './feeds/shared.js';
import {
  decimalToIntegerString,
  integerToDecimalString,
  multiplyDecimalString,
  transformDecimalString,
} from './feeds/decimal.js';
import {
  fetchLatestFeedSnapshots,
  persistFeedSnapshots,
  loadFeedState,
  saveFeedState,
  resetFeedStateCache,
  getFeedStalenessSummary,
  getFeedStateWriteFailureCount,
} from './feeds/feed-state.js';

export { getFeedStalenessSummary, getFeedStateWriteFailureCount };
import { fetchJsonRpc, loadOnchainFeedRecords } from './feeds/neo-stack-decode.js';
import {
  buildSyncPolicy,
  resolvePairThresholdBps,
  resolveFeedSubmissionWait,
  resolveFeedSubmissionWaitTimeoutMs,
  resolveFeedSubmissionIssue,
  shouldLoadOnchainFeedBaseline,
  shouldSubmitFeed,
} from './feeds/sync-policy.js';
import {
  buildCanonicalFeedMessage,
  buildFeedSignatureFields,
  buildFeedUpdateInvocation,
  buildNeoN3RelaySigningPayload,
  isMissingNeoN3BatchUpdateMethod,
  isRecoverableNeoN3BatchUpdateFailure,
  getRecoverableNeoN3BatchUpdateFailureReason,
  submitQuotesToN3WithFallback,
  SIGNED_FEED_REQUIRES_PER_FEED_PATH,
} from './feeds/feed-submit.js';

// Re-export the converters so consumers (oracle/index.js) and tests keep
// importing them from this module path unchanged.
export {
  decimalToIntegerString,
  integerToDecimalString,
  multiplyDecimalString,
  transformDecimalString,
};

const oracleFeedBackgroundTasks = new Set();

export function __fetchLatestFeedSnapshotsForTests(limit, scope) {
  return fetchLatestFeedSnapshots(limit, scope);
}

export function __persistFeedSnapshotsForTests(rows) {
  return persistFeedSnapshots(rows);
}

export function __resetFeedStateForTests() {
  resetFeedStateCache();
}

export function __clampFeedTimestampSecForTests(args) {
  return clampFeedTimestampSec(args);
}

export async function __loadFeedStateForTests(scope = {}) {
  return loadFeedState(scope);
}

export function __buildFeedSnapshotRowsForTests(
  targetChain,
  syncResults,
  state,
  batchTx,
  scope = {}
) {
  return buildFeedSnapshotRows(targetChain, syncResults, state, batchTx, scope);
}

export function normalizePairSymbol(rawSymbol) {
  const raw = trimString(rawSymbol).toUpperCase();
  if (!raw) return 'NEO-USD';
  if (raw.includes(':')) {
    return normalizeFeedPairSymbol(raw);
  }
  if (/^[A-Z0-9]+-[A-Z0-9]+$/.test(raw)) {
    const [base, quote] = raw.split('-');
    return normalizeFeedPairSymbol(`${base}-${quote === 'USDT' ? 'USD' : quote}`);
  }
  if (/^[A-Z0-9]+[-/_][A-Z0-9]+$/.test(raw)) {
    const [base, quote] = raw.split(/[-/_]/);
    return normalizeFeedPairSymbol(`${base}-${quote === 'USDT' ? 'USD' : quote}`);
  }
  if (raw.endsWith('USDT')) return normalizeFeedPairSymbol(`${raw.slice(0, -4)}-USD`);
  if (raw.endsWith('USD')) return normalizeFeedPairSymbol(`${raw.slice(0, -3)}-USD`);
  return normalizeFeedPairSymbol(`${raw}-USD`);
}

function buildFeedSnapshotRows(targetChain, syncResults, state, batchTx, scope = {}) {
  const resolvedScope = resolveFeedScope(scope, targetChain);
  const rows = [];
  for (const result of Array.isArray(syncResults) ? syncResults : []) {
    const storagePair = trimString(result?.storage_pair || '');
    const record = storagePair ? state.records?.[storagePair] || {} : {};
    const quote = result?.quote && typeof result.quote === 'object' ? result.quote : null;
    const price = record?.price ?? record?.last_observed_price ?? quote?.price ?? null;
    rows.push({
      network: resolvedScope.network,
      symbol: storagePair || trimString(result?.pair || ''),
      target_chain: resolvedScope.targetChain,
      price,
      attestation_hash: trimString(record?.attestation_hash || quote?.attestation_hash || ''),
      payload: {
        ...(record && typeof record === 'object' ? record : {}),
        relay_status: result?.relay_status || null,
        skip_reason: result?.skip_reason || null,
        change_bps: result?.change_bps ?? null,
        comparison_basis: result?.comparison_basis ?? null,
        anchored_tx: result?.anchored_tx ?? batchTx ?? null,
      },
    });
  }
  return rows.filter((entry) => trimString(entry.symbol));
}

// C2 — provider ids are deduplicated here so a misconfiguration like
// MORPHEUS_FEED_PROVIDERS="twelvedata,twelvedata" cannot fan out into two quotes
// from a single source (which would then masquerade as a multi-provider
// aggregate). This is the upstream half of the defense; meetsMinProviders is the
// downstream guard.
function dedupeProviderIds(ids) {
  const seen = new Set();
  const out = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function parseProviderList(value, fallback = []) {
  if (Array.isArray(value)) {
    return dedupeProviderIds(value.map((entry) => trimString(entry).toLowerCase()).filter(Boolean));
  }
  const raw = trimString(value);
  if (!raw) return fallback;
  return dedupeProviderIds(
    raw
      .split(',')
      .map((entry) => trimString(entry).toLowerCase())
      .filter(Boolean)
  );
}

function resolveRequestedProviders(symbol, options = {}) {
  const inferredProvider = trimString(inferProviderIdFromPairSymbol(symbol)).toLowerCase();
  if (inferredProvider) return [inferredProvider];

  const explicitProviders = parseProviderList(options.providers || options.provider_list);
  if (explicitProviders.length > 0) return explicitProviders;

  const explicitProvider = trimString(options.provider || options.source || '').toLowerCase();
  if (explicitProvider && explicitProvider !== 'all') return [explicitProvider];

  const network = resolveFeedNetwork(options);
  const configured = parseProviderList(envForNetwork(network, 'MORPHEUS_FEED_PROVIDERS'), []);
  const available = getFeedProvidersForPair(symbol);
  if (configured.length > 0) {
    return configured.filter((provider) => available.length === 0 || available.includes(provider));
  }
  return available.length > 0 ? available : ['twelvedata'];
}

function extractQuotePrice(response) {
  return (
    response.data?.price ??
    response.data?.value ??
    response.data?.close ??
    response.data?.data?.amount ??
    null
  );
}

/**
 * Extract the upstream data source timestamp from the provider API response.
 * Using the provider's timestamp instead of the local clock prevents clock-skew
 * issues and ensures the recorded timestamp reflects when the price was actually
 * observed at the source (TwelveData, Binance, Coinbase), not when our worker
 * happened to process it.
 */
function extractUpstreamTimestamp(response) {
  // TwelveData: { "datetime": "2025-01-15 14:30:00" }
  if (response.data?.datetime) {
    const parsed = Date.parse(response.data.datetime);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  // TwelveData time_series: { "timestamp": 1705312200 }
  if (response.data?.timestamp) {
    const ts = Number(response.data.timestamp);
    // Distinguish seconds from milliseconds (pre-2100 cutoff in seconds)
    if (Number.isFinite(ts) && ts > 0) {
      return new Date(ts < 4_102_444_800 ? ts * 1000 : ts).toISOString();
    }
  }
  // Binance: { "time": 1705312200000 } (trade time in ms)
  if (response.data?.time) {
    const ts = Number(response.data.time);
    if (Number.isFinite(ts) && ts > 0) {
      return new Date(ts < 4_102_444_800 ? ts * 1000 : ts).toISOString();
    }
  }
  // Coinbase: { "data": { "currency": "NEO", "amount": "12.34" } } - no timestamp field;
  // fall back to response Date header if present
  if (response.headers?.date) {
    const parsed = Date.parse(response.headers.date);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  // Last resort: use local clock (safe fallback)
  return new Date().toISOString();
}

export function __resolvePairThresholdBpsForTests(
  storagePair,
  payload = {},
  targetChain = 'neo_n3'
) {
  return resolvePairThresholdBps(storagePair, payload, targetChain);
}

export function __buildSyncPolicyForTests(targetChain, payload = {}) {
  return buildSyncPolicy(targetChain, payload);
}

function shouldFastAckOracleFeed(payload = {}) {
  const explicitFastAck =
    payload.fast_ack ?? payload.fastAck ?? payload.async_ack ?? payload.asyncAck;
  if (explicitFastAck !== undefined && explicitFastAck !== null && explicitFastAck !== '') {
    return normalizeBooleanLike(explicitFastAck, false);
  }
  if (hasOwnPayloadKey(payload, 'wait')) {
    return !normalizeBooleanLike(payload.wait, true);
  }
  return false;
}

function buildOracleFeedRequestId(payload = {}) {
  return (
    trimString(payload.request_id || payload.requestId) ||
    `pricefeed:${resolveFeedNetwork(payload)}:${Date.now()}:${randomUUID()}`
  );
}

function scheduleOracleFeedBackgroundTask(payload = {}) {
  let task;
  task = Promise.resolve()
    .then(async () => {
      const response = await handleOracleFeed(payload);
      const body = await response
        .clone()
        .json()
        .catch(() => null);
      if (!response.ok) {
        console.error(
          JSON.stringify({
            level: 'error',
            msg: 'oracle feed background task failed',
            request_id: payload.request_id || payload.requestId || null,
            status: response.status,
            error: body?.error || body?.errors?.[0]?.error || null,
          })
        );
      }
      return { status: response.status, body };
    })
    .catch((error) => {
      console.error(
        JSON.stringify({
          level: 'error',
          msg: 'oracle feed background task crashed',
          request_id: payload.request_id || payload.requestId || null,
          error: error instanceof Error ? error.message : String(error),
        })
      );
      return null;
    })
    .finally(() => {
      oracleFeedBackgroundTasks.delete(task);
    });
  oracleFeedBackgroundTasks.add(task);
  return task;
}

async function resolveQuoteForProvider(symbol, options, provider) {
  const providerPayload = applyFeedProviderDefaults(symbol, provider, {
    ...options,
    provider,
    symbol: normalizePairSymbol(symbol),
  });

  const { payload: resolvedPayload } = await resolveProviderPayload(providerPayload, {
    projectSlug: trimString(providerPayload.project_slug || ''),
    fallbackProviderId: provider,
  });
  const providerRequest = buildProviderRequest(resolvedPayload);
  if (!providerRequest) throw new Error('provider request could not be built');
  const response = await fetchProviderJSON(
    providerRequest,
    Math.min(
      parseDurationMs(
        resolvedPayload.oracle_timeout_ms || env('ORACLE_TIMEOUT'),
        DEFAULT_FEED_PROVIDER_TIMEOUT_MS
      ),
      MAX_FEED_PROVIDER_TIMEOUT_MS
    )
  );
  if (!response.ok) {
    throw new Error(response.provider_error?.message || `${provider} fetch failed`);
  }
  const pair = providerRequest.pair || normalizePairSymbol(symbol);
  const storagePair = getFeedStoragePair(provider, pair);
  const rawPrice = extractQuotePrice(response);
  if (rawPrice === null || rawPrice === undefined || rawPrice === '')
    throw new Error(`${provider} response missing price`);
  const displaySymbol = getFeedDisplaySymbol(storagePair);
  const unitLabel = getFeedUnitLabel(storagePair) || null;
  const priceMultiplier = getFeedPriceMultiplier(storagePair);
  const priceTransform = getFeedPriceTransform(storagePair);
  const price = transformDecimalString(String(rawPrice), {
    transform: priceTransform,
    multiplier: priceMultiplier,
  });

  // Use the upstream provider's timestamp rather than local clock, so the
  // recorded observation time reflects the data source, not worker processing.
  const upstreamTimestamp = extractUpstreamTimestamp(response);
  const quote = {
    feed_id: `${provider}:${pair}`,
    pair: storagePair,
    provider_pair: pair,
    display_symbol: displaySymbol,
    unit_label: unitLabel,
    provider,
    raw_price: String(rawPrice),
    price_transform: priceTransform || null,
    price_multiplier: priceMultiplier,
    price: String(price),
    decimals: FEED_PRICE_DECIMALS,
    price_scale_decimals: FEED_PRICE_DECIMALS,
    timestamp: upstreamTimestamp,
    sources: [provider],
  };
  const signed = await buildSignedResultEnvelope(quote, resolvedPayload);
  // signed.tee_attestation already binds sha256(stableStringify(quote)) via output_hash;
  // reuse it instead of a second /attest call with the same report_data.
  const teeAttestation = signed.tee_attestation;
  return {
    ...quote,
    signature: signed.signature,
    public_key: signed.public_key,
    attestation_hash: signed.attestation_hash,
    tee_attestation: teeAttestation,
    verification: buildVerificationEnvelope(signed),
  };
}

export async function fetchPriceQuote(symbol, options = {}) {
  const providers = resolveRequestedProviders(symbol, options);
  if (providers.length === 0) throw new Error(`no providers configured for ${symbol}`);
  return resolveQuoteForProvider(symbol, options, providers[0]);
}

export async function fetchPriceQuotes(symbol, options = {}) {
  const providers = resolveRequestedProviders(symbol, options);
  if (providers.length === 0) throw new Error(`no providers configured for ${symbol}`);
  const normalizedPair = normalizePairSymbol(symbol);

  // Fetch all providers concurrently instead of serially: multi-provider aggregate
  // latency is then bounded by the slowest provider rather than the SUM of provider
  // round-trips. Concurrency is safe — each resolveQuoteForProvider builds its own
  // request/state, and fetchProviderJSON's per-provider circuit breaker + response
  // cache + in-flight dedup (providers.js) are already designed for concurrent calls.
  // allSettled preserves INPUT (provider-config) order in the results array, so the
  // quotes/errors ordering and the downstream aggregateQuotes output match the prior
  // serial behavior exactly — only the wall-clock latency changes.
  const settled = await Promise.allSettled(
    providers.map((provider) => resolveQuoteForProvider(symbol, options, provider))
  );

  const quotes = [];
  const errors = [];
  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      quotes.push(result.value);
    } else {
      errors.push({
        provider: providers[index],
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    }
  });

  const aggregation =
    quotes.length >= 2
      ? aggregateQuotes(
          quotes.map((q) => ({
            provider: q.provider,
            price: Number(q.price),
            timestamp: q.timestamp,
          })),
          {
            method:
              trimString(
                options.aggregation_method || env('MORPHEUS_AGGREGATION_METHOD') || 'median'
              ).toLowerCase() === 'trimmed-mean'
                ? 'trimmed-mean'
                : 'median',
          }
        )
      : null;

  return {
    pair:
      providers.length === 1 ? getFeedStoragePair(providers[0], normalizedPair) : normalizedPair,
    providers_requested: providers,
    quotes,
    errors,
    ...(aggregation ? { aggregation } : {}),
  };
}

export async function handleFeedsPrice(symbol, options = {}) {
  try {
    const explicitProvider = trimString(options.provider || options.source || '').toLowerCase();
    const inferredProvider = trimString(inferProviderIdFromPairSymbol(symbol)).toLowerCase();
    if ((explicitProvider && explicitProvider !== 'all') || inferredProvider) {
      return json(200, await fetchPriceQuote(symbol, options));
    }
    const result = await fetchPriceQuotes(symbol, options);
    return json(200, result);
  } catch (error) {
    return jsonError(502, error);
  }
}

function buildRoundId(previousRecord) {
  if (!previousRecord?.round_id) return String(Math.floor(Date.now() / 1000));
  return String(Number(previousRecord.round_id) + 1);
}

// C2 — the storage key for the single canonical aggregated record of a pair.
// The per-provider records (PROVIDER:PAIR) are single-source and never
// cross-checked against each other; this canonical key holds the multi-provider
// aggregated value so a consumer can read one tamper-resistant price per pair.
export function buildCanonicalAggregateStorageKey(pair) {
  return `AGG:${normalizeFeedPairSymbol(pair)}`;
}

// C2 — build the canonical aggregated record for a pair from a multi-source
// aggregation result. Returns null unless at least CANONICAL_AGGREGATE_MIN_PROVIDERS
// (>=2) independent providers contributed, so a single-source value can never be
// laundered into the canonical record. The price carries the aggregation's
// median/mean output rather than any one provider's quote.
function buildCanonicalAggregateRecord(pair, aggregation, previousRecord = null) {
  if (!meetsMinProviders(aggregation, CANONICAL_AGGREGATE_MIN_PROVIDERS)) return null;
  const aggregatedPrice = Number(aggregation?.price);
  if (!Number.isFinite(aggregatedPrice)) return null;

  const storageKey = buildCanonicalAggregateStorageKey(pair);
  // toFixed avoids exponential notation (e.g. 1e-7) that decimalToIntegerString
  // would reject, and bounds the float to the feed scale before integer conversion.
  const priceDecimalString = integerToDecimalString(
    decimalToIntegerString(aggregatedPrice.toFixed(FEED_PRICE_DECIMALS), FEED_PRICE_DECIMALS),
    FEED_PRICE_DECIMALS
  );
  const roundId = buildRoundId(previousRecord);
  return {
    storageKey,
    record: {
      ...(previousRecord && typeof previousRecord === 'object' ? previousRecord : {}),
      storage_pair: storageKey,
      pair: normalizeFeedPairSymbol(pair),
      aggregate: true,
      aggregation_method: aggregation.method ?? null,
      providers_used: Array.isArray(aggregation.providers_used) ? aggregation.providers_used : [],
      providers_rejected: Array.isArray(aggregation.providers_rejected)
        ? aggregation.providers_rejected
        : [],
      // C2 — count DISTINCT providers so a duplicated id can't inflate the count.
      provider_count: countDistinctProviders(aggregation),
      deviation_pct: aggregation.deviation_pct ?? null,
      confidence: aggregation.confidence ?? null,
      price: priceDecimalString,
      price_units: decimalToIntegerString(priceDecimalString, FEED_PRICE_DECIMALS),
      round_id: roundId,
      last_observed_price: priceDecimalString,
      last_observed_price_units: decimalToIntegerString(priceDecimalString, FEED_PRICE_DECIMALS),
      last_observed_at_ms: Date.now(),
      price_scale_decimals: FEED_PRICE_DECIMALS,
    },
  };
}

export function __buildCanonicalAggregateRecordForTests(pair, aggregation, previousRecord = null) {
  return buildCanonicalAggregateRecord(pair, aggregation, previousRecord);
}

export function __buildNeoN3RelaySigningPayloadForTests(payload = {}) {
  return buildNeoN3RelaySigningPayload(payload);
}

export function __buildFeedSignatureFieldsForTests(quote = {}) {
  return buildFeedSignatureFields(quote);
}

export function __buildCanonicalFeedMessageForTests(fields) {
  return buildCanonicalFeedMessage(fields);
}

export function __buildFeedUpdateInvocationForTests(baseParams, signed) {
  return buildFeedUpdateInvocation(baseParams, signed);
}

export function __countDistinctProvidersForTests(aggregation) {
  return countDistinctProviders(aggregation);
}

export function __meetsMinProvidersForTests(aggregation, minProviders) {
  return meetsMinProviders(aggregation, minProviders);
}

export const __SIGNED_FEED_REQUIRES_PER_FEED_PATH = SIGNED_FEED_REQUIRES_PER_FEED_PATH;

export function __resolveFeedSubmissionWaitForTests(payload = {}) {
  return resolveFeedSubmissionWait(payload);
}

export async function __drainOracleFeedBackgroundTasksForTests() {
  while (oracleFeedBackgroundTasks.size > 0) {
    await Promise.allSettled([...oracleFeedBackgroundTasks]);
  }
}

export function __resolveFeedSubmissionWaitTimeoutMsForTests(payload = {}) {
  return resolveFeedSubmissionWaitTimeoutMs(payload);
}

export function __shouldLoadOnchainFeedBaselineForTests(payload = {}, state = {}) {
  return shouldLoadOnchainFeedBaseline(payload, state);
}

export function __shouldSubmitFeedForTests(
  storageKey,
  quote,
  previousRecord,
  policy,
  force = false
) {
  return shouldSubmitFeed(storageKey, quote, previousRecord, policy, force);
}

export function __fetchJsonRpcForTests(url, body) {
  return fetchJsonRpc(url, body);
}

export function __isMissingNeoN3BatchUpdateMethodForTests(error) {
  return isMissingNeoN3BatchUpdateMethod(error);
}

export function __isRecoverableNeoN3BatchUpdateFailureForTests(error) {
  return isRecoverableNeoN3BatchUpdateFailure(error);
}

export function __getRecoverableNeoN3BatchUpdateFailureReasonForTests(error) {
  return getRecoverableNeoN3BatchUpdateFailureReason(error);
}

function resolveRequestedSymbols(payload = {}) {
  const explicitSymbols = Array.isArray(payload.symbols)
    ? payload.symbols
    : parseProviderList(payload.symbols || payload.symbol_list || '', []);
  if (Array.isArray(explicitSymbols) && explicitSymbols.length > 0) {
    return explicitSymbols.map((symbol) => normalizePairSymbol(symbol));
  }
  if (trimString(payload.symbol)) return [normalizePairSymbol(payload.symbol)];
  return getDefaultFeedSymbols().map((symbol) => normalizePairSymbol(symbol));
}

export async function handleOracleFeed(payload) {
  const scope = resolveFeedScope(
    payload,
    payload?.target_chain || payload?.targetChain || 'neo_n3'
  );
  const targetChain = scope.targetChain;
  const scopedPayload = payload?.network ? payload : { ...payload, network: scope.network };
  const symbols = resolveRequestedSymbols(scopedPayload);

  const policy = buildSyncPolicy(targetChain, scopedPayload);
  const requireSubmission = normalizeBooleanLike(
    scopedPayload.require_submission ?? scopedPayload.requireSubmission,
    false
  );
  const state = await loadFeedState(scope);
  const syncResults = [];
  const batchUpdates = [];
  const errors = [];
  const aggregations = {};

  const dataFeedHash =
    targetChain === 'neo_n3'
      ? normalizeNeoHash160(
          envForNetwork(scope.network, 'CONTRACT_MORPHEUS_DATAFEED_HASH', 'CONTRACT_PRICEFEED_HASH')
        )
      : null;
  const hasNeoN3DataFeedTarget =
    targetChain === 'neo_n3' && dataFeedHash && isConfiguredHash160(dataFeedHash);
  const neoContext = hasNeoN3DataFeedTarget
    ? await loadNeoN3Context(scopedPayload, { required: false, requireRpc: false })
    : null;
  const loadOnchainBaseline = shouldLoadOnchainFeedBaseline(scopedPayload, state);
  const onchainFeedState = loadOnchainBaseline
    ? await loadOnchainFeedRecords(targetChain, {
        neoContext,
        dataFeedHash,
      })
    : { records: {}, error: null };
  const onchainRecords = onchainFeedState.records;
  if (
    onchainFeedState.error &&
    Object.keys(state.records || {}).length === 0 &&
    !scopedPayload.force
  ) {
    return json(503, {
      mode: 'pricefeed',
      network: scope.network,
      target_chain: targetChain,
      symbols,
      batch_submitted: false,
      batch_count: 0,
      sync_results: [],
      errors: [
        {
          error: `on-chain baseline unavailable: ${onchainFeedState.error}`,
        },
      ],
    });
  }

  for (const symbol of symbols) {
    const quoteSet = await fetchPriceQuotes(symbol, scopedPayload);
    if (quoteSet.quotes.length === 0) {
      errors.push({
        symbol,
        providers_requested: quoteSet.providers_requested,
        errors: quoteSet.errors,
      });
      continue;
    }
    if (quoteSet.aggregation) {
      aggregations[symbol] = quoteSet.aggregation;
      // C2 — when >=2 providers agree, persist ONE canonical aggregated record
      // (AGG:<PAIR>) carrying the aggregation price. This closes the integrity gap
      // where every consumed record was a single, unchecked per-provider value.
      const canonicalKey = buildCanonicalAggregateStorageKey(symbol);
      const previousCanonical = {
        ...(state.records[canonicalKey] || {}),
        ...(onchainRecords[canonicalKey] || {}),
      };
      const canonical = buildCanonicalAggregateRecord(
        symbol,
        quoteSet.aggregation,
        Object.keys(previousCanonical).length > 0 ? previousCanonical : null
      );
      if (canonical) {
        state.records[canonical.storageKey] = canonical.record;
        syncResults.push({
          provider: 'aggregate',
          pair: canonical.record.pair,
          storage_pair: canonical.storageKey,
          relay_status: 'aggregated',
          aggregation_method: canonical.record.aggregation_method,
          provider_count: canonical.record.provider_count,
          confidence: canonical.record.confidence,
        });
      }
    }
    for (const quote of quoteSet.quotes) {
      const storagePair = getFeedStoragePair(quote.provider, quote.pair);
      const previousRecord = {
        ...(state.records[storagePair] || {}),
        ...(onchainRecords[storagePair] || {}),
      };
      const hasPreviousRecord = Object.keys(previousRecord).length > 0;
      const decision = shouldSubmitFeed(
        storagePair,
        quote,
        hasPreviousRecord ? previousRecord : null,
        {
          ...policy,
          thresholdBps:
            resolvePairThresholdBps(storagePair, scopedPayload, targetChain) ?? policy.thresholdBps,
        },
        Boolean(scopedPayload.force)
      );
      const roundId =
        trimString(scopedPayload.round_id) ||
        buildRoundId(hasPreviousRecord ? previousRecord : null);
      const sourceSetId = Number(
        scopedPayload.source_set_id ?? getSourceSetIdForProvider(quote.provider, 0)
      );
      const quoteTimestampMs = Date.parse(quote.timestamp);
      const nowSec = Math.floor(Date.now() / 1000);
      const upstreamSec = Number.isFinite(quoteTimestampMs)
        ? Math.floor(quoteTimestampMs / 1000)
        : nowSec;
      // Clamp the on-chain submission timestamp against the strictly-monotonic
      // MorpheusDataFeed using the previous on-chain timestamp as the floor (B9).
      const prevOnchainTs = Number(previousRecord?.timestamp) || 0;
      let timestampSec;
      try {
        timestampSec = clampFeedTimestampSec({
          upstreamSec,
          prevTs: prevOnchainTs,
          nowSec,
        });
      } catch (error) {
        if (error instanceof FeedTimestampError) {
          // A poisoned/far-future upstream timestamp must never be anchored — it
          // would permanently stall this pair. Skip it (do not throw the batch).
          state.records[storagePair] = {
            ...(hasPreviousRecord ? previousRecord : {}),
            provider: quote.provider,
            pair: quote.pair,
            storage_pair: storagePair,
            last_observed_price: quote.price,
            last_observed_price_units: decimalToIntegerString(quote.price, quote.decimals),
            last_observed_at_ms: Number.isFinite(quoteTimestampMs) ? quoteTimestampMs : Date.now(),
            price_scale_decimals: FEED_PRICE_DECIMALS,
          };
          syncResults.push({
            provider: quote.provider,
            pair: quote.pair,
            storage_pair: storagePair,
            relay_status: 'skipped',
            skip_reason: 'upstream_timestamp_rejected',
            change_bps: decision.change_bps ?? null,
            comparison_basis: decision.comparison_basis ?? null,
            quote,
          });
          errors.push({
            symbol,
            storage_pair: storagePair,
            error: error.message,
          });
          continue;
        }
        throw error;
      }
      const observedAtMs = Number.isFinite(quoteTimestampMs) ? quoteTimestampMs : Date.now();

      if (!decision.allow) {
        state.records[storagePair] = {
          ...(hasPreviousRecord ? previousRecord : {}),
          provider: quote.provider,
          pair: quote.pair,
          storage_pair: storagePair,
          last_observed_price: quote.price,
          last_observed_price_units: decimalToIntegerString(quote.price, quote.decimals),
          last_observed_at_ms: observedAtMs,
          price_scale_decimals: FEED_PRICE_DECIMALS,
        };
        syncResults.push({
          provider: quote.provider,
          pair: quote.pair,
          storage_pair: storagePair,
          relay_status: 'skipped',
          skip_reason: decision.reason,
          change_bps: decision.change_bps ?? null,
          comparison_basis: decision.comparison_basis ?? null,
          quote,
        });
        continue;
      }

      batchUpdates.push({
        quote,
        storagePair,
        roundId,
        sourceSetId,
        timestampSec,
        observedAtMs,
        previousRecord: hasPreviousRecord ? previousRecord : null,
      });
      syncResults.push({
        provider: quote.provider,
        pair: quote.pair,
        storage_pair: storagePair,
        relay_status: 'queued',
        change_bps: decision.change_bps ?? null,
        comparison_basis: decision.comparison_basis ?? null,
        quote,
      });
    }
  }

  let batchTx = null;
  const submissionIssue =
    batchUpdates.length > 0
      ? resolveFeedSubmissionIssue(targetChain, {
          hasNeoN3DataFeedTarget,
          neoContext,
        })
      : '';
  if (batchUpdates.length > 0) {
    if (submissionIssue) {
      errors.push({
        target_chain: targetChain,
        error: submissionIssue,
      });
    } else if (hasNeoN3DataFeedTarget && neoContext) {
      batchTx = await submitQuotesToN3WithFallback(
        dataFeedHash,
        neoContext,
        scopedPayload,
        batchUpdates
      );
    }
  }

  if (requireSubmission && batchUpdates.length > 0 && !batchTx && !submissionIssue) {
    errors.push({
      target_chain: targetChain,
      error: 'feed batch submission returned no transaction metadata',
    });
  }

  for (const entry of batchUpdates) {
    if (batchTx) {
      state.records[entry.storagePair] = {
        provider: entry.quote.provider,
        pair: entry.quote.pair,
        storage_pair: entry.storagePair,
        price: entry.quote.price,
        price_units: decimalToIntegerString(entry.quote.price, entry.quote.decimals),
        round_id: entry.roundId,
        source_set_id: entry.sourceSetId,
        last_submitted_at_ms: Date.now(),
        last_observed_price: entry.quote.price,
        last_observed_price_units: decimalToIntegerString(entry.quote.price, entry.quote.decimals),
        last_observed_at_ms: entry.observedAtMs,
        attestation_hash: entry.quote.attestation_hash,
        price_scale_decimals: FEED_PRICE_DECIMALS,
        // C1 — persist the off-chain ECDSA signature + signer pubkey alongside the
        // anchored value so it can be verified once a verification key is registered.
        ...buildFeedSignatureFields(entry.quote),
      };
      continue;
    }

    state.records[entry.storagePair] = {
      ...(entry.previousRecord || {}),
      provider: entry.quote.provider,
      pair: entry.quote.pair,
      storage_pair: entry.storagePair,
      last_observed_price: entry.quote.price,
      last_observed_price_units: decimalToIntegerString(entry.quote.price, entry.quote.decimals),
      last_observed_at_ms: entry.observedAtMs,
      price_scale_decimals: FEED_PRICE_DECIMALS,
    };
  }

  for (const result of syncResults) {
    if (result.relay_status === 'queued') {
      result.relay_status = batchTx ? 'submitted' : 'skipped';
      if (!batchTx) {
        result.skip_reason = submissionIssue ? 'submission_unavailable' : 'submission_missing_tx';
      }
      result.anchored_tx = batchTx;
    }
  }

  await saveFeedState(state, scope);
  if (isEnabled(env('MORPHEUS_FEED_SNAPSHOT_SUPABASE_ENABLED'), true)) {
    const snapshotRows = buildFeedSnapshotRows(targetChain, syncResults, state, batchTx, scope);
    try {
      await persistFeedSnapshots(snapshotRows);
    } catch {
      // keep pricefeed path independent from Supabase write health
    }
  }

  return json(200, {
    mode: 'pricefeed',
    network: scope.network,
    target_chain: targetChain,
    symbols,
    batch_submitted: Boolean(batchTx),
    batch_count: batchUpdates.length,
    batch_tx: batchTx,
    sync_results: syncResults,
    errors,
    ...(Object.keys(aggregations).length > 0 ? { aggregations } : {}),
  });
}

export async function handleOracleFeedRequest(payload = {}) {
  if (!shouldFastAckOracleFeed(payload)) {
    return handleOracleFeed(payload);
  }

  const requestId = buildOracleFeedRequestId(payload);
  const scope = resolveFeedScope(
    payload,
    payload?.target_chain || payload?.targetChain || 'neo_n3'
  );
  scheduleOracleFeedBackgroundTask({
    ...payload,
    request_id: requestId,
    requestId,
    network: scope.network,
    target_chain: scope.targetChain,
  });

  return json(202, {
    accepted: true,
    status: 'accepted',
    mode: 'pricefeed',
    request_id: requestId,
    network: scope.network,
    target_chain: scope.targetChain,
    wait: false,
  });
}

export function listFeedSymbols() {
  return getDefaultFeedSymbols();
}
