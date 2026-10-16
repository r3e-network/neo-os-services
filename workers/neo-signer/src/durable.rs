//! Commit-before-release state machine for custody mutations.
//!
//! The coordinator owns object durability, linearizable CAS, fencing and the
//! receipt key. This module owns exact candidate construction and independent
//! receipt verification inside the signer. Any ambiguous failure fences the
//! process; callers must restore from an authenticated HEAD before retrying.

use std::{
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result};
use p256::ecdsa::{signature::Verifier, Signature, VerifyingKey};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    snapshot::{SnapshotCipher, SnapshotHead, SnapshotPosition, VaultBinding, MAX_SNAPSHOT_BYTES},
    store::Store,
    vault_profile::ValidatedVaultProfile,
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuthorityHead {
    pub binding: VaultBinding,
    pub generation: u64,
    pub snapshot_fence: u64,
    pub previous_snapshot_sha256: [u8; 32],
    pub snapshot_sha256: [u8; 32],
    pub epoch: u64,
    pub owner_id: String,
    pub head_fingerprint: [u8; 32],
    pub lease_expires_at_ms: u64,
    pub commit_id: Option<String>,
    pub snapshot: Option<AuthoritySnapshot>,
    pub updated_at: String,
}

impl AuthorityHead {
    pub fn genesis(binding: VaultBinding, epoch: u64, owner_id: String) -> Result<Self> {
        let head = Self {
            binding,
            generation: 0,
            snapshot_fence: 0,
            previous_snapshot_sha256: [0; 32],
            snapshot_sha256: [0; 32],
            epoch,
            owner_id,
            head_fingerprint: [1; 32],
            lease_expires_at_ms: u64::MAX,
            commit_id: None,
            snapshot: None,
            updated_at: "1970-01-01T00:00:00.000Z".to_string(),
        };
        head.validate()?;
        Ok(head)
    }

    pub(crate) fn validate(&self) -> Result<()> {
        anyhow::ensure!(self.epoch > 0, "durable authority epoch must be positive");
        validate_identifier(&self.owner_id, "owner id", 128)?;
        anyhow::ensure!(
            self.head_fingerprint != [0; 32],
            "HEAD fingerprint must not be zero"
        );
        anyhow::ensure!(
            self.lease_expires_at_ms > 0,
            "HEAD lease expiry must be positive"
        );
        if self.generation == 0 {
            anyhow::ensure!(
                self.snapshot_fence == 0
                    && self.previous_snapshot_sha256 == [0; 32]
                    && self.snapshot_sha256 == [0; 32]
                    && self.commit_id.is_none()
                    && self.snapshot.is_none(),
                "durable authority genesis is inconsistent"
            );
        } else {
            anyhow::ensure!(
                self.snapshot_fence > 0 && self.snapshot_fence <= self.epoch,
                "HEAD snapshot fence exceeds its lease epoch"
            );
            anyhow::ensure!(
                self.snapshot_sha256 != [0; 32],
                "HEAD snapshot hash is zero"
            );
            anyhow::ensure!(
                (self.generation == 1) == (self.previous_snapshot_sha256 == [0; 32]),
                "HEAD predecessor is inconsistent with its generation"
            );
            let snapshot = self
                .snapshot
                .as_ref()
                .context("non-genesis HEAD has no immutable S3 snapshot")?;
            snapshot.validate()?;
            anyhow::ensure!(
                snapshot.sha256 == self.snapshot_sha256,
                "HEAD object hash mismatch"
            );
            validate_identifier(
                self.commit_id
                    .as_deref()
                    .context("non-genesis HEAD has no commit id")?,
                "commit id",
                128,
            )?;
        }
        validate_text(&self.updated_at, "HEAD update time", 64)?;
        Ok(())
    }

    pub fn is_genesis(&self) -> bool {
        self.generation == 0
    }

    pub fn ensure_live(&self, now_ms: u64) -> Result<()> {
        anyhow::ensure!(
            self.lease_expires_at_ms > now_ms,
            "durable authority lease is expired"
        );
        Ok(())
    }

    pub fn snapshot_head(&self) -> Result<SnapshotHead> {
        anyhow::ensure!(!self.is_genesis(), "genesis has no snapshot to restore");
        Ok(SnapshotHead {
            binding: self.binding.clone(),
            position: SnapshotPosition {
                generation: self.generation,
                fence: self.snapshot_fence,
                previous_digest: self.previous_snapshot_sha256,
            },
            digest: self.snapshot_sha256,
        })
    }

    pub fn same_snapshot(&self, other: &Self) -> bool {
        self.binding == other.binding
            && self.generation == other.generation
            && self.snapshot_fence == other.snapshot_fence
            && self.previous_snapshot_sha256 == other.previous_snapshot_sha256
            && self.snapshot_sha256 == other.snapshot_sha256
            && self.commit_id == other.commit_id
            && self.snapshot == other.snapshot
    }

    pub fn same_lease_identity(&self, other: &Self) -> bool {
        self.same_snapshot(other)
            && self.epoch == other.epoch
            && self.owner_id == other.owner_id
            && self.head_fingerprint != [0; 32]
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuthoritySnapshot {
    pub bucket: String,
    pub key: String,
    pub version_id: String,
    pub sha256: [u8; 32],
    pub size_bytes: usize,
}

impl AuthoritySnapshot {
    fn validate(&self) -> Result<()> {
        validate_text(&self.bucket, "snapshot bucket", 255)?;
        validate_text(&self.key, "snapshot key", 1024)?;
        validate_text(&self.version_id, "snapshot version id", 1024)?;
        anyhow::ensure!(self.sha256 != [0; 32], "snapshot object hash is zero");
        anyhow::ensure!(self.size_bytes > 0, "snapshot object size is zero");
        anyhow::ensure!(
            self.size_bytes <= MAX_SNAPSHOT_BYTES,
            "snapshot object exceeds the configured limit"
        );
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommitCandidate {
    pub commit_id: String,
    pub mutation_digest: [u8; 32],
    pub previous: AuthorityHead,
    pub next: SnapshotHead,
    pub envelope: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommitReceipt {
    pub network: String,
    pub vault_id: [u8; 32],
    pub profile_hash: [u8; 32],
    pub network_set_hash: [u8; 32],
    pub root_key_commitment: [u8; 32],
    pub commit_id: String,
    pub operation_digest: [u8; 32],
    pub mutation_digest: [u8; 32],
    pub previous_generation: u64,
    pub previous_snapshot_fence: u64,
    pub previous_snapshot_sha256: [u8; 32],
    pub generation: u64,
    pub snapshot_sha256: [u8; 32],
    pub epoch: u64,
    pub snapshot_fence: u64,
    pub owner_id: String,
    pub snapshot_bucket: String,
    pub snapshot_key: String,
    pub snapshot_version_id: String,
    pub snapshot_size_bytes: usize,
    pub lease_expires_at_ms: u64,
    pub committed_at_ms: u64,
    pub receipt_key_id: String,
    pub receipt_id: [u8; 32],
    pub payload: Vec<u8>,
    pub signature_der: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommitResult {
    pub head: AuthorityHead,
    pub receipt: CommitReceipt,
}

pub trait DurableCoordinator: Send + Sync {
    /// Persist `candidate.envelope`, independently verify its exact object, and
    /// advance HEAD with one linearizable conditional transaction.
    fn commit(&self, candidate: &CommitCandidate) -> Result<CommitResult>;

    /// Re-read/renew the exact lease. Health is successful only when the remote
    /// authority confirms this process still owns the live HEAD.
    fn verify_lease(&self, head: &AuthorityHead) -> Result<AuthorityHead>;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DurableStatus {
    Ready(Box<AuthorityHead>),
    Fenced { reason: String },
}

enum Phase {
    Ready(Box<AuthorityHead>),
    Fenced { reason: String },
}

pub struct DurableState {
    profile: Arc<ValidatedVaultProfile>,
    cipher: SnapshotCipher,
    coordinator: Arc<dyn DurableCoordinator>,
    phase: Mutex<Phase>,
}

impl DurableState {
    /// Construct only after the caller has authenticated HEAD and acquired the
    /// exact owner/epoch lease represented by `head`.
    pub fn from_verified_lease(
        profile: Arc<ValidatedVaultProfile>,
        cipher: SnapshotCipher,
        coordinator: Arc<dyn DurableCoordinator>,
        head: AuthorityHead,
    ) -> Result<Self> {
        head.validate()?;
        validate_binding(profile.as_ref(), cipher.binding(), &head.binding)?;
        Ok(Self {
            profile,
            cipher,
            coordinator,
            phase: Mutex::new(Phase::Ready(Box::new(head))),
        })
    }

    pub fn status(&self) -> DurableStatus {
        match self.phase.lock() {
            Ok(phase) => match &*phase {
                Phase::Ready(head) => DurableStatus::Ready(head.clone()),
                Phase::Fenced { reason } => DurableStatus::Fenced {
                    reason: reason.clone(),
                },
            },
            Err(_) => DurableStatus::Fenced {
                reason: "durable state lock poisoned".to_string(),
            },
        }
    }

    pub fn ensure_ready(&self) -> Result<()> {
        match self.status() {
            DurableStatus::Ready(head) => head.ensure_live(now_millis()?),
            DurableStatus::Fenced { reason } => anyhow::bail!("durable signer is fenced: {reason}"),
        }
    }

    pub fn verify_remote_lease(&self) -> Result<AuthorityHead> {
        let mut phase = self
            .phase
            .lock()
            .map_err(|_| anyhow::anyhow!("durable state lock is poisoned"))?;
        let previous = match &*phase {
            Phase::Ready(head) => head.as_ref().clone(),
            Phase::Fenced { reason } => anyhow::bail!("durable signer is fenced: {reason}"),
        };
        let result = self.coordinator.verify_lease(&previous);
        match result {
            Ok(head) => {
                validate_binding(self.profile.as_ref(), self.cipher.binding(), &head.binding)?;
                anyhow::ensure!(
                    head.same_lease_identity(&previous),
                    "remote lease verification changed HEAD identity"
                );
                *phase = Phase::Ready(Box::new(head.clone()));
                Ok(head)
            }
            Err(error) => {
                *phase = Phase::Fenced {
                    reason: bounded_reason(&error),
                };
                Err(error)
            }
        }
    }

    pub(crate) fn fence(&self, reason: &str) {
        if let Ok(mut phase) = self.phase.lock() {
            *phase = Phase::Fenced {
                reason: reason.chars().take(240).collect(),
            };
        }
    }

    /// Snapshot and commit the exact SQLite state. The returned HEAD is proof
    /// that the receipt was exact and cryptographically valid; no caller-visible
    /// operation result may leave the signer before this returns successfully.
    pub fn commit(&self, store: &Store, operation_digest: [u8; 32]) -> Result<AuthorityHead> {
        let mut phase = self
            .phase
            .lock()
            .map_err(|_| anyhow::anyhow!("durable state lock is poisoned"))?;
        let previous = match &*phase {
            Phase::Ready(head) => head.as_ref().clone(),
            Phase::Fenced { reason } => anyhow::bail!("durable signer is fenced: {reason}"),
        };
        let result = self.commit_from(store, operation_digest, &previous);
        match result {
            Ok(head) => {
                *phase = Phase::Ready(Box::new(head.clone()));
                Ok(head)
            }
            Err(error) => {
                *phase = Phase::Fenced {
                    reason: bounded_reason(&error),
                };
                Err(error)
            }
        }
    }

    fn commit_from(
        &self,
        store: &Store,
        operation_digest: [u8; 32],
        previous: &AuthorityHead,
    ) -> Result<AuthorityHead> {
        validate_binding(
            self.profile.as_ref(),
            self.cipher.binding(),
            &previous.binding,
        )?;
        let generation = previous
            .generation
            .checked_add(1)
            .context("durable snapshot generation overflow")?;
        let position = SnapshotPosition {
            generation,
            fence: previous.epoch,
            previous_digest: previous.snapshot_sha256,
        };
        let (envelope, next) = store
            .sealed_snapshot(&self.cipher, position)
            .context("failed to create the custody state candidate")?;
        let candidate = CommitCandidate {
            commit_id: Uuid::new_v4().to_string(),
            mutation_digest: operation_digest,
            previous: previous.clone(),
            next,
            envelope,
        };
        let result = self
            .coordinator
            .commit(&candidate)
            .context("durable coordinator commit failed or was ambiguous")?;
        self.verify_receipt(&candidate, &result)?;
        Ok(result.head)
    }

    fn verify_receipt(&self, candidate: &CommitCandidate, result: &CommitResult) -> Result<()> {
        let receipt = &result.receipt;
        let expected = &candidate.next;
        anyhow::ensure!(
            receipt.network == self.profile.environment().to_string(),
            "commit receipt network mismatch"
        );
        anyhow::ensure!(
            receipt.vault_id == expected.binding.vault_id,
            "commit receipt vault mismatch"
        );
        anyhow::ensure!(
            receipt.profile_hash == expected.binding.profile_hash,
            "commit receipt profile mismatch"
        );
        anyhow::ensure!(
            receipt.network_set_hash == expected.binding.network_set_hash,
            "commit receipt network set mismatch"
        );
        anyhow::ensure!(
            receipt.commit_id == candidate.commit_id,
            "commit receipt id mismatch"
        );
        anyhow::ensure!(
            receipt.mutation_digest == candidate.mutation_digest,
            "commit receipt mutation mismatch"
        );
        anyhow::ensure!(
            receipt.previous_generation == candidate.previous.generation,
            "commit receipt predecessor generation mismatch"
        );
        anyhow::ensure!(
            receipt.previous_snapshot_fence == candidate.previous.snapshot_fence,
            "commit receipt predecessor fence mismatch"
        );
        anyhow::ensure!(
            receipt.previous_snapshot_sha256 == candidate.previous.snapshot_sha256,
            "commit receipt predecessor hash mismatch"
        );
        anyhow::ensure!(
            receipt.generation == expected.position.generation,
            "commit receipt generation mismatch"
        );
        anyhow::ensure!(
            receipt.snapshot_sha256 == expected.digest,
            "commit receipt snapshot mismatch"
        );
        anyhow::ensure!(
            receipt.epoch == candidate.previous.epoch,
            "commit receipt epoch mismatch"
        );
        anyhow::ensure!(
            receipt.snapshot_fence == expected.position.fence,
            "commit receipt snapshot fence mismatch"
        );
        anyhow::ensure!(
            receipt.owner_id == candidate.previous.owner_id,
            "commit receipt owner mismatch"
        );
        anyhow::ensure!(
            receipt.root_key_commitment == expected.binding.root_key_commitment,
            "commit receipt root mismatch"
        );
        anyhow::ensure!(
            receipt.snapshot_size_bytes == candidate.envelope.len(),
            "commit receipt snapshot size mismatch"
        );
        anyhow::ensure!(
            receipt.committed_at_ms > 0 && receipt.lease_expires_at_ms > receipt.committed_at_ms,
            "commit receipt lease time is invalid"
        );
        validate_text(&receipt.snapshot_bucket, "snapshot bucket", 255)?;
        validate_text(&receipt.snapshot_key, "snapshot key", 1024)?;
        validate_text(&receipt.snapshot_version_id, "snapshot version id", 1024)?;
        let expected_operation = canonical_operation(candidate, receipt)?;
        let expected_operation_digest: [u8; 32] = Sha256::digest(&expected_operation).into();
        anyhow::ensure!(
            receipt.operation_digest == expected_operation_digest,
            "commit operation digest mismatch"
        );
        let canonical = canonical_receipt(receipt);
        anyhow::ensure!(
            receipt.payload == canonical,
            "commit receipt payload bytes mismatch"
        );
        let expected_receipt_id: [u8; 32] = Sha256::digest(&canonical).into();
        anyhow::ensure!(
            receipt.receipt_id == expected_receipt_id,
            "commit receipt id mismatch"
        );
        let pinned = self
            .profile
            .document()
            .coordinator
            .receipt_keys
            .iter()
            .find(|key| key.key_id == receipt.receipt_key_id)
            .context("commit receipt used an unpinned key id")?;
        let public_key = hex::decode(&pinned.public_key_sec1_hex)
            .context("pinned receipt public key is not hexadecimal")?;
        let verifying_key = VerifyingKey::from_sec1_bytes(&public_key)
            .context("pinned receipt public key is invalid")?;
        let signature = Signature::from_der(&receipt.signature_der)
            .context("commit receipt signature is not canonical DER ECDSA")?;
        verifying_key
            .verify(&canonical, &signature)
            .context("commit receipt signature verification failed")?;
        let head = &result.head;
        head.validate()?;
        anyhow::ensure!(
            head.binding == expected.binding,
            "committed HEAD binding mismatch"
        );
        anyhow::ensure!(
            head.generation == expected.position.generation,
            "committed HEAD generation mismatch"
        );
        anyhow::ensure!(
            head.snapshot_fence == expected.position.fence,
            "committed HEAD fence mismatch"
        );
        anyhow::ensure!(
            head.previous_snapshot_sha256 == candidate.previous.snapshot_sha256,
            "committed HEAD predecessor mismatch"
        );
        anyhow::ensure!(
            head.snapshot_sha256 == expected.digest,
            "committed HEAD hash mismatch"
        );
        anyhow::ensure!(
            head.epoch == candidate.previous.epoch && head.owner_id == candidate.previous.owner_id,
            "committed HEAD lease mismatch"
        );
        anyhow::ensure!(
            head.lease_expires_at_ms == receipt.lease_expires_at_ms,
            "committed HEAD lease expiry mismatch"
        );
        anyhow::ensure!(
            head.commit_id.as_deref() == Some(candidate.commit_id.as_str()),
            "committed HEAD commit id mismatch"
        );
        anyhow::ensure!(
            head.snapshot.as_ref()
                == Some(&AuthoritySnapshot {
                    bucket: receipt.snapshot_bucket.clone(),
                    key: receipt.snapshot_key.clone(),
                    version_id: receipt.snapshot_version_id.clone(),
                    sha256: receipt.snapshot_sha256,
                    size_bytes: receipt.snapshot_size_bytes,
                }),
            "committed HEAD snapshot object mismatch"
        );
        Ok(())
    }
}

pub fn operation_digest(action: &str, key_id: Option<&str>) -> [u8; 32] {
    let mut encoded = b"neoos/custody/operation/v1\0".to_vec();
    push_field(&mut encoded, action.as_bytes());
    push_field(&mut encoded, key_id.unwrap_or("").as_bytes());
    Sha256::digest(encoded).into()
}

pub fn canonical_receipt(receipt: &CommitReceipt) -> Vec<u8> {
    let mut encoded = b"neoos/custody-state-receipt/v2\0".to_vec();
    push_field(&mut encoded, receipt.network.as_bytes());
    encoded.extend_from_slice(&receipt.vault_id);
    encoded.extend_from_slice(&receipt.profile_hash);
    encoded.extend_from_slice(&receipt.network_set_hash);
    encoded.extend_from_slice(&receipt.root_key_commitment);
    push_field(&mut encoded, receipt.commit_id.as_bytes());
    encoded.extend_from_slice(&receipt.operation_digest);
    encoded.extend_from_slice(&receipt.mutation_digest);
    encoded.extend_from_slice(&receipt.previous_generation.to_be_bytes());
    encoded.extend_from_slice(&receipt.previous_snapshot_fence.to_be_bytes());
    encoded.extend_from_slice(&receipt.previous_snapshot_sha256);
    encoded.extend_from_slice(&receipt.generation.to_be_bytes());
    encoded.extend_from_slice(&receipt.snapshot_sha256);
    encoded.extend_from_slice(&receipt.epoch.to_be_bytes());
    encoded.extend_from_slice(&receipt.snapshot_fence.to_be_bytes());
    push_field(&mut encoded, receipt.owner_id.as_bytes());
    push_field(&mut encoded, receipt.snapshot_bucket.as_bytes());
    push_field(&mut encoded, receipt.snapshot_key.as_bytes());
    push_field(&mut encoded, receipt.snapshot_version_id.as_bytes());
    encoded.extend_from_slice(&(receipt.snapshot_size_bytes as u64).to_be_bytes());
    encoded.extend_from_slice(&receipt.lease_expires_at_ms.to_be_bytes());
    encoded.extend_from_slice(&receipt.committed_at_ms.to_be_bytes());
    push_field(&mut encoded, receipt.receipt_key_id.as_bytes());
    encoded
}

pub fn canonical_operation(
    candidate: &CommitCandidate,
    receipt: &CommitReceipt,
) -> Result<Vec<u8>> {
    anyhow::ensure!(
        receipt.snapshot_size_bytes == candidate.envelope.len(),
        "snapshot size mismatch"
    );
    anyhow::ensure!(
        candidate.previous.binding == candidate.next.binding,
        "commit candidate changed vault binding"
    );
    let network = candidate.next.binding.environment()?.to_string();
    anyhow::ensure!(
        receipt.network == network,
        "commit operation network mismatch"
    );
    let mut encoded = b"neoos/custody-state-operation/v2\0".to_vec();
    push_field(&mut encoded, network.as_bytes());
    encoded.extend_from_slice(&candidate.next.binding.vault_id);
    encoded.extend_from_slice(&candidate.next.binding.profile_hash);
    encoded.extend_from_slice(&candidate.next.binding.network_set_hash);
    encoded.extend_from_slice(&candidate.next.binding.root_key_commitment);
    push_field(&mut encoded, candidate.previous.owner_id.as_bytes());
    encoded.extend_from_slice(&candidate.previous.epoch.to_be_bytes());
    encoded.extend_from_slice(&candidate.next.position.generation.to_be_bytes());
    encoded.extend_from_slice(&candidate.next.position.fence.to_be_bytes());
    encoded.extend_from_slice(&candidate.previous.generation.to_be_bytes());
    encoded.extend_from_slice(&candidate.previous.snapshot_fence.to_be_bytes());
    encoded.extend_from_slice(&candidate.previous.snapshot_sha256);
    push_field(&mut encoded, candidate.commit_id.as_bytes());
    encoded.extend_from_slice(&candidate.mutation_digest);
    push_field(&mut encoded, receipt.snapshot_bucket.as_bytes());
    push_field(&mut encoded, receipt.snapshot_key.as_bytes());
    push_field(&mut encoded, receipt.snapshot_version_id.as_bytes());
    encoded.extend_from_slice(&candidate.next.digest);
    encoded.extend_from_slice(&(candidate.envelope.len() as u64).to_be_bytes());
    Ok(encoded)
}

fn validate_binding(
    profile: &ValidatedVaultProfile,
    cipher: &VaultBinding,
    head: &VaultBinding,
) -> Result<()> {
    anyhow::ensure!(
        cipher == head,
        "durable HEAD does not match the snapshot cipher binding"
    );
    anyhow::ensure!(
        cipher.environment()? == profile.environment(),
        "durable HEAD profile network mismatch"
    );
    anyhow::ensure!(
        cipher.profile_hash == *profile.profile_hash(),
        "durable HEAD profile hash mismatch"
    );
    anyhow::ensure!(
        cipher.network_set_hash == *profile.network_set_hash(),
        "durable HEAD network-set hash mismatch"
    );
    anyhow::ensure!(
        cipher.root_key_commitment == *profile.root_key_commitment(),
        "durable HEAD root commitment mismatch"
    );
    Ok(())
}

fn validate_identifier(value: &str, name: &str, maximum: usize) -> Result<()> {
    anyhow::ensure!(
        !value.is_empty() && value.len() <= maximum,
        "{name} length is invalid"
    );
    anyhow::ensure!(
        value.bytes().all(|byte| byte.is_ascii_alphanumeric()
            || matches!(byte, b'-' | b'_' | b'.' | b'/' | b'+' | b'=')),
        "{name} contains unsafe characters"
    );
    Ok(())
}

fn validate_text(value: &str, name: &str, maximum: usize) -> Result<()> {
    anyhow::ensure!(
        !value.is_empty() && value.len() <= maximum && !value.chars().any(char::is_control),
        "{name} is not a bounded canonical string"
    );
    Ok(())
}

fn now_millis() -> Result<u64> {
    u64::try_from(SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis())
        .context("system time exceeds u64 milliseconds")
}

fn push_field(output: &mut Vec<u8>, value: &[u8]) {
    let length = u32::try_from(value.len()).expect("validated durable field length fits u32");
    output.extend_from_slice(&length.to_be_bytes());
    output.extend_from_slice(value);
}

fn bounded_reason(error: &anyhow::Error) -> String {
    let reason = error.to_string();
    reason.chars().take(240).collect()
}
