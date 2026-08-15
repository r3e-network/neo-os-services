import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { wallet } from '@cityofzion/neon-js';

const repoRoot = path.resolve(import.meta.dirname, '..');

function baseSpawnEnv(extra = {}) {
  return {
    PATH: process.env.PATH || '',
    HOME: process.env.HOME || '',
    MORPHEUS_ALLOW_UNPINNED_SIGNERS: 'true',
    ...extra,
  };
}

function writeEnvFile(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'morpheus-env-signers-'));
  const filePath = path.join(dir, '.env');
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
  return filePath;
}

function generatedSignerLines() {
  const account = new wallet.Account(wallet.generatePrivateKey());
  return {
    wif: account.WIF,
    privateKey: account.privateKey,
  };
}

test('check-nitro-env accepts suffix-scoped mainnet worker, relayer, and updater signers', () => {
  const signer = generatedSignerLines();
  const envPath = writeEnvFile([
    'NITRO_SHARED_SECRET=test-secret',
    'SUPABASE_URL=https://supabase.test',
    'SUPABASE_SERVICE_ROLE_KEY=service-role-key',
    'MORPHEUS_NETWORK=mainnet',
    'NEO_RPC_URL=https://neo-rpc.test',
    'NEO_NETWORK_MAGIC=860833102',
    'CONTRACT_MORPHEUS_ORACLE_HASH=0xf54d8584ef82315c1800373272ab08ae0db2d5ef',
    'CONTRACT_ORACLE_CALLBACK_CONSUMER_HASH=0xe1226268f2fe08bea67fb29e1c8fda0d7c8e9844',
    'MORPHEUS_ALLOW_UNPINNED_SIGNERS=true',
    `MORPHEUS_WORKER_NEO_N3_WIF_MAINNET=${signer.wif}`,
    `MORPHEUS_RELAYER_NEO_N3_WIF_MAINNET=${signer.wif}`,
    `MORPHEUS_UPDATER_NEO_N3_WIF_MAINNET=${signer.wif}`,
    `MORPHEUS_ORACLE_VERIFIER_WIF_MAINNET=${signer.wif}`,
  ]);

  const result = spawnSync(process.execPath, ['scripts/check-nitro-env.mjs'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: baseSpawnEnv({ NITRO_ENV_FILE: envPath }),
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.deepEqual(report.missing_either_of, []);
});

test('check-nitro-env passes with NITRO_USE_DERIVED_KEYS and no pinned signer WIFs', () => {
  const signer = generatedSignerLines();
  const envPath = writeEnvFile([
    'SUPABASE_URL=https://supabase.test',
    'SUPABASE_SERVICE_ROLE_KEY=service-role-key',
    'MORPHEUS_NETWORK=mainnet',
    'NEO_RPC_URL=https://neo-rpc.test',
    'NEO_NETWORK_MAGIC=860833102',
    'CONTRACT_MORPHEUS_ORACLE_HASH=0xf54d8584ef82315c1800373272ab08ae0db2d5ef',
    'CONTRACT_ORACLE_CALLBACK_CONSUMER_HASH=0xe1226268f2fe08bea67fb29e1c8fda0d7c8e9844',
    'MORPHEUS_ALLOW_UNPINNED_SIGNERS=true',
    'NITRO_USE_DERIVED_KEYS=true',
    'NITRO_API_TOKEN=runtime-token',
    `MORPHEUS_ORACLE_VERIFIER_WIF_MAINNET=${signer.wif}`,
  ]);

  const result = spawnSync(process.execPath, ['scripts/check-nitro-env.mjs'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: baseSpawnEnv({ NITRO_ENV_FILE: envPath }),
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.deepEqual(report.missing_required, []);
  assert.deepEqual(report.missing_either_of, []);
  const derivedRoles = report.neo_n3_signers.filter((entry) =>
    ['worker', 'relayer', 'updater'].includes(entry.role)
  );
  for (const entry of derivedRoles) {
    assert.equal(entry.derived_key_mode, true);
    assert.equal(entry.ok, true);
    assert.deepEqual(entry.issues, []);
  }
});

test('check-control-plane-env accepts suffix-scoped mainnet updater signer for feed execution', () => {
  const signer = generatedSignerLines();
  const envPath = writeEnvFile([
    'SUPABASE_URL=https://supabase.test',
    'SUPABASE_SERVICE_ROLE_KEY=service-role-key',
    'MORPHEUS_MAINNET_EXECUTION_BASE_URL=https://execution.test',
    'MORPHEUS_EXECUTION_TOKEN=execution-token',
    `MORPHEUS_UPDATER_NEO_N3_WIF_MAINNET=${signer.wif}`,
  ]);

  const result = spawnSync(
    process.execPath,
    [path.join(repoRoot, 'scripts/check-control-plane-env.mjs')],
    {
      cwd: path.dirname(envPath),
      encoding: 'utf8',
      env: baseSpawnEnv(),
    }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.deepEqual(report.partially_configured_missing?.execution_plane || [], []);
});
