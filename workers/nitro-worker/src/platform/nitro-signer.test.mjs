import test from 'node:test';
import assert from 'node:assert/strict';
import { getNitroInfo, buildNitroAttestation } from './nitro-signer.js';

const originalFetch = global.fetch;

test.afterEach(() => {
  global.fetch = originalFetch;
});

test('getNitroInfo bounds the signer health probe with an abort signal', async () => {
  let captured;
  global.fetch = async (url, init = {}) => {
    captured = init;
    return new Response(JSON.stringify({ runtime: 'aws-nitro-signer', network: 'testnet' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const info = await getNitroInfo();
  assert.equal(info.runtime, 'aws-nitro-signer');
  assert.equal(info.network, 'testnet');
  assert.ok(captured.signal instanceof AbortSignal);
});

test('buildNitroAttestation bounds the attest call with an abort signal', async () => {
  let captured;
  global.fetch = async (url, init = {}) => {
    captured = init;
    return new Response(JSON.stringify({ attestation_document: 'doc-base64' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const attestation = await buildNitroAttestation('a'.repeat(64));
  assert.equal(attestation.attestation_document, 'doc-base64');
  assert.equal(attestation.runtime, 'aws-nitro');
  assert.ok(captured.signal instanceof AbortSignal);
});
