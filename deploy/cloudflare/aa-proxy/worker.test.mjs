import test from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker.mjs';

test('AA proxy pins the Vercel origin and preserves path/query', async () => {
  const original = globalThis.fetch; let seen;
  globalThis.fetch = async request => { seen = request; return new Response('ok'); };
  try {
    const response = await worker.fetch(new Request('https://aa.neoos.network/docs?lang=zh-CN'));
    assert.equal(response.status, 200);
    assert.equal(seen.url, 'https://neoos-aa-frontend.vercel.app/docs?lang=zh-CN');
  } finally { globalThis.fetch = original; }
});

test('AA proxy cannot be used as an open proxy', async () => {
  const original = globalThis.fetch; let seenUrl = '';
  globalThis.fetch = async request => { seenUrl = request.url; return new Response(null, { status: 204 }); };
  try { await worker.fetch(new Request('https://aa.neoos.network/https://evil.example')); }
  finally { globalThis.fetch = original; }
  assert.equal(new URL(seenUrl).origin, 'https://neoos-aa-frontend.vercel.app');
});
