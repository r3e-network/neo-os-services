//! The `/compute/execute` fold — the Rust shape of `handleComputeExecute`
//! (compute/index.js:814-846): confidential-payload resolution, builtin or
//! standalone compute, and the D5 signed-result envelope, all inside the
//! measured boundary. Compute runs IN-PROCESS through the golden-vector-pinned
//! `morpheus-compute` ports instead of the keyless Node child; signing goes
//! through the custody `SignerPlane` (worker role) and attestation through the
//! host's own `/attestation` binding — the exact objects the child fetched
//! over loopback from the 8787 server.
//!
//! Divergences from the Node child, all deliberate:
//!   - Encrypted-confidential REFS (remote claim over Supabase REST) fail
//!     closed with a 503: the fold has no egress. A direct ciphertext
//!     decrypts through the canonical `morpheus_compute::oracle::crypto`
//!     implementation.
//!   - Sealed-keystore (Secrets Manager) and ephemeral oracle key material
//!     fail closed with 503s; only configured-env material decrypts. The
//!     unavailable-material message is the JS one, verbatim, and a
//!     misconfigured source falls through to the next source exactly as the
//!     child logs and does.
//!   - `use_derived_keys` is ignored (the child derives per-role keys from
//!     Secrets Manager); signing always uses the custody worker key.
//!   - A failed custody signing call surfaces the plane's own status (503 for
//!     an unconfigured plane) where the child's untyped throw rendered 400.
//!   - A missing, disabled, wrong-network, unreachable, or incomplete signer
//!     key fails the signed lane with 503. A successful response never carries
//!     null signature identity.
//!   - The snarkjs CLI closure refuses: a `MORPHEUS_ZKP_VERIFY_RUNTIME=cli`
//!     lane errors 400 with the refusal message; the default "disabled"
//!     runtime gate never reaches the CLI, exactly like the child.
//!   - Caller-key rejection happens AFTER the compute succeeds, in the
//!     envelope build — the child's `buildSignedResultEnvelope` runs there
//!     too, so compute errors take precedence in both.

use std::collections::BTreeMap;

use morpheus_compute::compute::execute_builtin_compute;
use morpheus_compute::core::EnvReader;
use morpheus_compute::oracle::crypto::{
    parse_configured_oracle_key_material,
    resolve_confidential_payload as resolve_confidential_payload_canonical,
    resolve_encrypted_confidential_payload, resolve_encrypted_confidential_ref, OracleKeyMaterial,
    ORACLE_ENVELOPE_ALGORITHM, PLAINTEXT_ORACLE_KEY_PRODUCTION_ERROR,
};
use morpheus_compute::standalone::execute_standalone_compute;
use morpheus_core::js_value::JsValue;
use morpheus_core::stable_stringify::stable_stringify;

use crate::attestation::handle_attestation;
use crate::fulfill::{js_coerce, js_truthy, trim_string, truthy_trimmed};
use crate::http_error;
use crate::state::AppState;
use crate::RuntimeError;

pub fn handle_compute_execute(
    state: &AppState,
    body: &serde_json::Value,
) -> Result<serde_json::Value, RuntimeError> {
    // One env snapshot for the whole fold — the child read accumulated
    // process.env per request; the overlay snapshot is the same idea with
    // provisioned values shadowing the image base.
    let overlay = state.overlay.read().expect("overlay lock").merged_map();
    let env_trim = |name: &str| -> String {
        overlay
            .get(name)
            .map(|value| value.trim().to_string())
            .unwrap_or_default()
    };

    // resolveConfidentialPayload (crypto.js:643) — the direct-ciphertext
    // aliases decrypt in-process; the ref lane needs egress and fails closed.
    let payload = resolve_confidential_payload(body, &overlay, &env_trim)?;

    // `trimString(resolved.mode || (function || compute_fn ? 'builtin' :
    // 'script')) || 'script'` — mode is NOT lowercased: 'SCRIPT' runs
    // standalone.
    let mode = match payload.get("mode").filter(|value| js_truthy(value)) {
        Some(value) => trim_string(Some(value)),
        None => {
            let builtin = payload.get("function").map(js_truthy).unwrap_or(false)
                || payload.get("compute_fn").map(js_truthy).unwrap_or(false);
            if builtin {
                "builtin".to_string()
            } else {
                "script".to_string()
            }
        }
    };
    let mode = if mode.is_empty() {
        "script".to_string()
    } else {
        mode
    };

    // `resolved.target_chain ? normalizeTargetChain(...) : 'neo_n3'` — the
    // throw interpolates the RAW value, exactly like the JS template string.
    let target_chain = match payload.get("target_chain").filter(|value| js_truthy(value)) {
        Some(value) => {
            let normalized = trim_string(Some(value)).to_ascii_lowercase();
            if normalized != "neo_n3" && normalized != "neox" {
                return Err(http_error(
                    400,
                    format!("unsupported target_chain: {}", js_coerce(value)),
                ));
            }
            normalized
        }
        None => "neo_n3".to_string(),
    };
    let target_chain_id = match payload
        .get("target_chain_id")
        .filter(|value| js_truthy(value))
    {
        Some(value) => serde_json::Value::String(js_coerce(value)),
        None => serde_json::Value::Null,
    };

    let env_reader: EnvReader = &|name: &str| overlay.get(name).cloned();
    let result = if mode == "builtin" {
        let random_unit = os_random_unit;
        let verify_groth16_cli = |_: &serde_json::Value,
                                  _: &serde_json::Value,
                                  _: &serde_json::Value| {
            Err("snarkjs CLI verification is not available in the Rust enclave host".to_string())
        };
        execute_builtin_compute(&env_reader, &payload, &random_unit, &verify_groth16_cli)
    } else {
        execute_standalone_compute(&env_reader, &payload)
    };
    let result = result.map_err(|message| http_error(400, message))?;

    // buildSignedResultEnvelope (chain/signing.js:236) — always the
    // enclave-resident worker key (the custody plane), never caller material.
    reject_caller_supplied_signing_key(&payload)?;
    let payload_bytes = stable_stringify(&JsValue::from_json(&result)).into_bytes();
    let output_hash = morpheus_core::sha256_hex(&payload_bytes);
    let network = resolve_payload_network(state, &payload);
    let signed = sign_worker_bytes(state, &network, &payload_bytes)?;
    let tee_attestation = build_tee_attestation(state, &payload, "worker", &output_hash);

    // `{mode, target_chain, target_chain_id, ...result, ...buildLaneSignedEnvelope(signed)}`
    // — later spreads overwrite, and serde_json's preserve_order keeps a
    // overwritten key at its first-inserted position, same as an object
    // literal.
    let mut response = serde_json::Map::new();
    response.insert("mode".to_string(), serde_json::Value::String(mode));
    response.insert(
        "target_chain".to_string(),
        serde_json::Value::String(target_chain),
    );
    response.insert("target_chain_id".to_string(), target_chain_id);
    if let Some(object) = result.as_object() {
        for (key, value) in object {
            response.insert(key.clone(), value.clone());
        }
    }
    for (key, value) in build_lane_signed_envelope(&signed, &output_hash, &tee_attestation) {
        response.insert(key, value);
    }
    Ok(serde_json::Value::Object(response))
}

/// `resolveConfidentialPayload` (crypto.js:643) minus the remote ref claim:
/// direct ciphertext decrypts natively; an encrypted-ref request fails closed
/// before any network touch. Shared with the neodid fold, whose JS handler
/// composes the same resolution before its flows.
pub(crate) fn resolve_confidential_payload(
    payload: &serde_json::Value,
    overlay: &BTreeMap<String, String>,
    env_trim: &dyn Fn(&str) -> String,
) -> Result<serde_json::Value, RuntimeError> {
    let direct = resolve_encrypted_confidential_payload(payload);
    if direct.is_empty() {
        if !resolve_encrypted_confidential_ref(payload).is_empty() {
            return Err(http_error(
                503,
                "encrypted-confidential refs (remote claim) are not served by the Rust enclave host yet",
            ));
        }
        return Ok(payload.clone());
    }
    let key = oracle_key_material(overlay, env_trim)?;
    let env_lookup = |name: &str| overlay.get(name).cloned();
    let unavailable_transport = |_: &morpheus_compute::transport::HttpRequest| {
        Err("encrypted-confidential ref transport is unavailable".to_string())
    };
    resolve_confidential_payload_canonical(payload, &env_lookup, &unavailable_transport, &key)
        .map_err(|message| {
            let message = if message.starts_with("unsupported confidential payload format") {
                format!(
                    "unsupported confidential payload format; expected {ORACLE_ENVELOPE_ALGORITHM}"
                )
            } else {
                message
            };
            http_error(400, message)
        })
}

/// `ensureOracleKeyMaterial` (crypto.js:575) over the overlay: the
/// ephemeral-policy check, the configured-env sources, then fail-closed
/// refusals for the two sources the fold cannot serve.
fn oracle_key_material(
    overlay: &BTreeMap<String, String>,
    env_trim: &dyn Fn(&str) -> String,
) -> Result<OracleKeyMaterial, RuntimeError> {
    let ephemeral_requested = overlay_boolean(overlay, "MORPHEUS_ALLOW_EPHEMERAL_KEY");
    let production = env_trim("NODE_ENV").eq_ignore_ascii_case("production");
    if ephemeral_requested && production {
        return Err(http_error(
            400,
            "MORPHEUS_ALLOW_EPHEMERAL_KEY is not allowed when NODE_ENV=production",
        ));
    }

    let env_lookup = |name: &str| overlay.get(name).cloned();
    let configured = match parse_configured_oracle_key_material(&env_lookup) {
        Ok(configured) => configured,
        Err(message) if message == PLAINTEXT_ORACLE_KEY_PRODUCTION_ERROR => {
            return Err(http_error(503, message));
        }
        Err(_) => None,
    };
    if let Some(key) = configured {
        return Ok(key);
    }

    if !env_trim("MORPHEUS_ORACLE_SEALED_KEYSTORE_JSON").is_empty()
        || !env_trim("MORPHEUS_ORACLE_SEALED_KEYSTORE_BASE64").is_empty()
    {
        return Err(http_error(
            503,
            "sealed oracle keystore unsealing is not served by the Rust enclave host yet",
        ));
    }
    if ephemeral_requested {
        return Err(http_error(
            503,
            "ephemeral oracle key material is not served by the Rust enclave host",
        ));
    }
    Err(http_error(
        400,
        "oracle key material unavailable: no configured key, Secrets Manager sealed keystore, or ephemeral key not allowed",
    ))
}

/// `normalizeBoolean` over an env value: absent/blank falls back, otherwise
/// the trimmed lowercase form must be `1`/`true`/`yes` (NOT `on`).
fn overlay_boolean(overlay: &BTreeMap<String, String>, name: &str) -> bool {
    match overlay.get(name) {
        None => false,
        Some(value) if value.is_empty() => false,
        Some(value) => {
            let normalized = value.trim().to_ascii_lowercase();
            normalized == "1" || normalized == "true" || normalized == "yes"
        }
    }
}

/// `normalizeBoolean(value, fallback)` (platform/core.js:171) — the exact
/// empty-string special case before the String() coercion.
fn normalize_boolean(value: Option<&serde_json::Value>, fallback: bool) -> bool {
    match value {
        None | Some(serde_json::Value::Null) => fallback,
        Some(serde_json::Value::String(text)) if text.is_empty() => fallback,
        Some(value) => {
            let normalized = js_coerce(value).trim().to_ascii_lowercase();
            normalized == "1" || normalized == "true" || normalized == "yes"
        }
    }
}

/// `shouldEmitAttestation` (nitro-signer.js): `include_attestation ??
/// emit_attestation ?? NITRO_EMIT_ATTESTATION` — `??`, so an empty string is
/// NOT skipped (it reads as false), while null/absent fall through.
pub(crate) fn should_emit_attestation(state: &AppState, payload: &serde_json::Value) -> bool {
    let env_value = state
        .overlay
        .read()
        .expect("overlay lock")
        .get("NITRO_EMIT_ATTESTATION")
        .map(ToString::to_string);
    let requested = payload
        .get("include_attestation")
        .filter(|value| !value.is_null())
        .or_else(|| {
            payload
                .get("emit_attestation")
                .filter(|value| !value.is_null())
        })
        .cloned()
        .or_else(|| env_value.map(serde_json::Value::String));
    normalize_boolean(requested.as_ref(), false)
}

/// `hasCallerSuppliedKeyMaterial` (chain/signing.js:77).
pub(crate) fn has_caller_supplied_key_material(payload: &serde_json::Value) -> bool {
    ["private_key", "signing_key", "wif"]
        .iter()
        .any(|key| !trim_string(payload.get(key)).is_empty())
}

/// Key-confusion guard on every signing lane. The Rust custody boundary has no
/// compatibility escape hatch: caller material is always refused.
pub(crate) fn reject_caller_supplied_signing_key(
    payload: &serde_json::Value,
) -> Result<(), RuntimeError> {
    if !has_caller_supplied_key_material(payload) {
        return Ok(());
    }
    Err(http_error(
        400,
        "caller-supplied signing key material (private_key/signing_key/wif) is not accepted \
         on this signing lane; the enclave-resident key is used instead",
    ))
}

/// `resolvePayloadNetwork` (platform/core.js:90): the first truthy network
/// alias wins; the fallback is the host's own MORPHEUS_NETWORK resolution.
pub(crate) fn resolve_payload_network(state: &AppState, payload: &serde_json::Value) -> String {
    let fallback = state.resolve_network();
    let alias = truthy_trimmed(
        payload,
        &[
            "network",
            "morpheus_network",
            "runtime_network",
            "environment",
        ],
    );
    match alias.to_ascii_lowercase().as_str() {
        "mainnet" => "mainnet".to_string(),
        "testnet" => "testnet".to_string(),
        _ => fallback,
    }
}

/// Sign through a ready, identity-consistent worker custody role.
pub(crate) fn sign_worker_bytes(
    state: &AppState,
    network: &str,
    payload_bytes: &[u8],
) -> Result<serde_json::Value, RuntimeError> {
    sign_worker_hex(state, network, &hex::encode(payload_bytes))
}

pub(crate) fn sign_worker_hex(
    state: &AppState,
    network: &str,
    data_hex: &str,
) -> Result<serde_json::Value, RuntimeError> {
    let report = state.signer.role_report(network, "worker");
    if !(report.ok && report.materialized) || report.public_key.trim().is_empty() {
        return Err(http_error(
            503,
            "worker custody key is unavailable, disabled, or does not match the requested network",
        ));
    }
    let signed = state.signer.sign_payload(network, "worker", data_hex)?;
    let field = |name: &str| {
        signed
            .get(name)
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
    };
    let identity_field = |name: &str| {
        report
            .identity
            .get(name)
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
    };
    let complete = field("signature").is_some()
        && field("public_key") == Some(report.public_key.trim())
        && field("address").is_some()
        && field("script_hash").is_some()
        && identity_field("public_key") == Some(report.public_key.trim())
        && identity_field("address") == field("address")
        && identity_field("script_hash") == field("script_hash");
    if !complete {
        return Err(http_error(
            503,
            "worker custody response is incomplete or contradicts the pinned identity",
        ));
    }
    Ok(signed)
}

/// `maybeBuildDstackAttestation` (nitro-signer.js): caller-keyed lanes never
/// attest, the emit gate is `normalizeBoolean`, and every failure is
/// best-effort null. The child POSTed `{report_data: outputHash}` to the
/// 8787 /attestation endpoint — `handle_attestation` IS that endpoint in-process,
/// and `normalizeReportData` rode the 64-hex output hash as raw bytes.
pub(crate) fn build_tee_attestation(
    state: &AppState,
    payload: &serde_json::Value,
    key_source: &str,
    output_hash: &str,
) -> serde_json::Value {
    if key_source == "caller" {
        return serde_json::Value::Null;
    }
    if !should_emit_attestation(state, payload) {
        return serde_json::Value::Null;
    }
    let attestation =
        match handle_attestation(state, &serde_json::json!({ "report_data": output_hash })) {
            Ok(attestation) => attestation,
            Err(_) => return serde_json::Value::Null,
        };
    // `body.attestation_document || body.document || null` — falsy → null.
    let document = match attestation.get("attestation_document") {
        Some(serde_json::Value::String(document)) if !document.is_empty() => {
            serde_json::Value::String(document.clone())
        }
        _ => serde_json::Value::Null,
    };
    serde_json::json!({
        "runtime": "aws-nitro",
        "attestation_document": document,
        "report_data": format!("0x{output_hash}"),
    })
}

/// `signed?.field || null` — falsy signed fields read as null.
fn signed_field(signed: &serde_json::Value, key: &str) -> serde_json::Value {
    match signed.get(key) {
        Some(serde_json::Value::String(text)) if !text.is_empty() => {
            serde_json::Value::String(text.clone())
        }
        _ => serde_json::Value::Null,
    }
}

/// `buildSignedResultEnvelope` + `buildLaneSignedEnvelope` +
/// `buildVerificationEnvelope` (chain/signing.js:236-295) — the D5 canonical
/// signed-result fields, identical keys on every fulfillment lane. Shared
/// with the Phase 9 oracle folds.
pub(crate) fn build_lane_signed_envelope(
    signed: &serde_json::Value,
    output_hash: &str,
    tee_attestation: &serde_json::Value,
) -> serde_json::Map<String, serde_json::Value> {
    let signature = signed_field(signed, "signature");
    let public_key = signed_field(signed, "public_key");
    let signer_address = signed_field(signed, "address");
    let signer_script_hash = signed_field(signed, "script_hash");
    let mut envelope = serde_json::Map::new();
    envelope.insert(
        "output_hash".to_string(),
        serde_json::Value::String(output_hash.to_string()),
    );
    envelope.insert("signature".to_string(), signature.clone());
    envelope.insert("public_key".to_string(), public_key.clone());
    envelope.insert(
        "attestation_hash".to_string(),
        serde_json::Value::String(output_hash.to_string()),
    );
    envelope.insert("tee_attestation".to_string(), tee_attestation.clone());
    envelope.insert(
        "verification".to_string(),
        serde_json::json!({
            "output_hash": output_hash,
            "attestation_hash": output_hash,
            "signature": signature,
            "public_key": public_key,
            "signer_address": signer_address,
            "signer_script_hash": signer_script_hash,
            "tee_attestation": tee_attestation.clone(),
        }),
    );
    envelope
}

/// `cryptoRandomUnit()` — one unbiased 53-bit draw from the operating
/// system/Nitro CSPRNG. Deterministic randomness remains injected only in the
/// compute crate's unit tests.
fn os_random_unit() -> f64 {
    use rand::RngCore;
    (rand::rngs::OsRng.next_u64() >> 11) as f64 / (1u64 << 53) as f64
}

#[cfg(test)]
#[path = "../tests/unit/compute_execute.rs"]
mod tests;
