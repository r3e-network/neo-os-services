import {
  getServerSupabaseClient,
  loadProjectProviderConfig,
  resolveSupabaseNetwork,
} from './server-supabase';
import { trimString } from './strings';

function normalizeProviderId(value: unknown) {
  return trimString(value).toLowerCase();
}

function normalizeBoolean(value: unknown, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = trimString(value).toLowerCase();
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off', 'disabled'].includes(normalized)) return false;
  return fallback;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function parseJsonObjectParam(rawValue: string | null) {
  const value = trimString(rawValue);
  if (!value) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('provider_params must be valid JSON');
  }
  if (!isPlainObject(parsed)) {
    throw new Error('provider_params must be a JSON object');
  }
  return parsed;
}

function coerceObject(value: unknown) {
  if (isPlainObject(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (isPlainObject(parsed)) return parsed;
    } catch {
      return {};
    }
  }
  return {};
}

function describeLookupError(error: unknown) {
  if (error instanceof Error) return error.message;
  if (isPlainObject(error)) {
    const message = trimString(error.message || error.error || error.details || '');
    if (message) return message;
    try {
      return JSON.stringify(error);
    } catch {
      return 'provider config lookup failed';
    }
  }
  return trimString(error) || 'provider config lookup failed';
}

function resolveProviderPolicyPayload(
  payload: Record<string, unknown>,
  providerId: string,
  projectSlug: string,
  providerConfig: { config?: unknown }
) {
  const config = coerceObject(providerConfig.config);
  // Request policy may strengthen the stored policy, but can never weaken it.
  const requireAttestation =
    normalizeBoolean(config.require_attestation, false) ||
    normalizeBoolean(payload.require_attestation, false);
  const existingPolicyDecision = coerceObject(payload.policy_decision);

  return {
    ...payload,
    provider_enabled: true,
    require_attestation: requireAttestation,
    policy_decision: {
      ...existingPolicyDecision,
      allow: true,
      decision: 'allow',
      reason: 'allowed',
      scope: 'provider',
      scope_id: providerId,
      provider_enabled: true,
      require_attestation: requireAttestation,
      project_slug: projectSlug,
    },
  };
}

function resolveProviderPolicyNetwork(payloadNetwork: unknown, optionNetwork: unknown) {
  const rawRequestedNetwork = payloadNetwork ?? optionNetwork;
  if (
    rawRequestedNetwork !== undefined &&
    rawRequestedNetwork !== null &&
    rawRequestedNetwork !== '' &&
    typeof rawRequestedNetwork !== 'string'
  ) {
    throw new Error('network must be mainnet or testnet');
  }

  const requestedNetwork = trimString(rawRequestedNetwork);
  if (requestedNetwork && requestedNetwork !== 'mainnet' && requestedNetwork !== 'testnet') {
    throw new Error('network must be mainnet or testnet');
  }

  const deploymentNetwork = resolveSupabaseNetwork();
  if (requestedNetwork && requestedNetwork !== deploymentNetwork) {
    throw new Error(
      `provider policy network ${requestedNetwork} does not match deployment network ${deploymentNetwork}`
    );
  }
  return deploymentNetwork;
}

export async function resolveProviderAwarePayload<T extends Record<string, unknown>>(
  payload: T,
  options: {
    projectSlug?: string;
    fallbackProviderId?: string;
    network?: string;
  } = {}
) {
  const projectSlug = trimString(payload.project_slug || options.projectSlug || '');
  const providerId = normalizeProviderId(
    payload.provider || payload.provider_id || payload.source || options.fallbackProviderId || ''
  );

  if (!projectSlug || !providerId) {
    return {
      payload,
      providerConfig: null,
      projectSlug: projectSlug || null,
      providerId: providerId || null,
    };
  }

  const supabase = getServerSupabaseClient();
  if (!supabase) {
    throw new Error('provider policy storage is unavailable');
  }

  let providerConfig;
  try {
    const network = resolveProviderPolicyNetwork(payload.network, options.network);
    providerConfig = await loadProjectProviderConfig(supabase, projectSlug, providerId, network);
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message === 'network must be mainnet or testnet' ||
        error.message.startsWith('provider policy network '))
    ) {
      throw error;
    }
    console.warn('[neoos-provider-config] lookup failed; request denied', {
      projectSlug,
      providerId,
      error: describeLookupError(error),
    });
    throw new Error(`provider policy lookup failed for project ${projectSlug}`);
  }
  if (!providerConfig) {
    throw new Error(`provider ${providerId} is not configured for project ${projectSlug}`);
  }

  if (!providerConfig.enabled) {
    throw new Error(`provider ${providerId} is disabled for project ${projectSlug}`);
  }

  return {
    payload: resolveProviderPolicyPayload(
      {
        ...payload,
        provider: String(payload.provider || providerId),
        project_slug: projectSlug,
        provider_params: {
          ...coerceObject(providerConfig.config),
          ...coerceObject(payload.provider_params),
        },
      },
      providerId,
      projectSlug,
      providerConfig
    ),
    providerConfig,
    projectSlug,
    providerId,
  };
}
