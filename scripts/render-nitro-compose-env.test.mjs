import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { wallet } from '@cityofzion/neon-js';
import { resolvePinnedNeoN3Role } from './lib-neo-signers.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');
const archivedEnvKeys = [
  'NEOX_RPC_URL',
  'NEOX_CHAIN_ID',
  'CONTRACT_MORPHEUS_ORACLE_X_ADDRESS',
  'CONTRACT_ORACLE_CALLBACK_CONSUMER_X_ADDRESS',
  'CONTRACT_MORPHEUS_DATAFEED_X_ADDRESS',
  'MORPHEUS_RELAYER_NEOX_PRIVATE_KEY',
  'MORPHEUS_RELAYER_NEO_X_START_BLOCK',
];

const signerMaterialWifKeys = [
  'NEO_TESTNET_WIF',
  'NEO_N3_WIF',
  'MORPHEUS_WORKER_NEO_N3_WIF',
  'MORPHEUS_WORKER_NEO_N3_WIF_MAINNET',
  'MORPHEUS_RELAYER_NEO_N3_WIF',
  'MORPHEUS_RELAYER_NEO_N3_WIF_MAINNET',
  'MORPHEUS_UPDATER_NEO_N3_WIF',
  'MORPHEUS_UPDATER_NEO_N3_WIF_MAINNET',
  'MORPHEUS_ORACLE_VERIFIER_WIF',
  'MORPHEUS_ORACLE_VERIFIER_WIF_MAINNET',
];
const signerMaterialPrivateKeyKeys = [
  'MORPHEUS_WORKER_NEO_N3_PRIVATE_KEY',
  'MORPHEUS_WORKER_NEO_N3_PRIVATE_KEY_MAINNET',
  'MORPHEUS_RELAYER_NEO_N3_PRIVATE_KEY',
  'MORPHEUS_RELAYER_NEO_N3_PRIVATE_KEY_MAINNET',
  'MORPHEUS_UPDATER_NEO_N3_PRIVATE_KEY',
  'MORPHEUS_UPDATER_NEO_N3_PRIVATE_KEY_MAINNET',
  'MORPHEUS_ORACLE_VERIFIER_PRIVATE_KEY',
  'MORPHEUS_ORACLE_VERIFIER_PRIVATE_KEY_MAINNET',
];
const signerMaterialKeys = [...signerMaterialWifKeys, ...signerMaterialPrivateKeyKeys];

function reviewedRegistryRoot(chainId) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'render-nitro-compose-registry-'));
  const networkDirectory = path.join(directory, 'config', 'networks');
  fs.mkdirSync(networkDirectory, { recursive: true });
  const registry = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'config', 'networks', 'mainnet.json'), 'utf8')
  );
  registry.neo_x.chain_id = chainId;
  fs.writeFileSync(
    path.join(networkDirectory, 'mainnet.json'),
    `${JSON.stringify(registry, null, 2)}\n`,
    'utf8'
  );
  return directory;
}

function buildTestSignerEnv() {
  const account = new wallet.Account(wallet.generatePrivateKey());

  return Object.fromEntries([
    ['MORPHEUS_ALLOW_UNPINNED_SIGNERS', 'true'],
    ...signerMaterialWifKeys.map((key) => [key, account.WIF]),
    ...signerMaterialPrivateKeyKeys.map((key) => [key, account.privateKey]),
  ]);
}

test('render-nitro-compose-env omits archived Neo X fields from generated output', () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-nitro-compose-env-'));
  const outputPath = path.join(outputDir, 'morpheus.mainnet.env');
  const result = spawnSync(
    process.execPath,
    ['scripts/render-nitro-compose-env.mjs', '--network', 'mainnet', '--output', outputPath],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        ...buildTestSignerEnv(),
        MORPHEUS_ALLOW_TRANSACTION_SPONSORSHIP: 'true',
        MORPHEUS_MAX_SPONSOR_FEE_GAS: '2.5',
      },
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

  const rendered = fs.readFileSync(outputPath, 'utf8');
  const renderedKeys = new Set(
    rendered
      .split(/\r?\n/)
      .filter((line) => line && !line.startsWith('#') && line.includes('='))
      .map((line) => line.slice(0, line.indexOf('=')))
  );

  for (const key of archivedEnvKeys) {
    assert.equal(renderedKeys.has(key), false, `unexpected archived key in rendered env: ${key}`);
  }

  const runtimeConfigLine = rendered
    .split(/\r?\n/)
    .find((line) => line.startsWith('MORPHEUS_RUNTIME_CONFIG_JSON='));
  assert.ok(runtimeConfigLine, 'missing MORPHEUS_RUNTIME_CONFIG_JSON line');

  const runtimeConfig = JSON.parse(runtimeConfigLine.slice('MORPHEUS_RUNTIME_CONFIG_JSON='.length));

  for (const key of archivedEnvKeys) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(runtimeConfig, key),
      false,
      `unexpected archived key in runtime config: ${key}`
    );
  }

  // Custody migration invariant: signer key material fed in through the root
  // env must never reach the runtime surface — not as rendered lines and not
  // inside MORPHEUS_RUNTIME_CONFIG_JSON. Signing is custody-side; the runtime
  // only ever sees the verifier PUBLIC key.
  for (const key of signerMaterialKeys) {
    assert.equal(
      renderedKeys.has(key),
      false,
      `rendered env must not carry signer key material: ${key}`
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(runtimeConfig, key),
      false,
      `runtime config must not carry signer key material: ${key}`
    );
  }

  const lineValue = (key) => {
    const linePrefix = `${key}=`;
    const match = rendered.split(/\r?\n/).find((line) => line.startsWith(linePrefix));
    return match ? match.slice(linePrefix.length) : undefined;
  };

  const verifierPublicKey = lineValue('MORPHEUS_ORACLE_VERIFIER_PUBLIC_KEY');
  assert.ok(verifierPublicKey, 'rendered env must expose the oracle verifier PUBLIC key');
  assert.match(verifierPublicKey, /^[0-9a-f]{66}$/);
  assert.equal(
    lineValue('MORPHEUS_RELAYER_NEOX_CHAIN_ID'),
    '47763',
    'staged NeoX configuration must retain the selected network chain identity'
  );
  assert.equal(lineValue('SIGNER_ROLE_NEOX_VERIFIER_KEY_ID'), '');
  assert.equal(lineValue('MORPHEUS_RELAYER_NEOX_FEED_GAS_LIMIT'), '2000000');
  assert.equal(lineValue('MORPHEUS_ALLOW_TRANSACTION_SPONSORSHIP'), 'true');
  assert.equal(lineValue('MORPHEUS_MAX_SPONSOR_FEE_GAS'), '2.5');
  assert.equal(runtimeConfig.MORPHEUS_ALLOW_TRANSACTION_SPONSORSHIP, 'true');
  assert.equal(runtimeConfig.MORPHEUS_MAX_SPONSOR_FEE_GAS, '2.5');

  assert.ok(renderedKeys.has('NITRO_USE_DERIVED_KEYS'), 'missing NITRO_USE_DERIVED_KEYS line');
  assert.equal(
    lineValue('NITRO_USE_DERIVED_KEYS'),
    'true',
    'NITRO_USE_DERIVED_KEYS defaults to true for mainnet when no explicit override is set'
  );
  assert.ok(
    Object.prototype.hasOwnProperty.call(runtimeConfig, 'NITRO_USE_DERIVED_KEYS'),
    'runtime config must expose NITRO_USE_DERIVED_KEYS'
  );

  // The rendered runtime config is the WIF-free healthy state, so the pinned
  // drift check must pass over it as-is: a missing key is allowed, and there is
  // nothing left to disagree with the registry.
  for (const role of ['worker', 'oracle_verifier']) {
    const report = resolvePinnedNeoN3Role('mainnet', role, {
      env: runtimeConfig,
      allowMissing: true,
    });
    assert.equal(
      report.ok,
      true,
      `${role} drift check must pass on the WIF-free runtime config: ${report.issues.join('; ')}`
    );
    assert.deepEqual(report.issues, []);
  }
});

test('render-nitro-compose-env reads NeoX chain identity from the reviewed registry', () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-nitro-compose-neox-'));
  const outputPath = path.join(outputDir, 'morpheus.mainnet.env');
  const registryRoot = reviewedRegistryRoot(47764);
  const result = spawnSync(
    process.execPath,
    [
      'scripts/render-nitro-compose-env.mjs',
      '--network',
      'mainnet',
      '--output',
      outputPath,
      '--registry-root',
      registryRoot,
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, ...buildTestSignerEnv() },
    }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const rendered = fs.readFileSync(outputPath, 'utf8');
  const line = rendered
    .split(/\r?\n/)
    .find((entry) => entry.startsWith('MORPHEUS_RELAYER_NEOX_CHAIN_ID='));
  assert.equal(line, 'MORPHEUS_RELAYER_NEOX_CHAIN_ID=47764');
  fs.rmSync(registryRoot, { recursive: true, force: true });
});

test('render-nitro-compose-env rejects a mismatched reviewed N3 magic override', () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-nitro-compose-n3-'));
  const outputPath = path.join(outputDir, 'morpheus.mainnet.env');
  const result = spawnSync(
    process.execPath,
    ['scripts/render-nitro-compose-env.mjs', '--network', 'mainnet', '--output', outputPath],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, ...buildTestSignerEnv(), NEO_NETWORK_MAGIC: '1' },
    }
  );

  assert.notEqual(result.status, 0, result.stderr || result.stdout);
  assert.match(`${result.stderr}${result.stdout}`, /Neo N3 magic|network magic/i);
});
