import test from 'node:test';
import assert from 'node:assert/strict';

import worker from './worker.mjs';

function createEnv(overrides = {}) {
  return {
    MORPHEUS_ORIGIN_URL: 'https://origin.test',
    MORPHEUS_MAINNET_ORIGIN_URL: 'https://origin.test/mainnet',
    MORPHEUS_TESTNET_ORIGIN_URL: 'https://origin.test/testnet',
    MORPHEUS_MAINNET_FEED_ORIGIN_URL: 'https://feed-origin.test/mainnet',
    MORPHEUS_TESTNET_FEED_ORIGIN_URL: 'https://feed-origin.test/testnet',
    MORPHEUS_ORIGIN_TOKEN: 'origin-secret',
    ...overrides,
  };
}

function createCtx() {
  return {
    waitUntil() {},
  };
}

function createCaches() {
  return {
    default: {
      async match() {
        return null;
      },
      async put() {},
    },
  };
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const originalFetch = global.fetch;
const originalCaches = global.caches;

test.afterEach(() => {
  global.fetch = originalFetch;
  global.caches = originalCaches;
});

test('edge gateway serves the public runtime catalog without origin fetch', async () => {
  let fetchCalls = 0;
  global.fetch = async () => {
    fetchCalls += 1;
    throw new Error('origin fetch should not happen for runtime catalog');
  };
  global.caches = createCaches();

  const response = await worker.fetch(
    new Request('https://oracle.meshmini.app/testnet/api/runtime/catalog'),
    createEnv(),
    createCtx()
  );

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.envelope.version, '2026-04-tee-v1');
  assert.equal(
    payload.networks.testnet.morpheus.publicApiUrl,
    'https://oracle.meshmini.app/testnet'
  );
  assert.ok(payload.workflows.some((item) => item.id === 'automation.upkeep'));
  assert.equal(fetchCalls, 0);
});

test('edge gateway rejects a mainnet runtime exposed through the testnet health lane', async () => {
  global.fetch = async () =>
    jsonResponse(200, {
      status: 'ok',
      ready: true,
      runtime: 'morpheus-enclave-server',
      network: 'mainnet',
    });
  global.caches = createCaches();

  const response = await worker.fetch(
    new Request('https://oracle.meshmini.app/testnet/health'),
    createEnv(),
    createCtx()
  );

  assert.equal(response.status, 503);
  assert.equal(response.headers.get('x-morpheus-network'), 'testnet');
  const payload = await response.json();
  assert.equal(payload.status, 'degraded');
  assert.equal(payload.ready, false);
  assert.equal(payload.error, 'runtime_network_mismatch');
  assert.equal(payload.requested_network, 'testnet');
  assert.equal(payload.actual_network, 'mainnet');
});

test('edge gateway keeps a matching runtime health response available and cacheable', async () => {
  const cached = [];
  global.fetch = async () =>
    jsonResponse(200, {
      status: 'ok',
      ready: true,
      runtime: 'morpheus-enclave-server',
      network: 'testnet',
    });
  global.caches = {
    default: {
      async match() {
        return null;
      },
      put(_request, response) {
        cached.push(response);
      },
    },
  };

  const response = await worker.fetch(
    new Request('https://oracle.meshmini.app/testnet/health'),
    createEnv(),
    createCtx()
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'public, max-age=15');
  assert.equal((await response.json()).network, 'testnet');
  assert.equal(cached.length, 1);
});

test('edge gateway serves runtime status from origin health and info probes', async () => {
  const calls = [];
  global.fetch = async (input, init = {}) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const target = new URL(request.url);
    calls.push({
      path: target.pathname,
      network: target.searchParams.get('network'),
      headers: Object.fromEntries(request.headers.entries()),
    });

    if (target.pathname === '/testnet/api/runtime/health') {
      return jsonResponse(200, { status: 'ok', network: 'testnet' });
    }

    if (target.pathname === '/testnet/api/runtime/info') {
      return jsonResponse(200, {
        version: '1.2.3',
        dstack: {
          app_id: 'app-123',
          compose_hash: 'compose-hash-123',
          client_kind: 'dstack',
        },
      });
    }

    return jsonResponse(404, { error: 'not found', path: target.pathname });
  };
  global.caches = createCaches();

  const response = await worker.fetch(
    new Request('https://oracle.meshmini.app/testnet/api/runtime/status'),
    createEnv(),
    createCtx()
  );

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.deepEqual(
    calls.map((call) => call.path),
    ['/testnet/api/runtime/health', '/testnet/api/runtime/info']
  );
  assert.deepEqual(
    calls.map((call) => call.network),
    ['testnet', 'testnet']
  );
  assert.equal(calls[0].headers.authorization, 'Bearer origin-secret');
  assert.equal(calls[1].headers.authorization, 'Bearer origin-secret');
  assert.equal(payload.catalog.envelope.version, '2026-04-tee-v1');
  assert.equal(payload.catalog.links.catalog, '/api/runtime/catalog');
  assert.equal(payload.runtime.status, 'operational');
  assert.equal(payload.runtime.health.state, 'ok');
  assert.equal(payload.runtime.info.appId, 'app-123');
});

test('edge gateway runtime status fails closed when origin health reports another network', async () => {
  global.fetch = async (input, init = {}) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const target = new URL(request.url);
    if (target.pathname === '/testnet/api/runtime/health') {
      return jsonResponse(200, { status: 'ok', ready: true, network: 'mainnet' });
    }
    if (target.pathname === '/testnet/api/runtime/info') {
      return jsonResponse(200, { version: '1.2.3' });
    }
    return jsonResponse(404, { error: 'not found' });
  };
  global.caches = createCaches();

  const response = await worker.fetch(
    new Request('https://oracle.meshmini.app/testnet/api/runtime/status'),
    createEnv(),
    createCtx()
  );

  assert.equal(response.status, 503);
  const payload = await response.json();
  assert.equal(payload.runtime.status, 'down');
  assert.equal(payload.runtime.health.ok, false);
  assert.equal(payload.runtime.health.statusCode, 503);
  assert.equal(payload.runtime.health.detail, 'runtime_network_mismatch');
});

test('edge gateway blocks raw sensitive runtime-origin routes without trusted credentials', async () => {
  let fetchCalls = 0;
  global.fetch = async () => {
    fetchCalls += 1;
    return jsonResponse(200, { derived: { app_id: 'should-not-leak' } });
  };
  global.caches = createCaches();

  for (const path of [
    '/testnet/runtime/keys/derived',
    '/testnet/keys/derived',
    '/testnet/info',
    '/testnet/oracle/query',
    '/testnet/oracle/smart-fetch',
    '/testnet/compute/execute',
    '/testnet/neodid/bind',
  ]) {
    const response = await worker.fetch(
      new Request(`https://oracle.meshmini.app${path}`),
      createEnv(),
      createCtx()
    );
    assert.equal(response.status, 401, path);
    assert.deepEqual(await response.json(), { error: 'unauthorized' });
  }
  assert.equal(fetchCalls, 0);
});

test('edge gateway returns 503 for retired raw runtime routes even with a trusted token', async () => {
  const calls = [];
  global.fetch = async (input, init = {}) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    calls.push(new URL(request.url).pathname);
    return jsonResponse(200, { derived: { app_id: 'app-123' } });
  };
  global.caches = createCaches();

  const response = await worker.fetch(
    new Request('https://oracle.meshmini.app/testnet/runtime/keys/derived', {
      headers: { authorization: 'Bearer edge-runtime-token' },
    }),
    createEnv({ MORPHEUS_EDGE_RUNTIME_TOKEN: 'edge-runtime-token' }),
    createCtx()
  );

  // The trusted token passes the auth gate, but raw runtime routes (keys/derived,
  // compute, AA) require the retired runtime and are not mapped to the apps/web API
  // -> clean 503, never proxied.
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, 'runtime_route_unavailable');
  assert.equal(calls.length, 0);
});

test('edge gateway returns 503 for the retired oracle feed-publication lane', async () => {
  const calls = [];
  global.fetch = async (input, init = {}) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    calls.push(new URL(request.url).pathname);
    return jsonResponse(200, { mode: 'pricefeed' });
  };
  global.caches = createCaches();

  const response = await worker.fetch(
    new Request('https://oracle.meshmini.app/testnet/oracle/feed', {
      method: 'POST',
      body: JSON.stringify({ symbols: ['TWELVEDATA:NEO-USD'] }),
    }),
    createEnv(),
    createCtx()
  );

  // /oracle/feed was the legacy feed-write lane; feeds are now pushed on-chain by the
  // box, so the edge no longer proxies it.
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, 'runtime_route_unavailable');
  assert.equal(calls.length, 0);
});

// A fetch stub that hangs forever unless its AbortSignal fires (the hung-origin
// failure mode). It resolves to a rejection only when aborted, so the worker's
// AbortSignal.timeout is what frees it — never the stub itself.
function hangingFetch() {
  return (input, init = {}) =>
    new Promise((_resolve, reject) => {
      const signal = init.signal;
      if (signal) {
        if (signal.aborted) {
          reject(signal.reason || new Error('aborted'));
          return;
        }
        signal.addEventListener('abort', () => reject(signal.reason || new Error('aborted')), {
          once: true,
        });
      }
      // No resolve path: the origin "hangs".
    });
}

test('edge gateway fails fast to 503 when a proxied origin hangs (B7)', async () => {
  global.fetch = hangingFetch();
  global.caches = createCaches();

  const startedAt = Date.now();
  const response = await worker.fetch(
    // A mapped public route (proxied to apps/web) exercises the proxy/hang path.
    new Request('https://oracle.meshmini.app/testnet/oracle/public-key'),
    // 1s timeout (clamped floor) keeps the test fast but proves the abort path.
    createEnv({ MORPHEUS_EDGE_ORIGIN_TIMEOUT_MS: '1000' }),
    createCtx()
  );
  const elapsed = Date.now() - startedAt;

  assert.equal(response.status, 503);
  const payload = await response.json();
  assert.equal(payload.error, 'origin_unavailable');
  // Resolved via the timeout, well under Cloudflare's ~30s wall clock.
  assert.ok(elapsed < 5000, `expected fast fail, took ${elapsed}ms`);
});

test('edge gateway runtime status reports "down" fast when origin probes hang (B7)', async () => {
  global.fetch = hangingFetch();
  global.caches = createCaches();

  const startedAt = Date.now();
  const response = await worker.fetch(
    new Request('https://oracle.meshmini.app/testnet/api/runtime/status'),
    createEnv({ MORPHEUS_EDGE_PROBE_TIMEOUT_MS: '1000' }),
    createCtx()
  );
  const elapsed = Date.now() - startedAt;

  // Both probes time out -> snapshot resolves to down (503) instead of stalling.
  assert.equal(response.status, 503);
  const payload = await response.json();
  assert.equal(payload.runtime.status, 'down');
  assert.ok(elapsed < 5000, `expected fast fail, took ${elapsed}ms`);
});

// --- A4: rate-limit backend failure fails closed with 503 ---

test('edge gateway fails closed with 503 when the Upstash rate-limit backend 5xxs (A4)', async () => {
  let pipelineCalls = 0;
  global.fetch = async (input, init = {}) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const target = new URL(request.url);
    // The shared rate-limit helper posts to <upstash>/pipeline; simulate an
    // Upstash outage (5xx) which makes applyUpstashRateLimit throw.
    if (target.pathname.endsWith('/pipeline')) {
      pipelineCalls += 1;
      return jsonResponse(503, { error: 'service unavailable' });
    }
    throw new Error(`origin fetch should not be reached on rate-limit backend failure: ${target}`);
  };
  global.caches = createCaches();

  const response = await worker.fetch(
    // /vrf/random maps to the rate-limited 'vrf' route, is not runtime-auth
    // gated, and turnstile is disabled (no TURNSTILE_WORKER_SECRET).
    new Request('https://oracle.meshmini.app/testnet/vrf/random', { method: 'POST' }),
    createEnv({
      UPSTASH_REDIS_REST_URL: 'https://upstash.test',
      UPSTASH_REDIS_REST_TOKEN: 'upstash-token',
    }),
    createCtx()
  );

  assert.equal(response.status, 503);
  const payload = await response.json();
  assert.equal(payload.error, 'rate_limit_backend_unavailable');
  assert.equal(payload.route, 'vrf');
  assert.equal(pipelineCalls, 1);
});

// --- A3-edge: constant-time trusted-token compare ---

test('edge gateway accepts a valid trusted token and rejects an equal-length mismatch (A3-edge)', async () => {
  const calls = [];
  global.fetch = async (input, init = {}) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    calls.push(new URL(request.url).pathname);
    return jsonResponse(200, { derived: { app_id: 'app-123' } });
  };
  global.caches = createCaches();

  // The configured token; a runtime-auth-gated route exercises the trusted
  // token check (isTrustedAutomationRequest).
  const token = 'edge-runtime-token-1234567890';
  const env = createEnv({ MORPHEUS_EDGE_RUNTIME_TOKEN: token });

  const ok = await worker.fetch(
    new Request('https://oracle.meshmini.app/testnet/runtime/keys/derived', {
      headers: { authorization: `Bearer ${token}` },
    }),
    env,
    createCtx()
  );
  // Valid token PASSES the constant-time auth gate; the raw runtime route itself is
  // retired, so it resolves to 503 (not 401) — proving auth accepted the token.
  assert.equal(ok.status, 503);
  assert.equal((await ok.json()).error, 'runtime_route_unavailable');
  assert.equal(calls.length, 0);

  // Equal-length-but-different token must be REJECTED at auth (401), distinct from
  // the accepted-token 503 above — constant-time compare does not early-accept on a
  // length match.
  const wrong = token.slice(0, -1) + (token.endsWith('X') ? 'Y' : 'X');
  assert.equal(wrong.length, token.length);
  const denied = await worker.fetch(
    new Request('https://oracle.meshmini.app/testnet/runtime/keys/derived', {
      headers: { authorization: `Bearer ${wrong}` },
    }),
    env,
    createCtx()
  );
  assert.equal(denied.status, 401);
  assert.deepEqual(await denied.json(), { error: 'unauthorized' });
  assert.equal(calls.length, 0);
});

// --- F10-edge: x-morpheus-runtime discriminator + catalog-derived capabilities ---

test('edge gateway runtime status surfaces the origin runtime discriminator and catalog capabilities (F10)', async () => {
  global.fetch = async (input, init = {}) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const target = new URL(request.url);
    if (target.pathname === '/testnet/api/runtime/health') {
      return new Response(JSON.stringify({ status: 'ok', network: 'testnet' }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-morpheus-runtime': 'tee-box-runtime',
        },
      });
    }
    if (target.pathname === '/testnet/api/runtime/info') {
      return new Response(JSON.stringify({ version: '1.0.0', dstack: { app_id: 'app-123' } }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-morpheus-runtime': 'tee-box-runtime',
        },
      });
    }
    return jsonResponse(404, { error: 'not found', path: target.pathname });
  };
  global.caches = createCaches();

  const response = await worker.fetch(
    new Request('https://oracle.meshmini.app/testnet/api/runtime/status'),
    createEnv(),
    createCtx()
  );

  assert.equal(response.status, 200);
  // Discriminator header travels with the response.
  assert.equal(response.headers.get('x-morpheus-runtime'), 'tee-box-runtime');
  const payload = await response.json();
  assert.equal(payload.runtime.origin, 'tee-box-runtime');
  // Capabilities are derived from the shared catalog (single source of truth).
  assert.equal(payload.runtime.capabilities.catalogVersion, '2026-04-tee-v1');
  assert.equal(payload.runtime.capabilities.teeRequired, true);
  assert.ok(payload.runtime.capabilities.workflowIds.includes('oracle.query'));
  assert.ok(payload.runtime.capabilities.capabilityIds.includes('oracle_query'));
  assert.deepEqual(payload.runtime.capabilities.automationTriggerKinds, ['interval', 'threshold']);
});

test('edge gateway runtime status reports an unknown discriminator when the origin omits the header (F10)', async () => {
  global.fetch = async (input, init = {}) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const target = new URL(request.url);
    if (target.pathname === '/testnet/api/runtime/health') {
      return jsonResponse(200, { status: 'ok', network: 'testnet' });
    }
    if (target.pathname === '/testnet/api/runtime/info') {
      return jsonResponse(200, { version: '1.0.0', dstack: { app_id: 'app-123' } });
    }
    return jsonResponse(404, { error: 'not found' });
  };
  global.caches = createCaches();

  const response = await worker.fetch(
    new Request('https://oracle.meshmini.app/testnet/api/runtime/status'),
    createEnv(),
    createCtx()
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-morpheus-runtime'), 'unknown');
  const payload = await response.json();
  assert.equal(payload.runtime.origin, null);
});

// Regression for the 2026-08 staleness fix: the origin marks a stale quote
// `cache-control: no-store` + `x-morpheus-feed-stale: 1` and deliberately keeps
// HTTP 200 so the diagnostic body stays readable. The edge previously keyed its
// caching off `response.ok` alone, so it overwrote that with
// `public, max-age=15` AND `cache.put`, pinning a stale price at the edge — the
// exact thing the origin change exists to prevent.
test('edge gateway does not cache a stale feed quote the origin marked no-store', async () => {
  let cachePutCalls = 0;
  global.caches = {
    default: {
      async match() {
        return null;
      },
      async put() {
        cachePutCalls += 1;
      },
    },
  };
  global.fetch = async () =>
    new Response(
      JSON.stringify({
        status: 'stale',
        degraded: true,
        symbol: 'TWELVEDATA:BTC-USD',
        error_code: 'FEED_QUOTE_STALE',
        age_seconds: 279681,
      }),
      {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'cache-control': 'no-store',
          'x-morpheus-feed-stale': '1',
        },
      }
    );

  const response = await worker.fetch(
    new Request('https://edge.test/testnet/feeds/price/TWELVEDATA:BTC-USD'),
    createEnv(),
    createCtx()
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-morpheus-feed-stale'), '1');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(cachePutCalls, 0);
});

test('edge gateway still caches a fresh feed quote for its configured ttl', async () => {
  let cachePutCalls = 0;
  global.caches = {
    default: {
      async match() {
        return null;
      },
      async put() {
        cachePutCalls += 1;
      },
    },
  };
  global.fetch = async () =>
    new Response(JSON.stringify({ status: 'ok', symbol: 'TWELVEDATA:BTC-USD', price: 72001.79 }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'public, max-age=15',
        'x-morpheus-feed-stale': '0',
      },
    });

  const response = await worker.fetch(
    new Request('https://edge.test/mainnet/feeds/price/TWELVEDATA:BTC-USD'),
    createEnv(),
    createCtx()
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'public, max-age=15');
  assert.equal(cachePutCalls, 1);
});
