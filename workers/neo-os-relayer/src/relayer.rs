//! High-level relayer tick and continuous loop orchestration.
//!
//! Pinned against `workers/morpheus-relayer/src/relayer.js`.

use std::future::Future;
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use neo_os_chain_evm::SystemEvmWaiter;
use neo_os_chain_n3::tx::{OsNonce, SystemWaiter};
use neo_os_core::js_value::{JsObject, JsValue};
use neo_os_core::state::{
    create_empty_relayer_state, increment_metric, ms_to_iso_string, normalize_state_file_value,
    snapshot_metrics,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::automation::{process_automation_jobs, AutomationResult};
use crate::durable::{drain_durable_jobs, DurableDrainConfig};
use crate::config::RelayerConfig;
use crate::feed_sync::{process_feed_sync_with, FeedSyncResult};
use crate::heartbeat::send_heartbeat;
use crate::scan::{process_chain_neo_n3, process_chain_neox, ChainProcessResult};
use crate::transport::RelayerHttpTransport;
use crate::xcm_lane::{drain_xcm_lane, relay_xcm_message, XcmDrainConfig, XcmDrainOutcome, XCM_DEFAULT_MAX_RETRIES, XCM_DEFAULT_RETRY_BASE_DELAY_MS, XCM_DEFAULT_RETRY_MAX_DELAY_MS};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RelayerRunResult {
    pub instance_id: String,
    pub mode: String,
    pub neo_n3: Option<ChainProcessResult>,
    pub neox: Option<ChainProcessResult>,
    pub feed_sync: FeedSyncResult,
    pub automation: AutomationResult,
    pub state: Value,
    pub metrics: Value,
}

pub fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as f64
}

pub fn load_or_init_state(path_str: &str) -> Result<JsObject, String> {
    let p = Path::new(path_str);
    if !p.exists() {
        return Ok(create_empty_relayer_state());
    }
    let content = std::fs::read_to_string(p)
        .map_err(|error| format!("cannot read relayer state {}: {error}", p.display()))?;
    let parsed = serde_json::from_str::<Value>(&content)
        .map_err(|error| format!("relayer state {} is not recoverable JSON: {error}", p.display()))?;
    let js_val = JsValue::from_json(&parsed);
    Ok(normalize_state_file_value(&js_val))
}

/// Report the first active chain whose request discovery failed this tick.
/// A skipped lane (chain not in active set / misconfigured) is not unhealthy;
/// an attempted lane that could not resolve its RPC/cursor is. This decides
/// whether the tick is a success heartbeat or a failure (review P2-15): an
/// empty successful scan and a failed discovery must not both report healthy.
pub fn unresolved_discovery_chain<'a>(
    neo_n3: &'a Option<ChainProcessResult>,
    neox: &'a Option<ChainProcessResult>,
) -> Option<String> {
    [neo_n3.as_ref(), neox.as_ref()]
        .into_iter()
        .flatten()
        .find(|result| !result.skipped && !result.discovery_healthy)
        .map(|result| format!("{} discovery unavailable", result.chain))
}

pub fn save_state(path_str: &str, state: &JsObject) -> Result<(), String> {
    let serde_val = crate::config::js_value_to_json(&JsValue::Object(state.clone()));
    let content = serde_json::to_string_pretty(&serde_val).map_err(|e| e.to_string())?;
    neo_os_relayer_store::state_file::save_state_file_atomic(Path::new(path_str), &content)
        .map_err(|e| e.to_string())
}

fn run_relayer_once_blocking(
    config: &RelayerConfig,
    transport: &RelayerHttpTransport,
) -> Result<RelayerRunResult, String> {
    let mut state = load_or_init_state(&config.state_file)?;
    let start_ms = now_ms();
    let start_iso = ms_to_iso_string(start_ms);

    if let Some(metrics) = state.get_mut("metrics").and_then(|v| v.as_object_mut()) {
        metrics.set("last_tick_started_at", JsValue::Str(start_iso));
    }
    increment_metric(&mut state, "ticks_total", 1.0);

    // 1. Feed sync
    let feed_sync = if config.should_run_feed_sync() {
        process_feed_sync_with(
            config,
            &mut state,
            start_ms,
            transport,
            &SystemEvmWaiter,
            &OsNonce,
        )
    } else {
        FeedSyncResult {
            enabled: false,
            skipped: true,
            reason: Some("mode is requests_only".to_string()),
            delay_ms: None,
            duration_ms: None,
            error: None,
        }
    };

    // 2. Neo N3
    let neo_n3 = if config.should_run_request_processing()
        && config.active_chains.contains(&"neo_n3".to_string())
    {
        Some(process_chain_neo_n3(
            config, &mut state, transport, start_ms,
        ))
    } else {
        None
    };

    // 3. NeoX
    let neox = if config.should_run_request_processing()
        && config.active_chains.contains(&"neox".to_string())
    {
        Some(process_chain_neox(config, &mut state, transport, start_ms))
    } else {
        None
    };

    // 4. Automation
    let automation = if config.should_run_request_processing() {
        process_automation_jobs(config, &mut state)
    } else {
        AutomationResult {
            skipped: true,
            reason: Some("mode is feed_only".to_string()),
            inspected: 0,
            queued: 0,
            failed: 0,
        }
    };

    // 5. Durable queue drain: process control-plane retries / manual replays
    // from Supabase with cross-instance claim mutual exclusion (review P1-3).
    // Only a configured, enabled durable queue constructs a client; otherwise
    // the lane is a strict no-op so a single-instance local deployment keeps
    // its existing behavior.
    if config
        .raw
        .pointer("/durableQueue/enabled")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        && config.should_run_request_processing()
    {
        let supabase_url = std::env::var("SUPABASE_URL")
            .or_else(|_| std::env::var("morpheus_SUPABASE_URL"))
            .ok()
            .filter(|s| !s.trim().is_empty());
        let supabase_key = std::env::var("SUPABASE_SERVICE_ROLE_KEY")
            .or_else(|_| std::env::var("morpheus_SUPABASE_SERVICE_ROLE_KEY"))
            .ok()
            .filter(|s| !s.trim().is_empty());
        if let (Some(url), Some(key)) = (supabase_url, supabase_key) {
            let client = neo_os_relayer_store::supabase::SupabaseClient::new(
                transport.clone(),
                neo_os_relayer_store::supabase::SupabaseConfig::new(&url, &key, &config.network),
            );
            let now_ms = now_ms();
            let now_iso = ms_to_iso_string(now_ms);
            // One batch per tick; the loop's poll interval bounds aggregate rate.
            let limit = config
                .raw
                .pointer("/durableQueue/syncLimit")
                .and_then(Value::as_u64)
                .unwrap_or(200)
                .max(1) as usize;
            let stale_ms = config
                .raw
                .pointer("/durableQueue/staleProcessingMs")
                .and_then(Value::as_u64)
                .unwrap_or(45_000);
            let allow_local = config
                .raw
                .pointer("/durableQueue/allowLocalClaimDuringBackoff")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let chains = config.active_chains.clone();
            for chain in &chains {
                let event_now_ms = now_ms;
                let _ = drain_durable_jobs(
                    &client,
                    &DurableDrainConfig {
                        enabled: true,
                        allow_local_claim_during_backoff: allow_local,
                        stale_processing_ms: stale_ms,
                        instance_id: &config.instance_id,
                        network: &config.network,
                        chain,
                        sync_limit: limit,
                    },
                    now_ms as u64,
                    &now_iso,
                    &ms_to_iso_string((now_ms - stale_ms as f64).max(0.0)),
                    |event| {
                        // Execute the claimed durable event through the SAME
                        // fulfillment pipeline as chain-discovered events so a
                        // manual retry/replay converges with discovery. A
                        // non-terminal failure is surfaced to the outer drain so
                        // the row is patched retry_scheduled, not completed.
                        let js_event = JsValue::from_json(event);
                        let result =
                            crate::fulfillment::process_event(config, &mut state, chain, &js_event, event_now_ms);
                        match result.status.as_str() {
                            "fulfilled" | "already_fulfilled" => Ok(()),
                            _ => Err(result.error.unwrap_or_else(|| "durable execution failed".to_string())),
                        }
                    },
                );
            }
        }
    }

    // 6. Cross-chain message (XCM) lane: relay queued arbitrary messages
    // between Neo N3 and NeoX. Shares the durable queue (rows tagged
    // route="xcm") and its cross-instance claim state machine, so delivery is
    // at-most-once. Only a configured, enabled lane constructs a client;
    // otherwise it is a strict no-op, preserving single-instance local
    // behavior. Chain delivery reuses the existing N3/EVM adapters via
    // relay_xcm_message; no new RPC or signing code lives in the lane.
    if config
        .raw
        .pointer("/xcm/enabled")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        && config.should_run_request_processing()
    {
        let supabase_url = std::env::var("SUPABASE_URL")
            .or_else(|_| std::env::var("morpheus_SUPABASE_URL"))
            .ok()
            .filter(|s| !s.trim().is_empty());
        let supabase_key = std::env::var("SUPABASE_SERVICE_ROLE_KEY")
            .or_else(|_| std::env::var("morpheus_SUPABASE_SERVICE_ROLE_KEY"))
            .ok()
            .filter(|s| !s.trim().is_empty());
        if let (Some(url), Some(key)) = (supabase_url, supabase_key) {
            let client = neo_os_relayer_store::supabase::SupabaseClient::new(
                transport.clone(),
                neo_os_relayer_store::supabase::SupabaseConfig::new(&url, &key, &config.network),
            );
            let xcm_now_ms = now_ms();
            let xcm_now_iso = ms_to_iso_string(xcm_now_ms);
            let limit = config
                .raw
                .pointer("/xcm/syncLimit")
                .and_then(Value::as_u64)
                .unwrap_or(200)
                .max(1) as usize;
            let stale_ms = config
                .raw
                .pointer("/xcm/staleProcessingMs")
                .and_then(Value::as_u64)
                .unwrap_or(45_000);
            let allow_local = config
                .raw
                .pointer("/xcm/allowLocalClaimDuringBackoff")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let stale_before_iso = ms_to_iso_string((xcm_now_ms - stale_ms as f64).max(0.0));
            // Read retry backoff config from top-level keys (matching oracle lane)
            let retry_base = config
                .raw
                .get("retryBaseDelayMs")
                .and_then(Value::as_f64)
                .unwrap_or(XCM_DEFAULT_RETRY_BASE_DELAY_MS);
            let retry_max = config
                .raw
                .get("retryMaxDelayMs")
                .and_then(Value::as_f64)
                .unwrap_or(XCM_DEFAULT_RETRY_MAX_DELAY_MS);
            let max_retries = config
                .raw
                .get("maxRetries")
                .and_then(Value::as_u64)
                .unwrap_or(XCM_DEFAULT_MAX_RETRIES);
            match drain_xcm_lane(
                &client,
                &XcmDrainConfig {
                    enabled: true,
                    allow_local_claim_during_backoff: allow_local,
                    stale_processing_ms: stale_ms,
                    instance_id: &config.instance_id,
                    sync_limit: limit,
                    active_chains: &config.active_chains,
                    retry_base_delay_ms: retry_base,
                    retry_max_delay_ms: retry_max,
                    max_retries,
                },
                xcm_now_ms as u64,
                &xcm_now_iso,
                &stale_before_iso,
                |msg, existing_tx, persist| {
                    relay_xcm_message(config, msg, existing_tx, persist, transport, &OsNonce, &SystemWaiter)
                },
            ) {
                Ok(outcomes) => {
                    for outcome in outcomes {
                        match outcome {
                            XcmDrainOutcome::Relayed => {
                                increment_metric(&mut state, "xcm_messages_relayed_total", 1.0)
                            }
                            XcmDrainOutcome::Failed => {
                                increment_metric(&mut state, "xcm_messages_failed_total", 1.0)
                            }
                            XcmDrainOutcome::Conflict => {
                                increment_metric(&mut state, "xcm_claim_conflicts_total", 1.0)
                            }
                            _ => {}
                        }
                    }
                }
                Err(error) => {
                    tracing::warn!(error = %error, "XCM lane drain failed");
                    increment_metric(&mut state, "xcm_messages_failed_total", 1.0);
                }
            }
        }
    }

    let finish_ms = now_ms();
    let finish_iso = ms_to_iso_string(finish_ms);
    let tick_duration_ms = finish_ms - start_ms;

    if let Some(metrics) = state.get_mut("metrics").and_then(|v| v.as_object_mut()) {
        metrics.set("last_tick_completed_at", JsValue::Str(finish_iso));
        metrics.set("last_tick_duration_ms", JsValue::Number(tick_duration_ms));
    }

    // Persist state
    save_state(&config.state_file, &state)?;

    // Discovery failures are a degraded capability, not a healthy no-op. The
    // scan functions distinguish an empty successful range from an RPC/cursor
    // failure; persist metrics first, then fail the tick so the loop sends the
    // failure heartbeat instead of publishing success while requests were not
    // discoverable (review P2-15).
    let discovery_error = unresolved_discovery_chain(&neo_n3, &neox);

    if let Some(error) = discovery_error {
        return Err(error);
    }

    // A due feed tick that could not submit and confirm an on-chain update is
    // an operational failure, not a healthy no-op. Persist the counters above
    // first so metrics retain the evidence, then fail the tick so `once`
    // exits non-zero and the loop reports through the failure heartbeat rather
    // than publishing a success heartbeat for work that never happened.
    if let Some(error) = feed_sync.error.as_deref() {
        return Err(format!("feed sync failed: {error}"));
    }

    let metrics_snapshot = snapshot_metrics(&state, finish_ms);
    let state_val = crate::config::js_value_to_json(&JsValue::Object(state.clone()));
    let metrics_val = crate::config::js_value_to_json(&JsValue::Object(metrics_snapshot));

    Ok(RelayerRunResult {
        instance_id: config.instance_id.clone(),
        mode: config.mode.clone(),
        neo_n3,
        neox,
        feed_sync,
        automation,
        state: state_val,
        metrics: metrics_val,
    })
}

/// Run all blocking filesystem, RPC, and store work on Tokio's blocking pool.
/// The blocking reqwest client is both created and dropped inside that worker.
pub async fn run_relayer_once(config: &RelayerConfig) -> Result<RelayerRunResult, String> {
    config.ensure_runtime_ready()?;
    let blocking_config = config.clone();
    let result = tokio::task::spawn_blocking(move || {
        let transport = RelayerHttpTransport::new();
        run_relayer_once_blocking(&blocking_config, &transport)
    })
    .await
    .map_err(|error| format!("relayer blocking task failed: {error}"))??;

    let heartbeat_url = if config.is_feed_only() {
        config
            .raw
            .pointer("/heartbeats/feedRelayer")
            .and_then(|value| value.as_str())
            .unwrap_or("")
    } else {
        config
            .raw
            .pointer("/heartbeats/relayer")
            .and_then(|value| value.as_str())
            .unwrap_or("")
    };
    if !heartbeat_url.is_empty() {
        let tick_duration_ms = result
            .metrics
            .get("last_tick_duration_ms")
            .and_then(Value::as_f64);
        let payload = serde_json::json!({
            "mode": config.mode,
            "network": config.network,
            "tick_duration_ms": tick_duration_ms,
        });
        send_heartbeat(heartbeat_url, Some(&payload)).await;
    }

    Ok(result)
}

pub async fn run_relayer_loop(
    config: &RelayerConfig,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    run_relayer_loop_until(config, neo_os_service_runtime::shutdown_signal()).await
}

async fn run_relayer_loop_until<F>(
    config: &RelayerConfig,
    shutdown: F,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>>
where
    F: Future<Output = neo_os_service_runtime::ShutdownReason>,
{
    config
        .ensure_runtime_ready()
        .map_err(std::io::Error::other)?;
    tracing::info!(
        network = config.network,
        mode = config.mode,
        instance_id = config.instance_id,
        state_file = config.state_file,
        poll_interval_ms = config.poll_interval_ms,
        concurrency = config.concurrency,
        "Starting Morpheus relayer loop"
    );

    tokio::pin!(shutdown);
    loop {
        let tick = run_relayer_once(config);
        tokio::pin!(tick);
        let (tick_result, shutdown_after_tick) = tokio::select! {
            // Poll the tick first so a signal received during a tick drains
            // that already-started state transition instead of abandoning a
            // blocking scan or atomic state write in the background.
            biased;
            result = &mut tick => (result, None),
            reason = &mut shutdown => (tick.await, Some(reason)),
        };

        let sleep_ms = match tick_result {
            Ok(result) => {
                tracing::info!(
                    metrics = ?result.metrics,
                    "Relayer loop tick complete"
                );

                if config.is_feed_only() {
                    let feed_delay = result
                        .feed_sync
                        .delay_ms
                        .unwrap_or(config.poll_interval_ms as f64);
                    if feed_delay.is_finite() && feed_delay > 0.0 {
                        (feed_delay as u64).min(config.poll_interval_ms)
                    } else {
                        config.poll_interval_ms
                    }
                } else {
                    config.poll_interval_ms
                }
            }
            Err(e) => {
                tracing::error!("Relayer loop tick failed: {e}");
                let failure_hb = config
                    .raw
                    .pointer("/heartbeats/failure")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                if !failure_hb.is_empty() {
                    let payload = serde_json::json!({
                        "mode": config.mode,
                        "network": config.network,
                        "error": e,
                    });
                    send_heartbeat(failure_hb, Some(&payload)).await;
                }
                config.poll_interval_ms
            }
        };

        if let Some(reason) = shutdown_after_tick {
            tracing::info!(reason = %reason, "Relayer loop drained and stopped");
            return Ok(());
        }

        tokio::select! {
            reason = &mut shutdown => {
                tracing::info!(reason = %reason, "Relayer loop stopped");
                return Ok(());
            }
            _ = tokio::time::sleep(Duration::from_millis(sleep_ms)) => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::{run_relayer_loop_until, run_relayer_once};
    use crate::config::RelayerConfig;
    use crate::scan::ChainProcessResult;

    fn request_mode_config(mode: &str, state_file: String) -> RelayerConfig {
        RelayerConfig {
            repo_root: String::new(),
            instance_id: "fail-closed-test".to_string(),
            state_file,
            network: "testnet".to_string(),
            node_env: "test".to_string(),
            mode: mode.to_string(),
            active_chains: vec!["neo_n3".to_string(), "neox".to_string()],
            poll_interval_ms: 1,
            concurrency: 1,
            max_blocks_per_tick: 1,
            discovery_idle_backoff_ms: 1,
            state_persist_min_interval_ms: 1,
            raw: serde_json::json!({}),
        }
    }

    fn unique_absent_state_path(mode: &str) -> std::path::PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "neo-os-relayer-{mode}-{}-{nonce}.json",
            std::process::id()
        ))
    }

    #[test]
    fn missing_state_initializes_empty_without_creating_file() {
        let path = unique_absent_state_path("missing");
        let state = super::load_or_init_state(path.to_str().expect("utf8 path"))
            .expect("missing state is first-start initialization");
        assert!(state.contains_key("metrics"));
        assert!(!path.exists(), "loading must not write a new state file");
    }

    #[test]
    fn corrupt_state_fails_closed_without_overwriting_recovery_evidence() {
        let path = unique_absent_state_path("corrupt");
        let original = "{ not valid json and must remain intact";
        std::fs::write(&path, original).expect("write corrupt fixture");
        let error = super::load_or_init_state(path.to_str().expect("utf8 path"))
            .expect_err("corrupt existing state must stop rather than reset");
        assert!(error.contains("not recoverable JSON"));
        assert_eq!(std::fs::read_to_string(&path).expect("state remains"), original);
        std::fs::remove_file(&path).expect("remove corrupt fixture");
    }

    #[test]
    fn discovery_failure_is_reported_as_unresolved_chain() {
        let healthy_ref = ChainProcessResult {
            chain: "neo_n3".to_string(),
            skipped: false,
            discovery_healthy: true,
            scanned_blocks: None,
            scanned_requests: None,
            events: vec![],
            retries: vec![],
        };
        let unhealthy_ref = ChainProcessResult {
            chain: "neox".to_string(),
            skipped: false,
            discovery_healthy: false,
            scanned_blocks: None,
            scanned_requests: None,
            events: vec![],
            retries: vec![],
        };
        let skipped = ChainProcessResult {
            chain: "neo_n3".to_string(),
            skipped: true,
            discovery_healthy: false,
            scanned_blocks: None,
            scanned_requests: None,
            events: vec![],
            retries: vec![],
        };
        assert_eq!(
            super::unresolved_discovery_chain(&Some(healthy_ref.clone()), &Some(unhealthy_ref.clone())),
            Some("neox discovery unavailable".to_string())
        );
        assert_eq!(
            super::unresolved_discovery_chain(&None, &Some(unhealthy_ref.clone())),
            Some("neox discovery unavailable".to_string())
        );
        // A skipped lane (not in active set) is not a failed discovery.
        assert_eq!(
            super::unresolved_discovery_chain(&Some(skipped.clone()), &Some(unhealthy_ref.clone())),
            Some("neox discovery unavailable".to_string())
        );
        assert_eq!(
            super::unresolved_discovery_chain(&Some(healthy_ref.clone()), &None),
            None
        );
    }

    #[tokio::test]
    async fn automation_is_a_bounded_capability_not_a_startup_failure() {
        // Review P2-16: an operator who enables automation must not lose the
        // core request/combined runtime. The tick runs, persists state, and
        // reports `automation` with the fail-closed reason — it does not abort.
        for mode in ["combined", "requests_only"] {
            let path = unique_absent_state_path(mode);
            let mut config = request_mode_config(mode, path.to_string_lossy().into_owned());
            config.raw = serde_json::json!({
                "automation": {"enabled": true},
                "neo_n3": {"oracleContract": "", "rpcUrls": []},
                "neox": {"oracleContract": "", "rpcUrls": []}
            });

            let result = run_relayer_once(&config)
                .await
                .expect("core tick must run even when automation is unavailable");
            assert!(result.automation.skipped);
            assert!(
                result.automation.reason.is_some(),
                "automation must report why it is unavailable"
            );
            assert_eq!(result.automation.queued, 0);
            std::fs::remove_file(&path).ok();
        }
    }

    #[tokio::test]
    async fn loop_drains_one_started_tick_then_stops_on_shutdown() {
        let path = unique_absent_state_path("shutdown");
        let mut config = request_mode_config("feed_only", path.to_string_lossy().into_owned());
        config.active_chains.clear();
        config.raw = serde_json::json!({ "feedSync": { "enabled": true } });

        run_relayer_loop_until(&config, async {
            neo_os_service_runtime::ShutdownReason::Interrupt
        })
        .await
        .expect("shutdown must stop the loop cleanly after draining the tick");

        assert!(
            path.exists(),
            "the in-flight tick must finish its atomic state write"
        );
        let persisted = std::fs::read_to_string(&path).expect("persisted state");
        assert!(persisted.contains("ticks_total"));
        std::fs::remove_file(&path).expect("remove test state");
    }

    #[tokio::test]
    async fn misconfigured_due_feed_is_a_failed_tick_not_a_success_heartbeat() {
        let path = unique_absent_state_path("feed-misconfigured");
        let mut config = request_mode_config("feed_only", path.to_string_lossy().into_owned());
        config.active_chains.clear();
        config.raw = serde_json::json!({
            "feedSync": {
                "enabled": true,
                "intervalMs": 0
            }
        });

        let error = run_relayer_once(&config)
            .await
            .expect_err("a due feed without chain configuration must fail its tick");
        assert!(error.contains("relayer configuration is missing neo_n3"));
        assert!(
            path.exists(),
            "failure metrics must be durable before the tick reports failure"
        );
        let persisted = std::fs::read_to_string(&path).expect("persisted failure state");
        assert!(persisted.contains("feed_sync_error_total"));
        std::fs::remove_file(&path).expect("remove test state");
    }
}
