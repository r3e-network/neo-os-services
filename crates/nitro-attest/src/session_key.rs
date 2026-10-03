//! Ephemeral enclave key for attested custody sessions, never a vault signing key.

use zeroize::Zeroizing;

use crate::{rsa_provider::PrivateKey, AttestResult};

const PROOF_DOMAIN: &[u8] = b"neoos/custody-state-request-proof/v1\0";

/// No private export, import, serialization, or clone surface. The RSA type
/// zeroizes its private components on drop; session plaintext is zeroized too.
pub struct SessionTransportKey(PrivateKey);

impl SessionTransportKey {
    pub fn generate() -> AttestResult<Self> {
        Ok(Self(PrivateKey::generate(3072)?))
    }

    pub fn public_key_der(&self) -> AttestResult<Vec<u8>> {
        self.0.public_key_der()
    }

    pub fn open_session_token(&self, ciphertext: &[u8]) -> AttestResult<Zeroizing<Vec<u8>>> {
        if ciphertext.len() != 384 {
            return Err("invalid sealed session token".to_string());
        }
        self.0.decrypt_oaep_sha256(ciphertext)
    }

    pub fn sign_request_proof(&self, canonical: &[u8]) -> AttestResult<Vec<u8>> {
        if !canonical.starts_with(PROOF_DOMAIN) || canonical.len() > 8192 {
            return Err("invalid custody request-proof domain or size".to_string());
        }
        self.0
            .sign_pss_sha256_digest(canonical)
            .map_err(|_| "failed to sign custody request proof".to_string())
    }
}
