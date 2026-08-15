import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { processChainByRequestCursor, reconcilePendingRequests } from './request-processor.js';
import { createEmptyRelayerState } from './state.js';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

function tempStateFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'morpheus-relayer-rp-'));
  return path.join(dir, '.morpheus-relayer-state.json');
}

function cursorConfig(overrides = {}) {
  return {
    network: 'testnet',
    stateFile: tempStateFile(),
    concurrency: 2,
    maxBlocksPerTick: 250,
    maxRetries: 3,
    retryBaseDelayMs: 10,
    retryMaxDelayMs: 100,
    processedCacheSize: 100,
    deadLetterLimit: 10,
    startRequestIds: {},
    durableQueue: { enabled: false },
    backpressure: { maxFreshEventsPerTick: 32, maxRetryEventsPerTick: 16, deferDelayMs: 250 },
    ...overrides,
  };
}

test('processChainByRequestCursor does not advance the cursor when the scan throws', async () => {
  const state = createEmptyRelayerState();
  state.neox.last_request_id = 4;

  // Discovery is decoupled from retry draining (A2): a scan/discovery throw is
  // logged and swallowed so due retries still run this tick, but the cursor must
  // NOT advance — the failed range (5..10) must be rescanned next tick, else
  // paid requests are orphaned behind the cursor forever.
  const result = await processChainByRequestCursor(cursorConfig(), state, silentLogger, 'neox', {
    hasConfig: () => true,
    getLatestRequestId: async () => 10,
    scan: async () => {
      throw new Error('ECONNRESET');
    },
  });

  assert.equal(state.neox.last_request_id, 4);
  assert.equal(result.scanned_requests, null);
  assert.deepEqual(result.events, []);
  assert.equal(state.metrics.discovery_failures_total, 1);
});

test('processChainByRequestCursor still drains due retries when discovery throws', async () => {
  const state = createEmptyRelayerState();
  state.neox.last_request_id = 4;

  // A prepared, already-due callback redelivery that needs no fresh chain-tip
  // read. A transient getLatestRequestId failure must not starve it.
  const preparedFulfillment = {
    success: true,
    result: '{"ok":true}',
    error: '',
    result_bytes_base64: '',
    route: '/oracle/fetch',
    module_id: 'oracle.fetch',
    operation: 'privacy_oracle',
    worker_status: 200,
    verification_signature: 'sig',
  };
  state.neox.retry_queue.push({
    key: 'neox:7:::',
    event: { chain: 'neox', requestId: '7', requestType: 'privacy_oracle', txHash: '' },
    attempts: 0,
    next_retry_at: Date.now() - 1000,
    prepared_fulfillment: preparedFulfillment,
    durable_claimed: true,
  });

  const fulfillCalls = [];
  const config = cursorConfig({
    hooks: {
      fulfillNeoRequest: async (call) => {
        fulfillCalls.push(call.requestId);
        return {
          request_id: `neox:fulfill:${call.requestId}`,
          tx_hash: '0xfulfilled',
          vm_state: 'HALT',
          target_chain: 'neox',
        };
      },
    },
  });

  const result = await processChainByRequestCursor(config, state, silentLogger, 'neox', {
    hasConfig: () => true,
    getLatestRequestId: async () => {
      throw new Error('RPC tip read failed');
    },
    scan: async () => [],
  });

  // Discovery failed (cursor unchanged) but the due retry was still delivered.
  assert.equal(state.neox.last_request_id, 4);
  assert.equal(result.scanned_requests, null);
  assert.equal(state.metrics.discovery_failures_total, 1);
  assert.deepEqual(fulfillCalls, ['7']);
  assert.equal(result.retries.length, 1);
});

test('reconcilePendingRequests skips requests already in retry_queue or processed (cross-tick dedupe) but still picks up genuinely-missed requests (B2)', async () => {
  const state = createEmptyRelayerState();
  state.neox.last_request_id = 0;

  // K1: already queued for retry under a BLOCK-CURSOR event key (carries a
  // txHash) — the request-cursor scan rebuilds the same request with a different
  // key, so key-based filtering alone would NOT dedupe it.
  state.neox.retry_queue.push({
    key: 'neox:1:0xblockhash:0:5',
    event: { chain: 'neox', requestId: '1', requestType: 'random', txHash: '0xblockhash' },
    attempts: 0,
    next_retry_at: Date.now() + 60_000,
  });
  // K2: already processed under a block-cursor key.
  state.neox.processed_records['neox:2:0xblockhash2:0:5'] = {
    key: 'neox:2:0xblockhash2:0:5',
    status: 'fulfilled',
    request_id: '2',
  };

  const fulfillCalls = [];
  // `random` -> local VRF (no worker call); neox signs the fulfillment locally,
  // so the only on-chain touch is the fulfillNeoRequest hook.
  const TEST_PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
  const config = cursorConfig({
    neox: {
      chainId: 47763,
      oracleContract: '0xeCFC1C652B5cCdBfe3E9314a83156787D92a3fD2',
      updaterPrivateKey: TEST_PK,
      verifierPrivateKey: TEST_PK,
    },
    hooks: {
      fulfillNeoRequest: async (call) => {
        fulfillCalls.push(call.requestId);
        return { tx_hash: '0xok', vm_state: 'HALT', target_chain: 'neox' };
      },
    },
  });

  // The request-cursor scan returns requests 1, 2 (already tracked) AND 3 (a
  // genuinely-missed request the block-cursor lane never observed).
  const result = await reconcilePendingRequests(
    config,
    state,
    silentLogger,
    'neox',
    {
      getLatestRequestId: async () => 3,
      scanByRequestId: async () => [
        { chain: 'neox', requestId: '1', requestType: 'random', txHash: '' },
        { chain: 'neox', requestId: '2', requestType: 'random', txHash: '' },
        { chain: 'neox', requestId: '3', requestType: 'random', txHash: '' },
      ],
    },
    new Set()
  );

  // Only the genuinely-missed request (3) was reconciled; 1 (in retry) and 2
  // (processed) were excluded by membership and NOT double-processed.
  assert.deepEqual(fulfillCalls, ['3']);
  assert.equal(result.events.length, 1);
  // The cursor advanced across the full scanned range so 1/2/3 are not rescanned.
  assert.equal(state.neox.last_request_id, 3);
});

test('quiet-chain early return still caps due retries and counts skipped items', async () => {
  const state = createEmptyRelayerState();
  state.neox.last_request_id = 10;

  const preparedFulfillment = {
    success: true,
    result: '{"ok":true}',
    error: '',
    result_bytes_base64: '',
    route: '/oracle/fetch',
    module_id: 'oracle.fetch',
    operation: 'privacy_oracle',
    worker_status: 200,
    verification_signature: 'sig',
  };
  for (const requestId of ['7', '8', '9']) {
    state.neox.retry_queue.push({
      key: `neox:${requestId}:::`,
      event: { chain: 'neox', requestId, requestType: 'privacy_oracle', txHash: '' },
      attempts: 0,
      next_retry_at: Date.now() - 1000,
      prepared_fulfillment: preparedFulfillment,
      durable_claimed: true,
    });
  }

  const fulfillCalls = [];
  const config = cursorConfig({
    backpressure: { maxFreshEventsPerTick: 32, maxRetryEventsPerTick: 1, deferDelayMs: 250 },
    hooks: {
      fulfillNeoRequest: async (call) => {
        fulfillCalls.push(call.requestId);
        return {
          request_id: `neox:fulfill:${call.requestId}`,
          tx_hash: '0xfulfilled',
          vm_state: 'HALT',
          target_chain: 'neox',
        };
      },
    },
  });

  // fromRequestId (11) > latestRequestId (10) -> the quiet-chain early return,
  // which previously processed ALL due retries with no backpressure cap.
  const result = await processChainByRequestCursor(config, state, silentLogger, 'neox', {
    hasConfig: () => true,
    getLatestRequestId: async () => 10,
    scan: async () => [],
  });

  assert.equal(result.scanned_requests, null);
  assert.equal(result.retries.length, 1);
  assert.deepEqual(fulfillCalls, ['7']);
  assert.equal(state.metrics.backpressure_retry_skipped_total, 2);
  assert.equal(state.neox.retry_queue.length, 2);
});
