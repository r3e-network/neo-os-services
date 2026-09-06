use crate::dispatch::dispatch;
use serde_json::json;

#[path = "support.rs"]
#[allow(clippy::duplicate_mod)]
mod support;
use support::*;

#[test]
fn vrf_random_is_signed_by_custody_with_the_canonical_envelope() {
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
        &body_json(&json!({ "request_id": "req-1" })),
    );

    assert_eq!(outcome.status, 200, "{}", outcome.body);
    assert_eq!(outcome.body["request_id"], "req-1");
    assert_eq!(outcome.body["vrf_method"], "csprng-signed");
    assert_eq!(outcome.body["randomness"].as_str().unwrap().len(), 64);
    assert_eq!(outcome.body["signature"], "00");
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
        &healthy_overlay(),
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
