import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeMorpheusNetwork } from './lib/neo-signers.js';
import {
  parseBooleanEnv as parseBoolean,
  trimString,
} from '@r3e-network/neo-os-services-shared/utils';

const DEFAULT_NITRO_TIMEOUT_MS = 10_000;
const MAX_REQUEST_TIMEOUT_MS = 10_000;
const MAX_FEED_SYNC_TIMEOUT_MS = 30_000;
// Sanity ceiling for the retry backoff cap — generous enough that operators can
// slow poison-item retries to minutes, while still bounding accidental
// misconfiguration (the default cap stays at 10s).
const MAX_RETRY_MAX_DELAY_MS = 600_000;
// Last-resort fallback RPC URLs used ONLY when config/networks/<network>.json is absent or
// its rpc_urls list is empty (the registry is the SSOT — loadNetworkRegistry reads it, and
// resolveNeoN3RpcUrls prefers registry.neo_n3.rpc_urls ahead of this fallback). Kept as a
// defense-in-depth net so a missing registry file does not leave the relayer with no nodes.
// Mirrored from config/networks/*.json.
//
// HTTPS ONLY — never add an http:// endpoint here or to config/networks/*.json. A cleartext
// wallet RPC hop leaks every address and balance query to anyone on the path, and lets an
// on-path attacker rewrite the response a signing decision is made from. uniqueRankedRpcUrls
// only demotes http:// to last place, so a single cleartext entry anywhere in the merge order
// becomes reachable the moment every https:// node is down — exactly when an attacker who can
// drop traffic wants it. A short list that fails closed is the intended outcome; the C# SDK
// (neo-os-sdk RpcNodeSelector) and secure-sign's HttpsRequired already refuse cleartext.
// Enforced by workers/morpheus-relayer/src/rpc-url-ranking.test.mjs, which also pins this
// table byte-identical to the Rust port in crates/neo-os-core/src/config.rs.
export const DEFAULT_NEO_N3_RPC_URLS = {
  mainnet: [
    'https://api.n3index.dev/mainnet',
    'https://mainnet1.neo.coz.io:443',
    'https://mainnet2.neo.coz.io:443',
  ],
  testnet: ['https://api.n3index.dev/testnet', 'https://testnet1.neo.coz.io:443'],
};
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(moduleDir, '../../..');

// Exported for the golden-vector exporter (scripts/export-rust-vectors.mjs):
// the Rust relayer port is pinned against these functions' live behavior.
export function parseList(value) {
  const raw = trimString(value);
  if (!raw) return [];
  return raw
    .split(',')
    .map((entry) => trimString(entry))
    .filter(Boolean);
}

const SUPPORTED_CHAINS = ['neo_n3', 'neox'];
const RELAYER_NEO_N3_HOST_KEY_ENV_NAMES = [
  'NEO_N3_WIF',
  'NEO_TESTNET_WIF',
  ...['WORKER', 'RELAYER', 'UPDATER', 'ORACLE_VERIFIER', 'FEED'].flatMap((role) =>
    ['', '_MAINNET', '_TESTNET'].flatMap((suffix) => [
      `MORPHEUS_${role}_NEO_N3_WIF${suffix}`,
      `MORPHEUS_${role}_NEO_N3_PRIVATE_KEY${suffix}`,
    ])
  ),
];
const RELAYER_NEOX_HOST_KEY_ENV_NAMES = [
  'MORPHEUS_RELAYER_NEOX_UPDATER_PK',
  'MORPHEUS_RELAYER_NEOX_VERIFIER_PK',
  'NEOX_UPDATER_PK',
  'NEOX_VERIFIER_PK',
  'NEOX_FEED_PK',
];

function parseActiveChains(value) {
  const requested = parseList(value).map((entry) => entry.toLowerCase());
  const filtered = requested.filter((entry) => SUPPORTED_CHAINS.includes(entry));
  return filtered.length > 0 ? filtered : ['neo_n3'];
}

function parseUrlList(value) {
  return String(value || '')
    .split(',')
    .map((entry) => trimString(entry).replace(/\/$/, ''))
    .filter(Boolean);
}

export function uniqueOrdered(values) {
  return [...new Set(values.filter(Boolean))];
}

export function rpcUrlRank(value) {
  const normalized = trimString(value).toLowerCase();
  // HTTPS always outranks plaintext HTTP so the relayer never PREFERS a
  // MITM-able cleartext RPC endpoint when a TLS endpoint is available. Plaintext
  // http:// endpoints (e.g. the public neo.org seeds) sort last and serve only
  // as a last-resort fallback. (Previously http://seed*.neo.org ranked first.)
  if (normalized.startsWith('https://')) return 0;
  if (normalized.startsWith('http://')) return 2;
  return 1;
}

export function uniqueRankedRpcUrls(values) {
  return uniqueOrdered(values).sort((left, right) => rpcUrlRank(left) - rpcUrlRank(right));
}

export function requireHttpsRpcUrls(values, label = 'RPC') {
  const urls = uniqueOrdered(values);
  const invalid = urls.filter((value) => {
    try {
      return new URL(value).protocol !== 'https:';
    } catch {
      return true;
    }
  });
  if (invalid.length > 0) {
    throw new Error(`${label} requires HTTPS RPC endpoints: ${invalid.join(', ')}`);
  }
  return urls;
}

export function resolveReviewedNeoXChainId(network, registry, configuredValue = '') {
  const canonicalChainId = { mainnet: 47763, testnet: 12227332 }[network];
  if (!canonicalChainId) {
    throw new Error(`unsupported Neo network: ${network}`);
  }
  if (registry?.network && registry.network !== network) {
    throw new Error(`reviewed Neo X registry network conflicts with ${network}`);
  }
  const registryValue = registry?.neo_x?.chain_id;
  if (!Number.isSafeInteger(registryValue) || registryValue <= 0) {
    throw new Error(`missing reviewed Neo X chain id for ${network}`);
  }
  if (registryValue !== canonicalChainId) {
    throw new Error(`reviewed Neo X chain id conflicts with canonical ${network} identity`);
  }
  const configured = trimString(configuredValue);
  if (!configured) return registryValue;
  const parsed = Number(configured);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`invalid Neo X chain id for ${network}`);
  }
  if (parsed !== registryValue) {
    throw new Error(`Neo X chain id conflicts with reviewed ${network} identity`);
  }
  return parsed;
}

export function resolveAllowLocalClaimDuringBackoff({
  nodeEnv = process.env.NODE_ENV,
  requested = false,
} = {}) {
  if (
    String(nodeEnv || '')
      .trim()
      .toLowerCase() === 'production'
  )
    return false;
  return Boolean(requested);
}

export function resolveDurableQueueFailClosed({
  nodeEnv = process.env.NODE_ENV,
  requested = false,
} = {}) {
  if (
    String(nodeEnv || '')
      .trim()
      .toLowerCase() === 'production'
  )
    return true;
  return Boolean(requested);
}

function resolveNeoN3RpcUrls(network, registry) {
  const scopedRpcUrls =
    network === 'mainnet'
      ? parseUrlList(
          env(
            'NEO_MAINNET_RPC_URLS',
            'MAINNET_RPC_URLS',
            'NEO_RPC_URLS_MAINNET',
            'NEO_MAINNET_RPC_URL',
            'MAINNET_RPC_URL',
            'NEO_RPC_MAINNET'
          )
        )
      : parseUrlList(
          env(
            'NEO_TESTNET_RPC_URLS',
            'TESTNET_RPC_URLS',
            'NEO_RPC_URLS_TESTNET',
            'NEO_TESTNET_RPC_URL',
            'TESTNET_RPC_URL',
            'NEO_RPC_TESTNET'
          )
        );
  const genericRpcUrls = parseUrlList(env('NEO_RPC_URLS', 'NEO_RPC_URL'));
  return requireHttpsRpcUrls(
    uniqueRankedRpcUrls([
      ...scopedRpcUrls,
      ...parseUrlList(registry.neo_n3?.rpc_urls || []),
      trimString(registry.neo_n3?.rpc_url || ''),
      ...(parseBoolean(env('ALLOW_GENERIC_NEO_RPC_URL'), false) ? genericRpcUrls : []),
      ...(DEFAULT_NEO_N3_RPC_URLS[network] || []),
    ]),
    `Neo N3 ${network} RPC`
  );
}

export function resolveNeoN3NetworkMagic(network, registry) {
  const scopedMagic =
    network === 'mainnet'
      ? env('NEO_MAINNET_MAGIC', 'MAINNET_NETWORK_MAGIC')
      : env('NEO_TESTNET_MAGIC', 'TESTNET_NETWORK_MAGIC');
  const genericMagic = parseBoolean(env('ALLOW_GENERIC_NEO_NETWORK_MAGIC'), false)
    ? env('NEO_NETWORK_MAGIC')
    : '';
  const registryMagic = Number(registry?.neo_n3?.network_magic);
  const configuredMagic = scopedMagic || genericMagic;

  // The reviewed workspace registry is the authority for network identity.
  // Environment values are accepted only as a consistency assertion; allowing
  // them to win lets a mistyped production env sign for another network.
  if (Number.isSafeInteger(registryMagic) && registryMagic > 0) {
    if (configuredMagic && Number(configuredMagic) !== registryMagic) {
      throw new Error(`Neo N3 network magic conflicts with reviewed ${network} registry identity`);
    }
    return registryMagic;
  }
  throw new Error(`reviewed ${network} Neo N3 network magic is required`);
}

function parseIntegerString(value, fallback) {
  const raw = trimString(value);
  if (!/^[0-9]+$/.test(raw)) return fallback;
  return raw;
}

// Numeric env parser that preserves `Number(env || default)` semantics for empty
// and valid input but returns the fallback for a non-finite (e.g. mistyped) value
// instead of NaN. A bare Number('abc') is NaN, and NaN silently defeats every
// downstream Math.max floor (Math.max(NaN, x) === NaN) — e.g. a mistyped
// pollIntervalMs becomes sleep(NaN) === setTimeout(…, 0), spinning the scan loop
// and hammering RPC/Supabase. Callers keep their Math.max floors for minimums.
function parseNumericEnv(value, fallback) {
  const raw = trimString(value);
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function resolveRelayerMode(value) {
  const normalized = trimString(value).toLowerCase();
  if (normalized === 'feed_only' || normalized === 'requests_only') return normalized;
  return 'combined';
}

let runtimeConfigCache;
let runtimeConfigCacheRaw;

// A non-empty MORPHEUS_RUNTIME_CONFIG_JSON must be a JSON object. Reading a
// corrupt or non-object value as empty would drop every packed setting,
// MORPHEUS_NETWORK included, and start the relayer on its defaults, so it is a
// configuration error. The message never echoes the value: it can carry
// secrets.
function parseRuntimeConfigJson(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('MORPHEUS_RUNTIME_CONFIG_JSON is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('MORPHEUS_RUNTIME_CONFIG_JSON must be a JSON object');
  }
  return parsed;
}

function getRuntimeConfig() {
  const raw = trimString(process.env.MORPHEUS_RUNTIME_CONFIG_JSON || '');
  if (runtimeConfigCache !== undefined && raw === runtimeConfigCacheRaw) return runtimeConfigCache;
  const parsed = raw ? parseRuntimeConfigJson(raw) : {};
  runtimeConfigCacheRaw = raw;
  runtimeConfigCache = parsed;
  return runtimeConfigCache;
}

export function env(...names) {
  const runtimeConfig = getRuntimeConfig();
  for (const name of names) {
    const direct = trimString(process.env[name]);
    if (direct) return direct;
  }
  for (const name of names) {
    const packed = runtimeConfig[name];
    if (packed !== undefined && packed !== null && `${packed}`.trim()) {
      return `${packed}`.trim();
    }
  }
  return '';
}

function configuredHostSignerEnvNames() {
  const names = new Set([
    ...RELAYER_NEO_N3_HOST_KEY_ENV_NAMES,
    ...RELAYER_NEOX_HOST_KEY_ENV_NAMES,
    ...Object.keys(process.env),
    ...Object.keys(getRuntimeConfig()),
  ]);
  return [...names]
    .filter((name) => {
      const normalized = name.toUpperCase();
      return (
        /(?:^|_)WIF(?:_|$)/.test(normalized) ||
        (/(?:^|_)(?:PRIVATE_KEY|PK)(?:_|$)/.test(normalized) &&
          /(NEO|NEOX|EVM|MORPHEUS|SIGNER)/.test(normalized))
      );
    })
    .filter((name) => Boolean(env(name)))
    .sort();
}

export function envNetworkScoped(network, genericKey) {
  const suffix = network === 'mainnet' ? 'MAINNET' : 'TESTNET';
  return env(`${genericKey}_${suffix}`) || env(genericKey);
}

function loadJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function loadFileIfReadable(filePath) {
  if (!filePath) return '';
  try {
    return fs.readFileSync(filePath, 'utf8').trim();
  } catch {
    return '';
  }
}

function resolveNetworkName() {
  return env('MORPHEUS_NETWORK', 'NEXT_PUBLIC_MORPHEUS_NETWORK') || 'testnet';
}

export function resolvePublicRuntimeCandidates(network, registry) {
  // The runtime is the AWS Nitro enclave; read the `nitro` registry key.
  const runtimeRegistry = registry.nitro;
  return uniqueOrdered([
    trimString(runtimeRegistry?.public_api_url || ''),
    `https://oracle.meshmini.app/${network}`,
    `https://edge.meshmini.app/${network}`,
  ]);
}

function resolveNitroApiUrls(network, registry, { allowPublicFallbacks = true } = {}) {
  const explicit = uniqueOrdered(
    parseUrlList(
      env(
        `MORPHEUS_${network.toUpperCase()}_RUNTIME_URL`,
        'MORPHEUS_RUNTIME_URL',
        `MORPHEUS_${network.toUpperCase()}_NITRO_API_URL`,
        'NITRO_API_URL'
      )
    )
  );
  const publicFallbacks = allowPublicFallbacks
    ? resolvePublicRuntimeCandidates(network, registry)
    : [];
  const combined = uniqueOrdered([...explicit, ...publicFallbacks]);
  return combined.join(',');
}

function loadNetworkRegistry(networkName) {
  const registryPath = path.resolve(repoRoot, 'config', 'networks', `${networkName}.json`);
  const registry = loadJsonFile(registryPath);
  if (!registry) throw new Error(`cannot load reviewed network registry ${registryPath}`);
  return registry;
}

export function createRelayerConfig() {
  const network = normalizeMorpheusNetwork(resolveNetworkName());
  const registry = loadNetworkRegistry(network);
  const neoN3RpcUrls = resolveNeoN3RpcUrls(network, registry);
  const mode = resolveRelayerMode(env('MORPHEUS_RELAYER_MODE') || 'combined');
  const nodeEnv = trimString(env('NODE_ENV') || process.env.NODE_ENV);
  const production = nodeEnv.toLowerCase() === 'production';
  const useDerivedKeys = parseBoolean(env('NITRO_USE_DERIVED_KEYS'), false);
  const hasSupabaseUrl = Boolean(
    env('SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL', 'morpheus_SUPABASE_URL')
  );
  const hasSupabaseKey = Boolean(
    env(
      'SUPABASE_SECRET_KEY',
      'SUPABASE_SERVICE_ROLE_KEY',
      'morpheus_SUPABASE_SECRET_KEY',
      'morpheus_SUPABASE_SERVICE_ROLE_KEY',
      'SUPABASE_SERVICE_KEY'
    )
  );
  const durableQueueEnabled = parseBoolean(
    env('MORPHEUS_DURABLE_QUEUE_ENABLED'),
    hasSupabaseUrl && hasSupabaseKey
  );
  const stateFile = path.resolve(
    repoRoot,
    env('MORPHEUS_RELAYER_STATE_FILE') ||
      (mode === 'combined'
        ? '.morpheus-relayer-state.json'
        : `.morpheus-relayer-state.${mode}.json`)
  );
  const activeChains = parseActiveChains(env('MORPHEUS_ACTIVE_CHAINS') || 'neo_n3');
  const maxRetries = Math.max(parseNumericEnv(env('MORPHEUS_RELAYER_MAX_RETRIES'), 5), 0);
  const hostSignerEnvNames = configuredHostSignerEnvNames();
  const neoXHostKeyEnvNames = hostSignerEnvNames.filter((name) => /NEOX|EVM/i.test(name));
  const neoN3HostKeyEnvNames = hostSignerEnvNames.filter(
    (name) => !neoXHostKeyEnvNames.includes(name)
  );
  const allowInsecureHostEvmSigner =
    !production && parseBoolean(env('MORPHEUS_ALLOW_INSECURE_HOST_EVM_SIGNER'), false);

  if (neoN3HostKeyEnvNames.length > 0) {
    throw new Error(
      'host Neo N3 signing key configuration is forbidden in the relayer; ' +
        `use custody key ids instead (configured: ${neoN3HostKeyEnvNames.join(', ')})`
    );
  }
  if (production && neoXHostKeyEnvNames.length > 0) {
    throw new Error(
      'host signing key configuration is forbidden in the production relayer; ' +
        `use custody/enclave signing instead (configured: ${neoXHostKeyEnvNames.join(', ')})`
    );
  }
  if (!production && neoXHostKeyEnvNames.length > 0 && !allowInsecureHostEvmSigner) {
    throw new Error(
      'Neo X host signing is development-only and disabled; remove the EVM private key or set ' +
        'MORPHEUS_ALLOW_INSECURE_HOST_EVM_SIGNER=true for an explicit non-production test'
    );
  }
  return {
    repoRoot,
    network,
    nodeEnv,
    mode,
    useDerivedKeys,
    instanceId:
      trimString(env('MORPHEUS_RELAYER_INSTANCE_ID')) ||
      `${mode}:${network}:${trimString(os.hostname() || 'host')}:${process.pid}`,
    activeChains,
    pollIntervalMs: parseNumericEnv(env('MORPHEUS_RELAYER_POLL_INTERVAL_MS'), 5000),
    // Idle-discovery backoff (Round-2 R2-0.1): when a chain has no scanned events AND
    // no due retries for a tick, skip the getLatestBlock + scan RPCs until this many ms
    // have elapsed since the last scan. 0 = disabled (always scan every tick, the
    // prior behavior). runDueRetries always runs regardless, so due callbacks are never
    // delayed. Set e.g. 30000 to cut idle-chain RPC load to once per 30s on quiet boxes.
    discoveryIdleBackoffMs: Math.max(
      parseNumericEnv(env('MORPHEUS_RELAYER_DISCOVERY_IDLE_BACKOFF_MS'), 0),
      0
    ),
    concurrency: Math.max(parseNumericEnv(env('MORPHEUS_RELAYER_CONCURRENCY'), 4), 1),
    maxBlocksPerTick: Math.max(
      parseNumericEnv(env('MORPHEUS_RELAYER_MAX_BLOCKS_PER_TICK'), 250),
      1
    ),
    maxRetries,
    // Ceiling on callback-delivery / failure-finalize redelivery attempts; once a
    // prepared fulfillment exceeds it the request is dead-lettered for manual
    // replay instead of retrying forever.
    maxCallbackRetries: Math.max(
      parseNumericEnv(env('MORPHEUS_RELAYER_MAX_CALLBACK_RETRIES'), maxRetries * 2),
      1
    ),
    retryBaseDelayMs: Math.max(
      parseNumericEnv(env('MORPHEUS_RELAYER_RETRY_BASE_DELAY_MS'), 5000),
      250
    ),
    retryMaxDelayMs: Math.min(
      Math.max(parseNumericEnv(env('MORPHEUS_RELAYER_RETRY_MAX_DELAY_MS'), 10_000), 1000),
      MAX_RETRY_MAX_DELAY_MS
    ),
    // Minimum interval between local state-file writes; bursts of persistState
    // calls inside one processEvent coalesce into a single trailing write. 0
    // restores write-on-every-call.
    statePersistMinIntervalMs: Math.max(
      parseNumericEnv(env('MORPHEUS_RELAYER_STATE_PERSIST_MIN_INTERVAL_MS'), 250),
      0
    ),
    processedCacheSize: Math.max(
      parseNumericEnv(env('MORPHEUS_RELAYER_PROCESSED_CACHE_SIZE'), 5000),
      100
    ),
    deadLetterLimit: Math.max(parseNumericEnv(env('MORPHEUS_RELAYER_DEAD_LETTER_LIMIT'), 500), 10),
    // Ceiling on the in-memory retry queue per chain. A sustained ingestion burst
    // combined with a downstream failure can grow the retry queue unboundedly (and
    // the whole array is re-serialized on every persist). When set, the oldest
    // retry items beyond the limit are shed into the dead-letter lane (recoverable
    // via manual replay) and counted. Defaults to 0 = no ceiling, so the live box
    // behaves identically until the operator sets the variable.
    retryQueueLimit: Math.max(parseNumericEnv(env('MORPHEUS_RELAYER_RETRY_QUEUE_LIMIT'), 0), 0),
    durableQueue: {
      enabled: durableQueueEnabled,
      failClosed: resolveDurableQueueFailClosed({
        nodeEnv: env('NODE_ENV') || process.env.NODE_ENV,
        requested: parseBoolean(env('MORPHEUS_DURABLE_QUEUE_FAIL_CLOSED'), durableQueueEnabled),
      }),
      // Fail closed by default: when the shared idempotency store is unreachable, do NOT
      // locally claim/deliver (a multi-instance double-delivery window). Single-instance/
      // local-dev can opt back in, but production always remains fail closed.
      allowLocalClaimDuringBackoff: resolveAllowLocalClaimDuringBackoff({
        nodeEnv: env('NODE_ENV') || process.env.NODE_ENV,
        requested: parseBoolean(
          env('MORPHEUS_DURABLE_QUEUE_ALLOW_LOCAL_CLAIM_DURING_BACKOFF'),
          false
        ),
      }),
      syncLimit: Math.max(parseNumericEnv(env('MORPHEUS_DURABLE_QUEUE_SYNC_LIMIT'), 200), 1),
      staleProcessingMs: Math.max(
        parseNumericEnv(env('MORPHEUS_DURABLE_QUEUE_STALE_PROCESSING_MS'), 45000),
        1000
      ),
    },
    runSnapshots: {
      enabled: parseBoolean(env('MORPHEUS_RELAYER_RUN_SNAPSHOTS_ENABLED'), true),
      intervalMs: Math.max(
        parseNumericEnv(env('MORPHEUS_RELAYER_RUN_SNAPSHOT_INTERVAL_MS'), 60000),
        0
      ),
      errorBackoffMs: Math.max(
        parseNumericEnv(env('MORPHEUS_RELAYER_RUN_SNAPSHOT_ERROR_BACKOFF_MS'), 300000),
        1000
      ),
    },
    backpressure: {
      maxFreshEventsPerTick: Math.max(
        parseNumericEnv(env('MORPHEUS_RELAYER_MAX_FRESH_EVENTS_PER_TICK'), 32),
        1
      ),
      maxRetryEventsPerTick: Math.max(
        parseNumericEnv(env('MORPHEUS_RELAYER_MAX_RETRY_EVENTS_PER_TICK'), 16),
        1
      ),
      deferDelayMs: Math.max(parseNumericEnv(env('MORPHEUS_RELAYER_DEFER_DELAY_MS'), 5000), 250),
    },
    feedSync: {
      enabled: (env('MORPHEUS_FEED_SYNC_ENABLED') || 'true').toLowerCase() !== 'false',
      intervalMs: Math.max(parseNumericEnv(env('MORPHEUS_FEED_SYNC_INTERVAL_MS'), 60000), 1000),
      timeoutMs: Math.min(
        Math.max(parseNumericEnv(env('MORPHEUS_FEED_SYNC_TIMEOUT_MS'), 10000), 1000),
        MAX_FEED_SYNC_TIMEOUT_MS
      ),
      waitForSubmission: parseBoolean(env('MORPHEUS_FEED_SYNC_WAIT_FOR_SUBMISSION'), false),
      projectSlug: env('MORPHEUS_FEED_PROJECT_SLUG') || 'morpheus',
      projectConfigEnabled: parseBoolean(env('MORPHEUS_FEED_SYNC_PROJECT_CONFIG_ENABLED'), false),
      provider: env('MORPHEUS_FEED_PROVIDER'),
      providers: parseList(env('MORPHEUS_FEED_PROVIDERS')),
      symbols: parseList(env('MORPHEUS_FEED_SYMBOLS')),
      changeThresholdBps: env('MORPHEUS_FEED_CHANGE_THRESHOLD_BPS') || '10',
      minUpdateIntervalMs: env('MORPHEUS_FEED_MIN_UPDATE_INTERVAL_MS') || '60000',
      staleAfterMs: env('MORPHEUS_FEED_STALE_AFTER_MS') || '300000',
    },
    automation: {
      enabled: (env('MORPHEUS_AUTOMATION_ENABLED') || 'true').toLowerCase() !== 'false',
      batchSize: Math.max(parseNumericEnv(env('MORPHEUS_AUTOMATION_BATCH_SIZE'), 50), 1),
      maxQueuedPerTick: Math.max(
        parseNumericEnv(env('MORPHEUS_AUTOMATION_MAX_QUEUED_PER_TICK'), 10),
        1
      ),
      pricePollPairsPerTick: Math.max(
        parseNumericEnv(env('MORPHEUS_AUTOMATION_PRICE_PAIRS_PER_TICK'), 25),
        1
      ),
      defaultPriceCooldownMs: Math.max(
        parseNumericEnv(env('MORPHEUS_AUTOMATION_DEFAULT_PRICE_COOLDOWN_MS'), 60000),
        0
      ),
      claimStaleMs: Math.max(
        parseNumericEnv(env('MORPHEUS_AUTOMATION_CLAIM_STALE_MS'), 120000),
        1000
      ),
      // Idle-fetch backoff (Round-2 R2-0.2): after a fetch returns ZERO due jobs, skip the
      // next fetchActiveAutomationJobs query for this many ms. 0 = disabled (fetch every tick,
      // the prior behavior). Automation jobs are inserted by the control plane, so keep this
      // SMALL (e.g. 15000-30000) — an externally-inserted job is picked up within this window.
      idleBackoffMs: Math.max(parseNumericEnv(env('MORPHEUS_AUTOMATION_IDLE_BACKOFF_MS'), 0), 0),
    },
    logFormat: env('MORPHEUS_RELAYER_LOG_FORMAT', 'LOG_FORMAT') || 'json',
    logLevel: env('MORPHEUS_RELAYER_LOG_LEVEL', 'LOG_LEVEL') || 'info',
    confirmations: {
      neo_n3: parseNumericEnv(env('MORPHEUS_RELAYER_NEO_N3_CONFIRMATIONS'), 1),
      neox: parseNumericEnv(env('MORPHEUS_RELAYER_NEOX_CONFIRMATIONS'), 2),
    },
    startRequestIds: {
      neo_n3: env('MORPHEUS_RELAYER_NEO_N3_START_REQUEST_ID')
        ? Number(env('MORPHEUS_RELAYER_NEO_N3_START_REQUEST_ID'))
        : null,
      neox: env('MORPHEUS_RELAYER_NEOX_START_REQUEST_ID')
        ? Number(env('MORPHEUS_RELAYER_NEOX_START_REQUEST_ID'))
        : null,
    },
    startBlocks: {
      neo_n3: env('MORPHEUS_RELAYER_NEO_N3_START_BLOCK')
        ? Number(env('MORPHEUS_RELAYER_NEO_N3_START_BLOCK'))
        : null,
      neox: env('MORPHEUS_RELAYER_NEOX_START_BLOCK')
        ? Number(env('MORPHEUS_RELAYER_NEOX_START_BLOCK'))
        : null,
    },
    stateFile,
    nitro: {
      apiUrl: resolveNitroApiUrls(network, registry, {
        allowPublicFallbacks: !production,
      }),
      // Every relayer runtime request is confidential or mutating. Production
      // always forces one endpoint; development retains the old fallback pool
      // behind an explicit config value.
      allowFallback:
        !production && parseBoolean(env('MORPHEUS_RELAYER_ALLOW_RUNTIME_FALLBACKS'), true),
      // Endpoint that holds the signing keys (enclave). Used for /sign/payload +
      // key derivation. Defaults to the worker apiUrl so single-endpoint
      // deployments are unchanged; set NITRO_SIGNER_URL when the worker (compute)
      // and the signer (enclave) run on separate ports.
      signerUrl:
        trimString(env('NITRO_SIGNER_URL', 'MORPHEUS_SIGNER_URL')) ||
        resolveNitroApiUrls(network, registry, {
          allowPublicFallbacks: !production,
        }),
      // Custody signer service (SIGNER_SERVICE.md §5): the relayer holds no keys —
      // all Neo N3 signing goes through this service's policy-checked endpoints.
      custodyUrl: trimString(env('SIGNER_SERVICE_URL')),
      custodyToken: trimString(env('SIGNER_SERVICE_TOKEN')),
      // Compute-in-enclave cutover flag (Phase 4). Default FALSE: the relayer keeps
      // today's split path (host-worker compute via callNitro, then a separate
      // enclave /sign/payload). When TRUE the attested lanes (price/feed query,
      // vrf, compute, confidential decrypt, neodid) call the enclave's atomic
      // POST /oracle/fulfill once (compute + sign in one measured boundary). The
      // arbitrary-URL fetch lane stays on the host worker regardless. The live box
      // runs flag-off, so its behavior is unchanged byte-for-byte until cutover.
      enclaveFulfill: parseBoolean(env('MORPHEUS_RELAYER_ENCLAVE_FULFILL'), false),
      // Expected enclave PCR0 (hex). When set, the relayer enforces that an enclave
      // attestation document binds to this measurement before treating a fulfillment as
      // enclave-attested (else trust_tier is downgraded). Unset = no PCR0 pinning yet.
      expectedPcr0: trimString(env('MORPHEUS_EXPECTED_PCR0')),
      // When true, the relayer verifies the enclave's returned signature against the
      // on-chain-pinned oracle_verifier public key before submitting. SECURITY (S9):
      // ON by default in production (fail closed); operators may still opt out
      // explicitly with MORPHEUS_RELAYER_VERIFY_ENCLAVE_SIGNATURE=false.
      verifyEnclaveSignature: parseBoolean(
        env('MORPHEUS_RELAYER_VERIFY_ENCLAVE_SIGNATURE'),
        process.env.NODE_ENV === 'production'
      ),
      // Base URL of the enclave /oracle/fulfill endpoint. Defaults to the signer
      // URL (the enclave already holds the keys), so a merged single-endpoint
      // enclave needs no extra configuration.
      enclaveFulfillUrl:
        trimString(env('MORPHEUS_RELAYER_ENCLAVE_FULFILL_URL')) ||
        trimString(env('NITRO_SIGNER_URL', 'MORPHEUS_SIGNER_URL')) ||
        resolveNitroApiUrls(network, registry, {
          allowPublicFallbacks: !production,
        }),
      // Enclave-ONLY endpoint for the confidential /oracle/decrypt (and any future
      // key/sign) lane. Confidential decryption MUST happen inside the measured
      // enclave; it must NEVER fail over to a public/edge endpoint (that would
      // perform decryption off the attested boundary and leak plaintext). It is
      // resolved from the EXPLICIT enclave/signer URLs (not the public-fallback-laden
      // apiUrl): a dedicated decrypt URL, then the enclave-fulfill URL, then the
      // signer URL. Only when NONE of those are explicitly configured does it fall
      // back to the worker apiUrl (single-endpoint deployments where the apiUrl IS the
      // enclave); the decrypt call always runs with failover DISABLED so only this
      // first enclave URL is ever contacted (fail closed if unreachable).
      decryptUrl:
        trimString(env('MORPHEUS_RELAYER_ENCLAVE_DECRYPT_URL', 'MORPHEUS_DECRYPT_URL')) ||
        trimString(env('MORPHEUS_RELAYER_ENCLAVE_FULFILL_URL')) ||
        trimString(env('NITRO_SIGNER_URL', 'MORPHEUS_SIGNER_URL')) ||
        resolveNitroApiUrls(network, registry, {
          allowPublicFallbacks: !production,
        }),
      // PEM of the pinned AWS Nitro Enclaves attestation ROOT certificate. A result
      // can be labeled enclave-attested only when its COSE_Sign1 signature and chain
      // verify to this root. When unset, fulfillment may continue for compatibility,
      // but matching digest/PCR fields remain host-unattested.
      nitroRootCertPem:
        trimString(env('MORPHEUS_NITRO_ROOT_CERT_PEM')) ||
        loadFileIfReadable(trimString(env('MORPHEUS_NITRO_ROOT_CERT_PATH'))),
      // Maximum age (ms) of an attestation document's echoed timestamp before it is
      // considered stale (replay protection). 0/unset disables the timestamp-age gate
      // (the nonce-echo binding is the primary anti-replay control). Defaults to 0.
      attestationMaxAgeMs: Math.max(parseNumericEnv(env('MORPHEUS_ATTESTATION_MAX_AGE_MS'), 0), 0),
      token: env('MORPHEUS_RUNTIME_TOKEN', 'NITRO_API_TOKEN', 'NITRO_SHARED_SECRET'),
      timeoutMs: Math.min(
        Math.max(parseNumericEnv(env('MORPHEUS_NITRO_TIMEOUT_MS'), DEFAULT_NITRO_TIMEOUT_MS), 1000),
        MAX_REQUEST_TIMEOUT_MS
      ),
      useDerivedKeys,
    },
    neo_n3: {
      scanMode:
        trimString(env('MORPHEUS_RELAYER_NEO_N3_SCAN_MODE')) ||
        (network === 'testnet' ? 'n3index_notifications' : 'block_cursor'),
      // How long to poll a broadcast fulfillRequest's application log for a
      // concrete VM state before treating it as a confirmation timeout. 0/unset
      // falls back to the in-module default (45s).
      fulfillConfirmTimeoutMs: env('MORPHEUS_RELAYER_NEO_N3_FULFILL_CONFIRM_TIMEOUT_MS')
        ? Number(env('MORPHEUS_RELAYER_NEO_N3_FULFILL_CONFIRM_TIMEOUT_MS'))
        : null,
      // When true (default), a fulfillRequest whose application log never appears
      // before the timeout is treated as transient and re-broadcast on a later
      // tick (idempotent) instead of silently recorded as fulfilled. Set false
      // to restore the prior best-effort UNKNOWN behavior.
      fulfillConfirmThrowOnTimeout: parseBoolean(
        env('MORPHEUS_RELAYER_NEO_N3_FULFILL_CONFIRM_THROW_ON_TIMEOUT'),
        true
      ),
      indexerUrl:
        trimString(env('MORPHEUS_RELAYER_NEO_N3_INDEXER_URL')) || 'https://api.n3index.dev/rest/v1',
      startRequestId: env('MORPHEUS_RELAYER_NEO_N3_START_REQUEST_ID')
        ? Number(env('MORPHEUS_RELAYER_NEO_N3_START_REQUEST_ID'))
        : null,
      rpcUrl: neoN3RpcUrls[0] || '',
      rpcUrls: neoN3RpcUrls,
      networkMagic: resolveNeoN3NetworkMagic(network, registry),
      oracleContract:
        envNetworkScoped(network, 'CONTRACT_MORPHEUS_ORACLE_HASH') ||
        trimString(registry.neo_n3?.contracts?.morpheus_oracle || ''),
      datafeedContract:
        envNetworkScoped(network, 'CONTRACT_MORPHEUS_DATAFEED_HASH') ||
        trimString(registry.neo_n3?.contracts?.morpheus_datafeed || ''),
      // Custody key ids per signer role (docs/SIGNER_SERVICE.md §5). The relayer
      // names a key id and receives public identity + policy-checked signatures;
      // the secret never leaves the enclave.
      custodyKeyIds: {
        updater: trimString(env('SIGNER_ROLE_UPDATER_KEY_ID')),
        oracle_verifier: trimString(env('SIGNER_ROLE_ORACLE_VERIFIER_KEY_ID')),
        fee_funder: trimString(env('SIGNER_ROLE_FEE_FUNDER_KEY_ID')),
      },
      feeTopUp: {
        enabled: parseBoolean(env('MORPHEUS_RELAYER_NEO_N3_AUTO_TOPUP_ENABLED'), true),
        minBalance: parseIntegerString(
          env('MORPHEUS_RELAYER_NEO_N3_AUTO_TOPUP_MIN_FIXED8'),
          '50000000'
        ),
        topUpAmount: parseIntegerString(
          env('MORPHEUS_RELAYER_NEO_N3_AUTO_TOPUP_AMOUNT_FIXED8'),
          '100000000'
        ),
        maxTopUpAmount: parseIntegerString(
          env('MORPHEUS_RELAYER_NEO_N3_AUTO_TOPUP_MAX_FIXED8'),
          '500000000'
        ),
      },
    },
    neox: {
      // EVM kernel uses request-cursor discovery (getRequest/totalRequests) — no
      // genesis block scan, cold-starts at the request-id tail like Neo N3.
      scanMode: trimString(env('MORPHEUS_RELAYER_NEOX_SCAN_MODE')) || 'request_cursor',
      rpcUrl:
        trimString(env('MORPHEUS_RELAYER_NEOX_RPC_URL', 'NEOX_RPC')) ||
        trimString(registry.neo_x?.rpc_url || '') ||
        (network === 'mainnet'
          ? 'https://mainnet-1.rpc.banelabs.org'
          : 'https://neoxt4seed1.ngd.network'),
      // Failover RPC list for READS (B4): a single dead Neo X RPC must not kill
      // the whole neox lane (Neo N3 already rotates). The primary rpcUrl above is
      // always first; the rest come from MORPHEUS_RELAYER_NEOX_RPC_URLS / registry
      // plus per-net public defaults. De-duped, order preserved. The signer/submit
      // path stays pinned to rpcUrl (a stable per-signer key) so failover never
      // rotates the URL used for nonce management mid-flight.
      rpcUrls: requireHttpsRpcUrls(
        uniqueOrdered([
          trimString(env('MORPHEUS_RELAYER_NEOX_RPC_URL', 'NEOX_RPC')) ||
            trimString(registry.neo_x?.rpc_url || '') ||
            (network === 'mainnet'
              ? 'https://mainnet-1.rpc.banelabs.org'
              : 'https://neoxt4seed1.ngd.network'),
          ...parseUrlList(env('MORPHEUS_RELAYER_NEOX_RPC_URLS', 'NEOX_RPC_URLS')),
          ...parseUrlList(registry.neo_x?.rpc_urls || []),
          ...(network === 'mainnet'
            ? ['https://mainnet-1.rpc.banelabs.org', 'https://mainnet-2.rpc.banelabs.org']
            : ['https://neoxt4seed1.ngd.network', 'https://neoxt4seed2.ngd.network']),
        ]),
        `Neo X ${network} RPC`
      ),
      // Must be correct — it is bound into the fulfillment digest the kernel verifies.
      // The reviewed per-network registry is the fallback authority; an explicit
      // environment value remains an operator assertion for compatibility.
      chainId: resolveReviewedNeoXChainId(
        network,
        registry,
        env('MORPHEUS_RELAYER_NEOX_CHAIN_ID', 'NEOX_CHAIN_ID')
      ),
      oracleContract:
        trimString(env('MORPHEUS_RELAYER_NEOX_ORACLE', 'NEOX_ORACLE')) ||
        trimString(registry.neo_x?.contracts?.morpheus_oracle || ''),
      datafeedContract:
        trimString(env('MORPHEUS_RELAYER_NEOX_DATAFEED', 'NEOX_DATAFEED')) ||
        trimString(registry.neo_x?.contracts?.morpheus_datafeed || ''),
      feedGasLimit: Math.max(
        parseNumericEnv(env('MORPHEUS_RELAYER_NEOX_FEED_GAS_LIMIT'), 2_000_000),
        21_000
      ),
      // Legacy host secp256k1 signing is only available for an explicitly
      // opted-in non-production test. The production Rust EIF has no complete
      // EVM custody signer, so createRelayerConfig refuses the Neo X lane.
      allowHostSigner: allowInsecureHostEvmSigner,
      custodyKeyIds: {
        updater: trimString(env('SIGNER_ROLE_NEOX_UPDATER_KEY_ID')),
        verifier: trimString(env('SIGNER_ROLE_NEOX_VERIFIER_KEY_ID')),
      },
      updaterPrivateKey: allowInsecureHostEvmSigner
        ? trimString(env('MORPHEUS_RELAYER_NEOX_UPDATER_PK', 'NEOX_UPDATER_PK', 'NEOX_FEED_PK'))
        : '',
      verifierPrivateKey: allowInsecureHostEvmSigner
        ? trimString(env('MORPHEUS_RELAYER_NEOX_VERIFIER_PK', 'NEOX_VERIFIER_PK'))
        : '',
      // Deadline for the fulfillRequest receipt wait — a never-mined tx must not
      // wedge the per-signer submission queue (mirrors the Neo N3 45s default).
      confirmTimeoutMs: Math.max(
        parseNumericEnv(env('MORPHEUS_RELAYER_NEOX_CONFIRM_TIMEOUT_MS'), 45_000),
        1000
      ),
      workerUrl: trimString(env('MORPHEUS_RELAYER_NEOX_WORKER_URL', 'NEOX_WORKER_URL')),
    },
    metricsServer: {
      host: env('MORPHEUS_RELAYER_METRICS_HOST') || '127.0.0.1',
      port: Math.max(parseNumericEnv(env('MORPHEUS_RELAYER_METRICS_PORT'), 9464), 1),
      path: env('MORPHEUS_RELAYER_METRICS_PATH') || '/metrics',
    },
    heartbeats: {
      relayer: env('MORPHEUS_BETTERSTACK_RELAYER_HEARTBEAT_URL'),
      feedRelayer: env('MORPHEUS_BETTERSTACK_RELAYER_FEED_HEARTBEAT_URL'),
      failure: env('MORPHEUS_BETTERSTACK_RELAYER_FAILURE_URL'),
      // Dead-letter (permanent callback loss) push alert (F1). Falls back to the
      // generic failure URL when unset, so configuring only the failure URL keeps
      // the existing single-channel behavior; set a dedicated URL to route the
      // single most important incident — a permanently dropped oracle callback —
      // to its own alert channel.
      deadLetter: env('MORPHEUS_BETTERSTACK_RELAYER_DEADLETTER_URL'),
    },
  };
}
