//! TestNet custody-state authority v3 client.
//!
//! The parent may proxy packets, but it never supplies state facts. Every API
//! call is SigV4 signed in the enclave, every successful response is decoded
//! into a closed schema, and snapshots are accepted only at the exact immutable
//! S3 version bound by the authenticated HEAD.

use std::{
    collections::BTreeMap,
    io::Read,
    path::Path,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use hmac::{Hmac, Mac};
use nitro_attest::{release::AttestationSource, session_key::SessionTransportKey};
use reqwest::{blocking::Client, Method};
use rsa::rand_core::{OsRng, RngCore};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::{
    durable::{
        AuthorityHead, AuthoritySnapshot, CommitCandidate, CommitReceipt, CommitResult,
        DurableCoordinator, DurableState,
    },
    service::SignerService,
    snapshot::{SnapshotCipher, VaultBinding},
    store::Store,
    vault::MasterKey,
    vault_profile::ValidatedVaultProfile,
};

const WIRE_SCHEMA: &str = "neoos/custody-state-wire/v3";
const HEAD_SCHEMA: &str = "neoos/custody-state-head/v2";
const RECEIPT_SCHEMA: &str = "neoos/custody-state-receipt/v2";
const TESTNET: &str = "testnet";
const SESSION_HEADER: &str = "x-custody-session";
const REQUEST_PROOF_SCHEMA: &str = "neoos/custody-state-request-proof/v1";
const REQUEST_PROOF_ALGORITHM: &str = "RSA-PSS-SHA256";
const REQUEST_PROOF_TIMESTAMP_HEADER: &str = "x-custody-pop-timestamp";
const REQUEST_PROOF_NONCE_HEADER: &str = "x-custody-pop-nonce";
const REQUEST_PROOF_SIGNATURE_HEADER: &str = "x-custody-pop-signature";
const MAX_API_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const MAX_ATTEMPTS: usize = 3;
const SESSION_REFRESH_MARGIN_MS: u64 = 30_000;
const ZERO_HASH: [u8; 32] = [0; 32];

type HmacSha256 = Hmac<Sha256>;

#[derive(Clone)]
pub struct AwsCredentials {
    pub access_key_id: String,
    pub secret_access_key: String,
    pub session_token: Option<String>,
}

impl AwsCredentials {
    pub fn validate(&self) -> Result<()> {
        anyhow::ensure!(
            !self.access_key_id.is_empty() && !self.secret_access_key.is_empty(),
            "AWS credentials are empty"
        );
        anyhow::ensure!(
            !self
                .access_key_id
                .bytes()
                .any(|byte| byte.is_ascii_whitespace()),
            "AWS access key id contains whitespace"
        );
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HttpRequest {
    pub method: String,
    pub url: String,
    pub headers: BTreeMap<String, String>,
    pub body: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HttpResponse {
    pub status: u16,
    pub headers: BTreeMap<String, String>,
    pub body: Vec<u8>,
}

pub trait HttpTransport: Send + Sync {
    fn send(&self, request: &HttpRequest, maximum_response_bytes: usize) -> Result<HttpResponse>;
}

pub struct ReqwestRustlsTransport {
    client: Client,
}

impl ReqwestRustlsTransport {
    pub fn new() -> Result<Self> {
        let client = Client::builder()
            .https_only(true)
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(20))
            .build()
            .context("failed to construct the rustls coordinator client")?;
        Ok(Self { client })
    }
}

impl HttpTransport for ReqwestRustlsTransport {
    fn send(&self, request: &HttpRequest, maximum_response_bytes: usize) -> Result<HttpResponse> {
        let method =
            Method::from_bytes(request.method.as_bytes()).context("invalid HTTP method")?;
        let mut builder = self.client.request(method, &request.url);
        for (name, value) in &request.headers {
            builder = builder.header(name, value);
        }
        let response = builder
            .body(request.body.clone())
            .send()
            .context("coordinator HTTPS request failed")?;
        if response
            .content_length()
            .is_some_and(|length| length > maximum_response_bytes as u64)
        {
            bail!("coordinator response exceeds its size limit");
        }
        let status = response.status().as_u16();
        let headers = response
            .headers()
            .iter()
            .map(|(name, value)| {
                Ok((
                    name.as_str().to_ascii_lowercase(),
                    value
                        .to_str()
                        .context("HTTP response contains a non-text header")?
                        .to_string(),
                ))
            })
            .collect::<Result<BTreeMap<_, _>>>()?;
        let mut body = Vec::new();
        response
            .take(maximum_response_bytes as u64 + 1)
            .read_to_end(&mut body)
            .context("failed to read coordinator response")?;
        anyhow::ensure!(
            body.len() <= maximum_response_bytes,
            "coordinator response exceeds its size limit"
        );
        Ok(HttpResponse {
            status,
            headers,
            body,
        })
    }
}

struct SessionCredential {
    token: Zeroizing<String>,
    expires_at_ms: u64,
}

fn expiry_millis(value: &str) -> Result<u64> {
    let parsed = time::OffsetDateTime::parse(value, &time::format_description::well_known::Rfc3339)
        .context("invalid authority expiry")?;
    u64::try_from(parsed.unix_timestamp_nanos() / 1_000_000)
        .context("authority expiry is out of range")
}

fn exchange_session(
    profile: &ValidatedVaultProfile,
    binding: &VaultBinding,
    credentials: &AwsCredentials,
    transport: &Arc<dyn HttpTransport>,
    attestation: &dyn AttestationSource,
    private_key: &SessionTransportKey,
) -> Result<(String, SessionCredential)> {
    let spki = private_key.public_key_der().map_err(anyhow::Error::msg)?;
    let key_hash: [u8; 32] = Sha256::digest(&spki).into();
    let owner_id = format!("nitro-{}", hex::encode(key_hash));
    let send = |path: &str, body: Vec<u8>| -> Result<HttpResponse> {
        let request = signed_request(
            &profile.document().coordinator.origin,
            &profile.document().coordinator.aws_region,
            credentials,
            "POST",
            path,
            &body,
            &[],
            &nitro_attest::kms::utc_amz_date_now(),
        )?;
        let response = transport.send(&request, MAX_API_RESPONSE_BYTES)?;
        require_status(&response, &[200, 201])?;
        Ok(response)
    };
    let response = send(
        "/v1/challenges",
        serde_json::to_vec(&ChallengeRequest {
            vault_id: hex::encode(binding.vault_id),
            profile_id: hex::encode(binding.profile_hash),
            network_id: hex::encode(binding.network_set_hash),
            root_commitment: hex::encode(binding.root_key_commitment),
            owner_id: owner_id.clone(),
        })?,
    )?;
    let challenge: ChallengeResponse = decode_json(&response.body)?;
    challenge.validate(binding)?;
    anyhow::ensure!(
        expiry_millis(&challenge.expires_at)? > now_millis()?,
        "challenge expired"
    );
    let nonce = hex::decode(&challenge.attestation.nonce_hex)?;
    let user_data = hex::decode(&challenge.attestation.user_data_hex)?;
    anyhow::ensure!(
        nonce.len() == 32 && user_data.len() == 32,
        "challenge binding length mismatch"
    );
    let document = attestation
        .attest(Some(&nonce), Some(&user_data), Some(&spki))
        .map_err(|error| anyhow::anyhow!("session attestation failed: {error}"))?;
    let response = send(
        "/v1/sessions",
        serde_json::to_vec(&SessionRequest {
            challenge_id: challenge.challenge_id,
            attestation_document: BASE64.encode(document),
        })?,
    )?;
    let session: SessionResponse = decode_json(&response.body)?;
    session.validate(binding, &owner_id, &key_hash)?;
    let expires_at_ms = expiry_millis(&session.expires_at)?;
    anyhow::ensure!(
        expires_at_ms > now_millis()?.saturating_add(SESSION_REFRESH_MARGIN_MS),
        "session expiry is too near or expired"
    );
    let ciphertext = BASE64.decode(&session.sealed_session_token.ciphertext_base64)?;
    let plaintext = private_key
        .open_session_token(&ciphertext)
        .map_err(anyhow::Error::msg)?;
    let token = Zeroizing::new(std::str::from_utf8(&plaintext)?.to_owned());
    validate_session_token(&token)?;
    Ok((
        owner_id,
        SessionCredential {
            token,
            expires_at_ms,
        },
    ))
}

pub struct CoordinatorClient {
    profile: Arc<ValidatedVaultProfile>,
    binding: VaultBinding,
    credentials: AwsCredentials,
    transport: Arc<dyn HttpTransport>,
    attestation: Arc<dyn AttestationSource>,
    owner_id: String,
    session_key: SessionTransportKey,
    session: Mutex<SessionCredential>,
}

impl CoordinatorClient {
    pub fn establish(
        profile: Arc<ValidatedVaultProfile>,
        binding: VaultBinding,
        credentials: AwsCredentials,
        attestation: Arc<dyn AttestationSource>,
    ) -> Result<Self> {
        Self::establish_with_transport(
            profile,
            binding,
            credentials,
            attestation,
            Arc::new(ReqwestRustlsTransport::new()?),
        )
    }

    pub fn establish_with_transport(
        profile: Arc<ValidatedVaultProfile>,
        binding: VaultBinding,
        credentials: AwsCredentials,
        attestation: Arc<dyn AttestationSource>,
        transport: Arc<dyn HttpTransport>,
    ) -> Result<Self> {
        credentials.validate()?;
        validate_profile_binding(&profile, &binding)?;
        let private_key = SessionTransportKey::generate().map_err(anyhow::Error::msg)?;
        let (owner_id, session) = exchange_session(
            &profile,
            &binding,
            &credentials,
            &transport,
            attestation.as_ref(),
            &private_key,
        )?;
        Ok(Self {
            profile,
            binding,
            credentials,
            transport,
            attestation,
            owner_id,
            session_key: private_key,
            session: Mutex::new(session),
        })
    }

    pub fn owner_id(&self) -> &str {
        &self.owner_id
    }

    pub fn head(&self) -> Result<Option<AuthorityHead>> {
        let response = self.authority_request("GET", "head", None::<&EmptyBody>)?;
        if response.status == 404 {
            let error: ErrorResponse = decode_json(&response.body)?;
            anyhow::ensure!(
                error.error.code == "head_not_initialized",
                "coordinator returned an unexpected HEAD absence"
            );
            return Ok(None);
        }
        require_status(&response, &[200])?;
        self.decode_head(&response.body).map(Some)
    }

    pub fn takeover(&self, previous: Option<&AuthorityHead>) -> Result<AuthorityHead> {
        let body = match previous {
            Some(head) => TakeoverRequest {
                owner_id: self.owner_id().to_string(),
                previous_owner_id: Some(head.owner_id.clone()),
                epoch: head.epoch.to_string(),
                snapshot_fence: head.snapshot_fence.to_string(),
                generation: head.generation.to_string(),
                snapshot_sha256: hex::encode(head.snapshot_sha256),
                head_fingerprint: hex::encode(head.head_fingerprint),
            },
            None => TakeoverRequest {
                owner_id: self.owner_id().to_string(),
                previous_owner_id: None,
                epoch: "0".to_string(),
                snapshot_fence: "0".to_string(),
                generation: "0".to_string(),
                snapshot_sha256: hex::encode(ZERO_HASH),
                head_fingerprint: hex::encode(ZERO_HASH),
            },
        };
        let response = self.authority_request("POST", "takeover", Some(&body))?;
        require_status(&response, &[200])?;
        let head = self.decode_head(&response.body)?;
        anyhow::ensure!(
            head.owner_id == self.owner_id(),
            "takeover returned another owner"
        );
        anyhow::ensure!(
            head.epoch == previous.map_or(1, |value| value.epoch.saturating_add(1)),
            "takeover returned an unexpected epoch"
        );
        if let Some(previous) = previous {
            anyhow::ensure!(
                head.same_snapshot(previous),
                "takeover changed the snapshot HEAD"
            );
        } else {
            anyhow::ensure!(
                head.is_genesis(),
                "genesis takeover returned non-genesis state"
            );
        }
        head.ensure_live(now_millis()?)?;
        Ok(head)
    }

    pub fn renew(&self, previous: &AuthorityHead) -> Result<AuthorityHead> {
        let response =
            self.authority_request("POST", "renew", Some(&HeadBindingRequest::from(previous)))?;
        require_status(&response, &[200])?;
        let renewed = self.decode_head(&response.body)?;
        anyhow::ensure!(
            renewed.same_lease_identity(previous),
            "renew returned a different authoritative HEAD"
        );
        renewed.ensure_live(now_millis()?)?;
        Ok(renewed)
    }

    pub fn download_snapshot(&self, head: &AuthorityHead) -> Result<Vec<u8>> {
        let expected = head
            .snapshot
            .as_ref()
            .context("non-genesis HEAD has no immutable snapshot object")?;
        let response = self.authority_request(
            "POST",
            "download-tickets",
            Some(&HeadBindingRequest::from(head)),
        )?;
        require_status(&response, &[200])?;
        let ticket: DownloadTicketResponse = decode_json(&response.body)?;
        ticket.validate(expected)?;
        let object = self.transport.send(
            &HttpRequest {
                method: "GET".to_string(),
                url: ticket.url,
                headers: BTreeMap::new(),
                body: Vec::new(),
            },
            expected
                .size_bytes
                .checked_add(1)
                .context("snapshot size overflow")?,
        )?;
        require_status(&object, &[200])?;
        anyhow::ensure!(
            object.headers.get("x-amz-version-id") == Some(&expected.version_id),
            "download did not return the exact S3 version"
        );
        anyhow::ensure!(
            object.body.len() == expected.size_bytes,
            "downloaded snapshot size does not match HEAD"
        );
        let digest: [u8; 32] = Sha256::digest(&object.body).into();
        anyhow::ensure!(
            digest == expected.sha256,
            "downloaded snapshot hash does not match HEAD"
        );
        Ok(object.body)
    }

    fn authority_request<T: Serialize + ?Sized>(
        &self,
        method: &str,
        operation: &str,
        body: Option<&T>,
    ) -> Result<HttpResponse> {
        let path = format!(
            "/v1/vaults/{}/profiles/{}/{}",
            hex::encode(self.binding.vault_id),
            hex::encode(self.binding.profile_hash),
            operation
        );
        let bytes = body
            .map(serde_json::to_vec)
            .transpose()?
            .unwrap_or_default();
        let request = self.signed_authority_request(method, &path, &bytes)?;
        self.transport.send(&request, MAX_API_RESPONSE_BYTES)
    }

    fn signed_authority_request(
        &self,
        method: &str,
        path: &str,
        body: &[u8],
    ) -> Result<HttpRequest> {
        // Serialize refresh so concurrent requests retain the same fenced owner.
        let mut session = self
            .session
            .lock()
            .map_err(|_| anyhow::anyhow!("session lock poisoned"))?;
        if session.expires_at_ms <= now_millis()?.saturating_add(SESSION_REFRESH_MARGIN_MS) {
            let (owner, refreshed) = exchange_session(
                &self.profile,
                &self.binding,
                &self.credentials,
                &self.transport,
                self.attestation.as_ref(),
                &self.session_key,
            )
            .context("attested session refresh failed")?;
            anyhow::ensure!(owner == self.owner_id, "session refresh changed owner");
            *session = refreshed;
        }
        let timestamp_ms = now_millis()?;
        let mut nonce = [0u8; 32];
        OsRng.fill_bytes(&mut nonce);
        let signature = sign_request_proof(
            &self.session_key,
            method,
            path,
            &session.token,
            timestamp_ms,
            &nonce,
            body,
        )?;
        let timestamp = timestamp_ms.to_string();
        let nonce_hex = hex::encode(nonce);
        let signature_base64 = BASE64.encode(signature);
        signed_request(
            &self.profile.document().coordinator.origin,
            &self.profile.document().coordinator.aws_region,
            &self.credentials,
            method,
            path,
            body,
            &[
                (SESSION_HEADER, session.token.as_str()),
                (REQUEST_PROOF_TIMESTAMP_HEADER, timestamp.as_str()),
                (REQUEST_PROOF_NONCE_HEADER, nonce_hex.as_str()),
                (REQUEST_PROOF_SIGNATURE_HEADER, signature_base64.as_str()),
            ],
            &nitro_attest::kms::utc_amz_date_now(),
        )
    }

    fn decode_head(&self, body: &[u8]) -> Result<AuthorityHead> {
        AuthorityHead::from_wire(decode_json(body)?, &self.binding)
    }

    fn upload(&self, candidate: &CommitCandidate) -> Result<(AuthoritySnapshot, String)> {
        let body = UploadTicketRequest::from_candidate(candidate, self.owner_id());
        let response = self.authority_request("POST", "upload-tickets", Some(&body))?;
        require_status(&response, &[200, 201])?;
        let ticket: UploadTicketResponse = decode_json(&response.body)?;
        ticket.validate(candidate)?;
        let upload_result = self.transport.send(
            &HttpRequest {
                method: "PUT".to_string(),
                url: ticket.upload.url.clone(),
                headers: ticket.upload.required_headers.clone(),
                body: candidate.envelope.clone(),
            },
            MAX_API_RESPONSE_BYTES,
        );
        let snapshot = ticket.snapshot.into_authority()?;
        match upload_result {
            Ok(upload) if upload.status == 200 => {
                if let Some(version_id) = upload.headers.get("x-amz-version-id") {
                    if validate_text(version_id, "S3 version id", 1024).is_ok() {
                        return Ok((snapshot, version_id.clone()));
                    }
                }
                self.resolve_uploaded_version(candidate, &snapshot)
                    .map(|version_id| (snapshot, version_id))
            }
            Ok(upload) if upload.status == 412 || upload.status >= 500 => self
                .resolve_uploaded_version(candidate, &snapshot)
                .map(|version_id| (snapshot, version_id)),
            Ok(upload) => Err(anyhow::anyhow!(response_error(&upload))),
            Err(_) => self
                .resolve_uploaded_version(candidate, &snapshot)
                .map(|version_id| (snapshot, version_id)),
        }
    }

    fn resolve_uploaded_version(
        &self,
        candidate: &CommitCandidate,
        expected: &AuthoritySnapshot,
    ) -> Result<String> {
        let body = UploadStatusRequest {
            commit_id: candidate.commit_id.clone(),
            owner_id: self.owner_id().to_string(),
        };
        let mut last_error = None;
        for _ in 0..MAX_ATTEMPTS {
            match self.authority_request("POST", "upload-status", Some(&body)) {
                Ok(response) if response.status == 200 => {
                    let status: UploadStatusResponse = decode_json(&response.body)?;
                    return status.validate(candidate, expected, self.owner_id());
                }
                Ok(response) if response.status >= 500 => {
                    last_error = Some(anyhow::anyhow!(response_error(&response)));
                }
                Ok(response) => return Err(anyhow::anyhow!(response_error(&response))),
                Err(error) => last_error = Some(error),
            }
        }
        Err(last_error.unwrap_or_else(|| anyhow::anyhow!("upload-status retry exhausted")))
            .context("exact S3 version remained ambiguous")
    }

    fn submit_commit(
        &self,
        candidate: &CommitCandidate,
        snapshot: &AuthoritySnapshot,
        version_id: &str,
    ) -> Result<CommitResult> {
        let body = CommitRequest::from_candidate(candidate, self.owner_id(), snapshot, version_id);
        let encoded = serde_json::to_vec(&body)?;
        let path = format!(
            "/v1/vaults/{}/profiles/{}/commits",
            hex::encode(self.binding.vault_id),
            hex::encode(self.binding.profile_hash)
        );
        let mut last_error = None;
        for _ in 0..MAX_ATTEMPTS {
            let request = self.signed_authority_request("POST", &path, &encoded)?;
            match self.transport.send(&request, MAX_API_RESPONSE_BYTES) {
                Ok(response) if [200, 201].contains(&response.status) => {
                    let wire: CommitResponse = decode_json(&response.body)?;
                    return wire.into_result(&self.binding);
                }
                Ok(response) if response.status >= 500 => {
                    last_error = Some(anyhow::anyhow!(response_error(&response)));
                }
                Ok(response) => return Err(anyhow::anyhow!(response_error(&response))),
                Err(error) => last_error = Some(error),
            }
        }
        Err(last_error.unwrap_or_else(|| anyhow::anyhow!("commit retry exhausted")))
            .context("same-id coordinator commit remained ambiguous after exact retries")
    }
}

impl DurableCoordinator for CoordinatorClient {
    fn commit(&self, candidate: &CommitCandidate) -> Result<CommitResult> {
        let (mut snapshot, version_id) = self.upload(candidate)?;
        snapshot.version_id = version_id.clone();
        self.submit_commit(candidate, &snapshot, &version_id)
    }

    fn verify_lease(&self, head: &AuthorityHead) -> Result<AuthorityHead> {
        self.renew(head)
    }
}

trait RecoveryAuthority {
    fn head(&self) -> Result<Option<AuthorityHead>>;
    fn takeover(&self, previous: Option<&AuthorityHead>) -> Result<AuthorityHead>;
    fn download_snapshot(&self, head: &AuthorityHead) -> Result<Vec<u8>>;
}

impl RecoveryAuthority for CoordinatorClient {
    fn head(&self) -> Result<Option<AuthorityHead>> {
        CoordinatorClient::head(self)
    }

    fn takeover(&self, previous: Option<&AuthorityHead>) -> Result<AuthorityHead> {
        CoordinatorClient::takeover(self, previous)
    }

    fn download_snapshot(&self, head: &AuthorityHead) -> Result<Vec<u8>> {
        CoordinatorClient::download_snapshot(self, head)
    }
}

/// Complete attested recovery. No SQLite path is opened before HEAD has been
/// authenticated and takeover has established this boot's fenced lease.
pub fn recover(
    profile: Arc<ValidatedVaultProfile>,
    credentials: AwsCredentials,
    master_key: MasterKey,
    database_path: &Path,
    attestation: Arc<dyn AttestationSource>,
) -> Result<SignerService> {
    // Refuse stale local state before taking ownership remotely. This is a
    // path-only existence check, never a SQLite open or source of truth.
    ensure_fresh_database_target(database_path)?;
    let cipher = SnapshotCipher::from_profile(&master_key, &profile)?;
    let client = Arc::new(CoordinatorClient::establish(
        Arc::clone(&profile),
        cipher.binding().clone(),
        credentials,
        attestation,
    )?);
    recover_with_authority(profile, master_key, database_path, client, cipher)
}

fn recover_with_authority<A>(
    profile: Arc<ValidatedVaultProfile>,
    master_key: MasterKey,
    database_path: &Path,
    authority: Arc<A>,
    cipher: SnapshotCipher,
) -> Result<SignerService>
where
    A: RecoveryAuthority + DurableCoordinator + 'static,
{
    ensure_fresh_database_target(database_path)?;
    let observed = authority.head()?;
    let leased = authority.takeover(observed.as_ref())?;
    let repository = if leased.is_genesis() {
        anyhow::ensure!(
            observed.is_none(),
            "genesis is valid only when HEAD was absent"
        );
        Store::open(database_path).context("failed to create the verified genesis store")?
    } else {
        let envelope = authority.download_snapshot(&leased)?;
        let expected = leased.snapshot_head()?;
        Store::install_snapshot(database_path, &cipher, &envelope, &expected)
            .context("failed to install the exact authoritative snapshot")?
    };
    let durable = DurableState::from_verified_lease(profile, cipher, authority, leased)?;
    Ok(SignerService::new(repository, master_key).with_durable_state(Arc::new(durable)))
}

fn ensure_fresh_database_target(path: &Path) -> Result<()> {
    anyhow::ensure!(
        !path.exists(),
        "verified genesis refuses an existing local custody database"
    );
    for suffix in ["-wal", "-shm", "-journal"] {
        let mut sidecar = path.as_os_str().to_os_string();
        sidecar.push(suffix);
        anyhow::ensure!(
            !Path::new(&sidecar).exists(),
            "verified genesis refuses a stale SQLite sidecar"
        );
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub fn signed_request(
    origin: &str,
    region: &str,
    credentials: &AwsCredentials,
    method: &str,
    path: &str,
    body: &[u8],
    extra_headers: &[(&str, &str)],
    amz_date: &str,
) -> Result<HttpRequest> {
    credentials.validate()?;
    validate_amz_date(amz_date)?;
    let origin = url::Url::parse(origin).context("invalid coordinator origin")?;
    anyhow::ensure!(origin.scheme() == "https", "coordinator requires HTTPS");
    let host = origin
        .host_str()
        .context("coordinator origin has no host")?;
    anyhow::ensure!(
        origin.path() == "/" && origin.query().is_none() && origin.fragment().is_none(),
        "coordinator origin must not contain path, query or fragment"
    );
    anyhow::ensure!(
        path.starts_with('/') && !path.contains('?'),
        "invalid coordinator path"
    );
    let payload_hash = hex::encode(Sha256::digest(body));
    let mut signed = BTreeMap::from([
        ("content-type".to_string(), "application/json".to_string()),
        ("host".to_string(), host.to_string()),
        ("x-amz-content-sha256".to_string(), payload_hash.clone()),
        ("x-amz-date".to_string(), amz_date.to_string()),
    ]);
    if let Some(token) = &credentials.session_token {
        signed.insert("x-amz-security-token".to_string(), token.clone());
    }
    for &(name, value) in extra_headers {
        validate_header(name, value)?;
        let normalized = name.to_ascii_lowercase();
        anyhow::ensure!(
            !matches!(
                normalized.as_str(),
                "authorization"
                    | "content-type"
                    | "host"
                    | "x-amz-content-sha256"
                    | "x-amz-date"
                    | "x-amz-security-token"
            ) && !signed.contains_key(&normalized),
            "duplicate or reserved signed header"
        );
        signed.insert(normalized, value.to_string());
    }
    let canonical_headers = signed
        .iter()
        .map(|(name, value)| format!("{name}:{}\n", value.trim()))
        .collect::<String>();
    let signed_headers = signed.keys().cloned().collect::<Vec<_>>().join(";");
    let canonical = format!(
        "{}\n{}\n\n{}\n{}\n{}",
        method.to_ascii_uppercase(),
        path,
        canonical_headers,
        signed_headers,
        payload_hash
    );
    let datestamp = &amz_date[..8];
    let scope = format!("{datestamp}/{region}/execute-api/aws4_request");
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{}",
        hex::encode(Sha256::digest(canonical.as_bytes()))
    );
    let date_key = hmac(
        format!("AWS4{}", credentials.secret_access_key).as_bytes(),
        datestamp.as_bytes(),
    );
    let region_key = hmac(&date_key, region.as_bytes());
    let service_key = hmac(&region_key, b"execute-api");
    let signing_key = hmac(&service_key, b"aws4_request");
    let signature = hex::encode(hmac(&signing_key, string_to_sign.as_bytes()));
    signed.insert(
        "authorization".to_string(),
        format!(
            "AWS4-HMAC-SHA256 Credential={}/{}, SignedHeaders={}, Signature={}",
            credentials.access_key_id, scope, signed_headers, signature
        ),
    );
    let url = format!("{}{}", origin.origin().ascii_serialization(), path);
    Ok(HttpRequest {
        method: method.to_ascii_uppercase(),
        url,
        headers: signed,
        body: body.to_vec(),
    })
}

fn canonical_request_proof(
    method: &str,
    path: &str,
    token: &str,
    timestamp_ms: u64,
    nonce: &[u8; 32],
    body: &[u8],
) -> Result<Vec<u8>> {
    let token_sha256: [u8; 32] = Sha256::digest(token.as_bytes()).into();
    let body_sha256: [u8; 32] = Sha256::digest(body).into();
    canonical_request_proof_fields(
        method,
        path,
        &token_sha256,
        timestamp_ms,
        nonce,
        &body_sha256,
    )
}

fn canonical_request_proof_fields(
    method: &str,
    path: &str,
    token_sha256: &[u8; 32],
    timestamp_ms: u64,
    nonce: &[u8; 32],
    body_sha256: &[u8; 32],
) -> Result<Vec<u8>> {
    let method = method.to_ascii_uppercase();
    anyhow::ensure!(
        matches!(method.as_str(), "GET" | "POST"),
        "invalid proof method"
    );
    anyhow::ensure!(
        path.starts_with("/v1/") && !path.contains(['?', '#']) && path.len() <= 2048,
        "invalid proof path"
    );
    let mut encoded = format!("{REQUEST_PROOF_SCHEMA}\0").into_bytes();
    push_proof_field(&mut encoded, method.as_bytes())?;
    push_proof_field(&mut encoded, path.as_bytes())?;
    encoded.extend_from_slice(token_sha256);
    encoded.extend_from_slice(&timestamp_ms.to_be_bytes());
    encoded.extend_from_slice(nonce);
    encoded.extend_from_slice(body_sha256);
    Ok(encoded)
}

fn push_proof_field(output: &mut Vec<u8>, value: &[u8]) -> Result<()> {
    let length = u32::try_from(value.len()).context("request proof field exceeds u32")?;
    output.extend_from_slice(&length.to_be_bytes());
    output.extend_from_slice(value);
    Ok(())
}

fn sign_request_proof(
    private_key: &SessionTransportKey,
    method: &str,
    path: &str,
    token: &str,
    timestamp_ms: u64,
    nonce: &[u8; 32],
    body: &[u8],
) -> Result<Vec<u8>> {
    let canonical = canonical_request_proof(method, path, token, timestamp_ms, nonce, body)?;
    private_key
        .sign_request_proof(&canonical)
        .map_err(anyhow::Error::msg)
}

fn hmac(key: &[u8], value: &[u8]) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC accepts any key length");
    mac.update(value);
    mac.finalize().into_bytes().to_vec()
}

fn validate_amz_date(value: &str) -> Result<()> {
    let bytes = value.as_bytes();
    anyhow::ensure!(
        bytes.len() == 16
            && bytes[8] == b'T'
            && bytes[15] == b'Z'
            && bytes[..8]
                .iter()
                .chain(&bytes[9..15])
                .all(u8::is_ascii_digit),
        "amz date must be YYYYMMDDTHHMMSSZ"
    );
    Ok(())
}

fn validate_header(name: &str, value: &str) -> Result<()> {
    anyhow::ensure!(
        !name.is_empty()
            && name
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte == b'-'),
        "invalid signed header name"
    );
    anyhow::ensure!(
        !value.is_empty() && !value.bytes().any(|byte| matches!(byte, b'\r' | b'\n')),
        "invalid signed header value"
    );
    Ok(())
}

fn validate_profile_binding(profile: &ValidatedVaultProfile, binding: &VaultBinding) -> Result<()> {
    anyhow::ensure!(
        profile.environment().to_string() == TESTNET,
        "coordinator is TestNet-only"
    );
    anyhow::ensure!(
        binding.profile_hash == *profile.profile_hash(),
        "profile hash mismatch"
    );
    anyhow::ensure!(
        binding.network_set_hash == *profile.network_set_hash(),
        "network set hash mismatch"
    );
    anyhow::ensure!(
        binding.root_key_commitment == *profile.root_key_commitment(),
        "root commitment mismatch"
    );
    Ok(())
}

fn now_millis() -> Result<u64> {
    u64::try_from(SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis())
        .context("system time exceeds u64 milliseconds")
}

fn decode_json<T: DeserializeOwned>(body: &[u8]) -> Result<T> {
    serde_json::from_slice(body).context("coordinator returned an invalid or non-canonical shape")
}

fn require_status(response: &HttpResponse, accepted: &[u16]) -> Result<()> {
    if accepted.contains(&response.status) {
        Ok(())
    } else {
        bail!(response_error(response))
    }
}

fn response_error(response: &HttpResponse) -> String {
    match serde_json::from_slice::<ErrorResponse>(&response.body) {
        Ok(error) => format!(
            "coordinator HTTP {} {}: {}",
            response.status, error.error.code, error.error.message
        ),
        Err(_) => format!(
            "coordinator HTTP {} returned an invalid error body",
            response.status
        ),
    }
}

fn decode_hash(value: &str, name: &str) -> Result<[u8; 32]> {
    anyhow::ensure!(
        value.len() == 64
            && value
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()),
        "{name} must be lowercase SHA-256 hex"
    );
    let decoded = hex::decode(value)?;
    decoded
        .try_into()
        .map_err(|_| anyhow::anyhow!("{name} has wrong length"))
}

fn decode_canonical_base64(value: &str, name: &str) -> Result<Vec<u8>> {
    let decoded = BASE64
        .decode(value)
        .with_context(|| format!("{name} is not base64"))?;
    anyhow::ensure!(
        BASE64.encode(&decoded) == value,
        "{name} base64 is not canonical"
    );
    Ok(decoded)
}

fn parse_u64(value: &str, name: &str) -> Result<u64> {
    anyhow::ensure!(
        value == "0"
            || (!value.starts_with('0') && value.bytes().all(|byte| byte.is_ascii_digit())),
        "{name} is not a canonical u64"
    );
    value.parse().with_context(|| format!("{name} exceeds u64"))
}

fn validate_text(value: &str, name: &str, maximum: usize) -> Result<()> {
    anyhow::ensure!(
        !value.is_empty() && value.len() <= maximum && !value.chars().any(char::is_control),
        "{name} is not a bounded canonical string"
    );
    Ok(())
}

fn validate_session_token(value: &str) -> Result<()> {
    anyhow::ensure!(
        value.len() == 43
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_')),
        "unsealed session token is not canonical base64url"
    );
    Ok(())
}

#[derive(Serialize)]
#[serde(deny_unknown_fields)]
struct ChallengeRequest {
    vault_id: String,
    profile_id: String,
    network_id: String,
    root_commitment: String,
    owner_id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ChallengeResponse {
    challenge_id: String,
    network: String,
    schema: String,
    vault_id: String,
    profile_id: String,
    network_id: String,
    root_commitment: String,
    expires_at: String,
    attestation: ChallengeAttestation,
    request_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ChallengeAttestation {
    nonce_hex: String,
    user_data_hex: String,
    expected_pcrs: ExpectedPcrs,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ExpectedPcrs {
    pcr0: String,
    pcr1: String,
    pcr2: String,
}

impl ChallengeResponse {
    fn validate(&self, binding: &VaultBinding) -> Result<()> {
        anyhow::ensure!(
            self.schema == WIRE_SCHEMA && self.network == TESTNET,
            "challenge schema mismatch"
        );
        anyhow::ensure!(
            self.vault_id == hex::encode(binding.vault_id),
            "challenge vault mismatch"
        );
        anyhow::ensure!(
            self.profile_id == hex::encode(binding.profile_hash),
            "challenge profile mismatch"
        );
        anyhow::ensure!(
            self.network_id == hex::encode(binding.network_set_hash),
            "challenge network mismatch"
        );
        anyhow::ensure!(
            self.root_commitment == hex::encode(binding.root_key_commitment),
            "challenge root mismatch"
        );
        validate_text(&self.challenge_id, "challenge id", 128)?;
        validate_text(&self.expires_at, "challenge expiry", 64)?;
        if let Some(request_id) = &self.request_id {
            validate_text(request_id, "request id", 256)?;
        }
        for pcr in [
            &self.attestation.expected_pcrs.pcr0,
            &self.attestation.expected_pcrs.pcr1,
            &self.attestation.expected_pcrs.pcr2,
        ] {
            anyhow::ensure!(
                pcr.len() == 96
                    && pcr
                        .bytes()
                        .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()),
                "challenge PCR is invalid"
            );
        }
        Ok(())
    }
}

#[derive(Serialize)]
#[serde(deny_unknown_fields)]
struct SessionRequest {
    challenge_id: String,
    attestation_document: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SessionResponse {
    sealed_session_token: SealedSessionToken,
    request_header: String,
    schema: String,
    network: String,
    vault_id: String,
    profile_id: String,
    network_id: String,
    root_commitment: String,
    owner_id: String,
    request_proof: RequestProofParameters,
    expires_at: String,
    request_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RequestProofParameters {
    schema: String,
    algorithm: String,
    timestamp_header: String,
    nonce_header: String,
    signature_header: String,
    max_clock_skew_seconds: u64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SealedSessionToken {
    algorithm: String,
    key_sha256: String,
    ciphertext_base64: String,
}

impl SessionResponse {
    fn validate(&self, binding: &VaultBinding, owner_id: &str, key_hash: &[u8; 32]) -> Result<()> {
        anyhow::ensure!(
            self.schema == WIRE_SCHEMA && self.network == TESTNET,
            "session schema mismatch"
        );
        anyhow::ensure!(
            self.request_header == SESSION_HEADER,
            "session header mismatch"
        );
        anyhow::ensure!(self.owner_id == owner_id, "session owner mismatch");
        anyhow::ensure!(
            self.request_proof.schema == REQUEST_PROOF_SCHEMA
                && self.request_proof.algorithm == REQUEST_PROOF_ALGORITHM
                && self.request_proof.timestamp_header == REQUEST_PROOF_TIMESTAMP_HEADER
                && self.request_proof.nonce_header == REQUEST_PROOF_NONCE_HEADER
                && self.request_proof.signature_header == REQUEST_PROOF_SIGNATURE_HEADER
                && (5..=120).contains(&self.request_proof.max_clock_skew_seconds),
            "session request-proof contract mismatch"
        );
        anyhow::ensure!(
            self.vault_id == hex::encode(binding.vault_id),
            "session vault mismatch"
        );
        anyhow::ensure!(
            self.profile_id == hex::encode(binding.profile_hash),
            "session profile mismatch"
        );
        anyhow::ensure!(
            self.network_id == hex::encode(binding.network_set_hash),
            "session network mismatch"
        );
        anyhow::ensure!(
            self.root_commitment == hex::encode(binding.root_key_commitment),
            "session root mismatch"
        );
        anyhow::ensure!(
            self.sealed_session_token.algorithm == "RSA-OAEP-256",
            "session algorithm is not RSA-OAEP-SHA256"
        );
        anyhow::ensure!(
            self.sealed_session_token.key_sha256 == hex::encode(key_hash),
            "session key digest mismatch"
        );
        if let Some(request_id) = &self.request_id {
            validate_text(request_id, "request id", 256)?;
        }
        validate_text(&self.expires_at, "session expiry", 64)
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct WireHead {
    schema: String,
    network: String,
    vault_id: String,
    profile_id: String,
    network_id: String,
    root_commitment: String,
    owner_id: String,
    epoch: String,
    snapshot_fence: String,
    generation: String,
    previous_snapshot_sha256: String,
    snapshot_sha256: String,
    head_fingerprint: String,
    lease_expires_at_ms: String,
    lease_expires_at: String,
    commit_id: Option<String>,
    snapshot: Option<WireSnapshot>,
    updated_at: String,
    request_id: Option<String>,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct WireSnapshot {
    bucket: String,
    key: String,
    version_id: String,
    sha256: String,
    size_bytes: usize,
}

#[derive(Serialize)]
#[serde(deny_unknown_fields)]
struct TakeoverRequest {
    owner_id: String,
    previous_owner_id: Option<String>,
    epoch: String,
    snapshot_fence: String,
    generation: String,
    snapshot_sha256: String,
    head_fingerprint: String,
}

#[derive(Serialize)]
#[serde(deny_unknown_fields)]
struct HeadBindingRequest {
    owner_id: String,
    epoch: String,
    snapshot_fence: String,
    generation: String,
    snapshot_sha256: String,
    head_fingerprint: String,
}

impl From<&AuthorityHead> for HeadBindingRequest {
    fn from(head: &AuthorityHead) -> Self {
        Self {
            owner_id: head.owner_id.clone(),
            epoch: head.epoch.to_string(),
            snapshot_fence: head.snapshot_fence.to_string(),
            generation: head.generation.to_string(),
            snapshot_sha256: hex::encode(head.snapshot_sha256),
            head_fingerprint: hex::encode(head.head_fingerprint),
        }
    }
}

#[derive(Serialize)]
#[serde(deny_unknown_fields)]
struct UploadTicketRequest {
    commit_id: String,
    owner_id: String,
    epoch: String,
    snapshot_fence: String,
    previous_snapshot_fence: String,
    generation: String,
    previous_snapshot_sha256: String,
    head_fingerprint: String,
    mutation_digest: String,
    snapshot_sha256: String,
    snapshot_size_bytes: usize,
}

#[derive(Serialize)]
#[serde(deny_unknown_fields)]
struct UploadStatusRequest {
    commit_id: String,
    owner_id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UploadStatusResponse {
    schema: String,
    commit_id: String,
    owner_id: String,
    snapshot: WireSnapshot,
    request_id: Option<String>,
}

impl UploadStatusResponse {
    fn validate(
        self,
        candidate: &CommitCandidate,
        expected: &AuthoritySnapshot,
        owner_id: &str,
    ) -> Result<String> {
        anyhow::ensure!(self.schema == WIRE_SCHEMA, "upload status schema mismatch");
        anyhow::ensure!(
            self.commit_id == candidate.commit_id,
            "upload status commit mismatch"
        );
        anyhow::ensure!(self.owner_id == owner_id, "upload status owner mismatch");
        if let Some(request_id) = &self.request_id {
            validate_text(request_id, "request id", 256)?;
        }
        let snapshot = self.snapshot.into_authority()?;
        anyhow::ensure!(
            snapshot.bucket == expected.bucket,
            "upload status bucket mismatch"
        );
        anyhow::ensure!(snapshot.key == expected.key, "upload status key mismatch");
        anyhow::ensure!(
            snapshot.sha256 == expected.sha256,
            "upload status hash mismatch"
        );
        anyhow::ensure!(
            snapshot.size_bytes == expected.size_bytes,
            "upload status size mismatch"
        );
        validate_text(&snapshot.version_id, "upload status version id", 1024)?;
        Ok(snapshot.version_id)
    }
}

impl UploadTicketRequest {
    fn from_candidate(candidate: &CommitCandidate, owner_id: &str) -> Self {
        Self {
            commit_id: candidate.commit_id.clone(),
            owner_id: owner_id.to_string(),
            epoch: candidate.previous.epoch.to_string(),
            snapshot_fence: candidate.next.position.fence.to_string(),
            previous_snapshot_fence: candidate.previous.snapshot_fence.to_string(),
            generation: candidate.next.position.generation.to_string(),
            previous_snapshot_sha256: hex::encode(candidate.previous.snapshot_sha256),
            head_fingerprint: hex::encode(candidate.previous.head_fingerprint),
            mutation_digest: hex::encode(candidate.mutation_digest),
            snapshot_sha256: hex::encode(candidate.next.digest),
            snapshot_size_bytes: candidate.envelope.len(),
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UploadTicketResponse {
    idempotent: bool,
    schema: String,
    commit_id: String,
    generation: String,
    previous_snapshot_sha256: String,
    snapshot_fence: String,
    previous_snapshot_fence: String,
    mutation_digest: String,
    snapshot: TicketSnapshot,
    upload: UploadTarget,
    request_id: Option<String>,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct TicketSnapshot {
    bucket: String,
    key: String,
    sha256: String,
    size_bytes: usize,
}

impl TicketSnapshot {
    fn into_authority(self) -> Result<AuthoritySnapshot> {
        Ok(AuthoritySnapshot {
            bucket: self.bucket,
            key: self.key,
            version_id: String::new(),
            sha256: decode_hash(&self.sha256, "ticket snapshot hash")?,
            size_bytes: self.size_bytes,
        })
    }
}

impl WireSnapshot {
    fn into_authority(self) -> Result<AuthoritySnapshot> {
        validate_text(&self.bucket, "snapshot bucket", 255)?;
        validate_text(&self.key, "snapshot key", 1024)?;
        validate_text(&self.version_id, "snapshot version id", 1024)?;
        anyhow::ensure!(self.size_bytes > 0, "snapshot size is zero");
        Ok(AuthoritySnapshot {
            bucket: self.bucket,
            key: self.key,
            version_id: self.version_id,
            sha256: decode_hash(&self.sha256, "snapshot hash")?,
            size_bytes: self.size_bytes,
        })
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UploadTarget {
    method: String,
    url: String,
    expires_at: String,
    required_headers: BTreeMap<String, String>,
}

impl UploadTicketResponse {
    fn validate(&self, candidate: &CommitCandidate) -> Result<()> {
        anyhow::ensure!(self.schema == WIRE_SCHEMA, "upload ticket schema mismatch");
        anyhow::ensure!(
            self.commit_id == candidate.commit_id,
            "upload ticket commit id mismatch"
        );
        anyhow::ensure!(
            parse_u64(&self.generation, "ticket generation")? == candidate.next.position.generation,
            "upload ticket generation mismatch"
        );
        anyhow::ensure!(
            decode_hash(&self.previous_snapshot_sha256, "ticket predecessor")?
                == candidate.previous.snapshot_sha256,
            "upload ticket predecessor mismatch"
        );
        anyhow::ensure!(
            parse_u64(&self.snapshot_fence, "ticket fence")? == candidate.next.position.fence,
            "upload ticket fence mismatch"
        );
        anyhow::ensure!(
            parse_u64(&self.previous_snapshot_fence, "ticket previous fence")?
                == candidate.previous.snapshot_fence,
            "upload ticket previous fence mismatch"
        );
        anyhow::ensure!(
            decode_hash(&self.mutation_digest, "ticket mutation")? == candidate.mutation_digest,
            "upload ticket mutation mismatch"
        );
        anyhow::ensure!(
            decode_hash(&self.snapshot.sha256, "ticket snapshot")? == candidate.next.digest,
            "upload ticket hash mismatch"
        );
        anyhow::ensure!(
            self.snapshot.size_bytes == candidate.envelope.len(),
            "upload ticket size mismatch"
        );
        anyhow::ensure!(self.upload.method == "PUT", "upload ticket method mismatch");
        validate_text(&self.snapshot.bucket, "snapshot bucket", 255)?;
        validate_text(&self.snapshot.key, "snapshot key", 1024)?;
        validate_text(&self.upload.url, "upload URL", 8192)?;
        validate_text(&self.upload.expires_at, "upload expiry", 64)?;
        if let Some(request_id) = &self.request_id {
            validate_text(request_id, "request id", 256)?;
        }
        anyhow::ensure!(
            !self.upload.required_headers.is_empty(),
            "upload ticket omitted required headers"
        );
        let _ = self.idempotent;
        Ok(())
    }
}

#[derive(Serialize)]
#[serde(deny_unknown_fields)]
struct CommitRequest {
    commit_id: String,
    owner_id: String,
    epoch: String,
    snapshot_fence: String,
    previous_snapshot_fence: String,
    generation: String,
    previous_snapshot_sha256: String,
    mutation_digest: String,
    snapshot_key: String,
    snapshot_version_id: String,
}

impl CommitRequest {
    fn from_candidate(
        candidate: &CommitCandidate,
        owner_id: &str,
        snapshot: &AuthoritySnapshot,
        version_id: &str,
    ) -> Self {
        Self {
            commit_id: candidate.commit_id.clone(),
            owner_id: owner_id.to_string(),
            epoch: candidate.previous.epoch.to_string(),
            snapshot_fence: candidate.next.position.fence.to_string(),
            previous_snapshot_fence: candidate.previous.snapshot_fence.to_string(),
            generation: candidate.next.position.generation.to_string(),
            previous_snapshot_sha256: hex::encode(candidate.previous.snapshot_sha256),
            mutation_digest: hex::encode(candidate.mutation_digest),
            snapshot_key: snapshot.key.clone(),
            snapshot_version_id: version_id.to_string(),
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CommitResponse {
    idempotent: bool,
    head: WireHead,
    receipt: WireReceipt,
    request_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct WireReceipt {
    schema: String,
    network: String,
    commit_id: String,
    vault_id: String,
    profile_id: String,
    network_id: String,
    root_commitment: String,
    owner_id: String,
    epoch: String,
    snapshot_fence: String,
    generation: String,
    previous_generation: String,
    previous_snapshot_fence: String,
    previous_snapshot_sha256: String,
    snapshot_sha256: String,
    mutation_digest: String,
    operation_digest: String,
    snapshot_bucket: String,
    snapshot_key: String,
    snapshot_version_id: String,
    snapshot_size_bytes: usize,
    lease_expires_at_ms: String,
    committed_at_ms: String,
    receipt_key_id: String,
    receipt_id: String,
    payload_base64: String,
    signature_base64: String,
    kms_key_arn: String,
    signing_algorithm: String,
}

impl CommitResponse {
    fn into_result(self, binding: &VaultBinding) -> Result<CommitResult> {
        let head = AuthorityHead::from_wire(self.head, binding)?;
        let receipt = self.receipt.into_receipt()?;
        let _ = self.idempotent;
        if let Some(request_id) = &self.request_id {
            validate_text(request_id, "request id", 256)?;
        }
        Ok(CommitResult { head, receipt })
    }
}

impl WireReceipt {
    fn into_receipt(self) -> Result<CommitReceipt> {
        anyhow::ensure!(
            self.schema == RECEIPT_SCHEMA && self.network == TESTNET,
            "receipt schema mismatch"
        );
        anyhow::ensure!(
            self.signing_algorithm == "ECDSA_SHA_256",
            "receipt algorithm mismatch"
        );
        validate_text(&self.kms_key_arn, "receipt KMS key ARN", 2048)?;
        Ok(CommitReceipt {
            network: self.network,
            vault_id: decode_hash(&self.vault_id, "receipt vault")?,
            profile_hash: decode_hash(&self.profile_id, "receipt profile")?,
            network_set_hash: decode_hash(&self.network_id, "receipt network")?,
            root_key_commitment: decode_hash(&self.root_commitment, "receipt root")?,
            commit_id: self.commit_id,
            operation_digest: decode_hash(&self.operation_digest, "receipt operation")?,
            mutation_digest: decode_hash(&self.mutation_digest, "receipt mutation")?,
            previous_generation: parse_u64(
                &self.previous_generation,
                "receipt previous generation",
            )?,
            previous_snapshot_fence: parse_u64(
                &self.previous_snapshot_fence,
                "receipt previous fence",
            )?,
            previous_snapshot_sha256: decode_hash(
                &self.previous_snapshot_sha256,
                "receipt predecessor",
            )?,
            generation: parse_u64(&self.generation, "receipt generation")?,
            snapshot_sha256: decode_hash(&self.snapshot_sha256, "receipt snapshot")?,
            epoch: parse_u64(&self.epoch, "receipt epoch")?,
            snapshot_fence: parse_u64(&self.snapshot_fence, "receipt fence")?,
            owner_id: self.owner_id,
            snapshot_bucket: self.snapshot_bucket,
            snapshot_key: self.snapshot_key,
            snapshot_version_id: self.snapshot_version_id,
            snapshot_size_bytes: self.snapshot_size_bytes,
            lease_expires_at_ms: parse_u64(&self.lease_expires_at_ms, "receipt lease expiry")?,
            committed_at_ms: parse_u64(&self.committed_at_ms, "receipt time")?,
            receipt_key_id: self.receipt_key_id,
            receipt_id: decode_hash(&self.receipt_id, "receipt id")?,
            payload: decode_canonical_base64(&self.payload_base64, "receipt payload")?,
            signature_der: decode_canonical_base64(&self.signature_base64, "receipt signature")?,
        })
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DownloadTicketResponse {
    schema: String,
    method: String,
    url: String,
    expires_at: String,
    snapshot: WireSnapshot,
    request_id: Option<String>,
}

impl DownloadTicketResponse {
    fn validate(&self, expected: &AuthoritySnapshot) -> Result<()> {
        anyhow::ensure!(
            self.schema == WIRE_SCHEMA && self.method == "GET",
            "download ticket schema mismatch"
        );
        anyhow::ensure!(
            self.snapshot.bucket == expected.bucket,
            "download bucket mismatch"
        );
        anyhow::ensure!(self.snapshot.key == expected.key, "download key mismatch");
        anyhow::ensure!(
            self.snapshot.version_id == expected.version_id,
            "download version mismatch"
        );
        anyhow::ensure!(
            decode_hash(&self.snapshot.sha256, "download snapshot")? == expected.sha256,
            "download hash mismatch"
        );
        anyhow::ensure!(
            self.snapshot.size_bytes == expected.size_bytes,
            "download size mismatch"
        );
        validate_text(&self.url, "download URL", 8192)?;
        if let Some(request_id) = &self.request_id {
            validate_text(request_id, "request id", 256)?;
        }
        validate_text(&self.expires_at, "download expiry", 64)
    }
}

#[derive(Serialize)]
#[serde(deny_unknown_fields)]
struct EmptyBody {}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ErrorResponse {
    error: ErrorDetail,
    #[serde(rename = "request_id")]
    _request_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ErrorDetail {
    code: String,
    message: String,
}

impl AuthorityHead {
    pub(crate) fn from_wire(wire: WireHead, binding: &VaultBinding) -> Result<Self> {
        anyhow::ensure!(
            wire.schema == WIRE_SCHEMA && wire.network == TESTNET,
            "HEAD schema mismatch"
        );
        anyhow::ensure!(
            wire.vault_id == hex::encode(binding.vault_id),
            "HEAD vault mismatch"
        );
        anyhow::ensure!(
            wire.profile_id == hex::encode(binding.profile_hash),
            "HEAD profile mismatch"
        );
        anyhow::ensure!(
            wire.network_id == hex::encode(binding.network_set_hash),
            "HEAD network mismatch"
        );
        anyhow::ensure!(
            wire.root_commitment == hex::encode(binding.root_key_commitment),
            "HEAD root mismatch"
        );
        let supplied_fingerprint = decode_hash(&wire.head_fingerprint, "HEAD fingerprint")?;
        anyhow::ensure!(
            supplied_fingerprint == head_fingerprint(&wire)?,
            "HEAD fingerprint does not match its canonical descriptor"
        );
        let snapshot_sha256 = decode_hash(&wire.snapshot_sha256, "HEAD snapshot")?;
        let snapshot = wire
            .snapshot
            .map(|snapshot| {
                Ok::<_, anyhow::Error>(AuthoritySnapshot {
                    bucket: snapshot.bucket,
                    key: snapshot.key,
                    version_id: snapshot.version_id,
                    sha256: decode_hash(&snapshot.sha256, "HEAD object hash")?,
                    size_bytes: snapshot.size_bytes,
                })
            })
            .transpose()?;
        let head = Self {
            binding: binding.clone(),
            generation: parse_u64(&wire.generation, "HEAD generation")?,
            snapshot_fence: parse_u64(&wire.snapshot_fence, "HEAD snapshot fence")?,
            previous_snapshot_sha256: decode_hash(
                &wire.previous_snapshot_sha256,
                "HEAD predecessor",
            )?,
            snapshot_sha256,
            epoch: parse_u64(&wire.epoch, "HEAD epoch")?,
            owner_id: wire.owner_id,
            head_fingerprint: supplied_fingerprint,
            lease_expires_at_ms: parse_u64(&wire.lease_expires_at_ms, "HEAD lease expiry")?,
            commit_id: wire.commit_id,
            snapshot,
            updated_at: wire.updated_at,
        };
        validate_text(&wire.lease_expires_at, "HEAD lease time", 64)?;
        if let Some(request_id) = &wire.request_id {
            validate_text(request_id, "request id", 256)?;
        }
        head.validate()?;
        Ok(head)
    }
}

fn head_fingerprint(head: &WireHead) -> Result<[u8; 32]> {
    let mut descriptor = BTreeMap::<String, serde_json::Value>::new();
    descriptor.insert("schema".into(), HEAD_SCHEMA.into());
    descriptor.insert("network".into(), head.network.clone().into());
    descriptor.insert("vault_id".into(), head.vault_id.clone().into());
    descriptor.insert("profile_id".into(), head.profile_id.clone().into());
    descriptor.insert("network_id".into(), head.network_id.clone().into());
    descriptor.insert(
        "root_commitment".into(),
        head.root_commitment.clone().into(),
    );
    descriptor.insert("owner_id".into(), head.owner_id.clone().into());
    descriptor.insert("epoch".into(), head.epoch.clone().into());
    descriptor.insert("snapshot_fence".into(), head.snapshot_fence.clone().into());
    descriptor.insert("generation".into(), head.generation.clone().into());
    descriptor.insert(
        "previous_snapshot_sha256".into(),
        head.previous_snapshot_sha256.clone().into(),
    );
    descriptor.insert(
        "snapshot_sha256".into(),
        head.snapshot_sha256.clone().into(),
    );
    descriptor.insert(
        "lease_expires_at_ms".into(),
        head.lease_expires_at_ms.clone().into(),
    );
    descriptor.insert(
        "commit_id".into(),
        head.commit_id
            .clone()
            .map(serde_json::Value::String)
            .unwrap_or(serde_json::Value::Null),
    );
    for (name, value) in [
        (
            "snapshot_bucket",
            head.snapshot.as_ref().map(|value| value.bucket.clone()),
        ),
        (
            "snapshot_key",
            head.snapshot.as_ref().map(|value| value.key.clone()),
        ),
        (
            "snapshot_version_id",
            head.snapshot.as_ref().map(|value| value.version_id.clone()),
        ),
    ] {
        descriptor.insert(
            name.into(),
            value
                .map(serde_json::Value::String)
                .unwrap_or(serde_json::Value::Null),
        );
    }
    descriptor.insert(
        "snapshot_size_bytes".into(),
        head.snapshot
            .as_ref()
            .map(|value| serde_json::Value::from(value.size_bytes))
            .unwrap_or(serde_json::Value::Null),
    );
    descriptor.insert("updated_at".into(), head.updated_at.clone().into());
    Ok(Sha256::digest(serde_json::to_vec(&descriptor)?).into())
}

#[cfg(test)]
#[path = "../tests/unit/coordinator.rs"]
mod tests;
