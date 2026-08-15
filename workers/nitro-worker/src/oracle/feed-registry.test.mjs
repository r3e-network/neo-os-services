import test from 'node:test';
import assert from 'node:assert/strict';

import {
  __resetFeedRegistryCacheForTests,
  getDefaultFeedSymbols,
  getFeedPairConfig,
  getFeedPairRegistry,
} from './feed-registry.js';

const originalRegistryJson = process.env.MORPHEUS_FEED_PAIR_REGISTRY_JSON;

test.afterEach(() => {
  if (originalRegistryJson === undefined) delete process.env.MORPHEUS_FEED_PAIR_REGISTRY_JSON;
  else process.env.MORPHEUS_FEED_PAIR_REGISTRY_JSON = originalRegistryJson;
  __resetFeedRegistryCacheForTests();
});

test('getFeedPairRegistry returns the cached object on repeated calls with the same override', () => {
  delete process.env.MORPHEUS_FEED_PAIR_REGISTRY_JSON;
  __resetFeedRegistryCacheForTests();

  const first = getFeedPairRegistry();
  const second = getFeedPairRegistry();
  assert.equal(first, second, 'repeated calls reuse the memoized registry instance');
});

test('getFeedPairRegistry re-derives when the override string changes', () => {
  delete process.env.MORPHEUS_FEED_PAIR_REGISTRY_JSON;
  __resetFeedRegistryCacheForTests();

  const baseConfig = getFeedPairConfig('NEO-USD');
  assert.equal(baseConfig?.threshold_bps, undefined, 'default NEO-USD has no threshold override');

  process.env.MORPHEUS_FEED_PAIR_REGISTRY_JSON = JSON.stringify({
    'NEO-USD': { threshold_bps: 5 },
  });
  const overridden = getFeedPairConfig('NEO-USD');
  assert.equal(overridden?.threshold_bps, 5, 'changed override is reflected immediately');

  process.env.MORPHEUS_FEED_PAIR_REGISTRY_JSON = JSON.stringify({
    'NEO-USD': { threshold_bps: 7 },
  });
  const reoverridden = getFeedPairConfig('NEO-USD');
  assert.equal(reoverridden?.threshold_bps, 7, 'a different override value re-derives the merge');
});

test('getFeedPairRegistry merges overrides without dropping default pairs', () => {
  const baselineSymbols = (() => {
    delete process.env.MORPHEUS_FEED_PAIR_REGISTRY_JSON;
    __resetFeedRegistryCacheForTests();
    return getDefaultFeedSymbols();
  })();

  process.env.MORPHEUS_FEED_PAIR_REGISTRY_JSON = JSON.stringify({
    'CUSTOM-USD': { providers: { twelvedata: { symbol: 'CUSTOM/USD' } } },
  });
  __resetFeedRegistryCacheForTests();

  const merged = getFeedPairRegistry();
  assert.ok(merged['NEO-USD'], 'default pairs survive the deep merge');
  assert.ok(merged['CUSTOM-USD'], 'override pairs are added');
  assert.equal(
    getDefaultFeedSymbols().length,
    baselineSymbols.length + 1,
    'override adds exactly one new symbol'
  );
});

test('invalid override JSON falls back to the default registry', () => {
  process.env.MORPHEUS_FEED_PAIR_REGISTRY_JSON = '{ not valid json';
  __resetFeedRegistryCacheForTests();

  const registry = getFeedPairRegistry();
  assert.ok(registry['NEO-USD'], 'malformed override does not break the default registry');
});
