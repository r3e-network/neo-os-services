//! `/neodid/*` fold tests — the Phase 8 flip. The ticket flows run in-process
//! (`neo-os-compute::neodid`), the digest signature and the envelope
//! signature both come from the custody `SignerPlane` (FakeSigner here), and
//! the passthrough bridge stays EMPTY: an assertion that it never recorded a
//! forward pins the in-process property. The RS256 verifier is exercised
//! against generated keys — no network in these fixtures.

use super::*;
use crate::dispatch::dispatch;
use aws_lc_rs::{
    rand::SystemRandom,
    rsa::{KeyPair, KeySize},
    signature::{KeyPair as _, RsaPublicKeyComponents, RSA_PKCS1_SHA256},
};
use serde_json::json;
use sha2::{Digest as _, Sha256};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Barrier, Mutex};
use std::time::{Duration, Instant};

#[path = "support.rs"]
#[allow(clippy::duplicate_mod)] // intentional: one shared doubles file per test module
mod support;
use support::*;

const TEST_NEODID_SALT: &str = "fixture";

fn neodid_harness(overlay: &[(&str, &str)]) -> TestState {
    test_state(
        overlay,
        FakeAttest::with_document(b"doc"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::default(),
    )
}

fn salted_overlay() -> Vec<(&'static str, &'static str)> {
    vec![
        ("MORPHEUS_NETWORK", TEST_NETWORK),
        ("NITRO_API_TOKEN", "s3cret"),
        ("NEODID_SECRET_SALT", TEST_NEODID_SALT),
        ("MORPHEUS_NEODID_ALLOW_UNVERIFIED_UID", "true"),
    ]
}

fn expected_salt() -> Vec<u8> {
    Sha256::digest(TEST_NEODID_SALT.as_bytes()).to_vec()
}

fn post(
    state: &AppState,
    route: &str,
    payload: &serde_json::Value,
) -> Result<serde_json::Value, crate::RuntimeError> {
    let outcome = dispatch(state, "POST", route, &bearer("s3cret"), &body_json(payload));
    assert_eq!(outcome.status, 200, "body: {}", outcome.body);
    Ok(outcome.body)
}

fn error_body(state: &AppState, route: &str, payload: &serde_json::Value) -> (u16, String) {
    let outcome = dispatch(state, "POST", route, &bearer("s3cret"), &body_json(payload));
    (
        outcome.status,
        outcome.body["error"]
            .as_str()
            .unwrap_or_default()
            .to_string(),
    )
}

/// Strip the envelope fields back off a fold response and hash the remaining
/// result object — the output_hash must bind EXACTLY the stableStringify of
/// the flow result plus the digest signer spread.
fn recomputed_output_hash(response: &serde_json::Value) -> String {
    let envelope_keys = [
        "mode",
        "callback_encoding",
        "output_hash",
        "attestation_hash",
        "verification",
        "tee_attestation",
    ];
    let mut result = serde_json::Map::new();
    for (key, value) in response.as_object().expect("response object") {
        if !envelope_keys.contains(&key.as_str()) {
            result.insert(key.clone(), value.clone());
        }
    }
    neo_os_core::sha256_hex(
        neo_os_compute::stable_stringify::stable_stringify(&serde_json::Value::Object(result))
            .as_bytes(),
    )
}

#[test]
fn bind_ticket_flows_in_process_with_both_custody_signatures() {
    let harness = neodid_harness(&salted_overlay());
    let response = post(
        &harness.state,
        "/neodid/bind",
        &json!({
            "provider": "twitter",
            "provider_uid": "uid-1",
            "vault_account": "0x11223344556677889900aabbccddeeff00112233",
            "callback_encoding": "base64",
        }),
    )
    .expect("bind lane executes");

    // The flow fields — the master nullifier recomputed from the salt spec.
    let master_nullifier =
        neo_os_compute::neodid::compute_master_nullifier("twitter", "uid-1", &expected_salt());
    assert_eq!(response["provider"], "twitter");
    assert_eq!(response["claim_type"], "Generic_Claim");
    assert_eq!(
        response["master_nullifier"],
        format!("0x{master_nullifier}")
    );
    assert_eq!(
        response["metadata_hash"],
        format!("0x{}", neo_os_compute::neodid::compute_metadata_hash(None))
    );
    let digest = response["digest"].as_str().expect("digest").to_string();
    assert!(
        digest.starts_with("0x") && digest.len() == 66,
        "digest: {digest}"
    );

    // The digest signer spread (signDigestBytes): FakeSigner's identity with
    // the 0x prefix added once.
    assert_eq!(response["signature"], "00");
    assert_eq!(
        response["public_key"],
        "02f8a5a1e0f3b6c9d2e5f8a1b4c7d0e3f6a9b2c5d8e1f4a7b0c3d6e9f2a5b8c1"
    );
    assert_eq!(
        response["signer_address"],
        "Nd5tGBUrXa3YylLBYbwZSp8BhRd1vcaFqm"
    );
    assert_eq!(
        response["signer_script_hash"],
        "0x5c2047b1c6b4b6e4b3a1c9d5e7f0a2b4c6d8e0f1"
    );

    // The envelope: mode first-class, callback_encoding preserved when
    // non-empty, both hashes bound to the result bytes, verification carrying
    // the envelope signature.
    assert_eq!(response["mode"], "neodid_bind");
    assert_eq!(response["callback_encoding"], "base64");
    let output_hash = response["output_hash"].as_str().expect("output_hash");
    assert_eq!(output_hash.len(), 64);
    assert_eq!(response["attestation_hash"], response["output_hash"]);
    assert_eq!(recomputed_output_hash(&response), output_hash);
    assert_eq!(
        response["verification"]["signature"], "00",
        "the envelope re-signs the result bytes (second custody call)"
    );
    assert_eq!(
        response["verification"]["output_hash"],
        response["output_hash"]
    );
    assert_eq!(
        response["verification"]["signer_script_hash"],
        "0x5c2047b1c6b4b6e4b3a1c9d5e7f0a2b4c6d8e0f1"
    );
    assert_eq!(response["tee_attestation"], serde_json::Value::Null);

    // Both custody calls rode the worker role on the payload network, and the
    // child never saw the request.
    let calls = harness.signer.sign_calls();
    assert_eq!(calls.len(), 2, "digest + envelope signatures");
    assert_eq!(calls[0].0, "testnet");
    assert_eq!(calls[0].1, "worker");
    assert_eq!(calls[0].2, &digest[2..], "the RAW digest bytes hex, no 0x");
    assert!(harness.bridge.forwards().is_empty());
}

/// A bind ticket without a network label is bound to the host's network: on a
/// MainNet host its digest carries the MainNet magic, exactly as with an
/// explicit `mainnet` label, and both custody signatures ride MainNet.
#[test]
fn bind_without_a_label_binds_the_host_network() {
    let mut overlay = salted_overlay();
    overlay.retain(|(name, _)| *name != "MORPHEUS_NETWORK");
    overlay.push(("MORPHEUS_NETWORK", "mainnet"));
    let harness = neodid_harness(&overlay);
    let payload = json!({
        "provider": "twitter",
        "provider_uid": "uid-1",
        "vault_account": "0x11223344556677889900aabbccddeeff00112233",
    });
    let response = post(&harness.state, "/neodid/bind", &payload).expect("bind lane executes");

    let env_reader = |name: &str| {
        overlay
            .iter()
            .find(|(key, _)| *key == name)
            .map(|(_, value)| (*value).to_string())
    };
    let verify = |_request: &neo_os_compute::neodid::Web3AuthVerifyRequest<'_>| -> Result<serde_json::Value, String> {
        unreachable!("web3auth verification not expected")
    };
    let derive = |_path: &str, _purpose: &str| -> Result<Vec<u8>, String> {
        unreachable!("TEE salt derivation not expected")
    };
    let io = neo_os_compute::neodid::NeoDidIo {
        env: &env_reader,
        verify_id_token: &verify,
        derive_key_bytes: &derive,
        read_aa_action_authorization: None,
    };
    let mut labelled = payload.clone();
    labelled["network"] = json!("mainnet");
    let expected = neo_os_compute::neodid::neodid_bind(&io, &labelled).expect("mainnet bind");
    assert_eq!(response["digest"], expected["digest"]);

    let calls = harness.signer.sign_calls();
    assert_eq!(calls.len(), 2, "digest + envelope signatures");
    for (network, role, _) in &calls {
        assert_eq!(network, "mainnet");
        assert_eq!(role, "worker");
    }
}

/// An explicit label must name the host's network: a digest bound to another
/// network could never match the host worker key's signature on chain, so the
/// ticket is refused before any custody call.
#[test]
fn tickets_refuse_a_label_for_another_network_before_custody() {
    for (route, payload) in [
        (
            "/neodid/bind",
            json!({
                "provider": "twitter",
                "provider_uid": "uid-1",
                "vault_account": "0x11223344556677889900aabbccddeeff00112233",
                "network": "mainnet",
            }),
        ),
        (
            "/neodid/action-ticket",
            json!({
                "provider": "twitter",
                "provider_uid": "uid-1",
                "disposable_account": "0x11223344556677889900aabbccddeeff00112233",
                "action_id": "vote-1",
                "network": "mainnet",
            }),
        ),
    ] {
        let harness = neodid_harness(&salted_overlay());
        let (status, message) = error_body(&harness.state, route, &payload);
        assert_eq!(status, 400, "{route}: {message}");
        assert_eq!(
            message, "payload network mainnet does not match the host network testnet",
            "{route}"
        );
        assert!(harness.signer.sign_calls().is_empty(), "{route}");
    }
}

#[test]
fn response_field_order_matches_the_node_handler() {
    let harness = neodid_harness(&salted_overlay());
    let response = post(
        &harness.state,
        "/neodid/bind",
        &json!({
            "provider": "twitter",
            "provider_uid": "uid-1",
            "vault_account": "0x11223344556677889900aabbccddeeff00112233",
        }),
    )
    .expect("bind lane executes");
    let keys: Vec<&str> = response
        .as_object()
        .expect("object")
        .keys()
        .map(String::as_str)
        .collect();
    // {...result(lane fields + digest + signer spread), mode,
    // callback_encoding(empty → dropped), output_hash, attestation_hash,
    // verification, tee_attestation}
    assert_eq!(
        keys,
        vec![
            "binding_mode",
            "vault_account",
            "provider",
            "claim_type",
            "claim_value",
            "claim_commitment",
            "master_nullifier",
            "metadata_hash",
            "digest",
            "commitment_digest",
            "signature",
            "public_key",
            "signer_address",
            "signer_script_hash",
            "mode",
            "output_hash",
            "attestation_hash",
            "verification",
            "tee_attestation",
        ]
    );
    assert!(response.get("callback_encoding").is_none());
}

#[test]
fn the_network_prefix_serves_the_same_fold() {
    let harness = neodid_harness(&salted_overlay());
    let response = post(
        &harness.state,
        "/testnet/neodid/bind",
        &json!({
            "provider": "twitter",
            "provider_uid": "uid-1",
            "vault_account": "0x11223344556677889900aabbccddeeff00112233",
        }),
    )
    .expect("prefixed bind lane executes");
    assert_eq!(response["mode"], "neodid_bind");
}

#[test]
fn action_ticket_returns_the_action_nullifier() {
    let harness = neodid_harness(&salted_overlay());
    let response = post(
        &harness.state,
        "/neodid/action-ticket",
        &json!({
            "provider": "twitter",
            "provider_uid": "uid-1",
            "action_id": "claim-daily",
            "disposable_account": "0xaabbccddeeff00112233445566778899aabbccdd",
        }),
    )
    .expect("action lane executes");
    assert_eq!(response["mode"], "neodid_action_ticket");
    let action_nullifier = neo_os_compute::neodid::compute_action_nullifier(
        "twitter",
        "uid-1",
        "claim-daily",
        &expected_salt(),
    );
    assert_eq!(
        response["action_nullifier"],
        format!("0x{action_nullifier}")
    );
    assert!(response["digest"]
        .as_str()
        .expect("digest")
        .starts_with("0x"));
}

#[test]
fn aa_action_v3_cannot_issue_ownerless_tickets_or_call_the_signer() {
    let mut overlay = salted_overlay();
    overlay.retain(|(name, _)| *name != "NEODID_SECRET_SALT");
    overlay.push(("NEODID_SECRET_SALT", "unit-test-salt-text"));
    let harness = neodid_harness(&overlay);
    let (status, message) = error_body(
        &harness.state,
        "/neodid/action-ticket",
        &json!({
            "provider": "twitter",
            "provider_uid": "user-42",
            "network": "neo3-testnet",
            "aa_contract": format!("0x{}", "11".repeat(20)),
            "verifier_contract": format!("0x{}", "33".repeat(20)),
            "account_id_raw": format!("0x{}", "22".repeat(20)),
            "account_id": "acct-1",
            "disposable_account": format!("0x{}", "44".repeat(20)),
            "expires_at": "1735689600",
            "session_nonce": "7",
            "callback_encoding": "neo_n3_action_v3",
        }),
    );
    assert_eq!(status, 400);
    assert_eq!(message, "AA action issuance requires action-v4 enrollment");
    assert!(harness.signer.sign_calls().is_empty());
}

#[test]
fn recovery_ticket_fails_closed_for_unverified_providers() {
    let harness = neodid_harness(&salted_overlay());
    let (status, message) = error_body(
        &harness.state,
        "/neodid/recovery-ticket",
        &json!({
            "provider": "twitter",
            "provider_uid": "uid-1",
            "aa_contract": "0x11223344556677889900aabbccddeeff00112233",
            "account_id": "acct-1",
            "new_owner": "0xaabbccddeeff00112233445566778899aabbccdd",
            "recovery_nonce": "1",
            "expires_at": "2030-01-01",
        }),
    );
    assert_eq!(status, 400);
    assert!(
        message.contains("recovery-ticket requires a TEE-verified provider_uid"),
        "message: {message}"
    );
}

fn recovery_payload(network: serde_json::Value) -> serde_json::Value {
    json!({
        "provider": "twitter",
        "provider_uid": "uid-1",
        "network": network,
        "aa_contract": "0x11223344556677889900aabbccddeeff00112233",
        "account_id_raw": "0x6666666666666666666666666666666666666666",
        "verifier_contract": "0x7777777777777777777777777777777777777777",
        "account_address": "0x4444444444444444444444444444444444444444",
        "account_id": "acct-1",
        "new_owner": "0xaabbccddeeff00112233445566778899aabbccdd",
        "recovery_nonce": "1",
        "expires_at": "2030-01-01",
    })
}

fn recovery_overlay() -> Vec<(&'static str, &'static str)> {
    let mut overlay = salted_overlay();
    overlay.push((
        "MORPHEUS_NEODID_RECOVERY_ALLOW_UNVERIFIED_PROVIDERS",
        "twitter",
    ));
    overlay
}

/// The documented recovery request names its chain family, `"network":
/// "neo_n3"`. That label is bound into the ticket and signed under the host's
/// network; it is not refused as an unknown network.
#[test]
fn recovery_ticket_chain_family_label_signs_under_the_host_network() {
    for label in [json!("neo_n3"), json!("NEO_N3")] {
        let harness = neodid_harness(&recovery_overlay());
        let response = post(
            &harness.state,
            "/neodid/recovery-ticket",
            &recovery_payload(label.clone()),
        )
        .expect("recovery lane executes");
        assert_eq!(response["network"], label);
        let calls = harness.signer.sign_calls();
        assert_eq!(calls.len(), 2, "digest + envelope signatures");
        for (network, role, _) in &calls {
            assert_eq!(network, TEST_NETWORK);
            assert_eq!(role, "worker");
        }
    }
}

#[test]
fn aa_recovery_v3_preserves_raw_network_text_under_the_host_custody_network() {
    for network in ["neo3-testnet", "neo3-local"] {
        let harness = neodid_harness(&recovery_overlay());
        let mut payload = recovery_payload(json!(network));
        payload["callback_encoding"] = json!("neo_n3_recovery_v3");
        let response = post(&harness.state, "/neodid/recovery-ticket", &payload)
            .expect("AA recovery v3 lane executes");
        assert_eq!(response["network"], network);
        assert!(response["action_id"]
            .as_str()
            .expect("action id")
            .starts_with("aa_recovery:"));
        assert_eq!(response["callback_encoding"], "neo_n3_recovery_v3");
        let calls = harness.signer.sign_calls();
        assert_eq!(calls.len(), 2);
        assert!(calls
            .iter()
            .all(|(network, role, _)| network == TEST_NETWORK && role == "worker"));
    }
}

/// A legacy recovery `network` that is neither a chain family nor a reviewed
/// network is refused before any custody call, like on every other ticket.
#[test]
fn recovery_ticket_refuses_an_unknown_network_label() {
    for label in [json!("staging"), json!(false)] {
        let harness = neodid_harness(&recovery_overlay());
        let (status, message) = error_body(
            &harness.state,
            "/neodid/recovery-ticket",
            &recovery_payload(label.clone()),
        );
        assert_eq!(status, 400, "{label}: {message}");
        assert!(
            message.contains("unsupported Neo network"),
            "{label}: {message}"
        );
        assert!(harness.signer.sign_calls().is_empty());
    }
}

#[test]
fn zklogin_route_is_folded_and_requires_a_verified_web3auth_token() {
    let harness = neodid_harness(&salted_overlay());
    let (status, message) = error_body(
        &harness.state,
        "/neodid/zklogin-ticket",
        &json!({
            "provider": "web3auth",
            "provider_uid": "user@example.com",
            "verifier_contract": "0x11223344556677889900aabbccddeeff00112233",
            "account_id_hash": "0xaabbccddeeff00112233445566778899aabbccdd",
            "target_contract": "0x00112233445566778899aabbccddeeff00112233",
            "method": "transfer",
            "args_hash": format!("0x{}", "11".repeat(32)),
            "nonce": "1",
            "deadline": "2000000000",
        }),
    );

    assert_eq!(status, 400);
    assert_eq!(message, "web3auth id_token is required");
    assert!(harness.signer.sign_calls().is_empty());
}

#[test]
fn missing_salt_renders_the_child_message() {
    let harness = neodid_harness(&[
        ("MORPHEUS_NETWORK", TEST_NETWORK),
        ("NITRO_API_TOKEN", "s3cret"),
    ]);
    let (status, message) = error_body(
        &harness.state,
        "/neodid/bind",
        &json!({
            "provider": "twitter",
            "provider_uid": "uid-1",
            "vault_account": "0x11223344556677889900aabbccddeeff00112233",
        }),
    );
    assert_eq!(status, 400);
    assert_eq!(
        message,
        "NeoDID salt unavailable: set NEODID_SECRET_SALT env var or ensure dstack is available"
    );
}

#[test]
fn production_neodid_salt_requires_the_kms_materialization_marker() {
    let mut plaintext = salted_overlay();
    plaintext.push(("NODE_ENV", "production"));
    let harness = neodid_harness(&plaintext);
    let (status, message) = error_body(
        &harness.state,
        "/neodid/bind",
        &json!({
            "provider": "twitter",
            "provider_uid": "uid-1",
            "vault_account": "0x11223344556677889900aabbccddeeff00112233",
        }),
    );
    assert_eq!(status, 503);
    assert_eq!(
        message,
        "plaintext configured NeoDID salt is forbidden in production"
    );

    let mut kms = plaintext;
    kms.push(("NEODID_SECRET_SALT_SOURCE", "nitro-recipient-kms"));
    let harness = neodid_harness(&kms);
    let response = post(
        &harness.state,
        "/neodid/bind",
        &json!({
            "provider": "twitter",
            "provider_uid": "uid-1",
            "vault_account": "0x11223344556677889900aabbccddeeff00112233",
        }),
    )
    .expect("KMS-materialized salt works in production");
    assert_eq!(response["mode"], "neodid_bind");
}

#[test]
fn neodid_signed_response_fails_closed_without_worker_custody() {
    let harness = test_state(
        &salted_overlay(),
        FakeAttest::with_document(b"doc"),
        FakeSigner::unconfigured(),
        FakeBridge::new(),
        FakeKms::default(),
    );
    let (status, message) = error_body(
        &harness.state,
        "/neodid/bind",
        &json!({
            "provider": "twitter",
            "provider_uid": "uid-1",
            "vault_account": "0x11223344556677889900aabbccddeeff00112233",
        }),
    );
    assert_eq!(status, 503);
    assert!(message.contains("worker custody key is unavailable"));
}

#[test]
fn caller_key_material_is_rejected_like_every_other_signing_lane() {
    let harness = neodid_harness(&salted_overlay());
    let (status, message) = error_body(
        &harness.state,
        "/neodid/bind",
        &json!({
            "provider": "twitter",
            "provider_uid": "uid-1",
            "vault_account": "0x11223344556677889900aabbccddeeff00112233",
            "private_key": "fixture",
        }),
    );
    assert_eq!(status, 400);
    assert!(
        message.contains("caller-supplied signing key material"),
        "message: {message}"
    );
    assert!(harness.signer.sign_calls().is_empty());
}

#[test]
fn unauthenticated_requests_are_refused_like_the_other_sensitive_routes() {
    let harness = neodid_harness(&salted_overlay());
    let outcome = dispatch(
        &harness.state,
        "POST",
        "/neodid/bind",
        &http::HeaderMap::new(),
        &body_json(&json!({})),
    );
    assert_eq!(outcome.status, 401);
}

#[test]
fn get_is_not_a_neodid_route() {
    let harness = neodid_harness(&salted_overlay());
    let outcome = dispatch(&harness.state, "GET", "/neodid/bind", &bearer("s3cret"), "");
    assert_eq!(outcome.status, 404);
}

// ---------------------------------------------------------------------------
// The RS256 verifier
// ---------------------------------------------------------------------------

struct ScriptedJwksFetcher {
    replies: Mutex<VecDeque<Result<serde_json::Value, String>>>,
    calls: AtomicUsize,
    delay: Duration,
}

impl ScriptedJwksFetcher {
    fn new(replies: Vec<Result<serde_json::Value, String>>) -> Self {
        Self {
            replies: Mutex::new(replies.into()),
            calls: AtomicUsize::new(0),
            delay: Duration::ZERO,
        }
    }

    fn delayed(replies: Vec<Result<serde_json::Value, String>>) -> Self {
        Self {
            replies: Mutex::new(replies.into()),
            calls: AtomicUsize::new(0),
            delay: Duration::from_millis(40),
        }
    }

    fn call_count(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
}

impl JwksFetcher for ScriptedJwksFetcher {
    fn fetch_jwks(&self, _url: &str) -> Result<serde_json::Value, String> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        if !self.delay.is_zero() {
            std::thread::sleep(self.delay);
        }
        self.replies
            .lock()
            .expect("JWKS replies lock")
            .pop_front()
            .unwrap_or_else(|| Err("unexpected extra JWKS fetch".to_string()))
    }
}

fn verify_web3auth_fixture(
    fetcher: &dyn JwksFetcher,
    url: &str,
    token: &str,
) -> Result<serde_json::Value, String> {
    verify_id_token_web3auth(
        fetcher,
        &Web3AuthVerifyRequest {
            id_token: token,
            jwks_url: url,
            audience: "client-id",
            issuer: None,
        },
    )
}

fn age_cached_jwks(url: &str) {
    let mut entries = jwks_cache().entries.lock().expect("JWKS cache lock");
    let snapshot = entries
        .get_mut(url)
        .and_then(|entry| entry.cached.as_mut())
        .expect("the test primed this JWKS URL");
    snapshot.fetched_at = Instant::now()
        .checked_sub(JWKS_REFRESH_COOLDOWN + Duration::from_secs(1))
        .expect("representable test instant");
}

struct KeyFixture {
    jwks: serde_json::Value,
    token: String,
}

fn signed_token(claims: &serde_json::Value, kid: &str) -> KeyFixture {
    let (jwks, token) = build_token(claims, Some(kid));
    KeyFixture { jwks, token }
}

/// Builds a token+JWKS pair from a fresh RSA key; `kid: None` omits the kid
/// from BOTH the header and the JWK — jose's fallback that verifies against
/// every eligible candidate key.
fn build_token(claims: &serde_json::Value, kid: Option<&str>) -> (serde_json::Value, String) {
    let signing_key = KeyPair::generate(KeySize::Rsa2048).expect("keygen");
    let public_key: RsaPublicKeyComponents<Vec<u8>> = signing_key.public_key().into();
    let mut jwk = json!({
        "kty": "RSA",
        "use": "sig",
        "alg": "RS256",
        "n": URL_SAFE_NO_PAD.encode(public_key.n),
        "e": URL_SAFE_NO_PAD.encode(public_key.e),
    });
    if let Some(kid) = kid {
        jwk["kid"] = json!(kid);
    }
    let mut header = json!({ "alg": "RS256", "typ": "JWT" });
    if let Some(kid) = kid {
        header["kid"] = json!(kid);
    }
    let encode = |value: &serde_json::Value| {
        URL_SAFE_NO_PAD.encode(serde_json::to_string(value).expect("json").as_bytes())
    };
    let signing_input = format!("{}.{}", encode(&header), encode(claims));
    let mut signature = vec![0u8; signing_key.public_modulus_len()];
    signing_key
        .sign(
            &RSA_PKCS1_SHA256,
            &SystemRandom::new(),
            signing_input.as_bytes(),
            &mut signature,
        )
        .expect("sign");
    (
        json!({ "keys": [jwk] }),
        format!("{signing_input}.{}", URL_SAFE_NO_PAD.encode(signature)),
    )
}

fn base_claims() -> serde_json::Value {
    json!({
        "sub": "user-1",
        "email": "user@example.com",
        "verifier": "google",
        "verifierId": "user@example.com",
        "aud": "client-id",
        "iss": "https://issuer.example.com",
        "exp": chrono_now() + 3600,
        "iat": chrono_now(),
    })
}

fn chrono_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_secs()
}

#[test]
fn a_valid_id_token_verifies_and_returns_its_claims() {
    let fixture = signed_token(&base_claims(), "k1");
    let claims = verify_rs256_token(&fixture.token, &fixture.jwks, "client-id", None)
        .expect("token verifies");
    assert_eq!(claims["sub"], "user-1");
}

#[test]
fn rs256_accepts_legacy_1024_bit_jwk_vectors() {
    // Web3Auth/JWKS deployments can still publish a 1024-bit RSA key. This
    // compatibility vector is public-only; the signing key is never stored.
    let jwks = json!({
        "keys": [{
            "kty": "RSA",
            "n": "s7xoDMsIJN8THAuJ4XkgnrkfXvwPygGN1a_t7l5QboyvgW1VFIKXTKh0CpEwuhKMsPhId5xugDTIVLJ9nPvbPw0E0pym7YAnmJAlc4-FeNPCF5oIrLvdtfyHmhMxNoTMoPy31webqzOOTgOqf_uRDbfgfqioxOnj5nbXb0NQ59k",
            "e": "AQAB",
            "use": "sig",
            "alg": "RS256",
            "kid": "legacy-1024"
        }]
    });
    let token = [
        "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6ImxlZ2FjeS0xMDI0In0",
        "eyJzdWIiOiJsZWdhY3ktdXNlciIsImF1ZCI6ImNsaWVudC1pZCIsImlzcyI6Imh0dHBzOi8vaXNzdWVyLmV4YW1wbGUuY29tIiwiZXhwIjo0MTAyNDQ0ODAwLCJpYXQiOjE3MDAwMDAwMDB9",
        "cxjLfuE63jpi9h5IANByDmVIA39RR4N93UDj23jmGy6oEhUhLJ0EIRn99u2Q--qtEvS9O1PkpLadzre-Vji-GOgsKRJDK3yD1Sfqz92jhXs_jJBIlNwJZnBKOAC4yPax6vCm2uVf04qiQO_yVqRKr61ccza21Sd26zlFkSwhkFs",
    ].join(".");
    let claims = verify_rs256_token(
        &token,
        &jwks,
        "client-id",
        Some("https://issuer.example.com"),
    )
    .expect("1024-bit legacy RS256 vector verifies");
    assert_eq!(claims["sub"], "legacy-user");
}

#[test]
fn the_issuer_pin_is_enforced_only_when_configured() {
    let fixture = signed_token(&base_claims(), "k1");
    let claims = verify_rs256_token(
        &fixture.token,
        &fixture.jwks,
        "client-id",
        Some("https://issuer.example.com"),
    )
    .expect("issuer matches");
    assert_eq!(claims["verifier"], "google");
    let error = verify_rs256_token(
        &fixture.token,
        &fixture.jwks,
        "client-id",
        Some("https://other.example.com"),
    )
    .expect_err("issuer mismatch");
    assert_eq!(error, "\"iss\" claim value check failed");
}

#[test]
fn a_foreign_audience_is_refused() {
    let fixture = signed_token(&base_claims(), "k1");
    let error = verify_rs256_token(&fixture.token, &fixture.jwks, "attacker-client", None)
        .expect_err("aud");
    assert_eq!(error, "\"aud\" claim value check failed");
}

#[test]
fn an_expired_token_is_refused() {
    let mut claims = base_claims();
    claims["exp"] = json!(chrono_now() - 10);
    let fixture = signed_token(&claims, "k1");
    let error =
        verify_rs256_token(&fixture.token, &fixture.jwks, "client-id", None).expect_err("expired");
    assert_eq!(error, "\"exp\" claim timestamp check failed");
}

#[test]
fn an_unsigned_alg_is_refused_before_any_key_lookup() {
    let claims = base_claims();
    let encode = |value: &serde_json::Value| {
        URL_SAFE_NO_PAD.encode(serde_json::to_string(value).expect("json").as_bytes())
    };
    let token = format!(
        "{}.{}.{}",
        encode(&json!({ "alg": "none" })),
        encode(&claims),
        ""
    );
    let error = verify_rs256_token(&token, &json!({ "keys": [] }), "client-id", None)
        .expect_err("alg none");
    assert!(error.contains("alg"), "message: {error}");
}

#[test]
fn a_token_with_an_unknown_kid_is_the_jwks_no_matching_key_error() {
    // The token pins kid "k1" while this concrete JWKS only carries "k2".
    // The remote wrapper decides whether its refresh cooldown permits another
    // fetch; the pure verifier surfaces JWKSNoMatchingKey's exact message,
    // rather than turning a missing key into a signature error.
    let fixture = signed_token(&base_claims(), "k1");
    let other = signed_token(&base_claims(), "k2");
    let error = verify_rs256_token(&fixture.token, &other.jwks, "client-id", None)
        .expect_err("foreign kid");
    assert_eq!(error, "no applicable key found in the JSON Web Key Set");
}

#[test]
fn a_kidless_token_is_verified_against_every_candidate_key() {
    // No kid: jose attempts every eligible JWKS key and only fails when none
    // verifies — the JWS message, not the JWKS-lookup one.
    let (jwks, token) = build_token(&base_claims(), None);
    let claims = verify_rs256_token(&token, &jwks, "client-id", None).expect("kidless verifies");
    assert_eq!(claims["sub"], "user-1");

    let (_, foreign_token) = build_token(&base_claims(), None);
    let error = verify_rs256_token(&foreign_token, &jwks, "client-id", None)
        .expect_err("signature from another key");
    assert_eq!(error, "signature verification failed");
}

#[test]
fn unknown_kid_refreshes_once_and_caches_the_rotated_set() {
    let current = signed_token(&base_claims(), "rotation-kid");
    let stale = signed_token(&base_claims(), "stale-kid");
    let fetcher = ScriptedJwksFetcher::new(vec![Ok(stale.jwks), Ok(current.jwks)]);
    let url = "https://jwks.example.test/rotation";

    fetch_jwks(&fetcher, url).expect("prime stale cache");
    age_cached_jwks(url);

    let claims = verify_web3auth_fixture(&fetcher, url, &current.token)
        .expect("unknown kid should verify after one refresh");
    assert_eq!(claims["sub"], "user-1");
    assert_eq!(fetcher.call_count(), 2);

    verify_web3auth_fixture(&fetcher, url, &current.token).expect("rotated set should be cached");
    assert_eq!(
        fetcher.call_count(),
        2,
        "cached rotation must avoid refetch"
    );
}

#[test]
fn a_fresh_unknown_kid_does_not_cause_repeated_outbound_refreshes() {
    let current = signed_token(&base_claims(), "missing-fresh-kid");
    let stale = signed_token(&base_claims(), "fresh-set-kid");
    let fetcher = ScriptedJwksFetcher::new(vec![Ok(stale.jwks)]);
    let url = "https://jwks.example.test/fresh-unknown-kid";

    for _ in 0..2 {
        let error = verify_web3auth_fixture(&fetcher, url, &current.token)
            .expect_err("the fresh set does not contain the requested key");
        assert_eq!(error, JWKS_NO_MATCHING_KEY);
    }
    assert_eq!(
        fetcher.call_count(),
        1,
        "a cold load and repeated unknown kid must share the fresh endpoint answer"
    );
}

#[test]
fn bad_signature_does_not_refresh_jwks() {
    let trusted = signed_token(&base_claims(), "same-kid");
    let attacker = signed_token(&base_claims(), "same-kid");
    let fetcher = ScriptedJwksFetcher::new(vec![Ok(trusted.jwks)]);

    let error = verify_web3auth_fixture(
        &fetcher,
        "https://jwks.example.test/bad-signature",
        &attacker.token,
    )
    .expect_err("foreign signature must fail");
    assert_eq!(error, "signature verification failed");
    assert_eq!(
        fetcher.call_count(),
        1,
        "signature failure must not refresh"
    );
}

#[test]
fn invalid_claims_do_not_refresh_jwks() {
    let mut claims = base_claims();
    claims["aud"] = json!("another-client");
    let invalid = signed_token(&claims, "claim-kid");
    let fetcher = ScriptedJwksFetcher::new(vec![Ok(invalid.jwks)]);

    let error = verify_web3auth_fixture(
        &fetcher,
        "https://jwks.example.test/invalid-claim",
        &invalid.token,
    )
    .expect_err("invalid claim must fail");
    assert_eq!(error, "\"aud\" claim value check failed");
    assert_eq!(fetcher.call_count(), 1, "claim failure must not refresh");
}

#[test]
fn failed_rotation_is_fail_closed_and_cooled_down() {
    let current = signed_token(&base_claims(), "missing-kid");
    let stale = signed_token(&base_claims(), "old-kid");
    let fetcher = ScriptedJwksFetcher::new(vec![
        Ok(stale.jwks),
        Err("JWKS refresh unavailable".to_string()),
    ]);
    let url = "https://jwks.example.test/failed-rotation";

    fetch_jwks(&fetcher, url).expect("prime stale cache");
    age_cached_jwks(url);

    let error = verify_web3auth_fixture(&fetcher, url, &current.token)
        .expect_err("failed rotation must fail closed");
    assert_eq!(error, "JWKS refresh unavailable");
    assert_eq!(fetcher.call_count(), 2);

    let repeated = verify_web3auth_fixture(&fetcher, url, &current.token)
        .expect_err("cooldown must keep the failure closed");
    assert_eq!(repeated, "JWKS refresh unavailable");
    assert_eq!(
        fetcher.call_count(),
        2,
        "failure cooldown must suppress storms"
    );
}

#[test]
fn concurrent_unknown_kid_requests_share_one_refresh() {
    let current = signed_token(&base_claims(), "concurrent-kid");
    let stale = signed_token(&base_claims(), "concurrent-old-kid");
    let fetcher = Arc::new(ScriptedJwksFetcher::delayed(vec![
        Ok(stale.jwks),
        Ok(current.jwks),
    ]));
    let url = "https://jwks.example.test/concurrent-rotation";
    fetch_jwks(fetcher.as_ref(), url).expect("prime stale cache");
    age_cached_jwks(url);

    let threads = 8;
    let barrier = Arc::new(Barrier::new(threads));
    let mut joins = Vec::new();
    for _ in 0..threads {
        let fetcher = fetcher.clone();
        let barrier = barrier.clone();
        let token = current.token.clone();
        joins.push(std::thread::spawn(move || {
            barrier.wait();
            verify_web3auth_fixture(fetcher.as_ref(), url, &token)
        }));
    }
    for join in joins {
        let claims = join
            .join()
            .expect("verification thread")
            .expect("rotated key");
        assert_eq!(claims["sub"], "user-1");
    }
    assert_eq!(
        fetcher.call_count(),
        2,
        "initial load plus exactly one shared forced refresh"
    );
}

/// Finite-domain differential check against the real RS256 entry point.
/// Signing uses one ephemeral test key, never custody or network I/O. The
/// acceptance table is independent of verifier helpers. This does not model
/// revocation, JWKS refresh, precise clock boundaries or arbitrary claim JSON.
#[test]
fn rs256_acceptance_domain_model() {
    let signing_key = KeyPair::generate(KeySize::Rsa2048).expect("test keygen");
    let public_key: RsaPublicKeyComponents<Vec<u8>> = signing_key.public_key().into();
    let jwks = json!({"keys": [{
        "kty": "RSA", "use": "sig", "alg": "RS256", "kid": "model-test-key",
        "n": URL_SAFE_NO_PAD.encode(public_key.n),
        "e": URL_SAFE_NO_PAD.encode(public_key.e),
    }]});
    let encode = |value: &serde_json::Value| {
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(value).expect("fixture json"))
    };
    let now = chrono_now();
    let mut checked = 0;
    let mut accepted = 0;
    for expiration in 0..3 {
        for audience in 0..3 {
            for algorithm_ok in [false, true] {
                let mut claims = json!({"sub": "test-subject", "iss": "test-issuer",
                    "aud": match audience {
                        0 => json!("wrong-client"),
                        1 => json!("test-client"),
                        _ => json!(["other-client", "test-client"]),
                    },
                    "nbf": now - 3600, "iat": now - 3600});
                // Document existing policy: absent exp is allowed by this layer.
                if expiration != 2 {
                    claims["exp"] = json!(if expiration == 0 {
                        now - 3600
                    } else {
                        now + 3600
                    });
                }
                let header = json!({"alg": if algorithm_ok { "RS256" } else { "HS256" },
                    "kid": "model-test-key"});
                let signing_input = format!("{}.{}", encode(&header), encode(&claims));
                let mut signature = vec![0u8; signing_key.public_modulus_len()];
                signing_key
                    .sign(
                        &RSA_PKCS1_SHA256,
                        &SystemRandom::new(),
                        signing_input.as_bytes(),
                        &mut signature,
                    )
                    .expect("sign");
                for signature_ok in [false, true] {
                    let mut bytes = signature.clone();
                    if !signature_ok {
                        bytes[0] ^= 1;
                    }
                    let token = format!("{signing_input}.{}", URL_SAFE_NO_PAD.encode(bytes));
                    for issuer_ok in [false, true] {
                        for key_present in [false, true] {
                            let empty_keys = json!({"keys": []});
                            let result = verify_rs256_token(
                                &token,
                                if key_present { &jwks } else { &empty_keys },
                                "test-client",
                                Some(if issuer_ok {
                                    "test-issuer"
                                } else {
                                    "other-issuer"
                                }),
                            );
                            let expected = expiration != 0
                                && audience != 0
                                && algorithm_ok
                                && signature_ok
                                && issuer_ok
                                && key_present;
                            assert_eq!(result.is_ok(), expected,
                                "expiration={expiration} audience={audience} alg={algorithm_ok} sig={signature_ok} issuer={issuer_ok} key={key_present}: {result:?}");
                            if expected {
                                assert_eq!(result.unwrap(), claims);
                                accepted += 1;
                            }
                            checked += 1;
                        }
                    }
                }
            }
        }
    }
    assert_eq!((checked, accepted, checked - accepted), (144, 4, 140));
    println!(
        "rs256_acceptance_domain_model: checked={checked} accepted={accepted} rejected={}",
        checked - accepted
    );
}

#[test]
fn timestamp_claim_exact_second_boundaries_and_malformed_values() {
    // (claim name, "is this claim value a rejection at `now`?", acceptance at
    // offsets -1/0/+1 second) — named so the table type stays readable.
    type ClaimPolicy = (&'static str, fn(u64, u64) -> bool, [bool; 3]);

    let now = 1_800_000_000_u64;
    let policies: [ClaimPolicy; 3] = [
        ("exp", |at, now| now >= at, [false, false, true]),
        ("nbf", |at, now| now < at, [true, true, false]),
        ("iat", |at, now| now < at, [true, true, false]),
    ];
    for (claim, rejects, expected) in policies {
        for (offset, accepted) in expected.into_iter().enumerate() {
            let mut claims = json!({});
            claims[claim] = json!(now - 1 + offset as u64);
            assert_eq!(
                check_timestamp_claim(&claims, claim, rejects, now).is_ok(),
                accepted,
                "{claim} offset {offset}"
            );
        }
        for value in [
            json!(null),
            json!("1800000000"),
            json!(-1),
            json!(1.5),
            json!(true),
            json!([]),
            json!({}),
        ] {
            let mut claims = json!({});
            claims[claim] = value;
            assert!(
                check_timestamp_claim(&claims, claim, rejects, now).is_err(),
                "{claim}: {claims}"
            );
        }
    }
}

// Invoke the real adapter directly: an outer dispatcher cannot substitute for
// the mandatory admission after confidential resolution inside the adapter.
fn selected_context_ticket(
    state: &AppState,
    recovery: bool,
    payload: &serde_json::Value,
) -> Result<serde_json::Value, RuntimeError> {
    if recovery {
        handle_neo_did_recovery_ticket(state, payload)
    } else {
        handle_neo_did_bind(state, payload)
    }
}

fn selected_context_payload(network: &str, recovery: bool) -> serde_json::Value {
    if recovery {
        let mut payload = recovery_payload(json!("neo_n3"));
        payload["morpheus_network"] = json!(network);
        payload
    } else {
        json!({
            "provider": "twitter", "provider_uid": "uid-1",
            "vault_account": "0x11223344556677889900aabbccddeeff00112233",
            "network": network,
        })
    }
}

#[test]
fn selected_context_rejects_shadowed_foreign_aliases_before_custody() {
    for (network, foreign) in [("testnet", "mainnet"), ("mainnet", "testnet")] {
        for recovery in [false, true] {
            for alias in ["morpheus_network", "runtime_network", "environment"] {
                // Recovery's highest-priority deployment assertion is kept
                // valid so each lower-priority alias is tested independently.
                if recovery && alias == "morpheus_network" {
                    continue;
                }
                let mut overlay = recovery_overlay();
                overlay.retain(|(name, _)| *name != "MORPHEUS_NETWORK");
                overlay.push(("MORPHEUS_NETWORK", network));
                let harness = neodid_harness(&overlay);
                let mut payload = selected_context_payload(network, recovery);
                payload[alias] = json!(foreign);
                let result = selected_context_ticket(&harness.state, recovery, &payload);
                let error = result.expect_err("foreign deployment alias must be refused");
                assert_eq!(error.status, 400, "{alias}: {error:?}");
                assert_eq!(
                    error.message,
                    format!("payload network {foreign} does not match the host network {network}")
                );
                assert!(
                    harness.signer.sign_calls().is_empty(),
                    "foreign alias reached custody"
                );
            }
        }
    }
}

#[test]
fn selected_context_rejects_malformed_shadowed_aliases_before_custody() {
    for recovery in [false, true] {
        for alias in ["runtime_network", "environment"] {
            for invalid in [
                json!(null),
                json!(""),
                json!(" "),
                json!(false),
                json!(0),
                json!([]),
                json!({}),
            ] {
                let harness = neodid_harness(&recovery_overlay());
                let mut payload = selected_context_payload(TEST_NETWORK, recovery);
                payload[alias] = invalid;
                let result = selected_context_ticket(&harness.state, recovery, &payload);
                let error = result.expect_err("malformed deployment alias must be refused");
                assert_eq!(error.status, 400, "{alias}: {error:?}");
                assert!(error.message.contains("network"), "{error:?}");
                assert!(
                    harness.signer.sign_calls().is_empty(),
                    "malformed alias reached custody"
                );
            }
        }
    }
}

#[test]
fn selected_context_agreeing_aliases_preserve_both_networks_and_recovery_family() {
    for network in ["testnet", "mainnet"] {
        for recovery in [false, true] {
            let mut overlay = recovery_overlay();
            overlay.retain(|(name, _)| *name != "MORPHEUS_NETWORK");
            overlay.push(("MORPHEUS_NETWORK", network));
            let harness = neodid_harness(&overlay);
            let mut payload = selected_context_payload(network, recovery);
            for alias in ["morpheus_network", "runtime_network", "environment"] {
                payload[alias] = json!(network);
            }
            selected_context_ticket(&harness.state, recovery, &payload).expect("matching aliases");
            let calls = harness.signer.sign_calls();
            assert_eq!(calls.len(), 2);
            assert!(calls
                .iter()
                .all(|call| call.0 == network && call.1 == "worker"));
            if recovery {
                payload["network"] = json!("neox");
                let response = selected_context_ticket(&harness.state, true, &payload)
                    .expect("NeoX recovery retains its chain family");
                assert_eq!(response["network"], "neox");
                let calls = harness.signer.sign_calls();
                assert_eq!(calls.len(), 4);
                assert!(calls.iter().all(|call| call.0 == network));
            }
        }
    }
}

#[test]
fn selected_context_omitted_labels_use_host_and_invalid_host_fails_closed() {
    for network in ["testnet", "mainnet", "staging"] {
        let mut overlay = salted_overlay();
        overlay.retain(|(name, _)| *name != "MORPHEUS_NETWORK");
        overlay.push(("MORPHEUS_NETWORK", network));
        let harness = neodid_harness(&overlay);
        let mut payload = selected_context_payload(network, false);
        payload.as_object_mut().unwrap().remove("network");
        let response = handle_neo_did_bind(&harness.state, &payload);
        if network == "staging" {
            assert_eq!(response.unwrap_err().status, 503);
            assert!(harness.signer.sign_calls().is_empty());
        } else {
            response.expect("omitted labels retain the selected context");
            let calls = harness.signer.sign_calls();
            assert_eq!(calls.len(), 2);
            assert!(calls.iter().all(|call| call.0 == network));
        }
    }
}

// Independent caller-side AWS-LC sealing of a public-key response.
fn seal_to_public_key(recipient_public_key_b64: &str, plaintext: &str) -> String {
    use aws_lc_rs::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM};
    use aws_lc_rs::agreement::{agree_ephemeral, EphemeralPrivateKey, UnparsedPublicKey, X25519};
    use aws_lc_rs::rand::{SecureRandom as _, SystemRandom};
    use base64::Engine as _;
    use hkdf::Hkdf;
    use neo_os_compute::oracle::crypto::{
        AES_GCM_IV_LENGTH_BYTES, AES_GCM_TAG_LENGTH_BYTES, ORACLE_ENVELOPE_ALGORITHM,
        ORACLE_ENVELOPE_INFO, ORACLE_ENVELOPE_VERSION,
    };
    use sha2::Sha256;

    let engine = base64::engine::general_purpose::STANDARD;
    let recipient_public = engine
        .decode(recipient_public_key_b64)
        .expect("the advertised public key is base64");
    assert_eq!(
        recipient_public.len(),
        32,
        "an X25519 public key is 32 bytes"
    );

    let rng = SystemRandom::new();
    let sender_private = EphemeralPrivateKey::generate(&X25519, &rng).expect("sender key");
    let sender_public = sender_private
        .compute_public_key()
        .expect("sender public key")
        .as_ref()
        .to_vec();

    let mut aes_key = [0u8; 32];
    agree_ephemeral(
        sender_private,
        UnparsedPublicKey::new(&X25519, recipient_public.as_slice()),
        aws_lc_rs::error::Unspecified,
        |shared| {
            let mut info = Vec::with_capacity(ORACLE_ENVELOPE_INFO.len() + 64);
            info.extend_from_slice(ORACLE_ENVELOPE_INFO);
            info.extend_from_slice(&sender_public);
            info.extend_from_slice(&recipient_public);
            Hkdf::<Sha256>::new(Some(recipient_public.as_slice()), shared)
                .expand(&info, &mut aes_key)
                .map_err(|_| aws_lc_rs::error::Unspecified)
        },
    )
    .expect("x25519 agreement");

    let mut iv = [0u8; AES_GCM_IV_LENGTH_BYTES];
    rng.fill(&mut iv).expect("envelope nonce");

    let sealing =
        LessSafeKey::new(UnboundKey::new(&AES_256_GCM, &aes_key).expect("aes-256-gcm key"));
    let mut in_out = plaintext.as_bytes().to_vec();
    sealing
        .seal_in_place_append_tag(Nonce::assume_unique_for_key(iv), Aad::empty(), &mut in_out)
        .expect("seal");
    let tag = in_out.split_off(in_out.len() - AES_GCM_TAG_LENGTH_BYTES);

    engine.encode(
        json!({
            "v": ORACLE_ENVELOPE_VERSION,
            "alg": ORACLE_ENVELOPE_ALGORITHM,
            "epk": engine.encode(&sender_public),
            "iv": engine.encode(iv),
            "ct": engine.encode(&in_out),
            "tag": engine.encode(&tag),
        })
        .to_string(),
    )
}

#[test]
fn selected_context_confidential_uses_advertised_key_and_checks_decrypted_aliases() {
    for (network, foreign) in [("testnet", "mainnet"), ("mainnet", "testnet")] {
        let mut overlay = recovery_overlay();
        overlay.retain(|(name, _)| *name != "MORPHEUS_NETWORK");
        overlay.push(("MORPHEUS_NETWORK", network));
        overlay.push(("MORPHEUS_ALLOW_EPHEMERAL_KEY", "true"));
        let harness = neodid_harness(&overlay);
        let public =
            crate::oracle_read::handle_oracle_public_key(&harness.state, &json!({})).unwrap();
        let public_key = public.body["public_key"].as_str().unwrap();
        for recovery in [false, true] {
            let mut plain = selected_context_payload(network, recovery);
            plain["environment"] = json!(network);
            let envelope =
                json!({"encrypted_params": seal_to_public_key(public_key, &plain.to_string())});
            let before = harness.signer.sign_calls().len();
            selected_context_ticket(&harness.state, recovery, &envelope)
                .expect("advertised key decrypts");
            assert_eq!(harness.signer.sign_calls().len(), before + 2);
            plain["environment"] = json!(foreign);
            let crossed = json!({"network": network, "encrypted_params": seal_to_public_key(public_key, &plain.to_string())});
            let error = selected_context_ticket(&harness.state, recovery, &crossed)
                .expect_err("decrypted alias must not switch contexts");
            assert_eq!(error.status, 400);
            assert_eq!(
                error.message,
                format!("payload network {foreign} does not match the host network {network}")
            );
            assert_eq!(harness.signer.sign_calls().len(), before + 2);
            // The legacy network resolver treats null/empty aliases as
            // absent. Only the post-decryption assertion rejects these.
            for invalid in [json!(null), json!("")] {
                plain["environment"] = invalid;
                let malformed = json!({"network": network, "encrypted_params": seal_to_public_key(public_key, &plain.to_string())});
                let error = selected_context_ticket(&harness.state, recovery, &malformed)
                    .expect_err("decrypted malformed alias must be refused");
                assert_eq!(error.status, 400);
                assert!(error.message.contains("network"));
                assert_eq!(harness.signer.sign_calls().len(), before + 2);
            }
        }
        let again =
            crate::oracle_read::handle_oracle_public_key(&harness.state, &json!({})).unwrap();
        assert_eq!(again.body["public_key"], public.body["public_key"]);
        let other = neodid_harness(&overlay);
        let envelope = json!({"encrypted_params": seal_to_public_key(public_key, &selected_context_payload(network, false).to_string())});
        assert!(
            handle_neo_did_bind(&other.state, &envelope).is_err(),
            "another state cannot decrypt this state's envelope"
        );
        assert!(other.signer.sign_calls().is_empty());
    }
}

#[test]
fn selected_context_confidential_never_enables_a_production_key_fallback() {
    let mut overlay = salted_overlay();
    overlay.extend([
        ("NODE_ENV", "production"),
        ("NEODID_SECRET_SALT_SOURCE", "nitro-recipient-kms"),
        ("MORPHEUS_ALLOW_EPHEMERAL_KEY", "true"),
    ]);
    let harness = neodid_harness(&overlay);
    let error = handle_neo_did_bind(
        &harness.state,
        &json!({"encrypted_params": "not-an-envelope"}),
    )
    .unwrap_err();
    assert_eq!(error.status, 400);
    assert!(error
        .message
        .contains("MORPHEUS_ALLOW_EPHEMERAL_KEY is not allowed"));
    assert!(harness.signer.sign_calls().is_empty());
}

struct AdmissionProbeJwks(Arc<AtomicUsize>);
impl JwksFetcher for AdmissionProbeJwks {
    fn fetch_jwks(&self, _: &str) -> Result<serde_json::Value, String> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Err("admission provider probe".to_string())
    }
}

#[test]
fn selected_context_rejects_before_provider_verification_on_every_ticket_route() {
    check_provider_admission("selected-context");
}

fn check_provider_admission(namespace: &str) {
    type Handler = fn(&AppState, &serde_json::Value) -> Result<serde_json::Value, RuntimeError>;
    let (_, token) = build_token(&base_claims(), Some("admission-probe"));
    for (mode, handler) in [
        ("bind", handle_neo_did_bind as Handler),
        ("action-ticket", handle_neo_did_action_ticket as Handler),
        ("recovery-ticket", handle_neo_did_recovery_ticket as Handler),
        ("zklogin-ticket", handle_neo_did_zklogin_ticket as Handler),
    ] {
        let url = format!("https://admission.example.test/{namespace}/{mode}");
        let mut overlay = salted_overlay();
        overlay.extend([
            ("WEB3AUTH_CLIENT_ID", "client-id"),
            ("WEB3AUTH_JWKS_URL", url.as_str()),
        ]);
        let mut harness = neodid_harness(&overlay);
        let calls = Arc::new(AtomicUsize::new(0));
        harness.state.jwks_fetcher = Box::new(AdmissionProbeJwks(Arc::clone(&calls)));
        let mut payload = json!({"provider": "web3auth", "id_token": token, "network": TEST_NETWORK, "environment": "mainnet"});
        let error = handler(&harness.state, &payload).unwrap_err();
        assert_eq!(error.status, 400);
        assert_eq!(
            error.message,
            "payload network mainnet does not match the host network testnet"
        );
        assert_eq!(
            calls.load(Ordering::SeqCst),
            0,
            "{mode} reached provider before network admission"
        );
        assert!(harness.signer.sign_calls().is_empty());
        for invalid in [json!(null), json!("")] {
            payload["environment"] = invalid;
            let error = handler(&harness.state, &payload).unwrap_err();
            assert_eq!(error.status, 400);
            assert!(error.message.contains("network"));
            assert_eq!(calls.load(Ordering::SeqCst), 0);
            assert!(harness.signer.sign_calls().is_empty());
        }
        payload["environment"] = json!(TEST_NETWORK);
        let error = handler(&harness.state, &payload).unwrap_err();
        assert!(
            error.message.contains("admission provider probe"),
            "{mode}: {error:?}"
        );
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "positive control must reach provider"
        );
        for family in ["neo_n3", "neox", " NEO_N3 "] {
            // Reset only this probe's failed fetch; other tests may be using
            // cached keys or sharing an in-flight refresh for another URL.
            jwks_cache()
                .entries
                .lock()
                .expect("JWKS cache lock")
                .remove(&url);
            payload["network"] = json!(family);
            let before = calls.load(Ordering::SeqCst);
            let error = handler(&harness.state, &payload).unwrap_err();
            if mode == "recovery-ticket" {
                assert!(error.message.contains("admission provider probe"));
                assert_eq!(calls.load(Ordering::SeqCst), before + 1);
            } else {
                assert_eq!(error.status, 400);
                assert!(error.message.contains("unsupported Neo network"));
                assert_eq!(calls.load(Ordering::SeqCst), before);
            }
            assert!(harness.signer.sign_calls().is_empty());
        }
    }
}

#[test]
fn admission_controls_preserve_another_urls_rotated_jwks() {
    let current = signed_token(&base_claims(), "isolated-rotation-kid");
    let stale = signed_token(&base_claims(), "isolated-stale-kid");
    let fetcher = ScriptedJwksFetcher::new(vec![Ok(stale.jwks), Ok(current.jwks)]);
    let url = "https://jwks.example.test/admission-isolation-rotation";
    fetch_jwks(&fetcher, url).expect("prime stale cache");
    age_cached_jwks(url);
    verify_web3auth_fixture(&fetcher, url, &current.token).expect("rotate key");
    assert_eq!(fetcher.call_count(), 2);

    // Force the admission fixture's resets between two verifications instead
    // of depending on the test runner to schedule unrelated tests together.
    check_provider_admission("cache-isolation");

    verify_web3auth_fixture(&fetcher, url, &current.token)
        .expect("admission probes must preserve another URL's rotated key");
    assert_eq!(
        fetcher.call_count(),
        2,
        "the rotated set must remain cached"
    );
}
