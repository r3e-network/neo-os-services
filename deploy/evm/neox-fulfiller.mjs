#!/usr/bin/env node
// Neo X oracle fulfiller: watches MorpheusOracleEVM for RequestQueued events,
// does the work (VRF locally; HTTP/compute via the Nitro worker when configured),
// signs the result with the oracle_verifier key (EIP-191) and submits
// fulfillRequest with the updater key. Stateless except a block cursor.
//
// Env:
//   NEOX_ORACLE          oracle kernel address (default: build record)
//   NEOX_RPC             RPC (default mainnet-1.rpc.banelabs.org)
//   NEOX_CHAIN_ID        47763
//   NEOX_UPDATER_PK      key that sends fulfillRequest (gas payer / updater)
//   NEOX_VERIFIER_PK     key that signs the result digest (default: NEOX_UPDATER_PK)
//   NEOX_WORKER_URL      Nitro worker base for HTTP/compute (optional)
//   NEOX_WORKER_TOKEN    bearer token for the worker (optional)
//   FULFILLER_STATE      cursor file (default /var/lib/morpheus/neox-fulfiller.json)
//   POLL_MS              poll interval (default 5000)
//   LOOKBACK_BLOCKS      first-run lookback (default 5000)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { ethers } from 'ethers';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const NET = process.env.NEOX_NET || 'neox-mainnet';
let recAddr = '';
try {
  recAddr = JSON.parse(
    readFileSync(resolve(ROOT, `contracts-evm/build/MorpheusOracleEVM.${NET}.json`), 'utf8')
  ).address;
} catch {}
const ADDR = process.env.NEOX_ORACLE || recAddr;
const RPC = process.env.NEOX_RPC || 'https://mainnet-1.rpc.banelabs.org';
const CHAIN_ID = Number(process.env.NEOX_CHAIN_ID || 47763);
const POLL_MS = Number(process.env.POLL_MS || 5000);
const LOOKBACK = Number(process.env.LOOKBACK_BLOCKS || 5000);
const STATE = process.env.FULFILLER_STATE || '/var/lib/morpheus/neox-fulfiller.json';
const WORKER_URL = process.env.NEOX_WORKER_URL || '';
const WORKER_TOKEN = process.env.NEOX_WORKER_TOKEN || '';
const ABI_PATH =
  process.env.NEOX_ABI_PATH || resolve(ROOT, 'contracts-evm/build/MorpheusOracleEVM.abi.json');
const abi = JSON.parse(readFileSync(ABI_PATH, 'utf8'));

const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);
const provider = new ethers.JsonRpcProvider(RPC, CHAIN_ID);
const updaterPk = process.env.NEOX_UPDATER_PK || process.env.NEOX_FEED_PK;
if (!ADDR || !updaterPk) {
  console.error('need NEOX_ORACLE (or build record) and NEOX_UPDATER_PK');
  process.exit(1);
}
const updater = new ethers.Wallet(updaterPk, provider);
const verifier = new ethers.Wallet(process.env.NEOX_VERIFIER_PK || updaterPk, provider);
const kernel = new ethers.Contract(ADDR, abi, updater);
const iface = new ethers.Interface(abi);

function readState() {
  try {
    return JSON.parse(readFileSync(STATE, 'utf8'));
  } catch {
    return {};
  }
}
function writeState(s) {
  try {
    mkdirSync(dirname(STATE), { recursive: true });
    writeFileSync(STATE, JSON.stringify(s));
  } catch (e) {
    log('state write failed: ' + e.message);
  }
}

// ── work lanes ──────────────────────────────────────────────────────────────
async function doWork(r) {
  const mod = r.moduleId,
    op = r.operation;
  // VRF: local CSPRNG; the oracle_verifier signature binds it to the request.
  if (mod === 'random.generate' || op === 'random' || op === 'random.generate') {
    return { success: true, result: '0x' + randomBytes(32).toString('hex'), error: '' };
  }
  // HTTP / compute via the Nitro worker (optional; only if NEOX_WORKER_URL set)
  if (
    WORKER_URL &&
    (mod === 'oracle.fetch' || op === 'oracle' || mod === 'compute.run' || op === 'compute')
  ) {
    let payload = {};
    try {
      payload = JSON.parse(ethers.toUtf8String(r.payload));
    } catch {}
    const path = mod === 'compute.run' || op === 'compute' ? '/compute/run' : '/oracle/fetch';
    const res = await fetch(WORKER_URL.replace(/\/$/, '') + path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(WORKER_TOKEN ? { authorization: 'Bearer ' + WORKER_TOKEN } : {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(25000),
    });
    const text = await res.text();
    if (!res.ok)
      return { success: false, result: '0x', error: `worker ${res.status}: ${text.slice(0, 120)}` };
    return { success: true, result: '0x' + Buffer.from(text, 'utf8').toString('hex'), error: '' };
  }
  return { success: false, result: '0x', error: `unsupported module/operation: ${mod}/${op}` };
}

// ── fulfilment digest (must match MorpheusOracleEVM.fulfillmentDigest) ────────
function buildDigest(r, success, result, error) {
  const kAppId = ethers.keccak256(ethers.toUtf8Bytes(r.appId));
  const kModule = ethers.keccak256(ethers.toUtf8Bytes(r.moduleId));
  const kOp = ethers.keccak256(ethers.toUtf8Bytes(r.operation));
  const kResult = ethers.keccak256(result);
  const kError = ethers.keccak256(ethers.toUtf8Bytes(error));
  const enc = ethers.AbiCoder.defaultAbiCoder().encode(
    [
      'string',
      'uint256',
      'address',
      'uint256',
      'bytes32',
      'bytes32',
      'bytes32',
      'bool',
      'bytes32',
      'bytes32',
    ],
    [
      'morpheus-evm-fulfillment-v1',
      CHAIN_ID,
      ADDR,
      r.id,
      kAppId,
      kModule,
      kOp,
      success,
      kResult,
      kError,
    ]
  );
  return ethers.keccak256(enc);
}

async function fulfill(r) {
  const w = await doWork(r);
  const digest = buildDigest(r, w.success, w.result, w.error);
  const signature = await verifier.signMessage(ethers.getBytes(digest)); // EIP-191 over 32-byte digest
  const tx = await kernel.fulfillRequest(r.id, w.success, w.result, w.error, signature);
  const rcpt = await tx.wait();
  log(
    `fulfilled #${r.id} (${r.appId}/${r.moduleId}) success=${w.success} result=${w.result.slice(0, 18)}… tx ${tx.hash} gas ${rcpt.gasUsed}`
  );
}

async function cycle(state) {
  const head = await provider.getBlockNumber();
  const from = state.cursor ? state.cursor + 1 : Math.max(0, head - LOOKBACK);
  if (from > head) return state;
  const topic = iface.getEvent('RequestQueued').topicHash;
  // chunk to respect RPC log-range limits
  for (let start = from; start <= head; start += 2000) {
    const end = Math.min(start + 1999, head);
    let logs = [];
    try {
      logs = await provider.getLogs({
        address: ADDR,
        topics: [topic],
        fromBlock: start,
        toBlock: end,
      });
    } catch (e) {
      log(`getLogs ${start}-${end} failed: ${e.message}`);
      return state;
    }
    for (const lg of logs) {
      const ev = iface.parseLog(lg).args;
      const id = ev.requestId;
      let r;
      try {
        r = await kernel.getRequest(id);
      } catch (e) {
        log(`getRequest ${id} failed: ${e.message}`);
        continue;
      }
      if (Number(r.status) !== 1) continue; // 1 == Pending; skip already-fulfilled
      const req = {
        id,
        appId: r.appId,
        moduleId: r.moduleId,
        operation: r.operation,
        payload: r.payload,
        callbackContract: r.callbackContract,
      };
      try {
        await fulfill(req);
      } catch (e) {
        log(`fulfill #${id} error (retry next cycle): ${e.message}`);
        return state;
      }
    }
    state.cursor = end;
    writeState(state);
  }
  return state;
}

(async () => {
  log(
    `neox-fulfiller up: oracle ${ADDR} chain ${CHAIN_ID} updater ${updater.address} verifier ${verifier.address} poll ${POLL_MS}ms`
  );
  let state = readState();
  for (;;) {
    try {
      state = await cycle(state);
    } catch (e) {
      log('cycle error (recovers): ' + e.message);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
})();
