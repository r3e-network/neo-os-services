//! Overlay tests: the environment is a value here, so the tests construct it
//! instead of touching `std::env` — which is the whole reason the overlay
//! exists.

use super::*;

fn value(text: &str) -> serde_json::Value {
    serde_json::Value::String(text.to_string())
}

#[test]
fn the_overlay_shadows_the_base() {
    let mut overlay = EnvOverlay::new([("AWS_REGION", "us-east-1")]);
    assert_eq!(overlay.get("AWS_REGION"), Some("us-east-1"));
    overlay.apply("AWS_REGION", &value("eu-west-1"));
    assert_eq!(overlay.get("AWS_REGION"), Some("eu-west-1"));
    // The base remains visible for names the overlay never touched.
    assert_eq!(overlay.get("UNSET_NAME"), None);
}

#[test]
fn apply_enforces_the_exact_provision_allowlist() {
    let mut overlay = EnvOverlay::new(Vec::<(&str, &str)>::new());
    assert!(overlay.apply("AWS_ACCESS_KEY_ID", &value("x")));
    assert!(overlay.apply("MORPHEUS_ORACLE_KMS_CIPHERTEXT_BASE64", &value("x")));
    assert!(!overlay.apply("NODE_ENV", &value("production")));
    assert!(!overlay.apply("MORPHEUS_NETWORK", &value("mainnet")));
    assert!(!overlay.apply("SIGNER_SERVICE_URL", &value("https://attacker")));
    assert!(!overlay.apply("lowercase", &value("x")));
    assert!(!overlay.apply("WITH-DASH", &value("x")));
    assert!(!overlay.apply("", &value("x")));
}

#[test]
fn apply_is_string_only_and_skips_empty_values() {
    let mut overlay = EnvOverlay::new(Vec::<(&str, &str)>::new());
    // trimString is string-only in the Node server: numbers and objects are
    // skipped, not stringified.
    assert!(!overlay.apply("AWS_ACCESS_KEY_ID", &serde_json::json!(42)));
    assert!(!overlay.apply("AWS_ACCESS_KEY_ID", &serde_json::json!({})));
    assert!(!overlay.apply("AWS_ACCESS_KEY_ID", &serde_json::Value::Null));
    assert!(!overlay.apply("AWS_ACCESS_KEY_ID", &value("   ")));
    // Whitespace is trimmed off before the value is stored.
    assert!(overlay.apply("AWS_ACCESS_KEY_ID", &value("  padded  ")));
    assert_eq!(overlay.get("AWS_ACCESS_KEY_ID"), Some("padded"));
    assert_eq!(
        overlay.applied_keys().collect::<Vec<_>>(),
        vec!["AWS_ACCESS_KEY_ID"]
    );
}

#[test]
fn applied_keys_reports_what_landed() {
    let mut overlay = EnvOverlay::new(Vec::<(&str, &str)>::new());
    overlay.apply("TD_KEY", &value("2"));
    overlay.apply("AWS_REGION", &value("1"));
    overlay.apply("SKIPPED_lower", &value("3"));
    let mut keys: Vec<&str> = overlay.applied_keys().collect();
    keys.sort_unstable();
    assert_eq!(keys, vec!["AWS_REGION", "TD_KEY"]);
}

#[test]
fn get_trimmed_reads_like_the_node_helpers() {
    let mut overlay = EnvOverlay::new([("EMPTYISH", "   ")]);
    assert_eq!(overlay.get_trimmed("EMPTYISH"), None);
    overlay.apply("AWS_REGION", &value("v"));
    assert_eq!(overlay.get_trimmed("AWS_REGION").as_deref(), Some("v"));
    assert_eq!(overlay.get_trimmed("ABSENT"), None);
}

#[test]
fn the_runtime_token_bypasses_the_whitelist_but_not_the_shadow() {
    let mut overlay = EnvOverlay::new([("MORPHEUS_RUNTIME_TOKEN", "from-image-env")]);
    overlay.set_runtime_token("from-kms-envelope");
    assert_eq!(
        overlay.get("MORPHEUS_RUNTIME_TOKEN"),
        Some("from-kms-envelope")
    );
}

#[test]
fn from_process_snapshots_the_live_environment() {
    // One round trip through a name only this test sets; the snapshot must
    // contain it while the overlay half stays empty.
    let name = "ENCLAVE_HOST_OVERLAY_PROBE";
    std::env::remove_var(name);
    let before = EnvOverlay::from_process();
    std::env::set_var(name, "value");
    let after = EnvOverlay::from_process();
    assert_eq!(before.get(name), None);
    assert_eq!(after.get(name), Some("value"));
    std::env::remove_var(name);
}

#[test]
fn is_provisionable_name_matches_the_documented_allowlist() {
    assert!(is_provisionable_name("AWS_REGION"));
    assert!(is_provisionable_name(
        "MORPHEUS_RUNTIME_TOKEN_KMS_CIPHERTEXT_BASE64"
    ));
    assert!(!is_provisionable_name("MORPHEUS_NETWORK"));
    assert!(!is_provisionable_name("NODE_ENV"));
    assert!(!is_provisionable_name("SIGNER_SERVICE_URL"));
    assert!(!is_provisionable_name("MORPHEUS-NETWORK"));
    assert!(!is_provisionable_name("morpheus_network"));
    assert!(!is_provisionable_name(""));
}
