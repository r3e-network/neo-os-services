//! Pet Potion — port of `game/wrappers/pet.wrapper.js` over the deterministic
//! core in `engines/pet.js`. Deterministic care deltas with a real-time
//! per-action spacing gate: care actions closer than MIN_ACTION_GAP_MS apart
//! (enclave clock) are rejected with 429. Resumed (replay) sessions are exempt
//! at op time — the finalize behavioural gate still applies.

use serde_json::Value as Json;

use super::abi::{answer_hash_of, OpMeta, OpOutcome, ScoreExtra, ScoreRejection};
use super::{js_math_round, js_num_json, op_type_of};

pub const APP_ID: &str = "miniapp-pet-potion";

pub const DESCRIPTOR: super::registry::EngineDescriptor = super::registry::EngineDescriptor {
    op_schema: "care: {type:'feed'|'play'|'pet'|'rest'} | undo",
    targets: [50, 70, 100], // peak happiness
    time_window: super::registry::TimeWindow {
        limit_ms: [180_000.0, 300_000.0, 600_000.0],
        min_solve_ms: [30_000.0, 60_000.0, 120_000.0],
    },
    gates: super::abi::Gates {
        min_median_interval_ms: 120.0,
        max_burst_ops_per_sec: 12.0,
        min_action_gap_ms: Some(1500.0),
    },
    reveal_policy: super::abi::RevealPolicy::StateOnly,
    max_ops: 20_000,
    max_undos: 3,
    undo_penalty_pct: 30,
    log_deterministic: true,
    start_config_key: Some("target_happiness"),
};

pub static ENGINE: super::registry::EngineHandle = super::registry::EngineHandle {
    app_id: APP_ID,
    engine_hash: "0c5fec666ee36b9e06214d13aba01121321d2ea3620815e5bc942b5178ab6a5d",
    descriptor: DESCRIPTOR,
    deal,
    apply_op,
    apply_undo,
    replay,
    score,
};

const ACTIONS: [&str; 4] = ["feed", "play", "pet", "rest"];
const MIN_ACTION_GAP_MS: f64 = 1500.0;
const START: (i64, i64, i64) = (20, 40, 60); // happiness, hunger, energy

// ---------------------------------------------------------------------------
// Generated core
// ---------------------------------------------------------------------------

fn clamp(value: i64) -> i64 {
    value.clamp(0, 100)
}

fn stage_of(happiness: i64) -> i64 {
    if happiness >= 60 {
        2
    } else if happiness >= 30 {
        1
    } else {
        0
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct Pet {
    happiness: i64,
    hunger: i64,
    energy: i64,
}

fn new_pet() -> Pet {
    Pet {
        happiness: START.0,
        hunger: START.1,
        energy: START.2,
    }
}

fn step_pet(state: Pet, action: &str) -> Option<Pet> {
    let mut next = state;
    match action {
        "feed" => {
            let hunger_gap = 100 - next.hunger;
            next.happiness =
                clamp(next.happiness + js_math_round(hunger_gap as f64 / 8.0).min(8.0) as i64);
            next.hunger = clamp(next.hunger + 30);
        }
        "play" => {
            let can_play = next.hunger.min(next.energy);
            let gain = if can_play >= 20 {
                12
            } else {
                js_math_round(can_play as f64 / 4.0) as i64
            };
            next.happiness = clamp(next.happiness + gain);
            next.hunger = clamp(next.hunger - 20);
            next.energy = clamp(next.energy - 20);
        }
        "pet" => {
            next.happiness = clamp(next.happiness + 4);
            next.energy = clamp(next.energy - 3);
        }
        "rest" => {
            next.energy = clamp(next.energy + 30);
            next.happiness = clamp(next.happiness + 2);
            next.hunger = clamp(next.hunger - 10);
        }
        _ => return None, // "unknown pet action"
    }
    Some(next)
}

struct PetReplay {
    state: Pet,
    peak: i64,
}

fn replay_pet(actions: &[i64]) -> PetReplay {
    let mut state = new_pet();
    let mut peak = state.happiness;
    for &action in actions {
        let name = ACTIONS.get(action as usize).copied().unwrap_or("");
        let Some(next) = step_pet(state, name) else {
            break; // unreachable: actions only stores validated indices
        };
        state = next;
        peak = peak.max(state.happiness);
    }
    PetReplay { state, peak }
}

fn pet_answer(peak: i64, actions: &[i64]) -> String {
    let encoded = actions.iter().map(|a| a.to_string()).collect::<String>();
    format!("pet:{peak}:{encoded}")
}

fn pet_json(pet: &Pet) -> Json {
    serde_json::json!({
        "happiness": pet.happiness,
        "hunger": pet.hunger,
        "energy": pet.energy,
    })
}

fn pet_of(value: &Json) -> Pet {
    Pet {
        happiness: value
            .get("happiness")
            .and_then(Json::as_i64)
            .unwrap_or(START.0),
        hunger: value
            .get("hunger")
            .and_then(Json::as_i64)
            .unwrap_or(START.1),
        energy: value
            .get("energy")
            .and_then(Json::as_i64)
            .unwrap_or(START.2),
    }
}

fn action_view(pet: &Pet) -> Json {
    serde_json::json!({
        "ok": true,
        "view": {
            "happiness": pet.happiness,
            "hunger": pet.hunger,
            "energy": pet.energy,
            "stage": stage_of(pet.happiness),
        },
    })
}

// ---------------------------------------------------------------------------
// Wrapper ABI
// ---------------------------------------------------------------------------

pub fn deal(_problem_secret: &[u8; 32], _difficulty: u8) -> (Json, Json) {
    let pet = new_pet();
    let state = serde_json::json!({
        "pet": pet_json(&pet),
        "petPeak": pet.happiness,
        "actions": [],
        "lastActionMs": Json::Null,
    });
    let start_view = serde_json::json!({
        "happiness": pet.happiness,
        "hunger": pet.hunger,
        "energy": pet.energy,
        "stage": stage_of(pet.happiness),
    });
    (state, start_view)
}

pub fn apply_op(state: &mut Json, op: &Json, op_meta: &OpMeta) -> OpOutcome {
    let name = op_type_of(op);
    if !ACTIONS.contains(&name.as_str()) {
        return OpOutcome::Rejected {
            message: "op.type must be feed, play, pet, rest or undo".into(),
            status: 400,
        };
    }
    // Real-time action spacing (burst gate at op time). Resumed sessions
    // replayed without timing are exempt (finalize gate still applies).
    let now_ms = op_meta.now_ms;
    let last_action_ms = state.get("lastActionMs").and_then(Json::as_f64);
    if !op_meta.resumed
        && last_action_ms.is_some()
        && now_ms.is_some_and(|n| n.is_finite())
        && now_ms.unwrap() - last_action_ms.unwrap() < MIN_ACTION_GAP_MS
    {
        return OpOutcome::Rejected {
            message: "care actions must be spaced out".into(),
            status: 429,
        };
    }
    if now_ms.is_some_and(|n| n.is_finite()) {
        state["lastActionMs"] = js_num_json(now_ms.unwrap());
    }
    let pet = pet_of(state.get("pet").expect("pet state carries pet"));
    let next = step_pet(pet, &name).expect("validated care action cannot fail");
    let peak = state.get("petPeak").and_then(Json::as_i64).unwrap_or(0);
    state["pet"] = pet_json(&next);
    if next.happiness > peak {
        state["petPeak"] = Json::from(next.happiness);
    }
    let index = ACTIONS
        .iter()
        .position(|a| *a == name)
        .expect("validated action") as f64;
    state
        .get_mut("actions")
        .and_then(Json::as_array_mut)
        .expect("pet state carries actions")
        .push(js_num_json(index));
    OpOutcome::View(action_view(&next))
}

pub fn apply_undo(state: &mut Json, _op_meta: &OpMeta) -> OpOutcome {
    let actions_len = state
        .get("actions")
        .and_then(Json::as_array)
        .map_or(0, Vec::len);
    if actions_len == 0 {
        return OpOutcome::Rejected {
            message: "nothing to undo".into(),
            status: 409,
        };
    }
    let actions: Vec<i64> = {
        state
            .get_mut("actions")
            .and_then(Json::as_array_mut)
            .expect("pet state carries actions")
            .pop();
        state
            .get("actions")
            .and_then(Json::as_array)
            .expect("pet state carries actions")
            .iter()
            .filter_map(Json::as_i64)
            .collect()
    };
    // Rebuild pet + peak from the trimmed action log. lastActionMs is NOT
    // restored — the JS wrapper leaves it at the last applied op's value.
    let rebuilt = replay_pet(&actions);
    state["pet"] = pet_json(&rebuilt.state);
    state["petPeak"] = Json::from(rebuilt.peak);
    OpOutcome::View(action_view(&rebuilt.state))
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
    let actions: Vec<i64> = state
        .get("actions")
        .and_then(Json::as_array)
        .expect("pet state carries actions")
        .iter()
        .filter_map(Json::as_i64)
        .collect();
    let replayed = replay_pet(&actions);
    let target = super::abi::resolve_target(&DESCRIPTOR.targets, difficulty, extra);
    if (replayed.peak as f64) < target {
        return Err(ScoreRejection::new("happiness target not reached"));
    }
    Ok(super::abi::ScoreOutcome {
        answer_hash: answer_hash_of(&pet_answer(replayed.peak, &actions)),
        score: replayed.peak,
        score_field: Some(serde_json::json!({ "happiness_achieved": replayed.peak })),
    })
}
