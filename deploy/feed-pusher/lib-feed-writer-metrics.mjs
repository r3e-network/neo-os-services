/**
 * Network-scoped Prometheus surface for feed-writer confirmation state.
 *
 * Derived from persisted PUSH_STATUS and the optional pending-batch sidecar.
 * Never interpolates pair names, txids, raw transactions, keys, or account
 * values. See docs/FEED-WRITER-METRICS.md.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

import { FEED_WRITE_MODE_BATCH, FEED_WRITE_MODE_PER_PAIR } from './lib-feed-network.mjs';

export const FEED_WRITER_CONFIRMATION_STATES = Object.freeze([
  'skipped',
  'submitted',
  'pending',
  'confirmed',
  'fault',
  'failed',
]);

export const FEED_WRITER_PAIR_RESULTS = Object.freeze([
  'submitted',
  'pending',
  'confirmed',
  'skipped',
  'faulted',
  'failed',
]);

export const FEED_WRITER_SOURCE_RESULTS = Object.freeze(['skipped', 'missing']);

export const FEED_WRITER_WRITE_MODES = Object.freeze([
  FEED_WRITE_MODE_BATCH,
  FEED_WRITE_MODE_PER_PAIR,
]);

export const FEED_WRITER_METRIC_NAMES = Object.freeze({
  last_attempt: 'neoos_feed_writer_last_attempt_timestamp_seconds',
  last_submitted: 'neoos_feed_writer_last_submitted_timestamp_seconds',
  last_confirmed: 'neoos_feed_writer_last_confirmed_timestamp_seconds',
  last_submitted_height: 'neoos_feed_writer_last_submitted_height',
  last_confirmed_height: 'neoos_feed_writer_last_confirmed_height',
  confirmation_state: 'neoos_feed_writer_confirmation_state',
  pairs: 'neoos_feed_writer_pairs',
  source_pairs: 'neoos_feed_writer_source_pairs',
  latency: 'neoos_feed_writer_confirmation_latency_seconds',
  failed_cycles: 'neoos_feed_writer_failed_cycles_total',
  outstanding_replay: 'neoos_feed_writer_outstanding_replay',
  write_mode: 'neoos_feed_writer_write_mode',
});

const CONFIRMATION_STATE_SET = new Set(FEED_WRITER_CONFIRMATION_STATES);

function countList(value) {
  return Array.isArray(value) ? value.length : 0;
}

function finiteCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function parseUnixSeconds(value) {
  const timestamp = Date.parse(String(value || ''));
  if (!Number.isFinite(timestamp)) return null;
  return Math.floor(timestamp / 1000);
}

export function sanitizeFeedWriterNetwork(value) {
  const network = String(value || '')
    .trim()
    .toLowerCase();
  return network === 'mainnet' || network === 'testnet' ? network : '';
}

export function sanitizeFeedWriteMode(value) {
  return FEED_WRITER_WRITE_MODES.includes(value) ? value : '';
}

export function writerMetricsStatePath(statusPath) {
  return `${statusPath}.metrics.json`;
}

export function pendingBatchSidecarPath(statusPath) {
  return `${statusPath}.pending-batch.json`;
}

export function classifyWriterConfirmationState(status = {}, { pendingReplay = false } = {}) {
  const faulted = countList(status.pairs_faulted);
  const confirmation = String(status.confirmation_status || '')
    .trim()
    .toLowerCase();
  if (faulted > 0 || confirmation === 'fault') return 'fault';
  if (pendingReplay && (confirmation === 'confirmed' || confirmation === 'skipped' || confirmation === '')) {
    return 'pending';
  }
  if (CONFIRMATION_STATE_SET.has(confirmation)) return confirmation;
  return '';
}

function readJsonObject(filePath) {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    return null;
  }
}

export function readPendingReplayPresence(sidecarPath, expectedNetwork = '') {
  if (!sidecarPath || !existsSync(sidecarPath)) return false;
  const parsed = readJsonObject(sidecarPath);
  if (!parsed) return true;
  const sidecarNetwork = sanitizeFeedWriterNetwork(parsed.network);
  const expected = sanitizeFeedWriterNetwork(expectedNetwork);
  if (sidecarNetwork && expected && sidecarNetwork !== expected) return false;
  return true;
}

function previousNumber(previous, key) {
  const value = Number(previous?.[key]);
  return Number.isFinite(value) ? value : null;
}

export function advanceWriterMetrics({
  status = {},
  previous = null,
  pendingReplay = false,
} = {}) {
  const network = sanitizeFeedWriterNetwork(status.network);
  const writeMode = sanitizeFeedWriteMode(status.write_mode);
  const confirmationState = classifyWriterConfirmationState(status, { pendingReplay });
  const attemptUnix = parseUnixSeconds(status.ts);
  const height = Number(status.submitted_identity?.validUntilBlock);
  const safeHeight = Number.isSafeInteger(height) && height > 0 ? height : null;
  const cycleKey = String(status.ts || '');

  const next = {
    version: 1,
    network,
    write_mode: writeMode,
    confirmation_state: confirmationState,
    last_attempt_unix: attemptUnix,
    last_submitted_unix: previousNumber(previous, 'last_submitted_unix'),
    last_confirmed_unix: previousNumber(previous, 'last_confirmed_unix'),
    last_submitted_height: previousNumber(previous, 'last_submitted_height'),
    last_confirmed_height: previousNumber(previous, 'last_confirmed_height'),
    last_confirmation_latency_seconds: previousNumber(previous, 'last_confirmation_latency_seconds'),
    failed_cycles_total: Math.max(0, Math.floor(Number(previous?.failed_cycles_total) || 0)),
    last_failed_cycle_ts: String(previous?.last_failed_cycle_ts || ''),
    outstanding_replay: pendingReplay ? 1 : 0,
    pairs: {
      submitted: countList(status.pairs_submitted),
      pending: countList(status.pairs_pending),
      confirmed: countList(status.pairs_confirmed),
      skipped: countList(status.pairs_skipped),
      faulted: countList(status.pairs_faulted),
      failed: countList(status.pairs_failed),
    },
    source_pairs: {
      skipped: finiteCount(status.skipped),
      missing: finiteCount(status.missing),
    },
  };

  if (
    (confirmationState === 'submitted' || confirmationState === 'pending') &&
    attemptUnix != null
  ) {
    next.last_submitted_unix = attemptUnix;
    if (safeHeight != null) next.last_submitted_height = safeHeight;
  }

  if (confirmationState === 'confirmed' && attemptUnix != null) {
    next.last_confirmed_unix = attemptUnix;
    if (safeHeight != null) next.last_confirmed_height = safeHeight;
    if (next.last_submitted_unix != null && attemptUnix >= next.last_submitted_unix) {
      next.last_confirmation_latency_seconds = attemptUnix - next.last_submitted_unix;
    }
  }

  if (
    (confirmationState === 'fault' || confirmationState === 'failed') &&
    status.submitted_identity &&
    attemptUnix != null
  ) {
    if (next.last_submitted_unix == null) next.last_submitted_unix = attemptUnix;
    if (safeHeight != null && next.last_submitted_height == null) {
      next.last_submitted_height = safeHeight;
    }
  }

  if (
    (confirmationState === 'failed' || confirmationState === 'fault') &&
    cycleKey &&
    cycleKey !== next.last_failed_cycle_ts
  ) {
    next.failed_cycles_total += 1;
    next.last_failed_cycle_ts = cycleKey;
  }

  return next;
}

function escapeLabelValue(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function metricLine(name, value, labels) {
  if (!Number.isFinite(value)) return null;
  const body = Object.entries(labels)
    .map(([key, current]) => `${key}="${escapeLabelValue(current)}"`)
    .join(',');
  return `${name}{${body}} ${value}`;
}

export function renderFeedWriterPrometheus(snapshot = {}) {
  const network = sanitizeFeedWriterNetwork(snapshot.network);
  if (!network) return '';

  const lines = [
    '# HELP neoos_feed_writer_last_attempt_timestamp_seconds Unix seconds of the last persisted writer status.',
    '# TYPE neoos_feed_writer_last_attempt_timestamp_seconds gauge',
  ];
  const attempt = metricLine(FEED_WRITER_METRIC_NAMES.last_attempt, snapshot.last_attempt_unix, {
    network,
  });
  if (attempt) lines.push(attempt);

  lines.push(
    '# HELP neoos_feed_writer_last_submitted_timestamp_seconds Unix seconds of the last broadcast-accept persist.',
    '# TYPE neoos_feed_writer_last_submitted_timestamp_seconds gauge'
  );
  const submitted = metricLine(
    FEED_WRITER_METRIC_NAMES.last_submitted,
    snapshot.last_submitted_unix,
    { network }
  );
  if (submitted) lines.push(submitted);

  lines.push(
    '# HELP neoos_feed_writer_last_confirmed_timestamp_seconds Unix seconds of the last application-log HALT persist.',
    '# TYPE neoos_feed_writer_last_confirmed_timestamp_seconds gauge'
  );
  const confirmed = metricLine(
    FEED_WRITER_METRIC_NAMES.last_confirmed,
    snapshot.last_confirmed_unix,
    { network }
  );
  if (confirmed) lines.push(confirmed);

  lines.push(
    '# HELP neoos_feed_writer_last_submitted_height Last submitted valid-until height. Not a txid.',
    '# TYPE neoos_feed_writer_last_submitted_height gauge'
  );
  const submittedHeight = metricLine(
    FEED_WRITER_METRIC_NAMES.last_submitted_height,
    snapshot.last_submitted_height,
    { network }
  );
  if (submittedHeight) lines.push(submittedHeight);

  lines.push(
    '# HELP neoos_feed_writer_last_confirmed_height Last confirmed valid-until height.',
    '# TYPE neoos_feed_writer_last_confirmed_height gauge'
  );
  const confirmedHeight = metricLine(
    FEED_WRITER_METRIC_NAMES.last_confirmed_height,
    snapshot.last_confirmed_height,
    { network }
  );
  if (confirmedHeight) lines.push(confirmedHeight);

  lines.push(
    '# HELP neoos_feed_writer_confirmation_state One-hot writer confirmation class. skipped means no planned writes.',
    '# TYPE neoos_feed_writer_confirmation_state gauge'
  );
  for (const state of FEED_WRITER_CONFIRMATION_STATES) {
    lines.push(
      metricLine(FEED_WRITER_METRIC_NAMES.confirmation_state, snapshot.confirmation_state === state ? 1 : 0, {
        network,
        state,
      })
    );
  }

  lines.push(
    '# HELP neoos_feed_writer_pairs Pair counts by persisted confirmation bucket. Labels are buckets, never pair ids.',
    '# TYPE neoos_feed_writer_pairs gauge'
  );
  for (const result of FEED_WRITER_PAIR_RESULTS) {
    lines.push(
      metricLine(FEED_WRITER_METRIC_NAMES.pairs, finiteCount(snapshot.pairs?.[result]), {
        network,
        result,
      })
    );
  }

  lines.push(
    '# HELP neoos_feed_writer_source_pairs Planning-phase skipped/missing counts. Not confirmation state.',
    '# TYPE neoos_feed_writer_source_pairs gauge'
  );
  for (const result of FEED_WRITER_SOURCE_RESULTS) {
    lines.push(
      metricLine(FEED_WRITER_METRIC_NAMES.source_pairs, finiteCount(snapshot.source_pairs?.[result]), {
        network,
        result,
      })
    );
  }

  lines.push(
    '# HELP neoos_feed_writer_confirmation_latency_seconds Seconds from last submitted persist to last confirmed persist.',
    '# TYPE neoos_feed_writer_confirmation_latency_seconds gauge'
  );
  const latency = metricLine(FEED_WRITER_METRIC_NAMES.latency, snapshot.last_confirmation_latency_seconds, {
    network,
  });
  if (latency) lines.push(latency);

  lines.push(
    '# HELP neoos_feed_writer_failed_cycles_total Persisted cycles that ended failed or fault. Not pending or skipped.',
    '# TYPE neoos_feed_writer_failed_cycles_total counter'
  );
  lines.push(
    metricLine(FEED_WRITER_METRIC_NAMES.failed_cycles, finiteCount(snapshot.failed_cycles_total), {
      network,
    })
  );

  lines.push(
    '# HELP neoos_feed_writer_outstanding_replay 1 when a pending-batch sidecar exists for this network.',
    '# TYPE neoos_feed_writer_outstanding_replay gauge'
  );
  lines.push(
    metricLine(FEED_WRITER_METRIC_NAMES.outstanding_replay, snapshot.outstanding_replay ? 1 : 0, {
      network,
    })
  );

  lines.push(
    '# HELP neoos_feed_writer_write_mode One-hot persisted write mode.',
    '# TYPE neoos_feed_writer_write_mode gauge'
  );
  for (const mode of FEED_WRITER_WRITE_MODES) {
    lines.push(
      metricLine(FEED_WRITER_METRIC_NAMES.write_mode, snapshot.write_mode === mode ? 1 : 0, {
        network,
        mode,
      })
    );
  }

  return `${lines.join('\n')}\n`;
}

function writeAtomicFile(filePath, body, mode) {
  const temp = `${filePath}.${process.pid}.tmp`;
  writeFileSync(temp, body, { mode });
  renameSync(temp, filePath);
}

export function writeWriterMetricsState(filePath, snapshot) {
  if (!filePath) return;
  writeAtomicFile(
    filePath,
    `${JSON.stringify(
      {
        version: 1,
        network: sanitizeFeedWriterNetwork(snapshot.network),
        write_mode: sanitizeFeedWriteMode(snapshot.write_mode),
        confirmation_state: CONFIRMATION_STATE_SET.has(snapshot.confirmation_state)
          ? snapshot.confirmation_state
          : '',
        last_attempt_unix: snapshot.last_attempt_unix,
        last_submitted_unix: snapshot.last_submitted_unix,
        last_confirmed_unix: snapshot.last_confirmed_unix,
        last_submitted_height: snapshot.last_submitted_height,
        last_confirmed_height: snapshot.last_confirmed_height,
        last_confirmation_latency_seconds: snapshot.last_confirmation_latency_seconds,
        failed_cycles_total: finiteCount(snapshot.failed_cycles_total),
        last_failed_cycle_ts: String(snapshot.last_failed_cycle_ts || ''),
        outstanding_replay: snapshot.outstanding_replay ? 1 : 0,
        pairs: {
          submitted: finiteCount(snapshot.pairs?.submitted),
          pending: finiteCount(snapshot.pairs?.pending),
          confirmed: finiteCount(snapshot.pairs?.confirmed),
          skipped: finiteCount(snapshot.pairs?.skipped),
          faulted: finiteCount(snapshot.pairs?.faulted),
          failed: finiteCount(snapshot.pairs?.failed),
        },
        source_pairs: {
          skipped: finiteCount(snapshot.source_pairs?.skipped),
          missing: finiteCount(snapshot.source_pairs?.missing),
        },
      },
      null,
      2
    )}\n`,
    0o600
  );
}

export function writeFeedWriterPrometheusTextfile(filePath, snapshot) {
  if (!filePath) return;
  writeAtomicFile(filePath, renderFeedWriterPrometheus(snapshot), 0o644);
}

export function loadWriterMetricsFromDisk({ statusPath, sidecarPath, metricsPath } = {}) {
  const status = statusPath ? readJsonObject(statusPath) : null;
  const previous = metricsPath ? readJsonObject(metricsPath) : null;
  const pendingReplay = readPendingReplayPresence(sidecarPath, status?.network || previous?.network);
  if (!status) {
    return { snapshot: previous, pendingReplay };
  }
  return {
    snapshot: advanceWriterMetrics({ status, previous, pendingReplay }),
    pendingReplay,
  };
}

export function persistFeedWriterMetrics({
  status,
  statusPath,
  promPath = '',
} = {}) {
  if (!statusPath) return null;
  const sidecarPath = pendingBatchSidecarPath(statusPath);
  const metricsPath = writerMetricsStatePath(statusPath);
  const previous = readJsonObject(metricsPath);
  const pendingReplay = readPendingReplayPresence(sidecarPath, status?.network);
  const snapshot = advanceWriterMetrics({ status, previous, pendingReplay });
  writeWriterMetricsState(metricsPath, snapshot);
  writeFeedWriterPrometheusTextfile(promPath, snapshot);
  return snapshot;
}

export function restoreFeedWriterMetricsFromDisk({ statusPath, promPath = '' } = {}) {
  if (!statusPath) return null;
  const loaded = loadWriterMetricsFromDisk({
    statusPath,
    sidecarPath: pendingBatchSidecarPath(statusPath),
    metricsPath: writerMetricsStatePath(statusPath),
  });
  if (!loaded.snapshot) return null;
  writeFeedWriterPrometheusTextfile(promPath, loaded.snapshot);
  return loaded.snapshot;
}
