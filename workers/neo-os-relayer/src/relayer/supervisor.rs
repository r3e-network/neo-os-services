//! Independent v2 chain loops; the parent owns only progress aggregation and shutdown.
use super::*;
use tokio::sync::watch;
use tokio::task::JoinSet;

type Stop = Option<neo_os_service_runtime::ShutdownReason>;

pub(super) fn prepare_chain_workers(config: &RelayerConfig) -> Result<Vec<RelayerConfig>, String> {
    let original = load_or_init_state(&config.state_file)?;
    let mut chains = config.active_chains.clone();
    chains.sort();
    chains.dedup();
    if chains.is_empty() || chains.iter().any(|c| c != "neo_n3" && c != "neox") {
        return Err("v2 supervisor requires explicit supported active chains".into());
    }
    let mut children = Vec::new();
    for chain in chains {
        let mut child = config.clone();
        child.active_chains = vec![chain.clone()];
        child.instance_id = format!("{}:{chain}", config.instance_id);
        child.state_file = format!("{}.{chain}.json", config.state_file);
        // Only the parent emits aggregate heartbeats; child files retain lane detail.
        child
            .raw
            .as_object_mut()
            .ok_or("relayer config must be an object")?
            .insert("heartbeats".into(), serde_json::json!({}));
        if !Path::new(&child.state_file).exists() {
            let mut state = create_empty_relayer_state();
            if let Some(lane) = original.get(&chain) {
                state.set(&chain, lane.clone());
            }
            // The parent's old boolean may only cover another previously active
            // chain. Re-import this child's recovery lane idempotently once.
            if let Some(baselines) = original.get("feed_baselines") {
                state.set("feed_baselines", baselines.clone());
            }
            // Fresh per-worker counters prevent counting the old combined totals twice.
            save_state(&child.state_file, &state)?;
        }
        children.push(child);
    }
    Ok(children)
}

pub(super) fn aggregate_progress(
    config: &RelayerConfig,
    children: &[RelayerConfig],
    started_ms: f64,
    stopped: bool,
) -> Result<Value, String> {
    let now = now_ms();
    let mut state = load_or_init_state(&config.state_file)?;
    // Keep inactive chains' unimported recovery evidence, but sum only current
    // worker counters (a cutover resets the process counter epoch).
    state.set(
        "metrics",
        create_empty_relayer_state()
            .get("metrics")
            .expect("metric seed")
            .clone(),
    );
    let mut lanes = serde_json::Map::new();
    let mut healthy = !stopped;
    let mut oldest = now;
    let mut metrics_by_chain = JsObject::new();
    let mut labeled_failures = JsObject::new();
    for child in children {
        let chain = &child.active_chains[0];
        let snapshot = load_or_init_state(&child.state_file)?;
        if let Some(lane) = snapshot.get(chain) {
            state.set(chain, lane.clone());
        }
        let health = neo_os_relayer_store::state_file::load_state_json(Path::new(&format!(
            "{}.health.json",
            child.state_file
        )))
        .map_err(|e| e.to_string())?
        .unwrap_or(Value::Null);
        let checked = health
            .get("checked_at_ms")
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        let lane_healthy = health.get("healthy").and_then(Value::as_bool) == Some(true)
            && health.get("network").and_then(Value::as_str) == Some(config.network.as_str())
            && checked >= started_ms
            && checked <= now
            && now - checked
                <= (config
                    .poll_interval_ms
                    .saturating_mul(3)
                    .saturating_add(90000)) as f64;
        healthy &= lane_healthy;
        oldest = oldest.min(checked);
        lanes.insert(
            chain.clone(),
            serde_json::json!({"healthy":lane_healthy,"checked_at_ms":checked}),
        );
        if let Some(metrics) = snapshot.get("metrics").and_then(JsValue::as_object) {
            metrics_by_chain.set(chain, JsValue::Object(metrics.clone()));
            if let Some(labels) = metrics.get("labeled_failures").and_then(JsValue::as_object) {
                for (label, value) in labels.iter() {
                    if let JsValue::Number(count) = value {
                        if count.is_finite() && *count >= 0.0 {
                            let previous = match labeled_failures.get(label) {
                                Some(JsValue::Number(n)) => *n,
                                _ => 0.0,
                            };
                            labeled_failures.set(label, JsValue::Number(previous + count));
                        }
                    }
                }
            }
            for (key, value) in metrics.iter() {
                if key.ends_with("_total") {
                    if let JsValue::Number(count) = value {
                        if count.is_finite() && *count >= 0.0 {
                            increment_metric(&mut state, key, *count);
                        }
                    }
                }
            }
        }
    }
    if let Some(metrics) = state.get_mut("metrics").and_then(JsValue::as_object_mut) {
        metrics.set("chains", JsValue::Object(metrics_by_chain));
        metrics.set("labeled_failures", JsValue::Object(labeled_failures));
        metrics.set(
            "last_tick_completed_at",
            if oldest > 0.0 {
                JsValue::Str(ms_to_iso_string(oldest))
            } else {
                JsValue::Null
            },
        );
    }
    // Per-child files own import completion; a combined marker cannot prove
    // that every chain (including currently inactive ones) was imported.
    state.set("delivery_v2_local_imported", JsValue::Bool(false));
    save_state(&config.state_file, &state)?;
    let health = serde_json::json!({"checked_at_ms":now,"healthy":healthy,"network":config.network,
        "mode":config.mode,"protocol":"v2-supervisor","stopped":stopped,"chains":lanes});
    neo_os_relayer_store::state_file::save_state_json_atomic(
        Path::new(&format!("{}.health.json", config.state_file)),
        &health,
    )
    .map_err(|e| e.to_string())?;
    Ok(health)
}

async fn persist_progress(
    config: &RelayerConfig,
    children: &[RelayerConfig],
    started: f64,
    stopped: bool,
) -> Result<Value, String> {
    let config = config.clone();
    let children = children.to_vec();
    tokio::task::spawn_blocking(move || aggregate_progress(&config, &children, started, stopped))
        .await
        .map_err(|e| format!("supervisor progress task failed: {e}"))?
}

pub(super) async fn run_v2_loop_with_runtime_until<F>(config:&RelayerConfig,runtime:crate::transport::LoopRuntime,shutdown:F)->Result<(),String>
where F:Future<Output=neo_os_service_runtime::ShutdownReason> {
    let source = config.clone();
    let children = tokio::task::spawn_blocking(move || prepare_chain_workers(&source))
        .await
        .map_err(|e| format!("supervisor initialization failed: {e}"))??;
    let (stop_tx, stop_rx) = watch::channel(None);
    let mut tasks = JoinSet::new();
    for child in &children {
        let child = child.clone();
        let runtime=runtime.clone();
        let mut stop = stop_rx.clone();
        tasks.spawn(async move {
            let signal = async move {
                loop {
                    if let Some(reason) = *stop.borrow() {
                        return reason;
                    }
                    if stop.changed().await.is_err() {
                        return neo_os_service_runtime::ShutdownReason::Terminate;
                    }
                }
            };
            super::run_single_relayer_loop_with_runtime_until(&child, runtime, signal)
                .await
                .map_err(|e| e.to_string())
        });
    }
    supervise_chain_tasks_with_runtime(config, &children, tasks, stop_tx, runtime, shutdown).await
}

#[cfg(test)]
pub(super) async fn supervise_chain_tasks<F>(
    config: &RelayerConfig,
    children: &[RelayerConfig],
    tasks: JoinSet<Result<(), String>>,
    stop: watch::Sender<Stop>,
    shutdown: F,
) -> Result<(), String>
where
    F: Future<Output = neo_os_service_runtime::ShutdownReason>,
{
    supervise_chain_tasks_with_runtime(config,children,tasks,stop,crate::transport::LoopRuntime::default(),shutdown).await
}

async fn supervise_chain_tasks_with_runtime<F>(
    config:&RelayerConfig,children:&[RelayerConfig],mut tasks:JoinSet<Result<(),String>>,
    stop:watch::Sender<Stop>,runtime:crate::transport::LoopRuntime,shutdown:F,
)->Result<(),String>
where F:Future<Output=neo_os_service_runtime::ShutdownReason> {
    let started = now_ms();
    let mut interval = tokio::time::interval(Duration::from_millis(
        config.poll_interval_ms.clamp(250, 5000),
    ));
    tokio::pin!(shutdown);
    let mut failure = None;
    let mut progress_tasks: JoinSet<Result<Value, String>> = JoinSet::new();
    let mut heartbeat_task: Option<tokio::task::JoinHandle<bool>> = None;
    let reason = loop {
        tokio::select! {
            biased;
            reason = &mut shutdown => break reason,
            result = tasks.join_next() => {
                failure = Some(match result {
                    Some(Ok(Err(error))) => error,
                    Some(Err(error)) => format!("chain worker failed: {error}"),
                    _ => "chain worker exited before shutdown".into(),
                });
                break neo_os_service_runtime::ShutdownReason::Terminate;
            }
            result = progress_tasks.join_next(), if !progress_tasks.is_empty() => {
                match result {
                    Some(Ok(Ok(health))) => {
                        let healthy = health.get("healthy").and_then(Value::as_bool) == Some(true);
                        let path = if healthy && config.is_feed_only() {"/heartbeats/feedRelayer"}
                            else if healthy {"/heartbeats/relayer"} else {"/heartbeats/failure"};
                        let url = config.raw.pointer(path).and_then(Value::as_str).unwrap_or("");
                        if !url.is_empty() && heartbeat_task.as_ref().is_none_or(|task|task.is_finished()) {
                            let url=url.to_owned();
                            heartbeat_task=Some(tokio::spawn(async move {send_heartbeat(&url,Some(&health)).await}));
                        }
                    }
                    Some(Ok(Err(error))) => {failure=Some(error);break neo_os_service_runtime::ShutdownReason::Terminate;}
                    Some(Err(error)) => {failure=Some(error.to_string());break neo_os_service_runtime::ShutdownReason::Terminate;}
                    None => {},
                }
            }
            _ = interval.tick(), if progress_tasks.is_empty() => {
                let config=config.clone();let children=children.to_vec();
                progress_tasks.spawn_blocking(move || aggregate_progress(&config,&children,started,false));
            }
        }
    };
    // Heartbeat and filesystem work cannot postpone signaling the workers.
    if let Some(task) = heartbeat_task {
        task.abort();
        if runtime.strict_drain { let _=task.await; }
    }
    let _ = stop.send(Some(reason));
    let drain_ms = config
        .raw
        .get("shutdownDrainMs")
        .and_then(Value::as_u64)
        .unwrap_or(30000)
        .clamp(100, 120000);
    let drain = async {
        while let Some(result) = tasks.join_next().await {
            match result {
                Ok(Ok(())) => {}
                Ok(Err(error)) => {
                    failure.get_or_insert(error);
                }
                Err(error) => {
                    failure.get_or_insert_with(|| error.to_string());
                }
            }
        }
        while let Some(result) = progress_tasks.join_next().await {
            match result {
                Ok(Ok(_)) => {}
                Ok(Err(error)) => {
                    failure.get_or_insert(error);
                }
                Err(error) => {
                    failure.get_or_insert_with(|| error.to_string());
                }
            }
        }
        persist_progress(config, children, started, true).await
    };
    // Embedded dependencies must outlive every blocking operation. A deadline
    // may diagnose an unhealthy process, but cannot authorize detaching work.
    let drained = if runtime.strict_drain { Ok(drain.await) }
        else { tokio::time::timeout(Duration::from_millis(drain_ms),drain).await };
    match drained {
        Ok(Ok(_)) => {}
        Ok(Err(error)) => {
            failure.get_or_insert(error);
        }
        Err(_) => {
            tasks.abort_all();
            progress_tasks.abort_all();
            // No healthy marker is emitted from this path. A blocked OS write
            // is an operational shutdown failure; systemd's stop budget remains
            // the final bound for non-cancellable filesystem/blocking work.
            failure.get_or_insert_with(||"chain workers exceeded shutdown drain budget; signed jobs remain in durable recovery".into());
            persist_progress(config, children, started, true).await?;
        }
    }
    match failure {
        Some(error) => Err(error),
        None => Ok(()),
    }
}
