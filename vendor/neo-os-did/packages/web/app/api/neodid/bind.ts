import { dispatchToControlPlane, shouldDispatchToControlPlane } from '@/lib/control-plane';
import { proxyToNitro } from '@/lib/nitro';
import { createRateLimitedHandler } from '@/lib/rate-limit';

const handlePost = createRateLimitedHandler(
  async function POST(request: Request) {
    const body = await request.text();
    if (shouldDispatchToControlPlane('/neodid/bind')) {
      return dispatchToControlPlane(
        '/neodid/bind',
        {
          method: 'POST',
          body,
          headers: { 'content-type': 'application/json' },
        },
        {
          route: '/api/neodid/bind',
          category: 'system',
          requestPayload: body,
        }
      );
    }
    return proxyToNitro(
      '/neodid/bind',
      {
        method: 'POST',
        body,
        headers: { 'content-type': 'application/json' },
      },
      {
        route: '/api/neodid/bind',
        category: 'system',
        requestPayload: body,
      }
    );
  },
  { scope: 'neodid_bind', maxRequests: 20, windowMs: 60_000 }
);

export async function POST(request: Request) {
  return handlePost(request);
}
