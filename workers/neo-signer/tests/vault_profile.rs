use neo_signer::{
    network::ChainFamily,
    snapshot::{SnapshotCipher, SnapshotPosition},
    vault::MasterKey,
    vault_profile::{
        root_key_commitment, CoordinatorProfile, ReceiptVerifierKey, VaultNetwork, VaultProfile,
        PROFILE_VERSION, SIGNER_SCHEMA_VERSION, SNAPSHOT_FORMAT_VERSION,
    },
};
use p256::{elliptic_curve::sec1::ToSec1Point, SecretKey};

type ProfileMutation = Box<dyn Fn(&mut VaultProfile)>;

#[test]
fn profile_build_cli_validates_exact_public_input_without_opening_the_vault() {
    use sha2::{Digest, Sha256};
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("public-profile.json");
    let data_dir = directory.path().join("must-not-create");
    let document = profile(&MasterKey::from_bytes([9; 32]));
    let expected = document.clone().validate().unwrap();
    let bytes = serde_json::to_vec(&document).unwrap();
    std::fs::write(&path, &bytes).unwrap();
    let execute = |network: &str| {
        std::process::Command::new(env!("CARGO_BIN_EXE_signer_service"))
            .arg("validate-vault-profile")
            .arg(&path)
            .arg(network)
            .env("SIGNER_SERVICE_ATTESTED_BOOT", "require")
            .env("SIGNER_SERVICE_DATA_DIR", &data_dir)
            .output()
            .unwrap()
    };
    let output = execute("testnet");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let identity: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(identity["file_sha256"], hex::encode(Sha256::digest(&bytes)));
    assert_eq!(
        identity["profile_sha256"],
        hex::encode(expected.profile_hash())
    );
    assert_eq!(
        identity["network_set_sha256"],
        hex::encode(expected.network_set_hash())
    );
    assert!(!data_dir.exists());
    assert!(!execute("mainnet").status.success());
    let destinations = identity["required_egress"].as_array().unwrap();
    assert_eq!(destinations.len(), 4);
    assert!(destinations.iter().all(|entry| entry["port"] == 443));
    assert!(destinations
        .iter()
        .any(|entry| entry["address"] == "kms.ap-southeast-1.amazonaws.com"));
    assert!(destinations
        .iter()
        .any(|entry| entry["address"] == "s3.ap-southeast-1.amazonaws.com"));
    let mut invalid = serde_json::to_value(&document).unwrap();
    invalid["private_key"] = "must-not-ship".into();
    std::fs::write(&path, serde_json::to_vec(&invalid).unwrap()).unwrap();
    let refused = execute("testnet");
    assert!(!refused.status.success());
    assert!(refused.stdout.is_empty());
    std::fs::write(&path, vec![b' '; 65_537]).unwrap();
    assert!(!execute("testnet").status.success());
    assert!(!data_dir.exists());
}

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

#[test]
fn validates_and_hashes_an_immutable_public_profile() {
    let master = MasterKey::from_bytes([9; 32]);
    let document = profile(&master);
    let encoded = serde_json::to_vec(&document).unwrap();
    let first = VaultProfile::from_json(&encoded).unwrap();
    let second = document.validate().unwrap();

    assert_eq!(first.profile_hash(), second.profile_hash());
    assert_eq!(first.network_set_hash(), second.network_set_hash());
    assert_ne!(first.profile_hash(), first.network_set_hash());
    assert_eq!(
        first.vault_id(),
        &hex::decode("00112233445566778899aabbccddeeff")
            .unwrap()
            .as_slice()
    );
    assert!(first.permits(ChainFamily::NeoN3, 894_710_606));
    assert!(first.permits(ChainFamily::NeoX, 12_227_332));
    assert!(!first.permits(ChainFamily::NeoX, 47_763));
    first.verify_master(&master).unwrap();
    assert!(first
        .verify_master(&MasterKey::from_bytes([8; 32]))
        .is_err());
}

#[test]
fn rejects_noncanonical_or_substituted_identity_fields() {
    let master = MasterKey::from_bytes([9; 32]);
    let baseline = profile(&master);
    let mut mutations: Vec<ProfileMutation> = vec![
        Box::new(|value| value.profile_version += 1),
        Box::new(|value| value.vault_id = "00".repeat(16)),
        Box::new(|value| value.vault_id.make_ascii_uppercase()),
        Box::new(|value| value.environment = "mainnet".to_string()),
        Box::new(|value| value.networks.reverse()),
        Box::new(|value| value.networks[0].chain_id += 1),
        Box::new(|value| {
            value.networks[0].genesis_hash.remove(0);
        }),
        Box::new(|value| {
            value.custody_kms_key_arn = value
                .custody_kms_key_arn
                .replace("ap-southeast-1", "us-east-1")
        }),
        Box::new(|value| {
            value.custody_kms_key_arn =
                "arn:aws:kms:ap-southeast-1:736326664265:alias/testnet".to_string()
        }),
        Box::new(|value| value.coordinator.origin = "http://custody-state.test/".to_string()),
        Box::new(|value| value.coordinator.origin = "https://custody-state.test/path".to_string()),
        Box::new(|value| value.coordinator.snapshot_prefix = "../vault".to_string()),
        Box::new(|value| {
            value
                .coordinator
                .receipt_keys
                .push(value.coordinator.receipt_keys[0].clone())
        }),
        Box::new(|value| {
            value.coordinator.receipt_keys[0].public_key_sec1_hex =
                "04".to_string() + &"00".repeat(64)
        }),
    ];

    for mutate in mutations.drain(..) {
        let mut candidate = baseline.clone();
        mutate(&mut candidate);
        assert!(candidate.validate().is_err());
    }
}

#[test]
fn unknown_json_fields_and_changed_profile_fields_are_not_ignored() {
    let master = MasterKey::from_bytes([9; 32]);
    let original = profile(&master).validate().unwrap();
    let mut changed_document = profile(&master);
    changed_document.release_policy_version = "testnet-r7".to_string();
    let changed = changed_document.validate().unwrap();
    assert_ne!(original.profile_hash(), changed.profile_hash());

    let mut json = serde_json::to_value(profile(&master)).unwrap();
    json.as_object_mut()
        .unwrap()
        .insert("runtime_override".to_string(), serde_json::json!(true));
    assert!(VaultProfile::from_json(&serde_json::to_vec(&json).unwrap()).is_err());
}

#[test]
fn profile_bound_snapshots_reject_other_profiles_and_roots() {
    let master = MasterKey::from_bytes([9; 32]);
    let first_profile = profile(&master).validate().unwrap();
    let first = SnapshotCipher::from_profile(&master, &first_profile).unwrap();
    let position = SnapshotPosition {
        generation: 1,
        fence: 7,
        previous_digest: [0; 32],
    };
    let (envelope, head) = first.seal(b"bound state", position).unwrap();
    assert_eq!(
        first.open(&envelope, &head).unwrap().as_slice(),
        b"bound state"
    );

    let mut other_document = profile(&master);
    other_document.release_policy_version = "testnet-r7".to_string();
    let other_profile = other_document.validate().unwrap();
    let other = SnapshotCipher::from_profile(&master, &other_profile).unwrap();
    assert!(other.open(&envelope, &head).is_err());
    assert!(SnapshotCipher::from_profile(&MasterKey::from_bytes([8; 32]), &first_profile).is_err());
}

#[test]
fn profile_build_cli_admits_only_the_explicit_matching_network() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("public-profile.json");
    let data_dir = directory.path().join("must-not-create");
    for (network, n3, neox) in [
        ("testnet", 894_710_606, 12_227_332),
        ("mainnet", 860_833_102, 47_763),
    ] {
        let mut document = profile(&MasterKey::from_bytes([9; 32]));
        document.environment = network.into();
        document.networks[0].chain_id = n3;
        document.networks[1].chain_id = neox;
        let expected = document.clone().validate().unwrap();
        std::fs::write(&path, serde_json::to_vec(&document).unwrap()).unwrap();
        for selector in [
            "testnet", "mainnet", "private", "MainNet", " mainnet", "testnet ", "",
        ] {
            let output = std::process::Command::new(env!("CARGO_BIN_EXE_signer_service"))
                .args(["validate-vault-profile", path.to_str().unwrap(), selector])
                .env_clear()
                .env("SIGNER_SERVICE_ATTESTED_BOOT", "require")
                .env("SIGNER_SERVICE_DATA_DIR", &data_dir)
                .output()
                .unwrap();
            assert_eq!(
                output.status.success(),
                selector == network,
                "network={network} selector={selector:?}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            if selector == network {
                let identity: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
                assert_eq!(identity["environment"], network);
                assert_eq!(
                    identity["profile_sha256"],
                    hex::encode(expected.profile_hash())
                );
                assert_eq!(
                    identity["network_set_sha256"],
                    hex::encode(expected.network_set_hash())
                );
            } else {
                assert!(output.stdout.is_empty());
            }
        }
        assert!(!data_dir.exists());
    }
}
