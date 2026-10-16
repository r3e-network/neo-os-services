use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

use anyhow::{bail, Result};
use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use neo_signer::{
    api::{router, ApiState},
    auth::CallerCredentials,
    durable::{
        canonical_operation, canonical_receipt, operation_digest, AuthorityHead, AuthoritySnapshot,
        CommitCandidate, CommitReceipt, CommitResult, DurableCoordinator, DurableState,
        DurableStatus,
    },
    model::{CallerCapability, KeyGrant, SignerAuditAction, SignerPolicy},
    network::Network,
    service::{provision_admin_caller, Outcome, SignerService},
    signclient::{
        proto::{
            servicepb::{secure_sign_server::SecureSign, SignExtensiblePayloadRequest},
            signpb::ExtensiblePayload,
        },
        SignClientBridge,
    },
    snapshot::SnapshotCipher,
    store::Store,
    vault::MasterKey,
    vault_profile::{
        root_key_commitment, CoordinatorProfile, ReceiptVerifierKey, VaultNetwork, VaultProfile,
        PROFILE_VERSION, SIGNER_SCHEMA_VERSION, SNAPSHOT_FORMAT_VERSION,
    },
};
use p256::ecdsa::{signature::Signer, Signature, SigningKey};
use sha2::Digest as _;
use tonic::Request as GrpcRequest;
use tower::ServiceExt;

#[derive(Clone, Copy)]
enum Behavior {
    Valid,
    Fail,
    WrongGeneration,
    WrongNetwork,
    WrongHeadNetwork,
}

struct Coordinator {
    signing_key: SigningKey,
    network: Network,
    behavior: Mutex<Behavior>,
    candidates: Mutex<Vec<CommitCandidate>>,
}

impl Coordinator {
    fn new(signing_key: SigningKey, network: Network) -> Self {
        Self {
            signing_key,
            network,
            behavior: Mutex::new(Behavior::Valid),
            candidates: Mutex::new(Vec::new()),
        }
    }

    fn behavior(&self, behavior: Behavior) {
        *self.behavior.lock().unwrap() = behavior;
    }
}

impl DurableCoordinator for Coordinator {
    fn commit(&self, candidate: &CommitCandidate) -> Result<CommitResult> {
        self.candidates.lock().unwrap().push(candidate.clone());
        match *self.behavior.lock().unwrap() {
            Behavior::Fail => bail!("simulated ambiguous coordinator failure"),
            Behavior::Valid
            | Behavior::WrongGeneration
            | Behavior::WrongNetwork
            | Behavior::WrongHeadNetwork => {}
        }
        let mut receipt = CommitReceipt {
            network: self.network.to_string(),
            vault_id: candidate.next.binding.vault_id,
            profile_hash: candidate.next.binding.profile_hash,
            network_set_hash: candidate.next.binding.network_set_hash,
            root_key_commitment: candidate.next.binding.root_key_commitment,
            commit_id: candidate.commit_id.clone(),
            operation_digest: [0; 32],
            mutation_digest: candidate.mutation_digest,
            previous_generation: candidate.previous.generation,
            previous_snapshot_fence: candidate.previous.snapshot_fence,
            previous_snapshot_sha256: candidate.previous.snapshot_sha256,
            generation: candidate.next.position.generation,
            snapshot_sha256: candidate.next.digest,
            epoch: candidate.previous.epoch,
            snapshot_fence: candidate.next.position.fence,
            owner_id: candidate.previous.owner_id.clone(),
            snapshot_bucket: "test-snapshot-bucket".to_string(),
            snapshot_key: format!("snapshots/{}.bin", candidate.commit_id),
            snapshot_version_id: format!("version-{}", candidate.next.position.generation),
            snapshot_size_bytes: candidate.envelope.len(),
            lease_expires_at_ms: u64::MAX,
            committed_at_ms: 1_789_100_000_000 + candidate.next.position.generation,
            receipt_key_id: "receipt-r1".to_string(),
            receipt_id: [0; 32],
            payload: Vec::new(),
            signature_der: Vec::new(),
        };
        receipt.operation_digest =
            sha2::Sha256::digest(canonical_operation(candidate, &receipt)?).into();
        if matches!(*self.behavior.lock().unwrap(), Behavior::WrongGeneration) {
            receipt.generation += 1;
        }
        // Model an authority that signs the wrong network label with an otherwise
        // trusted key and the exact candidate operation digest.
        if matches!(*self.behavior.lock().unwrap(), Behavior::WrongNetwork) {
            receipt.network = other_network(self.network).to_string();
        }
        receipt.payload = canonical_receipt(&receipt);
        receipt.receipt_id = sha2::Sha256::digest(&receipt.payload).into();
        let signature: Signature = self.signing_key.sign(&receipt.payload);
        receipt.signature_der = signature.to_der().as_bytes().to_vec();
        let snapshot = AuthoritySnapshot {
            bucket: receipt.snapshot_bucket.clone(),
            key: receipt.snapshot_key.clone(),
            version_id: receipt.snapshot_version_id.clone(),
            sha256: receipt.snapshot_sha256,
            size_bytes: receipt.snapshot_size_bytes,
        };
        let mut head = AuthorityHead {
            binding: candidate.next.binding.clone(),
            generation: candidate.next.position.generation,
            snapshot_fence: candidate.next.position.fence,
            previous_snapshot_sha256: candidate.previous.snapshot_sha256,
            snapshot_sha256: candidate.next.digest,
            epoch: candidate.previous.epoch,
            owner_id: candidate.previous.owner_id.clone(),
            head_fingerprint: [candidate.next.position.generation as u8; 32],
            lease_expires_at_ms: receipt.lease_expires_at_ms,
            commit_id: Some(candidate.commit_id.clone()),
            snapshot: Some(snapshot),
            updated_at: "2026-09-11T00:00:00.000Z".to_string(),
        };
        if matches!(*self.behavior.lock().unwrap(), Behavior::WrongHeadNetwork) {
            let other = other_network(self.network);
            head.binding.neo_n3_magic = neo_signer::network::network_magic(other);
            head.binding.neox_chain_id = neo_signer::network::neox_chain_id(other);
        }
        Ok(CommitResult { head, receipt })
    }

    fn verify_lease(&self, head: &AuthorityHead) -> Result<AuthorityHead> {
        match *self.behavior.lock().unwrap() {
            Behavior::Fail => bail!("simulated remote lease failure"),
            Behavior::Valid
            | Behavior::WrongGeneration
            | Behavior::WrongNetwork
            | Behavior::WrongHeadNetwork => Ok(head.clone()),
        }
    }
}

fn fixture(
    behavior: Behavior,
) -> Result<(tempfile::TempDir, Store, Arc<Coordinator>, DurableState)> {
    network_fixture(behavior, Network::Testnet)
}

fn network_fixture(
    behavior: Behavior,
    network: Network,
) -> Result<(tempfile::TempDir, Store, Arc<Coordinator>, DurableState)> {
    let directory = tempfile::tempdir()?;
    let store = Store::open(directory.path().join("signer.db"))?;
    let master = MasterKey::from_bytes([9; 32]);
    let receipt_key = SigningKey::from_slice(&[7; 32])?;
    let profile = VaultProfile {
        profile_version: PROFILE_VERSION,
        vault_id: "00112233445566778899aabbccddeeff".to_string(),
        environment: network.to_string(),
        networks: vec![VaultNetwork {
            chain_family: "neo-n3".to_string(),
            chain_id: u64::from(neo_signer::network::network_magic(network)),
            genesis_hash: format!("0x{}", "11".repeat(32)),
        }],
        custody_kms_key_arn:
            "arn:aws:kms:ap-southeast-1:736326664265:key/11111111-2222-3333-4444-555555555555"
                .to_string(),
        root_key_version: "testnet-r6".to_string(),
        root_key_commitment: hex::encode(root_key_commitment(&master)),
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
                    receipt_key
                        .verifying_key()
                        .to_encoded_point(false)
                        .as_bytes(),
                ),
            }],
        },
        release_policy_version: "testnet-r6".to_string(),
    }
    .validate()?;
    let cipher = SnapshotCipher::from_profile(&master, &profile)?;
    let head = AuthorityHead::genesis(cipher.binding().clone(), 3, "session-a".to_string())?;
    let coordinator = Arc::new(Coordinator::new(receipt_key, network));
    coordinator.behavior(behavior);
    let durable =
        DurableState::from_verified_lease(Arc::new(profile), cipher, coordinator.clone(), head)?;
    Ok((directory, store, coordinator, durable))
}

#[test]
fn exact_signed_receipt_advances_the_only_ready_head() -> Result<()> {
    let (_directory, store, coordinator, durable) = fixture(Behavior::Valid)?;
    let first = durable.commit(&store, operation_digest("raw-signed", Some("key-1")))?;
    let second = durable.commit(&store, operation_digest("policy-saved", Some("key-1")))?;
    assert_eq!(first.generation, 1);
    assert_eq!(second.generation, 2);
    assert_eq!(
        second.snapshot_sha256,
        coordinator.candidates.lock().unwrap()[1].next.digest
    );
    assert!(matches!(durable.status(), DurableStatus::Ready(head) if *head == second));
    let candidates = coordinator.candidates.lock().unwrap();
    assert_eq!(
        candidates[1].previous.snapshot_sha256,
        candidates[0].next.digest
    );
    assert_eq!(
        candidates[1].next.position.previous_digest,
        candidates[0].next.digest
    );
    assert!(!candidates[0].envelope.is_empty());
    Ok(())
}

#[test]
fn ambiguous_failure_fences_the_process_and_prevents_retry() -> Result<()> {
    let (_directory, store, coordinator, durable) = fixture(Behavior::Fail)?;
    assert!(durable.commit(&store, [1; 32]).is_err());
    coordinator.behavior(Behavior::Valid);
    assert!(durable.commit(&store, [2; 32]).is_err());
    assert!(matches!(durable.status(), DurableStatus::Fenced { .. }));
    assert_eq!(coordinator.candidates.lock().unwrap().len(), 1);
    Ok(())
}

#[test]
fn a_real_but_inexact_receipt_fences_the_process() -> Result<()> {
    let (_directory, store, _coordinator, durable) = fixture(Behavior::WrongGeneration)?;
    assert!(durable.commit(&store, [3; 32]).is_err());
    assert!(matches!(durable.status(), DurableStatus::Fenced { .. }));
    Ok(())
}

fn allowed<T>(outcome: Outcome<T>) -> T {
    match outcome {
        Outcome::Allowed(value) => value,
        Outcome::Refused(refusal) => panic!("fixture was refused: {}", refusal.code),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn signclient_metadata_and_signature_share_one_durable_barrier() -> Result<()> {
    let (_directory, store, coordinator, durable) = fixture(Behavior::Valid)?;
    let (_, admin_token) = provision_admin_caller(&store, "bootstrap")?;
    let admin = CallerCredentials::server_to_server(&admin_token);
    let service = SignerService::new(store, MasterKey::from_bytes([9; 32]));
    let key = allowed(service.generate_key(&admin, "validator", Network::Testnet, None)?);
    allowed(service.save_policy(
        &admin,
        &key.key_id,
        &SignerPolicy {
            allow_consensus: true,
            ..Default::default()
        },
    )?);
    let (_, caller_token) = allowed(service.create_caller(
        &admin,
        "neo-signclient",
        KeyGrant::Only(vec![key.key_id.clone()]),
        &[CallerCapability::Sign],
        &[],
    )?);
    let service = service.with_durable_state(Arc::new(durable));
    let bridge = SignClientBridge::new(ApiState::new(service), &key.key_id, &caller_token);
    let mut dbft = vec![0x40];
    dbft.extend_from_slice(&17u32.to_le_bytes());
    dbft.extend_from_slice(&[0, 0]);
    dbft.extend_from_slice(&9u64.to_le_bytes());

    let response = bridge
        .sign_extensible_payload(GrpcRequest::new(SignExtensiblePayloadRequest {
            payload: Some(ExtensiblePayload {
                category: "dBFT".to_string(),
                valid_block_start: 0,
                valid_block_end: 17,
                sender: key.script_hash.as_bytes().to_vec(),
                data: dbft,
            }),
            script_hashes: vec![key.script_hash.as_bytes().to_vec()],
            network: key.network_magic,
        }))
        .await?
        .into_inner();

    assert_eq!(response.signs.len(), 1);
    assert_eq!(
        coordinator.candidates.lock().unwrap().len(),
        1,
        "one SignClient key lookup plus sign RPC must cross one durable barrier"
    );
    Ok(())
}

#[tokio::test]
async fn observable_results_are_withheld_and_health_fails_after_commit_failure() -> Result<()> {
    let (_directory, store, coordinator, durable) = fixture(Behavior::Valid)?;
    let (_, admin_token) = provision_admin_caller(&store, "bootstrap")?;
    let admin = CallerCredentials::server_to_server(&admin_token);
    let service = SignerService::new(store.clone(), MasterKey::from_bytes([9; 32]))
        .with_durable_state(Arc::new(durable));

    let key = allowed(
        service.execute_observable(SignerAuditAction::KeyGenerated, None, || {
            service.generate_key(&admin, "durable key", Network::Testnet, None)
        })?,
    );
    allowed(service.execute_observable(
        SignerAuditAction::PolicySaved,
        Some(&key.key_id),
        || {
            service.save_policy(
                &admin,
                &key.key_id,
                &SignerPolicy {
                    allow_raw: true,
                    ..Default::default()
                },
            )
        },
    )?);
    let (_caller, token) =
        allowed(
            service.execute_observable(SignerAuditAction::CallerCreated, None, || {
                service.create_caller(
                    &admin,
                    "raw workload",
                    KeyGrant::Only(vec![key.key_id.clone()]),
                    &[CallerCapability::RawSign],
                    &[],
                )
            })?,
        );
    assert_eq!(coordinator.candidates.lock().unwrap().len(), 3);

    coordinator.behavior(Behavior::Fail);
    let signing = CallerCredentials::server_to_server(&token);
    let result =
        service.execute_observable(SignerAuditAction::RawSigned, Some(&key.key_id), || {
            service.sign_raw_with_request_id(
                &signing,
                &key.key_id,
                b"must not escape",
                Some("durable-failure"),
            )
        });
    assert!(
        result.is_err(),
        "a locally produced signature must be withheld"
    );
    let caller_id = store
        .list_signer_callers()?
        .into_iter()
        .find(|caller| caller.label == "raw workload")
        .expect("fixture caller")
        .id;
    assert!(
        store
            .find_signer_request(&caller_id, "durable-failure")?
            .is_some(),
        "the fenced candidate retains its exact idempotent result locally"
    );

    let ran = Arc::new(AtomicBool::new(false));
    let observed = ran.clone();
    assert!(service
        .execute_observable(SignerAuditAction::RawSigned, Some(&key.key_id), || {
            observed.store(true, Ordering::SeqCst);
            service.sign_raw(&signing, &key.key_id, b"second")
        },)
        .is_err());
    assert!(
        !ran.load(Ordering::SeqCst),
        "a fenced service must reject before the operation runs"
    );

    let response = router(ApiState::new(service))
        .oneshot(Request::builder().uri("/health").body(Body::empty())?)
        .await?;
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    let body = response.into_body().collect().await?.to_bytes();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&body)?["status"],
        "fenced"
    );
    Ok(())
}

fn other_network(network: Network) -> Network {
    match network {
        Network::Mainnet => Network::Testnet,
        Network::Testnet => Network::Mainnet,
        Network::Private => panic!("public-network fixture only"),
    }
}

#[test]
fn both_networks_advance_independent_durable_heads() -> Result<()> {
    let (_main_dir, main_store, main_coordinator, main) =
        network_fixture(Behavior::Valid, Network::Mainnet)?;
    let (_test_dir, test_store, test_coordinator, test) =
        network_fixture(Behavior::Valid, Network::Testnet)?;
    let main_first = main.commit(&main_store, [1; 32])?;
    let test_first = test.commit(&test_store, [1; 32])?;
    let main_second = main.commit(&main_store, [2; 32])?;
    assert_eq!(main_second.generation, 2);
    assert_eq!(test_first.generation, 1);
    assert_ne!(main_first.binding, test_first.binding);
    assert!(matches!(test.status(), DurableStatus::Ready(head) if *head == test_first));
    assert_eq!(main_coordinator.candidates.lock().unwrap().len(), 2);
    assert_eq!(test_coordinator.candidates.lock().unwrap().len(), 1);
    Ok(())
}

#[test]
fn signed_cross_network_receipts_and_heads_fence_both_networks() -> Result<()> {
    for network in [Network::Mainnet, Network::Testnet] {
        for behavior in [Behavior::WrongNetwork, Behavior::WrongHeadNetwork] {
            let (_directory, store, coordinator, durable) = network_fixture(behavior, network)?;
            assert!(durable.commit(&store, [3; 32]).is_err());
            assert!(matches!(durable.status(), DurableStatus::Fenced { .. }));
            coordinator.behavior(Behavior::Valid);
            assert!(durable.commit(&store, [4; 32]).is_err());
            assert_eq!(coordinator.candidates.lock().unwrap().len(), 1);
        }
    }
    Ok(())
}
