import fs from 'node:fs/promises';
import path from 'node:path';
import { parseDotEnv } from './lib-env.mjs';
import { normalizeMorpheusNetwork, reportPinnedNeoN3Roles } from './lib-neo-signers.mjs';
import { trimString } from './lib-strings.mjs';

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
];

const args = parseArgs();
const envPath = resolveEnvPath({ networkOverride: args.network, envFileOverride: args.envFile });
const raw = await fs.readFile(envPath, 'utf8');
const env = parseDotEnv(raw);
const runtimeConfig = parseRuntimeConfig(env);
const network = normalizeMorpheusNetwork(
  getValue(env, runtimeConfig, 'MORPHEUS_NETWORK') || 'testnet'
);
const networkSuffix = network === 'mainnet' ? 'MAINNET' : 'TESTNET';
const requiredEither = [
  ['MORPHEUS_RUNTIME_TOKEN', 'NITRO_API_TOKEN', 'NITRO_SHARED_SECRET'],
  ['SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY'],
  [
    'MORPHEUS_WORKER_NEO_N3_WIF',
    'MORPHEUS_WORKER_NEO_N3_PRIVATE_KEY',
    `MORPHEUS_WORKER_NEO_N3_WIF_${networkSuffix}`,
    `MORPHEUS_WORKER_NEO_N3_PRIVATE_KEY_${networkSuffix}`,
  ],
  [
    'MORPHEUS_RELAYER_NEO_N3_WIF',
    'MORPHEUS_RELAYER_NEO_N3_PRIVATE_KEY',
    `MORPHEUS_RELAYER_NEO_N3_WIF_${networkSuffix}`,
    `MORPHEUS_RELAYER_NEO_N3_PRIVATE_KEY_${networkSuffix}`,
  ],
  [
    'MORPHEUS_UPDATER_NEO_N3_WIF',
    'MORPHEUS_UPDATER_NEO_N3_PRIVATE_KEY',
    `MORPHEUS_UPDATER_NEO_N3_WIF_${networkSuffix}`,
    `MORPHEUS_UPDATER_NEO_N3_PRIVATE_KEY_${networkSuffix}`,
  ],
];
const missing = required.filter((key) => !getValue(env, runtimeConfig, key));
const useDerivedKeys = isTrue(getValue(env, runtimeConfig, 'NITRO_USE_DERIVED_KEYS'));
const missingEither = requiredEither.filter((group) => {
  if (
    useDerivedKeys &&
    group.some(
      (key) =>
        key.startsWith('MORPHEUS_WORKER_NEO_N3_') ||
        key.startsWith('MORPHEUS_RELAYER_NEO_N3_') ||
        key.startsWith('MORPHEUS_UPDATER_NEO_N3_')
    )
  ) {
    return false;
  }
  return !group.some((key) => getValue(env, runtimeConfig, key));
});

const report = {
  env_path: envPath,
  mode: 'n3-only',
  missing_required: missing,
  missing_either_of: missingEither,
  optional_recommendations: {
    oracle_verifier: [],
  },
  ok: missing.length === 0 && missingEither.length === 0,
};

report.neo_n3_signers = ['worker', 'relayer', 'updater', 'oracle_verifier'].map((role) => {
  const entry = reportPinnedNeoN3Roles(network, [role], {
    env: { ...runtimeConfig, ...env },
    allowMissing: useDerivedKeys && role !== 'oracle_verifier',
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

const explicitOracleVerifierKeys = [
  'MORPHEUS_ORACLE_VERIFIER_PRIVATE_KEY',
  'MORPHEUS_ORACLE_VERIFIER_WIF',
  `MORPHEUS_ORACLE_VERIFIER_PRIVATE_KEY_${networkSuffix}`,
  `MORPHEUS_ORACLE_VERIFIER_WIF_${networkSuffix}`,
];

if (!explicitOracleVerifierKeys.some((key) => getValue(env, runtimeConfig, key))) {
  report.optional_recommendations.oracle_verifier.push(explicitOracleVerifierKeys.join(' | '));
}

report.ok = report.ok && report.neo_n3_signers.every((entry) => entry.ok);

console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;
