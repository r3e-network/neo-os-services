import {
  buildEventKey,
  clearRetryItem,
  enqueueRetryItem,
  incrementLabeledFailure,
  incrementMetric,
  recordProcessedEvent,
} from '../state.js';
import { maybeUpsertJob } from '../queue.js';
import { computeRetryDelayMs } from '../lib/retry.js';
import { sendHeartbeat } from '../heartbeat.js';
import { classifyError, trimOnchainErrorMessage } from './classifier.js';

/**
 * Retry / delivery dispatch helpers shared by processEvent. These functions
 * decide whether to schedule another callback-delivery attempt, dead-letter an
 * exhausted request, or record a terminal outcome.
 */

/**
 * Ceiling on callback-delivery / failure-finalize redelivery attempts. The
 * prepared-fulfillment and finalize-only retry lanes bypass scheduleRetry's
 * maxRetries check (the payload is already prepared, only the on-chain
 * submission is retried), so without this cap a poison request would redeliver
 * forever. Defaults to maxRetries * 2 when MORPHEUS_RELAYER_MAX_CALLBACK_RETRIES
 * is not configured.
 *
 * @param {object} config Relayer configuration.
 * @returns {number}
 */
export function resolveCallbackRetryCeiling(config) {
  const explicit = Number(config?.maxCallbackRetries);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  return Math.max(Number(config?.maxRetries || 0) * 2, 1);
}

// Dead-letter a delivery lane that is permanently failing or has exceeded the
// callback retry ceiling: record 'exhausted' locally and mirror the status to
// the durable Supabase queue.
export async function recordDeliveryExhaustion(
  config,
  state,
  persistState,
  logger,
  event,
  kernelIntent,
  { attempts, route, errorMessage, errorClass, terminalError = null }
) {
  const eventKey = buildEventKey(event);
  const lastError = trimOnchainErrorMessage(errorMessage);
  incrementMetric(state, 'retries_exhausted_total');
  incrementLabeledFailure(state, event.chain, kernelIntent.moduleId, kernelIntent.operation);
  recordProcessedEvent(
    state,
    event.chain,
    event,
    'exhausted',
    {
      attempts,
      route,
      module_id: kernelIntent.moduleId,
      operation: kernelIntent.operation,
      last_error: lastError,
      ...(terminalError ? { terminal_error: terminalError } : {}),
    },
    config
  );
  clearRetryItem(state, event.chain, eventKey);
  persistState();

  await maybeUpsertJob(logger, event, {
    event_key: eventKey,
    status: 'exhausted',
    attempts,
    route,
    last_error: lastError,
    completed_at: new Date().toISOString(),
    next_retry_at: null,
  });

  logger.error(
    {
      chain: event.chain,
      request_id: event.requestId,
      request_type: event.requestType,
      module_id: kernelIntent.moduleId,
      operation: kernelIntent.operation,
      event_key: eventKey,
      attempts,
      route,
      error_class: errorClass.level,
      error: lastError,
      terminal_error: terminalError,
    },
    'Callback delivery retries exhausted; dead-lettered oracle request for manual replay'
  );
  void sendHeartbeat(config?.heartbeats?.deadLetter || config?.heartbeats?.failure || '', {
    event: 'relayer_dead_letter',
    network: config?.network,
    chain: event.chain,
    request_id: String(event.requestId || ''),
    request_type: String(event.requestType || ''),
    module_id: kernelIntent.moduleId,
    operation: kernelIntent.operation,
    event_key: eventKey,
    attempts,
    route,
    error_class: errorClass.level,
    error: lastError,
    terminal_error: terminalError,
  });
  return {
    event,
    error: lastError,
    retry_status: 'exhausted',
    event_key: eventKey,
    attempts,
  };
}

/**
 * Re-enqueue a callback-delivery / failure-finalize retry that bypasses
 * scheduleRetry's maxRetries gate.
 */
export async function scheduleCallbackRetry(
  config,
  state,
  persistState,
  logger,
  event,
  kernelIntent,
  {
    nextAttempts,
    firstFailedAt,
    errorMessage,
    extraRetryItemFields = {},
    upsertStatus,
    upsertExtras = {},
    upsertWorkerResponse,
    retryStatus,
    logLevel,
    logMessage,
    logModuleId,
    logOperation,
  }
) {
  const eventKey = buildEventKey(event);
  const retryItemNext = enqueueRetryItem(state, event.chain, event, {
    attempts: nextAttempts,
    next_retry_at: Date.now() + computeRetryDelayMs(config, nextAttempts),
    first_failed_at: firstFailedAt,
    last_error: trimOnchainErrorMessage(errorMessage),
    retryQueueLimit: config.retryQueueLimit,
    deadLetterLimit: config.deadLetterLimit,
    ...extraRetryItemFields,
  });
  incrementMetric(state, 'retries_scheduled_total');
  persistState();

  await maybeUpsertJob(logger, event, {
    event_key: eventKey,
    status: upsertStatus,
    attempts: retryItemNext.attempts,
    ...upsertExtras,
    last_error: retryItemNext.last_error,
    next_retry_at: new Date(retryItemNext.next_retry_at).toISOString(),
    worker_response: upsertWorkerResponse,
  });

  logger[logLevel](
    {
      chain: event.chain,
      request_id: event.requestId,
      request_type: event.requestType,
      module_id: logModuleId ?? kernelIntent.moduleId,
      operation: logOperation ?? kernelIntent.operation,
      event_key: eventKey,
      attempts: retryItemNext.attempts,
      retry_at: retryItemNext.next_retry_at,
      error: retryItemNext.last_error,
    },
    logMessage
  );

  return {
    event,
    error: retryItemNext.last_error,
    retry_status: retryStatus,
    event_key: eventKey,
    attempts: retryItemNext.attempts,
  };
}

/**
 * Record a terminal (non-exhaustion) processing outcome — the 'settled'
 * (already-fulfilled-on-chain) and terminal-configuration-error arms.
 */
export async function recordTerminalOutcome(
  config,
  state,
  persistState,
  logger,
  event,
  kernelIntent,
  {
    attempts,
    localStatus,
    durableStatus,
    route,
    lastError,
    metric = null,
    logLevel,
    logMessage,
    extraMeta = {},
    retryStatus,
  }
) {
  const eventKey = buildEventKey(event);
  if (metric) incrementMetric(state, metric);
  recordProcessedEvent(
    state,
    event.chain,
    event,
    localStatus,
    {
      attempts,
      route,
      module_id: kernelIntent.moduleId,
      operation: kernelIntent.operation,
      last_error: lastError,
      ...extraMeta,
    },
    config
  );
  clearRetryItem(state, event.chain, eventKey);
  persistState();

  await maybeUpsertJob(logger, event, {
    event_key: eventKey,
    status: durableStatus,
    attempts,
    last_error: lastError,
    completed_at: new Date().toISOString(),
    next_retry_at: null,
  });

  logger[logLevel](
    {
      chain: event.chain,
      request_id: event.requestId,
      request_type: event.requestType,
      module_id: kernelIntent.moduleId,
      operation: kernelIntent.operation,
      event_key: eventKey,
      attempts,
      ...(logLevel === 'error' ? { error: lastError } : {}),
    },
    logMessage
  );

  return {
    event,
    ...(retryStatus === 'settled' ? { result: null } : { error: lastError }),
    retry_status: retryStatus,
    event_key: eventKey,
    attempts,
  };
}

/**
 * Collapse the duplicated "delivery error: is it permanent / over the callback
 * ceiling? -> dead-letter, else schedule another attempt" arms.
 */
export async function resolveDeliveryRetryOrExhaust(
  config,
  state,
  persistState,
  logger,
  event,
  kernelIntent,
  {
    nextAttempts,
    errorMessage,
    errorClass = null,
    exhaustRoute,
    exhaustTerminalError = null,
    retryOptions,
  }
) {
  const deliveryErrorClass = errorClass || classifyError(errorMessage);
  if (
    deliveryErrorClass.level === 'permanent' ||
    nextAttempts > resolveCallbackRetryCeiling(config)
  ) {
    return recordDeliveryExhaustion(config, state, persistState, logger, event, kernelIntent, {
      attempts: nextAttempts,
      route: exhaustRoute,
      errorMessage,
      errorClass: deliveryErrorClass,
      ...(exhaustTerminalError !== null ? { terminalError: exhaustTerminalError } : {}),
    });
  }
  return scheduleCallbackRetry(config, state, persistState, logger, event, kernelIntent, {
    nextAttempts,
    errorMessage,
    ...retryOptions,
  });
}

/**
 * Record a request finalized with an on-chain failure callback.
 */
export async function recordFinalizedFailure(
  config,
  state,
  persistState,
  logger,
  event,
  kernelIntent,
  eventKey,
  attempts,
  result
) {
  incrementMetric(state, 'events_processed_total');
  incrementMetric(state, 'events_failed_total');
  incrementMetric(state, 'fulfill_failure_total');
  incrementLabeledFailure(state, event.chain, kernelIntent.moduleId, kernelIntent.operation);
  recordProcessedEvent(
    state,
    event.chain,
    event,
    'failed',
    {
      attempts,
      route: result.route,
      module_id: result.module_id || kernelIntent.moduleId,
      operation: result.operation || kernelIntent.operation,
      fulfill_tx: result.fulfill_tx,
      worker_status: null,
      last_error: result.error,
    },
    config
  );
  clearRetryItem(state, event.chain, eventKey);
  persistState();

  await maybeUpsertJob(logger, event, {
    event_key: eventKey,
    status: 'failed',
    attempts,
    last_error: result.error,
    fulfill_tx: result.fulfill_tx,
    completed_at: new Date().toISOString(),
    next_retry_at: null,
  });

  logger.warn(
    {
      chain: event.chain,
      request_id: event.requestId,
      request_type: event.requestType,
      event_key: eventKey,
      attempts,
      error: result.error,
    },
    'Finalized oracle request with an on-chain failure callback'
  );
  return { event, result, event_key: eventKey, attempts };
}
