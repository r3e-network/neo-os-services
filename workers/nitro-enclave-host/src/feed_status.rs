//! What the price plane has observed, for `/health` to report.
//!
//! Two things the Node writer's monitor reports and the Rust host did not: what
//! the market-data provider is currently doing (an expired subscription must read
//! as a failure, not as a quiet market), and how long the updater can keep writing.
//!
//! The runway arithmetic is a port of `feed-monitor.mjs`'s `assRunway`, and it
//! keeps that code's refusals intact, because they are the point: a balance that
//! cannot pay one write is zero days, and with no history there is nothing to
//! estimate from. "No data" must never be reported as "fine" — an absent balance
//! reads `balance_unknown` with a null runway, not a comfortable number.
//!
//! One deliberate difference from the Node monitor, stated rather than hidden: the
//! monitor measures the updater's balance falling, which catches spend by ANY
//! process. This host can only observe its OWN write cycles, so the burn here is
//! this host's writes times the fee of one write. It is the host's own view, and
//! the monitor remains the authority on actual balance.

use std::collections::VecDeque;

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

/// How many write timestamps to keep. Bounded so a long-lived host cannot grow
/// without limit; the window is a day, so this is far more than it needs.
const MAX_WRITE_SAMPLES: usize = 4096;

/// The upstream message cap, so a provider cannot flood the status.
const MESSAGE_CAP: usize = 240;

pub struct RunwayAlertDays {
    pub warning: f64,
    pub high: f64,
    pub critical: f64,
}

/// A classified provider failure: the Node writer's `error.providerCategory`, the
/// HTTP status it came from, and a redacted summary. It never carries the API key
/// — [`sanitize_provider_message`] removes it before the value is built.
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

/// `sanitizeProviderErrorMessage`: redact the API key, collapse whitespace, cap
/// the length. A provider that echoes the key back must not put it in `/health`.
pub fn sanitize_provider_message(value: &str) -> String {
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

    let mut message = out.split_whitespace().collect::<Vec<_>>().join(" ");
    if message.is_empty() {
        message = "upstream request failed".to_string();
    }
    if message.chars().count() > MESSAGE_CAP {
        message = message.chars().take(MESSAGE_CAP).collect();
    }
    message
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
        .and_then(|value| value.as_i64())
        .filter(|code| *code != 0)
        .unwrap_or(i64::from(http_status));
    let message = body
        .get("message")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    if code == 429 || http_status == 429 {
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
    if code == 401 || code == 403 {
        return "provider_unauthorized";
    }
    "provider_error"
}

/// `/subscription.{0,40}expired/i` — the word order and the bounded gap, because
/// the provider's message carries an invoice reference between the two words.
fn is_subscription_expired(lower_message: &str) -> bool {
    let Some(start) = lower_message.find("subscription") else {
        return false;
    };
    let after = &lower_message[start + "subscription".len()..];
    let gap = after.len().min(40 + "expired".len());
    after[..gap].contains("expired")
}

/// Is this response a provider failure? The three tests
/// `assertTwelveDataResponse` makes: the HTTP status, an explicit
/// `status: "error"`, and a numeric `code >= 400`. A body can arrive under a 200
/// and still carry a failure, which is why all three are checked.
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
        .and_then(|value| value.as_i64())
        .is_some_and(|code| code >= 400);
    says_error || bad_code
}

/// The failure for a response, with the Node writer's message shape.
pub fn provider_failure(http_status: u16, body: &Value) -> ProviderFailure {
    let code = body
        .get("code")
        .and_then(|value| value.as_i64())
        .filter(|code| *code != 0);
    let code_suffix = code
        .map(|code| format!(", code {code}"))
        .unwrap_or_default();
    let summary = sanitize_provider_message(
        body.get("message")
            .and_then(|value| value.as_str())
            .unwrap_or(""),
    );
    ProviderFailure {
        category: classify_provider_failure(http_status, body).to_string(),
        http_status,
        summary: format!("TwelveData upstream error (HTTP {http_status}{code_suffix}): {summary}"),
    }
}

/// The observed price-plane state: the last provider verdict and the write
/// timestamps the daily budget and the burn rate are both derived from. Held by
/// `AppState` behind a `Mutex`, like `KmsDiag`.
///
/// Both derived numbers are computed from the timestamps at read time rather than
/// kept in counters. A counter has to be reset by the code that notices midnight,
/// and any read path that forgets leaves yesterday's number on the status; deriving
/// both from the same series makes that class of bug impossible.
#[derive(Debug, Default)]
pub struct PricePlaneStatus {
    provider: Option<ProviderFailure>,
    /// When the provider was last observed. `Some` with no failure means the last
    /// fetch succeeded; `None` means no fetch has happened yet.
    provider_observed_at: Option<i64>,
    writes: VecDeque<i64>,
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

    /// One successful write cycle, for today's count and the burn rate.
    pub fn record_write(&mut self, observed_at_sec: i64) {
        self.writes.push_back(observed_at_sec);
        while self.writes.len() > MAX_WRITE_SAMPLES {
            self.writes.pop_front();
        }
    }

    /// The writes counted for the UTC day `now_sec` falls in. A host that is idle
    /// across midnight reports zero, not yesterday's total.
    fn writes_today(&self, now_sec: i64) -> u64 {
        let day_start = now_sec.div_euclid(86_400) * 86_400;
        self.writes
            .iter()
            .filter(|at| **at >= day_start && **at <= now_sec)
            .count() as u64
    }

    /// The `/health` object.
    pub fn snapshot(&self, now_sec: i64, config: RunwayConfig) -> Value {
        let writes_today = self.writes_today(now_sec);
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
                "observed": writes_today,
                "budget": Value::Null,
                "budget_state": "unbounded",
            }),
            Some(budget) => {
                let observed = writes_today as f64;
                json!({
                    "observed": writes_today,
                    "budget": budget,
                    "budget_state": if observed > budget { "exceeded" } else { "within_budget" },
                })
            }
        };
        let write_times: Vec<i64> = self.writes.iter().copied().collect();
        json!({
            "provider": provider,
            "writes": writes,
            "runway": assess_runway(config.balance_gas, &write_times, config.fee(), now_sec),
        })
    }
}

/// `assessRunway`. `balance` of `None` means no balance is configured at all,
/// which is its own basis rather than a zero runway. The burn comes from this
/// host's own observed writes: `writes_per_day * fee`, which is what this process
/// spends, not what the updater's balance loses to every writer.
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
