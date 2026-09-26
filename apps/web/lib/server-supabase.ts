import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { timingSafeCompare } from '@r3e-network/neo-os-services-shared/utils';
import { Database } from './supabase-types';
import { getCache, setCache, __resetMemoryCaches, __resetRedisClient } from './upstash-cache';

export type ServerSupabaseClient = SupabaseClient<Database>;
export type MorpheusNetwork = 'mainnet' | 'testnet';

export type ProjectProviderConfigRecord = {
  provider_id: string;
  enabled: boolean;
  config: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
};

const LOOKUP_CACHE_TTL_MS = 30_000;
const PROJECT_ID_CACHE_NS = 'morpheus:project-id';
const PROVIDER_CONFIG_CACHE_NS = 'morpheus:provider-config';

let serverSupabaseClientCache: ServerSupabaseClient | null | undefined;
const projectIdInFlight = new Map<string, Promise<string | null>>();
const providerConfigInFlight = new Map<string, Promise<ProjectProviderConfigRecord | null>>();

function resolveLookupCacheTtlMs() {
  const configured = Number(process.env.MORPHEUS_WEB_LOOKUP_CACHE_TTL_MS || '');
  if (!Number.isFinite(configured)) return LOOKUP_CACHE_TTL_MS;
  return Math.max(Math.trunc(configured), 0);
}

function resolveLookupCacheTtlSeconds(): number {
  return Math.ceil(resolveLookupCacheTtlMs() / 1000);
}

export function __resetServerSupabaseCachesForTests() {
  serverSupabaseClientCache = undefined;
  projectIdInFlight.clear();
  providerConfigInFlight.clear();
  __resetMemoryCaches();
  __resetRedisClient();
}

function resolveAdminKeys(
  scope:
    | 'provider_config'
    | 'relayer_ops'
    | 'sign_payload'
    | 'relay_transaction' = 'provider_config'
) {
  const values =
    scope === 'provider_config'
      ? [process.env.MORPHEUS_PROVIDER_CONFIG_API_KEY, process.env.ADMIN_CONSOLE_API_KEY]
      : scope === 'relayer_ops'
        ? [
            process.env.MORPHEUS_RELAYER_ADMIN_API_KEY,
            process.env.MORPHEUS_OPERATOR_API_KEY,
            process.env.ADMIN_CONSOLE_API_KEY,
          ]
        : scope === 'sign_payload'
          ? [
              process.env.MORPHEUS_SIGNING_ADMIN_API_KEY,
              process.env.MORPHEUS_OPERATOR_API_KEY,
              process.env.ADMIN_CONSOLE_API_KEY,
            ]
          : [
              process.env.MORPHEUS_RELAY_ADMIN_API_KEY,
              process.env.MORPHEUS_OPERATOR_API_KEY,
              process.env.ADMIN_CONSOLE_API_KEY,
            ];
  return [...new Set(values.map((value) => (value || '').trim()).filter(Boolean))];
}

export function isAuthorizedAdminRequest(
  request: Request,
  scope:
    | 'provider_config'
    | 'relayer_ops'
    | 'sign_payload'
    | 'relay_transaction' = 'provider_config'
) {
  const configured = resolveAdminKeys(scope);
  if (configured.length === 0) return false;

  const headerKey = (request.headers.get('x-admin-api-key') || '').trim();
  const bearer = (request.headers.get('authorization') || '').trim();
  // Constant-time comparison against every configured key to avoid leaking key
  // material through a comparison-timing side-channel. `timingSafeCompare`
  // short-circuits only on length mismatch (length is not secret here), and the
  // loop deliberately checks all candidates without early-out on first match.
  let authorized = false;
  for (const value of configured) {
    if (timingSafeCompare(headerKey, value)) authorized = true;
    if (timingSafeCompare(bearer, `Bearer ${value}`)) authorized = true;
  }
  return authorized;
}

export function getServerSupabaseClient() {
  if (serverSupabaseClientCache !== undefined) {
    return serverSupabaseClientCache;
  }

  const url =
    process.env.SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    process.env.morpheus_SUPABASE_URL ||
    '';
  const serviceKey =
    process.env.SUPABASE_SECRET_KEY ||
    process.env.morpheus_SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.morpheus_SUPABASE_SERVICE_ROLE_KEY ||
    '';
  if (!url || !serviceKey) {
    serverSupabaseClientCache = null;
    return serverSupabaseClientCache;
  }
  serverSupabaseClientCache = createClient(url, serviceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
  return serverSupabaseClientCache;
}

export function resolveSupabaseNetwork(value?: string | null): MorpheusNetwork {
  const raw = String(
    value || process.env.MORPHEUS_NETWORK || process.env.NEXT_PUBLIC_MORPHEUS_NETWORK || 'mainnet'
  ).trim();
  if (raw === 'mainnet' || raw === 'testnet') return raw;
  throw new Error(`unsupported Neo network: ${raw}`);
}

export async function resolveProjectIdBySlug(
  supabase: ServerSupabaseClient,
  projectSlug: string,
  network: MorpheusNetwork = resolveSupabaseNetwork()
) {
  const cacheKey = `${network}:${projectSlug}`;
  const cached = await getCache<string | null>(cacheKey, PROJECT_ID_CACHE_NS);
  if (cached !== undefined) return cached;

  const existing = projectIdInFlight.get(cacheKey);
  if (existing) return existing;

  const request = Promise.resolve(
    supabase
      .from('morpheus_projects')
      .select('id, slug, network')
      .eq('slug', projectSlug)
      .eq('network', network)
      .maybeSingle()
  )
    .then(async ({ data, error }) => {
      if (error) throw error;
      const value = data?.id || null;
      await setCache(cacheKey, value, resolveLookupCacheTtlSeconds(), PROJECT_ID_CACHE_NS);
      return value;
    })
    .finally(() => {
      projectIdInFlight.delete(cacheKey);
    });

  projectIdInFlight.set(cacheKey, request);
  return request;
}

export async function loadProjectProviderConfig(
  supabase: ServerSupabaseClient,
  projectSlug: string,
  providerId: string,
  network: MorpheusNetwork = resolveSupabaseNetwork()
): Promise<ProjectProviderConfigRecord | null> {
  const cacheKey = `${network}:${projectSlug}:${providerId}`;
  const cached = await getCache<ProjectProviderConfigRecord | null>(
    cacheKey,
    PROVIDER_CONFIG_CACHE_NS
  );
  if (cached !== undefined) return cached;

  const existing = providerConfigInFlight.get(cacheKey);
  if (existing) return existing;

  const request = (async () => {
    const projectId = await resolveProjectIdBySlug(supabase, projectSlug, network);
    if (!projectId) {
      await setCache(cacheKey, null, resolveLookupCacheTtlSeconds(), PROVIDER_CONFIG_CACHE_NS);
      return null;
    }

    const { data, error } = await supabase
      .from('morpheus_provider_configs')
      .select('provider_id, enabled, config, created_at, updated_at')
      .eq('project_id', projectId)
      .eq('network', network)
      .eq('provider_id', providerId)
      .maybeSingle();

    if (error) throw error;
    const value = (data as ProjectProviderConfigRecord | null) ?? null;
    await setCache(cacheKey, value, resolveLookupCacheTtlSeconds(), PROVIDER_CONFIG_CACHE_NS);
    return value;
  })().finally(() => {
    providerConfigInFlight.delete(cacheKey);
  });

  providerConfigInFlight.set(cacheKey, request);
  return request;
}
