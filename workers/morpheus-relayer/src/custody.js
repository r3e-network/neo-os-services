// Custody signer service client (docs/SIGNER_SERVICE.md §5). The relayer holds
// no key material: it names a key_id and the custody enclave returns either a
// refusal envelope or a signature computed inside the attested boundary.
// Connection and key-id provisioning come from the runtime env
// (SIGNER_SERVICE_URL / SIGNER_SERVICE_TOKEN / SIGNER_ROLE_{ROLE}_KEY_ID),
// folded into config at load time.
import { trimString } from './lib/strings.js';

const CUSTODY_API = '/signer/api/v1';

export function custodyKeyId(config, role) {
  const keyId = trimString(config?.neo_n3?.custodyKeyIds?.[role] || '');
  if (!keyId) {
    throw new Error(
      `custody key for role ${role} is not provisioned (SIGNER_ROLE_${String(role).toUpperCase()}_KEY_ID)`
    );
  }
  return keyId;
}

export function custodyConnection(config) {
  const url = trimString(config?.nitro?.custodyUrl || '').replace(/\/+$/, '');
  const token = trimString(config?.nitro?.custodyToken || '');
  if (!url || !token) {
    throw new Error(
      'custody signer service is not configured; provision SIGNER_SERVICE_URL and SIGNER_SERVICE_TOKEN'
    );
  }
  return { url, token };
}

async function custodyRequest(config, method, pathname, body) {
  const { url, token } = custodyConnection(config);
  const timeoutMs =
    Number(config?.nitro?.custodyTimeoutMs) > 0 ? Number(config.nitro.custodyTimeoutMs) : 15_000;
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
    throw new Error(`custody signer service unreachable: ${error?.message || error}`);
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
    throw new Error(
      code || detail
        ? `custody refused (${response.status}): ${[code, detail].filter(Boolean).join(': ')}`
        : `custody signer service answered ${response.status}`
    );
  }
  // A 2xx that still says no is a refusal envelope (§5), not a success.
  if (parsed.allowed === false) {
    throw new Error(
      `custody refused: ${parsed.code || 'denied'}${parsed.message ? `: ${parsed.message}` : ''}`
    );
  }
  return parsed;
}

export function custodyKeyInfo(config, keyId) {
  return custodyRequest(config, 'GET', `/keys/${encodeURIComponent(keyId)}`);
}

// Digest/preimage signing for allow_raw keys — the fulfillment lane. The bytes
// are signed as-is (SHA-256 then ECDSA inside the enclave); policy lives on the
// key's allow_raw boundary, not on the request.
export function custodySignRaw(config, keyId, dataHex) {
  return custodyRequest(config, 'POST', '/sign/raw', { key_id: keyId, data_hex: dataHex });
}

export function custodySignTransaction(config, keyId, unsignedHex) {
  return custodyRequest(config, 'POST', '/sign/transaction', {
    key_id: keyId,
    unsigned_hex: unsignedHex,
  });
}
