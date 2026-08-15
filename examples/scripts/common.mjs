import fs from 'node:fs/promises';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { rpc as neoRpc, wallet } from '@cityofzion/neon-js';
import { loadDotEnv } from '../../scripts/lib-env.mjs';
import {
  normalizeMorpheusNetwork,
  resolvePinnedNeoN3RolePreferMatch,
} from '../../scripts/lib-neo-signers.mjs';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const deploymentsDir = path.resolve(repoRoot, 'examples/deployments');
export const docsDir = path.resolve(repoRoot, 'docs');
const relayerStateFile = path.resolve(
  process.env.TMPDIR || '/tmp',
  `morpheus-relayer-examples-${process.pid}.json`
);

export function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function logValidationStep(phase, details = {}) {
  const payload = {
    phase,
    ...details,
  };
  console.log(JSON.stringify(payload, null, 2));
}

let phalaCliInvocationCache = null;

export function resolvePhalaCliInvocation() {
  if (phalaCliInvocationCache) return phalaCliInvocationCache;
  const explicit = trimString(process.env.PHALA_CLI || '');
  if (explicit) {
    phalaCliInvocationCache = { command: explicit, argsPrefix: [] };
    return phalaCliInvocationCache;
  }

  const direct = spawnSync('bash', ['-lc', 'command -v phala >/dev/null 2>&1']);
  if ((direct.status ?? 1) === 0) {
    phalaCliInvocationCache = { command: 'phala', argsPrefix: [] };
    return phalaCliInvocationCache;
  }

  phalaCliInvocationCache = { command: 'npx', argsPrefix: ['-y', 'phala'] };
  return phalaCliInvocationCache;
}

export const DEFAULT_REMOTE_COMMAND_TIMEOUT_MS = 45_000;

export function resolveNeoN3SignerWif(
  network = normalizeMorpheusNetwork(process.env.MORPHEUS_NETWORK || 'testnet')
) {
  const explicit = trimString(
    process.env.TEST_WIF || process.env.EXAMPLE_NEO_N3_WIF || process.env.EXAMPLE_TEST_WIF || ''
  );
  if (explicit) return explicit;
  const signer = resolvePinnedNeoN3RolePreferMatch(network, 'updater', {
    env: process.env,
    allowMissing: true,
  });
  return trimString(signer.materialized?.wif || signer.materialized?.private_key || '');
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isTransientRpcError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /HTTP code 502|HTTP code 503|HTTP code 504|ECONNRESET|ETIMEDOUT|socket hang up|fetch failed/i.test(
    message
  );
}

export async function withRetries(label, task, attempts = 5) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      if (!isTransientRpcError(error) || attempt === attempts) break;
      await sleep(1000 * attempt);
    }
  }
  throw new Error(
    `${label} failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`
  );
}

export function tryParseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function jsonPretty(value) {
  return `${JSON.stringify(
    value,
    (_key, current) => (typeof current === 'bigint' ? current.toString() : current),
    2
  )}\n`;
}

export async function loadExampleEnv() {
  const explicitNetwork = trimString(
    process.env.MORPHEUS_NETWORK || process.env.EXAMPLE_MORPHEUS_NETWORK || ''
  );
  const requestedNetwork = normalizeMorpheusNetwork(explicitNetwork || 'testnet');
  process.env.MORPHEUS_NETWORK = requestedNetwork;
  process.env.NEXT_PUBLIC_MORPHEUS_NETWORK ||= requestedNetwork;
  await loadDotEnv(path.resolve(repoRoot, '.env'), { override: false });
  const network = normalizeMorpheusNetwork(process.env.MORPHEUS_NETWORK || requestedNetwork);
  const envFileName = network === 'mainnet' ? 'morpheus.mainnet.env' : 'morpheus.testnet.env';
  // Prefer the current Nitro deployment env file; the deploy/phala path is the
  // legacy CVM location kept as a documented fallback for old checkouts.
  const nitroEnvPath = path.resolve(repoRoot, 'deploy', 'nitro', envFileName);
  const legacyPhalaEnvPath = path.resolve(repoRoot, 'deploy', 'phala', envFileName);
  if (!(await loadDotEnv(nitroEnvPath, { override: true }))) {
    await loadDotEnv(legacyPhalaEnvPath, { override: true });
  }
}

export async function readDeploymentRegistry(network = 'testnet') {
  const filePath = path.resolve(deploymentsDir, `${network}.json`);
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw error;
  }
}

export async function writeDeploymentRegistry(network, value) {
  const filePath = path.resolve(deploymentsDir, `${network}.json`);
  await fs.mkdir(deploymentsDir, { recursive: true });
  await fs.writeFile(filePath, jsonPretty(value));
}

export function reportDateStamp(isoString = new Date().toISOString()) {
  return String(isoString).slice(0, 10);
}

export function repoRelativePath(absolutePath) {
  return path.relative(repoRoot, absolutePath).replace(/\\/g, '/');
}

export function markdownJson(value) {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

export async function writeValidationArtifacts({
  baseName,
  network,
  generatedAt = new Date().toISOString(),
  jsonReport,
  markdownReport,
  legacyJsonFileNames = [],
}) {
  const date = reportDateStamp(generatedAt);
  const normalizedBase = trimString(baseName)
    .replace(/[^a-z0-9-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  const normalizedNetwork = trimString(network).toLowerCase() || 'unknown';
  const docBase = normalizedBase.replace(/-/g, '_').toUpperCase();

  const datedJsonPath = path.resolve(
    deploymentsDir,
    `${normalizedBase}.${normalizedNetwork}.${date}.json`
  );
  const latestJsonPath = path.resolve(
    deploymentsDir,
    `${normalizedBase}.${normalizedNetwork}.latest.json`
  );
  const markdownPath = path.resolve(
    docsDir,
    `${docBase}_${normalizedNetwork.toUpperCase()}_${date}.md`
  );

  await fs.mkdir(deploymentsDir, { recursive: true });
  await fs.mkdir(docsDir, { recursive: true });
  await fs.writeFile(datedJsonPath, jsonPretty(jsonReport));
  await fs.writeFile(latestJsonPath, jsonPretty(jsonReport));
  await fs.writeFile(
    markdownPath,
    markdownReport.endsWith('\n') ? markdownReport : `${markdownReport}\n`
  );

  for (const legacyFileName of legacyJsonFileNames) {
    const legacyPath = path.resolve(deploymentsDir, legacyFileName);
    await fs.writeFile(legacyPath, jsonPretty(jsonReport));
  }

  return {
    generated_at: generatedAt,
    json_report: repoRelativePath(datedJsonPath),
    json_latest: repoRelativePath(latestJsonPath),
    markdown_report: repoRelativePath(markdownPath),
    legacy_json_reports: legacyJsonFileNames.map((fileName) =>
      repoRelativePath(path.resolve(deploymentsDir, fileName))
    ),
  };
}

export async function writeSkippedValidationArtifacts({
  baseName,
  network,
  generatedAt = new Date().toISOString(),
  title,
  reason,
  details = {},
}) {
  const jsonReport = {
    generated_at: generatedAt,
    network,
    status: 'skipped',
    reason,
    ...details,
  };

  const markdownReport = [
    `# ${title}`,
    '',
    `Date: ${generatedAt}`,
    '',
    '## Result',
    '',
    '- Status: `skipped`',
    `- Reason: \`${reason}\``,
    '',
  ].join('\n');

  return writeValidationArtifacts({
    baseName,
    network,
    generatedAt,
    jsonReport,
    markdownReport,
  });
}

export function normalizeAddress(value) {
  const raw = trimString(value);
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) return '';
  return raw;
}

export function normalizeHash160(value) {
  const raw = trimString(value);
  if (!raw) return '';
  if (wallet.isAddress(raw)) {
    return `0x${wallet.getScriptHashFromAddress(raw).toLowerCase()}`;
  }
  const hex = raw.replace(/^0x/i, '').toLowerCase();
  return /^[0-9a-f]{40}$/.test(hex) ? `0x${hex}` : '';
}

export function decodeHexUtf8(bytesLike) {
  const raw = trimString(bytesLike || '0x');
  if (!raw || raw === '0x') return '';
  return Buffer.from(raw.replace(/^0x/i, ''), 'hex').toString('utf8');
}

export function decodeBase64Utf8(raw) {
  const text = trimString(raw);
  if (!text) return '';
  return Buffer.from(text, 'base64').toString('utf8');
}

export function encodeUtf8Hex(value) {
  return `0x${Buffer.from(String(value ?? ''), 'utf8').toString('hex')}`;
}

export function encodeUtf8Base64(value) {
  return Buffer.from(String(value ?? ''), 'utf8').toString('base64');
}

export function resolveNeoN3RpcUrl(network = 'testnet', deployment = {}) {
  const normalized = trimString(network).toLowerCase() || 'testnet';
  const defaultRpcUrl =
    normalized === 'mainnet'
      ? 'https://api.n3index.dev/mainnet'
      : 'https://api.n3index.dev/testnet';
  return trimString(
    normalized === 'testnet'
      ? process.env.NEO_TESTNET_RPC_URL ||
          deployment.rpc_url ||
          process.env.NEO_RPC_URL ||
          defaultRpcUrl
      : process.env.NEO_MAINNET_RPC_URL ||
          process.env.NEO_RPC_URL ||
          deployment.rpc_url ||
          defaultRpcUrl
  );
}

export function resolveNeoN3NetworkMagic(network = 'testnet', deployment = {}) {
  const normalized = trimString(network).toLowerCase() || 'testnet';
  const defaultNetworkMagic = normalized === 'mainnet' ? 860833102 : 894710606;
  const raw =
    normalized === 'testnet'
      ? process.env.NEO_TESTNET_NETWORK_MAGIC ||
        deployment.network_magic ||
        process.env.NEO_NETWORK_MAGIC ||
        defaultNetworkMagic
      : process.env.NEO_MAINNET_NETWORK_MAGIC ||
        process.env.NEO_NETWORK_MAGIC ||
        deployment.network_magic ||
        defaultNetworkMagic;
  return Number(raw);
}

export function resolveNeoN3OracleHash(network = 'testnet', deployment = {}) {
  const normalized = trimString(network).toLowerCase() || 'testnet';
  return normalizeHash160(
    normalized === 'testnet'
      ? process.env.CONTRACT_MORPHEUS_ORACLE_HASH_TESTNET ||
          deployment.oracle_hash ||
          process.env.CONTRACT_MORPHEUS_ORACLE_HASH ||
          ''
      : process.env.CONTRACT_MORPHEUS_ORACLE_HASH_MAINNET ||
          process.env.CONTRACT_MORPHEUS_ORACLE_HASH ||
          deployment.oracle_hash ||
          ''
  );
}

export function resolveNeoN3ConsumerHash(network = 'testnet', deployment = {}) {
  const normalized = trimString(network).toLowerCase() || 'testnet';
  return normalizeHash160(
    normalized === 'testnet'
      ? process.env.EXAMPLE_N3_CONSUMER_HASH_TESTNET ||
          deployment.example_consumer_hash ||
          process.env.EXAMPLE_N3_CONSUMER_HASH ||
          ''
      : process.env.EXAMPLE_N3_CONSUMER_HASH_MAINNET ||
          process.env.EXAMPLE_N3_CONSUMER_HASH ||
          deployment.example_consumer_hash ||
          ''
  );
}

export function resolveNeoN3FeedReaderHash(network = 'testnet', deployment = {}) {
  const normalized = trimString(network).toLowerCase() || 'testnet';
  return normalizeHash160(
    normalized === 'testnet'
      ? process.env.EXAMPLE_N3_FEED_READER_HASH_TESTNET ||
          deployment.example_feed_reader_hash ||
          process.env.EXAMPLE_N3_FEED_READER_HASH ||
          ''
      : process.env.EXAMPLE_N3_FEED_READER_HASH_MAINNET ||
          process.env.EXAMPLE_N3_FEED_READER_HASH ||
          deployment.example_feed_reader_hash ||
          ''
  );
}

export function resolveNeoN3DatafeedHash(network = 'testnet', deployment = {}) {
  const normalized = trimString(network).toLowerCase() || 'testnet';
  return normalizeHash160(
    normalized === 'testnet'
      ? process.env.CONTRACT_MORPHEUS_DATAFEED_HASH_TESTNET ||
          deployment.datafeed_hash ||
          process.env.CONTRACT_MORPHEUS_DATAFEED_HASH ||
          ''
      : process.env.CONTRACT_MORPHEUS_DATAFEED_HASH_MAINNET ||
          process.env.CONTRACT_MORPHEUS_DATAFEED_HASH ||
          deployment.datafeed_hash ||
          ''
  );
}

const ORACLE_ENCRYPTION_ALGORITHM = 'X25519-HKDF-SHA256-AES-256-GCM';
const ORACLE_ENCRYPTION_INFO = 'morpheus-confidential-payload-v2';
const AES_GCM_TAG_LENGTH_BYTES = 16;

function parseNeoRpcString(response) {
  const item = response?.stack?.[0];
  const type = trimString(item?.type).toLowerCase();
  if (type === 'string') return trimString(item?.value || '');
  if (type === 'bytestring' || type === 'bytearray') return decodeBase64Utf8(item?.value || '');
  return '';
}

export async function fetchOnchainOraclePublicKey(targetChain) {
  const chain = trimString(targetChain).toLowerCase();
  if (!chain) throw new Error('targetChain is required');

  if (chain === 'neo_n3') {
    const network = trimString(process.env.MORPHEUS_NETWORK || 'testnet').toLowerCase();
    const rpcUrl = trimString(
      process.env.NEO_RPC_URL ||
        (network === 'mainnet'
          ? 'https://api.n3index.dev/mainnet'
          : 'https://api.n3index.dev/testnet')
    );
    const oracleHash = normalizeHash160(process.env.CONTRACT_MORPHEUS_ORACLE_HASH || '');
    if (!oracleHash) throw new Error('CONTRACT_MORPHEUS_ORACLE_HASH is required');

    const rpcClient = new neoRpc.RPCClient(rpcUrl);
    const [algorithmResponse, publicKeyResponse] = await Promise.all([
      rpcClient.invokeFunction(oracleHash, 'oracleEncryptionAlgorithm', []).catch(() => null),
      rpcClient.invokeFunction(oracleHash, 'oracleEncryptionPublicKey', []),
    ]);
    const algorithm = parseNeoRpcString(algorithmResponse) || ORACLE_ENCRYPTION_ALGORITHM;
    const publicKey = parseNeoRpcString(publicKeyResponse);
    if (!publicKey) throw new Error('Neo N3 oracle encryption public key is empty');
    return {
      source: 'neo_n3_contract',
      algorithm,
      public_key: publicKey,
    };
  }

  throw new Error(`unsupported target chain for oracle key lookup: ${targetChain}`);
}

export async function fetchOraclePublicKey(targetChain = 'neo_n3') {
  return fetchOnchainOraclePublicKey(targetChain);
}

export async function encryptWithOracleKey(publicKeyBase64, plaintext) {
  const recipientPublicKeyBytes = Buffer.from(publicKeyBase64, 'base64');
  const recipientKey = await webcrypto.subtle.importKey(
    'raw',
    recipientPublicKeyBytes,
    { name: 'X25519' },
    false,
    []
  );
  const ephemeralKeyPair = await webcrypto.subtle.generateKey({ name: 'X25519' }, true, [
    'deriveBits',
  ]);
  const ephemeralPublicKeyBytes = new Uint8Array(
    await webcrypto.subtle.exportKey('raw', ephemeralKeyPair.publicKey)
  );
  const sharedSecret = new Uint8Array(
    await webcrypto.subtle.deriveBits(
      { name: 'X25519', public: recipientKey },
      ephemeralKeyPair.privateKey,
      256
    )
  );
  const keyMaterial = await webcrypto.subtle.importKey('raw', sharedSecret, 'HKDF', false, [
    'deriveKey',
  ]);
  const info = new Uint8Array([
    ...new TextEncoder().encode(ORACLE_ENCRYPTION_INFO),
    ...ephemeralPublicKeyBytes,
    ...recipientPublicKeyBytes,
  ]);
  const aesKey = await webcrypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: recipientPublicKeyBytes,
      info,
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt']
  );
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const encryptedBytes = new Uint8Array(
    await webcrypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      aesKey,
      new TextEncoder().encode(plaintext)
    )
  );
  const ciphertextBytes = encryptedBytes.slice(0, encryptedBytes.length - AES_GCM_TAG_LENGTH_BYTES);
  const tagBytes = encryptedBytes.slice(encryptedBytes.length - AES_GCM_TAG_LENGTH_BYTES);
  return Buffer.from(
    JSON.stringify({
      v: 2,
      alg: ORACLE_ENCRYPTION_ALGORITHM,
      epk: Buffer.from(ephemeralPublicKeyBytes).toString('base64'),
      iv: Buffer.from(iv).toString('base64'),
      ct: Buffer.from(ciphertextBytes).toString('base64'),
      tag: Buffer.from(tagBytes).toString('base64'),
    })
  ).toString('base64');
}

export async function buildEncryptedBuiltinComputePayload(targetChain) {
  const oracleKey = await fetchOnchainOraclePublicKey(targetChain);
  return encryptWithOracleKey(
    oracleKey.public_key,
    JSON.stringify({
      function: 'math.modexp',
      input: {
        base: '2',
        exponent: '10',
        modulus: '17',
      },
      target_chain: targetChain,
    })
  );
}

export async function buildEncryptedJsonPatch(targetChainOrValue, value = undefined) {
  const hasExplicitTargetChain = typeof targetChainOrValue === 'string';
  const oracleKey = hasExplicitTargetChain
    ? await fetchOnchainOraclePublicKey(targetChainOrValue)
    : await fetchOraclePublicKey();
  return encryptWithOracleKey(
    oracleKey.public_key,
    JSON.stringify(hasExplicitTargetChain ? value : targetChainOrValue)
  );
}
export function runLocalRelayerOnce({ neoN3StartBlock = null } = {}) {
  const env = {
    ...process.env,
    MORPHEUS_RELAYER_STATE_FILE: relayerStateFile,
    MORPHEUS_RELAYER_NEO_N3_CONFIRMATIONS: '0',
  };
  if (neoN3StartBlock !== null && neoN3StartBlock !== undefined) {
    env.MORPHEUS_RELAYER_NEO_N3_START_BLOCK = String(Math.max(Number(neoN3StartBlock), 0));
  }

  const result = spawnSync('npm', ['run', 'once:relayer'], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });
  if ((result.status ?? 1) !== 0) {
    throw new Error(result.stderr || result.stdout || 'local relayer once failed');
  }
  return result.stdout;
}
