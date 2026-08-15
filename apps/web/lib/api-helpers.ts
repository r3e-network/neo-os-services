import { NextResponse } from 'next/server';

/**
 * Standardized API error response with machine-readable error_code.
 *
 * Usage:
 *   return apiError('ciphertext is required', 'MISSING_CIPHERTEXT', 400);
 */
export function apiError(message: string, code: string, status = 500) {
  return NextResponse.json({ error: message, error_code: code }, { status });
}

/**
 * Minimal error response preserving the `{ error }` JSON shape used by the
 * relayer/oracle/control-plane route handlers. When `code` is omitted the body
 * stays byte-identical to the legacy `{ error }` shape; passing a `code`
 * additively includes a machine-readable `error_code` alongside `error` so
 * existing `{ error }` consumers keep working.
 */
export function badRequest(message: string, status = 400, code?: string) {
  return Response.json(code ? { error: message, error_code: code } : { error: message }, {
    status,
  });
}
