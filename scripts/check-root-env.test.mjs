// scripts/check-root-env.mjs (`npm run check:env`) is what env-check.yml runs
// for a manually dispatched network. It used to read only .env/.env.local, so
// on a runner (which has no .env) it could never pass, and the network chosen
// for the dispatch never reached it: the signers were always checked against
// the testnet default.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const script = path.resolve(import.meta.dirname, 'check-root-env.mjs');

function run(environment, dotenv) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'check-root-env-'));
  try {
    if (dotenv) fs.writeFileSync(path.join(cwd, '.env'), dotenv);
    const result = spawnSync(process.execPath, [script], {
      cwd,
      encoding: 'utf8',
      // Only what the case sets: nothing from the developer's shell leaks in.
      env: { PATH: process.env.PATH ?? '', ...environment },
    });
    assert.equal(result.error, undefined);
    return { status: result.status, report: JSON.parse(result.stdout) };
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

function signerNetworks(report) {
  return [...new Set(report.neo_n3_signers.map((entry) => entry.network))];
}

test('with no configuration at all it fails and reports the network as missing', () => {
  const { status, report } = run({});
  assert.equal(status, 1);
  assert.equal(report.ok, false);
  assert.ok(report.missing.web_server.includes('MORPHEUS_NETWORK'));
  assert.deepEqual(signerNetworks(report), ['testnet']);
});

test('a network exported by the runner selects the signers and satisfies its group', () => {
  const { report } = run({ MORPHEUS_NETWORK: 'mainnet' });
  assert.deepEqual(signerNetworks(report), ['mainnet']);
  assert.equal(report.missing.web_server.includes('MORPHEUS_NETWORK'), false);
});

test('variables injected by the runner satisfy the required groups without a .env file', () => {
  const environment = {
    NEXT_PUBLIC_APP_NAME: 'NeoOS Services',
    NEXT_PUBLIC_APP_URL: 'https://example.invalid',
    MORPHEUS_RUNTIME_URL_MAINNET: 'https://runtime.example.invalid',
    NEXT_PUBLIC_SUPABASE_URL: 'https://db.example.invalid',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-placeholder',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-placeholder',
    MORPHEUS_RUNTIME_TOKEN: 'runtime-token-placeholder',
    MORPHEUS_NETWORK: 'mainnet',
    NEO_RPC_URL: 'https://rpc.example.invalid',
    NEO_NETWORK_MAGIC: '860833102',
    CONTRACT_MORPHEUS_ORACLE_HASH: '0x' + '11'.repeat(20),
    CONTRACT_ORACLE_CALLBACK_CONSUMER_HASH: '0x' + '22'.repeat(20),
    MORPHEUS_FEED_PROVIDER: 'twelvedata',
    MORPHEUS_FEED_PROJECT_SLUG: 'feeds',
    MORPHEUS_CRON_SECRET: 'cron-placeholder',
    MORPHEUS_FEED_SYMBOLS: 'NEO-USD',
  };
  const { report } = run(environment);
  assert.deepEqual(report.missing, { web_public: [], web_server: [], feed_ops: [] });
});

test('the process environment overrides the .env file', () => {
  const { report } = run({ MORPHEUS_NETWORK: 'mainnet' }, 'MORPHEUS_NETWORK=testnet\n');
  assert.deepEqual(signerNetworks(report), ['mainnet']);
  const fromFile = run({}, 'MORPHEUS_NETWORK=mainnet\n');
  assert.deepEqual(signerNetworks(fromFile.report), ['mainnet']);
});
