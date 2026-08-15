import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const PRUNE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'db-prune.mjs');

function startMockPostgrest(respondFor) {
  const requests = [];
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const table = req.url.replace(/^\/rest\/v1\//, '').split('?')[0];
      requests.push({ method: req.method, table });
      const status = respondFor(table);
      res.writeHead(status, { 'content-type': 'application/json', 'content-range': '*/5' });
      res.end(status < 300 ? '' : JSON.stringify({ message: 'mock failure' }));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, requests }));
  });
}

function runPrune(envFile) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [PRUNE], {
      env: { ...process.env, RELAYER_ENV_FILE: envFile },
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

function writeEnvFile(url) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'db-prune-'));
  const envFile = path.join(tmp, 'morpheus-relayer.env');
  writeFileSync(envFile, `SUPABASE_URL=${url}\nSUPABASE_SECRET_KEY="test-secret"\n`);
  return envFile;
}

test('prune exits 0 and deletes from every table when all DELETEs succeed', async () => {
  const { server, requests } = await startMockPostgrest(() => 204);
  const { port } = server.address();
  try {
    const result = await runPrune(writeEnvFile(`http://127.0.0.1:${port}`));
    assert.equal(
      result.code,
      0,
      `expected success, got ${result.code}: ${result.stdout}${result.stderr}`
    );
    assert.match(result.stdout, /prune complete/);
    assert.equal(requests.length, 7);
    assert.ok(requests.every((r) => r.method === 'DELETE'));
  } finally {
    server.close();
  }
});

test('prune exits 1 when any DELETE returns a non-2xx so systemd surfaces the failure', async () => {
  const { server } = await startMockPostgrest((table) =>
    table === 'morpheus_operation_logs' ? 500 : 204
  );
  const { port } = server.address();
  try {
    const result = await runPrune(writeEnvFile(`http://127.0.0.1:${port}`));
    assert.equal(
      result.code,
      1,
      `expected failure exit, got ${result.code}: ${result.stdout}${result.stderr}`
    );
    assert.match(result.stdout, /FATAL: 1\/7 tables failed to prune/);
    assert.match(result.stdout, /morpheus_operation_logs: HTTP 500/);
  } finally {
    server.close();
  }
});

test('prune skips absent tables (404) without failing the run', async () => {
  const { server } = await startMockPostgrest((table) =>
    table === 'morpheus_policy_decisions' || table === 'morpheus_risk_events' ? 404 : 204
  );
  const { port } = server.address();
  try {
    const result = await runPrune(writeEnvFile(`http://127.0.0.1:${port}`));
    assert.equal(
      result.code,
      0,
      `expected success, got ${result.code}: ${result.stdout}${result.stderr}`
    );
    assert.match(result.stdout, /prune complete/);
    assert.match(
      result.stdout,
      /skipped absent tables: morpheus_policy_decisions, morpheus_risk_events/
    );
    assert.doesNotMatch(result.stdout, /FATAL/);
  } finally {
    server.close();
  }
});

test('prune exits 1 when every DELETE fails at the network layer', async () => {
  // point at a closed port: each fetch throws, nothing is pruned
  const { server } = await startMockPostgrest(() => 204);
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  const result = await runPrune(writeEnvFile(`http://127.0.0.1:${port}`));
  assert.equal(result.code, 1);
  assert.match(result.stdout, /FATAL: 7\/7 tables failed to prune/);
});

test('prune exits 1 when the relayer env file has no Supabase credentials', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'db-prune-'));
  const envFile = path.join(tmp, 'morpheus-relayer.env');
  writeFileSync(envFile, 'OTHER_VAR=1\n');
  const result = await runPrune(envFile);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /FATAL: no Supabase creds/);
});
