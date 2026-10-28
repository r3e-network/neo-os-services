use super::*;
use crate::{store::Store, vault_profile::VaultProfile};
use serde_json::{json, Value};
use std::sync::Arc;

pub(crate) const ADMIN: &str =
    "nsk1_1111111111114111811111111111111122222222222242228222222222222222";
pub(crate) const ROOT: [u8; 32] = [0x5a; 32];

pub(crate) fn manifest(document: &VaultProfile) -> Value {
    json!({
        "schema":"neoos/first-admin-enrollment/v1", "purpose":ENROLLMENT_MODE,
        "ceremony_id":"synthetic-first-admin", "environment":document.environment,
        "vault_id":document.vault_id, "networks":document.networks,
        "custody_kms_key_arn":document.custody_kms_key_arn,
        "root_key_version":document.root_key_version, "root_key_commitment":document.root_key_commitment,
        "coordinator":document.coordinator,
        "caller":{"id":"first-admin", "label":"Test operator", "created_at_unix":1780000000u64,
            "token_digest":hex::encode(auth::token_digest(ADMIN)), "auth_mode":"bearer",
            "capabilities":["admin"], "key_grant":"any", "allowed_origins":[], "disabled":false}
    })
}

pub(crate) fn fixture() -> (Arc<ValidatedVaultProfile>, Arc<ValidatedGenesisEnrollment>) {
    let mut document = crate::vault_profile::test_profile(ROOT).document().clone();
    let bytes = serde_json::to_vec(&manifest(&document)).unwrap();
    document.release_policy_version = hex::encode(Sha256::digest(&bytes));
    let profile = Arc::new(document.validate().unwrap());
    let enrollment = Arc::new(ValidatedGenesisEnrollment::from_json(&bytes, &profile).unwrap());
    (profile, enrollment)
}

#[test]
fn enrollment_pins_exact_manifest_profile_and_caller_contract() {
    let (profile, enrollment) = fixture();
    enrollment
        .verify_token(ADMIN.as_bytes(), &auth::token_digest("transport"))
        .unwrap();
    assert!(enrollment
        .verify_token(ADMIN.as_bytes(), &auth::token_digest(ADMIN))
        .is_err());
    assert!(enrollment.verify_token(b"nsk1_wrong", &[8; 32]).is_err());
    let other = ADMIN.replace('1', "3");
    assert!(enrollment.verify_token(other.as_bytes(), &[8; 32]).is_err());
    assert_eq!(
        enrollment.caller().capabilities,
        vec![CallerCapability::Admin]
    );
    let original = manifest(profile.document());
    let mut altered = original.clone();
    altered["caller"]["id"] = json!("attacker");
    // Replacing both file and its advertised SHA cannot replace profile binding.
    let bytes = serde_json::to_vec(&altered).unwrap();
    assert!(ValidatedGenesisEnrollment::from_json(&bytes, &profile).is_err());
    for (field, value) in [
        ("purpose", json!("other")),
        ("environment", json!("mainnet")),
        ("vault_id", json!("11".repeat(16))),
        ("root_key_version", json!("other")),
    ] {
        let mut altered = original.clone();
        altered[field] = value;
        let bytes = serde_json::to_vec(&altered).unwrap();
        let mut p = profile.document().clone();
        p.release_policy_version = hex::encode(Sha256::digest(&bytes));
        assert!(
            ValidatedGenesisEnrollment::from_json(&bytes, &p.validate().unwrap()).is_err(),
            "{field}"
        );
    }
    for (field, value) in [
        ("auth_mode", json!("workload")),
        ("capabilities", json!(["admin", "sign"])),
        ("key_grant", json!("only")),
        ("allowed_origins", json!(["https://host.example"])),
        ("disabled", json!(true)),
        ("created_at_unix", json!(0)),
        ("unknown", json!("input")),
    ] {
        let mut altered = original.clone();
        altered["caller"][field] = value;
        let bytes = serde_json::to_vec(&altered).unwrap();
        let mut p = profile.document().clone();
        p.release_policy_version = hex::encode(Sha256::digest(&bytes));
        assert!(
            ValidatedGenesisEnrollment::from_json(&bytes, &p.validate().unwrap()).is_err(),
            "{field}"
        );
    }
    let raw = serde_json::to_string(&original).unwrap().replacen(
        "\"caller\":{",
        "\"caller\":{\"id\":\"duplicate\",",
        1,
    );
    let mut p = profile.document().clone();
    p.release_policy_version = hex::encode(Sha256::digest(raw.as_bytes()));
    assert!(ValidatedGenesisEnrollment::from_json(raw.as_bytes(), &p.validate().unwrap()).is_err());
    assert!(
        ValidatedGenesisEnrollment::from_json(&vec![b' '; MAX_MANIFEST_BYTES + 1], &profile)
            .is_err()
    );
    let unbound = crate::vault_profile::test_profile(ROOT);
    assert!(enrollment.validate_profile(&unbound).is_err());
}

#[test]
fn enrollment_is_atomic_and_checks_every_application_table() {
    let (_, enrollment) = fixture();
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("audit.db")).unwrap();
    let conn = rusqlite::Connection::open(store.db_path()).unwrap();
    conn.execute_batch("CREATE TRIGGER reject_enrollment BEFORE INSERT ON signer_audit BEGIN SELECT RAISE(ABORT, 'injected'); END;").unwrap();
    assert!(store.enroll_genesis(&enrollment).is_err());
    assert!(store.list_signer_callers().unwrap().is_empty());
    conn.execute_batch("DROP TRIGGER reject_enrollment;")
        .unwrap();
    // Even an unexpected application table prevents preseeded initialization.
    conn.execute_batch(
        "CREATE TABLE sqliteXapplication (v INTEGER); INSERT INTO sqliteXapplication VALUES (1);",
    )
    .unwrap();
    assert!(store.enroll_genesis(&enrollment).is_err());
    assert!(store.list_signer_callers().unwrap().is_empty());
    conn.execute_batch("DROP TABLE sqliteXapplication;")
        .unwrap();
    store.enroll_genesis(&enrollment).unwrap();
    store.validate_enrollment(&enrollment, 1).unwrap();
    assert!(store.enroll_genesis(&enrollment).is_err());
    // The audit survives legitimate token rotation, but generation one is exact.
    store
        .set_signer_caller_digest("first-admin", &auth::token_digest("rotated"))
        .unwrap();
    assert!(store.validate_enrollment(&enrollment, 1).is_err());
    store.validate_enrollment(&enrollment, 2).unwrap();
    store
        .set_signer_caller_disabled("first-admin", true)
        .unwrap();
    assert!(store.validate_enrollment(&enrollment, 2).is_err());
    assert!(store.list_signer_callers().unwrap()[0].disabled);
}

pub(crate) fn mainnet_profile() -> ValidatedVaultProfile {
    let mut document = crate::vault_profile::test_profile(ROOT).document().clone();
    document.environment = "mainnet".into();
    for binding in &mut document.networks {
        binding.chain_id = match binding.chain_family.as_str() {
            "neo-n3" => crate::network::network_magic(Network::Mainnet) as u64,
            "neox" => crate::network::neox_chain_id(Network::Mainnet),
            _ => unreachable!(),
        };
    }
    document.validate().unwrap()
}

#[test]
fn enrollment_direct_parser_refuses_fully_self_consistent_mainnet_manifest() {
    let mut document = mainnet_profile().document().clone();
    let bytes = serde_json::to_vec(&manifest(&document)).unwrap();
    document.release_policy_version = hex::encode(Sha256::digest(&bytes));
    let mainnet = document.validate().unwrap();
    let error = ValidatedGenesisEnrollment::from_json(&bytes, &mainnet).unwrap_err();
    assert_eq!(error.to_string(), "enrollment requires TestNet");
}

fn image_enrollment_bytes(profile: &ValidatedVaultProfile) -> Vec<u8> {
    serde_json::to_vec(&json!({"schema":"neoos/image-owned-testnet-enrollment/v1",
        "profile_sha256":hex::encode(profile.profile_hash()), "enrollment":manifest(profile.document())})).unwrap()
}

pub(crate) fn image_fixture() -> (Arc<ValidatedVaultProfile>, Arc<ValidatedGenesisEnrollment>) {
    let profile = Arc::new(crate::vault_profile::test_profile(ROOT));
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("image.json");
    let bytes = image_enrollment_bytes(&profile);
    std::fs::write(&path, &bytes).unwrap();
    let pin = hex::encode(Sha256::digest(&bytes));
    let enrollment =
        Arc::new(ValidatedGenesisEnrollment::load_pinned_file(&path, &pin, &profile).unwrap());
    (profile, enrollment)
}

#[test]
fn image_enrollment_keeps_original_profile_and_original_context() {
    let profile = crate::vault_profile::test_profile(ROOT);
    let before = serde_json::to_vec(profile.document()).unwrap();
    use crate::provision::{custody_encryption_context, EnvelopePurpose};
    let contexts = [
        EnvelopePurpose::MasterKey,
        EnvelopePurpose::TransportToken,
        EnvelopePurpose::FirstAdmin,
    ]
    .map(|purpose| custody_encryption_context(&profile, purpose));
    let profile_hash = *profile.profile_hash();
    let network_set_hash = *profile.network_set_hash();
    let root_commitment = *profile.root_key_commitment();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("image.json");
    let bytes = image_enrollment_bytes(&profile);
    std::fs::write(&path, &bytes).unwrap();
    let pin = hex::encode(Sha256::digest(&bytes));
    let enrollment = ValidatedGenesisEnrollment::load_pinned_file(&path, &pin, &profile).unwrap();
    enrollment
        .verify_token(ADMIN.as_bytes(), &auth::token_digest("transport"))
        .unwrap();
    assert_eq!(before, serde_json::to_vec(profile.document()).unwrap());
    assert_eq!(
        contexts,
        [
            EnvelopePurpose::MasterKey,
            EnvelopePurpose::TransportToken,
            EnvelopePurpose::FirstAdmin
        ]
        .map(|purpose| custody_encryption_context(&profile, purpose))
    );
    assert_eq!(*profile.profile_hash(), profile_hash);
    assert_eq!(*profile.network_set_hash(), network_set_hash);
    assert_eq!(*profile.root_key_commitment(), root_commitment);
    assert_eq!(enrollment.digest, <[u8; 32]>::from(Sha256::digest(&bytes)));
    let detail: Value = serde_json::from_str(enrollment.audit.detail.as_ref().unwrap()).unwrap();
    assert_eq!(detail["manifest_sha256"], pin);
    assert_eq!(detail["profile_sha256"], hex::encode(profile_hash));
    assert_eq!(enrollment.profile_hash, *profile.profile_hash());
    assert!(
        ValidatedGenesisEnrollment::from_json(
            &serde_json::to_vec(&manifest(profile.document())).unwrap(),
            &profile
        )
        .is_err(),
        "old release-policy admission remains required"
    );
}

#[test]
fn image_enrollment_requires_exact_pin_full_profile_and_admin_only() {
    let profile = crate::vault_profile::test_profile(ROOT);
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("image.json");
    let original: Value = serde_json::from_slice(&image_enrollment_bytes(&profile)).unwrap();
    for mode in [
        "valid",
        "schema",
        "profile",
        "caller",
        "network",
        "capability",
        "duplicate",
        "extra",
    ] {
        let mut changed = original.clone();
        match mode {
            "schema" => changed["schema"] = json!("other"),
            "profile" => changed["profile_sha256"] = json!("11".repeat(32)),
            "caller" => changed["enrollment"]["caller"]["disabled"] = json!(true),
            "network" => changed["enrollment"]["environment"] = json!("mainnet"),
            "capability" => {
                changed["enrollment"]["caller"]["capabilities"] = json!(["admin", "sign"])
            }
            "extra" => changed["unknown"] = json!(true),
            _ => {}
        }
        let mut bytes = serde_json::to_vec(&changed).unwrap();
        if mode == "duplicate" {
            bytes = String::from_utf8(bytes)
                .unwrap()
                .replacen("{", "{\"schema\":\"duplicate\",", 1)
                .into_bytes();
        }
        std::fs::write(&path, &bytes).unwrap();
        let pin = hex::encode(Sha256::digest(&bytes));
        let result = ValidatedGenesisEnrollment::load_pinned_file(&path, &pin, &profile);
        assert_eq!(result.is_ok(), mode == "valid", "{mode}");
    }
    let bytes = image_enrollment_bytes(&profile);
    std::fs::write(&path, &bytes).unwrap();
    for pin in [
        "00".repeat(32),
        "11".repeat(32),
        "AA".repeat(32),
        "short".into(),
    ] {
        assert!(ValidatedGenesisEnrollment::load_pinned_file(&path, &pin, &profile).is_err());
    }
    let pin = hex::encode(Sha256::digest(&bytes));
    let mut altered = profile.document().clone();
    altered.release_policy_version = "changed".into();
    assert!(ValidatedGenesisEnrollment::load_pinned_file(
        &path,
        &pin,
        &altered.validate().unwrap()
    )
    .is_err());
    assert!(ValidatedGenesisEnrollment::load_pinned_file(&path, &pin, &mainnet_profile()).is_err());
}

#[test]
fn image_enrollment_refuses_symlink_directory_empty_and_oversize() {
    let profile = crate::vault_profile::test_profile(ROOT);
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("image.json");
    let pin = "11".repeat(32);
    assert!(ValidatedGenesisEnrollment::load_pinned_file(dir.path(), &pin, &profile).is_err());
    for bytes in [vec![], vec![b' '; MAX_MANIFEST_BYTES + 1]] {
        std::fs::write(&path, bytes).unwrap();
        assert!(ValidatedGenesisEnrollment::load_pinned_file(&path, &pin, &profile).is_err());
    }
    #[cfg(unix)]
    {
        let link = dir.path().join("link");
        std::os::unix::fs::symlink(&path, &link).unwrap();
        assert!(ValidatedGenesisEnrollment::load_pinned_file(&link, &pin, &profile).is_err());
    }
}

#[test]
fn image_enrollment_keeps_existing_atomic_first_admin_admission() {
    let profile = crate::vault_profile::test_profile(ROOT);
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("image.json");
    let bytes = image_enrollment_bytes(&profile);
    std::fs::write(&path, &bytes).unwrap();
    let pin = hex::encode(Sha256::digest(&bytes));
    let enrollment = ValidatedGenesisEnrollment::load_pinned_file(&path, &pin, &profile).unwrap();
    let store = Store::open(dir.path().join("signer.db")).unwrap();
    let connection = rusqlite::Connection::open(store.db_path()).unwrap();
    connection.execute_batch("CREATE TRIGGER refuse_image_admin BEFORE INSERT ON signer_audit BEGIN SELECT RAISE(ABORT, 'synthetic'); END;").unwrap();
    assert!(store.enroll_genesis(&enrollment).is_err());
    assert!(store.list_signer_callers().unwrap().is_empty());
    connection
        .execute_batch("DROP TRIGGER refuse_image_admin;")
        .unwrap();
    store.enroll_genesis(&enrollment).unwrap();
    store.validate_enrollment(&enrollment, 1).unwrap();
    assert!(store.enroll_genesis(&enrollment).is_err());
    assert_eq!(store.list_signer_callers().unwrap().len(), 1);
    assert!(enrollment
        .verify_token(ADMIN.as_bytes(), &auth::token_digest(ADMIN))
        .is_err());
}
