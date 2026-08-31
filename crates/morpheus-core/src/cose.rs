//! COSE_Sign1 Sig_structure encoding + ES384 raw(r||s) → DER conversion
//! (port of packages/shared/src/cose-verify.js).
//!
//! The functions are byte-exact ports of the JS originals (the only copy that
//! was ever exercised against real AWS Nitro attestation documents). Do NOT
//! "canonicalize" the length-class thresholds here without regenerating the
//! verify-passing ES384 fixture — those bytes are signature-load-bearing.

/// One item of the Sig_structure array: a text string or a byte string.
#[derive(Debug, Clone, Copy)]
pub enum SigItem<'a> {
    Text(&'a str),
    Bytes(&'a [u8]),
}

/// Minimal deterministic CBOR encoder for a Sig_structure array (RFC 8152
/// §4.4): a fixed-length array of text strings + byte strings. Only the
/// majors needed by Sig_structure are supported (array=4, byte string=2, text
/// string=3); lengths up to 32-bit (0x1a) — exactly the JS head() ladder.
fn head(major: u8, len: usize) -> Vec<u8> {
    let (major, len) = (major as usize, len);
    if len < 24 {
        vec![((major << 5) | len) as u8]
    } else if len < 256 {
        vec![((major << 5) | 24) as u8, len as u8]
    } else if len < 65536 {
        vec![
            ((major << 5) | 25) as u8,
            ((len >> 8) & 0xff) as u8,
            (len & 0xff) as u8,
        ]
    } else {
        let mut out = vec![((major << 5) | 26) as u8];
        out.extend_from_slice(&(len as u32).to_be_bytes());
        out
    }
}

/// Encode the Sig_structure items (port of `cborEncodeSigStructure`).
pub fn cbor_encode_sig_structure(items: &[SigItem<'_>]) -> Vec<u8> {
    let mut out = head(4, items.len());
    for item in items {
        match item {
            SigItem::Text(s) => {
                let b = s.as_bytes();
                out.extend_from_slice(&head(3, b.len()));
                out.extend_from_slice(b);
            }
            SigItem::Bytes(b) => {
                out.extend_from_slice(&head(2, b.len()));
                out.extend_from_slice(b);
            }
        }
    }
    out
}

/// Build the COSE Sig_structure for a COSE_Sign1 (RFC 8152 §4.4):
/// `["Signature1", body_protected(bstr), external_aad(bstr ""), payload(bstr)]`
/// — the exact byte string the enclave's ES384 signature is computed over.
///
/// `protected_header_bytes` must be the ORIGINAL wire bytes (as returned by
/// `decode_cose_sign1`), never re-serialized, or the signature will not verify.
pub fn build_cose_sign1_sig_structure(
    protected_header_bytes: &[u8],
    payload_bytes: &[u8],
) -> Vec<u8> {
    cbor_encode_sig_structure(&[
        SigItem::Text("Signature1"),
        SigItem::Bytes(protected_header_bytes),
        SigItem::Bytes(&[]),
        SigItem::Bytes(payload_bytes),
    ])
}

/// Convert a 96-byte COSE raw (r||s) ES384 signature into the DER-encoded
/// ECDSA signature Node's crypto.verify expects (with dsaEncoding:'der').
/// Returns `None` if the input is not a 96-byte raw signature (e.g. a
/// placeholder), so the caller can treat it as unverifiable rather than
/// throwing.
///
/// DER for ECDSA: SEQUENCE { INTEGER r, INTEGER s }, each INTEGER minimally
/// encoded with a leading 0x00 if the high bit would otherwise be set.
pub fn cose_es384_signature_to_der(raw_signature: &[u8]) -> Option<Vec<u8>> {
    if raw_signature.len() != 96 {
        return None;
    }
    let encode_int = |bytes: &[u8]| -> Vec<u8> {
        let mut i = 0;
        while i < bytes.len() - 1 && bytes[i] == 0 {
            i += 1;
        }
        let mut trimmed = bytes[i..].to_vec();
        if trimmed[0] & 0x80 != 0 {
            trimmed.insert(0, 0);
        }
        let mut out = vec![0x02, trimmed.len() as u8];
        out.extend_from_slice(&trimmed);
        out
    };
    let r = encode_int(&raw_signature[0..48]);
    let s = encode_int(&raw_signature[48..96]);
    let mut out = vec![0x30, (r.len() + s.len()) as u8];
    out.extend_from_slice(&r);
    out.extend_from_slice(&s);
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn length_classes() {
        let items = [SigItem::Bytes(&[0xaa; 3])];
        // array(1) + bstr(3): header byte 0x81 then the definite-length bstr.
        assert_eq!(
            cbor_encode_sig_structure(&items),
            vec![0x81, 0x43, 0xaa, 0xaa, 0xaa]
        );
        let big = vec![0xbb; 300];
        let items = [SigItem::Bytes(&big)];
        let encoded = cbor_encode_sig_structure(&items);
        // Length 300 lands in the one-byte-extensive class: 0x59 0x01 0x2c.
        assert_eq!(&encoded[..4], &[0x81u8, 0x59, 0x01, 0x2c]);
    }

    #[test]
    fn sig_structure_shape() {
        let built = build_cose_sign1_sig_structure(&[0xa1], &[0x61, 0x61]);
        // ["Signature1", h'A1', h'', h'6161'] — "Signature1" is 10 chars (0x6a).
        assert_eq!(
            built,
            vec![
                0x84, 0x6a, b'S', b'i', b'g', b'n', b'a', b't', b'u', b'r', b'e', b'1', 0x41, 0xa1,
                0x40, 0x42, 0x61, 0x61,
            ]
        );
    }

    #[test]
    fn der_conversion() {
        let raw = [0xff; 96];
        let der = cose_es384_signature_to_der(&raw).unwrap();
        // Each half: 48 content bytes + 0x00 prefix = 49-byte INTEGER, so each
        // TLV is 51 bytes and the SEQUENCE content length is 102.
        assert_eq!(der[0], 0x30);
        assert_eq!(der[1], (2 * 51) as u8);
        assert_eq!(&der[2..4], &[0x02u8, 49]);
        assert_eq!(cose_es384_signature_to_der(&[0xff; 95]), None);
    }
}
