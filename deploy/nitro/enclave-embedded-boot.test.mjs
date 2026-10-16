// Loopback process controls: explicit custody configuration must never be ignored.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve } from 'node:path';

const binary = resolve(process.env.CARGO_TARGET_DIR || 'target', 'debug/enclave_host');
before(() => {
  const result = spawnSync(
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
    { timeout: 240000, encoding: 'utf8' }
  );
  assert.equal(result.status, 0, result.stderr);
});

async function boot(extra) {
  const reservation = createServer();
  await new Promise((r) => reservation.listen(0, '127.0.0.1', r));
  const port = reservation.address().port;
  await new Promise((r) => reservation.close(r));
  const child = spawn(binary, [], {
    env: {
      PATH: process.env.PATH,
      HOST: '127.0.0.1',
      PORT: String(port),
      MORPHEUS_NETWORK: 'testnet',
      TOKIO_WORKER_THREADS: '2',
      ...extra,
    },
    stdio: 'ignore',
  });
  let exited;
  const done = new Promise((r) =>
    child.once('exit', (code, signal) => {
      exited = { code, signal };
      r();
    })
  );
  try {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      if (exited)
        return exited.code !== 0 && exited.signal === null ? 'refused' : 'unexpected-exit';
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, {
          signal: AbortSignal.timeout(100),
        });
        // Liveness only: unconfigured legacy health is correctly 503, and
        // unselected dual-network health is 400. Either proves a listener.
        await response.arrayBuffer();
        return 'listening';
      } catch {
        /* Startup is asynchronous; retry until exit or loopback readiness. */
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    return 'no-observed-outcome';
  } finally {
    if (!exited) child.kill('SIGTERM');
    const kill = setTimeout(() => {
      if (!exited) child.kill('SIGKILL');
    }, 1000);
    await done;
    clearTimeout(kill);
  }
}

test('an explicit missing custody profile refuses before the listener', async () => {
  assert.equal(
    await boot({
      MORPHEUS_CUSTODY_PROFILE_FILE: '/nonexistent/neoos-test-profile.json',
      MORPHEUS_CUSTODY_PROFILE_SHA256: '11'.repeat(32),
      MORPHEUS_CUSTODY_DATA_DIR: '/nonexistent/neoos-test-vault',
      MORPHEUS_CUSTODY_WORKLOAD_AUDIENCE: 'https://test.example',
    }),
    'refused'
  );
});

test('a partial custody configuration refuses instead of falling back to HTTP', async () => {
  assert.equal(await boot({ MORPHEUS_CUSTODY_PROFILE_SHA256: '11'.repeat(32) }), 'refused');
});

test('production dual-network boot requires both embedded vaults', async () => {
  for (const NODE_ENV of ['production', ' Production ']) {
    assert.equal(
      await boot({
        NODE_ENV,
        MORPHEUS_NETWORK_PROFILES_JSON: JSON.stringify({ mainnet: {}, testnet: {} }),
      }),
      'refused'
    );
  }
});

test('unconfigured development legacy mode remains observable', async () => {
  assert.equal(await boot({}), 'listening');
});
