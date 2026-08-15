// CMS (RFC 5652) EnvelopedData parsing + decryption for the KMS
// "CiphertextForRecipient" returned to a Nitro enclave Recipient.
//
// KMS, when given a Nitro Recipient, returns the requested plaintext re-wrapped
// as a CMS EnvelopedData:
//
//	ContentInfo ::= SEQUENCE {
//	  contentType  OBJECT IDENTIFIER (id-envelopedData 1.2.840.113549.1.7.3),
//	  content      [0] EXPLICIT EnvelopedData }
//
//	EnvelopedData ::= SEQUENCE {
//	  version               INTEGER,
//	  recipientInfos        SET OF RecipientInfo,   -- a single KeyTransRecipientInfo
//	  encryptedContentInfo  EncryptedContentInfo }
//
//	KeyTransRecipientInfo ::= SEQUENCE {
//	  version                 INTEGER,
//	  rid                     RecipientIdentifier,   -- issuerAndSerial | [0] SKI
//	  keyEncryptionAlgorithm  AlgorithmIdentifier,   -- RSAES-OAEP (SHA-256)
//	  encryptedKey            OCTET STRING }         -- OAEP-wrapped CEK
//
//	EncryptedContentInfo ::= SEQUENCE {
//	  contentType                 OBJECT IDENTIFIER (id-data),
//	  contentEncryptionAlgorithm  AlgorithmIdentifier,  -- AES-256-CBC, IV in params
//	  encryptedContent            [0] IMPLICIT OCTET STRING OPTIONAL }
//
// The recovered CEK RSA-OAEP-unwraps with SHA-256, and the content decrypts
// under AES-256-CBC (with the IV from the algorithm parameters), after which
// PKCS#7 padding is stripped.
//
// This file deliberately uses only the standard library so the enclave build
// has no extra dependencies for the security-critical crypto path.
package main

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/asn1"
	"errors"
	"fmt"
)

// Object identifiers used by the KMS-for-Nitro CMS structure.
var (
	oidEnvelopedData = asn1.ObjectIdentifier{1, 2, 840, 113549, 1, 7, 3}
	oidData          = asn1.ObjectIdentifier{1, 2, 840, 113549, 1, 7, 1}
	oidRSAESOAEP     = asn1.ObjectIdentifier{1, 2, 840, 113549, 1, 1, 7}
	oidAES256CBC     = asn1.ObjectIdentifier{2, 16, 840, 1, 101, 3, 4, 1, 42}
	oidAES256GCM     = asn1.ObjectIdentifier{2, 16, 840, 1, 101, 3, 4, 1, 46}
)

// contentInfo is the outer RFC 5652 wrapper. The content is tagged [0] EXPLICIT.
type contentInfo struct {
	ContentType asn1.ObjectIdentifier
	Content     asn1.RawValue `asn1:"explicit,tag:0"`
}

// envelopedData is the EnvelopedData SEQUENCE. originatorInfo ([0] IMPLICIT)
// and unprotectedAttrs ([1] IMPLICIT) are optional and not produced by KMS, so
// they are intentionally omitted; any trailing optional fields are ignored by
// encoding/asn1 because we decode the SET and the SEQUENCE explicitly below.
type envelopedData struct {
	Version              int
	RecipientInfos       asn1.RawValue // SET OF RecipientInfo (decoded manually)
	EncryptedContentInfo encryptedContentInfo
}

// keyTransRecipientInfo is the single recipient KMS targets at the enclave.
type keyTransRecipientInfo struct {
	Version                int
	Rid                    asn1.RawValue       // RecipientIdentifier (issuerAndSerial or [0] SKI)
	KeyEncryptionAlgorithm algorithmIdentifier // RSAES-OAEP
	EncryptedKey           []byte              // OCTET STRING: OAEP-wrapped CEK
}

// algorithmIdentifier with optional parameters carried as raw ASN.1.
type algorithmIdentifier struct {
	Algorithm  asn1.ObjectIdentifier
	Parameters asn1.RawValue `asn1:"optional"`
}

// encryptedContentInfo holds the symmetric algorithm + IV and the ciphertext.
// The encryptedContent is [0] IMPLICIT OCTET STRING OPTIONAL.
type encryptedContentInfo struct {
	ContentType                asn1.ObjectIdentifier
	ContentEncryptionAlgorithm algorithmIdentifier
	EncryptedContent           asn1.RawValue `asn1:"optional,tag:0"`
}

// berToDER transcodes a BER-encoded structure into DER. AWS KMS returns the
// Nitro CiphertextForRecipient CMS EnvelopedData using indefinite-length BER
// (constructed elements with a 0x80 length octet, terminated by an
// end-of-contents 0x00 0x00), which Go's encoding/asn1 rejects ("indefinite
// length found (not DER)"). This walks the TLV tree, recomputing definite
// lengths for constructed elements; primitive elements and already-definite
// lengths are preserved byte-for-byte. Stdlib only (the security-critical path
// keeps no extra dependencies).
func berToDER(ber []byte) ([]byte, error) {
	var out bytes.Buffer
	rest, err := convertTLV(ber, &out)
	if err != nil {
		return nil, err
	}
	for _, b := range rest { // tolerate only trailing end-of-contents padding
		if b != 0x00 {
			return nil, errors.New("ber: unexpected trailing data after top-level element")
		}
	}
	return out.Bytes(), nil
}

// convertTLV consumes exactly one TLV from in, writes its DER form to out, and
// returns the unconsumed remainder.
func convertTLV(in []byte, out *bytes.Buffer) ([]byte, error) {
	if len(in) < 2 {
		return nil, errors.New("ber: truncated TLV")
	}
	idByte := in[0]
	constructed := idByte&0x20 != 0
	i := 1
	if idByte&0x1f == 0x1f { // high-tag-number form: octets until MSB clear
		for {
			if i >= len(in) {
				return nil, errors.New("ber: truncated identifier")
			}
			c := in[i]
			i++
			if c&0x80 == 0 {
				break
			}
		}
	}
	tag := in[:i]
	if i >= len(in) {
		return nil, errors.New("ber: missing length")
	}
	lb := in[i]
	i++

	if lb == 0x80 { // indefinite length — constructed only, ends at 0x00 0x00
		if !constructed {
			return nil, errors.New("ber: indefinite length on a primitive element")
		}
		rest := in[i:]
		var children bytes.Buffer
		for {
			if len(rest) < 2 {
				return nil, errors.New("ber: missing end-of-contents")
			}
			if rest[0] == 0x00 && rest[1] == 0x00 {
				rest = rest[2:]
				break
			}
			var err error
			rest, err = convertTLV(rest, &children)
			if err != nil {
				return nil, err
			}
		}
		writeTagLen(out, tag, children.Len())
		out.Write(children.Bytes())
		return rest, nil
	}

	var length int
	if lb&0x80 == 0 {
		length = int(lb) // short form
	} else {
		n := int(lb & 0x7f) // long form
		if n == 0 || n > 4 {
			return nil, fmt.Errorf("ber: unsupported length-of-length %d", n)
		}
		if i+n > len(in) {
			return nil, errors.New("ber: truncated long-form length")
		}
		for k := 0; k < n; k++ {
			length = length<<8 | int(in[i+k])
		}
		i += n
	}
	if length < 0 || i+length > len(in) {
		return nil, errors.New("ber: content length exceeds buffer")
	}
	content := in[i : i+length]
	rest := in[i+length:]

	if !constructed {
		writeTagLen(out, tag, len(content))
		out.Write(content)
		return rest, nil
	}
	var children bytes.Buffer
	cr := content
	for len(cr) > 0 {
		var err error
		cr, err = convertTLV(cr, &children)
		if err != nil {
			return nil, err
		}
	}
	writeTagLen(out, tag, children.Len())
	out.Write(children.Bytes())
	return rest, nil
}

// writeTagLen emits the identifier octets followed by a DER definite length.
func writeTagLen(out *bytes.Buffer, tag []byte, length int) {
	out.Write(tag)
	if length < 0x80 {
		out.WriteByte(byte(length))
		return
	}
	var lenBytes []byte
	for l := length; l > 0; l >>= 8 {
		lenBytes = append([]byte{byte(l)}, lenBytes...)
	}
	out.WriteByte(byte(0x80 | len(lenBytes)))
	out.Write(lenBytes)
}

// concatOctetSegments concatenates the contents of a run of primitive OCTET
// STRING segments — the body of a constructed (segmented) OCTET STRING, which
// the indefinite-length BER CMS from KMS uses for the encryptedContent. After
// berToDER the segments are definite-length primitive OCTET STRINGs; this joins
// their octets back into the original ciphertext.
func concatOctetSegments(in []byte) ([]byte, error) {
	var out []byte
	rest := in
	for len(rest) > 0 {
		if len(rest) < 2 {
			return nil, errors.New("cms: truncated OCTET STRING segment")
		}
		tag := rest[0]
		i := 1
		lb := rest[i]
		i++
		var length int
		if lb&0x80 == 0 {
			length = int(lb)
		} else {
			n := int(lb & 0x7f)
			if n == 0 || n > 4 || i+n > len(rest) {
				return nil, errors.New("cms: bad OCTET STRING segment length")
			}
			for k := 0; k < n; k++ {
				length = length<<8 | int(rest[i+k])
			}
			i += n
		}
		if i+length > len(rest) {
			return nil, errors.New("cms: OCTET STRING segment exceeds buffer")
		}
		if tag != 0x04 {
			return nil, fmt.Errorf("cms: unexpected encryptedContent segment tag 0x%02x (want OCTET STRING)", tag)
		}
		out = append(out, rest[i:i+length]...)
		rest = rest[i+length:]
	}
	return out, nil
}

// decryptCMSEnvelopedData parses a CMS EnvelopedData (DER, optionally wrapped in
// the ContentInfo SEQUENCE) and decrypts it with the supplied RSA private key,
// returning the recovered plaintext. The wrapping key is unwrapped with
// RSAES-OAEP (SHA-256); the content is decrypted with AES-256-CBC (CEK + IV
// from the algorithm parameters). AES-256-GCM is also handled for forward
// compatibility should KMS switch ciphers.
func decryptCMSEnvelopedData(der []byte, priv *rsa.PrivateKey) ([]byte, error) {
	if priv == nil {
		return nil, errors.New("cms: nil private key")
	}
	if len(der) == 0 {
		return nil, errors.New("cms: empty input")
	}

	// KMS returns the CiphertextForRecipient as indefinite-length BER, which
	// encoding/asn1 cannot parse. Normalize to DER first (no-op if already DER).
	if normalized, err := berToDER(der); err != nil {
		return nil, fmt.Errorf("cms: normalize BER->DER: %w", err)
	} else {
		der = normalized
	}

	// The input may be either the bare EnvelopedData SEQUENCE or the full
	// ContentInfo wrapper. Try the wrapper first; if the OID matches
	// id-envelopedData, unwrap to the inner content.
	envBytes := der
	var ci contentInfo
	if rest, err := asn1.Unmarshal(der, &ci); err == nil && len(rest) == 0 && ci.ContentType.Equal(oidEnvelopedData) {
		// For a RawValue captured from an EXPLICIT [0] wrapper, .Bytes is the
		// content of the [0] tag, i.e. the complete inner EnvelopedData TLV
		// (its own SEQUENCE header included), which is what we re-parse below.
		// (.FullBytes would still carry the outer [0] wrapper.)
		envBytes = ci.Content.Bytes
	}

	var env envelopedData
	if _, err := asn1.Unmarshal(envBytes, &env); err != nil {
		return nil, fmt.Errorf("cms: parse EnvelopedData: %w", err)
	}

	// recipientInfos is a SET OF RecipientInfo. KMS emits exactly one
	// KeyTransRecipientInfo. Decode the first element of the SET.
	if env.RecipientInfos.Class != asn1.ClassUniversal || env.RecipientInfos.Tag != asn1.TagSet {
		return nil, fmt.Errorf("cms: recipientInfos is not a SET (class=%d tag=%d)", env.RecipientInfos.Class, env.RecipientInfos.Tag)
	}
	var ktri keyTransRecipientInfo
	riRest, err := asn1.Unmarshal(env.RecipientInfos.Bytes, &ktri)
	if err != nil {
		return nil, fmt.Errorf("cms: parse KeyTransRecipientInfo: %w", err)
	}
	if len(riRest) != 0 {
		// More than one recipient is unexpected from KMS-for-Nitro.
		return nil, errors.New("cms: expected exactly one recipientInfo")
	}
	if !ktri.KeyEncryptionAlgorithm.Algorithm.Equal(oidRSAESOAEP) {
		return nil, fmt.Errorf("cms: unexpected key encryption algorithm %v (want RSAES-OAEP)", ktri.KeyEncryptionAlgorithm.Algorithm)
	}
	if len(ktri.EncryptedKey) == 0 {
		return nil, errors.New("cms: empty encryptedKey")
	}

	// Unwrap the content-encryption key with RSA-OAEP / SHA-256.
	cek, err := rsa.DecryptOAEP(sha256.New(), rand.Reader, priv, ktri.EncryptedKey, nil)
	if err != nil {
		return nil, fmt.Errorf("cms: RSA-OAEP unwrap CEK: %w", err)
	}

	eci := env.EncryptedContentInfo
	if !eci.ContentType.Equal(oidData) {
		return nil, fmt.Errorf("cms: unexpected encrypted content type %v (want id-data)", eci.ContentType)
	}

	// The encryptedContent is [0] IMPLICIT OCTET STRING. KMS emits it either as a
	// PRIMITIVE [0] (octets directly in .Bytes) or — under indefinite-length BER —
	// as a CONSTRUCTED [0] wrapping segmented OCTET STRINGs, in which case .Bytes
	// still carries the inner segment headers; concatenate them to recover the
	// ciphertext.
	ct := eci.EncryptedContent.Bytes
	if eci.EncryptedContent.IsCompound {
		joined, err := concatOctetSegments(ct)
		if err != nil {
			return nil, fmt.Errorf("cms: join segmented encryptedContent: %w", err)
		}
		ct = joined
	}
	if len(ct) == 0 {
		return nil, errors.New("cms: empty encryptedContent")
	}

	switch {
	case eci.ContentEncryptionAlgorithm.Algorithm.Equal(oidAES256CBC):
		return decryptAES256CBC(cek, eci.ContentEncryptionAlgorithm.Parameters.FullBytes, ct)
	case eci.ContentEncryptionAlgorithm.Algorithm.Equal(oidAES256GCM):
		return decryptAES256GCM(cek, eci.ContentEncryptionAlgorithm.Parameters.FullBytes, ct)
	default:
		return nil, fmt.Errorf("cms: unsupported content encryption algorithm %v", eci.ContentEncryptionAlgorithm.Algorithm)
	}
}

// decryptAES256CBC decrypts AES-256-CBC content. The IV is the algorithm
// parameter, encoded as an OCTET STRING. PKCS#7 padding is stripped.
func decryptAES256CBC(cek, paramDER, ct []byte) ([]byte, error) {
	if len(cek) != 32 {
		return nil, fmt.Errorf("cms: AES-256-CBC requires a 32-byte CEK, got %d", len(cek))
	}
	var iv []byte
	if _, err := asn1.Unmarshal(paramDER, &iv); err != nil {
		return nil, fmt.Errorf("cms: parse AES-CBC IV: %w", err)
	}
	if len(iv) != aes.BlockSize {
		return nil, fmt.Errorf("cms: AES-CBC IV must be %d bytes, got %d", aes.BlockSize, len(iv))
	}
	if len(ct) == 0 || len(ct)%aes.BlockSize != 0 {
		return nil, fmt.Errorf("cms: AES-CBC ciphertext length %d is not a block multiple", len(ct))
	}

	block, err := aes.NewCipher(cek)
	if err != nil {
		return nil, fmt.Errorf("cms: new AES cipher: %w", err)
	}
	out := make([]byte, len(ct))
	cipher.NewCBCDecrypter(block, iv).CryptBlocks(out, ct)

	return pkcs7Unpad(out, aes.BlockSize)
}

// decryptAES256GCM decrypts AES-256-GCM content (forward-compat path). The
// parameters carry the nonce (and optionally tag length / AAD); KMS does not
// currently use GCM here, so only the nonce form is handled.
func decryptAES256GCM(cek, paramDER, ct []byte) ([]byte, error) {
	if len(cek) != 32 {
		return nil, fmt.Errorf("cms: AES-256-GCM requires a 32-byte CEK, got %d", len(cek))
	}
	// GCMParameters ::= SEQUENCE { aes-nonce OCTET STRING, aes-ICVlen INTEGER DEFAULT 12 }
	var params struct {
		Nonce  []byte
		ICVLen int `asn1:"optional,default:12"`
	}
	if _, err := asn1.Unmarshal(paramDER, &params); err != nil {
		// Some encoders place the nonce as a bare OCTET STRING.
		var nonce []byte
		if _, err2 := asn1.Unmarshal(paramDER, &nonce); err2 != nil {
			return nil, fmt.Errorf("cms: parse AES-GCM params: %w", err)
		}
		params.Nonce = nonce
		params.ICVLen = 16
	}
	if len(params.Nonce) == 0 {
		return nil, errors.New("cms: empty AES-GCM nonce")
	}

	block, err := aes.NewCipher(cek)
	if err != nil {
		return nil, fmt.Errorf("cms: new AES cipher: %w", err)
	}
	gcm, err := cipher.NewGCMWithNonceSize(block, len(params.Nonce))
	if err != nil {
		return nil, fmt.Errorf("cms: new GCM: %w", err)
	}
	// In CMS, the GCM auth tag is appended to the ciphertext.
	pt, err := gcm.Open(nil, params.Nonce, ct, nil)
	if err != nil {
		return nil, fmt.Errorf("cms: AES-GCM open: %w", err)
	}
	return pt, nil
}

// pkcs7Unpad removes and validates PKCS#7 padding for the given block size.
// It is written to avoid leaking the pad length through early returns where
// practical (constant-time comparison of the trailing pad bytes).
func pkcs7Unpad(data []byte, blockSize int) ([]byte, error) {
	if blockSize <= 0 || blockSize > 255 {
		return nil, fmt.Errorf("cms: invalid block size %d", blockSize)
	}
	n := len(data)
	if n == 0 || n%blockSize != 0 {
		return nil, fmt.Errorf("cms: padded data length %d is not a block multiple", n)
	}
	pad := int(data[n-1])
	if pad == 0 || pad > blockSize || pad > n {
		return nil, errors.New("cms: invalid PKCS#7 padding length")
	}
	// All pad bytes must equal `pad`. Compare against a reference buffer in
	// constant time over the (public) block size.
	ref := bytes.Repeat([]byte{byte(pad)}, pad)
	if subtle.ConstantTimeCompare(data[n-pad:], ref) != 1 {
		return nil, errors.New("cms: invalid PKCS#7 padding bytes")
	}
	return data[:n-pad], nil
}
