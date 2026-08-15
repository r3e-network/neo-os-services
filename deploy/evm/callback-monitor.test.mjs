import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, mkdtempSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const MONITOR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'callback-monitor.mjs');
const KERNEL = '0xecfc1c652b5ccdbfe3e9314a83156787d92a3fd2';
const TOPIC = '0x0a9520733397afef775ede12870471820a9f662c0425a29d47e21607f3f7fdb6';
// Live mainnet consumer callbacks (built-in expectations of the monitor).
const DICE_CALLBACK = '0xfa795f814d38f218153d21838360096f3f5cb774';
const ADMIN = '0x622ae03bdb6d7e2a29be853c75d625bb25c0139c';

// abi.encode(string appId, address admin, address callbackContract) for the
// non-indexed MiniAppRegistered event data.
function registrationData(appId, admin, callback) {
  const pad = (hex) => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0');
  const str = Buffer.from(appId, 'utf8');
  const padded = str.toString('hex').padEnd(Math.max(1, Math.ceil(str.length / 32)) * 64, '0');
  return (
    '0x' + pad('0x60') + pad(admin) + pad(callback) + pad('0x' + str.length.toString(16)) + padded
  );
}

function registrationLog({ appId, admin = ADMIN, callback, block, txHash }) {
  return {
    address: KERNEL,
    topics: [TOPIC],
    data: registrationData(appId, admin, callback),
    blockNumber: '0x' + block.toString(16),
    transactionHash: txHash || '0x' + String(block).padStart(64, '0'),
  };
}

// Minimal EVM JSON-RPC stub: serves eth_blockNumber + eth_getLogs (filtered by
// the requested block range) and records every eth_getLogs window it was asked for.
function startMockRpc({ latestBlock, logs = [] }) {
  const calls = [];
  return new Promise((resolvePromise) => {
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        const body = JSON.parse(raw);
        let result;
        if (body.method === 'eth_blockNumber') {
          result = '0x' + latestBlock.toString(16);
        } else if (body.method === 'eth_getLogs') {
          const filter = body.params[0];
          const from = parseInt(filter.fromBlock, 16);
          const to = parseInt(filter.toBlock, 16);
          calls.push({ from, to });
          result = logs.filter((l) => {
            const block = parseInt(l.blockNumber, 16);
            return block >= from && block <= to;
          });
        } else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: body.id,
              error: { code: -32601, message: `unsupported ${body.method}` },
            })
          );
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolvePromise({ server, calls }));
  });
}

function runMonitor(rpcUrl, dir, extraEnv = {}, args = []) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [MONITOR, ...args], {
      env: {
        ...process.env,
        NEOX_RPC: rpcUrl,
        KERNEL_ADDRESS: KERNEL,
        STATE_FILE: path.join(dir, 'callback-monitor-state.json'),
        STATUS_FILE: path.join(dir, 'callback-monitor-status.json'),
        MONITOR_LOG: path.join(dir, 'callback-monitor.log'),
        ...extraEnv,
      },
      encoding: 'utf8',
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }));
  });
}

const readJson = (dir, name) => JSON.parse(readFileSync(path.join(dir, name), 'utf8'));

test('clean pass: legit registrations exit 0 and the first run is lookback-bounded', async () => {
  const { server, calls } = await startMockRpc({
    latestBlock: 1000,
    logs: [
      registrationLog({ appId: 'dice', callback: DICE_CALLBACK, block: 600 }),
      registrationLog({
        appId: 'fresh-app',
        callback: '0x1111111111111111111111111111111111111111',
        block: 700,
      }),
    ],
  });
  const { port } = server.address();
  const dir = mkdtempSync(path.join(os.tmpdir(), 'callback-monitor-'));
  try {
    const result = await runMonitor(`http://127.0.0.1:${port}`, dir, { LOOKBACK_BLOCKS: '500' });
    assert.equal(
      result.code,
      0,
      `expected ok exit, got ${result.code}: ${result.stdout}${result.stderr}`
    );
    assert.match(result.stdout, /ok scanned=\[500,1000\] registrations=2/);
    // First-run lookback bound: scan starts at latest - LOOKBACK_BLOCKS, not 0.
    assert.equal(calls[0].from, 500);
    assert.equal(calls[calls.length - 1].to, 1000);
    const status = readJson(dir, 'callback-monitor-status.json');
    assert.equal(status.ok, true);
    assert.equal(status.problems.length, 0);
    assert.equal(status.scanned_from, 500);
    const state = readJson(dir, 'callback-monitor-state.json');
    assert.equal(state.lastBlock, 1000);
    assert.equal(state.seen[DICE_CALLBACK].appId, 'dice');
    assert.equal(state.seen['0x1111111111111111111111111111111111111111'].appId, 'fresh-app');
  } finally {
    server.close();
  }
});

test('violation: a known callback re-registered under a foreign appId alerts and exits 1', async () => {
  const { server } = await startMockRpc({
    latestBlock: 2000,
    logs: [
      registrationLog({
        appId: 'evil-app',
        admin: '0xbadbadbadbadbadbadbadbadbadbadbadbadbad0',
        callback: DICE_CALLBACK,
        block: 1500,
      }),
    ],
  });
  const { port } = server.address();
  const dir = mkdtempSync(path.join(os.tmpdir(), 'callback-monitor-'));
  try {
    const result = await runMonitor(`http://127.0.0.1:${port}`, dir, { LOOKBACK_BLOCKS: '1000' });
    assert.equal(
      result.code,
      1,
      `expected alert exit 1, got ${result.code}: ${result.stdout}${result.stderr}`
    );
    assert.match(result.stdout, /ALERT: CALLBACK HIJACK/);
    assert.match(result.stdout, /expected appId=dice re-registered as appId=evil-app/);
    const status = readJson(dir, 'callback-monitor-status.json');
    assert.equal(status.ok, false);
    assert.equal(status.violations[0].kind, 'known_callback_hijack');
    assert.equal(status.violations[0].callback, DICE_CALLBACK);
  } finally {
    server.close();
  }
});

test('violation: any registration reusing an already-seen callback address alerts', async () => {
  const reused = '0x2222222222222222222222222222222222222222';
  const { server } = await startMockRpc({
    latestBlock: 3000,
    logs: [
      registrationLog({ appId: 'app-one', callback: reused, block: 2100 }),
      registrationLog({ appId: 'app-two', callback: reused, block: 2200 }),
    ],
  });
  const { port } = server.address();
  const dir = mkdtempSync(path.join(os.tmpdir(), 'callback-monitor-'));
  try {
    const result = await runMonitor(`http://127.0.0.1:${port}`, dir, { LOOKBACK_BLOCKS: '1000' });
    assert.equal(
      result.code,
      1,
      `expected alert exit 1, got ${result.code}: ${result.stdout}${result.stderr}`
    );
    assert.match(result.stdout, /ALERT: CALLBACK REUSE/);
    const status = readJson(dir, 'callback-monitor-status.json');
    assert.equal(status.ok, false);
    assert.equal(status.violations[0].kind, 'callback_reuse');
    assert.equal(status.violations[0].firstAppId, 'app-one');
    assert.equal(status.violations[0].appId, 'app-two');
    // The first registrant stays the recorded owner.
    const state = readJson(dir, 'callback-monitor-state.json');
    assert.equal(state.seen[reused].appId, 'app-one');
  } finally {
    server.close();
  }
});

test('state-file progression: the second run resumes from lastBlock+1 and skips old logs', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'callback-monitor-'));
  const first = await startMockRpc({
    latestBlock: 1000,
    logs: [registrationLog({ appId: 'dice', callback: DICE_CALLBACK, block: 900 })],
  });
  try {
    const r1 = await runMonitor(`http://127.0.0.1:${first.server.address().port}`, dir, {
      LOOKBACK_BLOCKS: '500',
    });
    assert.equal(r1.code, 0, r1.stdout + r1.stderr);
    assert.equal(readJson(dir, 'callback-monitor-state.json').lastBlock, 1000);
  } finally {
    first.server.close();
  }
  // Second run: chain advanced; an old in-window-looking log must not be rescanned.
  const second = await startMockRpc({
    latestBlock: 1100,
    logs: [registrationLog({ appId: 'dice', callback: DICE_CALLBACK, block: 900 })],
  });
  try {
    const r2 = await runMonitor(`http://127.0.0.1:${second.server.address().port}`, dir, {
      LOOKBACK_BLOCKS: '500',
    });
    assert.equal(r2.code, 0, r2.stdout + r2.stderr);
    assert.equal(second.calls[0].from, 1001);
    assert.match(r2.stdout, /ok scanned=\[1001,1100\] registrations=0/);
    assert.equal(readJson(dir, 'callback-monitor-state.json').lastBlock, 1100);
  } finally {
    second.server.close();
  }
});

test('violations are sticky across runs until acknowledged', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'callback-monitor-'));
  const first = await startMockRpc({
    latestBlock: 1000,
    logs: [registrationLog({ appId: 'evil-app', callback: DICE_CALLBACK, block: 800 })],
  });
  try {
    const r1 = await runMonitor(`http://127.0.0.1:${first.server.address().port}`, dir, {
      LOOKBACK_BLOCKS: '500',
    });
    assert.equal(r1.code, 1, r1.stdout + r1.stderr);
  } finally {
    first.server.close();
  }
  // A later clean window still alerts (the hijack happened; it does not un-happen).
  const second = await startMockRpc({ latestBlock: 1100, logs: [] });
  try {
    const r2 = await runMonitor(`http://127.0.0.1:${second.server.address().port}`, dir, {
      LOOKBACK_BLOCKS: '500',
    });
    assert.equal(r2.code, 1, `sticky violation must keep exit 1: ${r2.stdout}${r2.stderr}`);
    assert.match(r2.stdout, /ALERT: CALLBACK HIJACK/);
  } finally {
    second.server.close();
  }
  // `ack` clears the stored violations; the next clean run goes green.
  const ackRun = await runMonitor('http://127.0.0.1:1', dir, {}, ['ack']);
  assert.equal(ackRun.code, 0, ackRun.stdout + ackRun.stderr);
  assert.match(ackRun.stdout, /ack: cleared 1 stored violation/);
  const third = await startMockRpc({ latestBlock: 1200, logs: [] });
  try {
    const r3 = await runMonitor(`http://127.0.0.1:${third.server.address().port}`, dir, {
      LOOKBACK_BLOCKS: '500',
    });
    assert.equal(r3.code, 0, r3.stdout + r3.stderr);
    assert.equal(readJson(dir, 'callback-monitor-status.json').ok, true);
  } finally {
    third.server.close();
  }
});

test('rpc failure exits 2 without advancing the state file', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'callback-monitor-'));
  const result = await runMonitor('http://127.0.0.1:1', dir, { LOOKBACK_BLOCKS: '500' });
  assert.equal(
    result.code,
    2,
    `expected rpc-error exit 2, got ${result.code}: ${result.stdout}${result.stderr}`
  );
  assert.match(result.stdout, /monitor RPC error/);
  assert.throws(() => readJson(dir, 'callback-monitor-state.json'));
});
