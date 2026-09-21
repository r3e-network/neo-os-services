//! The `/paymaster/authorize` fold. Policy evaluation and optional Neo N3 AA
//! hook reads execute through the Rust compute core; the verdict is then
//! custody-signed with the same D5 envelope as every other sensitive lane.

use neo_os_compute::core::EnvReader;
use neo_os_compute::paymaster::{evaluate_paymaster_authorization, PaymasterEvaluation};

use crate::compute_execute::{
    build_lane_signed_envelope, build_tee_attestation, reject_caller_supplied_signing_key,
    resolve_payload_network, sign_worker_bytes,
};
use crate::state::AppState;
use crate::RuntimeError;

pub fn handle_paymaster_authorize(
    state: &AppState,
    payload: &serde_json::Value,
) -> Result<serde_json::Value, RuntimeError> {
    reject_caller_supplied_signing_key(payload)?;

    let overlay = state.overlay.read().expect("overlay lock").merged_map();
    let env: EnvReader<'_> = &|name: &str| overlay.get(name).cloned();
    let http = |request: &neo_os_compute::transport::HttpRequest| state.oracle_io.fetch(request);
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0);
    let evaluation =
        evaluate_paymaster_authorization(env, payload, &http, now_ms, crate::vrf::random_uuid_v4)
            .map_err(|message| crate::http_error(400, message))?;
    let result = match evaluation {
        PaymasterEvaluation::Invalid(body) | PaymasterEvaluation::Verdict(body) => body,
    };

    let payload_bytes = neo_os_core::stable_stringify::stable_stringify(
        &neo_os_core::js_value::JsValue::from_json(&result),
    )
    .into_bytes();
    let output_hash = neo_os_core::sha256_hex(&payload_bytes);
    let network = resolve_payload_network(state, payload);
    let signed = sign_worker_bytes(state, &network, &payload_bytes)?;
    let tee_attestation = build_tee_attestation(state, payload, "custody", &output_hash)?;

    let mut response = result.as_object().cloned().unwrap_or_default();
    for (key, value) in build_lane_signed_envelope(&signed, &output_hash, &tee_attestation) {
        response.insert(key, value);
    }
    Ok(serde_json::Value::Object(response))
}

#[cfg(test)]
#[path = "../tests/unit/paymaster.rs"]
mod tests;
