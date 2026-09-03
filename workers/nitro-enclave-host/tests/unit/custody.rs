//! The custody-backed plane against a fake transport: every state the
//! /health and /sign surfaces can be put in, and the exact requests the plane
//! makes to reach them. The transport fake records each [`CustodyRequest`] —
//! URL, token, body — so these assertions cover the caller contract the plan
//! requires (§5 shapes, the role's pinned key, the bearer credential) without
//! a socket; the real reqwest adapter is exercised by the E2E run against a
//! live custody service.

use crate::state::{RoleReport, SignerPlane};
use std::sync::{Arc, Mutex, RwLock};

#[path = "support.rs"]
#[allow(clippy::duplicate_mod)] // intentional: one shared doubles file per test module
mod support;
use support::TEST_NETWORK;

// -- doubles ---------------------------------------------------------------

/// A transport with canned replies and a call log. `None` replies mean
/// transport failure: the call is recorded and the error string returned.
#[derive(Clone, Default)]
struct FakeTransport {
    calls: Arc<Mutex<Vec<crate::custody::CustodyRequest>>>,
    replies: Arc<Mutex<Option<crate::custody::CustodyReply>>>,
    error: Arc<Mutex<Option<String>>>,
}

impl FakeTransport {
    fn answering(reply: crate::custody::CustodyReply) -> Self {
        FakeTransport {
            replies: Mutex::new(Some(reply)).into(),
            ..FakeTransport::default()
        }
    }

    fn failing(message: &str) -> Self {
        FakeTransport {
            error: Mutex::new(Some(message.to_string())).into(),
            ..FakeTransport::default()
        }
    }

    fn calls(&self) -> Vec<crate::custody::CustodyRequest> {
        self.calls.lock().expect("calls lock").clone()
    }
}

impl crate::custody::CustodyTransport for FakeTransport {
    fn send(
        &self,
        request: crate::custody::CustodyRequest,
    ) -> Result<crate::custody::CustodyReply, String> {
        self.calls.lock().expect("calls lock").push(request);
        if let Some(error) = self.error.lock().expect("error lock").clone() {
            return Err(error);
        }
        self.replies
            .lock()
            .expect("reply lock")
            .clone()
            .ok_or_else(|| "no canned reply".to_string())
    }
}

/// The custody `GET /keys/{id}` body for a healthy testnet key.
fn key_body(network: &str) -> serde_json::Value {
    let network_magic = if network == "mainnet" {
        860_833_102
    } else {
        894_710_606
    };
    serde_json::json!({
        "key_id": "key-updater-1",
        "label": "updater",
        "network": network,
        "network_magic": network_magic,
        "public_key": "02f8a5a1e0f3b6c9d2e5f8a1b4c7d0e3f6a9b2c5d8e1f4a7b0c3d6e9f2a5b8c1",
        "script_hash": "0x5c2047b1c6b4b6e4b3a1c9d5e7f0a2b4c6d8e0f1",
        "address": "Nd5tGBUrXa3YylLBYbwZSp8BhRd1vcaFqm",
        "verification_script": "0c2102f8a5a1e0f3b6c9d2e5f8a1b4c7d0e3f6a9b2c5d8e1f4a7b0c3d6e9f2a5b8c14156e7b327",
        "signing_enabled": true
    })
}

/// A raw-sign success body, the shape `POST /sign/raw` answers with.
fn raw_signature_body() -> serde_json::Value {
    serde_json::json!({
        "allowed": true,
        "key_id": "key-updater-1",
        "script_hash": "0x5c2047b1c6b4b6e4b3a1c9d5e7f0a2b4c6d8e0f1",
        "address": "Nd5tGBUrXa3YylLBYbwZSp8BhRd1vcaFqm",
        "digest": "0x3394c84bb2e6d9f95e0af33582ce1655b6001fd69fc4818e00d867ae9853bbc5",
        "signature": "00aa11bb22cc33dd44ee55ff66aa77bb88cc99dd00ee11ff22aa33bb44cc55dd66aa77bb88cc99dd00ee11ff22aa33bb44cc55dd66aa77bb88cc99ddeeff0011",
        "public_key": "02f8a5a1e0f3b6c9d2e5f8a1b4c7d0e3f6a9b2c5d8e1f4a7b0c3d6e9f2a5b8c1",
        "invocation_script": "0c40…",
        "verification_script": "0c21…4156e7b327"
    })
}

fn signer(overlay: &[(&str, &str)], transport: FakeTransport) -> crate::custody::CustodySigner {
    crate::custody::CustodySigner::new(
        Arc::new(RwLock::new(crate::overlay::EnvOverlay::new(
            overlay.iter().map(|(key, value)| (*key, *value)),
        ))),
        Box::new(transport),
    )
}

fn configured_overlay() -> Vec<(&'static str, &'static str)> {
    vec![
        ("SIGNER_SERVICE_URL", "http://127.0.0.1:9211"),
        ("SIGNER_SERVICE_TOKEN", "custody-caller-token"),
        ("SIGNER_ROLE_UPDATER_KEY_ID", "key-updater-1"),
    ]
}

// -- role_report ------------------------------------------------------------

#[test]
fn with_no_url_the_plane_reads_as_the_unconfigured_shim_did() {
    // The exact issue string the fail-closed shim produced: /health's
    // signer_error, /provision's role issues and /keys/derived's 503 all
    // render from it, and the cutover parity run diffs those bodies.
    let plane = signer(
        &[("MORPHEUS_NETWORK", TEST_NETWORK)],
        FakeTransport::default(),
    );
    let report = plane.role_report(TEST_NETWORK, "updater");
    assert!(!report.ok);
    assert!(!report.materialized);
    assert_eq!(report.key_source, "none");
    assert_eq!(
        report.issues,
        vec!["updater: no custody signing plane is connected".to_string()]
    );
}

#[test]
fn a_url_without_a_pinned_key_id_names_the_missing_env() {
    let plane = signer(
        &[
            ("SIGNER_SERVICE_URL", "http://127.0.0.1:9211"),
            ("SIGNER_SERVICE_TOKEN", "custody-caller-token"),
        ],
        FakeTransport::default(),
    );
    let report = plane.role_report(TEST_NETWORK, "updater");
    assert!(!report.ok);
    assert_eq!(
        report.issues,
        vec!["updater: no custody key is pinned (SIGNER_ROLE_UPDATER_KEY_ID)".to_string()]
    );
}

#[test]
fn a_healthy_key_resolves_the_role_identity() {
    let transport = FakeTransport::answering(crate::custody::CustodyReply {
        status: 200,
        body: key_body(TEST_NETWORK),
    });
    let plane = signer(&configured_overlay(), transport.clone());
    let report = plane.role_report(TEST_NETWORK, "updater");

    assert!(report.ok, "{report:?}");
    assert!(report.materialized);
    assert_eq!(report.key_source, "custody");
    assert!(report.issues.is_empty());
    assert_eq!(
        report.public_key,
        "02f8a5a1e0f3b6c9d2e5f8a1b4c7d0e3f6a9b2c5d8e1f4a7b0c3d6e9f2a5b8c1"
    );
    assert_eq!(
        report.identity["address"],
        key_body(TEST_NETWORK)["address"]
    );
    assert_eq!(
        report.identity["script_hash"],
        key_body(TEST_NETWORK)["script_hash"]
    );

    // The call the report cost: the role's key at the configured base URL,
    // carrying the host's custody credential.
    let calls = transport.calls();
    assert_eq!(calls.len(), 1, "{calls:?}");
    assert_eq!(calls[0].method, "GET");
    assert_eq!(
        calls[0].url,
        "http://127.0.0.1:9211/signer/api/v1/keys/key-updater-1"
    );
    assert_eq!(
        calls[0].token.as_deref(),
        Some("custody-caller-token"),
        "the host presents its own custody caller token"
    );
    assert_eq!(calls[0].body, None);
}

#[test]
fn a_trailing_slash_on_the_base_url_does_not_double() {
    let overlay = configured_overlay()
        .into_iter()
        .map(|(key, value)| {
            if key == "SIGNER_SERVICE_URL" {
                (key, "http://127.0.0.1:9211/")
            } else {
                (key, value)
            }
        })
        .collect::<Vec<_>>();
    let transport = FakeTransport::answering(crate::custody::CustodyReply {
        status: 200,
        body: key_body(TEST_NETWORK),
    });
    let plane = signer(&overlay, transport.clone());
    assert!(plane.role_report(TEST_NETWORK, "updater").ok);
    assert_eq!(
        transport.calls()[0].url,
        "http://127.0.0.1:9211/signer/api/v1/keys/key-updater-1"
    );
}

#[test]
fn a_key_pinned_to_the_wrong_network_is_a_contradiction() {
    let transport = FakeTransport::answering(crate::custody::CustodyReply {
        status: 200,
        body: key_body("mainnet"),
    });
    let plane = signer(&configured_overlay(), transport);
    let report = plane.role_report(TEST_NETWORK, "updater");
    assert!(!report.ok);
    assert!(!report.materialized, "the key must not be usable");
    assert_eq!(
        report.issues,
        vec!["updater: custody key key-updater-1 is on mainnet, not testnet".to_string()]
    );
}

#[test]
fn a_disabled_key_is_not_a_usable_role() {
    let mut body = key_body(TEST_NETWORK);
    body["signing_enabled"] = serde_json::json!(false);
    let transport = FakeTransport::answering(crate::custody::CustodyReply { status: 200, body });
    let plane = signer(&configured_overlay(), transport);
    let report = plane.role_report(TEST_NETWORK, "updater");
    assert!(!report.ok);
    assert_eq!(
        report.issues,
        vec!["updater: custody key key-updater-1 is disabled".to_string()]
    );
}

#[test]
fn an_unknown_key_id_names_the_custody_refusal() {
    let transport = FakeTransport::answering(crate::custody::CustodyReply {
        status: 404,
        body: serde_json::json!({
            "allowed": false,
            "code": "signer-key-unknown",
            "message": "this key is not held by the service"
        }),
    });
    let plane = signer(&configured_overlay(), transport);
    let report = plane.role_report(TEST_NETWORK, "updater");
    assert!(!report.ok);
    assert_eq!(
        report.issues,
        vec![
            "updater: the custody service refused the key read (404 signer-key-unknown)"
                .to_string()
        ]
    );
}

#[test]
fn an_unreachable_custody_service_is_reported_not_panicked() {
    let transport = FakeTransport::failing("connection refused");
    let plane = signer(&configured_overlay(), transport);
    let report = plane.role_report(TEST_NETWORK, "updater");
    assert!(!report.ok);
    assert_eq!(
        report.issues,
        vec!["updater: the custody service is unreachable: connection refused".to_string()]
    );
}

// -- sign_payload -----------------------------------------------------------

#[test]
fn a_sign_request_posts_the_role_key_and_the_raw_hex() {
    let transport = FakeTransport::answering(crate::custody::CustodyReply {
        status: 200,
        body: raw_signature_body(),
    });
    let plane = signer(&configured_overlay(), transport.clone());

    let reply = plane
        .sign_payload(TEST_NETWORK, "updater", "00aabb")
        .expect("signs");
    assert_eq!(reply["status"], "ok");
    assert_eq!(reply["network"], TEST_NETWORK);
    assert_eq!(reply["role"], "updater");
    // The merged server's shape, with custody's values passed through and the
    // pinned key named for the cutover consumers.
    assert_eq!(reply["signature"], raw_signature_body()["signature"]);
    assert_eq!(reply["signature_hex"], reply["signature"]);
    assert_eq!(reply["public_key"], raw_signature_body()["public_key"]);
    assert_eq!(reply["address"], raw_signature_body()["address"]);
    assert_eq!(reply["script_hash"], raw_signature_body()["script_hash"]);
    assert_eq!(reply["key_id"], "key-updater-1");
    assert_eq!(reply["key_source"], "custody");

    let calls = transport.calls();
    assert_eq!(calls.len(), 1, "{calls:?}");
    assert_eq!(calls[0].method, "POST");
    assert_eq!(calls[0].url, "http://127.0.0.1:9211/signer/api/v1/sign/raw");
    assert_eq!(
        calls[0].body,
        Some(serde_json::json!({
            "key_id": "key-updater-1",
            "data_hex": "00aabb",
        }))
    );
}

#[test]
fn a_sign_request_without_custody_is_the_unconfigured_503() {
    let plane = signer(&[], FakeTransport::default());
    let error = plane
        .sign_payload(TEST_NETWORK, "updater", "00aabb")
        .expect_err("fails closed");
    assert_eq!(error.status, 503);
    assert_eq!(
        error.message,
        "updater signer is not configured or does not match pinned identity"
    );
}

#[test]
fn a_sign_request_without_a_pinned_key_is_the_unconfigured_503() {
    let plane = signer(
        &[("SIGNER_SERVICE_URL", "http://127.0.0.1:9211")],
        FakeTransport::default(),
    );
    let error = plane
        .sign_payload(TEST_NETWORK, "updater", "00aabb")
        .expect_err("fails closed");
    assert_eq!(error.status, 503);
    assert_eq!(
        error.message,
        "updater signer is not configured or does not match pinned identity"
    );
}

#[test]
fn a_custody_refusal_carries_its_status_and_code() {
    let transport = FakeTransport::answering(crate::custody::CustodyReply {
        status: 403,
        body: serde_json::json!({
            "allowed": false,
            "code": "raw-forbidden",
            "message": "raw signatures are not allowed for this key"
        }),
    });
    let plane = signer(&configured_overlay(), transport);
    let error = plane
        .sign_payload(TEST_NETWORK, "updater", "00aabb")
        .expect_err("custody refused");
    assert_eq!(error.status, 403);
    assert_eq!(
        error.message,
        "updater signer refused by custody (raw-forbidden): raw signatures are not allowed for \
         this key"
    );
}

#[test]
fn an_unreachable_custody_service_is_a_503_not_a_signature() {
    let transport = FakeTransport::failing("connection refused");
    let plane = signer(&configured_overlay(), transport);
    let error = plane
        .sign_payload(TEST_NETWORK, "updater", "00aabb")
        .expect_err("fails closed");
    assert_eq!(error.status, 503);
    assert!(
        error
            .message
            .starts_with("updater signer could not reach the custody service: "),
        "{error:?}"
    );
}

#[test]
fn kms_materialized_token_connects_immutable_custody_config() {
    let overlay = Arc::new(RwLock::new(crate::overlay::EnvOverlay::new([
        ("MORPHEUS_NETWORK", TEST_NETWORK),
        ("SIGNER_SERVICE_URL", "http://127.0.0.1:9211"),
        ("SIGNER_ROLE_UPDATER_KEY_ID", "key-updater-1"),
    ])));
    let transport = FakeTransport::answering(crate::custody::CustodyReply {
        status: 200,
        body: key_body(TEST_NETWORK),
    });
    let plane = crate::custody::CustodySigner::new(overlay.clone(), Box::new(transport.clone()));

    let report = plane.role_report(TEST_NETWORK, "updater");
    assert_eq!(
        report.issues,
        vec!["updater: no custody signing plane is connected".to_string()]
    );

    overlay
        .write()
        .expect("overlay lock")
        .set_custody_token("custody-caller-token");
    assert!(plane.role_report(TEST_NETWORK, "updater").ok, "connected");
}

#[test]
fn role_reports_never_leak_key_material_into_issues() {
    // The issues string is joined into /health's signer_error, which is a
    // caller-visible body. Every issue this plane produces is built from the
    // role name, the key id and custody's own codes — assert that even a
    // hostile-looking key row cannot widen that.
    let mut body = key_body(TEST_NETWORK);
    body["public_key"] = serde_json::json!("SECRET MATERIAL LOOKS LIKE THIS");
    let transport = FakeTransport::answering(crate::custody::CustodyReply { status: 200, body });
    let plane = signer(&configured_overlay(), transport);
    let report = plane.role_report(TEST_NETWORK, "updater");
    assert!(report.ok, "{report:?}");
    assert!(report.issues.is_empty());
    assert!(
        !serde_json::to_string(&report.issues)
            .expect("issues serialize")
            .contains("SECRET MATERIAL"),
        "the public key is not an issue line"
    );
}

#[test]
fn the_role_key_env_names_survive_the_role_casing() {
    assert_eq!(
        crate::custody::role_key_id_env("updater"),
        "SIGNER_ROLE_UPDATER_KEY_ID"
    );
    assert_eq!(
        crate::custody::role_key_id_env("oracle_verifier"),
        "SIGNER_ROLE_ORACLE_VERIFIER_KEY_ID"
    );
}

#[test]
fn an_unused_role_report_type_still_defaults_closed() {
    // RoleReport::not_configured is the plane's base state; the custody plane
    // must never widen it by accident.
    let report = RoleReport::not_configured();
    assert!(!report.ok);
    assert_eq!(report.key_source, "none");
    assert_eq!(report.public_key, "");
}
