use super::*;
use neo_signer::{
    api::ApiState,
    service::{Outcome, SignerService},
    store::Store,
    vault::MasterKey,
};

fn raw_request(path: &str) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri(path)
        .header("content-type", "application/json")
        .header("authorization", "Bearer synthetic-cancellation-caller")
        .body(Body::from(
            r#"{"key_id":"synthetic-key","data_hex":"0102"}"#,
        ))
        .unwrap()
}

fn dual_shim(routers: BTreeMap<String, Router>) -> ShimState {
    let profiles = NetworkProfiles {
        explicit: true,
        overlays: ["mainnet", "testnet"]
            .into_iter()
            .map(|network| {
                (
                    network.to_string(),
                    EnvOverlay::new([("MORPHEUS_NETWORK", network)]),
                )
            })
            .collect(),
    };
    ShimState {
        apps: Arc::new(build_apps(profiles, &routers)),
        custody: Arc::new(routers),
        explicit_network: true,
        max_body_bytes: 262144,
        request_slots: Arc::new(tokio::sync::Semaphore::new(MAX_INFLIGHT_REQUESTS)),
        #[cfg(feature = "embedded-relayer")]
        relayer: None,
    }
}

fn health_request(network: &str) -> Request<Body> {
    Request::builder()
        .uri(format!("/{network}/custody/health"))
        .body(Body::empty())
        .unwrap()
}

#[test]
fn native_cancellation_retains_global_admission() {
    let dir = tempfile::tempdir().unwrap();
    let service = SignerService::new(
        Store::open(dir.path().join("signer.db")).unwrap(),
        MasterKey::from_bytes([19; 32]),
    );
    let locked = service.clone();
    let (started, recv_started) = std::sync::mpsc::channel();
    let (release, recv_release) = std::sync::mpsc::channel();
    let holder = std::thread::spawn(move || {
        locked
            .execute_observable(
                neo_signer::model::SignerAuditAction::KeyViewed,
                None,
                || {
                    started.send(()).unwrap();
                    recv_release
                        .recv_timeout(std::time::Duration::from_secs(8))
                        .expect("bounded probe release");
                    Ok(Outcome::Allowed(()))
                },
            )
            .unwrap();
    });
    recv_started
        .recv_timeout(std::time::Duration::from_secs(2))
        .unwrap();
    let router = neo_signer::api::router(ApiState::new(service).with_max_in_flight_requests(1));
    let testnet_service = SignerService::new(
        Store::open(dir.path().join("testnet.db")).unwrap(),
        MasterKey::from_bytes([20; 32]),
    );
    let shim = dual_shim(BTreeMap::from([
        ("mainnet".to_string(), router.clone()),
        (
            "testnet".to_string(),
            neo_signer::api::router(ApiState::new(testnet_service)),
        ),
    ]));
    let runtime = host_runtime();
    let (before, after, busy, other_before, other_full, recovered) = runtime.block_on(async {
        let request = tokio::spawn(serve(
            State(shim.clone()),
            raw_request("/mainnet/custody/signer/api/v1/sign/raw"),
        ));
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(1);
        while shim.request_slots.available_permits() == MAX_INFLIGHT_REQUESTS
            && tokio::time::Instant::now() < deadline
        {
            tokio::task::yield_now().await;
        }
        // A second native request cannot start while the first native request owns its slot.
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        let before = shim.request_slots.available_permits();
        request.abort();
        let cancelled = request.await.is_err_and(|e| e.is_cancelled());
        let after = shim.request_slots.available_permits();
        // The request middleware was cancelled, but the real native blocking operation remains alive.
        let busy = tokio::time::timeout(
            std::time::Duration::from_millis(100),
            router
                .clone()
                .oneshot(raw_request("/signer/api/v1/sign/raw")),
        )
        .await
        .ok()
        .map(|r| r.unwrap().status());
        let other_before = serve(State(shim.clone()), health_request("testnet"))
            .await
            .status();
        let remaining = shim
            .request_slots
            .clone()
            .try_acquire_many_owned((MAX_INFLIGHT_REQUESTS - 1) as u32)
            .ok();
        let other_full = if remaining.is_some() {
            Some(
                serve(State(shim.clone()), health_request("testnet"))
                    .await
                    .status(),
            )
        } else {
            None
        };
        drop(remaining);
        let _ = release.send(());
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(2);
        while shim.request_slots.available_permits() != MAX_INFLIGHT_REQUESTS
            && tokio::time::Instant::now() < deadline
        {
            tokio::time::sleep(std::time::Duration::from_millis(1)).await;
        }
        let recovered = shim.request_slots.available_permits();
        assert!(cancelled);

        (before, after, busy, other_before, other_full, recovered)
    });
    holder.join().unwrap();
    runtime.shutdown_timeout(std::time::Duration::from_secs(2));
    eprintln!("NATIVE_CANCELLATION before={before} after={after} native_busy_after={busy:?}");
    assert_eq!(
        before,
        MAX_INFLIGHT_REQUESTS - 1,
        "real serve held global admission"
    );
    assert_eq!(
        busy,
        Some(StatusCode::SERVICE_UNAVAILABLE),
        "real native detached work still owns native blocking budget"
    );
    assert_eq!(
        after, before,
        "global admission must survive cancelled native serve while native work is still running"
    );
    assert_eq!(
        other_before,
        StatusCode::OK,
        "other network remains available within shared capacity"
    );
    assert_eq!(
        other_full,
        Some(StatusCode::SERVICE_UNAVAILABLE),
        "other network shares the same sixteen-slot budget"
    );
    assert_eq!(
        recovered, MAX_INFLIGHT_REQUESTS,
        "completed detached work releases its shared slot"
    );
}

#[test]
fn native_task_failure_is_closed_and_releases_global_admission() {
    let router = Router::new().route(
        "/health",
        axum::routing::get(|| async {
            panic!("synthetic native handler failure");
            #[allow(unreachable_code)]
            StatusCode::OK
        }),
    );
    let shim = dual_shim(BTreeMap::from([("mainnet".to_string(), router)]));
    let runtime = host_runtime();
    let response = runtime.block_on(serve(State(shim.clone()), health_request("mainnet")));
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(
        shim.request_slots.available_permits(),
        MAX_INFLIGHT_REQUESTS
    );
    runtime.shutdown_timeout(std::time::Duration::from_secs(2));
}
