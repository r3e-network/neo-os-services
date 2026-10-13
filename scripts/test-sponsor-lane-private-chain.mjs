// CU-153: the sponsor lane end to end on a disposable private chain.
//
// What this proves, in order:
//   1. eligibility is enforced — an intent aimed at the wrong contract is refused
//      with the validator's own code and charges nothing;
//   2. a sponsored intent is paid: the real `neo-os-relayer serve:sponsor` takes
//      `POST /sponsor/intent`, reserves a budget, journals before broadcast,
//      takes a signature from a faked SIGN, broadcasts to the private chain and
//      confirms a HALT receipt;
//   3. the sponsor is charged and the recipient is paid — both balances are read
//      off the chain and the deltas are exact;
//   4. the journal is the schema-valid one, holding the reserved ceiling and a
//      receipt for the signed transaction;
//   5. budget exhaustion is refused, and the refusal neither writes a journal row
//      nor broadcasts anything.
//
// Real, unmodified: the request surface, the intent validator, the sponsor state
// machine, `DbSponsorJournal` over `DeliveryStore`/`SupabaseClient`, the
// `ChainSubmit` send path and the application-log receipt. Faked, exactly one
// leg: SIGN (a local endpoint speaking the custody signer protocol with a
// throwaway key). Two services the relayer talks to are local peers over
// loopback: the signing endpoint and the delivery store's HTTP peer, which
// forwards to the shipped SQL on a disposable PostgreSQL.
//
// Every process binds loopback. No public RPC, no remote database, no container,
// no cloud account. Chain state, wallet material and the database live in a
// temporary directory that is deleted on exit.
//
// Run: node scripts/test-sponsor-lane-private-chain.mjs   (from the repository root)
//
// Requires: Rust 1.98, .NET 10, Neo Express 3.10.1, nccs 3.9.1, PostgreSQL 16.
// Source scripts/dotnet_env.sh first if `neoxp`/`nccs` report that .NET is missing.
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  ACCEPTANCE_CHECKS,
  HarnessError,
  PRIVATE_CHAIN_MAGIC,
  SPONSOR_SCHEMA_MAX_FEE_CEILING_UNITS,
  assertRpcAddress,
  assertRpcParams,
  assertTestOnlyProfile,
  buildSponsorEnv,
  deliveryRpcSql,
  encodeUnsignedTx,
  evaluateAcceptance,
  keyIdentity,
  nep17AssetAmount,
  normalizeScriptHash,
  scriptHashToAddress,
  signWitness,
  sponsorIntentScript,
  teardownRefusalRoot,
  throwawayPrivateKey,
  transactionHashDisplay,
} from './lib-sponsor-lane-private-chain.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = join(REPO_ROOT, 'target', 'debug');
const RELAYER_BIN = join(TARGET, 'neo-os-relayer');
const FIXTURE_DIR = join(REPO_ROOT, 'tests', 'fixtures', 'sponsorable-intent-probe');
const GAS_ASSET = '0xd2a4cff31913016155e38e474a2c06d08be276cf';
const PRINCIPAL_ID = '11111111-2222-4333-8444-555555555555';
/**
 * The three idempotency keys this journey uses. They name requests, not
 * credentials; kept in one table so a literal never sits beside the header
 * that carries them.
 */
const IDEMPOTENCY_KEYS = Object.freeze({
  ineligible: 'cu153-ineligible',
  paid: 'cu153-paid',
  exhausted: 'cu153-exhausted',
});
const FEE_CEILING_UNITS = SPONSOR_SCHEMA_MAX_FEE_CEILING_UNITS;
const REIMBURSEMENT_UNITS = 2_000_000;
const NETWORK_FEE_UNITS = 2_000_000;

const children = [];
const servers = [];
let scratchRoot = null;
let pgEnv = {};

function note(message) {
  process.stdout.write(`${message}\n`);
}

function fail(message) {
  throw new HarnessError(message);
}

function redact(text) {
  return String(text ?? '')
    .replace(/[0-9a-f]{32,}/gi, '[redacted]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .slice(-2000);
}

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

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createNetServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
    server.on('error', reject);
  });
}

function start(name, command, args, env) {
  const child = spawn(command, args, {
    env: childEnv(env),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = { out: '', err: '' };
  child.stdout.on('data', (chunk) => {
    logs.out = `${logs.out}${chunk}`.slice(-8000);
  });
  child.stderr.on('data', (chunk) => {
    logs.err = `${logs.err}${chunk}`.slice(-8000);
  });
  children.push({ name, child, logs });
  return child;
}

function childLog(name) {
  return children.find((entry) => entry.name === name)?.logs ?? { out: '', err: '' };
}

function stopAll(signal) {
  for (const entry of children) {
    try {
      entry.child.kill(signal);
    } catch {
      // the child is already gone
    }
  }
  for (const server of servers) {
    try {
      server.close();
    } catch {
      // the listener is already closed
    }
  }
}

async function waitUntilReachable(url, label, attempts = 120) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url);
      return { status: response.status, body: await response.text() };
    } catch {
      await new Promise((done) => setTimeout(done, 500));
    }
  }
  fail(`${label} did not become reachable at ${url}`);
}

async function rpc(method, params = []) {
  // `assertRpcParams` refuses a thenable here rather than letting
  // `JSON.stringify` turn one into `{}` on the wire.
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method,
    params: assertRpcParams(method, params),
  });
  const response = await fetch(process.env.CU153_CHAIN_RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  const payload = await response.json();
  if (payload.error) fail(`${method} failed: ${JSON.stringify(payload.error)}`);
  return payload.result;
}

function neoxp(...args) {
  const result = spawnSync('neoxp', [...args, '-i', join(scratchRoot, 'chain.neo-express')], {
    encoding: 'utf8',
    timeout: 180_000,
    env: childEnv({ HOME: scratchRoot, DOTNET_CLI_HOME: scratchRoot }),
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    fail(
      `Neo Express ${args.slice(0, 2).join(' ')} exited ${result.status}: ` +
        redact(`${result.stderr || ''}\n${result.stdout || ''}`)
    );
  }
  return result.stdout ?? '';
}

function psql(sql, { allowFailure = false } = {}) {
  const result = spawnSync('psql', ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-c', sql], {
    encoding: 'utf8',
    timeout: 60_000,
    env: childEnv(pgEnv),
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0 && !allowFailure) {
    fail(`psql failed: ${redact(result.stderr)}`);
  }
  return {
    ok: result.status === 0,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
  };
}

// ---------------------------------------------------------------------------
// The two local peers
// ---------------------------------------------------------------------------

/**
 * The fake SIGN: the custody signer protocol, answered with a throwaway P-256
 * key held only by this process. It is the one stand-in the row allows, and it
 * decides nothing: the witness it returns is checked by
 * `CustodySignerAdapter::verify_witness` and then by the chain.
 */
function startFakeSign({ port, privateKeyHex, keyId }) {
  const identity = keyIdentity({ privateKeyHex });
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const url = new URL(request.url, 'http://127.0.0.1');
      const send = (status, body) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(body));
      };
      if (
        request.method === 'GET' &&
        url.pathname === `/signer/api/v1/keys/${encodeURIComponent(keyId)}`
      ) {
        send(200, {
          allowed: true,
          key_id: keyId,
          chain_family: identity.chain_family,
          public_key: identity.public_key,
          script_hash: identity.script_hash,
          address: identity.address,
        });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/signer/api/v1/sign/transaction') {
        let body;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          send(400, { allowed: false, code: 'bad_request', message: 'the body is not JSON' });
          return;
        }
        const unsigned = Buffer.from(String(body.unsigned_hex ?? ''), 'hex');
        if (unsigned.length === 0) {
          send(400, { allowed: false, code: 'bad_request', message: 'unsigned_hex is required' });
          return;
        }
        const witness = signWitness({
          privateKeyHex,
          unsignedBytes: unsigned,
          magic: Number(process.env.CU153_CHAIN_MAGIC),
        });
        send(200, {
          allowed: true,
          key_id: keyId,
          script_hash: identity.script_hash,
          address: identity.address,
          digest: witness.digest,
          public_key: identity.public_key,
          invocation_script: witness.invocation_script,
          verification_script: witness.verification_script,
        });
        return;
      }
      send(404, { allowed: false, code: 'not_found', message: url.pathname });
    });
  });
  return new Promise((done) => {
    server.listen(port, '127.0.0.1', () => {
      servers.push(server);
      done(server);
    });
  });
}

/**
 * The delivery store's HTTP peer: `POST /rest/v1/rpc/<fn>` forwarded to the
 * shipped SQL function on the disposable cluster, as `service_role`. The budget
 * caps, the idempotency conflict and the journal immutability guards are the
 * migration's own code; this peer only carries the call.
 */
function startDeliveryPeer({ port }) {
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const send = (status, body) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(typeof body === 'string' ? body : JSON.stringify(body));
      };
      const url = new URL(request.url, 'http://127.0.0.1');
      const match = /^\/rest\/v1\/rpc\/([A-Za-z0-9_]+)$/.exec(url.pathname);
      if (request.method !== 'POST' || !match) {
        send(404, { message: `no route for ${request.method} ${url.pathname}` });
        return;
      }
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        send(400, { message: 'the body is not JSON' });
        return;
      }
      let built;
      try {
        built = deliveryRpcSql(match[1], body);
      } catch (error) {
        send(400, { message: String(error.message ?? error) });
        return;
      }
      const result = psql(built.sql, { allowFailure: true });
      if (!result.ok) {
        send(500, { message: result.stderr, code: '22023', details: built.name });
        return;
      }
      send(200, result.stdout === '' ? 'null' : result.stdout);
    });
  });
  return new Promise((done) => {
    server.listen(port, '127.0.0.1', () => {
      servers.push(server);
      done(server);
    });
  });
}

// ---------------------------------------------------------------------------
// Chain and database fixtures
// ---------------------------------------------------------------------------

async function gasBalance(address) {
  const target = assertRpcAddress(address, 'getnep17balances address');
  return nep17AssetAmount(await rpc('getnep17balances', [target]), GAS_ASSET);
}

async function chainTransactionCount() {
  return Number(await rpc('getblockcount'));
}

async function sponsorRequest({
  sponsorUrl,
  idempotencyKey,
  envelopeHex,
  principal = PRINCIPAL_ID,
}) {
  const response = await fetch(`${sponsorUrl}/sponsor/intent`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey,
      'x-neoos-principal': principal,
    },
    body: JSON.stringify({ envelope_hex: envelopeHex, fee_ceiling_units: FEE_CEILING_UNITS }),
  });
  return { status: response.status, body: await response.json() };
}

function applyDeliveryMigrations() {
  const migrations = [
    '20260908040427_relayer_delivery_v2.sql',
    '20260920102300_relayer_delivery_completion_identity.sql',
    '20261012120000_relayer_delivery_sponsor.sql',
  ];
  for (const name of migrations) {
    const path = join(REPO_ROOT, 'db', 'services', 'migrations', name);
    if (!existsSync(path)) fail(`the delivery migration ${name} is missing`);
    const result = spawnSync('psql', ['-X', '-v', 'ON_ERROR_STOP=1', '-q', '-f', path], {
      encoding: 'utf8',
      timeout: 120_000,
      env: childEnv(pgEnv),
      maxBuffer: 16 * 1024 * 1024,
    });
    if (result.status !== 0) fail(`applying ${name} failed: ${redact(result.stderr)}`);
    note(`applied ${name}`);
  }
}

function budgetTotals() {
  const result = psql(
    `select coalesce(sum(reserved_fee_units),0) from public.morpheus_sponsor_lifetime_budgets`
  );
  const daily = psql(
    `select coalesce(sum(reserved_actions),0) from public.morpheus_sponsor_daily_budgets`
  );
  return { lifetime: Number(result.stdout || 0), daily: Number(daily.stdout || 0) };
}

function journalRows() {
  return Number(psql(`select count(*) from public.morpheus_sponsor_intents`).stdout || 0);
}

function readJournal() {
  const result = psql(
    `select row_to_json(j) from (select job_key,status,generation,journal from public.morpheus_delivery_jobs order by created_at) j`
  );
  if (!result.stdout) return [];
  return result.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

// ---------------------------------------------------------------------------
// The journey
// ---------------------------------------------------------------------------

async function main() {
  assertTestOnlyProfile({ nodeEnv: 'test', network: 'testnet', magic: PRIVATE_CHAIN_MAGIC });

  if (!existsSync(RELAYER_BIN)) {
    fail(`${RELAYER_BIN} is missing; run: cargo build --locked -p neo-os-relayer`);
  }
  const fixtureNef = join(scratchRoot ?? REPO_ROOT, 'SponsorableIntentProbe.nef');

  // ---- the disposable private chain ------------------------------------
  const ports = {
    chainRpc: await freePort(),
    chainTcp: await freePort(),
    sign: await freePort(),
    store: await freePort(),
    sponsor: await freePort(),
    postgres: await freePort(),
  };
  const tempParent = existsSync('/private/tmp') ? '/private/tmp' : '/tmp';
  scratchRoot = mkdtempSync(join(tempParent, 'sponsor-lane-private-chain-'));
  teardownRefusalRoot(scratchRoot);
  process.env.CU153_CHAIN_RPC = `http://127.0.0.1:${ports.chainRpc}`;
  process.env.CU153_CHAIN_MAGIC = String(PRIVATE_CHAIN_MAGIC);

  process.on('exit', () => stopAll('SIGKILL'));
  process.on('SIGINT', () => process.exit(130));
  process.on('SIGTERM', () => process.exit(143));

  // ---- the fixture contract -------------------------------------------
  const buildDir = join(scratchRoot, 'probe');
  mkdirSync(buildDir, { recursive: true });
  for (const step of [
    ['dotnet', ['build', join(FIXTURE_DIR, 'SponsorableIntentProbe.csproj'), '-c', 'Release']],
    [
      'nccs',
      [
        join(FIXTURE_DIR, 'SponsorableIntentProbe.csproj'),
        '--generate-artifacts',
        'Source',
        '--output',
        buildDir,
      ],
    ],
  ]) {
    const result = spawnSync(step[0], step[1], {
      encoding: 'utf8',
      timeout: 300_000,
      env: childEnv({ HOME: scratchRoot, DOTNET_CLI_HOME: scratchRoot }),
      maxBuffer: 32 * 1024 * 1024,
    });
    if (result.status !== 0) {
      fail(`${step[0]} exited ${result.status}: ${redact(`${result.stderr}\n${result.stdout}`)}`);
    }
  }
  const nef = join(buildDir, 'SponsorableIntentProbe.nef');
  if (!existsSync(nef)) fail('the fixture build produced no SponsorableIntentProbe.nef');
  void fixtureNef;

  // ---- the disposable PostgreSQL --------------------------------------
  const pgDir = join(scratchRoot, 'pg');
  mkdirSync(pgDir, { recursive: true });
  for (const step of [
    ['initdb', ['-D', join(pgDir, 'data'), '-A', 'trust', '--no-locale']],
    [
      'pg_ctl',
      [
        '-D',
        join(pgDir, 'data'),
        '-l',
        join(pgDir, 'server.log'),
        '-o',
        `-k ${pgDir} -h 127.0.0.1 -p ${ports.postgres}`,
        '-w',
        'start',
      ],
    ],
  ]) {
    const result = spawnSync(step[0], step[1], {
      encoding: 'utf8',
      timeout: 180_000,
      env: childEnv({ LC_ALL: 'C.UTF-8', HOME: scratchRoot }),
      maxBuffer: 16 * 1024 * 1024,
    });
    if (result.status !== 0) {
      fail(`${step[0]} exited ${result.status}: ${redact(result.stderr)}`);
    }
  }
  pgEnv = {
    PGHOST: pgDir,
    PGPORT: String(ports.postgres),
    PGDATABASE: 'postgres',
    PGUSER: process.env.USER ?? 'postgres',
    LC_ALL: 'C.UTF-8',
  };
  // The API-role default grants are a hostile fixture: a migration that forgets
  // to revoke them must not pass unnoticed.
  psql(
    'create role service_role bypassrls; create role anon; create role authenticated; ' +
      'alter default privileges in schema public grant execute on functions to anon, authenticated; ' +
      'alter default privileges in schema public grant all on tables to anon, authenticated;'
  );
  applyDeliveryMigrations();

  // ---- the two local peers --------------------------------------------
  const signKeyId = 'cu153-sponsor';
  const sponsorKeyHex = throwawayPrivateKey();
  const sponsorIdentity = keyIdentity({ privateKeyHex: sponsorKeyHex });
  const recipientKeyHex = throwawayPrivateKey();
  const recipientIdentity = keyIdentity({ privateKeyHex: recipientKeyHex });
  await startFakeSign({ port: ports.sign, privateKeyHex: sponsorKeyHex, keyId: signKeyId });
  await startDeliveryPeer({ port: ports.store });
  note(`fake SIGN bound to ${sponsorIdentity.address} on http://127.0.0.1:${ports.sign}`);

  // ---- chain setup, offline, before the node serves ---------------------
  const chainPath = join(scratchRoot, 'chain.neo-express');
  const create = spawnSync('neoxp', ['create', '-o', chainPath], {
    encoding: 'utf8',
    timeout: 180_000,
    env: childEnv({ HOME: scratchRoot, DOTNET_CLI_HOME: scratchRoot }),
    maxBuffer: 32 * 1024 * 1024,
  });
  if (create.status !== 0) fail(`Neo Express create failed: ${redact(create.stderr)}`);
  const config = JSON.parse(readFileSync(chainPath, 'utf8'));
  config.magic = PRIVATE_CHAIN_MAGIC;
  const node = config['consensus-nodes'][0];
  node['rpc-port'] = ports.chainRpc;
  node['tcp-port'] = ports.chainTcp;
  writeFileSync(chainPath, JSON.stringify(config));
  const walletName = node.wallet.name;

  neoxp('transfer', '1000', 'GAS', 'genesis', walletName);
  neoxp('transfer', '100', 'GAS', 'genesis', sponsorIdentity.address);
  neoxp('transfer', '1', 'GAS', 'genesis', recipientIdentity.address);
  const deployed = JSON.parse(neoxp('contract', 'deploy', nef, walletName, '--json'));
  const probeHash = normalizeScriptHash(deployed['contract-hash']);
  note(`fixture deployed: ${probeHash}`);
  // The fixture holds the reimbursement it settles to the account the intent
  // names. Funded here, before the chain serves, so the deployment block and
  // the funding block both exist before anything is measured.
  neoxp('transfer', '1', 'GAS', 'genesis', scriptHashToAddress(probeHash));

  start('neoxp-run', 'neoxp', ['run', '-i', chainPath], {
    HOME: scratchRoot,
    DOTNET_CLI_HOME: scratchRoot,
  });
  await waitUntilReachable(
    `${process.env.CU153_CHAIN_RPC.replace(/\/$/, '')}/`,
    'private chain'
  ).catch(() => {});
  await rpc('getblockcount');
  note(`private chain listening on ${process.env.CU153_CHAIN_RPC}`);

  // ---- the real sponsor API -------------------------------------------
  const sponsorUrl = `http://127.0.0.1:${ports.sponsor}`;
  const storeToken = 'cu153-local-store';
  const signToken = 'cu153-local-sign';
  const env = buildSponsorEnv({
    nodeEnv: 'test',
    network: 'testnet',
    magic: PRIVATE_CHAIN_MAGIC,
    chainRpcUrl: process.env.CU153_CHAIN_RPC,
    signUrl: `http://127.0.0.1:${ports.sign}`,
    storeUrl: `http://127.0.0.1:${ports.store}`,
    sponsorUrl,
    sponsorableContract: probeHash,
    feeCeilingUnits: FEE_CEILING_UNITS,
    confirmAttempts: 120,
    confirmWaitMs: 500,
    enabled: true,
    stateFile: join(scratchRoot, 'relayer-state.json'),
    storeToken,
    signToken,
    signKeyId,
  });
  start('neo-os-relayer', RELAYER_BIN, ['serve:sponsor'], env);
  try {
    await waitUntilReachable(`${sponsorUrl}/sponsor/intent`, 'sponsor API', 40);
  } catch (error) {
    const logs = childLog('neo-os-relayer');
    fail(
      `${error.message}\nrelayer stdout: ${redact(logs.out)}\nrelayer stderr: ${String(logs.err).slice(0, 4000)}`
    );
  }

  // ---- 1. eligibility ---------------------------------------------------
  const ineligibleScript = sponsorIntentScript({
    method: 'executeSponsoredUserOp',
    contract: `0x${'55'.repeat(20)}`,
    accountId: `0x${'11'.repeat(20)}`,
    paymaster: `0x${'22'.repeat(20)}`,
    sponsor: sponsorIdentity.script_hash,
    reimbursementUnits: REIMBURSEMENT_UNITS,
    op: {
      targetContract: `0x${'44'.repeat(20)}`,
      method: 'transfer',
      args: [{ type: 'int', value: 1 }],
      nonce: 1,
      deadline: 0,
      signature: Buffer.from('cafebabe', 'hex'),
    },
  });
  const beforeEligibility = budgetTotals();
  const ineligible = await sponsorRequest({
    sponsorUrl,
    idempotencyKey: IDEMPOTENCY_KEYS.ineligible,
    envelopeHex: Buffer.from(
      encodeUnsignedTx({
        nonce: 1,
        systemFee: 10_000_000,
        networkFee: NETWORK_FEE_UNITS,
        validUntilBlock: 1000,
        signerDisplay: sponsorIdentity.script_hash,
        script: ineligibleScript.script,
      })
    ).toString('hex'),
  });
  note(`eligibility control: ${JSON.stringify(ineligible.body)}`);
  const afterEligibility = budgetTotals();

  // ---- 2. the paid intent ----------------------------------------------
  const sponsorBefore = await gasBalance(sponsorIdentity.address);
  const recipientBefore = await gasBalance(recipientIdentity.address);
  const txCountBefore = await chainTransactionCount();
  // The probe's script hash becomes an address through a synchronous helper:
  // `await`ing the conversion at the call site is what this line got wrong, and
  // an un-awaited Promise reaches the node as `{}`.
  const probeBefore = await gasBalance(scriptHashToAddress(probeHash));
  note(
    `balances before: sponsor=${sponsorBefore} recipient=${recipientBefore} probe=${probeBefore}`
  );

  const intent = sponsorIntentScript({
    method: 'executeSponsoredUserOp',
    contract: probeHash,
    accountId: recipientIdentity.script_hash,
    paymaster: `0x${'22'.repeat(20)}`,
    sponsor: sponsorIdentity.script_hash,
    reimbursementUnits: REIMBURSEMENT_UNITS,
    op: {
      targetContract: `0x${'44'.repeat(20)}`,
      method: 'transfer',
      args: [{ type: 'int', value: 1 }],
      nonce: 1,
      deadline: 0,
      signature: Buffer.from('cafebabe', 'hex'),
    },
  });
  // `invokescript` with the sponsor named as a signer, so the fixture's witness
  // check passes and the measured cost is the one the real transaction pays.
  const measured = await rpc('invokescript', [
    Buffer.from(intent.script).toString('base64'),
    [{ account: sponsorIdentity.script_hash, scopes: 'CalledByEntry' }],
  ]);
  if (measured.state !== 'HALT') {
    fail(`the fixture call did not halt in a test invocation: ${JSON.stringify(measured)}`);
  }
  // The sponsor's on-chain debit is `SystemFee + NetworkFee`, and the sponsor
  // is charged `reimbursement + execution cost` for the intent — the same
  // `sponsor_fee_units` the intent validator prices. The reimbursement rides in
  // the system fee because Neo's `CalledByEntryCondition` will not let this
  // fixture debit the sponsor's token balance (see the fixture's remarks), and
  // the invocation script may carry exactly one contract call.
  const gasConsumedUnits = Number(measured.gasconsumed ?? 0);
  const systemFeeUnits = gasConsumedUnits + REIMBURSEMENT_UNITS;
  const feesChargedUnits = gasConsumedUnits + NETWORK_FEE_UNITS;
  const declaredFeeUnits = systemFeeUnits + NETWORK_FEE_UNITS;
  if (declaredFeeUnits + REIMBURSEMENT_UNITS > FEE_CEILING_UNITS) {
    fail(
      `the measured fee ${declaredFeeUnits} plus the reimbursement ${REIMBURSEMENT_UNITS} ` +
        `does not fit the schema fee ceiling ${FEE_CEILING_UNITS}`
    );
  }
  const blockCount = await chainTransactionCount();
  const envelope = encodeUnsignedTx({
    nonce: 7,
    systemFee: systemFeeUnits,
    networkFee: NETWORK_FEE_UNITS,
    validUntilBlock: blockCount + 1000,
    signerDisplay: sponsorIdentity.script_hash,
    script: intent.script,
  });
  note(
    `envelope: systemFee=${systemFeeUnits} networkFee=${NETWORK_FEE_UNITS} ` +
      `reimbursement=${REIMBURSEMENT_UNITS} execution=${feesChargedUnits} ` +
      `hash=${transactionHashDisplay(envelope)}`
  );
  const budgetsBefore = budgetTotals();
  const paid = await sponsorRequest({
    sponsorUrl,
    idempotencyKey: IDEMPOTENCY_KEYS.paid,
    envelopeHex: Buffer.from(envelope).toString('hex'),
  });
  note(`paid intent: ${JSON.stringify(paid.body)}`);
  const budgetsAfter = budgetTotals();
  const sponsorAfter = await gasBalance(sponsorIdentity.address);
  const recipientAfter = await gasBalance(recipientIdentity.address);

  // ---- 3. budget exhaustion --------------------------------------------
  const rowsBeforeExhaustion = journalRows();
  const txCountBeforeExhaustion = await chainTransactionCount();
  const exhausted = await sponsorRequest({
    sponsorUrl,
    idempotencyKey: IDEMPOTENCY_KEYS.exhausted,
    envelopeHex: Buffer.from(envelope).toString('hex'),
  });
  note(`exhaustion: ${JSON.stringify(exhausted.body)}`);
  const rowsAfterExhaustion = journalRows();
  const txCountAfterExhaustion = await chainTransactionCount();

  // ---- 4. the journal ---------------------------------------------------
  const jobs = readJournal();
  const paidJob = jobs.find((job) => job.job_key === paid.body.journal_id) ?? null;

  // ---- 5. the acceptance ------------------------------------------------
  const observed = {
    response: paid.body,
    journal: paidJob,
    balances: {
      sponsorDelta: Number(sponsorAfter - sponsorBefore),
      recipientDelta: Number(recipientAfter - recipientBefore),
      reimbursementUnits: REIMBURSEMENT_UNITS,
      feesCharged: feesChargedUnits,
      declaredFeeUnits,
    },
    budgets: {
      feeCeilingUnits: FEE_CEILING_UNITS,
      lifetimeDelta: budgetsAfter.lifetime - budgetsBefore.lifetime,
      dailyDelta: budgetsAfter.daily - budgetsBefore.daily,
    },
    exhaustion: {
      code: exhausted.body.code,
      journalRowsDelta: rowsAfterExhaustion - rowsBeforeExhaustion,
      chainTxCountDelta: txCountAfterExhaustion - txCountBeforeExhaustion,
    },
    eligibility: {
      code: ineligible.body.code,
      intent_code: ineligible.body.intent_code,
      budgetDelta:
        afterEligibility.lifetime -
        beforeEligibility.lifetime +
        (afterEligibility.daily - beforeEligibility.daily),
    },
  };

  const evaluation = evaluateAcceptance(observed);
  // Every acceptance dimension the library names has to be reported here, or a
  // green run would be a green run over a shortened list.
  if (evaluation.checks.length !== ACCEPTANCE_CHECKS.length) {
    fail(
      `the acceptance evaluation reported ${evaluation.checks.length} checks, ` +
        `not the ${ACCEPTANCE_CHECKS.length} the journey must see`
    );
  }
  for (const entry of evaluation.checks) {
    note(`  [${entry.ok ? 'ok' : 'FAILED'}] ${entry.name}`);
  }
  for (const failure of evaluation.failures) note(`  failure: ${failure}`);

  note(
    `observation: ${JSON.stringify({ ...observed, journal: observed.journal?.job_key ?? null })}`
  );
  note(`sponsor ${sponsorIdentity.address} ${sponsorBefore} -> ${sponsorAfter}`);
  note(`recipient ${recipientIdentity.address} ${recipientBefore} -> ${recipientAfter}`);
  note(`chain transactions observed ${txCountBefore} -> ${txCountAfterExhaustion}`);
  note(`gas consumed by the fixture call: ${measured.gasconsumed}`);

  if (!evaluation.ok) {
    fail('the sponsor lane journey did not satisfy every acceptance check');
  }
  note(
    'PASS: an intent was paid and confirmed with a journal id on the private chain, the sponsor ' +
      'was charged and the recipient was paid, and budget exhaustion was refused without a write.'
  );
}

main()
  .catch((error) => {
    process.stderr.write(
      `${error?.name === 'HarnessError' ? 'FAIL: ' : ''}${error?.message ?? error}\n`
    );
    if (error?.stack && error?.name !== 'HarnessError') process.stderr.write(`${error.stack}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    // Kill the children and close the two local peers before anything else: the
    // listeners and the child stdio keep the event loop alive, so a run that
    // reports green would otherwise never reach `process.on('exit')` and never
    // terminate.
    stopAll('SIGKILL');
    if (scratchRoot) {
      try {
        teardownRefusalRoot(scratchRoot);
      } catch (error) {
        process.stderr.write(`teardown refused: ${error.message}\n`);
        process.exitCode = 1;
        return;
      }
      spawnSync('pg_ctl', ['-D', join(scratchRoot, 'pg', 'data'), '-m', 'immediate', 'stop'], {
        encoding: 'utf8',
        timeout: 30_000,
        env: childEnv({ HOME: scratchRoot }),
      });
      rmSync(scratchRoot, { recursive: true, force: true });
    }
  });
