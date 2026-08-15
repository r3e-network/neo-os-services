import fs from 'node:fs/promises';
import path from 'node:path';

import {
  classifyFeedFreshness,
  decodeNeoStackItem,
  invokeNeoFunctionViaCurl,
  loadRuntimeConfigFromEnvFile,
  parseConfiguredFeedPairs,
} from './lib-feed-freshness.mjs';
import { trimString } from './lib-strings.mjs';

export function parseOnchainFeedRecords(stackItem, nowMs = Date.now(), staleMinutes = 720) {
  const decoded = decodeNeoStackItem(stackItem);
  if (!Array.isArray(decoded)) return [];

  return decoded
    .filter((entry) => Array.isArray(entry) && entry.length >= 6)
    .map((entry) => {
      const [pair, roundId, price, timestamp, attestationHash, sourceSetId] = entry;
      return {
        pair: trimString(pair),
        round_id: String(roundId ?? '0'),
        price: String(price ?? '0'),
        timestamp: String(timestamp ?? '0'),
        attestation_hash: trimString(attestationHash),
        source_set_id: String(sourceSetId ?? '0'),
        ...classifyFeedFreshness(timestamp ?? '0', nowMs, staleMinutes, pair),
      };
    })
    .filter((entry) => entry.pair);
}

export function diffFeedRegistry(configuredPairs = [], onchainRecords = []) {
  const configured = [
    ...new Set(configuredPairs.map((entry) => trimString(entry)).filter(Boolean)),
  ].sort();
  const onchainPairs = [
    ...new Set(onchainRecords.map((entry) => trimString(entry?.pair)).filter(Boolean)),
  ].sort();
  const configuredSet = new Set(configured);
  const onchainSet = new Set(onchainPairs);

  return {
    configured_pairs: configured,
    onchain_pairs: onchainPairs,
    missing_onchain_pairs: configured.filter((pair) => !onchainSet.has(pair)),
    extra_onchain_pairs: onchainPairs.filter((pair) => !configuredSet.has(pair)),
  };
}

export function summarizeFeedRegistryDrift(reports = []) {
  const enrichedReports = reports.map((report) => {
    const extraPairs = new Set(report.extra_onchain_pairs || []);
    const configuredStaleRecords = (report.rows || []).filter(
      (row) => row.stale === true && !extraPairs.has(row.pair)
    );
    return {
      ...report,
      configured_onchain_stale_pair_count: configuredStaleRecords.length,
      configured_onchain_stale_pairs: configuredStaleRecords.map((row) => row.pair),
      legacy_extra_onchain_pairs: [...extraPairs].sort(),
    };
  });
  const missingOnchainPairCount = enrichedReports.reduce(
    (total, report) => total + (report.missing_onchain_pairs || []).length,
    0
  );
  const configuredOnchainStalePairCount = enrichedReports.reduce(
    (total, report) => total + report.configured_onchain_stale_pair_count,
    0
  );
  const blockingIssueCount = missingOnchainPairCount + configuredOnchainStalePairCount;

  return {
    status: blockingIssueCount === 0 ? 'pass' : 'fail',
    missing_onchain_pair_count: missingOnchainPairCount,
    configured_onchain_stale_pair_count: configuredOnchainStalePairCount,
    blocking_issue_count: blockingIssueCount,
    legacy_extra_onchain_pairs: enrichedReports.flatMap(
      (report) => report.legacy_extra_onchain_pairs
    ),
    reports: enrichedReports,
  };
}

export async function buildFeedRegistryDriftReport({ repoRoot, network, staleMinutes = 720 }) {
  const networkConfig = JSON.parse(
    await fs.readFile(path.join(repoRoot, 'config', 'networks', `${network}.json`), 'utf8')
  );
  const runtimeConfig = await loadRuntimeConfigFromEnvFile(
    path.join(repoRoot, 'deploy', 'nitro', `morpheus.${network}.env`)
  );
  const rpcUrl = trimString(networkConfig.neo_n3?.rpc_url || '');
  const datafeedHash = trimString(networkConfig.neo_n3?.contracts?.morpheus_datafeed || '');
  const configuredPairs = parseConfiguredFeedPairs(runtimeConfig);
  const result = invokeNeoFunctionViaCurl(rpcUrl, datafeedHash, 'getAllFeedRecords', []);
  const onchainRecords = parseOnchainFeedRecords(result.stack?.[0], Date.now(), staleMinutes);
  const drift = diffFeedRegistry(configuredPairs, onchainRecords);

  return {
    network,
    configured_pair_count: configuredPairs.length,
    onchain_pair_count: drift.onchain_pairs.length,
    missing_onchain_pairs: drift.missing_onchain_pairs,
    extra_onchain_pairs: drift.extra_onchain_pairs,
    extra_onchain_records: onchainRecords.filter((entry) =>
      drift.extra_onchain_pairs.includes(entry.pair)
    ),
    rows: onchainRecords,
  };
}
