//! XCM lane orchestration: enqueue, drain, and relay cross-chain messages.
//!
//! This module implements the cross-chain message relay lane that operates
//! alongside the existing oracle-request pipeline. Messages are persisted in
//! the same `morpheus_relayer_jobs` table (tagged `route="xcm"`) and share the
//! durable-queue claim mechanism for exactly-once/at-most-once delivery.
//!
//! # Architecture
//!
//! - **Enqueue**: [`enqueue_xcm_message`] persists an outbound message via the
//!   store's `insert_relayer_job_if_absent` (on-conflict ignore-duplicates on
//!   `network,event_key`), giving exactly-once insertion semantics.
//! - **Drain**: [`drain_xcm_lane`] fetches XCM-tagged rows, claims them via
//!   [`claim_durable_job_for_processing`], dispatches to a relay closure, and
//!   patches completed/retry_scheduled. Mirrors [`drain_durable_jobs`] pattern.
//! - **Relay**: [`relay_xcm_to_neo_n3`] and [`relay_xcm_to_neox`] build the
//!   target-chain transaction by reusing `neo-os-chain-n3` (script assembly,
//!   custody signing, broadcast, HALT confirmation) and `neo-os-chain-evm`
//!   (ABI encoding, EIP-1559 construction, custody signing, receipt polling).
//!   No new RPC or signing code is written.
//!
//! # Route isolation
//!
//! XCM jobs carry `route="xcm"` in the shared relayer-jobs table. The oracle
//! drain ([`crate::durable::drain_durable_jobs`]) skips these rows; this lane
//! skips non-XCM rows. Both use the identical claim state machine, so cross-
//! instance mutual exclusion is preserved without schema changes.

use neo_os_chain_evm::{
    abi_encode, decode_signed_eip1559, keccak256, AbiValue, EvmCustodyClient, EvmCustodySettings,
    EvmRpcClient, EvmWaiter, HttpTransport as EvmHttpTransport, UnsignedEip1559,
};
use neo_os_chain_n3::custody::{CustodyClient, CustodyConnection};
use neo_os_chain_n3::rpc::NeoRpcClient;
use neo_os_chain_n3::tx::{
    build_sign_and_broadcast, confirm_fulfill_execution, resolve_signer, BroadcastOptions,
    NonceSource, Waiter, DEFAULT_FULFILL_CONFIRM_TIMEOUT_MS,
};
use neo_os_chain_n3::HttpTransport as N3HttpTransport;
use neo_os_core::n3_tx::{create_invoke_script, ContractParam};
use neo_os_core::retry::compute_retry_delay_ms;
use neo_os_core::state::ms_to_iso_string;
use neo_os_relayer_store::jobs::{
    insert_relayer_job_if_absent, patch_relayer_job, quote_postgrest_in_value,
};
use neo_os_relayer_store::queue::{
    claim_durable_job_for_processing, is_durable_queue_ready_job, ClaimDecision, DurableClaimConfig,
};
use neo_os_relayer_store::supabase::SupabaseClient;
use neo_os_relayer_store::HttpTransport as StoreHttpTransport;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::config::RelayerConfig;
use crate::delivery::{decode_evm_address, decode_hash160, string_array};
use crate::xcm::CrossChainMessage;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Route tag distinguishing XCM rows from oracle rows in the shared table.
pub const XCM_ROUTE: &str = "xcm";

/// Request type stored in the `request_type` column for XCM jobs.
pub const XCM_REQUEST_TYPE: &str = "xcm_message";

/// Terminal status for a cross-chain message that exhausted its retry budget or
/// failed a permanent (non-transient) provenance/validation check. Mirrors the
/// `dead_lettered` terminal status the control plane uses for poisoned rows.
pub const XCM_DEAD_LETTER_STATUS: &str = "dead_lettered";

/// Retry-backoff defaults, matching the oracle lane's `retry_config` fallbacks
/// in `fulfillment.rs` (`retryBaseDelayMs` = 1000, `retryMaxDelayMs` = 300000,
/// `maxRetries` = 5) so the XCM lane reuses the exact backoff curve of the
/// oracle lane (via `compute_retry_delay_ms`) instead of inventing a new scheme.
pub const XCM_DEFAULT_RETRY_BASE_DELAY_MS: f64 = 1_000.0;
pub const XCM_DEFAULT_RETRY_MAX_DELAY_MS: f64 = 300_000.0;
pub const XCM_DEFAULT_MAX_RETRIES: u64 = 5;

/// ABI function signature for the XCM bridge contract's deliverMessage method.
const XCM_DELIVER_SIGNATURE: &str = "deliverMessage(bytes32,string,string,uint256,bytes)";

/// Statuses eligible for XCM drain (same as oracle durable drain).
const XCM_FETCH_STATUSES: &[&str] = &[
    "queued",
    "queued_backpressure",
    "retry_scheduled",
    "processing",
    "retrying",
];

/// Columns fetched for each XCM job. `tx_hash` and `next_retry_at` are required
/// so the drain can (a) re-observe an already-broadcast tx instead of
/// re-broadcasting it (at-most-once delivery) and (b) honor the retry backoff
/// window via [`is_durable_queue_ready_job`].
const XCM_FETCH_SELECT: &str =
    "event_key,chain,route,status,attempts,tx_hash,next_retry_at,event,updated_at";

/// Callback persisting the broadcast tx_hash into the job row immediately after
/// a successful broadcast and BEFORE waiting for on-chain confirmation. On a
/// later retry the stored tx_hash is re-observed rather than re-broadcast, which
/// is what guarantees at-most-once on-chain delivery when a confirmation times
/// out but the transaction still mines.
pub type PersistTxHash<'a> = &'a (dyn Fn(&str) -> Result<(), String> + 'a);

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/// Outcome of a single XCM drain iteration.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum XcmDrainOutcome {
    /// Lane is disabled; no work performed.
    Disabled,
    /// No XCM jobs found in the durable queue.
    Empty,
    /// Message relayed and confirmed on the destination chain.
    Relayed,
    /// Claim was granted but the relay failed. The row was patched either
    /// `retry_scheduled` with an exponential-backoff `next_retry_at`, or
    /// `dead_lettered` once the retry budget (`max_retries`) was exhausted.
    Failed,
    /// Claim conflict: another instance already processing.
    Conflict,
    /// Backoff skip: the row is not yet due (`next_retry_at` in the future) or
    /// the durable queue is unavailable and fail-closed.
    SkippedBackoff,
    /// Job data malformed, provenance/commitment mismatch, or validation failed;
    /// the row is dead-lettered and never relayed.
    Unavailable,
}

/// Receipt from a successful on-chain XCM delivery.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct XcmDeliveryReceipt {
    /// The message commitment (SHA-256 hex) that was delivered.
    pub commitment: String,
    /// Transaction hash on the destination chain.
    pub tx_hash: String,
    /// VM execution state ("HALT" for success).
    pub vm_state: String,
    /// Which chain the message was delivered to.
    pub target_chain: String,
}

/// Configuration for one XCM drain pass.
pub struct XcmDrainConfig<'a> {
    pub enabled: bool,
    pub allow_local_claim_during_backoff: bool,
    pub stale_processing_ms: u64,
    pub instance_id: &'a str,
    pub sync_limit: usize,
    /// Destination chains this instance is configured to serve. The fetch is
    /// gated by `chain.in.(...)` so an instance never claims (and endlessly
    /// retries) a message whose destination it cannot deliver to.
    pub active_chains: &'a [String],
    /// Exponential-backoff base delay (ms) for `retry_scheduled`, mirroring the
    /// oracle lane's `retryBaseDelayMs`.
    pub retry_base_delay_ms: f64,
    /// Exponential-backoff ceiling (ms), mirroring `retryMaxDelayMs`.
    pub retry_max_delay_ms: f64,
    /// Retry budget before a permanently failing message is dead-lettered,
    /// mirroring `maxRetries`.
    pub max_retries: u64,
}

impl<'a> XcmDrainConfig<'a> {
    /// Build a config with the shared retry-backoff defaults applied. Callers
    /// that read the values from the relayer config use the struct literal
    /// directly; this convenience keeps tests and fallbacks consistent.
    #[allow(dead_code)]
    pub fn with_defaults(
        enabled: bool,
        allow_local_claim_during_backoff: bool,
        stale_processing_ms: u64,
        instance_id: &'a str,
        sync_limit: usize,
        active_chains: &'a [String],
    ) -> Self {
        Self {
            enabled,
            allow_local_claim_during_backoff,
            stale_processing_ms,
            instance_id,
            sync_limit,
            active_chains,
            retry_base_delay_ms: XCM_DEFAULT_RETRY_BASE_DELAY_MS,
            retry_max_delay_ms: XCM_DEFAULT_RETRY_MAX_DELAY_MS,
            max_retries: XCM_DEFAULT_MAX_RETRIES,
        }
    }
}

// ---------------------------------------------------------------------------
// Enqueue: persist outbound XCM messages
// ---------------------------------------------------------------------------

/// Persist an outbound cross-chain message into the durable queue.
///
/// Uses `insert_relayer_job_if_absent` with on-conflict ignore-duplicates on
/// `(network, event_key)`, providing exactly-once insertion semantics. The
/// event_key is derived from the message commitment, so re-enqueueing the same
/// logical message is a no-op.
///
/// Returns the event_key on success.
pub fn enqueue_xcm_message<T: StoreHttpTransport>(
    client: &SupabaseClient<T>,
    msg: &CrossChainMessage,
    now_ms: u64,
) -> Result<String, String> {
    msg.validate()?;
    let commitment = msg.commitment();
    let event_key = format!("{XCM_ROUTE}:{commitment}");

    let record = json!({
        "event_key": event_key,
        "chain": msg.dest_chain,
        "route": XCM_ROUTE,
        "request_id": msg.nonce.to_string(),
        "request_type": XCM_REQUEST_TYPE,
        "status": "queued",
        "attempts": 0,
        "event": {
            "source_chain": msg.source_chain,
            "dest_chain": msg.dest_chain,
            "nonce": msg.nonce,
            "payload_hex": hex::encode(&msg.payload),
            "commitment": commitment,
        },
    });

    insert_relayer_job_if_absent(client, &record, now_ms)?;
    Ok(event_key)
}

// ---------------------------------------------------------------------------
// Drain: fetch, claim, relay, patch
// ---------------------------------------------------------------------------

/// Drain XCM-tagged jobs from the durable queue.
///
/// Mirrors [`crate::durable::drain_durable_jobs`]: fetches eligible rows,
/// claims via the shared state machine, invokes the relay closure, and patches
/// the row to completed or retry_scheduled. The relay closure is injected so
/// this function is testable without network access.
pub fn drain_xcm_lane<T, F>(
    client: &SupabaseClient<T>,
    cfg: &XcmDrainConfig<'_>,
    now_ms: u64,
    now_iso: &str,
    stale_before_iso: &str,
    mut relay: F,
) -> Result<Vec<XcmDrainOutcome>, String>
where
    T: StoreHttpTransport,
    F: FnMut(
        &CrossChainMessage,
        Option<&str>,
        &dyn Fn(&str) -> Result<(), String>,
    ) -> Result<XcmDeliveryReceipt, String>,
{
    if !cfg.enabled {
        return Ok(vec![XcmDrainOutcome::Disabled]);
    }

    let jobs = fetch_xcm_jobs(client, cfg.sync_limit.max(1), cfg.active_chains, now_ms)?;
    if jobs.is_empty() {
        return Ok(vec![XcmDrainOutcome::Empty]);
    }

    let mut outcomes = Vec::with_capacity(jobs.len());
    for job in jobs {
        let event_key = match job.get("event_key").and_then(Value::as_str) {
            Some(key) if !key.is_empty() => key,
            _ => {
                outcomes.push(XcmDrainOutcome::Unavailable);
                continue;
            }
        };

        // Fix #7 (defense in depth): the fetch already filters by destination
        // chain, but re-gate here so a row whose destination this instance does
        // not serve is never claimed (and therefore never retried forever).
        if !cfg.active_chains.is_empty() {
            let dest = job.get("chain").and_then(Value::as_str).unwrap_or("");
            if !cfg.active_chains.iter().any(|chain| chain == dest) {
                tracing::debug!(
                    event_key,
                    dest,
                    "XCM job destination not in active chains; skipping without claim"
                );
                continue;
            }
        }

        // Fix #5: honor the retry backoff window before claiming. A
        // retry_scheduled row whose next_retry_at is still in the future (or a
        // processing row that is not yet stale) is not ready and must not be
        // re-claimed and re-broadcast on every tick.
        if !is_durable_queue_ready_job(&job, now_ms, cfg.stale_processing_ms) {
            outcomes.push(XcmDrainOutcome::SkippedBackoff);
            continue;
        }

        let event = match job.get("event") {
            Some(Value::Object(_)) => job.get("event").unwrap(),
            _ => {
                // Permanent: a row without an event object can never be relayed,
                // so dead-letter it instead of retrying forever.
                tracing::warn!(event_key, "XCM job missing event object; dead-lettering");
                dead_letter_xcm_job(client, event_key, "xcm job missing event", now_iso, now_ms);
                outcomes.push(XcmDrainOutcome::Unavailable);
                continue;
            }
        };

        // Fix #2 + #6: decode, validate provenance, and cross-check the
        // commitment against both the stored commitment and the event_key suffix
        // BEFORE claiming or relaying. Any failure here is permanent, so the row
        // is dead-lettered (never relayed, never retried forever).
        let msg = match decode_xcm_event(event, event_key) {
            Ok(m) => m,
            Err(e) => {
                tracing::warn!(event_key, error = %e, "XCM job rejected before relay; dead-lettering");
                dead_letter_xcm_job(client, event_key, &format!("xcm decode: {e}"), now_iso, now_ms);
                outcomes.push(XcmDrainOutcome::Unavailable);
                continue;
            }
        };

        let attempts = job.get("attempts").and_then(Value::as_u64).unwrap_or(0);
        let is_retry = job
            .get("status")
            .and_then(Value::as_str)
            .is_some_and(|s| s.contains("retry") || s == "processing" || s == "retrying");

        // Fix #1: an existing tx_hash means a prior tick already built and
        // broadcast the transaction. The relay must re-observe/confirm that tx,
        // never build a new one (a new nonce/signature would double-deliver if
        // the timed-out transaction still mines).
        let existing_tx_hash = job
            .get("tx_hash")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty());

        let decision = claim_durable_job_for_processing(
            client,
            event_key,
            is_retry,
            attempts.saturating_add(1),
            &DurableClaimConfig {
                durable_queue_enabled: true,
                allow_local_claim_during_backoff: cfg.allow_local_claim_during_backoff,
                stale_processing_ms: cfg.stale_processing_ms,
                instance_id: cfg.instance_id,
            },
            now_iso,
            stale_before_iso,
            now_ms,
        )?;

        match decision {
            ClaimDecision::Conflict => outcomes.push(XcmDrainOutcome::Conflict),
            ClaimDecision::BackoffSkip => outcomes.push(XcmDrainOutcome::SkippedBackoff),
            ClaimDecision::Unavailable => outcomes.push(XcmDrainOutcome::Unavailable),
            ClaimDecision::Granted => {
                // Fix #1: the persistence callback writes tx_hash the instant the
                // tx is broadcast, before confirmation is awaited, so a crash
                // between broadcast and confirm still records the tx and the
                // next tick re-observes rather than re-broadcasts.
                let persist: &dyn Fn(&str) -> Result<(), String> = &|tx_hash: &str| {
                    patch_relayer_job(client, event_key, &json!({"tx_hash": tx_hash}), now_ms)
                        .map(|_| ())
                };
                match relay(&msg, existing_tx_hash, persist) {
                    Ok(receipt) => {
                        patch_relayer_job(
                            client,
                            event_key,
                            &json!({
                                "status": "completed",
                                "tx_hash": receipt.tx_hash,
                                "last_error": Value::Null,
                            }),
                            now_ms,
                        )?;
                        outcomes.push(XcmDrainOutcome::Relayed);
                    }
                    Err(error) => {
                        // Fix #5: exponential backoff via the shared curve, or
                        // dead-letter once the retry budget is exhausted.
                        let next_attempts = attempts.saturating_add(1);
                        if cfg.max_retries > 0 && next_attempts >= cfg.max_retries {
                            tracing::warn!(
                                event_key,
                                attempts = next_attempts,
                                max_retries = cfg.max_retries,
                                "XCM relay exhausted retry budget; dead-lettering"
                            );
                            dead_letter_xcm_job(client, event_key, &error, now_iso, now_ms);
                        } else {
                            let delay_ms = compute_retry_delay_ms(
                                cfg.retry_base_delay_ms,
                                cfg.retry_max_delay_ms,
                                next_attempts as f64,
                                jitter_from_key(event_key),
                            );
                            let next_retry_at_ms = (now_ms as f64 + delay_ms).max(0.0) as u64;
                            let next_retry_iso = ms_to_iso_string(next_retry_at_ms as f64);
                            patch_relayer_job(
                                client,
                                event_key,
                                &json!({
                                    "status": "retry_scheduled",
                                    "last_error": error,
                                    "next_retry_at": next_retry_iso,
                                }),
                                now_ms,
                            )?;
                        }
                        outcomes.push(XcmDrainOutcome::Failed);
                    }
                }
            }
        }
    }
    Ok(outcomes)
}

/// Dead-letter an XCM job: a terminal disposition for permanent failures
/// (malformed event, validation/provenance failure, exhausted retry budget) so
/// the row never re-enters the ready set and is never relayed again.
fn dead_letter_xcm_job<T: StoreHttpTransport>(
    client: &SupabaseClient<T>,
    event_key: &str,
    error: &str,
    now_iso: &str,
    now_ms: u64,
) {
    let _ = patch_relayer_job(
        client,
        event_key,
        &json!({
            "status": XCM_DEAD_LETTER_STATUS,
            "last_error": error,
            "next_retry_at": Value::Null,
            "completed_at": now_iso,
        }),
        now_ms,
    );
}

/// Deterministic per-message jitter in `[0, 1)` derived from the event_key, fed
/// to [`compute_retry_delay_ms`]. Using a hash of the key (instead of a shared
/// RNG) keeps the backoff curve identical to the oracle lane while spreading
/// retries across messages so a recovering dependency is not stampeded, and
/// keeps unit tests deterministic without a randomness dependency.
fn jitter_from_key(event_key: &str) -> f64 {
    let hash = Sha256::digest(event_key.as_bytes());
    let mut buf = [0u8; 8];
    buf.copy_from_slice(&hash[..8]);
    u64::from_be_bytes(buf) as f64 / u64::MAX as f64
}

/// Fetch XCM-tagged jobs from the durable queue, filtered by route and by the
/// destination chains this instance serves.
fn fetch_xcm_jobs<T: StoreHttpTransport>(
    client: &SupabaseClient<T>,
    limit: usize,
    active_chains: &[String],
    now_ms: u64,
) -> Result<Vec<Value>, String> {
    let network = &client.config().network;
    let status_filter = format!("in.({})", XCM_FETCH_STATUSES.join(","));
    let limit_str = limit.to_string();
    let network_eq = format!("eq.{network}");
    let route_eq = format!("eq.{XCM_ROUTE}");
    // Fix #7: only fetch rows whose destination chain is one this instance
    // serves, so it never claims (and endlessly retries) a message it cannot
    // deliver. Values are quoted for PostgREST `in.(...)` safety.
    let chain_filter = if active_chains.is_empty() {
        None
    } else {
        Some(format!(
            "in.({})",
            active_chains
                .iter()
                .map(|chain| quote_postgrest_in_value(chain))
                .collect::<Vec<_>>()
                .join(",")
        ))
    };
    let mut query: Vec<(&str, &str)> = vec![
        ("select", XCM_FETCH_SELECT),
        ("network", &network_eq),
        ("route", &route_eq),
        ("status", &status_filter),
        ("order", "updated_at.asc"),
        ("limit", &limit_str),
    ];
    if let Some(chain_in) = &chain_filter {
        query.push(("chain", chain_in));
    }
    client.select("morpheus_relayer_jobs", &query, now_ms)
}

/// Decode and validate a CrossChainMessage from the stored event JSON.
///
/// Fix #2: provenance is validated via [`CrossChainMessage::validate`] before
/// the message can be claimed or relayed, so a row inserted directly into the
/// table with an empty or self-looping chain is never TEE-custody-signed and
/// broadcast.
///
/// Fix #6: the commitment recomputed from the decoded fields must match BOTH the
/// stored `event.commitment` AND the `xcm:{commitment}` suffix of the event_key.
/// An adversarial control-plane edit of the event JSON (changing the payload
/// while keeping the event_key) is detected and rejected here.
fn decode_xcm_event(event: &Value, event_key: &str) -> Result<CrossChainMessage, String> {
    let source_chain = event
        .get("source_chain")
        .and_then(Value::as_str)
        .ok_or_else(|| "missing source_chain".to_string())?
        .to_string();
    let dest_chain = event
        .get("dest_chain")
        .and_then(Value::as_str)
        .ok_or_else(|| "missing dest_chain".to_string())?
        .to_string();
    let nonce = event
        .get("nonce")
        .and_then(Value::as_u64)
        .ok_or_else(|| "missing nonce".to_string())?;
    let payload_hex = event
        .get("payload_hex")
        .and_then(Value::as_str)
        .unwrap_or("");
    let payload = hex::decode(payload_hex).map_err(|e| format!("invalid payload_hex: {e}"))?;

    let msg = CrossChainMessage::new(source_chain, dest_chain, nonce, payload);

    // Fix #2: validate provenance before any claim/relay.
    msg.validate()?;

    // Fix #6: recompute and cross-check the commitment against the stored value
    // and the event_key suffix.
    let recomputed = msg.commitment();
    if let Some(stored) = event.get("commitment").and_then(Value::as_str) {
        if !stored.trim().is_empty() && !stored.eq_ignore_ascii_case(&recomputed) {
            return Err(format!(
                "commitment mismatch: event.commitment {stored} != recomputed {recomputed}"
            ));
        }
    }
    let expected_key = format!("{XCM_ROUTE}:{recomputed}");
    if event_key != expected_key {
        return Err(format!(
            "event_key {event_key} does not match recomputed commitment {expected_key}"
        ));
    }

    Ok(msg)
}

// ---------------------------------------------------------------------------
// Relay: on-chain delivery to Neo N3
// ---------------------------------------------------------------------------

/// Relay a cross-chain message to its destination on Neo N3.
///
/// Builds an invoke script calling the XCM bridge contract's `deliverMessage`
/// method, signs via the custody service, broadcasts, and confirms HALT.
/// Reuses `build_sign_and_broadcast` and `confirm_fulfill_execution` from
/// `neo-os-chain-n3::tx` — no new RPC or signing code.
pub fn relay_xcm_to_neo_n3<T, N, W>(
    config: &RelayerConfig,
    msg: &CrossChainMessage,
    existing_tx_hash: Option<&str>,
    persist_tx_hash: PersistTxHash<'_>,
    transport: &T,
    nonce_source: &N,
    waiter: &W,
) -> Result<XcmDeliveryReceipt, String>
where
    T: N3HttpTransport + EvmHttpTransport,
    N: NonceSource,
    W: Waiter,
{
    let xcm_cfg = config
        .raw
        .get("xcm")
        .and_then(Value::as_object)
        .ok_or_else(|| "relayer configuration is missing xcm".to_string())?;
    let n3_xcm = xcm_cfg
        .get("neo_n3")
        .and_then(Value::as_object)
        .ok_or_else(|| "xcm configuration is missing neo_n3".to_string())?;
    let nitro = config
        .raw
        .get("nitro")
        .and_then(Value::as_object)
        .ok_or_else(|| "relayer configuration is missing nitro".to_string())?;
    let n3_base = config
        .raw
        .get("neo_n3")
        .and_then(Value::as_object)
        .ok_or_else(|| "relayer configuration is missing neo_n3".to_string())?;

    // XCM bridge contract script hash
    let contract_str = n3_xcm
        .get("contract")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "xcm neo_n3 contract is not configured".to_string())?;
    let contract_hash = decode_hash160(contract_str)
        .ok_or_else(|| "xcm neo_n3 contract must be a 20-byte hex script hash".to_string())?;

    // RPC URLs from base neo_n3 config
    let rpc_urls = string_array(n3_base.get("rpcUrls"));
    if rpc_urls.is_empty() {
        return Err("Neo N3 RPC URLs are not configured".to_string());
    }

    // Custody connection from nitro config
    let custody_url = nitro
        .get("custodyUrl")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "custody signer service URL is not configured".to_string())?;
    let custody_token = nitro
        .get("custodyToken")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "custody signer service token is not configured".to_string())?;
    let custody_timeout = nitro
        .get("timeoutMs")
        .and_then(Value::as_u64)
        .filter(|v| *v > 0);
    let connection = CustodyConnection::new(custody_url.to_string(), custody_token.to_string(), custody_timeout)?;

    // Custody key: prefer XCM-specific key, fall back to oracle updater key
    let updater_key_id = n3_xcm
        .get("custodyKeyId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .or_else(|| {
            n3_base
                .get("custodyKeyIds")
                .and_then(Value::as_object)
                .and_then(|keys| keys.get("updater"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
        })
        .ok_or_else(|| "Neo N3 XCM custody updater key is not configured".to_string())?;

    let commitment = msg.commitment();
    let rpc = NeoRpcClient::new(transport, rpc_urls, !cfg!(test))?;
    let timeout_ms = n3_xcm
        .get("confirmTimeoutMs")
        .and_then(Value::as_u64)
        .filter(|v| *v > 0)
        .unwrap_or(DEFAULT_FULFILL_CONFIRM_TIMEOUT_MS);

    // Fix #1 (at-most-once delivery): when a tx_hash was already persisted for
    // this message, a prior tick built, signed, and broadcast the transaction.
    // Re-observe/confirm that exact tx via confirm_fulfill_execution instead of
    // building a new one — a fresh nonce/signature would double-deliver the same
    // message if the timed-out transaction still mines.
    if let Some(tx_hash) = existing_tx_hash {
        let outcome = confirm_fulfill_execution(
            &rpc,
            waiter,
            &commitment,
            tx_hash,
            "deliverMessage",
            timeout_ms,
            true,
        )?;
        return Ok(XcmDeliveryReceipt {
            commitment,
            tx_hash: tx_hash.to_string(),
            vm_state: outcome.vm_state,
            target_chain: "neo_n3".to_string(),
        });
    }

    // Build invoke script for deliverMessage(bytes32,string,string,integer,bytes)
    let nonce_i64 = i64::try_from(msg.nonce)
        .map_err(|_| "XCM nonce exceeds signed 64-bit range for Neo N3".to_string())?;
    let script = create_invoke_script(
        &contract_hash,
        "deliverMessage",
        &[
            ContractParam::HexBytes(commitment.clone()),
            ContractParam::String(msg.source_chain.clone()),
            ContractParam::String(msg.dest_chain.clone()),
            ContractParam::Integer(nonce_i64),
            ContractParam::HexBytes(hex::encode(&msg.payload)),
        ],
    )
    .map_err(|e| format!("Neo N3 XCM deliverMessage script encoding failed: {e}"))?;

    // Broadcast via custody
    let custody = CustodyClient::new(transport, connection);
    let signer = resolve_signer(&custody, updater_key_id)?;
    let commitment_for_error = commitment.clone();
    let options = BroadcastOptions {
        label: "Neo N3 XCM deliverMessage",
        system_fee_headroom: true,
        build_test_invoke_fault_error: Some(Box::new(move |exception| {
            format!(
                "Neo N3 XCM deliverMessage test invoke faulted for commitment {}: {}",
                commitment_for_error,
                if exception.trim().is_empty() { "unknown error" } else { exception }
            )
        })),
        ensure_fee_balance: None,
    };
    let broadcast = build_sign_and_broadcast(&rpc, &custody, &signer, nonce_source, &script, &options)?;

    // Fix #1: persist the tx_hash into the job row immediately after a
    // successful broadcast and BEFORE awaiting confirmation, so a crash or
    // timeout between broadcast and confirm still records the tx and the next
    // tick re-observes rather than re-broadcasts.
    persist_tx_hash(&broadcast.tx_hash)?;

    // Confirm HALT
    let outcome = confirm_fulfill_execution(
        &rpc,
        waiter,
        &commitment,
        &broadcast.tx_hash,
        "deliverMessage",
        timeout_ms,
        true,
    )?;

    Ok(XcmDeliveryReceipt {
        commitment,
        tx_hash: broadcast.tx_hash,
        vm_state: outcome.vm_state,
        target_chain: "neo_n3".to_string(),
    })
}

// ---------------------------------------------------------------------------
// Relay: on-chain delivery to NeoX (EVM)
// ---------------------------------------------------------------------------

/// Relay a cross-chain message to its destination on NeoX.
///
/// Builds EIP-1559 calldata for the XCM bridge contract's `deliverMessage`
/// method, signs via the custody service, broadcasts, and confirms receipt.
/// Reuses `EvmRpcClient`, `EvmCustodyClient`, `UnsignedEip1559`, and
/// `decode_signed_eip1559` from `neo-os-chain-evm` — no new RPC or signing code.
pub fn relay_xcm_to_neox<T, W>(
    config: &RelayerConfig,
    msg: &CrossChainMessage,
    existing_tx_hash: Option<&str>,
    persist_tx_hash: PersistTxHash<'_>,
    transport: &T,
    waiter: &W,
) -> Result<XcmDeliveryReceipt, String>
where
    T: N3HttpTransport + EvmHttpTransport,
    W: Waiter,
{
    let xcm_cfg = config
        .raw
        .get("xcm")
        .and_then(Value::as_object)
        .ok_or_else(|| "relayer configuration is missing xcm".to_string())?;
    let neox_xcm = xcm_cfg
        .get("neox")
        .and_then(Value::as_object)
        .ok_or_else(|| "xcm configuration is missing neox".to_string())?;
    let nitro = config
        .raw
        .get("nitro")
        .and_then(Value::as_object)
        .ok_or_else(|| "relayer configuration is missing nitro".to_string())?;
    let neox_base = config
        .raw
        .get("neox")
        .and_then(Value::as_object)
        .ok_or_else(|| "relayer configuration is missing neox".to_string())?;

    // XCM bridge contract address
    let contract_str = neox_xcm
        .get("contract")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "xcm neox contract is not configured".to_string())?;
    let contract_address = decode_evm_address(contract_str)
        .ok_or_else(|| "xcm neox contract must be a 20-byte EVM address".to_string())?;
    let contract_0x = format!("0x{}", hex::encode(contract_address));

    // Chain ID from base neox config
    let chain_id = neox_base
        .get("chainId")
        .and_then(|v| {
            v.as_u64().or_else(|| v.as_f64().filter(|f| f.is_finite() && *f >= 0.0).map(|f| f as u64))
                .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
        })
        .filter(|v| *v > 0)
        .ok_or_else(|| "NeoX chain id is not configured".to_string())?;

    // RPC URLs
    let rpc_url = neox_base
        .get("rpcUrl")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "NeoX primary RPC URL is not configured".to_string())?
        .to_string();
    let rpc_urls = string_array(neox_base.get("rpcUrls"));
    let rpc = EvmRpcClient::new(rpc_url, rpc_urls, transport);
    let commitment = msg.commitment();
    let timeout_ms = neox_xcm
        .get("confirmTimeoutMs")
        .and_then(Value::as_u64)
        .filter(|v| *v > 0)
        .unwrap_or(45_000);

    // Fix #1 (at-most-once delivery): when a tx_hash was already persisted for
    // this message, a prior tick built, signed, and broadcast the transaction.
    // Re-observe/confirm that exact tx via its receipt instead of building a new
    // one — a fresh nonce/signature would double-deliver the same message if the
    // timed-out transaction still mines.
    if let Some(tx_hash) = existing_tx_hash {
        let receipt = rpc
            .wait_for_receipt(&XcmEvmWaiterBridge(waiter), tx_hash, timeout_ms)
            .map_err(|e| format!("NeoX XCM confirmation failed: {e}"))?;
        return Ok(XcmDeliveryReceipt {
            commitment,
            tx_hash: receipt.tx_hash,
            vm_state: "HALT".to_string(),
            target_chain: "neox".to_string(),
        });
    }

    // Custody
    let custody_url = nitro
        .get("custodyUrl")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "custody signer service URL is not configured".to_string())?;
    let custody_token = nitro
        .get("custodyToken")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "custody signer service token is not configured".to_string())?;
    let custody_timeout = nitro.get("timeoutMs").and_then(Value::as_u64).filter(|v| *v > 0);

    let updater_key_id = neox_xcm
        .get("custodyKeyId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .or_else(|| {
            neox_base
                .get("custodyKeyIds")
                .and_then(Value::as_object)
                .and_then(|keys| keys.get("updater"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
        })
        .ok_or_else(|| "NeoX XCM custody updater key is not configured".to_string())?;

    let custody = EvmCustodyClient::new(
        transport,
        EvmCustodySettings::new(custody_url, custody_token, custody_timeout)?,
    );
    let updater = custody.key_info(updater_key_id)?;
    // Fix #3: pin the updater address recovered from the custody identity so the
    // decoded transaction's `from` can be verified against it, matching the
    // oracle lane's deliver_neox. This closes an identity-spoofing gap where
    // custody reports a matching address/digest but signs with a different key.
    let updater_address = decode_evm_address(&updater.address)
        .ok_or_else(|| "NeoX XCM updater custody identity returned an invalid address".to_string())?;
    if updater.chain_id != chain_id {
        return Err("NeoX XCM custody updater key chain id mismatch".to_string());
    }

    // Build calldata: selector ++ abi_encode(bytes32,string,string,uint256,bytes)
    let calldata = build_xcm_calldata(&commitment, msg)?;
    let calldata_hex = format!("0x{}", hex::encode(&calldata));

    // Gas estimation and fee parameters
    let tx_nonce = rpc
        .transaction_count(&updater.address)
        .map_err(|e| format!("NeoX XCM updater nonce lookup failed: {e}"))?;
    let estimate = rpc
        .estimate_gas(&updater.address, &contract_0x, &calldata_hex)
        .map_err(|e| format!("NeoX XCM deliverMessage gas estimation failed: {e}"))?;
    let gas_limit = estimate
        .checked_mul(2)
        .filter(|v| *v > 0)
        .ok_or_else(|| "NeoX XCM gas limit overflowed".to_string())?;
    let gas_price = rpc
        .gas_price()
        .map_err(|e| format!("NeoX gas price lookup failed: {e}"))?;
    let priority_fee = rpc
        .max_priority_fee_per_gas()
        .map_err(|e| format!("NeoX priority fee lookup failed: {e}"))?;
    let max_fee = gas_price
        .checked_mul(2)
        .and_then(|v| v.checked_add(priority_fee))
        .ok_or_else(|| "NeoX XCM fee overflowed".to_string())?;

    let unsigned = UnsignedEip1559 {
        chain_id,
        nonce: tx_nonce,
        max_priority_fee_per_gas: priority_fee,
        max_fee_per_gas: max_fee,
        gas_limit,
        to: contract_address,
        value: [0u8; 32],
        data: calldata,
    };

    // Custody sign
    let expected_signing_hash = format!("0x{}", hex::encode(unsigned.signing_hash()));
    let signing_request_id = format!(
        "relayer:xcm:neox:{}:{}:{}",
        commitment, tx_nonce, &expected_signing_hash[2..18]
    );
    let signed = custody.sign_transaction(
        updater_key_id,
        chain_id,
        &unsigned.encode_hex(),
        &signing_request_id,
    )?;
    if !signed.address.eq_ignore_ascii_case(&updater.address) {
        return Err("NeoX XCM custody response changed updater identity".to_string());
    }

    // Verify decoded transaction matches plan
    let decoded = decode_signed_eip1559(&signed.signed_transaction)?;
    if decoded.chain_id != chain_id
        || decoded.nonce != tx_nonce
        || decoded.max_priority_fee_per_gas != priority_fee
        || decoded.max_fee_per_gas != max_fee
        || decoded.gas_limit != gas_limit
        || decoded.to != contract_address
        || decoded.value.iter().any(|b| *b != 0)
        || decoded.data != unsigned.data
        || decoded.signing_hash != unsigned.signing_hash()
        || decoded.from != updater_address
    {
        return Err("custody-signed NeoX XCM transaction differs from the approved plan".to_string());
    }
    if !signed.digest.eq_ignore_ascii_case(&decoded.tx_hash) {
        return Err("NeoX XCM custody response changed the signed transaction hash".to_string());
    }

    // Broadcast and confirm
    let node_hash = rpc
        .send_raw_transaction(&signed.signed_transaction)
        .map_err(|e| format!("NeoX XCM broadcast failed: {e}"))?;
    if !node_hash.eq_ignore_ascii_case(&decoded.tx_hash) {
        return Err(format!(
            "NeoX RPC returned tx hash {node_hash}, locally signed hash is {}",
            decoded.tx_hash
        ));
    }

    // Fix #1: persist the tx_hash into the job row immediately after a
    // successful broadcast and BEFORE awaiting the receipt, so a crash or
    // timeout between broadcast and confirmation still records the tx and the
    // next tick re-observes rather than re-broadcasts.
    persist_tx_hash(&decoded.tx_hash)?;

    let receipt = rpc
        .wait_for_receipt(&XcmEvmWaiterBridge(waiter), &decoded.tx_hash, timeout_ms)
        .map_err(|e| format!("NeoX XCM confirmation failed: {e}"))?;

    Ok(XcmDeliveryReceipt {
        commitment,
        tx_hash: receipt.tx_hash,
        vm_state: "HALT".to_string(),
        target_chain: "neox".to_string(),
    })
}

// ---------------------------------------------------------------------------
// Calldata construction
// ---------------------------------------------------------------------------

/// Build the EVM calldata for `deliverMessage(bytes32,string,string,uint256,bytes)`.
fn build_xcm_calldata(commitment_hex: &str, msg: &CrossChainMessage) -> Result<Vec<u8>, String> {
    // 4-byte function selector
    let selector_hash = keccak256(XCM_DELIVER_SIGNATURE.as_bytes());
    let selector = &selector_hash[..4];

    // ABI-encode arguments
    let commitment_bytes = hex::decode(commitment_hex)
        .map_err(|e| format!("commitment hex decode failed: {e}"))?;
    let mut commitment_word = [0u8; 32];
    if commitment_bytes.len() == 32 {
        commitment_word.copy_from_slice(&commitment_bytes);
    } else {
        return Err("commitment must be exactly 32 bytes".to_string());
    }

    let mut nonce_word = [0u8; 32];
    nonce_word[24..].copy_from_slice(&msg.nonce.to_be_bytes());

    let encoded = abi_encode(&[
        AbiValue::Uint256(commitment_word),
        AbiValue::String(msg.source_chain.clone()),
        AbiValue::String(msg.dest_chain.clone()),
        AbiValue::Uint256(nonce_word),
        AbiValue::Bytes(msg.payload.clone()),
    ])
    .map_err(|e| format!("XCM ABI encoding failed: {e}"))?;

    let mut calldata = Vec::with_capacity(4 + encoded.len());
    calldata.extend_from_slice(selector);
    calldata.extend_from_slice(&encoded);
    Ok(calldata)
}

// ---------------------------------------------------------------------------
// Dispatch: route message to the correct chain relay
// ---------------------------------------------------------------------------

/// Relay a cross-chain message to its destination chain.
///
/// Dispatches to [`relay_xcm_to_neo_n3`] or [`relay_xcm_to_neox`] based on
/// `msg.dest_chain`.
pub fn relay_xcm_message<T, N, W>(
    config: &RelayerConfig,
    msg: &CrossChainMessage,
    existing_tx_hash: Option<&str>,
    persist_tx_hash: PersistTxHash<'_>,
    transport: &T,
    nonce_source: &N,
    waiter: &W,
) -> Result<XcmDeliveryReceipt, String>
where
    T: N3HttpTransport + EvmHttpTransport,
    N: NonceSource,
    W: Waiter,
{
    match msg.dest_chain.as_str() {
        "neo_n3" => relay_xcm_to_neo_n3(
            config,
            msg,
            existing_tx_hash,
            persist_tx_hash,
            transport,
            nonce_source,
            waiter,
        ),
        "neox" => relay_xcm_to_neox(config, msg, existing_tx_hash, persist_tx_hash, transport, waiter),
        other => Err(format!("unsupported XCM destination chain: {other}")),
    }
}

// ---------------------------------------------------------------------------
// Waiter bridge (n3 Waiter -> EVM Waiter)
// ---------------------------------------------------------------------------

struct XcmEvmWaiterBridge<'a, W>(&'a W);

impl<W: Waiter> EvmWaiter for XcmEvmWaiterBridge<'_, W> {
    fn now_ms(&self) -> u64 {
        self.0.now_ms()
    }
    fn sleep(&self, duration: std::time::Duration) {
        self.0.sleep(duration.as_millis().try_into().unwrap_or(u64::MAX));
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use neo_os_relayer_store::supabase::SupabaseConfig;
    use std::collections::VecDeque;
    use std::sync::Mutex;

    struct MockStoreTransport {
        replies: Mutex<VecDeque<(u16, String)>>,
        calls: Mutex<Vec<(String, String, String)>>,
    }

    impl MockStoreTransport {
        fn new(replies: Vec<(u16, Value)>) -> Self {
            Self {
                replies: Mutex::new(
                    replies.into_iter().map(|(s, b)| (s, b.to_string())).collect(),
                ),
                calls: Mutex::new(Vec::new()),
            }
        }
    }

    impl StoreHttpTransport for MockStoreTransport {
        fn request(
            &self,
            method: &str,
            url: &str,
            _headers: &[(&str, &str)],
            body: Option<&str>,
        ) -> Result<(u16, String), String> {
            self.calls.lock().unwrap().push((
                method.to_string(),
                url.to_string(),
                body.unwrap_or("").to_string(),
            ));
            self.replies
                .lock()
                .unwrap()
                .pop_front()
                .ok_or_else(|| "unexpected store call".to_string())
        }
    }

    struct PanicTransport;
    impl StoreHttpTransport for PanicTransport {
        fn request(&self, _: &str, _: &str, _: &[(&str, &str)], _: Option<&str>) -> Result<(u16, String), String> {
            panic!("disabled XCM lane must not access the store");
        }
    }

    fn test_message() -> CrossChainMessage {
        CrossChainMessage::new("neo_n3", "neox", 1, vec![0xde, 0xad, 0xbe, 0xef])
    }

    #[test]
    fn disabled_lane_is_noop() {
        let client = SupabaseClient::new(
            PanicTransport,
            SupabaseConfig::new("https://unused.invalid", "key", "testnet"),
        );
        let outcomes = drain_xcm_lane(
            &client,
            &XcmDrainConfig {
                enabled: false,
                allow_local_claim_during_backoff: false,
                stale_processing_ms: 45_000,
                instance_id: "test",
                sync_limit: 10,
                active_chains: &[],
                retry_base_delay_ms: XCM_DEFAULT_RETRY_BASE_DELAY_MS,
                retry_max_delay_ms: XCM_DEFAULT_RETRY_MAX_DELAY_MS,
                max_retries: XCM_DEFAULT_MAX_RETRIES,
            },
            0,
            "now",
            "before",
            |_, _, _| panic!("relay must not be called when disabled"),
        )
        .expect("disabled lane");
        assert_eq!(outcomes, vec![XcmDrainOutcome::Disabled]);
    }

    #[test]
    fn empty_queue_returns_empty() {
        let transport = MockStoreTransport::new(vec![(200, json!([]))]);
        let client = SupabaseClient::new(
            transport,
            SupabaseConfig::new("https://store.example", "key", "testnet"),
        );
        let outcomes = drain_xcm_lane(
            &client,
            &XcmDrainConfig {
                enabled: true,
                allow_local_claim_during_backoff: false,
                stale_processing_ms: 45_000,
                instance_id: "test",
                sync_limit: 10,
                active_chains: &[],
                retry_base_delay_ms: XCM_DEFAULT_RETRY_BASE_DELAY_MS,
                retry_max_delay_ms: XCM_DEFAULT_RETRY_MAX_DELAY_MS,
                max_retries: XCM_DEFAULT_MAX_RETRIES,
            },
            1000,
            "2026-01-01T00:00:00Z",
            "2025-12-31T23:59:15Z",
            |_, _, _| panic!("relay must not be called on empty queue"),
        )
        .expect("empty drain");
        assert_eq!(outcomes, vec![XcmDrainOutcome::Empty]);
    }

    #[test]
    fn enqueue_persists_with_route_tag() {
        let msg = test_message();
        let expected_key = format!("xcm:{}", msg.commitment());
        // insert_relayer_job_if_absent returns 201 on success
        let transport = MockStoreTransport::new(vec![(201, json!([{"event_key": &expected_key}]))]);
        let client = SupabaseClient::new(
            transport,
            SupabaseConfig::new("https://store.example", "key", "testnet"),
        );
        let key = enqueue_xcm_message(&client, &msg, 1000).expect("enqueue");
        assert_eq!(key, expected_key);
    }

    #[test]
    fn enqueue_rejects_invalid_message() {
        let msg = CrossChainMessage::new("", "neox", 1, vec![]);
        let transport = MockStoreTransport::new(vec![]);
        let client = SupabaseClient::new(
            transport,
            SupabaseConfig::new("https://store.example", "key", "testnet"),
        );
        let err = enqueue_xcm_message(&client, &msg, 1000).unwrap_err();
        assert!(err.contains("empty"));
    }

    #[test]
    fn drain_claims_and_relays() {
        let msg = test_message();
        let commitment = msg.commitment();
        let event_key = format!("xcm:{commitment}");

        // Simulate: fetch returns one queued XCM job, claim succeeds, patch completes
        let job_row = json!({
            "event_key": event_key,
            "chain": "neox",
            "route": "xcm",
            "status": "queued",
            "attempts": 0,
            "event": {
                "source_chain": "neo_n3",
                "dest_chain": "neox",
                "nonce": 1,
                "payload_hex": "deadbeef",
                "commitment": commitment,
            },
            "updated_at": "2026-01-01T00:00:00Z"
        });

        let transport = MockStoreTransport::new(vec![
            // 1. fetch_xcm_jobs select
            (200, json!([job_row])),
            // 2. claim_durable_job_for_processing PATCH (granted)
            (200, json!([{"event_key": event_key, "status": "processing"}])),
            // 3. patch_relayer_job completed
            (200, json!([{"event_key": event_key, "status": "completed"}])),
        ]);
        let client = SupabaseClient::new(
            transport,
            SupabaseConfig::new("https://store.example", "key", "testnet"),
        );

        let mut relay_called = false;
        let outcomes = drain_xcm_lane(
            &client,
            &XcmDrainConfig {
                enabled: true,
                allow_local_claim_during_backoff: false,
                stale_processing_ms: 45_000,
                instance_id: "test-instance",
                sync_limit: 10,
                active_chains: &[],
                retry_base_delay_ms: XCM_DEFAULT_RETRY_BASE_DELAY_MS,
                retry_max_delay_ms: XCM_DEFAULT_RETRY_MAX_DELAY_MS,
                max_retries: XCM_DEFAULT_MAX_RETRIES,
            },
            1000,
            "2026-01-01T00:00:01Z",
            "2025-12-31T23:59:16Z",
            |m, _existing, _persist| {
                relay_called = true;
                assert_eq!(m.source_chain, "neo_n3");
                assert_eq!(m.dest_chain, "neox");
                assert_eq!(m.nonce, 1);
                assert_eq!(m.payload, vec![0xde, 0xad, 0xbe, 0xef]);
                Ok(XcmDeliveryReceipt {
                    commitment: m.commitment(),
                    tx_hash: "0xabc123".to_string(),
                    vm_state: "HALT".to_string(),
                    target_chain: "neox".to_string(),
                })
            },
        )
        .expect("drain");
        assert!(relay_called);
        assert_eq!(outcomes, vec![XcmDrainOutcome::Relayed]);
    }

    #[test]
    fn drain_relay_failure_patches_retry() {
        let msg = test_message();
        let commitment = msg.commitment();
        let event_key = format!("xcm:{commitment}");
        let job_row = json!({
            "event_key": event_key,
            "chain": "neox",
            "route": "xcm",
            "status": "queued",
            "attempts": 0,
            "event": {
                "source_chain": "neo_n3",
                "dest_chain": "neox",
                "nonce": 1,
                "payload_hex": "deadbeef",
                "commitment": commitment,
            },
            "updated_at": "2026-01-01T00:00:00Z"
        });

        let transport = MockStoreTransport::new(vec![
            (200, json!([job_row])),
            (200, json!([{"event_key": event_key, "status": "processing"}])),
            (200, json!([{"event_key": event_key, "status": "retry_scheduled"}])),
        ]);
        let client = SupabaseClient::new(
            transport,
            SupabaseConfig::new("https://store.example", "key", "testnet"),
        );

        let outcomes = drain_xcm_lane(
            &client,
            &XcmDrainConfig {
                enabled: true,
                allow_local_claim_during_backoff: false,
                stale_processing_ms: 45_000,
                instance_id: "test",
                sync_limit: 10,
                active_chains: &[],
                retry_base_delay_ms: XCM_DEFAULT_RETRY_BASE_DELAY_MS,
                retry_max_delay_ms: XCM_DEFAULT_RETRY_MAX_DELAY_MS,
                max_retries: XCM_DEFAULT_MAX_RETRIES,
            },
            1000,
            "2026-01-01T00:00:01Z",
            "2025-12-31T23:59:16Z",
            |_, _, _| Err("chain unavailable".to_string()),
        )
        .expect("drain");
        // Relay was attempted (Granted) but failed; the row is patched
        // retry_scheduled and the outcome reports the failure distinctly.
        assert_eq!(outcomes, vec![XcmDrainOutcome::Failed]);
    }

    #[test]
    fn calldata_has_correct_selector() {
        let msg = test_message();
        let commitment = msg.commitment();
        let calldata = build_xcm_calldata(&commitment, &msg).expect("calldata");
        // First 4 bytes are the keccak256 selector
        let expected_selector = &keccak256(XCM_DELIVER_SIGNATURE.as_bytes())[..4];
        assert_eq!(&calldata[..4], expected_selector);
        // Calldata must be at least 4 + 5*32 = 164 bytes (5 ABI words minimum)
        assert!(calldata.len() >= 164);
    }

    #[test]
    fn relay_dispatch_rejects_unknown_chain() {
        let msg = CrossChainMessage::new("neo_n3", "ethereum", 1, vec![]);
        let config = RelayerConfig {
            repo_root: ".".into(),
            instance_id: "test".into(),
            state_file: "unused".into(),
            network: "testnet".into(),
            node_env: "test".into(),
            mode: "requests_only".into(),
            active_chains: vec!["neo_n3".into()],
            poll_interval_ms: 1,
            concurrency: 1,
            max_blocks_per_tick: 1,
            discovery_idle_backoff_ms: 0,
            state_persist_min_interval_ms: 0,
            raw: json!({}),
        };
        struct NoTransport;
        impl N3HttpTransport for NoTransport {
            fn post(&self, _: &str, _: &str) -> Result<(u16, String), String> { panic!() }
            fn get(&self, _: &str) -> Result<(u16, String), String> { panic!() }
        }
        impl EvmHttpTransport for NoTransport {
            fn post(&self, _: &str, _: &str) -> Result<(u16, String), String> { panic!() }
            fn get(&self, _: &str) -> Result<(u16, String), String> { panic!() }
        }
        struct NoNonce;
        impl NonceSource for NoNonce { fn nonce(&self) -> u32 { 0 } }
        struct NoWait;
        impl Waiter for NoWait { fn now_ms(&self) -> u64 { 0 } fn sleep(&self, _: u64) {} }

        let err = relay_xcm_message(&config, &msg, None, &|_: &str| Ok(()), &NoTransport, &NoNonce, &NoWait).unwrap_err();
        assert!(err.contains("unsupported XCM destination chain"));
    }
}
