//! `/session/{start,step,finalize}` — the Rust confidential-game host.
//!
//! The keyless state machine and the result codec (v2, 111 bytes) live in
//! `neo_os_games::session`. This frontier contributes only the two
//! measured-boundary capabilities: the game-session HMAC key, expanded from
//! the recipient-attested KMS root under its own label
//! ([`crate::secret_root::game_session_key`]), and the custody worker
//! signature over the successful finalize payload.
//! The kernel lane also hands the session machine the chain side of its
//! request — `request_id` and `requester`, which the `/oracle/fulfill` fold
//! takes from the relayer's view of the on-chain request — so a result can
//! only settle the session its requester played, once.

use rand::RngCore;

use neo_os_core::js_value::JsValue;
use neo_os_core::stable_stringify::stable_stringify;
use neo_os_games::session::{
    validate_identity_and_engine, FinalizeLane, KernelRequest, SessionReply, SessionStore,
    SEALED_FINALIZE_KIND,
};
use serde_json::Value as Json;

use crate::compute_execute::{
    build_tee_attestation, reject_caller_supplied_signing_key, sign_worker_bytes,
};
use crate::http_error;
use crate::state::AppState;
use crate::{DispatchOutcome, RuntimeError};

const GAME_SECRET_ROOT_ENV: &str = "MORPHEUS_GAME_SECRET_ROOT_HEX";
const GAME_SECRET_SOURCE_ENV: &str = "MORPHEUS_GAME_SECRET_ROOT_SOURCE";
const KMS_SOURCE: &str = "nitro-recipient-kms";

struct GameKeyMaterial {
    session_key: [u8; 32],
    public_key: String,
}

pub fn handle_session_start(
    state: &AppState,
    payload: &Json,
) -> Result<DispatchOutcome, RuntimeError> {
    let identity = match validate_identity_and_engine(payload) {
        Ok(identity) => identity,
        Err(message) => return Ok(protocol_error(400, message)),
    };
    let material = match game_key_material(state, &identity.network) {
        Some(material) => material,
        None => return Ok(protocol_error(503, "game key material unavailable")),
    };
    let now_ms = state.oracle_io.now_ms() as f64;
    let mut fresh_token = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut fresh_token);
    let reply = session_store(state)?.start(
        payload,
        &material.session_key,
        &material.public_key,
        now_ms,
        &fresh_token,
    );
    Ok(reply.into())
}

pub fn handle_session_step(
    state: &AppState,
    payload: &Json,
) -> Result<DispatchOutcome, RuntimeError> {
    let identity = match validate_identity_and_engine(payload) {
        Ok(identity) => identity,
        Err(message) => return Ok(protocol_error(400, message)),
    };
    let material = match game_key_material(state, &identity.network) {
        Some(material) => material,
        None => return Ok(protocol_error(503, "game key material unavailable")),
    };
    let now_ms = state.oracle_io.now_ms() as f64;
    let reply = session_store(state)?.step(payload, &material.session_key, now_ms);
    Ok(reply.into())
}

pub fn handle_session_finalize(
    state: &AppState,
    payload: &Json,
) -> Result<DispatchOutcome, RuntimeError> {
    finalize_session(state, payload, FinalizeLane::Direct)
}

pub(crate) fn handle_session_finalize_kernel(
    state: &AppState,
    payload: &Json,
) -> Result<DispatchOutcome, RuntimeError> {
    if payload.get("kind").and_then(Json::as_str) != Some(SEALED_FINALIZE_KIND) {
        return Ok(protocol_error(400, "SEALED_KIND_UNSUPPORTED"));
    }
    // On the /oracle/fulfill path `build_worker_payload` sets `request_id` to
    // the kernel request id, and `requester` is the key the relayer always
    // sets from the on-chain request. The bearer-gated /session/settle and
    // automation lanes must supply both themselves.
    let request = KernelRequest {
        request_id: kernel_field(payload, "request_id"),
        requester: kernel_field(payload, "requester"),
    };
    finalize_session(state, payload, FinalizeLane::Kernel(request))
}

fn kernel_field(payload: &Json, name: &str) -> String {
    match payload.get(name) {
        Some(Json::String(text)) => text.trim().to_string(),
        Some(Json::Number(number)) => number.to_string(),
        _ => String::new(),
    }
}

fn finalize_session(
    state: &AppState,
    payload: &Json,
    lane: FinalizeLane,
) -> Result<DispatchOutcome, RuntimeError> {
    let identity = match validate_identity_and_engine(payload) {
        Ok(identity) => identity,
        Err(message) => return Ok(protocol_error(400, message)),
    };
    let material = match game_key_material(state, &identity.network) {
        Some(material) => material,
        None => return Ok(protocol_error(503, "game key material unavailable")),
    };
    let now_ms = state.oracle_io.now_ms() as f64;
    let direct = lane == FinalizeLane::Direct;
    let reply = session_store(state)?.finalize(payload, &material.session_key, now_ms, lane);
    if reply.status != 200 || direct {
        return Ok(reply.into());
    }

    // The session machine is deliberately keyless. Only a complete successful
    // result crosses into the custody lane, and caller material never does.
    reject_caller_supplied_signing_key(payload)?;
    let result_bytes_base64 = reply
        .body
        .get("result_bytes_base64")
        .and_then(Json::as_str)
        .ok_or_else(|| http_error(500, "session finalize result is incomplete"))?;
    let signing_payload = serde_json::json!({
        "result_bytes_base64": result_bytes_base64,
    });
    let payload_bytes = stable_stringify(&JsValue::from_json(&signing_payload)).into_bytes();
    let output_hash = neo_os_core::sha256_hex(&payload_bytes);
    let signed = sign_worker_bytes(state, &identity.network, &payload_bytes)?;
    let tee_attestation = build_tee_attestation(state, payload, "worker", &output_hash)?;

    let signature = signed_field(&signed, "signature");
    let signed_public_key = signed_field(&signed, "public_key");
    let signer_address = signed_field(&signed, "address");
    let signer_script_hash = signed_field(&signed, "script_hash");
    let verification = serde_json::json!({
        "output_hash": output_hash,
        "attestation_hash": output_hash,
        "signature": signature,
        "public_key": signed_public_key,
        "signer_address": signer_address,
        "signer_script_hash": signer_script_hash,
        "tee_attestation": tee_attestation,
    });

    let mut body = reply
        .body
        .as_object()
        .cloned()
        .ok_or_else(|| http_error(500, "session finalize result is incomplete"))?;
    // During the Rust consolidation `game-settle` is no longer a second local
    // private key. The informational top-level identity is the same custody
    // worker public key that actually produced the envelope signature.
    body.insert("public_key".into(), Json::String(material.public_key));
    body.insert("output_hash".into(), Json::String(output_hash));
    body.insert("signature".into(), signature);
    body.insert("verification".into(), verification);
    Ok(DispatchOutcome::ok(Json::Object(body)))
}

fn session_store(
    state: &AppState,
) -> Result<std::sync::MutexGuard<'_, SessionStore>, RuntimeError> {
    state
        .game_sessions
        .lock()
        .map_err(|_| http_error(500, "game session state unavailable"))
}

fn game_key_material(state: &AppState, network: &str) -> Option<GameKeyMaterial> {
    if state.resolve_network().ok()?.as_str() != network {
        return None;
    }
    let secret_root = {
        let overlay = state.overlay.read().ok()?;
        if overlay.get_trimmed(GAME_SECRET_SOURCE_ENV).as_deref() != Some(KMS_SOURCE) {
            return None;
        }
        let root_hex = overlay.get_trimmed(GAME_SECRET_ROOT_ENV)?;
        let bytes = hex::decode(root_hex).ok()?;
        <[u8; 32]>::try_from(bytes).ok()?
    };
    let report = state.signer.role_report(network, "worker");
    if !(report.ok && report.materialized) || report.public_key.trim().is_empty() {
        return None;
    }
    Some(GameKeyMaterial {
        session_key: crate::secret_root::game_session_key(&secret_root),
        public_key: report.public_key.trim().to_string(),
    })
}

fn signed_field(signed: &Json, name: &str) -> Json {
    signed
        .get(name)
        .and_then(Json::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| Json::String(value.to_string()))
        .unwrap_or(Json::Null)
}

fn protocol_error(status: u16, message: impl Into<String>) -> DispatchOutcome {
    DispatchOutcome {
        status,
        body: serde_json::json!({ "error": message.into() }),
    }
}

impl From<SessionReply> for DispatchOutcome {
    fn from(reply: SessionReply) -> Self {
        DispatchOutcome {
            status: reply.status,
            body: reply.body,
        }
    }
}

#[cfg(test)]
#[path = "../tests/unit/session.rs"]
mod tests;
