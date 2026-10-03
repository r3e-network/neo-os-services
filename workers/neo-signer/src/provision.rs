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
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use serde::Deserialize;
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::{
    coordinator::{self, AwsCredentials},
    service::SignerService,
    vault::MasterKey,
    vault_profile::ValidatedVaultProfile,
};

/// The base64 KMS ciphertext the transport token envelope is released from.
pub const TOKEN_CIPHERTEXT_ENV: &str = "MORPHEUS_RUNTIME_TOKEN_KMS_CIPHERTEXT_BASE64";

/// Required base64 KMS ciphertext for the vault master key. Attested provision
/// never falls back to a host-supplied or enclave-local master key.
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
#[serde(deny_unknown_fields)]
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

    fn coordinator_credentials(&self) -> Result<AwsCredentials, ProvisionError> {
        let credentials = self.credentials()?;
        Ok(AwsCredentials {
            access_key_id: credentials.access_key_id,
            secret_access_key: credentials.secret_access_key,
            session_token: credentials.session_token,
        })
    }
}

/// What goes wrong with a provision attempt, with the HTTP status the route
/// answers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProvisionError {
    /// Another attempt already opened the vault. `409`.
    AlreadyProvisioned,
    /// Another blocking task owns initialization. `503`.
    InProgress,
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
    /// The two different purposes name the same ciphertext. `400`.
    ReusedCiphertext,
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
            ProvisionError::AlreadyProvisioned => (
                "signer-provision-already-done",
                409,
                "the vault is already provisioned; provisioning happens once per boot".to_string(),
            ),
            ProvisionError::InProgress => (
                "signer-service-busy",
                503,
                "another provision attempt is in progress".to_string(),
            ),
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
            ProvisionError::ReusedCiphertext => (
                "signer-provision-invalid",
                400,
                "transport token and master key require distinct purpose-bound ciphertexts"
                    .to_string(),
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
pub type EnvelopeReleaser = Arc<
    dyn Fn(&ProvisionEnv, &str, EnvelopePurpose) -> Result<Zeroizing<Vec<u8>>, String>
        + Send
        + Sync,
>;

pub type VaultRecoverer = Arc<
    dyn Fn(
            Arc<ValidatedVaultProfile>,
            AwsCredentials,
            MasterKey,
            &Path,
        ) -> Result<SignerService, String>
        + Send
        + Sync,
>;

/// Selected only by enclave code. The host cannot choose the KMS purpose.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EnvelopePurpose {
    TransportToken,
    MasterKey,
}

impl EnvelopePurpose {
    fn encryption_context(self) -> [(&'static str, &'static str); 2] {
        [
            ("neoos:component", "custody"),
            (
                "neoos:purpose",
                match self {
                    Self::TransportToken => "transport-token/v1",
                    Self::MasterKey => "master-key/v1",
                },
            ),
        ]
    }
}

/// The enclave side of the route: the still-sealed vault plus the one gate it
/// opens through. Held in `Arc` so the handler can clone it out of the router
/// state and run the (blocking) release off the async workers.
pub struct ProvisionGate {
    /// The database path remains unopened until the authenticated remote HEAD
    /// has selected genesis or an exact immutable snapshot restore.
    pub database_path: PathBuf,
    /// The enclave-local data directory; never a source of provisioned keys.
    pub data_dir: PathBuf,
    /// Immutable, measured identity of this vault. It supplies every KMS
    /// binding and the expected root-key commitment.
    pub profile: Arc<ValidatedVaultProfile>,
    pub releaser: EnvelopeReleaser,
    pub recoverer: VaultRecoverer,
    /// Serializes direct release calls. The API's Provisioning state owns the
    /// wider lifecycle, including publication after this lock is released.
    pub mutex: Mutex<()>,
}

/// The production release path: a fresh NSM attestation binding a single-use
/// RSA keypair, KMS Decrypt, CMS open — all in-process, no helper binary.
fn release_envelope(
    profile: &ValidatedVaultProfile,
    env: &ProvisionEnv,
    ciphertext_b64: &str,
    purpose: EnvelopePurpose,
) -> Result<Zeroizing<Vec<u8>>, String> {
    release_envelope_with(
        profile,
        env,
        ciphertext_b64,
        purpose,
        &nitro_attest::release::NsmAttestation,
        &nitro_attest::release::HttpKmsTransport,
    )
}

fn release_envelope_with(
    profile: &ValidatedVaultProfile,
    env: &ProvisionEnv,
    ciphertext_b64: &str,
    purpose: EnvelopePurpose,
    source: &dyn nitro_attest::release::AttestationSource,
    transport: &dyn nitro_attest::release::KmsTransport,
) -> Result<Zeroizing<Vec<u8>>, String> {
    let requested_region = env.region().map_err(|error| format!("{error:?}"))?;
    let profile_region = profile.document().coordinator.aws_region.as_str();
    if requested_region != profile_region {
        return Err(
            "the provisioned KMS region does not match the immutable vault profile".to_string(),
        );
    }
    let credentials = env
        .credentials()
        .map_err(|error| format!("provisioned environment: {:?}", error))?;
    let params = nitro_attest::release::ReleaseParams {
        region: profile_region,
        credentials: &credentials,
        ciphertext_b64,
        amz_date: &nitro_attest::kms::utc_amz_date_now(),
    };
    let profile_hash = hex::encode(profile.profile_hash());
    let network_set_hash = hex::encode(profile.network_set_hash());
    let context = [
        ("neoos:component", "custody"),
        ("neoos:purpose", purpose.encryption_context()[1].1),
        ("neoos:vault-id", profile.document().vault_id.as_str()),
        ("neoos:profile-sha256", profile_hash.as_str()),
        ("neoos:network-set-sha256", network_set_hash.as_str()),
        (
            "neoos:root-key-version",
            profile.document().root_key_version.as_str(),
        ),
    ];
    nitro_attest::release::release_bytes_with_context_and_key(
        source,
        transport,
        &params,
        &context,
        Some(profile.document().custody_kms_key_arn.as_str()),
    )
}

/// Construct the only production release closure. The validated profile is
/// captured before untrusted provision data arrives and cannot be replaced by
/// request fields.
pub fn profile_bound_releaser(profile: Arc<ValidatedVaultProfile>) -> EnvelopeReleaser {
    Arc::new(move |env, ciphertext_b64, purpose| {
        release_envelope(&profile, env, ciphertext_b64, purpose)
    })
}

pub fn coordinator_recoverer() -> VaultRecoverer {
    Arc::new(|profile, credentials, master_key, database_path| {
        coordinator::recover(
            profile,
            credentials,
            master_key,
            database_path,
            Arc::new(nitro_attest::release::NsmAttestation),
        )
        .map_err(|error| error.to_string())
    })
}

/// The whole provision transaction: validate, check the transport token,
/// release the master key, open the vault. The API must own its Provisioning
/// claim before calling this function and publish Ready in the same blocking
/// task, so HTTP cancellation cannot discard a successfully initialized vault.
pub fn run(
    gate: &ProvisionGate,
    env: &ProvisionEnv,
    presented_token: Option<&str>,
) -> Result<SignerService, ProvisionError> {
    let _guard = gate.mutex.lock().map_err(|_| {
        ProvisionError::Release("the provision lock is poisoned; restart the service".to_string())
    })?;
    let token_ciphertext = env.required(TOKEN_CIPHERTEXT_ENV)?;
    let master_ciphertext = env.required(MASTER_KEY_CIPHERTEXT_ENV)?;
    if token_ciphertext == master_ciphertext {
        return Err(ProvisionError::ReusedCiphertext);
    }

    // The transport token: released through the same attested path the master
    // key will take, then compared in constant time. A plaintext token in the
    // provisioned environment is not on the whitelist, so there is no fallback
    // to check against.
    let released = (gate.releaser)(env, token_ciphertext, EnvelopePurpose::TransportToken)
        .map_err(ProvisionError::Release)?;
    let expected = std::str::from_utf8(&released)
        .map_err(|_| ProvisionError::Release("the released transport token is not UTF-8".into()))?;
    let presented = presented_token.unwrap_or("");
    if !tokens_equal(presented, expected) {
        return Err(ProvisionError::TokenMismatch);
    }

    drop(released);
    let released = (gate.releaser)(env, master_ciphertext, EnvelopePurpose::MasterKey)
        .map_err(ProvisionError::Release)?;
    if released.len() != 32 {
        return Err(ProvisionError::Release(format!(
            "the released master key is {} bytes, expected 32",
            released.len()
        )));
    }
    let mut bytes = Zeroizing::new([0u8; 32]);
    bytes.copy_from_slice(&released);
    let master_key = MasterKey::from_bytes(*bytes);
    gate.profile
        .verify_master(&master_key)
        .map_err(|error| ProvisionError::Release(error.to_string()))?;
    let credentials = env.coordinator_credentials()?;
    (gate.recoverer)(
        Arc::clone(&gate.profile),
        credentials,
        master_key,
        &gate.database_path,
    )
    .map_err(ProvisionError::Release)
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
