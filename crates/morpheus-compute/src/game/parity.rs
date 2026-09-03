//! Engine parity — the Rust side of `engine-parity.test.mjs`. Drives every
//! registered engine through the recorded ops of the frozen goldens
//! (`engine-parity.goldens.json`) and asserts the per-op view/state hashes,
//! the replay hash and the canonical score outcome byte-for-byte.
//!
//! The goldens are self-contained (each vector records its ops), so the Rust
//! driver replays the RECORDED ops rather than re-deriving the scripted
//! plans — the single plan-derived input is sudoku's `full solve` finalize
//! answer (`state.solution`, name-sniffed), which travels in `score`'s extra
//! arg and is never part of the op log.
//!
//! Driver semantics mirror `parity-vectors.mjs` exactly: fixed enclave clock
//! origin [`STARTED_AT_MS`], per-op `elapsedMs = (i + 1) * spacingMs` (the
//! vector's `spacingMs`, default 2000), accepted-but-null ops (`view.ok ===
//! false`) excluded from the replay log, `hashOf = sha256(JSON.stringify(
//! canonicalize(value)))` with sorted keys and `{$bytes}` secrets.

use serde_json::Value as Json;

use super::abi::{OpMeta, OpOutcome, ScoreExtra};
use super::registry::{resolve_engine, EngineHandle};
use super::{op_type_of, sha256_hex};

const GOLDENS: &str = include_str!("engine-parity.goldens.json");
const STARTED_AT_MS: f64 = 1_770_000_000_000.0;

/// parity-vectors.mjs `secretOf`: HMAC-SHA256 over the label, keyed with 32
/// bytes of 0x07.
fn secret_of(label: &str) -> [u8; 32] {
    use hmac::{Hmac, Mac};
    let mut mac = Hmac::<sha2::Sha256>::new_from_slice(&[7u8; 32]).expect("hmac accepts any key");
    mac.update(label.as_bytes());
    mac.finalize().into_bytes().into()
}

/// Order-independent canonical form: object keys sorted recursively. Engine
/// state already carries the `{"$bytes":[..]}` secret form, so the Uint8Array
/// branch of the JS canonicalize has no Rust counterpart.
fn canonicalize(value: &Json) -> Json {
    match value {
        Json::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let mut out = serde_json::Map::new();
            for key in keys {
                out.insert(key.clone(), canonicalize(&map[key]));
            }
            Json::Object(out)
        }
        Json::Array(items) => Json::Array(items.iter().map(canonicalize).collect()),
        other => other.clone(),
    }
}

fn hash_of(value: &Json) -> String {
    sha256_hex(
        serde_json::to_string(&canonicalize(value))
            .expect("canonical JSON")
            .as_bytes(),
    )
}

fn assert_hash(actual: &Json, expected: Option<&Json>, label: &str) {
    let expected_hex = expected
        .and_then(Json::as_str)
        .unwrap_or_else(|| panic!("{label}: golden carries no hash"));
    assert_eq!(
        hash_of(actual),
        expected_hex,
        "{label}: hash mismatch — actual {actual:#}"
    );
}

fn run_vector(engine: &'static EngineHandle, vector: &Json) {
    let name = vector.get("name").and_then(Json::as_str).unwrap_or("");
    let context = format!("{} / {name}", engine.app_id);
    let seed = vector.get("seed").and_then(Json::as_str).unwrap_or("");
    let difficulty = vector.get("difficulty").and_then(Json::as_u64).unwrap_or(0) as u8;
    let spacing_ms = vector
        .get("spacingMs")
        .and_then(Json::as_f64)
        .unwrap_or(2000.0);
    let ops: Vec<Json> = vector
        .get("ops")
        .and_then(Json::as_array)
        .unwrap_or_else(|| panic!("{context}: golden carries no recorded ops"))
        .clone();
    let expected = vector.get("outcome").expect("golden outcome");
    let problem_secret = secret_of(seed);

    let (mut state, start_view) = (engine.deal)(&problem_secret, difficulty);
    // sudoku's `full solve` finalize answer travels in score()'s extra arg.
    let solution = state
        .get("solution")
        .and_then(Json::as_str)
        .map(String::from);
    assert_hash(
        &start_view,
        expected.get("startViewHash"),
        &format!("{context}: startView"),
    );

    let mut applied_ops: Vec<Json> = Vec::new();
    let op_goldens = expected
        .get("ops")
        .and_then(Json::as_array)
        .expect("op outcomes");
    assert_eq!(
        op_goldens.len(),
        ops.len(),
        "{context}: golden op count diverges from the recorded log"
    );
    for (i, op) in ops.iter().enumerate() {
        let elapsed_ms = (i as f64 + 1.0) * spacing_ms;
        let op_meta = OpMeta {
            problem_secret,
            difficulty,
            now_ms: Some(STARTED_AT_MS + elapsed_ms),
            started_at_ms: Some(STARTED_AT_MS),
            elapsed_ms: Some(elapsed_ms),
            resumed: false,
            op_index: i,
        };
        let op_context = format!("{context}: op {i}");
        let outcome = if op_type_of(op) == "undo" {
            (engine.apply_undo)(&mut state, &op_meta)
        } else {
            (engine.apply_op)(&mut state, op, &op_meta)
        };
        let expected_op = &op_goldens[i];
        // The recorder always writes `rejected` — null for accepted ops.
        let expected_rejection = expected_op.get("rejected").filter(|r| !r.is_null());

        match (&outcome, expected_rejection) {
            (OpOutcome::Rejected { message, status }, Some(rejection)) => {
                assert_eq!(
                    message,
                    rejection
                        .get("message")
                        .and_then(Json::as_str)
                        .unwrap_or(""),
                    "{op_context}: reject message"
                );
                assert_eq!(
                    *status as i64,
                    rejection.get("status").and_then(Json::as_i64).unwrap_or(-1),
                    "{op_context}: reject status"
                );
            }
            (OpOutcome::Rejected { message, status }, None) => {
                panic!("{op_context}: unexpected rejection {status} '{message}'")
            }
            (OpOutcome::View(_), Some(rejection)) => {
                panic!("{op_context}: golden expects rejection {rejection} but the op was accepted")
            }
            (OpOutcome::View(_), None) => {}
        }

        let expected_view_hash = expected_op.get("viewHash").and_then(Json::as_str);
        match &outcome {
            OpOutcome::View(view) => {
                let view_hash = expected_view_hash
                    .unwrap_or_else(|| panic!("{op_context}: golden expects no view"));
                assert_eq!(hash_of(view), view_hash, "{op_context}: view hash");
                // Accepted-but-null ops never reach the finalize log.
                if view.get("ok").and_then(Json::as_bool) != Some(false) {
                    applied_ops.push(op.clone());
                }
            }
            OpOutcome::Rejected { .. } => {
                assert!(
                    expected_view_hash.is_none(),
                    "{op_context}: rejected op cannot carry a view hash"
                );
            }
        }
        assert_hash(
            &state,
            expected_op.get("stateHash"),
            &format!("{op_context}: state"),
        );
    }

    // The JS driver hashes `dealtState` after the op loop — the wrappers mutate
    // the state in place, so the golden's "initialStateHash" is really the
    // final state's hash, identical to `liveStateHash` in every golden.
    assert_hash(
        &state,
        expected.get("initialStateHash"),
        &format!("{context}: initialState (post-run alias)"),
    );
    assert_hash(
        &state,
        expected.get("liveStateHash"),
        &format!("{context}: live state"),
    );

    let replay_expected = expected.get("replay").expect("replay outcome");
    match (engine.replay)(&problem_secret, &applied_ops, difficulty) {
        Ok(replay_state) => {
            let expected_hash = replay_expected
                .get("stateHash")
                .and_then(Json::as_str)
                .unwrap_or_else(|| panic!("{context}: golden replay throws but ours succeeded"));
            assert_eq!(
                hash_of(&replay_state),
                expected_hash,
                "{context}: replay state hash"
            );
        }
        Err(message) => {
            let expected_threw = replay_expected
                .get("threw")
                .and_then(Json::as_str)
                .unwrap_or_else(|| {
                    panic!("{context}: replay threw '{message}' but golden expects success")
                });
            assert_eq!(&message, expected_threw, "{context}: replay error message");
        }
    }

    let total_elapsed_ms = ops.len() as f64 * spacing_ms;
    let wants_answer = engine.app_id == "miniapp-sudoku" && name == "full solve";
    let score_extra = ScoreExtra {
        answer: if wants_answer {
            solution.map(Json::String)
        } else {
            None
        },
        elapsed_ms: Some(total_elapsed_ms),
        started_at_ms: Some(STARTED_AT_MS),
        now_ms: Some(STARTED_AT_MS + total_elapsed_ms),
        target_override: None,
    };
    let score_expected = expected.get("score").expect("score outcome");
    match (engine.score)(&state, difficulty, &score_extra) {
        Ok(outcome) => {
            let expected_result = score_expected
                .get("result")
                .unwrap_or_else(|| panic!("{context}: golden score rejects but ours succeeded"));
            // The recorder freezes wrapper.score()'s return raw: answerHash is a
            // Uint8Array (canonicalized to {$bytes}), and scoreField is absent
            // when the wrapper doesn't return one.
            let mut built = serde_json::Map::new();
            built.insert(
                "answerHash".into(),
                serde_json::json!({ "$bytes": outcome.answer_hash.to_vec() }),
            );
            built.insert("score".into(), Json::from(outcome.score));
            if let Some(field) = outcome.score_field.clone() {
                built.insert("scoreField".into(), field);
            }
            let built = Json::Object(built);
            assert_eq!(
                canonicalize(&built),
                *expected_result,
                "{context}: canonical score outcome"
            );
        }
        Err(rejection) => {
            let expected_message = score_expected
                .get("rejected")
                .and_then(Json::as_str)
                .unwrap_or_else(|| {
                    panic!("{context}: score rejected '{rejection}' but golden expects a result")
                });
            assert_eq!(
                &rejection.message, expected_message,
                "{context}: score rejection message"
            );
            let expected_status = score_expected.get("status");
            assert_eq!(
                Some(rejection.status as i64),
                expected_status.and_then(Json::as_i64),
                "{context}: score rejection status"
            );
        }
    }
}

#[test]
fn engines_reproduce_parity_goldens() {
    let goldens: Json = serde_json::from_str(GOLDENS).expect("engine-parity.goldens.json parses");
    let engines = goldens
        .get("engines")
        .and_then(Json::as_object)
        .expect("goldens.engines");
    for (app_id, wrapper_goldens) in engines {
        let engine = resolve_engine(app_id).unwrap_or_else(|error| panic!("{error}"));
        let vectors = wrapper_goldens
            .get("vectors")
            .and_then(Json::as_array)
            .expect("engine vectors");
        assert!(!vectors.is_empty(), "{app_id}: golden carries no vectors");
        for vector in vectors {
            run_vector(engine, vector);
        }
    }
}

/// registry.test.mjs drift guard: every registered engine's pinned hash still
/// matches the live JS wrapper source (CRLF normalized), so a wrapper edit that
/// has not been ported flips this test before anything else can trust it.
#[test]
fn wrapper_sources_match_pinned_engine_hashes() {
    const WRAPPER_FILES: [(&str, &str); 11] = [
        ("miniapp-sudoku", "sudoku.wrapper.js"),
        ("miniapp-game-2048", "game2048.wrapper.js"),
        ("miniapp-flappy-dash", "flappy.wrapper.js"),
        ("miniapp-snake-bounty", "snake.wrapper.js"),
        ("miniapp-aim-master", "aim.wrapper.js"),
        ("miniapp-color-clash", "color.wrapper.js"),
        ("miniapp-merge-kingdom", "merge.wrapper.js"),
        ("miniapp-pet-potion", "pet.wrapper.js"),
        ("miniapp-sheep-solitaire", "sheep.wrapper.js"),
        ("miniapp-jump-rush", "jump.wrapper.js"),
        ("miniapp-curve-arrow", "arrow.wrapper.js"),
    ];
    let wrapper_dir = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../workers/nitro-worker/src/game/wrappers/"
    );
    for (app_id, file) in WRAPPER_FILES {
        let engine = resolve_engine(app_id).unwrap_or_else(|error| panic!("{error}"));
        let source = std::fs::read_to_string(format!("{wrapper_dir}{file}"))
            .unwrap_or_else(|error| panic!("reading {file}: {error}"));
        assert_eq!(
            super::registry::engine_hash_of_source(&source),
            engine.engine_hash,
            "{app_id}: {file} drifted from the pinned engine hash — port the change and re-pin"
        );
    }
}
