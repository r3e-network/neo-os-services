//! The `/vrf/random` fold: generate 256 bits from the enclave OS CSPRNG,
//! bind them into the same custody-signed result envelope as every other
//! fulfillment lane, and return the legacy request/timestamp metadata.

use rand::RngCore;

use crate::compute_execute::{
    build_lane_signed_envelope, build_tee_attestation, reject_caller_supplied_signing_key,
    resolve_payload_network, sign_worker_bytes,
};
use crate::state::AppState;
use crate::RuntimeError;

pub fn handle_vrf_random(
    state: &AppState,
    payload: &serde_json::Value,
) -> Result<serde_json::Value, RuntimeError> {
    reject_caller_supplied_signing_key(payload)?;

    let mut random = [0_u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut random);
    let randomness = hex::encode(random);
    let result = serde_json::json!({ "randomness": randomness });
    let payload_bytes = neo_os_core::stable_stringify::stable_stringify(
        &neo_os_core::js_value::JsValue::from_json(&result),
    )
    .into_bytes();
    let output_hash = neo_os_core::sha256_hex(&payload_bytes);
    let network = resolve_payload_network(state, payload);
    let signed = sign_worker_bytes(state, &network, &payload_bytes)?;
    let tee_attestation = build_tee_attestation(state, payload, "custody", &output_hash);

    let request_id = payload
        .get("request_id")
        .filter(|value| js_truthy(value))
        .cloned()
        .unwrap_or_else(|| serde_json::Value::String(random_uuid_v4()));
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);

    let mut response = serde_json::Map::new();
    response.insert("request_id".to_string(), request_id);
    response.insert("randomness".to_string(), randomness.into());
    for (key, value) in build_lane_signed_envelope(&signed, &output_hash, &tee_attestation) {
        response.insert(key, value);
    }
    response.insert("timestamp".to_string(), timestamp.into());
    response.insert("vrf_method".to_string(), "csprng-signed".into());
    Ok(serde_json::Value::Object(response))
}

fn js_truthy(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Null => false,
        serde_json::Value::Bool(value) => *value,
        serde_json::Value::Number(number) => number.as_f64().is_some_and(|value| value != 0.0),
        serde_json::Value::String(value) => !value.is_empty(),
        serde_json::Value::Array(_) | serde_json::Value::Object(_) => true,
    }
}

pub(crate) fn random_uuid_v4() -> String {
    let mut bytes = [0_u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex = hex::encode(bytes);
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

#[cfg(test)]
#[path = "../tests/unit/vrf.rs"]
mod tests;
