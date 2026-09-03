mod common;

use common::{canonical, load_family};
use neo_os_core::config::EnvSource;
use neo_os_core::js_value::{JsObject, JsValue};

fn json_object(case: &serde_json::Value, key: &str) -> JsObject {
    match JsValue::from_json(&case[key]) {
        JsValue::Object(obj) => obj,
        JsValue::Null => JsObject::new(),
        other => panic!("{key} is not an object: {other:?}"),
    }
}

#[test]
fn env_alias_resolution_matches_js_oracle() {
    for case in load_family("env_for_network") {
        let name = case["name"].as_str().unwrap_or("?");
        let source = EnvSource::new(
            json_object(&case, "process_env"),
            json_object(&case, "runtime_config"),
        );
        let calls = case["calls"].as_array().expect("calls");
        let expected = case["expected"].as_array().expect("expected");
        assert_eq!(
            calls.len(),
            expected.len(),
            "case {name} call/expected arity"
        );
        for (call, want) in calls.iter().zip(expected.iter()) {
            let actual = match call["kind"].as_str().expect("kind") {
                "env" => {
                    let names: Vec<String> = call["names"]
                        .as_array()
                        .expect("names")
                        .iter()
                        .map(|v| v.as_str().expect("alias name").to_string())
                        .collect();
                    let refs: Vec<&str> = names.iter().map(String::as_str).collect();
                    JsValue::Str(source.env(&refs))
                }
                "env_network_scoped" => JsValue::Str(source.env_network_scoped(
                    call["network"].as_str().expect("network"),
                    call["generic_key"].as_str().expect("generic_key"),
                )),
                other => panic!("unknown env_for_network call kind {other}"),
            };
            assert_eq!(
                canonical(&actual),
                canonical(&JsValue::from_tagged(want)),
                "case {name}"
            );
        }
    }
}
