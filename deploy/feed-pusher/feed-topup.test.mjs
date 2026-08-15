import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import pkg from '@cityofzion/neon-js';

const { wallet } = pkg;
const TOPUP = path.join(path.dirname(fileURLToPath(import.meta.url)), 'feed-topup.mjs');

function startMockRpc(balanceRaw) {
  const requests = [];
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        const body = JSON.parse(raw || '{}');
        requests.push(body);
        res.writeHead(200, { 'content-type': 'application/json' });
        if (body.method === 'invokefunction') {
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: body.id,
              result: { state: 'HALT', stack: [{ type: 'Integer', value: String(balanceRaw) }] },
            })
          );
          return;
        }
        res.end(
          JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { message: 'unexpected method' } })
        );
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, requests }));
  });
}

function runTopup(envFile, rpcUrl) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TOPUP], {
      env: {
        ...process.env,
        FEED_TOPUP_ENV_FILE: envFile,
        FEED_RPCS: rpcUrl,
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
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function writeEnvFile(contents) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'feed-topup-'));
  const envFile = path.join(tmp, 'feed-topup.env');
  writeFileSync(envFile, contents);
  return envFile;
}

test('topup accepts a quoted TOPUP_WIF and exits 0 when the updater balance is healthy', async () => {
  const wif = new wallet.Account().WIF;
  // 100 GAS (raw 1e10) >= default threshold 25 -> no transfer attempted.
  const { server } = await startMockRpc(10_000_000_000n);
  const { port } = server.address();
  try {
    const result = await runTopup(writeEnvFile(`TOPUP_WIF="${wif}"\n`), `http://127.0.0.1:${port}`);
    assert.equal(
      result.code,
      0,
      `expected success, got ${result.code}: ${result.stdout}${result.stderr}`
    );
    assert.match(result.stdout, /no topup needed/);
  } finally {
    server.close();
  }
});

test('topup parses unquoted WIF values and keys containing digits', async () => {
  const wif = new wallet.Account().WIF;
  const { server } = await startMockRpc(10_000_000_000n);
  const { port } = server.address();
  try {
    const result = await runTopup(
      writeEnvFile(`TOPUP_WIF=${wif}\nFUNDING_KEY_2024=ignored\n`),
      `http://127.0.0.1:${port}`
    );
    assert.equal(
      result.code,
      0,
      `expected success, got ${result.code}: ${result.stdout}${result.stderr}`
    );
    assert.match(result.stdout, /no topup needed/);
  } finally {
    server.close();
  }
});
