import { apiError } from '@/lib/api-helpers';
import { isAuthorizedRuntimeRequest } from '@/lib/control-plane-auth';
import { proxyToNitro } from '@/lib/nitro';
import { createRateLimitedHandler } from '@/lib/rate-limit';

const handleGet = createRateLimitedHandler(
  async function GET(request: Request) {
    // The edge gateway requires a trusted runtime token for /keys/derived; the
    // apps/web origin proxies the same upstream path and must enforce the same
    // gate so derived key material is never reachable unauthenticated.
    if (!isAuthorizedRuntimeRequest(request)) {
      return apiError('unauthorized', 'UNAUTHORIZED', 401);
    }

    const url = new URL(request.url);
    const role = (url.searchParams.get('role') || 'worker').trim() || 'worker';
    // The host serves /keys/derived for POST only: `classify` falls through to
    // NotFound on a method mismatch, so a GET here was a 404 behind an
    // authorised public endpoint. The role travels in the body, not the query
    // string, because `handle_keys_derived` reads `role` from the payload and
    // the dispatcher never forwards query parameters to a POST lane.
    return proxyToNitro(
      '/keys/derived',
      { method: 'POST', body: JSON.stringify({ role }) },
      {
        route: '/api/runtime/keys/derived',
        category: 'runtime',
        requestPayload: { role },
      }
    );
  },
  { scope: 'runtime_keys_derived', maxRequests: 20, windowMs: 60_000 }
);

export async function GET(request: Request) {
  return handleGet(request);
}
