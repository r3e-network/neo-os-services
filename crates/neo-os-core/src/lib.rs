//! Single-sourced consensus layer for the Morpheus services.
//!
//! Everything in this crate is a byte-exact port of a Node implementation and
//! is pinned by golden vectors exported from that implementation (see
//! `scripts/export-rust-vectors.mjs` and `tests/vectors/`). The acceptance rule
//! for every module: for every fixture, the Rust output's sha256 equals the
//! Node oracle's sha256. A hash mismatch is a merge blocker, not a review note.
//!
//! Modules (landed with Phase 1):
//! - `cbor` — indefinite-length CBOR decode (port of packages/shared/src/cbor.js,
//!   including its limits and its "decode just enough" float->null behaviour)
//! - `cose` — Sig_structure encoding + ES384 r||s to DER (cose-verify.js)
//! - `stable_stringify` — key collation pinned to
//!   Intl.Collator('en', {sensitivity:'variant', caseFirst:'false'})
//! - `digest` / `envelope` / `kernel` — the fulfillment digest, the on-chain
//!   result envelope and the kernel intent table (morpheus-relayer/src/router.js)
//! - `error_codes` — deterministic error classification (shared/src/error-codes.js)
//! - `neo_encoding` — network-magic and uint256 word encoders
//!   (shared/src/neo-encoding.js)
//! - `js_value` / `js_number` / `js_json` — the JavaScript value model the
//!   digest paths are defined against: insertion-ordered objects, ECMAScript
//!   double formatting and JSON.stringify semantics. These are the substrate
//!   the byte-parity tests run on; without them serde_json's BTreeMap key
//!   order and ryu number styling would silently change hashes.
//!
//! Modules (T02 — relayer pure-logic sink):
//! - `config_schema` / `config` — the generated CONFIG_SCHEMA table (110
//!   entries / 153 aliases) and the alias-chain env resolution plus the pure
//!   field derivation of `createRelayerConfig()`, gate error strings included
//! - `state` — the relayer state machine: cursors, the processed-record LRU,
//!   retry queue with ceiling shed into dead letters, metrics snapshot
//! - `retry` — `computeRetryDelayMs` exponential backoff with jitter
//! - `cursor` — request cursor floor + checkpoint block validation
//! - `secret_redaction` — secret-name / secret-value log redaction
//! - `sponsor_intent` — the sponsorable intent decision for the DELIVER sponsor
//!   lane: script shape (`registerAccount`, `executeSponsoredUserOp`), target
//!   and fee ceiling, refused with a frozen code vocabulary. First-party, not a
//!   port; `n3_tx` gained its decoder half alongside it so the shape question is
//!   answered against the same wire definition that emits the script.
//!
//! Nothing here performs IO. Consumers: the enclave host, the custody service
//! (attestation binding) and, later, the Rust relayer.

use std::fmt;

/// Error type shared by every consensus-layer port. The message text mirrors
/// the Node implementation's error strings because the golden vectors pin them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoreError(pub String);

impl CoreError {
    pub fn new(message: impl Into<String>) -> Self {
        CoreError(message.into())
    }
}

impl fmt::Display for CoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for CoreError {}

pub type CoreResult<T> = Result<T, CoreError>;

pub mod base64;
pub mod cbor;
pub mod config;
pub mod config_schema;
pub mod cose;
pub mod cursor;
pub mod digest;
pub mod envelope;
pub mod error_codes;
pub mod js_json;
pub mod js_number;
pub mod js_value;
pub mod kernel;
pub mod n3_tx;
pub mod neo_encoding;
pub mod network_identity;
pub mod retry;
pub mod secret_redaction;
pub mod sponsor_intent;
pub mod stable_stringify;
pub mod state;

/// Lowercase hex encoding (Buffer.prototype.toString('hex')).
pub fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// sha256 over raw bytes.
pub fn sha256(bytes: &[u8]) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher.finalize().into()
}

/// sha256 over raw bytes, lowercase hex encoded.
pub fn sha256_hex(bytes: &[u8]) -> String {
    hex_encode(&sha256(bytes))
}
