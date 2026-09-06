//! Engine ABI — port of `workers/nitro-worker/src/game/abi.js` plus the payload
//! shapes the five ABI functions exchange.
//!
//! The generic session host knows nothing about any game: it derives the
//! problemSecret, records op timestamps, runs the behavioural gate, enforces
//! the time window and undo bounds from the engine's descriptor, and builds the
//! finalize result. All per-game behaviour lives behind this fixed ABI:
//!
//! * [`deal`](crate::registry::EngineHandle) `(problemSecret, difficulty)`
//!   → `{state, startView}` — the start view never reveals future secrets.
//! * `applyOp(state, op, opMeta)` → view or reject. `opMeta` carries the
//!   enclave-derived timing the host owns. A returned `view.ok === false`
//!   (no reject) marks an accepted-but-null op — the host records it like the
//!   legacy "board did not change" no-op.
//! * `applyUndo(state, opMeta)` — the host enforces `descriptor.max_undos`
//!   BEFORE calling and counts the undo; the engine only rebuilds its state.
//! * `replay(problemSecret, opLog)` — deterministic rebuild; throws on an op
//!   the live session would have rejected.
//! * `score(state, difficulty, extra)` — the authoritative
//!   `{answerHash, score, scoreField?}` or a [`ScoreRejection`] (mapped to its
//!   status, 403 by default).

use serde_json::Value as Json;

/// "Run did not meet the target / invalid log" — the host maps this to its
/// status (403 by default). Any other engine failure is a bug (500-class).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScoreRejection {
    pub message: String,
    pub status: u16,
}

impl ScoreRejection {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            status: 403,
        }
    }

    pub fn with_status(message: impl Into<String>, status: u16) -> Self {
        Self {
            message: message.into(),
            status,
        }
    }
}

impl std::fmt::Display for ScoreRejection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for ScoreRejection {}

/// sha256 of a UTF-8 answer string → the 32-byte answerHash every engine binds.
pub fn answer_hash_of(str_input: &str) -> [u8; 32] {
    super::sha256_digest(str_input.as_bytes())
}

/// Effective score target for a difficulty: the host may pass a
/// `targetOverride` (test/operator-tuned lower target) via `score`'s extra arg;
/// otherwise the engine's descriptor target for that difficulty applies.
pub fn resolve_target(descriptor_targets: &[i64; 3], difficulty: u8, extra: &ScoreExtra) -> f64 {
    match extra.target_override {
        Some(override_value) if override_value.is_finite() => override_value,
        _ => descriptor_targets[difficulty.min(2) as usize] as f64,
    }
}

// ---------------------------------------------------------------------------
// Shared behavioural-gate defaults — engines override per-genre via descriptor.
// ---------------------------------------------------------------------------

pub const DEFAULT_MAX_OPS: u64 = 20_000;
pub const DEFAULT_MAX_UNDOS: u64 = 3;
pub const DEFAULT_UNDO_PENALTY_PCT: u64 = 30;

/// `gates` of the descriptor: the finalize-time sustained-rate floor. Per-op
/// gates (e.g. pet action spacing) are enforced inside the engine at op time.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Gates {
    pub min_median_interval_ms: f64,
    pub max_burst_ops_per_sec: f64,
    pub min_action_gap_ms: Option<f64>,
}

impl Default for Gates {
    fn default() -> Self {
        Self {
            min_median_interval_ms: 120.0,
            max_burst_ops_per_sec: 12.0,
            min_action_gap_ms: None,
        }
    }
}

/// abi.js's exported `DEFAULT_GATES` — engines reference this const in their
/// descriptor literals (a `Default::default()` call is not const-evaluable).
pub const DEFAULT_GATES: Gates = Gates {
    min_median_interval_ms: 120.0,
    max_burst_ops_per_sec: 12.0,
    min_action_gap_ms: None,
};

/// `revealPolicy` of the descriptor (informational; surfaces in start config).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RevealPolicy {
    Seed,
    Clues,
    PerMove,
    PerRound,
    StateOnly,
}

impl RevealPolicy {
    pub fn as_str(self) -> &'static str {
        match self {
            RevealPolicy::Seed => "seed",
            RevealPolicy::Clues => "clues",
            RevealPolicy::PerMove => "per-move",
            RevealPolicy::PerRound => "per-round",
            RevealPolicy::StateOnly => "state-only",
        }
    }
}

// ---------------------------------------------------------------------------
// ABI payload shapes
// ---------------------------------------------------------------------------

/// `opMeta` — the enclave-derived timing the host owns and hands to every
/// engine call. `None` fields are JS `undefined` (the replay paths pass
/// `{resumed: true}` only).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct OpMeta {
    pub problem_secret: [u8; 32],
    pub difficulty: u8,
    pub now_ms: Option<f64>,
    pub started_at_ms: Option<f64>,
    pub elapsed_ms: Option<f64>,
    pub resumed: bool,
    pub op_index: usize,
}

impl OpMeta {
    /// The replay-path meta: `{ resumed: true }` with everything else absent.
    pub fn resumed(problem_secret: [u8; 32], difficulty: u8, op_index: usize) -> Self {
        Self {
            problem_secret,
            difficulty,
            now_ms: None,
            started_at_ms: None,
            elapsed_ms: None,
            resumed: true,
            op_index,
        }
    }
}

/// One ABI op application. `Rejected` mirrors `outcome.reject` (the host maps
/// `status` straight onto the HTTP response); `View` mirrors `outcome.view`
/// (whose `ok === false` marks an accepted-but-null op).
#[derive(Debug, Clone, PartialEq)]
pub enum OpOutcome {
    Rejected { message: String, status: u16 },
    View(Json),
}

impl OpOutcome {
    pub fn is_rejected(&self) -> bool {
        matches!(self, OpOutcome::Rejected { .. })
    }

    /// `outcome.view?.ok === false` — the host's accepted-but-null signal.
    pub fn view_ok_false(&self) -> bool {
        match self {
            OpOutcome::View(view) => view.get("ok").and_then(Json::as_bool) == Some(false),
            OpOutcome::Rejected { .. } => false,
        }
    }
}

/// `score`'s extra arg: the finalize context plus the optional per-app target
/// override, and (sudoku) the submitted 81-char answer board.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ScoreExtra {
    pub answer: Option<Json>,
    pub elapsed_ms: Option<f64>,
    pub started_at_ms: Option<f64>,
    pub now_ms: Option<f64>,
    pub target_override: Option<f64>,
}

/// The enclave-authoritative score derivation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScoreOutcome {
    pub answer_hash: [u8; 32],
    pub score: i64,
    /// Optional extra JSON the finalize response surfaces for the client.
    pub score_field: Option<Json>,
}
