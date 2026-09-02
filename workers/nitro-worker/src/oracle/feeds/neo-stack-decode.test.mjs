import test from 'node:test';
import assert from 'node:assert/strict';

import { loadNeoN3FeedSigningMode } from './neo-stack-decode.js';

const originalFetch = global.fetch;

test.afterEach(() => {
  global.fetch = originalFetch;
});

function rpcResponse(result) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

test('legacy data feed ABI selects unsigned updates even when local signer material exists', async () => {
  global.fetch = async () =>
    rpcResponse({
      manifest: {
        abi: {
          methods: [
            { name: 'updateFeed', parameters: Array(6).fill({}) },
            { name: 'updateFeeds', parameters: Array(6).fill({}) },
          ],
        },
      },
    });
  assert.deepEqual(await loadNeoN3FeedSigningMode('https://rpc.test', '0xfeed'), {
    supportsSignedUpdates: false,
    requiresSignedUpdates: false,
    error: null,
  });
});

test('current data feed requires signatures only when a verification key is registered', async () => {
  let keyConfigured = false;
  global.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    if (body.method === 'getcontractstate') {
      return rpcResponse({
        manifest: {
          abi: {
            methods: [
              { name: 'oracleVerificationKey', parameters: [] },
              { name: 'updateFeedSigned', parameters: Array(7).fill({}) },
            ],
          },
        },
      });
    }
    return rpcResponse({
      state: 'HALT',
      stack: keyConfigured
        ? [{ type: 'ByteString', value: 'A'.repeat(44) }]
        : [{ type: 'Any', value: null }],
    });
  };

  assert.equal(
    (await loadNeoN3FeedSigningMode('https://rpc.test', '0xfeed')).requiresSignedUpdates,
    false
  );
  keyConfigured = true;
  assert.equal(
    (await loadNeoN3FeedSigningMode('https://rpc.test', '0xfeed')).requiresSignedUpdates,
    true
  );
});
