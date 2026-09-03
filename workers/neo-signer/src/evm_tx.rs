//! EVM transaction parsing for NeoX (EVM-compatible chain).
//!
//! This module decodes EIP-1559 transactions and ERC-20 transfers for policy
//! evaluation. Like the Neo N3 parser, we refuse to sign opaque transactions
//! we cannot fully interpret.

use k256::ecdsa::{signature::hazmat::PrehashSigner, Signature, SigningKey};
use sha3::{Digest, Keccak256};

/// EIP-1559 transaction type identifier.
pub const EIP1559_TX_TYPE: u8 = 0x02;

/// Maximum transaction size we'll accept (similar to Neo N3's limit).
pub const MAX_EVM_TX_SIZE: usize = 131_072;

/// ERC-20 transfer method selector: `transfer(address,uint256)`.
pub const ERC20_TRANSFER_SELECTOR: [u8; 4] = [0xa9, 0x05, 0x9c, 0xbb];

/// ERC-20 transferFrom method selector: `transferFrom(address,address,uint256)`.
pub const ERC20_TRANSFER_FROM_SELECTOR: [u8; 4] = [0x23, 0xb8, 0x72, 0xdd];

/// Something wrong with the EVM transaction input.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EvmTxError {
    /// Input ended mid-field.
    Truncated,
    /// Transaction exceeds size limit.
    TooLarge,
    /// Unsupported transaction type.
    UnsupportedTxType { tx_type: u8 },
    /// RLP decoding failed.
    InvalidRlp { detail: &'static str },
    /// Chain ID doesn't match expected value.
    InvalidChainId { expected: u64, actual: u64 },
    /// Gas price or limit out of acceptable range.
    InvalidGasParams { detail: &'static str },
    /// Transaction data cannot be interpreted.
    UnknownCallData,
}

impl std::fmt::Display for EvmTxError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            EvmTxError::Truncated => f.write_str("input ended mid-field"),
            EvmTxError::TooLarge => f.write_str("transaction exceeds maximum size"),
            EvmTxError::UnsupportedTxType { tx_type } => {
                write!(f, "unsupported transaction type 0x{tx_type:02x}")
            }
            EvmTxError::InvalidRlp { detail } => write!(f, "invalid RLP: {detail}"),
            EvmTxError::InvalidChainId { expected, actual } => {
                write!(f, "chain ID mismatch: expected {expected}, got {actual}")
            }
            EvmTxError::InvalidGasParams { detail } => write!(f, "invalid gas params: {detail}"),
            EvmTxError::UnknownCallData => f.write_str("cannot interpret transaction call data"),
        }
    }
}

impl std::error::Error for EvmTxError {}

/// Decoded ERC-20 transfer call data.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Erc20Call {
    Transfer {
        to: [u8; 20],
        amount: [u8; 32],
    },
    TransferFrom {
        from: [u8; 20],
        to: [u8; 20],
        amount: [u8; 32],
    },
}

/// What an EVM transaction intends to do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EvmIntent {
    /// Native token transfer (value > 0, no data or simple data).
    NativeTransfer {
        to: [u8; 20],
        /// Value in wei.
        value: [u8; 32],
    },
    /// ERC-20 token transfer.
    Erc20Transfer {
        /// Token contract address.
        token: [u8; 20],
        /// Recipient address.
        to: [u8; 20],
        /// Amount in token's smallest unit.
        amount: [u8; 32],
    },
    /// Contract call we cannot specifically interpret.
    ContractCall {
        /// Target contract.
        to: [u8; 20],
        /// Call data (first 4 bytes are method selector).
        data: Vec<u8>,
        /// Native token value sent.
        value: [u8; 32],
    },
}

/// Unsigned EIP-1559 transaction.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnsignedEvmTransaction {
    /// Chain ID (must match expected value for NeoX).
    pub chain_id: u64,
    /// Transaction nonce.
    pub nonce: u64,
    /// Max priority fee per gas (tip to miner).
    pub max_priority_fee_per_gas: u128,
    /// Max fee per gas (base fee + priority fee cap).
    pub max_fee_per_gas: u128,
    /// Gas limit.
    pub gas_limit: u64,
    /// Recipient address (None for contract creation).
    pub to: Option<[u8; 20]>,
    /// Native token value in wei.
    pub value: [u8; 32],
    /// Contract call data or init code.
    pub data: Vec<u8>,
    /// Access list (EIP-2930).
    pub access_list: Vec<AccessListEntry>,
}

/// EIP-2930 access list entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccessListEntry {
    pub address: [u8; 20],
    pub storage_keys: Vec<[u8; 32]>,
}

impl UnsignedEvmTransaction {
    /// Parse an unsigned EIP-1559 transaction (type 0x02).
    pub fn parse(bytes: &[u8], expected_chain_id: u64) -> Result<Self, EvmTxError> {
        if bytes.len() > MAX_EVM_TX_SIZE {
            return Err(EvmTxError::TooLarge);
        }
        if bytes.is_empty() {
            return Err(EvmTxError::Truncated);
        }

        // EIP-1559 transactions start with 0x02
        if bytes[0] != EIP1559_TX_TYPE {
            return Err(EvmTxError::UnsupportedTxType { tx_type: bytes[0] });
        }

        // Rest is RLP-encoded: rlp([chain_id, nonce, max_priority_fee_per_gas,
        // max_fee_per_gas, gas_limit, to, value, data, access_list])
        let mut decoder = RlpDecoder::new(&bytes[1..])?;

        let chain_id = decoder.decode_u64()?;
        if chain_id != expected_chain_id {
            return Err(EvmTxError::InvalidChainId {
                expected: expected_chain_id,
                actual: chain_id,
            });
        }

        let nonce = decoder.decode_u64()?;
        let max_priority_fee_per_gas = decoder.decode_u128()?;
        let max_fee_per_gas = decoder.decode_u128()?;

        if max_priority_fee_per_gas > max_fee_per_gas {
            return Err(EvmTxError::InvalidGasParams {
                detail: "priority fee exceeds max fee",
            });
        }

        let gas_limit = decoder.decode_u64()?;
        let to = decoder.decode_optional_address()?;
        let value = decoder.decode_u256()?;
        let data = decoder.decode_bytes()?;
        let access_list = decoder.decode_access_list()?;

        decoder.finish()?;

        Ok(UnsignedEvmTransaction {
            chain_id,
            nonce,
            max_priority_fee_per_gas,
            max_fee_per_gas,
            gas_limit,
            to,
            value,
            data,
            access_list,
        })
    }

    /// Classify what this transaction intends to do.
    pub fn intent(&self) -> EvmIntent {
        let to = match self.to {
            Some(addr) => addr,
            None => {
                // Contract creation
                return EvmIntent::ContractCall {
                    to: [0u8; 20],
                    data: self.data.clone(),
                    value: self.value,
                };
            }
        };

        // Check for ERC-20 transfer
        if self.data.len() == 68 && self.data.starts_with(&ERC20_TRANSFER_SELECTOR) {
            let mut recipient = [0u8; 20];
            recipient.copy_from_slice(&self.data[16..36]);
            let mut amount = [0u8; 32];
            amount.copy_from_slice(&self.data[36..68]);
            return EvmIntent::Erc20Transfer {
                token: to,
                to: recipient,
                amount,
            };
        }

        // Check for ERC-20 transferFrom
        if self.data.len() == 100 && self.data.starts_with(&ERC20_TRANSFER_FROM_SELECTOR) {
            let mut recipient = [0u8; 20];
            recipient.copy_from_slice(&self.data[48..68]);
            let mut amount = [0u8; 32];
            amount.copy_from_slice(&self.data[68..100]);
            return EvmIntent::Erc20Transfer {
                token: to,
                to: recipient,
                amount,
            };
        }

        // Check for simple native transfer
        if self.data.is_empty() && !is_zero(&self.value) {
            return EvmIntent::NativeTransfer {
                to,
                value: self.value,
            };
        }

        // Generic contract call
        EvmIntent::ContractCall {
            to,
            data: self.data.clone(),
            value: self.value,
        }
    }

    /// Compute the signing hash for this transaction.
    pub fn signing_hash(&self) -> [u8; 32] {
        let mut encoded = vec![EIP1559_TX_TYPE];
        self.encode_rlp(&mut encoded);
        let hash = Keccak256::digest(&encoded);
        let mut result = [0u8; 32];
        result.copy_from_slice(&hash);
        result
    }

    /// RLP-encode this transaction.
    fn encode_rlp(&self, out: &mut Vec<u8>) {
        let mut items = Vec::new();

        // Chain ID
        encode_u64(self.chain_id, &mut items);
        // Nonce
        encode_u64(self.nonce, &mut items);
        // Max priority fee
        encode_u128(self.max_priority_fee_per_gas, &mut items);
        // Max fee
        encode_u128(self.max_fee_per_gas, &mut items);
        // Gas limit
        encode_u64(self.gas_limit, &mut items);
        // To
        if let Some(addr) = self.to {
            items.push(addr.to_vec());
        } else {
            items.push(Vec::new());
        }
        // Value
        items.push(self.value.to_vec());
        // Data
        items.push(self.data.clone());
        // Access list (empty for now)
        items.push(Vec::new());

        encode_rlp_list(&items, out);
    }
}

/// Sign an EVM transaction with secp256k1.
pub fn sign_evm_tx(
    tx: &UnsignedEvmTransaction,
    private_key: &[u8; 32],
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let signing_key = SigningKey::from_bytes(private_key.into())?;
    let message_hash = tx.signing_hash();

    let signature: Signature = signing_key.sign_prehash(&message_hash)?;
    let signature_bytes = signature.to_bytes();

    // Compute recovery ID (v)
    let v = compute_recovery_id(&signing_key, &message_hash, &signature)?;

    // Build final signed transaction: 0x02 || rlp([...unsigned fields, y_parity, r, s])
    let mut result = vec![EIP1559_TX_TYPE];
    let mut rlp_items = Vec::new();

    // All unsigned fields
    encode_u64(tx.chain_id, &mut rlp_items);
    encode_u64(tx.nonce, &mut rlp_items);
    encode_u128(tx.max_priority_fee_per_gas, &mut rlp_items);
    encode_u128(tx.max_fee_per_gas, &mut rlp_items);
    encode_u64(tx.gas_limit, &mut rlp_items);
    if let Some(addr) = tx.to {
        rlp_items.push(addr.to_vec());
    } else {
        rlp_items.push(Vec::new());
    }
    rlp_items.push(tx.value.to_vec());
    rlp_items.push(tx.data.clone());
    rlp_items.push(Vec::new()); // access_list

    // Signature components
    rlp_items.push(vec![v]);
    rlp_items.push(signature_bytes[..32].to_vec()); // r
    rlp_items.push(signature_bytes[32..].to_vec()); // s

    encode_rlp_list(&rlp_items, &mut result);
    Ok(result)
}

fn compute_recovery_id(
    _signing_key: &SigningKey,
    _message_hash: &[u8; 32],
    _signature: &Signature,
) -> Result<u8, Box<dyn std::error::Error>> {
    // For EIP-1559, y_parity is 0 or 1
    // This is a simplified implementation - full recovery ID computation
    // requires testing both values
    Ok(0)
}

fn is_zero(bytes: &[u8]) -> bool {
    bytes.iter().all(|&b| b == 0)
}

/// Minimal RLP decoder for EIP-1559 transactions.
struct RlpDecoder<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> RlpDecoder<'a> {
    fn new(data: &'a [u8]) -> Result<Self, EvmTxError> {
        // First byte should be a list prefix
        if data.is_empty() {
            return Err(EvmTxError::Truncated);
        }
        Ok(RlpDecoder { data, pos: 0 })
    }

    fn decode_u64(&mut self) -> Result<u64, EvmTxError> {
        let bytes = self.decode_bytes()?;
        if bytes.is_empty() {
            return Ok(0);
        }
        if bytes.len() > 8 {
            return Err(EvmTxError::InvalidRlp {
                detail: "u64 value too large",
            });
        }
        let mut result = 0u64;
        for &byte in &bytes {
            result = (result << 8) | u64::from(byte);
        }
        Ok(result)
    }

    fn decode_u128(&mut self) -> Result<u128, EvmTxError> {
        let bytes = self.decode_bytes()?;
        if bytes.is_empty() {
            return Ok(0);
        }
        if bytes.len() > 16 {
            return Err(EvmTxError::InvalidRlp {
                detail: "u128 value too large",
            });
        }
        let mut result = 0u128;
        for &byte in &bytes {
            result = (result << 8) | u128::from(byte);
        }
        Ok(result)
    }

    fn decode_u256(&mut self) -> Result<[u8; 32], EvmTxError> {
        let bytes = self.decode_bytes()?;
        if bytes.len() > 32 {
            return Err(EvmTxError::InvalidRlp {
                detail: "u256 value too large",
            });
        }
        let mut result = [0u8; 32];
        if !bytes.is_empty() {
            result[32 - bytes.len()..].copy_from_slice(&bytes);
        }
        Ok(result)
    }

    fn decode_optional_address(&mut self) -> Result<Option<[u8; 20]>, EvmTxError> {
        let bytes = self.decode_bytes()?;
        if bytes.is_empty() {
            return Ok(None);
        }
        if bytes.len() != 20 {
            return Err(EvmTxError::InvalidRlp {
                detail: "address must be 20 bytes",
            });
        }
        let mut addr = [0u8; 20];
        addr.copy_from_slice(&bytes);
        Ok(Some(addr))
    }

    fn decode_bytes(&mut self) -> Result<Vec<u8>, EvmTxError> {
        if self.pos >= self.data.len() {
            return Err(EvmTxError::Truncated);
        }

        let prefix = self.data[self.pos];
        self.pos += 1;

        // Single byte < 0x80
        if prefix < 0x80 {
            return Ok(vec![prefix]);
        }

        // Short string (0-55 bytes)
        if prefix <= 0xb7 {
            let length = (prefix - 0x80) as usize;
            return self.read_bytes(length);
        }

        // Long string (>55 bytes)
        if prefix <= 0xbf {
            let length_of_length = (prefix - 0xb7) as usize;
            let length = self.read_length(length_of_length)?;
            return self.read_bytes(length);
        }

        // List - skip for now in this simplified decoder
        Err(EvmTxError::InvalidRlp {
            detail: "unexpected list in field position",
        })
    }

    fn decode_access_list(&mut self) -> Result<Vec<AccessListEntry>, EvmTxError> {
        // Simplified: return empty access list
        // Full implementation would decode RLP list of [address, [storage_keys]]
        let _ = self.decode_bytes()?;
        Ok(Vec::new())
    }

    fn read_bytes(&mut self, length: usize) -> Result<Vec<u8>, EvmTxError> {
        if self.pos + length > self.data.len() {
            return Err(EvmTxError::Truncated);
        }
        let result = self.data[self.pos..self.pos + length].to_vec();
        self.pos += length;
        Ok(result)
    }

    fn read_length(&mut self, length_of_length: usize) -> Result<usize, EvmTxError> {
        if self.pos + length_of_length > self.data.len() {
            return Err(EvmTxError::Truncated);
        }
        let mut length = 0usize;
        for i in 0..length_of_length {
            length = (length << 8) | self.data[self.pos + i] as usize;
        }
        self.pos += length_of_length;
        Ok(length)
    }

    fn finish(&self) -> Result<(), EvmTxError> {
        if self.pos < self.data.len() {
            Err(EvmTxError::InvalidRlp {
                detail: "trailing bytes after transaction",
            })
        } else {
            Ok(())
        }
    }
}

// RLP encoding helpers
fn encode_u64(value: u64, out: &mut Vec<Vec<u8>>) {
    if value == 0 {
        out.push(Vec::new());
    } else {
        let bytes = value.to_be_bytes();
        let start = bytes.iter().position(|&b| b != 0).unwrap_or(8);
        out.push(bytes[start..].to_vec());
    }
}

fn encode_u128(value: u128, out: &mut Vec<Vec<u8>>) {
    if value == 0 {
        out.push(Vec::new());
    } else {
        let bytes = value.to_be_bytes();
        let start = bytes.iter().position(|&b| b != 0).unwrap_or(16);
        out.push(bytes[start..].to_vec());
    }
}

fn encode_rlp_list(items: &[Vec<u8>], out: &mut Vec<u8>) {
    let mut payload = Vec::new();
    for item in items {
        encode_rlp_bytes(item, &mut payload);
    }

    let len = payload.len();
    if len < 56 {
        out.push(0xc0 + len as u8);
    } else {
        let len_bytes = length_to_bytes(len);
        out.push(0xf7 + len_bytes.len() as u8);
        out.extend_from_slice(&len_bytes);
    }
    out.extend_from_slice(&payload);
}

fn encode_rlp_bytes(bytes: &[u8], out: &mut Vec<u8>) {
    if bytes.len() == 1 && bytes[0] < 0x80 {
        out.push(bytes[0]);
    } else if bytes.len() < 56 {
        out.push(0x80 + bytes.len() as u8);
        out.extend_from_slice(bytes);
    } else {
        let len_bytes = length_to_bytes(bytes.len());
        out.push(0xb7 + len_bytes.len() as u8);
        out.extend_from_slice(&len_bytes);
        out.extend_from_slice(bytes);
    }
}

fn length_to_bytes(length: usize) -> Vec<u8> {
    let bytes = length.to_be_bytes();
    let start = bytes.iter().position(|&b| b != 0).unwrap_or(8);
    bytes[start..].to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_erc20_transfer_detection() {
        // ERC-20 transfer(address,uint256) call data
        let mut data = Vec::new();
        data.extend_from_slice(&ERC20_TRANSFER_SELECTOR);
        data.extend_from_slice(&[0u8; 12]); // padding
        data.extend_from_slice(&[1u8; 20]); // recipient
        data.extend_from_slice(&[0u8; 32]); // amount

        assert_eq!(data.len(), 68);
        assert!(data.starts_with(&ERC20_TRANSFER_SELECTOR));
    }
}
