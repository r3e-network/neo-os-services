//! Sudoku — port of `game/wrappers/sudoku.wrapper.js` over the deterministic
//! core in `game/engines/sudoku.js` (GENERATED from the minigames TS twin; the
//! mask tables and BASE_GRID below are byte-identical to that core).
//!
//! No correctness feedback by design — the TEE only records placements. The
//! finalize board is DERIVED from the session's own recorded placements
//! (clues + the last accepted digit per open cell, undos already popped), so
//! the sealed op-log fully determines the outcome. `score`'s extra `answer`
//! is accepted only as an optional client assertion: when present it must
//! equal the derived board, it never replaces it (audit: the old contract
//! required an out-of-band answer the sealed payload never carried, so the
//! kernel lane could not settle, and the recorded moves had no bearing on
//! the result).

use serde_json::Value as Json;

use super::abi::{answer_hash_of, OpMeta, OpOutcome, ScoreExtra, ScoreRejection};
use super::{js_num_json, number_field, op_type_of};

pub const APP_ID: &str = "miniapp-sudoku";

pub const DESCRIPTOR: super::registry::EngineDescriptor = super::registry::EngineDescriptor {
    op_schema: "place: {type:'place', cell:0..80, digit:1..9} | undo",
    targets: [0, 0, 0], // solved/not — the answer check is exact, no numeric target
    time_window: super::registry::TimeWindow {
        limit_ms: [900_000.0, 1_500_000.0, 2_400_000.0],
        min_solve_ms: [90_000.0, 150_000.0, 240_000.0],
    },
    gates: super::abi::DEFAULT_GATES,
    reveal_policy: super::abi::RevealPolicy::Clues,
    max_ops: 20_000,
    max_undos: 3,
    undo_penalty_pct: 30,
    log_deterministic: true,
    start_config_key: None, // no numeric target surfaced at start
};

pub static ENGINE: super::registry::EngineHandle = super::registry::EngineHandle {
    app_id: APP_ID,
    engine_hash: "8d9ed338a95211be2cf2b92e09fe9e6b4cf8085295eb272359fe8dac8a5bb8a6",
    descriptor: DESCRIPTOR,
    deal,
    apply_op,
    apply_undo,
    replay,
    score,
};

const BASE_GRID: &str =
    "534678912672195348198342567859761423426853791713924856961537284287419635345286179";

const EASY_MASKS: [&str; 20] = [
    "110011001101010010011101000001110010001111100010011100000101110010010111100110011",
    "101010101001100010101111100100011100011000110001110001001111101010001100101010101",
    "100001000000111100101101100111011110011000110011110111001101101001111000000100001",
    "101000010111101010000110011011101100110000011001101110110011000010101111010000101",
    "010101111101100100100010100001010110011101110011010100001010001001001101111101010",
    "100101101001011111101100101000010101010000010101010000101001101111110100101101001",
    "110110010110000001010011001101101011001111100110101101100100010100000011010011011",
    "100001110010011110011000110000110111100111001111011000011000110011110010010100001",
    "010111001001101010111100011100011000101000101000110001110001111010101100100111010",
    "011110101011100010000111100101110000101000101000011101001111000010001110101011110",
    "010000101010000101100001011101011010111111111010110101110100001101010010101000010",
    "010001010011010110100100011100011101010111010101110001110001001011010110010100110",
    "111110000100010001011110011010100010011111110010001010110011110100010001000001111",
    "110101100000100110001101001011011010111010111010110110100101100011000000001101011",
    "011001100100011010111010111000111100010010010000111000111010111010110001001100110",
    "101101001011010110100001101010001001110101011100100010101100001011010110100101101",
    "111100100110111110010001000100101001101010101100101001000100010011111011000001111",
    "111110010100110110011010110001010001001000100100010100011010110011011001010011111",
    "111011011100000010011100000001111010111010111010111000000001110010000001110110111",
    "100010111011111001110011000010000110100101001011000010000110011100111110111010001",
];
const MEDIUM_MASKS: [&str; 20] = [
    "000100101011001000011110010001010100001101100001010100010011110000100110101001000",
    "011001110000000010110010111000110010100000001010011000111010011010000000011100110",
    "001101100101000110010101000100011010000010000010110101000101010011000101001101100",
    "001011110001100101001001010010000011100010001110000010010100100100001100011110100",
    "000110111001100000101000011100100000011011110000001001110000101000001100111011000",
    "010101100100011001001000000011010010001111100010010111000000100100110001001101010",
    "011100001101100010010010011001000010010111010010000100100010010010001101100001110",
    "000000010010011101010011100010011101001010100101110000001110010101110010010000000",
    "110000100011011001001011011000010001100000001100010000110110100100110110001000011",
    "001100010100000101001110100110011000110000011000110011001011100101000001010001100",
    "000010101000111000010000011011101010001101100010101110110000010000111000101010000",
    "110010000100001100100001101000111110000010000011111000101100001001101001000010011",
    "100000011010000000011011011011110100000111000000011110110110110000000010110000001",
    "011000101010100000100000011110011001100101001100110011110000001000001010101000110",
    "110000010011000001000111101010100010100111000010001010101111000100000110010000011",
    "001101110010000100100110101010001010001000100010100010101011001001000010011101100",
    "000101001010001100010100000001101100101111101001101101000001010001100010100101000",
    "100000110001000010000101000101011111100101001111110101000101000010000100011000001",
    "110101000000011001100000010011101101000111000101101100010000001100110000000101011",
    "111000000001111100010100100000010101011000110101010000001001010001111100000000111",
];
const HARD_MASKS: [&str; 20] = [
    "011000010101100001001100000100010001000010000110010001000001100100001101010000110",
    "101001000010000000110011000010101100001000100001101010000110011000000010000100101",
    "000001110001101010010000100100010001000010010100010001001000010010101100011100000",
    "100110000001011000010001001010000110101000101011000010100100010000110100000011001",
    "011100101100000010010100100001100000010101010000001100001001010010000001101001110",
    "000011011000101001010000000100100001001010100100001001000000010100111000110110000",
    "000010010100101010001010010000001100110101011001100000010010100010101001010010000",
    "011000000000001001001001011001010011000101000110010100110100100100100000000000110",
    "101010000000001101000000110001100001010101010100001100011000000101100000000010101",
    "001011100000000000101001010110001001100010001100100011010100101000000000001110000",
    "000010010111001001000101000001010000011101110000010100000101000100100111010010000",
    "000101100010001010001000000011010100101000101001010110000000100010100010001101000",
    "101001000010100000100010110010100110100000001011001010011010001000001010000100101",
    "000000100000001010110101101000011100011000110001110000101101011010100000001000000",
    "110100001110000001001100100100011100000000000001110001001001100100000011100001011",
    "001011100000001101000010010100100010100101001010001001010010000101100000001110100",
    "010110000001000101101000001000100010100010001010001010100000101101000100000011010",
    "001101000010101011001010000010010001001000100100010010000010100110101010000101100",
    "000001010110001001000000101000010101010010010101010000101000000100110011010100000",
    "000000110111100010001100010000100010100101001010001000010001100010001111011000000",
];

fn masks_for(difficulty: u8) -> &'static [&'static str; 20] {
    // DIFFICULTY_KEYS[difficulty] ?? "easy"
    match difficulty {
        1 => &MEDIUM_MASKS,
        2 => &HARD_MASKS,
        _ => &EASY_MASKS,
    }
}

/// The cyclic byte stream over the seed (`streamOf`).
struct SudokuStream {
    seed: [u8; 32],
    cursor: usize,
}

impl SudokuStream {
    fn next(&mut self) -> u8 {
        let byte = self.seed[self.cursor % 32];
        self.cursor += 1;
        byte
    }
}

fn fisher_yates(stream: &mut SudokuStream, values: &[u8]) -> Vec<u8> {
    let mut arr = values.to_vec();
    let mut i = arr.len() as i64 - 1;
    while i >= 1 {
        let j = (stream.next() as usize) % (i as usize + 1);
        arr.swap(i as usize, j);
        i -= 1;
    }
    arr
}

struct Transform {
    digit_perm: Vec<u8>,
    row_index: [usize; 9],
    col_index: [usize; 9],
    transpose: bool,
    mask_draw: u8,
}

fn derive_transform(seed: &[u8; 32]) -> Transform {
    let mut stream = SudokuStream {
        seed: *seed,
        cursor: 0,
    };
    let digit_perm = fisher_yates(&mut stream, &[1, 2, 3, 4, 5, 6, 7, 8, 9]);
    let band_perm = fisher_yates(&mut stream, &[0, 1, 2]);
    let row_perm = [
        fisher_yates(&mut stream, &[0, 1, 2]),
        fisher_yates(&mut stream, &[0, 1, 2]),
        fisher_yates(&mut stream, &[0, 1, 2]),
    ];
    let stack_perm = fisher_yates(&mut stream, &[0, 1, 2]);
    let col_perm = [
        fisher_yates(&mut stream, &[0, 1, 2]),
        fisher_yates(&mut stream, &[0, 1, 2]),
        fisher_yates(&mut stream, &[0, 1, 2]),
    ];
    let transpose = stream.next() % 2 == 1;
    let mask_draw = stream.next();
    let mut row_index = [0usize; 9];
    let mut col_index = [0usize; 9];
    for r in 0..9usize {
        row_index[r] = (band_perm[r / 3] as usize) * 3 + row_perm[r / 3][r % 3] as usize;
    }
    for c in 0..9usize {
        col_index[c] = (stack_perm[c / 3] as usize) * 3 + col_perm[c / 3][c % 3] as usize;
    }
    Transform {
        digit_perm,
        row_index,
        col_index,
        transpose,
        mask_draw,
    }
}

fn source_cell(t: &Transform, r: usize, c: usize) -> usize {
    let sr = if t.transpose {
        t.row_index[c]
    } else {
        t.row_index[r]
    };
    let sc = if t.transpose {
        t.col_index[r]
    } else {
        t.col_index[c]
    };
    sr * 9 + sc
}

pub struct DealtPuzzle {
    pub solution: String,
    pub puzzle: String,
}

pub fn deal_puzzle(seed: &[u8; 32], difficulty: u8) -> DealtPuzzle {
    let t = derive_transform(seed);
    let masks = masks_for(difficulty);
    let mask_index = t.mask_draw as usize % masks.len();
    let mask = masks[mask_index];
    let mut solution = String::with_capacity(81);
    let mut puzzle = String::with_capacity(81);
    for r in 0..9usize {
        for c in 0..9usize {
            let src = source_cell(&t, r, c);
            let digit = BASE_GRID.as_bytes()[src] - b'0';
            solution.push((b'0' + t.digit_perm[(digit - 1) as usize]) as char);
            if mask.as_bytes()[src] == b'1' {
                puzzle.push((b'0' + t.digit_perm[(digit - 1) as usize]) as char);
            } else {
                puzzle.push('0');
            }
        }
    }
    DealtPuzzle { solution, puzzle }
}

// ---------------------------------------------------------------------------
// Wrapper ABI
// ---------------------------------------------------------------------------

pub fn deal(problem_secret: &[u8; 32], difficulty: u8) -> (Json, Json) {
    let dealt = deal_puzzle(problem_secret, difficulty);
    let state = serde_json::json!({
        "puzzle": dealt.puzzle,
        "solution": dealt.solution,
        "placements": [],
    });
    let start_view = serde_json::json!({ "clues": dealt.puzzle });
    (state, start_view)
}

pub fn apply_op(state: &mut Json, op: &Json, _op_meta: &OpMeta) -> OpOutcome {
    let type_name = op_type_of(op);
    if type_name != "place" {
        return OpOutcome::Rejected {
            message: "op.type must be place or undo".into(),
            status: 400,
        };
    }
    let cell = number_field(op.get("cell"));
    let digit = number_field(op.get("digit"));
    if !cell.is_finite() || cell.fract() != 0.0 || !(0.0..=80.0).contains(&cell) {
        return OpOutcome::Rejected {
            message: "op.cell must be an integer 0..80".into(),
            status: 400,
        };
    }
    if !digit.is_finite() || digit.fract() != 0.0 || !(1.0..=9.0).contains(&digit) {
        return OpOutcome::Rejected {
            message: "op.digit must be an integer 1..9".into(),
            status: 400,
        };
    }
    let cell_index = cell as usize;
    let puzzle = state
        .get("puzzle")
        .and_then(Json::as_str)
        .expect("sudoku state carries the puzzle string");
    let puzzle_bytes = puzzle.as_bytes();
    // JS charAt on an out-of-range index returns '' — never equal to '0', so
    // the guard above (0..80) is what actually bounds the access.
    if puzzle_bytes.get(cell_index).copied().unwrap_or(b' ') != b'0' {
        return OpOutcome::Rejected {
            message: "cannot place on a clue cell".into(),
            status: 400,
        };
    }
    let placements = state
        .get_mut("placements")
        .and_then(Json::as_array_mut)
        .expect("sudoku state carries placements");
    placements.push(serde_json::json!({
        "cell": js_num_json(cell),
        "digit": js_num_json(digit),
    }));
    OpOutcome::View(serde_json::json!({ "ok": true }))
}

pub fn apply_undo(state: &mut Json, _op_meta: &OpMeta) -> OpOutcome {
    let placements = state
        .get_mut("placements")
        .and_then(Json::as_array_mut)
        .expect("sudoku state carries placements");
    if placements.is_empty() {
        return OpOutcome::Rejected {
            message: "nothing to undo".into(),
            status: 409,
        };
    }
    placements.pop();
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
        if outcome.is_rejected() || outcome.view_ok_false() {
            return Err(format!("invalid replay op at index {i}"));
        }
    }
    Ok(state)
}

/// The board the recorded placements produce: clues stay fixed, each open
/// cell takes its LAST accepted placement (undos have already been popped
/// from `placements`), untouched open cells stay `0`.
pub fn derived_board(state: &Json) -> String {
    let puzzle = state
        .get("puzzle")
        .and_then(Json::as_str)
        .expect("sudoku state carries the puzzle string");
    let mut board: Vec<u8> = puzzle.as_bytes().to_vec();
    board.resize(81, b'0');
    if let Some(placements) = state.get("placements").and_then(Json::as_array) {
        for placement in placements {
            let cell = number_field(placement.get("cell"));
            let digit = number_field(placement.get("digit"));
            if !(0.0..=80.0).contains(&cell) || !(1.0..=9.0).contains(&digit) {
                continue;
            }
            board[cell as usize] = b'0' + digit as u8;
        }
    }
    String::from_utf8(board).expect("digits are ASCII")
}

pub fn score(
    state: &Json,
    _difficulty: u8,
    extra: &ScoreExtra,
) -> Result<super::abi::ScoreOutcome, ScoreRejection> {
    let derived = derived_board(state);
    let solution = state
        .get("solution")
        .and_then(Json::as_str)
        .expect("sudoku state carries the solution");
    // The authenticated op-log is authoritative. An optional client answer
    // can only assert the replayed board and can never decide settlement.
    if let Some(Json::String(answer)) = &extra.answer {
        if answer.trim() != derived {
            return Err(ScoreRejection::new("answer does not match the recorded placements"));
        }
    }
    if derived != solution {
        return Err(ScoreRejection::new("incorrect solution"));
    }
    Ok(super::abi::ScoreOutcome {
        answer_hash: answer_hash_of(&derived),
        score: 1,
        score_field: None,
    })
}
