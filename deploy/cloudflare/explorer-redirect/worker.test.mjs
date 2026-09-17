import test from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker.mjs';

test('Explorer redirects directly to its canonical host and preserves resource path/query', async () => {
  const response = await worker.fetch(new Request('https://explorer.neoos.network/block/123?network=mainnet'));
  assert.equal(response.status, 301);
  assert.equal(response.headers.get('location'), 'https://www.neo3scan.com/block/123?network=mainnet');
});
