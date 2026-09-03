//! `CircuitBreaker` — the port of `platform/circuit-breaker.js`: the classic
//! CLOSED → OPEN → HALF_OPEN → CLOSED health gate for provider calls.
//!
//! The JS reads `Date.now()` inside `recordFailure`/`isOpen`, and its tests
//! reach into `cb.lastFailureAt` to fake time. The port takes the clock as a
//! parameter instead (`now_ms`) — same observable behavior, no test hooks on
//! private state. Production callers pass [`unix_millis`]; tests pass
//! whatever timeline they need.
//!
//! `get_state` folds the breaker into a `classify_risk_signal` input and
//! carries the recommendation through (`recommended_action`, `risk_scope`,
//! `risk_scope_id`), keyed exactly as the JS object literal.

use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value as Json};

use crate::risk::classify_risk_signal;

/// `Date.now()` for production callers — the injected-clock escape hatch is
/// the `now_ms` parameter on the state methods.
pub fn unix_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BreakerState {
    Closed,
    Open,
    HalfOpen,
}

impl BreakerState {
    fn as_js_str(self) -> &'static str {
        match self {
            BreakerState::Closed => "closed",
            BreakerState::Open => "open",
            BreakerState::HalfOpen => "half_open",
        }
    }
}

pub struct CircuitBreaker {
    name: String,
    failure_threshold: u32,
    reset_timeout_ms: u64,
    half_open_max: u32,
    failures: u32,
    successes: u32,
    state: BreakerState,
    last_failure_at_ms: u64,
    half_open_quota: u32,
}

impl CircuitBreaker {
    pub fn new(name: impl Into<String>) -> Self {
        CircuitBreaker {
            name: name.into(),
            failure_threshold: 3,
            reset_timeout_ms: 60_000,
            half_open_max: 1,
            failures: 0,
            successes: 0,
            state: BreakerState::Closed,
            last_failure_at_ms: 0,
            half_open_quota: 0,
        }
    }

    pub fn with_failure_threshold(mut self, threshold: u32) -> Self {
        self.failure_threshold = threshold;
        self
    }

    pub fn with_reset_timeout_ms(mut self, timeout_ms: u64) -> Self {
        self.reset_timeout_ms = timeout_ms;
        self
    }

    pub fn with_half_open_max(mut self, max: u32) -> Self {
        self.half_open_max = max;
        self
    }

    pub fn record_success(&mut self) {
        self.successes += 1;
        self.failures = 0;
        if self.state == BreakerState::HalfOpen {
            self.state = BreakerState::Closed;
            self.half_open_quota = 0;
        }
    }

    pub fn record_failure(&mut self, now_ms: u64) {
        self.failures += 1;
        self.successes = 0;
        self.last_failure_at_ms = now_ms;
        if self.state == BreakerState::HalfOpen {
            self.state = BreakerState::Open;
            self.half_open_quota = 0;
        } else if self.failures >= self.failure_threshold {
            self.state = BreakerState::Open;
        }
    }

    /// `isOpen` — transitions OPEN → HALF_OPEN when the reset timeout has
    /// elapsed (mutates state, as the JS does).
    pub fn is_open(&mut self, now_ms: u64) -> bool {
        match self.state {
            BreakerState::Closed => false,
            BreakerState::Open => {
                if now_ms.saturating_sub(self.last_failure_at_ms) >= self.reset_timeout_ms {
                    self.state = BreakerState::HalfOpen;
                    self.half_open_quota = self.half_open_max;
                    false
                } else {
                    true
                }
            }
            BreakerState::HalfOpen => self.half_open_quota == 0,
        }
    }

    /// `allow` — whether a call may proceed; consumes one half-open probe
    /// slot when granted.
    pub fn allow(&mut self, now_ms: u64) -> bool {
        if self.is_open(now_ms) {
            return false;
        }
        if self.state == BreakerState::HalfOpen && self.half_open_quota > 0 {
            self.half_open_quota -= 1;
        }
        true
    }

    pub fn get_state(&self) -> Json {
        let failure_rate = match self.state {
            BreakerState::Open => 1.0,
            _ if self.failures > 0 => {
                self.failures as f64 / (self.failures + self.successes).max(1) as f64
            }
            _ => 0.0,
        };
        let risk = classify_risk_signal(&json!({
            "scope": "provider",
            "scope_id": self.name,
            "failure_rate": failure_rate,
        }));
        json!({
            "name": self.name,
            "state": self.state.as_js_str(),
            "failures": self.failures,
            "successes": self.successes,
            "last_failure_at": if self.last_failure_at_ms > 0 {
                Json::Number(self.last_failure_at_ms.into())
            } else {
                Json::Null
            },
            "recommended_action": risk["action"],
            "risk_scope": risk["scope"],
            "risk_scope_id": risk["scope_id"],
        })
    }
}
