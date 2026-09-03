//! Jump Rush — port of `game/wrappers/jump.wrapper.js` over the GENERATED rule
//! core in `engines/jump.js` plus the handwritten `engines/jump.adapter.js`.
//! Pure skill genre: charge 0..100 → landing offset; platform layouts come
//! from a byte-cycling seed stream, everything else is clock-free and
//! deterministic. Undo is not supported (405), and the wrapper's own
//! `descriptor.targets` threshold also latches `completed` in `applyOp`.

use serde_json::Value as Json;

use super::abi::{answer_hash_of, OpMeta, OpOutcome, ScoreExtra, ScoreRejection};
use super::{js_num_json, op_type_of};

pub const APP_ID: &str = "miniapp-jump-rush";

pub const DESCRIPTOR: super::registry::EngineDescriptor = super::registry::EngineDescriptor {
    op_schema: "jump: {type:'jump', chargeLevel:0..100}",
    targets: [15, 25, 35], // number of platforms to clear per difficulty
    time_window: super::registry::TimeWindow {
        limit_ms: [180_000.0, 300_000.0, 480_000.0],
        min_solve_ms: [20_000.0, 40_000.0, 60_000.0],
    },
    gates: super::abi::DEFAULT_GATES,
    reveal_policy: super::abi::RevealPolicy::Clues,
    max_ops: 200,
    max_undos: 0,
    undo_penalty_pct: 0,
    log_deterministic: true,
    start_config_key: Some("target_platforms"),
};

pub static ENGINE: super::registry::EngineHandle = super::registry::EngineHandle {
    app_id: APP_ID,
    engine_hash: "803078b2092f67b6dc54abf5c5d4d17252a0f76d3765abd633320562e9cea81d",
    descriptor: DESCRIPTOR,
    deal,
    apply_op,
    apply_undo,
    replay,
    score,
};

// ---------------------------------------------------------------------------
// Generated core (engines/jump.js)
// ---------------------------------------------------------------------------

struct PlatformConfig {
    min_width: f64,
    max_width: f64,
    min_gap: f64,
    max_gap: f64,
    count: usize,
}

// configs[difficulty] — easy / medium / hard; anything else falls back to [0].
const CONFIGS: [PlatformConfig; 3] = [
    PlatformConfig {
        min_width: 100.0,
        max_width: 140.0,
        min_gap: 60.0,
        max_gap: 120.0,
        count: 15,
    },
    PlatformConfig {
        min_width: 85.0,
        max_width: 115.0,
        min_gap: 100.0,
        max_gap: 180.0,
        count: 25,
    },
    PlatformConfig {
        min_width: 70.0,
        max_width: 100.0,
        min_gap: 140.0,
        max_gap: 260.0,
        count: 35,
    },
];

#[derive(Clone, Copy)]
struct Platform {
    x: f64,
    width: f64,
    gap: f64,
}

impl Platform {
    fn to_json(self) -> Json {
        serde_json::json!({
            "x": js_num_json(self.x),
            "width": js_num_json(self.width),
            "gap": js_num_json(self.gap),
        })
    }
}

/// `streamOf` cycles the 32 seed bytes (`seed[cursor % 32] ?? 0`).
fn generate_platforms(seed: &[u8; 32], difficulty: u8) -> Vec<Platform> {
    let config = CONFIGS.get(difficulty as usize).unwrap_or(&CONFIGS[0]);
    let mut cursor = 0usize;
    let mut next_byte = move || {
        let byte = seed[cursor % 32];
        cursor += 1;
        byte
    };
    let mut platforms = vec![Platform {
        x: 60.0,
        width: 120.0,
        gap: 0.0,
    }];
    for _ in 1..=config.count {
        let width_range = config.max_width - config.min_width;
        let gap_range = config.max_gap - config.min_gap;
        let width = config.min_width + (next_byte() as f64 % (width_range + 1.0));
        let gap = config.min_gap + (next_byte() as f64 % (gap_range + 1.0));
        let prev = *platforms
            .last()
            .expect("platforms starts with the base platform");
        let x = prev.x + prev.width + gap;
        platforms.push(Platform { x, width, gap });
    }
    platforms
}

/// `evaluateJumpLevel` — the wrapper only consumes `landed` and `perfect` (the
/// adapter's landingX/idealCharge/chargeError never reach a view).
fn evaluate_jump_level(charge: f64, gap: f64, width: f64) -> (bool, bool) {
    let safe_gap = gap.max(0.0);
    let safe_width = width.max(1.0);
    let valid_charge = charge.is_finite() && (0.0..=100.0).contains(&charge);
    let landing_offset = if valid_charge {
        charge / 100.0 * (safe_gap + safe_width) - safe_gap
    } else {
        f64::NAN
    };
    let landed = valid_charge && landing_offset >= 0.0 && landing_offset <= safe_width;
    let perfect =
        landed && landing_offset >= safe_width * 0.35 && landing_offset <= safe_width * 0.65;
    (landed, perfect)
}

/// The adapter's `evaluateJump`: `None` models the `{ ok: false }` shape taken
/// when either the current or the next platform is missing.
fn evaluate_jump(
    platforms: &[Platform],
    platform_index: usize,
    charge: f64,
) -> Option<(bool, bool)> {
    let to = platforms.get(platform_index + 1)?;
    Some(evaluate_jump_level(charge, to.gap, to.width))
}

// ---------------------------------------------------------------------------
// Wrapper ABI
// ---------------------------------------------------------------------------

fn platforms_of(state: &Json) -> Vec<Platform> {
    state
        .get("platforms")
        .and_then(Json::as_array)
        .expect("jump state carries platforms")
        .iter()
        .map(|p| Platform {
            x: p.get("x").and_then(Json::as_f64).unwrap_or(0.0),
            width: p.get("width").and_then(Json::as_f64).unwrap_or(0.0),
            gap: p.get("gap").and_then(Json::as_f64).unwrap_or(0.0),
        })
        .collect()
}

pub fn deal(problem_secret: &[u8; 32], difficulty: u8) -> (Json, Json) {
    let platforms = generate_platforms(problem_secret, difficulty);
    let platform_json: Vec<Json> = platforms.iter().map(|p| p.to_json()).collect();
    let state = serde_json::json!({
        "problemSecret": super::secret_to_json(problem_secret),
        "difficulty": difficulty,
        "platforms": platform_json,
        "platformIndex": 0,
        "jumps": 0,
        "perfects": 0,
        "failed": false,
        "completed": false,
    });
    let start_view = serde_json::json!({
        "platforms": platform_json,
        "totalPlatforms": platforms.len(),
        "targetPlatforms": DESCRIPTOR.targets.get(difficulty as usize).copied().unwrap_or(15),
    });
    (state, start_view)
}

pub fn apply_op(state: &mut Json, op: &Json, _op_meta: &OpMeta) -> OpOutcome {
    if op_type_of(op) != "jump" {
        return OpOutcome::Rejected {
            message: "op.type must be 'jump'".into(),
            status: 400,
        };
    }
    let charge = super::number_field(op.get("chargeLevel"));
    if !charge.is_finite() || !(0.0..=100.0).contains(&charge) {
        return OpOutcome::Rejected {
            message: "op.chargeLevel must be a number 0..100".into(),
            status: 400,
        };
    }
    let already_over = state.get("failed").and_then(Json::as_bool).unwrap_or(false)
        || state
            .get("completed")
            .and_then(Json::as_bool)
            .unwrap_or(false);
    if already_over {
        return OpOutcome::Rejected {
            message: "game is already over".into(),
            status: 409,
        };
    }

    let platform_index = state
        .get("platformIndex")
        .and_then(Json::as_u64)
        .unwrap_or(0) as usize;
    let difficulty = state.get("difficulty").and_then(Json::as_u64).unwrap_or(0) as u8;
    let platforms = platforms_of(state);

    let outcome = evaluate_jump(&platforms, platform_index, charge);
    let jumps = state.get("jumps").and_then(Json::as_i64).unwrap_or(0) + 1;
    state["jumps"] = js_num_json(jumps as f64);

    let landed = outcome.is_some_and(|(landed, _)| landed);
    if !landed {
        state["failed"] = Json::Bool(true);
        let perfects = state.get("perfects").and_then(Json::as_i64).unwrap_or(0);
        return OpOutcome::View(serde_json::json!({
            "ok": false,
            "landed": false,
            "perfect": false,
            "platformIndex": platform_index,
            "jumps": jumps,
            "perfects": perfects,
            "failed": true,
        }));
    }

    let perfect = outcome.is_some_and(|(_, perfect)| perfect);
    let perfects = state.get("perfects").and_then(Json::as_i64).unwrap_or(0) + i64::from(perfect);
    let next_index = platform_index + 1;
    let target = DESCRIPTOR
        .targets
        .get(difficulty as usize)
        .copied()
        .unwrap_or(15);
    let completed = (next_index as i64) >= target;
    state["platformIndex"] = js_num_json(next_index as f64);
    state["perfects"] = js_num_json(perfects as f64);
    state["completed"] = Json::Bool(completed);
    OpOutcome::View(serde_json::json!({
        "ok": true,
        "landed": true,
        "perfect": perfect,
        "platformIndex": next_index,
        "jumps": jumps,
        "perfects": perfects,
        "completed": completed,
    }))
}

pub fn apply_undo(_state: &mut Json, _op_meta: &OpMeta) -> OpOutcome {
    OpOutcome::Rejected {
        message: "undo not supported in Jump Rush".into(),
        status: 405,
    }
}

pub fn replay(problem_secret: &[u8; 32], op_log: &[Json], difficulty: u8) -> Result<Json, String> {
    let (mut state, _) = deal(problem_secret, difficulty);
    for (i, op) in op_log.iter().enumerate() {
        let outcome = apply_op(
            &mut state,
            op,
            &OpMeta::resumed(*problem_secret, difficulty, i),
        );
        if let OpOutcome::Rejected { message, .. } = outcome {
            return Err(format!("invalid op at index {i}: {message}"));
        }
        let over = state.get("failed").and_then(Json::as_bool).unwrap_or(false)
            || state
                .get("completed")
                .and_then(Json::as_bool)
                .unwrap_or(false);
        if over {
            break;
        }
    }
    Ok(state)
}

pub fn score(
    state: &Json,
    difficulty: u8,
    extra: &ScoreExtra,
) -> Result<super::abi::ScoreOutcome, ScoreRejection> {
    let platform_index = state
        .get("platformIndex")
        .and_then(Json::as_i64)
        .unwrap_or(0);
    let perfects = state.get("perfects").and_then(Json::as_i64).unwrap_or(0);
    let jumps = state.get("jumps").and_then(Json::as_i64).unwrap_or(0);
    let target = super::abi::resolve_target(&DESCRIPTOR.targets, difficulty, extra);
    if (platform_index as f64) < target {
        return Err(ScoreRejection::new(
            "course not completed — reach the target platform count to win",
        ));
    }
    Ok(super::abi::ScoreOutcome {
        answer_hash: answer_hash_of(&format!("jump:{platform_index}:{perfects}:{jumps}")),
        score: platform_index,
        score_field: Some(serde_json::json!({
            "platforms_cleared": platform_index,
            "perfects": perfects,
            "jumps": jumps,
        })),
    })
}
