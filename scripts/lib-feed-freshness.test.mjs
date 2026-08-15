import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyFeedFreshness,
  FRESHNESS_RPC_PROBE_CONNECT_TIMEOUT_SECONDS,
  FRESHNESS_RPC_PROBE_MAX_TIME_SECONDS,
  FRESHNESS_RPC_PROBE_TIMEOUT_MS,
  loadRuntimeConfigFromEnvFile,
  mergeFreshnessRpcUrls,
  normalizeFeedStoragePair,
  parseConfiguredFeedPairs,
  selectFreshnessRpcUrlsForPair,
} from './lib-feed-freshness.mjs';

test('normalizeFeedStoragePair prefixes bare symbols with TWELVEDATA', () => {
  assert.equal(normalizeFeedStoragePair('NEO-USD'), 'TWELVEDATA:NEO-USD');
  assert.equal(normalizeFeedStoragePair('TWELVEDATA:BTC-USD'), 'TWELVEDATA:BTC-USD');
});

test('freshness RPC probes use short timeouts so unhealthy endpoints do not stall heartbeats', () => {
  assert.equal(FRESHNESS_RPC_PROBE_CONNECT_TIMEOUT_SECONDS, '5');
  assert.equal(FRESHNESS_RPC_PROBE_MAX_TIME_SECONDS, '8');
  assert.equal(FRESHNESS_RPC_PROBE_TIMEOUT_MS, 10_000);
});

test('parseConfiguredFeedPairs normalizes configured feed symbols', () => {
  assert.deepEqual(
    parseConfiguredFeedPairs({ MORPHEUS_FEED_SYMBOLS: 'NEO-USD,TWELVEDATA:GAS-USD' }),
    ['TWELVEDATA:NEO-USD', 'TWELVEDATA:GAS-USD']
  );
});

test('runtime config can be supplied explicitly for read-only audits without a local env file', async () => {
  const previous = process.env.MORPHEUS_RUNTIME_CONFIG_JSON;
  process.env.MORPHEUS_RUNTIME_CONFIG_JSON = JSON.stringify({
    MORPHEUS_FEED_SYMBOLS: 'TWELVEDATA:NEO-USD',
  });
  try {
    assert.deepEqual(
      await loadRuntimeConfigFromEnvFile('/tmp/morpheus-runtime-config-does-not-exist.env'),
      { MORPHEUS_FEED_SYMBOLS: 'TWELVEDATA:NEO-USD' }
    );
  } finally {
    if (previous === undefined) delete process.env.MORPHEUS_RUNTIME_CONFIG_JSON;
    else process.env.MORPHEUS_RUNTIME_CONFIG_JSON = previous;
  }
});

test('classifyFeedFreshness marks old observations stale', () => {
  const nowMs = Date.parse('2026-04-13T05:00:00.000Z');
  assert.deepEqual(classifyFeedFreshness('1776045014', nowMs, 180, 'TWELVEDATA:NEO-USD'), {
    iso: '2026-04-13T01:50:14.000Z',
    age_min: 190,
    cadence: 'continuous',
    threshold_min: 180,
    stale: true,
  });
  assert.deepEqual(classifyFeedFreshness('1776052214', nowMs, 180, 'TWELVEDATA:NEO-USD'), {
    iso: '2026-04-13T03:50:14.000Z',
    age_min: 70,
    cadence: 'continuous',
    threshold_min: 180,
    stale: false,
  });
});

test('classifyFeedFreshness treats sub-12h observations as fresh under the default operator threshold', () => {
  const nowMs = Date.parse('2026-04-13T12:00:00.000Z');
  assert.deepEqual(classifyFeedFreshness('1776053621', nowMs, 720, 'TWELVEDATA:CNY-USD'), {
    iso: '2026-04-13T04:13:41.000Z',
    age_min: 466,
    cadence: 'market_hours',
    threshold_min: 1440,
    stale: false,
  });
});

test('mergeFreshnessRpcUrls excludes unhealthy fallback RPCs once reachable URLs are known', () => {
  assert.deepEqual(
    mergeFreshnessRpcUrls(
      ['http://seed1.neo.org:10332'],
      [
        'https://api.n3index.dev/mainnet',
        'http://seed1.neo.org:10332',
        'https://mainnet1.neo.coz.io:443',
      ]
    ),
    ['http://seed1.neo.org:10332']
  );
});

test('mergeFreshnessRpcUrls prefers stable public seed RPCs over intermittent HTTPS RPCs', () => {
  assert.deepEqual(
    mergeFreshnessRpcUrls(['https://mainnet1.neo.coz.io:443', 'http://seed2.neo.org:10332'], []),
    ['http://seed2.neo.org:10332', 'https://mainnet1.neo.coz.io:443']
  );
});

test('selectFreshnessRpcUrlsForPair keeps the same healthy RPC priority for every pair', () => {
  assert.deepEqual(
    selectFreshnessRpcUrlsForPair([
      'http://seed1.neo.org:10332',
      'https://mainnet1.neo.coz.io:443',
    ]),
    ['http://seed1.neo.org:10332', 'https://mainnet1.neo.coz.io:443']
  );
});
