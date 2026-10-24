//! Fulfillment digest builders (port of the digest half of
//! workers/morpheus-relayer/src/router.js).
//!
//! The Neo N3 kernel contract binds the signature to the full request
//! envelope (appId, moduleId, operation) plus, when supplied, the executing
//! contract script hash and network magic. Identifier/error inputs are hashed
//! VERBATIM: the on-chain ComputeFulfillmentDigest hashes the stored request
//! bytes exactly as written, so any normalization here would produce a
//! signature that fails verification on-chain. Malformed identifiers are
//! rejected at ingestion, not here.

use crate::js_value::JsValue;
use crate::neo_encoding::{decode_hex_lossy, network_magic_le4, parse_bigint};
use crate::{sha256, CoreError, CoreResult};

pub const FULFILLMENT_DOMAIN_N3: &[u8] = b"miniapp-os-fulfillment-v2";
pub const FULFILLMENT_DOMAIN_LEGACY: &[u8] = b"morpheus-fulfillment-v2";

/// Mirrors the JS options object of `buildFulfillmentDigestBytes`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct FulfillmentOptions {
    /// `'neo_n3'` by default; `'legacy'` selects the pre-kernel domain.
    pub chain: Option<String>,
    pub app_id: String,
    pub module_id: String,
    pub operation: String,
    /// Exact payload bytes stored by the request, not a JSON re-serialization.
    pub payload: Vec<u8>,
    pub contract_script_hash: String,
    /// JS receives this as a `Number`; `Number.isFinite` gates deployment
    /// binding. `None` models `undefined`.
    pub network_magic: Option<f64>,
}

impl FulfillmentOptions {
    pub fn n3(app_id: &str, module_id: &str, operation: &str) -> Self {
        FulfillmentOptions {
            chain: Some("neo_n3".to_string()),
            app_id: app_id.to_string(),
            module_id: module_id.to_string(),
            operation: operation.to_string(),
            ..FulfillmentOptions::default()
        }
    }

    pub fn legacy() -> Self {
        FulfillmentOptions {
            chain: Some("legacy".to_string()),
            ..FulfillmentOptions::default()
        }
    }
}

/// JS strict `trimString` for string inputs (this module only ever receives
/// real strings from the relayer boundary).
fn trim(value: &str) -> &str {
    let trimmed = crate::js_value::js_trim(value);
    trimmed
}

fn strip0x(value: &str) -> &str {
    let trimmed = trim(value);
    trimmed
        .strip_prefix("0x")
        .or_else(|| trimmed.strip_prefix("0X"))
        .unwrap_or(trimmed)
}

/// Router `encodeUint256Bytes`: `BigInt(String(value ?? '0'))`, negative
/// rejected, hex zero-padded to 64 characters. NOTE: the JS oracle performs NO
/// uint256 overflow check here — values above 2^256 produce a LONGER buffer
/// (and Buffer.from hex-decoding drops a trailing odd nibble). This port
/// reproduces that byte-for-byte; the checked variant is `neo_encoding::
/// encode_uint256_word`.
pub fn encode_uint256_bytes(value: &JsValue) -> CoreResult<Vec<u8>> {
    let text = match value {
        JsValue::Undefined | JsValue::Null => "0".to_string(),
        other => other.to_string_js()?,
    };
    let parsed = parse_bigint(&text)
        .map_err(|_| CoreError::new("uint256 value must be a valid BigInt string"))?;
    if parsed.negative {
        return Err(CoreError::new("uint256 value must be non-negative"));
    }
    let mut hex = crate::hex_encode(&parsed.be_bytes);
    if hex.is_empty() {
        // BigInt(0n).toString(16) === '0'
        hex.push('0');
    }
    if hex.len() < 64 {
        hex = format!("{}{hex}", "0".repeat(64 - hex.len()));
    }
    Ok(decode_hex_lossy(&hex))
}

fn is_hex_40(value: &str) -> bool {
    value.len() == 40 && value.bytes().all(|b| b.is_ascii_hexdigit())
}

/// sha256 over a string input exactly as `sha256Buffer(String(value ?? ''))`.
fn sha256_str(value: &str) -> [u8; 32] {
    sha256(value.as_bytes())
}

/// Build the fulfillment digest that must match the on-chain contract's
/// ComputeFulfillmentDigest. See the JS oracle for the full security
/// rationale (envelope coverage prevents cross-tuple signature reuse).
pub fn build_fulfillment_digest_bytes(
    request_id: &JsValue,
    request_type: &str,
    success: bool,
    result: &str,
    error: &str,
    result_bytes_base64: &str,
    options: &FulfillmentOptions,
) -> CoreResult<[u8; 32]> {
    let success_byte = [u8::from(success)];
    let trimmed_base64 = trim(result_bytes_base64);
    let result_bytes: Vec<u8> = if !trimmed_base64.is_empty() {
        crate::base64::decode_lenient(trimmed_base64)
    } else {
        // String(result || '') — the relayer passes real strings, so an empty
        // string covers null/undefined/'' alike.
        result.as_bytes().to_vec()
    };

    let hash_hex = strip0x(&options.contract_script_hash);
    let magic_finite = options.network_magic.is_some_and(f64::is_finite);
    let bind_deployment = is_hex_40(hash_hex) && magic_finite;
    let mut deployment_suffix: Vec<u8> = Vec::new();
    if bind_deployment {
        // big-endian display form -> little-endian VM bytes
        let mut reversed = decode_hex_lossy(hash_hex);
        reversed.reverse();
        deployment_suffix.extend_from_slice(&reversed);
        deployment_suffix
            .extend_from_slice(&network_magic_le4(options.network_magic.unwrap_or(0.0)));
    }

    let mut message: Vec<u8> = Vec::new();
    if options.chain.as_deref() == Some("legacy") {
        message.extend_from_slice(FULFILLMENT_DOMAIN_LEGACY);
        message.extend_from_slice(&encode_uint256_bytes(request_id)?);
        message.extend_from_slice(&sha256_str(request_type));
        message.extend_from_slice(&success_byte);
        message.extend_from_slice(&sha256(&result_bytes));
        message.extend_from_slice(&sha256_str(error));
    } else {
        message.extend_from_slice(FULFILLMENT_DOMAIN_N3);
        message.extend_from_slice(&encode_uint256_bytes(request_id)?);
        message.extend_from_slice(&sha256_str(&options.app_id));
        message.extend_from_slice(&sha256_str(&options.module_id));
        message.extend_from_slice(&sha256_str(&options.operation));
        message.extend_from_slice(&sha256(&options.payload));
        message.extend_from_slice(&success_byte);
        message.extend_from_slice(&sha256(&result_bytes));
        message.extend_from_slice(&sha256_str(error));
        message.extend_from_slice(&deployment_suffix);
    }
    Ok(sha256(&message))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uint256_router_semantics() {
        // Plain values zero-pad to 32 bytes.
        assert_eq!(encode_uint256_bytes(&JsValue::Str("42".into())).unwrap(), {
            let mut v = vec![0u8; 31];
            v.push(42);
            v
        });
        // Zero encodes as 63 zero nibbles + '0' — still 32 bytes.
        assert_eq!(
            encode_uint256_bytes(&JsValue::Number(0.0)).unwrap().len(),
            32
        );
        assert!(encode_uint256_bytes(&JsValue::Str("-1".into())).is_err());
    }
}
