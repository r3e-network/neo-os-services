//! getRequest record → internal event shape, and the per-id scan entrypoint.
//! Ported from neox.js `buildNeoXEventFromRequest` / `scanNeoXOracleRequestsById`.

use serde_json::Value;

use crate::fulfill::{
    decode_confidential_envelope, decode_confidential_message_id, decode_payload,
    is_confidential_decrypt_operation,
};

/// The internal event shape the fulfillment pipeline consumes (the JS object
/// literal in buildNeoXEventFromRequest). `message_id` is only populated for
/// the confidential decrypt lane, where the in-TEE worker requires the
/// on-chain binding.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NeoXEvent {
    pub request_id: String,
    pub request_type: String,
    pub app_id: String,
    pub module_id: String,
    pub operation: String,
    pub payload_text: String,
    /// Lowercase hex of the original request payload before any decrypt decoding.
    pub payload_hex: String,
    pub message_id: String,
    pub requester: String,
    pub callback_contract: String,
    pub callback_method: String,
    pub block_number: i64,
    pub created_at_ms: i64,
    pub tx_hash: String,
    pub log_index: i64,
}

pub const LEGACY_CALLBACK_METHOD: &str = "onOracleResult";
/// Status enum on the kernel: None=0, Pending=1, Succeeded=2, Failed=3.
pub const STATUS_PENDING: u64 = 1;

/// buildNeoXEventFromRequest: the decoded getRequest tuple → the internal
/// event shape. Only still-pending requests surface (the engine +
/// reconciliation dedupe the rest); a zeroed struct (missing id) decodes to an
/// empty operation and is skipped. Identifier hygiene: `requestId` and the
/// identifier/error strings carry the on-chain bytes VERBATIM (no trim).
pub fn build_event_from_request(record: &Value) -> Option<NeoXEvent> {
    let text_field = |name: &str| -> String {
        record
            .get(name)
            .map(|value| match value {
                Value::String(text) => text.clone(),
                other => other.to_string(),
            })
            .unwrap_or_default()
    };
    let request_id = text_field("id");
    let operation = record
        .get("operation")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if operation.is_empty() {
        return None;
    }
    let status = record
        .get("status")
        .map(|value| match value {
            Value::String(text) => text.parse::<u64>().unwrap_or(0),
            Value::Number(number) => number.as_u64().unwrap_or(0),
            _ => 0,
        })
        .unwrap_or(0);
    if status != STATUS_PENDING {
        return None;
    }
    let callback_contract = text_field("callbackContract");
    let requester = record
        .get("requester")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let payload_hex = record
        .get("payload")
        .map(|value| match value {
            Value::String(hex) => hex.clone(),
            other => other.to_string(),
        })
        .unwrap_or_default();
    let decrypt_lane = is_confidential_decrypt_operation(&operation);
    Some(NeoXEvent {
        request_id,
        request_type: operation.clone(),
        app_id: text_field("appId"),
        module_id: text_field("moduleId"),
        operation,
        payload_text: if decrypt_lane {
            decode_confidential_envelope(&payload_hex)
        } else {
            decode_payload(&payload_hex)
        },
        payload_hex: payload_hex
            .trim()
            .strip_prefix("0x")
            .unwrap_or(payload_hex.trim())
            .to_ascii_lowercase(),
        message_id: if decrypt_lane {
            decode_confidential_message_id(&payload_hex)
        } else {
            String::new()
        },
        requester,
        callback_contract: zero_address_to_empty(&callback_contract),
        callback_method: LEGACY_CALLBACK_METHOD.to_string(),
        block_number: created_at_of(record),
        created_at_ms: created_at_of(record).saturating_mul(1000),
        tx_hash: String::new(),
        log_index: 0,
    })
}

fn created_at_of(record: &Value) -> i64 {
    record
        .get("createdAt")
        .map(|value| match value {
            Value::String(text) => text.parse::<i64>().unwrap_or(0),
            Value::Number(number) => number.as_i64().unwrap_or(0),
            _ => 0,
        })
        .unwrap_or(0)
}

fn zero_address_to_empty(value: &str) -> String {
    let trimmed = value.trim();
    let raw = trimmed.strip_prefix("0x").unwrap_or(trimmed);
    if raw.len() == 40 && raw.bytes().all(|b| b == b'0') {
        String::new()
    } else {
        trimmed.to_string()
    }
}
