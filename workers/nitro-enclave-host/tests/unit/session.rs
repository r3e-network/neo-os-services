//! Rust session-route closure: all 11 engines traverse auth + dispatch, the
//! generic sequence/token contract remains fail-closed, and a successful
//! Sudoku finalize produces the exact codec plus custody envelope. The kernel
//! lane is also driven through the production `/oracle/fulfill` fold: a
//! settled session is bound to its chain requester, consumed by the first
//! kernel request, and encoded as the shared game-result v2 vectors.

use super::*;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use p256::ecdsa::signature::hazmat::PrehashSigner;
use p256::ecdsa::SigningKey;
use serde_json::{json, Value as Json};
use sha2::{Digest, Sha256};

#[path = "support.rs"]
#[allow(clippy::duplicate_mod)]
mod support;
use support::*;

/// Every test here shares the process-wide session store, and the test
/// harness runs tests on parallel threads: hold this for the whole test.
static STORE_TESTS: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn store_test_lock() -> std::sync::MutexGuard<'static, ()> {
    STORE_TESTS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn identity(app_id: &str, game_id: usize) -> Json {
    let engine_hash = neo_os_games::registry::resolve_engine(app_id)
        .map(|engine| engine.engine_hash)
        .unwrap_or("");
    let mut scalar = [1u8; 32];
    scalar[0] = 0x11;
    let signing_key = SigningKey::from_slice(&scalar).expect("valid test scalar");
    let public_key = signing_key.verifying_key().to_encoded_point(true);
    let public_key_hex = hex_encode(public_key.as_bytes());
    let script_hash = neo_os_core::n3_tx::script_hash_from_public_key(public_key.as_bytes())
        .expect("test public key script hash");
    let player = format!("0x{}", hex_encode(&script_hash));
    let mut payload = json!({
        "app_id": app_id,
        "network": "testnet",
        "contract_hash": "0xaabbccddeeff0011223344556677889900aabbcc",
        "player": player,
        "game_id": game_id.to_string(),
        "difficulty": 0,
        "engine_hash": engine_hash,
    });
    let identity = neo_os_games::session::parse_identity(&payload).expect("valid identity");
    let digest = neo_os_games::session::witness_digest(
        "",
        &neo_os_games::session::witness_message_for(&identity.canonical),
    );
    let signature: p256::ecdsa::Signature = signing_key
        .sign_prehash(&digest)
        .expect("test witness signature");
    payload["player_witness"] = json!({
        "public_key": public_key_hex,
        "signature": hex_encode(&signature.to_bytes()),
        "salt": "",
    });
    payload
}

fn post(harness: &TestState, route: &str, payload: &Json) -> DispatchOutcome {
    crate::dispatch::dispatch(
        &harness.state,
        "POST",
        route,
        &bearer("s3cret"),
        &body_json(payload),
    )
}

#[test]
fn rust_session_routes_cover_every_engine_and_sign_the_fixed_codec() {
    let _store = store_test_lock();
    reset_sessions_for_tests();
    let root_hex = "07".repeat(32);
    let harness = test_state(
        &[
            ("MORPHEUS_NETWORK", "testnet"),
            ("NITRO_API_TOKEN", "s3cret"),
            ("MORPHEUS_GAME_SECRET_ROOT_HEX", &root_hex),
            ("MORPHEUS_GAME_SECRET_ROOT_SOURCE", "nitro-recipient-kms"),
        ],
        FakeAttest::with_document(b"attestation"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::default(),
    );
    harness.oracle_io.set_now_ms(1_000_000);

    for (index, app_id) in neo_os_games::registry::registered_app_ids()
        .into_iter()
        .enumerate()
    {
        let response = post(&harness, "/session/start", &identity(app_id, index + 1));
        assert_eq!(response.status, 200, "{app_id}: {}", response.body);
        assert_eq!(response.body["config"]["app_id"], app_id);
        assert_eq!(response.body["config"]["game_id"], (index + 1).to_string());
        assert!(response.body["session_token"]
            .as_str()
            .is_some_and(|value| value.len() == 64));
        assert!(response.body["replay_proof"]
            .as_str()
            .is_some_and(|value| value.len() == 64));
    }

    // One live step proves sequence ownership and the plain session error
    // contract (not the host's generic runtime-error envelope).
    let step_identity = identity("miniapp-sudoku", 90);
    let start = post(&harness, "/session/start", &step_identity);
    let open_cell = start.body["view"]["clues"]
        .as_str()
        .expect("Sudoku clues")
        .bytes()
        .position(|value| value == b'0')
        .expect("a playable cell");
    let mut step = step_identity.clone();
    step["session_token"] = start.body["session_token"].clone();
    step["seq"] = Json::from(0);
    step["op"] = json!({ "type": "place", "cell": open_cell, "digit": 1 });
    harness.oracle_io.set_now_ms(1_001_000);
    let accepted = post(&harness, "/session/step", &step);
    assert_eq!(accepted.status, 200, "{}", accepted.body);
    assert_eq!(accepted.body["seq"], 0);
    assert_eq!(accepted.body["op_count"], 1);
    let stale = post(&harness, "/session/step", &step);
    assert_eq!(stale.status, 409);
    assert_eq!(
        stale.body,
        json!({ "error": "stale seq", "expected_min": 1 })
    );

    // Sudoku's authoritative solution is deterministically derivable only
    // inside the measured compute module from the HMAC-derived problem secret.
    let final_identity = identity("miniapp-sudoku", 91);
    harness.oracle_io.set_now_ms(2_000_000);
    let start = post(&harness, "/session/start", &final_identity);
    assert_eq!(start.status, 200, "{}", start.body);
    let parsed =
        neo_os_games::session::parse_identity(&final_identity).expect("valid test identity");
    let root = [7u8; 32];
    let secret = neo_os_games::session::problem_secret_for(&root, &parsed.canonical);
    let engine =
        neo_os_games::registry::resolve_engine("miniapp-sudoku").expect("registered Sudoku");
    let (state, _) = (engine.deal)(&secret, 0);
    let solution = state["solution"].as_str().expect("solution").to_string();

    let clues = start.body["view"]["clues"].as_str().expect("Sudoku clues");
    let mut sequence = 0u64;
    for (cell, clue) in clues.bytes().enumerate() {
        if clue != b'0' {
            continue;
        }
        let mut step = final_identity.clone();
        step["session_token"] = start.body["session_token"].clone();
        step["seq"] = Json::from(sequence);
        step["op"] = json!({
            "type": "place",
            "cell": cell,
            "digit": solution.as_bytes()[cell] - b'0',
        });
        harness.oracle_io.set_now_ms(2_001_000 + sequence * 2_250);
        let accepted = post(&harness, "/session/step", &step);
        assert_eq!(accepted.status, 200, "{}", accepted.body);
        sequence += 1;
    }

    // The server replays the accepted operation log. A client-provided answer
    // is optional and only acts as a consistency assertion when present.
    let mut finalize = final_identity;
    finalize["session_token"] = start.body["session_token"].clone();
    finalize["kind"] = Json::String("miniapp.game.session.finalize.v2".into());
    harness.oracle_io.set_now_ms(2_090_000);
    // The kernel lane settles one chain request, submitted by the player.
    let mut unbound = finalize.clone();
    unbound["request_id"] = Json::String("91".into());
    let refused = post(&harness, "/session/settle", &unbound);
    assert_eq!(refused.status, 400, "{}", refused.body);
    assert_eq!(
        refused.body["error"],
        "kernel requester must be a 20-byte script hash"
    );
    finalize["request_id"] = Json::String("91".into());
    finalize["requester"] = finalize["player"].clone();
    let result = post(&harness, "/session/settle", &finalize);
    assert_eq!(result.status, 200, "{}", result.body);
    assert_eq!(result.body["callback_encoding"], "game_result_v2");
    assert_eq!(result.body["elapsed_ms"], 1_000 + (sequence - 1) * 2_250);
    assert_eq!(result.body["score"], 1, "{}", result.body);
    assert_eq!(
        BASE64
            .decode(
                result.body["result_bytes_base64"]
                    .as_str()
                    .expect("result codec"),
            )
            .expect("base64")
            .len(),
        neo_os_games::session::RESULT_BYTES_LENGTH
    );
    assert_eq!(
        result.body["verification"]["output_hash"],
        result.body["output_hash"]
    );
    assert_eq!(
        result.body["verification"]["signature"],
        result.body["signature"]
    );
    assert_eq!(result.body["verification"]["tee_attestation"], Json::Null);

    let calls = harness.signer.sign_calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].0, "testnet");
    assert_eq!(calls[0].1, "worker");
    let signed_text =
        String::from_utf8(hex::decode(&calls[0].2).expect("signed hex")).expect("signed UTF-8");
    assert_eq!(
        signed_text,
        format!(
            "{{\"result_bytes_base64\":\"{}\"}}",
            result.body["result_bytes_base64"].as_str().unwrap()
        )
    );
    assert_eq!(
        result.body["output_hash"],
        neo_os_core::sha256_hex(signed_text.as_bytes())
    );

    // Validation precedes key lookup; a well-formed request without a
    // recipient-attested secret fails as the Node route's plain 503.
    let unavailable = test_state(
        &[
            ("MORPHEUS_NETWORK", "testnet"),
            ("NITRO_API_TOKEN", "s3cret"),
        ],
        FakeAttest::with_document(b"attestation"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::default(),
    );
    let invalid = post(&unavailable, "/session/start", &json!({}));
    assert_eq!(invalid.status, 400);
    assert!(invalid.body["error"]
        .as_str()
        .unwrap()
        .starts_with("app_id must be one of:"));
    let missing_key = post(
        &unavailable,
        "/session/start",
        &identity("miniapp-sudoku", 92),
    );
    assert_eq!(missing_key.status, 503);
    assert_eq!(
        missing_key.body,
        json!({ "error": "game key material unavailable" })
    );
}

// ---------------------------------------------------------------------------
// Kernel lane through the production `/oracle/fulfill` fold
// ---------------------------------------------------------------------------

/// The crate tests' HMAC root, `[9u8; 32]`, so the shared LOSS vector can be
/// reproduced byte for byte through the enclave host.
const GAME_ROOT_HEX: &str = "0909090909090909090909090909090909090909090909090909090909090909";
const GAME_CONTRACT: &str = "0xaabbccddeeff0011223344556677889900aabbcc";
const SUDOKU: &str = "miniapp-sudoku";
const DAY_MS: u64 = 86_400_000;

struct Player {
    signing_key: SigningKey,
    public_key_hex: String,
    hash: String,
}

/// The same deterministic account as `neo_os_games`' `test_player(seed)`.
fn player(seed: u8) -> Player {
    let mut scalar = [seed; 32];
    scalar[0] = 0x11;
    let signing_key = SigningKey::from_slice(&scalar).expect("valid test scalar");
    let public_key = signing_key.verifying_key().to_encoded_point(true);
    let script_hash = neo_os_core::n3_tx::script_hash_from_public_key(public_key.as_bytes())
        .expect("test public key script hash");
    Player {
        public_key_hex: hex_encode(public_key.as_bytes()),
        hash: format!("0x{}", hex_encode(&script_hash)),
        signing_key,
    }
}

fn sudoku_identity(game_id: &str, player: &Player) -> Json {
    let engine_hash = neo_os_games::registry::resolve_engine(SUDOKU)
        .expect("registered Sudoku")
        .engine_hash;
    json!({
        "app_id": SUDOKU,
        "engine_hash": engine_hash,
        "network": "testnet",
        "contract_hash": GAME_CONTRACT,
        "player": player.hash,
        "game_id": game_id,
        "difficulty": 0,
    })
}

fn witnessed_start(identity: &Json, player: &Player) -> Json {
    let canonical = neo_os_games::session::parse_identity(identity)
        .expect("valid identity")
        .canonical;
    let digest = neo_os_games::session::witness_digest(
        "salt-1",
        &neo_os_games::session::witness_message_for(&canonical),
    );
    let signature: p256::ecdsa::Signature = player
        .signing_key
        .sign_prehash(&digest)
        .expect("witness signature");
    let mut start = identity.clone();
    start["player_witness"] = json!({
        "public_key": player.public_key_hex,
        "signature": hex_encode(&signature.to_bytes()),
        "salt": "salt-1",
    });
    start
}

fn kernel_harness() -> TestState {
    let mut harness = test_state(
        &[
            ("MORPHEUS_NETWORK", "testnet"),
            ("NITRO_API_TOKEN", "s3cret"),
            ("MORPHEUS_GAME_SECRET_ROOT_HEX", GAME_ROOT_HEX),
            ("MORPHEUS_GAME_SECRET_ROOT_SOURCE", "nitro-recipient-kms"),
        ],
        FakeAttest::with_document(b"attestation"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::default(),
    );
    // Run the real in-process session handler behind /oracle/fulfill.
    harness.state.fulfillment_compute_override = None;
    harness
}

/// A played Sudoku session: the token, the op-log and the last step's
/// authenticated resume record.
struct Played {
    identity: Json,
    token: Json,
    ops: Vec<Json>,
    last_step: Json,
}

/// Start at `started_ms` and place every open cell with its solution digit;
/// op `i` of `n` lands at `last_op_ms - (n - 1 - i) * spacing_ms`.
fn play_sudoku(
    harness: &TestState,
    game_id: &str,
    player: &Player,
    started_ms: u64,
    last_op_ms: u64,
    spacing_ms: u64,
) -> Played {
    let identity = sudoku_identity(game_id, player);
    harness.oracle_io.set_now_ms(started_ms);
    let start = post(
        harness,
        "/session/start",
        &witnessed_start(&identity, player),
    );
    assert_eq!(start.status, 200, "{}", start.body);
    let token = start.body["session_token"].clone();
    let parsed = neo_os_games::session::parse_identity(&identity).expect("identity");
    let root: [u8; 32] = hex::decode(GAME_ROOT_HEX)
        .expect("root hex")
        .try_into()
        .expect("32-byte root");
    let secret = neo_os_games::session::problem_secret_for(&root, &parsed.canonical);
    let engine = neo_os_games::registry::resolve_engine(SUDOKU).expect("Sudoku");
    let (state, _) = (engine.deal)(&secret, 0);
    let solution = state["solution"].as_str().expect("solution").to_string();
    let cells: Vec<usize> = start.body["view"]["clues"]
        .as_str()
        .expect("clues")
        .bytes()
        .enumerate()
        .filter_map(|(index, value)| (value == b'0').then_some(index))
        .collect();
    let count = cells.len() as u64;
    let mut ops = Vec::new();
    let mut last_step = Json::Null;
    for (seq, cell) in cells.into_iter().enumerate() {
        let op = json!({
            "type": "place",
            "cell": cell,
            "digit": (solution.as_bytes()[cell] - b'0') as u64,
        });
        let mut step = identity.clone();
        step["session_token"] = token.clone();
        step["seq"] = Json::from(seq);
        step["op"] = op.clone();
        harness
            .oracle_io
            .set_now_ms(last_op_ms - (count - 1 - seq as u64) * spacing_ms);
        let reply = post(harness, "/session/step", &step);
        assert_eq!(reply.status, 200, "{}", reply.body);
        ops.push(op);
        last_step = reply.body;
    }
    Played {
        identity,
        token,
        ops,
        last_step,
    }
}

/// The plaintext finalize.v2 payload a player assembles from its own
/// direct-lane outputs (the preview freezes the elapsed time it settles).
fn previewed_payload(harness: &TestState, played: &Played, at_ms: u64) -> Json {
    let mut finalize = played.identity.clone();
    finalize["session_token"] = played.token.clone();
    harness.oracle_io.set_now_ms(at_ms);
    let preview = post(harness, "/session/finalize", &finalize);
    assert_eq!(preview.status, 200, "{}", preview.body);
    assert_eq!(preview.body["solved"], true, "{}", preview.body);
    let mut payload = played.identity.clone();
    payload["kind"] = Json::String("miniapp.game.session.finalize.v2".into());
    payload["session_token"] = played.token.clone();
    payload["replay"] = Json::Array(played.ops.clone());
    payload["replay_record"] = preview.body["replay_record"].clone();
    payload["replay_proof"] = preview.body["replay_proof"].clone();
    payload["elapsed_ms"] = preview.body["elapsed_ms"].clone();
    payload["finalize_proof"] = preview.body["finalize_proof"].clone();
    payload
}

/// One kernel request as the relayer delivers it: the requester and the ids
/// come from the chain request, the rest from the payload.
fn kernel_fulfill(harness: &TestState, request_id: &str, requester: &str, payload: &Json) -> Json {
    let mut delivered = payload.clone();
    delivered["requester"] = Json::String(requester.to_string());
    let body = json!({
        "chain": "neo_n3",
        "request_type": "session.finalize",
        "request_id": request_id,
        "payload": delivered,
        "fulfillment_context": {
            "app_id": payload["app_id"],
            "module_id": "game.session",
            "operation": "session.finalize",
        },
    });
    crate::fulfill::handle_oracle_fulfill(&harness.state, &body).expect("kernel fulfillment")
}

fn result_bytes(response: &Json) -> Vec<u8> {
    BASE64
        .decode(
            response["result_bytes_base64"]
                .as_str()
                .unwrap_or_else(|| panic!("no result bytes in {response}")),
        )
        .expect("result base64")
}

/// `sha256("neoos-game-result-binding/v1" ‖ sha256(appId) ‖ uint256_be(gameId) ‖ player)`,
/// recomputed here from the definition in the shared vectors.
fn expected_binding(app_id: &str, game_id: u64, player_display_hex: &str) -> Vec<u8> {
    let mut game = [0u8; 32];
    game[24..].copy_from_slice(&game_id.to_be_bytes());
    let mut player = hex::decode(player_display_hex.trim_start_matches("0x")).expect("player hex");
    player.reverse();
    let mut hasher = Sha256::new();
    hasher.update(b"neoos-game-result-binding/v1");
    hasher.update(Sha256::digest(app_id.as_bytes()));
    hasher.update(game);
    hasher.update(&player);
    hasher.finalize().to_vec()
}

fn evict_live_sessions() {
    if let Some(store) = SESSIONS.get() {
        store.lock().expect("session store").clear();
    }
}

fn restart_session_store() {
    if let Some(store) = SESSIONS.get() {
        *store.lock().expect("session store") = SessionStore::new();
    }
}

#[test]
fn kernel_lane_refuses_a_session_played_by_another_account() {
    let _store = store_test_lock();
    restart_session_store();
    let harness = kernel_harness();
    let owner = player(21);
    let other = player(22);
    let played = play_sudoku(&harness, "7", &owner, 1_000_000, 1_080_000, 2_000);
    let payload = previewed_payload(&harness, &played, 1_095_000);

    // The chain says Q submitted this request; the session belongs to P.
    let replayed = kernel_fulfill(&harness, "501", &other.hash, &payload);
    assert_eq!(replayed["success"], false, "{replayed}");
    assert!(
        replayed["error"]
            .as_str()
            .unwrap_or_default()
            .contains("requester"),
        "{replayed}"
    );
    assert!(replayed["result_bytes_base64"].is_null(), "{replayed}");

    // The session's own player settles it.
    let own = kernel_fulfill(&harness, "502", &owner.hash, &payload);
    assert_eq!(own["success"], true, "{own}");
}

#[test]
fn kernel_lane_consumes_the_session_and_binds_the_result_to_the_game() {
    let _store = store_test_lock();
    restart_session_store();
    let harness = kernel_harness();
    let owner = player(23);
    let started = 2_000_000;
    let played = play_sudoku(&harness, "8", &owner, started, started + 80_000, 2_000);
    let payload = previewed_payload(&harness, &played, started + 95_000);

    let first = kernel_fulfill(&harness, "601", &owner.hash, &payload);
    assert_eq!(first["success"], true, "{first}");
    let bytes = result_bytes(&first);
    assert_eq!(bytes.len(), 111, "codec v2 is 111 bytes");
    assert_eq!(bytes[0], 0x03, "codec v2 tag");
    assert_eq!(
        hex_encode(&bytes[79..]),
        hex_encode(&expected_binding(SUDOKU, 8, &owner.hash)),
        "the result is bound to (appId, gameId, player)"
    );

    // A retry of the SAME kernel request is idempotent.
    let retry = kernel_fulfill(&harness, "601", &owner.hash, &payload);
    assert_eq!(retry["success"], true, "{retry}");
    assert_eq!(result_bytes(&retry), bytes);

    // Any other kernel request is refused: live, after eviction (the HMAC
    // resume record cannot rebuild it), and after a restart 30 days later.
    let second = kernel_fulfill(&harness, "602", &owner.hash, &payload);
    assert_eq!(second["success"], false, "{second}");
    assert!(second["result_bytes_base64"].is_null(), "{second}");

    evict_live_sessions();
    let rebuilt = kernel_fulfill(&harness, "603", &owner.hash, &payload);
    assert_eq!(rebuilt["success"], false, "{rebuilt}");

    restart_session_store();
    harness.oracle_io.set_now_ms(started + 30 * DAY_MS);
    let month_later = kernel_fulfill(&harness, "604", &owner.hash, &payload);
    assert_eq!(month_later["success"], false, "{month_later}");
    assert!(
        month_later["result_bytes_base64"].is_null(),
        "{month_later}"
    );
}

#[test]
fn kernel_lane_loss_is_the_shared_game_result_v2_vector() {
    let _store = store_test_lock();
    restart_session_store();
    let vectors: Json = serde_json::from_str(include_str!(
        "../../../../crates/neo-os-games/tests/vectors/game-result-v2.vectors.json"
    ))
    .expect("shared vectors");
    let loss = vectors["vectors"]
        .as_array()
        .expect("vectors")
        .iter()
        .find(|vector| vector["name"] == "session-loss-sudoku")
        .expect("session-loss-sudoku vector")
        .clone();

    let harness = kernel_harness();
    let owner = player(7);
    assert_eq!(owner.hash, loss["player"]);
    let played = play_sudoku(&harness, "1", &owner, 10_000, 51_000, 500);
    assert_eq!(played.ops.len(), 41);
    assert_eq!(
        played.last_step["replay_record"]["op_elapsed_ms"][40],
        41_000
    );

    // No preview: the last accepted op bounds the elapsed time, which is
    // under Sudoku's 90 s floor, so the kernel lane settles a LOSS.
    let mut payload = played.identity.clone();
    payload["kind"] = Json::String("miniapp.game.session.finalize.v2".into());
    payload["session_token"] = played.token.clone();
    harness.oracle_io.set_now_ms(60_000);
    let settled = kernel_fulfill(&harness, "701", &owner.hash, &payload);
    assert_eq!(settled["success"], true, "{settled}");
    assert_eq!(
        hex_encode(&result_bytes(&settled)),
        loss["result"].as_str().expect("vector result"),
        "the enclave's LOSS bytes are the shared vector the contract settles"
    );
}
