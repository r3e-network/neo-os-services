//! neo-os-chain-n3 — Neo N3 chain adapter (T03).
//!
//! Ported from `workers/morpheus-relayer/src/neo-n3.js` + `custody.js`:
//!
//! - [`rpc`] — JSON-RPC client over an injected sync transport: URL failover
//!   with known-good promotion, the exact JS error strings, and typed wrappers
//!   for getblockcount / getblock / getapplicationlog / invokefunction /
//!   sendrawtransaction / calculatenetworkfee / getcontractstate.
//! - [`scan`] — block-window scans, n3index request cursors, per-id getRequest
//!   scans, duplicate/settled filtering, and the Neo VM stack-item decoder.
//! - [`tx`] — script/tx assembly via `neo-os-core::n3_tx` (vector-locked; no
//!   re-encoding here), test-invoke fee shaping, custody signing, broadcast,
//!   and confirm-until-HALT polling with an injected clock/sleeper.
//! - [`custody`] — the signer-service client: key identity lookup, raw-digest
//!   and transaction signing, refusal-envelope semantics (§5 SIGNER_SERVICE).
//! - [`ssrf`] — the SSRF guard for operator-configured RPC/indexer URLs:
//!   http/https only, resolve-then-classify, private/loopback/link-local/ULA/
//!   CGNAT/reserved rejection, decimal/hex/octal IPv4 bypass detection.
//!
//! Everything HTTP goes through the injected [`HttpTransport`], so
//! `cargo test` never touches the network.

pub mod concurrency;
pub mod custody;
#[cfg(feature = "http")]
pub mod http_transport;
pub mod rpc;
pub mod scan;
pub mod ssrf;
pub mod tx;

#[cfg(feature = "http")]
pub use http_transport::ReqwestHttpTransport;

/// The one wire primitive every adapter shares: a blocking JSON-over-HTTP
/// request/response pair. Errors are transport failures (connect, timeout,
/// TLS) as strings — HTTP status codes and bodies travel in the reply.
pub trait HttpTransport: Send + Sync {
    fn post(&self, url: &str, body: &str) -> Result<(u16, String), String>;
    fn get(&self, url: &str) -> Result<(u16, String), String>;

    /// Send an authenticated request with an optional per-request deadline.
    ///
    /// Custody traffic must never silently fall back to an unauthenticated
    /// request. Transports that do not implement this capability therefore
    /// fail closed instead of delegating to `post`/`get`.
    fn post_with_bearer(
        &self,
        _url: &str,
        _token: &str,
        _timeout_ms: u64,
        _body: &str,
    ) -> Result<(u16, String), String> {
        Err("HTTP transport does not support authenticated requests".to_string())
    }

    fn get_with_bearer(
        &self,
        _url: &str,
        _token: &str,
        _timeout_ms: u64,
    ) -> Result<(u16, String), String> {
        Err("HTTP transport does not support authenticated requests".to_string())
    }
}

/// Shared references are transports too, so clients can borrow a scripted
/// transport in tests while owning the production one.
impl<T: HttpTransport + ?Sized> HttpTransport for &T {
    fn post(&self, url: &str, body: &str) -> Result<(u16, String), String> {
        (**self).post(url, body)
    }
    fn get(&self, url: &str) -> Result<(u16, String), String> {
        (**self).get(url)
    }

    fn post_with_bearer(
        &self,
        url: &str,
        token: &str,
        timeout_ms: u64,
        body: &str,
    ) -> Result<(u16, String), String> {
        (**self).post_with_bearer(url, token, timeout_ms, body)
    }

    fn get_with_bearer(
        &self,
        url: &str,
        token: &str,
        timeout_ms: u64,
    ) -> Result<(u16, String), String> {
        (**self).get_with_bearer(url, token, timeout_ms)
    }
}
