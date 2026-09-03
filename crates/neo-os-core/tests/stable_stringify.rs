mod common;

use common::{keys_object, load_family};
use neo_os_core::js_value::JsValue;
use neo_os_core::stable_stringify::stable_stringify;

/// The pinned golden vectors (stable-stringify-vectors.mjs) — the oracle
/// self-checks against them at export time; here we prove the Rust port
/// reproduces the same bytes.
#[test]
fn stable_stringify_matches_pinned_vectors() {
    for case in load_family("stable_stringify") {
        // Inputs are exported with the tagged-scalar encoding.
        let input = JsValue::from_tagged(case.get("input").expect("input"));
        let expected = case
            .get("expected")
            .and_then(|v| v.as_str())
            .expect("expected");
        let actual = stable_stringify(&input);
        assert_eq!(actual, expected, "case {}", case["name"]);
    }
}

/// 150 randomized key sets over ASCII/accented/Cyrillic/CJK/emoji keys — the
/// ICU collation acceptance gate (hash mismatch is a merge blocker).
#[test]
fn key_collation_corpus_matches_js_oracle() {
    for case in load_family("key_collation_corpus") {
        let keys = case.get("keys").and_then(|v| v.as_array()).expect("keys");
        let expected = case
            .get("expected")
            .and_then(|v| v.as_str())
            .expect("expected");
        let actual = stable_stringify(&keys_object(keys));
        assert_eq!(actual, expected, "case {}", case["name"]);
    }
}
