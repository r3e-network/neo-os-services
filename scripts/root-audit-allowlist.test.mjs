import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');

const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
const readJson = (relativePath) => JSON.parse(read(relativePath));

test('root package exposes the audit allowlist checker command', () => {
  const pkg = readJson('package.json');

  assert.equal(pkg.scripts?.['check:audit:root'], 'node scripts/check-root-audit-allowlist.mjs');
});

test('root audit allowlist script documents only the excluded CityOfZion chain', () => {
  const source = read(path.join('scripts', 'check-root-audit-allowlist.mjs'));

  assert.match(source, /@cityofzion\/neon-js/);
  assert.match(source, /@cityofzion\/neon-core/);
  assert.match(source, /@cityofzion\/neon-api/);
  assert.match(source, /elliptic/);
  assert.match(source, /lodash/);
  assert.doesNotMatch(source, /@web3auth\/modal/);
});

test('README documents the root audit baseline and the dedicated checker', () => {
  const readme = read('README.md');

  assert.match(readme, /check:audit:root/);
  assert.match(readme, /excluded CityOfZion/i);
  assert.match(readme, /no additional production vulnerabilities/i);
});
