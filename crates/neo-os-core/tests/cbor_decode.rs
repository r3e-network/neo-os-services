mod common;

use common::load_family;
use neo_os_core::cbor::{cbor_read, decode_cose_sign1, decode_cose_sign1_payload, CborValue};

/// Tag a decoded CborValue the same way the exporter's tagCbor does: byte
/// strings become {__t:'bytes',hex}, undefined {__t:'undefined'}, everything
/// else its plain JSON form.
fn tag_cbor(value: &CborValue) -> serde_json::Value {
    match value {
        CborValue::Bytes(b) => {
            serde_json::json!({ "__t": "bytes", "hex": neo_os_core::hex_encode(b) })
        }
        CborValue::Undefined => serde_json::json!({ "__t": "undefined" }),
        CborValue::Null => serde_json::Value::Null,
        CborValue::Bool(b) => serde_json::Value::Bool(*b),
        CborValue::Int(i) => serde_json::json!(i),
        CborValue::Text(s) => serde_json::Value::String(s.clone()),
        CborValue::Array(items) => serde_json::Value::Array(items.iter().map(tag_cbor).collect()),
        CborValue::Map(entries) => {
            let mut map = serde_json::Map::new();
            for (k, v) in entries {
                map.insert(k.clone(), tag_cbor(v));
            }
            serde_json::Value::Object(map)
        }
    }
}

fn hex_bytes(case: &serde_json::Value) -> Vec<u8> {
    let hex = case.get("hex").and_then(|v| v.as_str()).expect("case hex");
    hex::decode(hex).expect("valid hex")
}

#[test]
fn cbor_family_matches_js_oracle() {
    for case in load_family("cbor_decode") {
        let name = case["name"].as_str().unwrap_or("?");

        if case.get("decoded").is_some() {
            // Plain cborRead ok-case.
            let bytes = hex_bytes(&case);
            let (value, _pos) = cbor_read(&bytes, 0).unwrap_or_else(|e| panic!("{name}: {e}"));
            assert_eq!(tag_cbor(&value), case["decoded"], "{name}");
            continue;
        }

        if let Some(expected_error) = case.get("error").and_then(|v| v.as_str()) {
            // Error cases: dispatched to the same decoder the JS oracle used.
            let bytes = hex_bytes(&case);
            let result = if expected_error.starts_with("cose:") {
                decode_cose_sign1(&bytes).map(|_| ())
            } else {
                cbor_read(&bytes, 0).map(|_| ())
            };
            let err = result.expect_err(&format!("{name} was expected to fail"));
            assert_eq!(err.to_string(), expected_error, "{name}");
            continue;
        }

        if case.get("payload").is_some() {
            // COSE ok-case: full four-element comparison when the vector
            // carries the header/payload/signature splits.
            let bytes = hex_bytes(&case);
            if case.get("protected_header_hex").is_some() {
                let decoded = decode_cose_sign1(&bytes).unwrap_or_else(|e| panic!("{name}: {e}"));
                assert_eq!(
                    neo_os_core::hex_encode(&decoded.protected_header_bytes),
                    case["protected_header_hex"].as_str().unwrap(),
                    "{name} protected bytes"
                );
                assert_eq!(
                    neo_os_core::hex_encode(&decoded.payload_bytes),
                    case["payload_bytes_hex"].as_str().unwrap(),
                    "{name} payload bytes"
                );
                assert_eq!(
                    tag_cbor(&decoded.payload),
                    case["payload"],
                    "{name} payload map"
                );
                assert_eq!(
                    neo_os_core::hex_encode(&decoded.signature),
                    case["signature_hex"].as_str().unwrap(),
                    "{name} signature"
                );
            } else {
                let payload =
                    decode_cose_sign1_payload(&bytes).unwrap_or_else(|e| panic!("{name}: {e}"));
                assert_eq!(tag_cbor(&payload), case["payload"], "{name}");
            }
        }
    }
}
