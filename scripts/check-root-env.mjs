import path from 'node:path';
import { readMergedDotEnvFiles } from './lib-env.mjs';
import { reportPinnedNeoN3Roles, normalizeMorpheusNetwork } from './lib-neo-signers.mjs';
import {
  ROOT_ENV_REQUIRED_GROUPS,
  ROOT_ENV_OPTIONAL_GROUPS,
  evaluateRootEnvRequirements,
  getGroupValue,
} from './lib-root-env-requirements.mjs';

const envPaths = [path.resolve(process.cwd(), '.env'), path.resolve(process.cwd(), '.env.local')];

const env = await readMergedDotEnvFiles(envPaths);

const report = {
  env_path: envPaths[0],
  env_paths: envPaths,
  missing: {},
  optional_recommendations: {},
  mode: {
    active_scope: 'neo_n3-only',
    neo_n3_enabled: Boolean(
      getGroupValue(env, [
        'CONTRACT_MORPHEUS_ORACLE_HASH',
        'CONTRACT_ORACLE_CALLBACK_CONSUMER_HASH',
      ])
    ),
  },
};

const signerNetwork = normalizeMorpheusNetwork(env.MORPHEUS_NETWORK || 'testnet');
report.neo_n3_signers = reportPinnedNeoN3Roles(
  signerNetwork,
  ['worker', 'relayer', 'updater', 'oracle_verifier'],
  { env, allowMissing: true }
).map((entry) => ({
  network: entry.network,
  role: entry.role,
  pinned: entry.pinned,
  selected_source: entry.selected_source,
  selected_identity: entry.selected_identity,
  public_key: entry.public_key,
  issues: entry.issues,
  ok: entry.ok,
}));

report.missing = evaluateRootEnvRequirements(env, ROOT_ENV_REQUIRED_GROUPS);
report.optional_recommendations = evaluateRootEnvRequirements(env, ROOT_ENV_OPTIONAL_GROUPS);

report.ok =
  Object.values(report.missing).every((items) => items.length === 0) &&
  report.neo_n3_signers.every((entry) => entry.ok);

console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;
