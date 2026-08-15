import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { experimental, rpc as neoRpc, sc, tx, u, wallet } from '@cityofzion/neon-js';
import {
  DEFAULT_REMOTE_COMMAND_TIMEOUT_MS,
  encodeUtf8Base64,
  jsonPretty,
  loadExampleEnv,
  logValidationStep,
  normalizeHash160,
  readDeploymentRegistry,
  repoRoot,
  resolvePhalaCliInvocation,
  resolveNeoN3SignerWif,
  sleep,
  trimString,
  writeValidationArtifacts,
  writeSkippedValidationArtifacts,
  withRetries,
} from './common.mjs';

const execFileAsync = promisify(execFile);
const GAS_HASH = '0xd2a4cff31913016155e38e474a2c06d08be276cf';
const EXAMPLE_BUILD_DIR = path.resolve(repoRoot, 'examples/build/n3');
const EXAMPLE_CONSUMER_ARTIFACT = 'UserConsumerN3OracleExample';
const AA_REPO_ROOT = path.resolve(repoRoot, '..', 'neo-abstract-account');
const RECOVERY_SOURCE_REF = '9cb7cca:contracts/recovery/MorpheusSocialRecoveryVerifier.Fixed.cs';
const RECOVERY_CSPROJ_REF = '9cb7cca:contracts/recovery/MorpheusSocialRecoveryVerifier.csproj';
const REMOTE_COMMAND_TIMEOUT_MS = Math.max(
  Number(process.env.MORPHEUS_REMOTE_COMMAND_TIMEOUT_MS || DEFAULT_REMOTE_COMMAND_TIMEOUT_MS),
  5000
);

function assertCondition(condition, message) {
  if (!condition) throw new Error(message);
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
      if (bytes.length === 20) return `0x${Buffer.from(bytes).reverse().toString('hex')}`;
      const text = bytes.toString('utf8');
      return /^[\x09\x0a\x0d\x20-\x7e]*$/.test(text) ? text : `0x${bytes.toString('hex')}`;
    }
    default:
      return item.value ?? null;
  }
}

function decodeCallbackArray(item) {
  if (!item || item.type !== 'Array' || !Array.isArray(item.value) || item.value.length < 4)
    return null;
  const [requestTypeItem, successItem, resultItem, errorItem] = item.value;
  const requestType = Buffer.from(trimString(requestTypeItem?.value || ''), 'base64').toString(
    'utf8'
  );
  const resultText = Buffer.from(trimString(resultItem?.value || ''), 'base64').toString('utf8');
  const errorText = Buffer.from(trimString(errorItem?.value || ''), 'base64').toString('utf8');
  return {
    request_type: requestType,
    success: Boolean(successItem?.value),
    result_text: resultText,
    result_json: (() => {
      try {
        return JSON.parse(resultText);
      } catch {
        return null;
      }
    })(),
    error_text: errorText,
  };
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

async function invokeReadRaw(rpcClient, contractHash, method, params = []) {
  const response = await withRetries(`invokeRead:${method}`, () =>
    rpcClient.invokeFunction(contractHash, method, params)
  );
  if (String(response.state || '').toUpperCase() === 'FAULT') {
    throw new Error(`${method} faulted: ${response.exception || 'unknown error'}`);
  }
  return response.stack?.[0] || null;
}

async function waitForApplicationLog(rpcClient, txHash, timeoutMs = 180000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await rpcClient.getApplicationLog(txHash);
    } catch {}
    await sleep(2000);
  }
  throw new Error(`timed out waiting for application log ${txHash}`);
}

function assertHalt(appLog, label) {
  const execution = appLog?.executions?.[0];
  const vmState = String(execution?.vmstate || execution?.state || '');
  if (!vmState.includes('HALT')) {
    throw new Error(`${label} did not HALT: ${vmState} ${execution?.exception || ''}`.trim());
  }
  return execution;
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

async function loadContractArtifacts(baseName, buildDir) {
  const nefPath = path.join(buildDir, `${baseName}.nef`);
  const manifestPath = path.join(buildDir, `${baseName}.manifest.json`);
  const [nefBytes, manifestRaw] = await Promise.all([
    fs.readFile(nefPath),
    fs.readFile(manifestPath, 'utf8'),
  ]);
  return {
    nef: sc.NEF.fromBuffer(nefBytes),
    manifestJson: JSON.parse(manifestRaw),
  };
}

async function deployContract(
  rpcClient,
  account,
  rpcUrl,
  networkMagic,
  baseName,
  suffix,
  buildDir
) {
  const { nef, manifestJson } = await loadContractArtifacts(baseName, buildDir);
  const uniqueManifest = sc.ContractManifest.fromJson({
    ...manifestJson,
    name: `${manifestJson.name}-${suffix}`,
  });
  const txid = await experimental.deployContract(nef, uniqueManifest, {
    account,
    rpcAddress: rpcUrl,
    networkMagic,
    blocksTillExpiry: 200,
  });
  const appLog = await waitForApplicationLog(rpcClient, txid);
  assertHalt(appLog, `deploy ${baseName}`);
  return {
    txid,
    hash: decodeDeployHash(appLog),
  };
}

async function compileRecoveryVerifier() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'morpheus-recovery-verifier-'));
  const outDir = path.join(tempDir, 'out');
  await fs.mkdir(outDir, { recursive: true });
  const source = await execFileAsync('git', ['-C', AA_REPO_ROOT, 'show', RECOVERY_SOURCE_REF], {
    maxBuffer: 10 * 1024 * 1024,
  });
  const csproj = await execFileAsync('git', ['-C', AA_REPO_ROOT, 'show', RECOVERY_CSPROJ_REF], {
    maxBuffer: 10 * 1024 * 1024,
  });
  await fs.writeFile(path.join(tempDir, 'MorpheusSocialRecoveryVerifier.Fixed.cs'), source.stdout);
  await fs.writeFile(path.join(tempDir, 'MorpheusSocialRecoveryVerifier.csproj'), csproj.stdout);
  await execFileAsync(
    path.join(process.env.HOME || '~', '.dotnet/tools/nccs'),
    [
      path.join(tempDir, 'MorpheusSocialRecoveryVerifier.csproj'),
      '-o',
      outDir,
      '--base-name',
      'MorpheusSocialRecoveryVerifier',
      '--assembly',
    ],
    {
      maxBuffer: 10 * 1024 * 1024,
    }
  );
  return { tempDir, outDir };
}

async function ensureRequestFeeCredit(
  account,
  rpcUrl,
  networkMagic,
  rpcClient,
  oracleHash,
  requiredRequests
) {
  const currentCredit = BigInt(
    (await invokeRead(rpcClient, oracleHash, 'feeCreditOf', [
      { type: 'Hash160', value: `0x${account.scriptHash}` },
    ])) || '0'
  );
  const requestFee = BigInt((await invokeRead(rpcClient, oracleHash, 'requestFee', [])) || '0');
  const requiredCredit = requestFee * BigInt(requiredRequests);
  if (requestFee <= 0n || currentCredit >= requiredCredit) {
    return {
      request_fee: requestFee.toString(),
      current_credit: currentCredit.toString(),
      deposit_amount: '0',
    };
  }
  const gas = new experimental.SmartContract(GAS_HASH, {
    rpcAddress: rpcUrl,
    networkMagic,
    account,
  });
  const deficit = requiredCredit - currentCredit;
  const txid = await gas.invoke('transfer', [
    sc.ContractParam.hash160(`0x${account.scriptHash}`),
    sc.ContractParam.hash160(oracleHash),
    sc.ContractParam.integer(deficit.toString()),
    sc.ContractParam.any(null),
  ]);
  await waitForApplicationLog(rpcClient, txid);
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const updatedCredit = BigInt(
      (await invokeRead(rpcClient, oracleHash, 'feeCreditOf', [
        { type: 'Hash160', value: `0x${account.scriptHash}` },
      ])) || '0'
    );
    if (updatedCredit >= requiredCredit) {
      return {
        request_fee: requestFee.toString(),
        current_credit: updatedCredit.toString(),
        deposit_amount: deficit.toString(),
      };
    }
    await sleep(2000);
  }
  throw new Error('timed out waiting for Neo N3 request fee credit');
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

async function runRemoteCommand(command, { appId, phalaApiToken }) {
  const phalaCli = resolvePhalaCliInvocation();
  logValidationStep('remote_command', {
    script: 'test-n3-aa-recovery-cross-account-boundary',
    app_id: appId,
    timeout_ms: REMOTE_COMMAND_TIMEOUT_MS,
    command_preview: command.slice(0, 120),
  });
  const attempts = [
    trimString(phalaApiToken)
      ? [...phalaCli.argsPrefix, 'ssh', '--api-token', phalaApiToken, appId, '--', `sh -lc ${shellQuote(command)}`]
      : null,
    [...phalaCli.argsPrefix, 'ssh', appId, '--', `sh -lc ${shellQuote(command)}`],
  ].filter(Boolean);

  let lastError = null;
  for (const args of attempts) {
    try {
      const { stdout } = await execFileAsync(phalaCli.command, args, {
        maxBuffer: 10 * 1024 * 1024,
        timeout: REMOTE_COMMAND_TIMEOUT_MS,
      });
      return stdout;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error('failed to execute remote phala ssh command');
}

async function findRelayerLoopPid({ appId, phalaApiToken }) {
  const stdout = await runRemoteCommand(
    "ps -ef | grep 'node src/cli.js loop' | grep -v grep | awk 'NR==1 {print $1}'",
    { appId, phalaApiToken }
  );
  return trimString(stdout.split(/\r?\n/, 1)[0] || '');
}

async function waitForRelayerState({
  appId,
  phalaApiToken,
  pid,
  shouldBeRunning,
  timeoutMs = 30000,
}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const stdout = await runRemoteCommand(
      `ps -o pid=,stat=,args= | awk '$1 == ${pid} {print $2}'`,
      { appId, phalaApiToken }
    );
    const status = trimString(stdout.split(/\r?\n/, 1)[0] || '');
    const paused = status.includes('T');
    const running = Boolean(status) && !paused;
    if ((shouldBeRunning && running) || (!shouldBeRunning && paused)) return;
    await sleep(1000);
  }
  throw new Error(`timed out waiting for morpheus-relayer paused=${!shouldBeRunning}`);
}

async function stopRelayer({ appId, phalaApiToken }) {
  const pid = await findRelayerLoopPid({ appId, phalaApiToken });
  assertCondition(pid, 'morpheus relayer loop pid not found on testnet CVM');
  await runRemoteCommand(`kill -s STOP ${pid}`, { appId, phalaApiToken });
  await waitForRelayerState({ appId, phalaApiToken, pid, shouldBeRunning: false });
  return pid;
}

async function startRelayer({ appId, phalaApiToken, pid }) {
  if (!trimString(pid)) return;
  await runRemoteCommand(`kill -s CONT ${pid}`, { appId, phalaApiToken });
  await waitForRelayerState({ appId, phalaApiToken, pid, shouldBeRunning: true });
}

async function waitForRequestId(rpcClient, txid, timeoutMs = 90000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const appLog = await rpcClient.getApplicationLog(txid);
      const notification = appLog.executions
        ?.flatMap((execution) => execution.notifications || [])
        .find((entry) => ['OracleRequested', 'MiniAppRequestQueued'].includes(entry.eventname));
      const requestId = notification?.state?.value?.[0]?.value ?? null;
      if (requestId) return requestId;
    } catch {}
    await sleep(2000);
  }
  throw new Error(`timed out waiting for request id from tx ${txid}`);
}

async function waitForCallback(rpcClient, consumerHash, requestId, timeoutMs = 180000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const response = await rpcClient.invokeFunction(consumerHash, 'getCallback', [
      { type: 'Integer', value: String(requestId) },
    ]);
    const decoded = decodeCallbackArray(response.stack?.[0]);
    if (decoded && (decoded.request_type || decoded.result_text || decoded.error_text)) {
      return decoded;
    }
    await sleep(2000);
  }
  throw new Error(`timed out waiting for callback ${requestId}`);
}

async function fetchRawCallbackResult(rpcClient, consumerHash, requestId, timeoutMs = 180000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const response = await rpcClient.invokeFunction(consumerHash, 'getCallback', [
      { type: 'Integer', value: String(requestId) },
    ]);
    const item = response.stack?.[0];
    if (item?.type === 'Array' && Array.isArray(item.value) && item.value.length >= 4) {
      const [requestTypeItem, successItem, resultItem, errorItem] = item.value;
      const requestType = Buffer.from(trimString(requestTypeItem?.value || ''), 'base64').toString(
        'utf8'
      );
      const success = Boolean(successItem?.value);
      const resultBytes = Buffer.from(trimString(resultItem?.value || ''), 'base64');
      const errorText = Buffer.from(trimString(errorItem?.value || ''), 'base64').toString('utf8');
      if (requestType || resultBytes.length > 0 || errorText) {
        return { requestType, success, resultBytes, errorText };
      }
    }
    await sleep(2000);
  }
  throw new Error(`timed out waiting for raw callback ${requestId}`);
}

function decodeRecoveryTicketV3(resultBytes) {
  const segments = resultBytes.toString('utf8').split('|');
  assertCondition(segments.length === 4, 'invalid recovery v3 compact payload');
  assertCondition(segments[0] === '3', 'unexpected recovery ticket version');
  return {
    master_nullifier: `0x${Buffer.from(segments[1], 'base64').toString('hex')}`,
    action_nullifier: `0x${Buffer.from(segments[2], 'base64').toString('hex')}`,
    signature: `0x${Buffer.from(segments[3], 'base64').toString('hex')}`,
  };
}

function decodeBindResult(callbackItem) {
  const decoded =
    typeof callbackItem?.request_type === 'string'
      ? callbackItem
      : decodeCallbackArray(callbackItem);
  return decoded?.result_json?.result || {};
}

function utf8ByteArrayParam(value) {
  return sc.ContractParam.byteArray(
    u.HexString.fromHex(Buffer.from(String(value ?? ''), 'utf8').toString('hex'), true)
  );
}

function hexByteArrayParam(hexValue) {
  return sc.ContractParam.byteArray(
    u.HexString.fromHex(String(hexValue || '').replace(/^0x/i, ''), true)
  );
}

function toNeoInternalHex(hashValue) {
  const hex = String(hashValue || '')
    .replace(/^0x/i, '')
    .toLowerCase();
  assertCondition(/^[0-9a-f]{40}$/.test(hex), `invalid hash160: ${hashValue}`);
  return `0x${Buffer.from(hex, 'hex').reverse().toString('hex')}`;
}

async function fetchBindMasterNullifier({
  consumer,
  rpcClient,
  providerUid,
  requesterHash,
  beforeSubmit,
  afterSubmit,
}) {
  const payload = {
    provider: 'github',
    provider_uid: providerUid,
    vault_account: requesterHash,
    claim_type: 'Github_VerifiedUser',
    claim_value: 'true',
  };
  let txid = null;
  try {
    if (beforeSubmit) await beforeSubmit();
    txid = await consumer.invoke(
      'requestRaw',
      ['neodid_bind', sc.ContractParam.byteArray(encodeUtf8Base64(JSON.stringify(payload)))],
      [new tx.Signer({ account: consumer.account.scriptHash, scopes: tx.WitnessScope.Global })]
    );
  } finally {
    if (afterSubmit) await afterSubmit(txid).catch(() => {});
  }
  const requestId = await waitForRequestId(rpcClient, txid);
  const callback = await waitForCallback(rpcClient, consumer.scriptHash, requestId);
  assertCondition(callback?.success === true, 'neodid_bind callback should succeed');
  const result = decodeBindResult(callback);
  assertCondition(
    /^0x[0-9a-f]{64}$/i.test(result.master_nullifier || ''),
    'master_nullifier missing from bind callback'
  );
  return {
    txid,
    request_id: String(requestId),
    callback,
    master_nullifier: result.master_nullifier.toLowerCase(),
  };
}

function creditProtectedHooks({
  account,
  rpcUrl,
  networkMagic,
  rpcClient,
  oracleHash,
  phalaApiToken,
  appId,
  requiredRequests,
}) {
  let pid = '';
  return {
    beforeSubmit: async () => {
      pid = await stopRelayer({ phalaApiToken, appId });
      await ensureRequestFeeCredit(
        account,
        rpcUrl,
        networkMagic,
        rpcClient,
        oracleHash,
        requiredRequests
      );
    },
    afterSubmit: async () => {
      await startRelayer({ phalaApiToken, appId, pid }).catch(() => {});
    },
  };
}

function computeRecoveryActionId({
  network,
  aaContract,
  accountIdText,
  newOwner,
  recoveryNonceText,
}) {
  const digest = createHash('sha256')
    .update([network, aaContract, accountIdText, newOwner, recoveryNonceText].join('\u001f'))
    .digest('hex');
  return `aa_recovery:${digest}`;
}

async function main() {
  logValidationStep('boot', { script: 'test-n3-aa-recovery-cross-account-boundary' });
  await loadExampleEnv();
  const deployment = (await readDeploymentRegistry('testnet')).neo_n3 || {};
  const rpcUrl = trimString(deployment.rpc_url || 'https://testnet1.neo.coz.io:443');
  const networkMagic = Number(deployment.network_magic || 894710606);
  const signerWif = resolveNeoN3SignerWif('testnet');
  const oracleHash = normalizeHash160(deployment.oracle_hash || '');
  const consumerHash = normalizeHash160(deployment.example_consumer_hash || '');
  const aaCoreHash = trimString(
    process.env.AA_CORE_HASH_TESTNET || '0xdbf38e7b2117186bf7a5e17ead702322c0c5b6f2'
  );
  const phalaApiToken = trimString(
    process.env.PHALA_API_TOKEN || process.env.PHALA_SHARED_SECRET || ''
  );
  const phalaAppId = trimString(
    process.env.MORPHEUS_PAYMASTER_APP_ID || 'ddff154546fe22d15b65667156dd4b7c611e6093'
  );
  const verifierPubkey =
    JSON.parse(
      await fs.readFile(
        path.resolve(repoRoot, 'examples/deployments/n3-neodid-oracle-matrix.testnet.latest.json'),
        'utf8'
      )
    ).cases?.find((item) => item.request_type === 'neodid_recovery_ticket')?.callback?.result_json
      ?.verification?.public_key || '';

  assertCondition(signerWif, 'testnet signer WIF is required');
  assertCondition(oracleHash, 'testnet oracle hash is required');
  assertCondition(consumerHash, 'testnet example consumer hash is required');
  assertCondition(trimString(verifierPubkey), 'NeoDID verifier public key is required');
  logValidationStep('config', {
    network: 'testnet',
    rpc_url: rpcUrl,
    oracle_hash: oracleHash,
    consumer_hash: consumerHash,
    aa_core_hash: aaCoreHash,
    phala_app_id: phalaAppId,
  });

  const account = new wallet.Account(signerWif);
  const rpcClient = new neoRpc.RPCClient(rpcUrl);
  const requesterHash = `0x${account.scriptHash}`;
  const providerUid = `aa-recovery-cross-account-${Date.now()}`;
  const consumer = new experimental.SmartContract(consumerHash, {
    rpcAddress: rpcUrl,
    networkMagic,
    account,
  });
  consumer.scriptHash = consumerHash.replace(/^0x/i, '');
  consumer.account = account;

  const feeHooks = creditProtectedHooks({
    account,
    rpcUrl,
    networkMagic,
    rpcClient,
    oracleHash,
    phalaApiToken,
    appId: phalaAppId,
    requiredRequests: 12,
  });
  const feeStatus = await (async () => {
    await feeHooks.beforeSubmit();
    await feeHooks.afterSubmit();
    return ensureRequestFeeCredit(account, rpcUrl, networkMagic, rpcClient, oracleHash, 12).catch(
      () => ({ request_fee: '0', current_credit: '0', deposit_amount: '0' })
    );
  })();
  const bind = await fetchBindMasterNullifier({
    consumer,
    rpcClient,
    providerUid,
    requesterHash,
    beforeSubmit: feeHooks.beforeSubmit,
    afterSubmit: feeHooks.afterSubmit,
  });

  const compiled = await compileRecoveryVerifier();
  try {
    const verifier = await deployContract(
      rpcClient,
      account,
      rpcUrl,
      networkMagic,
      'MorpheusSocialRecoveryVerifier',
      `recovery-boundary-${Date.now()}`,
      compiled.outDir
    );
    const ownerHash = requesterHash;
    const accountIdA = 'aa-social-recovery-cross-a';
    const accountIdB = 'aa-social-recovery-cross-b';
    const accountAddressA = normalizeHash160(
      process.env.AA_RECOVERY_BOUNDARY_ACCOUNT_A || `0x${new wallet.Account().scriptHash}`
    );
    const accountAddressB = normalizeHash160(
      process.env.AA_RECOVERY_BOUNDARY_ACCOUNT_B || `0x${new wallet.Account().scriptHash}`
    );
    const newOwnerA = normalizeHash160(
      process.env.AA_RECOVERY_BOUNDARY_NEW_OWNER_A || `0x${new wallet.Account().scriptHash}`
    );
    const newOwnerB = normalizeHash160(
      process.env.AA_RECOVERY_BOUNDARY_NEW_OWNER_B || `0x${new wallet.Account().scriptHash}`
    );
    const aaCoreHashInternal = toNeoInternalHex(aaCoreHash);
    const verifierHashInternal = toNeoInternalHex(verifier.hash);
    const accountAddressAInternal = toNeoInternalHex(accountAddressA);
    const accountAddressBInternal = toNeoInternalHex(accountAddressB);
    const newOwnerAInternal = toNeoInternalHex(newOwnerA);
    const newOwnerBInternal = toNeoInternalHex(newOwnerB);
    const recoveryNonceText = '0';
    const expiresAtText = String(Date.now() + 24 * 60 * 60 * 1000);

    const verifierContract = new experimental.SmartContract(verifier.hash, {
      rpcAddress: rpcUrl,
      networkMagic,
      account,
    });
    const signers = [
      new tx.Signer({ account: account.scriptHash, scopes: tx.WitnessScope.Global }),
    ];

    const setupParams = (accountIdText, accountAddress) => [
      utf8ByteArrayParam(accountIdText),
      sc.ContractParam.string(accountIdText),
      sc.ContractParam.string('neo_n3'),
      sc.ContractParam.hash160(ownerHash),
      sc.ContractParam.hash160(aaCoreHash),
      sc.ContractParam.hash160(accountAddress),
      sc.ContractParam.hash160(oracleHash),
      sc.ContractParam.array(hexByteArrayParam(bind.master_nullifier)),
      sc.ContractParam.integer(1),
      sc.ContractParam.integer(0),
      sc.ContractParam.publicKey(verifierPubkey),
    ];

    const setupATx = await verifierContract.invoke(
      'setupRecovery',
      setupParams(accountIdA, accountAddressA),
      signers
    );
    const setupBTx = await verifierContract.invoke(
      'setupRecovery',
      setupParams(accountIdB, accountAddressB),
      signers
    );
    await waitForApplicationLog(rpcClient, setupATx);
    await waitForApplicationLog(rpcClient, setupBTx);

    const recoveryActionIdA = computeRecoveryActionId({
      network: 'neo_n3',
      aaContract: aaCoreHashInternal,
      accountIdText: accountIdA,
      newOwner: newOwnerAInternal,
      recoveryNonceText,
    });

    const recoveryPayloadA = {
      provider: 'github',
      provider_uid: providerUid,
      network: 'neo_n3',
      aa_contract: aaCoreHashInternal,
      verifier_contract: verifierHashInternal,
      account_address: accountAddressAInternal,
      account_id: accountIdA,
      new_owner: newOwnerAInternal,
      recovery_nonce: recoveryNonceText,
      expires_at: expiresAtText,
      action_id: recoveryActionIdA,
      callback_encoding: 'neo_n3_recovery_v3',
    };

    let recoveryTx = null;
    try {
      await feeHooks.beforeSubmit();
      recoveryTx = await consumer.invoke(
        'requestRaw',
        [
          'neodid_recovery_ticket',
          sc.ContractParam.byteArray(encodeUtf8Base64(JSON.stringify(recoveryPayloadA))),
        ],
        signers
      );
    } finally {
      await feeHooks.afterSubmit(recoveryTx).catch(() => {});
    }
    const recoveryRequestId = await waitForRequestId(rpcClient, recoveryTx);
    const recoveryCallback = await fetchRawCallbackResult(
      rpcClient,
      consumerHash,
      recoveryRequestId
    );
    assertCondition(recoveryCallback.success === true, 'recovery ticket callback should succeed');
    const compact = decodeRecoveryTicketV3(recoveryCallback.resultBytes);

    const submitATx = await verifierContract.invoke(
      'submitRecoveryTicket',
      [
        utf8ByteArrayParam(accountIdA),
        sc.ContractParam.hash160(newOwnerA),
        sc.ContractParam.string(recoveryNonceText),
        sc.ContractParam.string(expiresAtText),
        sc.ContractParam.string(recoveryActionIdA),
        hexByteArrayParam(compact.master_nullifier),
        hexByteArrayParam(compact.action_nullifier),
        hexByteArrayParam(compact.signature),
      ],
      signers
    );
    const submitALog = await waitForApplicationLog(rpcClient, submitATx);
    assertHalt(submitALog, 'submitRecoveryTicket A');

    const wrongAccountTest = await verifierContract.testInvoke(
      'submitRecoveryTicket',
      [
        utf8ByteArrayParam(accountIdB),
        sc.ContractParam.hash160(newOwnerA),
        sc.ContractParam.string(recoveryNonceText),
        sc.ContractParam.string(expiresAtText),
        sc.ContractParam.string(recoveryActionIdA),
        hexByteArrayParam(compact.master_nullifier),
        hexByteArrayParam(compact.action_nullifier),
        hexByteArrayParam(compact.signature),
      ],
      signers
    );

    const pendingA = await invokeReadRaw(rpcClient, verifier.hash, 'getPendingRecovery', [
      { type: 'ByteArray', value: Buffer.from(accountIdA, 'utf8').toString('base64') },
    ]);
    const pendingB = await invokeReadRaw(rpcClient, verifier.hash, 'getPendingRecovery', [
      { type: 'ByteArray', value: Buffer.from(accountIdB, 'utf8').toString('base64') },
    ]);

    const generatedAt = new Date().toISOString();
    const jsonReport = {
      generated_at: generatedAt,
      network: 'testnet',
      rpc_url: rpcUrl,
      network_magic: networkMagic,
      oracle_hash: oracleHash,
      callback_consumer_hash: consumerHash,
      aa_core_hash: aaCoreHash,
      recovery_verifier_hash: verifier.hash,
      requester_hash: requesterHash,
      fee_status: feeStatus,
      bind_master_nullifier: bind.master_nullifier,
      setup: {
        account_id_a: accountIdA,
        account_id_b: accountIdB,
        account_address_a: accountAddressA,
        account_address_b: accountAddressB,
        owner_hash: ownerHash,
        verifier_pubkey: verifierPubkey,
      },
      oracle_recovery_ticket: {
        txid: recoveryTx,
        request_id: String(recoveryRequestId),
        compact_ticket: compact,
      },
      submit_a: {
        txid: submitATx,
        pending_recovery: pendingA,
      },
      wrong_account_testinvoke: {
        state: wrongAccountTest.state,
        exception: wrongAccountTest.exception || null,
        stack: wrongAccountTest.stack,
      },
      pending_b: pendingB,
    };

    const markdownReport = [
      '# N3 AA Recovery Cross-Account Boundary',
      '',
      `Date: ${generatedAt}`,
      '',
      '## Scope',
      '',
      'This probe deploys a disposable MorpheusSocialRecoveryVerifier on Neo N3 testnet, requests a compact NeoDID recovery ticket for account A, submits it successfully to account A, and then attempts to replay the same ticket against account B.',
      '',
      '## Result',
      '',
      `- Recovery verifier hash: \`${verifier.hash}\``,
      `- Oracle recovery request id: \`${recoveryRequestId}\``,
      `- Submit A tx: \`${submitATx}\``,
      `- Wrong-account testInvoke state: \`${wrongAccountTest.state}\``,
      wrongAccountTest.exception
        ? `- Wrong-account exception: \`${wrongAccountTest.exception}\``
        : null,
      '',
      '## Conclusion',
      '',
      'The ticket bound to account A cannot be replayed against account B if the verifier preserves account-specific digest binding.',
      '',
    ]
      .filter(Boolean)
      .join('\n');

    const artifacts = await writeValidationArtifacts({
      baseName: 'n3-aa-recovery-cross-account-boundary',
      network: 'testnet',
      generatedAt,
      jsonReport,
      markdownReport,
    });

    console.log(
      JSON.stringify(
        {
          ...artifacts,
          recovery_verifier_hash: verifier.hash,
          recovery_request_id: String(recoveryRequestId),
          wrong_account_state: wrongAccountTest.state,
          wrong_account_exception: wrongAccountTest.exception || null,
        },
        null,
        2
      )
    );
  } finally {
    await fs.rm(compiled.tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  const message = error?.stack || error?.message || String(error);
  if (/spawn phala ENOENT/i.test(message)) {
    writeSkippedValidationArtifacts({
      baseName: 'n3-aa-recovery-cross-account-boundary',
      network: 'testnet',
      title: 'N3 AA Recovery Cross-Account Boundary',
      reason: 'phala-cli-not-installed',
      details: { error: message },
    })
      .then((artifacts) => {
        console.log(JSON.stringify({ ...artifacts, skipped: true, error: message }, null, 2));
        process.exit(0);
      })
      .catch((artifactError) => {
        console.error(artifactError?.stack || artifactError?.message || String(artifactError));
        process.exit(1);
      });
    return;
  }
  console.error(message);
  process.exit(1);
});
