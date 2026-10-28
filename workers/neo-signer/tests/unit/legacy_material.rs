use super::*;

fn fixture(scalar: u8) -> ([u8; 32], [u8; 33], String) {
    let mut key = [0u8; 32];
    key[31] = scalar;
    let public = crate::crypto::public_key_from_private(&key).unwrap();
    let mut payload = vec![0x80];
    payload.extend_from_slice(&key);
    payload.push(0x01);
    (key, public, crate::crypto::base58check_encode(&payload))
}

#[test]
fn direct_wif_preserves_the_exact_existing_identity() {
    let (key, public, wif) = fixture(1);
    assert_eq!(
        hex::encode(public),
        "036b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296"
    );
    let got =
        decode_identity_bound_n3_material(wif.as_bytes(), LegacyN3Role::OracleVerifier, &public)
            .unwrap();
    assert_eq!(*got, key);
    let padded = format!(" \n{wif}\t");
    assert_eq!(
        *decode_identity_bound_n3_material(padded.as_bytes(), LegacyN3Role::Updater, &public)
            .unwrap(),
        key
    );
}

#[test]
fn only_single_role_appropriate_json_aliases_are_accepted() {
    let (key, public, wif) = fixture(2);
    for (role, fields) in [
        (
            LegacyN3Role::OracleVerifier,
            ["wif", "private_key", "oracle_verifier_wif"],
        ),
        (LegacyN3Role::Updater, ["wif", "private_key", "updater_wif"]),
    ] {
        for field in fields {
            let text = format!(r#"{{"{field}":"{wif}"}}"#);
            assert_eq!(
                *decode_identity_bound_n3_material(text.as_bytes(), role, &public).unwrap(),
                key
            );
        }
    }
    let wrong = format!(r#"{{"updater_wif":"{wif}"}}"#);
    assert_eq!(
        decode_identity_bound_n3_material(wrong.as_bytes(), LegacyN3Role::OracleVerifier, &public),
        Err(LegacyMaterialError::Format)
    );
    let wrong = format!(r#"{{"oracle_verifier_wif":"{wif}"}}"#);
    assert_eq!(
        decode_identity_bound_n3_material(wrong.as_bytes(), LegacyN3Role::Updater, &public),
        Err(LegacyMaterialError::Format)
    );
}

#[test]
fn duplicate_competing_unknown_and_trailing_json_are_refused() {
    let (_, public, wif) = fixture(3);
    for text in [
        format!(r#"{{"wif":"{wif}","wif":"{wif}"}}"#),
        format!(r#"{{"wif":"{wif}","private_key":"{wif}"}}"#),
        format!(r#"{{"wif":"{wif}","extra":true}}"#),
        format!(r#"{{"extra":"{wif}"}}"#),
        format!(r#"{{"wif":"{wif}"}} {{}}"#),
        r#"{"wif":null}"#.to_string(),
        r#"{"wif":7}"#.to_string(),
        "{}".to_string(),
        format!(r#"["{wif}"]"#),
    ] {
        assert_eq!(
            decode_identity_bound_n3_material(text.as_bytes(), LegacyN3Role::Updater, &public),
            Err(LegacyMaterialError::Format)
        );
    }
}

#[test]
fn wrong_version_marker_checksum_and_non_wif_forms_are_refused() {
    let (key, public, wif) = fixture(4);
    let mut wrong_checksum = wif.clone();
    wrong_checksum.replace_range(51..52, if wif.ends_with('1') { "2" } else { "1" });
    let mut values = vec![
        wrong_checksum,
        hex::encode(key),
        format!("0x{}", hex::encode(key)),
        "6Pnot-a-supported-envelope".into(),
    ];
    for (version, marker) in [(0x81, Some(0x01)), (0x80, Some(0x02)), (0x80, None)] {
        let mut bytes = vec![version];
        bytes.extend_from_slice(&key);
        if let Some(marker) = marker {
            bytes.push(marker);
        }
        values.push(crate::crypto::base58check_encode(&bytes));
    }
    for value in values {
        assert_eq!(
            decode_identity_bound_n3_material(
                value.as_bytes(),
                LegacyN3Role::OracleVerifier,
                &public
            ),
            Err(LegacyMaterialError::Format)
        );
    }
}

#[test]
fn mismatched_and_malformed_public_identities_fail_closed() {
    let (_, public, wif) = fixture(5);
    let (_, other, _) = fixture(6);
    assert_eq!(
        decode_identity_bound_n3_material(wif.as_bytes(), LegacyN3Role::OracleVerifier, &other),
        Err(LegacyMaterialError::IdentityMismatch)
    );
    assert_eq!(
        decode_identity_bound_n3_material(wif.as_bytes(), LegacyN3Role::OracleVerifier, &[0u8; 33]),
        Err(LegacyMaterialError::InvalidExpectedIdentity)
    );
    let mut noncanonical = public;
    noncanonical[0] = 4;
    assert_eq!(
        decode_identity_bound_n3_material(
            wif.as_bytes(),
            LegacyN3Role::OracleVerifier,
            &noncanonical
        ),
        Err(LegacyMaterialError::InvalidExpectedIdentity)
    );
}

#[test]
fn zero_and_out_of_range_scalars_are_refused() {
    let (_, public, _) = fixture(1);
    for key in [[0u8; 32], [0xffu8; 32]] {
        let mut payload = vec![0x80];
        payload.extend_from_slice(&key);
        payload.push(1);
        let wif = crate::crypto::base58check_encode(&payload);
        assert_eq!(
            decode_identity_bound_n3_material(wif.as_bytes(), LegacyN3Role::Updater, &public),
            Err(LegacyMaterialError::InvalidPrivateKey)
        );
    }
}

#[test]
fn bounded_invalid_utf8_and_secret_safe_errors() {
    let (_, public, wif) = fixture(7);
    for value in [vec![], vec![b'x'; 4097], vec![0xff, 0xfe]] {
        assert_eq!(
            decode_identity_bound_n3_material(&value, LegacyN3Role::Updater, &public),
            Err(LegacyMaterialError::Format)
        );
    }
    let (_, other, _) = fixture(8);
    let error = decode_identity_bound_n3_material(wif.as_bytes(), LegacyN3Role::Updater, &other)
        .unwrap_err();
    assert!(!format!("{error:?}: {error}").contains(&wif));
    assert!(!format!("{error:?}: {error}").contains(&hex::encode(fixture(7).0)));
}
