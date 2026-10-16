//! Exercise the effective handler input, including decrypted fields. These
//! calls deliberately bypass HTTP selection, as automation and fulfillment do.
use crate::{state::AppState, RuntimeError};
use neo_os_compute::oracle::crypto::{
    AES_GCM_IV_LENGTH_BYTES, AES_GCM_TAG_LENGTH_BYTES, ORACLE_ENVELOPE_ALGORITHM,
    ORACLE_ENVELOPE_INFO, ORACLE_ENVELOPE_VERSION,
};
use serde_json::{json, Value};

#[path = "support.rs"]
#[allow(clippy::duplicate_mod)]
mod support;
use support::*;

fn harness(network: &str) -> TestState {
    let h = test_state(
        &[
            ("MORPHEUS_NETWORK", network),
            ("SUPABASE_URL", "https://database.example"),
            ("SUPABASE_SECRET_KEY", "fixture-only"),
            ("MORPHEUS_ALLOW_EPHEMERAL_KEY", "true"),
            ("NEODID_SECRET_SALT", "fixture"),
            ("MORPHEUS_NEODID_ALLOW_UNVERIFIED_UID", "true"),
            (
                "MORPHEUS_NEODID_RECOVERY_ALLOW_UNVERIFIED_PROVIDERS",
                "twitter",
            ),
        ],
        FakeAttest::with_document(b"doc"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::default(),
    );
    h.oracle_io
        .set_reply(Ok(neo_os_compute::transport::HttpResponse {
            status: 200,
            headers: vec![("content-type".into(), "application/json".into())],
            body: br#"{"answer":42}"#.to_vec(),
        }));
    h
}

fn payload(route: &str) -> Value {
    match route {
        "compute" => json!({"function":"hash.sha256","input":{"network":"application-data"}}),
        "oracle" => json!({"url":"https://example.com/data"}),
        "bind" => json!({"provider":"twitter","provider_uid":"uid-1",
            "vault_account":"0x11223344556677889900aabbccddeeff00112233"}),
        _ => unreachable!(),
    }
}

fn invoke(state: &AppState, route: &str, body: &Value) -> Result<Value, RuntimeError> {
    match route {
        "compute" => crate::compute_execute::handle_compute_execute(state, body),
        "oracle" => crate::oracle_read::handle_oracle_query(state, body).map(|out| out.body),
        "bind" => crate::neodid::handle_neo_did_bind(state, body),
        _ => unreachable!(),
    }
}

fn confidential(h: &TestState, outer: &Value, fields: &Value) -> Value {
    let key = crate::oracle_read::handle_oracle_public_key(&h.state, &json!({})).unwrap();
    let sealed = seal_to_public_key(
        key.body["public_key"].as_str().unwrap(),
        &fields.to_string(),
    );
    let mut body = outer.clone();
    body["encrypted_params"] = json!(sealed);
    body
}

#[test]
fn direct_handlers_refuse_every_foreign_alias_before_work() {
    for network in ["mainnet", "testnet"] {
        let other = if network == "mainnet" {
            "testnet"
        } else {
            "mainnet"
        };
        for route in ["compute", "oracle", "bind"] {
            for alias in [
                "network",
                "morpheus_network",
                "runtime_network",
                "environment",
            ] {
                let h = harness(network);
                let mut body = payload(route);
                body["network"] = json!(network); // lower-priority aliases must not be ignored
                body[alias] = json!(other);
                let error = invoke(&h.state, route, &body).expect_err("foreign context refused");
                assert_eq!(error.status, 400, "{route}/{alias}");
                assert!(h.signer.sign_calls().is_empty(), "{route}/{alias}: signing");
                assert!(h.oracle_io.fetches().is_empty(), "{route}/{alias}: egress");
            }
        }
    }
}

#[test]
fn encrypted_overrides_are_checked_after_decryption_before_work() {
    for route in ["compute", "oracle", "bind"] {
        for alias in [
            "network",
            "morpheus_network",
            "runtime_network",
            "environment",
        ] {
            let h = harness("testnet");
            let mut outer = payload(route);
            outer["network"] = json!("testnet");
            let body = confidential(&h, &outer, &json!({alias:"mainnet"}));
            let error = invoke(&h.state, route, &body).expect_err("decrypted context refused");
            assert_eq!(error.status, 400, "{route}/{alias}");
            assert!(h.signer.sign_calls().is_empty(), "{route}/{alias}: signing");
            assert!(h.oracle_io.fetches().is_empty(), "{route}/{alias}: egress");
        }
    }
}

#[test]
fn matching_plain_and_encrypted_contexts_still_execute() {
    for network in ["mainnet", "testnet"] {
        for route in ["compute", "oracle", "bind"] {
            for encrypted in [false, true] {
                let h = harness(network);
                let aliases = json!({"network":network,"morpheus_network":network,
                    "runtime_network":network,"environment":network});
                let mut body = payload(route);
                if encrypted {
                    body = confidential(&h, &body, &aliases);
                } else {
                    body.as_object_mut()
                        .unwrap()
                        .extend(aliases.as_object().unwrap().clone());
                }
                invoke(&h.state, route, &body).expect("matching context executes");
                let calls = h.signer.sign_calls();
                assert!(!calls.is_empty());
                assert!(calls.iter().all(|call| call.0 == network));
            }
        }
    }
}

#[test]
fn foreign_context_precedes_compute_errors_and_confidential_reference_egress() {
    let h = harness("testnet");
    let error = invoke(
        &h.state,
        "compute",
        &json!({"network":"mainnet","function":"unknown"}),
    )
    .expect_err("foreign context");
    assert!(error.message.contains("network"), "{}", error.message);
    let error = invoke(
        &h.state,
        "compute",
        &json!({
            "network":"mainnet", "function":"hash.sha256", "encrypted_params":"AAAA"
        }),
    )
    .expect_err("reject foreign context before trying its ciphertext");
    assert!(error.message.contains("network"), "{}", error.message);
    let error = invoke(
        &h.state,
        "oracle",
        &json!({"network":"mainnet",
        "encrypted_params_ref":"fixture-ref", "request_id":"fixture-request"}),
    )
    .expect_err("foreign context");
    assert!(error.message.contains("network"), "{}", error.message);
    assert!(h.oracle_io.fetches().is_empty());
    // The same local transport is actually exercised by a matching reference;
    // this cannot pass just because the fixture disables the reference lane.
    h.oracle_io
        .set_reply(Ok(neo_os_compute::transport::HttpResponse {
            status: 200,
            headers: vec![],
            body: b"[]".to_vec(),
        }));
    let error = invoke(
        &h.state,
        "oracle",
        &json!({"network":"testnet",
        "encrypted_params_ref":"fixture-ref", "request_id":"fixture-request"}),
    )
    .expect_err("matching reference lookup reaches the empty local store");
    assert!(error.message.contains("not found"), "{}", error.message);
    assert_eq!(h.oracle_io.fetches().len(), 1);
}

#[test]
fn recovery_chain_family_keeps_case_and_whitespace_compatibility() {
    for family in ["neo_n3", "NEO_N3", " neo_n3 ", "neox", " NEOX "] {
        let body = json!({"network":family});
        crate::network_profiles::select_request(
            "POST",
            "/testnet/neodid/recovery-ticket",
            &http::HeaderMap::new(),
            &body.to_string(),
        )
        .expect("chain family is not deployment context");
    }
}

fn seal_to_public_key(recipient_public_key_b64: &str, plaintext: &str) -> String {
    use aws_lc_rs::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM};
    use aws_lc_rs::agreement::{agree_ephemeral, EphemeralPrivateKey, UnparsedPublicKey, X25519};
    use aws_lc_rs::rand::{SecureRandom as _, SystemRandom};
    use base64::Engine as _;
    use hkdf::Hkdf;
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
