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

const UPDATER_HASH = '0x9fb28bdacfaa7fcc0a4d660d0dc990b0e7d46118';
// Deterministic custody fee_funder identity for the mock signer service.
const funder = new wallet.Account('22'.repeat(32));

// One server plays both sides: the Neo RPC (JSON-RPC on /) and the custody
// signer service (/signer/api/v1/...).
function startTopupStack({ updaterBalanceRaw, funderBalanceRaw }) {
  const requests = [];
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        const respond = (status, bodyObj) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(bodyObj));
        };
        if (req.url.startsWith('/signer/api/v1/')) {
          requests.push({ kind: 'custody', method: req.method, url: req.url });
          if (req.method === 'GET' && /^\/signer\/api\/v1\/keys\/[^/]+$/.test(req.url)) {
            return respond(200, {
              key_id: decodeURIComponent(req.url.split('/').pop()),
              label: 'fee_funder',
              network: 'mainnet',
              network_magic: 860833102,
              public_key: funder.publicKey,
              script_hash: `0x${funder.scriptHash}`,
              address: funder.address,
              verification_script: `0c21${funder.publicKey}4156e7b327`,
              signing_enabled: true,
            });
          }
          if (req.method === 'POST' && req.url === '/signer/api/v1/sign/transaction') {
            const body = JSON.parse(raw || '{}');
            assert.equal(body.key_id, 'fee-funder-2024');
            assert.match(String(body.unsigned_hex || ''), /^[0-9a-f]+$/i);
            return respond(200, {
              allowed: true,
              key_id: body.key_id,
              script_hash: `0x${funder.scriptHash}`,
              address: funder.address,
              digest: 'd'.repeat(64),
              invocation_script: `0c40${'1'.repeat(128)}`,
              verification_script: `0c21${funder.publicKey}4156e7b327`,
            });
          }
          return respond(404, { code: 'not_found', message: 'unexpected custody route' });
        }
        const body = JSON.parse(raw || '{}');
        requests.push(body);
        if (body.method === 'invokefunction') {
          const sh = String(body.params?.[2]?.[0]?.value || '');
          const balanceRaw = sh === UPDATER_HASH ? updaterBalanceRaw : funderBalanceRaw;
          return respond(200, {
            jsonrpc: '2.0',
            id: body.id,
            result: { state: 'HALT', stack: [{ type: 'Integer', value: String(balanceRaw) }] },
          });
        }
        if (body.method === 'getblockcount') {
          return respond(200, { jsonrpc: '2.0', id: body.id, result: 1000 });
        }
        if (body.method === 'invokescript') {
          return respond(200, {
            jsonrpc: '2.0',
            id: body.id,
            result: { state: 'HALT', gasconsumed: '1000000' },
          });
        }
        if (body.method === 'calculatenetworkfee') {
          return respond(200, {
            jsonrpc: '2.0',
            id: body.id,
            result: { networkfee: '100000' },
          });
        }
        if (body.method === 'sendrawtransaction') {
          return respond(200, {
            jsonrpc: '2.0',
            id: body.id,
            result: { hash: `0x${'ab'.repeat(32)}` },
          });
        }
        return respond(200, {
          jsonrpc: '2.0',
          id: body.id,
          error: { message: 'unexpected method' },
        });
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

test('topup accepts a quoted custody token and exits 0 when the updater balance is healthy', async () => {
  // 100 GAS (raw 1e10) >= default threshold 25 -> no transfer attempted.
  const { server } = await startTopupStack({
    updaterBalanceRaw: 10_000_000_000n,
    funderBalanceRaw: 0n,
  });
  const { port } = server.address();
  try {
    const result = await runTopup(
      writeEnvFile(
        `SIGNER_SERVICE_URL="http://127.0.0.1:${port}"\n` +
          'SIGNER_SERVICE_TOKEN="custody-token"\n' +
          'SIGNER_ROLE_FEE_FUNDER_KEY_ID=fee-funder-2024\n'
      ),
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

test('topup parses unquoted token values and key ids containing digits', async () => {
  const { server } = await startTopupStack({
    updaterBalanceRaw: 10_000_000_000n,
    funderBalanceRaw: 0n,
  });
  const { port } = server.address();
  try {
    const result = await runTopup(
      writeEnvFile(
        `SIGNER_SERVICE_URL=http://127.0.0.1:${port}\n` +
          'SIGNER_SERVICE_TOKEN=custody-token\n' +
          'SIGNER_ROLE_FEE_FUNDER_KEY_ID=fee-funder-2024\n' +
          'FUNDING_KEY_2024=ignored\n'
      ),
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

test('topup signs the gas transfer through the custody fee_funder key', async () => {
  // Updater at 10 GAS (raw 1e9) < threshold 25, funder holds 100 GAS.
  const { server, requests } = await startTopupStack({
    updaterBalanceRaw: 1_000_000_000n,
    funderBalanceRaw: 10_000_000_000n,
  });
  const { port } = server.address();
  try {
    const result = await runTopup(
      writeEnvFile(
        `SIGNER_SERVICE_URL=http://127.0.0.1:${port}\n` +
          'SIGNER_SERVICE_TOKEN=custody-token\n' +
          'SIGNER_ROLE_FEE_FUNDER_KEY_ID=fee-funder-2024\n'
      ),
      `http://127.0.0.1:${port}`
    );
    assert.equal(
      result.code,
      0,
      `expected success, got ${result.code}: ${result.stdout}${result.stderr}`
    );
    assert.match(result.stdout, /TOPPED UP updater \+40 GAS/);
    assert.match(result.stdout, /txid 0xabab/);
    const custodyRoutes = requests
      .filter((r) => r.kind === 'custody')
      .map((r) => `${r.method} ${r.url.replace('/signer/api/v1', '')}`);
    assert.ok(
      custodyRoutes.includes('GET /keys/fee-funder-2024'),
      `expected key lookup, got ${custodyRoutes.join(', ')}`
    );
    assert.ok(
      custodyRoutes.includes('POST /sign/transaction'),
      `expected custody signing, got ${custodyRoutes.join(', ')}`
    );
  } finally {
    server.close();
  }
});
