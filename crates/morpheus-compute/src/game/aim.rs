//! Aim Master — port of `game/wrappers/aim.wrapper.js` over the deterministic
//! core in `engines/aim.js` (GENERATED from the minigames TS twin). Reflex
//! genre: each aim op is placed on the pattern timeline by the enclave's own
//! clock tick; the client-claimed position is recorded but never trusted for
//! scoring.
//!
//! The pattern LCG is a JS-number trap: `rngState * 1103515245 + 12345` runs
//! in f64 (state < 2^31, product up to ~2^61 — the low bits beyond 2^53 are
//! lost to rounding) and only then goes through ToInt32 + `& 0x7FFFFFFF`. The
//! i128 computation would diverge, so the f64 shape is preserved verbatim.

use serde_json::Value as Json;

use super::abi::{answer_hash_of, OpMeta, OpOutcome, ScoreExtra, ScoreRejection};
use super::{js_math_round, js_num_json, js_to_int32, number_field, op_type_of};

pub const APP_ID: &str = "miniapp-aim-master";

pub const DESCRIPTOR: super::registry::EngineDescriptor = super::registry::EngineDescriptor {
    op_schema: "aim: {type:'aim', position:0..width} | undo",
    targets: [3, 5, 7], // accuracy hits (ring <= 2)
    time_window: super::registry::TimeWindow {
        limit_ms: [60_000.0, 90_000.0, 120_000.0],
        min_solve_ms: [10_000.0, 20_000.0, 30_000.0],
    },
    gates: super::abi::DEFAULT_GATES,
    reveal_policy: super::abi::RevealPolicy::PerMove,
    max_ops: 20_000,
    max_undos: 3,
    undo_penalty_pct: 30,
    // reflex: score depends on enclave op-timing the log does not carry
    log_deterministic: false,
    start_config_key: Some("target_accuracy"),
};

pub static ENGINE: super::registry::EngineHandle = super::registry::EngineHandle {
    app_id: APP_ID,
    engine_hash: "701118ccc91941f1e36d8e71bdee6dc2f357ab42acd48fc754664915d570ca34",
    descriptor: DESCRIPTOR,
    deal,
    apply_op,
    apply_undo,
    replay,
    score,
};

const AIM_WIDTH: f64 = 300.0;
const AIM_CENTRE: f64 = 150.0;
const BULLSEYE_RADIUS: f64 = 6.0;
const RING_WIDTH: f64 = 24.0;
const AIM_MAX_SPEED: f64 = 6.0;
const TICK_MS: f64 = 16.0;
const ACCURACY_RING: i64 = 2;
const PATTERN_TICKS: usize = 313; // Math.ceil(5000 / 16)

// ---------------------------------------------------------------------------
// Generated core
// ---------------------------------------------------------------------------

fn generate_pattern(problem_secret: &[u8; 32]) -> Vec<f64> {
    let mut hash: i32 = 0;
    for &byte in problem_secret {
        // (hash << 5) - hash + byte | 0 — f64-exact then ToInt32, i.e. i32 wrap.
        hash = hash
            .wrapping_shl(5)
            .wrapping_sub(hash)
            .wrapping_add(byte as i32);
    }
    let mut rng_state = hash.abs() as f64; // Math.abs — i32::MIN becomes 2147483648.0
    let mut pseudo_rand = || {
        let t = rng_state * 1103515245.0 + 12345.0; // f64 rounding IS the semantics
        rng_state = (js_to_int32(t) & 0x7FFF_FFFF) as f64;
        rng_state / 2147483647.0
    };
    let mut positions = Vec::with_capacity(PATTERN_TICKS);
    let mut position = AIM_CENTRE;
    let mut direction = if pseudo_rand() < 0.5 { 1.0 } else { -1.0 };
    let mut speed = 1.0;
    let mut ticks_until_change = 0.0;
    for _ in 0..PATTERN_TICKS {
        positions.push(position);
        if ticks_until_change <= 0.0 {
            direction = if pseudo_rand() < 0.5 { 1.0 } else { -1.0 };
            speed = 1.0 + (pseudo_rand() * (AIM_MAX_SPEED - 1.0)).floor();
            ticks_until_change = 10.0 + (pseudo_rand() * 40.0).floor();
        }
        ticks_until_change -= 1.0;
        position += direction * speed;
        if position < 0.0 {
            position = 0.0;
            direction = 1.0;
        } else if position > AIM_WIDTH {
            position = AIM_WIDTH;
            direction = -1.0;
        }
    }
    positions
}

/// The comma-joined pattern the start view hands to the client.
pub fn pattern_view(problem_secret: &[u8; 32]) -> String {
    generate_pattern(problem_secret)
        .iter()
        .map(|p| super::js_num_json(*p).to_string())
        .collect::<Vec<_>>()
        .join(",")
}

fn ring_of(stop_position: f64) -> i64 {
    let offset = stop_position - AIM_CENTRE;
    let absolute_distance = offset.abs();
    if absolute_distance <= BULLSEYE_RADIUS {
        return 0;
    }
    (((absolute_distance - BULLSEYE_RADIUS) / RING_WIDTH).floor() as i64 + 1).min(5)
}

fn position_at_tick(pattern: &[f64], tick: i64) -> f64 {
    if pattern.is_empty() {
        return AIM_CENTRE;
    }
    let index = if tick < 0 {
        0
    } else {
        (tick as usize) % pattern.len()
    };
    pattern[index]
}

struct AimReplay {
    accuracy_hits: i64,
    rings: Vec<i64>,
}

fn replay_aim(pattern: &[f64], ticks: &[i64]) -> AimReplay {
    let mut rings = Vec::with_capacity(ticks.len());
    let mut accuracy_hits = 0i64;
    for &tick in ticks {
        let ring = ring_of(position_at_tick(pattern, tick));
        rings.push(ring);
        if ring <= ACCURACY_RING {
            accuracy_hits += 1;
        }
    }
    AimReplay {
        accuracy_hits,
        rings,
    }
}

fn aim_answer(accuracy_hits: i64, rings: &[i64]) -> String {
    let joined = rings.iter().map(|r| r.to_string()).collect::<String>();
    format!("aim:{accuracy_hits}:{joined}")
}

// ---------------------------------------------------------------------------
// Wrapper ABI
// ---------------------------------------------------------------------------

pub fn deal(problem_secret: &[u8; 32], _difficulty: u8) -> (Json, Json) {
    let state = serde_json::json!({
        "problemSecret": super::secret_to_json(problem_secret),
        "ticks": [],
        "ops": [],
    });
    let start_view = serde_json::json!({ "pattern": pattern_view(problem_secret) });
    (state, start_view)
}

pub fn apply_op(state: &mut Json, op: &Json, op_meta: &OpMeta) -> OpOutcome {
    let type_name = op_type_of(op);
    if type_name != "aim" {
        return OpOutcome::Rejected {
            message: "op.type must be aim or undo".into(),
            status: 400,
        };
    }
    let position = number_field(op.get("position"));
    if !position.is_finite() || !(0.0..=AIM_WIDTH).contains(&position) {
        return OpOutcome::Rejected {
            message: format!("op.position must be within 0..{AIM_WIDTH}"),
            status: 400,
        };
    }
    // The client-claimed position is recorded but NOT trusted; the tick derived
    // from the enclave clock is what the engine scores.
    state
        .get_mut("ops")
        .and_then(Json::as_array_mut)
        .expect("aim state carries ops")
        .push(serde_json::json!({ "type": "aim", "position": js_num_json(position) }));
    let ticks_len = state
        .get("ticks")
        .and_then(Json::as_array)
        .map_or(0, Vec::len);
    let tick = if op_meta.resumed {
        ((ticks_len + 1) * 30) as f64
    } else {
        let elapsed = op_meta.elapsed_ms.unwrap_or(0.0);
        js_math_round(elapsed / TICK_MS).max(0.0)
    };
    state
        .get_mut("ticks")
        .and_then(Json::as_array_mut)
        .expect("aim state carries ticks")
        .push(js_num_json(tick));
    OpOutcome::View(serde_json::json!({ "ok": true }))
}

pub fn apply_undo(state: &mut Json, _op_meta: &OpMeta) -> OpOutcome {
    let ticks_empty = state
        .get("ticks")
        .and_then(Json::as_array)
        .map(Vec::is_empty)
        .unwrap_or(true);
    if ticks_empty {
        return OpOutcome::Rejected {
            message: "nothing to undo".into(),
            status: 409,
        };
    }
    state
        .get_mut("ticks")
        .and_then(Json::as_array_mut)
        .expect("aim state carries ticks")
        .pop();
    state
        .get_mut("ops")
        .and_then(Json::as_array_mut)
        .expect("aim state carries ops")
        .pop();
    OpOutcome::View(serde_json::json!({ "ok": true }))
}

pub fn replay(problem_secret: &[u8; 32], op_log: &[Json], difficulty: u8) -> Result<Json, String> {
    let (mut state, _) = deal(problem_secret, difficulty);
    for (i, op) in op_log.iter().enumerate() {
        let type_name = op_type_of(op);
        let outcome = if type_name == "undo" {
            apply_undo(&mut state, &OpMeta::resumed(*problem_secret, difficulty, i))
        } else {
            apply_op(
                &mut state,
                op,
                &OpMeta::resumed(*problem_secret, difficulty, i),
            )
        };
        if outcome.is_rejected() {
            return Err(format!("invalid replay op at index {i}"));
        }
    }
    Ok(state)
}

pub fn score(
    state: &Json,
    difficulty: u8,
    extra: &ScoreExtra,
) -> Result<super::abi::ScoreOutcome, ScoreRejection> {
    let secret = super::state_secret(state);
    let pattern = generate_pattern(&secret);
    let ticks: Vec<i64> = state
        .get("ticks")
        .and_then(Json::as_array)
        .expect("aim state carries ticks")
        .iter()
        .filter_map(|t| t.as_i64())
        .collect();
    let replayed = replay_aim(&pattern, &ticks);
    let target = super::abi::resolve_target(&DESCRIPTOR.targets, difficulty, extra);
    if (replayed.accuracy_hits as f64) < target {
        return Err(ScoreRejection::new("accuracy target not reached"));
    }
    Ok(super::abi::ScoreOutcome {
        answer_hash: answer_hash_of(&aim_answer(replayed.accuracy_hits, &replayed.rings)),
        score: replayed.accuracy_hits,
        score_field: Some(serde_json::json!({ "rings_hit": replayed.accuracy_hits })),
    })
}
