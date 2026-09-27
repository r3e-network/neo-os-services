import { NextResponse } from 'next/server';
import {
  NeoOSError,
  ContractError,
  NetworkError,
  ValidationError,
  AuthenticationError,
  errorToResponse,
  formatError,
} from '@r3e-network/neo-os-devpack/framework/errors-standard';

/**
 * Standardized API error response with machine-readable error_code.
 *
 * @deprecated Use errorToResponse or throw NeoOSError subclasses instead.
 * This maintains backward compatibility with existing routes.
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
 *
 * @deprecated Use errorToResponse or throw NeoOSError subclasses instead.
 */
export function badRequest(message: string, status = 400, code?: string) {
  return Response.json(code ? { error: message, error_code: code } : { error: message }, {
    status,
  });
}

/**
 * Create standardized error response from any error.
 *
 * Usage:
 *   try {
 *     // ... operation
 *   } catch (error) {
 *     return standardErrorResponse(error, 'OPERATION_FAILED', 500);
 *   }
 */
export function standardErrorResponse(
  error: unknown,
  fallbackCode = 'INTERNAL_ERROR',
  fallbackStatus = 500
): Response {
  return errorToResponse(error, fallbackCode, fallbackStatus);
}

/**
 * Create validation error response.
 */
export function validationError(message: string, details?: Record<string, unknown>): Response {
  const error = new ValidationError(message, 'VALIDATION_ERROR', details);
  return error.toResponse();
}

/**
 * Create authentication error response.
 */
export function authenticationError(message: string, code = 'AUTHENTICATION_ERROR'): Response {
  const error = new AuthenticationError(message, code);
  return error.toResponse();
}

/**
 * Create network error response.
 */
export function networkError(message: string, details?: Record<string, unknown>): Response {
  const error = new NetworkError(message, 'NETWORK_ERROR', details);
  return error.toResponse();
}

/**
 * Create contract error response.
 */
export function contractError(message: string, code = 'CONTRACT_ERROR', details?: Record<string, unknown>): Response {
  const error = new ContractError(message, code, details);
  return error.toResponse();
}

// Re-export standard error classes for convenience
export {
  NeoOSError,
  ContractError,
  NetworkError,
  ValidationError,
  AuthenticationError,
  errorToResponse,
  formatError,
};
