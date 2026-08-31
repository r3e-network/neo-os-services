mod common;

use common::load_family;
use morpheus_core::cose::{build_cose_sign1_sig_structure, cose_es384_signature_to_der};

#[test]
fn sig_structure_matches_js_oracle() {
    for case in load_family("cose_sign1") {
        if case["kind"].as_str() != Some("sig_structure") {
            continue;
        }
        let name = case["name"].as_str().unwrap_or("?");
        let protected = hex::decode(case["protected_hex"].as_str().unwrap()).expect("hex");
        let payload = hex::decode(case["payload_hex"].as_str().unwrap()).expect("hex");
        let built = build_cose_sign1_sig_structure(&protected, &payload);
        assert_eq!(
            morpheus_core::hex_encode(&built),
            case["expected_hex"].as_str().unwrap(),
            "{name}"
        );
    }
}

#[test]
fn es384_der_conversion_matches_js_oracle() {
    for case in load_family("cose_sign1") {
        if case["kind"].as_str() != Some("es384_to_der") {
            continue;
        }
        let name = case["name"].as_str().unwrap_or("?");
        let raw = hex::decode(case["raw_hex"].as_str().unwrap()).expect("hex");
        let expected = case["expected_hex"].as_str();
        let der = cose_es384_signature_to_der(&raw);
        assert_eq!(
            der.as_deref().map(morpheus_core::hex_encode),
            expected.map(str::to_string),
            "{name}"
        );
    }
}
