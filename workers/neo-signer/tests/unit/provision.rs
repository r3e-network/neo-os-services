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
/// according to which ciphertext it was asked about — the way the real one
/// branches on a KMS response body rather than on its caller's intent.
fn canned_releaser() -> EnvelopeReleaser {
    Arc::new(|_env: &ProvisionEnv, ciphertext: &str| match ciphertext {
        TOKEN_CIPHERTEXT => Ok(RELEASED_TOKEN.as_bytes().to_vec()),
        MASTER_CIPHERTEXT => Ok(RELEASED_MASTER_KEY.to_vec()),
        other => Err(format!("the canned KMS has no envelope for {other}")),
    })
}

fn gate(dir: &Path, releaser: EnvelopeReleaser) -> ProvisionGate {
    let repository = crate::store::Store::open(dir.join("signer.db")).expect("store opens");
    ProvisionGate {
        repository,
        data_dir: dir.to_path_buf(),
        releaser,
        mutex: Mutex::new(()),
    }
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
    let short = Arc::new(|_env: &ProvisionEnv, ciphertext: &str| {
        if ciphertext == TOKEN_CIPHERTEXT {
            Ok(RELEASED_TOKEN.as_bytes().to_vec())
        } else {
            Ok(vec![0x5a; 16])
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
fn without_a_master_ciphertext_the_vault_is_enclave_born() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let mut body = full_env();
    body.env.remove(MASTER_KEY_CIPHERTEXT_ENV);
    let service = run_with(dir.path(), body, Some(RELEASED_TOKEN))
        .expect("the enclave-born fallback opens a vault");
    // The file now exists in the data directory — the fallback's caveat, and
    // the reason the runbook tells the operator to prefer the ciphertext.
    assert!(dir.path().join(crate::vault::MASTER_KEY_FILE).exists());
    assert!(!service.vault_fingerprint().is_empty());
    Ok(())
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
