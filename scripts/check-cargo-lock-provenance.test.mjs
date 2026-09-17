import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  auditCargoLockProvenance,
  parseLockPackageVersions,
} from './check-cargo-lock-provenance.mjs';

test('repository lock keeps the retired graph out', () => {
  assert.deepEqual(auditCargoLockProvenance(), []);
});

test('retired package names are detected in a lock excerpt', () => {
  const versions = parseLockPackageVersions(`
[[package]]
name = "morpheus-relayer-rs"
version = "0.1.0"
`);
  assert.deepEqual(versions.get('morpheus-relayer-rs'), ['0.1.0']);
});

test('reintroducing a retired package fails the audit', () => {
  const root = mkdtempSync(join(tmpdir(), 'lock-provenance-'));
  mkdirSync(join(root, 'scripts', 'fixtures'), { recursive: true });
  writeFileSync(
    join(root, 'scripts', 'fixtures', 'cargo-lock-provenance.json'),
    JSON.stringify({
      retiredLockPackages: ['morpheus-relayer-rs'],
      leftoverUpgrades: [],
    })
  );
  writeFileSync(
    join(root, 'Cargo.lock'),
    '[[package]]\nname = "morpheus-relayer-rs"\nversion = "0.1.0"\n'
  );
  const problems = auditCargoLockProvenance(root);
  assert.ok(problems.some((problem) => problem.includes('morpheus-relayer-rs')));
});
