import { apiError } from '@/lib/api-helpers';
import { publicApiHandler } from '@/lib/public-api-handler';
import { createRateLimitedHandler } from '@/lib/rate-limit';
import { requireProjectOwner, WORKFLOW_REGISTRY_SELECT } from '@/lib/registry-access';
import { resolveSupabaseNetwork } from '@/lib/server-supabase';
import { trimString } from '@/lib/strings';
import { emptyQuerySchema } from '@/lib/validators';
import {
  buildUserWorkflowId,
  isWorkflowTriggerKind,
  sanitizeIdSegment,
  toPublicWorkflowRecord,
  validateHandlerSource,
  validateTriggerConfig,
  type WorkflowRegistryRow,
} from '@/lib/workflow-registry';
import { getPublicWorkflowCatalog } from '@/lib/workflow-runtime';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

function validateQuery(request: Request) {
  const url = new URL(request.url);
  const result = emptyQuerySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!result.success) {
    return {
      success: false as const,
      response: Response.json({ error: 'invalid query parameters' }, { status: 400 }),
    };
  }
  return { success: true as const };
}

export const GET = publicApiHandler(async () => Response.json(getPublicWorkflowCatalog()), {
  rateLimit: { scope: 'workflows', maxRequests: 60, windowMs: 60_000 },
  validate: validateQuery,
});

export const POST = createRateLimitedHandler(
  async (request: Request) => {
    const body = await request.json().catch(() => ({}));
    const projectSlug = trimString(body?.project_slug || '');
    const name = trimString(body?.name || '');
    const triggerKind = trimString(body?.trigger_kind || '');
    const targetChain = trimString(body?.target_chain || 'neo_n3');
    const network = resolveSupabaseNetwork(String(body?.network || ''));
    const triggerConfig = body?.trigger_config ?? {};
    const handlerSource = body?.handler_source ?? null;
    if (
      body?.metadata !== undefined &&
      (typeof body.metadata !== 'object' || body.metadata === null || Array.isArray(body.metadata))
    ) {
      return apiError('metadata must be a JSON object', 'INVALID_METADATA', 400);
    }
    const metadata = body?.metadata ?? {};

    if (!sanitizeIdSegment(projectSlug)) {
      return apiError(
        'project_slug must contain at least one alphanumeric character',
        'MISSING_PROJECT_SLUG',
        400
      );
    }
    if (!sanitizeIdSegment(name)) {
      return apiError('name must contain at least one alphanumeric character', 'INVALID_NAME', 400);
    }
    if (name.length > 96) {
      return apiError('name must be <= 96 chars', 'INVALID_NAME', 400);
    }
    if (!isWorkflowTriggerKind(triggerKind)) {
      return apiError(
        'trigger_kind must be one of: request, cron, http, chain_event',
        'INVALID_TRIGGER_KIND',
        400
      );
    }
    if (targetChain !== 'neo_n3') {
      return apiError('target_chain must be neo_n3', 'UNSUPPORTED_CHAIN', 400);
    }
    const triggerConfigError = validateTriggerConfig(triggerKind, triggerConfig);
    if (triggerConfigError) return apiError(triggerConfigError, 'INVALID_TRIGGER_CONFIG', 400);
    const handlerError = validateHandlerSource(handlerSource);
    if (handlerError) return apiError(handlerError, 'INVALID_HANDLER_SOURCE', 400);

    const owned = await requireProjectOwner(request, projectSlug, network, {
      scope: 'workflow_registry_write',
      maxRequests: 60,
      windowMs: 60_000,
    });
    if (!owned.ok) return owned.response;
    const { projectId, supabase } = owned;

    const workflowId = buildUserWorkflowId(projectSlug, name, network);
    const row = {
      project_id: projectId,
      workflow_id: workflowId,
      name,
      version: 1,
      status: 'draft',
      trigger_kind: triggerKind,
      trigger_config: triggerConfig,
      handler_source: handlerSource,
      target_chain: targetChain,
      network,
      metadata: { ...metadata, source: 'api.workflows.post' },
    };

    const registry = supabase.from('morpheus_workflow_registry');
    const { data, error } = await registry.insert(row).select(WORKFLOW_REGISTRY_SELECT).single();
    if (error) {
      if (error.code === '23505') {
        return apiError(`workflow "${workflowId}" already exists`, 'WORKFLOW_ALREADY_EXISTS', 409);
      }
      return apiError(error.message, 'WORKFLOW_CREATE_FAILED', 500);
    }

    return Response.json(toPublicWorkflowRecord(data as WorkflowRegistryRow), { status: 201 });
  },
  { scope: 'workflow_registry_write', maxRequests: 60, windowMs: 60_000 }
);
