import {
  buildEventKey,
  clearRetryItem,
  enqueueRetryItem,
  incrementMetric,
  recordProcessedEvent,
  scheduleRetry,
} from '../state.js';
import { claimDurableJobForProcessing, maybeUpsertJob } from '../queue.js';
import { computeRetryDelayMs } from '../lib/retry.js';
import { normalizeErrorMessage } from '../feed-sync.js';
import { resolveKernelIntent } from '../router.js';
import {
  buildCallbackPendingWorkerResponse,
  buildPreparedFulfillmentRetryMeta,
  checkpointPreparedFulfillment,
  deliverPreparedFulfillment,
  finalizeFailedRequest,
  prepareOracleFulfillment,
} from './executor.js';
import {
  recordFinalizedFailure,
  recordTerminalOutcome,
  resolveCallbackRetryCeiling,
  resolveDeliveryRetryOrExhaust,
} from './dispatch.js';

export { resolveCallbackRetryCeiling };
import {
  classifyError,
  isAlreadyFulfilledError,
  isTerminalConfigurationError,
  trimOnchainErrorMessage,
} from './classifier.js';

/**
 * Top-level processEvent dispatcher. Coordinates durable claiming, fulfillment
 * preparation, delivery, retries, and terminal/dead-letter outcomes.
 */

/**
 * Main entry point for processing a single Morpheus oracle request event.
 *
 * @param {object} config Relayer configuration.
 * @param {object} state Relayer mutable state.
 * @param {Function} persistState Persist state callback.
 * @param {object} logger Logger.
 * @param {object} event On-chain request event.
 * @param {object|null} retryItem Optional retry item for redelivery.
 * @returns {Promise<object>} Processing outcome.
 */
export async function processEvent(config, state, persistState, logger, event, retryItem = null) {
  const eventKey = buildEventKey(event);
  const kernelIntent = resolveKernelIntent(event.requestType);
  const attempts = retryItem?.attempts || 0;
  const processingStartedAt = Date.now();
  const requestAgeMs =
    Number.isFinite(Number(event.createdAtMs || 0)) && Number(event.createdAtMs || 0) > 0
      ? Math.max(processingStartedAt - Number(event.createdAtMs || 0), 0)
      : null;
  const isFinalizeOnly = Boolean(retryItem?.finalize_only);
  let preparedForRedelivery =
    retryItem?.prepared_fulfillment && typeof retryItem.prepared_fulfillment === 'object'
      ? buildPreparedFulfillmentRetryMeta(retryItem.prepared_fulfillment)
      : null;
  const terminalError = trimOnchainErrorMessage(
    retryItem?.terminal_error || retryItem?.last_error || 'request execution failed'
  );

  logger.info(
    {
      chain: event.chain,
      request_id: event.requestId,
      request_type: event.requestType,
      module_id: kernelIntent.moduleId,
      operation: kernelIntent.operation,
      event_key: eventKey,
      attempts,
      tx_hash: event.txHash,
      request_age_ms: requestAgeMs,
    },
    'Processing Morpheus oracle request'
  );

  const claim = await claimDurableJobForProcessing(config, logger, event, retryItem, state);
  if (!claim.granted) {
    if (claim.reason === 'backoff_skip' || claim.reason === 'unavailable') {
      if (!retryItem) {
        enqueueRetryItem(state, event.chain, event, {
          attempts,
          next_retry_at: Date.now() + computeRetryDelayMs(config, attempts + 1),
          first_failed_at: new Date().toISOString(),
          last_error: `durable_claim_${claim.reason}`,
          retryQueueLimit: config.retryQueueLimit,
          deadLetterLimit: config.deadLetterLimit,
        });
        persistState();
      }
      return {
        event,
        skipped: true,
        event_key: eventKey,
        attempts,
        retry_status: claim.reason,
      };
    }
    incrementMetric(state, 'claim_conflicts_total');
    clearRetryItem(state, event.chain, eventKey);
    persistState();
    return {
      event,
      skipped: true,
      event_key: eventKey,
      attempts,
      retry_status: 'claimed_elsewhere',
    };
  }

  await maybeUpsertJob(logger, event, {
    event_key: eventKey,
    status: retryItem ? 'retrying' : 'processing',
    attempts,
    next_retry_at: null,
  });

  try {
    let result;
    if (isFinalizeOnly) {
      result = await finalizeFailedRequest(config, event, terminalError);
      incrementMetric(state, 'fulfill_failure_total');
    } else if (preparedForRedelivery) {
      result = await deliverPreparedFulfillment(config, event, preparedForRedelivery);
      incrementMetric(state, result.success ? 'fulfill_success_total' : 'fulfill_failure_total');
    } else {
      incrementMetric(state, 'worker_calls_total');
      preparedForRedelivery = await prepareOracleFulfillment(config, event, logger);
      if (!preparedForRedelivery.success) incrementMetric(state, 'worker_failures_total');
      enqueueRetryItem(state, event.chain, event, {
        attempts,
        next_retry_at: Date.now() + computeRetryDelayMs(config, attempts + 1),
        first_failed_at: retryItem?.first_failed_at || new Date().toISOString(),
        last_error: 'callback_pending',
        prepared_fulfillment: buildPreparedFulfillmentRetryMeta(preparedForRedelivery),
        durable_claimed: retryItem?.durable_claimed,
        retryQueueLimit: config.retryQueueLimit,
        deadLetterLimit: config.deadLetterLimit,
      });
      persistState();
      await checkpointPreparedFulfillment(
        config,
        logger,
        event,
        preparedForRedelivery,
        attempts,
        kernelIntent
      );
      result = await deliverPreparedFulfillment(config, event, preparedForRedelivery);
      incrementMetric(state, result.success ? 'fulfill_success_total' : 'fulfill_failure_total');
    }
    incrementMetric(state, 'events_processed_total');
    state.metrics.last_fulfill_latency_ms = Date.now() - processingStartedAt;

    recordProcessedEvent(
      state,
      event.chain,
      event,
      result.success ? 'fulfilled' : 'failed',
      {
        attempts,
        route: result.route,
        module_id: result.module_id || kernelIntent.moduleId,
        operation: result.operation || kernelIntent.operation,
        fulfill_tx: result.fulfill_tx,
        worker_status: result.worker_status,
        last_error: result.error || null,
        request_age_ms: requestAgeMs,
        total_duration_ms: Date.now() - processingStartedAt,
        durations_ms: result.durations_ms || null,
      },
      config
    );
    clearRetryItem(state, event.chain, eventKey);
    persistState();

    await maybeUpsertJob(logger, event, {
      event_key: eventKey,
      status: result.success ? 'fulfilled' : 'failed',
      attempts,
      route: result.route,
      worker_status: result.worker_status,
      worker_response:
        result.worker_response && typeof result.worker_response === 'object'
          ? {
              ...result.worker_response,
              kernel_intent: {
                module_id: result.module_id || kernelIntent.moduleId,
                operation: result.operation || kernelIntent.operation,
                legacy_request_type: kernelIntent.legacyRequestType,
              },
            }
          : result.worker_response,
      fulfill_tx: result.fulfill_tx,
      completed_at: new Date().toISOString(),
      next_retry_at: null,
    });

    logger.info(
      {
        chain: event.chain,
        request_id: event.requestId,
        request_type: event.requestType,
        module_id: result.module_id || kernelIntent.moduleId,
        operation: result.operation || kernelIntent.operation,
        event_key: eventKey,
        success: result.success,
        route: result.route,
        worker_status: result.worker_status,
        request_age_ms: requestAgeMs,
        total_duration_ms: Date.now() - processingStartedAt,
        durations_ms: result.durations_ms || null,
      },
      'Fulfilled Morpheus oracle request'
    );
    return { event, result, event_key: eventKey, attempts };
  } catch (error) {
    const message = normalizeErrorMessage(error);
    if (isAlreadyFulfilledError(message)) {
      return recordTerminalOutcome(config, state, persistState, logger, event, kernelIntent, {
        attempts,
        localStatus: 'settled',
        durableStatus: 'settled',
        route: isFinalizeOnly ? 'failure-finalize:already-fulfilled' : 'already-fulfilled',
        lastError: trimOnchainErrorMessage(message),
        logLevel: 'info',
        logMessage: 'Oracle request was already settled on-chain',
        retryStatus: 'settled',
      });
    }

    if (isTerminalConfigurationError(message)) {
      return recordTerminalOutcome(config, state, persistState, logger, event, kernelIntent, {
        attempts,
        localStatus: 'exhausted',
        durableStatus: 'failed_config',
        route: isFinalizeOnly ? 'failure-finalize:config-error' : 'config-error',
        lastError: trimOnchainErrorMessage(message),
        metric: 'retries_exhausted_total',
        logLevel: 'error',
        logMessage:
          'Relayer stopped retrying due to a terminal configuration or authorization error',
        retryStatus: 'terminal',
      });
    }

    if (preparedForRedelivery) {
      return resolveDeliveryRetryOrExhaust(
        config,
        state,
        persistState,
        logger,
        event,
        kernelIntent,
        {
          nextAttempts: attempts + 1,
          errorMessage: message,
          exhaustRoute: preparedForRedelivery.route || 'callback-delivery',
          retryOptions: {
            firstFailedAt: retryItem?.first_failed_at || new Date().toISOString(),
            extraRetryItemFields: {
              prepared_fulfillment: buildPreparedFulfillmentRetryMeta(preparedForRedelivery),
            },
            upsertStatus: 'callback_retry_scheduled',
            upsertExtras: {
              route: preparedForRedelivery.route,
              worker_status: preparedForRedelivery.worker_status,
            },
            upsertWorkerResponse: buildCallbackPendingWorkerResponse(
              preparedForRedelivery,
              kernelIntent
            ),
            retryStatus: 'callback_retry_scheduled',
            logLevel: 'warn',
            logMessage: 'Retrying prepared Morpheus oracle callback delivery',
            logModuleId: preparedForRedelivery.module_id || kernelIntent.moduleId,
            logOperation: preparedForRedelivery.operation || kernelIntent.operation,
          },
        }
      );
    }

    if (isFinalizeOnly) {
      return resolveDeliveryRetryOrExhaust(
        config,
        state,
        persistState,
        logger,
        event,
        kernelIntent,
        {
          nextAttempts: attempts + 1,
          errorMessage: message,
          exhaustRoute: 'failure-finalize',
          exhaustTerminalError: terminalError,
          retryOptions: {
            firstFailedAt: retryItem?.first_failed_at || new Date().toISOString(),
            extraRetryItemFields: { finalize_only: true, terminal_error: terminalError },
            upsertStatus: 'failure_callback_retry_scheduled',
            upsertWorkerResponse: {
              retry_meta: {
                finalize_only: true,
                terminal_error: terminalError,
                module_id: kernelIntent.moduleId,
                operation: kernelIntent.operation,
              },
            },
            retryStatus: 'scheduled',
            logLevel: 'warn',
            logMessage: 'Retrying terminal failure callback delivery',
          },
        }
      );
    }

    const errorClass = classifyError(message);
    const forceDead = errorClass.level === 'permanent';
    const retry = forceDead
      ? { status: 'exhausted', key: eventKey, attempts: attempts + 1, error: message }
      : scheduleRetry(state, event.chain, event, message, config);

    if (retry.status === 'exhausted') {
      incrementMetric(state, 'retries_exhausted_total');
      try {
        const result = await finalizeFailedRequest(config, event, message);
        return recordFinalizedFailure(
          config,
          state,
          persistState,
          logger,
          event,
          kernelIntent,
          eventKey,
          retry.attempts,
          result
        );
      } catch (finalizeError) {
        const finalizeTerminalError = trimOnchainErrorMessage(message);
        return resolveDeliveryRetryOrExhaust(
          config,
          state,
          persistState,
          logger,
          event,
          kernelIntent,
          {
            nextAttempts: retry.attempts + 1,
            errorMessage: finalizeError,
            exhaustRoute: 'failure-finalize',
            exhaustTerminalError: finalizeTerminalError,
            retryOptions: {
              firstFailedAt: new Date().toISOString(),
              extraRetryItemFields: {
                finalize_only: true,
                terminal_error: finalizeTerminalError,
              },
              upsertStatus: 'failure_callback_retry_scheduled',
              upsertWorkerResponse: {
                retry_meta: {
                  finalize_only: true,
                  terminal_error: finalizeTerminalError,
                  module_id: kernelIntent.moduleId,
                  operation: kernelIntent.operation,
                },
              },
              retryStatus: 'scheduled',
              logLevel: 'error',
              logMessage: 'Primary execution exhausted; retrying terminal failure callback',
            },
          }
        );
      }
    }

    incrementMetric(state, 'retries_scheduled_total');
    persistState();

    await maybeUpsertJob(logger, event, {
      event_key: eventKey,
      status: 'retry_scheduled',
      attempts: retry.item.attempts,
      last_error: message,
      next_retry_at: new Date(retry.item.next_retry_at).toISOString(),
    });

    logger.warn(
      {
        chain: event.chain,
        request_id: event.requestId,
        request_type: event.requestType,
        module_id: kernelIntent.moduleId,
        operation: kernelIntent.operation,
        event_key: eventKey,
        attempts: retry.item.attempts,
        retry_at: retry.item.next_retry_at,
        error_class: errorClass.level,
        error: message,
      },
      'Scheduled Morpheus oracle request retry'
    );
    return {
      event,
      error: message,
      error_class: errorClass.level,
      retry_status: 'scheduled',
      event_key: eventKey,
      attempts: retry.item.attempts,
    };
  }
}
