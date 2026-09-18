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

/// The fallback RPC tables are duplicated between this crate and
/// `workers/morpheus-relayer/src/config.js`, and the golden vectors only catch
/// drift in one direction: regenerating them from the JS oracle flags a JS-side
/// edit, but nothing replays the Rust constant itself, so a cleartext endpoint
/// added HERE was invisible to both `export-rust-vectors.mjs --check` and
/// `cargo test` (verified by mutation on 2026-09-18).
///
/// This pins the invariant the constant's own doc comment states: the table is
/// HTTPS only. `unique_ranked_rpc_urls` merely demotes `http://` to last place,
/// so one cleartext entry stays reachable exactly when every TLS node is down.
#[test]
fn default_rpc_tables_are_https_only() {
    for (network, urls) in neo_os_core::config::DEFAULT_NEO_N3_RPC_URLS {
        assert!(!urls.is_empty(), "{network}: fallback table must not be empty");
        for url in *urls {
            assert!(
                url.starts_with("https://"),
                "{network}: cleartext fallback RPC endpoint {url:?} - the table is HTTPS only",
            );
        }
    }
}
