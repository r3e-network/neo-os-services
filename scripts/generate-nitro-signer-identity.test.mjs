import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = path.resolve(import.meta.dirname, '..');

function spawnEnv(extra = {}) {
  return {
    PATH: process.env.PATH || '',
    HOME: process.env.HOME || '',
    ...extra,
  };
}

test('generated bootstrap signer identity declares itself bootstrap-only', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'morpheus-bootstrap-signer-'));
  const outputPath = path.join(outDir, 'bootstrap.env');

  const result = spawnSync(
    process.execPath,
    ['scripts/generate-nitro-signer-identity.mjs', '--network', 'testnet', '--output', outputPath],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: spawnEnv(),
    }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.bootstrap_only, true);
  assert.match(report.warning, /bootstrap-only/);
  assert.match(report.warning, /never runtime env/);

  const content = fs.readFileSync(outputPath, 'utf8');
  const lines = content.split('\n');
  assert.match(lines[0], /^# Bootstrap-only:/);
  assert.match(content, /^MORPHEUS_ALLOW_UNPINNED_SIGNERS=true$/m);
});

test('the generated bootstrap file is refused by the runtime env gate', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'morpheus-bootstrap-signer-'));
  const outputPath = path.join(outDir, 'bootstrap.env');

  const generated = spawnSync(
    process.execPath,
    ['scripts/generate-nitro-signer-identity.mjs', '--network', 'testnet', '--output', outputPath],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: spawnEnv(),
    }
  );
  assert.equal(generated.status, 0, generated.stderr || generated.stdout);

  const checked = spawnSync(process.execPath, ['scripts/check-nitro-env.mjs'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: spawnEnv({ NITRO_ENV_FILE: outputPath }),
  });

  assert.equal(checked.status, 1, checked.stderr || checked.stdout);
  const report = JSON.parse(checked.stdout);
  assert.equal(report.ok, false);
  assert.equal(report.forbidden_settings[0].key, 'MORPHEUS_ALLOW_UNPINNED_SIGNERS');
});
