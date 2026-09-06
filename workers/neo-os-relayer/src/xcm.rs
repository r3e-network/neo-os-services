//! Cross-chain message types and deterministic encoding for the XCM lane.
//!
//! The XCM (cross-chain message) lane relays arbitrary messages between Neo N3
//! and NeoX. This module provides the wire format: a [`CrossChainMessage`] with
//! canonical byte encoding and a SHA-256 commitment hash used as the message id
//! and for on-chain verification.
//!
//! # Deterministic encoding
//!
//! Canonical byte format (big-endian):
//! ```text
//! [source_chain.len() as u32][source_chain bytes]
//! [dest_chain.len() as u32][dest_chain bytes]
//! [nonce as u64]
//! [payload.len() as u64][payload bytes]
//! ```
//!
//! The commitment is `sha256(canonical_bytes)` in lowercase hex. This ensures
//! exactly-once semantics: the same logical message always produces the same
//! commitment, enabling idempotent persistence and cross-instance deduplication.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// A cross-chain message relayed between Neo N3 and NeoX.
///
/// The message is content-addressed: [`CrossChainMessage::commitment`] derives
/// a unique 32-byte SHA-256 hash from the canonical encoding of all fields.
/// This commitment serves as the message id for persistence, on-chain delivery,
/// and exactly-once deduplication.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CrossChainMessage {
    /// Source chain identifier (e.g., "neo_n3", "neox").
    pub source_chain: String,
    /// Destination chain identifier.
    pub dest_chain: String,
    /// Monotonic per-(source,dest) nonce for ordering and replay protection.
    pub nonce: u64,
    /// Arbitrary message payload bytes.
    pub payload: Vec<u8>,
}

impl CrossChainMessage {
    /// Create a new cross-chain message.
    pub fn new(
        source_chain: impl Into<String>,
        dest_chain: impl Into<String>,
        nonce: u64,
        payload: Vec<u8>,
    ) -> Self {
        Self {
            source_chain: source_chain.into(),
            dest_chain: dest_chain.into(),
            nonce,
            payload,
        }
    }

    /// Encode the message into canonical bytes for hashing and transmission.
    ///
    /// Format: `[source_len:u32][source][dest_len:u32][dest][nonce:u64][payload_len:u64][payload]`
    pub fn encode_canonical(&self) -> Vec<u8> {
        let mut out = Vec::new();
        
        // Source chain: length-prefixed UTF-8
        let source_bytes = self.source_chain.as_bytes();
        out.extend_from_slice(&(source_bytes.len() as u32).to_be_bytes());
        out.extend_from_slice(source_bytes);
        
        // Destination chain: length-prefixed UTF-8
        let dest_bytes = self.dest_chain.as_bytes();
        out.extend_from_slice(&(dest_bytes.len() as u32).to_be_bytes());
        out.extend_from_slice(dest_bytes);
        
        // Nonce: big-endian u64
        out.extend_from_slice(&self.nonce.to_be_bytes());
        
        // Payload: length-prefixed bytes
        out.extend_from_slice(&(self.payload.len() as u64).to_be_bytes());
        out.extend_from_slice(&self.payload);
        
        out
    }

    /// Compute the SHA-256 commitment hash of the canonical encoding.
    ///
    /// This is the message's unique identifier for persistence and on-chain
    /// delivery. The same logical message always produces the same commitment.
    pub fn commitment(&self) -> String {
        let canonical = self.encode_canonical();
        let hash = Sha256::digest(&canonical);
        hex::encode(hash)
    }

    /// Decode a message from canonical bytes.
    ///
    /// Returns `Err` if the byte slice is malformed or incomplete.
    pub fn decode_canonical(bytes: &[u8]) -> Result<Self, String> {
        // Every length-derived offset uses checked arithmetic. A crafted length
        // prefix (e.g. payload_len = u64::MAX) must yield Err, never a wrapping
        // `pos + len` that slips past the bounds check and then panics (debug)
        // or mis-slices (release) on `bytes[pos..end]`.
        let mut pos: usize = 0;

        // Read source chain: u32 length prefix, then that many UTF-8 bytes.
        let head_end = pos
            .checked_add(4)
            .filter(|end| *end <= bytes.len())
            .ok_or_else(|| "source length truncated".to_string())?;
        let source_len = u32::from_be_bytes(
            bytes[pos..head_end]
                .try_into()
                .map_err(|_| "invalid source length".to_string())?,
        ) as usize;
        let source_end = head_end
            .checked_add(source_len)
            .filter(|end| *end <= bytes.len())
            .ok_or_else(|| "source chain truncated or length overflow".to_string())?;
        let source_chain = String::from_utf8(bytes[head_end..source_end].to_vec())
            .map_err(|_| "source chain is not valid UTF-8".to_string())?;
        pos = source_end;

        // Read destination chain: u32 length prefix, then that many UTF-8 bytes.
        let head_end = pos
            .checked_add(4)
            .filter(|end| *end <= bytes.len())
            .ok_or_else(|| "destination length truncated".to_string())?;
        let dest_len = u32::from_be_bytes(
            bytes[pos..head_end]
                .try_into()
                .map_err(|_| "invalid destination length".to_string())?,
        ) as usize;
        let dest_end = head_end
            .checked_add(dest_len)
            .filter(|end| *end <= bytes.len())
            .ok_or_else(|| "destination chain truncated or length overflow".to_string())?;
        let dest_chain = String::from_utf8(bytes[head_end..dest_end].to_vec())
            .map_err(|_| "destination chain is not valid UTF-8".to_string())?;
        pos = dest_end;

        // Read nonce: big-endian u64.
        let nonce_end = pos
            .checked_add(8)
            .filter(|end| *end <= bytes.len())
            .ok_or_else(|| "nonce truncated".to_string())?;
        let nonce = u64::from_be_bytes(
            bytes[pos..nonce_end]
                .try_into()
                .map_err(|_| "invalid nonce".to_string())?,
        );
        pos = nonce_end;

        // Read payload: u64 length prefix, then that many bytes. The u64 length
        // is first narrowed to usize (rejecting values that cannot be indexed),
        // then added with checked_add so u64::MAX can never wrap the offset.
        let head_end = pos
            .checked_add(8)
            .filter(|end| *end <= bytes.len())
            .ok_or_else(|| "payload length truncated".to_string())?;
        let payload_len = u64::from_be_bytes(
            bytes[pos..head_end]
                .try_into()
                .map_err(|_| "invalid payload length".to_string())?,
        );
        let payload_len_usize = usize::try_from(payload_len)
            .map_err(|_| "payload length exceeds addressable range".to_string())?;
        let payload_end = head_end
            .checked_add(payload_len_usize)
            .filter(|end| *end <= bytes.len())
            .ok_or_else(|| "payload truncated or length overflow".to_string())?;
        let payload = bytes[head_end..payload_end].to_vec();
        pos = payload_end;

        // Verify no extra bytes.
        if pos != bytes.len() {
            return Err(format!(
                "canonical message has {} trailing bytes",
                bytes.len() - pos
            ));
        }

        Ok(Self {
            source_chain,
            dest_chain,
            nonce,
            payload,
        })
    }

    /// Validate the message structure before processing.
    ///
    /// Checks that chain identifiers are non-empty and do not contain
    /// problematic characters (null bytes, control characters).
    pub fn validate(&self) -> Result<(), String> {
        if self.source_chain.is_empty() {
            return Err("source chain is empty".to_string());
        }
        if self.dest_chain.is_empty() {
            return Err("destination chain is empty".to_string());
        }
        if self.source_chain == self.dest_chain {
            return Err(format!(
                "source and destination chains must differ (both are {})",
                self.source_chain
            ));
        }
        
        // Reject control characters and null bytes in chain identifiers
        for (name, chain) in [
            ("source", &self.source_chain),
            ("destination", &self.dest_chain),
        ] {
            if chain.chars().any(|c| c.is_control() || c == '\0') {
                return Err(format!("{name} chain contains control characters"));
            }
        }
        
        Ok(())
    }

    /// Create a message from a JSON value (used when reading from durable queue).
    pub fn from_json_value(value: &serde_json::Value) -> Result<Self, String> {
        serde_json::from_value(value.clone())
            .map_err(|e| format!("failed to parse cross-chain message: {e}"))
    }

    /// Convert to JSON value for persistence.
    pub fn to_json_value(&self) -> serde_json::Value {
        serde_json::to_value(self).expect("CrossChainMessage serialization cannot fail")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn message_encode_decode_roundtrip() {
        let msg = CrossChainMessage::new("neo_n3", "neox", 42, vec![1, 2, 3, 4]);
        let canonical = msg.encode_canonical();
        let decoded = CrossChainMessage::decode_canonical(&canonical)
            .expect("decode should succeed");
        assert_eq!(msg, decoded);
    }

    #[test]
    fn message_commitment_is_deterministic() {
        let msg1 = CrossChainMessage::new("neo_n3", "neox", 1, vec![0xff]);
        let msg2 = CrossChainMessage::new("neo_n3", "neox", 1, vec![0xff]);
        assert_eq!(msg1.commitment(), msg2.commitment());
        
        let msg3 = CrossChainMessage::new("neo_n3", "neox", 2, vec![0xff]);
        assert_ne!(msg1.commitment(), msg3.commitment());
    }

    #[test]
    fn message_commitment_format() {
        let msg = CrossChainMessage::new("neo_n3", "neox", 0, vec![]);
        let commitment = msg.commitment();
        assert_eq!(commitment.len(), 64); // SHA-256 hex
        assert!(commitment.chars().all(|c| c.is_ascii_hexdigit()));
        assert!(commitment.chars().all(|c| !c.is_ascii_uppercase()));
    }

    #[test]
    fn message_validation_rejects_empty_chains() {
        let msg = CrossChainMessage::new("", "neox", 1, vec![]);
        assert!(msg.validate().is_err());
        
        let msg = CrossChainMessage::new("neo_n3", "", 1, vec![]);
        assert!(msg.validate().is_err());
    }

    #[test]
    fn message_validation_rejects_same_chain() {
        let msg = CrossChainMessage::new("neo_n3", "neo_n3", 1, vec![]);
        let err = msg.validate().unwrap_err();
        assert!(err.contains("must differ"));
    }

    #[test]
    fn message_validation_rejects_control_chars() {
        let msg = CrossChainMessage::new("neo\nn3", "neox", 1, vec![]);
        assert!(msg.validate().is_err());
    }

    #[test]
    fn message_decode_rejects_truncated() {
        let msg = CrossChainMessage::new("neo_n3", "neox", 1, vec![1, 2, 3]);
        let mut canonical = msg.encode_canonical();
        canonical.truncate(canonical.len() - 2);
        assert!(CrossChainMessage::decode_canonical(&canonical).is_err());
    }

    #[test]
    fn message_decode_rejects_extra_bytes() {
        let msg = CrossChainMessage::new("neo_n3", "neox", 1, vec![]);
        let mut canonical = msg.encode_canonical();
        canonical.push(0xff);
        let err = CrossChainMessage::decode_canonical(&canonical).unwrap_err();
        assert!(err.contains("trailing bytes"));
    }

    /// Fix #4: a crafted payload_len = u64::MAX must return Err, never panic.
    /// A naive `pos + (u64::MAX as usize)` wraps to a small offset that slips
    /// past the bounds check and then panics/mis-slices.
    #[test]
    fn message_decode_rejects_overflowing_payload_len() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&1u32.to_be_bytes());
        bytes.extend_from_slice(b"a");
        bytes.extend_from_slice(&1u32.to_be_bytes());
        bytes.extend_from_slice(b"b");
        bytes.extend_from_slice(&0u64.to_be_bytes());
        bytes.extend_from_slice(&u64::MAX.to_be_bytes());
        // No payload bytes follow the overflowing length prefix.
        assert!(CrossChainMessage::decode_canonical(&bytes).is_err());
    }

    /// Fix #4: an overflowing u32 source_len must return Err, never panic.
    #[test]
    fn message_decode_rejects_overflowing_source_len() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&u32::MAX.to_be_bytes());
        bytes.extend_from_slice(b"a");
        assert!(CrossChainMessage::decode_canonical(&bytes).is_err());
    }

    /// Fix #4: an overflowing u32 dest_len must return Err, never panic.
    #[test]
    fn message_decode_rejects_overflowing_dest_len() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&1u32.to_be_bytes());
        bytes.extend_from_slice(b"a");
        bytes.extend_from_slice(&u32::MAX.to_be_bytes());
        bytes.extend_from_slice(b"b");
        assert!(CrossChainMessage::decode_canonical(&bytes).is_err());
    }

    /// Fix #4: an empty/truncated buffer is rejected without slicing out of
    /// range (the old `< 4` guard is subsumed by checked header reads).
    #[test]
    fn message_decode_rejects_empty_buffer() {
        assert!(CrossChainMessage::decode_canonical(&[]).is_err());
        assert!(CrossChainMessage::decode_canonical(&[0u8, 0, 0]).is_err());
    }

    #[test]
    fn message_json_roundtrip() {
        let msg = CrossChainMessage::new("neox", "neo_n3", 999, b"hello".to_vec());
        let json = msg.to_json_value();
        let decoded = CrossChainMessage::from_json_value(&json)
            .expect("JSON roundtrip");
        assert_eq!(msg, decoded);
    }
}
