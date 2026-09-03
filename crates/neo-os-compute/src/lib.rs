//! The keyless compute engine's Rust port — Phase 5a of the full-Rust enclave
//! plan (`flying-arch-dace.md`).
//!
//! Every module here is a port of a `workers/nitro-worker` JS module, with the
//! JS implementation as the byte-level oracle:
//!
//! | module             | oracle                                          |
//! |--------------------|-------------------------------------------------|
//! | [`capabilities`]   | `src/capabilities.js` (routing table + resolver) |
//! | [`policy`]         | `src/platform/policy-engine.js`                  |
//! | [`overload`]       | `src/platform/overload-guard.js`                 |
//! | [`circuit_breaker`]| `src/platform/circuit-breaker.js`                |
//! | [`risk`]           | `src/platform/risk-observer.js`                  |
//! | [`permission`]     | `src/platform/permission-guard.js`               |
//!
//! Two port-wide disciplines:
//!
//! * **Host-owned handler wiring.** The Rust enclave host calls these modules
//!   directly for the migrated compute, oracle-read, NeoDID, secrets, and
//!   feed-sign lanes. Routes not yet migrated remain explicit bridge entries;
//!   this crate never owns HTTP authentication or process lifecycle.
//! * **Transport-agnostic + env-injected.** Guards return plain values and
//!   status structs — HTTP rendering stays with the enclave host, exactly like
//!   the merged worker's `createServer` rendered `dispatch()` results. Anything
//!   that read `process.env` in JS takes an `&dyn Fn(&str) -> Option<String>`
//!   reader, so tests drive every env branch without process mutation and the
//!   host can feed its overlay.
//!
//! The workspace rule forbids path dependencies between members (see the root
//! `Cargo.toml`), so the JS-semantics helpers (`js.rs`) are local: they mirror
//! `neo-os-core`'s `js_value`/`js_number` but stay independent.

pub mod capabilities;
pub mod circuit_breaker;
pub mod compute;
pub mod core;
pub mod game;
pub mod js;
pub mod neodid;
pub mod oracle;
pub mod overload;
pub mod paymaster;
pub mod permission;
pub mod policy;
pub mod risk;
pub mod script;
pub mod ssrf;
pub mod stable_stringify;
pub mod standalone;
pub mod transport;
