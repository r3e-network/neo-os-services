// HTTP-boundary parity gate for the Rust enclave host (bin/enclave_host.rs).
//
// The dispatch fixtures already port to Rust unit tests (workers/
// nitro-enclave-host/tests/unit) and drive `dispatch()` without a socket.
// This suite is the OTHER half of the Phase 4 parity plan: the HTTP transport
// the Node `createServer` defined and the Rust bin must reproduce byte for
// byte — headers, body cap, method guards, route-prefix semantics and the
// fail-closed signing plane — asserted over real sockets against the real
// binary.
//
// Three host instances isolate the env-dependent surfaces:
//   A. the default cap (256 KiB) + one trusted token;
//   B. ENCLAVE_MAX_BODY_BYTES=1024 (the minimum) — the override + min clamp;
//   C. a placeholder token only ("changeme") — the trusted set must stay
//      closed, answering "not configured", never accepting the guess.
//
// The signing plane here is unconfigured (no SIGNER_SERVICE_URL): every
// /sign/payload answer is the exact 503 the merged server produced, which is
// itself part of the contract. /health is the same parity story: the merged
// server answers 200 only when ready (enclave-server.mjs:1928). Since the
// Rust-only image folded every compute lane in-process, a host with the child
// disabled is compute-ready — these instances are degraded purely because no
// signing plane is configured, and the suite pins that 503 body byte for byte.
//
// Run: node --test deploy/nitro/enclave-host.test.mjs

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
// Spawn the binary the before() hook just built. cargo writes it under
// CARGO_TARGET_DIR when that is set (a relative value resolves against the
// directory cargo runs in, REPO_ROOT); a fixed ./target path would then start a
// stale binary, or none at all.
const TARGET_DIR = process.env.CARGO_TARGET_DIR
  ? resolve(REPO_ROOT, process.env.CARGO_TARGET_DIR)
  : join(REPO_ROOT, 'target');
const HOST_BIN = join(
  TARGET_DIR,
  'debug',
  process.platform === 'win32' ? 'enclave_host.exe' : 'enclave_host'
);
const RUNTIME = 'morpheus-enclave-server';
const TOKEN_ENV_KEYS = [
  'NITRO_SIGNER_TOKEN',
  'MORPHEUS_RUNTIME_TOKEN',
  'NITRO_API_TOKEN',
  'NITRO_SHARED_SECRET',
];

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

const children = [];
const stopAll = () => {
  for (const child of children) {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' });
    } else {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }
  }
};
process.on('exit', stopAll);
process.on('SIGINT', () => process.exit(130));

// A clean env: no inherited proxy (the children talk loopback only) and none
// of the trusted-token keys — each instance then declares exactly the tokens
// it tests.
function baseEnv() {
  const env = { ...process.env };
  for (const key of [
    ...TOKEN_ENV_KEYS,
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy',
  ]) {
    delete env[key];
  }
  return env;
}

async function spawnHost(extraEnv) {
  const port = await freePort();
  const child = spawn(HOST_BIN, {
    env: {
      ...baseEnv(),
      HOST: '127.0.0.1',
      ENCLAVE_PORT: String(port),
      MORPHEUS_NETWORK: 'testnet',
      ...extraEnv,
    },
    stdio: 'ignore',
  });
  children.push(child);
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      // These hosts run with no signer configured, so they are permanently
      // degraded and /health answers 503 — the merged server's own rule (200
      // only when ready). Reachable therefore means any HTTP answer bearing
      // the runtime name, not response.ok.
      const response = await fetch(`${base}/health`);
      if (response.status === 200 || response.status === 503) {
        const body = await response.json();
        if (body.runtime === RUNTIME) return { child, base };
      }
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      throw new Error(`enclave host never became reachable on ${base}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

let hostA;
let hostB;
let hostC;

before(async () => {
  const build = spawnSync(
    'cargo',
    [
      'build',
      '--locked',
      '--offline',
      '--jobs',
      '1',
      '-p',
      'nitro-enclave-host',
      '--bin',
      'enclave_host',
    ],
    { stdio: 'inherit', cwd: REPO_ROOT }
  );
  assert.equal(build.status, 0, 'cargo build for enclave_host must succeed');

  hostA = await spawnHost({ NITRO_API_TOKEN: 'parity-suite-token' });
  hostB = await spawnHost({
    NITRO_API_TOKEN: 'parity-suite-token',
    ENCLAVE_MAX_BODY_BYTES: '1024',
  });
  hostC = await spawnHost({ NITRO_API_TOKEN: 'changeme' });
});

after(stopAll);

// -- transport shape ---------------------------------------------------------

test('GET /health answers the degraded readiness body with no-store', async () => {
  const response = await fetch(`${hostA.base}/health`);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-type') || '', /application\/json/);
  const body = await response.json();
  assert.equal(body.runtime, RUNTIME);
  assert.equal(body.network, 'testnet');
  assert.equal(body.status, 'degraded');
  assert.equal(body.ready, false);
  // Deliberate divergence from the merged server, which answered `false`
  // here because its compute lived in the child: the folded host serves
  // compute itself, so the loopback port is not on the readiness path.
  assert.equal(body.checks.compute, true);
  assert.equal(body.checks.signer, false);
  assert.deepEqual(body.key_source, {
    updater: 'none',
    oracle_verifier: 'none',
    relayer: 'none',
    worker: 'none',
    neox_updater: 'none',
    neox_verifier: 'none',
  });
  for (const role of Object.keys(body.key_source)) {
    assert.equal(body.checks[`${role}_ready`], false);
  }
  assert.equal(body.plaintext_key_provision_allowed, false);
});

test('HEAD falls through to the catch-all 404 with an empty body', async () => {
  // The merged server's ONLY HEAD special-case is reading no body
  // (enclave-server.mjs:2049); HEAD matches no route, so dispatch 404s it
  // and Node suppresses the body. The bin mirrors that: is_head renders the
  // dispatch outcome with an empty body, whatever status dispatch produced.
  const response = await fetch(`${hostA.base}/health`, { method: 'HEAD' });
  assert.equal(response.status, 404);
  assert.equal(await response.text(), '');
});

test('an unknown path answers the dispatch catch-all 404 shape', async () => {
  const response = await fetch(`${hostA.base}/nowhere`);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'not found', path: '/nowhere' });
});

// -- bearer auth -------------------------------------------------------------

test('a sensitive route without a token answers 401 unauthorized', async () => {
  const response = await fetch(`${hostA.base}/sign/payload`, { method: 'POST' });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), {
    status: 'error',
    error: 'unauthorized',
    runtime: RUNTIME,
  });
});

test('a wrong token answers 401, never the route', async () => {
  const response = await fetch(`${hostA.base}/sign/payload`, {
    method: 'POST',
    headers: { authorization: 'Bearer not-the-token' },
  });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, 'unauthorized');
});

test('the bearer scheme is case-insensitive and the token headers fall back in order', async () => {
  const forms = [
    { authorization: `Bearer ${'parity-suite-token'}` },
    { authorization: `bearer ${'parity-suite-token'}` },
    { 'x-nitro-token': 'parity-suite-token' },
    { 'x-runtime-token': 'parity-suite-token' },
  ];
  for (const headers of forms) {
    const response = await fetch(`${hostA.base}/sign/payload`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ key_role: 'updater', data_hex: '00' }),
    });
    assert.notEqual(response.status, 401, `form ${JSON.stringify(headers)} must authenticate`);
  }
});

test('a placeholder token keeps the trusted set closed', async () => {
  // changeme is a copied-env-example value: resolution refuses it, so even a
  // request presenting it exactly must not authenticate — and the 401 says
  // the set is EMPTY, which is the tell that the placeholder never entered it.
  const noToken = await fetch(`${hostC.base}/sign/payload`, { method: 'POST' });
  assert.equal(noToken.status, 401);
  assert.equal((await noToken.json()).error, 'runtime authorization is not configured');
  const guessed = await fetch(`${hostC.base}/sign/payload`, {
    method: 'POST',
    headers: { authorization: 'Bearer changeme' },
  });
  assert.equal(guessed.status, 401);
  assert.equal((await guessed.json()).error, 'runtime authorization is not configured');
});

// -- route semantics ---------------------------------------------------------

test('a single leading path segment routes — whatever it names; two do not', async () => {
  const routed = await fetch(`${hostA.base}/mainnet/sign/payload`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer parity-suite-token' },
    body: JSON.stringify({ key_role: 'updater', data_hex: '00' }),
  });
  assert.equal(routed.status, 503, '/mainnet/sign/payload must reach the signing plane');

  // Parity is exact here, including the loose end: the merged prefix check is
  // "exactly one segment matching [A-Za-z0-9._-]+" (enclave-server.mjs:1907),
  // so 'evil' qualifies and /evil/sign/payload routes too. What does NOT
  // route is anything the end-anchored indexOf rejects — an extra segment.
  const evilSingle = await fetch(`${hostA.base}/evil/sign/payload`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer parity-suite-token' },
    body: JSON.stringify({ key_role: 'updater', data_hex: '00' }),
  });
  assert.equal(evilSingle.status, 503, 'a single arbitrary segment is a valid prefix too');

  const extra = await fetch(`${hostA.base}/evil/extra/sign/payload`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer parity-suite-token' },
    body: JSON.stringify({ key_role: 'updater', data_hex: '00' }),
  });
  assert.equal(extra.status, 404);
  assert.deepEqual(await extra.json(), {
    error: 'not found',
    path: '/evil/extra/sign/payload',
  });
});

test('a method the route does not serve falls through to the catch-all 404', async () => {
  const response = await fetch(`${hostA.base}/provision`);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'not found', path: '/provision' });
});

// -- body cap ----------------------------------------------------------------

test('a body over the default cap answers 413 before dispatch', async () => {
  const response = await fetch(`${hostA.base}/sign/payload`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer parity-suite-token' },
    body: 'x'.repeat(262_145),
  });
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), {
    status: 'error',
    error: 'request body too large',
  });
});

test('ENCLAVE_MAX_BODY_BYTES overrides the cap and clamps to 1 KiB', async () => {
  const tooBig = await fetch(`${hostB.base}/sign/payload`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer parity-suite-token' },
    body: JSON.stringify({ pad: 'x'.repeat(2000) }),
  });
  assert.equal(tooBig.status, 413);
  assert.deepEqual(await tooBig.json(), { status: 'error', error: 'request body too large' });

  const under = await fetch(`${hostB.base}/sign/payload`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer parity-suite-token' },
    body: JSON.stringify({ key_role: 'updater', data_hex: '00' }),
  });
  assert.equal(under.status, 503, 'a body under the 1 KiB floor must reach dispatch');
});

// -- the fail-closed signing plane ------------------------------------------

test('an unconfigured signing plane answers the exact merged 503 for any role', async () => {
  for (const role of ['updater', 'oracle_verifier', 'relayer']) {
    const response = await fetch(`${hostA.base}/sign/payload`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer parity-suite-token' },
      body: JSON.stringify({ key_role: role, data_hex: '00' }),
    });
    assert.equal(response.status, 503, role);
    assert.deepEqual(await response.json(), {
      status: 'error',
      error: `${role} signer is not configured or does not match pinned identity`,
      runtime: RUNTIME,
    });
  }
});

test('/keys/derived with no custody reports the unconfigured state', async () => {
  const response = await fetch(`${hostA.base}/keys/derived`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer parity-suite-token' },
    body: JSON.stringify({ role: 'updater' }),
  });
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.status, 'error');
  assert.match(body.error, /updater signer is not configured/);
});

test('a malformed JSON body is a dispatch failure, not a crash', async () => {
  const response = await fetch(`${hostA.base}/sign/payload`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer parity-suite-token' },
    body: 'not-json{',
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.status, 'error');
  assert.equal(body.runtime, RUNTIME);
});

// -- boot --------------------------------------------------------------------

test('an unreviewed MORPHEUS_NETWORK stops the host before it listens', async () => {
  const port = await freePort();
  // A host that started serving would block here until the timeout kills it.
  const result = spawnSync(HOST_BIN, {
    env: {
      ...baseEnv(),
      HOST: '127.0.0.1',
      ENCLAVE_PORT: String(port),
      NITRO_API_TOKEN: 'parity-suite-token',
      MORPHEUS_NETWORK: 'staging',
    },
    encoding: 'utf8',
    timeout: 20_000,
  });
  assert.equal(result.status, 1, `stderr: ${result.stderr}`);
  assert.match(
    result.stderr,
    /refusing to serve — invalid runtime network: unsupported Neo network: staging/
  );
  assert.equal(result.stdout, '', 'the host must not report that it is listening');
  await assert.rejects(fetch(`http://127.0.0.1:${port}/health`), 'nothing may listen on the port');
});

test('an unknown FEED_PRICE_PLANE stops the host before it listens', async () => {
  const port = await freePort();
  // The price plane is dark and default-off (DEC-CU-30). An operator who types
  // `public_quorum` must not be served by the single-source plane they thought
  // they had replaced, so an unknown label is a refusal rather than a fallback.
  const result = spawnSync(HOST_BIN, {
    env: {
      ...baseEnv(),
      HOST: '127.0.0.1',
      ENCLAVE_PORT: String(port),
      NITRO_API_TOKEN: 'parity-suite-token',
      MORPHEUS_NETWORK: 'testnet',
      FEED_PRICE_PLANE: 'public_quorum',
    },
    encoding: 'utf8',
    timeout: 20_000,
  });
  assert.equal(result.status, 1, `stderr: ${result.stderr}`);
  assert.match(
    result.stderr,
    /refusing to serve — invalid FEED_PRICE_PLANE "public_quorum"; expected "twelvedata" or "public-quorum"/
  );
  assert.equal(result.stdout, '', 'the host must not report that it is listening');
  await assert.rejects(fetch(`http://127.0.0.1:${port}/health`), 'nothing may listen on the port');
});
