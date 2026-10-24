//! `/oracle/fulfill` fold tests — the fixtures from
//! `enclave-server.test.mjs` (the golden-vector consensus gate) ported to the
//! Rust fold. Most byte-contract tests install a canned fulfillment-compute
//! override, exactly like the mjs suite stubs the worker handler, so they
//! isolate the encode -> envelope -> digest -> sign pipeline — the
//! consensus-critical part — instead of live price data. Dedicated tests
//! disable that override and exercise production in-process routing.
//! Byte-exactness is proven the same way:
//! the SAME `{ok, status, body}` reply is fed into the canonical builders
//! independently and the fold's `fulfillment_digest_hex` + `verification`
//! must equal the recomputation.

use super::*;
use crate::state::BridgeReply;
use base64::Engine as _;
use neo_os_chain_evm::{
    build_neox_digest, resolve_result_bytes_hex, Fulfillment as EvmFulfillment,
};
use neo_os_core::digest::{build_fulfillment_digest_bytes, FulfillmentOptions};
use neo_os_core::envelope::{build_onchain_result_envelope, encode_fulfillment_result};
use neo_os_core::js_value::JsValue;
use neo_os_core::kernel::resolve_kernel_intent;
use serde_json::json;

#[path = "support.rs"]
#[allow(clippy::duplicate_mod)] // intentional: one shared doubles file per test module
mod support;
use support::*;

fn fixed_price_body() -> serde_json::Value {
    json!({
        "mode": "oracle",
        "result": "65000.12345678",
        "extracted_value": "65000.12345678",
        "price": "65000.12345678",
        "symbol": "BTC/USD",
        "decimals": 8,
        "timestamp": 1718352000,
        "sources": ["twelvedata"],
        "verification": {
            "output_hash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "attestation_hash": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "signature": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
            "public_key": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
            "signer_address": "NTEST",
            "signer_script_hash": "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        },
    })
}
const FIXED_VRF_RANDOMNESS: &str =
    "1111111111111111111111111111111111111111111111111111111111111111";
const GOLDEN_PUBLIC_KEY_RAW_B64: &str = "vAB/ripK5xzT1PT+KGbSvEEPfGQoxQliNWjSFjDfuhU=";
const GOLDEN_PRIVATE_KEY_PKCS8_B64: &str =
    "MC4CAQAwBQYDK2VuBCIEIEgdmKz6RqTG40pP8SVY+7XPGOUXAIbmI4alIH3uMYZ8";
const GOLDEN_ENVELOPE_JSON: &str = r#"{"v":2,"alg":"X25519-HKDF-SHA256-AES-256-GCM","epk":"1C44axNdzHDw2XVn2U7/uPmX+BfTgq9H4CltjiCRGWQ=","iv":"SOSWOZ3iY82CUNz6","ct":"x4/R3xIpzySVd55wSZFWh1HnCh7nmtYIAEhT","tag":"OUAJuhSWkVm/A0rWJSkFHQ=="}"#;

fn price_reply() -> BridgeReply {
    BridgeReply {
        ok: true,
        status: 200,
        body: fixed_price_body(),
    }
}

fn vrf_reply() -> BridgeReply {
    BridgeReply {
        ok: true,
        status: 200,
        body: json!({ "request_id": "1", "randomness": FIXED_VRF_RANDOMNESS }),
    }
}

fn fulfill_harness(reply: BridgeReply) -> TestState {
    let harness = test_state(
        &healthy_overlay(),
        FakeAttest::with_document(b"doc"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::default(),
    );
    harness.bridge.set_reply(reply);
    harness
}

fn use_production_compute(harness: &mut TestState) {
    harness.state.fulfillment_compute_override = None;
}

fn golden_key_env() -> String {
    format!(
        r#"{{"algorithm":"X25519-HKDF-SHA256","public_key_raw":"{GOLDEN_PUBLIC_KEY_RAW_B64}","private_key_pkcs8":"{GOLDEN_PRIVATE_KEY_PKCS8_B64}"}}"#
    )
}

fn price_body_without_binding() -> serde_json::Value {
    json!({
        "chain": "neo_n3",
        "request_type": "oracle_query",
        "request_id": "4242",
        "payload_text": "",
        "payload": { "symbol": "BTC/USD", "requester": format!("0x{}", "aa".repeat(20)) },
        "fulfillment_context": {},
        "nonce": "",
    })
}

#[test]
fn neo_n3_with_app_id_digest_envelope_and_signature_byte_exact() {
    let harness = fulfill_harness(price_reply());
    let intent = resolve_kernel_intent("oracle_query");
    let body = json!({
        "chain": "neo_n3",
        "request_type": "oracle_query",
        "request_id": "4242",
        "payload_text": "",
        "payload": { "symbol": "BTC/USD", "requester": format!("0x{}", "aa".repeat(20)) },
        "fulfillment_context": {
            "app_id": "demo.app",
            "module_id": intent.module_id,
            "operation": intent.operation,
            "contract_script_hash": measured_n3_oracle_contract(TEST_NETWORK).expect("reviewed test network"),
            "network_magic": 894710606,
        },
        "nonce": "deadbeef",
    });

    let response = handle_oracle_fulfill(&harness.state, &body).expect("fulfillment");
    assert_eq!(response["status"], "ok");
    assert_eq!(response["trust_tier"], "enclave-attested");
    assert_eq!(response["success"], true);
    assert_eq!(response["nonce"], "deadbeef");

    // Independently recompute from the SAME worker reply the fake returned.
    let worker_response = JsValue::from_json(&json!({
        "ok": true, "status": 200, "body": fixed_price_body(),
    }));
    let fulfillment = encode_fulfillment_result("oracle_query", &worker_response).expect("encode");
    let expected_envelope = build_onchain_result_envelope("oracle_query", &worker_response, None);
    let options = FulfillmentOptions {
        chain: Some("neo_n3".to_string()),
        app_id: "demo.app".to_string(),
        module_id: intent.module_id.to_string(),
        operation: intent.operation.to_string(),
        contract_script_hash: measured_n3_oracle_contract(TEST_NETWORK)
            .expect("reviewed test network")
            .to_string(),
        network_magic: Some(894710606.0),
        ..FulfillmentOptions::default()
    };
    let expected_digest = build_fulfillment_digest_bytes(
        &JsValue::Str("4242".to_string()),
        "oracle_query",
        fulfillment.success,
        &fulfillment.result,
        &fulfillment.error,
        fulfillment.result_bytes_base64.as_deref().unwrap_or(""),
        &options,
    )
    .expect("digest");

    // Byte-exactness: fold digest === independently-recomputed canonical digest.
    assert_eq!(
        response["fulfillment_digest_hex"],
        hex::encode(expected_digest)
    );
    // Result + envelope match the canonical encoding.
    assert_eq!(response["result"], fulfillment.result);
    assert_eq!(
        response["verification"],
        js_to_json(&JsValue::Object(expected_envelope))
    );
    // The signed failure nonce/freshness fields.
    assert_eq!(response["signature"], "00");
    assert_eq!(response["public_key"], intent_public_key());

    // Negative control: a digest WITHOUT the deployment binding (a common
    // re-derivation mistake) must NOT match — proving the fold actually
    // appended the contract script hash + network magic via the canonical
    // builder.
    let digest_no_binding = build_fulfillment_digest_bytes(
        &JsValue::Str("4242".to_string()),
        "oracle_query",
        fulfillment.success,
        &fulfillment.result,
        &fulfillment.error,
        fulfillment.result_bytes_base64.as_deref().unwrap_or(""),
        &FulfillmentOptions {
            chain: Some("neo_n3".to_string()),
            app_id: "demo.app".to_string(),
            module_id: intent.module_id.to_string(),
            operation: intent.operation.to_string(),
            contract_script_hash: String::new(),
            network_magic: None,
            ..FulfillmentOptions::default()
        },
    )
    .expect("digest");
    assert_ne!(
        response["fulfillment_digest_hex"],
        hex::encode(digest_no_binding)
    );
}

#[test]
fn neo_n3_refuses_parent_selected_contract_or_network_domain_before_signing() {
    for (field, value, expected) in [
        (
            "contract_script_hash",
            json!(format!("0x{}", "11".repeat(20))),
            "contract does not match measured testnet",
        ),
        (
            "network_magic",
            json!(860_833_102),
            "network magic does not match measured testnet",
        ),
    ] {
        let harness = fulfill_harness(price_reply());
        let mut body = price_body_without_binding();
        body["fulfillment_context"][field] = value;

        let error = handle_oracle_fulfill(&harness.state, &body).expect_err("foreign N3 domain");
        assert_eq!(error.status, 400);
        assert!(error.message.contains(expected), "{}", error.message);
        assert!(harness.signer.sign_calls().is_empty());
    }
}

#[test]
fn neox_fulfillment_uses_structured_verifier_custody_and_exposes_delivery_fields() {
    let harness = fulfill_harness(price_reply());
    let intent = resolve_kernel_intent("oracle_query");
    let oracle_contract = format!("0x{}", "22".repeat(20));
    let body = json!({
        "chain": "neox",
        "request_type": "oracle_query",
        "request_id": "4242",
        "payload_text": "",
        "payload": { "symbol": "BTC/USD", "requester": format!("0x{}", "aa".repeat(20)) },
        "fulfillment_context": {
            "app_id": "demo.app",
            "module_id": intent.module_id,
            "operation": intent.operation,
            "chain_id": 12_227_332,
            "oracle_contract": oracle_contract.clone(),
        },
        "nonce": "deadbeef",
    });

    let response = handle_oracle_fulfill(&harness.state, &body).expect("NeoX fulfillment");
    assert_eq!(response["status"], "ok");
    assert_eq!(response["chain"], "neox");
    assert_eq!(response["request_id"], "4242");
    assert_eq!(response["app_id"], "demo.app");
    assert_eq!(response["module_id"], intent.module_id);
    assert_eq!(response["operation"], intent.operation);
    assert_eq!(response["trust_tier"], "enclave-attested");
    assert_eq!(response["nonce"], "deadbeef");
    assert!(harness.signer.sign_calls().is_empty());

    let worker_response = JsValue::from_json(&json!({
        "ok": true, "status": 200, "body": fixed_price_body(),
    }));
    let encoded = encode_fulfillment_result("oracle_query", &worker_response).expect("encode");
    let result_bytes_hex = resolve_result_bytes_hex(
        &encoded.result,
        encoded.result_bytes_base64.as_deref().unwrap_or(""),
    );
    let expected = EvmFulfillment {
        request_id: "4242".to_string(),
        app_id: "demo.app".to_string(),
        module_id: intent.module_id.to_string(),
        operation: intent.operation.to_string(),
        payload: String::new(),
        success: true,
        error: String::new(),
    };
    let expected_digest = build_neox_digest(
        12_227_332,
        body["fulfillment_context"]["oracle_contract"]
            .as_str()
            .expect("contract"),
        &expected,
        &result_bytes_hex,
    )
    .expect("digest");
    assert_eq!(response["result"], encoded.result);
    assert_eq!(response["result_bytes_hex"], result_bytes_hex);
    assert_eq!(
        response["fulfillment_digest_hex"],
        format!("0x{}", hex::encode(expected_digest))
    );
    assert_eq!(
        response["signature"].as_str().expect("signature").len(),
        132
    );

    let calls = harness.signer.eip191_calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].network, TEST_NETWORK);
    assert_eq!(calls[0].role, "neox_verifier");
    assert_eq!(calls[0].chain_id, 12_227_332);
    assert_eq!(calls[0].oracle_contract, oracle_contract);
    assert_eq!(calls[0].fulfillment, expected);
    assert_eq!(calls[0].result_bytes_hex, result_bytes_hex);
    assert_eq!(
        calls[0].request_id,
        format!("neox-fulfill:{}", hex::encode(expected_digest))
    );
}

#[test]
fn migrated_compute_fulfillment_executes_in_process() {
    let mut harness = fulfill_harness(price_reply());
    use_production_compute(&mut harness);
    let body = json!({
        "chain": "neo_n3",
        "request_type": "compute_hash",
        "request_id": "101",
        "payload_text": "",
        "payload": {
            "function": "hash.sha256",
            "input": { "z": 1 },
        },
        "fulfillment_context": {},
    });

    let response = handle_oracle_fulfill(&harness.state, &body).expect("fulfillment");
    assert_eq!(response["status"], "ok");
    assert_eq!(response["success"], true);
    // Successful decryption reaches the canonical compact envelope. The
    // plaintext itself is deliberately not one of its on-chain fields.
    assert!(response["result"]
        .as_str()
        .expect("encoded compute result")
        .contains("hash.sha256"));
    assert!(harness.bridge.forwards().is_empty());
    // The compute result and the final fulfillment digest both cross custody.
    assert_eq!(harness.signer.sign_calls().len(), 2);
}

#[test]
fn session_finalize_fulfillment_uses_the_session_handler() {
    let mut harness = fulfill_harness(price_reply());
    use_production_compute(&mut harness);
    let body = json!({
        "chain": "neo_n3",
        "request_type": "session.finalize",
        "request_id": "901",
        "payload_text": "",
        "payload": {},
        "fulfillment_context": {},
    });

    let response = handle_oracle_fulfill(&harness.state, &body).expect("signed rejection");
    assert_eq!(response["status"], "ok");
    assert_eq!(response["success"], false);
    assert!(
        response["error"]
            .as_str()
            .expect("session error")
            .contains("SEALED_KIND_UNSUPPORTED"),
        "{response}"
    );
    assert!(harness.bridge.forwards().is_empty());
}

#[test]
fn automation_fulfillment_executes_the_nested_rust_handler() {
    let mut harness = fulfill_harness(price_reply());
    use_production_compute(&mut harness);
    let body = json!({
        "chain": "neo_n3",
        "request_type": "automation_execute",
        "request_id": "902",
        "payload_text": "",
        "payload": {
            "automation_id": "automation:fulfill:test",
            "idempotency_key": "automation-fulfill-test-902",
            "execution_request_type": "compute_hash",
            "execution_payload": {
                "function": "hash.sha256",
                "input": { "answer": 42 },
            },
        },
        "fulfillment_context": {},
    });

    let response = handle_oracle_fulfill(&harness.state, &body).expect("fulfillment");
    assert_eq!(response["status"], "ok");
    assert_eq!(response["success"], true);
    assert!(response["result"]
        .as_str()
        .expect("encoded automation result")
        .contains("automation"));
    assert!(harness.bridge.forwards().is_empty());
    assert_eq!(harness.signer.sign_calls().len(), 2);
}

/// SVC-E-1 (CL-19/CL-14). `resolve_kernel_intent` picks the lane by a
/// SUBSTRING match on the caller-chosen `operation` string, so anything
/// containing "feed" lands on `/oracle/feed` — a lane the intent table marks
/// `operator_only` and the retired Node relayer refused. The Rust port
/// dropped that enforcement entirely (`operator_only` had no consumer), so a
/// permissionless MiniApp could take the process-wide feed lock, spend the
/// operator's provider quota and rewrite shared feed state.
///
/// The refusal must stay a DETERMINISTIC UNSUCCESSFUL FULFILMENT — signed,
/// digest-bearing, `success: false` — and not an HTTP error, or the on-chain
/// request never settles and the fee is stranded. Before the fix this reached
/// the feed handler and answered with its background-executor refusal
/// instead; the direct `/oracle/feed` route still covers that path in
/// `tests/unit/oracle_feed.rs`.
#[test]
fn an_operator_only_feed_lane_is_refused_as_a_settleable_fulfillment() {
    let mut harness = fulfill_harness(price_reply());
    use_production_compute(&mut harness);
    let body = json!({
        "chain": "neo_n3",
        "request_type": "price_feed",
        "request_id": "903",
        "payload_text": "",
        "payload": { "symbol": "NEO-USD", "fast_ack": true },
        "fulfillment_context": {},
    });

    let response = handle_oracle_fulfill(&harness.state, &body).expect("signed rejection");
    assert_eq!(response["success"], false);
    assert_eq!(
        response["error"].as_str().expect("feed error"),
        crate::fulfill::OPERATOR_ONLY_REFUSAL,
    );
    // Settleable: the refusal is signed and carries a digest, so the chain
    // can close the request out exactly as a successful fulfilment would.
    assert!(response["fulfillment_digest_hex"]
        .as_str()
        .is_some_and(|digest| !digest.is_empty()));
    assert!(response["signature"]
        .as_str()
        .is_some_and(|signature| !signature.is_empty()));
    // No compute ran: the feed lock was never taken and no provider was paid.
    assert!(harness.bridge.forwards().is_empty());
}

/// The second half of SVC-E-1: the on-chain `moduleId` — the only identifier
/// the contract's grant check actually validates — was folded into the
/// fulfilment digest but never compared against the module the `operation`
/// string routes to. A caller could self-grant one cheap module and then name
/// an operation that reaches a different, privileged lane, with the on-chain
/// audit record showing the innocuous granted module.
#[test]
fn a_granted_module_that_disagrees_with_the_routed_lane_is_refused() {
    let mut harness = fulfill_harness(price_reply());
    use_production_compute(&mut harness);
    let body = json!({
        "chain": "neo_n3",
        "request_type": "compute_hash",
        "request_id": "904",
        "payload_text": "",
        "payload": { "function": "hash.sha256", "input": { "answer": 42 } },
        // The chain granted the cheap oracle.fetch module; the operation
        // string routes to compute.run.
        "fulfillment_context": { "module_id": "oracle.fetch" },
    });

    let error = handle_oracle_fulfill(&harness.state, &body).expect_err("module mismatch");
    assert_eq!(error.status, 400);
    assert!(error
        .message
        .contains("request operation does not match the granted module"));
    assert!(harness.bridge.forwards().is_empty());
}

/// The guard must not break the honest case: a context that names the module
/// the operation actually routes to still fulfils, and a context that names
/// no module at all keeps the pre-existing fallback onto the intent's module.
#[test]
fn a_matching_module_and_an_absent_module_both_still_fulfil() {
    let intent = resolve_kernel_intent("compute_hash");
    for context in [json!({ "module_id": intent.module_id }), json!({})] {
        let mut harness = fulfill_harness(price_reply());
        use_production_compute(&mut harness);
        let body = json!({
            "chain": "neo_n3",
            "request_type": "compute_hash",
            "request_id": "905",
            "payload_text": "",
        "payload": { "function": "hash.sha256", "input": { "answer": 42 } },
            "fulfillment_context": context,
        });

        let response = handle_oracle_fulfill(&harness.state, &body).expect("fulfillment");
        assert_eq!(response["success"], true, "context {context}");
    }
}

#[test]
fn migrated_decrypt_fulfillment_executes_in_process() {
    let key_env = golden_key_env();
    let mut harness = test_state(
        &[
            ("MORPHEUS_NETWORK", TEST_NETWORK),
            ("NITRO_API_TOKEN", "s3cret"),
            ("MORPHEUS_ORACLE_KEY_MATERIAL_JSON", key_env.as_str()),
            ("MORPHEUS_ORACLE_DECRYPT_REQUIRE_BINDING", "0"),
        ],
        FakeAttest::with_document(b"doc"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::default(),
    );
    use_production_compute(&mut harness);
    let body = json!({
        "chain": "neo_n3",
        "request_type": "decrypt",
        "request_id": "102",
        "payload_text": "",
        "payload": {
            "envelope": base64::engine::general_purpose::STANDARD.encode(GOLDEN_ENVELOPE_JSON),
        },
        "fulfillment_context": {},
    });

    let response = handle_oracle_fulfill(&harness.state, &body).expect("fulfillment");
    assert_eq!(response["status"], "ok");
    assert_eq!(response["success"], true);
    assert!(response["result"]
        .as_str()
        .expect("encoded decrypt result")
        .contains(r#""request_type":"decrypt""#));
    assert!(harness.bridge.forwards().is_empty());
}

#[test]
fn random_fulfillment_executes_in_process_without_a_bridge() {
    let mut harness = fulfill_harness(vrf_reply());
    use_production_compute(&mut harness);
    harness
        .state
        .overlay
        .write()
        .expect("overlay lock")
        .set_game_secret_root(&"11".repeat(32));
    let body = json!({
        "chain": "neo_n3",
        "request_type": "random",
        "request_id": "103",
        "payload_text": "",
        "payload": {},
        // The VRF lane binds the oracle contract the relayer names.
        "fulfillment_context": { "contract_script_hash": N3_TESTNET_ORACLE_CONTRACT },
    });

    let response = handle_oracle_fulfill(&harness.state, &body).expect("signed fulfillment");
    assert_eq!(response["status"], "ok");
    assert_eq!(response["success"], true);
    assert!(response["error"].as_str().unwrap_or_default().is_empty());
    assert_eq!(response["result"], "");
    let callback = base64::engine::general_purpose::STANDARD
        .decode(
            response["result_bytes_base64"]
                .as_str()
                .expect("compact random result"),
        )
        .expect("base64 callback");
    assert_eq!(callback.len(), 32);
    assert!(harness.bridge.forwards().is_empty());
}

#[test]
fn fulfillment_digest_binds_the_exact_request_payload() {
    let mut body_a = price_body_without_binding();
    body_a["payload_text"] = json!("{\"op\":\"add\"}");
    let mut body_b = body_a.clone();
    body_b["payload_text"] = json!("{\"op\":\"sub\"}");
    let response_a = handle_oracle_fulfill(&fulfill_harness(price_reply()).state, &body_a)
        .expect("first payload");
    let response_b = handle_oracle_fulfill(&fulfill_harness(price_reply()).state, &body_b)
        .expect("second payload");
    assert_ne!(
        response_a["fulfillment_digest_hex"],
        response_b["fulfillment_digest_hex"]
    );
}

#[test]
fn inconsistent_payload_hex_and_text_are_refused_before_signing() {
    let harness = fulfill_harness(price_reply());
    let mut body = price_body_without_binding();
    body["payload_text"] = json!("");
    body["payload_hex"] = json!("00");
    let error = handle_oracle_fulfill(&harness.state, &body).expect_err("payload mismatch");
    assert_eq!(error.status, 400);
    assert!(error.message.contains("does not match"));
    assert!(harness.signer.sign_calls().is_empty());
}

fn intent_public_key() -> serde_json::Value {
    json!("02f8a5a1e0f3b6c9d2e5f8a1b4c7d0e3f6a9b2c5d8e1f4a7b0c3d6e9f2a5b8c1")
}

#[test]
fn legacy_no_app_id_uses_the_legacy_domain() {
    let harness = fulfill_harness(price_reply());
    let body = price_body_without_binding();
    let mut body = body.clone();
    body["chain"] = json!("legacy");

    let response = handle_oracle_fulfill(&harness.state, &body).expect("fulfillment");
    assert_eq!(response["trust_tier"], "enclave-attested");

    let worker_response =
        JsValue::from_json(&json!({ "ok": true, "status": 200, "body": fixed_price_body() }));
    let fulfillment = encode_fulfillment_result("oracle_query", &worker_response).expect("encode");
    let expected_envelope = build_onchain_result_envelope("oracle_query", &worker_response, None);
    let expected_digest = build_fulfillment_digest_bytes(
        &JsValue::Str("4242".to_string()),
        "oracle_query",
        fulfillment.success,
        &fulfillment.result,
        &fulfillment.error,
        fulfillment.result_bytes_base64.as_deref().unwrap_or(""),
        &FulfillmentOptions {
            chain: Some("legacy".to_string()),
            contract_script_hash: measured_n3_oracle_contract(TEST_NETWORK)
                .expect("reviewed test network")
                .to_string(),
            network_magic: Some(f64::from(
                measured_n3_magic(TEST_NETWORK).expect("reviewed test network"),
            )),
            ..FulfillmentOptions::default()
        },
    )
    .expect("digest");
    assert_eq!(
        response["fulfillment_digest_hex"],
        hex::encode(expected_digest)
    );
    assert_eq!(
        response["verification"],
        js_to_json(&JsValue::Object(expected_envelope))
    );
}

#[test]
fn vrf_compact_lane_returns_the_callback_bytes() {
    let harness = fulfill_harness(vrf_reply());
    let intent = resolve_kernel_intent("random");
    let body = json!({
        "chain": "neo_n3",
        "request_type": "random",
        "request_id": "99",
        "payload_text": "",
        "payload": {},
        "fulfillment_context": {
            "app_id": "dice.app",
            "module_id": intent.module_id,
            "operation": intent.operation,
            "contract_script_hash": measured_n3_oracle_contract(TEST_NETWORK).expect("reviewed test network"),
            "network_magic": 894710606,
        },
    });

    let response = handle_oracle_fulfill(&harness.state, &body).expect("fulfillment");
    // VRF -> compact 32-byte randomness as result_bytes_base64, empty result.
    assert_eq!(response["result"], "");
    let compact = response["result_bytes_base64"]
        .as_str()
        .expect("compact bytes");
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(compact)
        .expect("base64");
    assert_eq!(hex::encode(decoded), FIXED_VRF_RANDOMNESS);

    // The digest binds the compact bytes, not the empty result string.
    let worker_response = JsValue::from_json(&json!({
        "ok": true, "status": 200, "body": { "request_id": "1", "randomness": FIXED_VRF_RANDOMNESS },
    }));
    let fulfillment = encode_fulfillment_result("random", &worker_response).expect("encode");
    let options = FulfillmentOptions {
        chain: Some("neo_n3".to_string()),
        app_id: "dice.app".to_string(),
        module_id: intent.module_id.to_string(),
        operation: intent.operation.to_string(),
        contract_script_hash: measured_n3_oracle_contract(TEST_NETWORK)
            .expect("reviewed test network")
            .to_string(),
        network_magic: Some(894710606.0),
        ..FulfillmentOptions::default()
    };
    let expected_digest = build_fulfillment_digest_bytes(
        &JsValue::Str("99".to_string()),
        "random",
        fulfillment.success,
        &fulfillment.result,
        &fulfillment.error,
        fulfillment.result_bytes_base64.as_deref().unwrap_or(""),
        &options,
    )
    .expect("digest");
    assert_eq!(
        response["fulfillment_digest_hex"],
        hex::encode(expected_digest)
    );
}

#[test]
fn arbitrary_url_smart_fetch_is_host_unattested() {
    let harness = fulfill_harness(price_reply());
    let body = json!({
        "chain": "neo_n3",
        "request_type": "privacy_oracle",
        "request_id": "7",
        "payload_text": "",
        "payload": { "url": "https://example.com/price" },
        "fulfillment_context": {},
    });

    let response = handle_oracle_fulfill(&harness.state, &body).expect("host-unattested");
    assert_eq!(
        response,
        json!({
            "status": "host-unattested",
            "success": false,
            "result": "",
            "error": "arbitrary-url fetch is host-tier (not attested in-enclave)",
            "signature": null,
            "public_key": null,
            "fulfillment_digest_hex": null,
            "verification": null,
            "trust_tier": "host-unattested",
        })
    );
    // Nothing was computed and nothing was signed.
    assert!(harness.bridge.forwards().is_empty());
    assert!(harness.signer.sign_calls().is_empty());
}

#[test]
fn neox_invalid_contract_never_reaches_any_signing_surface() {
    let harness = fulfill_harness(price_reply());
    let body = json!({
        "chain": "neox",
        "request_type": "oracle_query",
        "request_id": "1",
        "payload_text": "",
        "payload": {},
        "fulfillment_context": { "chain_id": 1868, "oracle_contract": "0xabc" },
    });

    let error = handle_oracle_fulfill(&harness.state, &body).expect_err("invalid contract");
    assert_eq!(error.status, 400);
    assert!(error.message.contains("invalid oracle contract address"));
    assert!(harness.signer.sign_calls().is_empty());
    assert!(harness.signer.eip191_calls().is_empty());
}

#[test]
fn a_deterministic_business_rejection_encodes_as_an_unsuccessful_fulfillment() {
    let harness = fulfill_harness(BridgeReply {
        ok: false,
        status: 422,
        body: json!({ "error": "boom" }),
    });
    let body = price_body_without_binding();

    let response = handle_oracle_fulfill(&harness.state, &body).expect("signed failure");
    assert_eq!(response["status"], "ok");
    assert_eq!(response["success"], false);
    assert_eq!(response["result"], "");
    assert_eq!(response["error"], "boom");
    // The failure digest is still signed + attested — the on-chain contract
    // records unsuccessful fulfillments through the same path.
    assert_ne!(response["fulfillment_digest_hex"], serde_json::Value::Null);
    assert_eq!(response["signature"], "00");
}

#[test]
fn transient_compute_failures_are_never_signed_as_permanent_fulfillments() {
    for status in [408, 425, 429, 500, 502, 503, 504, 508, 599] {
        let harness = fulfill_harness(BridgeReply {
            ok: false,
            status,
            body: json!({ "error": "try again" }),
        });

        let error = handle_oracle_fulfill(&harness.state, &price_body_without_binding())
            .expect_err("transient compute failure must remain retryable");

        assert_eq!(error.status, status);
        assert!(error.message.contains("transient compute failure"));
        assert!(harness.signer.sign_calls().is_empty());
    }
}

#[test]
fn the_decrypt_lane_forwards_the_envelope() {
    let harness = fulfill_harness(price_reply());
    let body = json!({
        "chain": "neo_n3",
        "request_type": "decrypt",
        "request_id": "8",
        "payload_text": "",
        "payload": { "envelope": " sealed-envelope " },
        "fulfillment_context": {},
    });

    let response = handle_oracle_fulfill(&harness.state, &body).expect("fulfillment");
    assert_eq!(response["status"], "ok");
    let forwards = harness.bridge.forwards();
    assert_eq!(forwards.len(), 1);
    assert_eq!(forwards[0].0, "/oracle/decrypt");
    // The envelope was trimmed and merged over the payload.
    assert_eq!(forwards[0].1["envelope"], "sealed-envelope");
}

#[test]
fn the_response_binds_an_attestation_document() {
    let harness = fulfill_harness(price_reply());
    let mut body = price_body_without_binding();
    body["nonce"] = json!("deadbeef");

    let response = handle_oracle_fulfill(&harness.state, &body).expect("fulfillment");
    assert_eq!(
        response["attestation_doc_base64"],
        base64::engine::general_purpose::STANDARD.encode(b"doc")
    );
    // The NSM seam committed user_data = sha256(the EXACT digest bytes).
    let digest_bytes = hex::decode(response["fulfillment_digest_hex"].as_str().expect("digest"))
        .expect("hex digest");
    let expected_user_data: [u8; 32] = {
        use sha2::{Digest, Sha256};
        Sha256::digest(&digest_bytes).into()
    };
    let calls = harness.attest.calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].user_data.as_deref(), Some(&expected_user_data[..]));
    assert_eq!(
        calls[0].nonce.as_deref(),
        Some(&[0xde, 0xad, 0xbe, 0xef][..])
    );
    // And the response carries the same binding for the relayer to verify.
    assert_eq!(
        response["attestation_user_data_hex"],
        hex::encode(expected_user_data)
    );
    assert_eq!(
        calls[0].public_key.as_deref(),
        Some(intent_public_key_hex().as_slice())
    );
}

fn intent_public_key_hex() -> Vec<u8> {
    hex::decode(intent_public_key().as_str().expect("public key")).expect("hex key")
}

#[test]
fn fulfillment_still_signs_when_attestation_is_unavailable() {
    let harness = test_state(
        &healthy_overlay(),
        FakeAttest::failing("nsm: this platform does not support NSM"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::default(),
    );
    harness.bridge.set_reply(price_reply());
    let body = price_body_without_binding();

    let response = handle_oracle_fulfill(&harness.state, &body).expect("fulfillment");
    // The signature path still returned; the relayer downgrades trust.
    assert_eq!(response["trust_tier"], "enclave-attested");
    assert_eq!(response["signature"], "00");
    assert_eq!(response.get("attestation_doc_base64"), None);
    // The fold records the attestation route's own error text (the mjs's
    // `String(error.message)` of the httpError(503) the helper threw).
    assert_eq!(
        response["attestation_error"],
        "nsm attestation helper failed: nsm: this platform does not support NSM"
    );
}

#[test]
fn missing_request_fields_are_400s_before_any_compute() {
    let harness = fulfill_harness(price_reply());
    let missing_type = json!({ "request_id": "1", "payload": {} });
    let error = handle_oracle_fulfill(&harness.state, &missing_type).expect_err("no type");
    assert_eq!(error.status, 400);
    assert_eq!(error.message, "request_type is required");

    let missing_id = json!({ "request_type": "oracle_query", "payload": {} });
    let error = handle_oracle_fulfill(&harness.state, &missing_id).expect_err("no id");
    assert_eq!(error.status, 400);
    assert_eq!(error.message, "request_id is required");
    assert!(harness.bridge.forwards().is_empty());
}

#[test]
fn measured_n3_identity_rejects_unknown_network_without_testnet_fallback() {
    assert!(measured_n3_oracle_contract("staging").is_err());
    assert!(measured_n3_magic("staging").is_err());
}

// ---------------------------------------------------------------------------
// CU-87: the test-only measured-contract override.
//
// A kernel deployed fresh on a private chain has its own script hash, so the
// compiled-in measured binding refuses every fulfilment against it. The
// override names that kernel for tests. It is refused in production, refused on
// mainnet, refused when malformed, and it never lets the request choose the
// value: the supplied contract must still equal the resolved expected hash.
// ---------------------------------------------------------------------------

/// A kernel deployed fresh on a private chain: a different script hash from the
/// compiled-in measured one.
const FRESH_KERNEL_CONTRACT: &str = "0x5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a";
const OTHER_FRESH_KERNEL_CONTRACT: &str = "0x6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b";

fn override_harness(extra: &[(&str, &str)], reply: BridgeReply) -> TestState {
    let mut overlay = healthy_overlay();
    overlay.extend_from_slice(extra);
    let harness = test_state(
        &overlay,
        FakeAttest::with_document(b"doc"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::default(),
    );
    harness.bridge.set_reply(reply);
    harness
}

fn override_env() -> [(&'static str, &'static str); 1] {
    [(
        "MORPHEUS_TEST_MEASURED_ORACLE_CONTRACT_OVERRIDE",
        FRESH_KERNEL_CONTRACT,
    )]
}

fn bound_body(contract: &str) -> serde_json::Value {
    let mut body = price_body_without_binding();
    body["fulfillment_context"]["contract_script_hash"] = json!(contract);
    body["fulfillment_context"]["network_magic"] = json!(894710606);
    body
}

#[test]
fn fresh_kernel_fulfils_when_the_test_override_names_it() {
    let harness = override_harness(&override_env(), price_reply());
    let body = bound_body(FRESH_KERNEL_CONTRACT);

    let response = handle_oracle_fulfill(&harness.state, &body).expect("fresh kernel fulfilment");
    assert_eq!(response["status"], "ok");
    assert_eq!(response["success"], true);

    // The digest binds the FRESH kernel, not the compiled-in measured one:
    // an independent recomputation over the override hash must match byte for
    // byte, and the measured-hash digest must not.
    let worker_response =
        JsValue::from_json(&json!({ "ok": true, "status": 200, "body": fixed_price_body() }));
    let fulfillment = encode_fulfillment_result("oracle_query", &worker_response).expect("encode");
    let intent = resolve_kernel_intent("oracle_query");
    let options_for = |contract: &str| FulfillmentOptions {
        chain: Some("neo_n3".to_string()),
        app_id: String::new(),
        module_id: intent.module_id.to_string(),
        operation: intent.operation.to_string(),
        contract_script_hash: contract.to_string(),
        network_magic: Some(894710606.0),
        ..FulfillmentOptions::default()
    };
    let digest_for = |contract: &str| {
        hex::encode(
            build_fulfillment_digest_bytes(
                &JsValue::Str("4242".to_string()),
                "oracle_query",
                fulfillment.success,
                &fulfillment.result,
                &fulfillment.error,
                fulfillment.result_bytes_base64.as_deref().unwrap_or(""),
                &options_for(contract),
            )
            .expect("digest"),
        )
    };
    assert_eq!(
        response["fulfillment_digest_hex"],
        digest_for(FRESH_KERNEL_CONTRACT)
    );
    assert_ne!(
        response["fulfillment_digest_hex"],
        digest_for(measured_n3_oracle_contract(TEST_NETWORK).expect("reviewed test network"))
    );
}

#[test]
fn test_override_is_refused_in_production_before_signing() {
    for node_env in ["production", " PrOdUcTiOn "] {
        let overlay = [("NODE_ENV", node_env), override_env()[0]];
        let harness = override_harness(&overlay, price_reply());
        let error = handle_oracle_fulfill(&harness.state, &bound_body(FRESH_KERNEL_CONTRACT))
            .expect_err("production refuses the override");
        assert_eq!(error.status, 503);
        assert_eq!(
            error.message,
            "MORPHEUS_TEST_MEASURED_ORACLE_CONTRACT_OVERRIDE is not allowed when NODE_ENV=production"
        );
        // Nothing signed. The N3 binding is resolved in the digest phase, which
        // runs after compute — the order the measured binding has always had, so
        // this asserts the invariant that matters and no more.
        assert!(harness.signer.sign_calls().is_empty());
    }
}

#[test]
fn test_override_must_be_a_script_hash() {
    for bad in [
        "0x1234",
        "0x5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a",
        "0xzzzz5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a",
        "not-a-hash",
    ] {
        let harness = override_harness(
            &[("MORPHEUS_TEST_MEASURED_ORACLE_CONTRACT_OVERRIDE", bad)],
            price_reply(),
        );
        let error = handle_oracle_fulfill(&harness.state, &bound_body(FRESH_KERNEL_CONTRACT))
            .expect_err("malformed override");
        assert_eq!(error.status, 503, "{bad}");
        assert_eq!(
            error.message,
            "MORPHEUS_TEST_MEASURED_ORACLE_CONTRACT_OVERRIDE must be a 20-byte hex script hash",
            "{bad}"
        );
        assert!(harness.signer.sign_calls().is_empty(), "{bad}");
    }
}

#[test]
fn test_override_is_refused_on_mainnet() {
    let mut overlay = vec![("MORPHEUS_NETWORK", "mainnet")];
    overlay.extend_from_slice(&override_env());
    let harness = override_harness(&overlay, price_reply());
    let error = handle_oracle_fulfill(&harness.state, &bound_body(FRESH_KERNEL_CONTRACT))
        .expect_err("mainnet refuses the override");
    assert_eq!(error.status, 503);
    assert_eq!(
        error.message,
        "MORPHEUS_TEST_MEASURED_ORACLE_CONTRACT_OVERRIDE is refused on mainnet"
    );
    assert!(harness.signer.sign_calls().is_empty());
}

#[test]
fn test_override_still_requires_the_supplied_contract_to_match() {
    let harness = override_harness(&override_env(), price_reply());
    // The override names kernel A; the request names kernel B. The override
    // widens the expected value, it does not disable the comparison.
    let error = handle_oracle_fulfill(&harness.state, &bound_body(OTHER_FRESH_KERNEL_CONTRACT))
        .expect_err("foreign fresh kernel");
    assert_eq!(error.status, 400);
    assert!(
        error
            .message
            .contains("contract does not match measured testnet"),
        "{}",
        error.message
    );
    assert!(harness.signer.sign_calls().is_empty());
}

#[test]
fn default_configuration_binds_the_measured_contract() {
    // No flag: the measured constant still binds and a fresh kernel is refused.
    let harness = fulfill_harness(price_reply());
    let error = handle_oracle_fulfill(&harness.state, &bound_body(FRESH_KERNEL_CONTRACT))
        .expect_err("measured binding is unchanged by default");
    assert_eq!(error.status, 400);
    assert!(
        error
            .message
            .contains("contract does not match measured testnet"),
        "{}",
        error.message
    );
    assert!(harness.signer.sign_calls().is_empty());
}

#[path = "private_chain.rs"]
mod private_chain;
