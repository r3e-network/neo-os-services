//! RFC 5652 EnvelopedData parsing + decryption for the KMS
//! "CiphertextForRecipient" returned to a Nitro enclave Recipient — byte-level
//! port of deploy/nitro/nsm-attest/cms.go.
//!
//! KMS, when given a Nitro Recipient, returns the requested plaintext
//! re-wrapped as a CMS EnvelopedData: one KeyTransRecipientInfo RSA-OAEP-SHA256
//! wrapping the CEK, and AES-256-CBC encryptedContent with the IV carried in
//! the algorithm parameters (PKCS#7-padded plaintext). AES-256-GCM is handled
//! for forward compatibility should KMS switch ciphers.
//!
//! ASN.1 is parsed by hand on top of [`crate::asn1`] — no external CMS/ASN.1
//! dependency on the security-critical path, mirroring cms.go's stdlib-only
//! posture (the crypto primitives are AWS-LC for RSA and dedicated AES crates).
//! The BER→DER transcode from
//! cms.go lives in [`crate::ber`] and runs first, because KMS emits
//! indefinite-length BER.

use crate::asn1::{self, Tlv};
use crate::ber::{ber_to_der, concat_octet_segments};
use crate::{rsa_provider::PrivateKey, AttestResult};
use aes::cipher::{generic_array::GenericArray, BlockDecrypt, KeyInit};
use aes_gcm::{aead::Aead, Aes256Gcm};

/// AlgorithmIdentifier ::= SEQUENCE { algorithm OID, parameters ANY OPTIONAL }
struct AlgorithmIdentifier<'a> {
    oid: &'a [u8],
    /// Full TLV bytes of the parameters element (Go's RawValue.FullBytes);
    /// empty when absent.
    parameters: Vec<u8>,
}

fn parse_algorithm_identifier<'a>(tlv: &Tlv<'a>) -> Result<AlgorithmIdentifier<'a>, String> {
    if !tlv.is_sequence() {
        return Err("algorithmIdentifier is not a SEQUENCE".to_string());
    }
    let kids = asn1::children(tlv.content)?;
    if kids.is_empty() || !kids[0].is_oid() {
        return Err("algorithmIdentifier is missing its algorithm OID".to_string());
    }
    let parameters = if kids.len() > 1 {
        kids[1].to_der()
    } else {
        Vec::new()
    };
    Ok(AlgorithmIdentifier {
        oid: kids[0].content,
        parameters,
    })
}

/// Decrypts a CMS EnvelopedData (DER, optionally wrapped in the ContentInfo
/// SEQUENCE) with the supplied RSA private key, returning the recovered
/// plaintext. The wrapping key is unwrapped with RSAES-OAEP (SHA-256); the
/// content is decrypted with AES-256-CBC (CEK + IV from the algorithm
/// parameters). Error strings carry the Go tool's `cms: ...` prefixes.
pub fn decrypt_cms_enveloped_data(cms: &[u8], priv_key: &PrivateKey) -> AttestResult<Vec<u8>> {
    if cms.is_empty() {
        return Err("cms: empty input".to_string());
    }

    // KMS returns the CiphertextForRecipient as indefinite-length BER, which a
    // DER-only parser cannot read. Normalize first (no-op if already DER).
    let der = ber_to_der(cms).map_err(|e| format!("cms: normalize BER->DER: {e}"))?;

    // The input may be either the bare EnvelopedData SEQUENCE or the full
    // ContentInfo wrapper. Try the wrapper first; if the OID matches
    // id-envelopedData, unwrap to the inner content (the [0] EXPLICIT wrapper's
    // content is the complete inner EnvelopedData TLV, header included).
    let mut env_bytes: &[u8] = &der;
    if let Ok((tlv, rest)) = Tlv::parse(&der) {
        if rest.is_empty() && tlv.is_sequence() {
            if let Ok(kids) = asn1::children(tlv.content) {
                if kids.len() == 2
                    && kids[0].is_oid()
                    && kids[0].content == asn1::oid_enveloped_data()
                    && kids[1].is_context0()
                {
                    env_bytes = kids[1].content;
                }
            }
        }
    }

    let (env, _) = Tlv::parse(env_bytes).map_err(|e| format!("cms: parse EnvelopedData: {e}"))?;
    if !env.is_sequence() {
        return Err("cms: parse EnvelopedData: not a SEQUENCE".to_string());
    }
    // EnvelopedData ::= SEQUENCE { version INTEGER, originatorInfo [0]
    // IMPLICIT OPTIONAL (not produced by KMS), recipientInfos SET,
    // encryptedContentInfo SEQUENCE, unprotectedAttrs [1] IMPLICIT OPTIONAL }.
    // Fields are matched positionally; trailing optional fields are ignored,
    // exactly like the Go struct unmarshal.
    let kids = asn1::children(env.content).map_err(|e| format!("cms: parse EnvelopedData: {e}"))?;
    if kids.len() < 3 {
        return Err("cms: parse EnvelopedData: sequence truncated".to_string());
    }
    if !kids[0].is_integer() {
        return Err("cms: parse EnvelopedData: version is not an INTEGER".to_string());
    }
    if !kids[1].is_set() {
        return Err(format!(
            "cms: recipientInfos is not a SET (class={} tag={})",
            kids[1].tag >> 6,
            kids[1].tag & 0x1f
        ));
    }
    if !kids[2].is_sequence() {
        return Err("cms: parse EnvelopedData: encryptedContentInfo is not a SEQUENCE".to_string());
    }

    // recipientInfos is a SET OF RecipientInfo. KMS emits exactly one
    // KeyTransRecipientInfo; decode the first element and refuse more.
    let (ktri, ktri_rest) = Tlv::parse(kids[1].content)
        .map_err(|e| format!("cms: parse KeyTransRecipientInfo: {e}"))?;
    if !ktri_rest.is_empty() {
        return Err("cms: expected exactly one recipientInfo".to_string());
    }
    let ktri_kids = asn1::children(ktri.content)
        .map_err(|e| format!("cms: parse KeyTransRecipientInfo: {e}"))?;
    if ktri_kids.len() < 4 {
        return Err("cms: parse KeyTransRecipientInfo: sequence truncated".to_string());
    }
    if !ktri_kids[0].is_integer() {
        return Err("cms: parse KeyTransRecipientInfo: version is not an INTEGER".to_string());
    }
    // ktri_kids[1] is the RecipientIdentifier (issuerAndSerial | [0] SKI);
    // decryption never reads it, so it is intentionally unused.
    let kek_alg = parse_algorithm_identifier(&ktri_kids[2])
        .map_err(|e| format!("cms: parse KeyTransRecipientInfo: {e}"))?;
    if kek_alg.oid != asn1::oid_rsaes_oaep() {
        return Err(format!(
            "cms: unexpected key encryption algorithm {} (want RSAES-OAEP)",
            asn1::format_oid(kek_alg.oid)
        ));
    }
    if !ktri_kids[3].is_octet_string() {
        return Err(
            "cms: parse KeyTransRecipientInfo: encryptedKey is not an OCTET STRING".to_string(),
        );
    }
    let encrypted_key = ktri_kids[3].content;
    if encrypted_key.is_empty() {
        return Err("cms: empty encryptedKey".to_string());
    }

    // Unwrap the content-encryption key with RSA-OAEP / SHA-256 (no label —
    // same as Go's rsa.DecryptOAEP(sha256.New(), ..., nil)). Use the blinded
    // private operation because this input is supplied by the KMS response and
    // the key is held inside the enclave.
    let cek = priv_key
        .decrypt_oaep_sha256(encrypted_key)
        .map_err(|e| format!("cms: RSA-OAEP unwrap CEK: {e}"))?;

    let eci_kids =
        asn1::children(kids[2].content).map_err(|e| format!("cms: parse EnvelopedData: {e}"))?;
    if eci_kids.len() < 2 {
        return Err("cms: parse EnvelopedData: encryptedContentInfo truncated".to_string());
    }
    if !eci_kids[0].is_oid() {
        return Err(
            "cms: parse EnvelopedData: encryptedContentInfo contentType is not an OID".to_string(),
        );
    }
    if eci_kids[0].content != asn1::oid_data() {
        return Err(format!(
            "cms: unexpected encrypted content type {} (want id-data)",
            asn1::format_oid(eci_kids[0].content)
        ));
    }
    let content_alg = parse_algorithm_identifier(&eci_kids[1])
        .map_err(|e| format!("cms: parse EnvelopedData: {e}"))?;

    // encryptedContent is [0] IMPLICIT OCTET STRING OPTIONAL. KMS emits it
    // either as a PRIMITIVE [0] (octets directly) or — under indefinite-length
    // BER — as a CONSTRUCTED [0] wrapping segmented OCTET STRINGs, in which
    // case the content still carries the inner segment headers; concatenate
    // them to recover the ciphertext.
    let ct: Vec<u8>;
    if eci_kids.len() >= 3 {
        if !eci_kids[2].is_context0() {
            return Err("cms: parse EnvelopedData: encryptedContent is not [0]".to_string());
        }
        if eci_kids[2].is_constructed() {
            ct = concat_octet_segments(eci_kids[2].content)
                .map_err(|e| format!("cms: join segmented encryptedContent: {e}"))?;
        } else {
            ct = eci_kids[2].content.to_vec();
        }
    } else {
        ct = Vec::new();
    }
    if ct.is_empty() {
        return Err("cms: empty encryptedContent".to_string());
    }

    if content_alg.oid == asn1::oid_aes256_cbc() {
        decrypt_aes256_cbc(&cek, &content_alg.parameters, &ct)
    } else if content_alg.oid == asn1::oid_aes256_gcm() {
        decrypt_aes256_gcm(&cek, &content_alg.parameters, &ct)
    } else {
        Err(format!(
            "cms: unsupported content encryption algorithm {}",
            asn1::format_oid(content_alg.oid)
        ))
    }
}

/// Decrypts AES-256-CBC content. The IV is the algorithm parameter, encoded as
/// an OCTET STRING. PKCS#7 padding is stripped.
fn decrypt_aes256_cbc(cek: &[u8], params_der: &[u8], ct: &[u8]) -> AttestResult<Vec<u8>> {
    if cek.len() != 32 {
        return Err(format!(
            "cms: AES-256-CBC requires a 32-byte CEK, got {}",
            cek.len()
        ));
    }
    if params_der.is_empty() {
        return Err("cms: parse AES-CBC IV: unexpected EOF".to_string());
    }
    let (iv_tlv, _) = Tlv::parse(params_der).map_err(|e| format!("cms: parse AES-CBC IV: {e}"))?;
    if !iv_tlv.is_octet_string() {
        return Err("cms: parse AES-CBC IV: not an OCTET STRING".to_string());
    }
    let iv = iv_tlv.content;
    if iv.len() != 16 {
        return Err(format!(
            "cms: AES-CBC IV must be 16 bytes, got {}",
            iv.len()
        ));
    }
    if ct.is_empty() || !ct.len().is_multiple_of(16) {
        return Err(format!(
            "cms: AES-CBC ciphertext length {} is not a block multiple",
            ct.len()
        ));
    }

    let block =
        aes::Aes256::new_from_slice(cek).map_err(|e| format!("cms: new AES cipher: {e}"))?;
    let mut out = Vec::with_capacity(ct.len());
    let mut prev = [0u8; 16];
    prev.copy_from_slice(iv);
    for chunk in ct.as_chunks::<16>().0 {
        let mut buf = GenericArray::clone_from_slice(chunk);
        block.decrypt_block(&mut buf);
        for (b, p) in buf.iter_mut().zip(prev.iter()) {
            *b ^= p;
        }
        out.extend_from_slice(&buf);
        // CBC needs the ORIGINAL previous ciphertext, not the decrypted one.
        prev.copy_from_slice(chunk);
    }

    Ok(pkcs7_unpad(&out, 16)?.to_vec())
}

/// Decrypts AES-256-GCM content (forward-compat path). The parameters carry
/// the nonce, either as a GCMParameters SEQUENCE or as a bare OCTET STRING;
/// KMS does not currently use GCM here. Deliberate divergence from cms.go:
/// only the standard 12-byte nonce is accepted (cms.go supports any nonce
/// size via NewGCMWithNonceSize).
fn decrypt_aes256_gcm(cek: &[u8], params_der: &[u8], ct: &[u8]) -> AttestResult<Vec<u8>> {
    if cek.len() != 32 {
        return Err(format!(
            "cms: AES-256-GCM requires a 32-byte CEK, got {}",
            cek.len()
        ));
    }
    if params_der.is_empty() {
        return Err("cms: parse AES-GCM params: unexpected EOF".to_string());
    }
    let (params, _) =
        Tlv::parse(params_der).map_err(|e| format!("cms: parse AES-GCM params: {e}"))?;
    // GCMParameters ::= SEQUENCE { aes-nonce OCTET STRING, aes-ICVlen INTEGER
    // DEFAULT 12 }. Some encoders place the nonce as a bare OCTET STRING.
    let nonce: &[u8] = if params.is_sequence() {
        let kids = asn1::children(params.content)
            .map_err(|e| format!("cms: parse AES-GCM params: {e}"))?;
        if kids.is_empty() || !kids[0].is_octet_string() {
            return Err("cms: parse AES-GCM params: missing aes-nonce".to_string());
        }
        // aes-ICVlen is parsed by the Go version but unused: the CMS format
        // appends the auth tag to the ciphertext, so its length is implicit.
        kids[0].content
    } else if params.is_octet_string() {
        params.content
    } else {
        return Err("cms: parse AES-GCM params: unexpected structure".to_string());
    };
    if nonce.is_empty() {
        return Err("cms: empty AES-GCM nonce".to_string());
    }
    if nonce.len() != 12 {
        return Err(format!(
            "cms: AES-GCM nonce must be 12 bytes, got {}",
            nonce.len()
        ));
    }

    let cipher = Aes256Gcm::new_from_slice(cek).map_err(|e| format!("cms: new GCM: {e}"))?;
    cipher
        .decrypt(aes_gcm::Nonce::from_slice(nonce), ct)
        .map_err(|_| "cms: AES-GCM open: message authentication failed".to_string())
}

/// Removes and validates PKCS#7 padding for the given block size. Written to
/// avoid leaking the pad length through early returns where practical
/// (constant-time XOR-accumulate over the trailing pad bytes, mirroring
/// cms.go's subtle.ConstantTimeCompare).
pub fn pkcs7_unpad(data: &[u8], block_size: usize) -> AttestResult<&[u8]> {
    if block_size == 0 || block_size > 255 {
        return Err(format!("cms: invalid block size {block_size}"));
    }
    let n = data.len();
    if n == 0 || !n.is_multiple_of(block_size) {
        return Err(format!(
            "cms: padded data length {n} is not a block multiple"
        ));
    }
    let pad = data[n - 1] as usize;
    if pad == 0 || pad > block_size || pad > n {
        return Err("cms: invalid PKCS#7 padding length".to_string());
    }
    // All pad bytes must equal `pad`. Accumulate the difference in constant
    // time over the (public) block size.
    let mut diff = 0u8;
    for &byte in &data[n - pad..] {
        diff |= byte ^ pad as u8;
    }
    if diff != 0 {
        return Err("cms: invalid PKCS#7 padding bytes".to_string());
    }
    Ok(&data[..n - pad])
}
