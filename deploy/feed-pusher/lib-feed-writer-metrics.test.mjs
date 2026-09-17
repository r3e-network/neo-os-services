import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { FEED_WRITE_MODE_BATCH, FEED_WRITE_MODE_PER_PAIR } from './lib-feed-network.mjs';
import {
  FEED_WRITER_CONFIRMATION_STATES,
  FEED_WRITER_METRIC_NAMES,
  FEED_WRITER_PAIR_RESULTS,
  advanceWriterMetrics,
  classifyWriterConfirmationState,
  loadWriterMetricsFromDisk,
  renderFeedWriterPrometheus,
  writeFeedWriterPrometheusTextfile,
  writeWriterMetricsState,
} from './lib-feed-writer-metrics.mjs';

const LEAK_RE =
  /TWELVEDATA:|0x[0-9a-f]{16}|rawTx|TD_KEY|sk_live|NN8tbpg|NiUs458|validUntilBlock|nonce=|account/i;

function statusFixture(overrides = {}) {
  return {
    ts: '2026-09-01T00:00:10.000Z',
    network: 'mainnet',
    write_mode: FEED_WRITE_MODE_BATCH,
    ok: true,
    confirmation_status: 'confirmed',
    pairs_submitted: ['TWELVEDATA:NEO-USD', 'TWELVEDATA:GAS-USD'],
    pairs_confirmed: ['TWELVEDATA:NEO-USD', 'TWELVEDATA:GAS-USD'],
    pairs_pending: [],
    pairs_failed: [],
    pairs_skipped: [],
    pairs_faulted: [],
    skipped: 1,
    missing: 0,
    txids: ['0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
    submitted_identity: {
      hash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      nonce: 7,
      validUntilBlock: 12_540_100,
    },
    write_attempts: [
      {
        pair: 'TWELVEDATA:NEO-USD',
        status: 'confirmed',
        attempt: 1,
        txid: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        error: null,
      },
    ],
    ...overrides,
  };
}

function metricValue(text, name, labels = {}) {
  const labelBody = Object.entries(labels)
    .map(([key, value]) => `${key}="${value}"`)
    .join(',');
  const suffix = labelBody ? `{${labelBody}}` : '';
  const match = text.match(
    new RegExp(`^${name}${suffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} (.+)$`, 'm')
  );
  return match ? match[1] : null;
}

function oneHotStates(text, network) {
  const found = {};
  for (const state of FEED_WRITER_CONFIRMATION_STATES) {
    found[state] = metricValue(text, FEED_WRITER_METRIC_NAMES.confirmation_state, {
      network,
      state,
    });
  }
  return found;
}

test('metric name and label vocabulary stays low cardinality', () => {
  assert.deepEqual(FEED_WRITER_CONFIRMATION_STATES, [
    'skipped',
    'submitted',
    'pending',
    'confirmed',
    'fault',
    'failed',
  ]);
  assert.deepEqual(FEED_WRITER_PAIR_RESULTS, [
    'submitted',
    'pending',
    'confirmed',
    'skipped',
    'faulted',
    'failed',
  ]);
  assert.equal(
    FEED_WRITER_METRIC_NAMES.last_attempt,
    'neoos_feed_writer_last_attempt_timestamp_seconds'
  );
  assert.equal(
    FEED_WRITER_METRIC_NAMES.last_submitted,
    'neoos_feed_writer_last_submitted_timestamp_seconds'
  );
  assert.equal(
    FEED_WRITER_METRIC_NAMES.last_confirmed,
    'neoos_feed_writer_last_confirmed_timestamp_seconds'
  );
  assert.equal(
    FEED_WRITER_METRIC_NAMES.last_submitted_height,
    'neoos_feed_writer_last_submitted_height'
  );
  assert.equal(
    FEED_WRITER_METRIC_NAMES.last_confirmed_height,
    'neoos_feed_writer_last_confirmed_height'
  );
  assert.equal(FEED_WRITER_METRIC_NAMES.confirmation_state, 'neoos_feed_writer_confirmation_state');
  assert.equal(FEED_WRITER_METRIC_NAMES.pairs, 'neoos_feed_writer_pairs');
  assert.equal(FEED_WRITER_METRIC_NAMES.source_pairs, 'neoos_feed_writer_source_pairs');
  assert.equal(FEED_WRITER_METRIC_NAMES.latency, 'neoos_feed_writer_confirmation_latency_seconds');
  assert.equal(FEED_WRITER_METRIC_NAMES.failed_cycles, 'neoos_feed_writer_failed_cycles_total');
  assert.equal(FEED_WRITER_METRIC_NAMES.outstanding_replay, 'neoos_feed_writer_outstanding_replay');
  assert.equal(FEED_WRITER_METRIC_NAMES.write_mode, 'neoos_feed_writer_write_mode');
});

test('classifyWriterConfirmationState distinguishes skipped from unconfirmed and FAULT', () => {
  assert.equal(
    classifyWriterConfirmationState({ confirmation_status: 'skipped', pairs_faulted: [] }),
    'skipped'
  );
  assert.equal(
    classifyWriterConfirmationState({ confirmation_status: 'submitted', pairs_faulted: [] }),
    'submitted'
  );
  assert.equal(
    classifyWriterConfirmationState({ confirmation_status: 'pending', pairs_faulted: [] }),
    'pending'
  );
  assert.equal(
    classifyWriterConfirmationState({ confirmation_status: 'confirmed', pairs_faulted: [] }),
    'confirmed'
  );
  assert.equal(
    classifyWriterConfirmationState({
      confirmation_status: 'failed',
      pairs_faulted: ['TWELVEDATA:NEO-USD'],
    }),
    'fault'
  );
  assert.equal(
    classifyWriterConfirmationState({ confirmation_status: 'failed', pairs_faulted: [] }),
    'failed'
  );
  assert.equal(
    classifyWriterConfirmationState(
      { confirmation_status: 'confirmed', pairs_faulted: [] },
      { pendingReplay: true }
    ),
    'pending'
  );
  assert.equal(classifyWriterConfirmationState({ ok: false, errors: ['env'] }), '');
});

test('batch confirmed cycle records timestamps, height, latency, and no leak', () => {
  const submitted = advanceWriterMetrics({
    status: statusFixture({
      ts: '2026-09-01T00:00:00.000Z',
      ok: false,
      confirmation_status: 'submitted',
      pairs_confirmed: [],
    }),
  });
  const confirmed = advanceWriterMetrics({
    status: statusFixture({ ts: '2026-09-01T00:00:04.000Z' }),
    previous: submitted,
  });
  assert.equal(confirmed.confirmation_state, 'confirmed');
  assert.equal(confirmed.network, 'mainnet');
  assert.equal(confirmed.write_mode, FEED_WRITE_MODE_BATCH);
  assert.equal(confirmed.last_attempt_unix, Date.parse('2026-09-01T00:00:04.000Z') / 1000);
  assert.equal(confirmed.last_submitted_unix, Date.parse('2026-09-01T00:00:00.000Z') / 1000);
  assert.equal(confirmed.last_confirmed_unix, Date.parse('2026-09-01T00:00:04.000Z') / 1000);
  assert.equal(confirmed.last_submitted_height, 12_540_100);
  assert.equal(confirmed.last_confirmed_height, 12_540_100);
  assert.equal(confirmed.last_confirmation_latency_seconds, 4);
  assert.equal(confirmed.failed_cycles_total, 0);
  assert.equal(confirmed.outstanding_replay, 0);
  assert.equal(confirmed.pairs.confirmed, 2);
  assert.equal(confirmed.pairs.pending, 0);

  const text = renderFeedWriterPrometheus(confirmed);
  assert.equal(metricValue(text, FEED_WRITER_METRIC_NAMES.latency, { network: 'mainnet' }), '4');
  assert.equal(
    metricValue(text, FEED_WRITER_METRIC_NAMES.confirmation_state, {
      network: 'mainnet',
      state: 'confirmed',
    }),
    '1'
  );
  assert.equal(
    metricValue(text, FEED_WRITER_METRIC_NAMES.write_mode, {
      network: 'mainnet',
      mode: FEED_WRITE_MODE_BATCH,
    }),
    '1'
  );
  assert.equal(
    metricValue(text, FEED_WRITER_METRIC_NAMES.write_mode, {
      network: 'mainnet',
      mode: FEED_WRITE_MODE_PER_PAIR,
    }),
    '0'
  );
  assert.doesNotMatch(text, LEAK_RE);
  for (const state of FEED_WRITER_CONFIRMATION_STATES) {
    if (state === 'confirmed') continue;
    assert.equal(oneHotStates(text, 'mainnet')[state], '0');
  }
});

test('batch pending plus sidecar is unconfirmed, not skipped, and does not increment failed cycles', () => {
  const snapshot = advanceWriterMetrics({
    status: statusFixture({
      ts: '2026-09-01T00:01:00.000Z',
      ok: false,
      confirmation_status: 'pending',
      pairs_confirmed: [],
      pairs_pending: ['TWELVEDATA:NEO-USD', 'TWELVEDATA:GAS-USD'],
    }),
    pendingReplay: true,
    previous: { failed_cycles_total: 3, last_failed_cycle_ts: 'old' },
  });
  assert.equal(snapshot.confirmation_state, 'pending');
  assert.equal(snapshot.outstanding_replay, 1);
  assert.equal(snapshot.failed_cycles_total, 3);
  assert.equal(snapshot.pairs.pending, 2);
  const text = renderFeedWriterPrometheus(snapshot);
  assert.equal(
    metricValue(text, FEED_WRITER_METRIC_NAMES.confirmation_state, {
      network: 'mainnet',
      state: 'pending',
    }),
    '1'
  );
  assert.equal(
    metricValue(text, FEED_WRITER_METRIC_NAMES.confirmation_state, {
      network: 'mainnet',
      state: 'skipped',
    }),
    '0'
  );
  assert.equal(
    metricValue(text, FEED_WRITER_METRIC_NAMES.outstanding_replay, { network: 'mainnet' }),
    '1'
  );
  assert.equal(
    metricValue(text, FEED_WRITER_METRIC_NAMES.failed_cycles, { network: 'mainnet' }),
    '3'
  );
  assert.doesNotMatch(text, LEAK_RE);
});

test('batch FAULT increments failed cycles once and stays fault after restart', () => {
  const tmp = path.join(os.tmpdir(), `feed-writer-metrics-fault-${process.pid}`);
  mkdirSync(tmp, { recursive: true });
  const statusPath = path.join(tmp, 'feed-pusher-status.json');
  const sidecarPath = path.join(tmp, 'feed-pusher-status.json.pending-batch.json');
  const metricsPath = path.join(tmp, 'feed-pusher-status.json.metrics.json');
  try {
    const faultStatus = statusFixture({
      ts: '2026-09-01T00:02:00.000Z',
      ok: false,
      confirmation_status: 'failed',
      pairs_confirmed: [],
      pairs_failed: ['TWELVEDATA:NEO-USD', 'TWELVEDATA:GAS-USD'],
      pairs_faulted: ['TWELVEDATA:NEO-USD', 'TWELVEDATA:GAS-USD'],
    });
    writeFileSync(statusPath, JSON.stringify(faultStatus, null, 2));
    const first = advanceWriterMetrics({ status: faultStatus });
    writeWriterMetricsState(metricsPath, first);
    assert.equal(first.confirmation_state, 'fault');
    assert.equal(first.failed_cycles_total, 1);
    assert.equal(first.pairs.faulted, 2);

    const replay = loadWriterMetricsFromDisk({ statusPath, sidecarPath, metricsPath });
    assert.equal(replay.snapshot.confirmation_state, 'fault');
    assert.equal(
      replay.snapshot.failed_cycles_total,
      1,
      'restart must not double-count the same cycle'
    );
    const text = renderFeedWriterPrometheus(replay.snapshot);
    assert.equal(
      metricValue(text, FEED_WRITER_METRIC_NAMES.confirmation_state, {
        network: 'mainnet',
        state: 'fault',
      }),
      '1'
    );
    assert.equal(
      metricValue(text, FEED_WRITER_METRIC_NAMES.pairs, { network: 'mainnet', result: 'faulted' }),
      '2'
    );
    assert.doesNotMatch(text, LEAK_RE);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('per-pair success, pending, FAULT, and skipped stay network-scoped', () => {
  const confirmed = advanceWriterMetrics({
    status: statusFixture({
      network: 'testnet',
      write_mode: FEED_WRITE_MODE_PER_PAIR,
      confirmation_status: 'confirmed',
      pairs_submitted: ['TWELVEDATA:NEO-USD'],
      pairs_confirmed: ['TWELVEDATA:NEO-USD'],
      submitted_identity: { hash: '0xbbbb', nonce: 2, validUntilBlock: 4_000_500 },
    }),
  });
  assert.equal(confirmed.network, 'testnet');
  assert.equal(confirmed.write_mode, FEED_WRITE_MODE_PER_PAIR);
  assert.equal(confirmed.confirmation_state, 'confirmed');

  const pending = advanceWriterMetrics({
    status: statusFixture({
      network: 'testnet',
      write_mode: FEED_WRITE_MODE_PER_PAIR,
      ok: false,
      confirmation_status: 'pending',
      pairs_confirmed: [],
      pairs_pending: ['TWELVEDATA:GAS-USD'],
      pairs_submitted: ['TWELVEDATA:GAS-USD'],
    }),
  });
  assert.equal(pending.confirmation_state, 'pending');
  assert.equal(pending.pairs.pending, 1);

  const faulted = advanceWriterMetrics({
    status: statusFixture({
      network: 'testnet',
      write_mode: FEED_WRITE_MODE_PER_PAIR,
      ok: false,
      confirmation_status: 'failed',
      pairs_confirmed: [],
      pairs_failed: ['TWELVEDATA:BTC-USD'],
      pairs_faulted: ['TWELVEDATA:BTC-USD'],
    }),
  });
  assert.equal(faulted.confirmation_state, 'fault');

  const skipped = advanceWriterMetrics({
    status: statusFixture({
      network: 'testnet',
      write_mode: FEED_WRITE_MODE_PER_PAIR,
      confirmation_status: 'skipped',
      pairs_submitted: [],
      pairs_confirmed: [],
      submitted_identity: null,
      skipped: 4,
      missing: 3,
    }),
  });
  assert.equal(skipped.confirmation_state, 'skipped');
  assert.equal(skipped.source_pairs.skipped, 4);
  assert.equal(skipped.source_pairs.missing, 3);

  const skippedText = renderFeedWriterPrometheus(skipped);
  assert.equal(
    metricValue(skippedText, FEED_WRITER_METRIC_NAMES.confirmation_state, {
      network: 'testnet',
      state: 'skipped',
    }),
    '1'
  );
  assert.equal(
    metricValue(skippedText, FEED_WRITER_METRIC_NAMES.confirmation_state, {
      network: 'testnet',
      state: 'pending',
    }),
    '0'
  );
  assert.equal(
    metricValue(skippedText, FEED_WRITER_METRIC_NAMES.confirmation_state, {
      network: 'testnet',
      state: 'fault',
    }),
    '0'
  );
  assert.equal(
    metricValue(skippedText, FEED_WRITER_METRIC_NAMES.source_pairs, {
      network: 'testnet',
      result: 'missing',
    }),
    '3'
  );
  assert.match(
    skippedText,
    /neoos_feed_writer_write_mode\{network="testnet",mode="per_pair_update_feed"\} 1/
  );
  assert.doesNotMatch(skippedText, /network="mainnet"/);
  assert.doesNotMatch(skippedText, LEAK_RE);
});

test('restart rebuilds the same exposition from status, sidecar, and metrics sidecar', () => {
  const tmp = path.join(os.tmpdir(), `feed-writer-metrics-restart-${process.pid}`);
  mkdirSync(tmp, { recursive: true });
  const statusPath = path.join(tmp, 'status.json');
  const sidecarPath = `${statusPath}.pending-batch.json`;
  const metricsPath = `${statusPath}.metrics.json`;
  const promPath = path.join(tmp, 'writer.prom');
  try {
    const submitted = statusFixture({
      ts: '2026-09-01T00:03:00.000Z',
      ok: false,
      confirmation_status: 'submitted',
      pairs_confirmed: [],
    });
    const pending = statusFixture({
      ts: '2026-09-01T00:03:02.000Z',
      ok: false,
      confirmation_status: 'pending',
      pairs_confirmed: [],
      pairs_pending: ['TWELVEDATA:NEO-USD', 'TWELVEDATA:GAS-USD'],
    });
    const live = advanceWriterMetrics({
      status: pending,
      previous: advanceWriterMetrics({ status: submitted }),
      pendingReplay: true,
    });
    writeFileSync(statusPath, JSON.stringify(pending, null, 2));
    writeFileSync(
      sidecarPath,
      JSON.stringify({
        version: 1,
        network: 'mainnet',
        write_mode: FEED_WRITE_MODE_BATCH,
        identity: {
          hash: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
          rawTx: 'c2VjcmV0LXJhdy10eA==',
          nonce: 99,
          validUntilBlock: 12_540_100,
        },
      })
    );
    writeWriterMetricsState(metricsPath, live);
    writeFeedWriterPrometheusTextfile(promPath, live);
    const before = readFileSync(promPath, 'utf8');

    const restored = loadWriterMetricsFromDisk({ statusPath, sidecarPath, metricsPath });
    const after = renderFeedWriterPrometheus(restored.snapshot);
    assert.equal(restored.pendingReplay, true);
    assert.equal(restored.snapshot.confirmation_state, 'pending');
    assert.equal(restored.snapshot.outstanding_replay, 1);
    assert.equal(after, before);
    assert.doesNotMatch(after, LEAK_RE);
    assert.doesNotMatch(readFileSync(metricsPath, 'utf8'), /rawTx|0xdeadbeef|c2VjcmV0/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('sidecar existence cannot leak raw identity and keeps a confirmed file pending', () => {
  const tmp = path.join(os.tmpdir(), `feed-writer-metrics-sidecar-${process.pid}`);
  mkdirSync(tmp, { recursive: true });
  const statusPath = path.join(tmp, 'status.json');
  const sidecarPath = `${statusPath}.pending-batch.json`;
  const metricsPath = `${statusPath}.metrics.json`;
  try {
    writeFileSync(statusPath, JSON.stringify(statusFixture({ confirmation_status: 'confirmed' })));
    writeFileSync(
      sidecarPath,
      JSON.stringify({
        version: 1,
        network: 'mainnet',
        identity: { rawTx: 'c2VjcmV0', hash: '0xffff', nonce: 1, validUntilBlock: 9 },
      })
    );
    const restored = loadWriterMetricsFromDisk({ statusPath, sidecarPath, metricsPath });
    assert.equal(restored.snapshot.confirmation_state, 'pending');
    assert.equal(restored.pendingReplay, true);
    const text = renderFeedWriterPrometheus(restored.snapshot);
    assert.doesNotMatch(text, /c2VjcmV0|0xffff|rawTx/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('later skipped cycle keeps last confirmed times and does not look like FAULT', () => {
  const confirmed = advanceWriterMetrics({
    status: statusFixture({ ts: '2026-09-01T00:04:00.000Z' }),
    previous: advanceWriterMetrics({
      status: statusFixture({
        ts: '2026-09-01T00:03:50.000Z',
        ok: false,
        confirmation_status: 'submitted',
        pairs_confirmed: [],
      }),
    }),
  });
  const skipped = advanceWriterMetrics({
    status: statusFixture({
      ts: '2026-09-01T00:09:00.000Z',
      confirmation_status: 'skipped',
      pairs_submitted: [],
      pairs_confirmed: [],
      submitted_identity: null,
      skipped: 6,
      missing: 2,
    }),
    previous: confirmed,
  });
  assert.equal(skipped.confirmation_state, 'skipped');
  assert.equal(skipped.last_confirmed_unix, confirmed.last_confirmed_unix);
  assert.equal(skipped.last_submitted_unix, confirmed.last_submitted_unix);
  assert.equal(
    skipped.last_confirmation_latency_seconds,
    confirmed.last_confirmation_latency_seconds
  );
  assert.equal(skipped.failed_cycles_total, 0);
  const text = renderFeedWriterPrometheus(skipped);
  assert.equal(
    metricValue(text, FEED_WRITER_METRIC_NAMES.confirmation_state, {
      network: 'mainnet',
      state: 'skipped',
    }),
    '1'
  );
  assert.equal(
    metricValue(text, FEED_WRITER_METRIC_NAMES.confirmation_state, {
      network: 'mainnet',
      state: 'fault',
    }),
    '0'
  );
  assert.equal(
    metricValue(text, FEED_WRITER_METRIC_NAMES.source_pairs, {
      network: 'mainnet',
      result: 'missing',
    }),
    '2'
  );
});

test('unknown network or missing confirmation emits no high-cardinality or 1970 gauges', () => {
  const empty = renderFeedWriterPrometheus(
    advanceWriterMetrics({
      status: { ts: 'nope', network: 'neox', confirmation_status: 'confirmed' },
    })
  );
  assert.equal(empty, '');
  const envOnly = renderFeedWriterPrometheus(
    advanceWriterMetrics({
      status: { ts: '2026-09-01T00:00:00.000Z', network: 'mainnet', ok: false, errors: ['TD'] },
    })
  );
  assert.equal(
    metricValue(envOnly, FEED_WRITER_METRIC_NAMES.last_attempt, { network: 'mainnet' }),
    String(Date.parse('2026-09-01T00:00:00.000Z') / 1000)
  );
  for (const state of FEED_WRITER_CONFIRMATION_STATES) {
    assert.equal(
      metricValue(envOnly, FEED_WRITER_METRIC_NAMES.confirmation_state, {
        network: 'mainnet',
        state,
      }),
      '0'
    );
  }
  assert.doesNotMatch(envOnly, /1970/);
});

test('same-cycle overlay with reused timestamp increments failed cycles once', () => {
  const fault = statusFixture({
    ts: '2026-09-01T00:10:00.000Z',
    ok: false,
    confirmation_status: 'failed',
    pairs_confirmed: [],
    pairs_failed: ['TWELVEDATA:NEO-USD'],
    pairs_faulted: ['TWELVEDATA:NEO-USD'],
  });
  const first = advanceWriterMetrics({ status: fault });
  const overlay = advanceWriterMetrics({
    status: { ...fault, ok: false, errors: [{ code: 'chain_push_failed' }] },
    previous: first,
  });
  assert.equal(first.confirmation_state, 'fault');
  assert.equal(first.failed_cycles_total, 1);
  assert.equal(overlay.failed_cycles_total, 1);
  assert.equal(overlay.confirmation_state, 'fault');
});

test('textfile write is atomic and omitted when the path is empty', () => {
  const tmp = path.join(os.tmpdir(), `feed-writer-metrics-prom-${process.pid}`);
  mkdirSync(tmp, { recursive: true });
  const promPath = path.join(tmp, 'writer.prom');
  try {
    const snapshot = advanceWriterMetrics({ status: statusFixture() });
    writeFeedWriterPrometheusTextfile('', snapshot);
    assert.equal(existsSync(promPath), false);
    writeFeedWriterPrometheusTextfile(promPath, snapshot);
    assert.match(
      readFileSync(promPath, 'utf8'),
      /# TYPE neoos_feed_writer_confirmation_state gauge/
    );
    assert.equal(existsSync(`${promPath}.tmp`), false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
