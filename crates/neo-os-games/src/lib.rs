//! `neo-os-games` — hash-pinned game content and the generic session protocol.
//!
//! The JS game lane is a generic confidential-session host (`session.js`) that
//! knows nothing about any specific game plus 11 APP-DECLARED ENGINES loaded by
//! `(appId, engineHash)` from the operator-whitelisted registry
//! (`registry.js`). Each engine implements the fixed five-function ABI of
//! `abi.js` — `deal / applyOp / applyUndo / replay / score` — over a static
//! descriptor of per-game constants.
//!
//! This port keeps the same split:
//!
//! | module          | oracle                                                |
//! |-----------------|-------------------------------------------------------|
//! | [`abi`]         | `src/game/abi.js` + the ABI payload shapes             |
//! | [`registry`]    | `src/game/registry.js` (manifest + pinned engineHashes)|
//! | [`sudoku`] …    | `src/game/wrappers/*.wrapper.js` (+ `engines/*.js`)    |
//!
//! [`session`] is the generic host: canonical identity and HMAC-bound replay,
//! bounded in-memory state, descriptor-driven behavioural gates, and the
//! fixed 79-byte RESULT CODEC. It deliberately stops at an unsigned finalize
//! body; the Nitro host owns KMS release and custody signing.
//!
//! Two representation decisions, both dictated by `engine-parity.goldens.json`:
//!
//! * **Engine state is JSON** (`serde_json::Value`), exactly like the JS
//!   host's opaque state object. The goldens hash every state via
//!   `canonicalize()` + `JSON.stringify`, so the Rust state must be the same
//!   JSON document, key order included.
//! * **`problemSecret` lives inside the state as `{"$bytes":[..]}`.** The JS
//!   state carries the raw 32-byte Buffer and `canonicalize()` converts it to
//!   `{"$bytes":[...]}` at hash time; the Rust state stores that canonical form
//!   directly so the hashes line up byte-for-byte. Engine code reads it back
//!   with [`state_secret`].
//!
//! The parity test (`parity.rs`) drives every engine through the recorded ops
//! of the frozen goldens and asserts the per-op view/state hashes, the replay
//! hash and the score outcome — the same net `engine-parity.test.mjs` provides
//! on the JS side.

pub mod abi;
pub mod registry;
pub mod session;

pub mod aim;
pub mod arrow;
pub mod color;
pub mod flappy;
pub mod game2048;
pub mod jump;
pub mod merge;
pub mod pet;
pub mod sheep;
pub mod snake;
pub mod sudoku;

mod js;

#[cfg(test)]
mod parity;

use serde_json::Value as Json;
use sha2::{Digest, Sha256};

// The engines reference the JS-side helpers through `super::`, matching how
// the wrappers import from `../abi.js` / sibling modules.
pub(crate) use crate::js::js_math_round;

pub(crate) fn sha256_digest(input: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(input);
    hasher.finalize().into()
}

pub(crate) fn sha256_hex(input: &[u8]) -> String {
    hex_encode(&sha256_digest(input))
}

pub(crate) fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// JS `ToInt32(value)` — modulo 2^32, then signed. Exact for the integral
/// doubles the engines produce (`fmod` is exact per IEEE 754).
pub(crate) fn js_to_int32(value: f64) -> i32 {
    let m = value.trunc().rem_euclid(4294967296.0);
    if m >= 2147483648.0 {
        (m - 4294967296.0) as i32
    } else {
        m as i32
    }
}

/// JS `ToUint32(value)` — modulo 2^32, unsigned.
pub(crate) fn js_to_uint32(value: f64) -> u32 {
    value.trunc().rem_euclid(4294967296.0) as u32
}

/// Store a JS Number into engine state the way `JSON.stringify` would render
/// it: integral values stay integers (`150`, never `150.0` — the parity goldens
/// hash the state text). Non-integral doubles pass through.
pub(crate) fn js_num_json(value: f64) -> Json {
    if value.is_finite() && value.fract() == 0.0 && value.abs() <= 9.007_199_254_740_991e15 {
        Json::from(value as i64)
    } else {
        serde_json::Number::from_f64(value)
            .map(Json::Number)
            .unwrap_or(Json::Null)
    }
}

/// The canonical `{"$bytes":[..]}` form of a 32-byte secret inside engine state.
pub(crate) fn secret_to_json(secret: &[u8; 32]) -> Json {
    serde_json::json!({ "$bytes": secret.iter().map(|b| Json::from(*b as i64)).collect::<Vec<_>>() })
}

/// Read `problemSecret` back out of an engine state (see the module doc).
pub(crate) fn state_secret(state: &Json) -> [u8; 32] {
    let bytes = state
        .pointer("/problemSecret/$bytes")
        .and_then(Json::as_array)
        .expect("engine state carries {\"problemSecret\":{\"$bytes\":[..]}}");
    let mut out = [0u8; 32];
    for (i, b) in bytes.iter().enumerate() {
        out[i] = b.as_u64().expect("secret byte") as u8;
    }
    out
}

/// `typeof op?.type === 'string' ? op.type.trim() : ''` — the per-op type gate
/// every wrapper opens with.
pub(crate) fn op_type_of(op: &Json) -> String {
    match op.get("type") {
        Some(Json::String(s)) => s.trim().to_string(),
        _ => String::new(),
    }
}

/// JS `Number(value)` for an optional JSON field.
pub(crate) fn number_field(value: Option<&Json>) -> f64 {
    value.map(crate::js::js_to_number).unwrap_or(f64::NAN)
}

// ---------------------------------------------------------------------------
// Counter-mode SHA-256 byte stream — the enclave-only deal source shared by
// 2048, snake, merge and arrow (each `engines/*.adapter.js` has its own copy
// of this exact construction: block k = sha256(seed || k as 4-byte BE)).
// ---------------------------------------------------------------------------

pub(crate) fn stream_block_of(seed: &[u8; 32], k: u32) -> [u8; 32] {
    let mut input = [0u8; 36];
    input[..32].copy_from_slice(seed);
    input[32..].copy_from_slice(&k.to_be_bytes());
    sha256_digest(&input)
}

pub(crate) struct CounterStream {
    seed: [u8; 32],
    k: u32,
    cursor: u8,
    block: Option<[u8; 32]>,
}

impl CounterStream {
    /// Fresh stream: first `next()` derives block 0.
    pub(crate) fn new(seed: &[u8; 32]) -> Self {
        Self {
            seed: *seed,
            k: 0,
            cursor: 32,
            block: None,
        }
    }

    /// Resume from a persisted `(k, cursor)` run state. Resuming mid-block
    /// re-derives block `k - 1`, the block `cursor` points into.
    pub(crate) fn resumed(seed: &[u8; 32], k: u32, cursor: u8) -> Self {
        let block = if cursor < 32 && k > 0 {
            Some(stream_block_of(seed, k - 1))
        } else {
            None
        };
        Self {
            seed: *seed,
            k,
            cursor,
            block,
        }
    }

    /// The persisted `(k, cursor)` state (the wrappers' `rng` field).
    pub(crate) fn state(&self) -> (u32, u8) {
        (self.k, self.cursor)
    }

    pub(crate) fn next(&mut self) -> u8 {
        if self.cursor >= 32 {
            self.block = Some(stream_block_of(&self.seed, self.k));
            self.k = self.k.wrapping_add(1);
            self.cursor = 0;
        }
        let byte = self.block.unwrap_or([0u8; 32])[self.cursor as usize];
        self.cursor += 1;
        byte
    }
}
