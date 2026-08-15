import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { TOP_LEVEL_COUNTERS, renderPrometheusMetrics } from './prometheus.js';
import { createEmptyRelayerState, incrementLabeledFailure, snapshotMetrics } from './state.js';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

// Counter names that are deliberately rendered as labeled series (F5) rather than
// flat top-level counters. They are still exported (as `<name>{labels}`), so they
// are exempt from the flat TOP_LEVEL_COUNTERS drift guard.
const LABELED_COUNTER_EXEMPTIONS = new Set(['failures_total']);

function collectIncrementMetricNames() {
  const names = new Set();
  const pattern = /incrementMetric\(\s*state\s*,\s*'([a-zA-Z0-9_]+)'/g;
  for (const entry of fs.readdirSync(moduleDir)) {
    if (!entry.endsWith('.js')) continue;
    const source = fs.readFileSync(path.join(moduleDir, entry), 'utf8');
    let match;
    while ((match = pattern.exec(source)) !== null) {
      names.add(match[1]);
    }
  }
  return names;
}

describe('prometheus metric export drift guard (A5)', () => {
  it('exports every incrementMetric counter name in TOP_LEVEL_COUNTERS', () => {
    const exported = new Set(TOP_LEVEL_COUNTERS);
    const used = collectIncrementMetricNames();
    // Sanity: the scan actually found the hot-path counters.
    assert.ok(used.size >= 15, `expected to scan many counters, found ${used.size}`);

    const missing = [...used].filter(
      (name) => !exported.has(name) && !LABELED_COUNTER_EXEMPTIONS.has(name)
    );
    assert.deepEqual(
      missing,
      [],
      `incrementMetric() names not exported via TOP_LEVEL_COUNTERS: ${missing.join(', ')}`
    );
  });

  it('seeds the A5 counters in the default metrics snapshot', () => {
    const state = createEmptyRelayerState();
    for (const name of [
      'discovery_failures_total',
      'reconciliation_failures_total',
      'durable_claim_skipped_during_backoff_total',
    ]) {
      assert.equal(state.metrics[name], 0, `${name} should be seeded to 0`);
    }
  });

  it('renders the A5 counters even when never incremented', () => {
    const output = renderPrometheusMetrics(createEmptyRelayerState().metrics);
    assert.match(output, /morpheus_relayer_discovery_failures_total 0/);
    assert.match(output, /morpheus_relayer_reconciliation_failures_total 0/);
    assert.match(output, /morpheus_relayer_durable_claim_skipped_during_backoff_total 0/);
  });

  it('renders the B10 overflow counter', () => {
    const output = renderPrometheusMetrics(createEmptyRelayerState().metrics);
    assert.match(output, /morpheus_relayer_retry_queue_overflow_total 0/);
  });
});

describe('prometheus queue-age / latency gauges (F2)', () => {
  it('emits oldest_retry_age_seconds / oldest_dead_letter_age_seconds and last_fulfill_latency', () => {
    const state = createEmptyRelayerState();
    const nowMs = Date.parse('2026-06-14T12:00:00.000Z');
    state.neo_n3.retry_queue.push({
      key: 'neo_n3:1:::',
      event: { chain: 'neo_n3', requestId: '1' },
      first_failed_at: new Date(nowMs - 120_000).toISOString(), // 120s old
    });
    state.neo_n3.dead_letters.push({
      key: 'neo_n3:2:::',
      request_id: '2',
      exhausted_at: new Date(nowMs - 300_000).toISOString(), // 300s old
    });
    state.metrics.last_fulfill_latency_ms = 1234;

    const output = renderPrometheusMetrics(snapshotMetrics(state, nowMs));
    assert.match(output, /morpheus_relayer_oldest_retry_age_seconds\{chain="neo_n3"\} 120/);
    assert.match(output, /morpheus_relayer_oldest_dead_letter_age_seconds\{chain="neo_n3"\} 300/);
    assert.match(output, /morpheus_relayer_last_fulfill_latency_ms 1234/);
  });

  it('omits queue-age series for an empty queue (no false 0)', () => {
    const output = renderPrometheusMetrics(snapshotMetrics(createEmptyRelayerState(), Date.now()));
    assert.ok(!output.includes('morpheus_relayer_oldest_retry_age_seconds'));
    assert.ok(!output.includes('morpheus_relayer_last_fulfill_latency_ms'));
  });
});

describe('prometheus log-sink drop counter (F7)', () => {
  it('renders log_sink_dropped_total from the metrics seam', () => {
    const metrics = { ...createEmptyRelayerState().metrics, log_sink_dropped_total: 7 };
    const output = renderPrometheusMetrics(metrics);
    assert.match(output, /morpheus_relayer_log_sink_dropped_total 7/);
  });
});

describe('prometheus labeled failure counters (F5)', () => {
  it('emits failures_total{chain,module,operation} alongside the flat totals', () => {
    const state = createEmptyRelayerState();
    incrementLabeledFailure(state, 'neo_n3', 'oracle.fetch', 'privacy_oracle');
    incrementLabeledFailure(state, 'neo_n3', 'oracle.fetch', 'privacy_oracle');
    incrementLabeledFailure(state, 'neox', 'random.generate', 'random');

    const output = renderPrometheusMetrics(snapshotMetrics(state, Date.now()));
    assert.match(
      output,
      /morpheus_relayer_failures_total\{chain="neo_n3",module="oracle\.fetch",operation="privacy_oracle"\} 2/
    );
    assert.match(
      output,
      /morpheus_relayer_failures_total\{chain="neox",module="random\.generate",operation="random"\} 1/
    );
  });
});
