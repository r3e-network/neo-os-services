use super::*;
use crate::durable::{
    canonical_operation, canonical_receipt, AuthorityHead, CommitCandidate, CommitReceipt,
};
use crate::snapshot::{SnapshotHead, SnapshotPosition};
use aws_lc_rs::{
    digest::{digest, SHA256},
    rsa::{OaepPublicEncryptingKey, PublicEncryptingKey, OAEP_SHA256_MGF1SHA256},
    signature::{ParsedPublicKey, RSA_PSS_2048_8192_SHA256},
};
use serde::Deserialize;
use std::collections::VecDeque;
use std::sync::Mutex;

const VECTOR_JSON: &str =
    include_str!("../../../../deploy/custody-state-authority/test/fixtures/protocol-v2.json");

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProtocolVector {
    schema: String,
    request_proof: VectorRequestProof,
    request_proof_canonical_hex: String,
    request_proof_sha256: String,
    operation: VectorOperation,
    operation_canonical_hex: String,
    operation_sha256: String,
    receipt: VectorReceipt,
    receipt_canonical_hex: String,
    receipt_sha256: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct VectorRequestProof {
    schema: String,
    method: String,
    path: String,
    session_token_sha256: String,
    timestamp_ms: String,
    nonce: String,
    body_sha256: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct VectorOperation {
    schema: String,
    network: String,
    vault_id: String,
    profile_id: String,
    network_id: String,
    root_commitment: String,
    owner_id: String,
    epoch: String,
    generation: String,
    snapshot_fence: String,
    previous_generation: String,
    previous_snapshot_fence: String,
    previous_snapshot_sha256: String,
    commit_id: String,
    mutation_digest: String,
    snapshot_bucket: String,
    snapshot_key: String,
    snapshot_version_id: String,
    snapshot_sha256: String,
    snapshot_size_bytes: usize,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct VectorReceipt {
    schema: String,
    network: String,
    vault_id: String,
    profile_id: String,
    network_id: String,
    root_commitment: String,
    commit_id: String,
    operation_digest: String,
    mutation_digest: String,
    previous_generation: String,
    previous_snapshot_fence: String,
    previous_snapshot_sha256: String,
    generation: String,
    snapshot_sha256: String,
    epoch: String,
    snapshot_fence: String,
    owner_id: String,
    snapshot_bucket: String,
    snapshot_key: String,
    snapshot_version_id: String,
    snapshot_size_bytes: usize,
    lease_expires_at_ms: String,
    committed_at_ms: String,
    receipt_key_id: String,
}

fn hash(value: &str) -> [u8; 32] {
    hex::decode(value).unwrap().try_into().unwrap()
}

fn counter(value: &str) -> u64 {
    value.parse().unwrap()
}

fn receipt(value: &VectorReceipt) -> CommitReceipt {
    assert_eq!(value.schema, RECEIPT_SCHEMA);
    CommitReceipt {
        network: value.network.clone(),
        vault_id: hash(&value.vault_id),
        profile_hash: hash(&value.profile_id),
        network_set_hash: hash(&value.network_id),
        root_key_commitment: hash(&value.root_commitment),
        commit_id: value.commit_id.clone(),
        operation_digest: hash(&value.operation_digest),
        mutation_digest: hash(&value.mutation_digest),
        previous_generation: counter(&value.previous_generation),
        previous_snapshot_fence: counter(&value.previous_snapshot_fence),
        previous_snapshot_sha256: hash(&value.previous_snapshot_sha256),
        generation: counter(&value.generation),
        snapshot_sha256: hash(&value.snapshot_sha256),
        epoch: counter(&value.epoch),
        snapshot_fence: counter(&value.snapshot_fence),
        owner_id: value.owner_id.clone(),
        snapshot_bucket: value.snapshot_bucket.clone(),
        snapshot_key: value.snapshot_key.clone(),
        snapshot_version_id: value.snapshot_version_id.clone(),
        snapshot_size_bytes: value.snapshot_size_bytes,
        lease_expires_at_ms: counter(&value.lease_expires_at_ms),
        committed_at_ms: counter(&value.committed_at_ms),
        receipt_key_id: value.receipt_key_id.clone(),
        receipt_id: [0; 32],
        payload: Vec::new(),
        signature_der: Vec::new(),
    }
}

#[test]
fn rust_consumes_the_exact_js_v2_protocol_vector() {
    let vector: ProtocolVector = serde_json::from_str(VECTOR_JSON).unwrap();
    assert_eq!(vector.schema, "neoos/custody-state-protocol-vectors/v1");
    assert_eq!(vector.request_proof.schema, REQUEST_PROOF_SCHEMA);
    let proof = canonical_request_proof_fields(
        &vector.request_proof.method,
        &vector.request_proof.path,
        &hash(&vector.request_proof.session_token_sha256),
        counter(&vector.request_proof.timestamp_ms),
        &hash(&vector.request_proof.nonce),
        &hash(&vector.request_proof.body_sha256),
    )
    .unwrap();
    assert_eq!(hex::encode(&proof), vector.request_proof_canonical_hex);
    assert_eq!(
        hex::encode(Sha256::digest(&proof)),
        vector.request_proof_sha256
    );
    assert_eq!(vector.operation.schema, "neoos/custody-state-operation/v2");
    assert_eq!(vector.operation.network, "testnet");
    assert_eq!(vector.operation.previous_generation, "11");
    let receipt = receipt(&vector.receipt);
    let candidate = vector_candidate(&vector);
    assert_eq!(receipt.snapshot_bucket, vector.operation.snapshot_bucket);
    assert_eq!(receipt.snapshot_key, vector.operation.snapshot_key);
    assert_eq!(
        receipt.snapshot_version_id,
        vector.operation.snapshot_version_id
    );

    let operation = canonical_operation(&candidate, &receipt).unwrap();
    assert_eq!(hex::encode(&operation), vector.operation_canonical_hex);
    assert_eq!(
        hex::encode(Sha256::digest(&operation)),
        vector.operation_sha256
    );

    let receipt_bytes = canonical_receipt(&receipt);
    assert_eq!(hex::encode(&receipt_bytes), vector.receipt_canonical_hex);
    assert_eq!(
        hex::encode(Sha256::digest(&receipt_bytes)),
        vector.receipt_sha256
    );
}

#[test]
fn response_structs_reject_unknown_fields() {
    let malformed = br#"{
        "error":{"code":"head_not_initialized","message":"absent"},
        "request_id":null,
        "permissive":true
    }"#;
    assert!(serde_json::from_slice::<ErrorResponse>(malformed).is_err());
}

#[test]
fn sigv4_binds_the_session_and_payload_with_execute_api_scope() {
    let request = signed_request(
        "https://authority.example",
        "ap-southeast-1",
        &AwsCredentials {
            access_key_id: "AKIDEXAMPLE".to_string(),
            secret_access_key: "secret".to_string(),
            session_token: Some("sts-token".to_string()),
        },
        "POST",
        "/v1/challenges",
        br#"{"a":1}"#,
        &[(SESSION_HEADER, "session-token")],
        "20260911T010203Z",
    )
    .unwrap();
    let authorization = request.headers.get("authorization").unwrap();
    assert!(authorization.contains("/ap-southeast-1/execute-api/aws4_request"));
    assert!(authorization.contains("x-custody-session"));
    assert_eq!(request.headers[SESSION_HEADER], "session-token");
    assert_eq!(request.headers["x-amz-security-token"], "sts-token");
}

struct QueueTransport {
    responses: Mutex<VecDeque<HttpResponse>>,
    requests: Mutex<Vec<HttpRequest>>,
}

impl QueueTransport {
    fn new(responses: Vec<HttpResponse>) -> Self {
        Self {
            responses: Mutex::new(responses.into()),
            requests: Mutex::new(Vec::new()),
        }
    }
}

impl HttpTransport for QueueTransport {
    fn send(&self, request: &HttpRequest, maximum_response_bytes: usize) -> Result<HttpResponse> {
        assert!(request.body.len() <= maximum_response_bytes || request.method == "PUT");
        self.requests.lock().unwrap().push(request.clone());
        self.responses
            .lock()
            .unwrap()
            .pop_front()
            .context("test transport exhausted")
    }
}

fn response(status: u16, body: serde_json::Value) -> HttpResponse {
    HttpResponse {
        status,
        headers: BTreeMap::new(),
        body: serde_json::to_vec(&body).unwrap(),
    }
}

#[test]
fn ambiguous_commit_retries_the_exact_same_commit_id_and_body() {
    let master = MasterKey::from_bytes([0x5a; 32]);
    let profile = Arc::new(crate::vault_profile::test_profile([0x5a; 32]));
    let cipher = SnapshotCipher::from_profile(&master, &profile).unwrap();
    let previous =
        AuthorityHead::genesis(cipher.binding().clone(), 7, "nitro-owner".to_string()).unwrap();
    let (envelope, next) = cipher
        .seal(
            b"snapshot payload",
            SnapshotPosition {
                generation: 1,
                fence: 7,
                previous_digest: [0; 32],
            },
        )
        .unwrap();
    let candidate = CommitCandidate {
        commit_id: "permanent-commit-id".to_string(),
        mutation_digest: [0x66; 32],
        previous,
        next,
        envelope,
    };
    let transport = Arc::new(QueueTransport::new(vec![
        response(
            500,
            serde_json::json!({"error":{"code":"internal_error","message":"closed"},"request_id":"r1"}),
        ),
        response(
            503,
            serde_json::json!({"error":{"code":"unavailable","message":"retry"},"request_id":"r2"}),
        ),
        response(
            500,
            serde_json::json!({"error":{"code":"internal_error","message":"closed"},"request_id":"r3"}),
        ),
    ]));
    let client = CoordinatorClient {
        profile,
        binding: cipher.binding().clone(),
        credentials: AwsCredentials {
            access_key_id: "AKID".to_string(),
            secret_access_key: "secret".to_string(),
            session_token: None,
        },
        transport: transport.clone(),
        owner_id: "nitro-owner".to_string(),
        session_key: SessionTransportKey::generate().unwrap(),
        attestation: Arc::new(nitro_attest::release::NsmAttestation),
        session: Mutex::new(SessionCredential {
            token: Zeroizing::new("a".repeat(43)),
            expires_at_ms: u64::MAX,
        }),
    };
    let snapshot = AuthoritySnapshot {
        bucket: "bucket".to_string(),
        key: "snapshots/object.bin".to_string(),
        version_id: "version-1".to_string(),
        sha256: candidate.next.digest,
        size_bytes: candidate.envelope.len(),
    };
    assert!(client
        .submit_commit(&candidate, &snapshot, "version-1")
        .is_err());
    let requests = transport.requests.lock().unwrap();
    assert_eq!(requests.len(), MAX_ATTEMPTS);
    let nonces = requests
        .iter()
        .map(|request| &request.headers[REQUEST_PROOF_NONCE_HEADER])
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(nonces.len(), MAX_ATTEMPTS);
    assert!(requests
        .iter()
        .all(|request| request.body == requests[0].body));
    assert!(requests
        .iter()
        .all(|request| request.url.ends_with("/commits")));
    let body: serde_json::Value = serde_json::from_slice(&requests[0].body).unwrap();
    assert_eq!(body["commit_id"], "permanent-commit-id");
    assert_eq!(body["snapshot_fence"], "7");
    assert_eq!(body["previous_snapshot_fence"], "0");
}

#[test]
fn download_requires_the_exact_version_size_and_hash() {
    let profile = Arc::new(crate::vault_profile::test_profile([0x5a; 32]));
    let cipher =
        SnapshotCipher::from_profile(&MasterKey::from_bytes([0x5a; 32]), &profile).unwrap();
    let bytes = b"exact encrypted snapshot".to_vec();
    let digest: [u8; 32] = Sha256::digest(&bytes).into();
    let snapshot = AuthoritySnapshot {
        bucket: "bucket".to_string(),
        key: "snapshots/exact.bin".to_string(),
        version_id: "version-exact".to_string(),
        sha256: digest,
        size_bytes: bytes.len(),
    };
    let head = AuthorityHead {
        binding: cipher.binding().clone(),
        generation: 4,
        snapshot_fence: 3,
        previous_snapshot_sha256: [0x44; 32],
        snapshot_sha256: digest,
        epoch: 7,
        owner_id: "nitro-owner".to_string(),
        head_fingerprint: [0x88; 32],
        lease_expires_at_ms: u64::MAX,
        commit_id: Some("commit-4".to_string()),
        snapshot: Some(snapshot.clone()),
        updated_at: "2026-09-11T00:00:00.000Z".to_string(),
    };
    let ticket = response(
        200,
        serde_json::json!({
            "schema": WIRE_SCHEMA,
            "method": "GET",
            "url": "https://s3.example/exact",
            "expires_at": "2026-09-11T00:01:00.000Z",
            "snapshot": {
                "bucket": snapshot.bucket,
                "key": snapshot.key,
                "version_id": snapshot.version_id,
                "sha256": hex::encode(snapshot.sha256),
                "size_bytes": snapshot.size_bytes
            },
            "request_id": "request-1"
        }),
    );
    let mut object = HttpResponse {
        status: 200,
        headers: BTreeMap::from([("x-amz-version-id".to_string(), "version-exact".to_string())]),
        body: bytes.clone(),
    };
    let transport = Arc::new(QueueTransport::new(vec![ticket.clone(), object.clone()]));
    let client = CoordinatorClient {
        profile: profile.clone(),
        binding: cipher.binding().clone(),
        credentials: AwsCredentials {
            access_key_id: "AKID".to_string(),
            secret_access_key: "secret".to_string(),
            session_token: None,
        },
        transport,
        owner_id: "nitro-owner".to_string(),
        session_key: SessionTransportKey::generate().unwrap(),
        attestation: Arc::new(nitro_attest::release::NsmAttestation),
        session: Mutex::new(SessionCredential {
            token: Zeroizing::new("a".repeat(43)),
            expires_at_ms: u64::MAX,
        }),
    };
    assert_eq!(client.download_snapshot(&head).unwrap(), bytes);

    object
        .headers
        .insert("x-amz-version-id".to_string(), "wrong".to_string());
    let transport = Arc::new(QueueTransport::new(vec![ticket, object]));
    let bad = CoordinatorClient {
        profile,
        binding: cipher.binding().clone(),
        credentials: client.credentials.clone(),
        transport,
        owner_id: "nitro-owner".to_string(),
        session_key: SessionTransportKey::generate().unwrap(),
        attestation: Arc::new(nitro_attest::release::NsmAttestation),
        session: Mutex::new(SessionCredential {
            token: Zeroizing::new("a".repeat(43)),
            expires_at_ms: u64::MAX,
        }),
    };
    assert!(bad.download_snapshot(&head).is_err());
}

struct RecordingAttestation {
    public_key: Arc<Mutex<Vec<u8>>>,
}

impl AttestationSource for RecordingAttestation {
    fn attest(
        &self,
        nonce: Option<&[u8]>,
        user_data: Option<&[u8]>,
        public_key: Option<&[u8]>,
    ) -> nitro_attest::AttestResult<Vec<u8>> {
        if nonce != Some(&[0x11; 32]) || user_data != Some(&[0x22; 32]) {
            return Err("challenge binding mismatch".to_string());
        }
        let public_key = public_key.ok_or_else(|| "session key missing".to_string())?;
        *self.public_key.lock().unwrap() = public_key.to_vec();
        Ok(b"attestation-document".to_vec())
    }
}

struct SessionAuthority {
    network: crate::network::Network,
    binding: VaultBinding,
    public_key: Arc<Mutex<Vec<u8>>>,
    owner_id: Mutex<Option<String>>,
    exchanges: std::sync::atomic::AtomicUsize,
    fail: std::sync::atomic::AtomicBool,
}

impl HttpTransport for SessionAuthority {
    fn send(&self, request: &HttpRequest, _maximum_response_bytes: usize) -> Result<HttpResponse> {
        anyhow::ensure!(
            !self.fail.load(std::sync::atomic::Ordering::SeqCst),
            "injected authority failure"
        );
        if request.url.ends_with("/v1/challenges") {
            let body: serde_json::Value = serde_json::from_slice(&request.body)?;
            let owner_id = body["owner_id"].as_str().context("owner id")?.to_string();
            *self.owner_id.lock().unwrap() = Some(owner_id);
            return Ok(response(
                201,
                serde_json::json!({
                    "challenge_id": "challenge-1",
                    "network": self.network.to_string(),
                    "schema": WIRE_SCHEMA,
                    "vault_id": hex::encode(self.binding.vault_id),
                    "profile_id": hex::encode(self.binding.profile_hash),
                    "network_id": hex::encode(self.binding.network_set_hash),
                    "root_commitment": hex::encode(self.binding.root_key_commitment),
                    "expires_at": (time::OffsetDateTime::now_utc() + time::Duration::minutes(1)).format(&time::format_description::well_known::Rfc3339).unwrap(),
                    "attestation": {
                        "nonce_hex": "11".repeat(32),
                        "user_data_hex": "22".repeat(32),
                        "expected_pcrs": {
                            "pcr0": "33".repeat(48),
                            "pcr1": "44".repeat(48),
                            "pcr2": "55".repeat(48)
                        }
                    },
                    "request_id": "request-challenge"
                }),
            ));
        }
        if request.url.ends_with("/v1/sessions") {
            let body: serde_json::Value = serde_json::from_slice(&request.body)?;
            assert_eq!(body["challenge_id"], "challenge-1");
            assert_eq!(
                body["attestation_document"],
                BASE64.encode(b"attestation-document")
            );
            let der = self.public_key.lock().unwrap().clone();
            let key = PublicEncryptingKey::from_der(&der)?;
            assert_eq!(key.key_size_bits(), 3072);
            let exchange = self
                .exchanges
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let token = if exchange == 0 { "S" } else { "R" }.repeat(43);
            let oaep = OaepPublicEncryptingKey::new(key)?;
            let mut ciphertext = vec![0u8; oaep.ciphertext_size()];
            let ciphertext = oaep
                .encrypt(
                    &OAEP_SHA256_MGF1SHA256,
                    token.as_bytes(),
                    &mut ciphertext,
                    None,
                )?
                .to_vec();
            let key_hash = hex::encode(Sha256::digest(&der));
            return Ok(response(
                201,
                serde_json::json!({
                    "sealed_session_token": {
                        "algorithm": "RSA-OAEP-256",
                        "key_sha256": key_hash,
                        "ciphertext_base64": BASE64.encode(ciphertext)
                    },
                    "request_header": SESSION_HEADER,
                    "schema": WIRE_SCHEMA,
                    "network": self.network.to_string(),
                    "vault_id": hex::encode(self.binding.vault_id),
                    "profile_id": hex::encode(self.binding.profile_hash),
                    "network_id": hex::encode(self.binding.network_set_hash),
                    "root_commitment": hex::encode(self.binding.root_key_commitment),
                    "owner_id": self.owner_id.lock().unwrap().clone().unwrap(),
                    "request_proof": {
                        "schema": REQUEST_PROOF_SCHEMA,
                        "algorithm": REQUEST_PROOF_ALGORITHM,
                        "timestamp_header": REQUEST_PROOF_TIMESTAMP_HEADER,
                        "nonce_header": REQUEST_PROOF_NONCE_HEADER,
                        "signature_header": REQUEST_PROOF_SIGNATURE_HEADER,
                        "max_clock_skew_seconds": 30
                    },
                    "expires_at": (time::OffsetDateTime::now_utc() + time::Duration::minutes(5)).format(&time::format_description::well_known::Rfc3339).unwrap(),
                    "request_id": "request-session"
                }),
            ));
        }
        bail!("unexpected session authority request")
    }
}

#[test]
fn session_is_unsealed_only_with_exact_rsa_3072_oaep_sha256() {
    for network in [
        crate::network::Network::Mainnet,
        crate::network::Network::Testnet,
    ] {
        session_exchange_for_network(network);
    }
}

fn session_exchange_for_network(network: crate::network::Network) {
    let profile = Arc::new(network_binding::profile(network));
    let cipher =
        SnapshotCipher::from_profile(&MasterKey::from_bytes([0x5a; 32]), &profile).unwrap();
    let public_key = Arc::new(Mutex::new(Vec::new()));
    let transport = Arc::new(SessionAuthority {
        network,
        binding: cipher.binding().clone(),
        public_key: public_key.clone(),
        owner_id: Mutex::new(None),
        exchanges: std::sync::atomic::AtomicUsize::new(0),
        fail: std::sync::atomic::AtomicBool::new(false),
    });
    let attestation = RecordingAttestation { public_key };
    let client = CoordinatorClient::establish_with_transport(
        profile,
        cipher.binding().clone(),
        AwsCredentials {
            access_key_id: "AKID".to_string(),
            secret_access_key: "secret".to_string(),
            session_token: None,
        },
        Arc::new(attestation),
        transport.clone(),
    )
    .unwrap();
    assert_eq!(
        client.session.lock().unwrap().token.as_str(),
        "S".repeat(43)
    );
    assert!(client.owner_id().starts_with("nitro-"));
    assert_eq!(client.owner_id().len(), "nitro-".len() + 64);

    let original_owner = client.owner_id().to_owned();
    let original_der = client.session_key.public_key_der().unwrap();
    let original_key = ParsedPublicKey::new(&RSA_PSS_2048_8192_SHA256, &original_der).unwrap();
    client.session.lock().unwrap().expires_at_ms = 0;
    let client = Arc::new(client);
    let requests = std::thread::scope(|scope| {
        let handles = (0..4)
            .map(|_| {
                let client = client.clone();
                scope.spawn(move || {
                    client
                        .signed_authority_request("GET", "/v1/test", &[])
                        .unwrap()
                })
            })
            .collect::<Vec<_>>();
        handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect::<Vec<_>>()
    });
    assert_eq!(
        transport
            .exchanges
            .load(std::sync::atomic::Ordering::SeqCst),
        2
    );
    assert_eq!(client.owner_id(), original_owner);
    assert_eq!(client.session_key.public_key_der().unwrap(), original_der);
    for request in requests {
        assert_eq!(request.headers[SESSION_HEADER], "R".repeat(43));
        let nonce: [u8; 32] = hex::decode(&request.headers[REQUEST_PROOF_NONCE_HEADER])
            .unwrap()
            .try_into()
            .unwrap();
        let canonical = canonical_request_proof(
            "GET",
            "/v1/test",
            &request.headers[SESSION_HEADER],
            request.headers[REQUEST_PROOF_TIMESTAMP_HEADER]
                .parse()
                .unwrap(),
            &nonce,
            &[],
        )
        .unwrap();
        original_key
            .verify_digest_sig(
                &digest(&SHA256, &canonical),
                &BASE64
                    .decode(&request.headers[REQUEST_PROOF_SIGNATURE_HEADER])
                    .unwrap(),
            )
            .unwrap();
    }
    client.session.lock().unwrap().expires_at_ms = 0;
    transport
        .fail
        .store(true, std::sync::atomic::Ordering::SeqCst);
    assert!(client
        .signed_authority_request("GET", "/v1/test", &[])
        .is_err());
    assert_eq!(client.session.lock().unwrap().expires_at_ms, 0);
}

#[test]
fn authority_expiry_requires_rfc3339_and_a_nonnegative_timestamp() {
    assert!(expiry_millis("not-a-date").is_err());
    assert!(expiry_millis("1969-12-31T23:59:59Z").is_err());
    assert_eq!(expiry_millis("1970-01-01T01:00:01+01:00").unwrap(), 1000);
}

struct RecoveryFixture {
    target: std::path::PathBuf,
    observed: AuthorityHead,
    leased: AuthorityHead,
    envelope: Vec<u8>,
    calls: Mutex<Vec<&'static str>>,
}

impl RecoveryAuthority for RecoveryFixture {
    fn head(&self) -> Result<Option<AuthorityHead>> {
        assert!(
            !self.target.exists(),
            "Store::open ran before HEAD verification"
        );
        self.calls.lock().unwrap().push("head");
        Ok(Some(self.observed.clone()))
    }

    fn takeover(&self, previous: Option<&AuthorityHead>) -> Result<AuthorityHead> {
        assert!(!self.target.exists(), "Store::open ran before takeover");
        assert_eq!(previous, Some(&self.observed));
        self.calls.lock().unwrap().push("takeover");
        Ok(self.leased.clone())
    }

    fn download_snapshot(&self, head: &AuthorityHead) -> Result<Vec<u8>> {
        assert!(
            !self.target.exists(),
            "Store::open ran before exact download"
        );
        assert_eq!(head, &self.leased);
        self.calls.lock().unwrap().push("download");
        Ok(self.envelope.clone())
    }
}

impl DurableCoordinator for RecoveryFixture {
    fn commit(&self, _candidate: &CommitCandidate) -> Result<CommitResult> {
        bail!("recovery fixture does not commit")
    }

    fn verify_lease(&self, head: &AuthorityHead) -> Result<AuthorityHead> {
        self.calls.lock().unwrap().push("renew");
        Ok(head.clone())
    }
}

#[test]
fn non_genesis_recovery_verifies_head_and_takeover_before_install_and_ready() {
    let directory = tempfile::tempdir().unwrap();
    let source_path = directory.path().join("source.db");
    let target = directory.path().join("restored.db");
    let source = Store::open(&source_path).unwrap();
    let master = MasterKey::from_bytes([0x5a; 32]);
    let profile = Arc::new(crate::vault_profile::test_profile([0x5a; 32]));
    let cipher = SnapshotCipher::from_profile(&master, &profile).unwrap();
    let (envelope, snapshot_head) = source
        .sealed_snapshot(
            &cipher,
            SnapshotPosition {
                generation: 1,
                fence: 3,
                previous_digest: [0; 32],
            },
        )
        .unwrap();
    let snapshot = AuthoritySnapshot {
        bucket: "snapshot-bucket".to_string(),
        key: "snapshots/one.bin".to_string(),
        version_id: "version-one".to_string(),
        sha256: snapshot_head.digest,
        size_bytes: envelope.len(),
    };
    let observed = AuthorityHead {
        binding: cipher.binding().clone(),
        generation: 1,
        snapshot_fence: 3,
        previous_snapshot_sha256: [0; 32],
        snapshot_sha256: snapshot_head.digest,
        epoch: 3,
        owner_id: "prior-owner".to_string(),
        head_fingerprint: [0x31; 32],
        lease_expires_at_ms: 1,
        commit_id: Some("commit-one".to_string()),
        snapshot: Some(snapshot.clone()),
        updated_at: "2026-09-11T00:00:00.000Z".to_string(),
    };
    let leased = AuthorityHead {
        epoch: 4,
        owner_id: "new-owner".to_string(),
        head_fingerprint: [0x41; 32],
        lease_expires_at_ms: u64::MAX,
        updated_at: "2026-09-11T00:01:00.000Z".to_string(),
        ..observed.clone()
    };
    let authority = Arc::new(RecoveryFixture {
        target: target.clone(),
        observed,
        leased,
        envelope,
        calls: Mutex::new(Vec::new()),
    });
    let service =
        recover_with_authority(profile, master, &target, authority.clone(), cipher).unwrap();
    assert!(target.exists());
    assert!(matches!(
        service.durable_status(),
        Some(crate::durable::DurableStatus::Ready(_))
    ));
    assert_eq!(
        *authority.calls.lock().unwrap(),
        ["head", "takeover", "download"]
    );
    service.verify_durable_lease().unwrap();
    assert_eq!(authority.calls.lock().unwrap().last(), Some(&"renew"));
}

struct GenesisRecoveryFixture {
    target: std::path::PathBuf,
    leased: AuthorityHead,
    calls: Mutex<Vec<&'static str>>,
}

impl RecoveryAuthority for GenesisRecoveryFixture {
    fn head(&self) -> Result<Option<AuthorityHead>> {
        assert!(
            !self.target.exists(),
            "Store::open ran before confirming HEAD absence"
        );
        self.calls.lock().unwrap().push("head-absent");
        Ok(None)
    }

    fn takeover(&self, previous: Option<&AuthorityHead>) -> Result<AuthorityHead> {
        assert!(!self.target.exists(), "Store::open ran before takeover");
        assert!(previous.is_none());
        self.calls.lock().unwrap().push("takeover-genesis");
        Ok(self.leased.clone())
    }

    fn download_snapshot(&self, _head: &AuthorityHead) -> Result<Vec<u8>> {
        panic!("genesis recovery must not download a snapshot")
    }
}

impl DurableCoordinator for GenesisRecoveryFixture {
    fn commit(&self, _candidate: &CommitCandidate) -> Result<CommitResult> {
        bail!("recovery fixture does not commit")
    }

    fn verify_lease(&self, head: &AuthorityHead) -> Result<AuthorityHead> {
        Ok(head.clone())
    }
}

#[test]
fn genesis_recovery_requires_absent_head_before_store_open_and_ready() {
    let directory = tempfile::tempdir().unwrap();
    let target = directory.path().join("genesis.db");
    let master = MasterKey::from_bytes([0x5a; 32]);
    let profile = Arc::new(crate::vault_profile::test_profile([0x5a; 32]));
    let cipher = SnapshotCipher::from_profile(&master, &profile).unwrap();
    let leased =
        AuthorityHead::genesis(cipher.binding().clone(), 1, "genesis-owner".to_string()).unwrap();
    let authority = Arc::new(GenesisRecoveryFixture {
        target: target.clone(),
        leased,
        calls: Mutex::new(Vec::new()),
    });

    let service = recover_with_authority(profile, master, &target, authority.clone(), cipher)
        .expect("absent HEAD may initialize genesis after takeover");

    assert!(target.exists());
    assert!(matches!(
        service.durable_status(),
        Some(crate::durable::DurableStatus::Ready(head)) if head.is_genesis()
    ));
    assert_eq!(
        *authority.calls.lock().unwrap(),
        ["head-absent", "takeover-genesis"]
    );
}

#[test]
fn stale_local_database_is_refused_before_any_remote_recovery_call() {
    let directory = tempfile::tempdir().unwrap();
    let target = directory.path().join("signer.db");
    std::fs::write(&target, b"stale").unwrap();
    let master = MasterKey::from_bytes([0x5a; 32]);
    let profile = Arc::new(crate::vault_profile::test_profile([0x5a; 32]));
    let cipher = SnapshotCipher::from_profile(&master, &profile).unwrap();
    let genesis = AuthorityHead::genesis(cipher.binding().clone(), 1, "owner".to_string()).unwrap();
    let authority = Arc::new(RecoveryFixture {
        target: target.clone(),
        observed: genesis.clone(),
        leased: genesis,
        envelope: Vec::new(),
        calls: Mutex::new(Vec::new()),
    });
    assert!(recover_with_authority(profile, master, &target, authority.clone(), cipher).is_err());
    assert!(authority.calls.lock().unwrap().is_empty());
}

// Source-only synthetic additions for the dedicated migration restore seam.
// No test or workload was run while authoring this candidate.
struct MigrationRecoveryCase {
    _directory: tempfile::TempDir,
    profile: Arc<ValidatedVaultProfile>,
    root: MasterKey,
    cipher: SnapshotCipher,
    migration: crate::migration::MeasuredMigration,
    authority: Arc<RecoveryFixture>,
}

fn migration_recovery_case(generation: u64, keep_receipt: bool) -> MigrationRecoveryCase {
    use crate::migration::tests::{manifest, permit, prepared, profile, validated};
    let directory = tempfile::tempdir().unwrap();
    let source = Store::open(directory.path().join("source.db")).unwrap();
    let profile = Arc::new(profile());
    let root = MasterKey::from_bytes([0x5a; 32]);
    let cipher = SnapshotCipher::from_profile(&root, &profile).unwrap();
    let migration = validated(&manifest(&profile), &profile).unwrap();
    let state = prepared();
    source
        .stage_legacy_migration(&state, &permit(&state))
        .unwrap();
    if generation > 1 {
        source
            .set_signer_caller_digest("internal-n3-raw-r1", &[8; 32])
            .unwrap();
        source
            .set_signer_caller_disabled("internal-n3-raw-r1", true)
            .unwrap();
        source
            .set_signer_key_disabled("mn-updater-r1", true)
            .unwrap();
    }
    if !keep_receipt {
        let connection = rusqlite::Connection::open(source.db_path()).unwrap();
        connection
            .execute("DELETE FROM signer_audit WHERE id = 1", [])
            .unwrap();
    }
    let previous_digest = if generation == 1 { [0; 32] } else { [9; 32] };
    let (envelope, head) = source
        .sealed_snapshot(
            &cipher,
            SnapshotPosition {
                generation,
                fence: 3,
                previous_digest,
            },
        )
        .unwrap();
    let observed = AuthorityHead {
        binding: cipher.binding().clone(),
        generation,
        snapshot_fence: 3,
        previous_snapshot_sha256: previous_digest,
        snapshot_sha256: head.digest,
        epoch: 3,
        owner_id: "prior-owner".into(),
        head_fingerprint: [0x31; 32],
        lease_expires_at_ms: 1,
        commit_id: Some("committed-migration".into()),
        snapshot: Some(AuthoritySnapshot {
            bucket: "snapshot-bucket".into(),
            key: "snapshots/migration.bin".into(),
            version_id: "immutable-version".into(),
            sha256: head.digest,
            size_bytes: envelope.len(),
        }),
        updated_at: "2026-09-11T00:00:00.000Z".into(),
    };
    let leased = AuthorityHead {
        epoch: 4,
        owner_id: "new-owner".into(),
        head_fingerprint: [0x41; 32],
        lease_expires_at_ms: u64::MAX,
        ..observed.clone()
    };
    let authority = Arc::new(RecoveryFixture {
        target: directory.path().join("restored.db"),
        observed,
        leased,
        envelope,
        calls: Mutex::new(Vec::new()),
    });
    MigrationRecoveryCase {
        _directory: directory,
        profile,
        root,
        cipher,
        migration,
        authority,
    }
}

#[test]
fn migration_restore_uses_exact_snapshot_and_live_lease_without_import_or_commit() {
    let case = migration_recovery_case(1, true);
    let target = case.authority.target.clone();
    let service = recover_migrated_with_authority(
        case.profile,
        case.root,
        &target,
        case.authority.clone(),
        case.cipher,
        &case.migration,
    )
    .unwrap();
    assert_eq!(
        *case.authority.calls.lock().unwrap(),
        ["head", "takeover", "download", "renew"]
    );
    assert!(matches!(service.durable_status(),
        Some(crate::durable::DurableStatus::Ready(head)) if head.generation == 1));
    assert_eq!(service.repository().list_signer_keys().unwrap().len(), 2);
    assert_eq!(
        service
            .repository()
            .list_signer_audit(None, 10)
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn migration_restore_preserves_rotated_disabled_caller_and_key() {
    let case = migration_recovery_case(2, true);
    let target = case.authority.target.clone();
    let service = recover_migrated_with_authority(
        case.profile,
        case.root,
        &target,
        case.authority.clone(),
        case.cipher,
        &case.migration,
    )
    .unwrap();
    let callers = service.repository().list_signer_callers().unwrap();
    assert_eq!(callers.len(), 1);
    assert_eq!(callers[0].token_digest, [8; 32]);
    assert!(callers[0].disabled);
    assert!(
        service
            .repository()
            .get_signer_key("mn-updater-r1")
            .unwrap()
            .disabled
    );
    assert_eq!(
        service
            .repository()
            .list_signer_audit(None, 10)
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        *case.authority.calls.lock().unwrap(),
        ["head", "takeover", "download", "renew"]
    );
}

#[test]
fn migration_restore_refuses_absent_or_genesis_head_before_takeover_or_database() {
    let case = migration_recovery_case(1, true);
    let target = case.authority.target.clone();
    let genesis = AuthorityHead::genesis(case.cipher.binding().clone(), 1, "owner".into()).unwrap();
    let authority = Arc::new(GenesisRecoveryFixture {
        target: target.clone(),
        leased: genesis,
        calls: Mutex::new(Vec::new()),
    });
    assert!(recover_migrated_with_authority(
        case.profile,
        case.root,
        &target,
        authority.clone(),
        case.cipher,
        &case.migration
    )
    .is_err());
    assert!(!target.exists());
    assert_eq!(*authority.calls.lock().unwrap(), ["head-absent"]);

    let mut case = migration_recovery_case(1, true);
    let genesis = AuthorityHead::genesis(case.cipher.binding().clone(), 1, "owner".into()).unwrap();
    Arc::get_mut(&mut case.authority).unwrap().observed = genesis;
    let target = case.authority.target.clone();
    assert!(recover_migrated_with_authority(
        case.profile,
        case.root,
        &target,
        case.authority.clone(),
        case.cipher,
        &case.migration
    )
    .is_err());
    assert!(!target.exists());
    assert_eq!(*case.authority.calls.lock().unwrap(), ["head"]);
}

#[test]
fn migration_restore_refuses_expired_lease_or_changed_snapshot_before_download() {
    for expired in [true, false] {
        let mut case = migration_recovery_case(1, true);
        let fixture = Arc::get_mut(&mut case.authority).unwrap();
        if expired {
            fixture.leased.lease_expires_at_ms = 1;
        } else {
            fixture.leased.commit_id = Some("different-commit".into());
        }
        let target = case.authority.target.clone();
        assert!(recover_migrated_with_authority(
            case.profile,
            case.root,
            &target,
            case.authority.clone(),
            case.cipher,
            &case.migration
        )
        .is_err());
        assert!(!target.exists());
        assert_eq!(*case.authority.calls.lock().unwrap(), ["head", "takeover"]);
    }
}

#[test]
fn migration_restore_missing_historical_receipt_never_installs_database() {
    let case = migration_recovery_case(2, false);
    let target = case.authority.target.clone();
    assert!(recover_migrated_with_authority(
        case.profile,
        case.root,
        &target,
        case.authority.clone(),
        case.cipher,
        &case.migration
    )
    .is_err());
    assert!(!target.exists());
    assert_eq!(
        *case.authority.calls.lock().unwrap(),
        ["head", "takeover", "download"]
    );
}

struct MigrationLeaseFailure(Arc<RecoveryFixture>);
impl RecoveryAuthority for MigrationLeaseFailure {
    fn head(&self) -> Result<Option<AuthorityHead>> {
        self.0.head()
    }
    fn takeover(&self, previous: Option<&AuthorityHead>) -> Result<AuthorityHead> {
        self.0.takeover(previous)
    }
    fn download_snapshot(&self, head: &AuthorityHead) -> Result<Vec<u8>> {
        self.0.download_snapshot(head)
    }
}
impl DurableCoordinator for MigrationLeaseFailure {
    fn commit(&self, _candidate: &CommitCandidate) -> Result<CommitResult> {
        bail!("restore must not commit")
    }
    fn verify_lease(&self, _head: &AuthorityHead) -> Result<AuthorityHead> {
        self.0.calls.lock().unwrap().push("renew-failed");
        bail!("synthetic lease loss")
    }
}

#[test]
fn migration_restore_lease_loss_after_receipt_never_installs_or_publishes() {
    let case = migration_recovery_case(1, true);
    let target = case.authority.target.clone();
    let authority = Arc::new(MigrationLeaseFailure(case.authority.clone()));
    assert!(recover_migrated_with_authority(
        case.profile,
        case.root,
        &target,
        authority,
        case.cipher,
        &case.migration
    )
    .is_err());
    assert!(!target.exists());
    assert_eq!(
        *case.authority.calls.lock().unwrap(),
        ["head", "takeover", "download", "renew-failed"]
    );
}

fn vector_candidate(vector: &ProtocolVector) -> CommitCandidate {
    let binding = VaultBinding {
        vault_id: hash(&vector.operation.vault_id),
        neo_n3_magic: 894_710_606,
        neox_chain_id: 12_227_332,
        profile_hash: hash(&vector.operation.profile_id),
        network_set_hash: hash(&vector.operation.network_id),
        root_key_commitment: hash(&vector.operation.root_commitment),
        snapshot_format_version: 2,
        signer_schema_version: 1,
        allowed_chain_mask: 3,
    };
    let previous = AuthorityHead {
        binding: binding.clone(),
        generation: counter(&vector.operation.previous_generation),
        snapshot_fence: counter(&vector.operation.previous_snapshot_fence),
        previous_snapshot_sha256: [0x44; 32],
        snapshot_sha256: hash(&vector.operation.previous_snapshot_sha256),
        epoch: counter(&vector.operation.epoch),
        owner_id: vector.operation.owner_id.clone(),
        head_fingerprint: [0x99; 32],
        lease_expires_at_ms: u64::MAX,
        commit_id: Some("commit-11".to_string()),
        snapshot: Some(AuthoritySnapshot {
            bucket: "prior-bucket".to_string(),
            key: "prior-key".to_string(),
            version_id: "prior-version".to_string(),
            sha256: hash(&vector.operation.previous_snapshot_sha256),
            size_bytes: 1,
        }),
        updated_at: "2027-01-15T08:00:00.000Z".to_string(),
    };
    CommitCandidate {
        commit_id: vector.operation.commit_id.clone(),
        mutation_digest: hash(&vector.operation.mutation_digest),
        previous,
        next: SnapshotHead {
            binding,
            position: SnapshotPosition {
                generation: counter(&vector.operation.generation),
                fence: counter(&vector.operation.snapshot_fence),
                previous_digest: hash(&vector.operation.previous_snapshot_sha256),
            },
            digest: hash(&vector.operation.snapshot_sha256),
        },
        envelope: vec![0; vector.operation.snapshot_size_bytes],
    }
}

#[path = "coordinator_network.rs"]
mod network_binding;

// Real snapshot/receipt verification with a synthetic authority. No remote KMS,
// protected scalar or deployed authority is used by these migration cases.
fn migration_genesis_fixture() -> (
    tempfile::TempDir,
    Arc<ValidatedVaultProfile>,
    crate::migration::MeasuredMigration,
    Arc<super::enrollment_fixture::Authority>,
) {
    use crate::migration::tests::{manifest, profile, validated};
    let dir = tempfile::tempdir().unwrap();
    let profile = Arc::new(profile());
    let migration = validated(&manifest(&profile), &profile).unwrap();
    let authority = super::enrollment_fixture::Authority::new(profile.clone());
    (dir, profile, migration, authority)
}

fn migration_genesis_run<A>(
    profile: Arc<ValidatedVaultProfile>,
    migration: &crate::migration::MeasuredMigration,
    authority: Arc<A>,
    target: &Path,
    release: RoleRelease<'_>,
) -> Result<SignerService>
where
    A: RecoveryAuthority + DurableCoordinator + 'static,
{
    let root = MasterKey::from_bytes([0x5a; 32]);
    let cipher = SnapshotCipher::from_profile(&root, &profile)?;
    recover_migration_with_authority(
        profile,
        root,
        target,
        authority,
        cipher,
        migration,
        Some(release),
    )
}

#[test]
fn migration_genesis_ready_requires_one_complete_committed_readback() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let (dir, profile, migration, authority) = migration_genesis_fixture();
    let target = dir.path().join("genesis.db");
    let releases = AtomicUsize::new(0);
    let release = || {
        assert!(
            !target.exists(),
            "role release must precede local DB creation"
        );
        assert!(authority
            .head
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .is_genesis());
        releases.fetch_add(1, Ordering::SeqCst);
        Ok(crate::migration::tests::material())
    };
    let service =
        migration_genesis_run(profile, &migration, authority.clone(), &target, &release).unwrap();
    assert_eq!(releases.load(Ordering::SeqCst), 1);
    assert_eq!(authority.candidates.lock().unwrap().len(), 1);
    assert_eq!(authority.downloads.load(Ordering::SeqCst), 1);
    assert!(
        matches!(service.durable_status(), Some(crate::durable::DurableStatus::Ready(h)) if h.generation == 1)
    );
    let callers = service.repository().list_signer_callers().unwrap();
    assert_eq!(callers.len(), 1);
    assert_eq!(
        callers[0].capabilities,
        vec![crate::model::CallerCapability::RawSign]
    );
    assert_eq!(service.repository().list_signer_keys().unwrap().len(), 2);
    assert_eq!(
        service
            .repository()
            .list_signer_audit(None, 10)
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn migration_genesis_release_failure_or_identity_mismatch_never_opens_database() {
    for wrong_identity in [false, true] {
        let (dir, profile, migration, authority) = migration_genesis_fixture();
        let target = dir.path().join("genesis.db");
        let release = || {
            if !wrong_identity {
                return Err("synthetic secret transport detail".into());
            }
            let mut material = crate::migration::tests::material();
            material[0].scalar[31] = 9;
            Ok(material)
        };
        let result =
            migration_genesis_run(profile, &migration, authority.clone(), &target, &release);
        assert!(result.is_err());
        assert!(!result.err().unwrap().to_string().contains("secret"));
        assert!(!target.exists());
        assert!(authority.candidates.lock().unwrap().is_empty());
    }
}

#[test]
fn migration_genesis_lease_loss_during_release_prevents_database_or_commit() {
    let (dir, profile, migration, authority) = migration_genesis_fixture();
    let target = dir.path().join("genesis.db");
    let release = || {
        authority.expire();
        Ok(crate::migration::tests::material())
    };
    assert!(
        migration_genesis_run(profile, &migration, authority.clone(), &target, &release).is_err()
    );
    assert!(!target.exists());
    assert!(authority.candidates.lock().unwrap().is_empty());
}

#[test]
fn migration_genesis_durable_failures_are_one_attempt_without_ready_or_same_path_retry() {
    use super::enrollment_fixture::Fault;
    use std::sync::atomic::{AtomicUsize, Ordering};
    for fault in [
        Fault::Upload,
        Fault::LostReply,
        Fault::BadReceipt,
        Fault::ExpiredReceipt,
    ] {
        let (dir, profile, migration, authority) = migration_genesis_fixture();
        let target = dir.path().join("genesis.db");
        *authority.fault.lock().unwrap() = fault;
        let releases = AtomicUsize::new(0);
        let release = || {
            releases.fetch_add(1, Ordering::SeqCst);
            Ok(crate::migration::tests::material())
        };
        assert!(migration_genesis_run(
            profile.clone(),
            &migration,
            authority.clone(),
            &target,
            &release
        )
        .is_err());
        assert!(
            target.exists(),
            "retain failed staged state as a retry fence"
        );
        assert_eq!(authority.candidates.lock().unwrap().len(), 1);
        assert!(
            migration_genesis_run(profile, &migration, authority.clone(), &target, &release)
                .is_err()
        );
        assert_eq!(releases.load(Ordering::SeqCst), 1);
        assert_eq!(authority.candidates.lock().unwrap().len(), 1);
    }
}

#[test]
fn migration_genesis_lost_reply_restores_exact_commit_without_legacy_release() {
    use super::enrollment_fixture::Fault;
    use std::sync::atomic::Ordering;
    let (dir, profile, migration, authority) = migration_genesis_fixture();
    let first = dir.path().join("failed.db");
    *authority.fault.lock().unwrap() = Fault::LostReply;
    assert!(migration_genesis_run(
        profile.clone(),
        &migration,
        authority.clone(),
        &first,
        &|| Ok(crate::migration::tests::material())
    )
    .is_err());
    let digest = authority
        .head
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .snapshot_sha256;
    authority.expire();
    *authority.fault.lock().unwrap() = Fault::None;
    let second = dir.path().join("restored.db");
    let service = migration_genesis_run(profile, &migration, authority.clone(), &second, &|| {
        panic!("committed restore must never release original material")
    })
    .unwrap();
    assert!(
        matches!(service.durable_status(), Some(crate::durable::DurableStatus::Ready(h)) if h.snapshot_sha256 == digest)
    );
    assert_eq!(authority.candidates.lock().unwrap().len(), 1);
    assert_eq!(authority.downloads.load(Ordering::SeqCst), 1);
    assert_eq!(
        service
            .repository()
            .list_signer_audit(None, 10)
            .unwrap()
            .len(),
        1
    );
}

struct MigrationReadbackFailure(Arc<super::enrollment_fixture::Authority>);
impl RecoveryAuthority for MigrationReadbackFailure {
    fn head(&self) -> Result<Option<AuthorityHead>> {
        self.0.head()
    }
    fn takeover(&self, previous: Option<&AuthorityHead>) -> Result<AuthorityHead> {
        self.0.takeover(previous)
    }
    fn download_snapshot(&self, _: &AuthorityHead) -> Result<Vec<u8>> {
        bail!("synthetic readback failure")
    }
}
impl DurableCoordinator for MigrationReadbackFailure {
    fn verify_lease(&self, head: &AuthorityHead) -> Result<AuthorityHead> {
        self.0.verify_lease(head)
    }
    fn commit(&self, candidate: &CommitCandidate) -> Result<CommitResult> {
        self.0.commit(candidate)
    }
}

#[test]
fn migration_genesis_readback_failure_never_returns_service_even_after_commit() {
    let (dir, profile, migration, authority) = migration_genesis_fixture();
    let target = dir.path().join("genesis.db");
    assert!(migration_genesis_run(
        profile,
        &migration,
        Arc::new(MigrationReadbackFailure(authority.clone())),
        &target,
        &|| Ok(crate::migration::tests::material())
    )
    .is_err());
    assert!(target.exists());
    assert_eq!(authority.candidates.lock().unwrap().len(), 1);
    assert_eq!(
        authority.head.lock().unwrap().as_ref().unwrap().generation,
        1
    );
}

#[test]
fn migration_genesis_two_owners_cannot_both_release_or_commit() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let (dir, profile, migration, authority) = migration_genesis_fixture();
    let migration = Arc::new(migration);
    *authority.head_race.lock().unwrap() =
        Some(Arc::new((Mutex::new(0), std::sync::Condvar::new())));
    let releases = Arc::new(AtomicUsize::new(0));
    let mut threads = Vec::new();
    for i in 0..2 {
        let (profile, migration, authority, releases) = (
            profile.clone(),
            migration.clone(),
            authority.clone(),
            releases.clone(),
        );
        let target = dir.path().join(format!("boot-{i}.db"));
        threads.push(std::thread::spawn(move || {
            migration_genesis_run(profile, &migration, authority, &target, &|| {
                releases.fetch_add(1, Ordering::SeqCst);
                Ok(crate::migration::tests::material())
            })
            .is_ok()
        }));
    }
    let successes = threads
        .into_iter()
        .map(|t| t.join().unwrap())
        .filter(|ok| *ok)
        .count();
    assert_eq!(successes, 1);
    assert_eq!(releases.load(Ordering::SeqCst), 1);
    assert_eq!(authority.candidates.lock().unwrap().len(), 1);
}

#[test]
fn migration_internal_attachment_requires_ready_and_preserves_revocations() {
    let (dir, profile, migration, authority) = migration_genesis_fixture();
    let service = migration_genesis_run(
        profile.clone(),
        &migration,
        authority,
        &dir.path().join("raw.db"),
        &|| Ok(crate::migration::tests::material()),
    )
    .unwrap()
    .with_vault_binding(profile.clone(), None);
    assert!(service.migration_internal_raw_token(&migration).is_ok());
    let unready = SignerService::new(
        service.repository().clone(),
        MasterKey::from_bytes([0x5a; 32]),
    )
    .with_vault_binding(profile, None);
    assert!(unready.migration_internal_raw_token(&migration).is_err());
    let caller = service
        .repository()
        .list_signer_callers()
        .unwrap()
        .remove(0);
    service
        .repository()
        .set_signer_caller_disabled(&caller.id, true)
        .unwrap();
    assert!(service.migration_internal_raw_token(&migration).is_err());
    service
        .repository()
        .set_signer_caller_disabled(&caller.id, false)
        .unwrap();
    service
        .repository()
        .set_signer_caller_digest(&caller.id, &[7; 32])
        .unwrap();
    assert!(service.migration_internal_raw_token(&migration).is_err());
    service
        .repository()
        .delete_signer_caller(&caller.id)
        .unwrap();
    assert!(service.migration_internal_raw_token(&migration).is_err());
    assert!(service
        .repository()
        .list_signer_callers()
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn migration_internal_bridge_uses_canonical_auth_and_never_exposes_other_lanes() {
    use axum::{
        body::{to_bytes, Body},
        http::{Request, StatusCode},
    };
    let (dir, profile, migration, authority) = migration_genesis_fixture();
    let service = migration_genesis_run(
        profile.clone(),
        &migration,
        authority.clone(),
        &dir.path().join("bridge.db"),
        &|| Ok(crate::migration::tests::material()),
    )
    .unwrap()
    .with_vault_binding(profile, None);
    let state = crate::api::ApiState::new(service.clone());
    let bridge = crate::embedded::InternalRawBridge::fixture(state.clone(), migration);
    let request = || {
        Request::builder()
            .method("POST")
            .uri("/signer/api/v1/sign/raw")
            .header("content-type", "application/json")
            .body(Body::from(
                r#"{"key_id":"mn-updater-r1","data_hex":"0102"}"#,
            ))
            .unwrap()
    };
    // The very same ordinary router remains unauthenticated without a token.
    use tower::ServiceExt;
    let refused = crate::api::router(state).oneshot(request()).await.unwrap();
    assert_eq!(refused.status(), StatusCode::FORBIDDEN);
    let refused: serde_json::Value =
        serde_json::from_slice(&to_bytes(refused.into_body(), 65536).await.unwrap()).unwrap();
    assert_eq!(refused["code"], "missing-token");
    let response = bridge.dispatch(request()).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = to_bytes(response.into_body(), 65536).await.unwrap();
    let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(body["allowed"], true);
    assert_eq!(body["key_id"], "mn-updater-r1");
    assert!(!String::from_utf8_lossy(&bytes).contains("nci1_"));
    for id in ["mn-oracle-verifier-r1", "mn-updater-r1"] {
        let response = bridge
            .dispatch(
                Request::builder()
                    .method("GET")
                    .uri(format!("/signer/api/v1/keys/{id}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }
    let response = bridge
        .dispatch(
            Request::builder()
                .method("POST")
                .uri("/signer/api/v1/sign/raw")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"key_id":"foreign","data_hex":"0102"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    for path in [
        "/provision",
        "/signer/api/v1/callers",
        "/signer/api/v1/sign/transaction",
        "/signer/api/v1/keys/foreign",
        "/signer/api/v1/sign/raw?network=testnet",
    ] {
        assert!(bridge
            .dispatch(
                Request::builder()
                    .method("POST")
                    .uri(path)
                    .body(Body::empty())
                    .unwrap()
            )
            .await
            .is_err());
    }
    for header in ["authorization", "origin"] {
        let mut req = request();
        req.headers_mut()
            .insert(header, "unexpected".parse().unwrap());
        assert!(bridge.dispatch(req).await.is_err());
    }
    let caller = service
        .repository()
        .list_signer_callers()
        .unwrap()
        .remove(0);
    service
        .repository()
        .set_signer_caller_disabled(&caller.id, true)
        .unwrap();
    assert!(bridge.dispatch(request()).await.is_err());
}

fn semantic_v2_fixture() -> (
    tempfile::TempDir,
    Arc<ValidatedVaultProfile>,
    crate::migration::MeasuredMigration,
    Arc<super::enrollment_fixture::Authority>,
) {
    let dir = tempfile::tempdir().unwrap();
    let p = Arc::new(crate::migration::tests::profile());
    let m = crate::migration::tests::validated(&crate::migration::tests::semantic_manifest(&p), &p)
        .unwrap();
    let authority = super::enrollment_fixture::Authority::new(p.clone());
    (dir, p, m, authority)
}

fn semantic_v2_unsigned(method: &str, fee: u64, nonce: u32) -> Vec<u8> {
    semantic_v2_unsigned_to(
        "03013f49c42a14546c8bbe58f9d434c3517fccab",
        method,
        fee,
        nonce,
    )
}

fn semantic_v2_unsigned_to(contract: &str, method: &str, fee: u64, nonce: u32) -> Vec<u8> {
    use neo_os_core::n3_tx::{create_invoke_script, FeedSigner, FeedTx};
    let display: [u8; 20] = hex::decode(contract).unwrap().try_into().unwrap();
    let script = create_invoke_script(&display, method, &[]).unwrap();
    let mut scalar = [0u8; 32];
    scalar[31] = 2;
    let public = crate::crypto::public_key_from_private(&scalar).unwrap();
    let mut account = crate::crypto::script_hash(&public);
    account.reverse();
    FeedTx {
        nonce,
        valid_until_block: 1000,
        system_fee: fee,
        network_fee: 1000,
        signer: FeedSigner {
            script_hash: account.try_into().unwrap(),
        },
        script: &script,
    }
    .serialize_unsigned()
}

#[tokio::test]
async fn semantic_v2_bridge_fulltx_policy_domain_durable_and_currentcaller() {
    use axum::{
        body::{to_bytes, Body},
        http::{Request, StatusCode},
    };
    use p256::ecdsa::{signature::Verifier, Signature, VerifyingKey};
    let (dir, p, m, authority) = semantic_v2_fixture();
    let service = migration_genesis_run(
        p.clone(),
        &m,
        authority.clone(),
        &dir.path().join("v2.db"),
        &|| Ok(crate::migration::tests::material()),
    )
    .unwrap()
    .with_vault_binding(p.clone(), None);
    let state = crate::api::ApiState::new(service.clone());
    let bridge = crate::embedded::InternalSemanticBridge::fixture(state.clone(), m);
    let unsigned = semantic_v2_unsigned("updateFeeds", 1000, 1);
    let call = |data: Vec<u8>, id: &str, key: &str| {
        Request::builder().method("POST").uri("/signer/api/v1/sign/transaction").header("content-type","application/json").body(Body::from(serde_json::json!({"key_id":key,"unsigned_hex":hex::encode(data),"chain_family":"neo-n3","request_id":id}).to_string())).unwrap()
    };
    use tower::ServiceExt;
    assert_eq!(
        crate::api::router(state)
            .oneshot(call(unsigned.clone(), "first", "mn-updater-r1"))
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    let before_generation = authority.head.lock().unwrap().as_ref().unwrap().generation;
    let response = bridge
        .dispatch(call(unsigned.clone(), "first", "mn-updater-r1"))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = to_bytes(response.into_body(), 65536).await.unwrap();
    assert!(!String::from_utf8_lossy(&bytes).contains("nci1_"));
    let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(body["allowed"], true);
    let sigbytes = hex::decode(body["invocation_script"].as_str().unwrap()).unwrap();
    let verification = hex::decode(body["verification_script"].as_str().unwrap()).unwrap();
    let vk = VerifyingKey::from_sec1_bytes(&verification[2..35]).unwrap();
    let sig = Signature::from_slice(&sigbytes[2..]).unwrap();
    let mut pre = 860833102u32.to_le_bytes().to_vec();
    pre.extend_from_slice(&crate::crypto::transaction_hash(&unsigned));
    vk.verify(&pre, &sig).unwrap();
    pre[..4].copy_from_slice(&894710606u32.to_le_bytes());
    assert!(vk.verify(&pre, &sig).is_err());
    assert_eq!(
        authority.head.lock().unwrap().as_ref().unwrap().generation,
        before_generation + 1
    );
    assert!(service
        .repository()
        .list_signer_audit(None, 100)
        .unwrap()
        .iter()
        .any(|a| a.action == crate::model::SignerAuditAction::TransactionSigned));
    // Request ID cannot be rebound to different transaction bytes.
    assert_ne!(
        bridge
            .dispatch(call(
                semantic_v2_unsigned("updateFeeds", 1000, 2),
                "first",
                "mn-updater-r1"
            ))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    for (data, id) in [
        (semantic_v2_unsigned("updateFeed", 1000, 3), "method"),
        (semantic_v2_unsigned("updateFeeds", 150000001, 4), "fee"),
        (
            semantic_v2_unsigned_to(
                "2222222222222222222222222222222222222222",
                "updateFeeds",
                1000,
                5,
            ),
            "contract",
        ),
    ] {
        assert_ne!(
            bridge
                .dispatch(call(data, id, "mn-updater-r1"))
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
    }
    let mut wrong_scope = unsigned.clone();
    wrong_scope[46] = 0x80;
    assert!(bridge
        .dispatch(call(wrong_scope, "scope", "mn-updater-r1"))
        .await
        .is_err());
    let mut trailing = unsigned.clone();
    trailing.push(0);
    assert!(bridge
        .dispatch(call(trailing, "trailing", "mn-updater-r1"))
        .await
        .is_err());
    assert!(bridge
        .dispatch(call(vec![0; 36], "digest", "mn-updater-r1"))
        .await
        .is_err());
    assert!(bridge
        .dispatch(call(unsigned.clone(), "wrongkey", "mn-oracle-verifier-r1"))
        .await
        .is_err());
    for path in [
        "/signer/api/v1/sign/raw",
        "/signer/api/v1/sign/consensus",
        "/signer/api/v1/callers",
        "/signer/api/v1/sign/transaction?network=testnet",
    ] {
        assert!(bridge
            .dispatch(
                Request::builder()
                    .method("POST")
                    .uri(path)
                    .body(Body::empty())
                    .unwrap()
            )
            .await
            .is_err());
    }
    for header in ["authorization", "origin"] {
        let mut req = call(unsigned.clone(), "header", "mn-updater-r1");
        req.headers_mut().insert(header, "refused".parse().unwrap());
        assert!(bridge.dispatch(req).await.is_err());
    }
    service
        .repository()
        .set_signer_caller_disabled("internal-n3-feed-r1", true)
        .unwrap();
    assert!(bridge
        .dispatch(call(unsigned, "disabled", "mn-updater-r1"))
        .await
        .is_err());
}

#[tokio::test]
async fn semantic_v2_updater_raw_is_denied_while_feed_and_oracle_raw_coexist() {
    use axum::{
        body::{to_bytes, Body},
        http::{Request, StatusCode},
    };
    let (dir, p, migration, authority) = semantic_v2_fixture();
    let service = migration_genesis_run(
        p.clone(),
        &migration,
        authority,
        &dir.path().join("separated.db"),
        &|| Ok(crate::migration::tests::material()),
    )
    .unwrap()
    .with_vault_binding(p.clone(), None);
    let state = crate::api::ApiState::new(service.clone());
    let raw_migration =
        crate::migration::tests::validated(&crate::migration::tests::semantic_manifest(&p), &p)
            .unwrap();
    let raw = crate::embedded::InternalRawBridge::fixture(state.clone(), raw_migration);
    let semantic = crate::embedded::InternalSemanticBridge::fixture(state, migration);
    // Raw signing of this exact preimage would bypass the transaction policy.
    let mut collision = 860_833_102_u32.to_le_bytes().to_vec();
    collision.extend_from_slice(&crate::crypto::transaction_hash(&semantic_v2_unsigned(
        "updateFeed",
        1000,
        30,
    )));
    let collision_hex = hex::encode(collision);
    let raw_call = |key: &str| {
        Request::builder()
            .method("POST")
            .uri("/signer/api/v1/sign/raw")
            .header("content-type", "application/json")
            .body(Body::from(
                serde_json::json!({"key_id":key,"data_hex":collision_hex}).to_string(),
            ))
            .unwrap()
    };
    let denied = raw.dispatch(raw_call("mn-updater-r1")).await.unwrap();
    assert_eq!(denied.status(), StatusCode::FORBIDDEN);
    let denied: serde_json::Value =
        serde_json::from_slice(&to_bytes(denied.into_body(), 65536).await.unwrap()).unwrap();
    assert_eq!(denied["allowed"], false);
    assert_eq!(denied["code"], "raw-forbidden");
    let allowed = raw
        .dispatch(raw_call("mn-oracle-verifier-r1"))
        .await
        .unwrap();
    assert_eq!(allowed.status(), StatusCode::OK);
    let allowed: serde_json::Value =
        serde_json::from_slice(&to_bytes(allowed.into_body(), 65536).await.unwrap()).unwrap();
    assert_eq!(allowed["allowed"], true);
    for (method, id, expected) in [
        ("updateFeeds", "separated-feed", StatusCode::OK),
        (
            "updateFeed",
            "separated-wrong-method",
            StatusCode::FORBIDDEN,
        ),
    ] {
        let response = semantic
            .dispatch(
                Request::builder()
                    .method("POST")
                    .uri("/signer/api/v1/sign/transaction")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::json!({
                            "key_id":"mn-updater-r1",
                            "unsigned_hex":hex::encode(semantic_v2_unsigned(method, 1000, 31)),
                            "chain_family":"neo-n3",
                            "request_id":id,
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), expected, "{method}");
    }
    for id in ["mn-oracle-verifier-r1", "mn-updater-r1"] {
        assert!(!service
            .repository()
            .load_signer_policy(id)
            .unwrap()
            .unwrap()
            .mixes_raw_and_semantic_authority());
    }
}

#[test]
fn semantic_v2_genesis_restore_never_reimports_or_attaches_revoked_caller() {
    let (dir, p, m, authority) = semantic_v2_fixture();
    let service = migration_genesis_run(
        p.clone(),
        &m,
        authority.clone(),
        &dir.path().join("one.db"),
        &|| Ok(crate::migration::tests::material()),
    )
    .unwrap()
    .with_vault_binding(p.clone(), None);
    assert!(service.migration_internal_semantic_token(&m).is_ok());
    service
        .execute_observable(crate::model::SignerAuditAction::CallerCreated, None, || {
            service
                .repository()
                .set_signer_caller_disabled("internal-n3-feed-r1", true)?;
            Ok(crate::service::Outcome::Allowed(()))
        })
        .unwrap();
    authority.expire();
    let restored = migration_genesis_run(
        p.clone(),
        &m,
        authority.clone(),
        &dir.path().join("two.db"),
        &|| panic!("committed restore must never release"),
    )
    .unwrap()
    .with_vault_binding(p, None);
    assert!(restored.migration_internal_semantic_token(&m).is_err());
    assert!(
        restored
            .repository()
            .find_signer_caller("internal-n3-feed-r1")
            .unwrap()
            .unwrap()
            .disabled
    );
    assert_eq!(
        restored.repository().list_signer_callers().unwrap().len(),
        2
    );
    assert_eq!(restored.repository().list_signer_keys().unwrap().len(), 2);
}
