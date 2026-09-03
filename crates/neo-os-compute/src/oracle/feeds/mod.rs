//! Feed-lane modules ported from `workers/nitro-worker/src/oracle/feeds/`,
//! plus the pure helper half of `../feeds.js` itself: symbol and provider
//! resolution, quote-field extraction, fast-ack decisions, round ids and the
//! C2 canonical-aggregate / snapshot builders. The JS module is the
//! byte-level oracle; chain IO (feed-submit), state persistence (feed-state)
//! and the 5f handler wiring stay out until their lanes land, and every
//! `process.env` read arrives through a [`crate::core::EnvReader`].

use std::collections::HashSet;

use serde_json::{json, Map, Value as Json};

use crate::core::{env_for_network, EnvReader};
use crate::js::{
    js_first_truthy, js_iso_string_from_ms, js_number_to_string, js_stringify, js_to_fixed,
    js_to_number, js_trim, js_trim_string, js_truthy,
};
use crate::oracle::aggregation::{
    count_distinct_providers, meets_min_providers, CANONICAL_AGGREGATE_MIN_PROVIDERS,
};
use crate::oracle::decimal::{decimal_to_integer_string, integer_to_decimal_string};
use crate::oracle::feed_registry::{
    get_default_feed_symbols, get_feed_providers_for_pair, normalize_feed_pair_symbol,
};
use crate::oracle::feeds::shared::{
    has_own_payload_key, normalize_boolean_like, resolve_feed_network, resolve_feed_scope,
    FEED_PRICE_DECIMALS,
};
use crate::oracle::providers::{infer_provider_id_from_pair_symbol, parse_http_date_ms};

pub mod neo_stack_decode;
pub mod shared;
pub mod sync_policy;

/// `normalizePairSymbol(rawSymbol)` (feeds.js:133) — trim/uppercase, then a
/// provider-scoped `PROVIDER:PAIR` passthrough, an `A-B`/`A_B`/`A/B` split
/// with the USDT→USD quote remap, or a bare ticker treated as `*-USD`.
/// Everything funnels through [`normalize_feed_pair_symbol`].
pub fn normalize_pair_symbol(raw_symbol: Option<&Json>) -> String {
    let raw = js_trim_string(raw_symbol).to_uppercase();
    if raw.is_empty() {
        return "NEO-USD".to_string();
    }
    if raw.contains(':') {
        return normalize_feed_pair_symbol(&raw);
    }
    if let Some((base, quote)) = split_ascii_pair(&raw) {
        let quote = if quote == "USDT" { "USD" } else { quote };
        return normalize_feed_pair_symbol(&format!("{base}-{quote}"));
    }
    if let Some(base) = raw.strip_suffix("USDT") {
        return normalize_feed_pair_symbol(&format!("{base}-USD"));
    }
    if let Some(base) = raw.strip_suffix("USD") {
        return normalize_feed_pair_symbol(&format!("{base}-USD"));
    }
    normalize_feed_pair_symbol(&format!("{raw}-USD"))
}

/// The merged shape of the two `normalizePairSymbol` regexes
/// (`^[A-Z0-9]+-[A-Z0-9]+$` and `^[A-Z0-9]+[-/_][A-Z0-9]+$`): exactly one
/// separator in `[-/_]` with a non-empty `[A-Z0-9]` run on each side. A dash
/// matches both regexes with the same split; `/` and `_` only the second.
fn split_ascii_pair(raw: &str) -> Option<(&str, &str)> {
    let is_token = |c: char| c.is_ascii_uppercase() || c.is_ascii_digit();
    let mut split_at = None;
    for (index, c) in raw.char_indices() {
        if matches!(c, '-' | '/' | '_') {
            if split_at.is_some() {
                return None;
            }
            split_at = Some(index);
        } else if !is_token(c) {
            return None;
        }
    }
    let at = split_at?;
    let (base, quote) = (&raw[..at], &raw[at + 1..]);
    (!base.is_empty() && !quote.is_empty()).then_some((base, quote))
}

// C2 — provider ids are deduplicated here so a misconfiguration like
// MORPHEUS_FEED_PROVIDERS="twelvedata,twelvedata" cannot fan out into two quotes
// from a single source (which would then masquerade as a multi-provider
// aggregate). This is the upstream half of the defense; meetsMinProviders is the
// downstream guard.
fn dedupe_provider_ids(ids: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for id in ids {
        if seen.insert(id.clone()) {
            out.push(id);
        }
    }
    out
}

/// `parseProviderList(value, fallback)` — arrays and comma-separated strings
/// are trimmed, lowercased, emptied-out and deduplicated preserving order; an
/// absent or falsy non-array value returns the fallback.
pub fn parse_provider_list(value: Option<&Json>, fallback: Vec<String>) -> Vec<String> {
    if let Some(Json::Array(items)) = value {
        return dedupe_provider_ids(
            items
                .iter()
                .map(|entry| js_trim_string(Some(entry)).to_lowercase())
                .filter(|entry| !entry.is_empty())
                .collect(),
        );
    }
    let raw = js_trim_string(value);
    if raw.is_empty() {
        return fallback;
    }
    dedupe_provider_ids(
        raw.split(',')
            .map(js_trim)
            .map(str::to_lowercase)
            .filter(|entry| !entry.is_empty())
            .collect(),
    )
}

/// `resolveRequestedProviders(symbol, options)` — a provider-scoped symbol
/// pins its provider; explicit `providers`/`provider_list` or a single
/// `provider`/`source` follow; otherwise the network-configured
/// `MORPHEUS_FEED_PROVIDERS` list is filtered down to the pair's available
/// providers (falling back to twelvedata).
pub fn resolve_requested_providers(
    symbol: &str,
    options: &Json,
    env: EnvReader<'_>,
) -> Vec<String> {
    let inferred = js_trim(&infer_provider_id_from_pair_symbol(&Json::String(
        symbol.to_string(),
    )))
    .to_lowercase();
    if !inferred.is_empty() {
        return vec![inferred];
    }

    let explicit_providers = parse_provider_list(
        js_first_truthy(options, &["providers", "provider_list"]),
        Vec::new(),
    );
    if !explicit_providers.is_empty() {
        return explicit_providers;
    }

    let explicit_provider =
        js_trim_string(js_first_truthy(options, &["provider", "source"])).to_lowercase();
    if !explicit_provider.is_empty() && explicit_provider != "all" {
        return vec![explicit_provider];
    }

    let network = resolve_feed_network(options, env);
    let configured = parse_provider_list(
        Some(&Json::String(env_for_network(
            &network,
            &["MORPHEUS_FEED_PROVIDERS"],
            env,
        ))),
        Vec::new(),
    );
    let available = get_feed_providers_for_pair(symbol, env);
    if !configured.is_empty() {
        return configured
            .into_iter()
            .filter(|provider| available.is_empty() || available.iter().any(|id| id == provider))
            .collect();
    }
    if available.is_empty() {
        vec!["twelvedata".to_string()]
    } else {
        available
    }
}

/// `extractQuotePrice(response)` — the `??` chain over `data.price`,
/// `data.value`, `data.close` and `data.data.amount`; only null/absent
/// collapse, so a `0` price is kept. [`Json::Null`] is the JS `null`.
pub fn extract_quote_price(data: &Json) -> Json {
    let Some(fields) = data.as_object() else {
        return Json::Null;
    };
    for key in ["price", "value", "close"] {
        if let Some(value) = fields.get(key).filter(|value| !value.is_null()) {
            return value.clone();
        }
    }
    fields
        .get("data")
        .and_then(Json::as_object)
        .and_then(|inner| inner.get("amount"))
        .filter(|value| !value.is_null())
        .cloned()
        .unwrap_or(Json::Null)
}

/// `extractUpstreamTimestamp(response)` — the provider-side observation time
/// (prevents clock-skew: the recorded timestamp reflects when the price was
/// observed at the source, not when the worker processed it): TwelveData
/// `datetime` (string `Date.parse`), `timestamp`/`time` seconds-or-
/// milliseconds with the pre-2100 cutoff, the response `Date` header, then
/// the local clock. `Err` mirrors the JS `RangeError` when a pathological
/// number overflows the `Date` range.
pub fn extract_upstream_timestamp(
    data: &Json,
    headers: &Json,
    now_ms: i64,
) -> Result<String, String> {
    // JS `Date` spans ±100,000,000 days; `toISOString` throws RangeError
    // ("Invalid time value") outside it.
    const MAX_DATE_MS: f64 = 86_400_000_000_000_000.0;
    let iso_from_number = |ts: f64| -> Result<String, String> {
        let ms = if ts < 4_102_444_800.0 {
            ts * 1000.0
        } else {
            ts
        };
        if !ms.is_finite() || ms.abs() > MAX_DATE_MS {
            return Err("Invalid time value".to_string());
        }
        Ok(js_iso_string_from_ms(ms.trunc() as i64))
    };

    let fields = data.as_object();
    if let Some(value) = fields.and_then(|entry| entry.get("datetime")) {
        if js_truthy(value) {
            // Date.parse coerces via ToString, so `[2025]` parses like "2025".
            if let Some(parsed) = parse_http_date_ms(&js_stringify(value)) {
                return Ok(js_iso_string_from_ms(parsed));
            }
        }
    }
    for key in ["timestamp", "time"] {
        if let Some(value) = fields.and_then(|entry| entry.get(key)) {
            if js_truthy(value) {
                let ts = js_to_number(value);
                if ts.is_finite() && ts > 0.0 {
                    return iso_from_number(ts);
                }
            }
        }
    }
    if let Some(value) = headers.as_object().and_then(|entry| entry.get("date")) {
        if js_truthy(value) {
            if let Some(parsed) = parse_http_date_ms(&js_stringify(value)) {
                return Ok(js_iso_string_from_ms(parsed));
            }
        }
    }
    Ok(js_iso_string_from_ms(now_ms))
}

/// `shouldFastAckOracleFeed(payload)` — an explicit `fast_ack`/`fastAck`/
/// `async_ack`/`asyncAck` (first NON-null via the `??` chain, so `0` and
/// `false` count as explicit; an empty string does not) resolves through
/// [`normalize_boolean_like`]; otherwise an own `wait` key inverts
/// (`wait: true` → background task, 202).
pub fn should_fast_ack_oracle_feed(payload: &Json) -> bool {
    let explicit = payload.as_object().and_then(|fields| {
        ["fast_ack", "fastAck", "async_ack", "asyncAck"]
            .iter()
            .filter_map(|key| fields.get(*key))
            .find(|value| !value.is_null())
            .cloned()
    });
    if let Some(value) = explicit.filter(|value| *value != Json::String(String::new())) {
        return normalize_boolean_like(Some(&value), false);
    }
    if has_own_payload_key(payload, "wait") {
        return !normalize_boolean_like(payload.get("wait"), true);
    }
    false
}

/// `buildOracleFeedRequestId(payload)` — an explicit request id wins;
/// otherwise `pricefeed:{network}:{Date.now()}:{uuid}`. The clock and the
/// uuid source are injected.
pub fn build_oracle_feed_request_id(
    payload: &Json,
    env: EnvReader<'_>,
    now_ms: i64,
    random_uuid: impl Fn() -> String,
) -> String {
    let explicit = js_trim_string(js_first_truthy(payload, &["request_id", "requestId"]));
    if !explicit.is_empty() {
        return explicit;
    }
    format!(
        "pricefeed:{}:{now_ms}:{}",
        resolve_feed_network(payload, env),
        random_uuid()
    )
}

/// `buildRoundId(previousRecord)` — the last on-chain round id + 1, or the
/// wall clock in seconds when there is nothing to increment. A non-numeric
/// round id reproduces JS's `String(Number(x) + 1)` — `"NaN"`.
pub fn build_round_id(previous_record: Option<&Json>, now_ms: i64) -> String {
    let Some(record) = previous_record.and_then(Json::as_object) else {
        return (now_ms / 1000).to_string();
    };
    match record.get("round_id") {
        Some(value) if js_truthy(value) => js_number_to_string(js_to_number(value) + 1.0),
        _ => (now_ms / 1000).to_string(),
    }
}

/// `buildCanonicalAggregateStorageKey(pair)` — the C2 storage key for the
/// single canonical aggregated record of a pair. The per-provider records
/// (`PROVIDER:PAIR`) are single-source and never cross-checked against each
/// other; this canonical key holds the multi-provider aggregated value so a
/// consumer can read one tamper-resistant price per pair.
pub fn build_canonical_aggregate_storage_key(pair: &str) -> String {
    format!("AGG:{}", normalize_feed_pair_symbol(pair))
}

/// `buildCanonicalAggregateRecord(pair, aggregation, previousRecord)` — the
/// C2 guard: `None` unless at least [`CANONICAL_AGGREGATE_MIN_PROVIDERS`]
/// independent providers contributed, so a single-source value can never be
/// laundered into the canonical record. The price carries the aggregation's
/// median/mean output rather than any one provider's quote. `Err` mirrors a
/// JS throw from the decimal scaling of a pathological aggregate price.
pub fn build_canonical_aggregate_record(
    pair: &str,
    aggregation: &Json,
    previous_record: Option<&Json>,
    now_ms: i64,
) -> Result<Option<(String, Json)>, String> {
    if !meets_min_providers(aggregation, CANONICAL_AGGREGATE_MIN_PROVIDERS) {
        return Ok(None);
    }
    // `Number(undefined)` is NaN (absent → no record) but `Number(null)` is
    // 0 — a literal `price: null` stays in play as a zero price.
    let aggregated_price = match aggregation
        .as_object()
        .and_then(|fields| fields.get("price"))
    {
        Some(value) => js_to_number(value),
        None => f64::NAN,
    };
    if !aggregated_price.is_finite() {
        return Ok(None);
    }

    let storage_key = build_canonical_aggregate_storage_key(pair);
    // toFixed avoids exponential notation (e.g. 1e-7) that
    // decimalToIntegerString would reject, and bounds the float to the feed
    // scale before integer conversion.
    let price_decimal_string = integer_to_decimal_string(
        &Json::String(decimal_to_integer_string(
            &js_to_fixed(aggregated_price, FEED_PRICE_DECIMALS),
            FEED_PRICE_DECIMALS,
        )?),
        FEED_PRICE_DECIMALS,
    );
    let price_units = Json::String(decimal_to_integer_string(
        &price_decimal_string,
        FEED_PRICE_DECIMALS,
    )?);
    let round_id = build_round_id(previous_record, now_ms);

    let fields = aggregation.as_object();
    // Spread the previous record first, then overwrite in the JS literal's
    // property order (existing keys keep their original position, like the
    // JS object spread).
    let mut record = match previous_record {
        Some(Json::Object(previous)) => previous.clone(),
        _ => Map::new(),
    };
    record.insert(
        "storage_pair".to_string(),
        Json::String(storage_key.clone()),
    );
    record.insert(
        "pair".to_string(),
        Json::String(normalize_feed_pair_symbol(pair)),
    );
    record.insert("aggregate".to_string(), Json::Bool(true));
    record.insert(
        "aggregation_method".to_string(),
        fields
            .and_then(|entry| entry.get("method"))
            .cloned()
            .unwrap_or(Json::Null),
    );
    record.insert(
        "providers_used".to_string(),
        match fields.and_then(|entry| entry.get("providers_used")) {
            Some(Json::Array(items)) => Json::Array(items.clone()),
            _ => Json::Array(Vec::new()),
        },
    );
    record.insert(
        "providers_rejected".to_string(),
        match fields.and_then(|entry| entry.get("providers_rejected")) {
            Some(Json::Array(items)) => Json::Array(items.clone()),
            _ => Json::Array(Vec::new()),
        },
    );
    // C2 — count DISTINCT providers so a duplicated id can't inflate the count.
    record.insert(
        "provider_count".to_string(),
        Json::from(count_distinct_providers(aggregation)),
    );
    record.insert(
        "deviation_pct".to_string(),
        fields
            .and_then(|entry| entry.get("deviation_pct"))
            .cloned()
            .unwrap_or(Json::Null),
    );
    record.insert(
        "confidence".to_string(),
        fields
            .and_then(|entry| entry.get("confidence"))
            .cloned()
            .unwrap_or(Json::Null),
    );
    record.insert(
        "price".to_string(),
        Json::String(price_decimal_string.clone()),
    );
    record.insert("price_units".to_string(), price_units.clone());
    record.insert("round_id".to_string(), Json::String(round_id));
    record.insert(
        "last_observed_price".to_string(),
        Json::String(price_decimal_string),
    );
    record.insert("last_observed_price_units".to_string(), price_units);
    record.insert("last_observed_at_ms".to_string(), Json::from(now_ms));
    record.insert(
        "price_scale_decimals".to_string(),
        Json::from(FEED_PRICE_DECIMALS),
    );
    Ok(Some((storage_key, Json::Object(record))))
}

/// The `??` chain step: absent AND null collapse; `0` and `""` stay.
fn not_null(value: Option<&Json>) -> Option<&Json> {
    value.filter(|value| !value.is_null())
}

/// `buildFeedSnapshotRows(syncResults, state, batchTx, scope)` — the Supabase
/// snapshot projection of one sync pass, one row per sync result. The JS
/// signature carries a `targetChain` first argument, but it only feeds
/// `resolveFeedScope`'s discarded fallback, so the port drops it.
pub fn build_feed_snapshot_rows(
    sync_results: &Json,
    state: &Json,
    batch_tx: Option<&Json>,
    scope: &Json,
    env: EnvReader<'_>,
) -> Vec<Json> {
    let resolved_scope = resolve_feed_scope(scope, env);
    let Json::Array(results) = sync_results else {
        return Vec::new();
    };
    let mut rows = Vec::with_capacity(results.len());
    for result in results {
        let fields = result.as_object();
        let storage_pair = js_trim_string(
            fields
                .and_then(|entry| entry.get("storage_pair"))
                .filter(|value| js_truthy(value)),
        );
        let record = if storage_pair.is_empty() {
            Json::Object(Map::new())
        } else {
            state
                .as_object()
                .and_then(|state| state.get("records"))
                .and_then(Json::as_object)
                .and_then(|records| records.get(&storage_pair))
                .filter(|value| js_truthy(value))
                .cloned()
                .unwrap_or_else(|| Json::Object(Map::new()))
        };
        let quote = fields
            .and_then(|entry| entry.get("quote"))
            .filter(|value| js_truthy(value) && value.is_object())
            .cloned();
        let record_fields = record.as_object();
        let quote_fields = quote.as_ref().and_then(Json::as_object);
        let price = not_null(record_fields.and_then(|entry| entry.get("price")))
            .or_else(|| not_null(record_fields.and_then(|entry| entry.get("last_observed_price"))))
            .or_else(|| not_null(quote_fields.and_then(|entry| entry.get("price"))))
            .cloned()
            .unwrap_or(Json::Null);
        // `||` chain: any falsy value (including `0` and `""`) falls through.
        let attestation_hash = js_trim_string(
            record_fields
                .and_then(|entry| entry.get("attestation_hash"))
                .filter(|value| js_truthy(value))
                .or_else(|| {
                    quote_fields
                        .and_then(|entry| entry.get("attestation_hash"))
                        .filter(|value| js_truthy(value))
                }),
        );

        let mut payload = match &record {
            Json::Object(previous) => previous.clone(),
            _ => Map::new(),
        };
        payload.insert(
            "relay_status".to_string(),
            fields
                .and_then(|entry| entry.get("relay_status"))
                .filter(|value| js_truthy(value))
                .cloned()
                .unwrap_or(Json::Null),
        );
        payload.insert(
            "skip_reason".to_string(),
            fields
                .and_then(|entry| entry.get("skip_reason"))
                .filter(|value| js_truthy(value))
                .cloned()
                .unwrap_or(Json::Null),
        );
        payload.insert(
            "change_bps".to_string(),
            fields
                .and_then(|entry| entry.get("change_bps"))
                .filter(|value| !value.is_null())
                .cloned()
                .unwrap_or(Json::Null),
        );
        payload.insert(
            "comparison_basis".to_string(),
            fields
                .and_then(|entry| entry.get("comparison_basis"))
                .filter(|value| !value.is_null())
                .cloned()
                .unwrap_or(Json::Null),
        );
        payload.insert(
            "anchored_tx".to_string(),
            fields
                .and_then(|entry| entry.get("anchored_tx"))
                .filter(|value| !value.is_null())
                .or(batch_tx.filter(|value| !value.is_null()))
                .cloned()
                .unwrap_or(Json::Null),
        );

        let symbol = if storage_pair.is_empty() {
            js_trim_string(
                fields
                    .and_then(|entry| entry.get("pair"))
                    .filter(|value| js_truthy(value)),
            )
        } else {
            storage_pair.clone()
        };
        rows.push(json!({
            "network": resolved_scope.network,
            "symbol": symbol,
            "target_chain": resolved_scope.target_chain,
            "price": price,
            "attestation_hash": attestation_hash,
            "payload": Json::Object(payload),
        }));
    }
    rows.retain(|row| !js_trim_string(row.get("symbol")).is_empty());
    rows
}

/// `resolveRequestedSymbols(payload)` — an array `symbols` is used raw (no
/// dedupe); a comma-separated `symbols`/`symbol_list` goes through
/// [`parse_provider_list`]; a single `symbol`; else the registry defaults.
pub fn resolve_requested_symbols(payload: &Json, env: EnvReader<'_>) -> Vec<String> {
    let fields = payload.as_object();
    let explicit: Vec<String> = match fields.and_then(|entry| entry.get("symbols")) {
        Some(Json::Array(items)) => items
            .iter()
            .map(|symbol| normalize_pair_symbol(Some(symbol)))
            .collect(),
        _ => {
            let raw = fields
                .and_then(|entry| entry.get("symbols"))
                .filter(|value| js_truthy(value))
                .or_else(|| {
                    fields
                        .and_then(|entry| entry.get("symbol_list"))
                        .filter(|value| js_truthy(value))
                });
            parse_provider_list(raw, Vec::new())
                .into_iter()
                .map(|symbol| normalize_pair_symbol(Some(&Json::String(symbol))))
                .collect()
        }
    };
    if !explicit.is_empty() {
        return explicit;
    }
    if let Some(symbol) = fields.and_then(|entry| entry.get("symbol")) {
        if !js_trim_string(Some(symbol)).is_empty() {
            return vec![normalize_pair_symbol(Some(symbol))];
        }
    }
    get_default_feed_symbols(env)
        .iter()
        .map(|symbol| normalize_pair_symbol(Some(&Json::String(symbol.clone()))))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::HashMap;

    fn env_from(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
            .collect();
        move |name| map.get(name).cloned()
    }

    fn no_env() -> impl Fn(&str) -> Option<String> {
        env_from(&[])
    }

    #[test]
    fn normalize_pair_symbol_covers_the_registry_entry_shapes() {
        assert_eq!(normalize_pair_symbol(None), "NEO-USD");
        assert_eq!(normalize_pair_symbol(Some(&json!(""))), "NEO-USD");
        assert_eq!(normalize_pair_symbol(Some(&json!(0))), "NEO-USD"); // trimString(0) is ""
        assert_eq!(normalize_pair_symbol(Some(&json!("  neo  "))), "NEO-USD");
        assert_eq!(normalize_pair_symbol(Some(&json!("neo_usd"))), "NEO-USD");
        assert_eq!(normalize_pair_symbol(Some(&json!("NEOUSDT"))), "NEO-USD");
        assert_eq!(normalize_pair_symbol(Some(&json!("neousdt"))), "NEO-USD");
        assert_eq!(normalize_pair_symbol(Some(&json!("NEO"))), "NEO-USD");
        assert_eq!(normalize_pair_symbol(Some(&json!(5))), "5-USD"); // trimString(5) is "5"
                                                                     // A provider-scoped pair keeps its scope; an unknown scope passes through.
        assert_eq!(
            normalize_pair_symbol(Some(&json!("twelvedata:neo-usd"))),
            "NEO-USD"
        );
        assert_eq!(
            normalize_pair_symbol(Some(&json!("neo:twelvedata"))),
            "NEO:TWELVEDATA"
        );
        assert_eq!(normalize_pair_symbol(Some(&json!("wti/usd"))), "WTI-USD");
        // `slice(0, -3)` of "USD" is empty — JS produces "-USD" verbatim.
        assert_eq!(normalize_pair_symbol(Some(&json!("usd"))), "-USD");
    }

    #[test]
    fn multi_separator_or_empty_segments_fall_through_to_the_suffix_rules() {
        assert_eq!(normalize_pair_symbol(Some(&json!("A--B"))), "A--B-USD");
        assert_eq!(normalize_pair_symbol(Some(&json!("-NEO"))), "-NEO-USD");
        assert_eq!(
            normalize_pair_symbol(Some(&json!("NEO-USD-GAS"))),
            "NEO-USD-GAS-USD"
        );
    }

    #[test]
    fn parse_provider_list_trims_lowercases_and_dedupes() {
        assert_eq!(
            parse_provider_list(
                Some(&json!("TwelveData, twelveData , binance-spot,")),
                vec![]
            ),
            vec!["twelvedata", "binance-spot"]
        );
        assert_eq!(
            parse_provider_list(
                Some(&json!(["  TWELVEDATA ", "", 5, "binance-spot"])),
                vec![]
            ),
            vec!["twelvedata", "5", "binance-spot"]
        );
        // Empty arrays stay empty; falsy scalars take the fallback.
        assert_eq!(
            parse_provider_list(Some(&json!([])), vec![]),
            Vec::<String>::new()
        );
        assert_eq!(parse_provider_list(None, vec!["x".into()]), vec!["x"]);
        assert_eq!(
            parse_provider_list(Some(&json!("")), vec!["x".into()]),
            vec!["x"]
        );
        assert_eq!(
            parse_provider_list(Some(&json!(0)), vec!["x".into()]),
            vec!["x"]
        );
    }

    #[test]
    fn resolve_requested_providers_follows_the_explicit_chain() {
        let env = no_env();
        // A provider-scoped symbol pins its provider before anything else.
        assert_eq!(
            resolve_requested_providers("TWELVEDATA:NEO-USD", &json!({ "provider": "x" }), &env),
            vec!["twelvedata"]
        );
        assert_eq!(
            resolve_requested_providers(
                "NEO-USD",
                &json!({ "providers": "twelvedata,twelvedata, binance-spot" }),
                &env
            ),
            vec!["twelvedata", "binance-spot"]
        );
        assert_eq!(
            resolve_requested_providers(
                "NEO-USD",
                &json!({ "provider_list": ["BINANCE-SPOT"] }),
                &env
            ),
            vec!["binance-spot"]
        );
        // "all" is not a provider — the registry availability decides.
        assert_eq!(
            resolve_requested_providers("NEO-USD", &json!({ "provider": "All" }), &env),
            vec!["twelvedata", "binance-spot"]
        );
        assert_eq!(
            resolve_requested_providers("NEO-USD", &json!({ "source": "binance-spot" }), &env),
            vec!["binance-spot"]
        );
        // Unknown pair, nothing configured → the twelvedata fallback.
        assert_eq!(
            resolve_requested_providers("ZIL-USD", &json!({}), &env),
            vec!["twelvedata"]
        );
    }

    #[test]
    fn configured_provider_lists_filter_through_pair_availability() {
        let env = env_from(&[("MORPHEUS_FEED_PROVIDERS", "binance-spot, coinbase-spot")]);
        assert_eq!(
            resolve_requested_providers("NEO-USD", &json!({}), &env),
            vec!["binance-spot"]
        );
        assert_eq!(
            resolve_requested_providers("ZIL-USD", &json!({}), &env),
            vec!["binance-spot", "coinbase-spot"]
        );
    }

    #[test]
    fn extract_quote_price_walks_the_nullish_chain() {
        assert_eq!(extract_quote_price(&json!({ "price": 0 })), json!(0));
        assert_eq!(
            extract_quote_price(&json!({ "price": null, "value": "5" })),
            json!("5")
        );
        assert_eq!(
            extract_quote_price(
                &json!({ "value": null, "close": null, "data": { "amount": 12.5 } })
            ),
            json!(12.5)
        );
        assert_eq!(extract_quote_price(&json!("not-an-object")), Json::Null);
        assert_eq!(
            extract_quote_price(&json!({ "data": "scalar" })),
            Json::Null
        );
        assert_eq!(extract_quote_price(&json!({})), Json::Null);
    }

    #[test]
    fn extract_upstream_timestamp_prefers_the_source_clock() {
        let no_headers = json!({});
        let now = 1_893_456_000_000i64; // 2030-01-01T00:00:00Z
        assert_eq!(
            extract_upstream_timestamp(
                &json!({ "datetime": "2025-01-15 14:30:00" }),
                &no_headers,
                now
            )
            .unwrap(),
            "2025-01-15T14:30:00.000Z"
        );
        assert_eq!(
            extract_upstream_timestamp(&json!({ "timestamp": 1705312200 }), &no_headers, now)
                .unwrap(),
            "2024-01-15T09:50:00.000Z"
        );
        // Milliseconds clear the pre-2100 cutoff and pass through as-is.
        assert_eq!(
            extract_upstream_timestamp(&json!({ "time": 1705312200000i64 }), &no_headers, now)
                .unwrap(),
            "2024-01-15T09:50:00.000Z"
        );
        // Number() coercion over a string timestamp.
        assert_eq!(
            extract_upstream_timestamp(&json!({ "timestamp": "1705312200" }), &no_headers, now)
                .unwrap(),
            "2024-01-15T09:50:00.000Z"
        );
        // Truthy but unusable values fall through to the Date header, then now.
        assert_eq!(
            extract_upstream_timestamp(
                &json!({ "timestamp": 0, "datetime": "not-a-date" }),
                &json!({ "date": "Mon, 02 Jan 2006 15:04:05 GMT" }),
                now
            )
            .unwrap(),
            "2006-01-02T15:04:05.000Z"
        );
        assert_eq!(
            extract_upstream_timestamp(&json!({}), &no_headers, now).unwrap(),
            "2030-01-01T00:00:00.000Z"
        );
        // A pathological number overflows the JS Date range — RangeError.
        assert_eq!(
            extract_upstream_timestamp(&json!({ "timestamp": 1e300 }), &no_headers, now)
                .unwrap_err(),
            "Invalid time value"
        );
    }

    #[test]
    fn should_fast_ack_reads_the_nullish_chain_then_wait() {
        assert!(!should_fast_ack_oracle_feed(&json!({})));
        assert!(should_fast_ack_oracle_feed(&json!({ "fast_ack": true })));
        assert!(should_fast_ack_oracle_feed(&json!({ "fastAck": "yes" })));
        assert!(!should_fast_ack_oracle_feed(&json!({ "async_ack": 0 })));
        assert!(!should_fast_ack_oracle_feed(&json!({ "asyncAck": false })));
        // An empty string is NOT an explicit fast-ack decision.
        assert!(!should_fast_ack_oracle_feed(&json!({ "fast_ack": "" })));
        // null collapses through the ?? chain to "absent".
        assert!(!should_fast_ack_oracle_feed(&json!({ "fast_ack": null })));
        // wait: true → background (no fast ack); wait: 0 → fast ack.
        assert!(should_fast_ack_oracle_feed(&json!({ "wait": false })));
        assert!(!should_fast_ack_oracle_feed(&json!({ "wait": true })));
        // "no" is not a token, so normalizeBooleanLike yields false — wait is
        // falsy and the wait inversion fires.
        assert!(should_fast_ack_oracle_feed(&json!({ "wait": "no" })));
        assert!(should_fast_ack_oracle_feed(&json!({ "wait": 0 })));
        // An explicit decision beats the wait inversion.
        assert!(!should_fast_ack_oracle_feed(
            &json!({ "fast_ack": false, "wait": false })
        ));
    }

    #[test]
    fn build_oracle_feed_request_id_uses_explicit_or_composes() {
        let env = no_env();
        let uuid = || "u-1".to_string();
        assert_eq!(
            build_oracle_feed_request_id(&json!({ "request_id": "  abc  " }), &env, 5, uuid),
            "abc"
        );
        // The truthy chain falls past an empty request_id.
        assert_eq!(
            build_oracle_feed_request_id(
                &json!({ "request_id": "", "requestId": "xyz" }),
                &env,
                5,
                uuid
            ),
            "xyz"
        );
        assert_eq!(
            build_oracle_feed_request_id(&json!({ "request_id": "" }), &env, 123, uuid),
            "pricefeed:testnet:123:u-1"
        );
        assert_eq!(
            build_oracle_feed_request_id(&json!({}), &env, 123, uuid),
            "pricefeed:testnet:123:u-1"
        );
    }

    #[test]
    fn build_round_id_increments_or_clocks() {
        let now = 1_700_000_000_000i64;
        let previous = json!({ "round_id": 41, "provider": "x" });
        assert_eq!(build_round_id(None, now), "1700000000");
        assert_eq!(build_round_id(Some(&json!({})), now), "1700000000");
        assert_eq!(build_round_id(Some(&previous), now), "42");
        assert_eq!(
            build_round_id(Some(&json!({ "round_id": "41" })), now),
            "42"
        );
        // Falsy round ids have nothing to increment.
        assert_eq!(
            build_round_id(Some(&json!({ "round_id": 0 })), now),
            "1700000000"
        );
        // String(Number(x) + 1) — "NaN" for garbage.
        assert_eq!(
            build_round_id(Some(&json!({ "round_id": "abc" })), now),
            "NaN"
        );
    }

    #[test]
    fn canonical_aggregate_record_requires_multiple_distinct_providers() {
        let now = 1_700_000_000_000i64;
        let single = json!({
            "method": "median",
            "providers_used": ["twelvedata"],
            "price": "10",
        });
        assert_eq!(
            build_canonical_aggregate_record("neo-usd", &single, None, now).unwrap(),
            None
        );
        // A duplicated id is still a single source (C2).
        let duplicated = json!({
            "method": "median",
            "providers_used": ["twelvedata", "twelvedata"],
            "price": "10",
        });
        assert_eq!(
            build_canonical_aggregate_record("neo-usd", &duplicated, None, now).unwrap(),
            None
        );

        let aggregation = json!({
            "method": "median",
            "providers_used": ["twelvedata", "binance-spot"],
            "providers_rejected": ["coinbase-spot"],
            "deviation_pct": 0.5,
            "confidence": 0.9,
            "price": "12.5",
        });
        let previous = json!({ "round_id": 7, "provider": "twelvedata", "price": "9" });
        let (storage_key, record) =
            build_canonical_aggregate_record("neo-usd", &aggregation, Some(&previous), now)
                .unwrap()
                .unwrap();
        assert_eq!(storage_key, "AGG:NEO-USD");
        assert_eq!(record.get("storage_pair"), Some(&json!("AGG:NEO-USD")));
        assert_eq!(record.get("pair"), Some(&json!("NEO-USD")));
        assert_eq!(record.get("aggregate"), Some(&json!(true)));
        assert_eq!(record.get("aggregation_method"), Some(&json!("median")));
        assert_eq!(
            record.get("providers_used"),
            Some(&json!(["twelvedata", "binance-spot"]))
        );
        assert_eq!(
            record.get("providers_rejected"),
            Some(&json!(["coinbase-spot"]))
        );
        assert_eq!(record.get("provider_count"), Some(&json!(2)));
        assert_eq!(record.get("deviation_pct"), Some(&json!(0.5)));
        assert_eq!(record.get("confidence"), Some(&json!(0.9)));
        assert_eq!(record.get("price"), Some(&json!("12.500000")));
        assert_eq!(record.get("price_units"), Some(&json!("12500000")));
        assert_eq!(record.get("round_id"), Some(&json!("8")));
        assert_eq!(record.get("last_observed_price"), Some(&json!("12.500000")));
        assert_eq!(
            record.get("last_observed_price_units"),
            Some(&json!("12500000"))
        );
        assert_eq!(record.get("last_observed_at_ms"), Some(&json!(now)));
        assert_eq!(record.get("price_scale_decimals"), Some(&json!(6)));
        // The previous record spreads in underneath the overwrites.
        assert_eq!(record.get("provider"), Some(&json!("twelvedata")));

        // `Number(null)` is 0 — a null price stays in play as a zero price.
        let null_price = json!({
            "method": "mean",
            "providers_used": ["twelvedata", "binance-spot"],
            "price": null,
        });
        let (_, record) = build_canonical_aggregate_record("NEO-USD", &null_price, None, now)
            .unwrap()
            .unwrap();
        assert_eq!(record.get("price"), Some(&json!("0.000000")));
        // An absent price is Number(undefined) = NaN → no record.
        let absent_price = json!({
            "method": "mean",
            "providers_used": ["twelvedata", "binance-spot"],
        });
        assert_eq!(
            build_canonical_aggregate_record("NEO-USD", &absent_price, None, now).unwrap(),
            None
        );
        // toFixed(1e21) renders "1e+21", which the decimal scaler rejects.
        let huge = json!({
            "method": "mean",
            "providers_used": ["twelvedata", "binance-spot"],
            "price": 1e21,
        });
        assert!(build_canonical_aggregate_record("NEO-USD", &huge, None, now).is_err());
    }

    #[test]
    fn snapshot_rows_project_the_state_and_relay_metadata() {
        let env = no_env();
        let state = json!({
            "records": {
                "twelvedata:NEO-USD": {
                    "provider": "twelvedata",
                    "price": "11.000000",
                    "attestation_hash": "",
                },
                "binance-spot:NEO-USD": {
                    "provider": "binance-spot",
                    "price": null,
                    "last_observed_price": "22.000000",
                    "attestation_hash": "0xabc",
                },
                "gas": "not-an-object",
            }
        });
        let sync_results = json!([
            {
                "storage_pair": "  twelvedata:NEO-USD ",
                "relay_status": "submitted",
                "change_bps": 0,
                "quote": { "price": "11.5", "attestation_hash": "0xq" },
            },
            {
                "storage_pair": "binance-spot:NEO-USD",
                "relay_status": 0,
                "skip_reason": "below_threshold",
                "comparison_basis": null,
            },
            { "pair": "GAS-USD", "anchored_tx": null },
            { "storage_pair": "gas", "relay_status": "submitted" },
            { "storage_pair": "  ", "pair": "   " },
        ]);
        let batch_tx = json!({ "tx_hash": "0xdeadbeef" });
        let rows = build_feed_snapshot_rows(
            &sync_results,
            &state,
            Some(&batch_tx),
            &json!({ "network": "mainnet" }),
            &env,
        );
        assert_eq!(rows.len(), 4);
        assert_eq!(rows[0].get("network"), Some(&json!("mainnet")));
        assert_eq!(rows[0].get("symbol"), Some(&json!("twelvedata:NEO-USD")));
        assert_eq!(rows[0].get("target_chain"), Some(&json!("neo_n3")));
        assert_eq!(rows[0].get("price"), Some(&json!("11.000000")));
        // The record hash wins over the quote hash; empty record hash falls
        // through the truthy chain to the quote.
        assert_eq!(rows[0].get("attestation_hash"), Some(&json!("0xq")));
        let payload = rows[0].get("payload").unwrap();
        assert_eq!(payload.get("provider"), Some(&json!("twelvedata")));
        assert_eq!(payload.get("relay_status"), Some(&json!("submitted")));
        assert_eq!(payload.get("skip_reason"), Some(&Json::Null));
        assert_eq!(payload.get("change_bps"), Some(&json!(0))); // `??` keeps 0
        assert_eq!(payload.get("comparison_basis"), Some(&Json::Null));
        assert_eq!(payload.get("anchored_tx"), Some(&batch_tx));
        // Key order matches the JS literal: the record spread (provider,
        // price, attestation_hash) first, then the five overwrites appended.
        let payload_keys: Vec<&String> = payload.as_object().unwrap().keys().collect();
        assert_eq!(
            payload_keys
                .iter()
                .position(|key| **key == "relay_status")
                .zip(payload_keys.iter().position(|key| **key == "anchored_tx")),
            Some((3, 7))
        );

        // relay_status 0 collapses (`||`); price null falls to last_observed.
        assert_eq!(rows[1].get("price"), Some(&json!("22.000000")));
        assert_eq!(
            rows[1].get("payload").unwrap().get("relay_status"),
            Some(&Json::Null)
        );
        assert_eq!(
            rows[1].get("payload").unwrap().get("skip_reason"),
            Some(&json!("below_threshold"))
        );
        assert_eq!(rows[1].get("attestation_hash"), Some(&json!("0xabc")));

        // No state record → empty payload with the batch tx anchoring.
        assert_eq!(rows[2].get("symbol"), Some(&json!("GAS-USD")));
        assert_eq!(rows[2].get("price"), Some(&Json::Null));
        assert_eq!(
            rows[2].get("payload").unwrap().get("anchored_tx"),
            Some(&json!({ "tx_hash": "0xdeadbeef" }))
        );
        // A non-object record spreads as {} and yields no price.
        assert_eq!(rows[3].get("price"), Some(&Json::Null));
        assert_eq!(rows[3].get("symbol"), Some(&json!("gas")));

        // The all-whitespace row is filtered out by the symbol trim.
        assert!(rows
            .iter()
            .all(|row| !js_trim_string(row.get("symbol")).is_empty()));
        // Non-array sync results produce no rows.
        assert!(build_feed_snapshot_rows(&json!("x"), &state, None, &json!({}), &env).is_empty());
    }

    #[test]
    fn resolve_requested_symbols_uses_arrays_raw_and_defaults() {
        let env = no_env();
        // Arrays are used raw — duplicates and all.
        assert_eq!(
            resolve_requested_symbols(&json!({ "symbols": [" neo ", "neo"] }), &env),
            vec!["NEO-USD", "NEO-USD"]
        );
        assert_eq!(
            resolve_requested_symbols(&json!({ "symbols": "neo, eth" }), &env),
            vec!["NEO-USD", "ETH-USD"]
        );
        assert_eq!(
            resolve_requested_symbols(&json!({ "symbols": "", "symbol_list": "gas" }), &env),
            vec!["GAS-USD"]
        );
        assert_eq!(
            resolve_requested_symbols(&json!({ "symbols": [] }), &env)[0],
            "NEO-USD"
        );
        assert_eq!(
            resolve_requested_symbols(&json!({ "symbol": " neousdt " }), &env),
            vec!["NEO-USD"]
        );
        // The registry defaults come back normalized to plain pairs.
        let defaults = resolve_requested_symbols(&json!({}), &env);
        assert_eq!(defaults.first(), Some(&"NEO-USD".to_string()));
        assert_eq!(defaults.len(), 32);
        assert!(defaults.contains(&"JPY-USD".to_string()));
    }
}
