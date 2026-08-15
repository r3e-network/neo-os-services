import { getFeedsStatusBody } from '@/lib/feeds-status';
import { recordOperationLog } from '@/lib/operation-logs';
import { createRateLimitedHandler } from '@/lib/rate-limit';

const handleGet = createRateLimitedHandler(
  async function GET(request: Request) {
    const { body, cache } = await getFeedsStatusBody();
    await recordOperationLog({
      route: '/api/feeds/status',
      method: 'GET',
      category: 'feed',
      requestPayload: Object.fromEntries(new URL(request.url).searchParams.entries()),
      responsePayload: body,
      httpStatus: 200,
      metadata: { cache },
    });
    return Response.json(body);
  },
  { scope: 'feeds_status', maxRequests: 30, windowMs: 60_000 }
);

export async function GET(request: Request) {
  return handleGet(request);
}
