import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { experimental, rpc as neoRpc, sc, tx, u, wallet } from '@cityofzion/neon-js';
import {
  encodeUtf8Base64,
  jsonPretty,
  loadExampleEnv,
  normalizeHash160,
  readDeploymentRegistry,
  repoRoot,
  resolveNeoN3SignerWif,
  sleep,
  trimString,
  writeValidationArtifacts,
  withRetries,
} from './common.mjs';

const GAS_HASH = '0xd2a4cff31913016155e38e474a2c06d08be276cf';
const EXAMPLE_BUILD_DIR = path.resolve(repoRoot, 'examples/build/n3');
const EXAMPLE_CONSUMER_ARTIFACT = 'UserConsumerN3OracleExample';
const REGISTRY_BUILD_DIR = path.resolve(repoRoot, 'contracts/build');
const REGISTRY_ARTIFACT = 'NeoDIDRegistry';
const NEODID_MATRIX_LATEST = path.resolve(
  repoRoot,
  'examples/deployments/n3-neodid-oracle-matrix.testnet.latest.json'
);

function assertCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function byteArrayParam(hexValue) {
  return sc.ContractParam.byteArray(
    u.HexString.fromHex(String(hexValue || '').replace(/^0x/i, ''), true)
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

async function contractExists(rpcClient, hash) {
  if (!hash) return false;
  try {
    await rpcClient.getContractState(hash);
    return true;
  } catch {
    return false;
  }
}

async function loadContractArtifacts(baseName, buildDir) {
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

function decodeDeployHash(appLog) {
  const notification = appLog?.executions
    ?.flatMap((execution) => execution.notifications || [])
    .find((entry) => entry.eventname === 'Deploy');
  const value = notification?.state?.value?.[0]?.value || '';
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length !== 20) throw new Error('failed to decode deployed Neo N3 contract hash');
  return `0x${Buffer.from(bytes).reverse().toString('hex')}`;
}

function ensureRegistryArtifacts() {
  const nefPath = path.join(REGISTRY_BUILD_DIR, `${REGISTRY_ARTIFACT}.nef`);
  const manifestPath = path.join(REGISTRY_BUILD_DIR, `${REGISTRY_ARTIFACT}.manifest.json`);
  if (existsSync(nefPath) && existsSync(manifestPath)) return;
  const compile = spawnSync('nccs', ['NeoDIDRegistry.csproj', '-o', '../build'], {
    cwd: path.resolve(repoRoot, 'contracts/NeoDIDRegistry'),
    stdio: 'inherit',
  });
  if (compile.status !== 0) {
    throw new Error(`failed to compile ${REGISTRY_ARTIFACT}`);
  }
}

async function deployRegistry(rpcClient, account, rpcUrl, networkMagic) {
  ensureRegistryArtifacts();
  const { nef, manifestJson } = await loadContractArtifacts(REGISTRY_ARTIFACT, REGISTRY_BUILD_DIR);
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
  return {
    txid,
    hash: decodeDeployHash(appLog),
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
  const forceDeploy = ['1', 'true', 'yes'].includes(
    trimString(process.env.MORPHEUS_FORCE_DEPLOY_EXAMPLE_CONSUMER).toLowerCase()
  );
  let resolvedHash = forceDeploy ? '' : normalizeHash160(consumerHash);

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

async function sendInvocationTransaction({ rpcClient, account, networkMagic, script, signers }) {
  const preview = await rpcClient.invokeScript(u.HexString.fromHex(script), signers);
  const validUntilBlock = (await rpcClient.getBlockCount()) + 1000;
  const basePayload = {
    signers,
    validUntilBlock,
    script,
    systemFee: preview?.gasconsumed || '1000000',
  };

  let transaction = new tx.Transaction(basePayload);
  transaction.sign(account, networkMagic);
  const networkFee = await rpcClient.calculateNetworkFee(transaction);

  transaction = new tx.Transaction({
    ...basePayload,
    networkFee,
  });
  transaction.sign(account, networkMagic);

  const txid = await rpcClient.sendRawTransaction(transaction);
  const appLog = await waitForApplicationLog(rpcClient, txid);
  return {
    txid,
    preview,
    networkFee: String(networkFee),
    systemFee: preview?.gasconsumed || '0',
    appLog,
    execution: appLog?.executions?.[0] || {},
  };
}

function decodeActionTicketV1(resultBytes) {
  const bytes = Buffer.isBuffer(resultBytes) ? resultBytes : Buffer.from(resultBytes);
  assertCondition(bytes.length >= 1 + 20 + 1 + 32 + 64, 'compact action ticket v1 is too short');
  assertCondition(bytes[0] === 0x01, 'unsupported compact action ticket version');
  const disposableAccount = `0x${bytes.subarray(1, 21).toString('hex')}`;
  const actionIdLength = bytes[21];
  const actionIdStart = 22;
  const actionIdEnd = actionIdStart + actionIdLength;
  const actionId = bytes.subarray(actionIdStart, actionIdEnd).toString('utf8');
  const nullifierStart = actionIdEnd;
  const nullifierEnd = nullifierStart + 32;
  const signatureEnd = nullifierEnd + 64;
  const actionNullifier = `0x${bytes.subarray(nullifierStart, nullifierEnd).toString('hex')}`;
  const signature = `0x${bytes.subarray(nullifierEnd, signatureEnd).toString('hex')}`;
  return {
    disposable_account: disposableAccount,
    action_id: actionId,
    action_nullifier: actionNullifier,
    signature,
  };
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

async function ensureConsumerCredit(
  consumer,
  rpcClient,
  oracleHash,
  consumerHash,
  requestFee,
  requiredRequests,
  { account, rpcUrl, networkMagic, signers }
) {
  let callbackCredit = BigInt(
    (await invokeRead(rpcClient, oracleHash, 'feeCreditOf', [
      { type: 'Hash160', value: consumerHash },
    ])) || '0'
  );
  let depositTxid = null;
  const requiredCredit = requestFee * BigInt(requiredRequests);
  if (callbackCredit < requiredCredit) {
    let contractGasBalance = BigInt(
      (await invokeRead(rpcClient, consumerHash, 'contractGasBalance', []).catch(() => '0')) || '0'
    );
    const deficit = requiredCredit - callbackCredit;
    let fundingTxid = null;
    if (contractGasBalance < deficit) {
      const gas = new experimental.SmartContract(GAS_HASH, {
        rpcAddress: rpcUrl,
        networkMagic,
        account,
      });
      fundingTxid = await gas.invoke(
        'transfer',
        [
          sc.ContractParam.hash160(`0x${account.scriptHash}`),
          sc.ContractParam.hash160(consumerHash),
          sc.ContractParam.integer(deficit.toString()),
          sc.ContractParam.any(null),
        ],
        [new tx.Signer({ account: account.scriptHash, scopes: tx.WitnessScope.CalledByEntry })]
      );
      await waitForApplicationLog(rpcClient, fundingTxid);
      const balanceDeadline = Date.now() + 60000;
      while (Date.now() < balanceDeadline) {
        contractGasBalance = BigInt(
          (await invokeRead(rpcClient, consumerHash, 'contractGasBalance', []).catch(() => '0')) ||
            '0'
        );
        if (contractGasBalance >= deficit) break;
        await sleep(2000);
      }
    }
    assertCondition(
      contractGasBalance >= deficit,
      'example callback consumer lacks enough GAS to top up Oracle credit'
    );
    depositTxid = await consumer.invoke(
      'depositOracleCredits',
      [sc.ContractParam.integer(deficit.toString())],
      signers
    );
    await waitForApplicationLog(rpcClient, depositTxid);
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      callbackCredit = BigInt(
        (await invokeRead(rpcClient, oracleHash, 'feeCreditOf', [
          { type: 'Hash160', value: consumerHash },
        ])) || '0'
      );
      if (callbackCredit >= requiredCredit) break;
      await sleep(2000);
    }
    assertCondition(
      callbackCredit >= requiredCredit,
      'callback consumer top-up did not produce enough request fee credit'
    );
    return {
      callback_credit: callbackCredit.toString(),
      deposit_amount: deficit.toString(),
      deposit_txid: depositTxid,
      funding_txid: fundingTxid,
    };
  }
  return {
    callback_credit: callbackCredit.toString(),
    deposit_amount: '0',
    deposit_txid: depositTxid,
    funding_txid: null,
  };
}

async function main() {
  await loadExampleEnv();
  const deployment = (await readDeploymentRegistry('testnet')).neo_n3 || {};
  const rpcUrl = trimString(
    deployment.rpc_url || process.env.NEO_RPC_URL || 'https://testnet1.neo.coz.io:443'
  );
  const networkMagic = Number(
    deployment.network_magic || process.env.NEO_NETWORK_MAGIC || 894710606
  );
  const signerWif = resolveNeoN3SignerWif('testnet');
  const oracleHash = normalizeHash160(
    deployment.oracle_hash || process.env.CONTRACT_MORPHEUS_ORACLE_HASH || ''
  );
  const consumerHash = normalizeHash160(
    deployment.example_consumer_hash || process.env.EXAMPLE_N3_CONSUMER_HASH || ''
  );

  assertCondition(signerWif, 'NEO_TESTNET_WIF or compatible Neo N3 WIF is required');
  assertCondition(oracleHash, 'testnet oracle hash is required');
  assertCondition(consumerHash, 'testnet example consumer hash is required');

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
  const consumer = new experimental.SmartContract(resolvedConsumerHash, {
    rpcAddress: rpcUrl,
    networkMagic,
    account,
  });
  const signers = [new tx.Signer({ account: account.scriptHash, scopes: tx.WitnessScope.Global })];

  const requestFee = BigInt((await invokeRead(rpcClient, oracleHash, 'requestFee', [])) || '0');
  const feeStatus = await ensureConsumerCredit(
    consumer,
    rpcClient,
    oracleHash,
    resolvedConsumerHash,
    requestFee,
    2,
    {
      account,
      rpcUrl,
      networkMagic,
      signers,
    }
  );

  const actionPayload = {
    provider: 'github',
    provider_uid: 'alice-gh-registry-v1',
    disposable_account: `0x${account.scriptHash}`,
    action_id: `vote:registry-v1:${Date.now()}`,
    callback_encoding: 'neo_n3_action_v1',
  };

  const requestTxid = await consumer.invoke(
    'requestRaw',
    [
      'neodid_action_ticket',
      sc.ContractParam.byteArray(encodeUtf8Base64(JSON.stringify(actionPayload))),
    ],
    signers
  );
  const requestId = await waitForRequestId(rpcClient, requestTxid);
  const rawCallback = await fetchRawCallbackResult(rpcClient, resolvedConsumerHash, requestId);
  assertCondition(rawCallback.success === true, 'action ticket callback should succeed');
  const compactTicket = decodeActionTicketV1(rawCallback.resultBytes);
  assertCondition(
    compactTicket.disposable_account.toLowerCase() === `0x${account.scriptHash}`.toLowerCase(),
    'compact ticket disposable account mismatch'
  );

  const latestMatrix = JSON.parse(await fs.readFile(NEODID_MATRIX_LATEST, 'utf8'));
  const verifierPublicKey =
    latestMatrix.cases?.find((item) => item.request_type === 'neodid_action_ticket')?.callback
      ?.result_json?.verification?.public_key || '';
  assertCondition(
    trimString(verifierPublicKey),
    'failed to resolve NeoDID verifier public key from latest matrix artifact'
  );

  const registry = await deployRegistry(rpcClient, account, rpcUrl, networkMagic);
  const registryContract = new experimental.SmartContract(registry.hash, {
    rpcAddress: rpcUrl,
    networkMagic,
    account,
  });
  const setVerifierTxid = await registryContract.invoke(
    'setVerifier',
    [sc.ContractParam.publicKey(verifierPublicKey)],
    signers
  );
  await waitForApplicationLog(rpcClient, setVerifierTxid);

  const wrongWitnessPreview = await registryContract.testInvoke(
    'useActionTicket',
    [
      sc.ContractParam.hash160(`0x${new wallet.Account().scriptHash}`),
      sc.ContractParam.string(compactTicket.action_id),
      byteArrayParam(compactTicket.action_nullifier),
      byteArrayParam(compactTicket.signature),
    ],
    signers
  );
  assertCondition(
    String(wrongWitnessPreview?.state || '').includes('FAULT'),
    'wrong-witness preview should fault'
  );
  assertCondition(
    /unauthorized/i.test(String(wrongWitnessPreview?.exception || '')),
    'wrong-witness preview should fail unauthorized'
  );

  const useActionScript = sc.createScript({
    scriptHash: registry.hash.replace(/^0x/i, ''),
    operation: 'useActionTicket',
    args: [
      sc.ContractParam.hash160(`0x${account.scriptHash}`),
      sc.ContractParam.string(compactTicket.action_id),
      byteArrayParam(compactTicket.action_nullifier),
      byteArrayParam(compactTicket.signature),
    ],
  });
  const consumeTx = await sendInvocationTransaction({
    rpcClient,
    account,
    networkMagic,
    script: useActionScript,
    signers,
  });
  const consumeVmState = String(consumeTx.execution.vmstate || consumeTx.execution.state || '');
  assertCondition(
    consumeVmState.includes('HALT'),
    `compact ticket consumption should HALT, got ${consumeVmState} ${consumeTx.execution.exception || ''}`
  );

  const replayTx = await sendInvocationTransaction({
    rpcClient,
    account,
    networkMagic,
    script: useActionScript,
    signers,
  });
  const replayVmState = String(replayTx.execution.vmstate || replayTx.execution.state || '');
  const replayException = String(replayTx.execution.exception || '');
  assertCondition(replayVmState.includes('FAULT'), 'replay should fault');
  assertCondition(
    /action nullifier already used/i.test(replayException),
    'replay should fail with action nullifier already used'
  );

  const generatedAt = new Date().toISOString();
  const jsonReport = {
    generated_at: generatedAt,
    network: 'testnet',
    rpc_url: rpcUrl,
    network_magic: networkMagic,
    oracle_hash: oracleHash,
    callback_consumer_hash: consumerHash,
    registry_hash: registry.hash,
    request_fee_status: {
      request_fee: requestFee.toString(),
      ...feeStatus,
    },
    action_request: {
      txid: requestTxid,
      request_id: String(requestId),
      payload: actionPayload,
    },
    compact_ticket: compactTicket,
    wrong_witness_preview: {
      state: wrongWitnessPreview?.state || '',
      exception: wrongWitnessPreview?.exception || '',
    },
    consume_probe: {
      set_verifier_txid: setVerifierTxid,
      txid: consumeTx.txid,
      vmstate: consumeVmState,
      stack: consumeTx.execution.stack || [],
      exception: String(consumeTx.execution.exception || ''),
    },
    replay_probe: {
      txid: replayTx.txid,
      vmstate: replayVmState,
      exception: replayException,
    },
  };

  const markdownReport = [
    '# N3 NeoDID Registry V1 Ticket Validation',
    '',
    `Date: ${generatedAt}`,
    '',
    '## Scope',
    '',
    'This probe verifies the compact `neo_n3_action_v1` callback path for Oracle-issued NeoDID action tickets and checks whether `NeoDIDRegistry.UseActionTicket(...)` can consume and replay-protect those compact tickets on-chain.',
    '',
    '## Result',
    '',
    `- Oracle request tx: \`${requestTxid}\``,
    `- Request id: \`${requestId}\``,
    `- Registry hash: \`${registry.hash}\``,
    `- Wrong witness preview exception: \`${wrongWitnessPreview?.exception || ''}\``,
    `- Consume tx: \`${consumeTx.txid}\``,
    `- Consume vmstate: \`${consumeVmState}\``,
    `- Replay tx: \`${replayTx.txid}\``,
    `- Replay exception: \`${replayException}\``,
    '',
    '## Conclusion',
    '',
    'The compact `neo_n3_action_v1` callback path is consumable by `NeoDIDRegistry.UseActionTicket(...)`. Correct witness succeeds, wrong witness is rejected, and replay is rejected with `action nullifier already used`.',
    '',
  ].join('\n');

  const artifacts = await writeValidationArtifacts({
    baseName: 'n3-neodid-registry-v1',
    network: 'testnet',
    generatedAt,
    jsonReport,
    markdownReport,
  });

  console.log(
    JSON.stringify(
      {
        ...artifacts,
        request_txid: requestTxid,
        request_id: String(requestId),
        registry_hash: registry.hash,
        consume_txid: consumeTx.txid,
        replay_txid: replayTx.txid,
        replay_exception: replayException,
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
