//! Request scanning: the Neo VM stack-item decoder, the two notification
//! shapes (kernel `MiniAppRequestQueued` and legacy `OracleRequested`), the
//! two request-record shapes (≥14-field kernel / ≥12-field legacy), and the
//! four scan entrypoints (per-block RPC, block-window RPC, n3index REST,
//! per-id getRequest). Ported from neo-n3.js lines 15–568.
//!
//! Identifier hygiene (load-bearing): `requestId` and `requestType` carry the
//! on-chain bytes VERBATIM — no trimming — so fulfillment digests reproduce
//! exactly what the kernel hashes. Only decode artifacts (non-strings) coerce
//! to `""` for the emptiness gates.

use serde_json::Value;

use crate::concurrency::{map_with_concurrency, resolve_scan_concurrency};
use crate::rpc::NeoRpcClient;
use crate::HttpTransport;

/// Identifier hygiene coercion: JS `asEventString` — non-strings become ''.
pub fn as_event_string(value: &Value) -> String {
    value.as_str().unwrap_or("").to_string()
}

/// Strict relayer `trimString` (type-preserving: non-strings → '').
pub fn trim_string(value: &Value) -> String {
    value.as_str().map(str::trim).unwrap_or("").to_string()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Encoding {
    /// Decode ByteStrings as hex (legacy sniffer only).
    Hex,
    /// Decode ByteStrings as base64 — Neo JSON-RPC and n3index both emit
    /// base64, so every in-repo caller passes this.
    Base64,
    /// Last-resort legacy sniffing: base64 payloads made entirely of hex
    /// characters ('abcd') would otherwise be mis-decoded as hex.
    Auto,
}

fn try_decode_utf8(bytes: &[u8]) -> Option<String> {
    String::from_utf8(bytes.to_vec()).ok()
}

fn is_printable_text(text: &str) -> bool {
    text.bytes()
        .all(|b| matches!(b, 0x09 | 0x0a | 0x0d | 0x20..=0x7e))
}

fn decode_byte_string_from_hex(raw: &str) -> String {
    let bytes = hex_bytes(raw);
    if let Some(text) = try_decode_utf8(&bytes) {
        if is_printable_text(&text) {
            return text;
        }
    }
    if raw.len() == 40 {
        let mut reversed = bytes;
        reversed.reverse();
        return format!("0x{}", hex(&reversed));
    }
    String::from_utf8_lossy(&bytes).to_string()
}

fn decode_byte_string_from_base64(raw: &str) -> String {
    let bytes = neo_os_core::base64::decode_lenient(raw);
    if let Some(text) = try_decode_utf8(&bytes) {
        if is_printable_text(&text) {
            return text;
        }
    }
    if bytes.len() == 20 {
        let mut reversed = bytes.clone();
        reversed.reverse();
        return format!("0x{}", hex(&reversed));
    }
    String::from_utf8_lossy(&bytes).to_string()
}

fn raw_byte_string_base64(item: Option<&Value>) -> Option<Vec<u8>> {
    let object = item?.as_object()?;
    let item_type = object.get("type")?.as_str()?.to_lowercase();
    if item_type != "bytestring" && item_type != "bytearray" {
        return None;
    }
    let raw = object.get("value")?.as_str()?.trim();
    Some(neo_os_core::base64::decode_lenient(raw))
}

fn attach_raw_payload(event: &mut NeoN3Event, item: Option<&Value>) {
    if let Some(bytes) = raw_byte_string_base64(item) {
        event.payload_hex = hex(&bytes);
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn hex_bytes(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap_or(0))
        .collect()
}

/// Decode a Neo VM stack/notification item into the plain JSON shape the
/// fulfillment pipeline consumes. `encoding` pins how ByteString values are
/// encoded by the source (both Neo JSON-RPC and n3index emit base64).
pub fn decode_neo_item(item: &Value, encoding: Encoding) -> Value {
    let Some(object) = item.as_object() else {
        return Value::Null;
    };
    let item_type = object
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_lowercase();
    let value = object.get("value").cloned().unwrap_or(Value::Null);
    match item_type.as_str() {
        "integer" => Value::String(match &value {
            Value::Null => "0".to_string(),
            other => js_value_to_string(other),
        }),
        "string" | "hash160" | "hash256" => Value::String(match &value {
            Value::Null => String::new(),
            other => js_value_to_string(other),
        }),
        "boolean" => Value::Bool(value.as_bool().unwrap_or(false)),
        "bytestring" | "bytearray" => {
            let raw = value.as_str().unwrap_or("").trim().to_string();
            if raw.is_empty() {
                return Value::String(String::new());
            }
            let looks_hex = raw.bytes().all(|b| b.is_ascii_hexdigit()) && raw.len() % 2 == 0;
            if encoding == Encoding::Hex || (encoding != Encoding::Base64 && looks_hex) {
                if looks_hex {
                    Value::String(decode_byte_string_from_hex(&raw))
                } else {
                    Value::String(raw)
                }
            } else {
                Value::String(decode_byte_string_from_base64(&raw))
            }
        }
        "array" | "struct" => Value::Array(
            value
                .as_array()
                .map(|entries| {
                    entries
                        .iter()
                        .map(|entry| decode_neo_item(entry, encoding))
                        .collect()
                })
                .unwrap_or_default(),
        ),
        _ => value,
    }
}

/// JS `String(value)` for the primitive shapes the stack carries.
fn js_value_to_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => {
            if let Some(integer) = number.as_i64() {
                integer.to_string()
            } else if let Some(integer) = number.as_u64() {
                integer.to_string()
            } else {
                number
                    .as_f64()
                    .map(neo_os_core::js_number::json_number_to_string)
                    .unwrap_or_default()
            }
        }
        _ => String::new(),
    }
}

/// The internal event shape the fulfillment pipeline consumes (the JS object
/// literal in buildNeoN3EventFromNotificationState / FromRequestRecord).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NeoN3Event {
    pub request_id: String,
    pub request_type: String,
    pub app_id: String,
    pub module_id: String,
    pub operation: String,
    pub requester: String,
    pub callback_contract: String,
    pub callback_method: String,
    pub payload_text: String,
    /// Lowercase hex of the exact on-chain payload bytes.
    pub payload_hex: String,
    pub created_at_ms: i64,
    pub fulfilled_at_ms: i64,
    pub block_number: i64,
    pub tx_hash: String,
    pub log_index: i64,
}

pub const LEGACY_CALLBACK_METHOD: &str = "onOracleResult";

/// Event names emitted by the oracle request entry points: the current kernel
/// contract emits `MiniAppRequestQueued`; legacy oracle contracts emit
/// `OracleRequested`. The relayer accepts both so one scan works against
/// either deployment.
pub fn is_request_event_name(event_name: &str) -> bool {
    event_name == "MiniAppRequestQueued" || event_name == "OracleRequested"
}

/// buildNeoN3EventFromNotificationState. Returns None when the event name is
/// unknown or the operation/requestType is empty.
pub fn build_event_from_notification_state(
    event_name: &str,
    decoded_state: &[Value],
    block_number: i64,
    tx_hash: &str,
    log_index: Option<i64>,
) -> Option<NeoN3Event> {
    let string_at = |index: usize| -> String {
        decoded_state
            .get(index)
            .map(as_event_string)
            .unwrap_or_default()
    };
    if event_name == "MiniAppRequestQueued" {
        // [requestId, appId, moduleId, operation, requester, sponsor, payload]
        let operation = string_at(3);
        if operation.is_empty() {
            return None;
        }
        return Some(NeoN3Event {
            request_id: if !decoded_state.is_empty() {
                string_at(0)
            } else {
                "0".to_string()
            },
            request_type: operation.clone(),
            app_id: string_at(1),
            module_id: string_at(2),
            operation,
            requester: string_at(4),
            callback_contract: String::new(),
            callback_method: LEGACY_CALLBACK_METHOD.to_string(),
            payload_text: string_at(6),
            payload_hex: hex(string_at(6).as_bytes()),
            created_at_ms: 0,
            fulfilled_at_ms: 0,
            block_number,
            tx_hash: tx_hash.to_string(),
            log_index: log_index.unwrap_or(0),
        });
    }
    if event_name == "OracleRequested" {
        // [requestId, requestType, requester, callbackContract, callbackMethod, payload]
        let request_type = string_at(1);
        if request_type.is_empty() {
            return None;
        }
        return Some(NeoN3Event {
            request_id: if !decoded_state.is_empty() {
                string_at(0)
            } else {
                "0".to_string()
            },
            request_type: request_type.clone(),
            requester: string_at(2),
            callback_contract: string_at(3),
            callback_method: string_at(4),
            payload_text: string_at(5),
            payload_hex: hex(string_at(5).as_bytes()),
            app_id: String::new(),
            module_id: String::new(),
            operation: String::new(),
            created_at_ms: 0,
            fulfilled_at_ms: 0,
            block_number,
            tx_hash: tx_hash.to_string(),
            log_index: log_index.unwrap_or(0),
        });
    }
    None
}

/// buildNeoN3EventFromRequestRecord: a `getRequest` record. Already-settled
/// records (fulfilledAt set, or an outcome present) return None — the relayer
/// only fulfills unsettled requests.
pub fn build_event_from_request_record(decoded: &[Value], request_id: &str) -> Option<NeoN3Event> {
    let as_string =
        |index: usize| -> String { decoded.get(index).map(as_event_string).unwrap_or_default() };
    let trim = |index: usize| -> String { decoded.get(index).map(trim_string).unwrap_or_default() };
    if decoded.len() >= 14 {
        let operation = as_string(3);
        if operation.is_empty() {
            return None;
        }
        // JS destructure: [0]=requestId, 1=appId, 2=moduleId, 3=operation,
        // 4=payloadText, 5=requester, [6 skipped], 7=callbackContract,
        // [8 skipped], 9=createdAtMs, 10=fulfilledAtMs, [11 skipped],
        // 12=resultText, 13=errorText.
        let already_settled = !trim(10).is_empty() && trim(10) != "0";
        let has_outcome = !trim(12).is_empty() || !trim(13).is_empty();
        if already_settled || has_outcome {
            return None;
        }
        let created_at_ms: i64 = trim(9).parse().unwrap_or(0);
        let fulfilled_at_ms: i64 = trim(10).parse().unwrap_or(0);
        return Some(NeoN3Event {
            request_id: {
                let first = as_string(0);
                if first.is_empty() {
                    request_id.to_string()
                } else {
                    first
                }
            },
            request_type: operation.clone(),
            app_id: as_string(1),
            module_id: as_string(2),
            operation,
            requester: as_string(5),
            callback_contract: as_string(7),
            callback_method: LEGACY_CALLBACK_METHOD.to_string(),
            payload_text: as_string(4),
            payload_hex: hex(as_string(4).as_bytes()),
            created_at_ms,
            fulfilled_at_ms,
            block_number: created_at_ms,
            tx_hash: String::new(),
            log_index: 0,
        });
    }
    if decoded.len() >= 12 {
        let request_type = as_string(1);
        if request_type.is_empty() {
            return None;
        }
        let already_settled = !trim(8).is_empty() && trim(8) != "0";
        let has_outcome = !trim(10).is_empty() || !trim(11).is_empty();
        if already_settled || has_outcome {
            return None;
        }
        let created_at_ms: i64 = trim(7).parse().unwrap_or(0);
        let fulfilled_at_ms: i64 = trim(8).parse().unwrap_or(0);
        return Some(NeoN3Event {
            request_id: {
                let first = as_string(0);
                if first.is_empty() {
                    request_id.to_string()
                } else {
                    first
                }
            },
            request_type: request_type.clone(),
            requester: as_string(5),
            callback_contract: as_string(3),
            callback_method: as_string(4),
            payload_text: as_string(2),
            payload_hex: hex(as_string(2).as_bytes()),
            app_id: String::new(),
            module_id: String::new(),
            operation: String::new(),
            created_at_ms,
            fulfilled_at_ms,
            block_number: created_at_ms,
            tx_hash: String::new(),
            log_index: 0,
        });
    }
    None
}

/// scanNeoN3OracleRequestBlock: one block's oracle-request notifications, in
/// in-block order (tx order → execution order → notification index). The
/// per-tx getapplicationlog reads run under a bounded concurrency of 4 with
/// order-preserving slots, so the slice matches the sequential scan exactly.
pub fn scan_oracle_request_block<T: HttpTransport>(
    client: &NeoRpcClient<T>,
    height: u32,
    target_contract: &str,
) -> Result<Vec<NeoN3Event>, String> {
    let block = client
        .get_block(height)
        .map_err(|error| error.to_string())?;
    let transactions = block
        .get("tx")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let tx_hashes: Vec<String> = transactions
        .iter()
        .filter_map(|transaction| {
            transaction
                .get("txid")
                .or_else(|| transaction.get("hash"))
                .and_then(Value::as_str)
                .filter(|hash| !hash.is_empty())
                .map(str::to_string)
        })
        .collect();

    let app_logs = map_with_concurrency(&tx_hashes, 4, |tx_hash| {
        client
            .get_application_log(tx_hash)
            .map_err(|error| error.to_string())
    })?;

    let mut events = Vec::new();
    for (tx_index, tx_hash) in tx_hashes.iter().enumerate() {
        let app_log = &app_logs[tx_index];
        let executions = app_log
            .get("executions")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        for execution in &executions {
            let notifications = execution
                .get("notifications")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            for (notification_index, notification) in notifications.iter().enumerate() {
                let notification_contract = notification
                    .get("contract")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if strip0x_lowercase(notification_contract) != strip0x_lowercase(target_contract) {
                    continue;
                }
                let event_name = notification
                    .get("eventname")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim()
                    .to_string();
                if !is_request_event_name(&event_name) {
                    continue;
                }
                let state: Vec<Value> = notification
                    .pointer("/state/value")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let decoded_state: Vec<Value> = state
                    .iter()
                    .map(|entry| decode_neo_item(entry, Encoding::Base64))
                    .collect();
                if let Some(mut event) = build_event_from_notification_state(
                    &event_name,
                    &decoded_state,
                    height as i64,
                    tx_hash,
                    Some(notification_index as i64),
                ) {
                    let payload_index = if event_name == "MiniAppRequestQueued" {
                        6
                    } else {
                        5
                    };
                    attach_raw_payload(&mut event, state.get(payload_index));
                    events.push(event);
                }
            }
        }
    }
    Ok(events)
}

/// scanNeoN3OracleRequests: a block window under bounded concurrency,
/// results in ascending height with in-block ordering preserved; any FAULT or
/// transport error fails the whole scan (the block cursor never advances past
/// an unscanned height). `target_contract` is the oracle contract hash
/// stripped and lower-cased by the orchestrator (config wiring lands in T04).
pub fn scan_oracle_requests<T: HttpTransport>(
    client: &NeoRpcClient<T>,
    target_contract: &str,
    from_block: u32,
    to_block: u32,
    concurrency: Option<usize>,
) -> Result<Vec<NeoN3Event>, String> {
    if from_block > to_block {
        return Ok(Vec::new());
    }
    let heights: Vec<u32> = (from_block..=to_block).collect();
    let per_block =
        map_with_concurrency(&heights, resolve_scan_concurrency(concurrency), |height| {
            scan_oracle_request_block(client, *height, target_contract)
        })?;
    Ok(per_block.into_iter().flatten().collect())
}

/// scanNeoN3OracleRequestsViaN3Index: REST cursor scan with the same
/// event-name set, window filter, and (block_index, notification_index)
/// ordering as the RPC path.
pub fn scan_oracle_requests_via_n3index<T: HttpTransport>(
    transport: &T,
    indexer_url: &str,
    network: &str,
    oracle_contract: &str,
    from_block: u32,
    to_block: u32,
    max_results: usize,
) -> Result<Vec<NeoN3Event>, String> {
    if from_block > to_block {
        return Ok(Vec::new());
    }
    let base = indexer_url.trim_end_matches('/');
    let event_names = "MiniAppRequestQueued,OracleRequested";
    let url = format!(
        "{base}/contract_notifications?network=eq.{network}&contract_hash=eq.{oracle_contract}&event_name=in.({event_names})&order=block_index.desc&limit={}",
        max_results.max(500)
    );
    let (status, body) = transport.get(&url).map_err(|error| error.to_string())?;
    if status != 200 {
        return Err(format!(
            "n3index oracle request scan failed: {status} {body}"
        ));
    }
    let rows: Vec<Value> = serde_json::from_str(&body).unwrap_or_default();

    let mut events: Vec<Option<NeoN3Event>> = rows
        .iter()
        .filter(|row| {
            let block_index = row.get("block_index").and_then(Value::as_u64).unwrap_or(0);
            block_index >= from_block as u64 && block_index <= to_block as u64
        })
        .map(|row| {
            let state = row
                .pointer("/state_json/value")
                .or_else(|| row.pointer("/raw_json/state/value"))
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let decoded_state: Vec<Value> = state
                .iter()
                .map(|entry| decode_neo_item(entry, Encoding::Base64))
                .collect();
            let event_name = row
                .get("event_name")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            let mut event = build_event_from_notification_state(
                event_name,
                &decoded_state,
                row.get("block_index").and_then(Value::as_i64).unwrap_or(0),
                row.get("txid").and_then(Value::as_str).unwrap_or(""),
                row.get("notification_index").and_then(Value::as_i64),
            );
            if let Some(event) = event.as_mut() {
                let payload_index = if event_name == "MiniAppRequestQueued" {
                    6
                } else {
                    5
                };
                attach_raw_payload(event, state.get(payload_index));
            }
            event
        })
        .collect();

    // (block_index, notification_index) ascending.
    events.sort_by(|left, right| match (&left, &right) {
        (Some(left), Some(right)) => left
            .block_number
            .cmp(&right.block_number)
            .then(left.log_index.cmp(&right.log_index)),
        _ => std::cmp::Ordering::Equal,
    });
    Ok(events.into_iter().flatten().collect())
}

/// scanNeoN3OracleRequestsById: per-id `getRequest` lookups under bounded
/// concurrency, results in ascending id.
pub fn scan_oracle_requests_by_id<T: HttpTransport>(
    client: &NeoRpcClient<T>,
    oracle_contract: &str,
    from_request_id: u64,
    to_request_id: u64,
    concurrency: Option<usize>,
) -> Result<Vec<NeoN3Event>, String> {
    if from_request_id > to_request_id {
        return Ok(Vec::new());
    }
    let ids: Vec<u64> = (from_request_id..=to_request_id).collect();
    let events = map_with_concurrency(&ids, resolve_scan_concurrency(concurrency), |request_id| {
        let result = client
            .invoke_function(
                oracle_contract,
                "getRequest",
                serde_json::json!([{ "type": "Integer", "value": request_id.to_string() }]),
            )
            .map_err(|error| error.to_string())?;
        if result
            .get("state")
            .and_then(Value::as_str)
            .map(|state| state.to_uppercase() == "FAULT")
            .unwrap_or(false)
        {
            let exception = result
                .get("exception")
                .and_then(Value::as_str)
                .unwrap_or("");
            return Err(if exception.is_empty() {
                format!("Neo N3 getRequest faulted for request {request_id}")
            } else {
                exception.to_string()
            });
        }
        let stack = result
            .get("stack")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let first = stack.first().cloned().unwrap_or(Value::Null);
        let decoded = decode_neo_item(&first, Encoding::Base64);
        let decoded_array = decoded.as_array().cloned().unwrap_or_default();
        let mut event = build_event_from_request_record(&decoded_array, &request_id.to_string());
        if let Some(event) = event.as_mut() {
            let raw_fields = first.get("value").and_then(Value::as_array);
            let payload_index = if decoded_array.len() >= 14 { 4 } else { 2 };
            attach_raw_payload(
                event,
                raw_fields.and_then(|fields| fields.get(payload_index)),
            );
        }
        Ok(event)
    })?;
    Ok(events.into_iter().flatten().collect())
}

/// getNeoN3LatestRequestId: the kernel's TotalRequests counter.
pub fn get_latest_request_id<T: HttpTransport>(
    client: &NeoRpcClient<T>,
    oracle_contract: &str,
) -> Result<u64, String> {
    let result = client
        .invoke_function(oracle_contract, "getTotalRequests", serde_json::json!([]))
        .map_err(|error| error.to_string())?;
    if result
        .get("state")
        .and_then(Value::as_str)
        .map(|state| state.to_uppercase() == "FAULT")
        .unwrap_or(false)
    {
        let exception = result
            .get("exception")
            .and_then(Value::as_str)
            .unwrap_or("");
        return Err(if exception.is_empty() {
            "Neo N3 getTotalRequests faulted".to_string()
        } else {
            exception.to_string()
        });
    }
    let stack = result
        .get("stack")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let first = stack
        .first()
        .cloned()
        .ok_or_else(|| "Neo N3 getTotalRequests returned an empty stack".to_string())?;
    let decoded = decode_neo_item(&first, Encoding::Base64);
    let text = decoded
        .as_str()
        .ok_or_else(|| "Neo N3 getTotalRequests returned a non-string value".to_string())?;
    text.parse::<u64>()
        .map_err(|_| "Neo N3 getTotalRequests returned an invalid numeric value".to_string())
}

/// getNeoN3LatestBlock: `getblockcount - 1`.
pub fn get_latest_block<T: HttpTransport>(client: &NeoRpcClient<T>) -> Result<u32, String> {
    client
        .get_block_count()
        .map(|count| count.saturating_sub(1))
        .map_err(|error| error.to_string())
}

fn strip0x_lowercase(value: &str) -> String {
    let trimmed = value.trim();
    trimmed
        .strip_prefix("0x")
        .or_else(|| trimmed.strip_prefix("0X"))
        .unwrap_or(trimmed)
        .to_lowercase()
}

/// encodeUtf8ByteArrayParamValue: UTF-8 → base64, for request payloads.
pub fn encode_utf8_byte_array_param_value(value: &str) -> String {
    use neo_os_core::base64::encode_standard;
    let raw = value.trim();
    if raw.is_empty() {
        return String::new();
    }
    encode_standard(raw.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_base64_bytestrings_and_nested_arrays() {
        // Non-printable, non-20-byte base64 bytes decode through the lossy
        // UTF-8 tail — byte-identical to JS Buffer.toString('utf8').
        let item = serde_json::json!({
            "type": "ByteArray",
            "value": "AAECAwQFBgcICQ=="
        });
        let expected = String::from_utf8_lossy(&[0, 1, 2, 3, 4, 5, 6, 7, 8, 9]).to_string();
        assert_eq!(
            decode_neo_item(&item, Encoding::Base64),
            serde_json::json!(expected)
        );

        // A 20-byte value becomes the reversed 0x-hash form.
        let item = serde_json::json!({
            "type": "ByteArray",
            "value": "51f6b2601c8ca3effb5fbb4988281523f96fdbae"
        });
        assert_eq!(
            decode_neo_item(&item, Encoding::Hex),
            serde_json::json!("0xaedb6ff92315288849bb5ffbefa38c1c60b2f651")
        );
    }

    #[test]
    fn decodes_kernel_notification_state_into_the_event_shape() {
        let state = serde_json::json!([
            { "type": "Integer", "value": "42" },
            { "type": "String", "value": "demo.app" },
            { "type": "String", "value": "oracle.fetch" },
            { "type": "String", "value": "fetch" },
            { "type": "String", "value": "NbrXdur6FV9bx33ME1jxjoKyQMBLZCWtDL" },
            { "type": "String", "value": "NVVqfbA31We3H39aQvNAPoCvUwoNooXdL4" },
            { "type": "ByteArray", "value": "e30=" }
        ]);
        let decoded: Vec<Value> = state
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| decode_neo_item(entry, Encoding::Base64))
            .collect();
        let event = build_event_from_notification_state(
            "MiniAppRequestQueued",
            &decoded,
            100,
            "0xhash",
            Some(2),
        )
        .expect("kernel event");
        assert_eq!(event.request_id, "42");
        assert_eq!(event.request_type, "fetch");
        assert_eq!(event.app_id, "demo.app");
        assert_eq!(event.callback_method, "onOracleResult");
        assert_eq!(event.payload_text, "{}");
        assert_eq!(event.block_number, 100);
        assert_eq!(event.tx_hash, "0xhash");
        assert_eq!(event.log_index, 2);
    }

    #[test]
    fn rejects_unknown_event_names_and_empty_operations() {
        let state = serde_json::json!([1, 2, 3]);
        assert!(build_event_from_notification_state(
            "Unknown",
            state.as_array().unwrap(),
            1,
            "",
            None
        )
        .is_none());
        assert!(build_event_from_notification_state(
            "MiniAppRequestQueued",
            serde_json::json!([]).as_array().unwrap(),
            1,
            "",
            None
        )
        .is_none());
    }

    #[test]
    fn request_record_filters_already_settled_rows() {
        // ≥14-field kernel record with fulfilledAtMs set → filtered out.
        let record = serde_json::json!([
            "42",
            "demo.app",
            "oracle.fetch",
            "fetch",
            "{}",
            "NbrX",
            "0x0",
            "0xcallback",
            "onOracleResult",
            "1770000000000",
            "1770000000001",
            "0x0",
            "result",
            ""
        ]);
        assert!(build_event_from_request_record(record.as_array().unwrap(), "42").is_none());

        // Unsettled record passes through.
        let record = serde_json::json!([
            "42",
            "demo.app",
            "oracle.fetch",
            "fetch",
            "{}",
            "NbrX",
            "0x0",
            "0xcallback",
            "onOracleResult",
            "1770000000000",
            "0",
            "0x0",
            "",
            ""
        ]);
        let event =
            build_event_from_request_record(record.as_array().unwrap(), "42").expect("unsettled");
        assert_eq!(event.request_id, "42");
        assert_eq!(event.operation, "fetch");
    }

    #[test]
    fn identifier_hygiene_keeps_whitespace_verbatim() {
        // A requestType with leading whitespace must NOT be trimmed — the
        // kernel hashes the on-chain bytes verbatim.
        let state = serde_json::json!([
            { "type": "Integer", "value": 7 },
            { "type": "String", "value": "demo.app" },
            { "type": "String", "value": "oracle.fetch" },
            { "type": "String", "value": " fetch" },
            { "type": "String", "value": "requester" },
            { "type": "String", "value": "sponsor" },
            { "type": "String", "value": "{}" }
        ]);
        let decoded: Vec<Value> = state
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| decode_neo_item(entry, Encoding::Base64))
            .collect();
        let event = build_event_from_notification_state(
            "MiniAppRequestQueued",
            &decoded,
            1,
            "0xtx",
            Some(0),
        )
        .expect("event");
        assert_eq!(event.request_type, " fetch");
        assert_eq!(event.operation, " fetch");
    }

    #[test]
    fn utf8_param_encoder_matches_the_js() {
        assert_eq!(encode_utf8_byte_array_param_value("{}"), "e30=");
        assert_eq!(encode_utf8_byte_array_param_value(""), "");
    }

    /// The configured oracle contract is a 20-byte script hash, and every
    /// documented configuration writes it with an `0x` prefix, while the RPC
    /// notification's `contract` field is normalized to bare lowercase hex
    /// before it is compared. A scan must match on the 20 bytes, never on the
    /// spelling of the configured value.
    #[test]
    fn a_request_notification_is_found_whatever_the_hash_prefix() {
        const HASH: &str = "5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a";

        struct Reply;
        impl crate::HttpTransport for Reply {
            fn post(&self, _url: &str, body: &str) -> Result<(u16, String), String> {
                let request: Value = serde_json::from_str(body).map_err(|e| e.to_string())?;
                let result = match request["method"].as_str().unwrap_or_default() {
                    "getblock" => {
                        serde_json::json!({ "tx": [{ "txid": format!("0x{}", "ab".repeat(32)) }] })
                    }
                    "getapplicationlog" => serde_json::json!({
                        "executions": [{
                            "notifications": [{
                                "contract": format!("0x{HASH}"),
                                "eventname": "MiniAppRequestQueued",
                                "state": { "value": [
                                    {"type":"Integer","value":"7"},
                                    {"type":"String","value":"cu88.private"},
                                    {"type":"String","value":"compute.run"},
                                    {"type":"String","value":"compute_hash"},
                                    {"type":"String","value":"NbrXdur6FV9bx33ME1jxjoKyQMBLZCWtDL"},
                                    {"type":"String","value":"NVVqfbA31We3H39aQvNAPoCvUwoNooXdL4"},
                                    {"type":"ByteArray","value":"e30="}
                                ]}
                            }]
                        }]
                    }),
                    other => return Err(format!("unexpected method {other}")),
                };
                Ok((
                    200,
                    serde_json::json!({"jsonrpc":"2.0","id":1,"result":result}).to_string(),
                ))
            }
            fn get(&self, _url: &str) -> Result<(u16, String), String> {
                unreachable!("the block scan never performs a GET")
            }
            fn post_local(&self, url: &str, body: &str) -> Result<(u16, String), String> {
                self.post(url, body)
            }
        }

        let client = NeoRpcClient::new_local(
            Reply,
            vec!["http://127.0.0.1:23456".to_string()],
            "test",
            894710606,
        )
        .unwrap();
        for target in [
            format!("0x{HASH}"),
            HASH.to_string(),
            format!("0x{}", HASH.to_uppercase()),
        ] {
            let events = scan_oracle_request_block(&client, 1, &target)
                .unwrap_or_else(|error| panic!("scan refused target {target}: {error}"));
            assert_eq!(
                events.len(),
                1,
                "target spelling {target} must match the kernel"
            );
            assert_eq!(events[0].request_id, "7");
            assert_eq!(events[0].app_id, "cu88.private");
        }
        let other =
            scan_oracle_request_block(&client, 1, &format!("0x{}", "11".repeat(20))).unwrap();
        assert!(other.is_empty(), "a different contract must not match");
    }
}
