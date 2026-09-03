//! `/neodid/*` fold tests — the Phase 8 flip. The ticket flows run in-process
//! (`morpheus-compute::neodid`), the digest signature and the envelope
//! signature both come from the custody `SignerPlane` (FakeSigner here), and
//! the passthrough bridge stays EMPTY: an assertion that it never recorded a
//! forward pins the in-process property. The RS256 verifier is exercised
//! against generated keys — no network in these fixtures.

use super::*;
use crate::dispatch::dispatch;
use rsa::pkcs1v15::SigningKey;
use rsa::signature::{SignatureEncoding, Signer};
use rsa::traits::PublicKeyParts;
use rsa::{RsaPrivateKey, RsaPublicKey};
use serde_json::json;
use sha2::Digest as _;

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
    morpheus_core::sha256_hex(
        morpheus_compute::stable_stringify::stable_stringify(&serde_json::Value::Object(result))
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
        morpheus_compute::neodid::compute_master_nullifier("twitter", "uid-1", &expected_salt());
    assert_eq!(response["provider"], "twitter");
    assert_eq!(response["claim_type"], "Generic_Claim");
    assert_eq!(
        response["master_nullifier"],
        format!("0x{master_nullifier}")
    );
    assert_eq!(
        response["metadata_hash"],
        format!(
            "0x{}",
            morpheus_compute::neodid::compute_metadata_hash(None)
        )
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
            "vault_account",
            "provider",
            "claim_type",
            "claim_value",
            "master_nullifier",
            "metadata_hash",
            "digest",
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
    let action_nullifier = morpheus_compute::neodid::compute_action_nullifier(
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
    let mut rng = rsa::rand_core::OsRng;
    let private_key = RsaPrivateKey::new(&mut rng, 2048).expect("keygen");
    let public_key = RsaPublicKey::from(&private_key);
    let mut jwk = json!({
        "kty": "RSA",
        "use": "sig",
        "alg": "RS256",
        "n": URL_SAFE_NO_PAD.encode(public_key.n().to_bytes_be()),
        "e": URL_SAFE_NO_PAD.encode(public_key.e().to_bytes_be()),
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
    let signing_key = SigningKey::<Sha256>::new(private_key);
    let signature = signing_key.sign(signing_input.as_bytes()).to_vec();
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
    // The token pins kid "k1"; the JWKS only carries "k2". jose's
    // createRemoteJWKSet refetches once, still finds nothing, and surfaces
    // JWKSNoMatchingKey — its exact message, not the JWS verification one.
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
