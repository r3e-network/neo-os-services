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

test('render-nitro-hub-env propagates heartbeat URLs and verifier public keys without signer material', () => {
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
      MORPHEUS_ORACLE_VERIFIER_PUBLIC_KEY: 'mainnet-verifier-public-key',
      // Leftover signing material in the packed runtime config must NOT leak
      // into the hub env: signing is custody-side (docs/SIGNER_SERVICE.md §5).
      MORPHEUS_WORKER_NEO_N3_WIF: 'mainnet-feed-wif',
      MORPHEUS_RELAYER_NEO_N3_PRIVATE_KEY: 'mainnet-request-private-key',
      MORPHEUS_UPDATER_NEO_N3_WIF: 'mainnet-updater-wif',
    }),
  });
  writeEnvFile(path.join(deployDir, 'morpheus.testnet.env'), {
    ...shared,
    MORPHEUS_RUNTIME_CONFIG_JSON: JSON.stringify({
      MORPHEUS_NETWORK: 'testnet',
      MORPHEUS_ORACLE_VERIFIER_PUBLIC_KEY: 'testnet-verifier-public-key',
      MORPHEUS_WORKER_NEO_N3_WIF: 'testnet-feed-wif',
      MORPHEUS_RELAYER_NEO_N3_PRIVATE_KEY: 'testnet-request-private-key',
      MORPHEUS_UPDATER_NEO_N3_WIF: 'testnet-updater-wif',
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
  // NTFS does not carry POSIX permission bits: writeFileSync's mode option is
  // ignored and stat reports 0o666. The renderer does request 0o600, and that
  // request matters on the Linux hosts these env files ship to, but only a POSIX
  // filesystem can confirm it landed.
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(outputPath).mode & 0o777, 0o600, 'rendered env must be owner-only');
  }
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
  assert.equal(rendered.MORPHEUS_ORACLE_VERIFIER_PUBLIC_KEY_MAINNET, 'mainnet-verifier-public-key');
  assert.equal(rendered.MORPHEUS_ORACLE_VERIFIER_PUBLIC_KEY_TESTNET, 'testnet-verifier-public-key');
  for (const key of Object.keys(rendered)) {
    assert.equal(
      /WIF|PRIVATE_KEY/.test(key),
      false,
      `hub env must not carry signing key material: ${key}`
    );
  }
  // The *_RUNTIME_CONFIG_JSON lines are verbatim passthroughs of the rendered
  // per-network env files, which are already WIF-free by their own tests. Every
  // other rendered value must embed no signing material.
  for (const [key, value] of Object.entries(rendered)) {
    if (key.endsWith('_RUNTIME_CONFIG_JSON')) continue;
    assert.equal(
      /wif|private-key/.test(value),
      false,
      `hub env value must not embed signing key material: ${key}`
    );
  }
});

test('render-nitro-hub-env lets secure local verifier public key override packed runtime gaps', () => {
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
    MORPHEUS_ORACLE_VERIFIER_PUBLIC_KEY_MAINNET: 'local-mainnet-verifier-public-key',
  });
  writeEnvFile(path.join(deployDir, 'morpheus.mainnet.env'), {
    ...shared,
    MORPHEUS_RUNTIME_CONFIG_JSON: JSON.stringify({
      MORPHEUS_NETWORK: 'mainnet',
      MORPHEUS_ORACLE_VERIFIER_PUBLIC_KEY: '',
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

  assert.equal(
    rendered.MORPHEUS_ORACLE_VERIFIER_PUBLIC_KEY_MAINNET,
    'local-mainnet-verifier-public-key'
  );
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

  // The verifier public key still promotes per network (public, safe).
  assert.equal(rendered.MORPHEUS_ORACLE_VERIFIER_PUBLIC_KEY_MAINNET, 'mainnet-verifier-public-key');
  assert.equal(rendered.MORPHEUS_ORACLE_VERIFIER_PUBLIC_KEY_TESTNET, 'testnet-verifier-public-key');
  // Signing material is not rendered at all — scoped or otherwise.
  for (const key of Object.keys(rendered)) {
    assert.equal(/WIF|PRIVATE_KEY/.test(key), false, `hub env must not carry key material: ${key}`);
  }
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
