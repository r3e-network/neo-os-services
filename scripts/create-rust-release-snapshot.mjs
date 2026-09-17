#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MANIFEST = 'rust-release-snapshot.json';
const ROOT_FILES = [
  'Cargo.toml',
  'Cargo.lock',
  '.dockerignore',
  'config/networks/mainnet.json',
  'config/networks/testnet.json',
];
const SOURCE_DIRS = [
  'vendor',
  'crates',
  'workers/neo-signer',
  'workers/nitro-enclave-host',
  'workers/neo-os-relayer',
];
const BUILD_FILES = [
  'deploy/nitro/Dockerfile.enclave',
  'deploy/nitro/Dockerfile.signer',
  'deploy/nitro/Dockerfile.relayer',
  'deploy/nitro/build-enclave-eif.sh',
  'deploy/nitro/build-custody-eif.sh',
];
const OPTIONAL_BUILD_FILES = [
  'deploy/nitro/custody-vault-profile.json',
  ...BUILD_FILES.slice(0, 3).map((file) => `${file}.dockerignore`),
  '.cargo/config.toml',
  'rust-toolchain.toml',
  'rust-toolchain',
];
const gitEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sortPaths = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function git(root, args, options = {}) {
  return execFileSync('git', ['-C', root, ...args], {
    env: gitEnv,
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
}

function relativePath(value) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.includes('\\') ||
    /[\x00-\x1f\x7f]/.test(value) ||
    value.split('/').some((part) => !part || part === '.' || part === '..') ||
    path.isAbsolute(value)
  ) {
    throw new Error('Unsafe relative file path');
  }
  return value;
}

function inScope(file) {
  if (
    file
      .split('/')
      .some((part) => ['target', 'node_modules', '.git', '.next', 'coverage'].includes(part))
  )
    return false;
  return (
    [...ROOT_FILES, ...BUILD_FILES, ...OPTIONAL_BUILD_FILES].includes(file) ||
    SOURCE_DIRS.some((directory) => file === directory || file.startsWith(`${directory}/`))
  );
}

function rejectSecretFile(file, bytes) {
  const components = file.split('/');
  if (
    components.some((part) =>
      /^(?:\.env(?:\.|$)|\.npmrc$|\.netrc$|\.aws$|\.ssh$|\.secrets?$|secrets?$|credentials?(?:\.|$)|private-backups$)/i.test(
        part
      )
    ) ||
    /(?:\.env(?:\.|$)|\.(?:pem|key|p12|pfx|wif|jks|keystore)$|(?:^|\/)id_(?:rsa|ed25519)$)/i.test(
      file
    )
  ) {
    throw new Error(`Secret-bearing filename is not allowed: ${file}`);
  }
  const text = bytes.toString('utf8');
  if (
    /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/.test(text) ||
    /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/.test(text) ||
    /\b(?:ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{60,})\b/.test(text)
  ) {
    throw new Error(`Credential material is not allowed: ${file}`);
  }
}

async function checkedPath(root, file) {
  relativePath(file);
  let cursor = root;
  for (const component of file.split('/')) {
    cursor = path.join(cursor, component);
    if ((await fs.lstat(cursor)).isSymbolicLink())
      throw new Error(`Symlink is not allowed: ${file}`);
  }
  if ((await fs.realpath(cursor)) !== cursor)
    throw new Error(`File escapes source directory: ${file}`);
  return cursor;
}

function fingerprint(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mode, stat.mtimeNs, stat.ctimeNs]
    .map(String)
    .join(':');
}

async function readStableFile(root, file) {
  const absolute = await checkedPath(root, file);
  const before = await fs.lstat(absolute, { bigint: true });
  if (!before.isFile()) throw new Error(`Non-regular file is not allowed: ${file}`);
  const handle = await fs.open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (fingerprint(before) !== fingerprint(await handle.stat({ bigint: true }))) {
      throw new Error(`Source changed before read: ${file}`);
    }
    const bytes = await handle.readFile();
    await checkedPath(root, file);
    if (
      fingerprint(before) !== fingerprint(await fs.lstat(absolute, { bigint: true })) ||
      fingerprint(before) !== fingerprint(await handle.stat({ bigint: true }))
    ) {
      throw new Error(`Source changed during read: ${file}`);
    }
    const mode = Number(before.mode & 0o777n);
    if ((before.mode & 0o7000n) !== 0n)
      throw new Error(`Special permission bits are not allowed: ${file}`);
    rejectSecretFile(file, bytes);
    return {
      bytes,
      record: {
        path: file,
        mode: mode.toString(8).padStart(4, '0'),
        size: bytes.length,
        sha256: sha256(bytes),
      },
    };
  } finally {
    await handle.close();
  }
}

function gitState(root) {
  const head = git(root, ['rev-parse', '--verify', 'HEAD'], { encoding: 'utf8' }).trim();
  const status = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  return {
    head,
    dirty: status.length > 0,
    statusPorcelainV1Base64: status.toString('base64'),
    statusSha256: sha256(status),
    indexEntriesSha256: sha256(git(root, ['ls-files', '--stage', '-z'])),
  };
}

async function sourceFiles(root) {
  const candidates = [
    ...new Set(
      git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
        encoding: 'utf8',
      })
        .split('\0')
        .filter(Boolean)
        .filter(inScope)
    ),
  ].sort(sortPaths);
  for (const file of candidates) {
    try {
      await checkedPath(root, file);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const ignored = spawnSync('git', ['-C', root, 'check-ignore', '--no-index', '--stdin', '-z'], {
    input: `${candidates.join('\0')}\0`,
    encoding: 'utf8',
    env: gitEnv,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (ignored.error || ![0, 1].includes(ignored.status))
    throw new Error('Cannot verify Git ignore rules');
  const excluded = new Set(ignored.stdout.split('\0').filter(Boolean));
  const files = [];
  for (const file of candidates) {
    relativePath(file);
    if (excluded.has(file)) continue;
    try {
      await fs.lstat(path.join(root, file));
      files.push(file);
    } catch (error) {
      // A tracked deletion is part of the dirty worktree, not a source file.
      if (error.code !== 'ENOENT') throw error;
    }
  }
  for (const file of [...ROOT_FILES, ...BUILD_FILES]) {
    if (!files.includes(file))
      throw new Error(`Required build input is missing or ignored: ${file}`);
  }
  for (const directory of SOURCE_DIRS) {
    if (!files.some((file) => file.startsWith(`${directory}/`)))
      throw new Error(`Required source directory is empty: ${directory}`);
  }
  return files;
}

function verifyDockerInputs(files, sourceByPath) {
  for (const dockerfile of BUILD_FILES.slice(0, 3)) {
    const source = sourceByPath
      .get(dockerfile)
      .toString('utf8')
      .replace(/\\\r?\n/g, ' ');
    for (const line of source.split(/\r?\n/)) {
      const match = /^\s*COPY\s+(.+)$/i.exec(line);
      if (!match) continue;
      let argumentsText = match[1].trim();
      if (/^--from=\S+\s/.test(argumentsText)) continue;
      while (/^--(?:chown|chmod)=\S+\s/.test(argumentsText))
        argumentsText = argumentsText.replace(/^--(?:chown|chmod)=\S+\s+/, '');
      let parts;
      if (argumentsText.startsWith('[')) parts = JSON.parse(argumentsText);
      else {
        if (/["'`$*?\[\]\\]/.test(argumentsText) || argumentsText.startsWith('--'))
          throw new Error(`Unsupported COPY syntax: ${dockerfile}`);
        parts = argumentsText.split(/\s+/);
      }
      if (!Array.isArray(parts) || parts.length < 2)
        throw new Error(`Invalid COPY instruction: ${dockerfile}`);
      for (const input of parts.slice(0, -1)) {
        const file = relativePath(input.replace(/^\.\//, '').replace(/\/$/, ''));
        if (!files.some((candidate) => candidate === file || candidate.startsWith(`${file}/`))) {
          throw new Error(`Docker COPY input is absent from snapshot: ${dockerfile}: ${file}`);
        }
      }
    }
  }
}

export function contentDigest(records) {
  const canonical = records
    .map(({ path: file, mode, size, sha256: digest }) => ({
      path: file,
      mode,
      size,
      sha256: digest,
    }))
    .sort((a, b) => sortPaths(a.path, b.path));
  return sha256(`neoos-rust-release-snapshot-v1\0${JSON.stringify(canonical)}`);
}

export async function verifyRustReleaseSnapshot(snapshotRoot) {
  const root = await fs.realpath(snapshotRoot);
  const manifest = JSON.parse((await readStableFile(root, MANIFEST)).bytes);
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files))
    throw new Error('Unsupported snapshot manifest');
  const expected = manifest.files.map((record) => relativePath(record.path));
  if (new Set(expected).size !== expected.length || expected.includes(MANIFEST))
    throw new Error('Duplicate or reserved manifest path');
  const actual = [];
  async function walk(directory) {
    for (const entry of await fs.readdir(path.join(root, directory), { withFileTypes: true })) {
      const file = directory ? `${directory}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`Symlink is not allowed: ${file}`);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) actual.push(file);
      else throw new Error(`Non-regular file is not allowed: ${file}`);
    }
  }
  await walk('');
  if (
    JSON.stringify(actual.filter((file) => file !== MANIFEST).sort(sortPaths)) !==
    JSON.stringify([...expected].sort(sortPaths))
  ) {
    throw new Error('Snapshot file inventory mismatch');
  }
  const records = [];
  for (const file of expected) records.push((await readStableFile(root, file)).record);
  if (
    contentDigest(records) !== manifest.contentSha256 ||
    contentDigest(manifest.files) !== manifest.contentSha256
  ) {
    throw new Error('Snapshot content digest mismatch');
  }
  return manifest;
}

export async function createRustReleaseSnapshot({ sourceRoot = repoRoot, output, onCopied } = {}) {
  if (!output) throw new Error('An explicit --output directory is required');
  const root = await fs.realpath(sourceRoot);
  if (
    (await fs.realpath(
      git(root, ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
    )) !== root
  ) {
    throw new Error('Source must be the Git repository root');
  }
  const requested = path.resolve(output);
  const destination = path.join(
    await fs.realpath(path.dirname(requested)),
    path.basename(requested)
  );
  if (
    destination === root ||
    destination.startsWith(`${root}${path.sep}`) ||
    root.startsWith(`${destination}${path.sep}`)
  ) {
    throw new Error('Snapshot must be isolated outside the source repository');
  }
  await fs.mkdir(destination, { mode: 0o700 });
  try {
    const state = gitState(root);
    const files = await sourceFiles(root);
    const records = [];
    const dockerSources = new Map();
    for (const file of files) {
      const { bytes, record } = await readStableFile(root, file);
      if (BUILD_FILES.slice(0, 3).includes(file)) dockerSources.set(file, bytes);
      const target = path.join(destination, file);
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
      await fs.writeFile(target, bytes, { flag: 'wx', mode: Number.parseInt(record.mode, 8) });
      await fs.chmod(target, Number.parseInt(record.mode, 8));
      records.push(record);
    }
    verifyDockerInputs(files, dockerSources);
    if (onCopied) await onCopied();
    if (JSON.stringify(files) !== JSON.stringify(await sourceFiles(root)))
      throw new Error('Source file inventory changed while copying');
    const rechecked = [];
    for (const file of files) rechecked.push((await readStableFile(root, file)).record);
    const digest = contentDigest(records);
    if (
      contentDigest(rechecked) !== digest ||
      JSON.stringify(gitState(root)) !== JSON.stringify(state)
    ) {
      throw new Error('Source worktree or Git state changed while copying');
    }
    const manifest = {
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      source: { root, ...state },
      selection: {
        rootFiles: ROOT_FILES,
        sourceDirectories: SOURCE_DIRS,
        buildFiles: BUILD_FILES,
        ignoredFiles: 'excluded-including-tracked',
        symlinks: 'rejected',
      },
      digestAlgorithm:
        'sha256(neoos-rust-release-snapshot-v1 + NUL + JSON(sorted {path,mode,size,sha256} records))',
      contentSha256: digest,
      files: records,
    };
    await fs.writeFile(path.join(destination, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o644,
    });
    await verifyRustReleaseSnapshot(destination);
    return { directory: destination, ...manifest };
  } catch (error) {
    await fs.rm(destination, { recursive: true, force: true });
    throw error;
  }
}

async function main(args) {
  if (args[0] === '--verify' && args.length === 2) {
    const manifest = await verifyRustReleaseSnapshot(args[1]);
    console.log(
      JSON.stringify({
        verified: true,
        contentSha256: manifest.contentSha256,
        files: manifest.files.length,
      })
    );
    return;
  }
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = { '--source': 'sourceRoot', '--output': 'output' }[args[index]];
    if (!key || !args[index + 1] || options[key])
      throw new Error(
        'Usage: --source <repository> --output <new-directory> | --verify <snapshot>'
      );
    options[key] = args[index + 1];
  }
  const snapshot = await createRustReleaseSnapshot(options);
  console.log(
    JSON.stringify(
      {
        directory: snapshot.directory,
        manifest: path.join(snapshot.directory, MANIFEST),
        contentSha256: snapshot.contentSha256,
        head: snapshot.source.head,
        dirty: snapshot.source.dirty,
        files: snapshot.files.length,
      },
      null,
      2
    )
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
