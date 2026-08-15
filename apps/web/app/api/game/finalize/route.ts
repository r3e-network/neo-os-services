import { proxyToNitro } from '@/lib/nitro';
import { createRateLimitedHandler } from '@/lib/rate-limit';
import { isAuthorizedRuntimeRequest } from '@/lib/control-plane-auth';
import { trimString } from '@/lib/strings';

const handlePost = createRateLimitedHandler(
  async function POST(request: Request) {
    if (!isAuthorizedRuntimeRequest(request)) {
      return Response.json({ error: 'unauthorized' }, { status: 401 });
    }
    const body = await request.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = { raw_body: body };
    }
    const network =
      parsed && typeof parsed === 'object'
        ? trimString((parsed as Record<string, unknown>).network || '')
        : '';
    return proxyToNitro(
      '/game/finalize',
      { method: 'POST', body },
      {
        route: '/api/game/finalize',
        category: 'runtime',
        requestPayload: parsed,
        network: network || null,
      }
    );
  },
  { scope: 'game_finalize', maxRequests: 12, windowMs: 60_000 }
);

export async function POST(request: Request) {
  return handlePost(request);
}
