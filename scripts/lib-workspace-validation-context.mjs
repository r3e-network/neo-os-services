import { trimString } from './lib-strings.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { wallet } from '@cityofzion/neon-js';
import { parseDotEnv } from './lib-env.mjs';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const defaultOracleRoot = path.resolve(moduleDir, '..');

function parseDotEnvFile(filePath) {
  try {
    return parseDotEnv(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
}

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function normalizeNetwork(network) {
  return trimString(network) === 'mainnet' ? 'mainnet' : 'testnet';
}

function resolveRuntimeUrl({ network, morpheusEnv, morpheusLocalEnv }) {
  if (network === 'mainnet') {
    if (trimString(morpheusEnv.MORPHEUS_MAINNET_RUNTIME_URL)) {
      return trimString(morpheusEnv.MORPHEUS_MAINNET_RUNTIME_URL);
    }
  } else if (trimString(morpheusEnv.MORPHEUS_TESTNET_RUNTIME_URL)) {
    return trimString(morpheusEnv.MORPHEUS_TESTNET_RUNTIME_URL);
  }

  if (trimString(morpheusEnv.MORPHEUS_RUNTIME_URL)) {
    return trimString(morpheusEnv.MORPHEUS_RUNTIME_URL);
  }

  const customDomainKey =
    network === 'mainnet' ? 'MORPHEUS_MAINNET_CUSTOM_DOMAIN' : 'MORPHEUS_TESTNET_CUSTOM_DOMAIN';
  const customDomain = trimString(morpheusLocalEnv[customDomainKey]);
  if (customDomain) {
    return /^https?:\/\//i.test(customDomain) ? customDomain : `https://${customDomain}`;
  }

  return '';
}

function resolveRuntimeToken(morpheusEnv) {
  return trimString(morpheusEnv.MORPHEUS_RUNTIME_TOKEN);
}

function derivePrivateKeyFromWif(wif) {
  const normalized = trimString(wif);
  if (!normalized) return '';
  try {
    const account = new wallet.Account(normalized);
    return account.privateKey || '';
  } catch {
    return '';
  }
}

function resolveActorWif(key, miniappsEnv) {
  return trimString(miniappsEnv[key] || '');
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const normalized = trimString(value);
    if (normalized) return normalized;
  }
  return '';
}

function deriveWifFromPrivateKey(privateKey) {
  const normalized = trimString(privateKey);
  if (!normalized) return '';
  try {
    const account = new wallet.Account(normalized);
    return account.WIF || '';
  } catch {
    return '';
  }
}

function isEnvKeyToken(value) {
  return /^[A-Z0-9_]+$/.test(value);
}

function resolveCandidateValue(morpheusEnv, candidate) {
  const normalized = trimString(candidate);
  if (!normalized) return '';
  if (Object.prototype.hasOwnProperty.call(morpheusEnv, normalized)) {
    return trimString(morpheusEnv[normalized]);
  }
  return isEnvKeyToken(normalized) ? '' : normalized;
}

function resolveNetworkSignerMaterial({ morpheusEnv, wifKeys, privateKeyKeys }) {
  const privateKey = firstNonEmpty(
    ...privateKeyKeys.map((candidate) => resolveCandidateValue(morpheusEnv, candidate))
  );
  const wif = firstNonEmpty(
    ...wifKeys.map((candidate) => resolveCandidateValue(morpheusEnv, candidate)),
    deriveWifFromPrivateKey(privateKey)
  );
  return {
    wif,
    private_key: firstNonEmpty(privateKey, derivePrivateKeyFromWif(wif)),
  };
}

function resolveCanonicalRepoRoot(repoRoot) {
  const normalizedRepoRoot = path.resolve(repoRoot);
  const worktreeMarker = path.sep + '.worktrees' + path.sep;
  if (!normalizedRepoRoot.includes(worktreeMarker)) {
    return {
      repoRoot: normalizedRepoRoot,
      canonicalRoot: normalizedRepoRoot,
      worktreeName: '',
    };
  }

  const [canonicalRoot, worktreeName = ''] = normalizedRepoRoot.split(worktreeMarker);
  return {
    repoRoot: normalizedRepoRoot,
    canonicalRoot,
    worktreeName,
  };
}

function resolveSiblingRepoRoot({ workspaceRoot, repoName, worktreeName }) {
  const canonicalRoot = path.resolve(workspaceRoot, repoName);
  if (worktreeName) {
    const worktreeRoot = path.join(canonicalRoot, '.worktrees', worktreeName);
    if (fs.existsSync(worktreeRoot)) {
      return {
        root: worktreeRoot,
        canonicalRoot,
      };
    }
  }

  return {
    root: canonicalRoot,
    canonicalRoot,
  };
}

function resolveDefaultEnvFile(repoRoot, canonicalRoot, filename) {
  const repoCandidate = path.join(repoRoot, filename);
  if (fs.existsSync(repoCandidate)) {
    return repoCandidate;
  }
  return path.join(canonicalRoot, filename);
}

function resolveWorkspaceRoots(oracleRoot) {
  const oracleRepo = resolveCanonicalRepoRoot(oracleRoot);
  const workspaceRoot = path.resolve(oracleRepo.canonicalRoot, '..');
  const platformRepo = resolveSiblingRepoRoot({
    workspaceRoot,
    repoName: 'neo-os-web',
    worktreeName: oracleRepo.worktreeName,
  });
  const aaRepo = resolveSiblingRepoRoot({
    workspaceRoot,
    repoName: 'neo-abstract-account',
    worktreeName: oracleRepo.worktreeName,
  });
  return {
    oracleRoot: oracleRepo.repoRoot,
    oracleCanonicalRoot: oracleRepo.canonicalRoot,
    worktreeName: oracleRepo.worktreeName,
    workspaceRoot,
    platformRoot: platformRepo.root,
    platformCanonicalRoot: platformRepo.canonicalRoot,
    aaRoot: aaRepo.root,
    aaCanonicalRoot: aaRepo.canonicalRoot,
  };
}

function compactSecretEnv(secretEnv) {
  return Object.fromEntries(Object.entries(secretEnv).filter(([, value]) => trimString(value)));
}

export function buildWorkspaceValidationData({
  network = 'testnet',
  oracleRoot = defaultOracleRoot,
  servicesRoot,
  platformEnvFile,
  miniappsEnvFile,
  morpheusEnvFile,
  morpheusEnvLocalFile,
} = {}) {
  const normalizedNetwork = normalizeNetwork(network);
  const roots = resolveWorkspaceRoots(servicesRoot || oracleRoot);
  const resolvedPlatformEnvFile =
    platformEnvFile ||
    miniappsEnvFile ||
    process.env.PLATFORM_ENV_FILE ||
    process.env.MINIAPP_ENV_FILE ||
    resolveDefaultEnvFile(roots.platformRoot, roots.platformCanonicalRoot, '.env');
  const resolvedMorpheusEnvFile =
    morpheusEnvFile ||
    process.env.MORPHEUS_ENV_FILE ||
    resolveDefaultEnvFile(roots.oracleRoot, roots.oracleCanonicalRoot, '.env');
  const resolvedMorpheusEnvLocalFile =
    morpheusEnvLocalFile ||
    process.env.MORPHEUS_ENV_LOCAL_FILE ||
    resolveDefaultEnvFile(roots.oracleRoot, roots.oracleCanonicalRoot, '.env.local');

  const platformEnv = parseDotEnvFile(resolvedPlatformEnvFile);
  const morpheusEnv = parseDotEnvFile(resolvedMorpheusEnvFile);
  const morpheusLocalEnv = parseDotEnvFile(resolvedMorpheusEnvLocalFile);
  const networkRegistry = loadJson(
    path.join(roots.oracleRoot, 'config', 'networks', `${normalizedNetwork}.json`)
  );

  const neoTestnetWif = resolveActorWif('NEO_TESTNET_WIF', platformEnv);
  const flagshipLiveWif = resolveActorWif('FLAGSHIP_LIVE_WIF', platformEnv);
  const aaTestWif = resolveActorWif('AA_TEST_WIF', platformEnv) || neoTestnetWif;
  const oracleTestWif =
    resolveActorWif('ORACLE_TEST_WIF', platformEnv) ||
    aaTestWif ||
    flagshipLiveWif ||
    neoTestnetWif;
  const runtimeRelayer = resolveNetworkSignerMaterial({
    morpheusEnv,
    wifKeys:
      normalizedNetwork === 'mainnet'
        ? ['MORPHEUS_RELAYER_NEO_N3_WIF_MAINNET', 'MORPHEUS_RELAYER_NEO_N3_WIF']
        : ['MORPHEUS_RELAYER_NEO_N3_WIF_TESTNET', 'MORPHEUS_RELAYER_NEO_N3_WIF'],
    privateKeyKeys:
      normalizedNetwork === 'mainnet'
        ? ['MORPHEUS_RELAYER_NEO_N3_PRIVATE_KEY_MAINNET', 'MORPHEUS_RELAYER_NEO_N3_PRIVATE_KEY']
        : ['MORPHEUS_RELAYER_NEO_N3_PRIVATE_KEY_TESTNET', 'MORPHEUS_RELAYER_NEO_N3_PRIVATE_KEY'],
  });
  const runtimeUpdater = resolveNetworkSignerMaterial({
    morpheusEnv,
    wifKeys:
      normalizedNetwork === 'mainnet'
        ? [
            'MORPHEUS_UPDATER_NEO_N3_WIF_MAINNET',
            'MORPHEUS_UPDATER_NEO_N3_WIF',
            'MORPHEUS_RELAYER_NEO_N3_WIF_MAINNET',
            'MORPHEUS_RELAYER_NEO_N3_WIF',
          ]
        : [
            'MORPHEUS_UPDATER_NEO_N3_WIF_TESTNET',
            'MORPHEUS_UPDATER_NEO_N3_WIF',
            'MORPHEUS_RELAYER_NEO_N3_WIF_TESTNET',
            'MORPHEUS_RELAYER_NEO_N3_WIF',
          ],
    privateKeyKeys:
      normalizedNetwork === 'mainnet'
        ? [
            'MORPHEUS_UPDATER_NEO_N3_PRIVATE_KEY_MAINNET',
            'MORPHEUS_UPDATER_NEO_N3_PRIVATE_KEY',
            'MORPHEUS_RELAYER_NEO_N3_PRIVATE_KEY_MAINNET',
            'MORPHEUS_RELAYER_NEO_N3_PRIVATE_KEY',
          ]
        : [
            'MORPHEUS_UPDATER_NEO_N3_PRIVATE_KEY_TESTNET',
            'MORPHEUS_UPDATER_NEO_N3_PRIVATE_KEY',
            'MORPHEUS_RELAYER_NEO_N3_PRIVATE_KEY_TESTNET',
            'MORPHEUS_RELAYER_NEO_N3_PRIVATE_KEY',
          ],
  });
  const runtimeOracleVerifier = resolveNetworkSignerMaterial({
    morpheusEnv,
    wifKeys:
      normalizedNetwork === 'mainnet'
        ? [
            'MORPHEUS_ORACLE_VERIFIER_WIF_MAINNET',
            'MORPHEUS_ORACLE_VERIFIER_WIF',
            runtimeUpdater.wif,
          ]
        : [
            'MORPHEUS_ORACLE_VERIFIER_WIF_TESTNET',
            'MORPHEUS_ORACLE_VERIFIER_WIF',
            runtimeUpdater.wif,
          ],
    privateKeyKeys:
      normalizedNetwork === 'mainnet'
        ? [
            'MORPHEUS_ORACLE_VERIFIER_PRIVATE_KEY_MAINNET',
            'MORPHEUS_ORACLE_VERIFIER_PRIVATE_KEY',
            runtimeUpdater.private_key,
          ]
        : [
            'MORPHEUS_ORACLE_VERIFIER_PRIVATE_KEY_TESTNET',
            'MORPHEUS_ORACLE_VERIFIER_PRIVATE_KEY',
            runtimeUpdater.private_key,
          ],
  });

  const paymasterAppId =
    trimString(process.env.MORPHEUS_PAYMASTER_APP_ID) ||
    trimString(networkRegistry?.nitro?.cvm_id) ||
    'ddff154546fe22d15b65667156dd4b7c611e6093';

  const publicContext = {
    network: normalizedNetwork,
    roots: {
      services: roots.oracleRoot,
      oracle: roots.oracleRoot,
      aa: roots.aaRoot,
      platform: roots.platformRoot,
      miniapps: roots.platformRoot,
    },
    files: {
      platform_env: resolvedPlatformEnvFile,
      miniapps_env: resolvedPlatformEnvFile,
      morpheus_env: resolvedMorpheusEnvFile,
      morpheus_env_local: resolvedMorpheusEnvLocalFile,
    },
    morpheus: {
      runtime_url: resolveRuntimeUrl({
        network: normalizedNetwork,
        morpheusEnv,
        morpheusLocalEnv,
      }),
      control_plane_url:
        trimString(networkRegistry?.nitro?.control_plane_url) || 'https://control.meshmini.app',
      oracle_hash: trimString(networkRegistry?.neo_n3?.contracts?.morpheus_oracle || ''),
      callback_hash:
        trimString(networkRegistry?.neo_n3?.examples?.oracle_callback_consumer || '') ||
        trimString(networkRegistry?.neo_n3?.contracts?.oracle_callback_consumer || ''),
    },
    aa: {
      core_hash_testnet: trimString(networkRegistry?.neo_n3?.contracts?.abstract_account || ''),
      paymaster_app_id: paymasterAppId,
      paymaster_account_id:
        trimString(process.env.PAYMASTER_ACCOUNT_ID) ||
        '0x0c3146e78efc42bfb7d4cc2e06e3efd063c01c56',
    },
  };

  const secretEnv = compactSecretEnv({
    TEST_WIF: aaTestWif,
    TEST_PRIVATE_KEY: derivePrivateKeyFromWif(aaTestWif),
    NEO_TESTNET_WIF: neoTestnetWif,
    NEO_TESTNET_PRIVATE_KEY: derivePrivateKeyFromWif(neoTestnetWif),
    FLAGSHIP_LIVE_WIF: flagshipLiveWif,
    AA_TEST_WIF: aaTestWif,
    ORACLE_TEST_WIF: oracleTestWif,
    ORACLE_TEST_PRIVATE_KEY: derivePrivateKeyFromWif(oracleTestWif),
    ORACLE_RUNTIME_RELAYER_WIF: runtimeRelayer.wif,
    ORACLE_RUNTIME_RELAYER_PRIVATE_KEY: runtimeRelayer.private_key,
    ORACLE_RUNTIME_UPDATER_WIF: runtimeUpdater.wif,
    ORACLE_RUNTIME_UPDATER_PRIVATE_KEY: runtimeUpdater.private_key,
    ORACLE_RUNTIME_VERIFIER_WIF: runtimeOracleVerifier.wif,
    ORACLE_RUNTIME_VERIFIER_PRIVATE_KEY: runtimeOracleVerifier.private_key,
    MORPHEUS_RUNTIME_TOKEN: resolveRuntimeToken(morpheusEnv),
  });

  return {
    publicContext,
    secretEnv,
  };
}

export function writeWorkspaceValidationSecretsEnvFile(secretEnv, outputFile = '') {
  const normalizedOutputFile = trimString(outputFile);
  const targetFile = normalizedOutputFile
    ? path.resolve(normalizedOutputFile)
    : path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), 'morpheus-workspace-secrets-')),
        'workspace-validation-secrets.env'
      );

  fs.mkdirSync(path.dirname(targetFile), { recursive: true });
  const lines = Object.entries(secretEnv).map(([key, value]) => `${key}=${String(value)}`);
  fs.writeFileSync(targetFile, lines.join('\n') + '\n', { mode: 0o600 });
  fs.chmodSync(targetFile, 0o600);
  return targetFile;
}
