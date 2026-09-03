//! The policy engine's oracle vectors: `policy-decisions.json` is exported
//! from the JS implementation (generator: `export-policy-vectors.mjs`) and
//! every case must deep-equal the Rust output. A mismatch is a port bug, not
//! a spec change.

use serde_json::Value;

#[test]
fn rust_matches_the_js_oracle_on_every_vector() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/vectors/policy-decisions.json"
    );
    let raw = std::fs::read_to_string(path).expect("policy vectors file");
    let vectors: Vec<Value> = serde_json::from_str(&raw).expect("vectors parse");
    assert!(
        vectors.len() >= 30,
        "the vector set should stay substantial"
    );

    for vector in &vectors {
        let name = vector["name"].as_str().unwrap_or("unnamed");
        let decision = neo_os_compute::policy::evaluate_policy_decision(&vector["input"]);
        assert_eq!(
            decision, vector["expected"],
            "vector {name} diverged (input: {})",
            vector["input"]
        );
    }
}

#[test]
fn the_two_js_suite_cases_hold_semantically() {
    let disabled = neo_os_compute::policy::evaluate_policy_decision(&serde_json::json!({
        "workflow_id": "paymaster.authorize",
        "provider_enabled": false,
        "require_attestation": true,
    }));
    assert_eq!(disabled["allow"], Value::Bool(false));
    assert_eq!(disabled["reason"], "provider_disabled");

    let review = neo_os_compute::policy::evaluate_policy_decision(&serde_json::json!({
        "workflow_id": "oracle.query",
        "provider_enabled": true,
        "require_attestation": true,
        "attestation_available": false,
    }));
    assert_eq!(review["allow"], Value::Bool(false));
    assert_eq!(review["decision"], "review");
    assert_eq!(review["reason"], "attestation_required");
}

#[test]
fn the_decision_object_keeps_the_js_literal_key_order() {
    // The merged worker renders this object as-is; key order is part of the
    // caller-facing bytes once a lane serializes it.
    let decision = neo_os_compute::policy::evaluate_policy_decision(&serde_json::json!({}));
    let keys: Vec<&str> = decision
        .as_object()
        .expect("decision object")
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(
        keys,
        vec![
            "workflow_id",
            "allow",
            "decision",
            "reason",
            "httpStatus",
            "scope",
            "scope_id",
            "require_attestation",
            "metadata",
        ]
    );
}
