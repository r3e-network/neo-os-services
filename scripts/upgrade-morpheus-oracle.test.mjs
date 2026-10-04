import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { sc, tx, wallet } from '@cityofzion/neon-js';
import { computeUpgradeArtifactHash } from './lib-oracle-upgrade.mjs';

// Drives scripts/upgrade-morpheus-oracle.mjs against a local JSON-RPC stub (127.0.0.1 only,
// nothing leaves the machine) to pin how it plans each kernel generation's update gate, that it
// never sends a timelocked update early, and how it behaves against what real nodes answer
// (neo-go 0.121/0.123 and C# Neo 3.10 were read on 2026-10-04 and are mimicked below).

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const SCRIPT = path.join(ROOT, 'scripts', 'upgrade-morpheus-oracle.mjs');
const ORACLE = '0x00112233445566778899aabbccddeeff00112233';
const GAS_HASH = '0xd2a4cff31913016155e38e474a2c06d08be276cf';
// Deterministic throwaway key used only as the stub's admin; it signs only against the stub.
const ADMIN = new wallet.Account('3'.repeat(64));
// What neo-go 0.121/0.123 and C# Neo 3.10.1 answer for getstorage of a key that is not stored.
const ABSENT_STORAGE_ERROR = Object.freeze({ code: -104, message: 'Unknown storage item' });

// Network identities come from the reviewed registry, never from literals here.
function reviewedMagic(network) {
  const registry = JSON.parse(
    readFileSync(path.join(ROOT, 'config', 'networks', `${network}.json`), 'utf8')
  );
  return registry.neo_n3.network_magic;
}
const TESTNET_MAGIC = reviewedMagic('testnet');
const MAINNET_MAGIC = reviewedMagic('mainnet');

function getter(name, returntype = 'Integer') {
  return { name, parameters: [], returntype, safe: true };
}

const IMMEDIATE_METHODS = [{ name: 'update', parameters: [{}, {}] }];
const TIMELOCKED_METHODS = [
  { name: 'update', parameters: [{}, {}] },
  { name: 'scheduleUpdate', parameters: [{}, {}] },
  { name: 'cancelUpdate', parameters: [] },
];
// The generation deployed on 2026-10-04: immediate gate, fee views, no index-lock getters.
const LIVE_GENERATION_METHODS = [
  { name: 'update', parameters: [{}, {}] },
  getter('accruedRequestFees'),
  getter('reservedRequestFees'),
  getter('withdrawableFees'),
  getter('getMiniAppCount'),
  getter('getTotalRequests'),
  { name: 'getMiniAppIdByIndex', parameters: [{}], returntype: 'String', safe: true },
  { name: 'getMiniApp', parameters: [{}], returntype: 'Array', safe: true },
  { name: 'rebuildIndexes', parameters: [{}, {}] },
];
// The generation that replaces it: timelocked gate plus the index-lock getters.
const FIXED_GENERATION_METHODS = [
  ...LIVE_GENERATION_METHODS,
  { name: 'scheduleUpdate', parameters: [{}, {}] },
  { name: 'cancelUpdate', parameters: [] },
  getter('isIndexRebuildRequired', 'Boolean'),
  getter('indexRebuildCursor'),
];
const LOCAL_NEF_SCRIPT = '0c0a6e6577206b65726e656c' + '40';
const DEPLOYED_NEF_SCRIPT = '0c0474657374' + '40';

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

// A manifest as neo-go serves it versus as a C# node serves it: the same content in another key
// order (read from the two node kinds on 2026-10-04: neo-go starts name, abi, features; C# starts
// name, groups, features, supportedstandards, abi; and each orders a method's members differently).
function manifestInServingOrder(order, methods) {
  const member = (method, offsetFirst) =>
    offsetFirst
      ? {
          name: method.name,
          offset: 0,
          parameters: method.parameters,
          returntype: method.returntype || 'Void',
          safe: method.safe ?? false,
        }
      : {
          name: method.name,
          parameters: method.parameters,
          returntype: method.returntype || 'Void',
          offset: 0,
          safe: method.safe ?? false,
        };
  const extra = { Description: 'oracle <kernel> & feeds' };
  return order === 'neo-go'
    ? {
        name: 'MorpheusOracle',
        abi: { methods: methods.map((method) => member(method, true)), events: [] },
        features: {},
        groups: [],
        permissions: [{ contract: '*', methods: '*' }],
        supportedstandards: [],
        trusts: [],
        extra,
      }
    : {
        name: 'MorpheusOracle',
        groups: [],
        features: {},
        supportedstandards: [],
        abi: { methods: methods.map((method) => member(method, false)), events: [] },
        permissions: [{ contract: '*', methods: '*' }],
        trusts: [],
        extra,
      };
}

function storageIntegerBase64(value) {
  const time = Buffer.alloc(8);
  time.writeBigInt64LE(BigInt(value));
  // Neo trims a storage integer to its minimal two-complement width; keep 6 bytes here.
  return time.subarray(0, 6).toString('base64');
}

// The script of a transaction built by neon's emitAppCall is "... PUSHDATA1 <method> PUSHDATA1
// <hash> SYSCALL": find which kernel method it calls.
function methodOfScript(scriptHex, candidates) {
  const script = Buffer.from(scriptHex, 'hex');
  for (const name of candidates) {
    const framed = Buffer.concat([Buffer.from([0x0c, name.length]), Buffer.from(name, 'ascii')]);
    const at = script.indexOf(framed);
    if (at >= 0 && script[at + framed.length] === 0x0c && script[at + framed.length + 1] === 0x14) {
      return name;
    }
  }
  return null;
}

const STATE_CHANGING = ['update', 'scheduleUpdate', 'cancelUpdate', 'rebuildIndexes'];

// A JSON-RPC stub of one kernel on one chain. It answers what a real node answers to the
// planner, and applies the state transition of each state-changing method once a signed
// transaction arrives through sendrawtransaction. `handle.target` is what a confirmed update
// installs and `handle.scheduleHashHex` what a confirmed scheduleUpdate records.
async function startRpcStub({
  methods,
  pending = null,
  chainTimeMs = 1_000_000,
  absentStorage = 'error', // 'error' = what neo-go and C# answer; 'null' = older nodes
  storageError = null, // answer every getstorage with this JSON-RPC error instead
  magic = TESTNET_MAGIC,
  updatecounter = 1,
  nefScriptHex = DEPLOYED_NEF_SCRIPT,
  manifestOrder = null, // serve the manifest in 'neo-go' or 'csharp' key order
  stateBody = null, // (result) => the exact response body text for getcontractstate
  apps = [],
  lock = { required: false, cursor: 0 },
  callbackIndex = new Map(), // callback hash160 hex (big-endian) -> appId
  fees = { accruedRequestFees: '7000000', reservedRequestFees: '0', withdrawableFees: '7000000' },
  simulatedGas = '10000000',
  txOutcome = 'HALT',
}) {
  const calls = [];
  const sent = [];
  const executions = new Map();
  const storage = new Map();
  if (pending) {
    storage.set('MQ==', pending.timeBase64);
    storage.set('Mg==', pending.hashBase64);
  }
  const contract = {
    updatecounter,
    nef: rpcNef(nefOf(nefScriptHex)),
    manifest: manifestOrder
      ? manifestInServingOrder(manifestOrder, methods)
      : { name: 'MorpheusOracle', abi: { methods, events: [] } },
  };
  const lockState = { ...lock };
  let lastRebuildPreview = null;
  const hasMethod = (name, arity) =>
    contract.manifest.abi.methods.some(
      (method) => method.name === name && method.parameters.length === arity
    );
  const handle = {
    calls,
    sent,
    contract,
    lock: lockState,
    storage,
    target: null,
    scheduleHashHex: null,
    lastStateBody: null,
  };

  const faultMissingMethod = (name, arity) => ({
    state: 'FAULT',
    gasconsumed: '0',
    exception: `Method "${name}" with ${arity} parameter(s) doesn't exist in the contract ${ORACLE}.`,
    stack: [],
  });

  const server = http.createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => (raw += chunk));
    request.on('end', () => {
      const { id, method, params } = JSON.parse(raw);
      calls.push({ method, params });
      const send = (body) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(body);
      };
      const reply = (result) => send(JSON.stringify({ id, jsonrpc: '2.0', result }));
      const fail = (error) => send(JSON.stringify({ id, jsonrpc: '2.0', error }));
      const halt = (item) => reply({ state: 'HALT', gasconsumed: '1000000', stack: [item] });
      const integer = (value) => halt({ type: 'Integer', value: String(value) });
      switch (method) {
        case 'getversion':
          return reply({
            tcpport: 20333,
            useragent: '/Neo:3.10.1/',
            protocol: { network: magic, addressversion: 53, msperblock: 3000 },
          });
        case 'getcontractstate': {
          const result = {
            id: 7,
            updatecounter: contract.updatecounter,
            hash: ORACLE,
            nef: contract.nef,
            manifest: contract.manifest,
          };
          if (!stateBody) return reply(result);
          handle.lastStateBody = stateBody(result);
          return send(handle.lastStateBody);
        }
        case 'getstorage': {
          if (storageError) return fail(storageError);
          const stored = storage.get(params[1]);
          if (stored !== undefined) return reply(stored);
          return absentStorage === 'null' ? reply(null) : fail(ABSENT_STORAGE_ERROR);
        }
        case 'getblockcount':
          return reply(100);
        case 'getblockheader':
          return reply({ index: params[0], time: chainTimeMs });
        case 'invokescript':
          return reply({ state: 'HALT', gasconsumed: simulatedGas, stack: [] });
        case 'calculatenetworkfee':
          return reply({ networkfee: '1000000' });
        case 'sendrawtransaction': {
          const transaction = tx.Transaction.deserialize(
            Buffer.from(params[0], 'base64').toString('hex')
          );
          const called = methodOfScript(transaction.script.toString(), STATE_CHANGING);
          const txid = `0x${transaction.hash()}`;
          sent.push({
            txid,
            method: called,
            systemFee: BigInt(transaction.systemFee.toString()),
            networkFee: BigInt(transaction.networkFee.toString()),
            signedBy: wallet.getScriptHashFromVerificationScript(
              transaction.witnesses[0].verificationScript.toString()
            ),
          });
          if (txOutcome !== 'HALT') {
            executions.set(txid, { vmstate: 'FAULT', exception: 'stub: execution failed' });
            return reply({ hash: txid });
          }
          executions.set(txid, { vmstate: 'HALT', exception: null });
          if (called === 'update' && handle.target) {
            contract.updatecounter += 1;
            contract.nef = rpcNef(nefOf(handle.target.nefScriptHex));
            contract.manifest = handle.target.manifest;
            storage.delete('MQ==');
            storage.delete('Mg==');
            if (hasMethod('isIndexRebuildRequired', 0)) {
              Object.assign(lockState, { required: apps.length > 0, cursor: 0 });
            }
          } else if (called === 'scheduleUpdate') {
            storage.set('MQ==', storageIntegerBase64(chainTimeMs + 86_400_000));
            storage.set('Mg==', Buffer.from(handle.scheduleHashHex, 'hex').toString('base64'));
          } else if (called === 'cancelUpdate') {
            storage.delete('MQ==');
            storage.delete('Mg==');
          } else if (called === 'rebuildIndexes' && lastRebuildPreview) {
            lockState.cursor = lastRebuildPreview.start + lastRebuildPreview.count;
            lockState.required = lockState.cursor < apps.length;
          }
          return reply({ hash: txid });
        }
        case 'getapplicationlog': {
          const execution = executions.get(params[0]);
          if (!execution) return fail({ code: -100, message: 'Unknown transaction' });
          return reply({ txid: params[0], executions: [{ trigger: 'Application', ...execution }] });
        }
        case 'invokefunction': {
          const [contractHash, called, args] = params;
          if (contractHash.replace(/^0x/, '') === GAS_HASH.slice(2)) {
            return called === 'decimals' ? integer(8) : integer('5000000000');
          }
          if (called === 'admin' || called === 'updater') return halt(hash160Item(ADMIN));
          if (called === 'getMiniAppCount') return integer(apps.length);
          if (called === 'getMiniAppIdByIndex') {
            const app = apps[Number(args[0].value)];
            return halt({ type: 'ByteString', value: Buffer.from(app.appId).toString('base64') });
          }
          if (called === 'getMiniApp') {
            const app = apps.find((entry) => entry.appId === args[0].value);
            return halt({
              type: 'Array',
              value: [
                { type: 'ByteString', value: Buffer.from(app.appId).toString('base64') },
                hash160Item(ADMIN),
                { type: 'Integer', value: '0' },
                hash160Item(new wallet.Account(app.callbackKey)),
                { type: 'Integer', value: '0' },
                { type: 'Integer', value: '0' },
                { type: 'Integer', value: '0' },
                { type: 'Integer', value: String(app.createdAt ?? 1791117227420) },
              ],
            });
          }
          if (called in fees || called === 'getTotalRequests') {
            if (!hasMethod(called, 0)) return reply(faultMissingMethod(called, 0));
            return integer(fees[called] ?? '7');
          }
          if (called === 'indexRebuildCursor') {
            if (!hasMethod(called, 0)) return reply(faultMissingMethod(called, 0));
            return integer(lockState.cursor);
          }
          if (called === 'isIndexRebuildRequired') {
            if (!hasMethod(called, 0)) return reply(faultMissingMethod(called, 0));
            return halt({ type: 'Boolean', value: lockState.required });
          }
          // Test invocation of a state-changing method: the node runs it in a throwaway VM.
          if (called === 'rebuildIndexes') {
            lastRebuildPreview = { start: Number(args[0].value), count: Number(args[1].value) };
          }
          if (called === 'update' && pending && chainTimeMs < pending.executeAfterMs) {
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

  // The callback index the kernel keeps (prefix 0x27, key = callback hash160 little-endian).
  for (const [callbackHex, appId] of callbackIndex) {
    const key = Buffer.concat([Buffer.from([0x27]), Buffer.from(callbackHex, 'hex').reverse()]);
    storage.set(key.toString('base64'), Buffer.from(appId).toString('base64'));
  }

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return Object.assign(handle, {
    url: `http://127.0.0.1:${port}`,
    close: () => server.close(),
  });
}

async function writeLocalArtifact(
  dir,
  { methods = [], nefScriptHex = LOCAL_NEF_SCRIPT, name = 'MorpheusOracle' } = {}
) {
  const nef = nefOf(nefScriptHex);
  const nefBytes = Buffer.from(nef.serialize(), 'hex');
  const manifest = { name, abi: { methods, events: [] } };
  const manifestText = JSON.stringify(manifest);
  const nefPath = path.join(dir, `${name}.nef`);
  const manifestPath = path.join(dir, `${name}.manifest.json`);
  await fs.writeFile(nefPath, nefBytes);
  await fs.writeFile(manifestPath, manifestText);
  return {
    nefPath,
    manifestPath,
    nefBytes,
    manifestText,
    artifactHash: computeUpgradeArtifactHash(nefBytes, manifestText),
    // What a confirmed update installs on the stub chain.
    installs: { nefScriptHex, manifest },
  };
}

function runTool(
  rpcUrl,
  artifact,
  archiveDir,
  { extraArgs = [], env = {}, network = 'testnet', script = SCRIPT, cwd = ROOT } = {}
) {
  const rpcUrls = Array.isArray(rpcUrl) ? rpcUrl : rpcUrl ? [rpcUrl] : [];
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        script,
        '--network',
        network,
        ...rpcUrls.flatMap((url) => ['--rpc', url]),
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
        cwd,
        env: {
          ...process.env,
          MORPHEUS_NETWORK: network,
          NEO_NETWORK_MAGIC: String(network === 'mainnet' ? MAINNET_MAGIC : TESTNET_MAGIC),
          NEO_RPC_URL: '',
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

const APPLY = { UPGRADE_APPLY: '1', MORPHEUS_ORACLE_ADMIN_WIF: ADMIN.WIF };

// The artifact is written first so a stub option can depend on its hash (a schedule for it).
async function withFixture(stubOptions, fn, artifactOptions) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oracle-upgrade-test-'));
  let stub;
  try {
    const artifact = await writeLocalArtifact(dir, artifactOptions);
    stub = await startRpcStub(
      typeof stubOptions === 'function' ? stubOptions(artifact) : stubOptions
    );
    await fn({ stub, artifact, archiveDir: path.join(dir, 'archive'), dir });
  } finally {
    stub?.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function pendingFor(artifactHash, executeAfterMs) {
  return {
    executeAfterMs,
    timeBase64: storageIntegerBase64(executeAfterMs),
    hashBase64: Buffer.from(artifactHash, 'hex').toString('base64'),
  };
}

async function readRollbackRecord(archiveDir) {
  const archived = await fs.readdir(archiveDir);
  const rollback = archived.find((name) => name.endsWith('.rollback.json'));
  assert.ok(rollback, `no rollback record in ${archived.join(', ')}`);
  return {
    record: JSON.parse(await fs.readFile(path.join(archiveDir, rollback), 'utf8')),
    names: archived,
  };
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

    const { record } = await readRollbackRecord(archiveDir);
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

test('a matching schedule inside the timelock is a wait, and apply refuses to send early', async () => {
  await withFixture(
    (artifact) => ({
      methods: TIMELOCKED_METHODS,
      pending: pendingFor(artifact.artifactHash, 2_000_000),
      chainTimeMs: 1_000_000,
    }),
    async ({ stub, artifact, archiveDir }) => {
      const dryRun = await runTool(stub.url, artifact, archiveDir);
      assert.equal(dryRun.status, 0, dryRun.stderr);
      const report = planOf(dryRun.stdout);
      assert.equal(report.plan.action, 'wait');
      assert.equal(report.plan.remainingMs, '1000000');
      assert.match(dryRun.stdout, /timelock running/);

      const applied = await runTool(stub.url, artifact, archiveDir, { env: APPLY });
      assert.notEqual(applied.status, 0);
      assert.match(applied.stderr, /still timelocked/);
      assert.ok(!stub.calls.some((call) => call.method === 'sendrawtransaction'));
    }
  );
});

test('a matching schedule past the timelock plans the update', async () => {
  await withFixture(
    (artifact) => ({
      methods: TIMELOCKED_METHODS,
      pending: pendingFor(artifact.artifactHash, 2_000_000),
      chainTimeMs: 2_000_000,
    }),
    async ({ stub, artifact, archiveDir }) => {
      const result = await runTool(stub.url, artifact, archiveDir);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(planOf(result.stdout).plan.action, 'execute');
      assert.ok(invokedMethods(stub.calls).includes('update'));
    }
  );
});

test('a different scheduled artifact is refused unless it is cancelled or replaced', async () => {
  await withFixture(
    {
      methods: TIMELOCKED_METHODS,
      pending: pendingFor('c'.repeat(64), 2_000_000),
      chainTimeMs: 3_000_000,
    },
    async ({ stub, artifact, archiveDir }) => {
      const refused = await runTool(stub.url, artifact, archiveDir);
      assert.equal(refused.status, 1);
      assert.match(refused.stderr, /different artifact is scheduled/);

      const cancel = await runTool(stub.url, artifact, archiveDir, { extraArgs: ['--cancel'] });
      assert.equal(cancel.status, 0, cancel.stderr);
      assert.equal(planOf(cancel.stdout).plan.action, 'cancel');
      assert.ok(invokedMethods(stub.calls).includes('cancelUpdate'));
    }
  );
});

// --- D1: getstorage of an absent key is a JSON-RPC error on real nodes -------------------------

test('absent storage keys are the JSON-RPC error -104 on real nodes and a timelocked dry run still plans', async () => {
  // neo-go 0.121/0.123 (both public mainnet nodes) and C# Neo 3.10.1 answer getstorage for a key
  // that is not stored with {"code":-104,"message":"Unknown storage item"}, not with null.
  await withFixture({ methods: TIMELOCKED_METHODS }, async ({ stub, artifact, archiveDir }) => {
    const result = await runTool(stub.url, artifact, archiveDir);
    assert.equal(result.status, 0, result.stderr);
    const report = planOf(result.stdout);
    assert.equal(report.pending_upgrade.scheduled, false);
    assert.equal(report.plan.action, 'schedule');
    const reads = stub.calls.filter((call) => call.method === 'getstorage');
    assert.equal(reads.length, 2, 'the time key and the hash key are both read');
  });
});

test('a node that answers null for an absent key is still accepted', async () => {
  await withFixture(
    { methods: TIMELOCKED_METHODS, absentStorage: 'null' },
    async ({ stub, artifact, archiveDir }) => {
      const result = await runTool(stub.url, artifact, archiveDir);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(planOf(result.stdout).pending_upgrade.scheduled, false);
    }
  );
});

test('a getstorage error that is not "absent key" is not swallowed', async () => {
  await withFixture(
    { methods: TIMELOCKED_METHODS, storageError: { code: -102, message: 'Unknown contract' } },
    async ({ stub, artifact, archiveDir }) => {
      const result = await runTool(stub.url, artifact, archiveDir);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Unknown contract/);
    }
  );
});

test('--cancel with nothing scheduled is a plain refusal, not an RPC crash', async () => {
  await withFixture({ methods: TIMELOCKED_METHODS }, async ({ stub, artifact, archiveDir }) => {
    const result = await runTool(stub.url, artifact, archiveDir, { extraArgs: ['--cancel'] });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no upgrade is scheduled/);
    assert.doesNotMatch(result.stderr, /RPC error/);
  });
});

// --- The apply paths: sendrawtransaction, confirmation, verification, rebuild ------------------

const TWO_APPS = [
  { appId: 'vrf-e2e', callbackKey: '5'.repeat(64) },
  { appId: 'http-e2e', callbackKey: '6'.repeat(64) },
];
const callbackOf = (app) => new wallet.Account(app.callbackKey).scriptHash;

function verificationOf(stdout) {
  const label = 'post-update verification: ';
  return JSON.parse(stdout.slice(stdout.indexOf(label) + label.length));
}

test('apply: an update on the immediate gate is sent once, confirmed, and its lock getters are decoded', async () => {
  await withFixture(
    { methods: LIVE_GENERATION_METHODS, apps: TWO_APPS },
    async ({ stub, artifact, archiveDir }) => {
      stub.target = artifact.installs;
      const result = await runTool(stub.url, artifact, archiveDir, { env: APPLY });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(
        stub.sent.map((sent) => sent.method),
        ['update']
      );
      assert.equal(stub.sent[0].signedBy, ADMIN.scriptHash);
      assert.match(result.stdout, /update confirmed: updatecounter=2/);
      const verification = verificationOf(result.stdout);
      // The new ABI's getter answers a Boolean: it must read true, not "null".
      assert.equal(verification.isIndexRebuildRequired, true);
      assert.equal(verification.indexRebuildCursor, '0');
      assert.equal(verification.accruedRequestFees, '7000000');
      assert.equal(verification.getMiniAppCount, '2');
      assert.equal(verification.getMiniApp.appId, 'vrf-e2e');
    },
    { methods: FIXED_GENERATION_METHODS }
  );
});

test('apply: a rollback to an ABI without the lock getters reads only what that ABI has and exits 0', async () => {
  await withFixture(
    (artifact) => ({
      methods: FIXED_GENERATION_METHODS,
      apps: [TWO_APPS[0]],
      pending: pendingFor(artifact.artifactHash, 2_000_000),
      chainTimeMs: 2_000_000,
      updatecounter: 2,
    }),
    async ({ stub, artifact, archiveDir }) => {
      stub.target = artifact.installs;
      const result = await runTool(stub.url, artifact, archiveDir, { env: APPLY });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(planOf(result.stdout).plan.action, 'execute');
      assert.deepEqual(
        stub.sent.map((sent) => sent.method),
        ['update']
      );
      assert.match(result.stdout, /update confirmed: updatecounter=3/);
      const verification = verificationOf(result.stdout);
      assert.equal(verification.accruedRequestFees, '7000000');
      assert.equal('isIndexRebuildRequired' in verification, false);
      assert.equal('indexRebuildCursor' in verification, false);
      assert.deepEqual(verification.not_in_target_abi, [
        'isIndexRebuildRequired',
        'indexRebuildCursor',
      ]);
      // No getter the old ABI lacks was ever asked for.
      const afterUpdate = stub.calls.slice(
        stub.calls.findIndex((call) => call.method === 'sendrawtransaction')
      );
      assert.ok(!invokedMethods(afterUpdate).includes('isIndexRebuildRequired'));
      assert.ok(!invokedMethods(afterUpdate).includes('indexRebuildCursor'));
    },
    { methods: LIVE_GENERATION_METHODS }
  );
});

test('apply: scheduleUpdate is sent and the schedule is read back', async () => {
  await withFixture(
    { methods: FIXED_GENERATION_METHODS, updatecounter: 2 },
    async ({ stub, artifact, archiveDir }) => {
      stub.scheduleHashHex = artifact.artifactHash;
      const result = await runTool(stub.url, artifact, archiveDir, { env: APPLY });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(planOf(result.stdout).plan.action, 'schedule');
      assert.deepEqual(
        stub.sent.map((sent) => sent.method),
        ['scheduleUpdate']
      );
      assert.match(
        result.stdout,
        new RegExp(`upgrade scheduled: artifact ${artifact.artifactHash}`)
      );
    },
    { methods: LIVE_GENERATION_METHODS }
  );
});

test('apply: cancelUpdate clears the schedule and the read-back of the now-absent keys succeeds', async () => {
  await withFixture(
    {
      methods: FIXED_GENERATION_METHODS,
      updatecounter: 2,
      pending: pendingFor('c'.repeat(64), 2_000_000),
      chainTimeMs: 3_000_000,
    },
    async ({ stub, artifact, archiveDir }) => {
      const result = await runTool(stub.url, artifact, archiveDir, {
        env: APPLY,
        extraArgs: ['--cancel'],
      });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(
        stub.sent.map((sent) => sent.method),
        ['cancelUpdate']
      );
      assert.match(result.stdout, /scheduled upgrade cancelled/);
    }
  );
});

test('apply: a transaction that executes with FAULT aborts the run', async () => {
  await withFixture(
    { methods: LIVE_GENERATION_METHODS, txOutcome: 'FAULT' },
    async ({ stub, artifact, archiveDir }) => {
      stub.target = artifact.installs;
      const result = await runTool(stub.url, artifact, archiveDir, { env: APPLY });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /executed with FAULT: stub: execution failed/);
      assert.doesNotMatch(result.stdout, /update confirmed/);
      assert.equal(stub.sent.length, 1);
    },
    { methods: FIXED_GENERATION_METHODS }
  );
});

test('apply: the index backfill runs in chunks, clears the lock and verifies the callback index', async () => {
  await withFixture(
    {
      methods: FIXED_GENERATION_METHODS,
      updatecounter: 2,
      nefScriptHex: LOCAL_NEF_SCRIPT,
      apps: TWO_APPS,
      lock: { required: true, cursor: 0 },
      callbackIndex: new Map(TWO_APPS.map((app) => [callbackOf(app), app.appId])),
    },
    async ({ stub, artifact, archiveDir }) => {
      const result = await runTool(stub.url, artifact, archiveDir, {
        env: { REBUILD_APPLY: '1', MORPHEUS_ORACLE_ADMIN_WIF: ADMIN.WIF },
        extraArgs: ['--batch-size', '1'],
      });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(
        stub.sent.map((sent) => sent.method),
        ['rebuildIndexes', 'rebuildIndexes']
      );
      assert.match(result.stdout, /resuming required index rebuild at cursor 0\/2/);
      assert.match(result.stdout, /rebuildIndexes\(0, 1\) tx: /);
      assert.match(result.stdout, /rebuildIndexes\(1, 1\) tx: /);
      assert.match(result.stdout, /rebuild verified: 2 callback mapping\(s\) correct/);
      // A rebuild-only run sends a transaction: the report must not call itself a dry run.
      assert.doesNotMatch(planOf(result.stdout).mode, /DRY RUN/);
      assert.equal(stub.lock.required, false);
    },
    { methods: FIXED_GENERATION_METHODS, nefScriptHex: LOCAL_NEF_SCRIPT }
  );
});

test('apply: a missing callback index entry fails the backfill check by name, not as an RPC crash', async () => {
  await withFixture(
    {
      methods: LIVE_GENERATION_METHODS,
      apps: TWO_APPS,
      // the second app's mapping was never written
      callbackIndex: new Map([[callbackOf(TWO_APPS[0]), TWO_APPS[0].appId]]),
    },
    async ({ stub, artifact, archiveDir }) => {
      const result = await runTool(stub.url, artifact, archiveDir, {
        env: { REBUILD_APPLY: '1', MORPHEUS_ORACLE_ADMIN_WIF: ADMIN.WIF },
      });
      assert.equal(result.status, 1);
      assert.match(
        result.stderr,
        /callback index mismatch for 0x[0-9a-f]{40}: expected 'http-e2e'/
      );
      assert.match(result.stderr, /found 'null'/);
      assert.doesNotMatch(result.stderr, /RPC error/);
    },
    { methods: LIVE_GENERATION_METHODS, nefScriptHex: LOCAL_NEF_SCRIPT }
  );
});

// --- D3: the RPC endpoint is an explicit, cross-checked choice ---------------------------------

test('two RPC endpoints that agree on the deployed kernel are accepted, and only the first receives transactions', async () => {
  await withFixture(
    { methods: LIVE_GENERATION_METHODS, apps: TWO_APPS },
    async ({ stub, artifact, archiveDir }) => {
      const peer = await startRpcStub({ methods: LIVE_GENERATION_METHODS, apps: TWO_APPS });
      try {
        stub.target = artifact.installs;
        const result = await runTool([stub.url, peer.url], artifact, archiveDir, { env: APPLY });
        assert.equal(result.status, 0, result.stderr);
        const report = planOf(result.stdout);
        assert.equal(report.rpc, stub.url);
        assert.deepEqual(report.rpc_peers, [peer.url]);
        assert.equal(report.rpc_agreement.endpoints, 2);
        assert.equal(report.rpc_agreement.updatecounter, 1);
        assert.ok(peer.calls.some((call) => call.method === 'getcontractstate'));
        assert.equal(stub.sent.length, 1);
        assert.equal(peer.sent.length, 0, 'the peer is a read-only cross-check');
      } finally {
        peer.close();
      }
    },
    { methods: FIXED_GENERATION_METHODS }
  );
});

test('RPC endpoints that disagree about the deployed kernel stop the run before anything is planned', async () => {
  await withFixture(
    { methods: LIVE_GENERATION_METHODS },
    async ({ stub, artifact, archiveDir }) => {
      for (const lagging of [{ updatecounter: 2 }, { nefScriptHex: LOCAL_NEF_SCRIPT }]) {
        const peer = await startRpcStub({ methods: LIVE_GENERATION_METHODS, ...lagging });
        try {
          const result = await runTool([stub.url, peer.url], artifact, archiveDir);
          assert.equal(result.status, 1);
          assert.match(result.stderr, /disagree about the deployed MorpheusOracle/);
          assert.equal(result.stdout, '', 'nothing is planned or printed');
          assert.deepEqual(invokedMethods(stub.calls), [], 'no kernel method was invoked');
          await assert.rejects(fs.access(archiveDir), 'nothing is archived');
        } finally {
          peer.close();
        }
      }
    }
  );
});

test('an endpoint that is on another network than --network is refused', async () => {
  await withFixture(
    { methods: LIVE_GENERATION_METHODS, magic: MAINNET_MAGIC },
    async ({ stub, artifact, archiveDir }) => {
      const result = await runTool(stub.url, artifact, archiveDir);
      assert.equal(result.status, 1);
      assert.match(result.stderr, new RegExp(`network magic ${MAINNET_MAGIC}.*${TESTNET_MAGIC}`));
      assert.deepEqual(invokedMethods(stub.calls), []);
    }
  );
});

test('a mainnet apply needs --rpc on the command line: the environment alone is refused before any RPC call', async () => {
  await withFixture(
    { methods: LIVE_GENERATION_METHODS, magic: MAINNET_MAGIC },
    async ({ stub, artifact, archiveDir }) => {
      const result = await runTool(null, artifact, archiveDir, {
        network: 'mainnet',
        env: { ...APPLY, NEO_RPC_URL: stub.url },
      });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /mainnet apply requires an explicit --rpc/);
      assert.deepEqual(stub.calls, [], 'no RPC call was made');
      assert.deepEqual(stub.sent, []);
    }
  );
});

test('a single mainnet endpoint is allowed but flagged as not cross-checked', async () => {
  await withFixture(
    { methods: LIVE_GENERATION_METHODS, magic: MAINNET_MAGIC },
    async ({ stub, artifact, archiveDir }) => {
      const result = await runTool(stub.url, artifact, archiveDir, { network: 'mainnet' });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stderr, /single RPC endpoint.*not cross-checked/);
      assert.equal(planOf(result.stdout).rpc_agreement.endpoints, 1);
    }
  );
});

// --- D4: nothing is loaded from the checkout unless it is named ---------------------------------

// A populated checkout: the planner script is a real file (its import.meta.url decides where the
// deploy/nitro env file is looked up), its libraries are linked, and the working directory holds a
// .env. Both env files carry values that would redirect an unaware run.
async function makeCheckoutMirror(dir, { dotEnv, nitroEnv }) {
  const scriptsDir = path.join(dir, 'scripts');
  await fs.mkdir(scriptsDir, { recursive: true });
  await fs.copyFile(SCRIPT, path.join(scriptsDir, 'upgrade-morpheus-oracle.mjs'));
  for (const name of await fs.readdir(path.join(ROOT, 'scripts'))) {
    if (/^lib-.*\.mjs$/.test(name) && !name.endsWith('.test.mjs')) {
      await fs.symlink(path.join(ROOT, 'scripts', name), path.join(scriptsDir, name));
    }
  }
  await fs.symlink(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'));
  await fs.mkdir(path.join(dir, 'config'), { recursive: true });
  await fs.symlink(path.join(ROOT, 'config', 'networks'), path.join(dir, 'config', 'networks'));
  await fs.mkdir(path.join(dir, 'deploy', 'nitro'), { recursive: true });
  await fs.writeFile(path.join(dir, '.env'), dotEnv);
  await fs.writeFile(path.join(dir, 'deploy', 'nitro', 'morpheus.testnet.env'), nitroEnv);
  return { script: path.join(scriptsDir, 'upgrade-morpheus-oracle.mjs'), cwd: dir };
}

test('a populated checkout cannot change the magic: deploy/nitro/morpheus.<net>.env is not loaded implicitly', async () => {
  await withFixture(
    { methods: LIVE_GENERATION_METHODS },
    async ({ stub, artifact, archiveDir, dir }) => {
      const mirror = await makeCheckoutMirror(path.join(dir, 'checkout'), {
        dotEnv: '',
        // the nitro file is loaded with override, so it used to win over the real environment
        nitroEnv: 'NEO_NETWORK_MAGIC=1\n',
      });
      const result = await runTool(stub.url, artifact, archiveDir, mirror);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(planOf(result.stdout).plan.action, 'update');
    }
  );
});

test('a populated checkout cannot supply the signer: ./.env is not loaded implicitly', async () => {
  await withFixture(
    (artifact) => ({
      methods: TIMELOCKED_METHODS,
      pending: pendingFor(artifact.artifactHash, 2_000_000),
      chainTimeMs: 1_000_000,
    }),
    async ({ stub, artifact, archiveDir, dir }) => {
      const mirror = await makeCheckoutMirror(path.join(dir, 'checkout'), {
        dotEnv: `MORPHEUS_ORACLE_ADMIN_WIF=${ADMIN.WIF}\n`,
        nitroEnv: '',
      });
      const result = await runTool(stub.url, artifact, archiveDir, {
        ...mirror,
        env: { UPGRADE_APPLY: '1' },
      });
      assert.equal(result.status, 1);
      // Without the .env key the run stops at the signer, before it could reach the timelock check.
      assert.doesNotMatch(result.stderr, /still timelocked/);
      assert.match(result.stderr, /MORPHEUS_ORACLE_ADMIN_WIF|updater/);
      assert.deepEqual(stub.sent, []);
    }
  );
});

test('--env-file loads exactly the named file, and the real environment still wins over it', async () => {
  await withFixture(
    { methods: LIVE_GENERATION_METHODS },
    async ({ stub, artifact, archiveDir, dir }) => {
      const envFile = path.join(dir, 'operator.env');
      await fs.writeFile(envFile, `NEO_RPC_URL=${stub.url}\n`);
      const named = await runTool(null, artifact, archiveDir, {
        extraArgs: ['--env-file', envFile],
      });
      assert.equal(named.status, 0, named.stderr);
      assert.equal(planOf(named.stdout).rpc, stub.url);

      // The same file with an unreachable URL loses against the exported variable.
      await fs.writeFile(envFile, 'NEO_RPC_URL=http://127.0.0.1:9\n');
      const exported = await runTool(null, artifact, archiveDir, {
        extraArgs: ['--env-file', envFile],
        env: { NEO_RPC_URL: stub.url },
      });
      assert.equal(exported.status, 0, exported.stderr);
      assert.equal(planOf(exported.stdout).rpc, stub.url);

      // Of two files the later one wins, like Node's own --env-file.
      const earlier = path.join(dir, 'earlier.env');
      await fs.writeFile(earlier, 'NEO_RPC_URL=http://127.0.0.1:9\n');
      await fs.writeFile(envFile, `NEO_RPC_URL=${stub.url}\n`);
      const ordered = await runTool(null, artifact, archiveDir, {
        extraArgs: ['--env-file', earlier, '--env-file', envFile],
      });
      assert.equal(ordered.status, 0, ordered.stderr);
      assert.equal(planOf(ordered.stdout).rpc, stub.url);
    }
  );
});

// Node itself recognises --env-file anywhere on the command line and loads the file before this
// script starts (a missing file ends the process with "node: <path>: not found", exit 9); the
// planner's own loader gives the same answer when Node does not. Either way a typo is never a
// silent no-op.
test('a --env-file that does not exist is an error, not a silent no-op', async () => {
  await withFixture(
    { methods: LIVE_GENERATION_METHODS },
    async ({ stub, artifact, archiveDir, dir }) => {
      const result = await runTool(stub.url, artifact, archiveDir, {
        extraArgs: ['--env-file', path.join(dir, 'missing.env')],
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /missing\.env/);
      assert.deepEqual(stub.calls, []);
    }
  );
});

// --- D5: the dry run's preview is a node-side simulation, and it can be skipped -----------------

test('the dry run says plainly that the preview is a node-side simulation and not a transaction', async () => {
  await withFixture({ methods: IMMEDIATE_METHODS }, async ({ stub, artifact, archiveDir }) => {
    const result = await runTool(stub.url, artifact, archiveDir);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /node-side simulation/);
    assert.match(result.stdout, /not a transaction/);
    assert.match(result.stdout, /--skip-simulation/);
    assert.match(result.stdout, /update preview: state=HALT gasconsumed=12345678/);
    assert.equal(planOf(result.stdout).preview_simulation, true);
  });
});

test('--skip-simulation never asks the node to simulate a state-changing method', async () => {
  const stateChanging = ['update', 'scheduleUpdate', 'cancelUpdate', 'rebuildIndexes'];
  // a plain update, a schedule, a running timelock (the early-update preview) and a cancel
  const scenarios = [
    { options: { methods: IMMEDIATE_METHODS }, args: [] },
    { options: { methods: TIMELOCKED_METHODS }, args: [] },
    {
      options: (artifact) => ({
        methods: TIMELOCKED_METHODS,
        pending: pendingFor(artifact.artifactHash, 2_000_000),
        chainTimeMs: 1_000_000,
      }),
      args: [],
    },
    {
      options: { methods: TIMELOCKED_METHODS, pending: pendingFor('c'.repeat(64), 2_000_000) },
      args: ['--cancel'],
    },
  ];
  for (const { options, args } of scenarios) {
    await withFixture(options, async ({ stub, artifact, archiveDir }) => {
      const result = await runTool(stub.url, artifact, archiveDir, {
        extraArgs: ['--skip-simulation', ...args],
      });
      assert.equal(result.status, 0, result.stderr);
      const simulated = invokedMethods(stub.calls).filter((name) => stateChanging.includes(name));
      assert.deepEqual(simulated, [], `simulated ${simulated.join(', ')}`);
      assert.match(result.stdout, /simulation skipped \(--skip-simulation\)/);
      assert.equal(planOf(result.stdout).preview_simulation, false);
    });
  }
});

test('--skip-simulation is refused together with an apply, before any RPC call', async () => {
  await withFixture(
    { methods: LIVE_GENERATION_METHODS },
    async ({ stub, artifact, archiveDir }) => {
      for (const env of [APPLY, { REBUILD_APPLY: '1', MORPHEUS_ORACLE_ADMIN_WIF: ADMIN.WIF }]) {
        const result = await runTool(stub.url, artifact, archiveDir, {
          env,
          extraArgs: ['--skip-simulation'],
        });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /--skip-simulation is for dry runs/);
      }
      assert.deepEqual(stub.calls, []);
    }
  );
});

// --- D6: a margin on the simulated system fee --------------------------------------------------

test('apply: the transaction carries the simulated system fee plus a 10 percent margin by default', async () => {
  await withFixture(
    { methods: LIVE_GENERATION_METHODS, simulatedGas: '35706712' },
    async ({ stub, artifact, archiveDir }) => {
      stub.target = artifact.installs;
      const result = await runTool(stub.url, artifact, archiveDir, { env: APPLY });
      assert.equal(result.status, 0, result.stderr);
      // 35706712 + ceil(35706712 * 10 / 100) = 35706712 + 3570672
      assert.equal(stub.sent[0].systemFee, 39277384n);
      assert.match(
        result.stdout,
        /system fee for update: simulated 35706712 \+ 10% margin = 39277384/
      );
    },
    { methods: FIXED_GENERATION_METHODS }
  );
});

test('apply: --system-fee-margin sets the margin, and 0 sends the simulated fee exactly', async () => {
  for (const [margin, expected] of [
    ['0', 10_000_000n],
    ['25', 12_500_000n],
    ['12.5', 11_250_000n],
  ]) {
    await withFixture(
      { methods: LIVE_GENERATION_METHODS, simulatedGas: '10000000' },
      async ({ stub, artifact, archiveDir }) => {
        stub.target = artifact.installs;
        const result = await runTool(stub.url, artifact, archiveDir, {
          env: APPLY,
          extraArgs: ['--system-fee-margin', margin],
        });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(stub.sent[0].systemFee, expected, `margin ${margin}`);
      },
      { methods: FIXED_GENERATION_METHODS }
    );
  }
});

test('the dry run shows the system fee an apply would attach', async () => {
  await withFixture({ methods: IMMEDIATE_METHODS }, async ({ stub, artifact, archiveDir }) => {
    const result = await runTool(stub.url, artifact, archiveDir);
    assert.equal(result.status, 0, result.stderr);
    // the stub's simulated update costs 12345678: with the default margin apply would attach this
    assert.match(
      result.stdout,
      /apply would attach system fee 13580246 \(simulated 12345678 \+ 10% margin\)/
    );
  });
});

test('an invalid --system-fee-margin is refused before any RPC call', async () => {
  await withFixture(
    { methods: LIVE_GENERATION_METHODS },
    async ({ stub, artifact, archiveDir }) => {
      for (const bad of ['abc', '-1', '101', '10%', '1.234', '']) {
        // the = form: parseArgs refuses a value that starts with a dash in the separate form
        const result = await runTool(stub.url, artifact, archiveDir, {
          extraArgs: [`--system-fee-margin=${bad}`],
        });
        assert.equal(result.status, 1, `margin '${bad}'`);
        assert.match(result.stderr, /--system-fee-margin must be a percentage/);
      }
      assert.deepEqual(stub.calls, []);
    }
  );
});

// --- D8 (rollback artifact): the hash must not depend on the node that served the manifest -----

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys(value[key])])
    );
  }
  return value;
}

// neo-go escapes <, > and & in JSON strings; this is what its body looks like on the wire.
const goStyleBody = (result) =>
  `${JSON.stringify({ id: 1, jsonrpc: '2.0', result })
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')}\n`;

test('the rollback artifact hash is the same whichever node, in whichever key order, served the manifest', async () => {
  const archives = {};
  for (const order of ['neo-go', 'csharp']) {
    await withFixture(
      { methods: LIVE_GENERATION_METHODS, manifestOrder: order, stateBody: goStyleBody },
      async ({ stub, artifact, archiveDir }) => {
        const result = await runTool(stub.url, artifact, archiveDir);
        assert.equal(result.status, 0, result.stderr);
        const { record, names } = await readRollbackRecord(archiveDir);
        archives[order] = {
          record,
          names,
          nef: await fs.readFile(record.nef),
          manifest: await fs.readFile(record.manifest, 'utf8'),
          served: await fs.readFile(record.manifest_served, 'utf8'),
          raw: await fs.readFile(record.contractstate_raw),
        };
      }
    );
  }
  const goArchive = archives['neo-go'];
  const csArchive = archives.csharp;
  // the two nodes serve different text for the same manifest ...
  assert.notEqual(goArchive.served, csArchive.served);
  assert.notEqual(goArchive.record.served_artifact_sha256, csArchive.record.served_artifact_sha256);
  // ... and the artifact hash, the files to submit and the NEF do not depend on it
  assert.equal(goArchive.record.artifact_sha256, csArchive.record.artifact_sha256);
  assert.equal(goArchive.manifest, csArchive.manifest);
  assert.ok(goArchive.nef.equals(csArchive.nef));
  const canonical = JSON.stringify(sortKeys(JSON.parse(goArchive.served)));
  assert.equal(goArchive.manifest, canonical);
  assert.equal(
    goArchive.record.artifact_sha256,
    computeUpgradeArtifactHash(goArchive.nef, canonical)
  );
  assert.equal(
    goArchive.record.served_artifact_sha256,
    computeUpgradeArtifactHash(goArchive.nef, goArchive.served)
  );
});

test('the exact bytes the node sent are archived byte for byte', async () => {
  await withFixture(
    { methods: LIVE_GENERATION_METHODS, manifestOrder: 'neo-go', stateBody: goStyleBody },
    async ({ stub, artifact, archiveDir }) => {
      const result = await runTool(stub.url, artifact, archiveDir);
      assert.equal(result.status, 0, result.stderr);
      const { record } = await readRollbackRecord(archiveDir);
      const raw = await fs.readFile(record.contractstate_raw);
      assert.ok(raw.equals(Buffer.from(stub.lastStateBody)), 'the archived body is the sent body');
      // the body carries Go-style \u003c escapes that a parse and re-serialise would lose
      assert.match(raw.toString('utf8'), /oracle \\u003ckernel\\u003e \\u0026 feeds/);
      const served = await fs.readFile(record.manifest_served, 'utf8');
      assert.match(served, /oracle <kernel> & feeds/);
      assert.equal(record.served_by, stub.url);
    }
  );
});

test('a dry run archives the raw response, the served and canonical manifests, the NEF and the rollback record', async () => {
  await withFixture(
    { methods: LIVE_GENERATION_METHODS },
    async ({ stub, artifact, archiveDir }) => {
      const result = await runTool(stub.url, artifact, archiveDir);
      assert.equal(result.status, 0, result.stderr);
      const { record, names } = await readRollbackRecord(archiveDir);
      for (const suffix of [
        '.contractstate.json',
        '.getcontractstate.raw.json',
        '.manifest.json',
        '.manifest.served.json',
        '.nef',
        '.rollback.json',
      ]) {
        assert.ok(
          names.some((name) => name.endsWith(suffix)),
          `archive lacks ${suffix}: ${names.join(', ')}`
        );
      }
      assert.match(record.artifact_form, /canonical manifest/);
      assert.match(record.artifact_sha256, /^[0-9a-f]{64}$/);
      assert.match(record.nef_sha256, /^[0-9a-f]{64}$/);
    }
  );
});
