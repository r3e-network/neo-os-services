import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
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
  tryParseJson,
  writeValidationArtifacts,
  withRetries,
} from './common.mjs';

const GAS_HASH = '0xd2a4cff31913016155e38e474a2c06d08be276cf';
const EXAMPLE_BUILD_DIR = path.resolve(repoRoot, 'examples/build/n3');
const EXAMPLE_CONSUMER_ARTIFACT = 'UserConsumerN3OracleExample';
const REGISTRY_BUILD_DIR = path.resolve(repoRoot, 'contracts/build');
const REGISTRY_ARTIFACT = 'NeoDIDRegistry';

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
  requiredRequests,
  callbackContract = ''
) {
  const requesterCredit = BigInt(
    (await invokeRead(rpcClient, oracleHash, 'feeCreditOf', [
      { type: 'Hash160', value: `0x${account.scriptHash}` },
    ])) || '0'
  );
  const callbackCredit = callbackContract
    ? BigInt(
        (await invokeRead(rpcClient, oracleHash, 'feeCreditOf', [
          { type: 'Hash160', value: callbackContract },
        ]).catch(() => '0')) || '0'
      )
    : 0n;
  const requestFee = BigInt((await invokeRead(rpcClient, oracleHash, 'requestFee', [])) || '0');
  const requiredCredit = requestFee * BigInt(requiredRequests);
  if (requestFee <= 0n || requesterCredit >= requiredCredit || callbackCredit >= requiredCredit) {
    return {
      request_fee: requestFee.toString(),
      requester_credit: requesterCredit.toString(),
      callback_credit: callbackCredit.toString(),
      deposit_amount: '0',
    };
  }

  const deficit = requiredCredit - requesterCredit;
  const signers = [{ account: account.scriptHash, scopes: tx.WitnessScope.CalledByEntry }];
  const transferScript = sc.createScript({
    scriptHash: GAS_HASH.replace(/^0x/i, ''),
    operation: 'transfer',
    args: [
      sc.ContractParam.hash160(`0x${account.scriptHash}`),
      sc.ContractParam.hash160(oracleHash),
      sc.ContractParam.integer(deficit.toString()),
      sc.ContractParam.any(null),
    ],
  });
  const transfer = await sendInvocationTransaction({
    rpcClient,
    account,
    networkMagic,
    script: transferScript,
    signers,
  });
  const transferVmState = String(transfer.execution.vmstate || transfer.execution.state || '');
  if (!transferVmState.includes('HALT')) {
    throw new Error(
      `request fee top-up failed: ${transfer.execution.exception || transferVmState}`
    );
  }

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
        requester_credit: updatedCredit.toString(),
        callback_credit: callbackCredit.toString(),
        deposit_amount: deficit.toString(),
      };
    }
    await sleep(2000);
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

async function ensureConsumerCredit(
  consumer,
  rpcClient,
  oracleHash,
  consumerHash,
  requestFee,
  { account, networkMagic, signers }
) {
  let callbackCredit = BigInt(
    (await invokeRead(rpcClient, oracleHash, 'feeCreditOf', [
      { type: 'Hash160', value: consumerHash },
    ])) || '0'
  );
  let depositTxid = null;
  if (callbackCredit < requestFee) {
    let contractGasBalance = BigInt(
      (await invokeRead(rpcClient, consumerHash, 'contractGasBalance', []).catch(() => '0')) || '0'
    );
    const deficit = requestFee - callbackCredit;
    let fundingTxid = null;
    if (contractGasBalance < deficit) {
      const fundScript = sc.createScript({
        scriptHash: GAS_HASH.replace(/^0x/i, ''),
        operation: 'transfer',
        args: [
          sc.ContractParam.hash160(`0x${account.scriptHash}`),
          sc.ContractParam.hash160(consumerHash),
          sc.ContractParam.integer(deficit.toString()),
          sc.ContractParam.any(null),
        ],
      });
      const funded = await sendInvocationTransaction({
        rpcClient,
        account,
        networkMagic,
        script: fundScript,
        signers: [{ account: account.scriptHash, scopes: tx.WitnessScope.CalledByEntry }],
      });
      const fundingVmState = String(funded.execution.vmstate || funded.execution.state || '');
      assertCondition(
        fundingVmState.includes('HALT'),
        `consumer funding failed: ${funded.execution.exception || fundingVmState}`
      );
      fundingTxid = funded.txid;
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
      if (callbackCredit >= requestFee) break;
      await sleep(2000);
    }
    assertCondition(
      callbackCredit >= requestFee,
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

function ensureRegistryArtifacts() {
  const nefPath = path.join(REGISTRY_BUILD_DIR, `${REGISTRY_ARTIFACT}.nef`);
  const manifestPath = path.join(REGISTRY_BUILD_DIR, `${REGISTRY_ARTIFACT}.manifest.json`);
  const needsBuild = !existsSync(nefPath) || !existsSync(manifestPath);
  if (!needsBuild) return;
  const compile = spawnSync('nccs', ['NeoDIDRegistry.csproj', '-o', '../build'], {
    cwd: path.resolve(repoRoot, 'contracts/NeoDIDRegistry'),
    stdio: 'inherit',
  });
  if (compile.status !== 0) {
    throw new Error(`failed to compile ${REGISTRY_ARTIFACT}`);
  }
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

async function invokePersisted(
  contractHash,
  operation,
  params,
  { account, rpcUrl, networkMagic, signers }
) {
  const contract = new experimental.SmartContract(contractHash, {
    rpcAddress: rpcUrl,
    networkMagic,
    account,
  });
  const txid = await contract.invoke(operation, params, signers);
  const appLog = await waitForApplicationLog(new neoRpc.RPCClient(rpcUrl), txid);
  return {
    txid,
    appLog,
    execution: appLog?.executions?.[0] || {},
  };
}

async function testInvoke(
  contractHash,
  operation,
  params,
  { account, rpcUrl, networkMagic, signers }
) {
  const contract = new experimental.SmartContract(contractHash, {
    rpcAddress: rpcUrl,
    networkMagic,
    account,
  });
  return contract.testInvoke(operation, params, signers);
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
    networkFee: String(networkFee),
    systemFee: preview?.gasconsumed || '0',
    preview,
    appLog,
    execution: appLog?.executions?.[0] || {},
  };
}

function decodeActionTicketFromCallback(callback, signerScriptHash) {
  const result = callback?.result_json?.result || {};
  const verification = callback?.result_json?.verification || {};
  return {
    disposable_account: `0x${signerScriptHash}`,
    action_id: result.action_id,
    action_nullifier: result.action_nullifier,
    digest: result.digest,
    verification_signature: verification.signature,
    verification_public_key: verification.public_key,
  };
}

async function main() {
  await loadExampleEnv();
  const deployment = (await readDeploymentRegistry('testnet')).neo_n3 || {};
  const network = trimString(process.env.MORPHEUS_NETWORK || 'testnet').toLowerCase();
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
  const signerWif = resolveNeoN3SignerWif('testnet');
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

  assertCondition(signerWif, 'NEO_TESTNET_WIF or compatible Neo N3 WIF is required');
  assertCondition(oracleHash, 'testnet oracle hash is required');
  assertCondition(consumerHash, 'testnet example consumer hash is required');
  console.log(
    jsonPretty({
      phase: 'config',
      network,
      rpc_url: rpcUrl,
      oracle_hash: oracleHash,
      consumer_hash: consumerHash,
    })
  );

  const account = new wallet.Account(signerWif);
  const rpcClient = new neoRpc.RPCClient(rpcUrl);
  const resolvedConsumerHash = consumerHash;
  assertCondition(
    await contractExists(rpcClient, resolvedConsumerHash),
    'configured testnet example consumer does not exist'
  );
  const consumer = new experimental.SmartContract(resolvedConsumerHash, {
    rpcAddress: rpcUrl,
    networkMagic,
    account,
  });
  const signers = [new tx.Signer({ account: account.scriptHash, scopes: tx.WitnessScope.Global })];

  const requestFee = BigInt((await invokeRead(rpcClient, oracleHash, 'requestFee', [])) || '0');
  const requesterCredit = String(
    (await invokeRead(rpcClient, oracleHash, 'feeCreditOf', [
      { type: 'Hash160', value: `0x${account.scriptHash}` },
    ])) || '0'
  );
  let callbackCredit = BigInt(
    (await invokeRead(rpcClient, oracleHash, 'feeCreditOf', [
      { type: 'Hash160', value: resolvedConsumerHash },
    ])) || '0'
  );
  console.log(
    jsonPretty({
      phase: 'fee_probe',
      oracle_hash: oracleHash,
      callback_consumer_hash: resolvedConsumerHash,
      request_fee: requestFee.toString(),
      callback_credit: callbackCredit.toString(),
      requester_credit: requesterCredit,
    })
  );
  const consumerCreditStatus = await ensureConsumerCredit(
    consumer,
    rpcClient,
    oracleHash,
    resolvedConsumerHash,
    requestFee,
    {
      account,
      networkMagic,
      signers,
    }
  );
  callbackCredit = BigInt(consumerCreditStatus.callback_credit || '0');
  const feeStatus = {
    request_fee: requestFee.toString(),
    requester_credit: requesterCredit,
    callback_credit: callbackCredit.toString(),
    deposit_amount: consumerCreditStatus.deposit_amount,
    funding_txid: consumerCreditStatus.funding_txid,
    deposit_txid: consumerCreditStatus.deposit_txid,
  };

  const actionPayload = {
    provider: 'github',
    provider_uid: 'alice-gh-registry-gap',
    disposable_account: `0x${account.scriptHash}`,
    action_id: `vote:registry-gap:${Date.now()}`,
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
  const callback = await waitForCallback(rpcClient, resolvedConsumerHash, requestId);
  assertCondition(callback?.success === true, 'action ticket callback should succeed');

  const actionTicket = decodeActionTicketFromCallback(callback, account.scriptHash);
  assertCondition(actionTicket.action_id, 'action ticket action_id missing');
  assertCondition(actionTicket.action_nullifier, 'action ticket action_nullifier missing');
  assertCondition(
    actionTicket.verification_signature,
    'action ticket verification signature missing'
  );
  assertCondition(
    actionTicket.verification_public_key,
    'action ticket verification public key missing'
  );

  const registry = await deployRegistry(rpcClient, account, rpcUrl, networkMagic);
  const registryContract = new experimental.SmartContract(registry.hash, {
    rpcAddress: rpcUrl,
    networkMagic,
    account,
  });
  const setVerifierTxid = await registryContract.invoke(
    'setVerifier',
    [sc.ContractParam.publicKey(actionTicket.verification_public_key)],
    signers
  );
  await waitForApplicationLog(rpcClient, setVerifierTxid);

  const wrongWitnessPreview = await testInvoke(
    registry.hash,
    'useActionTicket',
    [
      sc.ContractParam.hash160(`0x${new wallet.Account().scriptHash}`),
      sc.ContractParam.string(actionTicket.action_id),
      byteArrayParam(actionTicket.action_nullifier),
      byteArrayParam(actionTicket.verification_signature),
    ],
    { account, rpcUrl, networkMagic, signers }
  );
  assertCondition(
    String(wrongWitnessPreview?.state || '').includes('FAULT'),
    'wrong-witness preview should fault'
  );
  assertCondition(
    /unauthorized/i.test(String(wrongWitnessPreview?.exception || '')),
    'wrong-witness preview should fail unauthorized'
  );

  const mismatchScript = sc.createScript({
    scriptHash: registry.hash.replace(/^0x/i, ''),
    operation: 'useActionTicket',
    args: [
      sc.ContractParam.hash160(`0x${account.scriptHash}`),
      sc.ContractParam.string(actionTicket.action_id),
      byteArrayParam(actionTicket.action_nullifier),
      byteArrayParam(actionTicket.verification_signature),
    ],
  });
  const mismatchPersisted = await sendInvocationTransaction({
    rpcClient,
    account,
    networkMagic,
    script: mismatchScript,
    signers,
  });

  const vmState = String(
    mismatchPersisted.execution.vmstate || mismatchPersisted.execution.state || ''
  );
  const exception = String(mismatchPersisted.execution.exception || '');
  assertCondition(vmState.includes('FAULT'), 'ticket-consumption mismatch should fault');
  assertCondition(
    /invalid verification signature/i.test(exception),
    'ticket-consumption mismatch should fail with invalid verification signature'
  );

  const generatedAt = new Date().toISOString();
  const jsonReport = {
    generated_at: generatedAt,
    network: 'testnet',
    rpc_url: rpcUrl,
    network_magic: networkMagic,
    oracle_hash: oracleHash,
    callback_consumer_hash: resolvedConsumerHash,
    registry_hash: registry.hash,
    request_fee_status: feeStatus,
    action_request: {
      txid: requestTxid,
      request_id: String(requestId),
      payload: actionPayload,
    },
    callback_ticket: actionTicket,
    wrong_witness_preview: {
      state: wrongWitnessPreview?.state || '',
      exception: wrongWitnessPreview?.exception || '',
    },
    registry_probe: {
      deploy_txid: registry.txid,
      set_verifier_txid: setVerifierTxid,
      use_action_ticket_txid: mismatchPersisted.txid,
      preview_state: mismatchPersisted.preview?.state || '',
      preview_exception: mismatchPersisted.preview?.exception || '',
      system_fee: mismatchPersisted.systemFee,
      network_fee: mismatchPersisted.networkFee,
      vmstate: vmState,
      exception,
    },
  };

  const markdownReport = [
    '# N3 NeoDID Registry Boundary Validation',
    '',
    `Date: ${generatedAt}`,
    '',
    '## Scope',
    '',
    'This probe verifies the current boundary between Oracle-issued NeoDID action-ticket callbacks and on-chain `NeoDIDRegistry.UseActionTicket(...)` consumption.',
    '',
    '## Validated Behaviors',
    '',
    `- Action-ticket request tx: \`${requestTxid}\``,
    `- Request id: \`${requestId}\``,
    `- Callback consumer hash: \`${resolvedConsumerHash}\``,
    `- Registry hash: \`${registry.hash}\``,
    `- Wrong witness preview state: \`${wrongWitnessPreview?.state || ''}\``,
    `- Wrong witness preview exception: \`${wrongWitnessPreview?.exception || ''}\``,
    `- Persisted consumption tx: \`${mismatchPersisted.txid}\``,
    `- Persisted vmstate: \`${vmState}\``,
    `- Persisted exception: \`${exception}\``,
    '',
    '## Conclusion',
    '',
    'The test confirms two things:',
    '',
    '- `NeoDIDRegistry.UseActionTicket(...)` rejects a caller that is not the declared disposable account.',
    '- The current Oracle callback output does not yet expose a ticket-level verification signature that can be consumed directly by `UseActionTicket(...)`; using the envelope-level verification signature faults with `invalid verification signature`.',
    '',
    'This is therefore a real integrated boundary gap rather than a purely theoretical one.',
    '',
  ].join('\n');

  const artifacts = await writeValidationArtifacts({
    baseName: 'n3-neodid-registry-boundary',
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
        wrong_witness_exception: wrongWitnessPreview?.exception || '',
        mismatch_txid: mismatchPersisted.txid,
        mismatch_exception: exception,
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
