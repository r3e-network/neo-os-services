import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tx as neoTx } from '@cityofzion/neon-js';
import { normalizeMorpheusNetwork, reportPinnedNeoN3Role } from '../../scripts/lib-neo-signers.mjs';
import {
  readReviewedNetworkRegistrySync,
  resolveReviewedNeoN3Magic,
} from '../../scripts/lib-network-registry.mjs';

const port = Math.max(Number(process.env.PORT || process.env.NITRO_SIGNER_PORT || 8080), 1);
// SECURITY (S15): bind loopback by default; expose externally only when
// explicitly configured (NITRO_SIGNER_HOST=0.0.0.0).
const host = trimString(process.env.NITRO_SIGNER_HOST || process.env.HOST || '127.0.0.1');
const network = normalizeMorpheusNetwork(process.env.MORPHEUS_NETWORK || 'mainnet');
const networkRegistry = readReviewedNetworkRegistrySync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'),
  network
);
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

// F-9: an absent or unmappable role used to sign as `updater`. It never signs
// now — the caller names the role it is entitled to, or the request leaves.
function normalizeRole(value) {
  const role = trimString(value).toLowerCase();
  if (role === 'oracle_verifier' || role === 'verifier') return 'oracle_verifier';
  if (role === 'updater') return 'updater';
  if (role === 'relayer') return 'relayer';
  if (role === 'worker') return 'worker';
  return null;
}

function requireRole(payload) {
  const role = normalizeRole(payload.key_role || payload.dstack_key_role || payload.role);
  if (!role) {
    const error = new Error(
      'key_role is required and must name a signer role; refusing to act under a defaulted role'
    );
    error.status = 400;
    throw error;
  }
  return role;
}

const CUSTODY_ROLES = ['updater', 'oracle_verifier'];

function roleKeyIdEnvName(role) {
  return `SIGNER_ROLE_${role.toUpperCase()}_KEY_ID`;
}

function resolveRoleKeyId(role) {
  const name = roleKeyIdEnvName(role);
  const keyId = trimString(effectiveEnv()[name]);
  if (!keyId) {
    const error = new Error(`${role} custody key is not provisioned (${name})`);
    error.status = 503;
    throw error;
  }
  return keyId;
}

function custodyConfig() {
  const env = effectiveEnv();
  const url = trimString(env.SIGNER_SERVICE_URL || '').replace(/\/+$/, '');
  const token = trimString(env.SIGNER_SERVICE_TOKEN || '');
  if (!url || !token) {
    const error = new Error(
      'custody signing is not configured; provision SIGNER_SERVICE_URL and SIGNER_SERVICE_TOKEN'
    );
    error.status = 503;
    throw error;
  }
  return { url, token };
}

async function custodyRequest(method, pathname, body) {
  const { url, token } = custodyConfig();
  let response;
  try {
    response = await fetch(`${url}${pathname}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        authorization: `Bearer ${token}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    const wrapped = new Error(`custody signer service unreachable: ${error?.message || error}`);
    wrapped.status = 503;
    throw wrapped;
  }
  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = {};
  }
  if (!response.ok) {
    const code = typeof parsed.code === 'string' && parsed.code ? parsed.code : '';
    const detail = typeof parsed.message === 'string' && parsed.message ? parsed.message : '';
    const wrapped = new Error(
      code || detail
        ? `custody refused: ${[code, detail].filter(Boolean).join(': ')}`
        : `custody answered ${response.status}`
    );
    wrapped.status = response.status;
    throw wrapped;
  }
  // A 2xx that still says no is a refusal envelope (§5), not a success.
  if (parsed.allowed === false) {
    const wrapped = new Error(
      `custody refused: ${parsed.code || 'denied'}${parsed.message ? `: ${parsed.message}` : ''}`
    );
    wrapped.status = 403;
    throw wrapped;
  }
  return parsed;
}

function configuredNetworkMagic() {
  const configured = trimString(effectiveEnv().NEO_NETWORK_MAGIC || '');
  if (!configured) {
    const error = new Error(
      'NEO_NETWORK_MAGIC is not provisioned; a transaction preimage cannot be checked against the chain it claims'
    );
    error.status = 503;
    throw error;
  }
  return Number(resolveReviewedNeoN3Magic(networkRegistry, network, configured));
}

// The one request kind this shim still translates: a preimage that carries the
// unsigned transaction itself — the chain's network magic little-endian, then
// the unsigned serialization. Custody recomputes the digest from those bytes
// and policy-checks the calls inside. The legacy magic+txid form cannot be
// policy-checked, so it is refused by name instead of signed blind.
function transactionPreimageToUnsignedHex(dataHex) {
  const magic = configuredNetworkMagic();
  const bytes = Buffer.from(dataHex, 'hex');
  if (bytes.length < 5) return { failure: 'unparsable' };
  if (bytes.readUInt32LE(0) !== magic) return { failure: 'magic' };
  const unsignedHex = bytes.subarray(4).toString('hex');
  try {
    neoTx.Transaction.deserialize(unsignedHex);
  } catch {
    return { failure: bytes.length === 36 ? 'txid' : 'unparsable' };
  }
  return { unsignedHex };
}

function sliceInvocationSignature(invocationScript) {
  const hex = normalizeHex(invocationScript || '');
  return /^0c40[0-9a-f]{128}$/.test(hex) ? hex.slice(4) : '';
}

function sliceVerificationPublicKey(verificationScript) {
  // Neo N3 native single-sig verification script: 0c 21 <33B pubkey> 41
  // 56e7b327 (Neo.Crypto.CheckSig syscall) — 40 bytes, matching custody's crypto.rs.
  const hex = normalizeHex(verificationScript || '');
  return /^0c21[0-9a-f]{66}4156e7b327$/.test(hex) ? hex.slice(4, 70) : '';
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
  if (status === 400) return 'Bad Request';
  if (status === 401) return 'Unauthorized';
  if (status === 403) return 'Forbidden';
  if (status === 404) return 'Not Found';
  if (status === 413) return 'Payload Too Large';
  if (status === 502) return 'Bad Gateway';
  if (status === 503) return 'Service Unavailable';
  return 'Internal Server Error';
}

// Health is custody readiness now: a role is up when its custody key id is
// provisioned. The pinned registry still supplies the public identity the
// attestation document binds — it never needed a secret to do that.
function signerHealth() {
  return CUSTODY_ROLES.map((role) => {
    const name = roleKeyIdEnvName(role);
    const keyId = trimString(effectiveEnv()[name]);
    let identity = null;
    try {
      const report = reportPinnedNeoN3Role(network, role, {
        env: effectiveEnv(),
        allowMissing: true,
      });
      identity = report.selected_identity || report.pinned || null;
    } catch {
      identity = null;
    }
    return {
      role,
      ok: Boolean(keyId),
      identity,
      issues: keyId ? [] : [`${name} is not provisioned`],
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

async function handleKeysDerived(payload) {
  const role = requireRole(payload);
  const keyId = resolveRoleKeyId(role);
  const key = await custodyRequest('GET', `/signer/api/v1/keys/${encodeURIComponent(keyId)}`);
  const neo = {
    address: typeof key.address === 'string' ? key.address : null,
    script_hash: typeof key.script_hash === 'string' ? key.script_hash : null,
    public_key: typeof key.public_key === 'string' ? key.public_key : null,
  };
  return {
    status: 'ok',
    network,
    role,
    key_id: keyId,
    derived: { neo_n3: neo },
    neo_n3: neo,
    key_source: 'custody',
  };
}

async function handleSignPayload(payload) {
  const role = requireRole(payload);
  const dataHex = normalizeHex(payload.data_hex || payload.message_hex || '');
  if (!/^[0-9a-f]+$/.test(dataHex) || dataHex.length % 2 !== 0) {
    throw new Error('data_hex is required');
  }
  const preimage = transactionPreimageToUnsignedHex(dataHex);
  if (!preimage.unsignedHex) {
    const message =
      preimage.failure === 'magic'
        ? 'data_hex does not start with this signer\u2019s network magic; refusing to sign bytes framed for another chain'
        : preimage.failure === 'txid'
          ? 'data_hex is the legacy magic+txid preimage; a bare transaction id cannot be policy-checked — send the unsigned transaction serialization instead, or sign via the custody signer service /sign/transaction'
          : 'data_hex is not a translatable request kind; this endpoint signs only a Neo N3 ' +
            'transaction preimage (network magic little-endian + unsigned transaction ' +
            'serialization) — other signing belongs to the custody signer service under ' +
            'the caller\u2019s own credential';
    const error = new Error(message);
    error.status = 400;
    throw error;
  }
  const keyId = resolveRoleKeyId(role);
  const signed = await custodyRequest('POST', '/signer/api/v1/sign/transaction', {
    key_id: keyId,
    unsigned_hex: preimage.unsignedHex,
  });
  const signature = sliceInvocationSignature(signed.invocation_script);
  const publicKey = sliceVerificationPublicKey(signed.verification_script);
  if (!signature || !publicKey) {
    const wrapped = new Error('custody returned a witness this shim cannot translate');
    wrapped.status = 502;
    throw wrapped;
  }
  return {
    status: 'ok',
    network,
    role,
    key_id: keyId,
    signature,
    signature_hex: signature,
    public_key: publicKey,
    address: typeof signed.address === 'string' ? signed.address : null,
    script_hash: typeof signed.script_hash === 'string' ? signed.script_hash : null,
    key_source: 'custody_policy',
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

function attestationPublicKeyForRole(role) {
  try {
    const report = reportPinnedNeoN3Role(network, role, {
      env: effectiveEnv(),
      allowMissing: true,
    });
    return normalizeHex(publicNeoIdentity(report).public_key);
  } catch {
    // role not in the pinned registry yet — the document simply binds no key
    return '';
  }
}

function selectAttestationPublicKey(payload) {
  const requested = payload && (payload.role || payload.key_role);
  if (requested) {
    const role = normalizeRole(requested);
    if (!role) {
      const error = new Error(
        `key_role does not name a signer role: ${trimString(String(requested))}`
      );
      error.status = 400;
      throw error;
    }
    return { role, publicKeyHex: attestationPublicKeyForRole(role) };
  }
  for (const role of CUSTODY_ROLES) {
    const publicKeyHex = attestationPublicKeyForRole(role);
    if (publicKeyHex) return { role, publicKeyHex };
  }
  return { role: CUSTODY_ROLES[0], publicKeyHex: '' };
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
  if (path.endsWith('/keys/derived')) return jsonPayload(200, await handleKeysDerived(payload));
  if (path.endsWith('/sign/payload')) return jsonPayload(200, await handleSignPayload(payload));
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
