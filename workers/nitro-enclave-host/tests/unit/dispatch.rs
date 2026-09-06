//! Dispatch-level tests — the fixtures from `enclave-server.test.mjs` ported
//! to the pure core: route matching over `(method, path)`, the 404 contract,
//! the auth gate and its fail-closed message, the compute passthrough, the
//! attestation binding, the provision bootstrap and the sign shims. The state
//! is assembled from the support doubles; nothing here touches a socket.

use super::*;
use crate::RUNTIME_NAME;
use serde_json::json;

#[path = "support.rs"]
#[allow(clippy::duplicate_mod)] // intentional: one shared doubles file per test module
mod support;
use support::*;

fn plain() -> http::HeaderMap {
    let mut headers = http::HeaderMap::new();
    headers.insert(
        http::header::HOST,
        http::HeaderValue::from_static("127.0.0.1"),
    );
    headers
}

fn dispatch_outcome(
    harness: &TestState,
    method: &str,
    raw_url: &str,
    headers: &http::HeaderMap,
    body: &str,
) -> DispatchOutcome {
    dispatch(&harness.state, method, raw_url, headers, body)
}

fn error_body(message: &str) -> serde_json::Value {
    json!({ "status": "error", "error": message, "runtime": RUNTIME_NAME })
}

// ---------------------------------------------------------------------------
// Routing + 404
// ---------------------------------------------------------------------------

#[test]
fn an_unknown_route_is_a_404_naming_the_path() {
    let harness = test_state(
        &healthy_overlay(),
        FakeAttest::with_document(b"doc"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::default(),
    );
    let outcome = dispatch_outcome(&harness, "GET", "/nope", &plain(), "");
    assert_eq!(outcome.status, 404);
    assert_eq!(
        outcome.body,
        json!({ "error": "not found", "path": "/nope" })
    );
}

#[test]
fn network_prefixed_and_exact_routes_reach_the_same_handler() {
    let harness = test_state(
        &healthy_overlay(),
        FakeAttest::with_document(b"doc"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::default(),
    );
    let exact = dispatch_outcome(&harness, "GET", "/health", &plain(), "");
    let prefixed = dispatch_outcome(&harness, "GET", "/testnet/health", &plain(), "");
    assert_eq!(exact.status, 200);
    assert_eq!(prefixed.status, 200);
    assert_eq!(exact.body["runtime"], RUNTIME_NAME);
    assert_eq!(prefixed.body["network"], "testnet");
}

#[test]
fn a_two_segment_prefix_never_reaches_health_or_admin() {
    let harness = test_state(
        &healthy_overlay(),
        FakeAttest::with_document(b"doc"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::default(),
    );
    // The mjs suite's '/evil/path/health' fixture: 404, not a health read.
    let outcome = dispatch_outcome(&harness, "GET", "/evil/path/health", &plain(), "");
    assert_eq!(outcome.status, 404);
    assert_eq!(outcome.body["error"], "not found");

    // Even with a valid token, an unmatched admin path stays a 404 — and it
    // never consumed auth.
    let outcome = dispatch_outcome(
        &harness,
        "POST",
        "/mainnet/admin/wipe",
        &bearer("s3cret"),
        "",
    );
    assert_eq!(outcome.status, 404);
}

#[test]
fn a_trailing_slash_is_stripped_once_like_the_node_dispatch() {
    let harness = test_state(
        &healthy_overlay(),
        FakeAttest::with_document(b"doc"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::default(),
    );
    let outcome = dispatch_outcome(&harness, "GET", "/health/", &plain(), "");
    assert_eq!(outcome.status, 200);
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

#[test]
fn health_is_200_when_compute_and_signer_are_ready() {
    let harness = test_state(
        &healthy_overlay(),
        FakeAttest::with_document(b"doc"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::default(),
    );
    let outcome = dispatch_outcome(&harness, "GET", "/health", &plain(), "");
    assert_eq!(outcome.status, 200);
    assert_eq!(outcome.body["status"], "ok");
    assert_eq!(outcome.body["ready"], true);
    assert_eq!(outcome.body["checks"]["compute"], true);
    assert_eq!(outcome.body["checks"]["signer"], true);
    assert_eq!(outcome.body["plaintext_key_provision_allowed"], false);
    assert_eq!(outcome.body["kms_diag"], json!({ "state": "not_run" }));
}

#[test]
fn health_is_503_and_carries_the_signer_error_when_degraded() {
    let harness = test_state(
        &healthy_overlay(),
        FakeAttest::with_document(b"doc"),
        FakeSigner::unconfigured(),
        FakeBridge::new(),
        FakeKms::default(),
    );
    let outcome = dispatch_outcome(&harness, "GET", "/health", &plain(), "");
    assert_eq!(outcome.status, 503);
    assert_eq!(outcome.body["status"], "degraded");
    assert_eq!(outcome.body["ready"], false);
    assert_eq!(outcome.body["key_source"]["oracle_verifier"], "none");
}

// ---------------------------------------------------------------------------
// Auth gate + fail-closed
// ---------------------------------------------------------------------------

#[test]
fn sensitive_routes_fail_closed_without_any_configured_token() {
    let harness = test_state(
        &[],
        FakeAttest::with_document(b"doc"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::default(),
    );
    for (method, path) in [
        ("POST", "/oracle/fulfill"),
        ("POST", "/feed/sign"),
        ("POST", "/sign/payload"),
        ("POST", "/keys/derived"),
        ("POST", "/oracle/query"),
        ("POST", "/oracle/smart-fetch"),
        ("POST", "/oracle/decrypt"),
        ("POST", "/oracle/message-reveal"),
        ("POST", "/session/start"),
        ("POST", "/session/step"),
        ("POST", "/session/finalize"),
        ("POST", "/automation/execute"),
        ("POST", "/oracle/feed"),
    ] {
        let outcome = dispatch_outcome(&harness, method, path, &plain(), "{}");
        assert_eq!(outcome.status, 401, "{path}");
        assert_eq!(
            outcome.body,
            error_body("runtime authorization is not configured"),
            "{path}"
        );
    }
}

#[test]
fn sensitive_routes_require_a_matching_bearer() {
    let harness = test_state(
        &healthy_overlay(),
        FakeAttest::with_document(b"doc"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::default(),
    );
    for (method, path) in [
        ("POST", "/oracle/fulfill"),
        ("POST", "/feed/sign"),
        ("POST", "/sign/payload"),
        ("POST", "/keys/derived"),
        ("POST", "/oracle/query"),
        ("POST", "/oracle/smart-fetch"),
        ("POST", "/oracle/decrypt"),
        ("POST", "/oracle/message-reveal"),
        ("POST", "/session/start"),
        ("POST", "/session/step"),
        ("POST", "/session/finalize"),
        ("POST", "/automation/execute"),
        ("POST", "/oracle/feed"),
    ] {
        let outcome = dispatch_outcome(&harness, method, path, &plain(), "{}");
        assert_eq!(outcome.status, 401, "{path}");
        assert_eq!(outcome.body, error_body("unauthorized"), "{path}");
    }
}

// ---------------------------------------------------------------------------
// Oracle read lanes — Phase 9: in-process
// ---------------------------------------------------------------------------

#[test]
fn the_oracle_query_lane_is_served_in_process() {
    let harness = test_state(
        &healthy_overlay(),
        FakeAttest::with_document(b"doc"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::default(),
    );
    let outcome = dispatch_outcome(
        &harness,
        "POST",
        "/mainnet/oracle/query",
        &bearer("s3cret"),
        &body_json(&json!({ "url": "https://example.com/data" })),
    );
    assert_eq!(outcome.status, 200);
    // The fold's own envelope — `buildOracleResponse` — not the child's reply.
    assert_eq!(outcome.body["mode"], "fetch");
    assert_eq!(outcome.body["status_code"], 200);
    assert_eq!(outcome.body["request_source"], "chain-dispatcher");
    assert_eq!(outcome.body["result"], json!({}));
    // Nothing reached the unmigrated-fulfillment seam; the upstream went
    // through the in-process IO plane.
    assert!(harness.bridge.forwards().is_empty());
    assert_eq!(harness.oracle_io.fetches()[0].1, "https://example.com/data");
}

#[test]
fn the_oracle_public_key_route_is_ungated_and_resolves_in_process() {
    let harness = test_state(
        &healthy_overlay(),
        FakeAttest::with_document(b"doc"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::default(),
    );
    // No bearer header — the lane stays public, exactly like the Node dispatch.
    let outcome = dispatch_outcome(&harness, "GET", "/oracle/public-key", &plain(), "");
    // The harness carries no oracle key material, so the full
    // ensureOracleKeyMaterial tree runs in-process and fails closed.
    assert_eq!(outcome.status, 400);
    assert!(outcome.body["error"]
        .as_str()
        .expect("error string")
        .starts_with("oracle key material unavailable"));
    // Nothing reached the unmigrated-fulfillment seam.
    assert!(harness.bridge.forwards().is_empty());
}

// ---------------------------------------------------------------------------
// Attestation over dispatch
// ---------------------------------------------------------------------------

#[test]
fn a_get_attestation_binds_the_digest_and_echoes_the_nonce() {
    let harness = test_state(
        &healthy_overlay(),
        FakeAttest::with_document(b"doc"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::default(),
    );
    let outcome = dispatch_outcome(
        &harness,
        "GET",
        "/attestation?nonce=aabb&fulfillment_digest_hex=ccdd",
        &plain(),
        "",
    );
    assert_eq!(outcome.status, 200);
    assert_eq!(outcome.body["status"], "ok");
    assert_eq!(outcome.body["nonce"], "aabb");
    let expected = {
        use sha2::{Digest, Sha256};
        hex::encode(Sha256::digest([0xcc, 0xdd]))
    };
    assert_eq!(outcome.body["user_data_hex"], expected);
    let calls = harness.attest.calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].nonce.as_deref(), Some(&[0xaa, 0xbb][..]));
    assert_eq!(calls[0].user_data.as_ref().map(hex::encode), Some(expected));
}

#[test]
fn an_odd_nonce_is_a_400_before_anything_else() {
    let harness = test_state(
        &healthy_overlay(),
        FakeAttest::with_document(b"doc"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::default(),
    );
    let outcome = dispatch_outcome(
        &harness,
        "POST",
        "/attestation",
        &plain(),
        &body_json(&json!({ "nonce": "abc", "fulfillment_digest_hex": "zz" })),
    );
    assert_eq!(outcome.status, 400);
    assert_eq!(outcome.body, error_body("nonce must be even-length hex"));
}

// ---------------------------------------------------------------------------
// Provision over dispatch
// ---------------------------------------------------------------------------

const RUNTIME_CIPHERTEXT: &str = "runtime-token-ciphertext";
const RELEASED_TOKEN: &str = "released-runtime-token-0123456789abcdef";

fn released_envelope(version: i64, network: &str) -> Vec<u8> {
    serde_json::to_vec(&json!({
        "purpose": "neoos/nitro-runtime-auth/v1",
        "network": network,
        "version": version,
        "token": RELEASED_TOKEN,
    }))
    .expect("envelope")
}

#[test]
fn the_first_provision_bootstraps_from_the_kms_envelope() {
    let harness = test_state(
        &[
            ("AWS_ACCESS_KEY_ID", "AKID"),
            ("AWS_SECRET_ACCESS_KEY", "secret"),
        ],
        FakeAttest::with_document(b"doc"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::releasing(RUNTIME_CIPHERTEXT, released_envelope(1, "testnet")),
    );
    let outcome = dispatch_outcome(
        &harness,
        "POST",
        "/provision",
        &bearer(RELEASED_TOKEN),
        &body_json(&json!({
            "env": {
                "MORPHEUS_RUNTIME_TOKEN_KMS_CIPHERTEXT_BASE64": RUNTIME_CIPHERTEXT,
                "TD_KEY": "twelve-data-key",
            }
        })),
    );
    assert_eq!(outcome.status, 200, "{:?}", outcome.body);
    assert_eq!(outcome.body["status"], "ok");
    assert_eq!(outcome.body["runtime"], RUNTIME_NAME);
    assert_eq!(outcome.body["network"], "testnet");
    assert_eq!(outcome.body["provisioned"], true);
    // The apply loop records every whitelisted key it materialized — the
    // ciphertext included (the mjs fixture asserts its presence too).
    assert_eq!(
        outcome.body["env_keys"],
        json!(["MORPHEUS_RUNTIME_TOKEN_KMS_CIPHERTEXT_BASE64", "TD_KEY"])
    );
    assert_eq!(outcome.body["roles"].as_array().expect("roles").len(), 6);

    // The materialized token authorizes the NEXT request — the trusted set is
    // live.
    let outcome = dispatch_outcome(
        &harness,
        "POST",
        "/keys/derived",
        &bearer(RELEASED_TOKEN),
        &body_json(&json!({ "role": "updater" })),
    );
    assert_eq!(outcome.status, 200, "{:?}", outcome.body);
}

#[test]
fn the_first_provision_refuses_a_mismatched_presented_token() {
    let harness = test_state(
        &[
            ("AWS_ACCESS_KEY_ID", "AKID"),
            ("AWS_SECRET_ACCESS_KEY", "secret"),
        ],
        FakeAttest::with_document(b"doc"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::releasing(RUNTIME_CIPHERTEXT, released_envelope(1, "testnet")),
    );
    let outcome = dispatch_outcome(
        &harness,
        "POST",
        "/provision",
        &bearer("not-the-released-token-not-the-released-token"),
        &body_json(&json!({
            "env": { "MORPHEUS_RUNTIME_TOKEN_KMS_CIPHERTEXT_BASE64": RUNTIME_CIPHERTEXT }
        })),
    );
    assert_eq!(outcome.status, 401);
    assert_eq!(outcome.body, error_body("unauthorized"));
}

#[test]
fn the_first_provision_requires_the_kms_ciphertext() {
    // The mjs fixture deletes every TOKEN_ENV_KEY first: with an empty trusted
    // set the request falls through to materialization, which fails without a
    // ciphertext in the body.
    let harness = test_state(
        &[("MORPHEUS_NETWORK", "testnet")],
        FakeAttest::with_document(b"doc"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::default(),
    );
    let outcome = dispatch_outcome(
        &harness,
        "POST",
        "/provision",
        &bearer("whatever"),
        &body_json(&json!({ "env": { "TD_KEY": "x" } })),
    );
    assert_eq!(outcome.status, 401);
    assert_eq!(
        outcome.body,
        error_body("first provision requires MORPHEUS_RUNTIME_TOKEN_KMS_CIPHERTEXT_BASE64")
    );
}

// ---------------------------------------------------------------------------
// Sign shims over dispatch
// ---------------------------------------------------------------------------

#[test]
fn sign_payload_passes_the_custody_body_through() {
    let harness = test_state(
        &healthy_overlay(),
        FakeAttest::with_document(b"doc"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::default(),
    );
    let outcome = dispatch_outcome(
        &harness,
        "POST",
        "/sign/payload",
        &bearer("s3cret"),
        &body_json(&json!({ "key_role": "verifier", "data_hex": "0xCAFE" })),
    );
    assert_eq!(outcome.status, 200);
    assert_eq!(outcome.body["role"], "oracle_verifier");
    let calls = harness.signer.sign_calls();
    assert_eq!(
        calls,
        vec![(
            "testnet".to_string(),
            "oracle_verifier".to_string(),
            "cafe".to_string()
        )]
    );
}

#[test]
fn sign_payload_refuses_unknown_roles_instead_of_defaulting() {
    let harness = test_state(
        &healthy_overlay(),
        FakeAttest::with_document(b"doc"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::default(),
    );
    // The Node server silently signed this with the UPDATER key. The shim
    // refuses — that divergence is the point.
    let outcome = dispatch_outcome(
        &harness,
        "POST",
        "/sign/payload",
        &bearer("s3cret"),
        &body_json(&json!({ "key_role": "typo_role", "data_hex": "cafe" })),
    );
    assert_eq!(outcome.status, 400);
    assert_eq!(
        outcome.body["error"],
        "key_role must be one of oracle_verifier, updater, relayer, worker"
    );
    assert!(harness.signer.sign_calls().is_empty());
}

#[test]
fn sign_payload_validates_the_data_hex() {
    let harness = test_state(
        &healthy_overlay(),
        FakeAttest::with_document(b"doc"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::default(),
    );
    for data in ["", "abc", "zzzz"] {
        let outcome = dispatch_outcome(
            &harness,
            "POST",
            "/sign/payload",
            &bearer("s3cret"),
            &body_json(&json!({ "key_role": "updater", "data_hex": data })),
        );
        assert_eq!(outcome.status, 400, "{data}");
        assert_eq!(outcome.body, error_body("data_hex is required"), "{data}");
    }
}

#[test]
fn keys_derived_reports_the_identity_without_secrets() {
    let harness = test_state(
        &healthy_overlay(),
        FakeAttest::with_document(b"doc"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::default(),
    );
    let outcome = dispatch_outcome(
        &harness,
        "POST",
        "/keys/derived",
        &bearer("s3cret"),
        &body_json(&json!({ "role": "updater" })),
    );
    assert_eq!(outcome.status, 200);
    assert_eq!(outcome.body["status"], "ok");
    assert_eq!(outcome.body["role"], "updater");
    assert_eq!(
        outcome.body["derived"]["neo_n3"]["address"],
        "Nd5tGBUrXa3YylLBYbwZSp8BhRd1vcaFqm"
    );
    assert_eq!(outcome.body["neo_n3"], outcome.body["derived"]["neo_n3"]);
}

#[test]
fn an_unconfigured_signer_is_a_503_with_the_exact_message() {
    let harness = test_state(
        &healthy_overlay(),
        FakeAttest::with_document(b"doc"),
        FakeSigner::unconfigured(),
        FakeBridge::new(),
        FakeKms::default(),
    );
    let outcome = dispatch_outcome(
        &harness,
        "POST",
        "/sign/payload",
        &bearer("s3cret"),
        &body_json(&json!({ "key_role": "updater", "data_hex": "cafe" })),
    );
    assert_eq!(outcome.status, 503);
    assert_eq!(
        outcome.body,
        error_body("updater signer is not configured or does not match pinned identity")
    );
}

// ---------------------------------------------------------------------------
// Error rendering
// ---------------------------------------------------------------------------

#[test]
fn a_malformed_body_renders_through_the_catch_all_shape() {
    let harness = test_state(
        &healthy_overlay(),
        FakeAttest::with_document(b"doc"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::default(),
    );
    let outcome = dispatch_outcome(
        &harness,
        "POST",
        "/sign/payload",
        &bearer("s3cret"),
        "{not json",
    );
    assert_eq!(outcome.status, 500);
    assert_eq!(outcome.body["status"], "error");
    assert_eq!(outcome.body["runtime"], RUNTIME_NAME);
    assert!(outcome.body["error"].is_string());
}

#[test]
fn an_unparsable_url_is_a_500_not_a_panic() {
    let harness = test_state(
        &healthy_overlay(),
        FakeAttest::with_document(b"doc"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::default(),
    );
    // A URL the `url` crate refuses to join (invalid host character in base
    // comes from the header, not the path).
    let mut headers = http::HeaderMap::new();
    headers.insert(
        http::header::HOST,
        http::HeaderValue::from_static("bad host with spaces"),
    );
    let outcome = dispatch_outcome(&harness, "GET", "/health", &headers, "");
    assert_eq!(outcome.status, 500);
    assert_eq!(outcome.body["status"], "error");
}

#[test]
fn an_empty_method_is_get_and_a_whitespace_method_matches_nothing() {
    let harness = test_state(
        &healthy_overlay(),
        FakeAttest::with_document(b"doc"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::default(),
    );
    assert_eq!(
        dispatch_outcome(&harness, "", "/health", &plain(), "").status,
        200
    );
    assert_eq!(
        dispatch_outcome(&harness, "   ", "/health", &plain(), "").status,
        404
    );
}
