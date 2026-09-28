import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { sc, wallet } from '@cityofzion/neon-js';
import { computeUpgradeArtifactHash } from './lib-oracle-upgrade.mjs';

// Drives scripts/upgrade-morpheus-oracle.mjs against a local JSON-RPC stub (127.0.0.1 only,
// nothing leaves the machine) to pin how it plans each kernel generation's update gate and
// that it never sends a timelocked update early.

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const SCRIPT = path.join(ROOT, 'scripts', 'upgrade-morpheus-oracle.mjs');
const ORACLE = '0x00112233445566778899aabbccddeeff00112233';
// Deterministic throwaway key used only as the stub's admin; it signs nothing here.
const ADMIN = new wallet.Account('3'.repeat(64));

const IMMEDIATE_METHODS = [{ name: 'update', parameters: [{}, {}] }];
const TIMELOCKED_METHODS = [
  { name: 'update', parameters: [{}, {}] },
  { name: 'scheduleUpdate', parameters: [{}, {}] },
  { name: 'cancelUpdate', parameters: [] },
];

function nefOf(scriptHex) {
  return new sc.NEF({ compiler: 'neo-os-tests', source: '', tokens: [], script: scriptHex });
}

function rpcNef(nef) {
  const json = nef.toJson();
  return {
    magic: json.magic,
    compiler: json.compiler,
    source: json.source,
    tokens: [],
    script: Buffer.from(json.script, 'hex').toString('base64'),
    checksum: json.checksum,
  };
}

function hash160Item(account) {
  return {
    type: 'ByteString',
    value: Buffer.from(account.scriptHash, 'hex').reverse().toString('base64'),
  };
}

async function startRpcStub({ methods, pending = null, chainTimeMs = 1_000_000 }) {
  const deployedNef = nefOf('0c0474657374' + '40');
  const calls = [];
  const server = http.createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => (raw += chunk));
    request.on('end', () => {
      const { id, method, params } = JSON.parse(raw);
      calls.push({ method, params });
      const reply = (result) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
      };
      switch (method) {
        case 'getcontractstate':
          return reply({
            id: 7,
            updatecounter: 1,
            hash: ORACLE,
            nef: rpcNef(deployedNef),
            manifest: { name: 'MorpheusOracle', abi: { methods, events: [] } },
          });
        case 'getstorage': {
          if (!pending) return reply(null);
          return reply(params[1] === 'MQ==' ? pending.timeBase64 : pending.hashBase64);
        }
        case 'getblockcount':
          return reply(100);
        case 'getblockheader':
          return reply({ index: params[0], time: chainTimeMs });
        case 'invokefunction': {
          const target = params[1];
          if (target === 'admin' || target === 'updater') {
            return reply({ state: 'HALT', stack: [hash160Item(ADMIN)] });
          }
          if (target === 'getMiniAppCount') {
            return reply({ state: 'HALT', stack: [{ type: 'Integer', value: '0' }] });
          }
          if (target === 'update' && pending && chainTimeMs < pending.executeAfterMs) {
            return reply({ state: 'FAULT', gasconsumed: '0', exception: 'timelock active' });
          }
          return reply({ state: 'HALT', gasconsumed: '12345678', stack: [] });
        }
        default:
          response.writeHead(500);
          return response.end(`unexpected method ${method}`);
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}`, calls, close: () => server.close() };
}

async function writeLocalArtifact(dir) {
  const nef = nefOf('0c0a6e6577206b65726e656c' + '40');
  const nefBytes = Buffer.from(nef.serialize(), 'hex');
  const manifestText = JSON.stringify({ name: 'MorpheusOracle', abi: { methods: [], events: [] } });
  const nefPath = path.join(dir, 'MorpheusOracle.nef');
  const manifestPath = path.join(dir, 'MorpheusOracle.manifest.json');
  await fs.writeFile(nefPath, nefBytes);
  await fs.writeFile(manifestPath, manifestText);
  return {
    nefPath,
    manifestPath,
    artifactHash: computeUpgradeArtifactHash(nefBytes, manifestText),
  };
}

function runTool(stubUrl, artifact, archiveDir, { extraArgs = [], env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        SCRIPT,
        '--network',
        'testnet',
        '--rpc',
        stubUrl,
        '--oracle',
        ORACLE,
        '--nef',
        artifact.nefPath,
        '--manifest',
        artifact.manifestPath,
        '--archive-dir',
        archiveDir,
        ...extraArgs,
      ],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          MORPHEUS_NETWORK: 'testnet',
          NEO_NETWORK_MAGIC: '894710606',
          UPGRADE_APPLY: '',
          REBUILD_APPLY: '',
          MORPHEUS_ORACLE_ADMIN_WIF: '',
          ...env,
        },
      }
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function planOf(stdout) {
  const report = JSON.parse(stdout.slice(0, stdout.indexOf('\n}\n') + 2));
  return report;
}

function invokedMethods(calls) {
  return calls.filter((call) => call.method === 'invokefunction').map((call) => call.params[1]);
}

async function withFixture(stubOptions, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oracle-upgrade-test-'));
  const stub = await startRpcStub(stubOptions);
  try {
    const artifact = await writeLocalArtifact(dir);
    await fn({ stub, artifact, archiveDir: path.join(dir, 'archive') });
  } finally {
    stub.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('the deployed immediate gate plans a direct update and archives the rollback artifact', async () => {
  await withFixture({ methods: IMMEDIATE_METHODS }, async ({ stub, artifact, archiveDir }) => {
    const result = await runTool(stub.url, artifact, archiveDir);
    assert.equal(result.status, 0, result.stderr);
    const report = planOf(result.stdout);
    assert.equal(report.plan.action, 'update');
    assert.equal(report.local.artifact_sha256, artifact.artifactHash);
    assert.match(report.deployed.update_gate, /immediate/);
    assert.ok(invokedMethods(stub.calls).includes('update'));
    assert.ok(!stub.calls.some((call) => call.method === 'getstorage'));
    assert.match(result.stdout, /Set UPGRADE_APPLY=1 to send update/);

    const archived = await fs.readdir(archiveDir);
    const rollback = archived.find((name) => name.endsWith('.rollback.json'));
    assert.ok(rollback, `no rollback record in ${archived.join(', ')}`);
    const record = JSON.parse(await fs.readFile(path.join(archiveDir, rollback), 'utf8'));
    const nef = await fs.readFile(record.nef);
    const manifest = await fs.readFile(record.manifest, 'utf8');
    assert.equal(record.artifact_sha256, computeUpgradeArtifactHash(nef, manifest));
  });
});

test('the timelocked gate plans scheduleUpdate when nothing is scheduled', async () => {
  await withFixture({ methods: TIMELOCKED_METHODS }, async ({ stub, artifact, archiveDir }) => {
    const result = await runTool(stub.url, artifact, archiveDir);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(planOf(result.stdout).plan.action, 'schedule');
    const invoked = invokedMethods(stub.calls);
    assert.ok(invoked.includes('scheduleUpdate'));
    assert.ok(!invoked.includes('update'));
    assert.match(result.stdout, /Set UPGRADE_APPLY=1 to send scheduleUpdate/);
    assert.match(result.stdout, /wait 24 h and run again/);
  });
});

function pendingFor(artifactHash, executeAfterMs) {
  const time = Buffer.alloc(8);
  time.writeBigInt64LE(BigInt(executeAfterMs));
  // Neo trims a storage integer to its minimal two-complement width; keep 6 bytes here.
  return {
    executeAfterMs,
    timeBase64: time.subarray(0, 6).toString('base64'),
    hashBase64: Buffer.from(artifactHash, 'hex').toString('base64'),
  };
}

test('a matching schedule inside the timelock is a wait, and apply refuses to send early', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oracle-upgrade-test-'));
  try {
    const artifact = await writeLocalArtifact(dir);
    const stub = await startRpcStub({
      methods: TIMELOCKED_METHODS,
      pending: pendingFor(artifact.artifactHash, 2_000_000),
      chainTimeMs: 1_000_000,
    });
    try {
      const dryRun = await runTool(stub.url, artifact, path.join(dir, 'archive'));
      assert.equal(dryRun.status, 0, dryRun.stderr);
      const report = planOf(dryRun.stdout);
      assert.equal(report.plan.action, 'wait');
      assert.equal(report.plan.remainingMs, '1000000');
      assert.match(dryRun.stdout, /timelock running/);

      const applied = await runTool(stub.url, artifact, path.join(dir, 'archive'), {
        env: { UPGRADE_APPLY: '1', MORPHEUS_ORACLE_ADMIN_WIF: ADMIN.WIF },
      });
      assert.notEqual(applied.status, 0);
      assert.match(applied.stderr, /still timelocked/);
      assert.ok(!stub.calls.some((call) => call.method === 'sendrawtransaction'));
    } finally {
      stub.close();
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a matching schedule past the timelock plans the update', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oracle-upgrade-test-'));
  try {
    const artifact = await writeLocalArtifact(dir);
    const stub = await startRpcStub({
      methods: TIMELOCKED_METHODS,
      pending: pendingFor(artifact.artifactHash, 2_000_000),
      chainTimeMs: 2_000_000,
    });
    try {
      const result = await runTool(stub.url, artifact, path.join(dir, 'archive'));
      assert.equal(result.status, 0, result.stderr);
      assert.equal(planOf(result.stdout).plan.action, 'execute');
      assert.ok(invokedMethods(stub.calls).includes('update'));
    } finally {
      stub.close();
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a different scheduled artifact is refused unless it is cancelled or replaced', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oracle-upgrade-test-'));
  try {
    const artifact = await writeLocalArtifact(dir);
    const stub = await startRpcStub({
      methods: TIMELOCKED_METHODS,
      pending: pendingFor('c'.repeat(64), 2_000_000),
      chainTimeMs: 3_000_000,
    });
    try {
      const refused = await runTool(stub.url, artifact, path.join(dir, 'archive'));
      assert.equal(refused.status, 1);
      assert.match(refused.stderr, /different artifact is scheduled/);

      const cancel = await runTool(stub.url, artifact, path.join(dir, 'archive'), {
        extraArgs: ['--cancel'],
      });
      assert.equal(cancel.status, 0, cancel.stderr);
      assert.equal(planOf(cancel.stdout).plan.action, 'cancel');
      assert.ok(invokedMethods(stub.calls).includes('cancelUpdate'));
    } finally {
      stub.close();
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
