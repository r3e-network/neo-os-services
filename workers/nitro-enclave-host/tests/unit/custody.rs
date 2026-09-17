//! The custody-backed plane against a fake transport: every state the
//! /health and /sign surfaces can be put in, and the exact requests the plane
//! makes to reach them. The transport fake records each [`CustodyRequest`] —
//! URL, token, body — so these assertions cover the caller contract the plan
//! requires (§5 shapes, the role's pinned key, the bearer credential) without
//! a socket; the real reqwest adapter is exercised by the E2E run against a
//! live custody service.

use crate::state::{Eip191FulfillmentRequest, RoleReport, SignerPlane};
use k256::ecdsa::SigningKey;
use neo_os_chain_evm::{build_neox_digest, eip191_message_hash, Fulfillment};
use neo_os_core::n3_tx::{
    address_from_script_hash, script_hash_from_public_key, verification_script_single_sig,
};
use p256::ecdsa::{signature::Signer as _, SigningKey as P256SigningKey};
use sha2::Sha256;
use sha3::{Digest, Keccak256};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::thread;
use std::time::Duration;

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

fn read_http_headers(stream: &mut TcpStream) -> String {
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .expect("read timeout");
    let mut bytes = Vec::new();
    let mut chunk = [0_u8; 1024];
    while !bytes.windows(4).any(|window| window == b"\r\n\r\n") {
        let read = stream.read(&mut chunk).expect("request headers");
        if read == 0 {
            break;
        }
        bytes.extend_from_slice(&chunk[..read]);
        assert!(bytes.len() <= 16 * 1024, "bounded request headers");
    }
    String::from_utf8(bytes).expect("ASCII request headers")
}

fn write_json_response(stream: &mut TcpStream, status: &str, headers: &str) {
    let body = r#"{"allowed":false}"#;
    write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{headers}Connection: close\r\n\r\n{body}",
        body.len()
    )
    .expect("response");
    stream.flush().expect("flush response");
}

/// The custody `GET /keys/{id}` body for a healthy testnet key.
fn key_body(network: &str) -> serde_json::Value {
    let network_magic = if network == "mainnet" {
        860_833_102
    } else {
        894_710_606
    };
    serde_json::json!({
        "allowed": true,
        "key_id": "key-updater-1",
        "label": "updater",
        "network": network,
        "chain_family": "neo-n3",
        "chain_id": 0,
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

fn transaction_signature_body() -> serde_json::Value {
    serde_json::json!({
        "allowed": true,
        "key_id": "neox-updater-1",
        "script_hash": "0x1111111111111111111111111111111111111111",
        "address": "0x1111111111111111111111111111111111111111",
        "digest": "0x3394c84bb2e6d9f95e0af33582ce1655b6001fd69fc4818e00d867ae9853bbc5",
        "invocation_script": "",
        "verification_script": "",
        "chain_family": "neox",
        "signed_transaction": "0x02f86c01",
        "signature_hex": "0x02f86c01"
    })
}

fn n3_transaction_signature_body(
    unsigned_hex: &str,
    network: &str,
    key_id: &str,
) -> serde_json::Value {
    let unsigned = hex::decode(unsigned_hex.trim_start_matches("0x")).expect("unsigned hex");
    let signing_key =
        P256SigningKey::from_bytes((&[7_u8; 32]).into()).expect("fixed P-256 signing key");
    let public_key = signing_key.verifying_key().to_encoded_point(true);
    let verification_script =
        verification_script_single_sig(public_key.as_bytes()).expect("P-256 verification script");
    let script_hash =
        script_hash_from_public_key(public_key.as_bytes()).expect("P-256 script hash");
    let network_magic = if network == "mainnet" {
        860_833_102_u32
    } else {
        894_710_606_u32
    };
    let mut message = network_magic.to_le_bytes().to_vec();
    message.extend_from_slice(&Sha256::digest(&unsigned));
    let signature: p256::ecdsa::Signature = signing_key.sign(&message);
    let signature = signature.normalize_s().unwrap_or(signature);
    let mut invocation_script = vec![0x0c, 0x40];
    invocation_script.extend_from_slice(&signature.to_bytes());
    let mut display_digest = Sha256::digest(&unsigned).to_vec();
    display_digest.reverse();

    serde_json::json!({
        "allowed": true,
        "key_id": key_id,
        "script_hash": format!("0x{}", hex::encode(script_hash)),
        "address": address_from_script_hash(&script_hash),
        "digest": format!("0x{}", hex::encode(display_digest)),
        "invocation_script": hex::encode(invocation_script),
        "verification_script": hex::encode(verification_script),
        "chain_family": "neo-n3",
        "signed_transaction": serde_json::Value::Null,
        "signature_hex": serde_json::Value::Null,
    })
}

fn neox_key_body(network: &str, key_id: &str) -> serde_json::Value {
    let chain_id = if network == "mainnet" {
        47_763
    } else {
        12_227_332
    };
    serde_json::json!({
        "allowed": true,
        "key_id": key_id,
        "label": "NeoX verifier",
        "network": network,
        "chain_family": "neox",
        "chain_id": chain_id,
        "network_magic": 0,
        "public_key": "0256b328b30c8bf5839e2405874781499b5dbb445287dadafb0d7f8d62a7ba100e",
        "script_hash": "0x4a62316623ad457f02cdc5d997ded67a383ec569",
        "address": "0x4a62316623ad457f02cdc5d997ded67a383ec569",
        "verification_script": "",
        "signing_enabled": true
    })
}

fn eip191_signature_body(
    key_id: &str,
    chain_id: u64,
    oracle_contract: &str,
    fulfillment: &Fulfillment,
    result_bytes_hex: &str,
) -> serde_json::Value {
    let signing_key = SigningKey::from_bytes((&[7u8; 32]).into()).expect("fixed signing key");
    let digest = build_neox_digest(chain_id, oracle_contract, fulfillment, result_bytes_hex)
        .expect("valid fulfillment");
    let message_hash = eip191_message_hash(&digest);
    let (signature, recovery) = signing_key
        .sign_prehash_recoverable(&message_hash)
        .expect("sign prehash");
    let mut signature_bytes = signature.to_bytes().to_vec();
    signature_bytes.push(recovery.to_byte() + 27);
    let verifying_key = signing_key.verifying_key();
    let public_key = verifying_key.to_encoded_point(true);
    let uncompressed = verifying_key.to_encoded_point(false);
    let address_hash = Keccak256::digest(&uncompressed.as_bytes()[1..]);
    let address = format!("0x{}", hex::encode(&address_hash[12..]));
    serde_json::json!({
        "allowed": true,
        "key_id": key_id,
        "address": address,
        "public_key": format!("0x{}", hex::encode(public_key.as_bytes())),
        "digest": format!("0x{}", hex::encode(digest)),
        "message_hash": format!("0x{}", hex::encode(message_hash)),
        "signature": format!("0x{}", hex::encode(signature_bytes)),
        "chain_family": "neox",
        "chain_id": chain_id,
        "oracle_contract": oracle_contract,
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
        ("SIGNER_ROLE_NEOX_UPDATER_KEY_ID", "neox-updater-1"),
        ("SIGNER_ROLE_NEOX_VERIFIER_KEY_ID", "neox-verifier-1"),
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
fn network_identity_guard_uses_registry_without_defaulting_unknown_labels() {
    for (requested, key_network, magic, expected_ok) in [
        ("mainnet", "mainnet", 860_833_102_u32, true),
        ("testnet", "testnet", 894_710_606_u32, true),
        ("mainnet", "mainnet", 894_710_606_u32, false),
        ("testnet", "testnet", 860_833_102_u32, false),
        ("mainnet", "testnet", 860_833_102_u32, false),
        ("private-A", "private-A", 0, false),
        ("private-A", "private-A", 894_710_606_u32, false),
    ] {
        let mut body = key_body(key_network);
        body["network_magic"] = serde_json::json!(magic);
        let transport =
            FakeTransport::answering(crate::custody::CustodyReply { status: 200, body });
        let plane = signer(&configured_overlay(), transport.clone());
        let report = plane.role_report(requested, "updater");
        assert_eq!(
            report.ok, expected_ok,
            "{requested}/{key_network}/{magic}: {report:?}"
        );
        assert!(
            transport.calls().iter().all(|call| call.method == "GET"),
            "identity checks must not sign"
        );
    }
}

#[test]
fn a_neox_role_report_binds_family_and_chain_without_requiring_an_n3_script() {
    let transport = FakeTransport::answering(crate::custody::CustodyReply {
        status: 200,
        body: neox_key_body(TEST_NETWORK, "neox-verifier-1"),
    });
    let plane = signer(&configured_overlay(), transport);
    let report = plane.role_report(TEST_NETWORK, "neox_verifier");

    assert!(report.ok, "{report:?}");
    assert_eq!(report.identity["chain_family"], "neox");
    assert_eq!(report.identity["chain_id"], 12_227_332);
    assert_eq!(report.identity["network_magic"], serde_json::Value::Null);
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
fn only_https_or_loopback_http_base_urls_reach_the_transport() {
    let invalid_urls = [
        "http://custody.internal.example:9211",
        "http://192.0.2.10:9211",
        "http://[::2]:9211",
        "ftp://127.0.0.1:9211",
        "https://caller:secret@custody.internal.example",
        "https://@custody.internal.example",
        "https://custody.internal.example/base#fragment",
        "https://custody.internal.example/base?tenant=one",
        "custody.internal.example",
    ];

    for base_url in invalid_urls {
        let transport = FakeTransport::answering(crate::custody::CustodyReply {
            status: 200,
            body: key_body(TEST_NETWORK),
        });
        let overlay = [
            ("SIGNER_SERVICE_URL", base_url),
            ("SIGNER_SERVICE_TOKEN", "custody-caller-token"),
            ("SIGNER_ROLE_UPDATER_KEY_ID", "key-updater-1"),
        ];
        let plane = signer(&overlay, transport.clone());

        let report = plane.role_report(TEST_NETWORK, "updater");
        assert!(!report.ok, "{base_url} must fail closed: {report:?}");
        assert!(
            report.issues[0].contains("custody service configuration is invalid"),
            "{base_url}: {report:?}"
        );
        let error = plane
            .sign_payload(TEST_NETWORK, "updater", "00aabb")
            .expect_err("an invalid base URL cannot sign");
        assert_eq!(error.status, 503, "{base_url}: {error:?}");
        assert!(
            transport.calls().is_empty(),
            "invalid URL {base_url} reached the transport"
        );
    }
}

#[test]
fn the_reqwest_transport_never_follows_a_bearer_redirect() {
    let redirect_listener = TcpListener::bind("127.0.0.1:0").expect("redirect listener");
    let redirect_address = redirect_listener.local_addr().expect("redirect address");
    let target_listener = TcpListener::bind("127.0.0.1:0").expect("target listener");
    let target_address = target_listener.local_addr().expect("target address");
    target_listener
        .set_nonblocking(true)
        .expect("nonblocking target");

    let stop_target = Arc::new(AtomicBool::new(false));
    let target_stop = stop_target.clone();
    let target = thread::spawn(move || {
        while !target_stop.load(Ordering::Acquire) {
            match target_listener.accept() {
                Ok((mut stream, _)) => {
                    let headers = read_http_headers(&mut stream);
                    let bearer_leaked = headers
                        .to_ascii_lowercase()
                        .contains("authorization: bearer custody-caller-token");
                    write_json_response(&mut stream, "200 OK", "");
                    return (true, bearer_leaked);
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(5));
                }
                Err(error) => panic!("target accept: {error}"),
            }
        }
        (false, false)
    });

    let redirect = thread::spawn(move || {
        let (mut stream, _) = redirect_listener.accept().expect("redirect request");
        let headers = read_http_headers(&mut stream);
        assert!(
            headers
                .to_ascii_lowercase()
                .contains("authorization: bearer custody-caller-token"),
            "the credential belongs on the original custody request"
        );
        write_json_response(
            &mut stream,
            "302 Found",
            &format!("Location: http://{target_address}/credential-sink\r\n"),
        );
    });

    let transport = crate::custody::ReqwestCustodyTransport::new();
    let reply = crate::custody::CustodyTransport::send(
        &transport,
        crate::custody::CustodyRequest {
            method: "GET",
            url: format!("http://{redirect_address}/signer/api/v1/keys/key-1"),
            token: Some("custody-caller-token".to_string()),
            body: None,
        },
    )
    .expect("the redirect itself remains observable");
    stop_target.store(true, Ordering::Release);

    redirect.join().expect("redirect server");
    let (target_reached, bearer_leaked) = target.join().expect("target server");
    assert_eq!(
        reply.status, 302,
        "redirects must be returned, not followed"
    );
    assert!(!target_reached, "the redirect target must not be contacted");
    assert!(!bearer_leaked, "the bearer must not cross the redirect");
}

#[test]
fn loopback_http_and_remote_https_remain_supported() {
    let valid_urls = [
        "http://127.0.0.1:9211",
        "http://localhost:9211",
        "http://[::1]:9211",
        "https://custody.internal.example",
        "https://custody.internal.example/private/base",
    ];

    for base_url in valid_urls {
        let transport = FakeTransport::answering(crate::custody::CustodyReply {
            status: 200,
            body: key_body(TEST_NETWORK),
        });
        let overlay = [
            ("SIGNER_SERVICE_URL", base_url),
            ("SIGNER_SERVICE_TOKEN", "custody-caller-token"),
            ("SIGNER_ROLE_UPDATER_KEY_ID", "key-updater-1"),
        ];
        let plane = signer(&overlay, transport.clone());

        let report = plane.role_report(TEST_NETWORK, "updater");
        assert!(report.ok, "{base_url} should remain supported: {report:?}");
        assert_eq!(transport.calls().len(), 1, "{base_url}");
    }
}

#[test]
fn the_role_key_id_is_one_percent_encoded_path_segment() {
    let key_id = "key/../../sign/raw?# segment";
    let mut body = key_body(TEST_NETWORK);
    body["key_id"] = serde_json::json!(key_id);
    let transport = FakeTransport::answering(crate::custody::CustodyReply { status: 200, body });
    let overlay = [
        ("SIGNER_SERVICE_URL", "http://127.0.0.1:9211"),
        ("SIGNER_SERVICE_TOKEN", "custody-caller-token"),
        ("SIGNER_ROLE_UPDATER_KEY_ID", key_id),
    ];
    let plane = signer(&overlay, transport.clone());

    let report = plane.role_report(TEST_NETWORK, "updater");
    assert!(report.ok, "{report:?}");
    let calls = transport.calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(
        calls[0].url,
        "http://127.0.0.1:9211/signer/api/v1/keys/key%2F..%2F..%2Fsign%2Fraw%3F%23%20segment"
    );
    let parsed = url::Url::parse(&calls[0].url).expect("encoded request URL");
    assert!(parsed.query().is_none());
    assert!(parsed.fragment().is_none());
}

#[test]
fn dot_segment_key_ids_fail_closed_before_transport() {
    for key_id in [".", ".."] {
        let transport = FakeTransport::answering(crate::custody::CustodyReply {
            status: 200,
            body: key_body(TEST_NETWORK),
        });
        let overlay = [
            ("SIGNER_SERVICE_URL", "http://127.0.0.1:9211"),
            ("SIGNER_SERVICE_TOKEN", "custody-caller-token"),
            ("SIGNER_ROLE_UPDATER_KEY_ID", key_id),
        ];
        let plane = signer(&overlay, transport.clone());

        let report = plane.role_report(TEST_NETWORK, "updater");
        assert!(!report.ok, "{key_id} cannot name a URL path segment");
        assert!(transport.calls().is_empty());
    }
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
fn a_successful_key_read_requires_allowed_true() {
    let mut body = key_body(TEST_NETWORK);
    body["allowed"] = serde_json::json!(false);
    let transport = FakeTransport::answering(crate::custody::CustodyReply { status: 200, body });
    let plane = signer(&configured_overlay(), transport);

    let report = plane.role_report(TEST_NETWORK, "updater");
    assert!(!report.ok, "a 2xx refusal is not a usable key: {report:?}");
    assert!(report.issues[0].contains("allowed was not true"));
}

#[test]
fn an_explicit_key_chain_family_must_be_neo_n3() {
    for invalid_family in [
        serde_json::json!("neox"),
        serde_json::json!(""),
        serde_json::Value::Null,
    ] {
        let mut body = key_body(TEST_NETWORK);
        body["chain_family"] = invalid_family;
        let transport =
            FakeTransport::answering(crate::custody::CustodyReply { status: 200, body });
        let plane = signer(&configured_overlay(), transport);

        let report = plane.role_report(TEST_NETWORK, "updater");
        assert!(!report.ok, "wrong family must fail closed: {report:?}");
        assert!(report.issues[0].contains("chain_family was not neo-n3"));
    }
}

#[test]
fn a_legacy_key_read_without_chain_family_remains_compatible() {
    let mut body = key_body(TEST_NETWORK);
    body.as_object_mut()
        .expect("key body object")
        .remove("chain_family");
    let transport = FakeTransport::answering(crate::custody::CustodyReply { status: 200, body });
    let plane = signer(&configured_overlay(), transport);

    assert!(plane.role_report(TEST_NETWORK, "updater").ok);
}

#[test]
fn a_key_read_requires_its_bound_id_and_complete_public_identity() {
    for field in [
        "key_id",
        "public_key",
        "address",
        "script_hash",
        "verification_script",
    ] {
        let mut body = key_body(TEST_NETWORK);
        body[field] = serde_json::json!("  ");
        let transport =
            FakeTransport::answering(crate::custody::CustodyReply { status: 200, body });
        let plane = signer(&configured_overlay(), transport);

        let report = plane.role_report(TEST_NETWORK, "updater");
        assert!(!report.ok, "missing {field} must fail closed: {report:?}");
        assert!(
            report.issues[0].contains("invalid key response"),
            "{field}: {report:?}"
        );
    }

    let mut body = key_body(TEST_NETWORK);
    body["key_id"] = serde_json::json!("another-key");
    let transport = FakeTransport::answering(crate::custody::CustodyReply { status: 200, body });
    let plane = signer(&configured_overlay(), transport);
    let report = plane.role_report(TEST_NETWORK, "updater");
    assert!(!report.ok, "a substituted key row must fail closed");
    assert!(report.issues[0].contains("key_id was missing or did not match"));
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
fn a_2xx_sign_refusal_is_not_passed_through_as_a_signature() {
    let mut body = raw_signature_body();
    body["allowed"] = serde_json::json!(false);
    body["code"] = serde_json::json!("raw-forbidden");
    body["message"] = serde_json::json!("raw signatures are not allowed");
    let transport = FakeTransport::answering(crate::custody::CustodyReply { status: 200, body });
    let plane = signer(&configured_overlay(), transport);

    let error = plane
        .sign_payload(TEST_NETWORK, "updater", "00aabb")
        .expect_err("2xx with allowed:false fails closed");
    assert_eq!(error.status, 502);
    assert!(error.message.contains("allowed was not true"));
}

#[test]
fn a_sign_success_requires_every_witness_field() {
    for field in [
        "key_id",
        "script_hash",
        "address",
        "digest",
        "signature",
        "public_key",
        "invocation_script",
        "verification_script",
    ] {
        let mut body = raw_signature_body();
        body[field] = serde_json::json!("  ");
        let transport =
            FakeTransport::answering(crate::custody::CustodyReply { status: 200, body });
        let plane = signer(&configured_overlay(), transport);

        let error = plane
            .sign_payload(TEST_NETWORK, "updater", "00aabb")
            .expect_err("an incomplete witness fails closed");
        assert_eq!(error.status, 502, "{field}: {error:?}");
    }
}

#[test]
fn a_sign_success_cannot_substitute_a_key_or_chain_family() {
    let mut wrong_key = raw_signature_body();
    wrong_key["key_id"] = serde_json::json!("another-key");
    let transport = FakeTransport::answering(crate::custody::CustodyReply {
        status: 200,
        body: wrong_key,
    });
    let plane = signer(&configured_overlay(), transport);
    let error = plane
        .sign_payload(TEST_NETWORK, "updater", "00aabb")
        .expect_err("a substituted key fails closed");
    assert_eq!(error.status, 502);
    assert!(error.message.contains("key_id did not match"));

    let mut wrong_family = raw_signature_body();
    wrong_family["chain_family"] = serde_json::json!("neox");
    let transport = FakeTransport::answering(crate::custody::CustodyReply {
        status: 200,
        body: wrong_family,
    });
    let plane = signer(&configured_overlay(), transport);
    let error = plane
        .sign_payload(TEST_NETWORK, "updater", "00aabb")
        .expect_err("a non-N3 signature fails closed");
    assert_eq!(error.status, 502);
    assert!(error.message.contains("chain_family was not neo-n3"));
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
fn a_transaction_request_posts_the_chain_bound_unsigned_transaction() {
    let transport = FakeTransport::answering(crate::custody::CustodyReply {
        status: 200,
        body: transaction_signature_body(),
    });
    let plane = signer(&configured_overlay(), transport.clone());
    let reply = plane
        .sign_transaction(
            TEST_NETWORK,
            "neox_updater",
            12_227_332,
            "0x02c0",
            "feed-neox:abc",
        )
        .expect("transaction signs");
    assert_eq!(reply["chain_family"], "neox");
    assert_eq!(reply["chain_id"], 12_227_332);
    assert_eq!(reply["key_id"], "neox-updater-1");
    assert_eq!(reply["signed_transaction"], "0x02f86c01");
    assert_eq!(reply["signature_hex"], reply["signed_transaction"]);

    let calls = transport.calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].method, "POST");
    assert_eq!(
        calls[0].url,
        "http://127.0.0.1:9211/signer/api/v1/sign/transaction"
    );
    assert_eq!(calls[0].token.as_deref(), Some("custody-caller-token"));
    assert_eq!(
        calls[0].body,
        Some(serde_json::json!({
            "key_id": "neox-updater-1",
            "unsigned_hex": "0x02c0",
            "request_id": "feed-neox:abc",
            "chain_family": "neox",
            "chain_id": 12_227_332,
        }))
    );
}

#[test]
fn an_n3_transaction_request_is_semantic_and_the_returned_witness_is_verified() {
    let unsigned_hex = "0x01020304";
    let body = n3_transaction_signature_body(unsigned_hex, TEST_NETWORK, "key-updater-1");
    let expected_signature = body["invocation_script"]
        .as_str()
        .expect("invocation script")
        .strip_prefix("0c40")
        .expect("canonical invocation")
        .to_string();
    let transport = FakeTransport::answering(crate::custody::CustodyReply { status: 200, body });
    let plane = signer(&configured_overlay(), transport.clone());

    let reply = plane
        .sign_n3_transaction(TEST_NETWORK, "updater", unsigned_hex, "n3-feed:vector-1")
        .expect("N3 transaction signs");
    assert_eq!(reply["chain_family"], "neo-n3");
    assert_eq!(reply["key_id"], "key-updater-1");
    assert_eq!(reply["signature"], expected_signature);
    assert_eq!(reply["signature_hex"], reply["signature"]);
    assert_eq!(reply["public_key"].as_str().expect("public key").len(), 66);

    let calls = transport.calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].method, "POST");
    assert_eq!(
        calls[0].url,
        "http://127.0.0.1:9211/signer/api/v1/sign/transaction"
    );
    assert_eq!(calls[0].token.as_deref(), Some("custody-caller-token"));
    assert_eq!(
        calls[0].body,
        Some(serde_json::json!({
            "key_id": "key-updater-1",
            "unsigned_hex": "01020304",
            "request_id": "n3-feed:vector-1",
            "chain_family": "neo-n3",
        }))
    );
}

#[test]
fn an_n3_transaction_success_cannot_substitute_digest_identity_or_signature() {
    let unsigned_hex = "01020304";
    let valid = n3_transaction_signature_body(unsigned_hex, TEST_NETWORK, "key-updater-1");
    let mut cases = Vec::new();

    let mut wrong_digest = valid.clone();
    wrong_digest["digest"] = serde_json::json!(format!("0x{}", "00".repeat(32)));
    cases.push((wrong_digest, "digest did not match"));

    let mut wrong_script_hash = valid.clone();
    wrong_script_hash["script_hash"] = serde_json::json!(format!("0x{}", "00".repeat(20)));
    cases.push((wrong_script_hash, "script_hash did not match"));

    let mut wrong_address = valid.clone();
    wrong_address["address"] = serde_json::json!("NbadCustodyIdentity");
    cases.push((wrong_address, "address did not match"));

    let mut wrong_signature = valid;
    let mut invocation = hex::decode(
        wrong_signature["invocation_script"]
            .as_str()
            .expect("invocation script"),
    )
    .expect("invocation hex");
    *invocation.last_mut().expect("signature byte") ^= 1;
    wrong_signature["invocation_script"] = serde_json::json!(hex::encode(invocation));
    cases.push((wrong_signature, "signature did not verify"));

    for (body, message) in cases {
        let transport =
            FakeTransport::answering(crate::custody::CustodyReply { status: 200, body });
        let plane = signer(&configured_overlay(), transport);
        let error = plane
            .sign_n3_transaction(TEST_NETWORK, "updater", unsigned_hex, "n3-feed:negative")
            .expect_err("substituted N3 witness must fail closed");
        assert_eq!(error.status, 502, "{error:?}");
        assert!(error.message.contains(message), "{error:?}");
    }
}

#[test]
fn an_n3_transaction_signature_cannot_replay_between_networks() {
    let unsigned_hex = "01020304";
    let transport = FakeTransport::answering(crate::custody::CustodyReply {
        status: 200,
        body: n3_transaction_signature_body(unsigned_hex, "testnet", "key-updater-1"),
    });
    let plane = signer(&configured_overlay(), transport);
    let error = plane
        .sign_n3_transaction("mainnet", "updater", unsigned_hex, "n3-feed:network-replay")
        .expect_err("a testnet witness must not verify on mainnet");
    assert_eq!(error.status, 502, "{error:?}");
    assert!(
        error.message.contains("signature did not verify"),
        "{error:?}"
    );
}

#[test]
fn an_eip191_request_is_structured_and_the_returned_signature_is_recovered() {
    let chain_id = 12_227_332;
    let oracle_contract = "0x2222222222222222222222222222222222222222";
    let fulfillment = Fulfillment {
        request_id: "42".to_string(),
        app_id: "demo.app".to_string(),
        module_id: "oracle.fetch".to_string(),
        operation: "privacy_oracle".to_string(),
        success: true,
        error: String::new(),
    };
    let result_bytes_hex = "0x68656c6c6f";
    let transport = FakeTransport::answering(crate::custody::CustodyReply {
        status: 200,
        body: eip191_signature_body(
            "neox-verifier-1",
            chain_id,
            oracle_contract,
            &fulfillment,
            result_bytes_hex,
        ),
    });
    let plane = signer(&configured_overlay(), transport.clone());
    let reply = plane
        .sign_eip191_fulfillment(&Eip191FulfillmentRequest {
            network: TEST_NETWORK,
            role: "neox_verifier",
            chain_id,
            oracle_contract,
            fulfillment: &fulfillment,
            result_bytes_hex,
            request_id: "neox-fulfill:vector-42",
        })
        .expect("semantic signature");
    assert_eq!(reply["chain_family"], "neox");
    assert_eq!(reply["chain_id"], chain_id);
    assert_eq!(reply["key_id"], "neox-verifier-1");
    assert_eq!(reply["oracle_contract"], oracle_contract);
    assert_eq!(reply["signature"].as_str().expect("signature").len(), 132);

    let calls = transport.calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].method, "POST");
    assert_eq!(
        calls[0].url,
        "http://127.0.0.1:9211/signer/api/v1/sign/eip191-fulfillment"
    );
    assert_eq!(
        calls[0].body,
        Some(serde_json::json!({
            "key_id": "neox-verifier-1",
            "request_id": "neox-fulfill:vector-42",
            "chain_id": chain_id,
            "oracle_contract": oracle_contract,
            "fulfillment": {
                "request_id": "42",
                "app_id": "demo.app",
                "module_id": "oracle.fetch",
                "operation": "privacy_oracle",
                "success": true,
                "error": "",
            },
            "result_bytes_hex": result_bytes_hex,
        }))
    );
}

#[test]
fn an_eip191_success_cannot_substitute_digest_or_signature_identity() {
    let chain_id = 12_227_332;
    let oracle_contract = "0x2222222222222222222222222222222222222222";
    let fulfillment = Fulfillment {
        request_id: "42".to_string(),
        app_id: "demo.app".to_string(),
        module_id: "oracle.fetch".to_string(),
        operation: "privacy_oracle".to_string(),
        success: true,
        error: String::new(),
    };
    let valid = eip191_signature_body(
        "neox-verifier-1",
        chain_id,
        oracle_contract,
        &fulfillment,
        "0x01",
    );
    let mut cases = Vec::new();
    let mut wrong_digest = valid.clone();
    wrong_digest["digest"] = serde_json::json!(format!("0x{}", "00".repeat(32)));
    cases.push((wrong_digest, "digest did not match"));
    let mut wrong_hash = valid.clone();
    wrong_hash["message_hash"] = serde_json::json!(format!("0x{}", "00".repeat(32)));
    cases.push((wrong_hash, "message_hash did not match"));
    let mut wrong_key = valid.clone();
    wrong_key["public_key"] = serde_json::json!(format!("0x02{}", "00".repeat(32)));
    cases.push((wrong_key, "public_key did not match"));
    let mut wrong_address = valid;
    wrong_address["address"] = serde_json::json!(format!("0x{}", "00".repeat(20)));
    cases.push((wrong_address, "address did not match"));

    for (body, expected) in cases {
        let transport =
            FakeTransport::answering(crate::custody::CustodyReply { status: 200, body });
        let plane = signer(&configured_overlay(), transport);
        let error = plane
            .sign_eip191_fulfillment(&Eip191FulfillmentRequest {
                network: TEST_NETWORK,
                role: "neox_verifier",
                chain_id,
                oracle_contract,
                fulfillment: &fulfillment,
                result_bytes_hex: "0x01",
                request_id: "neox-fulfill:negative",
            })
            .expect_err("substituted response must fail closed");
        assert_eq!(error.status, 502, "{error:?}");
        assert!(error.message.contains(expected), "{error:?}");
    }
}

#[test]
fn a_transaction_success_cannot_substitute_key_family_or_signed_bytes() {
    let mut cases = Vec::new();
    let mut denied = transaction_signature_body();
    denied["allowed"] = serde_json::json!(false);
    cases.push((denied, "allowed was not true"));
    let mut wrong_key = transaction_signature_body();
    wrong_key["key_id"] = serde_json::json!("another-key");
    cases.push((wrong_key, "key_id did not match"));
    let mut wrong_family = transaction_signature_body();
    wrong_family["chain_family"] = serde_json::json!("neo-n3");
    cases.push((wrong_family, "chain_family was not neox"));
    let mut missing_transaction = transaction_signature_body();
    missing_transaction["signed_transaction"] = serde_json::json!("");
    cases.push((
        missing_transaction,
        "a required signature field was missing",
    ));
    let mut alias_drift = transaction_signature_body();
    alias_drift["signature_hex"] = serde_json::json!("0x02dead");
    cases.push((
        alias_drift,
        "signature_hex did not match signed_transaction",
    ));

    for (body, message) in cases {
        let transport =
            FakeTransport::answering(crate::custody::CustodyReply { status: 200, body });
        let plane = signer(&configured_overlay(), transport);
        let error = plane
            .sign_transaction(
                TEST_NETWORK,
                "neox_updater",
                12_227_332,
                "0x02c0",
                "feed-neox:abc",
            )
            .expect_err("invalid transaction response fails closed");
        assert_eq!(error.status, 502, "{error:?}");
        assert!(error.message.contains(message), "{error:?}");
    }
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
