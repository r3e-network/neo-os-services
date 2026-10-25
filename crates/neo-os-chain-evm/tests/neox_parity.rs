//! Digest parity tests against the ethers-harvested vectors
//! (`neox_digest.json`, 8 cases). Passing all of them proves the hand-written
//! ABI encoder + keccak256 produce byte-identical input to
//! `MorpheusOracleEVM.fulfillmentDigest` for every case shape the relayer
//! drives.

use neo_os_chain_evm::abi::{abi_decode_uint256_bytes, abi_encode, AbiValue};
use neo_os_chain_evm::{
    build_neox_digest, decode_confidential_envelope, decode_confidential_message_id,
    normalize_neox_revert, resolve_result_bytes_hex, Fulfillment,
};
use std::fs;

fn load_vectors() -> serde_json::Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/vectors/neox_digest.json"
    );
    serde_json::from_str(&fs::read_to_string(path).expect("vector file readable"))
        .expect("neox_digest.json is valid JSON")
}

#[test]
fn all_neox_digest_vectors_reproduce_the_ethers_output() {
    let vectors = load_vectors();
    let cases = vectors
        .get("cases")
        .and_then(serde_json::Value::as_array)
        .expect("cases array");
    assert!(!cases.is_empty());
    for case in cases {
        let kind = case
            .get("kind")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        if kind != "digest" {
            continue;
        }
        let name = case
            .get("name")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        let config = case.get("config").expect("config");
        let chain_id: u64 = config
            .pointer("/neox/chainId")
            .and_then(serde_json::Value::as_str)
            .and_then(|text| text.parse().ok())
            .expect("chainId");
        let oracle = config
            .pointer("/neox/oracleContract")
            .and_then(serde_json::Value::as_str)
            .expect("oracleContract");
        let fulfillment_json = case.get("fulfillment").expect("fulfillment");
        let string_field = |name: &str| -> String {
            fulfillment_json
                .get(name)
                .and_then(serde_json::Value::as_str)
                .unwrap_or("")
                .to_string()
        };
        let fulfillment = Fulfillment {
            request_id: string_field("requestId"),
            app_id: string_field("appId"),
            module_id: string_field("moduleId"),
            operation: string_field("operation"),
            payload: string_field("payloadHex"),
            success: fulfillment_json
                .get("success")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false),
            error: string_field("error"),
        };
        let result_bytes_hex = case
            .get("result_bytes_hex")
            .and_then(serde_json::Value::as_str)
            .expect("result_bytes_hex");
        let expected = case
            .get("expected")
            .and_then(serde_json::Value::as_str)
            .expect("expected");

        let digest = build_neox_digest(chain_id, oracle, &fulfillment, result_bytes_hex)
            .unwrap_or_else(|error| panic!("digest for {name} failed: {error}"));
        assert_eq!(
            format!(
                "0x{}",
                digest
                    .iter()
                    .map(|b| format!("{b:02x}"))
                    .collect::<String>()
            ),
            expected,
            "digest mismatch for case {name}"
        );
    }
}

#[test]
fn request_payload_changes_the_neox_digest_and_must_be_valid_hex() {
    let fulfillment = Fulfillment {
        request_id: "42".into(),
        app_id: "app:1".into(),
        module_id: "oracle.fetch".into(),
        operation: "privacy_oracle".into(),
        payload: "7b7d".into(),
        success: true,
        error: String::new(),
    };
    let digest_a = build_neox_digest(
        12_227_332,
        "0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B",
        &fulfillment,
        "0x01",
    )
    .expect("first payload");
    let mut changed = fulfillment.clone();
    changed.payload = "010203".into();
    let digest_b = build_neox_digest(
        12_227_332,
        "0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B",
        &changed,
        "0x01",
    )
    .expect("second payload");
    assert_ne!(digest_a, digest_b);
    changed.payload = "not-hex".into();
    assert!(build_neox_digest(
        12_227_332,
        "0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B",
        &changed,
        "0x01"
    )
    .is_err());
}

#[test]
fn resolve_result_bytes_hex_prefers_compact_bytes() {
    let vectors = load_vectors();
    let cases = vectors
        .get("cases")
        .and_then(serde_json::Value::as_array)
        .expect("cases array");
    for case in cases {
        let kind = case
            .get("kind")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        if kind != "resolve_result_bytes" {
            continue;
        }
        let result = case
            .get("result")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        let b64 = case
            .get("result_bytes_base64")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        let expected = case
            .get("expected")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        assert_eq!(resolve_result_bytes_hex(result, b64), expected);
    }
}

#[test]
fn revert_normalization_maps_the_kernel_vocabulary() {
    assert_eq!(
        normalize_neox_revert("RequestNotPending", ""),
        "request already fulfilled"
    );
    assert_eq!(
        normalize_neox_revert("BadSignature", "sig check failed"),
        "invalid signature: verifier rejected signature"
    );
    assert_eq!(
        normalize_neox_revert("NotUpdater", ""),
        "unauthorized: updater not set"
    );
    // Unmapped reverts pass the reason through.
    assert_eq!(normalize_neox_revert("", "gas issue"), "gas issue");
}

#[test]
fn confidential_decoders_recover_envelope_and_message_id() {
    // abi.encode(uint256(7), bytes('{"v":1}')) harvested from ethers:
    let encoded = abi_encode(&[
        AbiValue::Uint256({
            let mut word = [0u8; 32];
            word[31] = 7;
            word
        }),
        AbiValue::Bytes(b"{\"v\":1}".to_vec()),
    ])
    .expect("encode");
    let payload_hex: String = encoded.iter().map(|b| format!("{b:02x}")).collect();

    assert_eq!(decode_confidential_envelope(&payload_hex), "{\"v\":1}");
    assert_eq!(decode_confidential_message_id(&payload_hex), "7");

    // Non-wrapper payloads fall back to utf8/empty.
    assert_eq!(decode_confidential_envelope(""), "");
    assert_eq!(decode_confidential_message_id(""), "");
}

#[test]
fn abi_decode_uint256_bytes_round_trips() {
    let blob = abi_encode(&[
        AbiValue::Uint256([9u8; 32]),
        AbiValue::Bytes(vec![0xde, 0xad, 0xbe, 0xef]),
    ])
    .expect("encode");
    let (message_id, data) = abi_decode_uint256_bytes(&blob).expect("decode");
    assert_eq!(
        message_id,
        "0909090909090909090909090909090909090909090909090909090909090909"
    );
    assert_eq!(data, vec![0xde, 0xad, 0xbe, 0xef]);
}

#[test]
fn scanner_preserves_explicit_empty_payload_as_bytes_and_empty_text() {
    use neo_os_chain_evm::{build_event_from_request, decode_payload};
    let event = build_event_from_request(&serde_json::json!({
        "id": "1", "operation": "random.generate", "status": 1, "payload": "0x"
    }))
    .expect("pending request");
    assert_eq!(event.payload_hex, "0x");
    assert_eq!(event.payload_text, "");
    assert_eq!(decode_payload("0x"), "");
    assert_eq!(decode_payload("0xff"), "0xff");
    assert_eq!(decode_payload("0x0"), "0x0");
}

#[test]
fn scanner_does_not_turn_missing_payload_into_explicit_empty_bytes() {
    use neo_os_chain_evm::build_event_from_request;
    let missing = build_event_from_request(&serde_json::json!({
        "id": "1", "operation": "random.generate", "status": 1
    }))
    .expect("pending request");
    assert_eq!(missing.payload_hex, "");
    for value in [serde_json::Value::Null, serde_json::json!("")] {
        let event = build_event_from_request(&serde_json::json!({
            "id": "1", "operation": "random.generate", "status": 1, "payload": value
        }))
        .expect("pending request");
        assert_ne!(event.payload_hex, "0x");
    }
    let event = build_event_from_request(&serde_json::json!({
        "id": "1", "operation": "compute_hash", "status": 1, "payload": "0x7B7D"
    }))
    .expect("pending request");
    assert_eq!(event.payload_hex, "7b7d");
    assert_eq!(event.payload_text, "{}");
}
