//! `/session/{start,step,finalize}` — the Rust confidential-game host.
//!
//! The keyless state machine and 79-byte codec live in
//! `neo_os_games::session`. This frontier contributes only the two
//! measured-boundary capabilities: a recipient-attested game-secret HMAC root
//! and the custody worker signature over the successful finalize payload.

use std::sync::{Mutex, OnceLock};

use neo_os_core::js_value::JsValue;
use neo_os_core::stable_stringify::stable_stringify;
use neo_os_games::session::{validate_identity_and_engine, SessionReply, SessionStore};
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

static SESSIONS: OnceLock<Mutex<SessionStore>> = OnceLock::new();

struct GameKeyMaterial {
    secret_root: [u8; 32],
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
    let reply =
        session_store()?.start(payload, &material.secret_root, &material.public_key, now_ms);
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
    let reply = session_store()?.step(payload, &material.secret_root, now_ms);
    Ok(reply.into())
}

pub fn handle_session_finalize(
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
    let reply = session_store()?.finalize(payload, &material.secret_root, now_ms);
    if reply.status != 200 {
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
    let tee_attestation = build_tee_attestation(state, payload, "worker", &output_hash);

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

fn session_store() -> Result<std::sync::MutexGuard<'static, SessionStore>, RuntimeError> {
    SESSIONS
        .get_or_init(|| Mutex::new(SessionStore::new()))
        .lock()
        .map_err(|_| http_error(500, "game session state unavailable"))
}

fn game_key_material(state: &AppState, network: &str) -> Option<GameKeyMaterial> {
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
        secret_root,
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
fn reset_sessions_for_tests() {
    if let Some(store) = SESSIONS.get() {
        store.lock().expect("session test lock").clear();
    }
}

#[cfg(test)]
#[path = "../tests/unit/session.rs"]
mod tests;
