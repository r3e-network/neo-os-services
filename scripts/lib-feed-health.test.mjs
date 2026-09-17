import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { FEED_NETWORK_DEFAULTS } from '../deploy/feed-pusher/lib-feed-network.mjs';
import {
  DEFAULT_RETIRED_PAIRS,
  buildFeedHealthReport,
  classifyAwsDiagnostic,
  classifyPairAgainstSlo,
  decodeFeedRecordsFromInvoke,
  diagnoseFeedHealth,
  feedHealthExitCode,
  formatFeedHealthHeadline,
  inspectAwsIdentity,
  DOCUMENTED_AWS_PROFILE,
  parseFeedHealthArgs,
  parseOnchainFeedHealthRows,
  summarizeFeedHealthReports,
} from './lib-feed-health.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('parseFeedHealthArgs defaults to all networks and a 6 hour SLO', () => {
  assert.deepEqual(parseFeedHealthArgs([]), {
    network: 'all',
    staleHours: 6,
    json: false,
    skipAws: false,
  });
  assert.deepEqual(parseFeedHealthArgs(['--network', 'testnet', '--stale-hours', '6', '--json']), {
    network: 'testnet',
    staleHours: 6,
    json: true,
    skipAws: false,
  });
  assert.deepEqual(parseFeedHealthArgs(['--skip-aws', '--json']), {
    network: 'all',
    staleHours: 6,
    json: true,
    skipAws: true,
  });
});

test('retired-pair policy matches the single checked source', () => {
  assert.deepEqual([...DEFAULT_RETIRED_PAIRS], [
    'COPPER-USD',
    'FLM-USD',
    '1000FLM-USD',
    '1000JPY-USD',
  ]);
});

test('classifyPairAgainstSlo treats retired pairs as stale-but-not-failing', () => {
  const nowMs = Date.parse('2026-08-31T13:00:00.000Z');
  const neo = classifyPairAgainstSlo(
    { pair: 'TWELVEDATA:NEO-USD', timestamp: Date.parse('2026-08-22T22:00:07.000Z') / 1000 },
    nowMs,
    6
  );
  assert.equal(neo.stale, true);
  assert.equal(neo.retired, false);
  assert.equal(neo.active_stale, true);
  assert.equal(neo.clock_skew, false);
  const flm = classifyPairAgainstSlo(
    { pair: 'TWELVEDATA:FLM-USD', timestamp: Date.parse('2026-05-05T14:06:00.000Z') / 1000 },
    nowMs,
    6
  );
  assert.equal(flm.retired, true);
  assert.equal(flm.active_stale, false);
});

test('classifyPairAgainstSlo does not treat a future timestamp as ordinary stale', () => {
  const nowMs = Date.parse('2026-08-31T13:00:00.000Z');
  const future = classifyPairAgainstSlo(
    { pair: 'TWELVEDATA:NEO-USD', timestamp: nowMs / 1000 + 3600 },
    nowMs,
    6
  );
  assert.equal(future.clock_skew, true);
  assert.equal(future.stale, false);
  assert.equal(future.active_stale, false);
});

test('decodeFeedRecordsFromInvoke fails closed on FAULT, empty, malformed, and undecodable stacks', () => {
  assert.deepEqual(decodeFeedRecordsFromInvoke({ state: 'FAULT', stack: [] }), {
    ok: false,
    reason: 'fault',
    rows: [],
    record_count: 0,
    decoded_count: 0,
    undecodable_count: 0,
  });
  assert.deepEqual(decodeFeedRecordsFromInvoke({ state: 'HALT', stack: [{ type: 'Array', value: [] }] }), {
    ok: false,
    reason: 'empty',
    rows: [],
    record_count: 0,
    decoded_count: 0,
    undecodable_count: 0,
  });
  assert.deepEqual(decodeFeedRecordsFromInvoke({ state: 'HALT', stack: [{ type: 'Integer', value: '1' }] }), {
    ok: false,
    reason: 'malformed',
    rows: [],
    record_count: 0,
    decoded_count: 0,
    undecodable_count: 0,
  });
  const allBad = decodeFeedRecordsFromInvoke({
    state: 'HALT',
    stack: [{ type: 'Array', value: [{ type: 'Struct', value: [{ type: 'ByteString', value: '' }] }] }],
  });
  assert.equal(allBad.ok, false);
  assert.equal(allBad.reason, 'undecodable');
  assert.equal(allBad.record_count, 1);
  assert.equal(allBad.decoded_count, 0);
  assert.equal(allBad.undecodable_count, 1);
});

test('diagnoseFeedHealth names the confirmed testnet writer defects and rules out funded GAS', () => {
  const nowMs = Date.parse('2026-08-31T13:00:00.000Z');
  const pairs = parseOnchainFeedHealthRows(
    [
      { pair: 'TWELVEDATA:NEO-USD', timestamp: Date.parse('2026-08-22T22:00:07.000Z') / 1000 },
      { pair: 'TWELVEDATA:GAS-USD', timestamp: Date.parse('2026-08-22T18:51:08.000Z') / 1000 },
      { pair: 'TWELVEDATA:FLM-USD', timestamp: Date.parse('2026-05-05T14:06:00.000Z') / 1000 },
      { pair: 'TWELVEDATA:COPPER-USD', timestamp: Date.parse('2026-03-23T00:00:00.000Z') / 1000 },
    ],
    nowMs,
    6
  );
  const report = diagnoseFeedHealth({
    network: 'testnet',
    resolved: {
      feed: FEED_NETWORK_DEFAULTS.testnet.feed,
      updaterSh: FEED_NETWORK_DEFAULTS.testnet.updaterSh,
    },
    pairs,
    updaterGas: 9026.45,
    onchainUpdater: `0x${FEED_NETWORK_DEFAULTS.testnet.updaterSh}`,
    abi: { probed: true, has_update_feeds: false, has_update_feed: true, methods: ['updateFeed'] },
    aws: { reachable: false, reason: 'credentials_absent' },
  });

  assert.equal(report.ok, false);
  assert.equal(report.counts.active_stale, 2);
  assert.equal(report.counts.retired_stale, 2);
  const codes = report.root_causes.map((entry) => entry.code);
  assert.ok(codes.includes('testnet_abi_missing_updateFeeds'));
  assert.ok(codes.includes('default_pusher_targets_mainnet'));
  assert.ok(codes.includes('all_active_pairs_beyond_slo'));
  assert.equal(codes.includes('live_writer_not_advancing'), false);
  assert.ok(report.ruled_out.some((entry) => entry.code === 'updater_gas_exhausted'));
  assert.ok(report.live_blockers.some((entry) => entry.code === 'aws_credentials_absent'));
  assert.ok(
    report.live_blockers.some(
      (entry) => entry.code === 'testnet_write_requires_deployed_updatefeed_writer'
    )
  );
  assert.match(formatFeedHealthHeadline({ network: 'testnet', ...report }), /FAIL/);
});

test('diagnoseFeedHealth is ok when every active pair is inside the SLO', () => {
  const nowMs = Date.parse('2026-08-31T13:00:00.000Z');
  const pairs = parseOnchainFeedHealthRows(
    [
      { pair: 'TWELVEDATA:NEO-USD', timestamp: nowMs / 1000 - 600 },
      { pair: 'TWELVEDATA:FLM-USD', timestamp: nowMs / 1000 - 80 * 86400 },
    ],
    nowMs,
    6
  );
  const report = diagnoseFeedHealth({
    network: 'mainnet',
    resolved: {
      feed: FEED_NETWORK_DEFAULTS.mainnet.feed,
      updaterSh: FEED_NETWORK_DEFAULTS.mainnet.updaterSh,
    },
    pairs,
    updaterGas: 80,
    onchainUpdater: `0x${FEED_NETWORK_DEFAULTS.mainnet.updaterSh}`,
    abi: { probed: true, has_update_feeds: true, has_update_feed: false, methods: ['updateFeeds'] },
    aws: { reachable: true, reason: 'identity_ok' },
  });
  assert.equal(report.ok, true);
  assert.equal(report.counts.active_stale, 0);
  assert.equal(
    report.root_causes.length,
    0
  );
  assert.equal(
    report.root_causes.some((entry) => entry.code === 'live_writer_not_advancing'),
    false
  );
});

test('diagnoseFeedHealth names a funded writable mainnet as writer-host outage, not ABI mismatch', () => {
  const nowMs = Date.parse('2026-08-31T20:20:29.000Z');
  const pairs = parseOnchainFeedHealthRows(
    [
      { pair: 'TWELVEDATA:NEO-USD', timestamp: Date.parse('2026-08-29T09:39:01.000Z') / 1000 },
      { pair: 'TWELVEDATA:FLM-USD', timestamp: Date.parse('2026-08-20T17:27:00.000Z') / 1000 },
    ],
    nowMs,
    6
  );
  const report = diagnoseFeedHealth({
    network: 'mainnet',
    resolved: {
      feed: FEED_NETWORK_DEFAULTS.mainnet.feed,
      updaterSh: FEED_NETWORK_DEFAULTS.mainnet.updaterSh,
    },
    pairs,
    updaterGas: 40.892,
    onchainUpdater: `0x${FEED_NETWORK_DEFAULTS.mainnet.updaterSh}`,
    abi: { probed: true, has_update_feeds: true, has_update_feed: true, methods: ['updateFeeds'] },
    aws: { reachable: false, reason: 'skipped' },
  });
  assert.equal(report.ok, false);
  assert.equal(report.counts.active_stale, 1);
  const codes = report.root_causes.map((entry) => entry.code);
  assert.ok(codes.includes('all_active_pairs_beyond_slo'));
  assert.ok(codes.includes('live_writer_not_advancing'));
  assert.equal(codes.includes('testnet_abi_missing_updateFeeds'), false);
  assert.ok(report.ruled_out.some((entry) => entry.code === 'updater_gas_exhausted'));
  assert.ok(report.live_blockers.some((entry) => entry.code === 'aws_inspection_skipped'));
  assert.match(
    report.live_blockers.find((entry) => entry.code === 'aws_inspection_skipped').summary,
    /skipped|cannot inspect/
  );
});

test('inspectAwsIdentity distinguishes absent, expired/denied, and unreachable without echoing secrets', () => {
  assert.deepEqual(
    inspectAwsIdentity(() => {
      const error = new Error('spawn aws ENOENT');
      error.stderr =
        'Unable to locate credentials. You can configure credentials by running "aws configure".';
      throw error;
    }),
    { reachable: false, reason: 'credentials_absent' }
  );
  assert.equal(classifyAwsDiagnostic('ExpiredToken: The security token included in the request is expired'), 'credentials_expired_or_denied');
  assert.equal(classifyAwsDiagnostic('An error occurred (AccessDenied)'), 'credentials_expired_or_denied');
  const denied = inspectAwsIdentity(() => {
    const error = new Error('AccessDenied');
    error.stderr = 'An error occurred (ExpiredToken) arn:aws:iam::123456789012:user/secret-op';
    throw error;
  });
  assert.deepEqual(denied, { reachable: false, reason: 'credentials_expired_or_denied' });
  assert.equal(JSON.stringify(denied).includes('123456789012'), false);
  assert.equal(classifyAwsDiagnostic('Could not connect to the endpoint URL'), 'aws_unreachable');
  assert.equal(
    classifyAwsDiagnostic('TLS connection expired while connecting to the endpoint'),
    'aws_unreachable'
  );
  const missingCli = inspectAwsIdentity(() => {
    const error = new Error('spawn aws ENOENT');
    error.stderr = '';
    throw error;
  });
  assert.deepEqual(missingCli, { reachable: false, reason: 'aws_unreachable' });
  assert.equal(Object.hasOwn(missingCli, 'stderr'), false);
  assert.equal(Object.hasOwn(missingCli, 'identity'), false);
});

test('inspectAwsIdentity retries documented morpheus profile when default credentials are absent', () => {
  assert.equal(DOCUMENTED_AWS_PROFILE, 'morpheus');
  const profiles = [];
  const recovered = inspectAwsIdentity((cmd, args, opts) => {
    assert.equal(cmd, 'aws');
    assert.deepEqual(args, ['sts', 'get-caller-identity', '--output', 'text']);
    profiles.push(opts?.env?.AWS_PROFILE || '');
    if (opts?.env?.AWS_PROFILE === 'morpheus') {
      return 'ok-text';
    }
    const error = new Error('Unable to locate credentials');
    error.stderr = 'Unable to locate credentials. You can configure credentials by running "aws configure".';
    throw error;
  }, {});
  assert.deepEqual(recovered, {
    reachable: true,
    reason: 'identity_ok',
    profile: 'morpheus',
  });
  assert.deepEqual(profiles, ['', 'morpheus']);
  assert.equal(JSON.stringify(recovered).includes('arn:'), false);
});

test('inspectAwsIdentity does not substitute the documented profile when AWS_PROFILE is already set', () => {
  const profiles = [];
  const denied = inspectAwsIdentity((cmd, args, opts) => {
    profiles.push(opts?.env?.AWS_PROFILE || '');
    const error = new Error('Unable to locate credentials');
    error.stderr = 'Unable to locate credentials. You can configure credentials by running "aws configure".';
    throw error;
  }, { AWS_PROFILE: 'other', PATH: '/usr/bin' });
  assert.deepEqual(denied, { reachable: false, reason: 'credentials_absent' });
  assert.deepEqual(profiles, ['other']);
});

test('summarizeFeedHealthReports distinguishes stale (1) from unreadable (2)', () => {
  const stale = summarizeFeedHealthReports([{ network: 'testnet', ok: false, readable: true, headline: 'FAIL' }]);
  assert.equal(stale.ok, false);
  assert.equal(stale.exit_code, 1);
  const unreadable = summarizeFeedHealthReports([
    { network: 'testnet', ok: false, readable: false, headline: 'UNREADABLE' },
  ]);
  assert.equal(unreadable.exit_code, 2);
  assert.equal(feedHealthExitCode({ ok: false, readable: true, counts: { clock_skew: 1 } }), 2);
});

function recordStruct(pair, timestamp) {
  return {
    type: 'Struct',
    value: [
      { type: 'ByteString', value: Buffer.from(pair).toString('base64') },
      { type: 'Integer', value: '1' },
      { type: 'Integer', value: '5250000' },
      { type: 'Integer', value: String(timestamp) },
    ],
  };
}

function healthSeams({ recordsResult, updater = `0x${FEED_NETWORK_DEFAULTS.testnet.updaterSh}`, magic = 894710606 }) {
  return {
    invoke: (_urls, _contract, operation) => {
      if (operation === 'getAllFeedRecords') return recordsResult;
      if (operation === 'updater') {
        return { state: 'HALT', stack: [{ type: 'Hash160', value: updater }] };
      }
      return { state: 'HALT', stack: [{ type: 'Integer', value: String(9000e8) }] };
    },
    getContractState: () => ({
      manifest: { abi: { methods: [{ name: 'updateFeed' }, { name: 'getAllFeedRecords' }] } },
    }),
    getVersion: async () => ({ protocol: { network: magic } }),
    getBlockHeaderTime: async () => 1_788_177_600,
    inspectAws: () => ({ reachable: false, reason: 'credentials_absent' }),
    skipAws: false,
  };
}

test('buildFeedHealthReport fails closed on FAULT getAllFeedRecords', async () => {
  const report = await buildFeedHealthReport({
    repoRoot: REPO_ROOT,
    network: 'testnet',
    staleHours: 6,
    ...healthSeams({ recordsResult: { state: 'FAULT', exception: 'bad' } }),
  });
  assert.equal(report.readable, false);
  assert.equal(report.unreadable_reason, 'fault');
  assert.equal(report.ok, false);
  assert.equal(feedHealthExitCode(report), 2);
});

test('buildFeedHealthReport fails closed on an empty HALT registry', async () => {
  const report = await buildFeedHealthReport({
    repoRoot: REPO_ROOT,
    network: 'testnet',
    staleHours: 6,
    ...healthSeams({ recordsResult: { state: 'HALT', stack: [{ type: 'Array', value: [] }] } }),
  });
  assert.equal(report.unreadable_reason, 'empty');
  assert.equal(feedHealthExitCode(report), 2);
});

test('buildFeedHealthReport uses header time so a future wall-clock pair is not ordinary stale', async () => {
  const header = 1_788_177_600;
  const report = await buildFeedHealthReport({
    repoRoot: REPO_ROOT,
    network: 'testnet',
    staleHours: 6,
    nowMs: (header + 7200) * 1000,
    ...healthSeams({
      recordsResult: {
        state: 'HALT',
        stack: [
          {
            type: 'Array',
            value: [recordStruct('TWELVEDATA:NEO-USD', header + 3600)],
          },
        ],
      },
    }),
  });
  assert.equal(report.readable, true);
  assert.equal(report.pairs[0].clock_skew, true);
  assert.equal(report.pairs[0].stale, false);
  assert.equal(feedHealthExitCode(report), 2);
});

test('buildFeedHealthReport fails closed on a mixed valid+undecodable registry', async () => {
  const report = await buildFeedHealthReport({
    repoRoot: REPO_ROOT,
    network: 'testnet',
    staleHours: 6,
    ...healthSeams({
      recordsResult: {
        state: 'HALT',
        stack: [
          {
            type: 'Array',
            value: [
              recordStruct('TWELVEDATA:NEO-USD', 1_788_177_000),
              { type: 'Struct', value: [{ type: 'ByteString', value: '' }] },
            ],
          },
        ],
      },
    }),
  });
  assert.equal(report.readable, false);
  assert.equal(report.unreadable_reason, 'undecodable');
  assert.deepEqual(report.decode_counts, {
    record_count: 2,
    decoded_count: 1,
    undecodable_count: 1,
  });
  assert.equal(feedHealthExitCode(report), 2);
  assert.equal(report.ok, false);
});

test('buildFeedHealthReport rejects candidate RPCs whose getversion magic does not match', async () => {
  const report = await buildFeedHealthReport({
    repoRoot: REPO_ROOT,
    network: 'testnet',
    staleHours: 6,
    ...healthSeams({
      recordsResult: { state: 'HALT', stack: [{ type: 'Array', value: [recordStruct('TWELVEDATA:NEO-USD', 1)] }] },
      magic: 860833102,
    }),
  });
  assert.equal(report.readable, false);
  assert.equal(report.unreadable_reason, 'rpc_magic_unvalidated');
  assert.equal(feedHealthExitCode(report), 2);
});
