import { randomUUID } from 'node:crypto';
import { normalizeMorpheusNetwork } from './lib/neo-signers.js';

import {
  AUTOMATION_PROCESSING_CLAIM_MARKER,
  claimAutomationJob,
  countActiveAutomationsByRequester,
  fetchActiveAutomationJobs,
  fetchAutomationJobById,
  fetchAutomationRunByQueueTxHash,
  insertAutomationRun,
  patchAutomationJob,
  patchAutomationRunByQueueTxHash,
  persistAutomationEncryptedFields,
  shouldSkipSupabasePersistence,
  markSupabasePersistenceUnavailable,
  upsertAutomationJob,
} from './persistence.js';
import { fetchNeoN3FeedRecord, queueNeoN3AutomationRequest } from './neo-n3.js';
import { buildUpkeepDispatch, buildUpkeepExecutionPayload } from './automation-supervisor.js';
import { isTerminalAutomationQueueFailure } from '@r3e-network/neo-os-services-shared/automation-supervisor';
import { normalizeRequestType, parseNonNegativeInteger, trimString } from './lib/strings.js';

export function resolveSupabaseNetwork(value) {
  return normalizeMorpheusNetwork(
    value || process.env.MORPHEUS_NETWORK || process.env.NEXT_PUBLIC_MORPHEUS_NETWORK || 'testnet'
  );
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// SECURITY (S3) — automation economic-DoS bounds. Every execution is broadcast
// by the relayer (operator GAS), so a schedule must be bounded at registration.
const MIN_AUTOMATION_INTERVAL_MS = 60_000; // interval triggers: >= 60s
const MIN_AUTOMATION_COOLDOWN_MS = 60_000; // price_threshold cooldown: >= 60s
const DEFAULT_MAX_AUTOMATION_EXECUTIONS = 1000; // unset max_executions -> finite
const MAX_AUTOMATION_EXECUTIONS = 10_000; // explicit max_executions ceiling
const MAX_ACTIVE_AUTOMATIONS_PER_REQUESTER = 50; // per-requester quota

function resolveMaxAutomationExecutionsPerRequester() {
  const raw = Number(process.env.MORPHEUS_AUTOMATION_MAX_ACTIVE_PER_REQUESTER);
  return Number.isInteger(raw) && raw > 0 ? raw : MAX_ACTIVE_AUTOMATIONS_PER_REQUESTER;
}

function nowIso() {
  return new Date().toISOString();
}

function parseTimestamp(value) {
  if (value === undefined || value === null || value === '') return null;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

function parsePositiveInteger(value, fieldName) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0 || !Number.isInteger(numeric)) {
    throw new Error(`${fieldName} must be a positive integer`);
  }
  return numeric;
}

function parseBigIntLike(value, fieldName) {
  try {
    return BigInt(String(value));
  } catch {
    throw new Error(`${fieldName} must be an integer string`);
  }
}

function resolveExecutionRequestType(payload) {
  const execution = isPlainObject(payload.execution) ? payload.execution : {};
  const requestType = normalizeRequestType(
    execution.request_type || payload.execution_request_type || ''
  );
  if (!requestType) throw new Error('execution.request_type is required');
  if (requestType.includes('feed')) {
    throw new Error('automation execution request_type cannot be datafeed');
  }
  if (requestType.startsWith('automation_')) {
    throw new Error('automation execution request_type cannot be an automation control type');
  }
  return requestType;
}

function resolveExecutionPayload(payload) {
  const execution = isPlainObject(payload.execution) ? payload.execution : {};
  const executionPayload = execution.payload ?? payload.execution_payload;
  if (typeof executionPayload === 'string') {
    try {
      return JSON.parse(executionPayload);
    } catch {
      return { raw_payload: executionPayload };
    }
  }
  if (!isPlainObject(executionPayload)) {
    throw new Error('execution.payload must be a JSON object or string');
  }
  return executionPayload;
}

function stringifyExecutionPayload(payload) {
  if (typeof payload === 'string') return payload;
  return JSON.stringify(payload);
}

function buildInitialTrigger(trigger) {
  const type = normalizeRequestType(trigger.type || '');
  if (!type) throw new Error('trigger.type is required');

  if (type === 'one_shot') {
    const executeAt = parseTimestamp(trigger.execute_at || trigger.executeAt);
    if (!executeAt) throw new Error('trigger.execute_at is required for one_shot');
    return {
      triggerType: 'one_shot',
      triggerConfig: {
        execute_at: executeAt.toISOString(),
      },
      nextRunAt: executeAt.toISOString(),
    };
  }

  if (type === 'interval') {
    const intervalMs = parsePositiveInteger(
      trigger.interval_ms || trigger.intervalMs,
      'trigger.interval_ms'
    );
    // SECURITY (S3): reject sub-minute intervals so a request cannot register a
    // schedule that fires every tick and drains operator GAS.
    if (intervalMs < MIN_AUTOMATION_INTERVAL_MS) {
      throw new Error(`trigger.interval_ms must be at least ${MIN_AUTOMATION_INTERVAL_MS} ms`);
    }
    const startAt = parseTimestamp(trigger.start_at || trigger.startAt) || new Date();
    return {
      triggerType: 'interval',
      triggerConfig: {
        interval_ms: intervalMs,
        start_at: startAt.toISOString(),
      },
      nextRunAt: startAt.toISOString(),
    };
  }

  if (type === 'price_threshold') {
    const comparator = normalizeRequestType(trigger.comparator || '');
    if (!['gte', 'lte', 'cross_above', 'cross_below'].includes(comparator)) {
      throw new Error('trigger.comparator must be one of gte, lte, cross_above, cross_below');
    }
    const pair = trimString(trigger.pair || trigger.feed_pair || '');
    if (!pair) throw new Error('trigger.pair is required for price_threshold');
    const threshold = parseBigIntLike(trigger.threshold, 'trigger.threshold').toString();
    const cooldownMs =
      trigger.cooldown_ms !== undefined
        ? parsePositiveInteger(trigger.cooldown_ms, 'trigger.cooldown_ms')
        : null;
    // SECURITY (S3): a price_threshold with a tiny/zero cooldown can fire on
    // every feed tick; enforce the same minimum as interval triggers.
    if (cooldownMs !== null && cooldownMs < MIN_AUTOMATION_COOLDOWN_MS) {
      throw new Error(`trigger.cooldown_ms must be at least ${MIN_AUTOMATION_COOLDOWN_MS} ms`);
    }
    const feedChain = normalizeRequestType(trigger.feed_chain || trigger.feedChain || '');
    return {
      triggerType: 'price_threshold',
      triggerConfig: {
        pair,
        comparator,
        threshold,
        cooldown_ms: cooldownMs,
        feed_chain: feedChain || null,
      },
      nextRunAt: null,
    };
  }

  throw new Error(`unsupported trigger.type: ${trigger.type}`);
}

function buildAutomationJobFromPayload(event, payload) {
  if (!isPlainObject(payload)) {
    throw new Error('automation registration payload must be a JSON object');
  }
  const trigger = isPlainObject(payload.trigger) ? payload.trigger : null;
  if (!trigger) throw new Error('trigger is required');

  const executionRequestType = resolveExecutionRequestType(payload);
  const executionPayload = resolveExecutionPayload(payload);
  const { triggerType, triggerConfig, nextRunAt } = buildInitialTrigger(trigger);
  // SECURITY (S3): an unset max_executions previously meant "unlimited" —
  // every fire burns operator GAS. Default it to a finite cap and reject
  // explicit values above the hard ceiling.
  let maxExecutions =
    payload.max_executions === undefined ||
    payload.max_executions === null ||
    payload.max_executions === ''
      ? DEFAULT_MAX_AUTOMATION_EXECUTIONS
      : parsePositiveInteger(payload.max_executions, 'max_executions');
  if (maxExecutions > MAX_AUTOMATION_EXECUTIONS) {
    throw new Error(`max_executions exceeds the ceiling of ${MAX_AUTOMATION_EXECUTIONS}`);
  }

  return {
    automation_id: `automation:${event.chain}:${randomUUID()}`,
    registration_request_id: String(event.requestId),
    network: resolveSupabaseNetwork(event.network),
    project_slug: trimString(payload.project_slug || executionPayload.project_slug || ''),
    chain: event.chain,
    requester: trimString(event.requester || ''),
    callback_contract: trimString(event.callbackContract || ''),
    callback_method: trimString(event.callbackMethod || ''),
    execution_request_type: executionRequestType,
    execution_payload: executionPayload,
    trigger_type: triggerType,
    trigger_config: triggerConfig,
    trigger_state: {},
    status: 'active',
    next_run_at: nextRunAt,
    last_run_at: null,
    execution_count: 0,
    max_executions: maxExecutions,
    last_queued_request_id: null,
    last_error: null,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
}

function buildRegistrationResult(job) {
  return {
    mode: 'automation',
    action: 'register',
    automation_id: job.automation_id,
    chain: job.chain,
    requester: job.requester,
    callback_contract: job.callback_contract,
    execution_request_type: job.execution_request_type,
    trigger_type: job.trigger_type,
    next_run_at: job.next_run_at,
    status: job.status,
  };
}

// A job is mid-flight when a tick has already claimed it (status=processing, or the
// paused stale-reclaim lane) AND pinned an on-chain request_id for the in-flight
// execution. That execution is already broadcast/queued and earns its on-chain
// billing regardless of cancel — so the cancel result must not pretend it was fully
// cancelled. (A FINALIZED row carries last_queued_request_id too, but its status is
// back to active/completed, so the status check is the discriminator.)
function resolveInFlightExecutionForCancel(job) {
  if (!job) return null;
  if (!isReclaimableInflightStatus(job)) return null;
  const inFlightRequestId = trimString(job.last_queued_request_id || '');
  if (!inFlightRequestId) return null;
  return inFlightRequestId;
}

function buildCancellationResult(job, automationId) {
  const inFlightRequestId = resolveInFlightExecutionForCancel(job);
  const result = {
    mode: 'automation',
    action: 'cancel',
    automation_id: automationId,
    chain: job?.chain || null,
    // All FUTURE executions are prevented; if an execution is already in flight the
    // job is not yet fully cancelled — it finishes the already-charged execution.
    status: inFlightRequestId ? 'cancelling' : 'cancelled',
    future_executions_cancelled: true,
  };
  if (inFlightRequestId) {
    // Surface that one already-queued execution will still run and be billed, so the
    // caller is not told the cancel was clean while still being charged for it.
    result.in_flight_execution = {
      request_id: inFlightRequestId,
      // The already-queued execution is earned on-chain; cancel does not refund it.
      will_be_charged: true,
    };
    result.message =
      'one already-queued execution will still run and be charged; all future executions are cancelled';
  }
  return result;
}

function buildCancelledExecutionError(automationId) {
  return `automation cancelled before execution: ${automationId}`;
}

export async function guardQueuedAutomationExecution(event, deps = {}) {
  const txHash = trimString(event?.txHash || '');
  if (!txHash) return { blocked: false, run: null, job: null };

  const fetchRun = deps.fetchAutomationRunByQueueTxHash || fetchAutomationRunByQueueTxHash;
  const fetchJob = deps.fetchAutomationJobById || fetchAutomationJobById;
  const patchRun = deps.patchAutomationRunByQueueTxHash || patchAutomationRunByQueueTxHash;

  const run = await fetchRun(txHash);
  if (!run) return { blocked: false, run: null, job: null };

  const automationId = trimString(run.automation_id || '');
  if (!automationId) {
    await patchRun(txHash, {
      status: 'failed',
      error: 'queued automation run missing automation_id',
    }).catch(() => undefined);
    return {
      blocked: true,
      route: 'automation:invalid-queued-run',
      error: 'queued automation run missing automation_id',
      automation_id: null,
      run,
      job: null,
    };
  }

  const job = await fetchJob(automationId);
  if (!job) {
    const error = `automation job missing before execution: ${automationId}`;
    await patchRun(txHash, {
      status: 'failed',
      error,
    }).catch(() => undefined);
    return {
      blocked: true,
      route: 'automation:missing-before-execution',
      error,
      automation_id: automationId,
      run,
      job: null,
    };
  }

  if (trimString(job.status || '') === 'cancelled') {
    // A cancel that lands while an execution is mid-flight must NOT strand the
    // already-queued (and therefore already-billed) execution. That one earned its
    // on-chain billing before the cancel, so it is allowed to fulfill; every OTHER
    // (future) queued execution of a cancelled job is blocked. The pinned
    // last_queued_request_id is the in-flight execution's id; only the run carrying
    // that exact id is let through.
    const inFlightRequestId = trimString(job.last_queued_request_id || '');
    const runRequestId = trimString(run.queued_request_id || '');
    const isInFlightExecution = Boolean(inFlightRequestId) && runRequestId === inFlightRequestId;
    if (!isInFlightExecution) {
      const error = buildCancelledExecutionError(automationId);
      await patchRun(txHash, {
        status: 'failed',
        error,
      }).catch(() => undefined);
      return {
        blocked: true,
        route: 'automation:cancelled-before-execution',
        error,
        automation_id: automationId,
        run,
        job,
      };
    }
  }

  return {
    blocked: false,
    automation_id: automationId,
    run,
    job,
  };
}

export function isAutomationControlRequestType(requestType) {
  const normalized = normalizeRequestType(requestType);
  return normalized === 'automation_register' || normalized === 'automation_cancel';
}

export async function handleAutomationControlRequest(event, payload, deps = {}) {
  const normalized = normalizeRequestType(event.requestType);
  const upsertJob = deps.upsertAutomationJob || upsertAutomationJob;
  const persistEncrypted =
    deps.persistAutomationEncryptedFields || persistAutomationEncryptedFields;
  const fetchJob = deps.fetchAutomationJobById || fetchAutomationJobById;
  const patchJob = deps.patchAutomationJob || patchAutomationJob;

  if (normalized === 'automation_register') {
    // SECURITY (S3): per-requester quota — a single account must not register an
    // unbounded number of schedules that the relayer broadcasts at operator cost.
    const quota = resolveMaxAutomationExecutionsPerRequester();
    const countActive = deps.countActiveAutomationsByRequester || countActiveAutomationsByRequester;
    const activeCount = await countActive(event.requester || '');
    if (activeCount >= quota) {
      return {
        ok: false,
        status: 429,
        body: {
          error: `requester automation quota exceeded (${activeCount} active, max ${quota})`,
          active: activeCount,
          quota,
        },
        route: 'automation:register',
      };
    }
    const job = buildAutomationJobFromPayload(event, payload);
    await upsertJob(job);
    await persistEncrypted(job);
    return {
      ok: true,
      status: 200,
      body: buildRegistrationResult(job),
      route: 'automation:register',
    };
  }

  if (normalized === 'automation_cancel') {
    const automationId = trimString(payload?.automation_id || payload?.id || '');
    if (!automationId) {
      return {
        ok: false,
        status: 400,
        body: { error: 'automation_id required' },
        route: 'automation:cancel',
      };
    }
    const job = await fetchJob(automationId);
    if (!job) {
      return {
        ok: false,
        status: 404,
        body: { error: `automation not found: ${automationId}` },
        route: 'automation:cancel',
      };
    }
    if (trimString(job.requester) !== trimString(event.requester || '')) {
      return {
        ok: false,
        status: 403,
        body: { error: 'automation cancel requester mismatch' },
        route: 'automation:cancel',
      };
    }

    // Always prevent FUTURE executions by clearing the schedule and flipping the job
    // out of the active lane.
    const cancellationPatch = {
      status: 'cancelled',
      next_run_at: null,
    };

    // If a tick already claimed + queued an execution (mid-flight), the on-chain
    // request is earned and will be billed. Preserve the pinned request_id and the
    // in-flight failure marker so the stale-reclaim lane / guardQueuedAutomationExecution
    // still reconciles that one execution; only blanking last_error here would lose the
    // claim marker that keeps a paused mid-flight row reclaimable. Do NOT clear the
    // billing of the already-queued execution — it is not refundable.
    const inFlightRequestId = resolveInFlightExecutionForCancel(job);
    if (!inFlightRequestId) {
      cancellationPatch.last_error = null;
    }

    await patchJob(automationId, cancellationPatch);
    return {
      ok: true,
      status: 200,
      body: buildCancellationResult(job, automationId),
      route: 'automation:cancel',
    };
  }

  return null;
}

function evaluatePriceThreshold(job, record, nowMs, defaultCooldownMs) {
  const triggerConfig = isPlainObject(job.trigger_config) ? job.trigger_config : {};
  const triggerState = isPlainObject(job.trigger_state) ? job.trigger_state : {};
  const threshold = BigInt(String(triggerConfig.threshold || '0'));
  const current = BigInt(String(record.price || '0'));
  const previous =
    triggerState.last_observed_value !== undefined &&
    triggerState.last_observed_value !== null &&
    triggerState.last_observed_value !== ''
      ? BigInt(String(triggerState.last_observed_value))
      : null;
  const comparator = normalizeRequestType(triggerConfig.comparator || '');
  const cooldownMs = Number(triggerConfig.cooldown_ms ?? defaultCooldownMs ?? 0);

  let due = false;
  if (comparator === 'gte') due = current >= threshold;
  if (comparator === 'lte') due = current <= threshold;
  if (comparator === 'cross_above') {
    due = previous !== null && previous < threshold && current >= threshold;
  }
  if (comparator === 'cross_below') {
    due = previous !== null && previous > threshold && current <= threshold;
  }

  return {
    due,
    triggerReason: `${comparator}:${triggerConfig.pair}`,
    observedValue: current.toString(),
    patch: {
      trigger_state: {
        ...triggerState,
        last_observed_value: current.toString(),
        last_observed_at: new Date(nowMs).toISOString(),
        last_round_id: String(record.roundId || '0'),
      },
      next_run_at:
        due && cooldownMs > 0 ? new Date(nowMs + cooldownMs).toISOString() : job.next_run_at,
    },
  };
}

async function evaluateAutomationJob(config, job, nowMs, deps = {}) {
  if (job.status !== 'active') return { due: false, patch: null, reason: 'inactive' };

  if (
    job.max_executions !== null &&
    job.max_executions !== undefined &&
    Number(job.execution_count || 0) >= Number(job.max_executions)
  ) {
    return {
      due: false,
      patch: { status: 'completed', next_run_at: null },
      reason: 'max-executions-reached',
    };
  }

  if (job.trigger_type === 'one_shot' || job.trigger_type === 'interval') {
    const nextRun = parseTimestamp(
      job.next_run_at || (isPlainObject(job.trigger_config) ? job.trigger_config.start_at : null)
    );
    if (!nextRun) {
      return {
        due: false,
        patch: { status: 'error', last_error: 'invalid next_run_at' },
        reason: 'invalid-next-run',
      };
    }
    return { due: nextRun.getTime() <= nowMs, patch: null, reason: job.trigger_type };
  }

  if (job.trigger_type === 'price_threshold') {
    const triggerConfig = isPlainObject(job.trigger_config) ? job.trigger_config : {};
    const pair = trimString(triggerConfig.pair || '');
    if (!pair) {
      return {
        due: false,
        patch: { status: 'error', last_error: 'price_threshold pair missing' },
        reason: 'invalid-pair',
      };
    }
    if (job.next_run_at && parseTimestamp(job.next_run_at)?.getTime() > nowMs) {
      return { due: false, patch: null, reason: 'cooldown' };
    }
    const loadNeoN3FeedRecord = deps.fetchNeoN3FeedRecord || fetchNeoN3FeedRecord;
    const record = await loadNeoN3FeedRecord(config, pair);
    return evaluatePriceThreshold(job, record, nowMs, config.automation.defaultPriceCooldownMs);
  }

  return {
    due: false,
    patch: { status: 'error', last_error: `unsupported trigger type: ${job.trigger_type}` },
    reason: 'unsupported-trigger',
  };
}

function computeNextIntervalRun(job, nowMs) {
  const triggerConfig = isPlainObject(job.trigger_config) ? job.trigger_config : {};
  const intervalMs = Number(triggerConfig.interval_ms || 0);
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return null;
  return new Date(nowMs + intervalMs).toISOString();
}

function classifyAutomationExecutionFailure(error, options = {}) {
  const message = trimString(error instanceof Error ? error.message : String(error));

  // These failures are terminal for the current job state and should stop
  // scheduler retries until an operator/user explicitly reactivates the job: the
  // payer has no credit, or no account consented to pay (R-01: no witness, no or an
  // expired or spent approval), or the job no longer matches its registration.
  if (isTerminalAutomationQueueFailure(message)) {
    return {
      terminal: true,
      patch: {
        status: 'error',
        next_run_at: null,
        last_error: message,
      },
    };
  }

  // Non-terminal failure AFTER the durable claim advanced + pinned this execution
  // (the broadcast was attempted and may have landed despite the error). Keep the
  // row in the stale-reclaim lane (status=processing) instead of flipping it back to
  // active: a later tick reclaims it past claimStaleMs and retries the SAME pinned
  // request_id (the kernel dedups if the tx landed), so a false-negative broadcast
  // error cannot mint a second logical execution / double callback.
  if (options.inFlightExecution) {
    return {
      terminal: false,
      patch: {
        status: 'processing',
        last_error: message,
      },
    };
  }

  return {
    terminal: false,
    patch: {
      status: 'active',
      last_error: message,
    },
  };
}

function buildQueuedAutomationPatch(job, evaluation, nowMs, dispatch, queuedRequestId) {
  let nextStatus = 'active';
  let nextRunAt = job.next_run_at;
  if (job.trigger_type === 'one_shot') {
    nextStatus = 'completed';
    nextRunAt = null;
  } else if (job.trigger_type === 'interval') {
    nextRunAt = computeNextIntervalRun(job, nowMs);
  } else if (evaluation.patch?.next_run_at !== undefined) {
    nextRunAt = evaluation.patch.next_run_at;
  }
  if (
    job.max_executions !== null &&
    job.max_executions !== undefined &&
    dispatch.next_execution_count >= Number(job.max_executions)
  ) {
    nextStatus = 'completed';
    nextRunAt = null;
  }

  return {
    ...evaluation.patch,
    execution_count: dispatch.next_execution_count,
    last_run_at: new Date(nowMs).toISOString(),
    last_queued_request_id: queuedRequestId || dispatch.request_id,
    next_run_at: nextRunAt,
    status: nextStatus,
    last_error: null,
  };
}

function buildQueuedAutomationTxRecord(queuedTx, dispatch) {
  return {
    ...(queuedTx || {}),
    workflow_id: dispatch.workflow_id,
    workflow_version: dispatch.workflow_version,
    execution_id: dispatch.execution_id,
    idempotency_key: dispatch.idempotency_key,
    replay_window: dispatch.replay_window,
    delivery_mode: dispatch.delivery_mode,
  };
}

// Resolves the dispatch (and therefore the count-based on-chain request_id) for a
// job's NEXT logical execution, while detecting a reclaim of an execution that was
// already advanced+pinned before a crash.
//
// Durability invariant: the on-chain request_id is derived from
// (automation_id, execution_count). To make execution dedup DURABLE rather than
// solely process-local, the claim advances execution_count and pins
// last_queued_request_id ATOMICALLY (see processAutomationJobs). So once a logical
// execution N is claimed, the durable row carries execution_count=N and
// last_queued_request_id=id(N).
//
// - Fresh claim: row.last_queued_request_id != id(row.execution_count + 1), so the
//   next execution is (count + 1); the claim must advance the row.
// - Reclaim after a crashed broadcast: the row was already advanced to count=N with
//   last_queued_request_id=id(N) AND left mid-flight (status=processing / paused
//   claim marker — the finalize patch never ran). Re-deriving the dispatch off the
//   row would mint id(N+1) and double-queue. Instead we re-derive the SAME execution
//   (count N-1 as the base so next_execution_count=N, request_id=id(N)) and DO NOT
//   advance again.
//
// The mid-flight status is the discriminator: a FINALIZED row is also at count=N
// with last_queued_request_id=id(N) but has status back to active/completed, so a
// later due tick must advance to N+1 — not be mistaken for a reclaim.
function isReclaimableInflightStatus(job) {
  const status = trimString(job.status || '');
  if (status === 'processing') return true;
  return (
    status === 'paused' && trimString(job.last_error || '') === AUTOMATION_PROCESSING_CLAIM_MARKER
  );
}

function resolveAutomationExecutionDispatch(job) {
  const currentCount = parseNonNegativeInteger(job.execution_count || job.executionCount);
  const pinnedRequestId = trimString(job.last_queued_request_id || '');
  // The id this row would mint if its current count were the just-claimed (but not
  // yet finalized) execution (i.e. the row was already advanced for it).
  const advancedDispatch = buildUpkeepDispatch({ ...job, execution_count: currentCount - 1 });
  if (
    isReclaimableInflightStatus(job) &&
    currentCount > 0 &&
    pinnedRequestId &&
    pinnedRequestId === advancedDispatch.request_id
  ) {
    return { dispatch: advancedDispatch, alreadyAdvanced: true };
  }
  // Fresh execution: advance from the current count.
  return { dispatch: buildUpkeepDispatch(job), alreadyAdvanced: false };
}

// The dispatch is resolved ONCE at claim time (resolveAutomationExecutionDispatch)
// and threaded through here so the on-chain request_id is pinned before broadcast
// and never re-derived off the already-advanced row (which would mint the NEXT id).
async function queueAutomationExecution(config, job, dispatch, deps = {}) {
  const payloadText = stringifyExecutionPayload(
    buildUpkeepExecutionPayload(job.execution_payload || {}, {
      ...job,
      execution_count: dispatch.execution_count,
      request_id: dispatch.request_id,
    })
  );
  const queueNeoN3 = deps.queueNeoN3AutomationRequest || queueNeoN3AutomationRequest;
  if (job.chain !== 'neo_n3') {
    throw new Error(`Invalid automation job chain: ${job.chain}`);
  }
  return {
    dispatch,
    ...(await queueNeoN3(
      config,
      job.requester,
      job.execution_request_type,
      payloadText,
      job.callback_contract,
      job.callback_method,
      dispatch.request_id,
      // The on-chain automation_register request this job was created from. On a kernel
      // with the R-01 execution lane it ties the execution to the owner's spend approval.
      job.registration_request_id
    )),
  };
}

// Idle-fetch backoff (Round-2 R2-0.2): automation jobs are inserted by the control plane
// (apps/web), so the relayer cannot know when a new one arrives without polling. To cut
// steady-state Supabase load on idle deployments, skip the fetchActiveAutomationJobs query
// for up to automationIdleBackoffMs after a fetch that returned ZERO due jobs. The window is
// bounded small (default disabled; a sane opt-in is 15-30s) so an externally-inserted job is
// picked up within that window. Module-level because automation is process-singleton (one
// processAutomationJobs per relayer, not per-chain). Reset to 0 the moment a non-empty fetch
// returns so an active automation schedule resumes immediately.
let lastEmptyAutomationFetchAt = 0;

export async function processAutomationJobs(config, logger, deps = {}) {
  if (!config.automation.enabled) {
    return { queued: 0, skipped: 0, failed: 0, inspected: 0 };
  }
  if (shouldSkipSupabasePersistence()) {
    return { queued: 0, skipped: 0, failed: 0, inspected: 0 };
  }

  // Idle-fetch backoff: if the last fetch was empty and we're still within the window,
  // skip this fetch entirely (returns empty). An externally-inserted job is picked up on
  // the next fetch after the window elapses. Disabled when automationIdleBackoffMs <= 0.
  const automationIdleBackoffMs = Math.max(Number(config.automation.idleBackoffMs || 0), 0);
  if (
    automationIdleBackoffMs > 0 &&
    lastEmptyAutomationFetchAt > 0 &&
    Date.now() - lastEmptyAutomationFetchAt < automationIdleBackoffMs
  ) {
    return { queued: 0, skipped: 0, failed: 0, inspected: 0, idle_skipped: true };
  }

  const fetchJobs = deps.fetchActiveAutomationJobs || fetchActiveAutomationJobs;
  const claimJob = deps.claimAutomationJob || claimAutomationJob;
  const patchJob = deps.patchAutomationJob || patchAutomationJob;
  const recordRun = deps.insertAutomationRun || insertAutomationRun;
  let jobs;
  const now = new Date();
  const dueAtIso = now.toISOString();
  const claimStaleMs = Math.max(Number(config.automation.claimStaleMs || 120000), 1000);
  const staleBeforeIso = new Date(now.getTime() - claimStaleMs).toISOString();
  try {
    jobs = await fetchJobs(config.automation.batchSize, dueAtIso);
    // Track empty vs non-empty fetches for the idle backoff. A non-empty fetch resets the
    // window so an active schedule resumes immediately; an empty fetch arms the skip.
    lastEmptyAutomationFetchAt = jobs.length === 0 ? Date.now() : 0;
  } catch (error) {
    markSupabasePersistenceUnavailable(error);
    logger.warn({ error }, 'Supabase automation fetch unavailable; skipping automation tick');
    return { queued: 0, skipped: 0, failed: 0, inspected: 0 };
  }

  let queued = 0;
  let skipped = 0;
  let failed = 0;
  const nowMs = Date.now();

  for (const job of jobs) {
    if (queued >= config.automation.maxQueuedPerTick) break;

    // Set once the durable claim has advanced+pinned the execution and we are about
    // to (or did) broadcast. If the broadcast then fails non-terminally, the catch
    // keeps the row in the stale-reclaim lane (status=processing) so the SAME pinned
    // request_id is retried — never a fresh second logical execution. This unifies a
    // broadcast that crashes (no catch runs) with one that throws a false-negative
    // timeout after the tx may already have landed on-chain.
    let inFlightExecution = null;

    try {
      const isRecoverableClaim = isReclaimableInflightStatus(job);
      const schedulableJob = isRecoverableClaim ? { ...job, status: 'active' } : job;
      const evaluation = await evaluateAutomationJob(config, schedulableJob, nowMs, deps);
      if (evaluation.patch) {
        await patchJob(schedulableJob.automation_id, evaluation.patch);
      }
      if (!evaluation.due) {
        skipped += 1;
        continue;
      }

      // Advance execution_count and pin last_queued_request_id ATOMICALLY as part
      // of the durable claim so execution dedup survives a relayer crash/restart and
      // does not rely on the process-local fast-path cache as the source of truth.
      // For a fresh claim, the single winning conditional PATCH advances the count
      // and pins the count-based request_id; a concurrent duplicate claim finds the
      // row already advanced (status no longer matches active/stale-processing) and
      // returns null → no-op. For a reclaim of an already-advanced execution (crash
      // after broadcast), the dispatch re-derives the SAME id and the claim keeps the
      // pinned values (no second logical execution).
      // Reclaim detection needs the ORIGINAL durable status (processing / paused
      // claim marker), which schedulableJob has normalized to 'active'.
      const { dispatch: claimDispatch, alreadyAdvanced } = resolveAutomationExecutionDispatch({
        ...schedulableJob,
        status: job.status,
        last_error: job.last_error,
      });
      const claimFields = {
        status: 'processing',
        last_error: null,
      };
      if (!alreadyAdvanced) {
        claimFields.execution_count = claimDispatch.next_execution_count;
        claimFields.last_queued_request_id = claimDispatch.request_id;
      }
      const claimedJob = await claimJob(schedulableJob.automation_id, claimFields, {
        dueAtIso,
        staleBeforeIso,
      });
      if (!claimedJob) {
        skipped += 1;
        continue;
      }

      // The claimed row is the durable source of truth for the pinned execution:
      // its execution_count is already advanced and last_queued_request_id holds the
      // count-based id, so queueAutomationExecution re-derives the same request_id.
      const executionJob = {
        ...schedulableJob,
        ...claimedJob,
        execution_count: claimDispatch.next_execution_count,
        last_queued_request_id: claimDispatch.request_id,
        status: 'active',
      };
      // From here the execution is durably pinned (count advanced, request_id set).
      // A failure after this point must retry the SAME execution, not mint a new one.
      inFlightExecution = { request_id: claimDispatch.request_id };
      const queuedTx = await queueAutomationExecution(config, executionJob, claimDispatch, deps);
      const dispatch = queuedTx?.dispatch || claimDispatch;
      const queuedRequestId = queuedTx?.request_id || dispatch.request_id;
      const queueTxRecord = buildQueuedAutomationTxRecord(queuedTx, dispatch);

      if (queuedTx?.duplicate) {
        await recordRun({
          automation_id: executionJob.automation_id,
          queued_request_id: queuedRequestId,
          chain: executionJob.chain,
          status: 'skipped',
          trigger_reason: evaluation.triggerReason || executionJob.trigger_type,
          observed_value: evaluation.observedValue || null,
          queue_tx: queueTxRecord,
          error: null,
        });
        await patchJob(
          executionJob.automation_id,
          buildQueuedAutomationPatch(executionJob, evaluation, nowMs, dispatch, queuedRequestId)
        );
        skipped += 1;
        continue;
      }
      await recordRun({
        automation_id: executionJob.automation_id,
        queued_request_id: queuedRequestId,
        chain: executionJob.chain,
        status: 'queued',
        trigger_reason: evaluation.triggerReason || executionJob.trigger_type,
        observed_value: evaluation.observedValue || null,
        queue_tx: queueTxRecord,
        error: null,
      });

      await patchJob(
        executionJob.automation_id,
        buildQueuedAutomationPatch(executionJob, evaluation, nowMs, dispatch, queuedRequestId)
      );
      queued += 1;
    } catch (error) {
      failed += 1;
      const failure = classifyAutomationExecutionFailure(error, { inFlightExecution });
      await patchJob(job.automation_id, failure.patch).catch(() => undefined);
      await recordRun({
        automation_id: job.automation_id,
        queued_request_id: null,
        chain: job.chain,
        status: 'failed',
        trigger_reason: job.trigger_type,
        observed_value: null,
        queue_tx: null,
        error: error instanceof Error ? error.message : String(error),
      }).catch(() => undefined);
      logger.warn({ automation_id: job.automation_id, error }, 'Automation job processing failed');
    }
  }

  return { queued, skipped, failed, inspected: jobs.length };
}
