import {
  getSelectedNetwork,
  getSelectedNetworkKey,
  normalizeNetworkKey,
  type NetworkKey,
} from './networks';
import { trimString } from '@r3e-network/neo-os-services-shared/utils';

// The attested in-TEE enclave server exposes /health publicly (unauthenticated).
// This is the real liveness source for the public status surface — NOT the retired
// runtime proxy (oracle.meshmini.app, which serves the emergency stub).
const DEFAULT_BOX_HEALTH_URL = 'https://runtime.meshmini.app/health';

export function resolveRuntimeRequestNetwork(request: Request): NetworkKey {
  const url = new URL(request.url);
  return (
    normalizeNetworkKey(url.searchParams.get('network')) ||
    normalizeNetworkKey(request.headers.get('x-morpheus-network')) ||
    getSelectedNetworkKey()
  );
}

export function resolveBoxHealthUrl(networkOverride?: string | null): string {
  const networkKey = getSelectedNetworkKey(networkOverride);
  const suffix = networkKey === 'mainnet' ? 'MAINNET' : 'TESTNET';
  const scoped = trimString(
    process.env[`MORPHEUS_BOX_HEALTH_URL_${suffix}` as keyof NodeJS.ProcessEnv]
  );
  const configured = scoped || trimString(process.env.MORPHEUS_BOX_HEALTH_URL);
  return (configured || DEFAULT_BOX_HEALTH_URL).replaceAll('{network}', networkKey);
}

export interface RuntimeProbe {
  ok: boolean;
  status: number;
  body: unknown;
}

export async function fetchBoxHealth(networkOverride?: string | null): Promise<RuntimeProbe> {
  const networkKey = getSelectedNetworkKey(networkOverride);
  try {
    const response = await fetch(resolveBoxHealthUrl(networkKey), {
      method: 'GET',
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    const text = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = text || null;
    }

    const reportedNetwork =
      body && typeof body === 'object' && !Array.isArray(body)
        ? normalizeNetworkKey((body as Record<string, unknown>).network as string | null)
        : null;
    if (reportedNetwork && reportedNetwork !== networkKey) {
      return {
        ok: false,
        status: 503,
        body: {
          ...(body as Record<string, unknown>),
          status: 'degraded',
          ready: false,
          error: 'runtime_network_mismatch',
          requested_network: networkKey,
          actual_network: reportedNetwork,
        },
      };
    }
    return { ok: response.ok, status: response.status, body };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      body: { error: error instanceof Error ? error.message : String(error) },
    };
  }
}

// The box does not serve /info publicly (nginx 404s it), and the dstack
// app_id/compose_hash are not on-chain. Serve the CONFIGURED enclave identity so the
// status surface stays populated. This is configured metadata, not a live attestation
// read (live attestation verification still requires the enclave directly).
export function buildStaticRuntimeInfo(version: string | null, networkOverride?: string | null) {
  const selected = getSelectedNetwork(networkOverride) as { nitro?: Record<string, unknown> };
  const nitro = selected.nitro || {};
  const appId = trimString(nitro.cvm_id) || null;
  return {
    runtime: {
      status: 'operational',
      mode: 'nitro-enclave',
      network: getSelectedNetworkKey(networkOverride),
      tee_attestation_available: true,
      origin: 'aws-nitro',
    },
    app_id: appId,
    cvm_name: trimString(nitro.cvm_name) || null,
    version: version || null,
    source: 'config',
    dstack: { available: false, reason: 'metadata_served_from_config', app_id: appId },
  };
}
