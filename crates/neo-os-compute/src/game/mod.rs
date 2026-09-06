//! Compatibility facade for the game lane.
//!
//! Game engines, their registry/parity corpus and the generic confidential
//! session protocol are owned by `neo-os-games`.  Existing Rust consumers may
//! keep the historical `neo_os_compute::game::*` path during migration; this
//! module contains no engine implementation or duplicated state.

pub use neo_os_games::*;
