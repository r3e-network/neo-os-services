import { trimString } from './lib-strings.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseDotEnv } from './lib-env.mjs';
import {
  NEO_N3_SIGNER_ENV_KEYS,
  resolvePinnedNeoN3Role,
  resolvePinnedNeoN3RolePreferMatch,
} from './lib-neo-signers.mjs';

const repoRoot = process.cwd();
const rootEnvPath = path.resolve(repoRoot, '.env');
const rootEnvLocalPath = path.resolve(repoRoot, '.env.local');

function parseArgs(argv = process.argv.slice(2)) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (current === '--network') {
      parsed.network = argv[index + 1] || '';
      index += 1;
      continue;
    }
    if (current === '--output') {
      parsed.output = argv[index + 1] || '';
      index += 1;
    }
  }
  return parsed;
}

const cliArgs = parseArgs();
const requestedNetwork = trimString(cliArgs.network || process.env.NITRO_ENV_NETWORK || '');
const requestedOutput = trimString(cliArgs.output || process.env.NITRO_ENV_OUTPUT || '');

async function readLocalEnv() {
  const merged = {};
  for (const filePath of [rootEnvPath, rootEnvLocalPath]) {
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      Object.assign(merged, parseDotEnv(raw));
    } catch {
      // ignore missing env file
    }
  }
  return merged;
}

async function readExistingOutputEnv(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return parseDotEnv(raw);
  } catch {
    return {};
  }
}

async function writeSecretFile(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await fs.chmod(temporaryPath, 0o600);
    await fs.rename(temporaryPath, filePath);
    await fs.chmod(filePath, 0o600);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
  }
}

async function readNetworkRegistry(network) {
  try {
    const raw = await fs.readFile(
      path.resolve(repoRoot, 'config/networks', `${network}.json`),
      'utf8'
    );
    return JSON.parse(raw);
  } catch {
    return { neo_n3: { contracts: {} } };
  }
}

function createResolver(localEnv, existingEnv) {
  return (...keys) => {
    for (const key of keys) {
      const localValue = trimString(localEnv[key]);
      if (localValue) return localValue;
      const processValue = trimString(process.env[key]);
      if (processValue) return processValue;
      const existingValue = trimString(existingEnv[key]);
      if (existingValue) return existingValue;
    }
    return '';
  };
}

function createInputOnlyResolver(localEnv) {
  return (key) => {
    if (Object.prototype.hasOwnProperty.call(localEnv, key)) {
      return trimString(localEnv[key]);
    }
    const processValue = trimString(process.env[key]);
    if (processValue || Object.prototype.hasOwnProperty.call(process.env, key)) {
      return processValue;
    }
    return '';
  };
}

function line(key, value) {
  return `${key}=${value ?? ''}`;
}

function resolveOracleKeystorePath(get) {
  const configured = get('NITRO_ORACLE_KEYSTORE_PATH', 'MORPHEUS_ORACLE_KEYSTORE_PATH');
  if (!configured || configured === '/data/morpheus-oracle-key.json') {
    return '/data/morpheus/oracle-key.json';
  }
  return configured;
}

const localEnv = await readLocalEnv();
const initialNetwork =
  requestedNetwork ||
  trimString(process.env.MORPHEUS_NETWORK || localEnv.MORPHEUS_NETWORK) ||
  'testnet';
const initialOutputPath = path.resolve(
  repoRoot,
  requestedOutput || `deploy/nitro/morpheus.${initialNetwork}.env`
);
const existingEnv = await readExistingOutputEnv(initialOutputPath);
const network =
  requestedNetwork ||
  trimString(
    process.env.MORPHEUS_NETWORK || localEnv.MORPHEUS_NETWORK || existingEnv.MORPHEUS_NETWORK
  ) ||
  initialNetwork;
const outputPath = path.resolve(
  repoRoot,
  requestedOutput || `deploy/nitro/morpheus.${network}.env`
);
const registry = await readNetworkRegistry(network);
const get = createResolver(localEnv, existingEnv);
const getInputOnly = createInputOnlyResolver(localEnv);
const explicitNetworkMode = Boolean(requestedNetwork);

function resolveNetworkScoped(...keys) {
  for (const key of keys) {
    const processValue = trimString(process.env[key]);
    if (processValue) return processValue;
  }
  if (!explicitNetworkMode) {
    for (const key of keys) {
      const localValue = trimString(localEnv[key]);
      if (localValue) return localValue;
    }
  }
  for (const key of keys) {
    const existingValue = trimString(existingEnv[key]);
    if (existingValue) return existingValue;
  }
  if (explicitNetworkMode) {
    for (const key of keys) {
      const localValue = trimString(localEnv[key]);
      if (localValue) return localValue;
    }
  }
  return '';
}

function resolveRegistryBackedValue(registryValue, ...keys) {
  if (explicitNetworkMode && trimString(registryValue)) {
    return trimString(registryValue);
  }
  for (const key of keys) {
    const processValue = trimString(process.env[key]);
    if (processValue) return processValue;
  }
  for (const key of keys) {
    const localValue = trimString(localEnv[key]);
    if (localValue) return localValue;
  }
  for (const key of keys) {
    const existingValue = trimString(existingEnv[key]);
    if (existingValue) return existingValue;
  }
  return trimString(registryValue);
}

function resolveNetworkScopedValue(baseKey, { allowGeneric = true, defaultValue = '' } = {}) {
  const scopedKey = `${baseKey}_${network.toUpperCase()}`;
  const scoped = resolveNetworkScoped(scopedKey);
  if (scoped) return scoped;
  if (allowGeneric) {
    const generic = resolveNetworkScoped(baseKey);
    if (generic) return generic;
  }
  return defaultValue;
}

function profileDefault(testnetValue, mainnetValue) {
  return network === 'mainnet' ? mainnetValue : testnetValue;
}

function profileTunable(key, testnetValue, mainnetValue) {
  const explicit = getInputOnly(key);
  return explicit || profileDefault(testnetValue, mainnetValue);
}

function resolveSignerScoped(...keys) {
  for (const key of keys) {
    const processValue = trimString(process.env[key]);
    if (processValue) return processValue;
  }
  for (const key of keys) {
    const localValue = trimString(localEnv[key]);
    if (localValue) return localValue;
  }
  return '';
}

function buildSignerSnapshot() {
  const snapshot = {};
  for (const key of NEO_N3_SIGNER_ENV_KEYS) {
    const value = resolveSignerScoped(key);
    if (value) snapshot[key] = value;
  }
  return snapshot;
}

function resolvePinnedRoleMaterial(role) {
  const report = resolvePinnedNeoN3RolePreferMatch(network, role, {
    env: buildSignerSnapshot(),
  });
  return {
    report,
    wif: report.materialized?.wif || '',
    privateKey: report.materialized?.private_key || '',
    publicKey: report.public_key || '',
  };
}

function resolveUseDerivedKeysDefault() {
  const explicit = get('NITRO_USE_DERIVED_KEYS');
  if (explicit) return explicit;

  const verifier = resolvePinnedRoleMaterial('oracle_verifier');
  const hasExplicitTestnetVerifier =
    network === 'testnet' && Boolean(verifier.wif || verifier.privateKey);
  return hasExplicitTestnetVerifier ? 'false' : 'true';
}

function resolveNeoN3ScanModeDefault() {
  const explicit = get('MORPHEUS_RELAYER_NEO_N3_SCAN_MODE');
  if (explicit) return explicit;
  return 'request_cursor';
}

function mergeCsvList(primary, additions = []) {
  const seen = new Set();
  const out = [];
  for (const raw of [primary, ...additions]) {
    for (const item of String(raw || '').split(',')) {
      const normalized = trimString(item);
      if (!normalized) continue;
      const dedupeKey = normalized.toLowerCase();
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      out.push(normalized);
    }
  }
  return out.join(',');
}

const workerSigner = resolvePinnedRoleMaterial('worker');
const relayerSigner = resolvePinnedRoleMaterial('relayer');
const updaterSigner = resolvePinnedRoleMaterial('updater');
const verifierSigner = resolvePinnedRoleMaterial('oracle_verifier');
const networkEnvSuffix = network.toUpperCase();

const runtimeConfig = {
  TWELVEDATA_API_KEY: get('TWELVEDATA_API_KEY'),
  WEB3AUTH_CLIENT_ID: get('WEB3AUTH_CLIENT_ID', 'NEXT_PUBLIC_WEB3AUTH_CLIENT_ID'),
  WEB3AUTH_JWKS_URL:
    get('WEB3AUTH_JWKS_URL') || 'https://api-auth.web3auth.io/.well-known/jwks.json',
  MORPHEUS_PROVIDER_CONFIG_API_KEY: get(
    'MORPHEUS_PROVIDER_CONFIG_API_KEY',
    'ADMIN_CONSOLE_API_KEY'
  ),
  MORPHEUS_RELAYER_ADMIN_API_KEY: get(
    'MORPHEUS_RELAYER_ADMIN_API_KEY',
    'MORPHEUS_OPERATOR_API_KEY',
    'ADMIN_CONSOLE_API_KEY'
  ),
  MORPHEUS_SIGNING_ADMIN_API_KEY: get(
    'MORPHEUS_SIGNING_ADMIN_API_KEY',
    'MORPHEUS_OPERATOR_API_KEY',
    'ADMIN_CONSOLE_API_KEY'
  ),
  MORPHEUS_RELAY_ADMIN_API_KEY: get(
    'MORPHEUS_RELAY_ADMIN_API_KEY',
    'MORPHEUS_OPERATOR_API_KEY',
    'ADMIN_CONSOLE_API_KEY'
  ),
  MORPHEUS_OPERATOR_API_KEY: get('MORPHEUS_OPERATOR_API_KEY', 'ADMIN_CONSOLE_API_KEY'),
  MORPHEUS_NETWORK: network,
  NEO_RPC_URL: resolveRegistryBackedValue(registry.neo_n3?.rpc_url || '', 'NEO_RPC_URL'),
  NEO_NETWORK_MAGIC: resolveRegistryBackedValue(
    String(registry.neo_n3?.network_magic || 894710606),
    'NEO_NETWORK_MAGIC'
  ),
  CONTRACT_MORPHEUS_ORACLE_HASH: resolveRegistryBackedValue(
    registry.neo_n3?.contracts?.morpheus_oracle || '',
    'CONTRACT_MORPHEUS_ORACLE_HASH'
  ),
  CONTRACT_ORACLE_CALLBACK_CONSUMER_HASH: resolveRegistryBackedValue(
    registry.neo_n3?.contracts?.oracle_callback_consumer || '',
    'CONTRACT_ORACLE_CALLBACK_CONSUMER_HASH'
  ),
  CONTRACT_MORPHEUS_DATAFEED_HASH: resolveRegistryBackedValue(
    registry.neo_n3?.contracts?.morpheus_datafeed || '',
    'CONTRACT_MORPHEUS_DATAFEED_HASH'
  ),
  MORPHEUS_WORKER_NEO_N3_WIF: workerSigner.wif,
  MORPHEUS_WORKER_NEO_N3_PRIVATE_KEY: workerSigner.privateKey,
  [`MORPHEUS_WORKER_NEO_N3_WIF_${networkEnvSuffix}`]: workerSigner.wif,
  [`MORPHEUS_WORKER_NEO_N3_PRIVATE_KEY_${networkEnvSuffix}`]: workerSigner.privateKey,
  MORPHEUS_ORACLE_VERIFIER_WIF: verifierSigner.wif,
  MORPHEUS_ORACLE_VERIFIER_PRIVATE_KEY: verifierSigner.privateKey,
  MORPHEUS_UPDATER_NEO_N3_WIF: updaterSigner.wif,
  MORPHEUS_UPDATER_NEO_N3_PRIVATE_KEY: updaterSigner.privateKey,
  [`MORPHEUS_UPDATER_NEO_N3_WIF_${networkEnvSuffix}`]: updaterSigner.wif,
  [`MORPHEUS_UPDATER_NEO_N3_PRIVATE_KEY_${networkEnvSuffix}`]: updaterSigner.privateKey,
  MORPHEUS_RELAYER_NEO_N3_WIF: relayerSigner.wif,
  MORPHEUS_RELAYER_NEO_N3_PRIVATE_KEY: relayerSigner.privateKey,
  MORPHEUS_FEED_PROJECT_SLUG: get('MORPHEUS_FEED_PROJECT_SLUG') || 'morpheus',
  MORPHEUS_FEED_PROVIDER: get('MORPHEUS_FEED_PROVIDER') || 'twelvedata',
  MORPHEUS_FEED_PROVIDERS: get('MORPHEUS_FEED_PROVIDERS') || 'twelvedata',
  MORPHEUS_FEED_SYMBOLS:
    get('MORPHEUS_FEED_SYMBOLS') ||
    'NEO-USD,GAS-USD,BTC-USD,ETH-USD,SOL-USD,TRX-USD,PAXG-USD,WTI-USD,BRENT-USD,NATGAS-USD,COPPER-USD,WHEAT-USD,CORN-USD,SOY-USD,USDT-USD,USDC-USD,BNB-USD,XRP-USD,DOGE-USD,AAPL-USD,GOOGL-USD,MSFT-USD,AMZN-USD,TSLA-USD,META-USD,NVDA-USD,SPY-USD,QQQ-USD,GLD-USD,EUR-USD,GBP-USD,JPY-USD,CNY-USD',
  MORPHEUS_FEED_CHANGE_THRESHOLD_BPS: get('MORPHEUS_FEED_CHANGE_THRESHOLD_BPS') || '10',
  MORPHEUS_FEED_MIN_UPDATE_INTERVAL_MS: get('MORPHEUS_FEED_MIN_UPDATE_INTERVAL_MS') || '60000',
  MORPHEUS_FEED_STALE_AFTER_MS: get('MORPHEUS_FEED_STALE_AFTER_MS') || '300000',
  MORPHEUS_FEED_SYNC_INTERVAL_MS: get('MORPHEUS_FEED_SYNC_INTERVAL_MS') || '60000',
  MORPHEUS_FEED_SYNC_TIMEOUT_MS: get('MORPHEUS_FEED_SYNC_TIMEOUT_MS') || '10000',
  MORPHEUS_FEED_BOOTSTRAP_SUPABASE_ENABLED:
    get('MORPHEUS_FEED_BOOTSTRAP_SUPABASE_ENABLED') || 'true',
  MORPHEUS_FEED_SNAPSHOT_SUPABASE_ENABLED: get('MORPHEUS_FEED_SNAPSHOT_SUPABASE_ENABLED') || 'true',
  MORPHEUS_RELAYER_POLL_INTERVAL_MS: get('MORPHEUS_RELAYER_POLL_INTERVAL_MS') || '5000',
  MORPHEUS_RELAYER_CONCURRENCY: get('MORPHEUS_RELAYER_CONCURRENCY') || '4',
  MORPHEUS_RELAYER_MAX_BLOCKS_PER_TICK: get('MORPHEUS_RELAYER_MAX_BLOCKS_PER_TICK') || '250',
  MORPHEUS_RELAYER_MAX_RETRIES: get('MORPHEUS_RELAYER_MAX_RETRIES') || '5',
  MORPHEUS_RELAYER_RETRY_BASE_DELAY_MS: get('MORPHEUS_RELAYER_RETRY_BASE_DELAY_MS') || '5000',
  MORPHEUS_RELAYER_RETRY_MAX_DELAY_MS: get('MORPHEUS_RELAYER_RETRY_MAX_DELAY_MS') || '10000',
  MORPHEUS_RELAYER_PROCESSED_CACHE_SIZE: get('MORPHEUS_RELAYER_PROCESSED_CACHE_SIZE') || '5000',
  MORPHEUS_RELAYER_DEAD_LETTER_LIMIT: get('MORPHEUS_RELAYER_DEAD_LETTER_LIMIT') || '500',
  MORPHEUS_RELAYER_MODE: get('MORPHEUS_RELAYER_MODE') || 'combined',
  MORPHEUS_DURABLE_QUEUE_ENABLED: get('MORPHEUS_DURABLE_QUEUE_ENABLED') || 'true',
  MORPHEUS_DURABLE_QUEUE_FAIL_CLOSED: get('MORPHEUS_DURABLE_QUEUE_FAIL_CLOSED') || 'true',
  MORPHEUS_DURABLE_QUEUE_SYNC_LIMIT: get('MORPHEUS_DURABLE_QUEUE_SYNC_LIMIT') || '200',
  MORPHEUS_DURABLE_QUEUE_STALE_PROCESSING_MS:
    get('MORPHEUS_DURABLE_QUEUE_STALE_PROCESSING_MS') || '45000',
  MORPHEUS_RELAYER_MAX_FRESH_EVENTS_PER_TICK: profileTunable(
    'MORPHEUS_RELAYER_MAX_FRESH_EVENTS_PER_TICK',
    '16',
    '64'
  ),
  MORPHEUS_RELAYER_MAX_RETRY_EVENTS_PER_TICK: profileTunable(
    'MORPHEUS_RELAYER_MAX_RETRY_EVENTS_PER_TICK',
    '8',
    '32'
  ),
  MORPHEUS_RELAYER_DEFER_DELAY_MS: profileTunable(
    'MORPHEUS_RELAYER_DEFER_DELAY_MS',
    '5000',
    '3000'
  ),
  MORPHEUS_RELAYER_NEO_N3_SCAN_MODE: resolveNeoN3ScanModeDefault(),
  MORPHEUS_RELAYER_NEO_N3_START_REQUEST_ID: get('MORPHEUS_RELAYER_NEO_N3_START_REQUEST_ID') || '',
  MORPHEUS_AUTOMATION_ENABLED: get('MORPHEUS_AUTOMATION_ENABLED') || 'true',
  MORPHEUS_AUTOMATION_BATCH_SIZE: get('MORPHEUS_AUTOMATION_BATCH_SIZE') || '50',
  MORPHEUS_AUTOMATION_MAX_QUEUED_PER_TICK: get('MORPHEUS_AUTOMATION_MAX_QUEUED_PER_TICK') || '10',
  MORPHEUS_AUTOMATION_PRICE_PAIRS_PER_TICK: get('MORPHEUS_AUTOMATION_PRICE_PAIRS_PER_TICK') || '64',
  MORPHEUS_AUTOMATION_DEFAULT_PRICE_COOLDOWN_MS:
    get('MORPHEUS_AUTOMATION_DEFAULT_PRICE_COOLDOWN_MS') || '60000',
  MORPHEUS_RELAYER_LOG_FORMAT: get('MORPHEUS_RELAYER_LOG_FORMAT', 'LOG_FORMAT') || 'json',
  MORPHEUS_RELAYER_LOG_LEVEL: get('MORPHEUS_RELAYER_LOG_LEVEL', 'LOG_LEVEL') || 'info',
  MORPHEUS_RELAYER_NEO_N3_START_BLOCK:
    resolveNetworkScopedValue('MORPHEUS_RELAYER_NEO_N3_START_BLOCK', {
      allowGeneric: network === 'mainnet',
      defaultValue:
        network === 'mainnet' ? existingEnv.MORPHEUS_RELAYER_NEO_N3_START_BLOCK || '' : '',
    }) || '',
  ORACLE_TIMEOUT: get('ORACLE_TIMEOUT') || '8s',
  ORACLE_MAX_PROVIDER_BODY_BYTES: get('ORACLE_MAX_PROVIDER_BODY_BYTES') || '65536',
  ORACLE_SCRIPT_TIMEOUT_MS: get('ORACLE_SCRIPT_TIMEOUT_MS') || '2000',
  ORACLE_WASM_TIMEOUT_MS:
    get('ORACLE_WASM_TIMEOUT_MS') || get('MORPHEUS_WASM_TIMEOUT_MS') || '10000',
  COMPUTE_SCRIPT_TIMEOUT_MS: get('COMPUTE_SCRIPT_TIMEOUT_MS') || '2000',
  COMPUTE_WASM_TIMEOUT_MS:
    get('COMPUTE_WASM_TIMEOUT_MS') || get('MORPHEUS_WASM_TIMEOUT_MS') || '10000',
  MORPHEUS_WASM_TIMEOUT_MS: get('MORPHEUS_WASM_TIMEOUT_MS') || '10000',
  MORPHEUS_ENABLE_UNTRUSTED_SCRIPTS: get('MORPHEUS_ENABLE_UNTRUSTED_SCRIPTS'),
  NITRO_USE_DERIVED_KEYS: resolveUseDerivedKeysDefault(),
  NITRO_EMIT_ATTESTATION: get('NITRO_EMIT_ATTESTATION') || 'true',
  NITRO_NEO_N3_KEY_PATH: getInputOnly('NITRO_NEO_N3_KEY_PATH'),
  NITRO_RELAYER_NEO_N3_KEY_PATH: getInputOnly('NITRO_RELAYER_NEO_N3_KEY_PATH'),
  NITRO_UPDATER_NEO_N3_KEY_PATH: getInputOnly('NITRO_UPDATER_NEO_N3_KEY_PATH'),
  NITRO_ORACLE_VERIFIER_NEO_N3_KEY_PATH: getInputOnly('NITRO_ORACLE_VERIFIER_NEO_N3_KEY_PATH'),
  NITRO_DSTACK_ORACLE_ENCRYPTION_KEY_PATH: getInputOnly('NITRO_DSTACK_ORACLE_ENCRYPTION_KEY_PATH'),
  NITRO_ORACLE_KEYSTORE_PATH: resolveOracleKeystorePath(get),
  MORPHEUS_PAYMASTER_TESTNET_ENABLED: get('MORPHEUS_PAYMASTER_TESTNET_ENABLED'),
  MORPHEUS_PAYMASTER_TESTNET_POLICY_ID: get('MORPHEUS_PAYMASTER_TESTNET_POLICY_ID'),
  MORPHEUS_PAYMASTER_TESTNET_MAX_GAS_UNITS: get('MORPHEUS_PAYMASTER_TESTNET_MAX_GAS_UNITS'),
  MORPHEUS_PAYMASTER_TESTNET_ALLOW_TARGETS: mergeCsvList(
    get('MORPHEUS_PAYMASTER_TESTNET_ALLOW_TARGETS'),
    [trimString(registry.neo_n3?.contracts?.abstract_account || '')]
  ),
  MORPHEUS_PAYMASTER_TESTNET_ALLOW_METHODS: mergeCsvList(
    get('MORPHEUS_PAYMASTER_TESTNET_ALLOW_METHODS'),
    ['executeUserOp', 'executeUnifiedByAddress']
  ),
  MORPHEUS_PAYMASTER_TESTNET_ALLOW_ACCOUNTS: get('MORPHEUS_PAYMASTER_TESTNET_ALLOW_ACCOUNTS'),
  MORPHEUS_PAYMASTER_TESTNET_BLOCK_ACCOUNTS: get('MORPHEUS_PAYMASTER_TESTNET_BLOCK_ACCOUNTS'),
  MORPHEUS_PAYMASTER_TESTNET_ALLOW_DAPPS: get('MORPHEUS_PAYMASTER_TESTNET_ALLOW_DAPPS'),
  MORPHEUS_PAYMASTER_TESTNET_TTL_MS: get('MORPHEUS_PAYMASTER_TESTNET_TTL_MS'),
  MORPHEUS_PAYMASTER_MAINNET_ENABLED: get('MORPHEUS_PAYMASTER_MAINNET_ENABLED'),
  MORPHEUS_PAYMASTER_MAINNET_POLICY_ID: get('MORPHEUS_PAYMASTER_MAINNET_POLICY_ID'),
  MORPHEUS_PAYMASTER_MAINNET_MAX_GAS_UNITS: get('MORPHEUS_PAYMASTER_MAINNET_MAX_GAS_UNITS'),
  MORPHEUS_PAYMASTER_MAINNET_ALLOW_TARGETS: get('MORPHEUS_PAYMASTER_MAINNET_ALLOW_TARGETS'),
  MORPHEUS_PAYMASTER_MAINNET_ALLOW_METHODS: get('MORPHEUS_PAYMASTER_MAINNET_ALLOW_METHODS'),
  MORPHEUS_PAYMASTER_MAINNET_ALLOW_ACCOUNTS: get('MORPHEUS_PAYMASTER_MAINNET_ALLOW_ACCOUNTS'),
  MORPHEUS_PAYMASTER_MAINNET_BLOCK_ACCOUNTS: get('MORPHEUS_PAYMASTER_MAINNET_BLOCK_ACCOUNTS'),
  MORPHEUS_PAYMASTER_MAINNET_ALLOW_DAPPS: get('MORPHEUS_PAYMASTER_MAINNET_ALLOW_DAPPS'),
  MORPHEUS_PAYMASTER_MAINNET_TTL_MS: get('MORPHEUS_PAYMASTER_MAINNET_TTL_MS'),
};

const signerDiagnostics = [workerSigner.report, relayerSigner.report, verifierSigner.report]
  .filter((entry) => entry.issues.length > 0)
  .map((entry) => `${entry.role}: ${entry.issues.join('; ')}`);
if (signerDiagnostics.length > 0) {
  console.error(`render-nitro-compose-env signer corrections applied for ${network}:`);
  for (const line of signerDiagnostics) console.error(`- ${line}`);
}

const runtimeUsesDerivedKeys = resolveUseDerivedKeysDefault().toLowerCase() === 'true';
for (const role of ['worker', 'relayer', 'updater', 'oracle_verifier']) {
  resolvePinnedNeoN3Role(network, role, {
    env: runtimeConfig,
    allowMissing: runtimeUsesDerivedKeys && role !== 'oracle_verifier',
  });
}

const lines = [
  '# Generated from root .env and config/networks; do not commit.',
  line(
    'MORPHEUS_NITRO_WORKER_IMAGE',
    getInputOnly('MORPHEUS_NITRO_WORKER_IMAGE') ||
      'ghcr.io/r3e-network/neo-os-services-nitro-worker:latest'
  ),
  line(
    'MORPHEUS_RELAYER_IMAGE',
    getInputOnly('MORPHEUS_RELAYER_IMAGE') || 'ghcr.io/r3e-network/neo-os-services-relayer:latest'
  ),
  '',
  line('NITROCORE_PORT', get('NITROCORE_PORT') || '8080'),
  line('MORPHEUS_RUNTIME_TOKEN', get('MORPHEUS_RUNTIME_TOKEN', 'NITRO_API_TOKEN')),
  line('NITRO_API_TOKEN', get('NITRO_API_TOKEN', 'MORPHEUS_RUNTIME_TOKEN')),
  line('CLOUDFLARE_DNS_API_TOKEN', get('CLOUDFLARE_DNS_API_TOKEN', 'CLOUDFLARE_API_TOKEN')),
  line('CERTBOT_EMAIL', get('CERTBOT_EMAIL', 'MORPHEUS_CERTBOT_EMAIL')),
  line(
    'MORPHEUS_CUSTOM_DOMAIN',
    network === 'mainnet'
      ? get('MORPHEUS_MAINNET_CUSTOM_DOMAIN', 'MORPHEUS_CUSTOM_DOMAIN')
      : get('MORPHEUS_TESTNET_CUSTOM_DOMAIN', 'MORPHEUS_CUSTOM_DOMAIN')
  ),
  line('MORPHEUS_INGRESS_PORT', get('MORPHEUS_INGRESS_PORT') || '443'),
  line('MORPHEUS_INGRESS_SET_CAA', get('MORPHEUS_INGRESS_SET_CAA') || 'false'),
  line('MORPHEUS_HEARTBEAT_TIMEOUT_MS', get('MORPHEUS_HEARTBEAT_TIMEOUT_MS') || '3000'),
  line(
    'MORPHEUS_BETTERSTACK_CRON_FEED_HEARTBEAT_URL',
    get('MORPHEUS_BETTERSTACK_CRON_FEED_HEARTBEAT_URL')
  ),
  line(
    'MORPHEUS_BETTERSTACK_CRON_FEED_FAILURE_URL',
    get('MORPHEUS_BETTERSTACK_CRON_FEED_FAILURE_URL')
  ),
  line(
    'MORPHEUS_BETTERSTACK_CRON_HEALTH_HEARTBEAT_URL',
    get('MORPHEUS_BETTERSTACK_CRON_HEALTH_HEARTBEAT_URL')
  ),
  line(
    'MORPHEUS_BETTERSTACK_RELAYER_HEARTBEAT_URL',
    get('MORPHEUS_BETTERSTACK_RELAYER_HEARTBEAT_URL')
  ),
  line(
    'MORPHEUS_BETTERSTACK_RELAYER_FEED_HEARTBEAT_URL',
    get('MORPHEUS_BETTERSTACK_RELAYER_FEED_HEARTBEAT_URL')
  ),
  line('MORPHEUS_BETTERSTACK_RELAYER_FAILURE_URL', get('MORPHEUS_BETTERSTACK_RELAYER_FAILURE_URL')),
  line('UPSTASH_REDIS_REST_URL', get('UPSTASH_REDIS_REST_URL')),
  line('UPSTASH_REDIS_REST_TOKEN', get('UPSTASH_REDIS_REST_TOKEN')),
  line('MORPHEUS_UPSTASH_GUARDS_ENABLED', get('MORPHEUS_UPSTASH_GUARDS_ENABLED') || 'false'),
  line('MORPHEUS_UPSTASH_FAIL_CLOSED', get('MORPHEUS_UPSTASH_FAIL_CLOSED') || 'false'),
  line(
    'MORPHEUS_RATE_LIMIT_PAYMASTER_AUTHORIZE_MAX',
    get('MORPHEUS_RATE_LIMIT_PAYMASTER_AUTHORIZE_MAX') || '20'
  ),
  line(
    'MORPHEUS_RATE_LIMIT_RELAY_TRANSACTION_MAX',
    get('MORPHEUS_RATE_LIMIT_RELAY_TRANSACTION_MAX') || '20'
  ),
  line(
    'MORPHEUS_RATE_LIMIT_COMPUTE_EXECUTE_MAX',
    get('MORPHEUS_RATE_LIMIT_COMPUTE_EXECUTE_MAX') || '10'
  ),
  line('MORPHEUS_RATE_LIMIT_VRF_RANDOM_MAX', get('MORPHEUS_RATE_LIMIT_VRF_RANDOM_MAX') || '15'),
  line('MORPHEUS_RATE_LIMIT_ORACLE_QUERY_MAX', get('MORPHEUS_RATE_LIMIT_ORACLE_QUERY_MAX') || '30'),
  line('GRAFANA_CLOUD_PROMETHEUS_PUSH_URL', get('GRAFANA_CLOUD_PROMETHEUS_PUSH_URL')),
  line('GRAFANA_CLOUD_PROMETHEUS_USERNAME', get('GRAFANA_CLOUD_PROMETHEUS_USERNAME')),
  line('GRAFANA_CLOUD_PROMETHEUS_API_KEY', get('GRAFANA_CLOUD_PROMETHEUS_API_KEY')),
  line(
    'MORPHEUS_MAX_INFLIGHT_ORACLE_QUERY',
    profileTunable('MORPHEUS_MAX_INFLIGHT_ORACLE_QUERY', '4', '16')
  ),
  line(
    'MORPHEUS_MAX_INFLIGHT_ORACLE_SMART_FETCH',
    profileTunable('MORPHEUS_MAX_INFLIGHT_ORACLE_SMART_FETCH', '1', '8')
  ),
  line(
    'MORPHEUS_MAX_INFLIGHT_COMPUTE_EXECUTE',
    profileTunable('MORPHEUS_MAX_INFLIGHT_COMPUTE_EXECUTE', '1', '6')
  ),
  line(
    'MORPHEUS_MAX_INFLIGHT_VRF_RANDOM',
    profileTunable('MORPHEUS_MAX_INFLIGHT_VRF_RANDOM', '2', '6')
  ),
  line(
    'MORPHEUS_MAX_INFLIGHT_PAYMASTER_AUTHORIZE',
    profileTunable('MORPHEUS_MAX_INFLIGHT_PAYMASTER_AUTHORIZE', '4', '12')
  ),
  line(
    'MORPHEUS_MAX_INFLIGHT_RELAY_TRANSACTION',
    profileTunable('MORPHEUS_MAX_INFLIGHT_RELAY_TRANSACTION', '4', '10')
  ),
  line(
    'MORPHEUS_MAX_INFLIGHT_NEODID_BIND',
    profileTunable('MORPHEUS_MAX_INFLIGHT_NEODID_BIND', '3', '8')
  ),
  line(
    'MORPHEUS_MAX_INFLIGHT_NEODID_ACTION_TICKET',
    profileTunable('MORPHEUS_MAX_INFLIGHT_NEODID_ACTION_TICKET', '3', '8')
  ),
  line(
    'MORPHEUS_MAX_INFLIGHT_NEODID_RECOVERY_TICKET',
    profileTunable('MORPHEUS_MAX_INFLIGHT_NEODID_RECOVERY_TICKET', '2', '4')
  ),
  line('TWELVEDATA_API_KEY', get('TWELVEDATA_API_KEY')),
  '',
  line('NEXT_PUBLIC_SUPABASE_URL', get('NEXT_PUBLIC_SUPABASE_URL', 'morpheus_SUPABASE_URL')),
  line(
    'NEXT_PUBLIC_SUPABASE_ANON_KEY',
    get('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'NEXT_PUBLIC_morpheus_SUPABASE_ANON_KEY')
  ),
  line('SUPABASE_URL', get('SUPABASE_URL', 'morpheus_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL')),
  line(
    'SUPABASE_SECRET_KEY',
    get(
      'SUPABASE_SECRET_KEY',
      'morpheus_SUPABASE_SECRET_KEY',
      'SUPABASE_SERVICE_ROLE_KEY',
      'morpheus_SUPABASE_SERVICE_ROLE_KEY'
    )
  ),
  line(
    'SUPABASE_SERVICE_ROLE_KEY',
    get(
      'SUPABASE_SERVICE_ROLE_KEY',
      'morpheus_SUPABASE_SERVICE_ROLE_KEY',
      'SUPABASE_SECRET_KEY',
      'morpheus_SUPABASE_SECRET_KEY'
    )
  ),
  line('MORPHEUS_RUNTIME_CONFIG_JSON', JSON.stringify(runtimeConfig)),
  line(
    'MORPHEUS_PROVIDER_CONFIG_API_KEY',
    get('MORPHEUS_PROVIDER_CONFIG_API_KEY', 'ADMIN_CONSOLE_API_KEY')
  ),
  line(
    'MORPHEUS_RELAYER_ADMIN_API_KEY',
    get('MORPHEUS_RELAYER_ADMIN_API_KEY', 'MORPHEUS_OPERATOR_API_KEY', 'ADMIN_CONSOLE_API_KEY')
  ),
  line(
    'MORPHEUS_SIGNING_ADMIN_API_KEY',
    get('MORPHEUS_SIGNING_ADMIN_API_KEY', 'MORPHEUS_OPERATOR_API_KEY', 'ADMIN_CONSOLE_API_KEY')
  ),
  line(
    'MORPHEUS_RELAY_ADMIN_API_KEY',
    get('MORPHEUS_RELAY_ADMIN_API_KEY', 'MORPHEUS_OPERATOR_API_KEY', 'ADMIN_CONSOLE_API_KEY')
  ),
  line('MORPHEUS_OPERATOR_API_KEY', get('MORPHEUS_OPERATOR_API_KEY', 'ADMIN_CONSOLE_API_KEY')),
  '',
  line('MORPHEUS_NETWORK', network),
  '',
  line('NEO_RPC_URL', runtimeConfig.NEO_RPC_URL),
  line('NEO_NETWORK_MAGIC', runtimeConfig.NEO_NETWORK_MAGIC),
  line('CONTRACT_MORPHEUS_ORACLE_HASH', runtimeConfig.CONTRACT_MORPHEUS_ORACLE_HASH),
  line(
    'CONTRACT_ORACLE_CALLBACK_CONSUMER_HASH',
    runtimeConfig.CONTRACT_ORACLE_CALLBACK_CONSUMER_HASH
  ),
  line('CONTRACT_MORPHEUS_DATAFEED_HASH', runtimeConfig.CONTRACT_MORPHEUS_DATAFEED_HASH),
  line('MORPHEUS_WORKER_NEO_N3_WIF', runtimeConfig.MORPHEUS_WORKER_NEO_N3_WIF),
  line('MORPHEUS_WORKER_NEO_N3_PRIVATE_KEY', runtimeConfig.MORPHEUS_WORKER_NEO_N3_PRIVATE_KEY),
  line('MORPHEUS_ORACLE_VERIFIER_WIF', runtimeConfig.MORPHEUS_ORACLE_VERIFIER_WIF),
  line('MORPHEUS_ORACLE_VERIFIER_PRIVATE_KEY', runtimeConfig.MORPHEUS_ORACLE_VERIFIER_PRIVATE_KEY),
  line('MORPHEUS_RELAYER_NEO_N3_WIF', runtimeConfig.MORPHEUS_RELAYER_NEO_N3_WIF),
  line('MORPHEUS_RELAYER_NEO_N3_PRIVATE_KEY', runtimeConfig.MORPHEUS_RELAYER_NEO_N3_PRIVATE_KEY),
  '',
  line('MORPHEUS_FEED_PROJECT_SLUG', get('MORPHEUS_FEED_PROJECT_SLUG') || 'morpheus'),
  line('MORPHEUS_FEED_PROVIDER', get('MORPHEUS_FEED_PROVIDER') || 'twelvedata'),
  line('MORPHEUS_FEED_PROVIDERS', get('MORPHEUS_FEED_PROVIDERS') || 'twelvedata'),
  line(
    'MORPHEUS_FEED_SYMBOLS',
    get('MORPHEUS_FEED_SYMBOLS') ||
      'NEO-USD,GAS-USD,BTC-USD,ETH-USD,SOL-USD,TRX-USD,PAXG-USD,WTI-USD,BRENT-USD,NATGAS-USD,COPPER-USD,WHEAT-USD,CORN-USD,SOY-USD,USDT-USD,USDC-USD,BNB-USD,XRP-USD,DOGE-USD,AAPL-USD,GOOGL-USD,MSFT-USD,AMZN-USD,TSLA-USD,META-USD,NVDA-USD,SPY-USD,QQQ-USD,GLD-USD,EUR-USD,GBP-USD,JPY-USD,CNY-USD'
  ),
  line('MORPHEUS_FEED_CHANGE_THRESHOLD_BPS', get('MORPHEUS_FEED_CHANGE_THRESHOLD_BPS') || '10'),
  line(
    'MORPHEUS_FEED_MIN_UPDATE_INTERVAL_MS',
    get('MORPHEUS_FEED_MIN_UPDATE_INTERVAL_MS') || '60000'
  ),
  line('MORPHEUS_FEED_STALE_AFTER_MS', get('MORPHEUS_FEED_STALE_AFTER_MS') || '300000'),
  line('MORPHEUS_FEED_SYNC_INTERVAL_MS', get('MORPHEUS_FEED_SYNC_INTERVAL_MS') || '60000'),
  line('MORPHEUS_FEED_PAIR_REGISTRY_JSON', get('MORPHEUS_FEED_PAIR_REGISTRY_JSON') || ''),
  '',
  line('MORPHEUS_RELAYER_POLL_INTERVAL_MS', get('MORPHEUS_RELAYER_POLL_INTERVAL_MS') || '5000'),
  line('MORPHEUS_RELAYER_CONCURRENCY', get('MORPHEUS_RELAYER_CONCURRENCY') || '4'),
  line(
    'MORPHEUS_RELAYER_MAX_BLOCKS_PER_TICK',
    get('MORPHEUS_RELAYER_MAX_BLOCKS_PER_TICK') || '250'
  ),
  line('MORPHEUS_RELAYER_MAX_RETRIES', get('MORPHEUS_RELAYER_MAX_RETRIES') || '5'),
  line(
    'MORPHEUS_RELAYER_RETRY_BASE_DELAY_MS',
    get('MORPHEUS_RELAYER_RETRY_BASE_DELAY_MS') || '5000'
  ),
  line(
    'MORPHEUS_RELAYER_RETRY_MAX_DELAY_MS',
    get('MORPHEUS_RELAYER_RETRY_MAX_DELAY_MS') || '10000'
  ),
  line(
    'MORPHEUS_RELAYER_PROCESSED_CACHE_SIZE',
    get('MORPHEUS_RELAYER_PROCESSED_CACHE_SIZE') || '5000'
  ),
  line('MORPHEUS_RELAYER_DEAD_LETTER_LIMIT', get('MORPHEUS_RELAYER_DEAD_LETTER_LIMIT') || '500'),
  line(
    'MORPHEUS_RELAYER_MAX_FRESH_EVENTS_PER_TICK',
    profileTunable('MORPHEUS_RELAYER_MAX_FRESH_EVENTS_PER_TICK', '16', '64')
  ),
  line(
    'MORPHEUS_RELAYER_MAX_RETRY_EVENTS_PER_TICK',
    profileTunable('MORPHEUS_RELAYER_MAX_RETRY_EVENTS_PER_TICK', '8', '32')
  ),
  line(
    'MORPHEUS_RELAYER_DEFER_DELAY_MS',
    profileTunable('MORPHEUS_RELAYER_DEFER_DELAY_MS', '5000', '3000')
  ),
  line('MORPHEUS_RELAYER_NEO_N3_SCAN_MODE', runtimeConfig.MORPHEUS_RELAYER_NEO_N3_SCAN_MODE),
  line(
    'MORPHEUS_RELAYER_NEO_N3_START_REQUEST_ID',
    runtimeConfig.MORPHEUS_RELAYER_NEO_N3_START_REQUEST_ID
  ),
  line('MORPHEUS_AUTOMATION_ENABLED', get('MORPHEUS_AUTOMATION_ENABLED') || 'true'),
  line('MORPHEUS_AUTOMATION_BATCH_SIZE', get('MORPHEUS_AUTOMATION_BATCH_SIZE') || '50'),
  line(
    'MORPHEUS_AUTOMATION_MAX_QUEUED_PER_TICK',
    get('MORPHEUS_AUTOMATION_MAX_QUEUED_PER_TICK') || '10'
  ),
  line(
    'MORPHEUS_AUTOMATION_PRICE_PAIRS_PER_TICK',
    get('MORPHEUS_AUTOMATION_PRICE_PAIRS_PER_TICK') || '64'
  ),
  line(
    'MORPHEUS_AUTOMATION_DEFAULT_PRICE_COOLDOWN_MS',
    get('MORPHEUS_AUTOMATION_DEFAULT_PRICE_COOLDOWN_MS') || '60000'
  ),
  line('MORPHEUS_RELAYER_LOG_FORMAT', get('MORPHEUS_RELAYER_LOG_FORMAT', 'LOG_FORMAT') || 'json'),
  line('MORPHEUS_RELAYER_LOG_LEVEL', get('MORPHEUS_RELAYER_LOG_LEVEL', 'LOG_LEVEL') || 'info'),
  line('MORPHEUS_RELAYER_NEO_N3_START_BLOCK', get('MORPHEUS_RELAYER_NEO_N3_START_BLOCK') || ''),
  line('ORACLE_TIMEOUT', get('ORACLE_TIMEOUT') || '8s'),
  line('ORACLE_MAX_PROVIDER_BODY_BYTES', get('ORACLE_MAX_PROVIDER_BODY_BYTES') || '65536'),
  line('ORACLE_SCRIPT_TIMEOUT_MS', get('ORACLE_SCRIPT_TIMEOUT_MS') || '2000'),
  line(
    'ORACLE_WASM_TIMEOUT_MS',
    get('ORACLE_WASM_TIMEOUT_MS') || get('MORPHEUS_WASM_TIMEOUT_MS') || '10000'
  ),
  line('COMPUTE_SCRIPT_TIMEOUT_MS', get('COMPUTE_SCRIPT_TIMEOUT_MS') || '2000'),
  line(
    'COMPUTE_WASM_TIMEOUT_MS',
    get('COMPUTE_WASM_TIMEOUT_MS') || get('MORPHEUS_WASM_TIMEOUT_MS') || '10000'
  ),
  line('MORPHEUS_WASM_TIMEOUT_MS', get('MORPHEUS_WASM_TIMEOUT_MS') || '10000'),
  line('MORPHEUS_ENABLE_UNTRUSTED_SCRIPTS', get('MORPHEUS_ENABLE_UNTRUSTED_SCRIPTS')),
  line('NITRO_USE_DERIVED_KEYS', resolveUseDerivedKeysDefault()),
  line('NITRO_EMIT_ATTESTATION', get('NITRO_EMIT_ATTESTATION') || 'true'),
  line('NITRO_NEO_N3_KEY_PATH', getInputOnly('NITRO_NEO_N3_KEY_PATH')),
  line('NITRO_RELAYER_NEO_N3_KEY_PATH', getInputOnly('NITRO_RELAYER_NEO_N3_KEY_PATH')),
  line('NITRO_UPDATER_NEO_N3_KEY_PATH', getInputOnly('NITRO_UPDATER_NEO_N3_KEY_PATH')),
  line(
    'NITRO_ORACLE_VERIFIER_NEO_N3_KEY_PATH',
    getInputOnly('NITRO_ORACLE_VERIFIER_NEO_N3_KEY_PATH')
  ),
  line(
    'NITRO_DSTACK_ORACLE_ENCRYPTION_KEY_PATH',
    getInputOnly('NITRO_DSTACK_ORACLE_ENCRYPTION_KEY_PATH')
  ),
  line('NITRO_ORACLE_KEYSTORE_PATH', resolveOracleKeystorePath(get)),
  line('MORPHEUS_PAYMASTER_TESTNET_ENABLED', get('MORPHEUS_PAYMASTER_TESTNET_ENABLED')),
  line('MORPHEUS_PAYMASTER_TESTNET_POLICY_ID', get('MORPHEUS_PAYMASTER_TESTNET_POLICY_ID')),
  line('MORPHEUS_PAYMASTER_TESTNET_MAX_GAS_UNITS', get('MORPHEUS_PAYMASTER_TESTNET_MAX_GAS_UNITS')),
  line(
    'MORPHEUS_PAYMASTER_TESTNET_ALLOW_TARGETS',
    runtimeConfig.MORPHEUS_PAYMASTER_TESTNET_ALLOW_TARGETS
  ),
  line(
    'MORPHEUS_PAYMASTER_TESTNET_ALLOW_METHODS',
    runtimeConfig.MORPHEUS_PAYMASTER_TESTNET_ALLOW_METHODS
  ),
  line(
    'MORPHEUS_PAYMASTER_TESTNET_ALLOW_ACCOUNTS',
    runtimeConfig.MORPHEUS_PAYMASTER_TESTNET_ALLOW_ACCOUNTS
  ),
  line(
    'MORPHEUS_PAYMASTER_TESTNET_BLOCK_ACCOUNTS',
    get('MORPHEUS_PAYMASTER_TESTNET_BLOCK_ACCOUNTS')
  ),
  line('MORPHEUS_PAYMASTER_TESTNET_ALLOW_DAPPS', get('MORPHEUS_PAYMASTER_TESTNET_ALLOW_DAPPS')),
  line('MORPHEUS_PAYMASTER_TESTNET_TTL_MS', get('MORPHEUS_PAYMASTER_TESTNET_TTL_MS')),
  line('MORPHEUS_PAYMASTER_MAINNET_ENABLED', get('MORPHEUS_PAYMASTER_MAINNET_ENABLED')),
  line('MORPHEUS_PAYMASTER_MAINNET_POLICY_ID', get('MORPHEUS_PAYMASTER_MAINNET_POLICY_ID')),
  line('MORPHEUS_PAYMASTER_MAINNET_MAX_GAS_UNITS', get('MORPHEUS_PAYMASTER_MAINNET_MAX_GAS_UNITS')),
  line('MORPHEUS_PAYMASTER_MAINNET_ALLOW_TARGETS', get('MORPHEUS_PAYMASTER_MAINNET_ALLOW_TARGETS')),
  line('MORPHEUS_PAYMASTER_MAINNET_ALLOW_METHODS', get('MORPHEUS_PAYMASTER_MAINNET_ALLOW_METHODS')),
  line(
    'MORPHEUS_PAYMASTER_MAINNET_ALLOW_ACCOUNTS',
    get('MORPHEUS_PAYMASTER_MAINNET_ALLOW_ACCOUNTS')
  ),
  line(
    'MORPHEUS_PAYMASTER_MAINNET_BLOCK_ACCOUNTS',
    get('MORPHEUS_PAYMASTER_MAINNET_BLOCK_ACCOUNTS')
  ),
  line('MORPHEUS_PAYMASTER_MAINNET_ALLOW_DAPPS', get('MORPHEUS_PAYMASTER_MAINNET_ALLOW_DAPPS')),
  line('MORPHEUS_PAYMASTER_MAINNET_TTL_MS', get('MORPHEUS_PAYMASTER_MAINNET_TTL_MS')),
  '',
];

await writeSecretFile(outputPath, `${lines.join('\n')}\n`);
console.log(`Wrote ${outputPath} for network=${network}`);
