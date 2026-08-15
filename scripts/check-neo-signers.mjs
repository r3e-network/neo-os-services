import fs from 'node:fs/promises';
import path from 'node:path';
import { readMergedDotEnvFiles } from './lib-env.mjs';
import { normalizeMorpheusNetwork, reportPinnedNeoN3Roles } from './lib-neo-signers.mjs';
import { trimString } from './lib-strings.mjs';

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function parseRuntimeConfig(env) {
  try {
    return JSON.parse(trimString(env.MORPHEUS_RUNTIME_CONFIG_JSON || '{}'));
  } catch {
    return {};
  }
}

function isTrue(value) {
  const normalized = trimString(value).toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

async function buildReport(label, filePaths, { allowMissing = false, network = '' } = {}) {
  const envPaths = Array.isArray(filePaths) ? filePaths : [filePaths];
  const exists = (await Promise.all(envPaths.map((filePath) => pathExists(filePath)))).some(
    Boolean
  );
  if (!exists) {
    return {
      label,
      env_path: envPaths[0],
      env_paths: envPaths,
      exists: false,
      ok: allowMissing,
      signers: [],
    };
  }

  const env = await readMergedDotEnvFiles(envPaths);
  const runtimeConfig = parseRuntimeConfig(env);
  const resolvedNetwork = normalizeMorpheusNetwork(
    network || env.MORPHEUS_NETWORK || runtimeConfig.MORPHEUS_NETWORK || 'testnet'
  );
  const signerEnv = { ...runtimeConfig, ...env };
  const useDerivedKeys = isTrue(signerEnv.NITRO_USE_DERIVED_KEYS);
  const signers = ['worker', 'relayer', 'updater', 'oracle_verifier'].map((role) => {
    const entry = reportPinnedNeoN3Roles(resolvedNetwork, [role], {
      env: signerEnv,
      allowMissing: allowMissing || (useDerivedKeys && role !== 'oracle_verifier'),
    })[0];
    return {
      role: entry.role,
      network: entry.network,
      selected_source: entry.selected_source,
      selected_identity: entry.selected_identity,
      public_key: entry.public_key,
      pinned: entry.pinned,
      derived_key_mode: useDerivedKeys && role !== 'oracle_verifier',
      issues: entry.issues,
      ok: entry.ok,
    };
  });
  return {
    label,
    env_path: envPaths[0],
    env_paths: envPaths,
    exists: true,
    ok: signers.every((entry) => entry.ok),
    signers,
  };
}

const repoRoot = process.cwd();
const reports = await Promise.all([
  buildReport('root_env', [path.resolve(repoRoot, '.env'), path.resolve(repoRoot, '.env.local')], {
    allowMissing: true,
  }),
  buildReport('testnet_nitro_env', path.resolve(repoRoot, 'deploy/nitro/morpheus.testnet.env'), {
    allowMissing: false,
    network: 'testnet',
  }),
  buildReport('mainnet_nitro_env', path.resolve(repoRoot, 'deploy/nitro/morpheus.mainnet.env'), {
    allowMissing: false,
    network: 'mainnet',
  }),
]);

const output = {
  ok: reports.every((entry) => entry.ok),
  reports,
};

console.log(JSON.stringify(output, null, 2));
if (!output.ok) process.exitCode = 1;
