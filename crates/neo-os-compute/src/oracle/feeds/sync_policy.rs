//! Port of `workers/nitro-worker/src/oracle/feeds/sync-policy.js` — the
//! per-pair submission policy: change thresholds, minimum update intervals,
//! staleness refreshes and the wait/timeout knobs the feed run reads before
//! touching the chain.

use serde_json::{json, Value as Json};

use crate::core::{env_for_network, parse_duration_ms, EnvReader};
use crate::js::{
    js_number, js_number_value, js_stringify, js_to_number, js_trim, js_trim_string, js_truthy,
};
use crate::oracle::decimal::decimal_to_integer_string;
use crate::oracle::feed_registry::get_feed_pair_config;

use super::shared::{
    normalize_boolean_like, resolve_feed_network, resolve_feed_scope,
    DEFAULT_FEED_SUBMISSION_WAIT_TIMEOUT_MS, MAINNET_FEED_CHANGE_THRESHOLD_BPS,
    MAINNET_FEED_MIN_UPDATE_INTERVAL_MS, MAINNET_FEED_STALE_AFTER_MS,
};

/// `??` semantics over a JSON value: absent and `null` are both nullish.
fn non_null(value: Option<&Json>) -> Option<&Json> {
    value.filter(|v| !v.is_null())
}

/// `resolvePairThresholdBps(storagePair, payload)` — the first non-nullish of
/// the registry's `threshold_bps` / `feed_change_threshold_bps`, the payload's
/// pair-level override, and the by-pair map; `''` and non-finite values
/// resolve to `None`, everything else clamps at 0.
pub fn resolve_pair_threshold_bps(
    storage_pair: &str,
    payload: &Json,
    env: EnvReader<'_>,
) -> Option<f64> {
    let config = get_feed_pair_config(storage_pair, env);
    let raw = config
        .as_ref()
        .and_then(|config| {
            non_null(config.get("threshold_bps"))
                .or_else(|| non_null(config.get("feed_change_threshold_bps")))
        })
        .or_else(|| non_null(payload.get("pair_feed_change_threshold_bps")))
        .or_else(|| {
            non_null(
                payload
                    .get("feed_change_threshold_bps_by_pair")
                    .and_then(|by_pair| by_pair.get(storage_pair)),
            )
        });
    let raw = raw?;
    if matches!(raw, Json::String(s) if s.is_empty()) {
        return None;
    }
    let parsed = js_to_number(raw);
    if !parsed.is_finite() {
        return None;
    }
    Some(parsed.max(0.0))
}

/// `{ thresholdBps, minUpdateIntervalMs, staleAfterMs }` with the JS key order
/// preserved by [`SyncPolicy::to_json`].
#[derive(Debug, Clone, PartialEq)]
pub struct SyncPolicy {
    pub threshold_bps: f64,
    pub min_update_interval_ms: u64,
    pub stale_after_ms: u64,
}

impl SyncPolicy {
    pub fn to_json(&self) -> Json {
        json!({
            "thresholdBps": js_number_value(self.threshold_bps),
            "minUpdateIntervalMs": js_number_value(self.min_update_interval_ms as f64),
            "staleAfterMs": js_number_value(self.stale_after_ms as f64),
        })
    }
}

/// `payload.X ?? envForNetwork(network, NAME)` — a payload `null`/absent falls
/// through to the env string, but a payload `''` (or `0`, or `false`) is kept:
/// only nullish values are skipped by `??`.
fn payload_candidate(payload: &Json, key: &str, env_value: String) -> Json {
    match non_null(payload.get(key)) {
        Some(value) => value.clone(),
        None => Json::String(env_value),
    }
}

/// The `candidate === '' || candidate === undefined || candidate === null`
/// guard swaps the empty candidate for the JS string default.
fn source_or_default(candidate: Json, default: &str) -> Json {
    match candidate {
        Json::String(ref s) if s.is_empty() => Json::String(default.to_string()),
        Json::Null => Json::String(default.to_string()),
        other => other,
    }
}

/// `buildSyncPolicy(targetChain, payload)` — threshold candidates resolve
/// through `Number(source || 0)` (so a truthy non-numeric string becomes NaN
/// → 0, and a falsy source becomes 0). The JS `targetChain` argument is
/// threaded into `resolveFeedScope` and then ignored, so the port keeps the
/// parameter only for call-site parity.
pub fn build_sync_policy(_target_chain: &str, payload: &Json, env: EnvReader<'_>) -> SyncPolicy {
    let network = resolve_feed_scope(payload, env).network;
    let threshold_candidate = payload_candidate(
        payload,
        "feed_change_threshold_bps",
        env_for_network(&network, &["MORPHEUS_FEED_CHANGE_THRESHOLD_BPS"], env),
    );
    let interval_candidate = payload_candidate(
        payload,
        "feed_min_update_interval_ms",
        env_for_network(&network, &["MORPHEUS_FEED_MIN_UPDATE_INTERVAL_MS"], env),
    );
    let stale_candidate = payload_candidate(
        payload,
        "feed_stale_after_ms",
        env_for_network(&network, &["MORPHEUS_FEED_STALE_AFTER_MS"], env),
    );
    let threshold_source = source_or_default(
        threshold_candidate,
        &MAINNET_FEED_CHANGE_THRESHOLD_BPS.to_string(),
    );
    let interval_source = source_or_default(
        interval_candidate,
        &format!("{MAINNET_FEED_MIN_UPDATE_INTERVAL_MS}ms"),
    );
    let stale_source =
        source_or_default(stale_candidate, &format!("{MAINNET_FEED_STALE_AFTER_MS}ms"));

    let threshold_number = js_to_number(&if js_truthy(&threshold_source) {
        threshold_source
    } else {
        json!(0)
    });
    let threshold_bps = if threshold_number.is_finite() {
        threshold_number.max(0.0)
    } else {
        0.0
    };
    SyncPolicy {
        threshold_bps,
        min_update_interval_ms: parse_duration_ms(
            Some(&interval_source),
            MAINNET_FEED_MIN_UPDATE_INTERVAL_MS,
        ),
        stale_after_ms: parse_duration_ms(Some(&stale_source), MAINNET_FEED_STALE_AFTER_MS),
    }
}

pub fn resolve_feed_submission_wait(payload: &Json) -> bool {
    normalize_boolean_like(payload.get("wait"), false)
}

pub fn resolve_feed_submission_wait_timeout_ms(payload: &Json, env: EnvReader<'_>) -> u64 {
    let network = resolve_feed_network(payload, env);
    let source = non_null(payload.get("timeout_ms"))
        .or_else(|| non_null(payload.get("timeoutMs")))
        .or_else(|| non_null(payload.get("feed_submission_wait_timeout_ms")))
        .or_else(|| non_null(payload.get("feedSubmissionWaitTimeoutMs")))
        .cloned()
        .unwrap_or_else(|| {
            Json::String(env_for_network(
                &network,
                &["MORPHEUS_FEED_SUBMISSION_WAIT_TIMEOUT_MS"],
                env,
            ))
        });
    parse_duration_ms(Some(&source), DEFAULT_FEED_SUBMISSION_WAIT_TIMEOUT_MS)
        .min(DEFAULT_FEED_SUBMISSION_WAIT_TIMEOUT_MS)
}

/// `resolveFeedSubmissionIssue(targetChain, { hasNeoN3DataFeedTarget, neoContext })`
/// — `neoContext` is collapsed to its `rpcUrl`; `None` means no context at all.
pub fn resolve_feed_submission_issue(
    target_chain: &str,
    has_neo_n3_data_feed_target: bool,
    neo_context_rpc_url: Option<&str>,
) -> String {
    if target_chain == "neo_n3" {
        if !has_neo_n3_data_feed_target {
            return "Neo N3 datafeed contract hash is not configured".to_string();
        }
        let Some(rpc_url) = neo_context_rpc_url else {
            return "Neo N3 signing key is not configured".to_string();
        };
        if js_trim(rpc_url).is_empty() {
            return "NEO_RPC_URL is required for Neo N3 feed submission".to_string();
        }
    }
    String::new()
}

/// `shouldLoadOnchainFeedBaseline(payload, state)` — an explicit
/// `refresh_onchain_baseline`/`refreshOnchainBaseline` (present, non-null and
/// non-empty) wins; otherwise load when forced or when local records are empty.
pub fn should_load_onchain_feed_baseline(payload: &Json, state: &Json) -> bool {
    let has_local_records = state
        .get("records")
        .and_then(Json::as_object)
        .is_some_and(|map| !map.is_empty());
    let explicit_refresh = non_null(payload.get("refresh_onchain_baseline"))
        .or_else(|| non_null(payload.get("refreshOnchainBaseline")));
    if let Some(value) = explicit_refresh {
        if !matches!(value, Json::String(s) if s.is_empty()) {
            return normalize_boolean_like(Some(value), false);
        }
    }
    js_truthy(payload.get("force").unwrap_or(&Json::Null)) || !has_local_records
}

/// `computeChangeBps` — `+Infinity` when either side is non-finite or the
/// previous price is not positive.
fn compute_change_bps(previous_price: &str, next_price: &str) -> f64 {
    let previous = js_number(previous_price);
    let next = js_number(next_price);
    if !previous.is_finite() || !next.is_finite() || previous <= 0.0 {
        return f64::INFINITY;
    }
    ((next - previous) / previous).abs() * 10_000.0
}

/// `Date.parse` for the ISO-8601 shapes feed records carry. The enclave runs
/// UTC, so local-time forms and `Z` forms coincide. Anything the JS grammar
/// would return NaN for returns `None`. Date-only forms are UTC midnight; day
/// values are NOT month-length validated (JS rolls `2020-02-31` into March).
fn date_parse_ms(raw: &str) -> Option<f64> {
    let bytes = raw.as_bytes();
    if bytes.len() < 10 {
        return None;
    }
    let year: i64 = raw.get(0..4)?.parse().ok()?;
    if bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let month: i64 = raw.get(5..7)?.parse().ok()?;
    let day: i64 = raw.get(8..10)?.parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }

    let mut hours = 0i64;
    let mut minutes = 0i64;
    let mut seconds = 0i64;
    let mut millis = 0f64;
    let mut tz_offset_seconds = 0i64;
    let mut rest = &raw[10..];
    if !rest.is_empty() {
        let separator = rest.as_bytes()[0];
        if separator != b'T' && separator != b't' && separator != b' ' {
            return None;
        }
        rest = &rest[1..];
        if rest.len() < 5 || rest.as_bytes()[2] != b':' {
            return None;
        }
        hours = rest.get(0..2)?.parse().ok()?;
        minutes = rest.get(3..5)?.parse().ok()?;
        rest = &rest[5..];
        if rest.starts_with(':') {
            rest = &rest[1..];
            seconds = rest.get(0..2)?.parse().ok()?;
            rest = &rest[2..];
            if rest.starts_with('.') {
                let digits_end = rest[1..]
                    .find(|c: char| !c.is_ascii_digit())
                    .map_or(rest.len(), |index| index + 1);
                let digits = &rest[1..digits_end];
                if digits.is_empty() {
                    return None;
                }
                // milliseconds truncate to 3 digits, right-padded (JS: '.1' → 100ms)
                let mut millis_text: String = digits.chars().take(3).collect();
                while millis_text.len() < 3 {
                    millis_text.push('0');
                }
                millis = millis_text.parse::<f64>().unwrap_or(0.0);
                rest = &rest[digits_end..];
            }
        }
        match rest.as_bytes().first() {
            None => {}
            Some(b'Z') | Some(b'z') if rest.len() == 1 => {}
            Some(b'+') | Some(b'-') => {
                let negative = rest.as_bytes()[0] == b'-';
                let offset = &rest[1..];
                let (offset_hours, offset_minutes) = match offset.len() {
                    5 if offset.as_bytes()[2] == b':' => (
                        offset.get(0..2)?.parse::<i64>().ok()?,
                        offset.get(3..5)?.parse::<i64>().ok()?,
                    ),
                    4 => (
                        offset.get(0..2)?.parse::<i64>().ok()?,
                        offset.get(2..4)?.parse::<i64>().ok()?,
                    ),
                    2 => (offset.parse::<i64>().ok()?, 0),
                    _ => return None,
                };
                let magnitude = offset_hours * 3600 + offset_minutes * 60;
                tz_offset_seconds = if negative { -magnitude } else { magnitude };
            }
            _ => return None,
        }
        if hours > 24 || minutes > 59 || seconds > 60 {
            return None;
        }
    }

    let days = days_from_civil(year, month, day);
    let epoch_seconds = days * 86_400 + hours * 3_600 + minutes * 60 + seconds - tz_offset_seconds;
    Some(epoch_seconds as f64 * 1000.0 + millis)
}

/// Howard Hinnant's `days_from_civil` — proleptic Gregorian days since epoch.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let years = if month <= 2 { year - 1 } else { year };
    let era = if years >= 0 { years } else { years - 399 } / 400;
    let year_of_era = years - era * 400;
    let day_of_year = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// `normalizeTimestampMs(value)` — `undefined`/`null`/`''` → 0; finite numbers
/// below the 10s-of-seconds cutoff are seconds and get ×1000; strings try
/// `Number` first and `Date.parse` second.
fn normalize_timestamp_ms(value: Option<&Json>) -> f64 {
    let Some(value) = value else {
        return 0.0;
    };
    if value.is_null() {
        return 0.0;
    }
    if let Json::String(s) = value {
        if s.is_empty() {
            return 0.0;
        }
    }
    if let Json::Number(number) = value {
        let Some(finite) = number.as_f64() else {
            return 0.0;
        };
        return if finite > 10_000_000_000.0 {
            finite
        } else {
            finite * 1000.0
        };
    }
    let raw = js_trim_string(Some(value));
    if raw.is_empty() {
        return 0.0;
    }
    let numeric = js_number(&raw);
    if numeric.is_finite() {
        return if numeric > 10_000_000_000.0 {
            numeric
        } else {
            numeric * 1000.0
        };
    }
    date_parse_ms(&raw).unwrap_or(0.0)
}

/// `resolvePreviousSubmittedAtMs(previousRecord)` — the first candidate above
/// zero from `last_submitted_at_ms`, `submitted_at_ms`, `timestamp_ms`,
/// `timestamp`, `submitted_at`.
fn resolve_previous_submitted_at_ms(previous_record: &Json) -> f64 {
    for key in [
        "last_submitted_at_ms",
        "submitted_at_ms",
        "timestamp_ms",
        "timestamp",
        "submitted_at",
    ] {
        let timestamp_ms = normalize_timestamp_ms(previous_record.get(key));
        if timestamp_ms > 0.0 {
            return timestamp_ms;
        }
    }
    0.0
}

/// `shouldSubmitFeed(storageKey, quote, previousRecord, policy, force)` with
/// `Date.now()` injected as `now_ms`. The decision object key order mirrors the
/// JS literals; `change_bps` of `+Infinity` serializes as `null`
/// (`JSON.stringify(Infinity)`), which [`js_number_value`] already does.
pub fn should_submit_feed(
    storage_key: &str,
    quote: &Json,
    previous_record: Option<&Json>,
    policy: &SyncPolicy,
    force: bool,
    now_ms: f64,
) -> Result<Json, String> {
    if force {
        return Ok(json!({ "allow": true, "reason": "forced" }));
    }
    let Some(record) = previous_record.filter(|record| js_truthy(record)) else {
        return Ok(json!({ "allow": true, "reason": "first-observation" }));
    };

    let last_submitted_at = normalize_timestamp_ms(record.get("last_submitted_at_ms"));
    if policy.min_update_interval_ms > 0
        && last_submitted_at > 0.0
        && now_ms - last_submitted_at < policy.min_update_interval_ms as f64
    {
        return Ok(json!({
            "allow": false,
            "reason": "min-update-interval",
            "storage_key": storage_key,
        }));
    }

    let quote_decimals = quote.get("decimals").map(js_to_number).unwrap_or(f64::NAN);
    if !quote_decimals.is_finite() || quote_decimals < 0.0 {
        return Err(format!(
            "invalid decimals: {}",
            crate::js::js_number_to_string(quote_decimals)
        ));
    }
    let quote_decimals = quote_decimals as usize;

    let previous_price_units =
        match non_null(record.get("price_units")).or_else(|| non_null(record.get("price_cents"))) {
            Some(units) => js_stringify(units),
            None => {
                let price_raw = non_null(record.get("price"))
                    .map(js_stringify)
                    .unwrap_or_else(|| "0".to_string());
                decimal_to_integer_string(&price_raw, quote_decimals)?
            }
        };
    let next_price_units = decimal_to_integer_string(
        &js_stringify(quote.get("price").unwrap_or(&Json::Null)),
        quote_decimals,
    )?;
    let change_bps = compute_change_bps(&previous_price_units, &next_price_units);
    let previous_submitted_at_ms = resolve_previous_submitted_at_ms(record);
    let stale_age_ms = if previous_submitted_at_ms > 0.0 {
        now_ms - previous_submitted_at_ms
    } else {
        0.0
    };

    if policy.stale_after_ms > 0 && stale_age_ms >= policy.stale_after_ms as f64 {
        return Ok(json!({
            "allow": true,
            "reason": "stale-refresh",
            "stale_age_ms": js_number_value(stale_age_ms),
            "stale_after_ms": js_number_value(policy.stale_after_ms as f64),
            "change_bps": js_number_value(change_bps),
            "comparison_basis": "current-chain-price",
            "current_chain_price_units": previous_price_units,
            "candidate_price_units": next_price_units,
            "storage_key": storage_key,
        }));
    }

    if policy.threshold_bps > 0.0 && change_bps < policy.threshold_bps {
        return Ok(json!({
            "allow": false,
            "reason": "price-change-below-threshold",
            "change_bps": js_number_value(change_bps),
            "comparison_basis": "current-chain-price",
            "current_chain_price_units": previous_price_units,
            "candidate_price_units": next_price_units,
            "storage_key": storage_key,
        }));
    }

    Ok(json!({
        "allow": true,
        "reason": "threshold-met",
        "change_bps": js_number_value(change_bps),
        "comparison_basis": "current-chain-price",
        "current_chain_price_units": previous_price_units,
        "candidate_price_units": next_price_units,
        "storage_key": storage_key,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::HashMap;

    fn env_from(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        move |name| map.get(name).cloned()
    }

    fn policy(threshold_bps: f64, min_update_interval_ms: u64, stale_after_ms: u64) -> SyncPolicy {
        SyncPolicy {
            threshold_bps,
            min_update_interval_ms,
            stale_after_ms,
        }
    }

    #[test]
    fn pair_specific_threshold_overrides_the_global_feed_threshold() {
        let env = env_from(&[(
            "MORPHEUS_FEED_PAIR_REGISTRY_JSON",
            r#"{"NEO-USD":{"threshold_bps":5}}"#,
        )]);
        assert_eq!(
            resolve_pair_threshold_bps(
                "TWELVEDATA:NEO-USD",
                &json!({ "network": "mainnet" }),
                &env
            ),
            Some(5.0)
        );
    }

    #[test]
    fn threshold_resolution_skips_nullish_and_empty_but_not_zero() {
        let empty = env_from(&[]);
        // no override anywhere → None
        assert_eq!(
            resolve_pair_threshold_bps("TWELVEDATA:NEO-USD", &json!({}), &empty),
            None
        );
        // '' resolves to null, but 0 survives (?? keeps non-nullish falsy values)
        assert_eq!(
            resolve_pair_threshold_bps(
                "TWELVEDATA:NEO-USD",
                &json!({ "pair_feed_change_threshold_bps": "" }),
                &empty
            ),
            None
        );
        assert_eq!(
            resolve_pair_threshold_bps(
                "TWELVEDATA:NEO-USD",
                &json!({ "pair_feed_change_threshold_bps": 0 }),
                &empty
            ),
            Some(0.0)
        );
        // the by-pair map is consulted last
        assert_eq!(
            resolve_pair_threshold_bps(
                "TWELVEDATA:GAS-USD",
                &json!({ "feed_change_threshold_bps_by_pair": { "TWELVEDATA:GAS-USD": 42 } }),
                &empty
            ),
            Some(42.0)
        );
        // non-numeric overrides resolve to null
        assert_eq!(
            resolve_pair_threshold_bps(
                "TWELVEDATA:NEO-USD",
                &json!({ "pair_feed_change_threshold_bps": "abc" }),
                &empty
            ),
            None
        );
        // negative values clamp at 0
        assert_eq!(
            resolve_pair_threshold_bps(
                "TWELVEDATA:NEO-USD",
                &json!({ "pair_feed_change_threshold_bps": -5 }),
                &empty
            ),
            Some(0.0)
        );
    }

    #[test]
    fn default_feed_sync_policy_checks_once_per_minute_with_a_0_1_percent_threshold() {
        let built = build_sync_policy("neo_n3", &json!({ "network": "mainnet" }), &env_from(&[]));
        assert_eq!(built.threshold_bps, 10.0);
        assert_eq!(built.min_update_interval_ms, 60_000);
        assert_eq!(built.stale_after_ms, 300_000);
        assert_eq!(
            built.to_json(),
            json!({ "thresholdBps": 10, "minUpdateIntervalMs": 60000, "staleAfterMs": 300000 })
        );
    }

    #[test]
    fn sync_policy_reads_network_scoped_env_and_payload_candidates() {
        // network-scoped env beats the payload-less default
        let env = env_from(&[("MORPHEUS_FEED_CHANGE_THRESHOLD_BPS_MAINNET", "25")]);
        let built = build_sync_policy("neo_n3", &json!({ "network": "mainnet" }), &env);
        assert_eq!(built.threshold_bps, 25.0);

        // a payload value beats env
        let built = build_sync_policy(
            "neo_n3",
            &json!({ "network": "mainnet", "feed_change_threshold_bps": 7 }),
            &env,
        );
        assert_eq!(built.threshold_bps, 7.0);

        // a payload '' is NOT nullish — it wins the ?? chain, hits the
        // `=== ''` default, and the env value is never consulted
        let built = build_sync_policy(
            "neo_n3",
            &json!({ "network": "mainnet", "feed_change_threshold_bps": "" }),
            &env,
        );
        assert_eq!(built.threshold_bps, 10.0);

        // a payload 0 survives ?? and Number(0 || 0) → 0
        let built = build_sync_policy(
            "neo_n3",
            &json!({ "network": "mainnet", "feed_change_threshold_bps": 0 }),
            &env,
        );
        assert_eq!(built.threshold_bps, 0.0);

        // intervals parse through parseDurationMs ('90s' → 90000)
        let built = build_sync_policy(
            "neo_n3",
            &json!({ "network": "mainnet", "feed_min_update_interval_ms": "90s" }),
            &env,
        );
        assert_eq!(built.min_update_interval_ms, 90_000);
    }

    #[test]
    fn feed_publication_submits_asynchronously_by_default_and_caps_explicit_waits() {
        assert!(!resolve_feed_submission_wait(&json!({})));
        assert!(!resolve_feed_submission_wait(&json!({ "wait": false })));
        assert!(resolve_feed_submission_wait(&json!({ "wait": "true" })));

        let empty = env_from(&[]);
        assert_eq!(
            resolve_feed_submission_wait_timeout_ms(&json!({}), &empty),
            8_000
        );
        assert_eq!(
            resolve_feed_submission_wait_timeout_ms(&json!({ "timeout_ms": "2500" }), &empty),
            2_500
        );
        assert_eq!(
            resolve_feed_submission_wait_timeout_ms(&json!({ "timeout_ms": "30s" }), &empty),
            8_000
        );
        // camelCase and dedicated keys participate in the same ?? chain
        assert_eq!(
            resolve_feed_submission_wait_timeout_ms(&json!({ "timeoutMs": 1_500 }), &empty),
            1_500
        );
    }

    #[test]
    fn feed_baseline_uses_local_state_unless_a_refresh_is_required() {
        let empty = json!({});
        let populated =
            json!({ "records": { "TWELVEDATA:NEO-USD": { "price_units": "2694000" } } });
        assert!(should_load_onchain_feed_baseline(
            &empty,
            &json!({ "records": {} })
        ));
        assert!(!should_load_onchain_feed_baseline(&empty, &populated));
        assert!(should_load_onchain_feed_baseline(
            &json!({ "force": true }),
            &populated
        ));
        assert!(should_load_onchain_feed_baseline(
            &json!({ "refresh_onchain_baseline": "true" }),
            &populated
        ));
        // an explicit '' is skipped (=== '' guard) and the local baseline wins
        assert!(!should_load_onchain_feed_baseline(
            &json!({ "refresh_onchain_baseline": "" }),
            &populated
        ));
        // camelCase alias and a false refresh both work
        assert!(should_load_onchain_feed_baseline(
            &json!({ "refreshOnchainBaseline": "on" }),
            &populated
        ));
        assert!(!should_load_onchain_feed_baseline(
            &json!({ "refresh_onchain_baseline": false }),
            &populated
        ));
    }

    #[test]
    fn feed_submission_only_allows_pairs_whose_price_changed_by_at_least_0_1_percent() {
        let sync_policy = policy(10.0, 60_000, 300_000);
        let now = 1_900_000_000_000.0;
        let previous_record = json!({
            "price_units": "100000000",
            "last_submitted_at_ms": now - 120_000.0,
        });
        let quote = json!({ "price": "100.05", "decimals": 6 });

        assert_eq!(
            should_submit_feed(
                "TWELVEDATA:NEO-USD",
                &quote,
                Some(&previous_record),
                &sync_policy,
                false,
                now
            )
            .unwrap(),
            json!({
                "allow": false,
                "reason": "price-change-below-threshold",
                "change_bps": 5,
                "comparison_basis": "current-chain-price",
                "current_chain_price_units": "100000000",
                "candidate_price_units": "100050000",
                "storage_key": "TWELVEDATA:NEO-USD",
            })
        );

        let changed_quote = json!({ "price": "100.10", "decimals": 6 });
        let decision = should_submit_feed(
            "TWELVEDATA:NEO-USD",
            &changed_quote,
            Some(&previous_record),
            &sync_policy,
            false,
            now,
        )
        .unwrap();
        assert_eq!(decision["allow"], json!(true));
        assert_eq!(decision["reason"], json!("threshold-met"));
    }

    #[test]
    fn feed_submission_refreshes_stale_on_chain_timestamps_even_below_the_price_threshold() {
        let sync_policy = policy(10.0, 60_000, 300_000);
        let now: f64 = 1_900_000_000_000.0;
        let previous_record = json!({
            "price_units": "100000000",
            "timestamp": format!("{}", ((now - 600_000.0) / 1000.0).floor() as i64),
        });
        let quote = json!({ "price": "100.05", "decimals": 6 });

        let decision = should_submit_feed(
            "TWELVEDATA:USDT-USD",
            &quote,
            Some(&previous_record),
            &sync_policy,
            false,
            now,
        )
        .unwrap();
        assert_eq!(decision["allow"], json!(true));
        assert_eq!(decision["reason"], json!("stale-refresh"));
        assert!(decision["stale_age_ms"].as_f64().unwrap() >= 300_000.0);
        assert_eq!(decision["stale_after_ms"], json!(300_000));
        assert_eq!(decision["change_bps"], json!(5));
        assert_eq!(decision["comparison_basis"], json!("current-chain-price"));
        assert_eq!(decision["current_chain_price_units"], json!("100000000"));
        assert_eq!(decision["candidate_price_units"], json!("100050000"));
        assert_eq!(decision["storage_key"], json!("TWELVEDATA:USDT-USD"));
    }

    #[test]
    fn feed_submission_honors_the_minimum_update_interval_and_force() {
        let sync_policy = policy(10.0, 60_000, 300_000);
        let now = 1_900_000_000_000.0;
        let previous_record = json!({
            "price_units": "100000000",
            "last_submitted_at_ms": now - 30_000.0,
        });
        let quote = json!({ "price": "200.00", "decimals": 6 });

        assert_eq!(
            should_submit_feed(
                "TWELVEDATA:NEO-USD",
                &quote,
                Some(&previous_record),
                &sync_policy,
                false,
                now
            )
            .unwrap(),
            json!({
                "allow": false,
                "reason": "min-update-interval",
                "storage_key": "TWELVEDATA:NEO-USD",
            })
        );

        // force short-circuits before the record is even looked at
        assert_eq!(
            should_submit_feed("TWELVEDATA:NEO-USD", &quote, None, &sync_policy, true, now)
                .unwrap(),
            json!({ "allow": true, "reason": "forced" })
        );
        // a falsy record counts as a first observation
        assert_eq!(
            should_submit_feed(
                "TWELVEDATA:NEO-USD",
                &quote,
                Some(&Json::Null),
                &sync_policy,
                false,
                now
            )
            .unwrap(),
            json!({ "allow": true, "reason": "first-observation" })
        );
    }

    #[test]
    fn timestamp_normalization_supports_seconds_millis_and_iso_dates() {
        assert_eq!(normalize_timestamp_ms(None), 0.0);
        assert_eq!(normalize_timestamp_ms(Some(&Json::Null)), 0.0);
        assert_eq!(normalize_timestamp_ms(Some(&json!(""))), 0.0);
        assert_eq!(normalize_timestamp_ms(Some(&json!("   "))), 0.0);
        // seconds below the 1e10 cutoff scale to millis
        assert_eq!(
            normalize_timestamp_ms(Some(&json!(1_900_000_000i64))),
            1_900_000_000_000.0
        );
        assert_eq!(
            normalize_timestamp_ms(Some(&json!("1900000000"))),
            1_900_000_000_000.0
        );
        // values above the cutoff pass through as millis
        assert_eq!(
            normalize_timestamp_ms(Some(&json!(1_900_000_000_000i64))),
            1_900_000_000_000.0
        );
        assert_eq!(
            normalize_timestamp_ms(Some(&json!("1900000000000"))),
            1_900_000_000_000.0
        );
        // ISO date strings parse; unparseable strings are 0
        assert_eq!(
            date_parse_ms("2026-03-11T12:00:00Z"),
            Some(1_773_230_400_000.0)
        );
        assert_eq!(
            date_parse_ms("2020-02-31"),
            Some(1_583_107_200_000.0) // rolls into Mar 2, like JS
        );
        assert_eq!(
            date_parse_ms("2026-03-11T12:00:00+02:00"),
            Some(1_773_223_200_000.0)
        );
        assert_eq!(date_parse_ms("not a date"), None);
        assert_eq!(
            normalize_timestamp_ms(Some(&json!("2026-03-11T12:00:00Z"))),
            1_773_230_400_000.0
        );
        assert_eq!(normalize_timestamp_ms(Some(&json!("zzz"))), 0.0);
    }

    #[test]
    fn submission_issue_messages_match_the_js_strings() {
        assert_eq!(
            resolve_feed_submission_issue("neo_n3", false, None),
            "Neo N3 datafeed contract hash is not configured"
        );
        assert_eq!(
            resolve_feed_submission_issue("neo_n3", true, None),
            "Neo N3 signing key is not configured"
        );
        assert_eq!(
            resolve_feed_submission_issue("neo_n3", true, Some("   ")),
            "NEO_RPC_URL is required for Neo N3 feed submission"
        );
        assert_eq!(
            resolve_feed_submission_issue("neo_n3", true, Some("rpc")),
            ""
        );
        assert_eq!(resolve_feed_submission_issue("neo_x", false, None), "");
    }
}
