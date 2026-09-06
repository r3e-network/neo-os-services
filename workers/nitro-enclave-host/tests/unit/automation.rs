use super::*;
use serde_json::json;

#[path = "support.rs"]
#[allow(clippy::duplicate_mod)]
mod support;
use support::*;

#[test]
fn executes_real_nested_work_and_enforces_idempotency() {
    reset_executions_for_tests();
    let harness = test_state(
        &healthy_overlay(),
        FakeAttest::with_document(b"doc"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::default(),
    );
    let payload = json!({
        "automation_id": "automation:test:1",
        "chain": "neo_n3",
        "execution_count": 2,
        "idempotency_key": "automation-host-test:3",
        "execution": {
            "request_type": "compute_hash",
            "payload": {
                "function": "hash.sha256",
                "input": { "value": 7 },
            },
        },
    });

    let first = handle_automation_execute(&harness.state, &payload).expect("execution");
    assert_eq!(first.status, 200, "{}", first.body);
    assert_eq!(first.body["status"], "completed");
    assert_eq!(first.body["success"], true);
    assert_eq!(first.body["worker_route"], "/compute/execute");
    assert_eq!(first.body["result"]["function"], "hash.sha256");
    assert_eq!(harness.signer.sign_calls().len(), 1);

    let replay = handle_automation_execute(&harness.state, &payload).expect("replay");
    assert_eq!(
        replay, first,
        "a replay returns the original completed result"
    );
    assert_eq!(harness.signer.sign_calls().len(), 1, "no second execution");

    let mut conflict = payload.clone();
    conflict["execution"]["payload"]["input"] = json!({ "value": 8 });
    let error = handle_automation_execute(&harness.state, &conflict)
        .expect_err("same key cannot change work");
    assert_eq!(error.status, 409);

    let recursive = json!({
        "automation_id": "automation:test:2",
        "execution_request_type": "automation_cancel",
        "execution_payload": {},
    });
    assert_eq!(
        handle_automation_execute(&harness.state, &recursive)
            .expect_err("recursion refused")
            .status,
        400
    );
}
