// Golden-vector consensus gate for deploy/nitro/enclave-server.mjs.
//
// PROVES the enclave-server's /oracle/fulfill produces a fulfillment digest +
// result envelope that are BYTE-IDENTICAL to the canonical relayer builders, and
// a signature that verifies against the returned public key — across neo_n3
// (with appId), legacy neo_n3 (no appId), and neox.
//
// How compute is made deterministic: the worker `handler` is STUBBED via the
// test-only seam __setWorkerHandlerForTests so each lane returns a FIXED result
// body (a fixed price string, a fixed 32-byte VRF randomness). The worker source
// is never touched. This isolates the test to the digest/envelope/signature
// pipeline — the consensus-critical part — instead of live price data.
//
// How byte-exactness is proven: the test feeds the SAME {ok, status, body}
// workerResponse the server's stub returned into the IMPORTED builders
// (encodeFulfillmentResult, buildOnchainResultEnvelope, buildFulfillmentDigestBytes
// / buildNeoXDigest) independently, and asserts the server's
// fulfillment_digest_hex + verification equal the independently-recomputed values.
// Because the server uses those exact imported builders, equality proves it did
// NOT re-derive the digest.

import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import neonPkg, { wallet as neoWallet } from '@cityofzion/neon-js';
import { ethers } from 'ethers';

const { sc, tx, u } = neonPkg;

import {
  buildFulfillmentDigestBytes,
  buildOnchainResultEnvelope,
  encodeFulfillmentResult,
  resolveKernelIntent,
} from '../../workers/morpheus-relayer/src/router.js';
import { buildNeoXDigest, resolveResultBytesHex } from '../../workers/morpheus-relayer/src/neox.js';

// ---------------------------------------------------------------------------
// Test-only keys + env (injected BEFORE importing the server so resolveNetwork /
// signer resolution see them). MORPHEUS_ALLOW_UNPINNED_SIGNERS lets us use a
// freshly-generated oracle_verifier key without matching the committed pinned
// identity (test-only — never use in production).
// ---------------------------------------------------------------------------
process.env.MORPHEUS_NETWORK = 'testnet';
process.env.MORPHEUS_ALLOW_UNPINNED_SIGNERS = '1';

const ORACLE_VERIFIER_ACCOUNT = new neoWallet.Account(neoWallet.generatePrivateKey());
process.env.MORPHEUS_ORACLE_VERIFIER_PRIVATE_KEY_TESTNET = ORACLE_VERIFIER_ACCOUNT.privateKey;

// Test-only updater key (the feed signer). Unpinned (allowed via the flag above).
const UPDATER_ACCOUNT = new neoWallet.Account(neoWallet.generatePrivateKey());
process.env.MORPHEUS_UPDATER_NEO_N3_PRIVATE_KEY_TESTNET = UPDATER_ACCOUNT.privateKey;

// Pin the N3 magic the feed tx is signed under so the server + the independent
// test recompute use the SAME magic (default 860833102; explicit for clarity).
process.env.FEED_MAGIC = '860833102';

// feed-pusher.mjs runs a live cycle on import unless this is set — pin it before
// either the server OR this test imports it (both import planFeedUpdate from it).
process.env.FEED_PUSHER_SKIP_MAIN = '1';

// Deterministic test-only EVM verifier key.
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
  __setFeedTxParamsProviderForTests,
  __resetFeedTxParamsProviderForTests,
  __setAttestRunnerForTests,
  __resetAttestRunnerForTests,
  __setAsyncAttestRunnerForTests,
  __resetAsyncAttestRunnerForTests,
  materializeOracleKeyFromKms,
  materializeNeoXVerifierKeyFromKms,
  materializeNeoXFeedKeyFromKms,
  materializeNeoDidSaltFromKms,
  __resetRuntimeProvisionStateForTests,
} = enclave;

// Import planFeedUpdate from the feed-pusher INDEPENDENTLY (the SAME decision the
// server imports) so the /feed/sign golden vector recomputes the planned arrays
// with the canonical function, not a copy.
const { planFeedUpdate } = await import('../feed-pusher/feed-pusher.mjs');

// Feed contract constants — MIRRORED from feed-pusher.mjs pushNeoN3 so the test's
// independent tx build matches the server's. If feed-pusher.mjs changes these the
// test (correctly) breaks alongside the server.
const FEED_N3_CONTRACT = '03013f49c42a14546c8bbe58f9d434c3517fccab';
const FEED_N3_MAGIC = Number(process.env.FEED_MAGIC);

// ---------------------------------------------------------------------------
// Deterministic worker-handler stub. Returns a fixed Response per route so the
// pipeline (encode -> envelope -> digest -> sign) is exercised against a known
// body. The body shapes mirror the real worker lanes:
//   - /oracle/query, /oracle/feed: a price/oracle result body
//   - /vrf/random: { randomness } (fixed 32 bytes)
//   - /oracle/decrypt: { plaintext } -> but encodeFulfillmentResult for decrypt is
//     handled by the relayer's special-case; here the generic encode is exercised
//     for query/feed/vrf which is sufficient for the digest pipeline proof.
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

function installDeterministicWorker() {
  __setWorkerHandlerForTests(async (request) => {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, '');
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

before(() => {
  installDeterministicWorker();
});

beforeEach(() => {
  installDeterministicWorker();
});

// Recompute the workerResponse the stub produced for a given route, so the test
// can drive the imported builders INDEPENDENTLY of the server.
function expectedWorkerResponse(requestType) {
  const intent = resolveKernelIntent(requestType);
  if (intent.moduleId === 'random.generate') {
    return { ok: true, status: 200, body: { request_id: '1', randomness: FIXED_VRF_RANDOMNESS } };
  }
  return { ok: true, status: 200, body: { ...FIXED_PRICE_BODY } };
}

// ---------------------------------------------------------------------------
// neo_n3 (with appId) — full kernel envelope digest, deployment-bound.
// ---------------------------------------------------------------------------

test('neo_n3 (with appId): digest + envelope + signature byte-exact', async () => {
  const requestType = 'oracle_query';
  const requestId = '4242';
  const contractScriptHash = '0x' + '1f'.repeat(20);
  const networkMagic = 894710606; // Neo N3 testnet
  const appId = 'demo.app';
  const moduleId = resolveKernelIntent(requestType).moduleId;
  const operation = resolveKernelIntent(requestType).operation;

  const req = {
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
  };

  const { status, body } = await dispatch('POST', '/oracle/fulfill', AUTH, JSON.stringify(req));
  assert.equal(status, 200, `dispatch failed: ${JSON.stringify(body)}`);
  assert.equal(body.status, 'ok');
  assert.equal(body.trust_tier, 'enclave-attested');
  assert.equal(body.success, true);
  assert.equal(body.nonce, 'deadbeef');

  // Independently recompute from the SAME workerResponse the stub returned.
  const workerResponse = expectedWorkerResponse(requestType);
  const fulfillment = encodeFulfillmentResult(requestType, workerResponse);
  const expectedEnvelope = buildOnchainResultEnvelope(requestType, workerResponse);
  const expectedDigest = buildFulfillmentDigestBytes(
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
      contractScriptHash,
      networkMagic,
    }
  ).toString('hex');

  // Byte-exactness: server digest === independently-recomputed canonical digest.
  assert.equal(
    body.fulfillment_digest_hex,
    expectedDigest,
    'fulfillment digest must be byte-exact'
  );
  // Result + envelope match the canonical encoding.
  assert.equal(body.result, fulfillment.result || '');
  assert.deepEqual(body.verification, expectedEnvelope);

  // Negative control: a digest WITHOUT the deployment binding (a common
  // re-derivation mistake) must NOT match — proving the server actually appended
  // the contract script hash + network magic via the canonical builder.
  const digestNoBinding = buildFulfillmentDigestBytes(
    requestId,
    requestType,
    fulfillment.success,
    fulfillment.result || '',
    fulfillment.error || '',
    fulfillment.result_bytes_base64 || '',
    { chain: 'neo_n3', appId, moduleId, operation } // no contractScriptHash/networkMagic
  ).toString('hex');
  assert.notEqual(
    body.fulfillment_digest_hex,
    digestNoBinding,
    'digest must include the deployment binding (script hash + magic)'
  );

  // Signature verifies against the returned public_key over the digest (secp256r1).
  assert.equal(
    body.public_key.toLowerCase(),
    ORACLE_VERIFIER_ACCOUNT.publicKey.toLowerCase(),
    'public_key must be the oracle_verifier'
  );
  assert.equal(
    neoWallet.verify(body.fulfillment_digest_hex, body.signature, body.public_key),
    true,
    'signature must verify over the digest'
  );
});

// ---------------------------------------------------------------------------
// legacy neo_n3 (no appId) — legacy digest domain, requestType-based.
// ---------------------------------------------------------------------------

test('legacy neo_n3 (no appId): legacy digest + signature byte-exact', async () => {
  const requestType = 'oracle_query';
  const requestId = '7';

  const req = {
    chain: 'legacy',
    request_type: requestType,
    request_id: requestId,
    payload: { symbol: 'BTC/USD' },
    fulfillment_context: {}, // no appId -> legacy domain
    nonce: '',
  };

  const { status, body } = await dispatch('POST', '/oracle/fulfill', AUTH, JSON.stringify(req));
  assert.equal(status, 200, `dispatch failed: ${JSON.stringify(body)}`);
  assert.equal(body.trust_tier, 'enclave-attested');

  const workerResponse = expectedWorkerResponse(requestType);
  const fulfillment = encodeFulfillmentResult(requestType, workerResponse);
  const expectedEnvelope = buildOnchainResultEnvelope(requestType, workerResponse);
  const expectedDigest = buildFulfillmentDigestBytes(
    requestId,
    requestType,
    fulfillment.success,
    fulfillment.result || '',
    fulfillment.error || '',
    fulfillment.result_bytes_base64 || '',
    { chain: 'legacy', appId: '', moduleId: '', operation: '' }
  ).toString('hex');

  assert.equal(body.fulfillment_digest_hex, expectedDigest, 'legacy digest must be byte-exact');
  assert.deepEqual(body.verification, expectedEnvelope);
  assert.equal(
    neoWallet.verify(body.fulfillment_digest_hex, body.signature, body.public_key),
    true,
    'legacy signature must verify over the digest'
  );
});

// ---------------------------------------------------------------------------
// neo_n3 VRF (with FIXED randomness) — compact callback bytes lane.
// ---------------------------------------------------------------------------

test('neo_n3 vrf (fixed randomness): compact callback digest + signature byte-exact', async () => {
  const requestType = 'random';
  const requestId = '99';
  const appId = 'dice.app';
  const moduleId = resolveKernelIntent(requestType).moduleId; // random.generate
  const operation = resolveKernelIntent(requestType).operation;
  const contractScriptHash = '0x' + '2c'.repeat(20);
  const networkMagic = 894710606;

  const req = {
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
  };

  const { status, body } = await dispatch('POST', '/oracle/fulfill', AUTH, JSON.stringify(req));
  assert.equal(status, 200, `dispatch failed: ${JSON.stringify(body)}`);

  const workerResponse = expectedWorkerResponse(requestType);
  const fulfillment = encodeFulfillmentResult(requestType, workerResponse);
  // VRF -> compact 32-byte randomness as result_bytes_base64, empty result string.
  assert.equal(fulfillment.result, '');
  assert.ok(fulfillment.result_bytes_base64, 'vrf must produce compact callback bytes');
  assert.equal(
    body.result_bytes_base64,
    fulfillment.result_bytes_base64,
    'server must return the compact callback bytes'
  );
  // The compact bytes must decode to the fixed randomness.
  assert.equal(
    Buffer.from(body.result_bytes_base64, 'base64').toString('hex'),
    FIXED_VRF_RANDOMNESS,
    'compact callback bytes must equal the fixed VRF randomness'
  );

  const expectedDigest = buildFulfillmentDigestBytes(
    requestId,
    requestType,
    fulfillment.success,
    fulfillment.result || '',
    fulfillment.error || '',
    fulfillment.result_bytes_base64 || '',
    { chain: 'neo_n3', appId, moduleId, operation, contractScriptHash, networkMagic }
  ).toString('hex');

  assert.equal(body.fulfillment_digest_hex, expectedDigest, 'vrf digest must be byte-exact');
  assert.equal(
    neoWallet.verify(body.fulfillment_digest_hex, body.signature, body.public_key),
    true,
    'vrf signature must verify over the digest'
  );
});

// ---------------------------------------------------------------------------
// neox (EVM) — keccak digest + EIP-191 signature.
// ---------------------------------------------------------------------------

test('neox: keccak digest + envelope + EIP-191 signature byte-exact', async () => {
  const requestType = 'oracle_query';
  const requestId = '123';
  const appId = 'evm.app';
  const moduleId = resolveKernelIntent(requestType).moduleId;
  const operation = resolveKernelIntent(requestType).operation;
  const chainId = 12227332; // Neo X testnet
  const oracleContract = '0xeCFC1C652B5cCdBfe3E9314a83156787D92a3fD2';

  const req = {
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
  };

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

// ---------------------------------------------------------------------------
// Host-unattested lane: arbitrary-URL smart-fetch is NOT signed in-enclave.
// ---------------------------------------------------------------------------

test('arbitrary-url smart-fetch is host-unattested (no in-enclave signature)', async () => {
  const req = {
    chain: 'neo_n3',
    request_type: 'privacy_oracle', // -> oracle.fetch -> /oracle/smart-fetch
    request_id: '5',
    payload: { url: 'https://example.com/data' },
    fulfillment_context: { app_id: 'x' },
  };
  // smart-fetch is the host-tier lane.
  assert.equal(resolveKernelIntent('privacy_oracle').workerRoute, '/oracle/smart-fetch');

  const { status, body } = await dispatch('POST', '/oracle/fulfill', AUTH, JSON.stringify(req));
  assert.equal(status, 200);
  assert.equal(body.trust_tier, 'host-unattested');
  assert.equal(body.signature, null);
  assert.equal(body.fulfillment_digest_hex, null);
});

// ---------------------------------------------------------------------------
// /feed/sign — golden vector: the signed updateFeeds message is byte-identical to
// what feed-pusher.mjs pushNeoN3 signs today, and the signature verifies.
// ---------------------------------------------------------------------------

// Independently rebuild the EXACT updateFeeds tx feed-pusher.mjs pushNeoN3 builds
// (sc.createScript + tx.Transaction + getMessageForSigning), using raw neon-js —
// NOT the server's builder. Equality proves the server reproduced the on-chain
// message byte-for-byte. This mirrors pushNeoN3 lines 300-336 precisely.
// txParams must include the EXACT nonce the server used (tx.Transaction otherwise
// assigns a random nonce, making getMessageForSigning non-deterministic). The
// server returns its nonce as body.tx_nonce so the broadcaster — and this test —
// rebuild the identical tx.
function feedPusherTxMessage(planned, txParams, updaterPublicKey) {
  const { P, R, PX, TS, AH, SS } = planned;
  const script = sc.createScript({
    scriptHash: FEED_N3_CONTRACT,
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
  return txn.getMessageForSigning(FEED_N3_MAGIC);
}

test('feed/sign: updateFeeds tx message byte-identical to feed-pusher + signature verifies', async () => {
  // Deterministic price set (the stubbed in-enclave fetch), fixed clock, and the
  // on-chain state the relayer/feed-pusher would read on the host.
  const FIXED_NOW = 1_780_000_000;
  const SYMBOLS = ['NEO-USD', 'GAS-USD', 'BTC-USD'];
  const STUB_PRICES = { 'NEO-USD': 5.25, 'GAS-USD': 2.1, 'BTC-USD': 65000.123456 };
  const ONCHAIN_STATE = {
    // NEO/BTC will push (price move / no prior record); GAS is unchanged+recent → skipped.
    'NEO-USD': { round: FIXED_NOW - 60, price: 5.0, timestamp: FIXED_NOW - 60 },
    'GAS-USD': { round: FIXED_NOW - 60, price: 2.1, timestamp: FIXED_NOW - 60 },
    'BTC-USD': { round: 0, price: 0, timestamp: 0 },
  };
  // Pin the tx nonce so the message is deterministic (tx.Transaction otherwise
  // randomizes it). The server echoes it back as body.tx_nonce.
  const TX_PARAMS = { block_count: 1234567, system_fee: 1234567, network_fee: 234567, nonce: 777 };

  __setPriceFetcherForTests(async (syms) => {
    const out = {};
    for (const s of syms) if (s in STUB_PRICES) out[s] = STUB_PRICES[s];
    return out;
  });

  const req = {
    chain: 'neo_n3',
    symbols: SYMBOLS,
    onchain_state: ONCHAIN_STATE,
    now: FIXED_NOW,
    tx_params: TX_PARAMS,
    nonce: 'cafe',
  };

  const { status, body } = await dispatch('POST', '/feed/sign', AUTH, JSON.stringify(req));
  assert.equal(status, 200, `dispatch failed: ${JSON.stringify(body)}`);
  assert.equal(body.status, 'ok');
  assert.equal(body.trust_tier, 'enclave-attested');
  assert.equal(body.nonce, 'cafe');

  // Independently recompute the planned arrays using the IMPORTED planFeedUpdate +
  // the SAME scaling/attestation-hash feed-pusher.mjs uses.
  const planned = { P: [], R: [], PX: [], TS: [], AH: [], SS: [] };
  for (const s of SYMBOLS) {
    if (!(s in STUB_PRICES)) continue;
    const cur = {
      round: ONCHAIN_STATE[s].round,
      price: ONCHAIN_STATE[s].price,
      ts: ONCHAIN_STATE[s].timestamp,
    };
    const px = Math.round(STUB_PRICES[s] * 1e6);
    const plan = planFeedUpdate(cur, STUB_PRICES[s], FIXED_NOW);
    if (!plan.push) continue;
    planned.P.push('TWELVEDATA:' + s);
    planned.R.push(plan.round);
    planned.PX.push(px);
    planned.TS.push(plan.ts);
    planned.AH.push(
      createHash('sha256').update(`${s}|${px}|${plan.ts}`).digest('hex').slice(0, 32)
    );
    planned.SS.push(0);
  }

  // GAS-USD is skipped (recent + unchanged); only NEO + BTC are signed.
  assert.deepEqual(body.pairs, ['TWELVEDATA:NEO-USD', 'TWELVEDATA:BTC-USD']);
  assert.deepEqual(body.prices_scaled, planned.PX);
  assert.deepEqual(body.rounds, planned.R);
  assert.deepEqual(body.timestamps, planned.TS);
  assert.deepEqual(body.attestation_hashes, planned.AH);
  assert.deepEqual(body.source_set_ids, planned.SS);
  assert.ok(
    body.skipped.some((e) => e.symbol === 'GAS-USD'),
    'GAS-USD must be reported skipped (recent + unchanged)'
  );

  // The server returns the nonce it used; rebuilding with it must reproduce the
  // signed message byte-for-byte. (Also assert the server honoured our pin.)
  assert.equal(body.tx_nonce, TX_PARAMS.nonce, 'server must honour the supplied tx nonce');
  assert.equal(body.valid_until_block, TX_PARAMS.block_count + 500);

  // The load-bearing assertion: the server's signed message === the message
  // feed-pusher.mjs would sign, recomputed independently from raw neon-js using
  // the SAME nonce the server returned.
  const expectedMessage = feedPusherTxMessage(
    planned,
    {
      blockCount: TX_PARAMS.block_count,
      systemFee: TX_PARAMS.system_fee,
      networkFee: TX_PARAMS.network_fee,
      nonce: body.tx_nonce,
    },
    UPDATER_ACCOUNT.publicKey
  );
  assert.equal(
    body.tx_message_hex,
    expectedMessage,
    'feed tx message must be byte-identical to feed-pusher.mjs'
  );

  // The signer is the updater, and the signature verifies over that message.
  assert.equal(
    body.public_key.toLowerCase(),
    UPDATER_ACCOUNT.publicKey.toLowerCase(),
    'feed signer must be the updater'
  );
  assert.equal(
    neoWallet.verify(body.tx_message_hex, body.signature, body.public_key),
    true,
    'feed signature must verify over the tx message'
  );

  // Sanity: a Witness built from this signature is the witness feed-pusher.mjs
  // attaches (tx.Witness.fromSignature(sig, pub)) — proves the signature is in the
  // form the broadcast path consumes.
  const witness = tx.Witness.fromSignature(body.signature, body.public_key);
  assert.ok(witness.invocationScript.toString().length > 0);

  __resetPriceFetcherForTests();
});

test('feed/sign: no symbol clears the push decision → no-update (no signature)', async () => {
  const FIXED_NOW = 1_780_000_000;
  __setPriceFetcherForTests(async () => ({ 'NEO-USD': 5.0 }));
  const req = {
    chain: 'neo_n3',
    symbols: ['NEO-USD'],
    // recent + unchanged → planFeedUpdate returns push:false
    onchain_state: { 'NEO-USD': { round: FIXED_NOW - 60, price: 5.0, timestamp: FIXED_NOW - 60 } },
    now: FIXED_NOW,
  };
  const { status, body } = await dispatch('POST', '/feed/sign', AUTH, JSON.stringify(req));
  assert.equal(status, 200);
  assert.equal(body.status, 'no-update');
  assert.equal(body.tx_message_hex, null);
  assert.equal(body.signature, null);
  assert.deepEqual(body.pairs, []);
  __resetPriceFetcherForTests();
});

test('feed/sign: tx params come from the provider seam when not supplied in the request', async () => {
  const FIXED_NOW = 1_780_000_000;
  __setPriceFetcherForTests(async () => ({ 'NEO-USD': 7.0 }));
  // No tx_params in the request → the server pulls them from the provider seam
  // (in production: an RPC read via the egress lane). Pin a nonce so the rebuild
  // is deterministic.
  __setFeedTxParamsProviderForTests(async () => ({
    blockCount: 9000000,
    systemFee: 555,
    networkFee: 666,
  }));
  const req = {
    chain: 'neo_n3',
    symbols: ['NEO-USD'],
    onchain_state: { 'NEO-USD': { round: FIXED_NOW - 60, price: 5.0, timestamp: FIXED_NOW - 60 } },
    now: FIXED_NOW,
    tx_nonce: 4242,
  };
  const { status, body } = await dispatch('POST', '/feed/sign', AUTH, JSON.stringify(req));
  assert.equal(status, 200, `dispatch failed: ${JSON.stringify(body)}`);
  assert.equal(body.status, 'ok');
  assert.equal(
    body.valid_until_block,
    9000000 + 500,
    'valid_until_block must come from the provider'
  );
  assert.equal(body.tx_nonce, 4242);

  // Rebuild independently with the provider's params + returned nonce.
  const px = Math.round(7.0 * 1e6);
  const plan = planFeedUpdate(
    { round: FIXED_NOW - 60, price: 5.0, ts: FIXED_NOW - 60 },
    7.0,
    FIXED_NOW
  );
  const planned = {
    P: ['TWELVEDATA:NEO-USD'],
    R: [plan.round],
    PX: [px],
    TS: [plan.ts],
    AH: [createHash('sha256').update(`NEO-USD|${px}|${plan.ts}`).digest('hex').slice(0, 32)],
    SS: [0],
  };
  const expectedMessage = feedPusherTxMessage(
    planned,
    { blockCount: 9000000, systemFee: 555, networkFee: 666, nonce: body.tx_nonce },
    UPDATER_ACCOUNT.publicKey
  );
  assert.equal(
    body.tx_message_hex,
    expectedMessage,
    'provider-param tx message must be byte-exact'
  );
  assert.equal(neoWallet.verify(body.tx_message_hex, body.signature, body.public_key), true);

  __resetFeedTxParamsProviderForTests();
  __resetPriceFetcherForTests();
});

test('feed/sign: missing tx params (no request params, default provider) surfaces 503', async () => {
  const FIXED_NOW = 1_780_000_000;
  // 5.0 -> 5.5 is a 10% move: past the bps threshold, well under the 50%
  // deviation ceiling, so the symbol pushes and the provider IS reached.
  __setPriceFetcherForTests(async () => ({ 'NEO-USD': 5.5 }));
  __resetFeedTxParamsProviderForTests(); // default provider throws 503
  const req = {
    chain: 'neo_n3',
    symbols: ['NEO-USD'],
    onchain_state: { 'NEO-USD': { round: FIXED_NOW - 60, price: 5.0, timestamp: FIXED_NOW - 60 } },
    now: FIXED_NOW,
  };
  const { status, body } = await dispatch('POST', '/feed/sign', AUTH, JSON.stringify(req));
  assert.equal(status, 503, `expected 503, got ${status}: ${JSON.stringify(body)}`);
  assert.match(body.error, /tx network params/);
  __resetPriceFetcherForTests();
});

test('feed/sign: rejects host-supplied N3 fees above enclave safety ceilings', async () => {
  const FIXED_NOW = 1_780_000_000;
  __setPriceFetcherForTests(async () => ({ 'NEO-USD': 5.5 }));
  try {
    const request = {
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
    };
    const rejected = await dispatch('POST', '/feed/sign', AUTH, JSON.stringify(request));
    assert.equal(rejected.status, 400);
    assert.match(rejected.body.error, /system_fee.*ceiling/);
  } finally {
    __resetPriceFetcherForTests();
  }
});

test('feed/sign: a symbol missing from the price fetch is reported, not signed', async () => {
  const FIXED_NOW = 1_780_000_000;
  __setPriceFetcherForTests(async () => ({ 'NEO-USD': 6.0 })); // GAS-USD missing
  const req = {
    chain: 'neo_n3',
    symbols: ['NEO-USD', 'GAS-USD'],
    onchain_state: {
      'NEO-USD': { round: FIXED_NOW - 60, price: 5.0, timestamp: FIXED_NOW - 60 },
      'GAS-USD': { round: FIXED_NOW - 60, price: 2.0, timestamp: FIXED_NOW - 60 },
    },
    now: FIXED_NOW,
    tx_params: { block_count: 100, system_fee: 1, network_fee: 1 },
  };
  const { status, body } = await dispatch('POST', '/feed/sign', AUTH, JSON.stringify(req));
  assert.equal(status, 200);
  assert.equal(body.status, 'ok');
  assert.deepEqual(body.pairs, ['TWELVEDATA:NEO-USD']);
  assert.deepEqual(body.missing, ['GAS-USD']);
  __resetPriceFetcherForTests();
});

test('feed/sign: validation — symbols required; neox needs pinned tx_params', async () => {
  const noSymbols = await dispatch(
    'POST',
    '/feed/sign',
    AUTH,
    JSON.stringify({ chain: 'neo_n3', symbols: [] })
  );
  assert.equal(noSymbols.status, 400);
  assert.match(noSymbols.body.error, /symbols/);

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

test('attestation: user_data binds sha256(fulfillment_digest) + nonce echo (stubbed seam)', async () => {
  const fulfillmentDigest = 'ab'.repeat(32); // 32-byte digest hex
  const nonce = 'feed1234';
  const expectedUserData = createHash('sha256')
    .update(Buffer.from(fulfillmentDigest, 'hex'))
    .digest('hex');

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

  // The binary actually received --user-data <sha256(digest)>, --nonce <nonce>,
  // and --public-key <oracle_verifier pubkey>.
  const argMap = {};
  for (let i = 0; i < capturedArgs.length; i += 2) argMap[capturedArgs[i]] = capturedArgs[i + 1];
  assert.equal(argMap['--user-data'], expectedUserData);
  assert.equal(argMap['--nonce'], nonce);
  assert.equal(
    argMap['--public-key'].toLowerCase(),
    ORACLE_VERIFIER_ACCOUNT.publicKey.toLowerCase(),
    '--public-key must bind the oracle_verifier signer'
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
// /oracle/fulfill ENFORCING attestation (C1): the response binds an NSM
// attestation document committing user_data = sha256(fulfillment_digest) and
// surfaces the measured PCRs the relayer verifies. Best-effort: a missing NSM
// binary does NOT break the (signed) fulfillment.
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

test('oracle/fulfill binds an attestation document committing sha256(fulfillment_digest) (C1)', async () => {
  const requestType = 'oracle_query';
  const requestId = '5150';
  const contractScriptHash = '0x' + '3a'.repeat(20);
  const networkMagic = 894710606;
  const appId = 'attest.app';
  const moduleId = resolveKernelIntent(requestType).moduleId;
  const operation = resolveKernelIntent(requestType).operation;
  const PCR0 = 'aa'.repeat(48);

  // Stub the attest runner so it returns a REAL COSE_Sign1 whose user_data is the
  // commitment the server passes (--user-data sha256(digest)) and a known PCR0.
  __setAsyncAttestRunnerForTests((args) => {
    const argMap = {};
    for (let i = 0; i < args.length; i += 2) argMap[args[i]] = args[i + 1];
    const doc = buildFakeAttestationDoc({ userDataHex: argMap['--user-data'], pcr0Hex: PCR0 });
    return { ok: true, attestation_b64: doc, document_len: doc.length };
  });

  const req = {
    chain: 'neo_n3',
    request_type: requestType,
    request_id: requestId,
    payload: { symbol: 'BTC/USD' },
    fulfillment_context: {
      app_id: appId,
      module_id: moduleId,
      operation,
      contract_script_hash: contractScriptHash,
      network_magic: networkMagic,
    },
    nonce: 'cafebabe',
  };
  const { status, body } = await dispatch('POST', '/oracle/fulfill', AUTH, JSON.stringify(req));
  assert.equal(status, 200, `dispatch failed: ${JSON.stringify(body)}`);
  assert.equal(body.trust_tier, 'enclave-attested');
  assert.ok(body.attestation_doc_base64, 'fulfill must carry the attestation document');

  // user_data committed in the response equals sha256(the returned digest bytes).
  const expectedUserData = createHash('sha256')
    .update(Buffer.from(body.fulfillment_digest_hex, 'hex'))
    .digest('hex');
  assert.equal(body.attestation_user_data_hex, expectedUserData);
  // The PCR0 the relayer pins is surfaced from the parsed document.
  assert.equal(body.attestation_pcrs.pcr0, PCR0);
  assert.equal(body.nonce, 'cafebabe');
  __resetAsyncAttestRunnerForTests();
});

test('oracle/fulfill still signs when attestation is unavailable (best-effort C1)', async () => {
  // A throwing/absent NSM binary must NOT break the signed fulfillment — the
  // relayer enforces and downgrades trust_tier when it cannot prove attestation.
  __setAsyncAttestRunnerForTests(() => {
    throw new Error('spawn ENOENT (no nsm binary outside an enclave)');
  });
  const requestType = 'oracle_query';
  const req = {
    chain: 'neo_n3',
    request_type: requestType,
    request_id: '5151',
    payload: { symbol: 'BTC/USD' },
    fulfillment_context: {
      app_id: 'a',
      module_id: resolveKernelIntent(requestType).moduleId,
      operation: resolveKernelIntent(requestType).operation,
    },
  };
  const { status, body } = await dispatch('POST', '/oracle/fulfill', AUTH, JSON.stringify(req));
  assert.equal(status, 200);
  assert.ok(body.signature, 'signature must still be produced');
  assert.equal(body.attestation_doc_base64, undefined, 'no doc when the binary is unavailable');
  assert.ok(body.attestation_error, 'the attestation failure is surfaced for ops');
  __resetAsyncAttestRunnerForTests();
});

// ---------------------------------------------------------------------------
// /health
// ---------------------------------------------------------------------------

test('GET /health reports compute + signer readiness', async () => {
  const { status, body } = await dispatch('GET', '/health', {}, '');
  assert.equal(status, 200);
  assert.equal(body.ready, true);
  assert.equal(body.checks.compute, true);
  assert.equal(body.checks.signer, true);

  // handleHealth direct call agrees.
  const direct = handleHealth();
  assert.equal(direct.ready, true);
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test('missing request_type / request_id returns 400', async () => {
  const noType = await dispatch(
    'POST',
    '/oracle/fulfill',
    AUTH,
    JSON.stringify({ chain: 'neo_n3', request_id: '1' })
  );
  assert.equal(noType.status, 400);
  assert.match(noType.body.error, /request_type/);

  const noId = await dispatch(
    'POST',
    '/oracle/fulfill',
    AUTH,
    JSON.stringify({ chain: 'neo_n3', request_type: 'oracle_query' })
  );
  assert.equal(noId.status, 400);
  assert.match(noId.body.error, /request_id/);
});

test('unknown route returns 404', async () => {
  const { status, body } = await dispatch('GET', '/nope', {}, '');
  assert.equal(status, 404);
  assert.equal(body.error, 'not found');
});

// ---------------------------------------------------------------------------
// Auth + provisioning + signer surface (the folded-in signer endpoints that make
// this enclave a strict superset of nitro-signer-server.mjs).
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

test('sign/payload signs data_hex with the pinned role key', async () => {
  const dataHex = createHash('sha256').update('enclave-sign-payload-test').digest('hex');
  const { status, body } = await dispatch(
    'POST',
    '/sign/payload',
    AUTH,
    JSON.stringify({ role: 'oracle_verifier', data_hex: dataHex })
  );
  assert.equal(status, 200);
  assert.equal(body.role, 'oracle_verifier');
  assert.equal(body.public_key, ORACLE_VERIFIER_ACCOUNT.publicKey);
  // The signature must verify against the returned public key over the data.
  assert.equal(neoWallet.verify(dataHex, body.signature, body.public_key), true);
});

test('keys/derived returns a pinned role identity (no secret)', async () => {
  const { status, body } = await dispatch(
    'POST',
    '/keys/derived',
    AUTH,
    JSON.stringify({ role: 'updater' })
  );
  assert.equal(status, 200);
  assert.equal(body.role, 'updater');
  assert.equal(body.neo_n3.public_key, UPDATER_ACCOUNT.publicKey);
});

test('enclave signer refuses to act under a defaulted or unmappable role', async () => {
  // regression: normalizeSignerRole used to fall back to 'updater', so an
  // absent or bogus key_role signed with the updater key
  const absent = await dispatch('POST', '/sign/payload', AUTH, JSON.stringify({}));
  assert.equal(absent.status, 400);
  assert.match(absent.body.error, /key_role is required and must name a signer role/);
  const bogus = await dispatch(
    'POST',
    '/sign/payload',
    AUTH,
    JSON.stringify({ key_role: 'superadmin', data_hex: '00' })
  );
  assert.equal(bogus.status, 400);
  assert.match(bogus.body.error, /key_role is required and must name a signer role/);
  const derived = await dispatch('POST', '/keys/derived', AUTH, JSON.stringify({}));
  assert.equal(derived.status, 400);
  assert.match(derived.body.error, /key_role is required and must name a signer role/);
});

test('provision applies env keys at runtime and reports role health', async () => {
  // Provision a benign extra key + re-affirm the network; the keys are already set
  // at module load, so roles should report ok. First-boot provisioning is not
  // exercised here because NITRO_API_TOKEN already seeds a trusted token.
  const { status, body } = await dispatch(
    'POST',
    '/provision',
    AUTH,
    JSON.stringify({ env: { MORPHEUS_NETWORK: 'testnet', TD_KEY: 'provisioned-td-key' } })
  );
  assert.equal(status, 200);
  assert.equal(body.provisioned, true);
  assert.equal(body.network, 'testnet');
  assert.ok(body.env_keys.includes('TD_KEY'));
  assert.equal(process.env.TD_KEY, 'provisioned-td-key');
  const verifier = body.roles.find((r) => r.role === 'oracle_verifier');
  assert.equal(verifier.ok, true);
});

test('provision permanently rejects plaintext keys and the former runtime opt-in flag', async () => {
  // A plaintext WIF is rejected with 403 and is not applied.
  const savedFlag = process.env.MORPHEUS_ALLOW_PLAINTEXT_KEY_PROVISION;
  delete process.env.MORPHEUS_ALLOW_PLAINTEXT_KEY_PROVISION;
  try {
    const rejected = await dispatch(
      'POST',
      '/provision',
      AUTH,
      JSON.stringify({ env: { MORPHEUS_ORACLE_VERIFIER_WIF_MAINNET: 'L1plaintextwifvalue' } })
    );
    assert.equal(rejected.status, 403);
    assert.match(
      rejected.body.error,
      /plaintext key or runtime-token provisioning is permanently disabled/
    );
    assert.match(rejected.body.error, /MORPHEUS_ORACLE_VERIFIER_WIF_MAINNET/);
    assert.equal(process.env.MORPHEUS_ORACLE_VERIFIER_WIF_MAINNET, undefined);

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

    // The KMS-ciphertext variant is always accepted (the attested path). Stub the
    // attest runner so handleProvision's in-TEE materialize is deterministic (no
    // real nsm-attest binary) and the WIF lands via the attested recovery path.
    const savedCt = process.env.MORPHEUS_ORACLE_VERIFIER_KMS_CIPHERTEXT_BASE64;
    const savedWif = process.env.MORPHEUS_ORACLE_VERIFIER_WIF_MAINNET;
    delete process.env.MORPHEUS_ORACLE_VERIFIER_KMS_CIPHERTEXT_BASE64;
    delete process.env.MORPHEUS_ORACLE_VERIFIER_WIF_MAINNET;
    __setAttestRunnerForTests(() => ({
      ok: true,
      plaintext_b64: Buffer.from('L1someRecoveredWifValue', 'utf8').toString('base64'),
    }));
    const accepted = await dispatch(
      'POST',
      '/provision',
      AUTH,
      JSON.stringify({
        env: { MORPHEUS_ORACLE_VERIFIER_KMS_CIPHERTEXT_BASE64: 'Y2lwaGVydGV4dA==' },
      })
    );
    assert.equal(accepted.status, 200);
    assert.ok(accepted.body.env_keys.includes('MORPHEUS_ORACLE_VERIFIER_KMS_CIPHERTEXT_BASE64'));
    __resetAttestRunnerForTests();
    delete process.env.MORPHEUS_ORACLE_VERIFIER_WIF_MAINNET;
    if (savedWif !== undefined) process.env.MORPHEUS_ORACLE_VERIFIER_WIF_MAINNET = savedWif;
    if (savedCt === undefined) delete process.env.MORPHEUS_ORACLE_VERIFIER_KMS_CIPHERTEXT_BASE64;
    else process.env.MORPHEUS_ORACLE_VERIFIER_KMS_CIPHERTEXT_BASE64 = savedCt;

    // Even a process-level flag change cannot reopen the production code path.
    process.env.MORPHEUS_ALLOW_PLAINTEXT_KEY_PROVISION = '1';
    const stillRejected = await dispatch(
      'POST',
      '/provision',
      AUTH,
      JSON.stringify({ env: { NEOX_FEED_PK: '0xfeedfeedfeed' } })
    );
    assert.equal(stillRejected.status, 403);
    assert.match(stillRejected.body.error, /NEOX_FEED_PK/);
    assert.equal(process.env.NEOX_FEED_PK, undefined);
  } finally {
    delete process.env.MORPHEUS_ORACLE_VERIFIER_WIF_MAINNET;
    if (savedFlag === undefined) delete process.env.MORPHEUS_ALLOW_PLAINTEXT_KEY_PROVISION;
    else process.env.MORPHEUS_ALLOW_PLAINTEXT_KEY_PROVISION = savedFlag;
  }
});

test('health surfaces key_source per role (host_plaintext when no KMS ciphertext)', async () => {
  const { body } = await dispatch('GET', '/health', {}, '');
  // The test keys were provisioned directly as plaintext env vars (no KMS
  // ciphertext), so both roles report host_plaintext — detectable by ops.
  assert.equal(body.key_source.oracle_verifier, 'host_plaintext');
  assert.equal(body.key_source.updater, 'host_plaintext');
  assert.equal(body.plaintext_key_provision_allowed, false);
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
  }
});

test('start-nitro-signer requires a KMS-sealed runtime token bootstrap', () => {
  const source = readFileSync(new URL('./start-nitro-signer.sh', import.meta.url), 'utf8');
  assert.match(source, /signer\.MORPHEUS_RUNTIME_TOKEN/);
  assert.match(source, /signer\.NITRO_SIGNER_TOKEN/);
  assert.match(source, /MORPHEUS_RUNTIME_TOKEN_KMS_CIPHERTEXT_BASE64/);
  assert.match(source, /SIGNER_SERVICE_TOKEN_KMS_CIPHERTEXT_BASE64/);
  assert.match(source, /MORPHEUS_ORACLE_KMS_CIPHERTEXT_BASE64/);
  assert.match(source, /MORPHEUS_NEODID_SALT_KMS_CIPHERTEXT_BASE64/);
  assert.match(source, /if \(!token\)/);
  assert.match(source, /authorization:\s*`Bearer \$\{token\}`/);
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
