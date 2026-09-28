import test from 'node:test';
import assert from 'node:assert/strict';
import { sc, wallet } from '@cityofzion/neon-js';

import { processAutomationJobs } from './automation.js';
import {
  buildNeoN3AutomationQueueInvocation,
  neoN3KernelSupportsAutomationExecution,
  queueNeoN3AutomationRequest,
} from './neo-n3.js';

// R-01: the kernel generation that stops the updater from charging an unconsenting
// requester adds queueAutomationExecution(registrationRequestId, requester, requestType,
// payload). These tests pin how the relayer picks that lane, what it sends, and how it
// treats the kernel's consent reverts.

const ORACLE = '0xf54d8584ef82315c1800373272ab08ae0db2d5ef';
const REQUESTER = '0x0c3146e78efc42bfb7d4cc2e06e3efd063c01c56';
const CALLBACK = '0x8c506f224d82e67200f20d9d5361f767f0756e3b';

const EXECUTION_LANE_MANIFEST = {
  abi: {
    methods: [
      { name: 'queueAutomationRequest', parameters: [{}, {}, {}, {}, {}] },
      { name: 'queueAutomationExecution', parameters: [{}, {}, {}, {}] },
    ],
  },
};
const LEGACY_MANIFEST = {
  abi: { methods: [{ name: 'queueAutomationRequest', parameters: [{}, {}, {}, {}, {}] }] },
};

function relayerConfig() {
  return {
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
      oracleContract: ORACLE,
      custodyKeyIds: { updater: 'key-updater' },
    },
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// Stubs the Neo RPC and the custody service for one queue call and records the RPC
// methods and the test-invoked script.
function stubChain({ manifest, rpcCalls }) {
  const signer = new wallet.Account('2'.repeat(64));
  return async (url, init = {}) => {
    const href = String(url);
    if (href.startsWith('https://custody.test/signer/api/v1/keys/key-updater')) {
      return json({
        key_id: 'key-updater',
        label: 'updater',
        network: 'mainnet',
        network_magic: 860833102,
        public_key: signer.publicKey,
        script_hash: `0x${signer.scriptHash}`,
        address: signer.address,
        verification_script: `0c21${signer.publicKey}4156e7b327`,
        signing_enabled: true,
      });
    }
    if (href === 'https://custody.test/signer/api/v1/sign/transaction') {
      return json({
        allowed: true,
        key_id: 'key-updater',
        script_hash: `0x${signer.scriptHash}`,
        address: signer.address,
        digest: 'd'.repeat(64),
        invocation_script: `0c40${'1'.repeat(128)}`,
        verification_script: `0c21${signer.publicKey}4156e7b327`,
      });
    }
    const body = JSON.parse(String(init.body || '{}'));
    rpcCalls.push({ method: body.method, params: body.params });
    switch (body.method) {
      case 'getcontractstate':
        return json({ jsonrpc: '2.0', id: 1, result: { hash: ORACLE, manifest } });
      case 'getblockcount':
        return json({ jsonrpc: '2.0', id: 1, result: 1000 });
      case 'invokescript':
        return json({ jsonrpc: '2.0', id: 1, result: { state: 'HALT', gasconsumed: '1000000' } });
      case 'calculatenetworkfee':
        return json({ jsonrpc: '2.0', id: 1, result: { networkfee: '100000' } });
      case 'sendrawtransaction':
        return json({ jsonrpc: '2.0', id: 1, result: true });
      case 'getapplicationlog':
        return json({ jsonrpc: '2.0', id: 1, result: { executions: [{ vmstate: 'HALT' }] } });
      default:
        throw new Error(`unexpected RPC ${body.method}`);
    }
  };
}

function testInvokedScriptHex(rpcCalls) {
  const call = rpcCalls.find((entry) => entry.method === 'invokescript');
  assert.ok(call, 'the queue must test-invoke its script');
  return Buffer.from(call.params[0], 'base64').toString('hex');
}

function asciiHex(text) {
  return Buffer.from(text, 'utf8').toString('hex');
}

test('buildNeoN3AutomationQueueInvocation ties an execution to the job registration and owner', () => {
  const invocation = buildNeoN3AutomationQueueInvocation({
    supportsExecutionLane: true,
    registrationRequestId: '57',
    requester: REQUESTER,
    requestType: 'privacy_oracle',
    payloadText: '{"a":1}',
    callbackContract: CALLBACK,
    callbackMethod: 'onOracleResult',
  });

  assert.equal(invocation.operation, 'queueAutomationExecution');
  assert.deepEqual(
    invocation.args.map((arg) => arg.toJson()),
    [
      sc.ContractParam.integer('57').toJson(),
      sc.ContractParam.hash160(REQUESTER).toJson(),
      sc.ContractParam.string('privacy_oracle').toJson(),
      sc.ContractParam.byteArray(Buffer.from('{"a":1}').toString('base64')).toJson(),
    ]
  );
});

test('buildNeoN3AutomationQueueInvocation keeps the legacy lane without a registration or on an old kernel', () => {
  for (const input of [
    { supportsExecutionLane: false, registrationRequestId: '57' },
    { supportsExecutionLane: true, registrationRequestId: '' },
    { supportsExecutionLane: true, registrationRequestId: 'not-a-request-id' },
  ]) {
    const invocation = buildNeoN3AutomationQueueInvocation({
      ...input,
      requester: REQUESTER,
      requestType: 'privacy_oracle',
      payloadText: '{}',
      callbackContract: CALLBACK,
      callbackMethod: 'onOracleResult',
    });
    assert.equal(invocation.operation, 'queueAutomationRequest', JSON.stringify(input));
    assert.equal(invocation.args.length, 5);
    assert.deepEqual(invocation.args[0].toJson(), sc.ContractParam.hash160(REQUESTER).toJson());
    assert.deepEqual(invocation.args[3].toJson(), sc.ContractParam.hash160(CALLBACK).toJson());
  }
});

test('neoN3KernelSupportsAutomationExecution reads the deployed ABI and fails closed', async () => {
  const originalFetch = global.fetch;
  try {
    for (const [manifest, expected] of [
      [EXECUTION_LANE_MANIFEST, true],
      [LEGACY_MANIFEST, false],
    ]) {
      const rpcCalls = [];
      global.fetch = stubChain({ manifest, rpcCalls });
      assert.equal(await neoN3KernelSupportsAutomationExecution(relayerConfig()), expected);
      assert.deepEqual(rpcCalls, [{ method: 'getcontractstate', params: [ORACLE] }]);
    }

    global.fetch = stubChain({ manifest: undefined, rpcCalls: [] });
    await assert.rejects(neoN3KernelSupportsAutomationExecution(relayerConfig()), /no ABI/);

    global.fetch = async () => json({ jsonrpc: '2.0', id: 1, error: { message: 'boom' } }, 500);
    await assert.rejects(neoN3KernelSupportsAutomationExecution(relayerConfig()));
  } finally {
    global.fetch = originalFetch;
  }
});

test('queueNeoN3AutomationRequest queues through the execution lane on an upgraded kernel', async () => {
  const originalFetch = global.fetch;
  const rpcCalls = [];
  try {
    global.fetch = stubChain({ manifest: EXECUTION_LANE_MANIFEST, rpcCalls });
    const queued = await queueNeoN3AutomationRequest(
      relayerConfig(),
      REQUESTER,
      'privacy_oracle',
      '{}',
      CALLBACK,
      'onOracleResult',
      'automation:neo_n3:job:1',
      '57'
    );

    assert.equal(queued.queue_method, 'queueAutomationExecution');
    assert.equal(queued.request_id, 'automation:neo_n3:job:1');
    assert.equal(rpcCalls[0].method, 'getcontractstate');
    const scriptHex = testInvokedScriptHex(rpcCalls);
    assert.ok(scriptHex.includes(asciiHex('queueAutomationExecution')));
    assert.ok(!scriptHex.includes(asciiHex('queueAutomationRequest')));
  } finally {
    global.fetch = originalFetch;
  }
});

test('queueNeoN3AutomationRequest stays on the legacy lane for an old kernel or a job without a registration', async () => {
  const originalFetch = global.fetch;
  try {
    const oldKernelCalls = [];
    global.fetch = stubChain({ manifest: LEGACY_MANIFEST, rpcCalls: oldKernelCalls });
    const onOldKernel = await queueNeoN3AutomationRequest(
      relayerConfig(),
      REQUESTER,
      'privacy_oracle',
      '{}',
      CALLBACK,
      'onOracleResult',
      'automation:neo_n3:job:1',
      '57'
    );
    assert.equal(onOldKernel.queue_method, 'queueAutomationRequest');
    assert.ok(testInvokedScriptHex(oldKernelCalls).includes(asciiHex('queueAutomationRequest')));

    // No registration id: the ABI is not read at all.
    const noRegistrationCalls = [];
    global.fetch = stubChain({ manifest: EXECUTION_LANE_MANIFEST, rpcCalls: noRegistrationCalls });
    const withoutRegistration = await queueNeoN3AutomationRequest(
      relayerConfig(),
      REQUESTER,
      'privacy_oracle',
      '{}',
      CALLBACK,
      'onOracleResult',
      'automation:neo_n3:job:1'
    );
    assert.equal(withoutRegistration.queue_method, 'queueAutomationRequest');
    assert.ok(!noRegistrationCalls.some((entry) => entry.method === 'getcontractstate'));
  } finally {
    global.fetch = originalFetch;
  }
});

function dueJob(overrides = {}) {
  return {
    automation_id: 'automation:neo_n3:owned',
    registration_request_id: '57',
    status: 'active',
    chain: 'neo_n3',
    requester: REQUESTER,
    callback_contract: CALLBACK,
    callback_method: 'onOracleResult',
    execution_request_type: 'privacy_oracle',
    execution_payload: { provider: 'twelvedata' },
    trigger_type: 'one_shot',
    trigger_config: { execute_at: new Date(0).toISOString() },
    next_run_at: new Date(0).toISOString(),
    execution_count: 0,
    max_executions: 1,
    ...overrides,
  };
}

const AUTOMATION_CONFIG = {
  automation: {
    enabled: true,
    batchSize: 10,
    maxQueuedPerTick: 10,
    defaultPriceCooldownMs: 60000,
  },
};

test('processAutomationJobs hands the job registration id to the queue', async () => {
  const queueCalls = [];
  const result = await processAutomationJobs(
    AUTOMATION_CONFIG,
    { info() {}, warn() {} },
    {
      fetchActiveAutomationJobs: async () => [dueJob()],
      claimAutomationJob: async (automationId) => ({
        automation_id: automationId,
        status: 'processing',
      }),
      queueNeoN3AutomationRequest: async (...args) => {
        queueCalls.push(args);
        return { tx_hash: '0xabc', request_id: args[6], target_chain: 'neo_n3' };
      },
      patchAutomationJob: async () => {},
      insertAutomationRun: async () => {},
    }
  );

  assert.equal(result.queued, 1);
  assert.equal(queueCalls.length, 1);
  assert.equal(queueCalls[0][1], REQUESTER);
  assert.equal(queueCalls[0][7], '57');
});

for (const reason of [
  'requester witness required',
  'automation spend not approved',
  'automation spend approval expired',
  'automation spend cap exceeded',
  'automation requester mismatch',
]) {
  test(`processAutomationJobs parks the job when the kernel reverts "${reason}"`, async () => {
    const patchedJobs = [];
    const insertedRuns = [];
    const message = `Neo N3 automation queue test invoke faulted for ${REQUESTER}: ABORTMSG is executed. Reason: ${reason}`;
    const result = await processAutomationJobs(
      AUTOMATION_CONFIG,
      { info() {}, warn() {} },
      {
        fetchActiveAutomationJobs: async () => [dueJob()],
        claimAutomationJob: async (automationId) => ({
          automation_id: automationId,
          status: 'processing',
        }),
        queueNeoN3AutomationRequest: async () => {
          throw new Error(message);
        },
        patchAutomationJob: async (automationId, fields) => {
          patchedJobs.push({ automationId, fields });
        },
        insertAutomationRun: async (record) => {
          insertedRuns.push(record);
        },
      }
    );

    assert.deepEqual(result, { queued: 0, skipped: 0, failed: 1, inspected: 1 });
    // Terminal: retrying every tick cannot succeed until the owner approves or the app
    // sponsors, so the job leaves the schedule instead of sitting in the reclaim lane.
    assert.deepEqual(patchedJobs, [
      {
        automationId: 'automation:neo_n3:owned',
        fields: { status: 'error', next_run_at: null, last_error: message },
      },
    ]);
    assert.equal(insertedRuns.length, 1);
    assert.equal(insertedRuns[0].status, 'failed');
  });
}
