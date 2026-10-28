//! Dormant preparation kernel for one measured, identity-preserving migration.
//!
//! No HTTP/provision/bootstrap path calls this module. In particular, there is
//! deliberately no production constructor for `MigrationGenesisPermit`. A
//! reviewed coordinator/attested-release adapter must supply that integration;
//! a manifest digest, root possession or decoded key alone is not admission.

use std::fmt::Write;

use anyhow::{ensure, Result};
use hkdf::Hkdf;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::{
    auth, crypto,
    model::{
        CallerCapability, KeyGrant, SignerAuditAction, SignerAuditOutcome, SignerAuditRecord,
        SignerCaller, SignerKey, SignerPolicy,
    },
    network::{self, ChainFamily, Network},
    vault::MasterKey,
    vault_profile::ValidatedVaultProfile,
};

pub(crate) const MAX_MANIFEST_BYTES: usize = 16 * 1024;
const PURPOSE: &str = "legacy-n3-two-role-root-caller/v1";
const HKDF_SALT: &[u8] = b"neoos/custody/internal-caller/root-hkdf/v1";
const ROLE_IDS: [&str; 2] = ["mn-oracle-verifier-r1", "mn-updater-r1"];
const ROLES: [&str; 2] = ["oracle_verifier", "updater"];
const CIPHER_SLOTS: [&str; 2] = [
    "MORPHEUS_ORACLE_VERIFIER_KMS_CIPHERTEXT_BASE64",
    "MORPHEUS_UPDATER_NEO_N3_KMS_CIPHERTEXT_BASE64",
];

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    schema: String,
    purpose: String,
    ceremony_id: String,
    profile_sha256: String,
    credential_epoch: String,
    caller_id: String,
    legacy_checkpoint_sha256: String,
    external_authority_map_sha256: String,
    roles: Vec<RoleBinding>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RoleBinding {
    role: String,
    key_id: String,
    public_key: String,
    script_hash: String,
    ciphertext_slot: String,
    expected_kms_key_arn: String,
    // Explicit legacy-only exception, never inferred or attempted as fallback.
    encryption_context: String,
    material_provenance_sha256: String,
}

/// Public source binding for a future Recipient-bound adapter. This is a
/// request contract, NOT evidence that a KMS call or attestation occurred.
pub(crate) struct RoleReleaseRequest<'a> {
    pub role: &'a str,
    pub ciphertext_slot: &'a str,
    pub expected_kms_key_arn: &'a str,
    pub encryption_context: &'a [(&'a str, &'a str)],
}

/// Output of the separately reviewed legacy decoder/release adapter. The
/// preparation kernel rechecks identity. This type has no Debug/Clone/serde.
/// Response KeyId is the exact full ARN, not an alias or candidate-key hint.
pub(crate) struct DecodedRoleMaterial {
    pub key_id: String,
    pub response_kms_key_arn: String,
    pub scalar: Zeroizing<[u8; 32]>,
}

pub(crate) struct MeasuredMigration {
    digest: [u8; 32],
    profile_hash: [u8; 32],
    manifest: Manifest,
}

impl MeasuredMigration {
    /// `expected_digest` must eventually come from image-owned configuration,
    /// independently admitted by the owner-approved measured release/policy.
    /// Passing two matching runtime values is NOT that integration.
    pub(crate) fn from_measured_bytes(
        bytes: &[u8],
        expected_digest: &[u8; 32],
        profile: &ValidatedVaultProfile,
    ) -> Result<Self> {
        ensure!(
            !bytes.is_empty() && bytes.len() <= MAX_MANIFEST_BYTES,
            "migration manifest size refused"
        );
        let digest: [u8; 32] = Sha256::digest(bytes).into();
        ensure!(
            &digest == expected_digest,
            "migration manifest digest mismatch"
        );
        // Suppress serde detail: this is public config, but an incorrectly
        // supplied secret must not be reflected in a parser error.
        let manifest: Manifest = serde_json::from_slice(bytes)
            .map_err(|_| anyhow::anyhow!("invalid migration manifest"))?;
        ensure!(
            profile.environment() == Network::Mainnet,
            "migration requires the explicit Mainnet two-role scope"
        );
        ensure!(
            manifest.schema == "neoos/legacy-n3-migration/v1" && manifest.purpose == PURPOSE,
            "unsupported migration contract"
        );
        ensure!(
            fixed_hex::<32>(&manifest.profile_sha256)? == *profile.profile_hash(),
            "migration profile mismatch"
        );
        identifier(&manifest.ceremony_id)?;
        identifier(&manifest.credential_epoch)?;
        identifier(&manifest.caller_id)?;
        fixed_hex::<32>(&manifest.legacy_checkpoint_sha256)?;
        fixed_hex::<32>(&manifest.external_authority_map_sha256)?;
        ensure!(
            manifest.roles.len() == 2,
            "migration requires exactly two roles"
        );
        let mut public_keys = Vec::new();
        for (index, role) in manifest.roles.iter().enumerate() {
            ensure!(
                role.role == ROLES[index]
                    && role.key_id == ROLE_IDS[index]
                    && role.ciphertext_slot == CIPHER_SLOTS[index],
                "migration role order or identity selector mismatch"
            );
            let public_key = fixed_hex::<33>(&role.public_key)?;
            ensure!(
                p256::PublicKey::from_sec1_bytes(&public_key).is_ok(),
                "migration public key is not compressed P256"
            );
            ensure!(
                !public_keys.contains(&public_key),
                "duplicate migration public key"
            );
            public_keys.push(public_key);
            let expected_hash = role
                .script_hash
                .strip_prefix("0x")
                .ok_or_else(|| anyhow::anyhow!("migration script hash format"))?;
            let mut display_hash = fixed_hex::<20>(expected_hash)?;
            display_hash.reverse();
            ensure!(
                crypto::script_hash(&public_key).as_slice() == display_hash.as_slice(),
                "migration public key and script hash mismatch"
            );
            validate_key_arn(
                &role.expected_kms_key_arn,
                &profile.document().coordinator.aws_region,
            )?;
            ensure!(
                role.encryption_context == "explicit-empty-legacy-n3/v1",
                "legacy role context must be explicitly empty"
            );
            fixed_hex::<32>(&role.material_provenance_sha256)?;
        }
        Ok(Self {
            digest,
            profile_hash: *profile.profile_hash(),
            manifest,
        })
    }

    pub(crate) fn release_request(&self, index: usize) -> Result<RoleReleaseRequest<'_>> {
        let role = self
            .manifest
            .roles
            .get(index)
            .ok_or_else(|| anyhow::anyhow!("migration role index refused"))?;
        Ok(RoleReleaseRequest {
            role: &role.role,
            ciphertext_slot: &role.ciphertext_slot,
            expected_kms_key_arn: &role.expected_kms_key_arn,
            encryption_context: &[],
        })
    }

    /// Release exactly the admitted legacy role through the existing Nitro
    /// Recipient flow. A fresh ephemeral key/NSM document and a matching KMS
    /// response KeyId are required by that implementation. No key search,
    /// plaintext host response, context fallback or new key generation exists
    /// here. The expected ARN still needs real, owner-admitted provenance.
    pub(crate) fn release_legacy_role(
        &self,
        index: usize,
        source: &dyn nitro_attest::release::AttestationSource,
        transport: &dyn nitro_attest::release::KmsTransport,
        params: &nitro_attest::release::ReleaseParams<'_>,
    ) -> Result<DecodedRoleMaterial> {
        let request = self.release_request(index)?;
        ensure!(
            request.expected_kms_key_arn.split(':').nth(3) == Some(params.region),
            "migration release region mismatch"
        );
        ensure!(
            !params.ciphertext_b64.is_empty() && params.ciphertext_b64.len() <= 8192,
            "migration role ciphertext size refused"
        );
        let plaintext = nitro_attest::release::release_bytes_with_context_and_key(
            source,
            transport,
            params,
            request.encryption_context,
            Some(request.expected_kms_key_arn),
        )
        .map_err(|_| anyhow::anyhow!("attested migration role release refused"))?;
        let binding = &self.manifest.roles[index];
        let role = match index {
            0 => crate::legacy_material::LegacyN3Role::OracleVerifier,
            1 => crate::legacy_material::LegacyN3Role::Updater,
            _ => unreachable!("release_request bounded the role index"),
        };
        let scalar = crate::legacy_material::decode_identity_bound_n3_material(
            &plaintext,
            role,
            &fixed_hex::<33>(&binding.public_key)?,
        )
        .map_err(|_| anyhow::anyhow!("released migration role identity refused"))?;
        // The release library verified this exact response ARN before opening
        // CiphertextForRecipient. Only the scalar survives the zeroizing buffer.
        Ok(DecodedRoleMaterial {
            key_id: binding.key_id.clone(),
            response_kms_key_arn: request.expected_kms_key_arn.to_string(),
            scalar,
        })
    }

    /// Pure local preparation after typed release/decoding, before any DB
    /// write. This neither authorizes genesis nor exposes a caller credential.
    pub(crate) fn prepare(
        &self,
        profile: &ValidatedVaultProfile,
        root: &MasterKey,
        material: [DecodedRoleMaterial; 2],
        imported_at_unix: u64,
    ) -> Result<PreparedMigration> {
        ensure!(
            *profile.profile_hash() == self.profile_hash,
            "migration preparation profile mismatch"
        );
        profile.verify_master(root)?;
        ensure!(
            imported_at_unix > 0 && imported_at_unix <= i64::MAX as u64,
            "invalid migration import timestamp"
        );
        let mut keys = Vec::new();
        let magic = network::network_magic(Network::Mainnet);
        ensure!(
            profile.permits(ChainFamily::NeoN3, u64::from(magic)),
            "migration N3 network is not admitted by original profile"
        );
        for (binding, released) in self.manifest.roles.iter().zip(material) {
            ensure!(
                released.key_id == binding.key_id,
                "migration released role mismatch"
            );
            ensure!(
                released.response_kms_key_arn == binding.expected_kms_key_arn,
                "migration KMS response KeyId mismatch"
            );
            let public_key = crypto::public_key_from_private(&released.scalar)
                .map_err(|_| anyhow::anyhow!("invalid migration P256 scalar"))?;
            ensure!(
                public_key == fixed_hex::<33>(&binding.public_key)?,
                "migration released identity mismatch"
            );
            let sealed = root.seal(&released.scalar)?;
            keys.push(SignerKey {
                id: binding.key_id.clone(),
                label: binding.role.clone(),
                network: Network::Mainnet,
                chain_family: ChainFamily::NeoN3,
                chain_id: u64::from(magic),
                network_magic: magic,
                public_key,
                sealed,
                created_at_unix: imported_at_unix,
                disabled: false,
            });
        }
        let token = self.derive_internal_token(root, InternalLane::Raw)?;
        let caller = SignerCaller {
            id: self.manifest.caller_id.clone(),
            label: "Migrated internal N3 raw lane".into(),
            token_digest: auth::token_digest(token.as_str()),
            workload_identity: None,
            key_grant: KeyGrant::Only(ROLE_IDS.iter().map(|s| s.to_string()).collect()),
            capabilities: vec![CallerCapability::RawSign],
            allowed_origins: Vec::new(),
            created_at_unix: imported_at_unix,
            disabled: false,
        };
        let policy = SignerPolicy {
            chain_family: Some(ChainFamily::NeoN3),
            allow_raw: true,
            ..SignerPolicy::default()
        };
        let audit = SignerAuditRecord {
            id: 1,
            recorded_at_unix: imported_at_unix,
            action: SignerAuditAction::CallerCreated,
            outcome: SignerAuditOutcome::Allowed,
            caller_id: Some(caller.id.clone()),
            key_id: None,
            tx_id: None,
            reason: None,
            origin: None,
            detail: Some(
                serde_json::json!({
                    "schema":"neoos/legacy-n3-migration-receipt/v1",
                    "manifest_sha256":hex::encode(self.digest),
                    "profile_sha256":hex::encode(self.profile_hash),
                    "ceremony_id":self.manifest.ceremony_id,
                    "legacy_checkpoint_sha256":self.manifest.legacy_checkpoint_sha256,
                    "external_authority_map_sha256":self.manifest.external_authority_map_sha256,
                    "material_provenance_sha256":self.manifest.roles.iter()
                        .map(|r| r.material_provenance_sha256.as_str()).collect::<Vec<_>>(),
                    "imported_key_ids":ROLE_IDS, "caller_id":caller.id,
                    "capability":"raw_sign", "historical_native_actions_restored":false
                })
                .to_string(),
            ),
        };
        Ok(PreparedMigration {
            manifest_digest: self.digest,
            profile_hash: self.profile_hash,
            operation_digest: crate::durable::operation_digest(
                PURPOSE,
                Some(&hex::encode(self.digest)),
            ),
            keys,
            policy,
            caller,
            audit,
            _internal_token: token,
        })
    }

    fn derive_internal_token(
        &self,
        root: &MasterKey,
        lane: InternalLane,
    ) -> Result<Zeroizing<String>> {
        let mut info = Vec::new();
        for field in [
            PURPOSE.as_bytes(),
            self.profile_hash.as_slice(),
            self.manifest.credential_epoch.as_bytes(),
            self.manifest.caller_id.as_bytes(),
            lane.label().as_bytes(),
            ROLE_IDS[0].as_bytes(),
            ROLE_IDS[1].as_bytes(),
        ] {
            info.extend_from_slice(&(field.len() as u32).to_be_bytes());
            info.extend_from_slice(field);
        }
        let mut bytes = Zeroizing::new([0u8; 32]);
        Hkdf::<Sha256>::new(Some(HKDF_SALT), root.bytes())
            .expand(&info, &mut *bytes)
            .map_err(|_| anyhow::anyhow!("internal credential derivation refused"))?;
        let mut token = Zeroizing::new(String::with_capacity(69));
        token.push_str("nci1_");
        for byte in bytes.iter() {
            write!(&mut *token, "{byte:02x}")
                .map_err(|_| anyhow::anyhow!("internal credential encoding refused"))?;
        }
        Ok(token)
    }
}

// Domain separation can be qualified without installing any semantic caller.
// The initial prepared state below contains RawSign only, never Sign/Admin.
enum InternalLane {
    Raw,
    Semantic,
}
impl InternalLane {
    fn label(&self) -> &'static str {
        match self {
            Self::Raw => "raw_sign",
            Self::Semantic => "sign",
        }
    }
}

/// Not a runtime admission API. There is deliberately NO production constructor,
/// Default, Deserialize, or public field. A future measured coordinator adapter
/// must mint this only after authenticated genesis HEAD plus live fenced lease,
/// exact owner admission and release provenance checks. Tests may synthesize it.
pub(crate) struct MigrationGenesisPermit {
    manifest_digest: [u8; 32],
    profile_hash: [u8; 32],
    operation_digest: [u8; 32],
}

pub(crate) struct PreparedMigration {
    manifest_digest: [u8; 32],
    profile_hash: [u8; 32],
    operation_digest: [u8; 32],
    keys: Vec<SignerKey>,
    policy: SignerPolicy,
    caller: SignerCaller,
    audit: SignerAuditRecord,
    _internal_token: Zeroizing<String>,
}

impl PreparedMigration {
    pub(crate) fn check_permit(&self, permit: &MigrationGenesisPermit) -> Result<()> {
        ensure!(
            permit.manifest_digest == self.manifest_digest
                && permit.profile_hash == self.profile_hash
                && permit.operation_digest == self.operation_digest,
            "migration genesis permit mismatch"
        );
        Ok(())
    }
    pub(crate) fn keys(&self) -> &[SignerKey] {
        &self.keys
    }
    pub(crate) fn policy(&self) -> &SignerPolicy {
        &self.policy
    }
    pub(crate) fn caller(&self) -> &SignerCaller {
        &self.caller
    }
    pub(crate) fn audit(&self) -> &SignerAuditRecord {
        &self.audit
    }
}

fn fixed_hex<const N: usize>(s: &str) -> Result<[u8; N]> {
    ensure!(
        s.len() == N * 2
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
        "migration fixed hex format"
    );
    let bytes: [u8; N] = hex::decode(s)?
        .try_into()
        .map_err(|_| anyhow::anyhow!("migration fixed hex length"))?;
    ensure!(bytes != [0; N], "zero migration binding refused");
    Ok(bytes)
}

fn identifier(s: &str) -> Result<()> {
    ensure!(
        !s.is_empty()
            && s.len() <= 128
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_')),
        "invalid migration identifier"
    );
    Ok(())
}

fn validate_key_arn(s: &str, region: &str) -> Result<()> {
    let p = s.split(':').collect::<Vec<_>>();
    ensure!(
        p.len() == 6
            && p[0] == "arn"
            && p[1] == "aws"
            && p[2] == "kms"
            && p[3] == region
            && p[4].len() == 12
            && p[4].bytes().all(|b| b.is_ascii_digit()),
        "migration requires exact regional KMS key ARN"
    );
    let id = p[5]
        .strip_prefix("key/")
        .ok_or_else(|| anyhow::anyhow!("migration refuses KMS alias"))?;
    ensure!(
        id.len() == 36
            && id
                .bytes()
                .enumerate()
                .all(|(i, b)| if [8, 13, 18, 23].contains(&i) {
                    b == b'-'
                } else {
                    b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
                }),
        "migration requires exact KMS key UUID"
    );
    Ok(())
}

#[cfg(test)]
#[path = "../tests/unit/migration.rs"]
mod tests;
