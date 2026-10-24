import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { sha256Hex } from '@r3e-network/neo-os-services-shared/node-runtime';
import { neoNetworkMagicLe4 } from '@r3e-network/neo-os-services-shared/neo-encoding';
import { normalizeRequestType, strip0x, trimString } from './lib/strings.js';
import { requireRawPayloadHex } from './lib/payload.js';
// Neo N3 contract uses the v2 kernel domain with envelope and request-payload binding.
const FULFILLMENT_SIGNATURE_DOMAIN_N3 = Buffer.from('miniapp-os-fulfillment-v2', 'utf8');

/**
 * SECURITY (S11): the smart-fetch lane forwards a caller-supplied URL to the
 * internal worker. This relayer-side gate enforces https-only, rejects
 * private/loopback/link-local IP literals and cloud metadata hosts, and — when
 * MORPHEUS_SMART_FETCH_ALLOWLIST is set — restricts hostnames to that allowlist
 * (exact match or subdomain). The worker side additionally DNS-resolves and pins
 * connections (resolvePinnedAddresses); this is defense in depth at the
 * boundary so a chain request cannot turn the platform into an SSRF proxy.
 */
export function assertSmartFetchUrlAllowed(rawUrl) {
  const value = trimString(rawUrl || '');
  if (!value) return; // no URL => not the arbitrary-URL lane
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('smart-fetch url is not a valid URL');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('smart-fetch url must use https');
  }
  const hostname = parsed.hostname.toLowerCase();
  if (
    hostname === 'localhost' ||
    hostname === '0.0.0.0' ||
    hostname === '::1' ||
    hostname.endsWith('.local')
  ) {
    throw new Error('smart-fetch url must not target local/private hosts');
  }
  if (isBlockedIpLiteral(hostname)) {
    throw new Error('smart-fetch url must not target private/loopback/link-local addresses');
  }
  const allowlist = (process.env.MORPHEUS_SMART_FETCH_ALLOWLIST || '')
    .split(',')
    .map((entry) => trimString(entry).toLowerCase())
    .filter(Boolean);
  if (allowlist.length > 0) {
    const allowed = allowlist.some((entry) => hostname === entry || hostname.endsWith(`.${entry}`));
    if (!allowed) {
      throw new Error('smart-fetch url host is not in MORPHEUS_SMART_FETCH_ALLOWLIST');
    }
  }
}

function isBlockedIpLiteral(hostname) {
  const family = isIP(hostname);
  if (family === 4) {
    const octets = hostname.split('.').map((part) => Number.parseInt(part, 10));
    if (
      octets.length !== 4 ||
      octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
    ) {
      return true;
    }
    const [a, b] = octets;
    return (
      a === 0 ||
      a === 127 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }
  if (family === 6) {
    // Reject loopback, link-local, ULA, multicast and IPv4-mapped loopback.
    const lower = hostname.toLowerCase();
    if (
      lower === '::1' ||
      lower.startsWith('fe80:') ||
      lower.startsWith('fc') ||
      lower.startsWith('fd') ||
      lower.startsWith('ff')
    ) {
      return true;
    }
    if (
      lower.startsWith('::ffff:127.') ||
      lower.startsWith('::ffff:10.') ||
      lower.startsWith('::ffff:192.168.')
    ) {
      return true;
    }
  }
  return false;
}
const FULFILLMENT_SIGNATURE_DOMAIN_LEGACY = Buffer.from('morpheus-fulfillment-v2', 'utf8');

function sha256Buffer(value) {
  const buffer = Buffer.isBuffer(value)
    ? value
    : value instanceof Uint8Array
      ? Buffer.from(value)
      : Buffer.from(String(value ?? ''), 'utf8');
  return createHash('sha256').update(buffer).digest();
}

function encodeLengthPrefixedUtf8(value) {
  const bytes = Buffer.from(trimString(value), 'utf8');
  if (bytes.length > 255) throw new Error('compact callback segment exceeds 255 bytes');
  return Buffer.concat([Buffer.from([bytes.length]), bytes]);
}

function encodeHash160Bytes(value, fieldName) {
  const raw = strip0x(value);
  if (!/^[0-9a-f]{40}$/i.test(raw)) throw new Error(`invalid hash160 for ${fieldName}`);
  return Buffer.from(raw, 'hex');
}

function encodeHashBytes(value, fieldName) {
  const raw = strip0x(value);
  if (!/^[0-9a-f]{64}$/i.test(raw)) throw new Error(`invalid 32-byte hash for ${fieldName}`);
  return Buffer.from(raw, 'hex');
}

function encodeSignatureBytes(value, fieldName = 'signature') {
  const raw = strip0x(value);
  if (!/^[0-9a-f]{128}$/i.test(raw)) throw new Error(`invalid 64-byte signature for ${fieldName}`);
  return Buffer.from(raw, 'hex');
}

function encodeNeoN3RecoveryTicketV1(workerBody) {
  return Buffer.concat([
    Buffer.from([0x01]),
    encodeHash160Bytes(workerBody.new_owner, 'new_owner'),
    encodeLengthPrefixedUtf8(workerBody.recovery_nonce),
    encodeLengthPrefixedUtf8(workerBody.expires_at),
    encodeLengthPrefixedUtf8(workerBody.action_id),
    encodeHashBytes(workerBody.master_nullifier, 'master_nullifier'),
    encodeHashBytes(workerBody.action_nullifier, 'action_nullifier'),
    encodeSignatureBytes(workerBody.signature, 'signature'),
  ]);
}

function encodeNeoN3ActionTicketV1(workerBody) {
  return Buffer.concat([
    Buffer.from([0x01]),
    encodeHash160Bytes(workerBody.disposable_account, 'disposable_account'),
    encodeLengthPrefixedUtf8(workerBody.action_id),
    encodeHashBytes(workerBody.action_nullifier, 'action_nullifier'),
    encodeSignatureBytes(workerBody.signature, 'signature'),
  ]);
}

function encodeNeoN3RecoveryTicketV3(workerBody) {
  return Buffer.from(
    [
      '3',
      Buffer.from(encodeHashBytes(workerBody.master_nullifier, 'master_nullifier')).toString(
        'base64'
      ),
      Buffer.from(encodeHashBytes(workerBody.action_nullifier, 'action_nullifier')).toString(
        'base64'
      ),
      Buffer.from(encodeSignatureBytes(workerBody.signature, 'signature')).toString('base64'),
    ].join('|'),
    'utf8'
  );
}

function encodeNeoN3ActionTicketV3(workerBody) {
  return Buffer.from(
    [
      '3',
      Buffer.from(encodeHashBytes(workerBody.action_nullifier, 'action_nullifier')).toString(
        'base64'
      ),
      Buffer.from(encodeSignatureBytes(workerBody.signature, 'signature')).toString('base64'),
    ].join('|'),
    'utf8'
  );
}

function resolveCompactCallbackBytes(requestType, workerResponse) {
  const normalized = normalizeRequestType(requestType);
  const workerBody =
    workerResponse?.body && typeof workerResponse.body === 'object' ? workerResponse.body : null;
  if (
    workerBody &&
    (normalized === 'rng' || normalized.includes('vrf') || normalized.includes('random'))
  ) {
    const randomness = strip0x(workerBody.randomness || '');
    if (/^[0-9a-f]{64}$/i.test(randomness)) {
      return Buffer.from(randomness, 'hex');
    }
  }
  const callbackEncoding = normalizeRequestType(workerBody?.callback_encoding || '');
  if (!workerBody || !callbackEncoding) return null;

  // Generic game session finalize: the worker builds the fixed 79-byte RESULT
  // CODEC and returns it base64 with callback_encoding 'game_result_v1'. The
  // bytes flow verbatim to the kernel callback; the fulfillment digest binds
  // SHA256(result) so any tamper breaks the RUNTIME_VERIFIER signature. This is
  // game-agnostic — the same encoding serves every registered engine.
  if (callbackEncoding === 'game_result_v1') {
    const raw = trimString(workerBody.result_bytes_base64 || '');
    if (raw) {
      const bytes = Buffer.from(raw, 'base64');
      if (bytes.length === 79 && bytes[0] === 0x02) return bytes;
    }
    return null;
  }

  if (normalized === 'neodid_recovery_ticket' && callbackEncoding === 'neo_n3_recovery_v1') {
    return encodeNeoN3RecoveryTicketV1(workerBody);
  }
  if (normalized === 'neodid_recovery_ticket' && callbackEncoding === 'neo_n3_recovery_v3') {
    return encodeNeoN3RecoveryTicketV3(workerBody);
  }
  if (normalized === 'neodid_action_ticket' && callbackEncoding === 'neo_n3_action_v1') {
    return encodeNeoN3ActionTicketV1(workerBody);
  }
  if (normalized === 'neodid_action_ticket' && callbackEncoding === 'neo_n3_action_v3') {
    return encodeNeoN3ActionTicketV3(workerBody);
  }
  return null;
}

function encodeUint256Bytes(value) {
  const numeric = BigInt(String(value ?? '0'));
  if (numeric < 0n) throw new Error('uint256 value must be non-negative');
  return Buffer.from(numeric.toString(16).padStart(64, '0'), 'hex');
}

// normalizeRequestType is single-sourced in ./lib/strings.js. Re-exported here so
// existing importers (and the characterization tests) keep resolving it from
// ./router.js unchanged.
export { normalizeRequestType };

export function resolveKernelIntent(requestType) {
  const normalized = normalizeRequestType(requestType);

  // Generic confidential game session (module game.session). The kernel request
  // operation is 'session.start' / 'session.step' / 'session.finalize' — the
  // on-chain settlement path is session.finalize (start/step run the direct
  // enclave loop off-chain and never reach the kernel). This branch is
  // game-agnostic: it does NOT branch on appId; the worker's generic host loads
  // the app-declared engine by (appId, engineHash) from the whitelist.
  if (normalized.startsWith('session.') || normalized.startsWith('session_')) {
    const isFinalize = normalized.includes('finalize');
    return {
      legacyRequestType: normalized,
      moduleId: 'game.session',
      operation: normalized || 'session.finalize',
      workerRoute: isFinalize ? '/session/finalize' : '/session/step',
      operatorOnly: false,
    };
  }

  if (normalized.includes('paymaster')) {
    return {
      legacyRequestType: normalized,
      moduleId: 'paymaster.authorize',
      operation: normalized || 'authorize',
      workerRoute: '/paymaster/authorize',
      operatorOnly: false,
    };
  }

  if (normalized.includes('compute')) {
    return {
      legacyRequestType: normalized,
      moduleId: 'compute.run',
      operation: normalized || 'compute',
      workerRoute: '/compute/execute',
      operatorOnly: false,
    };
  }

  if (normalized.includes('feed')) {
    return {
      legacyRequestType: normalized,
      moduleId: 'feed.publish',
      operation: normalized || 'feed',
      workerRoute: '/oracle/feed',
      operatorOnly: true,
    };
  }

  if (normalized === 'rng' || normalized.includes('vrf') || normalized.includes('random')) {
    return {
      legacyRequestType: normalized,
      moduleId: 'random.generate',
      operation: normalized || 'random',
      workerRoute: '/vrf/random',
      operatorOnly: false,
    };
  }

  if (normalized === 'decrypt' || normalized.includes('decrypt') || normalized.includes('reveal')) {
    return {
      legacyRequestType: normalized,
      moduleId: 'confidential.decrypt',
      operation: normalized || 'decrypt',
      workerRoute: '/oracle/decrypt',
      operatorOnly: false,
    };
  }

  if (normalized.startsWith('neodid')) {
    if (normalized.includes('zklogin')) {
      return {
        legacyRequestType: normalized,
        moduleId: 'identity.verify',
        operation: normalized,
        workerRoute: '/neodid/zklogin-ticket',
        operatorOnly: false,
      };
    }
    if (normalized.includes('recovery')) {
      return {
        legacyRequestType: normalized,
        moduleId: 'identity.verify',
        operation: normalized,
        workerRoute: '/neodid/recovery-ticket',
        operatorOnly: false,
      };
    }
    if (normalized.includes('action')) {
      return {
        legacyRequestType: normalized,
        moduleId: 'identity.verify',
        operation: normalized,
        workerRoute: '/neodid/action-ticket',
        operatorOnly: false,
      };
    }
    return {
      legacyRequestType: normalized,
      moduleId: 'identity.verify',
      operation: normalized || 'neodid_bind',
      workerRoute: '/neodid/bind',
      operatorOnly: false,
    };
  }

  if (normalized.startsWith('automation_')) {
    return {
      legacyRequestType: normalized,
      moduleId: 'automation.run',
      operation: normalized,
      workerRoute: '/automation/execute',
      operatorOnly: false,
    };
  }

  return {
    legacyRequestType: normalized,
    moduleId: 'oracle.fetch',
    operation: normalized || 'privacy_oracle',
    workerRoute: '/oracle/smart-fetch',
    operatorOnly: false,
  };
}

export function isOperatorOnlyRequestType(value) {
  return resolveKernelIntent(value).operatorOnly;
}

export function decodePayloadText(rawPayload) {
  const text = trimString(rawPayload);
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw_payload: text };
  }
}

export function resolveWorkerRoute(requestType, _payload) {
  return resolveKernelIntent(requestType).workerRoute;
}

export function buildWorkerPayload(chain, requestType, payload, requestId, context = {}) {
  const kernelIntent = resolveKernelIntent(requestType);
  // A request body of literal JSON `null` decodes to null, and the envelope
  // fields below are read from the body; dereferencing it threw a TypeError
  // (CU-179). Only null and undefined change here: every other payload keeps
  // the previous spread and field reads byte-for-byte.
  const body = payload ?? {};
  return {
    ...body,
    request_id: String(requestId),
    request_source: `morpheus-relayer:${chain}`,
    target_chain: body.target_chain || chain,
    legacy_request_type: kernelIntent.legacyRequestType,
    kernel_module_id: kernelIntent.moduleId,
    kernel_operation: kernelIntent.operation,
    requester: context.requester || body.requester || '',
    callback_contract: context.callbackContract || body.callback_contract || '',
    callback_method: context.callbackMethod || body.callback_method || '',
  };
}

/**
 * Build the fulfillment digest that must match the on-chain contract's
 * ComputeFulfillmentDigest. The Neo N3 kernel contract binds the signature
 * to the full request envelope (appId, moduleId, operation) instead of only
 * the legacy requestType. Legacy Neo N3 requests without kernel envelope
 * fields still verify against the older requestType-based digest domain.
 *
 * Security rationale: covering the full envelope prevents an attacker from
 * reusing a fulfillment signature meant for one (appId, moduleId, operation)
 * tuple against a different request that shares the same requestId.
 */
export function buildFulfillmentDigestBytes(
  requestId,
  requestType,
  success,
  result,
  error,
  resultBytesBase64 = '',
  {
    chain = 'neo_n3',
    appId = '',
    moduleId = '',
    operation = '',
    payloadText = '',
    payloadHex,
    contractScriptHash = '',
    networkMagic,
  } = {}
) {
  const successByte = Buffer.from([success ? 1 : 0]);
  const resultBytes = trimString(resultBytesBase64)
    ? Buffer.from(trimString(resultBytesBase64), 'base64')
    : Buffer.from(String(result || ''), 'utf8');
  const requestPayload =
    chain === 'legacy'
      ? Buffer.from(String(payloadText ?? ''), 'utf8')
      : Buffer.from(strip0x(requireRawPayloadHex({ payloadHex })), 'hex');

  // Deployment + network binding (kernel ComputeFulfillmentDigest): the contract
  // appends (ByteString)Runtime.ExecutingScriptHash (20 bytes, little-endian) and
  // a 4-byte little-endian network magic. The on-chain script hash is the reverse
  // of the 0x big-endian display form. Only appended when both are supplied, so
  // legacy/older deployments keep the unbound digest.
  const hashHex = strip0x(trimString(contractScriptHash || ''));
  const bindDeployment = /^[0-9a-fA-F]{40}$/.test(hashHex) && Number.isFinite(Number(networkMagic));
  const deploymentSuffix = [];
  if (bindDeployment) {
    deploymentSuffix.push(Buffer.from(hashHex, 'hex').reverse()); // big-endian display -> little-endian VM bytes
    deploymentSuffix.push(neoNetworkMagicLe4(Number(networkMagic)));
  }

  // Identifier hygiene: hash the identifier/error inputs VERBATIM. The on-chain
  // ComputeFulfillmentDigest hashes the stored request bytes exactly as written
  // (no trimming), so any normalization here would make a signature over a
  // whitespace-bearing identifier unverifiable on-chain. Malformed identifiers
  // are rejected at ingestion (fulfillment.js findWhitespaceIdentifier) instead.
  if (chain === 'legacy') {
    return createHash('sha256')
      .update(
        Buffer.concat([
          FULFILLMENT_SIGNATURE_DOMAIN_LEGACY,
          encodeUint256Bytes(requestId),
          sha256Buffer(String(requestType ?? '')),
          successByte,
          sha256Buffer(resultBytes),
          sha256Buffer(String(error ?? '')),
        ])
      )
      .digest();
  }

  // Neo N3 kernel contract: domain + requestId + sha256(appId) + sha256(moduleId)
  // + sha256(operation) + sha256(requestPayload) + success + sha256(result) + sha256(error)
  return createHash('sha256')
    .update(
      Buffer.concat([
        FULFILLMENT_SIGNATURE_DOMAIN_N3,
        encodeUint256Bytes(requestId),
        sha256Buffer(String(appId ?? '')),
        sha256Buffer(String(moduleId ?? '')),
        sha256Buffer(String(operation ?? '')),
        sha256Buffer(requestPayload),
        successByte,
        sha256Buffer(resultBytes),
        sha256Buffer(String(error ?? '')),
        ...deploymentSuffix,
      ])
    )
    .digest();
}

function compactTeeAttestation(attestation) {
  if (!attestation || typeof attestation !== 'object') return null;
  return {
    app_id: attestation.app_id || null,
    instance_id: attestation.instance_id || null,
    compose_hash: attestation.compose_hash || null,
    report_data: attestation.report_data || null,
    quote_hash: attestation.quote ? sha256Hex(attestation.quote) : null,
    event_log_hash: attestation.event_log ? sha256Hex(attestation.event_log) : null,
  };
}

function buildVerificationEnvelope(workerBody) {
  if (!workerBody || typeof workerBody !== 'object') return null;
  const existing =
    workerBody.verification && typeof workerBody.verification === 'object'
      ? workerBody.verification
      : null;
  const source = existing || workerBody;

  const hasAny =
    source.output_hash ||
    source.attestation_hash ||
    source.signature ||
    source.public_key ||
    source.tee_attestation;
  if (!hasAny) return null;

  return {
    output_hash: source.output_hash || null,
    attestation_hash: source.attestation_hash || null,
    signature: source.signature || null,
    public_key: source.public_key || null,
    signer_address: source.signer_address || null,
    signer_script_hash: source.signer_script_hash || null,
    tee_attestation: compactTeeAttestation(source.tee_attestation || null),
  };
}

const MAX_ONCHAIN_RESULT_VALUE_BYTES = 384;
const MAX_ONCHAIN_ERROR_LENGTH = 240;

function measureJsonBytes(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function trimErrorMessage(value) {
  const text = trimString(value);
  if (!text) return 'worker request failed';
  return text.length > MAX_ONCHAIN_ERROR_LENGTH
    ? `${text.slice(0, MAX_ONCHAIN_ERROR_LENGTH - 3)}...`
    : text;
}

function compactValue(value, maxBytes = MAX_ONCHAIN_RESULT_VALUE_BYTES) {
  if (value === undefined) return undefined;
  if (measureJsonBytes(value) <= maxBytes) return value;
  return undefined;
}

function buildBusinessResult(requestType, workerBody) {
  if (!workerBody || typeof workerBody !== 'object') return workerBody;

  const normalized = normalizeRequestType(requestType);
  const compact = {};
  const preferredFields = [
    'mode',
    'action',
    'function',
    'entry_point',
    'target_chain',
    'target_chain_id',
    'request_source',
    'provider',
    'claim_type',
    'claim_value',
    'master_nullifier',
    'provider_pair',
    'feed_id',
    'pair',
    'symbol',
    'action_id',
    'action_nullifier',
    'aa_contract',
    'verifier_contract',
    'account_id',
    'account_address',
    'new_owner',
    'recovery_nonce',
    'expires_at',
    'digest',
    'price',
    'decimals',
    'timestamp',
    'automation_id',
    'trigger_type',
    'next_run_at',
    'status',
    'chain',
    'requester',
    'callback_contract',
    'execution_request_type',
    'upstream_status',
    'randomness',
    'job_id',
    'extracted_value',
  ];

  for (const field of preferredFields) {
    if (workerBody[field] !== undefined && workerBody[field] !== null) {
      compact[field] = workerBody[field];
    }
  }

  if (Array.isArray(workerBody.sources) && workerBody.sources.length > 0) {
    compact.sources = workerBody.sources.slice(0, 4);
  }

  const preferredResult = compactValue(workerBody.result);
  if (preferredResult !== undefined) {
    compact.result = preferredResult;
  } else {
    const extractedValue = compactValue(workerBody.extracted_value, 192);
    if (extractedValue !== undefined) {
      compact.result = extractedValue;
      compact.result_source = 'extracted_value';
    } else if (workerBody.result !== undefined) {
      compact.result_omitted = true;
      compact.result_hash = workerBody.output_hash || null;
      compact.result_type = Array.isArray(workerBody.result) ? 'array' : typeof workerBody.result;
    }
  }

  if (normalized.includes('feed') && compact.result === undefined && compact.price !== undefined) {
    compact.result = compact.price;
    compact.result_source = 'price';
  }

  return Object.keys(compact).length > 0 ? compact : null;
}

function compactEnvelope(requestType, workerResponse) {
  const kernelIntent = resolveKernelIntent(requestType);
  const workerBody =
    workerResponse?.body && typeof workerResponse.body === 'object'
      ? workerResponse.body
      : { raw: workerResponse?.body ?? null };

  return {
    version: 'morpheus-result/v1',
    request_type: kernelIntent.legacyRequestType,
    module_id: kernelIntent.moduleId,
    operation: kernelIntent.operation,
    success: Boolean(workerResponse?.ok),
    result: buildBusinessResult(kernelIntent.legacyRequestType, workerBody),
    verification: buildVerificationEnvelope(workerBody),
  };
}

// Trust tiers for the result envelope (tiered-trust labeling, design §6):
//   - "enclave-attested": computed + signed inside the measured Nitro boundary
//     (the attested lanes via /oracle/fulfill, or the enclave feed/sign path).
//   - "host-unattested":  computed on the untrusted host worker (the arbitrary-URL
//     oracle.fetch / smart-fetch lane, which cannot be egress-allow-listed).
export const TRUST_TIER_ENCLAVE_ATTESTED = 'enclave-attested';
export const TRUST_TIER_HOST_UNATTESTED = 'host-unattested';

/**
 * Build the compacted on-chain result envelope.
 *
 * CONSENSUS-CRITICAL DIGEST-NEUTRALITY NOTE:
 * The returned envelope is JSON.stringified into the fulfillment `result` field by
 * encodeFulfillmentResult, and that `result` string is hashed verbatim by
 * buildFulfillmentDigestBytes (sha256(resultBytes), resultBytes = utf8(result)
 * when no compact callback bytes are present). Adding ANY field to this object
 * therefore changes the on-chain digest. So `trust_tier` is an OPTIONAL, default-
 * OFF parameter: encodeFulfillmentResult (the digest path) calls this WITHOUT it,
 * keeping the signed bytes byte-identical to today. Only non-digest consumers (the
 * relayer's labeled-envelope/API metadata) pass a trustTier to surface the label.
 * NEVER pass trustTier when producing the bytes that feed the digest.
 */
export function buildOnchainResultEnvelope(requestType, workerResponse, trustTier = null) {
  const envelope = compactEnvelope(requestType, workerResponse);
  if (trustTier) envelope.trust_tier = trustTier;
  const attempts = [
    envelope,
    envelope.result && typeof envelope.result === 'object'
      ? {
          ...envelope,
          result: Object.fromEntries(
            Object.entries(envelope.result).filter(
              ([key]) => !['request_source', 'target_chain_id', 'sources'].includes(key)
            )
          ),
        }
      : envelope,
    envelope.verification
      ? {
          ...envelope,
          verification: {
            output_hash: envelope.verification.output_hash || null,
            attestation_hash: envelope.verification.attestation_hash || null,
            signature: envelope.verification.signature || null,
            public_key: envelope.verification.public_key || null,
            tee_attestation: envelope.verification.tee_attestation
              ? {
                  app_id: envelope.verification.tee_attestation.app_id || null,
                  compose_hash: envelope.verification.tee_attestation.compose_hash || null,
                  report_data: envelope.verification.tee_attestation.report_data || null,
                  quote_hash: envelope.verification.tee_attestation.quote_hash || null,
                }
              : null,
          },
        }
      : envelope,
  ];

  let selected = attempts[attempts.length - 1];
  for (const candidate of attempts) {
    if (measureJsonBytes(candidate) <= 900) {
      selected = candidate;
      break;
    }
  }

  return selected;
}

export function encodeFulfillmentResult(requestType, workerResponse) {
  const normalized = normalizeRequestType(requestType);
  if (!workerResponse.ok) {
    const errorMessage =
      typeof workerResponse.body?.error === 'string'
        ? workerResponse.body.error
        : `worker request failed with status ${workerResponse.status}`;
    return { success: false, result: '', error: trimErrorMessage(errorMessage) };
  }

  const compactBytes = resolveCompactCallbackBytes(normalized, workerResponse);
  if (compactBytes) {
    return {
      success: true,
      result: '',
      result_bytes_base64: compactBytes.toString('base64'),
      error: '',
    };
  }

  const payload = buildOnchainResultEnvelope(normalized, workerResponse);
  return { success: true, result: JSON.stringify(payload), error: '' };
}
