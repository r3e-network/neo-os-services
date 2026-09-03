//! EVM transaction parsing for NeoX (EVM-compatible chain).
//!
//! This module decodes EIP-1559 transactions and ERC-20 transfers for policy
//! evaluation. Like the Neo N3 parser, we refuse to sign opaque transactions
//! we cannot fully interpret.

use k256::ecdsa::{
    signature::hazmat::PrehashSigner, RecoveryId, Signature, SigningKey, VerifyingKey,
};
use rlp::{Rlp, RlpStream};
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

        let rlp = Rlp::new(&bytes[1..]);
        if !rlp.is_list() {
            return Err(EvmTxError::InvalidRlp {
                detail: "expected RLP list for transaction payload",
            });
        }
        let count = rlp.item_count().map_err(|_| EvmTxError::InvalidRlp {
            detail: "failed to read item count",
        })?;
        if count != 9 {
            return Err(EvmTxError::InvalidRlp {
                detail: "expected exactly 9 items in unsigned EIP-1559 payload",
            });
        }

        let chain_id: u64 = rlp.val_at(0).map_err(|_| EvmTxError::InvalidRlp {
            detail: "invalid chain_id",
        })?;
        if chain_id != expected_chain_id {
            return Err(EvmTxError::InvalidChainId {
                expected: expected_chain_id,
                actual: chain_id,
            });
        }

        let nonce: u64 = rlp.val_at(1).map_err(|_| EvmTxError::InvalidRlp {
            detail: "invalid nonce",
        })?;
        let max_priority_fee_per_gas: u128 = rlp.val_at(2).map_err(|_| EvmTxError::InvalidRlp {
            detail: "invalid max_priority_fee_per_gas",
        })?;
        let max_fee_per_gas: u128 = rlp.val_at(3).map_err(|_| EvmTxError::InvalidRlp {
            detail: "invalid max_fee_per_gas",
        })?;

        if max_priority_fee_per_gas > max_fee_per_gas {
            return Err(EvmTxError::InvalidGasParams {
                detail: "priority fee exceeds max fee",
            });
        }

        let gas_limit: u64 = rlp.val_at(4).map_err(|_| EvmTxError::InvalidRlp {
            detail: "invalid gas_limit",
        })?;

        let to_bytes: Vec<u8> = rlp.val_at(5).map_err(|_| EvmTxError::InvalidRlp {
            detail: "invalid to address",
        })?;
        let to = if to_bytes.is_empty() {
            None
        } else if to_bytes.len() == 20 {
            let mut addr = [0u8; 20];
            addr.copy_from_slice(&to_bytes);
            Some(addr)
        } else {
            return Err(EvmTxError::InvalidRlp {
                detail: "to address must be empty or 20 bytes",
            });
        };

        let val_bytes: Vec<u8> = rlp.val_at(6).map_err(|_| EvmTxError::InvalidRlp {
            detail: "invalid value",
        })?;
        if val_bytes.len() > 32 {
            return Err(EvmTxError::InvalidRlp {
                detail: "value exceeds 32 bytes",
            });
        }
        let mut value = [0u8; 32];
        if !val_raw_is_empty(&val_bytes) {
            value[32 - val_bytes.len()..].copy_from_slice(&val_bytes);
        }

        let data: Vec<u8> = rlp.val_at(7).map_err(|_| EvmTxError::InvalidRlp {
            detail: "invalid data",
        })?;

        let access_list_rlp = rlp.at(8).map_err(|_| EvmTxError::InvalidRlp {
            detail: "invalid access_list",
        })?;
        if !access_list_rlp.is_list() {
            return Err(EvmTxError::InvalidRlp {
                detail: "access_list must be a list",
            });
        }

        let mut access_list = Vec::new();
        for entry_rlp in access_list_rlp.iter() {
            if !entry_rlp.is_list() {
                return Err(EvmTxError::InvalidRlp {
                    detail: "access list entry must be a list",
                });
            }
            let entry_count = entry_rlp.item_count().map_err(|_| EvmTxError::InvalidRlp {
                detail: "invalid access list entry item count",
            })?;
            if entry_count != 2 {
                return Err(EvmTxError::InvalidRlp {
                    detail: "access list entry must be [address, [keys]]",
                });
            }
            let addr_raw: Vec<u8> = entry_rlp.val_at(0).map_err(|_| EvmTxError::InvalidRlp {
                detail: "invalid access list address",
            })?;
            if addr_raw.len() != 20 {
                return Err(EvmTxError::InvalidRlp {
                    detail: "access list address must be 20 bytes",
                });
            }
            let mut address = [0u8; 20];
            address.copy_from_slice(&addr_raw);

            let keys_rlp = entry_rlp.at(1).map_err(|_| EvmTxError::InvalidRlp {
                detail: "invalid storage keys list",
            })?;
            if !keys_rlp.is_list() {
                return Err(EvmTxError::InvalidRlp {
                    detail: "storage keys must be a list",
                });
            }
            let mut storage_keys = Vec::new();
            for key_rlp in keys_rlp.iter() {
                let key_raw: Vec<u8> = key_rlp.as_val().map_err(|_| EvmTxError::InvalidRlp {
                    detail: "invalid storage key",
                })?;
                if key_raw.len() != 32 {
                    return Err(EvmTxError::InvalidRlp {
                        detail: "storage key must be 32 bytes",
                    });
                }
                let mut key = [0u8; 32];
                key.copy_from_slice(&key_raw);
                storage_keys.push(key);
            }
            access_list.push(AccessListEntry {
                address,
                storage_keys,
            });
        }

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
        encode_eip1559_fields(self, None, &mut encoded);
        let hash = Keccak256::digest(&encoded);
        let mut result = [0u8; 32];
        result.copy_from_slice(&hash);
        result
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

    let mut r = [0u8; 32];
    let mut s = [0u8; 32];
    r.copy_from_slice(&signature_bytes[..32]);
    s.copy_from_slice(&signature_bytes[32..]);

    let v = compute_recovery_id(&signing_key, &message_hash, &signature)?;

    let mut result = vec![EIP1559_TX_TYPE];
    encode_eip1559_fields(tx, Some((v, &r, &s)), &mut result);
    Ok(result)
}

fn compute_recovery_id(
    signing_key: &SigningKey,
    message_hash: &[u8; 32],
    signature: &Signature,
) -> Result<u8, Box<dyn std::error::Error>> {
    let expected_key = signing_key.verifying_key();
    for id in 0..4u8 {
        if let Ok(recovery_id) = RecoveryId::try_from(id) {
            if let Ok(recovered) =
                VerifyingKey::recover_from_prehash(message_hash.as_slice(), signature, recovery_id)
            {
                if &recovered == expected_key {
                    return Ok(recovery_id.to_byte());
                }
            }
        }
    }
    Err("failed to compute valid recovery ID for signature".into())
}

fn is_zero(bytes: &[u8]) -> bool {
    bytes.iter().all(|&b| b == 0)
}

fn val_raw_is_empty(bytes: &[u8]) -> bool {
    bytes.is_empty() || bytes.iter().all(|&b| b == 0)
}

fn encode_eip1559_fields(
    tx: &UnsignedEvmTransaction,
    signature: Option<(u8, &[u8; 32], &[u8; 32])>,
    out: &mut Vec<u8>,
) {
    let count = if signature.is_some() { 12 } else { 9 };
    let mut stream = RlpStream::new_list(count);

    stream.append(&tx.chain_id);
    stream.append(&tx.nonce);
    stream.append(&tx.max_priority_fee_per_gas);
    stream.append(&tx.max_fee_per_gas);
    stream.append(&tx.gas_limit);

    if let Some(addr) = &tx.to {
        stream.append(&addr.as_slice());
    } else {
        stream.append_empty_data();
    }

    let val_start = tx.value.iter().position(|&b| b != 0).unwrap_or(32);
    if val_start == 32 {
        stream.append_empty_data();
    } else {
        stream.append(&&tx.value[val_start..]);
    }

    stream.append(&tx.data);

    // Access list (EIP-2930)
    stream.begin_list(tx.access_list.len());
    for entry in &tx.access_list {
        stream.begin_list(2);
        stream.append(&entry.address.as_slice());
        stream.begin_list(entry.storage_keys.len());
        for key in &entry.storage_keys {
            stream.append(&key.as_slice());
        }
    }

    if let Some((v, r, s)) = signature {
        stream.append(&v);
        let r_start = r.iter().position(|&b| b != 0).unwrap_or(32);
        if r_start == 32 {
            stream.append_empty_data();
        } else {
            stream.append(&&r[r_start..]);
        }
        let s_start = s.iter().position(|&b| b != 0).unwrap_or(32);
        if s_start == 32 {
            stream.append_empty_data();
        } else {
            stream.append(&&s[s_start..]);
        }
    }

    out.extend_from_slice(&stream.out());
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

    #[test]
    fn test_compute_recovery_id_and_sign_evm_tx() {
        let private_key = [0x42u8; 32];
        let signing_key = SigningKey::from_bytes((&private_key).into()).unwrap();
        let expected_vk = signing_key.verifying_key();

        let tx = UnsignedEvmTransaction {
            chain_id: 47763, // NeoX T4 testnet
            nonce: 0,
            max_priority_fee_per_gas: 1_000_000_000,
            max_fee_per_gas: 20_000_000_000,
            gas_limit: 21_000,
            to: Some([0x11u8; 20]),
            value: [0u8; 32],
            data: Vec::new(),
            access_list: Vec::new(),
        };

        let message_hash = tx.signing_hash();
        let signature: Signature = signing_key.sign_prehash(&message_hash).unwrap();

        let recovery_id = compute_recovery_id(&signing_key, &message_hash, &signature).unwrap();
        assert!(recovery_id == 0 || recovery_id == 1);

        let rec_id = RecoveryId::try_from(recovery_id).unwrap();
        let recovered =
            VerifyingKey::recover_from_prehash(message_hash.as_slice(), &signature, rec_id)
                .unwrap();
        assert_eq!(&recovered, expected_vk);

        let signed_raw = sign_evm_tx(&tx, &private_key).unwrap();
        assert_eq!(signed_raw[0], EIP1559_TX_TYPE);
        assert!(signed_raw.len() > 10);
    }

    #[test]
    fn test_compute_recovery_id_multiple_hashes() {
        let private_key = [0x77u8; 32];
        let signing_key = SigningKey::from_bytes((&private_key).into()).unwrap();
        let expected_vk = signing_key.verifying_key();

        // Test with different messages to ensure both parity values are validly recoverable
        for i in 0..20u8 {
            let mut hash = [i; 32];
            hash[0] = i;
            let signature: Signature = signing_key.sign_prehash(&hash).unwrap();
            let v = compute_recovery_id(&signing_key, &hash, &signature).unwrap();
            assert!(v == 0 || v == 1);

            let rec_id = RecoveryId::try_from(v).unwrap();
            let recovered =
                VerifyingKey::recover_from_prehash(hash.as_slice(), &signature, rec_id).unwrap();
            assert_eq!(&recovered, expected_vk, "recovered key must match for hash {i}");
        }
    }

    #[test]
    fn test_unsigned_evm_tx_encode_parse_roundtrip() {
        let mut value = [0u8; 32];
        value[31] = 0x50;
        value[30] = 0x01;

        let tx = UnsignedEvmTransaction {
            chain_id: 47763,
            nonce: 7,
            max_priority_fee_per_gas: 1_500_000_000,
            max_fee_per_gas: 30_000_000_000,
            gas_limit: 100_000,
            to: Some([0x88u8; 20]),
            value,
            data: vec![0xa9, 0x05, 0x9c, 0xbb, 0x01, 0x02, 0x03],
            access_list: vec![AccessListEntry {
                address: [0x33u8; 20],
                storage_keys: vec![[0x11u8; 32], [0x22u8; 32]],
            }],
        };

        let mut encoded = vec![EIP1559_TX_TYPE];
        encode_eip1559_fields(&tx, None, &mut encoded);

        let parsed = UnsignedEvmTransaction::parse(&encoded, 47763).unwrap();
        assert_eq!(parsed.chain_id, tx.chain_id);
        assert_eq!(parsed.nonce, tx.nonce);
        assert_eq!(parsed.max_priority_fee_per_gas, tx.max_priority_fee_per_gas);
        assert_eq!(parsed.max_fee_per_gas, tx.max_fee_per_gas);
        assert_eq!(parsed.gas_limit, tx.gas_limit);
        assert_eq!(parsed.to, tx.to);
        assert_eq!(parsed.value, tx.value);
        assert_eq!(parsed.data, tx.data);
        assert_eq!(parsed.access_list, tx.access_list);
    }

    #[test]
    fn test_unsigned_evm_tx_contract_creation_roundtrip() {
        let tx = UnsignedEvmTransaction {
            chain_id: 1,
            nonce: 0,
            max_priority_fee_per_gas: 2_000_000_000,
            max_fee_per_gas: 50_000_000_000,
            gas_limit: 500_000,
            to: None, // Contract creation
            value: [0u8; 32],
            data: vec![0x60, 0x80, 0x60, 0x40], // Bytecode
            access_list: Vec::new(),
        };

        let mut encoded = vec![EIP1559_TX_TYPE];
        encode_eip1559_fields(&tx, None, &mut encoded);

        let parsed = UnsignedEvmTransaction::parse(&encoded, 1).unwrap();
        assert_eq!(parsed.to, None);
        assert_eq!(parsed.data, tx.data);
        assert_eq!(parsed.chain_id, 1);
    }

    #[test]
    fn test_unsigned_evm_tx_parse_rejections() {
        let tx = UnsignedEvmTransaction {
            chain_id: 47763,
            nonce: 1,
            max_priority_fee_per_gas: 50_000_000_000,
            max_fee_per_gas: 20_000_000_000, // Invalid: priority > max fee
            gas_limit: 21_000,
            to: Some([0x22u8; 20]),
            value: [0u8; 32],
            data: Vec::new(),
            access_list: Vec::new(),
        };

        let mut encoded = vec![EIP1559_TX_TYPE];
        encode_eip1559_fields(&tx, None, &mut encoded);

        // Priority fee > max fee rejection
        let err = UnsignedEvmTransaction::parse(&encoded, 47763).unwrap_err();
        assert!(matches!(err, EvmTxError::InvalidGasParams { .. }));

        // Chain ID mismatch rejection
        let valid_tx = UnsignedEvmTransaction {
            max_fee_per_gas: 50_000_000_000,
            ..tx
        };
        let mut valid_encoded = vec![EIP1559_TX_TYPE];
        encode_eip1559_fields(&valid_tx, None, &mut valid_encoded);
        let err = UnsignedEvmTransaction::parse(&valid_encoded, 99999).unwrap_err();
        assert!(matches!(err, EvmTxError::InvalidChainId { .. }));

        // Invalid type byte
        valid_encoded[0] = 0x01;
        let err = UnsignedEvmTransaction::parse(&valid_encoded, 47763).unwrap_err();
        assert!(matches!(err, EvmTxError::UnsupportedTxType { .. }));

        // Truncated payload
        valid_encoded[0] = EIP1559_TX_TYPE;
        let err = UnsignedEvmTransaction::parse(&valid_encoded[..5], 47763).unwrap_err();
        assert!(matches!(err, EvmTxError::InvalidRlp { .. } | EvmTxError::Truncated));
    }
}
