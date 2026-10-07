//! Price-plane provider state and runway tests. The runway arithmetic is a port
//! of feed-monitor.mjs's `assessRunway`, including its refusals: a balance that
//! cannot pay one write is zero days, and under an hour of observed span is not
//! an estimate at all. "No data" must never read as "fine".

use super::*;
use crate::feed_status::{
    assess_runway, classify_provider_failure, provider_response_failed, sanitize_provider_message,
    PricePlaneStatus, RunwayConfig, RUNWAY_ALERT_DAYS, WRITE_FEE_GAS,
};

/// Seconds since the epoch, built from a day and an hour so every case is exact.
fn at(day: i64, hour: i64) -> i64 {
    (day * 24 + hour) * 3600
}

fn expired() -> ProviderFailure {
    ProviderFailure {
        category: "subscription_expired".to_string(),
        http_status: 401,
        summary: "Your subscription has expired".to_string(),
    }
}

// ---------------------------------------------------------------------------
// Provider state
// ---------------------------------------------------------------------------

#[test]
fn provider_state_is_absent_before_the_first_fetch() {
    let status = PricePlaneStatus::default();
    let value = status.snapshot(at(10, 0), RunwayConfig::default());
    // A fresh host has observed no provider verdict and says nothing about one.
    assert_eq!(value["provider"], Value::Null);
    assert_eq!(value["writes"]["observed"], 0);
}

#[test]
fn a_recorded_failure_carries_its_category_kind_and_page_verdict() {
    let mut status = PricePlaneStatus::default();
    status.record_failure(expired(), at(10, 3));
    let provider = status.snapshot(at(10, 3), RunwayConfig::default())["provider"].clone();
    assert_eq!(provider["state"], "failed");
    assert_eq!(provider["category"], "subscription_expired");
    assert_eq!(provider["kind"], "expired");
    assert_eq!(provider["page"], true);
    assert_eq!(provider["http_status"], 401);
    assert_eq!(provider["observed_at"], at(10, 3));
    assert_eq!(provider["summary"], "Your subscription has expired");
}

#[test]
fn a_later_success_clears_the_failure_state() {
    let mut status = PricePlaneStatus::default();
    status.record_failure(expired(), at(10, 3));
    status.record_success(at(10, 4));
    assert_eq!(
        status.snapshot(at(10, 4), RunwayConfig::default())["provider"]["state"],
        "ok"
    );
}

#[test]
fn every_category_maps_to_its_kind_and_whether_it_pages() {
    // feed-monitor.mjs's PROVIDER_FAILURES table.
    for (category, kind, page) in [
        ("provider_unauthorized", "unauthorized", true),
        ("subscription_expired", "expired", true),
        ("daily_quota_exhausted", "quota", true),
        ("rate_limited", "quota", true),
        ("minute_rate_limited", "rate_limited", false),
        ("provider_error", "error", false),
        ("no_usable_prices", "no_prices", false),
    ] {
        let mut status = PricePlaneStatus::default();
        status.record_failure(
            ProviderFailure {
                category: category.to_string(),
                http_status: 401,
                summary: "x".to_string(),
            },
            at(10, 3),
        );
        let provider = status.snapshot(at(10, 3), RunwayConfig::default())["provider"].clone();
        assert_eq!(provider["kind"], kind, "{category}");
        assert_eq!(provider["page"], page, "{category}");
    }
}

#[test]
fn an_unrecognised_category_still_reports_failed_and_pages() {
    let mut status = PricePlaneStatus::default();
    status.record_failure(
        ProviderFailure {
            category: "something_new".to_string(),
            http_status: 500,
            summary: "x".to_string(),
        },
        at(10, 3),
    );
    let provider = status.snapshot(at(10, 3), RunwayConfig::default())["provider"].clone();
    assert_eq!(provider["state"], "failed");
    assert_eq!(provider["page"], true);
}

// ---------------------------------------------------------------------------
// The write budget
// ---------------------------------------------------------------------------

#[test]
fn the_write_budget_counts_the_current_utc_day_and_resets() {
    let mut status = PricePlaneStatus::default();
    for hour in 0..5 {
        status.record_write(at(10, hour));
    }
    let config = RunwayConfig {
        max_writes_per_day: Some(3.0),
        ..RunwayConfig::default()
    };
    let exceeded = status.snapshot(at(10, 5), config);
    assert_eq!(exceeded["writes"]["observed"], 5);
    assert_eq!(exceeded["writes"]["budget"], 3.0);
    assert_eq!(exceeded["writes"]["budget_state"], "exceeded");

    // A new UTC day starts a new count; yesterday's writes do not carry over.
    let next_day = status.snapshot(at(11, 0), config);
    assert_eq!(next_day["writes"]["observed"], 0);
    assert_eq!(next_day["writes"]["budget_state"], "within_budget");
}

#[test]
fn an_unset_write_budget_reports_unbounded_and_never_exceeded() {
    let mut status = PricePlaneStatus::default();
    // 46 writes inside one UTC day, which is the point: no cap is configured, so
    // however many writes happen the budget never reports a breach.
    for hour in 0..23 {
        status.record_write(at(10, hour) + 60);
        status.record_write(at(10, hour) + 120);
    }
    let writes = status.snapshot(at(10, 23), RunwayConfig::default())["writes"].clone();
    assert_eq!(writes["budget_state"], "unbounded");
    assert_eq!(writes["budget"], Value::Null);
    assert_eq!(writes["observed"], 46);
}

// ---------------------------------------------------------------------------
// Runway
// ---------------------------------------------------------------------------

#[test]
fn runway_reports_balance_unknown_when_no_balance_is_supplied() {
    let writes = [at(10, 0), at(11, 0)];
    let runway = assess_runway(None, &writes, WRITE_FEE_GAS, at(11, 0));
    assert_eq!(runway["runway_days"], Value::Null);
    assert_eq!(runway["runway_basis"], "balance_unknown");
    // An unknown runway raises no alert by itself; there is nothing to estimate.
    assert_eq!(runway["alert_level"], "ok");
}

#[test]
fn runway_is_zero_when_the_balance_cannot_pay_one_write() {
    let writes = [at(10, 0), at(11, 0)];
    let runway = assess_runway(Some(0.001), &writes, WRITE_FEE_GAS, at(11, 0));
    assert_eq!(runway["runway_days"], 0.0);
    assert_eq!(runway["runway_basis"], "balance_below_write_fee");
    assert_eq!(runway["alert_level"], "critical");
}

#[test]
fn runway_needs_an_hour_of_history_before_it_estimates() {
    // Five minutes of observed span: too little for a daily rate.
    let writes = [at(10, 0), at(10, 0) + 300];
    let runway = assess_runway(Some(100.0), &writes, WRITE_FEE_GAS, at(10, 0) + 300);
    assert_eq!(runway["runway_days"], Value::Null);
    assert_eq!(runway["runway_basis"], "insufficient_history");
    assert_eq!(runway["write_samples"], 2);
}

#[test]
fn runway_with_no_writes_at_all_is_unknown_not_zero() {
    let runway = assess_runway(Some(100.0), &[], WRITE_FEE_GAS, at(10, 0));
    assert_eq!(runway["runway_days"], Value::Null);
    assert_eq!(runway["runway_basis"], "insufficient_history");
}

#[test]
fn runway_is_measured_from_this_hosts_own_write_cadence() {
    // 48 writes spread evenly over 24 h. The rate counts writes over the span
    // between the first and the last, which is 47 gaps of 1800 s, not 48 — so the
    // measured rate is slightly above 48 a day. The runway is that rate times the
    // fee, divided into the balance.
    let writes: Vec<i64> = (0..48).map(|index| at(10, 0) + index * 1800).collect();
    let runway = assess_runway(Some(1.0), &writes, WRITE_FEE_GAS, at(11, 0));
    let rate = 48.0 / (47.0 * 1800.0) * 86_400.0;
    assert!((runway["writes_per_day"].as_f64().expect("rate") - rate).abs() < 1e-9);
    assert_eq!(runway["runway_basis"], "observed_burn");
    let burn = rate * WRITE_FEE_GAS;
    assert!((runway["burn_gas_per_day"].as_f64().expect("burn") - burn).abs() < 1e-12);
    assert!((runway["runway_days"].as_f64().expect("days") - 1.0 / burn).abs() < 1e-6);
    // 1 GAS at ~0.30 GAS a day is 3.4 days of runway: past the 3-day critical line
    // but inside the 7-day high line.
    assert_eq!(runway["alert_level"], "high");
    assert_eq!(runway["write_fee_gas"], WRITE_FEE_GAS);
}

#[test]
fn writes_older_than_the_window_are_clipped_out() {
    // Two days of writes at the same cadence. Only the last window counts, so the
    // measured rate must stay near one day's worth rather than doubling.
    let writes: Vec<i64> = (0..96).map(|index| at(9, 0) + index * 1800).collect();
    let windowed = assess_runway(Some(100.0), &writes, WRITE_FEE_GAS, at(10, 0));
    // The window holds the 49 writes from the window start through `now`.
    assert!((windowed["writes_per_day"].as_f64().expect("rate") - 49.0).abs() < 1e-9);
    assert_eq!(windowed["burn_window_hours"], 24.0);
}

#[test]
fn a_single_write_is_not_a_rate() {
    let runway = assess_runway(Some(100.0), &[at(10, 0)], WRITE_FEE_GAS, at(10, 0));
    assert_eq!(runway["runway_days"], Value::Null);
    assert_eq!(runway["runway_basis"], "insufficient_history");
}

#[test]
fn a_write_after_now_is_not_counted() {
    // A clock that jumped backwards must not inflate the observed rate.
    let writes = [at(10, 0), at(11, 0), at(12, 0)];
    let runway = assess_runway(Some(100.0), &writes, WRITE_FEE_GAS, at(10, 6));
    assert_eq!(runway["writes_per_day"], Value::Null);
}

#[test]
fn runway_alerts_at_fourteen_seven_and_three_days() {
    for (days, expected) in [
        (30.0, "ok"),
        (14.0, "warning"),
        (13.9, "warning"),
        (7.0, "high"),
        (3.0, "critical"),
        (0.5, "critical"),
    ] {
        assert_eq!(runway_alert_level(Some(days)), expected, "{days}");
    }
    assert_eq!(runway_alert_level(None), "ok");
    assert_eq!(runway_alert_level(Some(f64::NAN)), "ok");
    // The thresholds are the Node's, not a fresh set.
    assert_eq!(RUNWAY_ALERT_DAYS.warning, 14.0);
    assert_eq!(RUNWAY_ALERT_DAYS.high, 7.0);
    assert_eq!(RUNWAY_ALERT_DAYS.critical, 3.0);
    assert_eq!(BURN_WINDOW_SEC, 24 * 3600);
    assert_eq!(BURN_MIN_SPAN_SEC, 3600);
}

// ---------------------------------------------------------------------------
// The classification rules themselves
// ---------------------------------------------------------------------------

#[test]
fn classification_follows_the_node_table_in_its_order() {
    for (status, body, expected) in [
        (
            429,
            json!({"status":"error","code":429,"message":"API quota exceeded for today"}),
            "daily_quota_exhausted",
        ),
        (
            429,
            json!({"status":"error","code":429,"message":"Per minute limit reached"}),
            "minute_rate_limited",
        ),
        (
            429,
            json!({"status":"error","code":429,"message":"Too many requests"}),
            "rate_limited",
        ),
        // The HTTP status is a 429 signal in its own right: a body carrying a
        // different numeric code under an HTTP 429 is still rate limiting, not a
        // provider error.
        (
            429,
            json!({"status":"error","code":500,"message":"Internal server error"}),
            "rate_limited",
        ),
        (
            401,
            json!({"status":"error","code":401,"message":"Your subscription has expired"}),
            "subscription_expired",
        ),
        (
            403,
            json!({"status":"error","code":403,"message":"Forbidden"}),
            "provider_unauthorized",
        ),
        (
            500,
            json!({"status":"error","code":500,"message":"Internal server error"}),
            "provider_error",
        ),
    ] {
        assert_eq!(classify_provider_failure(status, &body), expected, "{body}");
    }
}

#[test]
fn expiry_is_classified_before_unauthorized() {
    // The incident response: a 401 whose message says the subscription expired.
    // Filing it as "unauthorized" sends an operator after the key, not the invoice.
    let body = json!({
        "status": "error",
        "code": 401,
        "message": "Your subscription has expired, please, pay last invoice",
    });
    assert_eq!(
        classify_provider_failure(401, &body),
        "subscription_expired"
    );
}

#[test]
fn rate_limiting_is_classified_before_expiry() {
    // The table's order, the other way round from the 401 case: the 429 branch is
    // tested first, so a throttled response that also mentions an expired
    // subscription is a quota problem, not a billing one — a different kind and a
    // different page verdict. Hoisting the expiry test above the 429 block
    // silently reclassifies it.
    let body = json!({
        "status": "error",
        "code": 429,
        "message": "Your subscription has expired",
    });
    assert_eq!(classify_provider_failure(429, &body), "rate_limited");
    // The HTTP status alone carries the same precedence, whatever code the body
    // carries.
    let wrong_code = json!({
        "status": "error",
        "code": 200,
        "message": "Your subscription has expired",
    });
    assert_eq!(classify_provider_failure(429, &wrong_code), "rate_limited");
}

#[test]
fn expiry_is_matched_across_a_bounded_gap() {
    let body = json!({"code":401,"message":"Your subscription for the plan expired"});
    assert_eq!(
        classify_provider_failure(401, &body),
        "subscription_expired"
    );
    // Beyond the bounded gap it is not the expiry phrase.
    let far =
        json!({"code":401,"message":"subscription ".to_string() + &"x".repeat(60) + "expired"});
    assert_eq!(
        classify_provider_failure(401, &far),
        "provider_unauthorized"
    );
}

#[test]
fn expiry_handles_unicode_without_splitting_utf8() {
    let body = json!({"code":401,"message":format!("subscription{}expired", "中".repeat(16))});
    assert_eq!(
        classify_provider_failure(401, &body),
        "subscription_expired"
    );
}

#[test]
fn expiry_gap_matches_the_node_utf16_limit() {
    // The Node classifier's regex has no `u` flag: its gap is measured in
    // UTF-16 code units, so a supplementary character occupies two positions.
    for (gap, expected) in [
        ("x".repeat(40), "subscription_expired"),
        ("x".repeat(41), "provider_unauthorized"),
        ("中".repeat(40), "subscription_expired"),
        ("中".repeat(41), "provider_unauthorized"),
        ("😀".repeat(20), "subscription_expired"),
        ("😀".repeat(21), "provider_unauthorized"),
    ] {
        let body = json!({"code":401,"message":format!("subscription{gap}expired")});
        assert_eq!(classify_provider_failure(401, &body), expected, "{body}");
    }
}

#[test]
fn expiry_does_not_cross_node_line_terminators() {
    for terminator in ['\n', '\r', '\u{2028}', '\u{2029}'] {
        let body = json!({"code":401,"message":format!("subscription{terminator}expired")});
        assert_eq!(
            classify_provider_failure(401, &body),
            "provider_unauthorized",
            "{body}"
        );
    }
}

#[test]
fn expiry_checks_later_subscription_matches() {
    let body = json!({"code":401,"message":format!("subscription{}; subscription expired", "x".repeat(60))});
    assert_eq!(
        classify_provider_failure(401, &body),
        "subscription_expired"
    );
}

#[test]
fn expiry_requires_the_complete_ordered_phrase() {
    for message in [
        "expired subscription",
        "subscription expire",
        "no subscription",
        "subscription",
    ] {
        let body = json!({"code":401,"message":message});
        assert_eq!(
            classify_provider_failure(401, &body),
            "provider_unauthorized",
            "{body}"
        );
    }
}

#[test]
fn a_response_is_a_failure_on_any_of_the_three_signals() {
    assert!(provider_response_failed(500, &json!({})));
    assert!(provider_response_failed(429, &json!({})));
    assert!(provider_response_failed(200, &json!({"status":"error"})));
    assert!(provider_response_failed(200, &json!({"status":"ERROR"})));
    assert!(provider_response_failed(200, &json!({"code":401})));
    assert!(provider_response_failed(200, &json!({"code":429})));
    // The numeric-code test starts AT 400, the lowest error code; 399 is not one.
    assert!(provider_response_failed(200, &json!({"code":400})));
    assert!(!provider_response_failed(200, &json!({"code":399})));
    // A good quote is not a failure.
    assert!(!provider_response_failed(200, &json!({"price":"65000.12"})));
    // A code under 400 is not a failure on its own.
    assert!(!provider_response_failed(
        200,
        &json!({"code":200,"price":"1"})
    ));
}

#[test]
fn numeric_provider_codes_match_the_node_number_model() {
    for (raw, category, code) in [
        (
            r#"{"code":401.0,"message":"request refused"}"#,
            "provider_unauthorized",
            "401",
        ),
        (
            r#"{"code":4.03e2,"message":"request refused"}"#,
            "provider_unauthorized",
            "403",
        ),
        (
            r#"{"code":"429","message":"daily quota"}"#,
            "daily_quota_exhausted",
            "429",
        ),
        (
            r#"{"code":429.0,"message":"per minute limit"}"#,
            "minute_rate_limited",
            "429",
        ),
        (
            r#"{"code":400.5,"message":"request refused"}"#,
            "provider_error",
            "400.5",
        ),
        (
            r#"{"code":"400","message":"request refused"}"#,
            "provider_error",
            "400",
        ),
    ] {
        // Read actual JSON text: the representation must not decide whether a
        // numeric provider failure is mistaken for an empty successful quote.
        let body: Value = serde_json::from_str(raw).expect("valid provider JSON");
        assert!(provider_response_failed(200, &body), "{raw}");
        assert_eq!(classify_provider_failure(200, &body), category, "{raw}");
        assert_eq!(
            provider_failure(200, &body).summary,
            format!(
                "TwelveData upstream error (HTTP 200, code {code}): {}",
                body["message"].as_str().expect("message")
            ),
            "{raw}"
        );
    }
}

#[test]
fn numeric_provider_code_controls_preserve_success_and_http_fallback() {
    for code in [
        json!(399.5),
        json!("399"),
        json!("not a number"),
        json!("Infinity"),
        json!("1e999"),
        json!(null),
        json!(false),
        json!(""),
    ] {
        assert!(
            !provider_response_failed(200, &json!({"code":code,"price":"12.5"})),
            "{code}"
        );
    }
    for code in [json!(0.0), json!(0), json!(false), json!(null), json!("")] {
        let body = json!({"code":code,"message":"request refused"});
        assert!(provider_response_failed(401, &body));
        assert_eq!(
            classify_provider_failure(401, &body),
            "provider_unauthorized",
            "{body}"
        );
    }
}

#[test]
fn a_provider_message_never_carries_the_api_key() {
    let sanitized = sanitize_provider_message(
        "Invalid API key apikey=SUPERSECRET1234567890 for account NEO&x=1",
    );
    assert!(!sanitized.contains("SUPERSECRET"), "{sanitized}");
    assert!(sanitized.contains("apikey=<redacted>"), "{sanitized}");
    // Everything after the value is kept: the redaction must not eat the message.
    assert!(sanitized.contains("x=1"), "{sanitized}");
}

#[test]
fn a_provider_message_is_collapsed_and_capped() {
    assert_eq!(sanitize_provider_message("  a\n\n  b  "), "a b");
    assert_eq!(sanitize_provider_message(""), "upstream request failed");
    let long = "x".repeat(1000);
    assert_eq!(sanitize_provider_message(&long).chars().count(), 240);
}
