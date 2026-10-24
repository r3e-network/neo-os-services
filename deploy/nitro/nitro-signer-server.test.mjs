import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'nitro-signer-server.mjs');
const TOKEN = 'unit-test-token';
const CUSTODY_TOKEN = 'custody-caller-token';
const UPDATER_KEY_ID = 'key-updater-test';
const NETWORK_MAGIC = 894710606;
const SIGNATURE_HEX = 'ab'.repeat(64);
const PUBLIC_KEY_HEX = '02'.concat('9a'.repeat(32));
const VERIFICATION_SCRIPT = `0c21${PUBLIC_KEY_HEX}4156e7b327`;
const INVOCATION_SCRIPT = `0c40${SIGNATURE_HEX}`;

// A stand-in custody signer service. It records what the shim forwarded so the
// tests can assert the translation (preimage stripped of its magic, custody
// route, bearer credential) rather than trust that it happened.
const custodyRequests = [];
let custodyRefusal = null;
const custody = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    custodyRequests.push({
      method: req.method,
      url: req.url,
      auth: req.headers.authorization,
      body,
    });
    const json = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    if (custodyRefusal) return json(custodyRefusal.status, custodyRefusal.body);
    if (req.method === 'POST' && req.url === '/signer/api/v1/sign/transaction') {
      return json(200, {
        allowed: true,
        key_id: UPDATER_KEY_ID,
        script_hash: '0x' + '22'.repeat(20),
        address: 'NevYgksywJCzVBQVNMTjDjBWNQGWCqKGpx',
        digest: 'cc'.repeat(32),
        invocation_script: INVOCATION_SCRIPT,
        verification_script: VERIFICATION_SCRIPT,
      });
    }
    if (req.method === 'GET' && req.url === `/signer/api/v1/keys/${UPDATER_KEY_ID}`) {
      return json(200, {
        allowed: true,
        key_id: UPDATER_KEY_ID,
        label: 'updater',
        network: 'testnet',
        public_key: PUBLIC_KEY_HEX,
        script_hash: '0x' + '22'.repeat(20),
        address: 'NevYgksywJCzVBQVNMTjDjBWNQGWCqKGpx',
        verification_script: VERIFICATION_SCRIPT,
        signing_enabled: true,
        network_magic: NETWORK_MAGIC,
      });
    }
    return json(404, { allowed: false, code: 'signer-route-unknown', message: 'no such route' });
  });
});
await new Promise((resolve) => custody.listen(0, '127.0.0.1', resolve));
const CUSTODY_URL = `http://127.0.0.1:${custody.address().port}`;

test.after(() => {
  custody.close();
});

function unsignedTransactionHex() {
  const { tx, sc } = neonJs;
  const transaction = new tx.Transaction({
    nonce: 1,
    validUntilBlock: 100,
    signers: [{ account: 'cd'.repeat(20), scopes: 0x01 }],
    script: new sc.ScriptBuilder()
      .emitAppCall('0x0123456789abcdef0123456789abcdef01234567', 'fulfillRequest', [])
      .build(),
  });
  return transaction.serialize(false);
}

function preimageHex(unsignedHex) {
  const magic = Buffer.alloc(4);
  magic.writeUInt32LE(NETWORK_MAGIC);
  return Buffer.concat([magic, Buffer.from(unsignedHex, 'hex')]).toString('hex');
}

const neonJs = await import('@cityofzion/neon-js');

function buildSignRequest(headers) {
  return buildRequest('/sign/payload', headers, '{}');
}

function buildRequest(pathname, headers, body) {
  return [
    `POST ${pathname} HTTP/1.1`,
    'host: localhost',
    ...headers,
    'content-type: application/json',
    `content-length: ${Buffer.byteLength(body)}`,
    '',
    body,
  ].join('\r\n');
}

function childEnv(token = TOKEN, networkMagic = NETWORK_MAGIC) {
  const env = { ...process.env };
  for (const key of [
    'NITRO_SIGNER_TOKEN',
    'MORPHEUS_RUNTIME_TOKEN',
    'NITRO_API_TOKEN',
    'NITRO_SHARED_SECRET',
  ]) {
    delete env[key];
  }
  if (token) env.NITRO_SIGNER_TOKEN = token;
  env.MORPHEUS_NETWORK = 'testnet';
  env.NEO_NETWORK_MAGIC = String(networkMagic);
  env.SIGNER_SERVICE_URL = CUSTODY_URL;
  env.SIGNER_SERVICE_TOKEN = CUSTODY_TOKEN;
  env.SIGNER_ROLE_UPDATER_KEY_ID = UPDATER_KEY_ID;
  env.SIGNER_ROLE_ORACLE_VERIFIER_KEY_ID = 'key-verifier-test';
  return env;
}

function cleanBootEnv(overrides = {}) {
  const env = childEnv();
  for (const key of [
    'NEO_NETWORK_MAGIC',
    'SIGNER_SERVICE_URL',
    'SIGNER_SERVICE_TOKEN',
    'SIGNER_ROLE_UPDATER_KEY_ID',
    'SIGNER_ROLE_ORACLE_VERIFIER_KEY_ID',
    'SIGNER_ROLE_RELAYER_KEY_ID',
    'SIGNER_ROLE_WORKER_KEY_ID',
  ]) {
    delete env[key];
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = String(value);
  }
  return env;
}

function stdioRequest(rawRequest, token = TOKEN, environment = null) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER, '--stdio'], {
      env: environment || childEnv(token),
      encoding: 'utf8',
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', () => resolve({ stdout, stderr }));
    child.stdin.write(rawRequest);
    child.stdin.end();
  });
}

function stdioRequestWithNetworkMagic(rawRequest, networkMagic) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER, '--stdio'], {
      env: childEnv(TOKEN, networkMagic),
      encoding: 'utf8',
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', () => resolve({ stdout, stderr }));
    child.stdin.write(rawRequest);
    child.stdin.end();
  });
}

const signerChildren = new Set();
test.after(() => {
  for (const child of signerChildren) child.kill('SIGTERM');
});

async function startSigner(environment) {
  const reservation = http.createServer();
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const { port } = reservation.address();
  await new Promise((resolve) => reservation.close(resolve));
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...environment,
      PORT: String(port),
      NITRO_SIGNER_HOST: '127.0.0.1',
    },
    encoding: 'utf8',
  });
  signerChildren.add(child);
  child.on('close', () => signerChildren.delete(child));
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`legacy signer exited before startup: ${output}`);
    }
    try {
      await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(500) });
      return { baseUrl, child };
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  child.kill('SIGTERM');
  throw new Error(`legacy signer did not start: ${output}`);
}

async function postSigner(baseUrl, pathname, body, token = TOKEN) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test('signer refuses a network magic that disagrees with the reviewed registry', async () => {
  const { stdout } = await stdioRequestWithNetworkMagic(
    buildRequest(
      '/sign/payload',
      [`authorization: Bearer ${TOKEN}`],
      JSON.stringify({ key_role: 'updater', data_hex: '00' })
    ),
    42
  );
  assert.match(stdout, /configured Neo N3 magic conflicts with reviewed testnet identity/i);
});

function jsonBody(stdout) {
  return JSON.parse(stdout.split('\r\n\r\n').pop());
}

test('signer rejects a wrong bearer token of the same length', async () => {
  const wrong = 'x'.repeat(TOKEN.length);
  const { stdout } = await stdioRequest(buildSignRequest([`authorization: Bearer ${wrong}`]));
  assert.match(stdout, /^HTTP\/1\.1 401 Unauthorized/);
  assert.match(stdout, /"error":"unauthorized"/);
});

test('signer rejects a wrong token of a different length without crashing', async () => {
  // regression: a bare crypto.timingSafeEqual throws on length mismatch — the
  // length guard must turn this into a clean 401, not a 500
  const { stdout } = await stdioRequest(
    buildSignRequest([`authorization: Bearer ${TOKEN}-extended`])
  );
  assert.match(stdout, /^HTTP\/1\.1 401 Unauthorized/);
});

test('signer accepts the trusted bearer token', async () => {
  // auth passes, then payload validation fires — proving the timing-safe
  // comparison still matches the provisioned token exactly
  const { stdout } = await stdioRequest(buildSignRequest([`authorization: Bearer ${TOKEN}`]));
  assert.doesNotMatch(stdout, /^HTTP\/1\.1 401/);
  assert.match(stdout, /key_role is required and must name a signer role/);
});

test('signer accepts the trusted token via the x-nitro-token header', async () => {
  const { stdout } = await stdioRequest(buildSignRequest([`x-nitro-token: ${TOKEN}`]));
  assert.doesNotMatch(stdout, /^HTTP\/1\.1 401/);
  assert.match(stdout, /key_role is required and must name a signer role/);
});

test('signer rejects a request with no token at all', async () => {
  const { stdout } = await stdioRequest(buildSignRequest([]));
  assert.match(stdout, /^HTTP\/1\.1 401 Unauthorized/);
});

test('signer fails closed when no runtime token is configured', async () => {
  const { stdout } = await stdioRequest(buildSignRequest([`authorization: Bearer ${TOKEN}`]), '');
  assert.match(stdout, /^HTTP\/1\.1 401 Unauthorized/);
  assert.match(stdout, /runtime authorization is not configured/);
});

test('legacy signer refuses plaintext WIF provisioning even for an authorized caller', async () => {
  const payload = JSON.stringify({
    env: { MORPHEUS_UPDATER_NEO_N3_WIF_MAINNET: 'L1hostheldplaintextwif' },
  });
  const { stdout } = await stdioRequest(
    buildRequest('/provision', [`authorization: Bearer ${TOKEN}`], payload)
  );
  assert.match(stdout, /^HTTP\/1\.1 403 Forbidden/);
  assert.match(stdout, /plaintext key provisioning is disabled/);
  assert.match(stdout, /MORPHEUS_UPDATER_NEO_N3_WIF_MAINNET/);
});

test('legacy signer refuses the former allow-plaintext escape hatch', async () => {
  const payload = JSON.stringify({
    env: { MORPHEUS_ALLOW_PLAINTEXT_KEY_PROVISION: '1' },
  });
  const { stdout } = await stdioRequest(
    buildRequest('/provision', [`authorization: Bearer ${TOKEN}`], payload)
  );
  assert.match(stdout, /^HTTP\/1\.1 403 Forbidden/);
  assert.match(stdout, /MORPHEUS_ALLOW_PLAINTEXT_KEY_PROVISION/);
});

test('legacy signer does not allow first-caller token installation', async () => {
  const payload = JSON.stringify({ env: { MORPHEUS_RUNTIME_TOKEN: TOKEN } });
  const selfChosen = await stdioRequest(
    buildRequest('/provision', [`authorization: Bearer ${TOKEN}`], payload),
    ''
  );
  assert.match(selfChosen.stdout, /^HTTP\/1\.1 401 Unauthorized/);
  assert.match(selfChosen.stdout, /legacy signer first provision is disabled/);
});

test('legacy provision accepts one atomic first configuration and rejects later calls', async () => {
  const boot = cleanBootEnv({
    NEO_NETWORK_MAGIC: String(NETWORK_MAGIC),
    SIGNER_SERVICE_URL: CUSTODY_URL,
    SIGNER_SERVICE_TOKEN: CUSTODY_TOKEN,
    SIGNER_ROLE_UPDATER_KEY_ID: UPDATER_KEY_ID,
    SIGNER_ROLE_ORACLE_VERIFIER_KEY_ID: 'key-verifier-test',
  });
  const signer = await startSigner(boot);
  const changedBoot = await postSigner(signer.baseUrl, '/provision', {
    env: {
      NEO_NETWORK_MAGIC: String(NETWORK_MAGIC + 1),
      SIGNER_ROLE_RELAYER_KEY_ID: 'must-not-be-half-merged',
    },
  });
  assert.equal(changedBoot.status, 409);
  assert.match(changedBoot.body.error, /boot value NEO_NETWORK_MAGIC is immutable/);

  const first = await postSigner(signer.baseUrl, '/provision', {
    env: {
      NEO_NETWORK_MAGIC: String(NETWORK_MAGIC),
      SIGNER_SERVICE_URL: CUSTODY_URL,
      SIGNER_SERVICE_TOKEN: CUSTODY_TOKEN,
      SIGNER_ROLE_UPDATER_KEY_ID: UPDATER_KEY_ID,
      SIGNER_ROLE_ORACLE_VERIFIER_KEY_ID: 'key-verifier-test',
      SIGNER_ROLE_WORKER_KEY_ID: 'key-worker-test',
    },
  });
  assert.equal(first.status, 200);
  assert.equal(first.body.provisioned, true);
  assert.deepEqual(first.body.env_keys, [
    'NEO_NETWORK_MAGIC',
    'SIGNER_ROLE_ORACLE_VERIFIER_KEY_ID',
    'SIGNER_ROLE_UPDATER_KEY_ID',
    'SIGNER_ROLE_WORKER_KEY_ID',
    'SIGNER_SERVICE_TOKEN',
    'SIGNER_SERVICE_URL',
  ]);
  const derived = await postSigner(signer.baseUrl, '/keys/derived', { role: 'updater' });
  assert.equal(derived.status, 200);
  assert.equal(derived.body.key_id, UPDATER_KEY_ID);

  const second = await postSigner(signer.baseUrl, '/provision', { env: {} });
  assert.equal(second.status, 409);
  assert.match(second.body.error, /already completed/);
  const halfMergedRole = await postSigner(signer.baseUrl, '/keys/derived', { role: 'relayer' });
  assert.equal(halfMergedRole.status, 503);
  assert.match(halfMergedRole.body.error, /relayer custody key is not provisioned/);
});

test('legacy provision rejects unknown and runtime-token env without consuming the retry', async () => {
  const signer = await startSigner(cleanBootEnv());
  const unknown = await postSigner(signer.baseUrl, '/provision', {
    env: {
      NEO_NETWORK_MAGIC: String(NETWORK_MAGIC),
      SIGNER_ROLE_RELAYER_KEY_ID: 'must-not-be-half-merged',
      UNLISTED_RUNTIME_SETTING: 'forbidden',
    },
  });
  assert.equal(unknown.status, 400);
  assert.match(unknown.body.error, /not allowlisted/);

  const runtimeToken = await postSigner(signer.baseUrl, '/provision', {
    env: { MORPHEUS_RUNTIME_TOKEN: 'provision-installed-token' },
  });
  assert.equal(runtimeToken.status, 403);
  assert.match(runtimeToken.body.error, /boot-only/);

  const first = await postSigner(signer.baseUrl, '/provision', {
    env: { NEO_NETWORK_MAGIC: String(NETWORK_MAGIC) },
  });
  assert.equal(first.status, 200);
  const second = await postSigner(signer.baseUrl, '/provision', {
    env: { NEO_NETWORK_MAGIC: String(NETWORK_MAGIC) },
  });
  assert.equal(second.status, 409);
  const halfMergedRole = await postSigner(signer.baseUrl, '/keys/derived', { role: 'relayer' });
  assert.equal(halfMergedRole.status, 503);
  const installedToken = await postSigner(
    signer.baseUrl,
    '/sign/payload',
    { key_role: 'updater', data_hex: '00' },
    'provision-installed-token'
  );
  assert.equal(installedToken.status, 401);
});

test('legacy provision requires a new custody URL/token pair and allows a failed retry', async () => {
  const signer = await startSigner(cleanBootEnv());
  const unpaired = await postSigner(signer.baseUrl, '/provision', {
    env: {
      NEO_NETWORK_MAGIC: String(NETWORK_MAGIC),
      SIGNER_SERVICE_URL: CUSTODY_URL,
    },
  });
  assert.equal(unpaired.status, 400);
  assert.match(unpaired.body.error, /must be provisioned together/);

  const paired = await postSigner(signer.baseUrl, '/provision', {
    env: {
      NEO_NETWORK_MAGIC: String(NETWORK_MAGIC),
      SIGNER_SERVICE_URL: CUSTODY_URL,
      SIGNER_SERVICE_TOKEN: CUSTODY_TOKEN,
      SIGNER_ROLE_UPDATER_KEY_ID: UPDATER_KEY_ID,
    },
  });
  assert.equal(paired.status, 200);
  const derived = await postSigner(signer.baseUrl, '/keys/derived', { role: 'updater' });
  assert.equal(derived.status, 200);
});

test('legacy provision can add a token to a boot URL but cannot add a URL to a boot token', async () => {
  const signer = await startSigner(
    cleanBootEnv({
      NEO_NETWORK_MAGIC: String(NETWORK_MAGIC),
      SIGNER_SERVICE_URL: CUSTODY_URL,
      SIGNER_ROLE_UPDATER_KEY_ID: UPDATER_KEY_ID,
    })
  );
  const paired = await postSigner(signer.baseUrl, '/provision', {
    env: { SIGNER_SERVICE_TOKEN: CUSTODY_TOKEN },
  });
  assert.equal(paired.status, 200);
  const derived = await postSigner(signer.baseUrl, '/keys/derived', { role: 'updater' });
  assert.equal(derived.status, 200);

  const before = custodyRequests.length;
  const tokenOnly = await stdioRequest(
    buildRequest(
      '/provision',
      [`authorization: Bearer ${TOKEN}`],
      JSON.stringify({ env: { SIGNER_SERVICE_URL: CUSTODY_URL } })
    ),
    TOKEN,
    cleanBootEnv({ SIGNER_SERVICE_TOKEN: CUSTODY_TOKEN })
  );
  assert.match(tokenOnly.stdout, /^HTTP\/1\.1 400 Bad Request/);
  assert.match(tokenOnly.stdout, /cannot be introduced after a boot-only SIGNER_SERVICE_TOKEN/);
  const unconfigured = await stdioRequest(
    buildRequest(
      '/keys/derived',
      [`authorization: Bearer ${TOKEN}`],
      JSON.stringify({ role: 'updater' })
    ),
    TOKEN,
    cleanBootEnv({
      SIGNER_SERVICE_TOKEN: CUSTODY_TOKEN,
      SIGNER_ROLE_UPDATER_KEY_ID: UPDATER_KEY_ID,
    })
  );
  assert.match(unconfigured.stdout, /^HTTP\/1\.1 503 Service Unavailable/);
  assert.equal(custodyRequests.length, before);
});

test('legacy custody requests refuse redirects without contacting the redirect target', async () => {
  let redirectedRequests = 0;
  let targetRequests = 0;
  const target = http.createServer((req, res) => {
    targetRequests += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve));
  const redirect = http.createServer((req, res) => {
    redirectedRequests += 1;
    res.writeHead(302, {
      location: `http://127.0.0.1:${target.address().port}/fake-custody`,
    });
    res.end();
  });
  await new Promise((resolve) => redirect.listen(0, '127.0.0.1', resolve));
  try {
    const signer = await startSigner(
      cleanBootEnv({
        NEO_NETWORK_MAGIC: String(NETWORK_MAGIC),
        SIGNER_SERVICE_URL: `http://127.0.0.1:${redirect.address().port}`,
        SIGNER_SERVICE_TOKEN: CUSTODY_TOKEN,
        SIGNER_ROLE_UPDATER_KEY_ID: UPDATER_KEY_ID,
      })
    );
    const derived = await postSigner(signer.baseUrl, '/keys/derived', { role: 'updater' });
    assert.equal(derived.status, 503);
    assert.match(derived.body.error, /custody signer service unreachable/);
    assert.equal(redirectedRequests, 1);
    assert.equal(targetRequests, 0);
  } finally {
    await Promise.all([
      new Promise((resolve) => redirect.close(resolve)),
      new Promise((resolve) => target.close(resolve)),
    ]);
  }
});

test('signer refuses to act under a defaulted or unmappable role', async () => {
  const absent = await stdioRequest(
    buildRequest('/sign/payload', [`authorization: Bearer ${TOKEN}`], JSON.stringify({}))
  );
  assert.match(absent.stdout, /^HTTP\/1\.1 400 Bad Request/);
  assert.match(absent.stdout, /key_role is required and must name a signer role/);
  const bogus = await stdioRequest(
    buildRequest(
      '/sign/payload',
      [`authorization: Bearer ${TOKEN}`],
      JSON.stringify({ key_role: 'superadmin', data_hex: '00' })
    )
  );
  assert.match(bogus.stdout, /^HTTP\/1\.1 400 Bad Request/);
  assert.match(bogus.stdout, /key_role is required and must name a signer role/);
});

test('signer refuses arbitrary data_hex without contacting custody', async () => {
  const before = custodyRequests.length;
  const { stdout } = await stdioRequest(
    buildRequest(
      '/sign/payload',
      [`authorization: Bearer ${TOKEN}`],
      JSON.stringify({ key_role: 'updater', data_hex: 'deadbeef' })
    )
  );
  assert.match(stdout, /^HTTP\/1\.1 400 Bad Request/);
  assert.match(stdout, /not a translatable request kind/);
  assert.equal(custodyRequests.length, before);
});

test('signer refuses the legacy magic+txid preimage by name', async () => {
  // regression: the relayer's old getMessageForSigning preimage is magic ||
  // reverseHex(txid) — a digest that cannot be policy-checked, so it must get
  // a targeted migration refusal rather than a signature
  const preimage = Buffer.alloc(4);
  preimage.writeUInt32LE(NETWORK_MAGIC);
  const dataHex = Buffer.concat([preimage, Buffer.from('cc'.repeat(32), 'hex')]).toString('hex');
  const before = custodyRequests.length;
  const { stdout } = await stdioRequest(
    buildRequest(
      '/sign/payload',
      [`authorization: Bearer ${TOKEN}`],
      JSON.stringify({ key_role: 'updater', data_hex: dataHex })
    )
  );
  assert.match(stdout, /^HTTP\/1\.1 400 Bad Request/);
  assert.match(stdout, /legacy magic\+txid preimage/);
  assert.equal(custodyRequests.length, before);
});

test('signer refuses a preimage framed for another network magic', async () => {
  const wrong = Buffer.alloc(4);
  wrong.writeUInt32LE(NETWORK_MAGIC + 1);
  const dataHex = Buffer.concat([wrong, Buffer.from(unsignedTransactionHex(), 'hex')]).toString(
    'hex'
  );
  const before = custodyRequests.length;
  const { stdout } = await stdioRequest(
    buildRequest(
      '/sign/payload',
      [`authorization: Bearer ${TOKEN}`],
      JSON.stringify({ key_role: 'updater', data_hex: dataHex })
    )
  );
  assert.match(stdout, /^HTTP\/1\.1 400 Bad Request/);
  assert.match(stdout, /network magic/);
  assert.equal(custodyRequests.length, before);
});

test('signer forwards a translatable preimage to custody as the unsigned transaction', async () => {
  const unsignedHex = unsignedTransactionHex();
  const { stdout } = await stdioRequest(
    buildRequest(
      '/sign/payload',
      [`authorization: Bearer ${TOKEN}`],
      JSON.stringify({ key_role: 'updater', data_hex: preimageHex(unsignedHex) })
    )
  );
  assert.match(stdout, /^HTTP\/1\.1 200 OK/);
  const body = jsonBody(stdout);
  assert.equal(body.status, 'ok');
  assert.equal(body.key_source, 'custody_policy');
  assert.equal(body.key_id, UPDATER_KEY_ID);
  assert.equal(body.signature, SIGNATURE_HEX);
  assert.equal(body.public_key, PUBLIC_KEY_HEX);
  const sent = custodyRequests.at(-1);
  assert.equal(sent.method, 'POST');
  assert.equal(sent.url, '/signer/api/v1/sign/transaction');
  assert.equal(sent.auth, `Bearer ${CUSTODY_TOKEN}`);
  const sentBody = JSON.parse(sent.body);
  assert.equal(sentBody.key_id, UPDATER_KEY_ID);
  // the magic prefix must be stripped: custody receives the unsigned bytes only
  assert.equal(sentBody.unsigned_hex, unsignedHex);
});

test('signer carries a custody policy refusal through to its caller', async () => {
  custodyRefusal = {
    status: 403,
    body: {
      allowed: false,
      code: 'recipient-blacklisted',
      message: 'target contract is not allowlisted',
    },
  };
  try {
    const { stdout } = await stdioRequest(
      buildRequest(
        '/sign/payload',
        [`authorization: Bearer ${TOKEN}`],
        JSON.stringify({ key_role: 'updater', data_hex: preimageHex(unsignedTransactionHex()) })
      )
    );
    assert.match(stdout, /^HTTP\/1\.1 403 Forbidden/);
    assert.match(stdout, /recipient-blacklisted/);
  } finally {
    custodyRefusal = null;
  }
});

test('keys/derived resolves the custody key identity without local secrets', async () => {
  const { stdout } = await stdioRequest(
    buildRequest(
      '/keys/derived',
      [`authorization: Bearer ${TOKEN}`],
      JSON.stringify({ role: 'updater' })
    )
  );
  assert.match(stdout, /^HTTP\/1\.1 200 OK/);
  const body = jsonBody(stdout);
  assert.equal(body.key_id, UPDATER_KEY_ID);
  assert.equal(body.key_source, 'custody');
  assert.equal(body.derived.neo_n3.public_key, PUBLIC_KEY_HEX);
  const sent = custodyRequests.at(-1);
  assert.equal(sent.method, 'GET');
  assert.equal(sent.url, `/signer/api/v1/keys/${UPDATER_KEY_ID}`);
  assert.equal(sent.auth, `Bearer ${CUSTODY_TOKEN}`);
});
