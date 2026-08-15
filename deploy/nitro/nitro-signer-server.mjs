import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { wallet as neoWallet } from '@cityofzion/neon-js';
import { normalizeMorpheusNetwork, reportPinnedNeoN3Role } from '../../scripts/lib-neo-signers.mjs';

const port = Math.max(Number(process.env.PORT || process.env.NITRO_SIGNER_PORT || 8080), 1);
// SECURITY (S15): bind loopback by default; expose externally only when
// explicitly configured (NITRO_SIGNER_HOST=0.0.0.0).
const host = trimString(process.env.NITRO_SIGNER_HOST || process.env.HOST || '127.0.0.1');
const network = normalizeMorpheusNetwork(process.env.MORPHEUS_NETWORK || 'mainnet');
const maxBodyBytes = Math.max(Number(process.env.NITRO_SIGNER_MAX_BODY_BYTES || 65536), 1024);
const attestBin = trimString(process.env.NITRO_ATTEST_BIN) || '/app/bin/nsm-attest';
const runtimeTrustedTokens = new Set(
  [
    process.env.NITRO_SIGNER_TOKEN,
    process.env.MORPHEUS_RUNTIME_TOKEN,
    process.env.NITRO_API_TOKEN,
    process.env.NITRO_SHARED_SECRET,
  ]
    .map((value) => trimString(value))
    .filter(Boolean)
);
let provisionedEnv = {};
const PLAINTEXT_KEY_ENV_KEYS = new Set([
  'MORPHEUS_ORACLE_VERIFIER_WIF_MAINNET',
  'MORPHEUS_ORACLE_VERIFIER_WIF_TESTNET',
  'MORPHEUS_ORACLE_VERIFIER_WIF',
  'MORPHEUS_ORACLE_VERIFIER_PRIVATE_KEY_MAINNET',
  'MORPHEUS_ORACLE_VERIFIER_PRIVATE_KEY_TESTNET',
  'MORPHEUS_UPDATER_NEO_N3_WIF_MAINNET',
  'MORPHEUS_UPDATER_NEO_N3_WIF_TESTNET',
  'MORPHEUS_UPDATER_NEO_N3_WIF',
  'MORPHEUS_UPDATER_NEO_N3_PRIVATE_KEY_MAINNET',
  'MORPHEUS_UPDATER_NEO_N3_PRIVATE_KEY_TESTNET',
]);

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeHex(value) {
  return trimString(value).replace(/^0x/i, '').toLowerCase();
}

function normalizeRole(value) {
  const role = trimString(value).toLowerCase();
  if (role === 'oracle_verifier' || role === 'verifier') return 'oracle_verifier';
  if (role === 'updater') return 'updater';
  if (role === 'relayer') return 'relayer';
  if (role === 'worker') return 'worker';
  return 'updater';
}

function timingSafeTokenMatch(candidate, trusted) {
  const a = Buffer.from(String(candidate), 'utf8');
  const b = Buffer.from(String(trusted), 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function assertAuthorized(req) {
  if (!runtimeTrustedTokens.size) {
    const error = new Error('runtime authorization is not configured');
    error.status = 401;
    throw error;
  }
  const authorization = trimString(req.headers.authorization || req.headers.Authorization || '');
  const bearer = authorization.toLowerCase().startsWith('bearer ')
    ? authorization.slice('bearer '.length).trim()
    : '';
  const token =
    bearer || trimString(req.headers['x-nitro-token'] || req.headers['x-runtime-token']);
  let authorized = false;
  for (const trusted of runtimeTrustedTokens) {
    if (timingSafeTokenMatch(token, trusted)) authorized = true;
  }
  if (!authorized) {
    const error = new Error('unauthorized');
    error.status = 401;
    throw error;
  }
}

function assertProvisionAuthorized(req) {
  if (runtimeTrustedTokens.size) {
    assertAuthorized(req);
    return;
  }
  const error = new Error(
    'legacy signer first provision is disabled; use the merged KMS-attested enclave'
  );
  error.status = 401;
  throw error;
}

function effectiveEnv() {
  return { ...process.env, ...provisionedEnv };
}

function resolveRole(role) {
  const report = reportPinnedNeoN3Role(network, role, {
    env: effectiveEnv(),
    allowMissing: false,
  });
  if (!report.ok || !report.materialized) {
    throw new Error(`${role} signer is not configured or does not match pinned identity`);
  }
  return report;
}

function publicNeoIdentity(report) {
  const identity = report.selected_identity || report.pinned || {};
  return {
    address: identity.address || null,
    script_hash: identity.script_hash || null,
    public_key: identity.public_key || report.public_key || null,
  };
}

async function readJsonBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBodyBytes) {
      const error = new Error('request body too large');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function json(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function jsonPayload(status, body) {
  const payload = JSON.stringify(body);
  return {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(payload),
      connection: 'close',
    },
    payload,
  };
}

function reasonPhrase(status) {
  if (status === 200) return 'OK';
  if (status === 401) return 'Unauthorized';
  if (status === 403) return 'Forbidden';
  if (status === 404) return 'Not Found';
  if (status === 413) return 'Payload Too Large';
  if (status === 503) return 'Service Unavailable';
  return 'Internal Server Error';
}

function signerHealth() {
  return ['updater', 'oracle_verifier'].map((role) => {
    const report = reportPinnedNeoN3Role(network, role, {
      env: effectiveEnv(),
      allowMissing: false,
    });
    return {
      role,
      ok: report.ok && Boolean(report.materialized),
      identity: report.selected_identity || report.pinned || null,
      issues: report.issues,
    };
  });
}

function handleProvision(payload) {
  const env =
    payload?.env && typeof payload.env === 'object' && !Array.isArray(payload.env)
      ? payload.env
      : {};
  const rejected = Object.keys(env)
    .filter(
      (key) =>
        trimString(env[key]) &&
        (key === 'MORPHEUS_ALLOW_PLAINTEXT_KEY_PROVISION' || PLAINTEXT_KEY_ENV_KEYS.has(key))
    )
    .sort();
  if (rejected.length) {
    const error = new Error(
      'legacy Nitro signer plaintext key provisioning is disabled; deploy the merged ' +
        `KMS-attested enclave instead. Rejected: ${rejected.join(', ')}`
    );
    error.status = 403;
    throw error;
  }
  const nextEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Z0-9_]{1,96}$/.test(key)) continue;
    const text = trimString(value);
    if (text) nextEnv[key] = text;
  }
  provisionedEnv = { ...provisionedEnv, ...nextEnv };
  for (const key of [
    'NITRO_SIGNER_TOKEN',
    'MORPHEUS_RUNTIME_TOKEN',
    'NITRO_API_TOKEN',
    'NITRO_SHARED_SECRET',
  ]) {
    if (provisionedEnv[key]) runtimeTrustedTokens.add(provisionedEnv[key]);
  }
  const roles = signerHealth();
  return {
    status: roles.every((entry) => entry.ok) ? 'ok' : 'degraded',
    runtime: 'aws-nitro-signer',
    network,
    provisioned: true,
    env_keys: Object.keys(nextEnv).sort(),
    roles,
  };
}

function handleKeysDerived(payload) {
  const role = normalizeRole(payload.role || payload.key_role || payload.dstack_key_role);
  const report = resolveRole(role);
  const neo = publicNeoIdentity(report);
  return {
    status: 'ok',
    network,
    role,
    derived: { neo_n3: neo },
    neo_n3: neo,
    key_source: 'nitro_explicit_pinned',
  };
}

function handleSignPayload(payload) {
  const role = normalizeRole(payload.key_role || payload.dstack_key_role || payload.role);
  const dataHex = normalizeHex(payload.data_hex || payload.message_hex || '');
  if (!/^[0-9a-f]+$/.test(dataHex) || dataHex.length % 2 !== 0) {
    throw new Error('data_hex is required');
  }
  const report = resolveRole(role);
  const secret = report.materialized.private_key || report.materialized.wif;
  const account = new neoWallet.Account(secret);
  const signature = neoWallet.sign(dataHex, account.privateKey);
  return {
    status: 'ok',
    network,
    role,
    signature,
    signature_hex: signature,
    public_key: account.publicKey,
    address: account.address,
    script_hash: `0x${account.scriptHash}`,
    key_source: 'nitro_explicit_pinned',
  };
}

function attestationUserDataHex() {
  // Bind the signer's pinned identities + network into the attestation document so
  // a verifier can confirm WHICH Neo signing keys this enclave is provisioned with.
  const roles = signerHealth().map((entry) => ({
    role: entry.role,
    ok: entry.ok,
    public_key: entry.identity ? entry.identity.public_key || null : null,
    script_hash: entry.identity ? entry.identity.script_hash || null : null,
  }));
  const userData = { runtime: 'aws-nitro-signer', network, roles };
  return Buffer.from(JSON.stringify(userData), 'utf8').toString('hex');
}

function selectAttestationPublicKey(payload) {
  const requested = payload && (payload.role || payload.key_role);
  const order = requested ? [normalizeRole(requested)] : ['oracle_verifier', 'updater'];
  for (const role of order) {
    try {
      const report = resolveRole(role);
      const pub = normalizeHex(publicNeoIdentity(report).public_key);
      if (pub) return { role, publicKeyHex: pub };
    } catch {
      // role not provisioned yet — try the next one
    }
  }
  return { role: order[0], publicKeyHex: '' };
}

function handleAttestation(payload) {
  const nonceHex = normalizeHex(
    payload.nonce || payload.report_data || payload.report_data_hex || ''
  );
  if (nonceHex && (!/^[0-9a-f]*$/.test(nonceHex) || nonceHex.length % 2 !== 0)) {
    throw new Error('nonce must be even-length hex');
  }
  const { role, publicKeyHex } = selectAttestationPublicKey(payload);
  const userDataHex = attestationUserDataHex();

  const args = ['--user-data', userDataHex];
  if (nonceHex) args.push('--nonce', nonceHex);
  if (publicKeyHex) args.push('--public-key', publicKeyHex);

  let raw;
  try {
    raw = execFileSync(attestBin, args, { timeout: 8000, maxBuffer: 4 * 1024 * 1024 }).toString(
      'utf8'
    );
  } catch (error) {
    const detail =
      error && error.stderr
        ? error.stderr.toString().slice(0, 300)
        : (error && error.message) || 'spawn failed';
    const wrapped = new Error(`nsm attestation helper failed: ${detail}`);
    wrapped.status = 503;
    throw wrapped;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw.trim().split('\n').filter(Boolean).pop());
  } catch {
    const wrapped = new Error('nsm attestation helper returned invalid output');
    wrapped.status = 503;
    throw wrapped;
  }
  if (!parsed.ok) {
    const wrapped = new Error(parsed.error || 'nsm attestation failed');
    wrapped.status = 503;
    throw wrapped;
  }
  return {
    status: 'ok',
    runtime: 'aws-nitro-signer',
    network,
    role,
    format: 'cose-sign1-cbor-base64',
    public_key: publicKeyHex || null,
    nonce: nonceHex || null,
    user_data_hex: userDataHex,
    document_len: parsed.document_len || null,
    attestation_document: parsed.attestation_b64,
  };
}

async function dispatchSignerRequest({ method, rawUrl, headers, payloadProvider }) {
  const url = new URL(rawUrl || '/', `http://${headers.host || '127.0.0.1'}`);
  const path = url.pathname.replace(/\/$/, '') || '/';
  if (method === 'GET' && path.endsWith('/health')) {
    const roles = signerHealth();
    return jsonPayload(roles.every((entry) => entry.ok) ? 200 : 503, {
      status: roles.every((entry) => entry.ok) ? 'ok' : 'degraded',
      runtime: 'aws-nitro-signer',
      network,
      roles,
    });
  }
  const payload = method === 'GET' ? Object.fromEntries(url.searchParams) : await payloadProvider();
  if (path.endsWith('/attestation')) {
    return jsonPayload(200, handleAttestation(payload));
  }
  if (method === 'POST' && path.endsWith('/provision')) {
    assertProvisionAuthorized({ headers });
    return jsonPayload(200, handleProvision(payload));
  }
  assertAuthorized({ headers });
  if (path.endsWith('/keys/derived')) return jsonPayload(200, handleKeysDerived(payload));
  if (path.endsWith('/sign/payload')) return jsonPayload(200, handleSignPayload(payload));
  return jsonPayload(404, { error: 'not found' });
}

function writeHttpResponse(response) {
  const lines = [`HTTP/1.1 ${response.status} ${reasonPhrase(response.status)}`];
  for (const [key, value] of Object.entries(response.headers)) {
    lines.push(`${key}: ${value}`);
  }
  process.stdout.write(`${lines.join('\r\n')}\r\n\r\n${response.payload}`);
}

function parseHeaderMap(lines) {
  const headers = {};
  for (const line of lines) {
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    headers[name] = value;
  }
  return headers;
}

async function readStdioHttpRequest() {
  return await new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('request timeout'));
    }, 10_000);
    function cleanup() {
      clearTimeout(timer);
      process.stdin.off('data', onData);
      process.stdin.off('end', onEnd);
      process.stdin.off('error', onError);
    }
    function tryComplete(ended = false) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) {
        if (buffer.length > maxBodyBytes) {
          cleanup();
          reject(new Error('request headers too large'));
        }
        return;
      }
      const headerText = buffer.subarray(0, headerEnd).toString('utf8');
      const lines = headerText.split('\r\n');
      const [method = '', rawUrl = '/'] = (lines.shift() || '').split(/\s+/);
      const headers = parseHeaderMap(lines);
      const contentLength = Math.max(Number(headers['content-length'] || 0), 0);
      if (contentLength > maxBodyBytes) {
        cleanup();
        reject(Object.assign(new Error('request body too large'), { status: 413 }));
        return;
      }
      const totalLength = headerEnd + 4 + contentLength;
      if (buffer.length < totalLength) {
        if (ended) {
          cleanup();
          reject(new Error('request body truncated'));
        }
        return;
      }
      cleanup();
      resolve({
        method: method.toUpperCase(),
        rawUrl,
        headers,
        body: buffer.subarray(headerEnd + 4, totalLength).toString('utf8'),
      });
    }
    function onData(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      tryComplete();
    }
    function onEnd() {
      tryComplete(true);
    }
    function onError(error) {
      cleanup();
      reject(error);
    }
    process.stdin.on('data', onData);
    process.stdin.on('end', onEnd);
    process.stdin.on('error', onError);
  });
}

async function handleStdioConnection() {
  try {
    const request = await readStdioHttpRequest();
    const response = await dispatchSignerRequest({
      method: request.method,
      rawUrl: request.rawUrl,
      headers: request.headers,
      payloadProvider: async () => (request.body ? JSON.parse(request.body) : {}),
    });
    writeHttpResponse(response);
  } catch (error) {
    const status = Number(error?.status || 500);
    writeHttpResponse(
      jsonPayload(status, {
        error: error instanceof Error ? error.message : String(error),
        runtime: 'aws-nitro-signer',
      })
    );
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const response = await dispatchSignerRequest({
      method: req.method || 'GET',
      rawUrl: req.url || '/',
      headers: req.headers || {},
      payloadProvider: async () => await readJsonBody(req),
    });
    return json(res, response.status, JSON.parse(response.payload));
  } catch (error) {
    const status = Number(error?.status || 500);
    return json(res, status, {
      error: error instanceof Error ? error.message : String(error),
      runtime: 'aws-nitro-signer',
    });
  }
});

if (process.argv.includes('--stdio') || process.env.NITRO_SIGNER_STDIO === '1') {
  await handleStdioConnection();
} else {
  server.listen(port, host, () => {
    console.log(
      JSON.stringify({ level: 'info', msg: 'nitro signer listening', host, port, network })
    );
  });
}
