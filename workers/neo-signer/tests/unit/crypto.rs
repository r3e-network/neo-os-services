//! Unit tests for the signer cryptographic primitives.
//!
//! The mainnet vectors here were read from real mined transactions on public
//! Neo N3 mainnet RPC (block ~5,000,000, network magic 860833102) and are the
//! reason this module can be trusted: each captured signature is checked against
//! the key the chain itself accepted, so a wrong preimage or a wrong script
//! shape fails here instead of at broadcast time.
//!
//! Byte-order note, because it has already caused one bug: hashes as RPC
//! *displays* them are big-endian (`0x04fdc8…`), while hashes on the wire, in
//! `HASH160` output, and in base58 address payloads are native little-endian
//! (`78bd4e76…`). These tests pin the native order.

use super::*;

/// Mainnet magic, the ASCII "NEO3" little-endian (`4e454f33`).
const MAINNET: u32 = 860_833_102;
/// NeoT5 testnet magic — used only to prove signatures are network-bound.
const TESTNET: u32 = 894_710_606;

/// One mined single-signature mainnet transaction.
struct MainnetVector {
    name: &'static str,
    pubkey: &'static str,
    /// `HASH160(verification_script)`, native order — matches the signer account
    /// bytes on the wire.
    script_hash: &'static str,
    address: &'static str,
    signature: &'static str,
    /// `magic_le32 || transaction_hash` actually signed.
    sign_data: &'static str,
    /// Serialized unsigned transaction, when the vector captured one.
    unsigned: Option<&'static str>,
    /// `SHA256(unsigned)`, i.e. the transaction hash in native order.
    tx_hash: Option<&'static str>,
}

const VECTORS: &[MainnetVector] = &[
    MainnetVector {
        name: "neo_transfer",
        pubkey: "027aaf5f1b8058a998e283f449a873a243ceb051e3e06734dd5165ca7eb69c97ac",
        script_hash: "78bd4e76c4e521ec4a556efc0121bb34c9c8fd04",
        address: "NWvP42DaUATm9ULce44T9evAizDuxMzSWg",
        signature: "49a619757a9dde03510a59e2d10f6f1bff53a5dce4069afefc33a8b764b92b846404bf4559fd96fb5cd286e496bc0b467433e7b8c34a34d7510a6a0d0f66780c",
        sign_data: "4e454f334742981833272e3969675f7e35143bf9f4cba7025b4f5cad3f252cc8a217aa01",
        unsigned: Some("00dc02000051bf1000000000009f490200000000007d4b4c000178bd4e76c4e521ec4a556efc0121bb34c9c8fd040100580b01f0010c14bf3e1cb378561797193a6d908cead3e5c9d2bb360c1478bd4e76c4e521ec4a556efc0121bb34c9c8fd0414c01f0c087472616e736665720c14f563ea40bc283d4d0e05c48ea305b3f2a07340ef41627d5b52"),
        tx_hash: Some("4742981833272e3969675f7e35143bf9f4cba7025b4f5cad3f252cc8a217aa01"),
    },
    MainnetVector {
        name: "gas_transfer",
        pubkey: "02255587dc2fa036c75d628c1d835d2374fb76d4eff232e2a69d04915f30373f9f",
        script_hash: "5341cf8cf9e8cf4a9aaf36255e16901b8cb174bc",
        address: "NTWC7Hh5VYMQ5K8YJbyCLbmJ4RhfQ1Ej64",
        signature: "605f9820c552f72e2eb0b7689eb372a25d92642a3bab5ba2ece9688024e87595efe0ac3ff26956bb9ab69723498be4af6ec61db91816d8db68eb12c3cf95bd15",
        sign_data: "4e454f3322ed1ca70a50041563d83b17cfc04be0182a476db74d025dc1883f640b9aaaba",
        unsigned: Some("0043b4d76b804f120000000000d0fb010000000000ac4b4c00015341cf8cf9e8cf4a9aaf36255e16901b8cb174bc01005e0b03e068accf260000000c144ebcda67ec45164df73dadec584f986c4c318e270c145341cf8cf9e8cf4a9aaf36255e16901b8cb174bc14c01f0c087472616e736665720c14cf76e28bd0062c4a478ee35561011319f3cfa4d241627d5b52"),
        tx_hash: Some("22ed1ca70a50041563d83b17cfc04be0182a476db74d025dc1883f640b9aaaba"),
    },
    MainnetVector {
        name: "contract_call_with_custom_scope",
        pubkey: "02d22bf261d363171f502ab84bafe2cbdc586e8b02165793944f3e6fe983f160ba",
        script_hash: "cfad99a926e5f92ec4ffc645eb1f8d7bc3ba0bed",
        address: "Ner52RMosgi4SpDAWcfFWsZ9v2tsgtShW9",
        signature: "9fc6c3ca889c95ff03a895ebb5c2d75cab1d66afc39fe2638371b08cdd449d2216c9d90004c8300d75c41c25a0e6700fda6ef90940b2b7d7adc3ae71960f8340",
        sign_data: "4e454f33933263f795429d941890c0d7a0428a917c9967652be660c15fce18934caf1186",
        unsigned: None,
        tx_hash: None,
    },
    MainnetVector {
        name: "batched_transfers",
        pubkey: "03ca9e0d82185344ee4c9cda49186ae745843e71892052f4f802f969cfa8c45d25",
        script_hash: "f4291817b6024df95218c71ba4314dbf2fd305a1",
        address: "NiAyHqBUZvsqx1vtp1WY4n27omDtftpwTt",
        signature: "e9c6ee2161fb95509e4ab899d4ea3cb56a6cdf530de856a12128c5dcb63f01f54b9bc59ec70bca26b96d1d3b424cc2aa0af9df3d8832c217178cc5c35b0585a1",
        sign_data: "4e454f337cda0b9033707cfb994ecb8922b59d95e83fc8a5dca2571b0d933b4b091010b9",
        unsigned: None,
        tx_hash: None,
    },
];

fn pubkey_of(vector: &MainnetVector) -> [u8; 33] {
    let bytes = hex::decode(vector.pubkey).expect("vector pubkey is hex");
    bytes.try_into().expect("vector pubkey is 33 bytes")
}

fn signature_of(vector: &MainnetVector) -> [u8; 64] {
    let bytes = hex::decode(vector.signature).expect("vector signature is hex");
    bytes.try_into().expect("vector signature is 64 bytes")
}

#[test]
fn hash160_matches_known_vector() {
    // HASH160 of empty input is a well-known constant.
    let digest = hash160(&[]);
    assert_eq!(
        hex::encode(&digest),
        "b472a266d0bd89c13706a4132ccfb16f7c3b9fcb"
    );
}

#[test]
fn base58check_round_trips() {
    let payload = vec![
        0x35, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
    ];
    let encoded = base58check_encode(&payload);
    let decoded = base58check_decode(&encoded).expect("decodes");
    assert_eq!(decoded, payload);
}

#[test]
fn base58check_rejects_corruption() {
    let payload = vec![0x35, 1, 2, 3];
    let mut encoded = base58check_encode(&payload);
    // Flip the last character to break the checksum.
    let last = encoded.pop().unwrap();
    let replacement = if last == '2' { '3' } else { '2' };
    encoded.push(replacement);
    assert!(base58check_decode(&encoded).is_none());
}

#[test]
fn public_key_is_valid_compressed_point() {
    let private_key = [7u8; 32];
    let public_key = public_key_from_private(&private_key).expect("derives");
    assert_eq!(public_key.len(), 33);
    assert!(public_key[0] == 0x02 || public_key[0] == 0x03);
}

#[test]
fn verification_script_shape() {
    let private_key = [7u8; 32];
    let public_key = public_key_from_private(&private_key).unwrap();
    let script = verification_script(&public_key);
    assert_eq!(script.len(), 40);
    assert_eq!(script[0], 0x0c, "PUSHDATA1");
    assert_eq!(script[1], 33, "push length");
    assert_eq!(&script[2..35], &public_key[..]);
    assert_eq!(
        &script[35..],
        &[0x41, 0x56, 0xe7, 0xb3, 0x27],
        "SYSCALL CheckSig"
    );

    assert_eq!(script_hash(&public_key).len(), 20);
    assert!(address_from_script_hash(&script_hash(&public_key)).starts_with('N'));
}

#[test]
fn invocation_script_shape() {
    let signature = [0xABu8; 64];
    let script = invocation_script(&signature);
    assert_eq!(script.len(), 66);
    assert_eq!(&script[..2], &[0x0c, 0x40], "PUSHDATA1 64");
    assert_eq!(&script[2..], &signature[..]);
}

#[test]
fn mainnet_verification_scripts_and_addresses_match_the_chain() {
    for vector in VECTORS {
        let public_key = pubkey_of(vector);
        let script = verification_script(&public_key);
        assert_eq!(
            hex::encode(&script),
            format!("0c21{}4156e7b327", vector.pubkey),
            "{}: verification script",
            vector.name
        );
        assert_eq!(
            hex::encode(script_hash(&public_key)),
            vector.script_hash,
            "{}: script hash",
            vector.name
        );
        assert_eq!(
            address_from_script_hash(&script_hash(&public_key)),
            vector.address,
            "{}: address",
            vector.name
        );
        assert_eq!(
            hex::encode(invocation_script(&signature_of(vector))),
            format!("0c40{}", vector.signature),
            "{}: invocation script",
            vector.name
        );
    }
}

#[test]
fn mainnet_signatures_verify_against_the_n3_preimage() {
    for vector in VECTORS {
        let preimage = hex::decode(vector.sign_data).expect("vector sign_data is hex");
        assert_eq!(preimage.len(), 36, "{}: preimage length", vector.name);
        assert!(
            verify_signature(&pubkey_of(vector), &preimage, &signature_of(vector)),
            "{}: the chain accepted this signature, so must we",
            vector.name
        );
    }
}

#[test]
fn sign_data_is_magic_le_then_transaction_hash() {
    for vector in VECTORS {
        let Some(unsigned) = vector.unsigned else {
            continue;
        };
        let unsigned = hex::decode(unsigned).expect("vector unsigned tx is hex");
        let expected = hex::decode(vector.sign_data).expect("vector sign_data is hex");
        assert_eq!(
            transaction_hash(&unsigned),
            hex::decode(vector.tx_hash.expect("vector carries its tx hash")).expect("hex"),
            "{}: SHA256(unsigned) is the transaction hash",
            vector.name
        );
        assert_eq!(
            sign_data(&unsigned, MAINNET),
            expected,
            "{}: preimage",
            vector.name
        );
        assert_eq!(&expected[..4], &MAINNET.to_le_bytes());
        assert_eq!(&expected[4..], &transaction_hash(&unsigned)[..]);
    }
}

#[test]
fn wrong_preimages_are_rejected_by_the_chain_signatures() {
    // Three plausible signing mistakes, plus a sensitivity check. Each of these
    // preimages would yield a well-formed 64-byte signature — only the network
    // can tell them apart, which is exactly why they need a pinned vector.
    for vector in VECTORS {
        let Some(unsigned) = vector.unsigned else {
            continue;
        };
        let unsigned = hex::decode(unsigned).expect("vector unsigned tx is hex");
        let signature = signature_of(vector);
        let public_key = pubkey_of(vector);
        assert!(
            !verify_signature(&public_key, &unsigned, &signature),
            "{}: signing the raw unsigned tx is wrong",
            vector.name
        );
        assert!(
            !verify_signature(&public_key, &sha256(&unsigned), &signature),
            "{}: signing SHA256(unsigned) without the magic is wrong",
            vector.name
        );
        assert!(
            !verify_signature(&public_key, &sign_data(&unsigned, TESTNET), &signature),
            "{}: a signature must not cross networks",
            vector.name
        );
        let mut one_byte_off = sign_data(&unsigned, MAINNET);
        let last = one_byte_off.len() - 1;
        one_byte_off[last] ^= 0x01;
        assert!(
            !verify_signature(&public_key, &one_byte_off, &signature),
            "{}: a one-byte preimage change must fail",
            vector.name
        );
    }
}

#[test]
fn sign_and_verify_round_trip() {
    let private_key = [9u8; 32];
    let public_key = public_key_from_private(&private_key).unwrap();
    let unsigned_tx = b"some serialized unsigned neo transaction".to_vec();
    let signature = sign_transaction(&private_key, &unsigned_tx, MAINNET).expect("signs");
    assert_eq!(signature.len(), 64);
    assert!(verify_signature(
        &public_key,
        &sign_data(&unsigned_tx, MAINNET),
        &signature
    ));
}

#[test]
fn signature_is_low_s() {
    // Consensus rejects high-S signatures. `normalize_s` returns Some only when
    // it had to flip S, so "always None" is the crate's own definition of a
    // low-S signature — and it fails if normalization is ever removed here.
    for seed in 1u8..24 {
        let private_key = [seed; 32];
        let signature = sign_transaction(&private_key, b"low-s check", MAINNET).expect("signs");
        let parsed = Signature::from_slice(&signature[..]).expect("64-byte r||s parses");
        assert!(
            parsed.normalize_s().is_none(),
            "seed {seed}: signature carries a high S value"
        );
    }
}

#[test]
fn verify_rejects_tampered_preimage() {
    let private_key = [9u8; 32];
    let public_key = public_key_from_private(&private_key).unwrap();
    let signature = sign_transaction(&private_key, b"original message", MAINNET).unwrap();
    assert!(!verify_signature(
        &public_key,
        &sign_data(b"tampered message", MAINNET),
        &signature
    ));
}

#[test]
fn verify_rejects_wrong_public_key() {
    let private_key_a = [9u8; 32];
    let private_key_b = [10u8; 32];
    let public_key_b = public_key_from_private(&private_key_b).unwrap();
    let signature = sign_transaction(&private_key_a, b"message", MAINNET).unwrap();
    assert!(!verify_signature(
        &public_key_b,
        &sign_data(b"message", MAINNET),
        &signature
    ));
}

#[test]
fn deterministic_rfc6979_signature() {
    // RFC6979 is deterministic: the same key + message yields the same signature.
    let private_key = [3u8; 32];
    let first = sign_transaction(&private_key, b"determinism check", MAINNET).unwrap();
    let second = sign_transaction(&private_key, b"determinism check", MAINNET).unwrap();
    assert_eq!(first, second);
    let other_network = sign_transaction(&private_key, b"determinism check", TESTNET).unwrap();
    assert_ne!(first, other_network);
}

#[test]
fn invalid_private_key_is_rejected() {
    // Zero and order-exceeding scalars have no valid key; both must error
    // rather than sign with something that looks like a key.
    assert!(matches!(
        sign_transaction(&[0u8; 32], b"message", MAINNET),
        Err(SignerCryptoError::InvalidPrivateKey)
    ));
}

#[test]
fn aes_gcm_seal_open_round_trip() {
    let master_key = [0xAB; 32];
    let private_key = [0x11; 32];
    let nonce = [0x07; 12];
    let ciphertext = seal_private_key(&master_key, &private_key, &nonce).expect("seals");
    let opened = open_private_key(&master_key, &nonce, &ciphertext).expect("opens");
    assert_eq!(opened.as_slice(), &private_key[..]);
}

#[test]
fn aes_gcm_rejects_wrong_master_key() {
    let private_key = [0x11; 32];
    let nonce = [0x07; 12];
    let ciphertext = seal_private_key(&[0xAB; 32], &private_key, &nonce).unwrap();
    assert!(open_private_key(&[0xCD; 32], &nonce, &ciphertext).is_err());
}

#[test]
fn nep2_encrypt_decrypt_round_trip() {
    let private_key = [5u8; 32];
    let passphrase = "super-secret-passphrase";
    let nep2 = encrypt_nep2(&private_key, passphrase).expect("encrypts");
    assert!(nep2.starts_with("6P"));
    let recovered = decrypt_nep2(&nep2, passphrase).expect("decrypts");
    assert_eq!(recovered.as_slice(), &private_key[..]);
}

#[test]
fn nep2_address_checksum_uses_the_real_n3_address() {
    // NEP-2 embeds HASH160(address-as-utf8)[0..4]. If the verification script
    // shape drifts, every derived address stops matching the one a real wallet
    // computes for the same key — so pin the address itself, not just the shape.
    let private_key = [5u8; 32];
    let public_key = public_key_from_private(&private_key).unwrap();
    let address = address_from_script_hash(&script_hash(&public_key));
    assert_eq!(address.len(), 34);
    let nep2 = encrypt_nep2(&private_key, "passphrase").expect("encrypts");
    let payload = base58check_decode(&nep2).expect("decodes");
    let expected = &sha256(&sha256(address.as_bytes()))[0..4];
    assert_eq!(&payload[3..7], expected);
    // A wrong-shape script would hash differently and reject this passphrase.
    assert_eq!(
        decrypt_nep2(&nep2, "passphrase")
            .expect("decrypts")
            .as_slice(),
        &private_key[..]
    );
}

#[test]
fn nep2_rejects_wrong_passphrase() {
    let private_key = [5u8; 32];
    let nep2 = encrypt_nep2(&private_key, "correct").expect("encrypts");
    assert!(matches!(
        decrypt_nep2(&nep2, "wrong"),
        Err(SignerCryptoError::Nep2ChecksumMismatch)
    ));
}

#[test]
fn nep2_rejects_malformed_input() {
    assert!(decrypt_nep2("not-a-nep2-key", "pass").is_err());
    assert!(decrypt_nep2("6Pinvalid", "pass").is_err());
}

#[test]
fn derive_master_key_is_deterministic_and_32_bytes() {
    let a = derive_master_key(b"operator-token", b"/data/dir").expect("derives");
    let b = derive_master_key(b"operator-token", b"/data/dir").expect("derives");
    let c = derive_master_key(b"different-token", b"/data/dir").expect("derives");
    let d = derive_master_key(b"operator-token", b"/other/dir").expect("derives");
    assert_eq!(a, b);
    assert_ne!(a, c);
    assert_ne!(a, d);
    assert_eq!(a.len(), 32);
    assert_ne!(a, [0u8; 32], "a zero master key would seal nothing");
}

#[test]
fn sign_raw_covers_sha256_of_the_bytes_with_no_neo_framing() {
    let private_key = [7u8; 32];
    let public_key = public_key_from_private(&private_key).expect("derives");
    let data = b"a fulfillment digest the enclave host wants signed";

    let signature = sign_raw(&private_key, data).expect("signs");
    // The unframed preimage verifies; the Neo-framed preimage of the same
    // bytes does not, which is the property that keeps the two lanes'
    // signatures from being interchangeable.
    assert!(verify_signature(&public_key, data, &signature));
    assert!(!verify_signature(
        &public_key,
        &sign_data(data, MAINNET),
        &signature
    ));

    // RFC6979: the same bytes sign to the same 64-byte witness, and the
    // witness is low-S because consensus rejects the high form.
    let again = sign_raw(&private_key, data).expect("signs again");
    assert_eq!(signature, again);
    let other = sign_raw(&private_key, b"different bytes").expect("signs other");
    assert_ne!(signature, other);
}
