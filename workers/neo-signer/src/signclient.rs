//! Official Neo `SignClient` gRPC compatibility bridge.
//!
//! The upstream protocol has no authentication field and its stock client does
//! not send credentials.  Consequently this adapter is intentionally one
//! configured NeoOS caller plus one configured custody key, and the process
//! configuration only permits it on loopback.  Every operation still enters
//! [`SignerService`]: caller grants, key state, policy, audit, idempotency and
//! durable anti-equivocation remain the authority.
//!
//! `tonic::Status` is the SignClient wire error. Boxing it would change the
//! generated gRPC trait; clippy `result_large_err` is allowed on this module.

#![allow(clippy::result_large_err)]

use std::{future::Future, net::SocketAddr};

use sha2::{Digest, Sha256};
use tokio::sync::OwnedSemaphorePermit;
use tonic::{transport::Server, Request, Response, Status};

use crate::{
    api::ApiState,
    audit::{self, Refusal},
    auth::CallerCredentials,
    crypto,
    model::{SignerAuditAction, SignerAuditOutcome},
    neo_block::{NeoBlock, NeoBlockHeader},
    network::ChainFamily,
    service::{KeyPublicInfo, Outcome, SignedWitness, SignerService},
};

pub mod proto {
    pub mod signpb {
        #![allow(clippy::result_large_err)]
        tonic::include_proto!("signpb");
    }

    pub mod servicepb {
        #![allow(clippy::result_large_err)]
        tonic::include_proto!("servicepb");
    }
}

use proto::{
    servicepb::{
        secure_sign_server::{SecureSign, SecureSignServer},
        GetAccountStatusRequest, GetAccountStatusResponse, SignBlockRequest, SignBlockResponse,
        SignExtensiblePayloadRequest, SignExtensiblePayloadResponse,
    },
    signpb::{AccountContract, AccountSign, AccountSigns, AccountStatus, ExtensiblePayload},
};

/// The official messages are small (a trimmed block carries hashes, not full
/// transactions). Keep their allocation ceiling aligned with the HTTP custody
/// body's default rather than accepting tonic's much larger generic default.
const MAX_MESSAGE_BYTES: usize = 256 * 1024;
const MAX_CATEGORY_BYTES: usize = 32;
const MAX_PAYLOAD_BYTES: usize = u16::MAX as usize;

/// One unauthenticated-on-the-wire SignClient endpoint, internally pinned to a
/// real NeoOS caller and one granted key. Deliberately not `Debug`: credentials
/// contain the bearer token supplied at process start.
#[derive(Clone)]
pub struct SignClientBridge {
    state: ApiState,
    key_id: String,
    credentials: CallerCredentials,
}

impl SignClientBridge {
    pub fn new(state: ApiState, key_id: impl Into<String>, caller_token: &str) -> Self {
        Self {
            state,
            key_id: key_id.into(),
            credentials: CallerCredentials::server_to_server(caller_token),
        }
    }

    async fn run<T, F>(&self, action: SignerAuditAction, call: F) -> Result<T, Status>
    where
        T: Send + 'static,
        F: FnOnce(SignerService, CallerCredentials, String) -> anyhow::Result<Outcome<T>>
            + Send
            + 'static,
    {
        let service = self
            .state
            .service_snapshot()
            .ok_or_else(|| Status::unavailable("the signer vault is not provisioned"))?;
        let permit = self
            .state
            .try_blocking_slot()
            .ok_or_else(|| Status::resource_exhausted("the signer is busy"))?;
        let credentials = self.credentials.clone();
        let key_id = self.key_id.clone();
        let outcome = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            let called_service = service.clone();
            let operation_key_id = key_id.clone();
            service.execute_observable(action, Some(&operation_key_id), move || {
                call(called_service, credentials, key_id)
            })
        })
        .await
        .map_err(|_| Status::internal("the signer operation did not complete"))?
        .map_err(|_| Status::internal("the signer could not complete the operation"))?;
        match outcome {
            Outcome::Allowed(value) => Ok(value),
            Outcome::Refused(refusal) => Err(refusal_status(refusal)),
        }
    }

    /// Execute metadata lookup and signing under one observable durability
    /// barrier. `key_info` still records its audit row, but no intermediate
    /// remote commit can split one SignClient RPC into two durable operations.
    async fn run_with_info<T, F>(&self, action: SignerAuditAction, call: F) -> Result<T, Status>
    where
        T: Send + 'static,
        F: FnOnce(
                SignerService,
                CallerCredentials,
                String,
                KeyPublicInfo,
            ) -> anyhow::Result<Outcome<Result<T, Status>>>
            + Send
            + 'static,
    {
        let service = self
            .state
            .service_snapshot()
            .ok_or_else(|| Status::unavailable("the signer vault is not provisioned"))?;
        let permit = self
            .state
            .try_blocking_slot()
            .ok_or_else(|| Status::resource_exhausted("the signer is busy"))?;
        let credentials = self.credentials.clone();
        let key_id = self.key_id.clone();
        let outcome =
            tokio::task::spawn_blocking(move || {
                let _permit = permit;
                let called_service = service.clone();
                let operation_key_id = key_id.clone();
                service.execute_observable(action, Some(&operation_key_id), move || {
                    match called_service.key_info(&credentials, &key_id)? {
                        Outcome::Allowed(info) => call(called_service, credentials, key_id, info),
                        Outcome::Refused(refusal) => Ok(Outcome::Refused(refusal)),
                    }
                })
            })
            .await
            .map_err(|_| Status::internal("the signer operation did not complete"))?
            .map_err(|_| Status::internal("the signer could not complete the operation"))?;
        match outcome {
            Outcome::Allowed(result) => result,
            Outcome::Refused(refusal) => Err(refusal_status(refusal)),
        }
    }

    fn admit(&self) -> Option<OwnedSemaphorePermit> {
        self.state.try_request_slot()
    }

    async fn key_info(&self) -> Result<KeyPublicInfo, Status> {
        self.run(
            SignerAuditAction::KeyViewed,
            |service, credentials, key_id| service.key_info(&credentials, &key_id),
        )
        .await
    }

    /// Fail a host-mode boot early when the configured token, key grant, or
    /// chain family cannot serve SignClient. Attested boot calls cannot run
    /// until `/provision`; those fail closed on the first RPC instead.
    pub async fn preflight(&self) -> Result<(), Status> {
        let info = self.key_info().await?;
        require_neo_key(&info).map_err(Status::failed_precondition)
    }
}

#[tonic::async_trait]
impl SecureSign for SignClientBridge {
    async fn sign_extensible_payload(
        &self,
        request: Request<SignExtensiblePayloadRequest>,
    ) -> Result<Response<SignExtensiblePayloadResponse>, Status> {
        let _request_permit = self
            .admit()
            .ok_or_else(|| Status::resource_exhausted("the signer is busy"))?;
        let request = request.into_inner();
        let payload = request
            .payload
            .ok_or_else(|| Status::invalid_argument("payload is required"))?;
        let unsigned = extensible_unsigned(&payload).map_err(Status::invalid_argument)?;
        let script_hashes = fixed_hashes::<20>(&request.script_hashes, "script hash")
            .map_err(Status::invalid_argument)?;
        let network = request.network;
        let response = self
            .run_with_info(
                SignerAuditAction::ConsensusSigned,
                move |service, credentials, key_id, info| {
                    if let Err(message) = require_neo_key(&info) {
                        return Ok(Outcome::Allowed(Err(Status::failed_precondition(message))));
                    }
                    if network != info.network_magic {
                        return Ok(Outcome::Allowed(Err(Status::failed_precondition(
                            "the requested network does not match the configured custody key",
                        ))));
                    }
                    let account = info.script_hash.as_bytes();
                    if !script_hashes.contains(&account) || !info.signing_enabled {
                        let signs = script_hashes
                            .iter()
                            .map(|hash| unavailable_account(*hash == account, info.signing_enabled))
                            .collect();
                        return Ok(Outcome::Allowed(Ok(SignExtensiblePayloadResponse {
                            signs,
                        })));
                    }
                    let request_id = deterministic_request_id(
                        "extensible-v1",
                        network,
                        &info.public_key,
                        &unsigned,
                    );
                    service
                        .sign_consensus_for_network_with_request_id(
                            &credentials,
                            &key_id,
                            &unsigned,
                            network,
                            Some(&request_id),
                        )
                        .map(|outcome| {
                            outcome.map(|witness| {
                                witness_signature(&witness)
                                    .map(|signature| {
                                        let signs = script_hashes
                                            .iter()
                                            .map(|hash| {
                                                if *hash == account {
                                                    available_account(&info, &signature)
                                                } else {
                                                    unavailable_account(false, true)
                                                }
                                            })
                                            .collect();
                                        SignExtensiblePayloadResponse { signs }
                                    })
                                    .map_err(Status::internal)
                            })
                        })
                },
            )
            .await?;
        Ok(Response::new(response))
    }

    async fn sign_block(
        &self,
        request: Request<SignBlockRequest>,
    ) -> Result<Response<SignBlockResponse>, Status> {
        let _request_permit = self
            .admit()
            .ok_or_else(|| Status::resource_exhausted("the signer is busy"))?;
        let request = request.into_inner();
        let public_key = crypto::compress_public_key(&request.public_key)
            .ok_or_else(|| Status::invalid_argument("public_key is not valid P-256 SEC1 data"))?;
        let block = validated_block(
            request
                .block
                .ok_or_else(|| Status::invalid_argument("block is required"))?,
        )
        .map_err(Status::invalid_argument)?;
        let network = request.network;
        let response = self
            .run_with_info(
                SignerAuditAction::ConsensusSigned,
                move |service, credentials, key_id, info| {
                    if let Err(message) = require_neo_key(&info) {
                        return Ok(Outcome::Allowed(Err(Status::failed_precondition(message))));
                    }
                    if public_key != info.public_key {
                        return Ok(Outcome::Allowed(Err(Status::not_found(
                            "the requested public key is not the configured account",
                        ))));
                    }
                    if network != info.network_magic {
                        return Ok(Outcome::Allowed(Err(Status::failed_precondition(
                            "the requested network does not match the configured custody key",
                        ))));
                    }
                    if !info.signing_enabled {
                        return Ok(Outcome::Allowed(Err(Status::failed_precondition(
                            "the configured account is locked",
                        ))));
                    }
                    let request_id = deterministic_request_id(
                        "block-v1",
                        network,
                        &public_key,
                        block.unsigned(),
                    );
                    service
                        .sign_block_with_request_id(
                            &credentials,
                            &key_id,
                            &block,
                            network,
                            public_key,
                            Some(&request_id),
                        )
                        .map(|outcome| {
                            outcome.map(|witness| {
                                witness_signature(&witness)
                                    .map(|signature| SignBlockResponse { signature })
                                    .map_err(Status::internal)
                            })
                        })
                },
            )
            .await?;
        Ok(Response::new(response))
    }

    async fn get_account_status(
        &self,
        request: Request<GetAccountStatusRequest>,
    ) -> Result<Response<GetAccountStatusResponse>, Status> {
        let _request_permit = self
            .admit()
            .ok_or_else(|| Status::resource_exhausted("the signer is busy"))?;
        let requested = crypto::compress_public_key(&request.into_inner().public_key)
            .ok_or_else(|| Status::invalid_argument("public_key is not valid P-256 SEC1 data"))?;
        let info = self.key_info().await?;
        require_neo_key(&info).map_err(Status::failed_precondition)?;
        let status = if requested != info.public_key {
            AccountStatus::NoSuchAccount
        } else if !info.signing_enabled {
            AccountStatus::Locked
        } else {
            AccountStatus::Single
        };
        Ok(Response::new(GetAccountStatusResponse {
            status: status as i32,
        }))
    }
}

/// Serve the exact official SignClient service on a prevalidated loopback
/// address. Bind policy belongs to process configuration; this function owns
/// only the protocol server and graceful drain.
pub async fn serve(
    bind: SocketAddr,
    bridge: SignClientBridge,
    shutdown: impl Future<Output = ()> + Send + 'static,
) -> anyhow::Result<()> {
    let service = SecureSignServer::new(bridge)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES);
    Server::builder()
        .add_service(service)
        .serve_with_shutdown(bind, shutdown)
        .await
        .map_err(Into::into)
}

fn require_neo_key(info: &KeyPublicInfo) -> Result<(), &'static str> {
    if info.chain_family == ChainFamily::NeoN3 {
        Ok(())
    } else {
        Err("the configured SignClient key is not a Neo N3 key")
    }
}

fn refusal_status(refusal: Refusal) -> Status {
    let message = format!("{}: {}", refusal.code, refusal.message);
    if matches!(
        refusal.code,
        "signer-payload-unparsable" | "signer-block-unparsable" | "signer-block-index-mismatch"
    ) || refusal.code == audit::REQUEST_ID_INVALID
    {
        return Status::invalid_argument(message);
    }
    if refusal.code == audit::REQUEST_ID_CONFLICT {
        return Status::already_exists(message);
    }
    if refusal.code == "signer-key-unknown" {
        return Status::not_found(message);
    }
    match refusal.outcome {
        SignerAuditOutcome::Denied => Status::permission_denied(message),
        // The official plugin retries Internal. Infrastructure failures should
        // use that path; caller-shape failures were separated above.
        SignerAuditOutcome::Failed => Status::internal(message),
        SignerAuditOutcome::Allowed => Status::internal("invalid signer refusal state"),
    }
}

fn extensible_unsigned(payload: &ExtensiblePayload) -> Result<Vec<u8>, &'static str> {
    if payload.category.len() > MAX_CATEGORY_BYTES {
        return Err("category is longer than 32 bytes");
    }
    let sender: [u8; 20] = payload
        .sender
        .as_slice()
        .try_into()
        .map_err(|_| "sender must be 20 bytes")?;
    if payload.data.len() > MAX_PAYLOAD_BYTES {
        return Err("payload data is longer than 65535 bytes");
    }
    let mut unsigned = Vec::with_capacity(payload.category.len() + payload.data.len() + 32);
    encode_var_bytes(&mut unsigned, payload.category.as_bytes());
    unsigned.extend_from_slice(&payload.valid_block_start.to_le_bytes());
    unsigned.extend_from_slice(&payload.valid_block_end.to_le_bytes());
    unsigned.extend_from_slice(&sender);
    encode_var_bytes(&mut unsigned, &payload.data);
    Ok(unsigned)
}

fn encode_var_bytes(target: &mut Vec<u8>, bytes: &[u8]) {
    let length = bytes.len() as u64;
    match length {
        0..=0xfc => target.push(length as u8),
        0xfd..=0xffff => {
            target.push(0xfd);
            target.extend_from_slice(&(length as u16).to_le_bytes());
        }
        0x1_0000..=0xffff_ffff => {
            target.push(0xfe);
            target.extend_from_slice(&(length as u32).to_le_bytes());
        }
        _ => {
            target.push(0xff);
            target.extend_from_slice(&length.to_le_bytes());
        }
    }
    target.extend_from_slice(bytes);
}

fn fixed_hashes<const N: usize>(
    values: &[Vec<u8>],
    name: &'static str,
) -> Result<Vec<[u8; N]>, String> {
    values
        .iter()
        .map(|value| {
            value
                .as_slice()
                .try_into()
                .map_err(|_| format!("each {name} must be {N} bytes"))
        })
        .collect()
}

fn validated_block(block: proto::signpb::TrimmedBlock) -> Result<NeoBlock, String> {
    let header = block
        .header
        .ok_or_else(|| "block header is required".to_string())?;
    let prev_hash = fixed::<32>(&header.prev_hash, "prev_hash")?;
    let merkle_root = fixed::<32>(&header.merkle_root, "merkle_root")?;
    let next_consensus = fixed::<20>(&header.next_consensus, "next_consensus")?;
    let prev_state_root = if header.prev_state_root.is_empty() {
        None
    } else {
        Some(fixed::<32>(&header.prev_state_root, "prev_state_root")?)
    };
    let tx_hashes = fixed_hashes::<32>(&block.tx_hashes, "transaction hash")?;
    let header = NeoBlockHeader::from_wire_with_state_root(
        header.version,
        prev_hash,
        merkle_root,
        header.timestamp,
        header.nonce,
        header.index,
        header.primary_index,
        next_consensus,
        prev_state_root,
        header.state_root_enabled,
    )
    .map_err(|error| error.to_string())?;
    NeoBlock::new(header, tx_hashes).map_err(|error| error.to_string())
}

fn fixed<const N: usize>(value: &[u8], name: &'static str) -> Result<[u8; N], String> {
    value
        .try_into()
        .map_err(|_| format!("{name} must be {N} bytes"))
}

fn unavailable_account(matching: bool, enabled: bool) -> AccountSigns {
    let status = if matching && !enabled {
        AccountStatus::Locked
    } else {
        AccountStatus::NoSuchAccount
    };
    AccountSigns {
        signs: Vec::new(),
        contract: None,
        status: status as i32,
    }
}

fn available_account(info: &KeyPublicInfo, signature: &[u8]) -> AccountSigns {
    AccountSigns {
        signs: vec![AccountSign {
            signature: signature.to_vec(),
            public_key: info.public_key.to_vec(),
        }],
        contract: Some(AccountContract {
            script: info.verification_script.clone(),
            // Neo VM ContractParameterType.Signature is zero.
            parameters: vec![0],
            deployed: false,
        }),
        status: AccountStatus::Single as i32,
    }
}

fn witness_signature(witness: &SignedWitness) -> Result<Vec<u8>, &'static str> {
    if witness.invocation.len() != 66 || witness.invocation[..2] != [0x0c, 0x40] {
        return Err("the signer produced an invalid single-signature invocation");
    }
    Ok(witness.invocation[2..].to_vec())
}

fn deterministic_request_id(
    domain: &str,
    network: u32,
    public_key: &[u8; 33],
    unsigned: &[u8],
) -> String {
    let mut framed = Vec::with_capacity(domain.len() + unsigned.len() + 40);
    framed.extend_from_slice(b"neoos-signclient\0");
    framed.extend_from_slice(domain.as_bytes());
    framed.push(0);
    framed.extend_from_slice(&network.to_le_bytes());
    framed.extend_from_slice(public_key);
    framed.extend_from_slice(unsigned);
    format!("grpc-{domain}-{}", hex::encode(Sha256::digest(framed)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        model::{CallerCapability, KeyGrant, SignerPolicy},
        network::Network,
        service::provision_admin_caller,
        store::Store,
        tx::ConsensusPayload,
        vault::MasterKey,
    };

    fn allowed<T>(outcome: Outcome<T>) -> T {
        match outcome {
            Outcome::Allowed(value) => value,
            Outcome::Refused(refusal) => panic!("unexpected refusal: {}", refusal.code),
        }
    }

    #[test]
    fn official_extensible_fields_encode_as_neo_serialize_unsigned() {
        let payload = ExtensiblePayload {
            category: "dBFT".to_string(),
            valid_block_start: 0,
            valid_block_end: 17,
            sender: vec![3; 20],
            data: vec![0x40, 17, 0, 0, 0, 1, 2, 9, 8, 7, 6, 5, 4, 3, 2],
        };
        let bytes = extensible_unsigned(&payload).unwrap();
        let decoded = ConsensusPayload::parse(&bytes).unwrap();
        assert_eq!(decoded.category, payload.category);
        assert_eq!(decoded.valid_block_end, 17);
        assert_eq!(decoded.sender, [3; 20]);
        assert_eq!(decoded.data, payload.data);
    }

    #[test]
    fn deterministic_ids_are_domain_network_and_content_bound() {
        let key = [2; 33];
        let first = deterministic_request_id("block-v1", 1, &key, b"header-a");
        assert_eq!(
            first,
            deterministic_request_id("block-v1", 1, &key, b"header-a")
        );
        assert_ne!(
            first,
            deterministic_request_id("block-v1", 2, &key, b"header-a")
        );
        assert_ne!(
            first,
            deterministic_request_id("extensible-v1", 1, &key, b"header-a")
        );
        assert_ne!(
            first,
            deterministic_request_id("block-v1", 1, &key, b"header-b")
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn official_rpc_shapes_reach_the_guarded_service_and_replay_idempotently(
    ) -> anyhow::Result<()> {
        let directory = tempfile::tempdir()?;
        let store = Store::open(directory.path().join("signer.db"))?;
        let service = SignerService::new(store, MasterKey::from_bytes([41; 32]));
        let (_, admin_token) = provision_admin_caller(service.repository(), "bootstrap")?;
        let admin = CallerCredentials::server_to_server(&admin_token);
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
        let bridge =
            SignClientBridge::new(ApiState::new(service.clone()), &key.key_id, &caller_token);

        let status = bridge
            .get_account_status(Request::new(GetAccountStatusRequest {
                public_key: key.public_key.to_vec(),
            }))
            .await?
            .into_inner();
        assert_eq!(status.status, AccountStatus::Single as i32);
        let uncompressed = p256::ecdsa::VerifyingKey::from_sec1_bytes(&key.public_key)
            .expect("custody stores a valid P-256 key")
            .to_sec1_point(false);
        let status = bridge
            .get_account_status(Request::new(GetAccountStatusRequest {
                public_key: uncompressed.as_bytes().to_vec(),
            }))
            .await?
            .into_inner();
        assert_eq!(status.status, AccountStatus::Single as i32);

        let mut dbft = vec![0x40];
        dbft.extend_from_slice(&17u32.to_le_bytes());
        dbft.extend_from_slice(&[0, 0]);
        dbft.extend_from_slice(&9u64.to_le_bytes());
        let request = SignExtensiblePayloadRequest {
            payload: Some(ExtensiblePayload {
                category: "dBFT".to_string(),
                valid_block_start: 0,
                valid_block_end: 17,
                sender: key.script_hash.as_bytes().to_vec(),
                data: dbft,
            }),
            script_hashes: vec![key.script_hash.as_bytes().to_vec(), vec![9; 20]],
            network: key.network_magic,
        };
        let first = bridge
            .sign_extensible_payload(Request::new(request.clone()))
            .await?
            .into_inner();
        let replay = bridge
            .sign_extensible_payload(Request::new(request))
            .await?
            .into_inner();
        assert_eq!(first, replay);
        assert_eq!(first.signs.len(), 2);
        assert_eq!(first.signs[0].status, AccountStatus::Single as i32);
        assert_eq!(first.signs[0].signs[0].signature.len(), 64);
        assert_eq!(first.signs[1].status, AccountStatus::NoSuchAccount as i32);
        assert_eq!(
            service
                .repository()
                .signer_signature_count(&key.key_id, 0)?,
            1,
            "the official client's retry consumes one durable signature decision"
        );

        let block_request = SignBlockRequest {
            block: Some(proto::signpb::TrimmedBlock {
                header: Some(proto::signpb::BlockHeader {
                    version: 0,
                    prev_hash: vec![1; 32],
                    merkle_root: vec![0; 32],
                    timestamp: 1_700_000_000_000,
                    nonce: 1,
                    index: 18,
                    primary_index: 0,
                    next_consensus: vec![2; 20],
                    prev_state_root: Vec::new(),
                    state_root_enabled: false,
                }),
                tx_hashes: Vec::new(),
            }),
            public_key: key.public_key.to_vec(),
            network: key.network_magic,
        };
        let signature = bridge
            .sign_block(Request::new(block_request.clone()))
            .await?
            .into_inner()
            .signature;
        assert_eq!(signature.len(), 64);
        assert_eq!(
            bridge
                .sign_block(Request::new(block_request.clone()))
                .await?
                .into_inner()
                .signature,
            signature
        );

        let mut rooted = block_request.clone();
        let rooted_header = rooted
            .block
            .as_mut()
            .and_then(|block| block.header.as_mut())
            .expect("the test block has a header");
        rooted_header.index = 19;
        rooted_header.prev_state_root = vec![4; 32];
        rooted_header.state_root_enabled = true;
        assert_eq!(
            bridge
                .sign_block(Request::new(rooted))
                .await?
                .into_inner()
                .signature
                .len(),
            64,
            "the known state-root extension must be signed, not discarded"
        );

        let mut conflict = block_request;
        conflict
            .block
            .as_mut()
            .and_then(|block| block.header.as_mut())
            .expect("the test block has a header")
            .prev_hash = vec![3; 32];
        let error = bridge
            .sign_block(Request::new(conflict))
            .await
            .expect_err("a second header at the same height must be refused");
        assert_eq!(error.code(), tonic::Code::PermissionDenied);
        assert!(error.message().contains("consensus-equivocation"));
        Ok(())
    }
}
