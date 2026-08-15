import { appConfig } from './config';
import { getWorkflowDispatchMetadata } from './workflow-runtime';
import { recordOperationLog } from './operation-logs';

type ControlPlaneCategory =
  | 'oracle'
  | 'compute'
  | 'system'
  | 'feed'
  | 'relay'
  | 'signing'
  | 'runtime';

type DispatchOperation = {
  route: string;
  category: ControlPlaneCategory;
  requestPayload?: unknown;
  metadata?: Record<string, unknown>;
};

const DISPATCHABLE_PATHS = new Set([
  '/oracle/query',
  '/oracle/smart-fetch',
  '/compute/execute',
  '/neodid/bind',
  '/neodid/action-ticket',
  '/neodid/recovery-ticket',
  '/feeds/tick',
  '/callbacks/broadcast',
  '/automation/execute',
]);

function maybeParseJson(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function shouldDispatchToControlPlane(path: string) {
  return Boolean(appConfig.controlPlaneUrl) && DISPATCHABLE_PATHS.has(path);
}

export function getControlPlaneDispatchMetadata(path: string) {
  return getWorkflowDispatchMetadata(path);
}

export async function dispatchToControlPlane(
  path: string,
  init: RequestInit = {},
  operation?: DispatchOperation
) {
  if (!appConfig.controlPlaneUrl) {
    return Response.json(
      { error: 'MORPHEUS_CONTROL_PLANE_URL is not configured' },
      { status: 500 }
    );
  }

  const headers = new Headers(init.headers || {});
  headers.set('content-type', headers.get('content-type') || 'application/json');
  const dispatchMetadata = getControlPlaneDispatchMetadata(path);
  if (dispatchMetadata) {
    headers.set('x-morpheus-workflow-id', dispatchMetadata.workflowId);
    headers.set('x-morpheus-workflow-version', String(dispatchMetadata.workflowVersion));
  }
  if (appConfig.controlPlaneApiKey) {
    headers.set('authorization', `Bearer ${appConfig.controlPlaneApiKey}`);
    headers.set('x-admin-api-key', appConfig.controlPlaneApiKey);
  }

  const controlPlaneUrl = `${appConfig.controlPlaneUrl.replace(/\/$/, '')}/${appConfig.selectedNetworkKey}${path}`;
  let response: Response;
  let text: string;
  let contentType = 'application/json';

  try {
    response = await fetch(controlPlaneUrl, {
      ...init,
      headers,
      cache: 'no-store',
      // Bound the request so a stalled control plane can't hang the caller;
      // the surrounding catch converts transport failures into a closed 503.
      signal: AbortSignal.timeout(10000),
    });
    text = await response.text();
    contentType = response.headers.get('content-type') || 'application/json';
  } catch {
    text = JSON.stringify({
      error: 'control_plane_unavailable',
    });
    contentType = 'application/json';
    response = new Response(text, { status: 503, headers: { 'content-type': contentType } });
  }

  if (operation) {
    await recordOperationLog({
      route: operation.route,
      method: init.method || 'POST',
      category: operation.category,
      requestPayload: operation.requestPayload,
      responsePayload: maybeParseJson(text),
      httpStatus: response.status,
      error: response.ok ? null : text,
      metadata: {
        upstream_path: path,
        control_plane: true,
        control_plane_url: controlPlaneUrl,
        workflow_id: dispatchMetadata?.workflowId || null,
        workflow_version: dispatchMetadata?.workflowVersion || null,
        envelope_version: dispatchMetadata?.envelopeVersion || null,
        ...operation.metadata,
      },
    });
  }

  const responseHeaders = new Headers({
    'content-type': contentType,
  });

  return new Response(text, {
    status: response.status,
    headers: responseHeaders,
  });
}
