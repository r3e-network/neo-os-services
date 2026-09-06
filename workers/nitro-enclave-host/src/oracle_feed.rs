//! `/oracle/feed` — the Rust price-feed orchestration adapter.
//!
//! Provider resolution, decimal transforms, aggregation and sync policy are
//! owned by `neo-os-compute`.  This host layer supplies real egress, custody
//! signatures and an atomic, network-scoped observation baseline.  Neo N3
//! transaction submission is intentionally not faked: until a chain submit
//! plane is wired, candidates are recorded as observed and reported as
//! `submission_unavailable`, never as anchored.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

use neo_os_compute::core::EnvReader;
use neo_os_compute::js::{js_stringify, js_to_number, js_trim_string, js_truthy};
use neo_os_compute::oracle::aggregation::{aggregate_quotes, AggregateOptions};
use neo_os_compute::oracle::decimal::{decimal_to_integer_string, transform_decimal_string};
use neo_os_compute::oracle::feed_registry::{
    apply_feed_provider_defaults, get_feed_display_symbol, get_feed_price_multiplier,
    get_feed_price_transform, get_feed_storage_pair, get_feed_unit_label,
    get_source_set_id_for_provider,
};
use neo_os_compute::oracle::feeds::shared::{
    clamp_feed_timestamp_sec, normalize_boolean_like, resolve_feed_scope,
    resolve_feed_timestamp_future_skew_seconds, resolve_feed_timestamp_max_future_seconds,
    DEFAULT_FEED_STATE_PATH, FEED_PRICE_DECIMALS,
};
use neo_os_compute::oracle::feeds::sync_policy::{
    build_sync_policy, resolve_pair_threshold_bps, should_submit_feed,
};
use neo_os_compute::oracle::feeds::{
    build_canonical_aggregate_record, build_canonical_aggregate_storage_key, build_round_id,
    extract_quote_price, extract_upstream_timestamp, resolve_requested_providers,
    resolve_requested_symbols, should_fast_ack_oracle_feed,
};
use neo_os_core::js_value::JsValue;
use neo_os_core::sha256_hex;
use neo_os_core::stable_stringify::stable_stringify;
use serde_json::{json, Map, Value as Json};

use crate::compute_execute::{
    build_lane_signed_envelope, build_tee_attestation, reject_caller_supplied_signing_key,
    sign_worker_bytes,
};
use crate::state::AppState;
use crate::{http_error, DispatchOutcome, RuntimeError};

static FEED_RUN: OnceLock<Mutex<()>> = OnceLock::new();
static FEED_STATES: OnceLock<Mutex<HashMap<PathBuf, Json>>> = OnceLock::new();
static FEED_STATE_WRITE_FAILURES: AtomicU64 = AtomicU64::new(0);
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

struct ResolvedQuote {
    quote: Json,
    upstream_sec: f64,
    observed_at_ms: u64,
}

struct PendingUpdate {
    storage_pair: String,
    quote: Json,
    previous_record: Option<Json>,
}

pub fn handle_oracle_feed(
    state: &AppState,
    payload: &Json,
) -> Result<DispatchOutcome, RuntimeError> {
    if !payload.is_object() {
        return Err(http_error(400, "oracle feed payload must be a JSON object"));
    }
    reject_caller_supplied_signing_key(payload)?;
    if should_fast_ack_oracle_feed(payload) {
        return Ok(DispatchOutcome {
            status: 409,
            body: json!({
                "accepted": false,
                "status": "background_execution_unavailable",
                "mode": "pricefeed",
                "error": "durable background feed execution is unavailable; retry with wait=true",
                "wait": true,
            }),
        });
    }

    let _run = FEED_RUN
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| http_error(500, "oracle feed execution state unavailable"))?;
    let overlay = state.overlay.read().expect("overlay lock").merged_map();
    let env: EnvReader<'_> = &|name| overlay.get(name).cloned();
    let scope = resolve_feed_scope(payload, env);
    let symbols = resolve_requested_symbols(payload, env);
    if symbols.is_empty() {
        return Err(http_error(400, "at least one feed symbol is required"));
    }
    let policy = build_sync_policy(&scope.target_chain, payload, env);
    let require_submission = normalize_boolean_like(
        payload
            .get("require_submission")
            .or_else(|| payload.get("requireSubmission")),
        false,
    );
    let now_ms = state.oracle_io.now_ms();
    let state_path = feed_state_path(env, &scope.network, &scope.target_chain);
    let mut feed_state = load_feed_state(&state_path, env)?;
    let mut sync_results = Vec::new();
    let mut errors = Vec::new();
    let mut aggregations = Map::new();
    let mut pending = Vec::new();

    for symbol in &symbols {
        let (quotes, providers, provider_errors, aggregation) =
            fetch_price_quotes(state, symbol, payload, env, &scope.network, now_ms);
        if quotes.is_empty() {
            errors.push(json!({
                "symbol": symbol,
                "providers_requested": providers,
                "errors": provider_errors,
            }));
            continue;
        }

        if let Some(aggregation) = aggregation {
            aggregations.insert(symbol.clone(), aggregation.clone());
            let canonical_key = build_canonical_aggregate_storage_key(symbol);
            let previous = feed_state
                .get("records")
                .and_then(Json::as_object)
                .and_then(|records| records.get(&canonical_key));
            if let Some((key, record)) = build_canonical_aggregate_record(
                symbol,
                &aggregation,
                previous,
                now_ms.min(i64::MAX as u64) as i64,
            )
            .map_err(|message| http_error(422, message))?
            {
                records_mut(&mut feed_state).insert(key.clone(), record.clone());
                sync_results.push(json!({
                    "provider": "aggregate",
                    "pair": record.get("pair").cloned().unwrap_or(Json::Null),
                    "storage_pair": key,
                    "relay_status": "aggregated",
                    "aggregation_method": record.get("aggregation_method").cloned().unwrap_or(Json::Null),
                    "provider_count": record.get("provider_count").cloned().unwrap_or(Json::Null),
                    "confidence": record.get("confidence").cloned().unwrap_or(Json::Null),
                }));
            }
        }

        for resolved in quotes {
            let quote = resolved.quote;
            let provider = js_trim_string(quote.get("provider"));
            let storage_pair = js_trim_string(quote.get("pair"));
            let previous = feed_state
                .get("records")
                .and_then(Json::as_object)
                .and_then(|records| records.get(&storage_pair))
                .cloned();
            let mut pair_policy = policy.clone();
            if let Some(threshold) = resolve_pair_threshold_bps(&storage_pair, payload, env) {
                pair_policy.threshold_bps = threshold;
            }
            let decision = should_submit_feed(
                &storage_pair,
                &quote,
                previous.as_ref(),
                &pair_policy,
                payload.get("force").is_some_and(js_truthy),
                now_ms as f64,
            )
            .map_err(|message| http_error(422, message))?;

            let previous_timestamp = previous
                .as_ref()
                .and_then(|record| record.get("timestamp"))
                .map(js_to_number)
                .filter(|value| value.is_finite())
                .unwrap_or(0.0);
            let timestamp = clamp_feed_timestamp_sec(
                resolved.upstream_sec,
                previous_timestamp,
                now_ms as f64 / 1_000.0,
                resolve_feed_timestamp_max_future_seconds(env),
                resolve_feed_timestamp_future_skew_seconds(env),
            );
            if let Err(error) = timestamp {
                observe_record(
                    &mut feed_state,
                    previous.as_ref(),
                    &storage_pair,
                    &provider,
                    &quote,
                    resolved.observed_at_ms,
                )?;
                sync_results.push(sync_result(
                    &provider,
                    &storage_pair,
                    "skipped",
                    Some("upstream_timestamp_rejected"),
                    &decision,
                    &quote,
                ));
                errors.push(json!({
                    "symbol": symbol,
                    "storage_pair": storage_pair,
                    "error": error.to_string(),
                }));
                continue;
            }

            if !decision
                .get("allow")
                .and_then(Json::as_bool)
                .unwrap_or(false)
            {
                observe_record(
                    &mut feed_state,
                    previous.as_ref(),
                    &storage_pair,
                    &provider,
                    &quote,
                    resolved.observed_at_ms,
                )?;
                let reason = decision.get("reason").and_then(Json::as_str);
                sync_results.push(sync_result(
                    &provider,
                    &storage_pair,
                    "skipped",
                    reason,
                    &decision,
                    &quote,
                ));
                continue;
            }

            let _round_id = payload
                .get("round_id")
                .and_then(Json::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| {
                    build_round_id(previous.as_ref(), now_ms.min(i64::MAX as u64) as i64)
                });
            let _source_set_id = payload
                .get("source_set_id")
                .map(js_to_number)
                .filter(|value| value.is_finite())
                .map(|value| value.trunc() as i64)
                .unwrap_or_else(|| {
                    get_source_set_id_for_provider(&Json::String(provider.clone()), 0)
                });
            let _timestamp = timestamp.expect("checked above");
            sync_results.push(sync_result(
                &provider,
                &storage_pair,
                "queued",
                None,
                &decision,
                &quote,
            ));
            pending.push(PendingUpdate {
                storage_pair,
                quote,
                previous_record: previous,
            });
        }
    }

    if !pending.is_empty() {
        errors.push(json!({
            "target_chain": scope.target_chain,
            "error": "Neo N3 feed submission transport is not configured in the Rust host",
        }));
    }
    for update in &pending {
        let provider = js_trim_string(update.quote.get("provider"));
        let observed_at_ms = update
            .quote
            .get("observed_at_ms")
            .and_then(Json::as_u64)
            .unwrap_or(now_ms);
        observe_record(
            &mut feed_state,
            update.previous_record.as_ref(),
            &update.storage_pair,
            &provider,
            &update.quote,
            observed_at_ms,
        )?;
    }
    for result in &mut sync_results {
        if result.get("relay_status") == Some(&Json::String("queued".to_string())) {
            result["relay_status"] = Json::String("skipped".to_string());
            result["skip_reason"] = Json::String("submission_unavailable".to_string());
            result["anchored_tx"] = Json::Null;
        }
    }

    let persistence_error = save_feed_state(&state_path, &feed_state).err();
    if let Some(message) = persistence_error.as_ref() {
        errors.push(json!({
            "state_path": state_path.to_string_lossy(),
            "error": format!("feed state persistence failed: {message}"),
        }));
    }
    let mut body = json!({
        "mode": "pricefeed",
        "network": scope.network,
        "target_chain": scope.target_chain,
        "symbols": symbols,
        "batch_submitted": false,
        "batch_count": pending.len(),
        "batch_tx": null,
        "sync_results": sync_results,
        "errors": errors,
        "state_persisted": persistence_error.is_none(),
        "state_write_failures_total": FEED_STATE_WRITE_FAILURES.load(Ordering::Relaxed),
        "sync_policy": policy.to_json(),
    });
    if !aggregations.is_empty() {
        body["aggregations"] = Json::Object(aggregations);
    }
    body["submission_required"] = Json::Bool(require_submission);
    if !pending.is_empty() {
        body["error"] = Json::String(if require_submission {
            "feed submission was required but no transaction was submitted".to_string()
        } else {
            "feed publication is owned by the Rust relayer; the host only observed candidate updates"
                .to_string()
        });
        return Ok(DispatchOutcome { status: 503, body });
    }
    Ok(DispatchOutcome::ok(body))
}

fn fetch_price_quotes(
    state: &AppState,
    symbol: &str,
    payload: &Json,
    env: EnvReader<'_>,
    network: &str,
    now_ms: u64,
) -> (Vec<ResolvedQuote>, Vec<String>, Vec<Json>, Option<Json>) {
    let providers = resolve_requested_providers(symbol, payload, env);
    let mut quotes = Vec::new();
    let mut errors = Vec::new();
    for provider in &providers {
        match resolve_quote_for_provider(state, symbol, provider, payload, env, network, now_ms) {
            Ok(quote) => quotes.push(quote),
            Err(error) => errors.push(json!({
                "provider": provider,
                "error": error,
            })),
        }
    }
    let aggregation = if quotes.len() >= 2 {
        let values = Json::Array(
            quotes
                .iter()
                .map(|quote| {
                    json!({
                        "provider": quote.quote.get("provider").cloned().unwrap_or(Json::Null),
                        "price": quote.quote.get("price").map(js_to_number).unwrap_or(f64::NAN),
                        "timestamp": quote.quote.get("timestamp").cloned().unwrap_or(Json::Null),
                    })
                })
                .collect(),
        );
        let method = payload
            .get("aggregation_method")
            .and_then(Json::as_str)
            .map(str::trim)
            .filter(|value| value.eq_ignore_ascii_case("trimmed-mean"))
            .map(|_| "trimmed-mean")
            .unwrap_or("median");
        aggregate_quotes(
            &values,
            AggregateOptions {
                method,
                ..AggregateOptions::default()
            },
        )
        .ok()
    } else {
        None
    };
    (quotes, providers, errors, aggregation)
}

fn resolve_quote_for_provider(
    state: &AppState,
    symbol: &str,
    provider: &str,
    payload: &Json,
    env: EnvReader<'_>,
    network: &str,
    now_ms: u64,
) -> Result<ResolvedQuote, String> {
    let pair = neo_os_compute::oracle::feeds::normalize_pair_symbol(Some(&Json::String(
        symbol.to_string(),
    )));
    let mut provider_payload =
        apply_feed_provider_defaults(&pair, &Json::String(provider.to_string()), payload, env);
    provider_payload["network"] = Json::String(network.to_string());
    provider_payload["target_chain"] = Json::String("neo_n3".to_string());
    provider_payload["request_source"] = Json::String("oracle-feed".to_string());
    let outcome = crate::oracle_read::handle_oracle_query(state, &provider_payload)
        .map_err(|error| error.message)?;
    if !(200..300).contains(&outcome.status) {
        return Err(response_error(&outcome.body, outcome.status));
    }
    let data = outcome.body.get("body_json").cloned().unwrap_or(Json::Null);
    let headers = outcome
        .body
        .get("headers")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let raw_price = extract_quote_price(&data);
    if raw_price.is_null() || matches!(&raw_price, Json::String(value) if value.is_empty()) {
        return Err(format!("{provider} response missing price"));
    }
    let storage_pair = get_feed_storage_pair(provider, &pair);
    let display_symbol = get_feed_display_symbol(&storage_pair, env);
    let unit_label = get_feed_unit_label(&storage_pair, env);
    let multiplier = get_feed_price_multiplier(&storage_pair, env);
    let transform = get_feed_price_transform(&storage_pair, env);
    let raw_price_text = js_stringify(&raw_price);
    let price = transform_decimal_string(&raw_price_text, &transform, multiplier)?;
    let timestamp =
        extract_upstream_timestamp(&data, &headers, now_ms.min(i64::MAX as u64) as i64)?;
    let (upstream_sec, observed_at_ms) = upstream_time(&data, now_ms);
    let mut quote = json!({
        "feed_id": format!("{provider}:{pair}"),
        "pair": storage_pair,
        "provider_pair": pair,
        "display_symbol": display_symbol,
        "unit_label": if unit_label.is_empty() { Json::Null } else { Json::String(unit_label) },
        "provider": provider,
        "raw_price": raw_price_text,
        "price_transform": if transform.is_empty() { Json::Null } else { Json::String(transform) },
        "price_multiplier": multiplier,
        "price": price,
        "decimals": FEED_PRICE_DECIMALS,
        "price_scale_decimals": FEED_PRICE_DECIMALS,
        "timestamp": timestamp,
        "observed_at_ms": observed_at_ms,
        "sources": [provider],
    });
    let bytes = stable_stringify(&JsValue::from_json(&quote)).into_bytes();
    let output_hash = sha256_hex(&bytes);
    let signed = sign_worker_bytes(state, network, &bytes).map_err(|error| error.message)?;
    let attestation = build_tee_attestation(state, &provider_payload, "custody", &output_hash);
    let quote_fields = quote.as_object_mut().expect("quote literal is an object");
    for (key, value) in build_lane_signed_envelope(&signed, &output_hash, &attestation) {
        quote_fields.insert(key, value);
    }
    Ok(ResolvedQuote {
        quote,
        upstream_sec,
        observed_at_ms,
    })
}

fn upstream_time(data: &Json, now_ms: u64) -> (f64, u64) {
    for key in ["timestamp", "time"] {
        let value = data.get(key).map(js_to_number).unwrap_or(f64::NAN);
        if value.is_finite() && value > 0.0 {
            let millis = if value < 4_102_444_800.0 {
                value * 1_000.0
            } else {
                value
            };
            if millis.is_finite() && millis >= 0.0 {
                return (millis / 1_000.0, millis.min(u64::MAX as f64) as u64);
            }
        }
    }
    (now_ms as f64 / 1_000.0, now_ms)
}

fn sync_result(
    provider: &str,
    storage_pair: &str,
    status: &str,
    skip_reason: Option<&str>,
    decision: &Json,
    quote: &Json,
) -> Json {
    json!({
        "provider": provider,
        "pair": quote.get("provider_pair").cloned().unwrap_or(Json::Null),
        "storage_pair": storage_pair,
        "relay_status": status,
        "skip_reason": skip_reason,
        "change_bps": decision.get("change_bps").cloned().unwrap_or(Json::Null),
        "comparison_basis": decision.get("comparison_basis").cloned().unwrap_or(Json::Null),
        "quote": quote,
    })
}

fn observe_record(
    state: &mut Json,
    previous: Option<&Json>,
    storage_pair: &str,
    provider: &str,
    quote: &Json,
    observed_at_ms: u64,
) -> Result<(), RuntimeError> {
    let price = quote
        .get("price")
        .map(js_stringify)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| http_error(500, "resolved feed quote is missing price"))?;
    let mut record = previous
        .and_then(Json::as_object)
        .cloned()
        .unwrap_or_default();
    record.insert("provider".to_string(), Json::String(provider.to_string()));
    record.insert(
        "pair".to_string(),
        quote.get("provider_pair").cloned().unwrap_or(Json::Null),
    );
    record.insert(
        "storage_pair".to_string(),
        Json::String(storage_pair.to_string()),
    );
    record.insert(
        "last_observed_price".to_string(),
        Json::String(price.clone()),
    );
    record.insert(
        "last_observed_price_units".to_string(),
        Json::String(
            decimal_to_integer_string(&price, FEED_PRICE_DECIMALS)
                .map_err(|message| http_error(422, message))?,
        ),
    );
    record.insert("last_observed_at_ms".to_string(), json!(observed_at_ms));
    record.insert(
        "price_scale_decimals".to_string(),
        json!(FEED_PRICE_DECIMALS),
    );
    records_mut(state).insert(storage_pair.to_string(), Json::Object(record));
    Ok(())
}

fn records_mut(state: &mut Json) -> &mut Map<String, Json> {
    if !state.is_object() {
        *state = json!({});
    }
    let object = state.as_object_mut().expect("normalized state object");
    if !object.get("records").is_some_and(Json::is_object) {
        object.insert("records".to_string(), json!({}));
    }
    object
        .get_mut("records")
        .and_then(Json::as_object_mut)
        .expect("normalized records object")
}

fn response_error(body: &Json, status: u16) -> String {
    ["error", "message", "code"]
        .iter()
        .find_map(|key| body.get(*key).and_then(Json::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("provider fetch failed with HTTP {status}"))
}

fn feed_state_path(env: EnvReader<'_>, network: &str, target_chain: &str) -> PathBuf {
    let base = env("MORPHEUS_FEED_STATE_PATH")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_FEED_STATE_PATH.to_string());
    scoped_feed_state_path(Path::new(&base), network, target_chain)
}

fn scoped_feed_state_path(base: &Path, network: &str, target_chain: &str) -> PathBuf {
    let parent = base.parent().unwrap_or_else(|| Path::new(""));
    let file_name = base
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("morpheus-feed-state");
    if let Some(extension) = base.extension().and_then(|value| value.to_str()) {
        let stem = base
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or(file_name);
        parent.join(format!("{stem}.{network}.{target_chain}.{extension}"))
    } else {
        parent.join(format!("{file_name}.{network}.{target_chain}"))
    }
}

fn load_feed_state(path: &Path, env: EnvReader<'_>) -> Result<Json, RuntimeError> {
    let cache = FEED_STATES.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(state) = cache
        .lock()
        .map_err(|_| http_error(500, "oracle feed state cache unavailable"))?
        .get(path)
        .cloned()
    {
        return Ok(state);
    }
    let base = env("MORPHEUS_FEED_STATE_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(DEFAULT_FEED_STATE_PATH));
    let mut state = read_state_file(path)
        .or_else(|| (base != path).then(|| read_state_file(&base)).flatten())
        .unwrap_or_else(|| json!({ "records": {} }));
    records_mut(&mut state);
    cache
        .lock()
        .map_err(|_| http_error(500, "oracle feed state cache unavailable"))?
        .insert(path.to_path_buf(), state.clone());
    Ok(state)
}

fn read_state_file(path: &Path) -> Option<Json> {
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn save_feed_state(path: &Path, state: &Json) -> Result<(), String> {
    FEED_STATES
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map_err(|_| "oracle feed state cache unavailable".to_string())?
        .insert(path.to_path_buf(), state.clone());
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(parent).map_err(|error| record_write_error(error.to_string()))?;
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("feed-state");
    let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let temp = parent.join(format!(
        "{file_name}.{}.{}.tmp",
        std::process::id(),
        sequence
    ));
    let raw = serde_json::to_string_pretty(state)
        .map(|value| format!("{value}\n"))
        .map_err(|error| record_write_error(error.to_string()))?;
    if let Err(error) = std::fs::write(&temp, raw) {
        let _ = std::fs::remove_file(&temp);
        return Err(record_write_error(error.to_string()));
    }
    if let Err(first) = std::fs::rename(&temp, path) {
        // Unix replaces atomically. Windows refuses an existing destination;
        // its narrow fallback removes exactly this scoped file before retrying.
        if path.exists() {
            let _ = std::fs::remove_file(path);
        }
        if let Err(second) = std::fs::rename(&temp, path) {
            let _ = std::fs::remove_file(&temp);
            return Err(record_write_error(format!("{first}; retry: {second}")));
        }
    }
    Ok(())
}

fn record_write_error(message: String) -> String {
    FEED_STATE_WRITE_FAILURES.fetch_add(1, Ordering::Relaxed);
    message
}

#[cfg(test)]
fn reset_feed_state_for_tests() {
    if let Some(states) = FEED_STATES.get() {
        states.lock().expect("feed state test lock").clear();
    }
    FEED_STATE_WRITE_FAILURES.store(0, Ordering::Relaxed);
}

#[cfg(test)]
#[path = "../tests/unit/oracle_feed.rs"]
mod tests;
