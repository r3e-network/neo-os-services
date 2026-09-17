//! Whole-vault snapshot encryption. Integrity is not freshness: callers must
//! obtain `SnapshotHead` from an authenticated, monotonic external authority.
//! A host-supplied head provides no rollback protection. This module supplies
//! the cryptographic primitive, not remote head verification or boot restore.

use aes_gcm::{
    aead::{rand_core::RngCore, Aead, KeyInit, OsRng, Payload},
    Aes256Gcm, Nonce,
};
use anyhow::{bail, ensure, Result};
use hkdf::Hkdf;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::{
    network::{self, ChainFamily, Network},
    vault::MasterKey,
    vault_profile::{
        root_key_commitment, ValidatedVaultProfile, SIGNER_SCHEMA_VERSION, SNAPSHOT_FORMAT_VERSION,
    },
};

const MAGIC: &[u8; 8] = b"NEOOSCS2";
const HEADER_BYTES: usize = 8 + 32 + 4 + 8 + 32 + 32 + 32 + 4 + 4 + 1 + 8 + 8 + 32 + 32 + 12;
const TAG_BYTES: usize = 16;
pub const MAX_SNAPSHOT_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_SNAPSHOT_PLAINTEXT_BYTES: usize = MAX_SNAPSHOT_BYTES - HEADER_BYTES - TAG_BYTES;
const NEO_N3_MASK: u8 = 1;
const NEOX_MASK: u8 = 2;

/// Full, domain-separated vault identity and both supported chain identities.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VaultBinding {
    pub vault_id: [u8; 32],
    pub neo_n3_magic: u32,
    pub neox_chain_id: u64,
    pub profile_hash: [u8; 32],
    pub network_set_hash: [u8; 32],
    pub root_key_commitment: [u8; 32],
    pub snapshot_format_version: u32,
    pub signer_schema_version: u32,
    pub allowed_chain_mask: u8,
}

impl VaultBinding {
    pub fn permits_chain(&self, family: ChainFamily) -> bool {
        let required = match family {
            ChainFamily::NeoN3 => NEO_N3_MASK,
            ChainFamily::NeoX => NEOX_MASK,
        };
        self.allowed_chain_mask & required != 0
    }
}

/// The external authority allocates generations and fences, and CAS-compares
/// the predecessor. The genesis predecessor is all zeroes, once only.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SnapshotPosition {
    pub generation: u64,
    pub fence: u64,
    pub previous_digest: [u8; 32],
}

impl SnapshotPosition {
    fn validate(&self) -> Result<()> {
        ensure!(
            self.generation > 0 && self.fence > 0,
            "snapshot generation and fence must be positive"
        );
        ensure!(
            (self.generation == 1) == (self.previous_digest == [0; 32]),
            "snapshot predecessor is inconsistent with its generation"
        );
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SnapshotHead {
    pub binding: VaultBinding,
    pub position: SnapshotPosition,
    pub digest: [u8; 32],
}

pub struct SnapshotCipher {
    key: Zeroizing<[u8; 32]>,
    binding: VaultBinding,
}

impl SnapshotCipher {
    /// Development constructor retained for local-store tests. Production
    /// attested boot must use [`Self::from_profile`].
    pub fn new(master: &MasterKey, network: Network) -> Result<Self> {
        ensure!(
            network != Network::Private,
            "private custody snapshots require explicit chain identities"
        );
        let neo_n3_magic = network::network_magic(network);
        let neox_chain_id = network::neox_chain_id(network);
        let mut identity = Sha256::new();
        identity.update(b"neoos/custody/development-vault-identity/v2\0");
        identity.update(neo_n3_magic.to_be_bytes());
        identity.update(neox_chain_id.to_be_bytes());
        identity.update(master.bytes());
        let vault_id = identity.finalize().into();
        let mut profile = Sha256::new();
        profile.update(b"neoos/custody/development-profile/v2\0");
        profile.update(vault_id);
        let profile_hash = profile.finalize().into();
        let mut network_set = Sha256::new();
        network_set.update(b"neoos/custody/development-network-set/v2\0");
        network_set.update(neo_n3_magic.to_be_bytes());
        network_set.update(neox_chain_id.to_be_bytes());
        let binding = VaultBinding {
            vault_id,
            neo_n3_magic,
            neox_chain_id,
            profile_hash,
            network_set_hash: network_set.finalize().into(),
            root_key_commitment: root_key_commitment(master),
            snapshot_format_version: SNAPSHOT_FORMAT_VERSION,
            signer_schema_version: SIGNER_SCHEMA_VERSION,
            allowed_chain_mask: NEO_N3_MASK | NEOX_MASK,
        };
        Self::with_binding(master, binding)
    }

    pub fn from_profile(master: &MasterKey, profile: &ValidatedVaultProfile) -> Result<Self> {
        profile.verify_master(master)?;
        let network = profile.environment();
        let mut vault_identity = Sha256::new();
        vault_identity.update(b"neoos/custody/vault-identity/v2\0");
        vault_identity.update(profile.vault_id());
        let allowed_chain_mask = ChainFamily::ALL.iter().fold(0, |mask, family| {
            let chain_id = match family {
                ChainFamily::NeoN3 => u64::from(network::network_magic(network)),
                ChainFamily::NeoX => network::neox_chain_id(network),
            };
            if profile.permits(*family, chain_id) {
                mask | match family {
                    ChainFamily::NeoN3 => NEO_N3_MASK,
                    ChainFamily::NeoX => NEOX_MASK,
                }
            } else {
                mask
            }
        });
        ensure!(
            allowed_chain_mask != 0,
            "vault profile permits no signer chain"
        );
        let binding = VaultBinding {
            vault_id: vault_identity.finalize().into(),
            neo_n3_magic: network::network_magic(network),
            neox_chain_id: network::neox_chain_id(network),
            profile_hash: *profile.profile_hash(),
            network_set_hash: *profile.network_set_hash(),
            root_key_commitment: *profile.root_key_commitment(),
            snapshot_format_version: profile.document().snapshot_format_version,
            signer_schema_version: profile.document().signer_schema_version,
            allowed_chain_mask,
        };
        Self::with_binding(master, binding)
    }

    fn with_binding(master: &MasterKey, binding: VaultBinding) -> Result<Self> {
        let mut domain = b"neoos/custody/snapshot-root/v2\0".to_vec();
        domain.extend_from_slice(&binding.vault_id);
        domain.extend_from_slice(&binding.profile_hash);
        domain.extend_from_slice(&binding.network_set_hash);
        domain.extend_from_slice(&binding.root_key_commitment);
        let mut key = Zeroizing::new([0; 32]);
        Hkdf::<Sha256>::new(Some(&domain), master.bytes())
            .expand(b"neoos/custody/whole-state-aes-256-gcm/v2", key.as_mut())
            .map_err(|_| anyhow::anyhow!("snapshot key derivation failed"))?;
        Ok(Self { key, binding })
    }

    pub fn binding(&self) -> &VaultBinding {
        &self.binding
    }

    fn header(&self, position: &SnapshotPosition, salt: &[u8; 32], nonce: &[u8; 12]) -> Vec<u8> {
        let mut header = Vec::with_capacity(HEADER_BYTES);
        header.extend_from_slice(MAGIC);
        header.extend_from_slice(&self.binding.vault_id);
        header.extend_from_slice(&self.binding.neo_n3_magic.to_be_bytes());
        header.extend_from_slice(&self.binding.neox_chain_id.to_be_bytes());
        header.extend_from_slice(&self.binding.profile_hash);
        header.extend_from_slice(&self.binding.network_set_hash);
        header.extend_from_slice(&self.binding.root_key_commitment);
        header.extend_from_slice(&self.binding.snapshot_format_version.to_be_bytes());
        header.extend_from_slice(&self.binding.signer_schema_version.to_be_bytes());
        header.push(self.binding.allowed_chain_mask);
        header.extend_from_slice(&position.generation.to_be_bytes());
        header.extend_from_slice(&position.fence.to_be_bytes());
        header.extend_from_slice(&position.previous_digest);
        header.extend_from_slice(salt);
        header.extend_from_slice(nonce);
        header
    }

    fn object_key(&self, salt: &[u8; 32]) -> Result<Zeroizing<[u8; 32]>> {
        let mut key = Zeroizing::new([0; 32]);
        Hkdf::<Sha256>::new(Some(salt), self.key.as_ref())
            .expand(b"neoos/custody/snapshot-object/v1", key.as_mut())
            .map_err(|_| anyhow::anyhow!("snapshot object key derivation failed"))?;
        Ok(key)
    }

    pub fn seal(
        &self,
        plaintext: &[u8],
        position: SnapshotPosition,
    ) -> Result<(Vec<u8>, SnapshotHead)> {
        position.validate()?;
        ensure!(
            !plaintext.is_empty() && plaintext.len() <= MAX_SNAPSHOT_PLAINTEXT_BYTES,
            "snapshot plaintext size is outside the supported limit"
        );
        let mut nonce = [0; 12];
        let mut salt = [0; 32];
        OsRng.fill_bytes(&mut nonce);
        OsRng.fill_bytes(&mut salt);
        let mut envelope = self.header(&position, &salt, &nonce);
        let key = self.object_key(&salt)?;
        let cipher = Aes256Gcm::new_from_slice(key.as_ref())
            .map_err(|_| anyhow::anyhow!("snapshot cipher initialization failed"))?;
        let ciphertext = cipher
            .encrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: plaintext,
                    aad: &envelope,
                },
            )
            .map_err(|_| anyhow::anyhow!("snapshot encryption failed"))?;
        envelope.extend_from_slice(&ciphertext);
        let head = SnapshotHead {
            binding: self.binding.clone(),
            position,
            digest: Sha256::digest(&envelope).into(),
        };
        Ok((envelope, head))
    }

    /// The expected head must come from the trusted external CAS store, never
    /// from the parent host or the snapshot's own header. A valid old envelope
    /// fails against the current head even though its AEAD tag remains valid.
    pub fn open(&self, envelope: &[u8], expected: &SnapshotHead) -> Result<Zeroizing<Vec<u8>>> {
        expected.position.validate()?;
        ensure!(
            envelope.len() > HEADER_BYTES + TAG_BYTES && envelope.len() <= MAX_SNAPSHOT_BYTES,
            "snapshot envelope size is outside the supported limit"
        );
        ensure!(
            expected.binding == self.binding,
            "snapshot vault or network identity mismatch"
        );
        let digest: [u8; 32] = Sha256::digest(envelope).into();
        ensure!(
            digest == expected.digest,
            "snapshot does not match the authoritative head"
        );
        let nonce: [u8; 12] = envelope[HEADER_BYTES - 12..HEADER_BYTES].try_into()?;
        let salt: [u8; 32] = envelope[HEADER_BYTES - 44..HEADER_BYTES - 12].try_into()?;
        let header = self.header(&expected.position, &salt, &nonce);
        ensure!(
            envelope[..HEADER_BYTES] == header,
            "snapshot metadata does not match the authoritative head"
        );
        let key = self.object_key(&salt)?;
        let cipher = Aes256Gcm::new_from_slice(key.as_ref())
            .map_err(|_| anyhow::anyhow!("snapshot cipher initialization failed"))?;
        match cipher.decrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &envelope[HEADER_BYTES..],
                aad: &header,
            },
        ) {
            Ok(plaintext) => Ok(Zeroizing::new(plaintext)),
            Err(_) => bail!("snapshot authentication failed"),
        }
    }
}
