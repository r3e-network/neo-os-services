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

  it('binds Neo N3 fulfillment signatures to the contract and network', () => {
    const input = {
      requestId: 4450,
      requestType: 'privacy_oracle',
      success: true,
      resultText: '{"price":"0"}',
      appId: 'demo.app',
      moduleId: 'oracle.fetch',
      operation: 'privacy_oracle',
      contractScriptHash: '0xf54d8584ef82315c1800373272ab08ae0db2d5ef',
      networkMagic: 894710606,
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
        {
          chain: 'neo_n3',
          appId: input.appId,
          moduleId: input.moduleId,
          operation: input.operation,
          contractScriptHash: input.contractScriptHash,
          networkMagic: input.networkMagic,
        }
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
        contractScriptHash: '0xf54d8584ef82315c1800373272ab08ae0db2d5ef',
        networkMagic: 894710606,
      }),
      {
        chain: 'legacy',
        contractScriptHash: '0xf54d8584ef82315c1800373272ab08ae0db2d5ef',
        networkMagic: 894710606,
      }
    );
  });
});
