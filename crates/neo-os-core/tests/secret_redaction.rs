mod common;

use common::load_family;
use neo_os_core::secret_redaction::{is_secret_name, redact_secret_values};

#[test]
fn secret_redaction_matches_js_oracle() {
    for case in load_family("secret_redaction") {
        let name = case["name"].as_str().unwrap_or("?");
        let input = case["input"].as_str().expect("secret_redaction input is a string");
        match case["kind"].as_str().expect("kind") {
            "redact" => {
                let expected = case["expected"].as_str().expect("redact expected is a string");
                assert_eq!(redact_secret_values(input), expected, "case {name}");
            }
            "is_secret_name" => {
                let expected = case["expected"].as_bool().expect("name expected is a bool");
                assert_eq!(is_secret_name(input), expected, "case {name}");
            }
            other => panic!("unknown secret_redaction kind {other}"),
        }
    }
}
