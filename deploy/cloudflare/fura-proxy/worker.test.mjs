import test from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker.mjs';

test('Fura proxy pins api.n3index.dev and preserves JSON-RPC context', async () => {
  const original = globalThis.fetch;
  let seen;
  globalThis.fetch = async (request) => {
    seen = request;
    return new Response('{"ok":true}', { status: 200 });
  };
  try {
    const response = await worker.fetch(
      new Request('https://fura.neoos.network/mainnet', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"jsonrpc":"2.0"}',
      })
    );
    assert.equal(response.status, 200);
    assert.equal(seen.url, 'https://api.n3index.dev/mainnet');
    assert.equal(await seen.text(), '{"jsonrpc":"2.0"}');
  } finally {
    globalThis.fetch = original;
  }
});

test('Fura proxy does not allow a caller-controlled upstream', async () => {
  const original = globalThis.fetch;
  let seenUrl = '';
  globalThis.fetch = async (request) => {
    seenUrl = request.url;
    return new Response(null, { status: 204 });
  };
  try {
    await worker.fetch(new Request('https://indexer.neoos.network/https://evil.example/a'));
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(new URL(seenUrl).origin, 'https://api.n3index.dev');
});
