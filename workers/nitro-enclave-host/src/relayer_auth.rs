//! Purpose/network-bound caller material; no issuer or signing primitive.
use crate::state::AppState;
use crate::{http_error, RuntimeError};
use neo_os_relayer::store_auth::{decode_consistent_claims, ScopedClaims};
use serde_json::Value;
use std::fmt;
use zeroize::Zeroizing;

pub const CIPHERTEXT_ENV: &str = "MORPHEUS_RELAYER_AUTH_KMS_CIPHERTEXT_BASE64";
pub const PURPOSE: &str = "neoos/relayer-caller-auth/v1";
pub const GATE: &str = "MORPHEUS_EMBEDDED_RELAYER";

#[derive(Clone)]
pub struct RelayerCredential {
    pub version: u64,
    jwt: Zeroizing<String>,
    pub claims: ScopedClaims,
}
impl fmt::Debug for RelayerCredential {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RelayerCredential")
            .field("version", &self.version)
            .finish_non_exhaustive()
    }
}
impl RelayerCredential {
    pub(crate) fn jwt(&self) -> &str {
        self.jwt.as_str()
    }
}

pub fn enabled(overlay: &crate::overlay::EnvOverlay) -> Result<bool, &'static str> {
    match overlay.get(GATE) {
        None | Some("false") => Ok(false),
        Some("true") => Ok(true),
        _ => Err("embedded relayer gate must be exactly true or false"),
    }
}

pub(crate) fn materialize(
    state: &AppState,
    env: &serde_json::Map<String, Value>,
) -> Result<Option<RelayerCredential>, RuntimeError> {
    if !env.contains_key(CIPHERTEXT_ENV) {
        return Ok(None);
    }
    let overlay = state.overlay.read().expect("overlay lock");
    if !enabled(&overlay).map_err(|e| http_error(503, e))? {
        return Err(http_error(
            409,
            "embedded relayer is not enabled by the measured image",
        ));
    }
    let issuer = overlay
        .get_trimmed("MORPHEUS_RELAYER_JWT_ISSUER")
        .ok_or_else(|| http_error(503, "relayer issuer is not pinned"))?;
    let subject = overlay
        .get_trimmed("MORPHEUS_RELAYER_CALLER_ID")
        .ok_or_else(|| http_error(503, "relayer caller is not pinned"))?;
    drop(overlay);
    let envelope = crate::provision::release_context_envelope(state, env, CIPHERTEXT_ENV, PURPOSE)?
        .ok_or_else(|| http_error(400, "encrypted relayer credential is required"))?;
    let version = envelope
        .get("version")
        .and_then(Value::as_u64)
        .filter(|v| *v > 0)
        .ok_or_else(|| http_error(400, "invalid relayer envelope version"))?;
    let jwt = envelope
        .get("jwt")
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| http_error(400, "invalid relayer credential envelope"))?;
    let network = state.resolve_network()?;
    let claims = decode_consistent_claims(
        jwt,
        &network,
        &issuer,
        &subject,
        state.oracle_io.now_ms() / 1000,
    )
    .map_err(|_| http_error(400, "relayer claims do not match the boot context"))?;
    Ok(Some(RelayerCredential {
        version,
        jwt: Zeroizing::new(jwt.to_string()),
        claims,
    }))
}

pub fn refresh(state: &AppState, payload: &Value) -> Result<Value, RuntimeError> {
    if state
        .runtime_token_kms_version
        .load(std::sync::atomic::Ordering::SeqCst)
        == 0
    {
        return Err(http_error(409, "runtime must be provisioned first"));
    }
    let env = payload
        .get("env")
        .and_then(Value::as_object)
        .filter(|e| e.len() == 1 && e.contains_key(CIPHERTEXT_ENV))
        .ok_or_else(|| http_error(400, "relayer refresh accepts only its encrypted credential"))?;
    let credential = materialize(state, env)?
        .ok_or_else(|| http_error(400, "encrypted relayer credential is required"))?;
    let version = credential.version;
    let mut overlay = state.overlay.write().expect("overlay lock");
    overlay
        .install_relayer_auth(credential)
        .map_err(|e| http_error(409, e))?;
    overlay.apply(
        CIPHERTEXT_ENV,
        env.get(CIPHERTEXT_ENV).expect("validated field"),
    );
    Ok(serde_json::json!({"status":"ok","relayer_credential_version":version}))
}
