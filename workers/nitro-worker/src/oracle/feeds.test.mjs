import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  __buildCanonicalAggregateRecordForTests,
  __buildCanonicalFeedMessageForTests,
  __buildFeedSignatureFieldsForTests,
  __buildFeedUpdateInvocationForTests,
  __buildNeoN3RelaySigningPayloadForTests,
  __buildFeedSnapshotRowsForTests,
  __buildSyncPolicyForTests,
  __clampFeedTimestampSecForTests,
  __countDistinctProvidersForTests,
  __fetchJsonRpcForTests,
  __fetchLatestFeedSnapshotsForTests,
  __isMissingNeoN3BatchUpdateMethodForTests,
  __isRecoverableNeoN3BatchUpdateFailureForTests,
  __getRecoverableNeoN3BatchUpdateFailureReasonForTests,
  __loadFeedStateForTests,
  __meetsMinProvidersForTests,
  __persistFeedSnapshotsForTests,
  __resolveFeedSubmissionWaitForTests,
  __resolveFeedSubmissionWaitTimeoutMsForTests,
  __resolvePairThresholdBpsForTests,
  __resetFeedStateForTests,
  __shouldSubmitFeedForTests,
  __shouldLoadOnchainFeedBaselineForTests,
  __SIGNED_FEED_REQUIRES_PER_FEED_PATH,
  buildCanonicalAggregateStorageKey,
  handleFeedsPrice,
  handleOracleFeed,
  normalizePairSymbol,
} from './feeds.js';
import { __resetProviderRuntimeCachesForTests } from './providers.js';
import {
  __resetCustodyTransportForTests,
  __setCustodyTransportForTests,
} from '../platform/custody.js';

const originalFetch = global.fetch;
const originalWorkerKeyId = process.env.SIGNER_ROLE_WORKER_KEY_ID;
const originalFeedStatePath = process.env.MORPHEUS_FEED_STATE_PATH;
const originalSupabaseUrl = process.env.SUPABASE_URL;
const originalSupabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const originalFeedBootstrap = process.env.MORPHEUS_FEED_BOOTSTRAP_SUPABASE_ENABLED;
const originalFeedSnapshot = process.env.MORPHEUS_FEED_SNAPSHOT_SUPABASE_ENABLED;
const originalFeedProviders = process.env.MORPHEUS_FEED_PROVIDERS;
const originalTwelveDataKey = process.env.TWELVEDATA_API_KEY;
const originalDatafeedHash = process.env.CONTRACT_MORPHEUS_DATAFEED_HASH;
const originalFeedState = process.env.MORPHEUS_NETWORK;
const originalRelayerWif = process.env.MORPHEUS_RELAYER_NEO_N3_WIF;
const originalRelayerKey = process.env.MORPHEUS_RELAYER_NEO_N3_PRIVATE_KEY;
const originalUpdaterWif = process.env.MORPHEUS_UPDATER_NEO_N3_WIF;
const originalUpdaterKey = process.env.MORPHEUS_UPDATER_NEO_N3_PRIVATE_KEY;
const originalAllowUnpinned = process.env.MORPHEUS_ALLOW_UNPINNED_SIGNERS;
const originalWorkerMainnetKey = process.env.MORPHEUS_WORKER_NEO_N3_PRIVATE_KEY_MAINNET;
const originalWorkerMainnetWif = process.env.MORPHEUS_WORKER_NEO_N3_WIF_MAINNET;

test.before(() => {
  process.env.SIGNER_ROLE_WORKER_KEY_ID = 'test-worker-key';
  __setCustodyTransportForTests(async (method) => {
    if (method === 'GET') {
      const network =
        String(process.env.MORPHEUS_NETWORK || '').toLowerCase() === 'mainnet'
          ? 'mainnet'
          : 'testnet';
      return {
        key_id: 'test-worker-key',
        network,
        network_magic: network === 'mainnet' ? 860833102 : 894710606,
        public_key: `02${'22'.repeat(32)}`,
        address: 'NTestWorkerCustodyAddress',
        script_hash: `0x${'33'.repeat(20)}`,
        signing_enabled: true,
      };
    }
    return {
      allowed: true,
      signature: '11'.repeat(64),
      public_key: `02${'22'.repeat(32)}`,
      address: 'NTestWorkerCustodyAddress',
      script_hash: `0x${'33'.repeat(20)}`,
    };
  });
});

test.after(() => {
  if (originalWorkerKeyId === undefined) {
    delete process.env.SIGNER_ROLE_WORKER_KEY_ID;
  } else {
    process.env.SIGNER_ROLE_WORKER_KEY_ID = originalWorkerKeyId;
  }
  __resetCustodyTransportForTests();
});

test.afterEach(async () => {
  global.fetch = originalFetch;
  __resetFeedStateForTests();
  if (originalFeedStatePath === undefined) delete process.env.MORPHEUS_FEED_STATE_PATH;
  else process.env.MORPHEUS_FEED_STATE_PATH = originalFeedStatePath;
  if (originalSupabaseUrl === undefined) delete process.env.SUPABASE_URL;
  else process.env.SUPABASE_URL = originalSupabaseUrl;
  if (originalSupabaseServiceRoleKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  else process.env.SUPABASE_SERVICE_ROLE_KEY = originalSupabaseServiceRoleKey;
  if (originalFeedBootstrap === undefined)
    delete process.env.MORPHEUS_FEED_BOOTSTRAP_SUPABASE_ENABLED;
  else process.env.MORPHEUS_FEED_BOOTSTRAP_SUPABASE_ENABLED = originalFeedBootstrap;
  if (originalFeedSnapshot === undefined)
    delete process.env.MORPHEUS_FEED_SNAPSHOT_SUPABASE_ENABLED;
  else process.env.MORPHEUS_FEED_SNAPSHOT_SUPABASE_ENABLED = originalFeedSnapshot;
  if (originalFeedProviders === undefined) delete process.env.MORPHEUS_FEED_PROVIDERS;
  else process.env.MORPHEUS_FEED_PROVIDERS = originalFeedProviders;
  if (originalTwelveDataKey === undefined) delete process.env.TWELVEDATA_API_KEY;
  else process.env.TWELVEDATA_API_KEY = originalTwelveDataKey;
  if (originalDatafeedHash === undefined) delete process.env.CONTRACT_MORPHEUS_DATAFEED_HASH;
  else process.env.CONTRACT_MORPHEUS_DATAFEED_HASH = originalDatafeedHash;
  if (originalFeedState === undefined) delete process.env.MORPHEUS_NETWORK;
  else process.env.MORPHEUS_NETWORK = originalFeedState;
  if (originalRelayerWif === undefined) delete process.env.MORPHEUS_RELAYER_NEO_N3_WIF;
  else process.env.MORPHEUS_RELAYER_NEO_N3_WIF = originalRelayerWif;
  if (originalRelayerKey === undefined) delete process.env.MORPHEUS_RELAYER_NEO_N3_PRIVATE_KEY;
  else process.env.MORPHEUS_RELAYER_NEO_N3_PRIVATE_KEY = originalRelayerKey;
  if (originalUpdaterWif === undefined) delete process.env.MORPHEUS_UPDATER_NEO_N3_WIF;
  else process.env.MORPHEUS_UPDATER_NEO_N3_WIF = originalUpdaterWif;
  if (originalUpdaterKey === undefined) delete process.env.MORPHEUS_UPDATER_NEO_N3_PRIVATE_KEY;
  else process.env.MORPHEUS_UPDATER_NEO_N3_PRIVATE_KEY = originalUpdaterKey;
  if (originalAllowUnpinned === undefined) delete process.env.MORPHEUS_ALLOW_UNPINNED_SIGNERS;
  else process.env.MORPHEUS_ALLOW_UNPINNED_SIGNERS = originalAllowUnpinned;
  if (originalWorkerMainnetKey === undefined)
    delete process.env.MORPHEUS_WORKER_NEO_N3_PRIVATE_KEY_MAINNET;
  else process.env.MORPHEUS_WORKER_NEO_N3_PRIVATE_KEY_MAINNET = originalWorkerMainnetKey;
  if (originalWorkerMainnetWif === undefined) delete process.env.MORPHEUS_WORKER_NEO_N3_WIF_MAINNET;
  else process.env.MORPHEUS_WORKER_NEO_N3_WIF_MAINNET = originalWorkerMainnetWif;
});

test('buildNeoN3RelaySigningPayload does not inject updater material over worker context', () => {
  process.env.MORPHEUS_RELAYER_NEO_N3_WIF = 'relayer-wif';
  process.env.MORPHEUS_RELAYER_NEO_N3_PRIVATE_KEY = 'relayer-key';
  process.env.MORPHEUS_UPDATER_NEO_N3_WIF = 'updater-wif';
  process.env.MORPHEUS_UPDATER_NEO_N3_PRIVATE_KEY = 'updater-key';

  const resolved = __buildNeoN3RelaySigningPayloadForTests({ network: 'mainnet' });
  assert.deepEqual(resolved, {});
});

test('buildNeoN3RelaySigningPayload preserves explicit payload signer material', () => {
  process.env.MORPHEUS_UPDATER_NEO_N3_WIF = 'updater-wif';
  process.env.MORPHEUS_UPDATER_NEO_N3_PRIVATE_KEY = 'updater-key';

  const resolved = __buildNeoN3RelaySigningPayloadForTests({
    network: 'mainnet',
    private_key: 'explicit-key',
    wif: 'explicit-wif',
  });
  assert.deepEqual(resolved, { private_key: 'explicit-key', wif: 'explicit-wif' });
});

test('normalizePairSymbol maps legacy oil symbol to WTI-USD', () => {
  assert.equal(normalizePairSymbol('OIL-USD'), 'WTI-USD');
});

test('Neo N3 batch fallback detects current RPC missing updateFeeds error shape', () => {
  assert.equal(
    __isMissingNeoN3BatchUpdateMethodForTests(
      'Method "updateFeeds" with 6 parameter(s) doesn\'t exist in the contract 0x9bea75cf702f6afc09125aa6d22f082bfd2ee064.'
    ),
    true
  );
});

test('Neo N3 batch fallback treats batch-only unauthorized as recoverable', () => {
  assert.equal(
    __isRecoverableNeoN3BatchUpdateFailureForTests('ABORTMSG is executed. Reason: unauthorized'),
    true
  );
  assert.equal(
    __getRecoverableNeoN3BatchUpdateFailureReasonForTests(
      'ABORTMSG is executed. Reason: unauthorized'
    ),
    'neo_n3_updatefeeds_unauthorized'
  );
  assert.equal(
    __getRecoverableNeoN3BatchUpdateFailureReasonForTests(
      'Method "updateFeeds" with 6 parameter(s) doesn\'t exist in the contract 0x9bea75cf702f6afc09125aa6d22f082bfd2ee064.'
    ),
    'neo_n3_updatefeeds_missing'
  );
  assert.equal(
    __isRecoverableNeoN3BatchUpdateFailureForTests(
      'Insufficient GAS. Required: 0.00863725 Available: 0.00586564'
    ),
    false
  );
  assert.equal(
    __getRecoverableNeoN3BatchUpdateFailureReasonForTests(
      'Insufficient GAS. Required: 0.00863725 Available: 0.00586564'
    ),
    null
  );
});

test('signed-feed batch path is recognized as a recoverable per-feed fallback (C1)', () => {
  // When a verification key is registered, the batch updateFeeds path raises this
  // marker so submitQuotesToN3WithFallback routes through the per-feed signed
  // updateFeedSigned submissions instead of submitting an unsigned batch.
  assert.equal(typeof __SIGNED_FEED_REQUIRES_PER_FEED_PATH, 'string');
  assert.equal(
    __getRecoverableNeoN3BatchUpdateFailureReasonForTests(__SIGNED_FEED_REQUIRES_PER_FEED_PATH),
    __SIGNED_FEED_REQUIRES_PER_FEED_PATH
  );
  assert.equal(
    __isRecoverableNeoN3BatchUpdateFailureForTests(__SIGNED_FEED_REQUIRES_PER_FEED_PATH),
    true
  );
});

test('pair-specific threshold overrides the global feed threshold', () => {
  process.env.MORPHEUS_FEED_PAIR_REGISTRY_JSON = JSON.stringify({
    'NEO-USD': {
      threshold_bps: 5,
    },
  });

  assert.equal(
    __resolvePairThresholdBpsForTests('TWELVEDATA:NEO-USD', { network: 'mainnet' }, 'neo_n3'),
    5
  );
});

test('default feed sync policy checks once per minute and uses a 0.1% change threshold', () => {
  const policy = __buildSyncPolicyForTests('neo_n3', { network: 'mainnet' });

  assert.equal(policy.thresholdBps, 10);
  assert.equal(policy.minUpdateIntervalMs, 60000);
});

test('feed publication submits asynchronously by default and caps explicit waits', () => {
  assert.equal(__resolveFeedSubmissionWaitForTests({}), false);
  assert.equal(__resolveFeedSubmissionWaitForTests({ wait: false }), false);
  assert.equal(__resolveFeedSubmissionWaitForTests({ wait: 'true' }), true);
  assert.equal(__resolveFeedSubmissionWaitTimeoutMsForTests({}), 8000);
  assert.equal(__resolveFeedSubmissionWaitTimeoutMsForTests({ timeout_ms: '2500' }), 2500);
  assert.equal(__resolveFeedSubmissionWaitTimeoutMsForTests({ timeout_ms: '30s' }), 8000);
});

test('feed baseline uses local state unless a refresh is required', () => {
  assert.equal(__shouldLoadOnchainFeedBaselineForTests({}, { records: {} }), true);
  assert.equal(
    __shouldLoadOnchainFeedBaselineForTests(
      {},
      { records: { 'TWELVEDATA:NEO-USD': { price_units: '2694000' } } }
    ),
    false
  );
  assert.equal(
    __shouldLoadOnchainFeedBaselineForTests(
      { force: true },
      { records: { 'TWELVEDATA:NEO-USD': { price_units: '2694000' } } }
    ),
    true
  );
  assert.equal(
    __shouldLoadOnchainFeedBaselineForTests(
      { refresh_onchain_baseline: 'true' },
      { records: { 'TWELVEDATA:NEO-USD': { price_units: '2694000' } } }
    ),
    true
  );
});

test('feed submission only allows pairs whose price changed by at least 0.1%', () => {
  const policy = { thresholdBps: 10, minUpdateIntervalMs: 60000, staleAfterMs: 300000 };
  const previousRecord = {
    price_units: '100000000',
    last_submitted_at_ms: Date.now() - 120000,
  };
  const quote = { price: '100.05', decimals: 6 };

  assert.deepEqual(
    __shouldSubmitFeedForTests('TWELVEDATA:NEO-USD', quote, previousRecord, policy),
    {
      allow: false,
      reason: 'price-change-below-threshold',
      change_bps: 5,
      comparison_basis: 'current-chain-price',
      current_chain_price_units: '100000000',
      candidate_price_units: '100050000',
      storage_key: 'TWELVEDATA:NEO-USD',
    }
  );

  const changedQuote = { price: '100.10', decimals: 6 };
  assert.equal(
    __shouldSubmitFeedForTests('TWELVEDATA:NEO-USD', changedQuote, previousRecord, policy).reason,
    'threshold-met'
  );
});

test('feed submission refreshes stale on-chain timestamps even below the price threshold', () => {
  const policy = { thresholdBps: 10, minUpdateIntervalMs: 60000, staleAfterMs: 300000 };
  const previousRecord = {
    price_units: '100000000',
    timestamp: String(Math.floor((Date.now() - 600000) / 1000)),
  };
  const quote = { price: '100.05', decimals: 6 };

  const decision = __shouldSubmitFeedForTests('TWELVEDATA:USDT-USD', quote, previousRecord, policy);
  assert.equal(decision.allow, true);
  assert.equal(decision.reason, 'stale-refresh');
  assert.ok(decision.stale_age_ms >= 300000);
  assert.equal(decision.stale_after_ms, 300000);
  assert.equal(decision.change_bps, 5);
  assert.equal(decision.comparison_basis, 'current-chain-price');
  assert.equal(decision.current_chain_price_units, '100000000');
  assert.equal(decision.candidate_price_units, '100050000');
  assert.equal(decision.storage_key, 'TWELVEDATA:USDT-USD');
});

test('clampFeedTimestampSec enforces strict monotonicity above the previous on-chain timestamp (B9)', () => {
  const nowSec = 1_900_000_000;
  // Upstream older than the previous on-chain timestamp must be bumped to prev+1.
  const stale = __clampFeedTimestampSecForTests({
    upstreamSec: nowSec - 10_000,
    prevTs: nowSec - 5,
    nowSec,
  });
  assert.equal(stale, nowSec - 5 + 1, 'stale upstream clamps to prevTs + 1');

  // A normal in-window upstream passes through unchanged.
  const normal = __clampFeedTimestampSecForTests({
    upstreamSec: nowSec - 2,
    prevTs: nowSec - 100,
    nowSec,
  });
  assert.equal(normal, nowSec - 2);
});

test('clampFeedTimestampSec caps a mildly-future upstream to now + skew (B9)', () => {
  const nowSec = 1_900_000_000;
  const clamped = __clampFeedTimestampSecForTests({
    upstreamSec: nowSec + 200, // within the 300s hard-reject window but beyond skew
    prevTs: 0,
    nowSec,
    futureSkewSeconds: 60,
    maxFutureSeconds: 300,
  });
  assert.equal(clamped, nowSec + 60, 'future upstream is capped to now + skew');
});

test('clampFeedTimestampSec rejects an upstream timestamp far in the future (B9)', () => {
  const nowSec = 1_900_000_000;
  assert.throws(
    () =>
      __clampFeedTimestampSecForTests({
        upstreamSec: nowSec + 86_400, // 1 day ahead
        prevTs: 0,
        nowSec,
        maxFutureSeconds: 300,
      }),
    /more than 300s in the future/
  );
});

test('handleOracleFeed rejects a future-dated provider timestamp instead of anchoring it (B9)', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'morpheus-feed-future-ts-'));
  process.env.MORPHEUS_FEED_STATE_PATH = path.join(tempDir, 'feed-state.json');
  process.env.MORPHEUS_FEED_BOOTSTRAP_SUPABASE_ENABLED = 'false';
  process.env.MORPHEUS_FEED_SNAPSHOT_SUPABASE_ENABLED = 'false';
  process.env.MORPHEUS_FEED_PROVIDERS = 'twelvedata';
  process.env.TWELVEDATA_API_KEY = 'test-twelvedata-key';
  process.env.MORPHEUS_NETWORK = 'mainnet';
  delete process.env.CONTRACT_PRICEFEED_HASH;
  delete process.env.CONTRACT_MORPHEUS_DATAFEED_HASH;

  // Provider reports an observation time 2 days in the future — a poisoned/bad
  // upstream. TwelveData surfaces the source time via a `datetime` field.
  const futureDate = new Date(Date.now() + 2 * 86_400 * 1000);
  const futureDatetime = futureDate.toISOString().replace('T', ' ').slice(0, 19);
  global.fetch = async (url) => {
    const value = String(url);
    if (!value.includes('api.twelvedata.com')) {
      throw new Error(`unexpected fetch ${value}`);
    }
    return new Response(JSON.stringify({ price: '2.900', datetime: futureDatetime }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const response = await handleOracleFeed({
    network: 'mainnet',
    target_chain: 'neo_n3',
    symbols: ['TWELVEDATA:NEO-USD'],
    force: true,
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.batch_submitted, false);
  assert.equal(body.batch_count, 0, 'future-dated quote must not enter the batch');
  assert.equal(body.sync_results[0].relay_status, 'skipped');
  assert.equal(body.sync_results[0].skip_reason, 'upstream_timestamp_rejected');
  assert.ok(
    body.errors.some((entry) => /in the future/.test(entry.error || '')),
    'a timestamp-rejected error should be surfaced'
  );
});

test('handleOracleFeed honors pair-specific threshold overrides for mainnet pairs', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'morpheus-feed-threshold-'));
  process.env.MORPHEUS_FEED_STATE_PATH = path.join(tempDir, 'feed-state.json');
  process.env.MORPHEUS_FEED_BOOTSTRAP_SUPABASE_ENABLED = 'false';
  process.env.MORPHEUS_FEED_SNAPSHOT_SUPABASE_ENABLED = 'false';
  process.env.MORPHEUS_FEED_PROVIDERS = 'twelvedata';
  process.env.TWELVEDATA_API_KEY = 'test-twelvedata-key';
  process.env.MORPHEUS_FEED_CHANGE_THRESHOLD_BPS = '10';
  process.env.MORPHEUS_NETWORK = 'mainnet';
  process.env.MORPHEUS_ALLOW_UNPINNED_SIGNERS = 'true';
  process.env.MORPHEUS_FEED_PAIR_REGISTRY_JSON = JSON.stringify({
    'NEO-USD': {
      threshold_bps: 5,
    },
  });
  delete process.env.CONTRACT_PRICEFEED_HASH;
  delete process.env.CONTRACT_MORPHEUS_DATAFEED_HASH;

  await fs.writeFile(
    process.env.MORPHEUS_FEED_STATE_PATH.replace(/\.json$/, '.mainnet.neo_n3.json'),
    JSON.stringify({
      records: {
        'TWELVEDATA:NEO-USD': {
          storage_pair: 'TWELVEDATA:NEO-USD',
          pair: 'TWELVEDATA:NEO-USD',
          provider: 'twelvedata',
          price: '2.694',
          price_units: '2694000',
          round_id: '1',
          last_submitted_at_ms: Date.now() - 120000,
        },
      },
    }),
    'utf8'
  );

  global.fetch = async (url) => {
    const value = String(url);
    if (!value.includes('api.twelvedata.com')) {
      throw new Error(`unexpected fetch ${value}`);
    }
    return new Response(JSON.stringify({ price: '2.692', timestamp: '2026-04-12T23:23:09.000Z' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const response = await handleOracleFeed({
    network: 'mainnet',
    target_chain: 'neo_n3',
    symbols: ['TWELVEDATA:NEO-USD'],
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.batch_submitted, false);
  assert.equal(body.batch_count, 1);
  assert.equal(body.sync_results[0].relay_status, 'skipped');
  assert.equal(body.sync_results[0].skip_reason, 'submission_unavailable');
});

test('loadFeedState bootstraps from Supabase snapshots when local state is empty', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'morpheus-feed-state-'));
  process.env.MORPHEUS_FEED_STATE_PATH = path.join(tempDir, 'feed-state.json');
  process.env.SUPABASE_URL = 'https://supabase.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
  process.env.MORPHEUS_FEED_BOOTSTRAP_SUPABASE_ENABLED = 'true';
  delete process.env.MORPHEUS_NETWORK;

  global.fetch = async (url) => {
    assert.match(String(url), /morpheus_feed_snapshots/);
    assert.match(String(url), /network=eq\.mainnet/);
    assert.match(String(url), /target_chain=eq\.neo_n3/);
    return new Response(
      JSON.stringify([
        {
          symbol: 'TWELVEDATA:NEO-USD',
          target_chain: 'neo_n3',
          price: '12.34',
          attestation_hash: '0xaaa',
          payload: {
            storage_pair: 'TWELVEDATA:NEO-USD',
            pair: 'NEO-USD',
            provider: 'twelvedata',
            price: '12.34',
            last_observed_price: '12.34',
          },
        },
      ]),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  };

  const state = await __loadFeedStateForTests({ network: 'mainnet', targetChain: 'neo_n3' });
  assert.equal(state.records['TWELVEDATA:NEO-USD'].price, '12.34');
  assert.equal(state.records['TWELVEDATA:NEO-USD'].provider, 'twelvedata');
});

test('handleOracleFeed persists Supabase snapshots without blocking pricefeed flow', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'morpheus-feed-snapshot-'));
  process.env.MORPHEUS_FEED_STATE_PATH = path.join(tempDir, 'feed-state.json');
  process.env.SUPABASE_URL = 'https://supabase.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
  process.env.MORPHEUS_FEED_BOOTSTRAP_SUPABASE_ENABLED = 'false';
  process.env.MORPHEUS_FEED_SNAPSHOT_SUPABASE_ENABLED = 'true';
  process.env.MORPHEUS_FEED_PROVIDERS = 'twelvedata';
  process.env.TWELVEDATA_API_KEY = 'test-twelvedata-key';
  process.env.MORPHEUS_NETWORK = 'testnet';
  process.env.MORPHEUS_ALLOW_UNPINNED_SIGNERS = 'true';
  delete process.env.CONTRACT_PRICEFEED_HASH;
  delete process.env.CONTRACT_MORPHEUS_DATAFEED_HASH;

  const snapshotWrites = [];
  global.fetch = async (url, options = {}) => {
    const value = String(url);
    if (value.includes('api.twelvedata.com')) {
      return new Response(JSON.stringify({ price: '12.34' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (value.includes('morpheus_feed_snapshots')) {
      assert.equal(options.method, 'POST');
      snapshotWrites.push(JSON.parse(String(options.body)));
      return new Response('', { status: 201 });
    }
    throw new Error(`unexpected fetch ${value}`);
  };

  const response = await handleOracleFeed({
    target_chain: 'neo_n3',
    symbols: ['NEO-USD'],
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.mode, 'pricefeed');
  assert.equal(snapshotWrites.length, 1);
  assert.equal(snapshotWrites[0][0].symbol, 'TWELVEDATA:NEO-USD');
});

test('buildFeedSnapshotRows keeps relay metadata in snapshot payloads', () => {
  const rows = __buildFeedSnapshotRowsForTests(
    'neo_n3',
    [
      {
        storage_pair: 'TWELVEDATA:NEO-USD',
        pair: 'NEO-USD',
        relay_status: 'submitted',
        skip_reason: null,
        change_bps: 42,
        comparison_basis: 'last_submitted',
        anchored_tx: { txid: '0xabc' },
        quote: { provider: 'twelvedata', attestation_hash: '0xaaa', price: '12.34' },
      },
    ],
    {
      records: {
        'TWELVEDATA:NEO-USD': {
          storage_pair: 'TWELVEDATA:NEO-USD',
          pair: 'NEO-USD',
          provider: 'twelvedata',
          price: '12.34',
          attestation_hash: '0xaaa',
        },
      },
    },
    { txid: '0xabc' }
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].symbol, 'TWELVEDATA:NEO-USD');
  assert.equal(rows[0].payload.relay_status, 'submitted');
  assert.deepEqual(rows[0].payload.anchored_tx, { txid: '0xabc' });
});

test('handleOracleFeed isolates feed state by Morpheus network in a shared worker', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'morpheus-feed-shared-network-'));
  process.env.MORPHEUS_FEED_STATE_PATH = path.join(tempDir, 'feed-state.json');
  process.env.MORPHEUS_FEED_BOOTSTRAP_SUPABASE_ENABLED = 'false';
  process.env.MORPHEUS_FEED_SNAPSHOT_SUPABASE_ENABLED = 'false';
  process.env.MORPHEUS_FEED_PROVIDERS = 'twelvedata';
  process.env.TWELVEDATA_API_KEY = 'test-twelvedata-key';
  process.env.MORPHEUS_ALLOW_UNPINNED_SIGNERS = 'true';
  delete process.env.CONTRACT_PRICEFEED_HASH;
  delete process.env.CONTRACT_MORPHEUS_DATAFEED_HASH;

  let requestCount = 0;
  global.fetch = async (url) => {
    const value = String(url);
    if (!value.includes('api.twelvedata.com')) {
      throw new Error(`unexpected fetch ${value}`);
    }
    requestCount += 1;
    return new Response(JSON.stringify({ price: requestCount === 1 ? '12.34' : '56.78' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const mainnetResponse = await handleOracleFeed({
    network: 'mainnet',
    target_chain: 'neo_n3',
    symbols: ['NEO-USD'],
  });
  assert.equal(mainnetResponse.status, 200);

  const testnetResponse = await handleOracleFeed({
    network: 'testnet',
    target_chain: 'neo_n3',
    symbols: ['NEO-USD'],
  });
  assert.equal(testnetResponse.status, 200);

  const mainnetState = await __loadFeedStateForTests({ network: 'mainnet', targetChain: 'neo_n3' });
  const testnetState = await __loadFeedStateForTests({ network: 'testnet', targetChain: 'neo_n3' });
  assert.equal(mainnetState.records['TWELVEDATA:NEO-USD'].last_observed_price, '12.34');
  assert.equal(testnetState.records['TWELVEDATA:NEO-USD'].last_observed_price, '56.78');
});

test('handleOracleFeed isolates feed state by target chain inside one Morpheus network', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'morpheus-feed-shared-target-'));
  process.env.MORPHEUS_FEED_STATE_PATH = path.join(tempDir, 'feed-state.json');
  process.env.MORPHEUS_FEED_BOOTSTRAP_SUPABASE_ENABLED = 'false';
  process.env.MORPHEUS_FEED_SNAPSHOT_SUPABASE_ENABLED = 'false';
  process.env.MORPHEUS_FEED_PROVIDERS = 'twelvedata';
  process.env.TWELVEDATA_API_KEY = 'test-twelvedata-key';
  process.env.MORPHEUS_ALLOW_UNPINNED_SIGNERS = 'true';
  delete process.env.CONTRACT_PRICEFEED_HASH;
  delete process.env.CONTRACT_MORPHEUS_DATAFEED_HASH;

  let requestCount = 0;
  global.fetch = async (url) => {
    const value = String(url);
    if (!value.includes('api.twelvedata.com')) {
      throw new Error(`unexpected fetch ${value}`);
    }
    requestCount += 1;
    return new Response(JSON.stringify({ price: requestCount === 1 ? '12.34' : '56.78' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const neoN3Response = await handleOracleFeed({
    network: 'mainnet',
    target_chain: 'neo_n3',
    symbols: ['NEO-USD'],
  });
  assert.equal(neoN3Response.status, 200);

  const neoN3State = await __loadFeedStateForTests({ network: 'mainnet', targetChain: 'neo_n3' });
  assert.equal(neoN3State.records['TWELVEDATA:NEO-USD'].last_observed_price, '12.34');
});

test('handleOracleFeed fails closed when on-chain baseline is unavailable and local state is empty', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'morpheus-feed-baseline-'));
  process.env.MORPHEUS_FEED_STATE_PATH = path.join(tempDir, 'feed-state.json');
  process.env.MORPHEUS_FEED_BOOTSTRAP_SUPABASE_ENABLED = 'false';
  process.env.MORPHEUS_FEED_SNAPSHOT_SUPABASE_ENABLED = 'false';
  process.env.MORPHEUS_FEED_PROVIDERS = 'twelvedata';
  process.env.TWELVEDATA_API_KEY = 'test-twelvedata-key';
  process.env.MORPHEUS_NETWORK = 'mainnet';
  process.env.NEO_RPC_URL = 'http://seed1.neo.org:10332';
  process.env.CONTRACT_MORPHEUS_DATAFEED_HASH = '0x03013f49c42a14546c8bbe58f9d434c3517fccab';
  process.env.MORPHEUS_ALLOW_UNPINNED_SIGNERS = 'true';
  process.env.MORPHEUS_WORKER_NEO_N3_PRIVATE_KEY_MAINNET =
    '1111111111111111111111111111111111111111111111111111111111111111';

  const calls = [];
  global.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes('api.twelvedata.com')) {
      return new Response(JSON.stringify({ price: '2.723' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error('rpc baseline fetch failed');
  };

  const response = await handleOracleFeed({
    network: 'mainnet',
    target_chain: 'neo_n3',
    symbols: ['TWELVEDATA:NEO-USD'],
  });
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.equal(body.batch_submitted, false);
  assert.equal(body.batch_count, 0);
  assert.deepEqual(body.sync_results, []);
  assert.match(body.errors[0].error, /baseline/i);
  assert.ok(calls.some((entry) => entry.includes('seed1.neo.org:10332')));
  assert.ok(!calls.some((entry) => entry.includes('api.twelvedata.com')));
});

test('handleOracleFeed does not mark local state as submitted when submission prerequisites are missing', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'morpheus-feed-submit-gap-'));
  process.env.MORPHEUS_FEED_STATE_PATH = path.join(tempDir, 'feed-state.json');
  process.env.MORPHEUS_FEED_BOOTSTRAP_SUPABASE_ENABLED = 'false';
  process.env.MORPHEUS_FEED_SNAPSHOT_SUPABASE_ENABLED = 'false';
  process.env.MORPHEUS_FEED_PROVIDERS = 'twelvedata';
  process.env.TWELVEDATA_API_KEY = 'test-twelvedata-key';
  process.env.MORPHEUS_NETWORK = 'mainnet';
  process.env.MORPHEUS_ALLOW_UNPINNED_SIGNERS = 'true';
  delete process.env.CONTRACT_PRICEFEED_HASH;
  delete process.env.CONTRACT_MORPHEUS_DATAFEED_HASH;
  delete process.env.MORPHEUS_RELAYER_NEO_N3_WIF;
  delete process.env.MORPHEUS_RELAYER_NEO_N3_PRIVATE_KEY;
  delete process.env.MORPHEUS_UPDATER_NEO_N3_WIF;
  delete process.env.MORPHEUS_UPDATER_NEO_N3_PRIVATE_KEY;

  const scopedStatePath = process.env.MORPHEUS_FEED_STATE_PATH.replace(
    /\.json$/,
    '.mainnet.neo_n3.json'
  );
  await fs.writeFile(
    scopedStatePath,
    JSON.stringify({
      records: {
        'TWELVEDATA:NEO-USD': {
          storage_pair: 'TWELVEDATA:NEO-USD',
          pair: 'TWELVEDATA:NEO-USD',
          provider: 'twelvedata',
          price: '2.694',
          price_units: '2694000',
          round_id: '1',
          last_submitted_at_ms: 1000,
          last_observed_price: '2.694',
          last_observed_price_units: '2694000',
          last_observed_at_ms: 1000,
        },
      },
    }),
    'utf8'
  );

  global.fetch = async (url) => {
    const value = String(url);
    if (!value.includes('api.twelvedata.com')) {
      throw new Error(`unexpected fetch ${value}`);
    }
    return new Response(JSON.stringify({ price: '2.900', timestamp: '2026-04-15T00:00:00.000Z' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const response = await handleOracleFeed({
    network: 'mainnet',
    target_chain: 'neo_n3',
    symbols: ['TWELVEDATA:NEO-USD'],
    force: true,
  });
  const body = await response.json();
  const state = await __loadFeedStateForTests({ network: 'mainnet', targetChain: 'neo_n3' });
  const record = state.records['TWELVEDATA:NEO-USD'];

  assert.equal(response.status, 200);
  assert.equal(body.batch_submitted, false);
  assert.equal(body.batch_count, 1);
  assert.match(body.errors[0].error, /datafeed contract hash is not configured/i);
  assert.equal(body.sync_results[0].relay_status, 'skipped');
  assert.equal(body.sync_results[0].skip_reason, 'submission_unavailable');
  assert.equal(record.last_submitted_at_ms, 1000);
  assert.equal(record.price, '2.694');
  assert.equal(record.last_observed_price, '2.9');
});

test('handleOracleFeed does not block on Neo baseline when local feed state is warm', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'morpheus-feed-warm-baseline-'));
  process.env.MORPHEUS_FEED_STATE_PATH = path.join(tempDir, 'feed-state.json');
  process.env.MORPHEUS_FEED_BOOTSTRAP_SUPABASE_ENABLED = 'false';
  process.env.MORPHEUS_FEED_SNAPSHOT_SUPABASE_ENABLED = 'false';
  process.env.MORPHEUS_FEED_PROVIDERS = 'twelvedata';
  process.env.TWELVEDATA_API_KEY = 'test-twelvedata-key';
  process.env.MORPHEUS_NETWORK = 'mainnet';
  process.env.NEO_RPC_URL = 'https://neo-rpc.example';
  process.env.CONTRACT_MORPHEUS_DATAFEED_HASH = '0x03013f49c42a14546c8bbe58f9d434c3517fccab';
  process.env.MORPHEUS_ALLOW_UNPINNED_SIGNERS = 'true';
  process.env.MORPHEUS_WORKER_NEO_N3_PRIVATE_KEY_MAINNET =
    '1111111111111111111111111111111111111111111111111111111111111111';

  const scopedStatePath = process.env.MORPHEUS_FEED_STATE_PATH.replace(
    /\.json$/,
    '.mainnet.neo_n3.json'
  );
  await fs.writeFile(
    scopedStatePath,
    JSON.stringify({
      records: {
        'TWELVEDATA:NEO-USD': {
          storage_pair: 'TWELVEDATA:NEO-USD',
          pair: 'TWELVEDATA:NEO-USD',
          provider: 'twelvedata',
          price: '2.694',
          price_units: '2694000',
          round_id: '7',
          last_submitted_at_ms: Date.now() - 120000,
        },
      },
    }),
    'utf8'
  );

  const calls = [];
  global.fetch = async (url) => {
    const value = String(url);
    calls.push(value);
    if (value.includes('api.twelvedata.com')) {
      return new Response(
        JSON.stringify({ price: '2.695', timestamp: '2026-04-15T00:00:00.000Z' }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }
      );
    }
    throw new Error(`unexpected blocking baseline fetch ${value}`);
  };

  const response = await handleOracleFeed({
    network: 'mainnet',
    target_chain: 'neo_n3',
    symbols: ['TWELVEDATA:NEO-USD'],
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.batch_submitted, false);
  assert.equal(body.sync_results[0].relay_status, 'skipped');
  assert.ok(calls.every((entry) => entry.includes('api.twelvedata.com')));
});

test('feed supabase and rpc fetches are bounded by abort signals', async () => {
  process.env.SUPABASE_URL = 'https://mock-supabase.example.com';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role';

  const captured = [];
  global.fetch = async (url, init = {}) => {
    captured.push({ url: String(url), init });
    if (String(url).includes('morpheus_feed_snapshots')) {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { stack: [] } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  await __fetchLatestFeedSnapshotsForTests(5, {});
  await __persistFeedSnapshotsForTests([{ symbol: 'NEO-USD' }]);
  await __fetchJsonRpcForTests('https://rpc.example.com', {
    jsonrpc: '2.0',
    id: 1,
    method: 'getversion',
    params: [],
  });

  assert.equal(captured.length, 3);
  for (const call of captured) {
    assert.ok(call.init.signal instanceof AbortSignal, `expected abort signal on ${call.url}`);
  }
});

test('handleFeedsPrice sanitizes provider errors before returning them', async () => {
  process.env.TWELVEDATA_API_KEY = 'test-key';
  __resetProviderRuntimeCachesForTests();

  global.fetch = async () => {
    throw new Error('lookup failed reading /home/morpheus/.aws/credentials');
  };

  const response = await handleFeedsPrice('NEO-USD', { provider: 'twelvedata' });
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.equal(body.error, 'internal error');
});

test('buildFeedSignatureFields carries the off-chain signature and signer pubkey (C1)', () => {
  // A signed quote contributes the ECDSA signature + signer public key so the
  // anchored value can be verified once an on-chain verification key is registered.
  assert.deepEqual(
    __buildFeedSignatureFieldsForTests({
      signature: '0xsig',
      public_key: '03abc',
      price: '2.7',
    }),
    { signature: '0xsig', signer_public_key: '03abc' }
  );

  // An unsigned quote contributes nothing (the contract stays witness-only).
  assert.deepEqual(__buildFeedSignatureFieldsForTests({ price: '2.7' }), {});
  assert.deepEqual(__buildFeedSignatureFieldsForTests({}), {});
});

test('buildCanonicalAggregateRecord requires at least two providers (C2)', () => {
  // A single-source aggregation must never be laundered into the canonical record.
  assert.equal(
    __buildCanonicalAggregateRecordForTests('NEO-USD', {
      price: 2.7,
      method: 'single-source',
      providers_used: ['twelvedata'],
      confidence: 'single-source',
    }),
    null
  );

  // A two-source-divergent result collapsed to one survivor is also single-provider.
  assert.equal(
    __buildCanonicalAggregateRecordForTests('NEO-USD', {
      price: 2.7,
      method: 'two-source-divergent',
      providers_used: ['twelvedata'],
      providers_rejected: ['binance-spot'],
      confidence: 'low',
    }),
    null
  );

  // Two agreeing providers qualify and carry the aggregation price.
  const canonical = __buildCanonicalAggregateRecordForTests('NEO-USD', {
    price: 2.71,
    method: 'mean',
    providers_used: ['twelvedata', 'binance-spot'],
    providers_rejected: [],
    deviation_pct: 0.37,
    confidence: 'medium',
  });
  assert.ok(canonical);
  assert.equal(canonical.storageKey, 'AGG:NEO-USD');
  assert.equal(canonical.record.aggregate, true);
  assert.equal(canonical.record.provider_count, 2);
  assert.equal(canonical.record.aggregation_method, 'mean');
  assert.equal(canonical.record.price, '2.710000');
  assert.equal(canonical.record.price_units, '2710000');
  assert.deepEqual(canonical.record.providers_used, ['twelvedata', 'binance-spot']);
});

test('handleOracleFeed writes one canonical AGG record when two providers agree (C2)', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'morpheus-feed-canonical-agg-'));
  process.env.MORPHEUS_FEED_STATE_PATH = path.join(tempDir, 'feed-state.json');
  process.env.MORPHEUS_FEED_BOOTSTRAP_SUPABASE_ENABLED = 'false';
  process.env.MORPHEUS_FEED_SNAPSHOT_SUPABASE_ENABLED = 'false';
  process.env.MORPHEUS_FEED_PROVIDERS = 'twelvedata,binance-spot';
  process.env.TWELVEDATA_API_KEY = 'test-twelvedata-key';
  process.env.MORPHEUS_NETWORK = 'mainnet';
  process.env.MORPHEUS_ALLOW_UNPINNED_SIGNERS = 'true';
  delete process.env.CONTRACT_PRICEFEED_HASH;
  delete process.env.CONTRACT_MORPHEUS_DATAFEED_HASH;
  __resetProviderRuntimeCachesForTests();

  global.fetch = async (url) => {
    const value = String(url);
    if (value.includes('api.twelvedata.com')) {
      return new Response(JSON.stringify({ price: '2.700' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (value.includes('binance.com')) {
      return new Response(JSON.stringify({ symbol: 'NEOUSDT', price: '2.720' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected fetch ${value}`);
  };

  const response = await handleOracleFeed({
    network: 'mainnet',
    target_chain: 'neo_n3',
    symbols: ['NEO-USD'],
    force: true,
  });
  const body = await response.json();
  assert.equal(response.status, 200);

  // The two-source aggregation is surfaced and a single canonical record is persisted.
  assert.ok(body.aggregations && body.aggregations['NEO-USD']);
  const canonicalKey = buildCanonicalAggregateStorageKey('NEO-USD');
  assert.equal(canonicalKey, 'AGG:NEO-USD');

  const aggregatedSyncResults = body.sync_results.filter(
    (entry) => entry.relay_status === 'aggregated'
  );
  assert.equal(aggregatedSyncResults.length, 1, 'exactly one canonical aggregate per pair');
  assert.equal(aggregatedSyncResults[0].storage_pair, canonicalKey);
  assert.equal(aggregatedSyncResults[0].provider_count, 2);

  const state = await __loadFeedStateForTests({ network: 'mainnet', targetChain: 'neo_n3' });
  const canonical = state.records[canonicalKey];
  assert.ok(canonical, 'canonical AGG record persisted');
  assert.equal(canonical.aggregate, true);
  assert.equal(canonical.provider_count, 2);
  // Mean of 2.70 and 2.72 is 2.71.
  assert.equal(canonical.price, '2.710000');
  assert.equal(canonical.price_units, '2710000');
});

test('countDistinctProviders deduplicates a repeated provider id (C2)', () => {
  assert.equal(
    __countDistinctProvidersForTests({ providers_used: ['twelvedata', 'twelvedata'] }),
    1
  );
  assert.equal(
    __countDistinctProvidersForTests({
      providers_used: ['twelvedata', 'TwelveData', ' twelvedata '],
    }),
    1
  );
  assert.equal(
    __countDistinctProvidersForTests({ providers_used: ['twelvedata', 'binance-spot'] }),
    2
  );
  assert.equal(__countDistinctProvidersForTests({ providers_used: [] }), 0);
  assert.equal(__countDistinctProvidersForTests(null), 0);
});

test('meetsMinProviders rejects a duplicated single provider but accepts two distinct ones (C2)', () => {
  // The exact masquerade: MORPHEUS_FEED_PROVIDERS="twelvedata,twelvedata" yields a
  // length-2 providers_used from ONE source — it must NOT satisfy minProviders=2.
  assert.equal(
    __meetsMinProvidersForTests({ providers_used: ['twelvedata', 'twelvedata'] }, 2),
    false
  );
  assert.equal(
    __meetsMinProvidersForTests({ providers_used: ['twelvedata', 'binance-spot'] }, 2),
    true
  );
});

test('buildCanonicalAggregateRecord refuses a duplicated single provider (C2)', () => {
  // Even when the upstream dedup is bypassed (e.g. an aggregation handed in
  // directly), the canonical record must never be written from one source.
  assert.equal(
    __buildCanonicalAggregateRecordForTests('NEO-USD', {
      price: 2.7,
      method: 'mean',
      providers_used: ['twelvedata', 'twelvedata'],
      providers_rejected: [],
      confidence: 'medium',
    }),
    null
  );
});

test('buildCanonicalFeedMessage matches the contract canonical v2 bytes (C1)', () => {
  // This is the exact format MorpheusDataFeed.BuildFeedMessage produces. The
  // contract hash is supplied in display (big-endian) form and is reversed into
  // the VM little-endian script hash inside the signed message.
  assert.equal(
    __buildCanonicalFeedMessageForTests({
      contractHash: '0x00112233445566778899aabbccddeeff00112233',
      networkMagic: 894710606,
      storagePair: 'TWELVEDATA:NEO-USD',
      priceUnits: '2710000',
      timestampSec: '1700000000',
      roundId: '7',
      attestationHash: '0xaabbccdd',
      sourceSetId: '9',
    }),
    '6d6f7270686575732d64617461666565642d763233221100ffeeddccbbaa998877665544332211004e335435' +
      '125457454c5645444154413a4e454f2d55534407323731303030300a313730303030303030300137' +
      '04aabbccdd0139'
  );
});

test('buildFeedUpdateInvocation routes a signed update to updateFeedSigned (C1)', () => {
  const baseParams = [
    { type: 'String', value: 'TWELVEDATA:NEO-USD' },
    { type: 'Integer', value: '7' },
    { type: 'Integer', value: '2710000' },
    { type: 'Integer', value: '1700000000' },
    { type: 'ByteArray', value: '' },
    { type: 'Integer', value: '0' },
  ];

  // Unsigned (no verification key configured) → the unchanged 6-arg updateFeed.
  const unsigned = __buildFeedUpdateInvocationForTests(baseParams, null);
  assert.equal(unsigned.method, 'updateFeed');
  assert.equal(unsigned.params.length, 6);

  // Signed → the 7-arg updateFeedSigned with the signature appended as a ByteArray.
  const signed = __buildFeedUpdateInvocationForTests(baseParams, { signature: '0xdeadbeef' });
  assert.equal(signed.method, 'updateFeedSigned');
  assert.equal(signed.params.length, 7);
  assert.deepEqual(signed.params[6], { type: 'ByteArray', value: '0xdeadbeef' });
  // The base params are unchanged.
  assert.deepEqual(signed.params.slice(0, 6), baseParams);

  // A signed envelope with an empty signature is treated as unsigned.
  const emptySig = __buildFeedUpdateInvocationForTests(baseParams, { signature: '' });
  assert.equal(emptySig.method, 'updateFeed');
});

test('handleOracleFeed does not write a canonical AGG record for duplicated providers (C2)', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'morpheus-feed-dup-provider-'));
  process.env.MORPHEUS_FEED_STATE_PATH = path.join(tempDir, 'feed-state.json');
  process.env.MORPHEUS_FEED_BOOTSTRAP_SUPABASE_ENABLED = 'false';
  process.env.MORPHEUS_FEED_SNAPSHOT_SUPABASE_ENABLED = 'false';
  // The misconfiguration: the same provider listed twice.
  process.env.MORPHEUS_FEED_PROVIDERS = 'twelvedata,twelvedata';
  process.env.TWELVEDATA_API_KEY = 'test-twelvedata-key';
  process.env.MORPHEUS_NETWORK = 'mainnet';
  process.env.MORPHEUS_ALLOW_UNPINNED_SIGNERS = 'true';
  delete process.env.CONTRACT_PRICEFEED_HASH;
  delete process.env.CONTRACT_MORPHEUS_DATAFEED_HASH;
  __resetProviderRuntimeCachesForTests();

  let twelvedataCalls = 0;
  global.fetch = async (url) => {
    const value = String(url);
    if (!value.includes('api.twelvedata.com')) {
      throw new Error(`unexpected fetch ${value}`);
    }
    twelvedataCalls += 1;
    return new Response(JSON.stringify({ price: '2.700' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const response = await handleOracleFeed({
    network: 'mainnet',
    target_chain: 'neo_n3',
    symbols: ['NEO-USD'],
    force: true,
  });
  const body = await response.json();
  assert.equal(response.status, 200);

  // The duplicated provider collapses to a single fetch (upstream dedup) and no
  // multi-source aggregation is surfaced.
  assert.equal(twelvedataCalls, 1, 'duplicated provider must not fan out into two fetches');
  assert.ok(!body.aggregations, 'no aggregation from a single distinct source');

  const state = await __loadFeedStateForTests({ network: 'mainnet', targetChain: 'neo_n3' });
  assert.equal(
    state.records[buildCanonicalAggregateStorageKey('NEO-USD')],
    undefined,
    'no canonical AGG record from a duplicated provider'
  );
  assert.ok(
    !body.sync_results.some((entry) => entry.relay_status === 'aggregated'),
    'no aggregated sync result from a duplicated provider'
  );
});

test('handleOracleFeed does not write a canonical AGG record for a single provider (C2)', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'morpheus-feed-no-agg-'));
  process.env.MORPHEUS_FEED_STATE_PATH = path.join(tempDir, 'feed-state.json');
  process.env.MORPHEUS_FEED_BOOTSTRAP_SUPABASE_ENABLED = 'false';
  process.env.MORPHEUS_FEED_SNAPSHOT_SUPABASE_ENABLED = 'false';
  process.env.MORPHEUS_FEED_PROVIDERS = 'twelvedata';
  process.env.TWELVEDATA_API_KEY = 'test-twelvedata-key';
  process.env.MORPHEUS_NETWORK = 'mainnet';
  process.env.MORPHEUS_ALLOW_UNPINNED_SIGNERS = 'true';
  delete process.env.CONTRACT_PRICEFEED_HASH;
  delete process.env.CONTRACT_MORPHEUS_DATAFEED_HASH;
  __resetProviderRuntimeCachesForTests();

  global.fetch = async (url) => {
    const value = String(url);
    if (!value.includes('api.twelvedata.com')) {
      throw new Error(`unexpected fetch ${value}`);
    }
    return new Response(JSON.stringify({ price: '2.700' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const response = await handleOracleFeed({
    network: 'mainnet',
    target_chain: 'neo_n3',
    symbols: ['NEO-USD'],
    force: true,
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.ok(!body.aggregations, 'no aggregation for a single source');

  const state = await __loadFeedStateForTests({ network: 'mainnet', targetChain: 'neo_n3' });
  assert.equal(
    state.records[buildCanonicalAggregateStorageKey('NEO-USD')],
    undefined,
    'no canonical record from a single provider'
  );
  assert.ok(
    !body.sync_results.some((entry) => entry.relay_status === 'aggregated'),
    'no aggregated sync result for a single provider'
  );
});
