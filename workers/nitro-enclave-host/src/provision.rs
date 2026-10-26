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
//! * **Provisioning is one-shot.** A second call is a 409 even when it carries
//!   the current token. Temporary AWS credentials rotate only through the
//!   separately authenticated `/provision/credentials` route.
//! * **Plaintext provisioning is permanently refused** (403): a compromised
//!   host must not be able to inject a known signer key in one request. The
//!   rejected names are sorted so the refusal is deterministic and greppable.
//!
//! X25519 and NeoDID ciphertexts are materialized here through the same
//! recipient-attested release seam as the runtime token. Their plaintext is
//! validated against purpose/network/version envelopes and installed only in
//! the in-memory overlay under internal source markers.

use serde_json::Value;

use crate::auth::{
    extract_request_token, timing_safe_token_match, RUNTIME_TOKEN_KMS_CIPHERTEXT_ENV,
    RUNTIME_TOKEN_KMS_PURPOSE, TOKEN_ENV_KEYS,
};
use crate::http_error;
use crate::overlay::{is_provisionable_name, CREDENTIAL_NAMES};
use crate::state::{AppState, KmsReleaseParams, RoleReport};
use crate::RuntimeError;

pub const ORACLE_KMS_CIPHERTEXT_ENV: &str = "MORPHEUS_ORACLE_KMS_CIPHERTEXT_BASE64";
pub const ORACLE_KMS_PURPOSE: &str = "neoos/oracle-x25519/v1";
pub const NEODID_KMS_CIPHERTEXT_ENV: &str = "MORPHEUS_NEODID_SALT_KMS_CIPHERTEXT_BASE64";
pub const NEODID_KMS_PURPOSE: &str = "neoos/neodid-salt/v1";
pub const CUSTODY_TOKEN_KMS_CIPHERTEXT_ENV: &str = "SIGNER_SERVICE_TOKEN_KMS_CIPHERTEXT_BASE64";
pub const CUSTODY_TOKEN_KMS_PURPOSE: &str = "neoos/custody-caller-token/v1";
pub const GAME_SECRET_KMS_CIPHERTEXT_ENV: &str = "MORPHEUS_GAME_SECRET_KMS_CIPHERTEXT_BASE64";
pub const GAME_SECRET_KMS_PURPOSE: &str = "neoos/game-secret/v1";

/// Plaintext signing-key env vars a host could otherwise inject via /provision
/// to bypass the KMS-attested path. The `*_KMS_CIPHERTEXT_BASE64` variants are
/// accepted because the host only ever holds ciphertext. Ported verbatim from
/// `PLAINTEXT_KEY_ENV_KEYS`.
pub const PLAINTEXT_KEY_ENV_KEYS: [&str; 22] = [
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
    // Game-session HMAC root (non-signing, but just as confidential).
    "MORPHEUS_GAME_SECRET_ROOT_HEX",
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

/// The pinned CMK ARN every frontier KMS release must name. Deliberately
/// ABSENT from [`crate::overlay::PROVISIONABLE_NAMES`]: it belongs to the
/// measured image (a `deploy/nitro/Dockerfile.enclave` ENV, which lands in
/// PCR2), so `/provision` cannot restate it and a compromised parent cannot
/// redirect a release to a CMK it controls.
pub const FRONTIER_KMS_KEY_ARN_ENV: &str = "FRONTIER_KMS_KEY_ARN";

/// The diagnostic probe's own purpose. It exercises the release path without
/// touching a live key, so it gets its own encryption context rather than
/// borrowing a secret's.
pub const KMS_DIAG_PURPOSE: &str = "neoos/kms-diag/v1";

/// Is this process running with `NODE_ENV=production`? Read from the overlay
/// (image ENV, since NODE_ENV is not provisionable) exactly as
/// `custody.rs::config` reads it.
fn is_production(state: &AppState) -> bool {
    state
        .overlay
        .read()
        .expect("overlay lock")
        .get_trimmed("NODE_ENV")
        .is_some_and(|value| value.eq_ignore_ascii_case("production"))
}

/// The image-owned CMK pin. `Ok(None)` is a local dry run; production has no
/// such mode — an unpinned release there is exactly the substitution this
/// binding exists to prevent, so it fails closed.
fn frontier_kms_key_arn(state: &AppState) -> Result<Option<String>, ()> {
    let pinned = state
        .overlay
        .read()
        .expect("overlay lock")
        .get_trimmed(FRONTIER_KMS_KEY_ARN_ENV);
    match pinned {
        Some(arn) => Ok(Some(arn)),
        None if is_production(state) => Err(()),
        None => Ok(None),
    }
}

/// The KMS inputs the release path carries — region resolved the way
/// `materializeProvisionRuntimeToken` resolves it, credentials from the
/// payload env or the accumulated overlay (never the raw process env), and
/// the three image-owned bindings (`purpose`, network, CMK) the parent does
/// not get to choose.
fn kms_release_params(
    state: &AppState,
    env: &serde_json::Map<String, Value>,
    ciphertext_b64: &str,
    purpose: &str,
) -> Option<KmsReleaseParams> {
    let region = provisioned_or_current(state, env, "AWS_REGION")
        .or_else(|| provisioned_or_current(state, env, "NITRO_AWS_REGION"))
        .unwrap_or_else(|| "us-east-1".to_string());
    let access_key_id = provisioned_or_current(state, env, "AWS_ACCESS_KEY_ID")?;
    let secret_access_key = provisioned_or_current(state, env, "AWS_SECRET_ACCESS_KEY")?;
    let session_token = provisioned_or_current(state, env, "AWS_SESSION_TOKEN");
    let key_arn = frontier_kms_key_arn(state).ok()?;
    Some(KmsReleaseParams {
        region,
        ciphertext_b64: ciphertext_b64.to_string(),
        access_key_id,
        secret_access_key,
        session_token,
        purpose: purpose.to_string(),
        network: state.resolve_network().ok()?,
        key_arn,
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
    let Some(params) = kms_release_params(state, env, ciphertext, RUNTIME_TOKEN_KMS_PURPOSE) else {
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
    // Network is image-owned. Letting the untrusted parent restate it here
    // would allow a valid testnet envelope to authorize a mainnet process.
    let provision_network = state.resolve_network()?;
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
        .is_ok_and(|network| network == provision_network);
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

pub(crate) fn release_context_envelope(
    state: &AppState,
    env: &serde_json::Map<String, Value>,
    ciphertext_env: &str,
    expected_purpose: &str,
) -> Result<Option<Value>, RuntimeError> {
    let Some(ciphertext) = env
        .get(ciphertext_env)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };
    let params = kms_release_params(state, env, ciphertext, expected_purpose).ok_or_else(|| {
        http_error(
            503,
            format!("attestation-gated {ciphertext_env} materialization failed"),
        )
    })?;
    let plaintext = state.kms.decrypt(&params).map_err(|_| {
        http_error(
            503,
            format!("attestation-gated {ciphertext_env} materialization failed"),
        )
    })?;
    let envelope: Value = serde_json::from_slice(&plaintext)
        .map_err(|_| http_error(400, format!("{ciphertext_env} KMS envelope is invalid")))?;
    let version_ok = envelope
        .get("version")
        .and_then(Value::as_u64)
        .is_some_and(|version| version > 0);
    let purpose_ok = envelope.get("purpose").and_then(Value::as_str) == Some(expected_purpose);
    let provision_network = state.resolve_network()?;
    let network_ok = crate::normalize_network(envelope.get("network").and_then(Value::as_str))
        .is_ok_and(|network| network == provision_network);
    if !(version_ok && purpose_ok && network_ok) {
        return Err(http_error(
            400,
            format!("{ciphertext_env} KMS envelope context is invalid"),
        ));
    }
    Ok(Some(envelope))
}

fn materialize_oracle_key(
    state: &AppState,
    env: &serde_json::Map<String, Value>,
) -> Result<Option<String>, RuntimeError> {
    let Some(envelope) =
        release_context_envelope(state, env, ORACLE_KMS_CIPHERTEXT_ENV, ORACLE_KMS_PURPOSE)?
    else {
        return Ok(None);
    };
    let material = envelope
        .get("key_material")
        .cloned()
        .filter(Value::is_object)
        .ok_or_else(|| {
            http_error(
                400,
                format!("{ORACLE_KMS_CIPHERTEXT_ENV} KMS envelope key_material is invalid"),
            )
        })?;
    let material_json = serde_json::to_string(&material).expect("JSON value serializes");
    let lookup = |name: &str| match name {
        "MORPHEUS_ORACLE_KEY_MATERIAL_JSON" => Some(material_json.clone()),
        "MORPHEUS_ORACLE_KEY_SOURCE" => Some("nitro-recipient-kms".to_string()),
        _ => None,
    };
    let parsed = neo_os_compute::oracle::crypto::parse_configured_oracle_key_material(&lookup)
        .map_err(|_| {
            http_error(
                400,
                format!("{ORACLE_KMS_CIPHERTEXT_ENV} KMS envelope key_material is invalid"),
            )
        })?
        .ok_or_else(|| {
            http_error(
                400,
                format!("{ORACLE_KMS_CIPHERTEXT_ENV} KMS envelope key_material is invalid"),
            )
        })?;
    neo_os_compute::oracle::crypto::validate_oracle_key_material(&parsed).map_err(|_| {
        http_error(
            400,
            format!("{ORACLE_KMS_CIPHERTEXT_ENV} KMS envelope key_material is invalid"),
        )
    })?;
    Ok(Some(material_json))
}

fn materialize_neodid_salt(
    state: &AppState,
    env: &serde_json::Map<String, Value>,
) -> Result<Option<String>, RuntimeError> {
    let Some(envelope) =
        release_context_envelope(state, env, NEODID_KMS_CIPHERTEXT_ENV, NEODID_KMS_PURPOSE)?
    else {
        return Ok(None);
    };
    let salt = envelope
        .get("salt")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|salt| (32..=1024).contains(&salt.len()))
        .ok_or_else(|| {
            http_error(
                400,
                format!("{NEODID_KMS_CIPHERTEXT_ENV} KMS envelope salt is invalid"),
            )
        })?;
    Ok(Some(salt.to_string()))
}

/// The custody caller credentials the envelope carries: the mandatory
/// `raw_sign` token and, optionally, the `sign`-capability token the semantic
/// lanes need (SVC-B-2). Both travel inside ONE envelope under one purpose
/// and one encryption context, so the second credential costs no new
/// ciphertext, no new provisionable name and no new production marker.
pub struct CustodyCallerTokens {
    pub raw: String,
    pub semantic: Option<String>,
}

fn materialize_custody_token(
    state: &AppState,
    env: &serde_json::Map<String, Value>,
) -> Result<Option<CustodyCallerTokens>, RuntimeError> {
    let Some(envelope) = release_context_envelope(
        state,
        env,
        CUSTODY_TOKEN_KMS_CIPHERTEXT_ENV,
        CUSTODY_TOKEN_KMS_PURPOSE,
    )?
    else {
        return Ok(None);
    };
    let read_token = |field: &str| -> Option<&str> {
        envelope
            .get(field)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|token| (32..=512).contains(&token.chars().count()))
    };
    let raw = read_token("token").ok_or_else(|| {
        http_error(
            400,
            format!("{CUSTODY_TOKEN_KMS_CIPHERTEXT_ENV} KMS envelope token is invalid"),
        )
    })?;
    // Present-but-malformed is a refusal, not a silent fall back to the raw
    // token: an operator who meant to provision the semantic caller must not
    // discover the typo as a production 403 on the NeoX fulfilment lane.
    let semantic = match envelope.get("semantic_token") {
        None | Some(Value::Null) => None,
        Some(_) => Some(read_token("semantic_token").ok_or_else(|| {
            http_error(
                400,
                format!(
                    "{CUSTODY_TOKEN_KMS_CIPHERTEXT_ENV} KMS envelope semantic_token is invalid"
                ),
            )
        })?),
    };
    Ok(Some(CustodyCallerTokens {
        raw: raw.to_string(),
        semantic: semantic.map(str::to_string),
    }))
}

fn materialize_game_secret_root(
    state: &AppState,
    env: &serde_json::Map<String, Value>,
) -> Result<Option<String>, RuntimeError> {
    let Some(envelope) = release_context_envelope(
        state,
        env,
        GAME_SECRET_KMS_CIPHERTEXT_ENV,
        GAME_SECRET_KMS_PURPOSE,
    )?
    else {
        return Ok(None);
    };
    let root = envelope
        .get("secret_root_hex")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|root| root.len() == 64 && root.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .ok_or_else(|| {
            http_error(
                400,
                format!("{GAME_SECRET_KMS_CIPHERTEXT_ENV} KMS envelope secret_root_hex is invalid"),
            )
        })?;
    Ok(Some(root.to_ascii_lowercase()))
}

/// Validate the complete provisioning object before any KMS or state effect.
fn validate_provision_env(env: &serde_json::Map<String, Value>) -> Result<(), RuntimeError> {
    let mut plaintext: Vec<&str> = env
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
    plaintext.sort_unstable();
    if !plaintext.is_empty() {
        return Err(http_error(
            403,
            format!(
                "plaintext key or runtime-token provisioning is permanently disabled; provide an attestation-gated \
                 *_KMS_CIPHERTEXT_BASE64 value instead. Rejected: {}",
                plaintext.join(", ")
            ),
        ));
    }

    let mut unknown: Vec<&str> = env
        .keys()
        .filter(|key| !is_provisionable_name(key))
        .map(String::as_str)
        .collect();
    unknown.sort_unstable();
    if !unknown.is_empty() {
        return Err(http_error(
            400,
            format!(
                "provision env contains non-allowlisted names: {}",
                unknown.join(", ")
            ),
        ));
    }

    let mut invalid: Vec<&str> = env
        .iter()
        .filter(|(_, value)| value.as_str().map(str::trim).is_none_or(str::is_empty))
        .map(|(key, _)| key.as_str())
        .collect();
    invalid.sort_unstable();
    if !invalid.is_empty() {
        return Err(http_error(
            400,
            format!(
                "provision env values must be non-empty strings: {}",
                invalid.join(", ")
            ),
        ));
    }
    Ok(())
}

/// `assertProvisionAuthorized`. The first call is authorized only by the
/// token released from its own KMS envelope. Existing image tokens never
/// authorize bootstrap, and a provisioned instance cannot rotate through this
/// route.
pub fn assert_provision_authorized(
    state: &AppState,
    headers: &http::HeaderMap,
    payload: &Value,
) -> Result<Option<MaterializedToken>, RuntimeError> {
    let empty = serde_json::Map::new();
    let env = provision_env(payload).unwrap_or(&empty);
    validate_provision_env(env)?;
    if state
        .runtime_token_kms_version
        .load(std::sync::atomic::Ordering::SeqCst)
        > 0
    {
        crate::auth::assert_authorized(&state.overlay.read().expect("overlay lock"), headers)?;
        return Err(http_error(409, "provisioning is one-shot per enclave boot"));
    }
    let materialized = materialize_provision_runtime_token(state, env)?;
    if timing_safe_token_match(&extract_request_token(headers), &materialized.token) {
        return Ok(Some(materialized));
    }
    Err(http_error(401, "unauthorized"))
}

/// The per-role health the provision response carries (`signerRolesHealth`).
pub fn signer_roles_health(state: &AppState) -> Result<Vec<Value>, RuntimeError> {
    Ok(state
        .signing_role_reports()?
        .into_iter()
        .map(|(role, report)| {
            let RoleReport {
                ok,
                materialized,
                identity,
                issues,
                key_source,
                ..
            } = report;
            serde_json::json!({
                "role": role,
                "ok": ok && materialized,
                "identity": identity,
                "issues": issues,
                "key_source": key_source,
            })
        })
        .collect())
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
    let key_arn = match frontier_kms_key_arn(state) {
        Ok(key_arn) => key_arn,
        Err(()) => {
            return serde_json::json!({
                "state": "error",
                "message": format!("{FRONTIER_KMS_KEY_ARN_ENV} is not set"),
            })
        }
    };
    let params = KmsReleaseParams {
        region,
        ciphertext_b64: ciphertext,
        access_key_id,
        secret_access_key,
        session_token,
        purpose: KMS_DIAG_PURPOSE.to_string(),
        network: match state.resolve_network() {
            Ok(network) => network,
            Err(error) => {
                return serde_json::json!({ "state": "error", "message": error.message });
            }
        },
        key_arn,
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
    validate_provision_env(env)?;
    if state
        .runtime_token_kms_version
        .load(std::sync::atomic::Ordering::SeqCst)
        > 0
    {
        return Err(http_error(409, "provisioning is one-shot per enclave boot"));
    }
    let next_runtime_token = bootstrap
        .ok_or_else(|| http_error(500, "provision bootstrap token was not materialized"))?;

    // Release and validate every optional confidential envelope before
    // mutating state, so one bad ciphertext cannot leave a half-provisioned
    // frontier.
    let oracle_key = materialize_oracle_key(state, env)?;
    let neodid_salt = materialize_neodid_salt(state, env)?;
    let custody_token = materialize_custody_token(state, env)?;
    let game_secret_root = materialize_game_secret_root(state, env)?;
    #[cfg(feature = "embedded-relayer")]
    let relayer_credential = crate::relayer_auth::materialize(state, env)?;
    #[cfg(not(feature = "embedded-relayer"))]
    if env.contains_key("MORPHEUS_RELAYER_AUTH_KMS_CIPHERTEXT_BASE64") {
        return Err(http_error(
            503,
            "this image does not include the embedded relayer",
        ));
    }

    let mut applied: Vec<String> = Vec::new();
    {
        let mut overlay = state.overlay.write().expect("overlay lock");
        // Serialize initial provisioning with credential refresh and another
        // initial request; no rejected envelope may leave a partial install.
        if state
            .runtime_token_kms_version
            .load(std::sync::atomic::Ordering::SeqCst)
            > 0
        {
            return Err(http_error(409, "provisioning is one-shot per enclave boot"));
        }
        #[cfg(feature = "embedded-relayer")]
        if let Some(credential) = relayer_credential {
            overlay
                .install_relayer_auth(credential)
                .map_err(|e| http_error(409, e))?;
        }
        for (key, value) in env {
            if overlay.apply(key, value) {
                applied.push(key.clone());
            }
        }
        overlay.set_runtime_token(&next_runtime_token.token);
        if let Some(tokens) = &custody_token {
            overlay.set_custody_token(&tokens.raw, tokens.semantic.as_deref());
        }
        if let Some(material) = &oracle_key {
            overlay.set_oracle_key_material(material);
        }
        if let Some(salt) = &neodid_salt {
            overlay.set_neodid_salt(salt);
        }
        if let Some(secret_root) = &game_secret_root {
            overlay.set_game_secret_root(secret_root);
        }
        state.runtime_token_kms_version.store(
            next_runtime_token.version,
            std::sync::atomic::Ordering::SeqCst,
        );
    }

    let diag = run_kms_diag(state);
    *state.kms_diag.lock().expect("kms diag lock") = crate::state::KmsDiag { value: diag };

    let roles = signer_roles_health(state)?;
    let network = state.resolve_network()?;
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

/// Rotate only temporary AWS credentials after one-shot provisioning.
pub fn handle_provision_credentials(
    state: &AppState,
    payload: &Value,
) -> Result<Value, RuntimeError> {
    if state
        .runtime_token_kms_version
        .load(std::sync::atomic::Ordering::SeqCst)
        == 0
    {
        return Err(http_error(409, "runtime must be provisioned first"));
    }
    let env = provision_env(payload)
        .ok_or_else(|| http_error(400, "credential provision requires an env object"))?;
    let mut unknown: Vec<&str> = env
        .keys()
        .filter(|key| !CREDENTIAL_NAMES.contains(&key.as_str()))
        .map(String::as_str)
        .collect();
    unknown.sort_unstable();
    if !unknown.is_empty() {
        return Err(http_error(
            400,
            format!(
                "credential provision contains non-credential names: {}",
                unknown.join(", ")
            ),
        ));
    }
    let missing: Vec<&str> = CREDENTIAL_NAMES
        .iter()
        .copied()
        .filter(|key| {
            env.get(*key)
                .and_then(Value::as_str)
                .map(str::trim)
                .is_none_or(str::is_empty)
        })
        .collect();
    if !missing.is_empty() {
        return Err(http_error(
            400,
            format!(
                "credential provision requires non-empty {}",
                missing.join(", ")
            ),
        ));
    }
    let mut applied = Vec::new();
    {
        let mut overlay = state.overlay.write().expect("overlay lock");
        for key in CREDENTIAL_NAMES {
            if overlay.apply(key, env.get(key).expect("validated credential")) {
                applied.push(key);
            }
        }
    }
    Ok(serde_json::json!({
        "status": "ok",
        "runtime": crate::RUNTIME_NAME,
        "credentials_rotated": true,
        "env_keys": applied,
    }))
}

#[cfg(test)]
#[path = "../tests/unit/provision.rs"]
mod tests;
