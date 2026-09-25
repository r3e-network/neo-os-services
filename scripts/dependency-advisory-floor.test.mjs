import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
}

function compareVersion(left, right) {
  const a = left.replace(/^v/, '').split('.').map(Number);
  const b = right.replace(/^v/, '').split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

function assertLockFloors(relativePath, floors) {
  const lock = readJson(relativePath);
  for (const [packagePath, floor] of Object.entries(floors)) {
    const actual = lock.packages?.[packagePath]?.version;
    assert.ok(actual, `${relativePath}: ${packagePath} must be present`);
    assert.ok(
      compareVersion(actual, floor) >= 0,
      `${relativePath}: ${packagePath} ${actual} is below ${floor}`
    );
  }
}

function assertOptionalLockFloors(relativePath, floors) {
  const lock = readJson(relativePath);
  for (const [packagePath, floor] of Object.entries(floors)) {
    const actual = lock.packages?.[packagePath]?.version;
    if (!actual) continue;
    assert.ok(
      compareVersion(actual, floor) >= 0,
      `${relativePath}: ${packagePath} ${actual} is below ${floor}`
    );
  }
}

test('all affected lockfiles retain patched dependency floors', () => {
  assertLockFloors('package-lock.json', {
    'node_modules/next': '15.5.24',
    'node_modules/postcss': '8.5.18',
    'node_modules/vite': '6.4.3',
  });
  assertLockFloors('apps/web/package-lock.json', {
    'node_modules/next': '15.5.24',
    'node_modules/js-yaml': '3.15.2',
    'node_modules/browserslist': '4.28.7',
    'node_modules/sharp': '0.35.4',
  });
  assertOptionalLockFloors('apps/web/package-lock.json', {
    'node_modules/fast-uri': '3.1.6',
  });
  assertLockFloors('services/neoswap/package-lock.json', {
    'node_modules/next': '15.5.24',
    'node_modules/tar': '7.5.21',
    'node_modules/vite': '6.4.3',
    'node_modules/vitest': '4.1.11',
  });
  assertOptionalLockFloors('services/neoswap/package-lock.json', {
    'node_modules/axios': '1.20.0',
  });
});

test('direct dependency ranges cannot reintroduce the affected advisories', () => {
  const app = readJson('apps/web/package.json');
  assert.equal(app.dependencies?.next, '^15.5.26');
  assert.equal(app.devDependencies?.vitest, '^4.1.11');

  const gateway = readJson('services/neoswap/api-gateway/package.json');
  assert.equal(gateway.devDependencies?.next, '^15.5.26');

  const neoswap = readJson('services/neoswap/package.json');
  assert.equal(neoswap.devDependencies?.vitest, '^4.1.11');
  assert.equal(neoswap.devDependencies?.['@vitest/coverage-v8'], '^4.1.11');

  for (const service of [
    'routing-engine',
    'price-feed',
    'order-matcher',
    'oracle-aggregator',
    'analytics-api',
  ]) {
    const pkg = readJson(`services/neoswap/${service}/package.json`);
    assert.equal(
      pkg.devDependencies?.vitest,
      '^4.1.11',
      `${service} must use the patched Vitest floor`
    );
  }
});
