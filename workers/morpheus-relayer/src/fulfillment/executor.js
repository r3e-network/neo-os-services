import crypto from 'node:crypto';
import { callNitro } from '../nitro.js';
import {
  assertSmartFetchUrlAllowed,
  buildWorkerPayload,
  encodeFulfillmentResult,
  isOperatorOnlyRequestType,
  resolveKernelIntent,
  resolveWorkerRoute,
  TRUST_TIER_HOST_UNATTESTED,
} from '../router.js';
import {
  guardQueuedAutomationExecution,
  handleAutomationControlRequest,
  isAutomationControlRequestType,
} from '../automation.js';
import { buildUpkeepDispatch } from '../automation-supervisor.js';
import { normalizeRequestType } from '../lib/strings.js';
import { decodeJsonObjectPayload, resolveEventPayload } from '../lib/payload.js';
import { trimString } from '@r3e-network/neo-os-services-shared/utils';
import {
  resolveExpectedPcr0,
  resolveNitroRootCertPem,
  verifyEnclaveAttestation,
  verifyEnclaveSignatureAgainstPinnedVerifier,
} from '../attestation.js';
import {
  buildTransientWorkerError,
  isTransientWorkerStatus,
  trimOnchainErrorMessage,
} from './classifier.js';
import { buildPreparedFulfillment, deliverPreparedFulfillment } from './delivery.js';
import {
  callEnclaveFulfill,
  defaultHostWorkerTrustTier,
  isHostUnattestedFetchLane,
} from './enclave.js';
import {
  resolveEventFulfillmentContext,
  signEncodedFulfillment,
  signFulfillmentPayload,
} from './signer.js';

/**
 * Fulfillment execution orchestration: request enrichment, lane selection,
 * worker invocation, enclave fallback, and the prepare/deliver entry points.
 *
 * Lower-level helpers live in sibling modules:
 *   - signer.js   : local signer, digest context, signFulfillmentPayload
 *   - enclave.js  : compute-in-enclave fulfillment path
 *   - delivery.js : prepared fulfillment records and on-chain delivery
 *   - classifier.js : error classification
 */

// Re-export attestation helpers so existing importers keep resolving them from
// the fulfillment barrel unchanged.
export {
  resolveExpectedPcr0,
  resolveNitroRootCertPem,
  verifyEnclaveAttestation,
  verifyEnclaveSignatureAgainstPinnedVerifier,
};

// Re-export signing helpers so they remain available from the executor module.
export {
  resolveEventFulfillmentContext,
  resolveFulfillmentSigningContext,
  signFulfillmentPayload,
} from './signer.js';

// Re-export delivery helpers used by coordinator.js and tests.
export {
  buildCallbackPendingWorkerResponse,
  buildPreparedFulfillmentRetryMeta,
  checkpointPreparedFulfillment,
  deliverPreparedFulfillment,
  finalizeFailedRequest,
} from './delivery.js';

/**
 * Identifier hygiene gate (ingestion): kernel identifiers (appId, moduleId,
 * operation — and requestType, which mirrors operation) are routing keys and
 * fulfillment-digest inputs. None of the kernel-defined identifier vocabularies
 * contain whitespace, so any whitespace-bearing identifier is malformed (or
 * adversarial). Returns the first offending field or null.
 *
 * @param {object} event On-chain request event.
 * @returns {{field:string,value:string}|null}
 */
export function findWhitespaceIdentifier(event = {}) {
  for (const field of ['appId', 'moduleId', 'operation', 'requestType']) {
    const value = event[field];
    if (typeof value === 'string' && /\s/.test(value)) {
      return { field, value };
    }
  }
  return null;
}

function assertEventIdentifiersClean(event) {
  const offending = findWhitespaceIdentifier(event);
  if (offending) {
    throw new Error(
      `invalid identifier: request ${String(event.requestId || '')} field ${offending.field} contains whitespace`
    );
  }
}

/**
 * Enrich an automation execution payload with canonical upkeep dispatch fields.
 *
 * @param {object} event On-chain request event.
 * @param {object} payload Decoded request payload.
 * @returns {object} Enriched payload.
 */
export function enrichAutomationExecutionPayload(event, payload) {
  const normalizedRequestType = normalizeRequestType(event?.requestType);
  if (!normalizedRequestType.startsWith('automation_')) return payload;

  const automationId = trimString(payload?.automation_id || '');
  if (!automationId) return payload;

  const dispatch = buildUpkeepDispatch({
    chain: event.chain,
    automation_id: automationId,
    execution_id: trimString(payload.execution_id || '') || String(event.requestId || ''),
    workflow_id: trimString(payload.workflow_id || 'automation.upkeep'),
    request_id: trimString(payload.request_id || ''),
    idempotency_key: trimString(payload.idempotency_key || ''),
  });

  return {
    ...payload,
    workflow_id: payload.workflow_id || dispatch.workflow_id,
    workflow_version: payload.workflow_version || dispatch.workflow_version,
    execution_id: payload.execution_id || dispatch.execution_id,
    idempotency_key: payload.idempotency_key || dispatch.idempotency_key,
    replay_window: payload.replay_window || dispatch.replay_window,
    delivery_mode: payload.delivery_mode || dispatch.delivery_mode,
  };
}

/**
 * True when a payload looks like a queued automation execution request.
 *
 * @param {*} payload Request payload.
 * @returns {boolean}
 */
export function isQueuedAutomationExecutionPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const automationId = trimString(payload.automation_id || payload.automationId || '');
  if (!automationId) return false;
  return Boolean(
    trimString(payload.workflow_id || payload.workflowId || '') ||
    trimString(payload.execution_id || payload.executionId || '') ||
    trimString(payload.idempotency_key || payload.idempotencyKey || '') ||
    trimString(payload.delivery_mode || payload.deliveryMode || '')
  );
}

/**
 * Build the /oracle/decrypt request body for the confidential.decrypt lane,
 * including the binding fields the worker's gated decrypt expects.
 *
 * @param {object} config Relayer configuration.
 * @param {object} event On-chain request event.
 * @param {object} payload Decoded request payload.
 * @param {string} envelope Sealed envelope ciphertext.
 * @returns {object} Decrypt request body.
 */
export function buildDecryptBindingRequest(config, event = {}, payload = {}, envelope = '') {
  const request = { envelope };
  const messageId =
    payload?.message_id ??
    payload?.messageId ??
    payload?.id ??
    event?.messageId ??
    event?.message_id ??
    null;
  const normalizedMessageId =
    messageId === null || messageId === undefined || trimString(String(messageId)) === ''
      ? null
      : trimString(String(messageId));
  if (normalizedMessageId === null) return request;

  request.message_id = normalizedMessageId;
  request.chain = 'neox';
  const contract =
    trimString(payload?.contract || payload?.contract_address || '') ||
    trimString(config?.neox?.messageContract || config?.neox?.oracleContract || '');
  if (contract) request.contract = contract;
  return request;
}

export async function prepareOracleFulfillment(config, event, logger = null) {
  assertEventIdentifiersClean(event);
  resolveEventPayload(event);
  const kernelIntent = resolveKernelIntent(event.requestType);
  const payload = enrichAutomationExecutionPayload(
    event,
    decodeJsonObjectPayload(event.payloadText, {
      allowNonObject: kernelIntent.moduleId === 'confidential.decrypt',
    })
  );
  const fulfillmentContext = resolveEventFulfillmentContext(event, kernelIntent);

  if (isAutomationControlRequestType(event.requestType)) {
    const automationResponse = await handleAutomationControlRequest(event, payload);
    const fulfillment = encodeFulfillmentResult(event.requestType, automationResponse);
    const verification = await signEncodedFulfillment(
      config,
      event,
      fulfillmentContext,
      fulfillment
    );
    return buildPreparedFulfillment(fulfillment, {
      route: automationResponse.route,
      module_id: fulfillmentContext.moduleId,
      operation: fulfillmentContext.operation,
      worker_response: automationResponse.body,
      worker_status: automationResponse.status,
      verification_signature: verification.signature,
    });
  }

  if (isQueuedAutomationExecutionPayload(payload)) {
    const automationGuard = await guardQueuedAutomationExecution(event);
    if (automationGuard.blocked) {
      const guardResponse = {
        ok: false,
        status: 409,
        body: {
          mode: 'automation',
          action: 'execute',
          automation_id: automationGuard.automation_id,
          status: automationGuard.job?.status || 'cancelled',
          chain: event.chain,
          error: automationGuard.error,
        },
      };
      const fulfillment = encodeFulfillmentResult(event.requestType, guardResponse);
      const verification = await signEncodedFulfillment(
        config,
        event,
        fulfillmentContext,
        fulfillment
      );
      return buildPreparedFulfillment(fulfillment, {
        route: automationGuard.route,
        module_id: fulfillmentContext.moduleId,
        operation: fulfillmentContext.operation,
        worker_response: guardResponse.body,
        worker_status: guardResponse.status,
        verification_signature: verification.signature,
      });
    }
  }

  if (isOperatorOnlyRequestType(event.requestType)) {
    const errorText =
      'datafeed requests are operator-only; users should read synchronized on-chain feed data';
    const verification = await signFulfillmentPayload(config, event.chain, {
      requestId: event.requestId,
      requestType: event.requestType,
      ...fulfillmentContext,
      ...resolveEventPayload(event),
      success: false,
      result: '',
      result_bytes_base64: '',
      error: errorText,
    });
    return buildPreparedFulfillment(
      { success: false, result: '', error: errorText, result_bytes_base64: '' },
      {
        route: 'operator-only:rejected',
        module_id: fulfillmentContext.moduleId,
        operation: fulfillmentContext.operation,
        worker_response: null,
        worker_status: null,
        verification_signature: verification.signature,
      }
    );
  }

  // Compute-in-enclave attested path (flag-gated, Phase 4).
  if (config?.nitro?.enclaveFulfill && !isHostUnattestedFetchLane(kernelIntent, payload)) {
    const enclaveResult = await callEnclaveFulfill(
      config,
      event.chain,
      event,
      fulfillmentContext,
      payload,
      kernelIntent
    );
    return buildPreparedFulfillment(enclaveResult.fulfillment, {
      route: `enclave:${kernelIntent.moduleId}`,
      module_id: fulfillmentContext.moduleId,
      operation: fulfillmentContext.operation,
      worker_response: enclaveResult.worker_response,
      worker_status: 200,
      verification_signature: enclaveResult.signature,
      trust_tier: enclaveResult.trust_tier,
    });
  }

  // Local VRF handler.
  if (kernelIntent.moduleId === 'random.generate') {
    // Fail closed (M-vrf): this relayer-local CSPRNG fallback is unbound to the
    // request, the host operator sees the outcome pre-broadcast, and the
    // on-chain pinned-verifier signature is indistinguishable from an
    // enclave-attested VRF — so in production only the compute-in-enclave lane
    // may fulfill randomness. The 'enclave fulfillment required' prefix maps to
    // a terminal configuration error in classifier.js (no retry burn, no
    // on-chain failure callback). Dev/test keep the fallback.
    //
    // The enclave lane is the request-bound derivation: the output is an
    // HMAC-SHA256, under a VRF subkey HKDF-derived from the attested KMS root,
    // over the measured network, chain family, chain id, oracle contract,
    // request id and module (neoos-vrf-random-v2), so a request cannot be
    // re-rolled. That output is still not third-party verifiable, and anyone
    // holding an enclave token can compute it before the request exists;
    // owner decision O18 (docs/security/VRF-DESIGN-20260926.md) chooses
    // between published VRF proofs, chain-bound input and commit-reveal. A
    // relayer-side derivation would have neither the attestation nor that
    // decision behind it, so this fallback stays fail-closed in production.
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'enclave fulfillment required in production: random.generate refuses the ' +
          'relayer-local VRF fallback (NODE_ENV=production); enable the compute-in-enclave ' +
          'lane (MORPHEUS_RELAYER_ENCLAVE_FULFILL=1)'
      );
    }
    const randomness = crypto.randomBytes(32).toString('hex');
    const vrfResponse = { ok: true, status: 200, body: { randomness } };
    const vrfFulfillment = encodeFulfillmentResult(event.requestType, vrfResponse);
    const vrfVerification = await signEncodedFulfillment(
      config,
      event,
      fulfillmentContext,
      vrfFulfillment
    );
    return buildPreparedFulfillment(vrfFulfillment, {
      route: 'local:vrf',
      module_id: fulfillmentContext.moduleId,
      operation: fulfillmentContext.operation,
      worker_response: vrfResponse.body,
      worker_status: 200,
      verification_signature: vrfVerification.signature,
      trust_tier: defaultHostWorkerTrustTier(config),
    });
  }

  // Confidential reveal.
  if (kernelIntent.moduleId === 'confidential.decrypt') {
    const envelope = trimString(event.payloadText || '');
    const decResponse = await callNitro(
      config,
      '/oracle/decrypt',
      buildDecryptBindingRequest(config, event, payload, envelope),
      { baseUrl: config.nitro.decryptUrl || config.nitro.signerUrl, allowFallback: false }
    );
    if (!decResponse.ok && isTransientWorkerStatus(decResponse.status)) {
      throw buildTransientWorkerError(
        decResponse.status,
        typeof decResponse.body?.error === 'string'
          ? decResponse.body.error
          : 'confidential decrypt'
      );
    }
    const ok = decResponse.ok && typeof decResponse.body?.plaintext === 'string';
    const decryptFulfillment = ok
      ? {
          success: true,
          result: '',
          result_bytes_base64: Buffer.from(decResponse.body.plaintext, 'utf8').toString('base64'),
          error: '',
        }
      : {
          success: false,
          result: '',
          result_bytes_base64: '',
          error: trimOnchainErrorMessage(decResponse.body?.error || 'confidential decrypt failed'),
        };
    const decryptVerification = await signFulfillmentPayload(config, event.chain, {
      requestId: event.requestId,
      requestType: event.requestType,
      ...fulfillmentContext,
      ...resolveEventPayload(event),
      success: decryptFulfillment.success,
      result: decryptFulfillment.result,
      result_bytes_base64: decryptFulfillment.result_bytes_base64,
      error: decryptFulfillment.error,
    });
    // SECURITY (S10): never persist the decrypted plaintext in worker_response
    // (which lands in the durable queue, local state and Supabase). The bytes
    // exist only in result_bytes_base64 for the on-chain settlement; the stored
    // worker response is a metadata-only allowlist.
    const decryptWorkerResponse = ok
      ? {
          success: true,
          message_id:
            trimString(decResponse.body?.message_id || decResponse.body?.messageId || '') || null,
          plaintext_length: Buffer.byteLength(decResponse.body.plaintext, 'utf8'),
        }
      : {
          success: false,
          error: trimOnchainErrorMessage(decResponse.body?.error || 'confidential decrypt failed'),
        };
    return buildPreparedFulfillment(decryptFulfillment, {
      route: 'oracle:decrypt',
      module_id: fulfillmentContext.moduleId,
      operation: fulfillmentContext.operation,
      worker_response: decryptWorkerResponse,
      worker_status: decResponse.status,
      verification_signature: decryptVerification.signature,
    });
  }

  const route = resolveWorkerRoute(event.requestType, payload);
  // SECURITY (S11): the smart-fetch lane forwards a caller-supplied URL to the
  // internal worker; gate it at the boundary (https-only, no private targets,
  // optional host allowlist) so a chain request cannot turn the relayer into an
  // SSRF proxy.
  if (route === '/oracle/smart-fetch') {
    assertSmartFetchUrlAllowed(trimString(payload?.url || ''));
  }
  const workerPayload = buildWorkerPayload(
    event.chain,
    event.requestType,
    payload,
    event.requestId,
    {
      requester: event.requester,
      callbackContract: event.callbackContract,
      callbackMethod: event.callbackMethod,
    }
  );
  const workerStartedAt = Date.now();
  const workerResponse = await callNitro(config, route, workerPayload);
  const workerDurationMs = Date.now() - workerStartedAt;

  if (!workerResponse.ok && isTransientWorkerStatus(workerResponse.status)) {
    throw buildTransientWorkerError(
      workerResponse.status,
      typeof workerResponse.body?.error === 'string' ? workerResponse.body.error : ''
    );
  }
  const fulfillment = encodeFulfillmentResult(event.requestType, workerResponse);
  const verificationStartedAt = Date.now();
  const verification = await signEncodedFulfillment(config, event, fulfillmentContext, fulfillment);
  const verificationDurationMs = Date.now() - verificationStartedAt;

  logger?.info(
    {
      chain: event.chain,
      request_id: event.requestId,
      request_type: event.requestType,
      route,
      worker_status: workerResponse.status,
      fulfillment_success: fulfillment.success,
      result_bytes_base64_present: Boolean(fulfillment.result_bytes_base64),
      result_length: typeof fulfillment.result === 'string' ? fulfillment.result.length : null,
      error_text: fulfillment.error || '',
    },
    'Prepared oracle fulfillment payload'
  );

  return buildPreparedFulfillment(fulfillment, {
    route,
    module_id: fulfillmentContext.moduleId,
    operation: fulfillmentContext.operation,
    worker_response: workerResponse.body,
    worker_status: workerResponse.status,
    verification_signature: verification.signature,
    trust_tier: isHostUnattestedFetchLane(kernelIntent, payload)
      ? TRUST_TIER_HOST_UNATTESTED
      : defaultHostWorkerTrustTier(config),
    durations_ms: {
      worker: workerDurationMs,
      verification: verificationDurationMs,
      total: workerDurationMs + verificationDurationMs,
    },
  });
}

/**
 * Prepare and immediately deliver a single oracle request fulfillment.
 *
 * @param {object} config Relayer configuration.
 * @param {object} event On-chain request event.
 * @param {object|null} logger Optional logger.
 * @returns {Promise<object>} Delivery result.
 */
export async function processOracleRequest(config, event, logger = null) {
  const prepared = await prepareOracleFulfillment(config, event, logger);
  return deliverPreparedFulfillment(config, event, prepared);
}

// Re-export retry helper for consumers that historically resolved it from the
// fulfillment barrel.
export { computeRetryDelayMs } from '../lib/retry.js';
