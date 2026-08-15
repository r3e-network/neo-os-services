import { isAuthorizedRuntimeRequest } from './control-plane-auth';
import { createRateLimitedHandler, type RateLimitOptions } from './rate-limit';

type ValidationResult = { success: true } | { success: false; response: Response };

export type PublicApiHandlerOptions = {
  /**
   * Require a valid runtime/admin token. Set to `false` for routes that must
   * remain fully public (e.g. `/api/networks`). Rate limiting still applies.
   */
  requireAuth?: boolean;
  /** Rate-limit options passed to the shared Redis-aware fixed-window limiter. */
  rateLimit?: RateLimitOptions;
  /** Optional input validator. Return `{ success: false, response }` to reject. */
  validate?: (request: Request) => ValidationResult | Promise<ValidationResult>;
};

/**
 * Shared wrapper for intentionally public apps/web API routes.
 *
 * Applies, in order:
 * 1. Rate limiting (Redis-backed when Upstash is configured, in-memory fallback).
 * 2. Runtime/admin token authentication (unless explicitly disabled).
 * 3. Optional input validation.
 *
 * Errors are returned as `{ error: string }` with generic messages so callers
 * cannot abuse the surface for enumeration.
 */
export function publicApiHandler(
  handler: (request: Request) => Promise<Response> | Response,
  options: PublicApiHandlerOptions = {}
) {
  const { requireAuth = true, rateLimit: rateLimitOptions, validate } = options;

  const limited = createRateLimitedHandler(async (request: Request): Promise<Response> => {
    if (requireAuth && !isAuthorizedRuntimeRequest(request)) {
      return Response.json({ error: 'unauthorized' }, { status: 401 });
    }

    if (validate) {
      const result = await validate(request);
      if (!result.success) {
        return result.response;
      }
    }

    return handler(request);
  }, rateLimitOptions);

  return limited;
}
