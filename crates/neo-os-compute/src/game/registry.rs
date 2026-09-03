//! Engine registry — port of `game/registry.js`. The 11 app-declared engines
//! resolve by `(app_id, engineHash)`; the host (Phase 6) calls
//! [`resolve_engine`] at session start and [`registry_manifest`] surfaces the
//! pin table.
//!
//! The `ENGINE_MANIFEST` hashes originated as the `sha256` of each wrapper's
//! UTF-8 source with CRLF normalized to LF (`engineHashOfFile`) — the same
//! value the JS worker computed. As of the Rust migration they keep those 11
//! literal values unchanged but their meaning is now "engine behavior version
//! pin": the permanent anchor is the frozen copy under
//! `baselines/js-parity/wrappers/` (manifest-checked, survives the T05 removal
//! of `workers/nitro-worker`), not the live JS tree. Nothing on-chain or in
//! `apps/web` references these hashes, so no client or contract changes.
//! `engine_hash_of_source` re-derives the value, and the drift test
//! (`game::parity::wrapper_sources_match_pinned_engine_hashes`) asserts the
//! manifest still matches the frozen sources.

use super::abi::{OpMeta, OpOutcome, ScoreExtra, ScoreRejection};
use serde_json::Value as Json;

pub type ReplayFn = fn(&[u8; 32], &[Json], u8) -> Result<Json, String>;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TimeWindow {
    pub limit_ms: [f64; 3],
    pub min_solve_ms: [f64; 3],
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct EngineDescriptor {
    pub op_schema: &'static str,
    pub targets: [i64; 3],
    pub time_window: TimeWindow,
    pub gates: super::abi::Gates,
    pub reveal_policy: super::abi::RevealPolicy,
    pub max_ops: u64,
    pub max_undos: u64,
    pub undo_penalty_pct: u64,
    pub log_deterministic: bool,
    pub start_config_key: Option<&'static str>,
}

#[derive(Debug, Clone, Copy)]
pub struct EngineHandle {
    pub app_id: &'static str,
    pub engine_hash: &'static str,
    pub descriptor: EngineDescriptor,
    pub deal: fn(&[u8; 32], u8) -> (Json, Json),
    pub apply_op: fn(&mut Json, &Json, &OpMeta) -> OpOutcome,
    pub apply_undo: fn(&mut Json, &OpMeta) -> OpOutcome,
    pub replay: ReplayFn,
    pub score: fn(&Json, u8, &ScoreExtra) -> Result<super::abi::ScoreOutcome, ScoreRejection>,
}

// Registration order mirrors registry.js WRAPPER_MODULES.
static ENGINES: [EngineHandle; 11] = [
    super::sudoku::ENGINE,
    super::game2048::ENGINE,
    super::flappy::ENGINE,
    super::snake::ENGINE,
    super::aim::ENGINE,
    super::color::ENGINE,
    super::merge::ENGINE,
    super::pet::ENGINE,
    super::sheep::ENGINE,
    super::jump::ENGINE,
    super::arrow::ENGINE,
];

pub fn resolve_engine(app_id: &str) -> Result<&'static EngineHandle, String> {
    ENGINES
        .iter()
        .find(|engine| engine.app_id == app_id)
        .ok_or_else(|| format!("no engine registered for app_id {app_id}"))
}

/// `resolveEngineByHash`: an empty/absent hash accepts the registered engine;
/// otherwise it must match exactly (trimmed + lowercased) or the session is
/// rejected — a stale client pinning a superseded engine is an error.
pub fn resolve_engine_by_hash(
    engine: &'static EngineHandle,
    supplied_hash: Option<&str>,
) -> Result<(), String> {
    let Some(supplied) = supplied_hash else {
        return Ok(());
    };
    let supplied = supplied.trim().to_lowercase();
    if supplied.is_empty() {
        return Ok(());
    }
    if supplied == engine.engine_hash {
        Ok(())
    } else {
        Err(format!("engine_hash mismatch for {}", engine.app_id))
    }
}

pub fn is_registered_app(app_id: &str) -> bool {
    ENGINES.iter().any(|engine| engine.app_id == app_id)
}

pub fn registered_app_ids() -> Vec<&'static str> {
    ENGINES.iter().map(|engine| engine.app_id).collect()
}

/// The pin table the start response surfaces (registry.js registryManifest).
pub fn registry_manifest() -> Json {
    Json::Array(
        ENGINES
            .iter()
            .map(|engine| {
                serde_json::json!({
                    "app_id": engine.app_id,
                    "engine_hash": engine.engine_hash,
                    "descriptor": {
                        "op_schema": engine.descriptor.op_schema,
                        "targets": engine.descriptor.targets,
                        "time_window": {
                            "limit_ms": engine.descriptor.time_window.limit_ms,
                            "min_solve_ms": engine.descriptor.time_window.min_solve_ms,
                        },
                        "gates": {
                            "minMedianIntervalMs": engine.descriptor.gates.min_median_interval_ms,
                            "maxBurstOpsPerSec": engine.descriptor.gates.max_burst_ops_per_sec,
                            "minActionGapMs": engine.descriptor.gates.min_action_gap_ms,
                        },
                        "revealPolicy": engine.descriptor.reveal_policy.as_str(),
                        "maxOps": engine.descriptor.max_ops,
                        "maxUndos": engine.descriptor.max_undos,
                        "undoPenaltyPct": engine.descriptor.undo_penalty_pct,
                        "logDeterministic": engine.descriptor.log_deterministic,
                        "startConfigKey": engine.descriptor.start_config_key,
                    },
                })
            })
            .collect(),
    )
}

/// `engineHashOfFile`: sha256 over the UTF-8 source with CRLF normalized to LF.
pub fn engine_hash_of_source(source: &str) -> String {
    let normalized = source.replace("\r\n", "\n");
    super::sha256_hex(normalized.as_bytes())
}
