// Exercise one actual process, not a model of its dispatcher. Tokens are
// deliberately synthetic local fixtures; this suite never contacts a network.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { resolve } from 'node:path';

const binary = resolve(process.env.CARGO_TARGET_DIR || 'target', 'debug/enclave_host');
const profiles = {
  mainnet: { MORPHEUS_RUNTIME_TOKEN: 'local-mainnet-fixture-unique' },
  testnet: { MORPHEUS_RUNTIME_TOKEN: 'local-testnet-fixture-unique' },
};
const children = new Set();
let base;
async function start(config) {
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  await new Promise((r) => server.close(r));
  const child = spawn(binary, [], {
    env: {
      PATH: process.env.PATH,
      HOST: '127.0.0.1',
      PORT: String(port),
      TOKIO_WORKER_THREADS: '2',
      MORPHEUS_NETWORK: 'mainnet',
      MORPHEUS_RUNTIME_TOKEN: 'global-token-must-not-be-inherited',
      NITRO_API_TOKEN: 'ambient-api-fixture',
      NITRO_SIGNER_TOKEN: 'ambient-signer-fixture',
      NITRO_SHARED_SECRET: 'ambient-shared-fixture',
      MORPHEUS_NETWORK_PROFILES_JSON: config,
    },
    stdio: 'ignore',
  });
  let launchError;
  child.on('error', (error) => {
    launchError = error;
  });
  children.add(child);
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (launchError) throw launchError;
    if (child.exitCode !== null || child.signalCode !== null) return { child, url, exited: true };
    try {
      await fetch(`${url}/mainnet/health`, { signal: AbortSignal.timeout(500) });
      return { child, url, exited: false };
    } catch {
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  throw new Error('local enclave binary did not start');
}
before(async () => {
  const built = spawnSync(
    'cargo',
    [
      'build',
      '--jobs',
      '1',
      '--locked',
      '--offline',
      '-p',
      'nitro-enclave-host',
      '--bin',
      'enclave_host',
    ],
    { stdio: 'pipe', timeout: 240000 }
  );
  assert.equal(built.status, 0, built.stderr?.toString());
  ({ url: base } = await start(JSON.stringify(profiles)));
});
after(async () => {
  await Promise.all(
    [...children].map(
      (child) =>
        new Promise((r) => {
          if (!child.pid || child.exitCode !== null || child.signalCode !== null) return r();
          const deadline = setTimeout(() => child.kill('SIGKILL'), 2000);
          child.once('exit', () => {
            clearTimeout(deadline);
            r();
          });
          child.kill();
        })
    )
  );
});
async function request(path, { token, body, headers = {} } = {}) {
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...headers, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(3000),
  });
  return { status: response.status, body: await response.json() };
}
test('one process keeps concurrent mainnet and testnet requests in their context', async () => {
  const replies = await Promise.all(
    Array.from({ length: 12 }, async (_, i) => {
      const network = i % 2 ? 'testnet' : 'mainnet';
      const reply = await request(`/${network}/health`);
      return [network, reply];
    })
  );
  for (const [network, reply] of replies) {
    assert.equal(reply.body.network, network);
    assert.equal(reply.status, 503); // No keys provisioned: never ready by accident.
    assert.equal(reply.body.ready, false);
  }
});
test('profile tokens cannot authorize the other network or inherit global credentials', async () => {
  for (const network of ['mainnet', 'testnet']) {
    const other = network === 'mainnet' ? 'testnet' : 'mainnet';
    for (const token of [
      profiles[other].MORPHEUS_RUNTIME_TOKEN,
      'global-token-must-not-be-inherited',
      'ambient-api-fixture',
      'ambient-signer-fixture',
      'ambient-shared-fixture',
    ]) {
      assert.equal((await request(`/${network}/sign/payload`, { token, body: {} })).status, 401);
    }
    const own = await request(`/${network}/sign/payload`, {
      token: profiles[network].MORPHEUS_RUNTIME_TOKEN,
      body: { key_role: 'worker', data_hex: '0102' },
    });
    assert.equal(own.status, 503);
    assert.match(own.body.error, /worker signer is not configured/); // Unconfigured custody must still refuse signing.
  }
});
test('dual mode requires explicit network selection', async () => {
  assert.equal((await request('/health')).status, 400);
  const selected = await request('/health', { headers: { 'x-morpheus-network': 'testnet' } });
  assert.equal(selected.body.network, 'testnet');
});
test('unknown, encoded, nested and conflicting network routes fail closed', async () => {
  for (const path of [
    '/staging/health',
    '/mainnet/testnet/health',
    '/%6dainnet/health',
    '//testnet/health',
  ]) {
    assert.ok([400, 404].includes((await request(path)).status), path);
  }
  for (const label of ['testnet', 'staging', 'mainnet, testnet', '']) {
    assert.equal(
      (await request('/mainnet/health', { headers: { 'x-morpheus-network': label } })).status,
      400
    );
  }
});
test('payload and query network assertions cannot contradict the selected context', async () => {
  for (const network of ['mainnet', 'testnet']) {
    const other = network === 'mainnet' ? 'testnet' : 'mainnet';
    const token = profiles[network].MORPHEUS_RUNTIME_TOKEN;
    for (const alias of ['network', 'morpheus_network', 'runtime_network', 'environment']) {
      const reply = await request(`/${network}/sign/payload`, {
        token,
        body: { key_role: 'worker', data_hex: '0102', [alias]: other },
      });
      assert.equal(reply.status, 400);
      assert.match(reply.body.error, /network disagrees with selected context/);
      assert.equal((await request(`/${network}/health?${alias}=${other}`)).status, 400);
    }
    for (const query of [
      `network=${other}`,
      `network=${network}&network=${other}`,
      `network=${other}&network=${network}`,
      `network=${network}&network=${network}`,
      `%6eetwork=${network}&network=${network}`,
      'network=',
      'network=unknown',
    ]) {
      assert.equal((await request(`/${network}/health?${query}`)).status, 400);
    }
  }
});
test('invalid profile configuration prevents the listener from starting', async () => {
  const invalid = [
    '{}',
    '{"mainnet":{}}',
    '{"mainnet":{},"testnet":{},"staging":{}}',
    '{"mainnet":{},"mainnet":{},"testnet":{}}',
    '{"mainnet":{"MORPHEUS_NETWORK":"testnet"},"testnet":{}}',
    '{"mainnet":{"NODE_ENV":"development"},"testnet":{}}',
    '{"mainnet":{"MORPHEUS_RUNTIME_TOKEN":"x","MORPHEUS_RUNTIME_TOKEN":"y"},"testnet":{}}',
  ];
  for (const config of invalid) {
    const result = await start(config);
    assert.equal(result.exited, true, 'invalid profile map reached the listener');
    assert.equal(result.child.exitCode, 1);
  }
});

function rawRequest(path, headers = {}) {
  return new Promise((resolve, reject) => {
    const origin = new URL(base);
    const request = httpRequest(
      { hostname: origin.hostname, port: origin.port, path, headers },
      (response) => {
        response.resume();
        response.once('end', () => resolve(response.statusCode));
      }
    );
    request.setTimeout(2000, () => request.destroy(new Error('raw HTTP timeout')));
    request.once('error', reject);
    request.end();
  });
}

test('raw HTTP cannot normalize dot paths or combine duplicate physical headers', async () => {
  for (const path of [
    '/mainnet/../testnet/health',
    '/mainnet/./health',
    '/mainnet/%2e%2e/testnet/health',
    '/mainnet%2fhealth',
    '/mainnet\\health',
  ]) {
    assert.equal(await rawRequest(path), 400, path);
  }
  for (const values of [
    ['mainnet', 'testnet'],
    ['testnet', 'mainnet'],
    ['mainnet', 'mainnet'],
  ]) {
    assert.equal(await rawRequest('/mainnet/health', { 'x-morpheus-network': values }), 400);
  }
  assert.equal(await rawRequest('/mainnet/health', { 'x-morpheus-network': 'mainnet' }), 503);
});

test('conflicting selectors refuse public and provisioning routes before their effects', async () => {
  for (const route of [
    '/oracle/public-key',
    '/attestation',
    '/provision',
    '/provision/credentials',
  ]) {
    const reply = await request(`/mainnet${route}`, {
      headers: { 'x-morpheus-network': 'testnet' },
      ...(route.startsWith('/provision') ? { body: {} } : {}),
    });
    assert.equal(reply.status, 400, route);
    assert.match(reply.body.error, /conflicting network selectors/);
  }
});
