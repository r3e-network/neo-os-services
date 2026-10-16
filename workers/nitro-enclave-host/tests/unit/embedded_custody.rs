use super::*;
use axum::extract::Request as AxumRequest;
use axum::routing::any;
use axum::Json;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

fn request(network: &str, path: &str) -> CustodyRequest {
    CustodyRequest {
        method: "POST",
        url: format!("{}{path}", embedded_base_url(network).unwrap()),
        token: Some("synthetic-caller".to_string()),
        body: Some(serde_json::json!({"key_id":"synthetic-key","data_hex":"0102"})),
    }
}

fn counting_router(calls: Arc<AtomicUsize>, network: &'static str) -> Router {
    Router::new().fallback(any(move |request: AxumRequest| {
        let calls = Arc::clone(&calls);
        async move {
            calls.fetch_add(1, Ordering::SeqCst);
            let authenticated = request.headers().get("authorization")
                .is_some_and(|h| h == "Bearer synthetic-caller");
            let body = to_bytes(request.into_body(), MAX_CUSTODY_BODY_BYTES).await.unwrap();
            if !authenticated {
                return (axum::http::StatusCode::UNAUTHORIZED, Json(serde_json::json!({"allowed":false,"code":"unauthorized"})));
            }
            (axum::http::StatusCode::OK, Json(serde_json::json!({"allowed":true,"network":network,"request":serde_json::from_slice::<serde_json::Value>(&body).ok()})))
        }
    }))
}

#[tokio::test]
async fn credentials_body_and_refusal_are_preserved() {
    let calls = Arc::new(AtomicUsize::new(0));
    let transport =
        InProcessCustodyTransport::new("mainnet", counting_router(calls.clone(), "mainnet"))
            .unwrap();
    let req = request("mainnet", "/signer/api/v1/sign/raw");
    let reply = transport.send_async(req.clone()).await.unwrap();
    assert_eq!(reply.status, 200);
    assert_eq!(reply.body["request"], req.body.unwrap());
    let mut missing = request("mainnet", "/signer/api/v1/sign/raw");
    missing.token = None;
    let reply = transport.send_async(missing).await.unwrap();
    assert_eq!(reply.status, 401);
    assert_eq!(reply.body["allowed"], false);
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn network_router_binding_cannot_be_selected_by_url() {
    let main_calls = Arc::new(AtomicUsize::new(0));
    let test_calls = Arc::new(AtomicUsize::new(0));
    let main =
        InProcessCustodyTransport::new("mainnet", counting_router(main_calls.clone(), "mainnet"))
            .unwrap();
    let test =
        InProcessCustodyTransport::new("testnet", counting_router(test_calls.clone(), "testnet"))
            .unwrap();
    for (transport, network) in [(&main, "mainnet"), (&test, "testnet")] {
        let reply = transport
            .send_async(request(network, "/signer/api/v1/sign/transaction"))
            .await
            .unwrap();
        assert_eq!(reply.body["network"], network);
    }
    assert!(main
        .send_async(request("testnet", "/signer/api/v1/sign/raw"))
        .await
        .is_err());
    assert!(test
        .send_async(request("mainnet", "/signer/api/v1/sign/raw"))
        .await
        .is_err());
    assert_eq!(main_calls.load(Ordering::SeqCst), 1);
    assert_eq!(test_calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn transport_never_exposes_management_or_normalizes_a_route() {
    let calls = Arc::new(AtomicUsize::new(0));
    let transport =
        InProcessCustodyTransport::new("mainnet", counting_router(calls.clone(), "mainnet"))
            .unwrap();
    for path in [
        "/provision",
        "/attestation",
        "/health",
        "/signer/api/v1/callers",
        "/signer/api/v1/keys",
        "/signer/api/v1/sign/raw?network=testnet",
        "/signer/api/v1/sign/%72aw",
        "/signer/api/v1/keys/../sign/raw",
        "x/signer/api/v1/sign/raw",
        "/signer/api/v1/sign/raw/",
        "/signer//api/v1/sign/raw",
    ] {
        assert!(
            transport
                .send_async(request("mainnet", path))
                .await
                .is_err(),
            "{path}"
        );
    }
    for base in [
        "https://127.0.0.1:0/mainnet",
        "http://127.0.0.1:1/mainnet",
        "http://localhost:0/mainnet",
        "http://user@127.0.0.1:0/mainnet",
        "http://127.0.0.1:0/testnet",
    ] {
        let mut req = request("mainnet", "/signer/api/v1/sign/raw");
        req.url = format!("{base}/signer/api/v1/sign/raw");
        assert!(transport.send_async(req).await.is_err());
    }
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn key_lookup_is_bounded_and_get_only() {
    let calls = Arc::new(AtomicUsize::new(0));
    let transport =
        InProcessCustodyTransport::new("testnet", counting_router(calls.clone(), "testnet"))
            .unwrap();
    let mut req = request("testnet", "/signer/api/v1/keys/a-123_4");
    assert!(transport.send_async(req.clone()).await.is_err());
    req.method = "GET";
    req.body = None;
    assert_eq!(transport.send_async(req.clone()).await.unwrap().status, 200);
    for id in [
        String::new(),
        "..".into(),
        "%2e%2e".into(),
        "a/b".into(),
        "a?x=1".into(),
        "a".repeat(129),
    ] {
        req.url = format!(
            "{}/signer/api/v1/keys/{id}",
            embedded_base_url("testnet").unwrap()
        );
        assert!(transport.send_async(req.clone()).await.is_err());
    }
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn malformed_credentials_and_oversized_body_stop_before_dispatch() {
    let calls = Arc::new(AtomicUsize::new(0));
    let transport =
        InProcessCustodyTransport::new("mainnet", counting_router(calls.clone(), "mainnet"))
            .unwrap();
    let mut req = request("mainnet", "/signer/api/v1/sign/raw");
    req.token = Some("synthetic\r\nx-header: injected".into());
    let error = transport.send_async(req).await.unwrap_err();
    assert!(!error.contains("synthetic"));
    let mut req = request("mainnet", "/signer/api/v1/sign/raw");
    req.body = Some(serde_json::json!({"data_hex":"a".repeat(MAX_CUSTODY_BODY_BYTES)}));
    assert!(transport.send_async(req).await.is_err());
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn non_json_and_oversized_responses_fail_closed() {
    for body in [
        "not-json".to_string(),
        format!("\"{}\"", "a".repeat(MAX_CUSTODY_BODY_BYTES)),
    ] {
        let router = Router::new().fallback(any(move || {
            let body = body.clone();
            async move { body }
        }));
        let transport = InProcessCustodyTransport::new("mainnet", router).unwrap();
        assert!(transport
            .send_async(request("mainnet", "/signer/api/v1/sign/raw"))
            .await
            .is_err());
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
async fn synchronous_host_dispatch_uses_the_same_router() {
    let calls = Arc::new(AtomicUsize::new(0));
    let transport =
        InProcessCustodyTransport::new("mainnet", counting_router(calls.clone(), "mainnet"))
            .unwrap();
    let result = tokio::task::spawn_blocking(move || {
        transport.send(request("mainnet", "/signer/api/v1/sign/eip191-fulfillment"))
    })
    .await
    .unwrap()
    .unwrap();
    assert_eq!(result.body["network"], "mainnet");
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[test]
fn rejects_unknown_network_without_configuration_echo() {
    let error = InProcessCustodyTransport::new("not-a-network", Router::new())
        .err()
        .unwrap();
    assert_eq!(error, "invalid embedded custody network");
}

// These fixtures use the real custody router, caller grants, policy and SQLite
// audit. All keys are generated only in disposable local stores. This proves
// adapter integration, not NSM/KMS recovery or remote durability acceptance.
struct RealCustody {
    transport: InProcessCustodyTransport,
    service: neo_signer::service::SignerService,
    admin: neo_signer::auth::CallerCredentials,
    token: String,
    key: neo_signer::service::KeyPublicInfo,
    _directory: tempfile::TempDir,
}

fn allowed<T>(outcome: neo_signer::service::Outcome<T>) -> T {
    match outcome {
        neo_signer::service::Outcome::Allowed(value) => value,
        neo_signer::service::Outcome::Refused(refusal) => {
            panic!("fixture refusal: {}", refusal.code)
        }
    }
}

fn real_custody(network: neo_signer::network::Network) -> RealCustody {
    use neo_signer::{
        api::ApiState,
        auth::CallerCredentials,
        model::{CallerCapability, KeyGrant, SignerPolicy},
        service::{provision_admin_caller, SignerService},
        store::Store,
        vault::MasterKey,
    };
    let directory = tempfile::tempdir().unwrap();
    let service = SignerService::new(
        Store::open(directory.path().join("signer.db")).unwrap(),
        MasterKey::from_bytes([19; 32]),
    );
    let (_, token) = provision_admin_caller(service.repository(), "local-test-bootstrap").unwrap();
    let admin = CallerCredentials::server_to_server(&token);
    let key = allowed(
        service
            .generate_key(&admin, "local-raw-key", network, None)
            .unwrap(),
    );
    allowed(
        service
            .save_policy(
                &admin,
                &key.key_id,
                &SignerPolicy {
                    allow_raw: true,
                    ..Default::default()
                },
            )
            .unwrap(),
    );
    let (_, token) = allowed(
        service
            .create_caller(
                &admin,
                "local-raw-caller",
                KeyGrant::Only(vec![key.key_id.clone()]),
                &[CallerCapability::RawSign],
                &[],
            )
            .unwrap(),
    );
    let transport = InProcessCustodyTransport::new(
        &network.to_string(),
        neo_signer::api::router(ApiState::new(service.clone())),
    )
    .unwrap();
    RealCustody {
        transport,
        service,
        admin,
        token,
        key,
        _directory: directory,
    }
}

fn real_request(vault: &RealCustody) -> CustodyRequest {
    let mut req = request(&vault.key.network.to_string(), "/signer/api/v1/sign/raw");
    req.token = Some(vault.token.clone());
    req.body = Some(serde_json::json!({"key_id":vault.key.key_id,"data_hex":"01020304"}));
    req
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn real_custody_retains_signature_auth_policy_and_network_routing() {
    use neo_signer::{model::SignerPolicy, network::Network};
    use p256::ecdsa::{signature::hazmat::PrehashVerifier, Signature, VerifyingKey};
    let main = real_custody(Network::Mainnet);
    let test = real_custody(Network::Testnet);
    for vault in [&main, &test] {
        let reply = vault
            .transport
            .send_async(real_request(vault))
            .await
            .unwrap();
        assert_eq!(reply.status, 200);
        assert_eq!(reply.body["allowed"], true);
        let signature =
            Signature::from_slice(&hex::decode(reply.body["signature"].as_str().unwrap()).unwrap())
                .unwrap();
        let digest = hex::decode(
            reply.body["digest"]
                .as_str()
                .unwrap()
                .strip_prefix("0x")
                .unwrap(),
        )
        .unwrap();
        VerifyingKey::from_sec1_bytes(&vault.key.public_key)
            .unwrap()
            .verify_prehash(&digest, &signature)
            .unwrap();
    }
    // Correct URL but the other vault's real caller token still fails native
    // authentication; URL swapping itself fails before router dispatch.
    let mut crossed = real_request(&test);
    crossed.token = Some(main.token.clone());
    let crossed = test.transport.send_async(crossed).await.unwrap();
    assert_eq!(crossed.status, 403);
    assert_eq!(crossed.body["allowed"], false);
    assert!(crossed.body.get("signature").is_none());
    assert!(main
        .transport
        .send_async(real_request(&test))
        .await
        .is_err());
    allowed(
        main.service
            .save_policy(&main.admin, &main.key.key_id, &SignerPolicy::default())
            .unwrap(),
    );
    let refused = main
        .transport
        .send_async(real_request(&main))
        .await
        .unwrap();
    assert_eq!(refused.status, 403);
    assert_eq!(refused.body["allowed"], false);
    assert!(refused.body.get("signature").is_none());
    assert_eq!(
        test.transport
            .send_async(real_request(&test))
            .await
            .unwrap()
            .status,
        200
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn real_custody_key_grant_and_host_role_checks_remain_effective() {
    use crate::{custody::CustodySigner, overlay::EnvOverlay, state::SignerPlane};
    use neo_signer::network::Network;
    use std::sync::RwLock;
    let vault = real_custody(Network::Testnet);
    let other = allowed(
        vault
            .service
            .generate_key(&vault.admin, "ungranted", Network::Testnet, None)
            .unwrap(),
    );
    let mut req = real_request(&vault);
    req.body.as_mut().unwrap()["key_id"] = serde_json::json!(other.key_id);
    let refusal = vault.transport.send_async(req).await.unwrap();
    assert_eq!(refusal.status, 403);
    assert_eq!(refusal.body["allowed"], false);
    let overlay = Arc::new(RwLock::new(EnvOverlay::new([
        ("SIGNER_SERVICE_URL", embedded_base_url("testnet").unwrap()),
        ("SIGNER_SERVICE_TOKEN", vault.token.clone()),
        ("SIGNER_ROLE_WORKER_KEY_ID", vault.key.key_id.clone()),
    ])));
    let signer = CustodySigner::new(overlay, Box::new(vault.transport.clone()));
    let (correct, wrong) = tokio::task::spawn_blocking(move || {
        (
            signer.role_report("testnet", "worker"),
            signer.role_report("mainnet", "worker"),
        )
    })
    .await
    .unwrap();
    assert!(correct.ok && correct.materialized);
    assert!(!wrong.ok && !wrong.materialized);
}
