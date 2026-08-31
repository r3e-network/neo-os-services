//! Canonical Neo N3 digest byte encoders (port of packages/shared/src/neo-encoding.js).
//!
//! These primitives feed the fulfillment / NeoDID signing digests: their byte
//! output MUST match the on-chain contracts (MorpheusOracle.Fulfillment.cs,
//! NeoDIDRegistry.cs). Golden vectors live in neo-encoding.test.mjs on the JS
//! side; the shared exporter pins the router digest path end to end.

use crate::CoreResult;

/// JS `>>> 0` (ToUint32): truncate toward zero, then take the value modulo
/// 2^32. NaN/Infinity map to 0.
pub fn to_uint32(x: f64) -> u32 {
    if !x.is_finite() || x == 0.0 {
        return 0;
    }
    x.trunc().rem_euclid(4_294_967_296.0) as u32
}

/// 4-byte little-endian network magic, byte-identical to the authoritative C#
/// `NetworkMagicLe4()`. Performs NO magic-range validation on purpose: the C#
/// contract has no such guard, and adding one here could split signer and
/// contract on a magic the chain accepts.
pub fn network_magic_le4(magic: f64) -> [u8; 4] {
    to_uint32(magic).to_le_bytes()
}

/// A `BigInt(string)` parse result: sign plus big-endian magnitude bytes.
pub struct ParsedBigInt {
    pub negative: bool,
    pub be_bytes: Vec<u8>,
}

/// Parse a JS `BigInt` literal (optional sign, decimal / 0x / 0o / 0b radix
/// prefixes, underscores between digits, no leading zeros in decimal — those
/// are SyntaxErrors in JS) into big-endian magnitude bytes. Exact for any
/// magnitude; no 128-bit ceiling.
pub fn parse_bigint(text: &str) -> Result<ParsedBigInt, &'static str> {
    let reject = || "invalid BigInt string";
    let negative = text.starts_with('-');
    let magnitude_text = if negative {
        &text[1..]
    } else {
        text.strip_prefix('+').unwrap_or(text)
    };

    let (radix, digits) = detect_radix(magnitude_text).ok_or_else(reject)?;

    let mut limbs: Vec<u32> = Vec::new();
    let mut last_was_underscore = true;
    let mut seen_digit = false;
    for c in digits.chars() {
        if c == '_' {
            if last_was_underscore {
                return Err(reject());
            }
            last_was_underscore = true;
            continue;
        }
        let digit = match radix {
            16 => c.to_digit(16),
            8 => c.to_digit(8),
            2 => c.to_digit(2),
            _ => c.to_digit(10),
        }
        .ok_or_else(reject)?;
        mul_add_small(&mut limbs, radix, digit);
        last_was_underscore = false;
        seen_digit = true;
    }
    if last_was_underscore || !seen_digit {
        return Err(reject());
    }
    // Decimal literals with a leading zero are SyntaxErrors in JS unless the
    // value is all zeros ("00" parses as 0n, "012" throws).
    if radix == 10 {
        let trimmed = digits.trim_matches('_');
        if trimmed.starts_with('0') && trimmed.bytes().any(|b| b != b'0' && b != b'_') {
            return Err(reject());
        }
    }
    Ok(ParsedBigInt {
        negative: text.starts_with('-'),
        be_bytes: limbs_to_be_bytes(&limbs),
    })
}

fn detect_radix(text: &str) -> Option<(u32, &str)> {
    if let Some(rest) = text.strip_prefix("0x").or_else(|| text.strip_prefix("0X")) {
        return Some((16, rest));
    }
    if let Some(rest) = text.strip_prefix("0o").or_else(|| text.strip_prefix("0O")) {
        return Some((8, rest));
    }
    if let Some(rest) = text.strip_prefix("0b").or_else(|| text.strip_prefix("0B")) {
        return Some((2, rest));
    }
    Some((10, text))
}

/// limbs *= mul; limbs += add (little-endian u32 limbs, school arithmetic).
fn mul_add_small(limbs: &mut Vec<u32>, mul: u32, add: u32) {
    let mut carry = add as u64;
    for limb in limbs.iter_mut() {
        let cur = (*limb as u64) * (mul as u64) + carry;
        *limb = cur as u32;
        carry = cur >> 32;
    }
    while carry > 0 {
        limbs.push(carry as u32);
        carry >>= 32;
    }
}

fn limbs_to_be_bytes(limbs: &[u32]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(limbs.len() * 4);
    for limb in limbs.iter().rev() {
        bytes.extend_from_slice(&limb.to_be_bytes());
    }
    let first_nonzero = bytes.iter().position(|b| *b != 0).unwrap_or(bytes.len());
    bytes.drain(..first_nonzero);
    bytes
}

/// `Buffer.from(text, 'hex')` — Node decodes complete pairs, stops at the
/// first non-hex character and silently drops a trailing odd nibble.
pub fn decode_hex_lossy(text: &str) -> Vec<u8> {
    fn nibble(c: u8) -> Option<u8> {
        match c {
            b'0'..=b'9' => Some(c - b'0'),
            b'a'..=b'f' => Some(c - b'a' + 10),
            b'A'..=b'F' => Some(c - b'A' + 10),
            _ => None,
        }
    }
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len() / 2);
    let mut i = 0;
    while i + 1 < bytes.len() {
        let (hi, lo) = match (nibble(bytes[i]), nibble(bytes[i + 1])) {
            (Some(h), Some(l)) => (h, l),
            _ => break,
        };
        out.push((hi << 4) | lo);
        i += 2;
    }
    out
}

/// 32-byte big-endian uint256 word, zero-left-padded (neo-encoding.js
/// `encodeUint256Word`). Rejects negatives and values that do not fit in
/// uint256 so a malformed word can never be folded into a signed digest.
pub fn encode_uint256_word(value: &crate::js_value::JsValue, field: &str) -> CoreResult<Vec<u8>> {
    use crate::js_value::JsValue;
    let text = match value {
        JsValue::Undefined | JsValue::Null => "0".to_string(),
        other => other.to_string_js()?,
    };
    let parsed = parse_bigint(&text)
        .map_err(|_| crate::CoreError::new(format!("{field} must be a uint256 string")))?;
    if parsed.negative {
        return Err(crate::CoreError::new(format!("{field} must be >= 0")));
    }
    if parsed.be_bytes.len() > 32 {
        return Err(crate::CoreError::new(format!("{field} overflows uint256")));
    }
    let mut out = vec![0u8; 32 - parsed.be_bytes.len()];
    out.extend_from_slice(&parsed.be_bytes);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::js_value::JsValue;

    #[test]
    fn uint32_wraps_like_js() {
        assert_eq!(to_uint32(-1.0), 4_294_967_295);
        assert_eq!(to_uint32(4_294_967_296.0), 0);
        // 8608331020 wraps twice through 2^32.
        assert_eq!(to_uint32(8_608_331_020.0), 18_396_428);
        assert_eq!(to_uint32(f64::NAN), 0);
        assert_eq!(to_uint32(1.5), 1);
    }

    #[test]
    fn magic_le4() {
        // N3 testnet magic 860833102 is "NEO3" in little-endian.
        assert_eq!(network_magic_le4(860_833_102.0), [0x4e, 0x45, 0x4f, 0x33]);
    }

    #[test]
    fn hex_lossy_trailing_nibble() {
        assert_eq!(decode_hex_lossy("abcd"), vec![0xab, 0xcd]);
        assert_eq!(decode_hex_lossy("abc"), vec![0xab]);
        assert_eq!(decode_hex_lossy("zz"), Vec::<u8>::new());
    }

    #[test]
    fn bigint_parses_exact() {
        let parsed = parse_bigint("18446744073709551615").unwrap();
        assert_eq!(parsed.be_bytes, vec![0xff; 8]);
        let parsed = parse_bigint("123456789012345678901234567890").unwrap();
        assert_eq!(parsed.be_bytes.len(), 13);
        assert!(parse_bigint("012").is_err());
        assert!(parse_bigint("1_0").is_ok());
        assert!(parse_bigint("_10").is_err());
        assert_eq!(parse_bigint("0x10").unwrap().be_bytes, vec![0x10]);
        assert_eq!(parse_bigint("0").unwrap().be_bytes, Vec::<u8>::new());
    }

    #[test]
    fn uint256_word_bounds() {
        let ok = encode_uint256_word(&JsValue::Str("18446744073709551615".into()), "v").unwrap();
        assert_eq!(ok.len(), 32);
        assert_eq!(ok[24..], [0xff; 8]);
        let overflow = "1".repeat(80);
        assert!(encode_uint256_word(&JsValue::Str(overflow), "v")
            .unwrap_err()
            .to_string()
            .contains("overflows uint256"));
        assert!(encode_uint256_word(&JsValue::Str("-1".into()), "v")
            .unwrap_err()
            .to_string()
            .contains("must be >= 0"));
    }
}
