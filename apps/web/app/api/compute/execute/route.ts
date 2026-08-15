import { dispatchToControlPlane, shouldDispatchToControlPlane } from '@/lib/control-plane';
import { isAuthorizedRuntimeRequest } from '@/lib/control-plane-auth';
import { apiError } from '@/lib/api-helpers';
import { proxyToNitro } from '@/lib/nitro';
import { createRateLimitedHandler } from '@/lib/rate-limit';
import { trimString } from '@/lib/strings';

const handlePost = createRateLimitedHandler(
  async function POST(request: Request) {
    // SECURITY (S1): compute/execute runs user-supplied scripts/WASM inside the
    // TEE. It must not be reachable anonymously: require a trusted runtime
    // credential (same gate as /api/runtime/keys/derived) and fail closed when
    // no credential is configured.
    if (!isAuthorizedRuntimeRequest(request)) {
      return apiError('unauthorized', 'UNAUTHORIZED', 401);
    }
    const body = await request.text();
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = { raw_body: body };
    }
    const targetChain =
      parsed && typeof parsed === 'object'
        ? trimString(
            (parsed as Record<string, unknown>).target_chain ||
              (parsed as Record<string, unknown>).targetChain ||
              ''
          )
        : '';
    if (targetChain && targetChain !== 'neo_n3') {
      return Response.json(
        { error: 'target_chain must be neo_n3', error_code: 'INVALID_TARGET_CHAIN' },
        { status: 400 }
      );
    }
    if (shouldDispatchToControlPlane('/compute/execute')) {
      return dispatchToControlPlane(
        '/compute/execute',
        { method: 'POST', body },
        {
          route: '/api/compute/execute',
          category: 'compute',
          requestPayload: parsed,
        }
      );
    }
    return proxyToNitro(
      '/compute/execute',
      { method: 'POST', body },
      {
        route: '/api/compute/execute',
        category: 'compute',
        requestPayload: parsed,
      }
    );
  },
  { scope: 'compute_execute', maxRequests: 20, windowMs: 60_000 }
);

export async function POST(request: Request) {
  return handlePost(request);
}
