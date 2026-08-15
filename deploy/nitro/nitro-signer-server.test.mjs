import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'nitro-signer-server.mjs');
const TOKEN = 'unit-test-token';

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

function childEnv(token = TOKEN) {
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
  return env;
}

function stdioRequest(rawRequest, token = TOKEN) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER, '--stdio'], {
      env: childEnv(token),
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
  assert.match(stdout, /data_hex is required/);
});

test('signer accepts the trusted token via the x-nitro-token header', async () => {
  const { stdout } = await stdioRequest(buildSignRequest([`x-nitro-token: ${TOKEN}`]));
  assert.doesNotMatch(stdout, /^HTTP\/1\.1 401/);
  assert.match(stdout, /data_hex is required/);
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
