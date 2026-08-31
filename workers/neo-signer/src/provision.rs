//! How an enclave-born custody vault receives its master key.
//!
//! Inside the enclave there is no env file and no operator at a terminal: the
//! only ingress is vsock, so the ciphertext that the vault's master key is
//! released from has to arrive over HTTP after the process is up. `/provision`
//! is that one door, and this module is everything behind it.
//!
//! The rules it enforces are RC2 from `deploy/nitro/TEE-CONFIDENTIALITY-GAPS.md`
//! and §7 step 3:
//!
//! * A plaintext `SIGNER_SERVICE_MASTER_KEY` in the provisioned environment is
//!   refused outright, with its own response code. The master key is either
//!   released by the attested KMS path or it does not exist.
//! * The provisioned environment is a whitelist. Everything the KMS path needs
//!   — the two ciphertext blobs, the AWS credentials the host fetched from
//!   IMDS, the region — is named; anything else is refused, so a host cannot
//!   smuggle configuration into the enclave by adding keys.
//! * The presented transport token is checked against a KMS-released envelope
//!   (constant-time, digest-based like the caller tokens in `auth`), not
//!   against a plaintext value that crossed the same channel it guards.
//! * Provisioning happens once per boot. When the vault is already open the
//!   route answers 409, and it stays refused for the life of the process.
//!
//! Between boot and provision the service answers `/health` with
//! `{"status":"unprovisioned"}` and every custody route with
//! `signer-not-provisioned`. There is deliberately no audit row for a refused
//! custody call in that window — the vault the audit trail lives in is not
//! open yet — which is one more reason the window is as short as the start
//! script can make it.

use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};

use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::{service::SignerService, store::Store, vault::MasterKey};

/// The base64 KMS ciphertext the transport token envelope is released from.
pub const TOKEN_CIPHERTEXT_ENV: &str = "MORPHEUS_RUNTIME_TOKEN_KMS_CIPHERTEXT_BASE64";

/// The base64 KMS ciphertext the vault's master key is released from. When it
/// is absent the vault falls back to the enclave-born master key file — an
/// operator's explicit choice, with the rootfs-persistence caveat in the
/// runbook.
pub const MASTER_KEY_CIPHERTEXT_ENV: &str = "SIGNER_SERVICE_MASTER_KEY_KMS_CIPHERTEXT";

/// Region override, falling back through the standard AWS names.
pub const REGION_ENV: &str = "SIGNER_SERVICE_KMS_REGION";

/// The only environment keys a provision body may carry.
const ALLOWED_ENV_KEYS: &[&str] = &[
    TOKEN_CIPHERTEXT_ENV,
    MASTER_KEY_CIPHERTEXT_ENV,
    REGION_ENV,
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_REGION",
    "AWS_DEFAULT_REGION",
];

/// The raw `/provision` body.
#[derive(Deserialize)]
pub struct ProvisionBody {
    pub env: serde_json::Map<String, serde_json::Value>,
}

/// The provisioned environment as an ordered string map — the whitelist's
/// subject, and the only configuration the release path may read.
pub struct ProvisionEnv {
    fields: Vec<(String, String)>,
}

impl ProvisionEnv {
    /// Validate the raw body: every key on the whitelist, every value a
    /// string. The plaintext master key is refused before anything else so its
    /// specific error is the one an operator sees.
    pub fn from_body(body: ProvisionBody) -> Result<Self, ProvisionError> {
        if body.env.contains_key("SIGNER_SERVICE_MASTER_KEY") {
            return Err(ProvisionError::PlaintextMasterKey);
        }
        let mut fields = Vec::with_capacity(body.env.len());
        for (name, value) in body.env {
            if !ALLOWED_ENV_KEYS.contains(&name.as_str()) {
                return Err(ProvisionError::UnknownKey(name));
            }
            let value = match value {
                serde_json::Value::String(value) => value,
                _ => return Err(ProvisionError::NotAString(name)),
            };
            if value.is_empty() {
                return Err(ProvisionError::EmptyValue(name));
            }
            fields.push((name, value));
        }
        Ok(ProvisionEnv { fields })
    }

    pub fn get(&self, name: &str) -> Option<&str> {
        self.fields
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }

    fn required(&self, name: &'static str) -> Result<&str, ProvisionError> {
        self.get(name).ok_or(ProvisionError::MissingField(name))
    }

    /// The region the KMS call targets, resolved the way the AWS tooling
    /// resolves it: explicit override, then the standard variables.
    fn region(&self) -> Result<&str, ProvisionError> {
        for name in [REGION_ENV, "AWS_REGION", "AWS_DEFAULT_REGION"] {
            if let Some(value) = self.get(name) {
                return Ok(value);
            }
        }
        Err(ProvisionError::MissingField(REGION_ENV))
    }

    /// The static AWS credentials the start script fetched from IMDSv2.
    fn credentials(&self) -> Result<nitro_attest::kms::Credentials, ProvisionError> {
        Ok(nitro_attest::kms::Credentials {
            access_key_id: self.required("AWS_ACCESS_KEY_ID")?.to_string(),
            secret_access_key: self.required("AWS_SECRET_ACCESS_KEY")?.to_string(),
            session_token: self.get("AWS_SESSION_TOKEN").map(str::to_string),
        })
    }
}

/// What goes wrong with a provision attempt, with the HTTP status the route
/// answers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProvisionError {
    /// A plaintext `SIGNER_SERVICE_MASTER_KEY` crossed the channel. RC2's
    /// bright line; `403`.
    PlaintextMasterKey,
    /// A key outside the whitelist. `400`.
    UnknownKey(String),
    /// A whitelist key whose value is not a JSON string. `400`.
    NotAString(String),
    /// A whitelist key whose value is empty. `400`.
    EmptyValue(String),
    /// A required whitelist key is absent. `400`.
    MissingField(&'static str),
    /// The presented transport token does not match its KMS-released
    /// envelope. `401`.
    TokenMismatch,
    /// The KMS release itself failed. `503`.
    Release(String),
}

impl ProvisionError {
    /// `(code, status, message)` as the route answers it.
    pub fn answer(&self) -> (&'static str, u16, String) {
        match self {
            ProvisionError::PlaintextMasterKey => (
                "signer-provision-forbidden",
                403,
                "a plaintext SIGNER_SERVICE_MASTER_KEY is refused in an attested deployment; \
                 the master key is released through the attested KMS path or it does not exist"
                    .to_string(),
            ),
            ProvisionError::UnknownKey(name) => (
                "signer-provision-invalid",
                400,
                format!("provisioned environment key `{name}` is not on the whitelist"),
            ),
            ProvisionError::NotAString(name) => (
                "signer-provision-invalid",
                400,
                format!("provisioned environment key `{name}` must be a string"),
            ),
            ProvisionError::EmptyValue(name) => (
                "signer-provision-invalid",
                400,
                format!("provisioned environment key `{name}` must not be empty"),
            ),
            ProvisionError::MissingField(name) => (
                "signer-provision-invalid",
                400,
                format!("provisioned environment is missing `{name}`"),
            ),
            ProvisionError::TokenMismatch => (
                "signer-provision-unauthorized",
                401,
                "the presented transport token does not match its released envelope".to_string(),
            ),
            ProvisionError::Release(detail) => (
                "signer-provision-failed",
                503,
                format!("the attested KMS release failed: {detail}"),
            ),
        }
    }
}

/// Releases a KMS-sealed envelope named by its ciphertext. Production builds
/// the [`release_envelope`] closure; tests substitute canned bytes, which is
/// what keeps every rule above exercisable without an NSM device.
pub type EnvelopeReleaser =
    Arc<dyn Fn(&ProvisionEnv, &str) -> Result<Vec<u8>, String> + Send + Sync>;

/// The enclave side of the route: the still-sealed vault plus the one gate it
/// opens through. Held in `Arc` so the handler can clone it out of the router
/// state and run the (blocking) release off the async workers.
pub struct ProvisionGate {
    /// The database, opened at boot — only its rows are sealed; opening it
    /// needed no key.
    pub repository: Store,
    /// Where an enclave-born master key file would be created.
    pub data_dir: PathBuf,
    pub releaser: EnvelopeReleaser,
    /// Serializes concurrent provisions so two simultaneous calls cannot both
    /// walk the release path; the route's final state flip is separately
    /// guarded by the vault's write lock.
    pub mutex: Mutex<()>,
}

/// The production release path: a fresh NSM attestation binding a single-use
/// RSA keypair, KMS Decrypt, CMS open — all in-process, no helper binary.
pub fn release_envelope(env: &ProvisionEnv, ciphertext_b64: &str) -> Result<Vec<u8>, String> {
    let credentials = env
        .credentials()
        .map_err(|error| format!("provisioned environment: {:?}", error))?;
    let params = nitro_attest::release::ReleaseParams {
        region: env.region().map_err(|error| format!("{error:?}"))?,
        credentials: &credentials,
        ciphertext_b64,
        amz_date: &nitro_attest::kms::utc_amz_date_now(),
    };
    nitro_attest::release::release_bytes(
        &nitro_attest::release::NsmAttestation,
        &nitro_attest::release::HttpKmsTransport,
        &params,
    )
}

/// The whole provision transaction: validate, check the transport token,
/// release the master key, open the vault. On success the caller moves the
/// router state to provisioned; this function has already handed back a
/// service that can sign.
pub fn run(
    gate: &ProvisionGate,
    env: &ProvisionEnv,
    presented_token: Option<&str>,
) -> Result<SignerService, ProvisionError> {
    let _guard = gate.mutex.lock().map_err(|_| {
        ProvisionError::Release("the provision lock is poisoned; restart the service".to_string())
    })?;

    // The transport token: released through the same attested path the master
    // key will take, then compared in constant time. A plaintext token in the
    // provisioned environment is not on the whitelist, so there is no fallback
    // to check against.
    let token_ciphertext = env.required(TOKEN_CIPHERTEXT_ENV)?;
    let released = (gate.releaser)(env, token_ciphertext).map_err(ProvisionError::Release)?;
    let expected = std::str::from_utf8(&released)
        .map_err(|_| ProvisionError::Release("the released transport token is not UTF-8".into()))?;
    let presented = presented_token.unwrap_or("");
    if !tokens_equal(presented, expected) {
        return Err(ProvisionError::TokenMismatch);
    }

    // The master key: released, or enclave-born when no ciphertext was
    // provisioned. The plaintext-env refusal already happened in
    // `ProvisionEnv::from_body`, and the process-level refusal happened at
    // boot — a host-supplied key has two locked doors in front of it.
    let master_key = match env.get(MASTER_KEY_CIPHERTEXT_ENV) {
        Some(ciphertext) => {
            let released = (gate.releaser)(env, ciphertext).map_err(ProvisionError::Release)?;
            let bytes: [u8; 32] = released.as_slice().try_into().map_err(|_| {
                ProvisionError::Release(format!(
                    "the released master key is {} bytes, expected 32",
                    released.len()
                ))
            })?;
            MasterKey::from_bytes(bytes)
        }
        None => MasterKey::open(&gate.data_dir).map_err(|error| {
            ProvisionError::Release(format!("enclave-born master key: {error}"))
        })?,
    };
    Ok(SignerService::new(gate.repository.clone(), master_key))
}

/// Constant-time digest comparison, the same shape `auth` uses for caller
/// tokens: compare SHA-256 outputs so neither length nor shared prefix leaks.
fn tokens_equal(presented: &str, expected: &str) -> bool {
    let a = Sha256::digest(presented.as_bytes());
    let b = Sha256::digest(expected.as_bytes());
    a.iter()
        .zip(b.iter())
        .fold(0u8, |acc, (x, y)| acc | (x ^ y))
        == 0
}

#[cfg(test)]
#[path = "../tests/unit/provision.rs"]
mod tests;
