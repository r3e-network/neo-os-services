export class ApiError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export class ConditionalConflictError extends Error {
  constructor(message = 'conditional state transition failed', cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'ConditionalConflictError';
  }
}

export function isConditionalAwsError(error) {
  return (
    error?.name === 'ConditionalCheckFailedException' ||
    error?.name === 'TransactionCanceledException' ||
    error?.name === 'IdempotentParameterMismatchException'
  );
}
