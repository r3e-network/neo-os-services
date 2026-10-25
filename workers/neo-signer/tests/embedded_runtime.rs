use axum::{
    body::{to_bytes, Body},
    http::Request,
};
use neo_signer::{
    attestation::BootGuard,
    embedded::{EmbeddedCustodyConfig, EmbeddedCustodyRuntime},
    network::Network,
    vault::MasterKey,
    vault_profile::{
        root_key_commitment, CoordinatorProfile, ReceiptVerifierKey, VaultNetwork, VaultProfile,
        PROFILE_VERSION, SIGNER_SCHEMA_VERSION, SNAPSHOT_FORMAT_VERSION,
    },
};
use nitro_attest::release::AttestationSource;
use p256::{elliptic_curve::sec1::ToSec1Point, SecretKey};
use std::{
    path::Path,
    sync::{Arc, Mutex},
};
use tower::ServiceExt;

fn profile(master: &MasterKey) -> VaultProfile {
    let receipt_key = SecretKey::from_slice(&[7; 32]).unwrap();
    VaultProfile {
        profile_version: PROFILE_VERSION,
        vault_id: "00112233445566778899aabbccddeeff".to_string(),
        environment: "testnet".to_string(),
        networks: vec![
            VaultNetwork {
                chain_family: "neo-n3".to_string(),
                chain_id: 894_710_606,
                genesis_hash: format!("0x{}", "11".repeat(32)),
            },
            VaultNetwork {
                chain_family: "neox".to_string(),
                chain_id: 12_227_332,
                genesis_hash: format!("0x{}", "22".repeat(32)),
            },
        ],
        custody_kms_key_arn:
            "arn:aws:kms:ap-southeast-1:736326664265:key/11111111-2222-3333-4444-555555555555"
                .to_string(),
        root_key_version: "testnet-r6".to_string(),
        root_key_commitment: hex::encode(root_key_commitment(master)),
        snapshot_format_version: SNAPSHOT_FORMAT_VERSION,
        signer_schema_version: SIGNER_SCHEMA_VERSION,
        coordinator: CoordinatorProfile {
            origin: "https://custody-state-testnet.neoos.network".to_string(),
            aws_region: "ap-southeast-1".to_string(),
            snapshot_bucket: "neoos-custody-state-testnet-736326664265".to_string(),
            snapshot_prefix: "vaults/testnet-r6".to_string(),
            receipt_keys: vec![ReceiptVerifierKey {
                key_id: "receipt-r1".to_string(),
                public_key_sec1_hex: hex::encode(
                    receipt_key.public_key().to_sec1_point(false).as_bytes(),
                ),
            }],
        },
        release_policy_version: "testnet-r6".to_string(),
    }
}

fn config(dir: &Path) -> EmbeddedCustodyConfig {
    EmbeddedCustodyConfig {
        enrollment: None,
        profile: Arc::new(profile(&MasterKey::from_bytes([9; 32])).validate().unwrap()),
        expected_network: Network::Testnet,
        data_dir: dir.to_path_buf(),
        workload_audience: "https://custody.test.example".into(),
        max_body_bytes: 256 * 1024,
        max_in_flight_requests: 2,
    }
}
#[derive(Default)]
struct Synthetic {
    nonces: Mutex<Vec<Vec<u8>>>,
    stale: bool,
    zero: bool,
    fail: bool,
}
impl AttestationSource for Synthetic {
    fn attest(
        &self,
        nonce: Option<&[u8]>,
        _: Option<&[u8]>,
        _: Option<&[u8]>,
    ) -> Result<Vec<u8>, String> {
        if self.fail {
            return Err("synthetic device unavailable".into());
        }
        let nonce = nonce.expect("fresh challenge required");
        self.nonces.lock().unwrap().push(nonce.to_vec());
        let mut payload = vec![0xa2, 0x64, b'p', b'c', b'r', b's', 0xa1, 0x00, 0x58, 48];
        payload.extend_from_slice(&[if self.zero { 0 } else { 0x31 }; 48]);
        payload.extend_from_slice(&[0x65, b'n', b'o', b'n', b'c', b'e', 0x50]);
        payload.extend_from_slice(if self.stale { &[0; 16] } else { nonce });
        let mut cose = vec![0xd2, 0x84, 0x40, 0xa0, 0x58, payload.len() as u8];
        cose.extend(payload);
        cose.extend([0x40]);
        Ok(cose)
    }
}
fn boot(dir: &Path, source: &Synthetic) -> anyhow::Result<EmbeddedCustodyRuntime> {
    EmbeddedCustodyRuntime::boot_with_attestation_source(
        config(dir),
        BootGuard::required(None)?,
        source,
    )
}
#[tokio::test]
async fn exported_router_clones_keep_exclusive_lease_and_remain_sealed() {
    let dir = tempfile::tempdir().unwrap();
    let source = Synthetic::default();
    let runtime = boot(dir.path(), &source).unwrap();
    assert_eq!(runtime.expected_network(), Network::Testnet);
    assert_eq!(runtime.measured_pcr0(), "31".repeat(48));
    let router = runtime.router();
    let clone = router.clone();
    drop(runtime);
    assert!(boot(dir.path(), &source).is_err());
    let response = clone
        .oneshot(
            Request::builder()
                .uri("/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let body = to_bytes(response.into_body(), 4096).await.unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&body).unwrap()["status"],
        "unprovisioned"
    );
    assert!(!dir.path().join("signer.db").exists());
    assert!(!dir.path().join("signer-master.key").exists());
    assert!(boot(dir.path(), &source).is_err());
    drop(router);
    drop(boot(dir.path(), &source).unwrap());
    let nonces = source.nonces.lock().unwrap();
    assert_eq!(nonces.len(), 2);
    assert_ne!(nonces[0], nonces[1]);
}
#[test]
fn source_failures_replays_zero_and_pin_mismatch_fail_closed_and_release_lock() {
    let dir = tempfile::tempdir().unwrap();
    for source in [
        Synthetic {
            fail: true,
            ..Default::default()
        },
        Synthetic {
            stale: true,
            ..Default::default()
        },
        Synthetic {
            zero: true,
            ..Default::default()
        },
    ] {
        assert!(boot(dir.path(), &source).is_err());
    }
    assert!(EmbeddedCustodyRuntime::boot_with_attestation_source(
        config(dir.path()),
        BootGuard::required(Some(&"32".repeat(48))).unwrap(),
        &Synthetic::default()
    )
    .is_err());
    assert!(BootGuard::required(Some("invalid")).is_err());
    drop(boot(dir.path(), &Synthetic::default()).unwrap());
}
#[test]
fn invalid_configuration_is_rejected_before_attestation_or_directory_creation() {
    let root = tempfile::tempdir().unwrap();
    let dir = root.path().join("uncreated");
    let source = Synthetic::default();
    for which in 0..7 {
        let mut c = config(&dir);
        match which {
            0 => c.expected_network = Network::Mainnet,
            1 => c.expected_network = Network::Private,
            2 => c.workload_audience = "https://custody.test.example/path".into(),
            3 => c.max_body_bytes = 0,
            4 => c.max_in_flight_requests = 0,
            5 => c.max_in_flight_requests = usize::MAX,
            _ => c.max_body_bytes = usize::MAX,
        }
        assert!(EmbeddedCustodyRuntime::boot_with_attestation_source(
            c,
            BootGuard::required(None).unwrap(),
            &source
        )
        .is_err());
    }
    assert!(!dir.exists());
    assert!(source.nonces.lock().unwrap().is_empty());
}
#[test]
fn plaintext_file_and_environment_never_enable_boot_or_fallback() {
    let dir = tempfile::tempdir().unwrap();
    let source = Synthetic::default();
    std::fs::write(dir.path().join("signer-master.key"), "synthetic-not-a-key").unwrap();
    assert!(boot(dir.path(), &source).is_err());
    std::fs::remove_file(dir.path().join("signer-master.key")).unwrap();
    let status = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "plaintext_environment_child", "--nocapture"])
        .env("SIGNER_SERVICE_MASTER_KEY", "synthetic-not-a-key")
        .env("EMBEDDED_BOOT_ENV_CHILD", "1")
        .status()
        .unwrap();
    assert!(status.success());
    assert!(source.nonces.lock().unwrap().is_empty());
    drop(boot(dir.path(), &source).unwrap());
}

#[test]
fn plaintext_environment_child() {
    if std::env::var_os("EMBEDDED_BOOT_ENV_CHILD").is_none() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let source = Synthetic::default();
    assert!(boot(dir.path(), &source).is_err());
    assert!(source.nonces.lock().unwrap().is_empty());
}

struct WaitingBody(Arc<tokio::sync::Notify>);
impl http_body::Body for WaitingBody {
    type Data = axum::body::Bytes;
    type Error = std::convert::Infallible;
    fn poll_frame(
        self: std::pin::Pin<&mut Self>,
        _: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Result<http_body::Frame<Self::Data>, Self::Error>>> {
        self.0.notify_one();
        std::task::Poll::Pending
    }
}

#[tokio::test]
async fn embedded_limits_apply_before_body_and_health_survives_saturation() {
    let dir = tempfile::tempdir().unwrap();
    let mut c = config(dir.path());
    c.max_in_flight_requests = 1;
    c.max_body_bytes = 16;
    let runtime = EmbeddedCustodyRuntime::boot_with_attestation_source(
        c,
        BootGuard::required(None).unwrap(),
        &Synthetic::default(),
    )
    .unwrap();
    let router = runtime.router();
    let oversized = router
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/provision")
                .header("content-type", "application/json")
                .header("content-length", "17")
                .body(Body::from(" ".repeat(17)))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(oversized.status(), 413);
    let polled = Arc::new(tokio::sync::Notify::new());
    let pending_router = router.clone();
    let body = WaitingBody(polled.clone());
    let pending = tokio::spawn(async move {
        pending_router
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/provision")
                    .header("content-type", "application/json")
                    .body(Body::new(body))
                    .unwrap(),
            )
            .await
    });
    tokio::time::timeout(std::time::Duration::from_secs(5), polled.notified())
        .await
        .unwrap();
    let response = router
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/provision")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), 503);
    let body = to_bytes(response.into_body(), 4096).await.unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&body).unwrap()["code"],
        "signer-service-busy"
    );
    let health = router
        .clone()
        .oneshot(
            Request::builder()
                .uri("/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(health.status(), 200);
    pending.abort();
    let _ = pending.await;
    drop(runtime);
    drop(router);
    drop(boot(dir.path(), &Synthetic::default()).unwrap());
}

#[test]
fn runtime_and_existing_bridge_clones_keep_the_same_exclusive_lease() {
    let dir = tempfile::tempdir().unwrap();
    let source = Synthetic::default();
    let runtime = boot(dir.path(), &source).unwrap();
    let cloned = runtime.clone();
    let bridge = runtime.signclient_bridge("synthetic-key-id", "synthetic-caller-token");
    drop(runtime);
    assert!(boot(dir.path(), &source).is_err());
    drop(cloned);
    assert!(boot(dir.path(), &source).is_err());
    drop(bridge);
    drop(boot(dir.path(), &source).unwrap());
}

#[test]
fn two_network_runtimes_have_independent_immutable_contexts_and_directories() {
    let root = tempfile::tempdir().unwrap();
    let source = Synthetic::default();
    let test = boot(&root.path().join("testnet"), &source).unwrap();
    let mut main_config = config(&root.path().join("mainnet"));
    let mut profile = main_config.profile.document().clone();
    profile.environment = "mainnet".into();
    profile.networks[0].chain_id = 860_833_102;
    profile.networks[1].chain_id = 47_763;
    main_config.profile = Arc::new(profile.validate().unwrap());
    main_config.expected_network = Network::Mainnet;
    main_config.workload_audience = "https://custody.main.example".into();
    let main = EmbeddedCustodyRuntime::boot_with_attestation_source(
        main_config,
        BootGuard::required(None).unwrap(),
        &source,
    )
    .unwrap();
    assert_eq!(test.expected_network(), Network::Testnet);
    assert_eq!(main.expected_network(), Network::Mainnet);
    let nonces = source.nonces.lock().unwrap();
    assert_ne!(nonces[0], nonces[1]);
}
