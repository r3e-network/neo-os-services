import { normalizeErrorMessage } from '../feed-sync.js';
import {
  ErrorCode,
  classifyErrorMessage,
  getErrorCodeLevel,
  isRetryableErrorCode,
} from '@r3e-network/neo-os-services-shared/error-codes';

/**
 * Leaf error classification helpers. These functions inspect raw or normalized
 * error messages and decide whether an error is transient (retryable),
 * permanent (terminal), or already-settled. They are intentionally stateless
 * and have no side effects.
 */

/**
 * Trim and sanitize an on-chain error message before it is finalized in chain
 * state or mirrored to durable storage. URLs are redacted so infrastructure
 * endpoints (and any credentials embedded in authenticated RPC URLs) can never
 * leak through an error message.
 *
 * @param {*} value The raw error value (Error, string, number, etc.).
 * @param {number} maxLength Maximum length of the sanitized message.
 * @returns {string} Sanitized error text.
 */
export function trimOnchainErrorMessage(value, maxLength = 240) {
  const text = normalizeErrorMessage(value)
    .replace(/https?:\/\/[^\s\]]+/gi, '[redacted-url]')
    .trim();
  if (!text) return 'request execution failed';
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

/**
 * True when an error message indicates the on-chain request was already
 * fulfilled. Used to short-circuit retry loops for settled requests.
 *
 * @param {*} message The raw error value or message string.
 * @returns {boolean}
 */
export function isAlreadyFulfilledError(message) {
  const normalized = normalizeErrorMessage(message).toLowerCase();
  return (
    normalized.includes('already fulfilled') ||
    normalized.includes('request already fulfilled') ||
    normalized.includes('reason: request already fulfilled')
  );
}

/**
 * True when an error message indicates a terminal configuration or authorization
 * problem that will not be fixed by retrying (e.g. unauthorized verifier,
 * missing updater, callback not allowed).
 *
 * @param {*} message The raw error value or message string.
 * @returns {boolean}
 */
export function isTerminalConfigurationError(message) {
  const normalized = normalizeErrorMessage(message).toLowerCase();
  return (
    normalized.includes('reason: unauthorized') ||
    normalized.includes('invalid signature') ||
    normalized.includes('verifier rejected signature') ||
    normalized.includes('oracle verifier') ||
    // The enclave signer surfaces the role with an underscore ("oracle_verifier
    // signing key not configured"); match both so a real verifier-misprovision
    // fast-fails as terminal instead of burning the full retry budget.
    normalized.includes('oracle_verifier') ||
    normalized.includes('updater not set') ||
    normalized.includes('callback not allowed') ||
    // The production VRF fail-closed guard (executor.js random.generate lane):
    // the relayer must enable enclave fulfillment, not burn the retry budget.
    normalized.includes('enclave fulfillment required') ||
    (normalized.includes('called contract') && normalized.includes('not found'))
  );
}

// Worker/upstream HTTP status codes that are retryable (transient infrastructure
// failures), NOT deterministic request rejections. A worker HTTP 5xx/429/408/425
// — or a 0 (no response / aborted) — is a momentary overload, an upstream rate
// limit, or a connectivity blip; it must be retried, never burned into a
// permanent on-chain failure callback. Deterministic 4xx (400/401/403/404/409/422)
// stay on the deliver-as-failure path because re-running the same request would
// produce the same rejection.
const TRANSIENT_WORKER_HTTP_STATUSES = new Set([0, 408, 425, 429, 500, 502, 503, 504]);

/**
 * True when a worker HTTP status is a retryable infrastructure failure (5xx
 * family, 429 rate-limit, 408/425 request-timeout, or 0 no-response). Used by
 * the prepare lanes to short-circuit a transient worker failure into a retry
 * BEFORE it is encoded into an on-chain failure callback. Deterministic 4xx
 * (400/401/403/404/409/422) are NOT transient.
 *
 * @param {*} status The HTTP status code (number or numeric string).
 * @returns {boolean}
 */
export function isTransientWorkerStatus(status) {
  // Only treat an actual numeric status as transient. null/undefined/non-numeric
  // must NOT coerce to 0 (Number(null) === 0) and accidentally match.
  if (typeof status !== 'number' && typeof status !== 'string') return false;
  if (typeof status === 'string' && status.trim() === '') return false;
  const numeric = Number(status);
  if (!Number.isFinite(numeric)) return false;
  return TRANSIENT_WORKER_HTTP_STATUSES.has(numeric);
}

// Sentinel marker appended to the message of a transient-worker-failure error so
// the (already-thrown, then re-classified) error reliably routes through the
// retry path even if the raw status text alone would not match classifyError's
// transient keyword set.
const TRANSIENT_WORKER_ERROR_MARKER = '[transient-worker-status]';

/**
 * Build a transient-classified error for a retryable worker/upstream HTTP status
 * so the prepare lanes can throw instead of finalizing a permanent failure
 * callback. The thrown error is caught by processEvent's catch block and
 * re-classified via classifyError (which recognizes the status code), so the
 * request is retried like any other transient failure.
 *
 * @param {*} status The HTTP status code.
 * @param {string} detail Optional extra detail text.
 * @returns {Error}
 */
export function buildTransientWorkerError(status, detail = '') {
  const numeric = Number(status);
  const statusText = Number.isFinite(numeric) ? numeric : 'unknown';
  const suffix = detail ? `: ${normalizeErrorMessage(detail)}` : '';
  return new Error(
    `worker request failed with transient status ${statusText}${suffix} ${TRANSIENT_WORKER_ERROR_MARKER}`
  );
}

/**
 * Classify an error as transient (network/rate-limit), permanent (auth/not-found),
 * settled (already fulfilled), or unknown to guide retry decisions. Transient
 * errors are always retried; permanent errors skip straight to the dead-letter /
 * finalize path.
 *
 * The classifier prefers a structured `ErrorCode` on the error object when
 * present; otherwise it falls back to the shared string classifier. The returned
 * object carries the legacy `level` string so existing consumers that compare
 * against `'transient' | 'permanent' | 'settled' | 'unknown'` can continue to do
 * so via `result.level`.
 *
 * @param {*} err The error value to classify.
 * @returns {{ level: 'transient'|'permanent'|'settled'|'unknown', code: string, retryable: boolean }}
 */
export function classifyError(err) {
  const rawCode = err?.code;
  if (typeof rawCode === 'string' && Object.values(ErrorCode).includes(rawCode)) {
    return {
      level: getErrorCodeLevel(rawCode),
      code: rawCode,
      retryable: isRetryableErrorCode(rawCode),
    };
  }
  return classifyErrorMessage(normalizeErrorMessage(err));
}
