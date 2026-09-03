//! Merge Kingdom — port of `game/wrappers/merge.wrapper.js` over the GENERATED
//! rule core in `engines/merge.js` plus the enclave-only spawn stream in
//! `engines/merge.adapter.js`. Reveal-per-move: the next spawn is disclosed
//! only after a merge, never up front. A reposition consumes NO stream bytes —
//! the rng cursor only advances on merges.

use serde_json::Value as Json;

use super::abi::{answer_hash_of, OpMeta, OpOutcome, ScoreExtra, ScoreRejection};
use super::{op_type_of, CounterStream};

pub const APP_ID: &str = "miniapp-merge-kingdom";

pub const DESCRIPTOR: super::registry::EngineDescriptor = super::registry::EngineDescriptor {
    op_schema: "move: {type:'move', from:{row,col}, to:{row,col}} | undo",
    targets: [64, 256, 1024], // highest tile value
    time_window: super::registry::TimeWindow {
        limit_ms: [180_000.0, 300_000.0, 600_000.0],
        min_solve_ms: [30_000.0, 60_000.0, 120_000.0],
    },
    gates: super::abi::DEFAULT_GATES,
    reveal_policy: super::abi::RevealPolicy::PerMove,
    max_ops: 20_000,
    max_undos: 3,
    undo_penalty_pct: 30,
    log_deterministic: true,
    start_config_key: Some("target_tile"),
};

pub static ENGINE: super::registry::EngineHandle = super::registry::EngineHandle {
    app_id: APP_ID,
    engine_hash: "32bbfb4096cf17d266bab76f80351b99ca07b86720248b95510b0991efaf95e2",
    descriptor: DESCRIPTOR,
    deal,
    apply_op,
    apply_undo,
    replay,
    score,
};

const BOARD_SIZE: i64 = 4;
const CELLS: usize = 16;
const INITIAL_TILES: usize = 4; // opening tiles seeded from the stream

// ---------------------------------------------------------------------------
// Adapter — flat board + spawn stream
// ---------------------------------------------------------------------------

fn spawn_into(board: &mut [i64; CELLS], stream: &mut CounterStream) -> Option<(usize, i64)> {
    let free: Vec<usize> = (0..CELLS).filter(|&i| board[i] == 0).collect();
    if free.is_empty() {
        return None;
    }
    let cell = free[(stream.next() as usize) % free.len()];
    let value = if stream.next().is_multiple_of(10) {
        4
    } else {
        2
    };
    board[cell] = value;
    Some((cell, value))
}

fn rng_json(state: (u32, u8)) -> Json {
    serde_json::json!({ "k": state.0, "cursor": state.1 })
}

fn board_json(board: &[i64; CELLS]) -> Json {
    Json::Array(board.iter().map(|v| (*v).into()).collect())
}

fn read_board(merge: &Json) -> [i64; CELLS] {
    let mut board = [0i64; CELLS];
    for (i, cell) in merge
        .get("board")
        .and_then(Json::as_array)
        .expect("merge state carries merge.board")
        .iter()
        .take(CELLS)
        .enumerate()
    {
        board[i] = cell.as_i64().unwrap_or(0);
    }
    board
}

fn read_rng(merge: &Json) -> (u32, u8) {
    let rng = merge.get("rng").expect("merge state carries merge.rng");
    (
        rng.get("k").and_then(Json::as_u64).unwrap_or(0) as u32,
        rng.get("cursor").and_then(Json::as_u64).unwrap_or(32) as u8,
    )
}

fn read_max_tile(merge: &Json) -> i64 {
    merge.get("maxTile").and_then(Json::as_i64).unwrap_or(0)
}

/// Flat board → 4×4 grid the frontend renders (view.board).
fn to_grid_json(board: &[i64; CELLS]) -> Json {
    Json::Array(
        (0..BOARD_SIZE as usize)
            .map(|r| {
                Json::Array(
                    board[r * 4..r * 4 + 4]
                        .iter()
                        .map(|v| (*v).into())
                        .collect(),
                )
            })
            .collect(),
    )
}

fn in_range(row: f64, col: f64) -> bool {
    let ok = |v: f64| v.is_finite() && v.fract() == 0.0 && (0.0..BOARD_SIZE as f64).contains(&v);
    ok(row) && ok(col)
}

/// One merge-state step over the GENERATED applyMergeMove core: reposition
/// (to empty — no spawn) or merge (equal values — one spawn consumed).
/// Returns None when the move is illegal.
#[allow(clippy::too_many_arguments)]
fn step_merge(
    problem_secret: &[u8; 32],
    board: &[i64; CELLS],
    rng: (u32, u8),
    max_tile: i64,
    from: (f64, f64),
    to: (f64, f64),
) -> Option<StepMerge> {
    if !in_range(from.0, from.1) || !in_range(to.0, to.1) {
        return None;
    }
    let (fr, fc) = (from.0 as usize, from.1 as usize);
    let (tr, tc) = (to.0 as usize, to.1 as usize);
    // isOrthogonalAdjacent
    let dr = fr as f64 - tr as f64;
    let dc = fc as f64 - tc as f64;
    if dr.abs() + dc.abs() != 1.0 {
        return None;
    }
    let source = board[fr * 4 + fc];
    if source <= 0 {
        return None; // nothing to move
    }
    let destination = board[tr * 4 + tc];
    let is_merge = if destination == 0 {
        false // reposition
    } else if destination == source {
        true
    } else {
        return None;
    };

    let mut next = *board;
    next[fr * 4 + fc] = 0;
    next[tr * 4 + tc] = if is_merge { source * 2 } else { source };

    if !is_merge {
        return Some(StepMerge {
            board: next,
            rng,
            max_tile,
            spawn: None,
            merged: false,
        });
    }
    let mut stream = CounterStream::resumed(problem_secret, rng.0, rng.1);
    let mut spawn = None;
    let free: Vec<usize> = (0..CELLS).filter(|&i| next[i] == 0).collect();
    if !free.is_empty() {
        let picked = free[(stream.next() as usize) % free.len()];
        let value = if stream.next().is_multiple_of(10) {
            4
        } else {
            2
        };
        next[picked] = value;
        spawn = Some((picked, value));
    }
    Some(StepMerge {
        board: next,
        rng: stream.state(),
        max_tile: max_tile.max(*next.iter().max().unwrap_or(&0)),
        spawn,
        merged: true,
    })
}

struct StepMerge {
    board: [i64; CELLS],
    rng: (u32, u8),
    max_tile: i64,
    spawn: Option<(usize, i64)>,
    merged: bool,
}

fn new_board(problem_secret: &[u8; 32]) -> Json {
    let mut stream = CounterStream::new(problem_secret);
    let mut board = [0i64; CELLS];
    for _ in 0..INITIAL_TILES {
        spawn_into(&mut board, &mut stream);
    }
    let max_tile = board.iter().copied().max().unwrap_or(0);
    serde_json::json!({
        "board": board_json(&board),
        "rng": rng_json(stream.state()),
        "maxTile": max_tile,
    })
}

/// Move read off the accepted log (or the incoming op): from/to coordinates.
type MoveCoords = ((f64, f64), (f64, f64));

fn coords_of(value: &Json) -> MoveCoords {
    let cell = |c: Option<&Json>| -> (f64, f64) {
        match c {
            Some(cell) => (
                super::number_field(cell.get("row")),
                super::number_field(cell.get("col")),
            ),
            None => (f64::NAN, f64::NAN),
        }
    };
    (cell(value.get("from")), cell(value.get("to")))
}

/// Rebuild the live merge state (with the correct rng cursor) from a move log.
fn rebuild_merge_state(problem_secret: &[u8; 32], merges: &[Json]) -> Json {
    let mut merge = new_board(problem_secret);
    for m in merges {
        let (from, to) = coords_of(m);
        let Some(next) = step_merge(
            problem_secret,
            &read_board(&merge),
            read_rng(&merge),
            read_max_tile(&merge),
            from,
            to,
        ) else {
            break;
        };
        merge = serde_json::json!({
            "board": board_json(&next.board),
            "rng": rng_json(next.rng),
            "maxTile": next.max_tile,
        });
    }
    merge
}

/// Full-run replay from the accepted move log. An illegal move returns
/// (ok=false, board-so-far, maxTile-so-far).
fn replay_merge(problem_secret: &[u8; 32], merges: &[Json]) -> (bool, i64) {
    let mut merge = new_board(problem_secret);
    for m in merges {
        let (from, to) = coords_of(m);
        let Some(next) = step_merge(
            problem_secret,
            &read_board(&merge),
            read_rng(&merge),
            read_max_tile(&merge),
            from,
            to,
        ) else {
            return (false, read_max_tile(&merge));
        };
        merge = serde_json::json!({
            "board": board_json(&next.board),
            "rng": rng_json(next.rng),
            "maxTile": next.max_tile,
        });
    }
    (true, read_max_tile(&merge))
}

/// Canonical answer string the enclave hashes for SETTLE.
fn merge_answer(max_tile: i64, merges: &[Json]) -> String {
    let encoded = merges
        .iter()
        .map(|m| {
            let ((fr, fc), (tr, tc)) = coords_of(m);
            format!(
                "{}{}{}{}",
                super::js_num_json(fr),
                super::js_num_json(fc),
                super::js_num_json(tr),
                super::js_num_json(tc)
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    format!("merge:{max_tile}:{encoded}")
}

// ---------------------------------------------------------------------------
// Wrapper ABI
// ---------------------------------------------------------------------------

pub fn deal(problem_secret: &[u8; 32], _difficulty: u8) -> (Json, Json) {
    let merge = new_board(problem_secret);
    let board = merge
        .get("board")
        .cloned()
        .expect("new_board carries board");
    let state = serde_json::json!({
        "problemSecret": super::secret_to_json(problem_secret),
        "merge": merge,
        "merges": [],
    });
    let start_view = serde_json::json!({ "board": to_grid_json_from_flat(&board) });
    (state, start_view)
}

fn to_grid_json_from_flat(flat: &Json) -> Json {
    let cells: Vec<i64> = flat
        .as_array()
        .map(|arr| arr.iter().filter_map(Json::as_i64).collect())
        .unwrap_or_default();
    Json::Array(
        (0..BOARD_SIZE as usize)
            .map(|r| {
                Json::Array(
                    cells[r * 4..r * 4 + 4]
                        .iter()
                        .map(|v| (*v).into())
                        .collect(),
                )
            })
            .collect(),
    )
}

pub fn apply_op(state: &mut Json, op: &Json, _op_meta: &OpMeta) -> OpOutcome {
    let type_name = op_type_of(op);
    if type_name != "move" {
        return OpOutcome::Rejected {
            message: "op.type must be move or undo".into(),
            status: 400,
        };
    }
    // JS: `!from || !to || typeof from !== 'object' || typeof to !== 'object'`
    // — null/absent/scalars reject; arrays count as objects and fall through to
    // NaN coordinates (ok:false), exactly like JS.
    let objecty = |v: Option<&Json>| matches!(v, Some(Json::Object(_)) | Some(Json::Array(_)));
    let (from, to) = (op.get("from"), op.get("to"));
    if !objecty(from) || !objecty(to) {
        return OpOutcome::Rejected {
            message: "op.from and op.to must be {row,col} objects".into(),
            status: 400,
        };
    }
    let (from, to) = (from.expect("checked"), to.expect("checked"));
    let coords = coords_of(&serde_json::json!({ "from": from, "to": to }));
    let (from, to) = coords;

    let secret = super::state_secret(state);
    let merge = state
        .get("merge")
        .cloned()
        .expect("merge state carries merge");
    let Some(next) = step_merge(
        &secret,
        &read_board(&merge),
        read_rng(&merge),
        read_max_tile(&merge),
        from,
        to,
    ) else {
        return OpOutcome::View(serde_json::json!({ "ok": false }));
    };
    let move_json = serde_json::json!({
        "from": { "row": super::js_num_json(from.0), "col": super::js_num_json(from.1) },
        "to": { "row": super::js_num_json(to.0), "col": super::js_num_json(to.1) },
    });
    state["merge"] = serde_json::json!({
        "board": board_json(&next.board),
        "rng": rng_json(next.rng),
        "maxTile": next.max_tile,
    });
    state
        .get_mut("merges")
        .and_then(Json::as_array_mut)
        .expect("merge state carries merges")
        .push(move_json);
    let mut view = serde_json::json!({
        "ok": true,
        "merged": next.merged,
        "view": { "board": to_grid_json(&next.board) },
        "tile": next.max_tile,
    });
    if let Some((cell, value)) = next.spawn {
        view["spawn"] = serde_json::json!({ "cell": cell, "value": value });
    }
    OpOutcome::View(view)
}

pub fn apply_undo(state: &mut Json, _op_meta: &OpMeta) -> OpOutcome {
    let merges_len = state
        .get("merges")
        .and_then(Json::as_array)
        .map_or(0, Vec::len);
    if merges_len == 0 {
        return OpOutcome::Rejected {
            message: "nothing to undo".into(),
            status: 409,
        };
    }
    let (secret, merges) = {
        state
            .get_mut("merges")
            .and_then(Json::as_array_mut)
            .expect("merge state carries merges")
            .pop();
        let secret = super::state_secret(state);
        (
            secret,
            state
                .get("merges")
                .cloned()
                .expect("merge state carries merges"),
        )
    };
    let rebuilt = rebuild_merge_state(&secret, merges.as_array().expect("merges is an array"));
    state["merge"] = rebuilt.clone();
    let board = rebuilt
        .get("board")
        .cloned()
        .expect("rebuilt carries board");
    OpOutcome::View(serde_json::json!({
        "ok": true,
        "view": { "board": to_grid_json_from_flat(&board) },
    }))
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
    let secret = super::state_secret(state);
    let merges: Vec<Json> = state
        .get("merges")
        .and_then(Json::as_array)
        .expect("merge state carries merges")
        .clone();
    let (ok, max_tile) = replay_merge(&secret, &merges);
    if !ok {
        return Err(ScoreRejection::new("invalid merge log"));
    }
    let target = super::abi::resolve_target(&DESCRIPTOR.targets, difficulty, extra);
    if (max_tile as f64) < target {
        return Err(ScoreRejection::new("target tile not reached"));
    }
    Ok(super::abi::ScoreOutcome {
        answer_hash: answer_hash_of(&merge_answer(max_tile, &merges)),
        score: max_tile,
        score_field: Some(serde_json::json!({ "tile_achieved": max_tile })),
    })
}
