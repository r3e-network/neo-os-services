//! BER→DER transcode (byte-level port of cms.go's `berToDER`/`convertTLV`/
//! `writeTagLen` and the segmented-OCTET-STRING joiner `concatOctetSegments`).
//!
//! AWS KMS returns the Nitro CiphertextForRecipient CMS EnvelopedData using
//! indefinite-length BER (constructed elements with a 0x80 length octet,
//! terminated by an end-of-contents 0x00 0x00), which strict DER parsers
//! reject. This walks the TLV tree, recomputing definite lengths for
//! constructed elements; primitive elements and already-definite lengths are
//! preserved byte-for-byte.

/// Transcodes a BER structure into DER. Tolerates only trailing
/// end-of-contents padding after the top-level element.
pub fn ber_to_der(ber: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    let rest = convert_tlv(ber, &mut out)?;
    if rest.iter().any(|&b| b != 0x00) {
        return Err("ber: unexpected trailing data after top-level element".to_string());
    }
    Ok(out)
}

/// Consumes exactly one TLV from `input`, writes its DER form to `out`, and
/// returns the unconsumed remainder.
fn convert_tlv<'a>(input: &'a [u8], out: &mut Vec<u8>) -> Result<&'a [u8], String> {
    if input.len() < 2 {
        return Err("ber: truncated TLV".to_string());
    }
    let id_byte = input[0];
    let constructed = id_byte & 0x20 != 0;
    let mut i = 1usize;
    if id_byte & 0x1f == 0x1f {
        // High-tag-number form: octets until MSB clear.
        loop {
            if i >= input.len() {
                return Err("ber: truncated identifier".to_string());
            }
            let c = input[i];
            i += 1;
            if c & 0x80 == 0 {
                break;
            }
        }
    }
    let tag = &input[..i];
    if i >= input.len() {
        return Err("ber: missing length".to_string());
    }
    let lb = input[i];
    i += 1;

    if lb == 0x80 {
        // Indefinite length — constructed only, ends at 0x00 0x00.
        if !constructed {
            return Err("ber: indefinite length on a primitive element".to_string());
        }
        let mut rest = &input[i..];
        let mut children: Vec<u8> = Vec::new();
        loop {
            if rest.len() < 2 {
                return Err("ber: missing end-of-contents".to_string());
            }
            if rest[0] == 0x00 && rest[1] == 0x00 {
                rest = &rest[2..];
                break;
            }
            rest = convert_tlv(rest, &mut children)?;
        }
        write_tag_len(out, tag, children.len());
        out.extend_from_slice(&children);
        return Ok(rest);
    }

    let length: usize;
    if lb & 0x80 == 0 {
        length = lb as usize; // short form
    } else {
        let n = (lb & 0x7f) as usize; // long form
        if n == 0 || n > 4 {
            return Err(format!("ber: unsupported length-of-length {n}"));
        }
        if i + n > input.len() {
            return Err("ber: truncated long-form length".to_string());
        }
        let mut l = 0usize;
        for k in 0..n {
            l = (l << 8) | input[i + k] as usize;
        }
        length = l;
        i += n;
    }
    if i + length > input.len() {
        return Err("ber: content length exceeds buffer".to_string());
    }
    let content = &input[i..i + length];
    let rest = &input[i + length..];

    if !constructed {
        write_tag_len(out, tag, content.len());
        out.extend_from_slice(content);
        return Ok(rest);
    }
    let mut children: Vec<u8> = Vec::new();
    let mut cr = content;
    while !cr.is_empty() {
        cr = convert_tlv(cr, &mut children)?;
    }
    write_tag_len(out, tag, children.len());
    out.extend_from_slice(&children);
    Ok(rest)
}

/// Emits the identifier octets followed by a DER definite length.
fn write_tag_len(out: &mut Vec<u8>, tag: &[u8], length: usize) {
    out.extend_from_slice(tag);
    if length < 0x80 {
        out.push(length as u8);
        return;
    }
    let mut len_bytes = Vec::new();
    let mut l = length;
    while l > 0 {
        len_bytes.insert(0, (l & 0xff) as u8);
        l >>= 8;
    }
    out.push(0x80 | len_bytes.len() as u8);
    out.extend_from_slice(&len_bytes);
}

/// Concatenates the contents of a run of primitive OCTET STRING segments —
/// the body of a constructed (segmented) OCTET STRING, which the
/// indefinite-length BER CMS from KMS uses for the encryptedContent. After
/// `ber_to_der` the segments are definite-length primitive OCTET STRINGs;
/// this joins their octets back into the original ciphertext.
pub fn concat_octet_segments(input: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    let mut rest = input;
    while !rest.is_empty() {
        if rest.len() < 2 {
            return Err("cms: truncated OCTET STRING segment".to_string());
        }
        let tag = rest[0];
        let mut i = 1usize;
        let lb = rest[i];
        i += 1;
        let length: usize;
        if lb & 0x80 == 0 {
            length = lb as usize;
        } else {
            let n = (lb & 0x7f) as usize;
            if n == 0 || n > 4 || i + n > rest.len() {
                return Err("cms: bad OCTET STRING segment length".to_string());
            }
            let mut l = 0usize;
            for k in 0..n {
                l = (l << 8) | rest[i + k] as usize;
            }
            length = l;
            i += n;
        }
        if i + length > rest.len() {
            return Err("cms: OCTET STRING segment exceeds buffer".to_string());
        }
        if tag != 0x04 {
            return Err(format!(
                "cms: unexpected encryptedContent segment tag 0x{tag:02x} (want OCTET STRING)"
            ));
        }
        out.extend_from_slice(&rest[i..i + length]);
        rest = &rest[i + length..];
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Vectors ported from cms_test.go TestBERToDER.
    #[test]
    fn ber_to_der_matches_go_vectors() {
        let der: &[u8] = &[
            0x30, 0x0a, 0x02, 0x01, 0x01, 0x04, 0x05, b'h', b'e', b'l', b'l', b'o',
        ];
        let ber: &[u8] = &[
            0x30, 0x80, 0x02, 0x01, 0x01, 0x04, 0x05, b'h', b'e', b'l', b'l', b'o', 0x00, 0x00,
        ];
        assert_eq!(ber_to_der(ber).unwrap(), der);
        // Already-DER input passes through byte-for-byte.
        assert_eq!(ber_to_der(der).unwrap(), der);
        // Nested indefinite: SEQUENCE { SEQUENCE { INTEGER 1 } }.
        let nested_ber = [
            0x30u8, 0x80, 0x30, 0x80, 0x02, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00,
        ];
        let nested_der = [0x30u8, 0x05, 0x30, 0x03, 0x02, 0x01, 0x01];
        assert_eq!(ber_to_der(&nested_ber).unwrap(), nested_der);
    }

    #[test]
    fn ber_errors() {
        assert_eq!(ber_to_der(&[0x30]).unwrap_err(), "ber: truncated TLV");
        // Indefinite length on a primitive element.
        assert_eq!(
            ber_to_der(&[0x04, 0x80, 0x00, 0x00]).unwrap_err(),
            "ber: indefinite length on a primitive element"
        );
        // Trailing garbage after the top-level element.
        assert_eq!(
            ber_to_der(&[0x02, 0x01, 0x01, 0xff]).unwrap_err(),
            "ber: unexpected trailing data after top-level element"
        );
        assert_eq!(
            ber_to_der(&[0x30, 0x80, 0x00]).unwrap_err(),
            "ber: missing end-of-contents"
        );
        assert_eq!(
            ber_to_der(&[0x02, 0x84, 0xff, 0xff, 0xff, 0xff, 0x01]).unwrap_err(),
            "ber: content length exceeds buffer"
        );
        assert_eq!(
            ber_to_der(&[0x02, 0x89, 0x01]).unwrap_err(),
            "ber: unsupported length-of-length 9"
        );
    }

    // Vectors ported from cms_test.go TestConcatOctetSegments.
    #[test]
    fn concat_segments_matches_go_vectors() {
        let two_short = [0x04, 0x03, b'a', b'b', b'c', 0x04, 0x02, b'd', b'e'];
        assert_eq!(concat_octet_segments(&two_short).unwrap(), b"abcde");
        let long_form = [0x04, 0x81, 0x03, b'x', b'y', b'z'];
        assert_eq!(concat_octet_segments(&long_form).unwrap(), b"xyz");
        // A non-OCTET-STRING segment is rejected.
        assert!(concat_octet_segments(&[0x30, 0x01, 0x00]).is_err());
    }
}
