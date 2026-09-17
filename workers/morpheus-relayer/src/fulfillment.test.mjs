import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createHash } from 'node:crypto';

import {
  buildDecryptBindingRequest,
  buildTransientWorkerError,
  classifyError,
  computeRetryDelayMs,
  enrichAutomationExecutionPayload,
  isAlreadyFulfilledError,
  isQueuedAutomationExecutionPayload,
  isTerminalConfigurationError,
  isTransientWorkerStatus,
  processEvent,
  resolveCallbackRetryCeiling,
  resolveEventFulfillmentContext,
  resolveExpectedPcr0,
  resolveFulfillmentSigningContext,
  resolveNitroRootCertPem,
  trimOnchainErrorMessage,
  verifyEnclaveAttestation,
  verifyEnclaveSignatureAgainstPinnedVerifier,
} from './fulfillment.js';
import { buildEventKey, createEmptyRelayerState } from './state.js';
import {
  markSupabasePersistenceUnavailable,
  resetSupabasePersistenceBackoffForTests,
} from './persistence.js';
import { buildFulfillmentDigestBytes, encodeFulfillmentResult } from './router.js';
import { buildNeoXDigest, resolveResultBytesHex } from './neox.js';
import { ErrorCode } from '@r3e-network/neo-os-services-shared/error-codes';

// ===================================================================
// Custody signer service stubs
// ===================================================================

// The testnet oracle_verifier public key pinned in config/signer-identities.json.
// signFulfillmentPayload cross-checks the custody signer's returned public key
// against this pinned identity, so every /sign/raw stub must sign for it.
const PINNED_TESTNET_VERIFIER_PK =
  '02911ea28aee939ef686f42e1137954135998b71e7e997794bde8c0a40f4b95cb4';

function custodySignRawResponse(signatureHex) {
  return new Response(
    JSON.stringify({
      key_id: 'key-oracle-verifier',
      script_hash: '0x' + 'e'.repeat(40),
      address: 'N' + 'e'.repeat(33),
      digest: 'ab'.repeat(32),
      signature: signatureHex,
      public_key: PINNED_TESTNET_VERIFIER_PK,
      invocation_script: `0c40${signatureHex}`,
      verification_script: `0c21${PINNED_TESTNET_VERIFIER_PK}4156e7b327`,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
}

// ===================================================================
// trimOnchainErrorMessage
// ===================================================================

describe('trimOnchainErrorMessage', () => {
  it('returns default message for empty/blank input', () => {
    assert.equal(trimOnchainErrorMessage(''), 'request execution failed');
    assert.equal(trimOnchainErrorMessage('   '), 'request execution failed');
  });

  it('passes through short messages unchanged', () => {
    assert.equal(trimOnchainErrorMessage('something went wrong'), 'something went wrong');
  });

  it('truncates messages exceeding maxLength', () => {
    const long = 'a'.repeat(300);
    const result = trimOnchainErrorMessage(long, 240);
    assert.ok(result.length <= 240);
    assert.ok(result.endsWith('...'));
  });

  it('handles Error objects', () => {
    const result = trimOnchainErrorMessage(new Error('test error'));
    assert.equal(result, 'test error');
  });

  it('handles non-string types', () => {
    const result = trimOnchainErrorMessage(42);
    assert.equal(result, '42');
  });

  it('respects custom maxLength', () => {
    const msg = 'a'.repeat(50);
    const result = trimOnchainErrorMessage(msg, 20);
    assert.ok(result.length <= 20);
    assert.ok(result.endsWith('...'));
  });

  it('redacts URLs so finalized error text cannot leak infrastructure endpoints', () => {
    const message =
      'request 42 not found [oracle_contract=0xabc rpc_url=https://user:secret@mainnet1.neo.coz.io:443/rpc]';
    const result = trimOnchainErrorMessage(message);
    assert.ok(!result.includes('http'), `expected no URL in: ${result}`);
    assert.ok(!result.includes('secret'));
    assert.match(result, /\[redacted-url\]/);
    assert.match(result, /request 42 not found/);
  });

  it('redacts RPC endpoints embedded by the Neo RPC error formatter', () => {
    const result = trimOnchainErrorMessage(
      'Neo RPC invokefunction failed via http://seed1.neo.org:10332 (503): unavailable'
    );
    assert.ok(!result.includes('seed1.neo.org'));
    assert.match(result, /Neo RPC invokefunction failed via \[redacted-url\] \(503\)/);
  });
});

// ===================================================================
// isAlreadyFulfilledError
// ===================================================================

describe('isAlreadyFulfilledError', () => {
  it('detects "already fulfilled" in various forms', () => {
    assert.equal(isAlreadyFulfilledError('already fulfilled'), true);
    assert.equal(isAlreadyFulfilledError('Request Already Fulfilled'), true);
    assert.equal(isAlreadyFulfilledError('reason: request already fulfilled'), true);
    assert.equal(isAlreadyFulfilledError('ALREADY FULFILLED by another node'), true);
  });

  it('returns false for unrelated errors', () => {
    assert.equal(isAlreadyFulfilledError('network timeout'), false);
    assert.equal(isAlreadyFulfilledError('unauthorized'), false);
    assert.equal(isAlreadyFulfilledError(''), false);
  });

  it('handles Error objects', () => {
    assert.equal(isAlreadyFulfilledError(new Error('already fulfilled')), true);
    assert.equal(isAlreadyFulfilledError(new Error('timeout')), false);
  });
});

// ===================================================================
// isTerminalConfigurationError
// ===================================================================

describe('isTerminalConfigurationError', () => {
  it('detects unauthorized errors', () => {
    assert.equal(isTerminalConfigurationError('reason: unauthorized'), true);
  });

  it('detects invalid signature errors', () => {
    assert.equal(isTerminalConfigurationError('invalid signature for request'), true);
    assert.equal(isTerminalConfigurationError('verifier rejected signature'), true);
  });

  it('detects oracle verifier errors', () => {
    assert.equal(isTerminalConfigurationError('oracle verifier mismatch'), true);
  });

  it('detects updater not set', () => {
    assert.equal(isTerminalConfigurationError('updater not set'), true);
  });

  it('detects callback not allowed', () => {
    assert.equal(isTerminalConfigurationError('callback not allowed'), true);
  });

  it('detects called contract not found', () => {
    assert.equal(isTerminalConfigurationError('called contract 0xabc123 not found'), true);
  });

  it('detects the production VRF fail-closed refusal (M-vrf)', () => {
    assert.equal(
      isTerminalConfigurationError(
        'enclave fulfillment required in production: random.generate refuses the relayer-local VRF fallback'
      ),
      true
    );
  });

  it('returns false for transient errors', () => {
    assert.equal(isTerminalConfigurationError('ETIMEDOUT'), false);
    assert.equal(isTerminalConfigurationError('rate limit exceeded'), false);
    assert.equal(isTerminalConfigurationError('socket hang up'), false);
  });
});

// ===================================================================
// classifyError
// ===================================================================

describe('classifyError', () => {
  // --- settled ---
  it('classifies already-fulfilled as settled', () => {
    assert.equal(classifyError('already fulfilled').level, 'settled');
    assert.equal(classifyError('request already fulfilled').level, 'settled');
  });

  // --- permanent (terminal config) ---
  it('classifies terminal config errors as permanent', () => {
    assert.equal(classifyError('reason: unauthorized').level, 'permanent');
    assert.equal(classifyError('invalid signature').level, 'permanent');
    assert.equal(classifyError('verifier rejected signature').level, 'permanent');
    assert.equal(classifyError('updater not set').level, 'permanent');
  });

  // --- transient ---
  it('classifies network errors as transient', () => {
    assert.equal(classifyError('ETIMEDOUT').level, 'transient');
    assert.equal(classifyError('ECONNREFUSED').level, 'transient');
    assert.equal(classifyError('ECONNRESET').level, 'transient');
    assert.equal(classifyError('socket hang up').level, 'transient');
  });

  it('classifies rate limit errors as transient', () => {
    assert.equal(classifyError('rate limit exceeded').level, 'transient');
  });

  it('classifies HTTP 5xx errors as transient', () => {
    assert.equal(classifyError('HTTP 502 Bad Gateway').level, 'transient');
    assert.equal(classifyError('HTTP 503 Service Unavailable').level, 'transient');
    assert.equal(classifyError('HTTP 504 Gateway Timeout').level, 'transient');
  });

  it('classifies timeout/unavailable as transient', () => {
    assert.equal(classifyError('request timed out').level, 'transient');
    assert.equal(classifyError('service unavailable').level, 'transient');
    assert.equal(classifyError('network error').level, 'transient');
  });

  // --- permanent (general) ---
  it('classifies not-found as permanent', () => {
    assert.equal(classifyError('resource not found').level, 'permanent');
  });

  it('classifies unauthorized/forbidden as permanent', () => {
    assert.equal(classifyError('unauthorized access').level, 'permanent');
    assert.equal(classifyError('forbidden').level, 'permanent');
  });

  it('classifies fault as permanent', () => {
    assert.equal(classifyError('VM fault').level, 'permanent');
  });

  it('classifies generic invalid as permanent', () => {
    assert.equal(classifyError('invalid argument').level, 'permanent');
  });

  // --- unknown ---
  it('classifies unrecognized errors as unknown', () => {
    assert.equal(classifyError('something weird happened').level, 'unknown');
    assert.equal(classifyError('').level, 'unknown');
  });

  // --- handles Error objects ---
  it('handles Error objects', () => {
    assert.equal(classifyError(new Error('ECONNRESET')).level, 'transient');
    assert.equal(classifyError(new Error('already fulfilled')).level, 'settled');
  });

  // --- settled takes priority over permanent keywords ---
  it('settled classification takes priority over permanent keywords', () => {
    // "already fulfilled" contains no permanent keywords, but let's verify
    // that the order of checks matters: settled is checked first
    assert.equal(classifyError('request already fulfilled').level, 'settled');
  });

  // --- B1: retryable worker HTTP statuses (429/408/425/500) classify transient ---
  it('classifies retryable worker HTTP statuses (429/408/425/500) as transient', () => {
    assert.equal(classifyError('worker request failed with status 429').level, 'transient');
    assert.equal(classifyError('worker request failed with status 408').level, 'transient');
    assert.equal(classifyError('worker request failed with status 425').level, 'transient');
    assert.equal(classifyError('worker request failed with status 500').level, 'transient');
  });

  it('classifies a buildTransientWorkerError marker as transient regardless of status text', () => {
    // The sentinel marker guarantees the retry path even if the status text alone
    // would not match the transient keyword set.
    assert.equal(classifyError(buildTransientWorkerError(429)).level, 'transient');
    assert.equal(
      classifyError(buildTransientWorkerError(500, 'upstream overloaded')).level,
      'transient'
    );
    assert.equal(classifyError(buildTransientWorkerError(0)).level, 'transient');
  });

  it('does NOT classify deterministic 4xx status codes as transient', () => {
    // 400/401/403/404/409/422 are deterministic rejections — re-running reproduces
    // them, so they must NOT route to the transient retry path here.
    assert.equal(classifyError('worker request failed with status 400').level, 'unknown');
    assert.equal(classifyError('worker request failed with status 422').level, 'unknown');
    // (401/403/404 contain permanent keywords elsewhere, but a bare status string
    // is at worst 'unknown' — never 'transient'.)
    assert.notEqual(classifyError('worker request failed with status 409').level, 'transient');
  });

  it('returns a structured object with level, code and retryable', () => {
    const result = classifyError('ETIMEDOUT');
    assert.equal(typeof result, 'object');
    assert.equal(result.level, 'transient');
    assert.equal(result.code, ErrorCode.TRANSIENT_NETWORK);
    assert.equal(result.retryable, true);
  });

  it('prefers a known ErrorCode on the error object over string parsing', () => {
    const error = Object.assign(new Error('some weird upstream text'), {
      code: ErrorCode.TRANSIENT_RATE_LIMIT,
    });
    const result = classifyError(error);
    assert.equal(result.level, 'transient');
    assert.equal(result.code, ErrorCode.TRANSIENT_RATE_LIMIT);
    assert.equal(result.retryable, true);
  });

  it('falls back to string classification when error.code is unrecognized', () => {
    const error = Object.assign(new Error('already fulfilled'), { code: 'ENOENT' });
    const result = classifyError(error);
    assert.equal(result.level, 'settled');
    assert.equal(result.code, ErrorCode.PERMANENT_ALREADY_FULFILLED);
  });
});

// ===================================================================
// isTransientWorkerStatus (B1)
// ===================================================================

describe('isTransientWorkerStatus', () => {
  it('treats 5xx, 429, 408/425 and 0 as transient', () => {
    for (const status of [0, 408, 425, 429, 500, 502, 503, 504]) {
      assert.equal(isTransientWorkerStatus(status), true, `status ${status} should be transient`);
    }
  });

  it('treats deterministic 4xx and 2xx as non-transient', () => {
    for (const status of [200, 400, 401, 403, 404, 409, 422]) {
      assert.equal(
        isTransientWorkerStatus(status),
        false,
        `status ${status} should not be transient`
      );
    }
  });

  it('treats non-numeric/missing status as non-transient', () => {
    assert.equal(isTransientWorkerStatus(undefined), false);
    assert.equal(isTransientWorkerStatus(null), false);
    assert.equal(isTransientWorkerStatus('not-a-number'), false);
  });
});

// ===================================================================
// computeRetryDelayMs
// ===================================================================

describe('computeRetryDelayMs', () => {
  const config = {
    retryBaseDelayMs: 1000,
    retryMaxDelayMs: 30000,
  };
  // Pin jitter to its upper bound (factor 1.0) to assert the deterministic
  // exponential-backoff ceiling. rng=()=>1 -> 0.5 + 0.5*1 = 1.0.
  const fullDelay = (attempts) => computeRetryDelayMs(config, attempts, () => 1);

  it('returns base delay for first attempt', () => {
    assert.equal(fullDelay(1), 1000);
  });

  it('doubles delay with each attempt (exponential backoff)', () => {
    assert.equal(fullDelay(1), 1000);
    assert.equal(fullDelay(2), 2000);
    assert.equal(fullDelay(3), 4000);
    assert.equal(fullDelay(4), 8000);
  });

  it('caps at retryMaxDelayMs', () => {
    assert.equal(fullDelay(10), 30000);
    assert.equal(fullDelay(20), 30000);
  });

  it('handles zero attempts (uses base delay)', () => {
    assert.equal(fullDelay(0), 1000);
  });

  it('handles negative attempts (uses base delay)', () => {
    assert.equal(fullDelay(-1), 1000);
  });

  it('works with different config values', () => {
    const custom = { retryBaseDelayMs: 500, retryMaxDelayMs: 5000 };
    assert.equal(
      computeRetryDelayMs(custom, 1, () => 1),
      500
    );
    assert.equal(
      computeRetryDelayMs(custom, 2, () => 1),
      1000
    );
    assert.equal(
      computeRetryDelayMs(custom, 4, () => 1),
      4000
    );
    assert.equal(
      computeRetryDelayMs(custom, 5, () => 1),
      5000
    ); // capped
  });

  it('applies full jitter within [0.5, 1.0] * ceiling (lower bound)', () => {
    // rng=()=>0 -> factor 0.5 -> half the deterministic ceiling.
    assert.equal(
      computeRetryDelayMs(config, 1, () => 0),
      500
    );
    assert.equal(
      computeRetryDelayMs(config, 3, () => 0),
      2000
    );
    // Capped attempt still halves: 30000 * 0.5 = 15000.
    assert.equal(
      computeRetryDelayMs(config, 20, () => 0),
      15000
    );
  });

  it('jitters two equal-attempt delays to different values', () => {
    // Same attempt, different rng draws -> different scheduled delays so a
    // shared-dependency outage does not synchronize retries into one bucket.
    const a = computeRetryDelayMs(config, 3, () => 0.2);
    const b = computeRetryDelayMs(config, 3, () => 0.8);
    assert.notEqual(a, b);
    // Both stay within the jitter band [0.5, 1.0] * ceiling (ceiling=4000).
    for (const value of [a, b]) {
      assert.ok(value >= 2000, `${value} >= 2000`);
      assert.ok(value <= 4000, `${value} <= 4000`);
    }
  });

  it('defaults to Math.random and stays within the jitter band', () => {
    // No rng argument exercises the production default path.
    for (let i = 0; i < 50; i += 1) {
      const value = computeRetryDelayMs(config, 4); // ceiling 8000
      assert.ok(value >= 4000 && value <= 8000, `${value} in [4000, 8000]`);
    }
  });
});

// ===================================================================
// resolveFulfillmentSigningContext
// ===================================================================

describe('resolveFulfillmentSigningContext', () => {
  it('uses the legacy digest domain for legacy Neo N3 requests', () => {
    assert.deepEqual(
      resolveFulfillmentSigningContext('neo_n3', {
        requestId: '4453',
        requestType: 'privacy_oracle',
        appId: '',
        moduleId: '',
        operation: '',
      }),
      { chain: 'legacy', appId: '', moduleId: '', operation: '' }
    );
  });

  it('preserves kernel digest context when app and module are present', () => {
    assert.deepEqual(
      resolveFulfillmentSigningContext('neo_n3', {
        appId: 'miniapp-os',
        moduleId: 'oracle.fetch',
        operation: 'privacy_oracle',
      }),
      {
        chain: 'neo_n3',
        appId: 'miniapp-os',
        moduleId: 'oracle.fetch',
        operation: 'privacy_oracle',
      }
    );
  });
});

describe('resolveEventFulfillmentContext', () => {
  it('prefers the on-chain miniapp envelope over the internal route mapping', () => {
    assert.deepEqual(
      resolveEventFulfillmentContext(
        {
          appId: 'morpheus.platform.game',
          moduleId: 'vrf_random',
          operation: 'vrf_random',
        },
        {
          moduleId: 'random.generate',
          operation: 'vrf_random',
        }
      ),
      {
        appId: 'morpheus.platform.game',
        moduleId: 'vrf_random',
        operation: 'vrf_random',
      }
    );
  });

  it('falls back to the legacy kernel mapping when old events lack envelope fields', () => {
    assert.deepEqual(
      resolveEventFulfillmentContext(
        {
          requestType: 'privacy_oracle',
        },
        {
          moduleId: 'oracle.fetch',
          operation: 'privacy_oracle',
        }
      ),
      {
        appId: '',
        moduleId: 'oracle.fetch',
        operation: 'privacy_oracle',
      }
    );
  });
});

// ===================================================================
// enrichAutomationExecutionPayload
// ===================================================================

describe('enrichAutomationExecutionPayload', () => {
  it('enriches automation payloads without throwing and preserves explicit identifiers', () => {
    const payload = enrichAutomationExecutionPayload(
      {
        chain: 'neo_n3',
        requestType: 'automation_upkeep',
        requestId: '42',
      },
      {
        automation_id: 'job-7',
        execution_id: 'custom-execution',
        workflow_id: 'custom.workflow',
        request_id: 'custom-request',
        idempotency_key: 'custom-idempotency',
      }
    );

    assert.equal(payload.execution_id, 'custom-execution');
    assert.equal(payload.workflow_id, 'custom.workflow');
    assert.equal(payload.request_id, 'custom-request');
    assert.equal(payload.idempotency_key, 'custom-idempotency');
  });
});

describe('isQueuedAutomationExecutionPayload', () => {
  it('does not treat regular oracle payloads as automation executions', () => {
    assert.equal(isQueuedAutomationExecutionPayload({ url: 'https://prices.test/neo' }), false);
    assert.equal(isQueuedAutomationExecutionPayload('raw payload'), false);
    assert.equal(isQueuedAutomationExecutionPayload(null), false);
  });

  it('detects scheduler execution payloads', () => {
    assert.equal(
      isQueuedAutomationExecutionPayload({
        automation_id: 'automation:neo_n3:test',
        workflow_id: 'automation.upkeep',
      }),
      true
    );
    assert.equal(
      isQueuedAutomationExecutionPayload({
        automationId: 'automation:neo_n3:test',
        executionId: 'execution-1',
      }),
      true
    );
  });
});

// ===================================================================
// resolveCallbackRetryCeiling
// ===================================================================

describe('resolveCallbackRetryCeiling', () => {
  it('defaults to maxRetries * 2', () => {
    assert.equal(resolveCallbackRetryCeiling({ maxRetries: 5 }), 10);
    assert.equal(resolveCallbackRetryCeiling({ maxRetries: 3 }), 6);
  });

  it('honours an explicit maxCallbackRetries', () => {
    assert.equal(resolveCallbackRetryCeiling({ maxRetries: 5, maxCallbackRetries: 3 }), 3);
  });

  it('never drops below one attempt', () => {
    assert.equal(resolveCallbackRetryCeiling({ maxRetries: 0 }), 1);
    assert.equal(resolveCallbackRetryCeiling({}), 1);
  });
});

// ===================================================================
// processEvent retry exhaustion (callback delivery + failure finalize)
// ===================================================================

describe('processEvent delivery retry exhaustion', () => {
  // Deterministic throwaway test key (not used anywhere live).
  const TEST_PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
  const silentLogger = { info() {}, warn() {}, error() {} };
  const baseRetryConfig = {
    network: 'testnet',
    maxRetries: 3,
    retryBaseDelayMs: 10,
    retryMaxDelayMs: 100,
    processedCacheSize: 100,
    deadLetterLimit: 10,
    durableQueue: { enabled: false },
  };
  const preparedFulfillment = {
    success: true,
    result: '{"answer":42}',
    error: '',
    result_bytes_base64: '',
    route: '/oracle/fetch',
    module_id: 'oracle.fetch',
    operation: 'privacy_oracle',
    worker_status: 200,
    verification_signature: 'signed-result',
  };

  function throwingDeliveryConfig(errorMessage) {
    return {
      ...baseRetryConfig,
      hooks: {
        fulfillNeoRequest: async () => {
          throw new Error(errorMessage);
        },
      },
    };
  }

  it('keeps retrying transient delivery errors below the callback ceiling', async () => {
    const state = createEmptyRelayerState();
    const event = {
      chain: 'neo_n3',
      requestId: '300',
      requestType: 'privacy_oracle',
      txHash: '0x300',
    };
    const result = await processEvent(
      throwingDeliveryConfig('ECONNRESET'),
      state,
      () => {},
      silentLogger,
      event,
      { attempts: 1, prepared_fulfillment: preparedFulfillment, durable_claimed: true }
    );

    assert.equal(result.retry_status, 'callback_retry_scheduled');
    assert.equal(state.neo_n3.retry_queue.length, 1);
    assert.equal(state.neo_n3.dead_letters.length, 0);
  });

  it('dead-letters prepared callback redelivery once the retry ceiling is exceeded', async () => {
    const state = createEmptyRelayerState();
    const event = {
      chain: 'neo_n3',
      requestId: '301',
      requestType: 'privacy_oracle',
      txHash: '0x301',
    };
    // attempts 6 == maxRetries * 2 -> the next failure (attempt 7) exhausts.
    const result = await processEvent(
      throwingDeliveryConfig('mempool rejected the transaction'),
      state,
      () => {},
      silentLogger,
      event,
      { attempts: 6, prepared_fulfillment: preparedFulfillment, durable_claimed: true }
    );

    assert.equal(result.retry_status, 'exhausted');
    assert.equal(result.attempts, 7);
    const key = buildEventKey(event);
    assert.equal(state.neo_n3.processed_records[key].status, 'exhausted');
    assert.equal(state.neo_n3.dead_letters.length, 1);
    assert.equal(state.neo_n3.dead_letters[0].request_id, '301');
    assert.equal(state.neo_n3.retry_queue.length, 0);
    assert.equal(state.metrics.retries_exhausted_total, 1);
  });

  it('fires a dead-letter push alert (F1) to the dedicated channel when a callback is permanently dropped', async () => {
    const originalFetch = global.fetch;
    const heartbeats = [];
    global.fetch = async (url, init = {}) => {
      heartbeats.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
      return new Response('', { status: 200 });
    };
    try {
      const state = createEmptyRelayerState();
      const event = {
        chain: 'neo_n3',
        requestId: '350',
        requestType: 'privacy_oracle',
        txHash: '0x350',
      };
      const config = {
        ...throwingDeliveryConfig('mempool rejected the transaction'),
        heartbeats: {
          deadLetter: 'https://betterstack.test/deadletter',
          failure: 'https://betterstack.test/failure',
        },
      };
      const result = await processEvent(config, state, () => {}, silentLogger, event, {
        attempts: 6,
        prepared_fulfillment: preparedFulfillment,
        durable_claimed: true,
      });

      assert.equal(result.retry_status, 'exhausted');
      // The dedicated dead-letter channel (not the generic failure URL) was alerted.
      const alert = heartbeats.find((h) => h.url === 'https://betterstack.test/deadletter');
      assert.ok(alert, 'expected a dead-letter heartbeat POST');
      assert.equal(alert.body.event, 'relayer_dead_letter');
      assert.equal(alert.body.request_id, '350');
      assert.equal(alert.body.chain, 'neo_n3');
      // The generic failure channel is NOT double-fired when deadLetter is set.
      assert.ok(!heartbeats.some((h) => h.url === 'https://betterstack.test/failure'));
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('falls back to the generic failure channel for the dead-letter alert when no dedicated URL is set (F1)', async () => {
    const originalFetch = global.fetch;
    const heartbeats = [];
    global.fetch = async (url, init = {}) => {
      heartbeats.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
      return new Response('', { status: 200 });
    };
    try {
      const state = createEmptyRelayerState();
      const event = {
        chain: 'neo_n3',
        requestId: '351',
        requestType: 'privacy_oracle',
        txHash: '0x351',
      };
      const config = {
        ...throwingDeliveryConfig('mempool rejected the transaction'),
        heartbeats: { failure: 'https://betterstack.test/failure' },
      };
      await processEvent(config, state, () => {}, silentLogger, event, {
        attempts: 6,
        prepared_fulfillment: preparedFulfillment,
        durable_claimed: true,
      });

      const alert = heartbeats.find((h) => h.url === 'https://betterstack.test/failure');
      assert.ok(alert, 'expected the dead-letter alert to fall back to the failure URL');
      assert.equal(alert.body.event, 'relayer_dead_letter');
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('short-circuits a permanently FAULTing callback delivery to the dead-letter lane', async () => {
    const state = createEmptyRelayerState();
    const event = {
      chain: 'neo_n3',
      requestId: '302',
      requestType: 'privacy_oracle',
      txHash: '0x302',
    };
    // classifyError('... faulted ...') === 'permanent': no point redelivering
    // the same prepared payload, even on the very first attempt.
    const result = await processEvent(
      throwingDeliveryConfig(
        'Neo N3 fulfillRequest test invoke faulted for request 302: callback exploded'
      ),
      state,
      () => {},
      silentLogger,
      event,
      { attempts: 0, prepared_fulfillment: preparedFulfillment, durable_claimed: true }
    );

    assert.equal(result.retry_status, 'exhausted');
    assert.equal(state.neo_n3.dead_letters.length, 1);
    assert.equal(state.neo_n3.retry_queue.length, 0);
  });

  it('dead-letters the failure-finalize lane once the callback ceiling is exceeded', async () => {
    const state = createEmptyRelayerState();
    // Neo X event: signNeoXFulfillment signs locally, so finalizeFailedRequest
    // runs fully offline before the delivery hook rejects.
    const event = { chain: 'neox', requestId: '7', requestType: 'random', txHash: '' };
    const config = {
      ...throwingDeliveryConfig('mempool rejected the transaction'),
      neox: {
        chainId: 47763,
        oracleContract: '0xeCFC1C652B5cCdBfe3E9314a83156787D92a3fD2',
        updaterPrivateKey: TEST_PK,
        verifierPrivateKey: TEST_PK,
      },
    };
    const result = await processEvent(config, state, () => {}, silentLogger, event, {
      attempts: 6,
      finalize_only: true,
      terminal_error: 'worker exploded upstream',
      durable_claimed: true,
    });

    assert.equal(result.retry_status, 'exhausted');
    assert.equal(result.attempts, 7);
    assert.equal(state.neox.dead_letters.length, 1);
    assert.equal(state.neox.dead_letters[0].terminal_error, 'worker exploded upstream');
    assert.equal(state.neox.retry_queue.length, 0);
  });

  // --- B1: transient worker HTTP status retried, NOT burned as a failure callback ---
  describe('transient worker HTTP status handling (B1)', () => {
    const TEST_PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
    const silentLogger = { info() {}, warn() {}, error() {} };

    function workerStatusConfig(deliveryHook = null) {
      return {
        network: 'testnet',
        maxRetries: 3,
        maxCallbackRetries: 6,
        retryBaseDelayMs: 10,
        retryMaxDelayMs: 100,
        processedCacheSize: 100,
        deadLetterLimit: 10,
        durableQueue: { enabled: false },
        // Neo X event -> signNeoXFulfillment signs locally, so the only network
        // call we must mock is the worker compute call (global.fetch below).
        nitro: { apiUrl: 'https://worker.test', timeoutMs: 1000 },
        neox: {
          chainId: 47763,
          oracleContract: '0xeCFC1C652B5cCdBfe3E9314a83156787D92a3fD2',
          updaterPrivateKey: TEST_PK,
          verifierPrivateKey: TEST_PK,
        },
        ...(deliveryHook ? { hooks: { fulfillNeoRequest: deliveryHook } } : {}),
      };
    }

    function mockWorkerFetch(status, body) {
      return async () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        });
    }

    async function runWithWorkerStatus(status, body, config, event) {
      const originalFetch = global.fetch;
      global.fetch = mockWorkerFetch(status, body);
      try {
        return await processEvent(
          config,
          createEmptyRelayerState(),
          () => {},
          silentLogger,
          event,
          {
            attempts: 0,
            durable_claimed: true,
          }
        );
      } finally {
        global.fetch = originalFetch;
      }
    }

    for (const status of [503, 429, 500]) {
      it(`retries a transient worker HTTP ${status} instead of finalizing a failure callback`, async () => {
        let delivered = false;
        const config = workerStatusConfig(async () => {
          delivered = true;
          return { tx_hash: '0xshould-not-happen', vm_state: 'HALT' };
        });
        const event = {
          chain: 'neox',
          requestId: '500',
          requestType: 'privacy_oracle',
          payloadText: '{"url":"https://prices.test/neo"}',
          txHash: '',
        };
        const result = await runWithWorkerStatus(status, { error: 'upstream blip' }, config, event);

        // Retried, NOT delivered as a permanent on-chain failure callback.
        assert.equal(result.retry_status, 'scheduled', `status ${status} should be retried`);
        assert.equal(result.error_class, 'transient');
        assert.equal(
          delivered,
          false,
          'no fulfillRequest should reach the chain on a transient blip'
        );
      });
    }

    it('finalizes a deterministic worker HTTP 400 as success:false (delivers the failure callback)', async () => {
      const deliveries = [];
      const config = workerStatusConfig(async (call) => {
        deliveries.push({ requestId: call.requestId, success: call.fulfillment.success });
        return { tx_hash: '0xfinalized', vm_state: 'HALT', target_chain: 'neox' };
      });
      const event = {
        chain: 'neox',
        requestId: '400',
        requestType: 'privacy_oracle',
        payloadText: '{"url":"https://prices.test/neo"}',
        txHash: '',
      };
      const result = await runWithWorkerStatus(400, { error: 'bad request' }, config, event);

      // Deterministic 4xx is encoded into an on-chain failure callback (success:false).
      assert.ok(result.result, 'expected a delivered fulfillment result');
      assert.equal(result.result.success, false);
      assert.equal(deliveries.length, 1);
      assert.equal(deliveries[0].success, false);
    });
  });

  it('re-enqueues a failure-finalize callback when the worker is exhausted and the finalize delivery itself fails (below the ceiling)', async () => {
    const state = createEmptyRelayerState();
    // Drive the primary-exhausted -> finalize -> finalize-fails -> re-enqueue arm:
    //  1. A worker-route request (privacy_oracle) with no nitro config makes
    //     prepareOracleFulfillment throw ("...is not configured") before any
    //     prepared payload exists, so the catch falls through to scheduleRetry.
    //  2. maxRetries:0 makes scheduleRetry exhaust immediately, forcing the
    //     finalizeFailedRequest path.
    //  3. The event is Neo X so signNeoXFulfillment signs the failure callback
    //     offline; the only on-chain touch is fulfillNeoRequest, which we drive
    //     through the config.hooks.fulfillNeoRequest seam to fail transiently.
    //  4. An explicit maxCallbackRetries keeps the finalize re-enqueue below the
    //     ceiling, so it schedules another attempt instead of dead-lettering.
    const event = { chain: 'neox', requestId: '900', requestType: 'privacy_oracle', txHash: '' };
    let deliveryCall = 0;
    const config = {
      ...baseRetryConfig,
      maxRetries: 0,
      maxCallbackRetries: 5,
      nitro: { apiUrl: '' },
      neox: {
        chainId: 47763,
        oracleContract: '0xeCFC1C652B5cCdBfe3E9314a83156787D92a3fD2',
        updaterPrivateKey: TEST_PK,
        verifierPrivateKey: TEST_PK,
      },
      hooks: {
        fulfillNeoRequest: async () => {
          deliveryCall += 1;
          throw new Error('socket hang up while delivering failure finalize');
        },
      },
    };

    const result = await processEvent(config, state, () => {}, silentLogger, event, {
      attempts: 0,
      durable_claimed: true,
    });

    // The failure-finalize delivery (and only that delivery) reached the hook.
    assert.equal(deliveryCall, 1);
    // Below the callback ceiling -> re-enqueued, NOT dead-lettered.
    assert.equal(result.retry_status, 'scheduled');
    assert.equal(result.attempts, 2);
    assert.equal(state.neox.dead_letters.length, 0);
    assert.equal(state.neox.retry_queue.length, 1);

    const queued = state.neox.retry_queue[0];
    assert.equal(queued.finalize_only, true);
    assert.equal(queued.attempts, 2);
    // last_error = the finalize-delivery failure; terminal_error = the original
    // primary failure the failure callback is finalizing.
    assert.equal(queued.last_error, 'socket hang up while delivering failure finalize');
    assert.equal(queued.terminal_error, 'MORPHEUS_RUNTIME_URL or NITRO_API_URL is not configured');
    assert.equal(state.metrics.retries_scheduled_total, 1);
    assert.equal(state.metrics.retries_exhausted_total, 1);
  });
});

// ===================================================================
// processEvent durable-claim backoff retention (B3)
// ===================================================================

describe('processEvent durable-claim backoff retention (B3)', () => {
  const silentLogger = { info() {}, warn() {}, error() {} };
  const preparedFulfillment = {
    success: true,
    result: '{"answer":42}',
    error: '',
    result_bytes_base64: '',
    route: '/oracle/fetch',
    module_id: 'oracle.fetch',
    operation: 'privacy_oracle',
    worker_status: 200,
    verification_signature: 'signed-result',
  };

  function multiInstanceBackoffConfig() {
    return {
      network: 'testnet',
      maxRetries: 3,
      retryBaseDelayMs: 10,
      retryMaxDelayMs: 100,
      processedCacheSize: 100,
      deadLetterLimit: 10,
      durableQueue: {
        enabled: true,
        failClosed: true,
        // Multi-instance opt-out: a relayer must SKIP (not locally claim)
        // processing during a Supabase backoff to avoid double-delivery.
        allowLocalClaimDuringBackoff: false,
      },
      instanceId: 'relayer-a',
    };
  }

  it('retains an existing retry item (no conflict, no clear, no attempt bump) on multi-instance backoff_skip', async () => {
    resetSupabasePersistenceBackoffForTests();
    markSupabasePersistenceUnavailable(
      new Error('supabase morpheus_relayer_jobs PATCH failed: 402 exceed_db_size_quota')
    );
    const state = createEmptyRelayerState();
    const event = {
      chain: 'neo_n3',
      requestId: '700',
      requestType: 'privacy_oracle',
      txHash: '0x700',
    };
    const eventKey = buildEventKey(event);
    // Pre-seed the retry item (a prepared callback redelivery waiting to be drained).
    state.neo_n3.retry_queue.push({
      key: eventKey,
      event,
      attempts: 2,
      next_retry_at: Date.now() - 1000,
      prepared_fulfillment: preparedFulfillment,
    });

    let delivered = false;
    const config = {
      ...multiInstanceBackoffConfig(),
      hooks: {
        fulfillNeoRequest: async () => {
          delivered = true;
          return { tx_hash: '0xshould-not-deliver', vm_state: 'HALT' };
        },
      },
    };

    const result = await processEvent(config, state, () => {}, silentLogger, event, {
      attempts: 2,
      prepared_fulfillment: preparedFulfillment,
      // NB: NOT durable_claimed — forces the backoff branch.
    });

    // Skipped this tick, but the work is RETAINED for the next tick.
    assert.equal(result.skipped, true);
    assert.equal(result.retry_status, 'backoff_skip');
    assert.equal(delivered, false, 'must not deliver during a multi-instance backoff skip');
    // The retry item is still present and UNCHANGED (no attempt bump).
    assert.equal(state.neo_n3.retry_queue.length, 1);
    assert.equal(state.neo_n3.retry_queue[0].attempts, 2);
    // It was NOT counted as a conflict (that would imply another instance has it).
    assert.equal(state.metrics.claim_conflicts_total, 0);
    assert.equal(state.metrics.durable_claim_skipped_during_backoff_total, 1);
    resetSupabasePersistenceBackoffForTests();
  });

  it('locally enqueues a fresh event (no retry item yet) on multi-instance backoff_skip so the block-scan path does not drop it', async () => {
    resetSupabasePersistenceBackoffForTests();
    markSupabasePersistenceUnavailable(
      new Error('supabase morpheus_relayer_jobs PATCH failed: 402 exceed_db_size_quota')
    );
    const state = createEmptyRelayerState();
    const event = {
      chain: 'neo_n3',
      requestId: '701',
      requestType: 'privacy_oracle',
      txHash: '0x701',
    };

    const result = await processEvent(
      multiInstanceBackoffConfig(),
      state,
      () => {},
      silentLogger,
      event,
      null // fresh event from the block scan, no retry item
    );

    assert.equal(result.skipped, true);
    assert.equal(result.retry_status, 'backoff_skip');
    // The fresh event was enqueued locally so it is retried next tick.
    assert.equal(state.neo_n3.retry_queue.length, 1);
    assert.equal(state.neo_n3.retry_queue[0].event.requestId, '701');
    assert.equal(state.metrics.claim_conflicts_total, 0);
    resetSupabasePersistenceBackoffForTests();
  });

  it('retains the item (no conflict) when the durable queue is enabled but Supabase is unavailable (not fail-closed)', async () => {
    resetSupabasePersistenceBackoffForTests();
    const state = createEmptyRelayerState();
    const event = {
      chain: 'neo_n3',
      requestId: '702',
      requestType: 'privacy_oracle',
      txHash: '0x702',
    };
    const eventKey = buildEventKey(event);
    state.neo_n3.retry_queue.push({
      key: eventKey,
      event,
      attempts: 1,
      next_retry_at: 0,
      prepared_fulfillment: preparedFulfillment,
    });

    // durableQueue enabled but failClosed:false and no Supabase persistence
    // configured -> ensureDurableQueueAvailable returns false -> claim reason
    // 'unavailable'. The request is unprocessed, so the item must be retained and
    // NOT counted as a cross-instance conflict.
    let delivered = false;
    const config = {
      network: 'testnet',
      maxRetries: 3,
      retryBaseDelayMs: 10,
      retryMaxDelayMs: 100,
      processedCacheSize: 100,
      deadLetterLimit: 10,
      durableQueue: { enabled: true, failClosed: false },
      instanceId: 'relayer-a',
      hooks: {
        fulfillNeoRequest: async () => {
          delivered = true;
          return { tx_hash: '0xnope', vm_state: 'HALT' };
        },
      },
    };

    const result = await processEvent(config, state, () => {}, silentLogger, event, {
      attempts: 1,
      prepared_fulfillment: preparedFulfillment,
    });

    assert.equal(result.skipped, true);
    assert.equal(result.retry_status, 'unavailable');
    assert.equal(delivered, false);
    // Item retained, not cleared, no phantom conflict.
    assert.equal(state.neo_n3.retry_queue.length, 1);
    assert.equal(state.neo_n3.retry_queue[0].attempts, 1);
    assert.equal(state.metrics.claim_conflicts_total, 0);
    resetSupabasePersistenceBackoffForTests();
  });
});

// ===================================================================
// Compute-in-enclave fulfillment (POST /oracle/fulfill) — flag-gated (Phase 4)
// ===================================================================

describe('enclave /oracle/fulfill path (MORPHEUS_RELAYER_ENCLAVE_FULFILL flag)', () => {
  const silentLogger = { info() {}, warn() {}, error() {} };
  // Throwaway secp256k1 key (used only for the neox flag-OFF baseline, never live).
  const TEST_EVM_PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
  const N3_ORACLE = '0x1212121212121212121212121212121212121212';
  const N3_MAGIC = 894710606; // testnet
  const NEOX_CHAIN_ID = 12227332;
  const NEOX_ORACLE = '0xeCFC1C652B5cCdBfe3E9314a83156787D92a3fD2';

  function baseConfig(extra = {}) {
    return {
      network: 'testnet',
      maxRetries: 3,
      maxCallbackRetries: 6,
      retryBaseDelayMs: 10,
      retryMaxDelayMs: 100,
      processedCacheSize: 100,
      deadLetterLimit: 10,
      durableQueue: { enabled: false },
      nitro: {
        apiUrl: 'https://worker.test',
        signerUrl: 'https://signer.test',
        enclaveFulfill: true,
        enclaveFulfillUrl: 'https://enclave.test',
        timeoutMs: 1000,
        custodyUrl: 'https://custody.test',
        custodyToken: 'custody-token',
      },
      neo_n3: {
        oracleContract: N3_ORACLE,
        networkMagic: N3_MAGIC,
        custodyKeyIds: { oracle_verifier: 'key-oracle-verifier' },
      },
      neox: { chainId: NEOX_CHAIN_ID, oracleContract: NEOX_ORACLE, updaterPrivateKey: TEST_EVM_PK },
      ...extra,
    };
  }

  // Build the EXACT digest hex the relayer will recompute for a given event +
  // enclave-computed result, using the SAME canonical builders. The enclave returns
  // this in fulfillment_digest_hex so the cross-check passes (or, when tampered,
  // a different value so the cross-check fails).
  function expectedDigestHex(chain, event, fulfillment) {
    if (chain === 'neox') {
      const resultBytesHex = resolveResultBytesHex(
        fulfillment.result,
        fulfillment.result_bytes_base64 || ''
      );
      return buildNeoXDigest(
        { neox: { chainId: NEOX_CHAIN_ID, oracleContract: NEOX_ORACLE } },
        {
          requestId: String(event.requestId),
          appId: event.appId || '',
          moduleId: fulfillment.moduleId,
          operation: fulfillment.operation,
          success: fulfillment.success,
          error: fulfillment.error || '',
        },
        resultBytesHex
      )
        .replace(/^0x/i, '')
        .toLowerCase();
    }
    // neo_n3 with no appId downgrades to the legacy digest domain (matches
    // resolveFulfillmentSigningContext); n3 also binds contract + magic. The
    // 'legacy' loop value models a neo_n3 event with no appId, so it too uses the
    // legacy domain.
    const isLegacy = chain === 'legacy' || (chain === 'neo_n3' && !(event.appId || ''));
    const digestContext = isLegacy
      ? { chain: 'legacy', appId: '', moduleId: '', operation: '' }
      : {
          chain: 'neo_n3',
          appId: event.appId || '',
          moduleId: fulfillment.moduleId,
          operation: fulfillment.operation,
          contractScriptHash: N3_ORACLE,
          networkMagic: N3_MAGIC,
        };
    return buildFulfillmentDigestBytes(
      String(event.requestId),
      event.requestType,
      fulfillment.success,
      fulfillment.result,
      fulfillment.error || '',
      fulfillment.result_bytes_base64 || '',
      digestContext
    ).toString('hex');
  }

  // A faithful enclave /oracle/fulfill response for the event: it COMPUTES the same
  // result the relayer would (via encodeFulfillmentResult over a stub worker body),
  // then returns the matching digest + a signature. `tamperDigest` corrupts the
  // returned digest so the relayer's cross-check must reject it.
  function enclaveResponseFor(chain, event, workerBody, { tamperDigest = false } = {}) {
    const moduleId =
      event.moduleId ||
      (event.requestType.includes('random') || event.requestType === 'rng'
        ? 'random.generate'
        : 'oracle.fetch');
    const operation = event.operation || event.requestType;
    const encoded = encodeFulfillmentResult(event.requestType, {
      ok: true,
      status: 200,
      body: workerBody,
    });
    const fulfillment = {
      moduleId,
      operation,
      success: encoded.success,
      result: encoded.result || '',
      result_bytes_base64: encoded.result_bytes_base64 || '',
      error: encoded.error || '',
    };
    let digestHex = expectedDigestHex(chain, event, fulfillment);
    if (tamperDigest) {
      // Flip the first hex nibble so the digest is structurally valid but wrong.
      const first = digestHex[0];
      const flipped = first === '0' ? '1' : '0';
      digestHex = flipped + digestHex.slice(1);
    }
    const body = {
      status: 'ok',
      success: fulfillment.success,
      result: fulfillment.result,
      error: fulfillment.error,
      signature: 'a'.repeat(128),
      public_key: '02' + 'b'.repeat(64),
      fulfillment_digest_hex: digestHex,
      verification: { output_hash: 'enclave-output-hash' },
      trust_tier: 'enclave-attested',
    };
    if (fulfillment.result_bytes_base64) body.result_bytes_base64 = fulfillment.result_bytes_base64;
    return body;
  }

  // Mock fetch that records every call and routes /oracle/fulfill to the supplied
  // enclave body. Any OTHER endpoint (worker compute / custody /sign/raw) is a
  // FAILURE in flag-on mode for the attested lane — the single /oracle/fulfill call
  // must be the only nitro hit (proving the two-step path is replaced).
  function installEnclaveFetch(enclaveBody) {
    const calls = [];
    const original = global.fetch;
    global.fetch = async (url, init = {}) => {
      const u = String(url);
      calls.push({ url: u, body: init.body ? JSON.parse(init.body) : null });
      if (u.endsWith('/oracle/fulfill')) {
        return new Response(JSON.stringify(enclaveBody), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      // Any other endpoint is unexpected on the attested lane.
      return new Response(JSON.stringify({ error: `unexpected endpoint ${u}` }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      });
    };
    return { calls, restore: () => (global.fetch = original) };
  }

  for (const chain of ['neo_n3', 'legacy', 'neox']) {
    it(`flag-ON computes+signs via a SINGLE /oracle/fulfill call and the digest cross-check passes (${chain})`, async () => {
      // 'legacy' is a neo_n3 event with no appId (the relayer downgrades the digest
      // domain); model it as a neo_n3 chain event without appId.
      const eventChain = chain === 'legacy' ? 'neo_n3' : chain;
      const event = {
        chain: eventChain,
        requestId: '4242',
        requestType: 'privacy_oracle',
        payloadText: '{"symbol":"NEO-USD"}',
        txHash: '0xabc',
        ...(chain === 'legacy' ? {} : { appId: 'miniapp-os' }),
      };
      const workerBody = { result: { price: '5.25' }, extracted_value: '5.25' };
      const enclaveBody = enclaveResponseFor(chain, event, workerBody);
      const { calls, restore } = installEnclaveFetch(enclaveBody);
      const submitted = [];
      const config = baseConfig({
        hooks: {
          fulfillNeoRequest: async (call) => {
            submitted.push(call);
            return { tx_hash: '0xfeed', vm_state: 'HALT' };
          },
        },
      });
      try {
        const result = await processEvent(
          config,
          createEmptyRelayerState(),
          () => {},
          silentLogger,
          event,
          {
            attempts: 0,
            durable_claimed: true,
          }
        );

        // EXACTLY one nitro endpoint hit, and it was /oracle/fulfill (not a worker
        // compute call followed by a separate custody /sign/raw).
        assert.equal(calls.length, 1, `expected a single nitro call, got ${calls.length}`);
        assert.ok(calls[0].url.endsWith('/oracle/fulfill'));
        assert.ok(calls[0].url.startsWith('https://enclave.test'));
        // The enclave request carries the kernel context for the digest rebuild.
        assert.equal(calls[0].body.request_id, '4242');
        assert.equal(typeof calls[0].body.nonce, 'string');

        // Delivered successfully, carrying the ENCLAVE's signature (consumed, not
        // recomputed by the relayer).
        assert.ok(result.result, 'expected a delivered fulfillment');
        assert.equal(submitted.length, 1);
        assert.equal(submitted[0].verification.signature, 'a'.repeat(128));
        assert.equal(result.result.success, true);
        assert.equal(result.result.route, 'enclave:oracle.fetch');
      } finally {
        restore();
      }
    });

    it(`flag-ON REJECTS a tampered enclave digest (does NOT submit) (${chain})`, async () => {
      const eventChain = chain === 'legacy' ? 'neo_n3' : chain;
      const event = {
        chain: eventChain,
        requestId: '4243',
        requestType: 'privacy_oracle',
        payloadText: '{"symbol":"NEO-USD"}',
        txHash: '0xdef',
        ...(chain === 'legacy' ? {} : { appId: 'miniapp-os' }),
      };
      const workerBody = { result: { price: '5.25' }, extracted_value: '5.25' };
      const enclaveBody = enclaveResponseFor(chain, event, workerBody, { tamperDigest: true });
      const { restore } = installEnclaveFetch(enclaveBody);
      let submitted = false;
      const config = baseConfig({
        hooks: {
          fulfillNeoRequest: async () => {
            submitted = true;
            return { tx_hash: '0xshould-not-happen', vm_state: 'HALT' };
          },
        },
      });
      try {
        const result = await processEvent(
          config,
          createEmptyRelayerState(),
          () => {},
          silentLogger,
          event,
          {
            attempts: 0,
            durable_claimed: true,
          }
        );

        // A digest mismatch classifies as a terminal configuration error
        // (the message contains 'invalid signature') -> never submitted.
        assert.equal(submitted, false, 'must NOT submit on a tampered enclave digest');
        assert.notEqual(result.retry_status, undefined);
        assert.ok(!result.result, 'no fulfillment should be delivered on a digest mismatch');
      } finally {
        restore();
      }
    });
  }

  it('flag-ON VRF uses the enclave (no relayer-local randomBytes; raw 32B from the enclave)', async () => {
    const event = {
      chain: 'neo_n3',
      requestId: '777',
      requestType: 'vrf_random',
      appId: 'morpheus.platform.game',
      moduleId: 'vrf_random',
      operation: 'vrf_random',
      payloadText: '{}',
      txHash: '0x777',
    };
    // The enclave produced the randomness (compact 32B callback) — the relayer must
    // carry it, not generate its own.
    const enclaveRandomness = 'cd'.repeat(32);
    const workerBody = { randomness: enclaveRandomness };
    const enclaveBody = enclaveResponseFor('neo_n3', event, workerBody);
    const { calls, restore } = installEnclaveFetch(enclaveBody);
    const submitted = [];
    const config = baseConfig({
      hooks: {
        fulfillNeoRequest: async (call) => {
          submitted.push(call);
          return { tx_hash: '0xvrf', vm_state: 'HALT' };
        },
      },
    });
    try {
      const result = await processEvent(
        config,
        createEmptyRelayerState(),
        () => {},
        silentLogger,
        event,
        {
          attempts: 0,
          durable_claimed: true,
        }
      );

      // Single /oracle/fulfill call — the relayer-local crypto.randomBytes VRF
      // branch is skipped while the flag is on.
      assert.equal(calls.length, 1);
      assert.ok(calls[0].url.endsWith('/oracle/fulfill'));
      assert.equal(submitted.length, 1);
      // The on-chain result bytes are the ENCLAVE randomness (compact 32B), not a
      // relayer-generated value.
      assert.equal(
        Buffer.from(submitted[0].fulfillment.result_bytes_base64, 'base64').toString('hex'),
        enclaveRandomness
      );
      assert.equal(result.result.route, 'enclave:random.generate');
    } finally {
      restore();
    }
  });

  it('flag-ON keeps the arbitrary-URL fetch lane on the HOST worker (host-unattested, not /oracle/fulfill)', async () => {
    const event = {
      chain: 'neo_n3',
      requestId: '888',
      requestType: 'privacy_oracle',
      appId: 'miniapp-os',
      payloadText: '{"url":"https://prices.example/neo"}',
      txHash: '0x888',
    };
    const original = global.fetch;
    const calls = [];
    global.fetch = async (url) => {
      const u = String(url);
      calls.push({ url: u });
      // The host worker compute call (NOT /oracle/fulfill).
      if (u.startsWith('https://worker.test')) {
        return new Response(JSON.stringify({ result: { value: 1 } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      // The custody signer /sign/raw call (oracle_verifier key).
      if (u.endsWith('/sign/raw')) {
        return custodySignRawResponse('d'.repeat(128));
      }
      return new Response(JSON.stringify({ error: `unexpected ${u}` }), { status: 500 });
    };
    const submitted = [];
    const config = baseConfig({
      hooks: {
        fulfillNeoRequest: async (call) => {
          submitted.push(call);
          return { tx_hash: '0xhost', vm_state: 'HALT' };
        },
      },
    });
    try {
      const result = await processEvent(
        config,
        createEmptyRelayerState(),
        () => {},
        silentLogger,
        event,
        {
          attempts: 0,
          durable_claimed: true,
        }
      );

      // The arbitrary-URL lane never hits /oracle/fulfill.
      assert.ok(!calls.some((c) => c.url.endsWith('/oracle/fulfill')), 'must not call the enclave');
      // It used the host worker compute + the custody signer /sign/raw (two-step).
      assert.ok(calls.some((c) => c.url.startsWith('https://worker.test')));
      assert.ok(calls.some((c) => c.url.endsWith('/sign/raw')));
      assert.equal(submitted.length, 1);
      assert.equal(result.result.success, true);
      // Tagged host-unattested.
      assert.equal(result.result.trust_tier, 'host-unattested');
    } finally {
      global.fetch = original;
    }
  });

  it('flag-OFF (default) keeps the two-step host path: worker compute + custody /sign/raw, NO /oracle/fulfill', async () => {
    const event = {
      chain: 'neo_n3',
      requestId: '999',
      requestType: 'privacy_oracle',
      appId: 'miniapp-os',
      payloadText: '{"symbol":"NEO-USD"}',
      txHash: '0x999',
    };
    const original = global.fetch;
    const calls = [];
    global.fetch = async (url) => {
      const u = String(url);
      calls.push({ url: u });
      if (u.startsWith('https://worker.test')) {
        return new Response(
          JSON.stringify({ result: { price: '5.25' }, extracted_value: '5.25' }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }
        );
      }
      if (u.endsWith('/sign/raw')) {
        return custodySignRawResponse('e'.repeat(128));
      }
      return new Response(JSON.stringify({ error: `unexpected ${u}` }), { status: 500 });
    };
    const submitted = [];
    const config = baseConfig({
      nitro: {
        apiUrl: 'https://worker.test',
        signerUrl: 'https://signer.test',
        enclaveFulfill: false, // explicit flag-OFF
        enclaveFulfillUrl: 'https://enclave.test',
        timeoutMs: 1000,
        custodyUrl: 'https://custody.test',
        custodyToken: 'custody-token',
      },
      hooks: {
        fulfillNeoRequest: async (call) => {
          submitted.push(call);
          return { tx_hash: '0xtwostep', vm_state: 'HALT' };
        },
      },
    });
    try {
      const result = await processEvent(
        config,
        createEmptyRelayerState(),
        () => {},
        silentLogger,
        event,
        {
          attempts: 0,
          durable_claimed: true,
        }
      );

      // Flag-off = the historical split path. /oracle/fulfill is NEVER called.
      assert.ok(
        !calls.some((c) => c.url.endsWith('/oracle/fulfill')),
        'flag-off must not call the enclave fulfill endpoint'
      );
      assert.ok(
        calls.some((c) => c.url.startsWith('https://worker.test')),
        'flag-off uses the host worker compute'
      );
      assert.ok(
        calls.some((c) => c.url.endsWith('/sign/raw')),
        'flag-off uses the custody signer /sign/raw'
      );
      assert.equal(submitted.length, 1);
      assert.equal(submitted[0].verification.signature, 'e'.repeat(128));
      assert.equal(result.result.success, true);
    } finally {
      global.fetch = original;
    }
  });

  it('flag-OFF labels the host-worker price lane host-unattested, NOT enclave-attested', async () => {
    // With the enclave-fulfill flag OFF the price/feed lane is computed on the host
    // worker (no attestation document exists), so its advisory trust_tier must be
    // truthful: host-unattested. Tagging it enclave-attested would be misleading.
    const event = {
      chain: 'neo_n3',
      requestId: '7001',
      requestType: 'privacy_oracle',
      appId: 'miniapp-os',
      payloadText: '{"symbol":"NEO-USD"}',
      txHash: '0x7001',
    };
    const original = global.fetch;
    const calls = [];
    global.fetch = async (url) => {
      const u = String(url);
      calls.push({ url: u });
      if (u.startsWith('https://worker.test')) {
        return new Response(
          JSON.stringify({ result: { price: '5.25' }, extracted_value: '5.25' }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }
        );
      }
      if (u.endsWith('/sign/raw')) {
        return custodySignRawResponse('e'.repeat(128));
      }
      return new Response(JSON.stringify({ error: `unexpected ${u}` }), { status: 500 });
    };
    const submitted = [];
    const config = baseConfig({
      nitro: {
        apiUrl: 'https://worker.test',
        signerUrl: 'https://signer.test',
        enclaveFulfill: false, // explicit flag-OFF
        enclaveFulfillUrl: 'https://enclave.test',
        timeoutMs: 1000,
        custodyUrl: 'https://custody.test',
        custodyToken: 'custody-token',
      },
      hooks: {
        fulfillNeoRequest: async (call) => {
          submitted.push(call);
          return { tx_hash: '0xtwostep', vm_state: 'HALT' };
        },
      },
    });
    try {
      const result = await processEvent(
        config,
        createEmptyRelayerState(),
        () => {},
        silentLogger,
        event,
        {
          attempts: 0,
          durable_claimed: true,
        }
      );
      assert.equal(submitted.length, 1, 'still submits');
      assert.equal(result.result.success, true);
      assert.notEqual(
        result.result.trust_tier,
        'enclave-attested',
        'flag-off host-worker price lane must NOT be labeled enclave-attested'
      );
      assert.equal(result.result.trust_tier, 'host-unattested');
    } finally {
      global.fetch = original;
    }
  });

  it('flag-OFF labels the local CSPRNG VRF lane host-unattested, NOT enclave-attested', async () => {
    // The local random.generate (VRF) branch only runs with the flag OFF — the
    // randomness + signing happen on the host worker, so its trust_tier must be
    // host-unattested, not the misleading enclave-attested default.
    const event = {
      chain: 'neo_n3',
      requestId: '7002',
      requestType: 'rng',
      appId: 'miniapp-os',
      payloadText: '{}',
      txHash: '0x7002',
    };
    const original = global.fetch;
    const calls = [];
    global.fetch = async (url) => {
      const u = String(url);
      calls.push({ url: u });
      // Local VRF performs no worker compute; it only signs via the custody /sign/raw.
      if (u.endsWith('/sign/raw')) {
        return custodySignRawResponse('f'.repeat(128));
      }
      return new Response(JSON.stringify({ error: `unexpected ${u}` }), { status: 500 });
    };
    const submitted = [];
    const config = baseConfig({
      nitro: {
        apiUrl: 'https://worker.test',
        signerUrl: 'https://signer.test',
        enclaveFulfill: false, // explicit flag-OFF
        enclaveFulfillUrl: 'https://enclave.test',
        timeoutMs: 1000,
        custodyUrl: 'https://custody.test',
        custodyToken: 'custody-token',
      },
      hooks: {
        fulfillNeoRequest: async (call) => {
          submitted.push(call);
          return { tx_hash: '0xrng', vm_state: 'HALT' };
        },
      },
    });
    try {
      const result = await processEvent(
        config,
        createEmptyRelayerState(),
        () => {},
        silentLogger,
        event,
        {
          attempts: 0,
          durable_claimed: true,
        }
      );
      // The local VRF lane never calls the enclave fulfill endpoint or the worker.
      assert.ok(
        !calls.some((c) => c.url.endsWith('/oracle/fulfill')),
        'local VRF must not call the enclave'
      );
      assert.equal(submitted.length, 1, 'still submits');
      assert.equal(result.result.success, true);
      assert.notEqual(
        result.result.trust_tier,
        'enclave-attested',
        'flag-off local VRF lane must NOT be labeled enclave-attested'
      );
      assert.equal(result.result.trust_tier, 'host-unattested');
    } finally {
      global.fetch = original;
    }
  });

  it('flag-OFF local VRF fallback is still allowed when NOT production (dev/test lane)', async () => {
    // M-vrf: the fail-closed guard keys off NODE_ENV=production only; dev/test
    // keep the relayer-local CSPRNG fallback.
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    const event = {
      chain: 'neo_n3',
      requestId: '7004',
      requestType: 'rng',
      appId: 'miniapp-os',
      payloadText: '{}',
      txHash: '0x7004',
    };
    const original = global.fetch;
    global.fetch = async (url) => {
      const u = String(url);
      if (u.endsWith('/sign/raw')) {
        return custodySignRawResponse('d'.repeat(128));
      }
      return new Response(JSON.stringify({ error: `unexpected ${u}` }), { status: 500 });
    };
    const submitted = [];
    const config = baseConfig({
      nitro: {
        apiUrl: 'https://worker.test',
        signerUrl: 'https://signer.test',
        enclaveFulfill: false, // explicit flag-OFF
        enclaveFulfillUrl: 'https://enclave.test',
        timeoutMs: 1000,
        custodyUrl: 'https://custody.test',
        custodyToken: 'custody-token',
      },
      hooks: {
        fulfillNeoRequest: async (call) => {
          submitted.push(call);
          return { tx_hash: '0xrngdev', vm_state: 'HALT' };
        },
      },
    });
    try {
      const result = await processEvent(
        config,
        createEmptyRelayerState(),
        () => {},
        silentLogger,
        event,
        {
          attempts: 0,
          durable_claimed: true,
        }
      );
      assert.equal(submitted.length, 1, 'dev fallback still submits');
      assert.equal(result.result.success, true);
      assert.equal(result.result.route, 'local:vrf');
    } finally {
      global.fetch = original;
      if (previousNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = previousNodeEnv;
      }
    }
  });

  it('flag-OFF local VRF fallback is REFUSED when NODE_ENV=production (fail closed, M-vrf)', async () => {
    // In production the relayer-local CSPRNG fallback is a terminal
    // configuration error: the operator would see the outcome pre-broadcast and
    // the on-chain signature is indistinguishable from an enclave-attested VRF.
    // The request must NOT be signed, submitted, or retried — the operator must
    // enable the compute-in-enclave lane instead.
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const event = {
      chain: 'neo_n3',
      requestId: '7005',
      requestType: 'rng',
      appId: 'miniapp-os',
      payloadText: '{}',
      txHash: '0x7005',
    };
    const original = global.fetch;
    const calls = [];
    global.fetch = async (url) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 });
    };
    const submitted = [];
    const config = baseConfig({
      nitro: {
        apiUrl: 'https://worker.test',
        signerUrl: 'https://signer.test',
        enclaveFulfill: false, // explicit flag-OFF
        enclaveFulfillUrl: 'https://enclave.test',
        timeoutMs: 1000,
      },
      hooks: {
        fulfillNeoRequest: async (call) => {
          submitted.push(call);
          return { tx_hash: '0xrngprod', vm_state: 'HALT' };
        },
      },
    });
    try {
      const result = await processEvent(
        config,
        createEmptyRelayerState(),
        () => {},
        silentLogger,
        event,
        {
          attempts: 0,
          durable_claimed: true,
        }
      );
      assert.equal(submitted.length, 0, 'refused VRF must not be submitted on-chain');
      assert.equal(calls.length, 0, 'refused VRF must not sign or call any worker/enclave');
      assert.equal(result.retry_status, 'terminal');
      assert.match(result.error, /enclave fulfillment required in production/);
      assert.match(result.error, /MORPHEUS_RELAYER_ENCLAVE_FULFILL/);
    } finally {
      global.fetch = original;
      if (previousNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = previousNodeEnv;
      }
    }
  });

  it('flag-ON downgrades trust_tier to host-unattested when the enclave returns NO attestation doc (C1)', async () => {
    // Today's enclave images return a signature but (pre-cutover) may not carry an
    // attestation document. The relayer must NOT blindly trust the response's
    // trust_tier string — with no provable attestation it labels the result
    // host-unattested while still submitting (the on-chain check is authoritative).
    const event = {
      chain: 'neo_n3',
      requestId: '6001',
      requestType: 'privacy_oracle',
      appId: 'miniapp-os',
      payloadText: '{"symbol":"NEO-USD"}',
      txHash: '0x6001',
    };
    const workerBody = { result: { price: '5.25' }, extracted_value: '5.25' };
    // enclaveResponseFor returns trust_tier:'enclave-attested' but NO attestation doc.
    const enclaveBody = enclaveResponseFor('neo_n3', event, workerBody);
    const { restore } = installEnclaveFetch(enclaveBody);
    const submitted = [];
    const config = baseConfig({
      hooks: {
        fulfillNeoRequest: async (call) => {
          submitted.push(call);
          return { tx_hash: '0xfeed', vm_state: 'HALT' };
        },
      },
    });
    try {
      const result = await processEvent(
        config,
        createEmptyRelayerState(),
        () => {},
        silentLogger,
        event,
        {
          attempts: 0,
          durable_claimed: true,
        }
      );
      assert.equal(submitted.length, 1, 'still submits (lane keeps fulfilling)');
      assert.equal(
        result.result.trust_tier,
        'host-unattested',
        'unprovable attestation must NOT be labeled enclave-attested'
      );
    } finally {
      restore();
    }
  });

  it('flag-ON keeps an unsigned attestation host-unattested even when PCR0 matches (C1)', async () => {
    const event = {
      chain: 'neo_n3',
      requestId: '6002',
      requestType: 'privacy_oracle',
      appId: 'miniapp-os',
      payloadText: '{"symbol":"NEO-USD"}',
      txHash: '0x6002',
    };
    const workerBody = { result: { price: '5.25' }, extracted_value: '5.25' };
    const enclaveBody = enclaveResponseFor('neo_n3', event, workerBody);
    const PCR0 = 'ab'.repeat(48);
    // Bind a real COSE doc to sha256(the enclave's returned digest) + the pinned PCR0.
    const userData = createHash('sha256')
      .update(Buffer.from(enclaveBody.fulfillment_digest_hex, 'hex'))
      .digest('hex');
    enclaveBody.attestation_doc_base64 = buildAttestationDoc({
      userDataHex: userData,
      pcr0Hex: PCR0,
    });
    const { restore } = installEnclaveFetch(enclaveBody);
    const submitted = [];
    const config = baseConfig({
      nitro: {
        apiUrl: 'https://worker.test',
        signerUrl: 'https://signer.test',
        enclaveFulfill: true,
        enclaveFulfillUrl: 'https://enclave.test',
        timeoutMs: 1000,
        expectedPcr0: PCR0,
      },
      hooks: {
        fulfillNeoRequest: async (call) => {
          submitted.push(call);
          return { tx_hash: '0xfeed', vm_state: 'HALT' };
        },
      },
    });
    try {
      const result = await processEvent(
        config,
        createEmptyRelayerState(),
        () => {},
        silentLogger,
        event,
        {
          attempts: 0,
          durable_claimed: true,
        }
      );
      assert.equal(submitted.length, 1);
      assert.equal(result.result.trust_tier, 'host-unattested');
    } finally {
      restore();
    }
  });
});

// ===================================================================
// C1 — enforcing enclave attestation verification (verifyEnclaveAttestation)
// ===================================================================

// Minimal CBOR encoder for the test (mirrors the enclave's), used to build a real
// COSE_Sign1 attestation document the relayer's verifier parses.
function cborEncodeForTest(value) {
  const head = (major, n) => {
    const big = BigInt(n);
    if (big < 24n) return Buffer.from([(major << 5) | Number(big)]);
    if (big < 256n) return Buffer.from([(major << 5) | 24, Number(big)]);
    if (big < 65536n)
      return Buffer.from([(major << 5) | 25, Number(big >> 8n) & 0xff, Number(big) & 0xff]);
    if (big < 4294967296n) {
      const b = Buffer.alloc(5);
      b[0] = (major << 5) | 26;
      b.writeUInt32BE(Number(big), 1);
      return b;
    }
    // 64-bit unsigned (minor 27) — needed for epoch-ms timestamps.
    const b = Buffer.alloc(9);
    b[0] = (major << 5) | 27;
    b.writeBigUInt64BE(big, 1);
    return b;
  };
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return head(0, value);
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  if (typeof value === 'string') {
    const b = Buffer.from(value, 'utf8');
    return Buffer.concat([head(3, b.length), b]);
  }
  if (Array.isArray(value))
    return Buffer.concat([head(4, value.length), ...value.map(cborEncodeForTest)]);
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    const parts = [head(5, entries.length)];
    for (const [k, v] of entries) {
      parts.push(/^\d+$/.test(k) ? cborEncodeForTest(Number(k)) : cborEncodeForTest(k));
      parts.push(cborEncodeForTest(v));
    }
    return Buffer.concat(parts);
  }
  throw new Error(`cborEncodeForTest: unsupported ${typeof value}`);
}

function buildAttestationDoc({ userDataHex, pcr0Hex, nonceHex, timestampMs }) {
  const payload = {
    pcrs: { 0: Buffer.from(pcr0Hex, 'hex'), 1: Buffer.alloc(48, 1) },
    user_data: Buffer.from(userDataHex, 'hex'),
  };
  if (nonceHex) payload.nonce = Buffer.from(nonceHex, 'hex');
  if (typeof timestampMs === 'number') payload.timestamp = timestampMs;
  const cose = [Buffer.from([0xa0]), {}, cborEncodeForTest(payload), Buffer.alloc(96, 7)];
  return cborEncodeForTest(cose).toString('base64');
}

describe('verifyEnclaveAttestation (C1)', () => {
  const DIGEST = 'ab'.repeat(32);
  const userDataFor = (digestHex) =>
    createHash('sha256').update(Buffer.from(digestHex, 'hex')).digest('hex');
  const PCR0 = 'cd'.repeat(48);

  it('absent attestation => not attested, no throw (backward compatible)', () => {
    const res = verifyEnclaveAttestation({}, { signature: 'a'.repeat(128) }, DIGEST);
    assert.equal(res.attested, false);
    assert.match(res.reason, /no attestation document/);
  });

  it('digest binding verified but no pinned PCR0 => downgrade (not attested)', () => {
    const doc = buildAttestationDoc({ userDataHex: userDataFor(DIGEST), pcr0Hex: PCR0 });
    const res = verifyEnclaveAttestation({}, { attestation_doc_base64: doc }, DIGEST);
    assert.equal(res.attested, false);
    assert.match(res.reason, /no MORPHEUS_EXPECTED_PCR0 pinned/);
    assert.equal(res.pcr0, PCR0);
  });

  it('digest + pinned PCR0 without a verified COSE chain remains untrusted', () => {
    const doc = buildAttestationDoc({ userDataHex: userDataFor(DIGEST), pcr0Hex: PCR0 });
    const config = { nitro: { expectedPcr0: PCR0 } };
    const res = verifyEnclaveAttestation(config, { attestation_doc_base64: doc }, DIGEST);
    assert.equal(res.attested, false);
    assert.equal(res.pcr0, PCR0);
    assert.match(res.reason, /signature\/certificate chain was not verified/);
  });

  it('a document binding the WRONG digest is a hard failure (throws)', () => {
    const doc = buildAttestationDoc({ userDataHex: userDataFor('11'.repeat(32)), pcr0Hex: PCR0 });
    assert.throws(
      () => verifyEnclaveAttestation({}, { attestation_doc_base64: doc }, DIGEST),
      /does not bind the fulfillment digest/
    );
  });

  it('a wrong PCR0 (when one is pinned) is a hard failure (throws)', () => {
    const doc = buildAttestationDoc({ userDataHex: userDataFor(DIGEST), pcr0Hex: 'ee'.repeat(48) });
    const config = { nitro: { expectedPcr0: PCR0 } };
    assert.throws(
      () => verifyEnclaveAttestation(config, { attestation_doc_base64: doc }, DIGEST),
      /PCR0 does not match the pinned measurement/
    );
  });

  it('resolveExpectedPcr0 reads config then env (lowercased, no 0x)', () => {
    assert.equal(resolveExpectedPcr0({ nitro: { expectedPcr0: '0xABcd' } }), 'abcd');
    const saved = process.env.MORPHEUS_EXPECTED_PCR0;
    process.env.MORPHEUS_EXPECTED_PCR0 = '0xFEED';
    try {
      assert.equal(resolveExpectedPcr0({}), 'feed');
    } finally {
      if (saved === undefined) delete process.env.MORPHEUS_EXPECTED_PCR0;
      else process.env.MORPHEUS_EXPECTED_PCR0 = saved;
    }
  });
});

// ===================================================================
// Confidential decrypt lane is ENCLAVE-ONLY (no off-TEE public failover)
// ===================================================================

describe('confidential decrypt lane endpoint isolation', () => {
  const silentLogger = { info() {}, warn() {}, error() {} };

  function decryptConfig(extra = {}) {
    return {
      network: 'testnet',
      maxRetries: 3,
      maxCallbackRetries: 6,
      retryBaseDelayMs: 10,
      retryMaxDelayMs: 100,
      processedCacheSize: 100,
      deadLetterLimit: 10,
      durableQueue: { enabled: false },
      nitro: {
        // apiUrl carries a PUBLIC off-TEE failover (the live topology); the decrypt
        // lane must NEVER touch it.
        apiUrl: 'https://enclave.test,https://oracle.public.test/testnet',
        signerUrl: 'https://enclave.test',
        decryptUrl: 'https://enclave.test',
        enclaveFulfill: false,
        timeoutMs: 1000,
        custodyUrl: 'https://custody.test',
        custodyToken: 'custody-token',
      },
      neo_n3: {
        oracleContract: '0x1212121212121212121212121212121212121212',
        networkMagic: 894710606,
        custodyKeyIds: { oracle_verifier: 'key-oracle-verifier' },
      },
      hooks: {
        fulfillNeoRequest: async () => ({ tx_hash: '0xfeed', vm_state: 'HALT' }),
      },
      ...extra,
    };
  }

  it('sends /oracle/decrypt ONLY to the enclave URL and never to the public apiUrl', async () => {
    const calls = [];
    const original = global.fetch;
    global.fetch = async (url) => {
      const u = String(url);
      calls.push(u);
      if (u.startsWith('https://enclave.test') && u.endsWith('/oracle/decrypt')) {
        return new Response(JSON.stringify({ plaintext: 'revealed-secret' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.endsWith('/sign/raw')) {
        return custodySignRawResponse('c'.repeat(128));
      }
      return new Response(JSON.stringify({ error: `unexpected endpoint ${u}` }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      });
    };
    const event = {
      chain: 'neo_n3',
      requestId: '7100',
      requestType: 'confidential_reveal',
      appId: 'miniapp-message',
      payloadText: 'sealed-envelope-bytes',
      txHash: '0x7100',
    };
    try {
      await processEvent(
        decryptConfig(),
        createEmptyRelayerState(),
        () => {},
        silentLogger,
        event,
        {
          attempts: 0,
          durable_claimed: true,
        }
      );
      const decryptCalls = calls.filter((u) => u.endsWith('/oracle/decrypt'));
      assert.equal(decryptCalls.length, 1, 'exactly one decrypt call');
      assert.ok(
        decryptCalls.every((u) => u.startsWith('https://enclave.test')),
        'decrypt must only hit the enclave URL'
      );
      assert.ok(
        !calls.some((u) => u.includes('oracle.public.test')),
        'decrypt must NEVER fail over to the public off-TEE endpoint'
      );
    } finally {
      global.fetch = original;
    }
  });

  it('fails closed (no public failover) when the enclave decrypt endpoint is unreachable', async () => {
    const calls = [];
    const original = global.fetch;
    global.fetch = async (url) => {
      const u = String(url);
      calls.push(u);
      if (u.startsWith('https://enclave.test')) {
        throw new Error('ECONNREFUSED enclave down');
      }
      // A public endpoint should never be reached; if it is, return success so the
      // assertion below (no public contact) is what fails the test.
      return new Response(JSON.stringify({ plaintext: 'leaked-off-tee' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const event = {
      chain: 'neo_n3',
      requestId: '7101',
      requestType: 'confidential_reveal',
      appId: 'miniapp-message',
      payloadText: 'sealed-envelope-bytes',
      txHash: '0x7101',
    };
    try {
      await processEvent(
        decryptConfig(),
        createEmptyRelayerState(),
        () => {},
        silentLogger,
        event,
        {
          attempts: 0,
          durable_claimed: true,
        }
      );
      assert.ok(
        !calls.some((u) => u.includes('oracle.public.test')),
        'must NOT fall back to a public off-TEE endpoint when the enclave is down'
      );
    } finally {
      global.fetch = original;
    }
  });
});

// ===================================================================
// C1 freshness / anti-replay — nonce echo + timestamp window
// ===================================================================

describe('verifyEnclaveAttestation freshness/anti-replay', () => {
  const DIGEST = 'ab'.repeat(32);
  const userDataFor = (digestHex) =>
    createHash('sha256').update(Buffer.from(digestHex, 'hex')).digest('hex');
  const PCR0 = 'cd'.repeat(48);
  const config = { nitro: { expectedPcr0: PCR0 } };

  it('a doc echoing the relayer nonce passes freshness but remains unsigned', () => {
    const nonceHex = '11'.repeat(16);
    const doc = buildAttestationDoc({
      userDataHex: userDataFor(DIGEST),
      pcr0Hex: PCR0,
      nonceHex,
    });
    const res = verifyEnclaveAttestation(config, { attestation_doc_base64: doc }, DIGEST, {
      expectedNonce: nonceHex,
    });
    assert.equal(res.attested, false);
  });

  it('a captured doc with a DIFFERENT nonce is rejected (replay, throws)', () => {
    const doc = buildAttestationDoc({
      userDataHex: userDataFor(DIGEST),
      pcr0Hex: PCR0,
      nonceHex: '22'.repeat(16),
    });
    assert.throws(
      () =>
        verifyEnclaveAttestation(config, { attestation_doc_base64: doc }, DIGEST, {
          expectedNonce: '11'.repeat(16),
        }),
      /nonce does not echo|possible replay/
    );
  });

  it('a doc WITHOUT a nonce stays backward-compatible (no hard fail)', () => {
    const doc = buildAttestationDoc({ userDataHex: userDataFor(DIGEST), pcr0Hex: PCR0 });
    const res = verifyEnclaveAttestation(config, { attestation_doc_base64: doc }, DIGEST, {
      expectedNonce: '11'.repeat(16),
    });
    assert.equal(res.attested, false);
  });

  it('a stale timestamp (beyond max age) is rejected when a max age is configured', () => {
    const cfg = { nitro: { expectedPcr0: PCR0, attestationMaxAgeMs: 60_000 } };
    const now = 1_000_000_000_000;
    const doc = buildAttestationDoc({
      userDataHex: userDataFor(DIGEST),
      pcr0Hex: PCR0,
      timestampMs: now - 120_000, // 2 min old, window is 1 min
    });
    assert.throws(
      () => verifyEnclaveAttestation(cfg, { attestation_doc_base64: doc }, DIGEST, { now }),
      /freshness window|possible replay/
    );
  });

  it('a fresh timestamp within the window is accepted', () => {
    const cfg = { nitro: { expectedPcr0: PCR0, attestationMaxAgeMs: 60_000 } };
    const now = 1_000_000_000_000;
    const doc = buildAttestationDoc({
      userDataHex: userDataFor(DIGEST),
      pcr0Hex: PCR0,
      timestampMs: now - 5_000,
    });
    const res = verifyEnclaveAttestation(cfg, { attestation_doc_base64: doc }, DIGEST, { now });
    assert.equal(res.attested, false);
  });

  it('timestamp gate is inert when no max age is configured (backward compatible)', () => {
    const doc = buildAttestationDoc({
      userDataHex: userDataFor(DIGEST),
      pcr0Hex: PCR0,
      timestampMs: 1, // ancient, but no max-age set
    });
    const res = verifyEnclaveAttestation(config, { attestation_doc_base64: doc }, DIGEST);
    assert.equal(res.attested, false);
  });
});

// ===================================================================
// C1 mandatory COSE_Sign1 ES384 signature + cert-chain verification for trust
// ===================================================================
//
// Full end-to-end COSE signature verification requires minting a real P-384 cert
// chain. The relayer may continue fulfillment when the root or chain is absent, but
// it must downgrade the result to host-unattested. A configured root + REAL cert
// chain that fails verification is a hard failure. These tests cover resolution,
// downgrade and malformed hard-fail branches without depending on cert minting.

// Build an attestation doc that carries a (bogus) certificate chain + a 96-byte
// signature, so the crypto branch is exercised (rather than short-circuited by an
// absent chain).
function buildAttestationDocWithChain({ userDataHex, pcr0Hex, leafDer, cabundleDer }) {
  const payload = {
    pcrs: { 0: Buffer.from(pcr0Hex, 'hex'), 1: Buffer.alloc(48, 1) },
    user_data: Buffer.from(userDataHex, 'hex'),
    certificate: leafDer,
    cabundle: cabundleDer,
  };
  const cose = [Buffer.from([0xa0]), {}, cborEncodeForTest(payload), Buffer.alloc(96, 7)];
  return cborEncodeForTest(cose).toString('base64');
}

describe('verifyEnclaveAttestation COSE crypto verification', () => {
  const DIGEST = 'ab'.repeat(32);
  const userDataFor = (digestHex) =>
    createHash('sha256').update(Buffer.from(digestHex, 'hex')).digest('hex');
  const PCR0 = 'cd'.repeat(48);
  const ROOT_PEM = '-----BEGIN CERTIFICATE-----\nMIIBfakeRootCert\n-----END CERTIFICATE-----';

  it('resolveNitroRootCertPem reads config then env', () => {
    assert.equal(resolveNitroRootCertPem({ nitro: { nitroRootCertPem: 'PEM-A' } }), 'PEM-A');
    const saved = process.env.MORPHEUS_NITRO_ROOT_CERT_PEM;
    process.env.MORPHEUS_NITRO_ROOT_CERT_PEM = 'PEM-B';
    try {
      assert.equal(resolveNitroRootCertPem({}), 'PEM-B');
    } finally {
      if (saved === undefined) delete process.env.MORPHEUS_NITRO_ROOT_CERT_PEM;
      else process.env.MORPHEUS_NITRO_ROOT_CERT_PEM = saved;
    }
  });

  it('downgrades when no root cert is pinned', () => {
    const config = { nitro: { expectedPcr0: PCR0 } };
    const doc = buildAttestationDoc({ userDataHex: userDataFor(DIGEST), pcr0Hex: PCR0 });
    const res = verifyEnclaveAttestation(config, { attestation_doc_base64: doc }, DIGEST);
    assert.equal(res.attested, false);
    assert.equal(res.cose_verified, false, 'no root pinned => crypto check skipped');
  });

  it('downgrades when a root is pinned but the doc carries no cert chain', () => {
    const config = { nitro: { expectedPcr0: PCR0, nitroRootCertPem: ROOT_PEM } };
    const doc = buildAttestationDoc({ userDataHex: userDataFor(DIGEST), pcr0Hex: PCR0 });
    const res = verifyEnclaveAttestation(config, { attestation_doc_base64: doc }, DIGEST);
    assert.equal(res.attested, false);
    assert.equal(res.cose_verified, false);
  });

  it('hard-fails when a root is pinned and the doc carries a MALFORMED cert chain', () => {
    const config = { nitro: { expectedPcr0: PCR0, nitroRootCertPem: ROOT_PEM } };
    const doc = buildAttestationDocWithChain({
      userDataHex: userDataFor(DIGEST),
      pcr0Hex: PCR0,
      leafDer: Buffer.from('not-a-real-der-cert'),
      cabundleDer: [Buffer.from('also-bogus')],
    });
    assert.throws(
      () => verifyEnclaveAttestation(config, { attestation_doc_base64: doc }, DIGEST),
      /certificate chain is malformed|does not verify/
    );
  });
});

// ===================================================================
// C3 — confidential decrypt binding request (buildDecryptBindingRequest)
// ===================================================================

describe('buildDecryptBindingRequest (C3)', () => {
  it('sends only the envelope when no message_id is derivable (legacy)', () => {
    const req = buildDecryptBindingRequest(
      {},
      { chain: 'neox' },
      { raw_payload: 'env' },
      'the-env'
    );
    assert.deepEqual(req, { envelope: 'the-env' });
  });

  it('includes chain + message_id + contract when a message id is present', () => {
    const config = { neox: { messageContract: '0xCAFE' } };
    const req = buildDecryptBindingRequest(config, { chain: 'neox' }, { message_id: '7' }, 'env7');
    assert.equal(req.envelope, 'env7');
    assert.equal(req.message_id, '7');
    assert.equal(req.chain, 'neox');
    assert.equal(req.contract, '0xCAFE');
  });

  it('prefers a payload-supplied contract over config', () => {
    const config = { neox: { messageContract: '0xCAFE' } };
    const req = buildDecryptBindingRequest(
      config,
      {},
      { messageId: 9, contract: '0xBEEF' },
      'env9'
    );
    assert.equal(req.message_id, '9');
    assert.equal(req.contract, '0xBEEF');
  });
});

// ===================================================================
// digest-sig LOW — enclave signature cross-check against the pinned verifier
// ===================================================================

describe('verifyEnclaveSignatureAgainstPinnedVerifier (digest-sig)', () => {
  const DIGEST = 'ab'.repeat(32);

  it('is a no-op (checked:false) for non-neo chains', () => {
    const res = verifyEnclaveSignatureAgainstPinnedVerifier({}, 'neox', {}, DIGEST);
    assert.equal(res.checked, false);
  });

  it('verifies a real signature against an env-pinned verifier and accepts it', async () => {
    const neon = await import('@cityofzion/neon-js');
    const account = new neon.wallet.Account(neon.wallet.generatePrivateKey());
    const saved = {
      allow: process.env.MORPHEUS_ALLOW_UNPINNED_SIGNERS,
      key: process.env.MORPHEUS_ORACLE_VERIFIER_PUBLIC_KEY_TESTNET,
    };
    process.env.MORPHEUS_ALLOW_UNPINNED_SIGNERS = '1';
    process.env.MORPHEUS_ORACLE_VERIFIER_PUBLIC_KEY_TESTNET = account.publicKey;
    try {
      const goodSig = neon.wallet.sign(DIGEST, account.privateKey);
      const ok = verifyEnclaveSignatureAgainstPinnedVerifier(
        { network: 'testnet' },
        'neo_n3',
        { signature: goodSig, public_key: account.publicKey },
        DIGEST
      );
      assert.equal(ok.verified, true);

      // A different signer's public_key is rejected (key mismatch -> throws).
      const other = new neon.wallet.Account(neon.wallet.generatePrivateKey());
      assert.throws(
        () =>
          verifyEnclaveSignatureAgainstPinnedVerifier(
            { network: 'testnet' },
            'neo_n3',
            { signature: goodSig, public_key: other.publicKey },
            DIGEST
          ),
        /!= pinned oracle_verifier/
      );

      // A non-verifying signature over the digest is rejected (throws).
      assert.throws(
        () =>
          verifyEnclaveSignatureAgainstPinnedVerifier(
            { network: 'testnet' },
            'neo_n3',
            { signature: 'a'.repeat(128), public_key: account.publicKey },
            DIGEST
          ),
        /does not verify against the pinned oracle_verifier/
      );
    } finally {
      if (saved.allow === undefined) delete process.env.MORPHEUS_ALLOW_UNPINNED_SIGNERS;
      else process.env.MORPHEUS_ALLOW_UNPINNED_SIGNERS = saved.allow;
      if (saved.key === undefined) delete process.env.MORPHEUS_ORACLE_VERIFIER_PUBLIC_KEY_TESTNET;
      else process.env.MORPHEUS_ORACLE_VERIFIER_PUBLIC_KEY_TESTNET = saved.key;
    }
  });
});
