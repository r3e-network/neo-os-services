//! Injected transports only. Never opens a socket or authenticates with a server.
use neo_os_relayer_store::{
    BackoffState, HttpTransport, RequestOptions, SupabaseClient, SupabaseConfig,
};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

type CapturedRequest = (String, String, Vec<(String, String)>, Value);

#[derive(Clone, Default)]
struct Capture(Arc<Mutex<Vec<CapturedRequest>>>);

impl HttpTransport for Capture {
    fn request(
        &self,
        method: &str,
        url: &str,
        headers: &[(&str, &str)],
        body: Option<&str>,
    ) -> Result<(u16, String), String> {
        self.0.lock().unwrap().push((
            method.into(),
            url.into(),
            headers
                .iter()
                .map(|(k, v)| ((*k).into(), (*v).into()))
                .collect(),
            serde_json::from_str(body.unwrap_or("null")).unwrap(),
        ));
        Ok((200, "null".into()))
    }
}

fn scoped(capture: Capture, network: &str) -> SupabaseClient<Capture> {
    SupabaseClient::new(
        capture,
        SupabaseConfig::new("https://store.invalid", "public-api-canary", network),
    )
    .with_rpc_auth("scoped-bearer-canary".into(), "neoos_relayer_v2".into())
}

#[test]
fn scoped_requests_separate_public_key_bearer_and_profile() {
    let capture = Capture::default();
    let client = scoped(capture.clone(), "mainnet");
    for name in [
        "enqueue",
        "claim",
        "transition",
        "checkpoint",
        "feed_baseline",
        "account_health",
    ] {
        client
            .request(
                &format!("rpc/morpheus_delivery_{name}"),
                "POST",
                Some(&json!({"p_network":"mainnet"})),
                &RequestOptions::default(),
                1000,
            )
            .unwrap();
    }
    let calls = capture.0.lock().unwrap();
    assert_eq!(calls.len(), 6);
    for (method, url, headers, body) in calls.iter() {
        assert_eq!(method, "POST");
        assert!(url.starts_with("https://store.invalid/rest/v1/rpc/morpheus_delivery_"));
        let header = |name: &str| {
            headers
                .iter()
                .find(|(k, _)| k.eq_ignore_ascii_case(name))
                .unwrap()
                .1
                .as_str()
        };
        assert_eq!(header("apikey"), "public-api-canary");
        assert_eq!(header("authorization"), "Bearer scoped-bearer-canary");
        assert_eq!(header("content-profile"), "neoos_relayer_v2");
        assert_eq!(header("accept-profile"), "neoos_relayer_v2");
        assert_eq!(body["p_network"], "mainnet");
    }
}

#[test]
fn tables_maintenance_wrong_network_and_method_never_reach_transport() {
    let capture = Capture::default();
    let client = scoped(capture.clone(), "mainnet");
    for (route, method, network) in [
        ("morpheus_delivery_jobs", "POST", "mainnet"),
        ("rpc/morpheus_delivery_replay", "POST", "mainnet"),
        ("rpc/morpheus_delivery_import_legacy", "POST", "mainnet"),
        ("rpc/morpheus_delivery_sponsor_reserve", "POST", "mainnet"),
        ("rpc/morpheus_delivery_claim", "GET", "mainnet"),
        ("rpc/morpheus_delivery_claim", "POST", "testnet"),
        ("rpc/morpheus_delivery_claim?admin=true", "POST", "mainnet"),
    ] {
        assert!(client
            .request(
                route,
                method,
                Some(&json!({"p_network":network})),
                &RequestOptions::default(),
                1000
            )
            .is_err());
    }
    assert!(client
        .request(
            "rpc/morpheus_delivery_claim",
            "POST",
            None,
            &RequestOptions::default(),
            1000
        )
        .is_err());
    for options in [
        RequestOptions {
            query: vec![("select".into(), "*".into())],
            ..Default::default()
        },
        RequestOptions {
            on_conflict: Some("job_key".into()),
            ..Default::default()
        },
    ] {
        assert!(client
            .request(
                "rpc/morpheus_delivery_claim",
                "POST",
                Some(&json!({"p_network":"mainnet"})),
                &options,
                1000
            )
            .is_err());
    }
    assert!(capture.0.lock().unwrap().is_empty());
}

#[test]
fn delivery_baseline_read_is_scoped_and_seed_is_refused() {
    let capture = Capture::default();
    let client = scoped(capture.clone(), "testnet");
    let store = neo_os_relayer_store::delivery::DeliveryStore { client: &client };
    store.feed_baseline("neo_n3", "oracle", 1000).unwrap();
    assert_eq!(capture.0.lock().unwrap()[0].3["p_network"], "testnet");
    assert!(store
        .seed_feed_baseline("neo_n3", "oracle", &json!({"synthetic":true}), 1000)
        .is_err());
    assert_eq!(capture.0.lock().unwrap().len(), 1);
}

#[test]
fn bearer_refresh_does_not_reset_shared_quota_backoff() {
    let capture = Capture::default();
    let state = Arc::new(Mutex::new(BackoffState::new()));
    state
        .lock()
        .unwrap()
        .mark_unavailable("quota exceeded", 1000);
    for bearer in ["old-synthetic", "new-synthetic"] {
        let client = SupabaseClient::with_backoff(
            capture.clone(),
            SupabaseConfig::new("https://store.invalid", "public", "testnet"),
            state.clone(),
        )
        .with_rpc_auth(bearer.into(), "neoos_relayer_v2".into());
        assert!(client
            .request(
                "rpc/morpheus_delivery_claim",
                "POST",
                Some(&json!({"p_network":"testnet"})),
                &RequestOptions::default(),
                2000
            )
            .is_err());
    }
    assert!(capture.0.lock().unwrap().is_empty());
}
