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

/// Separate envelope used only by measured TestNet genesis enrollment.
pub const ADMIN_CIPHERTEXT_ENV: &str = "SIGNER_SERVICE_FIRST_ADMIN_KMS_CIPHERTEXT";

/// Only these two legacy role envelopes may accompany measured migration.
/// They are never a plaintext/ref/metadata override or a genesis authority.
pub const LEGACY_ROLE_CIPHERTEXT_ENVS: [&str; 2] = [
    "MORPHEUS_ORACLE_VERIFIER_KMS_CIPHERTEXT_BASE64",
    "MORPHEUS_UPDATER_NEO_N3_KMS_CIPHERTEXT_BASE64",
];
const MAX_LEGACY_CIPHERTEXT_BYTES: usize = 6 * 1024;
const MAX_LEGACY_CIPHERTEXT_BASE64: usize = 8192;

/// Region override, falling back through the standard AWS names.
pub const REGION_ENV: &str = "SIGNER_SERVICE_KMS_REGION";

/// The only environment keys a provision body may carry.
const ALLOWED_ENV_KEYS: &[&str] = &[
    TOKEN_CIPHERTEXT_ENV,
    MASTER_KEY_CIPHERTEXT_ENV,
    ADMIN_CIPHERTEXT_ENV,
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
    #[serde(deserialize_with = "unique_env")]
    pub env: serde_json::Map<String, serde_json::Value>,
}

// Reject duplicate keys while streaming, before Map would replace a value.
fn unique_env<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<serde_json::Map<String, serde_json::Value>, D::Error> {
    struct Visitor;
    impl<'de> serde::de::Visitor<'de> for Visitor {
        type Value = serde_json::Map<String, serde_json::Value>;
        fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            f.write_str("unique provision fields")
        }
        fn visit_map<M: serde::de::MapAccess<'de>>(
            self,
            mut map: M,
        ) -> Result<Self::Value, M::Error> {
            let mut fields = serde_json::Map::new();
            while let Some((key, value)) = map.next_entry::<String, serde_json::Value>()? {
                if fields.insert(key, value).is_some() {
                    return Err(serde::de::Error::custom("duplicate provision field"));
                }
            }
            Ok(fields)
        }
    }
    deserializer.deserialize_map(Visitor)
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
        Self::from_body_for_migration(body, None)
    }

    pub(crate) fn from_body_for_migration(
        body: ProvisionBody,
        migration: Option<&crate::embedded::MeasuredMigration>,
    ) -> Result<Self, ProvisionError> {
        if body.env.contains_key("SIGNER_SERVICE_MASTER_KEY") {
            return Err(ProvisionError::PlaintextMasterKey);
        }
        let mut fields = Vec::with_capacity(body.env.len());
        for (name, value) in body.env {
            if !ALLOWED_ENV_KEYS.contains(&name.as_str())
                && !(migration.is_some() && LEGACY_ROLE_CIPHERTEXT_ENVS.contains(&name.as_str()))
            {
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
        let env = ProvisionEnv { fields };
        env.validate_legacy_ciphertexts(migration)?;
        Ok(env)
    }

    fn validate_legacy_ciphertexts(
        &self,
        migration: Option<&crate::embedded::MeasuredMigration>,
    ) -> Result<(), ProvisionError> {
        let present = LEGACY_ROLE_CIPHERTEXT_ENVS.map(|name| self.get(name));
        if present.iter().all(Option::is_none) {
            return Ok(());
        }
        if migration.is_none() {
            let name = LEGACY_ROLE_CIPHERTEXT_ENVS
                .iter()
                .find(|name| self.get(name).is_some())
                .expect("a legacy field is present");
            return Err(ProvisionError::UnknownKey((*name).to_string()));
        }
        // Restore needs no original envelopes. If supplied for future genesis
        // composition, require the exact complete bounded pair, never a hint.
        use base64::{engine::general_purpose::STANDARD, Engine as _};
        let mut decoded = Vec::new();
        for (name, value) in LEGACY_ROLE_CIPHERTEXT_ENVS.iter().zip(present) {
            let value = value.ok_or(ProvisionError::MissingField(name))?;
            if value.len() > MAX_LEGACY_CIPHERTEXT_BASE64 {
                return Err(ProvisionError::Release(
                    "legacy role ciphertext size refused".into(),
                ));
            }
            let bytes = STANDARD
                .decode(value)
                .map_err(|_| ProvisionError::Release("invalid legacy role ciphertext".into()))?;
            if bytes.is_empty()
                || bytes.len() > MAX_LEGACY_CIPHERTEXT_BYTES
                || decoded.contains(&bytes)
            {
                return Err(ProvisionError::Release(
                    "legacy role ciphertext pair refused".into(),
                ));
            }
            decoded.push(bytes);
        }
        Ok(())
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
            Option<&EnrollmentAttempt<'_>>,
        ) -> Result<SignerService, String>
        + Send
        + Sync,
>;

/// Separate ABI so the existing Testnet/ordinary recoverer stays unchanged.
/// This request carries a delayed release, never a bool/hash authority proof.
pub struct MigrationAttempt<'a> {
    pub(crate) restore_only: bool,
    pub(crate) manifest: &'a crate::embedded::MeasuredMigration,
    pub(crate) release_roles:
        &'a (dyn Fn() -> Result<[crate::migration::DecodedRoleMaterial; 2], String> + Sync),
}

pub type MigrationRecoverer = Arc<
    dyn Fn(
            Arc<ValidatedVaultProfile>,
            AwsCredentials,
            MasterKey,
            &Path,
            &MigrationAttempt<'_>,
        ) -> Result<SignerService, String>
        + Send
        + Sync,
>;

/// Borrowed authorization deferred until authenticated recovery selects genesis.
/// Restore never calls this closure or requires the original Admin ciphertext.
pub struct EnrollmentAttempt<'a> {
    pub(crate) manifest: &'a crate::enrollment::ValidatedGenesisEnrollment,
    pub(crate) authorize: &'a (dyn Fn() -> Result<(), String> + Sync),
}

/// Selected only by enclave code. The host cannot choose the KMS purpose.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EnvelopePurpose {
    TransportToken,
    MasterKey,
    FirstAdmin,
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
                    Self::FirstAdmin => "first-admin/v1",
                },
            ),
        ]
    }
}

/// The complete measured custody binding shared by offline preparation and
/// Recipient-bound Decrypt. Purpose is typed; callers cannot append overrides.
pub fn custody_encryption_context(
    profile: &ValidatedVaultProfile,
    purpose: EnvelopePurpose,
) -> [(String, String); 6] {
    [
        ("neoos:component".into(), "custody".into()),
        (
            "neoos:purpose".into(),
            purpose.encryption_context()[1].1.into(),
        ),
        ("neoos:vault-id".into(), profile.document().vault_id.clone()),
        (
            "neoos:profile-sha256".into(),
            hex::encode(profile.profile_hash()),
        ),
        (
            "neoos:network-set-sha256".into(),
            hex::encode(profile.network_set_hash()),
        ),
        (
            "neoos:root-key-version".into(),
            profile.document().root_key_version.clone(),
        ),
    ]
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
    pub enrollment: Option<Arc<crate::enrollment::ValidatedGenesisEnrollment>>,
    pub migration: Option<Arc<crate::embedded::MeasuredMigration>>,
    pub migration_recoverer: MigrationRecoverer,
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
    let context = custody_encryption_context(profile, purpose);
    let context_refs: Vec<_> = context
        .iter()
        .map(|(key, value)| (key.as_str(), value.as_str()))
        .collect();
    nitro_attest::release::release_bytes_with_context_and_key(
        source,
        transport,
        &params,
        &context_refs,
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
    Arc::new(
        |profile, credentials, master_key, database_path, enrollment| {
            coordinator::recover_with_enrollment(
                profile,
                credentials,
                master_key,
                database_path,
                Arc::new(nitro_attest::release::NsmAttestation),
                enrollment,
            )
            .map_err(|error| error.to_string())
        },
    )
}

/// The parent-owned coordinator must authorize genesis and invoke the delayed
/// release only there. A committed HEAD restores with receipt validation and
/// never inspects the original role envelopes. There is no recovery fallback.
/// This wiring requires the separately composed genesis/Recipient checkpoint.
pub fn migration_recoverer() -> MigrationRecoverer {
    Arc::new(|profile, credentials, master_key, database_path, attempt| {
        attempt
            .manifest
            .validate_profile(&profile)
            .map_err(|error| error.to_string())?;
        if attempt.restore_only {
            return coordinator::recover_with_migration_restore(
                profile,
                credentials,
                master_key,
                database_path,
                Arc::new(nitro_attest::release::NsmAttestation),
                attempt.manifest.core(),
            )
            .map_err(|error| error.to_string());
        }
        coordinator::recover_with_migration(
            profile,
            credentials,
            master_key,
            database_path,
            Arc::new(nitro_attest::release::NsmAttestation),
            attempt.manifest.core(),
            attempt.release_roles,
        )
        .map_err(|error| error.to_string())
    })
}

/// No caller can request this helper through an HTTP method or select a role
/// ARN/context. The closure in run is its only caller, after transport/root
/// authentication, and coordinator alone decides whether to invoke it.
fn release_legacy_pair(
    migration: &crate::embedded::MeasuredMigration,
    env: &ProvisionEnv,
) -> Result<[crate::migration::DecodedRoleMaterial; 2], String> {
    let credentials = env
        .credentials()
        .map_err(|_| "missing migration release credentials")?;
    let region = env
        .region()
        .map_err(|_| "missing migration release region")?;
    let release = |index: usize| {
        let request = migration
            .core()
            .release_request(index)
            .map_err(|_| "invalid measured migration role")?;
        if request.role != ["oracle_verifier", "updater"][index]
            || request.ciphertext_slot != LEGACY_ROLE_CIPHERTEXT_ENVS[index]
        {
            return Err("measured migration role selector mismatch".into());
        }
        let ciphertext = env
            .get(request.ciphertext_slot)
            .ok_or_else(|| "missing migration role ciphertext".to_string())?;
        let params = nitro_attest::release::ReleaseParams {
            region,
            credentials: &credentials,
            ciphertext_b64: ciphertext,
            amz_date: &nitro_attest::kms::utc_amz_date_now(),
        };
        migration
            .core()
            .release_legacy_role(
                index,
                &nitro_attest::release::NsmAttestation,
                &nitro_attest::release::HttpKmsTransport,
                &params,
            )
            .map_err(|_| "attested migration role release refused".to_string())
    };
    Ok([release(0)?, release(1)?])
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
    if let Some(migration) = &gate.migration {
        if gate.enrollment.is_some() {
            return Err(ProvisionError::Release(
                "migration conflicts with enrollment".into(),
            ));
        }
        migration
            .validate_profile(&gate.profile)
            .map_err(|error| ProvisionError::Release(error.to_string()))?;
    }
    env.validate_legacy_ciphertexts(gate.migration.as_deref())?;
    if gate.enrollment.is_none() && env.get(ADMIN_CIPHERTEXT_ENV).is_some() {
        return Err(ProvisionError::UnknownKey(ADMIN_CIPHERTEXT_ENV.to_string()));
    }
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

    let transport_digest = crate::auth::token_digest(expected);
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
    if let Some(manifest) = &gate.migration {
        let release_roles = || release_legacy_pair(manifest, env);
        let attempt = MigrationAttempt {
            manifest,
            release_roles: &release_roles,
            restore_only: env.get(LEGACY_ROLE_CIPHERTEXT_ENVS[0]).is_none(),
        };
        return (gate.migration_recoverer)(
            Arc::clone(&gate.profile),
            credentials,
            master_key,
            &gate.database_path,
            &attempt,
        )
        .map_err(ProvisionError::Release);
    }
    let authorize = || -> Result<(), String> {
        let manifest = gate.enrollment.as_ref().ok_or("enrollment is disabled")?;
        let ciphertext = env
            .get(ADMIN_CIPHERTEXT_ENV)
            .ok_or("missing enrollment ciphertext")?;
        // Compare decoded bytes too: base64 spelling is not purpose separation.
        use base64::{engine::general_purpose::STANDARD, Engine as _};
        let decode = |text: &str| {
            STANDARD
                .decode(text)
                .map_err(|_| "invalid enrollment ciphertext")
        };
        let admin = decode(ciphertext)?;
        if admin.is_empty()
            || admin == decode(token_ciphertext)?
            || admin == decode(master_ciphertext)?
        {
            return Err("enrollment requires a distinct purpose-bound ciphertext".into());
        }
        let released = (gate.releaser)(env, ciphertext, EnvelopePurpose::FirstAdmin)?;
        manifest
            .verify_token(&released, &transport_digest)
            .map_err(|error| error.to_string())
    };
    let enrollment = gate.enrollment.as_ref().map(|manifest| EnrollmentAttempt {
        manifest,
        authorize: &authorize,
    });
    (gate.recoverer)(
        Arc::clone(&gate.profile),
        credentials,
        master_key,
        &gate.database_path,
        enrollment.as_ref(),
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
