//! The attested identity: canonical serialization, and the two digests a
//! verifier recomputes.

use anyhow::Result;
use serde_json::Value;

use super::*;
use crate::crypto;
use crate::model::{SealedPrivateKey, SignerKey};
use crate::network::{network_magic, Network};

fn key_with(label: &str, disabled: bool) -> SignerKey {
    let private = crypto::generate_private_key();
    let public_key = crypto::public_key_from_private(&private)
        .expect("a generated scalar is always a valid key");
    SignerKey {
        id: format!("key-{label}"),
        label: label.to_string(),
        network: Network::Testnet,
        network_magic: network_magic(Network::Testnet),
        public_key,
        sealed: SealedPrivateKey {
            nonce: [0u8; 12],
            ciphertext: Vec::new(),
        },
        created_at_unix: 0,
        disabled,
    }
}

fn boundary(label: &str, disabled: bool, allow_transfer: bool) -> KeyBoundary {
    KeyBoundary::new(
        &key_with(label, disabled),
        SignerPolicy {
            allow_transfer,
            ..SignerPolicy::default()
        },
    )
    .expect("a real curve point always binds")
}

#[test]
fn a_boundary_binds_identity_and_the_whole_policy() -> Result<()> {
    let value = boundary("treasury", false, true).to_json();
    assert_eq!(value["key_id"], "key-treasury");
    assert_eq!(value["network"], Network::Testnet.to_string());
    assert_eq!(value["network_magic"], network_magic(Network::Testnet));
    assert_eq!(value["disabled"], false);
    assert_eq!(value["policy"]["allow_transfer"], true);
    // Closed-by-default shows up as the absence of permission, not as a
    // default the reader has to know.
    assert_eq!(value["policy"]["allow_consensus"], false);
    assert_eq!(value["policy"]["contract_whitelist"], Value::Array(vec![]));
    // The script hash is the reversed-wire display a verifier checks on chain.
    let script_hash = value["script_hash"].as_str().expect("string");
    assert!(script_hash.starts_with("0x"), "{script_hash}");
    Ok(())
}

#[test]
fn the_boundaries_document_is_canonical_and_order_stable() {
    let keys = vec![boundary("a", false, false), boundary("b", false, true)];
    let once = boundaries_json(&keys);
    let again = boundaries_json(&keys);
    assert_eq!(once, again, "the digest is only meaningful if this holds");
    // Field order is fixed by construction, and the document is compact.
    assert!(once.starts_with("[{\"key_id\":"), "{once}");
    assert!(!once.contains(' '), "{once}");
}

#[test]
fn the_digest_changes_with_the_boundaries_it_commits_to() {
    let closed = vec![boundary("a", false, false)];
    let open = vec![boundary("a", false, true)];
    let disabled = vec![boundary("a", true, false)];
    assert_ne!(boundaries_sha256(&closed), boundaries_sha256(&open));
    assert_ne!(boundaries_sha256(&closed), boundaries_sha256(&disabled));
    // Ordering is part of the commitment too: a re-ordered vault is a
    // different document, which is what makes the digest worth checking.
    let swapped = vec![boundary("b", false, true), boundary("a", false, false)];
    assert_ne!(boundaries_sha256(&swapped), boundaries_sha256(&open));
}

#[test]
fn network_magic_is_part_of_the_attested_boundary_digest() {
    let first_key = key_with("private", false);
    let mut second_key = first_key.clone();
    second_key.network_magic = first_key.network_magic.wrapping_add(1);
    let policy = SignerPolicy::default();
    let first = vec![KeyBoundary::new(&first_key, policy.clone()).expect("boundary")];
    let second = vec![KeyBoundary::new(&second_key, policy).expect("boundary")];

    assert_ne!(boundaries_json(&first), boundaries_json(&second));
    assert_ne!(boundaries_sha256(&first), boundaries_sha256(&second));
}

#[test]
fn user_data_binds_the_runtime_the_vault_and_the_digest() {
    let digest = boundaries_sha256(&[boundary("a", false, false)]);
    let user_data = attestation_user_data("fp01", &digest);
    let parsed: Value = serde_json::from_slice(&user_data).expect("the bytes are JSON");
    assert_eq!(parsed["runtime"], RUNTIME_NAME);
    assert_eq!(parsed["vault"], "fp01");
    assert_eq!(parsed["boundaries_sha256"], digest);
    // The NSM caps user_data at 512 bytes; the whole design rests on staying
    // under it, so the test keeps the promise visible.
    assert!(user_data.len() <= 512, "{} bytes", user_data.len());
}
