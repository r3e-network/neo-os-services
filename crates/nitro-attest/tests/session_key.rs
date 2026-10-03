use aws_lc_rs::{
    digest::{digest, SHA256},
    rsa::{
        OaepPublicEncryptingKey, Pkcs1PublicEncryptingKey, PublicEncryptingKey,
        OAEP_SHA256_MGF1SHA256,
    },
    signature::{ParsedPublicKey, RSA_PKCS1_2048_8192_SHA256, RSA_PSS_2048_8192_SHA256},
};
use nitro_attest::session_key::SessionTransportKey;

#[test]
fn attested_session_key_is_exact_domain_separated_and_rejects_invalid_ciphertexts() {
    let key = SessionTransportKey::generate().unwrap();
    let public = PublicEncryptingKey::from_der(&key.public_key_der().unwrap()).unwrap();
    assert_eq!(public.key_size_bits(), 3072);
    let token = b"session-token";
    let oaep = OaepPublicEncryptingKey::new(public.clone()).unwrap();
    let mut encrypted = vec![0u8; oaep.ciphertext_size()];
    let encrypted = oaep
        .encrypt(&OAEP_SHA256_MGF1SHA256, token, &mut encrypted, None)
        .unwrap()
        .to_vec();
    assert_eq!(
        key.open_session_token(&encrypted).unwrap().as_slice(),
        token
    );
    assert!(key.open_session_token(&encrypted[..383]).is_err());
    let mut corrupted = encrypted.clone();
    corrupted[0] ^= 1;
    assert!(key.open_session_token(&corrupted).is_err());
    let pkcs1 = Pkcs1PublicEncryptingKey::new(public).unwrap();
    let mut wrong_scheme = vec![0u8; pkcs1.ciphertext_size()];
    let wrong_scheme = pkcs1.encrypt(token, &mut wrong_scheme).unwrap();
    assert!(key.open_session_token(wrong_scheme).is_err());
    let proof = b"neoos/custody-state-request-proof/v1\0test-only-canonical-input";
    let signature = key.sign_request_proof(proof).unwrap();
    let public_der = key.public_key_der().unwrap();
    let public = ParsedPublicKey::new(&RSA_PSS_2048_8192_SHA256, public_der).unwrap();
    public
        .verify_digest_sig(&digest(&SHA256, proof), &signature)
        .unwrap();
    let wrong_algorithm =
        ParsedPublicKey::new(&RSA_PKCS1_2048_8192_SHA256, key.public_key_der().unwrap()).unwrap();
    assert!(wrong_algorithm.verify_sig(proof, &signature).is_err());
    assert!(key.sign_request_proof(b"transaction-to-sign").is_err());
    let mut oversize = proof.to_vec();
    oversize.resize(8193, 0);
    assert!(key.sign_request_proof(&oversize).is_err());
}
