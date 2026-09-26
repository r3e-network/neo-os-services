import { apiError } from '@/lib/api-helpers';
import { createRateLimitedHandler } from '@/lib/rate-limit';
import { requireProjectOwner, WORKFLOW_REGISTRY_SELECT } from '@/lib/registry-access';
import { resolveRequestNetwork } from '@/lib/request-network';
import { trimString } from '@/lib/strings';
import { toPublicWorkflowRecord, type WorkflowRegistryRow } from '@/lib/workflow-registry';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * Developer-owned workflow listing (self-serve registry, P0-1).
 *
 * Kept on its own route so `GET /api/workflows` keeps its existing
 * runtime-token contract for the public platform catalog unchanged.
 * This route authenticates the end user via a Supabase user JWT and
 * authorizes through project ownership.
 */
export const GET = createRateLimitedHandler(
  async (request: Request) => {
    const url = new URL(request.url);
    const projectSlug = trimString(url.searchParams.get('project_slug') || '');
    if (!projectSlug) {
      return apiError('project_slug is required', 'MISSING_PROJECT_SLUG', 400);
    }

    const requestedNetwork = resolveRequestNetwork(url.searchParams.get('network') || '');
    if (!requestedNetwork.ok) return requestedNetwork.response;
    const network = requestedNetwork.network;
    const owned = await requireProjectOwner(request, projectSlug, network, {
      scope: 'workflow_registry_read',
      maxRequests: 60,
      windowMs: 60_000,
    });
    if (!owned.ok) return owned.response;
    const { projectId, supabase } = owned;

    const registry = supabase.from('morpheus_workflow_registry');
    const { data, error } = await registry
      .select(WORKFLOW_REGISTRY_SELECT)
      .eq('project_id', projectId)
      .neq('status', 'deleted')
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) return apiError(error.message, 'WORKFLOW_LIST_FAILED', 500);

    const rows = (data || []) as WorkflowRegistryRow[];
    return Response.json({
      project_slug: projectSlug,
      network,
      workflows: rows.map(toPublicWorkflowRecord),
    });
  },
  { scope: 'workflow_registry_read', maxRequests: 60, windowMs: 60_000 }
);
