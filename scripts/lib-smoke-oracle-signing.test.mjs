import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { wallet } from '@cityofzion/neon-js';
import { buildFulfillmentDigestBytes } from '../workers/morpheus-relayer/src/router.js';

import * as smokeSigning from './lib-smoke-oracle-signing.mjs';

const { buildFulfillmentDigestHex, buildFulfillmentVerificationSignature } = smokeSigning;

describe('buildFulfillmentVerificationSignature', () => {
  it('signs the fulfillment digest with the verifier key instead of the updater key', () => {
    const verifierPrivateKey = '1'.repeat(64);
    const updaterPrivateKey = '2'.repeat(64);
    const input = {
      requestId: 4448,
      requestType: 'privacy_oracle',
      success: true,
      resultText: JSON.stringify({ provider: 'twelvedata', symbol: 'NEO-USD', price: '0' }),
    };

    const digestHex = buildFulfillmentDigestHex(input);
    const signature = buildFulfillmentVerificationSignature({
      ...input,
      signerPrivateKey: verifierPrivateKey,
    });

    assert.equal(signature, wallet.sign(digestHex, verifierPrivateKey));
    assert.notEqual(signature, wallet.sign(digestHex, updaterPrivateKey));
  });

  it('forwards the legacy fulfillment chain override used by live N3 contracts', () => {
    const input = {
      requestId: 4449,
      requestType: 'privacy_oracle',
      success: true,
      resultText: JSON.stringify({ provider: 'twelvedata', symbol: 'NEO-USD', price: '0' }),
      chain: 'legacy',
    };

    assert.equal(
      buildFulfillmentDigestHex(input),
      buildFulfillmentDigestBytes(
        input.requestId,
        input.requestType,
        input.success,
        input.resultText,
        '',
        '',
        { chain: 'legacy' }
      ).toString('hex')
    );
  });
});

describe('resolveFulfillmentSigningContext', () => {
  it('detects legacy request records and falls back to the legacy digest domain', () => {
    assert.equal(typeof smokeSigning.resolveFulfillmentSigningContext, 'function');
    assert.deepEqual(
      smokeSigning.resolveFulfillmentSigningContext({
        requestRecord: {
          request_id: '4449',
          request_type: 'privacy_oracle',
          callback_contract: '0x226f508c',
        },
      }),
      { chain: 'legacy' }
    );
  });
});
