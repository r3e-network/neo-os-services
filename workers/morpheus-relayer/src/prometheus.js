import { getLogSinkDroppedTotal } from './betterstack-log-sink.js';
import { LABELED_FAILURE_DELIMITER } from './state.js';

function metricLine(name, value, labels = null) {
  if (!Number.isFinite(value)) return null;
  const suffix = labels
    ? `{${Object.entries(labels)
        .map(([key, current]) => `${key}="${String(current).replace(/"/g, '\\"')}"`)
        .join(',')}}`
    : '';
  return `${name}${suffix} ${value}`;
}

function parseIsoToUnixSeconds(value) {
  const timestamp = Date.parse(String(value || ''));
  if (!Number.isFinite(timestamp)) return null;
  return Math.floor(timestamp / 1000);
}

// Flat top-level counters rendered as Prometheus `counter` series. Every metric
// name passed to incrementMetric() MUST appear here (or in the labeled-counter
// set) so it surfaces in the scrape; the drift-guard test in prometheus.test.mjs
// enforces this against the source so a new incrementMetric never goes unexported.
export const TOP_LEVEL_COUNTERS = [
  'ticks_total',
  'events_scanned_total',
  'events_processed_total',
  'events_failed_total',
  'duplicates_skipped_total',
  'retries_scheduled_total',
  'retries_exhausted_total',
  'worker_calls_total',
  'worker_failures_total',
  'fulfill_success_total',
  'fulfill_failure_total',
  'claim_conflicts_total',
  'stale_reclaims_total',
  'discovery_failures_total',
  'discovery_idle_skips_total',
  'reconciliation_failures_total',
  'durable_claim_skipped_during_backoff_total',
  'manual_actions_loaded_total',
  'feed_sync_runs_total',
  'feed_sync_success_total',
  'feed_sync_error_total',
  'feed_sync_skipped_total',
  'backpressure_deferred_total',
  'backpressure_retry_skipped_total',
  'retry_queue_overflow_total',
];

export function renderPrometheusMetrics(metrics = {}) {
  const lines = [
    '# HELP morpheus_relayer_ticks_total Total relayer ticks processed.',
    '# TYPE morpheus_relayer_ticks_total counter',
  ];

  const topLevelCounters = TOP_LEVEL_COUNTERS;

  for (const name of topLevelCounters) {
    const line = metricLine(`morpheus_relayer_${name}`, Number(metrics[name] || 0));
    if (line) lines.push(line);
  }

  const gauges = ['last_feed_sync_duration_ms', 'last_tick_duration_ms'];
  for (const name of gauges) {
    const line = metricLine(`morpheus_relayer_${name}`, Number(metrics[name] || 0));
    if (line) lines.push(line);
  }

  // F2: last-fulfill latency gauge. Only emitted once a callback has been
  // delivered (null until then) so the series does not falsely read 0.
  if (
    metrics.last_fulfill_latency_ms !== null &&
    metrics.last_fulfill_latency_ms !== undefined &&
    Number.isFinite(Number(metrics.last_fulfill_latency_ms))
  ) {
    const line = metricLine(
      'morpheus_relayer_last_fulfill_latency_ms',
      Number(metrics.last_fulfill_latency_ms)
    );
    if (line) lines.push(line);
  }

  // F2: per-chain queue-age gauges — a stuck callback is a one-query alert. Null
  // (empty queue) is skipped so the series only exists while work is pending.
  for (const [chain, value] of Object.entries(metrics.oldest_retry_age_seconds || {})) {
    if (value === null || value === undefined) continue;
    const line = metricLine('morpheus_relayer_oldest_retry_age_seconds', Number(value), { chain });
    if (line) lines.push(line);
  }
  for (const [chain, value] of Object.entries(metrics.oldest_dead_letter_age_seconds || {})) {
    if (value === null || value === undefined) continue;
    const line = metricLine('morpheus_relayer_oldest_dead_letter_age_seconds', Number(value), {
      chain,
    });
    if (line) lines.push(line);
  }

  const timestampGauges = {
    last_feed_sync_started_at: 'morpheus_relayer_last_feed_sync_started_at_seconds',
    last_feed_sync_completed_at: 'morpheus_relayer_last_feed_sync_completed_at_seconds',
    last_feed_sync_success_at: 'morpheus_relayer_last_feed_sync_success_at_seconds',
    last_tick_started_at: 'morpheus_relayer_last_tick_started_at_seconds',
    last_tick_completed_at: 'morpheus_relayer_last_tick_completed_at_seconds',
  };

  for (const [field, metricName] of Object.entries(timestampGauges)) {
    const seconds = parseIsoToUnixSeconds(metrics[field]);
    const line = seconds === null ? null : metricLine(metricName, seconds);
    if (line) lines.push(line);
  }

  for (const [chain, value] of Object.entries(metrics.retry_queue_sizes || {})) {
    const line = metricLine('morpheus_relayer_retry_queue_size', Number(value || 0), { chain });
    if (line) lines.push(line);
  }

  for (const [chain, value] of Object.entries(metrics.dead_letter_sizes || {})) {
    const line = metricLine('morpheus_relayer_dead_letter_size', Number(value || 0), { chain });
    if (line) lines.push(line);
  }

  for (const [chain, value] of Object.entries(metrics.checkpoints || {})) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) continue;
    const line = metricLine('morpheus_relayer_chain_checkpoint', numeric, { chain });
    if (line) lines.push(line);
  }

  for (const [chain, value] of Object.entries(metrics.request_checkpoints || {})) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) continue;
    const line = metricLine('morpheus_relayer_request_checkpoint', numeric, { chain });
    if (line) lines.push(line);
  }

  // F5: labeled failure counters {chain, module, operation}. Flat totals above
  // stay authoritative; this localizes an incident to a lane. snapshotMetrics
  // expands the labeled map into an array; tolerate the raw object form too.
  const labeledFailures = Array.isArray(metrics.labeled_failures)
    ? metrics.labeled_failures
    : Object.entries(metrics.labeled_failures || {}).map(([key, value]) => {
        const [chain, module, operation] = String(key).split(LABELED_FAILURE_DELIMITER);
        return {
          chain: chain || 'unknown',
          module: module || 'unknown',
          operation: operation || 'unknown',
          value: Number(value) || 0,
        };
      });
  for (const entry of labeledFailures) {
    const line = metricLine('morpheus_relayer_failures_total', Number(entry.value || 0), {
      chain: entry.chain,
      module: entry.module,
      operation: entry.operation,
    });
    if (line) lines.push(line);
  }

  // F7: BetterStack log-sink drop counter (process-global; the log sink is a
  // module-level singleton, not part of the per-tick metrics snapshot). Prefer a
  // value carried on the metrics object (test seam) and fall back to the live
  // sink counter.
  const logSinkDropped = Number.isFinite(Number(metrics.log_sink_dropped_total))
    ? Number(metrics.log_sink_dropped_total)
    : getLogSinkDroppedTotal();
  const dropLine = metricLine('morpheus_relayer_log_sink_dropped_total', logSinkDropped);
  if (dropLine) lines.push(dropLine);

  return `${lines.filter(Boolean).join('\n')}\n`;
}
