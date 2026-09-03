//! Flappy Dash — port of `game/wrappers/flappy.wrapper.js` over the
//! deterministic core in `engines/flappy.js` (GENERATED from the minigames TS
//! twin). Reflex genre: the host's enclave clock maps each flap onto its 60fps
//! frame; the finalize replay steps the physics to the authoritative score.

use serde_json::Value as Json;

use super::abi::{answer_hash_of, OpMeta, OpOutcome, ScoreExtra, ScoreRejection};
use super::{hex_encode, js_math_round, js_num_json, op_type_of};

pub const APP_ID: &str = "miniapp-flappy-dash";

pub const DESCRIPTOR: super::registry::EngineDescriptor = super::registry::EngineDescriptor {
    op_schema: "flap: {type:'flap'} | undo",
    targets: [5, 10, 20], // pipes passed
    time_window: super::registry::TimeWindow {
        limit_ms: [120_000.0, 180_000.0, 300_000.0],
        min_solve_ms: [20_000.0, 30_000.0, 45_000.0],
    },
    gates: super::abi::DEFAULT_GATES,
    reveal_policy: super::abi::RevealPolicy::Seed,
    max_ops: 20_000,
    max_undos: 3,
    undo_penalty_pct: 30,
    // reflex: score depends on enclave op-timing the log does not carry
    log_deterministic: false,
    start_config_key: Some("target_pipes"),
};

pub static ENGINE: super::registry::EngineHandle = super::registry::EngineHandle {
    app_id: APP_ID,
    engine_hash: "401bb3de1c04a8b20c18d35a9f0750f33647361060884f275d6954d3c74c2b1c",
    descriptor: DESCRIPTOR,
    deal,
    apply_op,
    apply_undo,
    replay,
    score,
};

const CANVAS_WIDTH: f64 = 400.0;
const CANVAS_HEIGHT: f64 = 600.0;
const GROUND_HEIGHT: f64 = 80.0;
const BIRD_WIDTH: f64 = 34.0;
const BIRD_HEIGHT: f64 = 24.0;
const BIRD_X: f64 = 80.0;
const PIPE_WIDTH: f64 = 52.0;
pub const FRAME_MS: f64 = 1000.0 / 60.0;
const GRAVITY: f64 = 0.45;
const FLAP_VELOCITY: f64 = -7.2;
const MAX_FALL_VELOCITY: f64 = 10.0;
const BIRD_START_Y: f64 = CANVAS_HEIGHT / 2.0 - BIRD_HEIGHT / 2.0;
const PIPE_GAP: f64 = 140.0;
const PIPE_SPEED: f64 = 2.5;
const PIPE_SPAWN_INTERVAL: f64 = 100.0;
const MIN_PIPE_TOP: i64 = 60;
const MAX_PIPE_BOTTOM: i64 = 320; // CANVAS_HEIGHT - GROUND_HEIGHT - PIPE_GAP - 60
const FIRST_SPAWN_FRAME: f64 = 60.0;

// ---------------------------------------------------------------------------
// Generated core
// ---------------------------------------------------------------------------

fn hash_seed(seed: &str) -> u32 {
    let mut hash: i32 = 0;
    for ch in seed.chars() {
        hash = hash.wrapping_mul(31).wrapping_add(ch as u32 as i32);
    }
    super::js_to_uint32(hash as f64)
}

struct SeededRandom {
    state: u32,
}

impl SeededRandom {
    fn new(seed: &str) -> Self {
        Self {
            state: hash_seed(seed),
        }
    }

    fn next(&mut self) -> f64 {
        // i32 xorshift: `<<` is wrapping, `>>` is arithmetic on the signed value.
        let mut s = self.state as i32;
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        self.state = super::js_to_uint32(s as f64);
        (self.state % 1_000_000) as f64 / 1_000_000.0
    }

    fn next_int(&mut self, min: i64, max: i64) -> i64 {
        min + (self.next() * ((max - min + 1) as f64)).floor() as i64
    }
}

pub fn seed_string(problem_secret: &[u8; 32]) -> String {
    hex_encode(problem_secret)
}

struct Pipe {
    x: f64,
    gap_y: i64,
    scored: bool,
}

#[derive(Default)]
struct FlappyState {
    bird_y: f64,
    bird_vy: f64,
    rotation: f64,
    pipes: Vec<Pipe>,
    playing: bool,
    crashed: bool,
    score: i64,
    frame: i64,
    rng: Option<SeededRandom>,
    next_spawn_frame: f64,
}

#[allow(clippy::too_many_arguments)]
fn rect_overlap(ax: f64, ay: f64, aw: f64, ah: f64, bx: f64, by: f64, bw: f64, bh: f64) -> bool {
    ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by
}

fn spawn_pipe(state: &mut FlappyState) -> Pipe {
    let rng = state.rng.as_mut().expect("flappy run carries its rng");
    let gap_y = rng.next_int(MIN_PIPE_TOP, MAX_PIPE_BOTTOM);
    Pipe {
        x: CANVAS_WIDTH,
        gap_y,
        scored: false,
    }
}

fn step_frame(state: &mut FlappyState) {
    if !state.playing {
        return;
    }
    state.frame += 1;
    state.bird_vy += GRAVITY;
    if state.bird_vy > MAX_FALL_VELOCITY {
        state.bird_vy = MAX_FALL_VELOCITY;
    }
    state.bird_y += state.bird_vy;
    state.rotation = (-25.0f64).max(90.0f64.min(state.bird_vy * 3.0));
    if state.bird_y + BIRD_HEIGHT >= CANVAS_HEIGHT - GROUND_HEIGHT {
        state.bird_y = CANVAS_HEIGHT - GROUND_HEIGHT - BIRD_HEIGHT;
        state.crashed = true;
        return;
    }
    if state.bird_y <= 0.0 {
        state.bird_y = 0.0;
        state.bird_vy = 0.0;
    }
    if state.frame as f64 >= state.next_spawn_frame {
        let pipe = spawn_pipe(state);
        state.pipes.push(pipe);
        state.next_spawn_frame = state.frame as f64 + PIPE_SPAWN_INTERVAL;
    }
    for index in (0..state.pipes.len()).rev() {
        let pipe = &mut state.pipes[index];
        pipe.x -= PIPE_SPEED;
        if !pipe.scored && pipe.x + PIPE_WIDTH < BIRD_X {
            pipe.scored = true;
            state.score += 1;
        }
        if pipe.x + PIPE_WIDTH < 0.0 {
            state.pipes.remove(index);
        }
    }
    for pipe in &state.pipes {
        if rect_overlap(
            BIRD_X,
            state.bird_y,
            BIRD_WIDTH,
            BIRD_HEIGHT,
            pipe.x,
            0.0,
            PIPE_WIDTH,
            pipe.gap_y as f64,
        ) {
            state.crashed = true;
            return;
        }
        let bottom_pipe_y = pipe.gap_y as f64 + PIPE_GAP;
        if rect_overlap(
            BIRD_X,
            state.bird_y,
            BIRD_WIDTH,
            BIRD_HEIGHT,
            pipe.x,
            bottom_pipe_y,
            PIPE_WIDTH,
            CANVAS_HEIGHT - GROUND_HEIGHT - bottom_pipe_y,
        ) {
            state.crashed = true;
            return;
        }
    }
}

struct FlappyRun {
    pipes_passed: i64,
}

fn replay_flappy(seed: &str, flap_frames: &[i64], max_frame: f64) -> FlappyRun {
    let mut state = FlappyState {
        bird_y: BIRD_START_Y,
        bird_vy: 0.0,
        rotation: 0.0,
        pipes: Vec::new(),
        playing: true,
        crashed: false,
        score: 0,
        frame: 0,
        rng: Some(SeededRandom::new(seed)),
        next_spawn_frame: FIRST_SPAWN_FRAME,
    };
    let mut frames = flap_frames.to_vec();
    frames.sort_unstable();
    let mut flap_cursor = 0usize;
    let cap = max_frame.trunc().max(0.0) as i64;
    for frame in 1..=cap {
        while flap_cursor < frames.len() && frames[flap_cursor] < frame {
            flap_cursor += 1;
        }
        while flap_cursor < frames.len() && frames[flap_cursor] == frame {
            if state.playing {
                state.bird_vy = FLAP_VELOCITY;
            }
            flap_cursor += 1;
        }
        step_frame(&mut state);
        if state.crashed {
            break;
        }
    }
    FlappyRun {
        pipes_passed: state.score,
    }
}

pub fn flappy_answer(pipes_passed: i64, flap_frames: &[i64]) -> String {
    let mut frames = flap_frames.to_vec();
    frames.sort_unstable();
    let joined = frames
        .iter()
        .map(|f| f.to_string())
        .collect::<Vec<_>>()
        .join(",");
    format!("flappy:{pipes_passed}:{joined}")
}

// ---------------------------------------------------------------------------
// Wrapper ABI
// ---------------------------------------------------------------------------

pub fn deal(problem_secret: &[u8; 32], _difficulty: u8) -> (Json, Json) {
    let state = serde_json::json!({
        "problemSecret": super::secret_to_json(problem_secret),
        "flapFrames": [],
    });
    let start_view = serde_json::json!({ "seed": seed_string(problem_secret) });
    (state, start_view)
}

pub fn apply_op(state: &mut Json, op: &Json, op_meta: &OpMeta) -> OpOutcome {
    let type_name = op_type_of(op);
    if type_name != "flap" {
        return OpOutcome::Rejected {
            message: "op.type must be flap or undo".into(),
            status: 400,
        };
    }
    let frames_len = state
        .get("flapFrames")
        .and_then(Json::as_array)
        .map_or(0, Vec::len);
    let frame = if op_meta.resumed {
        ((frames_len + 1) * 12) as f64
    } else {
        let elapsed = op_meta.elapsed_ms.unwrap_or(0.0);
        js_math_round(elapsed / FRAME_MS).max(1.0)
    };
    state
        .get_mut("flapFrames")
        .and_then(Json::as_array_mut)
        .expect("flappy state carries flapFrames")
        .push(js_num_json(frame));
    OpOutcome::View(serde_json::json!({ "ok": true }))
}

pub fn apply_undo(state: &mut Json, _op_meta: &OpMeta) -> OpOutcome {
    let frames_empty = state
        .get("flapFrames")
        .and_then(Json::as_array)
        .map(Vec::is_empty)
        .unwrap_or(true);
    if frames_empty {
        return OpOutcome::Rejected {
            message: "nothing to undo".into(),
            status: 409,
        };
    }
    state
        .get_mut("flapFrames")
        .and_then(Json::as_array_mut)
        .expect("flappy state carries flapFrames")
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
    let span_ms = match extra.elapsed_ms {
        Some(elapsed) if elapsed.is_finite() => elapsed,
        _ => ((extra.now_ms.unwrap_or(0.0)) - (extra.started_at_ms.unwrap_or(0.0))).max(0.0),
    };
    let max_frame = (span_ms / FRAME_MS).ceil();
    let secret = super::state_secret(state);
    let flap_frames: Vec<i64> = state
        .get("flapFrames")
        .and_then(Json::as_array)
        .expect("flappy state carries flapFrames")
        .iter()
        .filter_map(|f| f.as_i64())
        .collect();
    let run = replay_flappy(&seed_string(&secret), &flap_frames, max_frame);
    let target = super::abi::resolve_target(&DESCRIPTOR.targets, difficulty, extra);
    if (run.pipes_passed as f64) < target {
        return Err(ScoreRejection::new("target pipes not reached"));
    }
    let answer_hash = answer_hash_of(&flappy_answer(run.pipes_passed, &flap_frames));
    Ok(super::abi::ScoreOutcome {
        answer_hash,
        score: run.pipes_passed,
        score_field: Some(serde_json::json!({
            "pipes_passed": run.pipes_passed,
            "state_hash": hex_encode(&answer_hash),
        })),
    })
}
