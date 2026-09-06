mod common;

use common::{canonical, load_family};
use neo_os_core::config::{derive_pure_fields, EnvSource};
use neo_os_core::js_value::{JsObject, JsValue};

#[test]
fn config_resolution_matches_js_oracle() {
    for case in load_family("config_resolution") {
        let name = case["name"].as_str().unwrap_or("?").to_string();
        let process_env = match JsValue::from_json(&case["process_env"]) {
            JsValue::Object(obj) => obj,
            JsValue::Null => JsObject::new(),
            other => panic!("case {name}: process_env is not an object: {other:?}"),
        };
        let runtime_config = match JsValue::from_json(&case["runtime_config"]) {
            JsValue::Object(obj) => obj,
            JsValue::Null => JsObject::new(),
            other => panic!("case {name}: runtime_config is not an object: {other:?}"),
        };
        let source = EnvSource::new(process_env, runtime_config);
        // The registry is embedded raw (not tagged): it is exactly the object
        // the JS oracle loaded from config/networks/<network>.json.
        let registry = JsValue::from_json(&case["registry"]);
        // Vectors only exercise the unset MORPHEUS_NITRO_ROOT_CERT_PATH path.
        let result = derive_pure_fields(&source, &registry, "");

        let expected = &case["expected"];
        match expected.get("__t").and_then(|v| v.as_str()) {
            Some("error") => {
                let message = expected
                    .get("v")
                    .and_then(|v| v.as_str())
                    .unwrap_or_else(|| panic!("case {name}: error case without message"));
                let err = result.expect_err(&format!("case {name}: expected the JS gate error"));
                assert_eq!(err.0, message, "case {name} gate error message");
            }
            _ => {
                let config = result
                    .unwrap_or_else(|e| panic!("case {name}: expected a config, got error {e}"));
                assert_eq!(
                    canonical(&JsValue::Object(config)),
                    canonical(&JsValue::from_tagged(expected)),
                    "case {name} derived config"
                );
            }
        }
    }
}
