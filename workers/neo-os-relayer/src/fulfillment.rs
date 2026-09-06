//! Event fulfillment coordinator and execution pipeline.
//!
//! Pinned against `workers/morpheus-relayer/src/fulfillment/`.

use neo_os_core::js_value::{JsObject, JsValue};
use neo_os_core::state::{
    build_event_key, has_processed_event, increment_labeled_failure, increment_metric,
    ms_to_iso_string, record_processed_event, schedule_retry,
};
use serde::{Deserialize, Serialize};

use crate::config::RelayerConfig;
use crate::delivery::{deliver_event, DeliveryReceipt};
use crate::transport::RelayerHttpTransport;

pub fn trim_onchain_error_message(value: &str, max_length: usize) -> String {
    let re_url = regex_lite_replace_urls(value);
    let trimmed = re_url.trim();
    if trimmed.is_empty() {
        return "request execution failed".to_string();
    }
    if trimmed.chars().count() <= max_length {
        trimmed.to_string()
    } else if max_length <= 3 {
        ".".repeat(max_length)
    } else {
        let mut output: String = trimmed.chars().take(max_length - 3).collect();
        output.push_str("...");
        output
    }
}

fn regex_lite_replace_urls(text: &str) -> String {
    // Advance by Unicode scalar values so a non-ASCII error cannot trigger an
    // invalid byte-boundary slice or turn UTF-8 bytes into mojibake.
    let mut result = String::with_capacity(text.len());
    let mut pos = 0;

    while pos < text.len() {
        let remaining = &text[pos..];
        if remaining.starts_with("http://") || remaining.starts_with("https://") {
            result.push_str("[redacted-url]");
            pos += if remaining.starts_with("https://") {
                8
            } else {
                7
            };
            while pos < text.len() {
                let ch = text[pos..]
                    .chars()
                    .next()
                    .expect("position is on a char boundary");
                if ch.is_whitespace() || ch == ']' {
                    break;
                }
                pos += ch.len_utf8();
            }
        } else {
            let ch = remaining
                .chars()
                .next()
                .expect("position is on a char boundary");
            result.push(ch);
            pos += ch.len_utf8();
        }
    }
    result
}

pub fn is_already_fulfilled_error(message: &str) -> bool {
    let lower = message.to_lowercase();
    lower.contains("already fulfilled")
        || lower.contains("request already fulfilled")
        || lower.contains("reason: request already fulfilled")
}

pub fn is_terminal_configuration_error(message: &str) -> bool {
    let lower = message.to_lowercase();
    lower.contains("reason: unauthorized")
        || lower.contains("invalid signature")
        || lower.contains("verifier rejected signature")
        || lower.contains("oracle verifier")
        || lower.contains("oracle_verifier")
        || lower.contains("updater not set")
        || lower.contains("callback not allowed")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessEventResult {
    pub key: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// A dead letter is deliberately not a processed record: delivery never
/// completed. It is nevertheless terminal for automatic discovery until an
/// operator explicitly removes/requeues it, otherwise an unimplemented lane
/// would be rediscovered and exhausted on every tick.
pub fn is_event_dead_lettered(state: &JsObject, chain: &str, event_key: &str) -> bool {
    state
        .get(chain)
        .and_then(JsValue::as_object)
        .and_then(|chain_state| chain_state.get("dead_letters"))
        .and_then(JsValue::as_array)
        .is_some_and(|letters| {
            letters.iter().any(|letter| {
                letter
                    .as_object()
                    .and_then(|letter| letter.get("key"))
                    .and_then(JsValue::as_str)
                    == Some(event_key)
            })
        })
}

fn event_string(event: &JsValue, field: &str) -> String {
    event
        .as_object()
        .and_then(|event| event.get(field))
        .map(|value| match value {
            JsValue::Str(value) | JsValue::BigInt(value) => value.clone(),
            JsValue::Number(value) if value.is_finite() => value.to_string(),
            _ => String::new(),
        })
        .unwrap_or_default()
}

fn dead_letter_limit(config: &RelayerConfig) -> usize {
    let configured = config
        .raw
        .get("deadLetterLimit")
        .and_then(|value| {
            value
                .as_u64()
                .or_else(|| value.as_str().and_then(|value| value.parse().ok()))
        })
        .and_then(|value| usize::try_from(value).ok())
        .unwrap_or(200);
    if configured == 0 {
        200
    } else {
        configured
    }
}

struct DeadLetterInput<'a> {
    chain: &'a str,
    event: &'a JsValue,
    error: &'a str,
    retry_result: &'a JsValue,
    now_ms: f64,
    reason: &'a str,
}

fn archive_unprocessed_dead_letter(
    config: &RelayerConfig,
    state: &mut JsObject,
    input: DeadLetterInput<'_>,
) {
    let event_key = build_event_key(input.event);
    let attempts = input
        .retry_result
        .as_object()
        .and_then(|result| result.get("attempts"))
        .cloned()
        .unwrap_or(JsValue::Number(0.0));
    let mut letter = JsObject::new();
    letter.set("key", JsValue::Str(event_key.clone()));
    letter.set(
        "request_id",
        JsValue::Str(event_string(input.event, "requestId")),
    );
    letter.set(
        "request_type",
        JsValue::Str(event_string(input.event, "requestType")),
    );
    letter.set(
        "module_id",
        JsValue::Str(event_string(input.event, "moduleId")),
    );
    letter.set(
        "operation",
        JsValue::Str(event_string(input.event, "operation")),
    );
    letter.set("chain", JsValue::Str(input.chain.to_string()));
    letter.set("event", input.event.clone());
    letter.set("exhausted_at", JsValue::Str(ms_to_iso_string(input.now_ms)));
    letter.set("attempts", attempts);
    letter.set("last_error", JsValue::Str(input.error.to_string()));
    letter.set("reason", JsValue::Str(input.reason.to_string()));

    let Some(chain_state) = state.get_mut(input.chain).and_then(JsValue::as_object_mut) else {
        return;
    };
    let mut letters = chain_state
        .get("dead_letters")
        .and_then(JsValue::as_array)
        .map(<[JsValue]>::to_vec)
        .unwrap_or_default();
    letters.retain(|letter| {
        letter
            .as_object()
            .and_then(|letter| letter.get("key"))
            .and_then(JsValue::as_str)
            != Some(event_key.as_str())
    });
    letters.push(JsValue::Object(letter));
    let limit = dead_letter_limit(config);
    if letters.len() > limit {
        letters.drain(..letters.len() - limit);
    }
    chain_state.set("dead_letters", JsValue::Array(letters));
}

/// Process a single event through the fulfillment pipeline:
/// 1. Check idempotency against in-memory state
/// 2. Call compute/oracle worker (in enclave or local)
/// 3. Sign result
/// 4. Broadcast on-chain callback
/// 5. Update state & metrics
pub fn process_event(
    config: &RelayerConfig,
    state: &mut JsObject,
    chain: &str,
    event: &JsValue,
    now_ms: f64,
) -> ProcessEventResult {
    let transport = RelayerHttpTransport::new();
    let runtime = DeliveryRuntime {
        transport: &transport,
        nonce_source: &neo_os_chain_n3::tx::OsNonce,
        waiter: &neo_os_chain_n3::tx::SystemWaiter,
    };
    process_event_with(config, state, chain, event, now_ms, &runtime)
}

pub(crate) struct DeliveryRuntime<'a, T, N, W> {
    pub(crate) transport: &'a T,
    pub(crate) nonce_source: &'a N,
    pub(crate) waiter: &'a W,
}

/// Testable form of [`process_event`].  The transport, nonce and confirmation
/// clock are injected so the full custody/RPC protocol can be exercised
/// without touching a live chain.
pub(crate) fn process_event_with<T, N, W>(
    config: &RelayerConfig,
    state: &mut JsObject,
    chain: &str,
    event: &JsValue,
    now_ms: f64,
    runtime: &DeliveryRuntime<'_, T, N, W>,
) -> ProcessEventResult
where
    T: neo_os_chain_n3::HttpTransport + neo_os_chain_evm::HttpTransport,
    N: neo_os_chain_n3::tx::NonceSource,
    W: neo_os_chain_n3::tx::Waiter,
{
    let event_key = build_event_key(event);

    if is_event_dead_lettered(state, chain, &event_key) {
        increment_metric(state, "duplicates_skipped_total", 1.0);
        return ProcessEventResult {
            key: event_key,
            status: "skipped_dead_letter".to_string(),
            reason: Some("delivery_exhausted".to_string()),
            duration_ms: None,
            error: None,
        };
    }

    if has_processed_event(state, chain, &event_key) {
        increment_metric(state, "duplicates_skipped_total", 1.0);
        return ProcessEventResult {
            key: event_key,
            status: "skipped_duplicate".to_string(),
            reason: Some("already_processed".to_string()),
            duration_ms: None,
            error: None,
        };
    }

    match deliver_event(
        config,
        chain,
        event,
        runtime.transport,
        runtime.nonce_source,
        runtime.waiter,
    ) {
        Ok(receipt) => {
            record_delivery_success(config, state, chain, event, now_ms, &receipt);
            ProcessEventResult {
                key: event_key,
                status: "fulfilled".to_string(),
                reason: None,
                duration_ms: None,
                error: None,
            }
        }
        Err(error) if is_already_fulfilled_error(&error) => {
            let receipt = DeliveryReceipt {
                request_id: event_string(event, "requestId"),
                tx_hash: String::new(),
                vm_state: "RECONCILED".to_string(),
                target_chain: chain.to_string(),
                exception: Some(trim_onchain_error_message(&error, 240)),
            };
            record_delivery_success(config, state, chain, event, now_ms, &receipt);
            ProcessEventResult {
                key: event_key,
                status: "already_fulfilled".to_string(),
                reason: Some("onchain_request_already_settled".to_string()),
                duration_ms: None,
                error: None,
            }
        }
        Err(error) => record_delivery_failure(config, state, chain, event, now_ms, error),
    }
}

fn record_delivery_success(
    config: &RelayerConfig,
    state: &mut JsObject,
    chain: &str,
    event: &JsValue,
    now_ms: f64,
    receipt: &DeliveryReceipt,
) {
    increment_metric(state, "events_processed_total", 1.0);
    increment_metric(state, "fulfill_success_total", 1.0);

    let mut meta = JsObject::new();
    meta.set(
        "attempts",
        JsValue::Number(next_attempt_number(state, chain, event)),
    );
    meta.set("route", JsValue::Str("rust-enclave-fulfill".to_string()));
    meta.set(
        "fulfill_tx",
        JsValue::from_json(&serde_json::to_value(receipt).unwrap_or(serde_json::Value::Null)),
    );
    meta.set("worker_status", JsValue::Number(200.0));

    let limits = state_limits(config);
    record_processed_event(state, chain, event, "fulfilled", &meta, &limits, now_ms);
}

fn record_delivery_failure(
    config: &RelayerConfig,
    state: &mut JsObject,
    chain: &str,
    event: &JsValue,
    now_ms: f64,
    error: String,
) -> ProcessEventResult {
    let event_key = build_event_key(event);
    let sanitized = trim_onchain_error_message(&error, 240);
    let (app_id, module_id, operation) = match event {
        JsValue::Object(map) => (
            map.get("appId")
                .and_then(JsValue::as_str)
                .unwrap_or("")
                .to_string(),
            map.get("moduleId")
                .and_then(JsValue::as_str)
                .unwrap_or("")
                .to_string(),
            map.get("operation")
                .and_then(JsValue::as_str)
                .unwrap_or("")
                .to_string(),
        ),
        _ => (String::new(), String::new(), String::new()),
    };

    increment_metric(state, "events_failed_total", 1.0);
    increment_metric(state, "events_processed_total", 1.0);
    increment_metric(state, "fulfill_failure_total", 1.0);
    increment_labeled_failure(
        state,
        chain,
        &format!("{app_id}.{module_id}"),
        &operation,
        1.0,
    );

    let retry_config = retry_config(config);

    let retry_result = schedule_retry(state, chain, event, &sanitized, &retry_config, 0.5, now_ms);
    let retry_status = retry_result
        .as_object()
        .and_then(|result| result.get("status"))
        .and_then(JsValue::as_str)
        .unwrap_or("exhausted");
    let status = if retry_status == "scheduled" {
        increment_metric(state, "retries_scheduled_total", 1.0);
        "delivery_retry_scheduled"
    } else {
        archive_unprocessed_dead_letter(
            config,
            state,
            DeadLetterInput {
                chain,
                event,
                error: &sanitized,
                retry_result: &retry_result,
                now_ms,
                reason: "delivery_exhausted",
            },
        );
        increment_metric(state, "retries_exhausted_total", 1.0);
        "delivery_exhausted"
    };

    ProcessEventResult {
        key: event_key,
        status: status.to_string(),
        reason: Some("onchain_delivery_failed".to_string()),
        duration_ms: None,
        error: Some(sanitized),
    }
}

fn retry_config(config: &RelayerConfig) -> JsObject {
    let mut retry_config = JsObject::new();
    for (key, default) in [
        ("maxRetries", 5.0),
        ("retryBaseDelayMs", 1_000.0),
        ("retryMaxDelayMs", 300_000.0),
        ("retryQueueLimit", 1_000.0),
        ("deadLetterLimit", 200.0),
    ] {
        let value = config
            .raw
            .get(key)
            .and_then(|value| value.as_f64())
            .unwrap_or(default);
        retry_config.set(key, JsValue::Number(value));
    }
    retry_config
}

fn state_limits(config: &RelayerConfig) -> JsObject {
    let mut limits = retry_config(config);
    limits.set(
        "processedCacheSize",
        JsValue::Number(
            config
                .raw
                .get("processedCacheSize")
                .and_then(serde_json::Value::as_f64)
                .unwrap_or(5_000.0),
        ),
    );
    limits
}

fn next_attempt_number(state: &JsObject, chain: &str, event: &JsValue) -> f64 {
    let key = build_event_key(event);
    state
        .get(chain)
        .and_then(JsValue::as_object)
        .and_then(|chain_state| chain_state.get("retry_queue"))
        .and_then(JsValue::as_array)
        .and_then(|queue| {
            queue.iter().find_map(|item| {
                let item = item.as_object()?;
                if item.get("key").and_then(JsValue::as_str) == Some(key.as_str()) {
                    item.get("attempts").and_then(|value| match value {
                        JsValue::Number(value) => Some(*value + 1.0),
                        _ => None,
                    })
                } else {
                    None
                }
            })
        })
        .unwrap_or(1.0)
}

#[cfg(test)]
mod tests {
    use neo_os_core::js_value::{JsObject, JsValue};
    use neo_os_core::state::{
        build_event_key, create_empty_relayer_state, has_processed_event,
        is_event_queued_for_retry, normalize_state_file_value,
    };
    use serde_json::json;

    use super::{process_event, trim_onchain_error_message};
    use crate::config::{js_value_to_json, RelayerConfig};

    fn config(raw: serde_json::Value) -> RelayerConfig {
        RelayerConfig {
            repo_root: ".".to_string(),
            instance_id: "test".to_string(),
            state_file: "unused.json".to_string(),
            network: "testnet".to_string(),
            node_env: "test".to_string(),
            mode: "combined".to_string(),
            active_chains: vec!["neo_n3".to_string()],
            poll_interval_ms: 1_000,
            concurrency: 1,
            max_blocks_per_tick: 10,
            discovery_idle_backoff_ms: 0,
            state_persist_min_interval_ms: 0,
            raw,
        }
    }

    fn event() -> JsValue {
        let mut event = JsObject::new();
        event.set("requestId", JsValue::Str("42".to_string()));
        event.set("requestType", JsValue::Str("fetch".to_string()));
        event.set("appId", JsValue::Str("weather".to_string()));
        event.set("moduleId", JsValue::Str("http".to_string()));
        event.set("operation", JsValue::Str("get".to_string()));
        event.set("txHash", JsValue::Str("0xabc".to_string()));
        event.set("logIndex", JsValue::Number(1.0));
        JsValue::Object(event)
    }

    #[test]
    fn unicode_error_truncation_is_boundary_safe_and_redacts_urls() {
        let message = "请求失败：https://例子.测试/机密?token=秘密 后续信息很长";
        let redacted = trim_onchain_error_message(message, 100);
        let truncated = trim_onchain_error_message(message, 18);

        assert!(redacted.contains("[redacted-url]"));
        assert!(!redacted.contains("token"));
        assert!(truncated.chars().count() <= 18);
        assert!(truncated.ends_with("..."));
    }

    #[test]
    fn missing_delivery_configuration_is_retried_and_never_marked_processed() {
        let config = config(json!({
            "maxRetries": 5,
            "retryBaseDelayMs": 1000,
            "retryMaxDelayMs": 300000,
            "retryQueueLimit": 100,
            "deadLetterLimit": 20
        }));
        let mut state = create_empty_relayer_state();
        let event = event();
        let key = build_event_key(&event);

        let result = process_event(&config, &mut state, "neo_n3", &event, 1_000.0);

        assert_eq!(result.status, "delivery_retry_scheduled");
        assert_eq!(result.reason.as_deref(), Some("onchain_delivery_failed"));
        assert!(!has_processed_event(&state, "neo_n3", &key));
        assert!(is_event_queued_for_retry(&state, "neo_n3", &key));
    }

    #[test]
    fn exhausted_delivery_failure_still_is_not_processed() {
        let config = config(json!({
            "maxRetries": 0,
            "retryBaseDelayMs": 1000,
            "retryMaxDelayMs": 300000,
            "retryQueueLimit": 100,
            "deadLetterLimit": 20
        }));
        let mut state = create_empty_relayer_state();
        let event = event();
        let key = build_event_key(&event);

        let result = process_event(&config, &mut state, "neo_n3", &event, 1_000.0);

        assert_eq!(result.status, "delivery_exhausted");
        assert!(!has_processed_event(&state, "neo_n3", &key));
        assert!(!is_event_queued_for_retry(&state, "neo_n3", &key));

        let chain_state = state
            .get("neo_n3")
            .and_then(JsValue::as_object)
            .expect("chain state");
        let dead_letters = chain_state
            .get("dead_letters")
            .and_then(JsValue::as_array)
            .expect("dead letters");
        assert_eq!(dead_letters.len(), 1);
        let letter = dead_letters[0].as_object().expect("dead letter");
        assert_eq!(letter.get("key"), Some(&JsValue::Str(key.clone())));
        assert_eq!(
            letter.get("request_id"),
            Some(&JsValue::Str("42".to_string()))
        );
        assert_eq!(letter.get("attempts"), Some(&JsValue::Number(1.0)));
        assert_eq!(
            letter.get("reason"),
            Some(&JsValue::Str("delivery_exhausted".to_string()))
        );

        let metrics = state
            .get("metrics")
            .and_then(JsValue::as_object)
            .expect("metrics");
        assert_eq!(
            metrics.get("retries_exhausted_total"),
            Some(&JsValue::Number(1.0))
        );
        assert_eq!(
            metrics.get("retries_scheduled_total"),
            Some(&JsValue::Number(0.0))
        );
        for name in [
            "events_processed_total",
            "events_failed_total",
            "fulfill_failure_total",
        ] {
            assert_eq!(
                metrics.get(name),
                Some(&JsValue::Number(1.0)),
                "{name} counts the single failed delivery attempt"
            );
        }

        let persisted = js_value_to_json(&JsValue::Object(state));
        state = normalize_state_file_value(&JsValue::from_json(&persisted));
        assert!(!has_processed_event(&state, "neo_n3", &key));

        let rediscovered = process_event(&config, &mut state, "neo_n3", &event, 2_000.0);
        assert_eq!(rediscovered.status, "skipped_dead_letter");
        assert!(!has_processed_event(&state, "neo_n3", &key));
        let chain_state = state
            .get("neo_n3")
            .and_then(JsValue::as_object)
            .expect("chain state");
        assert_eq!(
            chain_state
                .get("dead_letters")
                .and_then(JsValue::as_array)
                .expect("dead letters")
                .len(),
            1,
            "rediscovery must not duplicate the durable dead letter"
        );
        let metrics = state
            .get("metrics")
            .and_then(JsValue::as_object)
            .expect("metrics");
        assert_eq!(
            metrics.get("events_failed_total"),
            Some(&JsValue::Number(1.0)),
            "a dead-letter skip is not a second delivery failure"
        );
        assert_eq!(
            metrics.get("retries_exhausted_total"),
            Some(&JsValue::Number(1.0)),
            "exhaustion is counted exactly once"
        );
        assert_eq!(
            metrics.get("duplicates_skipped_total"),
            Some(&JsValue::Number(1.0)),
            "rediscovery is classified as a dead-letter duplicate"
        );
    }
}
