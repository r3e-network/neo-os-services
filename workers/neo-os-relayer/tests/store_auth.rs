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
