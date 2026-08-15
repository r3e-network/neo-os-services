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
    return proxyToNitro(
      `/keys/derived?role=${encodeURIComponent(role)}`,
      { method: 'GET' },
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
