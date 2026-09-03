//! `acquireOverloadSlot` / `snapshotOverloadState` — the port of
//! `platform/overload-guard.js`.
//!
//! The JS keeps one module-global `inFlightByRoute` map; the host equivalent
//! is a single `OverloadGuard` in the app state (the crate never reaches for
//! globals). Two shape changes, both documented:
//!
//! * The guard is transport-agnostic: instead of `response: json(503, …)`
//!   the rejection carries `{status, retry_after, body}` for the HTTP layer
//!   to render — the exact body the JS built, keys in its literal order.
//! * The release closure becomes an idempotent `OverloadSlot` with `Drop`,
//!   so a lane that early-returns cannot leak a slot the way a JS lane that
//!   forgets `release()` can. The JS contract (`release()` callable any
//!   number of times, only the first counts) is preserved exactly.
//!
//! Limits: `MORPHEUS_MAX_INFLIGHT_<ROUTE_ID>` overrides the per-route
//! default; the value goes through JS `Number()` semantics (`''` falls back
//! to the default, NaN/garbage means 0 = uncapped, truncation toward zero,
//! negatives clamp to 0). The env reader is injected — the host passes its
//! overlay, tests pass a closure.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value as Json};

use crate::capabilities::resolve_route_name;
use crate::js::{js_number, js_trim};

/// The injected environment: `Some(raw)` when the variable is present.
/// The JS `env()` helper additionally treats an empty/whitespace value as
/// unset — `resolve_limit` mirrors that with its `||` fallback.
pub type EnvReader<'a> = &'a dyn Fn(&str) -> Option<String>;

/// `defaultLimit` (overload-guard.js:6-41) — 0 means the route is uncapped.
fn default_limit(route_name: &str) -> u64 {
    match route_name {
        "compute_execute" => 4,
        "vrf_random" => 4,
        "relay_transaction" => 6,
        "paymaster_authorize" => 8,
        "neodid_recovery_ticket" => 4,
        "neodid_bind" => 6,
        "neodid_action_ticket" => 6,
        "neodid_zklogin_ticket" => 6,
        "oracle_feed" => 0,
        "oracle_smart_fetch" => 12,
        "oracle_query" => 16,
        "txproxy_invoke" => 12,
        "session_start" => 8,
        "session_step" => 32,
        "session_finalize" => 8,
        _ => 0,
    }
}

/// `resolveLimit`: `Number(env(...) || defaultLimit)` under JS semantics.
fn resolve_limit(route_name: Option<&str>, env: EnvReader) -> u64 {
    let Some(route_name) = route_name else {
        return 0;
    };
    let key = format!("MORPHEUS_MAX_INFLIGHT_{}", route_name.to_ascii_uppercase());
    let explicit = match env(&key) {
        Some(raw) if !js_trim(&raw).is_empty() => js_number(js_trim(&raw)),
        _ => default_limit(route_name) as f64,
    };
    if explicit.is_finite() {
        explicit.trunc().max(0.0) as u64
    } else {
        0
    }
}

struct Inner {
    slots: Mutex<BTreeMap<String, u64>>,
}

/// One guard per process (the host's app state holds it). `BTreeMap` gives
/// the snapshot a deterministic order; for the capability-id keyspace
/// (lowercase ASCII + `_`, which sorts before lowercase letters in both byte
/// and ICU-en collation) that order equals the JS `localeCompare` sort.
pub struct OverloadGuard {
    inner: Arc<Inner>,
}

impl Default for OverloadGuard {
    fn default() -> Self {
        Self::new()
    }
}

/// The 503 the JS builds for a saturated route:
/// `{error, route, limit, in_flight}` with `retry-after: 1`.
pub struct OverloadRejection {
    pub status: u16,
    pub retry_after: &'static str,
    pub route_name: &'static str,
    pub limit: u64,
    pub in_flight: u64,
    pub body: Json,
}

/// A granted slot. `release()` is idempotent and runs on drop.
pub struct OverloadSlot {
    inner: Arc<Inner>,
    pub route_name: &'static str,
    pub limit: u64,
    /// The count as of acquisition (already including this slot).
    pub in_flight: u64,
    released: Arc<AtomicBool>,
}

impl OverloadSlot {
    pub fn release(&self) {
        if self.released.swap(true, Ordering::SeqCst) {
            return;
        }
        let mut slots = self.inner.slots.lock().expect("overload slots lock");
        let current = slots.get(self.route_name).copied().unwrap_or(0);
        let next = current.saturating_sub(1);
        if next == 0 {
            slots.remove(self.route_name);
        } else {
            slots.insert(self.route_name.to_string(), next);
        }
    }
}

impl Drop for OverloadSlot {
    fn drop(&mut self) {
        self.release();
    }
}

pub enum AcquireOutcome {
    /// Reserved capacity — release it (explicitly or by drop).
    Granted(OverloadSlot),
    /// The route is at its cap; render `rejection` as the response.
    Rejected(OverloadRejection),
    /// `!routeName || limit <= 0` — no reservation, the request proceeds.
    Uncapped {
        route_name: Option<&'static str>,
        limit: u64,
        in_flight: u64,
    },
}

impl AcquireOutcome {
    /// The JS result's `ok` field.
    pub fn ok(&self) -> bool {
        !matches!(self, AcquireOutcome::Rejected(_))
    }
}

impl OverloadGuard {
    pub fn new() -> Self {
        OverloadGuard {
            inner: Arc::new(Inner {
                slots: Mutex::new(BTreeMap::new()),
            }),
        }
    }

    fn current(&self, route_name: &str) -> u64 {
        self.inner
            .slots
            .lock()
            .expect("overload slots lock")
            .get(route_name)
            .copied()
            .unwrap_or(0)
    }

    /// `snapshotOverloadState` — a copy of the live per-route in-flight map.
    pub fn snapshot(&self) -> BTreeMap<String, u64> {
        self.inner
            .slots
            .lock()
            .expect("overload slots lock")
            .clone()
    }

    /// `acquireOverloadSlot(pathname, payload)` — the route name resolves
    /// through the capability registry (path first, `payload.action`
    /// fallback), so action-routed requests share the cap of the capability
    /// the dispatcher will execute.
    pub fn acquire(&self, path: &str, payload: &Json, env: EnvReader) -> AcquireOutcome {
        let route_name = resolve_route_name(js_trim(path), payload);
        let limit = resolve_limit(route_name, env);
        let Some(route_name) = route_name else {
            return AcquireOutcome::Uncapped {
                route_name: None,
                limit: 0,
                in_flight: 0,
            };
        };
        if limit == 0 {
            return AcquireOutcome::Uncapped {
                route_name: Some(route_name),
                limit: 0,
                in_flight: self.current(route_name),
            };
        }

        let in_flight = self.current(route_name);
        if in_flight >= limit {
            return AcquireOutcome::Rejected(OverloadRejection {
                status: 503,
                retry_after: "1",
                route_name,
                limit,
                in_flight,
                body: json!({
                    "error": "overloaded",
                    "route": route_name,
                    "limit": limit,
                    "in_flight": in_flight,
                }),
            });
        }

        self.inner
            .slots
            .lock()
            .expect("overload slots lock")
            .insert(route_name.to_string(), in_flight + 1);
        AcquireOutcome::Granted(OverloadSlot {
            inner: Arc::clone(&self.inner),
            route_name,
            limit,
            in_flight: in_flight + 1,
            released: Arc::new(AtomicBool::new(false)),
        })
    }
}
