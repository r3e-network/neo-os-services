//! Minimal DER reader for the CMS structures the CMS decrypt path walks.
//!
//! Only the pieces cms.go needs from encoding/asn1: TLV framing, SEQUENCE/SET
//! child iteration, OID identity (raw content-byte comparison against the
//! known constant OIDs) and OID formatting for error messages. DER's minimal-
//! encoding rule makes content-byte comparison exact.

/// One parsed DER TLV. `content` borrows the value octets.
#[derive(Debug, Clone, Copy)]
pub struct Tlv<'a> {
    pub tag: u8,
    pub content: &'a [u8],
}

impl<'a> Tlv<'a> {
    /// Parses one TLV and returns it with the unconsumed remainder. DER only:
    /// definite lengths (indefinite-length input must go through
    /// `crate::ber::ber_to_der` first, exactly like cms.go does).
    pub fn parse(input: &'a [u8]) -> Result<(Tlv<'a>, &'a [u8]), String> {
        if input.len() < 2 {
            return Err("asn1: truncated TLV".to_string());
        }
        let tag = input[0];
        let mut i = 1usize;
        if tag & 0x1f == 0x1f {
            // High-tag-number form: identifier octets continue until MSB clear.
            loop {
                if i >= input.len() {
                    return Err("asn1: truncated identifier".to_string());
                }
                let c = input[i];
                i += 1;
                if c & 0x80 == 0 {
                    break;
                }
            }
        }
        if i >= input.len() {
            return Err("asn1: missing length".to_string());
        }
        let lb = input[i];
        i += 1;
        let length = if lb & 0x80 == 0 {
            lb as usize
        } else {
            let n = (lb & 0x7f) as usize;
            if n == 0 {
                return Err("asn1: indefinite length found (not DER)".to_string());
            }
            if n > 4 {
                return Err(format!("asn1: unsupported length-of-length {n}"));
            }
            if i + n > input.len() {
                return Err("asn1: truncated long-form length".to_string());
            }
            let mut length = 0usize;
            for k in 0..n {
                length = (length << 8) | input[i + k] as usize;
            }
            i += n;
            length
        };
        if i + length > input.len() {
            return Err("asn1: content length exceeds buffer".to_string());
        }
        Ok((
            Tlv {
                tag,
                content: &input[i..i + length],
            },
            &input[i + length..],
        ))
    }

    pub fn is_constructed(&self) -> bool {
        self.tag & 0x20 != 0
    }

    pub fn is_sequence(&self) -> bool {
        self.tag == 0x30
    }

    pub fn is_set(&self) -> bool {
        self.tag == 0x31
    }

    pub fn is_octet_string(&self) -> bool {
        self.tag == 0x04
    }

    pub fn is_oid(&self) -> bool {
        self.tag == 0x06
    }

    pub fn is_integer(&self) -> bool {
        self.tag == 0x02
    }

    /// Context-specific [0] in either form — primitive (0x80, the usual
    /// encryptedContent) or constructed (0xa0, the ContentInfo explicit
    /// wrapper / BER-segmented encryptedContent). Go's `asn1:"tag:0"` on a
    /// RawValue matches both.
    pub fn is_context0(&self) -> bool {
        self.tag >> 6 == 2 && self.tag & 0x1f == 0
    }

    /// DER re-encoding of this TLV: tag octets + minimal definite length +
    /// content. Equivalent to Go's RawValue.FullBytes for inputs that already
    /// went through `ber_to_der` (or were DER to begin with), where every
    /// length is minimal by construction.
    pub fn to_der(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(self.content.len() + 5);
        out.push(self.tag);
        let len = self.content.len();
        if len < 0x80 {
            out.push(len as u8);
        } else {
            let be = (len as u64).to_be_bytes();
            let significant = &be[be.iter().position(|&b| b != 0).unwrap_or(be.len() - 1)..];
            out.push(0x80 | significant.len() as u8);
            out.extend_from_slice(significant);
        }
        out.extend_from_slice(self.content);
        out
    }
}

/// Parses every child TLV of a constructed element's content, requiring the
/// children to consume it exactly (Go struct unmarshal is equally strict).
pub fn children(content: &[u8]) -> Result<Vec<Tlv<'_>>, String> {
    let mut out = Vec::new();
    let mut rest = content;
    while !rest.is_empty() {
        let (tlv, remainder) = Tlv::parse(rest)?;
        out.push(tlv);
        rest = remainder;
    }
    Ok(out)
}

pub fn oid_enveloped_data() -> &'static [u8] {
    // 1.2.840.113549.1.7.3
    &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x03]
}

pub fn oid_data() -> &'static [u8] {
    // 1.2.840.113549.1.7.1
    &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x01]
}

pub fn oid_rsaes_oaep() -> &'static [u8] {
    // 1.2.840.113549.1.1.7
    &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x07]
}

pub fn oid_aes256_cbc() -> &'static [u8] {
    // 2.16.840.1.101.3.4.1.42
    &[0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x01, 0x2a]
}

pub fn oid_aes256_gcm() -> &'static [u8] {
    // 2.16.840.1.101.3.4.1.46
    &[0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x01, 0x2e]
}

/// Dotted-decimal form of an OID's content octets, for error messages.
pub fn format_oid(content: &[u8]) -> String {
    if content.is_empty() {
        return String::new();
    }
    let mut parts: Vec<String> = Vec::new();
    // First octet: value = 40*a + b of the first two arcs.
    let first = content[0];
    if first < 40 {
        parts.push("0".to_string());
        parts.push(first.to_string());
    } else if first < 80 {
        parts.push("1".to_string());
        parts.push((first - 40).to_string());
    } else {
        parts.push("2".to_string());
        parts.push((first - 80).to_string());
    }
    let mut value: u64 = 0;
    for &byte in &content[1..] {
        value = (value << 7) | (byte & 0x7f) as u64;
        if byte & 0x80 == 0 {
            parts.push(value.to_string());
            value = 0;
        }
    }
    parts.join(".")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_formats_oids() {
        assert_eq!(format_oid(oid_enveloped_data()), "1.2.840.113549.1.7.3");
        assert_eq!(format_oid(oid_aes256_cbc()), "2.16.840.1.101.3.4.1.42");
        assert_eq!(format_oid(oid_aes256_gcm()), "2.16.840.1.101.3.4.1.46");
        assert_eq!(format_oid(oid_data()), "1.2.840.113549.1.7.1");
        assert_eq!(format_oid(oid_rsaes_oaep()), "1.2.840.113549.1.1.7");
    }

    #[test]
    fn rejects_indefinite_lengths() {
        // SEQUENCE with 0x80 indefinite length must be refused (BER-only).
        let input = [0x30u8, 0x80, 0x02, 0x01, 0x01, 0x00, 0x00];
        assert!(Tlv::parse(&input).is_err());
    }

    #[test]
    fn parses_definite_children_exactly() {
        // SEQUENCE { INTEGER 1, OCTET STRING "hello" }
        let input = [
            0x30u8, 0x0a, 0x02, 0x01, 0x01, 0x04, 0x05, b'h', b'e', b'l', b'l', b'o',
        ];
        let (tlv, rest) = Tlv::parse(&input).unwrap();
        assert!(rest.is_empty());
        let kids = children(tlv.content).unwrap();
        assert_eq!(kids.len(), 2);
        assert!(kids[0].is_integer());
        assert_eq!(kids[0].content, &[0x01]);
        assert!(kids[1].is_octet_string());
        assert_eq!(kids[1].content, b"hello");
    }
}
