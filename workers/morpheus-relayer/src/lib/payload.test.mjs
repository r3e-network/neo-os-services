import test from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';

import { buildFulfillmentDigestBytes } from '../router.js';
import { buildNeoXDigest } from '../neox.js';
import { signFulfillmentPayload } from '../fulfillment/signer.js';
import { deliverPreparedFulfillment } from '../fulfillment/delivery.js';
import { decodeJsonObjectPayload, requireRawPayloadHex, resolveEventPayload } from './payload.js';

const NEOX_CONFIG = {
  neox: {
    chainId: 47763,
    oracleContract: '0xeCFC1C652B5cCdBfe3E9314a83156787D92a3fD2',
  },
};

test('raw payload validation distinguishes explicit empty bytes from missing input', () => {
  assert.equal(requireRawPayloadHex({ payloadHex: '0x' }), '0x');
  assert.equal(requireRawPayloadHex({ payloadHex: 'ff' }), 'ff');
  assert.equal(requireRawPayloadHex({ payloadHex: '0X00ff' }), '0X00ff');
  assert.deepEqual(resolveEventPayload({ payloadText: '', payloadHex: '0x' }), {
    payloadText: '',
    payloadHex: '0x',
    messageId: null,
  });

  for (const payloadHex of [undefined, null, '', '   ', 0, false, '0', 'zz']) {
    assert.throws(() => requireRawPayloadHex({ payloadHex }), /payloadHex/);
  }
  assert.throws(() => requireRawPayloadHex({}), /payloadHex is required/);
  assert.deepEqual(resolveEventPayload({ payloadText: 'a', payloadHex: '61', payload_hex: '61' }), {
    payloadText: 'a',
    payloadHex: '61',
    messageId: null,
  });
  assert.throws(
    () => resolveEventPayload({ payloadHex: 'ff', payload_hex: '00' }),
    /aliases disagree/
  );
});

test('JSON object decoding rejects typed non-objects without rejecting raw text', () => {
  assert.deepEqual(decodeJsonObjectPayload(''), {});
  assert.deepEqual(decodeJsonObjectPayload('{"op":"add"}'), { op: 'add' });
  assert.deepEqual(decodeJsonObjectPayload('not-json'), { raw_payload: 'not-json' });
  for (const text of ['[]', 'null', '"text"', '42', 'true']) {
    assert.throws(() => decodeJsonObjectPayload(text), /must be a JSON object/);
    assert.deepEqual(decodeJsonObjectPayload(text, { allowNonObject: true }), {});
  }
});

test('v2 digest builders never reconstruct missing raw payload from text', () => {
  assert.throws(
    () =>
      buildFulfillmentDigestBytes('7', 'compute', true, '', '', '', {
        chain: 'neo_n3',
        payloadText: '{}',
      }),
    /payloadHex is required/
  );
  assert.throws(
    () => buildNeoXDigest(NEOX_CONFIG, { requestId: '7', payloadText: '{}', payloadHex: '' }, '0x'),
    /payloadHex is required/
  );
});

test('all signing chains reject missing raw payload before custody or wallet access', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (...args) => {
    calls.push(args);
    throw new Error('custody must not be called');
  };
  const config = {
    network: 'testnet',
    nitro: { custodyUrl: 'https://custody.test', custodyToken: 'token' },
    neo_n3: {
      oracleContract: '0x1212121212121212121212121212121212121212',
      networkMagic: 894710606,
      custodyKeyIds: { oracle_verifier: 'verifier' },
    },
    neox: { ...NEOX_CONFIG.neox, verifierPrivateKey: 'not-a-key' },
  };
  try {
    for (const chain of ['neo_n3', 'neox']) {
      for (const payloadHex of [undefined, '', '   ']) {
        await assert.rejects(
          signFulfillmentPayload(config, chain, {
            requestId: '7',
            requestType: 'compute',
            appId: 'app',
            moduleId: 'compute.run',
            operation: 'compute',
            payloadText: '{}',
            payloadHex,
            success: false,
            result: '',
            error: 'failed',
          }),
          /payloadHex is required/
        );
      }
    }
  } finally {
    global.fetch = originalFetch;
  }
  assert.equal(calls.length, 0);
});

test('the signing entrypoint rejects non-object JSON before custody or wallet access', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (...args) => {
    calls.push(args);
    throw new Error('custody must not be called');
  };
  const config = {
    network: 'testnet',
    nitro: { custodyUrl: 'https://custody.test', custodyToken: 'token' },
    neo_n3: {
      oracleContract: '0x1212121212121212121212121212121212121212',
      networkMagic: 894710606,
      custodyKeyIds: { oracle_verifier: 'verifier' },
    },
    neox: {
      ...NEOX_CONFIG.neox,
      verifierPrivateKey: 'not-a-key',
    },
  };
  try {
    for (const chain of ['neo_n3', 'neox']) {
      for (const payloadText of ['[]', 'null', '"text"', '42', 'true']) {
        await assert.rejects(
          signFulfillmentPayload(config, chain, {
            requestId: '7',
            requestType: 'compute',
            appId: 'app',
            moduleId: 'compute.run',
            operation: 'compute',
            payloadText,
            payloadHex: Buffer.from(payloadText).toString('hex'),
            success: false,
            result: '',
            error: 'failed',
          }),
          /must be a JSON object/
        );
      }
    }
  } finally {
    global.fetch = originalFetch;
  }
  assert.equal(calls.length, 0);
});

test('raw bytes and supplied text must match before any signing or delivery', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (...args) => {
    calls.push(args);
    throw new Error('custody must not be called');
  };
  const config = {
    network: 'testnet',
    nitro: { custodyUrl: 'https://custody.test', custodyToken: 'token' },
    neo_n3: {
      oracleContract: '0x1212121212121212121212121212121212121212',
      networkMagic: 894710606,
      custodyKeyIds: { oracle_verifier: 'verifier' },
    },
    neox: { ...NEOX_CONFIG.neox, verifierPrivateKey: 'not-a-key' },
  };
  const fulfillment = (requestType, payloadText, payloadHex) => ({
    requestId: '7',
    requestType,
    appId: 'app',
    moduleId: requestType === 'decrypt' ? 'confidential.decrypt' : 'compute.run',
    operation: requestType,
    payloadText,
    payloadHex,
    success: false,
    result: '',
    error: 'failed',
  });
  try {
    for (const chain of ['neo_n3', 'neox']) {
      await assert.rejects(
        signFulfillmentPayload(config, chain, fulfillment('compute', '{}', '5b5d')),
        /payloadText does not match payloadHex/
      );
      for (const payloadText of [undefined, null]) {
        await assert.rejects(
          signFulfillmentPayload(config, chain, fulfillment('compute', payloadText, '5b5d')),
          /payloadText/
        );
      }
      assert.throws(
        () => resolveEventPayload({ payloadText: '{}', payload: '[]', payloadHex: '5b5d' }),
        /payloadText aliases disagree/
      );
    }
  } finally {
    global.fetch = originalFetch;
  }
  assert.equal(calls.length, 0);

  const abi = ethers.AbiCoder.defaultAbiCoder().encode(
    ['uint256', 'bytes'],
    [7, ethers.toUtf8Bytes('expected-envelope')]
  );
  const good = resolveEventPayload({
    chain: 'neox',
    requestType: 'decrypt',
    payloadText: 'expected-envelope',
    payloadHex: abi,
  });
  assert.deepEqual(good, { payloadText: 'expected-envelope', payloadHex: abi, messageId: '7' });
  await assert.rejects(
    signFulfillmentPayload(config, 'neox', fulfillment('decrypt', 'attacker-envelope', abi)),
    /payloadText does not match payloadHex/
  );
});

test('old durable prepared records without raw hex cannot be broadcast', async () => {
  let submissions = 0;
  await assert.rejects(
    deliverPreparedFulfillment(
      {
        hooks: {
          fulfillNeoRequest: async () => {
            submissions += 1;
            return { tx_hash: '0xmust-not-happen', vm_state: 'HALT' };
          },
        },
      },
      {
        chain: 'neo_n3',
        requestId: 'old-job',
        requestType: 'compute',
        payloadText: '{}',
      },
      {
        success: true,
        result: '{}',
        result_bytes_base64: '',
        error: '',
        verification_signature: 'already-signed',
      }
    ),
    /payloadHex is required/
  );
  assert.equal(submissions, 0);
});
