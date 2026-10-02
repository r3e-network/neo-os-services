import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = process.env.NEOOS_DEPENDENCY_AUDIT_ROOT
  ? path.resolve(process.env.NEOOS_DEPENDENCY_AUDIT_ROOT)
  : path.resolve(import.meta.dirname, '..');

const parseVersion = (value) =>
  String(value)
    .split(/[.-]/)
    .slice(0, 3)
    .map((part) => Number.parseInt(part, 10) || 0);

const atLeast = (actual, expected) => {
  const a = parseVersion(actual);
  const e = parseVersion(expected);
  for (let index = 0; index < e.length; index += 1) {
    if ((a[index] ?? 0) > e[index]) return true;
    if ((a[index] ?? 0) < e[index]) return false;
  }
  return true;
};

const assertBraceExpansionFloors = (lock, label) => {
  const braceEntries = Object.entries(lock.packages ?? {}).filter(
    ([key]) => key === 'node_modules/brace-expansion' || key.endsWith('/brace-expansion')
  );

  assert.ok(braceEntries.length > 0, `${label} must contain brace-expansion entries`);
  for (const [key, entry] of braceEntries) {
    const floor = String(entry.version).startsWith('1.') ? '1.1.21' : '5.0.12';
    assert.ok(
      atLeast(entry.version, floor),
      `${label} ${key} resolves ${entry.version}; expected at least ${floor}`
    );
  }
};

test('package lock keeps the resolved high severity dependency floors', () => {
  const rootPackage = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const webPackage = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'apps', 'web', 'package.json'), 'utf8')
  );
  const lock = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8'));
  const webLock = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'apps', 'web', 'package-lock.json'), 'utf8')
  );
  const packages = lock.packages ?? {};
  const webPackages = webLock.packages ?? {};

  assert.equal(rootPackage.overrides?.undici, '8.11.2');
  assert.equal(rootPackage.overrides?.['minimatch@3.1.5']?.['brace-expansion'], '1.1.21');
  assert.equal(rootPackage.overrides?.glob?.minimatch?.['brace-expansion'], '5.0.12');
  assert.equal(
    rootPackage.overrides?.['@typescript-eslint/typescript-estree']?.minimatch?.['brace-expansion'],
    '5.0.12'
  );
  assert.equal(webPackage.devDependencies?.['brace-expansion'], '5.0.12');
  assert.equal(webPackage.overrides?.['fast-uri'], '3.1.8');
  assert.equal(webPackage.overrides?.browserslist, '4.29.3');
  assert.equal(webPackage.overrides?.['baseline-browser-mapping'], '2.11.27');
  assert.equal(webPackage.overrides?.['minimatch@3.1.5']?.['brace-expansion'], '1.1.21');
  assert.equal(webPackage.overrides?.['minimatch@3.1.2']?.['brace-expansion'], '1.1.21');
  assertBraceExpansionFloors(lock, 'root package lock');
  assertBraceExpansionFloors(webLock, 'apps/web package lock');

  assert.ok(
    atLeast(packages['node_modules/undici']?.version, '8.11.2'),
    `node_modules/undici resolves ${packages['node_modules/undici']?.version}; expected at least 8.11.2`
  );
  assert.ok(
    atLeast(webPackages['node_modules/fast-uri']?.version, '3.1.8'),
    `apps/web fast-uri resolves ${webPackages['node_modules/fast-uri']?.version}; expected at least 3.1.8`
  );
  assert.ok(
    atLeast(webPackages['node_modules/browserslist']?.version, '4.29.3'),
    `apps/web browserslist resolves ${webPackages['node_modules/browserslist']?.version}; expected at least 4.29.3`
  );
  assert.ok(
    atLeast(webPackages['node_modules/baseline-browser-mapping']?.version, '2.11.27'),
    `apps/web baseline-browser-mapping resolves ${webPackages['node_modules/baseline-browser-mapping']?.version}; expected at least 2.11.27`
  );
  assert.ok(
    atLeast(webPackages['node_modules/next']?.version, '15.5.24'),
    `apps/web next resolves ${webPackages['node_modules/next']?.version}; expected at least 15.5.24`
  );
});
