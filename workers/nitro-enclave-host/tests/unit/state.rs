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
    assert_eq!(harness.state.resolve_network(), "mainnet");
}

#[test]
fn an_unspellable_network_collapses_to_testnet() {
    assert_eq!(normalize_network(Some("MAINNET")), "mainnet");
    assert_eq!(normalize_network(Some("  mainnet  ")), "mainnet");
    assert_eq!(normalize_network(Some("mainnet ")), "mainnet");
    assert_eq!(normalize_network(Some("testnet")), "testnet");
    assert_eq!(normalize_network(Some("mainnet-but-wrong")), "testnet");
    assert_eq!(normalize_network(Some("")), "testnet");
    assert_eq!(normalize_network(None), "testnet");
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
    assert_eq!(harness.state.resolve_network(), "testnet");
    harness
        .state
        .overlay
        .write()
        .expect("overlay lock")
        .apply("MORPHEUS_NETWORK", &serde_json::json!("mainnet"));
    assert_eq!(harness.state.resolve_network(), "testnet");
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
