use super::*;

#[test]
fn an_unmigrated_fulfillment_lane_refuses_without_io() {
    let reply = UnavailableLegacyCompute.forward(
        "/session/finalize",
        &serde_json::json!({ "secret": "never-forwarded" }),
        Some("never-forwarded"),
    );

    assert!(!reply.ok);
    assert_eq!(reply.status, 503);
    assert_eq!(reply.body["status"], "error");
    assert_eq!(reply.body["code"], UNAVAILABLE_CODE);
    assert_eq!(
        reply.body["error"],
        "the /session/finalize fulfillment lane has not migrated to Rust"
    );
    assert_eq!(reply.body["runtime"], RUNTIME_NAME);
}
