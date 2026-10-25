use super::*;
use crate::network_profiles::{select_request, PROFILES_ENV};
use neo_signer::vault::MasterKey;
use neo_signer::vault_profile::root_key_commitment;
use p256::elliptic_curve::sec1::ToSec1Point;
use serde_json::{json, Value};

fn fixture(dir: &Path) -> Value {
    let receipt = p256::SecretKey::from_slice(&[7; 32]).unwrap();
    let mut map = serde_json::Map::new();
    for (network, seed, magic) in [
        ("mainnet", 8u8, 860_833_102u64),
        ("testnet", 9, 894_710_606),
    ] {
        let profile = json!({
            "profile_version":1,"vault_id":hex::encode([seed;16]),"environment":network,
            "networks":[{"chain_family":"neo-n3","chain_id":magic,"genesis_hash":format!("0x{}", "11".repeat(32))}],
            "custody_kms_key_arn":"arn:aws:kms:us-east-1:123456789012:key/11111111-2222-3333-4444-555555555555",
            "root_key_version":format!("{network}-r1"),"root_key_commitment":hex::encode(root_key_commitment(&MasterKey::from_bytes([seed;32]))),
            "snapshot_format_version":2,"signer_schema_version":1,
            "coordinator":{"origin":format!("https://authority-{network}.example"),"aws_region":"us-east-1","snapshot_bucket":"synthetic-neoos-bucket","snapshot_prefix":format!("vaults/{network}"),
            "receipt_keys":[{"key_id":"receipt-r1","public_key_sec1_hex":hex::encode(receipt.public_key().to_sec1_point(false).as_bytes())}]},
            "release_policy_version":format!("{network}-r1")
        });
        let bytes = serde_json::to_vec(&profile).unwrap();
        let path = dir.join(format!("{network}.json"));
        std::fs::write(&path, &bytes).unwrap();
        map.insert(network.into(), json!({
            PROFILE_FILE:path.to_str().unwrap(), PROFILE_HASH:hex::encode(Sha256::digest(&bytes)),
            DATA_DIR:dir.join(network).to_str().unwrap(), AUDIENCE:format!("https://custody-{network}.example"),
            "SIGNER_SERVICE_URL":embedded_base_url(network).unwrap(),
        }));
    }
    Value::Object(map)
}

fn profiles(map: &Value) -> NetworkProfiles {
    NetworkProfiles::from_overlay(&EnvOverlay::new([(PROFILES_ENV, map.to_string())])).unwrap()
}

#[test]
fn complete_dual_plan_pins_profile_network_root_and_state() {
    let dir = tempfile::tempdir().unwrap();
    let map = fixture(dir.path());
    let plans = prepare(&profiles(&map)).unwrap();
    assert_eq!(plans.len(), 2);
    assert_eq!(plans["mainnet"].expected_network, Network::Mainnet);
    assert_eq!(plans["testnet"].expected_network, Network::Testnet);
    assert_ne!(
        plans["mainnet"].profile.root_key_commitment(),
        plans["testnet"].profile.root_key_commitment()
    );
    assert!(
        !dir.path().join("mainnet").exists(),
        "planning must not initialize a vault"
    );
}

#[test]
fn equivalent_audiences_refuse_before_any_vault_boot() {
    let dir = tempfile::tempdir().unwrap();
    let original = fixture(dir.path());
    assert_eq!(prepare(&profiles(&original)).unwrap().len(), 2);
    for alias in [
        " https://custody-mainnet.example ",
        "https://custody-mainnet.example/",
        "HTTPS://CUSTODY-MAINNET.EXAMPLE",
        "https://custody-mainnet.example:443",
    ] {
        let mut map = original.clone();
        map["testnet"][AUDIENCE] = json!(alias);
        assert_eq!(
            WorkloadAuthPolicy::new(alias, false).unwrap().audience(),
            original["mainnet"][AUDIENCE].as_str().unwrap()
        );
        let mut started = 0;
        let result = boot_using(&profiles(&map), |_, _| {
            started += 1;
            Err("test callback must not start")
        });
        assert_eq!(started, 0, "audience alias reached vault boot: {alias}");
        assert_eq!(
            result.err(),
            Some("embedded custody networks require distinct vault identities and state")
        );
    }
    let mut distinct = original;
    distinct["testnet"][AUDIENCE] = json!(" HTTPS://CUSTODY-MAINNET.EXAMPLE:8443/ ");
    let plans = prepare(&profiles(&distinct)).unwrap();
    assert_eq!(
        plans["testnet"].workload_audience,
        "https://custody-mainnet.example:8443"
    );
    assert_ne!(
        plans["mainnet"].workload_audience,
        plans["testnet"].workload_audience
    );
}

#[test]
fn single_plan_rejects_foreign_profile_before_any_cross_vault_checks() {
    let dir = tempfile::tempdir().unwrap();
    let mut map = fixture(dir.path());
    map["testnet"][PROFILE_FILE] = map["mainnet"][PROFILE_FILE].clone();
    map["testnet"][PROFILE_HASH] = map["mainnet"][PROFILE_HASH].clone();
    let profiles = profiles(&map);
    assert_eq!(
        plan("testnet", &profiles.overlays["testnet"]).err(),
        Some("embedded custody profile network mismatch")
    );
}

#[test]
fn partial_wrong_digest_foreign_network_and_external_urls_refuse() {
    let dir = tempfile::tempdir().unwrap();
    let original = fixture(dir.path());
    for key in CONFIG_KEYS {
        let mut bad = original.clone();
        bad["testnet"].as_object_mut().unwrap().remove(key);
        assert!(prepare(&profiles(&bad)).is_err(), "missing {key}");
    }
    for (key, value) in [
        (PROFILE_HASH, "00".repeat(32)),
        (
            PROFILE_FILE,
            original["mainnet"][PROFILE_FILE]
                .as_str()
                .unwrap()
                .to_string(),
        ),
        ("SIGNER_SERVICE_URL", embedded_base_url("mainnet").unwrap()),
        ("SIGNER_SERVICE_URL", "http://127.0.0.1:4444".into()),
        (DATA_DIR, "relative-path".into()),
        (DATA_DIR, "/tmp/vault/../other".into()),
        (AUDIENCE, "https://custody-testnet.example/path".into()),
    ] {
        let mut bad = original.clone();
        bad["testnet"][key] = json!(value);
        if key == PROFILE_FILE {
            bad["testnet"][PROFILE_HASH] = original["mainnet"][PROFILE_HASH].clone();
        }
        assert!(prepare(&profiles(&bad)).is_err(), "{key}");
    }
}

#[test]
fn shared_identity_root_audience_and_state_are_not_two_vaults() {
    let dir = tempfile::tempdir().unwrap();
    let original = fixture(dir.path());
    for key in [DATA_DIR, AUDIENCE] {
        let mut bad = original.clone();
        bad["testnet"][key] = original["mainnet"][key].clone();
        assert!(prepare(&profiles(&bad)).is_err(), "shared {key}");
    }
    let main: Value = serde_json::from_slice(
        &std::fs::read(original["mainnet"][PROFILE_FILE].as_str().unwrap()).unwrap(),
    )
    .unwrap();
    let path = original["testnet"][PROFILE_FILE].as_str().unwrap();
    let bytes = std::fs::read(path).unwrap();
    for key in ["vault_id", "root_key_commitment"] {
        let mut profile: Value = serde_json::from_slice(&bytes).unwrap();
        profile[key] = main[key].clone();
        let changed = serde_json::to_vec(&profile).unwrap();
        std::fs::write(path, &changed).unwrap();
        let mut bad = original.clone();
        bad["testnet"][PROFILE_HASH] = json!(hex::encode(Sha256::digest(&changed)));
        assert!(prepare(&profiles(&bad)).is_err(), "shared {key}");
    }
}

#[test]
fn failed_attestation_does_not_return_an_unsealed_or_fallback_router() {
    let dir = tempfile::tempdir().unwrap();
    let map = fixture(dir.path());
    // This developer machine has no NSM. Production boot must not accept that
    // or instantiate the ordinary non-attested SignerService constructor.
    #[cfg(not(target_os = "linux"))]
    assert_eq!(
        boot(&profiles(&map)).err(),
        Some("embedded custody measured boot failed")
    );
    #[cfg(target_os = "linux")]
    assert_eq!(prepare(&profiles(&map)).unwrap().len(), 2);
}

#[test]
fn native_namespace_uses_the_same_strict_network_selection() {
    for path in [
        "/custody/provision",
        "/custody/attestation",
        "/custody/health",
        "/custody/signer/api/v1/keys",
    ] {
        let request = format!("/mainnet{path}");
        assert_eq!(
            select_request("POST", &request, &http::HeaderMap::new(), "{}")
                .unwrap()
                .network,
            "mainnet"
        );
        let mut headers = http::HeaderMap::new();
        headers.insert("x-morpheus-network", "testnet".parse().unwrap());
        assert!(select_request("POST", &request, &headers, "{}").is_err());
        assert!(select_request(
            "POST",
            &format!("{request}?network=testnet"),
            &http::HeaderMap::new(),
            "{}"
        )
        .is_err());
    }
    for path in [
        "/mainnet/custody/../provision",
        "/mainnet/custody/%70rovision",
        "/mainnet/custody//provision",
        "/mainnet/custodyevil/provision",
    ] {
        assert!(
            select_request("POST", path, &http::HeaderMap::new(), "{}").is_err(),
            "{path}"
        );
    }
}

struct SyntheticAttestation(bool);
impl nitro_attest::release::AttestationSource for SyntheticAttestation {
    fn attest(
        &self,
        nonce: Option<&[u8]>,
        _: Option<&[u8]>,
        _: Option<&[u8]>,
    ) -> Result<Vec<u8>, String> {
        let mut payload = vec![0xa2, 0x64, b'p', b'c', b'r', b's', 0xa1, 0x00, 0x58, 48];
        payload.extend_from_slice(&[if self.0 { 0x31 } else { 0 }; 48]);
        payload.extend_from_slice(&[0x65, b'n', b'o', b'n', b'c', b'e', 0x50]);
        payload.extend_from_slice(nonce.expect("boot must request fresh nonce"));
        let mut cose = vec![0xd2, 0x84, 0x40, 0xa0, 0x58, payload.len() as u8];
        cose.extend(payload);
        cose.extend([0x40]);
        Ok(cose)
    }
}

#[tokio::test]
async fn two_sealed_native_routers_retain_their_distinct_leases() {
    use axum::{
        body::{to_bytes, Body},
        http::Request,
    };
    use neo_signer::embedded::VaultProcessLease;
    use tower::ServiceExt;
    let dir = tempfile::tempdir().unwrap();
    let map = fixture(dir.path());
    let mut routers = boot_using(&profiles(&map), |config, guard| {
        EmbeddedCustodyRuntime::boot_with_attestation_source(
            config,
            guard,
            &SyntheticAttestation(true),
        )
        .map_err(|_| "test boot failed")
    })
    .unwrap();
    assert_eq!(routers.len(), 2);
    for network in ["mainnet", "testnet"] {
        assert!(VaultProcessLease::acquire(&dir.path().join(network)).is_err());
        let router = routers.get(network).unwrap();
        let response = router
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/health")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let body: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap()).unwrap();
        assert_eq!(body["status"], "unprovisioned");
        assert!(!dir.path().join(network).join("signer.db").exists());
    }
    drop(routers.remove("mainnet"));
    assert!(VaultProcessLease::acquire(&dir.path().join("mainnet")).is_ok());
    assert!(VaultProcessLease::acquire(&dir.path().join("testnet")).is_err());
    drop(routers);
    assert!(VaultProcessLease::acquire(&dir.path().join("testnet")).is_ok());
}

#[test]
fn a_failed_second_attestation_rolls_back_boot_without_any_router() {
    use neo_signer::embedded::VaultProcessLease;
    let dir = tempfile::tempdir().unwrap();
    let map = fixture(dir.path());
    let mut calls = 0;
    let result = boot_using(&profiles(&map), |config, guard| {
        calls += 1;
        EmbeddedCustodyRuntime::boot_with_attestation_source(
            config,
            guard,
            &SyntheticAttestation(calls == 1),
        )
        .map_err(|_| "attestation refused")
    });
    assert!(result.is_err());
    assert_eq!(calls, 2);
    for network in ["mainnet", "testnet"] {
        assert!(VaultProcessLease::acquire(&dir.path().join(network)).is_ok());
        assert!(!dir.path().join(network).join("signer.db").exists());
    }
}

fn enrollment_fixture(dir: &Path, map: &mut Value) -> (Value, std::path::PathBuf) {
    let profile_file = std::path::PathBuf::from(map["testnet"][PROFILE_FILE].as_str().unwrap());
    let mut document: Value =
        serde_json::from_slice(&std::fs::read(&profile_file).unwrap()).unwrap();
    let mut manifest = json!({
        "schema":"neoos/first-admin-enrollment/v1", "purpose":neo_signer::enrollment::ENROLLMENT_MODE,
        "ceremony_id":"test-ceremony", "caller":{
            "id":"first-admin", "label":"Test operator", "created_at_unix":1780000000,
            "token_digest":"12".repeat(32), "auth_mode":"bearer", "capabilities":["admin"],
            "key_grant":"any", "allowed_origins":[], "disabled":false
        }
    });
    for key in [
        "environment",
        "vault_id",
        "networks",
        "custody_kms_key_arn",
        "root_key_version",
        "root_key_commitment",
        "coordinator",
    ] {
        manifest[key] = document[key].clone();
    }
    let bytes = serde_json::to_vec(&manifest).unwrap();
    let digest = hex::encode(Sha256::digest(&bytes));
    let path = dir.join("testnet-enrollment.json");
    std::fs::write(&path, bytes).unwrap();
    document["release_policy_version"] = json!(digest);
    let bytes = serde_json::to_vec(&document).unwrap();
    std::fs::write(profile_file, &bytes).unwrap();
    map["testnet"][PROFILE_HASH] = json!(hex::encode(Sha256::digest(&bytes)));
    map["testnet"][ENROLLMENT_MODE] = json!(neo_signer::enrollment::ENROLLMENT_MODE);
    map["testnet"][ENROLLMENT_FILE] = json!(path.to_str().unwrap());
    map["testnet"][ENROLLMENT_HASH] = json!(digest);
    (manifest, path)
}

#[test]
fn measured_enrollment_requires_all_bindings_and_keeps_mainnet_unchanged() {
    let dir = tempfile::tempdir().unwrap();
    let mut map = fixture(dir.path());
    let prior = prepare(&profiles(&map)).unwrap()["mainnet"]
        .profile
        .profile_hash()
        .to_owned();
    let (mut manifest, path) = enrollment_fixture(dir.path(), &mut map);
    let plans = prepare(&profiles(&map)).unwrap();
    assert!(plans["testnet"].enrollment.is_some());
    assert!(plans["mainnet"].enrollment.is_none());
    assert_eq!(*plans["mainnet"].profile.profile_hash(), prior);
    assert!(!dir.path().join("testnet").exists());
    for key in ENROLLMENT_KEYS {
        let mut missing = map.clone();
        missing["testnet"].as_object_mut().unwrap().remove(key);
        assert!(prepare(&profiles(&missing)).is_err(), "missing {key}");
        assert!(
            !crate::overlay::is_provisionable_name(key),
            "runtime requests must not change measured enrollment"
        );
    }
    let mut disabled = map.clone();
    for key in ENROLLMENT_KEYS {
        disabled["testnet"].as_object_mut().unwrap().remove(key);
    }
    assert!(
        prepare(&profiles(&disabled)).unwrap()["testnet"]
            .enrollment
            .is_none(),
        "digest alone is not opt-in"
    );
    let mut mainnet = map.clone();
    for key in ENROLLMENT_KEYS {
        mainnet["mainnet"][key] = map["testnet"][key].clone();
    }
    assert!(prepare(&profiles(&mainnet)).is_err());
    // Replace both bytes and advertised digest: the measured profile still pins
    // the old manifest. A self-consistent pair is not authority to enroll.
    manifest["caller"]["id"] = json!("substituted-admin");
    let bytes = serde_json::to_vec(&manifest).unwrap();
    std::fs::write(path, &bytes).unwrap();
    map["testnet"][ENROLLMENT_HASH] = json!(hex::encode(Sha256::digest(&bytes)));
    assert!(prepare(&profiles(&map)).is_err());
}
