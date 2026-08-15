import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = path.resolve(import.meta.dirname, '..');

function writeEnvFile(filePath, values) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    Object.entries(values)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n') + '\n',
    'utf8'
  );
}

function parseEnv(raw) {
  return Object.fromEntries(
    raw
      .split(/\r?\n/)
      .filter((line) => line && !line.startsWith('#') && line.includes('='))
      .map((line) => {
        const index = line.indexOf('=');
        return [line.slice(0, index), line.slice(index + 1)];
      })
  );
}

test('render-nitro-hub-env propagates heartbeat URLs and network-scoped signer material', () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-nitro-hub-env-'));
  const deployDir = path.join(workDir, 'deploy/nitro');
  const outputPath = path.join(deployDir, 'morpheus.hub.env');
  const shared = {
    MORPHEUS_NITRO_WORKER_IMAGE: 'worker:test',
    MORPHEUS_RELAYER_IMAGE: 'relayer:test',
    NITRO_API_TOKEN: 'shared-secret',
    SUPABASE_URL: 'https://supabase.example',
    SUPABASE_SECRET_KEY: 'supabase-secret',
  };

  writeEnvFile(path.join(deployDir, 'morpheus.mainnet.env'), {
    ...shared,
    MORPHEUS_BETTERSTACK_RELAYER_HEARTBEAT_URL: 'https://heartbeat.example/request',
    MORPHEUS_BETTERSTACK_RELAYER_FEED_HEARTBEAT_URL: 'https://heartbeat.example/feed',
    MORPHEUS_BETTERSTACK_RELAYER_FAILURE_URL: 'https://heartbeat.example/failure',
    MORPHEUS_RUNTIME_CONFIG_JSON: JSON.stringify({
      MORPHEUS_NETWORK: 'mainnet',
      MORPHEUS_WORKER_NEO_N3_WIF: 'mainnet-feed-wif',
      MORPHEUS_WORKER_NEO_N3_PRIVATE_KEY: 'mainnet-feed-private-key',
      MORPHEUS_RELAYER_NEO_N3_WIF: 'mainnet-request-wif',
      MORPHEUS_RELAYER_NEO_N3_PRIVATE_KEY: 'mainnet-request-private-key',
      MORPHEUS_UPDATER_NEO_N3_WIF: 'mainnet-updater-wif',
      MORPHEUS_UPDATER_NEO_N3_PRIVATE_KEY: 'mainnet-updater-private-key',
    }),
  });
  writeEnvFile(path.join(deployDir, 'morpheus.testnet.env'), {
    ...shared,
    MORPHEUS_RUNTIME_CONFIG_JSON: JSON.stringify({
      MORPHEUS_NETWORK: 'testnet',
      MORPHEUS_WORKER_NEO_N3_WIF: 'testnet-feed-wif',
      MORPHEUS_WORKER_NEO_N3_PRIVATE_KEY: 'testnet-feed-private-key',
      MORPHEUS_RELAYER_NEO_N3_WIF: 'testnet-request-wif',
      MORPHEUS_RELAYER_NEO_N3_PRIVATE_KEY: 'testnet-request-private-key',
      MORPHEUS_UPDATER_NEO_N3_WIF: 'testnet-updater-wif',
      MORPHEUS_UPDATER_NEO_N3_PRIVATE_KEY: 'testnet-updater-private-key',
    }),
  });

  const result = spawnSync(
    process.execPath,
    [path.join(repoRoot, 'scripts/render-nitro-hub-env.mjs'), '--output', outputPath],
    {
      cwd: workDir,
      encoding: 'utf8',
      env: { PATH: process.env.PATH },
    }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.statSync(outputPath).mode & 0o777, 0o600, 'rendered env must be owner-only');
  const rendered = parseEnv(fs.readFileSync(outputPath, 'utf8'));

  assert.equal(
    rendered.MORPHEUS_BETTERSTACK_RELAYER_HEARTBEAT_URL,
    'https://heartbeat.example/request'
  );
  assert.equal(
    rendered.MORPHEUS_BETTERSTACK_RELAYER_FEED_HEARTBEAT_URL,
    'https://heartbeat.example/feed'
  );
  assert.equal(
    rendered.MORPHEUS_BETTERSTACK_RELAYER_FAILURE_URL,
    'https://heartbeat.example/failure'
  );
  assert.equal(rendered.MORPHEUS_WORKER_NEO_N3_WIF_MAINNET, 'mainnet-feed-wif');
  assert.equal(rendered.MORPHEUS_WORKER_NEO_N3_PRIVATE_KEY_MAINNET, 'mainnet-feed-private-key');
  assert.equal(rendered.MORPHEUS_WORKER_NEO_N3_WIF_TESTNET, 'testnet-feed-wif');
  assert.equal(rendered.MORPHEUS_WORKER_NEO_N3_PRIVATE_KEY_TESTNET, 'testnet-feed-private-key');
  assert.equal(rendered.MORPHEUS_RELAYER_NEO_N3_WIF_MAINNET, 'mainnet-request-wif');
  assert.equal(rendered.MORPHEUS_RELAYER_NEO_N3_PRIVATE_KEY_MAINNET, 'mainnet-request-private-key');
  assert.equal(rendered.MORPHEUS_UPDATER_NEO_N3_WIF_MAINNET, 'mainnet-updater-wif');
  assert.equal(rendered.MORPHEUS_UPDATER_NEO_N3_PRIVATE_KEY_MAINNET, 'mainnet-updater-private-key');
  assert.equal(rendered.MORPHEUS_RELAYER_NEO_N3_WIF_TESTNET, 'testnet-request-wif');
  assert.equal(rendered.MORPHEUS_RELAYER_NEO_N3_PRIVATE_KEY_TESTNET, 'testnet-request-private-key');
  assert.equal(rendered.MORPHEUS_UPDATER_NEO_N3_WIF_TESTNET, 'testnet-updater-wif');
  assert.equal(rendered.MORPHEUS_UPDATER_NEO_N3_PRIVATE_KEY_TESTNET, 'testnet-updater-private-key');
});

test('render-nitro-hub-env lets secure local signer injection override packed runtime gaps', () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-nitro-hub-env-local-'));
  const deployDir = path.join(workDir, 'deploy/nitro');
  const outputPath = path.join(deployDir, 'morpheus.hub.env');
  const shared = {
    MORPHEUS_NITRO_WORKER_IMAGE: 'worker:test',
    MORPHEUS_RELAYER_IMAGE: 'relayer:test',
    NITRO_API_TOKEN: 'shared-secret',
    SUPABASE_URL: 'https://supabase.example',
    SUPABASE_SECRET_KEY: 'supabase-secret',
  };

  writeEnvFile(path.join(workDir, '.env.local'), {
    MORPHEUS_RELAYER_NEO_N3_WIF_MAINNET: 'local-mainnet-request-wif',
    MORPHEUS_UPDATER_NEO_N3_WIF_MAINNET: 'local-mainnet-updater-wif',
  });
  writeEnvFile(path.join(deployDir, 'morpheus.mainnet.env'), {
    ...shared,
    MORPHEUS_RUNTIME_CONFIG_JSON: JSON.stringify({
      MORPHEUS_NETWORK: 'mainnet',
      MORPHEUS_RELAYER_NEO_N3_WIF: '',
      MORPHEUS_UPDATER_NEO_N3_WIF: '',
    }),
  });
  writeEnvFile(path.join(deployDir, 'morpheus.testnet.env'), {
    ...shared,
    MORPHEUS_RUNTIME_CONFIG_JSON: JSON.stringify({
      MORPHEUS_NETWORK: 'testnet',
    }),
  });

  const result = spawnSync(
    process.execPath,
    [path.join(repoRoot, 'scripts/render-nitro-hub-env.mjs'), '--output', outputPath],
    {
      cwd: workDir,
      encoding: 'utf8',
      env: { PATH: process.env.PATH },
    }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const rendered = parseEnv(fs.readFileSync(outputPath, 'utf8'));

  assert.equal(rendered.MORPHEUS_RELAYER_NEO_N3_WIF_MAINNET, 'local-mainnet-request-wif');
  assert.equal(rendered.MORPHEUS_UPDATER_NEO_N3_WIF_MAINNET, 'local-mainnet-updater-wif');
});

test('render-nitro-hub-env never promotes unscoped local signer material into scoped hub keys', () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-nitro-hub-env-unscoped-'));
  const deployDir = path.join(workDir, 'deploy/nitro');
  const outputPath = path.join(deployDir, 'morpheus.hub.env');
  const shared = {
    MORPHEUS_NITRO_WORKER_IMAGE: 'worker:test',
    MORPHEUS_RELAYER_IMAGE: 'relayer:test',
    NITRO_API_TOKEN: 'shared-secret',
    SUPABASE_URL: 'https://supabase.example',
    SUPABASE_SECRET_KEY: 'supabase-secret',
  };

  writeEnvFile(path.join(workDir, '.env.local'), {
    MORPHEUS_WORKER_NEO_N3_PRIVATE_KEY: 'local-generic-worker-private-key',
    MORPHEUS_ORACLE_VERIFIER_PUBLIC_KEY: 'local-generic-verifier-public-key',
  });
  writeEnvFile(path.join(deployDir, 'morpheus.mainnet.env'), {
    ...shared,
    MORPHEUS_RUNTIME_CONFIG_JSON: JSON.stringify({
      MORPHEUS_NETWORK: 'mainnet',
      MORPHEUS_WORKER_NEO_N3_PRIVATE_KEY: 'mainnet-worker-private-key',
      MORPHEUS_ORACLE_VERIFIER_PUBLIC_KEY: 'mainnet-verifier-public-key',
    }),
  });
  writeEnvFile(path.join(deployDir, 'morpheus.testnet.env'), {
    ...shared,
    MORPHEUS_RUNTIME_CONFIG_JSON: JSON.stringify({
      MORPHEUS_NETWORK: 'testnet',
      MORPHEUS_WORKER_NEO_N3_PRIVATE_KEY: 'testnet-worker-private-key',
      MORPHEUS_ORACLE_VERIFIER_PUBLIC_KEY: 'testnet-verifier-public-key',
    }),
  });

  const result = spawnSync(
    process.execPath,
    [path.join(repoRoot, 'scripts/render-nitro-hub-env.mjs'), '--output', outputPath],
    {
      cwd: workDir,
      encoding: 'utf8',
      env: { PATH: process.env.PATH },
    }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const rendered = parseEnv(fs.readFileSync(outputPath, 'utf8'));

  assert.equal(rendered.MORPHEUS_WORKER_NEO_N3_PRIVATE_KEY_MAINNET, 'mainnet-worker-private-key');
  assert.equal(rendered.MORPHEUS_WORKER_NEO_N3_PRIVATE_KEY_TESTNET, 'testnet-worker-private-key');
  assert.equal(rendered.MORPHEUS_ORACLE_VERIFIER_PUBLIC_KEY_MAINNET, 'mainnet-verifier-public-key');
  assert.equal(rendered.MORPHEUS_ORACLE_VERIFIER_PUBLIC_KEY_TESTNET, 'testnet-verifier-public-key');
});

test('render-nitro-hub-env derives MORPHEUS_RUNTIME_TOKEN from a NITRO_API_TOKEN-only env', () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-nitro-hub-env-nitro-token-'));
  const deployDir = path.join(workDir, 'deploy/nitro');
  const outputPath = path.join(deployDir, 'morpheus.hub.env');
  const shared = {
    MORPHEUS_NITRO_WORKER_IMAGE: 'worker:test',
    MORPHEUS_RELAYER_IMAGE: 'relayer:test',
    NITRO_API_TOKEN: 'nitro-only-secret',
    SUPABASE_URL: 'https://supabase.example',
    SUPABASE_SECRET_KEY: 'supabase-secret',
  };

  writeEnvFile(path.join(deployDir, 'morpheus.mainnet.env'), {
    ...shared,
    MORPHEUS_RUNTIME_CONFIG_JSON: JSON.stringify({ MORPHEUS_NETWORK: 'mainnet' }),
  });
  writeEnvFile(path.join(deployDir, 'morpheus.testnet.env'), {
    ...shared,
    MORPHEUS_RUNTIME_CONFIG_JSON: JSON.stringify({ MORPHEUS_NETWORK: 'testnet' }),
  });

  const result = spawnSync(
    process.execPath,
    [path.join(repoRoot, 'scripts/render-nitro-hub-env.mjs'), '--output', outputPath],
    {
      cwd: workDir,
      encoding: 'utf8',
      env: { PATH: process.env.PATH },
    }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const rendered = parseEnv(fs.readFileSync(outputPath, 'utf8'));

  assert.equal(rendered.MORPHEUS_RUNTIME_TOKEN, 'nitro-only-secret');
  assert.equal(rendered.NITRO_API_TOKEN, 'nitro-only-secret');
});

test('render-nitro-hub-env passes when only MORPHEUS_RUNTIME_TOKEN is provided', () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-nitro-hub-env-runtime-token-'));
  const deployDir = path.join(workDir, 'deploy/nitro');
  const outputPath = path.join(deployDir, 'morpheus.hub.env');
  const shared = {
    MORPHEUS_NITRO_WORKER_IMAGE: 'worker:test',
    MORPHEUS_RELAYER_IMAGE: 'relayer:test',
    SUPABASE_URL: 'https://supabase.example',
    SUPABASE_SECRET_KEY: 'supabase-secret',
  };

  writeEnvFile(path.join(deployDir, 'morpheus.mainnet.env'), {
    ...shared,
    MORPHEUS_RUNTIME_CONFIG_JSON: JSON.stringify({ MORPHEUS_NETWORK: 'mainnet' }),
  });
  writeEnvFile(path.join(deployDir, 'morpheus.testnet.env'), {
    ...shared,
    MORPHEUS_RUNTIME_CONFIG_JSON: JSON.stringify({ MORPHEUS_NETWORK: 'testnet' }),
  });

  const result = spawnSync(
    process.execPath,
    [path.join(repoRoot, 'scripts/render-nitro-hub-env.mjs'), '--output', outputPath],
    {
      cwd: workDir,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, MORPHEUS_RUNTIME_TOKEN: 'runtime-token-only' },
    }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const rendered = parseEnv(fs.readFileSync(outputPath, 'utf8'));

  assert.equal(rendered.MORPHEUS_RUNTIME_TOKEN, 'runtime-token-only');
  assert.equal(rendered.NITRO_API_TOKEN, 'runtime-token-only');
});
