//! Read-only catalog plane tests (CU-149).
//!
//! The bodies are asserted field by field against the JS oracle
//! (`workers/nitro-worker/src/{oracle/index.js,compute/index.js,neodid/index.js}`),
//! because a catalog route that answers a shape no caller parses is a second
//! dead lane wearing a live name. Nothing here reaches a socket or a chain:
//! every value comes from a static catalog in `neo-os-compute` or from the
//! signing plane's role report.

use super::*;
use serde_json::json;

#[path = "support.rs"]
#[allow(clippy::duplicate_mod)] // intentional: one shared doubles file per test module
mod support;
use support::*;

fn harness(overlay: &[(&str, &str)]) -> TestState {
    test_state(
        overlay,
        FakeAttest::with_document(b"doc"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::default(),
    )
}

// ---------------------------------------------------------------------------
// /feeds/catalog — handleFeedsCatalog: { pairs: listFeedSymbols() }
// ---------------------------------------------------------------------------

#[test]
fn feeds_catalog_lists_the_reviewed_default_pairs() {
    let state = harness(&healthy_overlay());
    let body = handle_feeds_catalog(&state.state).expect("feeds catalog reads");
    let pairs = body["pairs"].as_array().expect("pairs is an array");
    assert!(!pairs.is_empty(), "the feed catalog is never empty");
    for pair in pairs {
        let symbol = pair.as_str().expect("pair is a string");
        assert!(
            symbol.contains("-USD"),
            "{symbol} is not a normalized *-USD pair"
        );
    }
    assert!(
        body.get("descriptors").is_none(),
        "the host answer is the oracle's {{ pairs }}, not the web app's static shape"
    );
}

#[test]
fn feeds_catalog_is_the_merged_pair_registry_not_a_hardcoded_list() {
    // `get_feed_pair_registry` deep-merges MORPHEUS_FEED_PAIR_REGISTRY_JSON
    // over the reviewed defaults, so a deployment can add a pair without the
    // catalog answer disagreeing with what `/oracle/feed` will accept.
    let overlay = [
        ("MORPHEUS_NETWORK", TEST_NETWORK),
        ("NITRO_API_TOKEN", "s3cret"),
        (
            "MORPHEUS_FEED_PAIR_REGISTRY_JSON",
            r#"{"AAA-USD":{"providers":{"twelvedata":{}}}}"#,
        ),
    ];
    let state = harness(&overlay);
    let body = handle_feeds_catalog(&state.state).expect("feeds catalog reads");
    let pairs = body["pairs"].as_array().expect("pairs is an array");
    assert!(pairs.contains(&json!("TWELVEDATA:AAA-USD")), "{}", body);
    assert!(pairs.contains(&json!("TWELVEDATA:NEO-USD")), "{}", body);

    let without_override = harness(&healthy_overlay());
    let defaults = handle_feeds_catalog(&without_override.state).expect("feeds catalog reads");
    assert_eq!(
        defaults["pairs"].as_array().expect("pairs").len() + 1,
        pairs.len(),
        "the override adds exactly the pair it names"
    );
}

// ---------------------------------------------------------------------------
// /providers — handleProvidersList: { providers: listBuiltinProviders() }
// ---------------------------------------------------------------------------

#[test]
fn providers_lists_the_builtin_provider_catalog() {
    let state = harness(&healthy_overlay());
    let body = handle_providers(&state.state).expect("providers read");
    let providers = body["providers"].as_array().expect("providers is an array");
    let ids: Vec<&str> = providers
        .iter()
        .map(|entry| entry["id"].as_str().expect("provider id"))
        .collect();
    assert_eq!(
        ids,
        vec![
            "twelvedata",
            "binance-spot",
            "coinbase-spot",
            "coingecko",
            "coinpaprika",
        ]
    );
    for entry in providers {
        assert_eq!(entry["category"], "market-data");
        assert_eq!(entry["supports"], json!(["oracle", "datafeed"]));
        assert_eq!(
            entry["kernel_supports"],
            json!(["oracle.fetch", "feed.publish"])
        );
    }
}

// ---------------------------------------------------------------------------
// /neodid/providers — handleNeoDidProviders: { providers: SUPPORTED_PROVIDERS }
// ---------------------------------------------------------------------------

#[test]
fn neodid_providers_lists_the_supported_identity_providers() {
    let state = harness(&healthy_overlay());
    let body = handle_neo_did_providers(&state.state).expect("neodid providers read");
    let providers = body["providers"].as_array().expect("providers is an array");
    let ids: Vec<&str> = providers
        .iter()
        .map(|entry| entry["id"].as_str().expect("provider id"))
        .collect();
    assert_eq!(ids[0], "web3auth");
    assert!(ids.contains(&"github"));
    for entry in providers {
        assert!(entry["category"].is_string());
        assert!(entry["aliases"].is_array());
        assert!(entry["auth_modes"].is_array());
        assert!(entry["claim_types"].is_array());
        assert!(entry["derives_provider_uid_in_tee"].is_boolean());
    }
    // Only web3auth derives the provider_uid inside the TEE; the oracle says
    // so in the same place, so a caller can tell the assurance apart.
    let tee: Vec<&str> = providers
        .iter()
        .filter(|entry| entry["derives_provider_uid_in_tee"] == json!(true))
        .map(|entry| entry["id"].as_str().expect("provider id"))
        .collect();
    assert_eq!(tee, vec!["web3auth"]);
}

// ---------------------------------------------------------------------------
// /compute/functions — handleComputeFunctions: { functions, names }
// ---------------------------------------------------------------------------

#[test]
fn compute_functions_lists_the_builtin_catalog_with_names() {
    let state = harness(&healthy_overlay());
    let body = handle_compute_functions(&state.state).expect("compute functions read");
    let functions = body["functions"].as_array().expect("functions is an array");
    let names = body["names"].as_array().expect("names is an array");
    assert_eq!(functions.len(), names.len());
    assert!(!functions.is_empty());
    for (entry, name) in functions.iter().zip(names.iter()) {
        assert_eq!(name, &entry["name"], "names mirrors functions[].name");
        assert!(entry["category"].is_string());
        assert!(entry["description"].is_string());
    }
    assert_eq!(names[0], json!("hash.sha256"));
}

// ---------------------------------------------------------------------------
// /neodid/runtime — handleNeoDidRuntime
// ---------------------------------------------------------------------------

#[test]
fn neodid_runtime_describes_the_verifier_a_caller_checks() {
    let overlay = [
        ("MORPHEUS_NETWORK", TEST_NETWORK),
        ("NITRO_API_TOKEN", "s3cret"),
        ("WEB3AUTH_CLIENT_ID", "test-client-id"),
    ];
    let state = harness(&overlay);
    let body = handle_neo_did_runtime(&state.state).expect("neodid runtime reads");

    assert_eq!(body["service"], "neodid");
    assert_eq!(body["verifier_curve"], "secp256r1");
    // The oracle takes this from custodySignBytes('worker', ...); the host
    // resolves the same identity through the signing plane's worker report.
    assert_eq!(
        body["verification_public_key"],
        "02f8a5a1e0f3b6c9d2e5f8a1b4c7d0e3f6a9b2c5d8e1f4a7b0c3d6e9f2a5b8c1"
    );

    assert_eq!(
        body["supported_routes"],
        json!([
            "/neodid/providers",
            "/neodid/runtime",
            "/neodid/bind",
            "/neodid/action-ticket",
            "/neodid/recovery-ticket",
            "/neodid/zklogin-ticket",
        ])
    );
    assert_eq!(
        body["request_types"],
        json!([
            "neodid_bind",
            "neodid_action_ticket",
            "neodid_recovery_ticket",
            "neodid_zklogin_ticket",
        ])
    );

    assert_eq!(body["web3auth"]["audience_configured"], json!(true));
    assert_eq!(body["web3auth"]["derives_provider_uid_in_tee"], json!(true));
    assert_eq!(
        body["provider_uid_verification"]["tee_verified_providers"],
        json!(["web3auth"])
    );
    assert_eq!(
        body["provider_uid_verification"]["unverified_provider_uid_allowed"],
        json!(false),
        "default deny: the unverified-uid downgrade is opt-in"
    );
    assert_eq!(
        body["providers"],
        neo_os_compute::neodid::supported_providers()
    );
}

#[test]
fn neodid_runtime_identity_fields_are_absent_like_the_oracle() {
    // The oracle reads these off `getDstackInfo`, which is an alias for
    // `getNitroInfo` (nitro-signer.js:198) and returns only
    // { runtime, network, client_kind } — so `info?.app_id` is always
    // undefined and the JS body carries null. The port must not invent one.
    let state = harness(&healthy_overlay());
    let body = handle_neo_did_runtime(&state.state).expect("neodid runtime reads");
    assert_eq!(body["app_id"], json!(null));
    assert_eq!(body["instance_id"], json!(null));
    assert_eq!(body["compose_hash"], json!(null));
}

#[test]
fn neodid_runtime_web3auth_settings_read_the_server_side_env() {
    let overlay = [
        ("MORPHEUS_NETWORK", TEST_NETWORK),
        ("NITRO_API_TOKEN", "s3cret"),
        (
            "WEB3AUTH_JWKS_URL",
            "https://issuer.example/.well-known/jwks.json",
        ),
        ("NEXT_PUBLIC_WEB3AUTH_CLIENT_ID", "public-client-id"),
        ("MORPHEUS_NEODID_ALLOW_UNVERIFIED_UID", "true"),
    ];
    let state = harness(&overlay);
    let body = handle_neo_did_runtime(&state.state).expect("neodid runtime reads");
    assert_eq!(
        body["web3auth"]["jwks_url"],
        json!("https://issuer.example/.well-known/jwks.json")
    );
    assert_eq!(body["web3auth"]["audience_configured"], json!(true));
    assert_eq!(
        body["provider_uid_verification"]["unverified_provider_uid_allowed"],
        json!(true),
        "MORPHEUS_NEODID_ALLOW_UNVERIFIED_UID=true is the documented opt-in"
    );
}

#[test]
fn neodid_runtime_defaults_the_jwks_url_and_the_audience_flag() {
    let state = harness(&healthy_overlay());
    let body = handle_neo_did_runtime(&state.state).expect("neodid runtime reads");
    assert_eq!(
        body["web3auth"]["jwks_url"],
        json!("https://api-auth.web3auth.io/.well-known/jwks.json")
    );
    assert_eq!(body["web3auth"]["audience_configured"], json!(false));
}

#[test]
fn neodid_runtime_fails_closed_when_the_worker_identity_is_not_materialized() {
    // A descriptor whose verification_public_key is invented is worse than no
    // descriptor: a caller would pin the wrong key. Unconfigured is a 503.
    let state = test_state(
        &healthy_overlay(),
        FakeAttest::with_document(b"doc"),
        FakeSigner::unconfigured(),
        FakeBridge::new(),
        FakeKms::default(),
    );
    let error = handle_neo_did_runtime(&state.state).expect_err("unconfigured worker refuses");
    assert_eq!(error.status, 503);
}

#[test]
fn every_catalog_handler_is_a_pure_read() {
    // No handler takes a request body, so no caller-supplied field can change
    // what the catalog says. The signatures are the assertion; if a handler
    // ever needs a payload this test no longer compiles.
    let state = harness(&healthy_overlay());
    let _ = handle_feeds_catalog(&state.state).expect("feeds");
    let _ = handle_providers(&state.state).expect("providers");
    let _ = handle_neo_did_providers(&state.state).expect("neodid providers");
    let _ = handle_neo_did_runtime(&state.state).expect("neodid runtime");
    let _ = handle_compute_functions(&state.state).expect("compute functions");
}
