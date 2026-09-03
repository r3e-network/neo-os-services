// End-to-end proof of the split's signing plane, on the host (no docker, no
// enclave needed): the real `signer_service` custody binary and the real
// `enclave_host` binary, wired the way the deployment wires them, driven over
// live HTTP.
//
// What it proves, in order:
//   1. a custody vault provisions (admin caller, three role keys, `allow_raw`
//      boundaries, an enclave-host caller token);
//   2. the host connects to it and /health reports both roles materialized
//      with key_source `custody`;
//   3. /keys/derived reports the pinned key's identity, no secrets;
//   4. /sign/payload produces a REAL signature — verified independently by
//     @noble/curves p256 over SHA-256 of the data (the byte contract the
//     merged server's neon-js `wallet.sign` kept);
//   5. an unpinned role still fails closed with the unconfigured 503;
//   6. the host's calls landed in the custody audit trail as the caller it
//      was registered as — the same contract every external caller gets;
//   7. deterministic compute executes inside the Rust host and signs through
//      the same custody boundary, with no alternate Node engine.
//
// Run: node scripts/custody-plane-e2e.mjs   (builds the binaries first)

import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { p256 } from '@noble/curves/p256';

const REPO_ROOT = process.cwd();
const TARGET = join(REPO_ROOT, 'target', 'debug');
const CUSTODY_BIN = join(
  TARGET,
  process.platform === 'win32' ? 'signer_service.exe' : 'signer_service'
);
const HOST_BIN = join(TARGET, process.platform === 'win32' ? 'enclave_host.exe' : 'enclave_host');
const DATA_MESSAGE = Buffer.from('a fulfillment digest the enclave host wants signed');

const failures = [];
function check(condition, description, detail) {
  const verdict = condition ? 'ok' : 'FAIL';
  console.log(`  [${verdict}] ${description}`);
  if (!condition) {
    if (detail !== undefined) console.log(`         detail: ${JSON.stringify(detail)}`);
    failures.push({ description, detail });
  }
}

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

async function waitUntilReachable(url, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.ok || response.status === 503) return await response.json();
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`${label} never became reachable at ${url}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function main() {
  // Always build. An incremental no-op costs a couple of seconds; a stale
  // binary costs a false failure that looks exactly like a contract bug (this
  // script once "proved" the raw lane missing because the exe predated it).
  console.log('building the custody and host binaries...');
  const build = spawnSync(
    'cargo',
    [
      'build',
      '--offline',
      '-p',
      'neo-signer',
      '--bin',
      'signer_service',
      '-p',
      'nitro-enclave-host',
      '--bin',
      'enclave_host',
    ],
    { stdio: 'inherit' }
  );
  if (build.status !== 0) throw new Error('cargo build failed');

  const custodyPort = await freePort();
  const enclavePort = await freePort();
  const custody = `http://127.0.0.1:${custodyPort}`;
  const enclave = `http://127.0.0.1:${enclavePort}`;
  const dataDir = mkdtempSync(join(tmpdir(), 'custody-e2e-'));
  const children = [];

  // The children talk loopback only. An operator shell that exports
  // HTTP_PROXY/HTTPS_PROXY (Clash and friends) would otherwise be inherited by
  // the host's reqwest client, which honors it — and the custody channel would
  // try to leave through a proxy for a socket that never leaves the machine.
  const childEnv = { ...process.env };
  for (const key of [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy',
  ]) {
    delete childEnv[key];
  }

  const stop = () => {
    for (const child of children) {
      // Windows kill() takes down the process but not always cleanly mid-boot,
      // and an orphaned signer_service.exe locks its own binary so the next
      // build fails with "Access is denied". A tree-kill ends the whole job.
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
  process.on('exit', stop);
  process.on('SIGINT', () => process.exit(130));

  try {
    // -- 1. a custody vault ------------------------------------------------
    const provisioned = spawnSync(CUSTODY_BIN, ['provision-admin', 'custody-plane-e2e'], {
      encoding: 'utf8',
      env: { ...childEnv, SIGNER_SERVICE_DATA_DIR: dataDir },
    });
    if (provisioned.status !== 0) throw new Error(`provision-admin failed: ${provisioned.stderr}`);
    const adminToken = provisioned.stdout.trim().split(/\r?\n/).filter(Boolean).pop();
    check(
      typeof adminToken === 'string' && adminToken.length >= 32,
      'custody vault provisions an admin token'
    );

    const custodyEnv = {
      ...childEnv,
      SIGNER_SERVICE_DATA_DIR: dataDir,
      SIGNER_SERVICE_HOST: '127.0.0.1',
      SIGNER_SERVICE_PORT: String(custodyPort),
    };
    children.push(spawn(CUSTODY_BIN, { env: custodyEnv, stdio: 'ignore' }));
    const custodyHealth = await waitUntilReachable(`${custody}/health`, 'custody service');
    check(custodyHealth.status === 'ok', 'custody service opens its vault', custodyHealth);

    const custodyApi = async (method, path, token, body) => {
      const response = await fetch(`${custody}/signer/api/v1${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    };

    // One dedicated raw-only key per host role, per network (§4.3).
    const roleKeys = {};
    for (const [role, label] of [
      ['worker', 'e2e-worker'],
      ['updater', 'e2e-updater'],
      ['oracle_verifier', 'e2e-verifier'],
    ]) {
      const created = await custodyApi('POST', '/keys', adminToken, { label, network: 'testnet' });
      check(created.status === 200, `custody generates the ${role} key`, created);
      // A boundary is saved as a whole — the policy body is a full replacement,
      // not a patch — so read the key's current boundary and flip `allow_raw`.
      const current = await custodyApi('GET', `/keys/${created.body.key_id}/policy`, adminToken);
      const policy = { ...current.body.policy, allow_raw: true };
      const saved = await custodyApi(
        'POST',
        `/keys/${created.body.key_id}/policy`,
        adminToken,
        policy
      );
      check(
        saved.status === 200 && saved.body.policy.allow_raw === true,
        `${role} key's allow_raw boundary opens`,
        saved
      );
      roleKeys[role] = created.body;
    }

    const hostCaller = await custodyApi('POST', '/callers', adminToken, {
      label: 'enclave-host',
      capabilities: ['raw_sign'],
      key_grant: {
        mode: 'only',
        key_ids: Object.values(roleKeys).map((key) => key.key_id),
      },
    });
    check(
      hostCaller.status === 200,
      'custody registers the enclave host as a raw-sign caller',
      hostCaller
    );

    // -- 2. the host connects ---------------------------------------------
    const hostToken = randomBytes(24).toString('hex');
    const hostChild = spawn(HOST_BIN, {
      env: {
        ...childEnv,
        NODE_ENV: 'test',
        HOST: '127.0.0.1',
        ENCLAVE_PORT: String(enclavePort),
        MORPHEUS_NETWORK: 'testnet',
        NITRO_API_TOKEN: hostToken,
        SIGNER_SERVICE_URL: custody,
        SIGNER_SERVICE_TOKEN: hostCaller.body.token,
        SIGNER_ROLE_WORKER_KEY_ID: roleKeys.worker.key_id,
        SIGNER_ROLE_UPDATER_KEY_ID: roleKeys.updater.key_id,
        SIGNER_ROLE_ORACLE_VERIFIER_KEY_ID: roleKeys.oracle_verifier.key_id,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    hostChild.stdout.on('data', (chunk) => process.stdout.write(`[host] ${chunk}`));
    hostChild.stderr.on('data', (chunk) => process.stderr.write(`[host!] ${chunk}`));
    children.push(hostChild);
    const hostHealth = await waitUntilReachable(`${enclave}/health`, 'enclave host').catch(
      (error) => {
        throw new Error(`${error.message} (host output above)`);
      }
    );
    check(
      hostHealth.key_source.updater === 'custody',
      '/health key_source.updater reads custody',
      hostHealth.key_source
    );
    check(
      hostHealth.key_source.oracle_verifier === 'custody',
      '/health key_source.oracle_verifier reads custody',
      hostHealth.key_source
    );
    check(
      hostHealth.checks.signer === true,
      '/health reports the signer plane ready',
      hostHealth.checks
    );
    check(
      hostHealth.network === 'testnet',
      '/health resolves the provisioned network',
      hostHealth.network
    );

    // -- 3. /keys/derived ---------------------------------------------------
    const derived = await fetch(`${enclave}/keys/derived`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${hostToken}` },
      body: JSON.stringify({ role: 'updater' }),
    }).then((r) => r.json());
    check(derived.key_source === 'custody', '/keys/derived reports its key_source', derived);
    check(
      derived.neo_n3.address === roleKeys.updater.address,
      '/keys/derived reports the pinned key address',
      derived.neo_n3
    );
    check(
      derived.neo_n3.public_key === roleKeys.updater.public_key,
      '/keys/derived reports the pinned public key',
      derived.neo_n3
    );

    // -- 4. a real signature ------------------------------------------------
    const signReply = await fetch(`${enclave}/sign/payload`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${hostToken}` },
      body: JSON.stringify({ key_role: 'updater', data_hex: DATA_MESSAGE.toString('hex') }),
    });
    const signed = await signReply.json();
    check(signReply.status === 200 && signed.status === 'ok', '/sign/payload answers ok', signed);
    check(signed.key_source === 'custody', '/sign/payload names its key_source', signed);
    check(
      signed.key_id === roleKeys.updater.key_id,
      '/sign/payload names the pinned key',
      signed.key_id
    );
    check(
      signed.public_key === roleKeys.updater.public_key,
      '/sign/payload returns the pinned public key',
      signed.public_key
    );
    check(
      signed.signature === signed.signature_hex,
      '/sign/payload keeps the merged signature aliases',
      signed.signature_hex
    );
    check(
      /^[0-9a-f]{128}$/.test(signed.signature),
      'the signature is 64 bytes of hex',
      signed.signature
    );

    const verified = p256.verify(
      Buffer.from(signed.signature, 'hex'),
      createHash('sha256').update(DATA_MESSAGE).digest(),
      Buffer.from(signed.public_key, 'hex')
    );
    check(
      verified,
      'the signature verifies under @noble p256 over SHA-256(data) — the neon-js byte contract'
    );

    // -- 5. an unpinned role still fails closed ----------------------------
    const unpinned = await fetch(`${enclave}/sign/payload`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${hostToken}` },
      body: JSON.stringify({ key_role: 'relayer', data_hex: DATA_MESSAGE.toString('hex') }),
    });
    const unpinnedBody = await unpinned.json();
    check(unpinned.status === 503, 'an unpinned role answers the unconfigured 503', unpinnedBody);
    check(
      unpinnedBody.error === 'relayer signer is not configured or does not match pinned identity',
      "the unconfigured 503 keeps the merged server's message",
      unpinnedBody.error
    );

    // -- 6. the host's calls are audited under its own caller ----------------
    const audit = await custodyApi('GET', '/audit?limit=500', adminToken);
    const rawSigned = audit.body.entries.filter((row) => row.action === 'signer-raw-signed');
    check(
      rawSigned.length >= 1,
      'the raw signatures landed in the custody audit trail',
      rawSigned.length
    );
    check(
      rawSigned.every((row) => row.caller_id === hostCaller.body.caller.id),
      'every audited signature names the enclave-host caller',
      rawSigned.map((row) => row.caller_id)
    );

    // -- 7. deterministic compute executes in the Rust host -----------------
    const computed = await fetch(`${enclave}/compute/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${hostToken}` },
      body: JSON.stringify({ function: 'hash.sha256', input: { z: 1 } }),
    });
    const computedBody = await computed.json();
    check(
      computed.status === 200 && computedBody.mode === 'builtin',
      'the Rust host executes the builtin compute lane in-process',
      { status: computed.status, body: computedBody }
    );
    check(
      typeof computedBody.result?.digest === 'string' &&
        /^[0-9a-f]{64}$/.test(computedBody.result.digest),
      'the in-process compute result carries a SHA-256 digest',
      computedBody
    );
    check(
      typeof computedBody.signature === 'string' && /^[0-9a-f]{128}$/.test(computedBody.signature),
      'the compute result signs through custody without a local key',
      computedBody
    );
    const computeAudit = await custodyApi('GET', '/audit?limit=500', adminToken);
    check(
      computeAudit.body.entries.some(
        (row) =>
          row.action === 'signer-raw-signed' &&
          row.key_id === roleKeys.worker.key_id &&
          row.caller_id === hostCaller.body.caller.id
      ),
      'the compute signature is audited under the worker key and enclave-host caller',
      computeAudit.body.entries
    );
  } finally {
    stop();
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }

  if (failures.length > 0) {
    console.error(`\ncustody-plane-e2e: ${failures.length} failure(s)`);
    process.exitCode = 1;
  } else {
    console.log('\ncustody-plane-e2e: all checks passed');
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
