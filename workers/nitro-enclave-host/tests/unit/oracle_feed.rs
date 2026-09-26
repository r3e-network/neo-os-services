use super::*;
use serde_json::json;

#[path = "support.rs"]
#[allow(clippy::duplicate_mod)]
mod support;
use support::*;

fn json_reply(body: &str) -> neo_os_compute::transport::HttpResponse {
    neo_os_compute::transport::HttpResponse {
        status: 200,
        headers: vec![("content-type".to_string(), "application/json".to_string())],
        body: body.as_bytes().to_vec(),
    }
}

#[test]
fn explicit_unknown_network_fails_before_feed_fetch_or_signing() {
    reset_feed_state_for_tests();
    let harness = test_state(
        &[
            ("MORPHEUS_NETWORK", TEST_NETWORK),
            ("NITRO_API_TOKEN", "s3cret"),
        ],
        FakeAttest::with_document(b"doc"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::default(),
    );

    let error = handle_oracle_feed(
        &harness.state,
        &json!({ "network": "staging", "symbols": ["NEO-USD"], "wait": true }),
    )
    .expect_err("unknown network must fail closed");
    assert_eq!(error.status, 400);
    assert!(error.message.contains("unsupported Neo network"));
    assert!(harness.oracle_io.fetches().is_empty());
    assert!(harness.signer.sign_calls().is_empty());
}

#[test]
fn fetches_aggregates_signs_and_persists_but_fails_when_updates_cannot_be_submitted() {
    reset_feed_state_for_tests();
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let base_path = std::env::temp_dir().join(format!(
        "neo-os-host-feed-{}-{nonce}.json",
        std::process::id()
    ));
    let base_text = base_path.to_string_lossy().to_string();
    let overlay = [
        ("MORPHEUS_NETWORK", TEST_NETWORK),
        ("NITRO_API_TOKEN", "s3cret"),
        ("TWELVEDATA_API_KEY", "test-key"),
        ("MORPHEUS_FEED_STATE_PATH", base_text.as_str()),
    ];
    let harness = test_state(
        &overlay,
        FakeAttest::with_document(b"doc"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::default(),
    );
    harness.oracle_io.set_now_ms(1_700_000_001_000);
    harness
        .oracle_io
        .set_reply(Ok(json_reply(r#"{"price":"12.5","timestamp":1700000000}"#)));

    let payload = json!({
        "symbols": ["NEO-USD"],
        "providers": ["twelvedata", "binance-spot"],
        "wait": true,
    });
    let outcome = handle_oracle_feed(&harness.state, &payload).expect("feed run");
    assert_eq!(outcome.status, 503, "{}", outcome.body);
    assert_eq!(outcome.body["mode"], "pricefeed");
    assert_eq!(outcome.body["batch_submitted"], false);
    assert_eq!(outcome.body["batch_count"], 2);
    assert_eq!(outcome.body["submission_required"], false);
    assert!(outcome.body["error"]
        .as_str()
        .expect("submission error")
        .contains("owned by the Rust relayer"));
    assert_eq!(outcome.body["state_persisted"], true);
    assert!(outcome.body["aggregations"]["NEO-USD"].is_object());
    assert!(outcome.body["sync_results"]
        .as_array()
        .expect("sync results")
        .iter()
        .filter(|entry| entry["provider"] != "aggregate")
        .all(|entry| {
            entry["relay_status"] == "skipped" && entry["skip_reason"] == "submission_unavailable"
        }));
    assert!(outcome.body["errors"]
        .to_string()
        .contains("submission transport is not configured"));

    // Each provider performs a real signed oracle read and then receives the
    // canonical quote signature. No child bridge or placeholder path runs.
    assert_eq!(harness.oracle_io.fetches().len(), 2);
    assert_eq!(harness.signer.sign_calls().len(), 4);
    assert!(harness.bridge.forwards().is_empty());

    let scoped = scoped_feed_state_path(&base_path, TEST_NETWORK, "neo_n3");
    let persisted: Json =
        serde_json::from_str(&std::fs::read_to_string(&scoped).expect("scoped state persisted"))
            .expect("state json");
    for key in ["TWELVEDATA:NEO-USD", "BINANCE-SPOT:NEO-USD", "AGG:NEO-USD"] {
        assert!(persisted["records"][key].is_object(), "missing {key}");
    }
    assert!(persisted["records"]["TWELVEDATA:NEO-USD"]
        .get("price")
        .is_none());
    assert_eq!(
        persisted["records"]["TWELVEDATA:NEO-USD"]["last_observed_price"],
        "12.5"
    );

    let fast = handle_oracle_feed(
        &harness.state,
        &json!({ "symbol": "NEO-USD", "fast_ack": true }),
    )
    .expect("structured refusal");
    assert_eq!(fast.status, 409);
    assert_eq!(fast.body["accepted"], false);

    let _ = std::fs::remove_file(scoped);
    let _ = std::fs::remove_file(base_path);
}
