//! neo-os-chain-n3 — Neo N3 chain adapter (T01 skeleton).
//!
//! Bodies arrive in T03, ported from `workers/morpheus-relayer/src/neo-n3.js`:
//!
//! - `rpc` — JSON-RPC client over an injected transport (the five methods the
//!   relayer actually uses: `getblockcount`, `invokefunction`,
//!   `getapplicationlog`, `sendrawtransaction`, `getcontractstate`)
//! - `scan` — block-window scans, n3index request cursors, duplicate filtering
//! - `tx` — script/transaction assembly via `neo-os-core::n3_tx` (already
//!   vector-locked; do not re-encode here)
//! - `ssrf` — the SSRF-guarded transport wrapper: resolve-then-connect with
//!   private/loopback/link-local/ULA/CGNAT classification and
//!   decimal/hex/octal IPv4 bypass detection (see ARCHITECTURE.md §5.5)
//!
//! Dependency note (ARCHITECTURE.md §3.2): `serde_json` with
//! `preserve_order` where event shapes feed digest-bound bytes; `reqwest` with
//! `rustls-tls` only — no OpenSSL. Intentionally empty in T01.
