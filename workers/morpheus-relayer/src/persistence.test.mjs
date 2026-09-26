import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  getSupabasePersistenceBackoff,
  insertRelayerJobIfAbsent,
  quarantineRelayerJobsBelowRequestId,
  isSupabaseConnectivityError,
  isSupabaseQuotaRestrictedError,
  markSupabasePersistenceUnavailable,
  patchAutomationJob,
  patchRelayerJob,
  resetSupabasePersistenceBackoffForTests,
  resolveSupabaseNetwork,
  shouldSkipSupabasePersistence,
  upsertAutomationJob,
  upsertRelayerJob,
} from './persistence.js';

afterEach(() => {
  resetSupabasePersistenceBackoffForTests();
});

describe('Supabase persistence backoff', () => {
  it('rejects an unknown configured network before persistence', () => {
    const previous = process.env.MORPHEUS_NETWORK;
    process.env.MORPHEUS_NETWORK = 'staging';
    try {
      assert.throws(() => resolveSupabaseNetwork(), /unsupported Neo network/);
    } finally {
      if (previous === undefined) delete process.env.MORPHEUS_NETWORK;
      else process.env.MORPHEUS_NETWORK = previous;
    }
  });

  it('detects Supabase quota restriction errors', () => {
    assert.equal(
      isSupabaseQuotaRestrictedError(
        new Error('supabase morpheus_relayer_jobs GET failed: 402 exceed_db_size_quota')
      ),
      true
    );
    assert.equal(isSupabaseQuotaRestrictedError(new Error('503 temporarily unavailable')), false);
  });

  it('temporarily skips Supabase persistence after quota restriction', () => {
    const nowMs = Date.parse('2026-05-06T08:00:00.000Z');
    assert.equal(shouldSkipSupabasePersistence(nowMs), false);

    const marked = markSupabasePersistenceUnavailable(
      new Error('supabase morpheus_relayer_runs POST failed: 402 Payment Required'),
      nowMs
    );

    assert.equal(marked, true);
    assert.equal(shouldSkipSupabasePersistence(nowMs + 1000), true);
    assert.equal(shouldSkipSupabasePersistence(nowMs + 301000), false);

    const backoff = getSupabasePersistenceBackoff(nowMs + 1000);
    assert.equal(backoff.active, true);
    assert.equal(backoff.reason, 'quota_restricted');
    assert.ok(backoff.remaining_ms > 0);
  });

  it('does not enter backoff for deterministic (non-transient, non-quota) errors', () => {
    // A constraint violation / 409 conflict is deterministic, not an outage, so it
    // must not arm a persistence backoff.
    const marked = markSupabasePersistenceUnavailable(
      new Error('supabase morpheus_relayer_jobs POST failed: 409 duplicate key value'),
      Date.now()
    );

    assert.equal(marked, false);
    assert.equal(shouldSkipSupabasePersistence(), false);
  });

  // --- B11: non-quota connectivity/5xx/timeout outages arm a SHORT backoff ---
  it('classifies connectivity/5xx/timeout (non-quota) Supabase errors', () => {
    assert.equal(isSupabaseConnectivityError(new Error('fetch failed')), true);
    assert.equal(
      isSupabaseConnectivityError(
        new Error('supabase morpheus_relayer_jobs GET failed: 503 service unavailable')
      ),
      true
    );
    assert.equal(isSupabaseConnectivityError(new Error('connection timed out')), true);
    assert.equal(isSupabaseConnectivityError(new Error('ECONNRESET')), true);
    // Quota is handled by its own (longer) window, not the connectivity path.
    assert.equal(isSupabaseConnectivityError(new Error('402 exceed_db_size_quota')), false);
    // Deterministic errors do not arm a connectivity backoff.
    assert.equal(isSupabaseConnectivityError(new Error('409 duplicate key')), false);
  });

  it('arms a short backoff for a non-quota connectivity outage (B11)', () => {
    const nowMs = Date.parse('2026-05-06T09:00:00.000Z');
    assert.equal(shouldSkipSupabasePersistence(nowMs), false);

    const marked = markSupabasePersistenceUnavailable(new Error('fetch failed'), nowMs);
    assert.equal(marked, true);

    const backoff = getSupabasePersistenceBackoff(nowMs + 1000);
    assert.equal(backoff.active, true);
    assert.equal(backoff.reason, 'connectivity');
    // Short (~30s default) window: still active at 1s, cleared by 31s — much
    // shorter than the 5min quota window so idempotency protection recovers fast.
    assert.equal(shouldSkipSupabasePersistence(nowMs + 1000), true);
    assert.equal(shouldSkipSupabasePersistence(nowMs + 31000), false);
  });

  it('never shortens an already-armed (longer quota) window when a connectivity error follows', () => {
    const nowMs = Date.parse('2026-05-06T10:00:00.000Z');
    markSupabasePersistenceUnavailable(new Error('402 exceed_db_size_quota'), nowMs);
    // A connectivity blip during the quota outage must not shrink the window.
    markSupabasePersistenceUnavailable(new Error('fetch failed'), nowMs);
    assert.equal(shouldSkipSupabasePersistence(nowMs + 31000), true); // still in quota window
    const backoff = getSupabasePersistenceBackoff(nowMs + 1000);
    assert.equal(backoff.reason, 'quota_restricted');
  });
});

describe('quarantineRelayerJobsBelowRequestId (PostgREST batching)', () => {
  function withSupabaseEnv() {
    const previous = {
      SUPABASE_URL: process.env.SUPABASE_URL,
      SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY,
    };
    process.env.SUPABASE_URL = 'https://supabase.test';
    process.env.SUPABASE_SECRET_KEY = 'service-key';
    return () => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    };
  }

  function stubSupabaseFetch(rows, calls) {
    return async (url, init = {}) => {
      const parsed = new URL(url);
      calls.push({
        method: init.method || 'GET',
        pathname: parsed.pathname,
        query: Object.fromEntries(parsed.searchParams.entries()),
        body: init.body ? JSON.parse(init.body) : undefined,
      });
      return {
        ok: true,
        status: 200,
        text: async () => ((init.method || 'GET') === 'GET' ? JSON.stringify(rows) : ''),
      };
    };
  }

  it('filters by the numeric request-id floor and quarantines via bulk event_key=in.(...) PATCHes', async () => {
    const restoreEnv = withSupabaseEnv();
    const originalFetch = global.fetch;
    try {
      const rows = [
        // '9' < 10 numerically but NOT lexicographically — the floor compare
        // must stay numeric even though request_id is a text column.
        { event_key: 'neo_n3:9:0xa:0:1', request_id: '9', last_error: null },
        { event_key: 'neo_n3:8:0xb:0:1', request_id: '8', last_error: null },
        { event_key: 'neo_n3:7:0xc:0:1', request_id: '7', last_error: 'worker timeout' },
        { event_key: 'neo_n3:10:0xd:0:1', request_id: '10', last_error: null }, // at floor: kept
        { event_key: 'neo_n3:100:0xe:0:1', request_id: '100', last_error: null }, // above: kept
      ];
      const calls = [];
      global.fetch = stubSupabaseFetch(rows, calls);

      const patched = await quarantineRelayerJobsBelowRequestId({
        network: 'testnet',
        chain: 'neo_n3',
        ltRequestId: 10,
        statuses: ['queued', 'processing'],
        note: 'auto-quarantined below request cursor floor 10',
      });

      assert.equal(patched, 3);

      const select = calls.find((call) => call.method === 'GET');
      assert.ok(select, 'expected a PostgREST select');
      // Status/chain filtering is pushed into the PostgREST query with a narrow select.
      assert.equal(select.query.select, 'event_key,request_id,last_error');
      assert.equal(select.query.status, 'in.(queued,processing)');
      assert.equal(select.query.chain, 'eq.neo_n3');

      const patches = calls.filter((call) => call.method === 'PATCH');
      // Rows sharing the same resulting last_error collapse into ONE bulk PATCH:
      // two rows had no previous error (one group) + one row with its own error.
      assert.equal(patches.length, 2);

      const bulk = patches.find((call) => call.query.event_key.includes('neo_n3:9:0xa:0:1'));
      assert.ok(bulk, 'expected the bulk no-previous-error PATCH');
      assert.equal(bulk.query.event_key, 'in.("neo_n3:9:0xa:0:1","neo_n3:8:0xb:0:1")');
      assert.equal(bulk.query.network, 'eq.testnet');
      assert.equal(bulk.body.status, 'stale_quarantined');
      assert.match(bulk.body.last_error, /floor 10 :: legacy open relayer job$/);

      const single = patches.find((call) => call.query.event_key.includes('neo_n3:7:0xc:0:1'));
      assert.ok(single, 'expected the previous-error-preserving PATCH');
      assert.match(single.body.last_error, /floor 10 :: worker timeout$/);

      // The at/above-floor rows are never patched.
      for (const call of patches) {
        assert.ok(!call.query.event_key.includes('neo_n3:10:0xd:0:1'));
        assert.ok(!call.query.event_key.includes('neo_n3:100:0xe:0:1'));
      }
    } finally {
      global.fetch = originalFetch;
      restoreEnv();
    }
  });

  it('returns 0 without issuing PATCHes when no row is below the floor', async () => {
    const restoreEnv = withSupabaseEnv();
    const originalFetch = global.fetch;
    try {
      const calls = [];
      global.fetch = stubSupabaseFetch(
        [{ event_key: 'neo_n3:50:0xa:0:1', request_id: '50', last_error: null }],
        calls
      );
      const patched = await quarantineRelayerJobsBelowRequestId({
        network: 'testnet',
        chain: 'neo_n3',
        ltRequestId: 10,
        statuses: ['queued'],
      });
      assert.equal(patched, 0);
      assert.equal(calls.filter((call) => call.method === 'PATCH').length, 0);
    } finally {
      global.fetch = originalFetch;
      restoreEnv();
    }
  });
});

describe('network-scoped Supabase business keys', () => {
  function installSupabaseTestEnvironment() {
    const previous = {
      SUPABASE_URL: process.env.SUPABASE_URL,
      SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY,
      MORPHEUS_NETWORK: process.env.MORPHEUS_NETWORK,
    };
    process.env.SUPABASE_URL = 'https://supabase.test';
    process.env.SUPABASE_SECRET_KEY = 'service-key';
    process.env.MORPHEUS_NETWORK = 'testnet';
    return () => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    };
  }

  function captureSupabaseCalls(calls) {
    return async (url, init = {}) => {
      const parsed = new URL(url);
      calls.push({
        method: init.method || 'GET',
        pathname: parsed.pathname,
        query: Object.fromEntries(parsed.searchParams.entries()),
        body: init.body ? JSON.parse(init.body) : undefined,
      });
      return {
        ok: true,
        status: 200,
        text: async () => '',
      };
    };
  }

  it('upserts relayer and automation identifiers using network-scoped conflicts', async () => {
    const restoreEnv = installSupabaseTestEnvironment();
    const originalFetch = global.fetch;
    const calls = [];
    global.fetch = captureSupabaseCalls(calls);
    try {
      await upsertRelayerJob({ network: 'mainnet', event_key: 'shared-event' });
      await upsertRelayerJob({ network: 'testnet', event_key: 'shared-event' });
      await insertRelayerJobIfAbsent({ event_key: 'testnet-only-event' });
      await upsertAutomationJob({ network: 'mainnet', automation_id: 'shared-automation' });
      await upsertAutomationJob({ network: 'testnet', automation_id: 'shared-automation' });

      const relayerCalls = calls.filter((call) => call.pathname.endsWith('/morpheus_relayer_jobs'));
      assert.equal(relayerCalls.length, 3);
      assert.deepEqual(
        relayerCalls.map((call) => call.query.on_conflict),
        ['network,event_key', 'network,event_key', 'network,event_key']
      );
      assert.deepEqual(
        relayerCalls.map((call) => call.body.network),
        ['mainnet', 'testnet', 'testnet']
      );
      assert.equal(relayerCalls[2].body.event_key, 'testnet-only-event');

      const automationCalls = calls.filter((call) =>
        call.pathname.endsWith('/morpheus_automation_jobs')
      );
      assert.equal(automationCalls.length, 2);
      assert.deepEqual(
        automationCalls.map((call) => call.query.on_conflict),
        ['network,automation_id', 'network,automation_id']
      );
      assert.deepEqual(
        automationCalls.map((call) => call.body.network),
        ['mainnet', 'testnet']
      );
    } finally {
      global.fetch = originalFetch;
      restoreEnv();
    }
  });

  it('patches identifiers only inside the configured network', async () => {
    const restoreEnv = installSupabaseTestEnvironment();
    const originalFetch = global.fetch;
    const calls = [];
    global.fetch = captureSupabaseCalls(calls);
    try {
      await patchRelayerJob('shared-event', { network: 'mainnet', status: 'completed' });
      await patchAutomationJob('shared-automation', { network: 'mainnet', status: 'paused' });

      assert.equal(calls[0].query.event_key, 'eq.shared-event');
      assert.equal(calls[0].query.network, 'eq.testnet');
      assert.equal(calls[0].body.network, 'testnet');
      assert.equal(calls[1].query.automation_id, 'eq.shared-automation');
      assert.equal(calls[1].query.network, 'eq.testnet');
      assert.equal(calls[1].body.network, 'testnet');
    } finally {
      global.fetch = originalFetch;
      restoreEnv();
    }
  });
});
