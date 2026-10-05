import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pkg from '@cityofzion/neon-js';
const { wallet, tx } = pkg;

process.env.FEED_PUSHER_SKIP_MAIN = '1';
process.env.SYMBOLS = 'NEO-USD,GAS-USD,BTC-USD';
const TEST_PUSH_STATUS = path.join(os.tmpdir(), `feed-write-mode-${process.pid}.json`);
const TEST_PENDING_BATCH_STATE = `${TEST_PUSH_STATUS}.pending-batch.json`;
const TEST_PUSH_PROM = `${TEST_PUSH_STATUS}.prom`;
process.env.PUSH_STATUS = TEST_PUSH_STATUS;
process.env.PUSH_PROM_TEXTFILE = TEST_PUSH_PROM;

import {
  FEED_NETWORK_DEFAULTS,
  FEED_PAIR_PREFIX,
  FEED_VALID_UNTIL_OFFSET,
  UPDATE_FEED_PARAMETERS,
  FEED_WRITE_MODE_BATCH,
  FEED_WRITE_MODE_PER_PAIR,
  MAX_PER_PAIR_FEED_UPDATES,
  PER_PAIR_ATTEMPTS,
  PER_PAIR_TIMEOUT_MS,
  advancePerPairWrite,
  assertContractIdentity,
  assertInvocationResult,
  assertPriceFreshness,
  assertSignerHealth,
  assertUpdaterIdentity,
  boundPerPairUpdates,
  createPerPairWriteReport,
  encodeUpdateFeedInvocation,
  finalizePerPairWrite,
  isRetryablePerPairError,
  nextPerPairTxParams,
  parseContractUpdateMethods,
  resolveFeedWriteMode,
  storagePairName,
} from './lib-feed-network.mjs';

const {
  FEED_TARGET,
  pushNeoN3,
  rebuildUpdateFeedTxFromEnclavePlan,
  rebuildUpdateFeedsTxFromEnclavePlan,
  __setEnclaveFeedSignForTests,
  __resetEnclaveFeedSignForTests,
  __setFeedTargetForTests,
  __resetFeedTargetForTests,
  __setN3RpcForTests,
  __resetN3RpcForTests,
  __setSignerHealthForTests,
  __resetSignerHealthForTests,
  __setConfirmSleepForTests,
  __resetConfirmSleepForTests,
  __getLastWriteEvidenceForTests,
  __rebuildWriterMetricsFromDiskForTests,
  __writeCycleOverlayStatusForTests,
  __setWriteBudgetForTests,
  __resetWriteBudgetForTests,
} = await import('./feed-pusher.mjs');
import {
  FEED_WRITER_METRIC_NAMES,
  renderFeedWriterPrometheus,
} from './lib-feed-writer-metrics.mjs';

const TESTNET = FEED_NETWORK_DEFAULTS.testnet;
const MAINNET = FEED_NETWORK_DEFAULTS.mainnet;
const TESTNET_STATE = JSON.parse(
  readFileSync(
    new URL('./fixtures/morpheus-datafeed-testnet.getcontractstate.json', import.meta.url),
    'utf8'
  )
);
const MAINNET_STATE = JSON.parse(
  readFileSync(
    new URL('./fixtures/morpheus-datafeed-mainnet.getcontractstate.json', import.meta.url),
    'utf8'
  )
);
const TESTNET_ABI = parseContractUpdateMethods(TESTNET_STATE.manifest);
const MAINNET_ABI = parseContractUpdateMethods(MAINNET_STATE.manifest);
const MAINNET_BATCH_MANIFEST = {
  ...MAINNET_STATE.manifest,
  abi: {
    ...MAINNET_STATE.manifest.abi,
    methods: MAINNET_STATE.manifest.abi.methods.filter((method) => method.name !== 'updateFeed'),
  },
};
const MAINNET_BATCH_ABI = parseContractUpdateMethods(MAINNET_BATCH_MANIFEST);

function liveSignerHealth() {
  return {
    ready: true,
    checks: { compute: true, signer: true },
    key_source: { updater: 'kms_attested' },
  };
}

function transportTimeout(message = 'sendrawtransaction timed out') {
  return Object.assign(new Error(message), { name: 'TimeoutError', code: 'ABORT_ERR' });
}

function writerPromText() {
  return readFileSync(TEST_PUSH_PROM, 'utf8');
}

function failedCyclesTotal(text, network) {
  const match = text.match(
    new RegExp(`${FEED_WRITER_METRIC_NAMES.failed_cycles}\\{network="${network}"\\} (\\d+)`)
  );
  return match ? Number(match[1]) : null;
}

function assertWriterPromState(text, { network, state, outstandingReplay = '0' }) {
  assert.match(
    text,
    new RegExp(
      `${FEED_WRITER_METRIC_NAMES.confirmation_state}\\{network="${network}",state="${state}"\\} 1`
    )
  );
  assert.match(
    text,
    new RegExp(
      `${FEED_WRITER_METRIC_NAMES.outstanding_replay}\\{network="${network}"\\} ${outstandingReplay}`
    )
  );
  assert.doesNotMatch(text, /TWELVEDATA:|0x[0-9a-f]{16}|rawTx|TD_KEY/i);
}

function haltAllRecords(entries) {
  return {
    state: 'HALT',
    stack: [
      {
        type: 'Array',
        value: entries.map(
          ({ pair = 'TWELVEDATA:NEO-USD', round = 1, price = 5.0, ts = 1_779_000_000 }) => ({
            type: 'Struct',
            value: [
              { type: 'ByteString', value: Buffer.from(pair).toString('base64') },
              { type: 'Integer', value: String(round) },
              { type: 'Integer', value: String(Math.round(price * 1e6)) },
              { type: 'Integer', value: String(ts) },
              { type: 'ByteString', value: '' },
              { type: 'Integer', value: '0' },
            ],
          })
        ),
      },
    ],
  };
}

function updaterHalt(hash160) {
  return { state: 'HALT', stack: [{ type: 'Hash160', value: `0x${hash160}` }] };
}

function decodeBroadcast(rawBase64) {
  const txn = tx.Transaction.deserialize(Buffer.from(rawBase64, 'base64').toString('hex'));
  const hash = `0x${String(txn.hash()).replace(/^0x/i, '').toLowerCase()}`;
  return { txn, hash, nonce: txn.nonce, raw: rawBase64 };
}

test('ABI mode dispatch selects the exact network-specific writer ABI', () => {
  assert.equal(resolveFeedWriteMode('testnet', TESTNET_ABI), FEED_WRITE_MODE_PER_PAIR);
  assert.equal(resolveFeedWriteMode('mainnet', MAINNET_BATCH_ABI), FEED_WRITE_MODE_BATCH);
  assert.equal(PER_PAIR_ATTEMPTS, 2);
  assert.equal(PER_PAIR_TIMEOUT_MS, 20_000);
  assert.equal(MAX_PER_PAIR_FEED_UPDATES, 64);
});

test('ABI mode dispatch rejects a TestNet batch or a mixed writer ABI', () => {
  assert.throws(
    () => resolveFeedWriteMode('testnet', MAINNET_ABI),
    /multiple supported writer ABIs/
  );
  const mixed = {
    ...TESTNET_ABI,
    has_update_feeds: true,
    update_feeds: {
      name: 'updateFeeds',
      present: true,
      ok: true,
      reason: null,
      parameters: MAINNET_ABI.update_feeds.parameters,
    },
  };
  assert.throws(() => resolveFeedWriteMode('testnet', mixed), /multiple supported writer ABIs/);
  assert.equal(resolveFeedWriteMode('mainnet', mixed), FEED_WRITE_MODE_BATCH);
});

test('mainnet explicitly prefers the exact batch ABI when the legacy singular ABI remains exposed', () => {
  assert.equal(resolveFeedWriteMode('mainnet', MAINNET_ABI), FEED_WRITE_MODE_BATCH);
});

test('testnet-only guard: mainnet, unknown, and unprobed ABI cannot enter per-pair', () => {
  assert.throws(
    () => resolveFeedWriteMode('mainnet', TESTNET_ABI),
    /mainnet feed has no updateFeeds.*Refusing silent downgrade/
  );
  assert.throws(
    () => resolveFeedWriteMode('neox', TESTNET_ABI),
    /unknown feed network neox: refusing write-mode dispatch/
  );
  assert.throws(
    () => resolveFeedWriteMode('testnet', { probed: false, has_update_feed: true }),
    /ABI not proven/
  );
  assert.throws(
    () =>
      resolveFeedWriteMode('testnet', {
        probed: true,
        has_update_feeds: false,
        has_update_feed: false,
      }),
    /no proven writer method/
  );
});

test('invocation encoding is the deployed 6-arg updateFeed ABI shape', () => {
  const encoded = encodeUpdateFeedInvocation({
    pair: 'NEO-USD',
    roundId: 7,
    price: 5_250_000,
    timestamp: 1_780_000_000,
    attestationHash: 'aabb',
    sourceSetId: 0,
  });
  assert.equal(encoded.operation, 'updateFeed');
  assert.deepEqual(
    encoded.params.map((param) => param.type),
    UPDATE_FEED_PARAMETERS.map((param) => param.type)
  );
  assert.equal(encoded.params.length, UPDATE_FEED_PARAMETERS.length);
  assert.equal(encoded.params[0].value, 'TWELVEDATA:NEO-USD');
  assert.equal(storagePairName('TWELVEDATA:gas-usd'), 'TWELVEDATA:GAS-USD');
  assert.throws(
    () => encodeUpdateFeedInvocation({ pair: 'NEO-USD', roundId: 0, price: 1, timestamp: 1 }),
    /roundId/
  );
});

test('per-pair progression is deterministic, bounded, and reports partial success', () => {
  const planned = boundPerPairUpdates([
    'TWELVEDATA:NEO-USD',
    'TWELVEDATA:GAS-USD',
    'TWELVEDATA:BTC-USD',
  ]);
  assert.deepEqual(planned, ['TWELVEDATA:NEO-USD', 'TWELVEDATA:GAS-USD', 'TWELVEDATA:BTC-USD']);
  assert.throws(
    () => boundPerPairUpdates(Array.from({ length: 65 }, (_, i) => `TWELVEDATA:P${i}`)),
    /exceeds bound 64/
  );

  const first = nextPerPairTxParams(null, {
    blockCount: 100,
    systemFee: 10,
    networkFee: 2,
    nonce: 1,
  });
  assert.equal(first.validUntilBlock, 100 + FEED_VALID_UNTIL_OFFSET);
  assert.throws(
    () => nextPerPairTxParams(first, { blockCount: 101, systemFee: 10, networkFee: 2, nonce: 1 }),
    /nonce must change/
  );
  const retry = nextPerPairTxParams(first, {
    blockCount: 101,
    systemFee: 11,
    networkFee: 3,
    nonce: 2,
  });
  assert.equal(retry.nonce, 2);
  assert.equal(retry.validUntilBlock, 101 + FEED_VALID_UNTIL_OFFSET);

  const report = createPerPairWriteReport({ planned });
  advancePerPairWrite(report, { pair: 'NEO-USD', status: 'confirmed', txid: '0xaaa', attempt: 1 });
  advancePerPairWrite(report, { pair: 'GAS-USD', status: 'pending', txid: '0xccc', attempt: 1 });
  advancePerPairWrite(report, { pair: 'BTC-USD', status: 'confirmed', txid: '0xbbb', attempt: 1 });
  const final = finalizePerPairWrite(report);
  assert.equal(final.ok, false);
  assert.deepEqual(final.confirmed, ['TWELVEDATA:NEO-USD', 'TWELVEDATA:BTC-USD']);
  assert.deepEqual(final.pending, ['TWELVEDATA:GAS-USD']);
  assert.deepEqual(final.txids, ['0xaaa', '0xccc', '0xbbb']);
  assert.equal(
    isRetryablePerPairError(
      Object.assign(new Error('timed out'), { name: 'TimeoutError', code: 'ABORT_ERR' })
    ),
    true
  );
  assert.equal(isRetryablePerPairError(new Error('Invalid network fee')), false);
  assert.equal(
    isRetryablePerPairError(new Error('[neo-n3] invokescript FAULT (fail-closed)')),
    false
  );
});

test('identity and freshness proofs fail closed', () => {
  assert.doesNotThrow(() =>
    assertSignerHealth({
      ready: true,
      checks: { compute: true, signer: true },
      key_source: { updater: 'kms_attested' },
    })
  );
  assert.throws(
    () => assertSignerHealth({ ready: true, signer: true }),
    /signer health not proven/
  );
  assert.throws(
    () => assertSignerHealth({ ready: true, signer: false }),
    /signer health not proven/
  );
  assert.throws(
    () =>
      assertSignerHealth({
        ready: true,
        checks: { signer: true },
        key_source: { updater: 'none' },
      }),
    /updater=none/
  );
  assert.equal(assertContractIdentity({ hash: `0x${TESTNET.feed}` }, TESTNET.feed), TESTNET.feed);
  assert.throws(
    () => assertContractIdentity({ hash: `0x${MAINNET.feed}` }, TESTNET.feed),
    /contract identity not proven/
  );
  assert.equal(
    assertUpdaterIdentity({ type: 'Hash160', value: `0x${TESTNET.updaterSh}` }, TESTNET.updaterSh),
    TESTNET.updaterSh
  );
  assert.throws(
    () =>
      assertUpdaterIdentity(
        { type: 'Hash160', value: `0x${MAINNET.updaterSh}` },
        TESTNET.updaterSh
      ),
    /updater identity not proven/
  );
  assert.equal(assertPriceFreshness({ 'NEO-USD': 5.25 }, 1_780_000_000), 1);
  assert.throws(() => assertPriceFreshness({}, 1_780_000_000), /no positive TwelveData/);
  assert.equal(assertInvocationResult({ hash: '0xabc' }, { requireHash: true }), '0xabc');
  assert.throws(() => assertInvocationResult({ state: 'FAULT', exception: 'no' }), /not proven/);
});

describe('testnet writer host path', { concurrency: false }, () => {
  test('no cross-network leak: testnet pins stay off the mainnet rebuild', () => {
    assert.equal(FEED_TARGET.network, 'mainnet');
    assert.equal(FEED_TARGET.feed, MAINNET.feed);
    const txParams = {
      nonce: 9,
      validUntilBlock: 500_500,
      systemFee: 1,
      networkFee: 1,
    };
    const px = 5_250_000;
    const plan = {
      pairs: ['TWELVEDATA:NEO-USD'],
      rounds: [7],
      prices_scaled: [px],
      timestamps: [1_780_000_000],
      attestation_hashes: [
        createHash('sha256').update(`NEO-USD|${px}|1780000000`).digest('hex').slice(0, 32),
      ],
      source_set_ids: [0],
    };
    const mainnetBatch = rebuildUpdateFeedsTxFromEnclavePlan(plan, txParams);
    const mainnetPair = rebuildUpdateFeedTxFromEnclavePlan(plan, txParams);
    __setFeedTargetForTests({ FEED_NETWORK: 'testnet' });
    try {
      assert.equal(FEED_TARGET.network, 'testnet');
      assert.equal(FEED_TARGET.feed, TESTNET.feed);
      assert.equal(FEED_TARGET.magic, TESTNET.magic);
      const testnetPair = rebuildUpdateFeedTxFromEnclavePlan(plan, txParams);
      assert.notEqual(testnetPair.message, mainnetPair.message);
      assert.notEqual(testnetPair.message, mainnetBatch.message);
      const scriptText = Buffer.from(
        String(testnetPair.txn.script).replace(/^0x/i, ''),
        'hex'
      ).toString('latin1');
      const batchText = Buffer.from(
        String(mainnetBatch.txn.script).replace(/^0x/i, ''),
        'hex'
      ).toString('latin1');
      assert.match(scriptText, /updateFeed/);
      assert.match(batchText, /updateFeeds/);
      assert.notEqual(String(testnetPair.txn.script), String(mainnetBatch.txn.script));
    } finally {
      __resetFeedTargetForTests();
    }
    assert.equal(FEED_TARGET.network, 'mainnet');
    assert.equal(FEED_TARGET.feed, MAINNET.feed);
  });

  test('mainnet regression: updateFeed-only ABI still fails closed and never broadcasts', async () => {
    const broadcast = [];
    __setSignerHealthForTests(async () => liveSignerHealth());
    __setN3RpcForTests(async (method) => {
      if (method === 'getversion') return { protocol: { network: MAINNET.magic } };
      if (method === 'getcontractstate') {
        return {
          hash: `0x${MAINNET.feed}`,
          manifest: TESTNET_STATE.manifest,
        };
      }
      if (method === 'sendrawtransaction') {
        broadcast.push('leaked');
        return { hash: '0xnope' };
      }
      throw new Error('unexpected rpc ' + method);
    });
    try {
      await assert.rejects(
        () => pushNeoN3({ 'NEO-USD': 5.25 }, 1_780_000_000),
        /has no updateFeeds|Refusing silent downgrade/
      );
      assert.deepEqual(broadcast, []);
    } finally {
      __resetN3RpcForTests();
      __resetSignerHealthForTests();
    }
  });

  async function withTestnetWriter(handler, extraRpc = {}) {
    const now = 1_780_000_000;
    const signer = new wallet.Account();
    const broadcast = [];
    const enclaveCalls = [];
    __setFeedTargetForTests({ FEED_NETWORK: 'testnet' });
    __setSignerHealthForTests(async () => liveSignerHealth());
    __setConfirmSleepForTests(async () => {});
    __setN3RpcForTests(async (method, params) => {
      if (extraRpc[method]) return extraRpc[method](params, { broadcast, now });
      switch (method) {
        case 'getversion':
          return { protocol: { network: TESTNET.magic } };
        case 'getcontractstate':
          return { hash: `0x${TESTNET.feed}`, manifest: TESTNET_STATE.manifest };
        case 'invokefunction':
          if (params[1] === 'updater') return updaterHalt(TESTNET.updaterSh);
          if (params[1] === 'getAllFeedRecords') {
            return haltAllRecords([
              { pair: 'TWELVEDATA:NEO-USD', round: 1, price: 5.0, ts: now - 3600 },
              { pair: 'TWELVEDATA:GAS-USD', round: 1, price: 2.0, ts: now - 3600 },
              { pair: 'TWELVEDATA:BTC-USD', round: 1, price: 60_000, ts: now - 3600 },
            ]);
          }
          if (params[1] === 'balanceOf') {
            return { state: 'HALT', stack: [{ type: 'Integer', value: String(20 * 1e8) }] };
          }
          throw new Error('unexpected invokefunction ' + params[1]);
        case 'getblockcount':
          return 4_000_000;
        case 'invokescript':
          return { state: 'HALT', gasconsumed: '1000' };
        case 'calculatenetworkfee':
          return { networkfee: '200' };
        case 'getapplicationlog':
          return { executions: [{ vmstate: 'HALT' }] };
        case 'getrawtransaction':
          return broadcast.find((row) => row.hash === params[0])?.raw || null;
        default:
          throw new Error('unexpected rpc ' + method);
      }
    });
    __setEnclaveFeedSignForTests(async (requestBody) => {
      enclaveCalls.push(requestBody);
      if (extraRpc.enclave) return extraRpc.enclave(requestBody, { signer, now });
      assert.equal(requestBody.write_mode, 'updateFeed');
      const symbol = requestBody.symbols[0];
      const price = { 'NEO-USD': 5.25, 'GAS-USD': 2.2, 'BTC-USD': 65_000 }[symbol];
      const px = Math.round(price * 1e6);
      const plan = {
        write_mode: 'updateFeed',
        operation: 'updateFeed',
        pairs: [`${FEED_PAIR_PREFIX}${symbol}`],
        rounds: [now],
        prices_scaled: [px],
        timestamps: [now],
        attestation_hashes: [
          createHash('sha256').update(`${symbol}|${px}|${now}`).digest('hex').slice(0, 32),
        ],
        source_set_ids: [0],
      };
      const txParams = {
        nonce: requestBody.tx_params.nonce,
        validUntilBlock: requestBody.tx_params.block_count + FEED_VALID_UNTIL_OFFSET,
        systemFee: requestBody.tx_params.system_fee,
        networkFee: requestBody.tx_params.network_fee,
      };
      const rebuilt = rebuildUpdateFeedTxFromEnclavePlan(plan, txParams);
      rebuilt.txn.witnesses = [
        tx.Witness.fromSignature(wallet.sign(rebuilt.message, signer.privateKey), signer.publicKey),
      ];
      return {
        status: 'ok',
        chain: 'neo_n3',
        ...plan,
        tx_message_hex: rebuilt.message,
        tx_nonce: txParams.nonce,
        valid_until_block: txParams.validUntilBlock,
        signature: wallet.sign(rebuilt.message, signer.privateKey),
        public_key: signer.publicKey,
      };
    });
    try {
      return await handler({ now, broadcast, enclaveCalls, signer });
    } finally {
      __resetEnclaveFeedSignForTests();
      __resetN3RpcForTests();
      __resetSignerHealthForTests();
      __resetFeedTargetForTests();
      __resetConfirmSleepForTests();
    }
  }

  test('pushNeoN3 testnet confirms HALT in SYMBOLS order and does not count broadcast as success', async () => {
    const sent = [];
    const submittedSnapshots = [];
    await withTestnetWriter(
      async ({ enclaveCalls, now }) => {
        await pushNeoN3({ 'NEO-USD': 5.25, 'GAS-USD': 2.2 }, now);
        assert.deepEqual(
          enclaveCalls.map((call) => call.symbols[0]),
          ['NEO-USD', 'GAS-USD']
        );
        assert.equal(sent.length, 2);
      },
      {
        sendrawtransaction: (params, { broadcast }) => {
          const decoded = decodeBroadcast(params[0]);
          broadcast.push(decoded);
          sent.push(decoded);
          return { hash: decoded.hash };
        },
        getapplicationlog: () => {
          submittedSnapshots.push(JSON.parse(readFileSync(TEST_PUSH_STATUS, 'utf8')));
          return { executions: [{ vmstate: 'HALT' }] };
        },
      }
    );
    assert.equal(submittedSnapshots.length, 2);
    assert.equal(submittedSnapshots[0].write_mode, FEED_WRITE_MODE_PER_PAIR);
    assert.equal(submittedSnapshots[0].confirmation_status, 'submitted');
    assert.deepEqual(submittedSnapshots[0].pairs_submitted, ['TWELVEDATA:NEO-USD']);
    assert.equal(submittedSnapshots[0].ok, false);
  });

  test('CU-11: a spent daily write budget stops the per-pair writer after the first refusal and says why', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'feed-write-mode-budget-'));
    const statePath = path.join(dir, 'status.json.write-budget.json');
    // One write left today: pair 1 goes out, pair 2 is signed and refused, pair 3 is not even signed.
    const sent = [];
    try {
      writeFileSync(statePath, JSON.stringify({ version: 1, day: '2026-10-05', writes: 4 }));
      __setWriteBudgetForTests({
        limit: 5,
        statePath,
        now: () => Date.UTC(2026, 9, 5, 12, 0, 0),
      });
      await withTestnetWriter(
        async ({ enclaveCalls, now }) => {
          await assert.rejects(
            () => pushNeoN3({ 'NEO-USD': 5.25, 'GAS-USD': 2.2, 'BTC-USD': 65_000 }, now),
            /per-pair updateFeed partial failure: .*daily write budget exhausted: 5 of 5 writes/
          );
          assert.deepEqual(
            enclaveCalls.map((call) => call.symbols[0]),
            ['NEO-USD', 'GAS-USD']
          );
          assert.equal(sent.length, 1);
          const evidence = __getLastWriteEvidenceForTests();
          assert.deepEqual(evidence.pairs_confirmed, ['TWELVEDATA:NEO-USD']);
          assert.deepEqual(evidence.pairs_failed, ['TWELVEDATA:GAS-USD', 'TWELVEDATA:BTC-USD']);
          assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).writes, 5);
        },
        {
          sendrawtransaction: (params, { broadcast }) => {
            const decoded = decodeBroadcast(params[0]);
            broadcast.push(decoded);
            sent.push(decoded);
            return { hash: decoded.hash };
          },
        }
      );
    } finally {
      __resetWriteBudgetForTests();
      rmSync(TEST_PENDING_BATCH_STATE, { force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('accepted-then-timeout reconciles the same signed hash and does not re-sign', async () => {
    const raws = [];
    let sendCalls = 0;
    const known = new Map();
    await withTestnetWriter(
      async ({ enclaveCalls, now }) => {
        await pushNeoN3({ 'NEO-USD': 5.25 }, now);
        assert.equal(enclaveCalls.length, 1);
        assert.equal(sendCalls, 1);
        assert.equal(raws.length, 1);
      },
      {
        sendrawtransaction: (params) => {
          sendCalls += 1;
          const decoded = decodeBroadcast(params[0]);
          raws.push(decoded.raw);
          known.set(decoded.hash, decoded);
          throw transportTimeout();
        },
        getapplicationlog: (params) => {
          if (known.has(params[0])) return { executions: [{ vmstate: 'HALT' }] };
          throw new Error('Unknown transaction');
        },
        getrawtransaction: (params) => known.get(params[0])?.raw || null,
      }
    );
  });

  test('transport timeout with unknown hash replays the same raw transaction', async () => {
    const raws = [];
    let sendCalls = 0;
    await withTestnetWriter(
      async ({ enclaveCalls, now }) => {
        await pushNeoN3({ 'NEO-USD': 5.25 }, now);
        assert.equal(enclaveCalls.length, 1);
        assert.equal(sendCalls, 2);
        assert.equal(raws[0], raws[1]);
      },
      {
        sendrawtransaction: (params, { broadcast }) => {
          sendCalls += 1;
          const decoded = decodeBroadcast(params[0]);
          raws.push(decoded.raw);
          if (sendCalls === 1) throw transportTimeout();
          broadcast.push(decoded);
          return { hash: decoded.hash };
        },
        getapplicationlog: (params, { broadcast }) => {
          if (broadcast.some((row) => row.hash === params[0])) {
            return { executions: [{ vmstate: 'HALT' }] };
          }
          throw new Error('Unknown transaction');
        },
        getrawtransaction: () => {
          throw new Error('Unknown transaction');
        },
      }
    );
  });

  test('explicit rejection does not create a second same-round write', async () => {
    await withTestnetWriter(
      async ({ enclaveCalls, now }) => {
        await assert.rejects(
          () => pushNeoN3({ 'NEO-USD': 5.25 }, now),
          /invalid transaction|partial failure/
        );
        assert.equal(enclaveCalls.length, 1);
      },
      {
        sendrawtransaction: () => {
          throw new Error('invalid transaction: mempool rejected');
        },
      }
    );
  });

  test('pending confirmation and application-log FAULT stay explicit and fail closed', async () => {
    await withTestnetWriter(
      async ({ now }) => {
        await assert.rejects(() => pushNeoN3({ 'NEO-USD': 5.25 }, now), /pending|partial failure/);
      },
      {
        sendrawtransaction: (params, { broadcast }) => {
          const decoded = decodeBroadcast(params[0]);
          broadcast.push(decoded);
          return { hash: decoded.hash };
        },
        getapplicationlog: () => {
          throw new Error('Unknown transaction');
        },
        getrawtransaction: () => null,
      }
    );
    await withTestnetWriter(
      async ({ now }) => {
        await assert.rejects(() => pushNeoN3({ 'NEO-USD': 5.25 }, now), /FAULT|partial failure/);
      },
      {
        sendrawtransaction: (params, { broadcast }) => {
          const decoded = decodeBroadcast(params[0]);
          broadcast.push(decoded);
          return { hash: decoded.hash };
        },
        getapplicationlog: () => ({ executions: [{ vmstate: 'FAULT', exception: 'denied' }] }),
      }
    );
  });

  test('confused enclave write_mode XOR operation is refused before broadcast', async () => {
    const sent = [];
    await withTestnetWriter(
      async ({ now }) => {
        await assert.rejects(
          () => pushNeoN3({ 'NEO-USD': 5.25 }, now),
          /write_mode and operation must both be updateFeed|partial failure/
        );
        assert.deepEqual(sent, []);
      },
      {
        enclave: (requestBody, { signer, now }) => {
          const symbol = requestBody.symbols[0];
          const px = Math.round(5.25 * 1e6);
          const plan = {
            write_mode: 'updateFeeds',
            operation: 'updateFeed',
            pairs: [`${FEED_PAIR_PREFIX}${symbol}`],
            rounds: [now],
            prices_scaled: [px],
            timestamps: [now],
            attestation_hashes: ['aa'],
            source_set_ids: [0],
          };
          const txParams = {
            nonce: requestBody.tx_params.nonce,
            validUntilBlock: requestBody.tx_params.block_count + FEED_VALID_UNTIL_OFFSET,
            systemFee: requestBody.tx_params.system_fee,
            networkFee: requestBody.tx_params.network_fee,
          };
          const rebuilt = rebuildUpdateFeedTxFromEnclavePlan(plan, txParams);
          return {
            status: 'ok',
            chain: 'neo_n3',
            ...plan,
            tx_message_hex: rebuilt.message,
            tx_nonce: txParams.nonce,
            signature: wallet.sign(rebuilt.message, signer.privateKey),
            public_key: signer.publicKey,
          };
        },
        sendrawtransaction: (params) => {
          sent.push(params[0]);
          return { hash: '0xnope' };
        },
      }
    );
  });

  test('pushNeoN3 testnet refuses to run when signer health is not proven', async () => {
    __setFeedTargetForTests({ FEED_NETWORK: 'testnet' });
    __setSignerHealthForTests(async () => ({ ready: true, signer: false }));
    __setN3RpcForTests(async (method) => {
      if (method === 'getcontractstate') {
        return {
          hash: `0x${TESTNET.feed}`,
          manifest: TESTNET_STATE.manifest,
        };
      }
      if (method === 'invokefunction') {
        return updaterHalt(TESTNET.updaterSh);
      }
      throw new Error('unexpected rpc ' + method);
    });
    try {
      await assert.rejects(
        () => pushNeoN3({ 'NEO-USD': 5.25 }, 1_780_000_000),
        /signer health not proven/
      );
      __setSignerHealthForTests(async () => ({
        ready: true,
        checks: { compute: true, signer: true },
        key_source: { updater: 'none' },
      }));
      await assert.rejects(() => pushNeoN3({ 'NEO-USD': 5.25 }, 1_780_000_000), /updater=none/);
    } finally {
      __resetN3RpcForTests();
      __resetSignerHealthForTests();
      __resetFeedTargetForTests();
    }
  });

  test('per-pair confirmed, pending, FAULT, and restart keep distinct Prometheus states', async () => {
    await withTestnetWriter(
      async ({ now }) => {
        await pushNeoN3({ 'NEO-USD': 5.25 }, now);
        assertWriterPromState(writerPromText(), { network: 'testnet', state: 'confirmed' });
        assert.match(
          writerPromText(),
          /neoos_feed_writer_write_mode\{network="testnet",mode="per_pair_update_feed"\} 1/
        );
      },
      {
        sendrawtransaction: (params, { broadcast }) => {
          const decoded = decodeBroadcast(params[0]);
          broadcast.push(decoded);
          return { hash: decoded.hash };
        },
      }
    );
    await withTestnetWriter(
      async ({ now }) => {
        await assert.rejects(() => pushNeoN3({ 'NEO-USD': 5.25 }, now), /pending|partial failure/);
        const pending = writerPromText();
        assertWriterPromState(pending, { network: 'testnet', state: 'pending' });
        const restored = __rebuildWriterMetricsFromDiskForTests();
        assert.equal(renderFeedWriterPrometheus(restored), pending);
      },
      {
        sendrawtransaction: (params, { broadcast }) => {
          const decoded = decodeBroadcast(params[0]);
          broadcast.push(decoded);
          return { hash: decoded.hash };
        },
        getapplicationlog: () => {
          throw new Error('Unknown transaction');
        },
        getrawtransaction: () => null,
      }
    );
    await withTestnetWriter(
      async ({ now }) => {
        await assert.rejects(() => pushNeoN3({ 'NEO-USD': 5.25 }, now), /FAULT|partial failure/);
        assertWriterPromState(writerPromText(), { network: 'testnet', state: 'fault' });
        assert.match(
          writerPromText(),
          /neoos_feed_writer_failed_cycles_total\{network="testnet"\} [1-9][0-9]*/
        );
      },
      {
        sendrawtransaction: (params, { broadcast }) => {
          const decoded = decodeBroadcast(params[0]);
          broadcast.push(decoded);
          return { hash: decoded.hash };
        },
        getapplicationlog: () => ({ executions: [{ vmstate: 'FAULT', exception: 'denied' }] }),
      }
    );
  });

  test('per-pair cycle overlay persist does not double-count failed_cycles_total', async () => {
    await withTestnetWriter(
      async ({ now }) => {
        await assert.rejects(() => pushNeoN3({ 'NEO-USD': 5.25 }, now), /FAULT|partial failure/);
        const before = writerPromText();
        assertWriterPromState(before, { network: 'testnet', state: 'fault' });
        const count = failedCyclesTotal(before, 'testnet');
        assert.equal(typeof count, 'number');
        assert.ok(count >= 1);
        __writeCycleOverlayStatusForTests({
          ok: false,
          errors: [{ code: 'chain_push_failed', summary: 'FAULT' }],
        });
        const after = writerPromText();
        assertWriterPromState(after, { network: 'testnet', state: 'fault' });
        assert.equal(failedCyclesTotal(after, 'testnet'), count);
      },
      {
        sendrawtransaction: (params, { broadcast }) => {
          const decoded = decodeBroadcast(params[0]);
          broadcast.push(decoded);
          return { hash: decoded.hash };
        },
        getapplicationlog: () => ({ executions: [{ vmstate: 'FAULT', exception: 'denied' }] }),
      }
    );
  });
});

describe('mainnet batch writer host path', { concurrency: false }, () => {
  async function withMainnetWriter(handler, extraRpc = {}) {
    const now = 1_780_000_000;
    const signer = new wallet.Account();
    const broadcast = [];
    const enclaveCalls = [];
    rmSync(TEST_PENDING_BATCH_STATE, { force: true });
    __setSignerHealthForTests(async () => liveSignerHealth());
    __setConfirmSleepForTests(async () => {});
    __setN3RpcForTests(async (method, params) => {
      if (extraRpc[method]) return extraRpc[method](params, { broadcast, now });
      switch (method) {
        case 'getversion':
          return { protocol: { network: MAINNET.magic } };
        case 'getcontractstate':
          return { hash: `0x${MAINNET.feed}`, manifest: MAINNET_STATE.manifest };
        case 'invokefunction':
          if (params[1] === 'updater') return updaterHalt(MAINNET.updaterSh);
          if (params[1] === 'getAllFeedRecords') {
            return haltAllRecords([
              { pair: 'TWELVEDATA:NEO-USD', round: 1, price: 5.0, ts: now - 3600 },
              { pair: 'TWELVEDATA:GAS-USD', round: 1, price: 2.0, ts: now - 3600 },
              { pair: 'TWELVEDATA:BTC-USD', round: 1, price: 60_000, ts: now - 3600 },
            ]);
          }
          if (params[1] === 'balanceOf') {
            return { state: 'HALT', stack: [{ type: 'Integer', value: String(20 * 1e8) }] };
          }
          throw new Error('unexpected invokefunction ' + params[1]);
        case 'getblockcount':
          return 5_000_000;
        case 'invokescript':
          return { state: 'HALT', gasconsumed: '1000' };
        case 'calculatenetworkfee':
          return { networkfee: '200' };
        case 'getapplicationlog':
          return { executions: [{ vmstate: 'HALT' }] };
        case 'getrawtransaction':
          return broadcast.find((row) => row.hash === params[0])?.raw || null;
        default:
          throw new Error('unexpected rpc ' + method);
      }
    });
    __setEnclaveFeedSignForTests(async (requestBody) => {
      enclaveCalls.push(requestBody);
      if (extraRpc.enclave) return extraRpc.enclave(requestBody, { signer, now });
      assert.equal(requestBody.write_mode, 'updateFeeds');
      const symbols = requestBody.symbols;
      const prices = { 'NEO-USD': 5.25, 'GAS-USD': 2.2, 'BTC-USD': 65_000 };
      const plan = {
        write_mode: 'updateFeeds',
        operation: 'updateFeeds',
        pairs: symbols.map((symbol) => `${FEED_PAIR_PREFIX}${symbol}`),
        rounds: symbols.map(() => now),
        prices_scaled: symbols.map((symbol) => Math.round(prices[symbol] * 1e6)),
        timestamps: symbols.map(() => now),
        attestation_hashes: symbols.map((symbol) =>
          createHash('sha256')
            .update(`${symbol}|${Math.round(prices[symbol] * 1e6)}|${now}`)
            .digest('hex')
            .slice(0, 32)
        ),
        source_set_ids: symbols.map(() => 0),
      };
      const txParams = {
        nonce: requestBody.tx_params.nonce,
        validUntilBlock: requestBody.tx_params.block_count + FEED_VALID_UNTIL_OFFSET,
        systemFee: requestBody.tx_params.system_fee,
        networkFee: requestBody.tx_params.network_fee,
      };
      const rebuilt = rebuildUpdateFeedsTxFromEnclavePlan(plan, txParams);
      rebuilt.txn.witnesses = [
        tx.Witness.fromSignature(wallet.sign(rebuilt.message, signer.privateKey), signer.publicKey),
      ];
      return {
        status: 'ok',
        chain: 'neo_n3',
        ...plan,
        tx_message_hex: rebuilt.message,
        tx_nonce: txParams.nonce,
        valid_until_block: txParams.validUntilBlock,
        signature: wallet.sign(rebuilt.message, signer.privateKey),
        public_key: signer.publicKey,
      };
    });
    try {
      return await handler({ now, broadcast, enclaveCalls, signer });
    } finally {
      __resetEnclaveFeedSignForTests();
      __resetN3RpcForTests();
      __resetSignerHealthForTests();
      __resetConfirmSleepForTests();
      rmSync(TEST_PENDING_BATCH_STATE, { force: true });
    }
  }

  test('pushNeoN3 mainnet batch confirms HALT and does not count broadcast as success', async () => {
    const sent = [];
    await withMainnetWriter(
      async ({ now }) => {
        await pushNeoN3({ 'NEO-USD': 5.25, 'GAS-USD': 2.2 }, now);
        const evidence = __getLastWriteEvidenceForTests();
        assert.equal(evidence.write_mode, FEED_WRITE_MODE_BATCH);
        assert.equal(evidence.confirmation_status, 'confirmed');
        assert.deepEqual(evidence.pairs_confirmed, ['TWELVEDATA:NEO-USD', 'TWELVEDATA:GAS-USD']);
        assert.deepEqual(evidence.pairs_pending, []);
        assert.equal(sent.length, 1);
        assert.equal(evidence.submitted_identity?.hash, evidence.txids[0]);
      },
      {
        sendrawtransaction: (params, { broadcast }) => {
          const decoded = decodeBroadcast(params[0]);
          broadcast.push(decoded);
          sent.push(decoded);
          return { hash: decoded.hash };
        },
      }
    );
  });

  test('mainnet batch FAULT, pending, and confirmation timeout fail closed', async () => {
    await withMainnetWriter(
      async ({ now }) => {
        await assert.rejects(
          () => pushNeoN3({ 'NEO-USD': 5.25 }, now),
          /FAULT|batch updateFeeds failure/
        );
        const evidence = __getLastWriteEvidenceForTests();
        assert.equal(evidence.confirmation_status, 'failed');
        assert.deepEqual(evidence.pairs_failed, ['TWELVEDATA:NEO-USD']);
        assert.equal(evidence.write_attempts.at(-1).status, 'fault');
      },
      {
        sendrawtransaction: (params, { broadcast }) => {
          const decoded = decodeBroadcast(params[0]);
          broadcast.push(decoded);
          return { hash: decoded.hash };
        },
        getapplicationlog: () => ({ executions: [{ vmstate: 'FAULT', exception: 'denied' }] }),
      }
    );
    await withMainnetWriter(
      async ({ now }) => {
        await assert.rejects(
          () => pushNeoN3({ 'NEO-USD': 5.25 }, now),
          /pending|batch updateFeeds failure/
        );
        const evidence = __getLastWriteEvidenceForTests();
        assert.equal(evidence.confirmation_status, 'pending');
        assert.deepEqual(evidence.pairs_pending, ['TWELVEDATA:NEO-USD']);
        assert.equal(evidence.write_attempts.at(-1).status, 'timeout');
        assert.equal(evidence.ok, undefined);
      },
      {
        sendrawtransaction: (params, { broadcast }) => {
          const decoded = decodeBroadcast(params[0]);
          broadcast.push(decoded);
          return { hash: decoded.hash };
        },
        getapplicationlog: () => {
          throw new Error('Unknown transaction');
        },
        getrawtransaction: () => null,
      }
    );
  });

  test('mainnet accepted-then-timeout reconciles the same signed hash and does not re-sign', async () => {
    const raws = [];
    let sendCalls = 0;
    const known = new Map();
    await withMainnetWriter(
      async ({ enclaveCalls, now }) => {
        await pushNeoN3({ 'NEO-USD': 5.25 }, now);
        assert.equal(enclaveCalls.length, 1);
        assert.equal(sendCalls, 1);
        assert.equal(raws.length, 1);
        const evidence = __getLastWriteEvidenceForTests();
        assert.equal(evidence.confirmation_status, 'confirmed');
        assert.equal(evidence.submitted_identity?.hash, known.keys().next().value);
      },
      {
        sendrawtransaction: (params) => {
          sendCalls += 1;
          const decoded = decodeBroadcast(params[0]);
          raws.push(decoded.raw);
          known.set(decoded.hash, decoded);
          throw transportTimeout();
        },
        getapplicationlog: (params) => {
          if (known.has(params[0])) return { executions: [{ vmstate: 'HALT' }] };
          throw new Error('Unknown transaction');
        },
        getrawtransaction: (params) => known.get(params[0])?.raw || null,
      }
    );
  });

  test('mainnet transport timeout with unknown hash replays the same raw and nonce', async () => {
    const raws = [];
    const nonces = [];
    let sendCalls = 0;
    await withMainnetWriter(
      async ({ enclaveCalls, now }) => {
        await pushNeoN3({ 'NEO-USD': 5.25 }, now);
        assert.equal(enclaveCalls.length, 1);
        assert.equal(sendCalls, 2);
        assert.equal(raws[0], raws[1]);
        assert.equal(nonces[0], nonces[1]);
      },
      {
        sendrawtransaction: (params, { broadcast }) => {
          sendCalls += 1;
          const decoded = decodeBroadcast(params[0]);
          raws.push(decoded.raw);
          nonces.push(decoded.nonce);
          if (sendCalls === 1) throw transportTimeout();
          broadcast.push(decoded);
          return { hash: decoded.hash };
        },
        getapplicationlog: (params, { broadcast }) => {
          if (broadcast.some((row) => row.hash === params[0])) {
            return { executions: [{ vmstate: 'HALT' }] };
          }
          throw new Error('Unknown transaction');
        },
        getrawtransaction: () => {
          throw new Error('Unknown transaction');
        },
      }
    );
  });

  test('mainnet ambiguous timeout survives a oneshot boundary and replays persisted raw without a new nonce', async () => {
    const raws = [];
    const nonces = [];
    let sendCalls = 0;
    await withMainnetWriter(
      async ({ enclaveCalls, now }) => {
        await assert.rejects(
          () => pushNeoN3({ 'NEO-USD': 5.25 }, now),
          /pending|timed out|batch updateFeeds failure/
        );
        const persisted = JSON.parse(readFileSync(TEST_PENDING_BATCH_STATE, 'utf8'));
        const pendingEvidence = __getLastWriteEvidenceForTests();
        assert.equal(persisted.identity.hash, pendingEvidence.submitted_identity.hash);
        assert.equal(persisted.identity.nonce, nonces[0]);
        assert.equal(persisted.identity.rawTx, raws[0]);
        assert.equal(pendingEvidence.confirmation_status, 'pending');

        // pushNeoN3 has returned, so its in-memory retainedIdentity is gone. This
        // second call models the next systemd oneshot and must load the state file.
        await pushNeoN3({ 'NEO-USD': 5.25 }, now);
        assert.equal(enclaveCalls.length, 1);
        assert.equal(sendCalls, 3);
        assert.deepEqual(new Set(raws), new Set([raws[0]]));
        assert.deepEqual(new Set(nonces), new Set([nonces[0]]));
        assert.equal(__getLastWriteEvidenceForTests().confirmation_status, 'confirmed');
        assert.throws(() => readFileSync(TEST_PENDING_BATCH_STATE, 'utf8'), { code: 'ENOENT' });
      },
      {
        sendrawtransaction: (params, { broadcast }) => {
          sendCalls += 1;
          const decoded = decodeBroadcast(params[0]);
          raws.push(decoded.raw);
          nonces.push(decoded.nonce);
          if (sendCalls <= 2) throw transportTimeout();
          broadcast.push(decoded);
          return { hash: decoded.hash };
        },
        getapplicationlog: (params, { broadcast }) => {
          if (broadcast.some((row) => row.hash === params[0])) {
            return { executions: [{ vmstate: 'HALT' }] };
          }
          throw new Error('Unknown transaction');
        },
        getrawtransaction: () => {
          throw new Error('Unknown transaction');
        },
      }
    );
  });

  test('batch confirmed, pending plus sidecar, FAULT, and restart stay fail-closed', async () => {
    await withMainnetWriter(
      async ({ now }) => {
        await pushNeoN3({ 'NEO-USD': 5.25 }, now);
        assertWriterPromState(writerPromText(), { network: 'mainnet', state: 'confirmed' });
        assert.match(
          writerPromText(),
          /neoos_feed_writer_write_mode\{network="mainnet",mode="batch_update_feeds"\} 1/
        );
      },
      {
        sendrawtransaction: (params, { broadcast }) => {
          const decoded = decodeBroadcast(params[0]);
          broadcast.push(decoded);
          return { hash: decoded.hash };
        },
      }
    );
    await withMainnetWriter(
      async ({ now }) => {
        await assert.rejects(
          () => pushNeoN3({ 'NEO-USD': 5.25 }, now),
          /pending|batch updateFeeds failure/
        );
        const pending = writerPromText();
        assertWriterPromState(pending, {
          network: 'mainnet',
          state: 'pending',
          outstandingReplay: '1',
        });
        const restored = __rebuildWriterMetricsFromDiskForTests();
        assert.equal(restored.confirmation_state, 'pending');
        assert.equal(restored.outstanding_replay, 1);
        assert.equal(renderFeedWriterPrometheus(restored), pending);
      },
      {
        sendrawtransaction: (params, { broadcast }) => {
          const decoded = decodeBroadcast(params[0]);
          broadcast.push(decoded);
          return { hash: decoded.hash };
        },
        getapplicationlog: () => {
          throw new Error('Unknown transaction');
        },
        getrawtransaction: () => null,
      }
    );
    await withMainnetWriter(
      async ({ now }) => {
        await assert.rejects(
          () => pushNeoN3({ 'NEO-USD': 5.25 }, now),
          /FAULT|batch updateFeeds failure/
        );
        assertWriterPromState(writerPromText(), { network: 'mainnet', state: 'fault' });
      },
      {
        sendrawtransaction: (params, { broadcast }) => {
          const decoded = decodeBroadcast(params[0]);
          broadcast.push(decoded);
          return { hash: decoded.hash };
        },
        getapplicationlog: () => ({ executions: [{ vmstate: 'FAULT', exception: 'denied' }] }),
      }
    );
  });

  test('mainnet cycle overlay persist does not double-count failed_cycles_total', async () => {
    await withMainnetWriter(
      async ({ now }) => {
        await assert.rejects(
          () => pushNeoN3({ 'NEO-USD': 5.25 }, now),
          /FAULT|batch updateFeeds failure/
        );
        const before = writerPromText();
        assertWriterPromState(before, { network: 'mainnet', state: 'fault' });
        const count = failedCyclesTotal(before, 'mainnet');
        assert.equal(typeof count, 'number');
        assert.ok(count >= 1);
        __writeCycleOverlayStatusForTests({
          ok: false,
          errors: [{ code: 'chain_push_failed', summary: 'FAULT' }],
        });
        const after = writerPromText();
        assertWriterPromState(after, { network: 'mainnet', state: 'fault' });
        assert.equal(failedCyclesTotal(after, 'mainnet'), count);
      },
      {
        sendrawtransaction: (params, { broadcast }) => {
          const decoded = decodeBroadcast(params[0]);
          broadcast.push(decoded);
          return { hash: decoded.hash };
        },
        getapplicationlog: () => ({ executions: [{ vmstate: 'FAULT', exception: 'denied' }] }),
      }
    );
  });

  test('mainnet explicit rejection does not create a second same-round write', async () => {
    await withMainnetWriter(
      async ({ enclaveCalls, now }) => {
        await assert.rejects(
          () => pushNeoN3({ 'NEO-USD': 5.25 }, now),
          /invalid transaction|batch updateFeeds failure/
        );
        assert.equal(enclaveCalls.length, 1);
        const evidence = __getLastWriteEvidenceForTests();
        assert.equal(evidence.confirmation_status, 'failed');
        assert.equal(evidence.write_attempts.at(-1).status, 'failed');
        assert.match(evidence.write_attempts.at(-1).error, /invalid transaction/);
      },
      {
        sendrawtransaction: () => {
          throw new Error('invalid transaction: mempool rejected');
        },
      }
    );
  });
});
