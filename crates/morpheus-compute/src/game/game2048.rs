//! 2048 — port of `game/wrappers/game2048.wrapper.js` over the deterministic
//! core in `engines/game2048.js` (GENERATED from the minigames TS twin) plus
//! the enclave-only spawn stream in `engines/game2048.adapter.js`.
//!
//! Exponents live on the board (2**exp values); every valid move consumes one
//! spawn off the counter-mode SHA-256 stream (position over free cells, then
//! the value byte — 2 when `byte % 10 == 0`, else 1).

use serde_json::Value as Json;

use super::abi::{answer_hash_of, OpMeta, OpOutcome, ScoreExtra, ScoreRejection};
use super::{number_field, op_type_of, CounterStream};

pub const APP_ID: &str = "miniapp-game-2048";

pub const DESCRIPTOR: super::registry::EngineDescriptor = super::registry::EngineDescriptor {
    op_schema: "move: {type:'move', dir:0..3} | undo",
    targets: [9, 10, 11], // maxExp thresholds → 512 / 1024 / 2048
    time_window: super::registry::TimeWindow {
        limit_ms: [240_000.0, 480_000.0, 900_000.0],
        min_solve_ms: [60_000.0, 120_000.0, 240_000.0],
    },
    gates: super::abi::DEFAULT_GATES,
    reveal_policy: super::abi::RevealPolicy::PerMove,
    max_ops: 20_000,
    max_undos: 3,
    undo_penalty_pct: 30,
    log_deterministic: true,
    start_config_key: Some("target_exp"),
};

pub static ENGINE: super::registry::EngineHandle = super::registry::EngineHandle {
    app_id: APP_ID,
    engine_hash: "9625b729f6bf9ce2cfc3849fd62cb8cbd9b4af1a05f2a56caba0d67d2b966fef",
    descriptor: DESCRIPTOR,
    deal,
    apply_op,
    apply_undo,
    replay,
    score,
};

// ---------------------------------------------------------------------------
// Generated core — applyMove (slide + merge, no motion bookkeeping needed)
// ---------------------------------------------------------------------------

fn line_indices(dir: i64) -> [[usize; 4]; 4] {
    let mut lines = [[0usize; 4]; 4];
    for (a, row) in lines.iter_mut().enumerate() {
        for (b, cell) in row.iter_mut().enumerate() {
            *cell = if dir == 3 {
                a * 4 + b // LEFT
            } else if dir == 1 {
                a * 4 + (3 - b) // RIGHT
            } else if dir == 0 {
                b * 4 + a // UP
            } else {
                (3 - b) * 4 + a // DOWN
            };
        }
    }
    lines
}

fn trace_slide(board: &[i64; 16], dir: i64) -> Option<[i64; 16]> {
    if !(0..=3).contains(&dir) {
        return None;
    }
    let mut after_slide = [0i64; 16];
    let mut changed = false;
    for idx in line_indices(dir) {
        let tiles: Vec<(usize, i64)> = idx
            .iter()
            .map(|&source| (source, board[source]))
            .filter(|&(_, exp)| exp > 0)
            .collect();
        let mut destination_offset = 0usize;
        let mut i = 0usize;
        while i < tiles.len() {
            let (source, exponent) = tiles[i];
            let next = tiles.get(i + 1).copied();
            let destination = idx[destination_offset];
            match next {
                Some((next_source, next_exp)) if next_exp == exponent => {
                    after_slide[destination] = exponent + 1;
                    changed = true;
                    let _ = next_source;
                    i += 1;
                }
                _ => {
                    after_slide[destination] = exponent;
                    if source != destination {
                        changed = true;
                    }
                }
            }
            destination_offset += 1;
            i += 1;
        }
    }
    changed.then_some(after_slide)
}

fn apply_move(board: &mut [i64; 16], dir: i64) -> bool {
    match trace_slide(board, dir) {
        Some(after_slide) => {
            *board = after_slide;
            true
        }
        None => false,
    }
}

fn moves_to_string(moves: &[Json]) -> String {
    let all_dirs = moves
        .iter()
        .all(|m| matches!(m.as_i64(), Some(d) if (0..=3).contains(&d)));
    if !all_dirs {
        return String::new();
    }
    moves
        .iter()
        .filter_map(|m| m.as_i64())
        .map(|d| d.to_string())
        .collect::<Vec<_>>()
        .join("")
}

// ---------------------------------------------------------------------------
// Adapter — spawn stream + run bookkeeping
// ---------------------------------------------------------------------------

/// ENCLAVE-ONLY spawn draw. JS `spawnInto` throws 'spawn on full board' on an
/// occupied board, but every caller reaches it only after a board-changing
/// move (which necessarily merged on a full board) or onto the fresh run —
/// the draw cannot fail, so the unreachable branch panics like the JS throw.
fn spawn_into(board: &mut [i64; 16], stream: &mut CounterStream) -> (usize, i64) {
    let free: Vec<usize> = (0..16).filter(|&i| board[i] == 0).collect();
    assert!(!free.is_empty(), "spawn on full board");
    let pos = free[(stream.next() as usize) % free.len()];
    let exp = if stream.next().is_multiple_of(10) {
        2
    } else {
        1
    };
    board[pos] = exp;
    (pos, exp)
}

fn rng_json(state: (u32, u8)) -> Json {
    serde_json::json!({ "k": state.0, "cursor": state.1 })
}

fn board_json(board: &[i64; 16]) -> Json {
    Json::Array(board.iter().map(|v| (*v).into()).collect())
}

fn read_board(state: &Json) -> [i64; 16] {
    let mut board = [0i64; 16];
    for (i, cell) in state
        .pointer("/run/board")
        .and_then(Json::as_array)
        .expect("2048 state carries run.board")
        .iter()
        .take(16)
        .enumerate()
    {
        board[i] = cell.as_i64().unwrap_or(0);
    }
    board
}

fn read_rng(state: &Json) -> (u32, u8) {
    let rng = state
        .pointer("/run/rng")
        .expect("2048 state carries run.rng");
    let k = rng.get("k").and_then(Json::as_u64).unwrap_or(0) as u32;
    let cursor = rng.get("cursor").and_then(Json::as_u64).unwrap_or(32) as u8;
    (k, cursor)
}

/// Fresh run: two spawns off the head of the stream.
fn new_run(seed: &[u8; 32]) -> Json {
    let mut stream = CounterStream::new(seed);
    let mut board = [0i64; 16];
    spawn_into(&mut board, &mut stream);
    spawn_into(&mut board, &mut stream);
    let max_exp = *board.iter().max().unwrap_or(&0);
    serde_json::json!({ "board": board_json(&board), "rng": rng_json(stream.state()), "maxExp": max_exp })
}

/// One player move: the next run state (with the consumed spawn reported) or
/// None when the move does not change the board (invalid — no spawn consumed).
fn step_run(seed: &[u8; 32], state: &Json, dir: i64) -> Option<Json> {
    let mut board = read_board(state);
    if !apply_move(&mut board, dir) {
        return None;
    }
    let mut stream = CounterStream::resumed(seed, read_rng(state).0, read_rng(state).1);
    let (pos, exp) = spawn_into(&mut board, &mut stream);
    let max_exp = read_max_exp(state).max(*board.iter().max().unwrap_or(&0));
    Some(serde_json::json!({
        "board": board_json(&board),
        "rng": rng_json(stream.state()),
        "maxExp": max_exp,
        "spawn": { "pos": pos, "exp": exp },
    }))
}

fn read_max_exp(state: &Json) -> i64 {
    state
        .pointer("/run/maxExp")
        .and_then(Json::as_i64)
        .unwrap_or(0)
}

/// Full-run replay — every move must be board-changing or ok is false.
fn replay_run(seed: &[u8; 32], moves: &[i64]) -> (bool, [i64; 16], (u32, u8), i64) {
    let mut stream = CounterStream::new(seed);
    let mut board = [0i64; 16];
    spawn_into(&mut board, &mut stream);
    spawn_into(&mut board, &mut stream);
    let mut max_exp = *board.iter().max().unwrap_or(&0);
    for &m in moves {
        if !(0..=3).contains(&m) || !apply_move(&mut board, m) {
            return (false, board, stream.state(), max_exp);
        }
        spawn_into(&mut board, &mut stream);
        max_exp = max_exp.max(*board.iter().max().unwrap_or(&0));
    }
    (true, board, stream.state(), max_exp)
}

// ---------------------------------------------------------------------------
// Wrapper ABI
// ---------------------------------------------------------------------------

pub fn deal(problem_secret: &[u8; 32], _difficulty: u8) -> (Json, Json) {
    let run = new_run(problem_secret);
    let board = run.get("board").cloned().expect("new_run carries board");
    let state = serde_json::json!({
        "problemSecret": super::secret_to_json(problem_secret),
        "run": run,
        "moves": [],
    });
    (state, serde_json::json!({ "board": board }))
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
    let seed = super::state_secret(state);
    let Some(next) = step_run(&seed, state, dir as i64) else {
        return OpOutcome::View(serde_json::json!({ "ok": false }));
    };
    let spawn = next.get("spawn").cloned().expect("step_run carries spawn");
    let board = next.get("board").cloned().expect("step_run carries board");
    state["run"] = serde_json::json!({
        "board": board,
        "rng": next.get("rng").cloned().expect("step_run carries rng"),
        "maxExp": next.get("maxExp").cloned().expect("step_run carries maxExp"),
    });
    state
        .get_mut("moves")
        .and_then(Json::as_array_mut)
        .expect("2048 state carries moves")
        .push(super::js_num_json(dir));
    OpOutcome::View(serde_json::json!({ "ok": true, "spawn": spawn, "board": board }))
}

pub fn apply_undo(state: &mut Json, _op_meta: &OpMeta) -> OpOutcome {
    let moves_len = state
        .get("moves")
        .and_then(Json::as_array)
        .map_or(0, Vec::len);
    if moves_len == 0 {
        return OpOutcome::Rejected {
            message: "nothing to undo".into(),
            status: 409,
        };
    }
    let seed = super::state_secret(state);
    let moves: Vec<i64> = {
        let arr = state
            .get_mut("moves")
            .and_then(Json::as_array_mut)
            .expect("2048 state carries moves");
        arr.pop();
        arr.iter().filter_map(|m| m.as_i64()).collect()
    };
    let (_, board, rng, max_exp) = replay_run(&seed, &moves);
    state["run"] = serde_json::json!({
        "board": board_json(&board),
        "rng": rng_json(rng),
        "maxExp": max_exp,
    });
    OpOutcome::View(serde_json::json!({ "ok": true, "board": board_json(&board) }))
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
        if outcome.is_rejected() || outcome.view_ok_false() {
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
    let target = super::abi::resolve_target(&DESCRIPTOR.targets, difficulty, extra);
    let max_exp = read_max_exp(state);
    if max_exp < target as i64 {
        return Err(ScoreRejection::new("target tile not reached"));
    }
    let moves = state
        .get("moves")
        .and_then(Json::as_array)
        .expect("2048 state carries moves");
    Ok(super::abi::ScoreOutcome {
        answer_hash: answer_hash_of(&moves_to_string(moves)),
        score: max_exp,
        score_field: None,
    })
}
