//! Synthetic external authority; recovery, SQLite, encryption and receipt
//! verification below are the production implementations, never preseeded.
use super::*;
use crate::durable::{canonical_operation, canonical_receipt, CommitReceipt};
use crate::enrollment::tests::{fixture, ROOT};
use p256::ecdsa::{signature::Signer, Signature, SigningKey};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Condvar,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Fault {
    None,
    Upload,
    LostReply,
    BadReceipt,
    ExpiredReceipt,
    FiniteReceipt,
    SlowDownload,
}

pub(crate) struct Authority {
    pub profile: Arc<ValidatedVaultProfile>,
    pub head: Mutex<Option<AuthorityHead>>,
    pub envelope: Mutex<Vec<u8>>,
    pub candidates: Mutex<Vec<CommitCandidate>>,
    pub fault: Mutex<Fault>,
    pub authorizations: AtomicUsize,
    pub downloads: AtomicUsize,
    pub hold: Arc<(Mutex<bool>, Condvar)>,
    pub entered: tokio::sync::Notify,
    pub head_race: Mutex<Option<Arc<(Mutex<usize>, Condvar)>>>,
}

impl Authority {
    pub(crate) fn new(profile: Arc<ValidatedVaultProfile>) -> Arc<Self> {
        Arc::new(Self {
            profile,
            head: Mutex::new(None),
            envelope: Mutex::new(Vec::new()),
            candidates: Mutex::new(Vec::new()),
            fault: Mutex::new(Fault::None),
            authorizations: AtomicUsize::new(0),
            downloads: AtomicUsize::new(0),
            hold: Arc::new((Mutex::new(false), Condvar::new())),
            entered: tokio::sync::Notify::new(),
            head_race: Mutex::new(None),
        })
    }
    pub(crate) fn expire(&self) {
        if let Some(head) = self.head.lock().unwrap().as_mut() {
            head.lease_expires_at_ms = 1;
        }
    }
    pub(crate) fn recoverer(self: &Arc<Self>) -> crate::provision::VaultRecoverer {
        let authority = self.clone();
        Arc::new(move |profile, _, master, target, enrollment| {
            let cipher =
                SnapshotCipher::from_profile(&master, &profile).map_err(|e| e.to_string())?;
            recover_enrolled_with_authority(
                profile,
                master,
                target,
                authority.clone(),
                cipher,
                enrollment,
            )
            .map_err(|e| e.to_string())
        })
    }
    pub(crate) fn recoverer_for_owner(
        self: &Arc<Self>,
        owner: &str,
    ) -> crate::provision::VaultRecoverer {
        let authority = Arc::new(BootAuthority {
            state: self.clone(),
            owner: owner.to_string(),
        });
        Arc::new(move |profile, _, master, target, enrollment| {
            let cipher =
                SnapshotCipher::from_profile(&master, &profile).map_err(|e| e.to_string())?;
            recover_enrolled_with_authority(
                profile,
                master,
                target,
                authority.clone(),
                cipher,
                enrollment,
            )
            .map_err(|e| e.to_string())
        })
    }

    pub(crate) fn release_hold(&self) {
        *self.hold.0.lock().unwrap() = false;
        self.hold.1.notify_all();
    }
}

impl Authority {
    fn takeover_as(
        &self,
        previous: Option<&AuthorityHead>,
        owner: Option<&str>,
    ) -> Result<AuthorityHead> {
        let mut current = self.head.lock().unwrap();
        anyhow::ensure!(
            current.as_ref() == previous,
            "takeover predecessor conflict"
        );
        let mut next = if let Some(head) = previous {
            anyhow::ensure!(
                head.lease_expires_at_ms <= now_millis()?,
                "competing owner lease is live"
            );
            let mut next = head.clone();
            next.epoch += 1;
            next.owner_id = owner
                .map(str::to_string)
                .unwrap_or_else(|| format!("owner-{}", next.epoch));
            next.lease_expires_at_ms = u64::MAX;
            next.head_fingerprint = [next.epoch as u8; 32];
            next
        } else {
            let cipher = SnapshotCipher::from_profile(&MasterKey::from_bytes(ROOT), &self.profile)?;
            AuthorityHead::genesis(
                cipher.binding().clone(),
                1,
                owner.unwrap_or("owner-1").into(),
            )?
        };
        if *self.fault.lock().unwrap() == Fault::SlowDownload {
            next.lease_expires_at_ms = now_millis()? + 250;
        }
        *current = Some(next.clone());
        Ok(next)
    }
}

impl RecoveryAuthority for Authority {
    fn head(&self) -> Result<Option<AuthorityHead>> {
        let observed = self.head.lock().unwrap().clone();
        let race = self.head_race.lock().unwrap().clone();
        if let Some(race) = race {
            let (lock, wake) = &*race;
            let mut readers = lock.lock().unwrap();
            *readers += 1;
            wake.notify_all();
            let (readers, _) = wake
                .wait_timeout_while(readers, Duration::from_secs(5), |n| *n < 2)
                .unwrap();
            anyhow::ensure!(*readers == 2, "two-owner HEAD barrier did not complete");
        }
        Ok(observed)
    }
    fn takeover(&self, previous: Option<&AuthorityHead>) -> Result<AuthorityHead> {
        self.takeover_as(previous, None)
    }
    fn download_snapshot(&self, head: &AuthorityHead) -> Result<Vec<u8>> {
        anyhow::ensure!(
            self.head.lock().unwrap().as_ref() == Some(head),
            "download exact HEAD"
        );
        self.downloads.fetch_add(1, Ordering::SeqCst);
        let bytes = self.envelope.lock().unwrap().clone();
        if *self.fault.lock().unwrap() == Fault::SlowDownload {
            wait_until_expired(head.lease_expires_at_ms)?;
        }
        Ok(bytes)
    }
}

impl DurableCoordinator for Authority {
    fn verify_lease(&self, head: &AuthorityHead) -> Result<AuthorityHead> {
        anyhow::ensure!(
            self.head.lock().unwrap().as_ref() == Some(head),
            "stale lease"
        );
        head.ensure_live(now_millis()?)?;
        Ok(head.clone())
    }
    fn commit(&self, candidate: &CommitCandidate) -> Result<CommitResult> {
        self.entered.notify_one();
        let (lock, wake) = &*self.hold;
        let hold = lock.lock().unwrap();
        let (hold, _) = wake
            .wait_timeout_while(hold, Duration::from_secs(10), |h| *h)
            .unwrap();
        anyhow::ensure!(!*hold, "test commit barrier timeout");
        drop(hold);
        self.verify_lease(&candidate.previous)?;
        self.candidates.lock().unwrap().push(candidate.clone());
        if *self.fault.lock().unwrap() == Fault::Upload {
            bail!("injected upload ambiguity");
        }
        let cfg = &self.profile.document().coordinator;
        let mut receipt = CommitReceipt {
            network: "testnet".into(),
            vault_id: candidate.next.binding.vault_id,
            profile_hash: candidate.next.binding.profile_hash,
            network_set_hash: candidate.next.binding.network_set_hash,
            root_key_commitment: candidate.next.binding.root_key_commitment,
            commit_id: candidate.commit_id.clone(),
            operation_digest: [0; 32],
            mutation_digest: candidate.mutation_digest,
            previous_generation: candidate.previous.generation,
            previous_snapshot_fence: candidate.previous.snapshot_fence,
            previous_snapshot_sha256: candidate.previous.snapshot_sha256,
            generation: candidate.next.position.generation,
            snapshot_sha256: candidate.next.digest,
            epoch: candidate.previous.epoch,
            snapshot_fence: candidate.next.position.fence,
            owner_id: candidate.previous.owner_id.clone(),
            snapshot_bucket: cfg.snapshot_bucket.clone(),
            snapshot_key: format!("{}/{}.bin", cfg.snapshot_prefix, candidate.commit_id),
            snapshot_version_id: format!("version-{}", candidate.next.position.generation),
            snapshot_size_bytes: candidate.envelope.len(),
            lease_expires_at_ms: u64::MAX,
            committed_at_ms: 1789100000000,
            receipt_key_id: "receipt-r1".into(),
            receipt_id: [0; 32],
            payload: Vec::new(),
            signature_der: Vec::new(),
        };
        if matches!(
            *self.fault.lock().unwrap(),
            Fault::ExpiredReceipt | Fault::FiniteReceipt
        ) {
            // Sign while live; delivery or API publication is then delayed.
            receipt.committed_at_ms = now_millis()?;
            receipt.lease_expires_at_ms = receipt.committed_at_ms + 250;
        }
        receipt.operation_digest = Sha256::digest(canonical_operation(candidate, &receipt)?).into();
        receipt.payload = canonical_receipt(&receipt);
        receipt.receipt_id = Sha256::digest(&receipt.payload).into();
        let key = SigningKey::from_slice(&[7; 32]).unwrap();
        let signature: Signature = key.sign(&receipt.payload);
        receipt.signature_der = signature.to_der().as_bytes().to_vec();
        let head = AuthorityHead {
            binding: candidate.next.binding.clone(),
            generation: candidate.next.position.generation,
            snapshot_fence: candidate.next.position.fence,
            previous_snapshot_sha256: candidate.previous.snapshot_sha256,
            snapshot_sha256: candidate.next.digest,
            epoch: candidate.previous.epoch,
            owner_id: candidate.previous.owner_id.clone(),
            head_fingerprint: [candidate.next.position.generation as u8; 32],
            lease_expires_at_ms: receipt.lease_expires_at_ms,
            commit_id: Some(candidate.commit_id.clone()),
            updated_at: "2026-10-19T00:00:00.000Z".into(),
            snapshot: Some(AuthoritySnapshot {
                bucket: receipt.snapshot_bucket.clone(),
                key: receipt.snapshot_key.clone(),
                version_id: receipt.snapshot_version_id.clone(),
                sha256: candidate.next.digest,
                size_bytes: candidate.envelope.len(),
            }),
        };
        // Atomic authority publication is represented under the head lock.
        let mut current = self.head.lock().unwrap();
        anyhow::ensure!(
            current.as_ref() == Some(&candidate.previous),
            "commit predecessor conflict"
        );
        *self.envelope.lock().unwrap() = candidate.envelope.clone();
        *current = Some(head.clone());
        drop(current);
        match *self.fault.lock().unwrap() {
            Fault::LostReply => bail!("injected lost committed reply"),
            Fault::BadReceipt => receipt.signature_der[8] ^= 1,
            Fault::ExpiredReceipt => wait_until_expired(receipt.lease_expires_at_ms)?,
            _ => {}
        }
        Ok(CommitResult { head, receipt })
    }
}

pub(crate) fn wait_until_expired(expires_ms: u64) -> Result<()> {
    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    while now_millis()? < expires_ms {
        anyhow::ensure!(
            std::time::Instant::now() < deadline,
            "test lease delay exceeded bound"
        );
        std::thread::sleep(Duration::from_millis(1));
    }
    Ok(())
}

// Distinct boot identities sharing one CAS repository. This is external
// authority simulation only; each router still runs the real recovery path.
struct BootAuthority {
    state: Arc<Authority>,
    owner: String,
}
impl RecoveryAuthority for BootAuthority {
    fn head(&self) -> Result<Option<AuthorityHead>> {
        self.state.head()
    }
    fn takeover(&self, previous: Option<&AuthorityHead>) -> Result<AuthorityHead> {
        self.state.takeover_as(previous, Some(&self.owner))
    }
    fn download_snapshot(&self, head: &AuthorityHead) -> Result<Vec<u8>> {
        self.state.download_snapshot(head)
    }
}
impl DurableCoordinator for BootAuthority {
    fn verify_lease(&self, head: &AuthorityHead) -> Result<AuthorityHead> {
        anyhow::ensure!(head.owner_id == self.owner, "wrong boot owner");
        self.state.verify_lease(head)
    }
    fn commit(&self, candidate: &CommitCandidate) -> Result<CommitResult> {
        anyhow::ensure!(
            candidate.previous.owner_id == self.owner,
            "wrong boot owner"
        );
        self.state.commit(candidate)
    }
}

fn recover_fixture(
    authority: Arc<Authority>,
    target: &Path,
    enrollment: &crate::enrollment::ValidatedGenesisEnrollment,
    allow_release: bool,
) -> Result<SignerService> {
    let authorize = || {
        assert!(
            allow_release,
            "committed restore attempted original credential release"
        );
        authority.authorizations.fetch_add(1, Ordering::SeqCst);
        Ok(())
    };
    let attempt = crate::provision::EnrollmentAttempt {
        manifest: enrollment,
        authorize: &authorize,
    };
    let master = MasterKey::from_bytes(ROOT);
    let cipher = SnapshotCipher::from_profile(&master, &authority.profile)?;
    recover_enrolled_with_authority(
        authority.profile.clone(),
        master,
        target,
        authority.clone(),
        cipher,
        Some(&attempt),
    )
}

#[test]
fn enrollment_ready_requires_signed_generation_one_and_fixed_admin() {
    let (profile, manifest) = fixture();
    let authority = Authority::new(profile);
    let dir = tempfile::tempdir().unwrap();
    let service = recover_fixture(
        authority.clone(),
        &dir.path().join("new.db"),
        &manifest,
        true,
    )
    .unwrap();
    assert!(
        matches!(service.durable_status(), Some(crate::durable::DurableStatus::Ready(head)) if head.generation == 1)
    );
    assert_eq!(
        service.repository().list_signer_callers().unwrap(),
        [manifest.caller().clone()]
    );
    service
        .repository()
        .validate_enrollment(&manifest, 1)
        .unwrap();
    assert_eq!(authority.candidates.lock().unwrap().len(), 1);
    assert_eq!(
        authority.candidates.lock().unwrap()[0].mutation_digest,
        manifest.operation_digest()
    );
}

#[test]
fn enrollment_crashes_preserve_local_evidence_and_restart_exact_head() {
    for fault in [Fault::Upload, Fault::LostReply, Fault::BadReceipt] {
        let (profile, manifest) = fixture();
        let authority = Authority::new(profile);
        *authority.fault.lock().unwrap() = fault;
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("abandoned.db");
        assert!(recover_fixture(authority.clone(), &target, &manifest, true).is_err());
        assert!(target.exists());
        let count = authority.authorizations.load(Ordering::SeqCst);
        assert!(recover_fixture(authority.clone(), &target, &manifest, false).is_err());
        assert_eq!(authority.authorizations.load(Ordering::SeqCst), count);
        assert!(recover_fixture(
            authority.clone(),
            &dir.path().join("live-owner.db"),
            &manifest,
            false
        )
        .is_err());
        authority.expire();
        *authority.fault.lock().unwrap() = Fault::None;
        let resumed = recover_fixture(
            authority.clone(),
            &dir.path().join("fresh-boot.db"),
            &manifest,
            fault == Fault::Upload,
        )
        .unwrap();
        assert_eq!(
            resumed.repository().list_signer_callers().unwrap(),
            [manifest.caller().clone()]
        );
        let candidates = authority.candidates.lock().unwrap();
        assert_eq!(candidates.len(), if fault == Fault::Upload { 2 } else { 1 });
        if fault == Fault::Upload {
            assert_ne!(candidates[0].commit_id, candidates[1].commit_id);
            assert_ne!(candidates[0].envelope, candidates[1].envelope);
            assert_eq!(candidates[1].next.position.fence, 2);
            assert!(
                authority.commit(&candidates[0]).is_err(),
                "old owner must be fenced"
            );
        }
    }
}

#[test]
fn enrollment_restore_never_reenrolls_adminless_initial_or_rotated_state() {
    let (profile, manifest) = fixture();
    let authority = Authority::new(profile);
    let dir = tempfile::tempdir().unwrap();
    let service = recover_fixture(
        authority.clone(),
        &dir.path().join("first.db"),
        &manifest,
        true,
    )
    .unwrap();
    let credentials = crate::auth::CallerCredentials::new(
        Some(&format!("Bearer {}", crate::enrollment::tests::ADMIN)),
        None,
        None,
    );
    let rotated = match service
        .rotate_caller_token(&credentials, "first-admin")
        .unwrap()
    {
        crate::service::Outcome::Allowed(token) => token,
        _ => panic!("legitimate Admin rotation refused"),
    };
    // Direct service methods are wrapped in execute_observable by HTTP. Commit
    // the same production Store explicitly here to construct a later snapshot.
    let cipher =
        SnapshotCipher::from_profile(&MasterKey::from_bytes(ROOT), &authority.profile).unwrap();
    let head = authority.head.lock().unwrap().clone().unwrap();
    let durable = DurableState::from_verified_lease(
        authority.profile.clone(),
        cipher,
        authority.clone(),
        head,
    )
    .unwrap();
    durable.commit(service.repository(), [9; 32]).unwrap();
    authority.expire();
    let restored = recover_fixture(
        authority.clone(),
        &dir.path().join("rotated.db"),
        &manifest,
        false,
    )
    .unwrap();
    assert_eq!(
        restored.repository().list_signer_callers().unwrap()[0].token_digest,
        crate::auth::token_digest(&rotated)
    );
    // Commit an adminless state to model an incompatible admitted producer.
    restored
        .repository()
        .set_signer_caller_disabled("first-admin", true)
        .unwrap();
    let head = authority.head.lock().unwrap().clone().unwrap();
    let cipher =
        SnapshotCipher::from_profile(&MasterKey::from_bytes(ROOT), &authority.profile).unwrap();
    DurableState::from_verified_lease(authority.profile.clone(), cipher, authority.clone(), head)
        .unwrap()
        .commit(restored.repository(), [8; 32])
        .unwrap();
    authority.expire();
    assert!(recover_fixture(
        authority.clone(),
        &dir.path().join("adminless.db"),
        &manifest,
        false
    )
    .is_err());
    assert_eq!(authority.authorizations.load(Ordering::SeqCst), 1);
}

#[test]
fn enrollment_audit_failure_rolls_back_caller_and_never_commits() {
    let (profile, manifest) = fixture();
    let authority = Authority::new(profile.clone());
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("audit-fault.db");
    let authorize = || {
        // Inject a storage fault after real fresh-target checks, not an Admin.
        let store = Store::open(&target).unwrap();
        rusqlite::Connection::open(store.db_path()).unwrap().execute_batch(
            "CREATE TRIGGER audit_fault BEFORE INSERT ON signer_audit BEGIN SELECT RAISE(ABORT, 'test audit fault'); END;"
        ).unwrap();
        Ok(())
    };
    let attempt = crate::provision::EnrollmentAttempt {
        manifest: &manifest,
        authorize: &authorize,
    };
    let master = MasterKey::from_bytes(ROOT);
    let cipher = SnapshotCipher::from_profile(&master, &profile).unwrap();
    assert!(recover_enrolled_with_authority(
        profile,
        master,
        &target,
        authority.clone(),
        cipher,
        Some(&attempt)
    )
    .is_err());
    assert!(Store::open(&target)
        .unwrap()
        .list_signer_callers()
        .unwrap()
        .is_empty());
    assert!(authority.candidates.lock().unwrap().is_empty());
    assert_eq!(
        authority.head.lock().unwrap().as_ref().unwrap().generation,
        0
    );
}

#[test]
fn enrollment_rejects_malformed_genesis_and_adminless_initial_snapshot() {
    let (profile, manifest) = fixture();
    let authority = Authority::new(profile.clone());
    let dir = tempfile::tempdir().unwrap();
    let cipher = SnapshotCipher::from_profile(&MasterKey::from_bytes(ROOT), &profile).unwrap();
    let mut genesis =
        AuthorityHead::genesis(cipher.binding().clone(), 1, "old-owner".into()).unwrap();
    genesis.lease_expires_at_ms = 1;
    genesis.snapshot_fence = 1;
    *authority.head.lock().unwrap() = Some(genesis.clone());
    assert!(recover_fixture(
        authority.clone(),
        &dir.path().join("malformed.db"),
        &manifest,
        false
    )
    .is_err());
    assert!(!dir.path().join("malformed.db").exists());
    genesis.snapshot_fence = 0;
    genesis.binding.profile_hash = [8; 32];
    *authority.head.lock().unwrap() = Some(genesis.clone());
    assert!(recover_fixture(
        authority.clone(),
        &dir.path().join("foreign.db"),
        &manifest,
        false
    )
    .is_err());
    // Even a trusted/signed generation-one envelope must have enrollment rows.
    genesis.binding = cipher.binding().clone();
    genesis.lease_expires_at_ms = u64::MAX;
    *authority.head.lock().unwrap() = Some(genesis.clone());
    let empty = Store::open(dir.path().join("incompatible-producer.db")).unwrap();
    DurableState::from_verified_lease(profile, cipher, authority.clone(), genesis)
        .unwrap()
        .commit(&empty, [4; 32])
        .unwrap();
    authority.expire();
    assert!(recover_fixture(
        authority.clone(),
        &dir.path().join("adminless-initial.db"),
        &manifest,
        false
    )
    .is_err());
    assert_eq!(authority.authorizations.load(Ordering::SeqCst), 0);
    assert_eq!(authority.candidates.lock().unwrap().len(), 1);
}

#[test]
fn enrollment_expired_receipt_is_authentic_but_fails_live_readiness() {
    let (profile, manifest) = fixture();
    let authority = Authority::new(profile.clone());
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("test.db")).unwrap();
    store.enroll_genesis(&manifest).unwrap();
    let leased = authority.takeover(None).unwrap();
    let cipher = SnapshotCipher::from_profile(&MasterKey::from_bytes(ROOT), &profile).unwrap();
    let durable =
        DurableState::from_verified_lease(profile, cipher, authority.clone(), leased).unwrap();
    *authority.fault.lock().unwrap() = Fault::ExpiredReceipt;
    let committed = durable
        .commit(&store, manifest.operation_digest())
        .expect("receipt must pass actual cryptographic verification");
    assert_eq!(committed.generation, 1);
    assert!(committed.ensure_live(now_millis().unwrap()).is_err());
    assert!(durable.ensure_ready().is_err());
}

#[test]
fn enrollment_recovery_refuses_expiry_before_returning_service() {
    // Exercise recovery without ApiState so its final guard cannot hide a
    // missing coordinator check. Both failures have durable evidence already.
    for fault in [Fault::ExpiredReceipt, Fault::SlowDownload] {
        let (profile, manifest) = fixture();
        let authority = Authority::new(profile);
        let dir = tempfile::tempdir().unwrap();
        if fault == Fault::SlowDownload {
            recover_fixture(
                authority.clone(),
                &dir.path().join("initial.db"),
                &manifest,
                true,
            )
            .unwrap();
            authority.expire();
        }
        *authority.fault.lock().unwrap() = fault;
        let target = dir.path().join("expired.db");
        assert!(
            recover_fixture(
                authority.clone(),
                &target,
                &manifest,
                fault == Fault::ExpiredReceipt
            )
            .is_err(),
            "expired recovery returned a service for {fault:?}"
        );
        assert!(target.exists(), "preserve the unpublished database");
        assert_eq!(
            authority.head.lock().unwrap().as_ref().unwrap().generation,
            1
        );
        assert_eq!(authority.authorizations.load(Ordering::SeqCst), 1);
        assert_eq!(authority.candidates.lock().unwrap().len(), 1);
        *authority.fault.lock().unwrap() = Fault::None;
        let restored = recover_fixture(
            authority.clone(),
            &dir.path().join("fresh.db"),
            &manifest,
            false,
        )
        .expect("fresh owner must restore the committed winner without original credential");
        restored
            .repository()
            .validate_enrollment(&manifest, 1)
            .unwrap();
        assert_eq!(authority.authorizations.load(Ordering::SeqCst), 1);
        assert_eq!(authority.candidates.lock().unwrap().len(), 1);
    }
}

#[test]
fn enrollment_disabled_refuses_initialized_genesis() {
    let (profile, _) = fixture();
    let authority = Authority::new(profile.clone());
    authority.takeover(None).unwrap();
    authority.expire();
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("disabled.db");
    let master = MasterKey::from_bytes(ROOT);
    let cipher = SnapshotCipher::from_profile(&master, &profile).unwrap();
    assert!(
        recover_with_authority(profile, master, &target, authority.clone(), cipher).is_err(),
        "a measured-looking profile alone must not enable genesis retry"
    );
    assert!(!target.exists());
    assert_eq!(authority.authorizations.load(Ordering::SeqCst), 0);
    assert!(authority.candidates.lock().unwrap().is_empty());
}
