import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { experimental, rpc as neoRpc, sc, tx, wallet } from '@cityofzion/neon-js';
import { createRelayerConfig } from '../../workers/morpheus-relayer/src/config.js';
import { processAutomationJobs } from '../../workers/morpheus-relayer/src/automation.js';
import { patchAutomationJob } from '../../workers/morpheus-relayer/src/persistence.js';
import {
  approveAutomationSpendIfSupported,
  encodeUtf8Base64,
  loadExampleEnv,
  normalizeHash160,
  readDeploymentRegistry,
  repoRoot,
  resolveNeoN3SignerWif,
  resolveNeoN3NetworkMagic,
  sleep,
  trimString,
  tryParseJson,
  writeValidationArtifacts,
  withRetries,
} from './common.mjs';

const execFileAsync = promisify(execFile);
const GAS_HASH = '0xd2a4cff31913016155e38e474a2c06d08be276cf';
const ZERO_HASH = '0x0000000000000000000000000000000000000000';
const EXAMPLE_BUILD_DIR = path.resolve(repoRoot, 'examples/build/n3');
const EXAMPLE_CONSUMER_ARTIFACT = 'UserConsumerN3OracleExample';

function assertCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
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
    result_json: tryParseJson(resultText),
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

async function loadContractArtifacts(baseName, buildDir = EXAMPLE_BUILD_DIR) {
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

async function deployContract(rpcClient, account, rpcUrl, networkMagic, baseName, suffix) {
  const { nef, manifestJson } = await loadContractArtifacts(baseName);
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

async function deployProbeMiniApp({
  rpcClient,
  account,
  rpcUrl,
  networkMagic,
  oracleHash,
  appAdminHash,
}) {
  const suffix = Date.now().toString(36);
  const appId = `autoex_${suffix}`;
  const consumer = await deployContract(
    rpcClient,
    account,
    rpcUrl,
    networkMagic,
    EXAMPLE_CONSUMER_ARTIFACT,
    suffix
  );

  const signers = [new tx.Signer({ account: account.scriptHash, scopes: tx.WitnessScope.Global })];
  const oracleContract = new experimental.SmartContract(oracleHash, {
    rpcAddress: rpcUrl,
    networkMagic,
    account,
  });
  const consumerContract = new experimental.SmartContract(consumer.hash, {
    rpcAddress: rpcUrl,
    networkMagic,
    account,
  });
  const setOracleTxid = await consumerContract.invoke(
    'setOracle',
    [sc.ContractParam.hash160(oracleHash)],
    signers
  );
  assertHalt(await waitForApplicationLog(rpcClient, setOracleTxid), 'setOracle');
  const registerMiniAppTxid = await oracleContract.invoke(
    'registerMiniApp',
    [
      sc.ContractParam.string(appId),
      sc.ContractParam.hash160(appAdminHash),
      sc.ContractParam.hash160(ZERO_HASH),
      sc.ContractParam.hash160(consumer.hash),
      sc.ContractParam.string('morpheus://validation/automation-deposit-exhaustion'),
      sc.ContractParam.string(''),
    ],
    signers
  );
  assertHalt(await waitForApplicationLog(rpcClient, registerMiniAppTxid), 'registerMiniApp');
  const grantOracleFetchTxid = await oracleContract.invoke(
    'grantModuleToMiniApp',
    [sc.ContractParam.string(appId), sc.ContractParam.string('oracle.fetch')],
    signers
  );
  assertHalt(await waitForApplicationLog(rpcClient, grantOracleFetchTxid), 'grantModuleToMiniApp');
  // automation_register requests route to automation.run, which the app must hold.
  const grantAutomationTxid = await oracleContract.invoke(
    'grantModuleToMiniApp',
    [sc.ContractParam.string(appId), sc.ContractParam.string('automation.run')],
    signers
  );
  assertHalt(
    await waitForApplicationLog(rpcClient, grantAutomationTxid),
    'grantModuleToMiniApp automation.run'
  );

  return {
    app_id: appId,
    fee_payer: ZERO_HASH,
    consumer_hash: consumer.hash,
    deploy_txid: consumer.txid,
    set_oracle_txid: setOracleTxid,
    register_miniapp_txid: registerMiniAppTxid,
    grant_oracle_fetch_txid: grantOracleFetchTxid,
    grant_automation_txid: grantAutomationTxid,
  };
}

async function contractSupportsMethod(rpcClient, contractHash, name, arity) {
  const state = await rpcClient.getContractState(contractHash);
  return Boolean(
    state?.manifest?.abi?.methods?.some(
      (method) => method.name === name && method.parameters?.length === arity
    )
  );
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
    if (decoded && (decoded.request_type || decoded.result_text || decoded.error_text))
      return decoded;
    await sleep(2000);
  }
  throw new Error(`timed out waiting for callback ${requestId}`);
}

async function fetchAutomationRecord(baseUrl, apiKey, automationId, network = 'testnet') {
  const headers = {
    apikey: apiKey,
    authorization: `Bearer ${apiKey}`,
    accept: 'application/json',
  };

  const jobUrl = new URL(`${baseUrl.replace(/\/$/, '')}/rest/v1/morpheus_automation_jobs`);
  jobUrl.searchParams.set('select', '*');
  jobUrl.searchParams.set('network', `eq.${network}`);
  jobUrl.searchParams.set('automation_id', `eq.${automationId}`);
  jobUrl.searchParams.set('limit', '1');
  const jobRows = await fetch(jobUrl, { headers }).then((response) =>
    response.ok ? response.json() : []
  );

  const runsUrl = new URL(`${baseUrl.replace(/\/$/, '')}/rest/v1/morpheus_automation_runs`);
  runsUrl.searchParams.set('select', '*');
  runsUrl.searchParams.set('network', `eq.${network}`);
  runsUrl.searchParams.set('automation_id', `eq.${automationId}`);
  runsUrl.searchParams.set('order', 'created_at.asc');
  const runRows = await fetch(runsUrl, { headers }).then((response) =>
    response.ok ? response.json() : []
  );

  return {
    job: Array.isArray(jobRows) ? jobRows[0] || null : null,
    runs: Array.isArray(runRows) ? runRows : [],
  };
}

async function waitForExhaustionRecords(baseUrl, apiKey, automationIds, timeoutMs = 60000) {
  const startedAt = Date.now();
  let last = null;
  while (Date.now() - startedAt < timeoutMs) {
    const records = await Promise.all(
      automationIds.map((automationId) =>
        fetchAutomationRecord(baseUrl, apiKey, automationId, 'testnet')
      )
    );
    const queuedRuns = records.flatMap((record) =>
      record.runs.filter((item) => item.status === 'queued')
    );
    const failedRuns = records.flatMap((record) =>
      record.runs.filter((item) => item.status === 'failed')
    );
    last = { records, queuedRuns, failedRuns };
    if (
      queuedRuns.length === 1 &&
      failedRuns.some((item) => /request fee not paid/i.test(String(item.error || ''))) &&
      failedRuns.some((item) => /automation spend not approved/i.test(String(item.error || '')))
    ) {
      return last;
    }
    await sleep(2000);
  }
  return last;
}

async function cancelExhaustionProbeJobs(baseUrl, apiKey, reason) {
  const headers = {
    apikey: apiKey,
    authorization: `Bearer ${apiKey}`,
    accept: 'application/json',
    'content-type': 'application/json',
    prefer: 'return=representation',
  };
  const url = new URL(`${baseUrl.replace(/\/$/, '')}/rest/v1/morpheus_automation_jobs`);
  url.searchParams.set('network', 'eq.testnet');
  url.searchParams.set('execution_payload->>tag', 'in.(exhaustion-a,exhaustion-b,exhaustion-c)');
  url.searchParams.set('status', 'in.(active,paused,processing,error)');
  const response = await fetch(url, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({
      status: 'cancelled',
      next_run_at: null,
      last_error: reason,
      updated_at: new Date().toISOString(),
    }),
  });
  if (!response.ok) {
    throw new Error(`failed to cancel stale exhaustion jobs: ${response.status} ${await response.text()}`);
  }
  return response.json().catch(() => []);
}

async function runRemoteCommand(command, { appId, phalaApiToken }) {
  const attempts = [
    trimString(phalaApiToken)
      ? ['ssh', '--api-token', phalaApiToken, appId, '--', `sh -lc ${shellQuote(command)}`]
      : null,
    ['ssh', appId, '--', `sh -lc ${shellQuote(command)}`],
  ].filter(Boolean);

  let lastError = null;
  for (const args of attempts) {
    try {
      const { stdout } = await execFileAsync('phala', args, {
        maxBuffer: 10 * 1024 * 1024,
      });
      return stdout;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error('failed to execute remote phala ssh command');
}

async function getCvmStatus(appId) {
  const { stdout } = await execFileAsync('phala', ['cvms', 'get', appId], {
    maxBuffer: 10 * 1024 * 1024,
  });
  const match = stdout.match(/│\s*Status\s*│\s*([^│\n]+)\s*│/);
  if (!match) {
    throw new Error(`unexpected phala cvms get output: ${stdout}`);
  }
  return trimString(match[1]);
}

async function waitForCvmStatus(appId, targetStatus, timeoutMs = 180000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const status = await getCvmStatus(appId);
    if (status === targetStatus) return;
    await sleep(3000);
  }
  throw new Error(`timed out waiting for CVM status=${targetStatus}`);
}

async function waitForContainersRunning(appId, timeoutMs = 300000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const { stdout } = await execFileAsync('phala', ['ps', appId], {
        maxBuffer: 10 * 1024 * 1024,
      });
      const relayerRunning = /morpheus-relayer.*running/i.test(stdout);
      const workerRunning = /nitro-worker.*running/i.test(stdout);
      if (relayerRunning && workerRunning) return;
    } catch {}
    await sleep(3000);
  }
  throw new Error('timed out waiting for Morpheus containers to become running');
}

async function stopCvm(appId) {
  await execFileAsync('phala', ['cvms', 'stop', appId], {
    maxBuffer: 10 * 1024 * 1024,
  }).catch((error) => {
    const message = String(error?.stderr || error?.stdout || error?.message || error);
    if (!/already in progress/i.test(message)) throw error;
  });
  await waitForCvmStatus(appId, 'stopped');
}

async function startCvm(appId) {
  await execFileAsync('phala', ['cvms', 'start', appId], {
    maxBuffer: 10 * 1024 * 1024,
  }).catch((error) => {
    const message = String(error?.stderr || error?.stdout || error?.message || error);
    if (!/already in progress/i.test(message)) throw error;
  });
  await waitForContainersRunning(appId);
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
  try {
    const pid = await findRelayerLoopPid({ appId, phalaApiToken });
    assertCondition(pid, 'morpheus relayer loop pid not found on testnet CVM');
    await runRemoteCommand(`kill -s STOP ${pid}`, { appId, phalaApiToken });
    await waitForRelayerState({ appId, phalaApiToken, pid, shouldBeRunning: false });
    return { mode: 'signal', pid };
  } catch {
    await stopCvm(appId);
    return { mode: 'cvm' };
  }
}

async function startRelayer({ appId, phalaApiToken, handle }) {
  if (!handle) return;
  if (handle.mode === 'cvm') {
    await startCvm(appId);
    return;
  }
  if (!trimString(handle.pid)) return;
  await runRemoteCommand(`kill -s CONT ${handle.pid}`, { appId, phalaApiToken });
  await waitForRelayerState({ appId, phalaApiToken, pid: handle.pid, shouldBeRunning: true });
}

async function readFeeCredit(rpcClient, oracleHash, accountHash) {
  return BigInt(
    (await invokeRead(rpcClient, oracleHash, 'feeCreditOf', [
      { type: 'Hash160', value: accountHash },
    ])) || '0'
  );
}

// The requester deposits GAS for its own credit (OnNEP17Payment credits the sender) and
// waits until exactly that amount landed.
async function depositOwnCredit({ requester, rpcUrl, networkMagic, rpcClient, oracleHash, amount }) {
  const requesterHash = `0x${requester.scriptHash}`;
  const before = await readFeeCredit(rpcClient, oracleHash, requesterHash);
  const gas = new experimental.SmartContract(GAS_HASH, {
    rpcAddress: rpcUrl,
    networkMagic,
    account: requester,
  });
  const txid = await gas.invoke('transfer', [
    sc.ContractParam.hash160(requesterHash),
    sc.ContractParam.hash160(oracleHash),
    sc.ContractParam.integer(amount.toString()),
    sc.ContractParam.any(null),
  ]);
  assertHalt(await waitForApplicationLog(rpcClient, txid), 'requester credit deposit');
  const after = await readFeeCredit(rpcClient, oracleHash, requesterHash);
  assertCondition(
    after === before + amount,
    `requester credit moved from ${before} to ${after}, expected +${amount}`
  );
  return { txid, before: before.toString(), after: after.toString() };
}

async function fundRequesterGas({ account, requester, rpcUrl, networkMagic, rpcClient, amount }) {
  const gas = new experimental.SmartContract(GAS_HASH, {
    rpcAddress: rpcUrl,
    networkMagic,
    account,
  });
  const txid = await gas.invoke('transfer', [
    sc.ContractParam.hash160(`0x${account.scriptHash}`),
    sc.ContractParam.hash160(`0x${requester.scriptHash}`),
    sc.ContractParam.integer(amount.toString()),
    sc.ContractParam.any(null),
  ]);
  assertHalt(await waitForApplicationLog(rpcClient, txid), 'requester GAS funding');
  return txid;
}

async function main() {
  await loadExampleEnv();
  const networkConfig = JSON.parse(
    await fs.readFile(path.resolve(repoRoot, 'config/networks/testnet.json'), 'utf8')
  );
  const deployment = (await readDeploymentRegistry('testnet')).neo_n3 || {};
  const rpcUrl = trimString(deployment.rpc_url || 'https://testnet1.neo.coz.io:443');
  const networkMagic = resolveNeoN3NetworkMagic('testnet', deployment);
  const signerWif = resolveNeoN3SignerWif('testnet');
  const oracleHash = normalizeHash160(deployment.oracle_hash || '');
  const supabaseUrl = trimString(
    process.env.SUPABASE_URL || process.env.morpheus_SUPABASE_URL || ''
  );
  const serviceRoleKey = trimString(
    process.env.SUPABASE_SECRET_KEY ||
      process.env.morpheus_SUPABASE_SECRET_KEY ||
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.morpheus_SUPABASE_SERVICE_ROLE_KEY ||
      ''
  );
  const phalaApiToken = trimString(
    process.env.PHALA_API_TOKEN || process.env.PHALA_SHARED_SECRET || ''
  );
  const appId = trimString(
    networkConfig?.phala?.cvm_id || process.env.MORPHEUS_PAYMASTER_APP_ID || ''
  );

  assertCondition(signerWif, 'testnet signer WIF is required');
  assertCondition(oracleHash, 'testnet oracle hash is required');
  assertCondition(supabaseUrl && serviceRoleKey, 'Supabase secret or service-role env is required');
  assertCondition(phalaApiToken && appId, 'Phala API token and CVM id are required');

  const account = new wallet.Account(signerWif);
  const rpcClient = new neoRpc.RPCClient(rpcUrl);
  const probeOperatorHash = `0x${account.scriptHash}`;
  assertCondition(
    await contractSupportsMethod(rpcClient, oracleHash, 'registerMiniApp', 6),
    'testnet oracle deployment is legacy_callback and lacks registerMiniApp/6; upgrade the testnet MorpheusOracle before running isolated MiniApp automation fee exhaustion validation'
  );
  // R-01: a requester's credit pays an automation execution only under its own approval for
  // that job. This probe validates that generation; against an older kernel the updater
  // lane charged the named requester with no approval at all.
  assertCondition(
    (await contractSupportsMethod(rpcClient, oracleHash, 'approveAutomationSpend', 3)) &&
      (await contractSupportsMethod(rpcClient, oracleHash, 'queueAutomationExecution', 4)),
    'testnet oracle lacks the automation spend approval lane (approveAutomationSpend/3, queueAutomationExecution/4); upgrade the testnet MorpheusOracle first (docs/security/ORACLE-INTEGRATION-WITNESS-20260928.md)'
  );
  const staleProbeCleanup = await cancelExhaustionProbeJobs(
    supabaseUrl,
    serviceRoleKey,
    `cancelled stale deposit exhaustion probes before ${new Date().toISOString()}`
  );
  const probeMiniApp = await deployProbeMiniApp({
    rpcClient,
    account,
    rpcUrl,
    networkMagic,
    oracleHash,
    appAdminHash: probeOperatorHash,
  });
  const resolvedConsumerHash = normalizeHash160(probeMiniApp.consumer_hash);
  const requestFee = BigInt((await invokeRead(rpcClient, oracleHash, 'requestFee', [])) || '0');
  assertCondition(requestFee > 0n, 'the probe needs a non-zero request fee');

  // A fresh requester that owns its jobs: it signs the registrations and the approvals, and
  // its credit is the shared pool the two approved jobs draw on.
  const requester = new wallet.Account(wallet.generatePrivateKey());
  const requesterHash = `0x${requester.scriptHash}`;
  const requesterGasTxid = await fundRequesterGas({
    account,
    requester,
    rpcUrl,
    networkMagic,
    rpcClient,
    amount: 10n * 100_000_000n,
  });
  const consumer = new experimental.SmartContract(resolvedConsumerHash, {
    rpcAddress: rpcUrl,
    networkMagic,
    account: requester,
  });
  // The consumer calls the kernel's direct lane, which checks the requester's witness in the
  // kernel, so the requester signs with a scope that reaches it.
  const signers = [new tx.Signer({ account: requester.scriptHash, scopes: tx.WitnessScope.Global })];

  const buildPayload = (label) =>
    JSON.stringify({
      trigger: {
        type: 'interval',
        interval_ms: 300000,
        start_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      },
      execution: {
        request_type: 'privacy_oracle',
        payload: {
          provider: 'twelvedata',
          symbol: 'TWELVEDATA:NEO-USD',
          json_path: 'price',
          target_chain: 'neo_n3',
          tag: label,
        },
      },
    });

  const registerOne = async (label) => {
    const txid = await consumer.invoke(
      'requestRaw',
      ['automation_register', sc.ContractParam.byteArray(encodeUtf8Base64(buildPayload(label)))],
      signers
    );
    const requestId = await waitForRequestId(rpcClient, txid);
    return {
      label,
      txid,
      request_id: String(requestId),
      callback: null,
      automation_id: '',
      spend_approval: null,
    };
  };

  const registrationPauseHandle = await stopRelayer({ appId, phalaApiToken });
  let registrations;
  let registrationDeposit;
  try {
    // The probe app has no fee payer, so each registration is the requester's own
    // witnessed spend: deposit exactly three fees and spend them on three registrations.
    registrationDeposit = await depositOwnCredit({
      requester,
      rpcUrl,
      networkMagic,
      rpcClient,
      oracleHash,
      amount: requestFee * 3n,
    });
    registrations = [
      await registerOne('exhaustion-a'),
      await registerOne('exhaustion-b'),
      await registerOne('exhaustion-c'),
    ];
  } finally {
    await startRelayer({ appId, phalaApiToken, handle: registrationPauseHandle }).catch(() => {});
  }
  const [registrationA, registrationB, registrationC] = registrations;

  for (const registration of registrations) {
    registration.callback = await waitForCallback(
      rpcClient,
      resolvedConsumerHash,
      registration.request_id,
      180000
    );
    assertCondition(
      registration.callback?.success === true,
      `automation register callback should succeed for ${registration.label}`
    );
    registration.automation_id = trimString(
      registration.callback.result_json?.result?.automation_id ||
        registration.callback.result_json?.automation_id ||
        ''
    );
    assertCondition(
      registration.automation_id,
      `automation register callback did not return automation_id for ${registration.label}`
    );
    const onChain = await invokeRead(rpcClient, oracleHash, 'getRequest', [
      { type: 'Integer', value: registration.request_id },
    ]);
    assertCondition(
      normalizeHash160(onChain?.[5] || '') === normalizeHash160(requesterHash),
      `${registration.label} was not registered by the probe requester`
    );
  }

  // A and B carry the requester's approval (cap: one fee each, one hour); C carries none.
  const approvalExpiresAtMs = Date.now() + 60 * 60 * 1000;
  for (const registration of [registrationA, registrationB]) {
    registration.spend_approval = await approveAutomationSpendIfSupported({
      rpcUrl,
      networkMagic,
      oracleHash,
      account: requester,
      registrationRequestId: registration.request_id,
      cap: requestFee,
      expiresAtMs: approvalExpiresAtMs,
    });
    assertCondition(
      registration.spend_approval.supported === true,
      `approveAutomationSpend was not available for ${registration.label}`
    );
  }

  const pausedRelayerHandle = await stopRelayer({ appId, phalaApiToken });
  try {
    const poolDeposit = await depositOwnCredit({
      requester,
      rpcUrl,
      networkMagic,
      rpcClient,
      oracleHash,
      amount: requestFee,
    });
    const creditBeforeQueue = await readFeeCredit(rpcClient, oracleHash, requesterHash);
    assertCondition(
      creditBeforeQueue === requestFee,
      `expected exactly one request fee on the requester before queueing, got ${creditBeforeQueue}`
    );

    for (const registration of registrations) {
      await patchAutomationJob(registration.automation_id, {
        status: 'active',
        next_run_at: new Date(0).toISOString(),
        execution_count: 0,
        last_error: null,
      });
    }

    process.env.MORPHEUS_NETWORK = 'testnet';
    process.env.MORPHEUS_AUTOMATION_BATCH_SIZE = '200';
    process.env.MORPHEUS_AUTOMATION_MAX_QUEUED_PER_TICK = '200';
    process.env.NEO_RPC_URL = rpcUrl;
    process.env.NEO_NETWORK_MAGIC = String(networkMagic);
    process.env.CONTRACT_MORPHEUS_ORACLE_HASH = oracleHash;
    process.env.NEO_TESTNET_WIF = signerWif;
    process.env.MORPHEUS_RELAYER_NEO_N3_WIF = signerWif;

    const config = createRelayerConfig();
    const targetJobs = (
      await Promise.all(
        registrations.map((registration) =>
          fetchAutomationRecord(supabaseUrl, serviceRoleKey, registration.automation_id, 'testnet')
        )
      )
    )
      .map((record) => record.job)
      .filter(Boolean);
    assertCondition(targetJobs.length === 3, 'expected all three target automation jobs before the tick');
    const localTick = await processAutomationJobs(config, { info() {}, warn() {} }, {
      fetchActiveAutomationJobs: async () => targetJobs,
    });
    const automationIds = registrations.map((registration) => registration.automation_id);
    const outcome = await waitForExhaustionRecords(supabaseUrl, serviceRoleKey, automationIds);
    const records =
      outcome?.records ||
      (await Promise.all(
        automationIds.map((automationId) =>
          fetchAutomationRecord(supabaseUrl, serviceRoleKey, automationId, 'testnet')
        )
      ));
    const [recordA, recordB, recordC] = records;
    const queuedRuns = records.flatMap((record) =>
      record.runs.filter((item) => item.status === 'queued')
    );
    const failedRuns = records.flatMap((record) =>
      record.runs.filter((item) => item.status === 'failed')
    );

    assertCondition(
      queuedRuns.length === 1,
      `expected exactly one queued automation run, got ${queuedRuns.length}`
    );
    assertCondition(
      [registrationA.automation_id, registrationB.automation_id].includes(
        queuedRuns[0].automation_id
      ),
      'the queued run must belong to an approved job'
    );
    assertCondition(
      trimString(queuedRuns[0]?.queue_tx?.queue_method || '') === 'queueAutomationExecution',
      'the queued run must use the approval lane (queueAutomationExecution)'
    );
    assertCondition(
      recordC.runs.some(
        (item) =>
          item.status === 'failed' && /automation spend not approved/i.test(String(item.error || ''))
      ),
      'the unapproved job must fail with automation spend not approved'
    );
    assertCondition(
      failedRuns.some((item) => /request fee not paid/i.test(String(item.error || ''))),
      'the second approved job must fail with request fee not paid once the pool is spent'
    );

    const creditAfterQueue = await readFeeCredit(rpcClient, oracleHash, requesterHash);
    assertCondition(
      creditAfterQueue === 0n,
      `expected the requester pool to hold 0 after one queue, got ${creditAfterQueue}`
    );
    const approvals = {};
    for (const registration of registrations) {
      const approval = await invokeRead(rpcClient, oracleHash, 'getAutomationSpendApproval', [
        { type: 'Integer', value: registration.request_id },
      ]);
      approvals[registration.label] = {
        cap: String(approval?.[3] ?? '0'),
        spent: String(approval?.[4] ?? '0'),
        expires_at_ms: String(approval?.[5] ?? '0'),
      };
    }
    const spentTotal =
      BigInt(approvals['exhaustion-a'].spent) + BigInt(approvals['exhaustion-b'].spent);
    assertCondition(
      spentTotal === requestFee,
      `approved spend should total one fee, got ${spentTotal}`
    );
    assertCondition(
      approvals['exhaustion-c'].cap === '0' && approvals['exhaustion-c'].spent === '0',
      'the unapproved job must have no approval and no recorded spend'
    );

    await startRelayer({ appId, phalaApiToken, handle: pausedRelayerHandle });
    const queuedTxHash = trimString(queuedRuns[0]?.queue_tx?.tx_hash || '');
    assertCondition(queuedTxHash, 'queued automation run did not record queue tx hash');
    const queuedChainRequestId = await waitForRequestId(rpcClient, queuedTxHash, 90000);
    const queuedCallback = await waitForCallback(
      rpcClient,
      resolvedConsumerHash,
      queuedChainRequestId,
      180000
    );
    assertCondition(
      queuedCallback?.success === true,
      'the single funded automation execution should fulfill successfully'
    );
    const finalProbeCleanup = await cancelExhaustionProbeJobs(
      supabaseUrl,
      serviceRoleKey,
      `cancelled completed deposit exhaustion probes after ${new Date().toISOString()}`
    );

    const generatedAt = new Date().toISOString();
    const jsonReport = {
      generated_at: generatedAt,
      network: 'testnet',
      rpc_url: rpcUrl,
      network_magic: networkMagic,
      oracle_hash: oracleHash,
      probe_miniapp: probeMiniApp,
      requester_hash: requesterHash,
      requester_gas_txid: requesterGasTxid,
      callback_consumer_hash: resolvedConsumerHash,
      request_fee: requestFee.toString(),
      stale_probe_cleanup_count: Array.isArray(staleProbeCleanup) ? staleProbeCleanup.length : 0,
      final_probe_cleanup_count: Array.isArray(finalProbeCleanup) ? finalProbeCleanup.length : 0,
      registration_deposit: registrationDeposit,
      pool_deposit: poolDeposit,
      credit_before_queue: creditBeforeQueue.toString(),
      credit_after_queue: creditAfterQueue.toString(),
      registrations,
      approvals,
      local_tick: localTick,
      automation_records: {
        [registrationA.automation_id]: recordA,
        [registrationB.automation_id]: recordB,
        [registrationC.automation_id]: recordC,
      },
      queued_runs: queuedRuns,
      failed_runs: failedRuns,
      queued_chain_request_id: String(queuedChainRequestId),
      queued_callback: queuedCallback,
    };

    const markdownReport = [
      '# N3 Automation Deposit Exhaustion Validation',
      '',
      `Date: ${generatedAt}`,
      '',
      '## Scope',
      '',
      'One requester registers three due automation jobs and signs a spend approval (cap one fee, one hour) for two of them. Its credit pool then holds exactly one request fee before a local scheduler tick.',
      '',
      '## Result',
      '',
      `- Requester hash: \`${requesterHash}\``,
      `- Probe miniapp: \`${probeMiniApp.app_id}\``,
      `- Request fee: \`${requestFee}\``,
      `- Credit before queue: \`${creditBeforeQueue}\``,
      `- Credit after queue: \`${creditAfterQueue}\``,
      `- Queued runs: \`${queuedRuns.length}\``,
      `- Failed runs: \`${failedRuns.length}\``,
      `- Stale probe cleanup: \`${Array.isArray(staleProbeCleanup) ? staleProbeCleanup.length : 0}\``,
      `- Final probe cleanup: \`${Array.isArray(finalProbeCleanup) ? finalProbeCleanup.length : 0}\``,
      queuedTxHash ? `- Queued tx: \`${queuedTxHash}\`` : null,
      queuedChainRequestId ? `- Queued chain request id: \`${queuedChainRequestId}\`` : null,
      '',
      '## Conclusion',
      '',
      '- The scheduler queued exactly one execution, through `queueAutomationExecution` under that job’s approval.',
      '- The second approved job did not overrun the pool; it failed with `request fee not paid`.',
      '- The job without an approval was not charged; it failed with `automation spend not approved`.',
      '- The funded queued execution still fulfilled successfully after the relayer resumed.',
      '',
    ]
      .filter(Boolean)
      .join('\n');

    const artifacts = await writeValidationArtifacts({
      baseName: 'n3-automation-deposit-exhaustion',
      network: 'testnet',
      generatedAt,
      jsonReport,
      markdownReport,
    });

    console.log(
      JSON.stringify(
        {
          ...artifacts,
          queued_runs: queuedRuns.length,
          failed_runs: failedRuns.length,
          queued_chain_request_id: String(queuedChainRequestId),
          failed_errors: failedRuns.map((item) => item.error || null),
        },
        null,
        2
      )
    );
  } finally {
    await startRelayer({ appId, phalaApiToken, handle: pausedRelayerHandle }).catch(() => {});
  }
}

main().catch((error) => {
  const message = error?.stack || error?.message || String(error);
  console.error(message);
  process.exit(1);
});
