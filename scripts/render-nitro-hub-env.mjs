import { trimString } from './lib-strings.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseDotEnv } from './lib-env.mjs';
import { NEO_N3_SIGNER_PUBLIC_ENV_KEYS } from './lib-neo-signers.mjs';

const repoRoot = process.cwd();

function stableStringify(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`)
    .join(',')}}`;
}

function parseArgs(argv = process.argv.slice(2)) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (current === '--output') {
      parsed.output = argv[index + 1] || '';
      index += 1;
    }
  }
  return parsed;
}

async function readEnvFile(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  return parseDotEnv(raw);
}

async function readOptionalEnvFile(filePath) {
  try {
    return await readEnvFile(filePath);
  } catch {
    return {};
  }
}

function line(key, value) {
  return `${key}=${value ?? ''}`;
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

function pick(envs, ...keys) {
  for (const env of envs) {
    for (const key of keys) {
      const value = trimString(env?.[key]);
      if (value) return value;
    }
  }
  return '';
}

function parseRuntimeConfig(env) {
  const raw = trimString(env?.MORPHEUS_RUNTIME_CONFIG_JSON || '');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function resolveRuntimeValue(key, fileEnv, runtimeConfig) {
  const direct = trimString(fileEnv?.[key]);
  if (direct) return direct;
  const packed = runtimeConfig?.[key];
  if (packed === undefined || packed === null) return '';
  return String(packed).trim();
}

function buildSharedRuntimeConfig(mainnetRuntimeConfig, testnetRuntimeConfig) {
  const shared = {};
  const keys = new Set([
    ...Object.keys(mainnetRuntimeConfig || {}),
    ...Object.keys(testnetRuntimeConfig || {}),
  ]);
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(mainnetRuntimeConfig, key)) continue;
    if (!Object.prototype.hasOwnProperty.call(testnetRuntimeConfig, key)) continue;
    if (stableStringify(mainnetRuntimeConfig[key]) !== stableStringify(testnetRuntimeConfig[key])) {
      continue;
    }
    shared[key] = mainnetRuntimeConfig[key];
  }
  return shared;
}

function resolveSharedHubSignerValue(
  key,
  overrideEnvs,
  mainnetEnv,
  testnetEnv,
  mainnetRuntimeConfig,
  testnetRuntimeConfig
) {
  if (key.endsWith('_MAINNET')) {
    const baseKey = key.slice(0, -8);
    return (
      resolveRuntimeValue(key, mainnetEnv, mainnetRuntimeConfig) ||
      resolveRuntimeValue(baseKey, mainnetEnv, mainnetRuntimeConfig) ||
      pick(overrideEnvs, key)
    );
  }
  if (key.endsWith('_TESTNET')) {
    const baseKey = key.slice(0, -8);
    return (
      resolveRuntimeValue(key, testnetEnv, testnetRuntimeConfig) ||
      resolveRuntimeValue(baseKey, testnetEnv, testnetRuntimeConfig) ||
      pick(overrideEnvs, key)
    );
  }
  return pick(overrideEnvs, key) || resolveRuntimeValue(key, mainnetEnv, mainnetRuntimeConfig);
}

const args = parseArgs();
const outputPath = path.resolve(
  repoRoot,
  trimString(args.output) || 'deploy/nitro/morpheus.hub.env'
);

const rootEnv = await readOptionalEnvFile(path.resolve(repoRoot, '.env'));
const localEnv = await readOptionalEnvFile(path.resolve(repoRoot, '.env.local'));
const mainnetEnv = await readEnvFile(path.resolve(repoRoot, 'deploy/nitro/morpheus.mainnet.env'));
const testnetEnv = await readEnvFile(path.resolve(repoRoot, 'deploy/nitro/morpheus.testnet.env'));
const envs = [process.env, localEnv, rootEnv, mainnetEnv, testnetEnv];
const secureOverrideEnvs = [process.env, localEnv, rootEnv];
const mainnetRuntimeConfig = parseRuntimeConfig(mainnetEnv);
const testnetRuntimeConfig = parseRuntimeConfig(testnetEnv);
const sharedRuntimeConfig = buildSharedRuntimeConfig(mainnetRuntimeConfig, testnetRuntimeConfig);

const requestHubDomain =
  pick(envs, 'MORPHEUS_REQUEST_HUB_CUSTOM_DOMAIN', 'MORPHEUS_SHARED_CUSTOM_DOMAIN') ||
  'morpheus-hub.meshmini.app';

const lines = [
  '# Generated from deploy/nitro/morpheus.mainnet.env and morpheus.testnet.env; do not edit.',
  line(
    'MORPHEUS_COMPAT_NITRO_WORKER_IMAGE',
    pick(envs, 'MORPHEUS_COMPAT_NITRO_WORKER_IMAGE', 'MORPHEUS_NITRO_WORKER_IMAGE')
  ),
  line(
    'MORPHEUS_COMPAT_RELAYER_IMAGE',
    pick(envs, 'MORPHEUS_COMPAT_RELAYER_IMAGE', 'MORPHEUS_RELAYER_IMAGE')
  ),
  '',
  line('MORPHEUS_PUBLIC_PORT', pick(envs, 'MORPHEUS_PUBLIC_PORT') || '3000'),
  line('MORPHEUS_RUNTIME_TOKEN', pick(envs, 'MORPHEUS_RUNTIME_TOKEN', 'NITRO_API_TOKEN')),
  line('NITRO_API_TOKEN', pick(envs, 'NITRO_API_TOKEN', 'MORPHEUS_RUNTIME_TOKEN')),
  line('SUPABASE_URL', pick(envs, 'SUPABASE_URL')),
  line('SUPABASE_SECRET_KEY', pick(envs, 'SUPABASE_SECRET_KEY')),
  line('SUPABASE_SERVICE_ROLE_KEY', pick(envs, 'SUPABASE_SERVICE_ROLE_KEY')),
  line('NEXT_PUBLIC_SUPABASE_URL', pick(envs, 'NEXT_PUBLIC_SUPABASE_URL')),
  line('NEXT_PUBLIC_SUPABASE_ANON_KEY', pick(envs, 'NEXT_PUBLIC_SUPABASE_ANON_KEY')),
  line('TWELVEDATA_API_KEY', pick(envs, 'TWELVEDATA_API_KEY')),
  line('MORPHEUS_ENABLE_UNTRUSTED_SCRIPTS', pick(envs, 'MORPHEUS_ENABLE_UNTRUSTED_SCRIPTS')),
  '',
  line('UPSTASH_REDIS_REST_URL', pick(envs, 'UPSTASH_REDIS_REST_URL')),
  line('UPSTASH_REDIS_REST_TOKEN', pick(envs, 'UPSTASH_REDIS_REST_TOKEN')),
  line('MORPHEUS_UPSTASH_GUARDS_ENABLED', pick(envs, 'MORPHEUS_UPSTASH_GUARDS_ENABLED') || 'true'),
  line('MORPHEUS_UPSTASH_FAIL_CLOSED', pick(envs, 'MORPHEUS_UPSTASH_FAIL_CLOSED') || 'false'),
  line('MORPHEUS_FEED_PAIR_REGISTRY_JSON', pick(envs, 'MORPHEUS_FEED_PAIR_REGISTRY_JSON')),
  line('MORPHEUS_HEARTBEAT_TIMEOUT_MS', pick(envs, 'MORPHEUS_HEARTBEAT_TIMEOUT_MS') || '3000'),
  line(
    'MORPHEUS_BETTERSTACK_RELAYER_HEARTBEAT_URL',
    pick(envs, 'MORPHEUS_BETTERSTACK_RELAYER_HEARTBEAT_URL')
  ),
  line(
    'MORPHEUS_BETTERSTACK_RELAYER_FEED_HEARTBEAT_URL',
    pick(envs, 'MORPHEUS_BETTERSTACK_RELAYER_FEED_HEARTBEAT_URL')
  ),
  line(
    'MORPHEUS_BETTERSTACK_RELAYER_FAILURE_URL',
    pick(envs, 'MORPHEUS_BETTERSTACK_RELAYER_FAILURE_URL')
  ),
  '',
  line('CLOUDFLARE_DNS_API_TOKEN', pick(envs, 'CLOUDFLARE_DNS_API_TOKEN')),
  line('CERTBOT_EMAIL', pick(envs, 'CERTBOT_EMAIL')),
  line('MORPHEUS_CUSTOM_DOMAIN', requestHubDomain),
  line('MORPHEUS_INGRESS_PORT', pick(envs, 'MORPHEUS_INGRESS_PORT') || '443'),
  line('MORPHEUS_INGRESS_SET_CAA', pick(envs, 'MORPHEUS_INGRESS_SET_CAA') || 'false'),
  '',
  line('MAINNET_RUNTIME_CONFIG_JSON', trimString(mainnetEnv.MORPHEUS_RUNTIME_CONFIG_JSON)),
  line('TESTNET_RUNTIME_CONFIG_JSON', trimString(testnetEnv.MORPHEUS_RUNTIME_CONFIG_JSON)),
  line('SHARED_RUNTIME_CONFIG_JSON', JSON.stringify(sharedRuntimeConfig)),
  '',
  // Custody migration: the hub env carries only the oracle verifier PUBLIC key
  // (used by compose to verify on-chain results). Signing key material never
  // lands in the hub env; relayer/worker signing resolves through the custody
  // signer service (docs/SIGNER_SERVICE.md §5) whose URL/token/role ids are
  // interpolated from the deployment shell env.
  ...NEO_N3_SIGNER_PUBLIC_ENV_KEYS.map((key) =>
    line(
      key,
      resolveSharedHubSignerValue(
        key,
        secureOverrideEnvs,
        mainnetEnv,
        testnetEnv,
        mainnetRuntimeConfig,
        testnetRuntimeConfig
      )
    )
  ),
  '',
];

await fs.mkdir(path.dirname(outputPath), { recursive: true });
const rendered = `${lines.join('\n')}\n`;
await writeSecretFile(outputPath, rendered);

function hasRenderedValue(renderedEnv, key) {
  const linePrefix = `${key}=`;
  const line = renderedEnv.split(/\r?\n/).find((entry) => entry.startsWith(linePrefix));
  return Boolean(line && trimString(line.slice(linePrefix.length)));
}

const requiredKeys = [
  'MORPHEUS_RUNTIME_TOKEN',
  'SUPABASE_URL',
  'SUPABASE_SECRET_KEY',
  'MAINNET_RUNTIME_CONFIG_JSON',
  'TESTNET_RUNTIME_CONFIG_JSON',
  'SHARED_RUNTIME_CONFIG_JSON',
];
for (const key of requiredKeys) {
  if (!hasRenderedValue(rendered, key)) {
    console.error(`WARN: ${key} appears empty in rendered env`);
    process.exitCode = 1;
  }
}

console.log(JSON.stringify({ output: path.relative(repoRoot, outputPath) }, null, 2));
