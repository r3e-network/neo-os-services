import { proxyToNitro } from '@/lib/nitro';
import { createRateLimitedHandler } from '@/lib/rate-limit';

// SECURITY (S19): this public GET proxy had no rate limit; cap it so it cannot
// be used to hammer the runtime upstream.
const handleGet = createRateLimitedHandler(
  async function GET(_request: Request) {
    return proxyToNitro(
      '/neodid/runtime',
      { method: 'GET' },
      {
        route: '/api/neodid/runtime',
        category: 'system',
        confidential: false,
      }
    );
  },
  { scope: 'neodid_runtime', maxRequests: 30, windowMs: 60_000 }
);

export async function GET(request: Request) {
  return handleGet(request);
}
