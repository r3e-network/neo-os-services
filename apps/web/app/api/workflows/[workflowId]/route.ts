import { apiError } from '@/lib/api-helpers';
import { createRateLimitedHandler, type RateLimitOptions } from '@/lib/rate-limit';
import {
  requireUser,
  resolveOwnedWorkflowRow,
  WORKFLOW_REGISTRY_SELECT,
} from '@/lib/registry-access';
import { trimString } from '@/lib/strings';
import type { Database } from '@/lib/supabase-types';
import {
  isAllowedStatusTransition,
  isWorkflowStatus,
  toPublicWorkflowRecord,
  validateHandlerSource,
  validateTriggerConfig,
  type WorkflowRegistryRow,
} from '@/lib/workflow-registry';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const REGISTRY_WRITE_LIMIT: RateLimitOptions = {
  scope: 'workflow_registry_write',
  maxRequests: 60,
  windowMs: 60_000,
};

function assertMutableWorkflowId(workflowId: string): Response | null {
  if (!workflowId) return apiError('workflow id is required', 'INVALID_WORKFLOW_ID', 400);
  if (!workflowId.startsWith('user.')) {
    return apiError(
      'platform workflows cannot be modified through the registry',
      'PLATFORM_WORKFLOW_IMMUTABLE',
      403
    );
  }
  return null;
}

async function patchWorkflow(request: Request, workflowId: string) {
  const rejection = assertMutableWorkflowId(workflowId);
  if (rejection) return rejection;

  const auth = await requireUser(request, REGISTRY_WRITE_LIMIT);
  if (!auth.ok) return auth.response;
  const { userId, supabase } = auth;

  const row = await resolveOwnedWorkflowRow(supabase, userId, workflowId);
  if (!row) return apiError('workflow not found', 'WORKFLOW_NOT_FOUND', 404);

  const body = await request.json().catch(() => ({}));
  const patch: Database['public']['Tables']['morpheus_workflow_registry']['Update'] = {};

  if (body?.trigger_config !== undefined) {
    const triggerConfigError = validateTriggerConfig(row.trigger_kind, body.trigger_config);
    if (triggerConfigError) {
      return apiError(triggerConfigError, 'INVALID_TRIGGER_CONFIG', 400);
    }
    patch.trigger_config = body.trigger_config;
  }

  if (body?.handler_source !== undefined) {
    const handlerError = validateHandlerSource(body.handler_source);
    if (handlerError) return apiError(handlerError, 'INVALID_HANDLER_SOURCE', 400);
    patch.handler_source = body.handler_source;
  }

  if (body?.status !== undefined) {
    const nextStatus = trimString(body.status);
    if (!isWorkflowStatus(nextStatus)) {
      return apiError(
        'status must be one of: draft, active, paused, deleted',
        'INVALID_STATUS',
        400
      );
    }
    if (!isAllowedStatusTransition(row.status, nextStatus)) {
      return apiError(
        `cannot transition workflow from ${row.status} to ${nextStatus}`,
        'INVALID_STATUS_TRANSITION',
        400
      );
    }
    patch.status = nextStatus;
  }

  if (Object.keys(patch).length === 0) {
    return apiError('no updatable fields provided', 'EMPTY_PATCH', 400);
  }

  // Content/state changes bump the version so consumers can detect drift.
  patch.version = row.version + 1;
  patch.updated_at = new Date().toISOString();

  const registry = supabase.from('morpheus_workflow_registry');
  const { data, error } = await registry
    .update(patch)
    .eq('workflow_id', workflowId)
    .select(WORKFLOW_REGISTRY_SELECT)
    .single();
  if (error) return apiError(error.message, 'WORKFLOW_UPDATE_FAILED', 500);

  return Response.json(toPublicWorkflowRecord(data as WorkflowRegistryRow));
}

async function deleteWorkflow(request: Request, workflowId: string) {
  const rejection = assertMutableWorkflowId(workflowId);
  if (rejection) return rejection;

  const auth = await requireUser(request, REGISTRY_WRITE_LIMIT);
  if (!auth.ok) return auth.response;
  const { userId, supabase } = auth;

  const row = await resolveOwnedWorkflowRow(supabase, userId, workflowId);
  if (!row) return apiError('workflow not found', 'WORKFLOW_NOT_FOUND', 404);

  // Soft delete: the row is retained for audit/traceability and excluded
  // from listings via `status != 'deleted'`.
  const registry = supabase.from('morpheus_workflow_registry');
  const { error } = await registry
    .update({ status: 'deleted', updated_at: new Date().toISOString() })
    .eq('workflow_id', workflowId);
  if (error) return apiError(error.message, 'WORKFLOW_DELETE_FAILED', 500);

  return Response.json({ workflow_id: workflowId, status: 'deleted' });
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ workflowId: string }> }
) {
  const { workflowId: rawWorkflowId } = await context.params;
  const workflowId = trimString(rawWorkflowId);
  // Rate-limit state is module-level/shared, so per-request wrappers keep
  // consistent limits while letting us close over the path parameter.
  const limited = createRateLimitedHandler(
    async (req: Request) => patchWorkflow(req, workflowId),
    REGISTRY_WRITE_LIMIT
  );
  return limited(request);
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ workflowId: string }> }
) {
  const { workflowId: rawWorkflowId } = await context.params;
  const workflowId = trimString(rawWorkflowId);
  const limited = createRateLimitedHandler(
    async (req: Request) => deleteWorkflow(req, workflowId),
    REGISTRY_WRITE_LIMIT
  );
  return limited(request);
}
