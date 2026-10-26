//! Unsigned synthetic fixtures exercise consistency only, never JWT verification.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use neo_os_relayer::store_auth::{decode_consistent_claims, backoff_identity};
use serde_json::{json, Value};

fn claims() -> Value {
    json!({"role":"neoos_relayer_caller","aud":"authenticated","iss":"https://issuer.invalid",
        "sub":"mainnet-relayer","neoos_network":"mainnet","scope":"neoos/relayer-delivery/v2",
        "neoos_epoch":1,"exp":2000})
}
fn unsigned_fixture(value: &Value) -> String {
    format!("{}.{}.c3ludGhldGljLW5vdC1hLXNpZ25hdHVyZQ", URL_SAFE_NO_PAD.encode(br#"{"alg":"RS256"}"#), URL_SAFE_NO_PAD.encode(value.to_string()))
}
#[test]
fn local_claims_are_bound_but_do_not_verify_the_synthetic_signature() {
    let c = decode_consistent_claims(&unsigned_fixture(&claims()), "mainnet", "https://issuer.invalid", "mainnet-relayer", 1000).unwrap();
    assert_eq!(c.neoos_epoch, 1);
    assert_eq!(c.neoos_network, "mainnet");
}
#[test]
fn wrong_role_network_issuer_scope_subject_or_expiry_are_refused() {
    for (key, value) in [("role",json!("service_role")),("neoos_network",json!("testnet")),
        ("iss",json!("https://other.invalid")),("scope",json!("admin")),("sub",json!("other")),
        ("exp",json!(999)),("neoos_epoch",json!(0)),("neoos_epoch",json!("1")),("nbf",json!(1001))] {
        let mut c=claims();c[key]=value;
        assert!(decode_consistent_claims(&unsigned_fixture(&c), "mainnet", "https://issuer.invalid", "mainnet-relayer", 1000).is_err(), "{key}");
    }
}
#[test]
fn auth_refresh_keeps_backoff_and_other_scope_separates_it() {
    let a=decode_consistent_claims(&unsigned_fixture(&claims()), "mainnet", "https://issuer.invalid", "mainnet-relayer", 1000).unwrap();
    let mut next=claims();next["exp"]=json!(3000);next["jti"]=json!("refreshed");next["neoos_epoch"]=json!(2);
    let b=decode_consistent_claims(&unsigned_fixture(&next), "mainnet", "https://issuer.invalid", "mainnet-relayer", 1000).unwrap();
    assert_eq!(backoff_identity("https://store.invalid/rest/v1",&a),backoff_identity("https://store.invalid/rest/v1",&b));
    assert_ne!(backoff_identity("https://store.invalid/rest/v1",&a),backoff_identity("https://other.invalid/rest/v1",&a));
}

#[test]
fn missing_or_wrong_type_claims_do_not_acquire_local_consistency() {
    for key in ["role", "aud", "iss", "sub", "neoos_network", "scope", "neoos_epoch", "exp"] {
        let mut value = claims();
        value.as_object_mut().unwrap().remove(key);
        assert!(decode_consistent_claims(&unsigned_fixture(&value), "mainnet", "https://issuer.invalid", "mainnet-relayer", 1000).is_err(), "missing {key}");
    }
    for (key, value) in [("aud", json!(["authenticated"])), ("iss", json!(null)),
        ("sub", json!(true)), ("neoos_network", json!("mainnet ")),
        ("exp", json!("2000")), ("exp", json!(2000.5)), ("exp", json!(-1)),
        ("neoos_epoch", json!(true)), ("neoos_epoch", json!(1.5)), ("nbf", json!("0"))] {
        let mut c = claims(); c[key] = value;
        assert!(decode_consistent_claims(&unsigned_fixture(&c), "mainnet", "https://issuer.invalid", "mainnet-relayer", 1000).is_err(), "invalid {key}");
    }
}

#[test]
fn expiration_and_integer_boundaries_fail_closed() {
    let max = i64::MAX as u64;
    for (key, value) in [("exp", json!(1000)), ("exp", json!(max + 1)),
        ("neoos_epoch", json!(max + 1)), ("nbf", json!(max + 1))] {
        let mut c = claims(); c[key] = value;
        assert!(decode_consistent_claims(&unsigned_fixture(&c), "mainnet", "https://issuer.invalid", "mainnet-relayer", 1000).is_err(), "{key}");
    }
    let mut c = claims(); c["nbf"] = json!(1000); c["exp"] = json!(1001);
    assert!(decode_consistent_claims(&unsigned_fixture(&c), "mainnet", "https://issuer.invalid", "mainnet-relayer", 1000).is_ok());
}

#[test]
fn token_shape_none_algorithm_and_duplicate_security_claims_are_refused() {
    let valid = unsigned_fixture(&claims());
    for token in [String::new(), format!(" {valid}"), format!("{valid}.extra"),
        format!("{valid}="), "a".repeat(16_385)] {
        assert!(decode_consistent_claims(&token, "mainnet", "https://issuer.invalid", "mainnet-relayer", 1000).is_err());
    }
    for header in [r#"{"alg":"none"}"#, r#"{"alg":"NONE"}"#, r#"{"alg":""}"#] {
        let token = format!("{}.{}.c3ludGhldGlj", URL_SAFE_NO_PAD.encode(header), URL_SAFE_NO_PAD.encode(claims().to_string()));
        assert!(decode_consistent_claims(&token, "mainnet", "https://issuer.invalid", "mainnet-relayer", 1000).is_err());
    }
    let duplicate = claims().to_string().replacen('{', "{\"neoos_network\":\"testnet\",", 1);
    let token = format!("{}.{}.c3ludGhldGlj", URL_SAFE_NO_PAD.encode(br#"{"alg":"RS256"}"#), URL_SAFE_NO_PAD.encode(duplicate));
    assert!(decode_consistent_claims(&token, "mainnet", "https://issuer.invalid", "mainnet-relayer", 1000).is_err());
}

#[test]
fn independent_network_issuer_and_subject_separate_backoff() {
    let original = decode_consistent_claims(&unsigned_fixture(&claims()), "mainnet", "https://issuer.invalid", "mainnet-relayer", 1000).unwrap();
    let original_key = backoff_identity("https://store.invalid/rest/v1", &original);
    for (network, issuer, subject) in [("testnet", "https://issuer.invalid", "testnet-relayer"),
        ("mainnet", "https://other.invalid", "mainnet-relayer"),
        ("mainnet", "https://issuer.invalid", "another-relayer")] {
        let mut c = claims(); c["neoos_network"] = json!(network); c["iss"] = json!(issuer); c["sub"] = json!(subject);
        let decoded = decode_consistent_claims(&unsigned_fixture(&c), network, issuer, subject, 1000).unwrap();
        assert_ne!(original_key, backoff_identity("https://store.invalid/rest/v1", &decoded));
    }
}

#[test]
fn public_api_key_classification_never_accepts_admin_or_secret_key() {
    use neo_os_relayer::store_auth::validate_public_api_key;
    assert!(validate_public_api_key(&format!("sb_publishable_{}", "a".repeat(16))).is_ok());
    let mut anon = claims(); anon["role"] = json!("anon");
    assert!(validate_public_api_key(&unsigned_fixture(&anon)).is_ok());
    for key in ["sb_secret_synthetic".to_string(), "service-role-canary".to_string(),
        "sb_publishable_short".to_string(), "sb_publishable_aaaaaaaaaaaaaaaa\n".to_string(),
        unsigned_fixture(&claims())] {
        assert!(validate_public_api_key(&key).is_err());
    }
    anon["role"] = json!("service_role");
    assert!(validate_public_api_key(&unsigned_fixture(&anon)).is_err());
}

#[test]
fn store_endpoint_cannot_carry_credentials_query_or_fragment() {
    use neo_os_relayer::store_auth::validate_store_url;
    assert!(validate_store_url("https://store.invalid/rest/v1").is_ok());
    for url in ["http://store.invalid", "https://user:pass@store.invalid", "https://store.invalid?token=synthetic", "https://store.invalid#context", "not-a-url"] {
        assert!(validate_store_url(url).is_err(), "{url}");
    }
}
