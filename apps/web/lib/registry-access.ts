import { apiError } from './api-helpers';
import { enforceRateLimit, type RateLimitOptions } from './rate-limit';
import {
  getServerSupabaseClient,
  isAuthorizedAdminRequest,
  resolveProjectIdBySlug,
  type MorpheusNetwork,
  type ServerSupabaseClient,
} from './server-supabase';
import type { SecretRegistryRow } from './secret-registry';
import { resolveOwnedProjectId, resolveRequestUser, unauthorized } from './user-auth';
import type { WorkflowRegistryRow } from './workflow-registry';

/**
 * Shared developer-facing access layer for the workflow/secret registry routes.
 *
 * Centralizes the repeated authn/authz + ownership-checked data-access pattern
 * so every registry route enforces the same behavior (401 for missing JWT,
 * 404 for missing/non-owned project or row, uniform 500 for missing Supabase)
 * from one place instead of re-implementing it per route.
 */

export const WORKFLOW_REGISTRY_SELECT =
  'id,project_id,workflow_id,name,version,status,trigger_kind,trigger_config,handler_source,target_chain,network,metadata,created_at,updated_at';

/** List projection: never exposes ciphertext. */
export const SECRET_LIST_SELECT =
  'id,project_id,name,target_chain,encryption_algorithm,key_version,metadata,network,expires_at,created_at,updated_at';

/** Full projection for PATCH/DELETE ownership checks; ciphertext is stripped on response. */
export const SECRET_FULL_SELECT = `${SECRET_LIST_SELECT},ciphertext`;

export type OwnershipResult =
  | { ok: true; projectId: string; userId: string; supabase: ServerSupabaseClient }
  | { ok: false; response: Response };

export type UserResult =
  | { ok: true; userId: string; supabase: ServerSupabaseClient }
  | { ok: false; response: Response };

/** Authenticate the end user (Supabase JWT) and hand back the service client. */
export async function requireUser(
  request: Request,
  rateLimitOptions?: RateLimitOptions
): Promise<UserResult> {
  const user = await resolveRequestUser(request);
  if (!user) return { ok: false, response: unauthorized() };

  const supabase = getServerSupabaseClient();
  if (!supabase) {
    return {
      ok: false,
      response: apiError(
        'Supabase server client is not configured',
        'SUPABASE_NOT_CONFIGURED',
        500
      ),
    };
  }

  // Per-user budget is enforced only after the JWT is validated, so the key is a
  // trusted identifier (never an unvalidated client-supplied token).
  if (rateLimitOptions) {
    const limited = await enforceRateLimit(`user:${user.id}`, rateLimitOptions);
    if (limited) return { ok: false, response: limited };
  }

  return { ok: true, userId: user.id, supabase };
}

/** Resolve the authenticated user and verify they own the project, in one gate. */
export async function requireProjectOwner(
  request: Request,
  projectSlug: string,
  network: MorpheusNetwork,
  rateLimitOptions?: RateLimitOptions
): Promise<OwnershipResult> {
  const user = await requireUser(request, rateLimitOptions);
  if (!user.ok) return user;

  const projectId = await resolveOwnedProjectId(user.supabase, user.userId, projectSlug, network);
  if (!projectId) {
    return { ok: false, response: apiError('project not found', 'PROJECT_NOT_FOUND', 404) };
  }
  return { ok: true, projectId, userId: user.userId, supabase: user.supabase };
}

export type ProjectAccessResult =
  | {
      ok: true;
      projectId: string;
      supabase: ServerSupabaseClient;
      via: 'owner' | 'admin';
    }
  | { ok: false; response: Response };

/**
 * SECURITY (S12): project-scoped access that accepts EITHER an operator with
 * the configured admin key (any project) OR the project's owner via Supabase
 * JWT (developer path). A bare `provider_config` admin key previously granted
 * read/write of every project's provider configuration (including data-source
 * API keys in plaintext) with no project-level isolation; now the developer
 * path is owner-scoped and only the operator key crosses projects.
 */
export async function authorizeProjectAccess(
  request: Request,
  projectSlug: string,
  network: MorpheusNetwork,
  adminScope: 'provider_config' | 'relayer_ops' = 'provider_config',
  rateLimitOptions?: RateLimitOptions
): Promise<ProjectAccessResult> {
  const supabase = getServerSupabaseClient();
  if (!supabase) {
    return {
      ok: false,
      response: apiError(
        'Supabase server client is not configured',
        'SUPABASE_NOT_CONFIGURED',
        500
      ),
    };
  }

  if (isAuthorizedAdminRequest(request, adminScope)) {
    const projectId = await resolveProjectIdBySlug(supabase, projectSlug, network);
    if (!projectId) {
      return { ok: false, response: apiError('project not found', 'PROJECT_NOT_FOUND', 404) };
    }
    return { ok: true, projectId, supabase, via: 'admin' };
  }

  const user = await requireUser(request, rateLimitOptions);
  if (!user.ok) return user;
  const projectId = await resolveOwnedProjectId(user.supabase, user.userId, projectSlug, network);
  if (!projectId) {
    return { ok: false, response: apiError('project not found', 'PROJECT_NOT_FOUND', 404) };
  }
  return { ok: true, projectId, supabase, via: 'owner' };
}

/** Load a workflow registry row and verify the user owns its project (null = 404). */
export async function resolveOwnedWorkflowRow(
  supabase: ServerSupabaseClient,
  userId: string,
  workflowId: string
): Promise<WorkflowRegistryRow | null> {
  const { data: row, error } = await supabase
    .from('morpheus_workflow_registry')
    .select(WORKFLOW_REGISTRY_SELECT)
    .eq('workflow_id', workflowId)
    .maybeSingle();
  if (error || !row) return null;

  const { data: project } = await supabase
    .from('morpheus_projects')
    .select('id')
    .eq('id', row.project_id)
    .eq('owner_user_id', userId)
    .maybeSingle();
  if (!project) return null;

  return row as WorkflowRegistryRow;
}

/** Load a secret row and verify the user owns its project (null = 404). */
export async function resolveOwnedSecretRow(
  supabase: ServerSupabaseClient,
  userId: string,
  secretId: string
): Promise<SecretRegistryRow | null> {
  const { data: row, error } = await supabase
    .from('morpheus_encrypted_secrets')
    .select(SECRET_FULL_SELECT)
    .eq('id', secretId)
    .maybeSingle();
  if (error || !row) return null;
  // Orphan rows (no owning project) are never owner-accessible.
  if (!row.project_id) return null;

  const { data: project } = await supabase
    .from('morpheus_projects')
    .select('id')
    .eq('id', row.project_id)
    .eq('owner_user_id', userId)
    .maybeSingle();
  if (!project) return null;

  return row as SecretRegistryRow;
}
