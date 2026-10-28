//! Identity-preserving migration under an authenticated coordinator lease.
//!
//! Image-owned input selects the contract; only the coordinator can admit
//! genesis and commit it. Existing authenticated snapshots are restored without
//! repeating release or overwriting current caller/key state.

use std::fmt::Write;

use anyhow::{ensure, Result};
use hkdf::Hkdf;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::{
    auth, crypto,
    model::{
        CallerCapability, ContractMethod, KeyGrant, SignatureRateLimit, SignerAuditAction,
        SignerAuditOutcome, SignerAuditRecord, SignerCaller, SignerKey, SignerPolicy,
    },
    network::{self, ChainFamily, Network},
    vault::MasterKey,
    vault_profile::ValidatedVaultProfile,
};

pub(crate) const MAX_MANIFEST_BYTES: usize = 16 * 1024;
const PURPOSE: &str = "legacy-n3-two-role-root-caller/v1";
const PURPOSE_V2: &str = "legacy-n3-two-role-root-caller/v2";
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
    #[serde(default)]
    semantic: Option<SemanticBinding>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SemanticBinding {
    caller_id: String,
    max_system_fee: i64,
    max_network_fee: i64,
    max_signatures: u64,
    window_seconds: u64,
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

/// Historical evidence inside an authenticated, committed snapshot. This is
/// deliberately not an admission token and has no authority-bearing API.
#[derive(Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct MigrationReceipt {
    schema: String,
    manifest_sha256: String,
    profile_sha256: String,
    ceremony_id: String,
    legacy_checkpoint_sha256: String,
    external_authority_map_sha256: String,
    material_provenance_sha256: Vec<String>,
    imported_key_ids: Vec<String>,
    caller_id: String,
    capability: String,
    historical_native_actions_restored: bool,
    #[serde(default)]
    semantic: Option<SemanticReceipt>,
}

#[derive(Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct SemanticReceipt {
    caller_id: String,
    key_id: String,
    capability: String,
    policy_sha256: String,
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
    pub(crate) fn profile_hash(&self) -> &[u8; 32] {
        &self.profile_hash
    }

    pub(crate) fn validate_profile(&self, profile: &ValidatedVaultProfile) -> Result<()> {
        ensure!(
            profile.environment() == Network::Mainnet
                && *profile.profile_hash() == self.profile_hash,
            "migration restore profile mismatch"
        );
        Ok(())
    }

    /// Validate the original import statement, not the current caller. Later
    /// rotations, disables, deletions and policy changes must survive recovery.
    pub(crate) fn validate_receipt(&self, audit: &SignerAuditRecord) -> Result<u64> {
        ensure!(
            audit.id == 1
                && audit.recorded_at_unix > 0
                && audit.recorded_at_unix <= i64::MAX as u64
                && audit.action == SignerAuditAction::CallerCreated
                && audit.outcome == SignerAuditOutcome::Allowed
                && audit.caller_id.as_deref() == Some(self.manifest.caller_id.as_str())
                && audit.key_id.is_none()
                && audit.tx_id.is_none()
                && audit.reason.is_none()
                && audit.origin.is_none(),
            "migration historical audit mismatch"
        );
        let detail = audit
            .detail
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("migration receipt missing"))?;
        ensure!(
            detail.len() <= MAX_MANIFEST_BYTES,
            "migration receipt size refused"
        );
        if !self.has_semantic() {
            let value: serde_json::Value = serde_json::from_str(detail)?;
            ensure!(
                !value
                    .as_object()
                    .is_some_and(|v| v.contains_key("semantic")),
                "v1 receipt cannot add semantic authority"
            );
        }
        let receipt: MigrationReceipt = serde_json::from_str(detail)
            .map_err(|_| anyhow::anyhow!("invalid migration receipt"))?;
        let expected = MigrationReceipt {
            schema: self.receipt_schema().into(),
            manifest_sha256: hex::encode(self.digest),
            profile_sha256: hex::encode(self.profile_hash),
            ceremony_id: self.manifest.ceremony_id.clone(),
            legacy_checkpoint_sha256: self.manifest.legacy_checkpoint_sha256.clone(),
            external_authority_map_sha256: self.manifest.external_authority_map_sha256.clone(),
            material_provenance_sha256: self
                .manifest
                .roles
                .iter()
                .map(|role| role.material_provenance_sha256.clone())
                .collect(),
            imported_key_ids: ROLE_IDS.iter().map(|id| id.to_string()).collect(),
            caller_id: self.manifest.caller_id.clone(),
            capability: "raw_sign".into(),
            historical_native_actions_restored: false,
            semantic: self.semantic_receipt(),
        };
        ensure!(receipt == expected, "migration historical receipt mismatch");
        Ok(audit.recorded_at_unix)
    }

    pub(crate) fn key_ids(&self) -> [&str; 2] {
        ROLE_IDS
    }

    pub(crate) fn initial_policy(&self) -> SignerPolicy {
        SignerPolicy {
            chain_family: Some(ChainFamily::NeoN3),
            allow_raw: true,
            ..SignerPolicy::default()
        }
    }

    fn receipt_schema(&self) -> &'static str {
        if self.manifest.semantic.is_some() {
            "neoos/legacy-n3-migration-receipt/v2"
        } else {
            "neoos/legacy-n3-migration-receipt/v1"
        }
    }

    pub(crate) fn has_semantic(&self) -> bool {
        self.manifest.semantic.is_some()
    }

    fn semantic_receipt(&self) -> Option<SemanticReceipt> {
        self.manifest.semantic.as_ref().map(|s| SemanticReceipt {
            caller_id: s.caller_id.clone(),
            key_id: ROLE_IDS[1].into(),
            capability: "sign".into(),
            policy_sha256: hex::encode(self.initial_policy_for(1).digest()),
        })
    }

    pub(crate) fn initial_policy_for(&self, index: usize) -> SignerPolicy {
        let mut policy = self.initial_policy();
        if index == 1 {
            if let Some(s) = &self.manifest.semantic {
                // A semantic key cannot also authorize raw preimages. The v1
                // policies and v2 oracle key retain their raw-only boundary.
                policy.allow_raw = false;
                // Fixed measured Mainnet feed target; never a body/env override.
                let contract = "0x03013f49c42a14546c8bbe58f9d434c3517fccab"
                    .parse::<crate::model::ScriptHash>()
                    .expect("fixed Mainnet feed hash");
                policy.allow_contract_call = true;
                policy.contract_whitelist = vec![contract];
                policy.contract_method_whitelist = vec![ContractMethod {
                    contract,
                    method: "updateFeeds".into(),
                }];
                policy.max_signers = Some(1);
                policy.max_system_fee = Some(s.max_system_fee);
                policy.max_network_fee = Some(s.max_network_fee);
                policy.max_signatures = Some(SignatureRateLimit {
                    seconds: s.window_seconds,
                    count: s.max_signatures,
                });
            }
        }
        policy
    }

    pub(crate) fn initial_semantic_caller(
        &self,
        root: &MasterKey,
        imported_at: u64,
    ) -> Result<Option<SignerCaller>> {
        let Some(s) = &self.manifest.semantic else {
            return Ok(None);
        };
        let token = self.derive_internal_token(root, InternalLane::Semantic)?;
        Ok(Some(SignerCaller {
            id: s.caller_id.clone(),
            label: "Migrated internal N3 feed transaction lane".into(),
            token_digest: auth::token_digest(token.as_str()),
            workload_identity: None,
            key_grant: KeyGrant::Only(vec![ROLE_IDS[1].into()]),
            capabilities: vec![CallerCapability::Sign],
            allowed_origins: Vec::new(),
            created_at_unix: imported_at,
            disabled: false,
        }))
    }

    /// Only generation one may compare the initial credential. This derives a
    /// temporary zeroizing token for comparison; it publishes nothing.
    pub(crate) fn initial_caller(
        &self,
        root: &MasterKey,
        imported_at: u64,
    ) -> Result<SignerCaller> {
        let token = self.derive_internal_token(root, InternalLane::Raw)?;
        Ok(SignerCaller {
            id: self.manifest.caller_id.clone(),
            label: "Migrated internal N3 raw lane".into(),
            token_digest: auth::token_digest(token.as_str()),
            workload_identity: None,
            key_grant: KeyGrant::Only(ROLE_IDS.iter().map(|id| id.to_string()).collect()),
            capabilities: vec![CallerCapability::RawSign],
            allowed_origins: Vec::new(),
            created_at_unix: imported_at,
            disabled: false,
        })
    }

    pub(crate) fn validate_initial_key(
        &self,
        index: usize,
        key: &SignerKey,
        root: &MasterKey,
        imported_at: u64,
    ) -> Result<()> {
        let role = self
            .manifest
            .roles
            .get(index)
            .ok_or_else(|| anyhow::anyhow!("migration role index refused"))?;
        let public_key = fixed_hex::<33>(&role.public_key)?;
        let magic = network::network_magic(Network::Mainnet);
        ensure!(
            key.id == role.key_id
                && key.label == role.role
                && key.public_key == public_key
                && key.network == Network::Mainnet
                && key.chain_family == ChainFamily::NeoN3
                && key.chain_id == u64::from(magic)
                && key.network_magic == magic
                && key.created_at_unix == imported_at
                && !key.disabled,
            "initial migration key mismatch"
        );
        let plaintext = root
            .open_sealed(&key.sealed)
            .map_err(|_| anyhow::anyhow!("initial migration key seal refused"))?;
        let scalar: &[u8; 32] = plaintext
            .as_slice()
            .try_into()
            .map_err(|_| anyhow::anyhow!("initial migration scalar size refused"))?;
        ensure!(
            crypto::public_key_from_private(scalar)
                .map_err(|_| anyhow::anyhow!("initial migration scalar refused"))?
                == public_key,
            "initial migration sealed identity mismatch"
        );
        Ok(())
    }

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
            (manifest.schema == "neoos/legacy-n3-migration/v1"
                && manifest.purpose == PURPOSE
                && !serde_json::from_slice::<serde_json::Value>(bytes)?
                    .as_object()
                    .is_some_and(|v| v.contains_key("semantic")))
                || (manifest.schema == "neoos/legacy-n3-migration/v2"
                    && manifest.purpose == PURPOSE_V2
                    && manifest.semantic.is_some()),
            "unsupported migration contract"
        );
        ensure!(
            fixed_hex::<32>(&manifest.profile_sha256)? == *profile.profile_hash(),
            "migration profile mismatch"
        );
        identifier(&manifest.ceremony_id)?;
        identifier(&manifest.credential_epoch)?;
        identifier(&manifest.caller_id)?;
        if let Some(s) = &manifest.semantic {
            identifier(&s.caller_id)?;
            ensure!(
                s.caller_id != manifest.caller_id
                    && (1..=1_000_000_000).contains(&s.max_system_fee)
                    && (1..=200_000_000).contains(&s.max_network_fee)
                    && (1..=3600).contains(&s.max_signatures)
                    && (1..=86400).contains(&s.window_seconds),
                "semantic caller or bounds refused"
            );
        }
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

    /// The opaque proof is minted only by the coordinator after authenticated
    /// HEAD/takeover and a fresh remote lease check. Runtime input cannot create
    /// it. A prepared batch is still private until its durable receipt verifies.
    pub(crate) fn admit_genesis(
        &self,
        proof: &crate::coordinator::AuthenticatedMigrationGenesis,
    ) -> Result<MigrationGenesisPermit> {
        let head = proof.head();
        head.validate()?;
        ensure!(
            head.is_genesis() && head.binding.profile_hash == self.profile_hash,
            "migration requires the authenticated genesis binding"
        );
        Ok(MigrationGenesisPermit {
            manifest_digest: self.digest,
            profile_hash: self.profile_hash,
            operation_digest: crate::durable::operation_digest(
                &self.manifest.purpose,
                Some(&hex::encode(self.digest)),
            ),
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
        let policy = self.initial_policy();
        let semantic_caller = self.initial_semantic_caller(root, imported_at_unix)?;
        let updater_policy = self.initial_policy_for(1);
        let mut audit = SignerAuditRecord {
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
        if let Some(semantic) = self.semantic_receipt() {
            let mut receipt: serde_json::Value =
                serde_json::from_str(audit.detail.as_ref().expect("receipt"))?;
            receipt["schema"] = self.receipt_schema().into();
            receipt["semantic"] = serde_json::to_value(semantic)?;
            audit.detail = Some(receipt.to_string());
        }
        Ok(PreparedMigration {
            manifest_digest: self.digest,
            profile_hash: self.profile_hash,
            operation_digest: crate::durable::operation_digest(
                &self.manifest.purpose,
                Some(&hex::encode(self.digest)),
            ),
            keys,
            policy,
            updater_policy,
            caller,
            semantic_caller,
            audit,
            _internal_token: token,
        })
    }

    /// Reattach only the still-current original RawSign caller. This is a
    /// read-only check: rotation, disable, deletion or grant changes refuse.
    pub(crate) fn current_raw_token(
        &self,
        root: &MasterKey,
        caller: &SignerCaller,
    ) -> Result<Zeroizing<String>> {
        let token = self.derive_internal_token(root, InternalLane::Raw)?;
        ensure!(
            caller.id == self.manifest.caller_id
                && !caller.disabled
                && caller.workload_identity.is_none()
                && caller.capabilities == [CallerCapability::RawSign]
                && caller.key_grant
                    == KeyGrant::Only(ROLE_IDS.iter().map(|id| id.to_string()).collect())
                && caller.allowed_origins.is_empty()
                && auth::digest_matches(&caller.token_digest, &auth::token_digest(token.as_str())),
            "current internal raw caller is not admitted"
        );
        Ok(token)
    }

    pub(crate) fn semantic_caller_id(&self) -> Option<&str> {
        self.manifest
            .semantic
            .as_ref()
            .map(|s| s.caller_id.as_str())
    }

    pub(crate) fn current_semantic_token(
        &self,
        root: &MasterKey,
        caller: &SignerCaller,
    ) -> Result<Zeroizing<String>> {
        let id = self
            .semantic_caller_id()
            .ok_or_else(|| anyhow::anyhow!("semantic migration not enabled"))?;
        let token = self.derive_internal_token(root, InternalLane::Semantic)?;
        ensure!(
            caller.id == id
                && !caller.disabled
                && caller.workload_identity.is_none()
                && caller.capabilities == [CallerCapability::Sign]
                && caller.key_grant == KeyGrant::Only(vec![ROLE_IDS[1].into()])
                && caller.allowed_origins.is_empty()
                && auth::digest_matches(&caller.token_digest, &auth::token_digest(token.as_str())),
            "current internal semantic caller is not admitted"
        );
        Ok(token)
    }

    pub(crate) fn caller_id(&self) -> &str {
        &self.manifest.caller_id
    }

    fn derive_internal_token(
        &self,
        root: &MasterKey,
        lane: InternalLane,
    ) -> Result<Zeroizing<String>> {
        let mut info = Vec::new();
        let (purpose, caller) = match lane {
            InternalLane::Raw => (PURPOSE, self.manifest.caller_id.as_str()),
            InternalLane::Semantic => (
                PURPOSE_V2,
                self.semantic_caller_id()
                    .unwrap_or(&self.manifest.caller_id),
            ),
        };
        for field in [
            purpose.as_bytes(),
            self.profile_hash.as_slice(),
            self.manifest.credential_epoch.as_bytes(),
            caller.as_bytes(),
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

// Each internal lane has a separate credential and current-caller grant.
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

/// Not a request-body admission API. No Default, Deserialize, or public field.
/// Production construction requires the coordinator's opaque genesis proof.
/// Tests may synthesize this binding without invoking a remote authority.
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
    updater_policy: SignerPolicy,
    caller: SignerCaller,
    semantic_caller: Option<SignerCaller>,
    audit: SignerAuditRecord,
    _internal_token: Zeroizing<String>,
}

impl PreparedMigration {
    pub(crate) fn operation_digest(&self) -> [u8; 32] {
        self.operation_digest
    }
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
    pub(crate) fn policy_for(&self, index: usize) -> &SignerPolicy {
        if index == 1 {
            &self.updater_policy
        } else {
            &self.policy
        }
    }
    pub(crate) fn semantic_caller(&self) -> Option<&SignerCaller> {
        self.semantic_caller.as_ref()
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
pub(crate) mod tests;
