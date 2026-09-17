import test from 'node:test';
import assert from 'node:assert/strict';

import {
  __resetProviderRuntimeCachesForTests,
  __getProviderCacheSizesForTests,
  __setCappedCacheEntryForTests,
  __cacheHasKeyForTests,
  fetchProviderJSON,
  listBuiltinProviders,
} from './providers.js';

const originalFetch = global.fetch;
const originalProviderCacheTtl = process.env.MORPHEUS_PROVIDER_RESPONSE_CACHE_TTL_MS;
const originalProviderRetries = process.env.MORPHEUS_PROVIDER_FETCH_RETRIES;

test.afterEach(() => {
  global.fetch = originalFetch;
  __resetProviderRuntimeCachesForTests();
  if (originalProviderCacheTtl === undefined) {
    delete process.env.MORPHEUS_PROVIDER_RESPONSE_CACHE_TTL_MS;
  } else {
    process.env.MORPHEUS_PROVIDER_RESPONSE_CACHE_TTL_MS = originalProviderCacheTtl;
  }
  if (originalProviderRetries === undefined) {
    delete process.env.MORPHEUS_PROVIDER_FETCH_RETRIES;
  } else {
    process.env.MORPHEUS_PROVIDER_FETCH_RETRIES = originalProviderRetries;
  }
});

test('fetchProviderJSON reuses a short-lived cached GET response for identical provider requests', async () => {
  process.env.MORPHEUS_PROVIDER_RESPONSE_CACHE_TTL_MS = '5000';
  process.env.MORPHEUS_PROVIDER_FETCH_RETRIES = '0';

  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ price: '12.34' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const request = {
    provider: 'twelvedata',
    pair: 'NEO-USD',
    method: 'GET',
    url: 'https://api.twelvedata.com/price?symbol=NEO/USD&apikey=secret-key',
    headers: {},
    auth_mode: 'query',
  };

  const first = await fetchProviderJSON(request, 2500);
  const second = await fetchProviderJSON(request, 2500);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(calls, 1);
  assert.deepEqual(second.data, { price: '12.34' });
});

test('fetchProviderJSON retries transient upstream failures before succeeding', async () => {
  process.env.MORPHEUS_PROVIDER_RESPONSE_CACHE_TTL_MS = '0';
  process.env.MORPHEUS_PROVIDER_FETCH_RETRIES = '2';

  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify({ error: 'temporary overload' }), {
        status: 503,
        headers: { 'content-type': 'application/json', 'retry-after': '0' },
      });
    }
    return new Response(JSON.stringify({ price: '42.00' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const result = await fetchProviderJSON(
    {
      provider: 'coinbase-spot',
      pair: 'NEO-USD',
      method: 'GET',
      url: 'https://api.coinbase.com/v2/prices/NEO-USD/spot',
      headers: {},
      auth_mode: 'none',
    },
    2500
  );

  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(calls, 2);
  assert.equal(result.data?.price, '42.00');
});

test('fetchProviderJSON refuses redirects on the final provider request', async () => {
  process.env.MORPHEUS_PROVIDER_RESPONSE_CACHE_TTL_MS = '0';
  process.env.MORPHEUS_PROVIDER_FETCH_RETRIES = '0';
  let observedRedirect;
  global.fetch = async (_url, init = {}) => {
    observedRedirect = init.redirect;
    return new Response(JSON.stringify({ price: '11.11' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const result = await fetchProviderJSON(
    {
      provider: 'coinbase-spot',
      pair: 'NEO-USD',
      method: 'GET',
      url: 'https://api.coinbase.com/v2/prices/NEO-USD/spot',
      headers: {},
      auth_mode: 'none',
    },
    2500
  );
  assert.equal(result.ok, true);
  assert.equal(observedRedirect, 'error');
});

test('provider caches evict oldest entries when above the size ceiling (C2)', () => {
  __resetProviderRuntimeCachesForTests();
  const max = 5;
  const future = Date.now() + 60_000;
  for (let i = 0; i < max + 20; i += 1) {
    __setCappedCacheEntryForTests('response', `key-${i}`, { expiresAt: future, value: i }, max);
  }
  const sizes = __getProviderCacheSizesForTests();
  assert.equal(sizes.response, max, 'response cache must be bounded at the ceiling');
  // Oldest keys are evicted first (insertion order), newest survive.
  assert.equal(__cacheHasKeyForTests('response', 'key-0'), false);
  assert.equal(__cacheHasKeyForTests('response', `key-${max + 19}`), true);
  __resetProviderRuntimeCachesForTests();
});

test('provider cache eviction drops expired entries before fresh ones (C2)', () => {
  __resetProviderRuntimeCachesForTests();
  const max = 3;
  const past = Date.now() - 1;
  const future = Date.now() + 60_000;
  // Seed the cache full of already-expired entries.
  __setCappedCacheEntryForTests('config', 'stale-a', { expiresAt: past, value: 'a' }, max);
  __setCappedCacheEntryForTests('config', 'stale-b', { expiresAt: past, value: 'b' }, max);
  __setCappedCacheEntryForTests('config', 'stale-c', { expiresAt: past, value: 'c' }, max);
  // A fresh insert over the cap should reclaim expired slots, keeping the fresh key.
  __setCappedCacheEntryForTests('config', 'fresh', { expiresAt: future, value: 'fresh' }, max);
  assert.equal(__getProviderCacheSizesForTests().config <= max, true);
  assert.equal(__cacheHasKeyForTests('config', 'fresh'), true);
  __resetProviderRuntimeCachesForTests();
});

test('re-setting an existing cache key refreshes recency without growing size (C2)', () => {
  __resetProviderRuntimeCachesForTests();
  const max = 3;
  const future = Date.now() + 60_000;
  __setCappedCacheEntryForTests('response', 'a', { expiresAt: future, value: 1 }, max);
  __setCappedCacheEntryForTests('response', 'b', { expiresAt: future, value: 2 }, max);
  __setCappedCacheEntryForTests('response', 'c', { expiresAt: future, value: 3 }, max);
  // Touch 'a' so it becomes the most-recent, then overflow to evict the oldest ('b').
  __setCappedCacheEntryForTests('response', 'a', { expiresAt: future, value: 11 }, max);
  __setCappedCacheEntryForTests('response', 'd', { expiresAt: future, value: 4 }, max);
  assert.equal(__getProviderCacheSizesForTests().response, max);
  assert.equal(__cacheHasKeyForTests('response', 'a'), true, 'recently-touched key survives');
  assert.equal(__cacheHasKeyForTests('response', 'b'), false, 'oldest key is evicted');
  __resetProviderRuntimeCachesForTests();
});

test('builtin provider catalog exposes kernel lane compatibility metadata', () => {
  const providers = listBuiltinProviders();
  assert.ok(Array.isArray(providers));
  assert.ok(providers.length >= 5);
  for (const provider of providers) {
    assert.ok(Array.isArray(provider.supports));
    assert.ok(Array.isArray(provider.kernel_supports));
    assert.ok(provider.kernel_supports.includes('oracle.fetch'));
    assert.ok(provider.kernel_supports.includes('feed.publish'));
  }
});

test('public NEO/GAS providers are present without credentials', async () => {
  const { buildProviderRequest } = await import('./providers.js');
  const neo = buildProviderRequest({ provider: 'coingecko', symbol: 'NEO-USD' });
  const gas = buildProviderRequest({ provider: 'coinpaprika', symbol: 'GAS-USD' });
  assert.equal(neo.url, 'https://api.coingecko.com/api/v3/simple/price?ids=neo&vs_currencies=usd');
  assert.equal(gas.url, 'https://api.coinpaprika.com/v1/tickers/gas-gas');
  assert.equal(neo.auth_mode, 'none');
  assert.equal(gas.auth_mode, 'none');
});

test('fetchProviderJSON blocks private/internal hosts when the unsafe base-URL override is enabled (finding 18)', async () => {
  const original = process.env.MORPHEUS_ALLOW_UNSAFE_PROVIDER_BASE_URL_OVERRIDE;
  process.env.MORPHEUS_ALLOW_UNSAFE_PROVIDER_BASE_URL_OVERRIDE = 'true';
  try {
    for (const url of [
      'http://169.254.169.254/latest/meta-data/', // cloud metadata
      'http://127.0.0.1:8080/api/v3/ticker/price',
      'http://[::1]/x',
      'http://10.0.0.5/x',
    ]) {
      await assert.rejects(
        fetchProviderJSON({ provider: 'binance-spot', url, method: 'GET' }, 2000),
        /private\/internal URLs not allowed/,
        url
      );
    }
  } finally {
    if (original === undefined) {
      delete process.env.MORPHEUS_ALLOW_UNSAFE_PROVIDER_BASE_URL_OVERRIDE;
    } else {
      process.env.MORPHEUS_ALLOW_UNSAFE_PROVIDER_BASE_URL_OVERRIDE = original;
    }
  }
});
