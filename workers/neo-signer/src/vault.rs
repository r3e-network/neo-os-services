//! The key backend: where the master key that opens the vault comes from.
//!
//! This is the seam a TEE implementation replaces. Everything above it — sealing,
//! opening, policy, signing — asks for 32 bytes and does not care who held them,
//! so moving the vault into an enclave means changing this module and the
//! deployment that starts the service, not the custody logic.
//!
//! Two local sources, and the difference between them is the whole point:
//!
//! * `SIGNER_SERVICE_MASTER_KEY` — the operator supplies the whole key out of
//!   band (secret manager, KMS, an enclave-attested config push), either as 64
//!   hex characters or as a passphrase stretched through HKDF-SHA256 with the
//!   data directory as the salt. Neither form ever touches the disk.
//! * `<data_dir>/signer-master.key` — created on first use with 32 random bytes
//!   and mode `0600`. This is the convenience path: it survives restarts with no
//!   operator setup, and it is worth stating plainly that it protects the vault
//!   from a database dump, not from anyone who can read the data directory. That
//!   is exactly the gap the TEE backend exists to close.

use std::{
    fs,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result};
use zeroize::Zeroizing;

use crate::{crypto, model::SealedPrivateKey};

/// Name of the environment variable holding an out-of-band master key.
pub const MASTER_KEY_ENV: &str = "SIGNER_SERVICE_MASTER_KEY";

/// File name of the generated master key, inside the data directory.
pub const MASTER_KEY_FILE: &str = "signer-master.key";

/// Length, in characters, of a hex-encoded 32-byte key.
const MASTER_KEY_HEX_CHARS: usize = 64;

/// Shortest passphrase accepted for the stretched form. The vault's whole
/// security rests on this value once the database is copied, so a four-character
/// credential would turn the AES-GCM layer into decoration.
const MIN_PASSPHRASE_CHARS: usize = 16;

/// The 32 bytes every custody record is sealed under.
///
/// Held in `Zeroizing` so the buffer is cleared when the service drops it, and
/// exposed only as a borrowed array: a `MasterKey` cannot be moved into a log
/// line, a response body, or a `Debug` print.
pub struct MasterKey(Zeroizing<[u8; 32]>);

impl MasterKey {
    /// Resolve the master key for a data directory.
    ///
    /// The environment variable wins so an operator can migrate a live vault
    /// onto a supplied key by setting it before the next start; the generated
    /// file is never read in that mode, and a mismatch between the two is
    /// reported when a sealed key refuses to open rather than guessed at here.
    pub fn open(data_dir: &Path) -> Result<Self> {
        match Self::from_environment(data_dir)? {
            Some(key) => Ok(key),
            None => Self::open_or_create_file(data_dir),
        }
    }

    /// `Ok(None)` when no out-of-band key was supplied, which is the signal to
    /// fall back to the data-directory file.
    fn from_environment(data_dir: &Path) -> Result<Option<Self>> {
        let Some(raw) = std::env::var(MASTER_KEY_ENV).ok() else {
            return Ok(None);
        };
        Self::from_credential(raw.trim(), data_dir)
    }

    /// The two out-of-band forms, which operators genuinely both have. A secret
    /// manager or enclave attestation flow can hand over 32 finished bytes; a
    /// human rotating a master credential types a passphrase. The passphrase is
    /// never used as a key directly — it goes through HKDF-SHA256, so a weak-ish
    /// 16-character credential at least cannot be lifted straight into AES-256
    /// as-is, and the same salted derivation is what the design specifies.
    ///
    /// `Ok(None)` means "nothing was supplied", which only an empty value says.
    fn from_credential(credential: &str, data_dir: &Path) -> Result<Option<Self>> {
        if credential.is_empty() {
            return Ok(None);
        }
        if credential.len() == MASTER_KEY_HEX_CHARS {
            if let Ok(bytes) = decode_key(credential) {
                return Ok(Some(MasterKey::from_bytes(bytes)));
            }
        }
        if credential.chars().count() < MIN_PASSPHRASE_CHARS {
            anyhow::bail!(
                "{MASTER_KEY_ENV} must be {MASTER_KEY_HEX_CHARS} hex characters or at least {MIN_PASSPHRASE_CHARS} characters; a short master credential is the weakest link in a custody service"
            );
        }
        // The directory is the salt, so the derivation is bound to the vault it
        // opens. Copying both the database and the credential to a different
        // path is a different operation, and it is meant to look like one.
        let salt = data_dir
            .canonicalize()
            .unwrap_or_else(|_| data_dir.to_path_buf())
            .to_string_lossy()
            .into_owned();
        let derived = crypto::derive_master_key(credential.as_bytes(), salt.as_bytes())
            .map_err(|error| anyhow::anyhow!("failed to derive the master key: {error:?}"))?;
        Ok(Some(MasterKey::from_bytes(derived)))
    }

    fn open_or_create_file(data_dir: &Path) -> Result<Self> {
        let path = data_dir.join(MASTER_KEY_FILE);
        match fs::read_to_string(&path) {
            Ok(stored) => {
                let bytes = decode_key(&stored).with_context(|| {
                    format!(
                        "{} does not hold a 64-character hex master key",
                        path.display()
                    )
                })?;
                Ok(MasterKey::from_bytes(bytes))
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let mut raw = [0u8; 32];
                use aes_gcm::aead::{rand_core::RngCore, OsRng};
                OsRng.fill_bytes(&mut raw);
                let encoded = format!("{}\n", hex::encode(raw));
                write_private(&path, &encoded)?;
                Ok(MasterKey::from_bytes(raw))
            }
            Err(error) => {
                Err(error).with_context(|| format!("failed to read master key {}", path.display()))
            }
        }
    }

    /// Wrap finished key bytes, as produced by either source above.
    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        MasterKey(Zeroizing::new(bytes))
    }

    pub fn bytes(&self) -> &[u8; 32] {
        &self.0
    }

    /// Seal a private key under a fresh random nonce.
    ///
    /// The nonce is random rather than derived from the plaintext: two operators
    /// importing the same test-net WIF into two records must not produce two
    /// identical ciphertexts, which is what a deterministic nonce would give
    /// them, and it would say so in the database.
    pub fn seal(&self, private_key: &[u8; 32]) -> Result<SealedPrivateKey> {
        let mut nonce = [0u8; 12];
        use aes_gcm::aead::{rand_core::RngCore, OsRng};
        OsRng.fill_bytes(&mut nonce);
        let ciphertext = crypto::seal_private_key(self.bytes(), private_key, &nonce)
            .map_err(|error| anyhow::anyhow!("failed to seal the private key: {error:?}"))?;
        Ok(SealedPrivateKey { nonce, ciphertext })
    }

    /// Open a sealed private key. The returned buffer is `Zeroizing`, so callers
    /// get the same guarantee the seal path has.
    pub fn open_sealed(&self, sealed: &SealedPrivateKey) -> Result<Zeroizing<Vec<u8>>> {
        crypto::open_private_key(self.bytes(), &sealed.nonce, &sealed.ciphertext)
            .map_err(|error| anyhow::anyhow!("failed to open the sealed key: {error:?}"))
    }

    /// The fingerprint to show an operator, so two vaults can be told apart
    /// without either key being readable.
    pub fn fingerprint(&self) -> String {
        let digest = crypto::sha256(self.bytes());
        hex::encode(&digest[..4])
    }
}

fn decode_key(stored: &str) -> Result<[u8; 32]> {
    let trimmed = stored.trim();
    let raw = hex::decode(trimmed).context("master key file must be hexadecimal")?;
    <[u8; 32]>::try_from(raw).map_err(|_| anyhow::anyhow!("master key must be exactly 32 bytes"))
}

/// Write with owner-only permissions where the platform supports them.
///
/// Windows ignores mode bits, so the file inherits the directory's ACL; that is
/// noted rather than worked around because the access-control story on that
/// platform is not this function's to tell.
fn write_private(path: &Path, contents: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create {}", parent.display()))?;
    }
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .with_context(|| format!("failed to create {}", path.display()))?;
    use std::io::Write;
    file.write_all(contents.as_bytes())
        .with_context(|| format!("failed to write {}", path.display()))?;
    Ok(())
}

/// The path this module would create, for the page that tells an operator where
/// the vault's key lives.
pub fn master_key_path(data_dir: &Path) -> PathBuf {
    data_dir.join(MASTER_KEY_FILE)
}

#[cfg(test)]
#[path = "../tests/unit/vault.rs"]
mod tests;
