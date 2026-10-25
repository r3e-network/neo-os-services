import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { createSecureBackupDir, writeSecureBackupFile } from './lib-secure-backup.mjs';

const execFileAsync = promisify(execFile);
const backupScript = path.resolve(import.meta.dirname, 'archive/backup-system-state.mjs');
const syntheticAppId = 'synthetic-app';
const expectedKinds = ['local_env', 'phala_env', 'cvm_runtime_config', 'oracle_keystore'];

async function makeTempDir(t, prefix) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function useUmask022(t) {
  const previous = process.umask(0o022);
  t.after(() => process.umask(previous));
}

async function assertDirectoryMode(directoryPath) {
  const stat = await fs.lstat(directoryPath);
  assert.equal(stat.isSymbolicLink(), false, `${directoryPath} must not be a symlink`);
  assert.equal(stat.isDirectory(), true, `${directoryPath} must be a directory`);
  if (process.platform !== 'win32') {
    assert.equal(stat.mode & 0o777, 0o700, `${directoryPath} must be owner-only`);
  }
}

async function assertFileMode(filePath, expectedMode = 0o600) {
  const stat = await fs.lstat(filePath);
  assert.equal(stat.isSymbolicLink(), false, `${filePath} must not be a symlink`);
  assert.equal(stat.isFile(), true, `${filePath} must be a regular file`);
  if (process.platform !== 'win32') {
    assert.equal(stat.mode & 0o777, expectedMode, `${filePath} has unexpected permissions`);
  }
}

test('backup directories are forced to 0700 under umask 022 and timestamp reuse is rejected', async (t) => {
  useUmask022(t);
  const tempDir = await makeTempDir(t, 'secure-backup-dirs-');
  const backupBase = path.join(tempDir, 'private-backups');
  const backupDir = path.join(backupBase, syntheticAppId, '2026-10-25T00-00-00-000Z');
  await fs.mkdir(backupBase, { mode: 0o755 });
  await fs.chmod(backupBase, 0o755);

  const realBackupDir = await createSecureBackupDir(backupDir, backupBase);

  assert.equal(realBackupDir, await fs.realpath(backupDir));
  await assertDirectoryMode(backupBase);
  await assertDirectoryMode(path.join(backupBase, syntheticAppId));
  await assertDirectoryMode(backupDir);
  await assert.rejects(createSecureBackupDir(backupDir, backupBase), { code: 'EEXIST' });
  await assertDirectoryMode(backupDir);
});

test('a pre-existing timestamp directory is rejected even with 0700 permissions', async (t) => {
  useUmask022(t);
  const tempDir = await makeTempDir(t, 'secure-backup-existing-dir-');
  const backupBase = path.join(tempDir, 'private-backups');
  const backupDir = path.join(backupBase, syntheticAppId, 'existing-timestamp');
  const canaryPath = path.join(backupDir, 'keep.txt');
  await fs.mkdir(backupDir, { recursive: true, mode: 0o700 });
  await fs.chmod(backupDir, 0o700);
  await fs.writeFile(canaryPath, 'synthetic-canary', 'utf8');

  await assert.rejects(createSecureBackupDir(backupDir, backupBase), { code: 'EEXIST' });
  assert.equal(await fs.readFile(canaryPath, 'utf8'), 'synthetic-canary');
});

test('backup directory creation rejects canonical path escapes', async (t) => {
  const tempDir = await makeTempDir(t, 'secure-backup-dir-escape-');
  const backupBase = path.join(tempDir, 'private-backups');
  const escapedDir = path.resolve(backupBase, '..', 'outside-backup');

  await assert.rejects(createSecureBackupDir(escapedDir, backupBase), /escapes its backup base/);
  const stat = await fs.lstat(escapedDir).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  assert.equal(stat, null);
});

test(
  'backup directory creation refuses controlled symlink components without following them',
  { skip: process.platform === 'win32' },
  async (t) => {
    const tempDir = await makeTempDir(t, 'secure-backup-dir-symlink-');
    const backupBase = path.join(tempDir, 'private-backups');
    const outsideDir = path.join(tempDir, 'outside');
    await fs.mkdir(outsideDir);
    await fs.symlink(outsideDir, backupBase, 'dir');

    await assert.rejects(
      createSecureBackupDir(path.join(backupBase, syntheticAppId, 'timestamp'), backupBase),
      /not a real directory/
    );
    assert.deepEqual(await fs.readdir(outsideDir), []);
    assert.equal((await fs.lstat(backupBase)).isSymbolicLink(), true);
  }
);

test('the secret writer enforces 0600 and a second write cannot replace the first', async (t) => {
  useUmask022(t);
  const tempDir = await makeTempDir(t, 'secure-backup-second-write-');
  const backupBase = path.join(tempDir, 'private-backups');
  const backupDir = path.join(backupBase, syntheticAppId, 'timestamp');
  await createSecureBackupDir(backupDir, backupBase);
  const destination = path.join(backupDir, 'oracle-key.json');

  await writeSecureBackupFile(backupDir, 'oracle-key.json', '{"key":"first-synthetic"}\n');
  await assertFileMode(destination);
  assert.equal(await fs.readFile(destination, 'utf8'), '{"key":"first-synthetic"}\n');

  await assert.rejects(writeSecureBackupFile(backupDir, 'oracle-key.json', 'replacement'), {
    code: 'EEXIST',
  });
  assert.equal(await fs.readFile(destination, 'utf8'), '{"key":"first-synthetic"}\n');
  await assertFileMode(destination);
});

test('the secret writer rejects existing files and directories without changing them', async (t) => {
  useUmask022(t);
  const tempDir = await makeTempDir(t, 'secure-backup-existing-targets-');
  const backupBase = path.join(tempDir, 'private-backups');
  const backupDir = path.join(backupBase, syntheticAppId, 'timestamp');
  await createSecureBackupDir(backupDir, backupBase);
  const existingFile = path.join(backupDir, 'runtime-config.json');
  const existingDirectory = path.join(backupDir, '.env.snapshot.json');
  const canaryPath = path.join(existingDirectory, 'keep.txt');
  await fs.writeFile(existingFile, 'synthetic-original', { encoding: 'utf8', mode: 0o640 });
  await fs.chmod(existingFile, 0o640);
  await fs.mkdir(existingDirectory);
  await fs.writeFile(canaryPath, 'synthetic-canary', 'utf8');

  await assert.rejects(writeSecureBackupFile(backupDir, 'runtime-config.json', 'replacement'), {
    code: 'EEXIST',
  });
  await assert.rejects(writeSecureBackupFile(backupDir, '.env.snapshot.json', 'replacement'), {
    code: 'EEXIST',
  });
  assert.equal(await fs.readFile(existingFile, 'utf8'), 'synthetic-original');
  await assertFileMode(existingFile, 0o640);
  assert.equal(await fs.readFile(canaryPath, 'utf8'), 'synthetic-canary');
});

test(
  'the secret writer rejects a symlink target and preserves its referent',
  { skip: process.platform === 'win32' },
  async (t) => {
    const tempDir = await makeTempDir(t, 'secure-backup-file-symlink-');
    const backupBase = path.join(tempDir, 'private-backups');
    const backupDir = path.join(backupBase, syntheticAppId, 'timestamp');
    await createSecureBackupDir(backupDir, backupBase);
    const outsideFile = path.join(tempDir, 'outside.json');
    const linkPath = path.join(backupDir, 'morpheus.testnet.env.snapshot.json');
    await fs.writeFile(outsideFile, 'synthetic-outside', 'utf8');
    await fs.symlink(outsideFile, linkPath);

    await assert.rejects(
      writeSecureBackupFile(backupDir, 'morpheus.testnet.env.snapshot.json', 'replacement'),
      { code: 'EEXIST' }
    );
    assert.equal(await fs.readFile(outsideFile, 'utf8'), 'synthetic-outside');
    assert.equal((await fs.lstat(linkPath)).isSymbolicLink(), true);
  }
);

test('the secret writer rejects an output outside the canonical backup directory', async (t) => {
  const tempDir = await makeTempDir(t, 'secure-backup-file-escape-');
  const backupBase = path.join(tempDir, 'private-backups');
  const backupDir = path.join(backupBase, syntheticAppId, 'timestamp');
  await createSecureBackupDir(backupDir, backupBase);

  await assert.rejects(writeSecureBackupFile(backupDir, '../outside.json', 'synthetic'), {
    code: 'EINVAL',
  });
  const stat = await fs
    .lstat(path.join(backupBase, syntheticAppId, 'outside.json'))
    .catch((error) => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
  assert.equal(stat, null);
});

test('a failed secret write removes the newly created output and leaves no temporary file', async (t) => {
  useUmask022(t);
  const tempDir = await makeTempDir(t, 'secure-backup-write-failure-');
  const backupBase = path.join(tempDir, 'private-backups');
  const backupDir = path.join(backupBase, syntheticAppId, 'timestamp');
  await createSecureBackupDir(backupDir, backupBase);
  async function* partialSecret() {
    yield 'synthetic-partial-secret';
    throw new Error('synthetic-write-failure');
  }

  await assert.rejects(
    writeSecureBackupFile(backupDir, 'runtime-config.json', partialSecret()),
    /synthetic-write-failure/
  );
  assert.deepEqual(await fs.readdir(backupDir), []);
  await assertDirectoryMode(backupDir);
});

async function createBackupHarness(t, { invalidKeystore = false } = {}) {
  const cwd = await makeTempDir(t, 'backup-system-state-e2e-');
  const binDir = path.join(cwd, 'bin');
  const nitroDir = path.join(cwd, 'deploy', 'nitro');
  await fs.mkdir(binDir);
  await fs.mkdir(nitroDir, { recursive: true });

  const localEnv = {
    LOCAL_ENV_SECRET: 'synthetic-local-secret',
    MORPHEUS_NETWORK: 'testnet',
  };
  const nitroEnv = { NITRO_ENV_SECRET: 'synthetic-nitro-secret' };
  const runtimeConfig = {
    runtime_secret: 'synthetic-runtime-secret',
    nested: { enabled: true },
  };
  const oracleKeystore = { private_key: 'synthetic-oracle-key', version: 1 };
  await fs.writeFile(
    path.join(cwd, '.env'),
    'LOCAL_ENV_SECRET=synthetic-local-secret\nMORPHEUS_NETWORK=testnet\n',
    { encoding: 'utf8', mode: 0o600 }
  );
  await fs.writeFile(
    path.join(nitroDir, 'morpheus.testnet.env'),
    'NITRO_ENV_SECRET=synthetic-nitro-secret\n',
    { encoding: 'utf8', mode: 0o600 }
  );

  const runtimeOutput = `${JSON.stringify(runtimeConfig)}\n`;
  const keystoreOutput = invalidKeystore
    ? '{"private_key":"synthetic-invalid"\n'
    : `${JSON.stringify(oracleKeystore)}\n`;
  const fakePhala = `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === 'runtime-config') {
  process.stdout.write(${JSON.stringify(runtimeOutput)});
  process.exit(0);
}
if (args[0] === 'ssh') {
  process.stdout.write(${JSON.stringify(keystoreOutput)});
  process.exit(0);
}
process.exit(2);
`;
  const fakePhalaPath = path.join(binDir, 'phala');
  await fs.writeFile(fakePhalaPath, fakePhala, { encoding: 'utf8', mode: 0o700 });
  await fs.chmod(fakePhalaPath, 0o700);

  const requests = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      const rows = JSON.parse(body);
      requests.push({ method: request.method, url: request.url, rows });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(rows));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      })
  );
  const address = server.address();
  const env = {
    PATH: binDir,
    PHALA_APP_ID: syntheticAppId,
    MORPHEUS_RUNTIME_TOKEN: 'synthetic-runtime-token',
    SUPABASE_URL: `http://127.0.0.1:${address.port}`,
    SUPABASE_SECRET_KEY: 'synthetic-supabase-key',
  };

  return {
    cwd,
    env,
    requests,
    localEnv,
    nitroEnv,
    runtimeConfig,
    oracleKeystore,
    run: () =>
      execFileAsync(process.execPath, [backupScript], {
        cwd,
        env,
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
      }),
  };
}

test('the real backup script writes all four outputs owner-only and preserves legacy rows', async (t) => {
  useUmask022(t);
  const harness = await createBackupHarness(t);
  const { stdout } = await harness.run();
  const summary = JSON.parse(stdout);
  const backupBase = path.join(harness.cwd, 'private-backups');
  const appDir = path.join(backupBase, syntheticAppId);
  const backupDir = summary.backup_dir;

  assert.equal(summary.app_id, syntheticAppId);
  assert.equal(summary.inserted_rows, 4);
  assert.deepEqual(summary.kinds, expectedKinds);
  assert.equal(await fs.realpath(path.dirname(backupDir)), await fs.realpath(appDir));
  await assertDirectoryMode(backupBase);
  await assertDirectoryMode(appDir);
  await assertDirectoryMode(backupDir);

  const expectedOutputs = new Map([
    ['oracle-key.json', harness.oracleKeystore],
    ['runtime-config.json', harness.runtimeConfig],
    ['.env.snapshot.json', harness.localEnv],
    ['morpheus.testnet.env.snapshot.json', harness.nitroEnv],
  ]);
  for (const [fileName, expected] of expectedOutputs) {
    const outputPath = path.join(backupDir, fileName);
    await assertFileMode(outputPath);
    assert.deepEqual(JSON.parse(await fs.readFile(outputPath, 'utf8')), expected, fileName);
  }
  assert.deepEqual((await fs.readdir(backupDir)).sort(), [...expectedOutputs.keys()].sort());

  assert.equal(harness.requests.length, 1);
  assert.equal(harness.requests[0].method, 'POST');
  assert.equal(harness.requests[0].url, '/rest/v1/morpheus_system_backups');
  const rows = harness.requests[0].rows;
  assert.deepEqual(
    rows.map((row) => row.backup_kind),
    expectedKinds
  );
  for (const row of rows) {
    assert.deepEqual(Object.keys(row).sort(), [
      'backup_kind',
      'backup_scope',
      'checksum',
      'metadata',
      'network',
      'payload',
    ]);
    assert.equal(row.network, 'testnet');
    assert.equal(row.backup_scope, syntheticAppId);
    assert.match(row.checksum, /^[a-f0-9]{64}$/);
    assert.equal(typeof row.metadata.timestamp, 'string');
  }
  assert.deepEqual(rows[0].payload, harness.localEnv);
  assert.equal(rows[0].metadata.source_path, '.env');
  assert.deepEqual(rows[1].payload, harness.nitroEnv);
  assert.equal(rows[1].metadata.network, 'testnet');
  assert.equal(rows[1].metadata.source_path, 'deploy/nitro/morpheus.testnet.env');
  assert.deepEqual(rows[2].payload, harness.runtimeConfig);
  assert.deepEqual(rows[3].payload, harness.oracleKeystore);
  assert.equal(rows[3].metadata.keystore_path, '/data/morpheus/oracle-key.json');
  assert.equal(rows[3].metadata.note, 'sealed Oracle X25519 transport key backup copied from CVM');
});

test('the real backup script parses keystore JSON before creating any secret output', async (t) => {
  useUmask022(t);
  const harness = await createBackupHarness(t, { invalidKeystore: true });

  await assert.rejects(harness.run());
  assert.equal(harness.requests.length, 0);
  const appDir = path.join(harness.cwd, 'private-backups', syntheticAppId);
  const timestampDirs = await fs.readdir(appDir);
  assert.equal(timestampDirs.length, 1);
  const backupDir = path.join(appDir, timestampDirs[0]);
  await assertDirectoryMode(backupDir);
  assert.deepEqual(await fs.readdir(backupDir), []);
});
