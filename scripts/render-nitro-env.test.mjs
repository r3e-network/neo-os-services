import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = path.resolve(import.meta.dirname, '..');

function runRenderer(args) {
  return spawnSync(process.execPath, ['scripts/render-nitro-env.mjs', ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { PATH: process.env.PATH || '' },
  });
}

test('render-nitro-env defaults to pinned-only signer resolution', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'render-nitro-env-'));
  const source = path.join(directory, 'empty.env');
  fs.writeFileSync(source, '', 'utf8');

  const result = runRenderer([
    '--network',
    'mainnet',
    '--source',
    source,
    '--output-dir',
    directory,
    '--allow-missing',
  ]);
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const signerPath = path.join(directory, 'morpheus-nitro-signer.env');
  const rendered = fs.readFileSync(signerPath, 'utf8');
  const relayerPath = path.join(directory, 'neo-os-relayer.env');
  const relayer = fs.readFileSync(relayerPath, 'utf8');
  assert.match(rendered, /^MORPHEUS_ALLOW_UNPINNED_SIGNERS=false$/m);
  assert.match(rendered, /^MORPHEUS_UPDATER_NEO_N3_KMS_CIPHERTEXT_BASE64=$/m);
  assert.doesNotMatch(rendered, /_WIF(?:_|=)/);
  assert.doesNotMatch(rendered, /_PRIVATE_KEY(?:_|=)/);
  assert.match(relayer, /^NODE_ENV=production$/m);
  assert.match(relayer, /^MORPHEUS_ACTIVE_CHAINS=neo_n3$/m);
  assert.match(relayer, /^MORPHEUS_RELAYER_MODE=requests_only$/m);
  assert.match(relayer, /^MORPHEUS_AUTOMATION_ENABLED=false$/m);
  assert.match(relayer, /^MORPHEUS_FEED_SYNC_ENABLED=false$/m);
  assert.match(relayer, /^MORPHEUS_RELAYER_INSTANCE_ID=$/m);
  assert.match(relayer, /^MORPHEUS_RELAYER_ENCLAVE_FULFILL=true$/m);
  assert.match(relayer, /^MORPHEUS_RELAYER_ENCLAVE_FULFILL_URL=http:\/\/127\.0\.0\.1:8787$/m);
  assert.match(relayer, /^CONTRACT_MORPHEUS_DATAFEED_HASH_MAINNET=$/m);
  assert.match(relayer, /^CONTRACT_MORPHEUS_ORACLE_HASH_MAINNET=$/m);
  assert.match(relayer, /^NEO_RPC_URLS_MAINNET=$/m);
  assert.match(relayer, /^SIGNER_ROLE_NEOX_UPDATER_KEY_ID=$/m);
  assert.match(relayer, /^SIGNER_ROLE_NEOX_VERIFIER_KEY_ID=$/m);
  assert.match(relayer, /^MORPHEUS_RELAYER_NEOX_CHAIN_ID=47763$/m);
  assert.match(relayer, /^MORPHEUS_RELAYER_NEOX_ORACLE=$/m);
  assert.match(relayer, /^MORPHEUS_RELAYER_NEOX_FEED_GAS_LIMIT=2000000$/m);
  assert.doesNotMatch(relayer, /_WIF(?:_|=)|_PRIVATE_KEY(?:_|=)/);
  // NTFS carries no POSIX permission bits (writeFileSync's mode is ignored and
  // stat reports 0o666), so only a POSIX filesystem can confirm the renderer's
  // 0o600 request on signer material landed.
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(signerPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(relayerPath).mode & 0o777, 0o600);
  }
});

test('render-nitro-env binds the staged NeoX identity to the selected network', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'render-nitro-neox-chain-'));
  const source = path.join(directory, 'empty.env');
  fs.writeFileSync(source, '', 'utf8');

  const result = runRenderer([
    '--network',
    'testnet',
    '--source',
    source,
    '--output-dir',
    directory,
    '--allow-missing',
  ]);
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const relayer = fs.readFileSync(path.join(directory, 'neo-os-relayer.env'), 'utf8');
  assert.match(relayer, /^MORPHEUS_RELAYER_NEOX_CHAIN_ID=12227332$/m);
});

test('render-nitro-env preserves validated production chain and lane selection', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'render-nitro-lanes-'));
  const source = path.join(directory, 'lanes.env');
  fs.writeFileSync(
    source,
    [
      'MORPHEUS_ACTIVE_CHAINS=neo_n3,neox',
      'MORPHEUS_RELAYER_MODE=combined',
      'MORPHEUS_FEED_SYNC_ENABLED=true',
      'MORPHEUS_FEED_SYMBOLS=BTCUSD,NEOUSD',
      'MORPHEUS_AUTOMATION_ENABLED=true',
    ].join('\n'),
    'utf8'
  );

  const result = runRenderer([
    '--network',
    'mainnet',
    '--source',
    source,
    '--output-dir',
    directory,
    '--allow-missing',
  ]);
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const relayer = fs.readFileSync(path.join(directory, 'neo-os-relayer.env'), 'utf8');
  assert.match(relayer, /^MORPHEUS_ACTIVE_CHAINS=neo_n3,neox$/m);
  assert.match(relayer, /^MORPHEUS_RELAYER_MODE=combined$/m);
  assert.match(relayer, /^MORPHEUS_FEED_SYNC_ENABLED=true$/m);
  assert.match(relayer, /^MORPHEUS_FEED_SYMBOLS=BTCUSD,NEOUSD$/m);
  assert.match(relayer, /^MORPHEUS_AUTOMATION_ENABLED=false$/m);
  assert.match(relayer, /state\.mainnet\.combined\.json/);
});

test('render-nitro-env never copies plaintext signer material into provisioning output', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'render-nitro-plaintext-'));
  const source = path.join(directory, 'legacy.env');
  fs.writeFileSync(
    source,
    [
      'MORPHEUS_UPDATER_NEO_N3_WIF_MAINNET=plaintext-updater-secret',
      'MORPHEUS_ORACLE_VERIFIER_PRIVATE_KEY_MAINNET=plaintext-verifier-secret',
    ].join('\n'),
    'utf8'
  );

  const result = runRenderer([
    '--network',
    'mainnet',
    '--source',
    source,
    '--output-dir',
    directory,
    '--allow-missing',
  ]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const rendered = fs.readFileSync(path.join(directory, 'morpheus-nitro-signer.env'), 'utf8');
  assert.doesNotMatch(rendered, /plaintext-updater-secret|plaintext-verifier-secret/);
  assert.doesNotMatch(rendered, /_WIF(?:_|=)|_PRIVATE_KEY(?:_|=)/);
});

test('render-nitro-env rejects a missing runtime token by default', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'render-nitro-token-'));
  const source = path.join(directory, 'empty.env');
  fs.writeFileSync(source, '', 'utf8');

  const result = runRenderer([
    '--network',
    'mainnet',
    '--source',
    source,
    '--output-dir',
    directory,
  ]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /missing runtime authorization token/);
  assert.equal(fs.existsSync(path.join(directory, 'morpheus-nitro-signer.env')), false);
});

test('render-nitro-env rejects a plaintext runtime token without its KMS envelope', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'render-nitro-kms-token-'));
  const source = path.join(directory, 'runtime.env');
  fs.writeFileSync(source, 'MORPHEUS_RUNTIME_TOKEN=a-secure-runtime-token-value\n', 'utf8');

  const result = runRenderer([
    '--network',
    'mainnet',
    '--source',
    source,
    '--output-dir',
    directory,
  ]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /missing KMS-sealed runtime authorization token/);
  assert.equal(fs.existsSync(path.join(directory, 'morpheus-nitro-signer.env')), false);
});
