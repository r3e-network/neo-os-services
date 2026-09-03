//! `classifyRiskSignal` — the port of `platform/risk-observer.js`.
//!
//! Pure classifier: given a provider/workflow health signal it recommends
//! `pause_scope` (total failure or a stale signal), `observe` with an
//! elevated reason (≥ 0.5 failure rate), or plain `observe`. The circuit
//! breaker folds its state into a signal through `get_state()`.
//!
//! Number coercion keeps the JS corners: `Number(null)` is `0` (not the
//! fallback), a present-but-null `failure_rate` therefore classifies as 0,
//! while the `??` chain on `stale_seconds` treats null as absent.

use serde_json::{json, Value as Json};

use crate::js::{js_number_value, js_to_number, js_trim_string};

/// `Number(value)` with a fallback for non-finite results. `Number(null)` is
/// `0` in JS — NOT the fallback — so a present JSON null lands on 0. Arrays
/// coerce through `Array.prototype.join` (`['5']` is 5, `[]` is 0, longer
/// arrays and objects are NaN → the fallback).
fn to_number(value: Option<&Json>, fallback: f64) -> f64 {
    let Some(value) = value else {
        return fallback;
    };
    let numeric = js_to_number(value);
    if numeric.is_finite() {
        numeric
    } else {
        fallback
    }
}

fn normalize_scope(signal: &Json, key: &str) -> String {
    let normalized = js_trim_string(signal.get(key)).to_lowercase();
    if normalized.is_empty() {
        "workflow".to_string()
    } else {
        normalized
    }
}

/// `normalizeScopeId(signal.scope_id || signal.scopeId, scope)` — truthy
/// chain, then trim, then the fallback. A truthy-but-whitespace value is
/// resolved by the `||`, trimmed to `''` and loses to the fallback.
fn normalize_scope_id(signal: &Json, fallback: &str) -> String {
    for key in ["scope_id", "scopeId"] {
        if let Some(value) = signal.get(key) {
            if crate::js::js_truthy(value) {
                let trimmed = js_trim_string(Some(value));
                if !trimmed.is_empty() {
                    return trimmed;
                }
                return fallback.to_string();
            }
        }
    }
    fallback.to_string()
}

fn resolve_failure_rate(signal: &Json) -> f64 {
    if let Some(rate) = signal.get("failure_rate") {
        // JS: `signal.failure_rate !== undefined` — presence, not truthiness.
        return to_number(Some(rate), 0.0).max(0.0);
    }
    let failures = to_number(signal.get("failures"), 0.0).max(0.0);
    let successes = to_number(signal.get("successes"), 0.0).max(0.0);
    let total = failures + successes;
    if total <= 0.0 {
        0.0
    } else {
        failures / total
    }
}

pub fn classify_risk_signal(signal: &Json) -> Json {
    let scope = normalize_scope(signal, "scope");
    let scope_id = normalize_scope_id(signal, &scope);
    let failure_rate = resolve_failure_rate(signal);
    let stale_seconds = to_number(
        signal
            .get("stale_seconds")
            .filter(|v| !v.is_null())
            .or_else(|| signal.get("staleSeconds").filter(|v| !v.is_null())),
        0.0,
    )
    .max(0.0);

    if failure_rate >= 1.0 || stale_seconds >= 600.0 {
        return json!({
            "action": "pause_scope",
            "scope": scope,
            "scope_id": scope_id,
            "reason": if failure_rate >= 1.0 { "failure_rate_exceeded" } else { "stale_signal" },
            "severity": "high",
            "failure_rate": js_number_value(failure_rate),
            "stale_seconds": js_number_value(stale_seconds),
        });
    }

    if failure_rate >= 0.5 {
        return json!({
            "action": "observe",
            "scope": scope,
            "scope_id": scope_id,
            "reason": "elevated_failure_rate",
            "severity": "medium",
            "failure_rate": js_number_value(failure_rate),
            "stale_seconds": js_number_value(stale_seconds),
        });
    }

    json!({
        "action": "observe",
        "scope": scope,
        "scope_id": scope_id,
        "reason": "healthy",
        "severity": "low",
        "failure_rate": js_number_value(failure_rate),
        "stale_seconds": js_number_value(stale_seconds),
    })
}
