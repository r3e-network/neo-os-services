//! Chain scanner and cursor orchestration for Neo N3 and NeoX.
//!
//! Pinned against `workers/morpheus-relayer/src/request-processor.js`.

use std::collections::HashSet;

use neo_os_core::cursor::resolve_chain_from_block;
use neo_os_core::js_value::{JsObject, JsValue};
use neo_os_core::state::{
    build_event_key, get_due_retry_items, has_processed_event, increment_metric,
    is_event_queued_for_retry,
};
use serde::de::{self, Visitor};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;

use crate::config::RelayerConfig;
use crate::fulfillment::{
    is_event_dead_lettered, process_event_with, DeliveryRuntime, ProcessEventResult,
};
use crate::transport::RelayerHttpTransport;

/// Largest integer JSON can carry through a JavaScript consumer without
/// changing its value. Larger cursor values cross the wire as decimal strings.
const MAX_SAFE_JSON_INTEGER: u64 = 9_007_199_254_740_991;

fn discovered_event(
    config: &RelayerConfig,
    state: &mut JsObject,
    chain: &str,
    event: &JsValue,
    now_ms: f64,
    transport: &RelayerHttpTransport,
) -> ProcessEventResult {
    if crate::durable_v2::enabled(config) {
        let result = crate::durable_v2::enqueue(config, chain, event, transport);
        return ProcessEventResult {
            key: build_event_key(event),
            status: if result.is_ok() {
                "durably_queued"
            } else {
                "enqueue_failed"
            }
            .into(),
            reason: None,
            duration_ms: None,
            error: result.err(),
        };
    }
    process_event_with(
        config,
        state,
        chain,
        event,
        now_ms,
        &DeliveryRuntime {
            transport,
            nonce_source: &neo_os_chain_n3::tx::OsNonce,
            waiter: &neo_os_chain_n3::tx::SystemWaiter,
        },
    )
}
fn storage_failed(
    state: &mut JsObject,
    chain: &str,
    error: String,
    events: Vec<ProcessEventResult>,
) -> ChainProcessResult {
    tracing::warn!(
        chain,
        error,
        "discovery persistence failed; cursor retained"
    );
    increment_metric(state, "discovery_failures_total", 1.0);
    ChainProcessResult {
        chain: chain.into(),
        skipped: false,
        discovery_healthy: false,
        scanned_blocks: None,
        scanned_requests: None,
        events,
        retries: vec![],
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScannedRange {
    #[serde(
        serialize_with = "serialize_json_safe_u64",
        deserialize_with = "deserialize_json_safe_u64"
    )]
    pub from: u64,
    #[serde(
        serialize_with = "serialize_json_safe_u64",
        deserialize_with = "deserialize_json_safe_u64"
    )]
    pub to: u64,
    #[serde(
        serialize_with = "serialize_json_safe_u64",
        deserialize_with = "deserialize_json_safe_u64"
    )]
    pub latest: u64,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "serialize_optional_json_safe_u64",
        deserialize_with = "deserialize_optional_json_safe_u64"
    )]
    pub confirmed_tip: Option<u64>,
}

fn serialize_json_safe_u64<S>(value: &u64, serializer: S) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    if *value > MAX_SAFE_JSON_INTEGER {
        serializer.serialize_str(&value.to_string())
    } else {
        serializer.serialize_u64(*value)
    }
}

fn serialize_optional_json_safe_u64<S>(
    value: &Option<u64>,
    serializer: S,
) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    match value {
        Some(value) => serialize_json_safe_u64(value, serializer),
        None => serializer.serialize_none(),
    }
}

struct JsonSafeU64Visitor;

impl Visitor<'_> for JsonSafeU64Visitor {
    type Value = u64;

    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("a non-negative integer or its decimal string")
    }

    fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E> {
        Ok(value)
    }

    fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        u64::try_from(value).map_err(E::custom)
    }

    fn visit_f64<E>(self, value: f64) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        if value.is_finite()
            && value >= 0.0
            && value.fract() == 0.0
            && value <= MAX_SAFE_JSON_INTEGER as f64
        {
            Ok(value as u64)
        } else {
            Err(E::custom(
                "floating-point cursor is not an exact safe integer",
            ))
        }
    }

    fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        value.parse::<u64>().map_err(E::custom)
    }
}

fn deserialize_json_safe_u64<'de, D>(deserializer: D) -> Result<u64, D::Error>
where
    D: Deserializer<'de>,
{
    deserializer.deserialize_any(JsonSafeU64Visitor)
}

fn deserialize_optional_json_safe_u64<'de, D>(deserializer: D) -> Result<Option<u64>, D::Error>
where
    D: Deserializer<'de>,
{
    struct OptionalVisitor;

    impl<'de> Visitor<'de> for OptionalVisitor {
        type Value = Option<u64>;

        fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str("null or an exact unsigned integer")
        }

        fn visit_none<E>(self) -> Result<Self::Value, E> {
            Ok(None)
        }

        fn visit_unit<E>(self) -> Result<Self::Value, E> {
            Ok(None)
        }

        fn visit_some<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
        where
            D: Deserializer<'de>,
        {
            deserialize_json_safe_u64(deserializer).map(Some)
        }
    }

    deserializer.deserialize_option(OptionalVisitor)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChainProcessResult {
    pub chain: String,
    pub skipped: bool,
    /// True only when discovery RPC/cursor resolution completed without a
    /// discovery failure in this call. An empty scan is healthy; a failed scan
    /// must not be reported as a success heartbeat by the orchestrator.
    pub discovery_healthy: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scanned_blocks: Option<ScannedRange>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scanned_requests: Option<ScannedRange>,
    pub events: Vec<ProcessEventResult>,
    pub retries: Vec<ProcessEventResult>,
}

pub fn filter_new_events(
    state: &JsObject,
    chain: &str,
    events: &[JsValue],
) -> (Vec<JsValue>, usize) {
    let mut unique = Vec::new();
    let mut seen_keys = HashSet::new();
    let mut duplicates = 0;

    for event in events {
        let key = build_event_key(event);
        if seen_keys.contains(&key)
            || has_processed_event(state, chain, &key)
            || is_event_queued_for_retry(state, chain, &key)
            || is_event_dead_lettered(state, chain, &key)
        {
            duplicates += 1;
            continue;
        }
        seen_keys.insert(key);
        unique.push(event.clone());
    }

    (unique, duplicates)
}

pub fn resolve_request_cursor(
    config: &RelayerConfig,
    state: &JsObject,
    chain: &str,
    latest_request_id: u64,
) -> Option<u64> {
    let configured_start = config
        .raw
        .get("startRequestIds")
        .and_then(|v| v.get(chain))
        .and_then(json_u64);

    let default_start = configured_start.unwrap_or(1).max(1);
    let default_tail_start = match configured_start {
        None => latest_request_id
            .saturating_sub(config.max_blocks_per_tick.saturating_sub(1))
            .max(1),
        Some(_) => default_start,
    };

    let chain_state = match state.get(chain).and_then(|v| v.as_object()) {
        Some(cs) => cs,
        None => return Some(default_tail_start),
    };

    let last_request_id_raw = match chain_state.get("last_request_id") {
        Some(v) => v,
        None => return Some(default_tail_start),
    };

    if matches!(last_request_id_raw, JsValue::Null | JsValue::Undefined) {
        return Some(default_tail_start);
    }

    let Some(last_request_id) = state_u64(last_request_id_raw) else {
        // An old JSON number outside JavaScript's safe range may already have
        // been rounded. Rescan the bounded tail rather than risk skipping an id.
        return Some(default_tail_start);
    };

    if last_request_id > latest_request_id {
        return Some(default_tail_start);
    }

    last_request_id.checked_add(1)
}

fn json_u64(value: &Value) -> Option<u64> {
    match value {
        Value::String(value) => value.parse().ok(),
        Value::Number(value) => value
            .as_u64()
            .filter(|value| *value <= MAX_SAFE_JSON_INTEGER)
            .or_else(|| {
                value.as_f64().and_then(|value| {
                    (value.is_finite()
                        && value >= 0.0
                        && value.fract() == 0.0
                        && value <= MAX_SAFE_JSON_INTEGER as f64)
                        .then_some(value as u64)
                })
            }),
        _ => None,
    }
}

fn state_u64(value: &JsValue) -> Option<u64> {
    match value {
        JsValue::Str(value) | JsValue::BigInt(value) => value.parse().ok(),
        JsValue::Number(value)
            if value.is_finite()
                && *value >= 0.0
                && value.fract() == 0.0
                && *value <= MAX_SAFE_JSON_INTEGER as f64 =>
        {
            Some(*value as u64)
        }
        _ => None,
    }
}

fn request_cursor_state_value(value: u64) -> JsValue {
    JsValue::Str(value.to_string())
}

pub fn process_chain_neo_n3(
    config: &RelayerConfig,
    state: &mut JsObject,
    transport: &RelayerHttpTransport,
    now_ms: f64,
) -> ChainProcessResult {
    let n3_cfg = config.raw.get("neo_n3").cloned().unwrap_or(Value::Null);
    let discovery_failures_before = state
        .get("metrics")
        .and_then(JsValue::as_object)
        .and_then(|m| m.get("discovery_failures_total"))
        .and_then(|v| match v {
            JsValue::Number(n) => Some(*n),
            _ => None,
        })
        .unwrap_or(0.0);
    let oracle_contract = n3_cfg
        .get("oracleContract")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();

    if oracle_contract.is_empty() {
        return ChainProcessResult {
            chain: "neo_n3".to_string(),
            skipped: true,
            discovery_healthy: true,
            scanned_blocks: None,
            scanned_requests: None,
            events: vec![],
            retries: vec![],
        };
    }

    let rpc_urls: Vec<String> = n3_cfg
        .get("rpcUrls")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();

    if rpc_urls.is_empty() {
        return ChainProcessResult {
            chain: "neo_n3".to_string(),
            skipped: true,
            discovery_healthy: true,
            scanned_blocks: None,
            scanned_requests: None,
            events: vec![],
            retries: vec![],
        };
    }

    let rpc_client =
        match neo_os_chain_n3::rpc::NeoRpcClient::new(transport.clone(), rpc_urls, true) {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!("Failed to create Neo N3 RPC client: {e}");
                return ChainProcessResult {
                    chain: "neo_n3".to_string(),
                    skipped: false,
                    discovery_healthy: false,
                    scanned_blocks: None,
                    scanned_requests: None,
                    events: vec![],
                    retries: vec![],
                };
            }
        };

    let due_retries_before = get_due_retry_items(state, "neo_n3", now_ms);
    let mut skip_discovery_for_idle = false;

    if config.discovery_idle_backoff_ms > 0 && due_retries_before.is_empty() {
        let last_discovery_at = state
            .get("neo_n3")
            .and_then(|v| v.as_object())
            .and_then(|cs| cs.get("last_discovery_at"))
            .and_then(|v| match v {
                JsValue::Number(n) => Some(*n),
                _ => None,
            })
            .unwrap_or(0.0);

        if last_discovery_at > 0.0
            && now_ms - last_discovery_at < config.discovery_idle_backoff_ms as f64
        {
            skip_discovery_for_idle = true;
            increment_metric(state, "discovery_idle_skips_total", 1.0);
        }
    }

    let mut scanned_blocks = None;
    let mut event_results = Vec::new();

    if !skip_discovery_for_idle {
        if let Some(cs) = state.get_mut("neo_n3").and_then(|v| v.as_object_mut()) {
            cs.set("last_discovery_at", JsValue::Number(now_ms));
        }

        match neo_os_chain_n3::scan::get_latest_block(&rpc_client) {
            Ok(latest_block_u32) => {
                let latest_block = latest_block_u32 as f64;
                let confirmations = config
                    .raw
                    .get("confirmations")
                    .and_then(|v| v.get("neo_n3"))
                    .and_then(|v| v.as_f64())
                    .unwrap_or(0.0)
                    .max(0.0);

                let confirmed_tip = latest_block - confirmations;
                if confirmed_tip >= 0.0 {
                    let start_block = config
                        .raw
                        .get("startBlocks")
                        .and_then(|v| v.get("neo_n3"))
                        .map(JsValue::from_json)
                        .unwrap_or(JsValue::Undefined);

                    let last_block_raw = state
                        .get("neo_n3")
                        .and_then(|v| v.as_object())
                        .and_then(|cs| cs.get("last_block"))
                        .cloned()
                        .unwrap_or(JsValue::Undefined);

                    match resolve_chain_from_block(
                        "neo_n3",
                        &start_block,
                        &last_block_raw,
                        confirmed_tip,
                    ) {
                        Ok(from_block) if from_block <= confirmed_tip => {
                            let to_block = (from_block + config.max_blocks_per_tick as f64 - 1.0)
                                .min(confirmed_tip);
                            let scanned_res = neo_os_chain_n3::scan::scan_oracle_requests(
                                &rpc_client,
                                oracle_contract,
                                from_block as u32,
                                to_block as u32,
                                Some(config.concurrency),
                            );

                            match scanned_res {
                                Ok(raw_events) => {
                                    let js_events: Vec<JsValue> = raw_events
                                        .iter()
                                        .map(|event| {
                                            JsValue::from_json(&serde_json::json!({
                                                "chain": "neo_n3",
                                                "eventName": event.event_name.clone(),
                                                "requestId": event.request_id,
                                                "requestType": event.request_type,
                                                "appId": event.app_id,
                                                "moduleId": event.module_id,
                                                "operation": event.operation,
                                                "requester": event.requester,
                                                "callbackContract": event.callback_contract,
                                                "callbackMethod": event.callback_method,
                                                "payload": event.payload_text,
                                                "payloadHash": event.payload_hash,
                                                "createdAtMs": event.created_at_ms,
                                                "fulfilledAtMs": event.fulfilled_at_ms,
                                                "blockNumber": event.block_number,
                                                "txHash": event.tx_hash,
                                                "logIndex": event.log_index,
                                            }))
                                        })
                                        .collect();

                                    increment_metric(
                                        state,
                                        "events_scanned_total",
                                        js_events.len() as f64,
                                    );
                                    let (filtered, dups) = if crate::durable_v2::enabled(config) {
                                        (js_events.clone(), 0)
                                    } else {
                                        filter_new_events(state, "neo_n3", &js_events)
                                    };
                                    increment_metric(
                                        state,
                                        "duplicates_skipped_total",
                                        dups as f64,
                                    );

                                    for ev in &filtered {
                                        let res = discovered_event(
                                            config, state, "neo_n3", ev, now_ms, transport,
                                        );
                                        if res.status == "enqueue_failed" {
                                            return storage_failed(
                                                state,
                                                "neo_n3",
                                                res.error.unwrap_or_default(),
                                                event_results,
                                            );
                                        }
                                        event_results.push(res);
                                    }

                                    if crate::durable_v2::enabled(config) {
                                        if let Err(error) = crate::durable_v2::checkpoint(
                                            config,
                                            "neo_n3",
                                            Some(&(to_block as u64).to_string()),
                                            transport,
                                        ) {
                                            return storage_failed(
                                                state,
                                                "neo_n3",
                                                error,
                                                event_results,
                                            );
                                        }
                                    }

                                    if let Some(cs) =
                                        state.get_mut("neo_n3").and_then(|v| v.as_object_mut())
                                    {
                                        cs.set("last_block", JsValue::Number(to_block));
                                    }

                                    scanned_blocks = Some(ScannedRange {
                                        from: from_block as u64,
                                        to: to_block as u64,
                                        latest: latest_block_u32.into(),
                                        confirmed_tip: Some(confirmed_tip as u64),
                                    });
                                }
                                Err(e) => {
                                    increment_metric(state, "discovery_failures_total", 1.0);
                                    tracing::warn!("Failed to scan Neo N3 oracle requests: {e}");
                                }
                            }
                        }
                        Ok(_) => {
                            // Up to date
                        }
                        Err(e) => {
                            increment_metric(state, "discovery_failures_total", 1.0);
                            tracing::warn!("Failed to resolve Neo N3 chain cursor: {e}");
                        }
                    }
                }
            }
            Err(e) => {
                increment_metric(state, "discovery_failures_total", 1.0);
                tracing::warn!("Failed to get latest Neo N3 block: {e}");
            }
        }
    }

    // Drain due retries
    let due_retries = if crate::durable_v2::enabled(config) {
        vec![]
    } else {
        get_due_retry_items(state, "neo_n3", now_ms)
    };
    let mut retry_results = Vec::new();

    for retry_item in due_retries {
        if let Some(event) = retry_item.as_object().and_then(|obj| obj.get("event")) {
            let res = process_event_with(
                config,
                state,
                "neo_n3",
                event,
                now_ms,
                &DeliveryRuntime {
                    transport,
                    nonce_source: &neo_os_chain_n3::tx::OsNonce,
                    waiter: &neo_os_chain_n3::tx::SystemWaiter,
                },
            );
            retry_results.push(res);
        }
    }

    ChainProcessResult {
        chain: "neo_n3".to_string(),
        skipped: false,
        discovery_healthy: state
            .get("metrics")
            .and_then(JsValue::as_object)
            .and_then(|m| m.get("discovery_failures_total"))
            .and_then(|v| match v {
                JsValue::Number(n) => Some(*n),
                _ => None,
            })
            .unwrap_or(discovery_failures_before)
            <= discovery_failures_before,
        scanned_blocks,
        scanned_requests: None,
        events: event_results,
        retries: retry_results,
    }
}

pub fn process_chain_neox(
    config: &RelayerConfig,
    state: &mut JsObject,
    transport: &RelayerHttpTransport,
    now_ms: f64,
) -> ChainProcessResult {
    let neox_cfg = config.raw.get("neox").cloned().unwrap_or(Value::Null);
    let discovery_failures_before = state
        .get("metrics")
        .and_then(JsValue::as_object)
        .and_then(|m| m.get("discovery_failures_total"))
        .and_then(|v| match v {
            JsValue::Number(n) => Some(*n),
            _ => None,
        })
        .unwrap_or(0.0);
    let oracle_contract = neox_cfg
        .get("oracleContract")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();

    if oracle_contract.is_empty() {
        return ChainProcessResult {
            chain: "neox".to_string(),
            skipped: true,
            discovery_healthy: true,
            scanned_blocks: None,
            scanned_requests: None,
            events: vec![],
            retries: vec![],
        };
    }

    let rpc_urls: Vec<String> = neox_cfg
        .get("rpcUrls")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();

    if rpc_urls.is_empty() {
        return ChainProcessResult {
            chain: "neox".to_string(),
            skipped: true,
            discovery_healthy: true,
            scanned_blocks: None,
            scanned_requests: None,
            events: vec![],
            retries: vec![],
        };
    }

    let primary = rpc_urls.first().cloned().unwrap_or_default();
    let evm_client = neo_os_chain_evm::rpc::EvmRpcClient::new(primary, rpc_urls, transport.clone());

    let mut scanned_requests = None;
    let mut event_results = Vec::new();

    match evm_client.get_latest_request_id(oracle_contract) {
        Ok(latest_id) => {
            if let Some(from_id) = resolve_request_cursor(config, state, "neox", latest_id) {
                if from_id <= latest_id {
                    let to_id = from_id
                        .saturating_add(config.max_blocks_per_tick.saturating_sub(1))
                        .min(latest_id);
                    match evm_client.scan_requests_by_id(oracle_contract, from_id, to_id) {
                        Ok(raw_events) => {
                            let js_events: Vec<JsValue> = raw_events
                                .iter()
                                .filter_map(neo_os_chain_evm::scan::build_event_from_request)
                                .map(|ev| {
                                    let val = serde_json::json!({
                                        "chain": "neox",
                                        "requestId": ev.request_id,
                                        "requestType": ev.request_type,
                                        "appId": ev.app_id,
                                        "moduleId": ev.module_id,
                                        "operation": ev.operation,
                                        "payload": ev.payload_text,
                                        "messageId": ev.message_id,
                                        "requester": ev.requester,
                                        "callbackContract": ev.callback_contract,
                                        "callbackMethod": ev.callback_method,
                                    });
                                    JsValue::from_json(&val)
                                })
                                .collect();

                            increment_metric(state, "events_scanned_total", js_events.len() as f64);
                            let (filtered, dups) = if crate::durable_v2::enabled(config) {
                                (js_events.clone(), 0)
                            } else {
                                filter_new_events(state, "neox", &js_events)
                            };
                            increment_metric(state, "duplicates_skipped_total", dups as f64);

                            for ev in &filtered {
                                let res =
                                    discovered_event(config, state, "neox", ev, now_ms, transport);
                                if res.status == "enqueue_failed" {
                                    return storage_failed(
                                        state,
                                        "neox",
                                        res.error.unwrap_or_default(),
                                        event_results,
                                    );
                                }
                                event_results.push(res);
                            }

                            if crate::durable_v2::enabled(config) {
                                if let Err(error) = crate::durable_v2::checkpoint(
                                    config,
                                    "neox",
                                    Some(&to_id.to_string()),
                                    transport,
                                ) {
                                    return storage_failed(state, "neox", error, event_results);
                                }
                            }

                            if let Some(cs) = state.get_mut("neox").and_then(|v| v.as_object_mut())
                            {
                                cs.set("last_request_id", request_cursor_state_value(to_id));
                            }

                            scanned_requests = Some(ScannedRange {
                                from: from_id,
                                to: to_id,
                                latest: latest_id,
                                confirmed_tip: None,
                            });
                        }
                        Err(e) => {
                            increment_metric(state, "discovery_failures_total", 1.0);
                            tracing::warn!("Failed to scan NeoX requests by id: {e}");
                        }
                    }
                }
            }
        }
        Err(e) => {
            increment_metric(state, "discovery_failures_total", 1.0);
            tracing::warn!("Failed to get latest NeoX request id: {e}");
        }
    }

    // Drain due retries
    let due_retries = if crate::durable_v2::enabled(config) {
        vec![]
    } else {
        get_due_retry_items(state, "neox", now_ms)
    };
    let mut retry_results = Vec::new();

    for retry_item in due_retries {
        if let Some(event) = retry_item.as_object().and_then(|obj| obj.get("event")) {
            let res = process_event_with(
                config,
                state,
                "neox",
                event,
                now_ms,
                &DeliveryRuntime {
                    transport,
                    nonce_source: &neo_os_chain_n3::tx::OsNonce,
                    waiter: &neo_os_chain_n3::tx::SystemWaiter,
                },
            );
            retry_results.push(res);
        }
    }

    ChainProcessResult {
        chain: "neox".to_string(),
        skipped: false,
        discovery_healthy: state
            .get("metrics")
            .and_then(JsValue::as_object)
            .and_then(|m| m.get("discovery_failures_total"))
            .and_then(|v| match v {
                JsValue::Number(n) => Some(*n),
                _ => None,
            })
            .unwrap_or(discovery_failures_before)
            <= discovery_failures_before,
        scanned_blocks: None,
        scanned_requests,
        events: event_results,
        retries: retry_results,
    }
}

#[cfg(test)]
mod tests {
    use neo_os_core::js_value::{JsObject, JsValue};
    use neo_os_core::state::{
        build_event_key, create_empty_relayer_state, normalize_state_file_value,
    };
    use serde_json::json;

    use super::{
        filter_new_events, request_cursor_state_value, resolve_request_cursor, ScannedRange,
        MAX_SAFE_JSON_INTEGER,
    };
    use crate::config::{js_value_to_json, RelayerConfig};

    fn config(raw: serde_json::Value) -> RelayerConfig {
        RelayerConfig {
            repo_root: ".".to_string(),
            instance_id: "test".to_string(),
            state_file: "unused.json".to_string(),
            network: "testnet".to_string(),
            node_env: "test".to_string(),
            mode: "combined".to_string(),
            active_chains: vec!["neox".to_string()],
            poll_interval_ms: 1_000,
            concurrency: 1,
            max_blocks_per_tick: 10,
            discovery_idle_backoff_ms: 0,
            state_persist_min_interval_ms: 0,
            raw,
        }
    }

    #[test]
    fn neox_cursor_round_trips_beyond_javascript_safe_integer() {
        let prior = MAX_SAFE_JSON_INTEGER + 17;
        let latest = prior + 100;
        let mut state = create_empty_relayer_state();
        state
            .get_mut("neox")
            .and_then(JsValue::as_object_mut)
            .expect("NeoX state")
            .set("last_request_id", JsValue::Str(prior.to_string()));

        assert_eq!(
            resolve_request_cursor(&config(json!({})), &state, "neox", latest),
            Some(prior + 1)
        );
        assert_eq!(
            request_cursor_state_value(latest),
            JsValue::Str(latest.to_string()),
            "new state files persist request cursors as exact decimal strings"
        );

        state
            .get_mut("neox")
            .and_then(JsValue::as_object_mut)
            .expect("NeoX state")
            .set("last_request_id", request_cursor_state_value(latest));
        let persisted = js_value_to_json(&JsValue::Object(state.clone()));
        assert_eq!(persisted["neox"]["last_request_id"], latest.to_string());
        let reopened = normalize_state_file_value(&JsValue::from_json(&persisted));
        assert_eq!(
            resolve_request_cursor(&config(json!({})), &reopened, "neox", latest + 10),
            Some(latest + 1),
            "decimal cursor survives the state-file write/load path"
        );

        let range = ScannedRange {
            from: prior + 1,
            to: prior + 10,
            latest,
            confirmed_tip: None,
        };
        let json = serde_json::to_value(&range).expect("serialize range");
        assert_eq!(json["from"], (prior + 1).to_string());
        assert_eq!(json["to"], (prior + 10).to_string());
        assert_eq!(json["latest"], latest.to_string());
        assert_eq!(
            serde_json::from_value::<ScannedRange>(json).expect("deserialize range"),
            range
        );
    }

    #[test]
    fn legacy_numeric_cursor_is_accepted_only_while_it_is_unambiguous() {
        let mut state = create_empty_relayer_state();
        state
            .get_mut("neox")
            .and_then(JsValue::as_object_mut)
            .expect("NeoX state")
            .set("last_request_id", JsValue::Number(41.0));
        assert_eq!(
            resolve_request_cursor(&config(json!({})), &state, "neox", 100),
            Some(42)
        );

        state
            .get_mut("neox")
            .and_then(JsValue::as_object_mut)
            .expect("NeoX state")
            .set(
                "last_request_id",
                JsValue::Number((MAX_SAFE_JSON_INTEGER + 1) as f64),
            );
        let latest = MAX_SAFE_JSON_INTEGER + 100;
        assert_eq!(
            resolve_request_cursor(&config(json!({})), &state, "neox", latest),
            Some(latest - 9),
            "an already-rounded legacy value must trigger bounded tail rescan"
        );
    }

    #[test]
    fn configured_big_cursor_and_u64_max_never_pass_through_f64() {
        let configured = MAX_SAFE_JSON_INTEGER + 31;
        let state = create_empty_relayer_state();
        assert_eq!(
            resolve_request_cursor(
                &config(json!({
                    "startRequestIds": {"neox": configured.to_string()}
                })),
                &state,
                "neox",
                configured + 10,
            ),
            Some(configured)
        );

        let mut state = state;
        state
            .get_mut("neox")
            .and_then(JsValue::as_object_mut)
            .expect("NeoX state")
            .set("last_request_id", JsValue::Str(u64::MAX.to_string()));
        assert_eq!(
            resolve_request_cursor(&config(json!({})), &state, "neox", u64::MAX),
            None,
            "there is no cursor after u64::MAX"
        );
    }

    #[test]
    fn dead_lettered_events_do_not_reenter_discovery() {
        let mut event = JsObject::new();
        event.set("chain", JsValue::Str("neox".to_string()));
        event.set("requestId", JsValue::Str("42".to_string()));
        let event = JsValue::Object(event);
        let key = build_event_key(&event);
        let mut letter = JsObject::new();
        letter.set("key", JsValue::Str(key));
        let mut state = create_empty_relayer_state();
        state
            .get_mut("neox")
            .and_then(JsValue::as_object_mut)
            .expect("NeoX state")
            .set(
                "dead_letters",
                JsValue::Array(vec![JsValue::Object(letter)]),
            );

        let (new, duplicates) = filter_new_events(&state, "neox", &[event]);
        assert!(new.is_empty());
        assert_eq!(duplicates, 1);
    }
}
