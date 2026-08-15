import { experimental, rpc as neoRpc, sc, tx, u, wallet } from '@cityofzion/neon-js';
import {
  buildEncryptedBuiltinComputePayload,
  buildEncryptedJsonPatch,
  decodeBase64Utf8,
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
  resolveNeoN3FeedReaderHash,
  resolveNeoN3DatafeedHash,
  writeValidationArtifacts,
  sleep,
  trimString,
  tryParseJson,
  withRetries,
} from './common.mjs';

const GAS_HASH = '0xd2a4cff31913016155e38e474a2c06d08be276cf';
const REQUEST_TX_SYSTEM_FEE_BUFFER = BigInt(process.env.EXAMPLE_REQUEST_SYSTEM_FEE_BUFFER || '3000000');
const CUSTOM_ORACLE_URL = trimString(process.env.MORPHEUS_EXAMPLE_CUSTOM_ORACLE_URL || '');
const CUSTOM_ORACLE_JSON_PATH = trimString(
  process.env.MORPHEUS_EXAMPLE_CUSTOM_ORACLE_JSON_PATH || ''
);
const CUSTOM_ORACLE_EXPECTED = trimString(
  process.env.MORPHEUS_EXAMPLE_CUSTOM_ORACLE_EXPECTED || ''
);

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
  const requestType = decodeBase64Utf8(requestTypeItem?.value || '');
  const resultText = decodeBase64Utf8(resultItem?.value || '');
  const errorText = decodeBase64Utf8(errorItem?.value || '');
  return {
    request_type: requestType,
    success: Boolean(successItem?.value),
    result_text: resultText,
    result_json: tryParseJson(resultText),
    error_text: errorText,
  };
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
    BigInt(String(preview?.gasconsumed || '0')) + REQUEST_TX_SYSTEM_FEE_BUFFER
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
  requiredRequests = 3
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
      funded: false,
      current_credit: currentCredit.toString(),
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
        funded: true,
        current_credit: updatedCredit.toString(),
        deposit_amount: deficit.toString(),
      };
    }
    await sleep(2000);
  }
  throw new Error('timed out waiting for Neo N3 request fee credit');
}

async function fundConsumerSponsoredCredit(
  account,
  rpcUrl,
  networkMagic,
  rpcClient,
  consumerHash,
  oracleHash,
  requestFee
) {
  const gas = new experimental.SmartContract(GAS_HASH, {
    rpcAddress: rpcUrl,
    networkMagic,
    account,
  });
  await gas.invoke('transfer', [
    sc.ContractParam.hash160(`0x${account.scriptHash}`),
    sc.ContractParam.hash160(consumerHash),
    sc.ContractParam.integer(requestFee),
    sc.ContractParam.any(null),
  ]);

  const deadlineBalance = Date.now() + 60000;
  while (Date.now() < deadlineBalance) {
    const contractBalanceRaw = await invokeRead(rpcClient, GAS_HASH, 'balanceOf', [
      { type: 'Hash160', value: consumerHash },
    ]);
    if (BigInt(contractBalanceRaw || '0') >= BigInt(requestFee)) break;
    await sleep(2000);
  }

  const consumer = new experimental.SmartContract(consumerHash, {
    rpcAddress: rpcUrl,
    networkMagic,
    account,
  });
  const signers = [new tx.Signer({ account: account.scriptHash, scopes: tx.WitnessScope.Global })];
  await consumer.invoke('depositOracleCredits', [sc.ContractParam.integer(requestFee)], signers);

  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const creditRaw = await invokeRead(rpcClient, oracleHash, 'feeCreditOf', [
      { type: 'Hash160', value: consumerHash },
    ]);
    if (BigInt(creditRaw || '0') >= BigInt(requestFee)) return;
    await sleep(2000);
  }
  throw new Error('timed out waiting for Neo N3 consumer-sponsored fee credit');
}

await loadExampleEnv();

const network = trimString(process.env.MORPHEUS_NETWORK || 'testnet') || 'testnet';
const registry = await readDeploymentRegistry(network);
const deployment = registry.neo_n3 || {};
const rpcUrl = resolveNeoN3RpcUrl(network, deployment);
const networkMagic = resolveNeoN3NetworkMagic(network, deployment);
const wif = resolveNeoN3SignerWif(network);
const consumerHash = resolveNeoN3ConsumerHash(network, deployment);
const readerHash = resolveNeoN3FeedReaderHash(network, deployment);
const oracleHash = resolveNeoN3OracleHash(network, deployment);
const datafeedHash = resolveNeoN3DatafeedHash(network, deployment);
const callbackTimeoutMs = Number(process.env.EXAMPLE_CALLBACK_TIMEOUT_MS || 180000);

if (!wif) throw new Error('NEO_N3_WIF or MORPHEUS_RELAYER_NEO_N3_WIF is required');
if (!consumerHash) throw new Error('Neo N3 example consumer hash is required');
if (!readerHash) throw new Error('Neo N3 example feed reader hash is required');
if (!oracleHash) throw new Error('CONTRACT_MORPHEUS_ORACLE_HASH is required');
if (!datafeedHash) throw new Error('CONTRACT_MORPHEUS_DATAFEED_HASH is required');

const account = new wallet.Account(wif);
const rpcClient = new neoRpc.RPCClient(rpcUrl);
const signers = [new tx.Signer({ account: account.scriptHash, scopes: tx.WitnessScope.Global })];
const consumer = new experimental.SmartContract(consumerHash, {
  rpcAddress: rpcUrl,
  networkMagic,
  account,
});
const invokeConsumer = (operation, args = []) => sendBufferedInvocation({
  rpcClient,
  account,
  networkMagic,
  script: sc.createScript({
    scriptHash: consumerHash,
    operation,
    args,
  }),
  signers,
});
const feeStatus = await ensureRequestFeeCredit(
  account,
  rpcUrl,
  networkMagic,
  rpcClient,
  oracleHash,
  4
);

console.log('Testing Neo N3 provider callback flow...');
const providerTx = await invokeConsumer('requestBuiltinProviderPrice');
const providerRequestId = await waitForRequestId(rpcClient, providerTx);
const providerCallback = await waitForCallback(
  rpcClient,
  consumerHash,
  providerRequestId,
  callbackTimeoutMs
);
if (!providerCallback.success) {
  throw new Error(
    `Neo N3 provider callback failed: ${providerCallback.error_text || 'unknown error'}`
  );
}

console.log('Testing Neo N3 encrypted compute flow...');
const encryptedPayload = await buildEncryptedBuiltinComputePayload('neo_n3');
const computeTx = await invokeConsumer('requestBuiltinCompute', [
  sc.ContractParam.byteArray(encodeUtf8Base64(encryptedPayload)),
]);
const computeRequestId = await waitForRequestId(rpcClient, computeTx);
const computeCallback = await waitForCallback(
  rpcClient,
  consumerHash,
  computeRequestId,
  callbackTimeoutMs
);
if (!computeCallback.success) {
  throw new Error(
    `Neo N3 compute callback failed: ${computeCallback.error_text || 'unknown error'}`
  );
}

console.log('Testing Neo N3 sponsored provider callback flow...');
await fundConsumerSponsoredCredit(
  account,
  rpcUrl,
  networkMagic,
  rpcClient,
  consumerHash,
  oracleHash,
  feeStatus.request_fee
);
const requestFeeValue = BigInt(feeStatus.request_fee);
const accountCreditBeforeSponsored = BigInt(
  (await invokeRead(rpcClient, oracleHash, 'feeCreditOf', [
    { type: 'Hash160', value: `0x${account.scriptHash}` },
  ])) || '0'
);
const consumerCreditBeforeSponsored = BigInt(
  (await invokeRead(rpcClient, oracleHash, 'feeCreditOf', [
    { type: 'Hash160', value: consumerHash },
  ])) || '0'
);
const sponsoredProviderTx = await invokeConsumer('requestBuiltinProviderPriceSponsored');
const sponsoredProviderRequestId = await waitForRequestId(rpcClient, sponsoredProviderTx);
const sponsoredProviderCallback = await waitForCallback(
  rpcClient,
  consumerHash,
  sponsoredProviderRequestId,
  callbackTimeoutMs
);
if (!sponsoredProviderCallback.success) {
  throw new Error(
    `Neo N3 sponsored provider callback failed: ${sponsoredProviderCallback.error_text || 'unknown error'}`
  );
}
const sponsoredCreditDeadline = Date.now() + 30000;
let accountCreditAfterSponsored = accountCreditBeforeSponsored;
let consumerCreditAfterSponsored = consumerCreditBeforeSponsored;
while (Date.now() < sponsoredCreditDeadline) {
  accountCreditAfterSponsored = BigInt(
    (await invokeRead(rpcClient, oracleHash, 'feeCreditOf', [
      { type: 'Hash160', value: `0x${account.scriptHash}` },
    ])) || '0'
  );
  consumerCreditAfterSponsored = BigInt(
    (await invokeRead(rpcClient, oracleHash, 'feeCreditOf', [
      { type: 'Hash160', value: consumerHash },
    ])) || '0'
  );
  if (consumerCreditBeforeSponsored - consumerCreditAfterSponsored === requestFeeValue) break;
  await sleep(2000);
}
if (accountCreditAfterSponsored !== accountCreditBeforeSponsored) {
  throw new Error('Neo N3 sponsored request incorrectly charged the transaction sender');
}
const consumerCreditDelta = consumerCreditBeforeSponsored - consumerCreditAfterSponsored;
if (consumerCreditDelta !== 0n && consumerCreditDelta !== requestFeeValue) {
  throw new Error(
    `Neo N3 sponsored request changed consumer credit by unexpected amount: ${consumerCreditDelta.toString()}`
  );
}
const sponsoredFeePayer =
  consumerCreditDelta === requestFeeValue ? 'consumer_contract_credit' : 'registered_app_fee_payer';

console.log('Testing Neo N3 custom URL oracle flow...');
if (!CUSTOM_ORACLE_URL || !CUSTOM_ORACLE_JSON_PATH || !CUSTOM_ORACLE_EXPECTED) {
  throw new Error(
    'MORPHEUS_EXAMPLE_CUSTOM_ORACLE_URL, MORPHEUS_EXAMPLE_CUSTOM_ORACLE_JSON_PATH, and MORPHEUS_EXAMPLE_CUSTOM_ORACLE_EXPECTED are required'
  );
}
const encryptedOracleParams = await buildEncryptedJsonPatch('neo_n3', {
  json_path: CUSTOM_ORACLE_JSON_PATH,
});
const customOraclePayload = JSON.stringify({
  url: CUSTOM_ORACLE_URL,
  target_chain: 'neo_n3',
  encrypted_params: encryptedOracleParams,
});
const customOracleTx = await invokeConsumer('requestRaw', [
  'oracle',
  sc.ContractParam.byteArray(encodeUtf8Base64(customOraclePayload)),
]);
const customOracleRequestId = await waitForRequestId(rpcClient, customOracleTx);
const customOracleCallback = await waitForCallback(
  rpcClient,
  consumerHash,
  customOracleRequestId,
  callbackTimeoutMs
);
if (!customOracleCallback.success) {
  throw new Error(
    `Neo N3 custom URL callback failed: ${customOracleCallback.error_text || 'unknown error'}`
  );
}
if (!JSON.stringify(customOracleCallback.result_json || {}).includes(CUSTOM_ORACLE_EXPECTED)) {
  throw new Error('Neo N3 custom URL callback did not return the expected echoed value');
}

console.log('Reading Neo N3 synchronized on-chain datafeed...');
const readerLatest = await invokeRead(rpcClient, readerHash, 'getNeoUsd', [
  { type: 'Hash160', value: datafeedHash },
]);
const readerPairs = await invokeRead(rpcClient, readerHash, 'getAllPairs', [
  { type: 'Hash160', value: datafeedHash },
]);
if (!Array.isArray(readerLatest) || readerLatest.length < 6) {
  throw new Error('Neo N3 feed reader returned an unexpected record shape');
}
const [pair, roundId, price, timestamp, attestationHash, sourceSetId] = readerLatest;
if (BigInt(roundId || '0') <= 0n || BigInt(price || '0') <= 0n) {
  throw new Error(`Neo N3 datafeed ${pair || 'TWELVEDATA:NEO-USD'} is not populated on-chain`);
}

const generatedAt = new Date().toISOString();
const reportJson = {
  generated_at: generatedAt,
  network,
  neo_n3: {
    consumer_hash: consumerHash,
    feed_reader_hash: readerHash,
    oracle_hash: oracleHash,
    datafeed_hash: datafeedHash,
    request_fee: feeStatus.request_fee,
    request_credit: feeStatus.current_credit,
    provider_request: {
      txid: providerTx,
      request_id: providerRequestId,
      callback: providerCallback,
    },
    compute_request: {
      txid: computeTx,
      request_id: computeRequestId,
      callback: computeCallback,
    },
    sponsored_provider_request: {
      txid: sponsoredProviderTx,
      request_id: sponsoredProviderRequestId,
      callback: sponsoredProviderCallback,
      fee_payer_mode: sponsoredFeePayer,
      account_credit_before: accountCreditBeforeSponsored.toString(),
      account_credit_after: accountCreditAfterSponsored.toString(),
      consumer_credit_before: consumerCreditBeforeSponsored.toString(),
      consumer_credit_after: consumerCreditAfterSponsored.toString(),
    },
    custom_oracle_request: {
      txid: customOracleTx,
      request_id: customOracleRequestId,
      callback: customOracleCallback,
    },
    onchain_feed_snapshot: {
      pair,
      round_id: String(roundId),
      price: String(price),
      timestamp: String(timestamp),
      attestation_hash: attestationHash,
      source_set_id: String(sourceSetId),
      reader_pairs: readerPairs,
    },
  },
};

const markdown = [
  '# Neo N3 Example Validation',
  '',
  `Generated: ${generatedAt}`,
  '',
  '## Environment',
  '',
  `- Network: \`${network}\``,
  `- Consumer: \`${consumerHash}\``,
  `- Feed reader: \`${readerHash}\``,
  `- Oracle: \`${oracleHash}\``,
  `- Datafeed: \`${datafeedHash}\``,
  `- Request fee: \`${feeStatus.request_fee}\``,
  `- Request credit before run: \`${feeStatus.current_credit}\``,
  '',
  '## Case Matrix',
  '',
  '| Case | Tx | Request ID | Result |',
  '| --- | --- | --- | --- |',
  `| provider_request | \`${providerTx}\` | \`${providerRequestId}\` | \`${JSON.stringify(providerCallback.result_json?.result?.result ?? providerCallback.result_json?.result?.extracted_value ?? null)}\` |`,
  `| compute_request | \`${computeTx}\` | \`${computeRequestId}\` | \`${JSON.stringify(computeCallback.result_json?.result?.result ?? null)}\` |`,
  `| sponsored_provider_request | \`${sponsoredProviderTx}\` | \`${sponsoredProviderRequestId}\` | \`${JSON.stringify(sponsoredProviderCallback.result_json?.result?.result ?? sponsoredProviderCallback.result_json?.result?.extracted_value ?? null)}\` |`,
  `| custom_oracle_request | \`${customOracleTx}\` | \`${customOracleRequestId}\` | \`${JSON.stringify(customOracleCallback.result_json?.result?.result ?? customOracleCallback.result_json?.result?.extracted_value ?? null)}\` |`,
  '',
  '## Provider Request',
  '',
  markdownJson(reportJson.neo_n3.provider_request),
  '',
  '## Compute Request',
  '',
  markdownJson(reportJson.neo_n3.compute_request),
  '',
  '## Sponsored Provider Request',
  '',
  markdownJson(reportJson.neo_n3.sponsored_provider_request),
  '',
  '## Custom Oracle Request',
  '',
  markdownJson(reportJson.neo_n3.custom_oracle_request),
  '',
  '## On-Chain Feed Snapshot',
  '',
  markdownJson(reportJson.neo_n3.onchain_feed_snapshot),
  '',
].join('\n');

const artifacts = await writeValidationArtifacts({
  baseName: 'n3-examples-validation',
  network,
  generatedAt,
  jsonReport: reportJson,
  markdownReport: markdown,
  legacyJsonFileNames: network === 'testnet' ? ['test-n3.latest.json'] : [],
});

process.stdout.write(
  jsonPretty({
    ...reportJson,
    ...artifacts,
  })
);
