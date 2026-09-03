//! Phase 0 harness: every vector file must parse and carry a non-empty case
//! list. The per-family byte-exact assertions arrive with the Phase 1
//! implementations; this file pins the fixture contract those tests will load.

use std::fs;
use std::path::PathBuf;

fn load(name: &str) -> serde_json::Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("vectors")
        .join(name);
    let raw = fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("vector file {} unreadable: {e}", path.display()));
    serde_json::from_str(&raw)
        .unwrap_or_else(|e| panic!("vector file {name} is not valid JSON: {e}"))
}

fn cases(name: &str) -> Vec<serde_json::Value> {
    let value = load(name);
    let cases = value
        .get("cases")
        .and_then(|c| c.as_array())
        .unwrap_or_else(|| panic!("vector file {name} has no cases array"));
    assert!(!cases.is_empty(), "vector file {name} is empty");
    cases.clone()
}

#[test]
fn stable_stringify_vectors_parse() {
    for case in cases("stable_stringify.json") {
        assert!(
            case.get("name").is_some() && case.get("expected").is_some(),
            "stable_stringify case missing name/expected: {case}"
        );
        assert!(
            case.get("input").is_some(),
            "stable_stringify case missing tagged input: {case}"
        );
    }
}

#[test]
fn collation_corpus_parses() {
    assert!(cases("key_collation_corpus.json").len() >= 100);
}

#[test]
fn cbor_vectors_parse() {
    for case in cases("cbor_decode.json") {
        if case.get("decoded").is_none() && case.get("error").is_none() {
            // decodeCoseSign1 / decodeCoseSign1Payload cases carry their own
            // shapes (protected/payload bytes or a payload map).
            assert!(
                case.get("payload").is_some(),
                "cose extraction case missing payload: {case}"
            );
            continue;
        }
        let has_decode = case.get("decoded").is_some();
        let has_error = case.get("error").is_some();
        assert!(
            has_decode != has_error,
            "cbor case must have exactly one of decoded/error: {case}"
        );
    }
}

#[test]
fn cose_vectors_parse() {
    for case in cases("cose_sign1.json") {
        assert!(
            case.get("kind").is_some() && case.get("expected_hex").is_some(),
            "cose case missing kind/expected_hex: {case}"
        );
    }
}

#[test]
fn digest_vectors_parse() {
    for case in cases("fulfillment_digest.json") {
        let digest = case
            .get("digest_hex")
            .and_then(|d| d.as_str())
            .unwrap_or_else(|| panic!("digest case missing digest_hex: {case}"));
        assert_eq!(digest.len(), 64, "digest must be sha256-length hex: {case}");
    }
}

#[test]
fn envelope_vectors_parse() {
    for case in cases("fulfillment_envelope.json") {
        assert!(
            case.get("encoded").is_some() && case.get("envelope").is_some(),
            "envelope case missing encoded/envelope: {case}"
        );
    }
}

#[test]
fn worker_payload_vectors_parse() {
    for case in cases("worker_payload.json") {
        assert!(
            case.get("payload").is_some(),
            "worker_payload case missing payload: {case}"
        );
    }
}

#[test]
fn neox_vectors_parse() {
    for case in cases("neox_digest.json") {
        assert!(
            case.get("expected").is_some(),
            "neox case missing expected: {case}"
        );
    }
}
