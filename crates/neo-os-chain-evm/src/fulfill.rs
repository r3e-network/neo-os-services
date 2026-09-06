//! NeoX fulfillment digest, EIP-191 signing seam, revert normalization, and
//! the confidential-envelope decoders. Ported from neox.js
//! (`buildNeoXDigest` / `signNeoXFulfillment` / `normalizeNeoXRevert` /
//! `decodeConfidentialEnvelope` / `decodeConfidentialMessageId`).
//!
//! Digest parity is pinned by `tests/vectors/neox_digest.json` (8 cases
//! harvested from ethers). Private-key signing stays behind the semantic
//! custody endpoint; this module recomputes its prehash and recovers the
//! returned verifier identity independently.

use k256::ecdsa::{RecoveryId, Signature, VerifyingKey};
use sha3::{Digest, Keccak256};

use crate::abi::{abi_decode_uint256_bytes, AbiValue};

pub const FULFILLMENT_DOMAIN: &str = "morpheus-evm-fulfillment-v1";
/// Status enum on the kernel: None=0, Pending=1, Succeeded=2, Failed=3.
pub const STATUS_PENDING: u64 = 1;

/// keccak256 re-export for the signing seam.
pub fn keccak256(bytes: &[u8]) -> [u8; 32] {
    Keccak256::digest(bytes).into()
}

/// The fulfillment fields that feed the digest.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fulfillment {
    pub request_id: String,
    pub app_id: String,
    pub module_id: String,
    pub operation: String,
    pub success: bool,
    pub error: String,
}

/// buildNeoXDigest: `keccak256(abi.encode(domain, chainId, oracleContract,
/// requestId, keccak256(appId), keccak256(moduleId), keccak256(operation),
/// success, keccak256(resultBytes), keccak256(error)))` — bound to
/// chain + contract so a signature cannot be replayed across deployments.
pub fn build_neox_digest(
    chain_id: u64,
    oracle_contract: &str,
    fulfillment: &Fulfillment,
    result_bytes_hex: &str,
) -> Result<[u8; 32], crate::abi::AbiError> {
    let contract_bytes = hex_to_20(oracle_contract)
        .ok_or_else(|| crate::abi::AbiError("invalid oracle contract address".into()))?;
    let request_id = hex_string_to_be_u256(&fulfillment.request_id).ok_or_else(|| {
        crate::abi::AbiError(format!("invalid requestId {}", fulfillment.request_id))
    })?;
    let result_bytes = decode_hex_strict(result_bytes_hex).ok_or_else(|| {
        crate::abi::AbiError("result bytes must be even-length hexadecimal".into())
    })?;
    let mut contract_word = [0u8; 32];
    contract_word[12..].copy_from_slice(&contract_bytes);

    let encoded = crate::abi::abi_encode(&[
        AbiValue::String(FULFILLMENT_DOMAIN.to_string()),
        AbiValue::Uint256(request_id_chain_word(chain_id)),
        AbiValue::Uint256(contract_word),
        AbiValue::Uint256(request_id),
        AbiValue::Uint256(keccak256(fulfillment.app_id.as_bytes())),
        AbiValue::Uint256(keccak256(fulfillment.module_id.as_bytes())),
        AbiValue::Uint256(keccak256(fulfillment.operation.as_bytes())),
        AbiValue::Bool(fulfillment.success),
        AbiValue::Uint256(keccak256(&result_bytes)),
        AbiValue::Uint256(keccak256(fulfillment.error.as_bytes())),
    ])?;
    Ok(keccak256(&encoded))
}

/// Encode the exact MorpheusOracleEVM updater call:
/// `fulfillRequest(uint256,bool,bytes,string,bytes)`.
///
/// The verification signature is the verifier key's EIP-191 `(r,s,v)` value;
/// it is calldata only. The updater transaction itself is signed separately by
/// its own custody key.
pub fn encode_fulfill_request_calldata(
    request_id: &str,
    success: bool,
    result_bytes_hex: &str,
    error: &str,
    verification_signature_hex: &str,
) -> Result<Vec<u8>, crate::abi::AbiError> {
    let request_id = hex_string_to_be_u256(request_id)
        .ok_or_else(|| crate::abi::AbiError("invalid fulfillment request id".into()))?;
    let result = decode_hex_strict(result_bytes_hex).ok_or_else(|| {
        crate::abi::AbiError("result bytes must be even-length hexadecimal".into())
    })?;
    let signature = decode_hex_strict(verification_signature_hex)
        .ok_or_else(|| crate::abi::AbiError("verification signature must be hexadecimal".into()))?;
    if signature.len() != 65 || !matches!(signature[64], 27 | 28) {
        return Err(crate::abi::AbiError(
            "verification signature must be 65-byte EIP-191 r||s||v with v 27 or 28".into(),
        ));
    }
    let mut calldata = keccak256(b"fulfillRequest(uint256,bool,bytes,string,bytes)")[..4].to_vec();
    calldata.extend_from_slice(&crate::abi::abi_encode(&[
        AbiValue::Uint256(request_id),
        AbiValue::Bool(success),
        AbiValue::Bytes(result),
        AbiValue::String(error.to_string()),
        AbiValue::Bytes(signature),
    ])?);
    Ok(calldata)
}

fn decode_hex_strict(text: &str) -> Option<Vec<u8>> {
    let raw = text
        .trim()
        .strip_prefix("0x")
        .or_else(|| text.trim().strip_prefix("0X"))
        .unwrap_or(text.trim());
    if !raw.len().is_multiple_of(2) || !raw.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    (0..raw.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&raw[index..index + 2], 16).ok())
        .collect()
}

fn request_id_chain_word(chain_id: u64) -> [u8; 32] {
    let mut word = [0u8; 32];
    word[24..].copy_from_slice(&chain_id.to_be_bytes());
    word
}

fn hex_to_20(value: &str) -> Option<[u8; 20]> {
    let raw = value.trim().strip_prefix("0x").unwrap_or(value.trim());
    if raw.len() != 40 {
        return None;
    }
    let mut out = [0u8; 20];
    for (index, pair) in raw.as_bytes().chunks(2).enumerate() {
        let high = (pair[0] as char).to_digit(16)? as u8;
        let low = (pair[1] as char).to_digit(16)? as u8;
        out[index] = (high << 4) | low;
    }
    Some(out)
}

/// A decimal-string uint256 (JS BigInt.toString()) as a 32-byte BE word.
fn hex_string_to_be_u256(decimal: &str) -> Option<[u8; 32]> {
    let trimmed = decimal.trim();
    if let Some(hex) = trimmed
        .strip_prefix("0x")
        .or_else(|| trimmed.strip_prefix("0X"))
    {
        if hex.len() > 64 {
            return None;
        }
        let mut out = [0u8; 32];
        let offset = 64 - hex.len();
        for (i, ch) in hex.chars().enumerate() {
            let val = ch.to_digit(16)? as u8;
            let byte_idx = (offset + i) / 2;
            if (offset + i) % 2 == 0 {
                out[byte_idx] |= val << 4;
            } else {
                out[byte_idx] |= val;
            }
        }
        return Some(out);
    }
    if trimmed.is_empty() || !trimmed.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    // Schoolbook: repeatedly multiply the accumulated bytes by 10 and add.
    let mut bytes = vec![0u8; 32];
    for digit in trimmed.bytes() {
        let mut carry = (digit - b'0') as u32;
        for byte in bytes.iter_mut().rev() {
            let product = (*byte as u32) * 10 + carry;
            *byte = (product & 0xff) as u8;
            carry = product >> 8;
        }
        if carry > 0 {
            return None; // overflow past 32 bytes
        }
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(&bytes);
    Some(out)
}

/// EIP-191 prehash: `keccak256("\x19Ethereum Signed Message:\n" + len + data)`.
/// The kernel recovers the verifier from a signature over THIS hash, so the
/// signer seam must sign exactly these 32 bytes.
pub fn eip191_message_hash(digest: &[u8; 32]) -> [u8; 32] {
    let prefix = format!("\x19Ethereum Signed Message:\n{}", digest.len());
    let mut buffer = prefix.into_bytes();
    buffer.extend_from_slice(digest);
    keccak256(&buffer)
}

/// Recover the Ethereum address that produced an EIP-191 `(r,s,v)` signature
/// over `message_hash`.
pub fn recover_eip191_address(
    message_hash: &[u8; 32],
    signature_hex: &str,
) -> Result<[u8; 20], String> {
    let bytes = decode_hex_strict(signature_hex)
        .ok_or_else(|| "EIP-191 signature must be hexadecimal".to_string())?;
    if bytes.len() != 65 || !matches!(bytes[64], 27 | 28) {
        return Err("EIP-191 signature must be 65-byte r||s||v with v 27 or 28".to_string());
    }
    let signature = Signature::from_slice(&bytes[..64])
        .map_err(|_| "EIP-191 signature scalars are invalid".to_string())?;
    if signature.normalize_s().is_some() {
        return Err("EIP-191 signature must use canonical low-S form".to_string());
    }
    let recovery_id = RecoveryId::from_byte(bytes[64] - 27)
        .ok_or_else(|| "EIP-191 recovery id is invalid".to_string())?;
    let key = VerifyingKey::recover_from_prehash(message_hash, &signature, recovery_id)
        .map_err(|_| "EIP-191 signature does not recover a verifier".to_string())?;
    let public_key = key.to_encoded_point(false);
    let hash = keccak256(&public_key.as_bytes()[1..]);
    Ok(hash[12..].try_into().expect("20-byte EVM address"))
}

/// The signing seam: implementation signs the 32-byte EIP-191 prehash and
/// returns the 65-byte `(r, s, v)` signature with `v ∈ {27, 28}` plus the
/// public identity. Production implementations live behind custody.
pub trait FulfillmentSigner: Send + Sync {
    fn sign_eip191(&self, message_hash: &[u8; 32]) -> Result<Vec<u8>, String>;
    fn public_key(&self) -> String;
    fn address(&self) -> String;
}

/// resolveResultBytesHex: the compact callback bytes (base64) when present,
/// otherwise the utf8 result string — both rendered as `0x`-prefixed hex.
pub fn resolve_result_bytes_hex(result: &str, result_bytes_base64: &str) -> String {
    let compact = result_bytes_base64.trim();
    if !compact.is_empty() {
        return format!(
            "0x{}",
            hex_lower(&neo_os_core::base64::decode_lenient(compact))
        );
    }
    format!("0x{}", hex_lower(result.as_bytes()))
}

/// normalizeNeoXRevert: map a kernel revert onto the relayer's
/// error-classifier vocabulary. Matching is name-first (ethers decodes the
/// custom error when the fragments are in the ABI) with a message-text
/// fallback.
pub fn normalize_neox_revert(error_name: &str, message: &str) -> String {
    let reason = if message.trim().is_empty() {
        error_name.to_string()
    } else {
        message.to_string()
    };
    let probe = format!("{error_name} {reason}").to_lowercase();
    if probe.contains("requestnotpending") {
        return "request already fulfilled".to_string();
    }
    if probe.contains("badsignature") {
        return "invalid signature: verifier rejected signature".to_string();
    }
    if probe.contains("notupdater") {
        return "unauthorized: updater not set".to_string();
    }
    reason
}

/// decodeConfidentialEnvelope: recover the raw base64 envelope string from the
/// `abi.encode(uint256 messageId, bytes envelope)` wrapper the miniapp
/// callback contract applies; falls back to the generic utf8 decode.
pub fn decode_confidential_envelope(payload_hex: &str) -> String {
    let bytes = hex_to_bytes(payload_hex);
    if let Ok((_, envelope)) = abi_decode_uint256_bytes(&bytes) {
        if let Ok(text) = String::from_utf8(envelope) {
            if !text.is_empty() {
                return text;
            }
        }
    }
    decode_payload(payload_hex)
}

/// decodeConfidentialMessageId: the uint256 messageId from the same wrapper
/// (decimal string), or '' when the payload is not in that shape.
pub fn decode_confidential_message_id(payload_hex: &str) -> String {
    let bytes = hex_to_bytes(payload_hex);
    match abi_decode_uint256_bytes(&bytes) {
        Ok((message_id, _)) => {
            let trimmed = message_id.trim_start_matches('0');
            if trimmed.is_empty() {
                "0".to_string()
            } else {
                trimmed.to_string()
            }
        }
        Err(_) => String::new(),
    }
}

/// isConfidentialDecryptOperation.
pub fn is_confidential_decrypt_operation(operation: &str) -> bool {
    let normalized = operation.to_lowercase();
    normalized == "decrypt" || normalized.contains("decrypt")
}

/// decodePayload: utf8 if it round-trips, else the trimmed hex verbatim.
pub fn decode_payload(payload_hex: &str) -> String {
    let raw = payload_hex.trim().strip_prefix("0x").unwrap_or(payload_hex);
    if raw.is_empty() || !raw.len().is_multiple_of(2) {
        return payload_hex.trim().to_string();
    }
    let bytes = hex_to_bytes(raw);
    match String::from_utf8(bytes) {
        Ok(text) => text,
        Err(_) => payload_hex.trim().to_string(),
    }
}

fn hex_lower(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn hex_to_bytes(text: &str) -> Vec<u8> {
    let raw = text.strip_prefix("0x").unwrap_or(text);
    (0..raw.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&raw[i..i + 2], 16).unwrap_or(0))
        .collect()
}
