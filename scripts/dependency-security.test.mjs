import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const semver = require(path.join(root, 'node_modules', 'semver'));
const neoSwap = path.join(root, 'services', 'neoswap');
const manifest = JSON.parse(fs.readFileSync(path.join(neoSwap, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(neoSwap, 'package-lock.json'), 'utf8'));
const rootManifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
const apiGatewayRedis = fs.readFileSync(
  path.join(neoSwap, 'api-gateway', 'src', 'lib', 'redis.ts'),
  'utf8'
);
const apiGatewayRateLimit = fs.readFileSync(
  path.join(neoSwap, 'api-gateway', 'src', 'middleware', 'rate-limit.ts'),
  'utf8'
);
const priceFeedServer = fs.readFileSync(
  path.join(neoSwap, 'price-feed', 'src', 'server.ts'),
  'utf8'
);

function major(version) {
  const match = String(version).match(/^(?:\^|~|>=|=)?(\d+)/);
  return match ? Number(match[1]) : NaN;
}

function atLeast(version, expectedMajor, expectedMinor = 0) {
  const match = String(version).match(/(?:\^|~|>=|=)?(\d+)\.(\d+)/);
  if (!match) return false;
  const actualMajor = Number(match[1]);
  const actualMinor = Number(match[2]);
  return (
    actualMajor > expectedMajor || (actualMajor === expectedMajor && actualMinor >= expectedMinor)
  );
}

function versionAtLeast(version, expectedMajor, expectedMinor, expectedPatch = 0) {
  const match = String(version).match(/(?:\^|~|>=|=)?(\d+)\.(\d+)\.(\d+)/);
  if (!match) return false;
  const actual = [Number(match[1]), Number(match[2]), Number(match[3])];
  const expected = [expectedMajor, expectedMinor, expectedPatch];
  return (
    actual[0] > expected[0] ||
    (actual[0] === expected[0] &&
      (actual[1] > expected[1] || (actual[1] === expected[1] && actual[2] >= expected[2])))
  );
}

function lockVersions(name) {
  return Object.entries(lock.packages ?? {})
    .filter(([key]) => key === `node_modules/${name}` || key.endsWith(`/node_modules/${name}`))
    .map(([key, value]) => ({ key, version: value.version }));
}

function workspaceManifest(name) {
  return JSON.parse(fs.readFileSync(path.join(neoSwap, name, 'package.json'), 'utf8'));
}

function lockPackageForWorkspace(workspace, name) {
  const candidates = [`${workspace}/node_modules/${name}`, `node_modules/${name}`];
  for (const key of candidates) {
    if (lock.packages?.[key]) return { key, package: lock.packages[key] };
  }
  return null;
}

function packageNameFromLockKey(key) {
  const marker = '/node_modules/';
  const markerIndex = key.lastIndexOf(marker);
  const packagePath =
    markerIndex >= 0
      ? key.slice(markerIndex + marker.length)
      : key.startsWith('node_modules/')
        ? key.slice('node_modules/'.length)
        : '';
  if (!packagePath) return null;
  const parts = packagePath.split('/');
  return parts[0].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function resolveLockDependency(fromKey, dependencyName) {
  let current = fromKey;
  while (true) {
    const candidate = current
      ? `${current}/node_modules/${dependencyName}`
      : `node_modules/${dependencyName}`;
    if (lock.packages?.[candidate]) return candidate;
    const markerIndex = current.lastIndexOf('/node_modules/');
    if (markerIndex < 0) break;
    current = current.slice(0, markerIndex);
  }
  return lock.packages?.[`node_modules/${dependencyName}`]
    ? `node_modules/${dependencyName}`
    : null;
}

function isExternalDependencySpec(spec) {
  return /^(?:file:|git|https?:|link:|npm:|workspace:)/.test(String(spec));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('NeoSwap lockfile pins every package to registry bytes', () => {
  for (const [key, value] of Object.entries(lock.packages ?? {})) {
    if (
      !(key.startsWith('node_modules/') || key.includes('/node_modules/')) ||
      !value.version ||
      value.link
    )
      continue;
    assert.match(
      value.resolved ?? '',
      /^https:\/\/registry\.npmjs\.org\//,
      `${key} is missing a registry URL`
    );
    const integrity = (value.integrity ?? '').match(/^sha512-([A-Za-z0-9+/]+={0,2})$/);
    assert.ok(integrity, `${key} is missing a valid SHA-512 integrity pin`);
    assert.equal(
      Buffer.from(integrity[1], 'base64').byteLength,
      64,
      `${key} has an invalid SHA-512 integrity digest`
    );
    const packageName = packageNameFromLockKey(key);
    const tarballName = packageName?.split('/').at(-1);
    assert.ok(packageName && tarballName, `${key} has no package name in its lock path`);
    assert.equal(
      new URL(value.resolved).pathname.endsWith(`/-/${tarballName}-${value.version}.tgz`),
      true,
      `${key} resolved tarball is not bound to ${packageName}@${value.version}`
    );
  }

  const edgeCounts = {
    dependencies: 0,
    optionalDependencies: 0,
    peerDependencies: 0,
    externalDependencies: 0,
    optionalPeerDependenciesMissing: 0,
  };
  for (const [key, value] of Object.entries(lock.packages ?? {})) {
    for (const dependencyGroup of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const [dependencyName, spec] of Object.entries(value[dependencyGroup] ?? {})) {
        if (isExternalDependencySpec(spec)) {
          edgeCounts.externalDependencies += 1;
          continue;
        }
        edgeCounts[dependencyGroup] += 1;
        const targetKey = resolveLockDependency(key, dependencyName);
        if (!targetKey) {
          if (dependencyGroup === 'optionalDependencies') continue;
          if (
            dependencyGroup === 'peerDependencies' &&
            value.peerDependenciesMeta?.[dependencyName]?.optional
          ) {
            edgeCounts.optionalPeerDependenciesMissing += 1;
            continue;
          }
          assert.fail(`${key} is missing locked dependency ${dependencyName}@${spec}`);
        }
        const target = lock.packages[targetKey];
        assert.ok(target?.version, `${targetKey} has no locked version`);
        assert.ok(
          semver.satisfies(target.version, spec, { includePrerelease: true }),
          `${key} resolves ${dependencyName}@${target.version}, outside ${spec}`
        );
      }
    }
  }
  assert.deepEqual(edgeCounts, {
    dependencies: 638,
    optionalDependencies: 99,
    peerDependencies: 51,
    externalDependencies: 1,
    optionalPeerDependenciesMissing: 25,
  });
});

test('services dependency security policy pins patched runtime and build packages', () => {
  assert.equal(
    rootManifest.packageManager,
    'npm@10.9.2',
    'the lockfile must be generated by the pinned npm version'
  );
  assert.ok(
    major(manifest.devDependencies?.vitest) >= 4,
    'all NeoSwap test workspaces must use patched Vitest 4+'
  );
  assert.ok(
    major(manifest.devDependencies?.['@vitest/coverage-v8']) >= 4,
    'coverage must use patched Vitest 4+'
  );

  const workspaceFiles = fs
    .readdirSync(neoSwap, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() && fs.existsSync(path.join(neoSwap, entry.name, 'package.json'))
    )
    .map((entry) => path.join(neoSwap, entry.name, 'package.json'));
  for (const file of workspaceFiles) {
    const packageJson = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (packageJson.devDependencies?.vitest) {
      assert.ok(
        major(packageJson.devDependencies.vitest) >= 4,
        `${path.relative(root, file)} must use patched Vitest 4+`
      );
    }
  }

  assert.equal(manifest.overrides?.next, '^16.3.6', 'Next.js must use the patched 16.3.6 line');
  assert.ok(
    major(manifest.overrides?.tar) >= 7,
    'tar must be globally overridden to the patched 7.x line'
  );
  assert.ok(
    atLeast(manifest.overrides?.['wasm-pack'], 0, 15),
    'wasm-pack must be patched to 0.15+'
  );
  for (const { key, version } of lockVersions('vitest'))
    assert.ok(major(version) >= 4, `${key} has vulnerable Vitest ${version}`);
  for (const { key, version } of lockVersions('vite'))
    assert.ok(versionAtLeast(version, 6, 4, 3), `${key} has vulnerable Vite ${version}`);
  for (const { key, version } of lockVersions('vite-node'))
    assert.ok(major(version) >= 3, `${key} has vulnerable vite-node ${version}`);
  for (const { key, version } of lockVersions('next'))
    assert.ok(versionAtLeast(version, 16, 3, 6), `${key} has vulnerable Next.js ${version}`);
  for (const { key, version } of lockVersions('postcss'))
    assert.ok(versionAtLeast(version, 8, 5, 18), `${key} has vulnerable postcss ${version}`);
  for (const { key, version } of lockVersions('tar'))
    assert.ok(versionAtLeast(version, 7, 5, 21), `${key} has vulnerable tar ${version}`);
  for (const { key, version } of lockVersions('vitest'))
    assert.ok(versionAtLeast(version, 3, 2, 6), `${key} has vulnerable Vitest ${version}`);
  for (const { key, version } of lockVersions('wasm-pack'))
    assert.ok(atLeast(version, 0, 15), `${key} has vulnerable wasm-pack ${version}`);
  for (const { key, version } of lockVersions('uuid'))
    assert.ok(versionAtLeast(version, 11, 1, 1), `${key} has vulnerable uuid ${version}`);
  for (const { key, version } of lockVersions('csv-parse'))
    assert.ok(versionAtLeast(version, 7, 0, 3), `${key} has vulnerable csv-parse ${version}`);
  assert.equal(
    lockVersions('binary-install').length,
    0,
    'the vulnerable binary-install chain must not return'
  );
  assert.equal(
    lockVersions('axios').length,
    0,
    'the vulnerable binary-install axios chain must not return'
  );

  const analytics = workspaceManifest('analytics-api');
  const orderMatcher = workspaceManifest('order-matcher');
  const routingEngine = workspaceManifest('routing-engine');
  const apiGateway = workspaceManifest('api-gateway');
  assert.equal(analytics.dependencies?.['csv-parse'], '^7.0.3');
  assert.equal(orderMatcher.dependencies?.uuid, '^11.1.1');
  assert.equal(routingEngine.dependencies?.uuid, '^11.1.1');
  assert.equal(orderMatcher.devDependencies?.['wasm-pack'], '^0.15.0');
  assert.equal(apiGateway.devDependencies?.next, '^16.3.6');
  assert.equal(apiGateway.devDependencies?.['@types/react'], '^19.0.0');
  assert.equal(apiGateway.devDependencies?.['@types/react-dom'], '^19.0.0');
  assert.equal(apiGateway.dependencies?.['@neoswap/routing-engine'], 'file:../routing-engine');

  for (const [workspace, name] of [
    ['analytics-api', 'csv-parse'],
    ['order-matcher', 'uuid'],
    ['routing-engine', 'uuid'],
    ['order-matcher', 'wasm-pack'],
    ['api-gateway', 'next'],
    ['api-gateway', '@types/react'],
    ['api-gateway', '@types/react-dom'],
  ]) {
    const resolved = lockPackageForWorkspace(workspace, name);
    assert.ok(resolved, `lockfile must contain ${workspace}/${name}`);
    assert.ok(resolved.package.version, `lockfile must version ${workspace}/${name}`);
  }
});

test('CI runs the NeoSwap security and production build gates', () => {
  assert.match(workflow, /neoswap:/, 'CI must have a dedicated NeoSwap job');
  const servicesFilterStart = workflow.indexOf('            services:\n');
  const servicesFilterEnd = workflow.indexOf('            evm:\n', servicesFilterStart);
  assert.ok(servicesFilterStart >= 0 && servicesFilterEnd > servicesFilterStart);
  const servicesFilter = workflow.slice(servicesFilterStart, servicesFilterEnd);
  for (const pathPattern of [
    'services/**',
    'package.json',
    'package-lock.json',
    'scripts/dependency-security.test.mjs',
    '.github/workflows/**',
  ]) {
    assert.match(
      servicesFilter,
      new RegExp(`- '${escapeRegExp(pathPattern)}'`),
      `${pathPattern} changes must select NeoSwap security coverage`
    );
  }
  assert.match(workflow, /node --test scripts\/dependency-security\.test\.mjs/);
  assert.match(workflow, /npm --prefix services\/neoswap run test:all/);
  assert.match(workflow, /npm --prefix services\/neoswap run build:all/);
  assert.match(workflow, /npm --prefix services\/neoswap run audit:security/);
});

test('API Gateway Redis users fail closed without an implicit localhost backend', () => {
  assert.match(apiGatewayRedis, /REDIS_URL/);
  assert.match(apiGatewayRedis, /required for API Gateway cache/);
  assert.match(apiGatewayRateLimit, /@\/lib\/redis/);
  assert.doesNotMatch(apiGatewayRedis, /localhost:6379/);
  assert.doesNotMatch(apiGatewayRateLimit, /localhost:6379/);
  assert.match(priceFeedServer, /REDIS_URL is required for Price Feed Server/);
  assert.match(priceFeedServer, /ensureRedisReady/);
  assert.match(priceFeedServer, /redisFailure/);
  assert.doesNotMatch(priceFeedServer, /localhost:6379/);
});
