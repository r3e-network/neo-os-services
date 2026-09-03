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
  // Defaults true. Only explicit public/read-only routes may set false and use
  // configured endpoint failover in production.
  confidential?: boolean;
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
  const segments = baseKey.split('_');
  const morpheusIndex = segments.indexOf('MORPHEUS');
  const prefixed =
    morpheusIndex >= 0
      ? [...segments.slice(0, morpheusIndex + 1), upper, ...segments.slice(morpheusIndex + 1)].join(
          '_'
        )
      : '';
  return (
    trimString(process.env[`${baseKey}_${upper}` as keyof NodeJS.ProcessEnv]) ||
    trimString(process.env[prefixed as keyof NodeJS.ProcessEnv])
  );
}

function resolveRuntimeCandidates(networkOverride?: string | null, confidential: boolean = true) {
  const networkKey = getSelectedNetworkKey(networkOverride || appConfig.selectedNetworkKey);
  if (!networkOverride || networkKey === appConfig.selectedNetworkKey) {
    if (
      !confidential &&
      Array.isArray(appConfig.publicNitroApiUrls) &&
      appConfig.publicNitroApiUrls.length > 0
    ) {
      return appConfig.publicNitroApiUrls;
    }
    return Array.isArray(appConfig.nitroApiUrls) && appConfig.nitroApiUrls.length > 0
      ? appConfig.nitroApiUrls
      : appConfig.nitroApiUrl
        ? [appConfig.nitroApiUrl]
        : [];
  }

  const selectedNetwork = getSelectedNetwork(networkKey);
  const serverCandidates = [
    networkScopedEnv('MORPHEUS_RUNTIME_URL', networkKey),
    trimString(process.env.MORPHEUS_RUNTIME_URL),
  ];
  const defaults = [...serverCandidates];
  if (!confidential || process.env.NODE_ENV !== 'production') {
    defaults.push(
      networkScopedEnv('NEXT_PUBLIC_MORPHEUS_RUNTIME_URL', networkKey),
      trimString(process.env.NEXT_PUBLIC_MORPHEUS_RUNTIME_URL),
      selectedNetwork.nitro?.public_api_url || '',
      `https://oracle.meshmini.app/${networkKey}`,
      `https://edge.meshmini.app/${networkKey}`
    );
  }
  const normalized = defaults.map((value) => value.trim()).filter(Boolean);

  return [...new Set(normalized)];
}

function normalizeRuntimeBaseUrl(value: string) {
  return value.trim().replace(/\/+$/, '');
}

export async function proxyToNitro(
  path: string,
  init: RequestInit = {},
  operation?: ProxyOperation
) {
  const networkKey = getSelectedNetworkKey(operation?.network || appConfig.selectedNetworkKey);
  const confidential = operation?.confidential !== false;
  const resolvedCandidates = resolveRuntimeCandidates(operation?.network, confidential);
  const candidateUrls =
    process.env.NODE_ENV === 'production' && confidential
      ? resolvedCandidates.slice(0, 1)
      : resolvedCandidates;
  const credentialedCandidates = new Set(
    resolveRuntimeCandidates(operation?.network, true).map(normalizeRuntimeBaseUrl)
  );

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

  const baseHeaders = new Headers(init.headers || {});
  baseHeaders.set('content-type', baseHeaders.get('content-type') || 'application/json');
  baseHeaders.set('x-morpheus-network', networkKey);

  let lastResponse: { status: number; text: string; contentType: string; url: string } | null =
    null;
  let lastError: string | null = null;

  for (const baseUrl of candidateUrls) {
    try {
      const headers = new Headers(baseHeaders);
      const mayReceiveRuntimeCredential =
        process.env.NODE_ENV !== 'production' ||
        credentialedCandidates.has(normalizeRuntimeBaseUrl(baseUrl));
      if (appConfig.nitroToken && mayReceiveRuntimeCredential) {
        headers.set('authorization', `Bearer ${appConfig.nitroToken}`);
        headers.set('x-nitro-token', appConfig.nitroToken);
      } else if (!mayReceiveRuntimeCredential) {
        headers.delete('authorization');
        headers.delete('x-nitro-token');
      }
      const response = await fetch(`${baseUrl.replace(/\/$/, '')}${path}`, {
        ...init,
        headers,
        cache: 'no-store',
        // Public/read-only callers may have more than one explicit candidate.
        // Confidential production calls are reduced to one candidate above.
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
