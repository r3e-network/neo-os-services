import { dispatchToControlPlane, shouldDispatchToControlPlane } from '@/lib/control-plane';
import { resolveProviderAwarePayload } from '@/lib/provider-configs';
import { recordOperationLog } from '@/lib/operation-logs';
import { proxyToNitro } from '@/lib/nitro';
import { createRateLimitedHandler } from '@/lib/rate-limit';
import {
  isAuthorizedOracleQueryRequest,
  isOracleQueryGateConfigured,
} from '@/lib/control-plane-auth';
import { apiError, badRequest } from '@/lib/api-helpers';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

const handlePost = createRateLimitedHandler(
  async function POST(request: Request) {
    // SECURITY (N-web-2): this lane spends server-held credentials on behalf of
    // its caller — an upstream provider fetch plus a control-plane dispatch
    // authenticated with MORPHEUS_CONTROL_PLANE_API_KEY. When
    // MORPHEUS_ORACLE_QUERY_API_KEY is configured the caller must present it;
    // the check is conditional so configuring it is the deployment's decision,
    // never a silent break for a deployment that has not set it yet.
    if (isOracleQueryGateConfigured() && !isAuthorizedOracleQueryRequest(request)) {
      return apiError('unauthorized', 'UNAUTHORIZED', 401);
    }
    const body = await request.json().catch(() => null);
    if (!isPlainObject(body)) {
      await recordOperationLog({
        route: '/api/oracle/query',
        method: 'POST',
        category: 'oracle',
        requestPayload: body,
        responsePayload: { error: 'invalid JSON body' },
        httpStatus: 400,
        error: 'invalid JSON body',
      });
      return badRequest('invalid JSON body', 400, 'INVALID_JSON_BODY');
    }

    try {
      const resolved = await resolveProviderAwarePayload(body, {
        fallbackProviderId: !body.url && body.symbol ? 'twelvedata' : undefined,
      });
      if (shouldDispatchToControlPlane('/oracle/query')) {
        return dispatchToControlPlane(
          '/oracle/query',
          {
            method: 'POST',
            body: JSON.stringify(resolved.payload),
          },
          {
            route: '/api/oracle/query',
            category: 'oracle',
            requestPayload: resolved.payload,
          }
        );
      }
      return proxyToNitro(
        '/oracle/query',
        {
          method: 'POST',
          body: JSON.stringify(resolved.payload),
        },
        {
          route: '/api/oracle/query',
          category: 'oracle',
          requestPayload: resolved.payload,
        }
      );
    } catch (error) {
      await recordOperationLog({
        route: '/api/oracle/query',
        method: 'POST',
        category: 'oracle',
        requestPayload: body,
        responsePayload: { error: error instanceof Error ? error.message : String(error) },
        httpStatus: 400,
        error: error instanceof Error ? error.message : String(error),
      });
      return badRequest(
        error instanceof Error ? error.message : String(error),
        400,
        'ORACLE_QUERY_INVALID'
      );
    }
  },
  { scope: 'oracle_query', maxRequests: 30, windowMs: 60_000 }
);

export async function POST(request: Request) {
  return handlePost(request);
}
