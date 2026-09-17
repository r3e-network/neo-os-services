//! Nitro enclave attestation helpers — the Rust port of deploy/nitro/nsm-attest
//! (main.go + attest_linux.go + attest_unsupported.go + cms.go).
//!
//! Three concerns, one crate, no extra dependencies on the security-critical
//! path:
//! - [`nsm`] — the only module that touches /dev/nsm. Real implementation is
//!   Linux-only (`aws-nitro-enclaves-nsm-api` driver); every other platform
//!   gets the fail-closed stub from attest_unsupported.go.
//! - [`cms`] — RFC 5652 EnvelopedData decryption for the KMS
//!   CiphertextForRecipient blob: BER→DER transcode (KMS emits indefinite-
//!   length BER), RSAES-OAEP-SHA256 CEK unwrap, AES-256-CBC/GCM content
//!   decrypt, constant-time PKCS#7 unpad. Byte-level port of cms.go.
//! - [`kms`] — hand-rolled SigV4 + the KMS Decrypt JSON-API request builder.
//!   The signed request is returned as pure data so callers execute it with
//!   whatever HTTP client they run (the CLI uses reqwest::blocking; the
//!   enclave host can use its async client without re-signing logic).
//! - [`release`] — the orchestrated flow over the three above: ephemeral RSA
//!   keypair → attestation → KMS Decrypt → CMS open, behind testable
//!   `AttestationSource` / `KmsTransport` seams.
//!
//! The `nsm-attest-rs` binary mirrors the Go tool's CLI and stdout JSON shapes
//! so the two can be A/B compared on a Linux machine (JSON object keys are
//! emitted in the sorted order Go's map marshaling produces).
//!
//! Known divergences from the Go tool, all deliberate and listed here:
//! - AWS credentials come from AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY /
//!   AWS_SESSION_TOKEN env vars only (no shared-config/profile files) — the
//!   enclave passes credentials through env.
//! - Deep ASN.1 parse-error detail strings differ from Go's encoding/asn1
//!   chatter; the surrounding `cms: ...` prefixes match the Go tool.
//! - SigV4 error strings surface the raw status/type instead of the AWS SDK's
//!   multi-line operation-error chatter.
//! - AES-GCM supports the standard 12-byte nonce only (KMS does not use the
//!   GCM path today; cms.go accepts any nonce size via NewGCMWithNonceSize).

pub mod asn1;
pub mod ber;
pub mod cms;
pub mod kms;
pub mod nsm;
pub mod release;
pub mod session_key;

/// Errors surface as strings: the CLI embeds them into
/// `{"ok":false,"error":...}` and every failure path here has a Go-tool
/// counterpart message.
pub type AttestResult<T> = Result<T, String>;
