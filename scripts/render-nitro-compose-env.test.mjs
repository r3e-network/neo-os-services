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

function buildTestSignerEnv() {
  const account = new wallet.Account(wallet.generatePrivateKey());
  const wifKeys = [
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
  const privateKeyKeys = [
    'MORPHEUS_WORKER_NEO_N3_PRIVATE_KEY',
    'MORPHEUS_WORKER_NEO_N3_PRIVATE_KEY_MAINNET',
    'MORPHEUS_RELAYER_NEO_N3_PRIVATE_KEY',
    'MORPHEUS_RELAYER_NEO_N3_PRIVATE_KEY_MAINNET',
    'MORPHEUS_UPDATER_NEO_N3_PRIVATE_KEY',
    'MORPHEUS_UPDATER_NEO_N3_PRIVATE_KEY_MAINNET',
    'MORPHEUS_ORACLE_VERIFIER_PRIVATE_KEY',
    'MORPHEUS_ORACLE_VERIFIER_PRIVATE_KEY_MAINNET',
  ];

  return Object.fromEntries([
    ['MORPHEUS_ALLOW_UNPINNED_SIGNERS', 'true'],
    ...wifKeys.map((key) => [key, account.WIF]),
    ...privateKeyKeys.map((key) => [key, account.privateKey]),
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
      env: { ...process.env, ...buildTestSignerEnv() },
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

  assert.ok(
    Object.prototype.hasOwnProperty.call(runtimeConfig, 'MORPHEUS_UPDATER_NEO_N3_WIF'),
    'runtime config must expose the updater WIF to the relayer'
  );
  assert.ok(
    Object.prototype.hasOwnProperty.call(runtimeConfig, 'MORPHEUS_UPDATER_NEO_N3_PRIVATE_KEY'),
    'runtime config must expose the updater private key to the relayer'
  );
  assert.ok(
    Object.prototype.hasOwnProperty.call(runtimeConfig, 'MORPHEUS_UPDATER_NEO_N3_WIF_MAINNET'),
    'runtime config must expose the network-scoped updater WIF to the relayer primary signer path'
  );
  assert.ok(
    Object.prototype.hasOwnProperty.call(
      runtimeConfig,
      'MORPHEUS_UPDATER_NEO_N3_PRIVATE_KEY_MAINNET'
    ),
    'runtime config must expose the network-scoped updater private key to the relayer primary signer path'
  );

  const lineValue = (key) => {
    const linePrefix = `${key}=`;
    const match = rendered.split(/\r?\n/).find((line) => line.startsWith(linePrefix));
    return match ? match.slice(linePrefix.length) : undefined;
  };

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

  const signerEnv = { ...runtimeConfig, MORPHEUS_ALLOW_UNPINNED_SIGNERS: 'true' };
  for (const role of ['worker', 'oracle_verifier']) {
    const report = resolvePinnedNeoN3Role('mainnet', role, { env: signerEnv });
    assert.equal(
      report.ok,
      true,
      `${role} signer must resolve from rendered runtime config: ${report.issues.join('; ')}`
    );
    assert.ok(
      report.materialized && (report.materialized.wif || report.materialized.private_key),
      `${role} signer must materialize key material from rendered runtime config`
    );
  }
});
