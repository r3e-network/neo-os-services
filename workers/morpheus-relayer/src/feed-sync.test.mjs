import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  buildFeedSyncPayload,
  processFeedSync,
  summarizeFeedSyncChainResult,
} from './feed-sync.js';
import { createEmptyRelayerState } from './state.js';

test('feed sync payload does not inject relayer/updater signer material', () => {
  const payload = buildFeedSyncPayload(
    {
      network: 'mainnet',
      feedSync: {
        symbols: ['TWELVEDATA:NEO-USD'],
        projectSlug: 'morpheus',
        projectConfigEnabled: false,
        changeThresholdBps: '10',
        minUpdateIntervalMs: '60000',
        staleAfterMs: '300000',
        providers: ['twelvedata'],
      },
      neo_n3: {
        updaterPrivateKey: '0x'.padEnd(66, '1'),
        updaterWif: 'L'.padEnd(52, '1'),
      },
    },
    'neo_n3'
  );

  assert.equal(payload.target_chain, 'neo_n3');
  assert.equal(payload.network, 'mainnet');
  assert.equal(payload.private_key, undefined);
  assert.equal(payload.wif, undefined);
  assert.equal(payload.project_slug, undefined);
});

test('feed sync project config lookup is opt-in', () => {
  const payload = buildFeedSyncPayload(
    {
      network: 'mainnet',
      feedSync: {
        symbols: ['NEO-USD'],
        projectSlug: 'morpheus',
        projectConfigEnabled: true,
        changeThresholdBps: '10',
        minUpdateIntervalMs: '60000',
        staleAfterMs: '300000',
        provider: 'twelvedata',
      },
    },
    'neo_n3'
  );

  assert.equal(payload.project_slug, 'morpheus');
});

test('feed sync submission waiting is opt-in', () => {
  const payload = buildFeedSyncPayload(
    {
      network: 'mainnet',
      feedSync: {
        symbols: ['NEO-USD'],
        waitForSubmission: true,
        timeoutMs: 30000,
        changeThresholdBps: '10',
        minUpdateIntervalMs: '60000',
        staleAfterMs: '300000',
        provider: 'twelvedata',
      },
    },
    'neo_n3'
  );

  assert.equal(payload.wait, true);
  assert.equal(payload.feed_submission_wait_timeout_ms, 30000);
});

test('feed sync summary marks fast acknowledgements as accepted', () => {
  const summary = summarizeFeedSyncChainResult({
    target_chain: 'neo_n3',
    api_url: 'http://worker',
    ok: true,
    status: 202,
    body: { accepted: true, network: 'mainnet', request_id: 'pricefeed:test' },
  });

  assert.equal(summary.publication_state, 'accepted');
  assert.equal(summary.error_count, 0);
});

test('feed sync marks HTTP 200 worker payload errors as failed syncs', async () => {
  const originalFetch = global.fetch;
  const stateFile = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'feed-sync-state-')),
    'state.json'
  );
  const state = createEmptyRelayerState();
  const config = {
    stateFile,
    network: 'mainnet',
    activeChains: ['neo_n3'],
    nitro: {
      apiUrl: 'https://worker.test',
      token: '',
      timeoutMs: 1000,
    },
    feedSync: {
      enabled: true,
      intervalMs: 0,
      timeoutMs: 1000,
      symbols: ['NEO-USD'],
      provider: 'twelvedata',
      providers: [],
      changeThresholdBps: '10',
      minUpdateIntervalMs: '60000',
      staleAfterMs: '300000',
      projectConfigEnabled: false,
    },
  };

  try {
    global.fetch = async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          network: 'mainnet',
          errors: [{ symbol: 'NEO-USD', errors: [{ message: 'control plane unavailable' }] }],
          sync_results: [],
        }),
    });

    const result = await processFeedSync(config, state, { warn() {} });

    assert.equal(result.chains[0].publication_summary.error_count, 1);
    assert.equal(result.chains[0].publication_summary.publication_state, 'error');
    assert.equal(state.metrics.feed_sync_error_total, 1);
    assert.equal(state.metrics.feed_sync_success_total, 0);
    assert.equal(state.metrics.last_feed_sync_success_at, null);
  } finally {
    global.fetch = originalFetch;
  }
});
