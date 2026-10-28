//! Authored synthetic test source only; no test/native run in this packet.
use super::*;

pub(crate) fn migration_fixture() -> (Arc<ValidatedVaultProfile>, Arc<MeasuredMigration>) {
    let profile = Arc::new(crate::migration::tests::profile());
    let manifest = crate::migration::tests::manifest(&profile);
    let core = crate::migration::tests::validated(&manifest, &profile).unwrap();
    (profile, Arc::new(MeasuredMigration { core }))
}

#[test]
fn exact_image_file_binding_preserves_original_profile() {
    let (profile, _) = migration_fixture();
    let before = serde_json::to_vec(profile.document()).unwrap();
    let bytes = serde_json::to_vec(&crate::migration::tests::manifest(&profile)).unwrap();
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("manifest.json");
    std::fs::write(&path, &bytes).unwrap();
    let pin = hex::encode(Sha256::digest(&bytes));
    let migration = MeasuredMigration::load_pinned_file(&path, &pin, &profile).unwrap();
    migration.validate_profile(&profile).unwrap();
    assert_eq!(before, serde_json::to_vec(profile.document()).unwrap());
    assert_eq!(migration.core().profile_hash(), profile.profile_hash());
}

#[test]
fn image_file_refuses_wrong_pin_changed_bytes_and_foreign_profile() {
    let (profile, _) = migration_fixture();
    let bytes = serde_json::to_vec(&crate::migration::tests::manifest(&profile)).unwrap();
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("manifest.json");
    std::fs::write(&path, &bytes).unwrap();
    let pin = hex::encode(Sha256::digest(&bytes));
    for wrong in [
        "00".repeat(32),
        "11".repeat(32),
        "GG".repeat(32),
        "short".into(),
    ] {
        assert!(MeasuredMigration::load_pinned_file(&path, &wrong, &profile).is_err());
    }
    let testnet = crate::vault_profile::test_profile([0x5a; 32]);
    assert!(MeasuredMigration::load_pinned_file(&path, &pin, &testnet).is_err());
    let mut changed_profile = profile.document().clone();
    changed_profile.release_policy_version = "foreign-release".into();
    assert!(
        MeasuredMigration::load_pinned_file(&path, &pin, &changed_profile.validate().unwrap(),)
            .is_err()
    );
    std::fs::write(&path, b"{}").unwrap();
    assert!(MeasuredMigration::load_pinned_file(&path, &pin, &profile).is_err());
}

#[test]
fn image_file_refuses_directory_empty_oversize_and_symlink() {
    let (profile, _) = migration_fixture();
    let directory = tempfile::tempdir().unwrap();
    let pin = "11".repeat(32);
    assert!(MeasuredMigration::load_pinned_file(directory.path(), &pin, &profile).is_err());
    let path = directory.path().join("manifest.json");
    std::fs::write(&path, b"").unwrap();
    assert!(MeasuredMigration::load_pinned_file(&path, &pin, &profile).is_err());
    std::fs::write(&path, vec![b' '; crate::migration::MAX_MANIFEST_BYTES + 1]).unwrap();
    assert!(MeasuredMigration::load_pinned_file(&path, &pin, &profile).is_err());
    #[cfg(unix)]
    {
        let link = directory.path().join("link.json");
        std::os::unix::fs::symlink(&path, &link).unwrap();
        assert!(MeasuredMigration::load_pinned_file(&link, &pin, &profile).is_err());
    }
}

struct NoAttestation;
impl AttestationSource for NoAttestation {
    fn attest(
        &self,
        _: Option<&[u8]>,
        _: Option<&[u8]>,
        _: Option<&[u8]>,
    ) -> Result<Vec<u8>, String> {
        panic!("invalid measured configuration reached NSM");
    }
}

#[test]
fn testnet_or_mixed_enrollment_migration_refuses_before_lease_or_nsm() {
    let (_, migration) = migration_fixture();
    let (profile, enrollment) = crate::enrollment::tests::fixture();
    for enrollment in [None, Some(enrollment)] {
        let directory = tempfile::tempdir().unwrap();
        let data_dir = directory.path().join("unopened");
        let config = EmbeddedCustodyConfig {
            profile: profile.clone(),
            enrollment,
            migration: Some(migration.clone()),
            expected_network: Network::Testnet,
            data_dir: data_dir.clone(),
            workload_audience: "https://custody.test.example".into(),
            max_body_bytes: 256 * 1024,
            max_in_flight_requests: 2,
        };
        assert!(EmbeddedCustodyRuntime::boot_with_attestation_source(
            config,
            BootGuard::required(None).unwrap(),
            &NoAttestation,
        )
        .is_err());
        assert!(!data_dir.exists());
    }
}
