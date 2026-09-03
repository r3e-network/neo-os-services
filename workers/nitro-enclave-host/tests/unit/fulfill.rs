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
use morpheus_core::digest::{build_fulfillment_digest_bytes, FulfillmentOptions};
use morpheus_core::envelope::{build_onchain_result_envelope, encode_fulfillment_result};
use morpheus_core::js_value::JsValue;
use morpheus_core::kernel::resolve_kernel_intent;
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
        "payload": { "symbol": "BTC/USD", "requester": format!("0x{}", "aa".repeat(20)) },
        "fulfillment_context": {
            "app_id": "demo.app",
            "module_id": intent.module_id,
            "operation": intent.operation,
            "contract_script_hash": format!("0x{}", "1f".repeat(20)),
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
        contract_script_hash: format!("0x{}", "1f".repeat(20)),
        network_magic: Some(894710606.0),
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
        },
    )
    .expect("digest");
    assert_ne!(
        response["fulfillment_digest_hex"],
        hex::encode(digest_no_binding)
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
fn an_unmigrated_fulfillment_lane_refuses_without_a_bridge() {
    let mut harness = fulfill_harness(vrf_reply());
    use_production_compute(&mut harness);
    let body = json!({
        "chain": "neo_n3",
        "request_type": "random",
        "request_id": "103",
        "payload": {},
        "fulfillment_context": {},
    });

    let response = handle_oracle_fulfill(&harness.state, &body).expect("signed refusal");
    assert_eq!(response["status"], "ok");
    assert_eq!(response["success"], false);
    assert_eq!(
        response["error"],
        "the /vrf/random fulfillment lane has not migrated to Rust"
    );
    assert!(harness.bridge.forwards().is_empty());
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
        "payload": {},
        "fulfillment_context": {
            "app_id": "dice.app",
            "module_id": intent.module_id,
            "operation": intent.operation,
            "contract_script_hash": format!("0x{}", "2c".repeat(20)),
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
        contract_script_hash: format!("0x{}", "2c".repeat(20)),
        network_magic: Some(894710606.0),
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
fn neox_fails_closed_before_any_compute() {
    let harness = fulfill_harness(price_reply());
    let body = json!({
        "chain": "neox",
        "request_type": "oracle_query",
        "request_id": "1",
        "payload": {},
        "fulfillment_context": { "chain_id": 1868, "oracle_contract": "0xabc" },
    });

    let error = handle_oracle_fulfill(&harness.state, &body).expect_err("neox refused");
    assert_eq!(error.status, 503);
    assert_eq!(
        error.message,
        "neox fulfillment signing is not available on the Rust enclave host"
    );
    // No compute ran: the EVM lane can never be signed on this host.
    assert!(harness.bridge.forwards().is_empty());
}

#[test]
fn a_failed_compute_encodes_as_an_unsuccessful_fulfillment() {
    let harness = fulfill_harness(BridgeReply {
        ok: false,
        status: 500,
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
fn the_decrypt_lane_forwards_the_envelope() {
    let harness = fulfill_harness(price_reply());
    let body = json!({
        "chain": "neo_n3",
        "request_type": "decrypt",
        "request_id": "8",
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
