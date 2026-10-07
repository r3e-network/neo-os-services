//! What the price plane has observed, for `/health` to report.
//!
//! Provider failures and signed plans are local observations. A signature is
//! not a broadcast or confirmation: the separate pusher owns both. This host
//! therefore reports completed writes and burn as unknown, and cannot estimate
//! runway from signed plans. An operator balance below one write fee still
//! reports zero runway; an absent balance remains explicitly unknown. The Node
//! monitor remains the authority on actual spending.

use std::collections::VecDeque;

use neo_os_compute::js::{js_number_to_string, js_to_number, js_truthy};
use serde_json::{json, Value};

/// The observed fee of one two-pair write, from `feed-monitor.mjs`'s
/// `OBSERVED_FEE_PER_WRITE_GAS`. Overridable per deployment.
pub const WRITE_FEE_GAS: f64 = 0.00606339;

/// The Node writer's alert thresholds, unchanged: 14 / 7 / 3 days.
pub const RUNWAY_ALERT_DAYS: RunwayAlertDays = RunwayAlertDays {
    warning: 14.0,
    high: 7.0,
    critical: 3.0,
};

/// The window the burn rate is measured over, and the shortest span that counts
/// as an estimate. `feed-monitor.mjs`'s `BURN_WINDOW_SEC` / `BURN_MIN_SPAN_SEC`.
const BURN_WINDOW_SEC: i64 = 24 * 3600;
const BURN_MIN_SPAN_SEC: i64 = 3600;

/// Bound retained signature observations; a truncated count is a lower bound.
const MAX_SIGNED_PLAN_SAMPLES: usize = 4096;

/// The upstream message cap, so a provider cannot flood the status.
const MESSAGE_CAP: usize = 240;

pub struct RunwayAlertDays {
    pub warning: f64,
    pub high: f64,
    pub critical: f64,
}

/// A classified provider failure: the Node writer's `error.providerCategory`, the
/// HTTP status it came from, and a redacted summary. It never carries the API key
/// — the request's configured key is removed before formatting or truncation.
#[derive(Debug, Clone, PartialEq)]
pub struct ProviderFailure {
    pub category: String,
    pub http_status: u16,
    pub summary: String,
}

/// The operator-supplied runway inputs, read from the overlay by the caller. They
/// are passed in rather than read from a global because the overlay is a value
/// this host owns (see `overlay.rs`): tests construct one instead of touching
/// `std::env`, and a process-global read would undo that.
#[derive(Debug, Clone, Copy, Default)]
pub struct RunwayConfig {
    /// The updater's GAS balance. `None` means no balance is configured.
    pub balance_gas: Option<f64>,
    /// The fee of one write.
    pub write_fee_gas: Option<f64>,
    /// The daily write cap. `None` means unbounded, the shipped posture.
    pub max_writes_per_day: Option<f64>,
}

impl RunwayConfig {
    fn fee(&self) -> f64 {
        self.write_fee_gas
            .filter(|fee| fee.is_finite() && *fee > 0.0)
            .unwrap_or(WRITE_FEE_GAS)
    }
}

/// The category -> kind and paging table, ported from `feed-monitor.mjs`'s
/// `PROVIDER_FAILURES`. `page` marks the categories an operator must be told
/// about; the rest are transient shapes a retry resolves.
///
/// `no_usable_prices` is in the Node table but this host never produces it: it has
/// the plan's `invalid_price` guard behind the parse, so an unusable quote is
/// reported per symbol instead of failing the batch. The mapping is kept so a
/// category recorded by a future caller still renders.
fn provider_verdict(category: &str) -> (&'static str, bool) {
    match category {
        "provider_unauthorized" => ("unauthorized", true),
        "subscription_expired" => ("expired", true),
        "daily_quota_exhausted" => ("quota", true),
        "rate_limited" => ("quota", true),
        "minute_rate_limited" => ("rate_limited", false),
        "provider_error" => ("error", false),
        "no_usable_prices" => ("no_prices", false),
        // An unrecognised category is reported honestly rather than folded into a
        // benign kind: unknown still means failed, so it pages.
        _ => ("error", true),
    }
}

/// Keep the context-free helper for fixtures that carry only query parameters.
#[cfg(test)]
pub fn sanitize_provider_message(value: &str) -> String {
    sanitize_provider_message_with_key(value, "")
}

/// Redact before collapsing whitespace or truncating: truncation must never
/// leave a partial configured credential that a later replacement cannot match.
pub fn sanitize_provider_message_with_key(value: &str, api_key: &str) -> String {
    let out = redact_provider_message(value, api_key);
    let mut message = out.split_whitespace().collect::<Vec<_>>().join(" ");
    if message.is_empty() {
        message = "upstream request failed".to_string();
    }
    if message.chars().count() > MESSAGE_CAP {
        message = message.chars().take(MESSAGE_CAP).collect();
    }
    message
}

/// Redaction without a second cap, for an already formatted error.
/// Provider bodies can echo a key without `apikey=`; URL errors can encode it.
pub fn redact_provider_message(value: &str, api_key: &str) -> String {
    // Replace complete keys first: a key containing `&` or whitespace must not
    // be split by query-parameter removal, leaving a credential suffix behind.
    let value = if api_key.is_empty() {
        value.to_string()
    } else {
        redact_encoded_key(
            &value.replace(api_key, "<redacted>"),
            &crate::feed_sign::encode_uri_component(api_key),
        )
    };
    let lower = value.to_ascii_lowercase();
    let mut out = String::with_capacity(value.len());
    let mut cursor = 0;
    while let Some(offset) = lower[cursor..].find("apikey=") {
        let start = cursor + offset;
        out.push_str(&value[cursor..start]);
        out.push_str("apikey=<redacted>");
        // Skip the value: up to the next `&`, whitespace, or the end.
        let tail = &value[start + "apikey=".len()..];
        let end = tail
            .find(|c: char| c == '&' || c.is_whitespace())
            .unwrap_or(tail.len());
        cursor = start + "apikey=".len() + end;
    }
    out.push_str(&value[cursor..]);

    out
}

fn redact_encoded_key(value: &str, encoded: &str) -> String {
    let expected = encoded.as_bytes();
    let mut out = String::with_capacity(value.len());
    let mut cursor = 0;
    for (start, _) in value.char_indices() {
        if start < cursor || start + expected.len() > value.len() {
            continue;
        }
        let actual = &value.as_bytes()[start..start + expected.len()];
        let mut index = 0;
        let mut matches = true;
        while index < expected.len() {
            if expected[index] == b'%' && index + 2 < expected.len() {
                matches &= actual[index] == b'%'
                    && actual[index + 1..index + 3]
                        .eq_ignore_ascii_case(&expected[index + 1..index + 3]);
                index += 3;
            } else {
                matches &= actual[index] == expected[index];
                index += 1;
            }
        }
        if matches {
            out.push_str(&value[cursor..start]);
            out.push_str("<redacted>");
            cursor = start + expected.len();
        }
    }
    out.push_str(&value[cursor..]);
    out
}

/// `classifyTwelveDataFailure`, in its order. Expiry is tested BEFORE 401/403 on
/// purpose: the real-world expired-subscription response is a 401 whose message
/// says the subscription expired, and filing that as "unauthorized" sends an
/// operator looking at the key instead of at the invoice. The 429 branch is
/// tested before expiry for the same reason in reverse: a throttled response is
/// a quota problem even when its message mentions the subscription, and the two
/// classify to a different kind and a different page verdict.
pub fn classify_provider_failure(http_status: u16, body: &Value) -> &'static str {
    let code = body
        .get("code")
        .filter(|value| js_truthy(value))
        .map(js_to_number)
        .unwrap_or(f64::from(http_status));
    let message = body
        .get("message")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    if code == 429.0 || http_status == 429 {
        if message.contains("daily") || message.contains("per day") || message.contains("today") {
            return "daily_quota_exhausted";
        }
        if message.contains("minute") {
            return "minute_rate_limited";
        }
        return "rate_limited";
    }
    if is_subscription_expired(&message) {
        return "subscription_expired";
    }
    if code == 401.0 || code == 403.0 {
        return "provider_unauthorized";
    }
    "provider_error"
}

/// `/subscription.{0,40}expired/i` — the Node regex counts UTF-16 code units
/// and its dot excludes line terminators. Try every phrase at character
/// boundaries: a byte prefix can split UTF-8, and the first phrase need not
/// be the one whose bounded gap ends in `expired`.
fn is_subscription_expired(lower_message: &str) -> bool {
    lower_message
        .match_indices("subscription")
        .any(|(start, _)| {
            let after = &lower_message[start + "subscription".len()..];
            let mut gap = 0;
            for (offset, character) in after.char_indices() {
                if gap > 40 {
                    break;
                }
                if after[offset..].starts_with("expired") {
                    return true;
                }
                if matches!(character, '\n' | '\r' | '\u{2028}' | '\u{2029}') {
                    break;
                }
                gap += character.len_utf16();
            }
            false
        })
}

/// Is this response a provider failure? The three tests
/// `assertTwelveDataResponse` makes: the HTTP status, an explicit
/// `status: "error"`, and a finite `Number(code) >= 400`. JSON decimals and
/// numeric strings have the same meaning as integers in the Node writer.
/// A body can arrive under a 200 and still carry a failure, which is why all
/// three are checked.
pub fn provider_response_failed(http_status: u16, body: &Value) -> bool {
    if !(200..300).contains(&http_status) {
        return true;
    }
    let Some(object) = body.as_object() else {
        return false;
    };
    let says_error = object
        .get("status")
        .and_then(|value| value.as_str())
        .is_some_and(|status| status.eq_ignore_ascii_case("error"));
    let bad_code = object
        .get("code")
        .map(js_to_number)
        .is_some_and(|code| code.is_finite() && code >= 400.0);
    says_error || bad_code
}

/// The failure for a response, with the Node writer's message shape.
#[cfg(test)]
pub fn provider_failure(http_status: u16, body: &Value) -> ProviderFailure {
    provider_failure_with_key(http_status, body, "")
}

/// The production boundary binds redaction to the key of this request.
pub fn provider_failure_with_key(http_status: u16, body: &Value, api_key: &str) -> ProviderFailure {
    let code = body
        .get("code")
        .map(js_to_number)
        .filter(|code| code.is_finite());
    let code_suffix = code
        .map(|code| format!(", code {}", js_number_to_string(code)))
        .unwrap_or_default();
    let summary = sanitize_provider_message_with_key(
        body.get("message")
            .and_then(|value| value.as_str())
            .unwrap_or(""),
        api_key,
    );
    ProviderFailure {
        category: classify_provider_failure(http_status, body).to_string(),
        http_status,
        summary: redact_provider_message(
            &format!("TwelveData upstream error (HTTP {http_status}{code_suffix}): {summary}"),
            api_key,
        ),
    }
}

/// Local provider verdict and signature observations, held by `AppState`.
/// Counts are derived for the UTC day at read time; no midnight reset is needed.
#[derive(Debug, Default)]
pub struct PricePlaneStatus {
    provider: Option<ProviderFailure>,
    /// When the provider was last observed. `Some` with no failure means the last
    /// fetch succeeded; `None` means no fetch has happened yet.
    provider_observed_at: Option<i64>,
    signed_plans: VecDeque<i64>,
    signed_plan_samples_dropped: bool,
}

impl PricePlaneStatus {
    /// A classified provider failure, remembered for `/health`.
    pub fn record_failure(&mut self, failure: ProviderFailure, observed_at_sec: i64) {
        self.provider = Some(failure);
        self.provider_observed_at = Some(observed_at_sec);
    }

    /// A fetch that produced at least one usable price. The verdict is cleared:
    /// the last observation is the current one, and leaving a stale failure on a
    /// recovered provider would page forever.
    pub fn record_success(&mut self, observed_at_sec: i64) {
        self.provider = None;
        self.provider_observed_at = Some(observed_at_sec);
    }

    /// One signed plan. The host has no broadcast or confirmation receipt.
    pub fn record_signed_plan(&mut self, observed_at_sec: i64) {
        self.signed_plans.push_back(observed_at_sec);
        while self.signed_plans.len() > MAX_SIGNED_PLAN_SAMPLES {
            self.signed_plans.pop_front();
            self.signed_plan_samples_dropped = true;
        }
    }

    /// The signed plans counted for the UTC day `now_sec` falls in. A host that is idle
    /// across midnight reports zero, not yesterday's total.
    fn signed_plans_today(&self, now_sec: i64) -> u64 {
        let day_start = now_sec.div_euclid(86_400) * 86_400;
        self.signed_plans
            .iter()
            .filter(|at| **at >= day_start && **at <= now_sec)
            .count() as u64
    }

    /// The `/health` object.
    pub fn snapshot(&self, now_sec: i64, config: RunwayConfig) -> Value {
        let signed_plans_today = self.signed_plans_today(now_sec);
        let provider = match self.provider_observed_at {
            // A fetch succeeded: the provider is answering, and saying so is the
            // point of clearing the failure in the first place.
            None => Value::Null,
            Some(observed_at) => match &self.provider {
                None => json!({ "state": "ok" }),
                Some(failure) => {
                    let (kind, page) = provider_verdict(&failure.category);
                    json!({
                        "state": "failed",
                        "category": failure.category,
                        "kind": kind,
                        "page": page,
                        "http_status": failure.http_status,
                        "summary": failure.summary,
                        "observed_at": observed_at,
                    })
                }
            },
        };
        let writes = match config.max_writes_per_day {
            None => json!({
                "observed": Value::Null,
                "observation_state": "not_observed",
                "budget": Value::Null,
                "budget_state": "unbounded",
            }),
            Some(budget) => {
                json!({
                    "observed": Value::Null,
                    "observation_state": "not_observed",
                    "budget": budget,
                    "budget_state": "unknown",
                })
            }
        };
        let mut runway = assess_runway(config.balance_gas, &[], config.fee(), now_sec);
        runway["write_samples"] = Value::Null;
        runway["burn_window_hours"] = Value::Null;
        if runway["runway_basis"] == "insufficient_history" {
            runway["runway_basis"] = json!("confirmed_write_history_unavailable");
        }
        json!({
            "provider": provider,
            "writes": writes,
            "signed_plans": {
                "chain": "neo_n3",
                "observed": signed_plans_today,
                "sample_limit": MAX_SIGNED_PLAN_SAMPLES,
                "count_state": if self.signed_plan_samples_dropped {
                    "lower_bound"
                } else {
                    "complete_since_start"
                },
            },
            "runway": runway,
        })
    }
}

/// Pure arithmetic for a caller with confirmed write history. The host snapshot
/// supplies none: local signatures do not establish actual spend or completion.
pub fn assess_runway(
    balance: Option<f64>,
    writes: &[i64],
    fee_per_write_gas: f64,
    now_sec: i64,
) -> Value {
    let observed = observe_writes(writes, now_sec);
    let writes_per_day = observed["writes_per_day"].as_f64();
    let burn_per_day = writes_per_day.map(|writes| writes * fee_per_write_gas);
    let (runway_days, basis): (Option<f64>, &str) = match balance {
        None => (None, "balance_unknown"),
        Some(balance) if balance < fee_per_write_gas => (Some(0.0), "balance_below_write_fee"),
        _ => match writes_per_day {
            None => (None, "insufficient_history"),
            Some(0.0) => (None, "no_burn_observed"),
            Some(writes_per_day) => (
                Some(balance.unwrap_or_default() / (writes_per_day * fee_per_write_gas)),
                "observed_burn",
            ),
        },
    };
    json!({
        "balance_gas": balance,
        "write_fee_gas": fee_per_write_gas,
        "burn_gas_per_day": burn_per_day,
        "writes_per_day": writes_per_day,
        "burn_window_hours": observed["span_hours"],
        "write_samples": writes.len(),
        "runway_days": runway_days,
        "runway_basis": basis,
        "alert_level": runway_alert_level(runway_days),
    })
}

/// Writes per day over the last window. Fewer than `BURN_MIN_SPAN_SEC` of
/// observed span is not an estimate — a host that has been up ten minutes has no
/// daily rate to divide a balance by.
fn observe_writes(writes: &[i64], now_sec: i64) -> Value {
    let start = now_sec - BURN_WINDOW_SEC;
    let in_window: Vec<i64> = writes
        .iter()
        .copied()
        .filter(|at| *at >= start && *at <= now_sec)
        .collect();
    let span_sec = in_window
        .last()
        .zip(in_window.first())
        .map(|(last, first)| last - first)
        .unwrap_or(0);
    let writes_per_day = if in_window.len() < 2 || span_sec < BURN_MIN_SPAN_SEC {
        Value::Null
    } else {
        json!((in_window.len() as f64 / span_sec as f64) * 86_400.0)
    };
    json!({
        "writes_per_day": writes_per_day,
        "span_hours": span_sec as f64 / 3600.0,
        "writes_in_window": in_window.len(),
    })
}

/// `runwayAlertLevel`: an unknown or unbounded runway raises no alert by itself.
/// With no history there is nothing to estimate from, and a balance that is not
/// falling has no end date.
pub fn runway_alert_level(runway_days: Option<f64>) -> &'static str {
    let Some(days) = runway_days else {
        return "ok";
    };
    if !days.is_finite() {
        return "ok";
    }
    if days <= RUNWAY_ALERT_DAYS.critical {
        return "critical";
    }
    if days <= RUNWAY_ALERT_DAYS.high {
        return "high";
    }
    if days <= RUNWAY_ALERT_DAYS.warning {
        return "warning";
    }
    "ok"
}

#[cfg(test)]
#[path = "../tests/unit/feed_status.rs"]
mod tests;
