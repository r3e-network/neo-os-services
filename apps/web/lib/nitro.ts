import { trimString } from '@r3e-network/neo-os-services-shared/utils';
import { appConfig } from './config';
import { getSelectedNetwork, getSelectedNetworkKey } from './networks';
import { recordOperationLog } from './operation-logs';

type ProxyOperation = {
  route: string;
  category:
    | 'oracle'
    | 'compute'
    | 'feed'
    | 'runtime'
    | 'signing'
    | 'relay'
    | 'attestation'
    | 'system';
  requestPayload?: unknown;
  metadata?: Record<string, unknown>;
  network?: string | null;
};

function maybeParseJson(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function isRetryableStatus(status: number) {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

const RUNTIME_URL_ERROR = 'MORPHEUS_RUNTIME_URL is not configured';

function networkScopedEnv(baseKey: string, networkKey: string) {
  const upper = getSelectedNetworkKey(networkKey) === 'mainnet' ? 'MAINNET' : 'TESTNET';
  return trimString(process.env[`${baseKey}_${upper}` as keyof NodeJS.ProcessEnv]);
}

function resolveRuntimeCandidates(networkOverride?: string | null) {
  const networkKey = getSelectedNetworkKey(networkOverride || appConfig.selectedNetworkKey);
  if (!networkOverride || networkKey === appConfig.selectedNetworkKey) {
    return Array.isArray(appConfig.nitroApiUrls) && appConfig.nitroApiUrls.length > 0
      ? appConfig.nitroApiUrls
      : appConfig.nitroApiUrl
        ? [appConfig.nitroApiUrl]
        : [];
  }

  const selectedNetwork = getSelectedNetwork(networkKey);
  const defaults = [
    networkScopedEnv('MORPHEUS_RUNTIME_URL', networkKey),
    networkScopedEnv('NEXT_PUBLIC_MORPHEUS_RUNTIME_URL', networkKey),
    selectedNetwork.nitro?.public_api_url || '',
    `https://oracle.meshmini.app/${networkKey}`,
    `https://edge.meshmini.app/${networkKey}`,
    trimString(process.env.MORPHEUS_RUNTIME_URL),
    trimString(process.env.NEXT_PUBLIC_MORPHEUS_RUNTIME_URL),
  ]
    .map((value) => value.trim())
    .filter(Boolean);

  return [...new Set(defaults)];
}

export async function proxyToNitro(
  path: string,
  init: RequestInit = {},
  operation?: ProxyOperation
) {
  const networkKey = getSelectedNetworkKey(operation?.network || appConfig.selectedNetworkKey);
  const candidateUrls = resolveRuntimeCandidates(operation?.network);

  if (candidateUrls.length === 0) {
    if (operation) {
      try {
        await recordOperationLog({
          route: operation.route,
          method: init.method || 'GET',
          category: operation.category,
          requestPayload: operation.requestPayload,
          responsePayload: { error: RUNTIME_URL_ERROR },
          httpStatus: 500,
          error: RUNTIME_URL_ERROR,
          metadata: operation.metadata,
        });
      } catch {}
    }
    return Response.json({ error: RUNTIME_URL_ERROR }, { status: 500 });
  }

  const headers = new Headers(init.headers || {});
  headers.set('content-type', headers.get('content-type') || 'application/json');
  if (appConfig.nitroToken) {
    headers.set('authorization', `Bearer ${appConfig.nitroToken}`);
    headers.set('x-nitro-token', appConfig.nitroToken);
  }
  headers.set('x-morpheus-network', networkKey);

  let lastResponse: { status: number; text: string; contentType: string; url: string } | null =
    null;
  let lastError: string | null = null;

  for (const baseUrl of candidateUrls) {
    try {
      const response = await fetch(`${baseUrl.replace(/\/$/, '')}${path}`, {
        ...init,
        headers,
        cache: 'no-store',
        // Per-candidate timeout so a stalled CVM endpoint fails over to the
        // next URL (caught below) instead of hanging the whole request.
        signal: AbortSignal.timeout(30000),
      });
      const text = await response.text();
      lastResponse = {
        status: response.status,
        text,
        contentType: response.headers.get('content-type') || 'application/json',
        url: baseUrl,
      };
      if (response.ok || !isRetryableStatus(response.status)) {
        break;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  if (!lastResponse) {
    if (operation) {
      try {
        await recordOperationLog({
          route: operation.route,
          method: init.method || 'GET',
          category: operation.category,
          requestPayload: operation.requestPayload,
          responsePayload: { error: lastError || 'upstream unavailable' },
          httpStatus: 503,
          error: lastError || 'upstream unavailable',
          metadata: {
            upstream_path: path,
            upstream_candidates: candidateUrls,
            ...operation.metadata,
          },
        });
      } catch {}
    }
    return Response.json({ error: lastError || 'upstream unavailable' }, { status: 503 });
  }

  if (operation) {
    try {
      await recordOperationLog({
        route: operation.route,
        method: init.method || 'GET',
        category: operation.category,
        requestPayload: operation.requestPayload,
        responsePayload: maybeParseJson(lastResponse.text),
        httpStatus: lastResponse.status,
        error: lastResponse.status >= 400 ? lastResponse.text : null,
        metadata: {
          upstream_path: path,
          upstream_url: lastResponse.url,
          upstream_candidates: candidateUrls,
          network: networkKey,
          ...operation.metadata,
        },
      });
    } catch {}
  }
  return new Response(lastResponse.text, {
    status: lastResponse.status,
    headers: { 'content-type': lastResponse.contentType },
  });
}
