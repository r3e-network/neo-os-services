//! `/health` — compute + signer readiness, ported from
//! `enclave-server.mjs:1831-1890`. The shape is a liveness contract: the
//! orchestrator polls `ready`, ops read `key_source` to detect any plaintext
//! reliance, and `kms_diag` reports whether the attestation-gated KMS path
//! has been proven — without ever carrying a secret.

use crate::state::AppState;
use crate::RUNTIME_NAME;

/// `roleHasKmsCiphertext`: whether a KMS ciphertext is provisioned for the
/// role — the marker that a materialized key arrived through the
/// attestation-gated path rather than as plaintext.
fn role_has_kms_ciphertext(state: &AppState, role: &str) -> bool {
    let name = match role {
        "oracle_verifier" => "MORPHEUS_ORACLE_VERIFIER_KMS_CIPHERTEXT_BASE64",
        "updater" => "MORPHEUS_UPDATER_NEO_N3_KMS_CIPHERTEXT_BASE64",
        _ => return false,
    };
    state
        .overlay
        .read()
        .expect("overlay lock")
        .get_trimmed(name)
        .is_some()
}

/// `roleKeySource`: how a materialized role key reached the trust boundary.
fn role_key_source(state: &AppState, role: &str, materialized: bool) -> &'static str {
    if !materialized {
        return "none";
    }
    if role_has_kms_ciphertext(state, role) {
        "kms_attested"
    } else {
        "host_plaintext"
    }
}

pub fn handle_health(state: &AppState) -> serde_json::Value {
    let network = state.resolve_network();
    let verifier = state.signer.role_report(&network, "oracle_verifier");
    let signer_ok = verifier.ok && verifier.materialized;
    let updater = state.signer.role_report(&network, "updater");

    let compute_ready = state.bridge.ready();
    let ready = compute_ready && signer_ok;

    let mut checks = serde_json::json!({
        "compute": compute_ready,
        "signer": signer_ok,
    });
    if !verifier.public_key.is_empty() {
        checks["oracle_verifier_public_key"] =
            serde_json::Value::String(verifier.public_key.clone());
    }

    let mut body = serde_json::json!({
        "status": if ready { "ok" } else { "degraded" },
        "ready": ready,
        "runtime": RUNTIME_NAME,
        "network": network,
        "checks": checks,
        "key_source": {
            "oracle_verifier": role_key_source(state, "oracle_verifier", verifier.materialized),
            "updater": role_key_source(state, "updater", updater.materialized),
        },
        "plaintext_key_provision_allowed": false,
        "kms_diag": state.kms_diag.lock().expect("kms diag lock").value.clone(),
    });
    if !signer_ok && !verifier.issues.is_empty() {
        body["signer_error"] = serde_json::Value::String(verifier.issues.join("; "));
    }
    body
}

#[cfg(test)]
#[path = "../tests/unit/health.rs"]
mod tests;
