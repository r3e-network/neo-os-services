//! Auth/provision doubles only: no issuer, crypto signature, real KMS or socket.
//! Reuses the existing provision harness. Compilation/execution needs its own
//! native allocation; these fixtures do not establish server JWT verification.
use super::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde_json::Value;
use std::sync::atomic::Ordering;

const AUTH_CIPHER: &str = "relayer-auth-ciphertext-synthetic";
const ISSUER: &str = "https://issuer.invalid";
const SUBJECT: &str = "testnet-relayer";

fn unsigned_claims() -> Value {
    json!({"role":"neoos_relayer_caller","aud":"authenticated","iss":ISSUER,
        "sub":SUBJECT,"neoos_network":"testnet","scope":"neoos/relayer-delivery/v2",
        "neoos_epoch":1,"exp":2000})
}

fn unsigned_token(claims: &Value) -> String {
    format!("{}.{}.c3ludGhldGljLW5vdC1hLXNpZ25hdHVyZQ",
        URL_SAFE_NO_PAD.encode(br#"{"alg":"RS256"}"#),
        URL_SAFE_NO_PAD.encode(claims.to_string()))
}

fn auth_envelope(version: u64, claims: &Value) -> Value {
    json!({"purpose":crate::relayer_auth::PURPOSE,"network":"testnet",
        "version":version,"jwt":unsigned_token(claims)})
}

fn auth_state(kms: FakeKms, gate: &str) -> TestState {
    let mut pairs = vec![("NODE_ENV", "test"), ("MORPHEUS_NETWORK", "testnet"),
        ("NITRO_API_TOKEN", STATIC_TOKEN), ("AWS_REGION", "us-east-1"),
        (crate::relayer_auth::GATE, gate), ("MORPHEUS_RELAYER_JWT_ISSUER", ISSUER),
        ("MORPHEUS_RELAYER_CALLER_ID", SUBJECT),
        ("MORPHEUS_RELAYER_STORE_URL", "https://store.invalid")];
    pairs.extend_from_slice(AWS_PAIRS);
    let h = bootstrap(&pairs, kms);
    h.oracle_io.set_now_ms(1_000_000);
    h
}

fn payload(ciphertext: &str) -> Value {
    let mut env = serde_json::Map::new();
    env.insert(crate::relayer_auth::CIPHERTEXT_ENV.into(), json!(ciphertext));
    json!({"env":env})
}

fn installed(h: &TestState) -> (u64, String, Option<String>) {
    let overlay = h.state.overlay.read().unwrap();
    let credential = overlay.relayer_auth().expect("installed credential");
    (credential.version, credential.jwt().to_string(),
        overlay.get(crate::relayer_auth::CIPHERTEXT_ENV).map(str::to_string))
}

fn install_first(h: &TestState) {
    h.state.runtime_token_kms_version.store(1, Ordering::SeqCst);
    crate::relayer_auth::refresh(&h.state, &payload(AUTH_CIPHER)).unwrap();
}

#[test]
fn refresh_default_off_and_unauthorized_requests_do_not_release_material() {
    let off = auth_state(FakeKms::default(), "false");
    let result = dispatch(&off.state, "POST", "/provision/relayer-auth",
        &bearer(STATIC_TOKEN), &body_json(&payload(AUTH_CIPHER)));
    assert_eq!(result.status, 404);
    assert!(off.kms.calls().is_empty());

    let on = auth_state(FakeKms::default(), "true");
    for headers in [http::HeaderMap::new(), bearer("wrong-synthetic-bearer")] {
        let result = dispatch(&on.state, "POST", "/provision/relayer-auth",
            &headers, &body_json(&payload(AUTH_CIPHER)));
        assert_eq!(result.status, 401);
    }
    assert!(on.kms.calls().is_empty());
}

#[test]
fn refresh_requires_provisioned_runtime_before_any_release() {
    let h = auth_state(FakeKms::default(), "true");
    let result = dispatch(&h.state, "POST", "/provision/relayer-auth",
        &bearer(STATIC_TOKEN), &body_json(&payload(AUTH_CIPHER)));
    assert_eq!(result.status, 409);
    assert!(h.kms.calls().is_empty());
    assert!(h.state.overlay.read().unwrap().relayer_auth().is_none());
}

#[test]
fn wrong_envelope_context_never_installs_a_credential() {
    for (key, value) in [("purpose", json!("neoos/nitro-runtime-auth/v1")),
        ("network", json!("mainnet")), ("version", json!(0)),
        ("version", json!("1")), ("jwt", json!(null))] {
        let mut envelope = auth_envelope(1, &unsigned_claims()); envelope[key] = value;
        let h = auth_state(FakeKms::releasing(AUTH_CIPHER, serde_json::to_vec(&envelope).unwrap()), "true");
        h.state.runtime_token_kms_version.store(1, Ordering::SeqCst);
        assert_eq!(crate::relayer_auth::refresh(&h.state, &payload(AUTH_CIPHER)).unwrap_err().status, 400, "{key}");
        let overlay = h.state.overlay.read().unwrap();
        assert!(overlay.relayer_auth().is_none());
        assert!(overlay.get(crate::relayer_auth::CIPHERTEXT_ENV).is_none());
        let calls = h.kms.calls(); assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].purpose, crate::relayer_auth::PURPOSE);
        assert_eq!(calls[0].network, "testnet");
    }
}

#[test]
fn successful_initial_provision_installs_auth_with_runtime_atomically() {
    let h = auth_state(FakeKms::releasing(AUTH_CIPHER,
        serde_json::to_vec(&auth_envelope(1, &unsigned_claims())).unwrap()), "true");
    let result = crate::provision::handle_provision(&h.state, &payload(AUTH_CIPHER),
        Some(crate::provision::MaterializedToken {token:RELEASED_TOKEN.into(), version:1})).unwrap();
    assert_eq!(h.state.runtime_token_kms_version.load(Ordering::SeqCst), 1);
    assert_eq!(installed(&h).0, 1);
    assert!(!result.to_string().contains(&unsigned_token(&unsigned_claims())));
    assert!(h.oracle_io.fetches().is_empty());
}

#[test]
fn failed_initial_auth_does_not_leave_partial_runtime_or_overlay() {
    let mut envelope = auth_envelope(1, &unsigned_claims()); envelope["network"] = json!("mainnet");
    let h = auth_state(FakeKms::releasing(AUTH_CIPHER, serde_json::to_vec(&envelope).unwrap()), "true");
    let before = h.state.overlay.read().unwrap().merged_map();
    let result = crate::provision::handle_provision(&h.state, &payload(AUTH_CIPHER),
        Some(crate::provision::MaterializedToken {token:RELEASED_TOKEN.into(), version:1}));
    assert_eq!(result.unwrap_err().status, 400);
    assert_eq!(h.state.runtime_token_kms_version.load(Ordering::SeqCst), 0);
    assert_eq!(h.state.overlay.read().unwrap().merged_map(), before);
    assert!(h.state.overlay.read().unwrap().relayer_auth().is_none());
}

#[test]
fn refresh_version_replay_preserves_previous_material_and_boot_pins() {
    let kms = FakeKms::releasing(AUTH_CIPHER, serde_json::to_vec(&auth_envelope(1, &unsigned_claims())).unwrap());
    let h = auth_state(kms.clone(), "true"); install_first(&h);
    let before = installed(&h);
    kms.set_result("stale-synthetic", Ok(serde_json::to_vec(&auth_envelope(1, &unsigned_claims())).unwrap()));
    assert_eq!(crate::relayer_auth::refresh(&h.state, &payload("stale-synthetic")).unwrap_err().status, 409);
    assert_eq!(installed(&h), before);

    let mut next = unsigned_claims(); next["jti"] = json!("next-synthetic");
    kms.set_result("next-synthetic", Ok(serde_json::to_vec(&auth_envelope(2, &next)).unwrap()));
    let result = crate::relayer_auth::refresh(&h.state, &payload("next-synthetic")).unwrap();
    assert_eq!(installed(&h).0, 2);
    assert_eq!(installed(&h).1, unsigned_token(&next));
    assert!(!result.to_string().contains(&unsigned_token(&next)));
    let overlay = h.state.overlay.read().unwrap();
    assert_eq!(overlay.get("MORPHEUS_RELAYER_STORE_URL"), Some("https://store.invalid"));
    assert_eq!(overlay.get("MORPHEUS_RELAYER_JWT_ISSUER"), Some(ISSUER));
    assert_eq!(overlay.get("MORPHEUS_RELAYER_CALLER_ID"), Some(SUBJECT));
    assert!(!format!("{:?}", overlay.relayer_auth().unwrap()).contains(&unsigned_token(&next)));
}

#[test]
fn refresh_rejects_endpoint_or_policy_fields_without_calling_kms() {
    let h = auth_state(FakeKms::default(), "true");
    h.state.runtime_token_kms_version.store(1, Ordering::SeqCst);
    for key in ["MORPHEUS_RELAYER_STORE_URL", "MORPHEUS_RELAYER_JWT_ISSUER",
        "MORPHEUS_RELAYER_CALLER_ID", "MORPHEUS_NETWORK", "SUPABASE_SERVICE_ROLE_KEY",
        "MORPHEUS_EMBEDDED_RELAYER"] {
        let mut body = payload(AUTH_CIPHER); body["env"][key] = json!("synthetic-retarget");
        assert_eq!(crate::relayer_auth::refresh(&h.state, &body).unwrap_err().status, 400, "{key}");
    }
    assert!(h.kms.calls().is_empty());
    assert!(h.state.overlay.read().unwrap().relayer_auth().is_none());
}

#[test]
fn wrong_claims_or_release_failure_cannot_replace_working_auth() {
    let kms = FakeKms::releasing(AUTH_CIPHER, serde_json::to_vec(&auth_envelope(1, &unsigned_claims())).unwrap());
    let h = auth_state(kms.clone(), "true"); install_first(&h);
    let before = installed(&h);
    for (key, value) in [("role", json!("service_role")), ("neoos_network", json!("mainnet")),
        ("iss", json!("https://other.invalid")), ("sub", json!("other-relayer")),
        ("scope", json!("admin")), ("exp", json!(1000))] {
        let mut claims = unsigned_claims(); claims[key] = value;
        kms.set_result("bad-synthetic", Ok(serde_json::to_vec(&auth_envelope(2, &claims)).unwrap()));
        assert_eq!(crate::relayer_auth::refresh(&h.state, &payload("bad-synthetic")).unwrap_err().status, 400, "{key}");
        assert_eq!(installed(&h), before);
    }
    kms.set_result("bad-synthetic", Err("synthetic release refused".into()));
    assert_eq!(crate::relayer_auth::refresh(&h.state, &payload("bad-synthetic")).unwrap_err().status, 503);
    assert_eq!(installed(&h), before);
}

#[test]
fn concurrent_refresh_keeps_highest_version_without_partial_ciphertext() {
    let kms = FakeKms::releasing(AUTH_CIPHER, serde_json::to_vec(&auth_envelope(1, &unsigned_claims())).unwrap());
    let h = auth_state(kms.clone(), "true"); install_first(&h);
    for version in [2, 3] {
        let mut claims = unsigned_claims(); claims["jti"] = json!(version);
        kms.set_result(&format!("refresh-{version}"), Ok(serde_json::to_vec(&auth_envelope(version, &claims)).unwrap()));
    }
    let results = std::thread::scope(|scope| {
        let a = scope.spawn(|| crate::relayer_auth::refresh(&h.state, &payload("refresh-2")));
        let b = scope.spawn(|| crate::relayer_auth::refresh(&h.state, &payload("refresh-3")));
        [a.join().unwrap(), b.join().unwrap()]
    });
    assert!(results[1].is_ok());
    assert!(results[0].is_ok() || results[0].as_ref().unwrap_err().status == 409);
    let mut claims = unsigned_claims(); claims["jti"] = json!(3);
    assert_eq!(installed(&h), (3, unsigned_token(&claims), Some("refresh-3".into())));
    assert_eq!(h.state.runtime_token_kms_version.load(Ordering::SeqCst), 1);
}
