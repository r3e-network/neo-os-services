//! Worker-level durable-queue drain test (review P1-3).
//!
//! Verifies that the relayer worker's `drain_durable_jobs` performs the full
//! claim -> execute -> patch lifecycle against a scripted Supabase double, and
//! that a conflict (another instance already claimed the job) never reaches the
//! execute callback. The claim state machine's two-instance race is pinned in
//! neo-os-relayer-store's store_parity; this test pins the worker orchestration
//! that sits on top of it.

use neo_os_relayer_store::supabase::{SupabaseClient, SupabaseConfig};
use neo_os_relayer_store::HttpTransport;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

use neo_os_relayer::durable::{drain_durable_jobs, DurableDrainConfig, DurableDrainOutcome};

/// Scripted Supabase double: returns a fixed job list on GET, and on PATCH
/// either grants the claim (returns an empty-but-representation body) or
/// rejects it (also empty body, but the orchestrator already won/lost by the
/// time it issues PATCH — this responder simply records every mutation).
struct MockSupabase {
    jobs: Mutex<String>,
    patches: Mutex<Vec<String>>,
    claim_granted: AtomicUsize,
}

impl MockSupabase {
    fn new(jobs: Value) -> Self {
        Self {
            jobs: Mutex::new(jobs.to_string()),
            patches: Mutex::new(Vec::new()),
            claim_granted: AtomicUsize::new(0),
        }
    }
}

impl HttpTransport for MockSupabase {
    fn request(
        &self,
        method: &str,
        url: &str,
        _headers: &[(&str, &str)],
        body: Option<&str>,
    ) -> Result<(u16, String), String> {
        if method == "GET" && url.contains("morpheus_relayer_jobs") {
            return Ok((200, self.jobs.lock().unwrap().clone()));
        }
        if method == "PATCH" && url.contains("morpheus_relayer_jobs") {
            self.patches
                .lock()
                .unwrap()
                .push(body.unwrap_or("").to_string());
            // PostgREST PATCH with return=representation returns "[]" when no
            // row matched the optimistic precondition (the conflict case). A
            // granted claim returns the updated row. We model "won the claim"
            // by the FIRST PATCH winning; drain_durable_jobs only reaches
            // execute when claim_durable_job_for_processing returns Granted,
            // which it does when claim_relayer_job got a non-empty row.
            let won = self.claim_granted.fetch_add(1, Ordering::SeqCst) == 0;
            if won {
                return Ok((200, "[{\"id\":1}]".to_string()));
            }
            return Ok((200, "[]".to_string()));
        }
        Ok((200, "[]".to_string()))
    }
}

fn job_rows() -> Value {
    json!([{
        "event_key": "neo_n3:7:0",
        "request_id": "7",
        "status": "queued",
        "attempts": 0,
        "chain": "neo_n3",
        "event": {
            "chain": "neo_n3",
            "requestId": "7",
            "requestType": "oracle",
            "payloadText": "{}",
            "requester": "0xab",
            "callbackContract": "0xcd",
            "callbackMethod": "onOracleResult"
        }
    }])
}

fn drain_config() -> DurableDrainConfig<'static> {
    DurableDrainConfig {
        enabled: true,
        allow_local_claim_during_backoff: false,
        stale_processing_ms: 120_000,
        instance_id: "worker-A",
        network: "testnet",
        chain: "neo_n3",
        sync_limit: 200,
    }
}

#[test]
fn granted_job_executes_exactly_once_and_patches_completed() {
    let transport = MockSupabase::new(job_rows());
    let client = SupabaseClient::new(
        &transport,
        SupabaseConfig::new("https://test.supabase.co", "test-key", "testnet"),
    );

    let executed = AtomicUsize::new(0);
    let outcomes = drain_durable_jobs(
        &client,
        &drain_config(),
        1000,
        "2026-09-05T12:00:00.000Z",
        "2026-09-05T11:58:00.000Z",
        |_event| {
            executed.fetch_add(1, Ordering::SeqCst);
            Ok(())
        },
    )
    .expect("drain succeeds");

    // Exactly one job, claimed and executed exactly once.
    assert_eq!(outcomes, vec![DurableDrainOutcome::Claimed]);
    assert_eq!(executed.load(Ordering::SeqCst), 1);

    // The terminal patch must be the completed status, not a retry.
    let patches = transport.patches.lock().unwrap();
    assert!(
        patches.iter().any(|p| p.contains("\"status\":\"completed\"")),
        "worker must patch the claimed job completed after success: {patches:?}"
    );
}

#[test]
fn two_workers_racing_same_job_never_both_execute() {
    // Worker A and B drain the same job. The claim precondition is
    // enforced by PostgREST `or=(status.in.(...))`; only the winner sees a
    // representation row. Model it here with a shared AtomicUsize that lets
    // exactly one drain win its claim PATCH — mirroring store_parity's
    // two-instance race.
    let transport = MockSupabase::new(job_rows());
    let client = SupabaseClient::new(
        &transport,
        SupabaseConfig::new("https://test.supabase.co", "test-key", "testnet"),
    );

    let executed = AtomicUsize::new(0);
    let run = || -> Vec<DurableDrainOutcome> {
        drain_durable_jobs(
            &client,
            &drain_config(),
            1000,
            "2026-09-05T12:00:00.000Z",
            "2026-09-05T11:58:00.000Z",
            |_event| {
                executed.fetch_add(1, Ordering::SeqCst);
                Ok(())
            },
        )
        .expect("drain succeeds")
    };

    let first = run();
    let second = run();

    // Across the two workers the job is executed at most once total.
    assert!(
        executed.load(Ordering::SeqCst) <= 1,
        "durable claim must prevent double execution; executed={}",
        executed.load(Ordering::SeqCst)
    );
    // The loser reports a conflict (job retained for a later tick).
    assert!(first.iter().any(|o| *o == DurableDrainOutcome::Claimed));
    assert!(
        second.iter().any(|o| *o == DurableDrainOutcome::Conflict),
        "the losing worker must report Conflict, not execute: {second:?}"
    );
}

#[test]
fn failing_execution_is_patched_retry_scheduled_not_completed() {
    let transport = MockSupabase::new(job_rows());
    let client = SupabaseClient::new(
        &transport,
        SupabaseConfig::new("https://test.supabase.co", "test-key", "testnet"),
    );

    let outcomes = drain_durable_jobs(
        &client,
        &drain_config(),
        1000,
        "2026-09-05T12:00:00.000Z",
        "2026-09-05T11:58:00.000Z",
        |_event| Err("kernel unreachable".to_string()),
    )
    .expect("drain handles execution failure");

    assert_eq!(outcomes, vec![DurableDrainOutcome::Claimed]);
    let patches = transport.patches.lock().unwrap();
    assert!(
        patches.iter().any(|p| p.contains("\"status\":\"retry_scheduled\"")),
        "failed execution must be patched retry_scheduled: {patches:?}"
    );
    assert!(
        patches.iter().any(|p| p.contains("kernel unreachable")),
        "retry patch must carry the failure reason: {patches:?}"
    );
}
