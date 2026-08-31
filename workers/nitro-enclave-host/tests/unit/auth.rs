//! Bearer-token auth tests — the fail-closed discipline from
//! `enclave-server.test.mjs` (fail-closed at ~1206, auth gate at ~1190) plus
//! the header-extraction cases the Node helpers implement.

use super::*;

fn overlay_with(pairs: &[(&str, &str)]) -> EnvOverlay {
    EnvOverlay::new(pairs.iter().map(|(k, v)| (*k, *v)))
}

fn bearer(token: &str) -> http::HeaderMap {
    let mut headers = http::HeaderMap::new();
    headers.insert(
        http::header::AUTHORIZATION,
        http::HeaderValue::from_str(&format!("Bearer {token}")).expect("header"),
    );
    headers
}

#[test]
fn trusted_tokens_read_the_four_env_keys_and_deduplicate() {
    let overlay = overlay_with(&[
        ("NITRO_SIGNER_TOKEN", "alpha"),
        ("MORPHEUS_RUNTIME_TOKEN", "beta"),
        ("NITRO_API_TOKEN", "alpha"),
        ("NITRO_SHARED_SECRET", "   "),
    ]);
    assert_eq!(
        trusted_tokens(&overlay),
        vec!["alpha".to_string(), "beta".to_string()]
    );
}

#[test]
fn placeholder_values_are_refused_and_the_set_stays_closed() {
    let overlay = overlay_with(&[
        ("MORPHEUS_RUNTIME_TOKEN", "replace-me"),
        ("NITRO_API_TOKEN", "Change-Me"),
        ("NITRO_SHARED_SECRET", "token"),
        ("NITRO_SIGNER_TOKEN", "real-secret"),
    ]);
    assert_eq!(trusted_tokens(&overlay), vec!["real-secret".to_string()]);
    // Every member of the placeholder set, case-insensitively.
    for placeholder in [
        "your-token-here",
        "your-morpheus-runtime-token",
        "nitro-shared-secret",
        "secret",
        "REPLACE-ME",
    ] {
        assert!(is_placeholder_token(placeholder), "{placeholder}");
    }
    assert!(!is_placeholder_token("replace-me-2"));
    assert!(!is_placeholder_token("  real value  "));
}

#[test]
fn an_empty_trusted_set_authorizes_nothing() {
    let overlay = overlay_with(&[]);
    let error = assert_authorized(&overlay, &bearer("anything")).expect_err("no tokens configured");
    assert_eq!(error.status, 401);
    assert_eq!(error.message, "runtime authorization is not configured");

    // A placeholder-only env is an empty set, not a public secret.
    let overlay = overlay_with(&[("NITRO_SHARED_SECRET", "changeme")]);
    let error = assert_authorized(&overlay, &bearer("changeme"))
        .expect_err("placeholder must not authenticate");
    assert_eq!(error.message, "runtime authorization is not configured");
}

#[test]
fn a_matching_bearer_or_x_token_authorizes() {
    let overlay = overlay_with(&[("NITRO_SIGNER_TOKEN", "s3cret")]);
    assert!(assert_authorized(&overlay, &bearer("s3cret")).is_ok());

    let mut headers = http::HeaderMap::new();
    headers.insert("x-nitro-token", http::HeaderValue::from_static("s3cret"));
    assert!(assert_authorized(&overlay, &headers).is_ok());

    let mut headers = http::HeaderMap::new();
    headers.insert("x-runtime-token", http::HeaderValue::from_static("s3cret"));
    assert!(assert_authorized(&overlay, &headers).is_ok());
}

#[test]
fn a_wrong_token_is_unauthorized_with_the_exact_message() {
    let overlay = overlay_with(&[("NITRO_SIGNER_TOKEN", "s3cret")]);
    let error = assert_authorized(&overlay, &bearer("wrong")).expect_err("mismatch");
    assert_eq!(error.status, 401);
    assert_eq!(error.message, "unauthorized");

    let error = assert_authorized(&overlay, &http::HeaderMap::new()).expect_err("no header");
    assert_eq!(error.message, "unauthorized");
}

#[test]
fn the_bearer_scheme_is_case_insensitive_and_trimmed() {
    for header_value in ["bearer s3cret", "BEARER s3cret", "Bearer  s3cret "] {
        let mut headers = http::HeaderMap::new();
        headers.insert(
            http::header::AUTHORIZATION,
            http::HeaderValue::from_str(header_value).expect("header"),
        );
        assert_eq!(extract_request_token(&headers), "s3cret", "{header_value}");
    }
}

#[test]
fn extraction_prefers_bearer_then_nitro_then_runtime() {
    let mut headers = http::HeaderMap::new();
    headers.insert("x-nitro-token", http::HeaderValue::from_static("nitro"));
    headers.insert("x-runtime-token", http::HeaderValue::from_static("runtime"));
    assert_eq!(extract_request_token(&headers), "nitro");

    let mut headers = http::HeaderMap::new();
    headers.insert("x-runtime-token", http::HeaderValue::from_static("runtime"));
    assert_eq!(extract_request_token(&headers), "runtime");

    assert_eq!(extract_request_token(&http::HeaderMap::new()), "");
    // Node's `||` picks the first PRESENT x-header even when it trims to
    // empty — the empty result can never authenticate.
    let mut headers = http::HeaderMap::new();
    headers.insert("x-nitro-token", http::HeaderValue::from_static("   "));
    headers.insert("x-runtime-token", http::HeaderValue::from_static("runtime"));
    assert_eq!(extract_request_token(&headers), "");
}

#[test]
fn the_digest_fold_is_constant_time_and_correct() {
    assert!(timing_safe_token_match("same", "same"));
    assert!(!timing_safe_token_match("same", "samе"));
    assert!(!timing_safe_token_match("short", "a-much-longer-token"));
    assert!(!timing_safe_token_match("", "x"));
    // Length never leaks: the fold collapses two sha256 digests, so any
    // unequal pair rejects identically.
    assert_eq!(
        timing_safe_token_match("a", "b"),
        timing_safe_token_match("aaaaaaaa", "bbbbbbbbbbbbbbbbbbbb")
    );
}

#[test]
fn provisioned_runtime_token_joins_the_trusted_set_live() {
    let mut overlay = overlay_with(&[]);
    overlay.set_runtime_token("kms-materialized-token");
    assert!(assert_authorized(&overlay, &bearer("kms-materialized-token")).is_ok());
}
