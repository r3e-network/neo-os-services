//! Where the master key comes from, and what sealing actually guarantees.
//!
//! None of these tests touch the process environment. The credential forms are
//! exercised through [`MasterKey::from_credential`] rather than by setting
//! `SIGNER_SERVICE_MASTER_KEY`, because a test that mutates the environment
//! races every other test in the binary — and the branch worth pinning is the
//! parsing, not the variable read.

use anyhow::Result;

use super::*;
use crate::crypto;

fn key_bytes(marker: u8) -> [u8; 32] {
    [marker; 32]
}

#[test]
fn a_generated_file_is_reused_by_the_next_open() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let first = MasterKey::open_or_create_file(dir.path())?;
    let second = MasterKey::open_or_create_file(dir.path())?;

    assert_eq!(first.bytes(), second.bytes());
    assert_ne!(first.bytes(), &[0u8; 32], "a zeroed vault is no vault");
    assert!(master_key_path(dir.path()).exists());
    Ok(())
}

#[test]
fn two_directories_generate_different_keys() -> Result<()> {
    let first_dir = tempfile::tempdir()?;
    let second_dir = tempfile::tempdir()?;
    let first = MasterKey::open_or_create_file(first_dir.path())?;
    let second = MasterKey::open_or_create_file(second_dir.path())?;

    assert_ne!(first.fingerprint(), second.fingerprint());
    Ok(())
}

#[test]
fn a_truncated_master_key_file_is_refused_rather_than_regenerated() -> Result<()> {
    let dir = tempfile::tempdir()?;
    fs::write(master_key_path(dir.path()), "010203")?;

    let error = MasterKey::open_or_create_file(dir.path())
        .err()
        .unwrap_or_else(|| unreachable!("a short hex file must not open as a key"));
    assert!(
        error
            .to_string()
            .contains("does not hold a 64-character hex"),
        "{error}"
    );
    Ok(())
}

#[test]
fn a_hex_credential_is_the_key_itself() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let raw = key_bytes(0xab);
    let credential = hex::encode(raw);
    assert_eq!(credential.len(), MASTER_KEY_HEX_CHARS);

    let key = MasterKey::from_credential(&credential, dir.path())
        .ok()
        .flatten()
        .unwrap_or_else(|| unreachable!("a hex credential supplies a key"));
    assert_eq!(key.bytes(), &raw);
    Ok(())
}

#[test]
fn a_passphrase_is_stretched_and_bound_to_its_directory() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let other = tempfile::tempdir()?;
    let passphrase = "correct horse battery staple";

    let key = MasterKey::from_credential(passphrase, dir.path())?
        .unwrap_or_else(|| unreachable!("a passphrase credential supplies a key"));
    let same_again = MasterKey::from_credential(passphrase, dir.path())?
        .unwrap_or_else(|| unreachable!("the same inputs give the same key"));
    let elsewhere = MasterKey::from_credential(passphrase, other.path())?
        .unwrap_or_else(|| unreachable!("a different directory still supplies a key"));

    assert_eq!(key.bytes(), same_again.bytes());
    // The salt is the directory, so the same passphrase in a different place is
    // a different key on purpose — and the passphrase must not be the key.
    assert_ne!(
        key.bytes().as_slice(),
        crypto::sha256(passphrase.as_bytes()).as_slice()
    );
    assert_ne!(key.fingerprint(), elsewhere.fingerprint());
    Ok(())
}

#[test]
fn a_short_passphrase_is_refused() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let error = MasterKey::from_credential("hunter2", dir.path())
        .err()
        .unwrap_or_else(|| unreachable!("seven characters is not a master credential"));
    assert!(error.to_string().contains(MASTER_KEY_ENV), "{error}");
    Ok(())
}

#[test]
fn an_empty_credential_falls_back_to_the_file() -> Result<()> {
    let dir = tempfile::tempdir()?;
    assert!(MasterKey::from_credential("", dir.path())?.is_none());
    Ok(())
}

#[test]
fn a_sealed_key_opens_only_under_the_key_that_sealed_it() -> Result<()> {
    let vault = MasterKey::from_bytes(key_bytes(0x11));
    let other = MasterKey::from_bytes(key_bytes(0x12));
    let private_key = key_bytes(0x33);

    let sealed = vault.seal(&private_key)?;
    assert_eq!(
        vault.open_sealed(&sealed)?.as_slice(),
        private_key.as_slice()
    );
    assert!(other.open_sealed(&sealed).is_err());
    assert!(
        !hex::encode(&sealed.ciphertext).contains(&hex::encode(private_key)),
        "the plaintext must not appear in the envelope"
    );
    Ok(())
}

#[test]
fn sealing_the_same_key_twice_produces_different_envelopes() -> Result<()> {
    let vault = MasterKey::from_bytes(key_bytes(0x21));
    let private_key = key_bytes(0x44);

    let first = vault.seal(&private_key)?;
    let second = vault.seal(&private_key)?;
    assert_ne!(first.nonce, second.nonce);
    assert_ne!(first.ciphertext, second.ciphertext);
    assert_eq!(
        vault.open_sealed(&first)?.as_slice(),
        vault.open_sealed(&second)?.as_slice()
    );
    Ok(())
}

#[test]
fn a_tampered_ciphertext_is_refused() -> Result<()> {
    let vault = MasterKey::from_bytes(key_bytes(0x51));
    let mut sealed = vault.seal(&key_bytes(0x66))?;
    let last = sealed
        .ciphertext
        .last_mut()
        .unwrap_or_else(|| unreachable!("an envelope is never empty"));
    *last ^= 0x01;

    assert!(vault.open_sealed(&sealed).is_err());
    Ok(())
}
