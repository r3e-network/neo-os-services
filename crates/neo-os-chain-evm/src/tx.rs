//! Strict, read-only EIP-1559 transaction decoding for post-custody validation.
//! This crate never signs: the decoder lets an untrusted orchestration process
//! prove that custody signed the exact chain, nonce, fee, target and calldata
//! it asked the measured service to construct.

use k256::ecdsa::{RecoveryId, Signature, VerifyingKey};
use rlp::{Rlp, RlpStream};
use sha3::{Digest, Keccak256};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignedEip1559 {
    pub chain_id: u64,
    pub nonce: u64,
    pub max_priority_fee_per_gas: u128,
    pub max_fee_per_gas: u128,
    pub gas_limit: u64,
    pub to: [u8; 20],
    pub value: [u8; 32],
    pub data: Vec<u8>,
    pub y_parity: u8,
    pub r: Vec<u8>,
    pub s: Vec<u8>,
    /// Keccak-256 of `0x02 || rlp(unsigned_fields)`.
    pub signing_hash: [u8; 32],
    /// Sender recovered from `(signing_hash, r, s, y_parity)`.
    pub from: [u8; 20],
    pub tx_hash: String,
}

/// Exact unsigned transaction handed to custody `/sign/transaction`.
/// Access lists are intentionally empty for the oracle/feed lanes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnsignedEip1559 {
    pub chain_id: u64,
    pub nonce: u64,
    pub max_priority_fee_per_gas: u128,
    pub max_fee_per_gas: u128,
    pub gas_limit: u64,
    pub to: [u8; 20],
    pub value: [u8; 32],
    pub data: Vec<u8>,
}

impl UnsignedEip1559 {
    pub fn encode(&self) -> Vec<u8> {
        let mut stream = RlpStream::new_list(9);
        stream.append(&self.chain_id);
        stream.append(&self.nonce);
        stream.append(&self.max_priority_fee_per_gas);
        stream.append(&self.max_fee_per_gas);
        stream.append(&self.gas_limit);
        stream.append(&self.to.as_slice());
        stream.append(&minimal_quantity(&self.value));
        stream.append(&self.data.as_slice());
        stream.begin_list(0);
        let mut encoded = vec![0x02];
        encoded.extend_from_slice(&stream.out());
        encoded
    }

    pub fn encode_hex(&self) -> String {
        format!("0x{}", hex_lower(&self.encode()))
    }

    pub fn signing_hash(&self) -> [u8; 32] {
        Keccak256::digest(self.encode()).into()
    }
}

pub fn decode_signed_eip1559(signed_hex: &str) -> Result<SignedEip1559, String> {
    let raw = signed_hex
        .trim()
        .strip_prefix("0x")
        .or_else(|| signed_hex.trim().strip_prefix("0X"))
        .unwrap_or(signed_hex.trim());
    if raw.is_empty() || !raw.len().is_multiple_of(2) {
        return Err("signed EIP-1559 transaction must be even-length hex".into());
    }
    let bytes = decode_hex(raw)?;
    if bytes.first() != Some(&0x02) {
        return Err("custody returned a non-EIP-1559 transaction".into());
    }
    let payload = bytes
        .get(1..)
        .ok_or_else(|| "signed EIP-1559 transaction is truncated".to_string())?;
    let rlp = Rlp::new(payload);
    if !rlp.is_list()
        || rlp.item_count().ok() != Some(12)
        || rlp.payload_info().ok().map(|info| info.total()) != Some(payload.len())
    {
        return Err("signed EIP-1559 transaction is not one canonical 12-field list".into());
    }
    let chain_id = quantity_u64(&rlp, 0, "chain id")?;
    let nonce = quantity_u64(&rlp, 1, "nonce")?;
    let max_priority_fee_per_gas = quantity_u128(&rlp, 2, "priority fee")?;
    let max_fee_per_gas = quantity_u128(&rlp, 3, "max fee")?;
    let gas_limit = quantity_u64(&rlp, 4, "gas limit")?;
    if max_priority_fee_per_gas > max_fee_per_gas {
        return Err("EIP-1559 priority fee exceeds max fee".into());
    }
    let to_bytes = rlp
        .at(5)
        .ok()
        .and_then(|item| item.data().ok())
        .ok_or_else(|| "EIP-1559 target is malformed".to_string())?;
    let to: [u8; 20] = to_bytes
        .try_into()
        .map_err(|_| "EIP-1559 target must be a 20-byte address".to_string())?;
    let value = left_padded_word(field_bytes(&rlp, 6, "value")?, "value")?;
    let data = field_bytes(&rlp, 7, "calldata")?.to_vec();
    let access_list = rlp
        .at(8)
        .map_err(|_| "EIP-1559 access list is malformed".to_string())?;
    if !access_list.is_list() || access_list.item_count().ok() != Some(0) {
        return Err("feed transactions require an empty EIP-1559 access list".into());
    }
    let y_parity = quantity_u64(&rlp, 9, "signature parity")?;
    if y_parity > 1 {
        return Err("EIP-1559 signature parity must be 0 or 1".into());
    }
    let r = signature_scalar(&rlp, 10, "r")?;
    let s = signature_scalar(&rlp, 11, "s")?;
    let signing_hash = eip1559_signing_hash(
        chain_id,
        nonce,
        max_priority_fee_per_gas,
        max_fee_per_gas,
        gas_limit,
        &to,
        &value,
        &data,
    );
    let from = recover_sender(&signing_hash, y_parity as u8, &r, &s)?;
    Ok(SignedEip1559 {
        chain_id,
        nonce,
        max_priority_fee_per_gas,
        max_fee_per_gas,
        gas_limit,
        to,
        value,
        data,
        y_parity: y_parity as u8,
        r,
        s,
        signing_hash,
        from,
        tx_hash: format!("0x{}", hex_lower(&Keccak256::digest(&bytes))),
    })
}

#[allow(clippy::too_many_arguments)]
fn eip1559_signing_hash(
    chain_id: u64,
    nonce: u64,
    max_priority_fee_per_gas: u128,
    max_fee_per_gas: u128,
    gas_limit: u64,
    to: &[u8; 20],
    value: &[u8; 32],
    data: &[u8],
) -> [u8; 32] {
    let mut stream = RlpStream::new_list(9);
    stream.append(&chain_id);
    stream.append(&nonce);
    stream.append(&max_priority_fee_per_gas);
    stream.append(&max_fee_per_gas);
    stream.append(&gas_limit);
    stream.append(&to.as_slice());
    stream.append(&minimal_quantity(value));
    stream.append(&data);
    stream.begin_list(0);
    let mut unsigned = vec![0x02];
    unsigned.extend_from_slice(&stream.out());
    Keccak256::digest(unsigned).into()
}

fn recover_sender(
    signing_hash: &[u8; 32],
    y_parity: u8,
    r: &[u8],
    s: &[u8],
) -> Result<[u8; 20], String> {
    let mut r_word = [0u8; 32];
    let mut s_word = [0u8; 32];
    r_word[32 - r.len()..].copy_from_slice(r);
    s_word[32 - s.len()..].copy_from_slice(s);
    let signature = Signature::from_scalars(r_word, s_word)
        .map_err(|_| "EIP-1559 signature scalar is outside secp256k1".to_string())?;
    if signature.normalize_s().is_some() {
        return Err("EIP-1559 signature must use canonical low-S form".to_string());
    }
    let recovery_id = RecoveryId::from_byte(y_parity)
        .ok_or_else(|| "EIP-1559 signature parity is invalid".to_string())?;
    let key = VerifyingKey::recover_from_prehash(signing_hash, &signature, recovery_id)
        .map_err(|_| "EIP-1559 signature does not recover a sender".to_string())?;
    let public_key = key.to_encoded_point(false);
    let hash = Keccak256::digest(&public_key.as_bytes()[1..]);
    Ok(hash[12..].try_into().expect("20-byte EVM address"))
}

fn minimal_quantity(word: &[u8; 32]) -> &[u8] {
    let first = word
        .iter()
        .position(|byte| *byte != 0)
        .unwrap_or(word.len());
    &word[first..]
}

fn field_bytes<'a>(rlp: &'a Rlp<'a>, index: usize, label: &str) -> Result<&'a [u8], String> {
    rlp.at(index)
        .ok()
        .and_then(|item| item.data().ok())
        .ok_or_else(|| format!("EIP-1559 {label} is malformed"))
}

fn quantity_u64(rlp: &Rlp<'_>, index: usize, label: &str) -> Result<u64, String> {
    let bytes = field_bytes(rlp, index, label)?;
    if bytes.len() > 8 || (bytes.len() > 1 && bytes[0] == 0) {
        return Err(format!("EIP-1559 {label} is not a canonical u64"));
    }
    let mut word = [0u8; 8];
    word[8 - bytes.len()..].copy_from_slice(bytes);
    Ok(u64::from_be_bytes(word))
}

fn quantity_u128(rlp: &Rlp<'_>, index: usize, label: &str) -> Result<u128, String> {
    let bytes = field_bytes(rlp, index, label)?;
    if bytes.len() > 16 || (bytes.len() > 1 && bytes[0] == 0) {
        return Err(format!("EIP-1559 {label} is not a canonical u128"));
    }
    let mut word = [0u8; 16];
    word[16 - bytes.len()..].copy_from_slice(bytes);
    Ok(u128::from_be_bytes(word))
}

fn left_padded_word(bytes: &[u8], label: &str) -> Result<[u8; 32], String> {
    if bytes.len() > 32 || (bytes.len() > 1 && bytes[0] == 0) {
        return Err(format!("EIP-1559 {label} is not a canonical uint256"));
    }
    let mut word = [0u8; 32];
    word[32 - bytes.len()..].copy_from_slice(bytes);
    Ok(word)
}

fn signature_scalar(rlp: &Rlp<'_>, index: usize, label: &str) -> Result<Vec<u8>, String> {
    let value = field_bytes(rlp, index, label)?;
    if value.is_empty()
        || value.len() > 32
        || value.iter().all(|byte| *byte == 0)
        || (value.len() > 1 && value[0] == 0)
    {
        return Err(format!("EIP-1559 signature {label} is invalid"));
    }
    Ok(value.to_vec())
}

fn decode_hex(raw: &str) -> Result<Vec<u8>, String> {
    (0..raw.len())
        .step_by(2)
        .map(|index| {
            u8::from_str_radix(&raw[index..index + 2], 16)
                .map_err(|_| "signed EIP-1559 transaction contains non-hex bytes".to_string())
        })
        .collect()
}

fn hex_lower(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use k256::ecdsa::SigningKey;
    use rlp::RlpStream;

    use super::*;

    #[test]
    fn decodes_and_hashes_one_signed_feed_transaction() {
        let mut unsigned = RlpStream::new_list(9);
        unsigned.append(&12_227_332u64);
        unsigned.append(&7u64);
        unsigned.append(&2u128);
        unsigned.append(&10u128);
        unsigned.append(&200_000u64);
        unsigned.append(&[0x11u8; 20].as_slice());
        unsigned.append_empty_data();
        unsigned.append(&[0xaa, 0xbb].as_slice());
        unsigned.begin_list(0);
        let mut signing_payload = vec![0x02];
        signing_payload.extend_from_slice(&unsigned.out());
        let signing_hash: [u8; 32] = Keccak256::digest(&signing_payload).into();
        let key = SigningKey::from_slice(&[9u8; 32]).unwrap();
        let (signature, recovery_id) = key.sign_prehash_recoverable(&signing_hash).unwrap();

        let mut stream = RlpStream::new_list(12);
        stream.append(&12_227_332u64);
        stream.append(&7u64);
        stream.append(&2u128);
        stream.append(&10u128);
        stream.append(&200_000u64);
        stream.append(&[0x11u8; 20].as_slice());
        stream.append_empty_data();
        stream.append(&[0xaa, 0xbb].as_slice());
        stream.begin_list(0);
        stream.append(&recovery_id.to_byte());
        stream.append(&minimal_quantity(&signature.r().to_bytes().into()));
        stream.append(&minimal_quantity(&signature.s().to_bytes().into()));
        let mut raw = vec![0x02];
        raw.extend_from_slice(&stream.out());
        let decoded = decode_signed_eip1559(&format!("0x{}", hex_lower(&raw))).expect("tx");
        assert_eq!(decoded.chain_id, 12_227_332);
        assert_eq!(decoded.nonce, 7);
        assert_eq!(decoded.to, [0x11; 20]);
        assert_eq!(decoded.data, vec![0xaa, 0xbb]);
        assert!(decoded.value.iter().all(|byte| *byte == 0));
        assert_eq!(decoded.signing_hash, signing_hash);
        let public_key = key.verifying_key().to_encoded_point(false);
        let expected_hash = Keccak256::digest(&public_key.as_bytes()[1..]);
        assert_eq!(decoded.from.as_slice(), &expected_hash[12..]);
        assert_eq!(decoded.tx_hash.len(), 66);
    }
}
