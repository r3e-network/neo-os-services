//! Ephemeral enclave key for attested custody sessions, never a vault signing key.

use rsa::{
    pkcs8::EncodePublicKey,
    rand_core::{CryptoRngCore, OsRng},
    traits::PublicKeyParts,
    Oaep, Pss, RsaPrivateKey,
};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::AttestResult;

const PROOF_DOMAIN: &[u8] = b"neoos/custody-state-request-proof/v1\0";
/// RSASSA-PSS salt length, equal to the SHA-256 digest length; the coordinator
/// verifies with `RSA_PSS_SALTLEN_DIGEST`.
const PROOF_SALT_LEN: usize = 32;

/// No private export, import, serialization, or clone surface. The RSA type
/// zeroizes its private components on drop; session plaintext is zeroized too.
/// Both private-key operations are blinded: token opening and request-proof
/// signing.
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
        self.sign_request_proof_with_rng(&mut OsRng, canonical)
    }

    fn sign_request_proof_with_rng<R: CryptoRngCore>(
        &self,
        rng: &mut R,
        canonical: &[u8],
    ) -> AttestResult<Vec<u8>> {
        if !canonical.starts_with(PROOF_DOMAIN) || canonical.len() > 8192 {
            return Err("invalid custody request-proof domain or size".to_string());
        }
        // rsa 0.9 blinds a PSS signature only when the padding asks for it: with
        // `Pss::new_with_salt` the RNG draws the salt and nothing else, and the
        // private exponentiation runs on the encoded message, a value anyone
        // holding the signature recomputes as s^e mod n (RUSTSEC-2023-0071).
        // Blinding exponentiates a random multiple of it instead. The signature
        // itself is unchanged: standard RSASSA-PSS-SHA256 with a 32-byte salt.
        self.0
            .sign_with_rng(
                rng,
                Pss::new_blinded_with_salt::<Sha256>(PROOF_SALT_LEN),
                &Sha256::digest(canonical),
            )
            .map_err(|_| "failed to sign custody request proof".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rsa::rand_core::{CryptoRng, Error, RngCore};
    use rsa::RsaPublicKey;

    /// Hands out `OsRng` bytes and counts them, so a test can tell whether a
    /// private-key operation drew a blinding factor or only the PSS salt.
    struct CountingRng {
        drawn: usize,
    }

    impl RngCore for CountingRng {
        fn next_u32(&mut self) -> u32 {
            self.drawn += 4;
            OsRng.next_u32()
        }

        fn next_u64(&mut self) -> u64 {
            self.drawn += 8;
            OsRng.next_u64()
        }

        fn fill_bytes(&mut self, dest: &mut [u8]) {
            self.drawn += dest.len();
            OsRng.fill_bytes(dest);
        }

        fn try_fill_bytes(&mut self, dest: &mut [u8]) -> Result<(), Error> {
            self.drawn += dest.len();
            OsRng.try_fill_bytes(dest)
        }
    }

    impl CryptoRng for CountingRng {}

    #[test]
    fn request_proof_signature_is_blinded_and_standard_pss() {
        let key = SessionTransportKey::generate().unwrap();
        let canonical = b"neoos/custody-state-request-proof/v1\0unit-test-canonical-input";
        let mut rng = CountingRng { drawn: 0 };
        let signature = key
            .sign_request_proof_with_rng(&mut rng, canonical)
            .unwrap();

        // PSS draws exactly the salt. An unblinded signature stops there; a
        // blinded one also draws the blinding factor r < n (for RSA-3072, at
        // least another 384 bytes).
        assert!(
            rng.drawn > PROOF_SALT_LEN,
            "request-proof signing drew {} random bytes, only the PSS salt: \
             the private-key exponentiation was not blinded",
            rng.drawn
        );

        // Blinding changes how the signature is computed, not what it is: a
        // standard RSASSA-PSS-SHA256 signature with a 32-byte salt.
        RsaPublicKey::from(&key.0)
            .verify(
                Pss::new_with_salt::<Sha256>(PROOF_SALT_LEN),
                &Sha256::digest(canonical),
                &signature,
            )
            .unwrap();
    }
}
