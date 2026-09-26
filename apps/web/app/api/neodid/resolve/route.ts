import { publicApiHandler } from '@/lib/public-api-handler';
import { resolveMorpheusDid } from '@/lib/neodid-did';
import { neodidResolveQuerySchema } from '@/lib/validators';
import { appConfig } from '@/lib/config';

function validateQuery(request: Request) {
  const url = new URL(request.url);
  const result = neodidResolveQuerySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!result.success) {
    return {
      success: false as const,
      response: Response.json({ error: 'invalid query parameters' }, { status: 400 }),
    };
  }
  return { success: true as const };
}

export const GET = publicApiHandler(
  async (request: Request) => {
    const url = new URL(request.url);
    const did = url.searchParams.get('did') || '';
    const format = url.searchParams.get('format');

    const result = await resolveMorpheusDid(did, {
      // SECURITY (S13): never reflect the request Host; DID document URLs are
      // built from the configured canonical app URL (normalizeOrigin inside
      // neodid-did.ts also enforces the host match as defense in depth).
      origin: appConfig.appUrl,
      accept: request.headers.get('accept'),
      format,
    });

    return new Response(JSON.stringify(result.body, null, 2), {
      status: result.status,
      headers: {
        'access-control-allow-origin': '*',
        'cache-control': 'no-store',
        'content-type': `${result.contentType}; charset=utf-8`,
        vary: 'accept',
      },
    });
  },
  {
    rateLimit: { scope: 'neodid-resolve', maxRequests: 30, windowMs: 60_000 },
    validate: validateQuery,
  }
);
