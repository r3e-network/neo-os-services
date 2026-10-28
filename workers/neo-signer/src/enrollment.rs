//! One measured TestNet enrollment, bound to an exact existing vault profile.
//! This is configuration, never an HTTP-selected caller or a new signing root.
use anyhow::{Context, Result};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::sync::Arc;

use crate::{
    auth,
    model::{
        CallerCapability, KeyGrant, SignerAuditAction, SignerAuditOutcome, SignerAuditRecord,
        SignerCaller,
    },
    network::Network,
    vault_profile::{CoordinatorProfile, ValidatedVaultProfile, VaultNetwork},
};

pub const MAX_MANIFEST_BYTES: usize = 16 * 1024;
pub const ENROLLMENT_MODE: &str = "first-testnet-admin/v1";
const IMAGE_ENROLLMENT_FILE: &str = "/opt/neoos/custody/testnet-image-enrollment.json";
const IMAGE_ENROLLMENT_SHA256: Option<&str> = option_env!("NEOOS_TESTNET_ENROLLMENT_SHA256");

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ImageManifest {
    schema: String,
    profile_sha256: String,
    enrollment: Manifest,
}

// Struct deserialization rejects duplicate fields before any generic JSON map.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    schema: String,
    purpose: String,
    ceremony_id: String,
    environment: String,
    vault_id: String,
    networks: Vec<VaultNetwork>,
    custody_kms_key_arn: String,
    root_key_version: String,
    root_key_commitment: String,
    coordinator: CoordinatorProfile,
    caller: Caller,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Caller {
    id: String,
    label: String,
    created_at_unix: u64,
    token_digest: String,
    auth_mode: String,
    capabilities: Vec<String>,
    key_grant: String,
    allowed_origins: Vec<String>,
    disabled: bool,
}

/// Constructed only from bounded measured bytes and their validated profile.
/// The host must opt in explicitly; a digest-looking policy is not an opt-in.
#[derive(Clone, Debug)]
pub struct ValidatedGenesisEnrollment {
    profile_hash: [u8; 32],
    digest: [u8; 32],
    caller: SignerCaller,
    audit: SignerAuditRecord,
}

impl ValidatedGenesisEnrollment {
    pub fn from_json(bytes: &[u8], profile: &ValidatedVaultProfile) -> Result<Self> {
        anyhow::ensure!(
            bytes.len() <= MAX_MANIFEST_BYTES,
            "enrollment manifest exceeds bound"
        );
        anyhow::ensure!(
            profile.environment() == Network::Testnet,
            "enrollment requires TestNet"
        );
        let digest: [u8; 32] = Sha256::digest(bytes).into();
        anyhow::ensure!(
            hex::encode(digest) == profile.document().release_policy_version,
            "enrollment manifest is not bound to the measured profile"
        );
        let manifest: Manifest =
            serde_json::from_slice(bytes).context("invalid enrollment manifest")?;
        Self::from_manifest(manifest, profile, digest)
    }

    /// The digest and fixed path are compiled into the measured image. No
    /// runtime environment, provision request or caller supplies either value.
    /// This separate opt-in preserves the original profile and KMS context.
    pub fn from_image_owned(profile: &ValidatedVaultProfile) -> Result<Option<Arc<Self>>> {
        let Some(expected) = IMAGE_ENROLLMENT_SHA256 else {
            return Ok(None);
        };
        if profile.environment() != Network::Testnet {
            return Ok(None);
        }
        Self::load_pinned_file(
            std::path::Path::new(IMAGE_ENROLLMENT_FILE),
            expected,
            profile,
        )
        .map(|value| Some(Arc::new(value)))
    }

    fn load_pinned_file(
        path: &std::path::Path,
        expected: &str,
        profile: &ValidatedVaultProfile,
    ) -> Result<Self> {
        use std::io::Read;
        anyhow::ensure!(
            expected.len() == 64
                && expected
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                && expected != "00".repeat(32),
            "image enrollment requires an exact nonzero SHA-256 binding"
        );
        anyhow::ensure!(
            profile.environment() == Network::Testnet,
            "enrollment requires TestNet"
        );
        let metadata = std::fs::symlink_metadata(path).context("image enrollment unavailable")?;
        anyhow::ensure!(
            metadata.is_file() && metadata.len() <= MAX_MANIFEST_BYTES as u64,
            "image enrollment must be a bounded regular file"
        );
        let mut bytes = Vec::new();
        std::fs::File::open(path)
            .context("image enrollment unavailable")?
            .take(MAX_MANIFEST_BYTES as u64 + 1)
            .read_to_end(&mut bytes)
            .context("image enrollment unreadable")?;
        let digest: [u8; 32] = Sha256::digest(&bytes).into();
        anyhow::ensure!(
            !bytes.is_empty()
                && bytes.len() <= MAX_MANIFEST_BYTES
                && hex::encode(digest) == expected,
            "image enrollment digest mismatch"
        );
        let wrapper: ImageManifest =
            serde_json::from_slice(&bytes).context("invalid image enrollment manifest")?;
        anyhow::ensure!(
            wrapper.schema == "neoos/image-owned-testnet-enrollment/v1"
                && wrapper.profile_sha256 == hex::encode(profile.profile_hash()),
            "image enrollment profile mismatch"
        );
        Self::from_manifest(wrapper.enrollment, profile, digest)
    }

    fn from_manifest(
        manifest: Manifest,
        profile: &ValidatedVaultProfile,
        digest: [u8; 32],
    ) -> Result<Self> {
        let document = profile.document();
        anyhow::ensure!(
            manifest.schema == "neoos/first-admin-enrollment/v1"
                && manifest.purpose == ENROLLMENT_MODE,
            "unsupported enrollment contract"
        );
        anyhow::ensure!(
            manifest.environment == "testnet"
                && manifest.vault_id == document.vault_id
                && manifest.networks == document.networks
                && manifest.custody_kms_key_arn == document.custody_kms_key_arn
                && manifest.root_key_version == document.root_key_version
                && manifest.root_key_commitment == document.root_key_commitment
                && manifest.coordinator == document.coordinator,
            "enrollment destination differs from measured profile"
        );
        identifier(&manifest.ceremony_id)?;
        identifier(&manifest.caller.id)?;
        let c = manifest.caller;
        anyhow::ensure!(
            !c.label.is_empty()
                && c.label.len() <= 128
                && c.label.trim() == c.label
                && !c.label.chars().any(char::is_control),
            "invalid enrollment label"
        );
        anyhow::ensure!(
            c.created_at_unix > 0 && c.created_at_unix <= i64::MAX as u64,
            "invalid enrollment timestamp"
        );
        anyhow::ensure!(
            c.auth_mode == "bearer"
                && c.capabilities == ["admin"]
                && c.key_grant == "any"
                && c.allowed_origins.is_empty()
                && !c.disabled,
            "enrollment must be an enabled bearer Admin only"
        );
        anyhow::ensure!(
            c.token_digest.len() == 64
                && c.token_digest
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
            "invalid enrollment token digest"
        );
        let token_digest: [u8; 32] = hex::decode(&c.token_digest)?
            .try_into()
            .map_err(|_| anyhow::anyhow!("invalid enrollment token digest"))?;
        anyhow::ensure!(token_digest != [0; 32], "zero enrollment token digest");
        let caller = SignerCaller {
            id: c.id,
            label: c.label,
            created_at_unix: c.created_at_unix,
            token_digest,
            workload_identity: None,
            key_grant: KeyGrant::Any,
            capabilities: vec![CallerCapability::Admin],
            allowed_origins: Vec::new(),
            disabled: false,
        };
        let audit = SignerAuditRecord {
            id: 1, recorded_at_unix: caller.created_at_unix,
            action: SignerAuditAction::CallerCreated, outcome: SignerAuditOutcome::Allowed,
            caller_id: Some(caller.id.clone()), key_id: None, tx_id: None, reason: None, origin: None,
            detail: Some(serde_json::json!({
                "schema":"neoos/first-admin-receipt/v1", "manifest_sha256":hex::encode(digest),
                "ceremony_id":manifest.ceremony_id, "profile_sha256":hex::encode(profile.profile_hash()),
                "caller_id":caller.id, "token_digest":hex::encode(token_digest),
                "capabilities":["admin"], "key_grant":"any"
            }).to_string()),
        };
        Ok(Self {
            profile_hash: *profile.profile_hash(),
            digest,
            caller,
            audit,
        })
    }

    pub(crate) fn validate_profile(&self, profile: &ValidatedVaultProfile) -> Result<()> {
        anyhow::ensure!(
            profile.environment() == Network::Testnet
                && profile.profile_hash() == &self.profile_hash,
            "enrollment profile mismatch"
        );
        Ok(())
    }

    pub(crate) fn verify_token(&self, plaintext: &[u8], transport_digest: &[u8; 32]) -> Result<()> {
        // Existing generate_token format: nsk1_ followed by two simple UUIDs.
        anyhow::ensure!(
            plaintext.len() == 69
                && plaintext.starts_with(b"nsk1_")
                && plaintext[5..]
                    .iter()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(b)),
            "invalid enrollment credential format"
        );
        let token = std::str::from_utf8(plaintext).context("invalid enrollment credential")?;
        let digest = auth::token_digest(token);
        let equal =
            |a: &[u8; 32], b: &[u8; 32]| a.iter().zip(b).fold(0u8, |v, (x, y)| v | (x ^ y)) == 0;
        anyhow::ensure!(
            equal(&digest, &self.caller.token_digest),
            "enrollment credential digest mismatch"
        );
        anyhow::ensure!(
            !equal(&digest, transport_digest),
            "enrollment credential equals transport credential"
        );
        Ok(())
    }

    pub(crate) fn caller(&self) -> &SignerCaller {
        &self.caller
    }
    pub(crate) fn audit(&self) -> &SignerAuditRecord {
        &self.audit
    }
    pub(crate) fn operation_digest(&self) -> [u8; 32] {
        crate::durable::operation_digest(
            "first-admin-enrollment/v1",
            Some(&hex::encode(self.digest)),
        )
    }
}

fn identifier(value: &str) -> Result<()> {
    anyhow::ensure!(
        !value.is_empty()
            && value.len() <= 128
            && value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_')),
        "invalid enrollment identifier"
    );
    Ok(())
}

#[cfg(test)]
#[path = "../tests/unit/enrollment.rs"]
pub(crate) mod tests;
