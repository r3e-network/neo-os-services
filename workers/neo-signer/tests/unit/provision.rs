//! The provision gate's rules, each one as a refusal an operator would meet.
//!
//! These run against a canned [`EnvelopeReleaser`] — the same substitution the
//! production route makes when the NSM device is not there — so the whitelist,
//! the token check and the master-key release are all exercised without KMS or
//! an enclave. What is *not* exercised here is the release itself; that lives
//! in `nitro-attest`'s own integration tests against a mock KMS.

use std::path::Path;
use std::sync::Arc;

use anyhow::Result;
use serde_json::json;

use super::*;

/// The transport token the canned releaser pretends KMS released.
const RELEASED_TOKEN: &str = "enclave-transport-token-0001";

/// A 32-byte master key the canned releaser pretends KMS released.
const RELEASED_MASTER_KEY: [u8; 32] = [0x5a; 32];

const TOKEN_CIPHERTEXT: &str = "ciphertext-of-the-transport-token";
const MASTER_CIPHERTEXT: &str = "ciphertext-of-the-master-key";

fn env_with(pairs: &[(&str, &str)]) -> ProvisionBody {
    let mut env = serde_json::Map::new();
    for (name, value) in pairs {
        env.insert(
            (*name).to_string(),
            serde_json::Value::String((*value).to_string()),
        );
    }
    ProvisionBody { env }
}

/// The full whitelist the start script projects: token ciphertext, master
/// ciphertext, region, and the four AWS names the release path needs.
fn full_env() -> ProvisionBody {
    env_with(&[
        (TOKEN_CIPHERTEXT_ENV, TOKEN_CIPHERTEXT),
        (MASTER_KEY_CIPHERTEXT_ENV, MASTER_CIPHERTEXT),
        (REGION_ENV, "us-east-1"),
        ("AWS_ACCESS_KEY_ID", "AKIAEXAMPLE"),
        ("AWS_SECRET_ACCESS_KEY", "secret"),
        ("AWS_SESSION_TOKEN", "session"),
    ])
}

/// A releaser that answers with the released token or the released master key,
/// only when the ciphertext and its encryption purpose both match.
fn canned_releaser() -> EnvelopeReleaser {
    Arc::new(
        |_env: &ProvisionEnv, ciphertext: &str, purpose| match (ciphertext, purpose) {
            (TOKEN_CIPHERTEXT, EnvelopePurpose::TransportToken) => {
                Ok(Zeroizing::new(RELEASED_TOKEN.as_bytes().to_vec()))
            }
            (MASTER_CIPHERTEXT, EnvelopePurpose::MasterKey) => {
                Ok(Zeroizing::new(RELEASED_MASTER_KEY.to_vec()))
            }
            _ => Err("ciphertext encryption context mismatch".to_string()),
        },
    )
}

fn gate(dir: &Path, releaser: EnvelopeReleaser) -> ProvisionGate {
    let repository = crate::store::Store::open(dir.join("signer.db")).expect("store opens");
    let recoverer: VaultRecoverer = Arc::new(
        |_profile, _credentials, master_key, database_path, _enrollment| {
            let repository =
                crate::store::Store::open(database_path).map_err(|error| error.to_string())?;
            Ok(SignerService::new(repository, master_key))
        },
    );
    ProvisionGate {
        database_path: repository.db_path().to_path_buf(),
        data_dir: dir.to_path_buf(),
        profile: Arc::new(crate::vault_profile::test_profile(RELEASED_MASTER_KEY)),
        releaser,
        recoverer,
        enrollment: None,
        migration: None,
        migration_recoverer: migration_recoverer(),
        mutex: Mutex::new(()),
    }
}

fn legacy_pair_body() -> ProvisionBody {
    let mut body = full_env();
    body.env
        .insert(LEGACY_ROLE_CIPHERTEXT_ENVS[0].into(), json!("b3JhY2xl"));
    body.env
        .insert(LEGACY_ROLE_CIPHERTEXT_ENVS[1].into(), json!("dXBkYXRlcg=="));
    body
}

#[test]
fn legacy_pair_is_accepted_only_under_measured_migration_and_is_optional_for_restore() {
    let (_, migration) = crate::embedded::tests::migration_fixture();
    assert!(ProvisionEnv::from_body(legacy_pair_body()).is_err());
    let env = ProvisionEnv::from_body_for_migration(legacy_pair_body(), Some(&migration)).unwrap();
    assert_eq!(env.get(LEGACY_ROLE_CIPHERTEXT_ENVS[0]), Some("b3JhY2xl"));
    assert_eq!(
        env.get(LEGACY_ROLE_CIPHERTEXT_ENVS[1]),
        Some("dXBkYXRlcg==")
    );
    let restore = ProvisionEnv::from_body_for_migration(full_env(), Some(&migration)).unwrap();
    assert!(LEGACY_ROLE_CIPHERTEXT_ENVS
        .iter()
        .all(|name| restore.get(name).is_none()));
}

#[test]
fn legacy_pair_refuses_partial_invalid_oversize_and_same_decoded_input() {
    let (_, migration) = crate::embedded::tests::migration_fixture();
    for name in LEGACY_ROLE_CIPHERTEXT_ENVS {
        let mut body = legacy_pair_body();
        body.env.remove(name);
        assert!(ProvisionEnv::from_body_for_migration(body, Some(&migration)).is_err());
    }
    for value in [
        "not-base64!".to_string(),
        "".into(),
        "b3JhY2xl".into(),
        "A".repeat(MAX_LEGACY_CIPHERTEXT_BYTES * 2 + 1),
    ] {
        let mut body = legacy_pair_body();
        body.env
            .insert(LEGACY_ROLE_CIPHERTEXT_ENVS[1].into(), json!(value));
        assert!(ProvisionEnv::from_body_for_migration(body, Some(&migration)).is_err());
    }
}

#[test]
fn migration_never_accepts_plaintext_reference_metadata_or_manifest_overrides() {
    let (_, migration) = crate::embedded::tests::migration_fixture();
    for name in [
        "MORPHEUS_ORACLE_VERIFIER_WIF",
        "MORPHEUS_UPDATER_NEO_N3_WIF",
        "MORPHEUS_ORACLE_VERIFIER_KMS_KEY_ARN",
        "MORPHEUS_UPDATER_NEO_N3_KEY_REF",
        "SIGNER_SERVICE_CUSTODY_TOKEN",
        "MORPHEUS_CUSTODY_MIGRATION_MODE",
        "MORPHEUS_CUSTODY_MIGRATION_FILE",
        "MORPHEUS_CUSTODY_MIGRATION_SHA256",
        "NEOOS_LEGACY_N3_MIGRATION_SHA256",
        "manifest",
        "expected_hash",
        "metadata",
    ] {
        let mut body = legacy_pair_body();
        body.env.insert(name.into(), json!("forbidden"));
        assert!(
            matches!(ProvisionEnv::from_body_for_migration(body, Some(&migration)),
            Err(ProvisionError::UnknownKey(key)) if key == name)
        );
    }
}

#[test]
fn gate_revalidates_migration_scope_before_any_release_or_recovery() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let (_, migration) = crate::embedded::tests::migration_fixture();
    let directory = tempfile::tempdir().unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let called = calls.clone();
    let releaser: EnvelopeReleaser = Arc::new(move |_, _, _| {
        called.fetch_add(1, Ordering::SeqCst);
        Err("invalid scope reached release".into())
    });
    let mut gate = gate(directory.path(), releaser);
    let pair = ProvisionEnv::from_body_for_migration(legacy_pair_body(), Some(&migration)).unwrap();
    assert!(run(&gate, &pair, Some(RELEASED_TOKEN)).is_err());
    gate.migration = Some(migration.clone()); // Existing gate profile is Testnet.
    let env = ProvisionEnv::from_body_for_migration(full_env(), Some(&migration)).unwrap();
    assert!(run(&gate, &env, Some(RELEASED_TOKEN)).is_err());
    let (profile, enrollment) = crate::enrollment::tests::fixture();
    gate.profile = profile;
    gate.enrollment = Some(enrollment);
    assert!(run(&gate, &env, Some(RELEASED_TOKEN)).is_err());
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[test]
fn migration_run_uses_dedicated_recoverer_without_eager_role_release_or_fallback() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let (profile, migration) = crate::embedded::tests::migration_fixture();
    let directory = tempfile::tempdir().unwrap();
    let mut gate = gate(directory.path(), canned_releaser());
    gate.profile = profile.clone();
    gate.migration = Some(migration);
    gate.recoverer = Arc::new(|_, _, _, _, _| panic!("migration used ordinary recovery"));
    let calls = Arc::new(AtomicUsize::new(0));
    let called = calls.clone();
    gate.migration_recoverer = Arc::new(move |received_profile, _, _, _, attempt| {
        assert_eq!(received_profile.profile_hash(), profile.profile_hash());
        attempt.manifest.validate_profile(&profile).unwrap();
        called.fetch_add(1, Ordering::SeqCst);
        assert!(attempt.restore_only);
        // No role envelopes were supplied: this models the committed branch.
        // Do NOT invoke the real release callback from a positive fixture.
        Err("synthetic committed branch did not request roles".into())
    });
    let env = ProvisionEnv::from_body_for_migration(full_env(), gate.migration.as_deref()).unwrap();
    let error = refused(
        run(&gate, &env, Some(RELEASED_TOKEN)),
        "synthetic recovery result",
    );
    assert_eq!(
        error,
        ProvisionError::Release("synthetic committed branch did not request roles".into())
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[test]
fn a_root_key_that_does_not_match_the_profile_is_refused() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let wrong_root = Arc::new(|_env: &ProvisionEnv, ciphertext: &str, _purpose| {
        if ciphertext == TOKEN_CIPHERTEXT {
            Ok(Zeroizing::new(RELEASED_TOKEN.as_bytes().to_vec()))
        } else {
            Ok(Zeroizing::new(vec![0x6b; 32]))
        }
    });
    let body = ProvisionEnv::from_body(full_env()).expect("whitelist passes");
    let error = refused(
        run(&gate(dir.path(), wrong_root), &body, Some(RELEASED_TOKEN)),
        "a substituted root must not open the vault",
    );
    assert!(matches!(error, ProvisionError::Release(_)));
    assert!(error.answer().2.contains("immutable vault profile"));
    Ok(())
}

fn run_with(
    dir: &Path,
    env: ProvisionBody,
    token: Option<&str>,
) -> Result<SignerService, ProvisionError> {
    let body = ProvisionEnv::from_body(env).expect("the environment should pass the whitelist");
    let gate = gate(dir, canned_releaser());
    run(&gate, &body, token)
}

/// `expect_err` without the `Debug` bound the success values deliberately do
/// not carry: a vault and a provisioned environment are not printable things.
fn refused(result: Result<SignerService, ProvisionError>, why: &str) -> ProvisionError {
    match result {
        Ok(_) => panic!("{why}"),
        Err(error) => error,
    }
}

fn unaccepted(result: Result<ProvisionEnv, ProvisionError>, why: &str) -> ProvisionError {
    match result {
        Ok(_) => panic!("{why}"),
        Err(error) => error,
    }
}

#[test]
fn a_plaintext_master_key_is_refused_before_anything_else() -> Result<()> {
    let mut body = full_env();
    body.env.insert(
        "SIGNER_SERVICE_MASTER_KEY".to_string(),
        json!("64-hex-or-a-passphrase"),
    );
    let error = unaccepted(ProvisionEnv::from_body(body), "plaintext key is refused");
    let (code, status, message) = error.answer();
    assert_eq!(error, ProvisionError::PlaintextMasterKey);
    assert_eq!(code, "signer-provision-forbidden");
    assert_eq!(status, 403);
    assert!(message.contains("attested"));
    Ok(())
}

#[test]
fn the_provisioned_environment_is_a_whitelist() -> Result<()> {
    let mut body = full_env();
    body.env.insert("EXTRA".to_string(), json!("smuggled"));
    assert_eq!(
        unaccepted(ProvisionEnv::from_body(body), "unknown key"),
        ProvisionError::UnknownKey("EXTRA".to_string())
    );

    let mut body = full_env();
    body.env.insert(REGION_ENV.to_string(), json!(1));
    assert_eq!(
        unaccepted(ProvisionEnv::from_body(body), "non-string"),
        ProvisionError::NotAString(REGION_ENV.to_string())
    );

    let mut body = full_env();
    body.env.insert(REGION_ENV.to_string(), json!(""));
    assert_eq!(
        unaccepted(ProvisionEnv::from_body(body), "empty"),
        ProvisionError::EmptyValue(REGION_ENV.to_string())
    );
    Ok(())
}

#[test]
fn a_mismatched_transport_token_is_refused_without_touching_the_master_key() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let error = refused(
        run_with(dir.path(), full_env(), Some("the-wrong-token")),
        "the wrong token must not open anything",
    );
    // The token check runs before the release, so the failure is the mismatch,
    // not some later symptom.
    assert_eq!(error, ProvisionError::TokenMismatch);
    assert_eq!(error.answer().1, 401);
    Ok(())
}

#[test]
fn a_presented_token_is_required_at_all() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let error = refused(run_with(dir.path(), full_env(), None), "no token, no vault");
    assert_eq!(error, ProvisionError::TokenMismatch);
    Ok(())
}

#[test]
fn the_matching_token_opens_the_vault_under_the_released_key() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let service = run_with(dir.path(), full_env(), Some(RELEASED_TOKEN))
        .expect("the right token releases the vault");
    // The fingerprint is derived from the released master key, so this
    // assertion is what proves the key that opened the vault is the one KMS
    // released rather than one the fallback minted.
    let expected = crate::vault::MasterKey::from_bytes(RELEASED_MASTER_KEY).fingerprint();
    assert_eq!(service.vault_fingerprint(), expected);
    Ok(())
}

#[test]
fn a_released_master_key_must_be_32_bytes() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let short = Arc::new(|_env: &ProvisionEnv, ciphertext: &str, _purpose| {
        if ciphertext == TOKEN_CIPHERTEXT {
            Ok(Zeroizing::new(RELEASED_TOKEN.as_bytes().to_vec()))
        } else {
            Ok(Zeroizing::new(vec![0x5a; 16]))
        }
    });
    let body = ProvisionEnv::from_body(full_env()).expect("whitelist passes");
    let gate = gate(dir.path(), short);
    let error = refused(
        run(&gate, &body, Some(RELEASED_TOKEN)),
        "16 bytes is not a key",
    );
    let (_, status, message) = error.answer();
    assert_eq!(status, 503);
    assert!(message.contains("16 bytes"), "{message}");
    Ok(())
}

#[test]
fn without_a_master_ciphertext_provision_refuses_without_creating_a_key_file() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let mut body = full_env();
    body.env.remove(MASTER_KEY_CIPHERTEXT_ENV);
    let error = refused(
        run_with(dir.path(), body, Some(RELEASED_TOKEN)),
        "missing master ciphertext must not create a new vault",
    );
    assert_eq!(
        error,
        ProvisionError::MissingField(MASTER_KEY_CIPHERTEXT_ENV)
    );
    assert!(!dir.path().join(crate::vault::MASTER_KEY_FILE).exists());
    Ok(())
}

#[test]
fn a_known_32_byte_transport_token_cannot_be_installed_as_the_master_key() -> Result<()> {
    let dir = tempfile::tempdir()?;
    const KNOWN_TOKEN: &str = "0123456789abcdef0123456789abcdef";
    let releaser: EnvelopeReleaser = Arc::new(|_env, ciphertext, _purpose| match ciphertext {
        TOKEN_CIPHERTEXT => Ok(Zeroizing::new(KNOWN_TOKEN.as_bytes().to_vec())),
        MASTER_CIPHERTEXT => Ok(Zeroizing::new(RELEASED_MASTER_KEY.to_vec())),
        _ => Err("unknown ciphertext".to_string()),
    });
    let mut body = full_env();
    body.env.insert(
        MASTER_KEY_CIPHERTEXT_ENV.to_string(),
        json!(TOKEN_CIPHERTEXT),
    );
    let env = ProvisionEnv::from_body(body).expect("known fields pass");
    let result = run(&gate(dir.path(), releaser), &env, Some(KNOWN_TOKEN));
    if let Ok(service) = result {
        let known_key = MasterKey::from_bytes(*b"0123456789abcdef0123456789abcdef");
        assert_eq!(service.vault_fingerprint(), known_key.fingerprint());
        panic!("host-known transport token was accepted as the vault master key");
    }
    assert!(!dir.path().join(crate::vault::MASTER_KEY_FILE).exists());
    Ok(())
}

#[test]
fn a_different_token_ciphertext_cannot_bypass_the_purpose_check() -> Result<()> {
    const KNOWN_TOKEN: &str = "0123456789abcdef0123456789abcdef";
    const ANOTHER_TOKEN_CIPHERTEXT: &str = "another-envelope-of-the-known-token";
    let calls = Arc::new(Mutex::new(Vec::new()));
    let recorded = Arc::clone(&calls);
    let releaser: EnvelopeReleaser = Arc::new(move |_env, ciphertext, purpose| {
        recorded
            .lock()
            .expect("record lock")
            .push((ciphertext.to_string(), purpose));
        if purpose == EnvelopePurpose::TransportToken
            && matches!(ciphertext, TOKEN_CIPHERTEXT | ANOTHER_TOKEN_CIPHERTEXT)
        {
            Ok(Zeroizing::new(KNOWN_TOKEN.as_bytes().to_vec()))
        } else {
            Err("KMS InvalidCiphertextException: encryption context mismatch".to_string())
        }
    });
    let dir = tempfile::tempdir()?;
    let mut body = full_env();
    body.env.insert(
        MASTER_KEY_CIPHERTEXT_ENV.to_string(),
        json!(ANOTHER_TOKEN_CIPHERTEXT),
    );
    let env = ProvisionEnv::from_body(body).expect("whitelist passes");
    let error = refused(
        run(&gate(dir.path(), releaser), &env, Some(KNOWN_TOKEN)),
        "cross-purpose envelope must fail",
    );
    assert!(matches!(error, ProvisionError::Release(_)));
    assert_eq!(
        *calls.lock().expect("record lock"),
        vec![
            (
                TOKEN_CIPHERTEXT.to_string(),
                EnvelopePurpose::TransportToken
            ),
            (
                ANOTHER_TOKEN_CIPHERTEXT.to_string(),
                EnvelopePurpose::MasterKey
            ),
        ]
    );
    assert!(!dir.path().join(crate::vault::MASTER_KEY_FILE).exists());
    Ok(())
}

#[test]
fn missing_or_reused_envelopes_fail_before_kms_or_local_master_key_access() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let gate = gate(
        dir.path(),
        Arc::new(|_, _, _| panic!("KMS must not be called")),
    );
    let mut missing = full_env();
    missing.env.remove(MASTER_KEY_CIPHERTEXT_ENV);
    let error = refused(
        run(
            &gate,
            &ProvisionEnv::from_body(missing).expect("whitelist"),
            Some(RELEASED_TOKEN),
        ),
        "missing master",
    );
    assert_eq!(
        error,
        ProvisionError::MissingField(MASTER_KEY_CIPHERTEXT_ENV)
    );
    let mut reused = full_env();
    reused.env.insert(
        MASTER_KEY_CIPHERTEXT_ENV.to_string(),
        json!(TOKEN_CIPHERTEXT),
    );
    let error = refused(
        run(
            &gate,
            &ProvisionEnv::from_body(reused).expect("whitelist"),
            Some(RELEASED_TOKEN),
        ),
        "same envelope",
    );
    assert_eq!(error, ProvisionError::ReusedCiphertext);
    assert_eq!(error.answer().1, 400);
    assert!(!dir.path().join(crate::vault::MASTER_KEY_FILE).exists());
    Ok(())
}

#[test]
fn production_release_sends_fixed_context_for_each_purpose_without_legacy_fallback() -> Result<()> {
    struct Attestation;
    impl nitro_attest::release::AttestationSource for Attestation {
        fn attest(
            &self,
            _nonce: Option<&[u8]>,
            _user_data: Option<&[u8]>,
            _public_key: Option<&[u8]>,
        ) -> Result<Vec<u8>, String> {
            Ok(vec![1, 2, 3])
        }
    }
    struct Kms(Mutex<Vec<serde_json::Value>>);
    impl nitro_attest::release::KmsTransport for Kms {
        fn post_json(
            &self,
            _url: &str,
            _headers: &[(String, String)],
            body: &str,
        ) -> Result<(u16, String), String> {
            self.0
                .lock()
                .expect("capture lock")
                .push(serde_json::from_str(body).expect("KMS JSON"));
            Ok((
                400,
                r#"{"__type":"InvalidCiphertextException"}"#.to_string(),
            ))
        }
    }
    let env = ProvisionEnv::from_body(full_env()).expect("whitelist");
    let profile = crate::vault_profile::test_profile(RELEASED_MASTER_KEY);
    for (purpose, expected) in [
        (EnvelopePurpose::TransportToken, "transport-token/v1"),
        (EnvelopePurpose::MasterKey, "master-key/v1"),
        (EnvelopePurpose::FirstAdmin, "first-admin/v1"),
    ] {
        let transport = Kms(Mutex::new(Vec::new()));
        let result = release_envelope_with(
            &profile,
            &env,
            "legacy-or-mismatched-envelope",
            purpose,
            &Attestation,
            &transport,
        );
        assert!(result.is_err());
        let calls = transport.0.lock().expect("capture lock");
        assert_eq!(
            calls.len(),
            1,
            "context rejection must not retry without context"
        );
        assert_eq!(
            calls[0]["EncryptionContext"],
            json!({
                "neoos:component": "custody",
                "neoos:purpose": expected,
                "neoos:vault-id": profile.document().vault_id,
                "neoos:profile-sha256": hex::encode(profile.profile_hash()),
                "neoos:network-set-sha256": hex::encode(profile.network_set_hash()),
                "neoos:root-key-version": profile.document().root_key_version,
            })
        );
        assert_eq!(calls[0]["KeyId"], profile.document().custody_kms_key_arn);
        let exported: serde_json::Map<String, serde_json::Value> =
            custody_encryption_context(&profile, purpose)
                .into_iter()
                .map(|(key, value)| (key, serde_json::Value::String(value)))
                .collect();
        assert_eq!(
            exported.len(),
            6,
            "offline seal must export exactly the actual Decrypt context"
        );
        assert_eq!(
            serde_json::Value::Object(exported),
            calls[0]["EncryptionContext"]
        );
        assert_eq!(calls[0]["CiphertextBlob"], "legacy-or-mismatched-envelope");
    }
    Ok(())
}

#[test]
fn exported_custody_context_binds_the_validated_profile_without_a_network_override() -> Result<()> {
    let profile = crate::vault_profile::test_profile(RELEASED_MASTER_KEY);
    let original = custody_encryption_context(&profile, EnvelopePurpose::FirstAdmin);
    assert_eq!(original[0], ("neoos:component".into(), "custody".into()));
    assert_eq!(
        original[1],
        ("neoos:purpose".into(), "first-admin/v1".into())
    );
    assert!(!original.iter().any(|(key, _)| key == "neoos:network"));
    for field in ["vault", "root-version", "network", "policy", "key"] {
        let mut document = profile.document().clone();
        match field {
            "vault" => document.vault_id = "fe".repeat(16),
            "root-version" => document.root_key_version = "root-new".into(),
            "network" => document.networks[0].genesis_hash = format!("0x{}", "a1".repeat(32)),
            "policy" => document.release_policy_version = "policy-new".into(),
            "key" => {
                document.custody_kms_key_arn =
                    "arn:aws:kms:us-east-1:123456789012:key/different".into()
            }
            _ => unreachable!(),
        }
        let changed = document.validate()?;
        let context = custody_encryption_context(&changed, EnvelopePurpose::FirstAdmin);
        assert_ne!(
            original[3].1, context[3].1,
            "every destination mutation must change native profile binding"
        );
        assert_eq!(context[3].1, hex::encode(changed.profile_hash()));
        assert_eq!(context[4].1, hex::encode(changed.network_set_hash()));
    }
    Ok(())
}

#[test]
fn host_payload_cannot_supply_a_purpose_or_encryption_context() {
    for name in [
        "neoos:purpose",
        "EncryptionContext",
        "SIGNER_SERVICE_KMS_PURPOSE",
    ] {
        let mut body = full_env();
        body.env.insert(name.to_string(), json!("master-key/v1"));
        assert_eq!(
            unaccepted(ProvisionEnv::from_body(body), "host purpose override"),
            ProvisionError::UnknownKey(name.to_string())
        );
    }
}

#[test]
fn a_missing_required_field_names_itself() -> Result<()> {
    let mut body = full_env();
    body.env.remove(TOKEN_CIPHERTEXT_ENV);
    let body = ProvisionEnv::from_body(body).expect("whitelist passes");
    let dir = tempfile::tempdir()?;
    let gate = gate(dir.path(), canned_releaser());
    let error = refused(
        run(&gate, &body, Some(RELEASED_TOKEN)),
        "no token ciphertext",
    );
    assert_eq!(error, ProvisionError::MissingField(TOKEN_CIPHERTEXT_ENV));
    Ok(())
}

#[test]
fn duplicate_provision_fields_are_rejected_before_map_conversion() {
    for raw in [
        r#"{"env":{"AWS_REGION":"us-east-1","AWS_REGION":"us-east-1"}}"#,
        r#"{"env":{},"env":{}}"#,
        r#"{"env":{"SIGNER_SERVICE_FIRST_ADMIN_KMS_CIPHERTEXT":"one","SIGNER_SERVICE_FIRST_ADMIN_KMS_CIPHERTEXT":"two"}}"#,
    ] {
        assert!(serde_json::from_str::<ProvisionBody>(raw).is_err());
    }
}

#[test]
fn migration_role_pair_selects_genesis_capable_recovery_without_eager_decrypt() {
    let (profile, migration) = crate::embedded::tests::migration_fixture();
    let directory = tempfile::tempdir().unwrap();
    let mut gate = gate(directory.path(), canned_releaser());
    gate.profile = profile;
    gate.migration = Some(migration);
    gate.recoverer = Arc::new(|_, _, _, _, _| panic!("ordinary recovery selected"));
    gate.migration_recoverer = Arc::new(|_, _, _, _, attempt| {
        assert!(!attempt.restore_only);
        Err("synthetic authenticated-head admission pending".into())
    });
    let mut body = full_env();
    body.env
        .insert(LEGACY_ROLE_CIPHERTEXT_ENVS[0].into(), json!("AQ=="));
    body.env
        .insert(LEGACY_ROLE_CIPHERTEXT_ENVS[1].into(), json!("Ag=="));
    let env = ProvisionEnv::from_body_for_migration(body, gate.migration.as_deref()).unwrap();
    assert_eq!(
        refused(
            run(&gate, &env, Some(RELEASED_TOKEN)),
            "fake recovery must hold"
        ),
        ProvisionError::Release("synthetic authenticated-head admission pending".into())
    );
}
