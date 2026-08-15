import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { experimental, rpc as neoRpc, sc, tx, wallet } from '@cityofzion/neon-js';
import {
  encryptWithOracleKey,
  encodeUtf8Base64,
  fetchOnchainOraclePublicKey,
  jsonPretty,
  loadExampleEnv,
  normalizeHash160,
  readDeploymentRegistry,
  repoRoot,
  resolveNeoN3SignerWif,
  sleep,
  trimString,
  tryParseJson,
  writeValidationArtifacts,
  withRetries,
} from './common.mjs';

const GAS_HASH = '0xd2a4cff31913016155e38e474a2c06d08be276cf';
const EXAMPLE_BUILD_DIR = path.resolve(repoRoot, 'examples/build/n3');
const EXAMPLE_CONSUMER_ARTIFACT = 'UserConsumerN3OracleExample';
const execFileAsync = promisify(execFile);
const PHALA_SSH_RETRIES = Math.max(1, Number(process.env.PHALA_SSH_RETRIES || 3));

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

async function ensureRequestFeeCredit(
  account,
  rpcUrl,
  networkMagic,
  rpcClient,
  oracleHash,
  requiredRequests
) {
  const requestFee = BigInt((await invokeRead(rpcClient, oracleHash, 'requestFee', [])) || '0');
  const requiredCredit = requestFee * BigInt(requiredRequests);
  let currentCredit = BigInt(
    (await invokeRead(rpcClient, oracleHash, 'feeCreditOf', [
      { type: 'Hash160', value: `0x${account.scriptHash}` },
    ])) || '0'
  );
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
  let totalDeposited = 0n;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    currentCredit = BigInt(
      (await invokeRead(rpcClient, oracleHash, 'feeCreditOf', [
        { type: 'Hash160', value: `0x${account.scriptHash}` },
      ])) || '0'
    );
    if (currentCredit >= requiredCredit) {
      return {
        request_fee: requestFee.toString(),
        current_credit: currentCredit.toString(),
        deposit_amount: totalDeposited.toString(),
      };
    }

    const deficit = requiredCredit - currentCredit;
    const txid = await gas.invoke('transfer', [
      sc.ContractParam.hash160(`0x${account.scriptHash}`),
      sc.ContractParam.hash160(oracleHash),
      sc.ContractParam.integer(deficit.toString()),
      sc.ContractParam.any(null),
    ]);
    totalDeposited += deficit;
    const appLog = await waitForApplicationLog(rpcClient, txid);
    const execution = appLog?.executions?.[0];
    const vmState = String(execution?.vmstate || execution?.state || '');
    assertCondition(
      vmState.includes('HALT'),
      `request fee top-up failed: ${execution?.exception || vmState || txid}`
    );

    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      currentCredit = BigInt(
        (await invokeRead(rpcClient, oracleHash, 'feeCreditOf', [
          { type: 'Hash160', value: `0x${account.scriptHash}` },
        ])) || '0'
      );
      if (currentCredit >= requiredCredit) {
        return {
          request_fee: requestFee.toString(),
          current_credit: currentCredit.toString(),
          deposit_amount: totalDeposited.toString(),
        };
      }
      await sleep(2000);
    }
  }

  throw new Error('timed out waiting for Neo N3 request fee credit');
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

async function waitForCallback(rpcClient, consumerHash, requestId, timeoutMs = 600000) {
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

function decodeDeployHash(appLog) {
  const notification = appLog?.executions
    ?.flatMap((execution) => execution.notifications || [])
    .find((entry) => entry.eventname === 'Deploy');
  const value = notification?.state?.value?.[0]?.value || '';
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length !== 20) throw new Error('failed to decode deployed Neo N3 contract hash');
  return `0x${Buffer.from(bytes).reverse().toString('hex')}`;
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

async function loadContractArtifacts(baseName, buildDir = EXAMPLE_BUILD_DIR) {
  const nefPath = path.join(buildDir, `${baseName}.nef`);
  const manifestPath = path.join(buildDir, `${baseName}.manifest.json`);
  const [nefBytes, manifestRaw] = await Promise.all([
    fs.readFile(nefPath),
    fs.readFile(manifestPath, 'utf8'),
  ]);
  const manifestJson = JSON.parse(manifestRaw);
  return {
    nef: sc.NEF.fromBuffer(nefBytes),
    manifestJson,
    manifest: sc.ContractManifest.fromJson(manifestJson),
  };
}

async function ensureExampleConsumer({
  rpcClient,
  account,
  rpcUrl,
  networkMagic,
  oracleHash,
  consumerHash,
}) {
  const { nef, manifestJson } = await loadContractArtifacts(
    EXAMPLE_CONSUMER_ARTIFACT,
    EXAMPLE_BUILD_DIR
  );
  let resolvedHash = normalizeHash160(consumerHash);

  if (!(await contractExists(rpcClient, resolvedHash))) {
    const uniqueManifest = sc.ContractManifest.fromJson({
      ...manifestJson,
      name: `${manifestJson.name}-${Date.now()}`,
    });
    const txid = await experimental.deployContract(nef, uniqueManifest, {
      account,
      rpcAddress: rpcUrl,
      networkMagic,
      blocksTillExpiry: 200,
    });
    const appLog = await waitForApplicationLog(rpcClient, txid);
    resolvedHash = decodeDeployHash(appLog);
  }

  const currentOracle = normalizeHash160(
    await invokeRead(rpcClient, resolvedHash, 'oracle').catch(() => '')
  );
  const oracleAllowed = Boolean(
    await invokeRead(rpcClient, oracleHash, 'isAllowedCallback', [
      { type: 'Hash160', value: resolvedHash },
    ]).catch(() => false)
  );
  const consumer = new experimental.SmartContract(resolvedHash, {
    rpcAddress: rpcUrl,
    networkMagic,
    account,
  });
  const signers = [new tx.Signer({ account: account.scriptHash, scopes: tx.WitnessScope.Global })];

  if (!oracleAllowed) {
    const oracle = new experimental.SmartContract(oracleHash, {
      rpcAddress: rpcUrl,
      networkMagic,
      account,
    });
    const txid = await oracle.invoke('addAllowedCallback', [
      sc.ContractParam.hash160(resolvedHash),
    ]);
    await waitForApplicationLog(rpcClient, txid);
  }

  if (currentOracle !== oracleHash) {
    const txid = await consumer.invoke(
      'setOracle',
      [sc.ContractParam.hash160(oracleHash)],
      signers
    );
    await waitForApplicationLog(rpcClient, txid);
  }

  return resolvedHash;
}

async function insertEncryptedSecret({
  supabaseUrl,
  serviceRoleKey,
  ciphertext,
  metadata,
  targetChain = 'neo_n3',
  network = 'testnet',
  name,
}) {
  const response = await fetch(
    `${supabaseUrl.replace(/\/$/, '')}/rest/v1/morpheus_encrypted_secrets`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        apikey: serviceRoleKey,
        authorization: `Bearer ${serviceRoleKey}`,
        prefer: 'return=representation',
      },
      body: JSON.stringify({
        name,
        network,
        target_chain: targetChain,
        encryption_algorithm: 'X25519-HKDF-SHA256-AES-256-GCM',
        key_version: 1,
        ciphertext,
        metadata,
      }),
    }
  );
  if (!response.ok) {
    throw new Error(`supabase insert failed: ${response.status} ${await response.text()}`);
  }
  const rows = await response.json();
  return Array.isArray(rows) ? rows[0] : rows;
}

async function runPhalaRemoteShell(
  shellScript,
  { phalaApiToken, appId, maxBuffer = 10 * 1024 * 1024 } = {}
) {
  let lastError = null;
  for (let attempt = 1; attempt <= PHALA_SSH_RETRIES; attempt += 1) {
    for (const args of [
      trimString(phalaApiToken)
        ? ['ssh', '--api-token', phalaApiToken, appId, '--', `sh -lc ${shellQuote(shellScript)}`]
        : null,
      ['ssh', appId, '--', `sh -lc ${shellQuote(shellScript)}`],
    ].filter(Boolean)) {
      try {
        const result = await execFileAsync('phala', args, { maxBuffer });
        return result;
      } catch (error) {
        lastError = error;
      }
    }
    if (attempt >= PHALA_SSH_RETRIES) break;
    await sleep(1500 * attempt);
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function getCvmStatus(appId) {
  const { stdout } = await execFileAsync('phala', ['cvms', 'get', appId], {
    maxBuffer: 10 * 1024 * 1024,
  });
  const match = stdout.match(/│\s*Status\s*│\s*([^│\n]+)\s*│/);
  if (!match) throw new Error(`unexpected phala cvms get output: ${stdout}`);
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

async function findRelayerLoopPid({ phalaApiToken, appId }) {
  const { stdout } = await execFileAsync(
    'phala',
    [
      'ssh',
      '--api-token',
      phalaApiToken,
      appId,
      '--',
      `sh -lc ${shellQuote("ps -ef | grep 'node src/cli.js loop' | grep -v grep | awk 'NR==1 {print $1}'")}`,
    ],
    {
      maxBuffer: 10 * 1024 * 1024,
    }
  );
  return trimString(stdout.split(/\r?\n/, 1)[0] || '');
}

async function waitForRelayerState({
  phalaApiToken,
  appId,
  pid,
  shouldBeRunning,
  timeoutMs = 30000,
}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const { stdout } = await execFileAsync(
      'phala',
      [
        'ssh',
        '--api-token',
        phalaApiToken,
        appId,
        '--',
        `sh -lc ${shellQuote(`ps -o pid=,stat=,args= | awk '$1 == ${pid} {print $2}'`)}`,
      ],
      {
        maxBuffer: 10 * 1024 * 1024,
      }
    );
    const status = trimString(stdout.split(/\r?\n/, 1)[0] || '');
    const paused = status.includes('T');
    const running = Boolean(status) && !paused;
    if ((shouldBeRunning && running) || (!shouldBeRunning && paused)) return;
    await sleep(1000);
  }
  throw new Error(`timed out waiting for morpheus-relayer paused=${!shouldBeRunning}`);
}

async function stopRelayer({ phalaApiToken, appId }) {
  try {
    const pid = await findRelayerLoopPid({ phalaApiToken, appId });
    assertCondition(pid, 'morpheus relayer loop pid not found on testnet CVM');
    await runPhalaRemoteShell(`kill -s STOP ${pid}`, { phalaApiToken, appId });
    await waitForRelayerState({ phalaApiToken, appId, pid, shouldBeRunning: false });
    return { mode: 'signal', pid };
  } catch {
    await stopCvm(appId);
    return { mode: 'cvm' };
  }
}

async function startRelayer({ phalaApiToken, appId, handle }) {
  if (!handle) return;
  if (handle.mode === 'cvm') {
    await startCvm(appId);
    return;
  }
  if (!trimString(handle.pid)) return;
  await runPhalaRemoteShell(`kill -s CONT ${handle.pid}`, { phalaApiToken, appId });
  await waitForRelayerState({ phalaApiToken, appId, pid: handle.pid, shouldBeRunning: true });
}

async function buildRemoteEncryptedPatch(plaintext) {
  const oracleKey = await fetchOnchainOraclePublicKey('neo_n3');
  return encryptWithOracleKey(oracleKey.public_key, String(plaintext));
}

async function submitCase({
  consumer,
  rpcClient,
  requestType,
  payload,
  expected,
  validate,
  beforeSubmit,
  afterSubmit,
}) {
  let txid = null;
  try {
    if (beforeSubmit) await beforeSubmit();
    txid = await consumer.invoke(
      'requestRaw',
      [requestType, sc.ContractParam.byteArray(encodeUtf8Base64(JSON.stringify(payload)))],
      [new tx.Signer({ account: consumer.account.scriptHash, scopes: tx.WitnessScope.Global })]
    );
  } finally {
    if (afterSubmit) await afterSubmit(txid).catch(() => {});
  }
  const requestId = await waitForRequestId(rpcClient, txid);
  const callback = await waitForCallback(rpcClient, consumer.scriptHash, requestId);
  const caseResult = {
    title: expected,
    request_type: requestType,
    txid,
    request_id: String(requestId),
    payload,
    callback,
  };
  console.log(jsonPretty(caseResult));
  if (validate) await validate(caseResult);
  return caseResult;
}

async function main() {
  await loadExampleEnv();
  const network = trimString(process.env.MORPHEUS_NETWORK || 'testnet').toLowerCase();
  const deployment = (await readDeploymentRegistry('testnet')).neo_n3 || {};
  const rpcUrl = trimString(
    network === 'testnet'
      ? deployment.rpc_url || process.env.NEO_RPC_URL || 'https://testnet1.neo.coz.io:443'
      : process.env.NEO_RPC_URL || deployment.rpc_url || 'https://testnet1.neo.coz.io:443'
  );
  const networkMagic = Number(
    network === 'testnet'
      ? deployment.network_magic || process.env.NEO_NETWORK_MAGIC || 894710606
      : process.env.NEO_NETWORK_MAGIC || deployment.network_magic || 894710606
  );
  const signerWif = resolveNeoN3SignerWif(network);
  const oracleHash = normalizeHash160(
    network === 'testnet'
      ? deployment.oracle_hash || process.env.CONTRACT_MORPHEUS_ORACLE_HASH || ''
      : process.env.CONTRACT_MORPHEUS_ORACLE_HASH || deployment.oracle_hash || ''
  );
  const consumerHash = normalizeHash160(
    network === 'testnet'
      ? deployment.example_consumer_hash || process.env.EXAMPLE_N3_CONSUMER_HASH || ''
      : process.env.EXAMPLE_N3_CONSUMER_HASH || deployment.example_consumer_hash || ''
  );
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

  assertCondition(network === 'testnet', 'this probe is intended for testnet');
  assertCondition(signerWif, 'testnet signer WIF is required');
  assertCondition(oracleHash, 'testnet oracle hash is required');
  assertCondition(consumerHash, 'testnet example consumer hash is required');
  assertCondition(supabaseUrl && serviceRoleKey, 'Supabase secret or service-role env is required');
  assertCondition(phalaApiToken, 'PHALA_API_TOKEN or PHALA_SHARED_SECRET is required');

  const account = new wallet.Account(signerWif);
  const rpcClient = new neoRpc.RPCClient(rpcUrl);
  const resolvedConsumerHash = await ensureExampleConsumer({
    rpcClient,
    account,
    rpcUrl,
    networkMagic,
    oracleHash,
    consumerHash,
  });
  const requesterHash = `0x${account.scriptHash}`;
  async function refreshRequesterCredit(requiredRequests) {
    return ensureRequestFeeCredit(
      account,
      rpcUrl,
      networkMagic,
      rpcClient,
      oracleHash,
      requiredRequests
    );
  }

  function creditProtectedHooks(requiredRequests) {
    return {
      beforeSubmit: async () => {
        await ensureRequestFeeCredit(
          account,
          rpcUrl,
          networkMagic,
          rpcClient,
          oracleHash,
          requiredRequests
        );
      },
      afterSubmit: async () => {},
    };
  }

  const feeStatus = await refreshRequesterCredit(20);

  const encryptedPatch = await buildRemoteEncryptedPatch(
    JSON.stringify({
      provider_uid: 'encrypted-ref-gh-001',
      claim_value: 'ref-bound-pass',
    })
  );

  const matchingSecret = await insertEncryptedSecret({
    supabaseUrl,
    serviceRoleKey,
    ciphertext: encryptedPatch,
    metadata: {
      source: 'examples.test.n3.encrypted-ref-boundary',
      bound_requester: requesterHash,
      bound_callback_contract: resolvedConsumerHash,
      scenario: 'matching',
    },
    name: `encrypted-ref-match-${Date.now()}`,
  });
  const wrongRequesterSecret = await insertEncryptedSecret({
    supabaseUrl,
    serviceRoleKey,
    ciphertext: encryptedPatch,
    metadata: {
      source: 'examples.test.n3.encrypted-ref-boundary',
      bound_requester: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      bound_callback_contract: resolvedConsumerHash,
      scenario: 'wrong_requester',
    },
    name: `encrypted-ref-requester-${Date.now()}`,
  });
  const wrongCallbackSecret = await insertEncryptedSecret({
    supabaseUrl,
    serviceRoleKey,
    ciphertext: encryptedPatch,
    metadata: {
      source: 'examples.test.n3.encrypted-ref-boundary',
      bound_requester: requesterHash,
      bound_callback_contract: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      scenario: 'wrong_callback',
    },
    name: `encrypted-ref-callback-${Date.now()}`,
  });
  const replaySecret = await insertEncryptedSecret({
    supabaseUrl,
    serviceRoleKey,
    ciphertext: encryptedPatch,
    metadata: {
      source: 'examples.test.n3.encrypted-ref-boundary',
      bound_requester: requesterHash,
      bound_callback_contract: resolvedConsumerHash,
      scenario: 'replay_same_binding',
    },
    name: `encrypted-ref-replay-${Date.now()}`,
  });

  const consumer = new experimental.SmartContract(resolvedConsumerHash, {
    rpcAddress: rpcUrl,
    networkMagic,
    account,
  });
  consumer.scriptHash = resolvedConsumerHash.replace(/^0x/i, '');
  consumer.account = account;

  const basePayload = {
    provider: 'github',
    vault_account: requesterHash,
    claim_type: 'Github_VerifiedUser',
  };

  const successCase = await submitCase({
    consumer,
    rpcClient,
    requestType: 'neodid_bind',
    payload: {
      ...basePayload,
      encrypted_params_ref: matchingSecret.id,
    },
    expected: 'encrypted_params_ref succeeds when requester and callback bindings match',
    validate(result) {
      assertCondition(result.callback?.success === true, 'matching ref callback should succeed');
      assertCondition(
        /^0x[0-9a-f]{64}$/.test(result.callback?.result_json?.result?.master_nullifier || ''),
        'matching ref master_nullifier missing'
      );
    },
    ...creditProtectedHooks(5),
  });

  const requesterMismatchCase = await submitCase({
    consumer,
    rpcClient,
    requestType: 'neodid_bind',
    payload: {
      ...basePayload,
      encrypted_params_ref: wrongRequesterSecret.id,
    },
    expected:
      'encrypted_params_ref fails when bound_requester does not match the relayed requester',
    validate(result) {
      assertCondition(result.callback?.success === false, 'wrong-requester callback should fail');
      assertCondition(
        /encrypted ref requester mismatch/i.test(result.callback?.error_text || ''),
        'wrong-requester error mismatch'
      );
    },
    ...creditProtectedHooks(5),
  });

  const callbackMismatchCase = await submitCase({
    consumer,
    rpcClient,
    requestType: 'neodid_bind',
    payload: {
      ...basePayload,
      encrypted_params_ref: wrongCallbackSecret.id,
    },
    expected:
      'encrypted_params_ref fails when bound_callback_contract does not match the relayed callback contract',
    validate(result) {
      assertCondition(result.callback?.success === false, 'wrong-callback callback should fail');
      assertCondition(
        /encrypted ref callback mismatch/i.test(result.callback?.error_text || ''),
        'wrong-callback error mismatch'
      );
    },
    ...creditProtectedHooks(5),
  });

  const replayFirstUseCase = await submitCase({
    consumer,
    rpcClient,
    requestType: 'neodid_bind',
    payload: {
      ...basePayload,
      encrypted_params_ref: replaySecret.id,
    },
    expected: 'encrypted_params_ref first use succeeds when the binding matches',
    validate(result) {
      assertCondition(
        result.callback?.success === true,
        'first-use replay ref callback should succeed'
      );
    },
    ...creditProtectedHooks(5),
  });

  const replaySecondUseCase = await submitCase({
    consumer,
    rpcClient,
    requestType: 'neodid_bind',
    payload: {
      ...basePayload,
      encrypted_params_ref: replaySecret.id,
    },
    expected:
      'encrypted_params_ref replay fails when the same ref is reused by a different request',
    validate(result) {
      assertCondition(result.callback?.success === false, 'replayed ref callback should fail');
      assertCondition(
        /encrypted ref already consumed by another request/i.test(
          result.callback?.error_text || ''
        ),
        'replayed ref error mismatch'
      );
    },
    ...creditProtectedHooks(5),
  });

  const generatedAt = new Date().toISOString();
  const jsonReport = {
    generated_at: generatedAt,
    network: 'testnet',
    rpc_url: rpcUrl,
    network_magic: networkMagic,
    requester_hash: requesterHash,
    callback_consumer_hash: resolvedConsumerHash,
    oracle_hash: oracleHash,
    request_fee_status: feeStatus,
    secret_refs: {
      matching: matchingSecret.id,
      wrong_requester: wrongRequesterSecret.id,
      wrong_callback: wrongCallbackSecret.id,
      replay: replaySecret.id,
    },
    cases: [
      successCase,
      requesterMismatchCase,
      callbackMismatchCase,
      replayFirstUseCase,
      replaySecondUseCase,
    ],
  };

  const markdownReport = [
    '# N3 Encrypted Ref Boundary Validation',
    '',
    `Date: ${generatedAt}`,
    '',
    '## Scope',
    '',
    'This probe validates the live testnet boundary for `encrypted_params_ref` after requester/callback binding was added to the worker resolution path.',
    '',
    '## Result Summary',
    '',
    `- Matching ref tx: \`${successCase.txid}\` request \`${successCase.request_id}\``,
    `- Wrong requester tx: \`${requesterMismatchCase.txid}\` request \`${requesterMismatchCase.request_id}\``,
    `- Wrong callback tx: \`${callbackMismatchCase.txid}\` request \`${callbackMismatchCase.request_id}\``,
    `- Replay first-use tx: \`${replayFirstUseCase.txid}\` request \`${replayFirstUseCase.request_id}\``,
    `- Replay second-use tx: \`${replaySecondUseCase.txid}\` request \`${replaySecondUseCase.request_id}\``,
    '',
    '## Conclusion',
    '',
    '- A ref bound to the live requester and callback contract succeeds.',
    '- A ref bound to a different requester fails with `encrypted ref requester mismatch`.',
    '- A ref bound to a different callback contract fails with `encrypted ref callback mismatch`.',
    '- Reusing the same encrypted ref from a different request now fails with `encrypted ref already consumed by another request`.',
    '',
  ].join('\n');

  const artifacts = await writeValidationArtifacts({
    baseName: 'n3-encrypted-ref-boundary',
    network: 'testnet',
    generatedAt,
    jsonReport,
    markdownReport,
  });

  console.log(
    JSON.stringify(
      {
        ...artifacts,
        matching_txid: successCase.txid,
        wrong_requester_txid: requesterMismatchCase.txid,
        wrong_callback_txid: callbackMismatchCase.txid,
        replay_first_use_txid: replayFirstUseCase.txid,
        replay_second_use_txid: replaySecondUseCase.txid,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
