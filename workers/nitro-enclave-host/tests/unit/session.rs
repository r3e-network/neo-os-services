//! Rust session-route closure: all 11 engines traverse auth + dispatch, the
//! generic sequence/token contract remains fail-closed, and a successful
//! Sudoku finalize produces the exact codec plus custody envelope.

use super::*;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use p256::ecdsa::signature::hazmat::PrehashSigner;
use p256::ecdsa::SigningKey;
use serde_json::{json, Value as Json};

#[path = "support.rs"]
#[allow(clippy::duplicate_mod)]
mod support;
use support::*;

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
    let result = post(&harness, "/session/settle", &finalize);
    assert_eq!(result.status, 200, "{}", result.body);
    assert_eq!(result.body["callback_encoding"], "game_result_v1");
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
