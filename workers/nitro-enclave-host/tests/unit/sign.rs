//! Sign shim tests: the strict role refusal (the deliberate divergence from
//! `normalizeSignerRole`'s silent updater default), the data_hex validation,
//! and the identity pass-through for /keys/derived.

use super::*;

#[path = "support.rs"]
#[allow(clippy::duplicate_mod)] // intentional: one shared doubles file per test module
mod support;
use support::*;

/// The blind-sign lane is OFF by default (SVC-B-1), so every test that means
/// to exercise a SUCCESSFUL `/sign/payload` opts in explicitly. Keeping the
/// opt-in out of `healthy_overlay()` is the point: a future test that forgets
/// it sees the refusal, not a signature.
fn blind_sign_overlay() -> Vec<(&'static str, &'static str)> {
    let mut pairs = healthy_overlay();
    pairs.push((BLIND_SIGN_OPT_IN_ENV, "1"));
    pairs
}

#[test]
fn the_strict_role_mapper_accepts_exactly_the_node_vocabulary() {
    assert_eq!(
        normalize_signer_role_strict("oracle_verifier"),
        Some("oracle_verifier")
    );
    assert_eq!(
        normalize_signer_role_strict("verifier"),
        Some("oracle_verifier")
    );
    assert_eq!(normalize_signer_role_strict("UPDATER"), Some("updater"));
    assert_eq!(normalize_signer_role_strict("  relayer "), Some("relayer"));
    assert_eq!(normalize_signer_role_strict("worker"), Some("worker"));
    assert_eq!(normalize_signer_role_strict("typo_role"), None);
    assert_eq!(normalize_signer_role_strict(""), None);
    assert_eq!(normalize_signer_role_strict("admin"), None);
}

#[test]
fn sign_payload_rejects_an_unknown_role_with_the_legal_set() {
    let harness = test_state(
        &healthy_overlay(),
        FakeAttest::with_document(b"doc"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::default(),
    );
    let error = handle_sign_payload(
        &harness.state,
        &serde_json::json!({ "key_role": "typo_role", "data_hex": "cafe" }),
    )
    .expect_err("unknown role");
    assert_eq!(error.status, 400);
    assert_eq!(
        error.message,
        "key_role must be one of oracle_verifier, updater, relayer, worker"
    );
}

#[test]
fn sign_payload_role_aliases_resolve_in_the_node_order() {
    let harness = test_state(
        &blind_sign_overlay(),
        FakeAttest::with_document(b"doc"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::default(),
    );
    // key_role beats dstack_key_role beats role — first truthy wins.
    let value = handle_sign_payload(
        &harness.state,
        &serde_json::json!({ "role": "worker", "key_role": "updater", "data_hex": "cafe" }),
    )
    .expect("sign");
    assert_eq!(value["role"], "updater");

    let value = handle_sign_payload(
        &harness.state,
        &serde_json::json!({ "role": "worker", "data_hex": "cafe" }),
    )
    .expect("sign");
    assert_eq!(value["role"], "worker");
}

#[test]
fn sign_payload_requires_even_lowercase_hex_data() {
    let harness = test_state(
        &blind_sign_overlay(),
        FakeAttest::with_document(b"doc"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::default(),
    );
    for data in ["", "abc", "0xzz", "nothex"] {
        let error = handle_sign_payload(
            &harness.state,
            &serde_json::json!({ "key_role": "updater", "data_hex": data }),
        )
        .expect_err(data);
        assert_eq!(error.status, 400, "{data}");
        assert_eq!(error.message, "data_hex is required", "{data}");
    }
    // Uppercase and 0x-prefixed input is normalized, not rejected.
    let value = handle_sign_payload(
        &harness.state,
        &serde_json::json!({ "key_role": "updater", "message_hex": "0xDEADBEEF" }),
    )
    .expect("sign");
    assert_eq!(value["status"], "ok");
    assert_eq!(harness.signer.sign_calls()[0].2, "deadbeef".to_string());
}

#[test]
fn sign_payload_passes_the_custody_response_through_verbatim() {
    let harness = test_state(
        &blind_sign_overlay(),
        FakeAttest::with_document(b"doc"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::default(),
    );
    let value = handle_sign_payload(
        &harness.state,
        &serde_json::json!({ "key_role": "oracle_verifier", "data_hex": "cafe" }),
    )
    .expect("sign");
    assert_eq!(value["key_source"], "vault_sealed");
    assert_eq!(value["network"], "testnet");
}

#[test]
fn keys_derived_reports_identity_and_falls_back_to_the_report_public_key() {
    let harness = test_state(
        &healthy_overlay(),
        FakeAttest::with_document(b"doc"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::default(),
    );
    let value = handle_keys_derived(
        &harness.state,
        &serde_json::json!({ "role": "oracle_verifier" }),
    )
    .expect("identity");
    assert_eq!(value["status"], "ok");
    assert_eq!(value["role"], "oracle_verifier");
    assert_eq!(
        value["neo_n3"]["address"],
        "Nd5tGBUrXa3YylLBYbwZSp8BhRd1vcaFqm"
    );
    assert_eq!(value["derived"]["neo_n3"], value["neo_n3"]);
    assert_eq!(value["key_source"], "kms_attested");

    // An identity without a public key falls back to the report's.
    harness.signer.set_config(SignerConfig {
        identity: serde_json::json!({ "address": "Nf1address" }),
        ..SignerConfig::default()
    });
    let value = handle_keys_derived(
        &harness.state,
        &serde_json::json!({ "role": "oracle_verifier" }),
    )
    .expect("identity");
    assert_eq!(value["neo_n3"]["address"], "Nf1address");
    assert_eq!(
        value["neo_n3"]["public_key"],
        "02f8a5a1e0f3b6c9d2e5f8a1b4c7d0e3f6a9b2c5d8e1f4a7b0c3d6e9f2a5b8c1"
    );
}

#[test]
fn keys_derived_refuses_unknown_roles_too() {
    let harness = test_state(
        &healthy_overlay(),
        FakeAttest::with_document(b"doc"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::default(),
    );
    let error = handle_keys_derived(&harness.state, &serde_json::json!({ "role": "root" }))
        .expect_err("unknown role");
    assert_eq!(error.status, 400);
    assert_eq!(
        error.message,
        "role must be one of oracle_verifier, updater, relayer, worker"
    );
}

#[test]
fn an_unconfigured_role_is_the_node_503_message() {
    let harness = test_state(
        &healthy_overlay(),
        FakeAttest::with_document(b"doc"),
        FakeSigner::unconfigured(),
        FakeBridge::new(),
        FakeKms::default(),
    );
    for handler in ["sign", "derived"] {
        let error = match handler {
            "sign" => handle_sign_payload(
                &harness.state,
                &serde_json::json!({ "key_role": "updater", "data_hex": "cafe" }),
            )
            .expect_err("unconfigured"),
            _ => handle_keys_derived(&harness.state, &serde_json::json!({ "role": "updater" }))
                .expect_err("unconfigured"),
        };
        assert_eq!(error.status, 503, "{handler}");
        assert_eq!(
            error.message, "updater signer is not configured or does not match pinned identity",
            "{handler}"
        );
    }
}

// ---------------------------------------------------------------------------
// SVC-B-1 — the blind-sign lane is retired unless the measured image opts in
// ---------------------------------------------------------------------------

/// `/sign/payload` hands the caller a signature over a digest the CALLER
/// chose, with a key the on-chain verifier trusts. That is enough to forge an
/// oracle fulfilment for a real pending request without any compute running
/// in the enclave, so a fully configured custody plane must still refuse
/// unless the measured image opted the lane back in.
#[test]
fn a_configured_plane_still_refuses_to_blind_sign_without_the_image_opt_in() {
    let harness = test_state(
        &healthy_overlay(),
        FakeAttest::with_document(b"doc"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::default(),
    );
    let error = handle_sign_payload(
        &harness.state,
        &serde_json::json!({ "key_role": "oracle_verifier", "data_hex": "cafe" }),
    )
    .expect_err("the retired lane must not sign");
    assert_eq!(error.status, 503);
    assert!(
        error.message.contains("blind payload signing is retired"),
        "{}",
        error.message
    );
    assert!(
        harness.signer.sign_calls().is_empty(),
        "no custody signing call may be made at all"
    );
}

/// Only the exact value opens it. `true`/`yes`/`0`/empty all leave it closed:
/// a lane this dangerous is not opened by something that merely looks truthy.
#[test]
fn only_the_exact_opt_in_value_reopens_the_lane() {
    for (value, expect_signed) in [
        ("1", true),
        ("true", false),
        ("yes", false),
        ("0", false),
        (" ", false),
    ] {
        let mut pairs = healthy_overlay();
        pairs.push((BLIND_SIGN_OPT_IN_ENV, value));
        let harness = test_state(
            &pairs,
            FakeAttest::with_document(b"doc"),
            FakeSigner::healthy(),
            FakeBridge::new(),
            FakeKms::default(),
        );
        let outcome = handle_sign_payload(
            &harness.state,
            &serde_json::json!({ "key_role": "updater", "data_hex": "cafe" }),
        );
        assert_eq!(
            outcome.is_ok(),
            expect_signed,
            "ENCLAVE_ALLOW_BLIND_SIGN={value:?}"
        );
    }
}

/// The lane that replaced it is untouched: `/oracle/fulfill`'s own digest is
/// still signed, because the refusal lives in the blind-sign shim and not in
/// the signing plane.
#[test]
fn the_opt_in_does_not_gate_the_semantic_signing_plane() {
    let harness = test_state(
        &healthy_overlay(),
        FakeAttest::with_document(b"doc"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::default(),
    );
    harness
        .state
        .signer
        .sign_payload("testnet", "oracle_verifier", "cafe")
        .expect("the plane itself still signs the fold's own digest");
}
