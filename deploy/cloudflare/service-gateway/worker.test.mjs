import test from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker.mjs';
import runtimeWorker from '../runtime-proxy/worker.mjs';
import mcpWorker from '../mcp-proxy/worker.mjs';
import { MCP_HEADER_TIMEOUT_MS } from '../lib/fixed-origin-proxy.mjs';

test('both MCP entrypoints permit the documented deadline and bound stalled headers', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const observed = [];
  t.mock.method(
    globalThis,
    'fetch',
    (request) =>
      new Promise((resolve, reject) => {
        observed.push(request);
        request.signal.addEventListener('abort', () => reject(request.signal.reason), {
          once: true,
        });
      })
  );
  const direct = mcpWorker.fetch(new Request('https://mcp.neoos.network/mcp'));
  const gateway = worker.fetch(new Request('https://services.neoos.network/mcp/mcp'));
  t.mock.timers.tick(300_000);
  assert.equal(observed.length, 2);
  assert.ok(observed.every((request) => !request.signal.aborted));
  t.mock.timers.tick(MCP_HEADER_TIMEOUT_MS - 300_000);
  assert.equal((await direct).status, 504);
  assert.equal((await gateway).status, 504);
});

for (const pathname of [
  '/testnet/health',
  '//testnet/health',
  '/TESTNET/health',
  '/%74estnet/health',
  '/testnet%2fhealth',
]) {
  test(`both runtime entrypoints refuse ${pathname} before fetch`, async (t) => {
    const fetch = t.mock.method(globalThis, 'fetch', async () => {
      throw new Error('must not fetch');
    });
    const direct = await runtimeWorker.fetch(
      new Request(`https://runtime.neoos.network${pathname}`)
    );
    const gateway = await worker.fetch(
      new Request(`https://services.neoos.network/runtime${pathname}`)
    );
    assert.equal(direct.status, 503);
    assert.equal(gateway.status, 503);
    assert.deepEqual(await direct.json(), await gateway.json());
    assert.equal(fetch.mock.callCount(), 0);
  });
}

test('gateway preserves path separators, trailing slash, method and payload', async (t) => {
  let observed;
  t.mock.method(globalThis, 'fetch', async (request) => {
    observed = request;
    return new Response('ok');
  });
  await worker.fetch(
    new Request('https://services.neoos.network/fura/v2//items/?id=a%2Fb', {
      method: 'POST',
      body: 'payload',
    })
  );
  assert.equal(observed.url, 'https://api.n3index.dev/v2//items/?id=a%2Fb');
  assert.equal(observed.method, 'POST');
  assert.equal(await observed.text(), 'payload');
});

test('inherited Object properties and ambiguous service prefixes cannot select an upstream', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('must not fetch');
  });
  for (const path of [
    '/toString',
    '/constructor',
    '/__proto__',
    '//runtime/health',
    '/%72untime/health',
  ]) {
    assert.equal(
      (await worker.fetch(new Request(`https://services.neoos.network${path}`))).status,
      404
    );
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test('service gateway exposes an explicit fixed-origin catalog', async () => {
  const response = await worker.fetch(new Request('https://services.neoos.network/'));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.policy, 'fixed-origin-prefix-routing');
  assert.equal(body.routes.mcp, 'https://services.neoos.network/mcp');
});

test('service gateway pins a known upstream and preserves auth', async () => {
  const original = globalThis.fetch;
  let seen;
  globalThis.fetch = async (request) => {
    seen = request;
    return new Response('ok', { status: 200 });
  };
  try {
    const response = await worker.fetch(
      new Request('https://services.neoos.network/mcp/mcp?x=1', {
        method: 'POST',
        headers: { authorization: 'Bearer test' },
        body: '{}',
      })
    );
    assert.equal(response.status, 200);
    assert.equal(seen.url, 'https://mcp.n3index.dev/mcp?x=1');
    assert.equal(seen.headers.get('authorization'), 'Bearer test');
  } finally {
    globalThis.fetch = original;
  }
});

test('service gateway rejects unknown prefixes without fetching', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('must not fetch');
  };
  try {
    const response = await worker.fetch(new Request('https://services.neoos.network/unknown/path'));
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'unknown_service', service: 'unknown' });
  } finally {
    globalThis.fetch = original;
  }
});
