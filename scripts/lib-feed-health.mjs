import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  CLOCK_SKEW_TOLERANCE_SEC,
  DEFAULT_RETIRED_FEED_PAIRS,
  DOCUMENTED_FEED_PUSHER_INSTANCE,
  FEED_GAS_WARN_DEFAULT,
  FEED_NETWORK_DEFAULTS,
  FEED_SLO_SECONDS,
  decodeGetAllFeedRecords,
  decodeNeoHash160,
  normalizeChainUnixTime,
  parseContractUpdateMethods,
  resolveFeedNetwork,
  selectRpcsMatchingMagic,
} from '../deploy/feed-pusher/lib-feed-network.mjs';
import { invokeNeoFunctionViaCurlWithFallback } from './lib-feed-freshness.mjs';
import { trimString } from './lib-strings.mjs';

export const DEFAULT_RETIRED_PAIRS = DEFAULT_RETIRED_FEED_PAIRS;

const GAS_SCRIPT_HASH = 'd2a4cff31913016155e38e474a2c06d08be276cf';

export function parseFeedHealthArgs(argv = []) {
  const parsed = {
    network: 'all',
    staleHours: 6,
    json: false,
    skipAws: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (current === '--network') {
      parsed.network = trimString(argv[index + 1] || parsed.network).toLowerCase();
      index += 1;
    } else if (current === '--stale-hours') {
      const value = Number(argv[index + 1]);
      if (Number.isFinite(value) && value > 0) parsed.staleHours = value;
      index += 1;
    } else if (current === '--json') {
      parsed.json = true;
    } else if (current === '--skip-aws') {
      parsed.skipAws = true;
    }
  }
  if (!['all', 'mainnet', 'testnet'].includes(parsed.network)) {
    throw new Error(`--network must be all, mainnet, or testnet (got ${parsed.network})`);
  }
  return parsed;
}

export function barePair(pair) {
  return trimString(pair)
    .replace(/^TWELVEDATA:/i, '')
    .toUpperCase();
}

export function isRetiredPair(pair, retiredPairs = DEFAULT_RETIRED_PAIRS) {
  const retired = new Set([...retiredPairs].map((entry) => barePair(entry)).filter(Boolean));
  return retired.has(barePair(pair));
}

export function classifyPairAgainstSlo(
  record,
  nowMs,
  staleHours,
  retiredPairs = DEFAULT_RETIRED_PAIRS
) {
  const timestamp = Number(record?.timestamp || record?.ts || 0);
  const ageSeconds =
    Number.isFinite(timestamp) && timestamp > 0 ? Math.floor(nowMs / 1000) - timestamp : null;
  const sloSeconds = Math.round(Number(staleHours) * 3600) || FEED_SLO_SECONDS;
  const retired = isRetiredPair(record?.pair, retiredPairs);
  const clockSkew =
    Number.isFinite(ageSeconds) && ageSeconds < -CLOCK_SKEW_TOLERANCE_SEC;
  const stale = !clockSkew && (ageSeconds == null || ageSeconds > sloSeconds);
  return {
    pair: trimString(record?.pair),
    bare_pair: barePair(record?.pair),
    price: record?.price ?? null,
    round_id: record?.round_id ?? record?.round ?? null,
    timestamp: Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null,
    timestamp_iso:
      Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp * 1000).toISOString() : null,
    age_seconds: ageSeconds,
    slo_seconds: sloSeconds,
    stale,
    clock_skew: clockSkew,
    retired,
    active_stale: stale && !retired,
  };
}

export function clusterWriteDays(pairs = []) {
  const clusters = {};
  for (const row of pairs) {
    const day = row.timestamp_iso ? row.timestamp_iso.slice(0, 10) : 'none';
    clusters[day] = (clusters[day] || 0) + 1;
  }
  return clusters;
}

export function parseOnchainFeedHealthRows(records, nowMs, staleHours, retiredPairs) {
  return (records || []).map((record) =>
    classifyPairAgainstSlo(record, nowMs, staleHours, retiredPairs)
  );
}

export function decodeFeedRecordsFromInvoke(result) {
  const decoded = decodeGetAllFeedRecords(result);
  return {
    ok: decoded.ok,
    reason: decoded.reason,
    rows: decoded.rows,
    record_count: decoded.record_count,
    decoded_count: decoded.decoded_count,
    undecodable_count: decoded.undecodable_count,
  };
}

function cause(code, severity, summary, evidence = null) {
  return { code, severity, summary, evidence };
}

const AWS_BLOCKER_CODES = Object.freeze({
  credentials_absent: 'aws_credentials_absent',
  credentials_expired_or_denied: 'aws_credentials_expired_or_denied',
  aws_unreachable: 'aws_unreachable',
  skipped: 'aws_inspection_skipped',
});

export function diagnoseFeedHealth({
  network,
  resolved,
  pairs = [],
  updaterGas = null,
  onchainUpdater = '',
  abi = { probed: false },
  aws = { reachable: false, reason: 'not_checked' },
  gasWarn = FEED_GAS_WARN_DEFAULT,
  readable = true,
  unreadableReason = null,
  decodeCounts = null,
} = {}) {
  const rootCauses = [];
  const ruledOut = [];
  const liveBlockers = [];
  const active = pairs.filter((row) => !row.retired);
  const activeStale = pairs.filter((row) => row.active_stale);
  const retiredStale = pairs.filter((row) => row.retired && row.stale);
  const clockSkewRows = pairs.filter((row) => row.clock_skew && !row.retired);
  const newest = [...pairs].sort((a, b) => (a.age_seconds ?? 1e18) - (b.age_seconds ?? 1e18))[0];
  const oldest = [...pairs].sort((a, b) => (b.age_seconds ?? -1) - (a.age_seconds ?? -1))[0];

  if (!readable) {
    rootCauses.push(
      cause(
        'getAllFeedRecords_unreadable',
        'confirmed',
        `getAllFeedRecords is not a healthy empty feed (${unreadableReason || 'unreadable'})`,
        { reason: unreadableReason, decode_counts: decodeCounts }
      )
    );
  }

  if (clockSkewRows.length) {
    rootCauses.push(
      cause(
        'future_timestamp_clock_skew',
        'confirmed',
        `${clockSkewRows.length} active pair(s) have timestamps ahead of chain/header time`,
        { pairs: clockSkewRows.map((row) => row.bare_pair) }
      )
    );
  }

  if (abi.probed && abi.has_update_feeds === false) {
    rootCauses.push(
      cause(
        'testnet_abi_missing_updateFeeds',
        'confirmed',
        `${network} contract 0x${resolved?.feed} exposes updateFeed but not updateFeeds; live writes need the testnet-only per-pair writer after deploy`,
        { has_update_feed: abi.has_update_feed, methods: abi.methods }
      )
    );
  }

  const defaultMainnet = resolveFeedNetwork({});
  if (network === 'testnet' && defaultMainnet.feed === FEED_NETWORK_DEFAULTS.mainnet.feed) {
    rootCauses.push(
      cause(
        'default_pusher_targets_mainnet',
        'confirmed',
        'feed-pusher.mjs without FEED_NETWORK=testnet still targets mainnet 0x03013f49… — a default install never writes this contract',
        { default_feed: defaultMainnet.feed, testnet_feed: FEED_NETWORK_DEFAULTS.testnet.feed }
      )
    );
  }

  if (readable && active.length && activeStale.length === active.length) {
    rootCauses.push(
      cause(
        'all_active_pairs_beyond_slo',
        'confirmed',
        `every active pair is older than the ${Math.round((pairs[0]?.slo_seconds || FEED_SLO_SECONDS) / 3600)}h SLO`,
        {
          active: active.length,
          newest: newest ? { pair: newest.bare_pair, age_seconds: newest.age_seconds } : null,
        }
      )
    );
  } else if (readable && activeStale.length) {
    rootCauses.push(
      cause(
        'partial_active_pairs_beyond_slo',
        'confirmed',
        `${activeStale.length}/${active.length} active pairs are older than the SLO`,
        { stale_pairs: activeStale.map((row) => row.bare_pair) }
      )
    );
  }

  if (
    readable &&
    abi.probed &&
    abi.has_update_feeds === true &&
    Number.isFinite(updaterGas) &&
    updaterGas >= gasWarn &&
    active.length > 0 &&
    activeStale.length === active.length
  ) {
    rootCauses.push(
      cause(
        'live_writer_not_advancing',
        'confirmed',
        `${network} contract exposes updateFeeds and the updater is funded, but no active pair has been written inside the SLO — the host may be down, or a still-running writer may be cycling with no usable upstream quotes`,
        { has_update_feeds: true, updater_gas: updaterGas }
      )
    );
  }

  const expectedUpdater = resolved?.updaterSh ? `0x${resolved.updaterSh}` : '';
  if (onchainUpdater && expectedUpdater && onchainUpdater.toLowerCase() !== expectedUpdater) {
    rootCauses.push(
      cause(
        'updater_identity_mismatch',
        'confirmed',
        'on-chain updater() does not match the signer-identity pin for this network',
        { onchain_updater: onchainUpdater, expected_updater: expectedUpdater }
      )
    );
  }

  if (Number.isFinite(updaterGas) && updaterGas >= 0 && updaterGas < gasWarn) {
    rootCauses.push(
      cause(
        'updater_gas_exhausted',
        'confirmed',
        `updater GAS ${updaterGas.toFixed(3)} is below warn ${gasWarn}`,
        { updater_gas: updaterGas, gas_warn: gasWarn }
      )
    );
  } else if (Number.isFinite(updaterGas) && updaterGas >= gasWarn) {
    ruledOut.push(
      cause(
        'updater_gas_exhausted',
        'confirmed',
        `canonical ${network} updater holds ${updaterGas.toFixed(3)} GAS — funding is not why this feed is stale`,
        { updater_gas: updaterGas, gas_warn: gasWarn }
      )
    );
  }

  if (retiredStale.length) {
    ruledOut.push(
      cause(
        'retired_pairs_expected_stale',
        'confirmed',
        `${retiredStale.length} retired pairs are stale by design and are excluded from the SLO fail`,
        { pairs: retiredStale.map((row) => row.bare_pair) }
      )
    );
  }

  const awsCode = AWS_BLOCKER_CODES[aws?.reason];
  if (aws && aws.reachable === false && awsCode) {
    liveBlockers.push(
      cause(
        awsCode,
        'live_blocker',
        aws.reason === 'skipped'
          ? `AWS inspection skipped; cannot inspect documented pusher instance ${DOCUMENTED_FEED_PUSHER_INSTANCE}`
          : `cannot inspect documented pusher instance ${DOCUMENTED_FEED_PUSHER_INSTANCE}`,
        { reason: aws.reason, instance: DOCUMENTED_FEED_PUSHER_INSTANCE }
      )
    );
  }

  if (network === 'testnet' && abi.probed && abi.has_update_feeds === false) {
    liveBlockers.push(
      cause(
        'testnet_write_requires_deployed_updatefeed_writer',
        'live_blocker',
        'this checkout has a fail-closed testnet per-pair updateFeed writer, but local implementation does not make TestNet healthy until it is deployed onto a funded signer/writer host',
        { writer: 'deploy/feed-pusher per_pair_update_feed', doc: 'docs/TESTNET-FEED-WRITER.md' }
      )
    );
  }

  const ok = Boolean(readable) && activeStale.length === 0 && clockSkewRows.length === 0;
  return {
    ok,
    readable: Boolean(readable),
    unreadable_reason: unreadableReason,
    root_causes: rootCauses,
    ruled_out: ruledOut,
    live_blockers: liveBlockers,
    counts: {
      total: pairs.length,
      fresh: pairs.filter((row) => !row.stale && !row.clock_skew).length,
      stale: pairs.filter((row) => row.stale).length,
      retired_stale: retiredStale.length,
      active: active.length,
      active_stale: activeStale.length,
      clock_skew: clockSkewRows.length,
    },
    newest: newest || null,
    oldest: oldest || null,
    age_clusters: clusterWriteDays(pairs),
  };
}

export function formatFeedHealthHeadline(report) {
  const counts = report.counts || {};
  const newest = report.newest;
  const ageH =
    newest && Number.isFinite(newest.age_seconds)
      ? `${(newest.age_seconds / 3600).toFixed(1)}h`
      : 'n/a';
  const status = report.readable === false ? 'UNREADABLE' : report.ok ? 'OK' : 'FAIL';
  return (
    `FEED HEALTH ${report.network} ${status} ` +
    `active_stale=${counts.active_stale || 0}/${counts.active || 0} ` +
    `(retired_stale=${counts.retired_stale || 0}) ` +
    `newest=${newest ? newest.bare_pair : 'none'} age=${ageH}`
  );
}

export function classifyAwsDiagnostic(detail) {
  const text = String(detail || '');
  if (/Unable to locate credentials/i.test(text)) {
    return 'credentials_absent';
  }
  if (
    /\b(ExpiredToken|ExpiredTokenException|AccessDenied|AccessDeniedException|UnauthorizedOperation|InvalidClientTokenId|TokenRefreshRequired|SignatureDoesNotMatch)\b/.test(
      text
    )
  ) {
    return 'credentials_expired_or_denied';
  }
  return 'aws_unreachable';
}

export const DOCUMENTED_AWS_PROFILE = 'morpheus';

function awsCliEnv(baseEnv, profile = '') {
  const env = { ...baseEnv };
  const selected = trimString(profile);
  if (selected) env.AWS_PROFILE = selected;
  else if (!trimString(env.AWS_PROFILE)) delete env.AWS_PROFILE;
  return env;
}

function probeAwsIdentity(execFileSyncImpl, env) {
  execFileSyncImpl('aws', ['sts', 'get-caller-identity', '--output', 'text'], {
    encoding: 'utf8',
    timeout: 8000,
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });
}

function awsFailureReason(error) {
  const stderr = String(error?.stderr || '');
  const message = String(error?.message || error || '');
  return classifyAwsDiagnostic(stderr || message);
}

export function inspectAwsIdentity(execFileSyncImpl = execFileSync, env = process.env) {
  const baseEnv = { ...env };
  try {
    probeAwsIdentity(execFileSyncImpl, awsCliEnv(baseEnv));
    return { reachable: true, reason: 'identity_ok' };
  } catch (error) {
    const reason = awsFailureReason(error);
    if (reason === 'credentials_absent' && !trimString(baseEnv.AWS_PROFILE)) {
      try {
        probeAwsIdentity(execFileSyncImpl, awsCliEnv(baseEnv, DOCUMENTED_AWS_PROFILE));
        return { reachable: true, reason: 'identity_ok', profile: DOCUMENTED_AWS_PROFILE };
      } catch (retryError) {
        return { reachable: false, reason: awsFailureReason(retryError) };
      }
    }
    return { reachable: false, reason };
  }
}

function invokeGetContractState(rpcUrls, contractHash, execFileSyncImpl = execFileSync) {
  const urls = Array.isArray(rpcUrls) ? rpcUrls : [rpcUrls];
  let lastError = null;
  for (const rpcUrl of urls) {
    try {
      const response = JSON.parse(
        execFileSyncImpl(
          'curl',
          [
            '-fsS',
            '--connect-timeout',
            '8',
            '--max-time',
            '20',
            trimString(rpcUrl),
            '-H',
            'Content-Type: application/json',
            '-d',
            JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'getcontractstate',
              params: [contractHash],
            }),
          ],
          { encoding: 'utf8', timeout: 25_000 }
        )
      );
      if (response.error) throw new Error(JSON.stringify(response.error));
      return response.result;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function probeGetVersionViaCurl(rpcUrl, execFileSyncImpl = execFileSync) {
  const response = JSON.parse(
    execFileSyncImpl(
      'curl',
      [
        '-fsS',
        '--connect-timeout',
        '8',
        '--max-time',
        '12',
        trimString(rpcUrl),
        '-H',
        'Content-Type: application/json',
        '-d',
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getversion', params: [] }),
      ],
      { encoding: 'utf8', timeout: 15_000 }
    )
  );
  if (response.error) throw new Error('getversion rpc error');
  return response.result;
}

function readBlockHeaderTimeViaCurl(rpcUrls, execFileSyncImpl = execFileSync) {
  const urls = Array.isArray(rpcUrls) ? rpcUrls : [rpcUrls];
  let lastError = null;
  for (const rpcUrl of urls) {
    try {
      const countResponse = JSON.parse(
        execFileSyncImpl(
          'curl',
          [
            '-fsS',
            '--connect-timeout',
            '8',
            '--max-time',
            '12',
            trimString(rpcUrl),
            '-H',
            'Content-Type: application/json',
            '-d',
            JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getblockcount', params: [] }),
          ],
          { encoding: 'utf8', timeout: 15_000 }
        )
      );
      const count = Number(countResponse.result);
      if (!Number.isFinite(count) || count < 1) throw new Error('getblockcount invalid');
      const blockResponse = JSON.parse(
        execFileSyncImpl(
          'curl',
          [
            '-fsS',
            '--connect-timeout',
            '8',
            '--max-time',
            '12',
            trimString(rpcUrl),
            '-H',
            'Content-Type: application/json',
            '-d',
            JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'getblock',
              params: [count - 1, 1],
            }),
          ],
          { encoding: 'utf8', timeout: 15_000 }
        )
      );
      return normalizeChainUnixTime(
        blockResponse.result?.time ?? blockResponse.result?.header?.time
      );
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function emptyUnreadableReport({
  network,
  staleHours,
  resolved,
  contract,
  reason,
  aws,
  abi = { probed: false, has_update_feeds: null, has_update_feed: null, methods: [] },
  onchainUpdater = null,
  updaterGas = null,
  chainTimeUnix = null,
  decodeCounts = null,
}) {
  const diagnosed = diagnoseFeedHealth({
    network,
    resolved,
    pairs: [],
    updaterGas,
    onchainUpdater,
    abi,
    aws,
    readable: false,
    unreadableReason: reason,
    decodeCounts,
  });
  return {
    network,
    read_only: true,
    chain_writes_performed: false,
    readable: false,
    unreadable_reason: reason,
    decode_counts: decodeCounts,
    slo_hours: staleHours,
    slo_seconds: Math.round(staleHours * 3600),
    contract,
    onchain_updater: onchainUpdater,
    expected_updater: `0x${resolved.updaterSh}`,
    updater_gas: updaterGas,
    abi,
    documented_pusher_instance: DOCUMENTED_FEED_PUSHER_INSTANCE,
    aws,
    pairs: [],
    chain_time_unix: chainTimeUnix,
    ...diagnosed,
    headline: formatFeedHealthHeadline({ network, ...diagnosed }),
  };
}

export function feedHealthExitCode(report) {
  if (report?.readable === false) return 2;
  if ((report?.counts?.clock_skew || 0) > 0) return 2;
  if (!report?.ok) return 1;
  return 0;
}

export async function buildFeedHealthReport({
  repoRoot,
  network,
  staleHours = 6,
  nowMs = Date.now(),
  invoke = invokeNeoFunctionViaCurlWithFallback,
  getContractState = invokeGetContractState,
  inspectAws = inspectAwsIdentity,
  getVersion = probeGetVersionViaCurl,
  getBlockHeaderTime = readBlockHeaderTimeViaCurl,
  skipAws = false,
} = {}) {
  const networkConfig = JSON.parse(
    await fs.readFile(path.join(repoRoot, 'config', 'networks', `${network}.json`), 'utf8')
  );
  const resolved = resolveFeedNetwork({ FEED_NETWORK: network });
  const configuredFeed = trimString(networkConfig.neo_n3?.contracts?.morpheus_datafeed || '');
  const contract = configuredFeed || `0x${resolved.feed}`;
  const candidateRpcs = [
    ...new Set(
      [
        ...resolved.rpcs,
        ...(Array.isArray(networkConfig.neo_n3?.rpc_urls) ? networkConfig.neo_n3.rpc_urls : []),
        trimString(networkConfig.neo_n3?.rpc_url || ''),
      ]
        .map((value) => trimString(value))
        .filter(Boolean)
    ),
  ];

  const aws = skipAws ? { reachable: false, reason: 'skipped' } : inspectAws();
  let invokeUrls;
  try {
    const selected = await selectRpcsMatchingMagic(candidateRpcs, resolved.magic, {
      probe: (url) => getVersion(url),
    });
    invokeUrls = selected.matched;
  } catch {
    return emptyUnreadableReport({
      network,
      staleHours,
      resolved,
      contract,
      reason: 'rpc_magic_unvalidated',
      aws,
    });
  }

  let chainTimeUnix = null;
  try {
    chainTimeUnix = await getBlockHeaderTime(invokeUrls);
  } catch {
    chainTimeUnix = null;
  }
  const effectiveNowMs = Number.isFinite(chainTimeUnix) && chainTimeUnix > 0 ? chainTimeUnix * 1000 : nowMs;

  let allRecordsResult;
  try {
    allRecordsResult = invoke(invokeUrls, contract, 'getAllFeedRecords', []);
  } catch {
    return emptyUnreadableReport({
      network,
      staleHours,
      resolved,
      contract,
      reason: 'undecodable',
      aws,
      chainTimeUnix,
    });
  }
  const decoded = decodeFeedRecordsFromInvoke(allRecordsResult);
  if (!decoded.ok) {
    return emptyUnreadableReport({
      network,
      staleHours,
      resolved,
      contract,
      reason: decoded.reason,
      aws,
      chainTimeUnix,
      decodeCounts: {
        record_count: decoded.record_count,
        decoded_count: decoded.decoded_count,
        undecodable_count: decoded.undecodable_count,
      },
    });
  }
  const pairs = parseOnchainFeedHealthRows(decoded.rows, effectiveNowMs, staleHours);

  let onchainUpdater = '';
  try {
    const updaterResult = invoke(invokeUrls, contract, 'updater', []);
    onchainUpdater = decodeNeoHash160(updaterResult?.stack?.[0]);
  } catch {
    onchainUpdater = '';
  }

  let updaterGas = null;
  const updaterForBalance = onchainUpdater || `0x${resolved.updaterSh}`;
  try {
    const gasResult = invoke(invokeUrls, `0x${GAS_SCRIPT_HASH}`, 'balanceOf', [
      { type: 'Hash160', value: updaterForBalance },
    ]);
    updaterGas = Number(gasResult?.stack?.[0]?.value || 0) / 1e8;
  } catch {
    updaterGas = null;
  }

  let abi = { probed: false, has_update_feeds: null, has_update_feed: null, methods: [] };
  try {
    const state = getContractState(invokeUrls, contract);
    abi = parseContractUpdateMethods(state?.manifest);
  } catch {
    abi = { probed: false, has_update_feeds: null, has_update_feed: null, methods: [] };
  }

  const diagnosed = diagnoseFeedHealth({
    network,
    resolved,
    pairs,
    updaterGas,
    onchainUpdater,
    abi,
    aws,
  });

  return {
    network,
    read_only: true,
    chain_writes_performed: false,
    readable: true,
    unreadable_reason: null,
    slo_hours: staleHours,
    slo_seconds: Math.round(staleHours * 3600),
    contract,
    onchain_updater: onchainUpdater || null,
    expected_updater: `0x${resolved.updaterSh}`,
    updater_gas: updaterGas,
    abi,
    documented_pusher_instance: DOCUMENTED_FEED_PUSHER_INSTANCE,
    aws,
    pairs,
    chain_time_unix: chainTimeUnix,
    ...diagnosed,
    headline: formatFeedHealthHeadline({ network, ...diagnosed }),
  };
}

export function summarizeFeedHealthReports(reports = []) {
  const exitCodes = reports.map((report) => feedHealthExitCode(report));
  const exit_code = exitCodes.includes(2) ? 2 : exitCodes.includes(1) ? 1 : 0;
  return {
    ok: exit_code === 0,
    networks: reports.map((report) => report.network),
    exit_code,
    headlines: reports.map((report) => report.headline),
  };
}
