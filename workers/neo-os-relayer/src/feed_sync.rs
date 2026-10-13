//! Oracle pricefeed sync pipeline.
//!
//! Pinned against `workers/morpheus-relayer/src/feed-sync.js`.

use neo_os_chain_evm::{
    decode_signed_eip1559, EvmCustodyClient, EvmCustodySettings, EvmRpcClient, EvmWaiter,
    HttpTransport, SystemEvmWaiter,
};
use neo_os_chain_n3::tx::{NonceSource, OsNonce};
use neo_os_chain_n3::{
    custody::{CustodyClient as N3CustodyClient, CustodyConnection},
    rpc::{parse_u128_field, NeoRpcClient},
    tx::{
        confirm_fulfill_execution, normalize_hash160, resolve_signer, NEO_N3_FEE_PADDING,
        NEO_N3_SYSTEM_FEE_HEADROOM_DIVISOR,
    },
    HttpTransport as N3HttpTransport,
};
use neo_os_core::js_value::{JsObject, JsValue};
use neo_os_core::n3_tx::{
    create_invoke_script, verification_script_single_sig, ContractParam, FeedSigner, FeedTx,
    Witness,
};
use neo_os_core::state::{increment_metric, ms_to_iso_string, parse_iso_date_ms};
use p256::ecdsa::{
    signature::Verifier, Signature as P256Signature, VerifyingKey as P256VerifyingKey,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::config::RelayerConfig;
use crate::delivery::{resume_signed, DeliveryJournal, DeliveryReceipt};
use crate::transport::RelayerHttpTransport;

pub fn get_feed_sync_delay_ms(config: &RelayerConfig, state: &JsObject, now_ms: f64) -> f64 {
    let feed_sync = match config.raw.get("feedSync") {
        Some(Value::Object(map)) => map,
        _ => return f64::INFINITY,
    };

    let enabled = feed_sync
        .get("enabled")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if !enabled {
        return f64::INFINITY;
    }

    let interval_ms = feed_sync
        .get("intervalMs")
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0)
        .max(0.0);
    if interval_ms <= 0.0 {
        return 0.0;
    }

    let metrics = state.get("metrics").and_then(|v| v.as_object());
    let last_attempt_at = [
        metrics.and_then(|m| m.get("last_feed_sync_completed_at")),
        metrics.and_then(|m| m.get("last_feed_sync_started_at")),
        metrics.and_then(|m| m.get("last_feed_sync_success_at")),
    ]
    .iter()
    .filter_map(|v| v.and_then(|x| x.as_str()).and_then(parse_iso_date_ms))
    .find(|&ms| ms > 0.0);

    match last_attempt_at {
        None => 0.0,
        Some(ms) => (ms + interval_ms - now_ms).max(0.0),
    }
}

pub fn build_feed_sync_payload(config: &RelayerConfig, target_chain: &str) -> Value {
    let feed_sync = config.raw.get("feedSync").cloned().unwrap_or(Value::Null);
    let mut payload = json!({
        "target_chain": target_chain,
        "network": config.network,
        "symbols": feed_sync.get("symbols").cloned().unwrap_or(json!([])),
        "feed_change_threshold_bps": feed_sync.get("changeThresholdBps").cloned().unwrap_or(json!(0)),
        "feed_min_update_interval_ms": feed_sync.get("minUpdateIntervalMs").cloned().unwrap_or(json!(0)),
        "feed_stale_after_ms": feed_sync.get("staleAfterMs").cloned().unwrap_or(json!(0)),
        "refresh_onchain_baseline": true,
        "wait": feed_sync.get("waitForSubmission").and_then(|v| v.as_bool()).unwrap_or(false),
    });

    if payload
        .get("wait")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        if let Some(to) = feed_sync.get("timeoutMs") {
            payload["feed_submission_wait_timeout_ms"] = to.clone();
        }
    }

    if let Some(p) = feed_sync.get("provider") {
        if !p.is_null() {
            payload["provider"] = p.clone();
        }
    } else if let Some(ps) = feed_sync.get("providers") {
        if ps.is_array() && !ps.as_array().unwrap().is_empty() {
            payload["providers"] = ps.clone();
        }
    }

    if feed_sync
        .get("projectConfigEnabled")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        if let Some(slug) = feed_sync.get("projectSlug") {
            payload["project_slug"] = slug.clone();
        }
    }

    payload
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FeedSyncResult {
    pub enabled: bool,
    pub skipped: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delay_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub fn process_feed_sync(
    config: &RelayerConfig,
    state: &mut JsObject,
    now_ms: f64,
) -> FeedSyncResult {
    let transport = RelayerHttpTransport::new();
    process_feed_sync_with(
        config,
        state,
        now_ms,
        &transport,
        &SystemEvmWaiter,
        &OsNonce,
    )
}

pub fn process_feed_sync_with<T, W, N>(
    config: &RelayerConfig,
    state: &mut JsObject,
    now_ms: f64,
    transport: &T,
    waiter: &W,
    nonce_source: &N,
) -> FeedSyncResult
where
    T: HttpTransport + N3HttpTransport,
    W: EvmWaiter + Sync,
    N: NonceSource,
{
    let feed_sync = match config.raw.get("feedSync") {
        Some(Value::Object(map)) => map,
        _ => {
            return FeedSyncResult {
                enabled: false,
                skipped: true,
                reason: Some("disabled".to_string()),
                delay_ms: None,
                duration_ms: None,
                error: None,
            }
        }
    };

    let enabled = feed_sync
        .get("enabled")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if !enabled {
        return FeedSyncResult {
            enabled: false,
            skipped: true,
            reason: Some("disabled".to_string()),
            delay_ms: None,
            duration_ms: None,
            error: None,
        };
    }

    let delay_ms = get_feed_sync_delay_ms(config, state, now_ms);
    if delay_ms > 0.0 {
        increment_metric(state, "feed_sync_skipped_total", 1.0);
        return FeedSyncResult {
            enabled: true,
            skipped: true,
            reason: Some("interval_not_elapsed".to_string()),
            delay_ms: Some(delay_ms),
            duration_ms: None,
            error: None,
        };
    }

    set_metric(
        state,
        "last_feed_sync_started_at",
        JsValue::Str(ms_to_iso_string(now_ms)),
    );
    increment_metric(state, "feed_sync_runs_total", 1.0);
    let started = waiter.now_ms();
    let targets = if config.active_chains.is_empty() {
        vec!["neo_n3".to_string()]
    } else {
        config.active_chains.clone()
    };
    let mut errors = Vec::new();
    let mut submitted = 0usize;
    let mut no_update = 0usize;
    for chain in targets {
        let outcome = match chain.as_str() {
            "neox" => {
                deliver_neox_feed(config, state, now_ms, transport, waiter, nonce_source, None)
            }
            "neo_n3" => {
                deliver_n3_feed(config, state, now_ms, transport, waiter, nonce_source, None)
            }
            other => Err(format!("unsupported feed target chain {other}")),
        };
        match outcome {
            Ok(true) => {
                submitted += 1;
                increment_metric(state, "feed_sync_success_total", 1.0);
            }
            Ok(false) => {
                no_update += 1;
                increment_metric(state, "feed_sync_success_total", 1.0);
            }
            Err(error) => {
                errors.push(format!("{chain}: {error}"));
                increment_metric(state, "feed_sync_error_total", 1.0);
            }
        }
    }
    let completed_ms = waiter.now_ms();
    let duration_ms = completed_ms.saturating_sub(started) as f64;
    set_metric(
        state,
        "last_feed_sync_completed_at",
        JsValue::Str(ms_to_iso_string(completed_ms as f64)),
    );
    set_metric(
        state,
        "last_feed_sync_duration_ms",
        JsValue::Number(duration_ms),
    );
    if errors.is_empty() {
        set_metric(
            state,
            "last_feed_sync_success_at",
            JsValue::Str(ms_to_iso_string(completed_ms as f64)),
        );
    }
    FeedSyncResult {
        enabled: true,
        skipped: false,
        reason: (submitted == 0 && no_update > 0).then(|| "no_update".to_string()),
        delay_ms: None,
        duration_ms: Some(duration_ms),
        error: (!errors.is_empty()).then(|| errors.join("; ")),
    }
}

/// Return `true` only after one signed transaction is broadcast and a concrete
/// status-1 receipt is persisted; `false` is the enclave's attested no-update
/// decision and performs no broadcast.
fn deliver_neox_feed<T: HttpTransport + N3HttpTransport, W: EvmWaiter, N: NonceSource>(
    config: &RelayerConfig,
    state: &mut JsObject,
    now_ms: f64,
    transport: &T,
    waiter: &W,
    nonce_source: &N,
    journal: Option<&dyn DeliveryJournal>,
) -> Result<bool, String> {
    let neox = object_at(&config.raw, "neox")?;
    let nitro = object_at(&config.raw, "nitro")?;
    let rpc_url = required_string(neox, "rpcUrl", "NeoX primary RPC URL")?;
    let rpc_urls = string_array(neox.get("rpcUrls"));
    let chain_id = neox
        .get("chainId")
        .and_then(value_u64)
        .filter(|value| *value > 0)
        .ok_or_else(|| "NeoX chain id is not configured".to_string())?;
    let contract = required_string(neox, "datafeedContract", "NeoX datafeed contract")?;
    let contract_bytes = parse_evm_address(&contract)?;
    let contract = canonical_address(contract_bytes);
    let key_id = neox
        .get("custodyKeyIds")
        .and_then(Value::as_object)
        .ok_or_else(|| "NeoX custody key ids are not configured".to_string())
        .and_then(|ids| required_string(ids, "updater", "NeoX updater custody key id"))?;
    let custody_url = required_string(nitro, "custodyUrl", "custody signer URL")?;
    let custody_token = required_string(nitro, "custodyToken", "custody signer token")?;
    let timeout_ms = nitro
        .get("timeoutMs")
        .and_then(value_u64)
        .filter(|value| *value > 0)
        .unwrap_or(10_000);
    let custody = EvmCustodyClient::new(
        transport,
        EvmCustodySettings::new(&custody_url, &custody_token, Some(timeout_ms))?,
    );
    let identity = custody.key_info(&key_id)?;
    if identity.chain_id != chain_id {
        return Err(format!(
            "NeoX updater custody key is bound to chain {}, configured chain is {chain_id}",
            identity.chain_id
        ));
    }
    let from = canonical_address(parse_evm_address(&identity.address)?);

    let rpc = EvmRpcClient::new(rpc_url, rpc_urls, transport);
    let tx_nonce = rpc
        .transaction_count(&from)
        .map_err(|error| format!("NeoX pending nonce failed: {error}"))?;
    let gas_price = rpc
        .gas_price()
        .map_err(|error| format!("NeoX gas price failed: {error}"))?;
    let priority_fee = rpc
        .max_priority_fee_per_gas()
        .map_err(|error| format!("NeoX priority fee failed: {error}"))?;
    let max_fee = gas_price
        .checked_mul(2)
        .and_then(|value| value.checked_add(priority_fee))
        .ok_or_else(|| "NeoX EIP-1559 fee calculation overflowed".to_string())?;
    let gas_limit = neox
        .get("feedGasLimit")
        .and_then(value_u64)
        .filter(|value| *value >= 21_000)
        .unwrap_or(2_000_000);
    let symbols = feed_symbols(config)?;
    let baseline = feed_baseline(state, "neox");
    let freshness_nonce = format!(
        "{:08x}{:08x}{:08x}{:08x}",
        nonce_source.nonce(),
        nonce_source.nonce(),
        nonce_source.nonce(),
        nonce_source.nonce()
    );
    let body = json!({
        "chain": "neox",
        "network": config.network,
        "symbols": symbols,
        "onchain_state": baseline,
        "now": (now_ms / 1000.0).floor(),
        "nonce": freshness_nonce,
        "tx_params": {
            "to": contract,
            "from": from,
            "chain_id": chain_id,
            "nonce": tx_nonce,
            "gas_limit": gas_limit,
            "max_fee_per_gas": max_fee.to_string(),
            "max_priority_fee_per_gas": priority_fee.to_string(),
        }
    });
    let base = nitro
        .get("apiUrl")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Rust enclave feed URL is not configured".to_string())?;
    let endpoint = service_endpoint(base, "/feed/sign")?;
    let token = nitro
        .get("token")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let body_text = body.to_string();
    let (status, response_text) = if token.is_empty() {
        HttpTransport::post(transport, &endpoint, &body_text)
    } else {
        HttpTransport::post_with_bearer(transport, &endpoint, token, timeout_ms, &body_text)
    }
    .map_err(|error| format!("Rust enclave feed signing failed: {error}"))?;
    let response: Value = serde_json::from_str(&response_text)
        .map_err(|_| format!("Rust enclave feed signing returned non-JSON (HTTP {status})"))?;
    if !(200..300).contains(&status) {
        let detail = response
            .get("error")
            .or_else(|| response.get("message"))
            .and_then(Value::as_str)
            .unwrap_or("feed signing failed");
        return Err(format!(
            "Rust enclave feed signing answered {status}: {detail}"
        ));
    }
    if response.get("chain").and_then(Value::as_str) != Some("neox") {
        return Err("Rust enclave feed response has the wrong chain".to_string());
    }
    match response.get("status").and_then(Value::as_str) {
        Some("no-update") => {
            if let Some(j) = journal {
                j.persist(
                    "prepared",
                    json!({"no_update":true,"feed_response":response}),
                )?;
            }
            return Ok(false);
        }
        Some("ok") => {}
        _ => return Err("Rust enclave feed response has no terminal status".to_string()),
    }
    let expected_envelope = NeoxFeedTxEnvelope {
        from: &from,
        to: &contract,
        chain_id,
        nonce: tx_nonce,
        gas_limit,
        max_fee,
        priority_fee,
    };
    validate_host_neox_response(&response, &expected_envelope)?;
    let signed_tx = required_value_string(&response, "signed_tx", "signed feed transaction")?;
    let decoded = decode_signed_eip1559(&signed_tx)?;
    if decoded.chain_id != chain_id
        || decoded.nonce != tx_nonce
        || decoded.gas_limit != gas_limit
        || decoded.max_fee_per_gas != max_fee
        || decoded.max_priority_fee_per_gas != priority_fee
        || decoded.to != contract_bytes
        || decoded.value.iter().any(|byte| *byte != 0)
    {
        return Err(
            "custody-signed NeoX feed transaction fields do not match the requested plan"
                .to_string(),
        );
    }
    if !canonical_address(decoded.from).eq_ignore_ascii_case(&from) {
        return Err(
            "custody-signed NeoX feed transaction does not recover to the updater identity"
                .to_string(),
        );
    }
    let returned_data =
        decode_hex_value(response.get("data").and_then(Value::as_str).unwrap_or(""))?;
    if decoded.data != returned_data {
        return Err("custody-signed NeoX feed calldata differs from the enclave plan".to_string());
    }
    let expected_selector =
        &neo_os_chain_evm::keccak256(b"updateFeeds(string[],uint256[],uint256[],uint256[])")[..4];
    if decoded.data.get(..4) != Some(expected_selector) {
        return Err("NeoX feed calldata does not call updateFeeds".to_string());
    }
    let estimate = rpc
        .estimate_gas(&from, &contract, response["data"].as_str().unwrap_or(""))
        .map_err(|error| format!("NeoX feed simulation failed: {error}"))?;
    if estimate > gas_limit {
        return Err(format!(
            "NeoX feed gas estimate {estimate} exceeds configured/signed limit {gas_limit}"
        ));
    }
    if let Some(journal) = journal {
        let stage =
            json!({"chain":"neox","request_id":"feed","tx_hash":decoded.tx_hash,"raw":signed_tx});
        persist_feed_prepared(journal, "neox", &response, &stage)?;
        return crate::delivery::persist_and_publish(config, "neox", transport, journal, &stage)
            .map(|_| true);
    }
    let node_hash = rpc
        .send_raw_transaction(&signed_tx)
        .map_err(|error| format!("NeoX feed broadcast failed: {error}"))?;
    if !node_hash.eq_ignore_ascii_case(&decoded.tx_hash) {
        return Err(format!(
            "NeoX RPC returned transaction hash {node_hash}, locally signed hash is {}",
            decoded.tx_hash
        ));
    }
    let confirm_timeout_ms = neox
        .get("confirmTimeoutMs")
        .and_then(value_u64)
        .filter(|value| *value > 0)
        .unwrap_or(45_000);
    let receipt = rpc
        .wait_for_receipt(waiter, &decoded.tx_hash, confirm_timeout_ms)
        .map_err(|error| format!("NeoX feed confirmation failed: {error}"))?;
    persist_feed_baseline(state, "neox", &response)?;
    state.set(
        "last_feed_delivery",
        JsValue::from_json(&json!({
            "target_chain": "neox",
            "tx_hash": receipt.tx_hash,
            "block_number": receipt.block_number,
            "status": receipt.status,
            "gas_estimate": estimate,
            "confirmed_at": ms_to_iso_string(waiter.now_ms() as f64),
            "symbols": response.get("symbols").cloned().unwrap_or(json!([])),
            "prices_scaled": response.get("prices_scaled").cloned().unwrap_or(json!([])),
            "timestamps": response.get("timestamps").cloned().unwrap_or(json!([])),
            "round_ids": response.get("round_ids").cloned().unwrap_or(json!([])),
        })),
    );
    increment_metric(state, "feed_submission_success_total", 1.0);
    Ok(true)
}

/// The prepared feed stage contains its exact signed delivery, so a restart
/// between the two durable writes promotes those same bytes without refetching
/// prices or signing another nonce.
pub fn deliver_feed_journaled<T, W, N>(
    config: &RelayerConfig,
    chain: &str,
    baseline: &Value,
    transport: &T,
    waiter: &W,
    nonce: &N,
    journal: &dyn DeliveryJournal,
) -> Result<DeliveryReceipt, String>
where
    T: HttpTransport + N3HttpTransport,
    W: EvmWaiter + Sync,
    N: NonceSource,
{
    journal.ensure_lease()?;
    if journal.get("signed").is_none() {
        if let Some(stage) = journal
            .get("prepared")
            .and_then(|p| p.get("signed_delivery").cloned())
        {
            journal.persist("signed", stage)?;
        }
    }
    if let Some(stage) = journal.get("signed") {
        return resume_signed(config, chain, transport, journal, &stage);
    }
    let no_update = || DeliveryReceipt {
        request_id: "feed".into(),
        tx_hash: String::new(),
        vm_state: "NO_UPDATE".into(),
        target_chain: chain.into(),
        exception: None,
        onchain_state: None,
    };
    if journal
        .get("prepared")
        .and_then(|p| p.get("no_update").and_then(Value::as_bool))
        == Some(true)
    {
        return Ok(no_update());
    }
    let mut state = neo_os_core::state::create_empty_relayer_state();
    if baseline.is_object() {
        state.set(
            "feed_baselines",
            JsValue::from_json(&json!({chain:baseline})),
        );
    }
    let now_ms = waiter.now_ms() as f64;
    let updated = match chain {
        "neox" => deliver_neox_feed(
            config,
            &mut state,
            now_ms,
            transport,
            waiter,
            nonce,
            Some(journal),
        )?,
        "neo_n3" => deliver_n3_feed(
            config,
            &mut state,
            now_ms,
            transport,
            waiter,
            nonce,
            Some(journal),
        )?,
        _ => return Err("unsupported feed chain".into()),
    };
    if !updated {
        return Ok(no_update());
    }
    resume_signed(
        config,
        chain,
        transport,
        journal,
        &journal
            .get("signed")
            .ok_or("feed omitted durable signed stage")?,
    )
}

struct N3SignedPlan {
    response: Value,
    script: Vec<u8>,
    tx_nonce: u32,
    valid_until_block: u32,
    witness: Witness,
}

struct N3WaiterBridge<'a, W>(&'a W);

impl<W: EvmWaiter + Sync> neo_os_chain_n3::tx::Waiter for N3WaiterBridge<'_, W> {
    fn now_ms(&self) -> u64 {
        self.0.now_ms()
    }

    fn sleep(&self, ms: u64) {
        self.0.sleep(std::time::Duration::from_millis(ms));
    }
}

fn deliver_n3_feed<T: HttpTransport + N3HttpTransport, W: EvmWaiter + Sync, N: NonceSource>(
    config: &RelayerConfig,
    state: &mut JsObject,
    now_ms: f64,
    transport: &T,
    waiter: &W,
    nonce_source: &N,
    journal: Option<&dyn DeliveryJournal>,
) -> Result<bool, String> {
    let n3 = object_at(&config.raw, "neo_n3")?;
    let nitro = object_at(&config.raw, "nitro")?;
    let rpc_urls = string_array(n3.get("rpcUrls"));
    if rpc_urls.is_empty() {
        return Err("Neo N3 RPC URLs are not configured".to_string());
    }
    let rpc = NeoRpcClient::new(transport, rpc_urls, !cfg!(test))?;
    let block_count = rpc.get_block_count().map_err(|error| error.to_string())?;
    let network_magic = n3
        .get("networkMagic")
        .and_then(value_u64)
        .and_then(|value| u32::try_from(value).ok())
        .ok_or_else(|| "Neo N3 network magic is not configured".to_string())?;
    let contract = required_string(n3, "datafeedContract", "Neo N3 datafeed contract")?;
    let contract_bytes = parse_hash160_display(&contract)?;
    let write_mode = probe_n3_feed_write_mode(&rpc, &contract, network_magic)?;
    let key_id = n3
        .get("custodyKeyIds")
        .and_then(Value::as_object)
        .ok_or_else(|| "Neo N3 custody key ids are not configured".to_string())
        .and_then(|ids| required_string(ids, "updater", "Neo N3 updater custody key id"))?;
    let custody_url = required_string(nitro, "custodyUrl", "custody signer URL")?;
    let custody_token = required_string(nitro, "custodyToken", "custody signer token")?;
    let timeout_ms = nitro
        .get("timeoutMs")
        .and_then(value_u64)
        .filter(|value| *value > 0)
        .unwrap_or(10_000);
    let custody = N3CustodyClient::new(
        transport,
        CustodyConnection::new(custody_url, custody_token, Some(timeout_ms))?,
    );
    let updater = resolve_signer(&custody, &key_id)?;
    let updater_hash = parse_hash160_display(&normalize_hash160(&updater.script_hash))?;
    let symbols = feed_symbols(config)?;
    let baseline = feed_baseline(state, "neo_n3");
    let freshness_nonce = format!(
        "{:08x}{:08x}{:08x}{:08x}",
        nonce_source.nonce(),
        nonce_source.nonce(),
        nonce_source.nonce(),
        nonce_source.nonce()
    );
    let tx_nonce = nonce_source.nonce();
    let expected_valid_until_block = block_count
        .checked_add(500)
        .ok_or_else(|| "Neo N3 feed valid-until block overflowed".to_string())?;

    // First measured pass supplies the plan; the zero fees are never
    // broadcast. They make the exact script available for invokescript.
    let first = call_n3_feed_host(
        config,
        transport,
        nitro,
        &symbols,
        &baseline,
        now_ms,
        &freshness_nonce,
        block_count,
        tx_nonce,
        0,
        0,
        timeout_ms,
        write_mode,
    )?;
    if validate_n3_no_update_response(&first, write_mode)? {
        if let Some(j) = journal {
            j.persist("prepared", json!({"no_update":true,"feed_response":first}))?;
        }
        return Ok(false);
    }
    let first_plan = parse_n3_signed_plan(
        first,
        &contract_bytes,
        &updater,
        updater_hash,
        network_magic,
        0,
        0,
        tx_nonce,
        expected_valid_until_block,
        &freshness_nonce,
        write_mode,
    )?;
    let zero_tx = FeedTx {
        nonce: first_plan.tx_nonce,
        valid_until_block: first_plan.valid_until_block,
        system_fee: 0,
        network_fee: 0,
        signer: FeedSigner {
            script_hash: updater_hash,
        },
        script: &first_plan.script,
    };
    let invoke = rpc
        .call(
            "invokescript",
            json!([
                neo_os_core::base64::encode_standard(zero_tx.script),
                [{"account": normalize_hash160(&updater.script_hash), "scopes": "CalledByEntry"}]
            ]),
        )
        .map_err(|error| error.to_string())?;
    ensure_n3_invoke_halt(&invoke, "initial feed simulation")?;
    let gas = parse_u128_field(&invoke, "gasconsumed")
        .ok_or_else(|| "Neo N3 feed simulation omitted gasconsumed".to_string())?;
    let mut system_fee = gas
        .checked_add(gas / NEO_N3_SYSTEM_FEE_HEADROOM_DIVISOR)
        .and_then(|value| value.checked_add(NEO_N3_FEE_PADDING))
        .ok_or_else(|| "Neo N3 feed system fee overflowed".to_string())?;

    // A signed zero-network-fee transaction is required for the node's witness
    // size calculation. This pass is also never broadcast.
    let fee_plan = call_n3_feed_host(
        config,
        transport,
        nitro,
        &symbols,
        &baseline,
        now_ms,
        &freshness_nonce,
        block_count,
        tx_nonce,
        system_fee,
        0,
        timeout_ms,
        write_mode,
    )?;
    if validate_n3_no_update_response(&fee_plan, write_mode)? {
        if let Some(j) = journal {
            j.persist(
                "prepared",
                json!({"no_update":true,"feed_response":fee_plan}),
            )?;
        }
        return Ok(false);
    }
    let fee_plan = parse_n3_signed_plan(
        fee_plan,
        &contract_bytes,
        &updater,
        updater_hash,
        network_magic,
        system_fee,
        0,
        tx_nonce,
        expected_valid_until_block,
        &freshness_nonce,
        write_mode,
    )?;
    let fee_tx = FeedTx {
        nonce: fee_plan.tx_nonce,
        valid_until_block: fee_plan.valid_until_block,
        system_fee: u64::try_from(system_fee)
            .map_err(|_| "Neo N3 feed system fee exceeds u64".to_string())?,
        network_fee: 0,
        signer: FeedSigner {
            script_hash: updater_hash,
        },
        script: &fee_plan.script,
    };
    let fee_payload = neo_os_core::base64::encode_standard(
        &fee_tx.serialize_signed(std::slice::from_ref(&fee_plan.witness)),
    );
    let mut network_fee = rpc
        .calculate_network_fee(&fee_payload)
        .map_err(|error| error.to_string())?
        .checked_add(NEO_N3_FEE_PADDING)
        .ok_or_else(|| "Neo N3 feed network fee overflowed".to_string())?;

    // Prices are fetched inside the measured fold on every pass. Re-simulate
    // the FINAL returned script and re-size its witness; retry boundedly when a
    // changed plan needs a larger declared fee.
    let mut final_plan = None;
    for _ in 0..3 {
        let response = call_n3_feed_host(
            config,
            transport,
            nitro,
            &symbols,
            &baseline,
            now_ms,
            &freshness_nonce,
            block_count,
            tx_nonce,
            system_fee,
            network_fee,
            timeout_ms,
            write_mode,
        )?;
        if validate_n3_no_update_response(&response, write_mode)? {
            if let Some(j) = journal {
                j.persist(
                    "prepared",
                    json!({"no_update":true,"feed_response":response}),
                )?;
            }
            return Ok(false);
        }
        let plan = parse_n3_signed_plan(
            response,
            &contract_bytes,
            &updater,
            updater_hash,
            network_magic,
            system_fee,
            network_fee,
            tx_nonce,
            expected_valid_until_block,
            &freshness_nonce,
            write_mode,
        )?;
        let (needed_system, needed_network, signed, tx_hash) = {
            let tx = FeedTx {
                nonce: plan.tx_nonce,
                valid_until_block: plan.valid_until_block,
                system_fee: u64::try_from(system_fee)
                    .map_err(|_| "Neo N3 feed system fee exceeds u64".to_string())?,
                network_fee: u64::try_from(network_fee)
                    .map_err(|_| "Neo N3 feed network fee exceeds u64".to_string())?,
                signer: FeedSigner {
                    script_hash: updater_hash,
                },
                script: &plan.script,
            };
            let final_invoke = rpc
                .call(
                    "invokescript",
                    json!([
                        neo_os_core::base64::encode_standard(tx.script),
                        [{"account": normalize_hash160(&updater.script_hash), "scopes": "CalledByEntry"}]
                    ]),
                )
                .map_err(|error| error.to_string())?;
            ensure_n3_invoke_halt(&final_invoke, "final feed simulation")?;
            let final_gas = parse_u128_field(&final_invoke, "gasconsumed")
                .ok_or_else(|| "Neo N3 final feed simulation omitted gasconsumed".to_string())?;
            let needed_system = final_gas
                .checked_add(final_gas / NEO_N3_SYSTEM_FEE_HEADROOM_DIVISOR)
                .and_then(|value| value.checked_add(NEO_N3_FEE_PADDING))
                .ok_or_else(|| "Neo N3 final feed system fee overflowed".to_string())?;
            let signed = neo_os_core::base64::encode_standard(
                &tx.serialize_signed(std::slice::from_ref(&plan.witness)),
            );
            let needed_network = rpc
                .calculate_network_fee(&signed)
                .map_err(|error| error.to_string())?
                .checked_add(NEO_N3_FEE_PADDING)
                .ok_or_else(|| "Neo N3 final feed network fee overflowed".to_string())?;
            (needed_system, needed_network, signed, tx.hash_display())
        };
        if needed_system > system_fee || needed_network > network_fee {
            system_fee = system_fee.max(needed_system);
            network_fee = network_fee.max(needed_network);
            continue;
        }
        final_plan = Some((plan, signed, tx_hash));
        break;
    }
    let (plan, signed_base64, tx_hash) = final_plan.ok_or_else(|| {
        "Neo N3 feed plan changed across all bounded fee/sign attempts".to_string()
    })?;
    if let Some(journal) = journal {
        let stage = json!({"chain":"neo_n3","request_id":"feed","tx_hash":tx_hash,"raw":signed_base64,"valid_until_block":plan.valid_until_block});
        persist_feed_prepared(journal, "neo_n3", &plan.response, &stage)?;
        return crate::delivery::persist_and_publish(config, "neo_n3", transport, journal, &stage)
            .map(|_| true);
    }
    if !rpc
        .send_raw_transaction(&signed_base64)
        .map_err(|error| error.to_string())?
    {
        return Err("Neo N3 RPC did not accept the signed feed transaction".to_string());
    }
    let confirm_timeout_ms = n3
        .get("fulfillConfirmTimeoutMs")
        .and_then(value_u64)
        .filter(|value| *value > 0)
        .unwrap_or(45_000);
    let execution = confirm_fulfill_execution(
        &rpc,
        &N3WaiterBridge(waiter),
        "feed",
        &tx_hash,
        "datafeed update",
        confirm_timeout_ms,
        true,
    )?;
    persist_n3_feed_baseline(state, &plan.response)?;
    state.set(
        "last_feed_delivery",
        JsValue::from_json(&json!({
            "target_chain": "neo_n3",
            "tx_hash": tx_hash,
            "vm_state": execution.vm_state,
            "system_fee": system_fee.to_string(),
            "network_fee": network_fee.to_string(),
            "confirmed_at": ms_to_iso_string(waiter.now_ms() as f64),
            "pairs": plan.response.get("pairs").cloned().unwrap_or(json!([])),
            "prices_scaled": plan.response.get("prices_scaled").cloned().unwrap_or(json!([])),
            "timestamps": plan.response.get("timestamps").cloned().unwrap_or(json!([])),
            "rounds": plan.response.get("rounds").cloned().unwrap_or(json!([])),
        })),
    );
    increment_metric(state, "feed_submission_success_total", 1.0);
    Ok(true)
}

#[allow(clippy::too_many_arguments)]
fn call_n3_feed_host<T: HttpTransport + N3HttpTransport>(
    config: &RelayerConfig,
    transport: &T,
    nitro: &serde_json::Map<String, Value>,
    symbols: &[String],
    baseline: &Value,
    now_ms: f64,
    freshness_nonce: &str,
    block_count: u32,
    tx_nonce: u32,
    system_fee: u128,
    network_fee: u128,
    timeout_ms: u64,
    write_mode: &str,
) -> Result<Value, String> {
    let endpoint = service_endpoint(
        nitro
            .get("apiUrl")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "Rust enclave feed URL is not configured".to_string())?,
        "/feed/sign",
    )?;
    let body = json!({
        "chain": "neo_n3",
        "network": config.network,
        "write_mode": write_mode,
        "operation": write_mode,
        "symbols": symbols,
        "onchain_state": baseline,
        "now": (now_ms / 1000.0).floor(),
        "nonce": freshness_nonce,
        "tx_params": {
            "block_count": block_count,
            "system_fee": system_fee.to_string(),
            "network_fee": network_fee.to_string(),
            "nonce": tx_nonce,
        }
    });
    let token = nitro
        .get("token")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let body = body.to_string();
    let (status, text) = if token.is_empty() {
        HttpTransport::post(transport, &endpoint, &body)
    } else {
        HttpTransport::post_with_bearer(transport, &endpoint, token, timeout_ms, &body)
    }
    .map_err(|error| format!("Rust enclave Neo N3 feed signing failed: {error}"))?;
    let response: Value = serde_json::from_str(&text)
        .map_err(|_| format!("Rust enclave Neo N3 feed signing returned non-JSON ({status})"))?;
    if !(200..300).contains(&status) {
        let detail = response
            .get("error")
            .or_else(|| response.get("message"))
            .and_then(Value::as_str)
            .unwrap_or("feed signing failed");
        return Err(format!(
            "Rust enclave Neo N3 feed signing answered {status}: {detail}"
        ));
    }
    if response.get("status").and_then(Value::as_str) == Some("no-update") {
        validate_n3_no_update_response(&response, write_mode)?;
    }
    Ok(response)
}

fn probe_n3_feed_write_mode<T: N3HttpTransport>(
    rpc: &NeoRpcClient<T>,
    contract: &str,
    network_magic: u32,
) -> Result<&'static str, String> {
    let state = rpc
        .get_contract_state(contract)
        .map_err(|error| format!("Neo N3 datafeed ABI probe failed: {error}"))?;
    let network = match network_magic {
        860_833_102 => "mainnet",
        894_710_606 => "testnet",
        other => return Err(format!("unsupported Neo N3 network magic {other}")),
    };
    resolve_n3_feed_write_mode(&state, network)
}

fn validate_n3_no_update_response(
    response: &Value,
    expected_operation: &str,
) -> Result<bool, String> {
    if response.get("status").and_then(Value::as_str) != Some("no-update") {
        return Ok(false);
    }
    let operation = response
        .get("operation")
        .and_then(Value::as_str)
        .ok_or_else(|| "Rust enclave Neo N3 no-update response omitted operation".to_string())?;
    let write_mode = response
        .get("write_mode")
        .and_then(Value::as_str)
        .ok_or_else(|| "Rust enclave Neo N3 no-update response omitted write_mode".to_string())?;
    if write_mode != operation {
        return Err("Rust enclave Neo N3 no-update response has mismatched write mode".to_string());
    }
    if operation != expected_operation {
        return Err(format!(
            "Rust enclave Neo N3 no-update operation {operation} did not match probed ABI {expected_operation}"
        ));
    }
    Ok(true)
}

fn resolve_n3_feed_write_mode(state: &Value, network: &str) -> Result<&'static str, String> {
    let methods = state
        .pointer("/manifest/abi/methods")
        .and_then(Value::as_array)
        .ok_or_else(|| "Neo N3 datafeed ABI probe omitted manifest.abi.methods".to_string())?;
    let inspect_method = |name: &str, expected: &[&str]| -> Result<bool, String> {
        let matches = methods
            .iter()
            .filter(|method| method.get("name").and_then(Value::as_str) == Some(name))
            .collect::<Vec<_>>();
        if matches.len() > 1 {
            return Err(format!(
                "Neo N3 {network} datafeed ABI method {name} is ambiguous ({})",
                matches.len()
            ));
        }
        let Some(method) = matches.first() else {
            return Ok(false);
        };
        let parameters = method
            .get("parameters")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                format!("Neo N3 {network} datafeed ABI method {name} has no parameters")
            })?;
        if parameters.len() != expected.len() {
            return Err(format!(
                "Neo N3 {network} datafeed ABI method {name} has wrong arity ({})",
                parameters.len()
            ));
        }
        if !parameters.iter().zip(expected).all(|(parameter, ty)| {
            parameter
                .get("type")
                .and_then(Value::as_str)
                .is_some_and(|actual| actual == *ty)
        }) {
            return Err(format!(
                "Neo N3 {network} datafeed ABI method {name} has wrong parameter types"
            ));
        }
        Ok(true)
    };
    let has_update_feed = inspect_method(
        "updateFeed",
        &[
            "String",
            "Integer",
            "Integer",
            "Integer",
            "ByteArray",
            "Integer",
        ],
    )?;
    let has_update_feeds = inspect_method(
        "updateFeeds",
        &["Array", "Array", "Array", "Array", "Array", "Array"],
    )?;
    // The deployed mainnet MorpheusDataFeed retains the exact legacy
    // updateFeed entry point alongside canonical updateFeeds. Mainnet is
    // deterministic because it always selects updateFeeds; testnet and
    // unknown networks must reject a mixed ABI instead of inheriting that
    // compatibility rule.
    if has_update_feed && has_update_feeds && network != "mainnet" {
        return Err(format!(
            "Neo N3 {network} datafeed ABI exposes multiple supported writer ABIs; refusing mixed selection outside the explicit mainnet batch policy"
        ));
    }
    match (network, has_update_feed, has_update_feeds) {
        ("testnet", true, false) => Ok("updateFeed"),
        ("mainnet", _, true) => Ok("updateFeeds"),
        ("mainnet", _, _) => Err(format!(
            "Neo N3 mainnet datafeed has no exact updateFeeds ABI (updateFeed={has_update_feed})"
        )),
        _ => Err(format!(
            "Neo N3 {network} datafeed has no exact supported writer ABI (updateFeeds={has_update_feeds}, updateFeed={has_update_feed})"
        )),
    }
}

#[allow(clippy::too_many_arguments)]
fn parse_n3_signed_plan(
    response: Value,
    contract: &[u8; 20],
    updater: &neo_os_chain_n3::tx::CustodySigner,
    updater_hash: [u8; 20],
    network_magic: u32,
    system_fee: u128,
    network_fee: u128,
    expected_tx_nonce: u32,
    expected_valid_until_block: u32,
    freshness_nonce: &str,
    expected_operation: &str,
) -> Result<N3SignedPlan, String> {
    if response.get("status").and_then(Value::as_str) != Some("ok")
        || response.get("chain").and_then(Value::as_str) != Some("neo_n3")
    {
        return Err("Rust enclave Neo N3 feed response has no ok terminal status".to_string());
    }
    if response.get("nonce").and_then(Value::as_str) != Some(freshness_nonce) {
        return Err("Rust enclave Neo N3 feed freshness nonce mismatch".to_string());
    }
    let pairs = value_array(&response, "pairs")?;
    let rounds = value_array(&response, "rounds")?;
    let prices = value_array(&response, "prices_scaled")?;
    let timestamps = value_array(&response, "timestamps")?;
    let hashes = value_array(&response, "attestation_hashes")?;
    let sources = value_array(&response, "source_set_ids")?;
    let lengths = [
        pairs.len(),
        rounds.len(),
        prices.len(),
        timestamps.len(),
        hashes.len(),
        sources.len(),
    ];
    if pairs.is_empty() || lengths.iter().any(|length| *length != pairs.len()) {
        return Err("Rust enclave Neo N3 feed response contains divergent plan arrays".to_string());
    }
    let strings = |items: &[Value], field: &str| -> Result<Vec<ContractParam>, String> {
        items
            .iter()
            .map(|item| {
                item.as_str()
                    .map(|value| ContractParam::String(value.to_string()))
                    .ok_or_else(|| format!("Neo N3 feed {field} contains a non-string"))
            })
            .collect()
    };
    let integers = |items: &[Value], field: &str| -> Result<Vec<ContractParam>, String> {
        items
            .iter()
            .map(|item| {
                value_i64(item)
                    .map(ContractParam::Integer)
                    .ok_or_else(|| format!("Neo N3 feed {field} contains a non-integer"))
            })
            .collect()
    };
    let hash_params = hashes
        .iter()
        .map(|item| {
            item.as_str()
                .map(|value| ContractParam::Base64Bytes(value.to_string()))
                .ok_or_else(|| "Neo N3 feed attestation hash is not text".to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    let operation = response
        .get("operation")
        .and_then(Value::as_str)
        .ok_or_else(|| "Rust enclave Neo N3 feed response omitted operation".to_string())?;
    let write_mode = response
        .get("write_mode")
        .and_then(Value::as_str)
        .ok_or_else(|| "Rust enclave Neo N3 feed response omitted write_mode".to_string())?;
    if write_mode != operation {
        return Err("Rust enclave Neo N3 feed response has mismatched write mode".to_string());
    }
    if operation != expected_operation {
        return Err(format!(
            "Rust enclave Neo N3 feed operation {operation} did not match probed ABI {expected_operation}"
        ));
    }
    let script = match operation {
        "updateFeeds" => create_invoke_script(
            contract,
            "updateFeeds",
            &[
                ContractParam::Array(strings(pairs, "pairs")?),
                ContractParam::Array(integers(rounds, "rounds")?),
                ContractParam::Array(integers(prices, "prices")?),
                ContractParam::Array(integers(timestamps, "timestamps")?),
                ContractParam::Array(hash_params),
                ContractParam::Array(integers(sources, "source ids")?),
            ],
        ),
        "updateFeed" => {
            if pairs.len() != 1
                || rounds.len() != 1
                || prices.len() != 1
                || timestamps.len() != 1
                || hashes.len() != 1
                || sources.len() != 1
            {
                return Err(
                    "Rust enclave updateFeed response must contain exactly one plan".to_string(),
                );
            }
            create_invoke_script(
                contract,
                "updateFeed",
                &[
                    strings(&pairs[..1], "pairs")?.remove(0),
                    integers(&rounds[..1], "rounds")?.remove(0),
                    integers(&prices[..1], "prices")?.remove(0),
                    integers(&timestamps[..1], "timestamps")?.remove(0),
                    hash_params.into_iter().next().expect("one hash"),
                    integers(&sources[..1], "source ids")?.remove(0),
                ],
            )
        }
        other => return Err(format!("unsupported Neo N3 feed operation {other}")),
    }
    .map_err(|error| error.to_string())?;
    let tx_nonce = response
        .get("tx_nonce")
        .and_then(value_u64)
        .and_then(|value| u32::try_from(value).ok())
        .ok_or_else(|| "Neo N3 feed response omitted tx_nonce".to_string())?;
    let valid_until_block = response
        .get("valid_until_block")
        .and_then(value_u64)
        .and_then(|value| u32::try_from(value).ok())
        .ok_or_else(|| "Neo N3 feed response omitted valid_until_block".to_string())?;
    if tx_nonce != expected_tx_nonce || valid_until_block != expected_valid_until_block {
        return Err(
            "Rust enclave Neo N3 feed response changed nonce or valid-until block".to_string(),
        );
    }
    let public_key = required_value_string(&response, "public_key", "Neo N3 updater public key")?;
    let public_key = decode_hex_value(&public_key)?;
    if hex::encode(&public_key) != updater.public_key.to_ascii_lowercase() {
        return Err("Neo N3 feed signer public key changed after identity lookup".to_string());
    }
    let verification_script = verification_script_single_sig(&public_key)
        .ok_or_else(|| "Neo N3 feed signer returned an invalid public key".to_string())?;
    let mut derived_hash = neo_os_core::n3_tx::hash160(&verification_script);
    derived_hash.reverse();
    if derived_hash != updater_hash {
        return Err(
            "Neo N3 feed signer verification script does not match custody identity".to_string(),
        );
    }
    let signature = decode_hex_value(&required_value_string(
        &response,
        "signature",
        "Neo N3 feed signature",
    )?)?;
    if signature.len() != 64 {
        return Err("Neo N3 feed signature must be exactly 64 bytes".to_string());
    }
    let mut invocation_script = vec![0x0c, 0x40];
    invocation_script.extend_from_slice(&signature);
    let tx = FeedTx {
        nonce: tx_nonce,
        valid_until_block,
        system_fee: u64::try_from(system_fee)
            .map_err(|_| "Neo N3 feed system fee exceeds u64".to_string())?,
        network_fee: u64::try_from(network_fee)
            .map_err(|_| "Neo N3 feed network fee exceeds u64".to_string())?,
        signer: FeedSigner {
            script_hash: updater_hash,
        },
        script: &script,
    };
    let expected_message = hex::encode(tx.message_for_signing(network_magic));
    let returned_message = required_value_string(&response, "tx_message_hex", "signing message")?;
    if !returned_message.eq_ignore_ascii_case(&expected_message) {
        return Err(
            "Rust enclave Neo N3 feed transaction does not match relayer reconstruction"
                .to_string(),
        );
    }
    let verifying_key = P256VerifyingKey::from_sec1_bytes(&public_key)
        .map_err(|_| "Neo N3 feed signer returned an invalid P-256 public key".to_string())?;
    let signature_value = P256Signature::from_slice(&signature)
        .map_err(|_| "Neo N3 feed signer returned an invalid P-256 signature".to_string())?;
    if signature_value.normalize_s().is_some() {
        return Err("Neo N3 feed signer returned a non-canonical high-S signature".to_string());
    }
    verifying_key
        .verify(&tx.message_for_signing(network_magic), &signature_value)
        .map_err(|_| {
            "Neo N3 feed signature does not verify against the reconstructed transaction"
                .to_string()
        })?;
    Ok(N3SignedPlan {
        response,
        script,
        tx_nonce,
        valid_until_block,
        witness: Witness {
            invocation_script,
            verification_script,
        },
    })
}

fn ensure_n3_invoke_halt(value: &Value, label: &str) -> Result<(), String> {
    let state = value
        .get("state")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    if !state.eq_ignore_ascii_case("HALT") {
        let detail = value
            .get("exception")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("missing concrete HALT state");
        return Err(format!("Neo N3 {label} did not HALT ({state}): {detail}"));
    }
    Ok(())
}

fn persist_feed_prepared(
    journal: &dyn DeliveryJournal,
    chain: &str,
    response: &Value,
    stage: &Value,
) -> Result<(), String> {
    let mut state = neo_os_core::state::create_empty_relayer_state();
    if chain == "neox" {
        persist_feed_baseline(&mut state, chain, response)?;
    } else {
        persist_n3_feed_baseline(&mut state, response)?;
    }
    journal.persist("prepared",json!({"feed_response":response,"feed_baseline_patch":feed_baseline(&state,chain),"signed_delivery":stage}))
}

fn persist_n3_feed_baseline(state: &mut JsObject, response: &Value) -> Result<(), String> {
    let pairs = value_array(response, "pairs")?;
    let prices = value_array(response, "prices_scaled")?;
    let timestamps = value_array(response, "timestamps")?;
    let rounds = value_array(response, "rounds")?;
    if prices.len() != pairs.len() || timestamps.len() != pairs.len() || rounds.len() != pairs.len()
    {
        return Err("feed baseline array lengths disagree".into());
    }
    let mut baseline = feed_baseline(state, "neo_n3");
    let records = baseline
        .as_object_mut()
        .ok_or_else(|| "persisted Neo N3 feed baseline is not an object".to_string())?;
    for index in 0..pairs.len() {
        let pair = pairs[index]
            .as_str()
            .ok_or_else(|| "Neo N3 feed pair is not text".to_string())?;
        let symbol = pair.strip_prefix("TWELVEDATA:").unwrap_or(pair);
        let price = value_i64(&prices[index])
            .ok_or_else(|| "Neo N3 feed price is not an integer".to_string())?;
        records.insert(
            symbol.to_string(),
            json!({
                "round": value_i64(&rounds[index]).unwrap_or(0),
                "price": price as f64 / 1_000_000.0,
                "timestamp": value_i64(&timestamps[index]).unwrap_or(0),
            }),
        );
    }
    let mut baselines = state
        .get("feed_baselines")
        .and_then(JsValue::as_object)
        .cloned()
        .unwrap_or_else(JsObject::new);
    baselines.set("neo_n3", JsValue::from_json(&baseline));
    state.set("feed_baselines", JsValue::Object(baselines));
    Ok(())
}

fn value_array<'a>(value: &'a Value, field: &str) -> Result<&'a [Value], String> {
    value
        .get(field)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .ok_or_else(|| format!("Rust enclave feed response is missing {field}[]"))
}

fn value_i64(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_u64().and_then(|value| i64::try_from(value).ok()))
        .or_else(|| value.as_str().and_then(|value| value.parse().ok()))
}

fn parse_hash160_display(value: &str) -> Result<[u8; 20], String> {
    let raw = value
        .trim()
        .strip_prefix("0x")
        .or_else(|| value.trim().strip_prefix("0X"))
        .unwrap_or(value.trim());
    if raw.len() != 40 || !raw.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Neo N3 script hash must be a 20-byte hexadecimal value".to_string());
    }
    decode_hex_value(raw)?
        .try_into()
        .map_err(|_| "Neo N3 script hash must be exactly 20 bytes".to_string())
}

struct NeoxFeedTxEnvelope<'a> {
    from: &'a str,
    to: &'a str,
    chain_id: u64,
    nonce: u64,
    gas_limit: u64,
    max_fee: u128,
    priority_fee: u128,
}

fn validate_host_neox_response(
    response: &Value,
    expected: &NeoxFeedTxEnvelope<'_>,
) -> Result<(), String> {
    let returned_from = required_value_string(response, "from", "NeoX updater address")?;
    let returned_to = required_value_string(response, "to", "NeoX feed target")?;
    if !returned_from.eq_ignore_ascii_case(expected.from)
        || !returned_to.eq_ignore_ascii_case(expected.to)
    {
        return Err("Rust enclave feed response changed the updater or target address".to_string());
    }
    if response.get("chain_id").and_then(value_u64) != Some(expected.chain_id)
        || response.get("nonce").and_then(value_u64) != Some(expected.nonce)
        || response.get("gas_limit").and_then(value_u64) != Some(expected.gas_limit)
        || response.get("max_fee_per_gas").and_then(value_u128) != Some(expected.max_fee)
        || response
            .get("max_priority_fee_per_gas")
            .and_then(value_u128)
            != Some(expected.priority_fee)
    {
        return Err(
            "Rust enclave feed response changed chain, nonce, gas, or fee fields".to_string(),
        );
    }
    let lengths = ["symbols", "prices_scaled", "timestamps", "round_ids"]
        .map(|field| response.get(field).and_then(Value::as_array).map(Vec::len));
    if lengths.iter().any(Option::is_none)
        || lengths
            .iter()
            .flatten()
            .copied()
            .collect::<std::collections::BTreeSet<_>>()
            .len()
            != 1
        || lengths[0] == Some(0)
    {
        return Err("Rust enclave feed response contains divergent plan arrays".to_string());
    }
    Ok(())
}

fn feed_symbols(config: &RelayerConfig) -> Result<Vec<String>, String> {
    let symbols = config
        .raw
        .pointer("/feedSync/symbols")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if symbols.is_empty() {
        Err("feedSync.symbols must contain at least one symbol".to_string())
    } else {
        Ok(symbols)
    }
}

fn feed_baseline(state: &JsObject, chain: &str) -> Value {
    state
        .get("feed_baselines")
        .and_then(JsValue::as_object)
        .and_then(|baselines| baselines.get(chain))
        .map(crate::config::js_value_to_json)
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}))
}

fn persist_feed_baseline(
    state: &mut JsObject,
    chain: &str,
    response: &Value,
) -> Result<(), String> {
    let symbols = response["symbols"]
        .as_array()
        .ok_or_else(|| "feed response symbols are missing".to_string())?;
    let prices = response["prices_scaled"]
        .as_array()
        .ok_or_else(|| "feed response prices are missing".to_string())?;
    let timestamps = response["timestamps"]
        .as_array()
        .ok_or_else(|| "feed response timestamps are missing".to_string())?;
    let rounds = response["round_ids"]
        .as_array()
        .ok_or_else(|| "feed response rounds are missing".to_string())?;
    if prices.len() != symbols.len()
        || timestamps.len() != symbols.len()
        || rounds.len() != symbols.len()
    {
        return Err("feed baseline array lengths disagree".into());
    }
    let mut baseline = feed_baseline(state, chain);
    let baseline_object = baseline
        .as_object_mut()
        .ok_or_else(|| "persisted feed baseline is not an object".to_string())?;
    for index in 0..symbols.len() {
        let pair = symbols[index]
            .as_str()
            .ok_or_else(|| "feed response symbol is not a string".to_string())?;
        let symbol = pair.strip_prefix("TWELVEDATA:").unwrap_or(pair);
        let price_scaled = prices[index]
            .as_str()
            .and_then(|value| value.parse::<f64>().ok())
            .ok_or_else(|| "feed response price is not numeric text".to_string())?;
        baseline_object.insert(
            symbol.to_string(),
            json!({
                "round": value_u128(&rounds[index]).unwrap_or(0).to_string(),
                "price": price_scaled / 1_000_000.0,
                "timestamp": value_u128(&timestamps[index]).unwrap_or(0).to_string(),
            }),
        );
    }
    let mut baselines = state
        .get("feed_baselines")
        .and_then(JsValue::as_object)
        .cloned()
        .unwrap_or_else(JsObject::new);
    baselines.set(chain, JsValue::from_json(&baseline));
    state.set("feed_baselines", JsValue::Object(baselines));
    Ok(())
}

fn set_metric(state: &mut JsObject, key: &str, value: JsValue) {
    if let Some(metrics) = state.get_mut("metrics").and_then(JsValue::as_object_mut) {
        metrics.set(key, value);
    }
}

fn object_at<'a>(
    value: &'a Value,
    field: &str,
) -> Result<&'a serde_json::Map<String, Value>, String> {
    value
        .get(field)
        .and_then(Value::as_object)
        .ok_or_else(|| format!("relayer configuration is missing {field}"))
}

fn required_string(
    object: &serde_json::Map<String, Value>,
    field: &str,
    label: &str,
) -> Result<String, String> {
    object
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("{label} is not configured"))
}

fn required_value_string(value: &Value, field: &str, label: &str) -> Result<String, String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("Rust enclave feed response is missing {label}"))
}

fn string_array(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn value_u64(value: &Value) -> Option<u64> {
    value
        .as_u64()
        .or_else(|| value.as_str().and_then(|text| text.parse().ok()))
}

fn value_u128(value: &Value) -> Option<u128> {
    value
        .as_u64()
        .map(u128::from)
        .or_else(|| value.as_str().and_then(|text| text.parse().ok()))
}

fn parse_evm_address(value: &str) -> Result<[u8; 20], String> {
    let raw = value
        .trim()
        .strip_prefix("0x")
        .or_else(|| value.trim().strip_prefix("0X"))
        .unwrap_or(value.trim());
    if raw.len() != 40 || !raw.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("EVM address must be 0x-prefixed 20-byte hexadecimal".to_string());
    }
    let bytes = decode_hex_value(raw)?;
    bytes
        .try_into()
        .map_err(|_| "EVM address must be exactly 20 bytes".to_string())
}

fn canonical_address(value: [u8; 20]) -> String {
    format!("0x{}", hex::encode(value))
}

fn decode_hex_value(value: &str) -> Result<Vec<u8>, String> {
    let raw = value
        .trim()
        .strip_prefix("0x")
        .or_else(|| value.trim().strip_prefix("0X"))
        .unwrap_or(value.trim());
    if raw.is_empty() || !raw.len().is_multiple_of(2) {
        return Err("hex value must be non-empty and even-length".to_string());
    }
    hex::decode(raw).map_err(|_| "hex value contains invalid characters".to_string())
}

fn service_endpoint(base: &str, path: &str) -> Result<String, String> {
    let mut parsed = url::Url::parse(base)
        .map_err(|_| "Rust enclave URL must be an absolute http(s) URL".to_string())?;
    if !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err("Rust enclave URL must not contain userinfo, query, or fragment".to_string());
    }
    match parsed.scheme() {
        "https" => {}
        "http" if is_loopback(&parsed) => {}
        "http" => return Err("Rust enclave URL may use HTTP only on loopback".to_string()),
        _ => return Err("Rust enclave URL must use http or https".to_string()),
    }
    if !parsed.path().ends_with(path) {
        parsed.set_path(&format!("{}{}", parsed.path().trim_end_matches('/'), path));
    }
    Ok(parsed.to_string())
}

fn is_loopback(url: &url::Url) -> bool {
    match url.host() {
        Some(url::Host::Domain(host)) => host.eq_ignore_ascii_case("localhost"),
        Some(url::Host::Ipv4(address)) => address.is_loopback(),
        Some(url::Host::Ipv6(address)) => address.is_loopback(),
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::Mutex;

    use neo_os_chain_evm::{decode_signed_eip1559, EvmWaiter, HttpTransport};
    use neo_os_chain_n3::tx::FixedNonce;
    use neo_os_core::{
        n3_tx::{
            create_invoke_script, hash160, verification_script_single_sig, ContractParam,
            FeedSigner, FeedTx,
        },
        state::create_empty_relayer_state,
    };
    use p256::ecdsa::{signature::Signer as _, Signature as P256Signature, SigningKey};
    use rlp::RlpStream;
    use serde_json::json;

    use super::{process_feed_sync_with, FeedSyncResult};
    use crate::config::RelayerConfig;

    struct NoWait(Mutex<u64>);

    impl EvmWaiter for NoWait {
        fn now_ms(&self) -> u64 {
            *self.0.lock().unwrap()
        }
        fn sleep(&self, duration: std::time::Duration) {
            *self.0.lock().unwrap() += duration.as_millis() as u64;
        }
    }

    struct ScriptedTransport {
        replies: Mutex<VecDeque<(u16, String)>>,
        calls: Mutex<Vec<(String, String)>>,
    }

    impl ScriptedTransport {
        fn new(replies: Vec<(u16, serde_json::Value)>) -> Self {
            Self {
                replies: Mutex::new(
                    replies
                        .into_iter()
                        .map(|(status, value)| (status, value.to_string()))
                        .collect(),
                ),
                calls: Mutex::new(Vec::new()),
            }
        }

        fn answer(&self, url: &str, body: &str) -> Result<(u16, String), String> {
            self.calls
                .lock()
                .unwrap()
                .push((url.to_string(), body.to_string()));
            self.replies
                .lock()
                .unwrap()
                .pop_front()
                .ok_or_else(|| format!("unexpected HTTP call to {url}"))
        }
    }

    impl HttpTransport for ScriptedTransport {
        fn post(&self, url: &str, body: &str) -> Result<(u16, String), String> {
            self.answer(url, body)
        }
        fn get(&self, url: &str) -> Result<(u16, String), String> {
            self.answer(url, "")
        }
        fn post_with_bearer(
            &self,
            url: &str,
            _token: &str,
            _timeout_ms: u64,
            body: &str,
        ) -> Result<(u16, String), String> {
            self.answer(url, body)
        }
        fn get_with_bearer(
            &self,
            url: &str,
            _token: &str,
            _timeout_ms: u64,
        ) -> Result<(u16, String), String> {
            self.answer(url, "")
        }
    }

    impl neo_os_chain_n3::HttpTransport for ScriptedTransport {
        fn post(&self, url: &str, body: &str) -> Result<(u16, String), String> {
            self.answer(url, body)
        }
        fn get(&self, url: &str) -> Result<(u16, String), String> {
            self.answer(url, "")
        }
        fn post_with_bearer(
            &self,
            url: &str,
            _token: &str,
            _timeout_ms: u64,
            body: &str,
        ) -> Result<(u16, String), String> {
            self.answer(url, body)
        }
        fn get_with_bearer(
            &self,
            url: &str,
            _token: &str,
            _timeout_ms: u64,
        ) -> Result<(u16, String), String> {
            self.answer(url, "")
        }
    }

    struct N3FeedTransport {
        signing_key: SigningKey,
        public_key: Vec<u8>,
        script_hash: [u8; 20],
        singular_abi: bool,
        include_mode_fields: bool,
        no_update_mode: Option<&'static str>,
        calls: Mutex<Vec<(String, String)>>,
    }

    impl N3FeedTransport {
        fn new() -> Self {
            Self::with_options(false, true)
        }

        fn without_mode_fields() -> Self {
            Self::with_options(false, false)
        }

        fn testnet_per_pair() -> Self {
            Self::with_options(true, true)
        }

        fn with_options(singular_abi: bool, include_mode_fields: bool) -> Self {
            let signing_key = SigningKey::from_slice(&[7u8; 32]).expect("test key");
            let public_key = signing_key
                .verifying_key()
                .to_encoded_point(true)
                .as_bytes()
                .to_vec();
            let verification = verification_script_single_sig(&public_key).expect("test script");
            let mut script_hash = hash160(&verification);
            script_hash.reverse();
            Self {
                signing_key,
                public_key,
                script_hash,
                singular_abi,
                include_mode_fields,
                no_update_mode: None,
                calls: Mutex::new(Vec::new()),
            }
        }

        fn no_update_without_mode_fields() -> Self {
            let mut transport = Self::with_options(false, true);
            transport.no_update_mode = Some("");
            transport
        }

        fn no_update_with_mode(operation: &'static str) -> Self {
            let mut transport = Self::with_options(false, true);
            transport.no_update_mode = Some(operation);
            transport
        }

        fn answer(&self, url: &str, body: &str) -> Result<(u16, String), String> {
            self.calls
                .lock()
                .unwrap()
                .push((url.to_string(), body.to_string()));
            if url.ends_with("/signer/api/v1/keys/n3-updater") {
                return Ok((
                    200,
                    json!({
                        "allowed": true,
                        "key_id": "n3-updater",
                        "chain_family": "neo-n3",
                        "public_key": hex::encode(&self.public_key),
                        "script_hash": format!("0x{}", hex::encode(self.script_hash)),
                        "address": "NTestUpdaterAddress",
                    })
                    .to_string(),
                ));
            }
            if url.ends_with("/feed/sign") {
                let request: serde_json::Value = serde_json::from_str(body).unwrap();
                if let Some(operation) = self.no_update_mode {
                    let mut response = json!({
                        "status": "no-update",
                        "chain": "neo_n3",
                    });
                    if !operation.is_empty() {
                        response["write_mode"] = json!(operation);
                        response["operation"] = json!(operation);
                    }
                    return Ok((200, response.to_string()));
                }
                let tx_params = request["tx_params"].as_object().unwrap();
                let quantity = |field: &str| -> u64 {
                    tx_params[field]
                        .as_str()
                        .and_then(|value| value.parse().ok())
                        .or_else(|| tx_params[field].as_u64())
                        .unwrap()
                };
                let tx_nonce = quantity("nonce") as u32;
                let system_fee = quantity("system_fee");
                let network_fee = quantity("network_fee");
                let operation = request["write_mode"].as_str().unwrap_or("updateFeeds");
                let network_magic = if self.singular_abi {
                    894_710_606
                } else {
                    860_833_102
                };
                let contract = hex::decode(if self.singular_abi {
                    "9bea75cf702f6afc09125aa6d22f082bfd2ee064"
                } else {
                    "03013f49c42a14546c8bbe58f9d434c3517fccab"
                })
                .unwrap()
                .try_into()
                .unwrap();
                let pairs = vec![ContractParam::String("TWELVEDATA:NEO-USD".into())];
                let rounds = vec![ContractParam::Integer(1)];
                let prices = vec![ContractParam::Integer(123_000_000)];
                let timestamps = vec![ContractParam::Integer(1_700_000_000)];
                let hashes = vec![ContractParam::Base64Bytes(
                    "0123456789abcdef0123456789abcdef".into(),
                )];
                let sources = vec![ContractParam::Integer(0)];
                let script = if operation == "updateFeed" {
                    create_invoke_script(
                        &contract,
                        "updateFeed",
                        &[
                            pairs.into_iter().next().unwrap(),
                            rounds.into_iter().next().unwrap(),
                            prices.into_iter().next().unwrap(),
                            timestamps.into_iter().next().unwrap(),
                            hashes.into_iter().next().unwrap(),
                            sources.into_iter().next().unwrap(),
                        ],
                    )
                    .unwrap()
                } else {
                    create_invoke_script(
                        &contract,
                        "updateFeeds",
                        &[
                            ContractParam::Array(pairs),
                            ContractParam::Array(rounds),
                            ContractParam::Array(prices),
                            ContractParam::Array(timestamps),
                            ContractParam::Array(hashes),
                            ContractParam::Array(sources),
                        ],
                    )
                    .unwrap()
                };
                let tx = FeedTx {
                    nonce: tx_nonce,
                    valid_until_block: 1_500,
                    system_fee,
                    network_fee,
                    signer: FeedSigner {
                        script_hash: self.script_hash,
                    },
                    script: &script,
                };
                let message = tx.message_for_signing(network_magic);
                let signature: P256Signature = self.signing_key.sign(&message);
                let signature = signature.normalize_s().unwrap_or(signature);
                let mut response = json!({
                    "status": "ok",
                    "chain": "neo_n3",
                    "pairs": ["TWELVEDATA:NEO-USD"],
                    "rounds": [1],
                    "prices_scaled": [123_000_000],
                    "timestamps": [1_700_000_000],
                    "attestation_hashes": ["0123456789abcdef0123456789abcdef"],
                    "source_set_ids": [0],
                    "tx_message_hex": hex::encode(message),
                    "tx_nonce": tx_nonce,
                    "valid_until_block": 1_500,
                    "signature": hex::encode(signature.to_bytes()),
                    "public_key": hex::encode(&self.public_key),
                    "trust_tier": "enclave-attested",
                    "nonce": request["nonce"],
                });
                if self.include_mode_fields {
                    response["write_mode"] = json!(operation);
                    response["operation"] = json!(operation);
                }
                return Ok((200, response.to_string()));
            }

            let request: serde_json::Value = serde_json::from_str(body)
                .map_err(|error| format!("invalid test RPC request: {error}"))?;
            let result = match request["method"].as_str().unwrap_or_default() {
                "getblockcount" => json!(1_000),
                "getcontractstate" => {
                    let method = if self.singular_abi {
                        json!({
                            "name": "updateFeed",
                            "parameters": [
                                {"type": "String"}, {"type": "Integer"},
                                {"type": "Integer"}, {"type": "Integer"},
                                {"type": "ByteArray"}, {"type": "Integer"}
                            ]
                        })
                    } else {
                        json!({
                            "name": "updateFeeds",
                            "parameters": [
                                {"type": "Array"}, {"type": "Array"},
                                {"type": "Array"}, {"type": "Array"},
                                {"type": "Array"}, {"type": "Array"}
                            ]
                        })
                    };
                    json!({"manifest": {"abi": {"methods": [method]}}})
                }
                "invokescript" => json!({"state":"HALT", "gasconsumed":"100000"}),
                "calculatenetworkfee" => json!({"networkfee":"123456"}),
                "sendrawtransaction" => json!(true),
                "getapplicationlog" => json!({
                    "executions": [{"vmstate":"HALT", "exception": null}]
                }),
                method => return Err(format!("unexpected Neo N3 RPC method {method}")),
            };
            Ok((200, rpc(result).to_string()))
        }
    }

    impl HttpTransport for N3FeedTransport {
        fn post(&self, url: &str, body: &str) -> Result<(u16, String), String> {
            self.answer(url, body)
        }
        fn get(&self, url: &str) -> Result<(u16, String), String> {
            self.answer(url, "")
        }
        fn post_with_bearer(
            &self,
            url: &str,
            _token: &str,
            _timeout_ms: u64,
            body: &str,
        ) -> Result<(u16, String), String> {
            self.answer(url, body)
        }
        fn get_with_bearer(
            &self,
            url: &str,
            _token: &str,
            _timeout_ms: u64,
        ) -> Result<(u16, String), String> {
            self.answer(url, "")
        }
    }

    impl neo_os_chain_n3::HttpTransport for N3FeedTransport {
        fn post(&self, url: &str, body: &str) -> Result<(u16, String), String> {
            self.answer(url, body)
        }
        fn get(&self, url: &str) -> Result<(u16, String), String> {
            self.answer(url, "")
        }
        fn post_with_bearer(
            &self,
            url: &str,
            _token: &str,
            _timeout_ms: u64,
            body: &str,
        ) -> Result<(u16, String), String> {
            self.answer(url, body)
        }
        fn get_with_bearer(
            &self,
            url: &str,
            _token: &str,
            _timeout_ms: u64,
        ) -> Result<(u16, String), String> {
            self.answer(url, "")
        }
    }

    fn rpc(result: serde_json::Value) -> serde_json::Value {
        json!({"jsonrpc":"2.0","id":1,"result":result})
    }

    fn signed_tx(data: &[u8]) -> (String, String, String) {
        fn minimal(word: &[u8]) -> &[u8] {
            let first = word
                .iter()
                .position(|byte| *byte != 0)
                .unwrap_or(word.len());
            &word[first..]
        }

        let mut unsigned = RlpStream::new_list(9);
        unsigned.append(&12_227_332u64);
        unsigned.append(&7u64);
        unsigned.append(&2u128);
        unsigned.append(&10u128);
        unsigned.append(&200_000u64);
        unsigned.append(&[0x11u8; 20].as_slice());
        unsigned.append_empty_data();
        unsigned.append(&data);
        unsigned.begin_list(0);
        let mut signing_payload = vec![0x02];
        signing_payload.extend_from_slice(&unsigned.out());
        let signing_hash = neo_os_chain_evm::keccak256(&signing_payload);
        let key = k256::ecdsa::SigningKey::from_slice(&[8u8; 32]).unwrap();
        let (signature, recovery_id) = key.sign_prehash_recoverable(&signing_hash).unwrap();
        let mut stream = RlpStream::new_list(12);
        stream.append(&12_227_332u64);
        stream.append(&7u64);
        stream.append(&2u128);
        stream.append(&10u128);
        stream.append(&200_000u64);
        stream.append(&[0x11u8; 20].as_slice());
        stream.append_empty_data();
        stream.append(&data);
        stream.begin_list(0);
        stream.append(&recovery_id.to_byte());
        stream.append(&minimal(signature.r().to_bytes().as_slice()));
        stream.append(&minimal(signature.s().to_bytes().as_slice()));
        let mut raw = vec![0x02];
        raw.extend_from_slice(&stream.out());
        let public_key = key.verifying_key().to_encoded_point(false);
        let address_hash = neo_os_chain_evm::keccak256(&public_key.as_bytes()[1..]);
        (
            format!("0x{}", hex::encode(raw)),
            format!("0x{}", hex::encode(&address_hash[12..])),
            format!(
                "0x{}",
                hex::encode(key.verifying_key().to_encoded_point(true).as_bytes())
            ),
        )
    }

    fn config(active_chain: &str) -> RelayerConfig {
        RelayerConfig {
            repo_root: ".".into(),
            instance_id: "test".into(),
            state_file: "unused.json".into(),
            network: "testnet".into(),
            node_env: "test".into(),
            mode: "feed_only".into(),
            active_chains: vec![active_chain.into()],
            poll_interval_ms: 1_000,
            concurrency: 1,
            max_blocks_per_tick: 10,
            discovery_idle_backoff_ms: 0,
            state_persist_min_interval_ms: 0,
            raw: json!({
                "feedSync": {"enabled": true, "intervalMs": 0, "symbols": ["NEO-USD"]},
                "nitro": {
                    "apiUrl": "https://enclave.example",
                    "token": "runtime-token",
                    "timeoutMs": 5000,
                    "custodyUrl": "https://custody.example",
                    "custodyToken": "custody-token"
                },
                "neox": {
                    "rpcUrl": "https://rpc.example",
                    "rpcUrls": ["https://rpc.example"],
                    "chainId": 12227332,
                    "datafeedContract": "0x1111111111111111111111111111111111111111",
                    "feedGasLimit": 200000,
                    "confirmTimeoutMs": 5000,
                    "custodyKeyIds": {"updater": "neox-updater"}
                },
                "neo_n3": {
                    "rpcUrls": ["https://n3-rpc.example"],
                    "networkMagic": 860833102,
                    "datafeedContract": "0x03013f49c42a14546c8bbe58f9d434c3517fccab",
                    "fulfillConfirmTimeoutMs": 5000,
                    "custodyKeyIds": {"updater": "n3-updater"}
                }
            }),
        }
    }

    fn testnet_per_pair_config() -> RelayerConfig {
        let mut config = config("neo_n3");
        let n3 = config
            .raw
            .get_mut("neo_n3")
            .and_then(serde_json::Value::as_object_mut)
            .expect("neo_n3 config");
        n3.insert("networkMagic".into(), json!(894_710_606u32));
        n3.insert(
            "datafeedContract".into(),
            json!("0x9bea75cf702f6afc09125aa6d22f082bfd2ee064"),
        );
        config
    }

    #[test]
    fn neo_n3_feed_reconstructs_verifies_broadcasts_confirms_and_persists() {
        let mut state = create_empty_relayer_state();
        let transport = N3FeedTransport::new();
        let result = process_feed_sync_with(
            &config("neo_n3"),
            &mut state,
            1_700_000_000_000.0,
            &transport,
            &NoWait(Mutex::new(1_700_000_000_000)),
            &FixedNonce(1),
        );

        assert!(result.enabled);
        assert!(!result.skipped);
        assert!(result.error.is_none(), "{result:?}");
        let calls = transport.calls.lock().unwrap();
        assert_eq!(calls.len(), 12);
        assert!(calls.iter().any(|(_, body)| body.contains("getblockcount")));
        assert!(calls
            .iter()
            .any(|(_, body)| body.contains("getcontractstate")));
        assert!(
            calls
                .iter()
                .filter(|(url, _)| url.ends_with("/feed/sign"))
                .count()
                == 3
        );
        assert!(calls
            .iter()
            .any(|(_, body)| body.contains("sendrawtransaction")));
        assert!(calls
            .iter()
            .any(|(_, body)| body.contains("getapplicationlog")));
        assert!(state.get("last_feed_delivery").is_some());
        assert_eq!(
            super::feed_baseline(&state, "neo_n3")["NEO-USD"]["price"],
            123.0
        );
    }

    /// `invokescript` takes a **script**, not a transaction. Every feed
    /// simulation must carry the exact bytes the node will execute; handing it
    /// the unsigned transaction serialization makes the node execute
    /// transaction framing as opcodes and fault with interpreter errors that
    /// look like contract bugs. The initial simulation and the final
    /// simulation are two call sites of the same rule and are pinned together.
    #[test]
    fn the_final_feed_simulation_carries_the_script_not_the_transaction() {
        let mut state = create_empty_relayer_state();
        let transport = N3FeedTransport::new();
        let result = process_feed_sync_with(
            &config("neo_n3"),
            &mut state,
            1_700_000_000_000.0,
            &transport,
            &NoWait(Mutex::new(1_700_000_000_000)),
            &FixedNonce(1),
        );
        assert!(result.error.is_none(), "{result:?}");

        // The invocation script every simulation must carry. Reconstructed
        // with the same operation and plan the test host signs.
        let contract: [u8; 20] =
            hex::decode("03013f49c42a14546c8bbe58f9d434c3517fccab")
                .unwrap()
                .try_into()
                .unwrap();
        let expected_script = create_invoke_script(
            &contract,
            "updateFeeds",
            &[
                ContractParam::Array(vec![ContractParam::String(
                    "TWELVEDATA:NEO-USD".into(),
                )]),
                ContractParam::Array(vec![ContractParam::Integer(1)]),
                ContractParam::Array(vec![ContractParam::Integer(123_000_000)]),
                ContractParam::Array(vec![ContractParam::Integer(1_700_000_000)]),
                ContractParam::Array(vec![ContractParam::Base64Bytes(
                    "0123456789abcdef0123456789abcdef".into(),
                )]),
                ContractParam::Array(vec![ContractParam::Integer(0)]),
            ],
        )
        .expect("expected script");

        // Transaction framing is strictly longer and starts with the version
        // byte; a simulation that carries it is the defect this test pins.
        let framing_probe = FeedTx {
            nonce: 1,
            valid_until_block: 1_500,
            system_fee: 200_000,
            network_fee: 123_456,
            signer: FeedSigner {
                script_hash: [0u8; 20],
            },
            script: &expected_script,
        }
        .serialize_unsigned();
        assert!(
            framing_probe.len() > expected_script.len(),
            "framing must be longer than the bare script"
        );

        let calls = transport.calls.lock().unwrap();
        let invoke_calls: Vec<&(String, String)> = calls
            .iter()
            .filter(|(_, body)| body.contains("\"method\":\"invokescript\""))
            .collect();
        assert!(
            invoke_calls.len() >= 2,
            "expected the initial and final simulations, got {} invokescript calls",
            invoke_calls.len()
        );
        for (url, body) in &invoke_calls {
            let request: serde_json::Value =
                serde_json::from_str(body).unwrap_or_else(|error| {
                    panic!("invokescript call to {url} is not JSON: {error}\n{body}")
                });
            assert_eq!(request["method"], "invokescript");
            let encoded = request["params"][0]
                .as_str()
                .expect("invokescript script parameter");
            let decoded = neo_os_core::base64::decode_lenient(encoded);
            assert_eq!(
                decoded.as_slice(),
                expected_script.as_slice(),
                "the invokescript simulation at {url} must carry the invocation script, not the transaction framing"
            );
        }
    }

    #[test]
    fn neo_n3_feed_rejects_a_signed_response_without_explicit_mode_fields() {
        let mut state = create_empty_relayer_state();
        let transport = N3FeedTransport::without_mode_fields();
        let result = process_feed_sync_with(
            &config("neo_n3"),
            &mut state,
            1_700_000_000_000.0,
            &transport,
            &NoWait(Mutex::new(1_700_000_000_000)),
            &FixedNonce(1),
        );
        assert!(result
            .error
            .as_deref()
            .is_some_and(|error| error.contains("operation")));
        assert!(state.get("last_feed_delivery").is_none());
    }

    #[test]
    fn neo_n3_feed_rejects_a_no_update_response_without_explicit_mode_fields() {
        let mut state = create_empty_relayer_state();
        let transport = N3FeedTransport::no_update_without_mode_fields();
        let result = process_feed_sync_with(
            &config("neo_n3"),
            &mut state,
            1_700_000_000_000.0,
            &transport,
            &NoWait(Mutex::new(1_700_000_000_000)),
            &FixedNonce(1),
        );
        assert!(result
            .error
            .as_deref()
            .is_some_and(|error| error.contains("no-update response omitted operation")));
        assert!(state.get("last_feed_delivery").is_none());
    }

    #[test]
    fn neo_n3_feed_rejects_a_no_update_response_for_the_wrong_probed_mode() {
        let mut state = create_empty_relayer_state();
        let transport = N3FeedTransport::no_update_with_mode("updateFeed");
        let result = process_feed_sync_with(
            &config("neo_n3"),
            &mut state,
            1_700_000_000_000.0,
            &transport,
            &NoWait(Mutex::new(1_700_000_000_000)),
            &FixedNonce(1),
        );
        assert!(result
            .error
            .as_deref()
            .is_some_and(|error| error.contains("did not match probed ABI")));
        assert!(state.get("last_feed_delivery").is_none());
    }

    #[test]
    fn neo_n3_feed_accepts_a_no_update_response_for_the_probed_mode() {
        let mut state = create_empty_relayer_state();
        let transport = N3FeedTransport::no_update_with_mode("updateFeeds");
        let result = process_feed_sync_with(
            &config("neo_n3"),
            &mut state,
            1_700_000_000_000.0,
            &transport,
            &NoWait(Mutex::new(1_700_000_000_000)),
            &FixedNonce(1),
        );
        assert!(result.error.is_none(), "{result:?}");
        assert_eq!(result.reason.as_deref(), Some("no_update"));
        assert!(state.get("last_feed_delivery").is_none());
    }

    #[test]
    fn neo_n3_testnet_feed_runs_the_probed_per_pair_path_end_to_end() {
        let mut state = create_empty_relayer_state();
        let transport = N3FeedTransport::testnet_per_pair();
        let result = process_feed_sync_with(
            &testnet_per_pair_config(),
            &mut state,
            1_700_000_000_000.0,
            &transport,
            &NoWait(Mutex::new(1_700_000_000_000)),
            &FixedNonce(1),
        );
        assert!(result.error.is_none(), "{result:?}");
        assert!(state.get("last_feed_delivery").is_some());
        let calls = transport.calls.lock().unwrap();
        let sign_requests = calls
            .iter()
            .filter(|(url, _)| url.ends_with("/feed/sign"))
            .map(|(_, body)| body)
            .collect::<Vec<_>>();
        assert_eq!(sign_requests.len(), 3);
        assert!(sign_requests
            .iter()
            .all(|body| body.contains("\"write_mode\":\"updateFeed\"")));
        assert!(sign_requests
            .iter()
            .all(|body| body.contains("\"operation\":\"updateFeed\"")));
    }

    #[test]
    fn n3_abi_probe_selects_testnet_per_pair_and_rejects_mainnet_downgrade() {
        let singular = json!({
            "manifest": {"abi": {"methods": [{
                "name": "updateFeed",
                "parameters": [
                    {"type": "String"}, {"type": "Integer"},
                    {"type": "Integer"}, {"type": "Integer"},
                    {"type": "ByteArray"}, {"type": "Integer"}
                ]
            }]}}
        });
        assert_eq!(
            super::resolve_n3_feed_write_mode(&singular, "testnet").unwrap(),
            "updateFeed"
        );
        assert!(super::resolve_n3_feed_write_mode(&singular, "mainnet")
            .unwrap_err()
            .contains("mainnet"));

        let batch = json!({
            "manifest": {"abi": {"methods": [{
                "name": "updateFeeds",
                "parameters": [
                    {"type": "Array"}, {"type": "Array"},
                    {"type": "Array"}, {"type": "Array"},
                    {"type": "Array"}, {"type": "Array"}
                ]
            }]}}
        });
        assert!(super::resolve_n3_feed_write_mode(&batch, "testnet")
            .unwrap_err()
            .contains("no exact supported writer ABI"));

        let mixed = json!({
            "manifest": {"abi": {"methods": [
                {"name": "updateFeed", "parameters": [
                    {"type": "String"}, {"type": "Integer"},
                    {"type": "Integer"}, {"type": "Integer"},
                    {"type": "ByteArray"}, {"type": "Integer"}
                ]},
                {"name": "updateFeeds", "parameters": [
                    {"type": "Array"}, {"type": "Array"},
                    {"type": "Array"}, {"type": "Array"},
                    {"type": "Array"}, {"type": "Array"}
                ]}
            ]}}
        });
        assert!(super::resolve_n3_feed_write_mode(&mixed, "testnet")
            .unwrap_err()
            .contains("multiple supported writer ABIs"));
        assert_eq!(
            super::resolve_n3_feed_write_mode(&mixed, "mainnet").unwrap(),
            "updateFeeds"
        );

        let duplicate = json!({
            "manifest": {"abi": {"methods": [
                {"name": "updateFeeds", "parameters": [
                    {"type": "Array"}, {"type": "Array"}, {"type": "Array"},
                    {"type": "Array"}, {"type": "Array"}, {"type": "Array"}
                ]},
                {"name": "updateFeeds", "parameters": [
                    {"type": "Array"}, {"type": "Array"}, {"type": "Array"},
                    {"type": "Array"}, {"type": "Array"}, {"type": "Array"}
                ]}
            ]}}
        });
        assert!(super::resolve_n3_feed_write_mode(&duplicate, "mainnet")
            .unwrap_err()
            .contains("ambiguous"));

        let wrong_shape = json!({
            "manifest": {"abi": {"methods": [
                {"name": "updateFeeds", "parameters": [
                    {"type": "Array"}, {"type": "Array"}, {"type": "Array"}
                ]}
            ]}}
        });
        assert!(super::resolve_n3_feed_write_mode(&wrong_shape, "mainnet")
            .unwrap_err()
            .contains("wrong"));

        let wrong_type_case = json!({
            "manifest": {"abi": {"methods": [{
                "name": "updateFeeds",
                "parameters": [
                    {"type": "array"}, {"type": "Array"},
                    {"type": "Array"}, {"type": "Array"},
                    {"type": "Array"}, {"type": "Array"}
                ]
            }]}}
        });
        assert!(
            super::resolve_n3_feed_write_mode(&wrong_type_case, "mainnet")
                .unwrap_err()
                .contains("wrong parameter types")
        );
    }

    #[test]
    fn neox_feed_requires_identity_plan_simulation_broadcast_receipt_and_persistence() {
        let selector =
            &neo_os_chain_evm::keccak256(b"updateFeeds(string[],uint256[],uint256[],uint256[])")
                [..4];
        let mut calldata = selector.to_vec();
        calldata.extend_from_slice(&[0u8; 128]);
        let (signed, updater_address, updater_public_key) = signed_tx(&calldata);
        let tx_hash = decode_signed_eip1559(&signed).unwrap().tx_hash;
        let transport = ScriptedTransport::new(vec![
            (
                200,
                json!({
                    "allowed": true,
                    "key_id": "neox-updater",
                    "chain_family": "neox",
                    "chain_id": 12227332,
                    "address": updater_address,
                "public_key": updater_public_key
                }),
            ),
            (200, rpc(json!("0x7"))),
            (200, rpc(json!("0x4"))),
            (200, rpc(json!("0x2"))),
            (
                200,
                json!({
                    "status": "ok",
                    "chain": "neox",
                    "signed_tx": signed,
                    "from": updater_address,
                    "to": "0x1111111111111111111111111111111111111111",
                    "nonce": 7,
                    "chain_id": 12227332,
                    "data": format!("0x{}", hex::encode(&calldata)),
                    "symbols": ["TWELVEDATA:NEO-USD"],
                    "prices_scaled": ["123000000"],
                    "timestamps": ["1700000000"],
                    "round_ids": ["1700000000"],
                    "gas_limit": "200000",
                    "max_fee_per_gas": "10",
                    "max_priority_fee_per_gas": "2",
                    "trust_tier": "enclave-attested"
                }),
            ),
            (200, rpc(json!("0x186a0"))),
            (200, rpc(json!(tx_hash.clone()))),
            (
                200,
                rpc(json!({
                    "transactionHash": tx_hash,
                    "status": "0x1",
                    "blockNumber": "0x63"
                })),
            ),
        ]);
        let mut state = create_empty_relayer_state();
        let result: FeedSyncResult = process_feed_sync_with(
            &config("neox"),
            &mut state,
            1_700_000_000_000.0,
            &transport,
            &NoWait(Mutex::new(1_700_000_000_000)),
            &FixedNonce(9),
        );

        assert!(result.error.is_none(), "{result:?}");
        assert!(!result.skipped);
        let calls = transport.calls.lock().unwrap();
        assert_eq!(calls.len(), 8);
        assert!(calls[0].0.ends_with("/signer/api/v1/keys/neox-updater"));
        assert!(calls[1].1.contains("eth_getTransactionCount"));
        assert!(calls[2].1.contains("eth_gasPrice"));
        assert!(calls[3].1.contains("eth_maxPriorityFeePerGas"));
        assert!(calls[4].0.ends_with("/feed/sign"));
        assert!(calls[5].1.contains("eth_estimateGas"));
        assert!(calls[6].1.contains("eth_sendRawTransaction"));
        assert!(calls[7].1.contains("eth_getTransactionReceipt"));
        assert!(state.get("last_feed_delivery").is_some());
        assert_eq!(
            super::feed_baseline(&state, "neox")["NEO-USD"]["price"],
            123.0
        );
    }
}
