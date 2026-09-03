//! Curve Arrow — port of `game/wrappers/arrow.wrapper.js` over the GENERATED
//! flight core in `engines/arrow.js` plus the handwritten enclave-only deal in
//! `engines/arrow.adapter.js`. Q8/Q12 fixed-point physics: held ticks rotate
//! counter-clockwise, released glide levels the arrow back to `SPEED_Q8` once
//! `nvy >= 0 && nvx > 0` (snapping posY to its pixel floor). No undo; the run
//! ends on `won` or budget exhaustion and further shots are rejected.

use serde_json::Value as Json;

use super::abi::{answer_hash_of, OpMeta, OpOutcome, ScoreExtra, ScoreRejection};
use super::{op_type_of, CounterStream};

pub const APP_ID: &str = "miniapp-curve-arrow";

pub const DESCRIPTOR: super::registry::EngineDescriptor = super::registry::EngineDescriptor {
    op_schema: "shot: {type:'shot', holds:[pressTick,releaseTick,...]} (no undo)",
    targets: [3, 5, 7], // levels cleared
    time_window: super::registry::TimeWindow {
        limit_ms: [180_000.0, 300_000.0, 600_000.0],
        min_solve_ms: [10_000.0, 25_000.0, 45_000.0],
    },
    gates: super::abi::DEFAULT_GATES,
    reveal_policy: super::abi::RevealPolicy::Clues,
    max_ops: 64,
    max_undos: 0,
    undo_penalty_pct: 0,
    log_deterministic: true,
    start_config_key: Some("target_levels"),
};

pub static ENGINE: super::registry::EngineHandle = super::registry::EngineHandle {
    app_id: APP_ID,
    engine_hash: "93df989b35b76e328d6b1ac10dc9b530a34f59831576bf1789963acd136ba494",
    descriptor: DESCRIPTOR,
    deal,
    apply_op,
    apply_undo,
    replay,
    score,
};

// ---------------------------------------------------------------------------
// Generated core (engines/arrow.js)
// ---------------------------------------------------------------------------

const FIELD_W: i64 = 1600;
const FIELD_H: i64 = 900;
const BOW_X: i64 = 140;
const BOW_Y: i64 = 450;
const SPEED_Q8: i64 = 3584;
const TURN_SIN: i64 = 286;
const TURN_COS: i64 = 4086;
const TICKS_MAX: i64 = 480;
const TARGET_RINGS: [i64; 3] = [18, 40, 70];
const MAX_HOLD_PAIRS: usize = 6;
const LEVEL_TARGETS: [usize; 3] = [3, 5, 7];
const ARROW_BUDGETS: [i64; 3] = [9, 14, 19];

/// `normalizeHolds` — pairs of strictly ascending integer ticks in 0..480,
/// at most 6 pairs; anything else (including non-array) is `null`.
fn normalize_holds(holds: Option<&Json>) -> Option<Vec<i64>> {
    let arr = holds?.as_array()?;
    if arr.len() % 2 != 0 || arr.len() > MAX_HOLD_PAIRS * 2 {
        return None;
    }
    let mut prev: i64 = -1;
    let mut out = Vec::with_capacity(arr.len());
    for value in arr {
        // Number.isInteger: integral doubles qualify, fractional do not.
        let raw = value.as_f64()?;
        if !raw.is_finite() || raw.fract() != 0.0 {
            return None;
        }
        let tick = raw as i64;
        if !(0..TICKS_MAX).contains(&tick) || tick <= prev {
            return None;
        }
        prev = tick;
        out.push(tick);
    }
    Some(out)
}

fn is_held(holds: &[i64], tick: i64) -> bool {
    for pair in holds.as_chunks::<2>().0 {
        if tick >= pair[0] && tick < pair[1] {
            return true;
        }
    }
    false
}

fn ring_of(offset: i64) -> i64 {
    let abs = offset.abs();
    for (ring, bound) in TARGET_RINGS.iter().enumerate() {
        if abs <= *bound {
            return ring as i64;
        }
    }
    -1
}

#[derive(Clone, Copy)]
struct ShotOutcome {
    hit: bool,
    ring: i64,
}

struct Level {
    target: (i64, i64),
    // (x, y, w, h)
    obstacles: Vec<(i64, i64, i64, i64)>,
}

fn simulate_shot(level: &Level, holds: &[i64]) -> ShotOutcome {
    let mut pos_x: i64 = BOW_X << 8;
    let mut pos_y: i64 = BOW_Y << 8;
    let mut vx: i64 = SPEED_Q8;
    let mut vy: i64 = 0;
    let mut world_x: i64 = BOW_X;
    let mut world_y: i64;
    let mut prev_world_x: i64;
    for tick in 0..TICKS_MAX {
        if is_held(holds, tick) {
            // (vx * TURN_COS + vy * TURN_SIN) >> 12 — JS `>>` after the `*`/`+`.
            let nvx = (vx * TURN_COS + vy * TURN_SIN) >> 12;
            let nvy = (-vx * TURN_SIN + vy * TURN_COS) >> 12;
            vx = nvx;
            vy = nvy;
        } else if vy < 0 {
            let nvx = (vx * TURN_COS - vy * TURN_SIN) >> 12;
            let nvy = (vx * TURN_SIN + vy * TURN_COS) >> 12;
            if nvy >= 0 && nvx > 0 {
                vx = SPEED_Q8;
                vy = 0;
                pos_y = (pos_y >> 8) << 8;
            } else {
                vx = nvx;
                vy = nvy;
            }
        }
        pos_x += vx;
        pos_y += vy;
        prev_world_x = world_x;
        world_x = pos_x >> 8;
        world_y = pos_y >> 8;
        if !(0..=FIELD_W).contains(&world_x) || !(0..=FIELD_H).contains(&world_y) {
            return ShotOutcome {
                hit: false,
                ring: -1,
            };
        }
        for &(ox, oy, ow, oh) in &level.obstacles {
            if world_x >= ox && world_x <= ox + ow && world_y >= oy && world_y <= oy + oh {
                return ShotOutcome {
                    hit: false,
                    ring: -1,
                };
            }
        }
        let crossed_forward = prev_world_x < level.target.0 && world_x >= level.target.0;
        let crossed_backward = prev_world_x > level.target.0 && world_x <= level.target.0;
        if crossed_forward || crossed_backward {
            let ring = ring_of(world_y - level.target.1);
            if ring >= 0 {
                return ShotOutcome { hit: true, ring };
            }
        }
    }
    ShotOutcome {
        hit: false,
        ring: -1,
    }
}

#[derive(Clone, Copy)]
struct Run {
    level_index: i64,
    cleared: i64,
    arrows_used: i64,
    budget: i64,
    done: bool,
    won: bool,
}

fn create_run(level_count: usize, difficulty: u8) -> Run {
    let clamped = (difficulty as usize).min(2);
    Run {
        level_index: 0,
        cleared: 0,
        arrows_used: 0,
        budget: ARROW_BUDGETS[clamped],
        done: level_count == 0,
        won: false,
    }
}

fn apply_shot(run: &Run, levels: &[Level], holds: &[i64]) -> (Run, ShotOutcome) {
    if run.done || run.level_index < 0 || run.level_index as usize >= levels.len() {
        return (
            *run,
            ShotOutcome {
                hit: false,
                ring: -1,
            },
        );
    }
    let outcome = simulate_shot(&levels[run.level_index as usize], holds);
    let arrows_used = run.arrows_used + 1;
    let cleared = run.cleared + i64::from(outcome.hit);
    let level_index = run.level_index + i64::from(outcome.hit);
    let won = cleared >= levels.len() as i64;
    let done = won || arrows_used >= run.budget;
    (
        Run {
            level_index,
            cleared,
            arrows_used,
            budget: run.budget,
            done,
            won,
        },
        outcome,
    )
}

// ---------------------------------------------------------------------------
// Enclave-only deal (engines/arrow.adapter.js) — counter-mode SHA-256 stream
// ---------------------------------------------------------------------------

const OBSTACLE_W: i64 = 36;
const MAX_OBSTACLES: usize = 4;
const MAX_OBSTACLE_ATTEMPTS: usize = 40;
const TARGET_CLEARANCE: i64 = 110;
const X_SEPARATION: i64 = 90;
const BAND_MARGIN: i64 = 90;

fn u16_next(stream: &mut CounterStream) -> i64 {
    ((stream.next() as i64) << 8) | stream.next() as i64
}

fn wall_acceptable(tx: i64, ty: i64, ox: i64, oy: i64, oh: i64) -> bool {
    let dx = tx.clamp(ox, ox + OBSTACLE_W) - tx;
    let dy = ty.clamp(oy, oy + oh) - ty;
    if dx * dx + dy * dy < TARGET_CLEARANCE * TARGET_CLEARANCE {
        return false;
    }
    let above_band = oy + oh <= ty - BAND_MARGIN;
    let below_band = oy >= ty + BAND_MARGIN;
    above_band || below_band
}

fn separated(obstacles: &[(i64, i64, i64, i64)], ox: i64) -> bool {
    obstacles
        .iter()
        .all(|&(rect_x, ..)| (ox - rect_x).abs() >= X_SEPARATION)
}

fn deal_arrow(problem_secret: &[u8; 32], difficulty: u8) -> Vec<Level> {
    let clamped = (difficulty as usize).min(2);
    let mut stream = CounterStream::new(problem_secret);
    let level_count = LEVEL_TARGETS[clamped];
    let mut levels = Vec::new();
    for i in 0..level_count {
        let tx = 1180 + u16_next(&mut stream) % 340;
        let ty = 160 + u16_next(&mut stream) % 340;
        let wanted = std::cmp::min(1 + (i >> 1), MAX_OBSTACLES);
        let mut obstacles = Vec::new();
        for _slot in 0..wanted {
            for _attempt in 0..MAX_OBSTACLE_ATTEMPTS {
                let ox = 420 + u16_next(&mut stream) % 640;
                let oh = 240 + u16_next(&mut stream) % 300;
                let oy = u16_next(&mut stream) % (FIELD_H - oh);
                if !wall_acceptable(tx, ty, ox, oy, oh) {
                    continue;
                }
                if !separated(&obstacles, ox) {
                    continue;
                }
                obstacles.push((ox, oy, OBSTACLE_W, oh));
                break;
            }
        }
        levels.push(Level {
            target: (tx, ty),
            obstacles,
        });
    }
    levels
}

fn level_to_json(level: &Level) -> Json {
    serde_json::json!({
        "target": { "x": level.target.0, "y": level.target.1 },
        "obstacles": level
            .obstacles
            .iter()
            .map(|&(x, y, w, h)| serde_json::json!({ "x": x, "y": y, "w": w, "h": h }))
            .collect::<Vec<_>>(),
    })
}

/// The clues JSON string the client's `parseInitialState` consumes.
fn arrow_clues_view(problem_secret: &[u8; 32], difficulty: u8) -> String {
    let levels = deal_arrow(problem_secret, difficulty);
    serde_json::to_string(&serde_json::json!({
        "levels": levels.iter().map(level_to_json).collect::<Vec<_>>(),
    }))
    .expect("clues JSON serializes")
}

fn levels_of(state: &Json) -> Vec<Level> {
    state
        .get("levels")
        .and_then(Json::as_array)
        .expect("arrow state carries levels")
        .iter()
        .map(|level| {
            let target = level.get("target").expect("level carries target");
            let x = target.get("x").and_then(Json::as_i64).expect("target.x");
            let y = target.get("y").and_then(Json::as_i64).expect("target.y");
            let obstacles = level
                .get("obstacles")
                .and_then(Json::as_array)
                .expect("level carries obstacles")
                .iter()
                .map(|o| {
                    let get =
                        |key: &str| o.get(key).and_then(Json::as_i64).expect("obstacle field");
                    (get("x"), get("y"), get("w"), get("h"))
                })
                .collect();
            Level {
                target: (x, y),
                obstacles,
            }
        })
        .collect()
}

fn run_of(state: &Json) -> Run {
    let run = state.get("run").expect("arrow state carries run");
    Run {
        level_index: run.get("levelIndex").and_then(Json::as_i64).unwrap_or(0),
        cleared: run.get("cleared").and_then(Json::as_i64).unwrap_or(0),
        arrows_used: run.get("arrowsUsed").and_then(Json::as_i64).unwrap_or(0),
        budget: run.get("budget").and_then(Json::as_i64).unwrap_or(0),
        done: run.get("done").and_then(Json::as_bool).unwrap_or(false),
        won: run.get("won").and_then(Json::as_bool).unwrap_or(false),
    }
}

fn set_run(state: &mut Json, run: &Run) {
    state["run"] = serde_json::json!({
        "levelIndex": run.level_index,
        "cleared": run.cleared,
        "arrowsUsed": run.arrows_used,
        "budget": run.budget,
        "done": run.done,
        "won": run.won,
    });
}

fn replay_arrow(problem_secret: &[u8; 32], difficulty: u8, shots: &[Vec<i64>]) -> Run {
    let levels = deal_arrow(problem_secret, difficulty);
    let mut run = create_run(levels.len(), difficulty);
    for holds in shots {
        if run.done {
            break;
        }
        let (next, _) = apply_shot(&run, &levels, holds);
        run = next;
        if run.done {
            break;
        }
    }
    run
}

// ---------------------------------------------------------------------------
// Wrapper ABI
// ---------------------------------------------------------------------------

pub fn deal(problem_secret: &[u8; 32], difficulty: u8) -> (Json, Json) {
    let diff = (difficulty as usize).min(2) as u8;
    let levels = deal_arrow(problem_secret, diff);
    let run = create_run(levels.len(), diff);
    let state = serde_json::json!({
        "problemSecret": super::secret_to_json(problem_secret),
        "difficulty": diff,
        "levels": levels.iter().map(level_to_json).collect::<Vec<_>>(),
        "run": {
            "levelIndex": run.level_index,
            "cleared": run.cleared,
            "arrowsUsed": run.arrows_used,
            "budget": run.budget,
            "done": run.done,
            "won": run.won,
        },
        "shots": [],
    });
    let start_view = serde_json::json!({ "clues": arrow_clues_view(problem_secret, diff) });
    (state, start_view)
}

pub fn apply_op(state: &mut Json, op: &Json, _op_meta: &OpMeta) -> OpOutcome {
    if op_type_of(op) != "shot" {
        return OpOutcome::Rejected {
            message: "op.type must be 'shot'".into(),
            status: 400,
        };
    }
    let Some(holds) = normalize_holds(op.get("holds")) else {
        return OpOutcome::Rejected {
            message:
                "op.holds must be up to 6 strictly ascending [press,release) tick pairs in 0..479"
                    .into(),
            status: 400,
        };
    };
    if run_of(state).done {
        return OpOutcome::Rejected {
            message: "run is already over".into(),
            status: 409,
        };
    }
    let levels = levels_of(state);
    let run = run_of(state);
    let (next_run, outcome) = apply_shot(&run, &levels, &holds);
    set_run(state, &next_run);
    state
        .get_mut("shots")
        .and_then(Json::as_array_mut)
        .expect("arrow state carries shots")
        .push(Json::Array(
            holds.iter().map(|tick| Json::from(*tick)).collect(),
        ));
    OpOutcome::View(serde_json::json!({
        "ok": true,
        "hit": outcome.hit,
        "ring": outcome.ring,
        "cleared": next_run.cleared,
        "arrowsUsed": next_run.arrows_used,
        "done": next_run.done,
        "won": next_run.won,
    }))
}

pub fn apply_undo(_state: &mut Json, _op_meta: &OpMeta) -> OpOutcome {
    OpOutcome::Rejected {
        message: "undo not supported".into(),
        status: 400,
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
    let deal_difficulty = state.get("difficulty").and_then(Json::as_u64).unwrap_or(0) as u8;
    let shots: Vec<Vec<i64>> = state
        .get("shots")
        .and_then(Json::as_array)
        .expect("arrow state carries shots")
        .iter()
        .map(|shot| {
            shot.as_array()
                .expect("shot is a holds array")
                .iter()
                .filter_map(Json::as_i64)
                .collect()
        })
        .collect();
    let replayed = replay_arrow(&secret, deal_difficulty, &shots);
    let target = super::abi::resolve_target(&DESCRIPTOR.targets, difficulty, extra);
    if (replayed.cleared as f64) < target {
        return Err(ScoreRejection::with_status("target not reached", 403));
    }
    Ok(super::abi::ScoreOutcome {
        answer_hash: answer_hash_of(&format!(
            "arrow:{}:{}",
            replayed.cleared, replayed.arrows_used
        )),
        score: replayed.cleared,
        score_field: Some(serde_json::json!({
            "cleared": replayed.cleared,
            "arrowsUsed": replayed.arrows_used,
        })),
    })
}
