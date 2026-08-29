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
  assert.match(rendered, /^MORPHEUS_ALLOW_UNPINNED_SIGNERS=false$/m);
  assert.match(rendered, /^MORPHEUS_UPDATER_NEO_N3_KMS_CIPHERTEXT_BASE64=$/m);
  assert.doesNotMatch(rendered, /_WIF(?:_|=)/);
  assert.doesNotMatch(rendered, /_PRIVATE_KEY(?:_|=)/);
  // NTFS carries no POSIX permission bits (writeFileSync's mode is ignored and
  // stat reports 0o666), so only a POSIX filesystem can confirm the renderer's
  // 0o600 request on signer material landed.
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(signerPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(directory, 'morpheus-relayer.env')).mode & 0o777, 0o600);
  }
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
