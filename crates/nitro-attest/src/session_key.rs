//! Ephemeral enclave key for attested custody sessions, never a vault signing key.

use rsa::{
    pkcs8::EncodePublicKey, rand_core::OsRng, traits::PublicKeyParts, Oaep, Pss, RsaPrivateKey,
};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::AttestResult;

const PROOF_DOMAIN: &[u8] = b"neoos/custody-state-request-proof/v1\0";

/// No private export, import, serialization, or clone surface. The RSA type
/// zeroizes its private components on drop; session plaintext is zeroized too.
pub struct SessionTransportKey(RsaPrivateKey);

impl SessionTransportKey {
    pub fn generate() -> AttestResult<Self> {
        let key = RsaPrivateKey::new(&mut OsRng, 3072)
            .map_err(|_| "failed to generate RSA-3072 session key".to_string())?;
        if key.n().bits() != 3072 {
            return Err("session key must be exactly RSA-3072".to_string());
        }
        Ok(Self(key))
    }

    pub fn public_key_der(&self) -> AttestResult<Vec<u8>> {
        self.0
            .to_public_key()
            .to_public_key_der()
            .map(|document| document.as_bytes().to_vec())
            .map_err(|_| "failed to encode session public key".to_string())
    }

    pub fn open_session_token(&self, ciphertext: &[u8]) -> AttestResult<Zeroizing<Vec<u8>>> {
        if ciphertext.len() != 384 {
            return Err("invalid sealed session token".to_string());
        }
        self.0
            .decrypt_blinded(&mut OsRng, Oaep::new::<Sha256>(), ciphertext)
            .map(Zeroizing::new)
            .map_err(|_| "invalid sealed session token".to_string())
    }

    pub fn sign_request_proof(&self, canonical: &[u8]) -> AttestResult<Vec<u8>> {
        if !canonical.starts_with(PROOF_DOMAIN) || canonical.len() > 8192 {
            return Err("invalid custody request-proof domain or size".to_string());
        }
        self.0
            .sign_with_rng(
                &mut OsRng,
                Pss::new_with_salt::<Sha256>(32),
                &Sha256::digest(canonical),
            )
            .map_err(|_| "failed to sign custody request proof".to_string())
    }
}
