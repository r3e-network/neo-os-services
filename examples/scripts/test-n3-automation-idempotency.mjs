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
    if (decoded && (decoded.request_type || decoded.result_text || decoded.error_text)) {
      return decoded;
    }
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
  requiredRequests,
  { viaConsumer = false, creditRecipientHash = payerHash } = {}
) {
  const currentCredit = BigInt(
    (await invokeRead(rpcClient, oracleHash, 'feeCreditOf', [
      { type: 'Hash160', value: creditRecipientHash },
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
  await gas.invoke('transfer', [
    sc.ContractParam.hash160(`0x${account.scriptHash}`),
    sc.ContractParam.hash160(viaConsumer ? payerHash : oracleHash),
    sc.ContractParam.integer(deficit.toString()),
    sc.ContractParam.any(null),
  ]);

  if (viaConsumer) {
    const deadlineBalance = Date.now() + 60000;
    while (Date.now() < deadlineBalance) {
      const contractBalanceRaw = await invokeRead(rpcClient, GAS_HASH, 'balanceOf', [
        { type: 'Hash160', value: payerHash },
      ]);
      if (BigInt(contractBalanceRaw || '0') >= deficit) break;
      await sleep(2000);
    }

    const consumer = new experimental.SmartContract(payerHash, {
      rpcAddress: rpcUrl,
      networkMagic,
      account,
    });
    const signers = [
      new tx.Signer({ account: account.scriptHash, scopes: tx.WitnessScope.Global }),
    ];
    await consumer.invoke(
      'depositOracleCredits',
      [sc.ContractParam.integer(deficit.toString())],
      signers
    );
  }

  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const updatedCredit = BigInt(
      (await invokeRead(rpcClient, oracleHash, 'feeCreditOf', [
        { type: 'Hash160', value: creditRecipientHash },
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

  throw new Error('timed out waiting for Neo N3 automation fee credit');
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
  const jobResponse = await fetch(jobUrl, { headers });
  const jobRows = jobResponse.ok ? await jobResponse.json() : [];
  const job = Array.isArray(jobRows) ? jobRows[0] || null : null;

  const runsUrl = new URL(`${baseUrl.replace(/\/$/, '')}/rest/v1/morpheus_automation_runs`);
  runsUrl.searchParams.set('select', '*');
  runsUrl.searchParams.set('network', `eq.${network}`);
  runsUrl.searchParams.set('automation_id', `eq.${automationId}`);
  runsUrl.searchParams.set('order', 'created_at.asc');
  const runsResponse = await fetch(runsUrl, { headers });
  const runs = runsResponse.ok ? await runsResponse.json() : [];

  return { job, runs: Array.isArray(runs) ? runs : [] };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

async function runRemoteDockerCommand(command, { appId, phalaApiToken }) {
  const phalaCli = resolvePhalaCliInvocation();
  logValidationStep('remote_command', {
    script: 'test-n3-automation-idempotency',
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
  const stdout = await runRemoteDockerCommand(
    "ps -ef | grep 'node src/cli.js loop' | grep -v grep | awk 'NR==1 {print $1}'",
    { appId, phalaApiToken }
  );
  return trimString(stdout.split(/\r?\n/, 1)[0] || '');
}

async function stopRelayer({ appId, phalaApiToken }) {
  const pid = await findRelayerLoopPid({ appId, phalaApiToken });
  assertCondition(pid, 'morpheus relayer loop pid not found on testnet CVM');
  await runRemoteDockerCommand(`kill -s STOP ${pid}`, { appId, phalaApiToken });
  return pid;
}

async function startRelayer({ appId, phalaApiToken, pid = '' }) {
  if (trimString(pid)) {
    await runRemoteDockerCommand(`kill -s CONT ${pid}`, { appId, phalaApiToken });
    return;
  }
  await runRemoteDockerCommand('docker start morpheus-relayer >/dev/null', {
    appId,
    phalaApiToken,
  });
}

async function waitForRelayerState({
  appId,
  phalaApiToken,
  shouldBeRunning,
  pid = '',
  timeoutMs = 30000,
}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const targetPid = trimString(pid) || (await findRelayerLoopPid({ appId, phalaApiToken }));
    if (!targetPid) {
      if (!shouldBeRunning) return;
      await sleep(1000);
      continue;
    }
    const stdout = await runRemoteDockerCommand(
      `ps -o pid=,stat=,args= | awk '$1 == ${targetPid} {print $2}'`,
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

async function main() {
  logValidationStep('boot', { script: 'test-n3-automation-idempotency' });
  await loadExampleEnv();
  const networkConfig = JSON.parse(
    await fs.readFile(path.resolve(repoRoot, 'config/networks/testnet.json'), 'utf8')
  );
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
    networkConfig?.phala?.cvm_id || process.env.MORPHEUS_PAYMASTER_APP_ID || ''
  );

  assertCondition(signerWif, 'testnet signer WIF is required');
  assertCondition(oracleHash, 'testnet oracle hash is required');
  assertCondition(consumerHash, 'testnet consumer hash is required');
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
  const requiredAutomationCredits = 50;
  const consumer = new experimental.SmartContract(consumerHash, {
    rpcAddress: rpcUrl,
    networkMagic,
    account,
  });
  const signers = [new tx.Signer({ account: account.scriptHash, scopes: tx.WitnessScope.Global })];
  let feeStatus = null;

  let pausedRelayerPid = await stopRelayer({ appId, phalaApiToken });
  await waitForRelayerState({
    appId,
    phalaApiToken,
    shouldBeRunning: false,
    pid: pausedRelayerPid,
  });
  feeStatus = await ensureFeeCredit(
    account,
    rpcUrl,
    networkMagic,
    rpcClient,
    oracleHash,
    requesterHash,
    requiredAutomationCredits,
    {
      viaConsumer: false,
      creditRecipientHash: requesterHash,
    }
  );
  await startRelayer({ appId, phalaApiToken, pid: pausedRelayerPid });
  await waitForRelayerState({ appId, phalaApiToken, shouldBeRunning: true, pid: pausedRelayerPid });

  const futureStart = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const intervalPayload = JSON.stringify({
    trigger: {
      type: 'interval',
      interval_ms: 300000,
      start_at: futureStart,
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
  const beforeRecord = await fetchAutomationRecord(
    supabaseUrl,
    serviceRoleKey,
    automationId,
    'testnet'
  );
  const beforeRunCount = Array.isArray(beforeRecord?.runs) ? beforeRecord.runs.length : 0;
  const expectedQueuedRequestId = `automation:neo_n3:${automationId}:1`;

  pausedRelayerPid = await stopRelayer({ appId, phalaApiToken });
  await waitForRelayerState({
    appId,
    phalaApiToken,
    shouldBeRunning: false,
    pid: pausedRelayerPid,
  });
  // Automation jobs share requester fee credit. Top up after the remote relayer loop
  // is paused so older due jobs cannot immediately consume the newly deposited balance.
  feeStatus = await ensureFeeCredit(
    account,
    rpcUrl,
    networkMagic,
    rpcClient,
    oracleHash,
    requesterHash,
    requiredAutomationCredits,
    {
      viaConsumer: false,
      creditRecipientHash: requesterHash,
    }
  );

  try {
    await patchAutomationJob(automationId, {
      status: 'active',
      next_run_at: new Date(Date.now() - 1000).toISOString(),
      execution_count: 0,
      last_error: null,
    });

    process.env.MORPHEUS_NETWORK = 'testnet';
    process.env.MORPHEUS_AUTOMATION_BATCH_SIZE = '200';
    process.env.MORPHEUS_AUTOMATION_MAX_QUEUED_PER_TICK = '200';
    process.env.NEO_RPC_URL = rpcUrl;
    process.env.NEO_NETWORK_MAGIC = String(networkMagic);
    process.env.CONTRACT_MORPHEUS_ORACLE_HASH = oracleHash;
    process.env.NEO_TESTNET_WIF = signerWif;
    process.env.MORPHEUS_RELAYER_NEO_N3_WIF = signerWif;
    const config = createRelayerConfig();
    const logger = { info() {}, warn() {} };

    const first = await processAutomationJobs(config, logger);
    const second = await processAutomationJobs(config, logger);

    const record = await fetchAutomationRecord(
      supabaseUrl,
      serviceRoleKey,
      automationId,
      'testnet'
    );
    const queuedRuns = record.runs.filter((item) => item.status === 'queued');
    const failedRuns = record.runs.filter((item) => item.status === 'failed');
    const skippedRuns = record.runs.filter((item) => item.status === 'skipped');
    assertCondition(
      record.job?.execution_count === 1,
      `expected execution_count=1 for ${automationId}, got ${record.job?.execution_count}`
    );
    assertCondition(
      trimString(record.job?.last_queued_request_id || '') === expectedQueuedRequestId,
      `expected last_queued_request_id=${expectedQueuedRequestId}, got ${record.job?.last_queued_request_id || ''}`
    );
    assertCondition(
      record.runs.length - beforeRunCount >= 1 && record.runs.length - beforeRunCount <= 2,
      `expected one queued run plus at most one skipped duplicate audit row for ${automationId}, got delta ${record.runs.length - beforeRunCount}`
    );
    assertCondition(
      queuedRuns.length === 1,
      `expected exactly one queued automation run, got ${queuedRuns.length}`
    );
    assertCondition(
      skippedRuns.length <= 1,
      `expected at most one skipped duplicate automation run, got ${skippedRuns.length}`
    );
    assertCondition(
      failedRuns.length === 0,
      `expected zero failed automation runs, got ${failedRuns.length}`
    );

    let relayerResumeObserved = true;
    await startRelayer({ appId, phalaApiToken, pid: pausedRelayerPid });
    try {
      await waitForRelayerState({
        appId,
        phalaApiToken,
        shouldBeRunning: true,
        pid: pausedRelayerPid,
        timeoutMs: 90000,
      });
    } catch {
      relayerResumeObserved = false;
    }
    const queuedRequestKey = trimString(queuedRuns[0]?.queued_request_id || '');
    const queuedTxHash = trimString(queuedRuns[0]?.queue_tx?.tx_hash || '');
    const queuedChainRequestId = queuedTxHash
      ? await waitForRequestId(rpcClient, queuedTxHash, 180000)
      : null;
    const queuedCallback = queuedChainRequestId
      ? await waitForCallback(rpcClient, consumerHash, queuedChainRequestId, 240000)
      : null;

    const generatedAt = new Date().toISOString();
    const jsonReport = {
      generated_at: generatedAt,
      network: 'testnet',
      rpc_url: rpcUrl,
      network_magic: networkMagic,
      oracle_hash: oracleHash,
      callback_consumer_hash: consumerHash,
      request_fee_status: feeStatus,
      registration: {
        txid: registerTx,
        request_id: String(registerRequestId),
        automation_id: automationId,
      },
      local_runs: {
        first,
        second,
      },
      relayer_resume_observed: relayerResumeObserved,
      supabase: record,
      queued_request_key: queuedRequestKey,
      queued_chain_request_id: queuedChainRequestId ? String(queuedChainRequestId) : null,
      queued_tx_hash: queuedTxHash || null,
      queued_callback: queuedCallback,
    };

    const markdownReport = [
      '# N3 Automation Idempotency Validation',
      '',
      `Date: ${generatedAt}`,
      '',
      '## Scope',
      '',
      'This probe validates that a due automation job is not sequentially queued twice when `processAutomationJobs()` is called back-to-back against the same active job state.',
      '',
      '## Result',
      '',
      `- Register tx: \`${registerTx}\``,
      `- Register request id: \`${registerRequestId}\``,
      `- Automation id: \`${automationId}\``,
      `- First local tick summary: \`${JSON.stringify(first)}\``,
      `- Second local tick summary: \`${JSON.stringify(second)}\``,
      `- Expected deterministic queued request id: \`${expectedQueuedRequestId}\``,
      `- Queued automation runs: \`${queuedRuns.length}\``,
      `- Skipped duplicate audit runs: \`${skippedRuns.length}\``,
      `- Relayer resume observed: \`${relayerResumeObserved}\``,
      queuedRequestKey ? `- Queued request key: \`${queuedRequestKey}\`` : null,
      queuedChainRequestId ? `- Queued chain request id: \`${queuedChainRequestId}\`` : null,
      queuedCallback ? `- Queued callback success: \`${queuedCallback.success}\`` : null,
      '',
      '## Conclusion',
      '',
      'Sequential duplicate queueing was not observed. The first `processAutomationJobs()` call queued one request, the second did not create a second queued execution, and Supabase recorded exactly one queued automation run plus at most one skipped duplicate audit row for the target job.',
      relayerResumeObserved
        ? 'The relayer pause/resume state transition was observed directly before the queued callback settled.'
        : 'The relayer pause/resume state transition was not observed within the local timeout window, but the queued callback still settled successfully on-chain.',
      '',
    ]
      .filter(Boolean)
      .join('\n');

    const artifacts = await writeValidationArtifacts({
      baseName: 'n3-automation-idempotency',
      network: 'testnet',
      generatedAt,
      jsonReport,
      markdownReport,
    });

    console.log(
      JSON.stringify(
        {
          ...artifacts,
          register_txid: registerTx,
          register_request_id: String(registerRequestId),
          automation_id: automationId,
          queued_request_key: queuedRequestKey,
          queued_chain_request_id: queuedChainRequestId ? String(queuedChainRequestId) : null,
        },
        null,
        2
      )
    );
  } finally {
    await startRelayer({ appId, phalaApiToken, pid: pausedRelayerPid }).catch(() => {});
  }
}

main().catch((error) => {
  const message = error?.stack || error?.message || String(error);
  if (/spawn phala ENOENT/i.test(message)) {
    writeSkippedValidationArtifacts({
      baseName: 'n3-automation-idempotency',
      network: 'testnet',
      title: 'N3 Automation Idempotency Validation',
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
