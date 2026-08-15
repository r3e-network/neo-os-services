import fs from 'node:fs';
import path from 'node:path';
import { resolveKernelIntent } from './router.js';
import { computeRetryDelayMs } from './lib/retry.js';

// Per-chain state is keyed by these chain ids. Adding a chain here makes the
// relayer engine track its cursor/retry/dead-letter state automatically.
export const RELAYER_CHAINS = ['neo_n3', 'neox'];

function defaultChainState() {
  return {
    last_block: null,
    last_request_id: null,
    // Timestamp (ms) of the last successful discovery RPC; used by the idle-discovery
    // backoff (R2-0.1) to skip chain scanning on quiet ticks. 0 = never scanned yet.
    last_discovery_at: 0,
    processed_records: {},
    processed_order: [],
    retry_queue: [],
    dead_letters: [],
  };
}

function buildChainStates(source, normalize) {
  const out = {};
  for (const chain of RELAYER_CHAINS) {
    out[chain] = normalize ? normalizeChainState(source?.[chain]) : defaultChainState();
  }
  return out;
}

function defaultMetrics() {
  return {
    ticks_total: 0,
    events_scanned_total: 0,
    events_processed_total: 0,
    events_failed_total: 0,
    duplicates_skipped_total: 0,
    retries_scheduled_total: 0,
    retries_exhausted_total: 0,
    worker_calls_total: 0,
    worker_failures_total: 0,
    fulfill_success_total: 0,
    fulfill_failure_total: 0,
    claim_conflicts_total: 0,
    stale_reclaims_total: 0,
    // Discovery/reconciliation RPC failures and the durable-claim backoff skip
    // are incremented on the hot path; seed them here so they always appear in
    // snapshots/Prometheus output even before the first failure.
    discovery_failures_total: 0,
    reconciliation_failures_total: 0,
    durable_claim_skipped_during_backoff_total: 0,
    manual_actions_loaded_total: 0,
    feed_sync_runs_total: 0,
    feed_sync_success_total: 0,
    feed_sync_error_total: 0,
    feed_sync_skipped_total: 0,
    backpressure_deferred_total: 0,
    backpressure_retry_skipped_total: 0,
    // Retry items shed into the dead-letter lane when the retry queue exceeds
    // MORPHEUS_RELAYER_RETRY_QUEUE_LIMIT (B10).
    retry_queue_overflow_total: 0,
    last_feed_sync_started_at: null,
    last_feed_sync_completed_at: null,
    last_feed_sync_success_at: null,
    last_feed_sync_duration_ms: null,
    last_tick_started_at: null,
    last_tick_completed_at: null,
    last_tick_duration_ms: null,
    last_run_snapshot_persisted_at: null,
    last_run_snapshot_error_at: null,
    // Total processing latency (ms) of the most recent fulfilled/failed callback
    // (F2) — distinguishes "slow but recovering" from "stuck".
    last_fulfill_latency_ms: null,
    // F5: labeled failure counters keyed by "chain module operation".
    labeled_failures: {},
  };
}

export function createEmptyRelayerState() {
  return {
    version: 2,
    updated_at: null,
    ...buildChainStates(null, false),
    metrics: defaultMetrics(),
  };
}

function normalizeChainState(raw) {
  return {
    ...defaultChainState(),
    ...(raw && typeof raw === 'object' ? raw : {}),
    last_request_id: raw?.last_request_id ?? null,
    processed_records:
      raw?.processed_records && typeof raw.processed_records === 'object'
        ? raw.processed_records
        : {},
    processed_order: Array.isArray(raw?.processed_order) ? raw.processed_order : [],
    retry_queue: Array.isArray(raw?.retry_queue) ? raw.retry_queue : [],
    dead_letters: Array.isArray(raw?.dead_letters) ? raw.dead_letters : [],
  };
}

export function loadRelayerState(filePath, logger = null) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    // A missing file is the normal cold-start path; anything else (EACCES,
    // EISDIR, ...) silently dropping cursors/retry state deserves a warning.
    if (error?.code !== 'ENOENT') {
      logger?.warn?.(
        { state_file: filePath, error },
        'Failed to read relayer state file; starting from empty state'
      );
    }
    return createEmptyRelayerState();
  }
  try {
    const parsed = JSON.parse(raw);
    return {
      version: parsed?.version || 2,
      updated_at: parsed?.updated_at || null,
      ...buildChainStates(parsed, true),
      metrics: {
        ...defaultMetrics(),
        ...(parsed?.metrics && typeof parsed.metrics === 'object' ? parsed.metrics : {}),
      },
    };
  } catch (error) {
    logger?.warn?.(
      { state_file: filePath, error },
      'Relayer state file is corrupt; starting from empty state'
    );
    return createEmptyRelayerState();
  }
}

export function saveRelayerState(filePath, state) {
  state.updated_at = new Date().toISOString();
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  // Atomic replace: write the snapshot to a sibling temp file and rename it over
  // the live file so a crash/power loss mid-write can never truncate the state.
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

export function buildEventKey(event) {
  return [
    event?.chain || 'unknown',
    event?.requestId || '0',
    event?.txHash || '',
    event?.logIndex ?? '',
    event?.blockNumber ?? '',
  ].join(':');
}

function pruneProcessedRecords(chainState, limit) {
  while (chainState.processed_order.length > limit) {
    const oldestKey = chainState.processed_order.shift();
    if (!oldestKey) continue;
    delete chainState.processed_records[oldestKey];
  }
}

function pruneDeadLetters(chainState, limit) {
  if (chainState.dead_letters.length > limit) {
    chainState.dead_letters = chainState.dead_letters.slice(-limit);
  }
}

export function incrementMetric(state, metricName, delta = 1) {
  if (typeof state.metrics[metricName] !== 'number') {
    state.metrics[metricName] = 0;
  }
  state.metrics[metricName] += delta;
}

// F5: labeled failure counter {chain, module, operation}. The flat totals (e.g.
// fulfill_failure_total / retries_exhausted_total) stay authoritative for
// back-compat; this adds bounded-cardinality (chain x module x operation) detail
// so an incident can be localized to a lane without grepping logs. The labeled
// map lives under metrics.labeled_failures and is keyed by a delimiter-joined
// tuple; snapshotMetrics expands it for rendering.
export const LABELED_FAILURE_DELIMITER = '|';

export function incrementLabeledFailure(state, chain, module, operation, delta = 1) {
  if (!state.metrics.labeled_failures || typeof state.metrics.labeled_failures !== 'object') {
    state.metrics.labeled_failures = {};
  }
  const key = [chain || 'unknown', module || 'unknown', operation || 'unknown'].join(
    LABELED_FAILURE_DELIMITER
  );
  state.metrics.labeled_failures[key] = (Number(state.metrics.labeled_failures[key]) || 0) + delta;
}

// Age in seconds of the oldest ISO timestamp in `items[].field`, or null when the
// list is empty or carries no parseable timestamp. The first_failed_at /
// exhausted_at fields are ISO strings, so Date.parse them (F2). Clamped to >= 0
// so a slightly-future clock skew never emits a negative age.
function oldestAgeSeconds(items, field, nowMs) {
  let oldestMs = null;
  for (const item of items || []) {
    const parsed = Date.parse(String(item?.[field] || ''));
    if (!Number.isFinite(parsed)) continue;
    if (oldestMs === null || parsed < oldestMs) oldestMs = parsed;
  }
  if (oldestMs === null) return null;
  return Math.max(Math.floor((nowMs - oldestMs) / 1000), 0);
}

export function snapshotMetrics(state, nowMs = Date.now()) {
  const retry_queue_sizes = {};
  const dead_letter_sizes = {};
  const checkpoints = {};
  const request_checkpoints = {};
  // F2: per-chain queue-age gauges so a "stuck callback" is a one-query alert.
  const oldest_retry_age_seconds = {};
  const oldest_dead_letter_age_seconds = {};
  for (const chain of RELAYER_CHAINS) {
    const chainState = state[chain];
    if (!chainState) continue;
    retry_queue_sizes[chain] = chainState.retry_queue.length;
    dead_letter_sizes[chain] = chainState.dead_letters.length;
    checkpoints[chain] = chainState.last_block;
    request_checkpoints[chain] = chainState.last_request_id;
    oldest_retry_age_seconds[chain] = oldestAgeSeconds(
      chainState.retry_queue,
      'first_failed_at',
      nowMs
    );
    oldest_dead_letter_age_seconds[chain] = oldestAgeSeconds(
      chainState.dead_letters,
      'exhausted_at',
      nowMs
    );
  }
  // F5: expand the labeled failure map into an array of {chain, module, operation,
  // value} so the renderer can emit a labeled series per tuple.
  const labeled_failures = [];
  for (const [key, value] of Object.entries(state.metrics.labeled_failures || {})) {
    const [chain, module, operation] = String(key).split(LABELED_FAILURE_DELIMITER);
    labeled_failures.push({
      chain: chain || 'unknown',
      module: module || 'unknown',
      operation: operation || 'unknown',
      value: Number(value) || 0,
    });
  }

  return {
    ...state.metrics,
    retry_queue_sizes,
    dead_letter_sizes,
    checkpoints,
    request_checkpoints,
    oldest_retry_age_seconds,
    oldest_dead_letter_age_seconds,
    labeled_failures,
  };
}

export function hasProcessedEvent(state, chain, eventOrKey) {
  const key = typeof eventOrKey === 'string' ? eventOrKey : buildEventKey(eventOrKey);
  return Boolean(state?.[chain]?.processed_records?.[key]);
}

export function isEventQueuedForRetry(state, chain, eventOrKey) {
  const key = typeof eventOrKey === 'string' ? eventOrKey : buildEventKey(eventOrKey);
  return state?.[chain]?.retry_queue?.some((item) => item.key === key) || false;
}

export function removeProcessedEvent(state, chain, eventOrKey) {
  const key = typeof eventOrKey === 'string' ? eventOrKey : buildEventKey(eventOrKey);
  delete state[chain].processed_records[key];
  state[chain].processed_order = state[chain].processed_order.filter((entry) => entry !== key);
}

export function removeDeadLetter(state, chain, eventOrKey) {
  const key = typeof eventOrKey === 'string' ? eventOrKey : buildEventKey(eventOrKey);
  state[chain].dead_letters = state[chain].dead_letters.filter((entry) => entry.key !== key);
}

/**
 * Shed the oldest retry items into the dead-letter lane when the retry queue
 * exceeds `retryQueueLimit` (B10). A sustained ingestion burst plus a downstream
 * failure can otherwise grow the queue unboundedly — and the whole array is
 * re-serialized on every persist. The shed items are recoverable via the
 * dead-letter manual-replay lane. No-op when the limit is 0/unset so the live box
 * is unchanged until the operator opts in. Returns the number of items shed.
 */
export function enforceRetryQueueLimit(state, chain, limits = {}) {
  const limit = Math.max(Number(limits.retryQueueLimit || 0), 0);
  if (limit <= 0) return 0;
  const chainState = state[chain];
  if (!chainState || chainState.retry_queue.length <= limit) return 0;

  const overflowCount = chainState.retry_queue.length - limit;
  // Oldest-first: the array preserves insertion order, so the head is the oldest.
  const shed = chainState.retry_queue.slice(0, overflowCount);
  chainState.retry_queue = chainState.retry_queue.slice(overflowCount);

  for (const item of shed) {
    const event = item.event || {};
    const kernelIntent = resolveKernelIntent(event.requestType);
    chainState.dead_letters.push({
      key: item.key,
      request_id: String(event.requestId || '0'),
      request_type: String(event.requestType || ''),
      module_id: kernelIntent.moduleId,
      operation: kernelIntent.operation,
      chain,
      event,
      attempts: Number(item.attempts || 0),
      last_error: item.last_error || 'retry_queue_overflow',
      exhausted_at: new Date().toISOString(),
      shed_reason: 'retry_queue_overflow',
    });
  }
  pruneDeadLetters(chainState, limits.deadLetterLimit || 200);
  incrementMetric(state, 'retry_queue_overflow_total', shed.length);
  return shed.length;
}

export function enqueueRetryItem(state, chain, event, options = {}) {
  const chainState = state[chain];
  const key = buildEventKey(event);
  const item = {
    key,
    event,
    attempts: Number(options.attempts || 0),
    next_retry_at: Number(options.next_retry_at || Date.now()),
    first_failed_at: options.first_failed_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
    last_error: options.last_error || null,
    manual_action: options.manual_action || null,
    finalize_only: Boolean(options.finalize_only),
    terminal_error: options.terminal_error || null,
    prepared_fulfillment:
      options.prepared_fulfillment && typeof options.prepared_fulfillment === 'object'
        ? options.prepared_fulfillment
        : null,
    durable_claimed: Boolean(options.durable_claimed),
  };
  const index = chainState.retry_queue.findIndex((entry) => entry.key === key);
  if (index >= 0) {
    chainState.retry_queue[index] = item;
  } else {
    chainState.retry_queue.push(item);
  }
  // Shed the oldest overflow into the dead-letter lane when a ceiling is set. The
  // item just enqueued is the newest (tail), so an overflow sheds older items.
  enforceRetryQueueLimit(state, chain, {
    retryQueueLimit: options.retryQueueLimit,
    deadLetterLimit: options.deadLetterLimit,
  });
  return item;
}

export function recordProcessedEvent(state, chain, event, status, meta = {}, limits = {}) {
  const chainState = state[chain];
  const key = buildEventKey(event);
  const kernelIntent = resolveKernelIntent(event.requestType);
  if (!chainState.processed_records[key]) {
    chainState.processed_order.push(key);
  }
  chainState.processed_records[key] = {
    key,
    status,
    request_id: String(event.requestId || '0'),
    request_type: String(event.requestType || ''),
    module_id: kernelIntent.moduleId,
    operation: kernelIntent.operation,
    tx_hash: String(event.txHash || ''),
    block_number: Number(event.blockNumber ?? 0),
    completed_at: new Date().toISOString(),
    ...meta,
  };
  chainState.retry_queue = chainState.retry_queue.filter((item) => item.key !== key);
  if (status === 'exhausted') {
    chainState.dead_letters.push({
      key,
      request_id: String(event.requestId || '0'),
      request_type: String(event.requestType || ''),
      module_id: kernelIntent.moduleId,
      operation: kernelIntent.operation,
      chain,
      event,
      exhausted_at: new Date().toISOString(),
      ...meta,
    });
    pruneDeadLetters(chainState, limits.deadLetterLimit || 200);
  }
  pruneProcessedRecords(chainState, limits.processedCacheSize || 5000);
  return chainState.processed_records[key];
}

export function scheduleRetry(state, chain, event, errorMessage, config, rng = Math.random) {
  const chainState = state[chain];
  const key = buildEventKey(event);
  const existing = chainState.retry_queue.find((item) => item.key === key);
  const attempts = (existing?.attempts || 0) + 1;

  if (attempts > config.maxRetries) {
    chainState.retry_queue = chainState.retry_queue.filter((item) => item.key !== key);
    return {
      status: 'exhausted',
      key,
      attempts,
      error: errorMessage,
    };
  }

  // Backoff-with-jitter shared with the fulfillment retry lanes (single source of
  // truth in ./lib/retry.js) so the two lanes can't drift and re-stampede.
  const delayMs = computeRetryDelayMs(config, attempts, rng);
  const item = {
    key,
    event,
    attempts,
    next_retry_at: Date.now() + delayMs,
    first_failed_at: existing?.first_failed_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
    last_error: errorMessage,
  };

  if (existing) {
    const index = chainState.retry_queue.findIndex((entry) => entry.key === key);
    chainState.retry_queue[index] = item;
  } else {
    chainState.retry_queue.push(item);
  }

  enforceRetryQueueLimit(state, chain, {
    retryQueueLimit: config?.retryQueueLimit,
    deadLetterLimit: config?.deadLetterLimit,
  });

  return { status: 'scheduled', key, item };
}

export function getDueRetryItems(state, chain, now = Date.now()) {
  const chainState = state[chain];
  return chainState.retry_queue
    .filter((item) => Number(item.next_retry_at || 0) <= now)
    .sort((left, right) => Number(left.next_retry_at || 0) - Number(right.next_retry_at || 0));
}

export function clearRetryItem(state, chain, eventOrKey) {
  const key = typeof eventOrKey === 'string' ? eventOrKey : buildEventKey(eventOrKey);
  state[chain].retry_queue = state[chain].retry_queue.filter((item) => item.key !== key);
}

/**
 * Collect every requestId the relayer is already tracking for a chain — both
 * queued-for-retry (retry_queue, by event.requestId) and already-processed
 * (processed_records, by record.request_id). The block-cursor and request-cursor
 * lanes build DIFFERENT event keys for the same on-chain request (the block scan
 * carries txHash/logIndex/blockNumber; the request-cursor scan does not), so the
 * key-based filterNewEvents cannot dedupe a request seen by both lanes. The
 * request-cursor reconciliation pass excludes this membership set so a request
 * already handled this — or a prior — tick is not processed a second time, while
 * a genuinely-missed request (not in either set) is still picked up.
 */
export function collectActiveRequestIds(state, chain) {
  const ids = new Set();
  const chainState = state?.[chain];
  if (!chainState) return ids;
  for (const item of chainState.retry_queue || []) {
    const requestId = String(item?.event?.requestId || '');
    if (requestId) ids.add(requestId);
  }
  for (const record of Object.values(chainState.processed_records || {})) {
    const requestId = String(record?.request_id || '');
    if (requestId) ids.add(requestId);
  }
  return ids;
}
