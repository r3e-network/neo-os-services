// nsm-attest: minimal AWS Nitro Security Module (NSM) attestation helper.
//
// Runs INSIDE the Nitro enclave. Two subcommands:
//
//	attest (default):
//	  Opens /dev/nsm, requests an attestation document (COSE_Sign1, signed by
//	  the AWS Nitro Attestation PKI) optionally bound to a caller-supplied
//	  nonce, user data, and public key, and prints the document base64-encoded
//	  as JSON on stdout.
//	  Output: {"ok":true,"attestation_b64":"..."} or {"ok":false,"error":"..."}.
//
//	kms-decrypt:
//	  Attestation-gated AWS KMS key release. Generates an ephemeral RSA-2048
//	  keypair, binds its public key (DER SubjectPublicKeyInfo) into a fresh NSM
//	  attestation document, and calls KMS Decrypt with a Nitro Recipient so a
//	  key policy conditioned on kms:RecipientAttestation only releases to this
//	  attested enclave. KMS returns the plaintext re-encrypted to the RSA public
//	  key as a CMS (RFC 5652) EnvelopedData (CiphertextForRecipient); this tool
//	  decrypts it locally with the RSA private key and prints the plaintext.
//	  Output: {"ok":true,"plaintext_b64":"..."} or {"ok":false,"error":"..."}.
//
// Back-compat: when invoked with no subcommand (or a leading flag), the tool
// behaves as `attest` so the existing enclave-server callers keep working.
package main

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"os"

	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/kms"
	"github.com/aws/aws-sdk-go-v2/service/kms/types"
	"github.com/hf/nsm"
	"github.com/hf/nsm/request"
)

func emit(v map[string]any, code int) {
	b, _ := json.Marshal(v)
	fmt.Println(string(b))
	os.Exit(code)
}

func fail(msg string) {
	emit(map[string]any{"ok": false, "error": msg}, 1)
}

func decodeHex(label, s string) []byte {
	if s == "" {
		return nil
	}
	b, err := hex.DecodeString(s)
	if err != nil {
		fail(fmt.Sprintf("invalid %s hex: %v", label, err))
	}
	return b
}

func main() {
	// Subcommand dispatch on os.Args[1]. Anything that is not a known
	// subcommand (including a leading flag such as -nonce, or no args at all)
	// falls through to the back-compat `attest` path.
	if len(os.Args) >= 2 {
		switch os.Args[1] {
		case "attest":
			runAttest(os.Args[2:])
			return
		case "kms-decrypt":
			runKMSDecrypt(os.Args[2:])
			return
		}
	}
	// No subcommand (or a leading flag): preserve the original behavior.
	runAttest(os.Args[1:])
}

// runAttest implements the original attestation behavior. Its flags and JSON
// output are intentionally identical to the pre-subcommand tool.
func runAttest(args []string) {
	fs := flag.NewFlagSet("attest", flag.ExitOnError)
	nonceHex := fs.String("nonce", "", "caller nonce (hex) for freshness")
	userDataHex := fs.String("user-data", "", "user data (hex) bound into the document")
	publicKeyHex := fs.String("public-key", "", "public key (hex) bound into the document")
	if err := fs.Parse(args); err != nil {
		fail(fmt.Sprintf("parse flags: %v", err))
	}

	nonce := decodeHex("nonce", *nonceHex)
	userData := decodeHex("user-data", *userDataHex)
	publicKey := decodeHex("public-key", *publicKeyHex)

	doc := attest(nonce, userData, publicKey)

	emit(map[string]any{
		"ok":              true,
		"attestation_b64": base64.StdEncoding.EncodeToString(doc),
		"document_len":    len(doc),
	}, 0)
}

// attest opens /dev/nsm and returns a fresh attestation document bound to the
// supplied fields. It calls fail() (which exits) on any error.
func attest(nonce, userData, publicKey []byte) []byte {
	sess, err := nsm.OpenDefaultSession()
	if err != nil {
		fail(fmt.Sprintf("open /dev/nsm: %v (not running inside a Nitro enclave?)", err))
	}
	defer sess.Close()

	res, err := sess.Send(&request.Attestation{
		Nonce:     nonce,
		UserData:  userData,
		PublicKey: publicKey,
	})
	if err != nil {
		fail(fmt.Sprintf("nsm attestation request: %v", err))
	}
	if res.Error != "" {
		fail(fmt.Sprintf("nsm error code: %s", string(res.Error)))
	}
	if res.Attestation == nil || len(res.Attestation.Document) == 0 {
		fail("nsm returned an empty attestation document")
	}
	return res.Attestation.Document
}

// runKMSDecrypt implements attestation-gated kms:Decrypt key release.
func runKMSDecrypt(args []string) {
	fs := flag.NewFlagSet("kms-decrypt", flag.ExitOnError)
	region := fs.String("region", "us-east-1", "AWS region for the KMS endpoint")
	ciphertextB64 := fs.String("ciphertext", "", "base64 of the KMS CiphertextBlob (required)")
	if err := fs.Parse(args); err != nil {
		fail(fmt.Sprintf("parse flags: %v", err))
	}

	if *ciphertextB64 == "" {
		fail("-ciphertext is required")
	}
	ciphertext, err := base64.StdEncoding.DecodeString(*ciphertextB64)
	if err != nil {
		fail(fmt.Sprintf("invalid -ciphertext base64: %v", err))
	}

	// a. Ephemeral RSA-2048 keypair (single use, never leaves the enclave).
	priv, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		fail(fmt.Sprintf("generate RSA key: %v", err))
	}

	// b. DER SubjectPublicKeyInfo of the RSA public key.
	derSPKI, err := x509.MarshalPKIXPublicKey(&priv.PublicKey)
	if err != nil {
		fail(fmt.Sprintf("marshal public key: %v", err))
	}

	// c. Attestation document binding that public key.
	attestationDoc := attest(nil, nil, derSPKI)

	// d. KMS Decrypt with a Nitro Recipient. The response's
	//    CiphertextForRecipient is the plaintext re-encrypted to derSPKI;
	//    Plaintext is nil when Recipient is set.
	ctx := context.Background()
	cfg, err := config.LoadDefaultConfig(ctx, config.WithRegion(*region))
	if err != nil {
		fail(fmt.Sprintf("load AWS config: %v", err))
	}
	client := kms.NewFromConfig(cfg)

	out, err := client.Decrypt(ctx, &kms.DecryptInput{
		CiphertextBlob: ciphertext,
		Recipient: &types.RecipientInfo{
			AttestationDocument:    attestationDoc,
			KeyEncryptionAlgorithm: types.KeyEncryptionMechanismRsaesOaepSha256,
		},
	})
	if err != nil {
		fail(fmt.Sprintf("kms decrypt: %v", err))
	}
	if len(out.CiphertextForRecipient) == 0 {
		fail("kms returned an empty CiphertextForRecipient (Recipient not honored?)")
	}

	// e. Decrypt the CMS EnvelopedData locally with the RSA private key.
	plaintext, err := decryptCMSEnvelopedData(out.CiphertextForRecipient, priv)
	if err != nil {
		fail(fmt.Sprintf("decrypt CiphertextForRecipient: %v", err))
	}

	// f. Emit the recovered plaintext.
	emit(map[string]any{
		"ok":            true,
		"plaintext_b64": base64.StdEncoding.EncodeToString(plaintext),
	}, 0)
}
