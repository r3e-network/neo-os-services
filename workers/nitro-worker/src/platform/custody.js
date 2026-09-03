// Custody signer service client (docs/SIGNER_SERVICE.md §5). The worker holds
// no key material: it names a key_id resolved from SIGNER_ROLE_{ROLE}_KEY_ID and
// the custody enclave returns either a refusal envelope or a signature computed
// inside the attested boundary. Connection comes from the runtime env
// (SIGNER_SERVICE_URL / SIGNER_SERVICE_TOKEN) like every other custody consumer.
import { env, trimString } from './core.js';

const CUSTODY_API = '/signer/api/v1';

let custodyTransportForTests = null;

export function custodyKeyId(role) {
  const envName = `SIGNER_ROLE_${String(role).toUpperCase()}_KEY_ID`;
  const keyId = trimString(env(envName));
  if (!keyId) {
    const error = new Error(`custody key for role ${role} is not provisioned (${envName})`);
    error.status = 503;
    throw error;
  }
  return keyId;
}

export function custodyConnection() {
  const url = trimString(env('SIGNER_SERVICE_URL')).replace(/\/+$/, '');
  const token = trimString(env('SIGNER_SERVICE_TOKEN'));
  if (!url || !token) {
    const error = new Error(
      'custody signer service is not configured; provision SIGNER_SERVICE_URL and SIGNER_SERVICE_TOKEN'
    );
    error.status = 503;
    throw error;
  }
  return { url, token };
}

async function custodyRequest(method, pathname, body) {
  let parsed;
  if (custodyTransportForTests) {
    try {
      parsed = await custodyTransportForTests(method, pathname, body);
    } catch (error) {
      const unavailable = new Error(
        `custody signer service unreachable: ${error?.message || error}`
      );
      unavailable.status = 503;
      throw unavailable;
    }
  } else {
    const { url, token } = custodyConnection();
    const timeoutMs =
      Number(env('SIGNER_CUSTODY_TIMEOUT_MS')) > 0
        ? Number(env('SIGNER_CUSTODY_TIMEOUT_MS'))
        : 15_000;
    let response;
    try {
      response = await fetch(`${url}${CUSTODY_API}${pathname}`, {
        method,
        headers: {
          'content-type': 'application/json',
          'cache-control': 'no-store',
          authorization: `Bearer ${token}`,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const unavailable = new Error(
        `custody signer service unreachable: ${error?.message || error}`
      );
      unavailable.status = 503;
      throw unavailable;
    }
    const text = await response.text();
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = {};
    }
    if (!response.ok) {
      const code = typeof parsed.code === 'string' && parsed.code ? parsed.code : '';
      const detail = typeof parsed.message === 'string' && parsed.message ? parsed.message : '';
      const error = new Error(
        code || detail
          ? `custody refused (${response.status}): ${[code, detail].filter(Boolean).join(': ')}`
          : `custody signer service answered ${response.status}`
      );
      // A signed lane cannot degrade a custody readiness fault into a caller
      // error or a successful unsigned response.
      error.status = 503;
      throw error;
    }
  }
  // A 2xx that still says no is a refusal envelope (§5), not a success.
  if (parsed.allowed === false) {
    const error = new Error(
      `custody refused: ${parsed.code || 'denied'}${parsed.message ? `: ${parsed.message}` : ''}`
    );
    error.status = 503;
    throw error;
  }
  return parsed;
}

export function custodyKeyInfo(keyId) {
  return custodyRequest('GET', `/keys/${encodeURIComponent(keyId)}`);
}

// Digest/preimage signing for allow_raw keys — the worker sign lane. The bytes
// are signed as-is (SHA-256 then ECDSA inside the enclave); policy lives on the
// key's allow_raw boundary, not on the request.
export function custodySignRaw(keyId, dataHex) {
  return custodyRequest('POST', '/sign/raw', { key_id: keyId, data_hex: dataHex });
}

export function custodySignTransaction(keyId, unsignedHex) {
  return custodyRequest('POST', '/sign/transaction', {
    key_id: keyId,
    unsigned_hex: unsignedHex,
  });
}

// Test seams: swap the HTTP transport for a deterministic custody stub (the
// platform test pattern, like __setSecretsProviderForTests).
export function __setCustodyTransportForTests(transport) {
  custodyTransportForTests = transport;
}

export function __resetCustodyTransportForTests() {
  custodyTransportForTests = null;
}
