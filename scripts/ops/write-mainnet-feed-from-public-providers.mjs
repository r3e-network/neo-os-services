#!/usr/bin/env node

import { createHash, randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sc, tx, u, wallet } from '@cityofzion/neon-js';
import {
  readReviewedNetworkRegistrySync,
  resolveReviewedNeoN3Magic,
} from '../lib-network-registry.mjs';

const NETWORK_MAGIC = Number(
  resolveReviewedNeoN3Magic(
    readReviewedNetworkRegistrySync(process.cwd(), 'mainnet'),
    'mainnet',
    process.env.NEO_NETWORK_MAGIC || ''
  )
);
const FEED_HASH = '0x03013f49c42a14546c8bbe58f9d434c3517fccab';
const UPDATER_HASH = '0x9fb28bdacfaa7fcc0a4d660d0dc990b0e7d46118';
const UPDATER_PUBLIC_KEY = '02f63e3f618d8f6995eb85279a03361beb715d25d3b97407c73c351d26ba849744';
const PAIRS = [
  { storage: 'TWELVEDATA:NEO-USD', gecko: 'neo', paprika: 'neo-neo' },
  { storage: 'TWELVEDATA:GAS-USD', gecko: 'gas', paprika: 'gas-gas' },
];
const EXECUTE = process.argv.includes('--execute');

function loadEnvFile(file) {
  try {
    const text = readFileSync(file, 'utf8');
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (!match || process.env[match[1]]) continue;
      process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch {}
}

loadEnvFile('/opt/morpheus/nitro/nitro-worker.env');
loadEnvFile('/opt/morpheus/nitro/morpheus-relayer.env');
loadEnvFile('/opt/morpheus/nitro/morpheus-nitro-signer.env');

const RPC_URL = process.env.NEO_RPC_URL_MAINNET || 'https://api.n3index.dev/mainnet';

function jsonRpc(method, params) {
  return fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }).then(async (response) => {
    const body = await response.json();
    if (!response.ok || body.error) throw new Error(`${method} RPC failure`);
    return body.result;
  });
}

function stackValue(item) {
  if (!item || typeof item !== 'object') return null;
  if (item.type === 'Integer' || item.type === 'Boolean' || item.type === 'String') {
    return item.value;
  }
  if (item.type === 'ByteArray' || item.type === 'Buffer') {
    return Buffer.from(String(item.value || ''), 'base64').toString('utf8');
  }
  if (item.type === 'Array' || item.type === 'Struct') {
    return Array.isArray(item.value) ? item.value.map(stackValue) : [];
  }
  return item.value ?? null;
}

async function fetchQuotes(pair) {
  const [geckoResponse, paprikaResponse] = await Promise.all([
    fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${pair.gecko}&vs_currencies=usd&include_last_updated_at=true`,
      { signal: AbortSignal.timeout(15000) }
    ),
    fetch(`https://api.coinpaprika.com/v1/tickers/${pair.paprika}`, {
      signal: AbortSignal.timeout(15000),
    }),
  ]);
  if (!geckoResponse.ok || !paprikaResponse.ok)
    throw new Error(`provider HTTP failure for ${pair.storage}`);
  const [gecko, paprika] = await Promise.all([geckoResponse.json(), paprikaResponse.json()]);
  const a = Number(gecko?.[pair.gecko]?.usd);
  const b = Number(paprika?.quotes?.USD?.price);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) {
    throw new Error(`provider returned invalid price for ${pair.storage}`);
  }
  const price = (a + b) / 2;
  const timestamp = Math.min(
    Number(gecko?.[pair.gecko]?.last_updated_at || Math.floor(Date.now() / 1000)),
    Date.parse(paprika?.last_updated || '') / 1000 || Math.floor(Date.now() / 1000)
  );
  return { price, timestamp: Math.floor(timestamp), providers: { coingecko: a, coinpaprika: b } };
}

async function currentRecord(pair) {
  const result = await jsonRpc('invokefunction', [
    FEED_HASH,
    'getLatest',
    [{ type: 'String', value: pair }],
  ]);
  if (String(result?.state || '').toUpperCase() !== 'HALT')
    throw new Error(`getLatest faulted for ${pair}`);
  const values = result?.stack?.[0]?.value;
  if (!Array.isArray(values) || values.length < 4)
    throw new Error(`malformed getLatest for ${pair}`);
  return {
    round: BigInt(stackValue(values[1]) || 0),
    price: BigInt(stackValue(values[2]) || 0),
    timestamp: BigInt(stackValue(values[3]) || 0),
  };
}

function makeUpdateScript(rows) {
  return sc.createScript({
    scriptHash: FEED_HASH.replace(/^0x/, ''),
    operation: 'updateFeeds',
    args: [
      sc.ContractParam.array(...rows.map((r) => sc.ContractParam.string(r.pair))),
      sc.ContractParam.array(...rows.map((r) => sc.ContractParam.integer(r.round.toString()))),
      sc.ContractParam.array(...rows.map((r) => sc.ContractParam.integer(r.price.toString()))),
      sc.ContractParam.array(...rows.map((r) => sc.ContractParam.integer(r.timestamp.toString()))),
      sc.ContractParam.array(...rows.map((r) => sc.ContractParam.byteArray(r.attestationHash))),
      sc.ContractParam.array(...rows.map(() => sc.ContractParam.integer('0'))),
    ],
  });
}

async function makeTransaction(rows) {
  const script = makeUpdateScript(rows);
  const blockCount = Number(await jsonRpc('getblockcount', []));
  const signer = {
    account: UPDATER_HASH.replace(/^0x/, ''),
    scopes: tx.WitnessScope.CalledByEntry,
  };
  const transaction = new tx.Transaction({
    nonce: randomInt(1, 0xffffffff),
    validUntilBlock: blockCount + 500,
    signers: [signer],
    attributes: [],
    witnesses: [],
    script: u.HexString.fromHex(script),
  });
  const invoke = await jsonRpc('invokescript', [
    u.HexString.fromHex(script).toBase64(),
    [{ account: UPDATER_HASH, scopes: 'CalledByEntry' }],
  ]);
  if (String(invoke?.state || '').toUpperCase() === 'FAULT') {
    throw new Error(
      `updateFeeds test invocation faulted: ${String(invoke?.exception || 'unknown').slice(0, 240)}`
    );
  }
  const gasConsumed = BigInt(invoke?.gasconsumed || '0');
  transaction.systemFee = u.BigInteger.fromDecimal((gasConsumed + 100000n).toString(), 0);
  const verificationScript = wallet.getVerificationScriptFromPublicKey(UPDATER_PUBLIC_KEY);
  transaction.witnesses = [
    new tx.Witness({
      invocationScript: `0c40${'00'.repeat(64)}`,
      verificationScript,
    }),
  ];
  const networkFee = await jsonRpc('calculatenetworkfee', [
    u.HexString.fromHex(transaction.serialize(true)).toBase64(),
  ]);
  transaction.networkFee = u.BigInteger.fromDecimal(String(networkFee?.networkfee || '0'), 0);
  transaction.witnesses = [];
  return { transaction, script, blockCount };
}

async function signAndBroadcast(transaction) {
  const signerUrl =
    process.env.NITRO_SIGNER_URL || process.env.SIGNER_URL || 'http://127.0.0.1:8787';
  const token =
    process.env.NITRO_SIGNER_TOKEN ||
    process.env.MORPHEUS_RUNTIME_TOKEN ||
    process.env.RUNTIME_TOKEN ||
    '';
  if (!token) throw new Error('Nitro signer token is not configured');
  const messageHex = transaction.getMessageForSigning(NETWORK_MAGIC);
  const response = await fetch(`${signerUrl.replace(/\/$/, '')}/sign/payload`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      target_chain: 'neo_n3',
      data_hex: messageHex,
      role: 'updater',
      key_role: 'updater',
    }),
  });
  const signed = await response.json();
  if (!response.ok || signed?.status === 'error') throw new Error('Nitro updater signing failed');
  const publicKey = String(signed.public_key || '')
    .replace(/^0x/, '')
    .toLowerCase();
  const signature = String(signed.signature || signed.signature_hex || '')
    .replace(/^0x/, '')
    .toLowerCase();
  if (publicKey !== UPDATER_PUBLIC_KEY || !/^[0-9a-f]{128}$/.test(signature)) {
    throw new Error('Nitro signer identity mismatch');
  }
  transaction.witnesses = [tx.Witness.fromSignature(signature, publicKey)];
  if (`0x${transaction.witnesses[0].scriptHash}`.toLowerCase() !== UPDATER_HASH.toLowerCase()) {
    throw new Error('constructed witness does not match on-chain updater');
  }
  const raw = u.HexString.fromHex(transaction.serialize(true)).toBase64();
  const txid = `0x${transaction.hash()}`;
  const result = await jsonRpc('sendrawtransaction', [raw]);
  return { txid, result };
}

async function waitForApplicationLog(txid) {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    try {
      const log = await jsonRpc('getapplicationlog', [txid]);
      if (log?.executions?.[0]) return log.executions[0];
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 2500));
  }
  throw new Error('timed out waiting for application log');
}

const rows = [];
for (const pair of PAIRS) {
  const [quote, current] = await Promise.all([fetchQuotes(pair), currentRecord(pair.storage)]);
  const price = BigInt(Math.round(quote.price * 1_000_000));
  const round = current.round + 1n;
  const timestamp = BigInt(Math.max(quote.timestamp, Number(current.timestamp) + 1));
  const attestationHash = createHash('sha256')
    .update(
      JSON.stringify({
        pair: pair.storage,
        price: price.toString(),
        round: round.toString(),
        timestamp: timestamp.toString(),
        providers: quote.providers,
      })
    )
    .digest('hex');
  // The deployed feed contract accepts the canonical 16-byte attestation
  // token encoded as 32 hex characters (the Neon script builder treats the
  // string as hex bytes). Keep the full digest out of the on-chain field.
  rows.push({
    pair: pair.storage,
    price,
    round,
    timestamp,
    attestationHash: attestationHash.slice(0, 32),
  });
}

const { transaction, blockCount } = await makeTransaction(rows);
const preview = rows.map((r) => ({
  pair: r.pair,
  price_1e6: r.price.toString(),
  round: r.round.toString(),
  timestamp: r.timestamp.toString(),
}));
if (!EXECUTE) {
  console.log(
    JSON.stringify(
      {
        mode: 'dry-run',
        network: 'mainnet',
        feed: FEED_HASH,
        updater: UPDATER_HASH,
        block_count: blockCount,
        rows: preview,
      },
      null,
      2
    )
  );
  process.exit(0);
}
const submitted = await signAndBroadcast(transaction);
const execution = await waitForApplicationLog(submitted.txid);
if (!String(execution.vmstate || '').includes('HALT'))
  throw new Error(`feed update faulted: ${execution.vmstate || 'unknown'}`);
console.log(
  JSON.stringify(
    {
      mode: 'execute',
      network: 'mainnet',
      feed: FEED_HASH,
      updater: UPDATER_HASH,
      txid: submitted.txid,
      vmstate: execution.vmstate,
      rows: preview,
    },
    null,
    2
  )
);
