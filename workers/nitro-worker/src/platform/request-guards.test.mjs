import test from 'node:test';
import assert from 'node:assert/strict';

const originalFetch = global.fetch;
const originalEnv = { ...process.env };

const store = new Map();
const expiry = new Map();

function resetStore() {
  store.clear();
  expiry.clear();
}

function now() {
  return Date.now();
}

function ensureNotExpired(key) {
  const expiresAt = expiry.get(key);
  if (typeof expiresAt === 'number' && expiresAt <= now()) {
    store.delete(key);
    expiry.delete(key);
  }
}

function response(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function installUpstashMock() {
  global.fetch = async (url, init = {}) => {
    const value = String(url);
    if (!value.startsWith('https://mock-upstash.example.com')) {
      throw new Error(`unexpected fetch ${value}`);
    }

    const parsed = new URL(value);
    if (parsed.pathname === '/pipeline') {
      const commands = JSON.parse(String(init.body || '[]'));
      const results = commands.map((entry) => {
        const [op, key, ...args] = entry;
        ensureNotExpired(key);
        switch (String(op).toUpperCase()) {
          case 'INCR': {
            const next = Number(store.get(key) || 0) + 1;
            store.set(key, next);
            return { result: next };
          }
          case 'PTTL': {
            const expiresAt = expiry.get(key);
            return { result: typeof expiresAt === 'number' ? Math.max(expiresAt - now(), 0) : -1 };
          }
          case 'PEXPIRE': {
            expiry.set(key, now() + Number(args[0] || 0));
            return { result: 1 };
          }
          case 'SET': {
            const valueArg = args[0];
            const optionArgs = args.slice(1).map((item) => String(item).toUpperCase());
            const existing = store.has(key);
            if (optionArgs.includes('NX') && existing) return { result: null };
            store.set(key, valueArg);
            const pxIndex = optionArgs.indexOf('PX');
            if (pxIndex >= 0) {
              const ttl = Number(args[pxIndex + 1] || 0);
              expiry.set(key, now() + ttl);
            }
            return { result: 'OK' };
          }
          case 'DEL': {
            const existed = store.delete(key);
            expiry.delete(key);
            return { result: existed ? 1 : 0 };
          }
          case 'EVAL': {
            const lockKey = args[1];
            const expectedOwner = args[2];
            ensureNotExpired(lockKey);
            if (store.get(lockKey) !== expectedOwner) return { result: 0 };
            store.delete(lockKey);
            expiry.delete(lockKey);
            return { result: 1 };
          }
          default:
            throw new Error(`unsupported op ${op}`);
        }
      });
      return response(results);
    }

    const [, command, ...segments] = parsed.pathname.split('/');
    if (command === 'get') {
      const key = decodeURIComponent(segments.join('/'));
      ensureNotExpired(key);
      return response({ result: store.get(key) ?? null });
    }

    throw new Error(`unsupported path ${parsed.pathname}`);
  };
}

test.beforeEach(() => {
  resetStore();
  process.env = { ...originalEnv };
  delete process.env.MORPHEUS_RUNTIME_CONFIG_JSON;
});

test.after(() => {
  global.fetch = originalFetch;
  process.env = originalEnv;
});

test('applyRequestGuards is a no-op when Upstash guards are disabled', async () => {
  const { applyRequestGuards } = await import('./request-guards.js');
  const result = await applyRequestGuards({
    request: new Request('http://local/paymaster/authorize', {
      method: 'POST',
      headers: { authorization: 'Bearer test' },
      body: JSON.stringify({ operation_hash: '0xabc' }),
    }),
    path: '/paymaster/authorize',
    payload: { operation_hash: '0xabc' },
  });
  assert.equal(result.ok, true);
});

test('applyRequestGuards rate limits repeated paymaster requests via Upstash', async () => {
  installUpstashMock();
  process.env.UPSTASH_REDIS_REST_URL = 'https://mock-upstash.example.com';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
  process.env.MORPHEUS_UPSTASH_GUARDS_ENABLED = 'true';
  process.env.MORPHEUS_RATE_LIMIT_PAYMASTER_AUTHORIZE_MAX = '1';

  const { applyRequestGuards } = await import('./request-guards.js');
  const request = new Request('http://local/paymaster/authorize', {
    method: 'POST',
    headers: {
      authorization: 'Bearer test',
      'cf-connecting-ip': '203.0.113.7',
    },
    body: JSON.stringify({ account_id: '0x1234', dapp_id: 'demo', operation_hash: '0xaaa' }),
  });
  const payload = { account_id: '0x1234', dapp_id: 'demo', operation_hash: '0xaaa' };

  const first = await applyRequestGuards({ request, path: '/paymaster/authorize', payload });
  const second = await applyRequestGuards({
    request,
    path: '/paymaster/authorize',
    payload: { ...payload, operation_hash: '0xbbb' },
  });

  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(second.response.status, 429);
});

test('applyRequestGuards bypasses fixed-window rate limiting for the dedicated bypass token', async () => {
  installUpstashMock();
  process.env.UPSTASH_REDIS_REST_URL = 'https://mock-upstash.example.com';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
  process.env.MORPHEUS_UPSTASH_GUARDS_ENABLED = 'true';
  process.env.MORPHEUS_RATE_LIMIT_BYPASS_TOKEN = 'dedicated-bypass-token';
  process.env.MORPHEUS_RATE_LIMIT_PAYMASTER_AUTHORIZE_MAX = '1';

  const { applyRequestGuards } = await import('./request-guards.js');
  const makeRequest = (operationHash) =>
    new Request('http://local/paymaster/authorize', {
      method: 'POST',
      headers: {
        authorization: 'Bearer dedicated-bypass-token',
        'cf-connecting-ip': '203.0.113.9',
      },
      body: JSON.stringify({
        account_id: '0x1234',
        dapp_id: 'demo',
        operation_hash: operationHash,
      }),
    });

  const first = await applyRequestGuards({
    request: makeRequest('0xaaa'),
    path: '/paymaster/authorize',
    payload: { account_id: '0x1234', dapp_id: 'demo', operation_hash: '0xaaa' },
  });
  const second = await applyRequestGuards({
    request: makeRequest('0xbbb'),
    path: '/paymaster/authorize',
    payload: { account_id: '0x1234', dapp_id: 'demo', operation_hash: '0xbbb' },
  });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
});

test('applyRequestGuards does NOT bypass rate limiting for a signing/auth token', async () => {
  installUpstashMock();
  process.env.UPSTASH_REDIS_REST_URL = 'https://mock-upstash.example.com';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
  process.env.MORPHEUS_UPSTASH_GUARDS_ENABLED = 'true';
  // A leaked signing/auth token must NOT also remove the abuse ceiling.
  process.env.MORPHEUS_RUNTIME_TOKEN = 'signing-token';
  delete process.env.MORPHEUS_RATE_LIMIT_BYPASS_TOKEN;
  process.env.MORPHEUS_RATE_LIMIT_PAYMASTER_AUTHORIZE_MAX = '1';

  const { applyRequestGuards } = await import('./request-guards.js');
  const makeRequest = (operationHash) =>
    new Request('http://local/paymaster/authorize', {
      method: 'POST',
      headers: {
        authorization: 'Bearer signing-token',
        'x-nitro-token': 'signing-token',
        'cf-connecting-ip': '203.0.113.9',
      },
      body: JSON.stringify({
        account_id: '0x1234',
        dapp_id: 'demo',
        operation_hash: operationHash,
      }),
    });

  const first = await applyRequestGuards({
    request: makeRequest('0xaaa'),
    path: '/paymaster/authorize',
    payload: { account_id: '0x1234', dapp_id: 'demo', operation_hash: '0xaaa' },
  });
  const second = await applyRequestGuards({
    request: makeRequest('0xbbb'),
    path: '/paymaster/authorize',
    payload: { account_id: '0x1234', dapp_id: 'demo', operation_hash: '0xbbb' },
  });

  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(second.response.status, 429);
});

test('persistGuardResult caches idempotent responses for repeated relay requests', async () => {
  installUpstashMock();
  process.env.UPSTASH_REDIS_REST_URL = 'https://mock-upstash.example.com';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
  process.env.MORPHEUS_UPSTASH_GUARDS_ENABLED = 'true';

  const { applyRequestGuards, persistGuardResult } = await import('./request-guards.js');
  const payload = { operation_hash: '0xfeedbeef', paymaster: { operation_hash: '0xfeedbeef' } };
  const request = new Request('http://local/relay/transaction', {
    method: 'POST',
    headers: {
      authorization: 'Bearer test',
      'cf-connecting-ip': '203.0.113.8',
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const first = await applyRequestGuards({ request, path: '/relay/transaction', payload });
  assert.equal(first.ok, true);
  await persistGuardResult(
    first,
    new Response(JSON.stringify({ ok: true, txid: '0x1234' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  );

  const second = await applyRequestGuards({ request, path: '/relay/transaction', payload });
  assert.equal(second.ok, false);
  assert.equal(second.cached, true);
  assert.equal(second.response.status, 200);
  assert.deepEqual(await second.response.json(), { ok: true, txid: '0x1234' });
});

test('workflow execution idempotency prefers workflow execution ids over payload hashes', async () => {
  installUpstashMock();
  process.env.UPSTASH_REDIS_REST_URL = 'https://mock-upstash.example.com';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
  process.env.MORPHEUS_UPSTASH_GUARDS_ENABLED = 'true';

  const { applyRequestGuards, persistGuardResult } = await import('./request-guards.js');
  const makeRequest = (payload) =>
    new Request('http://local/compute/execute', {
      method: 'POST',
      headers: {
        authorization: 'Bearer test',
        'cf-connecting-ip': '203.0.113.11',
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

  const firstPayload = {
    workflow_id: 'compute.execute',
    execution_id: 'exec-1',
    mode: 'builtin',
    function: 'hash.sha256',
    input: { data: 'hello world' },
  };
  const secondPayload = {
    workflow_id: 'compute.execute',
    execution_id: 'exec-1',
    mode: 'builtin',
    function: 'hash.sha256',
    input: { data: 'mutated payload' },
  };

  const first = await applyRequestGuards({
    request: makeRequest(firstPayload),
    path: '/compute/execute',
    payload: firstPayload,
  });
  assert.equal(first.ok, true);
  await persistGuardResult(
    first,
    new Response(JSON.stringify({ ok: true, digest: '0xabc' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  );

  const second = await applyRequestGuards({
    request: makeRequest(secondPayload),
    path: '/compute/execute',
    payload: secondPayload,
  });
  assert.equal(second.ok, false);
  assert.equal(second.cached, true);
  assert.deepEqual(await second.response.json(), { ok: true, digest: '0xabc' });
});

test('oracle request idempotency differentiates encrypted params and scripts', async () => {
  installUpstashMock();
  process.env.UPSTASH_REDIS_REST_URL = 'https://mock-upstash.example.com';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
  process.env.MORPHEUS_UPSTASH_GUARDS_ENABLED = 'true';

  const { applyRequestGuards } = await import('./request-guards.js');
  const makeRequest = (payload) =>
    new Request('http://local/oracle/query', {
      method: 'POST',
      headers: {
        authorization: 'Bearer test',
        'cf-connecting-ip': '203.0.113.10',
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

  const basePayload = {
    url: 'https://postman-echo.com/get?probe=neo-morpheus',
    target_chain: 'neo_n3',
  };
  const firstPayload = {
    ...basePayload,
    encrypted_params: 'ciphertext-a',
  };
  const secondPayload = {
    ...basePayload,
    encrypted_params: 'ciphertext-b',
  };
  const scriptedPayload = {
    ...basePayload,
    encrypted_params: 'ciphertext-a',
    script: 'function process(data) { return data.args.probe; }',
  };

  const first = await applyRequestGuards({
    request: makeRequest(firstPayload),
    path: '/oracle/query',
    payload: firstPayload,
  });
  const second = await applyRequestGuards({
    request: makeRequest(secondPayload),
    path: '/oracle/query',
    payload: secondPayload,
  });
  const third = await applyRequestGuards({
    request: makeRequest(scriptedPayload),
    path: '/oracle/query',
    payload: scriptedPayload,
  });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(third.ok, true);
  assert.notEqual(first.idempotency.lockKey, second.idempotency.lockKey);
  assert.notEqual(first.idempotency.lockKey, third.idempotency.lockKey);
});

test('applyRequestGuards rate limits action-routed requests that bypass the route path', async () => {
  installUpstashMock();
  process.env.UPSTASH_REDIS_REST_URL = 'https://mock-upstash.example.com';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
  process.env.MORPHEUS_UPSTASH_GUARDS_ENABLED = 'true';
  process.env.MORPHEUS_RATE_LIMIT_RELAY_TRANSACTION_MAX = '1';

  const { applyRequestGuards } = await import('./request-guards.js');
  // The dispatcher resolves this to relay_transaction via payload.action even
  // though the path matches no capability — the guards must do the same.
  const payload = { action: 'relay_transaction' };
  const request = new Request('http://local/', {
    method: 'POST',
    headers: {
      authorization: 'Bearer test',
      'cf-connecting-ip': '203.0.113.13',
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const first = await applyRequestGuards({ request, path: '', payload });
  const second = await applyRequestGuards({ request, path: '', payload });

  assert.equal(first.ok, true);
  assert.equal(first.routeName, 'relay_transaction');
  assert.equal(second.ok, false);
  assert.equal(second.response.status, 429);
  assert.equal((await second.response.json()).route, 'relay_transaction');
});

test('persistGuardResult does not cache transient 4xx failures', async () => {
  installUpstashMock();
  process.env.UPSTASH_REDIS_REST_URL = 'https://mock-upstash.example.com';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
  process.env.MORPHEUS_UPSTASH_GUARDS_ENABLED = 'true';

  const { applyRequestGuards, persistGuardResult, releaseGuardLock } =
    await import('./request-guards.js');
  const payload = { operation_hash: '0xdeadbeef' };
  const request = new Request('http://local/relay/transaction', {
    method: 'POST',
    headers: {
      authorization: 'Bearer test',
      'cf-connecting-ip': '203.0.113.14',
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const first = await applyRequestGuards({ request, path: '/relay/transaction', payload });
  assert.equal(first.ok, true);
  // The worker's top-level catch maps transient upstream failures to 400 —
  // replaying that for the idempotency TTL would poison legitimate retries.
  await persistGuardResult(
    first,
    new Response(JSON.stringify({ error: 'oracle fetch timed out after 8000ms' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    })
  );
  // The dispatch finally always releases the idempotency lock (see worker.js), so
  // the next request can re-claim it instead of being blocked until the lock TTL.
  await releaseGuardLock(first);

  const second = await applyRequestGuards({ request, path: '/relay/transaction', payload });
  assert.equal(second.ok, true);
  assert.equal(second.cached, undefined);
});

test('releaseGuardLock frees the idempotency lock so a thrown handler does not block retries', async () => {
  installUpstashMock();
  process.env.UPSTASH_REDIS_REST_URL = 'https://mock-upstash.example.com';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
  process.env.MORPHEUS_UPSTASH_GUARDS_ENABLED = 'true';

  const { applyRequestGuards, releaseGuardLock } = await import('./request-guards.js');
  const payload = { operation_hash: '0xcafef00d' };
  const makeRequest = () =>
    new Request('http://local/relay/transaction', {
      method: 'POST',
      headers: {
        authorization: 'Bearer test',
        'cf-connecting-ip': '203.0.113.20',
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

  const first = await applyRequestGuards({
    request: makeRequest(),
    path: '/relay/transaction',
    payload,
  });
  assert.equal(first.ok, true);
  assert.ok(first.idempotency?.lockKey);

  // Simulate a handler that threw: the lock was claimed but no response was cached.
  // Until the lock is released the same idempotency key is blocked with a 409.
  const whileLocked = await applyRequestGuards({
    request: makeRequest(),
    path: '/relay/transaction',
    payload,
  });
  assert.equal(whileLocked.ok, false);
  assert.equal(whileLocked.response.status, 409);

  // The dispatch finally always releases the lock, even on the throw path.
  await releaseGuardLock(first);

  const afterRelease = await applyRequestGuards({
    request: makeRequest(),
    path: '/relay/transaction',
    payload,
  });
  assert.equal(afterRelease.ok, true);
  assert.equal(afterRelease.cached, undefined);
});

test('releaseGuardLock never deletes a lock acquired by a newer owner after TTL expiry', async () => {
  installUpstashMock();
  process.env.UPSTASH_REDIS_REST_URL = 'https://mock-upstash.example.com';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
  process.env.MORPHEUS_UPSTASH_GUARDS_ENABLED = 'true';

  const { applyRequestGuards, releaseGuardLock } = await import('./request-guards.js');
  const payload = { operation_hash: '0xowner-race' };
  const request = new Request('http://local/relay/transaction', {
    method: 'POST',
    headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const first = await applyRequestGuards({ request, path: '/relay/transaction', payload });
  assert.equal(first.ok, true);

  const { lockKey, lockOwnerToken } = first.idempotency;
  assert.equal(store.get(lockKey), lockOwnerToken);
  store.set(lockKey, 'new-owner-after-expiry');

  await releaseGuardLock(first);
  assert.equal(store.get(lockKey), 'new-owner-after-expiry');
});

test('applyRequestGuards denies requests that carry an explicit policy rejection', async () => {
  installUpstashMock();
  process.env.UPSTASH_REDIS_REST_URL = 'https://mock-upstash.example.com';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
  process.env.MORPHEUS_UPSTASH_GUARDS_ENABLED = 'true';

  const { applyRequestGuards } = await import('./request-guards.js');
  const payload = {
    workflow_id: 'oracle.query',
    policy_decision: {
      allow: false,
      decision: 'deny',
      reason: 'provider_disabled',
    },
  };
  const request = new Request('http://local/oracle/query', {
    method: 'POST',
    headers: {
      authorization: 'Bearer test',
      'cf-connecting-ip': '203.0.113.12',
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const result = await applyRequestGuards({ request, path: '/oracle/query', payload });
  assert.equal(result.ok, false);
  assert.equal(result.response.status, 403);
  assert.deepEqual(await result.response.json(), {
    error: 'policy_denied',
    route: 'oracle_query',
    reason: 'provider_disabled',
    decision: 'deny',
  });
});
