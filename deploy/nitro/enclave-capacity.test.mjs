// Real loopback HTTP with incomplete request bodies. No provider or signer is
// configured; these fixtures cannot call cloud services or produce signatures.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { connect, createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { resolve } from 'node:path';

const binary = resolve(process.env.CARGO_TARGET_DIR || 'target', 'debug/enclave_host');
const children = new Set();
const sockets = new Set();

before(() => {
  const result = spawnSync(
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
    { timeout: 180000, stdio: 'pipe' }
  );
  assert.equal(result.status, 0, result.stderr?.toString());
});

after(async () => {
  for (const socket of sockets) socket.destroy();
  await Promise.all(
    [...children].map(
      (child) =>
        new Promise((done) => {
          if (!child.pid || child.exitCode !== null || child.signalCode !== null) return done();
          const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
          child.once('exit', () => {
            clearTimeout(timer);
            done();
          });
          child.kill();
        })
    )
  );
});

async function start(dual, profiles = { mainnet: {}, testnet: {} }) {
  const listener = createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const child = spawn(binary, [], {
    env: {
      PATH: process.env.PATH,
      HOST: '127.0.0.1',
      PORT: String(port),
      TOKIO_WORKER_THREADS: '2',
      MORPHEUS_NETWORK: 'mainnet',
      ...(dual ? { MORPHEUS_NETWORK_PROFILES_JSON: JSON.stringify(profiles) } : {}),
    },
    stdio: 'ignore',
  });
  let spawnError;
  child.on('error', (e) => {
    spawnError = e;
  });
  children.add(child);
  const health = `http://127.0.0.1:${port}/${dual ? 'mainnet/' : ''}health`;
  for (let i = 0; i < 100; i++) {
    if (spawnError) throw spawnError;
    assert.equal(child.exitCode, null, 'host must stay alive');
    try {
      const reply = await fetch(health, { signal: AbortSignal.timeout(200) });
      const body = await reply.json();
      assert.equal(body.network, 'mainnet');
      assert.equal(body.ready, false);
      return { port, health };
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  assert.fail('host did not become observable');
}

test('slow bodies time out and release capacity', { timeout: 16000 }, async () => {
  const { port, health } = await start(false);
  const held = await incompleteBody(port, '/compute/execute');
  assert.equal(held.status, 100);
  try {
    const final = await new Promise((resolve, reject) => {
      let text = '';
      const timer = setTimeout(() => reject(new Error('body timeout did not fire')), 12000);
      held.socket.on('data', (chunk) => {
        text += chunk.toString();
        if (text.includes('request body timed out')) {
          clearTimeout(timer);
          resolve(text);
        }
      });
    });
    assert.match(final, /HTTP\/1\.1 408/);
  } finally {
    held.socket.destroy();
  }
  assert.equal(
    (await (await fetch(health, { signal: AbortSignal.timeout(1000) })).json()).network,
    'mainnet'
  );
});

test('client cancellation does not release running blocking work', { timeout: 15000 }, async () => {
  const replies = [];
  const custody = createHttpServer((req, res) => {
    replies.push(res);
  });
  await new Promise((resolve) => custody.listen(0, '127.0.0.1', resolve));
  const controllers = [];
  const pending = [];
  try {
    const { port, health } = await start(true, {
      mainnet: {},
      testnet: {
        SIGNER_SERVICE_URL: `http://127.0.0.1:${custody.address().port}`,
        SIGNER_SERVICE_TOKEN: 'local-custody-fixture-only',
        SIGNER_ROLE_WORKER_KEY_ID: 'local-worker-fixture',
      },
    });
    for (let i = 0; i < 16; i++) {
      const controller = new AbortController();
      controllers.push(controller);
      pending.push(
        fetch(`http://127.0.0.1:${port}/testnet/health`, { signal: controller.signal }).catch(
          () => null
        )
      );
    }
    for (let i = 0; i < 150 && replies.length !== 16; i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(replies.length, 16, 'all actual custody reads must enter the blocking plane');
    controllers.forEach((c) => c.abort());
    await Promise.all(pending);
    await new Promise((resolve) => setTimeout(resolve, 100));
    // Observe admission before dispatch: a wrongly admitted health request
    // would queue behind the blocked workers and hide the defect in a timeout.
    const admission = await incompleteBody(port, '/mainnet/compute/execute');
    try {
      assert.equal(admission.status, 503, 'disconnected blocking work must retain its slots');
    } finally {
      admission.socket.destroy();
    }
    const refused = await fetch(health, { signal: AbortSignal.timeout(1000) });
    assert.equal((await refused.json()).error, 'enclave request capacity exhausted');
    replies.forEach((res) => {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end('{"code":"fixture-unavailable"}');
    });
    let recovered = false;
    for (let i = 0; i < 100; i++) {
      const body = await (await fetch(health, { signal: AbortSignal.timeout(1000) })).json();
      if (body.network === 'mainnet') {
        recovered = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(recovered, 'completed blocking work must release global capacity');
  } finally {
    controllers.forEach((c) => c.abort());
    replies.forEach((res) => res.destroy());
    custody.closeAllConnections();
    await new Promise((resolve) => custody.close(resolve));
  }
});

function incompleteBody(port, path) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port });
    sockets.add(socket);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('HTTP admission did not respond'));
    }, 3000);
    let text = '';
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on('data', (chunk) => {
      text += chunk.toString();
      const match = text.match(/^HTTP\/1\.1 (\d{3})/);
      if (match) {
        clearTimeout(timer);
        resolve({ socket, status: Number(match[1]) });
      }
    });
    socket.once('connect', () =>
      socket.write(
        `POST ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Length: 100\r\nContent-Type: application/json\r\nExpect: 100-continue\r\n\r\n`
      )
    );
  });
}

for (const dual of [false, true]) {
  test(`one process bounds in-flight bodies ${dual ? 'across both networks' : 'in single-network compatibility mode'}`, async () => {
    const { port, health } = await start(dual);
    const requests = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        incompleteBody(
          port,
          dual ? `/${i % 2 ? 'testnet' : 'mainnet'}/compute/execute` : '/compute/execute'
        )
      )
    );
    try {
      assert.equal(
        requests.filter((r) => r.status === 100).length,
        16,
        'one shared budget must gate body admission'
      );
      assert.equal(
        requests.filter((r) => r.status === 503).length,
        4,
        'excess work must reject without an unbounded queue'
      );
      const rejected = await fetch(health, { signal: AbortSignal.timeout(1000) });
      assert.equal(rejected.status, 503);
      assert.equal(rejected.headers.get('retry-after'), '1');
      assert.equal((await rejected.json()).error, 'enclave request capacity exhausted');
    } finally {
      requests.forEach(({ socket }) => socket.destroy());
    }
    let recovered = false;
    for (let i = 0; i < 50; i++) {
      const reply = await fetch(health, { signal: AbortSignal.timeout(1000) });
      const body = await reply.json();
      if (body.network === 'mainnet') {
        recovered = true;
        assert.equal(body.ready, false);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(recovered, 'aborted body readers must release their slots');
  });
}
