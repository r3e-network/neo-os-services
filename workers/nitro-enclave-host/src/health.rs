//! `/health` — compute + signer readiness, ported from
//! `enclave-server.mjs:1831-1890`. The shape is a liveness contract: the
//! orchestrator polls `ready`, ops read `key_source` to detect any plaintext
//! reliance, and `kms_diag` reports whether the attestation-gated KMS path
//! has been proven — without ever carrying a secret.
//!
//! `key_source` comes from the signing plane's own report, not from env
//! inference: the merged server guessed by looking for KMS ciphertext env
//! names, but the split's host holds no keys at all — how a role's key is
//! held (`custody`, `kms_attested`, `none`) is exactly what the plane knows.
//! `/provision` already renders the plane's report; /health disagreeing with
//! it about the same role would make one of the two wrong, and an operator
//! watching for plaintext reliance must read the same answer twice.

use crate::state::AppState;
use crate::RUNTIME_NAME;

pub fn handle_health(state: &AppState) -> serde_json::Value {
    let network = state.resolve_network();
    let reports = state.signing_role_reports();
    // Neo N3 is the mandatory signing plane for this host. NeoX roles are an
    // optional lane and must not make a Neo N3-only deployment report
    // globally unhealthy when they are intentionally unconfigured.
    let signer_ok = reports
        .iter()
        .filter(|(role, _)| matches!(*role, "worker" | "relayer" | "updater" | "oracle_verifier"))
        .all(|(_, report)| report.ok && report.materialized);

    // The measured runtime has no optional compute child. Implemented lanes
    // execute in-process and unmigrated fulfillment types refuse
    // deterministically, so host liveness is the compute readiness signal.
    let compute_ready = true;
    let ready = compute_ready && signer_ok;

    let mut checks = serde_json::json!({
        "compute": compute_ready,
        "signer": signer_ok,
    });
    let mut key_source = serde_json::Map::new();
    let mut signer_errors = Vec::new();
    for (role, report) in &reports {
        checks[format!("{role}_ready")] = serde_json::Value::Bool(report.ok && report.materialized);
        if !report.public_key.is_empty() {
            checks[format!("{role}_public_key")] =
                serde_json::Value::String(report.public_key.clone());
        }
        key_source.insert(
            (*role).to_string(),
            serde_json::Value::String(report.key_source.clone()),
        );
        if matches!(*role, "worker" | "relayer" | "updater" | "oracle_verifier")
            && (!report.ok || !report.materialized)
        {
            if report.issues.is_empty() {
                signer_errors.push(format!("{role}: custody identity is not materialized"));
            } else {
                signer_errors.push(format!("{role}: {}", report.issues.join("; ")));
            }
        }
    }

    let mut body = serde_json::json!({
        "status": if ready { "ok" } else { "degraded" },
        "ready": ready,
        "runtime": RUNTIME_NAME,
        "network": network,
        "provisioned": state.runtime_token_kms_version.load(std::sync::atomic::Ordering::SeqCst) > 0,
        "checks": checks,
        "key_source": key_source,
        "plaintext_key_provision_allowed": false,
        "kms_diag": state.kms_diag.lock().expect("kms diag lock").value.clone(),
    });
    if !signer_errors.is_empty() {
        body["signer_error"] = serde_json::Value::String(signer_errors.join(" | "));
    }
    body
}

#[cfg(test)]
#[path = "../tests/unit/health.rs"]
mod tests;
