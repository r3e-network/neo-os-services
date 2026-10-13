// CU-88 end-to-end harness: a MiniApp request goes kernel -> relayer -> host ->
// custody -> kernel on a disposable private N3 chain.
//
// What this proves, in order:
//   1. an unmodified MorpheusOracle kernel deploys to a fresh private chain and
//      accepts a request from a witnessed requester;
//   2. the kernel's fulfillment verifier is live, not vacuous: a corrupt
//      signature is refused while the request is still pending;
//   3. the real `neo-os-relayer` discovers that request on chain, delivers it to
//      the real `enclave_host`, and the host signs its fulfillment digest
//      through the real `signer_service` custody under the pinned
//      oracle_verifier key;
//   4. the relayer pins that returned key identity to the custody key it was
//      configured with before it broadcasts, and submits `fulfillRequest`;
//   5. the kernel verifies the signature and stores the result;
//   6. a second delivery of the same request is refused on chain and leaves the
//      stored request unchanged.
//
// Every process binds loopback. No public RPC, no database, no container, no
// cloud account. Chain state, wallet material and custody state live in a
// temporary directory that is deleted on exit.
//
// Run: node scripts/test-e2e-private-chain.mjs   (from the repository root)
//
// Requires: Rust 1.98, .NET 10, Neo Express 3.10.1, nccs 3.9.1. Source
// scripts/dotnet_env.sh first if `neoxp`/`nccs` report that .NET is missing.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  HarnessError,
  PRIVATE_CHAIN_MAGIC,
  buildCustodyEnv,
  buildHostEnv,
  buildRelayerEnv,
  decodeRequestStack,
  evaluateAcceptance,
  normalizeScriptHash,
  relayerEnvFromDump,
  teardownPlan,
} from './lib-e2e-private-chain.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = join(REPO_ROOT, 'target', 'debug');
const CUSTODY_BIN = join(TARGET, 'signer_service');
const HOST_BIN = join(TARGET, 'enclave_host');
const RELAYER_BIN = join(TARGET, 'neo-os-relayer');
const APP_ID = 'cu88.private';
const MODULE_ID = 'compute.run';
const OPERATION = 'compute_hash';
const PAYLOAD = { function: 'hash.sha256', input: { answer: 88 } };
// One request goes through the relayer; a second stays pending for the
// corrupt-signature control.
const E2E_REQUEST_ID = 1;
const CONTROL_REQUEST_ID = 2;

const children = [];
let scratchRoot = null;

function note(message) {
  process.stdout.write(`${message}\n`);
}

function fail(message) {
  throw new HarnessError(message);
}

// Diagnostics must never carry a credential. Anything that looks like a token or
// a long hex run is replaced before it can reach a terminal or a log.
function redact(text) {
  return String(text ?? '')
    .replace(/[0-9a-f]{32,}/gi, '[redacted]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .slice(-2000);
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
    server.on('error', reject);
  });
}

// Child processes talk loopback only. An operator shell that exports
// HTTP_PROXY/HTTPS_PROXY would otherwise be inherited by every client here.
function childEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const key of [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy',
    'NO_PROXY',
    'no_proxy',
  ]) {
    delete env[key];
  }
  return env;
}

/**
 * Run a command to completion. Never echoes its output unfiltered: wallet and
 * key commands can print material that must not reach a log or an evidence file.
 */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: options.timeout ?? 240_000,
    input: options.input,
    env: options.env ?? childEnv(),
    cwd: options.cwd ?? REPO_ROOT,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) {
    fail(`${command} could not be started: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(
      `${command} ${args.slice(0, 2).join(' ')} exited ${result.status}` +
        (options.label ? ` (${options.label})` : '') +
        `: ${redact(`${result.stderr || ''}\n${result.stdout || ''}`)}`
    );
  }
  return result.stdout ?? '';
}

function start(name, command, args, env) {
  const child = spawn(command, args, {
    env: childEnv(env),
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.name = name;
  children.push(child);
  return child;
}

function stopAll(signal) {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill(signal);
      } catch {
        /* already gone */
      }
    }
  }
}

async function waitUntilReachable(url, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.ok || response.status === 503) {
        return await response.json();
      }
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) {
      fail(`${label} never became reachable at ${url}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function rpcCall(url, method, params = []) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await response.json();
  if (body.error) fail(`${method} failed: ${JSON.stringify(body.error)}`);
  return body.result;
}

async function waitForRpc(url, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const count = await rpcCall(url, 'getblockcount');
      if (typeof count === 'number' && count >= 1) return;
    } catch {
      /* node not up yet */
    }
    if (Date.now() > deadline) fail(`${label} never became reachable at ${url}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

// ---- Neo Express ----------------------------------------------------------

function base58ToScriptHash(address) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let number = 0n;
  for (const character of address) {
    const digit = alphabet.indexOf(character);
    if (digit < 0) fail('the Neo Express wallet address is not base58');
    number = number * 58n + BigInt(digit);
  }
  let hex = number.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  const decoded = Buffer.from(hex.padStart(50, '0'), 'hex');
  const payload = decoded.subarray(0, 21);
  const checksum = decoded.subarray(21, 25);
  const digest = createHash('sha256')
    .update(createHash('sha256').update(payload).digest())
    .digest();
  if (!digest.subarray(0, 4).equals(checksum)) fail('base58 address checksum mismatch');
  if (payload[0] !== 53) fail('not an N3 account address version');
  return `0x${Buffer.from(payload.subarray(1, 21)).reverse().toString('hex')}`;
}

function scriptHashToAddress(scriptHash) {
  const hash = Buffer.from(normalizeScriptHash(scriptHash).slice(2), 'hex');
  const payload = Buffer.concat([Buffer.from([53]), Buffer.from(hash).reverse()]);
  const checksum = createHash('sha256')
    .update(createHash('sha256').update(payload).digest())
    .digest()
    .subarray(0, 4);
  const body = Buffer.concat([payload, checksum]);
  let number = BigInt(`0x${body.toString('hex')}`);
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let out = '';
  while (number > 0n) {
    const digit = Number(number % 58n);
    number /= 58n;
    out = alphabet[digit] + out;
  }
  return out;
}

const stackParam = {
  string: (value) => ({ type: 'String', value }),
  integer: (value) => ({ type: 'Integer', value: String(value) }),
  hash160: (value) => ({ type: 'Hash160', value }),
  bool: (value) => ({ type: 'Boolean', value }),
  bytes: (value) => ({ type: 'ByteArray', value: Buffer.from(value).toString('base64') }),
  publicKey: (value) => ({ type: 'PublicKey', value }),
};

// ---- custody HTTP ---------------------------------------------------------

async function custodyApi(base, token, method, path, body) {
  const response = await fetch(`${base}/signer/api/v1${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail(`custody ${path} returned a non-JSON reply`);
  }
  return { status: response.status, body: parsed };
}

// ---- main -----------------------------------------------------------------

async function main() {
  const neoxp = process.env.NEOXP_PATH ?? 'neoxp';
  const nccs = process.env.NCCS_PATH ?? 'nccs';
  run(neoxp, ['--version'], { label: 'Neo Express must be installed' });
  run(nccs, ['--version'], { label: 'nccs must be installed' });

  note('building the custody, host and relayer binaries...');
  run(
    'cargo',
    [
      'build',
      '--offline',
      '--locked',
      '-p',
      'neo-signer',
      '--bin',
      'signer_service',
      '-p',
      'nitro-enclave-host',
      '--bin',
      'enclave_host',
      '-p',
      'neo-os-relayer',
      '--bin',
      'neo-os-relayer',
    ],
    { timeout: 900_000, label: 'cargo build' }
  );
  for (const [path, name] of [
    [CUSTODY_BIN, 'signer_service'],
    [HOST_BIN, 'enclave_host'],
    [RELAYER_BIN, 'neo-os-relayer'],
  ]) {
    if (!existsSync(path)) fail(`${name} was not produced at ${path}`);
  }

  note('building the unmodified kernel...');
  const buildDir = join(REPO_ROOT, 'contracts', 'build');
  mkdirSync(buildDir, { recursive: true });
  run(nccs, [
    join('contracts', 'MorpheusOracle', 'MorpheusOracle.csproj'),
    '--generate-artifacts',
    'Source',
    '--output',
    buildDir,
  ]);
  const nef = join(buildDir, 'MorpheusOracle.nef');
  if (!existsSync(nef)) fail('the kernel build produced no MorpheusOracle.nef');

  const ports = {
    chainRpc: await freePort(),
    chainTcp: await freePort(),
    custody: await freePort(),
    host: await freePort(),
  };
  const tempParent = existsSync('/private/tmp') ? '/private/tmp' : '/tmp';
  scratchRoot = mkdtempSync(join(tempParent, 'e2e-private-chain-'));
  const chainPath = join(scratchRoot, 'chain.neo-express');
  const custodyData = join(scratchRoot, 'custody');
  mkdirSync(custodyData, { recursive: true });
  const rpcUrl = `http://127.0.0.1:${ports.chainRpc}`;

  process.on('exit', () => stopAll('SIGKILL'));
  process.on('SIGINT', () => process.exit(130));
  process.on('SIGTERM', () => process.exit(143));

  const plan = teardownPlan({
    children: ['neoxp-run', 'signer_service', 'enclave_host'],
    root: scratchRoot,
  });
  if (plan.length !== 4) fail('the teardown plan does not cover every child and the root');

  const xpBase = { HOME: scratchRoot, DOTNET_CLI_HOME: scratchRoot };
  const create = spawnSync(neoxp, ['create', '-o', chainPath], {
    encoding: 'utf8',
    timeout: 180_000,
    env: childEnv(xpBase),
    maxBuffer: 32 * 1024 * 1024,
  });
  if (create.status !== 0) {
    fail(`Neo Express create failed: ${redact(`${create.stderr || ''}\n${create.stdout || ''}`)}`);
  }

  const config = JSON.parse(readFileSync(chainPath, 'utf8'));
  config.magic = PRIVATE_CHAIN_MAGIC;
  const node = config['consensus-nodes'][0];
  node['rpc-port'] = ports.chainRpc;
  node['tcp-port'] = ports.chainTcp;
  writeFileSync(chainPath, JSON.stringify(config));
  const walletName = node.wallet.name;
  const walletAccount = node.wallet.accounts[0];
  const walletPrivateKey = walletAccount['private-key'];
  const walletHash = base58ToScriptHash(walletAccount['script-hash']);
  if (!/^[0-9a-f]{64}$/i.test(walletPrivateKey)) fail('Neo Express wallet has no raw key');

  // Chain setup runs before the node serves RPC. Neo Express commits each
  // offline command into its persistent store, and a running node applies a
  // per-block system-fee policy that refuses a kernel deployment outright, so
  // the deployment has to happen offline. Everything below reaches the same
  // store the node later serves.
  const xp = (...args) => {
    const result = spawnSync(neoxp, [...args, '-i', chainPath], {
      encoding: 'utf8',
      timeout: 180_000,
      env: childEnv(xpBase),
      maxBuffer: 32 * 1024 * 1024,
    });
    if (result.status !== 0) {
      fail(
        `Neo Express ${args.slice(0, 2).join(' ')} exited ${result.status}:` +
          ` ${redact(`${result.stderr || ''}\n${result.stdout || ''}`)}`
      );
    }
    return result.stdout ?? '';
  };
  const invoke = (method, args, read = false) => {
    const file = join(scratchRoot, 'invoke.json');
    writeFileSync(file, JSON.stringify({ contract: kernelHash, operation: method, args }));
    return JSON.parse(
      xp('contract', 'invoke', file, walletName, '--json', ...(read ? ['--results'] : []))
    );
  };
  // A Neo `ECPoint`/`ByteString` stack entry arrives as base64 bytes.
  const readPublicKey = (method) => {
    const result = invoke(method, [], true);
    if (result.state !== 'HALT') fail(`${method} did not halt`);
    const entry = result.stack[0];
    const value = entry?.value;
    if (typeof value !== 'string' || value === '') {
      fail(`${method} returned no public key (stack ${JSON.stringify(result.stack)})`);
    }
    const decoded = Buffer.from(value, 'base64').toString('hex');
    if (decoded.length !== 66) {
      fail(`${method} returned an unexpected stack: ${JSON.stringify(result.stack)}`);
    }
    return decoded;
  };

  xp('transfer', '10000', 'GAS', 'genesis', walletName);
  const deployed = JSON.parse(xp('contract', 'deploy', nef, walletName, '--json'));
  const kernelHash = normalizeScriptHash(deployed['contract-hash']);
  note(`fresh kernel deployed: ${kernelHash}`);

  // -- custody --------------------------------------------------------------
  const custodyBase = `http://127.0.0.1:${ports.custody}`;
  const provisioned = spawnSync(CUSTODY_BIN, ['provision-admin', 'cu88-e2e'], {
    encoding: 'utf8',
    timeout: 120_000,
    env: childEnv({ SIGNER_SERVICE_DATA_DIR: custodyData }),
    maxBuffer: 8 * 1024 * 1024,
  });
  if (provisioned.status !== 0) fail('custody provision-admin failed');
  const adminToken = provisioned.stdout.trim().split(/\r?\n/).filter(Boolean).pop();
  if (typeof adminToken !== 'string' || adminToken.length < 32) fail('no custody admin token');

  const hostToken = randomBytes(24).toString('hex');
  const custodyShape = {
    nodeEnv: 'test',
    network: 'testnet',
    magic: PRIVATE_CHAIN_MAGIC,
    kernelHash,
    custody: { url: custodyBase, token: adminToken, dataDir: custodyData, roleKeys: {} },
    host: { url: `http://127.0.0.1:${ports.host}`, token: hostToken },
    relayer: { stateFile: join(scratchRoot, 'relayer-state.json'), rpcUrl },
  };

  start('signer_service', CUSTODY_BIN, [], buildCustodyEnv(custodyShape));
  const custodyHealth = await waitUntilReachable(`${custodyBase}/health`, 'custody service');
  if (custodyHealth.status !== 'ok') fail('custody did not open its vault');

  // The updater key is the private-chain validator wallet itself, taken into
  // custody so the relayer and the driver act as one updater identity: the
  // kernel's `ValidateUpdater` accepts exactly one account, and a harness that
  // swapped the updater between the control and the delivery would be testing a
  // chain it invented rather than the one it deployed.
  const imported = await custodyApi(custodyBase, adminToken, 'POST', '/keys/import', {
    label: 'e2e-updater',
    network: 'testnet',
    chain_family: 'neo-n3',
    network_magic: PRIVATE_CHAIN_MAGIC,
    private_key: walletPrivateKey,
  });
  if (imported.status !== 200) {
    fail(`custody refused the updater key import: ${JSON.stringify(imported.body)}`);
  }
  const updaterKey = imported.body;
  if (normalizeScriptHash(updaterKey.script_hash) !== walletHash) {
    fail('the imported updater key is not the private-chain wallet');
  }

  const roleKeys = {
    updater: updaterKey.key_id,
    updater_public_key: updaterKey.public_key,
    updater_script_hash: updaterKey.script_hash,
  };
  for (const [role, label] of [
    ['worker', 'e2e-worker'],
    ['relayer', 'e2e-relayer'],
    ['oracle_verifier', 'e2e-verifier'],
  ]) {
    const created = await custodyApi(custodyBase, adminToken, 'POST', '/keys', {
      label,
      network: 'testnet',
    });
    if (created.status !== 200) {
      fail(`custody refused to generate the ${role} key: ${JSON.stringify(created.body)}`);
    }
    roleKeys[role] = created.body.key_id;
    roleKeys[`${role}_public_key`] = created.body.public_key;
    roleKeys[`${role}_script_hash`] = created.body.script_hash;
  }

  // A boundary is a whole policy body, so read it and extend it deliberately:
  // the host signs raw fulfillment digests, while the updater only ever signs
  // one contract call on this kernel.
  const boundaries = {
    worker: { allow_raw: true },
    relayer: { allow_raw: true },
    oracle_verifier: { allow_raw: true },
    updater: {
      allow_contract_call: true,
      contract_whitelist: [kernelHash],
      contract_method_whitelist: [{ contract: kernelHash, method: 'fulfillRequest' }],
    },
  };
  for (const role of ['worker', 'relayer', 'updater', 'oracle_verifier']) {
    const current = await custodyApi(
      custodyBase,
      adminToken,
      'GET',
      `/keys/${roleKeys[role]}/policy`
    );
    const saved = await custodyApi(
      custodyBase,
      adminToken,
      'POST',
      `/keys/${roleKeys[role]}/policy`,
      { ...current.body.policy, ...boundaries[role] }
    );
    if (saved.status !== 200) {
      fail(`the ${role} key's boundary did not save: ${JSON.stringify(saved.body)}`);
    }
    const applied = saved.body.policy ?? {};
    for (const [field, value] of Object.entries(boundaries[role])) {
      const actual = applied[field];
      const ok =
        typeof value === 'boolean'
          ? actual === value
          : JSON.stringify(actual ?? null) === JSON.stringify(value);
      if (!ok) {
        fail(`the ${role} key's boundary did not hold ${field}: ${JSON.stringify(actual)}`);
      }
    }
  }

  const hostCaller = await custodyApi(custodyBase, adminToken, 'POST', '/callers', {
    label: 'enclave-host',
    capabilities: ['raw_sign'],
    key_grant: {
      mode: 'only',
      key_ids: [roleKeys.worker, roleKeys.relayer, roleKeys.updater, roleKeys.oracle_verifier],
    },
  });
  if (hostCaller.status !== 200) {
    fail(`custody refused the enclave-host caller: ${JSON.stringify(hostCaller.body)}`);
  }
  // The relayer signs a parsed transaction (`/sign/transaction`) and reads key
  // identities; custody grants exactly one capability per caller, so that is a
  // `sign` credential — distinct from the host's raw-sign one on purpose.
  const relayerCaller = await custodyApi(custodyBase, adminToken, 'POST', '/callers', {
    label: 'neo-os-relayer',
    capabilities: ['sign'],
    key_grant: { mode: 'only', key_ids: [roleKeys.updater, roleKeys.oracle_verifier] },
  });
  if (relayerCaller.status !== 200) {
    fail(`custody refused the relayer caller: ${JSON.stringify(relayerCaller.body)}`);
  }
  custodyShape.custody.roleKeys = roleKeys;
  custodyShape.custody.token = hostCaller.body.token;
  const relayerCustodyToken = relayerCaller.body.token;

  // -- kernel: verifier key, app, requests ---------------------------------
  const custodyVerifierPublicKey = roleKeys.oracle_verifier_public_key.toLowerCase();
  if (!/^0[23][0-9a-f]{64}$/.test(custodyVerifierPublicKey)) {
    fail('the custody oracle_verifier key is not a compressed P-256 point');
  }
  invoke('setUpdater', [stackParam.hash160(walletHash)]);
  // Publishing a verifier key is the admin's 24h propose/execute path; Neo
  // Express's clock control advances past the timelock.
  invoke('proposeRuntimeVerificationPublicKey', [stackParam.publicKey(custodyVerifierPublicKey)]);
  xp('fastfwd', '1', '--timestamp-delta', '90000');
  invoke('executeRuntimeVerificationPublicKey', []);
  const verifierPublicKey = readPublicKey('runtimeVerificationPublicKey').toLowerCase();
  if (verifierPublicKey !== custodyVerifierPublicKey) {
    fail(
      'the on-chain verifier key is not the custody oracle_verifier key' +
        ` (on-chain ${verifierPublicKey}, custody ${custodyVerifierPublicKey})`
    );
  }
  invoke('registerMiniApp', [
    stackParam.string(APP_ID),
    stackParam.hash160(walletHash),
    stackParam.hash160(walletHash),
    stackParam.hash160(`0x${'00'.repeat(20)}`),
    stackParam.string(''),
    stackParam.string(''),
  ]);
  invoke('grantModuleToMiniApp', [stackParam.string(APP_ID), stackParam.string(MODULE_ID)]);
  xp('transfer', '1', 'GAS', walletName, scriptHashToAddress(kernelHash));
  for (const requestId of [E2E_REQUEST_ID, CONTROL_REQUEST_ID]) {
    invoke('submitMiniAppRequest', [
      stackParam.string(APP_ID),
      stackParam.string(MODULE_ID),
      stackParam.string(OPERATION),
      stackParam.bytes(Buffer.from(JSON.stringify(PAYLOAD))),
    ]);
    const observed = decodeRequestStack(
      invoke('getRequest', [stackParam.integer(requestId)], true).stack[0].value
    );
    if (observed.state !== 0) fail(`request ${requestId} is not pending after submission`);
    if (observed.requestId !== requestId) fail(`unexpected request id ${observed.requestId}`);
  }
  note(`on-chain requests ${E2E_REQUEST_ID} and ${CONTROL_REQUEST_ID} are pending`);

  // Control 1: the kernel's fulfillment verifier is live. A 64-byte garbage
  // signature must fault, and the request must still be pending afterwards.
  const controlBefore = decodeRequestStack(
    invoke('getRequest', [stackParam.integer(CONTROL_REQUEST_ID)], true).stack[0].value
  );
  const corrupt = invoke(
    'fulfillRequest',
    [
      stackParam.integer(CONTROL_REQUEST_ID),
      stackParam.bool(true),
      stackParam.bytes(Buffer.from('deadbeef', 'hex')),
      stackParam.string(''),
      stackParam.bytes(Buffer.alloc(64, 0x5a)),
    ],
    true
  );
  if (corrupt.state !== 'FAULT') fail('a corrupt verification signature was not rejected');
  const afterCorrupt = decodeRequestStack(
    invoke('getRequest', [stackParam.integer(CONTROL_REQUEST_ID)], true).stack[0].value
  );
  if (afterCorrupt.state !== 0) fail('the corrupt-signature control settled the request anyway');
  if (afterCorrupt.resultHex !== controlBefore.resultHex) {
    fail('the corrupt-signature control changed the stored result');
  }
  note('control: corrupt verification signature refused, request still pending');

  // The kernel accepts fulfillment from exactly one updater, so the harness
  // points it at the custody-held key for the delivery itself. The control above
  // ran while the updater was still the driver's own account; both accounts are
  // the same custody key in this harness, so this is a single identity.
  invoke('setUpdater', [stackParam.hash160(roleKeys.updater_script_hash)]);

  // -- the chain starts serving RPC ----------------------------------------
  start('neoxp-run', neoxp, ['run', '-i', chainPath], xpBase);
  await waitForRpc(rpcUrl, 'the private chain node');
  note(`private chain listening on ${rpcUrl}`);

  // -- host -----------------------------------------------------------------
  const hostShape = {
    ...custodyShape,
    custody: { ...custodyShape.custody, token: hostCaller.body.token },
  };
  start('enclave_host', HOST_BIN, [], buildHostEnv(hostShape));
  const hostHealth = await waitUntilReachable(
    `http://127.0.0.1:${ports.host}/health`,
    'enclave host'
  );
  if (hostHealth.network !== 'testnet') fail('the host did not resolve the testnet profile');
  if (hostHealth.key_source?.oracle_verifier !== 'custody') {
    fail('the host is not signing with a custody key');
  }

  // -- relayer --------------------------------------------------------------
  const relayerShape = {
    ...hostShape,
    custody: { ...hostShape.custody, token: relayerCustodyToken },
  };
  const relayerEnv = buildRelayerEnv(relayerShape);
  // The relayer validates its own configuration before it will resolve a
  // setting; a refusal here is a harness problem, not a delivery failure.
  const validation = JSON.parse(
    run(RELAYER_BIN, ['config:validate'], {
      env: childEnv(relayerEnv),
      label: 'config:validate',
    })
  );
  if (validation.ok !== true) {
    fail(
      `the relayer refuses its own configuration: ${JSON.stringify(validation.errors ?? validation)}`
    );
  }
  // The driver reads the relayer's own configuration resolution back, so the
  // equality the acceptance asserts is observed rather than assumed.
  const resolved = relayerEnvFromDump(
    run(RELAYER_BIN, ['config:dump'], { env: childEnv(relayerEnv) })
  );
  if (resolved.oracleContract !== kernelHash) {
    fail(`the relayer resolved contract ${resolved.oracleContract}, not ${kernelHash}`);
  }
  note(`relayer resolves contract ${resolved.oracleContract} and the custody verifier key`);

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const tick = JSON.parse(
      run(RELAYER_BIN, ['once'], { env: childEnv(relayerEnv), label: 'relayer once' })
    );
    const events = tick.neo_n3?.events ?? [];
    const summary = events
      .map(
        (e) =>
          `${e.key.slice(0, 24)}:${e.status}${e.reason ? `(${e.reason})` : ''}` +
          `${e.error ? ` ${redact(e.error)}` : ''}`
      )
      .join(' | ');
    note(
      `relayer tick ${attempt}: scanned=${tick.neo_n3?.scanned_blocks?.from ?? '-'}..` +
        `${tick.neo_n3?.scanned_blocks?.to ?? '-'} events=${events.length} ${summary}` +
        ` ${JSON.stringify(tick.neo_n3?.discovery_healthy)}`
    );
    const read = decodeRequestStack(
      invoke('getRequest', [stackParam.integer(E2E_REQUEST_ID)], true).stack[0].value
    );
    if (read.state === 1) break;
    if (attempt === 5) {
      fail(
        `the relayer never fulfilled the on-chain request; last tick ${JSON.stringify(tick).slice(0, 1200)}`
      );
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  const fulfilled = decodeRequestStack(
    invoke('getRequest', [stackParam.integer(E2E_REQUEST_ID)], true).stack[0].value
  );
  const controlFulfilled = decodeRequestStack(
    invoke('getRequest', [stackParam.integer(CONTROL_REQUEST_ID)], true).stack[0].value
  );
  note(
    `on-chain request ${E2E_REQUEST_ID}: state=${fulfilled.state} success=${fulfilled.success}` +
      ` resultBytes=${fulfilled.resultHex.length / 2}`
  );

  // Control 2: a second delivery of a settled request is refused on chain and
  // leaves the stored request untouched. This is the production replay path —
  // the relayer re-discovers the event with a fresh state file and re-broadcasts.
  unlinkSync(relayerEnv.MORPHEUS_RELAYER_STATE_FILE);
  const replayTick = JSON.parse(
    run(RELAYER_BIN, ['once'], { env: childEnv(relayerEnv), label: 'relayer replay' })
  );
  const replayEvents = replayTick.neo_n3?.events ?? [];
  const replayRefused = replayEvents.some(
    (e) => e.status === 'already_fulfilled' || e.reason === 'onchain_request_already_settled'
  );
  if (!replayRefused) {
    fail(
      'the replay attempt never reached the kernel; the control would be vacuous: ' +
        JSON.stringify(replayEvents)
    );
  }
  const afterReplay = decodeRequestStack(
    invoke('getRequest', [stackParam.integer(E2E_REQUEST_ID)], true).stack[0].value
  );
  const replayRejected =
    replayRefused &&
    afterReplay.resultHex === fulfilled.resultHex &&
    afterReplay.completionTimestamp === fulfilled.completionTimestamp &&
    afterReplay.state === fulfilled.state;
  if (!replayRejected) fail('a replayed delivery modified the settled on-chain request');
  note(`control: replay was refused on chain and left request ${E2E_REQUEST_ID} unchanged`);

  // -- acceptance -----------------------------------------------------------
  const verdict = evaluateAcceptance({
    onChain: {
      state: fulfilled.state,
      success: fulfilled.success,
      resultHex: fulfilled.resultHex,
      error: fulfilled.error,
      completionTimestamp: fulfilled.completionTimestamp,
    },
    // Both requests carry the same payload, so the control request's stored
    // result is an independent record of what the host computes.
    expected: { resultHex: controlFulfilled.resultHex },
    corruptSignatureRejected: afterCorrupt.state === 0,
    replayRejected,
    contractBinding: {
      kernelHash,
      hostOverride: hostShape.kernelHash,
      relayerContract: resolved.oracleContract,
    },
    custody: {
      verifierPublicKey,
      hostReportedPublicKey: custodyVerifierPublicKey,
      relayerPinnedVerifier: resolved.oracleVerifierKeyId,
      configuredVerifierKey: roleKeys.oracle_verifier,
    },
  });

  for (const entry of verdict.checks) {
    note(`  [${entry.ok ? 'ok' : 'FAIL'}] ${entry.name}`);
  }
  if (!verdict.ok) {
    for (const line of verdict.failures) note(`  detail: ${line}`);
    fail(`end-to-end acceptance failed with ${verdict.failures.length} problem(s)`);
  }

  note(
    'PASS: kernel queued a request; the relayer delivered it to the host; custody signed the ' +
      'fulfillment digest; the kernel verified the signature and stored the result; the ' +
      'corrupt-signature and replay controls were refused.'
  );
}

function cleanup() {
  stopAll('SIGTERM');
  const timer = setTimeout(() => {
    stopAll('SIGKILL');
    if (scratchRoot) {
      try {
        rmSync(scratchRoot, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
    process.exit(process.exitCode ?? 0);
  }, 750);
  timer.unref();
}

main()
  .catch((error) => {
    process.stderr.write(`e2e-private-chain: ${error?.message ?? error}\n`);
    process.exitCode = 1;
  })
  .finally(cleanup);
