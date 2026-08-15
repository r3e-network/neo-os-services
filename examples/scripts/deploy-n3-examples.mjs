import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { experimental, rpc as neoRpc, sc } from '@cityofzion/neon-js';
import {
  createContract,
  getDeployConfig,
  loadContractArtifacts,
} from '../../scripts/lib-neo-contracts.mjs';
import {
  jsonPretty,
  loadExampleEnv,
  normalizeHash160,
  readDeploymentRegistry,
  repoRoot,
  trimString,
  writeDeploymentRegistry,
  withRetries,
} from './common.mjs';

const BUILD_DIR = path.resolve(repoRoot, 'examples/build/n3');
const CONSUMER_ARTIFACT = 'UserConsumerN3OracleExample';
const READER_ARTIFACT = 'FeedReaderN3Example';

function resolveNccsPath() {
  const explicit = trimString(process.env.NCCS_PATH || '');
  if (explicit) return explicit;
  return path.join(process.env.HOME || '', '.dotnet/tools/nccs');
}

function parseStackItem(item) {
  if (!item || typeof item !== 'object') return null;
  const type = trimString(item.type).toLowerCase();
  switch (type) {
    case 'array':
    case 'struct':
      return Array.isArray(item.value) ? item.value.map((entry) => parseStackItem(entry)) : [];
    case 'hash160':
    case 'hash256':
    case 'string':
      return String(item.value ?? '');
    case 'integer':
      return String(item.value ?? '0');
    case 'boolean':
      return Boolean(item.value);
    case 'bytestring':
    case 'bytearray': {
      const raw = trimString(item.value);
      if (!raw) return '';
      const bytes = Buffer.from(raw, 'base64');
      if (bytes.length === 20) {
        return `0x${Buffer.from(bytes).reverse().toString('hex')}`;
      }
      const text = bytes.toString('utf8');
      return /^[\x09\x0a\x0d\x20-\x7e]*$/.test(text) ? text : `0x${bytes.toString('hex')}`;
    }
    default:
      return item.value ?? null;
  }
}

async function invokeRead(rpcClient, contractHash, method, params = []) {
  const response = await withRetries(`invokeRead:${method}`, () =>
    rpcClient.invokeFunction(contractHash, method, params)
  );
  if (String(response.state || '').toUpperCase() === 'FAULT') {
    throw new Error(`${method} faulted: ${response.exception || 'unknown error'}`);
  }
  return parseStackItem(response.stack?.[0]);
}

async function contractExists(rpcClient, hash) {
  if (!hash) return false;
  try {
    await rpcClient.getContractState(hash);
    return true;
  } catch {
    return false;
  }
}

async function isStaleConsumerContract(rpcClient, hash) {
  if (!(await contractExists(rpcClient, hash))) return false;
  try {
    const state = await rpcClient.getContractState(hash);
    const methods = Array.isArray(state?.manifest?.abi?.methods)
      ? state.manifest.abi.methods.map((item) => item?.name)
      : [];
    const required = [
      'requestBuiltinProviderPrice',
      'requestBuiltinCompute',
      'depositOracleCredits',
      'contractGasBalance',
      'onNEP17Payment',
    ];
    return required.some((method) => !methods.includes(method));
  } catch {
    return false;
  }
}

function decodeDeployHash(appLog) {
  const notification = appLog?.executions
    ?.flatMap((execution) => execution.notifications || [])
    .find((entry) => entry.eventname === 'Deploy');
  const value = notification?.state?.value?.[0]?.value || '';
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length !== 20) throw new Error('failed to decode deployed Neo N3 contract hash');
  return `0x${Buffer.from(bytes).reverse().toString('hex')}`;
}

async function waitForApplicationLog(rpcClient, txHash, timeoutMs = 180000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await rpcClient.getApplicationLog(txHash);
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`timed out waiting for Neo N3 application log ${txHash}`);
}

async function waitForContract(rpcClient, hash, timeoutMs = 180000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await contractExists(rpcClient, hash)) return;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`timed out waiting for Neo N3 contract ${hash} deployment`);
}

async function waitForCondition(check, description, timeoutMs = 60000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`timed out waiting for Neo N3 condition: ${description}`);
}

function compileN3Example(relativeProjectPath) {
  const nccsPath = resolveNccsPath();
  const projectPath = path.resolve(repoRoot, relativeProjectPath);
  execFileSync(nccsPath, [projectPath, '--generate-artifacts', 'All', '--output', BUILD_DIR], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
}

await loadExampleEnv();

const network = trimString(process.env.MORPHEUS_NETWORK || 'testnet') || 'testnet';
const oracleHash = normalizeHash160(process.env.CONTRACT_MORPHEUS_ORACLE_HASH || '');
const datafeedHash = normalizeHash160(process.env.CONTRACT_MORPHEUS_DATAFEED_HASH || '');

if (!oracleHash) throw new Error('CONTRACT_MORPHEUS_ORACLE_HASH is required');
if (!datafeedHash) throw new Error('CONTRACT_MORPHEUS_DATAFEED_HASH is required');

console.log('Compiling Neo N3 example contracts...');
compileN3Example('examples/contracts/n3/UserConsumerN3.csproj');
compileN3Example('examples/contracts/n3/FeedReaderN3.csproj');

const config = getDeployConfig();
const rpcClient = new neoRpc.RPCClient(config.rpcAddress);
const registry = await readDeploymentRegistry(network);
const previousN3 = registry.neo_n3 || {};

let consumerHash = normalizeHash160(previousN3.example_consumer_hash || '');
let readerHash = normalizeHash160(previousN3.example_feed_reader_hash || '');

if (await isStaleConsumerContract(rpcClient, consumerHash)) {
  console.log(
    `Detected stale Neo N3 example consumer ${consumerHash}; redeploying updated contract...`
  );
  consumerHash = '';
}

const [consumerArtifacts, readerArtifacts] = await Promise.all([
  loadContractArtifacts(CONSUMER_ARTIFACT, BUILD_DIR),
  loadContractArtifacts(READER_ARTIFACT, BUILD_DIR),
]);

const predictedConsumerHash = normalizeHash160(
  experimental.getContractHash(
    config.account.scriptHash,
    consumerArtifacts.nef.checksum,
    consumerArtifacts.manifest.name
  )
);
const predictedReaderHash = normalizeHash160(
  experimental.getContractHash(
    config.account.scriptHash,
    readerArtifacts.nef.checksum,
    readerArtifacts.manifest.name
  )
);

if (
  !(await contractExists(rpcClient, consumerHash)) &&
  (await contractExists(rpcClient, predictedConsumerHash))
) {
  console.log(
    `Reusing existing Neo N3 example consumer at predicted hash ${predictedConsumerHash}`
  );
  consumerHash = predictedConsumerHash;
}

if (
  !(await contractExists(rpcClient, readerHash)) &&
  (await contractExists(rpcClient, predictedReaderHash))
) {
  console.log(
    `Reusing existing Neo N3 example feed reader at predicted hash ${predictedReaderHash}`
  );
  readerHash = predictedReaderHash;
}

let consumerDeployTx = null;
if (!(await contractExists(rpcClient, consumerHash))) {
  console.log('Deploying Neo N3 example consumer...');
  consumerDeployTx = await experimental.deployContract(
    consumerArtifacts.nef,
    consumerArtifacts.manifest,
    config
  );
  console.log(`Neo N3 example consumer deploy tx: ${consumerDeployTx}`);
  consumerHash = decodeDeployHash(await waitForApplicationLog(rpcClient, consumerDeployTx));
  await waitForContract(rpcClient, consumerHash);
}

let readerDeployTx = null;
if (!(await contractExists(rpcClient, readerHash))) {
  console.log('Deploying Neo N3 example feed reader...');
  readerDeployTx = await experimental.deployContract(
    readerArtifacts.nef,
    readerArtifacts.manifest,
    config
  );
  console.log(`Neo N3 example feed reader deploy tx: ${readerDeployTx}`);
  readerHash = decodeDeployHash(await waitForApplicationLog(rpcClient, readerDeployTx));
  await waitForContract(rpcClient, readerHash);
}

if (!consumerHash) throw new Error('failed to resolve Neo N3 example consumer hash');
if (!readerHash) throw new Error('failed to resolve Neo N3 example feed reader hash');

const oracle = createContract(oracleHash);
const consumer = createContract(consumerHash);

let allowCallbackTx = null;
const callbackAllowed = Boolean(
  await invokeRead(rpcClient, oracleHash, 'isAllowedCallback', [
    { type: 'Hash160', value: consumerHash },
  ])
);
if (!callbackAllowed) {
  console.log('Allowlisting Neo N3 example consumer on live oracle...');
  allowCallbackTx = await oracle.invoke('addAllowedCallback', [
    sc.ContractParam.hash160(consumerHash),
  ]);
  await waitForCondition(
    async () =>
      Boolean(
        await invokeRead(rpcClient, oracleHash, 'isAllowedCallback', [
          { type: 'Hash160', value: consumerHash },
        ])
      ),
    `allowlisted callback ${consumerHash}`
  );
}

let setOracleTx = null;
const currentOracle = normalizeHash160(await invokeRead(rpcClient, consumerHash, 'oracle'));
if (currentOracle !== oracleHash) {
  console.log('Setting Neo N3 example consumer oracle reference...');
  setOracleTx = await consumer.invoke('setOracle', [sc.ContractParam.hash160(oracleHash)]);
  await waitForCondition(
    async () =>
      normalizeHash160(await invokeRead(rpcClient, consumerHash, 'oracle')) === oracleHash,
    `consumer oracle ${consumerHash} -> ${oracleHash}`
  );
}

const finalAllowlisted = Boolean(
  await invokeRead(rpcClient, oracleHash, 'isAllowedCallback', [
    { type: 'Hash160', value: consumerHash },
  ])
);
const finalOracle = normalizeHash160(await invokeRead(rpcClient, consumerHash, 'oracle'));

if (!finalAllowlisted)
  throw new Error(`failed to allowlist Neo N3 example consumer ${consumerHash}`);
if (finalOracle !== oracleHash)
  throw new Error(`failed to point Neo N3 example consumer at oracle ${oracleHash}`);

registry.updated_at = new Date().toISOString();
registry.neo_n3 = {
  deployed_at: new Date().toISOString(),
  rpc_url: config.rpcAddress,
  network_magic: config.networkMagic,
  deployer_address: config.account.address,
  deployer_script_hash: config.account.scriptHash,
  oracle_hash: oracleHash,
  datafeed_hash: datafeedHash,
  example_consumer_hash: consumerHash,
  example_feed_reader_hash: readerHash,
  allowlisted: true,
  consumer_oracle: finalOracle,
  transactions: {
    consumer_deploy: consumerDeployTx,
    feed_reader_deploy: readerDeployTx,
    allow_callback: allowCallbackTx,
    set_oracle: setOracleTx,
  },
};
await writeDeploymentRegistry(network, registry);

process.stdout.write(
  jsonPretty({
    network,
    neo_n3: registry.neo_n3,
  })
);
