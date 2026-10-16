// Real HTTP regression for the historical chain-family meaning of `network`.
// Only repository golden vectors and loopback processes are used. The
// development decrypt fixture isolates routing; the compute full-gate test
// separately exercises the binding/chain gate with synthetic chain IO.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const binary = resolve(process.env.CARGO_TARGET_DIR || 'target', 'debug/enclave_host');
const vectors = readFileSync('workers/nitro-enclave-host/tests/unit/oracle_read.rs', 'utf8');
const fixture = (name) => vectors.match(new RegExp(`const ${name}: &str =\\s*"([^"]+)";`))[1];
const key = JSON.stringify({
  algorithm: 'X25519-HKDF-SHA256',
  public_key_raw: fixture('GOLDEN_PUBLIC_KEY_RAW_B64'),
  private_key_pkcs8: fixture('GOLDEN_PRIVATE_KEY_PKCS8_B64'),
});
const envelope = Buffer.from(
  vectors.match(/const GOLDEN_ENVELOPE_JSON: &str = r#"(.*?)"#;/)[1]
).toString('base64');
const profiles = Object.fromEntries(
  ['mainnet', 'testnet'].map((network) => [
    network,
    {
      MORPHEUS_RUNTIME_TOKEN: `synthetic-family-${network}`,
      MORPHEUS_ORACLE_KEY_MATERIAL_JSON: key,
      MORPHEUS_ORACLE_DECRYPT_REQUIRE_BINDING: '0',
    },
  ])
);
const children = [];
const contexts = [];

async function call(context, path, body) {
  const response = await fetch(`${context.base}${context.prefix}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${profiles[context.network].MORPHEUS_RUNTIME_TOKEN}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(3000),
  });
  return { status: response.status, body: await response.json() };
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
  for (const dual of [false, true]) {
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
        MORPHEUS_NETWORK: 'testnet',
        ...(dual ? { MORPHEUS_NETWORK_PROFILES_JSON: JSON.stringify(profiles) } : profiles.testnet),
      },
      stdio: 'ignore',
    });
    children.push(child);
    let error;
    child.on('error', (e) => {
      error = e;
    });
    const base = `http://127.0.0.1:${port}`;
    let started = false;
    for (let i = 0; i < 150; i++) {
      if (error) throw error;
      assert.equal(child.exitCode, null, 'fixture process must stay alive');
      try {
        await fetch(`${base}/${dual ? 'testnet/' : ''}health`, {
          signal: AbortSignal.timeout(200),
        });
        started = true;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    assert.ok(started, 'local fixture must start');
    for (const network of dual ? ['mainnet', 'testnet'] : ['testnet']) {
      contexts.push({ base, prefix: dual ? `/${network}` : '', network, dual });
    }
  }
});

after(async () => {
  await Promise.all(
    children.map(
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

test('direct and nested decrypt preserve all supported family aliases', async () => {
  for (const context of contexts) {
    for (const network of [
      'neox',
      ' NEO_X ',
      'Neo-X',
      '\uFEFFneox\uFEFF',
      '\uFEFFNEO_X\uFEFF',
      '\uFEFFNeo-X\uFEFF',
    ]) {
      const payload = { envelope, network };
      const direct = await call(context, '/oracle/decrypt', payload);
      assert.equal(
        direct.status,
        200,
        JSON.stringify({ ...context, network, result: direct.body })
      );
      assert.ok(JSON.stringify(direct.body).includes('golden-vector-1'));
      const nested = await call(context, '/automation/execute', {
        automation_id: 'family-compatibility',
        idempotency_key: `${context.dual}-${context.network}-${network}`,
        execution: { request_type: 'decrypt', payload },
      });
      assert.equal(nested.status, 200);
      assert.ok(JSON.stringify(nested.body).includes('golden-vector-1'));
    }
  }
});

test('message reveal reaches its chain gate with each family alias', async () => {
  for (const context of contexts) {
    for (const network of [
      'neox',
      ' NEO_X ',
      'Neo-X',
      '\uFEFFneox\uFEFF',
      '\uFEFFNEO_X\uFEFF',
      '\uFEFFNeo-X\uFEFF',
    ]) {
      const common = {
        messageId: '1',
        signature: 'synthetic-not-a-signature',
        issuedAt: Math.floor(Date.now() / 1000),
      };
      const family = await call(context, '/oracle/message-reveal', { ...common, network });
      const control = await call(context, '/oracle/message-reveal', { ...common, chain: network });
      assert.equal(control.status, 503); // No RPC: not successful chain reveal.
      assert.deepEqual(family, control);
    }
  }
});

test('a family alias never exempts another deployment selector', async () => {
  for (const context of contexts.filter((c) => c.dual)) {
    const other = context.network === 'mainnet' ? 'testnet' : 'mainnet';
    for (const alias of ['morpheus_network', 'runtime_network', 'environment']) {
      const payload = { envelope, network: '\uFEFFneox\uFEFF', [alias]: other };
      assert.equal((await call(context, '/oracle/decrypt', payload)).status, 400);
      assert.equal(
        (
          await call(context, '/automation/execute', {
            automation_id: 'family-conflict',
            idempotency_key: `${context.network}-${alias}`,
            execution: { request_type: 'decrypt', payload },
          })
        ).status,
        400
      );
    }
    assert.equal(
      (await call(context, '/oracle/decrypt', { envelope, network: other })).status,
      400
    );
    for (const path of [
      '/compute/execute',
      '/oracle/query',
      '/oracle/smart-fetch',
      '/neodid/bind',
    ]) {
      assert.equal((await call(context, path, { network: 'neox' })).status, 400);
    }
    assert.equal(
      (await call(context, '/oracle/decrypt', { envelope, network: 'neo_n3' })).status,
      400
    );
  }
});

test('non-JavaScript whitespace does not become a valid family alias', async () => {
  for (const context of contexts) {
    for (const label of ['neox', 'NEO_X', 'Neo-X']) {
      const payload = { envelope, network: `\u0085${label}\u0085` };
      // The legacy direct development fixture disables the core binding gate.
      // Direct NEL refusal is covered here only at the dual selector; the
      // separate core full-gate probe covers the protocol-level rejection.
      if (context.dual) assert.equal((await call(context, '/oracle/decrypt', payload)).status, 400);
      assert.equal(
        (
          await call(context, '/automation/execute', {
            automation_id: 'family-nel-negative',
            idempotency_key: `${context.dual}-${context.network}-${label}`,
            execution: { request_type: 'decrypt', payload },
          })
        ).status,
        400
      );
    }
  }
});
