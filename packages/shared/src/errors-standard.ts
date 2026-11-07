/**
 * Standardized error classes for NeoOS services.
 * Provides structured error handling with machine-readable codes.
 */

import { NextResponse } from 'next/server';

/**
 * Base error class for all NeoOS errors.
 */
export class NeoOSError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 500,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Contract-related errors (blockchain interaction failures).
 */
export class ContractError extends NeoOSError {
  constructor(
    message: string,
    code: string = 'CONTRACT_ERROR',
    details?: Record<string, unknown>
  ) {
    super(message, code, 500, details);
  }
}

/**
 * Network-related errors (RPC, connectivity issues).
 */
export class NetworkError extends NeoOSError {
  constructor(
    message: string,
    code: string = 'NETWORK_ERROR',
    details?: Record<string, unknown>
  ) {
    super(message, code, 503, details);
  }
}

/**
 * Validation errors (invalid input, bad request).
 */
export class ValidationError extends NeoOSError {
  constructor(
    message: string,
    code: string = 'VALIDATION_ERROR',
    details?: Record<string, unknown>
  ) {
    super(message, code, 400, details);
  }
}

/**
 * Authentication errors (missing or invalid credentials).
 */
export class AuthenticationError extends NeoOSError {
  constructor(
    message: string,
    code: string = 'AUTHENTICATION_ERROR'
  ) {
    super(message, code, 401);
  }
}

/**
 * Convert an error to a NextResponse with proper status code and error format.
 */
export function errorToResponse(error: unknown): NextResponse {
  if (error instanceof NeoOSError) {
    return NextResponse.json(
      {
        error: error.message,
        error_code: error.code,
        ...(error.details && { details: error.details }),
      },
      { status: error.statusCode }
    );
  }

  // Unknown errors
  const message = error instanceof Error ? error.message : 'Unknown error';
  return NextResponse.json(
    { error: message, error_code: 'UNKNOWN_ERROR' },
    { status: 500 }
  );
}

/**
 * Format an error for logging or display.
 */
export function formatError(error: unknown): string {
  if (error instanceof NeoOSError) {
    return `[${error.code}] ${error.message}${
      error.details ? ` (${JSON.stringify(error.details)})` : ''
    }`;
  }

  return error instanceof Error ? error.message : String(error);
}
