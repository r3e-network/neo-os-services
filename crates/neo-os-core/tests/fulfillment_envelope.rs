mod common;

use common::{canonical, canonical_file, load_family, to_js};
use neo_os_core::envelope::{build_onchain_result_envelope, encode_fulfillment_result};
use neo_os_core::js_value::JsValue;
use serde_json::{json, Value};

#[test]
fn encoded_fulfillment_results_match_js_oracle() {
    for case in load_family("fulfillment_envelope") {
        let name = case["name"].as_str().unwrap_or("?");
        let request_type = case["request_type"].as_str().unwrap_or_default();
        let response = to_js(case.get("worker_response").expect("worker_response"));

        let encoded = encode_fulfillment_result(request_type, &response)
            .unwrap_or_else(|e| panic!("{name}: {e}"));

        let mut actual = serde_json::Map::new();
        actual.insert("success".into(), json!(encoded.success));
        actual.insert("result".into(), json!(encoded.result));
        if let Some(compact) = &encoded.result_bytes_base64 {
            actual.insert("result_bytes_base64".into(), json!(compact));
        }
        actual.insert("error".into(), json!(encoded.error));

        let expected = case.get("encoded").expect("encoded");
        // Every expected field must be present with the exact same value; the
        // result string is the digest-bound byte sequence, so this compare IS
        // the byte-parity gate.
        for (key, expected_value) in expected.as_object().expect("encoded object") {
            assert_eq!(actual.get(key), Some(expected_value), "{name}: field {key}");
        }
        assert_eq!(
            actual.len(),
            expected.as_object().unwrap().len(),
            "{name}: field set diverged (expected {expected}, got {actual:?})"
        );
    }
}

#[test]
fn onchain_envelopes_match_js_oracle() {
    for case in load_family("fulfillment_envelope") {
        let name = case["name"].as_str().unwrap_or("?");
        let request_type = case["request_type"].as_str().unwrap_or_default();
        let response = to_js(case.get("worker_response").expect("worker_response"));

        let envelope = build_onchain_result_envelope(request_type, &response, None);
        assert_eq!(
            canonical(&JsValue::Object(envelope)),
            canonical_file(case.get("envelope").expect("envelope")),
            "{name} envelope"
        );

        let tiered =
            build_onchain_result_envelope(request_type, &response, Some("enclave-attested"));
        assert_eq!(
            canonical(&JsValue::Object(tiered)),
            canonical_file(
                case.get("envelope_with_trust_tier")
                    .expect("envelope_with_trust_tier")
            ),
            "{name} tiered envelope"
        );
    }
}

/// The oversized-result lane is the one that exercises the trimming attempts;
/// make sure the selected envelope actually fits the 900-byte on-chain budget.
#[test]
fn trimmed_envelopes_respect_byte_budget() {
    for case in load_family("fulfillment_envelope") {
        let request_type = case["request_type"].as_str().unwrap_or_default();
        let response = to_js(case.get("worker_response").expect("worker_response"));
        let envelope = build_onchain_result_envelope(request_type, &response, None);
        let measured = neo_os_core::js_json::measure_bytes(&JsValue::Object(envelope));
        assert!(
            measured <= 900,
            "{}: envelope exceeds the on-chain budget ({measured} bytes)",
            case["name"].as_str().unwrap_or("?")
        );
    }
}

/// Keep the exporter's Value import honest when the family file changes shape.
#[allow(dead_code)]
fn _unused(v: &Value) -> Value {
    v.clone()
}

#[test]
fn action_v4_callback_encodes_strict_identity_epoch_packet() {
    let maximum = "57896044618658097711785492504343953926634992332820282019728792003956564819967";
    let body = json!({
        "callback_encoding": "neo_n3_action_v4",
        "master_nullifier": format!("0x{}", "11".repeat(32)),
        "authorization_epoch": "2",
        "action_nullifier": format!("0x{}", "22".repeat(32)),
        "signature": format!("0x{}", "33".repeat(64)),
    });
    let encode = |body: &Value| {
        encode_fulfillment_result(
            "neodid_action_ticket",
            &to_js(&json!({"ok": true, "body": body})),
        )
    };
    let expected = format!(
        "4|{}|2|{}|{}",
        neo_os_core::base64::encode_standard(&[0x11; 32]),
        neo_os_core::base64::encode_standard(&[0x22; 32]),
        neo_os_core::base64::encode_standard(&[0x33; 64])
    );
    let result = encode(&body).unwrap();
    assert_eq!(
        result.result_bytes_base64,
        Some(neo_os_core::base64::encode_standard(expected.as_bytes()))
    );
    assert!(result.result.is_empty());
    for epoch in ["1", maximum] {
        let mut valid = body.clone();
        valid["authorization_epoch"] = json!(epoch);
        assert!(encode(&valid).is_ok());
    }
    for field in [
        "master_nullifier",
        "authorization_epoch",
        "action_nullifier",
        "signature",
    ] {
        for invalid in [Value::Null, json!(1), json!({}), json!("")] {
            let mut malformed = body.clone();
            malformed[field] = invalid;
            assert!(encode(&malformed).is_err(), "{field}");
        }
    }
    for epoch in [
        "0",
        "01",
        "-1",
        "+1",
        "1.0",
        "1e3",
        " 1",
        "1 ",
        "1|2",
        "57896044618658097711785492504343953926634992332820282019728792003956564819968",
    ] {
        let mut malformed = body.clone();
        malformed["authorization_epoch"] = json!(epoch);
        assert!(encode(&malformed).is_err(), "{epoch}");
    }
    for (field, length) in [
        ("master_nullifier", 32),
        ("action_nullifier", 32),
        ("signature", 64),
    ] {
        for invalid in [
            "zz".repeat(length),
            "11".repeat(length - 1),
            "11".repeat(length + 1),
            format!(" {}", "11".repeat(length)),
        ] {
            let mut malformed = body.clone();
            malformed[field] = json!(invalid);
            assert!(encode(&malformed).is_err(), "{field}");
        }
    }
}
