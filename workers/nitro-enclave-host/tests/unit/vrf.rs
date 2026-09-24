use crate::dispatch::dispatch;
use serde_json::json;

#[path = "support.rs"]
#[allow(clippy::duplicate_mod)]
mod support;
use support::*;

const TEST_VRF_ROOT: &str = "1111111111111111111111111111111111111111111111111111111111111111";

fn vrf_overlay() -> Vec<(&'static str, &'static str)> {
    let mut overlay = healthy_overlay();
    overlay.push(("MORPHEUS_GAME_SECRET_ROOT_HEX", TEST_VRF_ROOT));
    overlay.push(("MORPHEUS_GAME_SECRET_ROOT_SOURCE", "nitro-recipient-kms"));
    overlay
}

#[test]
fn vrf_random_is_signed_by_custody_with_the_canonical_envelope() {
    let harness = test_state(
        &vrf_overlay(),
        FakeAttest::with_document(b"doc"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::default(),
    );
    let outcome = dispatch(
        &harness.state,
        "POST",
        "/vrf/random",
        &bearer("s3cret"),
        &body_json(&json!({ "request_id": "req-1" })),
    );

    assert_eq!(outcome.status, 200, "{}", outcome.body);
    assert_eq!(outcome.body["request_id"], "req-1");
    assert_eq!(outcome.body["vrf_method"], "hmac-sha256-signed");
    assert_eq!(outcome.body["randomness"].as_str().unwrap().len(), 64);
    assert_eq!(outcome.body["signature"], "00");
    assert_eq!(outcome.body["public_key"], healthy_identity()["public_key"]);
    assert_eq!(
        outcome.body["output_hash"],
        outcome.body["attestation_hash"]
    );
    assert!(outcome.body["timestamp"].as_u64().unwrap() > 0);

    let signed_hex = &harness.signer.sign_calls()[0].2;
    let signed_json = String::from_utf8(hex::decode(signed_hex).unwrap()).unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&signed_json).unwrap(),
        json!({ "randomness": outcome.body["randomness"] })
    );
}

#[test]
fn vrf_random_requires_auth_and_never_accepts_caller_keys() {
    let harness = test_state(
        &vrf_overlay(),
        FakeAttest::with_document(b"doc"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::default(),
    );
    let unauthenticated = dispatch(
        &harness.state,
        "POST",
        "/vrf/random",
        &http::HeaderMap::new(),
        "{}",
    );
    assert_eq!(unauthenticated.status, 401);

    let caller_key = dispatch(
        &harness.state,
        "POST",
        "/vrf/random",
        &bearer("s3cret"),
        r#"{"private_key":"forbidden"}"#,
    );
    assert_eq!(caller_key.status, 400);
    assert!(caller_key.body["error"]
        .as_str()
        .unwrap()
        .contains("caller-supplied signing key"));
}

#[test]
fn vrf_request_id_preserves_string_and_number_json_types() {
    for request_id in [json!("req-string"), json!(42)] {
        let harness = test_state(
            &vrf_overlay(),
            FakeAttest::with_document(b"doc"),
            FakeSigner::healthy(),
            FakeBridge::new(),
            FakeKms::default(),
        );
        let outcome = dispatch(
            &harness.state,
            "POST",
            "/vrf/random",
            &bearer("s3cret"),
            &body_json(&json!({ "request_id": request_id })),
        );

        assert_eq!(outcome.status, 200, "{}", outcome.body);
        assert_eq!(outcome.body["request_id"], request_id);

        let signed_hex = &harness.signer.sign_calls()[0].2;
        let signed_json = String::from_utf8(hex::decode(signed_hex).unwrap()).unwrap();
        let signed_value = serde_json::from_str::<serde_json::Value>(&signed_json).unwrap();
        assert_eq!(
            signed_value,
            json!({ "randomness": outcome.body["randomness"] }),
            "request metadata must not change the canonical signed value"
        );
    }
}

#[test]
fn vrf_random_is_deterministic_and_bound_to_the_request_domain() {
    let harness = test_state(
        &vrf_overlay(),
        FakeAttest::with_document(b"doc"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::default(),
    );
    let first = dispatch(
        &harness.state,
        "POST",
        "/vrf/random",
        &bearer("s3cret"),
        &body_json(&json!({ "request_id": "bound-1", "module_id": "random.generate" })),
    );
    let second = dispatch(
        &harness.state,
        "POST",
        "/vrf/random",
        &bearer("s3cret"),
        &body_json(&json!({ "request_id": "bound-1", "module_id": "random.generate" })),
    );
    assert_eq!(first.status, 200, "{}", first.body);
    assert_eq!(second.status, 200, "{}", second.body);
    assert_eq!(first.body["randomness"], second.body["randomness"]);
    assert_eq!(
        first.body["randomness"],
        "8bb793ed0cb627eeb5ceb860984c54a4ae14f0f1ed65336b78613426219a0fa7"
    );

    let changed_request = dispatch(
        &harness.state,
        "POST",
        "/vrf/random",
        &bearer("s3cret"),
        &body_json(&json!({ "request_id": "bound-2", "module_id": "random.generate" })),
    );
    assert_ne!(first.body["randomness"], changed_request.body["randomness"]);

    let changed_network = dispatch(
        &harness.state,
        "POST",
        "/vrf/random",
        &bearer("s3cret"),
        &body_json(&json!({
            "request_id": "bound-1",
            "module_id": "random.generate",
            "network": "mainnet"
        })),
    );
    assert_eq!(changed_network.status, 200, "{}", changed_network.body);
    assert_ne!(first.body["randomness"], changed_network.body["randomness"]);
}

#[test]
fn vrf_random_refuses_without_the_kms_materialized_root() {
    let harness = test_state(
        &healthy_overlay(),
        FakeAttest::with_document(b"doc"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::default(),
    );
    let outcome = dispatch(
        &harness.state,
        "POST",
        "/vrf/random",
        &bearer("s3cret"),
        &body_json(&json!({ "request_id": "missing-root" })),
    );
    assert_eq!(outcome.status, 503);
    assert!(outcome.body["error"].as_str().unwrap().contains("VRF key"));
    assert!(harness.signer.sign_calls().is_empty());
}

#[test]
fn vrf_random_refuses_every_explicit_noncanonical_module_id() {
    for module_id in [
        json!(""),
        json!("random.other"),
        json!(null),
        json!(42),
        json!(false),
        json!([]),
        json!({}),
    ] {
        let harness = test_state(
            &vrf_overlay(),
            FakeAttest::with_document(b"doc"),
            FakeSigner::healthy(),
            FakeBridge::new(),
            FakeKms::default(),
        );
        let outcome = dispatch(
            &harness.state,
            "POST",
            "/vrf/random",
            &bearer("s3cret"),
            &body_json(&json!({ "request_id": "bad-module", "module_id": module_id })),
        );
        assert_eq!(outcome.status, 400, "{}", outcome.body);
        assert!(outcome.body["error"]
            .as_str()
            .unwrap()
            .contains("module_id"));
        assert!(harness.signer.sign_calls().is_empty());
    }
}

#[test]
fn vrf_random_refuses_untrusted_or_malformed_kms_roots() {
    let short_root = "11".repeat(31);
    let long_root = "11".repeat(33);
    let cases = [
        ("wrong-source", TEST_VRF_ROOT),
        ("nitro-recipient-kms", "not-hex"),
        ("nitro-recipient-kms", short_root.as_str()),
        ("nitro-recipient-kms", long_root.as_str()),
    ];
    for (source, root) in cases {
        let mut overlay = healthy_overlay();
        overlay.push(("MORPHEUS_GAME_SECRET_ROOT_HEX", root));
        overlay.push(("MORPHEUS_GAME_SECRET_ROOT_SOURCE", source));
        let harness = test_state(
            &overlay,
            FakeAttest::with_document(b"doc"),
            FakeSigner::healthy(),
            FakeBridge::new(),
            FakeKms::default(),
        );
        let outcome = dispatch(
            &harness.state,
            "POST",
            "/vrf/random",
            &bearer("s3cret"),
            &body_json(&json!({ "request_id": "bad-root" })),
        );
        assert_eq!(outcome.status, 503, "{}", outcome.body);
        assert!(harness.signer.sign_calls().is_empty());
    }
}

#[test]
fn vrf_random_refuses_all_caller_key_aliases_before_custody() {
    for field in ["private_key", "signing_key", "wif"] {
        let harness = test_state(
            &vrf_overlay(),
            FakeAttest::with_document(b"doc"),
            FakeSigner::healthy(),
            FakeBridge::new(),
            FakeKms::default(),
        );
        let mut body = json!({ "request_id": "caller-key" });
        body[field] = json!("forbidden");
        let outcome = dispatch(
            &harness.state,
            "POST",
            "/vrf/random",
            &bearer("s3cret"),
            &body_json(&body),
        );
        assert_eq!(outcome.status, 400, "{}", outcome.body);
        assert!(outcome.body["error"]
            .as_str()
            .unwrap()
            .contains("caller-supplied signing key"));
        assert!(harness.signer.sign_calls().is_empty());
    }
}

#[test]
fn vrf_random_carries_custody_failure_without_a_local_fallback() {
    let signer = FakeSigner::new(SignerConfig {
        sign_result: Some(Err(crate::RuntimeError {
            status: 503,
            message: "custody unavailable".to_string(),
        })),
        ..SignerConfig::default()
    });
    let harness = test_state(
        &vrf_overlay(),
        FakeAttest::with_document(b"doc"),
        signer,
        FakeBridge::new(),
        FakeKms::default(),
    );
    let outcome = dispatch(
        &harness.state,
        "POST",
        "/vrf/random",
        &bearer("s3cret"),
        &body_json(&json!({ "request_id": "custody-failure" })),
    );
    assert_eq!(outcome.status, 503, "{}", outcome.body);
    assert!(outcome.body.get("randomness").is_none());
    assert!(harness.signer.sign_calls().len() == 1);
}

#[test]
fn vrf_random_refuses_a_custody_identity_contradiction() {
    let signer = FakeSigner::new(SignerConfig {
        sign_result: Some(Ok(json!({
            "status": "ok",
            "signature": "00",
            "public_key": healthy_identity()["public_key"],
            "address": "NWRONG",
            "script_hash": healthy_identity()["script_hash"],
        }))),
        ..SignerConfig::default()
    });
    let harness = test_state(
        &vrf_overlay(),
        FakeAttest::with_document(b"doc"),
        signer,
        FakeBridge::new(),
        FakeKms::default(),
    );
    let outcome = dispatch(
        &harness.state,
        "POST",
        "/vrf/random",
        &bearer("s3cret"),
        &body_json(&json!({ "request_id": "identity-mismatch" })),
    );
    assert_eq!(outcome.status, 503, "{}", outcome.body);
    assert!(outcome.body.get("randomness").is_none());
    assert_eq!(harness.signer.sign_calls().len(), 1);
}
