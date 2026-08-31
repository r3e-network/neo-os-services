//! `/provision` — the runtime configuration boundary, ported from
//! `enclave-server.mjs:280-502`. The enclave boots with only the baked image
//! ENV, so everything that configures it arrives here: network, worker
//! config, and the runtime authorization token — the token itself sealed in a
//! KMS envelope that only THIS enclave's measurement can open.
//!
//! The state machine's three rails, unchanged from the Node server:
//!
//! * **First provision** requires `MORPHEUS_RUNTIME_TOKEN_KMS_CIPHERTEXT_BASE64`.
//!   The operator relays ciphertext and presents the token; KMS releases the
//!   envelope only to the attested enclave, so the host cannot install a token
//!   of its choice. The presented token must match the released one.
//! * **Rotation** requires the current token (as a normal bearer credential)
//!   and a strictly newer versioned envelope — 409 otherwise.
//! * **Plaintext provisioning is permanently refused** (403): a compromised
//!   host must not be able to inject a known signer key in one request. The
//!   rejected names are sorted so the refusal is deterministic and greppable.
//!
//! The one deliberate divergence from the merged Node server: the
//! `materialize*FromKms` key-recovery calls are NOT here. In the split, keys
//! live in the custody service behind the signer plane — this host holds no
//! key material, so there is nothing to materialize. The custody enclave is
//! provisioned by the same start script with the same ciphertext envelopes.
//! The other half of the merged server's `process.env[key] = text` write —
//! the in-process worker handler observing the new env — becomes a compute
//! child respawn ([`crate::child`]): the child's config surface is its boot
//! env, so the host replaces it with the merged view once the overlay is
//! updated. Best-effort: a failed respawn is logged and retried by the watch
//! loop; the provision response still reports the applied keys.

use serde_json::Value;

use crate::auth::{
    extract_request_token, timing_safe_token_match, RUNTIME_TOKEN_KMS_CIPHERTEXT_ENV,
    RUNTIME_TOKEN_KMS_PURPOSE, TOKEN_ENV_KEYS,
};
use crate::http_error;
use crate::state::{AppState, KmsReleaseParams, RoleReport};
use crate::RuntimeError;

/// Plaintext signing-key env vars a host could otherwise inject via /provision
/// to bypass the KMS-attested path. The `*_KMS_CIPHERTEXT_BASE64` variants are
/// accepted because the host only ever holds ciphertext. Ported verbatim from
/// `PLAINTEXT_KEY_ENV_KEYS`.
pub const PLAINTEXT_KEY_ENV_KEYS: [&str; 21] = [
    // Neo N3 (secp256r1) WIFs / raw keys.
    "MORPHEUS_ORACLE_VERIFIER_WIF_MAINNET",
    "MORPHEUS_ORACLE_VERIFIER_WIF_TESTNET",
    "MORPHEUS_ORACLE_VERIFIER_WIF",
    "MORPHEUS_ORACLE_VERIFIER_PRIVATE_KEY_MAINNET",
    "MORPHEUS_ORACLE_VERIFIER_PRIVATE_KEY_TESTNET",
    "MORPHEUS_UPDATER_NEO_N3_WIF_MAINNET",
    "MORPHEUS_UPDATER_NEO_N3_WIF_TESTNET",
    "MORPHEUS_UPDATER_NEO_N3_WIF",
    "MORPHEUS_UPDATER_NEO_N3_PRIVATE_KEY_MAINNET",
    "MORPHEUS_UPDATER_NEO_N3_PRIVATE_KEY_TESTNET",
    // Neo X (EVM, secp256k1) keys.
    "MORPHEUS_NEOX_VERIFIER_PRIVATE_KEY",
    "MORPHEUS_NEOX_VERIFIER_KEY",
    "NEOX_VERIFIER_PK",
    "MORPHEUS_NEOX_UPDATER_PRIVATE_KEY",
    "NEOX_UPDATER_PK",
    "MORPHEUS_NEOX_FEED_PRIVATE_KEY",
    "NEOX_FEED_PK",
    "NEOX_FEED_PRIVATE_KEY",
    // X25519 oracle confidential-decrypt key material.
    "MORPHEUS_ORACLE_KEY_MATERIAL_JSON",
    "MORPHEUS_ORACLE_KEY_MATERIAL_BASE64",
    // NeoDID nullifier/ticket salt.
    "NEODID_SECRET_SALT",
];

/// `resolveProvisionEnv`: the body's env map, or empty when absent/misshaped.
pub fn provision_env(payload: &Value) -> Option<&serde_json::Map<String, Value>> {
    payload.get("env").and_then(Value::as_object)
}

/// The token released from the KMS envelope, with its envelope version.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MaterializedToken {
    pub token: String,
    pub version: u64,
}

/// `kmsRunnerEnv`'s resolution order, expressed against the payload env first
/// and the overlay second (the overlay already contains everything previously
/// provisioned, which is what the Node server's accumulated `process.env`
/// held).
fn provisioned_or_current(
    state: &AppState,
    env: &serde_json::Map<String, Value>,
    name: &str,
) -> Option<String> {
    if let Some(value) = env.get(name).and_then(Value::as_str) {
        let value = value.trim();
        if !value.is_empty() {
            return Some(value.to_string());
        }
    }
    state
        .overlay
        .read()
        .expect("overlay lock")
        .get_trimmed(name)
}

/// The KMS inputs the release path carries — region resolved the way
/// `materializeProvisionRuntimeToken` resolves it, credentials from the
/// payload env or the accumulated overlay (never the raw process env).
fn kms_release_params(
    state: &AppState,
    env: &serde_json::Map<String, Value>,
    ciphertext_b64: &str,
) -> Option<KmsReleaseParams> {
    let region = provisioned_or_current(state, env, "AWS_REGION")
        .or_else(|| provisioned_or_current(state, env, "NITRO_AWS_REGION"))
        .unwrap_or_else(|| "us-east-1".to_string());
    let access_key_id = provisioned_or_current(state, env, "AWS_ACCESS_KEY_ID")?;
    let secret_access_key = provisioned_or_current(state, env, "AWS_SECRET_ACCESS_KEY")?;
    let session_token = provisioned_or_current(state, env, "AWS_SESSION_TOKEN");
    Some(KmsReleaseParams {
        region,
        ciphertext_b64: ciphertext_b64.to_string(),
        access_key_id,
        secret_access_key,
        session_token,
    })
}

/// `materializeProvisionRuntimeToken`: KMS-release the envelope, validate its
/// context (purpose, network, version, token shape) and return the token it
/// authorizes. Every failure mode has the Node server's exact status and
/// message.
pub fn materialize_provision_runtime_token(
    state: &AppState,
    env: &serde_json::Map<String, Value>,
) -> Result<MaterializedToken, RuntimeError> {
    let ciphertext = env
        .get(RUNTIME_TOKEN_KMS_CIPHERTEXT_ENV)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let Some(ciphertext) = ciphertext else {
        return Err(http_error(
            401,
            format!("first provision requires {RUNTIME_TOKEN_KMS_CIPHERTEXT_ENV}"),
        ));
    };
    let Some(params) = kms_release_params(state, env, ciphertext) else {
        // No credentials to present to KMS — the release cannot even start.
        return Err(http_error(
            503,
            "attestation-gated runtime authorization materialization failed",
        ));
    };
    let plaintext = match state.kms.decrypt(&params) {
        Ok(bytes) => bytes,
        Err(_) => {
            return Err(http_error(
                503,
                "attestation-gated runtime authorization materialization failed",
            ))
        }
    };
    let envelope: Value = match serde_json::from_slice(&plaintext) {
        Ok(value) => value,
        Err(_) => {
            return Err(http_error(
                401,
                "runtime authorization KMS envelope is invalid",
            ))
        }
    };
    // JS `env.MORPHEUS_NETWORK || process.env.MORPHEUS_NETWORK` — the env map
    // wins only when it holds a non-empty (trimmed) string.
    let network_source = env
        .get("MORPHEUS_NETWORK")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| {
            state
                .overlay
                .read()
                .expect("overlay lock")
                .get_trimmed("MORPHEUS_NETWORK")
        });
    let provision_network = crate::normalize_network(network_source.as_deref());
    let token = envelope
        .get("token")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let version = envelope
        .get("version")
        .and_then(Value::as_i64)
        .filter(|version| *version >= 1);
    let network_ok = crate::normalize_network(envelope.get("network").and_then(Value::as_str))
        == provision_network;
    let purpose_ok =
        envelope.get("purpose").and_then(Value::as_str) == Some(RUNTIME_TOKEN_KMS_PURPOSE);
    let token_len = token.chars().count();
    let (Some(version), true, true, true) = (
        version.map(|version| version as u64),
        purpose_ok,
        network_ok,
        (32..=512).contains(&token_len),
    ) else {
        return Err(http_error(
            401,
            "runtime authorization KMS envelope context is invalid",
        ));
    };
    Ok(MaterializedToken { token, version })
}

/// The tokens /provision accepts: after a KMS-materialized token exists, ONLY
/// that token (rotation presents the current credential); before it, the
/// static trusted set from the token env keys.
fn current_provision_tokens(state: &AppState) -> Vec<String> {
    if state
        .runtime_token_kms_version
        .load(std::sync::atomic::Ordering::SeqCst)
        > 0
    {
        let token = state
            .overlay
            .read()
            .expect("overlay lock")
            .get_trimmed("MORPHEUS_RUNTIME_TOKEN");
        return token.into_iter().collect();
    }
    crate::auth::trusted_tokens(&state.overlay.read().expect("overlay lock"))
}

/// `assertProvisionAuthorized`. Returns the bootstrap token when this is the
/// first provision (trusted set empty, token released from the envelope and
/// matched against what was presented); `None` when the request authenticated
/// against the current token set like any other route.
pub fn assert_provision_authorized(
    state: &AppState,
    headers: &http::HeaderMap,
    payload: &Value,
) -> Result<Option<MaterializedToken>, RuntimeError> {
    let trusted = current_provision_tokens(state);
    if !trusted.is_empty() {
        let token = extract_request_token(headers);
        for trusted_token in &trusted {
            if timing_safe_token_match(&token, trusted_token) {
                return Ok(None);
            }
        }
        return Err(http_error(401, "unauthorized"));
    }
    let empty = serde_json::Map::new();
    let env = provision_env(payload).unwrap_or(&empty);
    let materialized = materialize_provision_runtime_token(state, env)?;
    if timing_safe_token_match(&extract_request_token(headers), &materialized.token) {
        return Ok(Some(materialized));
    }
    Err(http_error(401, "unauthorized"))
}

/// The per-role health the provision response carries (`signerRolesHealth`).
pub fn signer_roles_health(state: &AppState) -> Vec<Value> {
    let network = state.resolve_network();
    AppState::SIGNING_ROLES
        .iter()
        .map(|role| {
            let RoleReport {
                ok,
                materialized,
                identity,
                issues,
                key_source,
                ..
            } = state.signer.role_report(&network, role);
            serde_json::json!({
                "role": role,
                "ok": ok && materialized,
                "identity": identity,
                "issues": issues,
                "key_source": key_source,
            })
        })
        .collect()
}

/// The diagnostic KMS probe — outcome only, never plaintext. In the split the
/// host still owns this probe: it exercises the attestation-gated release path
/// (the prerequisite for every KMS-sealed key) without touching a live key.
/// Failure messages are the release flow's own (`AttestResult` strings); the
/// missing-credential strings are the ones `nitro_attest::kms` produces, so a
/// diag that cannot start reports exactly what the CLI would.
fn run_kms_diag(state: &AppState) -> Value {
    let overlay = state.overlay.read().expect("overlay lock");
    let Some(ciphertext) = overlay.get_trimmed("MORPHEUS_ORACLE_KMS_DIAG_CIPHERTEXT") else {
        return serde_json::json!({ "state": "no_diag_ciphertext" });
    };
    let region = overlay
        .get_trimmed("AWS_REGION")
        .or_else(|| overlay.get_trimmed("NITRO_AWS_REGION"))
        .unwrap_or_else(|| "us-east-1".to_string());
    let access_key_id = overlay.get_trimmed("AWS_ACCESS_KEY_ID");
    let secret_access_key = overlay.get_trimmed("AWS_SECRET_ACCESS_KEY");
    let session_token = overlay.get_trimmed("AWS_SESSION_TOKEN");
    drop(overlay);
    let Some(access_key_id) = access_key_id else {
        return serde_json::json!({ "state": "error", "message": "AWS_ACCESS_KEY_ID is not set" });
    };
    let Some(secret_access_key) = secret_access_key else {
        return serde_json::json!({ "state": "error", "message": "AWS_SECRET_ACCESS_KEY is not set" });
    };
    let params = KmsReleaseParams {
        region,
        ciphertext_b64: ciphertext,
        access_key_id,
        secret_access_key,
        session_token,
    };
    match state.kms.decrypt(&params) {
        Ok(_) => serde_json::json!({ "state": "ok" }),
        Err(message) => serde_json::json!({
            "state": "error",
            "message": message.chars().take(700).collect::<String>(),
        }),
    }
}

/// `handleProvision` — assumes `assert_provision_authorized` already ran.
/// `bootstrap` is the first-boot token the route materialized while
/// authorizing; rotations materialize their own newer envelope here.
pub fn handle_provision(
    state: &AppState,
    payload: &Value,
    bootstrap: Option<MaterializedToken>,
) -> Result<Value, RuntimeError> {
    let empty = serde_json::Map::new();
    let env = provision_env(payload).unwrap_or(&empty);

    // The plaintext refusal runs before anything else and lists every offender
    // at once, sorted — one deterministic refusal an operator can grep for.
    let mut rejected: Vec<&str> = env
        .iter()
        .filter(|(key, value)| {
            let value = value.as_str().map(str::trim).unwrap_or("");
            !value.is_empty()
                && (*key == "MORPHEUS_ALLOW_PLAINTEXT_KEY_PROVISION"
                    || TOKEN_ENV_KEYS.contains(&key.as_str())
                    || PLAINTEXT_KEY_ENV_KEYS.contains(&key.as_str()))
        })
        .map(|(key, _)| key.as_str())
        .collect();
    rejected.sort_unstable();
    if !rejected.is_empty() {
        return Err(http_error(
            403,
            format!(
                "plaintext key or runtime-token provisioning is permanently disabled; provide an attestation-gated \
                 *_KMS_CIPHERTEXT_BASE64 value instead. Rejected: {}",
                rejected.join(", ")
            ),
        ));
    }

    let ciphertext_present = env
        .get(RUNTIME_TOKEN_KMS_CIPHERTEXT_ENV)
        .and_then(Value::as_str)
        .map(str::trim)
        .is_some_and(|value| !value.is_empty());
    let next_runtime_token = if ciphertext_present {
        match bootstrap {
            Some(bootstrap) => Some(bootstrap),
            None => Some(materialize_provision_runtime_token(state, env)?),
        }
    } else {
        None
    };
    if let Some(next) = &next_runtime_token {
        let current = state
            .runtime_token_kms_version
            .load(std::sync::atomic::Ordering::SeqCst);
        if next.version <= current {
            return Err(http_error(
                409,
                "runtime authorization KMS envelope version must increase monotonically",
            ));
        }
    }

    let mut applied: Vec<String> = Vec::new();
    {
        let mut overlay = state.overlay.write().expect("overlay lock");
        for (key, value) in env {
            if overlay.apply(key, value) {
                applied.push(key.clone());
            }
        }
        if let Some(next) = &next_runtime_token {
            overlay.set_runtime_token(&next.token);
        }
    }
    if let Some(next) = &next_runtime_token {
        state
            .runtime_token_kms_version
            .store(next.version, std::sync::atomic::Ordering::SeqCst);
    }

    // The compute child's config surface is its boot env, so a provision
    // event replaces it with the merged overlay — the split's equivalent of
    // the merged server's `process.env` write reaching the worker handler.
    if let Some(child) = &state.bridge_child {
        let snapshot = state.overlay.read().expect("overlay lock").clone();
        child.respawn_for_provision(&snapshot);
    }

    let diag = run_kms_diag(state);
    *state.kms_diag.lock().expect("kms diag lock") = crate::state::KmsDiag { value: diag };

    let roles = signer_roles_health(state);
    let network = state.resolve_network();
    let status = if roles.iter().all(|role| role["ok"] == Value::Bool(true)) {
        "ok"
    } else {
        "degraded"
    };
    let mut env_keys = applied;
    env_keys.sort();

    Ok(serde_json::json!({
        "status": status,
        "runtime": crate::RUNTIME_NAME,
        "network": network,
        "provisioned": true,
        "env_keys": env_keys,
        "roles": roles,
    }))
}

#[cfg(test)]
#[path = "../tests/unit/provision.rs"]
mod tests;
