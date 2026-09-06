use serde_json::{json, Value};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use neo_os_relayer_store::*;

/// Scripted in-memory HTTP transport for testing Supabase PostgREST interactions.
#[allow(clippy::type_complexity)]
struct MockSupabaseTransport {
    pub requests: Mutex<Vec<(String, String, Vec<(String, String)>, Option<String>)>>,
    pub responder: Box<
        dyn Fn(&str, &str, &[(&str, &str)], Option<&str>) -> Result<(u16, String), String>
            + Send
            + Sync,
    >,
}

impl MockSupabaseTransport {
    fn new<F>(responder: F) -> Self
    where
        F: Fn(&str, &str, &[(&str, &str)], Option<&str>) -> Result<(u16, String), String>
            + Send
            + Sync
            + 'static,
    {
        Self {
            requests: Mutex::new(Vec::new()),
            responder: Box::new(responder),
        }
    }
}

impl HttpTransport for MockSupabaseTransport {
    fn request(
        &self,
        method: &str,
        url: &str,
        headers: &[(&str, &str)],
        body: Option<&str>,
    ) -> Result<(u16, String), String> {
        let headers_owned: Vec<(String, String)> = headers
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        self.requests.lock().unwrap().push((
            method.to_string(),
            url.to_string(),
            headers_owned,
            body.map(|s| s.to_string()),
        ));
        (self.responder)(method, url, headers, body)
    }
}

#[test]
fn test_sanitize_for_postgres_removes_null_bytes() {
    let input = json!({
        "text": "hello\u{0000}world\u{0000}",
        "array": ["a\u{0000}b", "clean", 123],
        "nested": {
            "val": "foo\u{0000}bar"
        },
        "clean": 456
    });
    let sanitized = sanitize_for_postgres(&input);
    assert_eq!(sanitized["text"], "helloworld");
    assert_eq!(sanitized["array"][0], "ab");
    assert_eq!(sanitized["array"][1], "clean");
    assert_eq!(sanitized["array"][2], 123);
    assert_eq!(sanitized["nested"]["val"], "foobar");
    assert_eq!(sanitized["clean"], 456);
}

#[test]
fn test_error_classification_and_backoff_transitions() {
    // 1. Quota errors
    assert!(is_supabase_quota_restricted_error(
        "failed: 402 Payment Required"
    ));
    assert!(is_supabase_quota_restricted_error("exceed_db_size_quota"));
    assert!(is_transient_durable_queue_error(
        "database size quota exceeded"
    ));

    // 2. Connectivity errors
    assert!(is_supabase_connectivity_error("PGRST002"));
    assert!(is_supabase_connectivity_error(
        "failed: 503 Service Unavailable"
    ));
    assert!(is_supabase_connectivity_error(
        "connection to database not available"
    ));
    assert!(is_supabase_connectivity_error("request timed out"));
    assert!(is_transient_durable_queue_error("502 Bad Gateway"));

    // 3. Backoff transitions
    let mut state = BackoffState::with_durations(300_000, 30_000);
    assert!(!state.should_skip(1000));

    // Connectivity error -> arms 30s
    assert!(state.mark_unavailable("PGRST002 schema cache error", 1000));
    assert!(state.should_skip(1000));
    assert!(state.should_skip(30_000));
    assert!(!state.should_skip(31_001));
    let info = state.get_backoff(1000).unwrap();
    assert_eq!(info.reason, "connectivity");
    assert_eq!(info.until_ms, 31_000);

    // Quota error -> arms 5m (300s)
    assert!(state.mark_unavailable("failed: 402 exceed_db_size_quota", 1000));
    let info = state.get_backoff(1000).unwrap();
    assert_eq!(info.reason, "quota_restricted");
    assert_eq!(info.until_ms, 301_000);

    // Sticky quota: another connectivity blip does NOT shorten the 5m quota window
    assert!(state.mark_unavailable("timed out", 2000));
    let info = state.get_backoff(2000).unwrap();
    assert_eq!(info.reason, "quota_restricted");
    assert_eq!(info.until_ms, 301_000);
}

#[test]
fn test_rest_request_formatting_and_prefer_headers() {
    let transport = MockSupabaseTransport::new(|method, url, headers, _body| {
        if method == "POST" && url.contains("/morpheus_relayer_jobs") {
            let prefer = headers
                .iter()
                .find(|(k, _)| k.eq_ignore_ascii_case("prefer"));
            assert!(prefer.is_some());
            assert!(prefer.unwrap().1.contains("resolution=merge-duplicates"));
            return Ok((201, "[]".into()));
        }
        Ok((200, "[]".into()))
    });

    let config = SupabaseConfig::new("https://test.supabase.co", "secret-key", "testnet");
    let client = SupabaseClient::new(&transport, config);

    let job_record = json!({
        "event_key": "neo_n3:100:0",
        "chain": "neo_n3",
        "request_id": "100",
        "status": "queued"
    });

    let res = upsert_relayer_job(&client, &job_record, 1000);
    assert!(res.is_ok());

    let reqs = transport.requests.lock().unwrap();
    assert_eq!(reqs.len(), 1);
    let (method, url, headers, body) = &reqs[0];
    assert_eq!(method, "POST");
    assert!(url.contains("https://test.supabase.co/rest/v1/morpheus_relayer_jobs"));
    assert!(url.contains("on_conflict=network%2Cevent_key"));

    let apikey = headers
        .iter()
        .find(|(k, _)| k == "apikey")
        .map(|(_, v)| v.as_str());
    assert_eq!(apikey, Some("secret-key"));
    let auth = headers
        .iter()
        .find(|(k, _)| k == "authorization")
        .map(|(_, v)| v.as_str());
    assert_eq!(auth, Some("Bearer secret-key"));

    let body_val: Value = serde_json::from_str(body.as_ref().unwrap()).unwrap();
    assert_eq!(body_val["network"], "testnet");
    assert_eq!(body_val["request_id"], "100");
}

#[test]
fn test_s4_manual_action_signing_and_verification() {
    let secret = "top-secret-hmac-key";
    let action = "relayer_upsert";
    let network = "testnet";
    let event_key = "neo_n3:42:0";
    let event = json!({
        "chain": "neo_n3",
        "requestId": "42",
        "requestType": "compute.execute",
        "payloadText": "{\"op\":\"add\"}",
        "requester": "0x1122334455667788990011223344556677889900",
        "callbackContract": "0xaabbccddeeff00112233445566778899aabbccdd",
        "callbackMethod": "onResult"
    });

    // Valid event check
    assert!(assert_db_event_well_formed(&event).is_ok());

    // Whitespace in requestType must be rejected
    let mut bad_event = event.clone();
    bad_event["requestType"] = json!("compute. execute");
    assert!(assert_db_event_well_formed(&bad_event).is_err());

    // Missing field must be rejected
    let mut missing_field = event.clone();
    missing_field["requester"] = json!("");
    assert!(assert_db_event_well_formed(&missing_field).is_err());

    // Sign and verify
    let sig = sign_manual_action(secret, action, network, event_key, &event);
    assert_eq!(sig.len(), 64);
    assert!(verify_manual_action_signature(
        secret, action, network, event_key, &event, &sig
    ));

    // Tampered payload fails verification
    let mut tampered = event.clone();
    tampered["payloadText"] = json!("{\"op\":\"sub\"}");
    assert!(!verify_manual_action_signature(
        secret, action, network, event_key, &tampered, &sig
    ));

    // Wrong secret fails verification
    assert!(!verify_manual_action_signature(
        "wrong-secret",
        action,
        network,
        event_key,
        &event,
        &sig
    ));
}

#[test]
fn test_durable_queue_claim_optimistic_concurrency_no_double_claim() {
    // Shared simulated PostgREST table row state across concurrent relayer instances
    let row_claimed = Arc::new(AtomicUsize::new(0));

    let transport_sim = {
        let row_claimed = row_claimed.clone();
        MockSupabaseTransport::new(move |method, url, _headers, _body| {
            if method == "PATCH" && url.contains("morpheus_relayer_jobs") {
                // If claim was already granted (state != 0), PostgREST or=(...) filter
                // will match 0 rows and return empty array [].
                // If not yet claimed, atomic compare_exchange wins and returns representation [row].
                if row_claimed
                    .compare_exchange(0, 1, Ordering::SeqCst, Ordering::SeqCst)
                    .is_ok()
                {
                    let granted_row = json!([{
                        "event_key": "neo_n3:7:0",
                        "status": "processing",
                        "attempts": 1
                    }]);
                    Ok((200, granted_row.to_string()))
                } else {
                    // Conflict: 0 rows returned
                    Ok((200, "[]".into()))
                }
            } else {
                Ok((200, "[]".into()))
            }
        })
    };

    let config = SupabaseConfig::new("https://test.supabase.co", "key", "testnet");
    let client = SupabaseClient::new(&transport_sim, config);

    let claim_config_1 = DurableClaimConfig {
        durable_queue_enabled: true,
        allow_local_claim_during_backoff: false,
        stale_processing_ms: 120_000,
        instance_id: "instance-A",
    };
    let claim_config_2 = DurableClaimConfig {
        durable_queue_enabled: true,
        allow_local_claim_during_backoff: false,
        stale_processing_ms: 120_000,
        instance_id: "instance-B",
    };

    let res_1 = claim_durable_job_for_processing(
        &client,
        "neo_n3:7:0",
        false,
        0,
        &claim_config_1,
        "2026-09-04T12:00:00.000Z",
        "2026-09-04T11:58:00.000Z",
        1000,
    )
    .unwrap();

    let res_2 = claim_durable_job_for_processing(
        &client,
        "neo_n3:7:0",
        false,
        0,
        &claim_config_2,
        "2026-09-04T12:00:00.000Z",
        "2026-09-04T11:58:00.000Z",
        1000,
    )
    .unwrap();

    // Exactly one instance is Granted, the other is Conflict!
    assert_eq!(res_1, ClaimDecision::Granted);
    assert_eq!(res_2, ClaimDecision::Conflict);
}

#[test]
fn test_quarantine_below_request_id_numerical_comparison() {
    let transport = MockSupabaseTransport::new(|method, url, _headers, body| {
        if method == "GET" && url.contains("morpheus_relayer_jobs") {
            // Return text request_ids: "9", "10", "11", "5"
            let rows = json!([
                {"event_key": "k1", "request_id": "9", "last_error": "timeout"},
                {"event_key": "k2", "request_id": "10", "last_error": "timeout"},
                {"event_key": "k3", "request_id": "11", "last_error": "timeout"},
                {"event_key": "k4", "request_id": "5", "last_error": "timeout"},
            ]);
            return Ok((200, rows.to_string()));
        }
        if method == "PATCH" && url.contains("morpheus_relayer_jobs") {
            let body_val: Value = serde_json::from_str(body.unwrap()).unwrap();
            assert_eq!(body_val["status"], "stale_quarantined");
            return Ok((200, "[]".into()));
        }
        Ok((200, "[]".into()))
    });

    let config = SupabaseConfig::new("https://test.supabase.co", "key", "testnet");
    let client = SupabaseClient::new(&transport, config);

    // Floor = 10. Rows below 10 are "9" and "5" (2 rows).
    // Text comparison would say "10" < "9", but numeric comparison knows 9 < 10 and 5 < 10!
    let patched = quarantine_relayer_jobs_below_request_id(
        &client,
        "neo_n3",
        10,
        &["queued", "processing"],
        "stale floor test",
        "2026-09-04T12:00:00.000Z",
        1000,
    )
    .unwrap();

    assert_eq!(patched, 2);
}

#[test]
fn test_atomic_state_file_save_and_load() {
    let tmp_dir = std::env::temp_dir().join(format!("relayer-store-test-{}", std::process::id()));
    let state_path = tmp_dir.join("relayer_state.json");

    let initial_state = json!({
        "cursor": {"neo_n3": 12345},
        "metrics": {"ticks_total": 42}
    });

    save_state_json_atomic(&state_path, &initial_state).unwrap();
    let loaded = load_state_json(&state_path).unwrap().expect("file exists");
    assert_eq!(loaded["cursor"]["neo_n3"], 12345);
    assert_eq!(loaded["metrics"]["ticks_total"], 42);

    // Test coalescing persistor
    let mut persistor = RelayerStatePersistor::new(&state_path, 100);
    assert!(!persistor.is_dirty());

    let mut state = initial_state.clone();
    state["metrics"]["ticks_total"] = json!(43);

    // First persist at t=0 flushes immediately
    let flushed = persistor.persist(&state, 0).unwrap();
    assert!(flushed);
    assert!(!persistor.is_dirty());

    // Next persist at t=50 (< 100ms interval) does NOT flush, marks dirty
    state["metrics"]["ticks_total"] = json!(44);
    let flushed = persistor.persist(&state, 50).unwrap();
    assert!(!flushed);
    assert!(persistor.is_dirty());

    // Flush explicitly
    persistor.flush(&state, 50).unwrap();
    assert!(!persistor.is_dirty());

    let reloaded = load_state_json(&state_path).unwrap().unwrap();
    assert_eq!(reloaded["metrics"]["ticks_total"], 44);

    let _ = std::fs::remove_dir_all(&tmp_dir);
}

#[test]
fn test_parse_timestamp_ms_and_is_durable_queue_ready_job() {
    // 1. parse_timestamp_ms
    let iso = json!("2026-09-04T12:00:00.000Z");
    let ms = parse_timestamp_ms(Some(&iso));
    assert!(ms > 0);

    let num = json!(1700000000000u64);
    assert_eq!(parse_timestamp_ms(Some(&num)), 1700000000000);

    let none: Option<&Value> = None;
    assert_eq!(parse_timestamp_ms(none), 0);

    // 2. is_durable_queue_ready_job
    // Queued is always ready
    let queued = json!({"status": "queued"});
    assert!(is_durable_queue_ready_job(&queued, 1000, 120_000));

    // Retry scheduled: ready if next_retry_at <= now_ms
    let retry_due = json!({
        "status": "retry_scheduled",
        "next_retry_at": 1000
    });
    assert!(is_durable_queue_ready_job(&retry_due, 1000, 120_000));
    assert!(is_durable_queue_ready_job(&retry_due, 2000, 120_000));
    assert!(!is_durable_queue_ready_job(&retry_due, 500, 120_000));

    // Processing: ready only if stale (now_ms - updated_at >= stale_processing_ms)
    let processing = json!({
        "status": "processing",
        "updated_at": 1000
    });
    assert!(!is_durable_queue_ready_job(&processing, 50_000, 120_000));
    assert!(is_durable_queue_ready_job(&processing, 121_000, 120_000));
}
