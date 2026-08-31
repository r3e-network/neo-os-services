//! The sign shims — `/sign/payload` and `/keys/derived`, the blind-sign and
//! identity surfaces the flag-OFF relayer path uses during cutover. In the
//! merged Node server they signed with the in-process pinned role key; in the
//! split, both translate the intent into a custody call over the signer plane
//! and pass the custody body through. The host still does the input shaping
//! and the refusals, because that is the part the outside world can probe.
//!
//! One deliberate divergence from `normalizeSignerRole`
//! (enclave-server.mjs:405): the Node helper SILENTLY DEFAULTS an unknown
//! role to `updater`. A caller that misspells `oracle_verifier` gets the
//! updater's signature and no error — the worst kind of wrong-key failure.
//! The shim refuses instead: an unknown role is a 400 naming the legal set.

use crate::attestation::{normalize_hex, truthy_string};
use crate::http_error;
use crate::state::AppState;
use crate::RuntimeError;

/// The roles a sign intent may name — the exact set `normalizeSignerRole`
/// mapped, without its silent fallback.
pub fn normalize_signer_role_strict(requested: &str) -> Option<&'static str> {
    match requested.trim().to_ascii_lowercase().as_str() {
        "oracle_verifier" | "verifier" => Some("oracle_verifier"),
        "updater" => Some("updater"),
        "relayer" => Some("relayer"),
        "worker" => Some("worker"),
        _ => None,
    }
}

fn unconfigured_error(role: &str) -> RuntimeError {
    http_error(
        503,
        format!("{role} signer is not configured or does not match pinned identity"),
    )
}

/// POST /sign/payload — sign caller-supplied `data_hex` with the role's key.
/// The custody service signs and owns the response body (signature, public
/// key, address, script hash, key source); the shim has enforced the shape.
pub fn handle_sign_payload(
    state: &AppState,
    payload: &serde_json::Value,
) -> Result<serde_json::Value, RuntimeError> {
    let requested = truthy_string(payload, &["key_role", "dstack_key_role", "role"]);
    let Some(role) = normalize_signer_role_strict(&requested) else {
        return Err(http_error(
            400,
            "key_role must be one of oracle_verifier, updater, relayer, worker",
        ));
    };
    let data_hex = normalize_hex(&truthy_string(payload, &["data_hex", "message_hex"]));
    // `/^[0-9a-f]+$/` — non-empty (unlike /attestation's liveness aliases).
    if data_hex.is_empty()
        || !data_hex
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
        || !data_hex.len().is_multiple_of(2)
    {
        return Err(http_error(400, "data_hex is required"));
    }
    let network = state.resolve_network();
    let report = state.signer.role_report(&network, role);
    if !report.ok || !report.materialized {
        return Err(unconfigured_error(role));
    }
    state.signer.sign_payload(&network, role, &data_hex)
}

/// POST /keys/derived — report a pinned role's public Neo identity, no secret.
pub fn handle_keys_derived(
    state: &AppState,
    payload: &serde_json::Value,
) -> Result<serde_json::Value, RuntimeError> {
    let requested = truthy_string(payload, &["role", "key_role", "dstack_key_role"]);
    let Some(role) = normalize_signer_role_strict(&requested) else {
        return Err(http_error(
            400,
            "role must be one of oracle_verifier, updater, relayer, worker",
        ));
    };
    let network = state.resolve_network();
    let report = state.signer.role_report(&network, role);
    if !report.ok || !report.materialized {
        return Err(unconfigured_error(role));
    }
    let identity = &report.identity;
    let address = identity
        .get("address")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let script_hash = identity
        .get("script_hash")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let public_key = match identity.get("public_key") {
        Some(value) if !value.is_null() => value.clone(),
        _ => {
            if report.public_key.is_empty() {
                serde_json::Value::Null
            } else {
                serde_json::Value::String(report.public_key.clone())
            }
        }
    };
    let neo = serde_json::json!({
        "address": address,
        "script_hash": script_hash,
        "public_key": public_key,
    });
    Ok(serde_json::json!({
        "status": "ok",
        "network": network,
        "role": role,
        "derived": { "neo_n3": neo },
        "neo_n3": neo,
        "key_source": report.key_source,
    }))
}

#[cfg(test)]
#[path = "../tests/unit/sign.rs"]
mod tests;
