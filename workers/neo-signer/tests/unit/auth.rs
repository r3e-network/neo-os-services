//! Credential parsing and the two-factor caller check.
//!
//! The interesting cases here are all "the request looks more trustworthy than
//! it is": a suffix that turns a lookalike host into an allowed origin, a
//! malformed `Origin` that could be traded for a friendlier `Referer`, a token
//! handed to two callers at once.

use super::*;
use crate::model::{CallerCapability, KeyGrant, SignerCaller, WorkloadIdentity};
use ed25519_dalek::{Signer as _, SigningKey};

const WORKLOAD_AUDIENCE: &str = "https://custody.test.example";

fn workload_policy(allow_legacy_v1: bool) -> WorkloadAuthPolicy {
    WorkloadAuthPolicy::new(WORKLOAD_AUDIENCE, allow_legacy_v1)
        .expect("the test audience is canonical")
}

fn caller(token: &str) -> SignerCaller {
    SignerCaller {
        id: "caller-1".to_string(),
        label: "Test Caller".to_string(),
        token_digest: token_digest(token),
        workload_identity: None,
        key_grant: KeyGrant::Only(vec!["key-1".to_string()]),
        capabilities: vec![CallerCapability::Sign],
        allowed_origins: Vec::new(),
        created_at_unix: 1_700_000_000,
        disabled: false,
    }
}

fn bound(token: &str, origins: &[&str]) -> SignerCaller {
    SignerCaller {
        allowed_origins: origins.iter().map(|origin| origin.to_string()).collect(),
        ..caller(token)
    }
}

fn browser(token: &str, origin: &str) -> CallerCredentials {
    CallerCredentials::new(Some(&format!("Bearer {token}")), Some(origin), None)
}

fn workload_caller(signing_key: &SigningKey) -> SignerCaller {
    SignerCaller {
        token_digest: token_digest("unreachable"),
        workload_identity: Some(WorkloadIdentity {
            public_key: signing_key.verifying_key().to_bytes(),
            subject: Some("neo-nexus:test".to_string()),
        }),
        ..caller("unreachable")
    }
}

fn workload_credentials(
    signing_key: &SigningKey,
    timestamp: u64,
    nonce: &str,
    route: &str,
    body: &[u8],
) -> CallerCredentials {
    let body_digest = body_sha256(body);
    let message = WorkloadMessage {
        audience: Some(WORKLOAD_AUDIENCE),
        caller_id: "caller-1",
        subject: Some("neo-nexus:test"),
        timestamp,
        nonce,
        method: "POST",
        route,
        body_digest: &body_digest,
        origin: None,
    }
    .to_bytes();
    let signature = hex::encode(signing_key.sign(&message).to_bytes());
    CallerCredentials::request(
        None,
        None,
        None,
        WorkloadRequestHeaders {
            protocol: Some(WORKLOAD_PROTOCOL_V2),
            audience: Some(WORKLOAD_AUDIENCE),
            caller_id: Some("caller-1"),
            timestamp: Some(&timestamp.to_string()),
            nonce: Some(nonce),
            signature: Some(&signature),
        },
        &workload_policy(false),
        "POST",
        route,
    )
    .with_body_digest(body_digest)
}

#[test]
fn a_bearer_token_is_read_out_of_the_header() {
    let credentials = CallerCredentials::new(Some("Bearer  abc123  "), None, None);
    assert_eq!(credentials.token(), Some("abc123"));
}

#[test]
fn the_scheme_name_is_case_insensitive_but_the_token_is_not() {
    let credentials = CallerCredentials::new(Some("bearer CaseD"), None, None);
    assert_eq!(credentials.token(), Some("CaseD"));
    let other = CallerCredentials::new(Some("bearer cased"), None, None);
    assert_ne!(credentials.token(), other.token());
}

#[test]
fn any_other_scheme_is_no_token_at_all() {
    for header in ["Basic abc", "Token abc", "Bearer", "Bearer ", ""] {
        let credentials = CallerCredentials::new(Some(header), None, None);
        assert_eq!(credentials.token(), None, "accepted {header:?}");
    }
}

#[test]
fn an_origin_reduces_to_scheme_host_and_port() {
    assert_eq!(
        normalize_origin("https://Neo.Example.COM/Path?query=1#frag").as_deref(),
        Some("https://neo.example.com")
    );
    assert_eq!(
        normalize_origin("http://localhost:8080/app").as_deref(),
        Some("http://localhost:8080")
    );
}

#[test]
fn a_default_port_is_not_a_different_origin() {
    // An operator who allows "https://app.example.com" must not have to also
    // allow ":443", or the same site arrives as two unrelated origins.
    assert_eq!(
        normalize_origin("https://app.example.com:443").as_deref(),
        normalize_origin("https://app.example.com").as_deref()
    );
    assert_eq!(
        normalize_origin("http://app.example.com:80").as_deref(),
        normalize_origin("http://app.example.com").as_deref()
    );
}

#[test]
fn origins_that_carry_no_host_are_unusable() {
    for value in ["null", "NULL", "", "   ", "not a url", "data:text/html,hi"] {
        assert_eq!(
            normalize_origin(value),
            None,
            "treated {value:?} as a real origin"
        );
    }
}

#[test]
fn a_referer_is_only_read_when_no_origin_was_sent() {
    let credentials = CallerCredentials::new(Some("Bearer t"), None, Some("https://good.test/x"));
    assert_eq!(credentials.origin().value(), Some("https://good.test"));

    let credentials = CallerCredentials::new(
        Some("Bearer t"),
        Some("garbage"),
        Some("https://good.test/x"),
    );
    // The bypass this closes: a hand-written `Origin` that cannot be matched
    // must not be swapped for an attacker-chosen `Referer` further down.
    assert_eq!(credentials.origin(), &OriginClaim::Unusable);
    assert_eq!(
        authorize(
            &bound("t", &["https://good.test"]),
            &credentials,
            CallerCapability::Sign,
            Some("key-1")
        )
        .err(),
        Some(AccessRejection::OriginNotAllowed)
    );
}

#[test]
fn a_blank_origin_does_not_count_as_presented() {
    let credentials = CallerCredentials::new(Some("Bearer t"), Some("  "), None);
    assert_eq!(credentials.origin(), &OriginClaim::Absent);
    assert!(authorize(
        &caller("t"),
        &credentials,
        CallerCapability::Sign,
        Some("key-1")
    )
    .is_ok());
}

#[test]
fn an_allow_entry_matches_only_the_whole_origin() {
    let allowed = vec!["https://neo.org".to_string()];
    for lookalike in [
        "https://neo.org.evil.test",
        "https://evil.test/https://neo.org",
        "https://neo.org:9999",
        "http://neo.org",
    ] {
        assert!(
            !origin_matches(&allowed, Some(lookalike)),
            "accepted {lookalike:?} as an allowed origin"
        );
    }
    assert!(origin_matches(&allowed, Some("https://neo.org")));
    assert!(!origin_matches(&allowed, None));
}

#[test]
fn an_unknown_token_is_refused_and_a_missing_one_is_distinct() {
    let callers = [caller("known")];
    assert_eq!(
        authenticate(
            &callers,
            &CallerCredentials::server_to_server("other"),
            CallerCapability::Sign,
            Some("key-1")
        )
        .err(),
        Some(AccessRejection::UnknownToken)
    );
    let no_token = CallerCredentials::new(None, None, None);
    assert_eq!(
        authenticate(&callers, &no_token, CallerCapability::Sign, Some("key-1")).err(),
        Some(AccessRejection::MissingToken)
    );
    assert_eq!(no_token.presented_digest(), None);
}

#[test]
fn a_token_shared_by_two_callers_grants_neither() {
    // Creation should prevent this, so the point of the test is that the check
    // exists: picking one would apply the wrong grant set to the request.
    let callers = [caller("dup"), caller("dup")];
    assert_eq!(
        authenticate(
            &callers,
            &CallerCredentials::server_to_server("dup"),
            CallerCapability::Sign,
            Some("key-1")
        )
        .err(),
        Some(AccessRejection::UnknownToken)
    );
}

#[test]
fn identify_names_the_caller_behind_a_refusal() {
    // The reason `identify` is public: `authenticate` answers "may this
    // happen", and a "no" still has to say who was told.
    let callers = [caller("t")];
    let credentials = CallerCredentials::server_to_server("t");
    assert_eq!(
        authenticate(
            &callers,
            &credentials,
            CallerCapability::Sign,
            Some("key-2")
        )
        .err(),
        Some(AccessRejection::KeyNotGranted)
    );
    assert_eq!(
        identify(&callers, &credentials).map(|found| found.id.as_str()),
        Some("caller-1")
    );

    let mut disabled = caller("t");
    disabled.disabled = true;
    assert_eq!(
        identify(&[disabled], &credentials).map(|found| found.label.as_str()),
        Some("Test Caller"),
        "a disabled caller is still the caller who asked"
    );
}

#[test]
fn identify_blames_nobody_when_a_digest_matches_two_rows() {
    assert_eq!(
        identify(
            &[caller("dup"), caller("dup")],
            &CallerCredentials::server_to_server("dup"),
        ),
        None
    );
}

#[test]
fn identify_returns_nothing_without_a_token() {
    assert_eq!(
        identify(&[caller("t")], &CallerCredentials::new(None, None, None)),
        None
    );
    // A token that matched no row is the same absence: there is no caller to
    // name, and inventing one would put the event under the wrong integration.
    assert_eq!(
        identify(
            &[caller("t")],
            &CallerCredentials::server_to_server("other"),
        ),
        None
    );
}

#[test]
fn a_disabled_caller_is_refused_after_matching() {
    let mut disabled = caller("t");
    disabled.disabled = true;
    let callers = [disabled];
    assert_eq!(
        authenticate(
            &callers,
            &CallerCredentials::server_to_server("t"),
            CallerCapability::Sign,
            Some("key-1")
        )
        .err(),
        Some(AccessRejection::CallerDisabled)
    );
}

#[test]
fn a_server_to_server_caller_refuses_a_browser_origin() {
    let callers = [caller("t")];
    let from_browser = CallerCredentials::new(Some("Bearer t"), Some("https://any.test"), None);
    assert_eq!(
        authenticate(
            &callers,
            &from_browser,
            CallerCapability::Sign,
            Some("key-1")
        )
        .err(),
        Some(AccessRejection::OriginUnexpected)
    );
    assert!(authenticate(
        &callers,
        &CallerCredentials::server_to_server("t"),
        CallerCapability::Sign,
        Some("key-1")
    )
    .is_ok());
}

#[test]
fn an_origin_bound_caller_refuses_a_request_that_sends_none() {
    let callers = [bound("t", &["https://app.test"])];
    assert_eq!(
        authenticate(
            &callers,
            &CallerCredentials::server_to_server("t"),
            CallerCapability::Sign,
            Some("key-1")
        )
        .err(),
        Some(AccessRejection::OriginRequired)
    );
    assert!(authenticate(
        &callers,
        &browser("t", "https://app.test"),
        CallerCapability::Sign,
        Some("key-1")
    )
    .is_ok());
    assert_eq!(
        authenticate(
            &callers,
            &browser("t", "https://other.test"),
            CallerCapability::Sign,
            Some("key-1")
        )
        .err(),
        Some(AccessRejection::OriginNotAllowed)
    );
}

#[test]
fn a_grant_narrows_which_keys_a_valid_token_may_name() {
    let callers = [caller("t")];
    assert!(authenticate(
        &callers,
        &CallerCredentials::server_to_server("t"),
        CallerCapability::Sign,
        Some("key-1")
    )
    .is_ok());
    assert_eq!(
        authenticate(
            &callers,
            &CallerCredentials::server_to_server("t"),
            CallerCapability::Sign,
            Some("key-2")
        )
        .err(),
        Some(AccessRejection::KeyNotGranted)
    );

    let mut empty = caller("t");
    empty.key_grant = KeyGrant::Only(Vec::new());
    assert_eq!(
        authenticate(
            &[empty],
            &CallerCredentials::server_to_server("t"),
            CallerCapability::Sign,
            Some("key-1")
        )
        .err(),
        Some(AccessRejection::KeyNotGranted)
    );
}

#[test]
fn an_any_grant_reaches_keys_created_after_the_caller() {
    let mut open = caller("t");
    open.key_grant = KeyGrant::Any;
    assert!(authenticate(
        &[open],
        &CallerCredentials::server_to_server("t"),
        CallerCapability::Sign,
        Some("any-new-key")
    )
    .is_ok());
}

#[test]
fn only_the_digest_of_a_token_is_ever_compared() {
    let digest = token_digest("secret-token");
    assert_eq!(digest.len(), 32);
    assert_eq!(digest, token_digest("secret-token"));
    assert_ne!(digest, token_digest("secret-token!"));
    // The stored form is a digest, so a caller row copied out of the database
    // cannot be replayed as a credential.
    assert_ne!(hex_lite(&digest), "secret-token");
}

#[test]
fn generated_tokens_are_prefixed_and_do_not_repeat() {
    let first = generate_token();
    let second = generate_token();
    assert!(first.starts_with("nsk1_"));
    assert_eq!(first.len(), 5 + 64);
    assert_ne!(first, second);
    assert_ne!(token_digest(&first), token_digest(&second));
}

#[test]
fn every_rejection_has_a_unique_code() {
    let reasons = [
        AccessRejection::MissingToken,
        AccessRejection::UnknownToken,
        AccessRejection::CallerDisabled,
        AccessRejection::OriginRequired,
        AccessRejection::OriginNotAllowed,
        AccessRejection::OriginUnexpected,
        AccessRejection::KeyNotGranted,
        AccessRejection::CapabilityMissing,
        AccessRejection::AmbiguousCredential,
        AccessRejection::WorkloadMalformed,
        AccessRejection::UnknownWorkload,
        AccessRejection::WorkloadStale,
        AccessRejection::WorkloadSignatureInvalid,
        AccessRejection::WorkloadProtocolUnsupported,
        AccessRejection::WorkloadAudienceMismatch,
        AccessRejection::WorkloadReplay,
    ];
    for (index, reason) in reasons.iter().enumerate() {
        for other in &reasons[index + 1..] {
            assert_ne!(reason.code(), other.code());
        }
        assert!(!reason.to_string().is_empty());
    }
}

#[test]
fn a_workload_assertion_binds_identity_route_body_and_time() {
    let signing_key = SigningKey::from_bytes(&[7u8; 32]);
    let callers = [workload_caller(&signing_key)];
    let timestamp = 1_900_000_000;
    let credentials = workload_credentials(
        &signing_key,
        timestamp,
        "nonce-0000000001",
        "/signer/api/v1/sign/transaction",
        br#"{"key_id":"key-1"}"#,
    );
    assert!(authenticate_at(
        &callers,
        &credentials,
        CallerCapability::Sign,
        Some("key-1"),
        timestamp,
    )
    .is_ok());

    let tampered_body = credentials
        .clone()
        .with_body_digest(body_sha256(br#"{"key_id":"key-2"}"#));
    assert_eq!(
        authenticate_at(
            &callers,
            &tampered_body,
            CallerCapability::Sign,
            Some("key-1"),
            timestamp,
        ),
        Err(AccessRejection::WorkloadSignatureInvalid)
    );
    assert_eq!(
        authenticate_at(
            &callers,
            &credentials,
            CallerCapability::Sign,
            Some("key-1"),
            timestamp + WORKLOAD_MAX_CLOCK_SKEW_SECONDS + 1,
        ),
        Err(AccessRejection::WorkloadStale)
    );

    let ambiguous = CallerCredentials::request(
        Some("Bearer also-present"),
        None,
        None,
        WorkloadRequestHeaders {
            protocol: Some(WORKLOAD_PROTOCOL_V2),
            audience: Some(WORKLOAD_AUDIENCE),
            caller_id: Some("caller-1"),
            timestamp: Some("1900000000"),
            nonce: Some("nonce-0000000001"),
            signature: Some("00"),
        },
        &workload_policy(false),
        "POST",
        "/signer/api/v1/sign/transaction",
    );
    assert_eq!(
        authenticate_at(
            &callers,
            &ambiguous,
            CallerCapability::Sign,
            Some("key-1"),
            timestamp,
        ),
        Err(AccessRejection::AmbiguousCredential)
    );
}

#[test]
fn a_v2_workload_assertion_is_bound_to_one_canonical_signer_audience() {
    let signing_key = SigningKey::from_bytes(&[8u8; 32]);
    let callers = [workload_caller(&signing_key)];
    let timestamp = 1_900_000_000;
    let credentials = workload_credentials(
        &signing_key,
        timestamp,
        "nonce-0000000002",
        "/signer/api/v1/sign/transaction",
        br#"{"key_id":"key-1"}"#,
    );
    assert!(authenticate_at(
        &callers,
        &credentials,
        CallerCapability::Sign,
        Some("key-1"),
        timestamp,
    )
    .is_ok());

    let wrong_policy = WorkloadAuthPolicy::new("https://other-custody.test.example", false)
        .expect("canonical test audience");
    let body = br#"{"key_id":"key-1"}"#;
    let body_digest = body_sha256(body);
    let message = WorkloadMessage {
        audience: Some(WORKLOAD_AUDIENCE),
        caller_id: "caller-1",
        subject: Some("neo-nexus:test"),
        timestamp,
        nonce: "nonce-0000000003",
        method: "POST",
        route: "/signer/api/v1/sign/transaction",
        body_digest: &body_digest,
        origin: None,
    }
    .to_bytes();
    let signature = hex::encode(signing_key.sign(&message).to_bytes());
    let timestamp_text = timestamp.to_string();
    let wrong_audience = CallerCredentials::request(
        None,
        None,
        None,
        WorkloadRequestHeaders {
            protocol: Some(WORKLOAD_PROTOCOL_V2),
            audience: Some(WORKLOAD_AUDIENCE),
            caller_id: Some("caller-1"),
            timestamp: Some(&timestamp_text),
            nonce: Some("nonce-0000000003"),
            signature: Some(&signature),
        },
        &wrong_policy,
        "POST",
        "/signer/api/v1/sign/transaction",
    )
    .with_body_digest(body_digest);
    assert_eq!(
        authenticate_at(
            &callers,
            &wrong_audience,
            CallerCapability::Sign,
            Some("key-1"),
            timestamp,
        ),
        Err(AccessRejection::WorkloadAudienceMismatch)
    );

    for invalid in [
        "https://custody.test.example/proxy-a",
        "https://custody.test.example?route=proxy-a",
        "https://user@custody.test.example",
    ] {
        assert!(
            WorkloadAuthPolicy::new(invalid, false).is_err(),
            "{invalid}"
        );
    }
    assert_eq!(
        WorkloadAuthPolicy::new("HTTPS://CUSTODY.TEST.EXAMPLE:443/", false)
            .expect("equivalent origin")
            .audience(),
        WORKLOAD_AUDIENCE
    );
}

#[test]
fn audience_less_v1_is_rejected_by_default_and_requires_explicit_compatibility() {
    let signing_key = SigningKey::from_bytes(&[9u8; 32]);
    let callers = [workload_caller(&signing_key)];
    let timestamp = 1_900_000_000;
    let body = br#"{"key_id":"key-1"}"#;
    let body_digest = body_sha256(body);
    let message = WorkloadMessage {
        audience: None,
        caller_id: "caller-1",
        subject: Some("neo-nexus:test"),
        timestamp,
        nonce: "nonce-0000000004",
        method: "POST",
        route: "/signer/api/v1/sign/transaction",
        body_digest: &body_digest,
        origin: None,
    }
    .to_bytes();
    let signature = hex::encode(signing_key.sign(&message).to_bytes());
    let timestamp_text = timestamp.to_string();
    let request = |allow_legacy_v1| {
        CallerCredentials::request(
            None,
            None,
            None,
            WorkloadRequestHeaders {
                protocol: None,
                audience: None,
                caller_id: Some("caller-1"),
                timestamp: Some(&timestamp_text),
                nonce: Some("nonce-0000000004"),
                signature: Some(&signature),
            },
            &workload_policy(allow_legacy_v1),
            "POST",
            "/signer/api/v1/sign/transaction",
        )
        .with_body_digest(body_digest)
    };
    assert_eq!(
        authenticate_at(
            &callers,
            &request(false),
            CallerCapability::Sign,
            Some("key-1"),
            timestamp,
        ),
        Err(AccessRejection::WorkloadProtocolUnsupported)
    );
    assert!(authenticate_at(
        &callers,
        &request(true),
        CallerCapability::Sign,
        Some("key-1"),
        timestamp,
    )
    .is_ok());
}

// -- capabilities ------------------------------------------------------------

/// A caller whose entitlement is only what `capabilities` says.
fn capable(token: &str, capabilities: &[CallerCapability]) -> SignerCaller {
    SignerCaller {
        capabilities: capabilities.to_vec(),
        ..caller(token)
    }
}

/// The shape an operator actually provisions for the management API: whole-vault
/// grant, `admin` capability.
fn vault_admin(token: &str) -> SignerCaller {
    SignerCaller {
        key_grant: KeyGrant::Any,
        capabilities: vec![CallerCapability::Admin],
        ..caller(token)
    }
}

#[test]
fn a_signing_credential_reaches_no_management_route() {
    let callers = [caller("t")];
    let credentials = CallerCredentials::server_to_server("t");
    // Naming a granted key is not enough: the route decides, not the key.
    assert_eq!(
        authenticate(
            &callers,
            &credentials,
            CallerCapability::Admin,
            Some("key-1")
        )
        .err(),
        Some(AccessRejection::CapabilityMissing)
    );
    assert_eq!(
        authenticate(&callers, &credentials, CallerCapability::Admin, None).err(),
        Some(AccessRejection::CapabilityMissing)
    );
}

#[test]
fn an_admin_credential_cannot_sign() {
    // Admin is not a superset. A vault that let the operator's credential sign
    // would make every stolen management token a theft tool.
    let callers = [vault_admin("t")];
    let credentials = CallerCredentials::server_to_server("t");
    assert_eq!(
        authenticate(
            &callers,
            &credentials,
            CallerCapability::Sign,
            Some("key-1")
        )
        .err(),
        Some(AccessRejection::CapabilityMissing)
    );
    assert!(authenticate(
        &callers,
        &credentials,
        CallerCapability::Admin,
        Some("key-1")
    )
    .is_ok());
}

#[test]
fn both_directions_of_a_capability_mismatch_answer_alike() {
    // The point of one code rather than two: whoever holds a bearer string can
    // present it to either route, and a message that differs by direction tells
    // them which kind they stole.
    let signing = authenticate(
        &[caller("t")],
        &CallerCredentials::server_to_server("t"),
        CallerCapability::Admin,
        Some("key-1"),
    )
    .expect_err("a signing token should not satisfy an admin route");
    let admin = authenticate(
        &[vault_admin("t")],
        &CallerCredentials::server_to_server("t"),
        CallerCapability::Sign,
        Some("key-1"),
    )
    .expect_err("an admin token should not satisfy a signing route");
    assert_eq!(signing.code(), admin.code());
    assert_eq!(signing.code(), "admin-capability-missing");
    assert_eq!(signing.to_string(), admin.to_string());
}

#[test]
fn the_capability_check_runs_before_the_origin_binding() {
    // Otherwise a wrong-kind credential could be triaged by which headers it
    // sends, and origin binding would leak the same distinction.
    let callers = [SignerCaller {
        allowed_origins: vec!["https://app.test".to_string()],
        ..capable("t", &[CallerCapability::Admin])
    }];
    assert_eq!(
        authenticate(
            &callers,
            &CallerCredentials::server_to_server("t"),
            CallerCapability::Sign,
            Some("key-1"),
        )
        .err(),
        Some(AccessRejection::CapabilityMissing)
    );
}

#[test]
fn a_disabled_caller_is_still_refused_as_disabled_first() {
    // Order matters to the operator, not to the attacker: `disabled` is a switch
    // they flipped, and telling them the credential was also the wrong kind
    // would hide the fact that they already turned it off.
    let mut disabled = caller("t");
    disabled.disabled = true;
    assert_eq!(
        authenticate(
            &[disabled],
            &CallerCredentials::server_to_server("t"),
            CallerCapability::Admin,
            None,
        )
        .err(),
        Some(AccessRejection::CallerDisabled)
    );
}

#[test]
fn a_route_naming_no_key_reaches_the_whole_vault_and_needs_it() {
    // "No key named" is the widest possible request — list the vault, create
    // into it. A scoped admin must not be able to read the keys it was scoped
    // away from, so the absence of a key tightens the check instead of
    // relaxing it.
    let scoped = capable("t", &[CallerCapability::Admin]);
    let credentials = CallerCredentials::server_to_server("t");
    assert_eq!(
        authenticate(&[scoped], &credentials, CallerCapability::Admin, None).err(),
        Some(AccessRejection::KeyNotGranted)
    );
    assert!(authenticate(
        &[vault_admin("t")],
        &credentials,
        CallerCapability::Admin,
        None
    )
    .is_ok());
}

#[test]
fn a_caller_with_no_capabilities_can_do_nothing() {
    // The regression this pins: an empty list read as "unrestricted".
    let callers = [capable("t", &[])];
    for required in CallerCapability::ALL {
        assert_eq!(
            authenticate(
                &callers,
                &CallerCredentials::server_to_server("t"),
                required,
                None,
            )
            .err(),
            Some(AccessRejection::CapabilityMissing),
            "an empty capability list was read as {required}"
        );
    }
}

#[test]
fn a_caller_holding_both_capabilities_passes_both_guards() {
    // The console's own credential: one token that can manage the vault and
    // sign with it, when an operator deliberately chose that.
    let callers = [SignerCaller {
        key_grant: KeyGrant::Any,
        capabilities: vec![CallerCapability::Sign, CallerCapability::Admin],
        ..caller("t")
    }];
    let credentials = CallerCredentials::server_to_server("t");
    assert!(authenticate(
        &callers,
        &credentials,
        CallerCapability::Sign,
        Some("key-1")
    )
    .is_ok());
    assert!(authenticate(&callers, &credentials, CallerCapability::Admin, None).is_ok());
}

#[test]
fn capability_labels_round_trip_and_reject_anything_else() {
    // The stored column is these labels, so a label that drifted from its
    // `FromStr` would silently turn a row into a caller that can do nothing.
    for capability in CallerCapability::ALL {
        let label = capability.label();
        assert_eq!(label.parse::<CallerCapability>().ok(), Some(capability));
        assert_ne!(label, "");
    }
    for junk in ["", "SIGN", "admin ", "everything", "sign,admin"] {
        assert!(
            junk.parse::<CallerCapability>().is_err(),
            "stored {junk:?} as a capability"
        );
    }
}

fn hex_lite(bytes: &[u8; 32]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
