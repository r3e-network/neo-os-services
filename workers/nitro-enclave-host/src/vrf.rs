//! The `/vrf/random` fold derives stable, domain-bound bytes from a
//! recipient-attested KMS root and signs the result envelope through custody.

use hmac::{Hmac, Mac};
use rand::RngCore;
use sha2::Sha256;

use crate::compute_execute::{
    build_lane_signed_envelope, build_tee_attestation, reject_caller_supplied_signing_key,
    resolve_payload_network, sign_worker_bytes,
};
use crate::state::AppState;
use crate::{http_error, RuntimeError};

pub fn handle_vrf_random(
    state: &AppState,
    payload: &serde_json::Value,
) -> Result<serde_json::Value, RuntimeError> {
    reject_caller_supplied_signing_key(payload)?;

    let request_id = payload
        .get("request_id")
        .filter(|value| js_truthy(value))
        .cloned()
        .ok_or_else(|| http_error(400, "request_id is required for deterministic VRF"))?;
    let module_id = match payload.get("module_id") {
        None => "random.generate",
        Some(serde_json::Value::String(value)) if value == "random.generate" => value.as_str(),
        Some(_) => return Err(http_error(400, "module_id must be random.generate")),
    };
    if module_id != "random.generate" {
        return Err(http_error(400, "module_id must be random.generate"));
    }
    let network = resolve_payload_network(state, payload);
    let root = {
        let overlay = state.overlay.read().expect("overlay lock");
        if overlay
            .get_trimmed("MORPHEUS_GAME_SECRET_ROOT_SOURCE")
            .as_deref()
            != Some("nitro-recipient-kms")
        {
            return Err(http_error(503, "VRF key is not KMS materialized"));
        }
        let root = overlay
            .get_trimmed("MORPHEUS_GAME_SECRET_ROOT_HEX")
            .ok_or_else(|| http_error(503, "VRF key is not KMS materialized"))?;
        let bytes = hex::decode(root).map_err(|_| http_error(503, "VRF key is invalid"))?;
        <[u8; 32]>::try_from(bytes).map_err(|_| http_error(503, "VRF key is invalid"))?
    };
    let request_id_bytes =
        serde_json::to_vec(&request_id).map_err(|_| http_error(400, "request_id is invalid"))?;
    let mut mac =
        Hmac::<Sha256>::new_from_slice(&root).map_err(|_| http_error(503, "VRF key is invalid"))?;
    for part in [
        b"neoos-vrf-random-v1".as_slice(),
        network.as_bytes(),
        request_id_bytes.as_slice(),
        module_id.as_bytes(),
    ] {
        mac.update(&(part.len() as u32).to_be_bytes());
        mac.update(part);
    }
    let randomness = hex::encode(mac.finalize().into_bytes());
    let result = serde_json::json!({ "randomness": randomness });
    let payload_bytes = neo_os_core::stable_stringify::stable_stringify(
        &neo_os_core::js_value::JsValue::from_json(&result),
    )
    .into_bytes();
    let output_hash = neo_os_core::sha256_hex(&payload_bytes);
    let signed = sign_worker_bytes(state, &network, &payload_bytes)?;
    let tee_attestation = build_tee_attestation(state, payload, "custody", &output_hash)?;

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
    response.insert("vrf_method".to_string(), "hmac-sha256-signed".into());
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
