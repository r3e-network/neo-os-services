//! Attestation tests — the binding contract from the mjs fixtures
//! (enclave-server.test.mjs ~911-993): alias resolution, the even-hex
//! validation, the sha256 user_data commitment, the role default and the
//! best-effort PCR extraction. The NSM source is the support double.

use super::*;
use base64::engine::general_purpose::STANDARD as BASE64;
use sha2::{Digest, Sha256};

#[path = "support.rs"]
#[allow(clippy::duplicate_mod)] // intentional: one shared doubles file per test module
mod support;
use support::*;

/// A minimal COSE_Sign1: [protected: b'', unprotected: {}, payload: <cbor map>,
/// sig: b''] with payload map {pcrs: {0: <bytes>}}.
fn cose_sign1_with_pcr0(pcr0: &[u8]) -> Vec<u8> {
    // payload map: { "pcrs": { 0: bytes } } — hand-encoded, matching the
    // NSM document shape neo-os-core's cbor reader decodes.
    let mut payload = vec![0xA1]; // map(1)
    payload.push(0x64); // text(4)
    payload.extend_from_slice(b"pcrs");
    payload.push(0xA1); // map(1)
    payload.push(0x00); // unsigned(0)
    if pcr0.len() < 24 {
        payload.push(0x40 + pcr0.len() as u8);
    } else {
        payload.push(0x58); // bytes, one-byte length follows
        payload.push(pcr0.len() as u8);
    }
    payload.extend_from_slice(pcr0);

    let mut doc = vec![0x84]; // array(4)
    doc.push(0x40); // protected: b''
    doc.push(0xA0); // unprotected: {} — element 1 is a map, not a bstr
    if payload.len() < 24 {
        doc.push(0x40 + payload.len() as u8);
    } else {
        doc.push(0x58); // bytes, one-byte length follows
        doc.push(payload.len() as u8);
    }
    doc.extend_from_slice(&payload);
    doc.push(0x40); // signature: b''
    doc
}

#[test]
fn normalize_hex_strips_the_0x_prefix_and_lowercases() {
    assert_eq!(normalize_hex("  0xABCD  "), "abcd");
    assert_eq!(normalize_hex("0XABCD"), "abcd");
    assert_eq!(normalize_hex("AbCd"), "abcd");
    assert_eq!(normalize_hex(""), "");
}

#[test]
fn the_user_data_is_sha256_of_the_binding_bytes() {
    // Byte-exact expectation, the same shape the mjs fixtures pin.
    let binding = "00";
    let expected = hex::encode(Sha256::digest([0x00]));
    let harness = test_state(
        &healthy_overlay(),
        FakeAttest::with_document(b"doc"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::default(),
    );
    let response = handle_attestation(
        &harness.state,
        &serde_json::json!({ "fulfillment_digest_hex": binding }),
    )
    .expect("attestation");
    assert_eq!(response["user_data_hex"], expected);
    let calls = harness.attest.calls();
    // The NSM seam carries the raw 32 digest bytes (the mjs CLI helper decoded
    // its --user-data hex argument before the ioctl).
    assert_eq!(calls[0].user_data.as_ref().map(hex::encode), Some(expected));
    // No nonce → no report_data binding.
    assert_eq!(calls[0].nonce, None);
}

#[test]
fn the_alias_chain_prefers_the_first_truthy_member() {
    let harness = test_state(
        &healthy_overlay(),
        FakeAttest::with_document(b"doc"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::default(),
    );
    let response = handle_attestation(
        &harness.state,
        &serde_json::json!({
            "fulfillment_digest_hex": "01",
            "fulfillment_digest": "02",
            "tx_message_hex": "03",
            "user_data": "04",
        }),
    )
    .expect("attestation");
    let expected = hex::encode(Sha256::digest([0x01]));
    assert_eq!(response["user_data_hex"], expected);

    // Falling through when the earlier alias is absent.
    let response = handle_attestation(
        &harness.state,
        &serde_json::json!({ "tx_message": "0x0303" }),
    )
    .expect("attestation");
    assert_eq!(
        response["user_data_hex"],
        hex::encode(Sha256::digest([0x03, 0x03]))
    );
}

#[test]
fn a_truthy_non_string_alias_shadows_the_chain_like_javascript() {
    // JS: `payload.fulfillment_digest_hex || payload.user_data` picks a
    // truthy NUMBER and normalizeHex collapses it to '' — no digest at all,
    // NOT a fallthrough to the later alias.
    let harness = test_state(
        &healthy_overlay(),
        FakeAttest::with_document(b"doc"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::default(),
    );
    let response = handle_attestation(
        &harness.state,
        &serde_json::json!({ "fulfillment_digest_hex": 7, "user_data": "aabb" }),
    )
    .expect("attestation");
    assert_eq!(response["user_data_hex"], serde_json::Value::Null);
    assert!(harness.attest.calls()[0].user_data.is_none());
}

#[test]
fn the_nonce_and_the_binding_are_validated_separately_in_order() {
    let harness = test_state(
        &healthy_overlay(),
        FakeAttest::with_document(b"doc"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::default(),
    );
    // Both bad → the nonce error wins (validation order).
    let error = handle_attestation(
        &harness.state,
        &serde_json::json!({ "nonce": "abc", "user_data": "zz" }),
    )
    .expect_err("odd nonce");
    assert_eq!(error.status, 400);
    assert_eq!(error.message, "nonce must be even-length hex");

    let error = handle_attestation(
        &harness.state,
        &serde_json::json!({ "nonce": "aabb", "user_data": "xyz" }),
    )
    .expect_err("non-hex binding");
    assert_eq!(
        error.message,
        "binding (digest/tx_message/user_data) must be even-length hex"
    );
}

#[test]
fn a_liveness_probe_binds_nothing() {
    let harness = test_state(
        &healthy_overlay(),
        FakeAttest::with_document(b"doc"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::default(),
    );
    let response =
        handle_attestation(&harness.state, &serde_json::json!({})).expect("liveness attestation");
    assert_eq!(response["user_data_hex"], serde_json::Value::Null);
    assert_eq!(response["nonce"], serde_json::Value::Null);
    let calls = harness.attest.calls();
    assert_eq!(calls[0].user_data, None);
    assert_eq!(calls[0].nonce, None);
}

#[test]
fn the_role_defaults_to_the_oracle_verifier_and_accepts_updater() {
    let harness = test_state(
        &healthy_overlay(),
        FakeAttest::with_document(b"doc"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::default(),
    );
    let response = handle_attestation(&harness.state, &serde_json::json!({})).expect("attestation");
    assert_eq!(response["role"], "oracle_verifier");

    let response = handle_attestation(&harness.state, &serde_json::json!({ "role": " UPDATER " }))
        .expect("attestation");
    assert_eq!(response["role"], "updater");
}

#[test]
fn the_pinned_public_key_rides_the_document_request() {
    let harness = test_state(
        &healthy_overlay(),
        FakeAttest::with_document(b"doc"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::default(),
    );
    let response = handle_attestation(&harness.state, &serde_json::json!({})).expect("attestation");
    assert_eq!(
        response["public_key"],
        "02f8a5a1e0f3b6c9d2e5f8a1b4c7d0e3f6a9b2c5d8e1f4a7b0c3d6e9f2a5b8c1"
    );
    let calls = harness.attest.calls();
    assert!(calls[0].public_key.is_some());
}

#[test]
fn the_response_contract_and_its_key_order() {
    let harness = test_state(
        &healthy_overlay(),
        FakeAttest::with_document(&cose_sign1_with_pcr0(&[0x11; 48])),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::default(),
    );
    let response = handle_attestation(&harness.state, &serde_json::json!({ "nonce": "aabb" }))
        .expect("attestation");
    let serialized = serde_json::to_string(&response).expect("body");
    let prefix = r#"{"status":"ok","runtime":"morpheus-enclave-server","network":"testnet","role":"oracle_verifier","format":"cose-sign1-cbor-base64","#;
    assert!(serialized.starts_with(prefix), "{serialized}");
    // pcrs lands before trust_tier, both after the document.
    let pcr_position = serialized.find(r#""pcrs":{"pcr0":"#).expect("pcrs present");
    let tier_position = serialized
        .find(r#""trust_tier":"enclave-attested""#)
        .expect("tier");
    assert!(pcr_position < tier_position, "{serialized}");
    assert_eq!(response["pcrs"]["pcr0"], "11".repeat(48));
    assert_eq!(response["document_len"], serialized_len_of(&response));
}

fn serialized_len_of(response: &serde_json::Value) -> usize {
    let document = response["attestation_document"].as_str().expect("doc");
    BASE64.decode(document).expect("b64").len()
}

#[test]
fn an_unparseable_document_simply_omits_the_pcrs() {
    let harness = test_state(
        &healthy_overlay(),
        FakeAttest::with_document(b"not a cose document"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::default(),
    );
    let response = handle_attestation(&harness.state, &serde_json::json!({})).expect("attestation");
    assert!(response.get("pcrs").is_none(), "{}", response);
    assert_eq!(response["trust_tier"], "enclave-attested");
}

#[test]
fn a_failing_nsm_source_is_a_503_with_a_truncated_detail() {
    let long_error = "x".repeat(400);
    let harness = test_state(
        &healthy_overlay(),
        FakeAttest::failing(&long_error),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::default(),
    );
    let error =
        handle_attestation(&harness.state, &serde_json::json!({})).expect_err("nsm refused");
    assert_eq!(error.status, 503);
    let expected: String = format!("nsm attestation helper failed: {}", "x".repeat(300));
    assert_eq!(error.message, expected);
}
