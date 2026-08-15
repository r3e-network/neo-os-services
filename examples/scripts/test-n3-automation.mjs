import { experimental, rpc as neoRpc, sc, tx, wallet } from '@cityofzion/neon-js';
import {
  encodeUtf8Base64,
  jsonPretty,
  loadExampleEnv,
  markdownJson,
  normalizeHash160,
  readDeploymentRegistry,
  resolveNeoN3ConsumerHash,
  resolveNeoN3OracleHash,
  resolveNeoN3SignerWif,
  writeValidationArtifacts,
  sleep,
  trimString,
  tryParseJson,
} from './common.mjs';

const GAS_HASH = '0xd2a4cff31913016155e38e474a2c06d08be276cf';

function isTransientRpcError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /HTTP code 502|HTTP code 503|HTTP code 504|ECONNRESET|ETIMEDOUT|socket hang up|fetch failed|network error/i.test(message);
}

async function withRetries(label, task, attempts = 5) {
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
      const appLog = await withRetries(`getApplicationLog:${txid}`, () =>
        rpcClient.getApplicationLog(txid)
      );
      const notification = appLog.executions
        ?.flatMap((execution) => execution.notifications || [])
        .find((entry) => ['OracleRequested', 'MiniAppRequestQueued'].includes(entry.eventname));
      const requestId = notification?.state?.value?.[0]?.value ?? null;
      if (requestId) return requestId;
    } catch {}
    await sleep(2000);
  }
  throw new Error(`timed out waiting for Neo N3 request id from tx ${txid}`);
}

async function waitForCallback(rpcClient, consumerHash, requestId, timeoutMs = 180000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const response = await withRetries(`getCallback:${requestId}`, () =>
      rpcClient.invokeFunction(consumerHash, 'getCallback', [
        { type: 'Integer', value: String(requestId) },
      ])
    );
    const decoded = decodeCallbackArray(response.stack?.[0]);
    if (decoded && (decoded.request_type || decoded.result_text || decoded.error_text)) {
      return decoded;
    }
    await sleep(2000);
  }
  throw new Error(`timed out waiting for Neo N3 callback ${requestId}`);
}

async function readCallbackOnce(rpcClient, consumerHash, requestId) {
  const response = await withRetries(`getCallback:${requestId}`, () =>
    rpcClient.invokeFunction(consumerHash, 'getCallback', [
      { type: 'Integer', value: String(requestId) },
    ])
  );
  return decodeCallbackArray(response.stack?.[0]);
}

async function resolveQueueTxRequestId(rpcClient, txid, timeoutMs = 30000) {
  try {
    return await waitForRequestId(rpcClient, txid, timeoutMs);
  } catch {
    return null;
  }
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
  await withRetries('gas.transfer', () =>
    gas.invoke('transfer', [
      sc.ContractParam.hash160(`0x${account.scriptHash}`),
      sc.ContractParam.hash160(payerHash),
      sc.ContractParam.integer(deficit.toString()),
      sc.ContractParam.any(null),
    ])
  );

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
  const signers = [new tx.Signer({ account: account.scriptHash, scopes: tx.WitnessScope.Global })];
  await withRetries('depositOracleCredits', () =>
    consumer.invoke('depositOracleCredits', [sc.ContractParam.integer(deficit.toString())], signers)
  );

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
      };
    }
    await sleep(2000);
  }

  throw new Error('timed out waiting for Neo N3 automation fee credit');
}

async function waitForQueuedExecution(
  rpcClient,
  oracleHash,
  startRequestIdExclusive,
  requesterHash,
  consumerHash,
  automationId,
  timeoutMs = 180000
) {
  const startedAt = Date.now();
  let nextRequestId = BigInt(startRequestIdExclusive) + 1n;
  const candidateRequestIds = new Map();
  while (Date.now() - startedAt < timeoutMs) {
    if (automationId) {
      const automationRecord = await fetchAutomationRecord(automationId).catch(() => null);
      for (const run of automationRecord?.runs || []) {
        const txHash = trimString(run?.queue_tx?.tx_hash || '');
        if (!txHash) continue;
        const resolvedRequestId = await resolveQueueTxRequestId(rpcClient, txHash, 10000);
        if (!resolvedRequestId) continue;
        candidateRequestIds.set(String(resolvedRequestId), {
          source: 'supabase_queue_tx',
          run_status: trimString(run?.status || ''),
          queue_tx_hash: txHash,
        });
      }
    }

    const totalRequests = BigInt(
      (await invokeRead(rpcClient, oracleHash, 'getTotalRequests', [])) || '0'
    );
    for (; nextRequestId <= totalRequests; nextRequestId += 1n) {
      const requestId = nextRequestId;
      const request = await invokeRead(rpcClient, oracleHash, 'getRequest', [
        { type: 'Integer', value: requestId.toString() },
      ]);
      if (!Array.isArray(request) || request.length < 12) continue;
      const requester = normalizeHash160(request[5] || '');
      const callbackContract = normalizeHash160(request[3] || '');
      if (requester !== requesterHash || callbackContract !== consumerHash) continue;
      candidateRequestIds.set(requestId.toString(), {
        source: 'chain_scan',
      });
    }

    const sortedRequestIds = [...candidateRequestIds.keys()].sort(
      (left, right) => Number(left) - Number(right)
    );
    for (const requestId of sortedRequestIds) {
      const callback = await readCallbackOnce(rpcClient, consumerHash, requestId);
      if (callback?.request_type === 'privacy_oracle' && callback.success) {
        const request = await invokeRead(rpcClient, oracleHash, 'getRequest', [
          { type: 'Integer', value: String(requestId) },
        ]);
        return {
          request_id: String(requestId),
          onchain_request: {
            id: String(request?.[0] || requestId),
            request_type: String(request[1] || ''),
            callback_contract: String(request[3] || ''),
            requester: String(request[5] || ''),
            status: String(request[6] || ''),
            created_at: String(request[7] || ''),
          },
          callback,
          source: candidateRequestIds.get(String(requestId)) || null,
        };
      }
    }
    await sleep(4000);
  }
  throw new Error('timed out waiting for queued automation execution');
}

async function fetchAutomationRecord(automationId) {
  const baseUrl = trimString(
    process.env.SUPABASE_URL ||
      process.env.NEXT_PUBLIC_SUPABASE_URL ||
      process.env.morpheus_SUPABASE_URL ||
      ''
  );
  const apiKey = trimString(
    process.env.SUPABASE_SECRET_KEY ||
      process.env.morpheus_SUPABASE_SECRET_KEY ||
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.morpheus_SUPABASE_SERVICE_ROLE_KEY ||
      ''
  );
  if (!baseUrl || !apiKey) return null;

  const headers = {
    apikey: apiKey,
    authorization: `Bearer ${apiKey}`,
    accept: 'application/json',
  };
  const network = trimString(process.env.MORPHEUS_NETWORK || 'testnet') || 'testnet';

  const jobUrl = new URL(`${baseUrl.replace(/\/$/, '')}/rest/v1/morpheus_automation_jobs`);
  jobUrl.searchParams.set('select', '*');
  jobUrl.searchParams.set('network', `eq.${network}`);
  jobUrl.searchParams.set('automation_id', `eq.${automationId}`);
  jobUrl.searchParams.set('limit', '1');
  const jobResponse = await withRetries(`supabase:automation_job:${automationId}`, () =>
    fetch(jobUrl, { headers })
  );
  const jobRows = jobResponse.ok ? await jobResponse.json() : [];
  const job = Array.isArray(jobRows) ? jobRows[0] || null : null;

  const runsUrl = new URL(`${baseUrl.replace(/\/$/, '')}/rest/v1/morpheus_automation_runs`);
  runsUrl.searchParams.set('select', '*');
  runsUrl.searchParams.set('network', `eq.${network}`);
  runsUrl.searchParams.set('automation_id', `eq.${automationId}`);
  runsUrl.searchParams.set('order', 'created_at.asc');
  const runsResponse = await withRetries(`supabase:automation_runs:${automationId}`, () =>
    fetch(runsUrl, { headers })
  );
  const runs = runsResponse.ok ? await runsResponse.json() : [];

  return {
    job,
    runs: Array.isArray(runs) ? runs : [],
  };
}

await loadExampleEnv();

const network = trimString(process.env.MORPHEUS_NETWORK || 'testnet') || 'testnet';
const registry = await readDeploymentRegistry(network);
const deployment = registry.neo_n3 || {};
const defaultRpcUrl =
  network === 'mainnet' ? 'http://seed1.neo.org:10332' : 'https://testnet1.neo.coz.io:443';
const defaultNetworkMagic = network === 'mainnet' ? 860833102 : 894710606;
const rpcUrl = trimString(process.env.NEO_RPC_URL || deployment.rpc_url || defaultRpcUrl);
const networkMagic = Number(
  process.env.NEO_NETWORK_MAGIC || deployment.network_magic || defaultNetworkMagic
);
const wif = resolveNeoN3SignerWif(network);
const consumerHash = resolveNeoN3ConsumerHash(network, deployment);
const oracleHash = resolveNeoN3OracleHash(network, deployment);
const callbackTimeoutMs = Number(process.env.EXAMPLE_CALLBACK_TIMEOUT_MS || 240000);

if (!wif) throw new Error('NEO_N3_WIF or MORPHEUS_RELAYER_NEO_N3_WIF is required');
if (!consumerHash) throw new Error('Neo N3 example consumer hash is required');
if (!oracleHash) throw new Error('CONTRACT_MORPHEUS_ORACLE_HASH is required');

const account = new wallet.Account(wif);
const requesterHash = `0x${account.scriptHash}`;
const rpcClient = new neoRpc.RPCClient(rpcUrl);
const signers = [new tx.Signer({ account: account.scriptHash, scopes: tx.WitnessScope.Global })];
const consumer = new experimental.SmartContract(consumerHash, {
  rpcAddress: rpcUrl,
  networkMagic,
  account,
});

// Automation flows can consume additional sponsored executions after registration,
// so keep a larger fee-credit buffer to avoid false negatives during live tests.
const feeStatus = await ensureFeeCredit(
  account,
  rpcUrl,
  networkMagic,
  rpcClient,
  oracleHash,
  consumerHash,
  8
);
const totalRequestsBefore = await invokeRead(rpcClient, oracleHash, 'getTotalRequests', []);

const executeAt = new Date(Date.now() + 20_000).toISOString();
const registerPayload = JSON.stringify({
  trigger: {
    type: 'one_shot',
    execute_at: executeAt,
  },
  execution: {
    request_type: 'privacy_oracle',
    payload: {
      provider: 'twelvedata',
      symbol: 'NEO-USD',
      json_path: 'price',
      target_chain: 'neo_n3',
    },
  },
  max_executions: 1,
});

console.log('Registering Neo N3 one-shot automation...');
const registerTx = await withRetries('automation_register', () =>
  consumer.invoke(
    'requestRaw',
    ['automation_register', sc.ContractParam.byteArray(encodeUtf8Base64(registerPayload))],
    signers
  )
);
const registerRequestId = await waitForRequestId(rpcClient, registerTx);
const registerCallback = await waitForCallback(
  rpcClient,
  consumerHash,
  registerRequestId,
  callbackTimeoutMs
);
if (!registerCallback.success) {
  throw new Error(
    `Neo N3 automation register callback failed: ${registerCallback.error_text || 'unknown error'}`
  );
}
const automationId = trimString(
  registerCallback.result_json?.result?.automation_id ||
    registerCallback.result_json?.automation_id ||
    ''
);
if (!automationId) {
  throw new Error('Neo N3 automation register callback did not return automation_id');
}

console.log('Waiting for queued one-shot automation execution...');
const execution = await waitForQueuedExecution(
  rpcClient,
  oracleHash,
  totalRequestsBefore,
  requesterHash,
  consumerHash,
  automationId,
  callbackTimeoutMs
);

const intervalPayload = JSON.stringify({
  trigger: {
    type: 'interval',
    interval_ms: 600000,
    start_at: new Date(Date.now() + 30 * 60_000).toISOString(),
  },
  execution: {
    request_type: 'privacy_oracle',
    payload: {
      provider: 'twelvedata',
      symbol: 'NEO-USD',
      json_path: 'price',
      target_chain: 'neo_n3',
    },
  },
});

console.log('Registering Neo N3 interval automation for cancellation...');
const intervalRegisterTx = await withRetries('automation_register:interval', () =>
  consumer.invoke(
    'requestRaw',
    ['automation_register', sc.ContractParam.byteArray(encodeUtf8Base64(intervalPayload))],
    signers
  )
);
const intervalRegisterRequestId = await waitForRequestId(rpcClient, intervalRegisterTx);
const intervalRegisterCallback = await waitForCallback(
  rpcClient,
  consumerHash,
  intervalRegisterRequestId,
  callbackTimeoutMs
);
if (!intervalRegisterCallback.success) {
  throw new Error(
    `Neo N3 interval automation register callback failed: ${intervalRegisterCallback.error_text || 'unknown error'}`
  );
}
const cancelAutomationId = trimString(
  intervalRegisterCallback.result_json?.result?.automation_id ||
    intervalRegisterCallback.result_json?.automation_id ||
    ''
);
if (!cancelAutomationId) {
  throw new Error('Neo N3 interval automation register callback did not return automation_id');
}

const cancelPayload = JSON.stringify({ automation_id: cancelAutomationId });
console.log('Cancelling Neo N3 automation...');
const cancelTx = await withRetries('automation_cancel', () =>
  consumer.invoke(
    'requestRaw',
    ['automation_cancel', sc.ContractParam.byteArray(encodeUtf8Base64(cancelPayload))],
    signers
  )
);
const cancelRequestId = await waitForRequestId(rpcClient, cancelTx);
const cancelCallback = await waitForCallback(
  rpcClient,
  consumerHash,
  cancelRequestId,
  callbackTimeoutMs
);
if (!cancelCallback.success) {
  throw new Error(
    `Neo N3 automation cancel callback failed: ${cancelCallback.error_text || 'unknown error'}`
  );
}

const supabase = await fetchAutomationRecord(automationId);
const cancelledSupabase = await fetchAutomationRecord(cancelAutomationId);

const generatedAt = new Date().toISOString();
const reportJson = {
  generated_at: generatedAt,
  network,
  target_chain: 'neo_n3',
  consumer_hash: consumerHash,
  oracle_hash: oracleHash,
  request_fee: feeStatus.request_fee,
  request_credit: feeStatus.current_credit,
  request_credit_deposit: feeStatus.deposit_amount,
  register: {
    txid: registerTx,
    request_id: registerRequestId,
    callback: registerCallback,
    execute_at: executeAt,
    automation_id: automationId,
  },
  queued_execution: execution,
  cancel_registration: {
    txid: intervalRegisterTx,
    request_id: intervalRegisterRequestId,
    callback: intervalRegisterCallback,
    automation_id: cancelAutomationId,
  },
  cancel: {
    txid: cancelTx,
    request_id: cancelRequestId,
    callback: cancelCallback,
  },
  supabase,
  cancelled_supabase: cancelledSupabase,
};

const markdown = [
  '# Neo N3 Automation Validation',
  '',
  `Generated: ${generatedAt}`,
  '',
  '## Environment',
  '',
  `- Network: \`${network}\``,
  `- Target chain: \`neo_n3\``,
  `- Consumer: \`${consumerHash}\``,
  `- Oracle: \`${oracleHash}\``,
  `- Request fee: \`${feeStatus.request_fee}\``,
  '',
  '## Case Matrix',
  '',
  '| Case | Tx | Request ID | Result |',
  '| --- | --- | --- | --- |',
  `| register | \`${registerTx}\` | \`${registerRequestId}\` | \`${automationId}\` |`,
  `| queued_execution | \`scheduler\` | \`${execution.request_id}\` | \`${JSON.stringify(execution.callback?.result_json?.result?.result ?? execution.callback?.result_json?.result?.extracted_value ?? null)}\` |`,
  `| cancel_registration | \`${intervalRegisterTx}\` | \`${intervalRegisterRequestId}\` | \`${cancelAutomationId}\` |`,
  `| cancel | \`${cancelTx}\` | \`${cancelRequestId}\` | \`${cancelCallback.success}\` |`,
  '',
  '## Registration Result',
  '',
  markdownJson(reportJson.register),
  '',
  '## Queued Execution',
  '',
  markdownJson(reportJson.queued_execution),
  '',
  '## Cancellation Registration',
  '',
  markdownJson(reportJson.cancel_registration),
  '',
  '## Cancellation Result',
  '',
  markdownJson(reportJson.cancel),
  '',
  '## Supabase Job Snapshot',
  '',
  markdownJson(reportJson.supabase),
  '',
  '## Supabase Cancelled Job Snapshot',
  '',
  markdownJson(reportJson.cancelled_supabase),
  '',
].join('\n');

const artifacts = await writeValidationArtifacts({
  baseName: 'n3-automation-validation',
  network,
  generatedAt,
  jsonReport: reportJson,
  markdownReport: markdown,
});

process.stdout.write(
  jsonPretty({
    ...reportJson,
    ...artifacts,
  })
);
