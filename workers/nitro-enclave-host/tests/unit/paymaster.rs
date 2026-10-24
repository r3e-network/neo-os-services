use crate::dispatch::dispatch;
use serde_json::json;

#[path = "support.rs"]
#[allow(clippy::duplicate_mod)]
mod support;
use support::*;

fn harness() -> TestState {
    test_state(
        &[
            ("MORPHEUS_NETWORK", TEST_NETWORK),
            ("NITRO_API_TOKEN", "s3cret"),
            ("MORPHEUS_PAYMASTER_TESTNET_ENABLED", "true"),
            ("MORPHEUS_PAYMASTER_TESTNET_POLICY_ID", "policy-1"),
        ],
        FakeAttest::with_document(b"doc"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::default(),
    )
}

#[test]
fn paymaster_authorize_runs_in_process_and_signs_the_verdict() {
    let harness = harness();
    let outcome = dispatch(
        &harness.state,
        "POST",
        "/paymaster/authorize",
        &bearer("s3cret"),
        &body_json(&json!({
            "account_id": "0x1234567890abcdef1234567890abcdef12345678",
            "target_contract": "0xabcdef1234567890abcdef1234567890abcdef12",
            "method": "transfer",
            "operation_hash": format!("0x{}", "00".repeat(31) + "01"),
            "estimated_gas_units": 100,
        })),
    );

    assert_eq!(outcome.status, 200, "{}", outcome.body);
    assert_eq!(outcome.body["mode"], "paymaster_authorize");
    assert_eq!(outcome.body["approved"], true);
    assert_eq!(outcome.body["policy_id"], "policy-1");
    assert_eq!(outcome.body["signature"], "00");
    assert_eq!(
        outcome.body["output_hash"],
        outcome.body["attestation_hash"]
    );
    assert_eq!(harness.signer.sign_calls().len(), 1);
}

#[test]
fn paymaster_validation_result_is_still_signed_and_caller_keys_are_refused() {
    let harness = harness();
    let invalid = dispatch(
        &harness.state,
        "POST",
        "/paymaster/authorize",
        &bearer("s3cret"),
        "{}",
    );
    assert_eq!(invalid.status, 200, "{}", invalid.body);
    assert_eq!(
        invalid.body["error"],
        "estimated_gas_units must be a positive number"
    );
    assert_eq!(invalid.body["signature"], "00");

    let caller_key = dispatch(
        &harness.state,
        "POST",
        "/paymaster/authorize",
        &bearer("s3cret"),
        r#"{"private_key":"forbidden","estimated_gas_units":1}"#,
    );
    assert_eq!(caller_key.status, 400);
    assert!(caller_key.body["error"]
        .as_str()
        .unwrap()
        .contains("caller-supplied signing key"));
}

#[test]
fn compatibility_sponsorship_fails_closed_without_the_node_approval_store() {
    let harness = test_state(
        &[
            ("MORPHEUS_NETWORK", TEST_NETWORK),
            ("NITRO_API_TOKEN", "s3cret"),
            ("MORPHEUS_PAYMASTER_TESTNET_ENABLED", "true"),
            ("MORPHEUS_ALLOW_TRANSACTION_SPONSORSHIP", "true"),
        ],
        FakeAttest::with_document(b"doc"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::default(),
    );
    let outcome = dispatch(
        &harness.state,
        "POST",
        "/paymaster/authorize",
        &bearer("s3cret"),
        &body_json(&json!({
            "account_id": "0x1234567890abcdef1234567890abcdef12345678",
            "target_contract": "0xabcdef1234567890abcdef1234567890abcdef12",
            "method": "transfer",
            "operation_hash": format!("0x{}", "00".repeat(31) + "01"),
            "estimated_gas_units": 100,
        })),
    );

    assert_eq!(outcome.status, 503, "{}", outcome.body);
    assert!(outcome.body["error"]
        .as_str()
        .unwrap()
        .contains("Node worker approval store"));
    assert_eq!(harness.signer.sign_calls().len(), 0);
}
