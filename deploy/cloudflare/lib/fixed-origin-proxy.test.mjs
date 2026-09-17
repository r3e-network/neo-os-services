import test from 'node:test';
import assert from 'node:assert/strict';
import { proxyToOrigin, UPSTREAM_HEADER_TIMEOUT_MS } from './fixed-origin-proxy.mjs';

test('fixed proxy never follows redirects with credentials and strips untrusted routing headers', async (t) => {
  let observed;
  t.mock.method(globalThis, 'fetch', async (request) => {
    observed = request;
    return new Response(null, { status: 307, headers: { location: 'https://other.example/path' } });
  });
  const response = await proxyToOrigin(
    new Request('https://services.neoos.network/mcp/mcp', {
      method: 'POST',
      body: '{}',
      headers: {
        host: 'attacker.example',
        forwarded: 'host=attacker.example',
        'x-forwarded-host': 'attacker.example',
        'x-forwarded-proto': 'http',
        authorization: 'Bearer test-token',
        cookie: 'session=test-cookie',
        'mcp-session-id': 'test-session',
      },
    }),
    'https://mcp.n3index.dev',
    { pathname: '/mcp' }
  );
  assert.equal(observed.redirect, 'manual');
  assert.equal(observed.headers.get('authorization'), 'Bearer test-token');
  assert.equal(observed.headers.get('mcp-session-id'), 'test-session');
  for (const name of ['host', 'forwarded', 'x-forwarded-host', 'x-forwarded-proto']) {
    assert.equal(observed.headers.get(name), null);
  }
  assert.equal(response.status, 307);
  assert.equal(response.headers.get('location'), 'https://other.example/path');
});

test('same-upstream redirects preserve the public service prefix and query', async (t) => {
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(null, {
        status: 308,
        headers: { location: '/v2/path/?cursor=abc#item' },
      })
  );
  const response = await proxyToOrigin(
    new Request('https://services.neoos.network/fura/v2/path'),
    'https://api.n3index.dev',
    { pathname: '/v2/path', publicPrefix: '/fura' }
  );
  assert.equal(
    response.headers.get('location'),
    'https://services.neoos.network/fura/v2/path/?cursor=abc#item'
  );
});

test('unavailable upstream returns bounded non-cacheable error without details', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('secret upstream details');
  });
  const response = await proxyToOrigin(
    new Request('https://mcp.neoos.network/mcp'),
    'https://mcp.n3index.dev'
  );
  assert.equal(response.status, 502);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { error: 'upstream_unavailable' });
});

test('stalled response headers time out', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(
    globalThis,
    'fetch',
    (request) =>
      new Promise((resolve, reject) => {
        request.signal.addEventListener('abort', () => reject(request.signal.reason), {
          once: true,
        });
      })
  );
  const pending = proxyToOrigin(
    new Request('https://mcp.neoos.network/mcp'),
    'https://mcp.n3index.dev'
  );
  t.mock.timers.tick(UPSTREAM_HEADER_TIMEOUT_MS);
  const response = await pending;
  assert.equal(response.status, 504);
  assert.deepEqual(await response.json(), { error: 'upstream_timeout' });
});

test('a healthy MCP stream stays open beyond the response-header deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let observed;
  let streamController;
  t.mock.method(globalThis, 'fetch', async (request) => {
    observed = request;
    return new Response(
      new ReadableStream({
        start(controller) {
          streamController = controller;
        },
      }),
      {
        headers: { 'content-type': 'text/event-stream' },
      }
    );
  });
  const response = await proxyToOrigin(
    new Request('https://mcp.neoos.network/mcp'),
    'https://mcp.n3index.dev'
  );
  t.mock.timers.tick(UPSTREAM_HEADER_TIMEOUT_MS * 2);
  assert.equal(observed.signal.aborted, false);
  streamController.enqueue(new TextEncoder().encode('data: ready\n\n'));
  streamController.close();
  assert.equal(await response.text(), 'data: ready\n\n');
});
