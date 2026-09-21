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

test('check-nitro-env accepts a custody-only env with no Neo N3 signer WIFs at all', () => {
  const envPath = writeEnvFile([
    'NITRO_SHARED_SECRET=test-secret',
    'SUPABASE_URL=https://supabase.test',
    'SUPABASE_SERVICE_ROLE_KEY=service-role-key',
    'MORPHEUS_NETWORK=mainnet',
    'ORACLE_HTTP_ALLOWLIST=api.example.com',
    'NEO_RPC_URL=https://neo-rpc.test',
    'NEO_NETWORK_MAGIC=860833102',
    'CONTRACT_MORPHEUS_ORACLE_HASH=0xf54d8584ef82315c1800373272ab08ae0db2d5ef',
    'CONTRACT_ORACLE_CALLBACK_CONSUMER_HASH=0xe1226268f2fe08bea67fb29e1c8fda0d7c8e9844',
    'SIGNER_SERVICE_URL=https://custody.test',
    'SIGNER_SERVICE_TOKEN=custody-token',
    'SIGNER_ROLE_UPDATER_KEY_ID=key-updater',
    'SIGNER_ROLE_ORACLE_VERIFIER_KEY_ID=key-oracle-verifier',
    'SIGNER_ROLE_WORKER_KEY_ID=key-worker',
    'MORPHEUS_SIGNING_ADMIN_API_KEY=signing-admin-token',
    'MORPHEUS_RELAY_ADMIN_API_KEY=relay-admin-token',
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
  for (const entry of report.neo_n3_signers) {
    assert.equal(entry.ok, true, `${entry.role} must pass with no local key material`);
    assert.deepEqual(entry.issues, []);
  }
});

function custodyOnlyEnvLines({ network = 'mainnet', omit = [] } = {}) {
  return [
    'NITRO_SHARED_SECRET=test-secret',
    'SUPABASE_URL=https://supabase.test',
    'SUPABASE_SERVICE_ROLE_KEY=service-role-key',
    `MORPHEUS_NETWORK=${network}`,
    'ORACLE_HTTP_ALLOWLIST=api.example.com',
    'NEO_RPC_URL=https://neo-rpc.test',
    `NEO_NETWORK_MAGIC=${network === 'mainnet' ? '860833102' : '894710606'}`,
    'CONTRACT_MORPHEUS_ORACLE_HASH=0xf54d8584ef82315c1800373272ab08ae0db2d5ef',
    'CONTRACT_ORACLE_CALLBACK_CONSUMER_HASH=0xe1226268f2fe08bea67fb29e1c8fda0d7c8e9844',
    'SIGNER_SERVICE_URL=https://custody.test',
    'SIGNER_SERVICE_TOKEN=custody-token',
    'SIGNER_ROLE_UPDATER_KEY_ID=key-updater',
    'SIGNER_ROLE_ORACLE_VERIFIER_KEY_ID=key-oracle-verifier',
    'SIGNER_ROLE_WORKER_KEY_ID=key-worker',
    'MORPHEUS_SIGNING_ADMIN_API_KEY=signing-admin-token',
    'MORPHEUS_RELAY_ADMIN_API_KEY=relay-admin-token',
  ].filter((line) => !omit.some((key) => line.startsWith(`${key}=`)));
}

test('check-nitro-env requires the oracle HTTP allow-list on mainnet only', () => {
  // The enclave's arbitrary-URL oracle lane treats an unset ORACLE_HTTP_ALLOWLIST
  // as an open app-layer gate. The vsock-proxy host allow-list is still the
  // primary, fail-closed control, so this is a mainnet-only requirement and
  // local/testnet runs keep the open-gate behaviour.
  const mainnetPath = writeEnvFile(custodyOnlyEnvLines({ omit: ['ORACLE_HTTP_ALLOWLIST'] }));
  const mainnet = spawnSync(process.execPath, ['scripts/check-nitro-env.mjs'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: baseSpawnEnv({ NITRO_ENV_FILE: mainnetPath }),
  });
  assert.equal(mainnet.status, 1, mainnet.stderr || mainnet.stdout);
  const mainnetReport = JSON.parse(mainnet.stdout);
  assert.equal(mainnetReport.ok, false);
  assert.deepEqual(mainnetReport.missing_required, ['ORACLE_HTTP_ALLOWLIST']);
  assert.deepEqual(mainnetReport.required_on_mainnet, ['ORACLE_HTTP_ALLOWLIST']);

  const testnetPath = writeEnvFile(
    custodyOnlyEnvLines({ network: 'testnet', omit: ['ORACLE_HTTP_ALLOWLIST'] })
  );
  const testnet = spawnSync(process.execPath, ['scripts/check-nitro-env.mjs'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: baseSpawnEnv({ NITRO_ENV_FILE: testnetPath }),
  });
  assert.equal(testnet.status, 0, testnet.stderr || testnet.stdout);
  const testnetReport = JSON.parse(testnet.stdout);
  assert.equal(testnetReport.ok, true);
  assert.deepEqual(testnetReport.missing_required, []);
  assert.deepEqual(testnetReport.required_on_mainnet, []);
});

test('check-nitro-env rejects the caller-supplied local signing escape hatch', () => {
  const envPath = writeEnvFile([
    'NITRO_SHARED_SECRET=test-secret',
    'SUPABASE_URL=https://supabase.test',
    'SUPABASE_SERVICE_ROLE_KEY=service-role-key',
    'MORPHEUS_NETWORK=mainnet',
    'ORACLE_HTTP_ALLOWLIST=api.example.com',
    'NEO_RPC_URL=https://neo-rpc.test',
    'NEO_NETWORK_MAGIC=860833102',
    'CONTRACT_MORPHEUS_ORACLE_HASH=0xf54d8584ef82315c1800373272ab08ae0db2d5ef',
    'CONTRACT_ORACLE_CALLBACK_CONSUMER_HASH=0xe1226268f2fe08bea67fb29e1c8fda0d7c8e9844',
    'SIGNER_SERVICE_URL=https://custody.test',
    'SIGNER_SERVICE_TOKEN=custody-token',
    'SIGNER_ROLE_UPDATER_KEY_ID=key-updater',
    'SIGNER_ROLE_ORACLE_VERIFIER_KEY_ID=key-oracle-verifier',
    'SIGNER_ROLE_WORKER_KEY_ID=key-worker',
    'MORPHEUS_SIGNING_ADMIN_API_KEY=signing-admin-token',
    'MORPHEUS_RELAY_ADMIN_API_KEY=relay-admin-token',
    'MORPHEUS_ALLOW_CALLER_SIGNING_KEY=true',
  ]);

  const result = spawnSync(process.execPath, ['scripts/check-nitro-env.mjs'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: baseSpawnEnv({ NITRO_ENV_FILE: envPath }),
  });

  assert.equal(result.status, 1, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(
    report.forbidden_settings.map((entry) => entry.key),
    ['MORPHEUS_ALLOW_CALLER_SIGNING_KEY']
  );
});

test('check-nitro-env fails a leftover WIF that disagrees with the pinned registry', () => {
  const signer = generatedSignerLines();
  const envPath = writeEnvFile([
    'NITRO_SHARED_SECRET=test-secret',
    'SUPABASE_URL=https://supabase.test',
    'SUPABASE_SERVICE_ROLE_KEY=service-role-key',
    'MORPHEUS_NETWORK=mainnet',
    'ORACLE_HTTP_ALLOWLIST=api.example.com',
    'NEO_RPC_URL=https://neo-rpc.test',
    'NEO_NETWORK_MAGIC=860833102',
    'CONTRACT_MORPHEUS_ORACLE_HASH=0xf54d8584ef82315c1800373272ab08ae0db2d5ef',
    'CONTRACT_ORACLE_CALLBACK_CONSUMER_HASH=0xe1226268f2fe08bea67fb29e1c8fda0d7c8e9844',
    `MORPHEUS_UPDATER_NEO_N3_WIF_MAINNET=${signer.wif}`,
    'SIGNER_SERVICE_URL=https://custody.test',
    'SIGNER_SERVICE_TOKEN=custody-token',
    'SIGNER_ROLE_UPDATER_KEY_ID=key-updater',
    'SIGNER_ROLE_ORACLE_VERIFIER_KEY_ID=key-oracle-verifier',
    'SIGNER_ROLE_WORKER_KEY_ID=key-worker',
    'MORPHEUS_SIGNING_ADMIN_API_KEY=signing-admin-token',
    'MORPHEUS_RELAY_ADMIN_API_KEY=relay-admin-token',
  ]);

  // Pinning stays ON in the subprocess env (no ALLOW_UNPINNED override): the
  // absent-key case passes, but a present-and-mismatched WIF is still drift.
  const result = spawnSync(process.execPath, ['scripts/check-nitro-env.mjs'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH || '',
      HOME: process.env.HOME || '',
      NITRO_ENV_FILE: envPath,
    },
  });

  assert.equal(result.status, 1, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, false);
  const updater = report.neo_n3_signers.find((entry) => entry.role === 'updater');
  assert.equal(updater.ok, false);
  assert.ok(
    updater.issues.some((issue) => /do not match pinned|not a valid/.test(issue)),
    `expected drift issues, got: ${JSON.stringify(updater.issues)}`
  );
});

test('check-nitro-env passes with NITRO_USE_DERIVED_KEYS and no pinned signer WIFs', () => {
  const envPath = writeEnvFile([
    'SUPABASE_URL=https://supabase.test',
    'SUPABASE_SERVICE_ROLE_KEY=service-role-key',
    'MORPHEUS_NETWORK=mainnet',
    'ORACLE_HTTP_ALLOWLIST=api.example.com',
    'NEO_RPC_URL=https://neo-rpc.test',
    'NEO_NETWORK_MAGIC=860833102',
    'CONTRACT_MORPHEUS_ORACLE_HASH=0xf54d8584ef82315c1800373272ab08ae0db2d5ef',
    'CONTRACT_ORACLE_CALLBACK_CONSUMER_HASH=0xe1226268f2fe08bea67fb29e1c8fda0d7c8e9844',
    'NITRO_USE_DERIVED_KEYS=true',
    'NITRO_API_TOKEN=runtime-token',
    'SIGNER_SERVICE_URL=https://custody.test',
    'SIGNER_SERVICE_TOKEN=custody-token',
    'SIGNER_ROLE_UPDATER_KEY_ID=key-updater',
    'SIGNER_ROLE_ORACLE_VERIFIER_KEY_ID=key-oracle-verifier',
    'SIGNER_ROLE_WORKER_KEY_ID=key-worker',
    'MORPHEUS_SIGNING_ADMIN_API_KEY=signing-admin-token',
    'MORPHEUS_RELAY_ADMIN_API_KEY=relay-admin-token',
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
    ['worker', 'updater'].includes(entry.role)
  );
  for (const entry of derivedRoles) {
    assert.equal(entry.derived_key_mode, true);
    assert.equal(entry.ok, true);
    assert.deepEqual(entry.issues, []);
  }
});

test('check-control-plane-env accepts a custody-only execution plane with no signer WIFs', () => {
  const envPath = writeEnvFile([
    'SUPABASE_URL=https://supabase.test',
    'SUPABASE_SERVICE_ROLE_KEY=service-role-key',
    'MORPHEUS_MAINNET_EXECUTION_BASE_URL=https://execution.test',
    'MORPHEUS_EXECUTION_TOKEN=execution-token',
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
  assert.equal(report.mode.execution_plane_configured, true);
  assert.deepEqual(report.partially_configured_missing?.execution_plane || [], []);
  // Signer WIFs no longer count toward the execution plane: signing is
  // custody-side, so a WIF in a control-plane env is not an asset to detect.
  assert.equal(
    (report.optional_recommendations?.execution_plane || []).some((group) =>
      group.includes('MORPHEUS_UPDATER_NEO_N3_WIF_MAINNET')
    ),
    false,
    'execution plane recommendations must not mention signer WIFs'
  );
});

test('check-control-plane-env rejects host signing keys and runtime credential reuse', () => {
  const envPath = writeEnvFile([
    'SUPABASE_URL=https://supabase.test',
    'SUPABASE_SERVICE_ROLE_KEY=service-role-key',
    'MORPHEUS_RUNTIME_TOKEN=shared-token',
    'MORPHEUS_CONTROL_PLANE_API_KEY=shared-token',
    'MORPHEUS_CUSTOM_SIGNER_PRIVATE_KEY=host-key',
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

  assert.equal(result.status, 1, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.forbidden_signer_env, ['MORPHEUS_CUSTOM_SIGNER_PRIVATE_KEY']);
  assert.deepEqual(report.reused_runtime_credential_env, ['MORPHEUS_CONTROL_PLANE_API_KEY']);
});

test('check-nitro-env fails a runtime env file that disables signer pinning', () => {
  const signer = generatedSignerLines();
  const envPath = writeEnvFile([
    'NITRO_SHARED_SECRET=test-secret',
    'SUPABASE_URL=https://supabase.test',
    'SUPABASE_SERVICE_ROLE_KEY=service-role-key',
    'MORPHEUS_NETWORK=mainnet',
    'ORACLE_HTTP_ALLOWLIST=api.example.com',
    'NEO_RPC_URL=https://neo-rpc.test',
    'NEO_NETWORK_MAGIC=860833102',
    'CONTRACT_MORPHEUS_ORACLE_HASH=0xf54d8584ef82315c1800373272ab08ae0db2d5ef',
    'CONTRACT_ORACLE_CALLBACK_CONSUMER_HASH=0xe1226268f2fe08bea67fb29e1c8fda0d7c8e9844',
    'MORPHEUS_ALLOW_UNPINNED_SIGNERS=true',
    `MORPHEUS_UPDATER_NEO_N3_WIF_MAINNET=${signer.wif}`,
    `MORPHEUS_ORACLE_VERIFIER_WIF_MAINNET=${signer.wif}`,
    'SIGNER_SERVICE_URL=https://custody.test',
    'SIGNER_SERVICE_TOKEN=custody-token',
    'SIGNER_ROLE_UPDATER_KEY_ID=key-updater',
    'SIGNER_ROLE_ORACLE_VERIFIER_KEY_ID=key-oracle-verifier',
    'SIGNER_ROLE_WORKER_KEY_ID=key-worker',
    'MORPHEUS_SIGNING_ADMIN_API_KEY=signing-admin-token',
    'MORPHEUS_RELAY_ADMIN_API_KEY=relay-admin-token',
  ]);

  const result = spawnSync(process.execPath, ['scripts/check-nitro-env.mjs'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: baseSpawnEnv({ NITRO_ENV_FILE: envPath }),
  });

  assert.equal(result.status, 1, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, false);
  assert.deepEqual(
    report.forbidden_settings.map((entry) => entry.key),
    [
      'MORPHEUS_ALLOW_UNPINNED_SIGNERS',
      'MORPHEUS_ORACLE_VERIFIER_WIF_MAINNET',
      'MORPHEUS_UPDATER_NEO_N3_WIF_MAINNET',
    ]
  );
});

test('check-nitro-env still rejects host WIFs when the unpinned switch is false', () => {
  const signer = generatedSignerLines();
  const envPath = writeEnvFile([
    'NITRO_SHARED_SECRET=test-secret',
    'SUPABASE_URL=https://supabase.test',
    'SUPABASE_SERVICE_ROLE_KEY=service-role-key',
    'MORPHEUS_NETWORK=mainnet',
    'ORACLE_HTTP_ALLOWLIST=api.example.com',
    'NEO_RPC_URL=https://neo-rpc.test',
    'NEO_NETWORK_MAGIC=860833102',
    'CONTRACT_MORPHEUS_ORACLE_HASH=0xf54d8584ef82315c1800373272ab08ae0db2d5ef',
    'CONTRACT_ORACLE_CALLBACK_CONSUMER_HASH=0xe1226268f2fe08bea67fb29e1c8fda0d7c8e9844',
    'MORPHEUS_ALLOW_UNPINNED_SIGNERS=false',
    `MORPHEUS_UPDATER_NEO_N3_WIF_MAINNET=${signer.wif}`,
    `MORPHEUS_ORACLE_VERIFIER_WIF_MAINNET=${signer.wif}`,
    'SIGNER_SERVICE_URL=https://custody.test',
    'SIGNER_SERVICE_TOKEN=custody-token',
    'SIGNER_ROLE_UPDATER_KEY_ID=key-updater',
    'SIGNER_ROLE_ORACLE_VERIFIER_KEY_ID=key-oracle-verifier',
    'SIGNER_ROLE_WORKER_KEY_ID=key-worker',
    'MORPHEUS_SIGNING_ADMIN_API_KEY=signing-admin-token',
    'MORPHEUS_RELAY_ADMIN_API_KEY=relay-admin-token',
  ]);

  const result = spawnSync(process.execPath, ['scripts/check-nitro-env.mjs'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: baseSpawnEnv({ NITRO_ENV_FILE: envPath }),
  });

  assert.equal(result.status, 1, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, false);
  assert.deepEqual(
    report.forbidden_settings.map((entry) => entry.key),
    ['MORPHEUS_ORACLE_VERIFIER_WIF_MAINNET', 'MORPHEUS_UPDATER_NEO_N3_WIF_MAINNET']
  );
});

test('check-nitro-env requires admin credentials and rejects cross-domain reuse', () => {
  const envPath = writeEnvFile([
    'NITRO_SHARED_SECRET=shared-token',
    'SUPABASE_URL=https://supabase.test',
    'SUPABASE_SERVICE_ROLE_KEY=service-role-key',
    'MORPHEUS_NETWORK=mainnet',
    'ORACLE_HTTP_ALLOWLIST=api.example.com',
    'NEO_RPC_URL=https://neo-rpc.test',
    'NEO_NETWORK_MAGIC=860833102',
    'CONTRACT_MORPHEUS_ORACLE_HASH=0xf54d8584ef82315c1800373272ab08ae0db2d5ef',
    'CONTRACT_ORACLE_CALLBACK_CONSUMER_HASH=0xe1226268f2fe08bea67fb29e1c8fda0d7c8e9844',
    'SIGNER_SERVICE_URL=https://custody.test',
    'SIGNER_SERVICE_TOKEN=signing-token',
    'SIGNER_ROLE_UPDATER_KEY_ID=key-updater',
    'SIGNER_ROLE_ORACLE_VERIFIER_KEY_ID=key-oracle-verifier',
    'SIGNER_ROLE_WORKER_KEY_ID=key-worker',
    'MORPHEUS_SIGNING_ADMIN_API_KEY=shared-token',
  ]);
  const result = spawnSync(process.execPath, ['scripts/check-nitro-env.mjs'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: baseSpawnEnv({ NITRO_ENV_FILE: envPath }),
  });
  assert.equal(result.status, 1, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.missing_required, ['MORPHEUS_RELAY_ADMIN_API_KEY']);
  assert.deepEqual(report.credential_domain_collisions, [
    {
      domains: ['runtime', 'signing'],
      names: ['MORPHEUS_SIGNING_ADMIN_API_KEY', 'NITRO_SHARED_SECRET'],
    },
  ]);
});
