import { experimental, rpc as neoRpc, sc, tx, wallet } from '@cityofzion/neon-js';
import {
  encodeUtf8Base64,
  jsonPretty,
  loadExampleEnv,
  markdownJson,
  readDeploymentRegistry,
  resolveNeoN3SignerWif,
  resolveNeoN3RpcUrl,
  resolveNeoN3NetworkMagic,
  resolveNeoN3OracleHash,
  resolveNeoN3ConsumerHash,
  writeValidationArtifacts,
  sleep,
  trimString,
  tryParseJson,
  withRetries,
} from './common.mjs';
import { buildBuiltinComputeCases, extractBuiltinInnerResult } from './lib-builtins.mjs';

const GAS_HASH = '0xd2a4cff31913016155e38e474a2c06d08be276cf';

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
  const currentCredit = BigInt(
    (await invokeRead(rpcClient, oracleHash, 'feeCreditOf', [
      { type: 'Hash160', value: `0x${account.scriptHash}` },
    ])) || '0'
  );
  const requestFee = BigInt((await invokeRead(rpcClient, oracleHash, 'requestFee', [])) || '0');
  const requiredCredit = requestFee * BigInt(requiredRequests);
  if (currentCredit >= requiredCredit) {
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
  throw new Error(`timed out waiting for Neo N3 request id from tx ${txid}`);
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
  throw new Error(`timed out waiting for Neo N3 callback ${requestId}`);
}

await loadExampleEnv();

const network = trimString(process.env.MORPHEUS_NETWORK || 'testnet') || 'testnet';
const registry = await readDeploymentRegistry(network);
const deployment = registry.neo_n3 || {};
const rpcUrl = resolveNeoN3RpcUrl(network, deployment);
const networkMagic = resolveNeoN3NetworkMagic(network, deployment);
const wif = resolveNeoN3SignerWif(network);
const consumerHash = resolveNeoN3ConsumerHash(network, deployment);
const oracleHash = resolveNeoN3OracleHash(network, deployment);
const callbackTimeoutMs = Number(process.env.EXAMPLE_CALLBACK_TIMEOUT_MS || 300000);

if (!wif || !consumerHash || !oracleHash) {
  throw new Error(
    'NEO_N3_WIF, EXAMPLE_N3_CONSUMER_HASH, and CONTRACT_MORPHEUS_ORACLE_HASH are required'
  );
}

const account = new wallet.Account(wif);
const rpcClient = new neoRpc.RPCClient(rpcUrl);
const signers = [new tx.Signer({ account: account.scriptHash, scopes: tx.WitnessScope.Global })];
const consumer = new experimental.SmartContract(consumerHash, {
  rpcAddress: rpcUrl,
  networkMagic,
  account,
});
const cases = await buildBuiltinComputeCases('neo_n3');
const feeStatus = await ensureRequestFeeCredit(
  account,
  rpcUrl,
  networkMagic,
  rpcClient,
  oracleHash,
  cases.length
);
const results = [];

for (const builtin of cases) {
  console.log(`Testing Neo N3 builtin ${builtin.name}...`);
  const txid = await consumer.invoke(
    'requestRaw',
    ['compute', sc.ContractParam.byteArray(encodeUtf8Base64(JSON.stringify(builtin.payload)))],
    signers
  );
  const requestId = await waitForRequestId(rpcClient, txid);
  const callback = await waitForCallback(rpcClient, consumerHash, requestId, callbackTimeoutMs);
  if (!callback.success) {
    throw new Error(
      `Neo N3 builtin ${builtin.name} failed: ${callback.error_text || 'unknown error'}`
    );
  }
  const inner = extractBuiltinInnerResult(callback.result_json);
  builtin.validate(inner);
  results.push({
    name: builtin.name,
    txid,
    request_id: requestId,
    result: inner,
  });
}

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
  builtins: results,
};

const markdown = [
  '# Neo N3 Builtin Validation',
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
  '## Builtin Matrix',
  '',
  '| Builtin | Tx | Request ID | Result |',
  '| --- | --- | --- | --- |',
  ...results.map(
    (item) =>
      `| ${item.name} | \`${item.txid}\` | \`${item.request_id}\` | \`${JSON.stringify(item.result)}\` |`
  ),
  '',
  '## Detailed Results',
  '',
  ...results.flatMap((item) => [`### ${item.name}`, '', markdownJson(item), '']),
].join('\n');

const artifacts = await writeValidationArtifacts({
  baseName: 'n3-builtins-validation',
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
