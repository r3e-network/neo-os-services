//! Sheep Solitaire — port of `game/wrappers/sheep.wrapper.js` over
//! `engines/sheep.js` (GENERATED from the minigames TS twin).
//!
//! Seed derivation trap: `seedFromProblemSecret` does
//! `String(problemSecret)` — a Uint8Array stringifies to its DECIMAL
//! comma-joined bytes (e.g. "154,51,2,..."), so the "hex" seed is actually
//! `parseInt` of the first decimal digits, stopping at the first comma —
//! then `>>> 1`. mulberry32 itself is i32 arithmetic with JS shift semantics.

use serde_json::Value as Json;

use super::abi::{answer_hash_of, OpMeta, OpOutcome, ScoreExtra, ScoreRejection};
use super::{js_num_json, number_field, op_type_of};

pub const APP_ID: &str = "miniapp-sheep-solitaire";

const CARD_TYPES: [i64; 3] = [8, 12, 15];

pub const DESCRIPTOR: super::registry::EngineDescriptor = super::registry::EngineDescriptor {
    op_schema: "pick: {type:'pick', cardId:number} | shuffle | remove3 | undo",
    targets: CARD_TYPES, // score target = all cards cleared (totalCards)
    time_window: super::registry::TimeWindow {
        limit_ms: [300_000.0, 480_000.0, 720_000.0], // 5 / 8 / 12 min
        min_solve_ms: [30_000.0, 60_000.0, 90_000.0],
    },
    gates: super::abi::DEFAULT_GATES,
    reveal_policy: super::abi::RevealPolicy::Clues,
    max_ops: 5_000,
    max_undos: 3,
    undo_penalty_pct: 30,
    log_deterministic: true,
    start_config_key: Some("card_types"),
};

pub static ENGINE: super::registry::EngineHandle = super::registry::EngineHandle {
    app_id: APP_ID,
    engine_hash: "64448237394521469201aa0481edc1b6bd3298e994ade1e3bd28891aa9d98d44",
    descriptor: DESCRIPTOR,
    deal,
    apply_op,
    apply_undo,
    replay,
    score,
};

// ---------------------------------------------------------------------------
// Generated core
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq)]
struct Card {
    id: i64,
    symbol: i64,
    layer: i64,
    col: i64,
    row: i64,
}

struct Mulberry32 {
    state: i32,
}

impl Mulberry32 {
    fn new(seed: u32) -> Self {
        Self { state: seed as i32 } // seed | 0
    }

    fn next(&mut self) -> f64 {
        self.state = self.state.wrapping_add(1831565813);
        let x = self.state ^ ((self.state as u32 >> 15) as i32);
        let mut value = x.wrapping_mul(1 | self.state);
        let y = value ^ ((value as u32 >> 7) as i32);
        // JS precedence: (value + imul(y, 61|value)) ^ value — the f64 sum is
        // exact, ToInt32 of it equals the i32 wrap.
        value = value.wrapping_add(y.wrapping_mul(61 | value)) ^ value;
        ((value ^ ((value as u32 >> 14) as i32)) as u32) as f64 / 4294967296.0
    }
}

/// Node's `secretOf` returns a Buffer, so `String(problemSecret)` here is the
/// UTF-8-decoded text (malformed bytes → U+FFFD), not a Uint8Array byte list.
/// Valid multi-byte sequences never decode to ASCII, so `parseInt(hex, 16)`
/// consumes exactly the leading run of raw ASCII hex bytes — but leading
/// valid whitespace sequences (U+00A0, U+2028, …) are trimmed like JS.
fn string_of_secret(problem_secret: &[u8; 32]) -> String {
    let mut text = String::new();
    let mut i = 0usize;
    while i < problem_secret.len() {
        let b = problem_secret[i];
        let (len, body) = match b {
            0x00..=0x7F => (1, &problem_secret[i..i + 1]),
            0xC2..=0xDF => (2, problem_secret.get(i + 1..i + 2).unwrap_or(&[])),
            0xE0..=0xEF => (3, problem_secret.get(i + 1..i + 3).unwrap_or(&[])),
            0xF0..=0xF4 => (4, problem_secret.get(i + 1..i + 4).unwrap_or(&[])),
            _ => (0, &[][..]),
        };
        let valid = match (b, body) {
            (0x00..=0x7F, _) => true,
            (0xC2..=0xDF, [c1]) => (0x80..=0xBF).contains(c1),
            (0xE0, [c1, c2]) => (0xA0..=0xBF).contains(c1) && (0x80..=0xBF).contains(c2),
            (0xED, [c1, c2]) => (0x80..=0x9F).contains(c1) && (0x80..=0xBF).contains(c2),
            (0xE1..=0xEF, [c1, c2]) => (0x80..=0xBF).contains(c1) && (0x80..=0xBF).contains(c2),
            (0xF0, [c1, c2, c3]) => {
                (0x90..=0xBF).contains(c1)
                    && (0x80..=0xBF).contains(c2)
                    && (0x80..=0xBF).contains(c3)
            }
            (0xF4, [c1, c2, c3]) => {
                (0x80..=0x8F).contains(c1)
                    && (0x80..=0xBF).contains(c2)
                    && (0x80..=0xBF).contains(c3)
            }
            (0xF1..=0xF3, [c1, c2, c3]) => {
                (0x80..=0xBF).contains(c1)
                    && (0x80..=0xBF).contains(c2)
                    && (0x80..=0xBF).contains(c3)
            }
            _ => false,
        };
        if len > 0 && valid {
            text.push_str(
                std::str::from_utf8(&problem_secret[i..i + len]).expect("validated UTF-8 sequence"),
            );
            i += len;
        } else {
            text.push('\u{FFFD}');
            i += 1;
        }
    }
    text
}

/// `seedFromProblemSecret` — `parseInt(String(secret).replace(/^0x/,"").slice(0,8), 16) >>> 1`.
fn seed_from_problem_secret(problem_secret: &[u8; 32]) -> u32 {
    let head: String = string_of_secret(problem_secret).chars().take(8).collect();
    let trimmed = head.trim_start_matches(js_whitespace);
    let trimmed = trimmed.strip_prefix(['+', '-']).unwrap_or(trimmed);
    let digits: String = trimmed
        .chars()
        .take_while(|c| c.is_ascii_hexdigit())
        .collect();
    // parseInt with no digits is NaN; NaN >>> 1 is 0.
    u64::from_str_radix(&digits, 16).unwrap_or(0) as u32 >> 1
}

fn js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n'
            | '\u{0B}'
            | '\u{0C}'
            | '\r'
            | ' '
            | '\u{85}'
            | '\u{A0}'
            | '\u{1680}'
            | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

fn shuffle_values(items: &mut [i64], random: &mut Mulberry32) {
    let mut index = items.len() as i64 - 1;
    while index > 0 {
        let swap_index = (random.next() * (index + 1) as f64).floor() as usize;
        items.swap(index as usize, swap_index);
        index -= 1;
    }
}

fn generate_layout(problem_secret: &[u8; 32], card_types: f64) -> Vec<Card> {
    let types = ((if card_types.is_finite() && card_types != 0.0 {
        card_types
    } else {
        8.0
    })
    .clamp(1.0, 15.0)) as usize;
    let mut random = Mulberry32::new(seed_from_problem_secret(problem_secret));
    let mut layer0: Vec<i64> = (0..types as i64).collect();
    let mut layer1: Vec<i64> = (0..types as i64).collect();
    let mut layer2: Vec<i64> = (0..types as i64).collect();
    shuffle_values(&mut layer0, &mut random);
    shuffle_values(&mut layer1, &mut random);
    shuffle_values(&mut layer2, &mut random);
    let configs = [(4i64, 0i64), (5, 1), (6, 2)]; // (cols, layer)
    let mut cards = Vec::with_capacity(types * 3);
    let mut id = 0i64;
    for layer_index in (0..=2usize).rev() {
        let (cols, layer) = configs[layer_index];
        let symbols = match layer_index {
            2 => &layer2,
            1 => &layer1,
            _ => &layer0,
        };
        for index in 0..types {
            if index >= symbols.len() {
                break;
            }
            cards.push(Card {
                id,
                symbol: symbols[index],
                layer,
                col: index as i64 % cols,
                row: index as i64 / cols,
            });
            id += 1;
        }
    }
    cards
}

fn compute_exposed(cards: &[Card], picked_ids: &[i64]) -> Vec<bool> {
    let picked: std::collections::HashSet<i64> = picked_ids.iter().copied().collect();
    let unpicked: Vec<&Card> = cards.iter().filter(|c| !picked.contains(&c.id)).collect();
    cards
        .iter()
        .map(|card| {
            if picked.contains(&card.id) {
                return false;
            }
            !unpicked.iter().any(|other| {
                other.layer < card.layer
                    && (other.col - card.col).abs() <= 1
                    && (other.row - card.row).abs() <= 1
            })
        })
        .collect()
}

/// `{id, symbol, layer, exposed, picked}` views in card order.
fn build_card_views(cards: &[Card], picked_ids: &[i64]) -> Json {
    let picked: std::collections::HashSet<i64> = picked_ids.iter().copied().collect();
    let exposed = compute_exposed(cards, picked_ids);
    Json::Array(
        cards
            .iter()
            .zip(exposed)
            .map(|(card, exposed)| {
                serde_json::json!({
                    "id": card.id,
                    "symbol": card.symbol,
                    "layer": card.layer,
                    "exposed": exposed,
                    "picked": picked.contains(&card.id),
                })
            })
            .collect(),
    )
}

fn card_symbol(cards: &[Card], id: i64) -> Option<i64> {
    cards.iter().find(|c| c.id == id).map(|c| c.symbol)
}

fn can_match(cards: &[Card], slot: &[i64]) -> bool {
    let mut counts: std::collections::BTreeMap<i64, i64> = std::collections::BTreeMap::new();
    for &id in slot {
        if let Some(symbol) = card_symbol(cards, id) {
            *counts.entry(symbol).or_insert(0) += 1;
        }
    }
    counts.values().any(|&count| count >= 3)
}

struct PickResult {
    picked_ids: Vec<i64>,
    slot: Vec<i64>,
    matched: bool,
    won: bool,
    game_over: bool,
}

fn apply_pick(
    cards: &[Card],
    picked_ids: &[i64],
    slot: &[i64],
    card_id: i64,
) -> Result<PickResult, String> {
    if !cards.iter().any(|c| c.id == card_id) {
        return Err("card not found".into());
    }
    let exposed = compute_exposed(cards, picked_ids);
    let card_index = cards
        .iter()
        .position(|c| c.id == card_id)
        .expect("card exists");
    if !exposed[card_index] {
        return Err("card is not exposed".into());
    }
    if picked_ids.contains(&card_id) {
        return Err("card already picked".into());
    }
    let new_picked_ids: Vec<i64> = picked_ids
        .iter()
        .copied()
        .chain(std::iter::once(card_id))
        .collect();
    let new_slot: Vec<i64> = slot
        .iter()
        .copied()
        .chain(std::iter::once(card_id))
        .collect();

    // Symbol counts keyed by symbol — JS integer-like keys iterate ascending.
    let mut symbol_count: std::collections::BTreeMap<i64, i64> = std::collections::BTreeMap::new();
    for &id in &new_slot {
        if let Some(symbol) = card_symbol(cards, id) {
            *symbol_count.entry(symbol).or_insert(0) += 1;
        }
    }
    let matched_symbol = symbol_count
        .iter()
        .find(|(_, &count)| count >= 3)
        .map(|(&symbol, _)| symbol);

    let mut final_slot = new_slot.clone();
    if let Some(eliminated) = matched_symbol {
        let mut removed = 0;
        final_slot = new_slot
            .iter()
            .copied()
            .filter(|&id| {
                let hit = removed < 3 && card_symbol(cards, id) == Some(eliminated);
                if hit {
                    removed += 1;
                }
                !hit
            })
            .collect();
    }
    let won = cards.iter().all(|c| new_picked_ids.contains(&c.id));
    let game_over = !won && final_slot.len() >= 7 && !can_match(cards, &final_slot);
    Ok(PickResult {
        picked_ids: new_picked_ids,
        slot: final_slot,
        matched: matched_symbol.is_some(),
        won,
        game_over,
    })
}

fn rebuild_slot_from_picks(cards: &[Card], picked_ids: &[i64]) -> Vec<i64> {
    let mut slot: Vec<i64> = Vec::new();
    for &card_id in picked_ids {
        let new_slot: Vec<i64> = slot
            .iter()
            .copied()
            .chain(std::iter::once(card_id))
            .collect();
        let mut symbol_count: std::collections::BTreeMap<i64, i64> =
            std::collections::BTreeMap::new();
        for &id in &new_slot {
            if let Some(symbol) = card_symbol(cards, id) {
                *symbol_count.entry(symbol).or_insert(0) += 1;
            }
        }
        let mut matched = false;
        for (&symbol, &count) in &symbol_count {
            if count >= 3 {
                matched = true;
                let mut removed = 0;
                slot = new_slot
                    .iter()
                    .copied()
                    .filter(|&id| {
                        let hit = removed < 3 && card_symbol(cards, id) == Some(symbol);
                        if hit {
                            removed += 1;
                        }
                        !hit
                    })
                    .collect();
                break;
            }
        }
        if !matched {
            slot = new_slot;
        }
    }
    slot
}

struct SheepReplay {
    picked_ids: Vec<i64>,
    slot: Vec<i64>,
    won: bool,
    game_over: bool,
    shuffle_left: i64,
    remove3_left: i64,
}

fn replay_sheep(
    problem_secret: &[u8; 32],
    difficulty: u8,
    op_log: &[Json],
) -> Result<SheepReplay, String> {
    let card_types = CARD_TYPES.get(difficulty as usize).copied().unwrap_or(8);
    let cards = generate_layout(problem_secret, card_types as f64);
    let mut picked_ids: Vec<i64> = Vec::new();
    let mut slot: Vec<i64> = Vec::new();
    let mut won = false;
    let mut game_over = false;
    let mut shuffle_left = 1i64;
    let mut remove3_left = 1i64;
    for (index, operation) in op_log.iter().enumerate() {
        let op_type = op_type_of(operation);
        if op_type == "pick" {
            let result = apply_pick(
                &cards,
                &picked_ids,
                &slot,
                super::number_field(operation.get("cardId")) as i64,
            )
            .map_err(|error| format!("invalid pick op at index {index}: {error}"))?;
            picked_ids = result.picked_ids;
            slot = result.slot;
            won = result.won;
            game_over = result.game_over;
        } else if op_type == "shuffle" {
            if shuffle_left <= 0 {
                return Err(format!("shuffle exhausted at index {index}"));
            }
            shuffle_left -= 1;
        } else if op_type == "remove3" {
            if remove3_left <= 0 {
                return Err(format!("remove3 exhausted at index {index}"));
            }
            remove3_left -= 1;
            slot = slot.iter().skip(3).copied().collect();
        } else if op_type == "undo" {
            if !picked_ids.is_empty() {
                picked_ids = picked_ids[..picked_ids.len() - 1].to_vec();
                slot = rebuild_slot_from_picks(&cards, &picked_ids);
            }
        } else {
            return Err(format!("unknown op type '{op_type}' at index {index}"));
        }
        if won || game_over {
            break;
        }
    }
    Ok(SheepReplay {
        picked_ids,
        slot,
        won,
        game_over,
        shuffle_left,
        remove3_left,
    })
}

// ---------------------------------------------------------------------------
// Wrapper ABI
// ---------------------------------------------------------------------------

fn card_json(card: &Card) -> Json {
    serde_json::json!({
        "id": card.id,
        "symbol": card.symbol,
        "layer": card.layer,
        "col": card.col,
        "row": card.row,
    })
}

fn cards_json(cards: &[Card]) -> Json {
    Json::Array(cards.iter().map(card_json).collect())
}

fn cards_of(value: &Json) -> Vec<Card> {
    value
        .as_array()
        .expect("sheep state carries cards")
        .iter()
        .map(|c| Card {
            id: c.get("id").and_then(Json::as_i64).unwrap_or(0),
            symbol: c.get("symbol").and_then(Json::as_i64).unwrap_or(0),
            layer: c.get("layer").and_then(Json::as_i64).unwrap_or(0),
            col: c.get("col").and_then(Json::as_i64).unwrap_or(0),
            row: c.get("row").and_then(Json::as_i64).unwrap_or(0),
        })
        .collect()
}

fn card_views_for_ids(cards: &[Card], picked_ids: &[i64], ids: &[i64]) -> Json {
    let views = build_card_views(cards, picked_ids);
    Json::Array(
        ids.iter()
            .filter_map(|id| {
                views
                    .as_array()
                    .expect("views is an array")
                    .iter()
                    .find(|v| v.get("id").and_then(Json::as_i64) == Some(*id))
                    .cloned()
            })
            .collect(),
    )
}

fn current_view(cards: &[Card], state: &Json, matched: bool) -> Json {
    let picked_ids: Vec<i64> = state
        .get("pickedIds")
        .and_then(Json::as_array)
        .map(|a| a.iter().filter_map(Json::as_i64).collect())
        .unwrap_or_default();
    let slot: Vec<i64> = state
        .get("slot")
        .and_then(Json::as_array)
        .map(|a| a.iter().filter_map(Json::as_i64).collect())
        .unwrap_or_default();
    serde_json::json!({
        "ok": true,
        "cards": build_card_views(cards, &picked_ids),
        "slots": card_views_for_ids(cards, &picked_ids, &slot),
        "matched": matched,
        "won": state.get("won").and_then(Json::as_bool).unwrap_or(false),
        "gameOver": state.get("gameOver").and_then(Json::as_bool).unwrap_or(false),
        "shuffleLeft": state.get("shuffleLeft").and_then(Json::as_i64).unwrap_or(1),
        "remove3Left": state.get("remove3Left").and_then(Json::as_i64).unwrap_or(1),
    })
}

pub fn deal(problem_secret: &[u8; 32], difficulty: u8) -> (Json, Json) {
    let card_types = CARD_TYPES.get(difficulty as usize).copied().unwrap_or(8);
    let cards = generate_layout(problem_secret, card_types as f64);
    let total_cards = cards.len() as i64;
    let state = serde_json::json!({
        "problemSecret": super::secret_to_json(problem_secret),
        "difficulty": difficulty,
        "cards": cards_json(&cards),
        "pickedIds": [],
        "slot": [],
        "shuffleLeft": 1,
        "remove3Left": 1,
        "won": false,
        "gameOver": false,
        "acceptedOps": [],
    });
    let start_view = serde_json::json!({
        "cards": build_card_views(&cards, &[]),
        "slots": [],
        "totalCards": total_cards,
        "cardTypes": card_types,
        "shuffleLeft": 1,
        "remove3Left": 1,
    });
    (state, start_view)
}

fn accepted_ops_of(state: &Json) -> Vec<Json> {
    state
        .get("acceptedOps")
        .and_then(Json::as_array)
        .expect("sheep state carries acceptedOps")
        .clone()
}

fn push_accepted_op(state: &mut Json, op: Json) {
    state
        .get_mut("acceptedOps")
        .and_then(Json::as_array_mut)
        .expect("sheep state carries acceptedOps")
        .push(op);
}

fn set_pick_result(state: &mut Json, result: &PickResult) {
    state["pickedIds"] = Json::Array(result.picked_ids.iter().map(|v| (*v).into()).collect());
    state["slot"] = Json::Array(result.slot.iter().map(|v| (*v).into()).collect());
    state["won"] = Json::Bool(result.won);
    state["gameOver"] = Json::Bool(result.game_over);
}

fn set_replay_result(state: &mut Json, replayed: &SheepReplay) {
    state["pickedIds"] = Json::Array(replayed.picked_ids.iter().map(|v| (*v).into()).collect());
    state["slot"] = Json::Array(replayed.slot.iter().map(|v| (*v).into()).collect());
    state["won"] = Json::Bool(replayed.won);
    state["gameOver"] = Json::Bool(replayed.game_over);
    state["shuffleLeft"] = Json::from(replayed.shuffle_left);
    state["remove3Left"] = Json::from(replayed.remove3_left);
}

pub fn apply_op(state: &mut Json, op: &Json, _op_meta: &OpMeta) -> OpOutcome {
    let op_type = op_type_of(op);

    if op_type == "pick" {
        let card_id = number_field(op.get("cardId"));
        if !card_id.is_finite() || card_id.fract() != 0.0 || card_id < 0.0 {
            return OpOutcome::Rejected {
                message: "op.cardId must be a non-negative integer".into(),
                status: 400,
            };
        }
        let cards = cards_of(state.get("cards").expect("sheep state carries cards"));
        let picked_ids: Vec<i64> = state
            .get("pickedIds")
            .and_then(Json::as_array)
            .map(|a| a.iter().filter_map(Json::as_i64).collect())
            .unwrap_or_default();
        let slot: Vec<i64> = state
            .get("slot")
            .and_then(Json::as_array)
            .map(|a| a.iter().filter_map(Json::as_i64).collect())
            .unwrap_or_default();
        let result = match apply_pick(&cards, &picked_ids, &slot, card_id as i64) {
            Ok(result) => result,
            Err(message) => {
                return OpOutcome::Rejected {
                    message,
                    status: 409,
                }
            }
        };
        set_pick_result(state, &result);
        push_accepted_op(
            state,
            serde_json::json!({ "type": "pick", "cardId": js_num_json(card_id) }),
        );
        return OpOutcome::View(current_view(&cards, state, result.matched));
    }

    if op_type == "shuffle" {
        let shuffle_left = state.get("shuffleLeft").and_then(Json::as_i64).unwrap_or(1);
        if shuffle_left <= 0 {
            return OpOutcome::Rejected {
                message: "no shuffles remaining".into(),
                status: 409,
            };
        }
        state["shuffleLeft"] = Json::from(shuffle_left - 1);
        push_accepted_op(state, serde_json::json!({ "type": "shuffle" }));
        let cards = cards_of(state.get("cards").expect("sheep state carries cards"));
        return OpOutcome::View(current_view(&cards, state, false));
    }

    if op_type == "remove3" {
        let remove3_left = state.get("remove3Left").and_then(Json::as_i64).unwrap_or(1);
        if remove3_left <= 0 {
            return OpOutcome::Rejected {
                message: "no remove3 uses remaining".into(),
                status: 409,
            };
        }
        let slot_len = state
            .get("slot")
            .and_then(Json::as_array)
            .map_or(0, Vec::len);
        if slot_len < 3 {
            return OpOutcome::Rejected {
                message: "remove3 requires at least 3 tray cards".into(),
                status: 409,
            };
        }
        state["remove3Left"] = Json::from(remove3_left - 1);
        // Remove first 3 items from the tray
        let slot: Vec<Json> = state
            .get("slot")
            .and_then(Json::as_array)
            .expect("sheep state carries slot")
            .iter()
            .skip(3)
            .cloned()
            .collect();
        state["slot"] = Json::Array(slot);
        state["gameOver"] = Json::Bool(false);
        push_accepted_op(state, serde_json::json!({ "type": "remove3" }));
        let cards = cards_of(state.get("cards").expect("sheep state carries cards"));
        return OpOutcome::View(current_view(&cards, state, false));
    }

    OpOutcome::Rejected {
        message: format!("unknown op.type: {op_type}"),
        status: 400,
    }
}

pub fn apply_undo(state: &mut Json, _op_meta: &OpMeta) -> OpOutcome {
    let pick_index = accepted_ops_of(state)
        .iter()
        .rposition(|op| op.get("type").and_then(Json::as_str) == Some("pick"));
    let Some(pick_index) = pick_index else {
        return OpOutcome::Rejected {
            message: "nothing to undo".into(),
            status: 409,
        };
    };
    state
        .get_mut("acceptedOps")
        .and_then(Json::as_array_mut)
        .expect("sheep state carries acceptedOps")
        .remove(pick_index); // wrapper splice(pickIndex, 1) drops exactly one op
    let secret = super::state_secret(state);
    let difficulty = state.get("difficulty").and_then(Json::as_u64).unwrap_or(0) as u8;
    let replayed =
        replay_sheep(&secret, difficulty, &accepted_ops_of(state)).expect("accepted ops replay");
    set_replay_result(state, &replayed);
    let cards = cards_of(state.get("cards").expect("sheep state carries cards"));
    OpOutcome::View(current_view(&cards, state, false))
}

pub fn replay(problem_secret: &[u8; 32], op_log: &[Json], difficulty: u8) -> Result<Json, String> {
    let (mut state, _) = deal(problem_secret, difficulty);
    for (i, op) in op_log.iter().enumerate() {
        let op_type = op_type_of(op);
        let outcome = if op_type == "undo" {
            apply_undo(&mut state, &OpMeta::resumed(*problem_secret, difficulty, i))
        } else {
            apply_op(
                &mut state,
                op,
                &OpMeta::resumed(*problem_secret, difficulty, i),
            )
        };
        if let OpOutcome::Rejected { message, .. } = outcome {
            return Err(format!("invalid replay op at index {i}: {message}"));
        }
        let won = state.get("won").and_then(Json::as_bool).unwrap_or(false);
        let game_over = state
            .get("gameOver")
            .and_then(Json::as_bool)
            .unwrap_or(false);
        if won || game_over {
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
    let total_cards = state
        .get("cards")
        .and_then(Json::as_array)
        .map_or(0, Vec::len) as f64;
    let cards_cleared = state
        .get("pickedIds")
        .and_then(Json::as_array)
        .map_or(0, Vec::len) as f64;
    let target = super::abi::resolve_target(&[total_cards as i64; 3], difficulty, extra);
    if cards_cleared < target {
        return Err(ScoreRejection::new(
            "game not won — all cards must be cleared",
        ));
    }
    let card_types = CARD_TYPES.get(difficulty as usize).copied().unwrap_or(8);
    let picked_ids: Vec<String> = state
        .get("pickedIds")
        .and_then(Json::as_array)
        .expect("sheep state carries pickedIds")
        .iter()
        .filter_map(Json::as_i64)
        .map(|id| id.to_string())
        .collect();
    Ok(super::abi::ScoreOutcome {
        answer_hash: answer_hash_of(&format!(
            "sheep:{}:{}",
            cards_cleared as i64,
            picked_ids.join(".")
        )),
        score: cards_cleared as i64,
        score_field: Some(serde_json::json!({
            "card_types": card_types,
            "cards_cleared": cards_cleared as i64,
        })),
    })
}
