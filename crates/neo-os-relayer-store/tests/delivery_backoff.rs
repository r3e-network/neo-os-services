use neo_os_relayer_store::{
    BackoffState, HttpTransport, RequestOptions, SupabaseClient, SupabaseConfig,
};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc, Mutex,
};

struct Offline(Arc<AtomicUsize>);
impl HttpTransport for Offline {
    fn request(
        &self,
        _: &str,
        _: &str,
        _: &[(&str, &str)],
        _: Option<&str>,
    ) -> Result<(u16, String), String> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Err("connection refused".into())
    }
}
#[test]
fn network_failure_arms_shared_backoff_across_new_tick_clients() {
    let calls = Arc::new(AtomicUsize::new(0));
    let backoff = Arc::new(Mutex::new(BackoffState::new()));
    for tick in [1000, 2000, 10000] {
        let client = SupabaseClient::with_backoff(
            Offline(calls.clone()),
            SupabaseConfig::new("https://db.example", "test", "testnet"),
            backoff.clone(),
        );
        assert!(client
            .request(
                "rpc/morpheus_delivery_claim",
                "POST",
                None,
                &RequestOptions::default(),
                tick
            )
            .is_err());
    }
    assert_eq!(
        calls.load(Ordering::SeqCst),
        1,
        "only the first tick may contact the unavailable database"
    );
}

#[test]
fn durable_event_survives_postgres_nul_sanitization_losslessly() {
    struct Echo;
    impl HttpTransport for Echo {
        fn request(
            &self,
            _: &str,
            _: &str,
            _: &[(&str, &str)],
            body: Option<&str>,
        ) -> Result<(u16, String), String> {
            let body: serde_json::Value = serde_json::from_str(body.unwrap()).unwrap();
            let event = body["p_event"].clone();
            assert!(event.get("event_base64").is_some());
            Ok((200,serde_json::json!({"job_key":"test","generation":0,"attempts":0,"event":event,"journal":{},"status":"queued","kind":"request","contract":"oracle","chain":"neo_n3"}).to_string()))
        }
    }
    let client = SupabaseClient::new(
        Echo,
        SupabaseConfig::new("https://db.example", "test", "testnet"),
    );
    let event =
        serde_json::json!({"requestId":"7","payload":"prefix\u{0000}suffix","operation":"compute"});
    let job = neo_os_relayer_store::delivery::DeliveryStore { client: &client }
        .enqueue("neo_n3", "oracle", "updater", &event, 1000)
        .unwrap();
    assert_eq!(job.event, event);
}
