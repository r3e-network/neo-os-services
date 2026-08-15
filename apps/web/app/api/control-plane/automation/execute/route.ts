import { isAuthorizedControlPlaneRequest } from '@/lib/control-plane-auth';
import { appConfig } from '@/lib/config';
import { badRequest } from '@/lib/api-helpers';
import { trimString } from '@/lib/strings';

export const runtime = 'nodejs';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function resolveNetwork(value: unknown) {
  return trimString(value) === 'mainnet' ? 'mainnet' : 'testnet';
}

function resolveControlPlaneUrl() {
  // Always use the server-configured control-plane host. A caller-supplied URL
  // must never be honored here: this request attaches the server's admin API
  // key, so trusting client input would let an authorized caller exfiltrate the
  // credential to an arbitrary host (SSRF + credential leak).
  return (appConfig.controlPlaneUrl || '').replace(/\/$/, '');
}

export async function POST(request: Request) {
  if (!isAuthorizedControlPlaneRequest(request)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  if (!isPlainObject(body)) return badRequest('invalid JSON body');
  const controlPlaneUrl = resolveControlPlaneUrl();
  if (!controlPlaneUrl) return badRequest('MORPHEUS_CONTROL_PLANE_URL is not configured', 500);

  const headers = new Headers({ 'content-type': 'application/json' });
  if (appConfig.controlPlaneApiKey) {
    headers.set('authorization', `Bearer ${appConfig.controlPlaneApiKey}`);
    headers.set('x-admin-api-key', appConfig.controlPlaneApiKey);
  }

  const network = resolveNetwork(body.network);
  try {
    const response = await fetch(`${controlPlaneUrl}/${network}/automation/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      cache: 'no-store',
    });
    const text = await response.text();
    return new Response(text, {
      status: response.status,
      headers: { 'content-type': response.headers.get('content-type') || 'application/json' },
    });
  } catch {
    return Response.json({ error: 'upstream unavailable' }, { status: 503 });
  }
}
