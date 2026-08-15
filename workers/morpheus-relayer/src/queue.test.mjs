import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  claimDurableJobForProcessing,
  createPersistor,
  extractDurableRetryMeta,
  isDurableQueueReadyJob,
  isTransientDurableQueueError,
  persistFreshEventsToDurableQueue,
} from './queue.js';
import { createEmptyRelayerState } from './state.js';
import {
  markSupabasePersistenceUnavailable,
  resetSupabasePersistenceBackoffForTests,
} from './persistence.js';

// ===================================================================
// extractDurableRetryMeta
// ===================================================================

describe('extractDurableRetryMeta', () => {
  it('extracts finalize_only and terminal_error from well-formed job', () => {
    const job = {
      worker_response: {
        retry_meta: {
          finalize_only: true,
          terminal_error: 'updater not set',
          durable_claimed: true,
          prepared_fulfillment: {
            success: true,
            result: '{"ok":true}',
            error: '',
            result_bytes_base64: '',
            route: '/oracle/fetch',
            module_id: 'oracle.fetch',
            operation: 'privacy_oracle',
            worker_status: 200,
            verification_signature: 'sig',
          },
        },
      },
    };
    const meta = extractDurableRetryMeta(job);
    assert.equal(meta.finalize_only, true);
    assert.equal(meta.terminal_error, 'updater not set');
    assert.equal(meta.durable_claimed, true);
    assert.deepEqual(meta.prepared_fulfillment, {
      success: true,
      result: '{"ok":true}',
      error: '',
      result_bytes_base64: '',
      route: '/oracle/fetch',
      module_id: 'oracle.fetch',
      operation: 'privacy_oracle',
      worker_status: 200,
      verification_signature: 'sig',
    });
  });

  it('returns safe defaults for null/undefined job', () => {
    assert.deepEqual(extractDurableRetryMeta(null), {
      finalize_only: false,
      terminal_error: null,
      durable_claimed: false,
      prepared_fulfillment: null,
    });
    assert.deepEqual(extractDurableRetryMeta(undefined), {
      finalize_only: false,
      terminal_error: null,
      durable_claimed: false,
      prepared_fulfillment: null,
    });
  });

  it('returns safe defaults when worker_response is missing', () => {
    const meta = extractDurableRetryMeta({});
    assert.equal(meta.finalize_only, false);
    assert.equal(meta.terminal_error, null);
    assert.equal(meta.durable_claimed, false);
    assert.equal(meta.prepared_fulfillment, null);
  });

  it('returns safe defaults when retry_meta is missing', () => {
    const meta = extractDurableRetryMeta({ worker_response: {} });
    assert.equal(meta.finalize_only, false);
    assert.equal(meta.terminal_error, null);
    assert.equal(meta.prepared_fulfillment, null);
  });

  it('returns safe defaults when worker_response is not an object', () => {
    const meta = extractDurableRetryMeta({ worker_response: 'string' });
    assert.equal(meta.finalize_only, false);
    assert.equal(meta.terminal_error, null);
    assert.equal(meta.prepared_fulfillment, null);
  });

  it('trims terminal_error whitespace', () => {
    const job = {
      worker_response: {
        retry_meta: {
          terminal_error: '  some error  ',
        },
      },
    };
    const meta = extractDurableRetryMeta(job);
    assert.equal(meta.terminal_error, 'some error');
  });

  it('returns null for blank terminal_error', () => {
    const job = {
      worker_response: {
        retry_meta: {
          terminal_error: '   ',
        },
      },
    };
    const meta = extractDurableRetryMeta(job);
    assert.equal(meta.terminal_error, null);
  });

  it('coerces finalize_only to boolean', () => {
    const job = {
      worker_response: {
        retry_meta: {
          finalize_only: 1,
        },
      },
    };
    const meta = extractDurableRetryMeta(job);
    assert.equal(meta.finalize_only, true);
    assert.equal(typeof meta.finalize_only, 'boolean');
  });
});

// ===================================================================
// isTransientDurableQueueError
// ===================================================================

describe('isTransientDurableQueueError', () => {
  it('marks Supabase quota restrictions for persistence backoff', () => {
    resetSupabasePersistenceBackoffForTests();
    const error = new Error(
      'supabase morpheus_relayer_jobs GET failed: 402 {"message":"exceed_db_size_quota"}'
    );

    assert.equal(isTransientDurableQueueError(error), true);
    assert.equal(markSupabasePersistenceUnavailable(error), true);
    resetSupabasePersistenceBackoffForTests();
  });

  it('treats Supabase quota restriction as durable queue unavailable', () => {
    const error = new Error(
      'supabase morpheus_relayer_jobs POST failed: 402 {"code":"exceed_db_size_quota","message":"Database size quota exceeded"}'
    );

    assert.equal(isTransientDurableQueueError(error), true);
  });

  it('treats Supabase quota HTTP status text as durable queue unavailable', () => {
    const error = new Error(
      'supabase morpheus_control_plane_jobs POST failed: 402 Payment Required'
    );

    assert.equal(isTransientDurableQueueError(error), true);
  });
});

describe('persistFreshEventsToDurableQueue', () => {
  it('fails closed on a transient Supabase insert failure when configured', async () => {
    const originalFetch = global.fetch;
    const originalSupabaseUrl = process.env.SUPABASE_URL;
    const originalSupabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const warnings = [];

    process.env.SUPABASE_URL = 'https://supabase.test';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
    resetSupabasePersistenceBackoffForTests();
    global.fetch = async () => ({
      ok: false,
      status: 503,
      text: async () => 'temporarily unavailable',
    });

    try {
      await assert.rejects(
        persistFreshEventsToDurableQueue(
          { concurrency: 1, durableQueue: { enabled: true, failClosed: true } },
          { warn: (...args) => warnings.push(args) },
          'neo_n3',
          [{ chain: 'neo_n3', requestId: '1', requestType: 'oracle.fetch', blockNumber: 1 }]
        ),
        /503 temporarily unavailable/
      );
      assert.equal(
        warnings.at(-1)?.[1],
        'Durable Supabase queue is unavailable; refusing to process fresh events until it recovers'
      );
    } finally {
      global.fetch = originalFetch;
      if (originalSupabaseUrl === undefined) delete process.env.SUPABASE_URL;
      else process.env.SUPABASE_URL = originalSupabaseUrl;
      if (originalSupabaseKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      else process.env.SUPABASE_SERVICE_ROLE_KEY = originalSupabaseKey;
      resetSupabasePersistenceBackoffForTests();
    }
  });
});

describe('claimDurableJobForProcessing', () => {
  it('does not treat an in-flight transient Supabase claim failure as a granted claim', async () => {
    const originalFetch = global.fetch;
    const originalSupabaseUrl = process.env.SUPABASE_URL;
    const originalSupabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const warnings = [];
    const state = createEmptyRelayerState();

    process.env.SUPABASE_URL = 'https://supabase.test';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
    resetSupabasePersistenceBackoffForTests();
    global.fetch = async () => ({
      ok: false,
      status: 503,
      text: async () => 'temporarily unavailable',
    });

    try {
      const claim = await claimDurableJobForProcessing(
        {
          durableQueue: { enabled: true, failClosed: true },
          instanceId: 'test-relayer',
        },
        { warn: (...args) => warnings.push(args), info() {} },
        { chain: 'neo_n3', requestId: '99', requestType: 'oracle_fetch' },
        null,
        state
      );

      assert.equal(claim.granted, false);
      assert.equal(claim.reason, 'unavailable');
      assert.equal(state.metrics.durable_claim_skipped_during_backoff_total, 1);
      assert.equal(
        warnings.at(-1)?.[1],
        'Durable Supabase claim is temporarily unavailable; skipping processing until the shared idempotency store recovers'
      );
    } finally {
      global.fetch = originalFetch;
      if (originalSupabaseUrl === undefined) delete process.env.SUPABASE_URL;
      else process.env.SUPABASE_URL = originalSupabaseUrl;
      if (originalSupabaseKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      else process.env.SUPABASE_SERVICE_ROLE_KEY = originalSupabaseKey;
      resetSupabasePersistenceBackoffForTests();
    }
  });

  it('skips processing (fail-closed) while Supabase persistence is in quota backoff by default', async () => {
    resetSupabasePersistenceBackoffForTests();
    markSupabasePersistenceUnavailable(
      new Error('supabase morpheus_relayer_jobs PATCH failed: 402 exceed_db_size_quota')
    );

    const claim = await claimDurableJobForProcessing(
      {
        durableQueue: { enabled: true, failClosed: true },
        instanceId: 'test-relayer',
      },
      { warn() {}, info() {} },
      { chain: 'neo_n3', requestId: '99', requestType: 'oracle_fetch' }
    );

    // Fail closed by default: do not grant a local claim that could double-deliver
    // when the shared idempotency store is unreachable.
    assert.equal(claim.granted, false);
    assert.equal(claim.reason, 'backoff_skip');
    resetSupabasePersistenceBackoffForTests();
  });

  it('fails closed (backoff_skip) and emits a backoff metric when allowLocalClaimDuringBackoff is unset', async () => {
    resetSupabasePersistenceBackoffForTests();
    markSupabasePersistenceUnavailable(
      new Error('supabase morpheus_relayer_jobs PATCH failed: 402 exceed_db_size_quota')
    );
    const state = createEmptyRelayerState();

    // Default (allowLocalClaimDuringBackoff unset) now fails closed: the shared
    // idempotency store is unreachable, so do NOT grant a local claim that could
    // let a second instance double-deliver. Caller retains the retry item.
    const claim = await claimDurableJobForProcessing(
      { durableQueue: { enabled: true, failClosed: true }, instanceId: 'test-relayer' },
      { warn() {}, info() {} },
      { chain: 'neo_n3', requestId: '99', requestType: 'oracle_fetch' },
      null,
      state
    );

    assert.equal(claim.granted, false);
    assert.equal(claim.reason, 'backoff_skip');
    // Operator-visible signal that the cross-instance claim was skipped this window.
    assert.equal(state.metrics.durable_claim_skipped_during_backoff_total, 1);
    resetSupabasePersistenceBackoffForTests();
  });

  it('grants a local claim during Supabase backoff only when allowLocalClaimDuringBackoff is explicitly true (opt-in)', async () => {
    resetSupabasePersistenceBackoffForTests();
    markSupabasePersistenceUnavailable(
      new Error('supabase morpheus_relayer_jobs PATCH failed: 402 exceed_db_size_quota')
    );
    const state = createEmptyRelayerState();

    const claim = await claimDurableJobForProcessing(
      {
        durableQueue: { enabled: true, failClosed: true, allowLocalClaimDuringBackoff: true },
        instanceId: 'test-relayer',
      },
      { warn() {}, info() {} },
      { chain: 'neo_n3', requestId: '99', requestType: 'oracle_fetch' },
      null,
      state
    );

    assert.equal(claim.granted, true);
    // Operator-visible signal that idempotency protection is off this window.
    assert.equal(state.metrics.durable_claim_skipped_during_backoff_total, 1);
    resetSupabasePersistenceBackoffForTests();
  });

  it('returns reason backoff_skip (not conflict) during backoff when allowLocalClaimDuringBackoff is false (multi-instance)', async () => {
    resetSupabasePersistenceBackoffForTests();
    markSupabasePersistenceUnavailable(
      new Error('supabase morpheus_relayer_jobs PATCH failed: 402 exceed_db_size_quota')
    );
    const state = createEmptyRelayerState();

    const claim = await claimDurableJobForProcessing(
      {
        durableQueue: { enabled: true, failClosed: true, allowLocalClaimDuringBackoff: false },
        instanceId: 'test-relayer',
      },
      { warn() {}, info() {} },
      { chain: 'neo_n3', requestId: '99', requestType: 'oracle_fetch' },
      null,
      state
    );

    // Conservative path: do not grant a local claim that could double-deliver,
    // but flag it as a recoverable backoff skip (NOT a permanent conflict) so the
    // caller retains the retry item instead of dropping it.
    assert.equal(claim.granted, false);
    assert.equal(claim.reason, 'backoff_skip');
    assert.equal(state.metrics.durable_claim_skipped_during_backoff_total, 1);
    resetSupabasePersistenceBackoffForTests();
  });

  it('grants immediately for an already-durably-claimed retry item', async () => {
    const claim = await claimDurableJobForProcessing(
      { durableQueue: { enabled: true }, instanceId: 'test-relayer' },
      { warn() {}, info() {} },
      { chain: 'neo_n3', requestId: '1', requestType: 'oracle_fetch' },
      { durable_claimed: true }
    );
    assert.equal(claim.granted, true);
    assert.equal(claim.reason, 'granted');
  });

  it('grants when the durable queue is disabled (single-instance default)', async () => {
    const claim = await claimDurableJobForProcessing(
      { durableQueue: { enabled: false } },
      { warn() {}, info() {} },
      { chain: 'neo_n3', requestId: '1', requestType: 'oracle_fetch' }
    );
    assert.equal(claim.granted, true);
  });
});

// ===================================================================
// isDurableQueueReadyJob
// ===================================================================

describe('isDurableQueueReadyJob', () => {
  const NOW = Date.now();
  const STALE_MS = 120_000; // 2 minutes

  // --- queued statuses are always ready ---
  it('returns true for "queued" status', () => {
    assert.equal(isDurableQueueReadyJob({ status: 'queued' }, NOW, STALE_MS), true);
  });

  it('returns true for "queued_backpressure" status', () => {
    assert.equal(isDurableQueueReadyJob({ status: 'queued_backpressure' }, NOW, STALE_MS), true);
  });

  // --- retry_scheduled: ready only when next_retry_at has passed ---
  it('returns true for retry_scheduled when next_retry_at is in the past', () => {
    const pastIso = new Date(NOW - 10_000).toISOString();
    assert.equal(
      isDurableQueueReadyJob({ status: 'retry_scheduled', next_retry_at: pastIso }, NOW, STALE_MS),
      true
    );
  });

  it('returns false for retry_scheduled when next_retry_at is in the future', () => {
    const futureIso = new Date(NOW + 60_000).toISOString();
    assert.equal(
      isDurableQueueReadyJob(
        { status: 'retry_scheduled', next_retry_at: futureIso },
        NOW,
        STALE_MS
      ),
      false
    );
  });

  it('returns true for retry_scheduled when next_retry_at is exactly now', () => {
    const nowIso = new Date(NOW).toISOString();
    assert.equal(
      isDurableQueueReadyJob({ status: 'retry_scheduled', next_retry_at: nowIso }, NOW, STALE_MS),
      true
    );
  });

  it('returns true for retry_scheduled with missing/zero next_retry_at', () => {
    assert.equal(
      isDurableQueueReadyJob({ status: 'retry_scheduled', next_retry_at: null }, NOW, STALE_MS),
      true
    );
    assert.equal(isDurableQueueReadyJob({ status: 'retry_scheduled' }, NOW, STALE_MS), true);
  });

  // --- failure_callback_retry_scheduled uses same logic ---
  it('returns true for failure_callback_retry_scheduled when due', () => {
    const pastIso = new Date(NOW - 5_000).toISOString();
    assert.equal(
      isDurableQueueReadyJob(
        { status: 'failure_callback_retry_scheduled', next_retry_at: pastIso },
        NOW,
        STALE_MS
      ),
      true
    );
  });

  it('returns true for callback_retry_scheduled when due', () => {
    const pastIso = new Date(NOW - 5_000).toISOString();
    assert.equal(
      isDurableQueueReadyJob(
        { status: 'callback_retry_scheduled', next_retry_at: pastIso },
        NOW,
        STALE_MS
      ),
      true
    );
  });

  it('returns true for stale callback_pending jobs', () => {
    const staleIso = new Date(NOW - STALE_MS - 1000).toISOString();
    assert.equal(
      isDurableQueueReadyJob({ status: 'callback_pending', updated_at: staleIso }, NOW, STALE_MS),
      true
    );
  });

  // --- processing/retrying: ready only when stale ---
  it('returns true for "processing" when updated_at is stale', () => {
    const staleIso = new Date(NOW - STALE_MS - 1000).toISOString();
    assert.equal(
      isDurableQueueReadyJob({ status: 'processing', updated_at: staleIso }, NOW, STALE_MS),
      true
    );
  });

  it('returns false for "processing" when updated_at is recent', () => {
    const recentIso = new Date(NOW - 1000).toISOString();
    assert.equal(
      isDurableQueueReadyJob({ status: 'processing', updated_at: recentIso }, NOW, STALE_MS),
      false
    );
  });

  it('returns true for "retrying" when updated_at is stale', () => {
    const staleIso = new Date(NOW - STALE_MS - 5000).toISOString();
    assert.equal(
      isDurableQueueReadyJob({ status: 'retrying', updated_at: staleIso }, NOW, STALE_MS),
      true
    );
  });

  it('returns false for "retrying" when updated_at is recent', () => {
    const recentIso = new Date(NOW - 10_000).toISOString();
    assert.equal(
      isDurableQueueReadyJob({ status: 'retrying', updated_at: recentIso }, NOW, STALE_MS),
      false
    );
  });

  it('returns false for "processing" with missing updated_at', () => {
    assert.equal(isDurableQueueReadyJob({ status: 'processing' }, NOW, STALE_MS), false);
  });

  // --- terminal statuses are never ready ---
  it('returns false for "fulfilled" status', () => {
    assert.equal(isDurableQueueReadyJob({ status: 'fulfilled' }, NOW, STALE_MS), false);
  });

  it('returns false for "failed" status', () => {
    assert.equal(isDurableQueueReadyJob({ status: 'failed' }, NOW, STALE_MS), false);
  });

  it('returns false for "settled" status', () => {
    assert.equal(isDurableQueueReadyJob({ status: 'settled' }, NOW, STALE_MS), false);
  });

  it('returns false for "failed_config" status', () => {
    assert.equal(isDurableQueueReadyJob({ status: 'failed_config' }, NOW, STALE_MS), false);
  });

  // --- edge cases ---
  it('returns false for null/undefined job', () => {
    assert.equal(isDurableQueueReadyJob(null, NOW, STALE_MS), false);
    assert.equal(isDurableQueueReadyJob(undefined, NOW, STALE_MS), false);
  });

  it('returns false for job with empty status', () => {
    assert.equal(isDurableQueueReadyJob({ status: '' }, NOW, STALE_MS), false);
    assert.equal(isDurableQueueReadyJob({}, NOW, STALE_MS), false);
  });
});

// ===================================================================
// createPersistor
// ===================================================================

describe('createPersistor', () => {
  function tempStateFile() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'morpheus-relayer-persistor-'));
    return path.join(dir, '.morpheus-relayer-state.json');
  }

  function readTicks(stateFile) {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8')).metrics.ticks_total;
  }

  it('writes on every call when no minimum interval is configured', () => {
    const stateFile = tempStateFile();
    const state = createEmptyRelayerState();
    const persist = createPersistor({ stateFile }, state);

    persist();
    assert.equal(readTicks(stateFile), 0);
    state.metrics.ticks_total = 5;
    persist();
    assert.equal(readTicks(stateFile), 5);
  });

  it('coalesces bursts within the interval and flushes the trailing state', async () => {
    const stateFile = tempStateFile();
    const state = createEmptyRelayerState();
    const persist = createPersistor({ stateFile, statePersistMinIntervalMs: 60 }, state);

    persist(); // leading write
    assert.equal(readTicks(stateFile), 0);

    state.metrics.ticks_total = 3;
    persist(); // within the interval -> deferred
    state.metrics.ticks_total = 7;
    persist(); // still deferred, same trailing timer
    assert.equal(readTicks(stateFile), 0);

    await new Promise((resolve) => setTimeout(resolve, 150));
    // The trailing flush wrote the LATEST in-memory state exactly once.
    assert.equal(readTicks(stateFile), 7);
  });

  it('exposes flush() to force an immediate write', () => {
    const stateFile = tempStateFile();
    const state = createEmptyRelayerState();
    const persist = createPersistor({ stateFile, statePersistMinIntervalMs: 60_000 }, state);

    persist();
    state.metrics.ticks_total = 9;
    persist(); // deferred behind a long interval
    assert.equal(readTicks(stateFile), 0);
    persist.flush();
    assert.equal(readTicks(stateFile), 9);
  });
});
