//! The `/compute/execute` fold — the Rust shape of `handleComputeExecute`
//! (compute/index.js:814-846): confidential-payload resolution, builtin or
//! standalone compute, and the D5 signed-result envelope, all inside the
//! measured boundary. Compute runs IN-PROCESS through the golden-vector-pinned
//! `neo-os-compute` ports instead of the keyless Node child; signing goes
//! through the custody `SignerPlane` (worker role) and attestation through the
//! host's own `/attestation` binding — the exact objects the child fetched
//! over loopback from the 8787 server.
//!
//! Divergences from the Node child, all deliberate:
//!   - Encrypted-confidential REFS (remote claim over Supabase REST) fail
//!     closed with a 503: the fold has no egress. A direct ciphertext
//!     decrypts through the canonical `neo_os_compute::oracle::crypto`
//!     implementation.
//!   - Oracle key material comes from a configured source — which is where
//!     `/provision` puts the key KMS released — or, outside production only and
//!     only with `MORPHEUS_ALLOW_EPHEMERAL_KEY`, from the process-lifetime
//!     ephemeral key shared with `/oracle/public-key`
//!     ([`AppState::ephemeral_oracle_key`]). The sealed-keystore source is NOT
//!     served: its only route to a wrap key is `derive_oracle_wrap_key`, and
//!     this host passes a deriver that refuses the legacy Secrets Manager
//!     master derivation unconditionally (CL-10/CL-12), so that branch could
//!     never produce material here and no longer advertises itself with a
//!     refusal of its own. The unavailable-material message names the sources
//!     that remain, and a misconfigured source falls through to the next source
//!     exactly as the child logs and does.
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

use neo_os_compute::compute::execute_builtin_compute;
use neo_os_compute::core::EnvReader;
use neo_os_compute::oracle::crypto::{
    parse_configured_oracle_key_material,
    resolve_confidential_payload as resolve_confidential_payload_canonical,
    resolve_encrypted_confidential_payload, resolve_encrypted_confidential_ref, OracleKeyMaterial,
    ORACLE_ENVELOPE_ALGORITHM, PLAINTEXT_ORACLE_KEY_PRODUCTION_ERROR,
};
use neo_os_compute::standalone::execute_standalone_compute;
use neo_os_core::js_value::JsValue;
use neo_os_core::stable_stringify::stable_stringify;

use crate::attestation::handle_attestation;
use crate::fulfill::{js_coerce, js_truthy, trim_string};
use crate::http_error;
use crate::state::AppState;
use crate::RuntimeError;

pub fn handle_compute_execute(
    state: &AppState,
    body: &serde_json::Value,
) -> Result<serde_json::Value, RuntimeError> {
    resolve_payload_network(state, body)?;
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
    let payload = resolve_confidential_payload(state, body, &overlay, &env_trim)?;
    let network = resolve_payload_network(state, &payload)?;

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
    let output_hash = neo_os_core::sha256_hex(&payload_bytes);
    let signed = sign_worker_bytes(state, &network, &payload_bytes)?;
    let tee_attestation = build_tee_attestation(state, &payload, "worker", &output_hash)?;

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
    state: &AppState,
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
    let key = oracle_key_material(state, overlay, env_trim)?;
    let env_lookup = |name: &str| overlay.get(name).cloned();
    let unavailable_transport = |_: &neo_os_compute::transport::HttpRequest| {
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
/// ephemeral-policy check, then the configured source, then — only outside
/// production and only when explicitly allowed — the process-lifetime
/// ephemeral key.
///
/// The sealed-keystore source that `crypto.js` also tries is deliberately absent, and
/// this is not an omission. Its only route to a wrap key is
/// `derive_oracle_wrap_key`, and this host passes a deriver that refuses the legacy
/// Secrets Manager master derivation unconditionally (CL-10/CL-12); the stable loader
/// derives that wrap key before it ever looks at the sealed env, so on this host the
/// branch could not succeed whatever the env said. Advertising it as a distinct refusal
/// implied a capability that does not exist here. The supported key sources are a
/// configured source (which is where `/provision` puts the key it released from KMS) and
/// the development-only ephemeral key.
///
/// The ephemeral key is NOT minted here. It comes from
/// [`AppState::ephemeral_oracle_key`], the one key `/oracle/public-key` also serves
/// and the other oracle lanes also decrypt with, so what this fold resolves is
/// exactly what a caller encrypted to. Minting per resolution here was the defect
/// CU-148's review found: the endpoint advertised key A and this fold decrypted
/// with key B. The exposure that sharing buys is stated on that method.
///
/// `pub(crate)` rather than private: the key `/provision` materializes is the key
/// this resolver must then serve, and that end-to-end claim is asserted from the
/// provisioning suite, which owns the KMS fixtures.
pub(crate) fn oracle_key_material(
    state: &AppState,
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
        // A source that fails to parse is skipped, not fatal: the fold logs and
        // continues to the next one, exactly as the child did.
        Err(_) => None,
    };
    if let Some(key) = configured {
        return Ok(key);
    }

    if ephemeral_requested {
        // The generator is `neo_os_compute`'s, not a second implementation here: the
        // enclave host owns no crypto of its own. The lifetime, though, is this
        // host's decision, and it is the process: `docs/ENVIRONMENT.md` documents
        // exactly that ("a process-lifetime ephemeral oracle key ... decryptability
        // ends with the process"), and a key that changed per resolution could not
        // be advertised and used. Production refuses the flag above, before this
        // line, so the branch stays development-only.
        return Ok(state.ephemeral_oracle_key());
    }
    Err(http_error(
        400,
        "oracle key material unavailable: no configured key or provisioned KMS ciphertext, and no ephemeral key allowed",
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

/// `resolvePayloadNetwork` (platform/core.js) for the signing lanes: the
/// fallback is the host's own reviewed MORPHEUS_NETWORK, and the payload is
/// read by the same strict parser the compute lanes use
/// ([`neo_os_compute::core::resolve_payload_network_strict`]). Only a missing,
/// `null` or empty-string alias falls back. Any other explicit value that is
/// not a reviewed network, `false` and `0` included, is a 400. Every alias
/// must agree with this AppState, even when a higher-priority alias is present.
/// Internal and decrypted calls cannot select another context.
pub(crate) fn resolve_payload_network(
    state: &AppState,
    payload: &serde_json::Value,
) -> Result<String, RuntimeError> {
    let fallback = state.resolve_network()?;
    for alias in [
        "network",
        "morpheus_network",
        "runtime_network",
        "environment",
    ] {
        if let Some(value) = payload.get(alias) {
            let selected = neo_os_compute::core::resolve_payload_network_strict(
                &serde_json::json!({alias: value}),
                &fallback,
            )
            .map_err(|message| http_error(400, message))?;
            if selected != fallback {
                return Err(http_error(
                    400,
                    format!(
                        "payload network {selected} does not match the host network {fallback}"
                    ),
                ));
            }
        }
    }
    Ok(fallback)
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
    if state.resolve_network()? != network {
        return Err(http_error(
            400,
            "signing network does not match the host context",
        ));
    }
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
/// attest and the emit gate is `normalizeBoolean`. Where this DIVERGES from
/// the Node original is the failure path (SVC-D-5, CL-33): the JS swallowed
/// an attestation error into `null`, which is byte-identical to
/// `include_attestation: false` in the response — so a caller could not tell
/// "you did not ask for a proof" from "the enclave could not produce one",
/// and a signed result went out either way. `handle_attestation` is itself
/// fail-closed (it answers 503); discarding that was the permissive default.
/// A requested-but-failed attestation now refuses the lane.
///
/// `Ok(Null)` therefore means exactly one thing: the caller deliberately did
/// not ask, or the lane signs with caller material and never attests.
pub(crate) fn build_tee_attestation(
    state: &AppState,
    payload: &serde_json::Value,
    key_source: &str,
    output_hash: &str,
) -> Result<serde_json::Value, RuntimeError> {
    if key_source == "caller" {
        return Ok(serde_json::Value::Null);
    }
    if !should_emit_attestation(state, payload) {
        return Ok(serde_json::Value::Null);
    }
    let attestation =
        handle_attestation(state, &serde_json::json!({ "report_data": output_hash }))?;
    // `body.attestation_document || body.document || null` — falsy → null.
    let document = match attestation.get("attestation_document") {
        Some(serde_json::Value::String(document)) if !document.is_empty() => {
            serde_json::Value::String(document.clone())
        }
        _ => serde_json::Value::Null,
    };
    Ok(serde_json::json!({
        "runtime": "aws-nitro",
        "attestation_document": document,
        "report_data": format!("0x{output_hash}"),
    }))
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
