import {
  buildEventKey,
  collectActiveRequestIds,
  getDueRetryItems,
  hasProcessedEvent,
  incrementMetric,
  isEventQueuedForRetry,
} from './state.js';
import {
  createPersistor,
  deferEventsForBackpressure,
  hydrateDurableQueue,
  persistFreshEventsToDurableQueue,
  quarantineDurableBacklogBelowRequestFloor,
  syncManualActions,
} from './queue.js';
import { processEvent } from './fulfillment/index.js';
import {
  getRequestCursorFloor,
  resolveChainFromBlock,
  pruneRetryQueueBelowRequestFloor,
} from './chain-cursor.js';
import { mapWithConcurrency } from '@r3e-network/neo-os-services-shared/utils';

// Process due retry-queue items under the backpressure cap. Shared by every
// chain-processing branch so maxRetryEventsPerTick (and its skip metric) apply
// uniformly — including the quiet-chain early return, where the retry queue is
// otherwise the only work source.
async function runDueRetries(config, state, logger, chain, persistState) {
  const dueRetries = getDueRetryItems(state, chain);
  const retryBatch = dueRetries.slice(
    0,
    Math.max(Number(config.backpressure?.maxRetryEventsPerTick || dueRetries.length), 1)
  );
  if (dueRetries.length > retryBatch.length) {
    incrementMetric(
      state,
      'backpressure_retry_skipped_total',
      dueRetries.length - retryBatch.length
    );
  }
  return retryBatch.length
    ? mapWithConcurrency(retryBatch, config.concurrency, (item) =>
        processEvent(config, state, persistState, logger, item.event, item)
      )
    : [];
}

export function filterNewEvents(state, chain, events) {
  const unique = [];
  const seenKeys = new Set();
  let duplicates = 0;

  for (const event of events) {
    const eventKey = buildEventKey(event);
    if (
      seenKeys.has(eventKey) ||
      hasProcessedEvent(state, chain, eventKey) ||
      isEventQueuedForRetry(state, chain, eventKey)
    ) {
      duplicates += 1;
      continue;
    }
    seenKeys.add(eventKey);
    unique.push(event);
  }

  return { events: unique, duplicates };
}

export async function reconcilePendingRequests(
  config,
  state,
  logger,
  chain,
  options,
  excludedRequestIds = new Set()
) {
  if (!options.getLatestRequestId || !options.scanByRequestId) {
    return { scanned_requests: null, events: [] };
  }

  const latestRequestId = await options.getLatestRequestId(config);
  const fromRequestId = resolveRequestCursor(config, state, chain, latestRequestId, logger);
  if (fromRequestId > latestRequestId) {
    return { scanned_requests: null, events: [] };
  }

  const toRequestId = Math.min(latestRequestId, fromRequestId + config.maxBlocksPerTick - 1);
  const scannedEvents = await options.scanByRequestId(config, fromRequestId, toRequestId);
  // Exclude requests already being tracked anywhere — the same-tick block-scan
  // observations (excludedRequestIds) UNION every requestId currently queued for
  // retry or already processed (collectActiveRequestIds). The two cursor lanes
  // build different event keys for the same on-chain request, so the key-based
  // filterNewEvents below cannot catch a cross-lane / cross-tick duplicate by
  // itself; membership exclusion does. A genuinely-missed request (in neither
  // set) is NOT excluded and is still reconciled.
  const trackedRequestIds = collectActiveRequestIds(state, chain);
  const pendingOnly = scannedEvents.filter((event) => {
    const requestId = String(event.requestId || '');
    return !excludedRequestIds.has(requestId) && !trackedRequestIds.has(requestId);
  });
  incrementMetric(state, 'events_scanned_total', pendingOnly.length);
  const filtered = filterNewEvents(state, chain, pendingOnly);
  incrementMetric(state, 'duplicates_skipped_total', filtered.duplicates);

  const persistState = createPersistor(config, state);
  await persistFreshEventsToDurableQueue(config, logger, chain, filtered.events);
  const eventResults = filtered.events.length
    ? await mapWithConcurrency(filtered.events, config.concurrency, (event) =>
        processEvent(config, state, persistState, logger, event)
      )
    : [];

  state[chain].last_request_id = toRequestId;
  persistState();
  return {
    scanned_requests: { from: fromRequestId, to: toRequestId, latest_request_id: latestRequestId },
    events: eventResults,
  };
}

export async function processChain(config, state, logger, chain, options) {
  if (!options.hasConfig(config)) {
    logger.debug({ chain }, 'Skipping chain with incomplete relayer config');
    return {
      scanned_blocks: null,
      retries: [],
      events: [],
      request_reconciliation: { scanned_requests: null, events: [] },
    };
  }

  await syncManualActions(config, state, logger, chain);
  const persistState = createPersistor(config, state);
  await quarantineDurableBacklogBelowRequestFloor(config, logger, chain);
  await hydrateDurableQueue(config, state, logger, chain, persistState);
  const pruned = pruneRetryQueueBelowRequestFloor(
    state,
    chain,
    getRequestCursorFloor(config, chain)
  );
  if (pruned > 0) {
    persistState();
    logger.info(
      { chain, pruned_count: pruned },
      'Pruned legacy retry queue entries below request cursor floor'
    );
  }

  // Discovery (getLatestBlock + scan) is decoupled from due-retry draining: a
  // transient discovery-RPC failure must not starve already-prepared callback
  // redeliveries that need no fresh chain-tip read. On a discovery throw, log
  // and fall through to runDueRetries WITHOUT advancing last_block (the cursor
  // only advances on a successful scan below).
  //
  // Idle-discovery backoff (Round-2 R2-0.1): when a chain has had NO scanned
  // events AND no due retries for consecutive ticks, skip the getLatestBlock +
  // scan RPCs entirely until the backoff window elapses. This cuts steady-state
  // Neo-RPC load on idle deployments. The backoff is conservative:
  //   - DISABLED by default (config.discoveryIdleBackoffMs <= 0 means always scan).
  //   - Reset to zero the moment any events are scanned OR any retry is due.
  //   - runDueRetries ALWAYS runs regardless of backoff, so due callbacks are
  //     never delayed (the existing discovery-failure fallthrough guarantees this).
  const discoveryIdleBackoffMs = Math.max(Number(config.discoveryIdleBackoffMs || 0), 0);
  const dueRetriesBeforeDiscovery = getDueRetryItems(state, chain);
  let skipDiscoveryForIdle = false;
  if (discoveryIdleBackoffMs > 0 && dueRetriesBeforeDiscovery.length === 0) {
    const lastScanMs = Number(state[chain].last_discovery_at || 0);
    if (lastScanMs > 0 && Date.now() - lastScanMs < discoveryIdleBackoffMs) {
      skipDiscoveryForIdle = true;
      incrementMetric(state, 'discovery_idle_skips_total');
    }
  } else {
    state[chain].idle_discovery_skips = 0;
  }
  let scannedBlocks = null;
  let eventResults = [];
  const observedRequestIds = new Set();

  try {
    if (skipDiscoveryForIdle) {
      // Idle backoff active and nothing due: skip the discovery RPCs entirely.
      // runDueRetries below still runs (and dueRetriesBeforeDiscovery was empty), so
      // no callback is delayed. The cursor is NOT advanced — the next scan after the
      // backoff window picks up exactly where it left off.
      logger.debug({ chain }, 'Skipping idle-chain discovery RPC (backoff)');
    } else {
      state[chain].last_discovery_at = Date.now();
      const latestBlock = await options.getLatestBlock(config);
      const confirmedTip = latestBlock - Math.max(config.confirmations[chain], 0);

      if (confirmedTip >= 0) {
        const fromBlock = resolveChainFromBlock(config, state, chain, confirmedTip, logger);
        if (fromBlock <= confirmedTip) {
          const toBlock = Math.min(confirmedTip, fromBlock + config.maxBlocksPerTick - 1);
          const scannedEvents = await options.scan(config, fromBlock, toBlock);
          incrementMetric(state, 'events_scanned_total', scannedEvents.length);
          const filtered = filterNewEvents(state, chain, scannedEvents);
          incrementMetric(state, 'duplicates_skipped_total', filtered.duplicates);
          await persistFreshEventsToDurableQueue(config, logger, chain, filtered.events);
          const deferred = await deferEventsForBackpressure(
            config,
            state,
            logger,
            chain,
            filtered.events,
            persistState
          );
          eventResults = deferred.processable.length
            ? await mapWithConcurrency(deferred.processable, config.concurrency, (event) =>
                processEvent(config, state, persistState, logger, event)
              )
            : [];
          for (const event of deferred.processable) {
            observedRequestIds.add(String(event.requestId || ''));
          }
          state[chain].last_block = toBlock;
          persistState();
          scannedBlocks = {
            from: fromBlock,
            to: toBlock,
            latest: latestBlock,
            confirmed_tip: confirmedTip,
          };
        }
      }
    } // end else (non-idle discovery)
  } catch (error) {
    incrementMetric(state, 'discovery_failures_total');
    logger.warn(
      { chain, err: error?.message || String(error) },
      'Block-cursor discovery failed; draining due retries without advancing cursor'
    );
  }

  const retryResults = await runDueRetries(config, state, logger, chain, persistState);

  // Reconciliation also issues discovery-class RPC; isolate it so a failure
  // here cannot retroactively crash the tick after retries have already run.
  let requestReconciliation = null;
  try {
    requestReconciliation = await reconcilePendingRequests(
      config,
      state,
      logger,
      chain,
      options,
      observedRequestIds
    );
  } catch (error) {
    incrementMetric(state, 'reconciliation_failures_total');
    logger.warn(
      { chain, err: error?.message || String(error) },
      'Pending-request reconciliation failed; due retries already drained this tick'
    );
  }

  return {
    scanned_blocks: scannedBlocks,
    retries: retryResults,
    events: eventResults,
    request_reconciliation: requestReconciliation,
  };
}

export async function processChainByRequestCursor(config, state, logger, chain, options) {
  if (!options.hasConfig(config)) {
    logger.debug({ chain }, 'Skipping chain with incomplete relayer config');
    return { scanned_requests: null, retries: [], events: [] };
  }

  await syncManualActions(config, state, logger, chain);
  const persistState = createPersistor(config, state);
  await quarantineDurableBacklogBelowRequestFloor(config, logger, chain);
  await hydrateDurableQueue(config, state, logger, chain, persistState);
  const pruned = pruneRetryQueueBelowRequestFloor(
    state,
    chain,
    getRequestCursorFloor(config, chain)
  );
  if (pruned > 0) {
    persistState();
    logger.info(
      { chain, pruned_count: pruned },
      'Pruned legacy retry queue entries below request cursor floor'
    );
  }

  // Discovery (getLatestRequestId + scan) is decoupled from due-retry draining:
  // a transient discovery-RPC failure must not starve already-prepared callback
  // redeliveries that need no fresh chain-tip read. On a discovery throw, log
  // and fall through to runDueRetries WITHOUT advancing last_request_id (the
  // cursor only advances on a successful scan below).
  let scannedRequests = null;
  let eventResults = [];
  try {
    const latestRequestId = await options.getLatestRequestId(config);
    const fromRequestId = resolveRequestCursor(config, state, chain, latestRequestId, logger);
    if (fromRequestId > latestRequestId) {
      const retryResults = await runDueRetries(config, state, logger, chain, persistState);
      return { scanned_requests: null, retries: retryResults, events: [] };
    }

    const toRequestId = Math.min(latestRequestId, fromRequestId + config.maxBlocksPerTick - 1);
    const scannedEvents = await options.scan(config, fromRequestId, toRequestId);
    incrementMetric(state, 'events_scanned_total', scannedEvents.length);
    const filtered = filterNewEvents(state, chain, scannedEvents);
    incrementMetric(state, 'duplicates_skipped_total', filtered.duplicates);
    await persistFreshEventsToDurableQueue(config, logger, chain, filtered.events);
    const deferred = await deferEventsForBackpressure(
      config,
      state,
      logger,
      chain,
      filtered.events,
      persistState
    );
    eventResults = deferred.processable.length
      ? await mapWithConcurrency(deferred.processable, config.concurrency, (event) =>
          processEvent(config, state, persistState, logger, event)
        )
      : [];

    state[chain].last_request_id = toRequestId;
    persistState();
    scannedRequests = { from: fromRequestId, to: toRequestId, latest_request_id: latestRequestId };
  } catch (error) {
    incrementMetric(state, 'discovery_failures_total');
    logger.warn(
      { chain, err: error?.message || String(error) },
      'Request-cursor discovery failed; draining due retries without advancing cursor'
    );
  }

  const retryResults = await runDueRetries(config, state, logger, chain, persistState);

  return {
    scanned_requests: scannedRequests,
    retries: retryResults,
    events: eventResults,
  };
}

export function resolveRequestCursor(config, state, chain, latestRequestId, logger = null) {
  const configuredStart = optionsSafeNumber(config.startRequestIds?.[chain]);
  const defaultStart = Math.max(configuredStart ?? 1, 1);
  const lastRequestIdRaw = state[chain].last_request_id;
  const defaultTailStart =
    configuredStart === null || configuredStart === undefined
      ? Math.max(latestRequestId - Math.max(config.maxBlocksPerTick - 1, 0), 1)
      : defaultStart;

  if (lastRequestIdRaw === null || lastRequestIdRaw === undefined) {
    return defaultTailStart;
  }

  const lastRequestId = Number(lastRequestIdRaw);
  if (!Number.isFinite(lastRequestId) || lastRequestId < 0) {
    state[chain].last_request_id = null;
    logger?.warn?.(
      {
        chain,
        invalid_request_checkpoint: lastRequestIdRaw,
        reset_to_start_request_id: defaultTailStart,
      },
      'Resetting invalid relayer request checkpoint'
    );
    return defaultTailStart;
  }

  if (lastRequestId > latestRequestId) {
    state[chain].last_request_id = null;
    logger?.warn?.(
      {
        chain,
        request_checkpoint: lastRequestId,
        latest_request_id: latestRequestId,
        reset_to_start_request_id: defaultTailStart,
      },
      'Resetting relayer request checkpoint ahead of latest request id'
    );
    return defaultTailStart;
  }

  return lastRequestId + 1;
}

function optionsSafeNumber(value) {
  return value === null || value === undefined || value === '' ? null : Number(value);
}
