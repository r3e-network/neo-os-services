//! Health tests — the readiness contract and the key_source vocabulary ops
//! watch for plaintext reliance.

use super::*;

#[path = "support.rs"]
#[allow(clippy::duplicate_mod)] // intentional: one shared doubles file per test module
mod support;
use support::*;

#[test]
fn a_ready_host_is_ok_with_the_full_contract() {
    let harness = test_state(
        &healthy_overlay(),
        FakeAttest::with_document(b"doc"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::default(),
    );
    let body = handle_health(&harness.state);
    assert_eq!(body["status"], "ok");
    assert_eq!(body["ready"], true);
    assert_eq!(body["runtime"], "morpheus-enclave-server");
    assert_eq!(body["network"], "testnet");
    assert_eq!(body["checks"]["compute"], true);
    assert_eq!(body["checks"]["signer"], true);
    assert_eq!(
        body["checks"]["oracle_verifier_public_key"],
        "02f8a5a1e0f3b6c9d2e5f8a1b4c7d0e3f6a9b2c5d8e1f4a7b0c3d6e9f2a5b8c1"
    );
    assert_eq!(body["plaintext_key_provision_allowed"], false);
    assert_eq!(body["kms_diag"], serde_json::json!({ "state": "not_run" }));
    assert!(body.get("signer_error").is_none());
}

#[test]
fn key_source_distinguishes_the_kms_path_from_plaintext() {
    // No ciphertext provisioned yet → a materialized key reads host_plaintext.
    let harness = test_state(
        &healthy_overlay(),
        FakeAttest::with_document(b"doc"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::default(),
    );
    let body = handle_health(&harness.state);
    assert_eq!(body["key_source"]["oracle_verifier"], "host_plaintext");
    assert_eq!(body["key_source"]["updater"], "host_plaintext");

    // The role ciphertexts arrive → kms_attested.
    let harness = test_state(
        &[
            ("MORPHEUS_ORACLE_VERIFIER_KMS_CIPHERTEXT_BASE64", "ct1"),
            ("MORPHEUS_UPDATER_NEO_N3_KMS_CIPHERTEXT_BASE64", "ct2"),
        ],
        FakeAttest::with_document(b"doc"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::default(),
    );
    let body = handle_health(&harness.state);
    assert_eq!(body["key_source"]["oracle_verifier"], "kms_attested");
    assert_eq!(body["key_source"]["updater"], "kms_attested");
}

#[test]
fn a_degraded_signer_degrades_health_and_names_the_issues() {
    let harness = test_state(
        &healthy_overlay(),
        FakeAttest::with_document(b"doc"),
        FakeSigner::new(SignerConfig {
            healthy: false,
            issues: vec!["key missing".to_string(), "identity mismatch".to_string()],
            ..SignerConfig::default()
        }),
        FakeBridge::new(),
        FakeKms::default(),
    );
    let body = handle_health(&harness.state);
    assert_eq!(body["status"], "degraded");
    assert_eq!(body["ready"], false);
    assert_eq!(body["checks"]["signer"], false);
    assert_eq!(body["signer_error"], "key missing; identity mismatch");
    assert_eq!(body["key_source"]["oracle_verifier"], "none");
}

#[test]
fn a_down_compute_child_degrades_health_even_with_a_healthy_signer() {
    let harness = test_state(
        &healthy_overlay(),
        FakeAttest::with_document(b"doc"),
        FakeSigner::healthy(),
        FakeBridge::unreachable(),
        FakeKms::default(),
    );
    let body = handle_health(&harness.state);
    assert_eq!(body["status"], "degraded");
    assert_eq!(body["checks"]["compute"], false);
    assert_eq!(body["checks"]["signer"], true);
}

#[test]
fn health_reads_the_network_from_the_live_overlay() {
    let harness = test_state(
        &[("MORPHEUS_NETWORK", "mainnet")],
        FakeAttest::with_document(b"doc"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::default(),
    );
    let body = handle_health(&harness.state);
    assert_eq!(body["network"], "mainnet");
}
