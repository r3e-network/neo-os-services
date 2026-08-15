import crypto from 'node:crypto';
import { callNitro } from '../nitro.js';
import {
  buildFulfillmentDigestBytes,
  TRUST_TIER_ENCLAVE_ATTESTED,
  TRUST_TIER_HOST_UNATTESTED,
} from '../router.js';
import { buildNeoXDigest, resolveResultBytesHex } from '../neox.js';
import { trimString } from '@r3e-network/neo-os-services-shared/utils';
import {
  enclaveSignatureVerificationEnabled,
  normalizePublicKey,
  verifyEnclaveAttestation,
  verifyEnclaveSignatureAgainstPinnedVerifier,
} from '../attestation.js';
import { buildTransientWorkerError, isTransientWorkerStatus } from './classifier.js';
import { resolveDigestBinding } from './signer.js';

/**
 * Compute-in-enclave fulfillment helpers (POST /oracle/fulfill). Flag-gated:
 * when config.nitro.enclaveFulfill is true the attested lanes call the enclave's
 * atomic compute+sign endpoint once instead of the host-worker compute + enclave
 * /sign/payload two-step.
 */

// The host-unattested arbitrary-URL fetch lane cannot be egress-allow-listed
// inside the enclave, so it stays on the host worker regardless of the flag.
export function isHostUnattestedFetchLane(kernelIntent, payload) {
  if (kernelIntent.workerRoute !== '/oracle/smart-fetch') return false;
  return Boolean(trimString(payload?.url || ''));
}

// Truthful default trust_tier for a lane computed on the HOST worker. With the
// enclave-fulfill flag OFF the host worker is NOT a measured enclave and its
// lanes are host-unattested. With the flag ON the host worker IS the attested
// enclave and keeps the attested label.
export function defaultHostWorkerTrustTier(config) {
  return config?.nitro?.enclaveFulfill ? TRUST_TIER_ENCLAVE_ATTESTED : TRUST_TIER_HOST_UNATTESTED;
}

// Recompute the fulfillment digest LOCALLY from the result the enclave returned,
// using the SAME canonical builders + binding the relayer's own signing path
// uses. Returns lowercase hex digest for comparison with enclave's
// fulfillment_digest_hex.
function recomputeFulfillmentDigestHex(config, chain, fulfillment) {
  if (chain === 'neox') {
    const resultBytesHex = resolveResultBytesHex(
      fulfillment.result,
      fulfillment.result_bytes_base64 || ''
    );
    return normalizePublicKey(buildNeoXDigest(config, fulfillment, resultBytesHex));
  }
  const digestContext = resolveDigestBinding(config, chain, fulfillment);
  const digestBytes = buildFulfillmentDigestBytes(
    fulfillment.requestId,
    fulfillment.requestType,
    fulfillment.success,
    fulfillment.result,
    fulfillment.error,
    fulfillment.result_bytes_base64 || '',
    digestContext
  );
  return digestBytes.toString('hex');
}

// Build the kernel-context object the enclave /oracle/fulfill endpoint needs to
// rebuild the EXACT digest.
function buildEnclaveFulfillmentContext(config, chain, event, fulfillmentContext) {
  const base = {
    app_id: fulfillmentContext.appId,
    module_id: fulfillmentContext.moduleId,
    operation: fulfillmentContext.operation,
  };
  if (chain === 'neox') {
    return {
      ...base,
      chain_id: config?.neox?.chainId,
      oracle_contract: config?.neox?.oracleContract || '',
    };
  }
  return {
    ...base,
    contract_script_hash: config?.neo_n3?.oracleContract || '',
    network_magic: config?.neo_n3?.networkMagic,
  };
}

/**
 * Single atomic compute+sign call to the enclave for an attested lane. Asserts
 * the returned digest equals the relayer's own recomputation and verifies
 * attestation/signature before the caller submits.
 *
 * @param {object} config Relayer configuration.
 * @param {string} chain Target chain id.
 * @param {object} event On-chain request event.
 * @param {object} fulfillmentContext Resolved fulfillment context.
 * @param {object} payload Decoded request payload.
 * @param {object} _kernelIntent Resolved kernel intent (reserved).
 * @returns {Promise<object>} Enclave fulfillment result.
 */
export async function callEnclaveFulfill(
  config,
  chain,
  event,
  fulfillmentContext,
  payload,
  _kernelIntent
) {
  const requestNonce = crypto.randomBytes(16).toString('hex');
  const enclavePayload = {
    chain,
    request_type: event.requestType,
    request_id: String(event.requestId),
    payload: {
      ...payload,
      requester: event.requester || payload.requester || '',
      callback_contract: event.callbackContract || payload.callback_contract || '',
      callback_method: event.callbackMethod || payload.callback_method || '',
    },
    payload_text: event.payloadText || '',
    fulfillment_context: buildEnclaveFulfillmentContext(config, chain, event, fulfillmentContext),
    nonce: requestNonce,
  };

  const response = await callNitro(config, '/oracle/fulfill', enclavePayload, {
    baseUrl: config.nitro.enclaveFulfillUrl,
  });

  if (!response.ok && isTransientWorkerStatus(response.status)) {
    throw buildTransientWorkerError(
      response.status,
      typeof response.body?.error === 'string' ? response.body.error : 'enclave fulfill'
    );
  }

  const body = response.body && typeof response.body === 'object' ? response.body : {};
  if (!response.ok) {
    throw new Error(
      typeof body.error === 'string' && body.error
        ? body.error
        : `enclave fulfill failed with status ${response.status}`
    );
  }
  if (typeof body.signature !== 'string' || !body.signature) {
    throw new Error(
      typeof body.error === 'string' && body.error
        ? body.error
        : 'enclave fulfill returned no signature'
    );
  }

  const fulfillment = {
    requestId: String(event.requestId),
    requestType: event.requestType,
    appId: fulfillmentContext.appId,
    moduleId: fulfillmentContext.moduleId,
    operation: fulfillmentContext.operation,
    success: Boolean(body.success),
    result: typeof body.result === 'string' ? body.result : '',
    result_bytes_base64:
      typeof body.result_bytes_base64 === 'string' ? body.result_bytes_base64 : '',
    error: typeof body.error === 'string' ? body.error : '',
  };

  const returnedDigest = normalizePublicKey(body.fulfillment_digest_hex || '');
  const localDigest = normalizePublicKey(recomputeFulfillmentDigestHex(config, chain, fulfillment));
  if (!returnedDigest || returnedDigest !== localDigest) {
    throw new Error(
      'invalid signature: enclave fulfillment digest mismatch ' +
        `(enclave=${returnedDigest || 'missing'} relayer=${localDigest}) — refusing to submit`
    );
  }

  if (enclaveSignatureVerificationEnabled(config)) {
    verifyEnclaveSignatureAgainstPinnedVerifier(config, chain, body, localDigest);
  }

  const attestation = verifyEnclaveAttestation(config, body, localDigest, {
    expectedNonce: requestNonce,
  });
  const trustTier = attestation.attested ? TRUST_TIER_ENCLAVE_ATTESTED : TRUST_TIER_HOST_UNATTESTED;

  return {
    fulfillment,
    signature: body.signature,
    trust_tier: trustTier,
    attestation,
    worker_response:
      body.verification && typeof body.verification === 'object' ? body.verification : body,
  };
}
