import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  MANIFEST,
  contentDigest,
  createRustReleaseSnapshot,
  verifyRustReleaseSnapshot,
} from './create-rust-release-snapshot.mjs';

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
}

async function write(root, file, value, mode = 0o644) {
  await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await fs.writeFile(path.join(root, file), value, { mode });
  await fs.chmod(path.join(root, file), mode);
}

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'neoos-rust-release-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'repo');
  await fs.mkdir(root);
  git(root, ['init', '--quiet']);
  await write(root, '.gitignore', '*.env\n.env*\nignored/\ntarget/\n');
  await write(root, '.dockerignore', '.git\n.env*\ntarget\n');
  await write(root, 'Cargo.toml', '[workspace]\nresolver = "2"\n');
  await write(root, 'Cargo.lock', 'version = 4\n');
  await write(root, 'config/networks/mainnet.json', '{"network":"mainnet"}\n');
  await write(root, 'config/networks/testnet.json', '{"network":"testnet"}\n');
  await write(root, 'vendor/example/Cargo.toml', '[package]\nname = "example"\n');
  await write(root, 'vendor/example/src/lib.rs', 'pub fn vendor() {}\n');
  await write(root, 'crates/core/src/lib.rs', 'pub fn core() {}\n');
  for (const name of ['neo-signer', 'nitro-enclave-host', 'neo-os-relayer']) {
    await write(root, `workers/${name}/Cargo.toml`, `[package]\nname = "${name}"\n`);
    await write(root, `workers/${name}/src/lib.rs`, 'pub fn run() {}\n');
  }
  for (const name of ['enclave', 'signer', 'relayer']) {
    await write(
      root,
      `deploy/nitro/Dockerfile.${name}`,
      'FROM scratch\nCOPY Cargo.toml Cargo.lock ./\nCOPY vendor /vendor\nCOPY crates /crates\n'
    );
  }
  for (const name of ['enclave', 'custody'])
    await write(root, `deploy/nitro/build-${name}-eif.sh`, '#!/bin/sh\nexit 0\n', 0o755);
  git(root, ['add', '.']);
  git(root, [
    '-c',
    'user.name=Snapshot Test',
    '-c',
    'user.email=snapshot@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'fixture',
  ]);
  return { directory, root, output: path.join(directory, 'snapshot') };
}

test('includes public custody profile as a checked and hashed Docker build input', async (t) => {
  const { root, output } = await fixture(t);
  const file = 'deploy/nitro/custody-vault-profile.json';
  await write(root, file, '{"environment":"testnet"}\n');
  await createRustReleaseSnapshot({ sourceRoot: root, output });
  assert.equal(await fs.readFile(path.join(output, file), 'utf8'), '{"environment":"testnet"}\n');
  await fs.writeFile(path.join(output, file), '{"environment":"mainnet"}\n');
  await assert.rejects(verifyRustReleaseSnapshot(output));
});

test('copies dirty and untracked source without modifying HEAD, index, or source permissions', async (t) => {
  const { root, output } = await fixture(t);
  await write(root, 'crates/core/src/lib.rs', 'pub fn repaired() {}\n');
  await write(root, 'workers/neo-os-relayer/src/new_fix.rs', 'pub fn new_fix() {}\n');
  await write(root, 'crates/core/.env.local', 'credential=must-not-copy\n');
  await write(root, 'workers/neo-signer/target/ignored', 'build output');
  await write(root, 'unrelated.txt', 'outside source selection');
  git(root, ['add', 'crates/core/src/lib.rs']);
  await write(root, 'crates/core/src/lib.rs', 'pub fn newer_unstaged_fix() {}\n');
  const index = await fs.readFile(path.join(root, '.git/index'));
  const head = git(root, ['rev-parse', 'HEAD']);
  const status = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const snapshot = await createRustReleaseSnapshot({ sourceRoot: root, output });
  assert.equal(snapshot.source.dirty, true);
  assert.equal(snapshot.source.head, head.toString().trim());
  assert.equal(snapshot.source.statusPorcelainV1Base64, status.toString('base64'));
  assert.equal(
    await fs.readFile(path.join(output, 'crates/core/src/lib.rs'), 'utf8'),
    'pub fn newer_unstaged_fix() {}\n'
  );
  assert.equal(
    snapshot.files.some(({ path: file }) => file.endsWith('/new_fix.rs')),
    true
  );
  assert.equal(
    snapshot.files.some(({ path: file }) => /env|target|unrelated/.test(file)),
    false
  );
  assert.equal(
    (await fs.stat(path.join(output, 'deploy/nitro/build-enclave-eif.sh'))).mode & 0o777,
    0o755
  );
  assert.deepEqual(await fs.readFile(path.join(root, '.git/index')), index);
  assert.deepEqual(git(root, ['rev-parse', 'HEAD']), head);
  assert.deepEqual(git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']), status);
  assert.equal(contentDigest(snapshot.files), snapshot.contentSha256);
  assert.equal((await verifyRustReleaseSnapshot(output)).contentSha256, snapshot.contentSha256);
});

test('ignores force-tracked ignored secrets as well as untracked ignored secrets', async (t) => {
  const { root, output } = await fixture(t);
  await write(root, 'crates/core/production.env', 'secret=example\n');
  git(root, ['add', '--force', 'crates/core/production.env']);
  const snapshot = await createRustReleaseSnapshot({ sourceRoot: root, output });
  assert.equal(
    snapshot.files.some(({ path: file }) => file.endsWith('.env')),
    false
  );
});

test('rejects unignored secret files and embedded private keys without publishing a snapshot', async (t) => {
  const { root, output } = await fixture(t);
  await write(root, 'crates/core/credentials.json', '{"key":"example"}\n');
  await assert.rejects(
    createRustReleaseSnapshot({ sourceRoot: root, output }),
    /Secret-bearing filename/
  );
  await assert.rejects(fs.stat(output), { code: 'ENOENT' });
  await fs.unlink(path.join(root, 'crates/core/credentials.json'));
  await write(root, 'crates/core/config.txt', '-----BEGIN PRIVATE KEY-----\nexample\n');
  await assert.rejects(
    createRustReleaseSnapshot({ sourceRoot: root, output }),
    /Credential material/
  );
  await assert.rejects(fs.stat(output), { code: 'ENOENT' });
});

test('rejects symlinks to files and symlinked source directories', async (t) => {
  const { root, output, directory } = await fixture(t);
  await write(directory, 'outside.rs', 'outside contents');
  await fs.symlink(path.join(directory, 'outside.rs'), path.join(root, 'crates/core/src/link.rs'));
  await assert.rejects(createRustReleaseSnapshot({ sourceRoot: root, output }), /Symlink/);
  await fs.unlink(path.join(root, 'crates/core/src/link.rs'));
  await fs.rename(path.join(root, 'crates/core'), path.join(directory, 'moved-core'));
  await fs.symlink(path.join(directory, 'moved-core'), path.join(root, 'crates/core'));
  await assert.rejects(createRustReleaseSnapshot({ sourceRoot: root, output }), /Symlink/);
});

test('requires an isolated, new destination and never alters an existing directory', async (t) => {
  const { root, output } = await fixture(t);
  await fs.mkdir(output);
  await write(output, 'keep', 'untouched');
  await assert.rejects(createRustReleaseSnapshot({ sourceRoot: root, output }), { code: 'EEXIST' });
  assert.equal(await fs.readFile(path.join(output, 'keep'), 'utf8'), 'untouched');
  await assert.rejects(
    createRustReleaseSnapshot({ sourceRoot: root, output: path.join(root, 'snapshot') }),
    /isolated outside/
  );
});

test('content and executable mode changes alter the digest, but snapshot time does not', async (t) => {
  const { root, output, directory } = await fixture(t);
  const first = await createRustReleaseSnapshot({ sourceRoot: root, output });
  const same = await createRustReleaseSnapshot({
    sourceRoot: root,
    output: path.join(directory, 'same'),
  });
  assert.equal(first.contentSha256, same.contentSha256);
  await write(root, 'crates/core/src/lib.rs', 'pub fn changed() {}\n');
  const changed = await createRustReleaseSnapshot({
    sourceRoot: root,
    output: path.join(directory, 'changed'),
  });
  assert.notEqual(first.contentSha256, changed.contentSha256);
  await fs.chmod(path.join(root, 'deploy/nitro/build-enclave-eif.sh'), 0o644);
  const mode = await createRustReleaseSnapshot({
    sourceRoot: root,
    output: path.join(directory, 'mode'),
  });
  assert.notEqual(changed.contentSha256, mode.contentSha256);
});

test('rejects source changes and new files introduced while copying', async (t) => {
  const { root, output } = await fixture(t);
  await assert.rejects(
    createRustReleaseSnapshot({
      sourceRoot: root,
      output,
      onCopied: () => write(root, 'crates/core/src/lib.rs', 'pub fn raced() {}\n'),
    }),
    /changed while copying/
  );
  await assert.rejects(fs.stat(output), { code: 'ENOENT' });
  await assert.rejects(
    createRustReleaseSnapshot({
      sourceRoot: root,
      output,
      onCopied: () => write(root, 'crates/core/src/addition.rs', 'pub fn added() {}\n'),
    }),
    /inventory changed while copying/
  );
});

test('verification rejects content tampering, extra files, and escaping manifest paths', async (t) => {
  const { root, output } = await fixture(t);
  const snapshot = await createRustReleaseSnapshot({ sourceRoot: root, output });
  await write(output, 'crates/core/src/lib.rs', 'tampered');
  await assert.rejects(verifyRustReleaseSnapshot(output), /digest mismatch/);
  await fs.copyFile(
    path.join(root, 'crates/core/src/lib.rs'),
    path.join(output, 'crates/core/src/lib.rs')
  );
  await write(output, 'unlisted', 'extra');
  await assert.rejects(verifyRustReleaseSnapshot(output), /inventory mismatch/);
  await fs.unlink(path.join(output, 'unlisted'));
  snapshot.files[0].path = '../outside';
  await write(output, MANIFEST, JSON.stringify(snapshot));
  await assert.rejects(verifyRustReleaseSnapshot(output), /Unsafe relative file path/);
});

test('required ignored or deleted build inputs fail closed', async (t) => {
  const { root, output } = await fixture(t);
  await fs.unlink(path.join(root, 'Cargo.lock'));
  await assert.rejects(
    createRustReleaseSnapshot({ sourceRoot: root, output }),
    /Required build input.*Cargo.lock/
  );
});

test('Docker COPY dependencies outside the selected source tree cannot be silently omitted', async (t) => {
  const { root, output } = await fixture(t);
  await write(root, 'deploy/nitro/Dockerfile.signer', 'FROM scratch\nCOPY other-source /app\n');
  await write(root, 'other-source', 'not selected');
  await assert.rejects(
    createRustReleaseSnapshot({ sourceRoot: root, output }),
    /COPY input is absent/
  );
  await write(
    root,
    'deploy/nitro/Dockerfile.signer',
    'FROM scratch\nCOPY ["../outside", "/app"]\n'
  );
  await assert.rejects(
    createRustReleaseSnapshot({ sourceRoot: root, output }),
    /Unsafe relative file path/
  );
});
