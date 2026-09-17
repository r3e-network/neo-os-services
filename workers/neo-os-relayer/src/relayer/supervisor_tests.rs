use super::*;

fn config() -> RelayerConfig {
    static SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    RelayerConfig {
        repo_root: String::new(),
        instance_id: "supervisor-test".into(),
        state_file: std::env::temp_dir()
            .join(format!(
                "neoos-supervisor-{}-{}-{}.json",
                std::process::id(),
                SEQUENCE.fetch_add(1, Ordering::SeqCst),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ))
            .to_string_lossy()
            .into_owned(),
        network: "testnet".into(),
        node_env: "test".into(),
        mode: "combined".into(),
        active_chains: vec!["neo_n3".into(), "neox".into()],
        poll_interval_ms: 10,
        concurrency: 1,
        max_blocks_per_tick: 1,
        discovery_idle_backoff_ms: 1,
        state_persist_min_interval_ms: 1,
        raw: serde_json::json!({"deliveryProtocol":"v2","heartbeats":{"relayer":"https://must-not-be-used.test"}}),
    }
}
fn cleanup(config: &RelayerConfig, children: &[RelayerConfig]) {
    for path in std::iter::once(config.state_file.as_str())
        .chain(children.iter().map(|c| c.state_file.as_str()))
    {
        std::fs::remove_file(path).ok();
        std::fs::remove_file(format!("{path}.health.json")).ok();
    }
}
#[test]
fn split_preserves_each_recovery_lane_and_never_overwrites_existing_children() {
    let cfg = config();
    let mut parent = create_empty_relayer_state();
    parent
        .get_mut("neo_n3")
        .unwrap()
        .as_object_mut()
        .unwrap()
        .set(
            "retry_queue",
            JsValue::from_json(&serde_json::json!([{"key":"pending-n3"}])),
        );
    parent
        .get_mut("neox")
        .unwrap()
        .as_object_mut()
        .unwrap()
        .set(
            "dead_letters",
            JsValue::from_json(&serde_json::json!([{"key":"pending-x"}])),
        );
    save_state(&cfg.state_file, &parent).unwrap();
    let children = prepare_chain_workers(&cfg).unwrap();
    assert_eq!(children.len(), 2);
    assert_ne!(children[0].state_file, children[1].state_file);
    assert_eq!(children[0].active_chains, vec!["neo_n3"]);
    assert!(children[0].raw.pointer("/heartbeats/relayer").is_none());
    let n3 = load_or_init_state(&children[0].state_file).unwrap();
    assert!(js_value_to_json_for_test(&n3)
        .to_string()
        .contains("pending-n3"));
    assert!(!js_value_to_json_for_test(&n3)
        .to_string()
        .contains("pending-x"));
    let old = std::fs::read(&children[0].state_file).unwrap();
    prepare_chain_workers(&cfg).unwrap();
    assert_eq!(std::fs::read(&children[0].state_file).unwrap(), old);
    cleanup(&cfg, &children);
}
fn js_value_to_json_for_test(value: &JsObject) -> Value {
    crate::config::js_value_to_json(&JsValue::Object(value.clone()))
}

#[tokio::test]
async fn slow_worker_does_not_block_healthy_worker_and_shutdown_drains_both() {
    use std::sync::atomic::AtomicUsize;
    let cfg = config();
    let children = prepare_chain_workers(&cfg).unwrap();
    let (stop_tx, stop_rx) = tokio::sync::watch::channel(None);
    let progress = Arc::new(AtomicUsize::new(0));
    let drained = Arc::new(AtomicUsize::new(0));
    let mut tasks = tokio::task::JoinSet::new();
    for slow in [true, false] {
        let mut stop = stop_rx.clone();
        let progress = progress.clone();
        let drained = drained.clone();
        tasks.spawn(async move {
   loop {
    tokio::select! {
     result=stop.changed()=>{if result.is_err()||stop.borrow().is_some(){drained.fetch_add(1,Ordering::SeqCst);return Ok::<(),String>(());}},
     _=tokio::time::sleep(Duration::from_millis(if slow{10000}else{5}))=>{if !slow{progress.fetch_add(1,Ordering::SeqCst);}}
    }
   }
  });
    }
    let ready = progress.clone();
    let shutdown = async move {
        while ready.load(Ordering::SeqCst) < 3 {
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
        neo_os_service_runtime::ShutdownReason::Terminate
    };
    tokio::time::timeout(
        Duration::from_secs(2),
        supervise_chain_tasks(&cfg, &children, tasks, stop_tx, shutdown),
    )
    .await
    .expect("fast lane cannot be blocked by slow lane")
    .unwrap();
    assert!(progress.load(Ordering::SeqCst) >= 3);
    assert_eq!(drained.load(Ordering::SeqCst), 2);
    assert!(
        runtime_health(&cfg).is_err(),
        "stopped process must not leave healthy status"
    );
    cleanup(&cfg, &children);
}

#[test]
fn aggregation_preserves_inactive_recovery_and_feed_baselines() {
    let mut cfg = config();
    cfg.active_chains = vec!["neo_n3".into()];
    let mut state = create_empty_relayer_state();
    state.get_mut("neox").unwrap().as_object_mut().unwrap().set(
        "dead_letters",
        JsValue::from_json(&serde_json::json!([{"key":"inactive-neox"}])),
    );
    state.set("delivery_v2_local_imported", JsValue::Bool(true));
    state.set(
        "feed_baselines",
        JsValue::from_json(&serde_json::json!({"NEO/USD":{"round":42}})),
    );
    save_state(&cfg.state_file, &state).unwrap();
    let children = prepare_chain_workers(&cfg).unwrap();
    let child = load_or_init_state(&children[0].state_file).unwrap();
    assert!(
        child.get("feed_baselines").is_some(),
        "new child must retain baseline for DB seed"
    );
    assert_ne!(
        child.get("delivery_v2_local_imported"),
        Some(&JsValue::Bool(true)),
        "a parent marker may only cover a previously active chain"
    );
    supervisor::aggregate_progress(&cfg, &children, now_ms(), false).unwrap();
    let parent = load_or_init_state(&cfg.state_file).unwrap();
    assert!(
        js_value_to_json_for_test(&parent)
            .to_string()
            .contains("inactive-neox"),
        "{}: {}",
        cfg.state_file,
        js_value_to_json_for_test(&parent)
    );
    cleanup(&cfg, &children);
}

#[test]
fn aggregate_health_requires_every_current_lane_and_sums_only_worker_counters() {
    let cfg = config();
    let children = prepare_chain_workers(&cfg).unwrap();
    let checked = now_ms();
    for (index, child) in children.iter().enumerate() {
        let mut state = load_or_init_state(&child.state_file).unwrap();
        increment_metric(&mut state, "ticks_total", (index + 2) as f64);
        save_state(&child.state_file, &state).unwrap();
        neo_os_relayer_store::state_file::save_state_json_atomic(
            Path::new(&format!("{}.health.json", child.state_file)),
            &serde_json::json!({"checked_at_ms":checked,"healthy":true,"network":"testnet"}),
        )
        .unwrap();
    }
    let health = supervisor::aggregate_progress(&cfg, &children, checked - 1.0, false).unwrap();
    assert_eq!(health["healthy"], true);
    let state = js_value_to_json_for_test(&load_or_init_state(&cfg.state_file).unwrap());
    assert_eq!(state["metrics"]["ticks_total"], 5.0);
    // The aggregate must not accumulate its previous aggregate again.
    supervisor::aggregate_progress(&cfg, &children, checked - 1.0, false).unwrap();
    let state = js_value_to_json_for_test(&load_or_init_state(&cfg.state_file).unwrap());
    assert_eq!(state["metrics"]["ticks_total"], 5.0);
    neo_os_relayer_store::state_file::save_state_json_atomic(
        Path::new(&format!("{}.health.json", children[1].state_file)),
        &serde_json::json!({"checked_at_ms":0,"healthy":true,"network":"testnet"}),
    )
    .unwrap();
    let health = supervisor::aggregate_progress(&cfg, &children, checked - 1.0, false).unwrap();
    assert_eq!(health["healthy"], false);
    cleanup(&cfg, &children);
}

#[tokio::test]
async fn shutdown_has_a_budget_for_a_worker_that_does_not_cooperate() {
    let mut cfg = config();
    cfg.raw["shutdownDrainMs"] = serde_json::json!(100);
    let children = prepare_chain_workers(&cfg).unwrap();
    let (stop, _) = tokio::sync::watch::channel(None);
    let mut tasks = tokio::task::JoinSet::new();
    tasks.spawn(async { std::future::pending::<Result<(), String>>().await });
    let result = tokio::time::timeout(
        Duration::from_secs(2),
        supervise_chain_tasks(&cfg, &children, tasks, stop, async {
            neo_os_service_runtime::ShutdownReason::Terminate
        }),
    )
    .await
    .expect("shutdown budget");
    assert!(result.unwrap_err().contains("drain budget"));
    assert!(runtime_health(&cfg).is_err());
    cleanup(&cfg, &children);
}

#[test]
fn aggregate_preserves_labeled_failures_for_existing_metrics_readers() {
    let cfg = config();
    let children = prepare_chain_workers(&cfg).unwrap();
    for child in &children {
        let mut state = load_or_init_state(&child.state_file).unwrap();
        state
            .get_mut("metrics")
            .unwrap()
            .as_object_mut()
            .unwrap()
            .set(
                "labeled_failures",
                JsValue::from_json(&serde_json::json!({"neo_n3|rpc|scan":2,"neox|rpc|scan":1})),
            );
        save_state(&child.state_file, &state).unwrap();
    }
    supervisor::aggregate_progress(&cfg, &children, now_ms(), false).unwrap();
    let snapshot = snapshot_metrics(&load_or_init_state(&cfg.state_file).unwrap(), now_ms());
    let value = js_value_to_json_for_test(&snapshot);
    assert_eq!(value["labeled_failures"].as_array().unwrap().len(), 2);
    assert_eq!(value["labeled_failures"][0]["value"], 4.0);
    cleanup(&cfg, &children);
}

#[tokio::test]
async fn shutdown_interrupts_an_inflight_local_heartbeat() {
    let mut cfg = config();
    cfg.raw["shutdownDrainMs"] = serde_json::json!(100);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    cfg.raw["heartbeats"]["failure"] =
        serde_json::json!(format!("http://{}", listener.local_addr().unwrap()));
    let (accepted_tx, accepted_rx) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        let (_stream, _) = listener.accept().await.unwrap();
        let _ = accepted_tx.send(());
        std::future::pending::<()>().await;
    });
    let children = prepare_chain_workers(&cfg).unwrap();
    let (stop, mut receiver) = tokio::sync::watch::channel(None);
    let mut tasks = tokio::task::JoinSet::new();
    tasks.spawn(async move {
        let _ = receiver.changed().await;
        Ok(())
    });
    let shutdown = async {
        let _ = accepted_rx.await;
        neo_os_service_runtime::ShutdownReason::Terminate
    };
    let result = tokio::time::timeout(
        Duration::from_secs(1),
        supervise_chain_tasks(&cfg, &children, tasks, stop, shutdown),
    )
    .await;
    server.abort();
    cleanup(&cfg, &children);
    assert!(
        result.is_ok(),
        "heartbeat I/O must not hide shutdown beyond the drain budget"
    );
    assert!(result.unwrap().is_ok());
}
