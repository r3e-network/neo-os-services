//! State-level tests: the overlay-backed network resolution and the role
//! order the health/provision surfaces emit.

use super::*;
use crate::normalize_network;

#[path = "support.rs"]
#[allow(clippy::duplicate_mod)] // intentional: one shared doubles file per test module
mod support;
use support::*;

#[test]
fn resolve_network_follows_the_overlay_like_process_env() {
    let harness = test_state(
        &[("MORPHEUS_NETWORK", "mainnet")],
        FakeAttest::with_document(b"doc"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::default(),
    );
    assert_eq!(harness.state.resolve_network().unwrap(), "mainnet");
}

#[test]
fn an_unspellable_network_collapses_to_testnet() {
    assert_eq!(normalize_network(Some("MAINNET")).unwrap(), "mainnet");
    assert_eq!(normalize_network(Some("  mainnet  ")).unwrap(), "mainnet");
    assert_eq!(normalize_network(Some("mainnet ")).unwrap(), "mainnet");
    assert_eq!(normalize_network(Some("testnet")).unwrap(), "testnet");
    assert!(normalize_network(Some("mainnet-but-wrong")).is_err());
    assert_eq!(normalize_network(Some("")).unwrap(), "testnet");
    assert_eq!(normalize_network(None).unwrap(), "testnet");
}

#[test]
fn an_explicit_unknown_network_is_rejected_before_identity_selection() {
    let harness = test_state(
        &[("MORPHEUS_NETWORK", "staging")],
        FakeAttest::with_document(b"doc"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::default(),
    );
    assert!(harness.state.resolve_network().is_err());
    let body = crate::health::handle_health(&harness.state);
    assert_eq!(body["ready"], false);
    assert_eq!(body["network"], serde_json::Value::Null);
    assert!(body["error"]
        .as_str()
        .expect("network error")
        .contains("unsupported Neo network"));
}

#[test]
fn provisioning_cannot_change_the_image_owned_network() {
    let harness = test_state(
        &[],
        FakeAttest::with_document(b"doc"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::default(),
    );
    assert_eq!(harness.state.resolve_network().unwrap(), "testnet");
    harness
        .state
        .overlay
        .write()
        .expect("overlay lock")
        .apply("MORPHEUS_NETWORK", &serde_json::json!("mainnet"));
    assert_eq!(harness.state.resolve_network().unwrap(), "testnet");
}

#[test]
fn every_measured_signing_role_is_reported_in_one_stable_order() {
    assert_eq!(
        AppState::SIGNING_ROLES,
        [
            "updater",
            "oracle_verifier",
            "relayer",
            "worker",
            "neox_updater",
            "neox_verifier"
        ]
    );
}

#[test]
fn a_fresh_kms_diag_reads_not_run() {
    let harness = test_state(
        &[],
        FakeAttest::with_document(b"doc"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::default(),
    );
    assert_eq!(
        harness.state.kms_diag.lock().expect("diag lock").value,
        serde_json::json!({ "state": "not_run" })
    );
}
