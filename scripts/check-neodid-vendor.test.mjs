// Drives each rule of scripts/check-neodid-vendor.mjs against a throwaway tree
// (and, for the sibling rules, a throwaway neo-os-did git repository), so a
// weakened rule fails here instead of silently passing the real pin.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { PIN_FILE, checkNeoDidVendor } from './check-neodid-vendor.mjs';

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

// One consumer file placed outside vendor/ and one data file under it.
const FILES = Object.freeze([
  {
    source: 'runtime/nitro-worker/src/neodid/index.js',
    dest: 'workers/nitro-worker/src/neodid/index.js',
    body: 'export const lane = 1;\n',
  },
  {
    source: 'docs/NEODID_DID_METHOD.md',
    dest: 'vendor/neo-os-did/docs/NEODID_DID_METHOD.md',
    body: '# did:morpheus\n',
  },
]);

function write(file, body) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
}

function git(cwd, ...args) {
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=pin-gate-test',
      '-c',
      'user.email=pin-gate-test@example.invalid',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'init.defaultBranch=main',
      ...args,
    ],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  ).trim();
}

function pinFor(commit, files = FILES) {
  return {
    schemaVersion: 2,
    repository: 'https://example.invalid/neo-os-did.git',
    commit,
    files: files.map(({ source, dest, body }) => ({ source, dest, sha256: sha256(body) })),
  };
}

function writePin(root, pin) {
  write(join(root, PIN_FILE), `${JSON.stringify(pin, null, 2)}\n`);
}

/**
 * services/ sits two levels below the temporary base, so the implicit
 * ../neo-os-did and ../../neo-os-did lookups can only find what a test creates.
 * `siblingBodies` commits a neo-os-did repository at ../neo-os-did whose files
 * hold those bodies (keyed by source) and pins its HEAD.
 */
function makeTree(t, { siblingBodies = null } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'neodid-pin-gate-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'workspace', 'services');
  const siblingPath = join(base, 'workspace', 'neo-os-did');
  let commit = 'a'.repeat(40);
  if (siblingBodies) {
    mkdirSync(siblingPath, { recursive: true });
    git(siblingPath, 'init', '-q');
    for (const entry of FILES) {
      write(join(siblingPath, entry.source), siblingBodies[entry.source] ?? entry.body);
    }
    git(siblingPath, 'add', '-A');
    git(siblingPath, 'commit', '-q', '--no-verify', '-m', 'fixture');
    commit = git(siblingPath, 'rev-parse', 'HEAD');
  }
  for (const entry of FILES) write(join(root, entry.dest), entry.body);
  writePin(root, pinFor(commit));
  return { base, root, siblingPath, commit };
}

function audit(root, env = {}) {
  return checkNeoDidVendor({ root, env });
}

test('passes a tree that matches its pin when no sibling checkout exists', (t) => {
  const { root, commit } = makeTree(t);
  const { problems, summary } = audit(root);
  assert.deepEqual(problems, []);
  assert.equal(summary.commit, commit);
  assert.equal(summary.files, FILES.length);
  assert.equal(summary.siblingChecked, false);
});

test('passes and compares sources when the sibling checkout is at the pin commit', (t) => {
  const { root, siblingPath } = makeTree(t, { siblingBodies: {} });
  const { problems, summary } = audit(root);
  assert.deepEqual(problems, []);
  assert.equal(summary.siblingChecked, true);
  assert.equal(summary.sibling, siblingPath);
});

test('reports drift when a pinned file no longer matches its sha256', (t) => {
  const { root } = makeTree(t);
  writeFileSync(join(root, FILES[0].dest), 'export const lane = 2;\n');
  const { problems } = audit(root);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /NeoDID pin drift: workers\/nitro-worker\/src\/neodid\/index\.js/);
});

test('reports a pinned destination that is missing', (t) => {
  const { root } = makeTree(t);
  unlinkSync(join(root, FILES[1].dest));
  const { problems } = audit(root);
  assert.deepEqual(problems, [
    'missing pinned NeoDID file: vendor/neo-os-did/docs/NEODID_DID_METHOD.md',
  ]);
});

test('reports a file under vendor/neo-os-did that the pin does not declare', (t) => {
  const { root } = makeTree(t);
  write(join(root, 'vendor/neo-os-did/runtime/nitro-worker/src/platform/core.js'), '// copy\n');
  const { problems } = audit(root);
  assert.equal(problems.length, 1);
  assert.match(
    problems[0],
    /orphan under vendor\/neo-os-did\/: vendor\/neo-os-did\/runtime\/nitro-worker\/src\/platform\/core\.js/
  );
});

test('reports a sibling checkout whose HEAD is not the pin commit', (t) => {
  const { root, siblingPath, commit } = makeTree(t, { siblingBodies: {} });
  write(join(siblingPath, 'CHANGELOG.md'), '# later\n');
  git(siblingPath, 'add', '-A');
  git(siblingPath, 'commit', '-q', '--no-verify', '-m', 'later');
  const { problems } = audit(root);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /NeoDID sibling drift: .* the pin names /);
  assert.ok(problems[0].endsWith(commit));
});

test('reports a source whose bytes at the pin commit differ from the pin', (t) => {
  const { root } = makeTree(t, {
    siblingBodies: { [FILES[0].source]: 'export const lane = 3;\n' },
  });
  const { problems } = audit(root);
  assert.equal(problems.length, 1);
  assert.match(
    problems[0],
    /NeoDID source\/pin mismatch: runtime\/nitro-worker\/src\/neodid\/index\.js at [0-9a-f]{40}/
  );
});

test('uses NEOOS_DID_CHECKOUT ahead of the implicit sibling lookup', (t) => {
  const { root, base } = makeTree(t, { siblingBodies: {} });
  const elsewhere = join(base, 'elsewhere', 'neo-os-did');
  mkdirSync(elsewhere, { recursive: true });
  git(elsewhere, 'init', '-q');
  write(join(elsewhere, 'README.md'), '# other\n');
  git(elsewhere, 'add', '-A');
  git(elsewhere, 'commit', '-q', '--no-verify', '-m', 'other');
  const { problems, summary } = audit(root, { NEOOS_DID_CHECKOUT: elsewhere });
  assert.equal(summary.sibling, elsewhere);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /NeoDID sibling drift/);
});

test('fails instead of skipping when NEOOS_DID_CHECKOUT is not a git checkout', (t) => {
  const { root, base } = makeTree(t);
  const missing = join(base, 'no-such-checkout');
  const { problems } = audit(root, { NEOOS_DID_CHECKOUT: missing });
  assert.deepEqual(problems, [`NEOOS_DID_CHECKOUT=${missing} is not a git checkout of neo-os-did`]);
});

test('rejects a pin that is not schema 2', (t) => {
  const { root, commit } = makeTree(t);
  const legacy = {
    schemaVersion: 1,
    repository: 'https://example.invalid/neo-os-did.git',
    commit,
    files: FILES.map(({ source, dest, body }) => ({ source, vendor: dest, sha256: sha256(body) })),
  };
  writePin(root, legacy);
  const { problems } = audit(root);
  assert.ok(problems.includes(`${PIN_FILE}: schemaVersion must be 2, got 1`));
  assert.ok(problems.some((problem) => /unknown property vendor/.test(problem)));
  assert.ok(
    problems.some((problem) => /dest must be a normalized repository-relative path/.test(problem))
  );
});

test('rejects escaping, absolute, duplicate and malformed entries', (t) => {
  const { root, commit } = makeTree(t);
  const pin = pinFor(commit);
  pin.commit = commit.slice(0, 12);
  pin.files.push({ ...pin.files[0] });
  pin.files.push({ source: '../outside.js', dest: 'apps/web/lib/x.ts', sha256: 'A'.repeat(64) });
  pin.files.push({ source: 'docs/a.md', dest: '/etc/passwd', sha256: sha256('x') });
  pin.files.push({ source: 'docs/b.md', dest: 'vendor/neo-os-did/./b.md', sha256: sha256('x') });
  writePin(root, pin);
  const { problems } = audit(root);
  assert.ok(problems.some((problem) => /commit must be a full 40-character/.test(problem)));
  assert.ok(
    problems.some((problem) => /files\[2\]: dest .* is declared more than once/.test(problem))
  );
  assert.ok(problems.some((problem) => /files\[3\]: source must be a normalized/.test(problem)));
  assert.ok(
    problems.some((problem) => /files\[3\]: sha256 must be 64 lowercase hex/.test(problem))
  );
  assert.ok(problems.some((problem) => /files\[4\]: dest must be a normalized/.test(problem)));
  assert.ok(problems.some((problem) => /files\[5\]: dest must be a normalized/.test(problem)));
});

test('refuses consumer code pinned under vendor/neo-os-did', (t) => {
  const { root, commit } = makeTree(t);
  const lane = {
    source: 'runtime/nitro-worker/src/neodid/index.js',
    dest: 'vendor/neo-os-did/runtime/nitro-worker/src/neodid/index.js',
    body: 'export const lane = 1;\n',
  };
  write(join(root, lane.dest), lane.body);
  writePin(root, pinFor(commit, [FILES[1], lane]));
  const { problems } = audit(root);
  assert.equal(problems.length, 1);
  assert.match(
    problems[0],
    /files\[1\]: vendor\/neo-os-did\/runtime\/nitro-worker\/src\/neodid\/index\.js is code; place it at its consumer path/
  );
});

test('refuses to pin a neo-os-did stand-in for a module or data file this repository owns', (t) => {
  const { root, commit } = makeTree(t);
  const standIns = [
    {
      source: 'runtime/nitro-worker/src/platform/custody.js',
      dest: 'workers/nitro-worker/src/platform/custody.js',
      body: '// custody\n',
    },
    {
      source: 'config/networks/testnet.json',
      dest: 'config/networks/testnet.json',
      body: '{}\n',
    },
    {
      source: 'crates/neo-os-did/src/core.rs',
      dest: 'crates/neo-os-compute/src/core.rs',
      body: '// core\n',
    },
  ];
  for (const entry of standIns) write(join(root, entry.dest), entry.body);
  writePin(root, pinFor(commit, [...FILES, ...standIns]));
  const { problems } = audit(root);
  assert.deepEqual(
    problems.map((problem) => problem.replace(/ is a neo-os-did stand-in.*$/, '')),
    [
      `${PIN_FILE}: files[2]: runtime/nitro-worker/src/platform/custody.js`,
      `${PIN_FILE}: files[3]: config/networks/testnet.json`,
      `${PIN_FILE}: files[4]: crates/neo-os-did/src/core.rs`,
    ]
  );
});
