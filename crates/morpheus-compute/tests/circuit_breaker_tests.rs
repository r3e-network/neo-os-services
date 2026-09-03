//! Ported from `workers/nitro-worker/src/platform/circuit-breaker.test.mjs`.
//! The JS fakes time by assigning `cb.lastFailureAt`; here the clock is the
//! `now_ms` parameter, so every scenario drives the same transitions with an
//! explicit timeline.

use morpheus_compute::circuit_breaker::CircuitBreaker;
use serde_json::Value;

#[test]
fn starts_closed_with_zero_failures() {
    let mut cb = CircuitBreaker::new("test");
    assert_eq!(cb.get_state()["state"], "closed");
    assert_eq!(cb.get_state()["failures"], 0);
    assert!(cb.allow(1_000));
}

#[test]
fn opens_after_reaching_failure_threshold() {
    let mut cb = CircuitBreaker::new("test").with_failure_threshold(3);
    cb.record_failure(1_000);
    cb.record_failure(1_000);
    assert!(cb.allow(1_000));
    cb.record_failure(1_000);
    assert_eq!(cb.get_state()["state"], "open");
    assert!(!cb.allow(1_000));
}

#[test]
fn resets_to_closed_on_success_from_half_open() {
    let mut cb = CircuitBreaker::new("test")
        .with_failure_threshold(1)
        .with_reset_timeout_ms(0);
    cb.record_failure(1_000);
    assert_eq!(cb.get_state()["state"], "open");

    // The JS test sets lastFailureAt = 0 to expire the timeout; the port
    // advances the clock (reset_timeout_ms = 0 means any now_ms does).
    assert!(cb.allow(1_000)); // transitions to half_open, grants quota
    assert_eq!(cb.get_state()["state"], "half_open");

    cb.record_success();
    assert_eq!(cb.get_state()["state"], "closed");
    assert_eq!(cb.get_state()["failures"], 0);
}

#[test]
fn returns_to_open_on_failure_during_half_open() {
    let mut cb = CircuitBreaker::new("test")
        .with_failure_threshold(1)
        .with_reset_timeout_ms(0);
    cb.record_failure(1_000);
    cb.allow(1_000); // half_open
    cb.record_failure(1_000);
    assert_eq!(cb.get_state()["state"], "open");
}

#[test]
fn respects_half_open_quota() {
    let mut cb = CircuitBreaker::new("test")
        .with_failure_threshold(1)
        .with_reset_timeout_ms(0)
        .with_half_open_max(2);
    cb.record_failure(1_000);

    assert!(cb.allow(1_000)); // quota 2 -> 1
    assert!(cb.allow(1_000)); // quota 1 -> 0
    assert!(!cb.allow(1_000)); // quota exhausted
}

#[test]
fn is_open_is_false_for_closed_state() {
    let mut cb = CircuitBreaker::new("test");
    assert!(!cb.is_open(1_000));
}

#[test]
fn is_open_is_true_for_open_state_before_timeout() {
    let mut cb = CircuitBreaker::new("test")
        .with_failure_threshold(1)
        .with_reset_timeout_ms(999_999);
    cb.record_failure(1_000);
    assert!(cb.is_open(1_000));
}

#[test]
fn is_open_transitions_open_to_half_open_after_timeout() {
    let mut cb = CircuitBreaker::new("test")
        .with_failure_threshold(1)
        .with_reset_timeout_ms(0);
    cb.record_failure(1_000);
    // The JS test sets lastFailureAt = Date.now() - 1; the port ticks once.
    assert!(!cb.is_open(1_001));
    assert_eq!(cb.get_state()["state"], "half_open");
}

#[test]
fn get_state_includes_all_fields() {
    let cb = CircuitBreaker::new("my-provider").with_failure_threshold(5);
    let state = cb.get_state();
    assert_eq!(state["name"], "my-provider");
    assert_eq!(state["state"], "closed");
    assert_eq!(state["failures"], 0);
    assert_eq!(state["successes"], 0);
    assert_eq!(state["last_failure_at"], Value::Null);
}

#[test]
fn get_state_includes_the_recommended_risk_action() {
    let mut cb = CircuitBreaker::new("coinbase-spot").with_failure_threshold(1);
    cb.record_failure(1_000);
    let state = cb.get_state();
    assert_eq!(state["recommended_action"], "pause_scope");
    assert_eq!(state["risk_scope"], "provider");
    assert_eq!(state["risk_scope_id"], "coinbase-spot");
}

#[test]
fn records_and_resets_success_and_failure_counts() {
    let mut cb = CircuitBreaker::new("test");
    cb.record_success();
    cb.record_success();
    assert_eq!(cb.get_state()["successes"], 2);

    cb.record_failure(1_000);
    assert_eq!(cb.get_state()["successes"], 0);

    cb.record_failure(1_000);
    cb.record_success();
    assert_eq!(cb.get_state()["failures"], 0);
}

#[test]
fn last_failure_at_carries_the_injected_clock() {
    let mut cb = CircuitBreaker::new("test").with_failure_threshold(1);
    cb.record_failure(1_714_000_000_000);
    assert_eq!(cb.get_state()["last_failure_at"], 1_714_000_000_000u64);
}
