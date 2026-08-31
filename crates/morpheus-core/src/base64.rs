//! Base64 with Node `Buffer` semantics.
//!
//! `Buffer.from(s, 'base64')` is LENIENT: it skips every character outside
//! the alphabet (both standard and URL-safe forms accepted), stops at the
//! first `=` and decodes whatever complete 6-bit groups remain. The digest
//! and envelope paths hash those decoded bytes, so this must match Node
//! exactly — a strict-RFC decoder would reject inputs the JS oracle accepts.

/// Lenient decode mirroring `Buffer.from(text, 'base64')`.
pub fn decode_lenient(text: &str) -> Vec<u8> {
    let mut acc: u32 = 0;
    let mut bits: u32 = 0;
    let mut out = Vec::new();
    for c in text.chars() {
        if c == '=' {
            break;
        }
        let value = match c {
            'A'..='Z' => c as u32 - 'A' as u32,
            'a'..='z' => c as u32 - 'a' as u32 + 26,
            '0'..='9' => c as u32 - '0' as u32 + 52,
            '+' => 62,
            '/' => 63,
            '-' => 62,
            '_' => 63,
            // whitespace, padding variants, non-ASCII: ignored by Node
            _ => continue,
        };
        acc = (acc << 6) | value;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((acc >> bits) & 0xff) as u8);
        }
    }
    out
}

/// Standard alphabet with padding, mirroring `Buffer.toString('base64')`.
pub fn encode_standard(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = chunk.get(1).copied().unwrap_or(0) as u32;
        let b2 = chunk.get(2).copied().unwrap_or(0) as u32;
        let group = (b0 << 16) | (b1 << 8) | b2;
        out.push(ALPHABET[(group >> 18) as usize & 63] as char);
        out.push(ALPHABET[(group >> 12) as usize & 63] as char);
        if chunk.len() > 1 {
            out.push(ALPHABET[(group >> 6) as usize & 63] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(ALPHABET[group as usize & 63] as char);
        } else {
            out.push('=');
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip() {
        let bytes = b"deadbeef";
        assert_eq!(decode_lenient(&encode_standard(bytes)), bytes.to_vec());
    }

    #[test]
    fn lenient_ignores_garbage() {
        assert_eq!(decode_lenient(" 3q2+7w=="), b"\xde\xad\xbe\xef".to_vec());
        // Node accepts the URL-safe alphabet too ('-' == 62), so this decodes
        // the same 4 bytes as the + form; padding is what stops the decode.
        assert_eq!(decode_lenient("3q2-7w"), b"\xde\xad\xbe\xef".to_vec());
        // 'z' IS alphabet (value 51): "zz" = 12 bits -> one byte + 4 dropped bits.
        assert_eq!(decode_lenient("zz"), vec![0xcf]);
    }
}
