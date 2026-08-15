import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { parseDotEnv } from './lib-env.mjs';
import {
  fetchPriceQuote,
  decimalToIntegerString,
} from '../workers/nitro-worker/src/oracle/index.js';
import { trimString } from './lib-strings.mjs';

const CONTINUOUS_FEED_PAIRS = new Set([
  'TWELVEDATA:NEO-USD',
  'TWELVEDATA:GAS-USD',
  'TWELVEDATA:BTC-USD',
  'TWELVEDATA:ETH-USD',
  'TWELVEDATA:SOL-USD',
  'TWELVEDATA:TRX-USD',
  'TWELVEDATA:PAXG-USD',
  'TWELVEDATA:USDT-USD',
  'TWELVEDATA:USDC-USD',
  'TWELVEDATA:BNB-USD',
  'TWELVEDATA:XRP-USD',
  'TWELVEDATA:DOGE-USD',
]);

export const FRESHNESS_RPC_PROBE_CONNECT_TIMEOUT_SECONDS = '5';
export const FRESHNESS_RPC_PROBE_MAX_TIME_SECONDS = '8';
export const FRESHNESS_RPC_PROBE_TIMEOUT_MS = 10_000;

export function classifyFeedCadence(pair) {
  const normalized = normalizeFeedStoragePair(pair);
  if (!normalized) return 'continuous';
  if (CONTINUOUS_FEED_PAIRS.has(normalized)) return 'continuous';
  return 'market_hours';
}

function inferProviderId(pair) {
  const normalized = normalizeFeedStoragePair(pair);
  if (normalized.startsWith('TWELVEDATA:')) return 'twelvedata';
  if (normalized.startsWith('BINANCE-SPOT:')) return 'binance-spot';
  if (normalized.startsWith('COINBASE-SPOT:')) return 'coinbase-spot';
  return 'twelvedata';
}

function computeChangeBps(previousUnits, nextUnits) {
  const previous = Number(previousUnits);
  const next = Number(nextUnits);
  if (!Number.isFinite(previous) || !Number.isFinite(next) || previous <= 0)
    return Number.POSITIVE_INFINITY;
  return Math.abs((next - previous) / previous) * 10_000;
}

export async function loadRuntimeConfigFromEnvFile(filePath) {
  const processRuntimeConfig = trimString(process.env.MORPHEUS_RUNTIME_CONFIG_JSON || '');
  if (processRuntimeConfig) return JSON.parse(processRuntimeConfig);

  const env = parseDotEnv(await fs.readFile(filePath, 'utf8'));
  const runtimeConfigRaw = trimString(env.MORPHEUS_RUNTIME_CONFIG_JSON || '');
  if (!runtimeConfigRaw) {
    throw new Error(`MORPHEUS_RUNTIME_CONFIG_JSON is missing from ${filePath}`);
  }
  return JSON.parse(runtimeConfigRaw);
}

export function normalizeFeedStoragePair(value) {
  const normalized = trimString(value).toUpperCase();
  if (!normalized) return '';
  return normalized.includes(':') ? normalized : `TWELVEDATA:${normalized}`;
}

export function parseConfiguredFeedPairs(runtimeConfig = {}) {
  return String(runtimeConfig.MORPHEUS_FEED_SYMBOLS || '')
    .split(',')
    .map((entry) => normalizeFeedStoragePair(entry))
    .filter(Boolean);
}

export function decodeNeoStackItem(item) {
  if (!item || typeof item !== 'object') return null;
  const type = trimString(item.type).toLowerCase();
  switch (type) {
    case 'array':
    case 'struct':
      return Array.isArray(item.value) ? item.value.map((entry) => decodeNeoStackItem(entry)) : [];
    case 'integer':
      return String(item.value ?? '0');
    case 'boolean':
      return Boolean(item.value);
    case 'string':
    case 'hash160':
    case 'hash256':
      return String(item.value ?? '');
    case 'bytestring':
    case 'bytearray': {
      const bytes = Buffer.from(String(item.value || ''), 'base64');
      const text = bytes.toString('utf8');
      return /^[\x09\x0a\x0d\x20-\x7e]*$/.test(text) ? text : `0x${bytes.toString('hex')}`;
    }
    default:
      return item.value ?? null;
  }
}

export function invokeNeoFunctionViaCurl(rpcUrl, contractHash, operation, params = []) {
  const payload = {
    jsonrpc: '2.0',
    id: 1,
    method: 'invokefunction',
    params: [contractHash, operation, params],
  };
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = JSON.parse(
        execFileSync(
          'curl',
          [
            '-fsS',
            '--happy-eyeballs-timeout-ms',
            '200',
            '--connect-timeout',
            '20',
            '--max-time',
            '20',
            rpcUrl,
            '-H',
            'Content-Type: application/json',
            '-d',
            JSON.stringify(payload),
          ],
          { encoding: 'utf8', timeout: 25_000 }
        )
      );
      if (response.error) {
        throw new Error(`rpc ${operation} failed: ${JSON.stringify(response.error)}`);
      }
      return response.result;
    } catch (error) {
      lastError = error;
      if (attempt >= 3) break;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function probeNeoRpcUrlViaCurl(rpcUrl) {
  const payload = {
    jsonrpc: '2.0',
    id: 1,
    method: 'getversion',
    params: [],
  };

  try {
    const response = JSON.parse(
      execFileSync(
        'curl',
        [
          '-fsS',
          '--happy-eyeballs-timeout-ms',
          '200',
          '--connect-timeout',
          FRESHNESS_RPC_PROBE_CONNECT_TIMEOUT_SECONDS,
          '--max-time',
          FRESHNESS_RPC_PROBE_MAX_TIME_SECONDS,
          rpcUrl,
          '-H',
          'Content-Type: application/json',
          '-d',
          JSON.stringify(payload),
        ],
        { encoding: 'utf8', timeout: FRESHNESS_RPC_PROBE_TIMEOUT_MS }
      )
    );
    return !response?.error;
  } catch {
    return false;
  }
}

export function resolveReachableNeoRpcUrls(rpcUrls) {
  const urls = Array.isArray(rpcUrls)
    ? rpcUrls.map((value) => trimString(value)).filter(Boolean)
    : [trimString(rpcUrls)].filter(Boolean);
  const uniqueUrls = [...new Set(urls)];
  if (!uniqueUrls.length) return [];

  const reachable = [];
  for (const url of uniqueUrls) {
    if (probeNeoRpcUrlViaCurl(url)) reachable.push(url);
  }

  return reachable.length ? reachable : uniqueUrls;
}

function probeNeoInvokeViaCurl(rpcUrl, contractHash, operation, params = []) {
  const payload = {
    jsonrpc: '2.0',
    id: 1,
    method: 'invokefunction',
    params: [contractHash, operation, params],
  };

  try {
    const response = JSON.parse(
      execFileSync(
        'curl',
        [
          '-fsS',
          '--happy-eyeballs-timeout-ms',
          '200',
          '--connect-timeout',
          FRESHNESS_RPC_PROBE_CONNECT_TIMEOUT_SECONDS,
          '--max-time',
          FRESHNESS_RPC_PROBE_MAX_TIME_SECONDS,
          rpcUrl,
          '-H',
          'Content-Type: application/json',
          '-d',
          JSON.stringify(payload),
        ],
        { encoding: 'utf8', timeout: FRESHNESS_RPC_PROBE_TIMEOUT_MS }
      )
    );
    if (response.error) return false;
    const result = response.result;
    return Boolean(result) && typeof result === 'object' && Array.isArray(result.stack);
  } catch {
    return false;
  }
}

export function resolveReachableNeoRpcUrlsForInvoke(rpcUrls, contractHash, operation, params = []) {
  const candidates = resolveReachableNeoRpcUrls(rpcUrls);
  if (!candidates.length) return [];
  const reachable = [];
  for (const url of candidates) {
    if (probeNeoInvokeViaCurl(url, contractHash, operation, params)) reachable.push(url);
  }
  return reachable.length ? reachable : candidates;
}

export function invokeNeoFunctionViaCurlWithFallback(
  rpcUrls,
  contractHash,
  operation,
  params = []
) {
  const urls = Array.isArray(rpcUrls)
    ? rpcUrls.map((value) => trimString(value)).filter(Boolean)
    : [trimString(rpcUrls)].filter(Boolean);
  if (!urls.length) {
    throw new Error(`rpc url missing for ${operation}`);
  }
  let lastError = null;
  for (const rpcUrl of urls) {
    try {
      return invokeNeoFunctionViaCurl(rpcUrl, contractHash, operation, params);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export function mergeFreshnessRpcUrls(reachableRpcUrls, configuredRpcUrls) {
  const reachable = Array.isArray(reachableRpcUrls)
    ? reachableRpcUrls.map((value) => trimString(value)).filter(Boolean)
    : [];
  if (reachable.length) return rankFreshnessRpcUrls([...new Set(reachable)]);
  return rankFreshnessRpcUrls([
    ...new Set(
      (Array.isArray(configuredRpcUrls) ? configuredRpcUrls : [configuredRpcUrls])
        .map((value) => trimString(value))
        .filter(Boolean)
    ),
  ]);
}

function rankFreshnessRpcUrls(rpcUrls) {
  return [...rpcUrls].sort((left, right) => rpcUrlRank(left) - rpcUrlRank(right));
}

function rpcUrlRank(value) {
  const normalized = trimString(value).toLowerCase();
  if (/^https?:\/\/seed\d+\.neo\.org(?::|\/|$)/.test(normalized)) return 0;
  if (normalized.includes('neo.org')) return 1;
  if (normalized.startsWith('https://')) return 2;
  return 3;
}

export function selectFreshnessRpcUrlsForPair(rpcUrls) {
  return [
    ...new Set(
      (Array.isArray(rpcUrls) ? rpcUrls : [rpcUrls])
        .map((value) => trimString(value))
        .filter(Boolean)
    ),
  ];
}

export function classifyFeedFreshness(
  timestampSeconds,
  nowMs = Date.now(),
  staleMinutes = 180,
  pair = ''
) {
  const tsMs = Number(timestampSeconds) * 1000;
  const cadence = classifyFeedCadence(pair);
  const thresholdMinutes = cadence === 'continuous' ? staleMinutes : Math.max(staleMinutes, 1440);
  if (!Number.isFinite(tsMs) || tsMs <= 0) {
    return {
      iso: null,
      age_min: null,
      cadence,
      threshold_min: thresholdMinutes,
      stale: true,
    };
  }
  const ageMin = Math.round((nowMs - tsMs) / 60000);
  return {
    iso: new Date(tsMs).toISOString(),
    age_min: ageMin,
    cadence,
    threshold_min: thresholdMinutes,
    stale: ageMin > thresholdMinutes,
  };
}

export async function buildFeedFreshnessReport({ repoRoot, network, staleMinutes = 180 }) {
  const networkConfig = JSON.parse(
    await fs.readFile(path.join(repoRoot, 'config', 'networks', `${network}.json`), 'utf8')
  );
  const runtimeConfig = await loadRuntimeConfigFromEnvFile(
    path.join(repoRoot, 'deploy', 'nitro', `morpheus.${network}.env`)
  );
  const explicitRpcUrl = trimString(process.env.NEO_RPC_URL || '');
  const baseRpcUrls = [
    ...(Array.isArray(networkConfig.neo_n3?.rpc_urls) ? networkConfig.neo_n3.rpc_urls : []),
    trimString(networkConfig.neo_n3?.rpc_url || ''),
  ]
    .map((value) => trimString(value))
    .filter(Boolean);
  const strictRpcOverride = trimString(process.env.NEO_RPC_URL_STRICT || '') === '1';
  const rpcUrls = (
    explicitRpcUrl
      ? strictRpcOverride
        ? [explicitRpcUrl]
        : [explicitRpcUrl, ...baseRpcUrls]
      : baseRpcUrls
  )
    .map((value) => trimString(value))
    .filter(Boolean);
  const datafeedHash = trimString(networkConfig.neo_n3?.contracts?.morpheus_datafeed || '');
  const pairs = parseConfiguredFeedPairs(runtimeConfig);
  const rpcUrlsOrdered = resolveReachableNeoRpcUrlsForInvoke(
    rpcUrls,
    datafeedHash,
    'getLatest',
    pairs.length ? [{ type: 'String', value: pairs[0] }] : []
  );
  const rpcUrlsFallback = mergeFreshnessRpcUrls(rpcUrlsOrdered, rpcUrls);
  const rows = [];

  if (
    trimString(runtimeConfig.TWELVEDATA_API_KEY || '') &&
    !trimString(process.env.TWELVEDATA_API_KEY || '')
  ) {
    process.env.TWELVEDATA_API_KEY = trimString(runtimeConfig.TWELVEDATA_API_KEY);
  }

  for (const pair of pairs) {
    const selectedRpcUrls = selectFreshnessRpcUrlsForPair(rpcUrlsFallback);
    const response = invokeNeoFunctionViaCurlWithFallback(
      selectedRpcUrls,
      datafeedHash,
      'getLatest',
      [{ type: 'String', value: pair }]
    );
    const decoded = decodeNeoStackItem(response.stack?.[0]) || [];
    const [, roundId, price, timestamp, attestationHash, sourceSetId] = decoded;
    rows.push({
      pair: decoded[0] || pair,
      round_id: roundId || '0',
      price: price || '0',
      timestamp: timestamp || '0',
      attestation_hash: attestationHash || '',
      source_set_id: sourceSetId || '0',
      ...classifyFeedFreshness(timestamp || '0', Date.now(), staleMinutes, decoded[0] || pair),
    });

    if (pairs.length > 1) {
      await new Promise((resolve) => setTimeout(resolve, 75));
    }
  }

  const stalePairs = [];
  for (const row of rows) {
    if (!row.stale) continue;
    let staleReason = 'age_exceeded_threshold';
    let actionable = true;
    let providerQuote = null;
    let providerError = null;

    try {
      providerQuote = await fetchPriceQuote(row.pair, {
        network,
        provider: inferProviderId(row.pair),
      });
      const providerUnits = decimalToIntegerString(providerQuote.price, providerQuote.decimals);
      const changeBps = computeChangeBps(row.price, providerUnits);
      row.provider_quote = {
        price: providerQuote.price,
        timestamp: providerQuote.timestamp,
        price_units: providerUnits,
        change_bps: changeBps,
      };
      if (changeBps < 10) {
        staleReason = 'stale_refresh_due_below_threshold';
      }
      if (providerQuote.timestamp) {
        const providerAge = classifyFeedFreshness(
          Math.floor(new Date(providerQuote.timestamp).getTime() / 1000),
          Date.now(),
          staleMinutes,
          row.pair
        );
        row.provider_quote.age_min = providerAge.age_min;
        if (providerAge.stale) {
          staleReason = 'upstream_source_stale';
          actionable = false;
        }
      }
    } catch (error) {
      providerError = error instanceof Error ? error.message : String(error);
      row.provider_error = providerError;
    }

    row.stale_reason = staleReason;
    row.actionable = actionable;
    stalePairs.push(row);
  }
  return {
    network,
    total: rows.length,
    fresh: rows.length - stalePairs.length,
    stale: stalePairs.length,
    actionable_stale: stalePairs.filter((entry) => entry.actionable).length,
    benign_stale: stalePairs.filter((entry) => !entry.actionable).length,
    stale_minutes: staleMinutes,
    stale_pairs: stalePairs,
    rows,
  };
}
