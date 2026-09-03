import { proxyToNitro } from '@/lib/nitro';
import { createRateLimitedHandler } from '@/lib/rate-limit';

// SECURITY (S19): this public GET proxy had no rate limit; cap it so it cannot
// be used to hammer the runtime upstream.
const handleGet = createRateLimitedHandler(
  async function GET(_request: Request) {
    return proxyToNitro(
      '/compute/functions',
      { method: 'GET' },
      {
        route: '/api/compute/functions',
        category: 'compute',
        confidential: false,
      }
    );
  },
  { scope: 'compute_functions', maxRequests: 30, windowMs: 60_000 }
);

export async function GET(request: Request) {
  return handleGet(request);
}
