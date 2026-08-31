//! The boot guard as the operator's two mistakes and one attack would meet it.
//!
//! The environment cases share a mutex because `from_env` reads process-global
//! state and the test runner parallelizes; every test that touches a variable
//! holds the lock for its whole body.

use std::sync::{Mutex, MutexGuard};

use super::*;
use nitro_attest::release::AttestationSource;

/// A PCR0 that is not all zeros, so a false match cannot come from an
/// uninitiated comparison.
const PINNED_PCR0: &str =
    "3d45a0b5c2e1f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7";

static ENV_LOCK: Mutex<()> = Mutex::new(());

fn lock_env() -> MutexGuard<'static, ()> {
    ENV_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// A source with one canned document: the stand-in for `/dev/nsm`.
struct FixedDocument(Vec<u8>);

impl AttestationSource for FixedDocument {
    fn attest(
        &self,
        _nonce: Option<&[u8]>,
        _user_data: Option<&[u8]>,
        _public_key: Option<&[u8]>,
    ) -> Result<Vec<u8>, String> {
        Ok(self.0.clone())
    }
}

/// Hand-encode a COSE_Sign1 whose payload is `{"pcrs": {"0": h'<pcr0>'}}`.
///
/// The NSM emits exactly this shape (tag 18, four elements, CBOR map payload);
/// building it by hand keeps the test's bytes reviewable against the spec.
fn cose_sign1_with_pcr0(pcr0: &[u8]) -> Vec<u8> {
    let mut pcrs = vec![0xA1, 0x61, b'0', 0x58, pcr0.len() as u8];
    pcrs.extend_from_slice(pcr0);
    let mut payload = vec![0xA1, 0x64, b'p', b'c', b'r', b's'];
    payload.extend_from_slice(&pcrs);
    let mut document = vec![0xD2, 0x84, 0x40, 0xA0, 0x58, payload.len() as u8];
    document.extend_from_slice(&payload);
    document.extend_from_slice(&[0x43, 0x01, 0x02, 0x03]);
    document
}

#[test]
fn unset_is_host_mode() {
    let _env = lock_env();
    std::env::remove_var(ATTESTED_BOOT_ENV);
    assert!(BootGuard::from_env().expect("unset reads fine").is_none());
}

#[test]
fn a_value_other_than_require_is_a_refusal_not_a_downgrade() {
    let _env = lock_env();
    std::env::set_var(ATTESTED_BOOT_ENV, "Require");
    let error = match BootGuard::from_env() {
        Ok(Some(_)) | Ok(None) => panic!("a typo must not fall back to host mode"),
        Err(error) => error,
    };
    assert!(error.to_string().contains(ATTESTED_BOOT_ENV), "{error}");
    std::env::set_var(ATTESTED_BOOT_ENV, "yes");
    assert!(BootGuard::from_env().is_err());
    std::env::remove_var(ATTESTED_BOOT_ENV);
}

#[test]
fn require_refuses_a_malformed_pin_and_accepts_a_well_formed_one() {
    let _env = lock_env();
    std::env::set_var(ATTESTED_BOOT_ENV, "require");

    std::env::set_var(EXPECTED_PCR0_ENV, "00");
    assert!(BootGuard::from_env().is_err(), "48 bytes or nothing");

    std::env::set_var(EXPECTED_PCR0_ENV, "zz");
    assert!(BootGuard::from_env().is_err(), "hexadecimal or nothing");

    std::env::set_var(EXPECTED_PCR0_ENV, PINNED_PCR0);
    BootGuard::from_env()
        .expect("a well-formed pin parses")
        .expect("require produces a guard");
    std::env::remove_var(ATTESTED_BOOT_ENV);
    std::env::remove_var(EXPECTED_PCR0_ENV);
}

#[test]
fn verify_accepts_the_pinned_measurement() {
    let _env = lock_env();
    std::env::set_var(ATTESTED_BOOT_ENV, "require");
    std::env::set_var(EXPECTED_PCR0_ENV, PINNED_PCR0);
    let guard = BootGuard::from_env()
        .expect("parses")
        .expect("require produces a guard");
    let measured = decode_pcr0(PINNED_PCR0).expect("the constant parses");
    let document = cose_sign1_with_pcr0(&measured);
    let reported = guard
        .verify(&FixedDocument(document))
        .expect("the measured image is the pinned image");
    assert_eq!(reported, PINNED_PCR0);
    std::env::remove_var(ATTESTED_BOOT_ENV);
    std::env::remove_var(EXPECTED_PCR0_ENV);
}

#[test]
fn require_without_a_pin_still_reports_the_measurement() {
    let _env = lock_env();
    std::env::set_var(ATTESTED_BOOT_ENV, "require");
    std::env::remove_var(EXPECTED_PCR0_ENV);
    let guard = BootGuard::from_env()
        .expect("require without a pin parses")
        .expect("require produces a guard");
    // No pin: nothing to compare, but the guard still fails closed on a
    // document it cannot read, and it reports the measured value — which is
    // what the operator pins in the KMS key policy.
    let reported = guard
        .verify(&FixedDocument(cose_sign1_with_pcr0(&[0x3d; PCR0_LEN])))
        .expect("the document parses");
    assert_eq!(reported, hex::encode([0x3d; PCR0_LEN]));
    std::env::remove_var(ATTESTED_BOOT_ENV);
}

#[test]
fn from_pin_is_the_same_check_with_a_literal() {
    assert!(BootGuard::from_pin("00").is_err());
    assert!(BootGuard::from_pin("zz").is_err());
    let guard = BootGuard::from_pin(PINNED_PCR0).expect("the constant parses");
    let error = guard
        .verify(&FixedDocument(cose_sign1_with_pcr0(&[0x00; PCR0_LEN])))
        .expect_err("a different image is a different enclave");
    assert!(error.contains("does not match"), "{error}");
}

#[test]
fn verify_refuses_a_different_measurement() {
    let guard = BootGuard::from_pin(PINNED_PCR0).expect("the constant parses");
    let document = cose_sign1_with_pcr0(&[0x00; PCR0_LEN]);
    let error = guard
        .verify(&FixedDocument(document))
        .expect_err("a different image is a different enclave");
    assert!(error.contains("does not match"), "{error}");
}

#[test]
fn verify_fails_closed_on_a_document_it_cannot_parse() {
    let guard = BootGuard::from_pin(PINNED_PCR0).expect("the constant parses");
    for garbage in [
        Vec::new(),
        vec![0xFF, 0xFF],
        // A 4-element array whose payload is not a map: still refused.
        vec![0xD2, 0x84, 0x40, 0xA0, 0x40, 0x43, 0x01, 0x02, 0x03],
    ] {
        assert!(
            guard.verify(&FixedDocument(garbage.clone())).is_err(),
            "garbage must fail closed: {garbage:?}"
        );
    }
}

#[test]
fn extract_pcr0_reads_the_nsms_register_zero() {
    let pcr0 = [0x11u8; PCR0_LEN];
    let document = cose_sign1_with_pcr0(&pcr0);
    assert_eq!(
        extract_pcr0(&document).expect("the hand-built document parses"),
        pcr0
    );
}

#[test]
fn extract_pcr0_refuses_a_missing_register() {
    // A valid COSE_Sign1 whose pcrs map holds only PCR1: no PCR0, no guess.
    let mut payload = vec![
        0xA1,
        0x64,
        b'p',
        b'c',
        b'r',
        b's',
        0xA1,
        0x61,
        b'1',
        0x58,
        PCR0_LEN as u8,
    ];
    payload.extend_from_slice(&[0x22u8; PCR0_LEN]);
    let mut document = vec![0xD2, 0x84, 0x40, 0xA0, 0x58, payload.len() as u8];
    document.extend_from_slice(&payload);
    document.extend_from_slice(&[0x43, 0x01, 0x02, 0x03]);
    let error = extract_pcr0(&document).expect_err("PCR1 is not PCR0");
    assert!(error.contains("PCR0"), "{error}");
}
