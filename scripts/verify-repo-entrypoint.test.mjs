import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');

const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
const readJson = (relativePath) => JSON.parse(read(relativePath));

test('root package exposes the repo verification command', () => {
  const pkg = readJson('package.json');

  assert.equal(pkg.scripts?.['verify:repo'], 'bash scripts/verify_repo.sh');
});

test('repo verification script runs the canonical local validation stack', () => {
  const script = read(path.join('scripts', 'verify_repo.sh'));

  assert.match(script, /check:audit:root/);
  assert.match(script, /check:rust-migration/);
  assert.match(script, /check:production-topology/);
  assert.match(script, /format:rust:check/);
  assert.match(script, /check:rust/);
  assert.match(script, /test:rust/);
  assert.match(script, /test:scripts/);
  assert.match(script, /test:game-engine-sync/);
  assert.match(script, /test:control-plane/);
  assert.match(script, /test:worker/);
  assert.match(script, /test:relayer/);
  assert.match(script, /check:relayer:compat/);
  assert.match(script, /test:relayer:compat/);
  assert.match(script, /check:brand/);
  assert.match(script, /build:web/);
  assert.match(script, /lint -- --max-warnings=0/);
  assert.match(script, /command -v pgrep/);
});

test('full testnet wrapper guards empty live args under bash nounset', () => {
  const script = read(path.join('scripts', 'run_full_testnet_validation.sh'));

  assert.match(script, /\$\{#live_args\[@\]\} -gt 0/);
  assert.match(script, /run_live_testnet_validation\.sh"\s*$/m);
});

test('README documents the repo verification entrypoint', () => {
  const readme = read('README.md');

  assert.match(readme, /verify:repo/);
  assert.match(readme, /local verification entrypoint/i);
});
