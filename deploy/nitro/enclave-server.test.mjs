// Contract + golden-vector gate for deploy/nitro/enclave-server.mjs.
//
// That file is a reference, not a runtime (no image ships it). Since S5 it holds
// no Neo N3 key, so this gate proves four things:
//
//   1. The retired Neo N3 lanes (/oracle/fulfill and /feed/sign for neo_n3 /
//      legacy, /sign/payload, /keys/derived) answer 410 with error_code
//      neo_n3_signer_retired, name their replacement (workers/nitro-enclave-host),
//      and do so BEFORE any compute, price fetch or attestation runs.
//   2. The consensus-critical BYTES those lanes used to sign are still pinned,
//      key-free, by calling the canonical builders directly: the fulfillment
//      digest + result envelope (router.js) against golden vectors and negative
//      controls, and the updateFeeds / updateFeed tx messages (exported from the
//      server) against INDEPENDENT reconstructions of the feed-pusher's own
//      construction.
//   3. The NeoX lanes, left in place by owner decision, still compute + sign
//      end to end (digest + EIP-191 signature, EIP-1559 feed tx).
//   4. /provision validates before it writes (a refused or failing provision
//      leaves process.env unchanged), refuses every plaintext key name the Rust
//      port refuses (parity-checked against provision.rs), and keeps the
//      KMS-sealed runtime-token bootstrap/rotation contract.
//
// Compute is made deterministic by stubbing the worker `handler` through the
// test-only seam __setWorkerHandlerForTests (fixed price body, fixed 32-byte VRF
// randomness); the worker source is never touched.

import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import neonPkg from '@cityofzion/neon-js';
import { ethers } from 'ethers';

const { sc, tx, u, wallet: neoWallet } = neonPkg;

import {
  buildFulfillmentDigestBytes,
  buildOnchainResultEnvelope,
  encodeFulfillmentResult,
  resolveKernelIntent,
} from '../../workers/morpheus-relayer/src/router.js';
import { buildNeoXDigest, resolveResultBytesHex } from '../../workers/morpheus-relayer/src/neox.js';
import {
  NEO_N3_RETIRED_PLAINTEXT_KEY_ENV_NAMES,
  getPinnedNeoN3Role,
} from '../../scripts/lib-neo-signers.mjs';

// ---------------------------------------------------------------------------
// Test env, injected BEFORE importing the server. No Neo N3 key is set anywhere
// in this file: the server resolves none, and the byte checks need only public
// keys. Pinning stays ON (no MORPHEUS_ALLOW_UNPINNED_SIGNERS), so /attestation
// binds the registry's pinned verifier key.
// ---------------------------------------------------------------------------
process.env.MORPHEUS_NETWORK = 'testnet';
delete process.env.MORPHEUS_ALLOW_UNPINNED_SIGNERS;

// Pin the N3 magic the feed tx is signed under so the server + the independent
// test recompute use the SAME magic (default 860833102; explicit for clarity).
process.env.FEED_MAGIC = '860833102';

// feed-pusher.mjs runs a live cycle on import unless this is set — pin it before
// either the server OR this test imports it (both import planFeedUpdate from it).
process.env.FEED_PUSHER_SKIP_MAIN = '1';

// Deterministic test-only EVM verifier key (the NeoX lane still reads its key
// from process.env).
const NEOX_VERIFIER_PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const NEOX_VERIFIER_WALLET = new ethers.Wallet(NEOX_VERIFIER_PK);
process.env.MORPHEUS_NEOX_VERIFIER_PRIVATE_KEY = NEOX_VERIFIER_PK;

// Worker auth token so the (stubbed) compute path is consistent; the stub does not
// check it, but the server attaches it — set it so a non-stubbed path would work too.
process.env.NITRO_API_TOKEN = 'enclave-test-token';

// The sensitive endpoints (/oracle/fulfill, /feed/sign, /sign/payload, /provision)
// require the provisioned bearer token, exactly as the production relayer/feed
// callers send it. NITRO_API_TOKEN above seeds the enclave's trusted-token set, so
// dispatch calls to those routes carry AUTH; /health + /attestation stay open.
const AUTH = { authorization: 'Bearer ' + process.env.NITRO_API_TOKEN };
const TOKEN_ENV_KEYS = [
  'NITRO_SIGNER_TOKEN',
  'MORPHEUS_RUNTIME_TOKEN',
  'NITRO_API_TOKEN',
  'NITRO_SHARED_SECRET',
];

// Imported after env is set.
const enclave = await import('./enclave-server.mjs');
const {
  dispatch,
  __setWorkerHandlerForTests,
  __resetWorkerHandlerForTests,
  handleHealth,
  __setPriceFetcherForTests,
  __resetPriceFetcherForTests,
  __setAttestRunnerForTests,
  __resetAttestRunnerForTests,
  __setAsyncAttestRunnerForTests,
  __resetAsyncAttestRunnerForTests,
  buildUpdateFeedsTxMessage,
  buildUpdateFeedTxMessage,
  materializeOracleKeyFromKms,
  materializeNeoXVerifierKeyFromKms,
  materializeNeoXFeedKeyFromKms,
  materializeNeoDidSaltFromKms,
  __resetRuntimeProvisionStateForTests,
  __resetEnclaveNetworkIdentityForTests,
  NEO_N3_SIGNER_RETIRED_CODE,
  NEO_N3_SIGNER_REPLACEMENT,
  NODE_ONLY_PLAINTEXT_KEY_ENV_KEYS,
  PLAINTEXT_KEY_ENV_KEYS,
} = enclave;

import {
  FEED_NETWORK_DEFAULTS,
  encodeUpdateFeedInvocation,
} from '../feed-pusher/lib-feed-network.mjs';

const DEFAULT_FEED_ENV = Object.freeze({
  FEED_NETWORK: process.env.FEED_NETWORK,
  MORPHEUS_NETWORK: process.env.MORPHEUS_NETWORK,
  FEED_MAGIC: process.env.FEED_MAGIC,
});

function restoreDefaultFeedEnv() {
  for (const [key, value] of Object.entries(DEFAULT_FEED_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  __resetEnclaveNetworkIdentityForTests();
}

function alignEnclaveFeedIdentity(network) {
  const defaults = FEED_NETWORK_DEFAULTS[network];
  process.env.FEED_NETWORK = network;
  process.env.MORPHEUS_NETWORK = network;
  process.env.FEED_MAGIC = String(defaults.magic);
  __resetEnclaveNetworkIdentityForTests();
}

// Import planFeedUpdate from the feed-pusher INDEPENDENTLY (the SAME decision the
// server imports) so the feed byte checks recompute the planned arrays with the
// canonical function, not a copy.
const { planFeedUpdate } = await import('../feed-pusher/feed-pusher.mjs');

// The pinned updater's PUBLIC key per network — the only key material the tx
// builders take. No private key is needed to pin their bytes.
const UPDATER_PUBLIC_KEY = {
  mainnet: FEED_NETWORK_DEFAULTS.mainnet.updaterPub,
  testnet: FEED_NETWORK_DEFAULTS.testnet.updaterPub,
};

// ---------------------------------------------------------------------------
// Deterministic worker-handler stub. Returns a fixed Response per route so the
// NeoX pipeline (encode -> envelope -> digest -> sign) is exercised against a
// known body, and records every route it is asked for so a retired lane can be
// shown to compute NOTHING.
// ---------------------------------------------------------------------------

const FIXED_PRICE_BODY = {
  mode: 'oracle',
  result: '65000.12345678',
  extracted_value: '65000.12345678',
  price: '65000.12345678',
  symbol: 'BTC/USD',
  decimals: 8,
  timestamp: 1718352000,
  sources: ['twelvedata'],
  verification: {
    output_hash: 'a'.repeat(64),
    attestation_hash: 'b'.repeat(64),
    signature: 'c'.repeat(128),
    public_key: 'd'.repeat(66),
    signer_address: 'NTEST',
    signer_script_hash: '0x' + 'e'.repeat(40),
  },
};

const FIXED_VRF_RANDOMNESS = '11'.repeat(32); // fixed 32-byte randomness

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function withRawPayload(request) {
  const payloadText = request.payload_text ?? JSON.stringify(request.payload ?? {});
  return {
    ...request,
    payload_text: payloadText,
    payload_hex: request.payload_hex ?? Buffer.from(payloadText).toString('hex'),
    request_context: request.request_context || {},
  };
}

let workerCalls = [];
let workerPayloads = [];

function installDeterministicWorker() {
  workerCalls = [];
  workerPayloads = [];
  __setWorkerHandlerForTests(async (request) => {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, '');
    workerPayloads.push({ path, payload: await request.json() });
    workerCalls.push(path);
    if (path.endsWith('/vrf/random')) {
      return jsonResponse(200, { request_id: '1', randomness: FIXED_VRF_RANDOMNESS });
    }
    if (path.endsWith('/oracle/query') || path.endsWith('/oracle/feed')) {
      return jsonResponse(200, { ...FIXED_PRICE_BODY });
    }
    if (path.endsWith('/oracle/public-key')) {
      return jsonResponse(200, {
        algorithm: 'X25519-HKDF-SHA256-AES-256-GCM',
        public_key: 'TEST_PUBLIC_KEY_BASE64',
      });
    }
    // default: echo a generic oracle body
    return jsonResponse(200, { ...FIXED_PRICE_BODY });
  });
}

// A retired lane must reach neither the NSM helper nor the price fetcher.
function installTripwires() {
  const calls = { attest: 0, price: 0 };
  __setAsyncAttestRunnerForTests(() => {
    calls.attest += 1;
    throw new Error('a retired lane must not attest');
  });
  __setPriceFetcherForTests(async () => {
    calls.price += 1;
    throw new Error('a retired lane must not fetch prices');
  });
  return calls;
}

function removeTripwires() {
  __resetAsyncAttestRunnerForTests();
  __resetPriceFetcherForTests();
}

// The 410 contract every retired Neo N3 surface answers.
function assertRetired({ status, body }, route) {
  assert.equal(status, 410, `${route}: expected 410, got ${status}: ${JSON.stringify(body)}`);
  assert.equal(body.status, 'error');
  assert.equal(body.error_code, NEO_N3_SIGNER_RETIRED_CODE);
  assert.equal(body.error_code, 'neo_n3_signer_retired');
  assert.equal(body.route, route);
  assert.equal(body.replacement, NEO_N3_SIGNER_REPLACEMENT);
  assert.equal(body.replacement, 'workers/nitro-enclave-host');
  assert.match(body.error, /workers\/nitro-enclave-host/);
  assert.match(body.error, /\bS5\b/);
  assert.equal(body.runtime, 'morpheus-enclave-server');
  for (const field of ['signature', 'public_key', 'fulfillment_digest_hex', 'tx_message_hex']) {
    assert.equal(body[field], undefined, `${route}: a retired lane returns no ${field}`);
  }
}

before(() => {
  installDeterministicWorker();
});

beforeEach(() => {
  installDeterministicWorker();
  restoreDefaultFeedEnv();
});

// Recompute the workerResponse the stub produces for a given request type, so the
// tests drive the imported builders exactly as the server's compute would.
function expectedWorkerResponse(requestType) {
  const intent = resolveKernelIntent(requestType);
  if (intent.moduleId === 'random.generate') {
    return { ok: true, status: 200, body: { request_id: '1', randomness: FIXED_VRF_RANDOMNESS } };
  }
  return { ok: true, status: 200, body: { ...FIXED_PRICE_BODY } };
}

// Golden vectors: the canonical builders' output for the fixed inputs below. A
// change here is a change to what the on-chain verifier checks — regenerate only
// together with the Rust vectors (scripts/export-rust-vectors.mjs).
const GOLDEN = Object.freeze({
  appIdDigest: 'a2149d434c63cfbc21efd854f761b6975ca7f0309755146e14a40f389ccfad45',
  legacyDigest: '9c91d9ccdca6f0207099205969760e9ae92567d1eca31b74cf44b1c6de1b529b',
  vrfDigest: '0fe3db94c8c7bd7207410d167e7b932aa7d1301d994285cef88a2cf47c55b83f',
  // sha256 of the encoded on-chain `result` string (the result envelope JSON).
  priceResultSha256: '2c4c4a3c0f486d6a76a917cc8e26c97886d52be1ce6bc05607f35eccd424accb',
});

// ---------------------------------------------------------------------------
// neo_n3 (with appId) — 410; full kernel envelope digest pinned key-free.
// ---------------------------------------------------------------------------

test('neo_n3 (with appId): lane answers 410; digest + envelope bytes pinned via the builders', async () => {
  const requestType = 'oracle_query';
  const requestId = '4242';
  const contractScriptHash = '0x' + '1f'.repeat(20);
  const networkMagic = 894710606; // Neo N3 testnet
  const appId = 'demo.app';
  const moduleId = resolveKernelIntent(requestType).moduleId;
  const operation = resolveKernelIntent(requestType).operation;

  const req = withRawPayload({
    chain: 'neo_n3',
    request_type: requestType,
    request_id: requestId,
    payload: { symbol: 'BTC/USD', requester: '0x' + 'aa'.repeat(20) },
    fulfillment_context: {
      app_id: appId,
      module_id: moduleId,
      operation,
      contract_script_hash: contractScriptHash,
      network_magic: networkMagic,
    },
    nonce: 'deadbeef',
  });

  const tripwires = installTripwires();
  try {
    assertRetired(
      await dispatch('POST', '/oracle/fulfill', AUTH, JSON.stringify(req)),
      '/oracle/fulfill'
    );
    assert.match(
      (await dispatch('POST', '/oracle/fulfill', AUTH, JSON.stringify(req))).body.error,
      /\/signer\/api\/v1\/sign\/raw.*SIGNER_ROLE_ORACLE_VERIFIER_KEY_ID/
    );
    assert.deepEqual(workerCalls, [], 'a retired lane computes nothing');
    assert.deepEqual(tripwires, { attest: 0, price: 0 });
  } finally {
    removeTripwires();
  }

  // Key-free byte checks: the SAME workerResponse through the canonical builders.
  const workerResponse = expectedWorkerResponse(requestType);
  const fulfillment = encodeFulfillmentResult(requestType, workerResponse);
  const envelope = buildOnchainResultEnvelope(requestType, workerResponse);
  assert.equal(fulfillment.success, true);
  // The on-chain result bytes ARE the result envelope, and both are pinned.
  assert.deepEqual(JSON.parse(fulfillment.result), envelope);
  assert.equal(envelope.version, 'morpheus-result/v1');
  assert.equal(envelope.module_id, moduleId);
  assert.equal(
    createHash('sha256').update(fulfillment.result, 'utf8').digest('hex'),
    GOLDEN.priceResultSha256
  );

  const digest = buildFulfillmentDigestBytes(
    requestId,
    requestType,
    fulfillment.success,
    fulfillment.result || '',
    fulfillment.error || '',
    fulfillment.result_bytes_base64 || '',
    {
      chain: 'neo_n3',
      appId,
      moduleId,
      operation,
      payloadHex: req.payload_hex,
      contractScriptHash,
      networkMagic,
    }
  ).toString('hex');
  assert.equal(digest, GOLDEN.appIdDigest, 'fulfillment digest must be byte-exact');

  // Negative controls: a digest WITHOUT the deployment binding (a common
  // re-derivation mistake), or bound to another network's magic, must differ.
  const digestNoBinding = buildFulfillmentDigestBytes(
    requestId,
    requestType,
    fulfillment.success,
    fulfillment.result || '',
    fulfillment.error || '',
    fulfillment.result_bytes_base64 || '',
    { chain: 'neo_n3', appId, moduleId, operation, payloadHex: req.payload_hex } // no contractScriptHash/networkMagic
  ).toString('hex');
  assert.notEqual(digest, digestNoBinding, 'digest must include the deployment binding');
  const digestMainnetMagic = buildFulfillmentDigestBytes(
    requestId,
    requestType,
    fulfillment.success,
    fulfillment.result || '',
    fulfillment.error || '',
    fulfillment.result_bytes_base64 || '',
    {
      chain: 'neo_n3',
      appId,
      moduleId,
      operation,
      payloadHex: req.payload_hex,
      contractScriptHash,
      networkMagic: 860833102,
    }
  ).toString('hex');
  assert.notEqual(digest, digestMainnetMagic, 'digest must bind the network magic');
});

// ---------------------------------------------------------------------------
// legacy neo_n3 (no appId) — 410; legacy digest domain pinned key-free.
// ---------------------------------------------------------------------------

test('legacy neo_n3 (no appId): lane answers 410; legacy digest pinned via the builders', async () => {
  const requestType = 'oracle_query';
  const requestId = '7';

  const req = withRawPayload({
    chain: 'legacy',
    request_type: requestType,
    request_id: requestId,
    payload: { symbol: 'BTC/USD' },
    fulfillment_context: {}, // no appId -> legacy domain
    nonce: '',
  });

  assertRetired(
    await dispatch('POST', '/oracle/fulfill', AUTH, JSON.stringify(req)),
    '/oracle/fulfill'
  );
  assert.deepEqual(workerCalls, []);

  const workerResponse = expectedWorkerResponse(requestType);
  const fulfillment = encodeFulfillmentResult(requestType, workerResponse);
  const digest = buildFulfillmentDigestBytes(
    requestId,
    requestType,
    fulfillment.success,
    fulfillment.result || '',
    fulfillment.error || '',
    fulfillment.result_bytes_base64 || '',
    { chain: 'legacy', appId: '', moduleId: '', operation: '', payloadHex: req.payload_hex }
  ).toString('hex');
  assert.equal(digest, GOLDEN.legacyDigest, 'legacy digest must be byte-exact');
  // Domain separation: the same request under the kernel (appId) domain differs.
  assert.notEqual(digest, GOLDEN.appIdDigest);
});

// ---------------------------------------------------------------------------
// neo_n3 VRF (with FIXED randomness) — 410; compact callback bytes pinned.
// ---------------------------------------------------------------------------

test('neo_n3 vrf (fixed randomness): lane answers 410; compact callback bytes + digest pinned', async () => {
  const requestType = 'random';
  const requestId = '99';
  const appId = 'dice.app';
  const moduleId = resolveKernelIntent(requestType).moduleId; // random.generate
  const operation = resolveKernelIntent(requestType).operation;
  const contractScriptHash = '0x' + '2c'.repeat(20);
  const networkMagic = 894710606;

  const req = withRawPayload({
    chain: 'neo_n3',
    request_type: requestType,
    request_id: requestId,
    payload: {},
    fulfillment_context: {
      app_id: appId,
      module_id: moduleId,
      operation,
      contract_script_hash: contractScriptHash,
      network_magic: networkMagic,
    },
  });

  assertRetired(
    await dispatch('POST', '/oracle/fulfill', AUTH, JSON.stringify(req)),
    '/oracle/fulfill'
  );
  assert.deepEqual(workerCalls, [], 'the VRF is not even computed on a retired lane');

  const workerResponse = expectedWorkerResponse(requestType);
  const fulfillment = encodeFulfillmentResult(requestType, workerResponse);
  // VRF -> compact 32-byte randomness as result_bytes_base64, empty result string.
  assert.equal(fulfillment.result, '');
  assert.ok(fulfillment.result_bytes_base64, 'vrf must produce compact callback bytes');
  // The compact bytes must decode to the fixed randomness.
  assert.equal(
    Buffer.from(fulfillment.result_bytes_base64, 'base64').toString('hex'),
    FIXED_VRF_RANDOMNESS,
    'compact callback bytes must equal the fixed VRF randomness'
  );

  const digest = buildFulfillmentDigestBytes(
    requestId,
    requestType,
    fulfillment.success,
    fulfillment.result || '',
    fulfillment.error || '',
    fulfillment.result_bytes_base64 || '',
    {
      chain: 'neo_n3',
      appId,
      moduleId,
      operation,
      payloadHex: req.payload_hex,
      contractScriptHash,
      networkMagic,
    }
  ).toString('hex');
  assert.equal(digest, GOLDEN.vrfDigest, 'vrf digest must be byte-exact');
});

// ---------------------------------------------------------------------------
// neox (EVM) — keccak digest + EIP-191 signature. The NeoX lane still signs.
// ---------------------------------------------------------------------------

test('neox: keccak digest + envelope + EIP-191 signature byte-exact', async () => {
  const requestType = 'oracle_query';
  const requestId = '123';
  const appId = 'evm.app';
  const moduleId = resolveKernelIntent(requestType).moduleId;
  const operation = resolveKernelIntent(requestType).operation;
  const chainId = 12227332; // Neo X testnet
  const oracleContract = '0xeCFC1C652B5cCdBfe3E9314a83156787D92a3fD2';

  const req = withRawPayload({
    chain: 'neox',
    request_type: requestType,
    request_id: requestId,
    payload: { symbol: 'BTC/USD' },
    fulfillment_context: {
      app_id: appId,
      module_id: moduleId,
      operation,
      chain_id: chainId,
      oracle_contract: oracleContract,
    },
  });

  const { status, body } = await dispatch('POST', '/oracle/fulfill', AUTH, JSON.stringify(req));
  assert.equal(status, 200, `dispatch failed: ${JSON.stringify(body)}`);
  assert.equal(body.trust_tier, 'enclave-attested');

  const workerResponse = expectedWorkerResponse(requestType);
  const fulfillment = encodeFulfillmentResult(requestType, workerResponse);
  const expectedEnvelope = buildOnchainResultEnvelope(requestType, workerResponse);

  const neoxConfig = { neox: { chainId, oracleContract, verifierPrivateKey: NEOX_VERIFIER_PK } };
  const evmFulfillment = {
    requestId,
    appId,
    moduleId,
    operation,
    payloadText: req.payload_text,
    payloadHex: req.payload_hex,
    success: fulfillment.success,
    result: fulfillment.result || '',
    result_bytes_base64: fulfillment.result_bytes_base64 || '',
    error: fulfillment.error || '',
  };
  const resultBytesHex = resolveResultBytesHex(
    evmFulfillment.result,
    evmFulfillment.result_bytes_base64
  );
  const expectedDigest = buildNeoXDigest(neoxConfig, evmFulfillment, resultBytesHex);

  assert.equal(
    body.fulfillment_digest_hex,
    expectedDigest,
    'neox keccak digest must be byte-exact'
  );
  assert.deepEqual(body.verification, expectedEnvelope);

  // EIP-191 personal-sign recovery: recovered address == verifier wallet address.
  assert.equal(
    body.public_key.toLowerCase(),
    NEOX_VERIFIER_WALLET.signingKey.publicKey.toLowerCase()
  );
  const recovered = ethers.verifyMessage(
    ethers.getBytes(body.fulfillment_digest_hex),
    body.signature
  );
  assert.equal(
    recovered.toLowerCase(),
    NEOX_VERIFIER_WALLET.address.toLowerCase(),
    'neox signature must recover to the verifier address over the digest'
  );
});

function validNeoXPayloadRequest() {
  return withRawPayload({
    chain: 'neox',
    request_type: 'oracle_query',
    request_id: '9001',
    payload: { symbol: 'BTC/USD' },
    fulfillment_context: {
      app_id: 'evm.app',
      module_id: 'oracle.fetch',
      operation: 'oracle_query',
      chain_id: 12227332,
      oracle_contract: '0xeCFC1C652B5cCdBfe3E9314a83156787D92a3fD2',
    },
  });
}

test('fulfill rejects a substituted execution object before compute or signing', async () => {
  const request = validNeoXPayloadRequest();
  request.payload = { symbol: 'EVIL/USD' };
  await assert.rejects(enclave.handleOracleFulfill(request), /payload object does not match/);
  assert.deepEqual(workerCalls, []);
});

test('fulfill rejects every non-object JSON type before compute or signing', async () => {
  for (const payloadText of ['[]', 'null', '"text"', '42', 'true']) {
    const request = validNeoXPayloadRequest();
    request.payload = {};
    request.payload_text = payloadText;
    request.payload_hex = Buffer.from(payloadText).toString('hex');
    await assert.rejects(enclave.handleOracleFulfill(request), /must be a JSON object/);
  }
  assert.deepEqual(workerCalls, []);
});

test('fulfill requires raw payload and rejects conflicting aliases before compute', async () => {
  const missing = validNeoXPayloadRequest();
  delete missing.payload_hex;
  await assert.rejects(enclave.handleOracleFulfill(missing), /payloadHex is required/);

  const conflict = validNeoXPayloadRequest();
  conflict.payloadHex = '00';
  await assert.rejects(enclave.handleOracleFulfill(conflict), /aliases disagree/);
  assert.deepEqual(workerCalls, []);
});

test('fulfill derives worker context from request_context instead of payload', async () => {
  const requester = '0x' + 'aa'.repeat(20);
  const callbackContract = '0x' + 'bb'.repeat(20);
  const request = validNeoXPayloadRequest();
  request.request_context = {
    requester,
    callback_contract: callbackContract,
    callback_method: 'onOracleResult',
  };
  await enclave.handleOracleFulfill(request);
  const worker = workerPayloads.at(-1);
  assert.equal(worker.path, '/oracle/smart-fetch');
  assert.equal(worker.payload.requester, requester);
  assert.equal(worker.payload.callback_contract, callbackContract);
  assert.equal(worker.payload.callback_method, 'onOracleResult');
  assert.equal(worker.payload.symbol, 'BTC/USD');
});

test('fulfill derives NeoX confidential envelope and message binding from raw ABI', async () => {
  const envelope = 'sealed-envelope-bytes';
  const abiPayload = ethers.AbiCoder.defaultAbiCoder().encode(
    ['uint256', 'bytes'],
    [42, ethers.toUtf8Bytes(envelope)]
  );
  const oracleContract = '0xeCFC1C652B5cCdBfe3E9314a83156787D92a3fD2';
  const request = {
    chain: 'neox',
    request_type: 'decrypt',
    request_id: '9002',
    payload: { raw_payload: envelope },
    payload_text: envelope,
    payload_hex: abiPayload,
    request_context: { contract: oracleContract },
    fulfillment_context: {
      app_id: 'evm.app',
      module_id: 'confidential.decrypt',
      operation: 'decrypt',
      chain_id: 12227332,
      oracle_contract: oracleContract,
    },
  };
  await enclave.handleOracleFulfill(request);
  const worker = workerPayloads.at(-1);
  assert.equal(worker.path, '/oracle/decrypt');
  assert.deepEqual(worker.payload, {
    envelope,
    message_id: '42',
    chain: 'neox',
    contract: oracleContract,
  });

  const before = workerCalls.length;
  request.payload = { envelope: 'attacker-controlled-envelope' };
  await assert.rejects(
    enclave.handleOracleFulfill(request),
    /confidential payload object does not match/
  );
  assert.equal(workerCalls.length, before);
});

// ---------------------------------------------------------------------------
// Host-unattested lane: arbitrary-URL smart-fetch is NOT signed in-enclave.
// ---------------------------------------------------------------------------

test('arbitrary-url smart-fetch: host-unattested on neox; the retired neo_n3 lane answers 410 first', async () => {
  // smart-fetch is the host-tier lane.
  assert.equal(resolveKernelIntent('privacy_oracle').workerRoute, '/oracle/smart-fetch');

  const neox = withRawPayload({
    chain: 'neox',
    request_type: 'privacy_oracle', // -> oracle.fetch -> /oracle/smart-fetch
    request_id: '5',
    payload: { url: 'https://example.com/data' },
    fulfillment_context: { app_id: 'x' },
  });
  const { status, body } = await dispatch('POST', '/oracle/fulfill', AUTH, JSON.stringify(neox));
  assert.equal(status, 200);
  assert.equal(body.trust_tier, 'host-unattested');
  assert.equal(body.signature, null);
  assert.equal(body.fulfillment_digest_hex, null);
  assert.deepEqual(workerCalls, [], 'the host-tier lane is never computed in-enclave');

  // The Neo N3 lane is retired as a whole, including its host-tier marker.
  assertRetired(
    await dispatch('POST', '/oracle/fulfill', AUTH, JSON.stringify({ ...neox, chain: 'neo_n3' })),
    '/oracle/fulfill'
  );
});

// ---------------------------------------------------------------------------
// Neo N3 feed signing — 410; the updateFeeds / updateFeed tx bytes stay pinned
// by comparing the server's exported builders with INDEPENDENT reconstructions.
// ---------------------------------------------------------------------------

// Independently rebuild the EXACT updateFeeds tx feed-pusher.mjs pushNeoN3 builds
// (sc.createScript + tx.Transaction + getMessageForSigning), using raw neon-js —
// NOT the server's builder. This mirrors pushNeoN3 lines 300-336 precisely.
// txParams must include the nonce (tx.Transaction otherwise assigns a random one,
// making getMessageForSigning non-deterministic).
function feedPusherTxMessage(network, planned, txParams, updaterPublicKey) {
  const { P, R, PX, TS, AH, SS } = planned;
  const script = sc.createScript({
    scriptHash: FEED_NETWORK_DEFAULTS[network].feed,
    operation: 'updateFeeds',
    args: [
      sc.ContractParam.array(...P.map((x) => sc.ContractParam.string(x))),
      sc.ContractParam.array(...R.map((x) => sc.ContractParam.integer(x))),
      sc.ContractParam.array(...PX.map((x) => sc.ContractParam.integer(x))),
      sc.ContractParam.array(...TS.map((x) => sc.ContractParam.integer(x))),
      sc.ContractParam.array(...AH.map((x) => sc.ContractParam.byteArray(x))),
      sc.ContractParam.array(...SS.map((x) => sc.ContractParam.integer(x))),
    ],
  });
  const updaterScriptHash = neoWallet.getScriptHashFromPublicKey(updaterPublicKey);
  const txn = new tx.Transaction({
    nonce: txParams.nonce,
    signers: [{ account: updaterScriptHash, scopes: tx.WitnessScope.CalledByEntry }],
    validUntilBlock: txParams.blockCount + 500,
    script,
  });
  txn.systemFee = u.BigInteger.fromNumber(txParams.systemFee);
  txn.networkFee = u.BigInteger.fromNumber(txParams.networkFee);
  return txn.getMessageForSigning(FEED_NETWORK_DEFAULTS[network].magic);
}

// Independently rebuild the testnet per-pair updateFeed tx the way the feed-pusher
// does (rebuildUpdateFeedTxFromEnclavePlan): through its canonical invocation
// encoder encodeUpdateFeedInvocation, not the server's direct ContractParams.
function feedPusherPerPairTxMessage(network, planned, txParams, updaterPublicKey) {
  const invocation = encodeUpdateFeedInvocation({
    pair: planned.P[0],
    roundId: planned.R[0],
    price: planned.PX[0],
    timestamp: planned.TS[0],
    attestationHash: planned.AH[0],
    sourceSetId: planned.SS[0],
  });
  const script = sc.createScript({
    scriptHash: FEED_NETWORK_DEFAULTS[network].feed,
    operation: invocation.operation,
    args: [
      sc.ContractParam.string(invocation.params[0].value),
      sc.ContractParam.integer(Number(invocation.params[1].value)),
      sc.ContractParam.integer(Number(invocation.params[2].value)),
      sc.ContractParam.integer(Number(invocation.params[3].value)),
      sc.ContractParam.byteArray(invocation.params[4].value),
      sc.ContractParam.integer(Number(invocation.params[5].value)),
    ],
  });
  const txn = new tx.Transaction({
    nonce: txParams.nonce,
    signers: [
      {
        account: neoWallet.getScriptHashFromPublicKey(updaterPublicKey),
        scopes: tx.WitnessScope.CalledByEntry,
      },
    ],
    validUntilBlock: txParams.blockCount + 500,
    script,
  });
  txn.systemFee = u.BigInteger.fromNumber(txParams.systemFee);
  txn.networkFee = u.BigInteger.fromNumber(txParams.networkFee);
  return txn.getMessageForSigning(FEED_NETWORK_DEFAULTS[network].magic);
}

// The plan feed-pusher.mjs (and the retired lane) derives: planFeedUpdate from the
// feed-pusher, 1e6 scaling, AH = sha256(`${s}|${px}|${ts}`).slice(0, 32).
function planFeeds(symbols, prices, onchainState, now) {
  const planned = { P: [], R: [], PX: [], TS: [], AH: [], SS: [] };
  const skipped = [];
  for (const s of symbols) {
    if (!(s in prices)) continue;
    const state = onchainState[s] || { round: 0, price: 0, timestamp: 0 };
    const cur = { round: state.round, price: state.price, ts: state.timestamp };
    const px = Math.round(prices[s] * 1e6);
    const plan = planFeedUpdate(cur, prices[s], now);
    if (!plan.push) {
      skipped.push(s);
      continue;
    }
    planned.P.push('TWELVEDATA:' + s);
    planned.R.push(plan.round);
    planned.PX.push(px);
    planned.TS.push(plan.ts);
    planned.AH.push(
      createHash('sha256').update(`${s}|${px}|${plan.ts}`).digest('hex').slice(0, 32)
    );
    planned.SS.push(0);
  }
  return { planned, skipped };
}

test('feed/sign neo_n3: lane answers 410; updateFeeds tx bytes identical to feed-pusher', async () => {
  alignEnclaveFeedIdentity('mainnet');
  // Deterministic prices, fixed clock, and the on-chain state the feed-pusher
  // would read on the host.
  const FIXED_NOW = 1_780_000_000;
  const SYMBOLS = ['NEO-USD', 'GAS-USD', 'BTC-USD'];
  const STUB_PRICES = { 'NEO-USD': 5.25, 'GAS-USD': 2.1, 'BTC-USD': 65000.123456 };
  const ONCHAIN_STATE = {
    // NEO/BTC will push (price move / no prior record); GAS is unchanged+recent → skipped.
    'NEO-USD': { round: FIXED_NOW - 60, price: 5.0, timestamp: FIXED_NOW - 60 },
    'GAS-USD': { round: FIXED_NOW - 60, price: 2.1, timestamp: FIXED_NOW - 60 },
    'BTC-USD': { round: 0, price: 0, timestamp: 0 },
  };
  const TX_PARAMS = { block_count: 1234567, system_fee: 1234567, network_fee: 234567, nonce: 777 };

  const tripwires = installTripwires();
  try {
    const retired = await dispatch(
      'POST',
      '/feed/sign',
      AUTH,
      JSON.stringify({
        chain: 'neo_n3',
        symbols: SYMBOLS,
        onchain_state: ONCHAIN_STATE,
        now: FIXED_NOW,
        tx_params: TX_PARAMS,
        nonce: 'cafe',
      })
    );
    assertRetired(retired, '/feed/sign');
    assert.match(
      retired.body.error,
      /\/signer\/api\/v1\/sign\/transaction.*SIGNER_ROLE_UPDATER_KEY_ID/
    );
    assert.deepEqual(tripwires, { attest: 0, price: 0 }, 'no price fetch on a retired lane');
  } finally {
    removeTripwires();
  }

  // Key-free byte check: the plan the lane used to sign, through the server's
  // exported builder, equals the independent feed-pusher reconstruction.
  const { planned, skipped } = planFeeds(SYMBOLS, STUB_PRICES, ONCHAIN_STATE, FIXED_NOW);
  assert.deepEqual(planned.P, ['TWELVEDATA:NEO-USD', 'TWELVEDATA:BTC-USD']);
  assert.deepEqual(skipped, ['GAS-USD'], 'GAS-USD is recent + unchanged');
  const txParams = {
    blockCount: TX_PARAMS.block_count,
    systemFee: TX_PARAMS.system_fee,
    networkFee: TX_PARAMS.network_fee,
    nonce: TX_PARAMS.nonce,
  };
  const built = buildUpdateFeedsTxMessage(planned, txParams, UPDATER_PUBLIC_KEY.mainnet);
  assert.equal(
    built.message,
    feedPusherTxMessage('mainnet', planned, txParams, UPDATER_PUBLIC_KEY.mainnet),
    'feed tx message must be byte-identical to feed-pusher.mjs'
  );
  assert.equal(built.txn.nonce, TX_PARAMS.nonce, 'the pinned nonce is the reproducibility key');
  assert.equal(built.txn.validUntilBlock, TX_PARAMS.block_count + 500);
  // Negative control: another nonce is another message (the nonce is load-bearing).
  assert.notEqual(
    built.message,
    buildUpdateFeedsTxMessage(planned, { ...txParams, nonce: 778 }, UPDATER_PUBLIC_KEY.mainnet)
      .message
  );
});

test('feed/sign neo_n3: an updateFeed write_mode on mainnet answers 410 (nothing is signed to downgrade)', async () => {
  alignEnclaveFeedIdentity('mainnet');
  assertRetired(
    await dispatch(
      'POST',
      '/feed/sign',
      AUTH,
      JSON.stringify({
        chain: 'neo_n3',
        write_mode: 'updateFeed',
        symbols: ['NEO-USD'],
        now: 1_780_000_000,
        tx_params: { block_count: 1, system_fee: 1, network_fee: 1, nonce: 1 },
      })
    ),
    '/feed/sign'
  );
});

// GAP (owner decision pending, round-9 audit 3a): the testnet-only per-pair
// updateFeed write mode has NO other implementation. The Rust frontier
// (workers/nitro-enclave-host/src/feed_sign.rs) builds only the batch
// updateFeeds transaction, so retiring this lane leaves the feed-pusher's
// per-pair testnet path (deploy/feed-pusher, write_mode 'updateFeed') without an
// enclave signer. This test pins the 410 and the per-pair tx bytes; it does not
// port the mode.
test('feed/sign neo_n3: TestNet per-pair updateFeed answers 410; its tx bytes match the feed-pusher encoder', async () => {
  alignEnclaveFeedIdentity('testnet');
  const FIXED_NOW = 1_780_000_000;
  const tripwires = installTripwires();
  try {
    assertRetired(
      await dispatch(
        'POST',
        '/feed/sign',
        AUTH,
        JSON.stringify({
          chain: 'neo_n3',
          write_mode: 'updateFeed',
          symbols: ['NEO-USD'],
          onchain_state: {
            'NEO-USD': { round: FIXED_NOW - 3600, price: 5.0, timestamp: FIXED_NOW - 3600 },
          },
          now: FIXED_NOW,
          tx_params: { block_count: 100, system_fee: 1, network_fee: 1, nonce: 9 },
        })
      ),
      '/feed/sign'
    );
    assert.deepEqual(tripwires, { attest: 0, price: 0 });
  } finally {
    removeTripwires();
  }

  const { planned } = planFeeds(
    ['NEO-USD'],
    { 'NEO-USD': 5.25 },
    { 'NEO-USD': { round: FIXED_NOW - 3600, price: 5.0, timestamp: FIXED_NOW - 3600 } },
    FIXED_NOW
  );
  assert.deepEqual(planned.P, ['TWELVEDATA:NEO-USD']);
  const txParams = { nonce: 9, blockCount: 100, systemFee: 1, networkFee: 1 };
  const built = buildUpdateFeedTxMessage(planned, txParams, UPDATER_PUBLIC_KEY.testnet);
  assert.equal(
    built.message,
    feedPusherPerPairTxMessage('testnet', planned, txParams, UPDATER_PUBLIC_KEY.testnet),
    'the per-pair updateFeed message must be byte-identical to the feed-pusher encoder'
  );
  assert.throws(
    () => buildUpdateFeedTxMessage({ ...planned, P: [] }, txParams, UPDATER_PUBLIC_KEY.testnet),
    /exactly one planned pair/
  );
});

test('feed tx builders refuse a mismatched FEED_MAGIC / MORPHEUS_NETWORK before building', async () => {
  const planned = {
    P: ['TWELVEDATA:NEO-USD'],
    R: [7],
    PX: [5_250_000],
    TS: [1_780_000_000],
    AH: ['aa'],
    SS: [0],
  };
  const txParams = { nonce: 1, blockCount: 1, systemFee: 1, networkFee: 1 };

  process.env.FEED_NETWORK = 'testnet';
  process.env.MORPHEUS_NETWORK = 'testnet';
  process.env.FEED_MAGIC = '860833102'; // mainnet magic on a testnet identity
  __resetEnclaveNetworkIdentityForTests();
  assert.throws(
    () => buildUpdateFeedTxMessage(planned, txParams, UPDATER_PUBLIC_KEY.testnet),
    (error) => error.status === 400 && /FEED_MAGIC|split-brain|does not match/.test(error.message)
  );

  process.env.FEED_MAGIC = String(FEED_NETWORK_DEFAULTS.testnet.magic);
  process.env.MORPHEUS_NETWORK = 'mainnet';
  __resetEnclaveNetworkIdentityForTests();
  assert.throws(
    () => buildUpdateFeedsTxMessage(planned, txParams, UPDATER_PUBLIC_KEY.testnet),
    (error) =>
      error.status === 400 && /split-brain|FEED_NETWORK|MORPHEUS_NETWORK/.test(error.message)
  );

  // The route itself is retired whatever the identity says.
  assertRetired(
    await dispatch(
      'POST',
      '/feed/sign',
      AUTH,
      JSON.stringify({ chain: 'neo_n3', write_mode: 'updateFeed', symbols: ['NEO-USD'] })
    ),
    '/feed/sign'
  );
});

test('buildUpdateFeedTxMessage has no pinOverride escape and follows the bound identity', async () => {
  assert.equal(buildUpdateFeedTxMessage.length, 3);
  const planned = {
    P: ['TWELVEDATA:NEO-USD'],
    R: [7],
    PX: [5_250_000],
    TS: [1_780_000_000],
    AH: ['aa'],
    SS: [0],
  };
  const txParams = { nonce: 9, blockCount: 100, systemFee: 1, networkFee: 1 };
  alignEnclaveFeedIdentity('testnet');
  const testnet = buildUpdateFeedTxMessage(planned, txParams, UPDATER_PUBLIC_KEY.testnet);
  alignEnclaveFeedIdentity('mainnet');
  const mainnet = buildUpdateFeedTxMessage(planned, txParams, UPDATER_PUBLIC_KEY.testnet);
  assert.notEqual(testnet.message, mainnet.message);
});

test('feed/sign neo_n3: a plan with nothing to push still answers 410 (no-update was a signing-lane answer)', async () => {
  alignEnclaveFeedIdentity('mainnet');
  const FIXED_NOW = 1_780_000_000;
  const tripwires = installTripwires();
  try {
    assertRetired(
      await dispatch(
        'POST',
        '/feed/sign',
        AUTH,
        JSON.stringify({
          chain: 'neo_n3',
          symbols: ['NEO-USD'],
          // recent + unchanged → planFeedUpdate returns push:false
          onchain_state: {
            'NEO-USD': { round: FIXED_NOW - 60, price: 5.0, timestamp: FIXED_NOW - 60 },
          },
          now: FIXED_NOW,
        })
      ),
      '/feed/sign'
    );
    assert.deepEqual(tripwires, { attest: 0, price: 0 });
  } finally {
    removeTripwires();
  }
  // The decision itself is the feed-pusher's, unchanged: nothing to push.
  assert.equal(
    planFeedUpdate({ round: FIXED_NOW - 60, price: 5.0, ts: FIXED_NOW - 60 }, 5.0, FIXED_NOW).push,
    false
  );
});

test('feed/sign neo_n3: without tx_params answers 410; provider-param tx bytes identical to feed-pusher', async () => {
  alignEnclaveFeedIdentity('mainnet');
  const FIXED_NOW = 1_780_000_000;
  // No tx_params: the lane used to pull block count + fees from a provider seam
  // (or answer 503). That seam is gone with the lane.
  assertRetired(
    await dispatch(
      'POST',
      '/feed/sign',
      AUTH,
      JSON.stringify({
        chain: 'neo_n3',
        symbols: ['NEO-USD'],
        onchain_state: {
          'NEO-USD': { round: FIXED_NOW - 60, price: 5.0, timestamp: FIXED_NOW - 60 },
        },
        now: FIXED_NOW,
        tx_nonce: 4242,
      })
    ),
    '/feed/sign'
  );

  const { planned } = planFeeds(
    ['NEO-USD'],
    { 'NEO-USD': 7.0 },
    { 'NEO-USD': { round: FIXED_NOW - 60, price: 5.0, timestamp: FIXED_NOW - 60 } },
    FIXED_NOW
  );
  const txParams = { blockCount: 9000000, systemFee: 555, networkFee: 666, nonce: 4242 };
  const built = buildUpdateFeedsTxMessage(planned, txParams, UPDATER_PUBLIC_KEY.mainnet);
  assert.equal(built.txn.validUntilBlock, 9000000 + 500);
  assert.equal(
    built.message,
    feedPusherTxMessage('mainnet', planned, txParams, UPDATER_PUBLIC_KEY.mainnet),
    'provider-param tx message must be byte-exact'
  );
  assert.throws(
    () =>
      buildUpdateFeedsTxMessage(planned, { ...txParams, nonce: 1.5 }, UPDATER_PUBLIC_KEY.mainnet),
    /nonce must be an integer/
  );
});

test('feed/sign neo_n3: missing tx params answers 410, not the retired lane’s 503', async () => {
  alignEnclaveFeedIdentity('mainnet');
  const FIXED_NOW = 1_780_000_000;
  assertRetired(
    await dispatch(
      'POST',
      '/feed/sign',
      AUTH,
      JSON.stringify({
        chain: 'neo_n3',
        symbols: ['NEO-USD'],
        onchain_state: {
          'NEO-USD': { round: FIXED_NOW - 60, price: 5.0, timestamp: FIXED_NOW - 60 },
        },
        now: FIXED_NOW,
      })
    ),
    '/feed/sign'
  );
});

// The fee ceilings (10 GAS system, 2 GAS network) belonged to the retired lane;
// the Rust frontier enforces the same ceilings (feed_sign.rs
// FEED_N3_MAX_SYSTEM_FEE / FEED_N3_MAX_NETWORK_FEE).
test('feed/sign neo_n3: host-supplied fees above the old ceilings answer 410 (never reach a signer)', async () => {
  alignEnclaveFeedIdentity('mainnet');
  const FIXED_NOW = 1_780_000_000;
  const tripwires = installTripwires();
  try {
    assertRetired(
      await dispatch(
        'POST',
        '/feed/sign',
        AUTH,
        JSON.stringify({
          chain: 'neo_n3',
          symbols: ['NEO-USD'],
          onchain_state: {
            'NEO-USD': { round: FIXED_NOW - 60, price: 5.0, timestamp: FIXED_NOW - 60 },
          },
          now: FIXED_NOW,
          tx_params: {
            block_count: 9_000_000,
            system_fee: 10 * 1e8 + 1,
            network_fee: 1,
            nonce: 7,
          },
        })
      ),
      '/feed/sign'
    );
    assert.deepEqual(tripwires, { attest: 0, price: 0 });
  } finally {
    removeTripwires();
  }
});

test('feed/sign neo_n3: a symbol missing from the price fetch answers 410 (nothing fetched)', async () => {
  alignEnclaveFeedIdentity('mainnet');
  const FIXED_NOW = 1_780_000_000;
  const tripwires = installTripwires();
  try {
    assertRetired(
      await dispatch(
        'POST',
        '/feed/sign',
        AUTH,
        JSON.stringify({
          chain: 'neo_n3',
          symbols: ['NEO-USD', 'GAS-USD'],
          onchain_state: {
            'NEO-USD': { round: FIXED_NOW - 60, price: 5.0, timestamp: FIXED_NOW - 60 },
            'GAS-USD': { round: FIXED_NOW - 60, price: 2.0, timestamp: FIXED_NOW - 60 },
          },
          now: FIXED_NOW,
          tx_params: { block_count: 100, system_fee: 1, network_fee: 1 },
        })
      ),
      '/feed/sign'
    );
    assert.deepEqual(tripwires, { attest: 0, price: 0 });
  } finally {
    removeTripwires();
  }
});

test('feed/sign: validation — neo_n3 answers 410 before validating; neox needs pinned tx_params', async () => {
  alignEnclaveFeedIdentity('mainnet');
  assertRetired(
    await dispatch('POST', '/feed/sign', AUTH, JSON.stringify({ chain: 'neo_n3', symbols: [] })),
    '/feed/sign'
  );
  assertRetired(
    await dispatch('POST', '/feed/sign', AUTH, JSON.stringify({ chain: 'bogus', symbols: [] })),
    '/feed/sign'
  );

  const neoxNoSymbols = await dispatch(
    'POST',
    '/feed/sign',
    AUTH,
    JSON.stringify({ chain: 'neox', symbols: [] })
  );
  assert.equal(neoxNoSymbols.status, 400);
  assert.match(neoxNoSymbols.body.error, /symbols/);

  // neox with a feed key but no tx_params → 400: the host must pin to/chain_id/nonce/fees.
  const saved = process.env.MORPHEUS_NEOX_FEED_PRIVATE_KEY;
  process.env.MORPHEUS_NEOX_FEED_PRIVATE_KEY =
    '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
  try {
    const noTxParams = await dispatch(
      'POST',
      '/feed/sign',
      AUTH,
      JSON.stringify({ chain: 'neox', symbols: ['NEO-USD'] })
    );
    assert.equal(noTxParams.status, 400);
    assert.match(noTxParams.body.error, /tx_params|required/);
  } finally {
    if (saved === undefined) delete process.env.MORPHEUS_NEOX_FEED_PRIVATE_KEY;
    else process.env.MORPHEUS_NEOX_FEED_PRIVATE_KEY = saved;
  }
});

test('feed/sign neox: signs the EIP-1559 updateFeeds tx in-TEE; recovers to the feed key + binds the plan (Phase D)', async () => {
  const FIXED_NOW = 1_780_000_000;
  const FEED_PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
  const expectedFrom = new ethers.Wallet(FEED_PK).address;
  const SYMBOLS = ['NEO-USD', 'GAS-USD', 'BTC-USD'];
  const STUB_PRICES = { 'NEO-USD': 5.25, 'GAS-USD': 2.1, 'BTC-USD': 65000.123456 };
  const ONCHAIN_STATE = {
    'NEO-USD': { round: FIXED_NOW - 60, price: 5.0, timestamp: FIXED_NOW - 60 }, // moved → push
    'GAS-USD': { round: FIXED_NOW - 60, price: 2.1, timestamp: FIXED_NOW - 60 }, // unchanged+recent → skip
    'BTC-USD': { round: 0, price: 0, timestamp: 0 }, // no prior → push
  };
  const TO = '0x38DD6BCEBDD47f4234AE11760CEFB58f9ae6a3bB';
  const TX_PARAMS = {
    to: TO,
    chain_id: 47763,
    nonce: 7,
    gas_limit: '2000000',
    max_fee_per_gas: '50000000000',
    max_priority_fee_per_gas: '1000000000',
  };
  const saved = process.env.MORPHEUS_NEOX_FEED_PRIVATE_KEY;
  process.env.MORPHEUS_NEOX_FEED_PRIVATE_KEY = FEED_PK;
  __setPriceFetcherForTests(async (syms) => {
    const out = {};
    for (const s of syms) if (s in STUB_PRICES) out[s] = STUB_PRICES[s];
    return out;
  });
  try {
    const { status, body } = await dispatch(
      'POST',
      '/feed/sign',
      AUTH,
      JSON.stringify({
        chain: 'neox',
        symbols: SYMBOLS,
        onchain_state: ONCHAIN_STATE,
        now: FIXED_NOW,
        tx_params: TX_PARAMS,
      })
    );
    assert.equal(status, 200, `dispatch failed: ${JSON.stringify(body)}`);
    assert.equal(body.status, 'ok');
    assert.equal(body.chain, 'neox');
    assert.equal(body.trust_tier, 'enclave-attested');
    assert.equal(body.from.toLowerCase(), expectedFrom.toLowerCase());
    // GAS unchanged+recent → skipped; NEO (moved) + BTC (no prior) pushed, in order.
    assert.deepEqual(body.symbols, ['TWELVEDATA:NEO-USD', 'TWELVEDATA:BTC-USD']);
    assert.deepEqual(body.prices_scaled, [
      String(Math.round(5.25 * 1e6)),
      String(Math.round(65000.123456 * 1e6)),
    ]);

    // The signed tx recovers to the feed key and binds the exact pinned tx fields.
    const parsed = ethers.Transaction.from(body.signed_tx);
    assert.equal(parsed.from.toLowerCase(), expectedFrom.toLowerCase());
    assert.equal(parsed.to.toLowerCase(), TO.toLowerCase());
    assert.equal(parsed.nonce, 7);
    assert.equal(Number(parsed.chainId), 47763);
    assert.equal(parsed.type, 2);

    // The signed calldata equals an INDEPENDENT re-encode of the returned plan — this
    // is exactly the assert the host runs before broadcasting.
    const iface = new ethers.Interface([
      'function updateFeeds(string[] symbols, uint256[] prices, uint256[] timestamps, uint256[] roundIds) external',
    ]);
    const rebuilt = iface.encodeFunctionData('updateFeeds', [
      body.symbols,
      body.prices_scaled.map((x) => BigInt(x)),
      body.timestamps.map((x) => BigInt(x)),
      body.round_ids.map((x) => BigInt(x)),
    ]);
    assert.equal(parsed.data, rebuilt);
    assert.equal(body.data, rebuilt);
  } finally {
    __resetPriceFetcherForTests();
    if (saved === undefined) delete process.env.MORPHEUS_NEOX_FEED_PRIVATE_KEY;
    else process.env.MORPHEUS_NEOX_FEED_PRIVATE_KEY = saved;
  }
});

// ---------------------------------------------------------------------------
// /attestation — nsm-attest passthrough via the stubbed seam. Asserts user_data
// binds sha256(fulfillment_digest) and the nonce is echoed.
// ---------------------------------------------------------------------------

test('attestation: user_data binds sha256(fulfillment_digest) + nonce echo + the pinned verifier key (stubbed seam)', async () => {
  const fulfillmentDigest = 'ab'.repeat(32); // 32-byte digest hex
  const nonce = 'feed1234';
  const expectedUserData = createHash('sha256')
    .update(Buffer.from(fulfillmentDigest, 'hex'))
    .digest('hex');
  // The bound key is the REGISTRY's pinned testnet oracle_verifier public key: the
  // server holds no Neo N3 key, so a pinned public identity is all it can bind.
  const pinnedVerifierPublicKey = getPinnedNeoN3Role('testnet', 'oracle_verifier').public_key;
  assert.match(pinnedVerifierPublicKey, /^[0-9a-f]{66}$/);

  // Stub the attest runner: capture the args the server passes, return a fake doc.
  let capturedArgs = null;
  __setAsyncAttestRunnerForTests((args) => {
    capturedArgs = args;
    return { ok: true, attestation_b64: 'ZmFrZS1jb3NlLWRvYw==', document_len: 11 };
  });

  const req = { fulfillment_digest_hex: fulfillmentDigest, nonce };
  const { status, body } = await dispatch('POST', '/attestation', {}, JSON.stringify(req));
  assert.equal(status, 200, `dispatch failed: ${JSON.stringify(body)}`);
  assert.equal(body.status, 'ok');
  assert.equal(body.trust_tier, 'enclave-attested');

  // user_data is the SINGLE 32-byte commit sha256(digest_bytes) — the §5 binding.
  assert.equal(body.user_data_hex, expectedUserData);
  assert.equal(body.user_data_hex.length, 64, 'user_data must be a single 32-byte commit');
  assert.equal(body.nonce, nonce, 'nonce must be echoed');
  assert.equal(body.attestation_document, 'ZmFrZS1jb3NlLWRvYw==');
  assert.equal(body.public_key, pinnedVerifierPublicKey);

  // The binary actually received --user-data <sha256(digest)>, --nonce <nonce>,
  // and --public-key <pinned oracle_verifier pubkey>.
  const argMap = {};
  for (let i = 0; i < capturedArgs.length; i += 2) argMap[capturedArgs[i]] = capturedArgs[i + 1];
  assert.equal(argMap['--user-data'], expectedUserData);
  assert.equal(argMap['--nonce'], nonce);
  assert.equal(
    argMap['--public-key'].toLowerCase(),
    pinnedVerifierPublicKey,
    '--public-key must bind the pinned oracle_verifier identity'
  );

  __resetAsyncAttestRunnerForTests();
});

test('attestation: GET liveness probe with no binding emits no user_data', async () => {
  __setAsyncAttestRunnerForTests((args) => {
    // No --user-data when no binding is supplied.
    assert.equal(args.includes('--user-data'), false);
    return { ok: true, attestation_b64: 'bGl2ZW5lc3M=', document_len: 8 };
  });
  const { status, body } = await dispatch('GET', '/attestation', {}, '');
  assert.equal(status, 200);
  assert.equal(body.user_data_hex, null);
  assert.equal(body.attestation_document, 'bGl2ZW5lc3M=');
  __resetAsyncAttestRunnerForTests();
});

test('attestation: a {ok:false} nsm helper surfaces a 503 with its error', async () => {
  __setAsyncAttestRunnerForTests(() => ({ ok: false, error: 'open /dev/nsm: not in an enclave' }));
  const { status, body } = await dispatch(
    'POST',
    '/attestation',
    {},
    JSON.stringify({ fulfillment_digest_hex: 'cc'.repeat(32) })
  );
  assert.equal(status, 503);
  assert.match(body.error, /\/dev\/nsm/);
  __resetAsyncAttestRunnerForTests();
});

test('attestation: a throwing nsm helper (spawn failure) surfaces a wrapped 503', async () => {
  __setAsyncAttestRunnerForTests(() => {
    throw new Error('spawn ENOENT');
  });
  const { status, body } = await dispatch(
    'POST',
    '/attestation',
    {},
    JSON.stringify({ fulfillment_digest_hex: 'dd'.repeat(32) })
  );
  assert.equal(status, 503);
  assert.match(body.error, /nsm attestation helper failed/);
  __resetAsyncAttestRunnerForTests();
});

test('attestation: a malformed (odd-length) binding hex is rejected with 400', async () => {
  const { status, body } = await dispatch(
    'POST',
    '/attestation',
    {},
    JSON.stringify({ fulfillment_digest_hex: 'abc' }) // odd length
  );
  assert.equal(status, 400);
  assert.match(body.error, /even-length hex/);
});

// ---------------------------------------------------------------------------
// ENFORCING attestation (C1): a fulfillment binds an NSM document committing
// user_data = sha256(fulfillment_digest) and surfaces the measured PCRs the
// relayer verifies. Best-effort: a missing NSM binary does NOT break a signed
// fulfillment. The NeoX lane still does both; the Neo N3 lane is retired.
// ---------------------------------------------------------------------------

// Encode a minimal CBOR value (just the subset the NSM attestation doc uses:
// unsigned ints, byte strings, text strings, arrays, maps). Mirrors the decoder
// in enclave-server.mjs so the test can build a real COSE_Sign1 document.
function cborEncode(value) {
  const head = (major, n) => {
    const big = BigInt(n);
    if (big < 24n) return Buffer.from([(major << 5) | Number(big)]);
    if (big < 256n) return Buffer.from([(major << 5) | 24, Number(big)]);
    if (big < 65536n)
      return Buffer.from([(major << 5) | 25, Number(big >> 8n) & 0xff, Number(big) & 0xff]);
    const b = Buffer.alloc(5);
    b[0] = (major << 5) | 26;
    b.writeUInt32BE(Number(big), 1);
    return b;
  };
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return head(0, value);
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  if (typeof value === 'string') {
    const b = Buffer.from(value, 'utf8');
    return Buffer.concat([head(3, b.length), b]);
  }
  if (Array.isArray(value)) {
    return Buffer.concat([head(4, value.length), ...value.map(cborEncode)]);
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    const parts = [head(5, entries.length)];
    for (const [k, v] of entries) {
      // map keys: numeric string -> uint key (matches PCR index keys), else text.
      parts.push(/^\d+$/.test(k) ? cborEncode(Number(k)) : cborEncode(k));
      parts.push(cborEncode(v));
    }
    return Buffer.concat(parts);
  }
  throw new Error(`cborEncode: unsupported ${typeof value}`);
}

function buildFakeAttestationDoc({ userDataHex, pcr0Hex }) {
  const payload = {
    module_id: 'i-fake-enclave',
    pcrs: { 0: Buffer.from(pcr0Hex, 'hex'), 1: Buffer.alloc(48, 1), 2: Buffer.alloc(48, 2) },
    user_data: Buffer.from(userDataHex, 'hex'),
    public_key: Buffer.from('02' + 'ab'.repeat(32), 'hex'),
  };
  const cose = [
    Buffer.from([0xa0]), // empty protected header (bstr-wrapped map)
    {}, // unprotected header
    cborEncode(payload), // payload bstr
    Buffer.alloc(96, 7), // signature bstr
  ];
  return cborEncode(cose).toString('base64');
}

function neoxFulfillRequest(requestId, nonce) {
  const requestType = 'oracle_query';
  return withRawPayload({
    chain: 'neox',
    request_type: requestType,
    request_id: requestId,
    payload: { symbol: 'BTC/USD' },
    fulfillment_context: {
      app_id: 'attest.app',
      module_id: resolveKernelIntent(requestType).moduleId,
      operation: resolveKernelIntent(requestType).operation,
      chain_id: 12227332,
      oracle_contract: '0xeCFC1C652B5cCdBfe3E9314a83156787D92a3fD2',
    },
    ...(nonce ? { nonce } : {}),
  });
}

test('C1: the neo_n3 fulfill lane answers 410 without attesting; the attestation binding holds for its digest and for neox', async () => {
  const PCR0 = 'aa'.repeat(48);
  let attestCalls = 0;
  // Stub the attest runner so it returns a REAL COSE_Sign1 whose user_data is the
  // commitment the server passes (--user-data sha256(digest)) and a known PCR0.
  __setAsyncAttestRunnerForTests((args) => {
    attestCalls += 1;
    const argMap = {};
    for (let i = 0; i < args.length; i += 2) argMap[args[i]] = args[i + 1];
    const doc = buildFakeAttestationDoc({ userDataHex: argMap['--user-data'], pcr0Hex: PCR0 });
    return { ok: true, attestation_b64: doc, document_len: doc.length };
  });
  try {
    const requestType = 'oracle_query';
    const contractScriptHash = '0x' + '3a'.repeat(20);
    const networkMagic = 894710606;
    const moduleId = resolveKernelIntent(requestType).moduleId;
    const operation = resolveKernelIntent(requestType).operation;
    const n3 = withRawPayload({
      chain: 'neo_n3',
      request_type: requestType,
      request_id: '5150',
      payload: { symbol: 'BTC/USD' },
      fulfillment_context: {
        app_id: 'attest.app',
        module_id: moduleId,
        operation,
        contract_script_hash: contractScriptHash,
        network_magic: networkMagic,
      },
      nonce: 'cafebabe',
    });
    assertRetired(
      await dispatch('POST', '/oracle/fulfill', AUTH, JSON.stringify(n3)),
      '/oracle/fulfill'
    );
    assert.equal(attestCalls, 0, 'a retired lane attests nothing');

    // Key-free: the digest the lane used to sign, bound through /attestation.
    const fulfillment = encodeFulfillmentResult(requestType, expectedWorkerResponse(requestType));
    const n3Digest = buildFulfillmentDigestBytes(
      '5150',
      requestType,
      fulfillment.success,
      fulfillment.result || '',
      fulfillment.error || '',
      fulfillment.result_bytes_base64 || '',
      {
        chain: 'neo_n3',
        appId: 'attest.app',
        moduleId,
        operation,
        payloadHex: n3.payload_hex,
        contractScriptHash,
        networkMagic,
      }
    ).toString('hex');
    const bound = await dispatch(
      'POST',
      '/attestation',
      {},
      JSON.stringify({ fulfillment_digest_hex: n3Digest, nonce: 'cafebabe' })
    );
    assert.equal(bound.status, 200);
    assert.equal(
      bound.body.user_data_hex,
      createHash('sha256').update(Buffer.from(n3Digest, 'hex')).digest('hex')
    );
    assert.equal(bound.body.pcrs.pcr0, PCR0);
    assert.equal(bound.body.nonce, 'cafebabe');

    // The live NeoX lane binds its own digest in the fulfillment response.
    const { status, body } = await dispatch(
      'POST',
      '/oracle/fulfill',
      AUTH,
      JSON.stringify(neoxFulfillRequest('5152', 'cafebabe'))
    );
    assert.equal(status, 200, `dispatch failed: ${JSON.stringify(body)}`);
    assert.equal(body.trust_tier, 'enclave-attested');
    assert.ok(body.attestation_doc_base64, 'fulfill must carry the attestation document');
    const neoxDigestBytes = Buffer.from(body.fulfillment_digest_hex.replace(/^0x/, ''), 'hex');
    assert.equal(
      body.attestation_user_data_hex,
      createHash('sha256').update(neoxDigestBytes).digest('hex')
    );
    assert.equal(body.attestation_pcrs.pcr0, PCR0);
    assert.equal(body.nonce, 'cafebabe');
  } finally {
    __resetAsyncAttestRunnerForTests();
  }
});

test('C1 best-effort: neo_n3 answers 410; neox still signs when attestation is unavailable', async () => {
  // A throwing/absent NSM binary must NOT break a signed fulfillment — the
  // relayer enforces and downgrades trust_tier when it cannot prove attestation.
  let attestCalls = 0;
  __setAsyncAttestRunnerForTests(() => {
    attestCalls += 1;
    throw new Error('spawn ENOENT (no nsm binary outside an enclave)');
  });
  try {
    const requestType = 'oracle_query';
    assertRetired(
      await dispatch(
        'POST',
        '/oracle/fulfill',
        AUTH,
        JSON.stringify(
          withRawPayload({
            chain: 'neo_n3',
            request_type: requestType,
            request_id: '5151',
            payload: { symbol: 'BTC/USD' },
            fulfillment_context: {
              app_id: 'a',
              module_id: resolveKernelIntent(requestType).moduleId,
              operation: resolveKernelIntent(requestType).operation,
            },
          })
        )
      ),
      '/oracle/fulfill'
    );
    assert.equal(attestCalls, 0);

    const { status, body } = await dispatch(
      'POST',
      '/oracle/fulfill',
      AUTH,
      JSON.stringify(neoxFulfillRequest('5153'))
    );
    assert.equal(status, 200);
    assert.ok(body.signature, 'signature must still be produced');
    assert.equal(body.attestation_doc_base64, undefined, 'no doc when the binary is unavailable');
    assert.ok(body.attestation_error, 'the attestation failure is surfaced for ops');
    assert.equal(attestCalls, 1);
  } finally {
    __resetAsyncAttestRunnerForTests();
  }
});

// ---------------------------------------------------------------------------
// /health
// ---------------------------------------------------------------------------

test('GET /health reports compute readiness and the Neo N3 signer as retired (ready:false)', async () => {
  const { status, body } = await dispatch('GET', '/health', {}, '');
  assert.equal(status, 503, 'a retired signer is not a ready signer');
  assert.equal(body.ready, false);
  assert.equal(body.status, 'retired');
  assert.equal(body.runtime, 'morpheus-enclave-server');
  assert.equal(body.checks.compute, true);
  assert.equal(body.checks.signer, false);
  assert.deepEqual(body.neo_n3_signer, {
    status: 'retired',
    error_code: 'neo_n3_signer_retired',
    replacement: 'workers/nitro-enclave-host',
  });
  // No per-role key_source / public-key claim: no Neo N3 key exists here.
  assert.equal(body.key_source, undefined);
  assert.equal(body.checks.oracle_verifier_public_key, undefined);
  assert.equal(body.plaintext_key_provision_allowed, false);

  // handleHealth direct call agrees.
  assert.deepEqual(handleHealth(), body);
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test('missing request_type / request_id: 400 on neox; neo_n3 answers 410 before validating', async () => {
  const noType = await dispatch(
    'POST',
    '/oracle/fulfill',
    AUTH,
    JSON.stringify(withRawPayload({ chain: 'neox', request_id: '1', payload: {} }))
  );
  assert.equal(noType.status, 400);
  assert.match(noType.body.error, /request_type/);

  const noId = await dispatch(
    'POST',
    '/oracle/fulfill',
    AUTH,
    JSON.stringify(withRawPayload({ chain: 'neox', request_type: 'oracle_query', payload: {} }))
  );
  assert.equal(noId.status, 400);
  assert.match(noId.body.error, /request_id/);

  assertRetired(
    await dispatch(
      'POST',
      '/oracle/fulfill',
      AUTH,
      JSON.stringify({ chain: 'neo_n3', request_id: '1' })
    ),
    '/oracle/fulfill'
  );
  // An absent chain is neo_n3 (normalizeChain's default).
  assertRetired(await dispatch('POST', '/oracle/fulfill', AUTH, '{}'), '/oracle/fulfill');
});

test('unknown route returns 404', async () => {
  const { status, body } = await dispatch('GET', '/nope', {}, '');
  assert.equal(status, 404);
  assert.equal(body.error, 'not found');
});

// ---------------------------------------------------------------------------
// Auth + provisioning + the retired signer surface
// ---------------------------------------------------------------------------

test('sensitive routes require the bearer token; health + attestation stay open', async () => {
  // No/incorrect auth on a signing route -> 401 (checked before any validation).
  const noAuth = await dispatch('POST', '/oracle/fulfill', {}, JSON.stringify({}));
  assert.equal(noAuth.status, 401);
  const wrongAuth = await dispatch(
    'POST',
    '/feed/sign',
    { authorization: 'Bearer wrong' },
    JSON.stringify({ chain: 'neo_n3', symbols: ['BTC-USD'] })
  );
  assert.equal(wrongAuth.status, 401);
  // Open endpoints don't require a token.
  const health = await dispatch('GET', '/health', {}, '');
  assert.ok(health.status === 200 || health.status === 503);
});

test('sensitive routes fail closed before a runtime token is provisioned', async () => {
  const savedTokens = Object.fromEntries(TOKEN_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of TOKEN_ENV_KEYS) delete process.env[key];
  try {
    const routes = [
      ['/oracle/fulfill', '{}'],
      ['/feed/sign', JSON.stringify({ chain: 'neo_n3', symbols: ['BTC-USD'] })],
      ['/sign/payload', JSON.stringify({})],
      ['/keys/derived', JSON.stringify({ role: 'updater' })],
      ['/testnet/compute/execute', JSON.stringify({})],
    ];
    for (const [route, body] of routes) {
      const noAuth = await dispatch('POST', route, {}, body);
      assert.equal(noAuth.status, 401, `${route} must reject an empty trusted-token set`);
      const forged = await dispatch(
        'POST',
        route,
        { authorization: 'Bearer attacker-token' },
        body
      );
      assert.equal(forged.status, 401, `${route} must reject a caller-chosen token`);
    }
    const health = await dispatch('GET', '/health', {}, '');
    assert.ok(health.status === 200 || health.status === 503);
  } finally {
    for (const [key, value] of Object.entries(savedTokens)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('sign/payload (blind signing) answers 410 and names the closed Rust lane', async () => {
  const dataHex = createHash('sha256').update('enclave-sign-payload-test').digest('hex');
  const retired = await dispatch(
    'POST',
    '/sign/payload',
    AUTH,
    JSON.stringify({ role: 'oracle_verifier', data_hex: dataHex })
  );
  assertRetired(retired, '/sign/payload');
  assert.match(retired.body.error, /ENCLAVE_ALLOW_BLIND_SIGN=1/);
  assert.equal(retired.body.signature_hex, undefined);
});

test('keys/derived answers 410 and names the custody-backed Rust lane', async () => {
  const retired = await dispatch(
    'POST',
    '/keys/derived',
    AUTH,
    JSON.stringify({ role: 'updater' })
  );
  assertRetired(retired, '/keys/derived');
  assert.match(retired.body.error, /SIGNER_ROLE_<ROLE>_KEY_ID/);
  assert.equal(retired.body.neo_n3, undefined);
  assert.equal(retired.body.derived, undefined);
});

test('the retired signer surface never acts under a defaulted or unmappable role', async () => {
  // regression: normalizeSignerRole once fell back to 'updater', so an absent or
  // bogus key_role signed with the updater key. The surface is retired: every
  // body, whatever role it names or omits, answers the same 410.
  for (const [route, body] of [
    ['/sign/payload', {}],
    ['/sign/payload', { key_role: 'superadmin', data_hex: '00' }],
    ['/sign/payload', { key_role: 'updater', data_hex: '00' }],
    ['/keys/derived', {}],
    ['/keys/derived', { role: 'oracle_verifier' }],
  ]) {
    assertRetired(await dispatch('POST', route, AUTH, JSON.stringify(body)), route);
  }
});

test('provision applies env keys at runtime and reports the Neo N3 signer retired (not role health)', async () => {
  // Provision a benign extra key + re-affirm the network. First-boot provisioning
  // is not exercised here because NITRO_API_TOKEN already seeds a trusted token.
  try {
    const { status, body } = await dispatch(
      'POST',
      '/provision',
      AUTH,
      JSON.stringify({
        env: {
          MORPHEUS_NETWORK: 'testnet',
          FEED_NETWORK: 'testnet',
          FEED_MAGIC: String(FEED_NETWORK_DEFAULTS.testnet.magic),
          TD_KEY: 'provisioned-td-key',
        },
      })
    );
    // D1: before, this answered 500 — after writing the payload into process.env —
    // because it called two KMS materializers 942adfe deleted.
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.status, 'ok');
    assert.equal(body.provisioned, true);
    assert.equal(body.network, 'testnet');
    assert.deepEqual(body.env_keys, ['FEED_MAGIC', 'FEED_NETWORK', 'MORPHEUS_NETWORK', 'TD_KEY']);
    assert.equal(process.env.TD_KEY, 'provisioned-td-key');
    assert.equal(body.roles, undefined, 'no per-role signer health: this file signs no Neo N3');
    assert.deepEqual(body.neo_n3_signer, {
      status: 'retired',
      error_code: 'neo_n3_signer_retired',
      replacement: 'workers/nitro-enclave-host',
    });
  } finally {
    delete process.env.TD_KEY;
    delete process.env.FEED_NETWORK;
  }
});

test('provision refuses a FEED_NETWORK / MORPHEUS_NETWORK mismatch before applying', async () => {
  const rejected = await dispatch(
    'POST',
    '/provision',
    AUTH,
    JSON.stringify({
      env: {
        FEED_NETWORK: 'testnet',
        MORPHEUS_NETWORK: 'mainnet',
        FEED_MAGIC: String(FEED_NETWORK_DEFAULTS.testnet.magic),
        TD_KEY: 'must-not-apply-split',
      },
    })
  );
  assert.equal(rejected.status, 400);
  assert.match(String(rejected.body.error || ''), /split-brain|FEED_NETWORK|MORPHEUS_NETWORK/);
  assert.notEqual(process.env.TD_KEY, 'must-not-apply-split');
});

// D2: the Rust port (workers/nitro-enclave-host/src/provision.rs) is the list of
// record. Parse its PLAINTEXT_KEY_ENV_KEYS and require the Node list to be the
// same set, so a one-sided edit (942adfe dropped 18 names here) fails this test.
function parseRustPlaintextKeyEnvKeys() {
  const source = readFileSync(
    new URL('../../workers/nitro-enclave-host/src/provision.rs', import.meta.url),
    'utf8'
  );
  const match = source.match(
    /pub const PLAINTEXT_KEY_ENV_KEYS:\s*\[&str;\s*(\d+)\]\s*=\s*\[([\s\S]*?)\];/
  );
  assert.ok(match, 'provision.rs must declare pub const PLAINTEXT_KEY_ENV_KEYS: [&str; N]');
  const body = match[2]
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
  const names = [...body.matchAll(/"([A-Z0-9_]+)"/g)].map((entry) => entry[1]);
  assert.equal(
    names.length,
    Number(match[1]),
    'the parser must read exactly as many names as the Rust array length declares'
  );
  return names;
}

test('D2 parity: PLAINTEXT_KEY_ENV_KEYS is exactly the Rust port’s list', () => {
  const rust = parseRustPlaintextKeyEnvKeys();
  assert.equal(rust.length, 22);
  assert.equal(
    new Set(PLAINTEXT_KEY_ENV_KEYS).size,
    PLAINTEXT_KEY_ENV_KEYS.length,
    'no duplicates'
  );
  assert.deepEqual(
    [...PLAINTEXT_KEY_ENV_KEYS].sort(),
    [...rust].sort(),
    'enclave-server.mjs and provision.rs must refuse the same plaintext names'
  );
  assert.ok(Object.isFrozen(PLAINTEXT_KEY_ENV_KEYS));
});

function envSnapshot() {
  return JSON.stringify(Object.entries(process.env).sort(([a], [b]) => a.localeCompare(b)));
}

test('D2: provision permanently rejects every plaintext key name (N3, NeoX, X25519, NeoDID, game) and the former opt-in flag', async () => {
  // The names come from the Rust list of record, not from the export under
  // test, so a shortened Node list (942adfe's) fails here as well as in parity.
  const names = parseRustPlaintextKeyEnvKeys();
  for (const name of [
    'MORPHEUS_ORACLE_VERIFIER_WIF_MAINNET',
    'MORPHEUS_UPDATER_NEO_N3_PRIVATE_KEY_TESTNET',
    'MORPHEUS_NEOX_VERIFIER_PRIVATE_KEY',
    'NEOX_FEED_PK',
  ]) {
    assert.ok(names.includes(name), `${name} must be on the list of record`);
  }
  // Also with the old process-level opt-in set: it cannot reopen the code path.
  const savedFlag = process.env.MORPHEUS_ALLOW_PLAINTEXT_KEY_PROVISION;
  try {
    for (const flagValue of [undefined, '1']) {
      if (flagValue === undefined) delete process.env.MORPHEUS_ALLOW_PLAINTEXT_KEY_PROVISION;
      else process.env.MORPHEUS_ALLOW_PLAINTEXT_KEY_PROVISION = flagValue;
      for (const name of names) {
        const before = envSnapshot();
        const rejected = await dispatch(
          'POST',
          '/provision',
          AUTH,
          JSON.stringify({ env: { [name]: 'plaintext-value-that-must-not-land', TD_KEY: 'x' } })
        );
        assert.equal(rejected.status, 403, `${name} must be refused`);
        assert.match(
          rejected.body.error,
          /plaintext key or runtime-token provisioning is permanently disabled/
        );
        assert.match(rejected.body.error, new RegExp(`Rejected: .*\\b${name}\\b`));
        assert.equal(envSnapshot(), before, `${name}: a refused provision writes nothing`);
      }
    }
    delete process.env.MORPHEUS_ALLOW_PLAINTEXT_KEY_PROVISION;

    // All at once: the refusal lists every name, sorted.
    const all = await dispatch(
      'POST',
      '/provision',
      AUTH,
      JSON.stringify({ env: Object.fromEntries(names.map((key) => [key, 'v'])) })
    );
    assert.equal(all.status, 403);
    assert.ok(all.body.error.endsWith(`Rejected: ${[...names].sort().join(', ')}`), all.body.error);

    // The old escape hatch itself is forbidden at the provisioning boundary, so
    // a host cannot enable it in one request and inject a key in the next.
    const flagAttempt = await dispatch(
      'POST',
      '/provision',
      AUTH,
      JSON.stringify({ env: { MORPHEUS_ALLOW_PLAINTEXT_KEY_PROVISION: '1' } })
    );
    assert.equal(flagAttempt.status, 403);
    assert.match(flagAttempt.body.error, /MORPHEUS_ALLOW_PLAINTEXT_KEY_PROVISION/);
    assert.equal(process.env.MORPHEUS_ALLOW_PLAINTEXT_KEY_PROVISION, undefined);

    // The KMS-ciphertext variant is the attested path and is accepted: the NeoX
    // verifier key arrives only as ciphertext and is released in-TEE (stubbed
    // runner), landing on the name /provision itself refuses.
    const savedCt = process.env.MORPHEUS_NEOX_VERIFIER_KMS_CIPHERTEXT_BASE64;
    const savedPk = process.env.MORPHEUS_NEOX_VERIFIER_PRIVATE_KEY;
    delete process.env.MORPHEUS_NEOX_VERIFIER_PRIVATE_KEY;
    __setAttestRunnerForTests(() => ({
      ok: true,
      plaintext_b64: Buffer.from(NEOX_VERIFIER_PK, 'utf8').toString('base64'),
    }));
    try {
      const accepted = await dispatch(
        'POST',
        '/provision',
        AUTH,
        JSON.stringify({
          env: { MORPHEUS_NEOX_VERIFIER_KMS_CIPHERTEXT_BASE64: 'Y2lwaGVydGV4dA==' },
        })
      );
      assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
      assert.deepEqual(accepted.body.env_keys, ['MORPHEUS_NEOX_VERIFIER_KMS_CIPHERTEXT_BASE64']);
      assert.equal(process.env.MORPHEUS_NEOX_VERIFIER_PRIVATE_KEY, NEOX_VERIFIER_PK);
    } finally {
      __resetAttestRunnerForTests();
      if (savedCt === undefined) delete process.env.MORPHEUS_NEOX_VERIFIER_KMS_CIPHERTEXT_BASE64;
      else process.env.MORPHEUS_NEOX_VERIFIER_KMS_CIPHERTEXT_BASE64 = savedCt;
      if (savedPk === undefined) delete process.env.MORPHEUS_NEOX_VERIFIER_PRIVATE_KEY;
      else process.env.MORPHEUS_NEOX_VERIFIER_PRIVATE_KEY = savedPk;
    }
  } finally {
    if (savedFlag === undefined) delete process.env.MORPHEUS_ALLOW_PLAINTEXT_KEY_PROVISION;
    else process.env.MORPHEUS_ALLOW_PLAINTEXT_KEY_PROVISION = savedFlag;
  }
});

test('D1: a refused or failing provision leaves process.env exactly as it found it', async () => {
  // Every refusal class /provision has, each checked against a byte-for-byte
  // snapshot of process.env. Nothing may be written before the last check.
  const cases = [
    ['plaintext key (403)', AUTH, { NEOX_FEED_PK: '0xfeed', TD_KEY: 'x' }, 403],
    [
      'runtime token name (403)',
      AUTH,
      { MORPHEUS_RUNTIME_TOKEN: 'y'.repeat(40), TD_KEY: 'x' },
      403,
    ],
    [
      'split-brain network identity (400)',
      AUTH,
      {
        FEED_NETWORK: 'testnet',
        MORPHEUS_NETWORK: 'mainnet',
        FEED_MAGIC: String(FEED_NETWORK_DEFAULTS.testnet.magic),
        TD_KEY: 'x',
      },
      400,
    ],
    [
      'FEED_MAGIC for the other network (400)',
      AUTH,
      {
        FEED_NETWORK: 'testnet',
        MORPHEUS_NETWORK: 'testnet',
        FEED_MAGIC: '860833102',
        TD_KEY: 'x',
      },
      400,
    ],
  ];
  for (const [label, headers, env, expected] of cases) {
    const before = envSnapshot();
    const response = await dispatch('POST', '/provision', headers, JSON.stringify({ env }));
    assert.equal(response.status, expected, `${label}: ${JSON.stringify(response.body)}`);
    assert.equal(envSnapshot(), before, `${label}: process.env must be unchanged`);
  }

  // Bind an identity, then try to retarget it (409 immutable) — also unchanged.
  const bind = await dispatch(
    'POST',
    '/provision',
    AUTH,
    JSON.stringify({
      env: {
        FEED_NETWORK: 'testnet',
        MORPHEUS_NETWORK: 'testnet',
        FEED_MAGIC: String(FEED_NETWORK_DEFAULTS.testnet.magic),
      },
    })
  );
  assert.equal(bind.status, 200, JSON.stringify(bind.body));
  const beforeRetarget = envSnapshot();
  const retarget = await dispatch(
    'POST',
    '/provision',
    AUTH,
    JSON.stringify({
      env: {
        FEED_NETWORK: 'mainnet',
        MORPHEUS_NETWORK: 'mainnet',
        FEED_MAGIC: String(FEED_NETWORK_DEFAULTS.mainnet.magic),
        TD_KEY: 'x',
      },
    })
  );
  assert.equal(retarget.status, 409, JSON.stringify(retarget.body));
  assert.match(retarget.body.error, /immutable/);
  assert.equal(envSnapshot(), beforeRetarget, 'a refused retarget writes nothing');
  delete process.env.FEED_NETWORK;

  // First-boot failures, with no trusted token: bad bearer (401), KMS release
  // failure (503), malformed envelope (401), wrong-network envelope (401).
  const savedTokens = Object.fromEntries(TOKEN_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of TOKEN_ENV_KEYS) delete process.env[key];
  const token = 'operator-sealed-runtime-token-d1-0123456789abcdef';
  const bootstrap = {
    MORPHEUS_NETWORK: 'testnet',
    MORPHEUS_RUNTIME_TOKEN_KMS_CIPHERTEXT_BASE64: 'sealed-d1',
    AWS_ACCESS_KEY_ID: 'must-not-apply-access-key',
    TD_KEY: 'must-not-apply',
  };
  const runners = [
    [
      'KMS release throws (503)',
      () => {
        throw new Error('AccessDenied');
      },
      `Bearer ${token}`,
      503,
    ],
    ['KMS returns ok:false (503)', () => ({ ok: false, error: 'denied' }), `Bearer ${token}`, 503],
    [
      'envelope is not JSON (401)',
      () => ({ ok: true, plaintext_b64: Buffer.from('nope').toString('base64') }),
      `Bearer ${token}`,
      401,
    ],
    [
      'envelope for the other network (401)',
      () => ({
        ok: true,
        plaintext_b64: Buffer.from(
          JSON.stringify({
            purpose: 'neoos/nitro-runtime-auth/v1',
            network: 'mainnet',
            version: 1,
            token,
          })
        ).toString('base64'),
      }),
      `Bearer ${token}`,
      401,
    ],
    [
      'presented bearer does not match the sealed token (401)',
      () => ({
        ok: true,
        plaintext_b64: Buffer.from(
          JSON.stringify({
            purpose: 'neoos/nitro-runtime-auth/v1',
            network: 'testnet',
            version: 1,
            token,
          })
        ).toString('base64'),
      }),
      'Bearer attacker-chosen-token-0123456789abcdef',
      401,
    ],
  ];
  try {
    for (const [label, runner, authorization, expected] of runners) {
      __setAttestRunnerForTests(runner);
      const before = envSnapshot();
      const response = await dispatch(
        'POST',
        '/provision',
        { authorization },
        JSON.stringify({ env: bootstrap })
      );
      assert.equal(response.status, expected, `${label}: ${JSON.stringify(response.body)}`);
      assert.equal(envSnapshot(), before, `${label}: process.env must be unchanged`);
    }
  } finally {
    __resetAttestRunnerForTests();
    __resetRuntimeProvisionStateForTests();
    for (const [key, value] of Object.entries(savedTokens)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('D1: the apply phase cannot throw — a malformed in-TEE KMS release is logged, not a 500 after writing', async () => {
  // Before, Buffer.from(<non-string plaintext_b64>) threw inside the apply phase:
  // the payload was already in process.env when /provision answered 500.
  const saved = {
    ct: process.env.MORPHEUS_NEOX_FEED_KMS_CIPHERTEXT_BASE64,
    pk: process.env.MORPHEUS_NEOX_FEED_PRIVATE_KEY,
  };
  delete process.env.MORPHEUS_NEOX_FEED_PRIVATE_KEY;
  const logged = [];
  const originalError = console.error;
  console.error = (line) => logged.push(String(line));
  __setAttestRunnerForTests(() => ({ ok: true, plaintext_b64: 5 }));
  try {
    const response = await dispatch(
      'POST',
      '/provision',
      AUTH,
      JSON.stringify({ env: { MORPHEUS_NEOX_FEED_KMS_CIPHERTEXT_BASE64: 'Y2lwaGVydGV4dA==' } })
    );
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(process.env.MORPHEUS_NEOX_FEED_PRIVATE_KEY, undefined, 'nothing released');
    assert.ok(logged.some((line) => line.includes('kms_neox_feed_key_materialize_bad_output')));
  } finally {
    console.error = originalError;
    __resetAttestRunnerForTests();
    if (saved.ct === undefined) delete process.env.MORPHEUS_NEOX_FEED_KMS_CIPHERTEXT_BASE64;
    else process.env.MORPHEUS_NEOX_FEED_KMS_CIPHERTEXT_BASE64 = saved.ct;
    if (saved.pk === undefined) delete process.env.MORPHEUS_NEOX_FEED_PRIVATE_KEY;
    else process.env.MORPHEUS_NEOX_FEED_PRIVATE_KEY = saved.pk;
  }
});

test('D1: the apply phase cannot throw on a malformed X25519 oracle-key release either', async () => {
  const saved = {
    ct: process.env.MORPHEUS_ORACLE_KMS_CIPHERTEXT_BASE64,
    json: process.env.MORPHEUS_ORACLE_KEY_MATERIAL_JSON,
    b64: process.env.MORPHEUS_ORACLE_KEY_MATERIAL_BASE64,
  };
  delete process.env.MORPHEUS_ORACLE_KEY_MATERIAL_JSON;
  delete process.env.MORPHEUS_ORACLE_KEY_MATERIAL_BASE64;
  const logged = [];
  const originalError = console.error;
  console.error = (line) => logged.push(String(line));
  __setAttestRunnerForTests(() => ({ ok: true, plaintext_b64: 5 }));
  try {
    const response = await dispatch(
      'POST',
      '/provision',
      AUTH,
      JSON.stringify({ env: { MORPHEUS_ORACLE_KMS_CIPHERTEXT_BASE64: 'Y2lwaGVydGV4dA==' } })
    );
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(process.env.MORPHEUS_ORACLE_KEY_MATERIAL_JSON, undefined, 'nothing released');
    assert.ok(logged.some((line) => line.includes('kms_oracle_key_materialize_bad_output')));
  } finally {
    console.error = originalError;
    __resetAttestRunnerForTests();
    for (const [key, value] of [
      ['MORPHEUS_ORACLE_KMS_CIPHERTEXT_BASE64', saved.ct],
      ['MORPHEUS_ORACLE_KEY_MATERIAL_JSON', saved.json],
      ['MORPHEUS_ORACLE_KEY_MATERIAL_BASE64', saved.b64],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('D1: a runtime token released in the plan phase is not installed when a later check refuses', async () => {
  // The KMS release succeeds (valid envelope, matching bearer) and a LATER plan
  // check refuses: neither the token, its version, nor any payload key may land.
  const savedTokens = Object.fromEntries(TOKEN_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of TOKEN_ENV_KEYS) delete process.env[key];
  const token = 'operator-sealed-runtime-token-plan-0123456789abcdef';
  __setAttestRunnerForTests((args) => {
    const ciphertext = args[args.indexOf('--ciphertext') + 1];
    const version = ciphertext === 'sealed-v2' ? 2 : 1;
    return {
      ok: true,
      plaintext_b64: Buffer.from(
        JSON.stringify({
          purpose: 'neoos/nitro-runtime-auth/v1',
          network: 'testnet',
          version,
          token: version === 2 ? `${token}-v2` : token,
        })
      ).toString('base64'),
    };
  });
  const identity = (magic) => ({
    MORPHEUS_NETWORK: 'testnet',
    FEED_NETWORK: 'testnet',
    FEED_MAGIC: String(magic),
  });
  const mainnetMagic = FEED_NETWORK_DEFAULTS.mainnet.magic;
  const testnetMagic = FEED_NETWORK_DEFAULTS.testnet.magic;
  try {
    let before = envSnapshot();
    const refusedBootstrap = await dispatch(
      'POST',
      '/provision',
      { authorization: `Bearer ${token}` },
      JSON.stringify({
        env: {
          ...identity(mainnetMagic),
          MORPHEUS_RUNTIME_TOKEN_KMS_CIPHERTEXT_BASE64: 'sealed-v1',
          TD_KEY: 'x',
        },
      })
    );
    assert.equal(refusedBootstrap.status, 400, JSON.stringify(refusedBootstrap.body));
    assert.equal(envSnapshot(), before, 'a refused bootstrap installs no token and no key');
    assert.equal(process.env.MORPHEUS_RUNTIME_TOKEN, undefined);

    // Version 1 was not consumed: the same sealed token still bootstraps.
    const bootstrap = await dispatch(
      'POST',
      '/provision',
      { authorization: `Bearer ${token}` },
      JSON.stringify({
        env: {
          ...identity(testnetMagic),
          MORPHEUS_RUNTIME_TOKEN_KMS_CIPHERTEXT_BASE64: 'sealed-v1',
        },
      })
    );
    assert.equal(bootstrap.status, 200, JSON.stringify(bootstrap.body));
    assert.equal(process.env.MORPHEUS_RUNTIME_TOKEN, token);

    before = envSnapshot();
    const refusedRotation = await dispatch(
      'POST',
      '/provision',
      { authorization: `Bearer ${token}` },
      JSON.stringify({
        env: {
          ...identity(mainnetMagic),
          MORPHEUS_RUNTIME_TOKEN_KMS_CIPHERTEXT_BASE64: 'sealed-v2',
        },
      })
    );
    assert.equal(refusedRotation.status, 400, JSON.stringify(refusedRotation.body));
    assert.equal(envSnapshot(), before, 'a refused rotation keeps the current token');

    // Version 2 was not consumed either.
    const rotation = await dispatch(
      'POST',
      '/provision',
      { authorization: `Bearer ${token}` },
      JSON.stringify({ env: { MORPHEUS_RUNTIME_TOKEN_KMS_CIPHERTEXT_BASE64: 'sealed-v2' } })
    );
    assert.equal(rotation.status, 200, JSON.stringify(rotation.body));
    assert.equal(process.env.MORPHEUS_RUNTIME_TOKEN, `${token}-v2`);
  } finally {
    __resetAttestRunnerForTests();
    __resetRuntimeProvisionStateForTests();
    for (const [key, value] of Object.entries(savedTokens)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    delete process.env.MORPHEUS_RUNTIME_TOKEN_KMS_CIPHERTEXT_BASE64;
    delete process.env.FEED_NETWORK;
  }
});

test('D2: provision also refuses every Neo N3 key name the resolver read before S5, and the X25519 PKCS8 half', async () => {
  // Derived from the resolver's retired table, not from the export under test,
  // so a shortened Node-only list fails here.
  const expected = [
    ...new Set(
      Object.values(NEO_N3_RETIRED_PLAINTEXT_KEY_ENV_NAMES).flatMap((byRole) =>
        Object.values(byRole).flat()
      )
    ),
    'MORPHEUS_ORACLE_PRIVATE_KEY_PKCS8',
  ];
  assert.equal(expected.length, 27);
  for (const name of ['MORPHEUS_RELAYER_NEO_N3_WIF', 'NEO_N3_WIF', 'NEO_TESTNET_WIF']) {
    assert.ok(expected.includes(name), `${name} was a resolver source before S5`);
  }
  for (const name of expected) {
    assert.ok(
      PLAINTEXT_KEY_ENV_KEYS.includes(name) || NODE_ONLY_PLAINTEXT_KEY_ENV_KEYS.includes(name),
      `${name} must be refused`
    );
    const before = envSnapshot();
    const rejected = await dispatch(
      'POST',
      '/provision',
      AUTH,
      JSON.stringify({ env: { [name]: 'plaintext-value-that-must-not-land', TD_KEY: 'x' } })
    );
    assert.equal(rejected.status, 403, `${name} must be refused`);
    assert.match(rejected.body.error, new RegExp(`Rejected: .*\\b${name}\\b`));
    assert.equal(envSnapshot(), before, `${name}: a refused provision writes nothing`);
  }
  assert.ok(Object.isFrozen(NODE_ONLY_PLAINTEXT_KEY_ENV_KEYS));
});

test('first provision and rotation require versioned attestation-gated KMS runtime tokens', async () => {
  const savedTokens = Object.fromEntries(TOKEN_ENV_KEYS.map((key) => [key, process.env[key]]));
  const savedProvisionEnv = {
    ciphertext: process.env.MORPHEUS_RUNTIME_TOKEN_KMS_CIPHERTEXT_BASE64,
    accessKey: process.env.AWS_ACCESS_KEY_ID,
    secretKey: process.env.AWS_SECRET_ACCESS_KEY,
    sessionToken: process.env.AWS_SESSION_TOKEN,
  };
  for (const key of TOKEN_ENV_KEYS) delete process.env[key];
  const tokenV1 = 'operator-sealed-runtime-token-v1-0123456789abcdef';
  const tokenV2 = 'operator-sealed-runtime-token-v2-0123456789abcdef';
  let runnerEnv = null;
  __setAttestRunnerForTests((args, options) => {
    runnerEnv = options?.env || null;
    const ciphertext = args[args.indexOf('--ciphertext') + 1];
    const envelope = {
      purpose: 'neoos/nitro-runtime-auth/v1',
      network: 'testnet',
      version: ciphertext === 'sealed-v2' ? 2 : 1,
      token: ciphertext === 'sealed-v2' ? tokenV2 : tokenV1,
    };
    return {
      ok: true,
      plaintext_b64: Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64'),
    };
  });
  try {
    // A parent-chosen plaintext token is no longer a bootstrap trust anchor.
    const selfChosen = await dispatch(
      'POST',
      '/provision',
      { authorization: 'Bearer attacker-chosen-token-0123456789abcdef' },
      JSON.stringify({
        env: { MORPHEUS_RUNTIME_TOKEN: 'attacker-chosen-token-0123456789abcdef' },
      })
    );
    assert.equal(selfChosen.status, 401);

    const payloadV1 = {
      env: {
        MORPHEUS_NETWORK: 'testnet',
        FEED_NETWORK: 'testnet',
        FEED_MAGIC: String(FEED_NETWORK_DEFAULTS.testnet.magic),
        MORPHEUS_RUNTIME_TOKEN_KMS_CIPHERTEXT_BASE64: 'sealed-v1',
        AWS_ACCESS_KEY_ID: 'bootstrap-access-key',
        AWS_SECRET_ACCESS_KEY: 'bootstrap-secret-key',
        AWS_SESSION_TOKEN: 'bootstrap-session-token',
      },
    };
    const wrong = await dispatch(
      'POST',
      '/provision',
      { authorization: 'Bearer nope' },
      JSON.stringify(payloadV1)
    );
    assert.equal(wrong.status, 401);

    const ok = await dispatch(
      'POST',
      '/provision',
      { authorization: `Bearer ${tokenV1}` },
      JSON.stringify(payloadV1)
    );
    assert.equal(ok.status, 200);
    assert.equal(ok.body.provisioned, true);
    assert.ok(ok.body.env_keys.includes('MORPHEUS_RUNTIME_TOKEN_KMS_CIPHERTEXT_BASE64'));
    assert.equal(process.env.MORPHEUS_RUNTIME_TOKEN, tokenV1);
    assert.equal(runnerEnv.AWS_ACCESS_KEY_ID, 'bootstrap-access-key');

    const replay = await dispatch(
      'POST',
      '/provision',
      { authorization: `Bearer ${tokenV1}` },
      JSON.stringify(payloadV1)
    );
    assert.equal(replay.status, 409);
    assert.match(replay.body.error, /version must increase monotonically/);

    const rotated = await dispatch(
      'POST',
      '/provision',
      { authorization: `Bearer ${tokenV1}` },
      JSON.stringify({
        env: {
          ...payloadV1.env,
          MORPHEUS_RUNTIME_TOKEN_KMS_CIPHERTEXT_BASE64: 'sealed-v2',
        },
      })
    );
    assert.equal(rotated.status, 200);
    assert.equal(process.env.MORPHEUS_RUNTIME_TOKEN, tokenV2);

    const oldToken = await dispatch(
      'POST',
      '/provision',
      { authorization: `Bearer ${tokenV1}` },
      JSON.stringify({ env: { TD_KEY: 'must-not-apply' } })
    );
    assert.equal(oldToken.status, 401);
    assert.notEqual(process.env.TD_KEY, 'must-not-apply');

    const newToken = await dispatch(
      'POST',
      '/provision',
      { authorization: `Bearer ${tokenV2}` },
      JSON.stringify({ env: { TD_KEY: 'rotated-token-authorized' } })
    );
    assert.equal(newToken.status, 200);
    assert.equal(process.env.TD_KEY, 'rotated-token-authorized');
    delete process.env.TD_KEY;
  } finally {
    __resetAttestRunnerForTests();
    __resetRuntimeProvisionStateForTests();
    for (const [key, value] of Object.entries(savedTokens)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const [key, value] of [
      ['MORPHEUS_RUNTIME_TOKEN_KMS_CIPHERTEXT_BASE64', savedProvisionEnv.ciphertext],
      ['AWS_ACCESS_KEY_ID', savedProvisionEnv.accessKey],
      ['AWS_SECRET_ACCESS_KEY', savedProvisionEnv.secretKey],
      ['AWS_SESSION_TOKEN', savedProvisionEnv.sessionToken],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    delete process.env.FEED_NETWORK;
  }
});

test('start-nitro-signer requires a KMS-sealed runtime token bootstrap', () => {
  const source = readFileSync(new URL('./start-nitro-signer.sh', import.meta.url), 'utf8');
  const helper = readFileSync(new URL('./lib/provisioning.sh', import.meta.url), 'utf8');
  assert.match(
    source,
    /neoos_first_env_value "\$signer_env" MORPHEUS_RUNTIME_TOKEN NITRO_SIGNER_TOKEN/
  );
  assert.match(source, /MORPHEUS_RUNTIME_TOKEN_KMS_CIPHERTEXT_BASE64/);
  assert.match(source, /SIGNER_SERVICE_TOKEN_KMS_CIPHERTEXT_BASE64/);
  assert.match(source, /MORPHEUS_ORACLE_KMS_CIPHERTEXT_BASE64/);
  assert.match(source, /MORPHEUS_NEODID_SALT_KMS_CIPHERTEXT_BASE64/);
  assert.match(source, /neoos_require_printable_token "\$token"/);
  assert.match(source, /neoos_fetch_imds_credentials/);
  assert.match(source, /neoos_post_json .*\/provision" "\$token" "\$payload"/);
  for (const role of [
    'updater',
    'oracle_verifier',
    'relayer',
    'worker',
    'neox_updater',
    'neox_verifier',
  ]) {
    assert.match(source, new RegExp(`"${role}"`));
  }
  assert.match(source, /\$roles \| all\(\.ok == true\)/);
  assert.match(source, /did not materialize all six distinct measured custody roles/);
  assert.match(helper, /Authorization: Bearer %s/);
  assert.doesNotMatch(source, /\bnode\b|\bnpm\b/);
});

test('credential rotation cannot replay confidential or runtime provisioning', () => {
  const source = readFileSync(new URL('./provision-enclave-compute.sh', import.meta.url), 'utf8');
  assert.match(source, /\/provision\/credentials/);
  assert.doesNotMatch(source, /MORPHEUS_ORACLE_KMS_CIPHERTEXT_BASE64/);
  assert.doesNotMatch(source, /MORPHEUS_NEODID_SALT_KMS_CIPHERTEXT_BASE64/);
  assert.doesNotMatch(source, /createDecipheriv|deriveKeyBytes/);
  assert.doesNotMatch(source, /env\.MORPHEUS_ORACLE_KEY_MATERIAL_(?:JSON|BASE64)\s*=/);
  assert.doesNotMatch(source, /env\.NEODID_SECRET_SALT\s*=/);
});

test('route matching: a non-prefix path that merely ends with a route is not matched', async () => {
  // path.endsWith('/health') would have matched '/evil/path/health'; matchesRoute
  // requires a single-segment network prefix, so this is a 404 (GET) and the
  // multi-segment-prefixed sensitive route is not reachable.
  const bogusHealth = await dispatch('GET', '/evil/path/health', {}, '');
  assert.equal(bogusHealth.status, 404);

  // A single-segment network prefix on a public route still works.
  const okHealth = await dispatch('GET', '/testnet/health', {}, '');
  assert.ok(okHealth.status === 200 || okHealth.status === 503);
});

test('execution-plane passthrough forwards whitelisted routes to the worker (auth-gated)', async () => {
  // No auth -> 401 before reaching the worker.
  const noAuth = await dispatch(
    'POST',
    '/mainnet/oracle/smart-fetch',
    {},
    JSON.stringify({ symbol: 'BTC/USD' })
  );
  assert.equal(noAuth.status, 401);

  // Authed whitelisted route -> forwarded to the in-process worker handler.
  const ok = await dispatch(
    'POST',
    '/mainnet/oracle/smart-fetch',
    AUTH,
    JSON.stringify({ symbol: 'BTC/USD' })
  );
  assert.equal(ok.status, 200);
  assert.equal(ok.body.symbol, 'BTC/USD'); // FIXED_PRICE_BODY from the stubbed worker

  // A non-whitelisted route is NOT passed through (stays 404, not forwarded).
  const notWhitelisted = await dispatch('POST', '/mainnet/admin/wipe', AUTH, JSON.stringify({}));
  assert.equal(notWhitelisted.status, 404);
});

test('/oracle/public-key is served (ungated) from the in-TEE worker key material', async () => {
  // GET, NO auth: a public key is not secret. It must reach the worker, which returns
  // the enclave's ACTUAL materialized X25519 public key (ensureOracleKeyMaterial).
  const got = await dispatch('GET', '/mainnet/oracle/public-key', {}, '');
  assert.equal(got.status, 200);
  assert.equal(got.body.public_key, 'TEST_PUBLIC_KEY_BASE64');
  assert.equal(got.body.algorithm, 'X25519-HKDF-SHA256-AES-256-GCM');

  // POST is accepted too (the publish flow may send a payload).
  const posted = await dispatch('POST', '/testnet/oracle/public-key', {}, JSON.stringify({}));
  assert.equal(posted.status, 200);
  assert.equal(posted.body.public_key, 'TEST_PUBLIC_KEY_BASE64');
});

test('cleanup: reset stubbed worker handler', () => {
  __resetWorkerHandlerForTests();
  delete process.env.TD_KEY;
  assert.ok(true);
});

test('materializeOracleKeyFromKms recovers the oracle key in-TEE from a KMS ciphertext (RC2)', () => {
  const KEYJSON = JSON.stringify({ public_key_raw: 'cHVi', private_key_pkcs8: 'cHJpdg==' });
  const saved = {
    json: process.env.MORPHEUS_ORACLE_KEY_MATERIAL_JSON,
    b64: process.env.MORPHEUS_ORACLE_KEY_MATERIAL_BASE64,
    ct: process.env.MORPHEUS_ORACLE_KMS_CIPHERTEXT_BASE64,
  };
  delete process.env.MORPHEUS_ORACLE_KEY_MATERIAL_JSON;
  delete process.env.MORPHEUS_ORACLE_KEY_MATERIAL_BASE64;
  let calledWith = null;
  __setAttestRunnerForTests((args) => {
    calledWith = args;
    return { ok: true, plaintext_b64: Buffer.from(KEYJSON, 'utf8').toString('base64') };
  });
  try {
    // no-op when no ciphertext is provisioned
    delete process.env.MORPHEUS_ORACLE_KMS_CIPHERTEXT_BASE64;
    materializeOracleKeyFromKms();
    assert.equal(calledWith, null);
    assert.equal(process.env.MORPHEUS_ORACLE_KEY_MATERIAL_JSON, undefined);

    // materializes from the ciphertext via attested kms-decrypt
    process.env.MORPHEUS_ORACLE_KMS_CIPHERTEXT_BASE64 = 'Y2lwaGVydGV4dA==';
    materializeOracleKeyFromKms();
    assert.equal(calledWith[0], 'kms-decrypt');
    assert.ok(calledWith.includes('--ciphertext'));
    assert.equal(process.env.MORPHEUS_ORACLE_KEY_MATERIAL_JSON, KEYJSON);

    // idempotent: already materialized -> does not re-run kms-decrypt
    calledWith = null;
    materializeOracleKeyFromKms();
    assert.equal(calledWith, null);
  } finally {
    __resetAttestRunnerForTests();
    for (const [k, v] of [
      ['MORPHEUS_ORACLE_KEY_MATERIAL_JSON', saved.json],
      ['MORPHEUS_ORACLE_KEY_MATERIAL_BASE64', saved.b64],
      ['MORPHEUS_ORACLE_KMS_CIPHERTEXT_BASE64', saved.ct],
    ]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('materializeNeoXVerifierKeyFromKms recovers the EVM verifier key in-TEE from a KMS ciphertext (Phase D)', () => {
  // a deterministic secp256k1 test key; its address is derived via ethers below.
  const PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
  const expectedAddress = new ethers.Wallet(PK).address;
  const saved = {
    pk: process.env.MORPHEUS_NEOX_VERIFIER_PRIVATE_KEY,
    key: process.env.MORPHEUS_NEOX_VERIFIER_KEY,
    npk: process.env.NEOX_VERIFIER_PK,
    ct: process.env.MORPHEUS_NEOX_VERIFIER_KMS_CIPHERTEXT_BASE64,
  };
  delete process.env.MORPHEUS_NEOX_VERIFIER_PRIVATE_KEY;
  delete process.env.MORPHEUS_NEOX_VERIFIER_KEY;
  delete process.env.NEOX_VERIFIER_PK;
  let calledWith = null;
  let plaintext = PK; // raw-hex form by default
  __setAttestRunnerForTests((args) => {
    calledWith = args;
    return { ok: true, plaintext_b64: Buffer.from(plaintext, 'utf8').toString('base64') };
  });
  try {
    // no-op when no ciphertext is provisioned
    delete process.env.MORPHEUS_NEOX_VERIFIER_KMS_CIPHERTEXT_BASE64;
    materializeNeoXVerifierKeyFromKms();
    assert.equal(calledWith, null);
    assert.equal(process.env.MORPHEUS_NEOX_VERIFIER_PRIVATE_KEY, undefined);

    // materializes a RAW-HEX key from the ciphertext via attested kms-decrypt
    process.env.MORPHEUS_NEOX_VERIFIER_KMS_CIPHERTEXT_BASE64 = 'Y2lwaGVydGV4dA==';
    materializeNeoXVerifierKeyFromKms();
    assert.equal(calledWith[0], 'kms-decrypt');
    assert.ok(calledWith.includes('--ciphertext'));
    assert.equal(process.env.MORPHEUS_NEOX_VERIFIER_PRIVATE_KEY, PK);
    // the recovered key is a usable secp256k1 key (recovers to the expected address)
    assert.equal(
      new ethers.Wallet(process.env.MORPHEUS_NEOX_VERIFIER_PRIVATE_KEY).address,
      expectedAddress
    );

    // idempotent: already materialized -> does not re-run kms-decrypt
    calledWith = null;
    materializeNeoXVerifierKeyFromKms();
    assert.equal(calledWith, null);

    // a JSON-envelope plaintext ({neox_verifier_private_key}) is also accepted
    delete process.env.MORPHEUS_NEOX_VERIFIER_PRIVATE_KEY;
    plaintext = JSON.stringify({ neox_verifier_private_key: PK });
    materializeNeoXVerifierKeyFromKms();
    assert.equal(process.env.MORPHEUS_NEOX_VERIFIER_PRIVATE_KEY, PK);
  } finally {
    __resetAttestRunnerForTests();
    for (const [k, v] of [
      ['MORPHEUS_NEOX_VERIFIER_PRIVATE_KEY', saved.pk],
      ['MORPHEUS_NEOX_VERIFIER_KEY', saved.key],
      ['NEOX_VERIFIER_PK', saved.npk],
      ['MORPHEUS_NEOX_VERIFIER_KMS_CIPHERTEXT_BASE64', saved.ct],
    ]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('materializeNeoXFeedKeyFromKms recovers the EVM feed key in-TEE from a KMS ciphertext (Phase D)', () => {
  const PK = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';
  const expectedAddress = new ethers.Wallet(PK).address;
  const saved = {
    pk: process.env.MORPHEUS_NEOX_FEED_PRIVATE_KEY,
    npk: process.env.NEOX_FEED_PK,
    fpk: process.env.NEOX_FEED_PRIVATE_KEY,
    ct: process.env.MORPHEUS_NEOX_FEED_KMS_CIPHERTEXT_BASE64,
  };
  delete process.env.MORPHEUS_NEOX_FEED_PRIVATE_KEY;
  delete process.env.NEOX_FEED_PK;
  delete process.env.NEOX_FEED_PRIVATE_KEY;
  let calledWith = null;
  __setAttestRunnerForTests((args) => {
    calledWith = args;
    return { ok: true, plaintext_b64: Buffer.from(PK, 'utf8').toString('base64') };
  });
  try {
    // no-op when no ciphertext is provisioned
    delete process.env.MORPHEUS_NEOX_FEED_KMS_CIPHERTEXT_BASE64;
    materializeNeoXFeedKeyFromKms();
    assert.equal(calledWith, null);
    assert.equal(process.env.MORPHEUS_NEOX_FEED_PRIVATE_KEY, undefined);

    // materializes from the ciphertext via attested kms-decrypt
    process.env.MORPHEUS_NEOX_FEED_KMS_CIPHERTEXT_BASE64 = 'Y2lwaGVydGV4dA==';
    materializeNeoXFeedKeyFromKms();
    assert.equal(calledWith[0], 'kms-decrypt');
    assert.equal(process.env.MORPHEUS_NEOX_FEED_PRIVATE_KEY, PK);
    assert.equal(
      new ethers.Wallet(process.env.MORPHEUS_NEOX_FEED_PRIVATE_KEY).address,
      expectedAddress
    );

    // idempotent: already materialized -> does not re-run kms-decrypt
    calledWith = null;
    materializeNeoXFeedKeyFromKms();
    assert.equal(calledWith, null);
  } finally {
    __resetAttestRunnerForTests();
    for (const [k, v] of [
      ['MORPHEUS_NEOX_FEED_PRIVATE_KEY', saved.pk],
      ['NEOX_FEED_PK', saved.npk],
      ['NEOX_FEED_PRIVATE_KEY', saved.fpk],
      ['MORPHEUS_NEOX_FEED_KMS_CIPHERTEXT_BASE64', saved.ct],
    ]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('materializeNeoDidSaltFromKms releases the nullifier salt only inside the enclave', () => {
  const salt = 'ab'.repeat(32);
  const saved = {
    salt: process.env.NEODID_SECRET_SALT,
    ct: process.env.MORPHEUS_NEODID_SALT_KMS_CIPHERTEXT_BASE64,
  };
  delete process.env.NEODID_SECRET_SALT;
  let calledWith = null;
  __setAttestRunnerForTests((args) => {
    calledWith = args;
    return {
      ok: true,
      plaintext_b64: Buffer.from(JSON.stringify({ neodid_secret_salt: salt }), 'utf8').toString(
        'base64'
      ),
    };
  });
  try {
    delete process.env.MORPHEUS_NEODID_SALT_KMS_CIPHERTEXT_BASE64;
    materializeNeoDidSaltFromKms();
    assert.equal(calledWith, null);
    assert.equal(process.env.NEODID_SECRET_SALT, undefined);

    process.env.MORPHEUS_NEODID_SALT_KMS_CIPHERTEXT_BASE64 = 'Y2lwaGVydGV4dA==';
    materializeNeoDidSaltFromKms();
    assert.equal(calledWith[0], 'kms-decrypt');
    assert.equal(process.env.NEODID_SECRET_SALT, salt);
  } finally {
    __resetAttestRunnerForTests();
    if (saved.salt === undefined) delete process.env.NEODID_SECRET_SALT;
    else process.env.NEODID_SECRET_SALT = saved.salt;
    if (saved.ct === undefined) delete process.env.MORPHEUS_NEODID_SALT_KMS_CIPHERTEXT_BASE64;
    else process.env.MORPHEUS_NEODID_SALT_KMS_CIPHERTEXT_BASE64 = saved.ct;
  }
});
