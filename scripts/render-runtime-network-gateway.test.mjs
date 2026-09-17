import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  renderRuntimeNetworkGateway,
  verifyRuntimeUpstream,
} from './render-runtime-network-gateway.mjs';

const template = await readFile(
  new URL('../deploy/nitro/runtime-gateway.nginx.conf', import.meta.url),
  'utf8'
);
const upstreams = { mainnet: 'http://127.0.0.1:8787', testnet: 'http://127.0.0.1:8791' };

test('renders distinct network upstreams while retaining route, auth, and edge fences', () => {
  const rendered = renderRuntimeNetworkGateway(template, upstreams);
  assert.match(rendered, /default http:\/\/127\.0\.0\.1:8787;/);
  assert.match(rendered, /~\^\/testnet\/ http:\/\/127\.0\.0\.1:8791;/);
  const originalRouteAndFence = template.replaceAll(
    'proxy_pass http://127.0.0.1:8787',
    'proxy_pass $morpheus_runtime_origin'
  );
  assert.ok(rendered.endsWith(originalRouteAndFence));
  assert.equal(rendered.split('proxy_pass $morpheus_runtime_origin').length - 1, 4);
});

test('refuses shared listeners, arbitrary targets, config injection, and stale templates', () => {
  assert.throws(() =>
    renderRuntimeNetworkGateway(template, { ...upstreams, testnet: upstreams.mainnet })
  );
  for (const testnet of [
    'http://example.test:8791',
    'http://127.0.0.1:8791/private',
    'http://user:secret@127.0.0.1:8791',
    'http://127.0.0.1:8791;return 200;',
  ]) {
    assert.throws(() => renderRuntimeNetworkGateway(template, { ...upstreams, testnet }));
  }
  assert.throws(() =>
    renderRuntimeNetworkGateway(
      template.replace('proxy_pass http://127.0.0.1:8787', 'proxy_pass http://127.0.0.1:9999'),
      upstreams
    )
  );
});

test('requires actual matching ready runtimes, not an HTTP 200 alias', async () => {
  const response = (body) => async () => Response.json(body);
  await assert.rejects(
    verifyRuntimeUpstream(
      upstreams.testnet,
      'testnet',
      response({ network: 'mainnet', ready: true })
    )
  );
  await assert.rejects(
    verifyRuntimeUpstream(upstreams.testnet, 'testnet', response({ network: 'testnet' }))
  );
  await assert.rejects(
    verifyRuntimeUpstream(
      upstreams.testnet,
      'testnet',
      response({ network: 'testnet', ready: false })
    )
  );
  for (const ready of [null, 'true', 1]) {
    await assert.rejects(
      verifyRuntimeUpstream(upstreams.testnet, 'testnet', response({ network: 'testnet', ready }))
    );
  }
  await assert.rejects(
    verifyRuntimeUpstream(
      upstreams.testnet,
      'testnet',
      response({ network: 'testnet', ready: true, status: 'degraded' })
    )
  );
  await assert.rejects(
    verifyRuntimeUpstream(upstreams.testnet, 'testnet', async () =>
      Response.json({ network: 'testnet', ready: true }, { status: 503 })
    )
  );
  await verifyRuntimeUpstream(
    upstreams.testnet,
    'testnet',
    response({ network: 'testnet', ready: true })
  );
  await verifyRuntimeUpstream(
    upstreams.mainnet,
    'mainnet',
    response({ network: 'mainnet', ready: true })
  );
});
