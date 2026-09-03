//! Port of `workers/nitro-worker/src/oracle/feed-registry.js` — the feed pair
//! registry: the default pair set with per-provider symbols, JSON overrides
//! deep-merged over it, and the per-pair config accessors the sync policy and
//! provider dispatch read through.
//!
//! The JS module memoizes the merged registry on the raw override string; the
//! port drops the cache — every getter is a pure function of the injected
//! [`EnvReader`], so env-mutating tests never need cache resets.

use std::sync::OnceLock;

use serde_json::{json, Value as Json};

use crate::core::EnvReader;
use crate::js::{js_to_number, js_trim, js_trim_string, js_truthy};
use crate::oracle::normalize_provider_id;

/// `FEED_PAIR_ALIASES` — legacy symbols remapped before any lookup.
pub const FEED_PAIR_ALIASES: [(&str, &str); 1] = [("OIL-USD", "WTI-USD")];

/// `KNOWN_FEED_PROVIDER_PREFIXES` — storage-pair prefixes stripped before
/// registry lookups.
pub const KNOWN_FEED_PROVIDER_PREFIXES: [&str; 3] =
    ["TWELVEDATA:", "BINANCE-SPOT:", "COINBASE-SPOT:"];

/// `RETIRED_FEED_PAIRS` — pairs retired from every active registry, with the
/// reason. Mirrors `RETIRED_FEED_PAIRS` in `deploy/feed-pusher/feed-pusher.mjs`
/// and `apps/web/lib/feed-defaults.ts`; `scripts/check-feed-pair-registries.mjs`
/// fails if a retired pair reappears in the default set or the lists disagree.
///
/// A pair that cannot be sourced correctly must be retired here rather than
/// left in the defaults to age forever: a permanently stale advertised pair is
/// what made the feed health signal meaningless.
pub fn retired_feed_pairs() -> &'static Json {
    static PAIRS: OnceLock<Json> = OnceLock::new();
    PAIRS.get_or_init(|| {
        json!({
            "COPPER-USD": "twelvedata HG1 resolves to Homag Group AG (FSX, EUR), not copper; correct copper needs exchange=Forex plus an on-chain reset",
            "FLM-USD": "twelvedata FLM/USD is FolmCoin, not Flamingo Finance; no Flamingo listing exists on this provider",
            "1000FLM-USD": "legacy scaled variant, last written 2026-03-11, superseded and unsourceable (see FLM-USD)",
            "1000JPY-USD": "legacy scaled variant, last written 2026-03-11, superseded by JPY-USD",
        })
    })
}

/// `DEFAULT_FEED_PAIRS` — the pairs this worker knows how to quote. Must name
/// the same set as `DEFAULT_FEED_BASE_SYMBOLS` in `apps/web/lib/feed-defaults.ts`
/// and `TD_SYMBOLS` in `deploy/feed-pusher/feed-pusher.mjs`. Where a provider
/// symbol here differs from the pusher's, the difference must be explained by
/// an explicit `price_transform` (JPY-USD is fetched as USD/JPY and inverted
/// here, and as JPY/USD directly by the pusher — the same instrument either way).
pub fn default_feed_pairs() -> &'static Json {
    static PAIRS: OnceLock<Json> = OnceLock::new();
    PAIRS.get_or_init(|| {
        json!({
            "NEO-USD": {
                "providers": {
                    "twelvedata": { "symbol": "NEO/USD" },
                    "binance-spot": { "symbol": "NEOUSDT" },
                },
            },
            "GAS-USD": {
                "providers": {
                    "twelvedata": { "symbol": "GAS/USD" },
                    "binance-spot": { "symbol": "GASUSDT" },
                },
            },
            "BTC-USD": {
                "providers": { "twelvedata": { "symbol": "BTC/USD" } },
            },
            "ETH-USD": {
                "providers": { "twelvedata": { "symbol": "ETH/USD" } },
            },
            "SOL-USD": {
                "providers": { "twelvedata": { "symbol": "SOL/USD" } },
            },
            "TRX-USD": {
                "providers": { "twelvedata": { "symbol": "TRX/USD" } },
            },
            "PAXG-USD": {
                "providers": { "twelvedata": { "symbol": "PAXG/USD" } },
            },
            "WTI-USD": {
                "providers": { "twelvedata": { "symbol": "WTI/USD" } },
            },
            "BRENT-USD": {
                "providers": { "twelvedata": { "symbol": "XBR/USD" } },
            },
            "NATGAS-USD": {
                "providers": { "twelvedata": { "symbol": "NG/USD" } },
            },
            "WHEAT-USD": {
                "providers": { "twelvedata": { "symbol": "W_1" } },
            },
            "CORN-USD": {
                // C_1 is CBOT corn futures (US cents/bushel). The bare ticker
                // CORN is the Teucrium Corn Fund ETF — a different asset an
                // order of magnitude apart.
                "providers": { "twelvedata": { "symbol": "C_1" } },
            },
            "SOY-USD": {
                "providers": { "twelvedata": { "symbol": "S_1" } },
            },
            "USDT-USD": {
                "providers": { "twelvedata": { "symbol": "USDT/USD" } },
            },
            "USDC-USD": {
                "providers": { "twelvedata": { "symbol": "USDC/USD" } },
            },
            "BNB-USD": {
                "providers": { "twelvedata": { "symbol": "BNB/USD" } },
            },
            "XRP-USD": {
                "providers": { "twelvedata": { "symbol": "XRP/USD" } },
            },
            "DOGE-USD": {
                "providers": { "twelvedata": { "symbol": "DOGE/USD" } },
            },
            "AAPL-USD": {
                "providers": { "twelvedata": { "symbol": "AAPL" } },
            },
            "GOOGL-USD": {
                "providers": { "twelvedata": { "symbol": "GOOGL" } },
            },
            "MSFT-USD": {
                "providers": { "twelvedata": { "symbol": "MSFT" } },
            },
            "AMZN-USD": {
                "providers": { "twelvedata": { "symbol": "AMZN" } },
            },
            "TSLA-USD": {
                "providers": { "twelvedata": { "symbol": "TSLA" } },
            },
            "META-USD": {
                "providers": { "twelvedata": { "symbol": "META" } },
            },
            "NVDA-USD": {
                "providers": { "twelvedata": { "symbol": "NVDA" } },
            },
            "SPY-USD": {
                "providers": { "twelvedata": { "symbol": "SPY" } },
            },
            "QQQ-USD": {
                "providers": { "twelvedata": { "symbol": "QQQ" } },
            },
            "GLD-USD": {
                "providers": { "twelvedata": { "symbol": "GLD" } },
            },
            "EUR-USD": {
                "providers": { "twelvedata": { "symbol": "EUR/USD" } },
            },
            "GBP-USD": {
                "providers": { "twelvedata": { "symbol": "GBP/USD" } },
            },
            "JPY-USD": {
                "price_transform": "inverse",
                "providers": { "twelvedata": { "symbol": "USD/JPY" } },
            },
            "CNY-USD": {
                "price_transform": "inverse",
                "providers": { "twelvedata": { "symbol": "USD/CNY" } },
            },
        })
    })
}

/// `DEFAULT_SOURCE_SET_IDS`.
pub const DEFAULT_SOURCE_SET_IDS: [(&str, i64); 3] =
    [("twelvedata", 1), ("binance-spot", 2), ("coinbase-spot", 3)];

/// `deepMerge(base, override)` over JSON objects: a non-object override returns
/// the base untouched; nested plain objects merge recursively, everything else
/// replaces.
fn deep_merge(base: &Json, over: &Json) -> Json {
    let Some(over_map) = over.as_object() else {
        return base.clone();
    };
    let Some(base_map) = base.as_object() else {
        return base.clone();
    };
    let mut output = base_map.clone();
    for (key, value) in over_map {
        let merged = match (output.get(key), value) {
            (Some(existing), Json::Object(_)) if existing.is_object() => {
                deep_merge(existing, value)
            }
            _ => value.clone(),
        };
        output.insert(key.clone(), merged);
    }
    Json::Object(output)
}

/// `parseRegistryOverride(raw)` — empty or malformed → `{}`, arrays and
/// non-objects → `{}`.
fn parse_registry_override(raw: &str) -> Json {
    if raw.is_empty() {
        return json!({});
    }
    match serde_json::from_str::<Json>(raw) {
        Ok(parsed) if parsed.is_object() => parsed,
        _ => json!({}),
    }
}

/// `normalizeFeedPairSymbol(pair)` — trim, uppercase, strip a known provider
/// prefix, then remap through the alias table.
pub fn normalize_feed_pair_symbol(pair: &str) -> String {
    let normalized = js_trim(pair).to_uppercase();
    let stripped = if KNOWN_FEED_PROVIDER_PREFIXES
        .iter()
        .any(|prefix| normalized.starts_with(prefix))
    {
        match normalized.find(':') {
            Some(index) => normalized[index + 1..].to_string(),
            None => normalized.clone(),
        }
    } else {
        normalized
    };
    FEED_PAIR_ALIASES
        .iter()
        .find(|(alias, _)| *alias == stripped)
        .map(|(_, target)| (*target).to_string())
        .unwrap_or(stripped)
}

/// `getFeedPairRegistry(env)` — the defaults deep-merged with the
/// `MORPHEUS_FEED_PAIR_REGISTRY_JSON` override.
pub fn get_feed_pair_registry(env: EnvReader<'_>) -> Json {
    let raw = env("MORPHEUS_FEED_PAIR_REGISTRY_JSON").unwrap_or_default();
    deep_merge(default_feed_pairs(), &parse_registry_override(&raw))
}

/// `getFeedPairConfig(pair)` — the merged registry entry, or `None`.
pub fn get_feed_pair_config(pair: &str, env: EnvReader<'_>) -> Option<Json> {
    let registry = get_feed_pair_registry(env);
    let normalized = normalize_feed_pair_symbol(pair);
    registry
        .get(&normalized)
        .filter(|config| js_truthy(config))
        .cloned()
}

/// `getFeedDisplaySymbol(pair)` — an explicit `display_symbol` or the
/// twelvedata storage pair.
pub fn get_feed_display_symbol(pair: &str, env: EnvReader<'_>) -> String {
    let config = get_feed_pair_config(pair, env);
    let display = js_trim_string(config.as_ref().and_then(|c| c.get("display_symbol")));
    if display.is_empty() {
        get_feed_storage_pair("twelvedata", pair)
    } else {
        display
    }
}

pub fn get_feed_unit_label(pair: &str, env: EnvReader<'_>) -> String {
    let config = get_feed_pair_config(pair, env);
    js_trim_string(config.as_ref().and_then(|c| c.get("unit_label")))
}

pub fn get_feed_price_multiplier(pair: &str, env: EnvReader<'_>) -> f64 {
    let config = get_feed_pair_config(pair, env);
    let raw_value = config
        .as_ref()
        .and_then(|c| c.get("price_multiplier").filter(|v| !v.is_null()))
        .cloned()
        .unwrap_or_else(|| json!(1));
    let raw = js_to_number(&raw_value);
    if raw.is_finite() && raw > 0.0 {
        raw
    } else {
        1.0
    }
}

pub fn get_feed_price_transform(pair: &str, env: EnvReader<'_>) -> String {
    let config = get_feed_pair_config(pair, env);
    js_trim_string(config.as_ref().and_then(|c| c.get("price_transform"))).to_lowercase()
}

pub fn get_feed_providers_for_pair(pair: &str, env: EnvReader<'_>) -> Vec<String> {
    let Some(config) = get_feed_pair_config(pair, env) else {
        return Vec::new();
    };
    let Some(map) = config.get("providers").and_then(Json::as_object) else {
        return Vec::new();
    };
    map.keys()
        .map(|provider| normalize_provider_id(&Json::String(provider.clone())))
        .filter(|provider| !provider.is_empty())
        .collect()
}

pub fn get_default_feed_symbols(env: EnvReader<'_>) -> Vec<String> {
    get_feed_pair_registry(env)
        .as_object()
        .map(|map| {
            map.keys()
                .map(|pair| get_feed_storage_pair("twelvedata", pair))
                .collect()
        })
        .unwrap_or_default()
}

/// `applyFeedProviderDefaults(pair, providerId, payload)` — the payload with
/// `symbol` (falling back to the normalized pair), the normalized `provider`,
/// and `provider_params` deep-filled from the registry defaults.
pub fn apply_feed_provider_defaults(
    pair: &str,
    provider_id: &Json,
    payload: &Json,
    env: EnvReader<'_>,
) -> Json {
    let normalized_pair = normalize_feed_pair_symbol(pair);
    let config = get_feed_pair_config(pair, env);
    let provider = normalize_provider_id(provider_id);
    let provider_defaults = config
        .as_ref()
        .and_then(|c| c.get("providers"))
        .and_then(|providers| providers.get(&provider))
        .filter(|value| value.is_object())
        .cloned()
        .unwrap_or_else(|| json!({}));

    let mut output = payload.as_object().cloned().unwrap_or_default();
    let symbol = match payload.get("symbol") {
        Some(value) if js_truthy(value) => js_trim_string(Some(value)),
        _ => normalized_pair.clone(),
    };
    output.insert("symbol".to_string(), json!(symbol.to_uppercase()));
    output.insert("provider".to_string(), json!(provider));

    let mut provider_params = match provider_defaults {
        Json::Object(map) => map,
        _ => Default::default(),
    };
    if let Some(Json::Object(overrides)) = payload.get("provider_params") {
        for (key, value) in overrides {
            provider_params.insert(key.clone(), value.clone());
        }
    }
    output.insert("provider_params".to_string(), Json::Object(provider_params));
    Json::Object(output)
}

/// `getFeedStoragePair(providerId, pair)` — `PROVIDER:PAIR` in storage form.
pub fn get_feed_storage_pair(provider_id: &str, pair: &str) -> String {
    let provider = normalize_provider_id(&Json::String(provider_id.to_string())).to_uppercase();
    format!("{provider}:{}", normalize_feed_pair_symbol(pair))
}

pub fn get_source_set_id_for_provider(provider_id: &Json, fallback: i64) -> i64 {
    let normalized = normalize_provider_id(provider_id);
    DEFAULT_SOURCE_SET_IDS
        .iter()
        .find(|(id, _)| *id == normalized)
        .map_or(fallback, |(_, source_set_id)| *source_set_id)
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

    fn env_with_registry(raw: &str) -> impl Fn(&str) -> Option<String> {
        env_from(&[("MORPHEUS_FEED_PAIR_REGISTRY_JSON", raw)])
    }

    #[test]
    fn re_derives_the_registry_when_the_override_string_changes() {
        let base_config = get_feed_pair_config("NEO-USD", &env_from(&[]));
        assert!(
            base_config
                .as_ref()
                .and_then(|config| config.get("threshold_bps"))
                .is_none(),
            "default NEO-USD has no threshold override"
        );

        let overridden = get_feed_pair_config(
            "NEO-USD",
            &env_with_registry(r#"{"NEO-USD":{"threshold_bps":5}}"#),
        );
        assert_eq!(
            overridden
                .as_ref()
                .and_then(|config| config.get("threshold_bps")),
            Some(&json!(5)),
            "changed override is reflected immediately"
        );

        let reoverridden = get_feed_pair_config(
            "NEO-USD",
            &env_with_registry(r#"{"NEO-USD":{"threshold_bps":7}}"#),
        );
        assert_eq!(
            reoverridden
                .as_ref()
                .and_then(|config| config.get("threshold_bps")),
            Some(&json!(7)),
            "a different override value re-derives the merge"
        );
    }

    #[test]
    fn merges_overrides_without_dropping_default_pairs() {
        let baseline_symbols = get_default_feed_symbols(&env_from(&[]));

        let env = env_with_registry(
            r#"{"CUSTOM-USD":{"providers":{"twelvedata":{"symbol":"CUSTOM/USD"}}}}"#,
        );
        let merged = get_feed_pair_registry(&env);
        assert!(
            merged.get("NEO-USD").is_some(),
            "default pairs survive the deep merge"
        );
        assert!(
            merged.get("CUSTOM-USD").is_some(),
            "override pairs are added"
        );
        assert_eq!(
            get_default_feed_symbols(&env).len(),
            baseline_symbols.len() + 1,
            "override adds exactly one new symbol"
        );
    }

    #[test]
    fn invalid_override_json_falls_back_to_the_default_registry() {
        let registry = get_feed_pair_registry(&env_with_registry("{ not valid json"));
        assert!(
            registry.get("NEO-USD").is_some(),
            "malformed override does not break the default registry"
        );
        // arrays and other non-objects fall back the same way
        let array_registry = get_feed_pair_registry(&env_with_registry("[]"));
        assert!(array_registry.get("NEO-USD").is_some());
    }

    #[test]
    fn pair_symbols_strip_provider_prefixes_and_apply_aliases() {
        assert_eq!(normalize_feed_pair_symbol("NEO-USD"), "NEO-USD");
        assert_eq!(normalize_feed_pair_symbol("TWELVEDATA:NEO-USD"), "NEO-USD");
        assert_eq!(
            normalize_feed_pair_symbol("BINANCE-SPOT:GAS-USD"),
            "GAS-USD"
        );
        assert_eq!(
            normalize_feed_pair_symbol("COINBASE-SPOT:BTC-USD"),
            "BTC-USD"
        );
        assert_eq!(normalize_feed_pair_symbol(" oil-usd "), "WTI-USD");
        assert_eq!(normalize_feed_pair_symbol("OIL-USD"), "WTI-USD");
        assert_eq!(normalize_feed_pair_symbol("  neo-usd  "), "NEO-USD");
    }

    #[test]
    fn storage_pairs_and_source_sets_follow_the_provider_normalization() {
        assert_eq!(
            get_feed_storage_pair("twelvedata", "NEO-USD"),
            "TWELVEDATA:NEO-USD"
        );
        assert_eq!(
            get_feed_storage_pair(" TWELVEDATA ", "OIL-USD"),
            "TWELVEDATA:WTI-USD"
        );
        assert_eq!(get_source_set_id_for_provider(&json!("twelvedata"), 0), 1);
        assert_eq!(get_source_set_id_for_provider(&json!("BINANCE-SPOT"), 0), 2);
        assert_eq!(
            get_source_set_id_for_provider(&json!("coinbase-spot"), 0),
            3
        );
        assert_eq!(get_source_set_id_for_provider(&json!("unknown"), 9), 9);
    }

    #[test]
    fn pair_configs_expose_display_units_multiplier_transform_and_providers() {
        let env = env_from(&[]);
        assert_eq!(
            get_feed_display_symbol("NEO-USD", &env),
            "TWELVEDATA:NEO-USD"
        );
        assert_eq!(get_feed_unit_label("NEO-USD", &env), "");
        assert_eq!(get_feed_price_multiplier("NEO-USD", &env), 1.0);
        assert_eq!(get_feed_price_transform("NEO-USD", &env), "");
        assert_eq!(get_feed_price_transform("JPY-USD", &env), "inverse");
        assert_eq!(
            get_feed_providers_for_pair("NEO-USD", &env),
            vec!["twelvedata".to_string(), "binance-spot".to_string()]
        );
        assert_eq!(
            get_feed_providers_for_pair("BTC-USD", &env),
            vec!["twelvedata"]
        );
        assert_eq!(
            get_feed_providers_for_pair("MISSING-USD", &env),
            Vec::<String>::new()
        );
        // an invalid multiplier falls back to 1
        let bad = env_with_registry(r#"{"NEO-USD":{"price_multiplier":-2}}"#);
        assert_eq!(get_feed_price_multiplier("NEO-USD", &bad), 1.0);
    }

    #[test]
    fn apply_feed_provider_defaults_fills_symbol_provider_and_params() {
        let env = env_from(&[]);
        let output = apply_feed_provider_defaults(
            "TWELVEDATA:NEO-USD",
            &json!("TWELVEDATA"),
            &json!({ "provider_params": { "timeout": "5" } }),
            &env,
        );
        assert_eq!(
            output,
            json!({
                "provider_params": { "symbol": "NEO/USD", "timeout": "5" },
                "symbol": "NEO-USD",
                "provider": "twelvedata",
            })
        );
        // registry defaults survive, payload values keep their positions
        assert_eq!(output["provider_params"]["symbol"], json!("NEO/USD"));
        assert_eq!(output["provider_params"]["timeout"], json!("5"));
        assert_eq!(output["symbol"], json!("NEO-USD"));
        assert_eq!(output["provider"], json!("twelvedata"));

        // a truthy payload symbol wins over the normalized pair
        let named = apply_feed_provider_defaults(
            "NEO-USD",
            &json!("twelvedata"),
            &json!({ "symbol": "neo/usd-custom" }),
            &env,
        );
        assert_eq!(named["symbol"], json!("NEO/USD-CUSTOM"));
    }

    #[test]
    fn retired_pairs_stay_retired() {
        let retired = retired_feed_pairs();
        assert_eq!(retired.as_object().map(|map| map.len()), Some(4));
        for pair in ["COPPER-USD", "FLM-USD", "1000FLM-USD", "1000JPY-USD"] {
            assert!(retired.get(pair).is_some(), "{pair} must stay retired");
            assert!(
                default_feed_pairs().get(pair).is_none(),
                "{pair} must not reappear in the defaults"
            );
        }
    }
}
