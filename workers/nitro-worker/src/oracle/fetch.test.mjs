import test from 'node:test';
import assert from 'node:assert/strict';
import { performOracleFetch } from './fetch.js';

const originalFetch = global.fetch;

test.afterEach(() => {
  global.fetch = originalFetch;
});

test('oracle fetch refuses to follow redirects (SSRF closure)', async () => {
  let captured;
  global.fetch = async (url, init = {}) => {
    captured = init;
    if (init.redirect !== 'error') {
      // Emulates undici's default redirect:'follow' silently fetching the
      // 30x Location target (e.g. 302 -> http://127.0.0.1/metadata) — the
      // exact behavior the guard must prevent.
      return new Response('metadata-leak', { status: 200 });
    }
    // undici with redirect:'error' rejects the fetch on any 30x response.
    throw new TypeError('fetch failed: unexpected redirect');
  };

  await assert.rejects(
    performOracleFetch({
      url: 'https://api.example.com/redirects-to-metadata',
      target_chain: 'neo_n3',
    }),
    /fetch failed/
  );
  assert.equal(captured.redirect, 'error');
});

test('oracle fetch still serves non-redirecting upstreams with redirects disabled', async () => {
  let captured;
  global.fetch = async (url, init = {}) => {
    captured = init;
    return new Response(JSON.stringify({ price: '1.23' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const result = await performOracleFetch({
    url: 'https://api.example.com/price',
    json_path: 'price',
    target_chain: 'neo_n3',
  });
  assert.equal(captured.redirect, 'error');
  assert.equal(result.upstream_status, 200);
  assert.equal(result.selected_value, '1.23');
});
