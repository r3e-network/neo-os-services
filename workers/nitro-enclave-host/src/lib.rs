//! The enclave's trusted frontier: the Rust process that faces the vsock
//! traffic, holds the route table, the bearer-token auth, `/provision`'s
//! state machine and `/attestation`'s binding — and nothing else that could
//! serve a key.
//!
//! This is the Rust replacement for `deploy/nitro/enclave-server.mjs`. The
//! production image has one execution engine:
//!
//! * **This crate** (the host) is the only thing the outside world reaches.
//!   It authenticates, classifies, provisions, attests, and translates
//!   signing intents into custody calls over loopback. It holds no private
//!   key material at all — that is the property that makes the frontier
//!   auditable. `/sign/payload` is a policy-enforcing custody client, never a
//!   local signing fallback.
//! * **`neo-os-compute`** serves migrated compute, oracle, NeoDID, and policy
//!   code in-process. **`neo-os-games`** owns the generic confidential session
//!   protocol and all 11 registered game engines. No Node child or loopback
//!   execution bridge exists in the measured host. Unmigrated fulfillment
//!   request types terminate at the deterministic no-IO boundary in [`bridge`].
//!
//! The pure core of this crate is [`dispatch`]: `(method, raw_url, headers,
//! body) -> (status, json body)`, no socket, exactly like the Node server's
//! `dispatch()` — which is what lets the Node test file's dispatch fixtures
//! port directly and the two implementations be diffed over HTTP.

pub mod attestation;
pub mod auth;
pub mod automation;
pub mod bridge;
pub mod compute_execute;
pub mod custody;
pub mod dispatch;
pub mod feed_sign;
pub mod fulfill;
pub mod health;
pub mod kms_release;
pub mod neodid;
pub mod oracle_feed;
pub mod oracle_read;
pub mod overlay;
pub mod paymaster;
pub mod provision;
pub mod routes;
pub mod session;
pub mod sign;
pub mod state;
pub mod vrf;

/// The runtime name the Node server puts in every error and health body; the
/// Rust host keeps it byte-identical so HTTP-parity tests cannot tell the two
/// implementations apart during the cutover.
pub const RUNTIME_NAME: &str = "morpheus-enclave-server";

/// What a dispatch failure looks like. The Node server throws
/// `httpError(status, message)` and its catch-all renders
/// `{status:'error', error, runtime}`; this is the same thing as a value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeError {
    pub status: u16,
    pub message: String,
}

/// `httpError(status, message)` — the constructor the Node dispatch reads as
/// `throw`.
pub fn http_error(status: u16, message: impl Into<String>) -> RuntimeError {
    RuntimeError {
        status,
        message: message.into(),
    }
}

impl RuntimeError {
    /// The catch-all's body shape (`enclave-server.mjs` dispatch's `catch`).
    pub fn body(&self) -> serde_json::Value {
        serde_json::json!({
            "status": "error",
            "error": self.message,
            "runtime": RUNTIME_NAME,
        })
    }
}

/// `(status, body)` — what `dispatch()` returns and the HTTP shim serializes.
#[derive(Debug, Clone, PartialEq)]
pub struct DispatchOutcome {
    pub status: u16,
    pub body: serde_json::Value,
}

impl DispatchOutcome {
    pub fn ok(body: serde_json::Value) -> Self {
        DispatchOutcome { status: 200, body }
    }

    pub fn error(error: &RuntimeError) -> Self {
        DispatchOutcome {
            status: error.status,
            body: error.body(),
        }
    }
}

/// `normalizeMorpheusNetwork` (`packages/shared/src/neo-signers-core.js:156`):
/// exactly `mainnet` after trim+lowercase, else `testnet`. The `?` is
/// deliberate — an unparsable value collapses to testnet the same way a wrong
/// one does, because a deployment that cannot spell mainnet must not get
/// mainnet.
pub fn normalize_network(value: Option<&str>) -> String {
    match value {
        Some(value) if value.trim().eq_ignore_ascii_case("mainnet") => "mainnet".to_string(),
        _ => "testnet".to_string(),
    }
}
