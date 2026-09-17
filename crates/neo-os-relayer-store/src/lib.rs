//! neo-os-relayer-store — Supabase REST persistence, durable queue state machine,
//! and atomic state file management (T03).
//!
//! Ported from `workers/morpheus-relayer/src/persistence.js` and `queue.js`:
//! - [`supabase`] — REST client over an injected sync transport: URL formatting,
//!   `Prefer` headers (`resolution=ignore-duplicates`, `return=representation`),
//!   Postgres NUL byte sanitization (`\u0000`), and the two-tier backoff state machine
//!   (5-minute quota restriction vs 30-second transient connectivity error).
//! - [`jobs`] — 6 tables: `morpheus_relayer_jobs`, `morpheus_relayer_runs`,
//!   `morpheus_automation_jobs`, `morpheus_automation_runs`,
//!   `morpheus_encrypted_secrets`, `morpheus_feed_snapshots`. Implements
//!   optimistic concurrency claiming, request-floor quarantine, and status queries.
//! - [`queue`] — durable queue claim 4-state decisions (`Granted`, `Conflict`,
//!   `BackoffSkip`, `Unavailable`), job readiness predicate, and S4 HMAC
//!   tamper-evidence signature and verification.
//! - [`state_file`] — crash-safe atomic state file persistence (`tmp + rename`).

pub mod delivery;
pub mod jobs;
pub mod queue;
pub mod state_file;
pub mod supabase;

pub use jobs::*;
pub use queue::*;
pub use state_file::*;
pub use supabase::*;

/// Pluggable blocking HTTP transport for REST API communication.
pub trait HttpTransport: Send + Sync {
    fn request(
        &self,
        method: &str,
        url: &str,
        headers: &[(&str, &str)],
        body: Option<&str>,
    ) -> Result<(u16, String), String>;
}

impl<T: HttpTransport + ?Sized> HttpTransport for &T {
    fn request(
        &self,
        method: &str,
        url: &str,
        headers: &[(&str, &str)],
        body: Option<&str>,
    ) -> Result<(u16, String), String> {
        (**self).request(method, url, headers, body)
    }
}
