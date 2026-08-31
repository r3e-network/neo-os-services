//! `/attestation` — the public attestation surface, ported from
//! `enclave-server.mjs:1736-1830` with the runner seam replaced by the
//! in-process `AttestationSource` (the Node server shelled out to the
//! `nsm-attest` CLI; the host holds the NSM driver as a dependency).
//!
//! The binding contract is the part a verifier leans on, so it is exact:
//! the caller supplies a digest/tx-message/user-data hex alias (first truthy
//! one wins) and the response commits `user_data = sha256(<binding bytes>)` —
//! a single 32-byte commitment the relayer recomputes and checks against the
//! COSE_Sign1. A liveness probe with no binding emits no user_data at all.
//! The nonce, when supplied, must be even-length hex and rides the document's
//! report_data for freshness.

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use sha2::{Digest, Sha256};

use crate::http_error;
use crate::state::AppState;
use crate::RuntimeError;

/// `normalizeHex`: trim, strip a leading `0x` (either case), lowercase.
pub fn normalize_hex(value: &str) -> String {
    let trimmed = value.trim();
    let stripped = trimmed
        .strip_prefix("0x")
        .or_else(|| trimmed.strip_prefix("0X"))
        .unwrap_or(trimmed);
    stripped.to_ascii_lowercase()
}

/// `a || b || ...` over JSON: the first value JS calls truthy — non-empty
/// string, non-zero number, `true`, or any object/array. A truthy NON-string
/// shadows the rest of the alias chain exactly as it does in JS, then
/// collapses to empty under `trimString`'s string-only rule. That quirk is
/// preserved rather than "fixed": the alias chain is part of the contract
/// verifiers code against.
pub(crate) fn first_truthy<'a>(
    payload: &'a serde_json::Value,
    names: &[&str],
) -> Option<&'a serde_json::Value> {
    for name in names {
        let Some(value) = payload.get(name) else {
            continue;
        };
        let truthy = match value {
            serde_json::Value::Null => false,
            serde_json::Value::Bool(b) => *b,
            serde_json::Value::String(s) => !s.is_empty(),
            serde_json::Value::Number(n) => {
                n.as_f64().map(|f| f != 0.0 && !f.is_nan()).unwrap_or(true)
            }
            serde_json::Value::Array(_) | serde_json::Value::Object(_) => true,
        };
        if truthy {
            return Some(value);
        }
    }
    None
}

/// The alias's string form — empty when the truthy winner was not a string.
pub(crate) fn truthy_string(payload: &serde_json::Value, names: &[&str]) -> String {
    match first_truthy(payload, names) {
        Some(serde_json::Value::String(s)) => s.clone(),
        _ => String::new(),
    }
}

fn even_hex_or_error(value: &str, message: &str) -> Result<(), RuntimeError> {
    if value.is_empty() {
        return Ok(());
    }
    if !value
        .bytes()
        .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
        || !value.len().is_multiple_of(2)
    {
        return Err(http_error(400, message));
    }
    Ok(())
}

/// `resolveAttestationPublicKey`: the pinned role's public key, lowercased
/// hex, empty when the signer plane has no identity for it.
fn resolve_attestation_public_key(
    state: &AppState,
    payload: &serde_json::Value,
) -> (String, String) {
    let requested = truthy_string(payload, &["role", "key_role"]);
    let role = if requested.trim().eq_ignore_ascii_case("updater") {
        "updater"
    } else {
        "oracle_verifier"
    };
    let network = state.resolve_network();
    let public_key = normalize_hex(&state.signer.role_report(&network, role).public_key);
    (role.to_string(), public_key)
}

/// CBOR map lookup — `morpheus_core::cbor` keeps insertion-ordered entries
/// rather than a map type, so `payload.get(...)` has no direct equivalent.
fn cbor_map_get<'a>(
    value: &'a morpheus_core::cbor::CborValue,
    key: &str,
) -> Option<&'a morpheus_core::cbor::CborValue> {
    match value {
        morpheus_core::cbor::CborValue::Map(entries) => {
            entries.iter().find(|(k, _)| k == key).map(|(_, v)| v)
        }
        _ => None,
    }
}

/// PCRs of the attestation document, best-effort: an unparseable document
/// simply omits the field — the document itself stays authoritative.
pub fn extract_attestation_pcrs(document: &[u8]) -> serde_json::Map<String, serde_json::Value> {
    let mut out = serde_json::Map::new();
    let Ok(payload) = morpheus_core::cbor::decode_cose_sign1_payload(document) else {
        return out;
    };
    let Some(morpheus_core::cbor::CborValue::Map(entries)) = cbor_map_get(&payload, "pcrs") else {
        return out;
    };
    for (index, value) in entries {
        let hex = match value {
            morpheus_core::cbor::CborValue::Bytes(bytes) => hex::encode(bytes),
            morpheus_core::cbor::CborValue::Text(text) => {
                let hex = normalize_hex(text);
                if hex.is_empty() {
                    continue;
                }
                hex
            }
            _ => continue,
        };
        if !hex.is_empty() {
            out.insert(format!("pcr{index}"), serde_json::Value::String(hex));
        }
    }
    out
}

pub fn handle_attestation(
    state: &AppState,
    payload: &serde_json::Value,
) -> Result<serde_json::Value, RuntimeError> {
    let digest_source = normalize_hex(&truthy_string(
        payload,
        &[
            "fulfillment_digest_hex",
            "fulfillment_digest",
            "tx_message_hex",
            "tx_message",
            "user_data",
            "user_data_hex",
        ],
    ));
    let nonce_hex = normalize_hex(&truthy_string(
        payload,
        &["nonce", "report_data", "report_data_hex"],
    ));

    even_hex_or_error(&nonce_hex, "nonce must be even-length hex")?;
    even_hex_or_error(
        &digest_source,
        "binding (digest/tx_message/user_data) must be even-length hex",
    )?;

    let user_data_hex = if digest_source.is_empty() {
        String::new()
    } else {
        let binding = hex::decode(&digest_source).map_err(|_| {
            http_error(
                400,
                "binding (digest/tx_message/user_data) must be even-length hex",
            )
        })?;
        hex::encode(Sha256::digest(&binding))
    };

    let (role, public_key_hex) = resolve_attestation_public_key(state, payload);

    let nonce_bytes = if nonce_hex.is_empty() {
        None
    } else {
        Some(
            hex::decode(&nonce_hex)
                .map_err(|_| http_error(400, "nonce must be even-length hex"))?,
        )
    };
    let user_data_bytes = if user_data_hex.is_empty() {
        None
    } else {
        Some(hex::decode(&user_data_hex).expect("sha256 hex decodes"))
    };
    let public_key_bytes = if public_key_hex.is_empty() {
        None
    } else {
        Some(hex::decode(&public_key_hex).map_err(|_| http_error(400, "public key is not hex"))?)
    };

    let document = state
        .attest
        .attest(
            nonce_bytes.as_deref(),
            user_data_bytes.as_deref(),
            public_key_bytes.as_deref(),
        )
        .map_err(|message| {
            let detail: String = message.chars().take(300).collect();
            http_error(503, format!("nsm attestation helper failed: {detail}"))
        })?;

    let pcrs = extract_attestation_pcrs(&document);
    let attestation_document = if document.is_empty() {
        serde_json::Value::Null
    } else {
        serde_json::Value::String(BASE64.encode(&document))
    };
    // `parsed.document_len || null` — an empty document reads as null on both
    // sides (a zero-length COSE_Sign1 cannot authenticate anything anyway).
    let document_len = if document.is_empty() {
        serde_json::Value::Null
    } else {
        serde_json::Value::Number(serde_json::Number::from(document.len()))
    };
    let mut response = serde_json::json!({
        "status": "ok",
        "runtime": crate::RUNTIME_NAME,
        "network": state.resolve_network(),
        "role": role,
        "format": "cose-sign1-cbor-base64",
        "public_key": if public_key_hex.is_empty() { serde_json::Value::Null } else { serde_json::Value::String(public_key_hex) },
        "nonce": if nonce_hex.is_empty() { serde_json::Value::Null } else { serde_json::Value::String(nonce_hex) },
        "user_data_hex": if user_data_hex.is_empty() { serde_json::Value::Null } else { serde_json::Value::String(user_data_hex) },
        "document_len": document_len,
        "attestation_document": attestation_document,
    });
    if !pcrs.is_empty() {
        response["pcrs"] = serde_json::Value::Object(pcrs);
    }
    response["trust_tier"] = serde_json::Value::String("enclave-attested".to_string());
    Ok(response)
}

#[cfg(test)]
#[path = "../tests/unit/attestation.rs"]
mod tests;
