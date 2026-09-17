import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { probeRuntimeNetworks } from './check-runtime-networks.mjs';

const expectedNetwork = (url) =>
  new URL(url).searchParams.get('network') || new URL(url).pathname.split('/')[1];

test('probes every runtime/oracle/edge and web network, using only uncredentialed GET', async () => {
  const requests = [];
  const report = await probeRuntimeNetworks({
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return Response.json({ network: expectedNetwork(url), ready: true });
    },
  });
  assert.equal(report.ok, true);
  assert.equal(requests.length, 8);
  for (const surface of ['runtime', 'oracle', 'edge', 'web']) {
    assert.deepEqual(
      report.results.filter((result) => result.surface === surface).map((result) => result.network),
      ['mainnet', 'testnet']
    );
  }
  for (const { options } of requests) {
    assert.equal(options.method, 'GET');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers, undefined);
  }
});

test('HTTP 200 mainnet aliases fail all four testnet paths', async () => {
  const report = await probeRuntimeNetworks({
    fetchImpl: async () => Response.json({ network: 'mainnet', ready: true }),
  });
  assert.equal(report.ok, false);
  assert.equal(report.results.filter((result) => result.ok).length, 4);
  assert.ok(
    report.results
      .filter((result) => result.network === 'testnet')
      .every((result) => result.reason === 'network_mismatch_or_missing')
  );
});

test('correct network cannot hide unavailable HTTP status, absent identity, or unready runtime', async () => {
  for (const failure of ['status', 'identity', 'readiness']) {
    const report = await probeRuntimeNetworks({
      fetchImpl: async (url) =>
        Response.json(
          {
            ...(failure === 'identity' ? {} : { network: expectedNetwork(url) }),
            ready: failure !== 'readiness',
          },
          { status: failure === 'status' ? 503 : 200 }
        ),
    });
    assert.equal(report.ok, false);
    assert.ok(report.results.every((result) => !result.ok));
  }
});

for (const ready of [undefined, null, 'true', 1]) {
  test(`release gate refuses ready=${JSON.stringify(ready)} despite HTTP 200 and correct network`, async () => {
    const report = await probeRuntimeNetworks({
      fetchImpl: async (url) =>
        Response.json({ network: expectedNetwork(url), status: 'ok', ready }),
    });
    assert.equal(report.ok, false);
    assert.ok(report.results.every((result) => result.reason === 'runtime_not_ready'));
  });
}

test('release gate refuses non-200 or contradictory declared status despite ready=true', async () => {
  for (const [httpStatus, status] of [
    [201, 'ok'],
    [503, 'ok'],
    [200, 'degraded'],
    [200, 'error'],
    [200, null],
  ]) {
    const report = await probeRuntimeNetworks({
      fetchImpl: async (url) =>
        Response.json(
          { network: expectedNetwork(url), ready: true, status },
          { status: httpStatus }
        ),
    });
    assert.equal(report.ok, false);
    assert.ok(report.results.every((result) => !result.ok));
  }
});

test('bounded body and safe errors do not echo upstream text', async () => {
  for (const fetchImpl of [
    async () => new Response('x'.repeat(65537)),
    async () => new Response('private-key=secret'),
    async () => {
      throw new Error('https://user:secret@internal.test/private');
    },
  ]) {
    const report = await probeRuntimeNetworks({ fetchImpl });
    assert.equal(report.ok, false);
    assert.ok(report.results.every((result) => result.reason === 'transport_or_invalid_body'));
    assert.doesNotMatch(JSON.stringify(report), /secret|private-key|internal\.test/);
  }
});

test('rejects credential-bearing or non-loopback HTTP origins before any fetch', async () => {
  for (const origin of [
    'https://user:secret@example.test',
    'http://example.test',
    'https://example.test/private',
    'https://example.test/?token=secret',
  ]) {
    let called = false;
    await assert.rejects(
      probeRuntimeNetworks({
        origins: { runtime: origin },
        fetchImpl: async () => {
          called = true;
        },
      })
    );
    assert.equal(called, false);
  }
});

test('actual HTTP receiver verifies both networks and does not follow redirects', async () => {
  let mode = 'healthy',
    unexpected = 0;
  const server = createServer((request, response) => {
    if (request.url === '/unexpected') {
      unexpected++;
      response.end('{}');
      return;
    }
    if (mode === 'redirect') {
      response.writeHead(307, { location: '/unexpected' });
      response.end();
      return;
    }
    const url = new URL(request.url, 'http://127.0.0.1');
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ network: expectedNetwork(url), ready: true }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const origins = Object.fromEntries(
      ['runtime', 'oracle', 'edge', 'web'].map((key) => [key, origin])
    );
    assert.equal((await probeRuntimeNetworks({ origins })).ok, true);
    mode = 'redirect';
    assert.equal((await probeRuntimeNetworks({ origins })).ok, false);
    assert.equal(unexpected, 0);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
