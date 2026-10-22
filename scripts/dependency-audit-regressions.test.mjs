import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');

const readJson = (relativePath) =>
  JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), 'utf8'));

const versionAtLeast = (actual, expected) => {
  const parse = (value) =>
    String(value)
      .split(/[.-]/)
      .slice(0, 3)
      .map((part) => Number.parseInt(part, 10) || 0);

  const actualParts = parse(actual);
  const expectedParts = parse(expected);

  for (let index = 0; index < expectedParts.length; index += 1) {
    if ((actualParts[index] ?? 0) > expectedParts[index]) return true;
    if ((actualParts[index] ?? 0) < expectedParts[index]) return false;
  }

  return true;
};

test('workspace manifests pin the safe frontend dependency floors', () => {
  const rootPkg = readJson('package.json');
  const webPkg = readJson(path.join('apps', 'web', 'package.json'));

  assert.equal(rootPkg.overrides?.h3?.['.'], '1.15.9');
  assert.equal(rootPkg.overrides?.h3?.defu, '6.1.7');
  assert.equal(rootPkg.overrides?.anymatch?.picomatch, '2.3.2');
  assert.equal(rootPkg.overrides?.readdirp?.picomatch, '2.3.2');
  assert.equal(rootPkg.overrides?.tinyglobby?.picomatch, '4.0.4');
  assert.equal(rootPkg.overrides?.tinyglobby?.fdir?.picomatch, '4.0.4');
  // 4.1.12 fixes GHSA-qxg6-89mg-rqv8 and GHSA-xp26-3454-mjgp in @vitest/mocker.
  assert.equal(webPkg.devDependencies?.vitest, '^4.1.12');
});

test('package lock resolves patched vite, vitest, and installed picomatch versions', () => {
  const lock = readJson('package-lock.json');
  const packages = lock.packages ?? {};

  // npm may place the web-only runner in its workspace instead of hoisting it.
  const vitestRoot = packages['apps/web/node_modules/vitest']
    ? 'apps/web/node_modules'
    : 'node_modules';
  assert.ok(versionAtLeast(packages[`${vitestRoot}/vitest`]?.version, '4.1.12'));
  assert.ok(versionAtLeast(packages['node_modules/vite']?.version, '8.3.3'));
  assert.equal(packages['node_modules/tinyglobby/node_modules/picomatch']?.version, '4.0.4');
  // No override pins these two paths, so they only need the patched floor.
  assert.ok(versionAtLeast(packages['node_modules/vite/node_modules/picomatch']?.version, '4.0.4'));
  assert.ok(
    versionAtLeast(
      (
        packages[`${vitestRoot}/vitest/node_modules/picomatch`] ??
        packages[`${vitestRoot}/picomatch`] ??
        packages['node_modules/picomatch']
      )?.version,
      '4.0.4'
    )
  );
});
