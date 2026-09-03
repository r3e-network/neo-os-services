//! On-chain result envelope builders (port of the envelope half of
//! workers/morpheus-relayer/src/router.js).
//!
//! CONSENSUS-CRITICAL DIGEST NEUTRALITY: the envelope returned by
//! `build_onchain_result_envelope` is JSON.stringified into the fulfillment
//! `result` field by `encode_fulfillment_result`, and that string is hashed
//! verbatim by `digest::build_fulfillment_digest_bytes`. Adding ANY field
//! changes the on-chain digest — `trust_tier` is therefore default-OFF and
//! only non-digest consumers pass it.

use crate::base64;
use crate::js_json;
use crate::js_value::{JsObject, JsValue};
use crate::kernel::{normalize_request_type, resolve_kernel_intent};
use crate::{CoreError, CoreResult};

pub const MAX_ONCHAIN_RESULT_VALUE_BYTES: usize = 384;
pub const MAX_ONCHAIN_ERROR_LENGTH: usize = 240;
const ENVELOPE_JSON_BYTE_BUDGET: usize = 900;

pub const TRUST_TIER_ENCLAVE_ATTESTED: &str = "enclave-attested";
pub const TRUST_TIER_HOST_UNATTESTED: &str = "host-unattested";

/// `resolveCompactCallbackBytes`: when the worker supplies compact callback
/// bytes (VRF randomness, NeoDID tickets, the generic game RESULT codec) those
/// bytes flow to the kernel callback verbatim and the fulfillment digest binds
/// SHA256(result) instead of the JSON envelope.
pub fn resolve_compact_callback_bytes(
    request_type: &str,
    worker_response: &JsValue,
) -> CoreResult<Option<Vec<u8>>> {
    let normalized = normalize_request_type(request_type);
    let worker_body = worker_response
        .as_object()
        .and_then(|response| response.get("body"))
        .and_then(JsValue::as_object);

    if let Some(body) = worker_body {
        if normalized == "rng" || normalized.contains("vrf") || normalized.contains("random") {
            let randomness = body
                .get("randomness")
                .map(|v| v.as_str().unwrap_or(""))
                .unwrap_or("");
            let stripped = strip0x_str(randomness);
            if stripped.len() == 64 && stripped.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Ok(Some(crate::neo_encoding::decode_hex_lossy(stripped)));
            }
        }
    }

    let callback_encoding = worker_body
        .and_then(|body| body.get("callback_encoding"))
        .map(|v| v.as_str().unwrap_or(""))
        .map(normalize_request_type)
        .unwrap_or_default();
    let Some(worker_body) = worker_body else {
        return Ok(None);
    };
    if callback_encoding.is_empty() {
        return Ok(None);
    }

    // Generic game session finalize: the worker builds the fixed 79-byte
    // RESULT CODEC and returns it base64 with callback_encoding
    // 'game_result_v1'. The bytes flow verbatim to the kernel callback; the
    // fulfillment digest binds SHA256(result) so any tamper breaks the
    // RUNTIME_VERIFIER signature. Game-agnostic: the same encoding serves
    // every registered engine.
    if callback_encoding == "game_result_v1" {
        let raw = worker_body
            .get("result_bytes_base64")
            .map(|v| v.as_str().unwrap_or(""))
            .map(crate::js_value::js_trim)
            .unwrap_or("");
        if !raw.is_empty() {
            let bytes = base64::decode_lenient(raw);
            if bytes.len() == 79 && bytes[0] == 0x02 {
                return Ok(Some(bytes));
            }
        }
        return Ok(None);
    }

    if normalized == "neodid_recovery_ticket" && callback_encoding == "neo_n3_recovery_v1" {
        return Ok(Some(encode_neo_n3_recovery_ticket_v1(worker_body)?));
    }
    if normalized == "neodid_recovery_ticket" && callback_encoding == "neo_n3_recovery_v3" {
        return Ok(Some(encode_neo_n3_recovery_ticket_v3(worker_body)));
    }
    if normalized == "neodid_action_ticket" && callback_encoding == "neo_n3_action_v1" {
        return Ok(Some(encode_neo_n3_action_ticket_v1(worker_body)?));
    }
    if normalized == "neodid_action_ticket" && callback_encoding == "neo_n3_action_v3" {
        return Ok(Some(encode_neo_n3_action_ticket_v3(worker_body)));
    }
    Ok(None)
}

/// JS strict `trimString`: non-string inputs collapse to ''. Applied at every
/// boundary where the value may not be a string.
fn strict_str(value: Option<&JsValue>) -> &str {
    value.and_then(JsValue::as_str).unwrap_or("")
}

fn strip0x_str(value: &str) -> &str {
    let trimmed = crate::js_value::js_trim(value);
    trimmed
        .strip_prefix("0x")
        .or_else(|| trimmed.strip_prefix("0X"))
        .unwrap_or(trimmed)
}

fn encode_length_prefixed_utf8(value: &str) -> CoreResult<Vec<u8>> {
    let bytes = crate::js_value::js_trim(value).as_bytes().to_vec();
    if bytes.len() > 255 {
        return Err(CoreError::new("compact callback segment exceeds 255 bytes"));
    }
    let mut out = vec![bytes.len() as u8];
    out.extend_from_slice(&bytes);
    Ok(out)
}

fn encode_hash160(value: &str, field: &str) -> CoreResult<Vec<u8>> {
    let raw = strip0x_str(value);
    if raw.len() == 40 && raw.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Ok(crate::neo_encoding::decode_hex_lossy(raw));
    }
    Err(CoreError::new(format!("invalid hash160 for {field}")))
}

fn encode_hash32(value: &str, field: &str) -> CoreResult<Vec<u8>> {
    let raw = strip0x_str(value);
    if raw.len() == 64 && raw.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Ok(crate::neo_encoding::decode_hex_lossy(raw));
    }
    Err(CoreError::new(format!("invalid 32-byte hash for {field}")))
}

fn encode_signature(value: &str, field: &str) -> CoreResult<Vec<u8>> {
    let raw = strip0x_str(value);
    if raw.len() == 128 && raw.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Ok(crate::neo_encoding::decode_hex_lossy(raw));
    }
    Err(CoreError::new(format!(
        "invalid 64-byte signature for {field}"
    )))
}

fn encode_neo_n3_recovery_ticket_v1(body: &JsObject) -> CoreResult<Vec<u8>> {
    let field = |k: &str| strict_str(body.get(k));
    let mut out = vec![0x01];
    out.extend_from_slice(&encode_hash160(field("new_owner"), "new_owner")?);
    out.extend_from_slice(&encode_length_prefixed_utf8(field("recovery_nonce"))?);
    out.extend_from_slice(&encode_length_prefixed_utf8(field("expires_at"))?);
    out.extend_from_slice(&encode_length_prefixed_utf8(field("action_id"))?);
    out.extend_from_slice(&encode_hash32(
        field("master_nullifier"),
        "master_nullifier",
    )?);
    out.extend_from_slice(&encode_hash32(
        field("action_nullifier"),
        "action_nullifier",
    )?);
    out.extend_from_slice(&encode_signature(field("signature"), "signature")?);
    Ok(out)
}

fn encode_neo_n3_action_ticket_v1(body: &JsObject) -> CoreResult<Vec<u8>> {
    let field = |k: &str| strict_str(body.get(k));
    let mut out = vec![0x01];
    out.extend_from_slice(&encode_hash160(
        field("disposable_account"),
        "disposable_account",
    )?);
    out.extend_from_slice(&encode_length_prefixed_utf8(field("action_id"))?);
    out.extend_from_slice(&encode_hash32(
        field("action_nullifier"),
        "action_nullifier",
    )?);
    out.extend_from_slice(&encode_signature(field("signature"), "signature")?);
    Ok(out)
}

fn encode_neo_n3_recovery_ticket_v3(body: &JsObject) -> Vec<u8> {
    let field = |k: &str| strict_str(body.get(k));
    let master = encode_hash32(field("master_nullifier"), "master_nullifier").unwrap_or_default();
    let action = encode_hash32(field("action_nullifier"), "action_nullifier").unwrap_or_default();
    let signature = encode_signature(field("signature"), "signature").unwrap_or_default();
    format!(
        "3|{}|{}|{}",
        base64::encode_standard(&master),
        base64::encode_standard(&action),
        base64::encode_standard(&signature)
    )
    .into_bytes()
}

fn encode_neo_n3_action_ticket_v3(body: &JsObject) -> Vec<u8> {
    let field = |k: &str| strict_str(body.get(k));
    let action = encode_hash32(field("action_nullifier"), "action_nullifier").unwrap_or_default();
    let signature = encode_signature(field("signature"), "signature").unwrap_or_default();
    format!(
        "3|{}|{}",
        base64::encode_standard(&action),
        base64::encode_standard(&signature)
    )
    .into_bytes()
}

fn compact_tee_attestation(attestation: Option<&JsValue>) -> JsValue {
    let Some(attestation) = attestation.and_then(JsValue::as_object) else {
        return JsValue::Null;
    };
    let get_or_null = |key: &str| -> JsValue {
        attestation
            .get(key)
            .filter(|v| v.truthy())
            .cloned()
            .unwrap_or(JsValue::Null)
    };
    // sha256Hex routes through ensureBuffer: strings hash as utf8, objects/
    // arrays hash as stableStringify bytes (the canonical digest form).
    let hash_field = |key: &str| -> JsValue {
        match attestation.get(key).filter(|v| v.truthy()) {
            Some(JsValue::Str(s)) => JsValue::Str(crate::sha256_hex(s.as_bytes())),
            Some(other @ (JsValue::Object(_) | JsValue::Array(_))) => JsValue::Str(
                crate::sha256_hex(crate::stable_stringify::stable_stringify(other).as_bytes()),
            ),
            Some(other) => JsValue::Str(crate::sha256_hex(
                other.to_string_js().unwrap_or_default().as_bytes(),
            )),
            None => JsValue::Null,
        }
    };
    let quote_hash = hash_field("quote");
    let event_log_hash = hash_field("event_log");
    let mut out = JsObject::new();
    out.set("app_id", get_or_null("app_id"));
    out.set("instance_id", get_or_null("instance_id"));
    out.set("compose_hash", get_or_null("compose_hash"));
    out.set("report_data", get_or_null("report_data"));
    out.set("quote_hash", quote_hash);
    out.set("event_log_hash", event_log_hash);
    JsValue::Object(out)
}

fn build_verification_envelope(worker_body: &JsValue) -> Option<JsObject> {
    let body = worker_body.as_object()?;
    let existing = body
        .get("verification")
        .and_then(JsValue::as_object)
        .unwrap_or(body);

    let has_any = [
        "output_hash",
        "attestation_hash",
        "signature",
        "public_key",
        "tee_attestation",
    ]
    .iter()
    .any(|key| existing.get(key).is_some_and(JsValue::truthy));
    if !has_any {
        return None;
    }

    let get_or_null = |key: &str| -> JsValue {
        existing
            .get(key)
            .filter(|v| v.truthy())
            .cloned()
            .unwrap_or(JsValue::Null)
    };
    let mut out = JsObject::new();
    out.set("output_hash", get_or_null("output_hash"));
    out.set("attestation_hash", get_or_null("attestation_hash"));
    out.set("signature", get_or_null("signature"));
    out.set("public_key", get_or_null("public_key"));
    // JS reads signer_address/signer_script_hash WITHOUT a truthiness filter
    // (plain `|| null`) — falsy values still become null.
    out.set(
        "signer_address",
        existing
            .get("signer_address")
            .filter(|v| v.truthy())
            .cloned()
            .unwrap_or(JsValue::Null),
    );
    out.set(
        "signer_script_hash",
        existing
            .get("signer_script_hash")
            .filter(|v| v.truthy())
            .cloned()
            .unwrap_or(JsValue::Null),
    );
    out.set(
        "tee_attestation",
        compact_tee_attestation(existing.get("tee_attestation").filter(|v| v.truthy())),
    );
    Some(out)
}

/// JS `Array.isArray(result) ? 'array' : typeof result` for the result_type label.
fn result_type(value: &JsValue) -> String {
    if matches!(value, JsValue::Array(_)) {
        "array".to_string()
    } else {
        value.type_of().to_string()
    }
}

fn build_business_result(request_type: &str, worker_body: &JsValue) -> JsValue {
    // JS: `if (!workerBody || typeof workerBody !== 'object') return workerBody;`
    // — an ARRAY body IS typeof 'object' and flows through the compact path,
    // where every field lookup misses and the result is `null`.
    let Some(body) = worker_body.as_object() else {
        if matches!(worker_body, JsValue::Array(_)) {
            return JsValue::Null;
        }
        return worker_body.clone();
    };

    let normalized = normalize_request_type(request_type);
    let mut compact = JsObject::new();
    const PREFERRED_FIELDS: [&str; 40] = [
        "mode",
        "action",
        "function",
        "entry_point",
        "target_chain",
        "target_chain_id",
        "request_source",
        "provider",
        "claim_type",
        "claim_value",
        "master_nullifier",
        "provider_pair",
        "feed_id",
        "pair",
        "symbol",
        "action_id",
        "action_nullifier",
        "aa_contract",
        "verifier_contract",
        "account_id",
        "account_address",
        "new_owner",
        "recovery_nonce",
        "expires_at",
        "digest",
        "price",
        "decimals",
        "timestamp",
        "automation_id",
        "trigger_type",
        "next_run_at",
        "status",
        "chain",
        "requester",
        "callback_contract",
        "execution_request_type",
        "upstream_status",
        "randomness",
        "job_id",
        "extracted_value",
    ];
    for field in PREFERRED_FIELDS {
        if let Some(value) = body
            .get(field)
            .filter(|v| !v.is_undefined() && **v != JsValue::Null)
        {
            compact.set(field, value.clone());
        }
    }

    if let Some(JsValue::Array(sources)) = body.get("sources") {
        if !sources.is_empty() {
            compact.set(
                "sources",
                JsValue::Array(sources.iter().take(4).cloned().collect()),
            );
        }
    }

    let compact_value = |value: Option<&JsValue>, max_bytes: usize| -> Option<JsValue> {
        let value = value?;
        if value.is_undefined() {
            return None;
        }
        if js_json::measure_bytes(value) <= max_bytes {
            Some(value.clone())
        } else {
            None
        }
    };

    match compact_value(body.get("result"), MAX_ONCHAIN_RESULT_VALUE_BYTES) {
        Some(preferred) => compact.set("result", preferred),
        None => match compact_value(body.get("extracted_value"), 192) {
            Some(extracted) => {
                compact.set("result", extracted);
                compact.set("result_source", JsValue::Str("extracted_value".to_string()));
            }
            None => {
                if let Some(result) = body.get("result").filter(|v| !v.is_undefined()) {
                    compact.set("result_omitted", JsValue::Bool(true));
                    let output_hash = body.get("output_hash").filter(|v| v.truthy());
                    compact.set("result_hash", output_hash.cloned().unwrap_or(JsValue::Null));
                    compact.set("result_type", JsValue::Str(result_type(result)));
                }
            }
        },
    }

    let result_absent = !compact.contains_key("result");
    if normalized.contains("feed") && result_absent && compact.get("price").is_some() {
        compact.set(
            "result",
            compact.get("price").cloned().unwrap_or(JsValue::Null),
        );
        compact.set("result_source", JsValue::Str("price".to_string()));
    }

    if compact.is_empty() {
        JsValue::Null
    } else {
        JsValue::Object(compact)
    }
}

fn compact_envelope(request_type: &str, worker_response: &JsValue) -> JsObject {
    let intent = resolve_kernel_intent(request_type);
    let response = worker_response.as_object();
    let raw_body = response.and_then(|r| r.get("body"));
    // JS: `workerResponse?.body && typeof workerResponse.body === 'object'` —
    // an ARRAY body passes the typeof check, so it flows through as-is.
    let worker_body = match raw_body {
        Some(body) if body.as_object().is_some() || matches!(body, JsValue::Array(_)) => {
            body.clone()
        }
        other => {
            let mut fallback = JsObject::new();
            fallback.set(
                "raw",
                other
                    .filter(|v| !v.is_undefined())
                    .cloned()
                    .unwrap_or(JsValue::Null),
            );
            JsValue::Object(fallback)
        }
    };

    let success = response
        .and_then(|r| r.get("ok"))
        .map(JsValue::truthy)
        .unwrap_or(false);

    let mut envelope = JsObject::new();
    envelope.set("version", JsValue::Str("morpheus-result/v1".to_string()));
    envelope.set(
        "request_type",
        JsValue::Str(intent.legacy_request_type.clone()),
    );
    envelope.set("module_id", JsValue::Str(intent.module_id.to_string()));
    envelope.set("operation", JsValue::Str(intent.operation));
    envelope.set("success", JsValue::Bool(success));
    envelope.set(
        "result",
        build_business_result(&intent.legacy_request_type, &worker_body),
    );
    envelope.set(
        "verification",
        build_verification_envelope(&worker_body)
            .map(JsValue::Object)
            .unwrap_or(JsValue::Null),
    );
    envelope
}

fn trim_error_message(value: &str) -> String {
    let text = crate::js_value::js_trim(value);
    if text.is_empty() {
        return "worker request failed".to_string();
    }
    // JS String.length counts UTF-16 code units.
    let units: Vec<u16> = text.encode_utf16().collect();
    if units.len() > MAX_ONCHAIN_ERROR_LENGTH {
        let mut sliced = units[..MAX_ONCHAIN_ERROR_LENGTH - 3].to_vec();
        sliced.extend_from_slice(&[0x2e, 0x2e, 0x2e]);
        String::from_utf16_lossy(&sliced)
    } else {
        text.to_string()
    }
}

/// Build the compacted on-chain result envelope, trimming fields until the
/// JSON form fits the 900-byte on-chain budget (port of
/// `buildOnchainResultEnvelope`). Pass `trust_tier` ONLY for non-digest
/// consumers.
pub fn build_onchain_result_envelope(
    request_type: &str,
    worker_response: &JsValue,
    trust_tier: Option<&str>,
) -> JsObject {
    let mut envelope = compact_envelope(request_type, worker_response);
    if let Some(tier) = trust_tier {
        envelope.set("trust_tier", JsValue::Str(tier.to_string()));
    }
    let envelope_value = JsValue::Object(envelope.clone());

    // Attempt 2: drop the bulky result metadata keys.
    let attempt2 = match envelope.get("result") {
        Some(JsValue::Object(result_obj)) => {
            let mut trimmed = envelope.clone();
            let mut filtered = JsObject::new();
            for (key, value) in result_obj.iter() {
                if !matches!(key, "request_source" | "target_chain_id" | "sources") {
                    filtered.set(key.to_string(), value.clone());
                }
            }
            trimmed.set("result", JsValue::Object(filtered));
            JsValue::Object(trimmed)
        }
        _ => envelope_value.clone(),
    };

    // Attempt 3: compact the verification block (drops event_log_hash and the
    // signer_* fields, keeps quote_hash).
    let attempt3 = match envelope.get("verification") {
        Some(verification) if verification.truthy() => {
            let mut trimmed = envelope.clone();
            let compacted = compact_verification_for_budget(verification);
            trimmed.set("verification", compacted);
            JsValue::Object(trimmed)
        }
        _ => envelope_value.clone(),
    };

    let attempts = [envelope_value, attempt2, attempt3];
    let mut selected = attempts[attempts.len() - 1].clone();
    for candidate in &attempts {
        if js_json::measure_bytes(candidate) <= ENVELOPE_JSON_BYTE_BUDGET {
            selected = candidate.clone();
            break;
        }
    }
    match selected {
        JsValue::Object(obj) => obj,
        _ => envelope,
    }
}

fn compact_verification_for_budget(verification: &JsValue) -> JsValue {
    let get_or_null = |source: &JsObject, key: &str| -> JsValue {
        source
            .get(key)
            .filter(|v| v.truthy())
            .cloned()
            .unwrap_or(JsValue::Null)
    };
    let Some(verification_obj) = verification.as_object() else {
        return JsValue::Null;
    };
    let mut out = JsObject::new();
    out.set("output_hash", get_or_null(verification_obj, "output_hash"));
    out.set(
        "attestation_hash",
        get_or_null(verification_obj, "attestation_hash"),
    );
    out.set("signature", get_or_null(verification_obj, "signature"));
    out.set("public_key", get_or_null(verification_obj, "public_key"));
    out.set(
        "tee_attestation",
        match verification_obj
            .get("tee_attestation")
            .filter(|v| v.truthy())
            .and_then(JsValue::as_object)
        {
            Some(tee) => {
                let mut tee_out = JsObject::new();
                tee_out.set("app_id", get_or_null(tee, "app_id"));
                tee_out.set("compose_hash", get_or_null(tee, "compose_hash"));
                tee_out.set("report_data", get_or_null(tee, "report_data"));
                tee_out.set("quote_hash", get_or_null(tee, "quote_hash"));
                JsValue::Object(tee_out)
            }
            None => JsValue::Null,
        },
    );
    JsValue::Object(out)
}

#[derive(Debug, Clone, PartialEq)]
pub struct EncodedFulfillmentResult {
    pub success: bool,
    pub result: String,
    pub result_bytes_base64: Option<String>,
    pub error: String,
}

/// Encode the fulfillment result the relayer submits on-chain (port of
/// `encodeFulfillmentResult`).
pub fn encode_fulfillment_result(
    request_type: &str,
    worker_response: &JsValue,
) -> CoreResult<EncodedFulfillmentResult> {
    let normalized = normalize_request_type(request_type);
    let response = worker_response.as_object();
    let ok = response
        .and_then(|r| r.get("ok"))
        .map(JsValue::truthy)
        .unwrap_or(false);
    if !ok {
        let body = response.and_then(|r| r.get("body"));
        let error_message = match body
            .and_then(|b| b.as_object())
            .and_then(|b| b.get("error"))
        {
            Some(JsValue::Str(text)) => text.clone(),
            _ => {
                let status = response
                    .and_then(|r| r.get("status"))
                    .map(|v| v.to_string_js().unwrap_or_else(|_| "undefined".to_string()))
                    .unwrap_or_else(|| "undefined".to_string());
                format!("worker request failed with status {status}")
            }
        };
        return Ok(EncodedFulfillmentResult {
            success: false,
            result: String::new(),
            result_bytes_base64: None,
            error: trim_error_message(&error_message),
        });
    }

    let response_value = JsValue::Object(response.cloned().unwrap_or_else(JsObject::new));
    let compact_bytes = resolve_compact_callback_bytes(&normalized, &response_value)?;
    if let Some(bytes) = compact_bytes {
        return Ok(EncodedFulfillmentResult {
            success: true,
            result: String::new(),
            result_bytes_base64: Some(base64::encode_standard(&bytes)),
            error: String::new(),
        });
    }

    let payload = build_onchain_result_envelope(&normalized, &response_value, None);
    let json = js_json::stringify(&JsValue::Object(payload))
        .map_err(CoreError::new)?
        .unwrap_or_default();
    Ok(EncodedFulfillmentResult {
        success: true,
        result: json,
        result_bytes_base64: None,
        error: String::new(),
    })
}
