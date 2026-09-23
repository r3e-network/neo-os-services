//! The kernel fulfillment builders carry the game-session result, codec v2,
//! to the chain as raw bytes. Every shared vector (the same file PlatformGame's
//! suites feed to the contract) must reach `result_bytes_base64` verbatim, and
//! bytes the contract refuses must not pass as v2.

use neo_os_core::envelope::encode_fulfillment_result;
use neo_os_core::js_value::JsValue;
use serde_json::{json, Value};

const VECTORS: &str = include_str!("../../neo-os-games/tests/vectors/game-result-v2.vectors.json");

fn b64(hex_text: &str) -> String {
    neo_os_core::base64::encode_standard(&hex::decode(hex_text).expect("hex"))
}

fn encode(callback_encoding: &str, result_hex: &str) -> (bool, Option<String>) {
    let response = JsValue::from_json(&json!({
        "ok": true,
        "status": 200,
        "body": {
            "result_bytes_base64": b64(result_hex),
            "callback_encoding": callback_encoding,
        },
    }));
    let encoded = encode_fulfillment_result("session.finalize", &response).expect("encodes");
    (encoded.success, encoded.result_bytes_base64)
}

#[test]
fn every_v2_vector_reaches_the_chain_verbatim() {
    let vectors: Value = serde_json::from_str(VECTORS).expect("vectors");
    let cases = vectors["vectors"].as_array().expect("vectors array");
    assert!(!cases.is_empty());
    for case in cases {
        let result = case["result"].as_str().expect("result hex");
        let (success, bytes) = encode("game_result_v2", result);
        assert!(success, "{}", case["name"]);
        assert_eq!(
            bytes.as_deref(),
            Some(b64(result).as_str()),
            "{}",
            case["name"]
        );
    }
}

#[test]
fn bytes_the_contract_refuses_do_not_pass_as_v2() {
    let vectors: Value = serde_json::from_str(VECTORS).expect("vectors");
    for rejected in vectors["rejected"].as_array().expect("rejected") {
        let (_, bytes) = encode("game_result_v2", rejected["result"].as_str().expect("hex"));
        assert_eq!(bytes, None, "{}", rejected["name"]);
    }
    // A v2 result under the v1 label is not v1 either.
    let golden = vectors["vectors"][0]["result"].as_str().expect("hex");
    assert_eq!(encode("game_result_v1", golden).1, None);
}
