import { isAuthorizedWorkflowRequest } from '@/lib/control-plane-auth';
import { sendHeartbeat } from '@/lib/heartbeat';
import {
  fetchAutomationJobForBackend,
  patchAutomationJobForBackend,
  queueNeoN3AutomationViaBackend,
  recordAutomationRunForBackend,
} from '@/lib/neo-control-plane';
import {
  buildUpkeepDispatch,
  buildUpkeepExecutionPayload,
} from '@r3e-network/neo-os-services-shared/automation-supervisor';
import { badRequest } from '@/lib/api-helpers';
import { resolveRequestNetwork } from '@/lib/request-network';
import { findHostSignerMaterialPaths } from '@/lib/host-key-guard';
import { trimString } from '@/lib/strings';

export const runtime = 'nodejs';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseTimestamp(value: unknown) {
  const text = trimString(value);
  if (!text) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

function buildRouteUpkeepDispatch(
  body: Record<string, unknown>,
  job: Record<string, unknown>,
  automationId: string
) {
  return buildUpkeepDispatch({
    ...job,
    automation_id: automationId,
    workflow_id: trimString(body.workflow_id || body.workflowId || ''),
    workflow_version: body.workflow_version || body.workflowVersion,
    execution_id: trimString(body.execution_id || body.executionId || ''),
    request_id: trimString(body.request_id || body.requestId || ''),
    idempotency_key: trimString(body.idempotency_key || body.idempotencyKey || ''),
    replay_window: trimString(body.replay_window || body.replayWindow || ''),
    delivery_mode: trimString(body.delivery_mode || body.deliveryMode || ''),
  });
}

function buildExecutionPayload(
  job: Record<string, unknown>,
  dispatch: ReturnType<typeof buildUpkeepDispatch>
) {
  const basePayload =
    typeof job.execution_payload === 'string'
      ? { raw_payload: job.execution_payload }
      : isPlainObject(job.execution_payload)
        ? job.execution_payload
        : {};
  return buildUpkeepExecutionPayload(basePayload, dispatch);
}

function buildQueueTxRecord(
  queueTx: Record<string, unknown>,
  dispatch: ReturnType<typeof buildUpkeepDispatch>
) {
  return {
    ...queueTx,
    workflow_id: dispatch.workflow_id,
    workflow_version: dispatch.workflow_version,
    execution_id: dispatch.execution_id,
    idempotency_key: dispatch.idempotency_key,
    replay_window: dispatch.replay_window,
    delivery_mode: dispatch.delivery_mode,
  };
}

function isDuplicateQueueError(error: unknown) {
  const message = trimString(error instanceof Error ? error.message : String(error));
  return /request[_ ]id already used/i.test(message);
}

export async function POST(request: Request) {
  if (!isAuthorizedWorkflowRequest(request)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  if (!isPlainObject(body)) return badRequest('invalid JSON body');

  if (findHostSignerMaterialPaths(body).length > 0) {
    return badRequest(
      'raw signer material (wif/private_key) is not accepted; signing uses the configured enclave/KMS signer'
    );
  }

  const automationId = trimString(body.automation_id || body.id || '');
  if (!automationId) return badRequest('automation_id is required');

  const requestedNetwork = resolveRequestNetwork(trimString(body.network || 'testnet'));
  if (!requestedNetwork.ok) return requestedNetwork.response;
  const network = requestedNetwork.network;

  try {
    const job = await fetchAutomationJobForBackend(network, automationId);
    if (!job) {
      return Response.json({ error: `automation not found: ${automationId}` }, { status: 404 });
    }

    const currentStatus = trimString(job.status || '');
    if (currentStatus !== 'active') {
      return Response.json({
        ok: true,
        network,
        automation_id: automationId,
        job_status: currentStatus || null,
        queued: false,
        reason: 'inactive',
      });
    }

    const nextRunAt = parseTimestamp(job.next_run_at);
    if (nextRunAt && nextRunAt.getTime() > Date.now()) {
      return Response.json({
        ok: true,
        network,
        automation_id: automationId,
        job_status: currentStatus,
        queued: false,
        reason: 'not-due',
        next_run_at: nextRunAt.toISOString(),
      });
    }

    if (trimString(job.chain || '') !== 'neo_n3') {
      return Response.json(
        { error: 'only neo_n3 automation execution is currently implemented in app backend' },
        { status: 400 }
      );
    }

    const dispatch = buildRouteUpkeepDispatch(body, job, automationId);
    const previousQueuedRequestId = trimString(job.last_queued_request_id || '');
    if (previousQueuedRequestId && previousQueuedRequestId === dispatch.request_id) {
      return Response.json({
        ok: true,
        network,
        automation_id: automationId,
        job_status: currentStatus,
        queued: false,
        duplicate: true,
        reason: 'already-queued',
        queue_tx: {
          request_id: dispatch.request_id,
          target_chain: 'neo_n3',
          duplicate: true,
        },
        dispatch,
      });
    }

    const payloadText = JSON.stringify(buildExecutionPayload(job, dispatch));

    let queueTx;
    try {
      queueTx = await queueNeoN3AutomationViaBackend({
        network,
        requester: trimString(job.requester || ''),
        requestType: trimString(job.execution_request_type || ''),
        payloadText,
        callbackContract: trimString(job.callback_contract || ''),
        callbackMethod: trimString(job.callback_method || ''),
        requestId: dispatch.request_id,
      });
    } catch (error) {
      if (!isDuplicateQueueError(error)) throw error;
      const duplicateTx = {
        request_id: dispatch.request_id,
        target_chain: 'neo_n3',
        duplicate: true,
      };
      await recordAutomationRunForBackend(network, {
        automation_id: automationId,
        queued_request_id: dispatch.request_id,
        chain: job.chain,
        status: 'skipped',
        trigger_reason: trimString(job.trigger_type || '') || 'manual_control_plane',
        observed_value: null,
        queue_tx: buildQueueTxRecord(duplicateTx, dispatch),
        error: null,
      }).catch(() => undefined);
      await patchAutomationJobForBackend(network, automationId, {
        execution_count: dispatch.next_execution_count,
        last_run_at: new Date().toISOString(),
        last_queued_request_id: dispatch.request_id,
        last_error: null,
      }).catch(() => undefined);
      return Response.json({
        ok: true,
        network,
        automation_id: automationId,
        job_status: currentStatus,
        queued: false,
        duplicate: true,
        reason: 'already-queued',
        queue_tx: duplicateTx,
        dispatch,
      });
    }

    await recordAutomationRunForBackend(network, {
      automation_id: automationId,
      queued_request_id: queueTx.request_id || dispatch.request_id,
      chain: job.chain,
      status: 'queued',
      trigger_reason: trimString(job.trigger_type || '') || 'manual_control_plane',
      observed_value: null,
      queue_tx: buildQueueTxRecord(queueTx, dispatch),
      error: null,
    });

    await patchAutomationJobForBackend(network, automationId, {
      execution_count: dispatch.next_execution_count,
      last_run_at: new Date().toISOString(),
      last_queued_request_id: queueTx.request_id || dispatch.request_id,
      last_error: null,
    });

    void sendHeartbeat(process.env.MORPHEUS_BETTERSTACK_CONTROL_AUTOMATION_HEARTBEAT_URL || '', {
      route: '/api/internal/control-plane/automation-execute',
      network,
      automation_id: automationId,
      workflow_id: dispatch.workflow_id,
      execution_id: dispatch.execution_id,
      queued: true,
    });

    return Response.json({
      ok: true,
      network,
      automation_id: automationId,
      job_status: currentStatus,
      queued: true,
      queue_tx: queueTx,
      dispatch,
    });
  } catch (error) {
    void sendHeartbeat(process.env.MORPHEUS_BETTERSTACK_CONTROL_AUTOMATION_FAILURE_URL || '', {
      route: '/api/internal/control-plane/automation-execute',
      network,
      automation_id: automationId,
      error: error instanceof Error ? error.message : String(error),
    });
    // SECURITY (S21): do not echo internal error detail to the caller; the
    // detail is retained in the heartbeat payload for operators.
    return Response.json(
      {
        error: 'automation dispatch failed',
      },
      { status: 500 }
    );
  }
}
