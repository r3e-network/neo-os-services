//! Public-network protocol tests use only the existing synthetic profile/key fixtures.
use super::*;
use crate::network::{neox_chain_id, network_magic, Network};

pub(super) fn profile(network: Network) -> ValidatedVaultProfile {
    let mut document = crate::vault_profile::test_profile([0x5a; 32])
        .document()
        .clone();
    document.environment = network.to_string();
    for chain in &mut document.networks {
        chain.chain_id = match chain.chain_family.as_str() {
            "neo-n3" => u64::from(network_magic(network)),
            "neox" => neox_chain_id(network),
            _ => unreachable!(),
        };
    }
    document.validate().unwrap()
}

fn binding(network: Network) -> VaultBinding {
    SnapshotCipher::from_profile(&MasterKey::from_bytes([0x5a; 32]), &profile(network))
        .unwrap()
        .binding()
        .clone()
}

fn challenge(binding: &VaultBinding, network: &str) -> ChallengeResponse {
    ChallengeResponse {
        challenge_id: "challenge-1".into(),
        schema: WIRE_SCHEMA.into(),
        network: network.into(),
        vault_id: hex::encode(binding.vault_id),
        profile_id: hex::encode(binding.profile_hash),
        network_id: hex::encode(binding.network_set_hash),
        root_commitment: hex::encode(binding.root_key_commitment),
        expires_at: "2099-01-01T00:00:00Z".into(),
        attestation: ChallengeAttestation {
            nonce_hex: "11".repeat(32),
            user_data_hex: "22".repeat(32),
            expected_pcrs: ExpectedPcrs {
                pcr0: "33".repeat(48),
                pcr1: "44".repeat(48),
                pcr2: "55".repeat(48),
            },
        },
        request_id: None,
    }
}

fn session(binding: &VaultBinding, network: &str) -> SessionResponse {
    SessionResponse {
        sealed_session_token: SealedSessionToken {
            algorithm: "RSA-OAEP-256".into(),
            key_sha256: hex::encode([0x66; 32]),
            ciphertext_base64: BASE64.encode([1]),
        },
        request_header: SESSION_HEADER.into(),
        schema: WIRE_SCHEMA.into(),
        network: network.into(),
        vault_id: hex::encode(binding.vault_id),
        profile_id: hex::encode(binding.profile_hash),
        network_id: hex::encode(binding.network_set_hash),
        root_commitment: hex::encode(binding.root_key_commitment),
        owner_id: "owner".into(),
        request_proof: RequestProofParameters {
            schema: REQUEST_PROOF_SCHEMA.into(),
            algorithm: REQUEST_PROOF_ALGORITHM.into(),
            timestamp_header: REQUEST_PROOF_TIMESTAMP_HEADER.into(),
            nonce_header: REQUEST_PROOF_NONCE_HEADER.into(),
            signature_header: REQUEST_PROOF_SIGNATURE_HEADER.into(),
            max_clock_skew_seconds: 30,
        },
        expires_at: "2099-01-01T00:00:00Z".into(),
        request_id: None,
    }
}

fn head(binding: &VaultBinding, network: &str) -> WireHead {
    let mut wire = WireHead {
        schema: WIRE_SCHEMA.into(),
        network: network.into(),
        vault_id: hex::encode(binding.vault_id),
        profile_id: hex::encode(binding.profile_hash),
        network_id: hex::encode(binding.network_set_hash),
        root_commitment: hex::encode(binding.root_key_commitment),
        owner_id: "owner".into(),
        epoch: "1".into(),
        snapshot_fence: "0".into(),
        generation: "0".into(),
        previous_snapshot_sha256: "00".repeat(32),
        snapshot_sha256: "00".repeat(32),
        head_fingerprint: String::new(),
        lease_expires_at_ms: "4070908800000".into(),
        lease_expires_at: "2099-01-01T00:00:00Z".into(),
        commit_id: None,
        snapshot: None,
        updated_at: "2026-10-16T00:00:00Z".into(),
        request_id: None,
    };
    wire.head_fingerprint = hex::encode(head_fingerprint(&wire).unwrap());
    wire
}

// Decoder tests exercise wire validation only; cryptographic receipt validation
// and the commit-before-release barrier are covered in tests/durable_state.rs.
fn wire_receipt(network: &str) -> WireReceipt {
    let vector: serde_json::Value = serde_json::from_str(VECTOR_JSON).unwrap();
    let mut wire = vector["receipt"].clone();
    wire["network"] = network.into();
    wire["receipt_id"] = "11".repeat(32).into();
    wire["payload_base64"] = BASE64.encode([1]).into();
    wire["signature_base64"] = BASE64.encode([1]).into();
    wire["kms_key_arn"] = "fixture-receipt-key".into();
    wire["signing_algorithm"] = "ECDSA_SHA_256".into();
    serde_json::from_value(wire).unwrap()
}

fn commit_response(
    binding: &VaultBinding,
    head_network: &str,
    receipt_network: &str,
) -> CommitResponse {
    CommitResponse {
        idempotent: false,
        head: head(binding, head_network),
        receipt: wire_receipt(receipt_network),
        request_id: None,
    }
}

#[test]
fn coordinator_accepts_both_networks_and_single_chain_profiles() {
    for network in [Network::Mainnet, Network::Testnet] {
        let profile = profile(network);
        let binding = binding(network);
        validate_profile_binding(&profile, &binding).unwrap();
        let name = network.to_string();
        challenge(&binding, &name).validate(&binding).unwrap();
        session(&binding, &name)
            .validate(&binding, "owner", &[0x66; 32])
            .unwrap();
        AuthorityHead::from_wire(head(&binding, &name), &binding).unwrap();
        let result = commit_response(&binding, &name, &name)
            .into_result(&binding)
            .unwrap();
        assert_eq!(result.receipt.network, name);
        for family in ["neo-n3", "neox"] {
            let mut document = profile.document().clone();
            document
                .networks
                .retain(|chain| chain.chain_family == family);
            let profile = document.validate().unwrap();
            let cipher =
                SnapshotCipher::from_profile(&MasterKey::from_bytes([0x5a; 32]), &profile).unwrap();
            validate_profile_binding(&profile, cipher.binding()).unwrap();
        }
    }
}

#[test]
fn coordinator_rejects_cross_network_and_noncanonical_response_labels() {
    for network in [Network::Mainnet, Network::Testnet] {
        let binding = binding(network);
        let name = network.to_string();
        for label in [
            "mainnet", "testnet", "private", "Mainnet", "TestNet", "", "testnet ",
        ] {
            if label == name {
                continue;
            }
            assert!(
                challenge(&binding, label).validate(&binding).is_err(),
                "challenge {name}/{label}"
            );
            assert!(
                session(&binding, label)
                    .validate(&binding, "owner", &[0x66; 32])
                    .is_err(),
                "session {name}/{label}"
            );
            assert!(
                AuthorityHead::from_wire(head(&binding, label), &binding).is_err(),
                "HEAD {name}/{label}"
            );
            assert!(
                commit_response(&binding, &name, label)
                    .into_result(&binding)
                    .is_err(),
                "receipt {name}/{label}"
            );
        }
    }
}

#[test]
fn coordinator_rejects_mixed_unknown_and_profile_mismatched_bindings() {
    for network in [Network::Mainnet, Network::Testnet] {
        let profile = profile(network);
        let good = binding(network);
        for other in [Network::Mainnet, Network::Testnet, Network::Private] {
            if other == network {
                continue;
            }
            for (n3, neox) in [
                (network_magic(other), good.neox_chain_id),
                (good.neo_n3_magic, neox_chain_id(other)),
                (network_magic(other), neox_chain_id(other)),
                (0, 0),
            ] {
                let mut bad = good.clone();
                bad.neo_n3_magic = n3;
                bad.neox_chain_id = neox;
                assert!(validate_profile_binding(&profile, &bad).is_err());
            }
        }
        // Alter only a scope hash; a matching label must never override it.
        for field in 0..4 {
            let mut other = good.clone();
            match field {
                0 => other.vault_id[0] ^= 1,
                1 => other.profile_hash[0] ^= 1,
                2 => other.network_set_hash[0] ^= 1,
                _ => other.root_key_commitment[0] ^= 1,
            }
            let name = network.to_string();
            assert!(challenge(&other, &name).validate(&good).is_err());
            assert!(session(&other, &name)
                .validate(&good, "owner", &[0x66; 32])
                .is_err());
            assert!(AuthorityHead::from_wire(head(&other, &name), &good).is_err());
        }
    }
}

#[test]
fn operation_network_comes_from_the_candidate_and_preserves_testnet_bytes() {
    let vector: ProtocolVector = serde_json::from_str(VECTOR_JSON).unwrap();
    let candidate = vector_candidate(&vector);
    let receipt = receipt(&vector.receipt);
    let legacy = hex::decode(&vector.operation_canonical_hex).unwrap();
    assert_eq!(canonical_operation(&candidate, &receipt).unwrap(), legacy);

    let mut main = candidate.clone();
    main.next.binding.neo_n3_magic = network_magic(Network::Mainnet);
    main.next.binding.neox_chain_id = neox_chain_id(Network::Mainnet);
    main.previous.binding = main.next.binding.clone();
    let mut main_receipt = receipt.clone();
    main_receipt.network = "mainnet".into();
    let mut expected = legacy.clone();
    let offset = b"neoos/custody-state-operation/v2\0".len() + 4;
    assert_eq!(&expected[offset..offset + 7], b"testnet");
    expected[offset..offset + 7].copy_from_slice(b"mainnet");
    assert_eq!(canonical_operation(&main, &main_receipt).unwrap(), expected);
    assert_ne!(Sha256::digest(&expected), Sha256::digest(&legacy));
    assert!(canonical_operation(&main, &receipt).is_err());
    assert!(canonical_operation(&candidate, &main_receipt).is_err());
    main.previous.binding = candidate.previous.binding.clone();
    assert!(canonical_operation(&main, &main_receipt).is_err());

    for (n3, neox) in [
        (0, 0),
        (
            network_magic(Network::Testnet),
            neox_chain_id(Network::Mainnet),
        ),
        (
            network_magic(Network::Private),
            neox_chain_id(Network::Private),
        ),
    ] {
        let mut bad = candidate.clone();
        bad.next.binding.neo_n3_magic = n3;
        bad.next.binding.neox_chain_id = neox;
        bad.previous.binding = bad.next.binding.clone();
        assert!(canonical_operation(&bad, &receipt).is_err());
    }
}

#[test]
fn crossed_candidates_and_heads_are_rejected_before_using_a_session() {
    let vector: ProtocolVector = serde_json::from_str(VECTOR_JSON).unwrap();
    for network in [Network::Mainnet, Network::Testnet] {
        let local_binding = binding(network);
        let other = match network {
            Network::Mainnet => Network::Testnet,
            Network::Testnet => Network::Mainnet,
            Network::Private => unreachable!(),
        };
        let transport = Arc::new(QueueTransport::new(Vec::new()));
        let client = CoordinatorClient {
            profile: Arc::new(profile(network)),
            binding: local_binding.clone(),
            credentials: AwsCredentials {
                access_key_id: "AKID".into(),
                secret_access_key: "secret".into(),
                session_token: None,
            },
            transport: transport.clone(),
            owner_id: "owner".into(),
            session_key: SessionTransportKey::generate().unwrap(),
            attestation: Arc::new(nitro_attest::release::NsmAttestation),
            session: Mutex::new(SessionCredential {
                token: Zeroizing::new("a".repeat(43)),
                expires_at_ms: u64::MAX,
            }),
        };
        let mut candidate = vector_candidate(&vector);
        candidate.previous.binding = binding(other);
        candidate.next.binding = candidate.previous.binding.clone();
        assert!(client.takeover(Some(&candidate.previous)).is_err());
        assert!(client.renew(&candidate.previous).is_err());
        assert!(client.download_snapshot(&candidate.previous).is_err());
        assert!(client.commit(&candidate).is_err());
        candidate.previous.binding = local_binding.clone();
        assert!(client.commit(&candidate).is_err());
        candidate.previous.binding = candidate.next.binding.clone();
        candidate.next.binding = local_binding;
        assert!(client.commit(&candidate).is_err());
        assert!(transport.requests.lock().unwrap().is_empty());
    }
}
