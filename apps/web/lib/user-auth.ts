import type { MorpheusNetwork, ServerSupabaseClient } from './server-supabase';
import { getServerSupabaseClient } from './server-supabase';

/**
 * End-user authentication for developer-facing API routes (workflow registry).
 *
 * Admin/operator routes keep using `isAuthorizedAdminRequest` /
 * `isAuthorizedControlPlaneRequest`; developer routes accept a Supabase user JWT
 * in `Authorization: Bearer <jwt>` and authorize through project ownership
 * (`morpheus_projects.owner_user_id`), matching the database RLS policies.
 */

export type RequestUser = {
  id: string;
  email: string | null;
};

export async function resolveRequestUser(request: Request): Promise<RequestUser | null> {
  const header = request.headers.get('authorization') || '';
  const token = header.trim().startsWith('Bearer ') ? header.trim().slice(7).trim() : '';
  if (!token) return null;

  const supabase = getServerSupabaseClient();
  if (!supabase) return null;

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return null;
  return { id: data.user.id, email: data.user.email ?? null };
}

/**
 * Resolve a project id only when the authenticated user owns it.
 * Returns null for missing projects or projects owned by someone else,
 * so callers can return a uniform 404 without leaking ownership.
 */
export async function resolveOwnedProjectId(
  supabase: ServerSupabaseClient,
  userId: string,
  projectSlug: string,
  network: MorpheusNetwork
): Promise<string | null> {
  const { data, error } = await supabase
    .from('morpheus_projects')
    .select('id')
    .eq('slug', projectSlug)
    .eq('network', network)
    .eq('owner_user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return data?.id ?? null;
}

export function unauthorized() {
  return Response.json(
    { error: 'unauthorized', error_code: 'UNAUTHORIZED' },
    { status: 401, headers: { 'cache-control': 'no-store' } }
  );
}
