import { dispatchToControlPlane, shouldDispatchToControlPlane } from '@/lib/control-plane';
import { resolveProviderAwarePayload } from '@/lib/provider-configs';
import { recordOperationLog } from '@/lib/operation-logs';
import { proxyToNitro } from '@/lib/nitro';
import { createRateLimitedHandler } from '@/lib/rate-limit';
import { badRequest } from '@/lib/api-helpers';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

const handlePost = createRateLimitedHandler(
  async function POST(request: Request) {
    const body = await request.json().catch(() => null);
    if (!isPlainObject(body)) {
      await recordOperationLog({
        route: '/api/oracle/smart-fetch',
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
      if (shouldDispatchToControlPlane('/oracle/smart-fetch')) {
        return dispatchToControlPlane(
          '/oracle/smart-fetch',
          {
            method: 'POST',
            body: JSON.stringify(resolved.payload),
          },
          {
            route: '/api/oracle/smart-fetch',
            category: 'oracle',
            requestPayload: resolved.payload,
          }
        );
      }
      return proxyToNitro(
        '/oracle/smart-fetch',
        {
          method: 'POST',
          body: JSON.stringify(resolved.payload),
        },
        {
          route: '/api/oracle/smart-fetch',
          category: 'oracle',
          requestPayload: resolved.payload,
        }
      );
    } catch (error) {
      await recordOperationLog({
        route: '/api/oracle/smart-fetch',
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
        'SMART_FETCH_INVALID'
      );
    }
  },
  { scope: 'oracle_smart_fetch', maxRequests: 20, windowMs: 60_000 }
);

export async function POST(request: Request) {
  return handlePost(request);
}
