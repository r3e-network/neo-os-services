mod common;

use common::load_family;
use morpheus_core::digest::{build_fulfillment_digest_bytes, FulfillmentOptions};
use morpheus_core::js_value::JsValue;

fn options_from(value: &serde_json::Value) -> FulfillmentOptions {
    FulfillmentOptions {
        chain: value
            .get("chain")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        app_id: value
            .get("appId")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        module_id: value
            .get("moduleId")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        operation: value
            .get("operation")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        contract_script_hash: value
            .get("contractScriptHash")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        network_magic: value.get("networkMagic").and_then(|v| v.as_f64()),
    }
}

#[test]
fn fulfillment_digest_matches_js_oracle() {
    for case in load_family("fulfillment_digest") {
        let name = case["name"].as_str().unwrap_or("?");
        // The exporter tags requestId ({__t:...}) so non-JSON scalars survive;
        // rebuild the JsValue through the tagged decoder.
        let request_id = JsValue::from_tagged(case.get("request_id").expect("request_id"));
        // The oracle exports plain scalars for these fields; the JsValue
        // layer normalizes them to the JS runtime shapes.
        let request_type = case
            .get("request_type")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        let success = case
            .get("success")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let result = str_field(case.get("result"));
        let error = str_field(case.get("error"));
        let result_bytes_base64 = str_field(case.get("result_bytes_base64"));
        let options = options_from(case.get("options").expect("options"));

        let digest = build_fulfillment_digest_bytes(
            &request_id,
            request_type,
            success,
            &result,
            &error,
            &result_bytes_base64,
            &options,
        )
        .unwrap_or_else(|e| panic!("{name}: {e}"));

        assert_eq!(
            morpheus_core::hex_encode(&digest),
            case["digest_hex"].as_str().unwrap(),
            "{name}"
        );
    }
}

fn str_field(value: Option<&serde_json::Value>) -> String {
    value
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .unwrap_or_default()
}

/// The BigInt-string requestId and the deployment-bound suffix are the
/// highest-risk byte paths — assert them explicitly even if the family grows.
#[test]
fn request_id_tostring_semantics() {
    let bigint = JsValue::from_tagged(
        &serde_json::json!({ "__t": "bigint", "v": "123456789012345678901234567890" }),
    );
    assert_eq!(
        bigint.to_string_js().unwrap(),
        "123456789012345678901234567890"
    );
    let number = JsValue::from_tagged(&serde_json::json!({ "__t": "number", "v": "0" }));
    assert_eq!(number.to_string_js().unwrap(), "0");
    assert_eq!(JsValue::Null.to_string_js().unwrap(), "null");
}
