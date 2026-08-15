import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CANONICAL_CODE_ROOT,
  LEGACY_CODE_ROOTS,
  installCompatibilityLinks,
  parseArgs,
} from './ops/install-code-path-compat.mjs';

function physicalPath(rootPrefix, logicalPath) {
  return path.join(rootPrefix, logicalPath.replace(/^\/+/, ''));
}

function makeRoot() {
  const rootPrefix = fs.mkdtempSync(path.join(os.tmpdir(), 'neoos-code-path-'));
  const canonicalPath = physicalPath(rootPrefix, CANONICAL_CODE_ROOT);
  fs.mkdirSync(canonicalPath, { recursive: true });
  fs.writeFileSync(
    path.join(canonicalPath, 'package.json'),
    JSON.stringify({ name: '@r3e-network/neo-os-services' })
  );
  return { rootPrefix, canonicalPath };
}

test('compatibility installer is dry-run by default and idempotent when applied', (t) => {
  const { rootPrefix, canonicalPath } = makeRoot();
  t.after(() => fs.rmSync(rootPrefix, { force: true, recursive: true }));

  const dryRun = installCompatibilityLinks({ rootPrefix });
  assert.deepEqual(
    dryRun.results.map((result) => result.status),
    ['would-link', 'would-link']
  );
  for (const legacyRoot of LEGACY_CODE_ROOTS) {
    assert.equal(fs.existsSync(physicalPath(rootPrefix, legacyRoot)), false);
  }

  const applied = installCompatibilityLinks({ apply: true, rootPrefix });
  assert.deepEqual(
    applied.results.map((result) => result.status),
    ['linked', 'linked']
  );
  for (const legacyRoot of LEGACY_CODE_ROOTS) {
    const link = physicalPath(rootPrefix, legacyRoot);
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
    assert.equal(path.resolve(path.dirname(link), fs.readlinkSync(link)), canonicalPath);
  }

  const repeated = installCompatibilityLinks({ apply: true, rootPrefix });
  assert.deepEqual(
    repeated.results.map((result) => result.status),
    ['already-linked', 'already-linked']
  );
});

test('compatibility installer refuses to overwrite a legacy checkout', (t) => {
  const { rootPrefix } = makeRoot();
  t.after(() => fs.rmSync(rootPrefix, { force: true, recursive: true }));
  fs.mkdirSync(physicalPath(rootPrefix, LEGACY_CODE_ROOTS[0]), { recursive: true });

  assert.throws(
    () => installCompatibilityLinks({ apply: true, rootPrefix }),
    /refusing to overwrite existing non-symlink path/
  );
});

test('compatibility installer validates the canonical checkout identity', (t) => {
  const { rootPrefix, canonicalPath } = makeRoot();
  t.after(() => fs.rmSync(rootPrefix, { force: true, recursive: true }));
  fs.writeFileSync(
    path.join(canonicalPath, 'package.json'),
    JSON.stringify({ name: 'wrong-repo' })
  );

  assert.throws(() => installCompatibilityLinks({ rootPrefix }), /refusing unexpected checkout/);
});

test('compatibility installer parses explicit apply and test-root arguments', () => {
  assert.deepEqual(parseArgs(['--apply', '--root-prefix', '/tmp/example']), {
    apply: true,
    rootPrefix: '/tmp/example',
  });
  assert.throws(() => parseArgs(['--root-prefix']), /requires a directory/);
  assert.throws(() => parseArgs(['--unknown']), /unknown argument/);
});
