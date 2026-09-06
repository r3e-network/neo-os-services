//! Minimal Ethereum ABI codec for exactly the shapes the Neo X relayer needs:
//! uint256 / address / bool / uint8 / uint64 / bytes32 (static), bytes /
//! string (dynamic), plus tuple decoding of the kernel's `getRequest` return.
//! Hand-written instead of pulling alloy/ethers (risk R9) and pinned by
//! ethers-harvested goldens (`tests/vectors/neox_abi.json`).
//!
//! Semantics that must not drift:
//! * all head words are 32 bytes, big-endian;
//! * dynamic fields (bytes/string) encode as offset-then-length-then-padded
//!   data, offsets relative to the start of the enclosing block;
//! * uint8/uint64 values read from the high-order word bytes are rejected —
//!   the kernel never sets them, and silent truncation would corrupt ids.

use sha3::{Digest, Keccak256};

/// keccak256 — the EVM hash function (digests, function selectors).
pub fn keccak256(bytes: &[u8]) -> [u8; 32] {
    Keccak256::digest(bytes).into()
}

/// An ABI encoding failure (overlong data, bad hex, out-of-bounds decode).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AbiError(pub String);

impl std::fmt::Display for AbiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for AbiError {}

/// The ABI value shapes this codec supports.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AbiValue {
    Uint256([u8; 32]),
    /// 20-byte address, padded to 32 on encode.
    Address([u8; 20]),
    Bool(bool),
    Bytes(Vec<u8>),
    String(String),
}

/// Left-pad a 20-byte address into a 32-byte head word.
fn address_word(address: &[u8; 20]) -> [u8; 32] {
    let mut word = [0u8; 32];
    word[12..].copy_from_slice(address);
    word
}

/// Convert a u64 into a 32-byte big-endian word (left-padded with zeros).
fn u64_to_word(val: u64) -> [u8; 32] {
    let mut word = [0u8; 32];
    word[24..].copy_from_slice(&val.to_be_bytes());
    word
}

/// Decode a 32-byte big-endian word into a u64, rejecting values exceeding u64.
fn word_to_u64(word: &[u8]) -> Result<u64, AbiError> {
    if word.len() != 32 {
        return Err(AbiError("invalid word length".into()));
    }
    if word[..24].iter().any(|&b| b != 0) {
        return Err(AbiError("value exceeds u64 bounds".into()));
    }
    let bytes: [u8; 8] = word[24..32].try_into().unwrap();
    Ok(u64::from_be_bytes(bytes))
}

/// Encode the values as one ABI blob (no function selector). The head is one
/// 32-byte word per value (static inline, dynamic as an offset); offsets point
/// into the tail starting right after the full head.
pub fn abi_encode(values: &[AbiValue]) -> Result<Vec<u8>, AbiError> {
    let head_size = values.len() * 32;
    let mut head = Vec::with_capacity(head_size);
    let mut tail = Vec::new();
    for value in values {
        match value {
            AbiValue::Uint256(word) => head.extend_from_slice(word),
            AbiValue::Address(address) => head.extend_from_slice(&address_word(address)),
            AbiValue::Bool(flag) => {
                let mut word = [0u8; 32];
                word[31] = u8::from(*flag);
                head.extend_from_slice(&word);
            }
            AbiValue::Bytes(data) => {
                head.extend_from_slice(&u64_to_word(head_size as u64 + tail.len() as u64));
                tail.extend_from_slice(&u64_to_word(data.len() as u64));
                tail.extend_from_slice(data);
                let padded = tail.len() + ((32 - tail.len() % 32) % 32);
                tail.resize(padded, 0);
            }
            AbiValue::String(text) => {
                head.extend_from_slice(&u64_to_word(head_size as u64 + tail.len() as u64));
                tail.extend_from_slice(&u64_to_word(text.len() as u64));
                tail.extend_from_slice(text.as_bytes());
                let padded = tail.len() + ((32 - tail.len() % 32) % 32);
                tail.resize(padded, 0);
            }
        }
    }
    if head.len() != head_size {
        return Err(AbiError("internal head alignment error".into()));
    }
    Ok([head, tail].concat())
}

/// A decoded dynamic field from [`abi_decode`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DecodedField {
    Uint256([u8; 32]),
    Address([u8; 20]),
    Bool(bool),
    Bytes(Vec<u8>),
    String(String),
}

/// Decode a top-level ABI blob of `(uint256, bytes)` — the confidential
/// callback payload wrapper.
pub fn abi_decode_uint256_bytes(blob: &[u8]) -> Result<(String, Vec<u8>), AbiError> {
    if blob.len() < 64 {
        return Err(AbiError("blob shorter than two head words".into()));
    }
    let message_id = hex_lower(&blob[0..32]);
    let offset = word_to_u64(&blob[32..64])? as usize;
    if blob.len() < offset + 32 {
        return Err(AbiError("bytes offset out of bounds".into()));
    }
    let len = word_to_u64(&blob[offset..offset + 32])? as usize;
    if blob.len() < offset + 32 + len {
        return Err(AbiError("bytes data out of bounds".into()));
    }
    Ok((message_id, blob[offset + 32..offset + 32 + len].to_vec()))
}

fn hex_lower(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
