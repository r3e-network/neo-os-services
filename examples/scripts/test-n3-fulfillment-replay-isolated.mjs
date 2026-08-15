import fs from 'node:fs/promises';
import path from 'node:path';
import { experimental, rpc as neoRpc, sc, tx, u, wallet } from '@cityofzion/neon-js';
import { buildFulfillmentDigestBytes } from '../../workers/morpheus-relayer/src/router.js';
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
  writeSkippedValidationArtifacts,
  withRetries,
} from './common.mjs';

const GAS_HASH = '0xd2a4cff31913016155e38e474a2c06d08be276cf';
const CONTRACT_BUILD_DIR = path.resolve(repoRoot, 'contracts/build');
const EXAMPLE_BUILD_DIR = path.resolve(repoRoot, 'examples/build/n3');
const SOURCE_CALLBACK_REPORT = path.resolve(
  repoRoot,
  'examples/deployments/n3-encrypted-ref-boundary.testnet.latest.json'
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

function byteArrayParam(hexValue) {
  return sc.ContractParam.byteArray(
    u.HexString.fromHex(String(hexValue || '').replace(/^0x/i, ''), true)
  );
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
  const manifestJson = JSON.parse(manifestRaw);
  return {
    nef: sc.NEF.fromBuffer(nefBytes),
    manifestJson,
  };
}

async function deployContract(
  rpcClient,
  account,
  rpcUrl,
  networkMagic,
  baseName,
  buildDir,
  suffix
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
  return {
    txid,
    hash: decodeDeployHash(appLog),
  };
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
  await gas.invoke('transfer', [
    sc.ContractParam.hash160(`0x${account.scriptHash}`),
    sc.ContractParam.hash160(oracleHash),
    sc.ContractParam.integer(deficit.toString()),
    sc.ContractParam.any(null),
  ]);

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

  throw new Error('timed out waiting for request fee credit');
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
    execution: appLog?.executions?.[0] || {},
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

  assertCondition(signerWif, 'testnet signer WIF is required');

  const account = new wallet.Account(signerWif);
  const rpcClient = new neoRpc.RPCClient(rpcUrl);
  const suffix = `replay-${Date.now()}`;

  const oracle = await deployContract(
    rpcClient,
    account,
    rpcUrl,
    networkMagic,
    'MorpheusOracle',
    CONTRACT_BUILD_DIR,
    suffix
  );
  const consumer = await deployContract(
    rpcClient,
    account,
    rpcUrl,
    networkMagic,
    'UserConsumerN3OracleExample',
    EXAMPLE_BUILD_DIR,
    suffix
  );

  const oracleContract = new experimental.SmartContract(oracle.hash, {
    rpcAddress: rpcUrl,
    networkMagic,
    account,
  });
  const consumerContract = new experimental.SmartContract(consumer.hash, {
    rpcAddress: rpcUrl,
    networkMagic,
    account,
  });
  const signers = [new tx.Signer({ account: account.scriptHash, scopes: tx.WitnessScope.Global })];

  const setUpdaterTxid = await oracleContract.invoke(
    'setUpdater',
    [sc.ContractParam.hash160(`0x${account.scriptHash}`)],
    signers
  );
  assertHalt(await waitForApplicationLog(rpcClient, setUpdaterTxid), 'setUpdater');
  const setVerifierTxid = await oracleContract.invoke(
    'setOracleVerificationPublicKey',
    [sc.ContractParam.publicKey(account.publicKey)],
    signers
  );
  assertHalt(
    await waitForApplicationLog(rpcClient, setVerifierTxid),
    'setOracleVerificationPublicKey'
  );
  const appId = `replay_${suffix}`;
  const registerMiniAppTxid = await oracleContract.invoke(
    'registerMiniApp',
    [
      sc.ContractParam.string(appId),
      sc.ContractParam.hash160(`0x${account.scriptHash}`),
      sc.ContractParam.hash160(`0x${account.scriptHash}`),
      sc.ContractParam.hash160(consumer.hash),
      sc.ContractParam.string('morpheus://validation/fulfillment-replay'),
      sc.ContractParam.string(''),
    ],
    signers
  );
  assertHalt(await waitForApplicationLog(rpcClient, registerMiniAppTxid), 'registerMiniApp');
  const grantIdentityTxid = await oracleContract.invoke(
    'grantModuleToMiniApp',
    [sc.ContractParam.string(appId), sc.ContractParam.string('identity.verify')],
    signers
  );
  assertHalt(await waitForApplicationLog(rpcClient, grantIdentityTxid), 'grantModuleToMiniApp');
  const setOracleTxid = await consumerContract.invoke(
    'setOracle',
    [sc.ContractParam.hash160(oracle.hash)],
    signers
  );
  assertHalt(await waitForApplicationLog(rpcClient, setOracleTxid), 'setOracle');
  const verifierPub = trimString(
    (await invokeRead(rpcClient, oracle.hash, 'oracleVerificationPublicKey', [])) || ''
  ).replace(/^0x/i, '');
  assertCondition(
    verifierPub === account.publicKey,
    `temporary oracle verifier mismatch: ${verifierPub} !== ${account.publicKey}`
  );

  const feeStatus = await ensureRequestFeeCredit(
    account,
    rpcUrl,
    networkMagic,
    rpcClient,
    oracle.hash,
    1
  );

  const sourceReport = JSON.parse(await fs.readFile(SOURCE_CALLBACK_REPORT, 'utf8'));
  const sourceCase = sourceReport.cases?.find(
    (item) => item.callback?.success === true && item.request_type === 'neodid_bind'
  );
  assertCondition(sourceCase?.callback?.result_text, 'failed to load a source callback result');
  const oldSignature = sourceCase.callback.result_json?.verification?.signature || '';
  assertCondition(trimString(oldSignature), 'source callback verification signature missing');

  const requestTxid = await consumerContract.invoke(
    'requestRaw',
    [
      'neodid_bind',
      sc.ContractParam.byteArray(
        encodeUtf8Base64(
          JSON.stringify({
            provider: 'github',
            provider_uid: 'isolated-replay-gh-001',
            vault_account: `0x${account.scriptHash}`,
            claim_type: 'Github_VerifiedUser',
            claim_value: 'isolated-replay-target',
          })
        )
      ),
    ],
    signers
  );
  const requestId = await waitForRequestId(rpcClient, requestTxid);

  const replayScript = sc.createScript({
    scriptHash: oracle.hash.replace(/^0x/i, ''),
    operation: 'fulfillRequest',
    args: [
      sc.ContractParam.integer(String(requestId)),
      sc.ContractParam.boolean(true),
      byteArrayParam(Buffer.from(sourceCase.callback.result_text, 'utf8').toString('hex')),
      sc.ContractParam.string(''),
      byteArrayParam(oldSignature),
    ],
  });
  const replayAttempt = await sendInvocationTransaction({
    rpcClient,
    account,
    networkMagic,
    script: replayScript,
    signers: [{ account: account.scriptHash, scopes: tx.WitnessScope.CalledByEntry }],
  });
  const replayVmState = String(
    replayAttempt.execution.vmstate || replayAttempt.execution.state || ''
  );
  const replayException = String(replayAttempt.execution.exception || '');
  console.log(
    jsonPretty({
      phase: 'replay_attempt',
      txid: replayAttempt.txid,
      vmstate: replayVmState,
      exception: replayException,
    })
  );
  assertCondition(replayVmState.includes('FAULT'), 'replay fulfill attempt should fault');
  assertCondition(
    /invalid verification signature/i.test(replayException),
    'replay fulfill attempt should fail with invalid verification signature'
  );

  const correctSignature = wallet.sign(
    buildFulfillmentDigestBytes(
      requestId,
      'neodid_bind',
      true,
      sourceCase.callback.result_text,
      '',
      '',
      {
        appId,
        moduleId: 'identity.verify',
        operation: 'neodid_bind',
      }
    ).toString('hex'),
    account.privateKey
  );
  const correctScript = sc.createScript({
    scriptHash: oracle.hash.replace(/^0x/i, ''),
    operation: 'fulfillRequest',
    args: [
      sc.ContractParam.integer(String(requestId)),
      sc.ContractParam.boolean(true),
      byteArrayParam(Buffer.from(sourceCase.callback.result_text, 'utf8').toString('hex')),
      sc.ContractParam.string(''),
      byteArrayParam(correctSignature),
    ],
  });
  const fulfillAttempt = await sendInvocationTransaction({
    rpcClient,
    account,
    networkMagic,
    script: correctScript,
    signers: [{ account: account.scriptHash, scopes: tx.WitnessScope.CalledByEntry }],
  });
  const fulfillVmState = String(
    fulfillAttempt.execution.vmstate || fulfillAttempt.execution.state || ''
  );
  assertCondition(
    fulfillVmState.includes('HALT'),
    `correct fulfill should HALT, got ${fulfillVmState} ${fulfillAttempt.execution.exception || ''}`
  );

  const callback = await waitForCallback(rpcClient, consumer.hash, requestId, 180000);
  assertCondition(callback?.success === true, 'isolated request should fulfill successfully');

  const generatedAt = new Date().toISOString();
  const jsonReport = {
    generated_at: generatedAt,
    network: 'testnet',
    rpc_url: rpcUrl,
    network_magic: networkMagic,
    oracle_hash: oracle.hash,
    callback_consumer_hash: consumer.hash,
    request_fee_status: feeStatus,
    setup: {
      set_updater_txid: setUpdaterTxid,
      set_verifier_txid: setVerifierTxid,
      register_miniapp_txid: registerMiniAppTxid,
      grant_identity_txid: grantIdentityTxid,
      set_oracle_txid: setOracleTxid,
    },
    replay_source: {
      request_id: String(sourceCase.request_id),
      request_type: sourceCase.request_type,
      txid: sourceCase.txid,
    },
    replay_target: {
      request_txid: requestTxid,
      request_id: String(requestId),
      replay_txid: replayAttempt.txid,
      replay_exception: replayException,
      fulfill_txid: fulfillAttempt.txid,
      fulfill_vmstate: fulfillVmState,
    },
  };

  const markdownReport = [
    '# N3 Fulfillment Replay Boundary Validation',
    '',
    `Date: ${generatedAt}`,
    '',
    '## Scope',
    '',
    'This probe validates that a fulfillment signature bound to one request id cannot be replayed against a different pending request, while a correctly re-signed fulfillment for the target request still succeeds.',
    '',
    '## Result',
    '',
    `- Temporary Oracle: \`${oracle.hash}\``,
    `- Temporary callback consumer: \`${consumer.hash}\``,
    `- Replay source request id: \`${sourceCase.request_id}\``,
    `- Replay target request tx: \`${requestTxid}\``,
    `- Replay target request id: \`${requestId}\``,
    `- Replay fulfill tx: \`${replayAttempt.txid}\``,
    `- Replay exception: \`${replayException}\``,
    `- Correct fulfill tx: \`${fulfillAttempt.txid}\``,
    `- Correct fulfill vmstate: \`${fulfillVmState}\``,
    `- Final callback success: \`${callback.success}\``,
    '',
    '## Conclusion',
    '',
    'A fulfillment signature from one request id cannot be replayed against a different pending request. The replay attempt faults with `invalid verification signature`, while a fresh signature over the target request digest fulfills successfully.',
    '',
  ].join('\n');

  const artifacts = await writeValidationArtifacts({
    baseName: 'n3-fulfillment-replay',
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
        replay_txid: replayAttempt.txid,
        replay_exception: replayException,
        fulfill_txid: fulfillAttempt.txid,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  const message = error?.stack || error?.message || String(error);
  if (/method not found: addAllowedCallback|addAllowedCallback/i.test(message)) {
    writeSkippedValidationArtifacts({
      baseName: 'n3-fulfillment-replay',
      network: 'testnet',
      title: 'N3 Fulfillment Replay Boundary Validation',
      reason: 'requires-deprecated-callback-allowlist-api',
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
