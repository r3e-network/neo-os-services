import test from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker.mjs';

test('MCP proxy pins the canonical upstream and preserves the request path', async () => {
  const original = globalThis.fetch;
  let seen;
  globalThis.fetch = async request => {
    seen = request;
    return new Response('{"status":"ok"}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const response = await worker.fetch(new Request('https://mcp.neoos.network/mcp?x=1', {
      method: 'POST',
      headers: { authorization: 'Bearer test', 'mcp-protocol-version': '2026-07-28' },
      body: '{}',
    }));
    assert.equal(response.status, 200);
    assert.equal(seen.url, 'https://mcp.n3index.dev/mcp?x=1');
    assert.equal(seen.headers.get('authorization'), 'Bearer test');
    assert.equal(seen.headers.get('mcp-protocol-version'), '2026-07-28');
  } finally {
    globalThis.fetch = original;
  }
});

test('MCP proxy ignores a caller-supplied origin path', async () => {
  const original = globalThis.fetch;
  let seen;
  globalThis.fetch = async request => { seen = request; return new Response('ok'); };
  try {
    await worker.fetch(new Request('https://mcp.neoos.network/https://attacker.example/'));
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(new URL(seen.url).origin, 'https://mcp.n3index.dev');
});
