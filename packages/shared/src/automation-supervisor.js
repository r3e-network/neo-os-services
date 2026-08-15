// Automation "upkeep" dispatch / execution-payload builders.
//
// Single source of truth shared by the relayer (box + fulfillment lanes, via a
// thin re-export in workers/morpheus-relayer/src/automation-supervisor.js) and
// the apps/web control-plane edge route, which previously reached across the
// workspace boundary into workers/morpheus-relayer/src through a deep relative
// import. Owning the on-chain request_id / dedup derivation, this must stay a
// single implementation so both dispatch lanes mint identical ids.
//
// The string helpers below deliberately use STRICT, type-preserving semantics
// (non-string -> ''), matching the relayer's lib/strings.js. Do NOT swap them for
// the coercing trimString in @r3e-network/neo-os-services-shared/utils (String(value ||
// '')): a non-string job field must normalize to '' (treated as absent) so the
// derived request_id / execution_id fall back to the deterministic count-based
// form instead of embedding a String()-coerced number/object into the dedup key.
function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function parseNonNegativeInteger(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return 0;
  return Math.trunc(numeric);
}

function normalizeWorkflowVersion(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 1;
  return Math.trunc(numeric);
}

export function buildUpkeepDispatch(job = {}) {
  const automationId = trimString(job.automation_id || job.automationId || '');
  if (!automationId) throw new Error('automation_id is required');

  const workflowId = trimString(job.workflow_id || job.workflowId || '') || 'automation.upkeep';
  const workflowVersion = normalizeWorkflowVersion(job.workflow_version || job.workflowVersion);
  const executionCount = parseNonNegativeInteger(job.execution_count || job.executionCount);
  const nextExecutionCount = executionCount + 1;
  const chain = trimString(job.chain || '') || 'unknown';
  const explicitExecutionId = trimString(job.execution_id || job.executionId || '');
  const executionId = explicitExecutionId || `${workflowId}:${automationId}:${nextExecutionCount}`;

  return {
    workflow_id: workflowId,
    workflow_version: workflowVersion,
    automation_id: automationId,
    execution_count: executionCount,
    next_execution_count: nextExecutionCount,
    execution_id: executionId,
    // The on-chain request_id is the CROSS-LANE dedup key, so it must derive only
    // from (automation_id, execution_count) — never from execution_id. The box
    // relayer dispatches with no execution_id (count-based id); the control-plane
    // edge path carries a random per-request execution_id. If request_id followed
    // execution_id, the two lanes would mint DIFFERENT ids for the same logical
    // execution and the oracle kernel's "request_id already used" guard could not
    // dedup them → a genuine double queueAutomationRequest + double callback. Keep
    // execution_id free-form for workflow/observability tracking only.
    request_id:
      trimString(job.request_id || job.requestId || '') ||
      `automation:${chain}:${automationId}:${nextExecutionCount}`,
    idempotency_key:
      trimString(job.idempotency_key || job.idempotencyKey || '') ||
      `${workflowId}:${automationId}:${nextExecutionCount}`,
    replay_window: trimString(job.replay_window || job.replayWindow || '') || 'strict',
    delivery_mode: trimString(job.delivery_mode || job.deliveryMode || '') || 'onchain_callback',
  };
}

export function buildUpkeepExecutionPayload(payload = {}, job = {}) {
  const basePayload =
    payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const dispatch = buildUpkeepDispatch(job);
  return {
    ...basePayload,
    automation_id: dispatch.automation_id,
    workflow_id: dispatch.workflow_id,
    workflow_version: dispatch.workflow_version,
    execution_id: dispatch.execution_id,
    idempotency_key: dispatch.idempotency_key,
    replay_window: dispatch.replay_window,
    delivery_mode: dispatch.delivery_mode,
  };
}
