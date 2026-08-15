import { badRequest } from './api-helpers';
import { recordOperationLog } from './operation-logs';
import { isAuthorizedAdminRequest } from './server-supabase';

/**
 * Shared admin guard for relayer-ops routes. Returns null when the request is
 * authorized, or a 401 `{ error: 'unauthorized' }` response otherwise.
 *
 * Extracted from the five relayer route handlers
 * (jobs, jobs/retry, jobs/replay, dead-letters, metrics) which each defined an
 * identical copy.
 */
export function requireRelayerAdmin(request: Request) {
  if (isAuthorizedAdminRequest(request, 'relayer_ops')) return null;
  return badRequest('unauthorized', 401);
}

/**
 * Records the standard unauthorized operation-log entry shared by the relayer
 * routes. `requestPayload` mirrors what each handler logged previously
 * (search params for GET, parsed body for POST).
 */
export async function logRelayerUnauthorized(
  route: string,
  method: string,
  requestPayload: unknown
) {
  await recordOperationLog({
    route,
    method,
    category: 'relayer',
    requestPayload,
    responsePayload: { error: 'unauthorized' },
    httpStatus: 401,
    error: 'unauthorized',
  });
}
