import { experimental, sc, rpc as neoRpc, wallet } from '@cityofzion/neon-js';
import { loadDotEnv, parseDotEnv } from './lib-env.mjs';
import { parseGasToRaw } from './lib-gas-units.mjs';
import { resolveCallbackWithLocalFallback } from './lib-smoke-oracle-fallback.mjs';
import {
  buildFulfillmentVerificationSignature,
  resolveFulfillmentSigningContext,
} from './lib-smoke-oracle-signing.mjs';
import { buildOnchainResultEnvelope } from '../workers/morpheus-relayer/src/router.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  materializeNeoN3Secret,
  normalizeMorpheusNetwork,
  reportPinnedNeoN3Role,
} from './lib-neo-signers.mjs';
import { resolveNetworkScopedValue, snapshotEnv, withRetries } from './lib-verify-morpheus-n3.mjs';
import { trimString } from './lib-strings.mjs';

const GAS_HASH = '0xd2a4cff31913016155e38e474a2c06d08be276cf';
const CONTRACT_ENV_KEYS = [
  'CONTRACT_MORPHEUS_ORACLE_HASH',
  'CONTRACT_MORPHEUS_ORACLE_HASH_MAINNET',
  'CONTRACT_MORPHEUS_ORACLE_HASH_TESTNET',
  'CONTRACT_ORACLE_CALLBACK_CONSUMER_HASH',
  'CONTRACT_ORACLE_CALLBACK_CONSUMER_HASH_MAINNET',
  'CONTRACT_ORACLE_CALLBACK_CONSUMER_HASH_TESTNET',
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForTransactionExecution(rpcClient, txid, timeoutMs = 120000) {
  const normalized = String(txid).startsWith('0x') ? String(txid) : `0x${txid}`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const appLog = await rpcClient.getApplicationLog(normalized);
      const execution = appLog?.executions?.[0];
      if (execution) {
        return {
          txid: normalized,
          vmstate: String(execution.vmstate || execution.state || ''),
          exception: execution.exception || null,
        };
      }
    } catch {}
    await sleep(2000);
  }
  throw new Error(`timed out waiting for transaction ${normalized}`);
}

function decodeBase64String(raw) {
  const text = trimString(raw);
  if (!text) return '';
  return Buffer.from(text, 'base64').toString('utf8');
}

function tryParseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function loadJsonIfExists(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw error;
  }
}

async function loadEnvSnapshot(filePath) {
  try {
    return parseDotEnv(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw error;
  }
}

const requestedRpcUrl = trimString(process.env.NEO_RPC_URL || '');
const network = normalizeMorpheusNetwork(process.env.MORPHEUS_NETWORK || 'testnet');
const explicitContractEnvSnapshot = snapshotEnv(CONTRACT_ENV_KEYS);
const selectedNitroEnvPath = path.resolve('deploy', 'nitro', `morpheus.${network}.env`);
const selectedNitroEnvSnapshot = await loadEnvSnapshot(selectedNitroEnvPath);
await loadDotEnv(selectedNitroEnvPath, { override: false });
await loadDotEnv();
const networkConfig = await loadJsonIfExists(path.resolve('config', 'networks', `${network}.json`));
const deploymentRegistry = await loadJsonIfExists(
  path.resolve('examples', 'deployments', `${network}.json`)
);
const defaultRpcUrl =
  network === 'mainnet' ? 'https://api.n3index.dev/mainnet' : 'https://api.n3index.dev/testnet';
const defaultNetworkMagic = network === 'mainnet' ? 860833102 : 894710606;

function decodeCallbackArray(item) {
  if (!item || item.type !== 'Array' || !Array.isArray(item.value)) return null;
  if (item.value.length < 4) return null;
  if (item.value.length >= 8) {
    const [
      appIdItem,
      moduleIdItem,
      operationItem,
      requesterItem,
      successItem,
      resultItem,
      errorItem,
      receivedAtItem,
    ] = item.value;
    const resultText = decodeBase64String(resultItem?.value || '');
    const requesterBytes = parseStackItem(requesterItem);
    return {
      app_id: decodeBase64String(appIdItem?.value || ''),
      module_id: decodeBase64String(moduleIdItem?.value || ''),
      operation: decodeBase64String(operationItem?.value || ''),
      requester: requesterBytes,
      success: Boolean(successItem?.value),
      result_text: resultText,
      result_json: tryParseJson(resultText),
      error_text: decodeBase64String(errorItem?.value || ''),
      received_at_ms: String(receivedAtItem?.value || ''),
    };
  }
  const [requestTypeItem, successItem, resultItem, errorItem] = item.value;
  const requestType = decodeBase64String(requestTypeItem?.value || '');
  const success = Boolean(successItem?.value);
  const resultText = decodeBase64String(resultItem?.value || '');
  const errorText = decodeBase64String(errorItem?.value || '');
  return {
    request_type: requestType,
    success,
    result_text: resultText,
    result_json: tryParseJson(resultText),
    error_text: errorText,
  };
}

function parseStackItem(item) {
  if (!item || typeof item !== 'object') return null;
  const type = trimString(item.type).toLowerCase();
  switch (type) {
    case 'integer':
      return String(item.value ?? '0');
    case 'boolean':
      return Boolean(item.value);
    case 'hash160':
    case 'hash256':
    case 'string':
      return String(item.value ?? '');
    case 'bytestring':
    case 'bytearray':
      return decodeBase64String(item.value || '');
    case 'array':
    case 'struct':
      return Array.isArray(item.value) ? item.value.map(parseStackItem) : [];
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

function toGasString(rawValue) {
  const negative = rawValue < 0n;
  const abs = negative ? rawValue * -1n : rawValue;
  const whole = abs / 100000000n;
  const fraction = String(abs % 100000000n)
    .padStart(8, '0')
    .replace(/0+$/, '');
  const suffix = fraction ? `.${fraction}` : '';
  return `${negative ? '-' : ''}${whole}${suffix}`;
}

async function ensureGasBudget(rpcClient, account) {
  const minGasRaw = parseGasToRaw(process.env.MORPHEUS_SMOKE_MIN_GAS, 2000000n);
  const balanceRaw = BigInt(
    (await invokeRead(rpcClient, GAS_HASH, 'balanceOf', [
      { type: 'Hash160', value: `0x${account.scriptHash}` },
    ])) || '0'
  );

  if (balanceRaw < minGasRaw) {
    throw new Error(
      `Insufficient GAS for smoke tx path. Required >= ${toGasString(minGasRaw)} GAS, available ${toGasString(balanceRaw)} GAS. Top up wallet and retry.`
    );
  }

  return {
    min_gas: toGasString(minGasRaw),
    balance_gas: toGasString(balanceRaw),
  };
}

async function ensureRequestFeeCredit(account, rpcUrl, networkMagic, rpcClient, oracleHash) {
  const currentCredit = BigInt(
    (await invokeRead(rpcClient, oracleHash, 'feeCreditOf', [
      { type: 'Hash160', value: `0x${account.scriptHash}` },
    ])) || '0'
  );
  const requestFee = BigInt((await invokeRead(rpcClient, oracleHash, 'requestFee', [])) || '0');
  if (requestFee <= 0n || currentCredit >= requestFee) {
    return {
      request_fee: requestFee.toString(),
      funded: false,
      current_credit: currentCredit.toString(),
    };
  }

  const gas = new experimental.SmartContract(GAS_HASH, {
    rpcAddress: rpcUrl,
    networkMagic,
    account,
  });
  const deficit = requestFee - currentCredit;
  const depositTxid = await gas.invoke('transfer', [
    sc.ContractParam.hash160(`0x${account.scriptHash}`),
    sc.ContractParam.hash160(oracleHash),
    sc.ContractParam.integer(deficit.toString()),
    sc.ContractParam.any(null),
  ]);
  const depositExecution = await waitForTransactionExecution(rpcClient, depositTxid);
  if (!depositExecution.vmstate.includes('HALT')) {
    throw new Error(
      depositExecution.exception ||
        `Neo N3 request fee deposit faulted for ${depositExecution.txid} (${depositExecution.vmstate})`
    );
  }

  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const updatedCredit = BigInt(
      (await invokeRead(rpcClient, oracleHash, 'feeCreditOf', [
        { type: 'Hash160', value: `0x${account.scriptHash}` },
      ])) || '0'
    );
    if (updatedCredit >= requestFee) {
      return {
        request_fee: requestFee.toString(),
        funded: true,
        deposit_amount: deficit.toString(),
        current_credit: updatedCredit.toString(),
        deposit_txid: depositExecution.txid,
      };
    }
    await sleep(2000);
  }
  throw new Error(
    `timed out waiting for Neo N3 request fee credit after deposit tx ${depositExecution.txid}`
  );
}

async function ensureAccountGasBalance({
  rpcClient,
  rpcUrl,
  networkMagic,
  fundingAccount,
  targetScriptHash,
  minGasRaw,
  timeoutMs = 60000,
}) {
  const normalizedTarget = trimString(targetScriptHash).replace(/^0x/i, '');
  if (!normalizedTarget) {
    throw new Error('targetScriptHash is required');
  }

  const current = BigInt(
    (await invokeRead(rpcClient, GAS_HASH, 'balanceOf', [
      { type: 'Hash160', value: `0x${normalizedTarget}` },
    ])) || '0'
  );
  if (current >= minGasRaw) {
    return {
      funded: false,
      previous_balance_gas: toGasString(current),
      current_balance_gas: toGasString(current),
      min_gas: toGasString(minGasRaw),
    };
  }

  const transferAmount = minGasRaw - current;
  const gas = new experimental.SmartContract(GAS_HASH, {
    rpcAddress: rpcUrl,
    networkMagic,
    account: fundingAccount,
  });

  const topupTxid = await gas.invoke('transfer', [
    sc.ContractParam.hash160(`0x${fundingAccount.scriptHash}`),
    sc.ContractParam.hash160(`0x${normalizedTarget}`),
    sc.ContractParam.integer(transferAmount.toString()),
    sc.ContractParam.any(null),
  ]);
  const topupExecution = await waitForTransactionExecution(rpcClient, topupTxid);
  if (!topupExecution.vmstate.includes('HALT')) {
    throw new Error(
      topupExecution.exception ||
        `GAS top-up faulted for ${topupExecution.txid} (${topupExecution.vmstate})`
    );
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const updated = BigInt(
      (await invokeRead(rpcClient, GAS_HASH, 'balanceOf', [
        { type: 'Hash160', value: `0x${normalizedTarget}` },
      ])) || '0'
    );
    if (updated >= minGasRaw) {
      return {
        funded: true,
        transfer_amount_gas: toGasString(transferAmount),
        previous_balance_gas: toGasString(current),
        current_balance_gas: toGasString(updated),
        min_gas: toGasString(minGasRaw),
        topup_txid: topupExecution.txid,
      };
    }
    await sleep(2000);
  }

  throw new Error(
    `timed out waiting for GAS top-up on ${`0x${normalizedTarget}`} after tx ${topupExecution.txid} (target >= ${toGasString(minGasRaw)} GAS)`
  );
}

async function waitForRequestId(rpcClient, txid, timeoutMs = 60000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const appLog = await rpcClient.getApplicationLog(txid);
      const execution = appLog.executions?.[0];
      const stackRequestId = execution?.stack?.[0]?.value;
      if (stackRequestId) return stackRequestId;
      const notify = appLog.executions
        ?.flatMap((entry) => entry.notifications || [])
        .find((entry) =>
          ['OracleRequested', 'MiniAppRequestQueued'].includes(String(entry.eventname || ''))
        );
      const requestId = notify?.state?.value?.[0]?.value ?? null;
      if (requestId) return requestId;
    } catch {}
    await sleep(2000);
  }
  throw new Error(`timed out waiting for OracleRequested for tx ${txid}`);
}

async function fetchRequestRecord(rpcClient, oracleHash, requestId) {
  const response = await rpcClient.invokeFunction(oracleHash, 'getRequest', [
    { type: 'Integer', value: String(requestId) },
  ]);
  if (String(response.state || '').toUpperCase() === 'FAULT') {
    throw new Error(response.exception || `getRequest faulted for ${requestId}`);
  }
  const decoded = parseStackItem(response.stack?.[0]);
  if (!Array.isArray(decoded)) return null;
  if (decoded.length >= 14) {
    return {
      request_shape: 'kernel',
      request_id: String(decoded[0] ?? requestId),
      app_id: String(decoded[1] ?? ''),
      module_id: String(decoded[2] ?? ''),
      operation: String(decoded[3] ?? ''),
      payload_text: String(decoded[4] ?? ''),
      requester: String(decoded[5] ?? ''),
      sponsor: String(decoded[6] ?? ''),
      callback_contract: String(decoded[7] ?? ''),
      status: String(decoded[8] ?? ''),
      created_at_ms: String(decoded[9] ?? ''),
      fulfilled_at_ms: String(decoded[10] ?? ''),
      success: Boolean(decoded[11]),
      result_text: String(decoded[12] ?? ''),
      error_text: String(decoded[13] ?? ''),
    };
  }
  if (decoded.length >= 12) {
    return {
      request_shape: 'legacy',
      request_id: String(decoded[0] ?? requestId),
      request_type: String(decoded[1] ?? ''),
      payload_text: String(decoded[2] ?? ''),
      callback_contract: String(decoded[3] ?? ''),
      callback_method: String(decoded[4] ?? ''),
      requester: String(decoded[5] ?? ''),
      status: String(decoded[6] ?? ''),
      created_at_ms: String(decoded[7] ?? ''),
      fulfilled_at_ms: String(decoded[8] ?? ''),
      success: Boolean(decoded[9]),
      result_text: String(decoded[10] ?? ''),
      error_text: String(decoded[11] ?? ''),
    };
  }
  return null;
}

async function waitForCallback(rpcClient, callbackHash, requestId, timeoutMs = 120000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const response = await rpcClient.invokeFunction(callbackHash, 'getCallback', [
      { type: 'Integer', value: String(requestId) },
    ]);
    const decoded = decodeCallbackArray(response.stack?.[0]);
    if (decoded) return decoded;
    await sleep(2000);
  }
  throw new Error(`timed out waiting for callback ${requestId}`);
}

async function fulfillRequestLocally(
  rpcClient,
  oracleHash,
  account,
  verificationAccount,
  rpcUrl,
  networkMagic,
  requestId,
  requestType,
  resultText,
  signingContext = {}
) {
  const signature = buildFulfillmentVerificationSignature({
    requestId,
    requestType,
    success: true,
    resultText,
    signerPrivateKey: verificationAccount?.privateKey || '',
    ...signingContext,
  });

  const oracle = new experimental.SmartContract(oracleHash, {
    rpcAddress: rpcUrl,
    networkMagic,
    account,
  });

  const txid = await oracle.invoke('fulfillRequest', [
    sc.ContractParam.integer(String(requestId)),
    sc.ContractParam.boolean(true),
    sc.ContractParam.byteArray(Buffer.from(String(resultText ?? ''), 'utf8').toString('base64')),
    sc.ContractParam.string(''),
    sc.ContractParam.byteArray(
      Buffer.from(signature.replace(/^0x/i, ''), 'hex').toString('base64')
    ),
  ]);

  const startedAt = Date.now();
  while (Date.now() - startedAt < 120000) {
    try {
      const appLog = await rpcClient.getApplicationLog(txid);
      const execution = appLog?.executions?.[0];
      const vmState = String(execution?.vmstate || execution?.state || '');
      if (vmState.includes('HALT')) return txid;
      if (vmState.includes('FAULT'))
        throw new Error(execution?.exception || `fulfillRequest faulted for ${requestId}`);
    } catch (error) {
      if (/faulted/i.test(String(error?.message || error))) throw error;
    }
    await sleep(2000);
  }
  throw new Error(`timed out waiting for local fulfill ${requestId}`);
}

const registryOracleHash = trimString(
  deploymentRegistry?.neo_n3?.oracle_hash || networkConfig?.neo_n3?.contracts?.morpheus_oracle || ''
);
const registryCallbackHash = trimString(
  networkConfig?.neo_n3?.contracts?.oracle_callback_consumer ||
    deploymentRegistry?.neo_n3?.example_consumer_hash ||
    ''
);
const mainnetOracleHash = trimString(
  (await loadJsonIfExists(path.resolve('config', 'networks', 'mainnet.json')))?.neo_n3?.contracts
    ?.morpheus_oracle || ''
);
const rawOracleHash = trimString(
  resolveNetworkScopedValue({
    network,
    explicitEnv: explicitContractEnvSnapshot,
    selectedEnv: selectedNitroEnvSnapshot,
    loadedEnv: process.env,
    genericKey: 'CONTRACT_MORPHEUS_ORACLE_HASH',
    mainnetKey: 'CONTRACT_MORPHEUS_ORACLE_HASH_MAINNET',
    testnetKey: 'CONTRACT_MORPHEUS_ORACLE_HASH_TESTNET',
    registryValue: registryOracleHash,
  })
);
const rawCallbackHash = trimString(
  resolveNetworkScopedValue({
    network,
    explicitEnv: explicitContractEnvSnapshot,
    selectedEnv: selectedNitroEnvSnapshot,
    loadedEnv: process.env,
    genericKey: 'CONTRACT_ORACLE_CALLBACK_CONSUMER_HASH',
    mainnetKey: 'CONTRACT_ORACLE_CALLBACK_CONSUMER_HASH_MAINNET',
    testnetKey: 'CONTRACT_ORACLE_CALLBACK_CONSUMER_HASH_TESTNET',
    registryValue: registryCallbackHash,
  })
);

const rpcUrl = trimString(
  requestedRpcUrl || process.env.NEO_RPC_URL || networkConfig?.neo_n3?.rpc_url || defaultRpcUrl
);
const networkMagic = Number(
  process.env.NEO_NETWORK_MAGIC || networkConfig?.neo_n3?.network_magic || defaultNetworkMagic
);
const oracleHash =
  network === 'testnet' && rawOracleHash === mainnetOracleHash && registryOracleHash
    ? registryOracleHash
    : rawOracleHash;
const callbackHash = rawCallbackHash;
const provider = trimString(process.env.MORPHEUS_SMOKE_PROVIDER || 'twelvedata') || 'twelvedata';
const symbol = trimString(process.env.MORPHEUS_SMOKE_SYMBOL || 'NEO-USD') || 'NEO-USD';
const requestType =
  trimString(process.env.MORPHEUS_SMOKE_REQUEST_TYPE || 'privacy_oracle') || 'privacy_oracle';
const jsonPath = trimString(process.env.MORPHEUS_SMOKE_JSON_PATH || 'price') || 'price';
const script = trimString(process.env.MORPHEUS_SMOKE_SCRIPT || '');
const requestTimeoutMs = Math.max(
  Number(process.env.MORPHEUS_SMOKE_REQUEST_TIMEOUT_MS || 90000),
  60000
);
const callbackTimeoutMs = Math.max(
  Number(process.env.MORPHEUS_SMOKE_CALLBACK_TIMEOUT_MS || 180000),
  120000
);
const explicitRequestWif = trimString(process.env.MORPHEUS_SMOKE_REQUEST_WIF || '');
const preferredRequestSecrets =
  network === 'mainnet'
    ? [
        trimString(process.env.MORPHEUS_RELAYER_NEO_N3_WIF_MAINNET || ''),
        trimString(process.env.NEO_N3_WIF_MAINNET || ''),
        trimString(process.env.MORPHEUS_RELAYER_NEO_N3_WIF || ''),
        trimString(process.env.NEO_N3_WIF || ''),
        trimString(process.env.MORPHEUS_RELAYER_NEO_N3_WIF_TESTNET || ''),
        trimString(process.env.NEO_TESTNET_WIF || ''),
      ]
    : [
        trimString(process.env.MORPHEUS_RELAYER_NEO_N3_WIF_TESTNET || ''),
        trimString(process.env.NEO_TESTNET_WIF || ''),
        trimString(process.env.MORPHEUS_RELAYER_NEO_N3_WIF || ''),
        trimString(process.env.NEO_N3_WIF || ''),
        trimString(process.env.MORPHEUS_RELAYER_NEO_N3_WIF_MAINNET || ''),
      ];
const requestSecret = explicitRequestWif || preferredRequestSecrets.find((value) => value) || '';
const requestSigner = requestSecret ? materializeNeoN3Secret(requestSecret) : null;
const updaterEnv = { ...process.env };
if (explicitRequestWif) {
  delete updaterEnv.MORPHEUS_SMOKE_REQUEST_WIF;
  delete updaterEnv.NEO_N3_WIF;
  delete updaterEnv.NEO_TESTNET_WIF;
}
const updaterSigner = reportPinnedNeoN3Role(network, 'updater', {
  env: updaterEnv,
  allowMissing: true,
});
const updaterWif = updaterSigner.materialized?.wif || updaterSigner.materialized?.private_key || '';
const verifierSigner = reportPinnedNeoN3Role(network, 'oracle_verifier', {
  allowMissing: true,
});
const verifierSecret =
  verifierSigner.materialized?.wif || verifierSigner.materialized?.private_key || '';

if (!requestSigner) {
  throw new Error(
    'MORPHEUS_SMOKE_REQUEST_WIF, NEO_N3_WIF, NEO_TESTNET_WIF, or MORPHEUS_RELAYER_NEO_N3_WIF is required'
  );
}
if (!oracleHash) throw new Error('CONTRACT_MORPHEUS_ORACLE_HASH is required');
if (!callbackHash) throw new Error('CONTRACT_ORACLE_CALLBACK_CONSUMER_HASH is required');

const payload = {
  provider,
  symbol,
  json_path: jsonPath,
};
if (script) payload.script = script;

const account = new wallet.Account(requestSigner.wif || requestSigner.private_key);
const updaterAccount = updaterWif ? new wallet.Account(updaterWif) : account;
const verifierAccount = verifierSecret ? new wallet.Account(verifierSecret) : null;
const oracle = new experimental.SmartContract(oracleHash, {
  rpcAddress: rpcUrl,
  networkMagic,
  account,
});
const rpcClient = new neoRpc.RPCClient(rpcUrl);
const gasBudget = await ensureGasBudget(rpcClient, account);
const fallbackUpdaterMinGasRaw = parseGasToRaw(
  process.env.MORPHEUS_SMOKE_FALLBACK_UPDATER_MIN_GAS,
  3000000n
);
let updaterGasTopup = null;
if (updaterAccount.scriptHash !== account.scriptHash) {
  updaterGasTopup = await ensureAccountGasBalance({
    rpcClient,
    rpcUrl,
    networkMagic,
    fundingAccount: account,
    targetScriptHash: updaterAccount.scriptHash,
    minGasRaw: fallbackUpdaterMinGasRaw,
  });
}
const feeStatus = await ensureRequestFeeCredit(
  account,
  rpcUrl,
  networkMagic,
  rpcClient,
  oracleHash
);
console.error(
  `Neo N3 smoke fee credit ready: request_fee=${feeStatus.request_fee} current_credit=${feeStatus.current_credit}`
);

const txid = await oracle.invoke('request', [
  sc.ContractParam.string(requestType),
  sc.ContractParam.byteArray(Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')),
  sc.ContractParam.hash160(callbackHash),
  sc.ContractParam.string('onOracleResult'),
]);
console.error(`Neo N3 smoke request txid: ${txid}`);

const requestId = await waitForRequestId(rpcClient, txid, requestTimeoutMs);
const requestRecord = await fetchRequestRecord(rpcClient, oracleHash, requestId);
const fallbackSigningContext = resolveFulfillmentSigningContext({ requestRecord });
const callback = await resolveCallbackWithLocalFallback({
  requestId,
  callbackTimeoutMs,
  waitForCallback: (timeoutMs) => waitForCallback(rpcClient, callbackHash, requestId, timeoutMs),
  onTimeout: () => {
    console.error(
      `Neo N3 smoke callback timeout for request ${requestId}, attempting local fulfill fallback...`
    );
  },
  beforeLocalFallback: async () => {
    if (updaterAccount.scriptHash !== account.scriptHash) {
      const fallbackTopup = await ensureAccountGasBalance({
        rpcClient,
        rpcUrl,
        networkMagic,
        fundingAccount: account,
        targetScriptHash: updaterAccount.scriptHash,
        minGasRaw: fallbackUpdaterMinGasRaw,
        timeoutMs: 90000,
      });
      updaterGasTopup = {
        ...(updaterGasTopup || {}),
        on_fallback: fallbackTopup,
      };
    }
    if (!updaterWif) {
      const reason = updaterSigner.issues.length
        ? updaterSigner.issues.join('; ')
        : 'no pinned updater signer materialized';
      throw new Error(
        `Neo N3 smoke callback fallback unavailable because updater signer is not configured: ${reason}`
      );
    }
    if (!verifierAccount) {
      const reason = verifierSigner.issues.length
        ? verifierSigner.issues.join('; ')
        : 'no pinned oracle verifier signer materialized';
      throw new Error(
        `Neo N3 smoke callback fallback unavailable because oracle verifier signer is not configured: ${reason}`
      );
    }
  },
  fulfillRequestLocally: async () => {
    const fallbackResultText = JSON.stringify(
      buildOnchainResultEnvelope(requestType, {
        ok: true,
        body: {
          provider,
          symbol,
          price: '0',
          smoke_fallback: true,
        },
      })
    );
    await fulfillRequestLocally(
      rpcClient,
      oracleHash,
      updaterAccount,
      verifierAccount,
      rpcUrl,
      networkMagic,
      requestId,
      requestType,
      fallbackResultText,
      fallbackSigningContext
    );
  },
});
const summary = {
  txid,
  request_id: requestId,
  request_record_shape: requestRecord?.request_shape || 'unknown',
  request_signer: account.address,
  fallback_signing_context: fallbackSigningContext,
  fallback_updater_signer: updaterAccount.address,
  fallback_updater_ready: Boolean(updaterWif),
  fallback_updater_issues: updaterSigner.issues,
  fallback_verifier_signer: verifierAccount?.address || null,
  fallback_verifier_ready: Boolean(verifierAccount),
  fallback_verifier_issues: verifierSigner.issues,
  fallback_updater_gas_topup: updaterGasTopup,
  gas_budget: gasBudget,
  request_fee: feeStatus.request_fee,
  request_credit: feeStatus.current_credit,
  provider,
  symbol,
  callback,
};

console.log(JSON.stringify(summary, null, 2));
if (!callback.success) {
  console.error(
    `Neo N3 smoke callback failed for request ${requestId}: ${callback.error_text || 'unknown error'}`
  );
  process.exitCode = 1;
}
