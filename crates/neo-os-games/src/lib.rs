//! neo-os-games — game lane crate (T01 skeleton).
//!
//! Bodies arrive in T05 from `neo-os-compute/src/game`:
//!
//! - `engines/*` — the 11 hash-pinned game engines (aim, arrow, color, flappy,
//!   game2048, jump, merge, pet, sheep, snake, sudoku)
//! - `registry` — the hash-pinned `ENGINE_MANIFEST` (11 `engineHash` literals,
//!   anchored to the frozen wrapper sources under `baselines/js-parity/`)
//! - `parity` — the golden-parity driver over `engine-parity.goldens.json`
//! - `session_host` — the T05 deliverable: general session host with identity
//!   canonicalization, HMAC root, the 79-byte RESULT CODEC, behavioral gates
//!   and replay proofs (ported from `workers/nitro-worker/src/game/session.js`)
//!
//! Invariants that must survive the move (docs/rust-migration/ARCHITECTURE.md §4):
//! - engine state stays `serde_json::Value` with `{"$bytes":[…]}` for secrets;
//! - integer JSON output goes through `js_num_json()` semantics (`150.0` →
//!   `150`), never Rust's default float formatting;
//! - randomness is a seeded counter-mode SHA-256 stream, never `rand`;
//! - time is injected (`started_at_ms`), never the system clock.
//!
//! Intentionally empty in T01; the split lands in T05 with the goldens.
