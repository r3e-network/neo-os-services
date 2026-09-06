//! Relayer state machine (port of workers/morpheus-relayer/src/state.js —
//! the IO-free kernel): per-chain cursors, processed-record LRU, the retry
//! queue with ceiling enforcement into dead letters, labeled failure
//! counters, and the metrics snapshot the relayer renders.
//!
//! Everything is modeled on the dynamic value layer ([`JsValue`]) because the
//! JS state is dynamic objects whose KEY ORDER is contract: snapshots spread
//! `defaultMetrics()` first (insertion order), then derived gauge maps, and
//! the JSON state file round-trips through JSON.parse which preserves that
//! order. File IO (load/save) stays with the caller shell; this module
//! exposes the pure `normalize` / mutation / snapshot halves. Wall-clock
//! inputs (`now_ms`) are injected — the JS oracle grew optional `nowMs`
//! parameters with `Date.now()` defaults for exactly this purpose.

#[cfg(test)]
use crate::js_number::number_to_string;
use crate::js_value::to_display_string;
use crate::js_value::{JsObject, JsValue};
use crate::kernel;
use crate::retry::compute_retry_delay_ms;

/// Per-chain state is keyed by these chain ids. Adding a chain here makes the
/// relayer engine track its cursor/retry/dead-letter state automatically.
pub const RELAYER_CHAINS: &[&str] = &["neo_n3", "neox"];

/// F5: labeled failure counters are keyed by a delimiter-joined tuple.
pub const LABELED_FAILURE_DELIMITER: &str = "|";

// ── time helpers ─────────────────────────────────────────────────────────────

/// `new Date(ms).toISOString()` — UTC, millisecond precision, `Z` suffix.
/// Sub-millisecond input truncates toward zero like the Date constructor.
pub fn ms_to_iso_string(ms: f64) -> String {
    let total_ms = ms as i64;
    let days = total_ms.div_euclid(86_400_000);
    let ms_of_day = total_ms.rem_euclid(86_400_000);
    let (y, m, d) = civil_from_days(days);
    let hour = ms_of_day / 3_600_000;
    let minute = (ms_of_day % 3_600_000) / 60_000;
    let second = (ms_of_day % 60_000) / 1000;
    let milli = ms_of_day % 1000;
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        y, m, d, hour, minute, second, milli
    )
}

/// Days since 1970-01-01 → proleptic Gregorian (Howard Hinnant's algorithm).
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// Days since 1970-01-01 from a proleptic Gregorian date (inverse).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn is_leap_year(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

fn days_in_month(y: i64, m: i64) -> i64 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if is_leap_year(y) {
                29
            } else {
                28
            }
        }
        _ => 0,
    }
}

/// `Date.parse` for the ISO 8601 subset the relayer state actually stores
/// (`new Date().toISOString()` output, i.e. always `Z`-suffixed), plus the
/// date-only UTC form. Returns None for: empty/garbage input, datetimes
/// WITHOUT a timezone (JS resolves those against the LOCAL zone, which is
/// not portable — the vectors deliberately stay on Z-suffixed strings), or
/// out-of-range components (V8 rejects 2026-02-30 and 24:00 outright).
pub fn parse_iso_date_ms(input: &str) -> Option<f64> {
    let s = input.trim();
    let bytes = s.as_bytes();
    // YYYY-MM-DD
    if bytes.len() == 10 {
        let y: i64 = s.get(0..4)?.parse().ok()?;
        if bytes[4] != b'-' || bytes[7] != b'-' {
            return None;
        }
        let m: i64 = s.get(5..7)?.parse().ok()?;
        let d: i64 = s.get(8..10)?.parse().ok()?;
        if !(1..=12).contains(&m) || d < 1 || d > days_in_month(y, m) {
            return None;
        }
        return Some((days_from_civil(y, m, d) * 86_400_000) as f64);
    }
    // YYYY-MM-DD[T ]HH:MM[:SS[.sss]][Z | ±HH:MM | ±HHMM]
    if bytes.len() < 16 {
        return None;
    }
    let date_part = s.get(0..10)?;
    let sep = bytes[10];
    if sep != b'T' && sep != b't' && sep != b' ' {
        return None;
    }
    let time_and_tz = &s[11..];
    let t = time_and_tz.as_bytes();
    if t.len() < 5 || t[2] != b':' {
        return None;
    }
    let hour: i64 = time_and_tz.get(0..2)?.parse().ok()?;
    let minute: i64 = time_and_tz.get(3..5)?.parse().ok()?;
    if !(0..=23).contains(&hour) || !(0..=59).contains(&minute) {
        return None;
    }
    let mut rest = &time_and_tz[5..];
    let mut second = 0i64;
    let mut milli = 0i64;
    if rest.starts_with(':') {
        rest = &rest[1..];
        let mut chars = rest.char_indices();
        let ss: String = chars.by_ref().take(2).map(|(_, c)| c).collect();
        if ss.len() != 2 || !ss.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        second = ss.parse().ok()?;
        if !(0..=59).contains(&second) {
            return None;
        }
        rest = &rest[2..];
        if rest.starts_with('.') {
            rest = &rest[1..];
            let digits: usize = rest.bytes().take_while(|b| b.is_ascii_digit()).count();
            if digits == 0 || digits > 9 {
                return None;
            }
            let frac: String = rest.get(0..digits)?.chars().collect();
            rest = rest.get(digits..)?;
            // JS Date keeps exactly 3 digits of the fraction (truncation).
            let scaled: f64 = frac.parse().ok()?;
            milli = (scaled * 10f64.powi(3 - digits.min(3) as i32)) as i64;
            if digits > 3 {
                milli = frac.get(0..3)?.parse().ok()?;
            }
        }
    }
    let offset_ms: f64 = match rest.bytes().next() {
        None => return None, // local-time semantics: not portable, not pinned
        Some(b'Z') | Some(b'z') => {
            if rest.len() != 1 {
                return None;
            }
            0.0
        }
        Some(sign @ (b'+' | b'-')) => {
            let tz = &rest[1..];
            let (oh, om) = match tz.len() {
                5 if tz.as_bytes()[2] == b':' => (
                    tz.get(0..2)?.parse::<i64>().ok()?,
                    tz.get(3..5)?.parse::<i64>().ok()?,
                ),
                4 => (
                    tz.get(0..2)?.parse::<i64>().ok()?,
                    tz.get(2..4)?.parse::<i64>().ok()?,
                ),
                _ => return None,
            };
            if oh > 23 || om > 59 {
                return None;
            }
            let magnitude = (oh * 3_600_000 + om * 60_000) as f64;
            if sign == b'-' {
                -magnitude
            } else {
                magnitude
            }
        }
        _ => return None,
    };
    let y: i64 = date_part.get(0..4)?.parse().ok()?;
    if date_part.as_bytes()[4] != b'-' || date_part.as_bytes()[7] != b'-' {
        return None;
    }
    let m: i64 = date_part.get(5..7)?.parse().ok()?;
    let d: i64 = date_part.get(8..10)?.parse().ok()?;
    if !(1..=12).contains(&m) || d < 1 || d > days_in_month(y, m) {
        return None;
    }
    let utc_ms = (days_from_civil(y, m, d) * 86_400_000)
        + hour * 3_600_000
        + minute * 60_000
        + second * 1000
        + milli;
    Some(utc_ms as f64 - offset_ms)
}

// ── shape builders ───────────────────────────────────────────────────────────

fn default_chain_state() -> JsObject {
    let mut obj = JsObject::new();
    obj.set("last_block", JsValue::Null);
    obj.set("last_request_id", JsValue::Null);
    // Timestamp (ms) of the last successful discovery RPC; 0 = never scanned.
    obj.set("last_discovery_at", JsValue::Number(0.0));
    obj.set("processed_records", JsValue::Object(JsObject::new()));
    obj.set("processed_order", JsValue::Array(Vec::new()));
    obj.set("retry_queue", JsValue::Array(Vec::new()));
    obj.set("dead_letters", JsValue::Array(Vec::new()));
    obj
}

/// The metric seed list in EXACT JS definition order — snapshot key order is
/// contract (Prometheus renders it).
const METRIC_COUNTERS: &[&str] = &[
    "ticks_total",
    "events_scanned_total",
    "events_processed_total",
    "events_failed_total",
    "duplicates_skipped_total",
    "retries_scheduled_total",
    "retries_exhausted_total",
    "worker_calls_total",
    "worker_failures_total",
    "fulfill_success_total",
    "fulfill_failure_total",
    "claim_conflicts_total",
    "stale_reclaims_total",
    "discovery_failures_total",
    "reconciliation_failures_total",
    "durable_claim_skipped_during_backoff_total",
    "manual_actions_loaded_total",
    "feed_sync_runs_total",
    "feed_sync_success_total",
    "feed_sync_error_total",
    "feed_sync_skipped_total",
    "backpressure_deferred_total",
    "backpressure_retry_skipped_total",
    "retry_queue_overflow_total",
];

const METRIC_NULLABLE: &[&str] = &[
    "last_feed_sync_started_at",
    "last_feed_sync_completed_at",
    "last_feed_sync_success_at",
    "last_feed_sync_duration_ms",
    "last_tick_started_at",
    "last_tick_completed_at",
    "last_tick_duration_ms",
    "last_run_snapshot_persisted_at",
    "last_run_snapshot_error_at",
    "last_fulfill_latency_ms",
];

fn default_metrics() -> JsObject {
    let mut metrics = JsObject::new();
    for name in METRIC_COUNTERS {
        metrics.set(*name, JsValue::Number(0.0));
    }
    for name in METRIC_NULLABLE {
        metrics.set(*name, JsValue::Null);
    }
    // F5: labeled failure counter map keyed by "chain|module|operation".
    metrics.set("labeled_failures", JsValue::Object(JsObject::new()));
    metrics
}

/// Port of `createEmptyRelayerState`.
pub fn create_empty_relayer_state() -> JsObject {
    let mut state = JsObject::new();
    state.set("version", JsValue::Number(2.0));
    state.set("updated_at", JsValue::Null);
    for chain in RELAYER_CHAINS {
        state.set(*chain, JsValue::Object(default_chain_state()));
    }
    state.set("metrics", JsValue::Object(default_metrics()));
    state
}

/// Port of `normalizeChainState`: defaults first, then the raw object spread
/// on top (new keys append), then the explicit normalizations.
pub fn normalize_chain_state(raw: &JsValue) -> JsObject {
    let mut out = default_chain_state();
    if let Some(raw_obj) = raw.as_object() {
        for (key, value) in raw_obj.iter() {
            out.set(key, value.clone());
        }
    }
    // last_request_id: raw?.last_request_id ?? null — nullish, NOT falsy.
    let last_request_id = raw
        .as_object()
        .and_then(|obj| obj.get("last_request_id"))
        .cloned()
        .unwrap_or(JsValue::Null);
    out.set(
        "last_request_id",
        match last_request_id {
            JsValue::Undefined => JsValue::Null,
            other => other,
        },
    );
    let records = raw
        .as_object()
        .and_then(|obj| obj.get("processed_records"))
        .cloned()
        .unwrap_or(JsValue::Undefined);
    out.set(
        "processed_records",
        match records.as_object() {
            Some(_) => records,
            None => JsValue::Object(JsObject::new()),
        },
    );
    out.set(
        "processed_order",
        array_or_empty(raw.as_object().and_then(|obj| obj.get("processed_order"))),
    );
    out.set(
        "retry_queue",
        array_or_empty(raw.as_object().and_then(|obj| obj.get("retry_queue"))),
    );
    out.set(
        "dead_letters",
        array_or_empty(raw.as_object().and_then(|obj| obj.get("dead_letters"))),
    );
    out
}

fn array_or_empty(value: Option<&JsValue>) -> JsValue {
    match value {
        Some(JsValue::Array(items)) => JsValue::Array(items.clone()),
        _ => JsValue::Array(Vec::new()),
    }
}

/// Pure half of `loadRelayerState`: given the JSON-parsed state file (or
/// undefined on a missing/unreadable file), produce the normalized live
/// state. Corrupt JSON is handled by the CALLER falling back to undefined —
/// same semantics as the JS try/catch returning createEmptyRelayerState().
pub fn normalize_state_file_value(parsed: &JsValue) -> JsObject {
    let raw_obj = parsed.as_object();
    let version = raw_obj
        .and_then(|obj| obj.get("version"))
        .cloned()
        .unwrap_or(JsValue::Undefined);
    // JS: parsed?.version || 2 — falsy versions (0, '', null) reset to 2.
    let version_value = if version.truthy() {
        version
    } else {
        JsValue::Number(2.0)
    };
    let updated_at = raw_obj
        .and_then(|obj| obj.get("updated_at"))
        .cloned()
        .unwrap_or(JsValue::Undefined);
    let updated_at_value = if updated_at.truthy() {
        updated_at
    } else {
        JsValue::Null
    };
    let mut state = JsObject::new();
    state.set("version", version_value);
    state.set("updated_at", updated_at_value);
    for chain in RELAYER_CHAINS {
        let raw_chain = raw_obj
            .and_then(|obj| obj.get(chain))
            .cloned()
            .unwrap_or(JsValue::Undefined);
        state.set(*chain, JsValue::Object(normalize_chain_state(&raw_chain)));
    }
    let raw_metrics = raw_obj
        .and_then(|obj| obj.get("metrics"))
        .cloned()
        .unwrap_or(JsValue::Undefined);
    let mut metrics = default_metrics();
    if let Some(raw_metrics_obj) = raw_metrics.as_object() {
        for (key, value) in raw_metrics_obj.iter() {
            metrics.set(key, value.clone());
        }
    }
    state.set("metrics", JsValue::Object(metrics));
    state
}

// ── small JS coercions ───────────────────────────────────────────────────────

/// `String(value || fallback)` — JS truthiness chain then ToString.
fn string_with_fallback(value: &JsValue, fallback: &str) -> String {
    if value.truthy() {
        to_display_string(value)
    } else {
        fallback.to_string()
    }
}

/// `Number(value ?? 0)`-style coercion used for block numbers (nullish → 0).
fn number_nullish(value: &JsValue) -> f64 {
    match value {
        JsValue::Undefined | JsValue::Null => 0.0,
        other => crate::js_number::number_of(other),
    }
}

/// `Number(value || 0)` — falsy (including 0 itself) → 0.
fn number_or_zero(value: &JsValue) -> f64 {
    if value.truthy() {
        crate::js_number::number_of(value)
    } else {
        0.0
    }
}

/// `Number(value)` for metrics fields (NaN preserved by number_of).
fn metric_number(value: &JsValue) -> f64 {
    crate::js_number::number_of(value)
}

// ── event keys ───────────────────────────────────────────────────────────────

/// Port of `buildEventKey`:
/// `[chain||'unknown', requestId||'0', txHash||'', logIndex??'', blockNumber??''].join(':')`.
/// Note the mixed operators: requestId/txHash use `||` (0 falls through) but
/// logIndex/blockNumber use `??` (0 is a real value).
pub fn build_event_key(event: &JsValue) -> String {
    let empty = JsObject::new();
    let obj = event.as_object().unwrap_or(&empty);
    let get = |key: &str| -> JsValue { obj.get(key).cloned().unwrap_or(JsValue::Undefined) };
    let chain = string_with_fallback(&get("chain"), "unknown");
    let request_id = string_with_fallback(&get("requestId"), "0");
    let tx_hash = string_with_fallback(&get("txHash"), "");
    let log_index = match get("logIndex") {
        JsValue::Undefined | JsValue::Null => String::new(),
        other => to_display_string(&other),
    };
    let block_number = match get("blockNumber") {
        JsValue::Undefined | JsValue::Null => String::new(),
        other => to_display_string(&other),
    };
    format!("{chain}:{request_id}:{tx_hash}:{log_index}:{block_number}")
}

// ── pruning ──────────────────────────────────────────────────────────────────

fn get_chain_mut<'a>(state: &'a mut JsObject, chain: &str) -> Option<&'a mut JsObject> {
    state.get_mut(chain).and_then(|v| v.as_object_mut())
}

/// Port of `pruneProcessedRecords`: evict oldest keys (insertion order) while
/// over the cache limit.
fn prune_processed_records(chain_state: &mut JsObject, limit: f64) {
    let mut order: Vec<JsValue> = chain_state
        .get("processed_order")
        .and_then(|v| v.as_array())
        .map(|items| items.to_vec())
        .unwrap_or_default();
    while order.len() as f64 > limit {
        let oldest = order.remove(0);
        let key = to_display_string(&oldest);
        if key.is_empty() {
            continue;
        }
        if let Some(records) = chain_state
            .get_mut("processed_records")
            .and_then(|v| v.as_object_mut())
        {
            records.remove(&key);
        }
    }
    chain_state.set("processed_order", JsValue::Array(order));
}

/// Port of `pruneDeadLetters`: keep only the LAST `limit` entries.
fn prune_dead_letters(chain_state: &mut JsObject, limit: f64) {
    if let Some(letters) = chain_state.get("dead_letters").and_then(|v| v.as_array()) {
        let len = letters.len() as f64;
        if len > limit {
            let keep = letters[(len - limit) as usize..].to_vec();
            chain_state.set("dead_letters", JsValue::Array(keep));
        }
    }
}

// ── metrics ──────────────────────────────────────────────────────────────────

/// Port of `incrementMetric`: non-number fields reset to 0 before adding.
pub fn increment_metric(state: &mut JsObject, metric_name: &str, delta: f64) {
    let Some(metrics) = state.get_mut("metrics").and_then(|v| v.as_object_mut()) else {
        return;
    };
    let current = match metrics.get(metric_name) {
        Some(JsValue::Number(n)) => *n,
        _ => 0.0, // typeof !== 'number' → seed at 0
    };
    metrics.set(metric_name, JsValue::Number(current + delta));
}

/// Port of `incrementLabeledFailure` (F5): bounded-cardinality
/// {chain x module x operation} counters under metrics.labeled_failures.
pub fn increment_labeled_failure(
    state: &mut JsObject,
    chain: &str,
    module: &str,
    operation: &str,
    delta: f64,
) {
    let key = format!(
        "{}{LABELED_FAILURE_DELIMITER}{}{LABELED_FAILURE_DELIMITER}{}",
        if chain.is_empty() { "unknown" } else { chain },
        if module.is_empty() { "unknown" } else { module },
        if operation.is_empty() {
            "unknown"
        } else {
            operation
        },
    );
    let Some(metrics) = state.get_mut("metrics").and_then(|v| v.as_object_mut()) else {
        return;
    };
    if !matches!(metrics.get("labeled_failures"), Some(JsValue::Object(_))) {
        metrics.set("labeled_failures", JsValue::Object(JsObject::new()));
    }
    let Some(labeled) = metrics
        .get_mut("labeled_failures")
        .and_then(|v| v.as_object_mut())
    else {
        return;
    };
    // JS: (Number(existing) || 0) + delta — NaN (missing) seeds at 0.
    let existing = labeled.get(&key).map(metric_number).unwrap_or(f64::NAN);
    let base = if existing.is_nan() || existing == 0.0 {
        0.0
    } else {
        existing
    };
    labeled.set(key, JsValue::Number(base + delta));
}

/// Port of `oldestAgeSeconds`: age in seconds of the oldest parseable
/// `items[].field` ISO timestamp, clamped to >= 0 (clock skew), or null when
/// nothing parses.
fn oldest_age_seconds(items: &[JsValue], field: &str, now_ms: f64) -> JsValue {
    let mut oldest_ms: Option<f64> = None;
    for item in items {
        let value = item
            .as_object()
            .and_then(|obj| obj.get(field))
            .cloned()
            .unwrap_or(JsValue::Undefined);
        let raw = string_with_fallback(&value, "");
        let Some(parsed) = parse_iso_date_ms(&raw) else {
            continue;
        };
        if oldest_ms.map(|oldest| parsed < oldest).unwrap_or(true) {
            oldest_ms = Some(parsed);
        }
    }
    match oldest_ms {
        None => JsValue::Null,
        Some(oldest) => JsValue::Number(((now_ms - oldest) / 1000.0).floor().max(0.0)),
    }
}

/// Port of `snapshotMetrics`: the metrics spread plus per-chain gauge maps
/// and the labeled-failure expansion, all in contract key order.
pub fn snapshot_metrics(state: &JsObject, now_ms: f64) -> JsObject {
    let mut out = JsObject::new();
    if let Some(metrics) = state.get("metrics").and_then(|v| v.as_object()) {
        for (key, value) in metrics.iter() {
            out.set(key, value.clone());
        }
    }
    let mut retry_queue_sizes = JsObject::new();
    let mut dead_letter_sizes = JsObject::new();
    let mut checkpoints = JsObject::new();
    let mut request_checkpoints = JsObject::new();
    let mut oldest_retry_age_seconds = JsObject::new();
    let mut oldest_dead_letter_age_seconds = JsObject::new();
    for chain in RELAYER_CHAINS {
        let Some(chain_state) = state.get(chain).and_then(|v| v.as_object()) else {
            continue;
        };
        let retry_queue = chain_state
            .get("retry_queue")
            .and_then(|v| v.as_array())
            .map(|items| items.to_vec())
            .unwrap_or_default();
        let dead_letters = chain_state
            .get("dead_letters")
            .and_then(|v| v.as_array())
            .map(|items| items.to_vec())
            .unwrap_or_default();
        retry_queue_sizes.set(*chain, JsValue::Number(retry_queue.len() as f64));
        dead_letter_sizes.set(*chain, JsValue::Number(dead_letters.len() as f64));
        checkpoints.set(
            *chain,
            chain_state
                .get("last_block")
                .cloned()
                .unwrap_or(JsValue::Null),
        );
        request_checkpoints.set(
            *chain,
            chain_state
                .get("last_request_id")
                .cloned()
                .unwrap_or(JsValue::Null),
        );
        oldest_retry_age_seconds.set(
            *chain,
            oldest_age_seconds(&retry_queue, "first_failed_at", now_ms),
        );
        oldest_dead_letter_age_seconds.set(
            *chain,
            oldest_age_seconds(&dead_letters, "exhausted_at", now_ms),
        );
    }
    out.set("retry_queue_sizes", JsValue::Object(retry_queue_sizes));
    out.set("dead_letter_sizes", JsValue::Object(dead_letter_sizes));
    out.set("checkpoints", JsValue::Object(checkpoints));
    out.set("request_checkpoints", JsValue::Object(request_checkpoints));
    out.set(
        "oldest_retry_age_seconds",
        JsValue::Object(oldest_retry_age_seconds),
    );
    out.set(
        "oldest_dead_letter_age_seconds",
        JsValue::Object(oldest_dead_letter_age_seconds),
    );
    // F5: expand the labeled map into [{chain, module, operation, value}].
    let mut labeled_out: Vec<JsValue> = Vec::new();
    if let Some(labeled) = state
        .get("metrics")
        .and_then(|v| v.as_object())
        .and_then(|m| m.get("labeled_failures"))
        .and_then(|v| v.as_object())
    {
        for (key, value) in labeled.iter() {
            let parts: Vec<&str> = key.split(LABELED_FAILURE_DELIMITER).collect();
            let chain = parts.first().copied().unwrap_or("unknown");
            let module = parts.get(1).copied().unwrap_or("unknown");
            let operation = parts.get(2).copied().unwrap_or("unknown");
            let number = metric_number(value);
            let val = if number.is_nan() { 0.0 } else { number };
            let mut entry = JsObject::new();
            entry.set("chain", JsValue::Str(chain.to_string()));
            entry.set("module", JsValue::Str(module.to_string()));
            entry.set("operation", JsValue::Str(operation.to_string()));
            entry.set("value", JsValue::Number(val));
            labeled_out.push(JsValue::Object(entry));
        }
    }
    out.set("labeled_failures", JsValue::Array(labeled_out));
    out
}

// ── membership ───────────────────────────────────────────────────────────────

/// Port of `hasProcessedEvent`.
pub fn has_processed_event(state: &JsObject, chain: &str, key: &str) -> bool {
    state
        .get(chain)
        .and_then(|v| v.as_object())
        .and_then(|cs| cs.get("processed_records"))
        .and_then(|v| v.as_object())
        .and_then(|records| records.get(key))
        .map(JsValue::truthy)
        .unwrap_or(false)
}

/// Port of `isEventQueuedForRetry`.
pub fn is_event_queued_for_retry(state: &JsObject, chain: &str, key: &str) -> bool {
    state
        .get(chain)
        .and_then(|v| v.as_object())
        .and_then(|cs| cs.get("retry_queue"))
        .and_then(|v| v.as_array())
        .map(|queue| {
            queue.iter().any(|item| {
                item.as_object()
                    .and_then(|o| o.get("key"))
                    .map(JsValue::truthy)
                    == Some(true)
                    && item
                        .as_object()
                        .and_then(|o| o.get("key"))
                        .and_then(|k| k.as_str())
                        == Some(key)
            })
        })
        .unwrap_or(false)
}

/// Port of `removeProcessedEvent` (no-op when the chain is absent, which the
/// JS oracle cannot reach — chains are fixed).
pub fn remove_processed_event(state: &mut JsObject, chain: &str, key: &str) {
    let Some(chain_state) = get_chain_mut(state, chain) else {
        return;
    };
    if let Some(records) = chain_state
        .get_mut("processed_records")
        .and_then(|v| v.as_object_mut())
    {
        records.remove(key);
    }
    if let Some(order) = chain_state
        .get_mut("processed_order")
        .and_then(|v| v.as_array_mut())
    {
        order.retain(|entry| to_display_string(entry) != key);
    }
}

/// Port of `removeDeadLetter`.
pub fn remove_dead_letter(state: &mut JsObject, chain: &str, key: &str) {
    let Some(chain_state) = get_chain_mut(state, chain) else {
        return;
    };
    if let Some(letters) = chain_state
        .get_mut("dead_letters")
        .and_then(|v| v.as_array_mut())
    {
        letters.retain(|entry| {
            entry
                .as_object()
                .and_then(|o| o.get("key"))
                .and_then(|k| k.as_str())
                != Some(key)
        });
    }
}

/// Port of `clearRetryItem`.
pub fn clear_retry_item(state: &mut JsObject, chain: &str, key: &str) {
    let Some(chain_state) = get_chain_mut(state, chain) else {
        return;
    };
    if let Some(queue) = chain_state
        .get_mut("retry_queue")
        .and_then(|v| v.as_array_mut())
    {
        queue.retain(|item| {
            item.as_object()
                .and_then(|o| o.get("key"))
                .and_then(|k| k.as_str())
                != Some(key)
        });
    }
}

// ── dead-letter shed / queue ops ─────────────────────────────────────────────

fn dead_letter_from_shed(item: &JsValue, chain: &str, now_ms: f64) -> JsValue {
    let empty = JsObject::new();
    let item_obj = item.as_object().unwrap_or(&empty);
    let default_event = JsValue::Object(JsObject::new());
    let event = item_obj.get("event").cloned().unwrap_or(default_event);
    let event_obj = event.as_object();
    let get_event = |key: &str| -> JsValue {
        event_obj
            .and_then(|o| o.get(key))
            .cloned()
            .unwrap_or(JsValue::Undefined)
    };
    let request_type = string_with_fallback(&get_event("requestType"), "");
    let intent = kernel::resolve_kernel_intent(&request_type);
    let mut letter = JsObject::new();
    letter.set(
        "key",
        item_obj.get("key").cloned().unwrap_or(JsValue::Undefined),
    );
    letter.set(
        "request_id",
        JsValue::Str(string_with_fallback(&get_event("requestId"), "0")),
    );
    letter.set("request_type", JsValue::Str(request_type));
    letter.set("module_id", JsValue::Str(intent.module_id.to_string()));
    letter.set("operation", JsValue::Str(intent.operation.clone()));
    letter.set("chain", JsValue::Str(chain.to_string()));
    letter.set("event", event);
    letter.set(
        "attempts",
        JsValue::Number(number_or_zero(
            &item_obj
                .get("attempts")
                .cloned()
                .unwrap_or(JsValue::Undefined),
        )),
    );
    letter.set(
        "last_error",
        JsValue::Str(string_with_fallback(
            &item_obj
                .get("last_error")
                .cloned()
                .unwrap_or(JsValue::Undefined),
            "retry_queue_overflow",
        )),
    );
    letter.set("exhausted_at", JsValue::Str(ms_to_iso_string(now_ms)));
    letter.set(
        "shed_reason",
        JsValue::Str("retry_queue_overflow".to_string()),
    );
    JsValue::Object(letter)
}

/// Port of `enforceRetryQueueLimit` (B10): shed the OLDEST retry items into
/// dead letters when the queue exceeds the ceiling; 0/undefined = unbounded.
/// Returns the number of items shed.
pub fn enforce_retry_queue_limit(
    state: &mut JsObject,
    chain: &str,
    limits: &JsObject,
    now_ms: f64,
) -> f64 {
    let limit = number_or_zero(
        &limits
            .get("retryQueueLimit")
            .cloned()
            .unwrap_or(JsValue::Undefined),
    )
    .max(0.0);
    if limit <= 0.0 {
        return 0.0;
    }
    let Some(chain_state) = get_chain_mut(state, chain) else {
        return 0.0;
    };
    let queue: Vec<JsValue> = chain_state
        .get("retry_queue")
        .and_then(|v| v.as_array())
        .map(|items| items.to_vec())
        .unwrap_or_default();
    if queue.len() as f64 <= limit {
        return 0.0;
    }
    let overflow_count = queue.len() as f64 - limit;
    let shed: Vec<JsValue> = queue[..overflow_count as usize].to_vec();
    chain_state.set(
        "retry_queue",
        JsValue::Array(queue[overflow_count as usize..].to_vec()),
    );
    for item in &shed {
        let letter = dead_letter_from_shed(item, chain, now_ms);
        chain_state.push_array("dead_letters", letter);
    }
    let dead_letter_limit = number_or_zero(
        &limits
            .get("deadLetterLimit")
            .cloned()
            .unwrap_or(JsValue::Undefined),
    );
    // JS: limits.deadLetterLimit || 200 — 0 falls through to 200.
    let dead_letter_limit = if dead_letter_limit == 0.0 {
        200.0
    } else {
        dead_letter_limit
    };
    prune_dead_letters(chain_state, dead_letter_limit);
    increment_metric(state, "retry_queue_overflow_total", shed.len() as f64);
    shed.len() as f64
}

/// Port of `enqueueRetryItem`: upsert by event key, newest at the tail, then
/// enforce the ceiling (overflow sheds older items).
pub fn enqueue_retry_item(
    state: &mut JsObject,
    chain: &str,
    event: &JsValue,
    options: &JsObject,
    now_ms: f64,
) -> JsValue {
    let key = build_event_key(event);
    let attempts = number_or_zero(
        &options
            .get("attempts")
            .cloned()
            .unwrap_or(JsValue::Undefined),
    );
    let next_retry_at = number_or_zero(
        &options
            .get("next_retry_at")
            .cloned()
            .unwrap_or(JsValue::Undefined),
    );
    let next_retry_at = if next_retry_at == 0.0 {
        now_ms
    } else {
        next_retry_at
    };
    let first_failed_at = match options.get("first_failed_at") {
        Some(v) if v.truthy() => to_display_string(v),
        _ => ms_to_iso_string(now_ms),
    };
    let prepared = match options.get("prepared_fulfillment") {
        Some(v) if v.truthy() && v.as_object().is_some() => v.clone(),
        _ => JsValue::Null,
    };
    let mut item = JsObject::new();
    item.set("key", JsValue::Str(key.clone()));
    item.set("event", event.clone());
    item.set("attempts", JsValue::Number(attempts));
    item.set("next_retry_at", JsValue::Number(next_retry_at));
    item.set("first_failed_at", JsValue::Str(first_failed_at));
    item.set("updated_at", JsValue::Str(ms_to_iso_string(now_ms)));
    item.set(
        "last_error",
        options.get("last_error").cloned().unwrap_or(JsValue::Null),
    );
    item.set(
        "manual_action",
        options
            .get("manual_action")
            .cloned()
            .unwrap_or(JsValue::Null),
    );
    item.set(
        "finalize_only",
        JsValue::Bool(
            options
                .get("finalize_only")
                .cloned()
                .unwrap_or(JsValue::Undefined)
                .truthy(),
        ),
    );
    item.set(
        "terminal_error",
        options
            .get("terminal_error")
            .cloned()
            .unwrap_or(JsValue::Null),
    );
    item.set("prepared_fulfillment", prepared);
    item.set(
        "durable_claimed",
        JsValue::Bool(
            options
                .get("durable_claimed")
                .cloned()
                .unwrap_or(JsValue::Undefined)
                .truthy(),
        ),
    );
    let item_value = JsValue::Object(item);

    let Some(chain_state) = get_chain_mut(state, chain) else {
        return item_value;
    };
    let mut queue: Vec<JsValue> = chain_state
        .get("retry_queue")
        .and_then(|v| v.as_array())
        .map(|items| items.to_vec())
        .unwrap_or_default();
    let existing_index = queue.iter().position(|entry| {
        entry
            .as_object()
            .and_then(|o| o.get("key"))
            .and_then(|k| k.as_str())
            == Some(key.as_str())
    });
    match existing_index {
        Some(index) => queue[index] = item_value.clone(),
        None => queue.push(item_value.clone()),
    }
    chain_state.set("retry_queue", JsValue::Array(queue));

    let mut limits = JsObject::new();
    limits.set(
        "retryQueueLimit",
        options
            .get("retryQueueLimit")
            .cloned()
            .unwrap_or(JsValue::Undefined),
    );
    limits.set(
        "deadLetterLimit",
        options
            .get("deadLetterLimit")
            .cloned()
            .unwrap_or(JsValue::Undefined),
    );
    enforce_retry_queue_limit(state, chain, &limits, now_ms);
    item_value
}

/// Port of `recordProcessedEvent`: upsert the LRU record, clear any retry
/// item, optionally dead-letter on `exhausted`, prune both structures.
pub fn record_processed_event(
    state: &mut JsObject,
    chain: &str,
    event: &JsValue,
    status: &str,
    meta: &JsObject,
    limits: &JsObject,
    now_ms: f64,
) -> JsValue {
    let key = build_event_key(event);
    let empty = JsObject::new();
    let event_obj = event.as_object().unwrap_or(&empty);
    let get_event =
        |name: &str| -> JsValue { event_obj.get(name).cloned().unwrap_or(JsValue::Undefined) };
    let request_type = string_with_fallback(&get_event("requestType"), "");
    let intent = kernel::resolve_kernel_intent(&request_type);

    let Some(chain_state) = get_chain_mut(state, chain) else {
        return JsValue::Undefined;
    };
    let has_record = {
        let records = chain_state
            .get("processed_records")
            .and_then(|v| v.as_object())
            .expect("processed_records is always an object");
        records.contains_key(&key)
    };
    if !has_record {
        chain_state.push_array("processed_order", JsValue::Str(key.clone()));
    }
    let mut record = JsObject::new();
    record.set("key", JsValue::Str(key.clone()));
    record.set("status", JsValue::Str(status.to_string()));
    record.set(
        "request_id",
        JsValue::Str(string_with_fallback(&get_event("requestId"), "0")),
    );
    record.set("request_type", JsValue::Str(request_type));
    record.set("module_id", JsValue::Str(intent.module_id.to_string()));
    record.set("operation", JsValue::Str(intent.operation.clone()));
    record.set(
        "tx_hash",
        JsValue::Str(string_with_fallback(&get_event("txHash"), "")),
    );
    record.set(
        "block_number",
        JsValue::Number(number_nullish(&get_event("blockNumber"))),
    );
    record.set("completed_at", JsValue::Str(ms_to_iso_string(now_ms)));
    for (meta_key, meta_value) in meta.iter() {
        record.set(meta_key, meta_value.clone());
    }
    let record_value = JsValue::Object(record);
    if let Some(records) = chain_state
        .get_mut("processed_records")
        .and_then(|v| v.as_object_mut())
    {
        records.set(key.clone(), record_value.clone());
    }
    // Drop any queued retry for this event.
    if let Some(queue) = chain_state
        .get_mut("retry_queue")
        .and_then(|v| v.as_array_mut())
    {
        queue.retain(|item| {
            item.as_object()
                .and_then(|o| o.get("key"))
                .and_then(|k| k.as_str())
                != Some(key.as_str())
        });
    }
    if status == "exhausted" {
        let mut letter = JsObject::new();
        letter.set("key", JsValue::Str(key.clone()));
        letter.set(
            "request_id",
            JsValue::Str(string_with_fallback(&get_event("requestId"), "0")),
        );
        letter.set(
            "request_type",
            JsValue::Str(string_with_fallback(&get_event("requestType"), "")),
        );
        letter.set("module_id", JsValue::Str(intent.module_id.to_string()));
        letter.set("operation", JsValue::Str(intent.operation.clone()));
        letter.set("chain", JsValue::Str(chain.to_string()));
        letter.set("event", event.clone());
        letter.set("exhausted_at", JsValue::Str(ms_to_iso_string(now_ms)));
        for (meta_key, meta_value) in meta.iter() {
            letter.set(meta_key, meta_value.clone());
        }
        chain_state.push_array("dead_letters", JsValue::Object(letter));
        let dead_letter_limit = number_or_zero(
            &limits
                .get("deadLetterLimit")
                .cloned()
                .unwrap_or(JsValue::Undefined),
        );
        let dead_letter_limit = if dead_letter_limit == 0.0 {
            200.0
        } else {
            dead_letter_limit
        };
        prune_dead_letters(chain_state, dead_letter_limit);
    }
    let processed_cache_size = number_or_zero(
        &limits
            .get("processedCacheSize")
            .cloned()
            .unwrap_or(JsValue::Undefined),
    );
    let processed_cache_size = if processed_cache_size == 0.0 {
        5000.0
    } else {
        processed_cache_size
    };
    prune_processed_records(chain_state, processed_cache_size);
    record_value
}

/// Port of `scheduleRetry`: bump the attempt count; past `maxRetries` the
/// item is removed and reported exhausted, otherwise it is rescheduled with
/// the shared backoff curve. `rng` and `now_ms` are injected for vectors.
pub fn schedule_retry(
    state: &mut JsObject,
    chain: &str,
    event: &JsValue,
    error_message: &str,
    config: &JsObject,
    rng: f64,
    now_ms: f64,
) -> JsValue {
    let key = build_event_key(event);
    let Some(chain_state) = get_chain_mut(state, chain) else {
        return JsValue::Undefined;
    };
    let queue: Vec<JsValue> = chain_state
        .get("retry_queue")
        .and_then(|v| v.as_array())
        .map(|items| items.to_vec())
        .unwrap_or_default();
    let existing = queue.iter().find_map(|item| {
        let obj = item.as_object()?;
        if obj.get("key").and_then(|k| k.as_str()) == Some(key.as_str()) {
            Some(obj.clone())
        } else {
            None
        }
    });
    let existing_attempts = existing
        .as_ref()
        .and_then(|obj| obj.get("attempts"))
        .map(number_or_zero)
        .unwrap_or(0.0);
    // JS: (existing?.attempts || 0) + 1
    let attempts = if existing_attempts == 0.0 {
        0.0
    } else {
        existing_attempts
    } + 1.0;

    let max_retries = crate::js_number::number_of(
        &config
            .get("maxRetries")
            .cloned()
            .unwrap_or(JsValue::Undefined),
    );
    if attempts > max_retries {
        chain_state.set(
            "retry_queue",
            JsValue::Array(
                queue
                    .into_iter()
                    .filter(|item| {
                        item.as_object()
                            .and_then(|o| o.get("key"))
                            .and_then(|k| k.as_str())
                            != Some(key.as_str())
                    })
                    .collect(),
            ),
        );
        let mut result = JsObject::new();
        result.set("status", JsValue::Str("exhausted".to_string()));
        result.set("key", JsValue::Str(key));
        result.set("attempts", JsValue::Number(attempts));
        result.set("error", JsValue::Str(error_message.to_string()));
        return JsValue::Object(result);
    }

    let base = crate::js_number::number_of(
        &config
            .get("retryBaseDelayMs")
            .cloned()
            .unwrap_or(JsValue::Undefined),
    );
    let max = crate::js_number::number_of(
        &config
            .get("retryMaxDelayMs")
            .cloned()
            .unwrap_or(JsValue::Undefined),
    );
    let delay_ms = compute_retry_delay_ms(base, max, attempts, rng);
    let first_failed_at = existing
        .as_ref()
        .and_then(|obj| obj.get("first_failed_at"))
        .filter(|v| v.truthy())
        .map(to_display_string)
        .unwrap_or_else(|| ms_to_iso_string(now_ms));
    let mut item = JsObject::new();
    item.set("key", JsValue::Str(key.clone()));
    item.set("event", event.clone());
    item.set("attempts", JsValue::Number(attempts));
    item.set("next_retry_at", JsValue::Number(now_ms + delay_ms));
    item.set("first_failed_at", JsValue::Str(first_failed_at));
    item.set("updated_at", JsValue::Str(ms_to_iso_string(now_ms)));
    item.set("last_error", JsValue::Str(error_message.to_string()));
    let item_value = JsValue::Object(item);

    let mut new_queue: Vec<JsValue> = queue;
    match new_queue.iter().position(|entry| {
        entry
            .as_object()
            .and_then(|o| o.get("key"))
            .and_then(|k| k.as_str())
            == Some(key.as_str())
    }) {
        Some(index) => new_queue[index] = item_value.clone(),
        None => new_queue.push(item_value.clone()),
    }
    chain_state.set("retry_queue", JsValue::Array(new_queue));

    let mut limits = JsObject::new();
    limits.set(
        "retryQueueLimit",
        config
            .get("retryQueueLimit")
            .cloned()
            .unwrap_or(JsValue::Undefined),
    );
    limits.set(
        "deadLetterLimit",
        config
            .get("deadLetterLimit")
            .cloned()
            .unwrap_or(JsValue::Undefined),
    );
    enforce_retry_queue_limit(state, chain, &limits, now_ms);

    let mut result = JsObject::new();
    result.set("status", JsValue::Str("scheduled".to_string()));
    result.set("key", JsValue::Str(key));
    result.set("item", item_value);
    JsValue::Object(result)
}

/// Port of `getDueRetryItems`: queued items whose next_retry_at has passed,
/// oldest first (stable sort on the numeric next_retry_at).
pub fn get_due_retry_items(state: &JsObject, chain: &str, now: f64) -> Vec<JsValue> {
    let Some(chain_state) = state.get(chain).and_then(|v| v.as_object()) else {
        return Vec::new();
    };
    let queue = chain_state
        .get("retry_queue")
        .and_then(|v| v.as_array())
        .map(|items| items.to_vec())
        .unwrap_or_default();
    let mut due: Vec<JsValue> = queue
        .into_iter()
        .filter(|item| {
            let next = item
                .as_object()
                .and_then(|o| o.get("next_retry_at"))
                .map(number_or_zero)
                .unwrap_or(0.0);
            next <= now
        })
        .collect();
    due.sort_by(|left, right| {
        let l = left
            .as_object()
            .and_then(|o| o.get("next_retry_at"))
            .map(number_or_zero)
            .unwrap_or(0.0);
        let r = right
            .as_object()
            .and_then(|o| o.get("next_retry_at"))
            .map(number_or_zero)
            .unwrap_or(0.0);
        l.partial_cmp(&r).unwrap_or(std::cmp::Ordering::Equal)
    });
    due
}

/// Port of `collectActiveRequestIds`: every requestId already tracked for a
/// chain (retry queue + processed records), insertion-ordered, deduped.
pub fn collect_active_request_ids(state: &JsObject, chain: &str) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    let Some(chain_state) = state.get(chain).and_then(|v| v.as_object()) else {
        return ids;
    };
    if let Some(queue) = chain_state.get("retry_queue").and_then(|v| v.as_array()) {
        for item in queue {
            let request_id = item
                .as_object()
                .and_then(|o| o.get("event"))
                .and_then(|e| e.as_object())
                .and_then(|e| e.get("requestId"))
                .cloned()
                .unwrap_or(JsValue::Undefined);
            if request_id.truthy() {
                let id = to_display_string(&request_id);
                if !id.is_empty() && !ids.contains(&id) {
                    ids.push(id);
                }
            }
        }
    }
    if let Some(records) = chain_state
        .get("processed_records")
        .and_then(|v| v.as_object())
    {
        for (_, record) in records.iter() {
            let request_id = record
                .as_object()
                .and_then(|o| o.get("request_id"))
                .cloned()
                .unwrap_or(JsValue::Undefined);
            if request_id.truthy() {
                let id = to_display_string(&request_id);
                if !id.is_empty() && !ids.contains(&id) {
                    ids.push(id);
                }
            }
        }
    }
    ids
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(chain: &str, request_id: &str, tx: &str, log_index: f64, block: f64) -> JsValue {
        let mut obj = JsObject::new();
        obj.set("chain", JsValue::Str(chain.to_string()));
        obj.set("requestId", JsValue::Str(request_id.to_string()));
        obj.set("txHash", JsValue::Str(tx.to_string()));
        obj.set("logIndex", JsValue::Number(log_index));
        obj.set("blockNumber", JsValue::Number(block));
        JsValue::Object(obj)
    }

    #[test]
    fn event_key_mixed_operators() {
        // `||` on requestId: 0 falls through to '0'; `??` on logIndex: 0 stays.
        let mut e = JsObject::new();
        e.set("chain", JsValue::Str("neo_n3".to_string()));
        e.set("requestId", JsValue::Number(0.0));
        e.set("txHash", JsValue::Str("".to_string()));
        e.set("logIndex", JsValue::Number(0.0));
        e.set("blockNumber", JsValue::Number(42.0));
        assert_eq!(build_event_key(&JsValue::Object(e)), "neo_n3:0::0:42");
        // Missing event entirely → all fallbacks ('||' fills chain and
        // requestId; '??' leaves logIndex/blockNumber as empty strings).
        assert_eq!(build_event_key(&JsValue::Undefined), "unknown:0:::");
    }

    #[test]
    fn empty_state_shape_is_pinned() {
        let state = create_empty_relayer_state();
        let keys: Vec<&str> = state.iter().map(|(k, _)| k).collect();
        assert_eq!(
            keys,
            vec!["version", "updated_at", "neo_n3", "neox", "metrics"]
        );
        let chain_keys: Vec<&str> = state
            .get("neo_n3")
            .unwrap()
            .as_object()
            .unwrap()
            .iter()
            .map(|(k, _)| k)
            .collect();
        assert_eq!(
            chain_keys,
            vec![
                "last_block",
                "last_request_id",
                "last_discovery_at",
                "processed_records",
                "processed_order",
                "retry_queue",
                "dead_letters"
            ]
        );
        let metrics = state.get("metrics").unwrap().as_object().unwrap();
        assert_eq!(
            metrics.len(),
            35,
            "24 counters + 10 nullable + labeled_failures"
        );
        assert_eq!(metrics.get("ticks_total"), Some(&JsValue::Number(0.0)));
        assert_eq!(metrics.get("last_tick_started_at"), Some(&JsValue::Null));
    }

    #[test]
    fn iso_round_trip_matches_date_to_iso_string() {
        // 2026-09-03T12:34:56.789Z
        let ms = parse_iso_date_ms("2026-09-03T12:34:56.789Z").unwrap();
        assert_eq!(ms_to_iso_string(ms), "2026-09-03T12:34:56.789Z");
        // Epoch + offsets.
        assert_eq!(ms_to_iso_string(0.0), "1970-01-01T00:00:00.000Z");
        assert_eq!(
            ms_to_iso_string(parse_iso_date_ms("2026-01-01T00:00:00+08:00").unwrap()),
            "2025-12-31T16:00:00.000Z"
        );
        // Date-only parses as UTC midnight.
        assert_eq!(
            parse_iso_date_ms("2026-09-03").unwrap(),
            parse_iso_date_ms("2026-09-03T00:00:00.000Z").unwrap()
        );
        // Invalid dates are rejected like V8.
        assert!(parse_iso_date_ms("2026-02-30").is_none());
        assert!(parse_iso_date_ms("2026-02-30T00:00:00Z").is_none());
        assert!(parse_iso_date_ms("2026-01-01T24:00:00Z").is_none());
        assert!(parse_iso_date_ms("").is_none());
        assert!(parse_iso_date_ms("not a date").is_none());
    }

    #[test]
    fn oldest_age_uses_minimum_and_clamps() {
        let make = |iso: &str| {
            let mut obj = JsObject::new();
            obj.set("first_failed_at", JsValue::Str(iso.to_string()));
            JsValue::Object(obj)
        };
        let items = vec![
            make("2026-01-01T00:00:10.000Z"),
            make("2026-01-01T00:00:40.000Z"),
        ];
        let now = parse_iso_date_ms("2026-01-01T00:01:00.000Z").unwrap();
        assert_eq!(
            oldest_age_seconds(&items, "first_failed_at", now),
            JsValue::Number(50.0)
        );
        // Future timestamp clamps to 0, never negative.
        let future = vec![make("2026-01-01T01:00:00.000Z")];
        assert_eq!(
            oldest_age_seconds(&future, "first_failed_at", now),
            JsValue::Number(0.0)
        );
        // Nothing parseable → null.
        let empty: Vec<JsValue> = vec![];
        assert_eq!(
            oldest_age_seconds(&empty, "first_failed_at", now),
            JsValue::Null
        );
    }

    #[test]
    fn enqueue_upserts_and_limit_sheds_oldest() {
        let mut state = create_empty_relayer_state();
        let e1 = event("neo_n3", "1", "tx1", 0.0, 100.0);
        let e2 = event("neo_n3", "2", "tx2", 0.0, 101.0);
        let e3 = event("neo_n3", "3", "tx3", 0.0, 102.0);
        let now = 1_700_000_000_000.0;
        let mut opts = JsObject::new();
        opts.set("retryQueueLimit", JsValue::Number(2.0));
        enqueue_retry_item(&mut state, "neo_n3", &e1, &opts, now);
        enqueue_retry_item(&mut state, "neo_n3", &e2, &opts, now);
        enqueue_retry_item(&mut state, "neo_n3", &e3, &opts, now);
        let chain_state = state.get("neo_n3").unwrap().as_object().unwrap();
        let queue = chain_state.get("retry_queue").unwrap().as_array().unwrap();
        assert_eq!(queue.len(), 2, "oldest shed");
        // First item landed in dead letters with the pinned shape.
        let letters = chain_state.get("dead_letters").unwrap().as_array().unwrap();
        assert_eq!(letters.len(), 1);
        let letter = letters[0].as_object().unwrap();
        assert_eq!(
            letter.get("shed_reason"),
            Some(&JsValue::Str("retry_queue_overflow".to_string()))
        );
        assert_eq!(
            letter.get("module_id").and_then(|v| v.as_str()),
            kernel::resolve_kernel_intent("").module_id.into(),
        );
        assert_eq!(
            letter.get("exhausted_at"),
            Some(&JsValue::Str(ms_to_iso_string(now)))
        );
        // Overflow counter incremented.
        assert_eq!(
            state
                .get("metrics")
                .unwrap()
                .as_object()
                .unwrap()
                .get("retry_queue_overflow_total"),
            Some(&JsValue::Number(1.0))
        );
    }

    #[test]
    fn schedule_retry_exhausts_after_max() {
        let mut state = create_empty_relayer_state();
        let e = event("neox", "7", "tx7", 1.0, 200.0);
        let mut config = JsObject::new();
        config.set("maxRetries", JsValue::Number(1.0));
        config.set("retryBaseDelayMs", JsValue::Number(1000.0));
        config.set("retryMaxDelayMs", JsValue::Number(5000.0));
        let now = 1_700_000_000_000.0;
        // Attempt 1 → scheduled.
        let r1 = schedule_retry(&mut state, "neox", &e, "boom", &config, 1.0, now);
        assert_eq!(
            r1.as_object().unwrap().get("status"),
            Some(&JsValue::Str("scheduled".to_string()))
        );
        // Attempt 2 > maxRetries 1 → exhausted and removed from the queue.
        let r2 = schedule_retry(&mut state, "neox", &e, "boom", &config, 1.0, now);
        let r2_obj = r2.as_object().unwrap();
        assert_eq!(
            r2_obj.get("status"),
            Some(&JsValue::Str("exhausted".to_string()))
        );
        assert_eq!(r2_obj.get("attempts"), Some(&JsValue::Number(2.0)));
        let chain_state = state.get("neox").unwrap().as_object().unwrap();
        assert_eq!(
            chain_state
                .get("retry_queue")
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            0
        );
    }

    #[test]
    fn schedule_retry_backoff_uses_injected_rng_and_clock() {
        let mut state = create_empty_relayer_state();
        let e = event("neo_n3", "9", "tx9", 0.0, 300.0);
        let mut config = JsObject::new();
        config.set("maxRetries", JsValue::Number(5.0));
        config.set("retryBaseDelayMs", JsValue::Number(1000.0));
        config.set("retryMaxDelayMs", JsValue::Number(5000.0));
        let now = 1_700_000_000_000.0;
        let result = schedule_retry(&mut state, "neo_n3", &e, "x", &config, 0.5, now);
        let item = result
            .as_object()
            .unwrap()
            .get("item")
            .unwrap()
            .as_object()
            .unwrap();
        // ceiling 1000, jitter 0.75 → 750.
        assert_eq!(
            item.get("next_retry_at"),
            Some(&JsValue::Number(now + 750.0))
        );
        assert_eq!(
            item.get("first_failed_at"),
            Some(&JsValue::Str(ms_to_iso_string(now)))
        );
    }

    #[test]
    fn record_processed_updates_lru_and_clears_retry() {
        let mut state = create_empty_relayer_state();
        let e = event("neo_n3", "5", "tx5", 2.0, 400.0);
        let now = 1_700_000_000_000.0;
        let mut limits = JsObject::new();
        limits.set("processedCacheSize", JsValue::Number(1.0));
        record_processed_event(
            &mut state,
            "neo_n3",
            &e,
            "fulfilled",
            &JsObject::new(),
            &limits,
            now,
        );
        let e2 = event("neo_n3", "6", "tx6", 3.0, 401.0);
        record_processed_event(
            &mut state,
            "neo_n3",
            &e2,
            "fulfilled",
            &JsObject::new(),
            &limits,
            now,
        );
        let chain_state = state.get("neo_n3").unwrap().as_object().unwrap();
        assert_eq!(
            chain_state
                .get("processed_order")
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            1,
            "LRU evicted the oldest"
        );
        assert!(!has_processed_event(&state, "neo_n3", "neo_n3:5:tx5:2:400"));
        assert!(has_processed_event(&state, "neo_n3", "neo_n3:6:tx6:3:401"));
    }

    #[test]
    fn record_processed_exhausted_dead_letters_with_meta_override() {
        let mut state = create_empty_relayer_state();
        let e = event("neox", "8", "tx8", 0.0, 500.0);
        let now = 1_700_000_000_000.0;
        let mut meta = JsObject::new();
        meta.set("last_error", JsValue::Str("terminal".to_string()));
        let mut limits = JsObject::new();
        limits.set("deadLetterLimit", JsValue::Number(10.0));
        record_processed_event(&mut state, "neox", &e, "exhausted", &meta, &limits, now);
        let letters = state
            .get("neox")
            .unwrap()
            .as_object()
            .unwrap()
            .get("dead_letters")
            .unwrap()
            .as_array()
            .unwrap();
        assert_eq!(letters.len(), 1);
        let letter = letters[0].as_object().unwrap();
        // meta spread AFTER exhausted_at can override it (JS contract).
        assert_eq!(
            letter.get("last_error"),
            Some(&JsValue::Str("terminal".to_string()))
        );
    }

    #[test]
    fn due_retry_items_sorted_stable_by_time() {
        let mut state = create_empty_relayer_state();
        let now = 1_700_000_000_000.0;
        let e1 = event("neo_n3", "1", "t1", 0.0, 1.0);
        let e2 = event("neo_n3", "2", "t2", 0.0, 2.0);
        let mut late = JsObject::new();
        late.set("next_retry_at", JsValue::Number(now - 5000.0));
        let mut early = JsObject::new();
        early.set("next_retry_at", JsValue::Number(now - 9000.0));
        enqueue_retry_item(&mut state, "neo_n3", &e1, &late, now);
        enqueue_retry_item(&mut state, "neo_n3", &e2, &early, now);
        let due = get_due_retry_items(&state, "neo_n3", now);
        let first = due[0].as_object().unwrap().get("event").unwrap();
        assert_eq!(
            first.as_object().unwrap().get("requestId"),
            Some(&JsValue::Str("2".to_string())),
            "earliest next_retry_at first"
        );
        // Future-scheduled items stay hidden.
        assert_eq!(
            get_due_retry_items(&state, "neo_n3", now - 10_000.0).len(),
            0
        );
    }

    #[test]
    fn collect_active_request_ids_dedupes_in_order() {
        let mut state = create_empty_relayer_state();
        let now = 1_700_000_000_000.0;
        enqueue_retry_item(
            &mut state,
            "neo_n3",
            &event("neo_n3", "11", "t", 0.0, 1.0),
            &JsObject::new(),
            now,
        );
        record_processed_event(
            &mut state,
            "neo_n3",
            &event("neo_n3", "22", "t", 0.0, 2.0),
            "fulfilled",
            &JsObject::new(),
            &JsObject::new(),
            now,
        );
        record_processed_event(
            &mut state,
            "neo_n3",
            &event("neo_n3", "11", "t2", 0.0, 3.0),
            "fulfilled",
            &JsObject::new(),
            &JsObject::new(),
            now,
        );
        assert_eq!(
            collect_active_request_ids(&state, "neo_n3"),
            vec!["11", "22"]
        );
    }

    #[test]
    fn normalize_state_file_preserves_extra_metrics_keys() {
        let mut raw = JsObject::new();
        raw.set("version", JsValue::Number(2.0));
        let mut metrics = JsObject::new();
        metrics.set("ticks_total", JsValue::Number(9.0));
        metrics.set("future_counter", JsValue::Number(1.0));
        raw.set("metrics", JsValue::Object(metrics));
        let normalized = normalize_state_file_value(&JsValue::Object(raw));
        let keys: Vec<&str> = normalized
            .get("metrics")
            .unwrap()
            .as_object()
            .unwrap()
            .iter()
            .map(|(k, _)| k)
            .collect();
        // Defaults first (insertion order), loaded extras after.
        assert_eq!(keys[0], "ticks_total");
        assert_eq!(keys[1], "events_scanned_total");
        assert_eq!(keys.last(), Some(&"future_counter"));
        assert_eq!(
            normalized
                .get("metrics")
                .unwrap()
                .as_object()
                .unwrap()
                .get("ticks_total"),
            Some(&JsValue::Number(9.0))
        );
    }

    #[test]
    fn labeled_failures_survive_snapshot_expansion() {
        let mut state = create_empty_relayer_state();
        increment_labeled_failure(&mut state, "neo_n3", "neo", "fulfill", 1.0);
        increment_labeled_failure(&mut state, "neo_n3", "neo", "fulfill", 2.0);
        increment_labeled_failure(&mut state, "neox", "evm", "submit", 1.0);
        let snap = snapshot_metrics(&state, 0.0);
        let labeled = snap.get("labeled_failures").unwrap().as_array().unwrap();
        assert_eq!(labeled.len(), 2);
        let first = labeled[0].as_object().unwrap();
        assert_eq!(
            first.get("chain"),
            Some(&JsValue::Str("neo_n3".to_string()))
        );
        assert_eq!(first.get("value"), Some(&JsValue::Number(3.0)));
    }

    #[test]
    fn snapshot_metrics_key_order_is_contract() {
        let state = create_empty_relayer_state();
        let snap = snapshot_metrics(&state, 0.0);
        let keys: Vec<&str> = snap.iter().map(|(k, _)| k).collect();
        assert_eq!(keys.first(), Some(&"ticks_total"));
        // JS `out.labeled_failures = ...` overwrites the key the metrics
        // spread already carries IN PLACE (insertion order preserved), so the
        // tail is labeled_failures followed by the 6 gauge maps.
        assert_eq!(
            &keys[keys.len() - 7..],
            &[
                "labeled_failures",
                "retry_queue_sizes",
                "dead_letter_sizes",
                "checkpoints",
                "request_checkpoints",
                "oldest_retry_age_seconds",
                "oldest_dead_letter_age_seconds",
            ][..]
        );
    }

    #[test]
    fn number_formatter_used_by_error_paths() {
        // NaN renders 'NaN' in template interpolation, never 'null'.
        assert_eq!(number_to_string(f64::NAN), "NaN");
    }
}
