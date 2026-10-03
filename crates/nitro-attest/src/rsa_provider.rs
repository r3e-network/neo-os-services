//! RSA operations backed by AWS-LC.
//!
//! This module is the single RSA boundary for the attestation crate. Keeping
//! key generation, OAEP, and PSS here prevents callers from selecting a
//! padding or provider independently.

use aws_lc_rs::{
    digest::{digest, SHA256},
    encoding::AsDer,
    rsa::{
        KeyPair, KeySize, OaepPrivateDecryptingKey, PrivateDecryptingKey, OAEP_SHA256_MGF1SHA256,
    },
    signature::{KeyPair as _, RSA_PSS_SHA256},
};
use zeroize::Zeroizing;

use crate::AttestResult;

pub struct PrivateKey {
    signing: KeyPair,
    decrypting: OaepPrivateDecryptingKey,
}

impl PrivateKey {
    pub fn generate(bits: usize) -> AttestResult<Self> {
        let size = match bits {
            2048 => KeySize::Rsa2048,
            3072 => KeySize::Rsa3072,
            4096 => KeySize::Rsa4096,
            8192 => KeySize::Rsa8192,
            _ => return Err(format!("unsupported RSA key size: {bits}")),
        };
        let signing =
            KeyPair::generate(size).map_err(|_| format!("failed to generate RSA-{bits} key"))?;
        let private_der = signing
            .as_der()
            .map_err(|_| "failed to encode RSA private key".to_string())?;
        let decrypting = PrivateDecryptingKey::from_pkcs8(private_der.as_ref())
            .map_err(|_| "failed to import generated RSA private key".to_string())?;
        let decrypting = OaepPrivateDecryptingKey::new(decrypting)
            .map_err(|_| "failed to configure RSA-OAEP".to_string())?;
        Ok(Self {
            signing,
            decrypting,
        })
    }

    pub fn from_pkcs8_der(der: &[u8]) -> AttestResult<Self> {
        let signing =
            KeyPair::from_pkcs8(der).map_err(|_| "invalid RSA PKCS#8 private key".to_string())?;
        let decrypting = PrivateDecryptingKey::from_pkcs8(der)
            .map_err(|_| "invalid RSA PKCS#8 private key".to_string())?;
        let decrypting = OaepPrivateDecryptingKey::new(decrypting)
            .map_err(|_| "failed to configure RSA-OAEP".to_string())?;
        Ok(Self {
            signing,
            decrypting,
        })
    }

    pub fn key_size_bytes(&self) -> usize {
        self.decrypting.key_size_bytes()
    }

    pub fn public_key_der(&self) -> AttestResult<Vec<u8>> {
        self.signing
            .public_key()
            .as_der()
            .map(|der| der.as_ref().to_vec())
            .map_err(|_| "failed to encode RSA public key".to_string())
    }

    pub fn decrypt_oaep_sha256(&self, ciphertext: &[u8]) -> AttestResult<Zeroizing<Vec<u8>>> {
        if ciphertext.len() != self.key_size_bytes() {
            return Err("invalid RSA-OAEP ciphertext length".to_string());
        }
        // Own the output buffer in Zeroizing before the provider sees it: both
        // success and error paths must erase plaintext when the buffer drops.
        let mut plaintext = Zeroizing::new(vec![0u8; self.key_size_bytes()]);
        let length = self
            .decrypting
            .decrypt(&OAEP_SHA256_MGF1SHA256, ciphertext, &mut plaintext, None)
            .map_err(|_| "RSA-OAEP decryption failed".to_string())?
            .len();
        plaintext.truncate(length);
        Ok(plaintext)
    }

    pub fn sign_pss_sha256_digest(&self, message: &[u8]) -> AttestResult<Vec<u8>> {
        let digest = digest(&SHA256, message);
        let mut signature = vec![0u8; self.signing.public_modulus_len()];
        self.signing
            .sign_digest(&RSA_PSS_SHA256, &digest, &mut signature)
            .map_err(|_| "RSA-PSS signing failed".to_string())?;
        Ok(signature)
    }
}
