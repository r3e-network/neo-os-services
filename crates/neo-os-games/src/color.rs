//! Color Clash — port of `game/wrappers/color.wrapper.js` over the
//! deterministic core in `engines/color.js`. Reveal-per-round: the start view's
//! sequence is EMPTY; colours are revealed one per completed round via the
//! per-op view.

use serde_json::Value as Json;

use super::abi::{answer_hash_of, OpMeta, OpOutcome, ScoreExtra, ScoreRejection};
use super::{js_num_json, number_field, op_type_of, CounterStream};

pub const APP_ID: &str = "miniapp-color-clash";

pub const DESCRIPTOR: super::registry::EngineDescriptor = super::registry::EngineDescriptor {
    op_schema: "press: {type:'press', color:0..3} | undo",
    targets: [8, 12, 16], // longest completed round
    time_window: super::registry::TimeWindow {
        limit_ms: [120_000.0, 180_000.0, 300_000.0],
        min_solve_ms: [15_000.0, 30_000.0, 45_000.0],
    },
    gates: super::abi::DEFAULT_GATES,
    reveal_policy: super::abi::RevealPolicy::PerRound,
    max_ops: 20_000,
    max_undos: 3,
    undo_penalty_pct: 30,
    log_deterministic: true,
    start_config_key: Some("target_seq"),
};

pub static ENGINE: super::registry::EngineHandle = super::registry::EngineHandle {
    app_id: APP_ID,
    engine_hash: "074ec7a8437bb8dbdb7c5aca5ccdad1c970e07f1cdbf06358b89638d90539013",
    descriptor: DESCRIPTOR,
    deal,
    apply_op,
    apply_undo,
    replay,
    score,
};

const SEQUENCE_LEN: usize = 24;

// ---------------------------------------------------------------------------
// Generated core
// ---------------------------------------------------------------------------

/// 24 colours drawn off the counter-mode SHA-256 stream, as digit chars.
fn color_sequence(problem_secret: &[u8; 32]) -> String {
    let mut stream = CounterStream::new(problem_secret);
    let mut output = String::with_capacity(SEQUENCE_LEN);
    for _ in 0..SEQUENCE_LEN {
        output.push((b'0' + (stream.next() & 3)) as char);
    }
    output
}

#[derive(Clone, Debug, PartialEq)]
struct ColorState {
    revealed: i64,
    round: i64,
    press_index: usize,
    best: i64,
    over: bool,
}

fn new_color_state() -> ColorState {
    ColorState {
        revealed: 1,
        round: 1,
        press_index: 0,
        best: 0,
        over: false,
    }
}

struct PressResult {
    ok: bool,
    wrong: bool,
    round_complete: bool,
    reveal: Option<i64>,
    round: Option<i64>,
    best: i64,
}

fn color_at(sequence: &str, index: usize) -> Option<i64> {
    sequence.as_bytes().get(index).map(|&b| (b - b'0') as i64)
}

/// charCodeAt past the string end is NaN in JS — never equal to a colour, so
/// the press is wrong and the run is over. `color_at` returning None models it.
fn press_color(sequence: &str, state: &mut ColorState, color: i64) -> PressResult {
    if state.over {
        return PressResult {
            ok: false,
            wrong: false,
            round_complete: false,
            reveal: None,
            round: None,
            best: state.best,
        };
    }
    let matches = color_at(sequence, state.press_index).is_some_and(|expected| expected == color);
    if !matches {
        state.over = true;
        return PressResult {
            ok: false,
            wrong: true,
            round_complete: false,
            reveal: None,
            round: None,
            best: state.best,
        };
    }
    state.press_index += 1;
    if state.press_index as i64 >= state.round {
        state.best = state.round;
        let next_round = state.round + 1;
        let mut result = PressResult {
            ok: true,
            wrong: false,
            round_complete: true,
            reveal: None,
            round: None,
            best: state.best,
        };
        if next_round as usize <= sequence.len() {
            state.revealed = next_round;
            result.reveal = color_at(sequence, next_round as usize - 1);
            result.round = Some(next_round);
            state.round = next_round;
            state.press_index = 0;
        } else {
            state.round = next_round;
            state.press_index = 0;
            result.round = Some(next_round);
        }
        return result;
    }
    PressResult {
        ok: true,
        wrong: false,
        round_complete: false,
        reveal: None,
        round: None,
        best: state.best,
    }
}

fn replay_color(problem_secret: &[u8; 32], presses: &[i64]) -> (i64, bool) {
    let sequence = color_sequence(problem_secret);
    let mut state = new_color_state();
    for &color in presses {
        if state.over {
            break;
        }
        press_color(&sequence, &mut state, color);
    }
    (state.best, state.over)
}

fn color_answer(best: i64, presses: &[i64]) -> String {
    let joined = presses.iter().map(|c| c.to_string()).collect::<String>();
    format!("color:{best}:{joined}")
}

fn color_state_json(state: &ColorState) -> Json {
    serde_json::json!({
        "revealed": state.revealed,
        "round": state.round,
        "pressIndex": state.press_index,
        "best": state.best,
        "over": state.over,
    })
}

fn color_state_of(value: &Json) -> ColorState {
    ColorState {
        revealed: value.get("revealed").and_then(Json::as_i64).unwrap_or(1),
        round: value.get("round").and_then(Json::as_i64).unwrap_or(1),
        press_index: value.get("pressIndex").and_then(Json::as_u64).unwrap_or(0) as usize,
        best: value.get("best").and_then(Json::as_i64).unwrap_or(0),
        over: value.get("over").and_then(Json::as_bool).unwrap_or(false),
    }
}

// ---------------------------------------------------------------------------
// Wrapper ABI
// ---------------------------------------------------------------------------

pub fn deal(problem_secret: &[u8; 32], _difficulty: u8) -> (Json, Json) {
    let state = serde_json::json!({
        "problemSecret": super::secret_to_json(problem_secret),
        "sequence": color_sequence(problem_secret),
        "color": color_state_json(&new_color_state()),
        "presses": [],
    });
    // Reveal-per-round: the future sequence is NEVER handed over at start.
    let start_view = serde_json::json!({ "sequence": "" });
    (state, start_view)
}

pub fn apply_op(state: &mut Json, op: &Json, _op_meta: &OpMeta) -> OpOutcome {
    let type_name = op_type_of(op);
    if type_name != "press" {
        return OpOutcome::Rejected {
            message: "op.type must be press or undo".into(),
            status: 400,
        };
    }
    let color = number_field(op.get("color"));
    if !color.is_finite() || color.fract() != 0.0 || !(0.0..=3.0).contains(&color) {
        return OpOutcome::Rejected {
            message: "op.color must be an integer 0..3".into(),
            status: 400,
        };
    }
    let color = color as i64;
    let sequence = state
        .get("sequence")
        .and_then(Json::as_str)
        .expect("color state carries sequence")
        .to_string();
    let mut color_state = color_state_of(state.get("color").expect("color state carries color"));
    let result = press_color(&sequence, &mut color_state, color);
    let best = result.best;
    let round_view = result.round;
    let wrong = result.wrong;
    let round_complete = result.round_complete;
    let reveal = result.reveal;
    state["color"] = color_state_json(&color_state);
    state
        .get_mut("presses")
        .and_then(Json::as_array_mut)
        .expect("color state carries presses")
        .push(js_num_json(color as f64));
    let mut view = serde_json::json!({
        "ok": true,
        "correct": result.ok,
        "best": best,
        "round": color_state.round,
    });
    if wrong {
        view["wrong"] = Json::Bool(true);
    }
    if round_complete {
        view["round_complete"] = Json::Bool(true);
    }
    // Reveal ONLY the newly revealed colour (never the full future sequence).
    if let Some(reveal) = reveal {
        view["reveal"] = super::js_num_json(reveal as f64);
        view["round"] = super::js_num_json(round_view.expect("reveal carries round") as f64);
    }
    OpOutcome::View(view)
}

pub fn apply_undo(state: &mut Json, _op_meta: &OpMeta) -> OpOutcome {
    let presses_len = state
        .get("presses")
        .and_then(Json::as_array)
        .map_or(0, Vec::len);
    if presses_len == 0 {
        return OpOutcome::Rejected {
            message: "nothing to undo".into(),
            status: 409,
        };
    }
    let (sequence, presses) = {
        state
            .get_mut("presses")
            .and_then(Json::as_array_mut)
            .expect("color state carries presses")
            .pop();
        (
            state
                .get("sequence")
                .and_then(Json::as_str)
                .expect("color state carries sequence")
                .to_string(),
            state
                .get("presses")
                .and_then(Json::as_array)
                .expect("color state carries presses")
                .iter()
                .filter_map(|c| c.as_i64())
                .collect::<Vec<_>>(),
        )
    };
    // Rebuild the reveal state from the trimmed press log.
    let mut rebuilt = new_color_state();
    for &c in &presses {
        if rebuilt.over {
            break;
        }
        press_color(&sequence, &mut rebuilt, c);
    }
    let view = serde_json::json!({
        "ok": true,
        "round": rebuilt.round,
        "revealed": rebuilt.revealed,
    });
    state["color"] = color_state_json(&rebuilt);
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
    let presses: Vec<i64> = state
        .get("presses")
        .and_then(Json::as_array)
        .expect("color state carries presses")
        .iter()
        .filter_map(|c| c.as_i64())
        .collect();
    let (best, _) = replay_color(&secret, &presses);
    let target = super::abi::resolve_target(&DESCRIPTOR.targets, difficulty, extra);
    if (best as f64) < target {
        return Err(ScoreRejection::new("sequence target not reached"));
    }
    Ok(super::abi::ScoreOutcome {
        answer_hash: answer_hash_of(&color_answer(best, &presses)),
        score: best,
        score_field: Some(serde_json::json!({ "seq_achieved": best })),
    })
}
