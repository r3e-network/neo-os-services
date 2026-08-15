import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { experimental, rpc as neoRpc, sc, tx, u, wallet } from '@cityofzion/neon-js';
import {
  buildEncryptedJsonPatch,
  encodeUtf8Base64,
  jsonPretty,
  loadExampleEnv,
  markdownJson,
  normalizeHash160,
  readDeploymentRegistry,
  repoRoot,
  resolveNeoN3ConsumerHash,
  resolveNeoN3OracleHash,
  resolveNeoN3SignerWif,
  writeValidationArtifacts,
  sleep,
  trimString,
  tryParseJson,
  withRetries,
} from './common.mjs';

const GAS_HASH = '0xd2a4cff31913016155e38e474a2c06d08be276cf';
const EXAMPLE_BUILD_DIR = path.resolve(repoRoot, 'examples/build/n3');
const EXAMPLE_CONSUMER_ARTIFACT = 'UserConsumerN3OracleExample';
const REQUEST_TX_SYSTEM_FEE_BUFFER = BigInt(process.env.EXAMPLE_REQUEST_SYSTEM_FEE_BUFFER || '3000000');

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

async function sendBufferedInvocation({ rpcClient, account, networkMagic, script, signers }) {
  const preview = await rpcClient.invokeScript(u.HexString.fromHex(script), signers);
  if (String(preview?.state || '').toUpperCase() === 'FAULT') {
    throw new Error(preview?.exception || 'preview fault');
  }

  const validUntilBlock = (await rpcClient.getBlockCount()) + 1000;
  const bufferedSystemFee = (
    BigInt(String(preview?.gasconsumed || '0'))
    + REQUEST_TX_SYSTEM_FEE_BUFFER
  ).toString();
  const basePayload = {
    signers,
    validUntilBlock,
    script,
    systemFee: bufferedSystemFee,
  };

  let transaction = new tx.Transaction(basePayload);
  transaction.sign(account, networkMagic);
  const networkFee = await rpcClient.calculateNetworkFee(transaction);

  transaction = new tx.Transaction({
    ...basePayload,
    networkFee,
  });
  transaction.sign(account, networkMagic);
  return rpcClient.sendRawTransaction(transaction);
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

async function fetchRequestRecord(rpcClient, oracleHash, requestId) {
  const response = await rpcClient.invokeFunction(oracleHash, 'getRequest', [
    { type: 'Integer', value: String(requestId) },
  ]);
  const decoded = parseStackItem(response.stack?.[0]);
  if (!Array.isArray(decoded) || decoded.length < 12) return null;
  return {
    request_id: String(decoded[0] ?? requestId),
    request_type: String(decoded[1] ?? ''),
    payload_text: String(decoded[2] ?? ''),
    payload_json: tryParseJson(String(decoded[2] ?? '')),
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

function sha256Hex(value) {
  return createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex');
}

function summarizeCiphertext(value) {
  const raw = trimString(value);
  if (!raw) return null;
  return {
    ciphertext_length: raw.length,
    ciphertext_sha256: sha256Hex(raw),
  };
}

function assertCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function resultBody(callback) {
  return callback?.result_json?.result || {};
}

function markdownCase(caseResult) {
  return [
    `### ${caseResult.title}`,
    ``,
    `- Request type: \`${caseResult.request_type}\``,
    `- Txid: \`${caseResult.txid}\``,
    `- Request id: \`${caseResult.request_id}\``,
    `- Callback success: \`${caseResult.callback?.success}\``,
    caseResult.expected ? `- Expected: ${caseResult.expected}` : null,
    caseResult.notes ? `- Notes: ${caseResult.notes}` : null,
    caseResult.onchain_request ? `- On-chain request:` : null,
    caseResult.onchain_request ? markdownJson(caseResult.onchain_request) : null,
    `- Callback:`,
    markdownJson(caseResult.callback),
  ]
    .filter(Boolean)
    .join('\n');
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
  const { nef, manifestJson } = await loadContractArtifacts(EXAMPLE_CONSUMER_ARTIFACT);
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
const callbackTimeoutMs = Number(process.env.EXAMPLE_CALLBACK_TIMEOUT_MS || 180000);
const aaContractHash = normalizeHash160(
  process.env.AA_TESTNET_HASH || '0xdbf38e7b2117186bf7a5e17ead702322c0c5b6f2'
);
const aaVerifierHash = normalizeHash160(
  process.env.AA_RECOVERY_VERIFIER_TESTNET_HASH || '0x11d1012e071fac7fd75569981ac44da097913a84'
);
const vaultAccount = normalizeHash160(
  process.env.NEODID_TEST_VAULT_ACCOUNT ||
    `0x${wallet.getScriptHashFromAddress('NTmHjwiadq4g3VHpJ5FQigQcD4fF5m8TyX')}`
);
const disposableAccountA = normalizeHash160(
  process.env.NEODID_TEST_DISPOSABLE_A || `0x${new wallet.Account().scriptHash}`
);
const disposableAccountB = normalizeHash160(
  process.env.NEODID_TEST_DISPOSABLE_B || `0x${new wallet.Account().scriptHash}`
);
const newOwnerA = normalizeHash160(
  process.env.NEODID_TEST_NEW_OWNER_A || `0x${new wallet.Account().scriptHash}`
);
const newOwnerB = normalizeHash160(
  process.env.NEODID_TEST_NEW_OWNER_B || `0x${new wallet.Account().scriptHash}`
);
const recoveryAccountIdA = trimString(
  process.env.NEODID_TEST_RECOVERY_ACCOUNT_ID_A || `aa-recovery-${Date.now()}-a`
);
const recoveryAccountIdB = trimString(
  process.env.NEODID_TEST_RECOVERY_ACCOUNT_ID_B || `aa-recovery-${Date.now()}-b`
);
const recoveryAccountIdC = trimString(
  process.env.NEODID_TEST_RECOVERY_ACCOUNT_ID_C || `aa-recovery-${Date.now()}-c`
);

if (!wif) throw new Error('NEO_N3_WIF or MORPHEUS_RELAYER_NEO_N3_WIF is required');
if (!consumerHash) throw new Error('Neo N3 example consumer hash is required');
if (!oracleHash) throw new Error('CONTRACT_MORPHEUS_ORACLE_HASH is required');

const account = new wallet.Account(wif);
const rpcClient = new neoRpc.RPCClient(rpcUrl);
const resolvedConsumerHash = await ensureExampleConsumer({
  rpcClient,
  account,
  rpcUrl,
  networkMagic,
  oracleHash,
  consumerHash,
});
const signers = [new tx.Signer({ account: account.scriptHash, scopes: tx.WitnessScope.Global })];
const consumer = new experimental.SmartContract(resolvedConsumerHash, {
  rpcAddress: rpcUrl,
  networkMagic,
  account,
});
const feeStatus = await ensureRequestFeeCredit(
  account,
  rpcUrl,
  networkMagic,
  rpcClient,
  oracleHash,
  8
);

async function submitCase({ title, requestType, payload, expected, validate }) {
  const payloadText = JSON.stringify(payload);
  const script = sc.createScript({
    scriptHash: resolvedConsumerHash,
    operation: 'requestRaw',
    args: [requestType, sc.ContractParam.byteArray(encodeUtf8Base64(payloadText))],
  });
  const txid = await sendBufferedInvocation({
    rpcClient,
    account,
    networkMagic,
    script,
    signers,
  });
  const requestId = await waitForRequestId(rpcClient, txid);
  const callback = await waitForCallback(
    rpcClient,
    resolvedConsumerHash,
    requestId,
    callbackTimeoutMs
  );
  const onchainRequest = await fetchRequestRecord(rpcClient, oracleHash, requestId);
  console.log(
    jsonPretty({
      title,
      request_type: requestType,
      txid,
      request_id: String(requestId),
      callback,
      onchain_request: onchainRequest,
    })
  );
  if (validate) {
    await validate({ callback, onchainRequest, payload });
  }
  return {
    title,
    request_type: requestType,
    txid,
    request_id: String(requestId),
    expected,
    callback,
    onchain_request: onchainRequest,
  };
}

const bindPlainPayload = {
  provider: 'github',
  provider_uid: 'alice-gh-001',
  vault_account: vaultAccount,
  claim_type: 'Github_VerifiedUser',
  claim_value: 'true',
  metadata: { scenario: 'bind_plain' },
};

const bindEncryptedPatch = {
  provider_uid: 'alice-gh-enc-001',
  claim_value: 'enc-true',
  metadata: { scenario: 'bind_encrypted' },
};
const bindEncryptedPayload = {
  provider: 'github',
  vault_account: vaultAccount,
  claim_type: 'Github_VerifiedUser',
  encrypted_params: await buildEncryptedJsonPatch('neo_n3', bindEncryptedPatch),
};

const actionPayloadA = {
  provider: 'github',
  provider_uid: 'alice-gh-001',
  disposable_account: disposableAccountA,
  action_id: 'vote:proposal-42',
};
const actionPayloadB = {
  provider: 'github',
  provider_uid: 'alice-gh-001',
  disposable_account: disposableAccountB,
  action_id: 'vote:proposal-42',
};

const recoveryPayloadA = {
  provider: 'github',
  provider_uid: 'alice-gh-001',
  network: 'neo_n3',
  aa_contract: aaContractHash,
  verifier_contract: aaVerifierHash,
  account_id: recoveryAccountIdA,
  new_owner: newOwnerA,
  recovery_nonce: '7',
  expires_at: '1893456000000',
};

const recoveryPayloadB = {
  provider: 'github',
  provider_uid: 'alice-gh-001',
  network: 'neo_n3',
  aa_contract: aaContractHash,
  verifier_contract: aaVerifierHash,
  account_id: recoveryAccountIdB,
  new_owner: newOwnerB,
  recovery_nonce: '7',
  expires_at: '1893456000000',
};

const recoveryFailurePayload = {
  provider: 'github',
  provider_uid: 'alice-gh-001',
  network: 'neo_n3',
  aa_contract: aaContractHash,
  verifier_contract: aaVerifierHash,
  account_id: recoveryAccountIdC,
  recovery_nonce: '9',
  expires_at: '1893456000000',
};

const cases = [];

cases.push(
  await submitCase({
    title: 'NeoDID bind through Oracle callback, public payload',
    requestType: 'neodid_bind',
    payload: bindPlainPayload,
    expected:
      'Callback succeeds and returns a stable master_nullifier bound to the provided vault account.',
    validate({ callback }) {
      assertCondition(callback?.success === true, 'bind_plain callback was not successful');
      const result = resultBody(callback);
      assertCondition(result.mode === 'neodid_bind', 'bind_plain mode mismatch');
      assertCondition(result.provider === 'github', 'bind_plain provider mismatch');
      assertCondition(
        /^0x[0-9a-f]{64}$/.test(result.master_nullifier || ''),
        'bind_plain master_nullifier missing'
      );
    },
  })
);

cases.push(
  await submitCase({
    title: 'NeoDID bind through Oracle callback, encrypted params',
    requestType: 'neodid_bind',
    payload: bindEncryptedPayload,
    expected:
      'Callback succeeds, but the on-chain request payload keeps the confidential provider_uid out of plaintext.',
    validate({ callback, onchainRequest }) {
      assertCondition(callback?.success === true, 'bind_encrypted callback was not successful');
      const result = resultBody(callback);
      assertCondition(result.mode === 'neodid_bind', 'bind_encrypted mode mismatch');
      assertCondition(
        /^0x[0-9a-f]{64}$/.test(result.master_nullifier || ''),
        'bind_encrypted master_nullifier missing'
      );
      const payloadJson = onchainRequest?.payload_json || {};
      const payloadText = onchainRequest?.payload_text || '';
      assertCondition(
        typeof payloadJson.encrypted_params === 'string' && payloadJson.encrypted_params.length > 0,
        'bind_encrypted missing encrypted_params on-chain'
      );
      assertCondition(
        !payloadText.includes(bindEncryptedPatch.provider_uid),
        'bind_encrypted leaked provider_uid into on-chain payload'
      );
    },
  })
);

const actionCaseA = await submitCase({
  title: 'NeoDID action ticket for disposable account A',
  requestType: 'neodid_action_ticket',
  payload: actionPayloadA,
  expected: 'Callback succeeds and binds the ticket to disposable account A.',
  validate({ callback }) {
    assertCondition(callback?.success === true, 'action A callback was not successful');
    const result = resultBody(callback);
    assertCondition(result.mode === 'neodid_action_ticket', 'action A mode mismatch');
    assertCondition(
      /^0x[0-9a-f]{64}$/.test(result.action_nullifier || ''),
      'action A action_nullifier missing'
    );
  },
});
cases.push(actionCaseA);

const actionCaseB = await submitCase({
  title: 'NeoDID action ticket for disposable account B with same action_id',
  requestType: 'neodid_action_ticket',
  payload: actionPayloadB,
  expected:
    'action_nullifier stays stable for the same human + action_id, while digest/signature remain bound to the new disposable account.',
  validate({ callback }) {
    assertCondition(callback?.success === true, 'action B callback was not successful');
    const result = resultBody(callback);
    assertCondition(result.mode === 'neodid_action_ticket', 'action B mode mismatch');
  },
});
cases.push(actionCaseB);

{
  const actionA = resultBody(actionCaseA.callback);
  const actionB = resultBody(actionCaseB.callback);
  assertCondition(
    actionA.action_nullifier === actionB.action_nullifier,
    'action ticket action_nullifier should stay stable across disposable accounts'
  );
  assertCondition(
    actionA.digest !== actionB.digest,
    'action ticket digest should differ across disposable accounts'
  );
}

const recoveryCaseA = await submitCase({
  title: 'NeoDID recovery ticket A through Oracle callback',
  requestType: 'neodid_recovery_ticket',
  payload: recoveryPayloadA,
  expected:
    'Callback succeeds and binds network, aa_contract, account_id, new_owner, recovery_nonce, and nullifiers into the ticket.',
  validate({ callback }) {
    assertCondition(callback?.success === true, 'recovery A callback was not successful');
    const result = resultBody(callback);
    assertCondition(result.mode === 'neodid_recovery_ticket', 'recovery A mode mismatch');
    assertCondition(
      result.aa_contract?.toLowerCase() === aaContractHash.toLowerCase(),
      'recovery A aa_contract mismatch'
    );
    assertCondition(
      result.new_owner?.toLowerCase() === newOwnerA.toLowerCase(),
      'recovery A new_owner mismatch'
    );
    assertCondition(
      result.account_id === recoveryPayloadA.account_id,
      'recovery A account_id mismatch'
    );
  },
});
cases.push(recoveryCaseA);

const recoveryCaseB = await submitCase({
  title: 'NeoDID recovery ticket B with different account / owner',
  requestType: 'neodid_recovery_ticket',
  payload: recoveryPayloadB,
  expected:
    'Changing account_id or new_owner changes the ticket binding and derived recovery action id.',
  validate({ callback }) {
    assertCondition(callback?.success === true, 'recovery B callback was not successful');
    const result = resultBody(callback);
    assertCondition(result.mode === 'neodid_recovery_ticket', 'recovery B mode mismatch');
    assertCondition(
      result.account_id === recoveryPayloadB.account_id,
      'recovery B account_id mismatch'
    );
    assertCondition(
      result.new_owner?.toLowerCase() === newOwnerB.toLowerCase(),
      'recovery B new_owner mismatch'
    );
  },
});
cases.push(recoveryCaseB);

{
  const recoveryA = resultBody(recoveryCaseA.callback);
  const recoveryB = resultBody(recoveryCaseB.callback);
  assertCondition(
    recoveryA.action_id !== recoveryB.action_id,
    'recovery action_id should differ across account/owner targets'
  );
  assertCondition(
    recoveryA.action_nullifier !== recoveryB.action_nullifier,
    'recovery action_nullifier should differ across account/owner targets'
  );
}

cases.push(
  await submitCase({
    title: 'NeoDID recovery ticket failure callback when required context is missing',
    requestType: 'neodid_recovery_ticket',
    payload: recoveryFailurePayload,
    expected:
      'Request is still fulfilled, but callback success=false and error explains that new_owner is required.',
    validate({ callback }) {
      assertCondition(
        callback?.success === false,
        'recovery failure case should return success=false'
      );
      assertCondition(
        /new_owner/i.test(callback?.error_text || ''),
        'recovery failure callback did not surface the new_owner validation error'
      );
    },
  })
);

const report = {
  generated_at: new Date().toISOString(),
  network,
  rpc_url: rpcUrl,
  network_magic: networkMagic,
  account_address: account.address,
  account_script_hash: `0x${account.scriptHash}`,
  oracle_hash: oracleHash,
  callback_consumer_hash: consumerHash,
  callback_consumer_hash_resolved: resolvedConsumerHash,
  fee_status: feeStatus,
  aa_contract_hash: aaContractHash,
  aa_verifier_hash: aaVerifierHash,
  cases,
};

const markdown = [
  '# N3 NeoDID + Oracle Matrix',
  ``,
  `Date: ${report.generated_at.slice(0, 10)}`,
  `Network: ${network}`,
  ``,
  '## Environment',
  ``,
  markdownJson({
    rpc_url: rpcUrl,
    network_magic: networkMagic,
    oracle_hash: oracleHash,
    callback_consumer_hash: consumerHash,
    account_address: account.address,
    fee_status: feeStatus,
    aa_contract_hash: aaContractHash,
    aa_verifier_hash: aaVerifierHash,
    encrypted_bind_ciphertext: summarizeCiphertext(bindEncryptedPayload.encrypted_params),
  }),
  ``,
  '## Cases',
  ``,
  ...cases.map((entry) => markdownCase(entry)),
].join('\n');

const artifacts = await writeValidationArtifacts({
  baseName: 'n3-neodid-oracle-matrix',
  network,
  generatedAt: report.generated_at,
  jsonReport: report,
  markdownReport: markdown,
});

console.log(
  jsonPretty({
    ok: true,
    artifacts,
    summary: cases.map((entry) => ({
      title: entry.title,
      request_type: entry.request_type,
      txid: entry.txid,
      request_id: entry.request_id,
      callback_success: entry.callback?.success,
    })),
  })
);
