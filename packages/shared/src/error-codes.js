/**
 * Shared, versioned error-code schema used by workers, relayers, and contracts.
 *
 * Instead of free-text error messages, consumers can return a structured
 * `RelayerError` with a deterministic `ErrorCode`. The codes partition failures
 * into transient (retryable) and permanent (terminal) categories and are the
 * source of truth for `classifyError` in the relayer.
 */

/**
 * Deterministic error codes. Each code maps to exactly one decision:
 * - TRANSIENT_* errors are retried with exponential backoff.
 * - PERMANENT_* errors fast-fail to the dead-letter / finalize path.
 * - UNKNOWN errors are treated as transient (retry) by default, because
 *   finalizing a recoverable failure as a permanent on-chain failure is the
 *   worse outcome.
 *
 * @enum {string}
 */
export const ErrorCode = Object.freeze({
  TRANSIENT_NETWORK: 'TRANSIENT_NETWORK',
  TRANSIENT_RATE_LIMIT: 'TRANSIENT_RATE_LIMIT',
  TRANSIENT_WORKER: 'TRANSIENT_WORKER',
  PERMANENT_CONFIG: 'PERMANENT_CONFIG',
  PERMANENT_ALREADY_FULFILLED: 'PERMANENT_ALREADY_FULFILLED',
  PERMANENT_INVALID_REQUEST: 'PERMANENT_INVALID_REQUEST',
  UNKNOWN: 'UNKNOWN',
});

/**
 * Map each ErrorCode to the legacy classifier string level used by the relayer.
 *
 * @type {Readonly<Record<ErrorCode, 'transient' | 'permanent' | 'settled' | 'unknown'>>}
 */
const ERROR_CODE_LEVELS = Object.freeze({
  [ErrorCode.TRANSIENT_NETWORK]: 'transient',
  [ErrorCode.TRANSIENT_RATE_LIMIT]: 'transient',
  [ErrorCode.TRANSIENT_WORKER]: 'transient',
  [ErrorCode.PERMANENT_CONFIG]: 'permanent',
  [ErrorCode.PERMANENT_ALREADY_FULFILLED]: 'settled',
  [ErrorCode.PERMANENT_INVALID_REQUEST]: 'permanent',
  [ErrorCode.UNKNOWN]: 'unknown',
});

const ALL_ERROR_CODES = new Set(Object.values(ErrorCode));

/**
 * Return the legacy level for a known ErrorCode.
 *
 * @param {string} code
 * @returns {'transient' | 'permanent' | 'settled' | 'unknown'}
 */
export function getErrorCodeLevel(code) {
  return ERROR_CODE_LEVELS[code] ?? 'unknown';
}

/**
 * True when the supplied code is a retryable/transient code.
 *
 * @param {string} code
 * @returns {boolean}
 */
export function isRetryableErrorCode(code) {
  return (
    code === ErrorCode.TRANSIENT_NETWORK ||
    code === ErrorCode.TRANSIENT_RATE_LIMIT ||
    code === ErrorCode.TRANSIENT_WORKER ||
    code === ErrorCode.UNKNOWN
  );
}

/**
 * Structured error carrying a deterministic code, retryability hint, and an
 * optional underlying cause. Designed to be thrown by relayer/contract code and
 * consumed by the retry classifier.
 */
export class RelayerError extends Error {
  /**
   * @param {string} code - A value from {@link ErrorCode}.
   * @param {string} message - Human-readable description.
   * @param {Error | unknown} [cause] - Underlying cause, if any.
   */
  constructor(code, message, cause) {
    super(message);
    this.name = 'RelayerError';
    /** @type {string} */
    this.code = code;
    /** @type {boolean} */
    this.retryable = isRetryableErrorCode(code);
    if (cause !== undefined) {
      /** @type {Error | unknown} */
      this.cause = cause;
    }
    Error.captureStackTrace?.(this, this.constructor);
  }
}

/**
 * Normalize an arbitrary error value to a string message.
 *
 * @param {unknown} value
 * @returns {string}
 */
function normalizeErrorMessage(value) {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string') return value;
  return String(value);
}

/**
 * Build a classification result object for a given ErrorCode.
 *
 * @param {string} code
 * @returns {{ level: 'transient' | 'permanent' | 'settled' | 'unknown', code: string, retryable: boolean }}
 */
function classificationResult(code) {
  return {
    level: getErrorCodeLevel(code),
    code,
    retryable: isRetryableErrorCode(code),
  };
}

// Sentinel marker appended to transient worker failures by the prepare lanes.
const TRANSIENT_WORKER_ERROR_MARKER = '[transient-worker-status]';

/**
 * True when the normalized message indicates the request was already fulfilled.
 *
 * @param {string} normalized
 * @returns {boolean}
 */
function isAlreadyFulfilled(normalized) {
  return (
    normalized.includes('already fulfilled') ||
    normalized.includes('request already fulfilled') ||
    normalized.includes('reason: request already fulfilled')
  );
}

/**
 * True when the normalized message indicates a terminal configuration or
 * authorization problem (unauthorized verifier, missing updater, etc.).
 *
 * @param {string} normalized
 * @returns {boolean}
 */
function isTerminalConfiguration(normalized) {
  return (
    normalized.includes('reason: unauthorized') ||
    normalized.includes('unauthorized') ||
    normalized.includes('unauthorised') ||
    normalized.includes('forbidden') ||
    normalized.includes('invalid signature') ||
    normalized.includes('verifier rejected signature') ||
    normalized.includes('oracle verifier') ||
    normalized.includes('oracle_verifier') ||
    normalized.includes('updater not set') ||
    normalized.includes('callback not allowed') ||
    (normalized.includes('called contract') && normalized.includes('not found'))
  );
}

/**
 * True when the normalized message indicates a transient worker/upstream HTTP
 * status (5xx family, 429/408/425, or the transient worker marker).
 *
 * @param {string} normalized
 * @returns {boolean}
 */
function isTransientWorker(normalized) {
  return (
    normalized.includes(TRANSIENT_WORKER_ERROR_MARKER) ||
    /\b(429|408|425|500|502|503|504)\b/.test(normalized)
  );
}

/**
 * True when the normalized message indicates a network/connectivity failure.
 *
 * @param {string} normalized
 * @returns {boolean}
 */
function isTransientNetwork(normalized) {
  return (
    normalized.includes('etimedout') ||
    normalized.includes('econnrefused') ||
    normalized.includes('econnreset') ||
    normalized.includes('socket hang up') ||
    normalized.includes('network') ||
    normalized.includes('timed out') ||
    normalized.includes('unavailable')
  );
}

/**
 * True when the normalized message indicates an explicit rate limit.
 *
 * @param {string} normalized
 * @returns {boolean}
 */
function isRateLimit(normalized) {
  return normalized.includes('rate limit');
}

/**
 * True when the normalized message indicates a deterministic request rejection
 * that should be finalized as a permanent failure.
 *
 * @param {string} normalized
 * @returns {boolean}
 */
function isPermanentInvalid(normalized) {
  return (
    /\bnot found\b/.test(normalized) ||
    /\bfault/.test(normalized) ||
    /\bunauthori[sz]ed/.test(normalized) ||
    /\bforbidden/.test(normalized) ||
    /\binvalid/.test(normalized)
  );
}

/**
 * Classify a free-text error message into a structured ErrorCode result. This is
 * a compatibility shim that maps the existing substring/regex patterns from the
 * relayer classifier to the new schema.
 *
 * Priority matches the original classifier so that the same message always maps
 * to the same legacy level:
 *   1. settled (already fulfilled)
 *   2. permanent configuration/auth
 *   3. transient worker/network/rate-limit
 *   4. permanent deterministic rejection
 *   5. unknown
 *
 * @param {unknown} message
 * @returns {{ level: 'transient' | 'permanent' | 'settled' | 'unknown', code: string, retryable: boolean }}
 */
export function classifyErrorMessage(message) {
  const normalized = normalizeErrorMessage(message).toLowerCase();

  if (isAlreadyFulfilled(normalized)) {
    return classificationResult(ErrorCode.PERMANENT_ALREADY_FULFILLED);
  }

  if (isTerminalConfiguration(normalized)) {
    return classificationResult(ErrorCode.PERMANENT_CONFIG);
  }

  if (isTransientWorker(normalized)) {
    return classificationResult(ErrorCode.TRANSIENT_WORKER);
  }

  if (isTransientNetwork(normalized)) {
    return classificationResult(ErrorCode.TRANSIENT_NETWORK);
  }

  if (isRateLimit(normalized)) {
    return classificationResult(ErrorCode.TRANSIENT_RATE_LIMIT);
  }

  if (isPermanentInvalid(normalized)) {
    return classificationResult(ErrorCode.PERMANENT_INVALID_REQUEST);
  }

  return classificationResult(ErrorCode.UNKNOWN);
}

/**
 * Extract a known ErrorCode from an error object, or assign a fallback code.
 *
 * Handles:
 * - Error objects with a recognized `code` property.
 * - Plain strings (treated as the message and assigned the fallback code).
 * - Arbitrary values (coerced to string and assigned the fallback code).
 *
 * The returned `RelayerError` carries the resolved code, retryability, and the
 * original cause when available.
 *
 * @param {Error | { code?: string } | string | unknown} error
 * @param {string} [fallbackCode]
 * @returns {RelayerError}
 */
export function wrapError(error, fallbackCode = ErrorCode.UNKNOWN) {
  if (error instanceof RelayerError) return error;

  const message = normalizeErrorMessage(error);
  const candidateCode =
    error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  const code =
    typeof candidateCode === 'string' && ALL_ERROR_CODES.has(candidateCode)
      ? candidateCode
      : fallbackCode;

  const cause = error instanceof Error ? error : undefined;
  return new RelayerError(code, message, cause);
}
