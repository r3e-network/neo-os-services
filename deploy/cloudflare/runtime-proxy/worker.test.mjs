import test from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker.mjs';

test('runtime proxy pins the upstream and preserves request context', async () => {
  const original = globalThis.fetch;
  let observed;
  globalThis.fetch = async (request) => {
    observed = request;
    return new Response('ok', { status: 200 });
  };
  try {
    const response = await worker.fetch(new Request('https://runtime.neoos.network/mainnet/health?x=1', {
      method: 'POST', headers: { authorization: 'Bearer test-token' }, body: 'payload',
    }));
    assert.equal(response.status, 200);
    assert.equal(observed.url, 'https://runtime.meshmini.app/mainnet/health?x=1');
    assert.equal(observed.method, 'POST');
    assert.equal(observed.headers.get('authorization'), 'Bearer test-token');
    assert.equal(await observed.text(), 'payload');
  } finally { globalThis.fetch = original; }
});

test('runtime proxy cannot be redirected to a caller-controlled origin', async () => {
  const original = globalThis.fetch;
  let observedUrl = '';
  globalThis.fetch = async (request) => { observedUrl = request.url; return new Response(null, { status: 204 }); };
  try { await worker.fetch(new Request('https://runtime.neoos.network/https://evil.example/a')); }
  finally { globalThis.fetch = original; }
  assert.equal(new URL(observedUrl).origin, 'https://runtime.meshmini.app');
});

test('runtime proxy refuses testnet until a testnet enclave is provisioned', async () => {
  let called = false;
  const original = globalThis.fetch;
  globalThis.fetch = async () => { called = true; return new Response('bad'); };
  try {
    const response = await worker.fetch(new Request('https://runtime.neoos.network/testnet/health'));
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'runtime_network_mismatch', requested_network: 'testnet', actual_network: 'mainnet' });
  } finally { globalThis.fetch = original; }
  assert.equal(called, false);
});
