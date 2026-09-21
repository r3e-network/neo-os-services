//! The `/oracle/fulfill` fold — the Rust shape of `handleOracleFulfill`
//! (enclave-server.mjs:742-912): compute, then encode, digest, sign, and attest
//! ATOMICALLY inside the measured boundary. The digest and
//! result envelope are NEVER re-derived here — they come from
//! `neo_os_core`'s golden-vector-tested canonical builders, fed the same
//! inputs the relayer feeds them, so the produced signature is identical to
//! the relayer-path signature. The signer never sees a caller-supplied
//! `data_hex` for this route: only the fold's own digest is signed.
//!
//! Divergences from the Node server, all deliberate:
//!   - NeoX uses the custody service's semantic EIP-191 endpoint: this host
//!     sends structured fulfillment fields and independently checks the
//!     returned digest/signature identity. No raw secp256k1 signing surface is
//!     exposed and the `neox_verifier` role stays distinct from the updater.
//!   - A failed signing call surfaces the signer plane's own status (503
//!     for an unconfigured plane) where the Node server's untyped throw
//!     rendered a 500; the message is identical.
//!   - `BigInt` values in a JsValue (the builders never put one in these
//!     envelopes) serialize to their decimal string, not `null`.

use neo_os_chain_evm::{
    build_neox_digest, resolve_result_bytes_hex, Fulfillment as EvmFulfillment,
};
use neo_os_core::digest::{build_fulfillment_digest_bytes, FulfillmentOptions};
use neo_os_core::envelope::{build_onchain_result_envelope, encode_fulfillment_result};
use neo_os_core::js_number::json_number_to_string;
use neo_os_core::js_value::{js_trim, JsValue};
use neo_os_core::kernel::{build_worker_payload, resolve_kernel_intent};

use crate::attestation::{handle_attestation, normalize_hex};
use crate::http_error;
use crate::state::{AppState, Eip191FulfillmentRequest};
use crate::RuntimeError;

const N3_MAINNET_MAGIC: u32 = 860_833_102;
const N3_TESTNET_MAGIC: u32 = 894_710_606;
const N3_MAINNET_ORACLE_CONTRACT: &str = "0xf54d8584ef82315c1800373272ab08ae0db2d5ef";
const N3_TESTNET_ORACLE_CONTRACT: &str = "0xf54d8584ef82315c1800373272ab08ae0db2d5ef";

/// JS `String(value)` over serde JSON — `??` chains never hand us
/// null/undefined, so `Null` here is unreachable in practice.
pub(crate) fn js_coerce(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(text) => text.clone(),
        serde_json::Value::Number(number) => {
            json_number_to_string(number.as_f64().unwrap_or(f64::NAN))
        }
        serde_json::Value::Bool(true) => "true".to_string(),
        serde_json::Value::Bool(false) => "false".to_string(),
        serde_json::Value::Null => "null".to_string(),
        serde_json::Value::Array(items) => {
            items.iter().map(js_coerce).collect::<Vec<_>>().join(",")
        }
        serde_json::Value::Object(_) => "[object Object]".to_string(),
    }
}

/// JS `trimString(value)`: `String(value ?? '').trim()`.
pub(crate) fn trim_string(value: Option<&serde_json::Value>) -> String {
    match value {
        None | Some(serde_json::Value::Null) => String::new(),
        Some(value) => js_trim(&js_coerce(value)).to_string(),
    }
}

/// JS truthiness over serde JSON (objects/arrays are truthy, `0`/`''`/null
/// are not; serde cannot carry NaN).
pub(crate) fn js_truthy(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Null => false,
        serde_json::Value::Bool(b) => *b,
        serde_json::Value::Number(number) => number.as_f64().map(|f| f != 0.0).unwrap_or(false),
        serde_json::Value::String(text) => !text.is_empty(),
        serde_json::Value::Array(_) | serde_json::Value::Object(_) => true,
    }
}

/// `a ?? b ?? ''` over one object's keys: the first non-null hit, JS-String'd.
fn string_coalesce(object: &serde_json::Value, keys: &[&str]) -> String {
    for key in keys {
        if let Some(value) = object.get(key).filter(|value| !value.is_null()) {
            return js_coerce(value);
        }
    }
    String::new()
}

/// `a || b || ''` over one object's keys: the first JS-truthy hit, trimmed.
pub(crate) fn truthy_trimmed(object: &serde_json::Value, keys: &[&str]) -> String {
    for key in keys {
        if let Some(value) = object.get(key).filter(|value| js_truthy(value)) {
            return js_trim(&js_coerce(value)).to_string();
        }
    }
    String::new()
}

/// `normalizeChain`: 'neox' | 'legacy' | 'neo_n3' (everything else).
fn normalize_chain(body: &serde_json::Value) -> &'static str {
    match trim_string(body.get("chain")).to_ascii_lowercase().as_str() {
        "neox" => "neox",
        "legacy" => "legacy",
        _ => "neo_n3",
    }
}

/// `isHostUnattestedLane`: the arbitrary-URL smart-fetch lane stays host-tier
/// and is never computed/signed in-enclave.
fn is_host_unattested_lane(intent_module_route: &str, payload: &serde_json::Value) -> bool {
    if intent_module_route != "/oracle/smart-fetch" {
        return false;
    }
    !truthy_trimmed(payload, &["url"]).is_empty()
}

/// JsValue → serde JSON for the HTTP response. The builders' outputs are
/// JSON-shaped (strings/numbers/objects), so this is lossless on every real
/// path; BigInt (never produced here) degrades to its decimal string.
fn js_to_json(value: &JsValue) -> serde_json::Value {
    match value {
        JsValue::Undefined | JsValue::Null => serde_json::Value::Null,
        JsValue::Bool(b) => serde_json::Value::Bool(*b),
        JsValue::Number(number) => serde_json::Number::from_f64(*number)
            .map(serde_json::Value::Number)
            .unwrap_or(serde_json::Value::Null),
        JsValue::BigInt(text) => serde_json::Value::String(text.clone()),
        JsValue::Str(text) => serde_json::Value::String(text.clone()),
        JsValue::Array(items) => serde_json::Value::Array(items.iter().map(js_to_json).collect()),
        JsValue::Object(object) => {
            let mut map = serde_json::Map::new();
            for (key, item) in object.iter() {
                map.insert(key.to_string(), js_to_json(item));
            }
            serde_json::Value::Object(map)
        }
    }
}

/// The `{ok, status, body}` compute reply the canonical builders consume —
/// the exact shape `computeViaWorker` returned to them.
fn worker_response_value(reply: &crate::state::BridgeReply) -> JsValue {
    JsValue::from_json(&serde_json::json!({
        "ok": reply.ok,
        "status": reply.status,
        "body": reply.body,
    }))
}

/// The `context` object `computeWorkerResponse` builds for
/// `buildWorkerPayload` (enclave-server.mjs:788-793): the three trimmed
/// payload fields it decorates the worker payload with.
fn fulfillment_context_object(payload: &serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "requester": truthy_trimmed(payload, &["requester"]),
        "callbackContract": truthy_trimmed(payload, &["callback_contract"]),
        "callbackMethod": truthy_trimmed(payload, &["callback_method"]),
    })
}

/// `requestBody?.payload_text ?? payload?.payload_text ?? payload?.envelope ?? ''`
/// — `??` falls through null/absent only, and the value is NOT trimmed here
/// (the decrypt lane trims it after its own `||` chain).
fn payload_text(body: &serde_json::Value, payload: &serde_json::Value) -> serde_json::Value {
    body.get("payload_text")
        .filter(|value| !value.is_null())
        .or_else(|| payload.get("payload_text").filter(|value| !value.is_null()))
        .or_else(|| payload.get("envelope").filter(|value| !value.is_null()))
        .cloned()
        .unwrap_or(serde_json::Value::Null)
}

pub fn handle_oracle_fulfill(
    state: &AppState,
    body: &serde_json::Value,
) -> Result<serde_json::Value, RuntimeError> {
    let chain = normalize_chain(body);
    let request_type = truthy_trimmed(body, &["request_type", "requestType"]);
    let request_id = trim_string(
        body.get("request_id")
            .filter(|v| !v.is_null())
            .or_else(|| body.get("requestId").filter(|v| !v.is_null())),
    );
    let payload = match body.get("payload") {
        Some(payload @ serde_json::Value::Object(_)) => payload.clone(),
        _ => serde_json::json!({}),
    };
    let fulfillment_context = match body.get("fulfillment_context") {
        Some(context @ serde_json::Value::Object(_)) => context.clone(),
        _ => serde_json::json!({}),
    };
    let nonce = normalize_hex(&truthy_trimmed(body, &["nonce"]));

    if request_type.is_empty() {
        return Err(http_error(400, "request_type is required"));
    }
    if request_id.is_empty() {
        return Err(http_error(400, "request_id is required"));
    }

    let intent = resolve_kernel_intent(&request_type);

    // Kernel envelope fields the digest binds (verbatim — matches the
    // relayer's resolveEventFulfillmentContext: prefer the on-chain
    // identifiers, fall back to the kernel-intent mapping only for genuinely
    // absent fields). String()'d WITHOUT trimming; `||` falls back on the
    // empty string exactly as JS truthiness does.
    let app_id = string_coalesce(&fulfillment_context, &["app_id", "appId"]);
    let module_id_text = string_coalesce(&fulfillment_context, &["module_id", "moduleId"]);
    let module_id = if module_id_text.is_empty() {
        intent.module_id.to_string()
    } else {
        module_id_text
    };
    let operation_text = string_coalesce(&fulfillment_context, &["operation"]);
    let operation = if operation_text.is_empty() {
        intent.operation.clone()
    } else {
        operation_text
    };

    // Host-unattested tier: arbitrary-URL fetch is not computed/signed here.
    if is_host_unattested_lane(intent.worker_route, &payload) {
        return Ok(serde_json::json!({
            "status": "host-unattested",
            "success": false,
            "result": "",
            "error": "arbitrary-url fetch is host-tier (not attested in-enclave)",
            "signature": serde_json::Value::Null,
            "public_key": serde_json::Value::Null,
            "fulfillment_digest_hex": serde_json::Value::Null,
            "verification": serde_json::Value::Null,
            "trust_tier": "host-unattested",
        }));
    }

    // (a)+(b) COMPUTE via the keyless child.
    let reply = compute_worker_response(
        state,
        chain,
        &request_type,
        &payload,
        &request_id,
        intent.module_id,
        &payload_text(body, &payload),
    );

    // Infrastructure failures are retryable and must never be committed as a
    // deterministic on-chain refusal. This mirrors the relayer's worker-status
    // classifier: business 4xx replies can be encoded as unsuccessful
    // fulfillments, while timeout/rate-limit/5xx replies leave the request open
    // for a later attempt.
    if !reply.ok && is_transient_worker_status(reply.status) {
        let detail = truthy_trimmed(&reply.body, &["error", "message", "code"]);
        let message = if detail.is_empty() {
            format!("transient compute failure (HTTP {})", reply.status)
        } else {
            format!(
                "transient compute failure (HTTP {}): {detail}",
                reply.status
            )
        };
        return Err(http_error(reply.status, message));
    }

    // (c) Encode the on-chain fulfillment fields + result envelope via the
    // CANONICAL builders (identical to the relayer's prepareOracleFulfillment).
    let worker_response = worker_response_value(&reply);
    let fulfillment = encode_fulfillment_result(&request_type, &worker_response)
        .map_err(|error| http_error(500, format!("fulfillment encoding failed: {error}")))?;
    let verification = build_onchain_result_envelope(&request_type, &worker_response, None);

    let result = fulfillment.result.clone();
    let result_bytes_base64 = fulfillment.result_bytes_base64.clone().unwrap_or_default();
    let error = fulfillment.error.clone();

    // (d)+(e) BUILD the digest with the canonical builder + SIGN atomically.
    // Read caller context for mismatch detection only. Neo N3 / legacy
    // signatures are always bound to the measured network's contract + magic;
    // an untrusted relayer cannot omit or replace that domain.
    let contract_script_hash = truthy_trimmed(
        &fulfillment_context,
        &["contract_script_hash", "contractScriptHash"],
    );
    let network = state.resolve_network();
    let (digest_hex, signed, result_bytes_hex, attestation_role) = if chain == "neox" {
        let chain_id = required_neox_chain_id(&fulfillment_context)?;
        let oracle_contract =
            truthy_trimmed(&fulfillment_context, &["oracle_contract", "oracleContract"]);
        if oracle_contract.is_empty() {
            return Err(http_error(
                400,
                "neox fulfillment_context.oracle_contract is required",
            ));
        }
        let evm = EvmFulfillment {
            request_id: request_id.clone(),
            app_id: app_id.clone(),
            module_id: module_id.clone(),
            operation: operation.clone(),
            success: fulfillment.success,
            error: error.clone(),
        };
        let result_bytes_hex = resolve_result_bytes_hex(&result, &result_bytes_base64);
        let digest = build_neox_digest(chain_id, &oracle_contract, &evm, &result_bytes_hex)
            .map_err(|error| http_error(400, format!("invalid NeoX fulfillment: {error}")))?;
        let signer_request_id = format!("neox-fulfill:{}", hex::encode(digest));
        let signed = state
            .signer
            .sign_eip191_fulfillment(&Eip191FulfillmentRequest {
                network: &network,
                role: "neox_verifier",
                chain_id,
                oracle_contract: &oracle_contract,
                fulfillment: &evm,
                result_bytes_hex: &result_bytes_hex,
                request_id: &signer_request_id,
            })?;
        (
            format!("0x{}", hex::encode(digest)),
            signed,
            Some(result_bytes_hex),
            "neox_verifier",
        )
    } else {
        let (contract_script_hash, network_magic) = measured_n3_binding(
            &network,
            &contract_script_hash,
            fulfillment_context
                .get("network_magic")
                .filter(|value| !value.is_null())
                .or_else(|| {
                    fulfillment_context
                        .get("networkMagic")
                        .filter(|value| !value.is_null())
                }),
        )?;
        let options = FulfillmentOptions {
            chain: Some(chain.to_string()),
            app_id: app_id.clone(),
            module_id: module_id.clone(),
            operation: operation.clone(),
            contract_script_hash,
            network_magic,
        };
        let digest_bytes = build_fulfillment_digest_bytes(
            &JsValue::Str(request_id.clone()),
            &request_type,
            fulfillment.success,
            &result,
            &error,
            &result_bytes_base64,
            &options,
        )
        .map_err(|error| http_error(500, format!("fulfillment digest failed: {error}")))?;
        let digest_hex = hex::encode(digest_bytes);
        let signed = state
            .signer
            .sign_payload(&network, "oracle_verifier", &digest_hex)?;
        (digest_hex, signed, None, "oracle_verifier")
    };

    // (f) Return the contract. result_bytes_base64 only present for compact
    // lanes (vrf/neodid). nonce echoed for the relayer/verifier freshness
    // binding.
    let mut response = serde_json::json!({
        "status": "ok",
        "chain": chain,
        "request_id": request_id,
        "app_id": app_id,
        "module_id": module_id,
        "operation": operation,
        "success": fulfillment.success,
        "result": result,
        "error": error,
        "signature": signed.get("signature").cloned().unwrap_or(serde_json::Value::Null),
        "public_key": signed.get("public_key").cloned().unwrap_or(serde_json::Value::Null),
        "fulfillment_digest_hex": digest_hex,
        "verification": js_to_json(&JsValue::Object(verification)),
        "trust_tier": "enclave-attested",
    });
    if !result_bytes_base64.is_empty() {
        response["result_bytes_base64"] = serde_json::Value::String(result_bytes_base64);
    }
    if let Some(result_bytes_hex) = result_bytes_hex {
        response["result_bytes_hex"] = serde_json::Value::String(result_bytes_hex);
    }
    if !nonce.is_empty() {
        response["nonce"] = serde_json::Value::String(nonce.clone());
    }

    // (g) ENFORCING ATTESTATION (C1): bind a fresh NSM document to THIS result
    // by committing user_data = sha256(the EXACT fulfillment_digest bytes) and
    // the oracle_verifier public key. Best-effort: if the NSM is unavailable
    // the signature path still returns and the relayer downgrades trust.
    let mut attestation_payload = serde_json::Map::new();
    attestation_payload.insert(
        "fulfillment_digest_hex".to_string(),
        serde_json::Value::String(digest_hex.clone()),
    );
    if !nonce.is_empty() {
        attestation_payload.insert("nonce".to_string(), serde_json::Value::String(nonce));
    }
    attestation_payload.insert(
        "role".to_string(),
        serde_json::Value::String(attestation_role.to_string()),
    );
    match handle_attestation(state, &serde_json::Value::Object(attestation_payload)) {
        Ok(attestation) => {
            // `if (attestation && attestation.attestation_document)` — only a
            // non-empty document carries fields.
            if let Some(serde_json::Value::String(document)) =
                attestation.get("attestation_document")
            {
                if !document.is_empty() {
                    response["attestation_doc_base64"] =
                        serde_json::Value::String(document.clone());
                    response["attestation_user_data_hex"] = attestation
                        .get("user_data_hex")
                        .cloned()
                        .unwrap_or(serde_json::Value::Null);
                    if attestation
                        .get("public_key")
                        .map(js_truthy)
                        .unwrap_or(false)
                    {
                        response["attestation_public_key"] = attestation["public_key"].clone();
                    }
                    let pcrs_nonempty = attestation
                        .get("pcrs")
                        .and_then(|value| value.as_object())
                        .map(|map| !map.is_empty())
                        .unwrap_or(false);
                    if pcrs_nonempty {
                        response["attestation_pcrs"] = attestation["pcrs"].clone();
                    }
                }
            }
        }
        Err(error) => {
            response["attestation_error"] =
                serde_json::Value::String(error.message.chars().take(300).collect());
        }
    }

    Ok(response)
}

fn measured_n3_binding(
    network: &str,
    supplied_contract: &str,
    supplied_magic: Option<&serde_json::Value>,
) -> Result<(String, Option<f64>), RuntimeError> {
    let expected_contract = measured_n3_oracle_contract(network);
    if !supplied_contract.is_empty() && !supplied_contract.eq_ignore_ascii_case(expected_contract) {
        return Err(http_error(
            400,
            format!(
                "neo_n3 fulfillment contract does not match measured {network} oracle contract"
            ),
        ));
    }

    let expected_magic = measured_n3_magic(network);
    if let Some(value) = supplied_magic {
        let parsed = match value {
            serde_json::Value::Number(number) => number.as_u64(),
            serde_json::Value::String(text) => text.trim().parse::<u64>().ok(),
            _ => None,
        };
        if parsed != Some(u64::from(expected_magic)) {
            return Err(http_error(
                400,
                format!(
                    "neo_n3 fulfillment network magic does not match measured {network} network"
                ),
            ));
        }
    }
    Ok((
        expected_contract.to_string(),
        Some(f64::from(expected_magic)),
    ))
}

fn measured_n3_oracle_contract(network: &str) -> &'static str {
    if network == "mainnet" {
        N3_MAINNET_ORACLE_CONTRACT
    } else {
        N3_TESTNET_ORACLE_CONTRACT
    }
}

fn measured_n3_magic(network: &str) -> u32 {
    if network == "mainnet" {
        N3_MAINNET_MAGIC
    } else {
        N3_TESTNET_MAGIC
    }
}

fn required_neox_chain_id(context: &serde_json::Value) -> Result<u64, RuntimeError> {
    let value = context
        .get("chain_id")
        .filter(|value| !value.is_null())
        .or_else(|| context.get("chainId").filter(|value| !value.is_null()));
    let chain_id = match value {
        Some(serde_json::Value::Number(number)) => number.as_u64(),
        Some(serde_json::Value::String(text)) => text.trim().parse::<u64>().ok(),
        _ => None,
    }
    .filter(|value| *value > 0)
    .ok_or_else(|| http_error(400, "neox fulfillment_context.chain_id is required"))?;
    Ok(chain_id)
}

fn is_transient_worker_status(status: u16) -> bool {
    matches!(status, 408 | 425 | 429) || (500..=599).contains(&status)
}

/// `computeWorkerResponse` (enclave-server.mjs:721-740): the confidential
/// decrypt special case, otherwise the kernel route with the
/// buildWorkerPayload-decorated payload.
fn compute_worker_response(
    state: &AppState,
    chain: &str,
    request_type: &str,
    payload: &serde_json::Value,
    request_id: &str,
    intent_module_id: &str,
    payload_text_value: &serde_json::Value,
) -> crate::state::BridgeReply {
    if intent_module_id == "confidential.decrypt" {
        // `trimString(context.payloadText || payload?.envelope || '')`.
        let envelope = match payload_text_value {
            serde_json::Value::Null => truthy_trimmed(payload, &["envelope"]),
            value if js_truthy(value) => trim_string(Some(value)),
            _ => truthy_trimmed(payload, &["envelope"]),
        };
        let mut decrypted = payload.clone();
        decrypted["envelope"] = serde_json::Value::String(envelope);
        return execute_fulfillment_route(state, "/oracle/decrypt", &decrypted);
    }

    let intent = resolve_kernel_intent(request_type);
    let payload_js = JsValue::from_json(payload);
    let context = fulfillment_context_object(payload);
    let worker_payload = build_worker_payload(
        chain,
        request_type,
        &payload_js,
        &JsValue::Str(request_id.to_string()),
        &JsValue::from_json(&context),
    );
    let worker_payload_json = js_to_json(&JsValue::Object(worker_payload));
    execute_fulfillment_route(state, intent.worker_route, &worker_payload_json)
}

fn execute_fulfillment_route(
    state: &AppState,
    route: &str,
    payload: &serde_json::Value,
) -> crate::state::BridgeReply {
    #[cfg(test)]
    if let Some(compute) = &state.fulfillment_compute_override {
        return compute.forward(route, payload, None);
    }

    match route {
        "/compute/execute" => value_reply(crate::compute_execute::handle_compute_execute(
            state, payload,
        )),
        "/oracle/query" => outcome_reply(crate::oracle_read::handle_oracle_query(state, payload)),
        "/oracle/smart-fetch" => outcome_reply(crate::oracle_read::handle_oracle_smart_fetch(
            state, payload,
        )),
        "/oracle/decrypt" => {
            outcome_reply(crate::oracle_read::handle_oracle_decrypt(state, payload))
        }
        "/oracle/message-reveal" => outcome_reply(
            crate::oracle_read::handle_oracle_message_reveal(state, payload),
        ),
        "/neodid/bind" => value_reply(crate::neodid::handle_neo_did_bind(state, payload)),
        "/neodid/action-ticket" => {
            value_reply(crate::neodid::handle_neo_did_action_ticket(state, payload))
        }
        "/neodid/recovery-ticket" => value_reply(crate::neodid::handle_neo_did_recovery_ticket(
            state, payload,
        )),
        "/neodid/zklogin-ticket" => {
            value_reply(crate::neodid::handle_neo_did_zklogin_ticket(state, payload))
        }
        "/vrf/random" => value_reply(crate::vrf::handle_vrf_random(state, payload)),
        "/paymaster/authorize" => {
            value_reply(crate::paymaster::handle_paymaster_authorize(state, payload))
        }
        "/session/finalize" => outcome_reply(crate::session::handle_session_finalize_kernel(
            state, payload,
        )),
        "/automation/execute" => {
            outcome_reply(crate::automation::handle_automation_execute(state, payload))
        }
        "/oracle/feed" => outcome_reply(crate::oracle_feed::handle_oracle_feed(state, payload)),
        _ => crate::bridge::unavailable_reply(route),
    }
}

fn value_reply(result: Result<serde_json::Value, RuntimeError>) -> crate::state::BridgeReply {
    match result {
        Ok(body) => crate::state::BridgeReply {
            ok: true,
            status: 200,
            body,
        },
        Err(error) => crate::state::BridgeReply {
            ok: false,
            status: error.status,
            body: error.body(),
        },
    }
}

fn outcome_reply(
    result: Result<crate::DispatchOutcome, RuntimeError>,
) -> crate::state::BridgeReply {
    match result {
        Ok(outcome) => crate::state::BridgeReply {
            ok: (200..300).contains(&outcome.status),
            status: outcome.status,
            body: outcome.body,
        },
        Err(error) => crate::state::BridgeReply {
            ok: false,
            status: error.status,
            body: error.body(),
        },
    }
}

#[cfg(test)]
#[path = "../tests/unit/fulfill.rs"]
mod tests;
