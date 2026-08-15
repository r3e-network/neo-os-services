package main

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/asn1"
	"testing"
)

// buildKMSLikeEnvelopedData constructs a CMS EnvelopedData with the same
// structure AWS KMS produces for a Nitro Recipient:
//   - one KeyTransRecipientInfo, RSAES-OAEP-SHA256-wrapping the CEK
//   - AES-256-CBC encryptedContent with the IV in the algorithm parameters
//   - PKCS#7-padded plaintext
//
// It returns the DER of the full ContentInfo wrapper (and, if wrap=false, just
// the EnvelopedData SEQUENCE) so both shapes can be exercised.
func buildKMSLikeEnvelopedData(t *testing.T, pub *rsa.PublicKey, cek, iv, plaintext []byte, wrap bool) []byte {
	t.Helper()

	// RSA-OAEP-SHA256 wrap the CEK to the recipient public key.
	encKey, err := rsa.EncryptOAEP(sha256.New(), rand.Reader, pub, cek, nil)
	if err != nil {
		t.Fatalf("EncryptOAEP: %v", err)
	}

	// AES-256-CBC encrypt the PKCS#7-padded plaintext.
	block, err := aes.NewCipher(cek)
	if err != nil {
		t.Fatalf("NewCipher: %v", err)
	}
	padded := pkcs7Pad(plaintext, aes.BlockSize)
	ct := make([]byte, len(padded))
	cipher.NewCBCEncrypter(block, iv).CryptBlocks(ct, padded)

	// IV is encoded as an OCTET STRING in the algorithm parameters.
	ivDER, err := asn1.Marshal(iv)
	if err != nil {
		t.Fatalf("marshal IV: %v", err)
	}

	ktri := keyTransRecipientInfo{
		Version: 0,
		// A minimal issuerAndSerialNumber-style rid; the decrypter ignores it.
		Rid:                    asn1.RawValue{FullBytes: mustMarshal(t, struct{ Serial int }{Serial: 1})},
		KeyEncryptionAlgorithm: algorithmIdentifier{Algorithm: oidRSAESOAEP},
		EncryptedKey:           encKey,
	}
	ktriDER := mustMarshal(t, ktri)

	// recipientInfos ::= SET OF RecipientInfo (one element).
	recipientInfos := asn1.RawValue{
		Class:      asn1.ClassUniversal,
		Tag:        asn1.TagSet,
		IsCompound: true,
		Bytes:      ktriDER,
	}

	eci := encryptedContentInfo{
		ContentType: oidData,
		ContentEncryptionAlgorithm: algorithmIdentifier{
			Algorithm:  oidAES256CBC,
			Parameters: asn1.RawValue{FullBytes: ivDER},
		},
		// encryptedContent ::= [0] IMPLICIT OCTET STRING.
		EncryptedContent: asn1.RawValue{
			Class:      asn1.ClassContextSpecific,
			Tag:        0,
			IsCompound: false,
			Bytes:      ct,
		},
	}

	env := envelopedData{
		Version:              0,
		RecipientInfos:       recipientInfos,
		EncryptedContentInfo: eci,
	}
	envDER := mustMarshal(t, env)

	if !wrap {
		return envDER
	}

	// Wrap as ContentInfo ::= SEQUENCE { contentType OID, content [0] EXPLICIT }.
	// The [0] EXPLICIT wrapper is a compound context-specific tag whose content
	// octets are the complete inner EnvelopedData TLV. We assemble the SEQUENCE
	// from a marshaled OID + the explicit wrapper so the [0] tag is emitted
	// exactly as KMS produces it (a struct field tag is not honored for a
	// RawValue carrying FullBytes, which is what tripped an earlier version).
	oidDER := mustMarshal(t, oidEnvelopedData)
	explicit := mustMarshal(t, asn1.RawValue{
		Class:      asn1.ClassContextSpecific,
		Tag:        0,
		IsCompound: true,
		Bytes:      envDER,
	})
	seqBody := append(append([]byte{}, oidDER...), explicit...)
	ci := asn1.RawValue{
		Class:      asn1.ClassUniversal,
		Tag:        asn1.TagSequence,
		IsCompound: true,
		Bytes:      seqBody,
	}
	return mustMarshal(t, ci)
}

func mustMarshal(t *testing.T, v any) []byte {
	t.Helper()
	b, err := asn1.Marshal(v)
	if err != nil {
		t.Fatalf("asn1.Marshal(%T): %v", v, err)
	}
	return b
}

// pkcs7Pad applies PKCS#7 padding (test helper / inverse of pkcs7Unpad).
func pkcs7Pad(data []byte, blockSize int) []byte {
	pad := blockSize - (len(data) % blockSize)
	return append(append([]byte{}, data...), bytes.Repeat([]byte{byte(pad)}, pad)...)
}

func TestDecryptCMSEnvelopedData_RoundTrip(t *testing.T) {
	priv, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}

	cek := make([]byte, 32)
	if _, err := rand.Read(cek); err != nil {
		t.Fatalf("read cek: %v", err)
	}
	iv := make([]byte, aes.BlockSize)
	if _, err := rand.Read(iv); err != nil {
		t.Fatalf("read iv: %v", err)
	}

	cases := map[string][]byte{
		"short":               []byte("hello nitro"),
		"empty":               {},
		"exact-block":         bytes.Repeat([]byte("A"), aes.BlockSize),     // forces a full extra pad block
		"multi-block":         bytes.Repeat([]byte("Z"), aes.BlockSize*3+7), // 55 bytes
		"binary-key-material": mustRandom(t, 32),
	}

	for name, pt := range cases {
		pt := pt
		t.Run("wrapped/"+name, func(t *testing.T) {
			der := buildKMSLikeEnvelopedData(t, &priv.PublicKey, cek, iv, pt, true)
			got, err := decryptCMSEnvelopedData(der, priv)
			if err != nil {
				t.Fatalf("decryptCMSEnvelopedData: %v", err)
			}
			if !bytes.Equal(got, pt) {
				t.Fatalf("plaintext mismatch:\n got=%x\nwant=%x", got, pt)
			}
		})
		t.Run("bare/"+name, func(t *testing.T) {
			der := buildKMSLikeEnvelopedData(t, &priv.PublicKey, cek, iv, pt, false)
			got, err := decryptCMSEnvelopedData(der, priv)
			if err != nil {
				t.Fatalf("decryptCMSEnvelopedData (bare): %v", err)
			}
			if !bytes.Equal(got, pt) {
				t.Fatalf("plaintext mismatch (bare):\n got=%x\nwant=%x", got, pt)
			}
		})
	}
}

func mustRandom(t *testing.T, n int) []byte {
	t.Helper()
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		t.Fatalf("rand: %v", err)
	}
	return b
}

func TestDecryptCMSEnvelopedData_WrongKey(t *testing.T) {
	priv, _ := rsa.GenerateKey(rand.Reader, 2048)
	other, _ := rsa.GenerateKey(rand.Reader, 2048)

	cek := mustRandom(t, 32)
	iv := mustRandom(t, aes.BlockSize)
	der := buildKMSLikeEnvelopedData(t, &priv.PublicKey, cek, iv, []byte("secret"), true)

	if _, err := decryptCMSEnvelopedData(der, other); err == nil {
		t.Fatal("expected error decrypting with the wrong RSA key, got nil")
	}
}

func TestDecryptCMSEnvelopedData_Errors(t *testing.T) {
	priv, _ := rsa.GenerateKey(rand.Reader, 2048)

	if _, err := decryptCMSEnvelopedData(nil, priv); err == nil {
		t.Fatal("expected error for empty input")
	}
	if _, err := decryptCMSEnvelopedData([]byte{0x01, 0x02}, priv); err == nil {
		t.Fatal("expected error for garbage input")
	}
	if _, err := decryptCMSEnvelopedData([]byte{0x30, 0x03, 0x02, 0x01, 0x00}, nil); err == nil {
		t.Fatal("expected error for nil key")
	}
}

func TestPKCS7Unpad(t *testing.T) {
	bs := aes.BlockSize

	t.Run("valid-full-block", func(t *testing.T) {
		// 16 bytes of value 0x10 is a valid full padding block.
		in := bytes.Repeat([]byte{byte(bs)}, bs)
		out, err := pkcs7Unpad(in, bs)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(out) != 0 {
			t.Fatalf("expected empty output, got %x", out)
		}
	})

	t.Run("valid-one-byte-pad", func(t *testing.T) {
		in := append(bytes.Repeat([]byte{0xAA}, bs-1), 0x01)
		out, err := pkcs7Unpad(in, bs)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if !bytes.Equal(out, bytes.Repeat([]byte{0xAA}, bs-1)) {
			t.Fatalf("unexpected output %x", out)
		}
	})

	t.Run("roundtrip-all-lengths", func(t *testing.T) {
		for n := 0; n <= bs*2; n++ {
			data := bytes.Repeat([]byte{0x5A}, n)
			padded := pkcs7Pad(data, bs)
			if len(padded)%bs != 0 {
				t.Fatalf("pad produced non-block length %d for n=%d", len(padded), n)
			}
			out, err := pkcs7Unpad(padded, bs)
			if err != nil {
				t.Fatalf("unpad n=%d: %v", n, err)
			}
			if !bytes.Equal(out, data) {
				t.Fatalf("roundtrip mismatch n=%d", n)
			}
		}
	})

	t.Run("pad-zero", func(t *testing.T) {
		in := append(bytes.Repeat([]byte{0x00}, bs-1), 0x00)
		if _, err := pkcs7Unpad(in, bs); err == nil {
			t.Fatal("expected error for zero pad byte")
		}
	})

	t.Run("pad-too-large", func(t *testing.T) {
		in := append(bytes.Repeat([]byte{0x00}, bs-1), byte(bs+1))
		if _, err := pkcs7Unpad(in, bs); err == nil {
			t.Fatal("expected error for pad > block size")
		}
	})

	t.Run("inconsistent-pad-bytes", func(t *testing.T) {
		// Last byte says 0x03 but the preceding pad bytes don't all equal 0x03.
		in := bytes.Repeat([]byte{0x00}, bs)
		in[bs-1] = 0x03
		in[bs-2] = 0x03
		in[bs-3] = 0x02 // wrong
		if _, err := pkcs7Unpad(in, bs); err == nil {
			t.Fatal("expected error for inconsistent pad bytes")
		}
	})

	t.Run("non-block-length", func(t *testing.T) {
		if _, err := pkcs7Unpad([]byte{0x01, 0x02, 0x03}, bs); err == nil {
			t.Fatal("expected error for non-block-multiple length")
		}
	})

	t.Run("empty", func(t *testing.T) {
		if _, err := pkcs7Unpad(nil, bs); err == nil {
			t.Fatal("expected error for empty input")
		}
	})
}

// TestBERToDER verifies the indefinite-length BER -> DER transcoder that lets
// encoding/asn1 parse the KMS CiphertextForRecipient (which uses indefinite
// lengths and otherwise fails with "indefinite length found (not DER)").
func TestBERToDER(t *testing.T) {
	// DER: SEQUENCE { INTEGER 1, OCTET STRING "hello" } — content is 10 bytes.
	der := []byte{0x30, 0x0a, 0x02, 0x01, 0x01, 0x04, 0x05, 'h', 'e', 'l', 'l', 'o'}
	// Same value, indefinite-length BER (0x80 length, 0x00 0x00 end-of-contents).
	ber := []byte{0x30, 0x80, 0x02, 0x01, 0x01, 0x04, 0x05, 'h', 'e', 'l', 'l', 'o', 0x00, 0x00}
	got, err := berToDER(ber)
	if err != nil {
		t.Fatalf("berToDER(ber): %v", err)
	}
	if !bytes.Equal(got, der) {
		t.Fatalf("berToDER mismatch:\n got %x\nwant %x", got, der)
	}
	// Already-DER input must pass through byte-for-byte.
	if got2, err := berToDER(der); err != nil || !bytes.Equal(got2, der) {
		t.Fatalf("DER passthrough: got %x err %v", got2, err)
	}
	// Nested indefinite: SEQUENCE { SEQUENCE { INTEGER 1 } }.
	nestedBER := []byte{0x30, 0x80, 0x30, 0x80, 0x02, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00}
	nestedDER := []byte{0x30, 0x05, 0x30, 0x03, 0x02, 0x01, 0x01}
	if got3, err := berToDER(nestedBER); err != nil || !bytes.Equal(got3, nestedDER) {
		t.Fatalf("nested: got %x want %x err %v", got3, nestedDER, err)
	}
	// The converted DER must parse with encoding/asn1.
	var v struct {
		N int
		S []byte
	}
	if _, err := asn1.Unmarshal(got, &v); err != nil {
		t.Fatalf("asn1.Unmarshal(converted): %v", err)
	}
	if v.N != 1 || string(v.S) != "hello" {
		t.Fatalf("parsed values wrong: %+v", v)
	}
}

// TestConcatOctetSegments verifies the segmented-OCTET-STRING joiner used for the
// KMS encryptedContent emitted as a constructed [0] OCTET STRING under BER.
func TestConcatOctetSegments(t *testing.T) {
	// Two short-form primitive OCTET STRING segments.
	in := []byte{0x04, 0x03, 'a', 'b', 'c', 0x04, 0x02, 'd', 'e'}
	if got, err := concatOctetSegments(in); err != nil || string(got) != "abcde" {
		t.Fatalf("two-segment: got %q err %v", got, err)
	}
	// Single long-form segment.
	in2 := []byte{0x04, 0x81, 0x03, 'x', 'y', 'z'}
	if got, err := concatOctetSegments(in2); err != nil || string(got) != "xyz" {
		t.Fatalf("long-form: got %q err %v", got, err)
	}
	// A non-OCTET-STRING segment is rejected.
	if _, err := concatOctetSegments([]byte{0x30, 0x01, 0x00}); err == nil {
		t.Fatalf("expected rejection of non-OCTET-STRING segment")
	}
}
