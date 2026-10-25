import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { sc, tx, wallet } from '@cityofzion/neon-js';
import { readReviewedNetworkRegistrySync } from '../lib-network-registry.mjs';
import {
  buildApplyConfirmation,
  parseRecoveryConfig,
  runRecovery,
} from './recover-and-rotate-admin.mjs';

const SCRIPT = fileURLToPath(new URL('./recover-and-rotate-admin.mjs', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const NETWORK_MAGIC = 123456;
const REVIEWED_TESTNET_MAGIC = readReviewedNetworkRegistrySync(REPO_ROOT, 'testnet').neo_n3
  .network_magic;
const ADMIN_PRIVATE_KEY = '11'.repeat(32);
const NEW_UPDATER_PRIVATE_KEY = '22'.repeat(32);
const CURRENT_UPDATER_PRIVATE_KEY = '33'.repeat(32);
const CURRENT_VERIFIER_PRIVATE_KEY = '44'.repeat(32);
const NEW_VERIFIER_PRIVATE_KEY = '55'.repeat(32);
const OTHER_PRIVATE_KEY = '66'.repeat(32);
const ADMIN_ACCOUNT = new wallet.Account(ADMIN_PRIVATE_KEY);
const NEW_UPDATER_ACCOUNT = new wallet.Account(NEW_UPDATER_PRIVATE_KEY);
const CURRENT_UPDATER_ACCOUNT = new wallet.Account(CURRENT_UPDATER_PRIVATE_KEY);
const OTHER_ACCOUNT = new wallet.Account(OTHER_PRIVATE_KEY);
const ORACLE_HASH = `0x${'aa'.repeat(20)}`;
const ADMIN_HASH = `0x${ADMIN_ACCOUNT.scriptHash}`;
const CURRENT_UPDATER_HASH = `0x${CURRENT_UPDATER_ACCOUNT.scriptHash}`;
const NEW_UPDATER_HASH = `0x${NEW_UPDATER_ACCOUNT.scriptHash}`;
const CURRENT_VERIFIER = wallet.getPublicKeyFromPrivateKey(CURRENT_VERIFIER_PRIVATE_KEY);
const NEW_VERIFIER = wallet.getPublicKeyFromPrivateKey(NEW_VERIFIER_PRIVATE_KEY);
const OTHER_TXID = `0x${'ee'.repeat(32)}`;
const APPLY_CONFIRMATION = buildApplyConfirmation({
  network: 'testnet',
  oracleHash: ORACLE_HASH,
  expectedAdminHash: ADMIN_HASH,
});

function baseEnv(overrides = {}) {
  return {
    NEO_RPC_URL: 'https://rpc.test',
    NITRO_RUNTIME_URL: 'https://cvm.test',
    CONTRACT_MORPHEUS_ORACLE_HASH: ORACLE_HASH,
    EXPECTED_ADMIN_ADDRESS: ADMIN_ACCOUNT.address,
    TARGET_ADMIN_ADDRESS: ADMIN_HASH,
    NEW_UPDATER_HASH: NEW_UPDATER_HASH,
    NEW_VERIFIER_PUBLIC_KEY: '',
    MAX_SYSTEM_FEE: '4000000',
    MAX_NETWORK_FEE: '4000000',
    MAX_TOTAL_FEE: '12000000',
    TX_CONFIRMATION_TIMEOUT_MS: '2',
    TX_POLL_INTERVAL_MS: '1',
    ...overrides,
  };
}

function makeConfig({ apply = false, confirmApply = true, env = {}, extraArgv = [] } = {}) {
  const argv = ['--network', 'testnet', ...extraArgv];
  if (apply) {
    argv.push('--apply');
    if (confirmApply) argv.push('--confirm-apply', APPLY_CONFIRMATION);
  }
  return parseRecoveryConfig({
    argv,
    env: baseEnv(env),
    resolveNetworkMagic: () => NETWORK_MAGIC,
  });
}

function applyArgv() {
  return ['--network', 'testnet', '--apply', '--confirm-apply', APPLY_CONFIRMATION];
}

function hashStack(hash) {
  return {
    type: 'ByteString',
    value: Buffer.from(hash.slice(2), 'hex').reverse().toString('base64'),
  };
}

function publicKeyStack(publicKey) {
  return { type: 'ByteString', value: Buffer.from(publicKey, 'hex').toString('base64') };
}

function halt(stack) {
  return { state: 'HALT', stack };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function derivedIdentity(account, role) {
  return {
    role,
    neo_n3: {
      address: account.address,
      script_hash: `0x${account.scriptHash}`,
      public_key: account.publicKey,
    },
  };
}

function expectedScript(method) {
  if (method === 'setUpdater') {
    return sc.createScript({
      scriptHash: ORACLE_HASH,
      operation: method,
      args: [sc.ContractParam.hash160(NEW_UPDATER_HASH)],
    });
  }
  if (method === 'setOracleVerificationPublicKey') {
    return sc.createScript({
      scriptHash: ORACLE_HASH,
      operation: method,
      args: [sc.ContractParam.publicKey(NEW_VERIFIER)],
    });
  }
  throw new Error(`unexpected synthetic method ${method}`);
}

function methodForScript(script) {
  for (const method of ['setUpdater', 'setOracleVerificationPublicKey']) {
    if (script === expectedScript(method)) return method;
  }
  throw new Error('transaction script does not match a requested synthetic operation');
}

function deserializeBase64Transaction(raw) {
  return tx.Transaction.deserialize(Buffer.from(raw, 'base64').toString('hex'));
}

function realSignResponse(payload, account = ADMIN_ACCOUNT, privateKey = ADMIN_PRIVATE_KEY) {
  const preimage = Buffer.from(payload.data_hex, 'hex');
  return {
    target_chain: 'neo_n3',
    source: 'data_hex',
    payload_hash: createHash('sha256').update(preimage).digest('hex'),
    signature: wallet.sign(payload.data_hex, privateKey),
    public_key: account.publicKey,
    address: account.address,
    script_hash: `0x${account.scriptHash}`,
  };
}

function createMockHarness(options = {}) {
  const rpcUrl = options.rpcUrl || 'https://rpc.test';
  const cvmUrl = options.cvmUrl || 'https://cvm.test';
  const harness = {
    state: {
      admin: ADMIN_HASH,
      updater: CURRENT_UPDATER_HASH,
      verifier: CURRENT_VERIFIER,
      ...options.state,
    },
    rpcNetworkMagic: options.rpcNetworkMagic || NETWORK_MAGIC,
    derivedAccounts: { worker: ADMIN_ACCOUNT, updater: NEW_UPDATER_ACCOUNT },
    derivedResponses: new Map(),
    getterResponses: new Map(),
    simulationResponses: new Map(),
    networkFeeResponses: new Map(),
    signResponseOverrides: [],
    broadcastResponses: new Map(),
    confirmationResponses: new Map(),
    requests: [],
    derivedCalls: [],
    getterCalls: [],
    simulationCalls: [],
    networkFeeCalls: [],
    signCalls: [],
    broadcasts: [],
    confirmationCalls: [],
    pending: new Map(),
    confirmedProposals: new Set(),
  };

  harness.fetch = async (url, init = {}) => {
    const payload = init.body ? JSON.parse(init.body) : null;
    harness.requests.push({ url, init, payload });
    if (url === `${cvmUrl}/keys/derived`) {
      const role = payload.role;
      harness.derivedCalls.push(role);
      const override = harness.derivedResponses.get(role);
      if (override) return jsonResponse(override.body, override.status || 200);
      return jsonResponse({ derived: derivedIdentity(harness.derivedAccounts[role], role) });
    }
    if (url === `${cvmUrl}/sign/payload`) {
      const index = harness.signCalls.length;
      harness.signCalls.push({ payload, init });
      const signed = realSignResponse(payload);
      const override = harness.signResponseOverrides[index];
      const body =
        typeof override === 'function' ? override(signed, payload) : { ...signed, ...override };
      return jsonResponse(body);
    }
    if (url !== rpcUrl) throw new Error(`unexpected non-mock URL: ${url}`);

    const { id, method, params } = payload;
    let result;
    if (method === 'getversion') {
      result = { protocol: { network: harness.rpcNetworkMagic } };
    } else if (method === 'getblockcount') {
      result = 1000;
    } else if (method === 'invokefunction') {
      const getter = params[1];
      harness.getterCalls.push(getter);
      const override = harness.getterResponses.get(getter);
      if (override) {
        result = typeof override === 'function' ? override() : override;
      } else if (getter === 'admin') {
        result = halt([hashStack(harness.state.admin)]);
      } else if (getter === 'updater') {
        result = halt([hashStack(harness.state.updater)]);
      } else if (getter === 'oracleVerificationPublicKey') {
        result = halt([publicKeyStack(harness.state.verifier)]);
      } else {
        throw new Error(`unexpected getter ${getter}`);
      }
    } else if (method === 'invokescript') {
      const script = Buffer.from(params[0], 'base64').toString('hex');
      const operation = methodForScript(script);
      harness.simulationCalls.push({ operation, script, signers: params[1], init });
      result = harness.simulationResponses.get(operation) || {
        state: 'HALT',
        gasconsumed: operation === 'setUpdater' ? '2000000' : '2100000',
        stack: [],
      };
    } else if (method === 'calculatenetworkfee') {
      const transaction = deserializeBase64Transaction(params[0]);
      const operation = methodForScript(transaction.script.toString());
      harness.networkFeeCalls.push({ operation, transaction, init });
      result = harness.networkFeeResponses.get(operation) || {
        networkfee: operation === 'setUpdater' ? '3000000' : '3100000',
      };
    } else if (method === 'sendrawtransaction') {
      const transaction = deserializeBase64Transaction(params[0]);
      const operation = methodForScript(transaction.script.toString());
      const txid = `0x${transaction.hash()}`;
      harness.broadcasts.push({ operation, transaction, txid, raw: params[0], init });
      harness.pending.set(txid, { operation, transaction });
      result = harness.broadcastResponses.get(operation) || { hash: txid };
    } else if (method === 'getapplicationlog') {
      const txid = params[0];
      harness.confirmationCalls.push(txid);
      const pending = harness.pending.get(txid);
      assert.ok(pending, `no synthetic broadcast for ${txid}`);
      const override = harness.confirmationResponses.get(pending.operation);
      if (override?.error) {
        return jsonResponse({ jsonrpc: '2.0', id, error: override.error });
      }
      if (!override) {
        if (pending.operation === 'setUpdater') harness.state.updater = NEW_UPDATER_HASH;
        if (pending.operation === 'setOracleVerificationPublicKey') {
          harness.confirmedProposals.add(txid);
        }
      }
      result = {
        txid,
        executions: [
          {
            trigger: override?.trigger || 'Application',
            vmstate: override?.vmstate || 'HALT',
            exception: override?.exception || null,
          },
        ],
      };
    } else {
      throw new Error(`unexpected RPC method ${method}`);
    }
    return jsonResponse({ jsonrpc: '2.0', id, result });
  };
  return harness;
}

function silentLogger(lines = []) {
  return { lines, log: (message) => lines.push(String(message)) };
}

async function rejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected promise to reject');
}

async function runChild(argv, env) {
  const child = spawn(process.execPath, [SCRIPT, ...argv], {
    cwd: REPO_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
  const [status, signal] = await once(child, 'close');
  clearTimeout(timer);
  return { status, signal, stdout, stderr };
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
}

async function startLoopbackHarness(t, options = {}) {
  let harness;
  const redirectedRequests = [];
  const secondStageRequests = [];
  let secondStageUrl = '';
  if (options.redirectPath) {
    const secondStage = http.createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      secondStageRequests.push({
        method: request.method,
        url: request.url,
        body: Buffer.concat(chunks),
      });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
    await listen(secondStage);
    t.after(() => new Promise((resolve) => secondStage.close(resolve)));
    secondStageUrl = `http://127.0.0.1:${secondStage.address().port}/second-stage`;
  }

  const server = http.createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString('utf8');
      if (request.url === options.redirectPath) {
        redirectedRequests.push({ method: request.method, body: Buffer.from(body) });
        response.writeHead(options.redirectStatus, { location: secondStageUrl });
        response.end();
        return;
      }
      const url = `http://127.0.0.1:${server.address().port}${request.url}`;
      const mocked = await harness.fetch(url, {
        method: request.method,
        headers: request.headers,
        body: body || undefined,
        redirect: 'error',
      });
      response.writeHead(mocked.status, Object.fromEntries(mocked.headers));
      response.end(await mocked.text());
    } catch (error) {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: error.message }));
    }
  });
  await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  harness = createMockHarness({
    ...options,
    rpcUrl: `${base}/rpc`,
    cvmUrl: `${base}/cvm`,
    rpcNetworkMagic: REVIEWED_TESTNET_MAGIC,
  });
  return {
    harness,
    redirectedRequests,
    secondStageRequests,
    env: baseEnv({
      NEO_RPC_URL: `${base}/rpc`,
      NITRO_RUNTIME_URL: `${base}/cvm`,
      ...(options.dual ? { NEW_VERIFIER_PUBLIC_KEY: NEW_VERIFIER } : {}),
    }),
  };
}

function assertUpdaterSuccessSemantics(harness, result, networkMagic) {
  assert.equal(result.finalState.updater, NEW_UPDATER_HASH);
  assert.equal(result.finalState.admin, ADMIN_HASH);
  assert.equal(result.transactions.length, 1);
  assert.equal(harness.signCalls.length, 1);
  assert.equal(harness.broadcasts.length, 1);
  assert.equal(harness.simulationCalls.length, 1);
  assert.equal(harness.networkFeeCalls.length, 1);
  assert.deepEqual(harness.simulationCalls[0].signers, [
    { account: ADMIN_HASH, scopes: 'CalledByEntry' },
  ]);
  assert.equal(harness.simulationCalls[0].script, expectedScript('setUpdater'));

  const placeholder = harness.networkFeeCalls[0].transaction;
  assert.equal(placeholder.systemFee.toString(), '2000000');
  assert.equal(placeholder.witnesses.length, 1);
  assert.equal(placeholder.witnesses[0].invocationScript.toString(), `0c40${'00'.repeat(64)}`);
  assert.equal(
    placeholder.witnesses[0].verificationScript.toString(),
    wallet.getVerificationScriptFromPublicKey(ADMIN_ACCOUNT.publicKey)
  );

  const signRequest = harness.signCalls[0];
  assert.deepEqual(Object.keys(signRequest.payload).sort(), [
    'data_hex',
    'dstack_key_role',
    'target_chain',
    'use_derived_keys',
  ]);
  assert.equal(signRequest.payload.target_chain, 'neo_n3');
  assert.equal(signRequest.payload.use_derived_keys, true);
  assert.equal(signRequest.payload.dstack_key_role, 'worker');
  assert.equal(signRequest.init.headers['x-morpheus-network'], 'testnet');
  assert.equal(Buffer.from(signRequest.payload.data_hex, 'hex').length, 36);

  const broadcast = harness.broadcasts[0];
  const transaction = broadcast.transaction;
  const unsignedBytes = Buffer.from(transaction.serialize(false), 'hex');
  const unsignedDigest = createHash('sha256').update(unsignedBytes).digest();
  const magicBytes = Buffer.alloc(4);
  magicBytes.writeUInt32LE(networkMagic, 0);
  assert.equal(
    signRequest.payload.data_hex,
    Buffer.concat([magicBytes, unsignedDigest]).toString('hex')
  );
  assert.equal(broadcast.txid, `0x${Buffer.from(unsignedDigest).reverse().toString('hex')}`);
  assert.equal(transaction.getMessageForSigning(networkMagic), signRequest.payload.data_hex);
  assert.equal(transaction.systemFee.toString(), '2000000');
  assert.equal(transaction.networkFee.toString(), '3000000');
  assert.equal(transaction.signers.length, 1);
  assert.equal(transaction.signers[0].scopes, tx.WitnessScope.CalledByEntry);
  assert.equal(`0x${transaction.signers[0].account}`, ADMIN_HASH);
  assert.equal(transaction.witnesses.length, 1);
  const invocation = transaction.witnesses[0].invocationScript.toString();
  const signature = invocation.slice(4);
  assert.match(invocation, /^0c40[0-9a-f]{128}$/);
  assert.equal(
    wallet.verify(signRequest.payload.data_hex, signature, ADMIN_ACCOUNT.publicKey),
    true
  );
  assert.equal(
    transaction.witnesses[0].verificationScript.toString(),
    wallet.getVerificationScriptFromPublicKey(ADMIN_ACCOUNT.publicKey)
  );
  assert.equal(broadcast.txid, result.transactions[0].txid);
  assert.equal(broadcast.txid, `0x${transaction.hash()}`);
  assert.equal(result.transactions[0].status, 'confirmed');
  assert.equal(result.transactions[0].trigger, 'Application');
  assert.ok(Number.isInteger(transaction.nonce) && transaction.nonce >= 0);
  assert.equal(harness.getterCalls.length, 6);
  assert.ok(harness.requests.every((request) => request.init.redirect === 'error'));
}

test('CLI has no network, endpoint, contract, admin, or signing defaults', () => {
  const result = spawnSync(process.execPath, [SCRIPT], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: {},
    timeout: 10000,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--network.*required|no default/i);
});

test('CLI apply without its independent exact confirmation exits non-zero before fetch', () => {
  const result = spawnSync(process.execPath, [SCRIPT, '--network', 'testnet', '--apply'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: baseEnv(),
    timeout: 10000,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--confirm-apply.*apply:testnet/i);
});

test('non-loopback plaintext CVM URLs are rejected in dry-run before any token request', () => {
  assert.throws(
    () =>
      makeConfig({
        env: {
          NITRO_RUNTIME_URL: 'http://cvm.invalid',
          NITRO_API_TOKEN: 'synthetic-shared-token',
        },
      }),
    /NITRO_RUNTIME_URL must use HTTPS for non-loopback endpoints/
  );
});

test('apply requires explicit fee ceilings, while dry-run does not need them', () => {
  for (const name of ['MAX_SYSTEM_FEE', 'MAX_NETWORK_FEE', 'MAX_TOTAL_FEE']) {
    assert.throws(
      () => makeConfig({ apply: true, env: { [name]: '' } }),
      new RegExp(`${name} is required`)
    );
  }
  const config = makeConfig({
    env: { MAX_SYSTEM_FEE: '', MAX_NETWORK_FEE: '', MAX_TOTAL_FEE: '' },
  });
  assert.equal(config.maxSystemFee, null);
  assert.equal(config.maxNetworkFee, null);
  assert.equal(config.maxTotalFee, null);
});

test('zero updater and invalid secp256r1 points fail before any fetch', () => {
  const invalidPoint = `02${'11'.repeat(32)}`;
  assert.equal(wallet.isPublicKey(invalidPoint), false);
  assert.throws(
    () => makeConfig({ env: { NEW_UPDATER_HASH: `0x${'00'.repeat(20)}` } }),
    /must not be zero/i
  );
  assert.throws(
    () => makeConfig({ env: { NEW_VERIFIER_PUBLIC_KEY: invalidPoint } }),
    /valid compressed secp256r1/i
  );
  assert.throws(() => makeConfig({ env: { NEW_UPDATER_HASH: 'not-a-hash' } }), /NEW_UPDATER_HASH/);
});

test('default dry-run accepts the real derived shape without network and never simulates, signs, or broadcasts', async () => {
  const harness = createMockHarness();
  const logger = silentLogger();
  const result = await runRecovery(makeConfig(), {
    fetch: harness.fetch,
    logger,
    now: () => 0,
    sleep: async () => {},
  });
  assert.equal(result.mode, 'dry-run');
  assert.deepEqual(harness.derivedCalls, ['worker', 'updater']);
  assert.equal(harness.simulationCalls.length, 0);
  assert.equal(harness.networkFeeCalls.length, 0);
  assert.equal(harness.signCalls.length, 0);
  assert.equal(harness.broadcasts.length, 0);
  assert.equal(harness.confirmationCalls.length, 0);
  assert.match(logger.lines.join('\n'), /DRY-RUN.*signing and broadcast disabled/i);
  assert.ok(harness.requests.every((request) => request.init.redirect === 'error'));
});

test('optional derived network is checked when present, and custody mismatch still fails', async (t) => {
  await t.test('mismatched optional network', async () => {
    const harness = createMockHarness();
    harness.derivedResponses.set('worker', {
      body: { network: 'mainnet', derived: derivedIdentity(ADMIN_ACCOUNT, 'worker') },
    });
    const error = await rejection(
      runRecovery(makeConfig(), { fetch: harness.fetch, logger: silentLogger() })
    );
    assert.match(error.message, /network does not match testnet/i);
    assert.equal(harness.signCalls.length, 0);
  });
  await t.test('wrong worker custody admin', async () => {
    const harness = createMockHarness();
    harness.derivedAccounts.worker = OTHER_ACCOUNT;
    const error = await rejection(
      runRecovery(makeConfig({ apply: true }), { fetch: harness.fetch, logger: silentLogger() })
    );
    assert.match(error.message, /does not match CVM worker custody admin/i);
    assert.equal(harness.signCalls.length, 0);
  });
});

test('worker and updater derived query failures remain fatal', async (t) => {
  for (const role of ['worker', 'updater']) {
    await t.test(role, async () => {
      const harness = createMockHarness();
      harness.derivedResponses.set(role, { status: 500, body: { error: 'synthetic' } });
      const error = await rejection(
        runRecovery(makeConfig({ apply: true }), { fetch: harness.fetch, logger: silentLogger() })
      );
      assert.match(error.message, /CVM \/keys\/derived returned HTTP 500/i);
      assert.equal(harness.signCalls.length, 0);
    });
  }
});

test('little-endian getter decoding detects a no-op and malformed getter stacks fail', async (t) => {
  await t.test('no-op updater', async () => {
    const harness = createMockHarness({ state: { updater: NEW_UPDATER_HASH } });
    const error = await rejection(
      runRecovery(makeConfig({ apply: true }), { fetch: harness.fetch, logger: silentLogger() })
    );
    assert.match(error.message, /equals the current updater/i);
    assert.equal(harness.signCalls.length, 0);
  });
  await t.test('malformed admin stack', async () => {
    const harness = createMockHarness();
    harness.getterResponses.set('admin', { state: 'HALT', stack: [] });
    const error = await rejection(
      runRecovery(makeConfig(), { fetch: harness.fetch, logger: silentLogger() })
    );
    assert.match(error.message, /exactly one stack item/i);
    assert.equal(harness.signCalls.length, 0);
  });
});

test('simulation FAULT stops before signing or broadcast', async () => {
  const harness = createMockHarness();
  harness.simulationResponses.set('setUpdater', {
    state: 'FAULT',
    gasconsumed: '2000000',
    exception: 'synthetic simulation fault',
  });
  const error = await rejection(
    runRecovery(makeConfig({ apply: true }), { fetch: harness.fetch, logger: silentLogger() })
  );
  assert.match(error.message, /simulation did not HALT.*synthetic simulation fault/i);
  assert.equal(harness.signCalls.length, 0);
  assert.equal(harness.broadcasts.length, 0);
});

test('simulation and network fee errors cannot fall back to default fees', async (t) => {
  await t.test('invalid system fee', async () => {
    const harness = createMockHarness();
    harness.simulationResponses.set('setUpdater', {
      state: 'HALT',
      gasconsumed: '0',
      stack: [],
    });
    const error = await rejection(
      runRecovery(makeConfig({ apply: true }), { fetch: harness.fetch, logger: silentLogger() })
    );
    assert.match(error.message, /simulation gasconsumed.*positive/i);
    assert.equal(harness.signCalls.length, 0);
  });
  await t.test('invalid network fee', async () => {
    const harness = createMockHarness();
    harness.networkFeeResponses.set('setUpdater', { networkfee: 'not-a-number' });
    const error = await rejection(
      runRecovery(makeConfig({ apply: true }), { fetch: harness.fetch, logger: silentLogger() })
    );
    assert.match(error.message, /calculatenetworkfee networkfee.*positive integer/i);
    assert.equal(harness.signCalls.length, 0);
    assert.equal(harness.broadcasts.length, 0);
  });
});

test('RPC fees above per-transaction ceilings stop before signing', async (t) => {
  for (const [kind, response, pattern] of [
    [
      'system',
      { state: 'HALT', gasconsumed: '500000000', stack: [] },
      /systemFee 500000000 exceeds MAX_SYSTEM_FEE 4000000/,
    ],
    [
      'network',
      { networkfee: '600000000' },
      /networkFee 600000000 exceeds MAX_NETWORK_FEE 4000000/,
    ],
  ]) {
    await t.test(kind, async () => {
      const harness = createMockHarness();
      if (kind === 'system') harness.simulationResponses.set('setUpdater', response);
      else harness.networkFeeResponses.set('setUpdater', response);
      const error = await rejection(
        runRecovery(makeConfig({ apply: true }), {
          fetch: harness.fetch,
          logger: silentLogger(),
        })
      );
      assert.match(error.message, pattern);
      assert.equal(harness.signCalls.length, 0);
      assert.equal(harness.broadcasts.length, 0);
    });
  }
});

test('combined and multi-transaction fees stop before any signature', async (t) => {
  await t.test('dual planned fees exceed the total budget', async () => {
    const harness = createMockHarness();
    const error = await rejection(
      runRecovery(
        makeConfig({
          apply: true,
          env: { NEW_VERIFIER_PUBLIC_KEY: NEW_VERIFIER, MAX_TOTAL_FEE: '6000000' },
        }),
        { fetch: harness.fetch, logger: silentLogger() }
      )
    );
    assert.match(
      error.message,
      /planned fees 10200000 exceed MAX_TOTAL_FEE 6000000 before signing/
    );
    assert.equal(harness.signCalls.length, 0);
    assert.equal(harness.broadcasts.length, 0);
  });

  await t.test('combined fees overflow the approved total', async () => {
    const harness = createMockHarness();
    const maximum = '9223372036854775807';
    harness.simulationResponses.set('setUpdater', {
      state: 'HALT',
      gasconsumed: maximum,
      stack: [],
    });
    harness.networkFeeResponses.set('setUpdater', { networkfee: maximum });
    const error = await rejection(
      runRecovery(
        makeConfig({
          apply: true,
          env: {
            MAX_SYSTEM_FEE: maximum,
            MAX_NETWORK_FEE: maximum,
            MAX_TOTAL_FEE: maximum,
          },
        }),
        { fetch: harness.fetch, logger: silentLogger() }
      )
    );
    assert.match(error.message, /total fee 18446744073709551614 exceeds MAX_TOTAL_FEE/);
    assert.equal(harness.signCalls.length, 0);
    assert.equal(harness.broadcasts.length, 0);
  });
});

test('missing or bad signatures and wrong signer identities prevent broadcast', async (t) => {
  const cases = [
    [{ signature: '' }, /signature.*64 bytes/i],
    [{ signature: '00'.repeat(64) }, /signature|verify/i],
    [
      {
        public_key: OTHER_ACCOUNT.publicKey,
        address: OTHER_ACCOUNT.address,
        script_hash: `0x${OTHER_ACCOUNT.scriptHash}`,
      },
      /signer identity.*does not match/i,
    ],
    [{ payload_hash: '00'.repeat(32) }, /payload_hash.*does not match/i],
  ];
  for (const [override, pattern] of cases) {
    await t.test(pattern.source, async () => {
      const harness = createMockHarness();
      harness.signResponseOverrides[0] = override;
      const error = await rejection(
        runRecovery(makeConfig({ apply: true }), { fetch: harness.fetch, logger: silentLogger() })
      );
      assert.match(error.message, pattern);
      assert.equal(harness.broadcasts.length, 0);
    });
  }
});

test('broadcast hash mismatch is fatal and is not followed by confirmation', async () => {
  const harness = createMockHarness();
  harness.broadcastResponses.set('setUpdater', { hash: OTHER_TXID });
  const error = await rejection(
    runRecovery(makeConfig({ apply: true }), { fetch: harness.fetch, logger: silentLogger() })
  );
  assert.match(error.message, /hash mismatch.*expected.*got/i);
  assert.equal(harness.broadcasts.length, 1);
  assert.equal(harness.confirmationCalls.length, 0);
  assert.equal(error.confirmedTransactions.length, 0);
});

test('confirmation VM fault and timeout are failures with a diagnosable submitted txid', async (t) => {
  await t.test('VM fault', async () => {
    const harness = createMockHarness();
    harness.confirmationResponses.set('setUpdater', {
      vmstate: 'FAULT',
      exception: 'synthetic execution fault',
    });
    const error = await rejection(
      runRecovery(makeConfig({ apply: true }), { fetch: harness.fetch, logger: silentLogger() })
    );
    assert.match(error.message, /FAULT.*synthetic execution fault/i);
    assert.match(error.message, /0x[0-9a-f]{64}/i);
    assert.equal(error.confirmedTransactions.length, 0);
  });
  await t.test('timeout', async () => {
    const harness = createMockHarness();
    harness.confirmationResponses.set('setUpdater', {
      error: { code: -104, message: 'Unknown transaction' },
    });
    const error = await rejection(
      runRecovery(makeConfig({ apply: true }), {
        fetch: harness.fetch,
        logger: silentLogger(),
        now: () => 0,
        sleep: async () => {},
      })
    );
    assert.match(error.message, /not confirmed within 2ms/i);
    assert.equal(harness.confirmationCalls.length, 2);
  });
});

test('updater-only apply succeeds with real signature, exact fees, witness, preimage, and read-back', async () => {
  const harness = createMockHarness();
  const result = await runRecovery(makeConfig({ apply: true }), {
    fetch: harness.fetch,
    logger: silentLogger(),
    now: () => 0,
    sleep: async () => {},
  });
  assertUpdaterSuccessSemantics(harness, result, NETWORK_MAGIC);
});

test('dual apply confirms updater and verifier proposal but fails final verifier rotation with txids', async () => {
  const harness = createMockHarness();
  const error = await rejection(
    runRecovery(makeConfig({ apply: true, env: { NEW_VERIFIER_PUBLIC_KEY: NEW_VERIFIER } }), {
      fetch: harness.fetch,
      logger: silentLogger(),
      now: () => 0,
      sleep: async () => {},
    })
  );
  assert.match(error.message, /verifier final getter mismatch/i);
  assert.match(error.message, /only confirmed a timelock proposal/i);
  assert.equal(error.confirmedTransactions.length, 2);
  const updater = error.confirmedTransactions.find((entry) => entry.method === 'setUpdater');
  assert.ok(updater);
  assert.match(error.message, new RegExp(`setUpdater=${updater.txid}`));
  assert.equal(harness.state.updater, NEW_UPDATER_HASH);
  assert.equal(harness.state.verifier, CURRENT_VERIFIER);
  assert.equal(harness.confirmedProposals.size, 1);
  assert.equal(harness.broadcasts.length, 2);
});

test('verifier signing failure after confirmed updater is a diagnosed partial apply', async () => {
  const harness = createMockHarness();
  harness.signResponseOverrides[1] = { signature: '' };
  const error = await rejection(
    runRecovery(makeConfig({ apply: true, env: { NEW_VERIFIER_PUBLIC_KEY: NEW_VERIFIER } }), {
      fetch: harness.fetch,
      logger: silentLogger(),
      now: () => 0,
      sleep: async () => {},
    })
  );
  assert.equal(error.confirmedTransactions.length, 1);
  assert.equal(error.confirmedTransactions[0].method, 'setUpdater');
  assert.match(error.message, /confirmed transactions: setUpdater=0x/i);
  assert.equal(harness.state.updater, NEW_UPDATER_HASH);
  assert.equal(harness.state.verifier, CURRENT_VERIFIER);
  assert.equal(harness.broadcasts.length, 1);
});

test('loopback CLI completes the real updater-only sign/RPC sequence', async (t) => {
  const { harness, env } = await startLoopbackHarness(t);
  const result = await runChild(applyArgv(), env);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /APPLY verified.*every requested final getter/i);
  const report = {
    finalState: harness.state,
    transactions: harness.broadcasts.map((entry) => ({
      txid: entry.txid,
      status: 'confirmed',
      trigger: 'Application',
    })),
  };
  assertUpdaterSuccessSemantics(harness, report, REVIEWED_TESTNET_MAGIC);
});

test('loopback CLI dual proposal exits non-zero and reports the confirmed updater txid', async (t) => {
  const { harness, env } = await startLoopbackHarness(t, { dual: true });
  const result = await runChild(applyArgv(), env);
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  const updater = harness.broadcasts.find((entry) => entry.operation === 'setUpdater');
  assert.ok(updater);
  assert.match(
    result.stdout,
    new RegExp(`setUpdater confirmed with Application/HALT: ${updater.txid}`)
  );
  assert.match(result.stderr, new RegExp(`confirmed transactions: setUpdater=${updater.txid}`));
  assert.match(result.stderr, /verifier final getter mismatch.*timelock proposal/i);
  assert.equal(harness.state.updater, NEW_UPDATER_HASH);
  assert.equal(harness.state.verifier, CURRENT_VERIFIER);
  assert.equal(harness.confirmedProposals.size, 1);
});

test('loopback RPC 307 redirect is rejected and second stage receives no request or body', async (t) => {
  const { redirectedRequests, secondStageRequests, env } = await startLoopbackHarness(t, {
    redirectPath: '/rpc',
    redirectStatus: 307,
  });
  const result = await runChild(['--network', 'testnet'], env);
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /RPC getversion request failed/i);
  assert.equal(redirectedRequests.length, 1);
  assert.ok(redirectedRequests[0].body.length > 0);
  assert.equal(secondStageRequests.length, 0);
  assert.equal(
    secondStageRequests.reduce((size, request) => size + request.body.length, 0),
    0
  );
});

test('loopback signing 308 redirect is rejected without second-stage body or broadcast', async (t) => {
  const { harness, redirectedRequests, secondStageRequests, env } = await startLoopbackHarness(t, {
    redirectPath: '/cvm/sign/payload',
    redirectStatus: 308,
  });
  const result = await runChild(applyArgv(), env);
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /CVM \/sign\/payload request failed/i);
  assert.equal(redirectedRequests.length, 1);
  assert.ok(redirectedRequests[0].body.length > 0);
  assert.equal(secondStageRequests.length, 0);
  assert.equal(
    secondStageRequests.reduce((size, request) => size + request.body.length, 0),
    0
  );
  assert.equal(harness.broadcasts.length, 0);
});
