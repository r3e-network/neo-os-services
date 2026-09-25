import test from 'node:test';
import assert from 'node:assert/strict';
import { wallet as neonWallet } from '@cityofzion/neon-js';

import {
  buildSignAndBroadcastNeoN3Tx,
  confirmNeoN3FulfillExecution,
  scanNeoN3OracleRequests,
  scanNeoN3OracleRequestsById,
} from './neo-n3.js';
import { classifyError } from './fulfillment.js';

// Deterministic throwaway test key (not used anywhere live).
const TEST_PK = '59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const TEST_SCRIPT = '51';

const baseConfig = {
  neo_n3: {
    rpcUrl: 'https://neo-rpc.test',
    networkMagic: 894710606,
  },
};

function stubNeoRpc(handlers, calls) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ method: body.method, params: body.params });
    const handler = handlers[body.method];
    if (!handler) throw new Error(`unexpected RPC method ${body.method}`);
    const result = typeof handler === 'function' ? handler(body.params) : handler;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result }),
    };
  };
}

test('buildSignAndBroadcastNeoN3Tx builds, fees, double-signs, and broadcasts a local-signer tx', async () => {
  const account = new neonWallet.Account(TEST_PK);
  const calls = [];
  let signCalls = 0;
  const originalFetch = global.fetch;
  try {
    global.fetch = stubNeoRpc(
      {
        getblockcount: 100,
        invokescript: { state: 'HALT', gasconsumed: '1000000' },
        calculatenetworkfee: { networkfee: '345000' },
        sendrawtransaction: { hash: '0xabc' },
      },
      calls
    );

    const { txHash, signedBase64, transaction } = await buildSignAndBroadcastNeoN3Tx(
      baseConfig,
      TEST_SCRIPT,
      {
        scriptHash: account.scriptHash,
        sign: (tx) => {
          signCalls += 1;
          tx.witnesses = [];
          tx.sign(account, baseConfig.neo_n3.networkMagic);
        },
      },
      { label: 'Neo N3 test transfer' }
    );

    assert.match(txHash, /^0x[0-9a-f]{64}$/);
    assert.equal(transaction.validUntilBlock, 220);
    // systemFee = gasconsumed + 0.001 GAS padding (no headroom by default).
    assert.equal(transaction.systemFee.toString(), '1100000');
    // networkFee = calculatenetworkfee + 0.001 GAS padding.
    assert.equal(transaction.networkFee.toString(), '445000');
    // Signed once for fee sizing, once for the final witness.
    assert.equal(signCalls, 2);
    assert.deepEqual(
      calls.map((entry) => entry.method),
      ['getblockcount', 'invokescript', 'calculatenetworkfee', 'sendrawtransaction']
    );
    // R2-1.2: this single getblockcount also pins the removal of the redundant pre-flight
    // health probe from fulfillNeoN3Request (Round-1 change b7642ba). buildSignAndBroadcastNeoN3Tx
    // is the actual submit path that probe used to pre-empt; asserting exactly one getblockcount
    // here means a re-added probe would surface as a second entry. fulfillNeoN3Request itself
    // (custody updater + this submit path) is covered end-to-end in relayer.test.mjs via the
    // mocked custody signer service + Neo RPC fetch stubs.
    assert.deepEqual(calls[3].params, [signedBase64]);
  } finally {
    global.fetch = originalFetch;
  }
});

test('buildSignAndBroadcastNeoN3Tx applies system-fee headroom and runs the fee-balance hook before the final sign', async () => {
  const account = new neonWallet.Account(TEST_PK);
  const calls = [];
  const feeBalanceCalls = [];
  let signCalls = 0;
  let verifyWitnessCalls = 0;
  const originalFetch = global.fetch;
  try {
    global.fetch = stubNeoRpc(
      {
        getblockcount: 100,
        invokescript: { state: 'HALT', gasconsumed: '1000000' },
        calculatenetworkfee: { networkfee: '345000' },
        sendrawtransaction: { hash: '0xabc' },
      },
      calls
    );

    const { transaction } = await buildSignAndBroadcastNeoN3Tx(
      baseConfig,
      TEST_SCRIPT,
      {
        scriptHash: account.scriptHash,
        sign: (tx) => {
          signCalls += 1;
          tx.witnesses = [];
          tx.sign(account, baseConfig.neo_n3.networkMagic);
        },
        verifyWitness: () => {
          verifyWitnessCalls += 1;
          assert.equal(signCalls, 2);
        },
      },
      {
        systemFeeHeadroom: true,
        ensureFeeBalance: (requiredFee) => {
          feeBalanceCalls.push({ requiredFee, signCallsAtCheck: signCalls });
        },
        buildTestInvokeFaultError: (exception) => exception || 'unused fault message',
      }
    );

    // systemFee = gasconsumed + 20% headroom + 0.001 GAS padding.
    assert.equal(transaction.systemFee.toString(), '1300000');
    assert.equal(transaction.networkFee.toString(), '445000');
    // The hook sees the full fee bill (system + raw network fee + padding)
    // and runs after the fee-sizing signature but before the final one.
    assert.deepEqual(feeBalanceCalls, [{ requiredFee: 1745000n, signCallsAtCheck: 1 }]);
    assert.equal(signCalls, 2);
    assert.equal(verifyWitnessCalls, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test('buildSignAndBroadcastNeoN3Tx fails closed on a FAULTing test invoke without signing or broadcasting', async () => {
  const account = new neonWallet.Account(TEST_PK);
  const calls = [];
  let signCalls = 0;
  const originalFetch = global.fetch;
  try {
    global.fetch = stubNeoRpc(
      {
        getblockcount: 100,
        invokescript: { state: 'FAULT', exception: 'boom' },
      },
      calls
    );

    await assert.rejects(
      buildSignAndBroadcastNeoN3Tx(
        baseConfig,
        TEST_SCRIPT,
        {
          scriptHash: account.scriptHash,
          sign: () => {
            signCalls += 1;
          },
        },
        { label: 'Neo N3 updater fee top-up' }
      ),
      { message: 'Neo N3 updater fee top-up test invoke faulted: boom' }
    );

    assert.equal(signCalls, 0);
    assert.ok(!calls.some((entry) => entry.method === 'sendrawtransaction'));
  } finally {
    global.fetch = originalFetch;
  }
});

test('buildSignAndBroadcastNeoN3Tx lets call sites shape the FAULT error message', async () => {
  const account = new neonWallet.Account(TEST_PK);
  const originalFetch = global.fetch;
  try {
    global.fetch = stubNeoRpc(
      {
        getblockcount: 100,
        invokescript: { state: 'FAULT', exception: 'request fee not paid' },
      },
      []
    );

    await assert.rejects(
      buildSignAndBroadcastNeoN3Tx(
        baseConfig,
        TEST_SCRIPT,
        { scriptHash: account.scriptHash, sign: () => {} },
        {
          buildTestInvokeFaultError: (exception) =>
            exception || 'Neo N3 automation queue test invoke faulted for 0xrequester',
        }
      ),
      { message: 'request fee not paid' }
    );
  } finally {
    global.fetch = originalFetch;
  }
});

// ===================================================================
// scanNeoN3OracleRequestsById — batched-scan equivalence (OR-W2-04)
// ===================================================================

function byteString(text) {
  return { type: 'ByteString', value: Buffer.from(text, 'utf8').toString('base64') };
}

function integerItem(value) {
  return { type: 'Integer', value: String(value) };
}

// 14-field kernel getRequest record: [id, appId, moduleId, operation, payload,
// requester, sponsor, callbackContract, callbackMethod, createdAtMs,
// fulfilledAtMs, status, resultText, errorText].
function kernelRequestRecord(requestId, { fulfilled = false } = {}) {
  return {
    type: 'Array',
    value: [
      integerItem(requestId),
      byteString('miniapp-os'),
      byteString('oracle.fetch'),
      byteString('privacy_oracle'),
      byteString('{"url":"https://example.test"}'),
      byteString('NScanner1111111111111111111111111'),
      byteString(''),
      byteString('0x0123456789012345678901234567890101234567'),
      byteString('onOracleResult'),
      integerItem(1700000000000),
      integerItem(fulfilled ? 1700000001000 : 0),
      integerItem(fulfilled ? 2 : 1),
      byteString(''),
      byteString(''),
    ],
  };
}

function emptyKernelRequestRecord() {
  return {
    type: 'Array',
    value: Array.from({ length: 14 }, (_, index) =>
      index === 0 || index === 9 || index === 10 ? integerItem(0) : byteString('')
    ),
  };
}

function stubGetRequestRpc(recordsById, calls) {
  return stubNeoRpc(
    {
      invokefunction: (params) => {
        const requestId = Number(params?.[2]?.[0]?.value || 0);
        const entry = recordsById[requestId];
        if (entry === 'FAULT') {
          return { state: 'FAULT', exception: `boom for ${requestId}`, stack: [] };
        }
        return { state: 'HALT', stack: [entry || emptyKernelRequestRecord()] };
      },
    },
    calls
  );
}

const scanConfig = (concurrency) => ({
  concurrency,
  neo_n3: {
    rpcUrl: 'https://neo-rpc.test',
    oracleContract: '0xaabbccddeeff00112233445566778899aabbccdd',
    networkMagic: 894710606,
  },
});

test('scanNeoN3OracleRequestsById batched scan is equivalent to the sequential path', async () => {
  // Equivalence gate for the bounded-concurrency scan: the same stubbed RPC is
  // scanned sequentially (concurrency 1) and concurrently; both must produce
  // identical, ascending-id pending-only event lists.
  const recordsById = {
    1: kernelRequestRecord(1),
    2: kernelRequestRecord(2, { fulfilled: true }),
    3: kernelRequestRecord(3),
    4: emptyKernelRequestRecord(),
    5: kernelRequestRecord(5),
  };
  const originalFetch = global.fetch;
  try {
    const sequentialCalls = [];
    global.fetch = stubGetRequestRpc(recordsById, sequentialCalls);
    const sequential = await scanNeoN3OracleRequestsById(scanConfig(1), 1, 5);

    const batchedCalls = [];
    global.fetch = stubGetRequestRpc(recordsById, batchedCalls);
    const batched = await scanNeoN3OracleRequestsById(scanConfig(4), 1, 5);

    assert.deepEqual(batched, sequential);
    assert.deepEqual(
      batched.map((event) => event.requestId),
      ['1', '3', '5']
    );
    // Both paths issue exactly one getRequest per id in the range.
    assert.equal(sequentialCalls.length, 5);
    assert.equal(batchedCalls.length, 5);
  } finally {
    global.fetch = originalFetch;
  }
});

test('scanNeoN3OracleRequestsById still aborts the scan on a FAULTed getRequest', async () => {
  const recordsById = {
    1: kernelRequestRecord(1),
    2: 'FAULT',
    3: kernelRequestRecord(3),
  };
  const originalFetch = global.fetch;
  try {
    global.fetch = stubGetRequestRpc(recordsById, []);
    await assert.rejects(scanNeoN3OracleRequestsById(scanConfig(4), 1, 3), /boom for 2/);
  } finally {
    global.fetch = originalFetch;
  }
});

// ===================================================================
// scanNeoN3OracleRequests — batched block-cursor-scan equivalence
// ===================================================================

const ORACLE_CONTRACT = '0xaabbccddeeff00112233445566778899aabbccdd';

// MiniAppRequestQueued state layout:
// [requestId, appId, moduleId, operation, requester, sponsor, payload, payloadHash].
function queuedNotification(requestId) {
  return {
    contract: ORACLE_CONTRACT,
    eventname: 'MiniAppRequestQueued',
    state: {
      type: 'Array',
      value: [
        integerItem(requestId),
        byteString('miniapp-os'),
        byteString('oracle.fetch'),
        byteString('privacy_oracle'),
        byteString('NScanner1111111111111111111111111'),
        byteString(''),
        byteString('{"url":"https://example.test"}'),
        byteString('payload-hash'),
      ],
    },
  };
}

// Notification emitted by an unrelated contract; the scan must ignore it.
function unrelatedNotification() {
  return {
    contract: '0x1111111111111111111111111111111111111111',
    eventname: 'Transfer',
    state: { type: 'Array', value: [byteString('noise')] },
  };
}

// Build the block fixture: blockByHeight maps a height to an array of txs, each
// tx an array of notifications. appLogByTx maps a txHash to its execution
// notifications. A notification array of 'TRANSPORT' signals getapplicationlog
// should fail (transport error) for that tx.
function buildBlockFixture(blockSpec) {
  const blockByHeight = {};
  const appLogByTx = {};
  for (const [height, txs] of Object.entries(blockSpec)) {
    blockByHeight[Number(height)] = {
      tx: txs.map((_, index) => ({ txid: `0xtx${height}_${index}` })),
    };
    txs.forEach((notifications, index) => {
      appLogByTx[`0xtx${height}_${index}`] = notifications;
    });
  }
  return { blockByHeight, appLogByTx };
}

function stubBlockScanRpc(fixture, calls) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ method: body.method, params: body.params });
    if (body.method === 'getblock') {
      const height = Number(body.params?.[0]);
      const result = fixture.blockByHeight[height] || { tx: [] };
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result }),
      };
    }
    if (body.method === 'getapplicationlog') {
      const txHash = body.params?.[0];
      const notifications = fixture.appLogByTx[txHash];
      if (notifications === 'TRANSPORT') {
        throw new Error(`transport boom for ${txHash}`);
      }
      const result = { executions: [{ notifications: notifications || [] }] };
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result }),
      };
    }
    throw new Error(`unexpected RPC method ${body.method}`);
  };
}

const blockScanConfig = (concurrency) => ({
  concurrency,
  neo_n3: {
    rpcUrl: 'https://neo-rpc.test',
    oracleContract: ORACLE_CONTRACT,
    networkMagic: 894710606,
  },
});

test('scanNeoN3OracleRequests batched scan is equivalent to the sequential path', async () => {
  // Equivalence gate for the batched block-cursor scan: the same stubbed RPC is
  // scanned sequentially (concurrency 1) and concurrently; both must produce
  // identical event lists in ascending block / tx / notification order, and
  // ignore notifications from other contracts and non-request events.
  const fixture = buildBlockFixture({
    100: [[queuedNotification(1)], [unrelatedNotification(), queuedNotification(2)]],
    101: [], // empty block
    102: [[unrelatedNotification()]], // only noise → no events
    103: [[queuedNotification(3), queuedNotification(4)]],
  });
  const originalFetch = global.fetch;
  try {
    const sequentialCalls = [];
    global.fetch = stubBlockScanRpc(fixture, sequentialCalls);
    const sequential = await scanNeoN3OracleRequests(blockScanConfig(1), 100, 103);

    const batchedCalls = [];
    global.fetch = stubBlockScanRpc(fixture, batchedCalls);
    const batched = await scanNeoN3OracleRequests(blockScanConfig(4), 100, 103);

    assert.deepEqual(batched, sequential);
    assert.deepEqual(
      batched.map((event) => `${event.blockNumber}:${event.requestId}`),
      ['100:1', '100:2', '103:3', '103:4']
    );
    assert.equal(batched[0].payloadHash, 'payload-hash');
    // Both paths issue one getblock per height (4) plus one getapplicationlog
    // per tx (2 + 0 + 1 + 1 = 4) = 8 calls.
    assert.equal(sequentialCalls.length, 8);
    assert.equal(batchedCalls.length, 8);
  } finally {
    global.fetch = originalFetch;
  }
});

test('scanNeoN3OracleRequests aborts the scan on a transport error mid-range', async () => {
  // A getapplicationlog transport failure on any block must reject the whole
  // scan so the block cursor never advances past an unscanned height.
  const fixture = buildBlockFixture({
    100: [[queuedNotification(1)]],
    101: ['TRANSPORT'],
    102: [[queuedNotification(2)]],
  });
  const originalFetch = global.fetch;
  try {
    global.fetch = stubBlockScanRpc(fixture, []);
    await assert.rejects(scanNeoN3OracleRequests(blockScanConfig(4), 100, 102), /transport boom/);
  } finally {
    global.fetch = originalFetch;
  }
});

// ===================================================================
// confirmNeoN3FulfillExecution timeout handling (B6)
// ===================================================================

// getapplicationlog stub that always returns an execution with no vmstate yet
// (the broadcast race / dropped-tx case). A small real delay lets the confirm
// loop's deadline elapse on the first iteration without the 1s inter-poll sleep.
function stubPendingAppLogRpc() {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.method !== 'getapplicationlog') {
      throw new Error(`unexpected RPC method ${body.method}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: { executions: [{}] } }),
    };
  };
}

const confirmConfig = (overrides = {}) => ({
  neo_n3: {
    rpcUrl: 'https://neo-rpc.test',
    networkMagic: 894710606,
    fulfillConfirmTimeoutMs: 1,
    ...overrides,
  },
});

test('confirmNeoN3FulfillExecution throws a transient timeout when the app log never confirms', async () => {
  // A dropped/unmined fulfillRequest must NOT be silently recorded as fulfilled:
  // the confirm must throw a "timed out" error so it re-broadcasts next tick.
  const originalFetch = global.fetch;
  try {
    global.fetch = stubPendingAppLogRpc();
    await assert.rejects(
      confirmNeoN3FulfillExecution(confirmConfig(), '42', '0xdeadbeef'),
      (error) => {
        assert.match(error.message, /confirmation timed out/);
        // classifyError must route this to the transient retry lane, not permanent.
        assert.equal(classifyError(error.message).level, 'transient');
        return true;
      }
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('confirmNeoN3FulfillExecution honors the opt-out flag and degrades to UNKNOWN', async () => {
  // Operators can restore the prior best-effort behavior via the flag.
  const originalFetch = global.fetch;
  try {
    global.fetch = stubPendingAppLogRpc();
    const outcome = await confirmNeoN3FulfillExecution(
      confirmConfig({ fulfillConfirmThrowOnTimeout: false }),
      '42',
      '0xdeadbeef'
    );
    assert.equal(outcome.vm_state, 'UNKNOWN');
  } finally {
    global.fetch = originalFetch;
  }
});

test('confirmNeoN3FulfillExecution still throws (never resolves) on a confirmed FAULT', async () => {
  // A real FAULT must always throw regardless of the timeout flag — never masked.
  const originalFetch = global.fetch;
  try {
    global.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      assert.equal(body.method, 'getapplicationlog');
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: { executions: [{ vmstate: 'FAULT', exception: 'ASSERT failed' }] },
          }),
      };
    };
    await assert.rejects(
      confirmNeoN3FulfillExecution(confirmConfig(), '42', '0xdeadbeef'),
      /faulted/
    );
  } finally {
    global.fetch = originalFetch;
  }
});
