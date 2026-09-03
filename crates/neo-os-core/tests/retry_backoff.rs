mod common;

use common::load_family;
use neo_os_core::js_value::JsValue;
use neo_os_core::retry::compute_retry_delay_ms;

fn num_field(case: &serde_json::Value, key: &str) -> f64 {
    match JsValue::from_tagged(&case[key]) {
        JsValue::Number(n) => n,
        other => panic!("field {key} is not a tagged number: {other:?}"),
    }
}

#[test]
fn retry_backoff_matches_js_oracle() {
    for case in load_family("retry_backoff") {
        let name = case["name"].as_str().unwrap_or("?");
        let actual = compute_retry_delay_ms(
            num_field(&case, "base_delay_ms"),
            num_field(&case, "max_delay_ms"),
            num_field(&case, "attempts"),
            num_field(&case, "rng"),
        );
        let expected = num_field(&case, "expected");
        assert_eq!(actual, expected, "retry_backoff case {name}");
    }
}
