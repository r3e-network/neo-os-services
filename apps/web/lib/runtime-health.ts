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
const DEFAULT_BOX_HEALTH_URL = 'https://runtime.meshmini.app/{network}/health';

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

async function readBoxHealth(url: string): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const operation = (async () => {
    const response = await fetch(url, {
      method: 'GET',
      cache: 'no-store',
      signal: controller.signal,
      redirect: 'error',
    });
    if (controller.signal.aborted) {
      void response.body?.cancel().catch(() => {});
      throw new Error('Health request expired');
    }
    reader = response.body?.getReader();
    if (!reader) throw new Error('Missing health body');
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 65536) throw new Error('Health response exceeds limit');
      chunks.push(part.value);
    }
    const content = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      content.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return {
      status: response.status,
      body: JSON.parse(new TextDecoder().decode(content)) as unknown,
    };
  })();
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('Health request expired'));
    }, 8000);
  });
  try {
    // The deadline includes both headers and every streamed body read, even
    // when a custom fetch implementation does not honor its AbortSignal.
    return await Promise.race([operation, deadline]);
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (reader) {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}

export async function fetchBoxHealth(networkOverride?: string | null): Promise<RuntimeProbe> {
  const networkKey = getSelectedNetworkKey(networkOverride);
  try {
    const response = await readBoxHealth(resolveBoxHealthUrl(networkKey));
    // Never return a raw response string (or spread string characters into an
    // error envelope). Only structured health documents can supply evidence.
    const body =
      response.body && typeof response.body === 'object' && !Array.isArray(response.body)
        ? (response.body as Record<string, unknown>)
        : {};

    const reportedNetwork = normalizeNetworkKey(body.network as string | null);
    if (response.status === 200 && reportedNetwork !== networkKey) {
      return {
        ok: false,
        status: 503,
        body: {
          ...body,
          status: 'degraded',
          ready: false,
          error: reportedNetwork ? 'runtime_network_mismatch' : 'runtime_network_unverified',
          requested_network: networkKey,
          actual_network: reportedNetwork,
        },
      };
    }
    if (
      response.status === 200 &&
      (body.ready !== true || (body.status !== undefined && body.status !== 'ok'))
    ) {
      return {
        ok: false,
        status: 503,
        body: { ...body, error: 'runtime_not_ready', status: 'degraded', ready: false },
      };
    }
    return {
      ok: response.status === 200,
      status: response.status,
      body: response.status === 200 ? body : { ...body, ready: false },
    };
  } catch {
    return {
      ok: false,
      status: 0,
      body: { error: 'runtime_health_unavailable', ready: false, requested_network: networkKey },
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
