//! Port of `workers/nitro-worker/src/oracle/feeds/shared.js` — the feed lane's
//! shared constants, boolean coercions and the B9 timestamp clamp that defends
//! the strictly-monotonic MorpheusDataFeed against poisoned future timestamps.

use serde_json::Value as Json;

use crate::core::{normalize_morpheus_network, read_env, resolve_payload_network, EnvReader};
use crate::js::{js_number, js_number_to_string, js_trim, js_trim_string};

pub const DEFAULT_FEED_STATE_PATH: &str = "/data/morpheus-feed-state.json";
pub const MAINNET_FEED_CHANGE_THRESHOLD_BPS: u64 = 10;
pub const MAINNET_FEED_MIN_UPDATE_INTERVAL_MS: u64 = 60_000;
pub const MAINNET_FEED_STALE_AFTER_MS: u64 = 300_000;
pub const DEFAULT_FEED_PROVIDER_TIMEOUT_MS: u64 = 8_000;
pub const MAX_FEED_PROVIDER_TIMEOUT_MS: u64 = 10_000;
pub const DEFAULT_FEED_SUBMISSION_WAIT_TIMEOUT_MS: u64 = 8_000;
pub const FEED_PRICE_DECIMALS: usize = 6;

/// `resolveFeedNetwork(input)` — `resolvePayloadNetwork(input, env-fallback)`.
pub fn resolve_feed_network(input: &Json, env: EnvReader<'_>) -> String {
    let from_env = read_env(env, &["MORPHEUS_NETWORK", "NEXT_PUBLIC_MORPHEUS_NETWORK"]);
    let fallback = normalize_morpheus_network(
        if from_env.is_empty() {
            "testnet"
        } else {
            &from_env
        },
        "testnet",
    );
    resolve_payload_network(input, &fallback)
}

/// `resolveFeedTargetChain()` — every value threaded into it is ignored; the
/// feed lane only ever targets `neo_n3`.
pub fn resolve_feed_target_chain() -> String {
    "neo_n3".to_string()
}

/// `resolveFeedScope(input, fallbackTargetChain)` — `{ network, targetChain }`.
/// The JS signature accepts a `fallbackTargetChain` but
/// `resolveFeedTargetChain` discards it, so the port drops the parameter.
pub struct FeedScope {
    pub network: String,
    pub target_chain: String,
}

pub fn resolve_feed_scope(input: &Json, env: EnvReader<'_>) -> FeedScope {
    FeedScope {
        network: resolve_feed_network(input, env),
        target_chain: resolve_feed_target_chain(),
    }
}

/// `isEnabled(rawValue, fallback = true)` — the token set the feed lane gates
/// env-style flags with ('1'/'true'/'yes'/'on').
pub fn is_enabled(raw_value: &str, fallback: bool) -> bool {
    let normalized = js_trim(raw_value).to_lowercase();
    if normalized.is_empty() {
        return fallback;
    }
    normalized == "1" || normalized == "true" || normalized == "yes" || normalized == "on"
}

/// `normalizeBooleanLike(value, fallback = false)` (feeds/shared.js) — NOT the
/// platform `normalizeBoolean`: booleans pass through, numbers compare
/// `!== 0` (so `2` is true, where the platform helper would say false), and
/// `'on'` is an accepted token.
pub fn normalize_boolean_like(value: Option<&Json>, fallback: bool) -> bool {
    match value {
        None | Some(Json::Null) => fallback,
        Some(Json::String(s)) if s.is_empty() => fallback,
        Some(Json::Bool(flag)) => *flag,
        Some(Json::Number(number)) => number.as_f64().is_none_or(|f| f != 0.0),
        Some(other) => {
            let normalized = js_trim_string(Some(other)).to_lowercase();
            if normalized.is_empty() {
                fallback
            } else {
                normalized == "1"
                    || normalized == "true"
                    || normalized == "yes"
                    || normalized == "on"
            }
        }
    }
}

/// `hasOwnPayloadKey(payload, key)` — `Object.prototype.hasOwnProperty`, so a
/// key holding `null` still counts as present.
pub fn has_own_payload_key(payload: &Json, key: &str) -> bool {
    payload.as_object().is_some_and(|map| map.contains_key(key))
}

// --- B9: feed timestamp clamp (strict-monotonic MorpheusDataFeed protection) ---
//
// MorpheusDataFeed.UpdateFeedInternal enforces `timestamp >= existing.Timestamp`.
// An unbounded upstream provider timestamp that lands far in the future would be
// accepted once, then PERMANENTLY stall the feed. The submission lane rejects
// anything more than ~5 minutes ahead and clamps to
//     max(prevTs + 1, min(upstream, now + skew))
// so it is never more than the skew window ahead of the local clock and is
// always strictly above the last on-chain timestamp.

pub const FEED_TIMESTAMP_MAX_FUTURE_SECONDS: f64 = 300.0; // 5 min hard reject
pub const FEED_TIMESTAMP_FUTURE_SKEW_SECONDS: f64 = 60.0; // tolerated clock-skew clamp window

pub fn resolve_feed_timestamp_max_future_seconds(env: EnvReader<'_>) -> f64 {
    let raw = js_number(&read_env(
        env,
        &["MORPHEUS_FEED_TIMESTAMP_MAX_FUTURE_SECONDS"],
    ));
    if raw.is_finite() && raw > 0.0 {
        raw.floor()
    } else {
        FEED_TIMESTAMP_MAX_FUTURE_SECONDS
    }
}

pub fn resolve_feed_timestamp_future_skew_seconds(env: EnvReader<'_>) -> f64 {
    let raw = js_number(&read_env(
        env,
        &["MORPHEUS_FEED_TIMESTAMP_FUTURE_SKEW_SECONDS"],
    ));
    if raw.is_finite() && raw >= 0.0 {
        raw.floor()
    } else {
        FEED_TIMESTAMP_FUTURE_SKEW_SECONDS
    }
}

/// The JS `FeedTimestampError` (`code: 'feed_timestamp_rejected'`); the code
/// survives as the constant because Rust errors carry no `code` field.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FeedTimestampError {
    pub message: String,
}

impl FeedTimestampError {
    pub const CODE: &'static str = "feed_timestamp_rejected";
}

impl std::fmt::Display for FeedTimestampError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for FeedTimestampError {}

/// `clampFeedTimestampSec({ upstreamSec, prevTs, nowSec, maxFutureSeconds,
/// futureSkewSeconds })`. The JS defaults pull `nowSec` from the wall clock and
/// the two windows from env at the call site; the ported host resolves those
/// explicitly, so all five arguments arrive as finite numbers.
pub fn clamp_feed_timestamp_sec(
    upstream_sec: f64,
    prev_ts: f64,
    now_sec: f64,
    max_future_seconds: f64,
    future_skew_seconds: f64,
) -> Result<f64, FeedTimestampError> {
    let now = now_sec.floor();
    let upstream = if upstream_sec.is_finite() {
        upstream_sec.floor()
    } else {
        now
    };
    let previous = if prev_ts.is_finite() {
        prev_ts.floor().max(0.0)
    } else {
        0.0
    };

    if upstream > now + max_future_seconds {
        return Err(FeedTimestampError {
            message: format!(
                "upstream feed timestamp {} is more than {}s in the future (now {})",
                js_number_to_string(upstream),
                js_number_to_string(max_future_seconds),
                js_number_to_string(now)
            ),
        });
    }

    // Cap a (mildly) future or skewed upstream value to now + skew, never anchor
    // a value the chain would treat as "from the future" beyond the tolerance.
    let capped = upstream.min(now + future_skew_seconds);
    // Enforce strict monotonicity above the last anchored on-chain timestamp.
    Ok((previous + 1.0).max(capped))
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

    #[test]
    fn is_enabled_matches_the_js_token_set() {
        assert!(is_enabled("1", false));
        assert!(is_enabled("true", false));
        assert!(is_enabled("YES", false));
        assert!(is_enabled(" on ", false));
        assert!(is_enabled("", true)); // empty → fallback
        assert!(is_enabled("   ", true)); // whitespace-only trims to empty → fallback
        assert!(!is_enabled("0", true));
    }

    #[test]
    fn normalize_boolean_like_follows_the_type_gates() {
        // nullish and exactly-'' fall back
        assert!(!normalize_boolean_like(None, false));
        assert!(normalize_boolean_like(Some(&Json::Null), true));
        assert!(normalize_boolean_like(Some(&json!("")), true));
        // booleans pass through
        assert!(normalize_boolean_like(Some(&json!(true)), false));
        assert!(!normalize_boolean_like(Some(&json!(false)), true));
        // numbers compare !== 0 — `2` is true here, unlike platform normalizeBoolean
        assert!(!normalize_boolean_like(Some(&json!(0)), true));
        assert!(normalize_boolean_like(Some(&json!(2)), false));
        // strings trim then match the token set; whitespace-only falls back
        assert!(normalize_boolean_like(Some(&json!("on")), false));
        assert!(normalize_boolean_like(Some(&json!("  TRUE  ")), false));
        assert!(normalize_boolean_like(Some(&json!("   ")), true));
        assert!(!normalize_boolean_like(Some(&json!("0")), true));
        // anything else coerces through String() — arrays join first
        assert!(normalize_boolean_like(Some(&json!(["on"])), false));
        assert!(!normalize_boolean_like(Some(&json!(["x"])), true));
    }

    #[test]
    fn has_own_payload_key_is_presence_not_truthiness() {
        let payload = json!({ "a": null, "b": 0 });
        assert!(has_own_payload_key(&payload, "a"));
        assert!(has_own_payload_key(&payload, "b"));
        assert!(!has_own_payload_key(&payload, "c"));
        assert!(!has_own_payload_key(&json!([]), "length"));
    }

    #[test]
    fn resolve_feed_network_prefers_the_payload_then_the_env() {
        let env = env_from(&[("MORPHEUS_NETWORK", "mainnet")]);
        assert_eq!(resolve_feed_network(&json!({}), &env), "mainnet");
        assert_eq!(
            resolve_feed_network(&json!({ "network": "testnet" }), &env),
            "testnet"
        );
        // an unrecognized payload network normalizes into the env fallback
        assert_eq!(
            resolve_feed_network(&json!({ "network": "bogus" }), &env),
            "mainnet"
        );

        let public_env = env_from(&[("NEXT_PUBLIC_MORPHEUS_NETWORK", "mainnet")]);
        assert_eq!(resolve_feed_network(&json!({}), &public_env), "mainnet");

        let empty = env_from(&[]);
        assert_eq!(resolve_feed_network(&json!({}), &empty), "testnet");
    }

    #[test]
    fn resolve_feed_scope_always_targets_neo_n3() {
        let env = env_from(&[("MORPHEUS_NETWORK", "mainnet")]);
        let scope = resolve_feed_scope(&json!({ "target_chain": "neo_x" }), &env);
        assert_eq!(scope.network, "mainnet");
        assert_eq!(scope.target_chain, "neo_n3");
    }

    #[test]
    fn timestamp_windows_read_env_with_js_defaults() {
        assert_eq!(
            resolve_feed_timestamp_max_future_seconds(&env_from(&[(
                "MORPHEUS_FEED_TIMESTAMP_MAX_FUTURE_SECONDS",
                "250"
            )])),
            250.0
        );
        assert_eq!(
            resolve_feed_timestamp_max_future_seconds(&env_from(&[(
                "MORPHEUS_FEED_TIMESTAMP_MAX_FUTURE_SECONDS",
                "90.9"
            )])),
            90.0 // Math.floor
        );
        // '0', negative, and non-numeric all fall back to the 300s default
        assert_eq!(
            resolve_feed_timestamp_max_future_seconds(&env_from(&[(
                "MORPHEUS_FEED_TIMESTAMP_MAX_FUTURE_SECONDS",
                "0"
            )])),
            300.0
        );
        assert_eq!(
            resolve_feed_timestamp_max_future_seconds(&env_from(&[(
                "MORPHEUS_FEED_TIMESTAMP_MAX_FUTURE_SECONDS",
                "abc"
            )])),
            300.0
        );
        assert_eq!(
            resolve_feed_timestamp_max_future_seconds(&env_from(&[])),
            300.0
        );

        // skew accepts 0 but rejects negatives
        assert_eq!(
            resolve_feed_timestamp_future_skew_seconds(&env_from(&[(
                "MORPHEUS_FEED_TIMESTAMP_FUTURE_SKEW_SECONDS",
                "0"
            )])),
            0.0
        );
        assert_eq!(
            resolve_feed_timestamp_future_skew_seconds(&env_from(&[(
                "MORPHEUS_FEED_TIMESTAMP_FUTURE_SKEW_SECONDS",
                "-5"
            )])),
            60.0
        );
    }

    #[test]
    fn clamp_enforces_strict_monotonicity_above_the_previous_timestamp() {
        let now = 1_900_000_000.0;
        // Upstream older than the previous on-chain timestamp must be bumped to prev+1.
        let stale = clamp_feed_timestamp_sec(now - 10_000.0, now - 5.0, now, 300.0, 60.0).unwrap();
        assert_eq!(stale, now - 5.0 + 1.0);

        // A normal in-window upstream passes through unchanged.
        let normal = clamp_feed_timestamp_sec(now - 2.0, now - 100.0, now, 300.0, 60.0).unwrap();
        assert_eq!(normal, now - 2.0);
    }

    #[test]
    fn clamp_caps_a_mildly_future_upstream_to_now_plus_skew() {
        let now = 1_900_000_000.0;
        let clamped = clamp_feed_timestamp_sec(now + 200.0, 0.0, now, 300.0, 60.0).unwrap();
        assert_eq!(clamped, now + 60.0);
    }

    #[test]
    fn clamp_rejects_an_upstream_timestamp_far_in_the_future() {
        let now = 1_900_000_000.0;
        let error = clamp_feed_timestamp_sec(now + 86_400.0, 0.0, now, 300.0, 60.0).unwrap_err();
        assert!(error.message.contains("more than 300s in the future"));
        assert_eq!(FeedTimestampError::CODE, "feed_timestamp_rejected");
    }

    #[test]
    fn clamp_handles_non_finite_inputs_like_the_js_defaults() {
        let now = 1_900_000_000.0;
        // non-finite upstream falls back to `now`
        assert_eq!(
            clamp_feed_timestamp_sec(f64::NAN, 0.0, now, 300.0, 60.0).unwrap(),
            now
        );
        // non-finite prevTs contributes nothing
        assert_eq!(
            clamp_feed_timestamp_sec(now - 2.0, f64::NAN, now, 300.0, 60.0).unwrap(),
            now - 2.0
        );
    }
}
