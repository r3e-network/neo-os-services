use std::collections::HashMap;

use morpheus_compute::permission::{
    is_child_process_permission_model_enabled, parse_allow_net, validate_child_process_permissions,
};

fn env_from(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
    let map: HashMap<String, String> = pairs
        .iter()
        .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
        .collect();
    move |name| map.get(name).cloned()
}

const EMPTY: fn(&str) -> Option<String> = |_| None;

#[test]
fn parse_allow_net_accepts_specific_hostnames() {
    let (entries, invalid) = parse_allow_net("api.example.com,localhost");
    assert_eq!(entries, vec!["api.example.com", "localhost"]);
    assert!(invalid.is_empty());
}

#[test]
fn parse_allow_net_accepts_hostnames_with_ports() {
    let (entries, invalid) = parse_allow_net("api.example.com:443");
    assert_eq!(entries, vec!["api.example.com:443"]);
    assert!(invalid.is_empty());
}

#[test]
fn parse_allow_net_accepts_ipv4_addresses() {
    let (entries, invalid) = parse_allow_net("1.2.3.4,192.168.1.1:8080");
    assert_eq!(entries, vec!["1.2.3.4", "192.168.1.1:8080"]);
    assert!(invalid.is_empty());
}

#[test]
fn parse_allow_net_rejects_wildcard_entries() {
    let (entries, invalid) = parse_allow_net("*,*.example.com,0.0.0.0/0,::/0");
    // entries is the parsed list before any validity filtering — the same
    // list the JS returns; invalid repeats them in input order (already the
    // sorted order the JS test compares against).
    assert_eq!(entries, vec!["*", "*.example.com", "0.0.0.0/0", "::/0"]);
    assert_eq!(invalid, vec!["*", "*.example.com", "0.0.0.0/0", "::/0"]);
}

#[test]
fn parse_allow_net_rejects_cidr_notation() {
    let (entries, invalid) = parse_allow_net("10.0.0.0/8");
    assert_eq!(entries, vec!["10.0.0.0/8"]);
    assert_eq!(invalid, vec!["10.0.0.0/8"]);
}

#[test]
fn parse_allow_net_rejects_malformed_entries_with_spaces_or_empty_labels() {
    let (entries, invalid) = parse_allow_net("example..com, bad host");
    assert_eq!(entries, vec!["example..com", "bad host"]);
    assert_eq!(invalid, vec!["example..com", "bad host"]);
}

#[test]
fn permission_model_is_enabled_by_default_when_nothing_is_set() {
    let env = env_from(&[]);
    assert!(is_child_process_permission_model_enabled(&env));
}

#[test]
fn permission_model_is_enabled_by_default_in_production() {
    let env = env_from(&[("NODE_ENV", "production")]);
    assert!(is_child_process_permission_model_enabled(&env));
}

#[test]
fn dev_override_disables_the_permission_model_when_not_production() {
    let env = env_from(&[("MORPHEUS_ALLOW_UNSANDBOXED_CHILDREN", "1")]);
    assert!(!is_child_process_permission_model_enabled(&env));
}

#[test]
fn all_truthy_override_values_disable_when_not_production() {
    for value in ["1", "true", "yes"] {
        let env = env_from(&[("MORPHEUS_ALLOW_UNSANDBOXED_CHILDREN", value)]);
        assert!(
            !is_child_process_permission_model_enabled(&env),
            "override={value}"
        );
    }
}

#[test]
fn permission_model_stays_enabled_for_non_truthy_override_values() {
    let env = env_from(&[("MORPHEUS_ALLOW_UNSANDBOXED_CHILDREN", "0")]);
    assert!(is_child_process_permission_model_enabled(&env));
}

#[test]
fn dev_override_is_ignored_in_production_fail_closed() {
    let env = env_from(&[
        ("NODE_ENV", "production"),
        ("MORPHEUS_ALLOW_UNSANDBOXED_CHILDREN", "1"),
    ]);
    assert!(is_child_process_permission_model_enabled(&env));
}

#[test]
fn validate_throws_when_allow_net_is_a_wildcard() {
    let env = env_from(&[("SCRIPT_CHILD_ALLOW_NET", "0.0.0.0/0")]);
    let error = validate_child_process_permissions(None, &env).unwrap_err();
    assert!(error.contains("disallowed entries"), "{error}");
}

#[test]
fn validate_throws_when_allow_net_is_a_wildcard_in_production() {
    let env = env_from(&[
        ("NODE_ENV", "production"),
        ("SCRIPT_CHILD_ALLOW_NET", "0.0.0.0/0"),
    ]);
    let error = validate_child_process_permissions(None, &env).unwrap_err();
    assert!(error.contains("disallowed entries"), "{error}");
}

#[test]
fn validate_allows_valid_allow_net() {
    let env = env_from(&[("SCRIPT_CHILD_ALLOW_NET", "api.example.com")]);
    validate_child_process_permissions(None, &env).expect("valid allowlist must pass");
}

#[test]
fn validate_does_not_throw_when_dev_override_disables_the_model_outside_production() {
    let env = env_from(&[("MORPHEUS_ALLOW_UNSANDBOXED_CHILDREN", "1")]);
    validate_child_process_permissions(None, &env).expect("override skips validation");
}

#[test]
fn validate_does_not_throw_in_production_with_override_set_override_is_ignored() {
    let env = env_from(&[
        ("NODE_ENV", "production"),
        ("MORPHEUS_ALLOW_UNSANDBOXED_CHILDREN", "1"),
    ]);
    // The override is ignored in production, so the model stays enabled — but
    // with no allowlist configured, "no entries" is a pass (nothing to reject).
    validate_child_process_permissions(None, &env)
        .expect("empty allowlist with enabled model is not an error");
}

#[test]
fn retired_script_child_enable_permission_model_toggle_has_no_effect() {
    // The old toggle cannot disable the permission model anymore: only the
    // explicit MORPHEUS_ALLOW_UNSANDBOXED_CHILDREN dev override can.
    let env = env_from(&[
        ("SCRIPT_CHILD_ENABLE_PERMISSION_MODEL", "false"),
        ("SCRIPT_CHILD_ALLOW_NET", "api.example.com"),
    ]);
    assert!(is_child_process_permission_model_enabled(&env));
    validate_child_process_permissions(None, &env)
        .expect("retired toggle must not change validation");
}

#[test]
fn validate_reports_under_the_default_variable_name_even_for_a_custom_var() {
    // The JS error message hardcodes SCRIPT_CHILD_ALLOW_NET regardless of
    // which variable was actually read.
    let env = env_from(&[("CUSTOM_ALLOW_NET", "0.0.0.0/0")]);
    let error = validate_child_process_permissions(Some("CUSTOM_ALLOW_NET"), &env).unwrap_err();
    assert!(
        error.starts_with("SCRIPT_CHILD_ALLOW_NET contains disallowed entries: "),
        "{error}"
    );
    assert!(error.contains("0.0.0.0/0"), "{error}");
}

#[test]
fn validate_passes_when_the_custom_variable_is_absent() {
    validate_child_process_permissions(Some("CUSTOM_ALLOW_NET"), &EMPTY)
        .expect("absent variable is not an error");
}
