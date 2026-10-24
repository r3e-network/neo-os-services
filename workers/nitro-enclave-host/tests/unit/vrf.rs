use crate::dispatch::dispatch;
use base64::Engine as _;
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use serde_json::json;
use sha2::Sha256;

#[path = "support.rs"]
#[allow(clippy::duplicate_mod)]
mod support;
use support::*;

const TEST_VRF_ROOT: &str = "1111111111111111111111111111111111111111111111111111111111111111";

fn vrf_overlay() -> Vec<(&'static str, &'static str)> {
    let mut overlay = healthy_overlay();
    overlay.push(("MORPHEUS_GAME_SECRET_ROOT_HEX", TEST_VRF_ROOT));
    overlay.push(("MORPHEUS_GAME_SECRET_ROOT_SOURCE", "nitro-recipient-kms"));
    overlay
}

#[test]
fn vrf_random_is_signed_by_custody_with_the_canonical_envelope() {
    let harness = test_state(
        &vrf_overlay(),
        FakeAttest::with_document(b"doc"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::default(),
    );
    let outcome = dispatch(
        &harness.state,
        "POST",
        "/vrf/random",
        &bearer("s3cret"),
        &body_json(&json!({ "request_id": "req-1" })),
    );

    assert_eq!(outcome.status, 200, "{}", outcome.body);
    assert_eq!(outcome.body["request_id"], "req-1");
    assert_eq!(outcome.body["vrf_method"], "hmac-sha256-signed");
    assert_eq!(outcome.body["randomness"].as_str().unwrap().len(), 64);
    assert_eq!(outcome.body["signature"], "00");
    assert_eq!(outcome.body["public_key"], healthy_identity()["public_key"]);
    assert_eq!(
        outcome.body["output_hash"],
        outcome.body["attestation_hash"]
    );
    assert!(outcome.body["timestamp"].as_u64().unwrap() > 0);

    let signed_hex = &harness.signer.sign_calls()[0].2;
    let signed_json = String::from_utf8(hex::decode(signed_hex).unwrap()).unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&signed_json).unwrap(),
        json!({ "randomness": outcome.body["randomness"] })
    );
}

#[test]
fn vrf_random_requires_auth_and_never_accepts_caller_keys() {
    let harness = test_state(
        &vrf_overlay(),
        FakeAttest::with_document(b"doc"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::default(),
    );
    let unauthenticated = dispatch(
        &harness.state,
        "POST",
        "/vrf/random",
        &http::HeaderMap::new(),
        "{}",
    );
    assert_eq!(unauthenticated.status, 401);

    let caller_key = dispatch(
        &harness.state,
        "POST",
        "/vrf/random",
        &bearer("s3cret"),
        r#"{"private_key":"forbidden"}"#,
    );
    assert_eq!(caller_key.status, 400);
    assert!(caller_key.body["error"]
        .as_str()
        .unwrap()
        .contains("caller-supplied signing key"));
}

#[test]
fn vrf_request_id_preserves_string_and_number_json_types() {
    for request_id in [json!("req-string"), json!(42)] {
        let harness = test_state(
            &vrf_overlay(),
            FakeAttest::with_document(b"doc"),
            FakeSigner::healthy(),
            FakeBridge::new(),
            FakeKms::default(),
        );
        let outcome = dispatch(
            &harness.state,
            "POST",
            "/vrf/random",
            &bearer("s3cret"),
            &body_json(&json!({ "request_id": request_id })),
        );

        assert_eq!(outcome.status, 200, "{}", outcome.body);
        assert_eq!(outcome.body["request_id"], request_id);

        let signed_hex = &harness.signer.sign_calls()[0].2;
        let signed_json = String::from_utf8(hex::decode(signed_hex).unwrap()).unwrap();
        let signed_value = serde_json::from_str::<serde_json::Value>(&signed_json).unwrap();
        assert_eq!(
            signed_value,
            json!({ "randomness": outcome.body["randomness"] }),
            "request metadata must not change the canonical signed value"
        );
    }
}

#[test]
fn vrf_random_is_deterministic_and_bound_to_the_request_domain() {
    let harness = test_state(
        &vrf_overlay(),
        FakeAttest::with_document(b"doc"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::default(),
    );
    let first = dispatch(
        &harness.state,
        "POST",
        "/vrf/random",
        &bearer("s3cret"),
        &body_json(&json!({ "request_id": "bound-1", "module_id": "random.generate" })),
    );
    let second = dispatch(
        &harness.state,
        "POST",
        "/vrf/random",
        &bearer("s3cret"),
        &body_json(&json!({ "request_id": "bound-1", "module_id": "random.generate" })),
    );
    assert_eq!(first.status, 200, "{}", first.body);
    assert_eq!(second.status, 200, "{}", second.body);
    assert_eq!(first.body["randomness"], second.body["randomness"]);
    // v2 direct-lane value (the key and the framing changed; bb07163's v1
    // value for this request was V1_BOUND_1).
    assert_eq!(
        first.body["randomness"],
        "1cd68ca6a870b3655f778068f64d604a619465b8ec407b674f91ab535f30626d"
    );

    let changed_request = dispatch(
        &harness.state,
        "POST",
        "/vrf/random",
        &bearer("s3cret"),
        &body_json(&json!({ "request_id": "bound-2", "module_id": "random.generate" })),
    );
    assert_ne!(first.body["randomness"], changed_request.body["randomness"]);

    let changed_network = dispatch(
        &harness.state,
        "POST",
        "/vrf/random",
        &bearer("s3cret"),
        &body_json(&json!({
            "request_id": "bound-1",
            "module_id": "random.generate",
            "network": "mainnet"
        })),
    );
    assert_eq!(changed_network.status, 400, "{}", changed_network.body);
    // A different domain must run in its own bound context, not select a
    // foreign signing key through a payload on the testnet context.
    let mut main_overlay = vrf_overlay();
    main_overlay.retain(|(key, _)| *key != "MORPHEUS_NETWORK");
    main_overlay.push(("MORPHEUS_NETWORK", "mainnet"));
    let main = test_state(
        &main_overlay,
        FakeAttest::with_document(b"doc"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::default(),
    );
    let main_result = dispatch(
        &main.state,
        "POST",
        "/vrf/random",
        &bearer("s3cret"),
        &body_json(&json!({"request_id":"bound-1", "module_id":"random.generate"})),
    );
    assert_eq!(main_result.status, 200, "{}", main_result.body);
    assert_ne!(first.body["randomness"], main_result.body["randomness"]);
    assert!(main
        .signer
        .sign_calls()
        .iter()
        .all(|call| call.0 == "mainnet"));
}

#[test]
fn vrf_random_refuses_without_the_kms_materialized_root() {
    let harness = test_state(
        &healthy_overlay(),
        FakeAttest::with_document(b"doc"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::default(),
    );
    let outcome = dispatch(
        &harness.state,
        "POST",
        "/vrf/random",
        &bearer("s3cret"),
        &body_json(&json!({ "request_id": "missing-root" })),
    );
    assert_eq!(outcome.status, 503);
    assert!(outcome.body["error"].as_str().unwrap().contains("VRF key"));
    assert!(harness.signer.sign_calls().is_empty());
}

#[test]
fn vrf_random_refuses_every_explicit_noncanonical_module_id() {
    for module_id in [
        json!(""),
        json!("random.other"),
        json!(null),
        json!(42),
        json!(false),
        json!([]),
        json!({}),
    ] {
        let harness = test_state(
            &vrf_overlay(),
            FakeAttest::with_document(b"doc"),
            FakeSigner::healthy(),
            FakeBridge::new(),
            FakeKms::default(),
        );
        let outcome = dispatch(
            &harness.state,
            "POST",
            "/vrf/random",
            &bearer("s3cret"),
            &body_json(&json!({ "request_id": "bad-module", "module_id": module_id })),
        );
        assert_eq!(outcome.status, 400, "{}", outcome.body);
        assert!(outcome.body["error"]
            .as_str()
            .unwrap()
            .contains("module_id"));
        assert!(harness.signer.sign_calls().is_empty());
    }
}

#[test]
fn vrf_random_refuses_untrusted_or_malformed_kms_roots() {
    let short_root = "11".repeat(31);
    let long_root = "11".repeat(33);
    let cases = [
        ("wrong-source", TEST_VRF_ROOT),
        ("nitro-recipient-kms", "not-hex"),
        ("nitro-recipient-kms", short_root.as_str()),
        ("nitro-recipient-kms", long_root.as_str()),
    ];
    for (source, root) in cases {
        let mut overlay = healthy_overlay();
        overlay.push(("MORPHEUS_GAME_SECRET_ROOT_HEX", root));
        overlay.push(("MORPHEUS_GAME_SECRET_ROOT_SOURCE", source));
        let harness = test_state(
            &overlay,
            FakeAttest::with_document(b"doc"),
            FakeSigner::healthy(),
            FakeBridge::new(),
            FakeKms::default(),
        );
        let outcome = dispatch(
            &harness.state,
            "POST",
            "/vrf/random",
            &bearer("s3cret"),
            &body_json(&json!({ "request_id": "bad-root" })),
        );
        assert_eq!(outcome.status, 503, "{}", outcome.body);
        assert!(harness.signer.sign_calls().is_empty());
    }
}

#[test]
fn vrf_random_refuses_all_caller_key_aliases_before_custody() {
    for field in ["private_key", "signing_key", "wif"] {
        let harness = test_state(
            &vrf_overlay(),
            FakeAttest::with_document(b"doc"),
            FakeSigner::healthy(),
            FakeBridge::new(),
            FakeKms::default(),
        );
        let mut body = json!({ "request_id": "caller-key" });
        body[field] = json!("forbidden");
        let outcome = dispatch(
            &harness.state,
            "POST",
            "/vrf/random",
            &bearer("s3cret"),
            &body_json(&body),
        );
        assert_eq!(outcome.status, 400, "{}", outcome.body);
        assert!(outcome.body["error"]
            .as_str()
            .unwrap()
            .contains("caller-supplied signing key"));
        assert!(harness.signer.sign_calls().is_empty());
    }
}

#[test]
fn vrf_random_carries_custody_failure_without_a_local_fallback() {
    let signer = FakeSigner::new(SignerConfig {
        sign_result: Some(Err(crate::RuntimeError {
            status: 503,
            message: "custody unavailable".to_string(),
            provider_category: None,
        })),
        ..SignerConfig::default()
    });
    let harness = test_state(
        &vrf_overlay(),
        FakeAttest::with_document(b"doc"),
        signer,
        FakeBridge::new(),
        FakeKms::default(),
    );
    let outcome = dispatch(
        &harness.state,
        "POST",
        "/vrf/random",
        &bearer("s3cret"),
        &body_json(&json!({ "request_id": "custody-failure" })),
    );
    assert_eq!(outcome.status, 503, "{}", outcome.body);
    assert!(outcome.body.get("randomness").is_none());
    assert!(harness.signer.sign_calls().len() == 1);
}

#[test]
fn vrf_random_refuses_a_custody_identity_contradiction() {
    let signer = FakeSigner::new(SignerConfig {
        sign_result: Some(Ok(json!({
            "status": "ok",
            "signature": "00",
            "public_key": healthy_identity()["public_key"],
            "address": "NWRONG",
            "script_hash": healthy_identity()["script_hash"],
        }))),
        ..SignerConfig::default()
    });
    let harness = test_state(
        &vrf_overlay(),
        FakeAttest::with_document(b"doc"),
        signer,
        FakeBridge::new(),
        FakeKms::default(),
    );
    let outcome = dispatch(
        &harness.state,
        "POST",
        "/vrf/random",
        &bearer("s3cret"),
        &body_json(&json!({ "request_id": "identity-mismatch" })),
    );
    assert_eq!(outcome.status, 503, "{}", outcome.body);
    assert!(outcome.body.get("randomness").is_none());
    assert_eq!(harness.signer.sign_calls().len(), 1);
}

/// The measured TestNet Neo N3 oracle contract and magic `fulfill.rs` binds.
const N3_ORACLE: &str = "0xf54d8584ef82315c1800373272ab08ae0db2d5ef";
const N3_TESTNET_MAGIC: u64 = 894_710_606;
const NEOX_TESTNET_CHAIN_ID: u64 = 12_227_332;
/// What bb07163 (v1) returned for the direct request `bound-1` on TestNet.
const V1_BOUND_1: &str = "8bb793ed0cb627eeb5ceb860984c54a4ae14f0f1ed65336b78613426219a0fa7";

fn test_root() -> [u8; 32] {
    <[u8; 32]>::try_from(hex::decode(TEST_VRF_ROOT).expect("root hex")).expect("32-byte root")
}

fn framed_hmac(key: &[u8], fields: &[&str]) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("HMAC accepts any key length");
    for field in fields {
        mac.update(
            &u32::try_from(field.len())
                .expect("short field")
                .to_be_bytes(),
        );
        mac.update(field.as_bytes());
    }
    hex::encode(mac.finalize().into_bytes())
}

/// The v2 output written out from docs/security/VRF-DESIGN-20260926.md,
/// independently of `vrf.rs`: `[lane, network, chain, chain_id,
/// oracle_contract, JSON(request_id)]`.
fn spec_v2(fields: [&str; 6]) -> String {
    let mut key = [0u8; 32];
    Hkdf::<Sha256>::new(Some(b"neoos-kms-secret-root/v1"), &test_root())
        .expand(b"neoos-vrf-random-key/v1", &mut key)
        .expect("32-byte HKDF output");
    let [lane, network, chain, chain_id, oracle_contract, request_id] = fields;
    framed_hmac(
        &key,
        &[
            "neoos-vrf-random-v2",
            lane,
            network,
            chain,
            chain_id,
            oracle_contract,
            request_id,
            "random.generate",
        ],
    )
}

/// bb07163's v1 output: the raw root as the key and four fields.
fn spec_v1(network: &str, request_id: &str) -> String {
    framed_hmac(
        &test_root(),
        &[
            "neoos-vrf-random-v1",
            network,
            request_id,
            "random.generate",
        ],
    )
}

fn vrf_test_state() -> TestState {
    test_state(
        &vrf_overlay(),
        FakeAttest::with_document(b"doc"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::default(),
    )
}

/// `/oracle/fulfill` runs the real in-process VRF handler, not the canned
/// compute double.
fn fulfill_vrf_harness() -> TestState {
    let mut harness = vrf_test_state();
    harness.state.fulfillment_compute_override = None;
    harness
}

fn random_body(
    chain: &str,
    request_id: &str,
    fulfillment_context: serde_json::Value,
) -> serde_json::Value {
    json!({
        "chain": chain,
        "request_type": "random",
        "request_id": request_id,
        "payload_text": "{}",
        "payload": {},
        "fulfillment_context": fulfillment_context,
    })
}

fn n3_context() -> serde_json::Value {
    json!({ "contract_script_hash": N3_ORACLE, "network_magic": N3_TESTNET_MAGIC })
}

fn neox_context(chain_id: u64, oracle_contract: &str) -> serde_json::Value {
    json!({ "chain_id": chain_id, "oracle_contract": oracle_contract })
}

/// The 32 callback bytes a fulfilment settles on chain, as hex.
fn fulfilled_randomness(harness: &TestState, body: &serde_json::Value) -> String {
    let response =
        crate::fulfill::handle_oracle_fulfill(&harness.state, body).expect("VRF fulfilment");
    assert_eq!(response["success"], true, "{response}");
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(
            response["result_bytes_base64"]
                .as_str()
                .expect("compact VRF result"),
        )
        .expect("base64 callback");
    assert_eq!(bytes.len(), 32);
    hex::encode(bytes)
}

#[test]
fn fulfilled_randomness_follows_the_v2_construction_on_both_chains() {
    let harness = fulfill_vrf_harness();
    let neox_oracle = format!("0x{}", "22".repeat(20));
    let n3 = fulfilled_randomness(&harness, &random_body("neo_n3", "103", n3_context()));
    let neox = fulfilled_randomness(
        &harness,
        &random_body(
            "neox",
            "103",
            neox_context(NEOX_TESTNET_CHAIN_ID, &neox_oracle),
        ),
    );
    assert_eq!(
        n3,
        spec_v2([
            "oracle-fulfill",
            "testnet",
            "neo_n3",
            "894710606",
            N3_ORACLE,
            "\"103\""
        ])
    );
    assert_eq!(
        neox,
        spec_v2([
            "oracle-fulfill",
            "testnet",
            "neox",
            "12227332",
            &neox_oracle,
            "\"103\""
        ])
    );
    // Pinned values, computed outside Rust.
    assert_eq!(
        n3,
        "19fd46f95f62b283a1a974a5d6cba035919231f057d60c2173ff33eec48caa8c"
    );
    assert_eq!(
        neox,
        "2bda09e629d9fe39d65fe270858b5fb48cfc86fe727349146f012b016eb83f2a"
    );
}

#[test]
fn identical_request_ids_on_neo_n3_and_neox_get_different_randomness() {
    let harness = fulfill_vrf_harness();
    let neox_oracle = format!("0x{}", "22".repeat(20));
    for request_id in ["1", "103", "4242"] {
        let n3 = fulfilled_randomness(&harness, &random_body("neo_n3", request_id, n3_context()));
        let neox = fulfilled_randomness(
            &harness,
            &random_body(
                "neox",
                request_id,
                neox_context(NEOX_TESTNET_CHAIN_ID, &neox_oracle),
            ),
        );
        assert_ne!(n3, neox, "request {request_id}");
    }
}

#[test]
fn different_oracle_contracts_get_different_randomness() {
    let harness = fulfill_vrf_harness();
    let first = format!("0x{}", "ab".repeat(20));
    let second = format!("0x{}", "cd".repeat(20));
    let randomness = |chain_id: u64, contract: &str| {
        fulfilled_randomness(
            &harness,
            &random_body("neox", "103", neox_context(chain_id, contract)),
        )
    };
    let base = randomness(NEOX_TESTNET_CHAIN_ID, &first);
    let other_contract = randomness(NEOX_TESTNET_CHAIN_ID, &second);
    // The same address on another EVM chain is another contract.
    let other_chain = randomness(47_763, &first);
    assert_ne!(base, other_contract);
    assert_ne!(base, other_chain);
    assert_ne!(other_contract, other_chain);

    // The contract is bound as its 20 bytes, not as the relayer's spelling,
    // so a checksummed or unprefixed address cannot re-roll a request.
    for spelling in [
        format!("0x{}", "AB".repeat(20)),
        "ab".repeat(20),
        format!("  {first}  "),
    ] {
        assert_eq!(
            randomness(NEOX_TESTNET_CHAIN_ID, &spelling),
            base,
            "{spelling}"
        );
    }
}

#[test]
fn vrf_fulfillment_refuses_a_missing_or_malformed_chain_domain_before_computing() {
    let neox_oracle = format!("0x{}", "22".repeat(20));
    let mut cases: Vec<(serde_json::Value, &str)> = Vec::new();

    let mut without_chain = random_body("neo_n3", "103", n3_context());
    without_chain
        .as_object_mut()
        .expect("body object")
        .remove("chain");
    cases.push((without_chain, "requires chain neo_n3 or neox"));
    for chain in [
        json!("legacy"),
        json!("solana"),
        json!(""),
        json!(42),
        json!(null),
    ] {
        let mut body = random_body("neo_n3", "103", n3_context());
        body["chain"] = chain;
        cases.push((body, "requires chain neo_n3 or neox"));
    }

    for context in [json!({}), json!({ "contract_script_hash": "" })] {
        cases.push((
            random_body("neo_n3", "103", context),
            "requires fulfillment_context.contract_script_hash",
        ));
    }
    cases.push((
        random_body(
            "neo_n3",
            "103",
            json!({ "contract_script_hash": format!("0x{}", "11".repeat(20)) }),
        ),
        "contract does not match measured testnet",
    ));
    cases.push((
        random_body(
            "neo_n3",
            "103",
            json!({ "contract_script_hash": N3_ORACLE, "network_magic": 860_833_102 }),
        ),
        "network magic does not match measured testnet",
    ));

    for context in [
        json!({ "oracle_contract": neox_oracle }),
        neox_context(0, &neox_oracle),
        json!({ "chain_id": "twelve", "oracle_contract": neox_oracle }),
    ] {
        cases.push((random_body("neox", "103", context), "chain_id is required"));
    }
    cases.push((
        random_body("neox", "103", json!({ "chain_id": NEOX_TESTNET_CHAIN_ID })),
        "oracle_contract is required",
    ));
    for contract in [
        "0xabc".to_string(),
        format!("0x{}", "zz".repeat(20)),
        format!("0X{}", "22".repeat(20)),
        format!("0x{}", "22".repeat(21)),
    ] {
        cases.push((
            random_body(
                "neox",
                "103",
                neox_context(NEOX_TESTNET_CHAIN_ID, &contract),
            ),
            "invalid oracle contract address",
        ));
    }

    for (body, expected) in cases {
        // The canned compute double records every compute it is asked for.
        let harness = vrf_test_state();
        let error = crate::fulfill::handle_oracle_fulfill(&harness.state, &body)
            .expect_err("a malformed VRF domain must be refused");
        assert_eq!(error.status, 400, "{body}");
        assert!(
            error.message.contains(expected),
            "{body}: {}",
            error.message
        );
        assert!(
            harness.bridge.forwards().is_empty(),
            "{body}: computed before refusing"
        );
        assert!(harness.signer.sign_calls().is_empty(), "{body}");
        assert!(harness.signer.eip191_calls().is_empty(), "{body}");
    }
}

#[test]
fn every_domain_field_changes_the_vrf_input() {
    let base = super::VrfRequestDomain {
        network: "testnet".to_string(),
        chain: "neo_n3",
        chain_id: N3_TESTNET_MAGIC,
        oracle_contract: N3_ORACLE.to_string(),
        request_id: "103".to_string(),
    };
    let input = |network: &str, domain: Option<&super::VrfRequestDomain>, request_id: &str| {
        super::vrf_input(network, domain, &json!(request_id), "random.generate")
            .expect("framed input")
    };
    let inputs = [
        input("testnet", Some(&base), "103"),
        input("testnet", Some(&base), "104"),
        input(
            "testnet",
            Some(&super::VrfRequestDomain {
                network: "mainnet".to_string(),
                ..base.clone()
            }),
            "103",
        ),
        input(
            "testnet",
            Some(&super::VrfRequestDomain {
                chain: "neox",
                ..base.clone()
            }),
            "103",
        ),
        input(
            "testnet",
            Some(&super::VrfRequestDomain {
                chain_id: NEOX_TESTNET_CHAIN_ID,
                ..base.clone()
            }),
            "103",
        ),
        input(
            "testnet",
            Some(&super::VrfRequestDomain {
                oracle_contract: format!("0x{}", "22".repeat(20)),
                ..base.clone()
            }),
            "103",
        ),
        input("testnet", None, "103"),
        input("mainnet", None, "103"),
    ];
    let distinct: std::collections::HashSet<&Vec<u8>> = inputs.iter().collect();
    assert_eq!(distinct.len(), inputs.len(), "two domains share an input");

    // A fulfilment's network is the measured one in its domain; the network
    // label its payload resolves to cannot move it.
    assert_eq!(
        input("mainnet", Some(&base), "103"),
        input("testnet", Some(&base), "103")
    );
}

#[test]
fn v2_never_reproduces_a_v1_output() {
    assert_eq!(spec_v1("testnet", "\"bound-1\""), V1_BOUND_1);

    let harness = vrf_test_state();
    for request_id in [json!("bound-1"), json!("103"), json!(103)] {
        let outcome = dispatch(
            &harness.state,
            "POST",
            "/vrf/random",
            &bearer("s3cret"),
            &body_json(&json!({ "request_id": request_id })),
        );
        assert_eq!(outcome.status, 200, "{}", outcome.body);
        let request_id = serde_json::to_string(&request_id).expect("request id JSON");
        assert_ne!(outcome.body["randomness"], spec_v1("testnet", &request_id));
    }
    let fulfilled = fulfilled_randomness(
        &fulfill_vrf_harness(),
        &random_body("neo_n3", "103", n3_context()),
    );
    assert_ne!(fulfilled, spec_v1("testnet", "\"103\""));

    // Every v2 input opens with the framed v2 tag, which no v1 input shares,
    // so no v2 request can be shaped into a v1 input; v2 also uses the VRF
    // subkey where v1 used the root itself.
    let mut v2_prefix = 19_u32.to_be_bytes().to_vec();
    v2_prefix.extend_from_slice(b"neoos-vrf-random-v2");
    for domain in [
        None,
        Some(super::VrfRequestDomain {
            network: "testnet".to_string(),
            chain: "neo_n3",
            chain_id: N3_TESTNET_MAGIC,
            oracle_contract: N3_ORACLE.to_string(),
            request_id: "103".to_string(),
        }),
    ] {
        let input = super::vrf_input("testnet", domain.as_ref(), &json!("103"), "random.generate")
            .expect("framed input");
        assert!(input.starts_with(&v2_prefix));
    }
    assert_ne!(crate::secret_root::vrf_key(&test_root()), test_root());
}

#[test]
fn neither_the_direct_route_nor_the_automation_lane_reproduces_a_fulfilled_output() {
    let harness = fulfill_vrf_harness();
    let fulfilled = fulfilled_randomness(&harness, &random_body("neo_n3", "103", n3_context()));
    let direct_value = spec_v2(["direct", "testnet", "", "", "", "\"103\""]);

    let direct = dispatch(
        &harness.state,
        "POST",
        "/vrf/random",
        &bearer("s3cret"),
        &body_json(&json!({ "request_id": "103" })),
    );
    assert_eq!(direct.status, 200, "{}", direct.body);
    assert_eq!(direct.body["randomness"], direct_value);
    assert_ne!(direct.body["randomness"], fulfilled);

    // The automation lane runs the VRF on a nested request_id taken from the
    // automation's own payload; it gets the direct-lane value too.
    let automation = dispatch(
        &harness.state,
        "POST",
        "/automation/execute",
        &bearer("s3cret"),
        &body_json(&json!({
            "automation_id": "automation:vrf:cross-lane",
            "idempotency_key": "automation-vrf-cross-lane-103",
            "execution_request_type": "random",
            "execution_payload": { "request_id": "103" },
        })),
    );
    assert_eq!(automation.status, 200, "{}", automation.body);
    assert_eq!(automation.body["result"]["randomness"], direct_value);
    assert_ne!(automation.body["result"]["randomness"], fulfilled);
}
