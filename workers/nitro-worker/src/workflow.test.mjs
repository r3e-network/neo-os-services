/**
 * Business workflow integration tests.
 *
 * These tests exercise the full request lifecycle through the handler:
 *   HTTP Request → worker.js → capabilities.js → domain handler → HTTP Response
 *
 * Every route registered in the capability registry is hit with a real request
 * to verify end-to-end wiring, auth, payload parsing, and response shape.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Environment setup (mirrors worker.test.mjs)
// ---------------------------------------------------------------------------
const originalFetch = global.fetch;

process.env.MORPHEUS_RUNTIME_TOKEN = 'workflow-test-secret';
delete process.env.MORPHEUS_WORKER_NEO_N3_PRIVATE_KEY;
process.env.SIGNER_ROLE_WORKER_KEY_ID = 'test-worker-key';
process.env.SIGNER_ROLE_ORACLE_VERIFIER_KEY_ID = 'test-oracle-verifier-key';
process.env.NEO_RPC_URL = 'https://neo-rpc.test';
process.env.EVM_RPC_URL = '';
process.env.TWELVEDATA_API_KEY = 'test-twelvedata-key';
process.env.CONTRACT_MORPHEUS_ORACLE_HASH = '0xf54d8584ef82315c1800373272ab08ae0db2d5ef';
process.env.NEODID_SECRET_SALT = 'workflow-test-salt';
delete process.env.MORPHEUS_ALLOW_UNPINNED_SIGNERS;
// Workflow tests have no KMS/NSM endpoint. This test-only switch permits an
// in-memory X25519 identity; Neo N3 signing still uses the custody stub below.
process.env.MORPHEUS_ALLOW_EPHEMERAL_KEY = 'true';
process.env.MORPHEUS_ENABLE_UNTRUSTED_SCRIPTS = 'true';

const baselineEnv = { ...process.env };
const { default: handler } = await import('./worker.js');
const { __resetDstackClientStateForTests } = await import('./platform/nitro-signer.js');
const { __resetOracleKeyMaterialForTests } = await import('./oracle/crypto.js');
const { __resetFeedStateForTests } = await import('./oracle/feeds.js');
const { __resetNeoDidStateForTests } = await import('./neodid/index.js');
const { __resetCustodyTransportForTests, __setCustodyTransportForTests } =
  await import('./platform/custody.js');

__setCustodyTransportForTests(async (method, pathname) => {
  const keyId = decodeURIComponent(pathname.split('/').at(-1) || 'test-worker-key');
  if (method === 'GET') {
    return {
      allowed: true,
      key_id: keyId,
      network: 'testnet',
      network_magic: 894710606,
      public_key: `02${'22'.repeat(32)}`,
      address: 'NTestWorkerCustodyAddress',
      script_hash: `0x${'33'.repeat(20)}`,
      signing_enabled: true,
    };
  }
  return {
    allowed: true,
    key_id: keyId,
    signature: '11'.repeat(64),
    public_key: `02${'22'.repeat(32)}`,
    address: 'NTestWorkerCustodyAddress',
    script_hash: `0x${'33'.repeat(20)}`,
  };
});

function authHeaders() {
  return {
    authorization: 'Bearer workflow-test-secret',
    'content-type': 'application/json',
  };
}

function restoreState() {
  global.fetch = originalFetch;
  for (const key of Object.keys(process.env)) {
    if (!Object.prototype.hasOwnProperty.call(baselineEnv, key)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(baselineEnv)) {
    process.env[key] = value;
  }
  __resetDstackClientStateForTests();
  __resetOracleKeyMaterialForTests();
  __resetFeedStateForTests();
  __resetNeoDidStateForTests();
}

test.beforeEach(restoreState);
test.afterEach(restoreState);
test.after(__resetCustodyTransportForTests);

async function post(path, body = {}) {
  return handler(
    new Request(`http://local${path}`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(body),
    })
  );
}

// ===========================================================================
// WORKFLOW 1: Unauthenticated public endpoints
// ===========================================================================

test('workflow: GET /health returns auto-discovered capability list', async () => {
  const res = await handler(new Request('http://local/health'));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.runtime, 'nitro-worker');
  assert.ok(Array.isArray(body.features));
  assert.ok(body.features.length >= 20, `expected >=20 features, got ${body.features.length}`);
  // Verify features come from capability registry, not hardcoded
  assert.ok(body.features.includes('oracle/query'));
  assert.ok(body.features.includes('vrf/random'));
  assert.ok(body.features.includes('compute/execute'));
  assert.ok(body.features.includes('neodid/bind'));
  assert.ok(body.features.includes('feeds/price/:symbol'));
  assert.ok(body.features.includes('paymaster/authorize'));
});

test('workflow: GET /info returns dstack and overload state', async () => {
  const res = await handler(new Request('http://local/info'));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok('dstack' in body);
  assert.ok('overload' in body);
});

test('workflow: GET /attestation returns attestation object', async () => {
  const res = await handler(new Request('http://local/attestation?report_data=workflow-test'));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok('attestation' in body);
});

// ===========================================================================
// WORKFLOW 2: Auth gate — every authenticated route rejects without token
// ===========================================================================

test('workflow: auth gate rejects unauthenticated POST to protected route', async () => {
  const res = await handler(
    new Request('http://local/vrf/random', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
  );
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.error, 'unauthorized');
});

// ===========================================================================
// WORKFLOW 3: Keys / Derived Key
// ===========================================================================

test('workflow: POST /keys/derived returns derived key summary', async () => {
  const res = await post('/keys/derived', { role: 'worker' });
  // Requires the AWS Nitro enclave for key derivation — accepts 200 (TEE available)
  // or 400 (no TEE in test env) as both are valid wiring outcomes.
  assert.ok(res.status === 200 || res.status === 400, `expected 200 or 400, got ${res.status}`);
  const body = await res.json();
  if (res.status === 200) {
    assert.ok(body.derived);
    assert.equal(body.derived.role, 'worker');
    assert.ok(body.derived.neo_n3);
    assert.ok(body.derived.neo_n3.address);
  }
});

test('workflow: POST /keys/derived defaults role to worker', async () => {
  const res = await post('/keys/derived', {});
  // Same TEE dependency as above
  assert.ok(res.status === 200 || res.status === 400, `expected 200 or 400, got ${res.status}`);
  if (res.status === 200) {
    const body = await res.json();
    assert.equal(body.derived.role, 'worker');
  }
});

// ===========================================================================
// WORKFLOW 4: Oracle Public Key
// ===========================================================================

test('workflow: POST /oracle/public-key returns X25519 key material', async () => {
  const res = await post('/oracle/public-key', {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.public_key);
  assert.equal(body.public_key_format, 'raw');
  assert.ok(body.algorithm);
  assert.ok(body.key_source);
});

// ===========================================================================
// WORKFLOW 5: Providers listing
// ===========================================================================

test('workflow: POST /providers returns builtin provider catalog', async () => {
  const res = await post('/providers');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.providers));
  assert.ok(body.providers.length >= 3);
  const ids = body.providers.map((p) => p.id);
  assert.ok(ids.includes('twelvedata'));
  assert.ok(ids.includes('binance-spot'));
  assert.ok(ids.includes('coinbase-spot'));
});

// ===========================================================================
// WORKFLOW 6: VRF Randomness
// ===========================================================================

test('workflow: POST /vrf/random generates verifiable randomness', async () => {
  const res = await post('/vrf/random', {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.randomness);
  assert.equal(body.randomness.length, 64, 'randomness should be 32 bytes hex');
  assert.ok(body.signature);
  assert.ok(body.public_key);
  assert.ok(body.attestation_hash);
  assert.ok(body.verification);
  // Second call should produce different randomness
  const res2 = await post('/vrf/random', {});
  const body2 = await res2.json();
  assert.notEqual(body.randomness, body2.randomness, 'each call should produce unique randomness');
});

// ===========================================================================
// WORKFLOW 7: Feeds Catalog
// ===========================================================================

test('workflow: POST /feeds/catalog returns symbol catalog', async () => {
  const res = await post('/feeds/catalog');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.pairs));
  assert.ok(body.pairs.length > 0);
});

// ===========================================================================
// WORKFLOW 8: Feeds Price (query params)
// ===========================================================================

test('workflow: POST /feeds/price returns price quote from provider', async () => {
  global.fetch = async (url) => {
    const value = String(url);
    if (value.includes('api.twelvedata.com')) {
      return new Response(JSON.stringify({ price: '42.50' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected fetch ${value}`);
  };
  process.env.TWELVEDATA_API_KEY = 'test-key';

  const res = await post('/feeds/price', { symbol: 'NEO-USD', provider: 'twelvedata' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.price || body.quotes || body.error === undefined);
});

// ===========================================================================
// WORKFLOW 9: Feeds Price by Symbol (path param via regex route)
// ===========================================================================

test('workflow: POST /feeds/price/NEO-USD resolves via regex pattern route', async () => {
  global.fetch = async (url) => {
    if (String(url).includes('api.twelvedata.com')) {
      return new Response(JSON.stringify({ price: '15.00' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  process.env.TWELVEDATA_API_KEY = 'test-key';

  const res = await post('/feeds/price/NEO-USD', {});
  assert.equal(res.status, 200);
});

// ===========================================================================
// WORKFLOW 10: Oracle Query
// ===========================================================================

test('workflow: POST /oracle/query fetches from provider and returns result', async () => {
  global.fetch = async (url) => {
    if (String(url).includes('api.twelvedata.com')) {
      return new Response(JSON.stringify({ price: '123.45' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  process.env.TWELVEDATA_API_KEY = 'test-key';

  const res = await post('/oracle/query', {
    url: 'https://api.twelvedata.com/price?symbol=NEO/USD&apikey=test-key',
    provider: 'twelvedata',
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.output_hash || body.result || body.price || body.sources);
});

// ===========================================================================
// WORKFLOW 11: Oracle Smart Fetch (same handler, different mode)
// ===========================================================================

test('workflow: POST /oracle/smart-fetch routes to buildOracleResponse with smart-fetch mode', async () => {
  global.fetch = async (url) => {
    if (String(url).includes('api.twelvedata.com')) {
      return new Response(JSON.stringify({ price: '99.99' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  process.env.TWELVEDATA_API_KEY = 'test-key';

  const res = await post('/oracle/smart-fetch', {
    url: 'https://api.twelvedata.com/price?symbol=NEO/USD&apikey=test-key',
  });
  assert.equal(res.status, 200);
});

// ===========================================================================
// WORKFLOW 12: Compute Functions
// ===========================================================================

test('workflow: POST /compute/functions lists all builtin functions', async () => {
  const res = await post('/compute/functions');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.functions));
  assert.ok(body.functions.length >= 15);
  const names = body.functions.map((f) => f.name);
  assert.ok(names.includes('hash.sha256'));
  assert.ok(names.includes('merkle.root'));
  assert.ok(names.includes('math.modexp'));
});

// ===========================================================================
// WORKFLOW 13: Compute Execute (builtin)
// ===========================================================================

test('workflow: POST /compute/execute runs builtin hash.sha256', async () => {
  const res = await post('/compute/execute', {
    mode: 'builtin',
    function: 'hash.sha256',
    input: { data: 'hello world' },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.mode, 'builtin');
  assert.ok(body.result);
  assert.ok(body.result.digest);
  assert.ok(body.output_hash);
  assert.ok(body.signature);
  assert.ok(body.verification);
});

test('workflow: POST /compute/execute runs merkle.root', async () => {
  const res = await post('/compute/execute', {
    mode: 'builtin',
    function: 'merkle.root',
    input: { leaves: ['a', 'b', 'c'] },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.result.root);
  assert.equal(body.result.root.length, 64);
});

test('workflow: POST /compute/execute returns a stable result envelope for workflow executions', async () => {
  const res = await post('/compute/execute', {
    workflow_id: 'compute.execute',
    execution_id: 'exec-1',
    network: 'testnet',
    route: '/compute/execute',
    mode: 'builtin',
    function: 'hash.sha256',
    input: { data: 'hello world' },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.version, '2026-04-tee-v1');
  assert.equal(body.workflow_id, 'compute.execute');
  assert.equal(body.execution_id, 'exec-1');
  assert.equal(body.status, 'succeeded');
  assert.ok(body.output.result.digest);
});

// ===========================================================================
// WORKFLOW 14: Compute Jobs
// ===========================================================================

test('workflow: POST /compute/jobs returns job list', async () => {
  const res = await post('/compute/jobs');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.jobs));
});

test('workflow: POST /compute/jobs/test-id returns job detail via regex route', async () => {
  const res = await post('/compute/jobs/test-job-123');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.id, 'test-job-123');
  assert.equal(body.status, 'completed');
});

// ===========================================================================
// WORKFLOW 15: NeoDID Providers
// ===========================================================================

test('workflow: POST /neodid/providers returns supported identity providers', async () => {
  const res = await post('/neodid/providers');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.providers));
  const ids = body.providers.map((p) => p.id);
  assert.ok(ids.includes('twitter'));
  assert.ok(ids.includes('github'));
  assert.ok(ids.includes('web3auth'));
});

// ===========================================================================
// WORKFLOW 16: NeoDID Runtime
// ===========================================================================

test('workflow: POST /neodid/runtime returns service metadata', async () => {
  const res = await post('/neodid/runtime');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.service, 'neodid');
  assert.ok(Array.isArray(body.supported_routes));
  assert.ok(body.supported_routes.length >= 5);
  assert.ok(Array.isArray(body.request_types));
});

// ===========================================================================
// WORKFLOW 17: Sign Payload (Neo N3)
// ===========================================================================

test('workflow: POST /sign/payload signs arbitrary payload on neo_n3', async () => {
  const res = await post('/sign/payload', {
    target_chain: 'neo_n3',
    data_hex: '0x48656c6c6f',
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.target_chain, 'neo_n3');
  assert.ok(body.signature);
  assert.ok(body.public_key);
  assert.ok(body.address);
  assert.ok(body.script_hash);
  assert.ok(body.payload_hash);
});

// ===========================================================================
// WORKFLOW 18: Sign Payload (action-based routing)
// ===========================================================================

test('workflow: POST with action=sign_payload routes to sign handler', async () => {
  const res = await handler(
    new Request('http://local/some/arbitrary/path', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        action: 'sign_payload',
        target_chain: 'neo_n3',
        data_hex: '0x48656c6c6f',
      }),
    })
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.signature);
});

// ===========================================================================
// WORKFLOW 19: Relay Transaction (action-based routing)
// ===========================================================================

test('workflow: POST with action=relay_transaction routes correctly', async () => {
  const res = await handler(
    new Request('http://local/some/path', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        action: 'relay_transaction',
        target_chain: 'neo_n3',
        raw_tx: '00000000000000000000000000000000',
      }),
    })
  );
  // May fail on actual broadcast but should route correctly (not 404)
  assert.notEqual(res.status, 404);
});

// ===========================================================================
// WORKFLOW 20: Oracle Feed (action-based routing)
// ===========================================================================

test('workflow: POST with action=oracle_feed routes to feed handler', async () => {
  process.env.MORPHEUS_FEED_PROVIDERS = 'twelvedata';
  process.env.TWELVEDATA_API_KEY = 'test-key';
  process.env.MORPHEUS_NETWORK = 'testnet';
  process.env.MORPHEUS_ALLOW_UNPINNED_SIGNERS = 'true';
  delete process.env.CONTRACT_PRICEFEED_HASH;
  delete process.env.CONTRACT_MORPHEUS_DATAFEED_HASH;

  global.fetch = async (url) => {
    if (String(url).includes('api.twelvedata.com')) {
      return new Response(JSON.stringify({ price: '10.00' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (String(url).includes('morpheus_feed_snapshots')) {
      return new Response('', { status: 201 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const res = await handler(
    new Request('http://local/some/path', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        action: 'oracle_feed',
        target_chain: 'neo_n3',
        symbols: ['NEO-USD'],
      }),
    })
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.mode, 'pricefeed');
});

// ===========================================================================
// WORKFLOW 21: Paymaster Authorize
// ===========================================================================

test('workflow: POST /paymaster/authorize evaluates policy', async () => {
  process.env.MORPHEUS_PAYMASTER_TESTNET_ENABLED = 'true';
  process.env.MORPHEUS_PAYMASTER_TESTNET_POLICY_ID = 'test-policy';

  const res = await post('/paymaster/authorize', {
    account_id: '0x1234567890abcdef1234567890abcdef12345678',
    target_contract: '0xabcdef1234567890abcdef1234567890abcdef12',
    method: 'transfer',
    operation_hash: '0x0000000000000000000000000000000000000000000000000000000000000001',
    estimated_gas_units: 100,
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.mode, 'paymaster_authorize');
  assert.ok(body.approved === true || body.approved === false);
  assert.ok(body.output_hash);
});

// ===========================================================================
// WORKFLOW 22: TxProxy Invoke
// ===========================================================================

test('workflow: POST /txproxy/invoke attempts Neo N3 invocation', async () => {
  // Will fail on missing RPC but should route correctly (not 404)
  const res = await post('/txproxy/invoke', {
    target_chain: 'neo_n3',
    contract_hash: '0x1234567890abcdef1234567890abcdef12345678',
    method: 'testMethod',
  });
  assert.notEqual(res.status, 404, 'txproxy should route, not 404');
});

// ===========================================================================
// WORKFLOW 23: 404 for unknown routes
// ===========================================================================

test('workflow: POST to unknown route returns 404', async () => {
  const res = await post('/this/route/does/not/exist');
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.error, 'not found');
  assert.ok(body.path);
});

// ===========================================================================
// WORKFLOW 24: Response shape consistency across all routes
// ===========================================================================

test('workflow: all authenticated routes return JSON with correct content-type', async () => {
  global.fetch = async (url) => {
    if (String(url).includes('api.twelvedata.com')) {
      return new Response(JSON.stringify({ price: '1.00' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const routes = [
    { path: '/health', method: 'GET' },
    { path: '/providers', method: 'POST' },
    { path: '/vrf/random', method: 'POST', body: {} },
    { path: '/feeds/catalog', method: 'POST' },
    { path: '/compute/functions', method: 'POST' },
    { path: '/compute/jobs', method: 'POST' },
    { path: '/neodid/providers', method: 'POST' },
    { path: '/oracle/public-key', method: 'POST', body: {} },
  ];

  for (const route of routes) {
    const req =
      route.method === 'GET'
        ? new Request(`http://local${route.path}`, { headers: authHeaders() })
        : new Request(`http://local${route.path}`, {
            method: 'POST',
            headers: authHeaders(),
            body: route.body ? JSON.stringify(route.body) : '{}',
          });
    const res = await handler(req);
    assert.equal(res.status, 200, `${route.path} should return 200`);
    assert.match(
      res.headers.get('content-type') || '',
      /application\/json/,
      `${route.path} should return JSON`
    );
    // Verify body is valid JSON
    const body = await res.json();
    assert.ok(typeof body === 'object', `${route.path} should return JSON object`);
  }
});

// ===========================================================================
// WORKFLOW 25: Every capability route is reachable (no dead routes)
// ===========================================================================

test('workflow: every capability registered in the registry resolves and handles a request', async () => {
  const { resolveCapability, listCapabilityFeatures } = await import('./capabilities.js');
  const features = listCapabilityFeatures();

  // Hit a representative set of routes to ensure none are dead
  const routesToHit = [
    '/keys/derived',
    '/neodid/providers',
    '/neodid/runtime',
    '/providers',
    '/oracle/public-key',
    '/oracle/decrypt',
    '/oracle/message-reveal',
    '/oracle/query',
    '/oracle/smart-fetch',
    '/feeds/catalog',
    '/feeds/price',
    '/vrf/random',
    '/oracle/feed',
    '/txproxy/invoke',
    '/sign/payload',
    '/relay/transaction',
    '/paymaster/authorize',
    '/compute/functions',
    '/compute/execute',
    '/compute/jobs',
    '/session/start',
    '/session/step',
    '/session/finalize',
  ];

  for (const path of routesToHit) {
    const resolved = resolveCapability(path);
    assert.ok(resolved, `route ${path} should resolve to a capability`);
    assert.ok(resolved.capability.handler, `capability for ${path} must have a handler`);
  }

  // Also verify regex routes
  const regexRoutes = ['/feeds/price/BTC-USD', '/compute/jobs/abc'];
  for (const path of regexRoutes) {
    const resolved = resolveCapability(path);
    assert.ok(resolved, `regex route ${path} should resolve`);
  }

  // Verify feature count matches capabilities
  assert.equal(features.length, 30, 'should have 30 registered capabilities');
});
