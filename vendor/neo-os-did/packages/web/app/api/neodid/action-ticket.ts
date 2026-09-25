import { dispatchToControlPlane, shouldDispatchToControlPlane } from '@/lib/control-plane';
import { proxyToNitro } from '@/lib/nitro';
import { createRateLimitedHandler } from '@/lib/rate-limit';

const handlePost = createRateLimitedHandler(
  async function POST(request: Request) {
    const body = await request.text();
    if (shouldDispatchToControlPlane('/neodid/action-ticket')) {
      return dispatchToControlPlane(
        '/neodid/action-ticket',
        {
          method: 'POST',
          body,
          headers: { 'content-type': 'application/json' },
        },
        {
          route: '/api/neodid/action-ticket',
          category: 'system',
          requestPayload: body,
        }
      );
    }
    return proxyToNitro(
      '/neodid/action-ticket',
      {
        method: 'POST',
        body,
        headers: { 'content-type': 'application/json' },
      },
      {
        route: '/api/neodid/action-ticket',
        category: 'system',
        requestPayload: body,
      }
    );
  },
  { scope: 'neodid_action_ticket', maxRequests: 20, windowMs: 60_000 }
);

export async function POST(request: Request) {
  return handlePost(request);
}
