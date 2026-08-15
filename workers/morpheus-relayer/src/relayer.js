import { parseTimestampMs } from '@r3e-network/neo-os-services-shared/utils';
import { createRelayerConfig } from './config.js';
import { sendHeartbeat } from './heartbeat.js';
import { createLogger } from './logger.js';
import { processAutomationJobs } from './automation.js';
import {
  markSupabasePersistenceUnavailable,
  persistRelayerRun,
  shouldSkipSupabasePersistence,
} from './persistence.js';
import { loadRelayerState, saveRelayerState, snapshotMetrics, incrementMetric } from './state.js';
import {
  hasNeoN3RelayerConfig,
  getNeoN3IndexedBlock,
  getNeoN3LatestBlock,
  getNeoN3LatestRequestId,
  scanNeoN3OracleRequests,
  scanNeoN3OracleRequestsById,
  scanNeoN3OracleRequestsViaN3Index,
} from './neo-n3.js';
import {
  hasNeoXRelayerConfig,
  getNeoXLatestRequestId,
  scanNeoXOracleRequestsById,
} from './neox.js';
import { getFeedSyncDelayMs, processFeedSync } from './feed-sync.js';
export { buildFeedSyncPayload } from './feed-sync.js';
export { getFeedSyncDelayMs } from './feed-sync.js';
export { summarizeFeedSyncChainResult } from './feed-sync.js';
export {
  getRequestCursorFloor,
  pruneRetryQueueBelowRequestFloor,
  resolveChainFromBlock,
} from './chain-cursor.js';

// Inline helpers from chain-cursor.js - these are simple checks that don't justify a separate module
export function shouldRunFeedSync(config) {
  return config.mode !== 'requests_only';
}

export function shouldRunRequestProcessing(config) {
  return config.mode !== 'feed_only';
}
export {
  hydrateDurableQueue,
  persistFreshEventsToDurableQueue,
  quarantineDurableBacklogBelowRequestFloor,
} from './queue.js';
import { processChain, processChainByRequestCursor } from './request-processor.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chainResultHasActivity(chainResult) {
  const chain = chainResult || {};
  if (Array.isArray(chain.events) && chain.events.length > 0) return true;
  if (Array.isArray(chain.retries) && chain.retries.length > 0) return true;
  if (
    Array.isArray(chain.request_reconciliation?.events) &&
    chain.request_reconciliation.events.length > 0
  ) {
    return true;
  }
  return false;
}

function resultHasPersistableActivity(config, result) {
  if (result.feed_sync?.skipped === false) return true;

  if (chainResultHasActivity(result.neo_n3)) return true;
  if (chainResultHasActivity(result.neox)) return true;

  const automation = result.automation || {};
  return (
    Number(automation.queued || 0) > 0 ||
    Number(automation.failed || 0) > 0 ||
    Number(automation.inspected || 0) > 0
  );
}

export function shouldPersistRunSnapshot(config, result, nowMs = Date.now()) {
  if (config.runSnapshots?.enabled === false) {
    return { persist: false, reason: 'disabled' };
  }

  const metrics = result?.state?.metrics || {};
  const lastErrorMs = parseTimestampMs(metrics.last_run_snapshot_error_at);
  const errorBackoffMs = Math.max(Number(config.runSnapshots?.errorBackoffMs || 0), 0);
  if (lastErrorMs > 0 && errorBackoffMs > 0 && nowMs - lastErrorMs < errorBackoffMs) {
    return { persist: false, reason: 'error_backoff' };
  }

  const intervalMs = Math.max(Number(config.runSnapshots?.intervalMs || 0), 0);
  const lastPersistedMs = parseTimestampMs(metrics.last_run_snapshot_persisted_at);
  const hasActivity = resultHasPersistableActivity(config, result);
  if (!hasActivity && config.mode === 'feed_only') {
    return { persist: false, reason: 'feed_sync_skipped' };
  }
  if (
    !hasActivity &&
    lastPersistedMs > 0 &&
    intervalMs > 0 &&
    nowMs - lastPersistedMs < intervalMs
  ) {
    return { persist: false, reason: 'interval' };
  }

  return { persist: true, reason: hasActivity ? 'activity' : 'interval_elapsed' };
}

async function maybePersistRun(logger, config, result) {
  if (shouldSkipSupabasePersistence()) {
    return { persisted: false, reason: 'supabase_backoff' };
  }
  const nowMs = Date.now();
  const decision = shouldPersistRunSnapshot(config, result, nowMs);
  if (!decision.persist) return decision;

  try {
    await persistRelayerRun(config, result);
    result.state.metrics.last_run_snapshot_persisted_at = new Date(nowMs).toISOString();
    result.state.metrics.last_run_snapshot_error_at = null;
    saveRelayerState(config.stateFile, result.state);
    return { persisted: true, reason: decision.reason };
  } catch (error) {
    markSupabasePersistenceUnavailable(error);
    result.state.metrics.last_run_snapshot_error_at = new Date().toISOString();
    saveRelayerState(config.stateFile, result.state);
    logger.warn({ error }, 'Failed to persist relayer run snapshot to Supabase');
    return { persisted: false, reason: 'error', error };
  }
}

export async function runRelayerOnce(options = {}) {
  const config = options.config || createRelayerConfig();
  const logger = options.logger || createLogger(config);
  const state = loadRelayerState(config.stateFile, logger);
  const startedAt = Date.now();
  state.metrics.last_tick_started_at = new Date(startedAt).toISOString();
  incrementMetric(state, 'ticks_total', 1);
  // NOTE: the prior tick-start saveRelayerState is intentionally omitted. It only updated
  // last_tick_started_at + ticks_total — both of which Prometheus reads from IN-MEMORY
  // state.metrics (not disk), and which the Supabase run snapshot reads from in-memory state
  // when maybePersistRun fires (it has its own interval/activity gate). The load-bearing
  // persisted state (processed_records, retry_queue) only changes DURING a tick, so it is
  // captured by the tick-end write below. Skipping this write removes one full-state
  // serialize + atomic rename per tick even when the box is completely idle.
  // (Round-2 R2-0.3.)

  const feedSync = shouldRunFeedSync(config)
    ? await processFeedSync(config, state, logger)
    : { enabled: false, skipped: true, mode: config.mode };

  const neoN3 =
    shouldRunRequestProcessing(config) && config.activeChains.includes('neo_n3')
      ? config.neo_n3.scanMode === 'request_cursor'
        ? await processChainByRequestCursor(config, state, logger, 'neo_n3', {
            hasConfig: hasNeoN3RelayerConfig,
            getLatestRequestId: getNeoN3LatestRequestId,
            scan: scanNeoN3OracleRequestsById,
          })
        : await processChain(config, state, logger, 'neo_n3', {
            hasConfig: hasNeoN3RelayerConfig,
            getLatestBlock:
              config.neo_n3.scanMode === 'n3index_notifications'
                ? getNeoN3IndexedBlock
                : getNeoN3LatestBlock,
            getLatestRequestId: getNeoN3LatestRequestId,
            scan:
              config.neo_n3.scanMode === 'n3index_notifications'
                ? scanNeoN3OracleRequestsViaN3Index
                : scanNeoN3OracleRequests,
            scanByRequestId: scanNeoN3OracleRequestsById,
          })
      : { skipped: true, chain: 'neo_n3' };
  // Neo X (EVM): request-cursor discovery + shared fulfillment pipeline. Gated by
  // activeChains AND adapter hasConfig, so default Neo-N3-only deploys are unchanged.
  const neox =
    shouldRunRequestProcessing(config) && config.activeChains.includes('neox')
      ? await processChainByRequestCursor(config, state, logger, 'neox', {
          hasConfig: hasNeoXRelayerConfig,
          getLatestRequestId: getNeoXLatestRequestId,
          scan: scanNeoXOracleRequestsById,
        })
      : { skipped: true, chain: 'neox' };
  const automation = shouldRunRequestProcessing(config)
    ? await processAutomationJobs(config, logger)
    : { skipped: true, mode: config.mode };

  state.metrics.last_tick_completed_at = new Date().toISOString();
  state.metrics.last_tick_duration_ms = Date.now() - startedAt;
  // Persist the tick-end state, but skip the full-state serialize + atomic rename when this
  // tick was completely idle AND the on-disk snapshot is still fresh. The load-bearing state
  // (processed_records, retry_queue) only mutates during an active tick; an idle tick changes
  // only last_tick_* metrics (which Prometheus reads from memory, not disk). Skipping here
  // removes the dominant per-tick disk I/O on idle deployments. (Round-2 R2-0.3.)
  const tickHadActivity =
    !feedSync?.skipped ||
    chainResultHasActivity(neoN3) ||
    chainResultHasActivity(neox) ||
    Number(automation?.queued || 0) > 0 ||
    Number(automation?.failed || 0) > 0 ||
    Number(automation?.inspected || 0) > 0;
  const statePersistMinIntervalMs = Math.max(Number(config.statePersistMinIntervalMs || 0), 0);
  const lastPersistedMs = parseTimestampMs(state.updated_at);
  const idleAndFresh =
    !tickHadActivity &&
    statePersistMinIntervalMs > 0 &&
    lastPersistedMs > 0 &&
    Date.now() - lastPersistedMs < statePersistMinIntervalMs;
  if (!idleAndFresh) {
    saveRelayerState(config.stateFile, state);
  }

  const result = {
    instance_id: config.instanceId,
    mode: config.mode,
    neo_n3: neoN3,
    neox,
    feed_sync: feedSync,
    automation,
    state,
    metrics: snapshotMetrics(state),
  };
  await maybePersistRun(logger, config, result);
  if (config.mode === 'feed_only') {
    void sendHeartbeat(config.heartbeats?.feedRelayer || '', {
      mode: config.mode,
      network: config.network,
      tick_duration_ms: result.metrics.last_tick_duration_ms,
    });
  } else {
    void sendHeartbeat(config.heartbeats?.relayer || '', {
      mode: config.mode,
      network: config.network,
      tick_duration_ms: result.metrics.last_tick_duration_ms,
    });
  }
  return result;
}

export async function runRelayerLoop(options = {}) {
  const config = options.config || createRelayerConfig();
  const logger = options.logger || createLogger(config);
  logger.info(
    {
      network: config.network,
      mode: config.mode,
      instance_id: config.instanceId,
      state_file: config.stateFile,
      poll_interval_ms: config.pollIntervalMs,
      concurrency: config.concurrency,
    },
    'Starting Morpheus relayer loop'
  );
  while (true) {
    try {
      const result = await runRelayerOnce({ config, logger });
      logger.info(
        {
          metrics: result.metrics,
          feed_sync:
            Array.isArray(result.feed_sync?.chains) && result.feed_sync.chains.length > 0
              ? result.feed_sync.chains.map((entry) => entry.publication_summary || null)
              : undefined,
        },
        'Relayer loop tick complete'
      );
      const feedSyncDelayMs = getFeedSyncDelayMs(config, result.state, Date.now());
      const sleepMs =
        config.mode === 'feed_only'
          ? Math.max(
              0,
              Math.min(
                Math.max(config.pollIntervalMs, 0),
                Number.isFinite(feedSyncDelayMs) ? feedSyncDelayMs : Number.POSITIVE_INFINITY
              )
            )
          : Math.max(config.pollIntervalMs, 0);
      await sleep(sleepMs);
    } catch (error) {
      logger.error({ error }, 'Relayer loop tick failed');
      void sendHeartbeat(config.heartbeats?.failure || '', {
        mode: config.mode,
        network: config.network,
        error: error instanceof Error ? error.message : String(error),
      });
      await sleep(config.pollIntervalMs);
    }
  }
}
