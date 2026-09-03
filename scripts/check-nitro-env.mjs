import fs from 'node:fs/promises';
import path from 'node:path';
import { parseDotEnv } from './lib-env.mjs';
import { normalizeMorpheusNetwork, reportPinnedNeoN3Roles } from './lib-neo-signers.mjs';
import { trimString } from './lib-strings.mjs';
import { findCredentialDomainCollisions } from './lib-credential-separation.mjs';

function parseArgs(argv = process.argv.slice(2)) {
  const out = {
    network: '',
    envFile: '',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--network') {
      out.network = trimString(argv[index + 1] || out.network);
      index += 1;
      continue;
    }
    if (arg.startsWith('--network=')) {
      out.network = trimString(arg.slice('--network='.length));
      continue;
    }
    if (arg === '--env-file') {
      out.envFile = trimString(argv[index + 1] || out.envFile);
      index += 1;
      continue;
    }
    if (arg.startsWith('--env-file=')) {
      out.envFile = trimString(arg.slice('--env-file='.length));
    }
  }

  return out;
}

function parseRuntimeConfig(env) {
  try {
    return JSON.parse(trimString(env.MORPHEUS_RUNTIME_CONFIG_JSON || '{}'));
  } catch {
    return {};
  }
}

function getValue(env, runtimeConfig, key) {
  return trimString(env[key]) || trimString(runtimeConfig[key]);
}

function isTrue(value) {
  const normalized = trimString(value).toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function resolveEnvPath({ networkOverride, envFileOverride } = {}) {
  const rawNetwork = trimString(networkOverride || process.env.MORPHEUS_NETWORK || 'mainnet');
  const network = normalizeMorpheusNetwork(rawNetwork || 'mainnet');
  const configuredPath = trimString(envFileOverride || process.env.NITRO_ENV_FILE || '');
  return configuredPath
    ? path.resolve(process.cwd(), configuredPath)
    : path.resolve(process.cwd(), `deploy/nitro/morpheus.${network}.env`);
}

const required = [
  'SUPABASE_URL',
  'MORPHEUS_NETWORK',
  'NEO_RPC_URL',
  'NEO_NETWORK_MAGIC',
  'CONTRACT_MORPHEUS_ORACLE_HASH',
  'CONTRACT_ORACLE_CALLBACK_CONSUMER_HASH',
  // All Neo N3 signing is custody-only since the custody migration: relayer,
  // worker sign lane, and worker tx-relay lane hold no signing key, so the
  // signer-service endpoint, its bearer token, and the per-role key ids must be
  // provisioned regardless of NITRO_USE_DERIVED_KEYS (which now only covers
  // derived-key lanes outside Neo N3 signing).
  'SIGNER_SERVICE_URL',
  'SIGNER_SERVICE_TOKEN',
  'SIGNER_ROLE_UPDATER_KEY_ID',
  'SIGNER_ROLE_ORACLE_VERIFIER_KEY_ID',
  'SIGNER_ROLE_WORKER_KEY_ID',
  'MORPHEUS_SIGNING_ADMIN_API_KEY',
  'MORPHEUS_RELAY_ADMIN_API_KEY',
];

const args = parseArgs();
const envPath = resolveEnvPath({ networkOverride: args.network, envFileOverride: args.envFile });
const raw = await fs.readFile(envPath, 'utf8');
const env = parseDotEnv(raw);
const runtimeConfig = parseRuntimeConfig(env);
const network = normalizeMorpheusNetwork(
  getValue(env, runtimeConfig, 'MORPHEUS_NETWORK') || 'testnet'
);
const requiredEither = [
  ['MORPHEUS_RUNTIME_TOKEN', 'NITRO_API_TOKEN', 'NITRO_SHARED_SECRET'],
  ['SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY'],
];
const missing = required.filter((key) => !getValue(env, runtimeConfig, key));
const useDerivedKeys = isTrue(getValue(env, runtimeConfig, 'NITRO_USE_DERIVED_KEYS'));
const missingEither = requiredEither.filter(
  (group) => !group.some((key) => getValue(env, runtimeConfig, key))
);
const credentialDomainCollisions = findCredentialDomainCollisions({
  ...runtimeConfig,
  ...env,
});

// The runtime reader (packages/shared neo-signers-core buildRoleReport) nulls the
// pinned registry when this variable is truthy, skipping every drift check — a
// runtime env file that carries it true turns pinning off for the deployment.
// Bootstrap files under .secrets/ legitimately set it; they are never runtime env.
const forbiddenSettings = [];
if (isTrue(getValue(env, runtimeConfig, 'MORPHEUS_ALLOW_UNPINNED_SIGNERS'))) {
  forbiddenSettings.push({
    key: 'MORPHEUS_ALLOW_UNPINNED_SIGNERS',
    reason:
      'a runtime env file must not disable signer pinning; only bootstrap files under .secrets/ may set this true',
  });
}
if (isTrue(getValue(env, runtimeConfig, 'MORPHEUS_ALLOW_CALLER_SIGNING_KEY'))) {
  forbiddenSettings.push({
    key: 'MORPHEUS_ALLOW_CALLER_SIGNING_KEY',
    reason:
      'production runtime env must not enable caller-supplied local signing; use the custody signer boundary',
  });
}
for (const key of Object.keys({ ...runtimeConfig, ...env }).sort()) {
  const normalized = key.toUpperCase();
  const hostKeyName =
    /(?:^|_)WIF(?:_|$)/.test(normalized) ||
    (/(?:^|_)(?:PRIVATE_KEY|PK)(?:_|$)/.test(normalized) &&
      /(NEO|NEOX|EVM|MORPHEUS|SIGNER)/.test(normalized));
  if (!hostKeyName || !getValue(env, runtimeConfig, key)) continue;
  forbiddenSettings.push({
    key,
    reason:
      'runtime/relayer env must not contain a WIF or private key; provision a custody key id and caller credential instead',
  });
}

const report = {
  env_path: envPath,
  mode: 'n3-only',
  missing_required: missing,
  missing_either_of: missingEither,
  forbidden_settings: forbiddenSettings,
  credential_domain_collisions: credentialDomainCollisions,
  optional_recommendations: {
    oracle_verifier: [],
  },
  ok:
    missing.length === 0 &&
    missingEither.length === 0 &&
    forbiddenSettings.length === 0 &&
    credentialDomainCollisions.length === 0,
};

// Every Neo N3 signing role (updater, oracle_verifier, worker) is custody-side.
// A WIF-free env file is the only healthy state. The pin report remains useful
// for public identity diagnostics, while forbidden_settings rejects any
// leftover private material even when it happens to match the registry.
report.neo_n3_signers = ['updater', 'oracle_verifier'].map((role) => {
  const entry = reportPinnedNeoN3Roles(network, [role], {
    env: { ...runtimeConfig, ...env },
    allowMissing: true,
  })[0];
  return {
    network: entry.network,
    role: entry.role,
    pinned: entry.pinned,
    selected_source: entry.selected_source,
    selected_identity: entry.selected_identity,
    public_key: entry.public_key,
    derived_key_mode: useDerivedKeys && role !== 'oracle_verifier',
    issues: entry.issues,
    ok: entry.ok,
  };
});

report.ok = report.ok && report.neo_n3_signers.every((entry) => entry.ok);

console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;
