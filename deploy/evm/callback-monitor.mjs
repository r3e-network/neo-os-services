#!/usr/bin/env node
// Neo X callback-registration monitor (OR-D-03 interim mitigation).
//
// The deployed MorpheusOracleEVM kernel's registerMiniApp is permissionless and
// its callback reverse-mapping (_appByCallback) is last-write-wins: anyone can
// register a fresh appId over an EXISTING app's callback contract and brick that
// contract's requestFromCallback path (ModuleNotGranted). The kernel bytecode is
// frozen, so until the next deployment adds the uniqueness require this monitor
// scans MiniAppRegistered events and alerts when:
//   1. a KNOWN callback contract gets (re)registered under a foreign appId, or
//   2. ANY new registration reuses an already-seen callback address.
// Violations are persisted in the state file and keep the monitor red (exit 1)
// until acknowledged: `node deploy/evm/callback-monitor.mjs ack`.
//
// Env:
//   NEOX_RPC            JSON-RPC endpoint (default mainnet-1.rpc.banelabs.org)
//   KERNEL_ADDRESS      oracle kernel (default: contracts-evm build record)
//   STATE_FILE          cursor + seen-callbacks + violations
//                       (default /opt/morpheus/nitro/callback-monitor-state.json)
//   STATUS_FILE         machine-readable status like feed-monitor's
//                       (default /opt/morpheus/nitro/callback-monitor-status.json)
//   MONITOR_LOG         append-only log (default /opt/morpheus/nitro/callback-monitor.log)
//   LOOKBACK_BLOCKS     first-run scan bound (default 50000 ≈ 5 days)
//   CHUNK_BLOCKS        eth_getLogs window size (default 25000)
//   EXPECTED_CALLBACKS  extra "0xaddr=appId,0xaddr=appId" pairs on top of the
//                       built-in dice/message expectations
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const NET = process.env.NEOX_NET || 'neox-mainnet';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

// keccak256("MiniAppRegistered(string,address,address)") — confirmed against the
// live kernel's own logs on Neo X mainnet (kernel deploy block 6733815).
const TOPIC_MINIAPP_REGISTERED =
  '0x0a9520733397afef775ede12870471820a9f662c0425a29d47e21607f3f7fdb6';

function buildRecordAddress(name, fallback) {
  try {
    const rec = JSON.parse(
      readFileSync(resolve(ROOT, `contracts-evm/build/${name}.${NET}.json`), 'utf8')
    );
    return typeof rec.address === 'string' && rec.address ? rec.address : fallback;
  } catch {
    return fallback;
  }
}

const RPC = process.env.NEOX_RPC || 'https://mainnet-1.rpc.banelabs.org';
const KERNEL = (
  process.env.KERNEL_ADDRESS ||
  buildRecordAddress('MorpheusOracleEVM', '0xeCFC1C652B5cCdBfe3E9314a83156787D92a3fD2')
).toLowerCase();
const STATE_FILE = process.env.STATE_FILE || '/opt/morpheus/nitro/callback-monitor-state.json';
const STATUS_FILE = process.env.STATUS_FILE || '/opt/morpheus/nitro/callback-monitor-status.json';
const LOG = process.env.MONITOR_LOG || '/opt/morpheus/nitro/callback-monitor.log';
const LOOKBACK = Number(process.env.LOOKBACK_BLOCKS || 50_000);
const CHUNK = Math.max(1, Number(process.env.CHUNK_BLOCKS || 25_000));

const log = (m) => {
  const line = `[${new Date().toISOString()}] ${m}`;
  try {
    appendFileSync(LOG, line + '\n');
  } catch {}
  console.log(line);
};

// EXPECTED callback contract → appId that legitimately owns it. Seeded from the
// repo's deployment records (with the live mainnet addresses as fallbacks) and
// extendable via EXPECTED_CALLBACKS.
function expectedCallbacks() {
  const map = {};
  map[
    buildRecordAddress(
      'MiniAppDiceGameEVM',
      '0xFA795F814d38F218153d21838360096f3F5cb774'
    ).toLowerCase()
  ] = 'dice';
  map[
    buildRecordAddress(
      'MiniAppMessageEVM',
      '0xd1906192c2308ae416aCDa96238cA846EBB83f15'
    ).toLowerCase()
  ] = 'message';
  for (const pair of (process.env.EXPECTED_CALLBACKS || '').split(',')) {
    const eq = pair.indexOf('=');
    if (eq < 1) continue;
    const addr = pair.slice(0, eq).trim().toLowerCase();
    const appId = pair.slice(eq + 1).trim();
    if (/^0x[0-9a-f]{40}$/.test(addr) && appId) map[addr] = appId;
  }
  delete map[ZERO_ADDRESS];
  return map;
}

async function rpc(method, params) {
  const r = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(20_000),
  });
  let j;
  try {
    j = JSON.parse(await r.text());
  } catch {
    throw new Error(`${method}: non-JSON response`);
  }
  if (j.error) throw new Error(`${method}: ${j.error.message || JSON.stringify(j.error)}`);
  return j.result;
}

// abi.decode(data, (string appId, address admin, address callbackContract)) —
// MiniAppRegistered has no indexed params, so everything lives in `data`.
function decodeRegistration(dataHex) {
  const d = (dataHex || '').replace(/^0x/, '');
  const word = (i) => d.slice(i * 64, (i + 1) * 64);
  if (d.length < 4 * 64) throw new Error('data too short');
  const strOffset = parseInt(word(0), 16);
  if (!Number.isInteger(strOffset) || strOffset % 32 !== 0) throw new Error('bad string offset');
  const admin = '0x' + word(1).slice(24);
  const callback = '0x' + word(2).slice(24);
  const lenPos = strOffset * 2;
  const len = parseInt(d.slice(lenPos, lenPos + 64), 16);
  if (!Number.isInteger(len) || lenPos + 64 + len * 2 > d.length)
    throw new Error('bad string length');
  const appId = Buffer.from(d.slice(lenPos + 64, lenPos + 64 + len * 2), 'hex').toString('utf8');
  return { appId, admin: admin.toLowerCase(), callback: callback.toLowerCase() };
}

function readState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2));
}

function describeViolation(v) {
  if (v.kind === 'known_callback_hijack') {
    return `CALLBACK HIJACK ${v.callback} expected appId=${v.expectedAppId} re-registered as appId=${v.appId} by admin=${v.admin} (block ${v.block} tx ${v.txHash})`;
  }
  if (v.kind === 'callback_reuse') {
    return `CALLBACK REUSE ${v.callback} first appId=${v.firstAppId} re-registered as appId=${v.appId} by admin=${v.admin} (block ${v.block} tx ${v.txHash})`;
  }
  return `REGISTRATION DECODE ERROR block ${v.block} tx ${v.txHash}: ${v.error}`;
}

async function main() {
  const expected = expectedCallbacks();
  const state = readState();
  const firstRun = !Number.isInteger(state.lastBlock);
  const seen = state.seen && typeof state.seen === 'object' ? state.seen : {};
  const violations = Array.isArray(state.violations) ? [...state.violations] : [];
  const violationKey = (v) => `${v.kind}:${v.callback || ''}:${v.txHash || ''}`;
  const known = new Set(violations.map(violationKey));
  const addViolation = (v) => {
    if (known.has(violationKey(v))) return;
    known.add(violationKey(v));
    violations.push(v);
  };

  const latest = parseInt(await rpc('eth_blockNumber', []), 16);
  const from = firstRun ? Math.max(0, latest - LOOKBACK) : state.lastBlock + 1;
  if (firstRun) {
    // Seed the seen-set with the expected owners so a foreign registration over a
    // known callback trips even when the legit registration predates the lookback.
    for (const [cb, appId] of Object.entries(expected)) {
      if (!seen[cb]) seen[cb] = { appId, block: 0, seeded: true };
    }
  }

  let registrations = 0;
  for (let start = from; start <= latest; start += CHUNK) {
    const end = Math.min(start + CHUNK - 1, latest);
    const logs = await rpc('eth_getLogs', [
      {
        address: KERNEL,
        topics: [TOPIC_MINIAPP_REGISTERED],
        fromBlock: '0x' + start.toString(16),
        toBlock: '0x' + end.toString(16),
      },
    ]);
    for (const entry of logs) {
      registrations += 1;
      const block = parseInt(entry.blockNumber, 16);
      let reg;
      try {
        reg = decodeRegistration(entry.data);
      } catch (e) {
        addViolation({
          kind: 'decode_error',
          block,
          txHash: entry.transactionHash,
          error: e.message,
          at: new Date().toISOString(),
        });
        continue;
      }
      const { appId, admin, callback } = reg;
      if (callback === ZERO_ADDRESS) continue; // no reverse-mapping write on the kernel
      const expectedAppId = expected[callback];
      const prior = seen[callback];
      if (expectedAppId && expectedAppId !== appId) {
        addViolation({
          kind: 'known_callback_hijack',
          callback,
          expectedAppId,
          appId,
          admin,
          block,
          txHash: entry.transactionHash,
          at: new Date().toISOString(),
        });
      } else if (prior && prior.appId !== appId) {
        addViolation({
          kind: 'callback_reuse',
          callback,
          firstAppId: prior.appId,
          appId,
          admin,
          block,
          txHash: entry.transactionHash,
          at: new Date().toISOString(),
        });
      } else if (!prior) {
        seen[callback] = { appId, admin, block, txHash: entry.transactionHash };
      }
    }
  }

  writeJson(STATE_FILE, { lastBlock: latest, seen, violations });
  const problems = violations.map(describeViolation);
  writeJson(STATUS_FILE, {
    ts: new Date().toISOString(),
    kernel: KERNEL,
    scanned_from: from,
    scanned_to: latest,
    last_block: latest,
    registrations_scanned: registrations,
    callbacks_tracked: Object.keys(seen).length,
    ok: problems.length === 0,
    problems,
    violations,
  });

  if (problems.length) {
    log('ALERT: ' + problems.join(' | '));
    process.exit(1);
  }
  log(
    `ok scanned=[${from},${latest}] registrations=${registrations} callbacks=${Object.keys(seen).length}`
  );
}

function ack() {
  const state = readState();
  const cleared = Array.isArray(state.violations) ? state.violations.length : 0;
  writeJson(STATE_FILE, { ...state, violations: [] });
  log(`ack: cleared ${cleared} stored violation(s)`);
}

try {
  if (process.argv[2] === 'ack') {
    ack();
  } else {
    await main();
  }
} catch (e) {
  log('monitor RPC error: ' + (e.message || e));
  process.exit(2);
}
