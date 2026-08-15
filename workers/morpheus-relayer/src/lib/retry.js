// Shared retry-backoff policy for the relayer.
//
// Single source of truth for the exponential-backoff-with-jitter delay used by
// every retry lane (block-scan retries via state.js:scheduleRetry, and the
// prepared-callback / finalize-only redelivery lanes in fulfillment.js). Keeping
// one implementation here — imported by both, depended on by neither — prevents
// the two lanes from drifting and re-stampeding a recovering dependency. It lives
// in lib/ (not in fulfillment.js or state.js) because fulfillment.js already
// imports state.js, so co-locating it in either would create an import cycle.

/**
 * Exponential backoff with full/equal jitter.
 *
 * Doubles the base delay per attempt up to a ceiling, then spreads the result
 * across [0.5, 1.0] * ceiling so a shared-dependency outage (RPC, Nitro signer,
 * Supabase 402) does not bucket every queued retry into the same next_retry_at
 * and re-stampede the recovering dependency on a single tick. Math.round keeps
 * integer-millisecond timestamps.
 *
 * @param {{retryBaseDelayMs:number, retryMaxDelayMs:number}} config
 * @param {number} attempts 1-based attempt count
 * @param {() => number} [rng] injectable [0,1) source for deterministic tests
 * @returns {number} delay in milliseconds
 */
export function computeRetryDelayMs(config, attempts, rng = Math.random) {
  const ceiling = Math.min(
    config.retryBaseDelayMs * 2 ** Math.max(attempts - 1, 0),
    config.retryMaxDelayMs
  );
  const jitterFactor = 0.5 + 0.5 * rng();
  return Math.round(ceiling * jitterFactor);
}
