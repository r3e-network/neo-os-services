//! Shared retry-backoff policy for the relayer (port of
//! workers/morpheus-relayer/src/lib/retry.js).
//!
//! Single source of truth for the exponential-backoff-with-jitter delay used
//! by every retry lane (block-scan retries via state.rs:schedule_retry, and
//! the prepared-callback / finalize-only redelivery lanes). Keeping one
//! implementation prevents the lanes from drifting and re-stampeding a
//! recovering dependency.

/// Exponential backoff with full/equal jitter (port of `computeRetryDelayMs`).
///
/// Doubles the base delay per attempt up to a ceiling, then spreads the
/// result across [0.5, 1.0] * ceiling so a shared-dependency outage does not
/// bucket every queued retry into the same next_retry_at. `rng` is an
/// injectable [0,1) source for deterministic tests (JS default Math.random).
///
/// `Math.round` is ES `floor(x + 0.5)`; the argument is always non-negative
/// here, so implementing it as `(x + 0.5).floor()` matches the spec exactly
/// (Rust's `f64::round` is half-away-from-zero, a different function).
pub fn compute_retry_delay_ms(
    retry_base_delay_ms: f64,
    retry_max_delay_ms: f64,
    attempts: f64,
    rng: f64,
) -> f64 {
    // JS `2 ** Math.max(attempts - 1, 0)` is a FLOATING-POINT power: a
    // fractional attempts value yields a fractional exponent (2^1.5), so this
    // must be powf, never powi. NaN propagates like JS too: Math.max(NaN, 0)
    // is NaN, 2 ** NaN is NaN and Math.min(NaN, max) stays NaN (Rust's
    // f64::min would swallow the NaN, hence the explicit guard).
    let raw_exponent = attempts - 1.0;
    let exponent = if raw_exponent.is_nan() {
        f64::NAN
    } else {
        raw_exponent.max(0.0)
    };
    let grown = retry_base_delay_ms * 2f64.powf(exponent);
    let ceiling = if grown.is_nan() {
        f64::NAN
    } else {
        grown.min(retry_max_delay_ms)
    };
    let jitter_factor = 0.5 + 0.5 * rng;
    (ceiling * jitter_factor + 0.5).floor()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config_of(base: f64, max: f64) -> (f64, f64) {
        (base, max)
    }

    #[test]
    fn doubles_then_caps() {
        let (base, max) = config_of(5000.0, 60_000.0);
        // attempt 1 → 5000 * 1 = 5000; rng 1.0 → full ceiling.
        assert_eq!(compute_retry_delay_ms(base, max, 1.0, 1.0), 5000.0);
        // attempt 4 → 5000 * 8 = 40000.
        assert_eq!(compute_retry_delay_ms(base, max, 4.0, 1.0), 40_000.0);
        // attempt 8 → 5000 * 128 = 640000 → capped at 60000.
        assert_eq!(compute_retry_delay_ms(base, max, 8.0, 1.0), 60_000.0);
    }

    #[test]
    fn jitter_spreads_half_to_full_ceiling() {
        let (base, max) = config_of(5000.0, 60_000.0);
        // rng 0.0 → 0.5 * ceiling; rng 0.5 → 0.75 * ceiling.
        assert_eq!(compute_retry_delay_ms(base, max, 1.0, 0.0), 2500.0);
        assert_eq!(compute_retry_delay_ms(base, max, 1.0, 0.5), 3750.0);
        // Fractional results round half-up.
        assert_eq!(compute_retry_delay_ms(base, max, 1.0, 0.001), 2502.0);
    }

    #[test]
    fn attempt_floor_is_zero_exponent() {
        let (base, max) = config_of(5000.0, 60_000.0);
        // attempts 0 → 2^0 = 1 → same as attempt 1.
        assert_eq!(
            compute_retry_delay_ms(base, max, 0.0, 1.0),
            compute_retry_delay_ms(base, max, 1.0, 1.0)
        );
    }
}
