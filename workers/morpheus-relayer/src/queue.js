import { env, verifyManualActionSignature } from '@r3e-network/neo-os-services-shared/node-runtime';
import {
  buildEventKey,
  clearRetryItem,
  enqueueRetryItem,
  hasProcessedEvent,
  isEventQueuedForRetry,
  incrementMetric,
  removeDeadLetter,
  removeProcessedEvent,
  saveRelayerState,
} from './state.js';
import {
  buildRelayerJobRecord,
  claimRelayerJob,
  fetchRelayerJobsByStatuses,
  hasSupabasePersistence,
  insertRelayerJobIfAbsent,
  markSupabasePersistenceUnavailable,
  patchRelayerJob,
  quarantineRelayerJobsBelowRequestId,
  shouldSkipSupabasePersistence,
  upsertRelayerJob,
} from './persistence.js';
import { getRequestCursorFloor } from './chain-cursor.js';
import { mapWithConcurrency, parseTimestampMs } from '@r3e-network/neo-os-services-shared/utils';

export function createPersistor(config, state) {
  const minIntervalMs = Math.max(Number(config.statePersistMinIntervalMs || 0), 0);
  if (minIntervalMs <= 0) {
    return () => saveRelayerState(config.stateFile, state);
  }
  let lastWriteAtMs = 0;
  let timer = null;
  let dirty = false;
  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    dirty = false;
    lastWriteAtMs = Date.now();
    saveRelayerState(config.stateFile, state);
  };
  const persist = () => {
    const elapsedMs = Date.now() - lastWriteAtMs;
    if (elapsedMs >= minIntervalMs) {
      flush();
      return;
    }
    // Coalesce bursts: processEvent persists at several sync points per event;
    // mark dirty and schedule a single trailing write so the full state JSON is
    // not re-serialized for every call. The trailing timer keeps the on-disk
    // snapshot within minIntervalMs of the in-memory state.
    dirty = true;
    if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        if (dirty) flush();
      }, minIntervalMs - elapsedMs);
      timer.unref?.();
    }
  };
  persist.flush = flush;
  return persist;
}

export async function maybeUpsertJob(logger, event, details) {
  if (shouldSkipSupabasePersistence()) return;
  try {
    await upsertRelayerJob(buildRelayerJobRecord(event, details));
  } catch (error) {
    logger.warn(
      { event_key: details.event_key, error },
      'Failed to persist relayer job state to Supabase'
    );
  }
}

export async function upsertJobOrThrow(event, details) {
  if (shouldSkipSupabasePersistence()) {
    throw new Error('supabase persistence unavailable during quota backoff');
  }
  return upsertRelayerJob(buildRelayerJobRecord(event, details));
}

/**
 * SECURITY (S4): resolve the shared HMAC secret that authenticates every
 * persisted relayer event (manual retry/replay actions and relayer-written
 * durable rows). Empty when not configured; consumers fail closed.
 */
function resolveEventHmacSecret() {
  return env('MORPHEUS_MANUAL_ACTION_HMAC_SECRET');
}

/**
 * SECURITY (S4): structural well-formedness check applied to DB-originated
 * events before they are queued for signing+broadcast. Returns an error message
 * string or null. This mirrors the minimum shape an on-chain scan produces, so
 * an injected row cannot skip the fields the rest of the pipeline relies on.
 */
function assertDbEventWellFormed(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    return 'event is not an object';
  }
  for (const field of [
    'chain',
    'requestId',
    'requestType',
    'payloadText',
    'requester',
    'callbackContract',
    'callbackMethod',
  ]) {
    if (typeof event[field] !== 'string' || !event[field].trim()) {
      return `event.${field} is missing or empty`;
    }
  }
  if (/\s/.test(String(event.requestType))) {
    return 'event.requestType contains whitespace';
  }
  return null;
}

/**
 * SECURITY (S4): verify the HMAC authenticating a DB-originated event before it
 * is queued for signing+broadcast. `action` is the status that requested the
 * queueing ('manual_retry_requested' / 'manual_replay_requested' /
 * 'relayer_upsert'). Returns null on success or an error message on failure.
 */
function verifyDbEventSignature(job, event, eventKey, network, action) {
  const secret = resolveEventHmacSecret();
  if (!secret) {
    return 'MORPHEUS_MANUAL_ACTION_HMAC_SECRET is not configured; DB-sourced events are disabled';
  }
  const signature = job?.worker_response?.manual_action_sig || '';
  if (!verifyManualActionSignature(secret, action, network, eventKey, event, signature)) {
    return 'event signature verification failed (tampered or unsigned DB event)';
  }
  return null;
}

export async function deferEventsForBackpressure(
  config,
  state,
  logger,
  chain,
  events,
  persistState
) {
  const maxFreshEventsPerTick = Math.max(
    Number(config.backpressure?.maxFreshEventsPerTick || events.length),
    1
  );
  if (events.length <= maxFreshEventsPerTick) {
    return { processable: events, deferred: [] };
  }

  const processable = events.slice(0, maxFreshEventsPerTick);
  const deferred = events.slice(maxFreshEventsPerTick);
  const nextRetryAt = Date.now() + Math.max(Number(config.backpressure?.deferDelayMs || 5000), 250);
  const nextRetryIso = new Date(nextRetryAt).toISOString();

  for (const event of deferred) {
    enqueueRetryItem(state, chain, event, {
      attempts: 0,
      next_retry_at: nextRetryAt,
      last_error: 'backpressure_deferred',
      retryQueueLimit: config.retryQueueLimit,
      deadLetterLimit: config.deadLetterLimit,
    });
    await maybeUpsertJob(logger, event, {
      event_key: buildEventKey(event),
      status: 'queued_backpressure',
      attempts: 0,
      last_error: 'backpressure_deferred',
      next_retry_at: nextRetryIso,
    });
  }

  incrementMetric(state, 'backpressure_deferred_total', deferred.length);
  persistState();
  logger.warn(
    {
      chain,
      deferred_count: deferred.length,
      processable_count: processable.length,
      next_retry_at: nextRetryIso,
    },
    'Deferred fresh oracle requests into the retry queue due to backpressure'
  );
  return { processable, deferred };
}

export async function syncManualActions(config, state, logger, chain) {
  if (shouldSkipSupabasePersistence()) return [];
  let jobs;
  try {
    jobs = await fetchRelayerJobsByStatuses(
      ['manual_retry_requested', 'manual_replay_requested'],
      chain,
      50
    );
  } catch (error) {
    markSupabasePersistenceUnavailable(error);
    logger.warn(
      { chain, error },
      'Supabase manual-action sync unavailable; continuing without control-plane sync'
    );
    return [];
  }
  if (!jobs.length) return [];

  const applied = [];
  for (const job of jobs) {
    const event = job?.event && typeof job.event === 'object' ? job.event : null;
    if (!event || !event.chain || !event.requestId) {
      await patchRelayerJob(job.event_key, {
        status: 'manual_action_failed',
        last_error: 'missing or invalid event payload for manual action',
        next_retry_at: null,
      });
      continue;
    }

    const eventKey = job.event_key || buildEventKey(event);

    // SECURITY (S4): a DB write alone must not be able to request a replay or
    // retry (which triggers signing + broadcast at operator GAS cost). Validate
    // the event shape and require an HMAC signed over the exact event.
    const malformed = assertDbEventWellFormed(event);
    if (malformed) {
      await patchRelayerJob(eventKey, {
        status: 'manual_action_failed',
        last_error: `manual action rejected: ${malformed}`,
        next_retry_at: null,
      });
      continue;
    }
    const signatureError = verifyDbEventSignature(job, event, eventKey, config.network, job.status);
    if (signatureError) {
      await patchRelayerJob(eventKey, {
        status: 'manual_action_failed',
        last_error: `manual action rejected: ${signatureError}`,
        next_retry_at: null,
      });
      continue;
    }

    if (job.status === 'manual_replay_requested') {
      removeProcessedEvent(state, chain, eventKey);
    }
    removeDeadLetter(state, chain, eventKey);
    clearRetryItem(state, chain, eventKey);
    enqueueRetryItem(state, chain, event, {
      attempts: 0,
      next_retry_at: Date.now(),
      last_error: null,
      manual_action: job.status,
    });
    incrementMetric(state, 'manual_actions_loaded_total');

    await patchRelayerJob(eventKey, {
      status: 'queued',
      attempts: 0,
      last_error: null,
      next_retry_at: new Date().toISOString(),
      completed_at: null,
    });
    applied.push({ event_key: eventKey, status: job.status });
  }

  if (applied.length) {
    saveRelayerState(config.stateFile, state);
    logger.info({ chain, actions: applied }, 'Loaded manual relayer actions from Supabase');
  }
  return applied;
}

export function extractDurableRetryMeta(job) {
  const retryMeta =
    job?.worker_response &&
    typeof job.worker_response === 'object' &&
    job.worker_response.retry_meta &&
    typeof job.worker_response.retry_meta === 'object'
      ? job.worker_response.retry_meta
      : {};
  return {
    finalize_only: Boolean(retryMeta.finalize_only),
    terminal_error:
      typeof retryMeta.terminal_error === 'string' && retryMeta.terminal_error.trim()
        ? retryMeta.terminal_error.trim()
        : null,
    durable_claimed: Boolean(retryMeta.durable_claimed),
    prepared_fulfillment:
      retryMeta.prepared_fulfillment && typeof retryMeta.prepared_fulfillment === 'object'
        ? retryMeta.prepared_fulfillment
        : null,
  };
}

export function isDurableQueueReadyJob(job, nowMs, staleProcessingMs) {
  const status = String(job?.status || '');
  if (status === 'queued' || status === 'queued_backpressure') return true;
  if (
    status === 'retry_scheduled' ||
    status === 'failure_callback_retry_scheduled' ||
    status === 'callback_retry_scheduled'
  ) {
    const nextRetryAtMs = parseTimestampMs(job?.next_retry_at);
    return nextRetryAtMs === 0 || nextRetryAtMs <= nowMs;
  }
  if (status === 'processing' || status === 'retrying' || status === 'callback_pending') {
    const updatedAtMs = parseTimestampMs(job?.updated_at);
    return updatedAtMs > 0 && nowMs - updatedAtMs >= staleProcessingMs;
  }
  return false;
}

export function ensureDurableQueueAvailable(config, logger, context = 'relayer') {
  if (!config.durableQueue?.enabled) return false;
  const available = hasSupabasePersistence();
  if (available) return true;
  const message = `durable queue enabled but Supabase persistence unavailable during ${context}`;
  if (config.durableQueue?.failClosed) {
    throw new Error(message);
  }
  logger.warn({ context }, message);
  return false;
}

export function isTransientDurableQueueError(error) {
  if (markSupabasePersistenceUnavailable(error)) return true;
  const normalized = String(error?.message || error || '').toLowerCase();
  return (
    normalized.includes('exceed_db_size_quota') ||
    normalized.includes('database size quota') ||
    normalized.includes('quota exceeded') ||
    normalized.includes('402 payment required') ||
    normalized.includes('failed: 402') ||
    normalized.includes('pgrst002') ||
    normalized.includes('schema cache') ||
    normalized.includes('503') ||
    normalized.includes('502') ||
    normalized.includes('504') ||
    normalized.includes('timed out') ||
    normalized.includes('timeout') ||
    normalized.includes('econnreset') ||
    normalized.includes('econnrefused') ||
    normalized.includes('eauthquery') ||
    normalized.includes('connection to database not available') ||
    normalized.includes('network') ||
    normalized.includes('unavailable')
  );
}

export async function persistFreshEventsToDurableQueue(config, logger, chain, events) {
  if (!events.length) return;
  if (shouldSkipSupabasePersistence()) {
    return;
  }
  if (!ensureDurableQueueAvailable(config, logger, `${chain}:fresh-event-persist`)) return;

  const nextRetryAtIso = new Date().toISOString();
  try {
    await mapWithConcurrency(events, Math.min(config.concurrency, events.length), async (event) => {
      await insertRelayerJobIfAbsent(
        buildRelayerJobRecord(event, {
          event_key: buildEventKey(event),
          status: 'queued',
          attempts: 0,
          next_retry_at: nextRetryAtIso,
        })
      );
    });
  } catch (error) {
    if (!isTransientDurableQueueError(error)) throw error;
    if (config.durableQueue?.failClosed) {
      logger.warn(
        { chain, event_count: events.length, error },
        'Durable Supabase queue is unavailable; refusing to process fresh events until it recovers'
      );
      throw error;
    }
    logger.warn(
      { chain, event_count: events.length, error },
      'Durable Supabase queue is temporarily unavailable; continuing with local relayer state'
    );
  }
}

// Claim outcomes. `granted` => safe to process; `conflict` => another instance
// already claimed it (clear the local item, count a conflict); `backoff_skip` =>
// the cross-instance claim is offline during a Supabase backoff and the
// multi-instance opt-out declined a local claim — the item MUST be retained and
// retried next tick, NOT cleared or counted as a conflict; `unavailable` =>
// durable queue enabled but Supabase persistence is down and failClosed is off.
export const CLAIM_GRANTED = Object.freeze({ granted: true, reason: 'granted' });

export async function claimDurableJobForProcessing(
  config,
  logger,
  event,
  retryItem = null,
  state = null
) {
  if (!config.durableQueue?.enabled) return CLAIM_GRANTED;
  if (retryItem?.durable_claimed) return CLAIM_GRANTED;
  if (shouldSkipSupabasePersistence()) {
    // Supabase is in quota/outage backoff: the cross-instance claim is offline.
    // Surface that idempotency protection is temporarily off so an operator can
    // see it, and honor the multi-instance opt-out instead of silently granting.
    if (state) incrementMetric(state, 'durable_claim_skipped_during_backoff_total');
    // Fail closed by default: when the shared idempotency store is unreachable we
    // do NOT locally claim/deliver, because two instances could both grant a local
    // claim and double-broadcast the same fulfillment. Local claiming is only
    // honored when explicitly opted in (allowLocalClaimDuringBackoff === true),
    // which single-instance / local-dev deploys can set.
    const allowLocalClaim = config.durableQueue?.allowLocalClaimDuringBackoff === true;
    if (!allowLocalClaim) {
      logger.warn(
        { chain: event.chain, request_id: event.requestId, event_key: buildEventKey(event) },
        'Durable cross-instance claim is offline (Supabase backoff); skipping processing this tick (fail-closed; set allowLocalClaimDuringBackoff=true to opt in) — retry item retained'
      );
      // NOT a conflict: the request is unprocessed, so its retry item must be
      // retained (not cleared) and retried once Supabase recovers.
      return { granted: false, reason: 'backoff_skip' };
    }
    logger.warn(
      { chain: event.chain, request_id: event.requestId, event_key: buildEventKey(event) },
      'Durable cross-instance claim is offline (Supabase backoff); granting local claim — idempotency protection is OFF until Supabase recovers'
    );
    return CLAIM_GRANTED;
  }
  if (!ensureDurableQueueAvailable(config, logger, `${event.chain}:durable-claim`)) {
    // Durable queue enabled but Supabase persistence is unavailable (and not
    // fail-closed): the request is unprocessed, retain its retry item.
    return { granted: false, reason: 'unavailable' };
  }

  const eventKey = buildEventKey(event);
  const staleBeforeIso = new Date(
    Date.now() - Math.max(Number(config.durableQueue?.staleProcessingMs || 120000), 1000)
  ).toISOString();
  const status = retryItem ? 'retrying' : 'processing';
  const attempts = Number(retryItem?.attempts || 0);
  let claim;
  try {
    claim = await claimRelayerJob(
      eventKey,
      {
        status,
        attempts,
        next_retry_at: null,
        worker_response: {
          retry_meta: {
            durable_claimed: true,
            claimed_by: config.instanceId,
            claimed_at: new Date().toISOString(),
            finalize_only: Boolean(retryItem?.finalize_only),
            terminal_error: retryItem?.terminal_error || null,
          },
        },
      },
      {
        readyStatuses: retryItem
          ? [
              'retry_scheduled',
              'failure_callback_retry_scheduled',
              'callback_retry_scheduled',
              'callback_pending',
              'queued',
              'queued_backpressure',
            ]
          : ['queued', 'queued_backpressure'],
        staleStatuses: ['processing', 'retrying', 'callback_pending'],
        staleBeforeIso,
      }
    );
  } catch (error) {
    if (!isTransientDurableQueueError(error)) throw error;
    if (state) incrementMetric(state, 'durable_claim_skipped_during_backoff_total');
    const allowLocalClaim = config.durableQueue?.allowLocalClaimDuringBackoff === true;
    if (allowLocalClaim) {
      logger.warn(
        {
          chain: event.chain,
          request_id: event.requestId,
          event_key: eventKey,
          error,
        },
        'Durable Supabase claim failed transiently; granting explicitly enabled local claim with cross-instance idempotency protection off'
      );
      return CLAIM_GRANTED;
    }
    logger.warn(
      {
        chain: event.chain,
        request_id: event.requestId,
        event_key: eventKey,
        error,
      },
      'Durable Supabase claim is temporarily unavailable; skipping processing until the shared idempotency store recovers'
    );
    return { granted: false, reason: 'unavailable' };
  }
  if (claim) return CLAIM_GRANTED;
  logger.info(
    {
      chain: event.chain,
      request_id: event.requestId,
      event_key: eventKey,
      status,
    },
    'Skipped Morpheus oracle request because another relayer instance already claimed it'
  );
  return { granted: false, reason: 'conflict' };
}

export async function hydrateDurableQueue(config, state, logger, chain, persistState) {
  if (config.mode === 'feed_only') return [];
  if (shouldSkipSupabasePersistence()) {
    return [];
  }
  if (!ensureDurableQueueAvailable(config, logger, `${chain}:durable-queue-hydration`)) return [];

  const minRequestId =
    Number.isFinite(Number(config.startRequestIds?.[chain])) &&
    Number(config.startRequestIds?.[chain]) > 0
      ? Number(config.startRequestIds?.[chain])
      : null;
  let jobs;
  try {
    jobs = await fetchRelayerJobsByStatuses(
      [
        'queued',
        'queued_backpressure',
        'retry_scheduled',
        'failure_callback_retry_scheduled',
        'callback_retry_scheduled',
        'callback_pending',
        'processing',
        'retrying',
      ],
      chain,
      Math.max(Number(config.durableQueue?.syncLimit || 200), 1)
    );
  } catch (error) {
    markSupabasePersistenceUnavailable(error);
    if (!isTransientDurableQueueError(error)) throw error;
    logger.warn(
      { chain, error },
      'Durable Supabase queue hydration unavailable; continuing with local relayer state'
    );
    return [];
  }
  if (!jobs.length) return [];

  const nowMs = Date.now();
  const hydrated = [];
  for (const job of jobs) {
    const jobRequestId = Number(job?.request_id || job?.requestId || 0);
    if (minRequestId !== null && Number.isFinite(jobRequestId) && jobRequestId < minRequestId) {
      continue;
    }
    if (
      !isDurableQueueReadyJob(job, nowMs, Number(config.durableQueue?.staleProcessingMs || 120000))
    ) {
      continue;
    }
    const event = job?.event && typeof job.event === 'object' ? job.event : null;
    if (!event || !event.chain || !event.requestId) continue;
    const eventKey = job.event_key || buildEventKey(event);

    // SECURITY (S4): hydrate must not blindly re-broadcast a DB row whose event
    // was tampered with. Require a well-formed event and a valid HMAC (rows
    // written by this relayer carry one via buildRelayerJobRecord; manual rows
    // are signed by the control plane).
    if (assertDbEventWellFormed(event)) continue;
    const hydrateSignatureError = verifyDbEventSignature(
      job,
      event,
      eventKey,
      config.network,
      'relayer_upsert'
    );
    if (hydrateSignatureError) {
      logger.warn(
        { chain, event_key: eventKey, reason: hydrateSignatureError },
        'Durable hydration skipped tampered or unsigned event'
      );
      continue;
    }

    if (
      hasProcessedEvent(state, chain, eventKey) ||
      isEventQueuedForRetry(state, chain, eventKey)
    ) {
      continue;
    }
    const retryMeta = extractDurableRetryMeta(job);
    if (job.status === 'processing' || job.status === 'retrying') {
      incrementMetric(state, 'stale_reclaims_total');
    }
    enqueueRetryItem(state, chain, event, {
      attempts: Number(job.attempts || 0),
      next_retry_at: parseTimestampMs(job.next_retry_at) || nowMs,
      first_failed_at: job.created_at || new Date(nowMs).toISOString(),
      last_error: job.last_error || null,
      finalize_only: retryMeta.finalize_only,
      terminal_error: retryMeta.terminal_error,
      prepared_fulfillment: retryMeta.prepared_fulfillment,
      durable_claimed: true,
    });
    hydrated.push(eventKey);
  }

  if (hydrated.length > 0) {
    persistState();
    logger.info(
      { chain, hydrated_count: hydrated.length },
      'Hydrated relayer retry queue from durable Supabase jobs'
    );
  }
  return hydrated;
}

export async function quarantineDurableBacklogBelowRequestFloor(config, logger, chain) {
  const minRequestId = getRequestCursorFloor(config, chain);
  if (minRequestId === null) return 0;
  if (shouldSkipSupabasePersistence()) {
    return 0;
  }
  if (!ensureDurableQueueAvailable(config, logger, `${chain}:durable-floor-quarantine`)) return 0;
  let patched;
  try {
    patched = await quarantineRelayerJobsBelowRequestId({
      network: config.network,
      chain,
      ltRequestId: minRequestId,
      statuses: [
        'queued',
        'queued_backpressure',
        'retry_scheduled',
        'failure_callback_retry_scheduled',
        'callback_retry_scheduled',
        'callback_pending',
        'processing',
        'retrying',
      ],
      note: `auto-quarantined below request cursor floor ${minRequestId}`,
    });
  } catch (error) {
    markSupabasePersistenceUnavailable(error);
    if (!isTransientDurableQueueError(error)) throw error;
    logger.warn(
      { chain, request_cursor_floor: minRequestId, error },
      'Durable Supabase floor quarantine unavailable; continuing with local relayer state'
    );
    return 0;
  }
  if (patched > 0) {
    logger.info(
      { chain, request_cursor_floor: minRequestId, quarantined_count: patched },
      'Quarantined stale durable relayer jobs below request cursor floor'
    );
  }
  return patched;
}
