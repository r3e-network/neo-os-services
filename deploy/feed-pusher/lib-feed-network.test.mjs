import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  CLOCK_SKEW_TOLERANCE_SEC,
  DEFAULT_RETIRED_FEED_PAIRS,
  FEED_NETWORK_DEFAULTS,
  FEED_SLO_SECONDS,
  FEED_UNIT_PINNED_ENV,
  applySystemdServiceEnv,
  assertBatchUpdateFeedsSupported,
  assertSignerHealth,
  decodeGetAllFeedRecords,
  decodeNeoHash160,
  extractNetworkMagic,
  finalizePusherCycle,
  isMissingGetAllFeedRecordsError,
  normalizeChainUnixTime,
  isMissingBatchUpdateFeedsError,
  UPDATE_FEED_PARAMETERS,
  UPDATE_FEEDS_PARAMETERS,
  __resetBoundEnclaveNetworkIdentityForTests,
  applyWriteConfirmation,
  assertBroadcastAccepted,
  bindEnclaveNetworkIdentity,
  classifyApplicationLog,
  classifyBroadcastOutcome,
  confirmFeedApplicationLog,
  createFeedWriteReport,
  createSignedFeedTxIdentity,
  canReplaceSignedTxIdentity,
  deriveConfirmationStatus,
  finalizeFeedWrite,
  markFeedWriteSubmitted,
  encodeUpdateFeedInvocation,
  isRetryablePerPairError,
  parseContractUpdateMethods,
  parseEnvFileAssignments,
  parseExecStartEnvPins,
  readChainUnixTime,
  reservedKeysPresent,
  resolveFeedNetwork,
  resolveFeedWriteMode,
  resolveFeedTopupPaths,
  FEED_WRITE_MODE_BATCH,
  FEED_WRITE_MODE_PER_PAIR,
  selectRpcsMatchingMagic,
  validateFeedPusherEnv,
} from './lib-feed-network.mjs';

const TESTNET_UPDATER_B64 = '94tf9dr7W9mdjIqaJOBuOZyZIeQ=';
const TESTNET_UPDATER = '0xe421999c396ee0249a8a8c9dd95bfbdaf55f8bf7';
const TESTNET_UPDATER_LE_HEX = Buffer.from(TESTNET_UPDATER_B64, 'base64').toString('hex');

test('acceptance SLO is 6 hours', () => {
  assert.equal(FEED_SLO_SECONDS, 6 * 3600);
  assert.equal(CLOCK_SKEW_TOLERANCE_SEC, 120);
});

test('retired-pair policy is the single checked source', () => {
  assert.deepEqual(
    [...DEFAULT_RETIRED_FEED_PAIRS],
    ['COPPER-USD', 'FLM-USD', '1000FLM-USD', '1000JPY-USD']
  );
});

test('resolveFeedNetwork defaults to the live mainnet writer target', () => {
  const resolved = resolveFeedNetwork({});
  assert.equal(resolved.network, 'mainnet');
  assert.equal(resolved.feed, FEED_NETWORK_DEFAULTS.mainnet.feed);
  assert.equal(resolved.magic, 860833102);
  assert.equal(resolved.updaterSh, FEED_NETWORK_DEFAULTS.mainnet.updaterSh);
});

test('MORPHEUS_NETWORK does not silently retarget a feed writer', () => {
  const resolved = resolveFeedNetwork({ MORPHEUS_NETWORK: 'testnet' });
  assert.equal(resolved.network, 'mainnet');
  assert.equal(resolved.feed, FEED_NETWORK_DEFAULTS.mainnet.feed);
  assert.equal(resolved.magic, FEED_NETWORK_DEFAULTS.mainnet.magic);
});

test('FEED_NETWORK=testnet selects the 0x9bea… datafeed and NiUs updater', () => {
  const resolved = resolveFeedNetwork({ FEED_NETWORK: 'testnet' });
  assert.equal(resolved.feed, '9bea75cf702f6afc09125aa6d22f082bfd2ee064');
  assert.equal(resolved.magic, 894710606);
  assert.equal(resolved.updaterSh, 'e421999c396ee0249a8a8c9dd95bfbdaf55f8bf7');
});

test('validateFeedPusherEnv refuses a testnet run aimed at the mainnet hash', () => {
  const hashMix = validateFeedPusherEnv(
    {
      FEED_NETWORK: 'testnet',
      N3_FEED: FEED_NETWORK_DEFAULTS.mainnet.feed,
      TD_KEY: 'x',
    },
    { requireTdKey: true }
  );
  assert.equal(hashMix.network, null);
  assert.ok(
    hashMix.errors.some(
      (error) =>
        error.code === 'feed_hash_mismatch' || error.code === 'testnet_pointing_at_mainnet_feed'
    )
  );
});

test('N3_FEED and FEED_MAGIC overrides fail closed and cannot silently retarget', () => {
  assert.throws(
    () =>
      resolveFeedNetwork({
        FEED_NETWORK: 'mainnet',
        N3_FEED: FEED_NETWORK_DEFAULTS.testnet.feed,
      }),
    /N3_FEED does not match FEED_NETWORK=mainnet|refusing silent retarget/
  );
  assert.throws(
    () =>
      resolveFeedNetwork({
        FEED_NETWORK: 'mainnet',
        FEED_MAGIC: String(FEED_NETWORK_DEFAULTS.testnet.magic),
      }),
    /FEED_MAGIC does not match FEED_NETWORK=mainnet|refusing silent retarget/
  );
  assert.throws(
    () =>
      resolveFeedNetwork({
        FEED_NETWORK: 'testnet',
        N3_FEED: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      }),
    /N3_FEED does not match FEED_NETWORK=testnet|refusing silent retarget/
  );
  const confirmed = resolveFeedNetwork({
    FEED_NETWORK: 'mainnet',
    N3_FEED: `0x${FEED_NETWORK_DEFAULTS.mainnet.feed}`,
    FEED_MAGIC: String(FEED_NETWORK_DEFAULTS.mainnet.magic),
    FEED_RPCS: 'https://operator.example/n3',
  });
  assert.equal(confirmed.feed, FEED_NETWORK_DEFAULTS.mainnet.feed);
  assert.equal(confirmed.magic, FEED_NETWORK_DEFAULTS.mainnet.magic);
  assert.deepEqual(confirmed.rpcs, ['https://operator.example/n3']);

  const leftover = validateFeedPusherEnv(
    {
      FEED_NETWORK: 'mainnet',
      N3_FEED: FEED_NETWORK_DEFAULTS.testnet.feed,
      FEED_MAGIC: String(FEED_NETWORK_DEFAULTS.testnet.magic),
      FEED_RPCS: 'https://api.n3index.dev/testnet',
      TD_KEY: 'x',
    },
    { requireTdKey: true }
  );
  assert.equal(leftover.network, null);
  assert.ok(
    leftover.errors.some((error) => /N3_FEED|FEED_MAGIC|silent retarget/.test(error.summary))
  );
});

test('validateFeedPusherEnv does not treat a URL substring as network isolation', () => {
  const rpcMix = validateFeedPusherEnv(
    {
      FEED_NETWORK: 'testnet',
      FEED_RPCS: 'https://api.n3index.dev/mainnet',
      TD_KEY: 'x',
    },
    { requireTdKey: true }
  );
  assert.equal(
    rpcMix.errors.some((error) => error.code === 'rpc_network_mismatch'),
    false,
    'URL substring matching is not an isolation mechanism'
  );
});

test('validateFeedPusherEnv requires TD_KEY only when a fetch will run', () => {
  const missing = validateFeedPusherEnv({ FEED_NETWORK: 'mainnet' }, { requireTdKey: true });
  assert.ok(missing.errors.some((error) => error.code === 'missing_td_key'));
  const skipped = validateFeedPusherEnv({ FEED_NETWORK: 'mainnet' }, { requireTdKey: false });
  assert.equal(skipped.errors.length, 0);
});

test('selectRpcsMatchingMagic keeps only getversion-magic matches', async () => {
  const probe = async (url) => {
    if (url.includes('test')) return { protocol: { network: 894710606 } };
    if (url.includes('main')) return { protocol: { network: 860833102 } };
    throw new Error('unreachable');
  };
  const selected = await selectRpcsMatchingMagic(
    ['https://n3.example/testnet', 'https://n3.example/mainnet', 'https://n3.example/down'],
    894710606,
    { probe }
  );
  assert.deepEqual(selected.matched, ['https://n3.example/testnet']);
  assert.equal(selected.rejected.length, 2);
});

test('selectRpcsMatchingMagic fails closed when no candidate matches', async () => {
  await assert.rejects(
    () =>
      selectRpcsMatchingMagic(['https://n3.example/mainnet'], 894710606, {
        probe: async () => ({ protocol: { network: 860833102 } }),
      }),
    /no RPC matched magic 894710606/
  );
});

test('extractNetworkMagic reads protocol.network and rejects a missing magic', () => {
  assert.equal(extractNetworkMagic({ protocol: { network: 860833102 } }), 860833102);
  assert.throws(
    () => extractNetworkMagic({ useragent: '/Neo:3/' }),
    /did not return a network magic/
  );
});

test('readChainUnixTime uses the previous block header time', async () => {
  const rpc = async (method) => {
    if (method === 'getblockcount') return 100;
    if (method === 'getblock') return { time: 1_780_000_000 };
    throw new Error(method);
  };
  assert.equal(await readChainUnixTime(rpc), 1_780_000_000);
});

test('normalizeChainUnixTime accepts millisecond header times without inventing ordinary stale', () => {
  assert.equal(normalizeChainUnixTime(1_788_177_600_000), 1_788_177_600);
  assert.equal(normalizeChainUnixTime(1_788_177_600), 1_788_177_600);
  assert.throws(() => normalizeChainUnixTime(0), /missing/);
});

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
test('parseContractUpdateMethods requires exact captured ABI arity and types', () => {
  const testnet = parseContractUpdateMethods(TESTNET_STATE.manifest);
  assert.deepEqual(
    {
      probed: testnet.probed,
      has_update_feeds: testnet.has_update_feeds,
      has_update_feed: testnet.has_update_feed,
    },
    { probed: true, has_update_feeds: false, has_update_feed: true }
  );
  const mainnet = parseContractUpdateMethods(MAINNET_STATE.manifest);
  assert.equal(mainnet.has_update_feeds, true);
  assert.equal(mainnet.has_update_feed, true);
  assert.equal(parseContractUpdateMethods(null).probed, false);
  const nameOnly = parseContractUpdateMethods({
    abi: { methods: [{ name: 'updateFeed' }, { name: 'getLatest' }] },
  });
  assert.equal(nameOnly.has_update_feed, false);
  assert.equal(nameOnly.update_feed.reason, 'unspecified_parameters');
  const wrongArity = parseContractUpdateMethods({
    abi: {
      methods: [{ name: 'updateFeed', parameters: UPDATE_FEED_PARAMETERS.slice(0, 5) }],
    },
  });
  assert.equal(wrongArity.update_feed.reason, 'wrong_arity');
});

test('assertSignerHealth accepts the live enclave /health body and refuses compact signer-only shapes', () => {
  assert.doesNotThrow(() =>
    assertSignerHealth({
      status: 'ok',
      ready: true,
      checks: { compute: true, signer: true },
      key_source: { oracle_verifier: 'kms_attested', updater: 'kms_attested' },
    })
  );
  assert.throws(
    () => assertSignerHealth({ ready: true, signer: true }),
    /signer health not proven/
  );
  assert.throws(
    () =>
      assertSignerHealth({
        ready: true,
        checks: { compute: true, signer: true },
        key_source: { oracle_verifier: 'kms_attested', updater: 'none' },
      }),
    /updater=none/
  );
  assert.throws(
    () =>
      assertSignerHealth({
        ready: true,
        checks: { compute: true, signer: true },
      }),
    /updater=unproven/
  );
  assert.throws(
    () => assertSignerHealth({ ready: true, signer: false }),
    /signer health not proven/
  );
});

test('resolveFeedWriteMode is testnet-only for updateFeed and never downgrades mainnet', () => {
  assert.equal(
    resolveFeedWriteMode('testnet', parseContractUpdateMethods(TESTNET_STATE.manifest)),
    FEED_WRITE_MODE_PER_PAIR
  );
  assert.equal(
    resolveFeedWriteMode('mainnet', parseContractUpdateMethods(MAINNET_STATE.manifest)),
    FEED_WRITE_MODE_BATCH
  );
  assert.equal(
    resolveFeedWriteMode('mainnet', parseContractUpdateMethods(MAINNET_STATE.manifest)),
    FEED_WRITE_MODE_BATCH
  );
  assert.throws(
    () => resolveFeedWriteMode('mainnet', parseContractUpdateMethods(TESTNET_STATE.manifest)),
    /Refusing silent downgrade/
  );
  assert.throws(
    () =>
      resolveFeedWriteMode(
        'testnet',
        parseContractUpdateMethods({
          abi: {
            methods: [{ name: 'updateFeed', parameters: UPDATE_FEED_PARAMETERS.slice(0, 4) }],
          },
        })
      ),
    /wrong_arity|ambiguous/
  );
});

test('assertBatchUpdateFeedsSupported fails closed on the live testnet ABI', () => {
  assert.throws(
    () =>
      assertBatchUpdateFeedsSupported(TESTNET_STATE.manifest, {
        feed: '9bea75cf702f6afc09125aa6d22f082bfd2ee064',
        network: 'testnet',
      }),
    /has no updateFeeds/
  );
  assert.doesNotThrow(() =>
      assertBatchUpdateFeedsSupported(MAINNET_STATE.manifest, {
      feed: '03013f49c42a14546c8bbe58f9d434c3517fccab',
      network: 'mainnet',
    })
  );
});

test('isMissingBatchUpdateFeedsError matches the worker and RPC phrasings', () => {
  assert.equal(
    isMissingBatchUpdateFeedsError(
      'Method "updateFeeds" with 6 parameter(s) doesn\'t exist in the contract 0x9bea75cf702f6afc09125aa6d22f082bfd2ee064.'
    ),
    true
  );
  assert.equal(isMissingBatchUpdateFeedsError('insufficient funds'), false);
});

test('decodeNeoHash160 supports HALT ByteString, Hash160, and LE hex encodings', () => {
  assert.equal(
    decodeNeoHash160({ type: 'ByteString', value: TESTNET_UPDATER_B64 }),
    TESTNET_UPDATER
  );
  assert.equal(
    decodeNeoHash160({ type: 'ByteArray', value: TESTNET_UPDATER_B64 }),
    TESTNET_UPDATER
  );
  assert.equal(decodeNeoHash160({ type: 'Hash160', value: TESTNET_UPDATER }), TESTNET_UPDATER);
  assert.equal(
    decodeNeoHash160({ type: 'Hash160', value: TESTNET_UPDATER.slice(2) }),
    TESTNET_UPDATER
  );
  assert.equal(
    decodeNeoHash160({ type: 'ByteString', value: TESTNET_UPDATER_LE_HEX }),
    TESTNET_UPDATER
  );
  assert.equal(decodeNeoHash160(TESTNET_UPDATER), TESTNET_UPDATER);
});

test('decodeNeoHash160 fails loudly on unsupported representations', () => {
  assert.throws(() => decodeNeoHash160(null), /empty/);
  assert.throws(() => decodeNeoHash160({ type: 'Integer', value: '1' }), /unsupported Hash160/);
  assert.throws(
    () => decodeNeoHash160({ type: 'ByteString', value: 'not-a-hash160' }),
    /unsupported Hash160/
  );
  assert.throws(() => decodeNeoHash160({ type: 'InteropInterface' }), /empty|unsupported/);
});

test('finalizePusherCycle is fail-closed on fetch, push, ABI, and missing-symbol faults', () => {
  const quotaError = Object.assign(new Error('Daily credits exhausted'), {
    providerCategory: 'daily_quota_exhausted',
  });
  const quota = finalizePusherCycle({ fetchError: quotaError });
  assert.equal(quota.exitCode, 1);
  assert.equal(quota.errors[0].provider_category, 'daily_quota_exhausted');
  assert.equal(finalizePusherCycle({}).exitCode, 0);
  assert.equal(finalizePusherCycle({ fetchError: new Error('TD down') }).exitCode, 1);
  assert.equal(finalizePusherCycle({ chainErrors: [new Error('INSUFFICIENT_FUNDS')] }).exitCode, 1);
  const abi = finalizePusherCycle({
    chainErrors: [
      new Error('[neo-n3] testnet feed 0x9bea has no updateFeeds (has updateFeed=true)'),
    ],
  });
  assert.equal(abi.exitCode, 1);
  assert.equal(abi.errors[0].code, 'neo_n3_updatefeeds_missing');
  assert.equal(
    finalizePusherCycle({ missingAlerts: [{ symbol: 'WTI-USD', cycles: 3 }] }).exitCode,
    1
  );
});

test('systemd EnvironmentFile overrides Environment and exec-time env pins win', () => {
  const leftover = {
    FEED_NETWORK: 'testnet',
    FEED_CHAINS: 'neox',
    PUSH_LOG: '/opt/morpheus/nitro/feed-pusher-testnet.log',
    PUSH_STATUS: '/opt/morpheus/nitro/feed-pusher-testnet-status.json',
    MISSING_STATE: '/opt/morpheus/nitro/feed-pusher-testnet-missing.json',
    PUSH_PROM_TEXTFILE: '/opt/morpheus/nitro/feed-pusher-testnet.prom',
    MONITOR_NETWORK: 'neo-n3-testnet',
    MONITOR_LOG: '/opt/morpheus/nitro/feed-monitor-testnet.log',
    MONITOR_STATUS: '/opt/morpheus/nitro/feed-status-testnet.json',
    MONITOR_PROM_TEXTFILE: '/opt/morpheus/nitro/feed-monitor-testnet.prom',
  };
  const environment = { FEED_NETWORK: 'mainnet', FEED_CHAINS: 'neo-n3' };
  const systemdMerged = applySystemdServiceEnv({
    environment,
    environmentFile: leftover,
  });
  assert.equal(systemdMerged.FEED_NETWORK, 'testnet');
  assert.equal(systemdMerged.PUSH_LOG, leftover.PUSH_LOG);

  const pinned = applySystemdServiceEnv({
    environment,
    environmentFile: leftover,
    execEnv: FEED_UNIT_PINNED_ENV['morpheus-feed-pusher.service'],
  });
  assert.equal(pinned.FEED_NETWORK, 'mainnet');
  assert.equal(pinned.FEED_CHAINS, 'neo-n3');
  assert.equal(pinned.PUSH_LOG, '/opt/morpheus/nitro/feed-pusher.log');
  assert.equal(pinned.PUSH_STATUS, '/opt/morpheus/nitro/feed-pusher-status.json');
  assert.equal(pinned.MISSING_STATE, '/opt/morpheus/nitro/feed-pusher-missing.json');
  assert.equal(pinned.PUSH_PROM_TEXTFILE, '');
  assert.notEqual(pinned.PUSH_LOG, leftover.PUSH_LOG);
  assert.notEqual(pinned.PUSH_PROM_TEXTFILE, leftover.PUSH_PROM_TEXTFILE);

  const monitorPinned = applySystemdServiceEnv({
    environment: { FEED_NETWORK: 'mainnet' },
    environmentFile: leftover,
    execEnv: FEED_UNIT_PINNED_ENV['morpheus-feed-monitor.service'],
  });
  assert.equal(monitorPinned.MONITOR_NETWORK, 'neo-n3');
  assert.equal(monitorPinned.MONITOR_PROM_TEXTFILE, '');
  assert.notEqual(monitorPinned.MONITOR_STATUS, leftover.MONITOR_STATUS);
});

test('parseExecStartEnvPins reads /usr/bin/env assignments including empty values', () => {
  const pins = parseExecStartEnvPins(
    '/usr/bin/env FEED_NETWORK=mainnet MONITOR_PROM_TEXTFILE= /usr/bin/node feed-monitor.mjs'
  );
  assert.equal(pins.FEED_NETWORK, 'mainnet');
  assert.equal(pins.MONITOR_PROM_TEXTFILE, '');
});

test('decodeGetAllFeedRecords fails closed on FAULT, empty, malformed, and mixed rows', () => {
  assert.deepEqual(decodeGetAllFeedRecords({ state: 'FAULT', stack: [] }), {
    ok: false,
    reason: 'fault',
    rows: [],
    record_count: 0,
    decoded_count: 0,
    undecodable_count: 0,
  });
  assert.equal(
    decodeGetAllFeedRecords({ state: 'HALT', stack: [{ type: 'Array', value: [] }] }).reason,
    'empty'
  );
  assert.equal(
    decodeGetAllFeedRecords({ state: 'HALT', stack: [{ type: 'Integer', value: '1' }] }).reason,
    'malformed'
  );
  const mixed = decodeGetAllFeedRecords({
    state: 'HALT',
    stack: [
      {
        type: 'Array',
        value: [
          {
            type: 'Struct',
            value: [
              { type: 'ByteString', value: Buffer.from('TWELVEDATA:NEO-USD').toString('base64') },
              { type: 'Integer', value: '1' },
              { type: 'Integer', value: '5250000' },
              { type: 'Integer', value: '1780000000' },
            ],
          },
          { type: 'Struct', value: [{ type: 'ByteString', value: '' }] },
        ],
      },
    ],
  });
  assert.equal(mixed.ok, false);
  assert.equal(mixed.reason, 'undecodable');
  assert.equal(mixed.record_count, 2);
  assert.equal(mixed.decoded_count, 1);
  assert.equal(mixed.undecodable_count, 1);
  assert.equal(
    decodeGetAllFeedRecords({
      state: 'FAULT',
      exception: 'Method "getAllFeedRecords" with 0 parameter(s) doesn\'t exist in the contract.',
    }).reason,
    'unsupported_method'
  );
  assert.equal(isMissingGetAllFeedRecordsError('method not found: getAllFeedRecords/0'), true);
});

test('isMissingGetAllFeedRecordsError matches only exact Neo/JSON-RPC missing-method signatures', () => {
  assert.equal(isMissingGetAllFeedRecordsError('method not found: getAllFeedRecords/0'), true);
  assert.equal(
    isMissingGetAllFeedRecordsError(
      'Method "getAllFeedRecords" with 0 parameter(s) doesn\'t exist in the contract.'
    ),
    true
  );
  assert.equal(
    isMissingGetAllFeedRecordsError({
      code: -32601,
      message: 'Method not found: getAllFeedRecords/0',
    }),
    true
  );
  assert.equal(
    isMissingGetAllFeedRecordsError({
      error: { code: -32601, message: 'Method not found: getAllFeedRecords' },
    }),
    true
  );

  assert.equal(
    isMissingGetAllFeedRecordsError('The given key does not exist in the storage'),
    false
  );
  assert.equal(isMissingGetAllFeedRecordsError('getAllFeedRecords: the key does not exist'), false);
  assert.equal(
    isMissingGetAllFeedRecordsError('Method getAllFeedRecords failed: key does not exist'),
    false
  );
  assert.equal(
    isMissingGetAllFeedRecordsError({
      code: -100,
      message: 'getAllFeedRecords: key does not exist',
    }),
    false
  );
  assert.equal(
    isMissingGetAllFeedRecordsError({ code: -32601, message: 'Method not found' }),
    false
  );
  assert.equal(isMissingGetAllFeedRecordsError('method not found: updateFeeds/6'), false);
  assert.equal(
    decodeGetAllFeedRecords({
      state: 'FAULT',
      exception: 'getAllFeedRecords: the key does not exist',
    }).reason,
    'fault'
  );
});

test('resolveFeedTopupPaths keeps testnet log and env files off the mainnet paths', () => {
  const mainnet = resolveFeedTopupPaths({ FEED_NETWORK: 'mainnet' });
  const testnet = resolveFeedTopupPaths({ FEED_NETWORK: 'testnet' });
  assert.equal(mainnet.log, '/opt/morpheus/nitro/feed-topup.log');
  assert.equal(mainnet.envFile, '/opt/morpheus/nitro/feed-topup.env');
  assert.equal(testnet.log, '/opt/morpheus/nitro/feed-topup-testnet.log');
  assert.equal(testnet.envFile, '/opt/morpheus/nitro/feed-topup-testnet.env');
  assert.notEqual(testnet.log, mainnet.log);
  assert.notEqual(testnet.envFile, mainnet.envFile);
});

test('feed-pusher.env.example does not assign reserved unit pins or unused FEED_RPC', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const text = readFileSync(path.join(here, 'feed-pusher.env.example'), 'utf8');
  const assigned = parseEnvFileAssignments(text);
  assert.deepEqual(reservedKeysPresent(assigned), []);
  assert.equal(Object.hasOwn(assigned, 'FEED_RPC'), false);
});

test('encodeUpdateFeedInvocation shares production parameter types with the captured TestNet ABI', () => {
  const encoded = encodeUpdateFeedInvocation({
    pair: 'NEO-USD',
    roundId: 7,
    price: 5_250_000,
    timestamp: 1_780_000_000,
    attestationHash: 'aabb',
    sourceSetId: 0,
  });
  const fixture = TESTNET_STATE.manifest.abi.methods.find((method) => method.name === 'updateFeed');
  assert.deepEqual(
    encoded.params.map((param) => param.type),
    UPDATE_FEED_PARAMETERS.map((param) => param.type)
  );
  assert.deepEqual(
    fixture.parameters.map((param) => param.type),
    UPDATE_FEED_PARAMETERS.map((param) => param.type)
  );
  assert.deepEqual(
    MAINNET_STATE.manifest.abi.methods
      .find((method) => method.name === 'updateFeeds')
      .parameters.map((param) => param.type),
    UPDATE_FEEDS_PARAMETERS.map((param) => param.type)
  );
});

test('shared write report distinguishes submitted pending confirmed skipped failure', () => {
  const identity = createSignedFeedTxIdentity({
    nonce: 7,
    validUntilBlock: 100,
    messageHex: 'aa',
    hash: '0xabc',
    rawTx: 'raw',
  });
  const report = createFeedWriteReport({
    planned: ['TWELVEDATA:NEO-USD', 'TWELVEDATA:GAS-USD'],
    skipped: ['TWELVEDATA:BTC-USD'],
    writeMode: FEED_WRITE_MODE_BATCH,
  });
  markFeedWriteSubmitted(report, {
    pairs: ['TWELVEDATA:NEO-USD', 'TWELVEDATA:GAS-USD'],
    identity,
  });
  assert.equal(deriveConfirmationStatus(report), 'submitted');
  assert.equal(report.submitted_identity.hash, '0xabc');
  assert.deepEqual(report.pending, []);

  applyWriteConfirmation(report, {
    pairs: ['TWELVEDATA:NEO-USD', 'TWELVEDATA:GAS-USD'],
    confirmation: { status: 'timeout', reason: 'unknown_transaction' },
    identity,
  });
  finalizeFeedWrite(report);
  assert.equal(report.ok, false);
  assert.equal(deriveConfirmationStatus(report), 'pending');

  const halted = createFeedWriteReport({
    planned: ['TWELVEDATA:NEO-USD'],
    writeMode: FEED_WRITE_MODE_BATCH,
  });
  applyWriteConfirmation(halted, {
    pairs: ['TWELVEDATA:NEO-USD'],
    confirmation: { status: 'confirmed', vmstate: 'HALT' },
    identity,
  });
  finalizeFeedWrite(halted);
  assert.equal(halted.ok, true);
  assert.equal(deriveConfirmationStatus(halted), 'confirmed');

  const faulted = createFeedWriteReport({
    planned: ['TWELVEDATA:NEO-USD'],
    writeMode: FEED_WRITE_MODE_BATCH,
  });
  applyWriteConfirmation(faulted, {
    pairs: ['TWELVEDATA:NEO-USD'],
    confirmation: { status: 'fault', exception: 'denied' },
    identity,
  });
  finalizeFeedWrite(faulted);
  assert.equal(faulted.ok, false);
  assert.equal(deriveConfirmationStatus(faulted), 'failed');

  const skipped = createFeedWriteReport({
    planned: [],
    skipped: ['TWELVEDATA:NEO-USD'],
    writeMode: FEED_WRITE_MODE_BATCH,
  });
  finalizeFeedWrite(skipped);
  assert.equal(skipped.ok, true);
  assert.equal(deriveConfirmationStatus(skipped), 'skipped');
});

test('broadcast accept is not HALT confirmation', () => {
  assert.equal(assertBroadcastAccepted({ hash: '0xabc' }), '0xabc');
  assert.throws(() => assertBroadcastAccepted({}), /no hash/);
  assert.deepEqual(classifyApplicationLog({ executions: [{ vmstate: 'HALT' }] }), {
    status: 'confirmed',
    vmstate: 'HALT',
  });
  assert.equal(
    classifyApplicationLog({ executions: [{ vmstate: 'FAULT', exception: 'boom' }] }).status,
    'fault'
  );
  assert.equal(classifyApplicationLog(null, new Error('Unknown transaction')).status, 'pending');
});

test('confirmation poll is bounded and fail-closed on timeout or FAULT', async () => {
  let calls = 0;
  const pending = await confirmFeedApplicationLog({
    rpc: async () => {
      calls += 1;
      throw new Error('Unknown transaction');
    },
    hash: '0xdead',
    attempts: 3,
    intervalMs: 0,
    sleep: async () => {},
  });
  assert.equal(pending.status, 'timeout');
  assert.equal(calls, 3);
  const faulted = await confirmFeedApplicationLog({
    rpc: async () => ({ executions: [{ vmstate: 'FAULT', exception: 'denied' }] }),
    hash: '0xbeef',
    attempts: 4,
    intervalMs: 0,
    sleep: async () => {},
  });
  assert.equal(faulted.status, 'fault');
  assert.equal(faulted.attempts, 1);
});

test('retry taxonomy is structured transport codes only', () => {
  assert.equal(
    isRetryablePerPairError(
      Object.assign(new Error('timed out'), { name: 'TimeoutError', code: 'ABORT_ERR' })
    ),
    true
  );
  assert.equal(
    isRetryablePerPairError(Object.assign(new Error('reset'), { code: 'ECONNRESET' })),
    true
  );
  assert.equal(isRetryablePerPairError(new Error('enclave /feed/sign timed out')), false);
  assert.equal(isRetryablePerPairError(new Error('Invalid network fee')), false);
  assert.equal(classifyBroadcastOutcome(new Error('AlreadyExists')).kind, 'already_exists');
  const identity = createSignedFeedTxIdentity({
    nonce: 1,
    validUntilBlock: 100,
    messageHex: 'aa',
    hash: '0x11',
    rawTx: 'raw',
  });
  assert.equal(canReplaceSignedTxIdentity(identity, { knownOnChain: true }), false);
  assert.equal(canReplaceSignedTxIdentity(identity, { rejected: true }), true);
  assert.equal(canReplaceSignedTxIdentity(identity, { validUntilExpired: true }), true);
  assert.equal(canReplaceSignedTxIdentity(identity, {}), false);
});

test('enclave network identity binds magic/network/updater and refuses split-brain', () => {
  __resetBoundEnclaveNetworkIdentityForTests();
  const identity = bindEnclaveNetworkIdentity({
    FEED_NETWORK: 'testnet',
    FEED_MAGIC: String(FEED_NETWORK_DEFAULTS.testnet.magic),
    MORPHEUS_NETWORK: 'testnet',
  });
  assert.equal(identity.network, 'testnet');
  assert.equal(identity.magic, FEED_NETWORK_DEFAULTS.testnet.magic);
  assert.equal(identity.updaterRole, 'updater');
  assert.equal(identity.updaterSh, FEED_NETWORK_DEFAULTS.testnet.updaterSh);
  assert.throws(
    () =>
      bindEnclaveNetworkIdentity({
        FEED_NETWORK: 'mainnet',
        FEED_MAGIC: String(FEED_NETWORK_DEFAULTS.mainnet.magic),
        MORPHEUS_NETWORK: 'mainnet',
      }),
    /immutable/
  );
  __resetBoundEnclaveNetworkIdentityForTests();
  assert.throws(
    () =>
      bindEnclaveNetworkIdentity({
        FEED_NETWORK: 'testnet',
        FEED_MAGIC: String(FEED_NETWORK_DEFAULTS.mainnet.magic),
        MORPHEUS_NETWORK: 'testnet',
      }),
    /FEED_MAGIC does not match/
  );
  assert.throws(
    () =>
      bindEnclaveNetworkIdentity({
        FEED_NETWORK: 'testnet',
        FEED_MAGIC: String(FEED_NETWORK_DEFAULTS.testnet.magic),
        MORPHEUS_NETWORK: 'mainnet',
      }),
    /split-brain/
  );
});
