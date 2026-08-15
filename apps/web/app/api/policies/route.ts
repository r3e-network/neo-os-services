import { getPublicPolicyCatalog } from '@/lib/workflow-runtime';
import { publicApiHandler } from '@/lib/public-api-handler';
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

export const GET = publicApiHandler(async () => Response.json(getPublicPolicyCatalog()), {
  rateLimit: { scope: 'policies', maxRequests: 60, windowMs: 60_000 },
  validate: validateQuery,
});
