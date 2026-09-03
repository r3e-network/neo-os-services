//! Fold-level tests for the Phase 9 oracle lanes (`src/oracle_read.rs`): the
//! overlay→env plumbing, the [`support::FakeOracleIo`] plane wiring, the lazy
//! key resolution, and the response shapes. The pure-port behavior (SSRF
//! classification, provider fallbacks, the E5 gate's on-chain checks) is
//! pinned by the morpheus-compute suites; here the fold composition is the
//! subject. The golden vectors are the same bytes the crypto suite pins.

use super::*;
use serde_json::json;

#[path = "support.rs"]
#[allow(clippy::duplicate_mod)] // intentional: one shared doubles file per test module
mod support;
use support::*;

// Harvested golden vectors (morpheus-compute crypto.rs): the recipient
// keypair and one envelope sealed to it. Production ciphertexts ride
// base64(JSON) — the crypto suite's `envelope_ciphertext` — so the sealed
// form wraps the raw envelope before any decrypt lane sees it.
const GOLDEN_PUBLIC_KEY_RAW_B64: &str = "vAB/ripK5xzT1PT+KGbSvEEPfGQoxQliNWjSFjDfuhU=";
const GOLDEN_PRIVATE_KEY_PKCS8_B64: &str =
    "MC4CAQAwBQYDK2VuBCIEIEgdmKz6RqTG40pP8SVY+7XPGOUXAIbmI4alIH3uMYZ8";
const GOLDEN_ENVELOPE_JSON: &str = r#"{"v":2,"alg":"X25519-HKDF-SHA256-AES-256-GCM","epk":"1C44axNdzHDw2XVn2U7/uPmX+BfTgq9H4CltjiCRGWQ=","iv":"SOSWOZ3iY82CUNz6","ct":"x4/R3xIpzySVd55wSZFWh1HnCh7nmtYIAEhT","tag":"OUAJuhSWkVm/A0rWJSkFHQ=="}"#;
const GOLDEN_PLAINTEXT_TOKEN: &str = "golden-vector-1";

const REVEAL_NOW_MS: u64 = 1_700_000_000_000;

/// The folds raise 400-class failures as `Err(RuntimeError)` and render
/// port-shaped (status, body) results as `Ok(DispatchOutcome)` — normalize
/// both into the dispatch pair the assertions read.
fn outcome(result: Result<DispatchOutcome, RuntimeError>) -> (u16, serde_json::Value) {
    match result {
        Ok(outcome) => (outcome.status, outcome.body),
        Err(error) => (error.status, error.body()),
    }
}

fn sealed_golden() -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(GOLDEN_ENVELOPE_JSON)
}

fn fold(overlay_pairs: &[(&str, &str)]) -> TestState {
    test_state(
        overlay_pairs,
        FakeAttest::with_document(b"doc"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::default(),
    )
}

fn golden_key_env() -> String {
    format!(
        r#"{{"algorithm":"X25519-HKDF-SHA256","public_key_raw":"{GOLDEN_PUBLIC_KEY_RAW_B64}","private_key_pkcs8":"{GOLDEN_PRIVATE_KEY_PKCS8_B64}"}}"#
    )
}

fn json_reply(status: u16, body: &str) -> morpheus_compute::transport::HttpResponse {
    morpheus_compute::transport::HttpResponse {
        status,
        headers: vec![("content-type".to_string(), "application/json".to_string())],
        body: body.as_bytes().to_vec(),
    }
}

// ---------------------------------------------------------------------------
// /oracle/public-key
// ---------------------------------------------------------------------------

#[test]
fn the_public_key_lane_serves_the_configured_material() {
    let key_env = golden_key_env();
    let harness = fold(&[("MORPHEUS_ORACLE_KEY_MATERIAL_JSON", key_env.as_str())]);
    let (status, body) = outcome(handle_oracle_public_key(&harness.state, &json!({})));
    assert_eq!(status, 200);
    assert_eq!(body["public_key"], GOLDEN_PUBLIC_KEY_RAW_B64);
    assert_eq!(body["recommended_payload_encryption"], body["algorithm"]);
    assert_eq!(
        body["supported_payload_encryption"],
        json!([body["algorithm"]])
    );
    assert!(!body["key_source"].as_str().expect("source").is_empty());
}

#[test]
fn the_public_key_lane_generates_ephemeral_material_when_gated_in() {
    let harness = fold(&[("MORPHEUS_ALLOW_EPHEMERAL_KEY", "true")]);
    let (status, body) = outcome(handle_oracle_public_key(&harness.state, &json!({})));
    assert_eq!(status, 200);
    assert_eq!(body["key_source"], "ephemeral-memory");
    assert!(!body["public_key"].as_str().expect("key").is_empty());
}

// ---------------------------------------------------------------------------
// /oracle/decrypt
// ---------------------------------------------------------------------------

#[test]
fn the_decrypt_lane_requires_a_sealed_envelope() {
    let harness = fold(&[]);
    let (status, body) = outcome(handle_oracle_decrypt(&harness.state, &json!({})));
    assert_eq!(status, 400);
    assert_eq!(body["error"], "sealed envelope required (field: envelope)");
}

#[test]
fn the_decrypt_lane_runs_the_binding_gate_in_process() {
    let harness = fold(&[]);
    let (status, body) = outcome(handle_oracle_decrypt(
        &harness.state,
        &json!({ "envelope": GOLDEN_ENVELOPE_JSON, "messageId": "1" }),
    ));
    // Binding fields present → the E5 gate → no RPC configured on the
    // harness → the gate's 503, not a plain decrypt attempt.
    assert_eq!(status, 503);
    assert_eq!(
        body["error"],
        "gated decrypt is not configured on this worker"
    );
}

#[test]
fn the_decrypt_lane_releases_the_golden_token_when_the_gate_is_opted_out() {
    let key_env = golden_key_env();
    let harness = fold(&[
        ("MORPHEUS_ORACLE_KEY_MATERIAL_JSON", key_env.as_str()),
        ("MORPHEUS_ORACLE_DECRYPT_REQUIRE_BINDING", "0"),
    ]);
    let (status, body) = outcome(handle_oracle_decrypt(
        &harness.state,
        &json!({ "envelope": sealed_golden() }),
    ));
    assert_eq!(status, 200, "{}", body);
    assert!(
        body["plaintext"]
            .to_string()
            .contains(GOLDEN_PLAINTEXT_TOKEN),
        "{}",
        body
    );
}

#[test]
fn the_decrypt_lane_fails_closed_without_any_key_material() {
    let harness = fold(&[("MORPHEUS_ORACLE_DECRYPT_REQUIRE_BINDING", "0")]);
    let (status, body) = outcome(handle_oracle_decrypt(
        &harness.state,
        &json!({ "envelope": sealed_golden() }),
    ));
    // Key resolution runs BEFORE the parse, so the failure is the tree's.
    assert_eq!(status, 400);
    assert!(
        body["error"]
            .as_str()
            .expect("error string")
            .starts_with("oracle key material unavailable"),
        "{}",
        body
    );
}

#[test]
fn production_reasserts_the_decrypt_binding_gate() {
    let harness = fold(&[
        ("NODE_ENV", "production"),
        ("MORPHEUS_ORACLE_DECRYPT_REQUIRE_BINDING", "0"),
    ]);
    let (status, body) = outcome(handle_oracle_decrypt(
        &harness.state,
        &json!({ "envelope": sealed_golden() }),
    ));
    assert_eq!(status, 400);
    assert_eq!(
        body["error"],
        "gated decrypt requires (chain, contract, messageId) binding fields"
    );
}

// ---------------------------------------------------------------------------
// /oracle/message-reveal
// ---------------------------------------------------------------------------

#[test]
fn the_reveal_lane_validates_the_message_id_and_the_fresh_signature() {
    let harness = fold(&[]);
    harness.oracle_io.set_now_ms(REVEAL_NOW_MS);

    let (status, body) = outcome(handle_oracle_message_reveal(&harness.state, &json!({})));
    assert_eq!(status, 400);
    assert_eq!(body["error"], "valid messageId required");

    let stale = json!({
        "messageId": "1",
        "signature": "0xdeadbeef",
        "issuedAt": REVEAL_NOW_MS as f64 / 1000.0 - 3600.0,
    });
    let (status, body) = outcome(handle_oracle_message_reveal(&harness.state, &stale));
    assert_eq!(status, 403);
    assert_eq!(
        body["error"],
        "reveal request expired; re-sign with a current timestamp"
    );

    let fresh = json!({
        "messageId": "1",
        "signature": "0xdeadbeef",
        "issuedAt": REVEAL_NOW_MS as f64 / 1000.0 - 60.0,
    });
    let (status, body) = outcome(handle_oracle_message_reveal(&harness.state, &fresh));
    // Fresh and signed, but the harness has no NeoX RPC configured.
    assert_eq!(status, 503);
    assert_eq!(
        body["error"],
        "recipient reveal is not configured on this worker"
    );
}

// ---------------------------------------------------------------------------
// /oracle/query + /oracle/smart-fetch
// ---------------------------------------------------------------------------

#[test]
fn the_query_lane_serves_the_full_read_with_the_signed_envelope() {
    let harness = fold(&healthy_overlay());
    harness
        .oracle_io
        .set_reply(Ok(json_reply(200, r#"{"answer":42}"#)));
    let (status, body) = outcome(handle_oracle_query(
        &harness.state,
        &json!({ "url": "https://example.com/data" }),
    ));
    assert_eq!(status, 200, "{}", body);
    assert_eq!(body["mode"], "fetch");
    assert_eq!(body["request_source"], "chain-dispatcher");
    assert_eq!(body["status_code"], 200);
    assert_eq!(body["body"], r#"{"answer":42}"#);
    assert_eq!(body["body_json"], json!({ "answer": 42 }));
    assert_eq!(body["result"], json!({ "answer": 42 }));
    assert_eq!(body["extracted_value"], json!(null));
    // The D5 envelope over the custody worker key.
    assert_eq!(body["signature"], "00");
    let output_hash = body["output_hash"].as_str().expect("hash");
    assert_eq!(output_hash.len(), 64);
    assert_eq!(body["attestation_hash"], body["output_hash"]);
    assert_eq!(body["verification"]["output_hash"], body["output_hash"]);
    // No emit gate anywhere → no attestation.
    assert_eq!(body["tee_attestation"], json!(null));
    // The upstream rode the IO plane; the child saw nothing.
    assert_eq!(harness.oracle_io.fetches()[0].1, "https://example.com/data");
    assert!(harness.bridge.forwards().is_empty());
}

#[test]
fn signed_oracle_response_fails_closed_without_worker_custody() {
    let harness = test_state(
        &healthy_overlay(),
        FakeAttest::with_document(b"doc"),
        FakeSigner::unconfigured(),
        FakeBridge::new(),
        FakeKms::default(),
    );
    harness
        .oracle_io
        .set_reply(Ok(json_reply(200, r#"{"answer":42}"#)));
    let (status, body) = outcome(handle_oracle_query(
        &harness.state,
        &json!({ "url": "https://example.com/data" }),
    ));
    assert_eq!(status, 503);
    assert!(body["error"]
        .as_str()
        .expect("error")
        .contains("worker custody key is unavailable"));
}

#[test]
fn the_smart_fetch_lane_omits_the_raw_response_fields() {
    let harness = fold(&healthy_overlay());
    harness
        .oracle_io
        .set_reply(Ok(json_reply(200, r#"{"answer":42}"#)));
    let (status, body) = outcome(handle_oracle_smart_fetch(
        &harness.state,
        &json!({ "url": "https://example.com/data" }),
    ));
    assert_eq!(status, 200, "{}", body);
    assert_eq!(body["mode"], "fetch");
    assert_eq!(body["upstream_status"], 200);
    assert_eq!(body["result"], json!({ "answer": 42 }));
    assert!(body.get("status_code").is_none());
    assert!(body.get("headers").is_none());
    assert!(body.get("body").is_none());
    assert!(body.get("body_json").is_none());
}

#[test]
fn the_query_lane_renders_typed_upstream_faults() {
    let harness = fold(&healthy_overlay());
    harness
        .oracle_io
        .set_reply(Err("connection refused".to_string()));
    let (status, body) = outcome(handle_oracle_query(
        &harness.state,
        &json!({ "url": "https://example.com/data" }),
    ));
    // The D4 gateway: the transport fault re-classified, not a thrown 400.
    assert_eq!(status, 502);
    assert_eq!(body["error"], "connection refused");
    assert_eq!(body["error_code"], "upstream_unreachable");
    assert_eq!(body["kind"], "upstream_unreachable");
}

#[test]
fn the_query_lane_fails_closed_on_private_targets() {
    let harness = fold(&healthy_overlay());
    let (status, body) = outcome(handle_oracle_query(
        &harness.state,
        &json!({ "url": "http://127.0.0.1:8090/admin" }),
    ));
    assert_eq!(status, 400);
    assert_eq!(body["error"], "private/internal URLs not allowed");
    // The IP literal is refused before any transport or DNS touch.
    assert!(harness.oracle_io.fetches().is_empty());
}

#[test]
fn the_query_lane_refuses_wasm_after_the_gates() {
    let harness = fold(&[("MORPHEUS_ENABLE_UNTRUSTED_SCRIPTS", "true")]);
    harness
        .oracle_io
        .set_reply(Ok(json_reply(200, r#"{"answer":42}"#)));
    let (status, body) = outcome(handle_oracle_query(
        &harness.state,
        &json!({
            "url": "https://example.com/data",
            "wasm_module_base64": "AGFBBQ==",
        }),
    ));
    // Opt-in and size gates run in order, THEN the deliberate refusal.
    assert_eq!(status, 400);
    assert_eq!(
        body["error"],
        morpheus_compute::standalone::WASM_DEFERRED_MESSAGE
    );
}

#[test]
fn the_query_lane_runs_the_script_in_process() {
    let harness = fold(&[("MORPHEUS_ENABLE_UNTRUSTED_SCRIPTS", "true")]);
    harness
        .oracle_io
        .set_reply(Ok(json_reply(200, r#"{"answer":42}"#)));
    let (status, body) = outcome(handle_oracle_query(
        &harness.state,
        &json!({
            "url": "https://example.com/data",
            "script":
                "function process(data, context) { return { echo: data.answer, chain: context.target_chain }; }",
        }),
    ));
    assert_eq!(status, 200, "{}", body);
    assert_eq!(body["mode"], "fetch+compute");
    assert_eq!(body["result"], json!({ "echo": 42, "chain": "neo_n3" }));
}

#[test]
fn the_query_lane_refuses_caller_signing_material() {
    let harness = fold(&healthy_overlay());
    let (status, body) = outcome(handle_oracle_query(
        &harness.state,
        &json!({
            "url": "https://example.com/data",
            "private_key": "Kwh private key material",
        }),
    ));
    // The key-confusion guard runs on the signing lane, after the compute.
    assert_eq!(status, 400);
    assert!(
        body["error"]
            .as_str()
            .expect("error string")
            .starts_with("caller-supplied signing key material"),
        "{}",
        body
    );
}

#[test]
fn the_query_lane_decrypts_the_confidential_payload_in_process() {
    let key_env = golden_key_env();
    let harness = fold(&[("MORPHEUS_ORACLE_KEY_MATERIAL_JSON", key_env.as_str())]);
    harness
        .oracle_io
        .set_reply(Ok(json_reply(200, r#"{"answer":42}"#)));
    let (status, body) = outcome(handle_oracle_query(
        &harness.state,
        &json!({
            "url": "https://example.com/data",
            "encrypted_payload": sealed_golden(),
        }),
    ));
    // The golden key decrypts the golden envelope in-process; the fetch
    // proceeds with the merged payload.
    assert_eq!(status, 200, "{}", body);
    assert_eq!(body["mode"], "fetch");
}

#[test]
fn the_confidential_payload_triggers_the_key_resolution_tree() {
    // The negative twin: the same envelope field without configured material
    // reaches the full ensureOracleKeyMaterial tree and fails closed — proof
    // the field really routes through the decrypt lane.
    let harness = fold(&[]);
    harness
        .oracle_io
        .set_reply(Ok(json_reply(200, r#"{"answer":42}"#)));
    let (status, body) = outcome(handle_oracle_query(
        &harness.state,
        &json!({
            "url": "https://example.com/data",
            "encrypted_payload": sealed_golden(),
        }),
    ));
    assert_eq!(status, 400);
    assert!(
        body["error"]
            .as_str()
            .expect("error string")
            .starts_with("oracle key material unavailable"),
        "{}",
        body
    );
    // No key, no fetch.
    assert!(harness.oracle_io.fetches().is_empty());
}
