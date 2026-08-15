import { getSelectedNetwork, networkRegistry } from '@/lib/networks';
import { publicApiHandler } from '@/lib/public-api-handler';
import { recordOperationLog } from '@/lib/operation-logs';
import { emptyQuerySchema } from '@/lib/validators';

function validateQuery(request: Request) {
  const url = new URL(request.url);
  const result = emptyQuerySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!result.success) {
    return {
      success: false as const,
      response: Response.json({ error: 'invalid query parameters' }, { status: 400 }),
    };
  }
  return { success: true as const };
}

export const GET = publicApiHandler(
  async () => {
    const body = {
      selected: getSelectedNetwork(),
      available: networkRegistry,
    };
    await recordOperationLog({
      route: '/api/networks',
      method: 'GET',
      category: 'network',
      responsePayload: body,
      httpStatus: 200,
    });
    return Response.json(body);
  },
  {
    requireAuth: false,
    rateLimit: { scope: 'networks', maxRequests: 60, windowMs: 60_000 },
    validate: validateQuery,
  }
);
