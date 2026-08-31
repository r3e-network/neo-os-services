import { resolveSupabaseNetwork } from '@/lib/server-supabase';
import { authorizeProjectAccess } from '@/lib/registry-access';
import { recordOperationLog } from '@/lib/operation-logs';
import { badRequest } from '@/lib/api-helpers';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// Audit P2 fix: provider configs carry provider data-source API keys. The
// response may only echo a masked preview, and operation logs must never
// receive the full config blob (the generic key-name redactor in
// operation-logs.ts cannot be trusted to catch every provider-specific
// field name, e.g. `config.token` or `config.bearer`).
const MASKED_CONFIG_KEYS = /(key|token|secret|password|credential|bearer|authorization)/i;

function maskConfigForDisplay(config: Record<string, unknown>): Record<string, unknown> {
  const masked: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config)) {
    masked[k] =
      MASKED_CONFIG_KEYS.test(k) && typeof v === 'string' && v.length > 0 ? `***${v.slice(-4)}` : v;
  }
  return masked;
}

function summarizeConfigsForLog(configs: Array<Record<string, unknown>> = []) {
  return configs.map((entry) => ({
    provider_id: entry.provider_id,
    enabled: entry.enabled,
    config_keys: isPlainObject(entry.config) ? Object.keys(entry.config) : [],
  }));
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const projectSlug = (url.searchParams.get('project_slug') || 'morpheus').trim();
  const network = resolveSupabaseNetwork(url.searchParams.get('network'));

  // SECURITY (S12): the caller must be the project owner (JWT) or an operator
  // holding the provider_config admin key — a bare admin key no longer reads
  // every project's configuration with no project-level isolation.
  const access = await authorizeProjectAccess(request, projectSlug, network, 'provider_config');
  if (!access.ok) {
    await recordOperationLog({
      route: '/api/provider-configs',
      method: 'GET',
      category: 'provider_config',
      requestPayload: { project_slug: projectSlug, network },
      responsePayload: { error: 'unauthorized' },
      httpStatus: 401,
      error: 'unauthorized',
    });
    return access.response;
  }
  const { projectId, supabase } = access;

  const { data, error } = await supabase
    .from('morpheus_provider_configs')
    .select('provider_id, enabled, config, created_at, updated_at')
    .eq('project_id', projectId)
    .eq('network', network)
    .order('provider_id');

  if (error) {
    await recordOperationLog({
      route: '/api/provider-configs',
      method: 'GET',
      category: 'provider_config',
      requestPayload: { project_slug: projectSlug, network },
      responsePayload: { error: error.message },
      httpStatus: 500,
      error: error.message,
    });
    return badRequest(error.message, 500);
  }
  const configs = (data || []).map((entry: Record<string, unknown>) => ({
    ...entry,
    config: isPlainObject(entry.config) ? maskConfigForDisplay(entry.config) : entry.config,
  }));
  const body = { project_slug: projectSlug, network, configs };
  await recordOperationLog({
    route: '/api/provider-configs',
    method: 'GET',
    category: 'provider_config',
    requestPayload: { project_slug: projectSlug, network },
    // Never log the config blobs — only which providers are configured.
    responsePayload: {
      project_slug: projectSlug,
      network,
      configs: summarizeConfigsForLog(configs),
    },
    httpStatus: 200,
  });
  return Response.json(body);
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  if (!isPlainObject(body)) {
    await recordOperationLog({
      route: '/api/provider-configs',
      method: 'POST',
      category: 'provider_config',
      requestPayload: {
        ...body,
        config: isPlainObject(config)
          ? summarizeConfigsForLog([{ provider_id: providerId, enabled, config }])
          : body.config,
      },
      responsePayload: { error: 'invalid JSON body' },
      httpStatus: 400,
      error: 'invalid JSON body',
    });
    return badRequest('invalid JSON body');
  }

  const projectSlug = String(body.project_slug || 'morpheus').trim();
  const network = resolveSupabaseNetwork(String(body.network || body.morpheus_network || ''));

  // SECURITY (S12): project owner (JWT) or operator (provider_config admin key).
  const access = await authorizeProjectAccess(request, projectSlug, network, 'provider_config');
  if (!access.ok) {
    await recordOperationLog({
      route: '/api/provider-configs',
      method: 'POST',
      category: 'provider_config',
      requestPayload: { project_slug: projectSlug, network },
      responsePayload: { error: 'unauthorized' },
      httpStatus: 401,
      error: 'unauthorized',
    });
    return access.response;
  }
  const { projectId, supabase } = access;

  const providerId = String(body.provider_id || '').trim();
  const enabled = body.enabled !== false;
  const config = body.config === undefined ? {} : body.config;
  if (!projectSlug) {
    await recordOperationLog({
      route: '/api/provider-configs',
      method: 'POST',
      category: 'provider_config',
      requestPayload: {
        ...body,
        config: isPlainObject(config)
          ? summarizeConfigsForLog([{ provider_id: providerId, enabled, config }])
          : body.config,
      },
      responsePayload: { error: 'project_slug required' },
      httpStatus: 400,
      error: 'project_slug required',
    });
    return badRequest('project_slug required');
  }
  if (!providerId) {
    await recordOperationLog({
      route: '/api/provider-configs',
      method: 'POST',
      category: 'provider_config',
      requestPayload: {
        ...body,
        config: isPlainObject(config)
          ? summarizeConfigsForLog([{ provider_id: providerId, enabled, config }])
          : body.config,
      },
      responsePayload: { error: 'provider_id required' },
      httpStatus: 400,
      error: 'provider_id required',
    });
    return badRequest('provider_id required');
  }
  if (!isPlainObject(config)) {
    await recordOperationLog({
      route: '/api/provider-configs',
      method: 'POST',
      category: 'provider_config',
      requestPayload: {
        ...body,
        config: isPlainObject(config)
          ? summarizeConfigsForLog([{ provider_id: providerId, enabled, config }])
          : body.config,
      },
      responsePayload: { error: 'config must be a JSON object' },
      httpStatus: 400,
      error: 'config must be a JSON object',
    });
    return badRequest('config must be a JSON object');
  }

  const payload = {
    project_id: projectId,
    network,
    provider_id: providerId,
    enabled,
    config,
    updated_at: new Date().toISOString(),
  };

  const providerConfigs = supabase.from('morpheus_provider_configs') as any;
  const { data, error } = await providerConfigs
    .upsert(payload, { onConflict: 'project_id,provider_id' })
    .select('provider_id, enabled, config, updated_at')
    .single();

  if (error) {
    await recordOperationLog({
      route: '/api/provider-configs',
      method: 'POST',
      category: 'provider_config',
      requestPayload: {
        ...body,
        config: isPlainObject(config)
          ? summarizeConfigsForLog([{ provider_id: providerId, enabled, config }])
          : body.config,
      },
      responsePayload: { error: error.message },
      httpStatus: 500,
      error: error.message,
    });
    return badRequest(error.message, 500);
  }
  const responseConfig =
    data && isPlainObject((data as Record<string, unknown>).config)
      ? {
          ...(data as Record<string, unknown>),
          config: maskConfigForDisplay(
            (data as Record<string, unknown>).config as Record<string, unknown>
          ),
        }
      : data;
  const responseBody = { ok: true, network, config: responseConfig };
  await recordOperationLog({
    route: '/api/provider-configs',
    method: 'POST',
    category: 'provider_config',
    requestPayload: {
      ...body,
      config: isPlainObject(config)
        ? summarizeConfigsForLog([{ provider_id: providerId, enabled, config }])
        : body.config,
    },
    responsePayload: responseBody,
    httpStatus: 200,
  });
  return Response.json(responseBody);
}

export async function DELETE(request: Request) {
  const url = new URL(request.url);
  const projectSlug = (url.searchParams.get('project_slug') || 'morpheus').trim();
  const network = resolveSupabaseNetwork(url.searchParams.get('network'));
  const providerId = (url.searchParams.get('provider_id') || '').trim();

  // SECURITY (S12): project owner (JWT) or operator (provider_config admin key).
  const access = await authorizeProjectAccess(request, projectSlug, network, 'provider_config');
  if (!access.ok) {
    await recordOperationLog({
      route: '/api/provider-configs',
      method: 'DELETE',
      category: 'provider_config',
      requestPayload: { project_slug: projectSlug, provider_id: providerId, network },
      responsePayload: { error: 'unauthorized' },
      httpStatus: 401,
      error: 'unauthorized',
    });
    return access.response;
  }
  const { projectId, supabase } = access;

  if (!providerId) {
    await recordOperationLog({
      route: '/api/provider-configs',
      method: 'DELETE',
      category: 'provider_config',
      requestPayload: { project_slug: projectSlug, provider_id: providerId, network },
      responsePayload: { error: 'provider_id required' },
      httpStatus: 400,
      error: 'provider_id required',
    });
    return badRequest('provider_id required');
  }

  const { error } = await supabase
    .from('morpheus_provider_configs')
    .delete()
    .eq('project_id', projectId)
    .eq('network', network)
    .eq('provider_id', providerId);

  if (error) {
    await recordOperationLog({
      route: '/api/provider-configs',
      method: 'DELETE',
      category: 'provider_config',
      requestPayload: { project_slug: projectSlug, provider_id: providerId, network },
      responsePayload: { error: error.message },
      httpStatus: 500,
      error: error.message,
    });
    return badRequest(error.message, 500);
  }
  await recordOperationLog({
    route: '/api/provider-configs',
    method: 'DELETE',
    category: 'provider_config',
    requestPayload: { project_slug: projectSlug, provider_id: providerId, network },
    responsePayload: { ok: true, network },
    httpStatus: 200,
  });
  return Response.json({ ok: true, network });
}
