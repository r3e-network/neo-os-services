//! Provision tests — the whitelist, the plaintext refusal, the KMS bootstrap
//! state machine, direct confidential materialization, and the separately
//! authorized temporary-credential rotation route. The KMS releaser is
//! canned; the release flow itself is nitro-attest's own test surface.

use crate::dispatch::dispatch;
use crate::DispatchOutcome;
use serde_json::json;

#[path = "support.rs"]
#[allow(clippy::duplicate_mod)] // intentional: one shared doubles file per test module
mod support;
use support::*;

const RUNTIME_CIPHERTEXT: &str = "runtime-token-ciphertext";
const ORACLE_CIPHERTEXT: &str = "oracle-key-ciphertext";
const NEODID_CIPHERTEXT: &str = "neodid-salt-ciphertext";
const CUSTODY_TOKEN_CIPHERTEXT: &str = "custody-token-ciphertext";
const RELEASED_TOKEN: &str = "released-runtime-token-0123456789abcdef";
const CUSTODY_TOKEN: &str = "released-custody-token-0123456789abcdef";
const ORACLE_PUBLIC_KEY: &str = "vAB/ripK5xzT1PT+KGbSvEEPfGQoxQliNWjSFjDfuhU=";
const ORACLE_PRIVATE_KEY: &str = "MC4CAQAwBQYDK2VuBCIEIEgdmKz6RqTG40pP8SVY+7XPGOUXAIbmI4alIH3uMYZ8";
const NEODID_SALT: &str = "0123456789abcdef0123456789abcdef";
// The mjs provision suite authenticates static-token requests with the
// module-load NITRO_API_TOKEN; this is its Rust stand-in for the tests that do
// NOT exercise first-boot bootstrap.
const STATIC_TOKEN: &str = "static-provision-token-0123456789abcdef";
const AWS_PAIRS: &[(&str, &str)] = &[
    ("AWS_ACCESS_KEY_ID", "AKIDEXAMPLE"),
    ("AWS_SECRET_ACCESS_KEY", "wJalrXUtnFEMI"),
];

fn released_envelope(version: i64, network: &str) -> Vec<u8> {
    serde_json::to_vec(&json!({
        "purpose": "neoos/nitro-runtime-auth/v1",
        "network": network,
        "version": version,
        "token": RELEASED_TOKEN,
    }))
    .expect("envelope")
}

fn oracle_envelope(network: &str) -> Vec<u8> {
    serde_json::to_vec(&json!({
        "purpose": "neoos/oracle-x25519/v1",
        "network": network,
        "version": 1,
        "key_material": {
            "public_key_raw": ORACLE_PUBLIC_KEY,
            "private_key_pkcs8": ORACLE_PRIVATE_KEY,
        },
    }))
    .expect("oracle envelope")
}

fn neodid_envelope(network: &str) -> Vec<u8> {
    serde_json::to_vec(&json!({
        "purpose": "neoos/neodid-salt/v1",
        "network": network,
        "version": 1,
        "salt": NEODID_SALT,
    }))
    .expect("NeoDID envelope")
}

fn custody_token_envelope(network: &str) -> Vec<u8> {
    serde_json::to_vec(&json!({
        "purpose": "neoos/custody-caller-token/v1",
        "network": network,
        "version": 1,
        "token": CUSTODY_TOKEN,
    }))
    .expect("custody token envelope")
}

fn bootstrap(pairs: &[(&str, &str)], kms: FakeKms) -> TestState {
    test_state(
        pairs,
        FakeAttest::with_document(b"doc"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        kms,
    )
}

/// A trusted set already present (the mjs suite's NITRO_API_TOKEN state): the
/// request authenticates statically and never reaches the bootstrap path.
fn bootstrap_authorized(kms: FakeKms) -> TestState {
    let mut pairs: Vec<(&str, &str)> = vec![("NITRO_API_TOKEN", STATIC_TOKEN)];
    pairs.extend_from_slice(AWS_PAIRS);
    bootstrap(&pairs, kms)
}

fn provision_outcome(
    harness: &TestState,
    headers: &http::HeaderMap,
    env: serde_json::Value,
) -> DispatchOutcome {
    dispatch(
        &harness.state,
        "POST",
        "/provision",
        headers,
        &serde_json::to_string(&json!({ "env": env })).expect("body"),
    )
}

#[test]
fn plaintext_signing_keys_are_refused_with_a_sorted_list() {
    let harness = bootstrap_authorized(FakeKms::default());
    let outcome = provision_outcome(
        &harness,
        &bearer(STATIC_TOKEN),
        json!({
            "MORPHEUS_UPDATER_NEO_N3_WIF": "fixture",
            "NEOX_FEED_PK": "0xdeadbeef",
            "MORPHEUS_ORACLE_KEY_MATERIAL_JSON": "{}",
            "HARMLESS_NAME": "fine",
        }),
    );
    assert_eq!(outcome.status, 403);
    let message = outcome.body["error"].as_str().expect("message");
    assert!(message.starts_with(
        "plaintext key or runtime-token provisioning is permanently disabled; provide an attestation-gated *_KMS_CIPHERTEXT_BASE64 value instead. Rejected: "
    ), "{message}");
    assert!(
        message.contains(
            "MORPHEUS_ORACLE_KEY_MATERIAL_JSON, MORPHEUS_UPDATER_NEO_N3_WIF, NEOX_FEED_PK"
        ),
        "{message}"
    );
    assert!(!message.contains("HARMLESS_NAME"), "{message}");
}

#[test]
fn a_runtime_token_value_in_the_body_is_itself_refused() {
    // The token env keys are members of the refusal list: a body carrying
    // NITRO_API_TOKEN is a plaintext-credential injection attempt.
    let harness = bootstrap_authorized(FakeKms::default());
    let outcome = provision_outcome(
        &harness,
        &bearer(STATIC_TOKEN),
        json!({ "NITRO_API_TOKEN": "smuggled" }),
    );
    assert_eq!(outcome.status, 403);
    assert!(outcome.body["error"]
        .as_str()
        .expect("message")
        .contains("Rejected: NITRO_API_TOKEN"));
}

#[test]
fn the_plaintext_opt_in_flag_is_refused_by_name() {
    let harness = bootstrap_authorized(FakeKms::default());
    let outcome = provision_outcome(
        &harness,
        &bearer(STATIC_TOKEN),
        json!({ "MORPHEUS_ALLOW_PLAINTEXT_KEY_PROVISION": "1" }),
    );
    assert_eq!(outcome.status, 403);
}

#[test]
fn first_provision_without_credentials_to_present_is_a_503() {
    // No AWS creds anywhere: the release cannot even start, which the Node
    // server reported as a materialization failure.
    let harness = bootstrap(&[], FakeKms::default());
    let outcome = provision_outcome(
        &harness,
        &bearer("anything-at-all"),
        json!({ "MORPHEUS_RUNTIME_TOKEN_KMS_CIPHERTEXT_BASE64": RUNTIME_CIPHERTEXT }),
    );
    assert_eq!(outcome.status, 503);
    assert_eq!(
        outcome.body["error"],
        "attestation-gated runtime authorization materialization failed"
    );
}

#[test]
fn a_kms_release_failure_is_a_503() {
    let harness = bootstrap(
        AWS_PAIRS,
        FakeKms::failing(RUNTIME_CIPHERTEXT, "kms decrypt: 403"),
    );
    let outcome = provision_outcome(
        &harness,
        &bearer("anything-at-all"),
        json!({ "MORPHEUS_RUNTIME_TOKEN_KMS_CIPHERTEXT_BASE64": RUNTIME_CIPHERTEXT }),
    );
    assert_eq!(outcome.status, 503);
    assert_eq!(
        outcome.body["error"],
        "attestation-gated runtime authorization materialization failed"
    );
}

#[test]
fn an_unparsable_envelope_is_a_401() {
    let harness = bootstrap(
        AWS_PAIRS,
        FakeKms::releasing(RUNTIME_CIPHERTEXT, b"not json".to_vec()),
    );
    let outcome = provision_outcome(
        &harness,
        &bearer("anything-at-all"),
        json!({ "MORPHEUS_RUNTIME_TOKEN_KMS_CIPHERTEXT_BASE64": RUNTIME_CIPHERTEXT }),
    );
    assert_eq!(outcome.status, 401);
    assert_eq!(
        outcome.body["error"],
        "runtime authorization KMS envelope is invalid"
    );
}

#[test]
fn an_envelope_from_the_wrong_context_is_a_401() {
    for envelope in [
        // Wrong purpose.
        json!({ "purpose": "other/v1", "network": "testnet", "version": 1, "token": RELEASED_TOKEN }),
        // Wrong network.
        json!({ "purpose": "neoos/nitro-runtime-auth/v1", "network": "mainnet", "version": 1, "token": RELEASED_TOKEN }),
        // Version below one / fractional.
        json!({ "purpose": "neoos/nitro-runtime-auth/v1", "network": "testnet", "version": 0, "token": RELEASED_TOKEN }),
        json!({ "purpose": "neoos/nitro-runtime-auth/v1", "network": "testnet", "version": 1.5, "token": RELEASED_TOKEN }),
        // Token too short.
        json!({ "purpose": "neoos/nitro-runtime-auth/v1", "network": "testnet", "version": 1, "token": "short" }),
    ] {
        let harness = bootstrap(
            AWS_PAIRS,
            FakeKms::releasing(
                RUNTIME_CIPHERTEXT,
                serde_json::to_vec(&envelope).expect("env"),
            ),
        );
        let outcome = provision_outcome(
            &harness,
            &bearer("anything-at-all"),
            json!({ "MORPHEUS_RUNTIME_TOKEN_KMS_CIPHERTEXT_BASE64": RUNTIME_CIPHERTEXT }),
        );
        assert_eq!(outcome.status, 401, "{envelope}");
        assert_eq!(
            outcome.body["error"], "runtime authorization KMS envelope context is invalid",
            "{envelope}"
        );
    }
}

#[test]
fn the_envelope_network_may_differ_in_case_but_not_value() {
    // normalizeMorpheusNetwork: exactly 'mainnet' after trim+lowercase, else
    // testnet — the envelope is judged by the same rule as the request.
    let harness = bootstrap(
        AWS_PAIRS,
        FakeKms::releasing(RUNTIME_CIPHERTEXT, released_envelope(1, "TESTNET")),
    );
    let outcome = provision_outcome(
        &harness,
        &bearer(RELEASED_TOKEN),
        json!({ "MORPHEUS_RUNTIME_TOKEN_KMS_CIPHERTEXT_BASE64": RUNTIME_CIPHERTEXT }),
    );
    assert_eq!(outcome.status, 200, "{:?}", outcome.body);
}

#[test]
fn immutable_security_configuration_and_unknown_names_are_rejected() {
    for name in [
        "NODE_ENV",
        "MORPHEUS_NETWORK",
        "SIGNER_SERVICE_URL",
        "SIGNER_SERVICE_TOKEN",
        "MORPHEUS_ALLOW_EPHEMERAL_KEY",
        "NITRO_ATTESTATION_PCR0",
        "NEO_RPC_URL",
        "HARMLESS_NAME",
    ] {
        let harness = bootstrap(AWS_PAIRS, FakeKms::default());
        let mut env = json!({
            "MORPHEUS_RUNTIME_TOKEN_KMS_CIPHERTEXT_BASE64": RUNTIME_CIPHERTEXT,
        });
        env.as_object_mut()
            .expect("env")
            .insert(name.to_string(), json!("attacker-controlled"));
        let outcome = provision_outcome(&harness, &bearer(RELEASED_TOKEN), env);
        assert_eq!(outcome.status, 400, "{name}: {:?}", outcome.body);
        assert!(outcome.body["error"]
            .as_str()
            .expect("error")
            .contains("non-allowlisted"));
        assert!(harness.kms.calls().is_empty(), "{name} reached KMS");
    }
}

#[test]
fn allowlisted_values_are_strict_non_empty_strings() {
    for value in [json!(null), json!(42), json!({}), json!("   ")] {
        let harness = bootstrap(AWS_PAIRS, FakeKms::default());
        let outcome = provision_outcome(
            &harness,
            &bearer(RELEASED_TOKEN),
            json!({ "MORPHEUS_RUNTIME_TOKEN_KMS_CIPHERTEXT_BASE64": value }),
        );
        assert_eq!(outcome.status, 400, "{:?}", outcome.body);
        assert!(harness.kms.calls().is_empty());
    }
}

#[test]
fn direct_confidential_ciphertexts_materialize_only_inside_memory() {
    let kms = FakeKms::releasing(RUNTIME_CIPHERTEXT, released_envelope(1, "testnet"));
    kms.set_result(ORACLE_CIPHERTEXT, Ok(oracle_envelope("testnet")));
    kms.set_result(NEODID_CIPHERTEXT, Ok(neodid_envelope("testnet")));
    kms.set_result(
        CUSTODY_TOKEN_CIPHERTEXT,
        Ok(custody_token_envelope("testnet")),
    );
    let harness = bootstrap(AWS_PAIRS, kms);
    let outcome = provision_outcome(
        &harness,
        &bearer(RELEASED_TOKEN),
        json!({
            "MORPHEUS_RUNTIME_TOKEN_KMS_CIPHERTEXT_BASE64": RUNTIME_CIPHERTEXT,
            "MORPHEUS_ORACLE_KMS_CIPHERTEXT_BASE64": ORACLE_CIPHERTEXT,
            "MORPHEUS_NEODID_SALT_KMS_CIPHERTEXT_BASE64": NEODID_CIPHERTEXT,
            "SIGNER_SERVICE_TOKEN_KMS_CIPHERTEXT_BASE64": CUSTODY_TOKEN_CIPHERTEXT,
        }),
    );
    assert_eq!(outcome.status, 200, "{:?}", outcome.body);
    let overlay = harness.state.overlay.read().expect("overlay");
    assert_eq!(
        overlay.get_trimmed("MORPHEUS_ORACLE_KEY_SOURCE").as_deref(),
        Some("nitro-recipient-kms")
    );
    assert_eq!(
        overlay.get_trimmed("NEODID_SECRET_SALT_SOURCE").as_deref(),
        Some("nitro-recipient-kms")
    );
    assert_eq!(
        overlay.get_trimmed("NEODID_SECRET_SALT").as_deref(),
        Some(NEODID_SALT)
    );
    assert_eq!(
        overlay.get_trimmed("SIGNER_SERVICE_TOKEN").as_deref(),
        Some(CUSTODY_TOKEN)
    );
    assert_eq!(
        overlay
            .get_trimmed("SIGNER_SERVICE_TOKEN_SOURCE")
            .as_deref(),
        Some("nitro-recipient-kms")
    );
    let oracle: serde_json::Value = serde_json::from_str(
        &overlay
            .get_trimmed("MORPHEUS_ORACLE_KEY_MATERIAL_JSON")
            .expect("materialized key"),
    )
    .expect("oracle key JSON");
    assert_eq!(oracle["public_key_raw"], ORACLE_PUBLIC_KEY);
    assert!(
        !serde_json::to_string(&outcome.body)
            .expect("body")
            .contains(ORACLE_PRIVATE_KEY),
        "provision response leaked X25519 private material"
    );
    assert!(
        !serde_json::to_string(&outcome.body)
            .expect("body")
            .contains(NEODID_SALT),
        "provision response leaked the NeoDID salt"
    );
    assert!(
        !serde_json::to_string(&outcome.body)
            .expect("body")
            .contains(CUSTODY_TOKEN),
        "provision response leaked the custody caller token"
    );
}

#[test]
fn confidential_envelopes_are_purpose_and_network_bound() {
    for (ciphertext, plaintext) in [
        (ORACLE_CIPHERTEXT, oracle_envelope("mainnet")),
        (NEODID_CIPHERTEXT, neodid_envelope("mainnet")),
        (CUSTODY_TOKEN_CIPHERTEXT, custody_token_envelope("mainnet")),
    ] {
        let kms = FakeKms::releasing(RUNTIME_CIPHERTEXT, released_envelope(1, "testnet"));
        kms.set_result(ciphertext, Ok(plaintext));
        let harness = bootstrap(AWS_PAIRS, kms);
        let field = match ciphertext {
            ORACLE_CIPHERTEXT => "MORPHEUS_ORACLE_KMS_CIPHERTEXT_BASE64",
            NEODID_CIPHERTEXT => "MORPHEUS_NEODID_SALT_KMS_CIPHERTEXT_BASE64",
            _ => "SIGNER_SERVICE_TOKEN_KMS_CIPHERTEXT_BASE64",
        };
        let mut env = json!({
            "MORPHEUS_RUNTIME_TOKEN_KMS_CIPHERTEXT_BASE64": RUNTIME_CIPHERTEXT,
        });
        env.as_object_mut()
            .expect("env")
            .insert(field.to_string(), json!(ciphertext));
        let outcome = provision_outcome(&harness, &bearer(RELEASED_TOKEN), env);
        assert_eq!(outcome.status, 400, "{:?}", outcome.body);
        assert_eq!(
            harness
                .state
                .runtime_token_kms_version
                .load(std::sync::atomic::Ordering::SeqCst),
            0,
            "failed materialization must remain unprovisioned"
        );
    }
}

#[test]
fn rotation_requires_the_current_token() {
    let harness = bootstrap(
        AWS_PAIRS,
        FakeKms::releasing(RUNTIME_CIPHERTEXT, released_envelope(1, "testnet")),
    );
    let first = provision_outcome(
        &harness,
        &bearer(RELEASED_TOKEN),
        json!({ "MORPHEUS_RUNTIME_TOKEN_KMS_CIPHERTEXT_BASE64": RUNTIME_CIPHERTEXT }),
    );
    assert_eq!(first.status, 200, "{:?}", first.body);

    // After the first provision the trusted set IS the materialized token;
    // a rotation without it is a plain unauthorized.
    let second = provision_outcome(
        &harness,
        &bearer("wrong-rotation-token-wrong-rotation-token"),
        json!({ "MORPHEUS_RUNTIME_TOKEN_KMS_CIPHERTEXT_BASE64": RUNTIME_CIPHERTEXT }),
    );
    assert_eq!(second.status, 401);
    assert_eq!(second.body["error"], "unauthorized");
}

#[test]
fn provisioning_is_one_shot_even_with_an_older_envelope() {
    let harness = bootstrap(
        AWS_PAIRS,
        FakeKms::releasing(RUNTIME_CIPHERTEXT, released_envelope(2, "testnet")),
    );
    let first = provision_outcome(
        &harness,
        &bearer(RELEASED_TOKEN),
        json!({ "MORPHEUS_RUNTIME_TOKEN_KMS_CIPHERTEXT_BASE64": RUNTIME_CIPHERTEXT }),
    );
    assert_eq!(first.status, 200, "{:?}", first.body);

    // Version 1 arrives after version 2 is installed — 409, and the trusted
    // token stays the version-2 one.
    harness
        .kms
        .set_result(RUNTIME_CIPHERTEXT, Ok(released_envelope(1, "testnet")));
    let second = provision_outcome(
        &harness,
        &bearer(RELEASED_TOKEN),
        json!({ "MORPHEUS_RUNTIME_TOKEN_KMS_CIPHERTEXT_BASE64": RUNTIME_CIPHERTEXT }),
    );
    assert_eq!(second.status, 409);
    assert_eq!(
        second.body["error"],
        "provisioning is one-shot per enclave boot"
    );
    // The installed token is still the version-2 one.
    assert!(
        dispatch(
            &harness.state,
            "POST",
            "/keys/derived",
            &bearer(RELEASED_TOKEN),
            &body_json(&json!({ "role": "updater" })),
        )
        .status
            == 200
    );
}

#[test]
fn provisioning_is_one_shot_even_with_a_newer_envelope() {
    let harness = bootstrap(AWS_PAIRS, FakeKms::default());
    harness
        .kms
        .set_result(RUNTIME_CIPHERTEXT, Ok(released_envelope(1, "testnet")));
    let first = provision_outcome(
        &harness,
        &bearer(RELEASED_TOKEN),
        json!({ "MORPHEUS_RUNTIME_TOKEN_KMS_CIPHERTEXT_BASE64": RUNTIME_CIPHERTEXT }),
    );
    assert_eq!(first.status, 200);

    let newer_token = "rotation-token-abcdef0123456789abcdef0123456789";
    harness.kms.set_result(
        RUNTIME_CIPHERTEXT,
        Ok(serde_json::to_vec(&json!({
            "purpose": "neoos/nitro-runtime-auth/v1",
            "network": "testnet",
            "version": 2,
            "token": newer_token,
        }))
        .expect("env")),
    );
    let second = provision_outcome(
        &harness,
        &bearer(RELEASED_TOKEN),
        json!({ "MORPHEUS_RUNTIME_TOKEN_KMS_CIPHERTEXT_BASE64": RUNTIME_CIPHERTEXT }),
    );
    assert_eq!(second.status, 409, "{:?}", second.body);

    // The old token remains installed; the second envelope was never opened.
    assert!(
        dispatch(
            &harness.state,
            "POST",
            "/keys/derived",
            &bearer(RELEASED_TOKEN),
            &body_json(&json!({ "role": "updater" })),
        )
        .status
            == 200
    );
    assert!(
        dispatch(
            &harness.state,
            "POST",
            "/keys/derived",
            &bearer(newer_token),
            &body_json(&json!({ "role": "updater" })),
        )
        .status
            == 401
    );
}

#[test]
fn the_response_contract_matches_the_node_server() {
    let harness = bootstrap(
        AWS_PAIRS,
        FakeKms::releasing(RUNTIME_CIPHERTEXT, released_envelope(1, "testnet")),
    );
    let outcome = provision_outcome(
        &harness,
        &bearer(RELEASED_TOKEN),
        json!({
            "MORPHEUS_RUNTIME_TOKEN_KMS_CIPHERTEXT_BASE64": RUNTIME_CIPHERTEXT,
            "TWELVEDATA_API_KEY": "provider-one",
            "TD_KEY": "provider-two",
        }),
    );
    assert_eq!(outcome.status, 200);
    // Key order is part of the wire contract (preserve_order parity).
    let serialized = serde_json::to_string(&outcome.body).expect("body");
    assert!(serialized.starts_with(
        r#"{"status":"ok","runtime":"morpheus-enclave-server","network":"testnet","provisioned":true,"env_keys":"#
    ), "{serialized}");
    assert_eq!(
        outcome.body["env_keys"],
        json!([
            "MORPHEUS_RUNTIME_TOKEN_KMS_CIPHERTEXT_BASE64",
            "TD_KEY",
            "TWELVEDATA_API_KEY"
        ])
    );
    let roles = outcome.body["roles"].as_array().expect("roles");
    assert_eq!(roles[0]["role"], "updater");
    assert_eq!(roles[1]["role"], "oracle_verifier");
    assert_eq!(roles[0]["ok"], true);
    assert_eq!(roles[0]["key_source"], "kms_attested");
}

#[test]
fn a_degraded_signer_plane_degrades_the_provision_status() {
    let harness = test_state(
        AWS_PAIRS,
        FakeAttest::with_document(b"doc"),
        FakeSigner::unconfigured(),
        FakeBridge::new(),
        FakeKms::releasing(RUNTIME_CIPHERTEXT, released_envelope(1, "testnet")),
    );
    let outcome = provision_outcome(
        &harness,
        &bearer(RELEASED_TOKEN),
        json!({ "MORPHEUS_RUNTIME_TOKEN_KMS_CIPHERTEXT_BASE64": RUNTIME_CIPHERTEXT }),
    );
    assert_eq!(outcome.status, 200);
    assert_eq!(outcome.body["status"], "degraded");
    assert_eq!(outcome.body["roles"][0]["ok"], false);
}

#[test]
fn the_diag_probe_reports_the_kms_path_without_secrets() {
    let kms = FakeKms::releasing(RUNTIME_CIPHERTEXT, released_envelope(1, "testnet"));
    kms.set_result("diag-ciphertext", Ok(b"diag-plaintext".to_vec()));
    let harness = bootstrap(AWS_PAIRS, kms);
    let outcome = provision_outcome(
        &harness,
        &bearer(RELEASED_TOKEN),
        json!({
            "MORPHEUS_RUNTIME_TOKEN_KMS_CIPHERTEXT_BASE64": RUNTIME_CIPHERTEXT,
            "MORPHEUS_ORACLE_KMS_DIAG_CIPHERTEXT": "diag-ciphertext"
        }),
    );
    assert_eq!(outcome.status, 200, "{:?}", outcome.body);
    // The response carries the outcome, never the plaintext.
    assert!(!serde_json::to_string(&outcome.body)
        .expect("body")
        .contains("diag-plaintext"));
    let diag = harness
        .state
        .kms_diag
        .lock()
        .expect("diag lock")
        .value
        .clone();
    assert_eq!(diag, json!({ "state": "ok" }));
}

#[test]
fn an_unknown_name_is_rejected_before_bootstrap_or_diag() {
    let harness = bootstrap(AWS_PAIRS, FakeKms::default());
    let outcome = provision_outcome(&harness, &bearer("anything"), json!({ "HARMLESS": "1" }));
    assert_eq!(outcome.status, 400);
    assert!(outcome.body["error"]
        .as_str()
        .is_some_and(|message| message.contains("HARMLESS")));
    let diag = harness
        .state
        .kms_diag
        .lock()
        .expect("diag lock")
        .value
        .clone();
    assert_eq!(
        diag,
        json!({ "state": "not_run" }),
        "refused provisions run no diag"
    );
}

#[test]
fn the_region_resolution_prefers_the_payload_then_the_overlay() {
    let kms = FakeKms::releasing(RUNTIME_CIPHERTEXT, released_envelope(1, "testnet"));
    let harness = bootstrap(AWS_PAIRS, kms.clone());
    let outcome = provision_outcome(
        &harness,
        &bearer(RELEASED_TOKEN),
        json!({
            "MORPHEUS_RUNTIME_TOKEN_KMS_CIPHERTEXT_BASE64": RUNTIME_CIPHERTEXT,
            "AWS_REGION": "eu-west-1",
        }),
    );
    assert_eq!(outcome.status, 200);
    let calls = harness.kms.calls();
    assert_eq!(calls[0].region, "eu-west-1");
    assert_eq!(calls[0].access_key_id, "AKIDEXAMPLE");

    // Without a payload region the overlay's AWS_REGION (or the us-east-1
    // default) is used.
    let kms = FakeKms::releasing(RUNTIME_CIPHERTEXT, released_envelope(1, "testnet"));
    let harness = bootstrap(AWS_PAIRS, kms);
    provision_outcome(
        &harness,
        &bearer(RELEASED_TOKEN),
        json!({ "MORPHEUS_RUNTIME_TOKEN_KMS_CIPHERTEXT_BASE64": RUNTIME_CIPHERTEXT }),
    );
    assert_eq!(harness.kms.calls()[0].region, "us-east-1");
}

#[test]
fn temporary_credentials_rotate_only_on_the_separate_authorized_route() {
    let harness = bootstrap(
        AWS_PAIRS,
        FakeKms::releasing(RUNTIME_CIPHERTEXT, released_envelope(1, "testnet")),
    );
    assert_eq!(
        provision_outcome(
            &harness,
            &bearer(RELEASED_TOKEN),
            json!({ "MORPHEUS_RUNTIME_TOKEN_KMS_CIPHERTEXT_BASE64": RUNTIME_CIPHERTEXT }),
        )
        .status,
        200
    );

    let rotate = |headers: &http::HeaderMap, env: serde_json::Value| {
        dispatch(
            &harness.state,
            "POST",
            "/provision/credentials",
            headers,
            &body_json(&json!({ "env": env })),
        )
    };
    assert_eq!(
        rotate(
            &bearer(RELEASED_TOKEN),
            json!({
                "AWS_ACCESS_KEY_ID": "AKIDROTATED",
                "AWS_SECRET_ACCESS_KEY": "rotated-secret",
                "AWS_SESSION_TOKEN": "rotated-session",
            }),
        )
        .status,
        200
    );
    let overlay = harness.state.overlay.read().expect("overlay");
    assert_eq!(overlay.get("AWS_ACCESS_KEY_ID"), Some("AKIDROTATED"));
    assert_eq!(overlay.get("AWS_SECRET_ACCESS_KEY"), Some("rotated-secret"));
    assert_eq!(overlay.get("AWS_SESSION_TOKEN"), Some("rotated-session"));
    drop(overlay);

    assert_eq!(
        rotate(
            &bearer("wrong-token"),
            json!({
                "AWS_ACCESS_KEY_ID": "x",
                "AWS_SECRET_ACCESS_KEY": "y",
                "AWS_SESSION_TOKEN": "z",
            }),
        )
        .status,
        401
    );
    let forbidden = rotate(
        &bearer(RELEASED_TOKEN),
        json!({
            "AWS_ACCESS_KEY_ID": "x",
            "AWS_SECRET_ACCESS_KEY": "y",
            "AWS_SESSION_TOKEN": "z",
            "NODE_ENV": "development",
        }),
    );
    assert_eq!(forbidden.status, 400);
    assert!(forbidden.body["error"]
        .as_str()
        .expect("error")
        .contains("non-credential"));
}
