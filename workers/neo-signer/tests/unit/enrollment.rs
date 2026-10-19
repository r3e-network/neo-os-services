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
