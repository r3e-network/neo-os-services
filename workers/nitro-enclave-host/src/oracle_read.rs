//! The Phase 9 folds: `/oracle/query`, `/oracle/smart-fetch`,
//! `/oracle/decrypt`, `/oracle/message-reveal` and `/oracle/public-key` run
//! IN-PROCESS. They have concrete route targets; the Rust host has no
//! passthrough manifest or Node compute child.
//!
//! Composition is the JS one, verbatim:
//!   - query/smart-fetch: `buildOracleResponse` (oracle/fetch.js:321) —
//!     `resolveConfidentialPayload` → `normalizeTargetChain` →
//!     `performOracleFetch` (the neo-os-compute port, D4 typed upstream
//!     failures) → `executeProgrammableOracle` (script lane in-process via
//!     boa `ScriptMode::Oracle`; the wasm lane fails closed with
//!     [`neo_os_compute::standalone::WASM_DEFERRED_MESSAGE`], the same
//!     policy the Phase 6 compute fold set) → the D5 signed envelope over
//!     the custody worker key.
//!   - decrypt: `handleOracleDecrypt` (capabilities.js:166) — envelope
//!     extraction, the E5 binding gate re-derived against the trusted
//!     contract (`read_message_from_chain` over the [`OracleIo`] plane),
//!     then the X25519 decrypt.
//!   - message-reveal: `handle_message_reveal` wired over the same plane.
//!   - public-key: `ensureOracleKeyMaterial` + the fixed response shape.
//!
//! Divergences from the Node child, all deliberate:
//!   - `allowUnresolved` is always false: the JS flag tracks an overridden
//!     `globalThis.fetch` (test injection); the host's transport IS the
//!     production one.
//!   - A wasm payload that passes the script gate is refused 400 with the
//!     deferred-wasm message (no wasm runtime is linked) instead of running.
//!   - The provider caches ([`ProviderRuntime`]) sit behind a Mutex held for
//!     the duration of one upstream fetch; the JS worker raced async
//!     requests over module-level Maps instead.
//!   - Production key material is direct Nitro Recipient KMS plaintext already
//!     materialized in memory by `/provision`. Legacy Secrets Manager master
//!     derivation is not compiled; sealed-keystore fallback therefore fails
//!     closed.

use neo_os_compute::core::{
    capped_duration_ms, enforce_serialized_size_limit, normalize_target_chain, read_env,
    resolve_max_bytes, sanitize_error_message, EnvReader,
};
use neo_os_compute::oracle::crypto::{
    format_key_material, resolve_confidential_payload as resolve_confidential_payload_js,
    resolve_encrypted_confidential_payload, resolve_encrypted_confidential_ref,
    resolve_encrypted_payload, resolve_encrypted_token_ref, resolve_oracle_key_material,
    KeystoreReadError, OracleKeyMaterial,
};
use neo_os_compute::oracle::fetch::{perform_oracle_fetch, TransportFailure, UpstreamFetchError};
use neo_os_compute::oracle::message_reveal::{
    handle_message_reveal, handle_oracle_decrypt as handle_oracle_decrypt_port,
    read_message_from_chain, ReadMessageRequest,
};
use neo_os_compute::oracle::providers::ProviderIo;
use neo_os_compute::script::{
    assert_untrusted_scripts_enabled, resolve_script_source, run_script_with_timeout,
    validate_user_script_source, ScriptMode, ScriptRun,
};
use neo_os_compute::standalone::{
    assert_wasm_module_size_allowed, resolve_wasm_module_base64, WASM_DEFERRED_MESSAGE,
};
use neo_os_compute::transport::{HttpRequest, HttpResponse};
use neo_os_core::js_value::JsValue;
use neo_os_core::sha256_hex;
use neo_os_core::stable_stringify::stable_stringify;
use serde_json::{json, Value as Json};

use crate::compute_execute::{
    build_lane_signed_envelope, build_tee_attestation, reject_caller_supplied_signing_key,
    resolve_payload_network, sign_worker_bytes,
};
use crate::fulfill::{js_coerce, js_truthy, trim_string};
use crate::state::AppState;
use crate::{http_error, DispatchOutcome, RuntimeError};

/// `/oracle/query` — the full read: raw upstream response + compute + envelope.
pub fn handle_oracle_query(
    state: &AppState,
    payload: &Json,
) -> Result<DispatchOutcome, RuntimeError> {
    build_oracle_response(state, payload, OracleMode::Query)
}

/// `/oracle/smart-fetch` — the same pipeline without the raw response body.
pub fn handle_oracle_smart_fetch(
    state: &AppState,
    payload: &Json,
) -> Result<DispatchOutcome, RuntimeError> {
    build_oracle_response(state, payload, OracleMode::SmartFetch)
}

/// `/oracle/decrypt` — the token-gated, E5-binding-gated decrypt lane.
pub fn handle_oracle_decrypt(
    state: &AppState,
    payload: &Json,
) -> Result<DispatchOutcome, RuntimeError> {
    let overlay = state.overlay.read().expect("overlay lock").merged_map();
    let env_reader: EnvReader = &|name: &str| overlay.get(name).cloned();
    let io_plane = state.oracle_io.as_ref();
    let transport = |request: &HttpRequest| io_plane.fetch(request);
    let read_message = |request: &ReadMessageRequest| read_message_from_chain(request, &transport);
    let deriver = refuse_legacy_master_derivation;
    let now_seconds = io_plane.now_ms() as f64 / 1000.0;
    let mut rng = os_rng();
    let (status, body) = handle_oracle_decrypt_port(
        payload,
        env_reader,
        now_seconds,
        &deriver,
        &keystore_reader,
        REPO_ROOT,
        &warn_log,
        &mut rng,
        &read_message,
    );
    Ok(DispatchOutcome { status, body })
}

/// `/oracle/message-reveal` — the recipient-gated reveal lane.
pub fn handle_oracle_message_reveal(
    state: &AppState,
    payload: &Json,
) -> Result<DispatchOutcome, RuntimeError> {
    let overlay = state.overlay.read().expect("overlay lock").merged_map();
    let env_reader: EnvReader = &|name: &str| overlay.get(name).cloned();
    let io_plane = state.oracle_io.as_ref();
    let transport = |request: &HttpRequest| io_plane.fetch(request);
    let read_message = |request: &ReadMessageRequest| read_message_from_chain(request, &transport);
    let deriver = refuse_legacy_master_derivation;
    let now_seconds = io_plane.now_ms() as f64 / 1000.0;
    let mut rng = os_rng();
    let (status, body) = handle_message_reveal(
        payload,
        now_seconds,
        env_reader,
        &deriver,
        &keystore_reader,
        REPO_ROOT,
        &warn_log,
        &mut rng,
        &read_message,
    );
    Ok(DispatchOutcome { status, body })
}

/// `/oracle/public-key` — the public X25519 half of the oracle key.
pub fn handle_oracle_public_key(
    state: &AppState,
    _payload: &Json,
) -> Result<DispatchOutcome, RuntimeError> {
    let overlay = state.overlay.read().expect("overlay lock").merged_map();
    let env_reader: EnvReader = &|name: &str| overlay.get(name).cloned();
    let mut rng = os_rng();
    let key = resolve_oracle_key_material(
        env_reader,
        &refuse_legacy_master_derivation,
        &keystore_reader,
        REPO_ROOT,
        &warn_log,
        &mut rng,
    )
    .map_err(|message| http_error(400, sanitize_error_message(&message)))?;
    Ok(DispatchOutcome::ok(json!({
        "algorithm": key.algorithm,
        "public_key": key.public_key_raw,
        "public_key_format": key.key_format,
        "key_source": key.source,
        "recommended_payload_encryption": key.algorithm,
        "supported_payload_encryption": [key.algorithm],
    })))
}

/// The image workdir: relative `MORPHEUS_ORACLE_KEYSTORE_PATH` overrides
/// resolve against it (the child resolved against its install dir, which the
/// image places here).
const REPO_ROOT: &str = "/app";

/// `warnLog` — structured line on the enclave stdout, same fields the child
/// emitted.
fn warn_log(level: &str, event: &str, detail: &str) {
    println!(
        "{}",
        json!({ "level": level, "msg": event, "detail": detail })
    );
}

/// `crypto.getRandomValues` — the ephemeral-key fallback needs real entropy.
fn os_rng() -> impl FnMut(&mut [u8]) {
    use rand::RngCore;
    let mut os = rand::rngs::OsRng;
    move |buffer: &mut [u8]| os.fill_bytes(buffer)
}

/// `readKeystoreFile` over the enclave filesystem: ENOENT → the optional
/// sentinel, anything else rethrown.
fn keystore_reader(path: &str) -> Result<String, KeystoreReadError> {
    match std::fs::read_to_string(path) {
        Ok(raw) => Ok(raw),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Err(KeystoreReadError::NotFound)
        }
        Err(error) => Err(KeystoreReadError::Other(error.to_string())),
    }
}

#[derive(Clone, Copy, PartialEq)]
enum OracleMode {
    Query,
    SmartFetch,
}

/// `buildOracleResponse` (fetch.js:321).
fn build_oracle_response(
    state: &AppState,
    payload: &Json,
    mode: OracleMode,
) -> Result<DispatchOutcome, RuntimeError> {
    let overlay = state.overlay.read().expect("overlay lock").merged_map();
    let env_reader: EnvReader = &|name: &str| overlay.get(name).cloned();
    let io_plane = state.oracle_io.as_ref();
    let transport = |request: &HttpRequest| io_plane.fetch(request);

    // Key material is resolved lazily, exactly where the JS resolves it:
    // `resolveConfidentialPayload`'s decrypt and `performOracleFetch`'s token
    // decrypt. When neither lane carries ciphertext the (unused) placeholder
    // rides along — `decrypt_encrypted_token` returns before touching it.
    let confidential_direct = resolve_encrypted_confidential_payload(payload);
    let confidential_ref = resolve_encrypted_confidential_ref(payload);
    let mut key = placeholder_key();
    let mut key_resolved = false;
    if !confidential_direct.is_empty() || !confidential_ref.is_empty() {
        key = oracle_key_material(env_reader, &mut os_rng())
            .map_err(|message| http_error(400, sanitize_error_message(&message)))?;
        key_resolved = true;
    }

    let resolved = resolve_confidential_payload_js(payload, env_reader, &transport, &key)
        .map_err(|message| http_error(400, sanitize_error_message(&message)))?;

    // `performOracleFetch(resolvedPayload)` — its token decrypt may still be
    // the first key consumer.
    if !key_resolved
        && (!resolve_encrypted_payload(&resolved).is_empty()
            || !resolve_encrypted_token_ref(&resolved).is_empty())
    {
        key = oracle_key_material(env_reader, &mut os_rng())
            .map_err(|message| http_error(400, sanitize_error_message(&message)))?;
    }

    let fetch = match perform_fetch(state, env_reader, &transport, &resolved, &key) {
        Ok(fetch) => fetch,
        Err(FetchError::Runtime(error)) => return Err(error),
        Err(FetchError::Upstream(error)) => return Ok(upstream_outcome(error)),
    };

    // `normalizeTargetChain(resolvedPayload.target_chain)`.
    let target_chain = normalize_target_chain(resolved.get("target_chain").unwrap_or(&Json::Null))
        .map_err(|message| http_error(400, message))?;
    // `resolvedPayload.target_chain_id ? String(...) : null`
    let target_chain_id = match resolved
        .get("target_chain_id")
        .filter(|value| js_truthy(value))
    {
        Some(value) => Json::String(js_coerce(value)),
        None => Json::Null,
    };
    // `trimString(resolvedPayload.request_source || 'chain-dispatcher') || 'chain-dispatcher'`
    let request_source = {
        let trimmed = trim_string(resolved.get("request_source").filter(|v| js_truthy(v)));
        if trimmed.is_empty() {
            "chain-dispatcher".to_string()
        } else {
            trimmed
        }
    };

    // The `context` object — `{...fetchResult, target_chain, ...}` in build
    // order; cloned fields because the fetch result feeds the response too.
    let context = json!({
        "upstream_status": fetch.upstream_status,
        "upstream_headers": fetch.upstream_headers.clone(),
        "raw_response": fetch.raw_response.clone(),
        "data": fetch.data.clone(),
        "selected_value": fetch.selected_value.clone(),
        "provider": fetch.provider.clone(),
        "provider_pair": fetch.provider_pair.clone(),
        "encrypted_token_present": fetch.encrypted_token_present,
        "target_chain": target_chain,
        "target_chain_id": target_chain_id,
        "request_source": request_source,
    });

    let executed = execute_programmable_oracle(env_reader, &resolved, &context)?;
    let result = if executed.executed {
        executed.result
    } else {
        // `{executed: false, result: selected_value ?? data ?? raw_response}`
        nullish_coalesce(&context, &["selected_value", "data", "raw_response"])
    };

    // The `derived` object — literal order is the hash input order.
    let derived = json!({
        "target_chain": context["target_chain"],
        "target_chain_id": context["target_chain_id"],
        "request_source": context["request_source"],
        "result": result.clone(),
        "extracted_value": fetch.selected_value.clone(),
        "upstream_status": fetch.upstream_status,
    });

    // buildSignedResultEnvelope(derived, resolvedPayload).
    reject_caller_supplied_signing_key(&resolved)?;
    let payload_bytes = stable_stringify(&JsValue::from_json(&derived)).into_bytes();
    let output_hash = sha256_hex(&payload_bytes);
    let network = resolve_payload_network(state, &resolved);
    let signed = sign_worker_bytes(state, &network, &payload_bytes)?;
    let tee_attestation = build_tee_attestation(state, &resolved, "custody", &output_hash);
    let lane = build_lane_signed_envelope(&signed, &output_hash, &tee_attestation);

    // Response assembly in the JS literal's insertion order (serde_json's
    // preserve_order keeps the parity byte-for-byte).
    let mut response = serde_json::Map::new();
    let computed_mode = if executed.executed {
        "fetch+compute"
    } else {
        "fetch"
    };
    response.insert("mode".to_string(), Json::String(computed_mode.to_string()));
    response.insert(
        "request_source".to_string(),
        context["request_source"].clone(),
    );
    response.insert("target_chain".to_string(), context["target_chain"].clone());
    response.insert(
        "target_chain_id".to_string(),
        context["target_chain_id"].clone(),
    );
    match mode {
        OracleMode::Query => {
            response.insert("status_code".to_string(), json!(fetch.upstream_status));
            response.insert("headers".to_string(), fetch.upstream_headers);
            response.insert("body".to_string(), Json::String(fetch.raw_response));
            // `typeof fetchResult.data === 'string' ? null : fetchResult.data`
            let body_json = match &fetch.data {
                Json::String(_) => Json::Null,
                other => other.clone(),
            };
            response.insert("body_json".to_string(), body_json);
            response.insert(
                "extracted_value".to_string(),
                fetch.selected_value.clone().unwrap_or(Json::Null),
            );
            response.insert("result".to_string(), result);
        }
        OracleMode::SmartFetch => {
            response.insert("upstream_status".to_string(), json!(fetch.upstream_status));
            response.insert("result".to_string(), result);
            response.insert(
                "extracted_value".to_string(),
                fetch.selected_value.clone().unwrap_or(Json::Null),
            );
        }
    }
    for (key, value) in lane {
        response.insert(key, value);
    }
    Ok(DispatchOutcome {
        status: 200,
        body: Json::Object(response),
    })
}

/// The key-material tree with legacy master derivation hard-disabled.
fn oracle_key_material(
    env_reader: EnvReader<'_>,
    rng: &mut dyn FnMut(&mut [u8]),
) -> Result<OracleKeyMaterial, String> {
    resolve_oracle_key_material(
        env_reader,
        &refuse_legacy_master_derivation,
        &keystore_reader,
        REPO_ROOT,
        &warn_log,
        rng,
    )
}

fn refuse_legacy_master_derivation(_path: &str, _purpose: &str) -> Result<Vec<u8>, String> {
    Err(
        "legacy Secrets Manager master derivation is disabled; provision a Nitro Recipient KMS ciphertext"
            .to_string(),
    )
}

/// The placeholder material: never dereferenced — `decrypt_encrypted_token`
/// returns `Ok(None)` on an empty ciphertext before any key use, and the
/// fold replaces it the moment a ciphertext lane is live.
fn placeholder_key() -> OracleKeyMaterial {
    format_key_material(vec![0u8; 32], Vec::new(), "placeholder")
}

/// `context.selected_value ?? context.data ?? context.raw_response` — the
/// `??` chain (nullish, not falsy).
fn nullish_coalesce(context: &Json, keys: &[&str]) -> Json {
    for key in keys {
        if let Some(value) = context.get(key).filter(|value| !value.is_null()) {
            return value.clone();
        }
    }
    Json::Null
}

/// `executeProgrammableOracle` (crypto.js:685) — wasm fails closed after the
/// gates, scripts run on the in-process boa sandbox, no script falls back to
/// the fetch result.
fn execute_programmable_oracle(
    env_reader: EnvReader<'_>,
    payload: &Json,
    context: &Json,
) -> Result<ExecutedOracle, RuntimeError> {
    let max_script_input_bytes = resolve_max_bytes(
        Some(&Json::String(read_env(
            env_reader,
            &["ORACLE_MAX_SCRIPT_INPUT_BYTES"],
        ))),
        128 * 1024,
        1024,
    );
    let programmable_context = json!({
        "target_chain": context["target_chain"],
        "target_chain_id": context["target_chain_id"],
        "request_source": context["request_source"],
        "upstream_status": context["upstream_status"],
        "provider": context["provider"],
        "provider_pair": context["provider_pair"],
        "selected_value": context["selected_value"],
        "encrypted_token_present": context["encrypted_token_present"],
    });
    let data = context["data"].clone();

    let wasm_module_base64 = resolve_wasm_module_base64(payload);
    if !wasm_module_base64.is_empty() {
        // SECURITY (S1): the same opt-in gate and size gate, in the same
        // order — then the deliberate refusal (no wasm runtime is linked).
        assert_untrusted_scripts_enabled(env_reader).map_err(|message| http_error(400, message))?;
        assert_wasm_module_size_allowed(&wasm_module_base64)
            .map_err(|message| http_error(400, message))?;
        enforce_serialized_size_limit(
            &json!({ "data": data, "context": programmable_context }),
            "oracle programmable input",
            max_script_input_bytes,
        )
        .map_err(|message| http_error(400, message))?;
        let _timeout_ms = capped_duration_ms(
            first_truthy_or_env(
                payload,
                &[
                    "wasm_timeout_ms",
                    "script_timeout_ms",
                    "oracle_script_timeout_ms",
                ],
                &read_env(
                    env_reader,
                    &["ORACLE_WASM_TIMEOUT_MS", "MORPHEUS_WASM_TIMEOUT_MS"],
                ),
            )
            .as_ref(),
            10_000,
            10_000,
        );
        return Err(http_error(400, WASM_DEFERRED_MESSAGE));
    }

    let script = resolve_script_source(payload).map_err(|message| http_error(400, message))?;
    let Some(script) = script else {
        return Ok(ExecutedOracle {
            executed: false,
            result: nullish_coalesce(context, &["selected_value", "data", "raw_response"]),
        });
    };

    assert_untrusted_scripts_enabled(env_reader).map_err(|message| http_error(400, message))?;
    validate_user_script_source(&script, env_reader).map_err(|message| http_error(400, message))?;
    enforce_serialized_size_limit(
        &json!({ "data": data, "context": programmable_context }),
        "oracle programmable input",
        max_script_input_bytes,
    )
    .map_err(|message| http_error(400, message))?;
    let timeout_ms = capped_duration_ms(
        first_truthy_or_env(
            payload,
            &["script_timeout_ms", "oracle_script_timeout_ms"],
            &read_env(env_reader, &["ORACLE_SCRIPT_TIMEOUT_MS"]),
        )
        .as_ref(),
        2_000,
        10_000,
    );

    let result = run_script_with_timeout(
        ScriptRun {
            mode: ScriptMode::Oracle,
            script: &script,
            entry_point: "",
            input: &Json::Null,
            data: &data,
            context: &programmable_context,
            timeout_ms,
            fixed_now_ms: None,
        },
        env_reader,
    )
    .map_err(|message| http_error(400, message))?;
    Ok(ExecutedOracle {
        executed: true,
        result,
    })
}

struct ExecutedOracle {
    executed: bool,
    result: Json,
}

/// `payload.a || payload.b || env(...)`: the first truthy payload field,
/// else the env value when non-empty (JS `''` is falsy in the `||` chain),
/// else None — `capped_duration_ms` supplies the final fallback.
fn first_truthy_or_env(payload: &Json, fields: &[&str], env_value: &str) -> Option<Json> {
    for field in fields {
        if let Some(value) = payload.get(*field).filter(|value| js_truthy(value)) {
            return Some(value.clone());
        }
    }
    (!env_value.is_empty()).then_some(Json::String(env_value.to_string()))
}

/// The two exits a fetch can take: a plain thrown error (400-class through
/// the worker catch) or a D4 upstream fault rendered as its own body.
enum FetchError {
    Runtime(RuntimeError),
    Upstream(UpstreamFetchError),
}

/// `buildUpstreamErrorResponse` (capabilities.js:219) — the D4 gateway body.
fn upstream_outcome(error: UpstreamFetchError) -> DispatchOutcome {
    let kind = error.kind.as_str();
    let mut body = serde_json::Map::new();
    body.insert("error".to_string(), Json::String(error.message));
    body.insert("error_code".to_string(), Json::String(kind.to_string()));
    body.insert("kind".to_string(), Json::String(kind.to_string()));
    if let Some(upstream_status) = error.upstream_status {
        body.insert("upstream_status".to_string(), json!(upstream_status));
    }
    DispatchOutcome {
        status: error.http_status,
        body: Json::Object(body),
    }
}

/// One `perform_oracle_fetch` under the provider-cache lock. `allow_unresolved`
/// is false: the production transport is not a test injection.
fn perform_fetch(
    state: &AppState,
    env_reader: EnvReader<'_>,
    transport: &dyn Fn(&HttpRequest) -> Result<HttpResponse, String>,
    resolved: &Json,
    key: &OracleKeyMaterial,
) -> Result<neo_os_compute::oracle::fetch::FetchOutcome, FetchError> {
    let io_plane = state.oracle_io.as_ref();
    // The port's DnsLookup error is `()` (ssrf.rs `DnsLookupError`): the
    // resolution diagnostics never reach the user — the port renders its own
    // SSRF/unreachable messages — so they are dropped at this seam.
    let dns = |host: &str| io_plane.dns_lookup(host).map_err(|_| ());
    let sleep = |ms: u64| io_plane.sleep_ms(ms);
    let io = ProviderIo {
        env: env_reader,
        dns: &dns,
        transport,
        now_ms: io_plane.now_ms(),
        sleep_ms: &sleep,
        allow_unresolved: false,
    };
    let mut runtime = state.oracle_runtime.lock().expect("oracle runtime lock");
    perform_oracle_fetch(resolved, key, &io, &mut runtime).map_err(|failure| match failure {
        TransportFailure::CallerUrl(message) => FetchError::Runtime(http_error(400, message)),
        TransportFailure::Upstream(error) => FetchError::Upstream(error),
    })
}

#[cfg(test)]
#[path = "../tests/unit/oracle_read.rs"]
mod tests;
