import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { experimental, rpc as neoRpc, sc, tx, wallet } from '@cityofzion/neon-js';
import { createRelayerConfig } from '../../workers/morpheus-relayer/src/config.js';
import { processAutomationJobs } from '../../workers/morpheus-relayer/src/automation.js';
import { patchAutomationJob } from '../../workers/morpheus-relayer/src/persistence.js';
import {
  DEFAULT_REMOTE_COMMAND_TIMEOUT_MS,
  encodeUtf8Base64,
  logValidationStep,
  loadExampleEnv,
  normalizeHash160,
  readDeploymentRegistry,
  repoRoot,
  resolvePhalaCliInvocation,
  resolveNeoN3SignerWif,
  sleep,
  trimString,
  tryParseJson,
  writeValidationArtifacts,
  writeSkippedValidationArtifacts,
  withRetries,
} from './common.mjs';

const execFileAsync = promisify(execFile);
const GAS_HASH = '0xd2a4cff31913016155e38e474a2c06d08be276cf';
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

async function ensureFeeCredit(
  account,
  rpcUrl,
  networkMagic,
  rpcClient,
  oracleHash,
  payerHash,
  requiredRequests
) {
  const currentCredit = BigInt(
    (await invokeRead(rpcClient, oracleHash, 'feeCreditOf', [
      { type: 'Hash160', value: payerHash },
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
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const updatedCredit = BigInt(
      (await invokeRead(rpcClient, oracleHash, 'feeCreditOf', [
        { type: 'Hash160', value: payerHash },
      ])) || '0'
    );
    if (updatedCredit >= requiredCredit) {
      return {
        request_fee: requestFee.toString(),
        current_credit: updatedCredit.toString(),
        deposit_amount: deficit.toString(),
        txid,
      };
    }
    await sleep(2000);
  }
  throw new Error('timed out waiting for Neo N3 automation fee credit');
}

async function fetchAutomationRecord(baseUrl, apiKey, automationId, network = 'testnet') {
  const headers = { apikey: apiKey, authorization: `Bearer ${apiKey}`, accept: 'application/json' };
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

async function waitForQueuedRun(
  baseUrl,
  apiKey,
  automationId,
  network = 'testnet',
  timeoutMs = 30000
) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const record = await fetchAutomationRecord(baseUrl, apiKey, automationId, network);
    const queuedRuns = record.runs.filter((row) => row.status === 'queued');
    if (queuedRuns.length > 0) return { record, queuedRuns };
    await sleep(2000);
  }
  return {
    record: await fetchAutomationRecord(baseUrl, apiKey, automationId, network),
    queuedRuns: [],
  };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

async function runRemoteCommand(command, { appId, phalaApiToken }) {
  const phalaCli = resolvePhalaCliInvocation();
  logValidationStep('remote_command', {
    script: 'test-n3-automation-cancel-race',
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

async function getCvmStatus(appId) {
  const phalaCli = resolvePhalaCliInvocation();
  const { stdout } = await execFileAsync(phalaCli.command, [...phalaCli.argsPrefix, 'cvms', 'get', appId], {
    maxBuffer: 10 * 1024 * 1024,
    timeout: REMOTE_COMMAND_TIMEOUT_MS,
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
    if (status === targetStatus) {
      return status;
    }
    await sleep(3000);
  }
  throw new Error(`timed out waiting for CVM status=${targetStatus}`);
}

async function waitForContainersRunning(appId, timeoutMs = 300000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const phalaCli = resolvePhalaCliInvocation();
      const { stdout } = await execFileAsync(phalaCli.command, [...phalaCli.argsPrefix, 'ps', appId], {
        maxBuffer: 10 * 1024 * 1024,
        timeout: REMOTE_COMMAND_TIMEOUT_MS,
      });
      const relayerRunning = /dstack-morpheus-relayer-1.*running/i.test(stdout);
      const workerRunning = /nitro-worker.*running/i.test(stdout);
      if (relayerRunning && workerRunning) return;
    } catch {}
    await sleep(3000);
  }
  throw new Error('timed out waiting for Morpheus containers to become running');
}

async function stopCvm(appId) {
  const phalaCli = resolvePhalaCliInvocation();
  await execFileAsync(phalaCli.command, [...phalaCli.argsPrefix, 'cvms', 'stop', appId], {
    maxBuffer: 10 * 1024 * 1024,
    timeout: REMOTE_COMMAND_TIMEOUT_MS,
  }).catch((error) => {
    const message = String(error?.stderr || error?.stdout || error?.message || error);
    if (!/already in progress/i.test(message)) throw error;
  });
  await waitForCvmStatus(appId, 'stopped');
}

async function startCvm(appId) {
  const phalaCli = resolvePhalaCliInvocation();
  await execFileAsync(phalaCli.command, [...phalaCli.argsPrefix, 'cvms', 'start', appId], {
    maxBuffer: 10 * 1024 * 1024,
    timeout: REMOTE_COMMAND_TIMEOUT_MS,
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

async function main() {
  logValidationStep('boot', { script: 'test-n3-automation-cancel-race' });
  await loadExampleEnv();
  const deployment = (await readDeploymentRegistry('testnet')).neo_n3 || {};
  const rpcUrl = trimString(deployment.rpc_url || 'https://testnet1.neo.coz.io:443');
  const networkMagic = Number(deployment.network_magic || 894710606);
  const signerWif = resolveNeoN3SignerWif('testnet');
  const oracleHash = normalizeHash160(deployment.oracle_hash || '');
  const consumerHash = normalizeHash160(deployment.example_consumer_hash || '');
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
    process.env.MORPHEUS_PAYMASTER_APP_ID || 'ddff154546fe22d15b65667156dd4b7c611e6093'
  );

  assertCondition(signerWif, 'testnet signer WIF is required');
  assertCondition(oracleHash, 'testnet oracle hash is required');
  assertCondition(consumerHash, 'testnet example consumer hash is required');
  assertCondition(supabaseUrl && serviceRoleKey, 'Supabase secret or service-role env is required');
  assertCondition(phalaApiToken && appId, 'Phala API token and CVM id are required');
  logValidationStep('config', {
    network: 'testnet',
    rpc_url: rpcUrl,
    oracle_hash: oracleHash,
    consumer_hash: consumerHash,
    phala_app_id: appId,
  });

  const account = new wallet.Account(signerWif);
  const rpcClient = new neoRpc.RPCClient(rpcUrl);
  const requesterHash = `0x${account.scriptHash}`;
  const consumer = new experimental.SmartContract(consumerHash, {
    rpcAddress: rpcUrl,
    networkMagic,
    account,
  });
  const signers = [new tx.Signer({ account: account.scriptHash, scopes: tx.WitnessScope.Global })];

  const initialPauseHandle = await stopRelayer({ appId, phalaApiToken });
  try {
    const feeStatus = await ensureFeeCredit(
      account,
      rpcUrl,
      networkMagic,
      rpcClient,
      oracleHash,
      requesterHash,
      25
    );

    await startRelayer({ appId, phalaApiToken, handle: initialPauseHandle });
    const intervalPayload = JSON.stringify({
      trigger: {
        type: 'interval',
        interval_ms: 300000,
        start_at: new Date(Date.now() + 30 * 60_000).toISOString(),
      },
      execution: {
        request_type: 'privacy_oracle',
        payload: {
          provider: 'twelvedata',
          symbol: 'TWELVEDATA:NEO-USD',
          json_path: 'price',
          target_chain: 'neo_n3',
        },
      },
    });

    const registerTx = await consumer.invoke(
      'requestRaw',
      ['automation_register', sc.ContractParam.byteArray(encodeUtf8Base64(intervalPayload))],
      signers
    );
    const registerRequestId = await waitForRequestId(rpcClient, registerTx);
    const registerCallback = await waitForCallback(
      rpcClient,
      consumerHash,
      registerRequestId,
      180000
    );
    assertCondition(
      registerCallback?.success === true,
      'automation register callback should succeed'
    );
    const automationId = trimString(
      registerCallback.result_json?.result?.automation_id ||
        registerCallback.result_json?.automation_id ||
        ''
    );
    assertCondition(automationId, 'automation register callback did not return automation_id');

    const pausedRelayerHandle = await stopRelayer({ appId, phalaApiToken });
    try {
      await ensureFeeCredit(
        account,
        rpcUrl,
        networkMagic,
        rpcClient,
        oracleHash,
        requesterHash,
        25
      );
      await patchAutomationJob(automationId, {
        status: 'active',
        next_run_at: new Date(0).toISOString(),
        execution_count: 0,
        last_error: null,
      });

      process.env.MORPHEUS_NETWORK = 'testnet';
      process.env.MORPHEUS_AUTOMATION_BATCH_SIZE = '2000';
      process.env.MORPHEUS_AUTOMATION_MAX_QUEUED_PER_TICK = '2000';
      process.env.NEO_RPC_URL = rpcUrl;
      process.env.NEO_NETWORK_MAGIC = String(networkMagic);
      process.env.CONTRACT_MORPHEUS_ORACLE_HASH = oracleHash;
      process.env.NEO_TESTNET_WIF = signerWif;
      process.env.MORPHEUS_RELAYER_NEO_N3_WIF = signerWif;

      const config = createRelayerConfig();
      const localTick = await processAutomationJobs(config, { info() {}, warn() {} });
      const { record: queuedRecord, queuedRuns } = await waitForQueuedRun(
        supabaseUrl,
        serviceRoleKey,
        automationId,
        'testnet'
      );
      assertCondition(
        queuedRuns.length >= 1,
        `expected at least one queued run before cancellation, got ${queuedRuns.length}`
      );

      await patchAutomationJob(automationId, {
        status: 'cancelled',
        next_run_at: null,
        last_error: null,
      });
      const cancelledBeforeResume = await fetchAutomationRecord(
        supabaseUrl,
        serviceRoleKey,
        automationId,
        'testnet'
      );
      const queuedTxHash = trimString(queuedRuns[0]?.queue_tx?.tx_hash || '');
      assertCondition(queuedTxHash, 'queued automation run did not record queue tx hash');
      const queuedChainRequestId = await waitForRequestId(rpcClient, queuedTxHash, 90000);

      await startRelayer({ appId, phalaApiToken, handle: pausedRelayerHandle });
      const callback = await waitForCallback(rpcClient, consumerHash, queuedChainRequestId, 180000);
      const finalRecord = await fetchAutomationRecord(
        supabaseUrl,
        serviceRoleKey,
        automationId,
        'testnet'
      );

      const generatedAt = new Date().toISOString();
      const executedAfterCancel = callback?.success === true;
      const jsonReport = {
        generated_at: generatedAt,
        network: 'testnet',
        rpc_url: rpcUrl,
        network_magic: networkMagic,
        oracle_hash: oracleHash,
        callback_consumer_hash: consumerHash,
        requester_hash: requesterHash,
        fee_status: feeStatus,
        register: {
          txid: registerTx,
          request_id: String(registerRequestId),
          callback: registerCallback,
          automation_id: automationId,
        },
        local_tick: localTick,
        queued_run_count_before_cancel: queuedRuns.length,
        cancelled_before_resume: cancelledBeforeResume,
        queued_request_key: trimString(queuedRuns[0]?.queued_request_id || ''),
        queued_tx_hash: queuedTxHash,
        queued_chain_request_id: String(queuedChainRequestId),
        resumed_callback: callback,
        final_supabase: finalRecord,
        executed_after_cancel: executedAfterCancel,
      };

      const markdownReport = [
        '# N3 Automation Cancellation Race Validation',
        '',
        `Date: ${generatedAt}`,
        '',
        '## Scope',
        '',
        'This probe queues one due interval automation execution, marks the job cancelled before the relayer resumes, and then observes whether the already-queued request still fulfills.',
        '',
        '## Result',
        '',
        `- Automation id: \`${automationId}\``,
        `- Queued runs before cancel: \`${queuedRuns.length}\``,
        `- Queued request key: \`${jsonReport.queued_request_key}\``,
        `- Queued chain request id: \`${jsonReport.queued_chain_request_id}\``,
        `- Cancelled before resume: \`${cancelledBeforeResume?.job?.status}\``,
        `- Executed after cancel: \`${executedAfterCancel}\``,
        callback ? `- Resumed callback success: \`${callback.success}\`` : null,
        callback?.error_text ? `- Resumed callback error: \`${callback.error_text}\`` : null,
        '',
        '## Interpretation',
        '',
        queuedRuns.length > 1
          ? 'More than one queued automation run was observed before cancellation. This indicates a duplicate queue window before the cancellation race is evaluated.'
          : 'Exactly one queued automation run was observed before cancellation.',
        '',
        executedAfterCancel
          ? 'An already-queued automation request still fulfilled after the job was marked cancelled before relayer resume. This is the currently observed cancellation-race behavior.'
          : 'The queued automation request did not fulfill after cancellation. The system failed closed for this race window.',
        '',
      ]
        .filter(Boolean)
        .join('\n');

      const artifacts = await writeValidationArtifacts({
        baseName: 'n3-automation-cancel-race',
        network: 'testnet',
        generatedAt,
        jsonReport,
        markdownReport,
      });

      console.log(
        JSON.stringify(
          {
            ...artifacts,
            automation_id: automationId,
            executed_after_cancel: executedAfterCancel,
            queued_chain_request_id: String(queuedChainRequestId),
          },
          null,
          2
        )
      );
    } finally {
      await startRelayer({ appId, phalaApiToken, handle: pausedRelayerHandle }).catch(() => {});
    }
  } finally {
    await startRelayer({ appId, phalaApiToken, handle: initialPauseHandle }).catch(() => {});
  }
}

main().catch((error) => {
  const message = error?.stack || error?.message || String(error);
  if (/spawn phala ENOENT/i.test(message)) {
    writeSkippedValidationArtifacts({
      baseName: 'n3-automation-cancel-race',
      network: 'testnet',
      title: 'N3 Automation Cancel Race Validation',
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
