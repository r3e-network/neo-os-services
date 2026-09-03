//! Ported from `workers/nitro-worker/src/platform/risk-observer.test.mjs`,
//! plus the coercion corners (`Number(null)` = 0, the `??` chain on
//! `stale_seconds`, the failures/successes fallback path).

use morpheus_compute::risk::classify_risk_signal;
use serde_json::json;

#[test]
fn pauses_failing_scopes() {
    let risk = classify_risk_signal(&json!({
        "failure_rate": 1,
        "scope": "provider",
        "scope_id": "coinbase-spot",
    }));
    assert_eq!(risk["action"], "pause_scope");
    assert_eq!(risk["reason"], "failure_rate_exceeded");
    assert_eq!(risk["severity"], "high");
    assert_eq!(risk["scope"], "provider");
    assert_eq!(risk["scope_id"], "coinbase-spot");
}

#[test]
fn keeps_healthy_scopes_in_observe_mode() {
    let risk = classify_risk_signal(&json!({
        "failure_rate": 0.2,
        "scope": "workflow",
        "scope_id": "oracle.query",
    }));
    assert_eq!(risk["action"], "observe");
    assert_eq!(risk["reason"], "healthy");
    assert_eq!(risk["severity"], "low");
    assert_eq!(risk["scope"], "workflow");
    assert_eq!(risk["scope_id"], "oracle.query");
}

#[test]
fn elevates_at_half_failure_rate() {
    let risk = classify_risk_signal(&json!({ "failure_rate": 0.5 }));
    assert_eq!(risk["action"], "observe");
    assert_eq!(risk["reason"], "elevated_failure_rate");
    assert_eq!(risk["severity"], "medium");
}

#[test]
fn a_stale_signal_pauses_even_with_zero_failures() {
    let risk = classify_risk_signal(&json!({ "failure_rate": 0, "stale_seconds": 600 }));
    assert_eq!(risk["action"], "pause_scope");
    assert_eq!(risk["reason"], "stale_signal");

    let just_under = classify_risk_signal(&json!({ "stale_seconds": 599.5 }));
    assert_eq!(just_under["action"], "observe");
}

#[test]
fn failure_rate_defaults_to_the_failures_successes_ratio() {
    let risk = classify_risk_signal(&json!({ "failures": 3, "successes": 1 }));
    assert_eq!(risk["failure_rate"], 0.75);

    // No samples at all -> rate 0, healthy.
    let empty = classify_risk_signal(&json!({}));
    assert_eq!(empty["failure_rate"], 0);
    assert_eq!(empty["reason"], "healthy");

    // A present-but-null failure_rate: JS `Number(null)` is 0, not NaN.
    let nulled = classify_risk_signal(&json!({ "failure_rate": null }));
    assert_eq!(nulled["failure_rate"], 0);
}

#[test]
fn scope_defaults_follow_the_js_shape() {
    // Missing scope -> "workflow"; missing scope_id -> the scope itself.
    let risk = classify_risk_signal(&json!({ "failure_rate": 1 }));
    assert_eq!(risk["scope"], "workflow");
    assert_eq!(risk["scope_id"], "workflow");

    // CamelCase alias for the stale field through the ?? chain; a null
    // primary is treated as absent.
    let stale = classify_risk_signal(&json!({ "stale_seconds": null, "staleSeconds": 601 }));
    assert_eq!(stale["action"], "pause_scope");

    // A falsy-but-present scope id does not fall back before the trim: the
    // JS `||` skips it entirely.
    let falsy_id = classify_risk_signal(&json!({ "scope": "provider", "scope_id": "" }));
    assert_eq!(falsy_id["scope_id"], "provider");
}

#[test]
fn the_output_keeps_the_js_key_order() {
    let risk = classify_risk_signal(&json!({}));
    let keys: Vec<&str> = risk
        .as_object()
        .expect("object")
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(
        keys,
        vec![
            "action",
            "scope",
            "scope_id",
            "reason",
            "severity",
            "failure_rate",
            "stale_seconds",
        ]
    );
    // Integral numbers serialize without a decimal point, like JS.
    assert_eq!(risk["failure_rate"].to_string(), "0");
    assert_eq!(risk["stale_seconds"].to_string(), "0");
}
