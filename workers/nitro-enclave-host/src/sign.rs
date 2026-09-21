//! The sign shims — `/sign/payload` and `/keys/derived`, the blind-sign and
//! identity surfaces the flag-OFF relayer path uses during cutover. In the
//! merged Node server they signed with the in-process pinned role key; in the
//! split, both translate the intent into a custody call over the signer plane
//! and pass the custody body through. The host still does the input shaping
//! and the refusals, because that is the part the outside world can probe.
//!
//! `/sign/payload` is a BLIND-SIGN lane: the caller chooses the digest and the
//! enclave signs it with a measured role key. That is the exact shape CL-14
//! rules out, and it contradicts the property the fulfilment lane beside it
//! claims ("the signer never sees a caller-supplied `data_hex` for this
//! route": `fulfill.rs`). It exists only for the flag-OFF relayer cutover,
//! which `deploy/nitro/enclave-server.mjs` already describes as retired once
//! `MORPHEUS_RELAYER_ENCLAVE_FULFILL` is on — and that flag is on in
//! `deploy/nitro/neo-os-relayer.env.example`. So the lane is now OFF unless
//! the measured image opts in with [`BLIND_SIGN_OPT_IN_ENV`]`=1`.
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

/// The image-owned opt-in for the blind-sign lane. Deliberately absent from
/// [`crate::overlay::PROVISIONABLE_NAMES`]: a security toggle the untrusted
/// parent could flip at `/provision` would be a downgrade switch outside
/// every measurement (CL-25).
pub const BLIND_SIGN_OPT_IN_ENV: &str = "ENCLAVE_ALLOW_BLIND_SIGN";

/// `ENCLAVE_ALLOW_BLIND_SIGN=1` — and only `1`. Anything else, including
/// `true`, `yes` and unset, leaves the lane closed: a lane this dangerous is
/// either demanded by an exact value or it is not there at all.
pub fn blind_sign_enabled(state: &AppState) -> bool {
    state
        .overlay
        .read()
        .expect("overlay lock")
        .get_trimmed(BLIND_SIGN_OPT_IN_ENV)
        .as_deref()
        == Some("1")
}

fn blind_sign_disabled_error() -> RuntimeError {
    http_error(
        503,
        "blind payload signing is retired; set ENCLAVE_ALLOW_BLIND_SIGN=1 in the measured \
         image to re-open it, or use the semantic fulfillment lane",
    )
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
    // The opt-in is checked here rather than at dispatch so that a host with
    // NO custody plane still answers the merged server's exact unconfigured
    // 503 — the byte-for-byte parity `deploy/nitro/enclave-host.test.mjs`
    // pins. What matters for the vulnerability is that this sits before
    // `sign_payload`: with custody connected and the lane not opted into, no
    // signature is ever produced.
    if !blind_sign_enabled(state) {
        return Err(blind_sign_disabled_error());
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
