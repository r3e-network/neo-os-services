//! Integration tests for nitro_attest::cms — a port of the Go tool's
//! cms_test.go (deploy/nitro/nsm-attest/cms_test.go), plus AES-256-GCM and
//! segmented-encryptedContent coverage.
//!
//! RSA keys are fixed PKCS#8 constants instead of per-run keygen: debug-mode
//! RSA-2048 keygen costs seconds per key and these tests create two.

use aes::cipher::{generic_array::GenericArray, BlockEncrypt, KeyInit};
use aes_gcm::aead::Aead;
use aes_gcm::Aes256Gcm;
use nitro_attest::asn1::{
    oid_aes256_cbc, oid_aes256_gcm, oid_data, oid_enveloped_data, oid_rsaes_oaep,
};
use nitro_attest::cms::{decrypt_cms_enveloped_data, pkcs7_unpad};
use rsa::pkcs8::DecodePrivateKey;
use rsa::{Oaep, RsaPrivateKey, RsaPublicKey};
use sha2::Sha256;

const MAIN_KEY_HEX: &str = "308204be020100300d06092a864886f70d0101010500048204a8308204a402010002820101009513e1e91821cfc5f1a4d9980ab57151ef72bcd62948768470a46efbe451738ce3c9a3ed7c54bfb30c7da2509867857ced5d66d2b056c8e90d35011309dc03b65ef9ca5e0138bb3807c5cff353b0f0ac535e75e2985479017cd9f42967022752fd8a8929364b7afbd3e106570be47ee5f1f8aa484171fff3907e57cd25dba739918b2c662093d135900dfe6a9c348813215404bc46eb3a7ee7a8dc2b461c1817c866af0847b798e3982044fa99a30e359525f5711c45a99a736bed713fd39fd04482cf1f4d2e7f0690e841fb8199e87ad817d8b9745ac4d8c196735e6a0d7fcd49f0e6a09e66e2626edc34b4f9afa3e69b4b75a5e3d2322c44944d0a8565793f020301000102820100390a66823dcd92267713507eb07a4465c96ce97c384795b18f381b8f1e095c6128375b15df60be08d05ab1e48cabef93a16eff8cd6141ec3ad5dfe8f3e5284c91f060cbc735335af76a9e5ab80f64ee060f5dfbd57f3da690b5089efdd8e2165cbc55a3dfe9c5aee485fed8118f7d0e642f3969417167b8cc258d5579588ba2ee3209acec9b1013e63cc63dfa7669661e2cc4744b51d64428a532bc9d80bdff12ddfb1573aba79084a74f17fc0017567d38fe3a53f6d621321570c2f964c57393c2a4ea3ecfd1b7d73a24f98096b78026d6889d94dcd891f60e6f967080d9649fdbb7f6d309d3f4ffb72f87888f1d822decf5a20db576f07f24bd2e63db5e72102818100cdf76bca028d74fda698debd44e86c3f84522f1072c7f9222768fedcf234ea8e5e4312f830c1eacac7338e96b026d25b0cdedb6bd8706303619c6b03de754475290207af6ffcd9c6701653433e91db7c30292d0771bd1b445dad93dd5eb995757ac1e5e0754d41db5acc6968a6202ee48ce39576e4886a74221ef8225470faf502818100b94aad61e15849af631443b1a2dc9158ee2ab0b46678d54fb2acaba3a2b2de04c2ddd443953f6427e3c739c08da2130131aaf4128bccc43c9fc64e4b3759667278c6dd968a1518aad75bd7d3e5b9ffb4282adecd93f668e2e59f04af60ca7a945e61381df5c90f0455a79f67971e9361f31acf123bd845e88d68e7c5c2a7eae30281810089ec3b64051d90d022759002925849d4a6d919e71bd5c981137efddc1add508c9196bce7324f48d90d57fb0df15badd586e2dd7074799df42fb33cfe544396da15e1e41f99106b0cb5165e1f5390fcb746d0ebf46637ca4097b29aa7ccbcddd6d3a3703a4492bd9d144a79f3b7fb292ba724e77bbc419577bb399dd3ef53d0d902818100b00b2d74039fd85254765a629973aa7cadbbcdab787871628945d8c55dbd47878a852c3911c1eaaca3931361c8af26134a573c11aad55fd4a190cdae54e61199ccfa5469c4c38a6e36b2c1fa471752c49e2d2d0670fffa6328face7eba1d661d35167534b1e2d6ebad5dd6eb9afea7d4b61ed082686d70ee23fc79c8c0cabd3502818023ea65966872d28d0c5c90da0d59312bd51c1d0ea62dfb31ee9778e58142c1607c4c9ea0ecc41a643fffd938a9d7203eb65ad04f1f6eeaa28bcfbdac0a5c492c9353f4edcc2814c111044bc6c71e13ecb30a09ff174d09e07b528147e570beed99d7dc12b36f6c0b2c8f4a17ed49bb5817a83b85fc2df4786b3ecc0f7688bd43";

const WRONG_KEY_HEX: &str = "308204be020100300d06092a864886f70d0101010500048204a8308204a40201000282010100df9644f2a46baac82141285f03cb77bb8d93a7974edb8a8388d5dac798e9ba9f6f5caba05dd666d6e43bdfb421d571170726bd7388b31d7f99850d360453ad122427b6e053d7ce46e53831e130f3280135ce30e64cfafc8ebee9b1afb18bbf6876abfb775bd18d6c5d7e46567373c09de78d226abbe751c8ac5ebbc9379d214e03fdc23784fcc0ac63914588914c57fb477d667b4739913ac5031f1752022821602230421c6d907390ec857ed6a31d104ec0d9e1556f6e5d324ce060c0554fe57a5bf95438f635116b915467da7b039a1df6906ff0aa63447b53a5581d2f2771d86fbe86af8d762248bb238575279d41502cd9db35b9e553c4a4690f0150e853020301000102820100063e9079ba5a80c58ac58d6c173e0a7faeca3891ad93ccc0345a77516b158959c49171004f3e9aac011479ab47e549d2f127302956e05c6ae0e314bb0a79e51e8440a65c88daebc43d1df4540165a3c60ce0fa554eec6a3b4e5d0127bd57557c2f119f39f67d84169fb1d423114c62a271021710fb63257c96467b0b7945d12a95968a4d0c9e09801010d92551b892f203f14c2453d3560ce1f54b4c5226352a01249386fe47859a65167c1994945d802a5a3d31c6f9b43e0de16d057d8839c12be2a059d33ae5356fdebb4398d6c7c6d27954bc94cb1cff15edf482503584dde0eecefff4fb7c23ba8a11bcdb96d4fb12cbdfde10750efdbfa447748b40103102818100f6d29fcc3b28a3379444ae51ec770af07f0f2a700eeab0a301c87a6f0e03892bc890ff4ce6101a9902309b6328ac3e9127d52909c55c6b413dd6ff9bc3c69cc4281953648359575f8b19eb2068d0e6de0c719a39ed3758b2ce32ec41957b721500509101649c08ee4906fa2a485a4bb7e7915f709b53eafef8bd7508f16e8b3902818100e7e679e46c510b7e31deb8627ca902a505f9637dde0c815c51964ff3eaafc94f1018ac6d02bab865054f5a514af285a797f7ec2482f3ee7d549edf4a0f927b8c526db193453f302b38e263af656595dded69a8991a91e33d3541f3183386cd158a7e638a9c30890d94b040d12cf04c5ffe394b0eaa8f15069dd604161830f3eb02818079718cfaba28f6960437fee58449d6721ab26599195dd467801b1a52c63c6b23c5ddc2201e1ad25b72be63d6584ed7c2282d33b2010fc61e25c541a36ca2aec3bd4f28bf0df9c989d3317f8544cd74aad0c89cafdfce19b070d0917a7b886fcb718a32aed2c80b84e31db1bd58384585494538067a06c25b8e1bfa17da631fd102818100a30b9adc0d8415ee8e25a7c2271fb56a4d7f0082b8a25639906b7c9f647c5fafa5039407b9098b280bc9b518bef7311d9a6d87ac4c1e31aa10dafae7597786422c9a4f65da24093bfa6cc1e5ca06d88e06a46913ec68723ad0bd23abfa5e66c7246ea4920a2addd19c9f27936a63316fb49097c3220c239e594ee5e49af1a02d02818100c9dec345cfe11ecfda496da701ede023d53dadd5b7cd55f00245189e623b1b38cf1db2725d93edea463f55927831ea63d8515508cb8658ea5c5df90a95efeacb802e572fdf7110bcd6dc03f7a571576a1581eefd15dfd9a875850db83ed32949db330c2286dbd63aae71aefe98e1f76efd4fcb90dc2e0fecc90b0cf2dd40fc5e";

const CEK: [u8; 32] = [
    0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff,
    0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef, 0xfe, 0xdc, 0xba, 0x98, 0x76, 0x54, 0x32, 0x10,
];
const IV: [u8; 16] = [
    0x0f, 0x1e, 0x2d, 0x3c, 0x4b, 0x5a, 0x69, 0x78, 0x87, 0x96, 0xa5, 0xb4, 0xc3, 0xd2, 0xe1, 0xf0,
];
const GCM_NONCE: [u8; 12] = [
    0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xab,
];

fn main_key() -> RsaPrivateKey {
    RsaPrivateKey::from_pkcs8_der(&hex::decode(MAIN_KEY_HEX).unwrap()).unwrap()
}

fn wrong_key() -> RsaPrivateKey {
    RsaPrivateKey::from_pkcs8_der(&hex::decode(WRONG_KEY_HEX).unwrap()).unwrap()
}

// --- minimal DER encoding helpers ---

fn tlv(tag: u8, content: &[u8]) -> Vec<u8> {
    let mut out = vec![tag];
    let len = content.len();
    if len < 0x80 {
        out.push(len as u8);
    } else {
        let be = (len as u64).to_be_bytes();
        let significant = &be[be.iter().position(|&b| b != 0).unwrap_or(be.len() - 1)..];
        out.push(0x80 | significant.len() as u8);
        out.extend_from_slice(significant);
    }
    out.extend_from_slice(content);
    out
}

fn concat_into(tag: u8, parts: &[&[u8]]) -> Vec<u8> {
    let mut body = Vec::new();
    for part in parts {
        body.extend_from_slice(part);
    }
    tlv(tag, &body)
}

fn seq(parts: &[&[u8]]) -> Vec<u8> {
    concat_into(0x30, parts)
}

fn set(parts: &[&[u8]]) -> Vec<u8> {
    concat_into(0x31, parts)
}

fn octet(content: &[u8]) -> Vec<u8> {
    tlv(0x04, content)
}

fn integer(value: u8) -> Vec<u8> {
    tlv(0x02, &[value])
}

fn oid(content: &[u8]) -> Vec<u8> {
    tlv(0x06, content)
}

// --- CMS builders mirroring buildKMSLikeEnvelopedData in cms_test.go ---

fn aes256_cbc_encrypt(cek: &[u8], iv: &[u8], plaintext: &[u8]) -> Vec<u8> {
    assert_eq!(plaintext.len() % 16, 0);
    let block = aes::Aes256::new_from_slice(cek).unwrap();
    let mut out = Vec::with_capacity(plaintext.len());
    let mut prev = [0u8; 16];
    prev.copy_from_slice(iv);
    for chunk in plaintext.as_chunks::<16>().0 {
        let mut buf = GenericArray::clone_from_slice(chunk);
        for (b, p) in buf.iter_mut().zip(prev.iter()) {
            *b ^= p;
        }
        block.encrypt_block(&mut buf);
        out.extend_from_slice(&buf);
        prev.copy_from_slice(&buf);
    }
    out
}

fn pkcs7_pad(data: &[u8], block_size: usize) -> Vec<u8> {
    let pad = block_size - (data.len() % block_size);
    let mut out = data.to_vec();
    out.extend(std::iter::repeat_n(pad as u8, pad));
    out
}

/// Builds a CMS EnvelopedData with the same structure AWS KMS produces for a
/// Nitro Recipient: one KeyTransRecipientInfo RSAES-OAEP-SHA256-wrapping the
/// CEK, AES-256-CBC encryptedContent with the IV in the algorithm parameters,
/// PKCS#7-padded plaintext. `segmented` emits the encryptedContent as a
/// CONSTRUCTED [0] wrapping OCTET STRING segments (the BER shape KMS uses for
/// larger payloads) instead of a PRIMITIVE [0].
fn build_kms_like_enveloped_data(
    pub_key: &RsaPublicKey,
    cek: &[u8],
    iv: &[u8],
    plaintext: &[u8],
    wrap: bool,
    segmented: bool,
) -> Vec<u8> {
    let enc_key = pub_key
        .encrypt(&mut rsa::rand_core::OsRng, Oaep::new::<Sha256>(), cek)
        .unwrap();
    let padded = pkcs7_pad(plaintext, 16);
    let ct = aes256_cbc_encrypt(cek, iv, &padded);

    let ktri = seq(&[
        &integer(0),
        // A minimal issuerAndSerialNumber-style rid; the decrypter ignores it.
        &tlv(0x02, &[1]),
        &seq(&[&oid(oid_rsaes_oaep())]),
        &octet(&enc_key),
    ]);
    let recipient_infos = set(&[&ktri]);

    let encrypted_content = if segmented {
        let mid = ct.len() / 2;
        let mut body = octet(&ct[..mid]);
        body.extend(octet(&ct[mid..]));
        tlv(0xA0, &body)
    } else {
        // encryptedContent ::= [0] IMPLICIT OCTET STRING (primitive).
        tlv(0x80, &ct)
    };

    let eci = seq(&[
        &oid(oid_data()),
        &seq(&[&oid(oid_aes256_cbc()), &octet(iv)]),
        &encrypted_content,
    ]);
    let env = seq(&[&integer(0), &recipient_infos, &eci]);

    if !wrap {
        return env;
    }
    // ContentInfo ::= SEQUENCE { contentType OID, content [0] EXPLICIT }.
    seq(&[&oid(oid_enveloped_data()), &tlv(0xA0, &env)])
}

/// AES-256-GCM variant of the KMS structure (forward-compat path): the
/// content-encryption algorithm is AES-256-GCM with a 12-byte nonce, either
/// as a GCMParameters SEQUENCE or as a bare OCTET STRING; the auth tag is
/// appended to the ciphertext.
fn build_gcm_enveloped_data(
    pub_key: &RsaPublicKey,
    cek: &[u8],
    nonce: &[u8],
    plaintext: &[u8],
    sequence_params: bool,
) -> Vec<u8> {
    let enc_key = pub_key
        .encrypt(&mut rsa::rand_core::OsRng, Oaep::new::<Sha256>(), cek)
        .unwrap();
    let gcm = Aes256Gcm::new_from_slice(cek).unwrap();
    let ct = gcm
        .encrypt(aes_gcm::Nonce::from_slice(nonce), plaintext)
        .unwrap();

    let params = if sequence_params {
        // GCMParameters ::= SEQUENCE { aes-nonce OCTET STRING, aes-ICVlen INTEGER }
        seq(&[&octet(nonce), &integer(12)])
    } else {
        octet(nonce)
    };
    let ktri = seq(&[
        &integer(0),
        &tlv(0x02, &[1]),
        &seq(&[&oid(oid_rsaes_oaep())]),
        &octet(&enc_key),
    ]);
    let eci = seq(&[
        &oid(oid_data()),
        &seq(&[&oid(oid_aes256_gcm()), &params]),
        &tlv(0x80, &ct),
    ]);
    seq(&[&integer(0), &set(&[&ktri]), &eci])
}

#[test]
fn round_trip() {
    let priv_key = main_key();
    let pub_key = priv_key.to_public_key();

    let cases: Vec<(&str, Vec<u8>)> = vec![
        ("short", b"hello nitro".to_vec()),
        ("empty", vec![]),
        ("exact-block", vec![b'A'; 16]), // forces a full extra pad block
        ("multi-block", vec![b'Z'; 55]), // 55 bytes
        ("binary-key-material", (0u8..32).collect()),
    ];

    for (name, plaintext) in &cases {
        for wrap in [true, false] {
            let der = build_kms_like_enveloped_data(&pub_key, &CEK, &IV, plaintext, wrap, false);
            let got = decrypt_cms_enveloped_data(&der, &priv_key)
                .unwrap_or_else(|err| panic!("wrapped={wrap} {name}: decrypt failed: {err}"));
            assert_eq!(got, *plaintext, "wrapped={wrap} {name}: plaintext mismatch");
        }
    }
}

#[test]
fn round_trip_segmented_encrypted_content() {
    let priv_key = main_key();
    let pub_key = priv_key.to_public_key();
    for (name, plaintext) in [
        ("short", b"hello nitro".to_vec()),
        ("multi-block", vec![b'Z'; 55]),
    ] {
        let der = build_kms_like_enveloped_data(&pub_key, &CEK, &IV, &plaintext, false, true);
        let got = decrypt_cms_enveloped_data(&der, &priv_key)
            .unwrap_or_else(|err| panic!("{name}: decrypt failed: {err}"));
        assert_eq!(got, plaintext, "{name}: plaintext mismatch");
    }
}

#[test]
fn round_trip_aes256_gcm() {
    let priv_key = main_key();
    let pub_key = priv_key.to_public_key();
    for name in ["gcm-params", "bare-octet-params"] {
        let der = build_gcm_enveloped_data(
            &pub_key,
            &CEK,
            &GCM_NONCE,
            b"forward compatibility",
            name == "gcm-params",
        );
        let got = decrypt_cms_enveloped_data(&der, &priv_key)
            .unwrap_or_else(|err| panic!("{name}: decrypt failed: {err}"));
        assert_eq!(got, b"forward compatibility", "{name}: plaintext mismatch");
    }
}

#[test]
fn wrong_key_is_rejected() {
    let priv_key = main_key();
    let pub_key = priv_key.to_public_key();
    let der = build_kms_like_enveloped_data(&pub_key, &CEK, &IV, b"secret", true, false);
    let result = decrypt_cms_enveloped_data(&der, &wrong_key());
    assert!(
        result.is_err(),
        "expected error decrypting with the wrong RSA key"
    );
    let err = result.unwrap_err();
    assert!(
        err.starts_with("cms: RSA-OAEP unwrap CEK:"),
        "unexpected error: {err}"
    );
}

#[test]
fn rejects_bad_input() {
    let priv_key = main_key();
    assert!(
        decrypt_cms_enveloped_data(&[], &priv_key).is_err(),
        "empty input"
    );
    assert!(
        decrypt_cms_enveloped_data(&[0x01, 0x02], &priv_key).is_err(),
        "garbage input"
    );
}

#[test]
fn pkcs7_unpad_cases() {
    let bs = 16;

    // 16 bytes of value 0x10 is a valid full padding block.
    let full_pad_block = vec![bs as u8; bs];
    let valid_full_block = pkcs7_unpad(&full_pad_block, bs).unwrap();
    assert!(valid_full_block.is_empty(), "expected empty output");

    let mut one_byte_padded = vec![0xAA; bs - 1];
    one_byte_padded.push(0x01);
    let one_byte_pad = pkcs7_unpad(&one_byte_padded, bs).unwrap();
    assert_eq!(one_byte_pad, &[0xAA; 15]);

    for n in 0..=bs * 2 {
        let data = vec![0x5A; n];
        let padded = pkcs7_pad(&data, bs);
        assert_eq!(
            padded.len() % bs,
            0,
            "pad produced non-block length for n={n}"
        );
        let out = pkcs7_unpad(&padded, bs).unwrap_or_else(|err| panic!("unpad n={n}: {err}"));
        assert_eq!(out, data, "roundtrip mismatch n={n}");
    }

    // Last byte says 0x03 but the preceding pad bytes don't all equal 0x03.
    let mut inconsistent = vec![0x00u8; bs];
    inconsistent[bs - 1] = 0x03;
    inconsistent[bs - 2] = 0x03;
    inconsistent[bs - 3] = 0x02;
    assert!(pkcs7_unpad(&inconsistent, bs).is_err());

    let mut pad_too_large = vec![0x00u8; bs - 1];
    pad_too_large.push(17);
    assert!(pkcs7_unpad(&pad_too_large, bs).is_err());

    let mut pad_zero = vec![0x00u8; bs - 1];
    pad_zero.push(0x00);
    assert!(pkcs7_unpad(&pad_zero, bs).is_err());

    assert!(
        pkcs7_unpad(&[0x01, 0x02, 0x03], bs).is_err(),
        "non-block length"
    );
    assert!(pkcs7_unpad(&[], bs).is_err(), "empty input");
}
