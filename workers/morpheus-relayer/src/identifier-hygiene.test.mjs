// Identifier hygiene (OR-W2-09, relayer side): the on-chain kernels hash the
// stored request identifier bytes VERBATIM, so the relayer's fulfillment digests
// must cover the exact same bytes (no trimming), and whitespace-bearing
// identifiers must be rejected at ingestion with a classified (permanent) error.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ethers } from 'ethers';

import { buildFulfillmentDigestBytes } from './router.js';
import {
  classifyError,
  findWhitespaceIdentifier,
  processEvent,
  resolveEventFulfillmentContext,
  resolveFulfillmentSigningContext,
} from './fulfillment.js';
import { buildNeoN3EventFromRequestRecord } from './neo-n3.js';
import { scanNeoXOracleRequestsById } from './neox.js';
import { createEmptyRelayerState } from './state.js';

// Deterministic throwaway test key (not used anywhere live).
const TEST_PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest();
}

// Independent contract-mirroring recompute of the Neo N3 kernel digest
// (MorpheusOracle.ComputeFulfillmentDigest, unbound legacy-deployment form):
// domain || uint256(requestId) || sha256(appId) || sha256(moduleId) ||
// sha256(operation) || sha256(requestPayload) || successByte || sha256(result) || sha256(error).
function contractStyleN3Digest(
  requestId,
  appId,
  moduleId,
  operation,
  success,
  result,
  error,
  requestPayload = ''
) {
  return sha256(
    Buffer.concat([
      Buffer.from('miniapp-os-fulfillment-v2', 'utf8'),
      Buffer.from(BigInt(requestId).toString(16).padStart(64, '0'), 'hex'),
      sha256(Buffer.from(appId, 'utf8')),
      sha256(Buffer.from(moduleId, 'utf8')),
      sha256(Buffer.from(operation, 'utf8')),
      sha256(Buffer.from(requestPayload, 'utf8')),
      Buffer.from([success ? 1 : 0]),
      sha256(Buffer.from(result, 'utf8')),
      sha256(Buffer.from(error, 'utf8')),
    ])
  );
}

test('buildFulfillmentDigestBytes hashes kernel identifiers verbatim (matches the contract bytes)', () => {
  // The contract hashes the STORED identifier bytes exactly; an identifier with
  // whitespace must produce the contract's digest, not the trimmed one.
  const verbatim = buildFulfillmentDigestBytes('42', ' op ', true, '{"ok":true}', ' e ', '', {
    chain: 'neo_n3',
    appId: ' app ',
    moduleId: ' module ',
    operation: ' op ',
  });
  const expected = contractStyleN3Digest(
    '42',
    ' app ',
    ' module ',
    ' op ',
    true,
    '{"ok":true}',
    ' e '
  );
  assert.deepEqual(verbatim, expected);

  const trimmedInputs = buildFulfillmentDigestBytes('42', 'op', true, '{"ok":true}', 'e', '', {
    chain: 'neo_n3',
    appId: 'app',
    moduleId: 'module',
    operation: 'op',
  });
  assert.notDeepEqual(verbatim, trimmedInputs);
});

test('buildFulfillmentDigestBytes hashes the legacy requestType and error verbatim', () => {
  const padded = buildFulfillmentDigestBytes('7', ' compute ', false, '', ' failed ', '', {
    chain: 'legacy',
  });
  const trimmed = buildFulfillmentDigestBytes('7', 'compute', false, '', 'failed', '', {
    chain: 'legacy',
  });
  assert.notDeepEqual(padded, trimmed);
});

// ── Cross-language golden vector (R2-3.1) ────────────────────────────────────
// The tests above pin the JS digest against a JS re-implementation of the contract's
// algorithm — which stays green if BOTH drift together. This test pins the JS output to
// FIXED expected hex for a canonical vector, so any drift in buildFulfillmentDigestBytes
// (a field reorder, a domain-string change, an encoding bug) fails here. The SAME vector
// is asserted independently by the Neo C# suite (MorpheusOracleGoldenDigestTests), so a
// drift on EITHER side breaks one of the two suites. The bound vector uses the live
// deployment-binding path (contractScriptHash + networkMagic), matching the C# harness.
//
// Vector: requestId=42, appId='demo.app', moduleId='oracle.fetch', operation='fetch',
//         success=true, result='{"v":1}', error='', requestType='oracle_query'.
//         Bound: scriptHash=0x1212...1212, networkMagic=894710606 (testnet default).
test('N3 fulfillment digest matches the cross-language golden vector (bound + unbound)', () => {
  // Unbound (legacy/older-deployment form, no contract/magic suffix).
  const unbound = buildFulfillmentDigestBytes('42', 'oracle_query', true, '{"v":1}', '', '', {
    chain: 'neo_n3',
    appId: 'demo.app',
    moduleId: 'oracle.fetch',
    operation: 'fetch',
    payloadHex: '010203',
  }).toString('hex');
  assert.equal(
    unbound,
    'f212156d681619b49c52cdd67059253f788249b528b8fab9d7d7b120be9a4380',
    'unbound N3 digest drifted from the golden vector (cross-language parity broken)'
  );

  // Bound (live deployment-binding form): contractScriptHash + networkMagic appended.
  const bound = buildFulfillmentDigestBytes('42', 'oracle_query', true, '{"v":1}', '', '', {
    chain: 'neo_n3',
    appId: 'demo.app',
    moduleId: 'oracle.fetch',
    operation: 'fetch',
    payloadHex: '010203',
    contractScriptHash: '0x1212121212121212121212121212121212121212',
    networkMagic: 894710606,
  }).toString('hex');
  assert.equal(
    bound,
    '2ab9c0ca2902504a50c71404d71f7c8231aadebf816cdde61c553df34f8672dc',
    'bound N3 digest drifted from the golden vector (cross-language parity broken)'
  );
});

test('resolveFulfillmentSigningContext passes identifiers through verbatim', () => {
  assert.deepEqual(
    resolveFulfillmentSigningContext('neo_n3', {
      appId: ' miniapp-os ',
      moduleId: ' oracle.fetch ',
      operation: ' privacy_oracle ',
    }),
    {
      chain: 'neo_n3',
      appId: ' miniapp-os ',
      moduleId: ' oracle.fetch ',
      operation: ' privacy_oracle ',
    }
  );
  // A whitespace-only appId is a NON-empty on-chain value: it must select the
  // kernel digest domain (the contract hashes ' '), not the legacy domain.
  assert.equal(resolveFulfillmentSigningContext('neo_n3', { appId: ' ' }).chain, 'neo_n3');
  // A genuinely empty appId still maps to the legacy domain.
  assert.equal(resolveFulfillmentSigningContext('neo_n3', { appId: '' }).chain, 'legacy');
});

test('resolveEventFulfillmentContext keeps on-chain identifier bytes verbatim', () => {
  assert.deepEqual(
    resolveEventFulfillmentContext(
      { appId: ' app ', moduleId: ' m ', operation: ' o ' },
      { moduleId: 'kernel.module', operation: 'kernel_op' }
    ),
    { appId: ' app ', moduleId: ' m ', operation: ' o ' }
  );
  // The kernel-intent mapping only fills genuinely absent fields.
  assert.deepEqual(
    resolveEventFulfillmentContext({}, { moduleId: 'kernel.module', operation: 'kernel_op' }),
    { appId: '', moduleId: 'kernel.module', operation: 'kernel_op' }
  );
});

test('findWhitespaceIdentifier flags whitespace-bearing identifiers and classifies as permanent', () => {
  assert.deepEqual(
    findWhitespaceIdentifier({
      appId: 'ok',
      moduleId: 'ok',
      operation: 'bad op',
      requestType: 'ok',
    }),
    { field: 'operation', value: 'bad op' }
  );
  assert.deepEqual(findWhitespaceIdentifier({ appId: ' padded' }), {
    field: 'appId',
    value: ' padded',
  });
  assert.equal(
    findWhitespaceIdentifier({
      appId: 'miniapp-os',
      moduleId: 'oracle.fetch',
      operation: 'privacy_oracle',
      requestType: 'privacy_oracle',
    }),
    null
  );
  // The thrown ingestion error must classify as permanent so processEvent skips
  // the worker/retry lanes and finalizes the request on-chain.
  assert.equal(
    classifyError(new Error('invalid identifier: request 7 field appId contains whitespace')).level,
    'permanent'
  );
});

test('buildNeoN3EventFromRequestRecord surfaces whitespace-bearing identifiers verbatim', () => {
  // 14-field kernel record with padded identifiers: the event must carry the
  // exact on-chain bytes so ingestion can detect and reject them.
  const decoded = [
    '7',
    ' app',
    'oracle.fetch',
    ' privacy_oracle ',
    '{}',
    'requester',
    '',
    '0xcb',
    '',
    '1700000000000',
    '0',
    '1',
    '',
    '',
  ];
  const event = buildNeoN3EventFromRequestRecord(decoded, 7);
  assert.ok(event, 'pending request with whitespace identifiers must surface');
  assert.equal(event.appId, ' app');
  assert.equal(event.operation, ' privacy_oracle ');
  assert.equal(event.requestType, ' privacy_oracle ');
});

test('Neo X scan carries on-chain identifier bytes verbatim', async () => {
  const stub = {
    getRequest: async (id) => ({
      id: BigInt(id),
      appId: ' vrf-e2e ',
      moduleId: ' random.generate',
      operation: 'random ',
      payload: '0x',
      requester: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      callbackContract: ethers.ZeroAddress,
      status: 1,
      createdAt: 1n,
      fulfilledAt: 0n,
      success: false,
      resultBytes: '0x',
      errorText: '',
    }),
  };
  const config = { concurrency: 1, neox: { chainId: 47763, oracleContract: ethers.ZeroAddress } };
  const [event] = await scanNeoXOracleRequestsById(config, 1, 1, stub);
  assert.equal(event.appId, ' vrf-e2e ');
  assert.equal(event.moduleId, ' random.generate');
  assert.equal(event.operation, 'random ');
});

test('ingestion rejects whitespace identifiers and finalizes with a contract-verifiable signature', async () => {
  // End-to-end through processEvent on the Neo X lane (its verifier signs
  // locally from config, no enclave): a whitespace appId must
  //   1. never reach a worker route (rejected before routing),
  //   2. finalize on-chain as a failure with an 'invalid identifier' error,
  //   3. carry a signature over the VERBATIM identifier bytes — i.e. the exact
  //      digest the deployed kernel recomputes (independent recompute below).
  const captured = [];
  const config = {
    network: 'testnet',
    maxRetries: 3,
    retryBaseDelayMs: 10,
    retryMaxDelayMs: 100,
    processedCacheSize: 100,
    deadLetterLimit: 10,
    durableQueue: { enabled: false },
    neox: {
      chainId: 47763,
      oracleContract: '0xeCFC1C652B5cCdBfe3E9314a83156787D92a3fD2',
      updaterPrivateKey: TEST_PK,
      verifierPrivateKey: TEST_PK,
    },
    hooks: {
      fulfillNeoRequest: async (invocation) => {
        captured.push(invocation);
        return { tx_hash: '0xfinalize', vm_state: 'HALT', target_chain: 'neox' };
      },
    },
  };
  const event = {
    chain: 'neox',
    requestId: '9',
    requestType: 'random',
    appId: ' vrf-e2e',
    moduleId: 'random.generate',
    operation: 'random',
    txHash: '',
    logIndex: 0,
    blockNumber: 1,
  };
  const state = createEmptyRelayerState();
  const silentLogger = { info() {}, warn() {}, error() {} };

  const outcome = await processEvent(config, state, () => {}, silentLogger, event);

  assert.equal(captured.length, 1, 'expected exactly one failure-finalize submission');
  const { fulfillment, verification } = captured[0];
  assert.equal(fulfillment.success, false);
  assert.match(fulfillment.error, /invalid identifier/);
  assert.match(fulfillment.error, /appId/);
  assert.equal(outcome.result.route, 'failure-finalize');

  // Independent, contract-mirroring digest recompute (MorpheusOracleEVM
  // fulfillmentDigest) using the VERBATIM on-chain identifier bytes. If the
  // relayer trimmed any digest input, this verification would fail.
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    [
      'string',
      'uint256',
      'address',
      'uint256',
      'bytes32',
      'bytes32',
      'bytes32',
      'bytes32',
      'bool',
      'bytes32',
      'bytes32',
    ],
    [
      'morpheus-evm-fulfillment-v2',
      47763n,
      ethers.getAddress(config.neox.oracleContract),
      9n,
      ethers.keccak256(ethers.toUtf8Bytes(' vrf-e2e')),
      ethers.keccak256(ethers.toUtf8Bytes('random.generate')),
      ethers.keccak256(ethers.toUtf8Bytes('random')),
      ethers.keccak256(ethers.toUtf8Bytes('')),
      false,
      ethers.keccak256(
        `0x${Buffer.from(String(fulfillment.result || ''), 'utf8').toString('hex')}`
      ),
      ethers.keccak256(ethers.toUtf8Bytes(fulfillment.error)),
    ]
  );
  const expectedDigest = ethers.keccak256(encoded);
  const signerAddress = ethers.verifyMessage(
    ethers.getBytes(expectedDigest),
    verification.signature
  );
  assert.equal(signerAddress, new ethers.Wallet(TEST_PK).address);
});
