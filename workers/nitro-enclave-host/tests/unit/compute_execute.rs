//! `/compute/execute` fold tests — the Phase 6 flip. Compute runs in-process
//! (`neo-os-compute`), the signature comes from the custody `SignerPlane`
//! (FakeSigner here) and the attestation from the host's own binding, so the
//! fixtures drive `handle_compute_execute` exactly as the Node suite drove
//! `handleComputeExecute`. The bridge double stays canned and EMPTY: an
//! assertion that it never recorded a forward pins the in-process property.

use super::*;
use base64::Engine as _;
use serde_json::json;

#[path = "support.rs"]
#[allow(clippy::duplicate_mod)] // intentional: one shared doubles file per test module
mod support;
use support::*;

/// The fixed recipient keypair from
/// `neo_os_compute::oracle::crypto`'s golden vectors; VECTOR_3 was encrypted
/// to it and reference-verified through the worker's own
/// `decryptEncryptedToken`.
const KEY_MATERIAL_JSON: &str = r#"{"public_key_raw":"XTtv0zrHad11LpRshb0tlN4yE17XpEtS1Q7vi72vG2w=","private_key_pkcs8":"MC4CAQAwBQYDK2VuBCIEIHBbVsOxyrXBteJj7nRKLaIPZ5McQpQs03dP2f2i5Z5x"}"#;
const RECIPIENT_PUBLIC_RAW_B64: &str = "XTtv0zrHad11LpRshb0tlN4yE17XpEtS1Q7vi72vG2w=";
const VECTOR_3_CIPHERTEXT: &str = "eyJ2IjoyLCJhbGciOiJYMjU1MTktSEtERi1TSEEyNTYtQUVTLTI1Ni1HQ00iLCJlcGsiOiJST1dTSXVicit0TGtCZHk4WjBxb25HNkx0bG9JTVpiSXppYmJ3U3FZTFUwPSIsIml2IjoiSnNkc0tTV1ZHMWRDNm9LTiIsImN0IjoiZ3BiTmNZNVR5dW1yMUErL2ltYnR2bmp2NHZ4dTh6UVBzTWtIQmdHOSIsInRhZyI6IkVocC9PWXV6L29DT3ZlRzFtKytOMWc9PSJ9";

fn compute_harness(overlay: &[(&str, &str)]) -> TestState {
    test_state(
        overlay,
        FakeAttest::with_document(b"doc"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::default(),
    )
}

fn expected_envelope(result: &serde_json::Value) -> (String, serde_json::Value) {
    let payload_bytes = stable_stringify(&JsValue::from_json(result));
    let output_hash = neo_os_core::sha256_hex(payload_bytes.as_bytes());
    let verification = json!({
        "output_hash": output_hash,
        "attestation_hash": output_hash,
        "signature": "00",
        "public_key": "02f8a5a1e0f3b6c9d2e5f8a1b4c7d0e3f6a9b2c5d8e1f4a7b0c3d6e9f2a5b8c1",
        "signer_address": "Nd5tGBUrXa3YylLBYbwZSp8BhRd1vcaFqm",
        "signer_script_hash": "0x5c2047b1c6b4b6e4b3a1c9d5e7f0a2b4c6d8e0f1",
        "tee_attestation": serde_json::Value::Null,
    });
    let lane = json!({
        "output_hash": output_hash,
        "signature": "00",
        "public_key": "02f8a5a1e0f3b6c9d2e5f8a1b4c7d0e3f6a9b2c5d8e1f4a7b0c3d6e9f2a5b8c1",
        "attestation_hash": output_hash,
        "tee_attestation": serde_json::Value::Null,
        "verification": verification,
    });
    (output_hash, lane)
}

#[test]
fn builtin_computes_in_process_signs_and_binds_the_result_envelope() {
    let harness = compute_harness(&healthy_overlay());
    let response = handle_compute_execute(
        &harness.state,
        &json!({ "function": "hash.sha256", "input": { "z": 1 } }),
    )
    .expect("builtin lane executes");

    let result = json!({
        "function": "hash.sha256",
        "result": {
            "digest": neo_os_core::sha256_hex(stable_stringify(&JsValue::from_json(&json!({"z": 1}))).as_bytes()),
        },
    });
    let (output_hash, lane) = expected_envelope(&result);
    assert_eq!(
        response,
        json!({
            "mode": "builtin",
            "target_chain": "neo_n3",
            "target_chain_id": serde_json::Value::Null,
            "function": "hash.sha256",
            "result": { "digest": result["result"]["digest"] },
            "output_hash": output_hash,
            "signature": "00",
            "public_key": "02f8a5a1e0f3b6c9d2e5f8a1b4c7d0e3f6a9b2c5d8e1f4a7b0c3d6e9f2a5b8c1",
            "attestation_hash": output_hash,
            "tee_attestation": serde_json::Value::Null,
            "verification": lane["verification"],
        })
    );

    // The signature binds the EXACT stableStringify(result) bytes, worker
    // role, resolved network — the custody plane never sees anything else.
    let signed_bytes = stable_stringify(&JsValue::from_json(&result));
    assert_eq!(
        harness.signer.sign_calls(),
        vec![(
            "testnet".to_string(),
            "worker".to_string(),
            hex::encode(signed_bytes.as_bytes()),
        )],
    );
    // The Phase 6 property: the fold never forwards to the child.
    assert!(harness.bridge.forwards().is_empty());
}

#[test]
fn response_keys_are_in_the_node_spread_order() {
    let harness = compute_harness(&healthy_overlay());
    let response = handle_compute_execute(
        &harness.state,
        &json!({ "function": "hash.sha256", "input": {} }),
    )
    .expect("executes");
    let keys: Vec<&str> = response
        .as_object()
        .expect("object")
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(
        keys,
        vec![
            "mode",
            "target_chain",
            "target_chain_id",
            "function",
            "result",
            "output_hash",
            "signature",
            "public_key",
            "attestation_hash",
            "tee_attestation",
            "verification",
        ]
    );
}

#[test]
fn confidential_payload_decrypts_merges_and_prunes_before_compute() {
    let overlay = [
        ("MORPHEUS_NETWORK", TEST_NETWORK),
        ("NITRO_API_TOKEN", "s3cret"),
        ("MORPHEUS_ORACLE_KEY_MATERIAL_JSON", KEY_MATERIAL_JSON),
    ];
    let harness = compute_harness(&overlay);
    let response = handle_compute_execute(
        &harness.state,
        &json!({
            "function": "hash.sha256",
            "encrypted_inputs": { "input": VECTOR_3_CIPHERTEXT },
        }),
    )
    .expect("confidential lane decrypts");

    // VECTOR_3's plaintext is {"input":{"symbol":"NEO/USD"}} — the merge
    // supplies payload.input, so the digest is over the DECRYPTED value, and
    // the pruned encrypted_inputs bookkeeping never reaches compute.
    let decrypted_input = json!({ "symbol": "NEO/USD" });
    let result = json!({
        "function": "hash.sha256",
        "result": {
            "digest": neo_os_core::sha256_hex(stable_stringify(&JsValue::from_json(&decrypted_input)).as_bytes()),
        },
    });
    let (output_hash, _) = expected_envelope(&result);
    assert_eq!(response["mode"], "builtin");
    assert_eq!(response["result"]["digest"], result["result"]["digest"]);
    assert_eq!(response["output_hash"], output_hash);
    assert!(response.get("encrypted_inputs").is_none());
    assert!(harness.bridge.forwards().is_empty());
}

#[test]
fn confidential_key_material_states_fail_exactly_like_the_child() {
    // No material at all: the child's unavailable error, verbatim.
    let harness = compute_harness(&healthy_overlay());
    let error = handle_compute_execute(&harness.state, &json!({ "encrypted_params": "AAAA" }))
        .expect_err("no key material configured");
    assert_eq!(error.status, 400);
    assert_eq!(
        error.message,
        "oracle key material unavailable: no configured key or provisioned KMS ciphertext, and no ephemeral key allowed"
    );

    // A configured source that fails to parse falls through to the next one
    // (the child logs and continues), landing on the same unavailable error.
    let overlay = [
        ("MORPHEUS_NETWORK", TEST_NETWORK),
        ("NITRO_API_TOKEN", "s3cret"),
        ("MORPHEUS_ORACLE_KEY_MATERIAL_JSON", "not json"),
    ];
    let harness = compute_harness(&overlay);
    let error = handle_compute_execute(&harness.state, &json!({ "encrypted_params": "AAAA" }))
        .expect_err("misconfigured source falls through");
    assert_eq!(
        error.message,
        "oracle key material unavailable: no configured key or provisioned KMS ciphertext, and no ephemeral key allowed"
    );

    // A sealed keystore in the env is not a separate refusal any more (CU-148):
    // the only way that path could produce a wrap key is the legacy Secrets
    // Manager master derivation, which this host refuses by policy, so it could
    // never succeed here. It now lands on the ordinary no-key-material error and
    // the message stops advertising a capability this host does not have.
    let overlay = [
        ("MORPHEUS_NETWORK", TEST_NETWORK),
        ("NITRO_API_TOKEN", "s3cret"),
        (
            "MORPHEUS_ORACLE_SEALED_KEYSTORE_JSON",
            r#"{"public_key_raw":"AA==","sealed_private_key":"BB=="}"#,
        ),
    ];
    let harness = compute_harness(&overlay);
    let error = handle_compute_execute(&harness.state, &json!({ "encrypted_params": "AAAA" }))
        .expect_err("a sealed keystore cannot be served here");
    assert_eq!(error.status, 400);
    assert_eq!(
        error.message,
        "oracle key material unavailable: no configured key or provisioned KMS ciphertext, and no ephemeral key allowed"
    );

    // ...and production denies the ephemeral flag before anything else runs.
    let overlay = [
        ("MORPHEUS_NETWORK", TEST_NETWORK),
        ("NITRO_API_TOKEN", "s3cret"),
        ("MORPHEUS_ALLOW_EPHEMERAL_KEY", "true"),
        ("NODE_ENV", "production"),
    ];
    let harness = compute_harness(&overlay);
    let error = handle_compute_execute(&harness.state, &json!({ "encrypted_params": "AAAA" }))
        .expect_err("ephemeral + production is a policy error");
    assert_eq!(error.status, 400);
    assert_eq!(
        error.message,
        "MORPHEUS_ALLOW_EPHEMERAL_KEY is not allowed when NODE_ENV=production"
    );

    // Remote refs need egress the enclave does not have: fail closed.
    let harness = compute_harness(&healthy_overlay());
    let error = handle_compute_execute(&harness.state, &json!({ "encrypted_params_ref": "ref-1" }))
        .expect_err("ref lane fails closed");
    assert_eq!(error.status, 503);
    assert_eq!(
        error.message,
        "encrypted-confidential refs (remote claim) are not served by the Rust enclave host yet"
    );

    // With key material configured, a non-envelope ciphertext is the child's
    // parse error.
    let overlay = [
        ("MORPHEUS_NETWORK", TEST_NETWORK),
        ("NITRO_API_TOKEN", "s3cret"),
        ("MORPHEUS_ORACLE_KEY_MATERIAL_JSON", KEY_MATERIAL_JSON),
    ];
    let harness = compute_harness(&overlay);
    let error = handle_compute_execute(&harness.state, &json!({ "encrypted_params": "AAAA" }))
        .expect_err("garbage ciphertext is a parse error");
    assert_eq!(
        error.message,
        "unsupported confidential payload format; expected X25519-HKDF-SHA256-AES-256-GCM"
    );

    // A well-formed envelope encrypted to a DIFFERENT key fails authentication.
    let mut wrong_key_pkcs8 = vec![
        0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04,
        0x20,
    ];
    wrong_key_pkcs8.extend([7u8; 32]);
    let wrong_key_material = json!({
        "public_key_raw": RECIPIENT_PUBLIC_RAW_B64,
        "private_key_pkcs8": base64::engine::general_purpose::STANDARD.encode(&wrong_key_pkcs8),
    })
    .to_string();
    let overlay = [
        ("MORPHEUS_NETWORK", TEST_NETWORK),
        ("NITRO_API_TOKEN", "s3cret"),
        (
            "MORPHEUS_ORACLE_KEY_MATERIAL_JSON",
            wrong_key_material.as_str(),
        ),
    ];
    let harness = compute_harness(&overlay);
    let error = handle_compute_execute(
        &harness.state,
        &json!({ "encrypted_params": VECTOR_3_CIPHERTEXT }),
    )
    .expect_err("wrong recipient key fails authentication");
    assert_eq!(error.message, "aes-gcm decryption failed");
}

#[test]
fn production_confidential_decrypt_accepts_only_kms_materialized_key_source() {
    let plaintext = [
        ("MORPHEUS_NETWORK", TEST_NETWORK),
        ("NITRO_API_TOKEN", "s3cret"),
        ("NODE_ENV", "production"),
        ("MORPHEUS_ORACLE_KEY_MATERIAL_JSON", KEY_MATERIAL_JSON),
    ];
    let harness = compute_harness(&plaintext);
    let error = handle_compute_execute(
        &harness.state,
        &json!({ "function": "hash.sha256", "encrypted_params": VECTOR_3_CIPHERTEXT }),
    )
    .expect_err("plaintext production key must be rejected");
    assert_eq!(error.status, 503);
    assert_eq!(
        error.message,
        "plaintext configured oracle private key material is forbidden in production"
    );

    let kms_materialized = [
        ("MORPHEUS_NETWORK", TEST_NETWORK),
        ("NITRO_API_TOKEN", "s3cret"),
        ("NODE_ENV", "production"),
        ("MORPHEUS_ORACLE_KEY_MATERIAL_JSON", KEY_MATERIAL_JSON),
        ("MORPHEUS_ORACLE_KEY_SOURCE", "nitro-recipient-kms"),
    ];
    let harness = compute_harness(&kms_materialized);
    let response = handle_compute_execute(
        &harness.state,
        &json!({
            "function": "hash.sha256",
            "encrypted_params": VECTOR_3_CIPHERTEXT,
        }),
    )
    .expect("KMS-materialized production key decrypts");
    assert_eq!(response["mode"], "builtin");
}

#[test]
fn caller_key_material_is_rejected_after_compute_and_never_attests() {
    let harness = compute_harness(&healthy_overlay());
    let error = handle_compute_execute(
        &harness.state,
        &json!({
            "function": "hash.sha256",
            "input": {},
            "private_key": "aa".repeat(32),
        }),
    )
    .expect_err("caller key material is rejected");
    assert_eq!(error.status, 400);
    assert_eq!(
        error.message,
        "caller-supplied signing key material (private_key/signing_key/wif) is not accepted on this signing lane; the enclave-resident key is used instead"
    );
    // The rejection fires in the ENVELOPE build: compute already ran, and the
    // signer plane was never touched.
    assert!(harness.signer.sign_calls().is_empty());

    // The legacy environment switch cannot reopen this boundary.
    let mut overlay = healthy_overlay();
    overlay.push(("MORPHEUS_ALLOW_CALLER_SIGNING_KEY", "true"));
    let harness = compute_harness(&overlay);
    let error = handle_compute_execute(
        &harness.state,
        &json!({
            "function": "hash.sha256",
            "input": {},
            "signing_key": "bb".repeat(32),
            "include_attestation": true,
        }),
    )
    .expect_err("caller key switch is ignored");
    assert_eq!(error.status, 400);
    assert!(harness.signer.sign_calls().is_empty());
    assert!(harness.attest.calls().is_empty());
}

#[test]
fn attestation_gate_follows_the_normalize_boolean_contract() {
    let emit = |payload: serde_json::Value| {
        let harness = compute_harness(&healthy_overlay());
        let response = handle_compute_execute(&harness.state, &payload).expect("executes");
        response["tee_attestation"].clone()
    };

    // Default: no attestation.
    assert_eq!(
        emit(json!({ "function": "hash.sha256", "input": {} })),
        serde_json::Value::Null
    );
    // include_attestation / emit_attestation / env, in ?? order.
    let attested = emit(json!({
        "function": "hash.sha256",
        "input": {},
        "include_attestation": true,
    }));
    assert_eq!(attested["runtime"], "aws-nitro");
    assert_eq!(
        attested["attestation_document"],
        base64::engine::general_purpose::STANDARD.encode(b"doc")
    );
    // report_data rides the RAW output hash bytes (0x-prefixed hex).
    let output_hash = attested["report_data"]
        .as_str()
        .and_then(|value| value.strip_prefix("0x"))
        .expect("0x-prefixed report_data");
    assert_eq!(output_hash.len(), 64);

    assert_eq!(
        emit(json!({
            "function": "hash.sha256",
            "input": {},
            "emit_attestation": "1",
        })),
        attested
    );
    let mut overlay = healthy_overlay();
    overlay.push(("NITRO_EMIT_ATTESTATION", "yes"));
    let harness = compute_harness(&overlay);
    let response = handle_compute_execute(
        &harness.state,
        &json!({ "function": "hash.sha256", "input": {} }),
    )
    .expect("executes");
    assert_eq!(response["tee_attestation"]["runtime"], "aws-nitro");

    // normalizeBoolean: '' falls back, 'on' is NOT accepted, and the values
    // the child accepts are exactly 1/true/yes.
    assert_eq!(
        emit(json!({
            "function": "hash.sha256",
            "input": {},
            "include_attestation": "",
        })),
        serde_json::Value::Null
    );
    assert_eq!(
        emit(json!({
            "function": "hash.sha256",
            "input": {},
            "include_attestation": "on",
        })),
        serde_json::Value::Null
    );

    // SVC-D-5: a requested-but-failed attestation is NOT best-effort null.
    // See `a_requested_attestation_that_fails_refuses_the_lane` below.
}

// ---------------------------------------------------------------------------
// SVC-D-5 — a requested attestation that fails refuses the lane (CL-33)
// ---------------------------------------------------------------------------

/// The old behaviour returned a custody-SIGNED result with
/// `tee_attestation: null` when the NSM was unavailable — byte-identical to
/// `include_attestation: false`. A caller could not tell "I did not ask for a
/// proof" from "the enclave could not produce one", so the absence of the
/// enclave's proof of itself was invisible and a signed result went out
/// anyway.
#[test]
fn a_requested_attestation_that_fails_refuses_the_lane() {
    let harness = test_state(
        &healthy_overlay(),
        FakeAttest::failing("nsm down"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::default(),
    );
    let error = handle_compute_execute(
        &harness.state,
        &json!({
            "function": "hash.sha256",
            "input": {},
            "include_attestation": true,
        }),
    )
    .expect_err("a requested proof that cannot be produced must not be silently dropped");
    assert_eq!(error.status, 503);
    assert!(
        error.message.contains("nsm attestation helper failed"),
        "{}",
        error.message
    );
}

/// The two deliberate opt-outs are untouched: a caller that did not ask still
/// gets a 200 with a null proof, because there is nothing missing.
#[test]
fn not_asking_for_an_attestation_is_still_a_null_not_a_refusal() {
    let harness = test_state(
        &healthy_overlay(),
        FakeAttest::failing("nsm down"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::default(),
    );
    let response = handle_compute_execute(
        &harness.state,
        &json!({ "function": "hash.sha256", "input": {} }),
    )
    .expect("an unrequested attestation is not a failure");
    assert_eq!(response["tee_attestation"], serde_json::Value::Null);
}

#[test]
fn missing_signer_key_fails_the_signed_lane_closed() {
    let harness = test_state(
        &healthy_overlay(),
        FakeAttest::with_document(b"doc"),
        FakeSigner::unconfigured(),
        FakeBridge::new(),
        FakeKms::default(),
    );
    let error = handle_compute_execute(
        &harness.state,
        &json!({ "function": "hash.sha256", "input": {} }),
    )
    .expect_err("no custody key cannot produce a successful signed response");
    assert_eq!(error.status, 503);
    assert!(error.message.contains("worker custody key is unavailable"));
}

#[test]
fn explicit_unknown_network_is_rejected_before_custody_signing() {
    let harness = compute_harness(&healthy_overlay());
    let error = handle_compute_execute(
        &harness.state,
        &json!({
            "function": "hash.sha256",
            "input": {},
            "network": "staging"
        }),
    )
    .expect_err("an unknown network must not be mapped to testnet");
    assert_eq!(error.status, 400);
    assert!(error.message.contains("unsupported Neo network"));
    assert!(harness.signer.sign_calls().is_empty());
}

#[test]
fn disabled_wrong_network_unreachable_and_incomplete_custody_fail_with_503() {
    for issue in [
        "worker: custody key is disabled",
        "worker: custody key is on mainnet, not testnet",
        "worker: the custody service is unreachable",
    ] {
        let signer = FakeSigner::new(SignerConfig {
            healthy: false,
            issues: vec![issue.to_string()],
            ..SignerConfig::default()
        });
        let harness = test_state(
            &healthy_overlay(),
            FakeAttest::with_document(b"doc"),
            signer,
            FakeBridge::new(),
            FakeKms::default(),
        );
        let error = handle_compute_execute(
            &harness.state,
            &json!({ "function": "hash.sha256", "input": {} }),
        )
        .expect_err(issue);
        assert_eq!(error.status, 503, "{issue}");
    }

    let signer = FakeSigner::new(SignerConfig {
        sign_result: Some(Ok(json!({
            "signature": "00",
            "public_key": "",
            "address": "address",
            "script_hash": "0x01",
        }))),
        ..SignerConfig::default()
    });
    let harness = test_state(
        &healthy_overlay(),
        FakeAttest::with_document(b"doc"),
        signer,
        FakeBridge::new(),
        FakeKms::default(),
    );
    let error = handle_compute_execute(
        &harness.state,
        &json!({ "function": "hash.sha256", "input": {} }),
    )
    .expect_err("incomplete custody response");
    assert_eq!(error.status, 503);
    assert!(error.message.contains("incomplete"));
}

#[test]
fn mode_dispatch_target_chain_and_chain_id_match_the_child() {
    // mode: a whitespace string is JS-TRUTHY, so the chain stops there, the
    // single trim collapses it to '', and `|| 'script'` picks the standalone
    // lane — which then fails on the missing script source.
    let harness = compute_harness(&healthy_overlay());
    let error = handle_compute_execute(
        &harness.state,
        &json!({ "mode": "  ", "function": "hash.sha256", "input": {} }),
    )
    .expect_err("whitespace mode collapses to the standalone lane");
    assert_eq!(error.message, "script or script_base64 required");

    let response = handle_compute_execute(
        &harness.state,
        &json!({ "compute_fn": "hash.sha256", "input": {} }),
    )
    .expect("compute_fn selects builtin");
    assert_eq!(response["mode"], "builtin");

    // A script without a script source is the standalone lane's error.
    let harness = compute_harness(&healthy_overlay());
    let error = handle_compute_execute(&harness.state, &json!({ "mode": "script" }))
        .expect_err("standalone lane runs");
    assert_eq!(error.message, "script or script_base64 required");

    // target_chain normalization + rejection with the RAW value interpolated.
    let harness = compute_harness(&healthy_overlay());
    let response = handle_compute_execute(
        &harness.state,
        &json!({ "function": "hash.sha256", "input": {}, "target_chain": " NEOX " }),
    )
    .expect("neox is a supported target");
    assert_eq!(response["target_chain"], "neox");

    let error = handle_compute_execute(
        &harness.state,
        &json!({ "function": "hash.sha256", "input": {}, "target_chain": "polkadot" }),
    )
    .expect_err("unsupported target chain");
    assert_eq!(error.message, "unsupported target_chain: polkadot");

    // target_chain_id: truthy → String(), falsy → null.
    let harness = compute_harness(&healthy_overlay());
    let response = handle_compute_execute(
        &harness.state,
        &json!({ "function": "hash.sha256", "input": {}, "target_chain_id": 42 }),
    )
    .expect("executes");
    assert_eq!(response["target_chain_id"], "42");
    let response = handle_compute_execute(
        &harness.state,
        &json!({ "function": "hash.sha256", "input": {}, "target_chain_id": "" }),
    )
    .expect("executes");
    assert_eq!(response["target_chain_id"], serde_json::Value::Null);
}

#[test]
fn script_lane_computes_in_process_and_signs_the_standalone_shape() {
    let mut overlay = healthy_overlay();
    overlay.push(("MORPHEUS_ENABLE_UNTRUSTED_SCRIPTS", "true"));
    let harness = compute_harness(&overlay);
    let response = handle_compute_execute(
        &harness.state,
        &json!({
            "mode": "script",
            "script": "function process(input) { return { echo: input }; }",
            "input": { "n": 21 },
        }),
    )
    .expect("script lane executes");

    let result = json!({
        "runtime": "script",
        "entry_point": "process",
        "result": { "echo": { "n": 21 } },
    });
    let (output_hash, _) = expected_envelope(&result);
    assert_eq!(response["mode"], "script");
    assert_eq!(response["runtime"], "script");
    assert_eq!(response["entry_point"], "process");
    assert_eq!(response["result"], json!({ "echo": { "n": 21 } }));
    assert_eq!(response["output_hash"], output_hash);
    assert_eq!(response["signature"], "00");
    assert!(harness.bridge.forwards().is_empty());
}

#[test]
fn dispatch_classifies_and_auth_gates_the_flipped_route() {
    assert_eq!(
        crate::routes::classify("POST", "/compute/execute"),
        crate::routes::Target::ComputeExecute,
    );
    assert_eq!(
        crate::routes::classify("POST", "/testnet/compute/execute"),
        crate::routes::Target::ComputeExecute,
    );
    // GET is not the compute method: method mismatch falls to NotFound.
    assert_eq!(
        crate::routes::classify("GET", "/compute/execute"),
        crate::routes::Target::NotFound,
    );
    let harness = compute_harness(&healthy_overlay());
    let outcome = crate::dispatch::dispatch(
        &harness.state,
        "POST",
        "/compute/execute",
        &http::HeaderMap::new(),
        r#"{"function":"hash.sha256","input":{}}"#,
    );
    assert_eq!(outcome.status, 401);

    let outcome = crate::dispatch::dispatch(
        &harness.state,
        "POST",
        "/compute/execute",
        &bearer("s3cret"),
        r#"{"function":"hash.sha256","input":{}}"#,
    );
    assert_eq!(outcome.status, 200);
    assert_eq!(outcome.body["mode"], "builtin");
}

// ---------------------------------------------------------------------------
// CU-148: the two branches that stood in for unfinished work.
//
// The ephemeral branch is implemented (the crypto already existed in
// `neo_os_compute::oracle::crypto` and is unit-tested there); the sealed-keystore
// branch is removed, because the only way it could produce a wrap key is the
// legacy Secrets Manager master derivation this host refuses by policy, so it
// could never have succeeded here.
// ---------------------------------------------------------------------------

/// The overlay as the fold sees it, plus the same trimming reader the fold builds
/// (`compute_execute.rs:62`). The trim matters: the production check compares the
/// trimmed value, so a padded `NODE_ENV` must still be recognised.
fn material_env(
    overlay: &[(&str, &str)],
) -> (
    std::collections::BTreeMap<String, String>,
    impl Fn(&str) -> String,
) {
    let map: std::collections::BTreeMap<String, String> = overlay
        .iter()
        .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
        .collect();
    let lookup = map.clone();
    (map, move |name: &str| {
        lookup
            .get(name)
            .map(|value| value.trim().to_string())
            .unwrap_or_default()
    })
}

#[test]
fn an_ephemeral_key_is_generated_outside_production_when_no_stable_source_exists() {
    let (overlay, env_trim) = material_env(&[
        ("MORPHEUS_NETWORK", TEST_NETWORK),
        ("MORPHEUS_ALLOW_EPHEMERAL_KEY", "true"),
    ]);
    let key = oracle_key_material(&overlay, &env_trim).expect("an ephemeral key");
    assert_eq!(key.source, "ephemeral-memory");
    assert_eq!(key.algorithm, "X25519-HKDF-SHA256-AES-256-GCM");
    // A real key pair, not a placeholder: the public half is 32 bytes.
    assert_eq!(key.public_key_raw_bytes.len(), 32);
    assert!(!key.private_key_pkcs8_bytes.is_empty());
}

#[test]
fn an_ephemeral_key_never_reaches_production() {
    // The production refusal stands and runs before the key is generated, so the
    // fact that the branch now works cannot widen production's attack surface.
    for node_env in ["production", " PrOdUcTiOn "] {
        let (overlay, env_trim) = material_env(&[
            ("MORPHEUS_NETWORK", TEST_NETWORK),
            ("MORPHEUS_ALLOW_EPHEMERAL_KEY", "true"),
            ("NODE_ENV", node_env),
        ]);
        let error = oracle_key_material(&overlay, &env_trim).expect_err("production refuses");
        assert_eq!(error.status, 400, "{node_env}");
        assert_eq!(
            error.message,
            "MORPHEUS_ALLOW_EPHEMERAL_KEY is not allowed when NODE_ENV=production"
        );
    }
}

#[test]
fn an_ephemeral_key_is_not_reachable_unless_the_flag_is_set() {
    // Without the flag the request fails closed exactly as before: opening the
    // branch must not make an ephemeral key the silent default.
    let (overlay, env_trim) = material_env(&[("MORPHEUS_NETWORK", TEST_NETWORK)]);
    let error = oracle_key_material(&overlay, &env_trim).expect_err("no flag, no key");
    assert_eq!(error.status, 400);
    assert_eq!(
        error.message,
        "oracle key material unavailable: no configured key or provisioned KMS ciphertext, and no ephemeral key allowed"
    );
}

#[test]
fn a_configured_key_still_wins_over_an_ephemeral_one() {
    // The order is unchanged: a configured or provisioned source is used, and the
    // ephemeral branch is only ever the last resort.
    let (overlay, env_trim) = material_env(&[
        ("MORPHEUS_NETWORK", TEST_NETWORK),
        ("MORPHEUS_ALLOW_EPHEMERAL_KEY", "true"),
        ("MORPHEUS_ORACLE_KEY_MATERIAL_JSON", KEY_MATERIAL_JSON),
    ]);
    let key = oracle_key_material(&overlay, &env_trim).expect("the configured key");
    assert_ne!(key.source, "ephemeral-memory");
    assert_eq!(key.public_key_raw, RECIPIENT_PUBLIC_RAW_B64);
}

#[test]
fn a_sealed_keystore_no_longer_claims_a_capability_this_host_lacks() {
    // The stub is gone, so a sealed keystore lands on the ordinary unavailable
    // error rather than a 503 advertising an unsealing path that cannot run here.
    for name in [
        "MORPHEUS_ORACLE_SEALED_KEYSTORE_JSON",
        "MORPHEUS_ORACLE_SEALED_KEYSTORE_BASE64",
    ] {
        let (overlay, env_trim) = material_env(&[
            ("MORPHEUS_NETWORK", TEST_NETWORK),
            (
                name,
                r#"{"public_key_raw":"AA==","sealed_private_key":"BB=="}"#,
            ),
        ]);
        let error = oracle_key_material(&overlay, &env_trim).expect_err("unavailable");
        assert_eq!(error.status, 400, "{name}");
        assert_eq!(
            error.message,
            "oracle key material unavailable: no configured key or provisioned KMS ciphertext, and no ephemeral key allowed",
            "{name}"
        );
        // And with the ephemeral flag it is still refused: the sealed env does not
        // silently become an ephemeral key.
        let mut overlay_with_flag = overlay.clone();
        overlay_with_flag.insert(
            "MORPHEUS_ALLOW_EPHEMERAL_KEY".to_string(),
            "true".to_string(),
        );
        let env_trim = {
            let lookup = overlay_with_flag.clone();
            move |name: &str| {
                lookup
                    .get(name)
                    .map(|value| value.trim().to_string())
                    .unwrap_or_default()
            }
        };
        let key = oracle_key_material(&overlay_with_flag, &env_trim).expect("ephemeral");
        assert_eq!(key.source, "ephemeral-memory", "{name}");
    }
}

#[test]
fn an_ephemeral_key_is_minted_per_resolution_and_never_leaks_between_requests() {
    // This is the sharp edge of the branch, pinned rather than left to a comment:
    // `docs/ENVIRONMENT.md` calls the ephemeral key process-lifetime, but the
    // resolution runs per request, so two resolutions produce two different keys.
    // That matches the sibling `/oracle/key` lane today and it is why the key cannot
    // carry a ciphertext across requests — but it must never silently become a
    // STABLE key, which is the failure that would matter. Two calls must differ.
    let (overlay, env_trim) = material_env(&[
        ("MORPHEUS_NETWORK", TEST_NETWORK),
        ("MORPHEUS_ALLOW_EPHEMERAL_KEY", "true"),
    ]);
    let first = oracle_key_material(&overlay, &env_trim).expect("first key");
    let second = oracle_key_material(&overlay, &env_trim).expect("second key");
    assert_ne!(
        first.public_key_raw_bytes, second.public_key_raw_bytes,
        "an ephemeral key must not be reused across resolutions"
    );
}
