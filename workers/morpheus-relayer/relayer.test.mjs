import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { wallet } from '@cityofzion/neon-js';
import { signManualAction } from '@r3e-network/neo-os-services-shared/node-runtime';

import {
  buildOnchainResultEnvelope,
  buildFulfillmentDigestBytes,
  buildWorkerPayload,
  decodePayloadText,
  encodeFulfillmentResult,
  isOperatorOnlyRequestType,
  normalizeRequestType,
  resolveKernelIntent,
  resolveWorkerRoute,
} from './src/router.js';
import { callNitro } from './src/nitro.js';
import {
  guardQueuedAutomationExecution,
  isAutomationControlRequestType,
  processAutomationJobs,
} from './src/automation.js';
import {
  buildFeedSyncPayload,
  getRequestCursorFloor,
  getFeedSyncDelayMs,
  summarizeFeedSyncChainResult,
  hydrateDurableQueue,
  persistFreshEventsToDurableQueue,
  pruneRetryQueueBelowRequestFloor,
  quarantineDurableBacklogBelowRequestFloor,
  resolveChainFromBlock,
  shouldPersistRunSnapshot,
  shouldRunFeedSync,
  shouldRunRequestProcessing,
} from './src/relayer.js';
import { resolveRequestCursor } from './src/request-processor.js';
import { processEvent } from './src/fulfillment/index.js';
import {
  buildEventKey,
  createEmptyRelayerState,
  getDueRetryItems,
  hasProcessedEvent,
  isEventQueuedForRetry,
  saveRelayerState,
  recordProcessedEvent,
  scheduleRetry,
  snapshotMetrics,
} from './src/state.js';
import {
  assertNeoN3HaltExecution,
  buildNeoN3EventFromRequestRecord,
  buildNeoN3RelayRequestId,
  decodeNeoItem,
  encodeUtf8ByteArrayParamValue,
  fulfillNeoN3Request,
  getNeoN3LatestBlock,
  hasNeoN3RelayerConfig,
  queueNeoN3AutomationRequest,
} from './src/neo-n3.js';
import {
  AUTOMATION_PROCESSING_CLAIM_MARKER,
  claimAutomationJob,
  claimRelayerJob,
  resetSupabasePersistenceBackoffForTests,
  sanitizeForPostgres,
} from './src/persistence.js';
import { createRelayerConfig, resolveReviewedNeoXChainId } from './src/config.js';

const retryConfig = {
  maxRetries: 3,
  retryBaseDelayMs: 1000,
  retryMaxDelayMs: 10000,
  processedCacheSize: 100,
  deadLetterLimit: 10,
};

const DURABLE_HYDRATION_TEST_SECRET = 'durable-hydration-test-secret';

function signDurableHydrationRows(rows, network = 'testnet') {
  return rows.map((row) => {
    const event = {
      payloadText: '{}',
      payloadHex: '7b7d',
      requester: 'NTestRequesterAddress',
      callbackContract: '0x1111111111111111111111111111111111111111',
      callbackMethod: 'onOracleResult',
      ...row.event,
    };
    const eventKey = row.event_key || buildEventKey(event);
    return {
      ...row,
      network,
      event_key: eventKey,
      event,
      worker_response: {
        ...(row.worker_response && typeof row.worker_response === 'object'
          ? row.worker_response
          : {}),
        manual_action_sig: signManualAction(
          DURABLE_HYDRATION_TEST_SECRET,
          'relayer_upsert',
          network,
          eventKey,
          event
        ),
      },
    };
  });
}

const ISOLATED_RELAYER_SIGNER_ENV_KEYS = [
  'MORPHEUS_ALLOW_UNPINNED_SIGNERS',
  'MORPHEUS_RELAYER_NEO_N3_WIF',
  'MORPHEUS_RELAYER_NEO_N3_PRIVATE_KEY',
  'MORPHEUS_UPDATER_NEO_N3_WIF',
  'MORPHEUS_UPDATER_NEO_N3_PRIVATE_KEY',
  'NEO_N3_WIF',
  'NEO_TESTNET_WIF',
];

function withIsolatedRelayerSigner(run) {
  const previous = new Map();
  for (const key of ISOLATED_RELAYER_SIGNER_ENV_KEYS) {
    previous.set(key, process.env[key]);
    delete process.env[key];
  }

  try {
    return run();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('normalizeRequestType normalizes separators and casing', () => {
  assert.equal(normalizeRequestType('Privacy-Oracle'), 'privacy_oracle');
  assert.equal(normalizeRequestType('  ZKP Compute '), 'zkp_compute');
});

test('Neo X chain ids resolve from the reviewed registry projection', () => {
  const registry = { network: 'testnet', neo_x: { chain_id: 12227332 } };
  assert.equal(resolveReviewedNeoXChainId('testnet', registry), 12227332);
  assert.equal(resolveReviewedNeoXChainId('testnet', registry, '12227332'), 12227332);
  assert.throws(
    () => resolveReviewedNeoXChainId('testnet', registry, '31338'),
    /conflicts with reviewed testnet identity/
  );
  assert.throws(
    () =>
      resolveReviewedNeoXChainId('testnet', { network: 'testnet', neox: { chain_id: 12227332 } }),
    /missing reviewed Neo X chain id/
  );
});

test('Neo X chain ids reject registry drift across reviewed networks', () => {
  assert.throws(
    () =>
      resolveReviewedNeoXChainId('mainnet', { network: 'mainnet', neo_x: { chain_id: 12227332 } }),
    /reviewed Neo X chain id/
  );
  assert.throws(
    () =>
      resolveReviewedNeoXChainId('sidechain', { network: 'sidechain', neo_x: { chain_id: 47763 } }),
    /unsupported Neo network/
  );
});

test('resolveWorkerRoute routes compute, feed, vrf, and oracle payloads', () => {
  assert.equal(resolveWorkerRoute('compute', {}), '/compute/execute');
  assert.equal(resolveWorkerRoute('datafeed', {}), '/oracle/feed');
  assert.equal(resolveWorkerRoute('rng', {}), '/vrf/random');
  assert.equal(resolveWorkerRoute('vrf', {}), '/vrf/random');
  assert.equal(resolveWorkerRoute('neodid_bind', {}), '/neodid/bind');
  assert.equal(resolveWorkerRoute('neodid_action_ticket', {}), '/neodid/action-ticket');
  assert.equal(resolveWorkerRoute('neodid_recovery_ticket', {}), '/neodid/recovery-ticket');
  assert.equal(resolveWorkerRoute('neodid_zklogin_ticket', {}), '/neodid/zklogin-ticket');
  assert.equal(
    resolveWorkerRoute('privacy_oracle', { script: 'function process(){}' }),
    '/oracle/smart-fetch'
  );
  assert.equal(resolveWorkerRoute('privacy_oracle', {}), '/oracle/smart-fetch');
});

test('resolveKernelIntent maps legacy request types to kernel module and operation', () => {
  assert.deepEqual(resolveKernelIntent('privacy_oracle'), {
    legacyRequestType: 'privacy_oracle',
    moduleId: 'oracle.fetch',
    operation: 'privacy_oracle',
    workerRoute: '/oracle/smart-fetch',
    operatorOnly: false,
  });
  assert.deepEqual(resolveKernelIntent('compute'), {
    legacyRequestType: 'compute',
    moduleId: 'compute.run',
    operation: 'compute',
    workerRoute: '/compute/execute',
    operatorOnly: false,
  });
  assert.deepEqual(resolveKernelIntent('datafeed'), {
    legacyRequestType: 'datafeed',
    moduleId: 'feed.publish',
    operation: 'datafeed',
    workerRoute: '/oracle/feed',
    operatorOnly: true,
  });
  // Neo Message confidential reveal: 'decrypt' (and reveal-ish aliases) route to
  // the enclave decrypt lane, never operator-only (permissionless reveal).
  assert.deepEqual(resolveKernelIntent('decrypt'), {
    legacyRequestType: 'decrypt',
    moduleId: 'confidential.decrypt',
    operation: 'decrypt',
    workerRoute: '/oracle/decrypt',
    operatorOnly: false,
  });
  assert.equal(resolveKernelIntent('message-reveal').moduleId, 'confidential.decrypt');
});

test('isOperatorOnlyRequestType flags feed sync requests', () => {
  assert.equal(isOperatorOnlyRequestType('datafeed'), true);
  assert.equal(isOperatorOnlyRequestType('price-feed'), true);
  assert.equal(isOperatorOnlyRequestType('privacy_oracle'), false);
});

test('buildWorkerPayload carries kernel intent alongside legacy request fields', () => {
  const payload = buildWorkerPayload('neo_n3', 'neodid_recovery_ticket', { foo: 'bar' }, '77');
  assert.equal(payload.request_id, '77');
  assert.equal(payload.legacy_request_type, 'neodid_recovery_ticket');
  assert.equal(payload.kernel_module_id, 'identity.verify');
  assert.equal(payload.kernel_operation, 'neodid_recovery_ticket');
});

test('isAutomationControlRequestType detects automation registration flows', () => {
  assert.equal(isAutomationControlRequestType('automation_register'), true);
  assert.equal(isAutomationControlRequestType('automation-cancel'), true);
  assert.equal(isAutomationControlRequestType('privacy_oracle'), false);
});

test('callNitro rejects when the worker fetch never resolves', async () => {
  const originalFetch = global.fetch;
  try {
    global.fetch = () => new Promise(() => {});

    await assert.rejects(
      callNitro(
        {
          nitro: {
            apiUrl: 'https://worker.test',
            token: 'secret',
            timeoutMs: 25,
          },
        },
        '/oracle/query',
        { ping: true }
      ),
      /nitro request timed out after 1000ms/
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('callNitro rejects when the worker response body never resolves', async () => {
  const originalFetch = global.fetch;
  try {
    global.fetch = async () => ({
      ok: true,
      status: 200,
      text: () => new Promise(() => {}),
    });

    await assert.rejects(
      callNitro(
        {
          nitro: {
            apiUrl: 'https://worker.test',
            token: 'secret',
            timeoutMs: 25,
          },
        },
        '/oracle/query',
        { ping: true }
      ),
      /nitro request timed out after 1000ms/
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('callNitro allows a longer timeout when explicitly requested for feed sync', async () => {
  const originalFetch = global.fetch;
  try {
    global.fetch = async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true }),
    });

    const response = await callNitro(
      {
        nitro: {
          apiUrl: 'https://worker.test',
          token: 'secret',
          timeoutMs: 90000,
        },
      },
      '/oracle/feed',
      { ping: true },
      { timeoutMs: 90000, maxTimeoutMs: 30000 }
    );

    assert.equal(response.ok, true);
  } finally {
    global.fetch = originalFetch;
  }
});

test('callNitro falls back to the next configured worker endpoint', async () => {
  const originalFetch = global.fetch;
  try {
    const calls = [];
    global.fetch = async (url) => {
      calls.push(String(url));
      if (String(url).startsWith('https://worker-a.test')) {
        throw new Error('fetch failed');
      }
      return new Response(JSON.stringify({ ok: true, route: 'fallback' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const response = await callNitro(
      {
        nitro: {
          apiUrl: 'https://worker-a.test, https://worker-b.test',
          token: 'secret',
          timeoutMs: 1000,
        },
      },
      '/oracle/query',
      { ping: true }
    );

    assert.equal(response.ok, true);
    assert.equal(response.status, 200);
    assert.equal(response.body.route, 'fallback');
    assert.equal(response.api_url, 'https://worker-b.test');
    assert.deepEqual(calls, [
      'https://worker-a.test/oracle/query',
      'https://worker-b.test/oracle/query',
    ]);
  } finally {
    global.fetch = originalFetch;
  }
});

test('callNitro never traverses fallback endpoints in production', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  try {
    global.fetch = async (url) => {
      calls.push(String(url));
      throw new Error('primary failed');
    };

    await assert.rejects(
      callNitro(
        {
          nodeEnv: 'production',
          nitro: {
            apiUrl:
              'https://confidential.worker,https://oracle.meshmini.app/mainnet,https://edge.meshmini.app/mainnet',
            token: 'secret',
            timeoutMs: 1000,
            allowFallback: true,
          },
        },
        '/oracle/query',
        { confidential: true },
        { allowFallback: true }
      ),
      /primary failed/
    );

    assert.deepEqual(calls, ['https://confidential.worker/oracle/query']);
  } finally {
    global.fetch = originalFetch;
  }
});

test('callNitro can disable fallback for mutating worker calls', async () => {
  const originalFetch = global.fetch;
  const requestedUrls = [];
  try {
    global.fetch = async (url) => {
      requestedUrls.push(String(url));
      throw new Error('primary failed');
    };

    await assert.rejects(
      callNitro(
        {
          nitro: {
            apiUrl: 'https://primary.worker,https://fallback.worker',
            token: 'secret',
            timeoutMs: 1000,
          },
        },
        '/oracle/feed',
        { ping: true },
        { timeoutMs: 1000, allowFallback: false }
      ),
      /primary failed/
    );

    assert.deepEqual(requestedUrls, ['https://primary.worker/oracle/feed']);
  } finally {
    global.fetch = originalFetch;
  }
});

test('getNeoN3LatestBlock falls back to a healthy Neo RPC endpoint and promotes it', async () => {
  const originalFetch = global.fetch;
  try {
    const calls = [];
    global.fetch = async (url) => {
      calls.push(String(url));
      if (String(url) === 'https://bad-rpc.test') {
        return new Response('<!DOCTYPE html><html><body>502</body></html>', {
          status: 502,
          headers: { 'content-type': 'text/html' },
        });
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 123 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const config = {
      neo_n3: {
        rpcUrl: 'https://bad-rpc.test',
        rpcUrls: ['https://bad-rpc.test', 'http://seed1.neo.org:10332'],
        oracleContract: '0x1234',
      },
    };

    const latestBlock = await getNeoN3LatestBlock(config);
    assert.equal(latestBlock, 122);
    assert.equal(config.neo_n3.rpcUrl, 'http://seed1.neo.org:10332');
    assert.deepEqual(calls, ['https://bad-rpc.test', 'http://seed1.neo.org:10332']);
  } finally {
    global.fetch = originalFetch;
  }
});

test('callNitro injects the relayer network when the payload omits it', async () => {
  const originalFetch = global.fetch;
  try {
    let postedBody = null;
    global.fetch = async (_url, init) => {
      postedBody = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const response = await callNitro(
      {
        network: 'mainnet',
        nitro: {
          apiUrl: 'https://worker.test',
          token: 'secret',
          timeoutMs: 1000,
        },
      },
      '/oracle/fetch',
      { target_chain: 'neo_n3', message: 'hello' }
    );

    assert.equal(response.ok, true);
    assert.equal(postedBody.network, 'mainnet');
  } finally {
    global.fetch = originalFetch;
  }
});

test('callNitro forwards the relayer derived-key preference to the worker', async () => {
  const originalFetch = global.fetch;
  try {
    let postedBody = null;
    global.fetch = async (_url, init) => {
      postedBody = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const response = await callNitro(
      {
        network: 'testnet',
        useDerivedKeys: true,
        nitro: {
          apiUrl: 'https://worker.test',
          token: 'secret',
          timeoutMs: 1000,
          useDerivedKeys: true,
        },
      },
      '/oracle/fetch',
      { target_chain: 'neo_n3', message: 'hello' }
    );

    assert.equal(response.ok, true);
    assert.equal(postedBody.use_derived_keys, true);
  } finally {
    global.fetch = originalFetch;
  }
});

test('guardQueuedAutomationExecution blocks cancelled queued automation requests', async () => {
  const patchedRuns = [];
  const result = await guardQueuedAutomationExecution(
    { txHash: '0xqueue' },
    {
      fetchAutomationRunByQueueTxHash: async (txHash) => ({
        automation_id: 'automation:neo_n3:test-cancelled',
        queue_tx: { tx_hash: txHash },
      }),
      fetchAutomationJobById: async () => ({
        automation_id: 'automation:neo_n3:test-cancelled',
        status: 'cancelled',
        chain: 'neo_n3',
      }),
      patchAutomationRunByQueueTxHash: async (txHash, fields) => {
        patchedRuns.push({ txHash, fields });
      },
    }
  );

  assert.equal(result.blocked, true);
  assert.equal(result.route, 'automation:cancelled-before-execution');
  assert.match(result.error, /automation cancelled before execution/i);
  assert.deepEqual(patchedRuns, [
    {
      txHash: '0xqueue',
      fields: {
        status: 'failed',
        error: 'automation cancelled before execution: automation:neo_n3:test-cancelled',
      },
    },
  ]);
});

test('guardQueuedAutomationExecution allows non-cancelled queued automation requests', async () => {
  const result = await guardQueuedAutomationExecution(
    { txHash: '0xqueue' },
    {
      fetchAutomationRunByQueueTxHash: async () => ({
        automation_id: 'automation:neo_n3:test-ok',
      }),
      fetchAutomationJobById: async () => ({
        automation_id: 'automation:neo_n3:test-ok',
        status: 'completed',
        chain: 'neo_n3',
      }),
      patchAutomationRunByQueueTxHash: async () => {
        throw new Error('should not patch run when not blocked');
      },
    }
  );

  assert.equal(result.blocked, false);
  assert.equal(result.automation_id, 'automation:neo_n3:test-ok');
  assert.equal(result.job.status, 'completed');
});

test('processAutomationJobs fail-closes automation jobs on request fee exhaustion', async () => {
  const patchedJobs = [];
  const insertedRuns = [];
  const result = await processAutomationJobs(
    {
      automation: {
        enabled: true,
        batchSize: 10,
        maxQueuedPerTick: 10,
        defaultPriceCooldownMs: 60000,
      },
    },
    { info() {}, warn() {} },
    {
      fetchActiveAutomationJobs: async () => [
        {
          automation_id: 'automation:neo_n3:exhausted',
          status: 'active',
          chain: 'neo_n3',
          requester: '0x0c3146e78efc42bfb7d4cc2e06e3efd063c01c56',
          callback_contract: '0x8c506f224d82e67200f20d9d5361f767f0756e3b',
          callback_method: 'onOracleResult',
          execution_request_type: 'privacy_oracle',
          execution_payload: { provider: 'twelvedata' },
          trigger_type: 'one_shot',
          trigger_config: { execute_at: new Date(0).toISOString() },
          next_run_at: new Date(0).toISOString(),
          execution_count: 0,
          max_executions: 1,
        },
      ],
      queueNeoN3AutomationRequest: async () => {
        throw new Error(
          'at instruction 2827 (ABORTMSG): ABORTMSG is executed. Reason: request fee not paid'
        );
      },
      claimAutomationJob: async () => ({
        automation_id: 'automation:neo_n3:exhausted',
        status: 'processing',
      }),
      patchAutomationJob: async (automationId, fields) => {
        patchedJobs.push({ automationId, fields });
      },
      insertAutomationRun: async (record) => {
        insertedRuns.push(record);
      },
    }
  );

  assert.deepEqual(result, { queued: 0, skipped: 0, failed: 1, inspected: 1 });
  assert.deepEqual(patchedJobs, [
    {
      automationId: 'automation:neo_n3:exhausted',
      fields: {
        status: 'error',
        next_run_at: null,
        last_error:
          'at instruction 2827 (ABORTMSG): ABORTMSG is executed. Reason: request fee not paid',
      },
    },
  ]);
  assert.equal(insertedRuns.length, 1);
  assert.equal(insertedRuns[0].status, 'failed');
  assert.match(insertedRuns[0].error, /request fee not paid/i);
});

test('Neo N3 automation queue waits for the app log and fail-closes VM faults', async () => {
  // The queued invoke is only durable once it lands: a FAULTed
  // queueAutomationRequest execution must surface as a hard error (not an
  // UNKNOWN vm_state), so the scheduler retries instead of trusting the tick.
  const originalFetch = global.fetch;
  const signer = new wallet.Account('2'.repeat(64));
  try {
    global.fetch = async (url, init = {}) => {
      const href = String(url);
      if (href.startsWith('https://custody.test/signer/api/v1/keys/key-updater')) {
        return new Response(
          JSON.stringify({
            key_id: 'key-updater',
            label: 'updater',
            network: 'mainnet',
            network_magic: 860833102,
            public_key: signer.publicKey,
            script_hash: `0x${signer.scriptHash}`,
            address: signer.address,
            verification_script: `0c21${signer.publicKey}4156e7b327`,
            signing_enabled: true,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (href === 'https://custody.test/signer/api/v1/sign/transaction') {
        const body = JSON.parse(String(init.body || '{}'));
        assert.equal(body.key_id, 'key-updater');
        // Real wire shape (§5): /sign/transaction carries no bare public_key —
        // the adapter must recover it from the verification script.
        return new Response(
          JSON.stringify({
            allowed: true,
            key_id: 'key-updater',
            script_hash: `0x${signer.scriptHash}`,
            address: signer.address,
            digest: 'd'.repeat(64),
            invocation_script: `0c40${'1'.repeat(128)}`,
            verification_script: `0c21${signer.publicKey}4156e7b327`,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }

      const rpcBody = JSON.parse(String(init.body || '{}'));
      if (rpcBody.method === 'getblockcount') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 1000 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (rpcBody.method === 'invokescript') {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: { state: 'HALT', gasconsumed: '1000000' },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (rpcBody.method === 'calculatenetworkfee') {
        return new Response(
          JSON.stringify({ jsonrpc: '2.0', id: 1, result: { networkfee: '100000' } }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (rpcBody.method === 'sendrawtransaction') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (rpcBody.method === 'getapplicationlog') {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: {
              executions: [{ vmstate: 'FAULT', exception: 'request fee not paid' }],
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      throw new Error(`unexpected fetch ${href}`);
    };
    await assert.rejects(
      queueNeoN3AutomationRequest(
        {
          network: 'mainnet',
          nitro: {
            apiUrl: 'https://runtime.test',
            token: '',
            timeoutMs: 1000,
            custodyUrl: 'https://custody.test',
            custodyToken: 'custody-token',
          },
          neo_n3: {
            rpcUrl: 'https://neo.test',
            rpcUrls: ['https://neo.test'],
            networkMagic: 860833102,
            oracleContract: '0xf54d8584ef82315c1800373272ab08ae0db2d5ef',
            custodyKeyIds: { updater: 'key-updater' },
          },
        },
        '0x0c3146e78efc42bfb7d4cc2e06e3efd063c01c56',
        'privacy_oracle',
        '{}',
        '0x8c506f224d82e67200f20d9d5361f767f0756e3b',
        'onOracleResult'
      ),
      /automation queue faulted for request .*: request fee not paid/
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('processAutomationJobs preserves retry semantics for transient automation queue errors', async () => {
  const patchedJobs = [];
  const insertedRuns = [];
  const result = await processAutomationJobs(
    {
      automation: {
        enabled: true,
        batchSize: 10,
        maxQueuedPerTick: 10,
        defaultPriceCooldownMs: 60000,
      },
    },
    { info() {}, warn() {} },
    {
      fetchActiveAutomationJobs: async () => [
        {
          automation_id: 'automation:neo_n3:transient',
          status: 'active',
          chain: 'neo_n3',
          requester: '0x0c3146e78efc42bfb7d4cc2e06e3efd063c01c56',
          callback_contract: '0x8c506f224d82e67200f20d9d5361f767f0756e3b',
          callback_method: 'onOracleResult',
          execution_request_type: 'privacy_oracle',
          execution_payload: { provider: 'twelvedata' },
          trigger_type: 'one_shot',
          trigger_config: { execute_at: new Date(0).toISOString() },
          next_run_at: new Date(0).toISOString(),
          execution_count: 0,
          max_executions: 1,
        },
      ],
      queueNeoN3AutomationRequest: async () => {
        throw new Error('rpc timeout');
      },
      claimAutomationJob: async () => ({
        automation_id: 'automation:neo_n3:transient',
        status: 'processing',
      }),
      patchAutomationJob: async (automationId, fields) => {
        patchedJobs.push({ automationId, fields });
      },
      insertAutomationRun: async (record) => {
        insertedRuns.push(record);
      },
    }
  );

  assert.deepEqual(result, { queued: 0, skipped: 0, failed: 1, inspected: 1 });
  // The durable claim already advanced + pinned this execution before the broadcast,
  // so a non-terminal broadcast failure keeps the row in the stale-reclaim lane
  // (status=processing) rather than flipping it back to active. A later tick reclaims
  // it past claimStaleMs and retries the SAME pinned request_id (the kernel dedups if
  // the tx landed), so a false-negative timeout cannot mint a second execution.
  assert.deepEqual(patchedJobs, [
    {
      automationId: 'automation:neo_n3:transient',
      fields: {
        status: 'processing',
        last_error: 'rpc timeout',
      },
    },
  ]);
  assert.equal(insertedRuns.length, 1);
  assert.equal(insertedRuns[0].status, 'failed');
  assert.equal(insertedRuns[0].error, 'rpc timeout');
});

test('processAutomationJobs skips due jobs already claimed by another relayer', async () => {
  const result = await processAutomationJobs(
    {
      automation: {
        enabled: true,
        batchSize: 10,
        maxQueuedPerTick: 10,
        defaultPriceCooldownMs: 60000,
        claimStaleMs: 120000,
      },
    },
    { info() {}, warn() {} },
    {
      fetchActiveAutomationJobs: async () => [
        {
          automation_id: 'automation:neo_n3:claimed-elsewhere',
          status: 'active',
          chain: 'neo_n3',
          requester: '0x0c3146e78efc42bfb7d4cc2e06e3efd063c01c56',
          callback_contract: '0x8c506f224d82e67200f20d9d5361f767f0756e3b',
          callback_method: 'onOracleResult',
          execution_request_type: 'privacy_oracle',
          execution_payload: { provider: 'twelvedata' },
          trigger_type: 'one_shot',
          trigger_config: { execute_at: new Date(0).toISOString() },
          next_run_at: new Date(0).toISOString(),
          execution_count: 0,
          max_executions: 1,
        },
      ],
      claimAutomationJob: async (automationId, fields, options) => {
        assert.equal(automationId, 'automation:neo_n3:claimed-elsewhere');
        assert.equal(fields.status, 'processing');
        assert.match(options.dueAtIso, /^\d{4}-/);
        assert.match(options.staleBeforeIso, /^\d{4}-/);
        return null;
      },
      queueNeoN3AutomationRequest: async () => {
        throw new Error('queue must not run without a claim');
      },
      patchAutomationJob: async () => {
        throw new Error('patch must not run when another relayer owns the claim');
      },
      insertAutomationRun: async () => {
        throw new Error('run must not be inserted when another relayer owns the claim');
      },
    }
  );

  assert.deepEqual(result, { queued: 0, skipped: 1, failed: 0, inspected: 1 });
});

test('claimAutomationJob falls back to paused marker when processing status is not migrated', async () => {
  const previousUrl = process.env.SUPABASE_URL;
  const previousKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const previousNetwork = process.env.MORPHEUS_NETWORK;
  const originalFetch = global.fetch;
  const requests = [];

  process.env.SUPABASE_URL = 'https://supabase.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
  process.env.MORPHEUS_NETWORK = 'testnet';
  global.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), body: JSON.parse(String(options.body || '{}')) });
    if (requests.length === 1) {
      return new Response(
        JSON.stringify({
          code: '23514',
          message:
            'new row for relation "morpheus_automation_jobs" violates check constraint "morpheus_automation_jobs_status_check"',
        }),
        { status: 400, headers: { 'content-type': 'application/json' } }
      );
    }
    return new Response(
      JSON.stringify([
        {
          automation_id: 'automation:neo_n3:fallback',
          status: 'paused',
          last_error: AUTOMATION_PROCESSING_CLAIM_MARKER,
        },
      ]),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  };

  try {
    const claimed = await claimAutomationJob(
      'automation:neo_n3:fallback',
      { status: 'processing', last_error: null },
      {
        dueAtIso: '2026-05-03T09:00:00.000Z',
        staleBeforeIso: '2026-05-03T08:58:00.000Z',
      }
    );
    assert.equal(claimed.status, 'paused');
    assert.equal(claimed.last_error, AUTOMATION_PROCESSING_CLAIM_MARKER);
  } finally {
    global.fetch = originalFetch;
    if (previousUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = previousUrl;
    if (previousKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = previousKey;
    if (previousNetwork === undefined) delete process.env.MORPHEUS_NETWORK;
    else process.env.MORPHEUS_NETWORK = previousNetwork;
  }

  assert.equal(requests.length, 2);
  assert.equal(requests[0].body.status, 'processing');
  assert.equal(requests[1].body.status, 'paused');
  assert.equal(requests[1].body.last_error, AUTOMATION_PROCESSING_CLAIM_MARKER);
  assert.match(requests[1].url, /last_error\.eq\.__morpheus_automation_processing_claim__/);
});

test('decodePayloadText parses JSON and preserves raw strings', () => {
  assert.deepEqual(decodePayloadText('{"provider":"twelvedata"}'), { provider: 'twelvedata' });
  assert.deepEqual(decodePayloadText('not-json'), { raw_payload: 'not-json' });
});

test('buildWorkerPayload injects relayer metadata', () => {
  assert.deepEqual(
    buildWorkerPayload('neo_n3', 'privacy_oracle', { provider: 'twelvedata' }, 42, {
      requester: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      callbackContract: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      callbackMethod: 'onOracleResult',
    }),
    {
      provider: 'twelvedata',
      request_id: '42',
      request_source: 'morpheus-relayer:neo_n3',
      target_chain: 'neo_n3',
      legacy_request_type: 'privacy_oracle',
      kernel_module_id: 'oracle.fetch',
      kernel_operation: 'privacy_oracle',
      requester: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      callback_contract: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      callback_method: 'onOracleResult',
    }
  );
});

test('buildFulfillmentDigestBytes binds the full callback context', () => {
  const options = { payloadHex: '0x' };
  const baseline = buildFulfillmentDigestBytes(
    '42',
    'compute',
    true,
    '{"ok":true}',
    '',
    '',
    options
  );
  const changedResult = buildFulfillmentDigestBytes(
    '42',
    'compute',
    true,
    '{"ok":false}',
    '',
    '',
    options
  );
  const changedError = buildFulfillmentDigestBytes(
    '42',
    'compute',
    false,
    '',
    'failed',
    '',
    options
  );
  const changedRequest = buildFulfillmentDigestBytes(
    '43',
    'compute',
    true,
    '{"ok":true}',
    '',
    '',
    options
  );

  assert.equal(Buffer.isBuffer(baseline), true);
  assert.equal(baseline.length, 32);
  assert.notDeepEqual(baseline, changedResult);
  assert.notDeepEqual(baseline, changedError);
  assert.notDeepEqual(baseline, changedRequest);
});

test('buildFulfillmentDigestBytes binds deployment (script hash + network) to match the kernel', () => {
  // Reference digest is the value the on-chain ComputeFulfillmentDigest produces for
  // these exact inputs, cross-verified by the contract test
  // FulfillRequest_VerifiesSignatureOverDigest (the contract accepts a signature over
  // this byte layout: ...+sha256(error)+scriptHash(LE 20)+networkMagic(LE 4)).
  const result = Buffer.from([0xaa, 0xbb, 0xcc]);
  const bound = buildFulfillmentDigestBytes('42', '', true, '', '', result.toString('base64'), {
    chain: 'neo_n3',
    appId: 'demo.app',
    moduleId: 'oracle.fetch',
    operation: 'fetch',
    payloadHex: '0x',
    contractScriptHash: '0x1122334455667788990011223344556677889900',
    networkMagic: 894710606,
  });
  const unbound = buildFulfillmentDigestBytes('42', '', true, '', '', result.toString('base64'), {
    chain: 'neo_n3',
    appId: 'demo.app',
    moduleId: 'oracle.fetch',
    operation: 'fetch',
    payloadHex: '0x',
  });
  assert.equal(
    bound.toString('hex'),
    '9c8e421367690cbb384bec70aa155a649aa8c852505f5d903c2428d4e7d5e213'
  );
  assert.notDeepEqual(bound, unbound); // deployment binding is actually applied
});

test('encodeFulfillmentResult returns success envelope for worker output', () => {
  const fulfilled = encodeFulfillmentResult('privacy_oracle', {
    ok: true,
    status: 200,
    body: {
      result: true,
      output_hash: 'abc',
      attestation_hash: 'abc',
      tee_attestation: { report_data: '0xabc' },
    },
  });
  assert.equal(fulfilled.success, true);
  assert.equal(typeof fulfilled.result, 'string');
  assert.equal(fulfilled.error, '');

  const parsed = JSON.parse(fulfilled.result);
  assert.equal(parsed.version, 'morpheus-result/v1');
  assert.equal(parsed.request_type, 'privacy_oracle');
  assert.equal(parsed.result.result, true);
  assert.equal(parsed.verification.output_hash, 'abc');
  assert.equal(parsed.verification.tee_attestation.quote_hash, null);

  const failed = encodeFulfillmentResult('compute', {
    ok: false,
    status: 400,
    body: { error: 'bad request' },
  });
  assert.equal(failed.success, false);
  assert.equal(failed.result, '');
  assert.equal(failed.error, 'bad request');
});

test('encodeFulfillmentResult emits compact bytes for neodid recovery ticket callbacks when requested', () => {
  const fulfilled = encodeFulfillmentResult('neodid_recovery_ticket', {
    ok: true,
    status: 200,
    body: {
      callback_encoding: 'neo_n3_recovery_v1',
      new_owner: '0x89b05cac00804648c666b47ecb1c57bc185821b7',
      recovery_nonce: '7',
      expires_at: '1735689600',
      action_id: 'aa_recovery:demo:7',
      master_nullifier: '0x1111111111111111111111111111111111111111111111111111111111111111',
      action_nullifier: '0x2222222222222222222222222222222222222222222222222222222222222222',
      signature: '33'.repeat(64),
    },
  });

  assert.equal(fulfilled.success, true);
  assert.equal(fulfilled.result, '');
  assert.equal(typeof fulfilled.result_bytes_base64, 'string');
  assert.ok(Buffer.from(fulfilled.result_bytes_base64, 'base64').length > 100);
});

test('encodeFulfillmentResult emits raw randomness bytes for rng callbacks', () => {
  const fulfilled = encodeFulfillmentResult('rng', {
    ok: true,
    status: 200,
    body: {
      randomness: '11'.repeat(32),
    },
  });

  assert.equal(fulfilled.success, true);
  assert.equal(fulfilled.result, '');
  assert.equal(fulfilled.error, '');
  assert.equal(
    Buffer.from(fulfilled.result_bytes_base64, 'base64').toString('hex'),
    '11'.repeat(32)
  );
});

test('buildFulfillmentDigestBytes can bind raw callback bytes instead of utf8 JSON', () => {
  const raw = Buffer.from('01020304', 'hex').toString('base64');
  const options = { payloadHex: '0x' };
  const baseline = buildFulfillmentDigestBytes(
    '42',
    'neodid_recovery_ticket',
    true,
    '',
    '',
    raw,
    options
  );
  const changed = buildFulfillmentDigestBytes(
    '42',
    'neodid_recovery_ticket',
    true,
    '',
    '',
    Buffer.from('05060708', 'hex').toString('base64'),
    options
  );

  assert.equal(Buffer.isBuffer(baseline), true);
  assert.equal(baseline.length, 32);
  assert.notDeepEqual(baseline, changed);
});

test('buildOnchainResultEnvelope normalizes verification metadata', () => {
  const envelope = buildOnchainResultEnvelope('vrf', {
    ok: true,
    status: 200,
    body: {
      randomness: '1234',
      verification: {
        output_hash: 'deadbeef',
        attestation_hash: 'deadbeef',
        tee_attestation: { report_data: '0xdeadbeef', quote: '0x1234', event_log: 'demo-log' },
      },
    },
  });

  assert.equal(envelope.version, 'morpheus-result/v1');
  assert.equal(envelope.request_type, 'vrf');
  assert.equal(envelope.module_id, 'random.generate');
  assert.equal(envelope.operation, 'vrf');
  assert.equal(envelope.result.randomness, '1234');
  assert.equal(envelope.verification.output_hash, 'deadbeef');
  assert.equal(typeof envelope.verification.tee_attestation.quote_hash, 'string');
  assert.equal(typeof envelope.verification.tee_attestation.event_log_hash, 'string');
});

test('buildOnchainResultEnvelope preserves neodid recovery ticket fields', () => {
  const envelope = buildOnchainResultEnvelope('neodid_recovery_ticket', {
    ok: true,
    status: 200,
    body: {
      mode: 'neodid_recovery_ticket',
      aa_contract: '0xf54d8584ef82315c1800373272ab08ae0db2d5ef',
      account_id: 'aa-test-01',
      new_owner: '0x89b05cac00804648c666b47ecb1c57bc185821b7',
      recovery_nonce: '7',
      expires_at: '1735689600',
      action_id: 'aa_recovery:neo_n3:oracle:aa-test-01:new:7',
      master_nullifier: '0x1111111111111111111111111111111111111111111111111111111111111111',
      action_nullifier: '0x2222222222222222222222222222222222222222222222222222222222222222',
      digest: '0x3333333333333333333333333333333333333333333333333333333333333333',
      verification: {
        output_hash: 'deadbeef',
        attestation_hash: 'deadbeef',
      },
    },
  });

  assert.equal(envelope.request_type, 'neodid_recovery_ticket');
  assert.equal(envelope.module_id, 'identity.verify');
  assert.equal(envelope.operation, 'neodid_recovery_ticket');
  assert.equal(envelope.result.account_id, 'aa-test-01');
  assert.equal(envelope.result.new_owner, '0x89b05cac00804648c666b47ecb1c57bc185821b7');
  assert.equal(
    envelope.result.action_nullifier,
    '0x2222222222222222222222222222222222222222222222222222222222222222'
  );
});

test('buildOnchainResultEnvelope compacts oversized privacy oracle payloads', () => {
  const envelope = buildOnchainResultEnvelope('privacy_oracle', {
    ok: true,
    status: 200,
    body: {
      mode: 'fetch',
      target_chain: 'neo_n3',
      result: { huge: 'x'.repeat(5000) },
      extracted_value: '42',
      verification: {
        output_hash: 'deadbeef',
        attestation_hash: 'beadfeed',
        tee_attestation: {
          app_id: 'app',
          compose_hash: 'hash',
          report_data: 'rd',
          quote: 'q'.repeat(5000),
          event_log: 'e'.repeat(5000),
        },
      },
    },
  });

  const encoded = JSON.stringify(envelope);
  assert.ok(encoded.length < 900);
  assert.equal(envelope.module_id, 'oracle.fetch');
  assert.equal(envelope.operation, 'privacy_oracle');
  assert.equal(envelope.result.result, '42');
  assert.equal(envelope.result.result_source, 'extracted_value');
  assert.equal(typeof envelope.verification.tee_attestation.quote_hash, 'string');
});

test('state tracks processed events and metrics snapshot', () => {
  const state = createEmptyRelayerState();
  const event = {
    chain: 'neo_n3',
    requestId: '7',
    txHash: '0xabc',
    logIndex: 0,
    blockNumber: 12,
    requestType: 'privacy_oracle',
  };
  recordProcessedEvent(state, 'neo_n3', event, 'fulfilled', { attempts: 1 }, retryConfig);
  assert.equal(hasProcessedEvent(state, 'neo_n3', event), true);
  const record = state.neo_n3.processed_records[buildEventKey(event)];
  assert.equal(record.module_id, 'oracle.fetch');
  assert.equal(record.operation, 'privacy_oracle');
  const metrics = snapshotMetrics(state);
  assert.equal(metrics.retry_queue_sizes.neo_n3, 0);
  assert.equal(metrics.checkpoints.neo_n3, null);
  assert.ok(buildEventKey(event).includes('neo_n3:7:0xabc'));
});

test('state schedules retries and marks queued items due', () => {
  const state = createEmptyRelayerState();
  const event = {
    chain: 'neo_n3',
    requestId: '9',
    txHash: '0xdef',
    logIndex: 3,
    blockNumber: 22,
    requestType: 'compute',
  };
  const scheduled = scheduleRetry(state, 'neo_n3', event, 'temporary failure', retryConfig);
  assert.equal(scheduled.status, 'scheduled');
  assert.equal(isEventQueuedForRetry(state, 'neo_n3', event), true);

  state.neo_n3.retry_queue[0].next_retry_at = Date.now() - 1;
  const due = getDueRetryItems(state, 'neo_n3');
  assert.equal(due.length, 1);
  assert.equal(due[0].key, buildEventKey(event));
});

test('state exhausts retries after max attempts', () => {
  const state = createEmptyRelayerState();
  const event = {
    chain: 'neo_n3',
    requestId: '11',
    txHash: '0x123',
    logIndex: 0,
    blockNumber: 30,
    requestType: 'datafeed',
  };
  assert.equal(scheduleRetry(state, 'neo_n3', event, 'fail-1', retryConfig).status, 'scheduled');
  assert.equal(scheduleRetry(state, 'neo_n3', event, 'fail-2', retryConfig).status, 'scheduled');
  assert.equal(scheduleRetry(state, 'neo_n3', event, 'fail-3', retryConfig).status, 'scheduled');
  const exhausted = scheduleRetry(state, 'neo_n3', event, 'fail-4', retryConfig);
  assert.equal(exhausted.status, 'exhausted');
});

test('saveRelayerState creates parent directories', () => {
  const state = createEmptyRelayerState();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'morpheus-relayer-state-'));
  const target = path.join(root, 'nested', '.morpheus-relayer-state.json');
  saveRelayerState(target, state);
  assert.equal(fs.existsSync(target), true);
});

test('hasNeoN3RelayerConfig requires rpc, contract, and a custody updater key', () => {
  const config = {
    neo_n3: {
      rpcUrl: 'https://neo.test',
      oracleContract: '0xabc',
      custodyKeyIds: { updater: 'key-updater' },
    },
  };

  assert.equal(hasNeoN3RelayerConfig(config), true);
  assert.equal(
    hasNeoN3RelayerConfig({
      ...config,
      neo_n3: { ...config.neo_n3, custodyKeyIds: { updater: '' } },
    }),
    false
  );
});

test('Neo N3 fulfill signs updater transactions through the custody signer service', async () => {
  const originalFetch = global.fetch;
  const signer = new wallet.Account('2'.repeat(64));
  const custodyCalls = [];
  try {
    global.fetch = async (url, init = {}) => {
      const href = String(url);
      if (href.startsWith('https://custody.test/signer/api/v1/keys/key-updater')) {
        custodyCalls.push(href);
        return new Response(
          JSON.stringify({
            key_id: 'key-updater',
            label: 'updater',
            network: 'mainnet',
            network_magic: 860833102,
            public_key: signer.publicKey,
            script_hash: `0x${signer.scriptHash}`,
            address: signer.address,
            verification_script: `0c21${signer.publicKey}4156e7b327`,
            signing_enabled: true,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (href === 'https://custody.test/signer/api/v1/sign/transaction') {
        const body = JSON.parse(String(init.body || '{}'));
        assert.equal(body.key_id, 'key-updater');
        assert.match(String(body.unsigned_hex || ''), /^[0-9a-f]+$/i);
        return new Response(
          JSON.stringify({
            allowed: true,
            key_id: 'key-updater',
            script_hash: `0x${signer.scriptHash}`,
            address: signer.address,
            digest: 'd'.repeat(64),
            invocation_script: `0c40${'1'.repeat(128)}`,
            verification_script: `0c21${signer.publicKey}4156e7b327`,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }

      const rpcBody = JSON.parse(String(init.body || '{}'));
      if (rpcBody.method === 'getblockcount') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 1000 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (rpcBody.method === 'invokescript') {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: { state: 'HALT', gasconsumed: '1000000' },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (rpcBody.method === 'calculatenetworkfee') {
        return new Response(
          JSON.stringify({ jsonrpc: '2.0', id: 1, result: { networkfee: '100000' } }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (rpcBody.method === 'sendrawtransaction') {
        assert.ok(String(rpcBody.params?.[0] || '').length > 0);
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (rpcBody.method === 'getapplicationlog') {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: { executions: [{ vmstate: 'HALT' }] },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      throw new Error(`unexpected fetch ${href}`);
    };

    const result = await fulfillNeoN3Request(
      {
        network: 'mainnet',
        useDerivedKeys: false,
        nitro: {
          apiUrl: 'https://runtime.test',
          token: '',
          timeoutMs: 1000,
          custodyUrl: 'https://custody.test',
          custodyToken: 'custody-token',
        },
        neo_n3: {
          rpcUrl: 'https://neo.test',
          rpcUrls: ['https://neo.test'],
          networkMagic: 860833102,
          oracleContract: '0xf54d8584ef82315c1800373272ab08ae0db2d5ef',
          custodyKeyIds: { updater: 'key-updater' },
        },
      },
      23,
      true,
      '',
      '',
      '3'.repeat(128),
      Buffer.from('ok').toString('base64')
    );

    assert.equal(result.vm_state, 'HALT');
    assert.equal(result.target_chain, 'neo_n3');
    assert.ok(custodyCalls.includes('https://custody.test/signer/api/v1/keys/key-updater'));
  } finally {
    global.fetch = originalFetch;
  }
});

test('Neo N3 fulfill auto-funds the custody updater when GAS fee reserve is low', async () => {
  const originalFetch = global.fetch;
  const updater = new wallet.Account('2'.repeat(64));
  const funder = new wallet.Account('4'.repeat(64));
  const sendrawTransactions = [];
  const balanceChecks = [];
  const custodyKeyLookups = [];
  try {
    global.fetch = async (url, init = {}) => {
      const href = String(url);
      if (href.startsWith('https://custody.test/signer/api/v1/keys/')) {
        const keyId = decodeURIComponent(href.split('/keys/')[1]);
        custodyKeyLookups.push(keyId);
        const account = keyId === 'key-fee-funder' ? funder : updater;
        return new Response(
          JSON.stringify({
            key_id: keyId,
            label: keyId,
            network: 'mainnet',
            network_magic: 860833102,
            public_key: account.publicKey,
            script_hash: `0x${account.scriptHash}`,
            address: account.address,
            verification_script: `0c21${account.publicKey}4156e7b327`,
            signing_enabled: true,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (href === 'https://custody.test/signer/api/v1/sign/transaction') {
        const body = JSON.parse(String(init.body || '{}'));
        const account = body.key_id === 'key-fee-funder' ? funder : updater;
        return new Response(
          JSON.stringify({
            allowed: true,
            key_id: body.key_id,
            script_hash: `0x${account.scriptHash}`,
            address: account.address,
            digest: 'd'.repeat(64),
            invocation_script: `0c40${'1'.repeat(128)}`,
            verification_script: `0c21${account.publicKey}4156e7b327`,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }

      const rpcBody = JSON.parse(String(init.body || '{}'));
      if (rpcBody.method === 'getblockcount') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 1000 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (rpcBody.method === 'invokefunction') {
        assert.equal(rpcBody.params?.[0], '0xd2a4cff31913016155e38e474a2c06d08be276cf');
        assert.equal(rpcBody.params?.[1], 'balanceOf');
        const account = String(rpcBody.params?.[2]?.[0]?.value || '').toLowerCase();
        balanceChecks.push(account);
        const value = account === `0x${updater.scriptHash}`.toLowerCase() ? '0' : '2000000000';
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: { state: 'HALT', stack: [{ type: 'Integer', value }] },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (rpcBody.method === 'invokescript') {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: { state: 'HALT', gasconsumed: '1000000' },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (rpcBody.method === 'calculatenetworkfee') {
        return new Response(
          JSON.stringify({ jsonrpc: '2.0', id: 1, result: { networkfee: '100000' } }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (rpcBody.method === 'sendrawtransaction') {
        sendrawTransactions.push(String(rpcBody.params?.[0] || ''));
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (rpcBody.method === 'getapplicationlog') {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: { executions: [{ vmstate: 'HALT' }] },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      throw new Error(`unexpected fetch ${href} ${rpcBody.method}`);
    };

    await fulfillNeoN3Request(
      {
        network: 'mainnet',
        useDerivedKeys: false,
        nitro: {
          apiUrl: 'https://runtime.test',
          token: '',
          timeoutMs: 1000,
          custodyUrl: 'https://custody.test',
          custodyToken: 'custody-token',
        },
        neo_n3: {
          rpcUrl: 'https://neo.test',
          rpcUrls: ['https://neo.test'],
          networkMagic: 860833102,
          oracleContract: '0xf54d8584ef82315c1800373272ab08ae0db2d5ef',
          custodyKeyIds: { updater: 'key-updater', fee_funder: 'key-fee-funder' },
          feeTopUp: {
            enabled: true,
            minBalance: '50000000',
            topUpAmount: '100000000',
            maxTopUpAmount: '500000000',
          },
        },
      },
      23,
      true,
      '',
      '',
      '3'.repeat(128),
      Buffer.from('ok').toString('base64')
    );

    assert.ok(
      balanceChecks.includes(`0x${updater.scriptHash}`.toLowerCase()),
      'expected updater balance to be checked before fulfillment'
    );
    assert.ok(
      custodyKeyLookups.includes('key-fee-funder'),
      'expected the fee-funder custody key to be resolved for the top-up'
    );
    assert.equal(sendrawTransactions.length, 2, 'expected top-up tx and fulfill tx');
  } finally {
    global.fetch = originalFetch;
  }
});

test('createRelayerConfig exposes the shared-worker derived-key preference', () => {
  const previous = process.env.NITRO_USE_DERIVED_KEYS;
  process.env.NITRO_USE_DERIVED_KEYS = 'true';

  try {
    const config = withIsolatedRelayerSigner(() => createRelayerConfig());
    assert.equal(config.useDerivedKeys, true);
    assert.equal(config.nitro.useDerivedKeys, true);
  } finally {
    if (previous === undefined) delete process.env.NITRO_USE_DERIVED_KEYS;
    else process.env.NITRO_USE_DERIVED_KEYS = previous;
  }
});

test('createRelayerConfig rejects Neo N3 host keys even outside production', () => {
  const keys = ['NODE_ENV', 'MORPHEUS_RELAYER_NEO_N3_WIF'];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  process.env.NODE_ENV = 'development';
  process.env.MORPHEUS_RELAYER_NEO_N3_WIF = 'legacy-host-wif';

  try {
    assert.throws(
      () => createRelayerConfig(),
      /host Neo N3 signing key configuration is forbidden.*custody key ids/i
    );
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('createRelayerConfig exposes the custody-backed Neo X lane in production', () => {
  const keys = [
    'NODE_ENV',
    'MORPHEUS_ACTIVE_CHAINS',
    'MORPHEUS_RELAYER_NEOX_UPDATER_PK',
    'NEOX_UPDATER_PK',
    'NEOX_FEED_PK',
  ];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  process.env.NODE_ENV = 'production';
  process.env.MORPHEUS_ACTIVE_CHAINS = 'neox';
  delete process.env.MORPHEUS_RELAYER_NEOX_UPDATER_PK;
  delete process.env.NEOX_UPDATER_PK;
  delete process.env.NEOX_FEED_PK;

  try {
    const config = withIsolatedRelayerSigner(() => createRelayerConfig());
    assert.deepEqual(config.activeChains, ['neox']);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

// Runs `run` with only MORPHEUS_RUNTIME_CONFIG_JSON selecting the network.
function withPackedRuntimeConfig(value, run) {
  const keys = ['MORPHEUS_RUNTIME_CONFIG_JSON', 'MORPHEUS_NETWORK', 'NEXT_PUBLIC_MORPHEUS_NETWORK'];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  process.env.MORPHEUS_RUNTIME_CONFIG_JSON = value;
  try {
    return withIsolatedRelayerSigner(run);
  } finally {
    for (const [key, saved] of previous) {
      if (saved === undefined) delete process.env[key];
      else process.env[key] = saved;
    }
  }
}

test('createRelayerConfig refuses a corrupt or non-object packed runtime config', () => {
  // Truncated JSON that names mainnet: read as empty, it would start the
  // relayer on its TestNet defaults.
  const secret = 'packed-secret-value-0123456789';
  withPackedRuntimeConfig(
    `{"MORPHEUS_NETWORK":"mainnet","MORPHEUS_RELAYER_ADMIN_API_KEY":"${secret}"`,
    () => {
      assert.throws(
        () => createRelayerConfig(),
        (error) =>
          /MORPHEUS_RUNTIME_CONFIG_JSON is not valid JSON/.test(error.message) &&
          !error.message.includes(secret)
      );
    }
  );
  for (const value of ['["mainnet"]', '"mainnet"', '42', 'null']) {
    withPackedRuntimeConfig(value, () => {
      assert.throws(
        () => createRelayerConfig(),
        /MORPHEUS_RUNTIME_CONFIG_JSON must be a JSON object/,
        value
      );
    });
  }
});

test('createRelayerConfig treats a packed false or 0 network as an explicit label', () => {
  for (const network of [false, 0]) {
    withPackedRuntimeConfig(JSON.stringify({ MORPHEUS_NETWORK: network }), () => {
      assert.throws(() => createRelayerConfig(), /unsupported Neo network/, String(network));
    });
  }
  withPackedRuntimeConfig(JSON.stringify({ MORPHEUS_NETWORK: 'mainnet' }), () => {
    assert.equal(createRelayerConfig().network, 'mainnet');
  });
});

test('createRelayerConfig reads relayer heartbeat urls from packed runtime config', () => {
  const keys = [
    'MORPHEUS_RUNTIME_CONFIG_JSON',
    'MORPHEUS_BETTERSTACK_RELAYER_HEARTBEAT_URL',
    'MORPHEUS_BETTERSTACK_RELAYER_FEED_HEARTBEAT_URL',
    'MORPHEUS_BETTERSTACK_RELAYER_FAILURE_URL',
  ];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));

  process.env.MORPHEUS_RUNTIME_CONFIG_JSON = JSON.stringify({
    MORPHEUS_BETTERSTACK_RELAYER_HEARTBEAT_URL: 'https://heartbeat.test/relayer',
    MORPHEUS_BETTERSTACK_RELAYER_FEED_HEARTBEAT_URL: 'https://heartbeat.test/feed',
    MORPHEUS_BETTERSTACK_RELAYER_FAILURE_URL: 'https://heartbeat.test/failure',
  });
  delete process.env.MORPHEUS_BETTERSTACK_RELAYER_HEARTBEAT_URL;
  delete process.env.MORPHEUS_BETTERSTACK_RELAYER_FEED_HEARTBEAT_URL;
  delete process.env.MORPHEUS_BETTERSTACK_RELAYER_FAILURE_URL;

  try {
    const config = withIsolatedRelayerSigner(() => createRelayerConfig());
    assert.equal(config.heartbeats.relayer, 'https://heartbeat.test/relayer');
    assert.equal(config.heartbeats.feedRelayer, 'https://heartbeat.test/feed');
    assert.equal(config.heartbeats.failure, 'https://heartbeat.test/failure');
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('createRelayerConfig exposes request cursor start ids', () => {
  const previousNetwork = process.env.MORPHEUS_NETWORK;
  const previousNeoN3 = process.env.MORPHEUS_RELAYER_NEO_N3_START_REQUEST_ID;

  process.env.MORPHEUS_NETWORK = 'testnet';
  process.env.MORPHEUS_RELAYER_NEO_N3_START_REQUEST_ID = '150';

  try {
    const config = withIsolatedRelayerSigner(() => createRelayerConfig());
    assert.equal(config.startRequestIds.neo_n3, 150);
  } finally {
    if (previousNetwork === undefined) delete process.env.MORPHEUS_NETWORK;
    else process.env.MORPHEUS_NETWORK = previousNetwork;

    if (previousNeoN3 === undefined) delete process.env.MORPHEUS_RELAYER_NEO_N3_START_REQUEST_ID;
    else process.env.MORPHEUS_RELAYER_NEO_N3_START_REQUEST_ID = previousNeoN3;
  }
});

test('createRelayerConfig maps custody signer-service env into the config', () => {
  const keys = [
    'SIGNER_SERVICE_URL',
    'SIGNER_SERVICE_TOKEN',
    'SIGNER_ROLE_UPDATER_KEY_ID',
    'SIGNER_ROLE_ORACLE_VERIFIER_KEY_ID',
    'SIGNER_ROLE_FEE_FUNDER_KEY_ID',
    'SIGNER_ROLE_SPONSOR_KEY_ID',
  ];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));

  process.env.SIGNER_SERVICE_URL = 'https://custody.example';
  process.env.SIGNER_SERVICE_TOKEN = 'custody-token';
  process.env.SIGNER_ROLE_UPDATER_KEY_ID = 'key-updater';
  process.env.SIGNER_ROLE_ORACLE_VERIFIER_KEY_ID = 'key-verifier';
  process.env.SIGNER_ROLE_FEE_FUNDER_KEY_ID = 'key-funder';
  delete process.env.SIGNER_ROLE_SPONSOR_KEY_ID;

  try {
    const config = createRelayerConfig();
    assert.equal(config.nitro.custodyUrl, 'https://custody.example');
    assert.equal(config.nitro.custodyToken, 'custody-token');
    assert.deepEqual(config.neo_n3.custodyKeyIds, {
      updater: 'key-updater',
      oracle_verifier: 'key-verifier',
      fee_funder: 'key-funder',
      sponsor: '',
    });
    assert.equal(config.nitro.sponsorCustodyKeyId, '');
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('createRelayerConfig keeps sponsor custody explicit and consistent across both projections', () => {
  const keys = ['SIGNER_ROLE_SPONSOR_KEY_ID', 'SIGNER_ROLE_UPDATER_KEY_ID'];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  process.env.SIGNER_ROLE_UPDATER_KEY_ID = 'key-updater-must-not-sponsor';
  try {
    for (const [input, expected] of [
      [undefined, ''],
      ['', ''],
      ['   ', ''],
      ['key-sponsor', 'key-sponsor'],
      ['  key-sponsor  ', 'key-sponsor'],
    ]) {
      if (input === undefined) delete process.env.SIGNER_ROLE_SPONSOR_KEY_ID;
      else process.env.SIGNER_ROLE_SPONSOR_KEY_ID = input;
      const config = withIsolatedRelayerSigner(() => createRelayerConfig());
      assert.equal(config.neo_n3.custodyKeyIds.sponsor, expected);
      assert.equal(config.nitro.sponsorCustodyKeyId, expected);
      assert.equal(config.neo_n3.custodyKeyIds.updater, 'key-updater-must-not-sponsor');
    }
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('createRelayerConfig prefers network-scoped Neo N3 contract hashes over stale generic env', () => {
  const keys = [
    'MORPHEUS_NETWORK',
    'CONTRACT_MORPHEUS_ORACLE_HASH',
    'CONTRACT_MORPHEUS_ORACLE_HASH_MAINNET',
    'CONTRACT_MORPHEUS_ORACLE_HASH_TESTNET',
    'CONTRACT_MORPHEUS_DATAFEED_HASH',
    'CONTRACT_MORPHEUS_DATAFEED_HASH_MAINNET',
    'CONTRACT_MORPHEUS_DATAFEED_HASH_TESTNET',
  ];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));

  process.env.MORPHEUS_NETWORK = 'mainnet';
  process.env.CONTRACT_MORPHEUS_ORACLE_HASH = '0xgenericstale';
  process.env.CONTRACT_MORPHEUS_ORACLE_HASH_MAINNET = '0xmainnetoracle';
  process.env.CONTRACT_MORPHEUS_ORACLE_HASH_TESTNET = '0xtestnetoracle';
  process.env.CONTRACT_MORPHEUS_DATAFEED_HASH = '0xgenericfeed';
  process.env.CONTRACT_MORPHEUS_DATAFEED_HASH_MAINNET = '0xmainnetfeed';
  process.env.CONTRACT_MORPHEUS_DATAFEED_HASH_TESTNET = '0xtestnetfeed';

  try {
    const config = withIsolatedRelayerSigner(() => createRelayerConfig());
    assert.equal(config.neo_n3.oracleContract, '0xmainnetoracle');
    assert.equal(config.neo_n3.datafeedContract, '0xmainnetfeed');
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('createRelayerConfig ranks https mainnet Neo N3 RPC endpoints before plaintext http seeds', () => {
  const keys = [
    'MORPHEUS_NETWORK',
    'MORPHEUS_RUNTIME_CONFIG_JSON',
    'NEO_MAINNET_RPC_URLS',
    'MAINNET_RPC_URLS',
    'NEO_RPC_URLS_MAINNET',
    'NEO_MAINNET_RPC_URL',
    'MAINNET_RPC_URL',
    'NEO_RPC_MAINNET',
    'NEO_RPC_URLS',
    'NEO_RPC_URL',
    'ALLOW_GENERIC_NEO_RPC_URL',
  ];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));

  process.env.MORPHEUS_NETWORK = 'mainnet';
  delete process.env.MORPHEUS_RUNTIME_CONFIG_JSON;
  delete process.env.NEO_MAINNET_RPC_URLS;
  delete process.env.MAINNET_RPC_URLS;
  delete process.env.NEO_RPC_URLS_MAINNET;
  delete process.env.NEO_MAINNET_RPC_URL;
  delete process.env.MAINNET_RPC_URL;
  delete process.env.NEO_RPC_MAINNET;
  delete process.env.NEO_RPC_URLS;
  delete process.env.NEO_RPC_URL;
  delete process.env.ALLOW_GENERIC_NEO_RPC_URL;

  try {
    const config = withIsolatedRelayerSigner(() => createRelayerConfig());
    // Security: the relayer must prefer a TLS endpoint and never default to a
    // MITM-able cleartext http:// seed when an https:// endpoint is available.
    assert.ok(
      config.neo_n3.rpcUrl.startsWith('https://'),
      'preferred mainnet RPC must be an https endpoint'
    );
    const firstHttp = config.neo_n3.rpcUrls.findIndex((url) => url.startsWith('http://'));
    const lastHttps = config.neo_n3.rpcUrls.reduce(
      (acc, url, index) => (url.startsWith('https://') ? index : acc),
      -1
    );
    assert.ok(
      firstHttp === -1 || lastHttps < firstHttp,
      'no plaintext http:// RPC may be ranked before an https:// RPC'
    );
    // Strengthened from "http seeds remain present as a last-resort fallback".
    // Ranking them last was never a control: uniqueRankedRpcUrls only demotes
    // http://, so a surviving cleartext seed is still dialed once every https://
    // node is unreachable — the exact state an on-path attacker who can drop
    // traffic can force, after which they see every address and balance query
    // and can rewrite the response a signing decision is made from. No cleartext
    // endpoint may appear in the resolved list at all; failing closed with a
    // short https-only list is the intended outcome.
    assert.equal(
      firstHttp,
      -1,
      `resolved mainnet RPC list must contain no cleartext http:// endpoint, got ${JSON.stringify(
        config.neo_n3.rpcUrls
      )}`
    );
    assert.ok(
      config.neo_n3.rpcUrls.every((url) => url.startsWith('https://')),
      'every resolved mainnet RPC endpoint must be https://'
    );
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('createRelayerConfig rejects an explicit cleartext RPC endpoint', () => {
  const key = 'NEO_MAINNET_RPC_URLS';
  const previous = process.env[key];
  const previousNetwork = process.env.MORPHEUS_NETWORK;
  process.env.MORPHEUS_NETWORK = 'mainnet';
  process.env[key] = 'http://cleartext.rpc';
  try {
    assert.throws(
      () => withIsolatedRelayerSigner(() => createRelayerConfig()),
      /Neo N3 mainnet RPC requires HTTPS RPC endpoints.*http:\/\/cleartext\.rpc/i
    );
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
    if (previousNetwork === undefined) delete process.env.MORPHEUS_NETWORK;
    else process.env.MORPHEUS_NETWORK = previousNetwork;
  }
});

test('createRelayerConfig rejects an explicit cleartext Neo X RPC endpoint', () => {
  const keys = ['MORPHEUS_NETWORK', 'MORPHEUS_RELAYER_NEOX_RPC_URL', 'NEOX_RPC'];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  process.env.MORPHEUS_NETWORK = 'testnet';
  delete process.env.NEOX_RPC;
  process.env.MORPHEUS_RELAYER_NEOX_RPC_URL = 'http://cleartext-neox.rpc';
  try {
    assert.throws(
      () => withIsolatedRelayerSigner(() => createRelayerConfig()),
      /Neo X testnet RPC requires HTTPS RPC endpoints.*http:\/\/cleartext-neox\.rpc/i
    );
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('createRelayerConfig defaults active chains to neo_n3 only', () => {
  const previous = process.env.MORPHEUS_ACTIVE_CHAINS;
  delete process.env.MORPHEUS_ACTIVE_CHAINS;

  try {
    const config = withIsolatedRelayerSigner(() => createRelayerConfig());
    assert.deepEqual(config.activeChains, ['neo_n3']);
  } finally {
    if (previous === undefined) delete process.env.MORPHEUS_ACTIVE_CHAINS;
    else process.env.MORPHEUS_ACTIVE_CHAINS = previous;
  }
});

test('createRelayerConfig enables durable queue by default when Supabase is configured', () => {
  const previousUrl = process.env.SUPABASE_URL;
  const previousKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const previousFlag = process.env.MORPHEUS_DURABLE_QUEUE_ENABLED;
  const previousFailClosed = process.env.MORPHEUS_DURABLE_QUEUE_FAIL_CLOSED;

  process.env.SUPABASE_URL = 'https://supabase.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
  delete process.env.MORPHEUS_DURABLE_QUEUE_ENABLED;
  delete process.env.MORPHEUS_DURABLE_QUEUE_FAIL_CLOSED;

  try {
    const config = withIsolatedRelayerSigner(() => createRelayerConfig());
    assert.equal(config.durableQueue.enabled, true);
    assert.equal(config.durableQueue.failClosed, true);
    assert.equal(config.durableQueue.staleProcessingMs, 45000);
  } finally {
    if (previousUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = previousUrl;
    if (previousKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = previousKey;
    if (previousFlag === undefined) delete process.env.MORPHEUS_DURABLE_QUEUE_ENABLED;
    else process.env.MORPHEUS_DURABLE_QUEUE_ENABLED = previousFlag;
    if (previousFailClosed === undefined) delete process.env.MORPHEUS_DURABLE_QUEUE_FAIL_CLOSED;
    else process.env.MORPHEUS_DURABLE_QUEUE_FAIL_CLOSED = previousFailClosed;
  }
});

test('createRelayerConfig supports feed_only mode with isolated default state file', () => {
  const previousMode = process.env.MORPHEUS_RELAYER_MODE;
  const previousStateFile = process.env.MORPHEUS_RELAYER_STATE_FILE;
  delete process.env.MORPHEUS_RELAYER_STATE_FILE;
  process.env.MORPHEUS_RELAYER_MODE = 'feed_only';

  try {
    const config = withIsolatedRelayerSigner(() => createRelayerConfig());
    assert.equal(config.mode, 'feed_only');
    assert.match(config.stateFile, /\.morpheus-relayer-state\.feed_only\.json$/);
  } finally {
    if (previousMode === undefined) delete process.env.MORPHEUS_RELAYER_MODE;
    else process.env.MORPHEUS_RELAYER_MODE = previousMode;
    if (previousStateFile === undefined) delete process.env.MORPHEUS_RELAYER_STATE_FILE;
    else process.env.MORPHEUS_RELAYER_STATE_FILE = previousStateFile;
  }
});

test('createRelayerConfig caps dedicated feed sync timeout at the feed SLO', () => {
  const previous = process.env.MORPHEUS_FEED_SYNC_TIMEOUT_MS;
  process.env.MORPHEUS_FEED_SYNC_TIMEOUT_MS = '90000';
  try {
    const config = withIsolatedRelayerSigner(() => createRelayerConfig());
    assert.equal(config.feedSync.timeoutMs, 30000);
  } finally {
    if (previous === undefined) delete process.env.MORPHEUS_FEED_SYNC_TIMEOUT_MS;
    else process.env.MORPHEUS_FEED_SYNC_TIMEOUT_MS = previous;
  }
});

test('createRelayerConfig caps worker waits at the request SLO and bounds retry backoff sanely', () => {
  const previousNitroTimeout = process.env.MORPHEUS_NITRO_TIMEOUT_MS;
  const previousRetryMaxDelay = process.env.MORPHEUS_RELAYER_RETRY_MAX_DELAY_MS;
  process.env.MORPHEUS_NITRO_TIMEOUT_MS = '90000';
  process.env.MORPHEUS_RELAYER_RETRY_MAX_DELAY_MS = '90000';
  try {
    const config = withIsolatedRelayerSigner(() => createRelayerConfig());
    assert.equal(config.nitro.timeoutMs, 10000);
    // Operators may slow poison-item retries beyond the 10s default; only a
    // sanity ceiling (10 minutes) bounds the env override.
    assert.equal(config.retryMaxDelayMs, 90000);

    process.env.MORPHEUS_RELAYER_RETRY_MAX_DELAY_MS = '99999999';
    const capped = withIsolatedRelayerSigner(() => createRelayerConfig());
    assert.equal(capped.retryMaxDelayMs, 600000);

    delete process.env.MORPHEUS_RELAYER_RETRY_MAX_DELAY_MS;
    const defaults = withIsolatedRelayerSigner(() => createRelayerConfig());
    assert.equal(defaults.retryMaxDelayMs, 10000);
  } finally {
    if (previousNitroTimeout === undefined) delete process.env.MORPHEUS_NITRO_TIMEOUT_MS;
    else process.env.MORPHEUS_NITRO_TIMEOUT_MS = previousNitroTimeout;
    if (previousRetryMaxDelay === undefined) delete process.env.MORPHEUS_RELAYER_RETRY_MAX_DELAY_MS;
    else process.env.MORPHEUS_RELAYER_RETRY_MAX_DELAY_MS = previousRetryMaxDelay;
  }
});

test('createRelayerConfig exposes callback ceiling, neox confirm timeout, and persist interval knobs', () => {
  const keys = [
    'MORPHEUS_RELAYER_MAX_RETRIES',
    'MORPHEUS_RELAYER_MAX_CALLBACK_RETRIES',
    'MORPHEUS_RELAYER_NEOX_CONFIRM_TIMEOUT_MS',
    'MORPHEUS_RELAYER_STATE_PERSIST_MIN_INTERVAL_MS',
  ];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];

  try {
    const defaults = withIsolatedRelayerSigner(() => createRelayerConfig());
    assert.equal(defaults.maxRetries, 5);
    assert.equal(defaults.maxCallbackRetries, 10);
    assert.equal(defaults.neox.confirmTimeoutMs, 45000);
    assert.equal(defaults.statePersistMinIntervalMs, 250);

    process.env.MORPHEUS_RELAYER_MAX_CALLBACK_RETRIES = '4';
    process.env.MORPHEUS_RELAYER_NEOX_CONFIRM_TIMEOUT_MS = '20000';
    process.env.MORPHEUS_RELAYER_STATE_PERSIST_MIN_INTERVAL_MS = '0';
    const overridden = withIsolatedRelayerSigner(() => createRelayerConfig());
    assert.equal(overridden.maxCallbackRetries, 4);
    assert.equal(overridden.neox.confirmTimeoutMs, 20000);
    assert.equal(overridden.statePersistMinIntervalMs, 0);
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('createRelayerConfig appends public runtime fallbacks after explicit runtime urls', () => {
  const previousNetwork = process.env.MORPHEUS_NETWORK;
  const previousApiUrl = process.env.NITRO_API_URL;
  const previousRuntimeUrl = process.env.MORPHEUS_RUNTIME_URL;

  process.env.MORPHEUS_NETWORK = 'testnet';
  process.env.NITRO_API_URL = 'http://nitro-worker:8080';
  delete process.env.MORPHEUS_RUNTIME_URL;

  try {
    const config = withIsolatedRelayerSigner(() => createRelayerConfig());
    assert.match(config.nitro.apiUrl, /^http:\/\/nitro-worker:8080,/);
    assert.match(config.nitro.apiUrl, /https:\/\/oracle\.meshmini\.app\/testnet/);
    assert.match(config.nitro.apiUrl, /https:\/\/edge\.meshmini\.app\/testnet/);
  } finally {
    if (previousNetwork === undefined) delete process.env.MORPHEUS_NETWORK;
    else process.env.MORPHEUS_NETWORK = previousNetwork;
    if (previousApiUrl === undefined) delete process.env.NITRO_API_URL;
    else process.env.NITRO_API_URL = previousApiUrl;
    if (previousRuntimeUrl === undefined) delete process.env.MORPHEUS_RUNTIME_URL;
    else process.env.MORPHEUS_RUNTIME_URL = previousRuntimeUrl;
  }
});

test('createRelayerConfig lets direct env override packed runtime URL candidates', () => {
  const previousNetwork = process.env.MORPHEUS_NETWORK;
  const previousRuntimeConfig = process.env.MORPHEUS_RUNTIME_CONFIG_JSON;
  const previousNitroApiUrl = process.env.NITRO_API_URL;

  process.env.MORPHEUS_NETWORK = 'mainnet';
  process.env.MORPHEUS_RUNTIME_CONFIG_JSON = JSON.stringify({
    MORPHEUS_MAINNET_RUNTIME_URL: 'https://packed-runtime.example/mainnet',
  });
  process.env.NITRO_API_URL = 'http://mainnet-feed-worker:8080';

  try {
    const config = withIsolatedRelayerSigner(() => createRelayerConfig());
    assert.equal(config.nitro.apiUrl.split(',')[0], 'http://mainnet-feed-worker:8080');
  } finally {
    if (previousNetwork === undefined) delete process.env.MORPHEUS_NETWORK;
    else process.env.MORPHEUS_NETWORK = previousNetwork;
    if (previousRuntimeConfig === undefined) delete process.env.MORPHEUS_RUNTIME_CONFIG_JSON;
    else process.env.MORPHEUS_RUNTIME_CONFIG_JSON = previousRuntimeConfig;
    if (previousNitroApiUrl === undefined) delete process.env.NITRO_API_URL;
    else process.env.NITRO_API_URL = previousNitroApiUrl;
  }
});

test('buildFeedSyncPayload does not forward target-chain signer material to the worker runtime', () => {
  const config = {
    network: 'mainnet',
    feedSync: {
      symbols: ['NEO-USD'],
      projectSlug: 'feeds_price',
      changeThresholdBps: 50,
      minUpdateIntervalMs: 30000,
      provider: 'twelvedata',
    },
    neo_n3: {
      custodyKeyIds: { updater: 'TEST_PLACEHOLDER_KEY_ID' },
    },
  };

  const neoN3Payload = buildFeedSyncPayload(config, 'neo_n3');
  assert.equal(neoN3Payload.target_chain, 'neo_n3');
  assert.equal(neoN3Payload.network, 'mainnet');
  assert.equal(neoN3Payload.provider, 'twelvedata');
  assert.equal('wif' in neoN3Payload, false);
  assert.equal('private_key' in neoN3Payload, false);
});

test('encodeUtf8ByteArrayParamValue encodes JSON payloads as base64 utf8', () => {
  const encoded = encodeUtf8ByteArrayParamValue('{"ok":true}');
  assert.equal(Buffer.from(encoded, 'base64').toString('utf8'), '{"ok":true}');
});

test('buildNeoN3EventFromRequestRecord decodes pending miniapp kernel requests', () => {
  const event = buildNeoN3EventFromRequestRecord(
    [
      '4',
      'morpheus.callback.consumer',
      'oracle.fetch',
      'privacy_oracle',
      '{"symbol":"NEO-USD"}',
      '0xrequester',
      '0xsponsor',
      '0xcallback',
      '0',
      '123456',
      '0',
      false,
      '',
      '',
    ],
    4,
    '7b2273796d626f6c223a224e454f2d555344227d'
  );

  assert.deepEqual(event, {
    chain: 'neo_n3',
    requestId: '4',
    requestType: 'privacy_oracle',
    appId: 'morpheus.callback.consumer',
    moduleId: 'oracle.fetch',
    operation: 'privacy_oracle',
    requester: '0xrequester',
    callbackContract: '0xcallback',
    callbackMethod: 'onOracleResult',
    payloadText: '{"symbol":"NEO-USD"}',
    payloadHex: '7b2273796d626f6c223a224e454f2d555344227d',
    createdAtMs: 123456,
    fulfilledAtMs: 0,
    blockNumber: 123456,
    txHash: '',
    logIndex: 0,
  });
});

test('buildNeoN3EventFromRequestRecord skips settled miniapp kernel requests', () => {
  const event = buildNeoN3EventFromRequestRecord(
    [
      '4',
      'morpheus.callback.consumer',
      'oracle.fetch',
      'privacy_oracle',
      '{}',
      '0xrequester',
      '0xsponsor',
      '0xcallback',
      '1',
      '123456',
      '123999',
      true,
      '{}',
      '',
    ],
    4,
    '7b7d'
  );

  assert.equal(event, null);
});

test('assertNeoN3HaltExecution rejects faulted fulfillment transactions', () => {
  assert.throws(
    () =>
      assertNeoN3HaltExecution('4', '0xfault', {
        vmstate: 'FAULT',
        exception: 'ABORTMSG is executed. Reason: request already fulfilled',
      }),
    /request already fulfilled/
  );
});

test('decodeNeoItem converts 20-byte base64 notifications into hash160', () => {
  const littleEndianHashBytes = Buffer.from(
    '6d0656f6dd91469db1c90cc1e574380613f43738',
    'hex'
  ).reverse();
  const decoded = decodeNeoItem({
    type: 'ByteString',
    value: littleEndianHashBytes.toString('base64'),
  });
  assert.equal(decoded, '0x6d0656f6dd91469db1c90cc1e574380613f43738');
});

test('buildNeoN3RelayRequestId keeps the chain request id while making relay attempts unique', () => {
  const a = buildNeoN3RelayRequestId('fulfill', '3836');
  const b = buildNeoN3RelayRequestId('fulfill', '3836');
  assert.match(a, /^relayer:n3:fulfill:3836:/);
  assert.match(b, /^relayer:n3:fulfill:3836:/);
  assert.notEqual(a, b);
});

test('decodeNeoItem keeps printable 20-byte byte strings as text', () => {
  const decoded = decodeNeoItem({
    type: 'ByteString',
    value: Buffer.from('neodid_action_ticket', 'utf8').toString('base64'),
  });
  assert.equal(decoded, 'neodid_action_ticket');
});

test('decodeNeoItem decodes Neo VM structs recursively', () => {
  const decoded = decodeNeoItem({
    type: 'Struct',
    value: [
      { type: 'Integer', value: '150' },
      { type: 'ByteString', value: Buffer.from('compute', 'utf8').toString('base64') },
      { type: 'Boolean', value: true },
    ],
  });

  assert.deepEqual(decoded, ['150', 'compute', true]);
});

test('decodeNeoItem with a base64 hint decodes hex-look-alike base64 correctly', () => {
  // 'h xh y' base64-encodes to 'aCB4aCB5' — every character is a hex digit and
  // the length is even, so the legacy sniffing heuristic mis-decodes it as hex.
  const payload = 'h xh y';
  const item = { type: 'ByteString', value: Buffer.from(payload, 'utf8').toString('base64') };
  assert.equal(item.value, 'aCB4aCB5');
  assert.equal(decodeNeoItem(item, 'base64'), payload);
  // Without the hint the heuristic still hex-decodes (last-resort behavior for
  // unknown sources) — this documents WHY RPC call sites must pin base64.
  assert.notEqual(decodeNeoItem(item), payload);
});

test('decodeNeoItem propagates the encoding hint through structs', () => {
  const decoded = decodeNeoItem(
    {
      type: 'Struct',
      value: [
        { type: 'ByteString', value: Buffer.from('h xh y', 'utf8').toString('base64') },
        { type: 'Integer', value: '7' },
      ],
    },
    'base64'
  );
  assert.deepEqual(decoded, ['h xh y', '7']);
});

test('decodeNeoItem base64 hint still maps 20-byte values onto hash160', () => {
  const littleEndianHashBytes = Buffer.from(
    '6d0656f6dd91469db1c90cc1e574380613f43738',
    'hex'
  ).reverse();
  const decoded = decodeNeoItem(
    { type: 'ByteString', value: littleEndianHashBytes.toString('base64') },
    'base64'
  );
  assert.equal(decoded, '0x6d0656f6dd91469db1c90cc1e574380613f43738');
});

test('buildOnchainResultEnvelope keeps working when verification is missing', () => {
  const envelope = buildOnchainResultEnvelope('privacy_oracle', {
    ok: true,
    status: 200,
    body: { result: { ok: true } },
  });
  assert.equal(envelope.version, 'morpheus-result/v1');
  assert.equal(envelope.verification, null);
});

test('buildOnchainResultEnvelope keeps automation registration metadata', () => {
  const envelope = buildOnchainResultEnvelope('automation_register', {
    ok: true,
    status: 200,
    body: {
      mode: 'automation',
      action: 'register',
      automation_id: 'automation:neo_n3:test',
      trigger_type: 'interval',
      execution_request_type: 'privacy_oracle',
      status: 'active',
    },
  });
  assert.equal(envelope.result.mode, 'automation');
  assert.equal(envelope.result.action, 'register');
  assert.equal(envelope.result.automation_id, 'automation:neo_n3:test');
});

test('sanitizeForPostgres strips NUL bytes recursively', () => {
  const sanitized = sanitizeForPostgres({
    text: 'ab\u0000cd',
    nested: {
      value: '\u0000hello',
      items: ['x\u0000y', 42, { inner: 'z\u0000' }],
    },
  });

  assert.deepEqual(sanitized, {
    text: 'abcd',
    nested: {
      value: 'hello',
      items: ['xy', 42, { inner: 'z' }],
    },
  });
});

test('resolveChainFromBlock throws on checkpoints ahead of the confirmed tip', () => {
  const state = createEmptyRelayerState();
  state.neo_n3.last_block = 14258261;

  const config = {
    startBlocks: { neo_n3: 8996388 },
  };

  assert.throws(
    () => resolveChainFromBlock(config, state, 'neo_n3', 8996666, null),
    /ahead of the confirmed tip/
  );
  assert.equal(state.neo_n3.last_block, 14258261);
});

test('resolveChainFromBlock throws on invalid checkpoints', () => {
  const state = createEmptyRelayerState();
  state.neo_n3.last_block = 'not-a-number';

  const config = {
    startBlocks: { neo_n3: 8996388 },
  };

  assert.throws(
    () => resolveChainFromBlock(config, state, 'neo_n3', 8997000, null),
    /Invalid relayer checkpoint/
  );
  assert.equal(state.neo_n3.last_block, 'not-a-number');
});

test('resolveChainFromBlock advances from a valid checkpoint', () => {
  const state = createEmptyRelayerState();
  state.neo_n3.last_block = 8996666;

  const config = {
    startBlocks: { neo_n3: 8996388 },
  };

  const fromBlock = resolveChainFromBlock(config, state, 'neo_n3', 8997000, null);
  assert.equal(fromBlock, 8996667);
  assert.equal(state.neo_n3.last_block, 8996666);
});

test('resolveRequestCursor tails the recent request window by default', () => {
  const state = createEmptyRelayerState();
  const config = {
    startRequestIds: { neo_n3: null },
    maxBlocksPerTick: 250,
  };

  const fromRequestId = resolveRequestCursor(config, state, 'neo_n3', 4702, null);
  assert.equal(fromRequestId, 4453);
});

test('resolveRequestCursor resets invalid checkpoints to the recent tail window', () => {
  const state = createEmptyRelayerState();
  state.neo_n3.last_request_id = 999999;
  const config = {
    startRequestIds: { neo_n3: null },
    maxBlocksPerTick: 250,
  };

  const fromRequestId = resolveRequestCursor(config, state, 'neo_n3', 4702, null);
  assert.equal(fromRequestId, 4453);
  assert.equal(state.neo_n3.last_request_id, null);
});

test('getFeedSyncDelayMs uses the most recent feed-sync attempt time', () => {
  const config = {
    feedSync: {
      enabled: true,
      intervalMs: 60000,
    },
  };
  const state = createEmptyRelayerState();
  state.metrics.last_feed_sync_success_at = '2026-03-10T13:00:05.000Z';
  state.metrics.last_feed_sync_completed_at = '2026-03-10T13:00:20.000Z';

  assert.equal(getFeedSyncDelayMs(config, state, Date.parse('2026-03-10T13:00:25.000Z')), 55000);
  assert.equal(getFeedSyncDelayMs(config, state, Date.parse('2026-03-10T13:01:21.000Z')), 0);
});

test('getFeedSyncDelayMs backs off after failed sync attempts without a fresh success', () => {
  const config = {
    feedSync: {
      enabled: true,
      intervalMs: 60000,
    },
  };
  const state = createEmptyRelayerState();
  state.metrics.last_feed_sync_success_at = '2026-03-10T12:55:00.000Z';
  state.metrics.last_feed_sync_completed_at = '2026-03-10T13:00:20.000Z';

  assert.equal(getFeedSyncDelayMs(config, state, Date.parse('2026-03-10T13:00:25.000Z')), 55000);
  assert.equal(getFeedSyncDelayMs(config, state, Date.parse('2026-03-10T13:01:05.000Z')), 15000);
});

test('buildFeedSyncPayload refreshes the on-chain baseline for automatic feed sync', () => {
  const payload = buildFeedSyncPayload(
    {
      network: 'mainnet',
      feedSync: {
        symbols: ['TWELVEDATA:NEO-USD'],
        projectSlug: 'morpheus',
        projectConfigEnabled: false,
        waitForSubmission: false,
        provider: 'twelvedata',
        providers: [],
        changeThresholdBps: '10',
        minUpdateIntervalMs: '60000',
        staleAfterMs: '300000',
      },
    },
    'neo_n3'
  );

  assert.equal(payload.refresh_onchain_baseline, true);
  assert.equal(payload.wait, false);
  assert.equal(payload.project_slug, undefined);
  assert.equal(payload.feed_submission_wait_timeout_ms, undefined);
});

test('shouldPersistRunSnapshot skips idle feed-only ticks', () => {
  const state = createEmptyRelayerState();
  const decision = shouldPersistRunSnapshot(
    {
      mode: 'feed_only',
      runSnapshots: {
        enabled: true,
        intervalMs: 60000,
        errorBackoffMs: 300000,
      },
    },
    {
      state,
      feed_sync: { enabled: true, skipped: true, chains: [] },
      neo_n3: { skipped: true },
      automation: { skipped: true },
    },
    Date.parse('2026-03-10T13:00:00.000Z')
  );

  assert.deepEqual(decision, { persist: false, reason: 'feed_sync_skipped' });
});

test('shouldPersistRunSnapshot persists feed-only ticks that attempt a sync', () => {
  const state = createEmptyRelayerState();
  const decision = shouldPersistRunSnapshot(
    {
      mode: 'feed_only',
      runSnapshots: {
        enabled: true,
        intervalMs: 60000,
        errorBackoffMs: 300000,
      },
    },
    {
      state,
      feed_sync: { enabled: true, skipped: false, chains: [{ ok: true }] },
      neo_n3: { skipped: true },
      automation: { skipped: true },
    },
    Date.parse('2026-03-10T13:00:00.000Z')
  );

  assert.deepEqual(decision, { persist: true, reason: 'activity' });
});

test('shouldPersistRunSnapshot backs off after Supabase persistence errors', () => {
  const state = createEmptyRelayerState();
  state.metrics.last_run_snapshot_error_at = '2026-03-10T13:00:00.000Z';

  const decision = shouldPersistRunSnapshot(
    {
      mode: 'feed_only',
      runSnapshots: {
        enabled: true,
        intervalMs: 60000,
        errorBackoffMs: 300000,
      },
    },
    {
      state,
      feed_sync: { enabled: true, skipped: false, chains: [{ ok: true }] },
      neo_n3: { skipped: true },
      automation: { skipped: true },
    },
    Date.parse('2026-03-10T13:01:00.000Z')
  );

  assert.deepEqual(decision, { persist: false, reason: 'error_backoff' });
});

test('summarizeFeedSyncChainResult exposes skipped publication reasons', () => {
  const summary = summarizeFeedSyncChainResult({
    target_chain: 'neo_n3',
    api_url: 'http://mainnet-feed-worker:8080',
    ok: true,
    status: 200,
    body: {
      network: 'mainnet',
      batch_submitted: false,
      batch_count: 0,
      sync_results: [
        {
          relay_status: 'skipped',
          skip_reason: 'price-change-below-threshold',
        },
        {
          relay_status: 'skipped',
          skip_reason: 'price-change-below-threshold',
        },
      ],
      errors: [],
    },
  });

  assert.deepEqual(summary, {
    target_chain: 'neo_n3',
    api_url: 'http://mainnet-feed-worker:8080',
    network: 'mainnet',
    publication_state: 'skipped',
    batch_submitted: false,
    batch_count: 0,
    submitted_pairs: 0,
    skipped_pairs: 2,
    error_count: 0,
    skipped_reasons: {
      'price-change-below-threshold': 2,
    },
  });
});

test('durable queue persists fresh chain events before checkpoint advancement', async () => {
  const previousUrl = process.env.SUPABASE_URL;
  const previousKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const originalFetch = global.fetch;
  const inserted = [];

  process.env.SUPABASE_URL = 'https://supabase.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
  global.fetch = async (url, options = {}) => {
    assert.match(String(url), /morpheus_relayer_jobs/);
    assert.equal(options.method, 'POST');
    inserted.push(JSON.parse(String(options.body)));
    return new Response('', { status: 201 });
  };

  try {
    await persistFreshEventsToDurableQueue(
      {
        network: 'testnet',
        concurrency: 2,
        durableQueue: { enabled: true, failClosed: true },
      },
      { warn() {}, info() {} },
      'neo_n3',
      [
        { chain: 'neo_n3', requestId: '101', requestType: 'privacy_oracle', txHash: '0xaaa' },
        { chain: 'neo_n3', requestId: '102', requestType: 'privacy_oracle', txHash: '0xbbb' },
      ]
    );
  } finally {
    global.fetch = originalFetch;
    if (previousUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = previousUrl;
    if (previousKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = previousKey;
  }

  assert.equal(inserted.length, 2);
  assert.equal(inserted[0].status, 'queued');
  assert.equal(inserted[1].status, 'queued');
  assert.equal(inserted[0].request_id, '101');
  assert.equal(inserted[1].request_id, '102');
});

test('durable queue hydrates queued and stale processing jobs back into retry queue', async () => {
  const previousUrl = process.env.SUPABASE_URL;
  const previousKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const previousHmacSecret = process.env.MORPHEUS_MANUAL_ACTION_HMAC_SECRET;
  const originalFetch = global.fetch;
  const state = createEmptyRelayerState();
  let persisted = 0;

  process.env.SUPABASE_URL = 'https://supabase.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
  process.env.MORPHEUS_MANUAL_ACTION_HMAC_SECRET = DURABLE_HYDRATION_TEST_SECRET;
  global.fetch = async (url) => {
    assert.match(String(url), /morpheus_relayer_jobs/);
    return new Response(
      JSON.stringify(
        signDurableHydrationRows([
          {
            event_key: 'neo_n3:101:0xaaa::',
            chain: 'neo_n3',
            request_id: '101',
            status: 'queued',
            attempts: 0,
            event: {
              chain: 'neo_n3',
              requestId: '101',
              requestType: 'privacy_oracle',
              txHash: '0xaaa',
            },
            updated_at: new Date(Date.now() - 10_000).toISOString(),
          },
          {
            event_key: 'neo_n3:102:0xbbb::',
            chain: 'neo_n3',
            request_id: '102',
            status: 'processing',
            attempts: 2,
            last_error: 'worker timeout',
            event: {
              chain: 'neo_n3',
              requestId: '102',
              requestType: 'privacy_oracle',
              txHash: '0xbbb',
            },
            updated_at: new Date(Date.now() - 10_000).toISOString(),
          },
          {
            event_key: 'neo_n3:103:0xccc::',
            chain: 'neo_n3',
            request_id: '103',
            status: 'retry_scheduled',
            attempts: 1,
            next_retry_at: new Date(Date.now() + 60_000).toISOString(),
            event: {
              chain: 'neo_n3',
              requestId: '103',
              requestType: 'privacy_oracle',
              txHash: '0xccc',
            },
            updated_at: new Date().toISOString(),
          },
        ])
      ),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  };

  try {
    const hydrated = await hydrateDurableQueue(
      {
        network: 'testnet',
        concurrency: 1,
        durableQueue: {
          enabled: true,
          failClosed: true,
          syncLimit: 10,
          staleProcessingMs: 1000,
        },
      },
      state,
      { warn() {}, info() {} },
      'neo_n3',
      () => {
        persisted += 1;
      }
    );
    assert.deepEqual(hydrated.sort(), ['neo_n3:101:0xaaa::', 'neo_n3:102:0xbbb::']);
  } finally {
    global.fetch = originalFetch;
    if (previousUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = previousUrl;
    if (previousKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = previousKey;
    if (previousHmacSecret === undefined) delete process.env.MORPHEUS_MANUAL_ACTION_HMAC_SECRET;
    else process.env.MORPHEUS_MANUAL_ACTION_HMAC_SECRET = previousHmacSecret;
  }

  assert.equal(state.neo_n3.retry_queue.length, 2);
  assert.ok(state.neo_n3.retry_queue.some((item) => String(item.event.requestId) === '101'));
  assert.ok(state.neo_n3.retry_queue.some((item) => String(item.event.requestId) === '102'));
  assert.equal(persisted, 1);
});

test('durable queue hydrates prepared callback delivery without losing fulfillment payload', async () => {
  const previousUrl = process.env.SUPABASE_URL;
  const previousKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const previousHmacSecret = process.env.MORPHEUS_MANUAL_ACTION_HMAC_SECRET;
  const originalFetch = global.fetch;
  const state = createEmptyRelayerState();
  const preparedFulfillment = {
    success: true,
    result: '{"answer":42}',
    error: '',
    result_bytes_base64: '',
    route: '/oracle/fetch',
    module_id: 'oracle.fetch',
    operation: 'privacy_oracle',
    worker_status: 200,
    verification_signature: 'signed-result',
  };

  process.env.SUPABASE_URL = 'https://supabase.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
  process.env.MORPHEUS_MANUAL_ACTION_HMAC_SECRET = DURABLE_HYDRATION_TEST_SECRET;
  global.fetch = async (url) => {
    assert.match(String(url), /morpheus_relayer_jobs/);
    return new Response(
      JSON.stringify(
        signDurableHydrationRows([
          {
            event_key: 'neo_n3:104:0xddd::',
            chain: 'neo_n3',
            request_id: '104',
            status: 'callback_pending',
            attempts: 1,
            event: {
              chain: 'neo_n3',
              requestId: '104',
              requestType: 'privacy_oracle',
              txHash: '0xddd',
            },
            worker_response: {
              retry_meta: {
                prepared_fulfillment: preparedFulfillment,
              },
            },
            updated_at: new Date(Date.now() - 10_000).toISOString(),
          },
        ])
      ),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  };

  try {
    const hydrated = await hydrateDurableQueue(
      {
        network: 'testnet',
        concurrency: 1,
        durableQueue: {
          enabled: true,
          failClosed: true,
          syncLimit: 10,
          staleProcessingMs: 1000,
        },
      },
      state,
      { warn() {}, info() {} },
      'neo_n3',
      () => {}
    );
    assert.deepEqual(hydrated, ['neo_n3:104:0xddd::']);
  } finally {
    global.fetch = originalFetch;
    if (previousUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = previousUrl;
    if (previousKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = previousKey;
    if (previousHmacSecret === undefined) delete process.env.MORPHEUS_MANUAL_ACTION_HMAC_SECRET;
    else process.env.MORPHEUS_MANUAL_ACTION_HMAC_SECRET = previousHmacSecret;
  }

  assert.equal(state.neo_n3.retry_queue.length, 1);
  assert.deepEqual(state.neo_n3.retry_queue[0].prepared_fulfillment, preparedFulfillment);
});

test('processEvent retains the event when Supabase durable claim is temporarily unavailable', async () => {
  const previousAllowUnpinned = process.env.MORPHEUS_ALLOW_UNPINNED_SIGNERS;
  const previousRelayerWif = process.env.MORPHEUS_RELAYER_NEO_N3_WIF;
  const previousSupabaseUrl = process.env.SUPABASE_URL;
  const previousSupabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const originalFetch = global.fetch;
  const signer = new wallet.Account(wallet.generatePrivateKey());
  const state = createEmptyRelayerState();
  const event = {
    chain: 'neo_n3',
    requestId: '106',
    requestType: 'privacy_oracle',
    txHash: '0xfff',
    payloadText: JSON.stringify({ url: 'https://prices.test/neo' }),
  };
  let callbackInvoked = false;

  process.env.MORPHEUS_ALLOW_UNPINNED_SIGNERS = 'true';
  process.env.MORPHEUS_RELAYER_NEO_N3_WIF = signer.WIF;
  process.env.SUPABASE_URL = 'https://supabase.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';

  global.fetch = async (url) => {
    const value = String(url);
    if (value.startsWith('https://supabase.test/rest/v1/morpheus_relayer_jobs')) {
      return new Response(
        JSON.stringify({
          code: 'PGRST002',
          message: 'Could not query the database for the schema cache. Retrying.',
        }),
        { status: 503, headers: { 'content-type': 'application/json' } }
      );
    }
    if (value === 'https://nitro.test/oracle/smart-fetch') {
      return new Response(JSON.stringify({ price: '42.10', source: 'test' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected fetch ${value}`);
  };

  try {
    const result = await processEvent(
      {
        ...retryConfig,
        network: 'testnet',
        durableQueue: { enabled: true, failClosed: true, syncLimit: 10, staleProcessingMs: 1000 },
        nitro: { apiUrl: 'https://nitro.test', token: 'runtime-token' },
        hooks: {
          fulfillNeoRequest: async () => {
            callbackInvoked = true;
            return {
              request_id: 'relayer:n3:fulfill:106:test',
              tx_hash: '0xfulfilled',
              vm_state: 'HALT',
              target_chain: 'neo_n3',
            };
          },
        },
      },
      state,
      () => saveRelayerState(path.join(os.tmpdir(), `morpheus-state-${Date.now()}.json`), state),
      { info() {}, warn() {}, error() {} },
      event
    );

    assert.equal(result.skipped, true);
    assert.equal(result.retry_status, 'unavailable');
    assert.equal(callbackInvoked, false);
    assert.equal(state.neo_n3.retry_queue.length, 1);
    assert.equal(state.neo_n3.retry_queue[0].last_error, 'durable_claim_unavailable');
    assert.equal(state.neo_n3.processed_records[buildEventKey(event)], undefined);
  } finally {
    global.fetch = originalFetch;
    if (previousAllowUnpinned === undefined) delete process.env.MORPHEUS_ALLOW_UNPINNED_SIGNERS;
    else process.env.MORPHEUS_ALLOW_UNPINNED_SIGNERS = previousAllowUnpinned;
    if (previousRelayerWif === undefined) delete process.env.MORPHEUS_RELAYER_NEO_N3_WIF;
    else process.env.MORPHEUS_RELAYER_NEO_N3_WIF = previousRelayerWif;
    if (previousSupabaseUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = previousSupabaseUrl;
    if (previousSupabaseKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = previousSupabaseKey;
    // The simulated Supabase 503/PGRST002 now arms a short connectivity backoff
    // (B11); clear it so it does not leak into later tests.
    resetSupabasePersistenceBackoffForTests();
  }
});

test('processEvent redelivers prepared fulfillment without re-running the worker', async () => {
  const state = createEmptyRelayerState();
  const event = {
    chain: 'neo_n3',
    requestId: '105',
    requestType: 'privacy_oracle',
    txHash: '0xeee',
    payloadText: '{"symbol":"NEO-USD"}',
    payloadHex: '7b2273796d626f6c223a224e454f2d555344227d',
  };
  const preparedFulfillment = {
    success: true,
    result: '{"answer":42}',
    error: '',
    result_bytes_base64: '',
    route: '/oracle/fetch',
    module_id: 'oracle.fetch',
    operation: 'privacy_oracle',
    worker_status: 200,
    verification_signature: 'signed-result',
  };
  const fulfillCalls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    throw new Error(`unexpected worker or network call: ${url}`);
  };

  try {
    const result = await processEvent(
      {
        ...retryConfig,
        network: 'testnet',
        durableQueue: { enabled: false },
        hooks: {
          fulfillNeoRequest: async (call) => {
            fulfillCalls.push(call);
            return {
              request_id: 'relayer:n3:fulfill:105:test',
              tx_hash: '0xfulfilled',
              vm_state: 'HALT',
              target_chain: 'neo_n3',
            };
          },
        },
      },
      state,
      () => {},
      { info() {}, warn() {}, error() {} },
      event,
      {
        attempts: 2,
        prepared_fulfillment: preparedFulfillment,
        durable_claimed: true,
      }
    );

    assert.equal(result.result.fulfill_tx.tx_hash, '0xfulfilled');
    assert.equal(fulfillCalls.length, 1);
    assert.equal(fulfillCalls[0].requestId, '105');
    assert.equal(fulfillCalls[0].fulfillment.result, '{"answer":42}');
    assert.equal(fulfillCalls[0].verification.signature, 'signed-result');
    assert.equal(state.neo_n3.processed_records[result.event_key].status, 'fulfilled');
  } finally {
    global.fetch = originalFetch;
  }
});

test('durable queue ignores jobs older than configured request cursor floor', async () => {
  const previousUrl = process.env.SUPABASE_URL;
  const previousKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const previousHmacSecret = process.env.MORPHEUS_MANUAL_ACTION_HMAC_SECRET;
  const originalFetch = global.fetch;
  const state = createEmptyRelayerState();

  process.env.SUPABASE_URL = 'https://supabase.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
  process.env.MORPHEUS_MANUAL_ACTION_HMAC_SECRET = DURABLE_HYDRATION_TEST_SECRET;
  global.fetch = async () =>
    new Response(
      JSON.stringify(
        signDurableHydrationRows([
          {
            event_key: 'neo_n3:3999:0xaaa::',
            chain: 'neo_n3',
            request_id: '3999',
            status: 'queued',
            attempts: 0,
            event: {
              chain: 'neo_n3',
              requestId: '3999',
              requestType: 'privacy_oracle',
              txHash: '0xaaa',
            },
            updated_at: new Date().toISOString(),
          },
          {
            event_key: 'neo_n3:4050:0xbbb::',
            chain: 'neo_n3',
            request_id: '4050',
            status: 'queued',
            attempts: 0,
            event: {
              chain: 'neo_n3',
              requestId: '4050',
              requestType: 'privacy_oracle',
              txHash: '0xbbb',
            },
            updated_at: new Date().toISOString(),
          },
        ])
      ),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );

  try {
    const hydrated = await hydrateDurableQueue(
      {
        network: 'testnet',
        startRequestIds: { neo_n3: 4050 },
        durableQueue: { enabled: true, failClosed: true, syncLimit: 10, staleProcessingMs: 1000 },
      },
      state,
      { warn() {}, info() {} },
      'neo_n3',
      () => {}
    );
    assert.deepEqual(hydrated, ['neo_n3:4050:0xbbb::']);
  } finally {
    global.fetch = originalFetch;
    if (previousUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = previousUrl;
    if (previousKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = previousKey;
    if (previousHmacSecret === undefined) delete process.env.MORPHEUS_MANUAL_ACTION_HMAC_SECRET;
    else process.env.MORPHEUS_MANUAL_ACTION_HMAC_SECRET = previousHmacSecret;
  }

  assert.equal(state.neo_n3.retry_queue.length, 1);
  assert.equal(String(state.neo_n3.retry_queue[0].event.requestId), '4050');
});

test('request cursor floor prunes legacy local retry queue entries', () => {
  const state = createEmptyRelayerState();

  state.neo_n3.retry_queue.push(
    {
      key: 'neo_n3:3999:0xaaa::',
      event: { chain: 'neo_n3', requestId: '3999', requestType: 'privacy_oracle', txHash: '0xaaa' },
      attempts: 1,
      next_retry_at: Date.now(),
    },
    {
      key: 'neo_n3:4050:0xbbb::',
      event: { chain: 'neo_n3', requestId: '4050', requestType: 'privacy_oracle', txHash: '0xbbb' },
      attempts: 1,
      next_retry_at: Date.now(),
    }
  );

  const floor = getRequestCursorFloor({ startRequestIds: { neo_n3: 4050 } }, 'neo_n3');
  const pruned = pruneRetryQueueBelowRequestFloor(state, 'neo_n3', floor);
  assert.equal(pruned, 1);
  assert.equal(state.neo_n3.retry_queue.length, 1);
  assert.equal(String(state.neo_n3.retry_queue[0].event.requestId), '4050');
});

test('request cursor floor quarantines durable jobs below the floor', async () => {
  const previousUrl = process.env.SUPABASE_URL;
  const previousKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const originalFetch = global.fetch;
  const calls = [];

  process.env.SUPABASE_URL = 'https://supabase.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
  global.fetch = async (url, options = {}) => {
    const value = String(url);
    if (!options.method || options.method === 'GET') {
      return new Response(
        JSON.stringify([
          {
            event_key: 'neo_n3:3999:0xaaa::',
            request_id: '3999',
            status: 'retry_scheduled',
            last_error: 'legacy',
            chain: 'neo_n3',
          },
          {
            event_key: 'neo_n3:4050:0xbbb::',
            request_id: '4050',
            status: 'retry_scheduled',
            last_error: 'current',
            chain: 'neo_n3',
          },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    calls.push({ url: value, body: JSON.parse(String(options.body || '{}')) });
    return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    const patched = await quarantineDurableBacklogBelowRequestFloor(
      {
        network: 'testnet',
        startRequestIds: { neo_n3: 4050 },
        durableQueue: { enabled: true, failClosed: true },
      },
      { warn() {}, info() {} },
      'neo_n3'
    );
    assert.equal(patched, 1);
  } finally {
    global.fetch = originalFetch;
    if (previousUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = previousUrl;
    if (previousKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = previousKey;
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.status, 'stale_quarantined');
});

test('claimRelayerJob returns null when another instance already claimed the row', async () => {
  const previousUrl = process.env.SUPABASE_URL;
  const previousKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const originalFetch = global.fetch;
  let calls = 0;

  process.env.SUPABASE_URL = 'https://supabase.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
  global.fetch = async (url, options = {}) => {
    calls += 1;
    assert.match(String(url), /morpheus_relayer_jobs/);
    assert.equal(options.method, 'PATCH');
    return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    const result = await claimRelayerJob(
      'neo_n3:101:0xaaa::',
      { status: 'processing', attempts: 0 },
      {
        readyStatuses: ['queued'],
        staleStatuses: ['processing'],
        staleBeforeIso: new Date().toISOString(),
      }
    );
    assert.equal(result, null);
  } finally {
    global.fetch = originalFetch;
    if (previousUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = previousUrl;
    if (previousKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = previousKey;
  }

  assert.equal(calls, 1);
});

test('relayer mode helpers isolate pricefeed from request-processing loops', () => {
  assert.equal(shouldRunFeedSync({ mode: 'combined' }), true);
  assert.equal(shouldRunFeedSync({ mode: 'feed_only' }), true);
  assert.equal(shouldRunFeedSync({ mode: 'requests_only' }), false);
  assert.equal(shouldRunRequestProcessing({ mode: 'combined' }), true);
  assert.equal(shouldRunRequestProcessing({ mode: 'feed_only' }), false);
  assert.equal(shouldRunRequestProcessing({ mode: 'requests_only' }), true);
});

test('createRelayerConfig falls back to defaults (not NaN) for mistyped numeric envs', () => {
  const keys = [
    'MORPHEUS_RELAYER_POLL_INTERVAL_MS',
    'MORPHEUS_RELAYER_MAX_RETRIES',
    'MORPHEUS_RELAYER_CONCURRENCY',
    'MORPHEUS_RELAYER_MAX_BLOCKS_PER_TICK',
  ];
  const saved = new Map(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) process.env[k] = 'not-a-number';
  try {
    const config = withIsolatedRelayerSigner(() => createRelayerConfig());
    // A mistyped numeric env must not become NaN (which would defeat Math.max
    // floors and, for pollIntervalMs, spin the scan loop via setTimeout(…, 0)).
    assert.equal(config.pollIntervalMs, 5000);
    assert.ok(Number.isFinite(config.maxRetries), 'maxRetries finite');
    assert.ok(Number.isFinite(config.concurrency) && config.concurrency >= 1, 'concurrency finite');
    assert.ok(
      Number.isFinite(config.maxBlocksPerTick) && config.maxBlocksPerTick >= 1,
      'maxBlocksPerTick finite'
    );
  } finally {
    for (const [k, v] of saved.entries()) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
