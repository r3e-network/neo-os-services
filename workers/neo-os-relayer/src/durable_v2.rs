//! One authoritative queue for discovery and replay. The local JSON file is a
//! metrics/cache projection; loss of that file cannot erase delivery work.
use crate::{
    config::{js_value_to_json, RelayerConfig},
    delivery::{deliver_event_journaled, DeliveryJournal},
    transport::RelayerHttpTransport,
};
use neo_os_core::js_value::{JsObject, JsValue};
use neo_os_relayer_store::{
    delivery::{DeliveryJob, DeliveryStore},
    BackoffState, SupabaseClient, SupabaseConfig,
};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

type Backoffs = BTreeMap<String, Arc<Mutex<BackoffState>>>;
static BACKOFFS: OnceLock<Mutex<Backoffs>> = OnceLock::new();
pub fn retry_budget(config: &RelayerConfig) -> u64 {
    config
        .raw
        .get("maxRetries")
        .and_then(Value::as_f64)
        .filter(|v| v.is_finite() && *v >= 0.0)
        .map(|v| v as u64)
        .unwrap_or(5)
        .saturating_add(1)
        .clamp(1, 1000)
}

pub fn import_legacy_rows(
    config: &RelayerConfig,
    rows: &[Value],
    transport: &RelayerHttpTransport,
) -> Result<Vec<(String, String)>, String> {
    let client = client(config, transport)?;
    let store = DeliveryStore { client: &client };
    let mut imported = vec![];
    for row in rows {
        let chain = row
            .get("chain")
            .and_then(Value::as_str)
            .ok_or("legacy row missing chain")?;
        if !config.active_chains.iter().any(|c| c == chain) {
            continue;
        }
        let mut event = row
            .get("event")
            .filter(|v| v.is_object())
            .cloned()
            .ok_or("legacy row missing event")?;
        event["max_attempts"] = json!(retry_budget(config));
        let legacy_key = row
            .get("event_key")
            .or_else(|| row.get("key"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let contract = if row.get("route").and_then(Value::as_str) == Some("xcm") {
            if !config
                .raw
                .pointer("/xcm/enabled")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                continue;
            }
            let msg = crate::xcm_lane::decode_xcm_event(&event, legacy_key)?;
            event["kind"] = json!("xcm");
            event["requestId"] = json!(format!("0x{}", msg.commitment()));
            event["payload"] = event.get("payload_hex").cloned().unwrap_or(json!(""));
            config
                .raw
                .get("xcm")
                .and_then(|v| v.get(chain))
                .and_then(|v| v.get("contract"))
                .and_then(Value::as_str)
                .ok_or("XCM contract missing during import")?
                .to_owned()
        } else {
            if let Some(id) = event.get("requestId").and_then(Value::as_u64) {
                event["requestId"] = json!(id.to_string());
            }
            identity(config, chain)?.0
        };
        let mut legacy = row.clone();
        if let Some(attempts) = legacy.get("attempts").and_then(Value::as_f64) {
            legacy["attempts"] = json!(attempts.max(0.0) as u64);
        }
        let job = store.import_legacy(chain, &contract, &event, &legacy, now())?;
        imported.push((legacy_key.to_owned(), job.job_key));
    }
    Ok(imported)
}

pub fn import_recovery(
    config: &RelayerConfig,
    state: &mut JsObject,
    transport: &RelayerHttpTransport,
) -> Result<(), String> {
    if config.should_run_feed_sync() {
        if let Some(baselines) = state.get("feed_baselines").and_then(JsValue::as_object) {
            let client = client(config, transport)?;
            let store = DeliveryStore { client: &client };
            for chain in &config.active_chains {
                if let (Some(snapshot), Some(contract)) = (
                    baselines.get(chain),
                    config
                        .raw
                        .get(chain)
                        .and_then(|v| v.get("datafeedContract"))
                        .and_then(Value::as_str)
                        .filter(|v| !v.is_empty()),
                ) {
                    store.seed_feed_baseline(
                        chain,
                        contract,
                        &js_value_to_json(snapshot),
                        now(),
                    )?;
                }
            }
        }
    }
    if !config.should_run_request_processing() {
        return Ok(());
    }
    if state.get("delivery_v2_local_imported") != Some(&JsValue::Bool(true)) {
        let mut rows = vec![];
        for chain in &config.active_chains {
            for lane in ["retry_queue", "dead_letters"] {
                if let Some(items) = state
                    .get(chain)
                    .and_then(JsValue::as_object)
                    .and_then(|c| c.get(lane))
                    .and_then(JsValue::as_array)
                {
                    for item in items {
                        let mut row = js_value_to_json(item);
                        row["chain"] = json!(chain);
                        row["status"] = json!("legacy_local_uncertain");
                        rows.push(row);
                    }
                }
            }
        }
        import_legacy_rows(config, &rows, transport)?;
        state.set("delivery_v2_local_imported", JsValue::Bool(true));
    }
    let client = client(config, transport)?;
    for chain in &config.active_chains {
        let rows = neo_os_relayer_store::fetch_relayer_jobs_by_statuses(
            &client,
            &[
                "queued",
                "queued_backpressure",
                "processing",
                "retrying",
                "retry_scheduled",
                "callback_pending",
                "callback_retry_scheduled",
                "failure_callback_retry_scheduled",
            ],
            Some(chain),
            100,
            None,
            now(),
        )?;
        for (old, key) in import_legacy_rows(config, &rows, transport)? {
            if !old.is_empty() {
                neo_os_relayer_store::patch_relayer_job(
                    &client,
                    &old,
                    &json!({"status":"v2_migrated","worker_response":{"delivery_job_key":key}}),
                    now(),
                )?;
            }
        }
    }
    Ok(())
}
pub fn enabled(config: &RelayerConfig) -> bool {
    config.raw.get("deliveryProtocol").and_then(Value::as_str) == Some("v2")
}
fn now() -> u64 {
    crate::relayer::now_ms() as u64
}

pub fn client(
    config: &RelayerConfig,
    transport: &RelayerHttpTransport,
) -> Result<SupabaseClient<RelayerHttpTransport>, String> {
    let url = std::env::var("SUPABASE_URL")
        .or_else(|_| std::env::var("morpheus_SUPABASE_URL"))
        .map_err(|_| "durable v2 requires SUPABASE_URL")?;
    let key = std::env::var("SUPABASE_SERVICE_ROLE_KEY")
        .or_else(|_| std::env::var("morpheus_SUPABASE_SERVICE_ROLE_KEY"))
        .map_err(|_| "durable v2 requires SUPABASE_SERVICE_ROLE_KEY")?;
    if url.trim().is_empty() || key.trim().is_empty() {
        return Err("durable v2 credentials are empty".into());
    }
    let config = SupabaseConfig::new(&url, &key, &config.network);
    let backoff = BACKOFFS
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| "backoff lock poisoned")?
        .entry(format!("{}|{}", config.rest_url, config.network))
        .or_insert_with(|| Arc::new(Mutex::new(BackoffState::new())))
        .clone();
    Ok(SupabaseClient::with_backoff(
        transport.clone(),
        config,
        backoff,
    ))
}
pub fn identity(config: &RelayerConfig, chain: &str) -> Result<(String, String), String> {
    let lane = config
        .raw
        .get(chain)
        .ok_or("delivery chain configuration missing")?;
    let contract = lane
        .get("oracleContract")
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
        .ok_or("oracle contract missing")?;
    lane.pointer("/custodyKeyIds/updater")
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
        .ok_or("updater account scope missing")?;
    // Conservative network+chain authority scope survives key-id aliases and
    // rotation. A pending transaction under an old key must still block a new
    // plan even when configuration now names another custody key id.
    Ok((contract.to_ascii_lowercase(), "oracle-updater".to_owned()))
}

pub fn schedule_feeds(
    config: &RelayerConfig,
    transport: &RelayerHttpTransport,
) -> crate::feed_sync::FeedSyncResult {
    let enabled = config
        .raw
        .pointer("/feedSync/enabled")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let interval = config
        .raw
        .pointer("/feedSync/intervalMs")
        .and_then(Value::as_u64)
        .unwrap_or(30000)
        .max(1000);
    let result = (|| -> Result<(), String> {
        if !enabled {
            return Ok(());
        }
        let client = client(config, transport)?;
        let store = DeliveryStore { client: &client };
        for chain in &config.active_chains {
            let contract = config
                .raw
                .get(chain)
                .and_then(|l| l.get("datafeedContract"))
                .and_then(Value::as_str)
                .filter(|v| !v.is_empty())
                .ok_or("feed contract missing")?;
            let event = json!({"kind":"feed","chain":chain,"requestId":(now()/interval).to_string(),"payload":"{}","max_attempts":retry_budget(config)});
            store.enqueue(chain, contract, "oracle-updater", &event, now())?;
        }
        Ok(())
    })();
    crate::feed_sync::FeedSyncResult {
        enabled,
        skipped: !enabled,
        reason: Some(
            if enabled {
                "durably_queued"
            } else {
                "disabled"
            }
            .into(),
        ),
        delay_ms: Some(interval as f64),
        duration_ms: None,
        error: result.err(),
    }
}
pub fn enqueue(
    config: &RelayerConfig,
    chain: &str,
    event: &JsValue,
    transport: &RelayerHttpTransport,
) -> Result<(), String> {
    let (contract, account) = identity(config, chain)?;
    let mut event = js_value_to_json(event);
    event["max_attempts"] = json!(retry_budget(config));
    if let Some(id) = event.get("requestId").and_then(Value::as_u64) {
        event["requestId"] = json!(id.to_string());
    }
    let client = client(config, transport)?;
    DeliveryStore { client: &client }.enqueue(chain, &contract, &account, &event, now())?;
    Ok(())
}
pub fn checkpoint(
    config: &RelayerConfig,
    chain: &str,
    cursor: Option<&str>,
    transport: &RelayerHttpTransport,
) -> Result<Option<String>, String> {
    if cursor.is_some() && config.raw.get("deliveryRescan").and_then(Value::as_bool) == Some(true) {
        return Ok(cursor.map(str::to_owned));
    }
    let (contract, _) = identity(config, chain)?;
    let client = client(config, transport)?;
    DeliveryStore { client: &client }.checkpoint(chain, &contract, cursor, now())
}
pub fn restore_cursors(
    config: &RelayerConfig,
    state: &mut JsObject,
    transport: &RelayerHttpTransport,
) -> Result<(), String> {
    for chain in &config.active_chains {
        let mut cursor = checkpoint(config, chain, None, transport)?;
        let field = if chain == "neo_n3" {
            "last_block"
        } else {
            "last_request_id"
        };
        if cursor.is_none() {
            if let Some(existing) = state
                .get(chain)
                .and_then(JsValue::as_object)
                .and_then(|lane| lane.get(field))
            {
                let seed = match existing {
                    JsValue::Str(v) | JsValue::BigInt(v) => Some(
                        v.parse::<u64>()
                            .map_err(|_| "invalid legacy cursor")?
                            .to_string(),
                    ),
                    JsValue::Number(v)
                        if v.is_finite()
                            && *v >= 0.0
                            && v.fract() == 0.0
                            && *v <= 9_007_199_254_740_991.0 =>
                    {
                        Some((*v as u64).to_string())
                    }
                    JsValue::Null | JsValue::Undefined => None,
                    _ => return Err("ambiguous legacy cursor requires explicit rescan plan".into()),
                };
                if let Some(seed) = seed {
                    cursor = checkpoint(config, chain, Some(&seed), transport)?;
                }
            }
        }
        if let Some(lane) = state.get_mut(chain).and_then(JsValue::as_object_mut) {
            let value = match cursor {
                Some(value) if chain == "neo_n3" => JsValue::Number(
                    value
                        .parse::<u32>()
                        .map_err(|_| "invalid durable N3 cursor")? as f64,
                ),
                Some(value) => JsValue::Str(value),
                None => JsValue::Null,
            };
            lane.set(field, value);
        }
    }
    Ok(())
}

pub fn rescan(
    config: &RelayerConfig,
    chain: &str,
    from: u64,
    to: u64,
    transport: &RelayerHttpTransport,
) -> Result<Value, String> {
    let count = to
        .checked_sub(from)
        .and_then(|v| v.checked_add(1))
        .filter(|v| *v <= 1000)
        .ok_or("rescan requires an ordered range of at most 1000 heights/ids")?;
    if !["neo_n3", "neox"].contains(&chain)
        || (chain == "neo_n3" && to > u32::MAX as u64)
        || (chain == "neox" && from == 0)
    {
        return Err("invalid rescan chain/range".into());
    }
    let mut config = config.clone();
    config.raw["deliveryProtocol"] = json!("v2");
    config.raw["deliveryRescan"] = json!(true);
    config.max_blocks_per_tick = count;
    config.discovery_idle_backoff_ms = 0;
    let mut state = neo_os_core::state::create_empty_relayer_state();
    if chain == "neo_n3" {
        config.raw["startBlocks"][chain] = json!(from);
        if from > 0 {
            state
                .get_mut(chain)
                .and_then(JsValue::as_object_mut)
                .unwrap()
                .set("last_block", JsValue::Number((from - 1) as f64));
        }
    } else {
        config.raw["startRequestIds"][chain] = json!(from.to_string());
        state
            .get_mut(chain)
            .and_then(JsValue::as_object_mut)
            .unwrap()
            .set("last_request_id", JsValue::Str((from - 1).to_string()));
    }
    let result = if chain == "neo_n3" {
        crate::scan::process_chain_neo_n3(&config, &mut state, transport, now() as f64)
    } else {
        crate::scan::process_chain_neox(&config, &mut state, transport, now() as f64)
    };
    if !result.discovery_healthy {
        return Err(
            "rescan incomplete; durable jobs retained and authoritative cursor unchanged".into(),
        );
    }
    Ok(
        json!({"chain":chain,"from":from.to_string(),"to":to.to_string(),"observed_and_queued":result.events.len(),"authoritative_cursor_changed":false}),
    )
}

struct DbJournal<'a> {
    store: DeliveryStore<'a, RelayerHttpTransport>,
    job: Mutex<DeliveryJob>,
    owner: &'a str,
    lease_ms: u64,
}
impl DbJournal<'_> {
    fn summary_status(&self) -> Result<&'static str, String> {
        let job = self.job.lock().map_err(|_| "journal lock poisoned")?;
        Ok(match job.status.as_str() {
            "completed" => "completed",
            "dead_letter" | "reconcile_required" => "terminal",
            _ => "retry_scheduled",
        })
    }
}
impl DeliveryJournal for DbJournal<'_> {
    fn get(&self, stage: &str) -> Option<Value> {
        let value = self.job.lock().ok()?.journal.get(stage).cloned()?;
        if let Some(body) = value.get("content_base64").and_then(Value::as_str) {
            serde_json::from_slice(&neo_os_core::base64::decode_lenient(body)).ok()
        } else {
            Some(value)
        }
    }
    fn persist(&self, stage: &str, value: Value) -> Result<(), String> {
        let mut job = self.job.lock().map_err(|_| "journal lock poisoned")?;
        *job = self
            .store
            .transition(&job, self.owner, stage, value, self.lease_ms, now())?;
        Ok(())
    }
    fn ensure_lease(&self) -> Result<(), String> {
        self.persist("renew", json!({}))
    }
}

/// A visit claims at most one job for an updater account. Confirmation performs
/// one observation and returns, so one slow chain cannot hold the next lane.
pub fn visit(
    config: &RelayerConfig,
    chain: &str,
    transport: &RelayerHttpTransport,
) -> Result<Value, String> {
    let account = "oracle-updater";
    let client = client(config, transport)?;
    let store = DeliveryStore { client: &client };
    let lease_ms = config
        .raw
        .get("deliveryLeaseMs")
        .and_then(Value::as_u64)
        .unwrap_or(60000)
        .clamp(3000, 300000);
    let mut kinds = if config.is_feed_only() {
        vec!["feed"]
    } else if config.is_requests_only() {
        vec!["request"]
    } else {
        vec!["request", "feed"]
    };
    if !config.is_feed_only()
        && config
            .raw
            .pointer("/xcm/enabled")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    {
        kinds.push("xcm");
    }
    let Some(job) = store.claim(chain, account, &config.instance_id, lease_ms, now(), &kinds)?
    else {
        let health = store.account_health(chain, account, now())?;
        if health
            .get("reconcile_required")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            > 0
        {
            return Err(format!(
                "{chain} has signed/imported transactions requiring reconciliation"
            ));
        }
        return Ok(json!({"chain":chain,"status":"healthy_empty_or_owned"}));
    };
    if job.status == "dead_letter" {
        return Ok(json!({"chain":chain,"status":"terminal","reason":"max_attempts_exhausted"}));
    }
    let event = JsValue::from_json(&job.event);
    let kind = job.kind.clone();
    let mut delivery_config = config.clone();
    if kind == "xcm" {
        delivery_config.raw["xcm"][chain]["contract"] = json!(job.contract);
    } else {
        delivery_config.raw[chain][if kind == "feed" {
            "datafeedContract"
        } else {
            "oracleContract"
        }] = json!(job.contract);
    }
    let config = &delivery_config;
    let baseline = if kind == "feed" {
        store.feed_baseline(chain, &job.contract, now())?
    } else {
        Value::Null
    };
    let journal = DbJournal {
        store,
        job: Mutex::new(job),
        owner: &config.instance_id,
        lease_ms,
    };
    let result = std::thread::scope(|scope| {
        let (stop_tx, stop_rx) = std::sync::mpsc::channel::<()>();
        let journal_ref = &journal;
        let renew = scope.spawn(move || -> Result<(), String> {
            loop {
                match stop_rx.recv_timeout(Duration::from_millis(lease_ms / 3)) {
                    Ok(()) | Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return Ok(()),
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                        journal_ref.ensure_lease()?
                    }
                }
            }
        });
        let result = if kind == "feed" {
            crate::feed_sync::deliver_feed_journaled(
                config,
                chain,
                &baseline,
                transport,
                &neo_os_chain_evm::SystemEvmWaiter,
                &neo_os_chain_n3::tx::OsNonce,
                &journal,
            )
        } else if kind == "xcm" {
            crate::xcm_lane::relay_xcm_journaled(
                config,
                &js_value_to_json(&event),
                transport,
                &neo_os_chain_n3::tx::OsNonce,
                &neo_os_chain_n3::tx::SystemWaiter,
                &journal,
            )
        } else {
            deliver_event_journaled(
                config,
                chain,
                &event,
                transport,
                &neo_os_chain_n3::tx::OsNonce,
                &neo_os_chain_n3::tx::SystemWaiter,
                &journal,
            )
        };
        let _ = stop_tx.send(());
        let renewal = renew
            .join()
            .map_err(|_| "lease renewal thread failed".to_string())?;
        renewal?;
        Ok::<_, String>(result)
    })?;
    match result {
        Ok(receipt) => {
            journal.persist(
                if receipt.vm_state == "NO_UPDATE" {
                    "no_update"
                } else if receipt.vm_state == "FAULT" {
                    "faulted"
                } else if receipt.vm_state == "EXPIRED_UNSEEN" {
                    "expired"
                } else if receipt.vm_state == "RECONCILED" {
                    "reconciled"
                } else {
                    "completed"
                },
                serde_json::to_value(receipt).map_err(|e| e.to_string())?,
            )?;
            Ok(json!({"chain":chain,"status":journal.summary_status()?}))
        }
        Err(error) => {
            let terminal = error.starts_with("terminal:")
                || crate::fulfillment::is_terminal_configuration_error(&error);
            journal.persist(
                if terminal { "terminal" } else { "retry" },
                json!({"error":error}),
            )?;
            Ok(json!({"chain":chain,"status":journal.summary_status()?}))
        }
    }
}
