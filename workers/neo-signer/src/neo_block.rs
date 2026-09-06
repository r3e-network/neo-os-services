//! Validated Neo N3 block-signing input.
//!
//! A block signature is not a raw signature with a convenient label.  The
//! transaction hashes commit to the Merkle root, the header has a precise wire
//! encoding, and a validator must never sign two different headers at one
//! height.  This type establishes the first two facts before the service is
//! allowed to reserve the third.

use std::fmt;

use sha2::{Digest, Sha256};

pub const HASH256_LEN: usize = 32;
pub const HASH160_LEN: usize = 20;

/// The fields in Neo's `Header.SerializeUnsigned`, in wire byte order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NeoBlockHeader {
    pub version: u32,
    pub prev_hash: [u8; HASH256_LEN],
    pub merkle_root: [u8; HASH256_LEN],
    pub timestamp: u64,
    pub nonce: u64,
    pub index: u32,
    pub primary_index: u8,
    pub next_consensus: [u8; HASH160_LEN],
    pub prev_state_root: Option<[u8; HASH256_LEN]>,
}

impl NeoBlockHeader {
    /// Construct a header from the SignClient wire width. Neo serializes the
    /// primary index as one byte even though protobuf represents it as u32.
    #[allow(clippy::too_many_arguments)]
    pub fn from_wire(
        version: u32,
        prev_hash: [u8; HASH256_LEN],
        merkle_root: [u8; HASH256_LEN],
        timestamp: u64,
        nonce: u64,
        index: u32,
        primary_index: u32,
        next_consensus: [u8; HASH160_LEN],
    ) -> Result<Self, BlockError> {
        Self::from_wire_with_state_root(
            version,
            prev_hash,
            merkle_root,
            timestamp,
            nonce,
            index,
            primary_index,
            next_consensus,
            None,
            false,
        )
    }

    /// Construct the wire-compatible state-root extension used by the existing
    /// secure-sign implementation. Official SignClient leaves both extension
    /// fields at their protobuf defaults.
    #[allow(clippy::too_many_arguments)]
    pub fn from_wire_with_state_root(
        version: u32,
        prev_hash: [u8; HASH256_LEN],
        merkle_root: [u8; HASH256_LEN],
        timestamp: u64,
        nonce: u64,
        index: u32,
        primary_index: u32,
        next_consensus: [u8; HASH160_LEN],
        prev_state_root: Option<[u8; HASH256_LEN]>,
        state_root_enabled: bool,
    ) -> Result<Self, BlockError> {
        let primary_index = u8::try_from(primary_index).map_err(|_| BlockError::PrimaryIndex)?;
        let prev_state_root = match (state_root_enabled, prev_state_root) {
            (true, Some(root)) => Some(root),
            (true, None) => return Err(BlockError::MissingStateRoot),
            (false, Some(_)) => return Err(BlockError::UnexpectedStateRoot),
            (false, None) => None,
        };
        Ok(Self {
            version,
            prev_hash,
            merkle_root,
            timestamp,
            nonce,
            index,
            primary_index,
            next_consensus,
            prev_state_root,
        })
    }

    fn serialize_unsigned(&self) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(109);
        bytes.extend_from_slice(&self.version.to_le_bytes());
        bytes.extend_from_slice(&self.prev_hash);
        bytes.extend_from_slice(&self.merkle_root);
        bytes.extend_from_slice(&self.timestamp.to_le_bytes());
        bytes.extend_from_slice(&self.nonce.to_le_bytes());
        bytes.extend_from_slice(&self.index.to_le_bytes());
        bytes.push(self.primary_index);
        bytes.extend_from_slice(&self.next_consensus);
        if let Some(prev_state_root) = self.prev_state_root {
            bytes.extend_from_slice(&prev_state_root);
        }
        bytes
    }
}

/// A trimmed block whose transaction set has already been checked against its
/// header. Its fields stay private so no caller can mutate it after validation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NeoBlock {
    header: NeoBlockHeader,
    tx_hashes: Vec<[u8; HASH256_LEN]>,
    unsigned: Vec<u8>,
}

impl NeoBlock {
    pub fn new(
        header: NeoBlockHeader,
        tx_hashes: Vec<[u8; HASH256_LEN]>,
    ) -> Result<Self, BlockError> {
        let calculated = merkle_root(&tx_hashes);
        if calculated != header.merkle_root {
            return Err(BlockError::MerkleRootMismatch);
        }
        let unsigned = header.serialize_unsigned();
        Ok(Self {
            header,
            tx_hashes,
            unsigned,
        })
    }

    pub fn index(&self) -> u32 {
        self.header.index
    }

    pub fn unsigned(&self) -> &[u8] {
        &self.unsigned
    }

    pub fn transaction_hashes(&self) -> &[[u8; HASH256_LEN]] {
        &self.tx_hashes
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlockError {
    PrimaryIndex,
    MerkleRootMismatch,
    MissingStateRoot,
    UnexpectedStateRoot,
}

impl fmt::Display for BlockError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::PrimaryIndex => "primary_index does not fit Neo's one-byte header field",
            Self::MerkleRootMismatch => {
                "the block transaction hashes do not match the header Merkle root"
            }
            Self::MissingStateRoot => {
                "prev_state_root must be 32 bytes when state_root_enabled is true"
            }
            Self::UnexpectedStateRoot => {
                "prev_state_root must be absent when state_root_enabled is false"
            }
        })
    }
}

impl std::error::Error for BlockError {}

/// Neo's Merkle tree: double-SHA256 each pair, duplicating an odd last node.
pub fn merkle_root(hashes: &[[u8; HASH256_LEN]]) -> [u8; HASH256_LEN] {
    match hashes {
        [] => [0; HASH256_LEN],
        [only] => *only,
        _ => {
            let mut level = hashes.to_vec();
            while level.len() > 1 {
                let mut parent = Vec::with_capacity(level.len().div_ceil(2));
                for pair in level.chunks(2) {
                    let right = pair.get(1).unwrap_or(&pair[0]);
                    let mut children = [0u8; HASH256_LEN * 2];
                    children[..HASH256_LEN].copy_from_slice(&pair[0]);
                    children[HASH256_LEN..].copy_from_slice(right);
                    let first = Sha256::digest(children);
                    parent.push(Sha256::digest(first).into());
                }
                level = parent;
            }
            level[0]
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merkle_root_matches_neo_vectors() {
        assert_eq!(merkle_root(&[]), [0; 32]);
        assert_eq!(merkle_root(&[[1; 32]]), [1; 32]);
        assert_eq!(
            hex::encode(merkle_root(&[[1; 32], [2; 32]])),
            "39ce20bede82c96b8908bec4a157b09c549b3db90b9b474bda9ae9b9030310b4"
        );
        assert_eq!(
            hex::encode(merkle_root(&[[1; 32], [2; 32], [3; 32]])),
            "223e023fadf1f053df26988871f893c821c28edf77d64a955e6c2a02d547bdac"
        );
    }

    #[test]
    fn validates_merkle_root_and_serializes_the_official_header_shape() {
        let header = NeoBlockHeader::from_wire(1, [2; 32], [0; 32], 3, 4, 5, 6, [7; 20]).unwrap();
        let block = NeoBlock::new(header, Vec::new()).unwrap();
        assert_eq!(block.unsigned().len(), 109);
        assert_eq!(&block.unsigned()[0..4], &1u32.to_le_bytes());
        assert_eq!(block.unsigned()[88], 6);
        assert_eq!(&block.unsigned()[89..], &[7; 20]);

        let rooted = NeoBlockHeader::from_wire_with_state_root(
            1,
            [2; 32],
            [0; 32],
            3,
            4,
            5,
            6,
            [7; 20],
            Some([8; 32]),
            true,
        )
        .unwrap();
        let rooted = NeoBlock::new(rooted, Vec::new()).unwrap();
        assert_eq!(rooted.unsigned().len(), 141);
        assert_eq!(&rooted.unsigned()[109..], &[8; 32]);

        assert_eq!(
            NeoBlockHeader::from_wire_with_state_root(
                0, [0; 32], [0; 32], 0, 0, 0, 0, [0; 20], None, true,
            ),
            Err(BlockError::MissingStateRoot)
        );
        assert_eq!(
            NeoBlockHeader::from_wire_with_state_root(
                0,
                [0; 32],
                [0; 32],
                0,
                0,
                0,
                0,
                [0; 20],
                Some([0; 32]),
                false,
            ),
            Err(BlockError::UnexpectedStateRoot)
        );

        assert_eq!(
            NeoBlockHeader::from_wire(0, [0; 32], [0; 32], 0, 0, 0, 256, [0; 20]),
            Err(BlockError::PrimaryIndex)
        );
        let wrong = NeoBlockHeader::from_wire(0, [0; 32], [9; 32], 0, 0, 0, 0, [0; 20]).unwrap();
        assert_eq!(
            NeoBlock::new(wrong, Vec::new()),
            Err(BlockError::MerkleRootMismatch)
        );
    }
}
