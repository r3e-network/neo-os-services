use nitro_attest::session_key::SessionTransportKey;
use rsa::{
    pkcs8::DecodePublicKey, rand_core::OsRng, traits::PublicKeyParts, Oaep, Pss, RsaPublicKey,
};
use sha2::{Digest, Sha256};

#[test]
fn attested_session_key_is_exact_domain_separated_and_rejects_invalid_ciphertexts() {
    let key = SessionTransportKey::generate().unwrap();
    let public = RsaPublicKey::from_public_key_der(&key.public_key_der().unwrap()).unwrap();
    assert_eq!(public.n().bits(), 3072);
    assert_eq!(public.e().to_string(), "65537");
    let token = b"session-token";
    let encrypted = public
        .encrypt(&mut OsRng, Oaep::new::<Sha256>(), token)
        .unwrap();
    assert_eq!(
        key.open_session_token(&encrypted).unwrap().as_slice(),
        token
    );
    assert!(key.open_session_token(&encrypted[..383]).is_err());
    let mut corrupted = encrypted.clone();
    corrupted[0] ^= 1;
    assert!(key.open_session_token(&corrupted).is_err());
    let wrong_scheme = public
        .encrypt(&mut OsRng, rsa::Pkcs1v15Encrypt, token)
        .unwrap();
    assert!(key.open_session_token(&wrong_scheme).is_err());
    let proof = b"neoos/custody-state-request-proof/v1\0test-only-canonical-input";
    let signature = key.sign_request_proof(proof).unwrap();
    public
        .verify(
            Pss::new_with_salt::<Sha256>(32),
            &Sha256::digest(proof),
            &signature,
        )
        .unwrap();
    assert!(public
        .verify(
            Pss::new_with_salt::<Sha256>(0),
            &Sha256::digest(proof),
            &signature
        )
        .is_err());
    assert!(key.sign_request_proof(b"transaction-to-sign").is_err());
    let mut oversize = proof.to_vec();
    oversize.resize(8193, 0);
    assert!(key.sign_request_proof(&oversize).is_err());
}
