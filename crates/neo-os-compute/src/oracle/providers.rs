//! Port of `workers/nitro-worker/src/oracle/providers.js` — the builtin
//! provider request builders, provider payload-error detection, the capped
//! TTL caches, per-provider circuit breakers, and the retrying provider
//! fetch over the injected transport. The in-flight dedup map is a
//! concurrency primitive and stays a host concern (the blocking lanes cannot
//! have concurrent awaits).

use std::collections::HashMap;

use serde_json::{json, Value as Json};
use url::Url;

use crate::circuit_breaker::CircuitBreaker;
use crate::core::{
    get_supabase_rest_config, normalize_morpheus_network_strict, read_env, resolve_max_bytes,
    resolve_payload_network_strict, EnvReader, JsHeaders,
};
use crate::js::{js_first_truthy, js_stringify, js_to_number, js_trim_string, js_truthy};
use crate::oracle::fetch::is_timeout_error;
use crate::oracle::normalize_provider_id;
use crate::ssrf::{resolve_pinned_addresses, DnsLookup};
use crate::transport::{read_response_text_with_limit, HttpRequest, HttpTransport};

pub const PROVIDER_CONFIG_CACHE_TTL_MS: u64 = 30_000;

/// `Number(env(name)) || fallback` — NaN and 0 take the fallback (the JS `||`).
fn env_number_or(env: EnvReader<'_>, name: &str, fallback: f64) -> f64 {
    let numeric = js_to_number(&Json::String(read_env(env, &[name])));
    if !numeric.is_finite() || numeric == 0.0 {
        fallback
    } else {
        numeric
    }
}

fn env_number_truncated_or(env: EnvReader<'_>, name: &str, fallback: f64, floor: f64) -> f64 {
    let numeric = js_to_number(&Json::String(read_env(env, &[name])));
    if !numeric.is_finite() {
        return fallback;
    }
    numeric.trunc().max(floor)
}

pub fn provider_cache_max_entries(env: EnvReader<'_>) -> usize {
    env_number_or(env, "MORPHEUS_PROVIDER_CACHE_MAX_ENTRIES", 500.0).max(16.0) as usize
}

pub fn resolve_provider_response_cache_ttl_ms(env: EnvReader<'_>) -> u64 {
    // Number('') === 0 — an unset env disables the cache; only non-numeric
    // text falls back to the 1.5s default.
    let configured = js_to_number(&Json::String(read_env(
        env,
        &["MORPHEUS_PROVIDER_RESPONSE_CACHE_TTL_MS"],
    )));
    if !configured.is_finite() {
        return 1_500;
    }
    configured.trunc().max(0.0) as u64
}

pub fn resolve_provider_retry_count(env: EnvReader<'_>) -> u32 {
    env_number_truncated_or(env, "MORPHEUS_PROVIDER_FETCH_RETRIES", 0.0, 0.0) as u32
}

pub fn resolve_provider_response_max_body_bytes(env: EnvReader<'_>) -> u64 {
    resolve_max_bytes(
        Some(&Json::String(read_env(
            env,
            &["ORACLE_MAX_PROVIDER_BODY_BYTES"],
        ))),
        64 * 1024,
        4_096,
    )
}

// ---- capped TTL caches (the JS module-level Maps) ----

struct TtlEntry<T> {
    expires_at: u64,
    value: T,
}

/// A Map with a hard size ceiling, evicting the oldest entries first; expired
/// entries are reclaimed before fresh ones (providers.js `setCappedCacheEntry`).
pub struct TtlCache<T> {
    entries: Vec<(String, TtlEntry<T>)>,
}

impl<T> Default for TtlCache<T> {
    fn default() -> Self {
        Self {
            entries: Vec::new(),
        }
    }
}

impl<T: Clone> TtlCache<T> {
    /// `cache.get(key)` guarded by `expiresAt > now`.
    pub fn get(&self, key: &str, now_ms: u64) -> Option<&T> {
        let (_, entry) = self.entries.iter().find(|(k, _)| k == key)?;
        if entry.expires_at > now_ms {
            Some(&entry.value)
        } else {
            None
        }
    }

    pub fn contains_key(&self, key: &str) -> bool {
        self.entries.iter().any(|(k, _)| k == key)
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn set_capped(
        &mut self,
        key: &str,
        expires_at: u64,
        value: T,
        max_entries: usize,
        now_ms: u64,
    ) {
        // Re-inserting an existing key must refresh its recency/ordering.
        self.entries.retain(|(k, _)| k != key);
        self.entries
            .push((key.to_string(), TtlEntry { expires_at, value }));
        if self.entries.len() <= max_entries {
            return;
        }
        let mut index = 0;
        while index < self.entries.len() && self.entries.len() > max_entries {
            let (existing_key, entry) = &self.entries[index];
            if existing_key != key && entry.expires_at <= now_ms {
                self.entries.remove(index);
            } else {
                index += 1;
            }
        }
        while self.entries.len() > max_entries {
            if self.entries[0].0 == key {
                break;
            }
            self.entries.remove(0);
        }
    }
}

/// The provider-lane module state: config/response caches plus the
/// per-provider circuit breakers. The caller owns it (the JS side keeps
/// module-level Maps); `now_ms` flows in per call.
#[derive(Default)]
pub struct ProviderRuntime {
    pub config_cache: TtlCache<Option<Json>>,
    pub response_cache: TtlCache<ProviderFetchResult>,
    pub breakers: HashMap<String, CircuitBreaker>,
}

impl ProviderRuntime {
    fn get_or_create_breaker(
        &mut self,
        provider_id: &str,
        env: EnvReader<'_>,
    ) -> &mut CircuitBreaker {
        self.breakers
            .entry(provider_id.to_string())
            .or_insert_with(|| {
                CircuitBreaker::new(provider_id)
                    .with_failure_threshold(env_number_or(
                        env,
                        "MORPHEUS_PROVIDER_FAILURE_THRESHOLD",
                        3.0,
                    ) as u32)
                    .with_reset_timeout_ms(env_number_or(
                        env,
                        "MORPHEUS_PROVIDER_RESET_TIMEOUT_MS",
                        60_000.0,
                    ) as u64)
                    .with_half_open_max(1)
            })
    }

    pub fn get_state(&self, provider_id: &str) -> Option<Json> {
        self.breakers
            .get(provider_id)
            .map(CircuitBreaker::get_state)
    }
}

// ---- builtin catalog ----

pub fn list_builtin_providers() -> Json {
    json!([
        {
            "id": "twelvedata",
            "category": "market-data",
            "description": "Direct TwelveData market data source for shared fetch/query and resource publication lanes. No aggregation, no smoothing.",
            "supports": ["oracle", "datafeed"],
            "kernel_supports": ["oracle.fetch", "feed.publish"],
            "auth": "apikey",
        },
        {
            "id": "binance-spot",
            "category": "market-data",
            "description": "Direct Binance spot ticker endpoint for shared fetch/query and resource publication lanes. No aggregation, no smoothing.",
            "supports": ["oracle", "datafeed"],
            "kernel_supports": ["oracle.fetch", "feed.publish"],
            "auth": "none",
        },
        {
            "id": "coinbase-spot",
            "category": "market-data",
            "description": "Direct Coinbase spot price endpoint for shared fetch/query and resource publication lanes. No aggregation, no smoothing.",
            "supports": ["oracle", "datafeed"],
            "kernel_supports": ["oracle.fetch", "feed.publish"],
            "auth": "none",
        },
        {
            "id": "coingecko",
            "category": "market-data",
            "description": "CoinGecko simple-price market data source for supported crypto assets. No API key is sent by the worker.",
            "supports": ["oracle", "datafeed"],
            "kernel_supports": ["oracle.fetch", "feed.publish"],
            "auth": "none",
        },
        {
            "id": "coinpaprika",
            "category": "market-data",
            "description": "CoinPaprika ticker market data source for supported crypto assets. No API key is sent by the worker.",
            "supports": ["oracle", "datafeed"],
            "kernel_supports": ["oracle.fetch", "feed.publish"],
            "auth": "none",
        },
    ])
}

const FEED_PROVIDER_PREFIXES: [(&str, &str); 5] = [
    ("TWELVEDATA:", "twelvedata"),
    ("BINANCE-SPOT:", "binance-spot"),
    ("COINBASE-SPOT:", "coinbase-spot"),
    ("COINGECKO:", "coingecko"),
    ("COINPAPRIKA:", "coinpaprika"),
];

fn matched_feed_prefix(normalized: &str) -> Option<&'static str> {
    FEED_PROVIDER_PREFIXES
        .iter()
        .map(|(prefix, _)| *prefix)
        .find(|prefix| normalized.starts_with(prefix))
}

/// `inferProviderIdFromPairSymbol(value)`.
pub fn infer_provider_id_from_pair_symbol(value: &Json) -> String {
    let normalized = js_trim_string(Some(value)).to_uppercase();
    match matched_feed_prefix(&normalized) {
        Some(prefix) => FEED_PROVIDER_PREFIXES
            .iter()
            .find(|(candidate, _)| *candidate == prefix)
            .map(|(_, id)| id.to_string())
            .unwrap_or_default(),
        None => String::new(),
    }
}

/// `stripProviderPrefixFromPairSymbol(value)`.
pub fn strip_provider_prefix_from_pair_symbol(value: &Json) -> String {
    let normalized = js_trim_string(Some(value)).to_uppercase();
    match matched_feed_prefix(&normalized) {
        Some(prefix) => normalized[prefix.len()..].to_string(),
        None => normalized,
    }
}

fn is_plain_object(value: &Json) -> bool {
    value.is_object()
}

/// `coerceProviderParams(value)` — a plain object passes through, a string is
/// JSON-parsed (plain objects only), everything else collapses to `{}`.
pub fn coerce_provider_params(value: &Json) -> Json {
    if is_plain_object(value) {
        return value.clone();
    }
    if let Json::String(text) = value {
        if let Ok(parsed) = serde_json::from_str::<Json>(text) {
            if is_plain_object(&parsed) {
                return parsed;
            }
        }
    }
    json!({})
}

/// `resolveSupabaseNetwork(value)` — `value || env(MORPHEUS_NETWORK) ||
/// env(NEXT_PUBLIC_MORPHEUS_NETWORK) || 'testnet'`, normalized.
pub fn resolve_supabase_network(value: &Json, env: EnvReader<'_>) -> Result<String, String> {
    let chain = [
        Some(value.clone()),
        Some(Json::String(read_env(env, &["MORPHEUS_NETWORK"]))),
        Some(Json::String(read_env(
            env,
            &["NEXT_PUBLIC_MORPHEUS_NETWORK"],
        ))),
        Some(Json::String("testnet".to_string())),
    ];
    let chosen = chain
        .iter()
        .flatten()
        .find(|candidate| js_truthy(candidate))
        .cloned()
        .unwrap_or(Json::Null);
    normalize_morpheus_network_strict(&js_stringify(&chosen), "testnet")
}

// ---- request specs ----

#[derive(Debug, Clone, PartialEq)]
pub struct ProviderRequestSpec {
    pub provider: String,
    pub pair: String,
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<Vec<u8>>,
    pub auth_mode: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ProviderFetchResult {
    pub ok: bool,
    pub status: u16,
    /// `Object.fromEntries(response.headers.entries())`.
    pub headers: Json,
    pub text: String,
    pub data: Json,
    pub provider_error: Option<Json>,
}

fn pair_parts(pair: &str) -> (String, String) {
    let mut parts = pair.split('-');
    let base = parts.next().unwrap_or("").to_string();
    let quote = parts.next().unwrap_or("USD").to_string();
    (base, quote)
}

/// `pairToTwelveDataSymbol(pair)` — `BASE/QUOTE`, defaulting the quote to USD.
pub fn pair_to_twelvedata_symbol(pair: &Json) -> String {
    let normalized = js_trim_string(Some(pair)).to_uppercase().replace('_', "-");
    let (base, quote) = pair_parts(&normalized);
    format!("{base}/{quote}")
}

/// `pairToBinanceSymbol(pair)` — `BASEQUOTE`, USD becoming USDT.
pub fn pair_to_binance_symbol(pair: &Json) -> String {
    let normalized = js_trim_string(Some(pair)).to_uppercase().replace('_', "-");
    let (base, quote) = pair_parts(&normalized);
    let quote = if quote == "USD" {
        "USDT".to_string()
    } else {
        quote
    };
    format!("{base}{quote}")
}

fn require_twelvedata_api_key(env: EnvReader<'_>) -> Result<String, String> {
    let api_key = read_env(env, &["TWELVEDATA_API_KEY"]);
    if api_key.is_empty() {
        return Err("TWELVEDATA_API_KEY is not configured".to_string());
    }
    Ok(api_key)
}

fn allow_unsafe_provider_base_url_override(env: EnvReader<'_>) -> bool {
    let raw = js_trim_string(Some(&Json::String(read_env(
        env,
        &["MORPHEUS_ALLOW_UNSAFE_PROVIDER_BASE_URL_OVERRIDE"],
    ))));
    let lowered = raw.to_lowercase();
    raw == "1" || lowered == "true" || lowered == "yes"
}

/// `/^[A-Z0-9]+-[A-Z0-9]+$/i` — exactly one dash with alphanumeric sides.
fn is_pair_shaped_symbol(symbol: &str) -> bool {
    let (first, second) = match symbol.split_once('-') {
        Some(parts) => parts,
        None => return false,
    };
    let alphanumeric =
        |text: &str| !text.is_empty() && text.chars().all(|c| c.is_ascii_alphanumeric());
    alphanumeric(first) && alphanumeric(second) && !second.contains('-')
}

/// `buildTwelveDataRequest(payload, provider)`.
fn build_twelvedata_request(
    payload: &Json,
    provider: &str,
    env: EnvReader<'_>,
) -> Result<ProviderRequestSpec, String> {
    let params = coerce_provider_params(
        &payload
            .get("provider_params")
            .cloned()
            .unwrap_or(Json::Null),
    );
    let fallback_pair = js_first_truthy(payload, &["symbol"])
        .cloned()
        .or_else(|| js_first_truthy(&params, &["pair"]).cloned())
        .unwrap_or(Json::String("NEO-USD".to_string()));
    let pair = {
        let stripped = strip_provider_prefix_from_pair_symbol(&fallback_pair);
        if stripped.is_empty() {
            "NEO-USD".to_string()
        } else {
            stripped
        }
    };
    let explicit_symbol = js_trim_string(Some(
        &js_first_truthy(&params, &["symbol"])
            .cloned()
            .or_else(|| js_first_truthy(payload, &["provider_symbol"]).cloned())
            .unwrap_or(Json::Null),
    ));
    let source_symbol = if explicit_symbol.is_empty() {
        pair.clone()
    } else {
        explicit_symbol.clone()
    };
    let symbol = if !explicit_symbol.is_empty() {
        if is_pair_shaped_symbol(&explicit_symbol) {
            pair_to_twelvedata_symbol(&Json::String(explicit_symbol.clone()))
        } else {
            explicit_symbol
        }
    } else if source_symbol.contains('/') {
        source_symbol
    } else {
        pair_to_twelvedata_symbol(&Json::String(source_symbol))
    };
    let endpoint = {
        let chosen = js_first_truthy(&params, &["endpoint"])
            .cloned()
            .or_else(|| js_first_truthy(payload, &["provider_endpoint"]).cloned())
            .unwrap_or(Json::Null);
        let trimmed = js_trim_string(Some(&chosen));
        if trimmed.is_empty() {
            "price".to_string()
        } else {
            trimmed
        }
    };
    let mut url = Url::parse(&format!("https://api.twelvedata.com/{endpoint}"))
        .map_err(|_| "Invalid URL".to_string())?;
    {
        let mut pairs = url.query_pairs_mut();
        pairs.append_pair("symbol", &symbol);
        pairs.append_pair("apikey", &require_twelvedata_api_key(env)?);
        if let Json::Object(map) = &params {
            for (key, value) in map {
                if key == "symbol" || key == "endpoint" {
                    continue;
                }
                // `value !== undefined && value !== null && value !== ''`
                if !value.is_null() && value.as_str() != Some("") {
                    pairs.append_pair(key, &js_stringify(value));
                }
            }
        }
    }
    Ok(ProviderRequestSpec {
        provider: provider.to_string(),
        pair,
        method: "GET".to_string(),
        url: url.to_string(),
        headers: Vec::new(),
        body: None,
        auth_mode: "query".to_string(),
    })
}

/// `buildBinanceSpotRequest(payload, provider)`.
fn build_binance_spot_request(
    payload: &Json,
    provider: &str,
    env: EnvReader<'_>,
) -> Result<ProviderRequestSpec, String> {
    let params = coerce_provider_params(
        &payload
            .get("provider_params")
            .cloned()
            .unwrap_or(Json::Null),
    );
    let fallback_pair = js_first_truthy(payload, &["symbol"])
        .cloned()
        .or_else(|| js_first_truthy(&params, &["pair"]).cloned())
        .unwrap_or(Json::String("NEO-USD".to_string()));
    let pair = {
        let stripped = strip_provider_prefix_from_pair_symbol(&fallback_pair);
        if stripped.is_empty() {
            "NEO-USD".to_string()
        } else {
            stripped
        }
    };
    let symbol = {
        let chosen = js_first_truthy(&params, &["symbol"])
            .cloned()
            .or_else(|| js_first_truthy(payload, &["provider_symbol"]).cloned())
            .unwrap_or(Json::String(pair_to_binance_symbol(&Json::String(
                pair.clone(),
            ))));
        let trimmed = js_trim_string(Some(&chosen));
        if trimmed.is_empty() {
            pair_to_binance_symbol(&Json::String(pair.clone()))
        } else {
            trimmed
        }
    };
    let requested_base_url = js_trim_string(Some(
        &js_first_truthy(&params, &["base_url"])
            .cloned()
            .or_else(|| js_first_truthy(payload, &["provider_base_url"]).cloned())
            .unwrap_or(Json::Null),
    ));
    let base_url = if !requested_base_url.is_empty() && allow_unsafe_provider_base_url_override(env)
    {
        requested_base_url
    } else {
        "https://api1.binance.com".to_string()
    };
    let mut url = Url::options()
        .base_url(Some(
            &Url::parse(&base_url).map_err(|_| "Invalid URL".to_string())?,
        ))
        .parse("/api/v3/ticker/price")
        .map_err(|_| "Invalid URL".to_string())?;
    url.query_pairs_mut().append_pair("symbol", &symbol);
    Ok(ProviderRequestSpec {
        provider: provider.to_string(),
        pair: pair.replace('_', "-").to_uppercase(),
        method: "GET".to_string(),
        url: url.to_string(),
        headers: Vec::new(),
        body: None,
        auth_mode: "none".to_string(),
    })
}

/// `buildCoinbaseSpotRequest(payload, provider)`.
fn build_coinbase_spot_request(payload: &Json, provider: &str) -> ProviderRequestSpec {
    let params = coerce_provider_params(
        &payload
            .get("provider_params")
            .cloned()
            .unwrap_or(Json::Null),
    );
    let fallback_pair = js_first_truthy(payload, &["symbol"])
        .cloned()
        .or_else(|| js_first_truthy(&params, &["symbol"]).cloned())
        .unwrap_or(Json::String("NEO-USD".to_string()));
    let pair = {
        let stripped = strip_provider_prefix_from_pair_symbol(&fallback_pair);
        if stripped.is_empty() {
            "NEO-USD".to_string()
        } else {
            stripped
        }
    };
    let normalized = pair.replace('_', "-").to_uppercase();
    ProviderRequestSpec {
        provider: provider.to_string(),
        pair: normalized.clone(),
        method: "GET".to_string(),
        url: format!("https://api.coinbase.com/v2/prices/{normalized}/spot"),
        headers: Vec::new(),
        body: None,
        auth_mode: "none".to_string(),
    }
}

fn crypto_provider_id(
    payload: &Json,
    default_pair: &str,
    ids: &[(&str, &str)],
) -> Result<(String, String), String> {
    let params = coerce_provider_params(
        &payload
            .get("provider_params")
            .cloned()
            .unwrap_or(Json::Null),
    );
    let fallback_pair = js_first_truthy(payload, &["symbol"])
        .cloned()
        .or_else(|| js_first_truthy(&params, &["pair"]).cloned())
        .unwrap_or(Json::String(default_pair.to_string()));
    let pair = {
        let stripped = strip_provider_prefix_from_pair_symbol(&fallback_pair);
        if stripped.is_empty() {
            default_pair.to_string()
        } else {
            stripped
        }
    };
    let id = js_trim_string(Some(
        &js_first_truthy(&params, &["id"])
            .cloned()
            .or_else(|| js_first_truthy(payload, &["provider_symbol"]).cloned())
            .unwrap_or(Json::Null),
    ));
    let id = if id.is_empty() {
        ids.iter()
            .find(|(candidate, _)| *candidate == pair)
            .map(|(_, id)| id.to_string())
            .unwrap_or_default()
    } else {
        id
    };
    if id.is_empty() {
        return Err(format!("provider does not support {pair}"));
    }
    Ok((pair.replace('_', "-").to_uppercase(), id))
}

fn build_coingecko_request(payload: &Json, provider: &str) -> Result<ProviderRequestSpec, String> {
    let (pair, id) = crypto_provider_id(
        payload,
        "NEO-USD",
        &[("NEO-USD", "neo"), ("GAS-USD", "gas")],
    )?;
    let mut url = Url::parse("https://api.coingecko.com/api/v3/simple/price")
        .map_err(|_| "Invalid URL".to_string())?;
    url.query_pairs_mut()
        .append_pair("ids", &id)
        .append_pair("vs_currencies", "usd");
    Ok(ProviderRequestSpec {
        provider: provider.to_string(),
        pair,
        method: "GET".to_string(),
        url: url.to_string(),
        headers: Vec::new(),
        body: None,
        auth_mode: "none".to_string(),
    })
}

fn build_coinpaprika_request(
    payload: &Json,
    provider: &str,
) -> Result<ProviderRequestSpec, String> {
    let (pair, id) = crypto_provider_id(
        payload,
        "NEO-USD",
        &[("NEO-USD", "neo-neo"), ("GAS-USD", "gas-gas")],
    )?;
    Ok(ProviderRequestSpec {
        provider: provider.to_string(),
        pair,
        method: "GET".to_string(),
        url: format!("https://api.coinpaprika.com/v1/tickers/{id}"),
        headers: Vec::new(),
        body: None,
        auth_mode: "none".to_string(),
    })
}

/// `buildProviderRequest(payload)` — `Ok(None)` when no provider is named,
/// `Err` for unknown builtin providers.
pub fn build_provider_request(
    payload: &Json,
    env: EnvReader<'_>,
) -> Result<Option<ProviderRequestSpec>, String> {
    let symbol_candidate = {
        let chosen = js_first_truthy(payload, &["symbol"])
            .cloned()
            .or_else(|| js_first_truthy(payload, &["pair"]).cloned())
            .or_else(|| {
                payload
                    .get("provider_params")
                    .filter(|params| is_plain_object(params))
                    .and_then(|params| params.get("pair"))
                    .cloned()
            })
            .unwrap_or(Json::String("NEO-USD".to_string()));
        js_trim_string(Some(&chosen))
    };
    let provider = normalize_provider_id(
        &js_first_truthy(payload, &["provider"])
            .cloned()
            .or_else(|| js_first_truthy(payload, &["source"]).cloned())
            .or_else(|| js_first_truthy(payload, &["provider_id"]).cloned())
            .unwrap_or(Json::String(infer_provider_id_from_pair_symbol(
                &Json::String(symbol_candidate),
            ))),
    );
    if provider.is_empty() {
        return Ok(None);
    }
    match provider.as_str() {
        "twelvedata" => build_twelvedata_request(payload, &provider, env).map(Some),
        "binance-spot" => build_binance_spot_request(payload, &provider, env).map(Some),
        "coinbase-spot" => Ok(Some(build_coinbase_spot_request(payload, &provider))),
        "coingecko" => build_coingecko_request(payload, &provider).map(Some),
        "coinpaprika" => build_coinpaprika_request(payload, &provider).map(Some),
        other => Err(format!("unknown builtin provider: {other}")),
    }
}

// ---- payload-error detection ----

/// `detectProviderPayloadError(requestSpec, response, data)`.
pub fn detect_provider_payload_error(
    provider: &str,
    response_status: u16,
    data: &Json,
) -> Option<Json> {
    if !is_plain_object(data) {
        return None;
    }
    let code = js_to_number(&data.get("code").cloned().unwrap_or(Json::Null));
    let status_text = js_trim_string(Some(&data.get("status").cloned().unwrap_or(Json::Null)));
    let message = js_trim_string(Some(
        &js_first_truthy(data, &["message", "error"])
            .cloned()
            .unwrap_or(Json::Null),
    ));

    if provider == "twelvedata"
        && ((code.is_finite() && code >= 400.0) || status_text.to_lowercase() == "error")
    {
        return Some(json!({
            "status": if code.is_finite() && code > 0.0 {
                js_to_fixed_number(code)
            } else {
                Json::Number(response_status.into())
            },
            "message": if message.is_empty() {
                "twelvedata provider error".to_string()
            } else {
                message
            },
        }));
    }

    let errors = data.get("errors");
    if matches!(errors, Some(Json::Array(items)) if !items.is_empty()) {
        let serialized: String = errors
            .unwrap_or(&Json::Null)
            .to_string()
            .chars()
            .take(180)
            .collect();
        let trimmed = js_trim_string(Some(&Json::String(serialized)));
        return Some(json!({
            "status": Json::Number(response_status.into()),
            "message": if trimmed.is_empty() {
                "provider returned errors".to_string()
            } else {
                trimmed
            },
        }));
    }
    None
}

/// `Number(code)` renders through `String(...)` in the JS object — integral
/// doubles stay integral ("418", not "418.0").
fn js_to_fixed_number(value: f64) -> Json {
    if value.fract() == 0.0 && value.abs() < 1e15 {
        json!(value as i64)
    } else {
        json!(value)
    }
}

// ---- retry policy ----

pub fn is_retryable_provider_status(status: u16) -> bool {
    [408, 425, 429, 500, 502, 503, 504].contains(&status)
}

pub fn is_retryable_provider_error(message: &str) -> bool {
    let lowered = js_trim_string(Some(&Json::String(message.to_string()))).to_lowercase();
    [
        "timed out",
        "network",
        "fetch failed",
        "econnreset",
        "socket hang up",
    ]
    .iter()
    .any(|needle| lowered.contains(needle))
}

fn is_cacheable_provider_request(request: &ProviderRequestSpec) -> bool {
    let method = request.method.trim().to_uppercase();
    method == "GET"
        && request.body.is_none()
        && !request.url.trim().is_empty()
        && ["none", "query", "apikey", ""]
            .contains(&request.auth_mode.trim().to_lowercase().as_str())
}

/// A process-local deterministic stand-in for `stableStringify` (the key never
/// leaves the runtime, only determinism matters).
fn cache_key_stringify(pairs: &[(&str, Json)]) -> String {
    fn write(value: &Json, out: &mut String) {
        match value {
            Json::Null => out.push_str("null"),
            Json::Bool(true) => out.push_str("true"),
            Json::Bool(false) => out.push_str("false"),
            Json::Number(number) => out.push_str(&number.to_string()),
            Json::String(text) => out.push_str(&format!(
                "\"{}\"",
                text.replace('\\', "\\\\").replace('"', "\\\"")
            )),
            Json::Array(items) => {
                out.push('[');
                for (index, item) in items.iter().enumerate() {
                    if index > 0 {
                        out.push(',');
                    }
                    write(item, out);
                }
                out.push(']');
            }
            Json::Object(map) => {
                let mut keys: Vec<&String> = map.keys().collect();
                keys.sort();
                out.push('{');
                for (index, key) in keys.iter().enumerate() {
                    if index > 0 {
                        out.push(',');
                    }
                    write(&Json::String((*key).clone()), out);
                    out.push(':');
                    write(&map[*key], out);
                }
                out.push('}');
            }
        }
    }
    let mut out = String::from("{");
    for (index, (key, value)) in pairs.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        write(&Json::String(key.to_string()), &mut out);
        out.push(':');
        write(value, &mut out);
    }
    out.push('}');
    out
}

/// `buildProviderCacheKey(requestSpec)` — `''` for uncacheable requests.
pub fn build_provider_cache_key(request: &ProviderRequestSpec) -> Result<String, String> {
    if !is_cacheable_provider_request(request) {
        return Ok(String::new());
    }
    let mut parsed_url = Url::parse(request.url.trim()).map_err(|_| "Invalid URL".to_string())?;
    {
        let mut pairs: Vec<(String, String)> = parsed_url.query_pairs().into_owned().collect();
        if pairs.iter().any(|(key, _)| key == "apikey") {
            pairs.retain(|(key, _)| key != "apikey");
            pairs.push(("apikey".to_string(), "__redacted__".to_string()));
        }
        parsed_url.set_query(None);
        if !pairs.is_empty() {
            let mut query = parsed_url.query_pairs_mut();
            for (key, value) in &pairs {
                query.append_pair(key, value);
            }
        }
    }
    let headers = {
        let mut map = serde_json::Map::new();
        for (name, value) in &request.headers {
            map.insert(name.clone(), Json::String(value.clone()));
        }
        Json::Object(map)
    };
    Ok(cache_key_stringify(&[
        (
            "provider",
            Json::String(js_trim_string(Some(&Json::String(
                request.provider.clone(),
            )))),
        ),
        (
            "pair",
            Json::String(js_trim_string(Some(&Json::String(request.pair.clone())))),
        ),
        (
            "method",
            Json::String(if request.method.trim().is_empty() {
                "GET".to_string()
            } else {
                request.method.trim().to_uppercase()
            }),
        ),
        ("url", Json::String(parsed_url.to_string())),
        ("headers", headers),
    ]))
}

/// `resolveRetryAfterMs(headerValue, fallbackMs)` — `Date.parse` supports the
/// ISO-8601 and IMF-fixdate forms; anything else takes the fallback.
pub fn resolve_retry_after_ms(header_value: &Json, fallback_ms: u64, now_ms: u64) -> u64 {
    let raw = js_trim_string(Some(header_value));
    if raw.is_empty() {
        return fallback_ms;
    }
    if !raw.is_empty() && raw.bytes().all(|byte| byte.is_ascii_digit()) {
        let seconds = raw.parse::<f64>().unwrap_or(f64::INFINITY) * 1000.0;
        return seconds.clamp(0.0, 5_000.0) as u64;
    }
    if let Some(parsed) = parse_http_date_ms(&raw) {
        let delta = parsed as f64 - now_ms as f64;
        return delta.clamp(0.0, 5_000.0) as u64;
    }
    fallback_ms
}

/// Minimal `Date.parse` shared by the feed lane: ISO-8601 date/times (naive
/// forms read as UTC — TwelveData's `2025-01-15 14:30:00` included) and
/// RFC-1123 IMF-fixdate in GMT. Retry-After headers use it here; upstream
/// quote timestamps reuse the same subset in `feeds`.
pub(crate) fn parse_http_date_ms(raw: &str) -> Option<i64> {
    let text = raw.trim();
    const MONTHS: [&str; 12] = [
        "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
    ];
    let days_from_civil = |year: i64, month: u32, day: u32| -> i64 {
        // Howard Hinnant's days_from_civil.
        let y = if month <= 2 { year - 1 } else { year };
        let era = if y >= 0 { y } else { y - 399 } / 400;
        let yoe = y - era * 400;
        let mp = ((month as i64) + 9) % 12;
        let doy = (153 * mp + 2) / 5 + day as i64 - 1;
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        era * 146_097 + doe - 719_468
    };
    let month_index = |name: &str| MONTHS.iter().position(|m| *m == name);

    // IMF-fixdate: "Mon, 02 Jan 2006 15:04:05 GMT"
    let parts: Vec<&str> = text.split_whitespace().collect();
    if parts.len() >= 5 && parts[0].ends_with(',') {
        let day = parts[1].parse::<u32>().ok();
        let month = month_index(&parts[2].to_lowercase());
        let year = parts[3].parse::<i64>().ok();
        let time: Vec<&str> = parts[4].split(':').collect();
        let (hour, minute, second) = match time.as_slice() {
            [h, m, s] => (
                h.parse::<i64>().ok(),
                m.parse::<i64>().ok(),
                s.parse::<i64>().ok(),
            ),
            _ => (None, None, None),
        };
        if let (Some(day), Some(month), Some(year), Some(hour), Some(minute), Some(second)) =
            (day, month, year, hour, minute, second)
        {
            let zone = parts.get(5).map(|z| z.to_uppercase()).unwrap_or_default();
            if zone == "GMT" || zone == "UT" || zone == "Z" {
                let days = days_from_civil(year, month as u32 + 1, day);
                return checked_epoch_ms(days, hour, minute, second, 0, 0);
            }
        }
        return None;
    }

    // ISO-8601: YYYY-MM-DD[T ]HH:MM[:SS[.fff]][Z|±HH[:MM]]
    let bytes = text.as_bytes();
    if bytes.len() < 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let year = text[0..4].parse::<i64>().ok()?;
    let month = text[5..7].parse::<u32>().ok()?;
    let day = text[8..10].parse::<u32>().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let (mut hour, mut minute, mut second, mut millis) = (0i64, 0i64, 0i64, 0i64);
    let mut offset_minutes = 0i64;
    if bytes.len() > 10 {
        let rest = &text[11..];
        let (time_part, zone_part) = match rest.find(['Z', '+', '-']) {
            Some(index) => (&rest[..index], Some(&rest[index..])),
            None => (rest, None),
        };
        let time_segments: Vec<&str> = time_part.split(':').collect();
        hour = time_segments.first()?.parse().ok()?;
        minute = time_segments
            .get(1)
            .map(|m| m.parse().unwrap_or(0))
            .unwrap_or(0);
        if let Some(seconds_part) = time_segments.get(2) {
            let (whole, fractional) = match seconds_part.split_once('.') {
                Some((w, f)) => (w, f),
                None => (*seconds_part, ""),
            };
            second = whole.parse().ok()?;
            if !fractional.is_empty() {
                let digits = fractional.chars().take(3).collect::<String>();
                let padded = format!("{digits:0<3}");
                millis = padded.parse().unwrap_or(0);
            }
        }
        if let Some(zone) = zone_part {
            if zone == "Z" {
                offset_minutes = 0;
            } else {
                let sign = if zone.starts_with('-') { -1 } else { 1 };
                let digits: String = zone[1..].chars().filter(|c| c.is_ascii_digit()).collect();
                let (zone_hour, zone_minute) = match digits.len() {
                    4 => (
                        digits[..2].parse::<i64>().ok()?,
                        digits[2..].parse::<i64>().ok()?,
                    ),
                    2 => (digits.parse::<i64>().ok()?, 0),
                    _ => return None,
                };
                offset_minutes = sign * (zone_hour * 60 + zone_minute);
            }
        }
    }
    let days = days_from_civil(year, month, day);
    checked_epoch_ms(days, hour, minute, second, offset_minutes, millis)
}

/// `Date.parse` yields NaN for dates outside the JS `Date` range
/// (±100,000,000 days); the checked arithmetic returns `None` for the same
/// inputs instead of overflowing `i64` on provider-controlled strings.
fn checked_epoch_ms(
    days: i64,
    hour: i64,
    minute: i64,
    second: i64,
    offset_minutes: i64,
    millis: i64,
) -> Option<i64> {
    const MAX_DATE_MS: i64 = 86_400_000_000_000_000;
    let seconds = days
        .checked_mul(86_400)?
        .checked_add(hour.checked_mul(3_600)?)?
        .checked_add(minute.checked_mul(60)?)?
        .checked_add(second)?;
    let ms = seconds
        .checked_mul(1_000)?
        .checked_sub(offset_minutes.checked_mul(60)?.checked_mul(1_000)?)?
        .checked_add(millis)?;
    ((-MAX_DATE_MS..=MAX_DATE_MS).contains(&ms)).then_some(ms)
}

/// `resolveProviderRetryDelayMs(attemptIndex, response)` — exponential
/// backoff capped at 2s, tightened by a numeric or date `Retry-After`.
pub fn resolve_provider_retry_delay_ms(
    attempt: u32,
    response_headers: Option<&Json>,
    now_ms: u64,
) -> u64 {
    let fallback = (250.0 * (2f64).powi(attempt as i32)).min(2_000.0) as u64;
    let headers = match response_headers {
        Some(Json::Object(_)) => response_headers.unwrap(),
        _ => return fallback,
    };
    let retry_after = headers.get("retry-after").cloned().unwrap_or(Json::Null);
    resolve_retry_after_ms(&retry_after, fallback, now_ms)
}

// ---- I/O half: Supabase config + the retrying provider fetch ----

/// `AbortSignal.timeout(15_000)` on the Supabase REST lookups.
const SUPABASE_LOOKUP_TIMEOUT_MS: u64 = 15_000;

/// The injected I/O surface of the provider lane: env + DNS + transport plus
/// the wall clock and sleep hook. `allow_unresolved` mirrors the JS
/// `globalThis.fetch !== nativeProviderFetch` harness flag — strict DNS in
/// production, lenient when the transport is a test stub.
pub struct ProviderIo<'a> {
    pub env: EnvReader<'a>,
    pub dns: DnsLookup<'a>,
    pub transport: HttpTransport<'a>,
    pub now_ms: u64,
    pub sleep_ms: &'a dyn Fn(u64),
    pub allow_unresolved: bool,
}

/// `fetchSupabaseRows(table, query)` — `Ok(None)` without a REST config, the
/// decoded rows (or `[]` when the body is empty or unparseable) otherwise.
fn fetch_supabase_rows(
    table: &str,
    query: &[(&str, Json)],
    env: EnvReader<'_>,
    transport: HttpTransport<'_>,
) -> Result<Option<Json>, String> {
    let rest_config = match get_supabase_rest_config(env) {
        Some(config) => config,
        None => return Ok(None),
    };

    let mut url = Url::parse(&format!("{}/{table}", rest_config.rest_url))
        .map_err(|_| "Invalid URL".to_string())?;
    {
        let mut pairs = url.query_pairs_mut();
        for (key, value) in query {
            // `value !== undefined && value !== null && value !== ''`
            if value.is_null() || value.as_str() == Some("") {
                continue;
            }
            pairs.append_pair(key, &js_stringify(value));
        }
    }

    let response = (transport)(&HttpRequest {
        url: url.to_string(),
        method: "GET".to_string(),
        headers: vec![
            ("apikey".to_string(), rest_config.api_key.clone()),
            (
                "authorization".to_string(),
                format!("Bearer {}", rest_config.api_key),
            ),
            ("accept".to_string(), "application/json".to_string()),
        ],
        body: None,
        timeout_ms: SUPABASE_LOOKUP_TIMEOUT_MS,
        follow_redirects: true,
    })?;

    if !(200..300).contains(&response.status) {
        let text = String::from_utf8_lossy(&response.body).into_owned();
        return Err(format!(
            "supabase {table} lookup failed: {} {}",
            response.status, text
        )
        .trim()
        .to_string());
    }
    let text = String::from_utf8_lossy(&response.body).into_owned();
    if text.is_empty() {
        return Ok(Some(Json::Array(Vec::new())));
    }
    Ok(Some(
        serde_json::from_str::<Json>(&text).unwrap_or(Json::Array(Vec::new())),
    ))
}

/// `loadProjectProviderConfig(projectSlug, providerId, network)` — the
/// 30s-cached `{network}:{slug}:{provider}` Supabase row.
fn load_project_provider_config(
    project_slug: &str,
    provider_id: &str,
    network: &str,
    env: EnvReader<'_>,
    transport: HttpTransport<'_>,
    runtime: &mut ProviderRuntime,
    now_ms: u64,
) -> Result<Option<Json>, String> {
    let normalized_project_slug = js_trim_string(Some(&Json::String(project_slug.to_string())));
    let normalized_provider_id = normalize_provider_id(&Json::String(provider_id.to_string()));
    if normalized_project_slug.is_empty() || normalized_provider_id.is_empty() {
        return Ok(None);
    }

    let cache_key = format!("{network}:{normalized_project_slug}:{normalized_provider_id}");
    if let Some(cached) = runtime.config_cache.get(&cache_key, now_ms) {
        return Ok(cached.clone());
    }

    let projects = fetch_supabase_rows(
        "morpheus_projects",
        &[
            ("select", Json::String("id,slug".to_string())),
            ("network", Json::String(format!("eq.{network}"))),
            (
                "slug",
                Json::String(format!("eq.{normalized_project_slug}")),
            ),
            ("limit", Json::Number(1.into())),
        ],
        env,
        transport,
    )?;
    let project_id = match &projects {
        Some(Json::Array(rows)) => rows
            .first()
            .and_then(|row| row.get("id"))
            .cloned()
            .unwrap_or(Json::Null),
        _ => Json::Null,
    };
    if !js_truthy(&project_id) {
        runtime.config_cache.set_capped(
            &cache_key,
            now_ms + PROVIDER_CONFIG_CACHE_TTL_MS,
            None,
            provider_cache_max_entries(env),
            now_ms,
        );
        return Ok(None);
    }

    let configs = fetch_supabase_rows(
        "morpheus_provider_configs",
        &[
            (
                "select",
                Json::String("provider_id,enabled,config,created_at,updated_at".to_string()),
            ),
            ("network", Json::String(format!("eq.{network}"))),
            (
                "project_id",
                Json::String(format!("eq.{}", js_stringify(&project_id))),
            ),
            (
                "provider_id",
                Json::String(format!("eq.{normalized_provider_id}")),
            ),
            ("limit", Json::Number(1.into())),
        ],
        env,
        transport,
    )?;
    let value = match configs {
        Some(Json::Array(rows)) => rows.into_iter().next().unwrap_or(Json::Null),
        _ => Json::Null,
    };
    runtime.config_cache.set_capped(
        &cache_key,
        now_ms + PROVIDER_CONFIG_CACHE_TTL_MS,
        Some(value.clone()),
        provider_cache_max_entries(env),
        now_ms,
    );
    Ok(Some(value))
}

/// `resolveProviderPayload(payload, options)` — resolves the provider id from
/// the payload (or the feed-symbol prefix), merges the project's configured
/// params under the payload's, and rejects disabled providers. Returns
/// `(resolvedPayload, providerConfig)`.
pub fn resolve_provider_payload(
    payload: &Json,
    options: &Json,
    env: EnvReader<'_>,
    transport: HttpTransport<'_>,
    runtime: &mut ProviderRuntime,
    now_ms: u64,
) -> Result<(Json, Option<Json>), String> {
    let fallback_provider_id = normalize_provider_id(
        &js_first_truthy(options, &["fallbackProviderId"])
            .cloned()
            .unwrap_or(Json::String(String::new())),
    );
    let inferred_symbol = js_first_truthy(payload, &["symbol"])
        .cloned()
        .or_else(|| js_first_truthy(payload, &["pair"]).cloned())
        .or_else(|| {
            payload
                .get("provider_params")
                .filter(|params| is_plain_object(params))
                .and_then(|params| params.get("pair"))
                .cloned()
        })
        .unwrap_or(Json::String(String::new()));
    let inferred_provider_id = normalize_provider_id(&Json::String(
        infer_provider_id_from_pair_symbol(&inferred_symbol),
    ));
    let provider_id = match js_first_truthy(payload, &["provider"])
        .cloned()
        .or_else(|| js_first_truthy(payload, &["source"]).cloned())
        .or_else(|| js_first_truthy(payload, &["provider_id"]).cloned())
    {
        Some(value) => normalize_provider_id(&value),
        None if !fallback_provider_id.is_empty() => fallback_provider_id,
        None => inferred_provider_id,
    };
    let project_slug = js_trim_string(Some(
        &js_first_truthy(payload, &["project_slug"])
            .cloned()
            .or_else(|| js_first_truthy(options, &["projectSlug"]).cloned())
            .unwrap_or(Json::String(String::new())),
    ));
    let network = resolve_payload_network_strict(
        payload,
        &resolve_supabase_network(
            &js_first_truthy(options, &["network"])
                .cloned()
                .unwrap_or(Json::Null),
            env,
        )?,
    )?;

    let mut resolved_map = match payload {
        Json::Object(map) => map.clone(),
        _ => serde_json::Map::new(),
    };
    if !provider_id.is_empty() {
        resolved_map.insert("provider".to_string(), Json::String(provider_id.clone()));
    }
    if !project_slug.is_empty() {
        resolved_map.insert(
            "project_slug".to_string(),
            Json::String(project_slug.clone()),
        );
    }
    if !network.is_empty() {
        resolved_map.insert("network".to_string(), Json::String(network.clone()));
    }
    if payload.get("provider_params").is_some() {
        resolved_map.insert(
            "provider_params".to_string(),
            coerce_provider_params(payload.get("provider_params").unwrap_or(&Json::Null)),
        );
    }

    if provider_id.is_empty() || project_slug.is_empty() {
        return Ok((Json::Object(resolved_map), None));
    }

    let provider_config = load_project_provider_config(
        &project_slug,
        &provider_id,
        &network,
        env,
        transport,
        runtime,
        now_ms,
    )?;
    let provider_config = match provider_config {
        Some(config) => config,
        None => return Ok((Json::Object(resolved_map), None)),
    };

    if matches!(provider_config.get("enabled"), Some(Json::Bool(false))) {
        return Err(format!(
            "provider {provider_id} is disabled for project {project_slug}"
        ));
    }

    let mut merged_params = serde_json::Map::new();
    if let Json::Object(config_params) =
        coerce_provider_params(provider_config.get("config").unwrap_or(&Json::Null))
    {
        for (key, value) in config_params {
            merged_params.insert(key, value);
        }
    }
    if let Json::Object(payload_params) =
        coerce_provider_params(resolved_map.get("provider_params").unwrap_or(&Json::Null))
    {
        for (key, value) in payload_params {
            merged_params.insert(key, value);
        }
    }
    resolved_map.insert("provider".to_string(), Json::String(provider_id));
    resolved_map.insert("project_slug".to_string(), Json::String(project_slug));
    resolved_map.insert("provider_params".to_string(), Json::Object(merged_params));
    Ok((Json::Object(resolved_map), Some(provider_config)))
}

/// One `fetchProviderWithRetries` attempt — the JS `try` body. Transport
/// timeouts reword to the provider wording; everything else passes through.
fn send_provider_request(
    request: &ProviderRequestSpec,
    timeout_ms: u64,
    io: &ProviderIo<'_>,
) -> Result<ProviderFetchResult, String> {
    let response = (io.transport)(&HttpRequest {
        url: request.url.clone(),
        method: if request.method.is_empty() {
            "GET".to_string()
        } else {
            request.method.clone()
        },
        headers: request.headers.clone(),
        body: request.body.clone(),
        timeout_ms,
        // `redirect: 'error'` — a 30x must never be followed (the SSRF checks
        // only ran against the original URL).
        follow_redirects: false,
    })
    .map_err(|error| {
        if is_timeout_error(&error) {
            format!("provider fetch timed out after {timeout_ms}ms")
        } else {
            error
        }
    })?;

    let text = read_response_text_with_limit(
        &response,
        resolve_provider_response_max_body_bytes(io.env) as usize,
        "provider response",
    )?;

    let mut data = Json::Null;
    if !text.is_empty() {
        data =
            serde_json::from_str::<Json>(&text).unwrap_or_else(|_| json!({ "raw": text.clone() }));
    }

    let payload_error = detect_provider_payload_error(&request.provider, response.status, &data);
    let status = payload_error
        .as_ref()
        .and_then(|error| error.get("status"))
        .map(js_to_number)
        .filter(|status| status.is_finite() && *status > 0.0)
        .map(|status| status as u16)
        .unwrap_or(response.status);
    let header_object = {
        let mut map = serde_json::Map::new();
        for (name, value) in &response.headers {
            map.insert(name.clone(), Json::String(value.clone()));
        }
        JsHeaders::normalize(&Json::Object(map)).to_object()
    };

    Ok(ProviderFetchResult {
        ok: (200..300).contains(&response.status) && payload_error.is_none(),
        status,
        headers: header_object,
        text,
        data,
        provider_error: payload_error,
    })
}

/// `fetchProviderWithRetries(requestSpec, timeoutMs)` — bounded retries on
/// transient statuses and transport errors. URL-parse and SSRF errors sit
/// outside the retryable surface and abort the whole fetch.
fn fetch_provider_with_retries(
    request: &ProviderRequestSpec,
    timeout_ms: u64,
    io: &ProviderIo<'_>,
) -> Result<ProviderFetchResult, String> {
    let total_attempts = resolve_provider_retry_count(io.env) + 1;
    for attempt in 0..total_attempts {
        let parsed_url = Url::parse(request.url.trim()).map_err(|_| "Invalid URL".to_string())?;
        let hostname = parsed_url.host_str().unwrap_or_default().to_string();
        resolve_pinned_addresses(&Json::String(hostname), io.allow_unresolved, io.dns)?;
        // Pinning the connection to the resolved addresses is a host concern:
        // the reqwest transport has no lookup hook, so the validation above is
        // the security boundary (re-run on every attempt).

        match send_provider_request(request, timeout_ms, io) {
            Ok(result) => {
                if !result.ok
                    && attempt + 1 < total_attempts
                    && is_retryable_provider_status(result.status)
                {
                    let delay =
                        resolve_provider_retry_delay_ms(attempt, Some(&result.headers), io.now_ms);
                    (io.sleep_ms)(delay);
                    continue;
                }
                return Ok(result);
            }
            Err(error) => {
                if attempt + 1 >= total_attempts || !is_retryable_provider_error(&error) {
                    return Err(error);
                }
                let delay = resolve_provider_retry_delay_ms(attempt, None, io.now_ms);
                (io.sleep_ms)(delay);
            }
        }
    }
    Err("provider fetch failed".to_string())
}

/// `fetchProviderJSON(requestSpec, timeoutMs)` — SSRF-validated, cached and
/// circuit-broken provider fetch. The in-flight promise dedup map is a
/// concurrency primitive the blocking lanes cannot have; identical requests
/// simply re-fetch inside the cache TTL window.
pub fn fetch_provider_json(
    request: &ProviderRequestSpec,
    timeout_ms: u64,
    io: &ProviderIo<'_>,
    runtime: &mut ProviderRuntime,
) -> Result<ProviderFetchResult, String> {
    // Validate once before circuit-breaker accounting so rejected internal
    // targets cannot trip the provider's breaker for legitimate traffic.
    let parsed_url = Url::parse(request.url.trim()).map_err(|_| "Invalid URL".to_string())?;
    let hostname = parsed_url.host_str().unwrap_or_default().to_string();
    resolve_pinned_addresses(&Json::String(hostname), io.allow_unresolved, io.dns)?;

    let provider_id = normalize_provider_id(&Json::String(request.provider.clone()));
    if !provider_id.is_empty() {
        let allowed = runtime
            .get_or_create_breaker(&provider_id, io.env)
            .allow(io.now_ms);
        if !allowed {
            return Err(format!("provider {provider_id} circuit breaker is open"));
        }
    }

    let cache_key = build_provider_cache_key(request)?;
    let cache_ttl_ms = resolve_provider_response_cache_ttl_ms(io.env);
    if !cache_key.is_empty() {
        if let Some(cached) = runtime.response_cache.get(&cache_key, io.now_ms) {
            return Ok(cached.clone());
        }
    }

    match fetch_provider_with_retries(request, timeout_ms, io) {
        Ok(result) => {
            if !cache_key.is_empty() && cache_ttl_ms > 0 && result.ok {
                runtime.response_cache.set_capped(
                    &cache_key,
                    io.now_ms + cache_ttl_ms,
                    result.clone(),
                    provider_cache_max_entries(io.env),
                    io.now_ms,
                );
            }
            if !provider_id.is_empty() {
                let breaker = runtime.get_or_create_breaker(&provider_id, io.env);
                if result.ok {
                    breaker.record_success();
                } else {
                    breaker.record_failure(io.now_ms);
                }
            }
            Ok(result)
        }
        Err(error) => {
            if !provider_id.is_empty() {
                runtime
                    .get_or_create_breaker(&provider_id, io.env)
                    .record_failure(io.now_ms);
            }
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ssrf::ResolvedAddress;
    use crate::transport::{HttpRequest, HttpResponse};
    use std::cell::RefCell;
    use std::rc::Rc;

    fn env_from(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect();
        move |name| map.get(name).cloned()
    }

    #[test]
    fn provider_network_rejects_unknown_explicit_labels() {
        let env = env_from(&[("MORPHEUS_NETWORK", "mainnet")]);
        assert_eq!(
            resolve_supabase_network(&json!("testnet"), &env).unwrap(),
            "testnet"
        );
        assert!(resolve_supabase_network(&json!("staging"), &env).is_err());
    }

    fn dns_from(addresses: &[&str]) -> impl Fn(&str) -> Result<Vec<ResolvedAddress>, ()> {
        let resolved: Vec<ResolvedAddress> = addresses
            .iter()
            .map(|address| ResolvedAddress {
                address: address.to_string(),
                family: 4,
            })
            .collect();
        move |_host| Ok(resolved.clone())
    }

    fn json_response(status: u16, body: &str) -> HttpResponse {
        HttpResponse {
            status,
            headers: vec![("content-type".to_string(), "application/json".to_string())],
            body: body.as_bytes().to_vec(),
        }
    }

    fn twelvedata_request(url: &str) -> ProviderRequestSpec {
        ProviderRequestSpec {
            provider: "twelvedata".to_string(),
            pair: "NEO-USD".to_string(),
            method: "GET".to_string(),
            url: url.to_string(),
            headers: Vec::new(),
            body: None,
            auth_mode: "query".to_string(),
        }
    }

    #[test]
    fn fetch_provider_json_reuses_a_short_lived_cached_response() {
        let env_fn = env_from(&[
            ("MORPHEUS_PROVIDER_RESPONSE_CACHE_TTL_MS", "5000"),
            ("MORPHEUS_PROVIDER_FETCH_RETRIES", "0"),
        ]);
        let calls = Rc::new(RefCell::new(0u32));
        let calls_for_transport = calls.clone();
        let transport_fn = move |_request: &HttpRequest| {
            *calls_for_transport.borrow_mut() += 1;
            Ok(json_response(200, "{\"price\":\"12.34\"}"))
        };
        let dns_fn = dns_from(&["93.184.216.34"]);
        let sleep_fn = |_ms: u64| {};
        let mut runtime = ProviderRuntime::default();
        let request = twelvedata_request(
            "https://api.twelvedata.com/price?symbol=NEO%2FUSD&apikey=secret-key",
        );
        {
            let io = ProviderIo {
                env: &env_fn,
                dns: &dns_fn,
                transport: &transport_fn,
                now_ms: 1_000,
                sleep_ms: &sleep_fn,
                allow_unresolved: false,
            };
            let first = fetch_provider_json(&request, 2_500, &io, &mut runtime).unwrap();
            let second = fetch_provider_json(&request, 2_500, &io, &mut runtime).unwrap();
            assert!(first.ok);
            assert!(second.ok);
            assert_eq!(*calls.borrow(), 1);
            assert_eq!(second.data.get("price"), Some(&json!("12.34")));
        }
        // Past the TTL the cache misses and the fetch runs again.
        let io = ProviderIo {
            env: &env_fn,
            dns: &dns_fn,
            transport: &transport_fn,
            now_ms: 7_000,
            sleep_ms: &sleep_fn,
            allow_unresolved: false,
        };
        let _third = fetch_provider_json(&request, 2_500, &io, &mut runtime).unwrap();
        assert_eq!(*calls.borrow(), 2);
    }

    #[test]
    fn fetch_provider_json_retries_transient_upstream_failures_before_succeeding() {
        let env_fn = env_from(&[
            ("MORPHEUS_PROVIDER_RESPONSE_CACHE_TTL_MS", "0"),
            ("MORPHEUS_PROVIDER_FETCH_RETRIES", "2"),
        ]);
        let calls = Rc::new(RefCell::new(0u32));
        let calls_for_transport = calls.clone();
        let transport_fn = move |_request: &HttpRequest| {
            *calls_for_transport.borrow_mut() += 1;
            if *calls_for_transport.borrow() == 1 {
                return Ok(HttpResponse {
                    status: 503,
                    headers: vec![
                        ("content-type".to_string(), "application/json".to_string()),
                        ("retry-after".to_string(), "0".to_string()),
                    ],
                    body: b"{\"error\":\"temporary overload\"}".to_vec(),
                });
            }
            Ok(json_response(200, "{\"price\":\"42.00\"}"))
        };
        let dns_fn = dns_from(&["93.184.216.34"]);
        let sleeps = Rc::new(RefCell::new(Vec::<u64>::new()));
        let sleeps_for_test = sleeps.clone();
        let sleep_fn = move |ms: u64| sleeps_for_test.borrow_mut().push(ms);
        let mut runtime = ProviderRuntime::default();
        let io = ProviderIo {
            env: &env_fn,
            dns: &dns_fn,
            transport: &transport_fn,
            now_ms: 1_000,
            sleep_ms: &sleep_fn,
            allow_unresolved: false,
        };
        let request = ProviderRequestSpec {
            provider: "coinbase-spot".to_string(),
            pair: "NEO-USD".to_string(),
            method: "GET".to_string(),
            url: "https://api.coinbase.com/v2/prices/NEO-USD/spot".to_string(),
            headers: Vec::new(),
            body: None,
            auth_mode: "none".to_string(),
        };
        let result = fetch_provider_json(&request, 2_500, &io, &mut runtime).unwrap();
        assert!(result.ok);
        assert_eq!(result.status, 200);
        assert_eq!(*calls.borrow(), 2);
        assert_eq!(result.data.get("price"), Some(&json!("42.00")));
        assert_eq!(*sleeps.borrow(), vec![0]);
    }

    #[test]
    fn fetch_provider_json_refuses_redirects_on_the_final_provider_request() {
        let env_fn = env_from(&[]);
        let observed = Rc::new(RefCell::new(None));
        let observed_for_transport = observed.clone();
        let transport_fn = move |request: &HttpRequest| {
            *observed_for_transport.borrow_mut() = Some(request.follow_redirects);
            Ok(json_response(200, "{\"price\":\"11.11\"}"))
        };
        let dns_fn = dns_from(&["93.184.216.34"]);
        let sleep_fn = |_ms: u64| {};
        let mut runtime = ProviderRuntime::default();
        let io = ProviderIo {
            env: &env_fn,
            dns: &dns_fn,
            transport: &transport_fn,
            now_ms: 1_000,
            sleep_ms: &sleep_fn,
            allow_unresolved: false,
        };
        let request = ProviderRequestSpec {
            provider: "coinbase-spot".to_string(),
            pair: "NEO-USD".to_string(),
            method: "GET".to_string(),
            url: "https://api.coinbase.com/v2/prices/NEO-USD/spot".to_string(),
            headers: Vec::new(),
            body: None,
            auth_mode: "none".to_string(),
        };
        let result = fetch_provider_json(&request, 2_500, &io, &mut runtime).unwrap();
        assert!(result.ok);
        // `redirect: 'error'` — a 30x must never be followed.
        assert_eq!(*observed.borrow(), Some(false));
    }

    #[test]
    fn fetch_provider_json_opens_the_circuit_after_repeated_failures() {
        let env_fn = env_from(&[
            ("MORPHEUS_PROVIDER_FAILURE_THRESHOLD", "3"),
            ("MORPHEUS_PROVIDER_RESPONSE_CACHE_TTL_MS", "0"),
        ]);
        let calls = Rc::new(RefCell::new(0u32));
        let calls_for_transport = calls.clone();
        let transport_fn = move |_request: &HttpRequest| {
            *calls_for_transport.borrow_mut() += 1;
            Ok(json_response(500, "{\"error\":\"boom\"}"))
        };
        let dns_fn = dns_from(&["93.184.216.34"]);
        let sleep_fn = |_ms: u64| {};
        let mut runtime = ProviderRuntime::default();
        let io = ProviderIo {
            env: &env_fn,
            dns: &dns_fn,
            transport: &transport_fn,
            now_ms: 1_000,
            sleep_ms: &sleep_fn,
            allow_unresolved: false,
        };
        let request = ProviderRequestSpec {
            provider: "binance-spot".to_string(),
            pair: "NEO-USD".to_string(),
            method: "GET".to_string(),
            url: "https://api1.binance.com/api/v3/ticker/price?symbol=NEOUSDT".to_string(),
            headers: Vec::new(),
            body: None,
            auth_mode: "none".to_string(),
        };
        for _ in 0..3 {
            let result = fetch_provider_json(&request, 2_500, &io, &mut runtime).unwrap();
            assert!(!result.ok);
            assert_eq!(result.status, 500);
        }
        assert_eq!(*calls.borrow(), 3);
        let error = fetch_provider_json(&request, 2_500, &io, &mut runtime).unwrap_err();
        assert_eq!(error, "provider binance-spot circuit breaker is open");
        assert_eq!(*calls.borrow(), 3);
        assert!(runtime.get_state("binance-spot").is_some());
    }

    #[test]
    fn transport_timeouts_reword_to_the_provider_timeout_error_and_retry() {
        let env_fn = env_from(&[("MORPHEUS_PROVIDER_FETCH_RETRIES", "1")]);
        let calls = Rc::new(RefCell::new(0u32));
        let calls_for_transport = calls.clone();
        let transport_fn = move |_request: &HttpRequest| {
            *calls_for_transport.borrow_mut() += 1;
            Err("oracle fetch timed out after 8000ms".to_string())
        };
        let dns_fn = dns_from(&["93.184.216.34"]);
        let sleeps = Rc::new(RefCell::new(Vec::<u64>::new()));
        let sleeps_for_test = sleeps.clone();
        let sleep_fn = move |ms: u64| sleeps_for_test.borrow_mut().push(ms);
        let mut runtime = ProviderRuntime::default();
        let io = ProviderIo {
            env: &env_fn,
            dns: &dns_fn,
            transport: &transport_fn,
            now_ms: 1_000,
            sleep_ms: &sleep_fn,
            allow_unresolved: false,
        };
        let request = twelvedata_request("https://api.twelvedata.com/price?symbol=NEO%2FUSD");
        let error = fetch_provider_json(&request, 8_000, &io, &mut runtime).unwrap_err();
        assert_eq!(error, "provider fetch timed out after 8000ms");
        assert_eq!(*calls.borrow(), 2);
        assert_eq!(*sleeps.borrow(), vec![250]);
    }

    #[test]
    fn fetch_provider_json_blocks_private_internal_hosts() {
        let env_fn = env_from(&[("MORPHEUS_ALLOW_UNSAFE_PROVIDER_BASE_URL_OVERRIDE", "true")]);
        let calls = Rc::new(RefCell::new(0u32));
        let calls_for_transport = calls.clone();
        let transport_fn = move |_request: &HttpRequest| {
            *calls_for_transport.borrow_mut() += 1;
            Ok(json_response(200, "{}"))
        };
        let dns_fn = dns_from(&["169.254.169.254"]);
        let sleep_fn = |_ms: u64| {};
        let mut runtime = ProviderRuntime::default();
        let io = ProviderIo {
            env: &env_fn,
            dns: &dns_fn,
            transport: &transport_fn,
            now_ms: 1_000,
            sleep_ms: &sleep_fn,
            allow_unresolved: false,
        };
        for url in [
            "http://169.254.169.254/latest/meta-data/",
            "http://127.0.0.1:8080/api/v3/ticker/price",
            "http://[::1]/x",
            "http://10.0.0.5/x",
        ] {
            let request = ProviderRequestSpec {
                provider: "binance-spot".to_string(),
                pair: "NEO-USD".to_string(),
                method: "GET".to_string(),
                url: url.to_string(),
                headers: Vec::new(),
                body: None,
                auth_mode: "none".to_string(),
            };
            let error = fetch_provider_json(&request, 2_000, &io, &mut runtime).unwrap_err();
            assert_eq!(error, "private/internal URLs not allowed", "{url}");
        }
        // Rejected before the transport and before breaker accounting.
        assert_eq!(*calls.borrow(), 0);
        assert_eq!(runtime.get_state("binance-spot"), None);
    }

    #[test]
    fn provider_caches_evict_like_the_js_capped_map() {
        // Oldest entries are evicted first above the ceiling (C2).
        let mut cache: TtlCache<u64> = TtlCache::default();
        let max = 5;
        let future = 60_000;
        for index in 0..(max + 20) {
            cache.set_capped(&format!("key-{index}"), future, index as u64, max, 1_000);
        }
        assert_eq!(cache.len(), max, "response cache must be bounded");
        assert!(!cache.contains_key("key-0"));
        assert!(cache.contains_key("key-24"));

        // Expired entries are reclaimed before fresh ones (C2).
        let mut cache: TtlCache<&str> = TtlCache::default();
        cache.set_capped("stale-a", 0, "a", 3, 1_000);
        cache.set_capped("stale-b", 0, "b", 3, 1_000);
        cache.set_capped("stale-c", 0, "c", 3, 1_000);
        cache.set_capped("fresh", future, "fresh", 3, 1_000);
        assert!(cache.len() <= 3);
        assert!(cache.contains_key("fresh"));

        // Re-setting an existing key refreshes recency without growth (C2).
        let mut cache: TtlCache<u64> = TtlCache::default();
        cache.set_capped("a", future, 1, 3, 1_000);
        cache.set_capped("b", future, 2, 3, 1_000);
        cache.set_capped("c", future, 3, 3, 1_000);
        cache.set_capped("a", future, 11, 3, 1_000);
        cache.set_capped("d", future, 4, 3, 1_000);
        assert_eq!(cache.len(), 3);
        assert!(cache.contains_key("a"), "recently-touched key survives");
        assert!(!cache.contains_key("b"), "oldest key is evicted");
    }

    #[test]
    fn builtin_provider_catalog_exposes_kernel_lane_compatibility_metadata() {
        let providers = list_builtin_providers();
        let items = providers.as_array().expect("catalog array");
        assert!(items.len() >= 3);
        for provider in items {
            assert!(provider.get("supports").and_then(Json::as_array).is_some());
            let kernel = provider
                .get("kernel_supports")
                .and_then(Json::as_array)
                .expect("kernel_supports");
            assert!(kernel.iter().any(|lane| lane == "oracle.fetch"));
            assert!(kernel.iter().any(|lane| lane == "feed.publish"));
        }
    }

    #[test]
    fn builtin_provider_request_builders_match_the_js_urls() {
        let env_fn = env_from(&[("TWELVEDATA_API_KEY", "secret-key")]);

        let twelvedata = build_provider_request(
            &json!({"provider": "twelvedata", "symbol": "TWELVEDATA:NEO-USD"}),
            &env_fn,
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            twelvedata.url,
            "https://api.twelvedata.com/price?symbol=NEO%2FUSD&apikey=secret-key"
        );
        assert_eq!(twelvedata.pair, "NEO-USD");
        assert_eq!(twelvedata.auth_mode, "query");

        let explicit = build_provider_request(
            &json!({
                "provider": "twelvedata",
                "provider_params": {"symbol": "BTC/USD", "endpoint": "time", "interval": "1min"}
            }),
            &env_fn,
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            explicit.url,
            "https://api.twelvedata.com/time?symbol=BTC%2FUSD&apikey=secret-key&interval=1min"
        );

        let binance = build_provider_request(
            &json!({"provider": "binance-spot", "symbol": "NEO-USD"}),
            &env_fn,
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            binance.url,
            "https://api1.binance.com/api/v3/ticker/price?symbol=NEOUSDT"
        );
        assert_eq!(binance.auth_mode, "none");

        let coinbase = build_provider_request(
            &json!({"provider": "coinbase-spot", "provider_params": {"symbol": "NEO-USD"}}),
            &env_fn,
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            coinbase.url,
            "https://api.coinbase.com/v2/prices/NEO-USD/spot"
        );

        // No provider named or inferable → None; unknown → error.
        assert!(build_provider_request(&json!({}), &env_fn)
            .unwrap()
            .is_none());
        let error = build_provider_request(&json!({"provider": "kraken"}), &env_fn).unwrap_err();
        assert_eq!(error, "unknown builtin provider: kraken");
    }

    #[test]
    fn binance_base_url_overrides_are_gated_behind_the_unsafe_flag() {
        let allowed_env = env_from(&[("MORPHEUS_ALLOW_UNSAFE_PROVIDER_BASE_URL_OVERRIDE", "true")]);
        let request = build_provider_request(
            &json!({"provider": "binance-spot", "provider_base_url": "https://mirror.example"}),
            &allowed_env,
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            request.url,
            "https://mirror.example/api/v3/ticker/price?symbol=NEOUSDT"
        );

        let default_env = env_from(&[]);
        let request = build_provider_request(
            &json!({"provider": "binance-spot", "provider_base_url": "https://mirror.example"}),
            &default_env,
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            request.url,
            "https://api1.binance.com/api/v3/ticker/price?symbol=NEOUSDT"
        );
    }

    #[test]
    fn provider_cache_keys_redact_the_apikey_query_parameter() {
        let request_a =
            twelvedata_request("https://api.twelvedata.com/price?symbol=NEO%2FUSD&apikey=secret-a");
        let request_b =
            twelvedata_request("https://api.twelvedata.com/price?symbol=NEO%2FUSD&apikey=secret-b");
        let key_a = build_provider_cache_key(&request_a).unwrap();
        let key_b = build_provider_cache_key(&request_b).unwrap();
        assert_eq!(key_a, key_b);
        assert!(!key_a.contains("secret"));

        // Non-GET requests are never cached.
        let mut post = twelvedata_request("https://api.twelvedata.com/price");
        post.method = "POST".to_string();
        assert_eq!(build_provider_cache_key(&post).unwrap(), "");
    }

    #[test]
    fn provider_payload_errors_surface_provider_status_and_message() {
        let twelvedata_error = detect_provider_payload_error(
            "twelvedata",
            200,
            &json!({"code": 512, "message": "invalid api keys"}),
        )
        .unwrap();
        assert_eq!(twelvedata_error.get("status"), Some(&json!(512)));
        assert_eq!(
            twelvedata_error.get("message"),
            Some(&json!("invalid api keys"))
        );

        let errors_payload = detect_provider_payload_error(
            "coinbase-spot",
            200,
            &json!({"errors": [{"param": "symbol"}]}),
        )
        .unwrap();
        assert_eq!(errors_payload.get("status"), Some(&json!(200)));
        assert_eq!(
            errors_payload.get("message"),
            Some(&json!("[{\"param\":\"symbol\"}]"))
        );

        assert!(
            detect_provider_payload_error("coinbase-spot", 200, &json!({"price": "1"})).is_none()
        );
        assert!(detect_provider_payload_error("coinbase-spot", 200, &json!([1, 2])).is_none());
    }

    #[test]
    fn retry_after_parsing_accepts_seconds_and_http_dates() {
        assert_eq!(resolve_retry_after_ms(&json!("2"), 250, 1_000), 2_000);
        assert_eq!(resolve_retry_after_ms(&json!("99"), 250, 1_000), 5_000);
        assert_eq!(resolve_retry_after_ms(&json!(""), 250, 1_000), 250);
        // 2026-01-01T00:00:01Z is far past the fixed clock → capped at 5s.
        assert_eq!(
            resolve_retry_after_ms(&json!("Thu, 01 Jan 2026 00:00:01 GMT"), 250, 1_000),
            5_000
        );
        assert_eq!(resolve_retry_after_ms(&json!("soon"), 250, 1_000), 250);
    }

    #[test]
    fn provider_env_parsing_matches_the_js_number_semantics() {
        let unset = env_from(&[]);
        // Number('') === 0 — an unset TTL disables the cache; only junk text
        // falls back to the 1.5s default.
        assert_eq!(resolve_provider_response_cache_ttl_ms(&unset), 0);
        let junk = env_from(&[("MORPHEUS_PROVIDER_RESPONSE_CACHE_TTL_MS", "abc")]);
        assert_eq!(resolve_provider_response_cache_ttl_ms(&junk), 1_500);
        let negative = env_from(&[("MORPHEUS_PROVIDER_RESPONSE_CACHE_TTL_MS", "-5")]);
        assert_eq!(resolve_provider_response_cache_ttl_ms(&negative), 0);

        assert_eq!(resolve_provider_retry_count(&unset), 0);
        let retries = env_from(&[("MORPHEUS_PROVIDER_FETCH_RETRIES", "3")]);
        assert_eq!(resolve_provider_retry_count(&retries), 3);

        // `Number(x) || fallback`: 0 and unset take the fallback.
        assert_eq!(provider_cache_max_entries(&unset), 500);
        let zero_entries = env_from(&[("MORPHEUS_PROVIDER_CACHE_MAX_ENTRIES", "0")]);
        assert_eq!(provider_cache_max_entries(&zero_entries), 500);
        let small_entries = env_from(&[("MORPHEUS_PROVIDER_CACHE_MAX_ENTRIES", "4")]);
        assert_eq!(provider_cache_max_entries(&small_entries), 16);

        assert_eq!(resolve_provider_response_max_body_bytes(&unset), 64 * 1024);
        let body = env_from(&[("ORACLE_MAX_PROVIDER_BODY_BYTES", "10")]);
        assert_eq!(resolve_provider_response_max_body_bytes(&body), 4_096);
    }

    #[test]
    fn resolve_provider_payload_merges_project_config_and_caches_it() {
        let env_fn = env_from(&[
            ("SUPABASE_URL", "https://sb.example"),
            ("SUPABASE_SECRET_KEY", "sk-test"),
        ]);
        let calls = Rc::new(RefCell::new(0u32));
        let urls = Rc::new(RefCell::new(Vec::<String>::new()));
        let calls_for_transport = calls.clone();
        let urls_for_transport = urls.clone();
        let transport_fn = move |request: &HttpRequest| {
            *calls_for_transport.borrow_mut() += 1;
            urls_for_transport.borrow_mut().push(request.url.clone());
            if request.url.contains("morpheus_projects") {
                return Ok(json_response(200, "[{\"id\":\"p1\",\"slug\":\"proj\"}]"));
            }
            if request.url.contains("morpheus_provider_configs") {
                return Ok(json_response(
                    200,
                    "[{\"provider_id\":\"binance-spot\",\"enabled\":true,\"config\":{\"base_url\":\"https://cfg.example\"}}]",
                ));
            }
            Err(format!("unexpected url {}", request.url))
        };
        let mut runtime = ProviderRuntime::default();
        let payload = json!({"provider": "binance-spot", "project_slug": "proj"});
        {
            let (resolved, config) = resolve_provider_payload(
                &payload,
                &json!({}),
                &env_fn,
                &transport_fn,
                &mut runtime,
                1_000,
            )
            .unwrap();
            assert_eq!(resolved.get("provider"), Some(&json!("binance-spot")));
            assert_eq!(resolved.get("project_slug"), Some(&json!("proj")));
            assert_eq!(resolved.get("network"), Some(&json!("testnet")));
            assert_eq!(
                resolved
                    .get("provider_params")
                    .and_then(|params| params.get("base_url")),
                Some(&json!("https://cfg.example"))
            );
            assert_eq!(
                config.and_then(|row| row.get("enabled").cloned()),
                Some(json!(true))
            );

            let recorded = urls.borrow();
            assert!(
                recorded[0].starts_with("https://sb.example/rest/v1/morpheus_projects?"),
                "{}",
                recorded[0]
            );
            assert!(recorded[0].contains("select=id%2Cslug"));
            assert!(recorded[0].contains("network=eq.testnet"));
            assert!(recorded[0].contains("slug=eq.proj"));
            assert!(recorded[0].contains("limit=1"));
            assert!(recorded[1].contains("morpheus_provider_configs"));
            assert!(recorded[1].contains("project_id=eq.p1"));
            assert!(recorded[1].contains("provider_id=eq.binance-spot"));
            assert_eq!(*calls.borrow(), 2);
        }
        // The second resolution is served from the 30s config cache.
        resolve_provider_payload(
            &payload,
            &json!({}),
            &env_fn,
            &transport_fn,
            &mut runtime,
            2_000,
        )
        .unwrap();
        assert_eq!(*calls.borrow(), 2);
    }

    #[test]
    fn resolve_provider_payload_rejects_disabled_providers() {
        let env_fn = env_from(&[
            ("SUPABASE_URL", "https://sb.example"),
            ("SUPABASE_SECRET_KEY", "sk-test"),
        ]);
        let transport_fn = move |request: &HttpRequest| {
            if request.url.contains("morpheus_projects") {
                return Ok(json_response(200, "[{\"id\":\"p1\",\"slug\":\"proj\"}]"));
            }
            if request.url.contains("morpheus_provider_configs") {
                return Ok(json_response(
                    200,
                    "[{\"provider_id\":\"binance-spot\",\"enabled\":false,\"config\":{}}]",
                ));
            }
            Err(format!("unexpected url {}", request.url))
        };
        let mut runtime = ProviderRuntime::default();
        let error = resolve_provider_payload(
            &json!({"provider": "binance-spot", "project_slug": "proj"}),
            &json!({}),
            &env_fn,
            &transport_fn,
            &mut runtime,
            1_000,
        )
        .unwrap_err();
        assert_eq!(error, "provider binance-spot is disabled for project proj");
    }

    #[test]
    fn resolve_provider_payload_returns_the_payload_unmerged_without_a_project_row() {
        let env_fn = env_from(&[
            ("SUPABASE_URL", "https://sb.example"),
            ("SUPABASE_SECRET_KEY", "sk-test"),
        ]);
        let calls = Rc::new(RefCell::new(0u32));
        let calls_for_transport = calls.clone();
        let transport_fn = move |request: &HttpRequest| {
            *calls_for_transport.borrow_mut() += 1;
            assert!(request.url.contains("morpheus_projects"));
            Ok(json_response(200, "[]"))
        };
        let mut runtime = ProviderRuntime::default();
        let payload = json!({"provider": "binance-spot", "project_slug": "proj"});
        let (resolved, config) = resolve_provider_payload(
            &payload,
            &json!({}),
            &env_fn,
            &transport_fn,
            &mut runtime,
            1_000,
        )
        .unwrap();
        assert!(config.is_none());
        assert_eq!(resolved.get("provider"), Some(&json!("binance-spot")));
        assert_eq!(resolved.get("project_slug"), Some(&json!("proj")));
        assert_eq!(resolved.get("network"), Some(&json!("testnet")));
        assert!(resolved.get("provider_params").is_none());
        assert_eq!(*calls.borrow(), 1);
        // The negative lookup is cached for the TTL window.
        resolve_provider_payload(
            &payload,
            &json!({}),
            &env_fn,
            &transport_fn,
            &mut runtime,
            2_000,
        )
        .unwrap();
        assert_eq!(*calls.borrow(), 1);
    }

    #[test]
    fn resolve_provider_payload_skips_the_config_lane_without_supabase_env() {
        let env_fn = env_from(&[]);
        let calls = Rc::new(RefCell::new(0u32));
        let calls_for_transport = calls.clone();
        let transport_fn = move |_request: &HttpRequest| {
            *calls_for_transport.borrow_mut() += 1;
            Err("no request should be made".to_string())
        };
        let mut runtime = ProviderRuntime::default();
        let (resolved, config) = resolve_provider_payload(
            &json!({"provider": "binance-spot", "project_slug": "proj"}),
            &json!({}),
            &env_fn,
            &transport_fn,
            &mut runtime,
            1_000,
        )
        .unwrap();
        assert!(config.is_none());
        assert_eq!(*calls.borrow(), 0);
        assert_eq!(resolved.get("provider"), Some(&json!("binance-spot")));
        assert_eq!(resolved.get("network"), Some(&json!("testnet")));
    }
}
