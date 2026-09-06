//! Durable queue claim decision state machine and S4 HMAC tamper protection (T03).
//!
//! Ported directly from `workers/morpheus-relayer/src/queue.js`.

use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha2::Sha256;

use neo_os_core::js_value::JsValue;
use neo_os_core::stable_stringify::stable_stringify;

use crate::jobs::claim_relayer_job;
use crate::supabase::{is_transient_durable_queue_error, SupabaseClient};
use crate::HttpTransport;

type HmacSha256 = Hmac<Sha256>;

/// The four claim decision outcomes defined in `queue.js:392-398`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClaimDecision {
    /// Safe to process: claim acquired or local claim granted.
    Granted,
    /// Another instance already claimed this job (clear local item, increment conflict metric).
    Conflict,
    /// Cross-instance claim offline during Supabase backoff; fail-closed defaults skip local claim.
    /// The item MUST be retained and retried next tick, NOT cleared.
    BackoffSkip,
    /// Durable queue is unavailable and failClosed is false.
    Unavailable,
}

impl ClaimDecision {
    pub fn is_granted(&self) -> bool {
        matches!(self, ClaimDecision::Granted)
    }
}

/// Helper to parse ISO-8601 string or numeric timestamp to epoch milliseconds.
pub fn parse_timestamp_ms(value: Option<&Value>) -> u64 {
    let Some(val) = value else {
        return 0;
    };
    if let Some(num) = val.as_u64() {
        return num;
    }
    if let Some(num) = val.as_i64() {
        return if num > 0 { num as u64 } else { 0 };
    }
    if let Some(s) = val.as_str() {
        if let Ok(num) = s.parse::<u64>() {
            return num;
        }
        if let Some(ms) = neo_os_core::state::parse_iso_date_ms(s) {
            return if ms > 0.0 { ms as u64 } else { 0 };
        }
    }
    0
}

/// Predicate deciding if a job in Supabase is ready for hydration or claiming.
/// Ported from `queue.js:302-318`.
pub fn is_durable_queue_ready_job(job: &Value, now_ms: u64, stale_processing_ms: u64) -> bool {
    let status = job.get("status").and_then(Value::as_str).unwrap_or("");
    if status == "queued" || status == "queued_backpressure" {
        return true;
    }
    if status == "retry_scheduled"
        || status == "failure_callback_retry_scheduled"
        || status == "callback_retry_scheduled"
    {
        let next_retry_at_ms = parse_timestamp_ms(job.get("next_retry_at"));
        return next_retry_at_ms == 0 || next_retry_at_ms <= now_ms;
    }
    if status == "processing" || status == "retrying" || status == "callback_pending" {
        let updated_at_ms = parse_timestamp_ms(job.get("updated_at"));
        return updated_at_ms > 0 && now_ms.saturating_sub(updated_at_ms) >= stale_processing_ms;
    }
    false
}

// -----------------------------------------------------------------------------
// S4 HMAC Security: canonical message, signing and verification
// -----------------------------------------------------------------------------

/// Canonical message format for manual action / relayer durable rows.
///
/// Matches `packages/shared/src/node-runtime.js:manualActionCanonical`:
/// `['morpheus-manual-action-v1', action, network, eventKey, stableStringify(event)].join('\n')`
pub fn manual_action_canonical(
    action: &str,
    network: &str,
    event_key: &str,
    event: &Value,
) -> String {
    let js_event = JsValue::from_json(event);
    let serialized_event = stable_stringify(&js_event);
    format!("morpheus-manual-action-v1\n{action}\n{network}\n{event_key}\n{serialized_event}")
}

/// Sign a manual relayer action with HMAC-SHA256.
pub fn sign_manual_action(
    secret: &str,
    action: &str,
    network: &str,
    event_key: &str,
    event: &Value,
) -> String {
    let canonical = manual_action_canonical(action, network, event_key, event);
    let mut mac =
        HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC can take any key size");
    mac.update(canonical.as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

/// Constant-time verification of an HMAC-SHA256 signature over a manual action.
pub fn verify_manual_action_signature(
    secret: &str,
    action: &str,
    network: &str,
    event_key: &str,
    event: &Value,
    signature: &str,
) -> bool {
    let sig_trimmed = signature.trim();
    if sig_trimmed.len() != 64 {
        return false;
    }
    let Ok(sig_bytes) = hex::decode(sig_trimmed) else {
        return false;
    };
    let canonical = manual_action_canonical(action, network, event_key, event);
    let mut mac =
        HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC can take any key size");
    mac.update(canonical.as_bytes());
    mac.verify_slice(&sig_bytes).is_ok()
}

/// Structural well-formedness check for DB-originated events (`queue.js:assertDbEventWellFormed`).
pub fn assert_db_event_well_formed(event: &Value) -> Result<(), &'static str> {
    let Value::Object(map) = event else {
        return Err("event is not an object");
    };
    for field in &[
        "chain",
        "requestId",
        "requestType",
        "payloadText",
        "requester",
        "callbackContract",
        "callbackMethod",
    ] {
        match map.get(*field).and_then(Value::as_str) {
            Some(s) if !s.trim().is_empty() => {}
            _ => return Err("event field is missing or empty"),
        }
    }
    if let Some(req_type) = map.get("requestType").and_then(Value::as_str) {
        if req_type.chars().any(char::is_whitespace) {
            return Err("event.requestType contains whitespace");
        }
    }
    Ok(())
}

// -----------------------------------------------------------------------------
// Durable Job Claim Orchestration
// -----------------------------------------------------------------------------

/// Durable job claim configuration options.
pub struct DurableClaimConfig<'a> {
    pub durable_queue_enabled: bool,
    pub allow_local_claim_during_backoff: bool,
    pub stale_processing_ms: u64,
    pub instance_id: &'a str,
}

/// Claim a durable job for processing across instances.
#[allow(clippy::too_many_arguments)]
pub fn claim_durable_job_for_processing<T: HttpTransport>(
    client: &SupabaseClient<T>,
    event_key: &str,
    is_retry: bool,
    attempts: u64,
    config: &DurableClaimConfig,
    now_iso: &str,
    stale_before_iso: &str,
    now_ms: u64,
) -> Result<ClaimDecision, String> {
    if !config.durable_queue_enabled {
        return Ok(ClaimDecision::Granted);
    }

    if client.is_backed_off(now_ms) {
        if config.allow_local_claim_during_backoff {
            return Ok(ClaimDecision::Granted);
        }
        return Ok(ClaimDecision::BackoffSkip);
    }

    let status = if is_retry { "retrying" } else { "processing" };
    let patch_fields = json!({
        "status": status,
        "attempts": attempts,
        "next_retry_at": Value::Null,
        "worker_response": {
            "retry_meta": {
                "durable_claimed": true,
                "claimed_by": config.instance_id,
                "claimed_at": now_iso,
            }
        }
    });

    let ready_statuses: &[&str] = if is_retry {
        &[
            "retry_scheduled",
            "failure_callback_retry_scheduled",
            "callback_retry_scheduled",
            "callback_pending",
            "queued",
            "queued_backpressure",
        ]
    } else {
        &["queued", "queued_backpressure"]
    };

    let stale_statuses: &[&str] = &["processing", "retrying", "callback_pending"];

    match claim_relayer_job(
        client,
        event_key,
        &patch_fields,
        ready_statuses,
        stale_statuses,
        stale_before_iso,
        now_ms,
    ) {
        Ok(Some(_)) => Ok(ClaimDecision::Granted),
        Ok(None) => Ok(ClaimDecision::Conflict),
        Err(err) => {
            if is_transient_durable_queue_error(&err) {
                if config.allow_local_claim_during_backoff {
                    return Ok(ClaimDecision::Granted);
                }
                return Ok(ClaimDecision::Unavailable);
            }
            Err(err)
        }
    }
}
