//! Per-purpose subkeys of the recipient-attested KMS secret root.
//!
//! `/provision` materializes one 32-byte root (`MORPHEUS_GAME_SECRET_ROOT_HEX`,
//! source `nitro-recipient-kms`). No lane keys a MAC with the root itself:
//! each lane expands its own subkey with HKDF-SHA256 (RFC 5869) under a
//! distinct `info` label, so a MAC computed for one purpose can neither
//! collide with nor stand in for a MAC of another purpose, whatever the two
//! input formats look like.

use hkdf::Hkdf;
use sha2::Sha256;

/// HKDF-Extract salt. It names the root the subkeys are expanded from.
pub(crate) const ROOT_SALT: &[u8] = b"neoos-kms-secret-root/v1";
/// HKDF-Expand `info` of the `/vrf/random` subkey.
pub(crate) const VRF_KEY_INFO: &[u8] = b"neoos-vrf-random-key/v1";
/// HKDF-Expand `info` of the confidential game-session subkey.
pub(crate) const GAME_SESSION_KEY_INFO: &[u8] = b"neoos-game-session-key/v1";

/// The key of the `/vrf/random` output MAC.
pub(crate) fn vrf_key(root: &[u8; 32]) -> [u8; 32] {
    expand(root, VRF_KEY_INFO)
}

/// The key the game-session state machine uses for problem secrets and
/// resume-record proofs.
pub(crate) fn game_session_key(root: &[u8; 32]) -> [u8; 32] {
    expand(root, GAME_SESSION_KEY_INFO)
}

fn expand(root: &[u8; 32], info: &[u8]) -> [u8; 32] {
    let mut key = [0u8; 32];
    Hkdf::<Sha256>::new(Some(ROOT_SALT), root)
        .expand(info, &mut key)
        .expect("32 bytes is a valid HKDF-SHA256 output length");
    key
}

#[cfg(test)]
#[path = "../tests/unit/secret_root.rs"]
mod tests;
