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

/// Hand-encode a COSE_Sign1 whose payload is
/// `{"pcrs": {"0": h'<pcr0>'}, "nonce": h'<nonce>'}` — or, when `nonce` is
/// `None`, the same document with no `nonce` key at all (the pre-CL-03 shape,
/// and what an unchallenged replay looks like).
///
/// The NSM emits exactly this shape (tag 18, four elements, CBOR map payload);
/// building it by hand keeps the test's bytes reviewable against the spec.
fn cose_sign1(pcr0: &[u8], nonce: Option<&[u8]>) -> Vec<u8> {
    let mut pcrs = vec![0xA1, 0x61, b'0', 0x58, pcr0.len() as u8];
    pcrs.extend_from_slice(pcr0);
    let mut payload = vec![
        if nonce.is_some() { 0xA2 } else { 0xA1 },
        0x64,
        b'p',
        b'c',
        b'r',
        b's',
    ];
    payload.extend_from_slice(&pcrs);
    if let Some(nonce) = nonce {
        payload.extend_from_slice(&[0x65, b'n', b'o', b'n', b'c', b'e', 0x58, nonce.len() as u8]);
        payload.extend_from_slice(nonce);
    }
    let mut document = vec![0xD2, 0x84, 0x40, 0xA0, 0x58, payload.len() as u8];
    document.extend_from_slice(&payload);
    document.extend_from_slice(&[0x43, 0x01, 0x02, 0x03]);
    document
}

/// The pre-CL-03 helper, kept for the cases that are about a document the
/// guard must refuse for some OTHER reason.
fn cose_sign1_with_pcr0(pcr0: &[u8]) -> Vec<u8> {
    cose_sign1(pcr0, None)
}

/// A source that behaves like a live NSM: it echoes back the nonce it was
/// challenged with. Every test about PCR semantics uses this, so a PCR
/// assertion can never be satisfied by the freshness refusal instead.
struct LiveNsm {
    pcr0: Vec<u8>,
}

impl LiveNsm {
    fn with_pcr0(pcr0: &[u8]) -> Self {
        LiveNsm {
            pcr0: pcr0.to_vec(),
        }
    }
}

impl AttestationSource for LiveNsm {
    fn attest(
        &self,
        nonce: Option<&[u8]>,
        _user_data: Option<&[u8]>,
        _public_key: Option<&[u8]>,
    ) -> Result<Vec<u8>, String> {
        Ok(cose_sign1(&self.pcr0, nonce))
    }
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
    let reported = guard
        .verify(&LiveNsm::with_pcr0(&measured))
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
        .verify(&LiveNsm::with_pcr0(&[0x3d; PCR0_LEN]))
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
        .verify(&LiveNsm::with_pcr0(&[0x2c; PCR0_LEN]))
        .expect_err("a different image is a different enclave");
    assert!(error.contains("does not match"), "{error}");
}

#[test]
fn verify_refuses_a_different_measurement() {
    let guard = BootGuard::from_pin(PINNED_PCR0).expect("the constant parses");
    let error = guard
        .verify(&LiveNsm::with_pcr0(&[0x2c; PCR0_LEN]))
        .expect_err("a different image is a different enclave");
    assert!(error.contains("does not match"), "{error}");
}

/// An all-zero PCR0 is the unmeasured-environment signature — an emulated or
/// broken NSM — and is refused even when no pin narrows the acceptance.
#[test]
fn verify_refuses_an_all_zero_pcr0_without_a_pin() {
    let _env = lock_env();
    std::env::set_var(ATTESTED_BOOT_ENV, "require");
    std::env::remove_var(EXPECTED_PCR0_ENV);
    let guard = BootGuard::from_env()
        .expect("parses")
        .expect("require produces a guard");
    let error = guard
        .verify(&LiveNsm::with_pcr0(&[0x00; PCR0_LEN]))
        .expect_err("all zeros is not a measured image");
    assert!(error.contains("all zeros"), "{error}");
    std::env::remove_var(ATTESTED_BOOT_ENV);
}

/// The all-zero refusal precedes the pin comparison, so even a (nonsensical)
/// all-zero pin cannot turn an unmeasured environment into a pass.
#[test]
fn the_all_zero_refusal_precedes_the_pin_comparison() {
    let guard = BootGuard::from_pin(PINNED_PCR0).expect("the constant parses");
    let error = guard
        .verify(&LiveNsm::with_pcr0(&[0x00; PCR0_LEN]))
        .expect_err("all zeros is refused regardless of the pin");
    assert!(error.contains("all zeros"), "{error}");
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

// ---------------------------------------------------------------------------
// SVC-A-6 — the challenge is checked, not merely issued (CL-03)
// ---------------------------------------------------------------------------

/// A source that replays one recorded document no matter what it is asked.
/// This is a cached real document from an earlier boot, or a `/dev/nsm`
/// emulator: syntactically perfect, cryptographically irrelevant.
struct ReplayedDocument(Vec<u8>);

impl AttestationSource for ReplayedDocument {
    fn attest(
        &self,
        _nonce: Option<&[u8]>,
        _user_data: Option<&[u8]>,
        _public_key: Option<&[u8]>,
    ) -> Result<Vec<u8>, String> {
        Ok(self.0.clone())
    }
}

/// A recorded document whose PCR0 is exactly the pinned one still fails: it
/// answers somebody else's challenge. Before the fix this passed, because the
/// generated nonce was never compared to anything.
#[test]
fn a_replayed_document_with_the_right_pcr0_is_still_refused() {
    let guard = BootGuard::from_pin(PINNED_PCR0).expect("the constant parses");
    let measured = decode_pcr0(PINNED_PCR0).expect("the constant parses");
    let stale = cose_sign1(&measured, Some(&[0x5au8; NONCE_LEN]));
    let error = guard
        .verify(&ReplayedDocument(stale))
        .expect_err("a document answering an older challenge is not this boot's answer");
    assert!(
        error.contains("does not answer this boot's challenge"),
        "{error}"
    );
}

/// A document with no nonce at all is refused rather than waved through as
/// "nothing to compare".
#[test]
fn a_document_with_no_nonce_is_refused() {
    let guard = BootGuard::from_pin(PINNED_PCR0).expect("the constant parses");
    let measured = decode_pcr0(PINNED_PCR0).expect("the constant parses");
    let error = guard
        .verify(&ReplayedDocument(cose_sign1(&measured, None)))
        .expect_err("an unchallenged document proves no liveness");
    assert!(error.contains("no nonce"), "{error}");
}

/// A truncated echo is not a match either — the comparison is on the whole
/// value, not a prefix.
#[test]
fn a_truncated_nonce_echo_is_refused() {
    let guard = BootGuard::from_pin(PINNED_PCR0).expect("the constant parses");
    let measured = decode_pcr0(PINNED_PCR0).expect("the constant parses");
    let error = guard
        .verify(&ReplayedDocument(cose_sign1(&measured, Some(&[0u8; 4]))))
        .expect_err("a 4-byte answer is not a 16-byte challenge");
    assert!(
        error.contains("does not answer this boot's challenge"),
        "{error}"
    );
}

/// The live NSM path still passes: a source that echoes the challenge is
/// accepted, so the new check does not simply break every boot.
#[test]
fn an_echoing_nsm_still_passes() {
    let guard = BootGuard::from_pin(PINNED_PCR0).expect("the constant parses");
    let measured = decode_pcr0(PINNED_PCR0).expect("the constant parses");
    assert_eq!(
        guard
            .verify(&LiveNsm::with_pcr0(&measured))
            .expect("a live NSM answers the challenge"),
        PINNED_PCR0
    );
}

/// Each boot issues a different challenge, so two boots cannot share an
/// answer. (The guard never exposes the nonce, so the observable proof is
/// that a document captured from one verify does not satisfy the next.)
#[test]
fn each_boot_issues_a_fresh_challenge() {
    use std::sync::Mutex as StdMutex;

    struct Recording {
        pcr0: Vec<u8>,
        seen: StdMutex<Vec<Vec<u8>>>,
    }

    impl AttestationSource for Recording {
        fn attest(
            &self,
            nonce: Option<&[u8]>,
            _user_data: Option<&[u8]>,
            _public_key: Option<&[u8]>,
        ) -> Result<Vec<u8>, String> {
            self.seen
                .lock()
                .expect("nonce log")
                .push(nonce.expect("a challenge is issued").to_vec());
            Ok(cose_sign1(&self.pcr0, nonce))
        }
    }

    let measured = decode_pcr0(PINNED_PCR0).expect("the constant parses");
    let source = Recording {
        pcr0: measured.to_vec(),
        seen: StdMutex::new(Vec::new()),
    };
    let guard = BootGuard::from_pin(PINNED_PCR0).expect("the constant parses");
    guard.verify(&source).expect("first boot");
    guard.verify(&source).expect("second boot");
    let seen = source.seen.lock().expect("nonce log");
    assert_eq!(seen.len(), 2);
    assert_eq!(seen[0].len(), NONCE_LEN);
    assert_ne!(seen[0], seen[1], "the challenge must be fresh per boot");
}
