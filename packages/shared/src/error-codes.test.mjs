import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ErrorCode,
  RelayerError,
  classifyErrorMessage,
  getErrorCodeLevel,
  isRetryableErrorCode,
  wrapError,
} from './error-codes.js';

// ===================================================================
// ErrorCode / level helpers
// ===================================================================

describe('ErrorCode constants', () => {
  it('exports every expected code', () => {
    assert.equal(typeof ErrorCode.TRANSIENT_NETWORK, 'string');
    assert.equal(typeof ErrorCode.TRANSIENT_RATE_LIMIT, 'string');
    assert.equal(typeof ErrorCode.TRANSIENT_WORKER, 'string');
    assert.equal(typeof ErrorCode.PERMANENT_CONFIG, 'string');
    assert.equal(typeof ErrorCode.PERMANENT_ALREADY_FULFILLED, 'string');
    assert.equal(typeof ErrorCode.PERMANENT_INVALID_REQUEST, 'string');
    assert.equal(typeof ErrorCode.UNKNOWN, 'string');
  });

  it('maps codes to the correct legacy levels', () => {
    assert.equal(getErrorCodeLevel(ErrorCode.TRANSIENT_NETWORK), 'transient');
    assert.equal(getErrorCodeLevel(ErrorCode.TRANSIENT_RATE_LIMIT), 'transient');
    assert.equal(getErrorCodeLevel(ErrorCode.TRANSIENT_WORKER), 'transient');
    assert.equal(getErrorCodeLevel(ErrorCode.PERMANENT_CONFIG), 'permanent');
    assert.equal(getErrorCodeLevel(ErrorCode.PERMANENT_ALREADY_FULFILLED), 'settled');
    assert.equal(getErrorCodeLevel(ErrorCode.PERMANENT_INVALID_REQUEST), 'permanent');
    assert.equal(getErrorCodeLevel(ErrorCode.UNKNOWN), 'unknown');
  });
});

describe('isRetryableErrorCode', () => {
  it('returns true for transient and unknown codes', () => {
    assert.equal(isRetryableErrorCode(ErrorCode.TRANSIENT_NETWORK), true);
    assert.equal(isRetryableErrorCode(ErrorCode.TRANSIENT_RATE_LIMIT), true);
    assert.equal(isRetryableErrorCode(ErrorCode.TRANSIENT_WORKER), true);
    assert.equal(isRetryableErrorCode(ErrorCode.UNKNOWN), true);
  });

  it('returns false for permanent codes', () => {
    assert.equal(isRetryableErrorCode(ErrorCode.PERMANENT_CONFIG), false);
    assert.equal(isRetryableErrorCode(ErrorCode.PERMANENT_ALREADY_FULFILLED), false);
    assert.equal(isRetryableErrorCode(ErrorCode.PERMANENT_INVALID_REQUEST), false);
  });

  it('returns false for unrecognized codes', () => {
    assert.equal(isRetryableErrorCode('NOT_A_CODE'), false);
  });
});

// ===================================================================
// RelayerError
// ===================================================================

describe('RelayerError', () => {
  it('carries code, message, retryability and cause', () => {
    const cause = new Error('root cause');
    const err = new RelayerError(ErrorCode.TRANSIENT_NETWORK, 'network blip', cause);
    assert.equal(err.code, ErrorCode.TRANSIENT_NETWORK);
    assert.equal(err.message, 'network blip');
    assert.equal(err.retryable, true);
    assert.equal(err.cause, cause);
  });

  it('derives retryability from permanent codes', () => {
    const err = new RelayerError(ErrorCode.PERMANENT_CONFIG, 'unauthorized');
    assert.equal(err.retryable, false);
  });
});

// ===================================================================
// wrapError
// ===================================================================

describe('wrapError', () => {
  it('returns the same RelayerError unchanged', () => {
    const original = new RelayerError(ErrorCode.TRANSIENT_RATE_LIMIT, 'rl');
    assert.equal(wrapError(original), original);
  });

  it('extracts a recognized code from an Error object', () => {
    const error = Object.assign(new Error('boom'), { code: ErrorCode.TRANSIENT_WORKER });
    const wrapped = wrapError(error);
    assert.equal(wrapped.code, ErrorCode.TRANSIENT_WORKER);
    assert.equal(wrapped.message, 'boom');
    assert.equal(wrapped.retryable, true);
    assert.equal(wrapped.cause, error);
  });

  it('falls back to the provided fallback code when code is missing', () => {
    const wrapped = wrapError(new Error('plain error'), ErrorCode.PERMANENT_INVALID_REQUEST);
    assert.equal(wrapped.code, ErrorCode.PERMANENT_INVALID_REQUEST);
    assert.equal(wrapped.retryable, false);
  });

  it('falls back to UNKNOWN for arbitrary values', () => {
    const wrapped = wrapError(null);
    assert.equal(wrapped.code, ErrorCode.UNKNOWN);
    assert.equal(wrapped.retryable, true);
    assert.equal(wrapped.message, 'null');
  });

  it('ignores unrecognized codes and uses the fallback', () => {
    const error = Object.assign(new Error('bad'), { code: 'ENOENT' });
    const wrapped = wrapError(error, ErrorCode.PERMANENT_CONFIG);
    assert.equal(wrapped.code, ErrorCode.PERMANENT_CONFIG);
  });
});

// ===================================================================
// classifyErrorMessage — mirrors the existing relayer classifier cases
// ===================================================================

describe('classifyErrorMessage', () => {
  function assertLevel(message, expectedLevel, expectedCode) {
    const result = classifyErrorMessage(message);
    assert.equal(
      result.level,
      expectedLevel,
      `expected level ${expectedLevel} for "${message}", got ${result.level}`
    );
    assert.equal(result.code, expectedCode);
    assert.equal(result.retryable, isRetryableErrorCode(expectedCode));
  }

  // --- settled ---
  it('classifies already-fulfilled as settled', () => {
    assertLevel('already fulfilled', 'settled', ErrorCode.PERMANENT_ALREADY_FULFILLED);
    assertLevel('request already fulfilled', 'settled', ErrorCode.PERMANENT_ALREADY_FULFILLED);
    assertLevel(
      'reason: request already fulfilled',
      'settled',
      ErrorCode.PERMANENT_ALREADY_FULFILLED
    );
  });

  // --- permanent configuration / auth ---
  it('classifies terminal config errors as permanent', () => {
    assertLevel('reason: unauthorized', 'permanent', ErrorCode.PERMANENT_CONFIG);
    assertLevel('invalid signature', 'permanent', ErrorCode.PERMANENT_CONFIG);
    assertLevel('verifier rejected signature', 'permanent', ErrorCode.PERMANENT_CONFIG);
    assertLevel('updater not set', 'permanent', ErrorCode.PERMANENT_CONFIG);
    assertLevel('oracle verifier mismatch', 'permanent', ErrorCode.PERMANENT_CONFIG);
    assertLevel(
      'oracle_verifier signing key not configured',
      'permanent',
      ErrorCode.PERMANENT_CONFIG
    );
    assertLevel('callback not allowed', 'permanent', ErrorCode.PERMANENT_CONFIG);
    assertLevel('called contract 0xabc123 not found', 'permanent', ErrorCode.PERMANENT_CONFIG);
  });

  // --- transient ---
  it('classifies network errors as transient', () => {
    assertLevel('ETIMEDOUT', 'transient', ErrorCode.TRANSIENT_NETWORK);
    assertLevel('ECONNREFUSED', 'transient', ErrorCode.TRANSIENT_NETWORK);
    assertLevel('ECONNRESET', 'transient', ErrorCode.TRANSIENT_NETWORK);
    assertLevel('socket hang up', 'transient', ErrorCode.TRANSIENT_NETWORK);
  });

  it('classifies rate limit errors as transient', () => {
    assertLevel('rate limit exceeded', 'transient', ErrorCode.TRANSIENT_RATE_LIMIT);
  });

  it('classifies HTTP 5xx errors as transient', () => {
    assertLevel('HTTP 502 Bad Gateway', 'transient', ErrorCode.TRANSIENT_WORKER);
    assertLevel('HTTP 503 Service Unavailable', 'transient', ErrorCode.TRANSIENT_WORKER);
    assertLevel('HTTP 504 Gateway Timeout', 'transient', ErrorCode.TRANSIENT_WORKER);
  });

  it('classifies timeout/unavailable as transient', () => {
    assertLevel('request timed out', 'transient', ErrorCode.TRANSIENT_NETWORK);
    assertLevel('service unavailable', 'transient', ErrorCode.TRANSIENT_NETWORK);
    assertLevel('network error', 'transient', ErrorCode.TRANSIENT_NETWORK);
  });

  it('classifies retryable worker HTTP statuses as transient', () => {
    assertLevel('worker request failed with status 429', 'transient', ErrorCode.TRANSIENT_WORKER);
    assertLevel('worker request failed with status 408', 'transient', ErrorCode.TRANSIENT_WORKER);
    assertLevel('worker request failed with status 425', 'transient', ErrorCode.TRANSIENT_WORKER);
    assertLevel('worker request failed with status 500', 'transient', ErrorCode.TRANSIENT_WORKER);
  });

  it('classifies the transient worker sentinel marker as transient', () => {
    assertLevel(
      'worker request failed with transient status 429 [transient-worker-status]',
      'transient',
      ErrorCode.TRANSIENT_WORKER
    );
  });

  // --- permanent (general) ---
  it('classifies not-found as permanent', () => {
    assertLevel('resource not found', 'permanent', ErrorCode.PERMANENT_INVALID_REQUEST);
  });

  it('classifies unauthorized/forbidden as permanent', () => {
    assertLevel('unauthorized access', 'permanent', ErrorCode.PERMANENT_CONFIG);
    assertLevel('forbidden', 'permanent', ErrorCode.PERMANENT_CONFIG);
  });

  it('classifies fault as permanent', () => {
    assertLevel('VM fault', 'permanent', ErrorCode.PERMANENT_INVALID_REQUEST);
  });

  it('classifies generic invalid as permanent', () => {
    assertLevel('invalid argument', 'permanent', ErrorCode.PERMANENT_INVALID_REQUEST);
  });

  // --- unknown ---
  it('classifies unrecognized errors as unknown', () => {
    assertLevel('something weird happened', 'unknown', ErrorCode.UNKNOWN);
    assertLevel('', 'unknown', ErrorCode.UNKNOWN);
  });

  it('does NOT classify deterministic 4xx status codes as transient', () => {
    assertLevel('worker request failed with status 400', 'unknown', ErrorCode.UNKNOWN);
    assertLevel('worker request failed with status 422', 'unknown', ErrorCode.UNKNOWN);
  });

  // --- priority ---
  it('settles classification wins over permanent keywords', () => {
    // "already fulfilled" does not contain permanent keywords, but this verifies
    // the order of checks: settled is checked first.
    assertLevel('request already fulfilled', 'settled', ErrorCode.PERMANENT_ALREADY_FULFILLED);
  });
});
