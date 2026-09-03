//! Snake Bounty — port of `game/wrappers/snake.wrapper.js` over the GENERATED
//! rule core in `engines/snake.js` plus the enclave-only deal in
//! `engines/snake.adapter.js` (counter-mode SHA-256 deal, clues view, replay
//! accounting, canonical answer string).

use serde_json::Value as Json;

use super::abi::{answer_hash_of, OpMeta, OpOutcome, ScoreExtra, ScoreRejection};
use super::{js_num_json, number_field, op_type_of, CounterStream};

pub const APP_ID: &str = "miniapp-snake-bounty";

pub const DESCRIPTOR: super::registry::EngineDescriptor = super::registry::EngineDescriptor {
    op_schema: "move: {type:'move', dir:0..3} | undo",
    targets: [10, 20, 35], // snake length
    time_window: super::registry::TimeWindow {
        limit_ms: [180_000.0, 300_000.0, 600_000.0],
        min_solve_ms: [20_000.0, 40_000.0, 60_000.0],
    },
    gates: super::abi::DEFAULT_GATES,
    reveal_policy: super::abi::RevealPolicy::Clues,
    max_ops: 20_000,
    max_undos: 3,
    undo_penalty_pct: 30,
    log_deterministic: true,
    start_config_key: Some("target_length"),
};

pub static ENGINE: super::registry::EngineHandle = super::registry::EngineHandle {
    app_id: APP_ID,
    engine_hash: "fda503867ba9592db786de45a9be1e1ae8125f57d2d7eaddcbf5f5251dabe06a",
    descriptor: DESCRIPTOR,
    deal,
    apply_op,
    apply_undo,
    replay,
    score,
};

const GRID_SIZE: i64 = 20;
// Enough food to cover the hardest target (35) with generous headroom.
const FOOD_QUEUE_LEN: usize = 64;
const INITIAL_LENGTH: i64 = 3;

// ---------------------------------------------------------------------------
// Adapter — deal (enclave-only)
// ---------------------------------------------------------------------------

fn point_json(p: (i64, i64)) -> Json {
    serde_json::json!({ "x": p.0, "y": p.1 })
}

/// The deterministic opening position from the secret: a horizontal snake of
/// INITIAL_LENGTH heading right, centred, then a food queue of distinct cells
/// that never land on the initial body. Pure function of the secret.
fn deal_snake(problem_secret: &[u8; 32]) -> Json {
    let mut stream = CounterStream::new(problem_secret);
    let head_x = 8 + (stream.next() % 4) as i64; // 8..11 — keeps room to the right
    let head_y = 6 + (stream.next() % 8) as i64; // 6..13
    let body: Vec<(i64, i64)> = (0..INITIAL_LENGTH).map(|i| (head_x - i, head_y)).collect();

    let mut occupied = std::collections::HashSet::new();
    for &(x, y) in &body {
        occupied.insert(y * GRID_SIZE + x);
    }
    let mut food_cells: Vec<(i64, i64)> = Vec::new();
    let mut guard = 0;
    while food_cells.len() < FOOD_QUEUE_LEN && guard < 100_000 {
        guard += 1;
        let x = (stream.next() % GRID_SIZE as u8) as i64;
        let y = (stream.next() % GRID_SIZE as u8) as i64;
        if occupied.insert(y * GRID_SIZE + x) {
            food_cells.push((x, y));
        }
    }
    let food = food_cells[0];
    let food_queue = &food_cells[1..];
    serde_json::json!({
        "body": body.iter().map(|&p| point_json(p)).collect::<Vec<_>>(),
        "direction": 1,
        "food": point_json(food),
        "foodQueue": food_queue.iter().map(|&p| point_json(p)).collect::<Vec<_>>(),
        "initialLength": INITIAL_LENGTH,
    })
}

/// The clues JSON the frontend snake-engine.parseInitialState consumes.
fn snake_clues_view(problem_secret: &[u8; 32]) -> String {
    let dealt = deal_snake(problem_secret);
    serde_json::json!({
        "body": dealt.get("body").cloned().unwrap_or_default(),
        "direction": dealt.get("direction").cloned().unwrap_or_default(),
        "food": dealt.get("food").cloned().unwrap_or_default(),
        "foodQueue": dealt.get("foodQueue").cloned().unwrap_or_default(),
    })
    .to_string()
}

// ---------------------------------------------------------------------------
// Generated core — step()
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct GameState {
    body: Vec<(i64, i64)>,
    food: (i64, i64),
    food_queue: Vec<(i64, i64)>,
    dead: bool,
    eaten: i64,
}

fn fresh_state(dealt: &Json) -> GameState {
    let read_point = |value: &Json| -> (i64, i64) {
        (
            value.get("x").and_then(Json::as_i64).unwrap_or(0),
            value.get("y").and_then(Json::as_i64).unwrap_or(0),
        )
    };
    let read_points = |value: Option<&Json>| -> Vec<(i64, i64)> {
        value
            .and_then(Json::as_array)
            .map(|arr| arr.iter().map(read_point).collect())
            .unwrap_or_default()
    };
    GameState {
        body: read_points(dealt.get("body")),
        food: read_point(dealt.get("food").unwrap_or(&Json::Null)),
        food_queue: read_points(dealt.get("foodQueue")),
        dead: false,
        eaten: 0,
    }
}

fn in_bounds(p: (i64, i64)) -> bool {
    p.0 >= 0 && p.0 < GRID_SIZE && p.1 >= 0 && p.1 < GRID_SIZE
}

fn overlaps_body(p: (i64, i64), body: &[(i64, i64)], exclude_head: bool) -> bool {
    body.iter()
        .skip(if exclude_head { 1 } else { 0 })
        .any(|&seg| seg == p)
}

fn direction_vector(direction: i64) -> (i64, i64) {
    match direction {
        0 => (0, -1),
        1 => (1, 0),
        2 => (0, 1),
        _ => (-1, 0),
    }
}

/// Advance one move. Returns the next state plus `changed` — false when the
/// move is out of range, the snake is dead, or the direction is a direct
/// reversal into the neck (rejected no-op, classic snake input filtering).
/// The generated step() is immutable and JSON-equal on a no-op, so `changed`
/// is exactly "the two no-op branches were not taken" (every other branch
/// updates dead, direction or body).
fn step_snake(state: &GameState, direction: i64) -> (GameState, bool) {
    if state.dead {
        return (state.clone(), false);
    }
    if !(0..=3).contains(&direction) {
        return (state.clone(), false);
    }
    let Some(&head) = state.body.first() else {
        return (state.clone(), false);
    };
    let vec = direction_vector(direction);
    let new_head = (head.0 + vec.0, head.1 + vec.1);
    if let Some(&neck) = state.body.get(1) {
        if new_head == neck {
            return (state.clone(), false);
        }
    }
    if !in_bounds(new_head) {
        return (
            GameState {
                dead: true,
                ..state.clone()
            },
            true,
        );
    }
    let will_eat = new_head == state.food;
    if will_eat {
        if overlaps_body(new_head, &state.body, false) {
            return (
                GameState {
                    dead: true,
                    ..state.clone()
                },
                true,
            );
        }
        let mut new_body = vec![new_head];
        new_body.extend(state.body.iter().copied());
        let (next_food, new_food_queue) = if !state.food_queue.is_empty() {
            (state.food_queue[0], state.food_queue[1..].to_vec())
        } else {
            (state.food, Vec::new())
        };
        return (
            GameState {
                body: new_body,

                food: next_food,
                food_queue: new_food_queue,
                eaten: state.eaten + 1,
                ..state.clone()
            },
            true,
        );
    }
    let body_without_tail = &state.body[..state.body.len() - 1];
    if overlaps_body(new_head, body_without_tail, false) {
        return (
            GameState {
                dead: true,
                ..state.clone()
            },
            true,
        );
    }
    let mut new_body = vec![new_head];
    new_body.extend(body_without_tail.iter().copied());
    (
        GameState {
            body: new_body,
            ..state.clone()
        },
        true,
    )
}

struct Replayed {
    state: GameState,
    eaten: i64,
    length: i64,
    dead: bool,
}

/// Replay the accepted move directions from the deal. A move that kills the
/// snake ends the replay; unchanged no-ops are skipped.
fn replay_snake(problem_secret: &[u8; 32], dirs: &[i64]) -> Replayed {
    let dealt = deal_snake(problem_secret);
    let mut state = fresh_state(&dealt);
    for &dir in dirs {
        if state.dead {
            break;
        }
        let (next, changed) = step_snake(&state, dir);
        if !changed {
            continue;
        }
        state = next;
        if state.dead {
            break;
        }
    }
    Replayed {
        eaten: state.eaten,
        length: state.body.len() as i64,
        dead: state.dead,
        state,
    }
}

fn body_json(body: &[(i64, i64)]) -> Json {
    Json::Array(body.iter().map(|&p| point_json(p)).collect())
}

/// Canonical answer string the enclave hashes for SETTLE.
fn snake_answer(length: i64, dirs: &[i64]) -> String {
    let joined = dirs.iter().map(|d| d.to_string()).collect::<String>();
    format!("snake:{length}:{joined}")
}

// ---------------------------------------------------------------------------
// Wrapper ABI
// ---------------------------------------------------------------------------

pub fn deal(problem_secret: &[u8; 32], _difficulty: u8) -> (Json, Json) {
    let state = serde_json::json!({
        "problemSecret": super::secret_to_json(problem_secret),
        "deal": deal_snake(problem_secret),
        "dirs": [],
    });
    let start_view = serde_json::json!({ "clues": snake_clues_view(problem_secret) });
    (state, start_view)
}

pub fn apply_op(state: &mut Json, op: &Json, _op_meta: &OpMeta) -> OpOutcome {
    let type_name = op_type_of(op);
    if type_name != "move" {
        return OpOutcome::Rejected {
            message: "op.type must be move or undo".into(),
            status: 400,
        };
    }
    let dir = number_field(op.get("dir"));
    if !dir.is_finite() || dir.fract() != 0.0 || !(0.0..=3.0).contains(&dir) {
        return OpOutcome::Rejected {
            message: "op.dir must be an integer 0..3 (0=up 1=right 2=down 3=left)".into(),
            status: 400,
        };
    }
    let dirs_played: Vec<i64> = {
        let dirs = state
            .get_mut("dirs")
            .and_then(Json::as_array_mut)
            .expect("snake state carries dirs");
        dirs.push(js_num_json(dir));
        dirs.iter().filter_map(|d| d.as_i64()).collect()
    };
    let secret = super::state_secret(state);
    let rebuilt = replay_snake(&secret, &dirs_played);
    let view = serde_json::json!({
        "ok": true,
        "body": body_json(&rebuilt.state.body),
        "food": point_json(rebuilt.state.food),
        "eaten": rebuilt.eaten,
        "length": rebuilt.length,
        "dead": rebuilt.dead,
    });
    OpOutcome::View(view)
}

pub fn apply_undo(state: &mut Json, _op_meta: &OpMeta) -> OpOutcome {
    let dirs_len = state
        .get("dirs")
        .and_then(Json::as_array)
        .map_or(0, Vec::len);
    if dirs_len == 0 {
        return OpOutcome::Rejected {
            message: "nothing to undo".into(),
            status: 409,
        };
    }
    let dirs_played: Vec<i64> = {
        let arr = state
            .get_mut("dirs")
            .and_then(Json::as_array_mut)
            .expect("snake state carries dirs");
        arr.pop();
        arr.iter().filter_map(|d| d.as_i64()).collect()
    };
    let secret = super::state_secret(state);
    let rebuilt = replay_snake(&secret, &dirs_played);
    let view = serde_json::json!({
        "ok": true,
        "body": body_json(&rebuilt.state.body),
        "food": point_json(rebuilt.state.food),
        "eaten": rebuilt.eaten,
    });
    OpOutcome::View(view)
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
    let dirs: Vec<i64> = state
        .get("dirs")
        .and_then(Json::as_array)
        .expect("snake state carries dirs")
        .iter()
        .filter_map(|d| d.as_i64())
        .collect();
    let replayed = replay_snake(&secret, &dirs);
    let target = super::abi::resolve_target(&DESCRIPTOR.targets, difficulty, extra);
    if (replayed.length as f64) < target {
        return Err(ScoreRejection::new("target length not reached"));
    }
    Ok(super::abi::ScoreOutcome {
        answer_hash: answer_hash_of(&snake_answer(replayed.length, &dirs)),
        score: replayed.length,
        score_field: Some(serde_json::json!({
            "length": replayed.length,
            "eaten": replayed.eaten,
        })),
    })
}
