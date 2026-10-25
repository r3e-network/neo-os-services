//! Cryptographic primitives for the Signer service.
//!
//! Neo N3 custody uses secp256r1 (P-256) ECDSA, but the message signed is not
//! the transaction: a transaction's hash is `SHA256(unsigned_tx)`, and each
//! witness signs `network_magic_le32 || hash` (36 bytes) with ECDSA-P256 over
//! the SHA-256 of those 36 bytes. Embedding the magic is what stops a
//! signature minted for one network from being replayed on another, so a
//! custody service cannot treat the magic as an unrelated transport detail.
//! RFC6979 makes the nonce deterministic and low-S is enforced because
//! consensus rejects high-S signatures.
//!
//! A single-signature account is a 40-byte verification script
//! `0c 21 <33B pubkey> 41 56 e7 b3 27` (`PUSHDATA1 33`, the key, then
//! `SYSCALL System.Crypto.CheckSig`) paired with a 66-byte invocation script
//! `0c 40 <64B r||s>`. The account script hash is `HASH160(verification_script)`.
//!
//! NeoX (EVM) custody uses secp256k1 ECDSA, following Ethereum's signing
//! conventions. Transactions are RLP-encoded and signed with EIP-155 replay
//! protection (chain ID embedded in the signature's v value).
//!
//! Every shape and preimage here is pinned by real mainnet transactions in
//! `tests/unit/crypto.rs`, not by a round-trip against this same module.
//!
//! Everything here is pure computation over borrowed bytes except the key custody
//! helpers, which hand back `zeroize`d buffers. Private key material is only ever
//! reconstructed inside these functions and cleared before returning.

use aes::cipher::{BlockDecryptMut, BlockEncryptMut, KeyIvInit};
use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use ripemd::Ripemd160;
use sha2::{Digest, Sha256};
use sha3::Keccak256;
use zeroize::Zeroizing;

use p256::ecdsa::signature::Signer;
use p256::ecdsa::{Signature, SigningKey, VerifyingKey};

use k256::ecdsa::{SigningKey as K256SigningKey, VerifyingKey as K256VerifyingKey};

type Aes256CbcDec = cbc::Decryptor<aes::Aes256>;
type Aes256CbcEnc = cbc::Encryptor<aes::Aes256>;

/// Neo address version byte (mainnet and testnet share it, so both start `N`).
pub const N3_ADDRESS_VERSION: u8 = 0x35;

/// `PUSHDATA1` — the opcode that prefixes the pubkey and the signature below.
const PUSHDATA1: u8 = 0x0c;
/// `SYSCALL`, followed by the 4-byte little-endian interop transition hash.
const SYSCALL: u8 = 0x41;
/// Interop transition hash of `System.Crypto.CheckSig` (`0x27B3E756`).
const CHECKSIG_INTEROP: [u8; 4] = [0x56, 0xe7, 0xb3, 0x27];

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum SignerCryptoError {
    InvalidPrivateKey,
    InvalidNep2,
    Nep2ChecksumMismatch,
    DecryptionFailed,
    KeyDerivationFailed,
    NotASingleSigAccount,
}

impl std::fmt::Display for SignerCryptoError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let message = match self {
            SignerCryptoError::InvalidPrivateKey => "not a usable P-256 private key",
            SignerCryptoError::InvalidNep2 => "the NEP-2 key is malformed",
            // The two causes an operator can actually tell apart, and the one
            // they will otherwise read as a broken import.
            SignerCryptoError::Nep2ChecksumMismatch => {
                "the passphrase is wrong, or the NEP-2 key is not the one expected"
            }
            SignerCryptoError::DecryptionFailed => "the key could not be decrypted",
            SignerCryptoError::KeyDerivationFailed => "the master key derivation failed",
            SignerCryptoError::NotASingleSigAccount => "not a single-signature account script",
        };
        formatter.write_str(message)
    }
}

impl std::error::Error for SignerCryptoError {}

/// HASH160 = RIPEMD160(SHA256(bytes)). Mirrors `wallet::crypto::hash::hash160`
/// but is re-declared here so the signer module does not depend on wallet's
/// crate-private visibility.
pub fn hash160(bytes: &[u8]) -> Vec<u8> {
    let sha = Sha256::digest(bytes);
    Ripemd160::digest(sha).to_vec()
}

pub fn sha256(bytes: &[u8]) -> Vec<u8> {
    Sha256::digest(bytes).to_vec()
}

/// Base58Check decode with double-SHA256 checksum verification. Returns the
/// payload without the four checksum bytes.
pub fn base58check_decode(value: &str) -> Option<Vec<u8>> {
    bs58::decode(value).with_check(None).into_vec().ok()
}

pub fn base58check_encode(payload: &[u8]) -> String {
    bs58::encode(payload).with_check().into_string()
}

/// Derive the compressed public key (33 bytes) from a 32-byte private key.
pub fn public_key_from_private(private_key: &[u8; 32]) -> Result<[u8; 33], SignerCryptoError> {
    let sk =
        SigningKey::from_slice(private_key).map_err(|_| SignerCryptoError::InvalidPrivateKey)?;
    let vk = sk.verifying_key();
    let point = vk.to_sec1_point(true);
    let bytes = point.as_bytes();
    let mut out = [0u8; 33];
    out.copy_from_slice(bytes);
    Ok(out)
}

/// Decode either SEC1 compressed or uncompressed P-256 material and return the
/// one canonical compressed representation used by custody records.
pub fn compress_public_key(public_key: &[u8]) -> Option<[u8; 33]> {
    let key = VerifyingKey::from_sec1_bytes(public_key).ok()?;
    let encoded = key.to_sec1_point(true);
    encoded.as_bytes().try_into().ok()
}

/// Mint a fresh custody private key from the OS CSPRNG.
///
/// Through `Generate::generate` rather than 32 raw random bytes because the
/// scalar has to be inside `[1, n-1]`: 32 bytes from a generator has a
/// negligible but non-zero chance of falling outside it, and a custody service
/// should not be discovering that when a key refuses to import. The RNG comes
/// from the same elliptic-curve API family as the signing trait.
pub fn generate_private_key() -> Zeroizing<[u8; 32]> {
    use p256::elliptic_curve::Generate;
    let key = SigningKey::generate();
    let mut out = [0u8; 32];
    out.copy_from_slice(key.to_bytes().as_slice());
    Zeroizing::new(out)
}

/// Neo N3 single-signature verification script:
/// `0c 21 <33B pubkey> 41 56 e7 b3 27` — 40 bytes.
pub fn verification_script(public_key: &[u8; 33]) -> Vec<u8> {
    let mut script = Vec::with_capacity(40);
    script.push(PUSHDATA1);
    script.push(33);
    script.extend_from_slice(public_key);
    script.push(SYSCALL);
    script.extend_from_slice(&CHECKSIG_INTEROP);
    script
}

/// Account script hash = HASH160(verification_script).
pub fn script_hash(public_key: &[u8; 33]) -> Vec<u8> {
    hash160(&verification_script(public_key))
}

/// Neo address string for a script hash (version 0x35, base58check).
pub fn address_from_script_hash(script_hash: &[u8]) -> String {
    let mut payload = vec![N3_ADDRESS_VERSION];
    payload.extend_from_slice(script_hash);
    base58check_encode(&payload)
}

/// Neo N3 transaction hash: `SHA256(unsigned_tx)`. The id shown by RPC
/// explorers is this digest byte-reversed.
pub fn transaction_hash(unsigned_tx: &[u8]) -> Vec<u8> {
    sha256(unsigned_tx)
}

/// The 36 bytes a witness actually signs: `network_magic_le32 ||
/// transaction_hash`. Because the magic is inside the preimage, a signature
/// produced here cannot be replayed on another network — and a custody service
/// that ignored the magic would happily sign the same bytes for both.
pub fn sign_data(unsigned_tx: &[u8], network_magic: u32) -> Vec<u8> {
    let mut data = Vec::with_capacity(4 + 32);
    data.extend_from_slice(&network_magic.to_le_bytes());
    data.extend_from_slice(&transaction_hash(unsigned_tx));
    data
}

/// Sign a serialized unsigned transaction (or consensus payload) for one network.
///
/// `p256` hashes its input with SHA-256 internally, which is the second hash N3
/// requires — `SHA256(sign_data)` is what the curve actually signs. Passing the
/// preimage unhashed is therefore correct; passing it pre-hashed would not be.
/// Low-S is enforced because consensus rejects high-S signatures.
pub fn sign_transaction(
    private_key: &[u8; 32],
    unsigned_tx: &[u8],
    network_magic: u32,
) -> Result<[u8; 64], SignerCryptoError> {
    let sk =
        SigningKey::from_slice(private_key).map_err(|_| SignerCryptoError::InvalidPrivateKey)?;
    let signature: Signature = sk.sign(&sign_data(unsigned_tx, network_magic));
    let signature = signature.normalize_s();
    let mut out = [0u8; 64];
    out.copy_from_slice(&signature.to_bytes());
    Ok(out)
}

/// Sign raw caller bytes — the digest/preimage signing the enclave's pinned
/// role keys need. Unlike [`sign_transaction`] there is no Neo framing: the
/// message the curve signs is `SHA-256(data)` exactly, which is the byte
/// contract `neon-js`'s `wallet.sign(dataHex, privateKey)` keeps (`p256`
/// hashes its input with SHA-256 internally). Low-S is enforced for the same
/// consensus reason as above.
pub fn sign_raw(private_key: &[u8; 32], data: &[u8]) -> Result<[u8; 64], SignerCryptoError> {
    let sk =
        SigningKey::from_slice(private_key).map_err(|_| SignerCryptoError::InvalidPrivateKey)?;
    let signature: Signature = sk.sign(data);
    let signature = signature.normalize_s();
    let mut out = [0u8; 64];
    out.copy_from_slice(&signature.to_bytes());
    Ok(out)
}

/// Build the invocation script for a single-signature witness:
/// `0c 40 <64B r||s>` — 66 bytes.
pub fn invocation_script(signature: &[u8; 64]) -> Vec<u8> {
    let mut script = Vec::with_capacity(66);
    script.push(PUSHDATA1);
    script.push(64);
    script.extend_from_slice(signature);
    script
}

/// Verify `r||s` against a compressed public key over a caller-built preimage,
/// mirroring Neo's `CryptoLib.ECDsaVerify`. Returns `false` rather than an error
/// so a policy decision never has to branch on malformed key material.
pub fn verify_signature(public_key: &[u8; 33], preimage: &[u8], signature: &[u8; 64]) -> bool {
    let sig = match Signature::from_slice(signature) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let vk = match VerifyingKey::from_sec1_bytes(public_key) {
        Ok(k) => k,
        Err(_) => return false,
    };
    use p256::ecdsa::signature::Verifier;
    vk.verify(preimage, &sig).is_ok()
}

// ---------------------------------------------------------------------------
// Key custody: AES-256-GCM envelope.
// ---------------------------------------------------------------------------

/// Encrypt a 32-byte private key under a 32-byte master key with AES-256-GCM.
/// Returns `(nonce_12, ciphertext)`. The master key should itself be a
/// `Zeroizing` guard so callers cannot leak it.
pub fn seal_private_key(
    master_key: &[u8; 32],
    private_key: &[u8; 32],
    nonce: &[u8; 12],
) -> Result<Vec<u8>, SignerCryptoError> {
    let key = Key::<Aes256Gcm>::from_slice(master_key);
    let cipher = Aes256Gcm::new(key);
    let nonce = Nonce::from_slice(nonce);
    cipher
        .encrypt(nonce, private_key.as_slice())
        .map_err(|_| SignerCryptoError::DecryptionFailed)
}

/// Decrypt a sealed private key. Returns a `Zeroizing` buffer so the plaintext is
/// cleared on drop.
pub fn open_private_key(
    master_key: &[u8; 32],
    nonce: &[u8],
    ciphertext: &[u8],
) -> Result<Zeroizing<Vec<u8>>, SignerCryptoError> {
    let key = Key::<Aes256Gcm>::from_slice(master_key);
    let cipher = Aes256Gcm::new(key);
    let nonce = Nonce::from_slice(nonce);
    let plaintext = cipher
        .decrypt(nonce, ciphertext)
        .map_err(|_| SignerCryptoError::DecryptionFailed)?;
    Ok(Zeroizing::new(plaintext))
}

/// Derive a 32-byte master key from the operator credential plus a per-data-dir
/// salt via HKDF-SHA256. This is the *local* key backend; a TEE backend would
/// replace this with a seal-key-derived key without touching the rest of the
/// service.
///
/// A failed expansion is an error rather than a silent zero buffer: an all-zero
/// master key would seal every custody record under a key anyone can derive.
pub fn derive_master_key(
    operator_credential: &[u8],
    data_dir_salt: &[u8],
) -> Result<[u8; 32], SignerCryptoError> {
    use hkdf::Hkdf;
    let hk = Hkdf::<Sha256>::new(Some(data_dir_salt), operator_credential);
    let mut out = [0u8; 32];
    hk.expand(b"neo-nexus/signer/v1", &mut out)
        .map_err(|_| SignerCryptoError::KeyDerivationFailed)?;
    Ok(out)
}

// ---------------------------------------------------------------------------
// NEP-2 import (BIP38-style): scrypt + AES-256-CBC.
// ---------------------------------------------------------------------------

/// Decrypt a NEP-2 encrypted private key (`6P…`) with its passphrase. Returns a
/// `Zeroizing` 32-byte private key. Verifies the address-hash checksum before
/// trusting the result.
pub fn decrypt_nep2(nep2: &str, passphrase: &str) -> Result<Zeroizing<Vec<u8>>, SignerCryptoError> {
    let payload = base58check_decode(nep2).ok_or(SignerCryptoError::InvalidNep2)?;
    if payload.len() != 39 || payload[0] != 0x01 || payload[1] != 0x42 || payload[2] != 0xe0 {
        return Err(SignerCryptoError::InvalidNep2);
    }
    let address_hash: [u8; 4] = payload[3..7]
        .try_into()
        .map_err(|_| SignerCryptoError::InvalidNep2)?;
    let encrypted = &payload[7..39];

    let mut derived = [0u8; 64];
    scrypt::scrypt(
        passphrase.as_bytes(),
        &address_hash,
        &scrypt::Params::new(14, 8, 8, 64).map_err(|_| SignerCryptoError::InvalidNep2)?,
        &mut derived,
    )
    .map_err(|_| SignerCryptoError::InvalidNep2)?;
    let (derivedhalf1, derivedhalf2) = derived.split_at(32);

    let iv = [0u8; 16];
    let mut buf = encrypted.to_vec();
    let dec = Aes256CbcDec::new_from_slices(derivedhalf2, &iv)
        .map_err(|_| SignerCryptoError::DecryptionFailed)?;
    dec.decrypt_padded_mut::<aes::cipher::block_padding::NoPadding>(&mut buf)
        .map_err(|_| SignerCryptoError::DecryptionFailed)?;

    // XOR each half with derivedhalf1 to recover the 32-byte private key.
    let mut private_key = Zeroizing::new(vec![0u8; 32]);
    for i in 0..32 {
        private_key[i] = buf[i] ^ derivedhalf1[i];
    }

    // Verify: derive the address hash from the recovered key and compare.
    let key_bytes: [u8; 32] = private_key
        .as_slice()
        .try_into()
        .map_err(|_| SignerCryptoError::InvalidPrivateKey)?;
    let public_key = public_key_from_private(&key_bytes)?;
    let script = verification_script(&public_key);
    let script_hash = hash160(&script);
    let address = address_from_script_hash(&script_hash);
    let expected = sha256(&sha256(address.as_bytes()));
    if expected[0..4] != address_hash {
        return Err(SignerCryptoError::Nep2ChecksumMismatch);
    }
    Ok(private_key)
}

/// Encrypt a raw 32-byte private key into NEP-2. Used to produce test vectors and
/// for export; not required by the signer flow itself.
pub fn encrypt_nep2(private_key: &[u8; 32], passphrase: &str) -> Result<String, SignerCryptoError> {
    let public_key = public_key_from_private(private_key)?;
    let script = verification_script(&public_key);
    let script_hash = hash160(&script);
    let address = address_from_script_hash(&script_hash);
    let address_hash = sha256(&sha256(address.as_bytes()));
    let address_hash: [u8; 4] = address_hash[0..4]
        .try_into()
        .map_err(|_| SignerCryptoError::InvalidNep2)?;

    let mut derived = [0u8; 64];
    scrypt::scrypt(
        passphrase.as_bytes(),
        &address_hash,
        &scrypt::Params::new(14, 8, 8, 64).map_err(|_| SignerCryptoError::InvalidNep2)?,
        &mut derived,
    )
    .map_err(|_| SignerCryptoError::InvalidNep2)?;
    let (derivedhalf1, derivedhalf2) = derived.split_at(32);

    let mut block = vec![0u8; 32];
    for i in 0..32 {
        block[i] = private_key[i] ^ derivedhalf1[i];
    }
    let iv = [0u8; 16];
    let enc = Aes256CbcEnc::new_from_slices(derivedhalf2, &iv)
        .map_err(|_| SignerCryptoError::DecryptionFailed)?;
    // NEP-2 plaintext is exactly two AES blocks (32 bytes); NoPadding requires an
    // exact block multiple, so encrypt in place into a fixed-size buffer.
    let encrypted = enc
        .encrypt_padded_mut::<aes::cipher::block_padding::NoPadding>(&mut block, 32)
        .map_err(|_| SignerCryptoError::DecryptionFailed)?;

    let mut payload = vec![0x01, 0x42, 0xe0];
    payload.extend_from_slice(&address_hash);
    payload.extend_from_slice(encrypted);
    Ok(base58check_encode(&payload))
}

// ============================================================================
// EVM (NeoX) Cryptographic Functions
// ============================================================================

/// Keccak256 hash (used by Ethereum/NeoX).
pub fn keccak256(bytes: &[u8]) -> Vec<u8> {
    Keccak256::digest(bytes).to_vec()
}

/// Derive the uncompressed secp256k1 public key (65 bytes) from a 32-byte private key.
/// Returns format: [0x04, x (32 bytes), y (32 bytes)]
pub fn evm_public_key_from_private(private_key: &[u8; 32]) -> Result<[u8; 65], SignerCryptoError> {
    let sk = K256SigningKey::from_slice(private_key)
        .map_err(|_| SignerCryptoError::InvalidPrivateKey)?;
    let vk = sk.verifying_key();
    let point = vk.to_sec1_point(false); // uncompressed
    let bytes = point.as_bytes();
    let mut out = [0u8; 65];
    out.copy_from_slice(bytes);
    Ok(out)
}

/// Derive the compressed secp256k1 public key stored with a NeoX custody key.
pub fn evm_compressed_public_key_from_private(
    private_key: &[u8; 32],
) -> Result<[u8; 33], SignerCryptoError> {
    let sk = K256SigningKey::from_slice(private_key)
        .map_err(|_| SignerCryptoError::InvalidPrivateKey)?;
    let point = sk.verifying_key().to_sec1_point(true);
    let mut out = [0u8; 33];
    out.copy_from_slice(point.as_bytes());
    Ok(out)
}

/// Derive the natural-order EVM address from a compressed secp256k1 public key.
pub fn evm_address_from_compressed_public_key(
    public_key: &[u8; 33],
) -> Result<[u8; 20], SignerCryptoError> {
    let key = K256VerifyingKey::from_sec1_bytes(public_key)
        .map_err(|_| SignerCryptoError::InvalidPrivateKey)?;
    let point = key.to_sec1_point(false);
    let bytes = point.as_bytes();
    let mut uncompressed = [0u8; 65];
    uncompressed.copy_from_slice(bytes);
    Ok(evm_address_from_public_key(&uncompressed))
}

/// Derive Ethereum address from secp256k1 public key.
/// Address = last 20 bytes of keccak256(uncompressed_pubkey[1..65])
pub fn evm_address_from_public_key(public_key: &[u8; 65]) -> [u8; 20] {
    // Skip the 0x04 prefix byte, hash the rest
    let hash = keccak256(&public_key[1..]);
    let mut address = [0u8; 20];
    address.copy_from_slice(&hash[12..32]);
    address
}

/// Derive Ethereum address from private key.
pub fn evm_address_from_private(private_key: &[u8; 32]) -> Result<[u8; 20], SignerCryptoError> {
    let public_key = evm_public_key_from_private(private_key)?;
    Ok(evm_address_from_public_key(&public_key))
}

/// EVM transaction signature with EIP-155 replay protection.
///
/// The signature includes:
/// - r: 32 bytes
/// - s: 32 bytes
/// - v: 1 byte (recovery id + chain_id encoding for EIP-155)
///
/// Returns (r, s, v) as a 65-byte array.
pub fn sign_evm_transaction(
    private_key: &[u8; 32],
    unsigned_tx_hash: &[u8; 32],
    chain_id: u64,
) -> Result<[u8; 65], SignerCryptoError> {
    let sk = K256SigningKey::from_slice(private_key)
        .map_err(|_| SignerCryptoError::InvalidPrivateKey)?;

    // Sign the transaction hash
    let (signature, recovery_id) = sk.sign_prehash_recoverable(unsigned_tx_hash);

    let sig_bytes = signature.to_bytes();
    let mut r = [0u8; 32];
    let mut s = [0u8; 32];
    r.copy_from_slice(&sig_bytes[..32]);
    s.copy_from_slice(&sig_bytes[32..]);

    // EIP-155: v = recovery_id + 35 + 2 * chain_id
    // For non-EIP155 (legacy): v = recovery_id + 27
    let v = if chain_id > 0 {
        recovery_id.to_byte() as u64 + 35 + 2 * chain_id
    } else {
        recovery_id.to_byte() as u64 + 27
    };

    // Pack into 65-byte signature: r || s || v
    let mut result = [0u8; 65];
    result[..32].copy_from_slice(&r);
    result[32..64].copy_from_slice(&s);
    result[64] = v as u8;

    Ok(result)
}

/// Sign an already-domain-separated EIP-191 prehash and return the Ethereum
/// `(r, s, v)` wire shape.  The caller must build the prehash from a structured
/// semantic request; this primitive is intentionally not exposed by the raw
/// signing HTTP route.
pub fn sign_eip191_prehash(
    private_key: &[u8; 32],
    message_hash: &[u8; 32],
) -> Result<[u8; 65], SignerCryptoError> {
    let sk = K256SigningKey::from_slice(private_key)
        .map_err(|_| SignerCryptoError::InvalidPrivateKey)?;
    let (signature, recovery_id) = sk.sign_prehash_recoverable(message_hash);
    let mut result = [0u8; 65];
    result[..64].copy_from_slice(&signature.to_bytes());
    // personal_sign/ecrecover uses the historical 27/28 convention.
    result[64] = recovery_id.to_byte() + 27;
    Ok(result)
}

/// Generate a fresh secp256k1 private key for EVM chains.
pub fn generate_evm_private_key() -> Zeroizing<[u8; 32]> {
    use p256::elliptic_curve::Generate;
    let key = K256SigningKey::generate();
    let mut out = [0u8; 32];
    out.copy_from_slice(key.to_bytes().as_slice());
    Zeroizing::new(out)
}

#[cfg(test)]
#[path = "../tests/unit/crypto.rs"]
mod tests;
