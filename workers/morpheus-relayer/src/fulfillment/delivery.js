import { buildEventKey } from '../state.js';
import {
  ensureDurableQueueAvailable,
  isTransientDurableQueueError,
  maybeUpsertJob,
  upsertJobOrThrow,
} from '../queue.js';
import { resolveKernelIntent, TRUST_TIER_ENCLAVE_ATTESTED } from '../router.js';
import { fulfillNeoN3Request } from '../neo-n3.js';
import { fulfillNeoXRequest } from '../neox.js';
import { normalizeErrorMessage } from '../feed-sync.js';
import { resolveEventFulfillmentContext, signFulfillmentPayload } from './signer.js';
import { trimOnchainErrorMessage } from './classifier.js';

/**
 * Prepared-fulfillment helpers: building retry metadata, checkpointing pending
 * callbacks, delivering prepared fulfillments, and finalizing failed requests.
 */

/**
 * Build the retry-metadata object for a prepared fulfillment. This shape is
 * stored in retry items and durable queue jobs.
 *
 * @param {object} prepared Prepared fulfillment record.
 * @returns {object}
 */
export function buildPreparedFulfillmentRetryMeta(prepared = {}) {
  return {
    success: Boolean(prepared.success),
    result: typeof prepared.result === 'string' ? prepared.result : '',
    result_bytes_base64:
      typeof prepared.result_bytes_base64 === 'string' ? prepared.result_bytes_base64 : '',
    error: typeof prepared.error === 'string' ? prepared.error : '',
    route: typeof prepared.route === 'string' ? prepared.route : '',
    module_id: typeof prepared.module_id === 'string' ? prepared.module_id : '',
    operation: typeof prepared.operation === 'string' ? prepared.operation : '',
    worker_status: Number.isFinite(Number(prepared.worker_status))
      ? Number(prepared.worker_status)
      : null,
    worker_response:
      prepared.worker_response && typeof prepared.worker_response === 'object'
        ? prepared.worker_response
        : null,
    verification_signature:
      typeof prepared.verification_signature === 'string' ? prepared.verification_signature : '',
    trust_tier:
      typeof prepared.trust_tier === 'string' && prepared.trust_tier
        ? prepared.trust_tier
        : TRUST_TIER_ENCLAVE_ATTESTED,
  };
}

/**
 * Build the worker_response shape stored with a callback-pending retry item.
 *
 * @param {object} prepared Prepared fulfillment record.
 * @param {object} kernelIntent Resolved kernel intent.
 * @returns {object}
 */
export function buildCallbackPendingWorkerResponse(prepared, kernelIntent) {
  const retryMeta = {
    prepared_fulfillment: buildPreparedFulfillmentRetryMeta(prepared),
    module_id: prepared.module_id || kernelIntent.moduleId,
    operation: prepared.operation || kernelIntent.operation,
  };
  if (prepared.worker_response && typeof prepared.worker_response === 'object') {
    return {
      ...prepared.worker_response,
      retry_meta: {
        ...(prepared.worker_response.retry_meta &&
        typeof prepared.worker_response.retry_meta === 'object'
          ? prepared.worker_response.retry_meta
          : {}),
        ...retryMeta,
      },
    };
  }
  return {
    retry_meta: retryMeta,
  };
}

/**
 * Persist a prepared fulfillment as callback_pending in the durable queue.
 *
 * @param {object} config Relayer configuration.
 * @param {object} logger Logger.
 * @param {object} event On-chain request event.
 * @param {object} prepared Prepared fulfillment record.
 * @param {number} attempts Attempt count.
 * @param {object} kernelIntent Resolved kernel intent.
 */
export async function checkpointPreparedFulfillment(
  config,
  logger,
  event,
  prepared,
  attempts,
  kernelIntent
) {
  const details = {
    event_key: buildEventKey(event),
    status: 'callback_pending',
    attempts,
    route: prepared.route,
    worker_status: prepared.worker_status,
    worker_response: buildCallbackPendingWorkerResponse(prepared, kernelIntent),
    next_retry_at: null,
  };

  if (config.durableQueue?.enabled) {
    if (ensureDurableQueueAvailable(config, logger, `${event.chain}:callback-pending-checkpoint`)) {
      try {
        await upsertJobOrThrow(event, details);
      } catch (error) {
        if (!isTransientDurableQueueError(error)) throw error;
        logger.warn(
          {
            chain: event.chain,
            request_id: event.requestId,
            event_key: details.event_key,
            error,
          },
          'Durable Supabase callback checkpoint unavailable; local prepared fulfillment is persisted'
        );
      }
      return;
    }
  }

  await maybeUpsertJob(logger, event, details);
}

async function fulfillNeoRequest(config, event, fulfillment, verification) {
  if (typeof config?.hooks?.fulfillNeoRequest === 'function') {
    return config.hooks.fulfillNeoRequest({
      event,
      requestId: event.requestId,
      fulfillment,
      verification,
    });
  }
  if (event.chain === 'neox') {
    return fulfillNeoXRequest(
      config,
      event.requestId,
      fulfillment.success,
      fulfillment.result,
      fulfillment.error,
      verification.signature,
      fulfillment.result_bytes_base64
    );
  }
  try {
    return await fulfillNeoN3Request(
      config,
      event.requestId,
      fulfillment.success,
      fulfillment.result,
      fulfillment.error,
      verification.signature,
      fulfillment.result_bytes_base64
    );
  } catch (error) {
    const message = normalizeErrorMessage(error);
    if (message.toLowerCase().includes('request not found') && event.chain === 'neo_n3') {
      throw new Error(`${message} [chain=${event.chain} request_id=${event.requestId}]`);
    }
    throw error;
  }
}

/**
 * Submit a prepared fulfillment on-chain.
 *
 * @param {object} config Relayer configuration.
 * @param {object} event On-chain request event.
 * @param {object} prepared Prepared fulfillment record.
 * @returns {Promise<object>} Delivery result with fulfill_tx.
 */
export async function deliverPreparedFulfillment(config, event, prepared) {
  const fulfillStartedAt = Date.now();
  const fulfillTx = await fulfillNeoRequest(
    config,
    event,
    {
      success: Boolean(prepared.success),
      result: prepared.result || '',
      error: prepared.error || '',
      result_bytes_base64: prepared.result_bytes_base64 || '',
    },
    { signature: prepared.verification_signature || '' }
  );
  const fulfillDurationMs = Date.now() - fulfillStartedAt;
  return {
    ...prepared,
    fulfill_tx: fulfillTx,
    durations_ms: {
      ...(prepared.durations_ms && typeof prepared.durations_ms === 'object'
        ? prepared.durations_ms
        : {}),
      fulfill: fulfillDurationMs,
    },
  };
}

/**
 * Finalize a request with an on-chain failure callback. Signs the failure
 * fulfillment and submits it to the target chain.
 *
 * @param {object} config Relayer configuration.
 * @param {object} event On-chain request event.
 * @param {string} errorMessage Failure reason.
 * @returns {Promise<object>} Failure result record.
 */
export async function finalizeFailedRequest(config, event, errorMessage) {
  const safeError = trimOnchainErrorMessage(errorMessage);
  const kernelIntent = resolveKernelIntent(event.requestType);
  const fulfillmentContext = resolveEventFulfillmentContext(event, kernelIntent);
  const verification = await signFulfillmentPayload(config, event.chain, {
    requestId: event.requestId,
    requestType: event.requestType,
    ...fulfillmentContext,
    success: false,
    result: '',
    result_bytes_base64: '',
    error: safeError,
  });
  const fulfillTx = await fulfillNeoRequest(
    config,
    event,
    {
      success: false,
      result: '',
      error: safeError,
      result_bytes_base64: '',
    },
    verification
  );
  return {
    success: false,
    result: '',
    error: safeError,
    route: 'failure-finalize',
    worker_response: null,
    worker_status: null,
    fulfill_tx: fulfillTx,
    verification_signature: verification.signature,
  };
}

/**
 * Build a prepared fulfillment record from a fulfillment envelope and detail
 * fields. Used internally by prepareOracleFulfillment.
 *
 * @param {object} fulfillment Fulfillment envelope.
 * @param {object} details Extra detail fields.
 * @returns {object}
 */
export function buildPreparedFulfillment(fulfillment, details = {}) {
  return buildPreparedFulfillmentRetryMeta({
    success: fulfillment.success,
    result: fulfillment.result || '',
    result_bytes_base64: fulfillment.result_bytes_base64 || '',
    error: fulfillment.error || '',
    route: details.route || '',
    module_id: details.module_id || '',
    operation: details.operation || '',
    worker_status: details.worker_status ?? null,
    worker_response: details.worker_response || null,
    verification_signature: details.verification_signature || '',
    trust_tier: details.trust_tier || TRUST_TIER_ENCLAVE_ATTESTED,
  });
}
