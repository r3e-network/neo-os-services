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

const VALID_UNSIGNED_N3: &str = "0001000000000000000000000000000000000000006400000001cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd01002dc21f0c0e66756c66696c6c526571756573740c1467452301efcdab8967452301efcdab896745230141627d5b52";

fn valid_payload_preimage() -> String {
    format!("4e335435{VALID_UNSIGNED_N3}")
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
    let data_hex = valid_payload_preimage();
    let value = handle_sign_payload(
        &harness.state,
        &serde_json::json!({ "role": "worker", "key_role": "updater", "data_hex": data_hex }),
    )
    .expect("sign");
    assert_eq!(value["role"], "updater");

    let value = handle_sign_payload(
        &harness.state,
        &serde_json::json!({ "role": "worker", "data_hex": valid_payload_preimage() }),
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
    let data_hex = format!("0x{}", valid_payload_preimage().to_ascii_uppercase());
    let value = handle_sign_payload(
        &harness.state,
        &serde_json::json!({ "key_role": "updater", "message_hex": data_hex }),
    )
    .expect("sign");
    assert_eq!(value["status"], "ok");
    assert!(harness.signer.sign_calls().is_empty());
    assert_eq!(
        harness.signer.n3_transaction_calls()[0].2,
        VALID_UNSIGNED_N3
    );
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
        &serde_json::json!({ "key_role": "oracle_verifier", "data_hex": valid_payload_preimage() }),
    )
    .expect("sign");
    assert_eq!(value["key_source"], "custody");
    assert_eq!(value["network"], "testnet");
    assert_eq!(value["chain_family"], "neo-n3");
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
        let data_hex = if expect_signed {
            valid_payload_preimage()
        } else {
            "cafe".to_string()
        };
        let outcome = handle_sign_payload(
            &harness.state,
            &serde_json::json!({ "key_role": "updater", "data_hex": data_hex }),
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

// W2.9: `/sign/payload` is a compatibility envelope for a complete N3
// transaction preimage only. It must translate to the semantic transaction
// capability; the image-owned opt-in must never reopen raw signing.
#[test]
fn payload_preimage_uses_the_n3_transaction_capability() {
    let harness = test_state(
        &blind_sign_overlay(),
        FakeAttest::with_document(b"doc"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::default(),
    );
    let unsigned = VALID_UNSIGNED_N3;
    let data_hex = valid_payload_preimage();
    let value = handle_sign_payload(
        &harness.state,
        &serde_json::json!({ "key_role": "updater", "data_hex": data_hex }),
    )
    .expect("semantic transaction signing");
    assert_eq!(value["chain_family"], "neo-n3");
    assert_eq!(harness.signer.sign_calls().len(), 0);
    let calls = harness.signer.n3_transaction_calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].0, "testnet");
    assert_eq!(calls[0].1, "updater");
    assert_eq!(calls[0].2, unsigned);
}

#[test]
fn payload_refuses_arbitrary_bytes_even_when_the_legacy_opt_in_is_present() {
    let harness = test_state(
        &blind_sign_overlay(),
        FakeAttest::with_document(b"doc"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::default(),
    );
    let error = handle_sign_payload(
        &harness.state,
        &serde_json::json!({ "key_role": "updater", "data_hex": "cafe" }),
    )
    .expect_err("arbitrary bytes must not be signed");
    assert_eq!(error.status, 400);
    assert!(error.message.contains("transaction"), "{}", error.message);
    assert!(harness.signer.sign_calls().is_empty());
    assert!(harness.signer.n3_transaction_calls().is_empty());
}

#[test]
fn payload_refuses_legacy_txid_and_foreign_magic_before_custody() {
    let harness = test_state(
        &blind_sign_overlay(),
        FakeAttest::with_document(b"doc"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::default(),
    );
    let legacy_txid = format!("4e335435{}", "ab".repeat(32));
    let foreign_magic = format!("00403633{VALID_UNSIGNED_N3}");
    for (data_hex, expected) in [
        (legacy_txid, "legacy magic+txid"),
        (foreign_magic, "measured network magic"),
    ] {
        let error = handle_sign_payload(
            &harness.state,
            &serde_json::json!({ "key_role": "updater", "data_hex": data_hex }),
        )
        .expect_err("the preimage is not a valid transaction for this network");
        assert_eq!(error.status, 400);
        assert!(error.message.contains(expected), "{}", error.message);
    }
    assert!(harness.signer.sign_calls().is_empty());
    assert!(harness.signer.n3_transaction_calls().is_empty());
}

#[test]
fn payload_request_id_is_stable_for_the_same_unsigned_transaction() {
    let harness = test_state(
        &blind_sign_overlay(),
        FakeAttest::with_document(b"doc"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::default(),
    );
    for _ in 0..2 {
        handle_sign_payload(
            &harness.state,
            &serde_json::json!({ "key_role": "updater", "data_hex": valid_payload_preimage() }),
        )
        .expect("idempotent semantic intent");
    }
    let calls = harness.signer.n3_transaction_calls();
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0].3, calls[1].3);
    assert!(calls[0].3.starts_with("n3-payload:testnet:"));
    assert!(harness.signer.sign_calls().is_empty());
}
