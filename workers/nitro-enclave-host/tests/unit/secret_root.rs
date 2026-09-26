//! Subkeys of the KMS secret root: RFC 5869 HKDF-SHA256 under the documented
//! salt and labels, one distinct key per purpose, never the root itself.

use super::*;
use hmac::{Hmac, Mac};

const ROOT: [u8; 32] = [0x11; 32];

fn hmac_sha256(key: &[u8], parts: &[&[u8]]) -> [u8; 32] {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("HMAC accepts any key length");
    for part in parts {
        mac.update(part);
    }
    mac.finalize().into_bytes().into()
}

/// RFC 5869 section 2 written out with HMAC alone, for L = 32:
/// PRK = HMAC(salt, IKM), OKM = T(1) = HMAC(PRK, info || 0x01).
fn rfc5869_okm32(salt: &[u8], ikm: &[u8], info: &[u8]) -> [u8; 32] {
    let prk = hmac_sha256(salt, &[ikm]);
    hmac_sha256(&prk, &[info, &[0x01]])
}

#[test]
fn the_reference_construction_matches_rfc5869_test_case_1() {
    let ikm = [0x0b_u8; 22];
    let salt: Vec<u8> = (0x00..=0x0c).collect();
    let info: Vec<u8> = (0xf0..=0xf9).collect();
    assert_eq!(
        hex::encode(rfc5869_okm32(&salt, &ikm, &info)),
        // RFC 5869 A.1, the first 32 of the 42 OKM bytes.
        "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf"
    );
}

#[test]
fn subkeys_are_hkdf_sha256_under_the_documented_salt_and_labels() {
    assert_eq!(ROOT_SALT, b"neoos-kms-secret-root/v1");
    assert_eq!(VRF_KEY_INFO, b"neoos-vrf-random-key/v1");
    assert_eq!(GAME_SESSION_KEY_INFO, b"neoos-game-session-key/v1");
    assert_eq!(
        vrf_key(&ROOT),
        rfc5869_okm32(ROOT_SALT, &ROOT, b"neoos-vrf-random-key/v1")
    );
    assert_eq!(
        game_session_key(&ROOT),
        rfc5869_okm32(ROOT_SALT, &ROOT, b"neoos-game-session-key/v1")
    );
    // Pinned values, computed outside Rust, so a change to the salt, a label
    // or the algorithm fails here even if the reference above moved with it.
    assert_eq!(
        hex::encode(vrf_key(&ROOT)),
        "3adcbfe11a95eec7aefc2b4171aef3202d1d5bd5c9510a35db6b0d42b89ea188"
    );
    assert_eq!(
        hex::encode(game_session_key(&ROOT)),
        "573e2f6cc21b147a0bbe1198463570ab7f7272e50e97c6774b927631a85eafcd"
    );
}

#[test]
fn the_game_lane_and_the_vrf_never_share_a_key_or_use_the_root() {
    assert_ne!(VRF_KEY_INFO, GAME_SESSION_KEY_INFO);
    for root in [[0x00_u8; 32], ROOT, [0xff_u8; 32]] {
        let vrf = vrf_key(&root);
        let game = game_session_key(&root);
        assert_ne!(vrf, game);
        assert_ne!(vrf, root);
        assert_ne!(game, root);
    }
}
