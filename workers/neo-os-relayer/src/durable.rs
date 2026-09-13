//! Durable relayer worker lane: fetch -> optimistic claim -> execute -> patch.
//!
//! This module is deliberately independent of chain scanning. The scanner may
//! discover a request first, while a control-plane retry may already exist in
//! Supabase; both paths converge here and only the instance that wins the
//! database claim is allowed to execute the event.

use neo_os_relayer_store::jobs::{fetch_relayer_jobs_by_statuses, patch_relayer_job};
use neo_os_relayer_store::queue::{
    assert_db_event_well_formed, claim_durable_job_for_processing, ClaimDecision,
    DurableClaimConfig,
};
use neo_os_relayer_store::supabase::SupabaseClient;
use neo_os_relayer_store::HttpTransport;
use serde_json::{json, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DurableDrainOutcome {
    Disabled,
    Empty,
    Claimed,
    Conflict,
    SkippedBackoff,
    Unavailable,
}

pub struct DurableDrainConfig<'a> {
    pub enabled: bool,
    pub allow_local_claim_during_backoff: bool,
    pub stale_processing_ms: u64,
    pub instance_id: &'a str,
    pub network: &'a str,
    pub chain: &'a str,
    pub sync_limit: usize,
}

/// Drain at most `sync_limit` durable jobs. The callback is invoked only after
/// an optimistic claim succeeds. A successful callback is persisted as
/// `completed`; an error is persisted as `retry_scheduled` with the error.
/// Conflicts and backoff skips remain in the durable queue for a later tick.
pub fn drain_durable_jobs<T, F>(
    client: &SupabaseClient<T>,
    cfg: &DurableDrainConfig<'_>,
    now_ms: u64,
    now_iso: &str,
    stale_before_iso: &str,
    mut execute: F,
) -> Result<Vec<DurableDrainOutcome>, String>
where
    T: HttpTransport,
    F: FnMut(&Value) -> Result<(), String>,
{
    if !cfg.enabled {
        return Ok(vec![DurableDrainOutcome::Disabled]);
    }
    let jobs = fetch_relayer_jobs_by_statuses(
        client,
        &[
            "queued",
            "queued_backpressure",
            "retry_scheduled",
            "failure_callback_retry_scheduled",
            "callback_retry_scheduled",
            "callback_pending",
            "processing",
            "retrying",
        ],
        Some(cfg.chain),
        cfg.sync_limit.max(1),
        None,
        now_ms,
    )?;
    if jobs.is_empty() {
        return Ok(vec![DurableDrainOutcome::Empty]);
    }

    let mut outcomes = Vec::with_capacity(jobs.len());
    for job in jobs {
        // XCM-tagged rows belong to the cross-chain message lane
        // (crate::xcm_lane), which shares this table but runs its own drain and
        // relay path. Skip them here so the oracle drain never claims or
        // re-patches a cross-chain message row; both lanes partition the shared
        // queue by `route` and reuse the identical claim state machine.
        if job.get("route").and_then(Value::as_str) == Some(crate::xcm_lane::XCM_ROUTE) {
            continue;
        }
        let event_key = job
            .get("event_key")
            .and_then(Value::as_str)
            .ok_or_else(|| "durable job missing event_key".to_string())?;
        let Some(event) = job.get("event") else {
            let _ = patch_relayer_job(
                client,
                event_key,
                &json!({"status":"retry_scheduled","last_error":"durable job missing event"}),
                now_ms,
            );
            outcomes.push(DurableDrainOutcome::Unavailable);
            continue;
        };
        if let Err(error) = assert_db_event_well_formed(event) {
            let _ = patch_relayer_job(
                client,
                event_key,
                &json!({"status":"retry_scheduled","last_error":error}),
                now_ms,
            );
            outcomes.push(DurableDrainOutcome::Unavailable);
            continue;
        }
        let attempts = job.get("attempts").and_then(Value::as_u64).unwrap_or(0);
        let is_retry = job
            .get("status")
            .and_then(Value::as_str)
            .is_some_and(|s| s.contains("retry") || s == "callback_pending");
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
            ClaimDecision::Conflict => outcomes.push(DurableDrainOutcome::Conflict),
            ClaimDecision::BackoffSkip => outcomes.push(DurableDrainOutcome::SkippedBackoff),
            ClaimDecision::Unavailable => outcomes.push(DurableDrainOutcome::Unavailable),
            ClaimDecision::Granted => match execute(event) {
                Ok(()) => {
                    patch_relayer_job(
                        client,
                        event_key,
                        &json!({"status":"completed","last_error":Value::Null}),
                        now_ms,
                    )?;
                    outcomes.push(DurableDrainOutcome::Claimed);
                }
                Err(error) => {
                    patch_relayer_job(
                        client,
                        event_key,
                        &json!({"status":"retry_scheduled","last_error":error}),
                        now_ms,
                    )?;
                    outcomes.push(DurableDrainOutcome::Claimed);
                }
            },
        }
    }
    Ok(outcomes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use neo_os_relayer_store::supabase::SupabaseConfig;

    // The claim state machine itself is tested exhaustively in store_parity;
    // this test pins the worker contract: disabled drains never touch the
    // transport or execute callback.
    struct PanicTransport;
    impl HttpTransport for PanicTransport {
        fn request(
            &self,
            _: &str,
            _: &str,
            _: &[(&str, &str)],
            _: Option<&str>,
        ) -> Result<(u16, String), String> {
            panic!("disabled durable lane must not access Supabase");
        }
    }

    #[test]
    fn disabled_lane_is_a_noop() {
        let client = SupabaseClient::new(
            PanicTransport,
            SupabaseConfig::new("https://unused.invalid", "unused", "testnet"),
        );
        let mut executed = false;
        let outcomes = drain_durable_jobs(
            &client,
            &DurableDrainConfig {
                enabled: false,
                allow_local_claim_during_backoff: false,
                stale_processing_ms: 45_000,
                instance_id: "test",
                network: "testnet",
                chain: "neo_n3",
                sync_limit: 10,
            },
            0,
            "now",
            "before",
            |_| {
                executed = true;
                Ok(())
            },
        )
        .expect("disabled lane");
        assert_eq!(outcomes, vec![DurableDrainOutcome::Disabled]);
        assert!(!executed);
    }
}
