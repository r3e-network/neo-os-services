//! The HTTP surface: `docs/SIGNER_SERVICE.md` §5 and §5.1 as axum handlers.
//!
//! This module decides nothing. Every answer it sends — every signature, every
//! `no`, every "this caller may not ask" — comes back from [`SignerService`], and
//! the only judgement made here is *shape*: which bytes are the request, what
//! status the answer deserves, and which fields may cross the boundary. That
//! asymmetry is the reason a new route cannot forget an authorization check,
//! because there is no check to forget: the guard lives in the service method the
//! route calls, and a route that skipped it would have to call a different
//! method. The one exception is the body decoder, described below.
//!
//! ## Ordering, and the two codes it produces
//!
//! A request is read in three steps: headers → body → service. The body is
//! decoded *before* the caller is authenticated because authentication lives
//! inside the service method ([`SignerService::sign_transaction`] and friends
//! each run their guard first), and running the guard twice would write two
//! audit rows for one request. That ordering is only safe because of what the
//! decoder is allowed to say:
//!
//! * `signer-request-unreadable` (`400`) and `signer-unsigned-hex-unreadable`
//!   (`400`) can be answered to anyone. Both describe the *caller's own input* —
//!   "that is not JSON", "that is not hexadecimal", "that field is not a script
//!   hash" — and neither has read a row, consulted a policy, or learned anything
//!   about the vault. An unauthenticated caller cannot use them to distinguish
//!   one key from another, because it cannot reach a code that does.
//! * [`audit::ADMIN_REQUEST_INVALID`] — the single code whose message is allowed
//!   to be specific — is produced only by [`SignerService`], only after
//!   `guard_admin` has passed. The decoder never emits it. That is what keeps the
//!   §5.1 promise true on the wire rather than only in the library.
//!
//! The same reasoning covers [`Credentials`], which cannot fail: a request with
//! no `Authorization` header is not a malformed request, it is a request the
//! service must answer `missing-token` *and record*. An extractor that rejected
//! it at the transport would produce a denial nobody logged.
//!
//! ## What never leaves
//!
//! A [`Refusal`] is serialized as `allowed`, `code` and `message` only. Its
//! `detail` — the bounded string with the amounts and hashes that make a refusal
//! actionable — goes to the audit row and stops there, so no response to a
//! denial can be a way to read the vault's specifics. The audit *list* route is
//! the one place `detail` is served, and that is not a hole in the rule but the
//! rule's other half: the route needs `admin` plus a whole-vault grant, which is
//! the same authority that already lets the caller read every key and boundary in
//! the vault (§5).
//!
//! ## No logging
//!
//! There is no logging middleware here, and the binary installs no tracing
//! subscriber — deliberately, per §5.1. A request line is the one place a caller
//! token could be reproduced by accident, and this service's answer to a
//! credential being used wrong is an audit row, which by construction names the
//! caller by id and never by token. What the transport *does* record is a
//! `500`: an infrastructure failure has nowhere else to be written, because the
//! service's own recording is the thing that failed. See `failed`.

use std::{
    convert::Infallible,
    str::FromStr,
    sync::{Arc, RwLock},
};

use anyhow::Result;
use axum::{
    body::to_bytes,
    extract::{FromRequest, FromRequestParts, OriginalUri, Path, Request, State},
    http::{header, request::Parts, StatusCode, Uri},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::json;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use zeroize::Zeroize;

use crate::{
    attested_identity::{self, KeyBoundary},
    audit::{self, Refusal},
    auth::{CallerCredentials, WorkloadAuthPolicy, WorkloadRequestHeaders},
    model::{
        AssetLimit, CallerCapability, ContractMethod, KeyGrant, ScriptHash, SignatureRateLimit,
        SignerAuditAction, SignerAuditOutcome, SignerAuditRecord, SignerPolicy, WindowLimit,
    },
    neo_block::{NeoBlock, NeoBlockHeader},
    network::{ChainFamily, Network},
    provision::{self, ProvisionBody, ProvisionEnv, ProvisionGate},
    service::{
        CallerInfo, Eip191FulfillmentRequest, KeyPublicInfo, Outcome, SignedEip191Fulfillment,
        SignedWitness, SignerService, WorkloadCallerSpec,
    },
};

use nitro_attest::release::{AttestationSource, NsmAttestation};

/// Prefix every endpoint shares. Named once because a route registered outside
/// it would be a route the fallback answers, and a caller would get `404` for a
/// path the documentation says exists.
const API_PREFIX: &str = "/signer/api/v1";
const WORKLOAD_CALLER_HEADER: &str = "x-neoos-caller";
const WORKLOAD_TIMESTAMP_HEADER: &str = "x-neoos-timestamp";
const WORKLOAD_NONCE_HEADER: &str = "x-neoos-nonce";
const WORKLOAD_SIGNATURE_HEADER: &str = "x-neoos-signature";
const WORKLOAD_PROTOCOL_HEADER: &str = "x-neoos-workload-protocol";
const WORKLOAD_AUDIENCE_HEADER: &str = "x-neoos-audience";
const DEFAULT_WORKLOAD_AUDIENCE: &str = "http://127.0.0.1:8081";

/// Longest request body the transport reads.
///
/// Sized from the chain, not from a round number: a Neo N3 transaction is capped
/// at 100 KB, and `unsigned_hex` doubles whatever it holds, so 256 KB covers the
/// largest legal transaction with room for the JSON around it. A body this large
/// is refused before it is buffered rather than after, so the ceiling is about
/// the memory the process agrees to spend, not just the response it eventually
/// sends.
pub const DEFAULT_BODY_LIMIT: usize = 256 * 1024;

/// Maximum custody requests admitted past the router at once.
///
/// The permit is taken before a request body is read and is held until its
/// handler returns. This caps both buffered request bodies (at roughly 8 MiB
/// under the default body ceiling) and the SQLite/cryptographic work submitted
/// to Tokio's blocking pool. Requests are shed rather than queued so a caller
/// cannot turn the queue itself into unbounded memory. Health and metrics are
/// deliberately outside this boundary so operators can observe saturation.
pub const DEFAULT_MAX_IN_FLIGHT_REQUESTS: usize = 32;

/// Audit rows a single `GET /audit` returns when it asks for no number.
const AUDIT_LIMIT_DEFAULT: usize = 100;

/// Most audit rows one request may ask for. The list is the console's page, and
/// an unbounded `limit` is a way to ask a custody service to serialize its whole
/// history into one response.
const AUDIT_LIMIT_MAX: usize = 500;

/// A body that could not be turned into a call: not JSON, missing a field the
/// contract requires, or a field whose own text does not parse. `400`.
const REQUEST_UNREADABLE: &str = "signer-request-unreadable";

/// A body larger than [`DEFAULT_BODY_LIMIT`]. `413`, and the only status outside
/// §5's four because it is a transport answer, not a decision about an intent.
const REQUEST_TOO_LARGE: &str = "signer-request-too-large";

/// The process-wide custody request budget is occupied. `503` with a short
/// `Retry-After`; no live count is exposed to an unauthenticated caller.
const SERVICE_BUSY: &str = "signer-service-busy";

/// A deliberately small, fixed retry hint. The router has no information about
/// how long the in-flight cryptographic or durable-write operations will take.
const BUSY_RETRY_AFTER_SECONDS: &str = "1";

/// `unsigned_hex` was not hexadecimal. Its own code rather than
/// [`REQUEST_UNREADABLE`] because §5 names it, and naming it is right: it is the
/// one thing a signing caller gets wrong most often, and the branch point is
/// worth having.
const UNSIGNED_HEX_UNREADABLE: &str = "signer-unsigned-hex-unreadable";

/// The service could not answer at all — the store refused a read, a write, the
/// clock. `500`, and the message is fixed because the specifics go to the audit
/// row: an operator has to be able to find out *which* read failed, and the
/// error's own text names database paths no caller needs.
const SERVICE_FAILED: &str = "signer-service-failed";

/// Nothing is registered at this path. `404` in the refusal shape rather than
/// the framework's empty body, so a client parsing a response from this service
/// never has to guess whether it is talking JSON.
const ROUTE_UNKNOWN: &str = "signer-route-unknown";

/// A custody call arrived while the vault is still sealed — attested boot
/// before a successful `/provision`. `503`, and no audit row: the vault the
/// audit trail lives in is not open yet.
const NOT_PROVISIONED: &str = "signer-not-provisioned";

/// The `network` a body may name, spelled out because the accepted set is
/// [`Network`]'s and a message that drifts from it is a lie about the contract.
const NETWORK_PROBLEM: &str = "network must be mainnet, testnet or private";

/// The service, the body ceiling, and — in the enclave deployment — the
/// provisioning gate.
///
/// The vault is behind an `Arc<RwLock<…>>` for one reason: in attested boot
/// mode the process starts with the master key *not* released, and `/provision`
/// moves the state from sealed to open in place. Host mode constructs the state
/// already provisioned and the lock never changes again.
#[derive(Clone)]
pub struct ApiState {
    inner: Arc<Inner>,
    workload_auth: WorkloadAuthPolicy,
    max_body_bytes: usize,
    request_slots: Arc<Semaphore>,
    blocking_slots: Arc<Semaphore>,
}

struct Inner {
    vault: RwLock<Vault>,
    attested_boot: bool,
    // Dropped after the vault and every clone of its pending/ready state.
    process_lease: Option<Arc<crate::embedded::VaultProcessLease>>,
}

/// The vault, as this process currently holds it.
#[derive(Clone)]
enum Vault {
    /// Open and serving. This is the only state host mode ever has.
    Ready(SignerService),
    /// Sealed: neither the database nor the master key is open. The gate is
    /// what `/provision` walks through, once.
    Pending(Arc<ProvisionGate>),
    /// One blocking task owns initialization through final state publication.
    /// Readers remain sealed, and no second task may enter the release path.
    Provisioning,
}

impl ApiState {
    /// Host mode: the vault opens from local configuration at boot.
    pub fn new(service: SignerService) -> Self {
        ApiState {
            inner: Arc::new(Inner {
                vault: RwLock::new(Vault::Ready(service)),
                attested_boot: false,
                process_lease: None,
            }),
            workload_auth: WorkloadAuthPolicy::new(DEFAULT_WORKLOAD_AUDIENCE, false)
                .expect("the built-in loopback workload audience is canonical"),
            max_body_bytes: DEFAULT_BODY_LIMIT,
            request_slots: Arc::new(Semaphore::new(DEFAULT_MAX_IN_FLIGHT_REQUESTS)),
            blocking_slots: Arc::new(Semaphore::new(DEFAULT_MAX_IN_FLIGHT_REQUESTS)),
        }
    }

    /// Attested boot: start sealed and let `/provision` release the key.
    pub fn attested_pending(
        database_path: std::path::PathBuf,
        data_dir: std::path::PathBuf,
        profile: Arc<crate::vault_profile::ValidatedVaultProfile>,
    ) -> Self {
        let releaser = provision::profile_bound_releaser(Arc::clone(&profile));
        Self::attested_pending_with_components(
            database_path,
            data_dir,
            profile,
            releaser,
            provision::coordinator_recoverer(),
        )
    }

    #[cfg(test)]
    fn attested_pending_with_releaser(
        repository: crate::store::Store,
        data_dir: std::path::PathBuf,
        profile: Arc<crate::vault_profile::ValidatedVaultProfile>,
        releaser: provision::EnvelopeReleaser,
    ) -> Self {
        let database_path = repository.db_path().to_path_buf();
        let recoverer: provision::VaultRecoverer = Arc::new(
            |_profile, _credentials, master_key, database_path, _enrollment| {
                let repository =
                    crate::store::Store::open(database_path).map_err(|error| error.to_string())?;
                Ok(SignerService::new(repository, master_key))
            },
        );
        Self::attested_pending_with_components(
            database_path,
            data_dir,
            profile,
            releaser,
            recoverer,
        )
    }

    fn attested_pending_with_components(
        database_path: std::path::PathBuf,
        data_dir: std::path::PathBuf,
        profile: Arc<crate::vault_profile::ValidatedVaultProfile>,
        releaser: provision::EnvelopeReleaser,
        recoverer: provision::VaultRecoverer,
    ) -> Self {
        ApiState {
            inner: Arc::new(Inner {
                vault: RwLock::new(Vault::Pending(Arc::new(ProvisionGate {
                    database_path,
                    data_dir,
                    profile,
                    releaser,
                    recoverer,
                    enrollment: None,
                    migration: None,
                    migration_recoverer: provision::migration_recoverer(),
                    mutex: std::sync::Mutex::new(()),
                }))),
                attested_boot: true,
                process_lease: None,
            }),
            workload_auth: WorkloadAuthPolicy::new(DEFAULT_WORKLOAD_AUDIENCE, false)
                .expect("the built-in loopback workload audience is canonical"),
            max_body_bytes: DEFAULT_BODY_LIMIT,
            request_slots: Arc::new(Semaphore::new(DEFAULT_MAX_IN_FLIGHT_REQUESTS)),
            blocking_slots: Arc::new(Semaphore::new(DEFAULT_MAX_IN_FLIGHT_REQUESTS)),
        }
    }

    pub(crate) fn with_enrollment(
        mut self,
        enrollment: Option<Arc<crate::enrollment::ValidatedGenesisEnrollment>>,
    ) -> Self {
        let inner = Arc::get_mut(&mut self.inner).expect("configure before publishing state");
        let vault = inner.vault.get_mut().expect("unpublished vault lock");
        if let Vault::Pending(gate) = vault {
            Arc::get_mut(gate)
                .expect("unpublished provision gate")
                .enrollment = enrollment;
        }
        self
    }

    pub(crate) fn with_migration(
        mut self,
        migration: Option<Arc<crate::embedded::MeasuredMigration>>,
    ) -> Self {
        let inner = Arc::get_mut(&mut self.inner).expect("configure before publishing state");
        let vault = inner.vault.get_mut().expect("unpublished vault lock");
        if let Vault::Pending(gate) = vault {
            let gate = Arc::get_mut(gate).expect("unpublished provision gate");
            gate.migration = migration;
        }
        self
    }

    fn parse_provision_body(
        &self,
        body: ProvisionBody,
    ) -> Result<ProvisionEnv, provision::ProvisionError> {
        let vault = self
            .inner
            .vault
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let migration = match &*vault {
            Vault::Pending(gate) => gate.migration.as_deref(),
            _ => None,
        };
        ProvisionEnv::from_body_for_migration(body, migration)
    }

    pub(crate) fn with_process_lease(
        mut self,
        lease: Arc<crate::embedded::VaultProcessLease>,
    ) -> Self {
        Arc::get_mut(&mut self.inner)
            .expect("attach the process lease before publishing or cloning state")
            .process_lease = Some(lease);
        self
    }

    /// Replace the fail-closed loopback default with this deployment's one
    /// canonical public signer audience.
    pub fn with_workload_auth(mut self, workload_auth: WorkloadAuthPolicy) -> Self {
        self.workload_auth = workload_auth;
        self
    }

    /// Lower [`DEFAULT_BODY_LIMIT`] for a deployment that wants to, or for a
    /// test that wants to prove the ceiling is real.
    pub fn with_body_limit(mut self, max_body_bytes: usize) -> Self {
        self.max_body_bytes = max_body_bytes;
        self
    }

    /// Override the process-wide custody request budget.
    ///
    /// Call this while assembling the process state, before cloning it into the
    /// router. A zero-sized budget could never serve a request and is therefore
    /// rejected at configuration parsing rather than represented here.
    pub fn with_max_in_flight_requests(mut self, max_in_flight_requests: usize) -> Self {
        assert!(
            max_in_flight_requests > 0,
            "the signer in-flight request budget must be positive"
        );
        self.request_slots = Arc::new(Semaphore::new(max_in_flight_requests));
        self.blocking_slots = Arc::new(Semaphore::new(max_in_flight_requests));
        self
    }

    /// Reserve one blocking operation. This second hold is intentional: Tokio
    /// cannot abort a `spawn_blocking` closure after it starts, so a disconnected
    /// client may release the outer request permit while its durable operation
    /// is still finishing. Moving this permit into the closure keeps that work
    /// bounded under cancellation as well as under ordinary request load.
    pub(crate) fn try_blocking_slot(&self) -> Option<OwnedSemaphorePermit> {
        self.blocking_slots.clone().try_acquire_owned().ok()
    }

    /// Share the outer custody admission budget with non-HTTP adapters.
    pub(crate) fn try_request_slot(&self) -> Option<OwnedSemaphorePermit> {
        self.request_slots.clone().try_acquire_owned().ok()
    }

    /// The open vault, when there is one. `None` is the sealed window between
    /// boot and a successful `/provision`.
    pub fn service_snapshot(&self) -> Option<SignerService> {
        match self.vault_read() {
            Vault::Ready(service) => Some(service.clone()),
            Vault::Pending(_) | Vault::Provisioning => None,
        }
    }

    fn vault_read(&self) -> Vault {
        self.inner
            .vault
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// Claim initialization and publish its result in the same blocking task.
    /// The state claim spans KMS and publication without holding the read lock
    /// across I/O. A panic leaves the vault sealed until the process restarts.
    fn provision(
        &self,
        env: &ProvisionEnv,
        presented: Option<&str>,
    ) -> Result<SignerService, provision::ProvisionError> {
        let gate = {
            let mut vault = self
                .inner
                .vault
                .write()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            match &*vault {
                Vault::Ready(_) => return Err(provision::ProvisionError::AlreadyProvisioned),
                Vault::Provisioning => return Err(provision::ProvisionError::InProgress),
                Vault::Pending(gate) => {
                    let gate = Arc::clone(gate);
                    *vault = Vault::Provisioning;
                    gate
                }
            }
        };
        let mut result = provision::run(&gate, env, presented).map(|service| {
            service.with_vault_binding(Arc::clone(&gate.profile), self.inner.process_lease.clone())
        });
        let mut vault = self
            .inner
            .vault
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        // Local-only freshness check under the publication lock: a live
        // recovery can expire between return and this final Ready transition.
        if gate.enrollment.is_some() || gate.migration.is_some() {
            result = result.and_then(|service| {
                service
                    .ensure_durable_ready()
                    .map_err(|error| provision::ProvisionError::Release(error.to_string()))?;
                Ok(service)
            });
        }
        *vault = match &result {
            Ok(service) => Vault::Ready(service.clone()),
            // Preserve abandoned local state as evidence. Never run another
            // initializer into a DB left by a failed or ambiguous attempt.
            Err(_)
                if (gate.enrollment.is_some() || gate.migration.is_some())
                    && gate.database_path.exists() =>
            {
                Vault::Provisioning
            }
            Err(_) => Vault::Pending(gate),
        };
        result
    }

    /// Whether this state is an attested-boot deployment at all.
    pub fn attested_boot(&self) -> bool {
        self.inner.attested_boot
    }
}

/// The router: §5's caller-facing routes, §5.1's management routes, the four
/// process routes this file owns — `/health`, `/metrics`, `/provision`, and
/// `/attestation` — and a fallback so an unmatched path answers in the same
/// shape as a matched one.
///
/// The only middleware is the bounded admission layer below. There is no logging
/// or CORS layer: an origin is an *authentication input* this service reads from
/// a caller's headers, and a permissive CORS configuration would turn a browser
/// on the operator's network into a signing client with the console's token.
pub fn router(state: ApiState) -> Router {
    let custody_routes = Router::new()
        .route("/provision", post(provision_route))
        .route("/attestation", get(attestation_route))
        .nest(API_PREFIX, api_routes())
        // `route_layer` applies to the registered custody route tree, while the
        // observability endpoints below remain usable during saturation.
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            shed_when_busy,
        ));

    Router::new()
        .route("/health", get(health_route))
        .route("/metrics", get(metrics_route))
        .merge(custody_routes)
        .fallback(route_unknown)
        .with_state(state)
}

/// Everything below the prefix, registered relative to it.
///
/// `nest` rather than a full literal per route so the prefix cannot be typed
/// twice and drift: §5 and §5.1 name seventeen paths under one prefix, and a
/// route that escaped the prefix would still work while reading as if it did not.
fn api_routes() -> Router<ApiState> {
    Router::new()
        .route("/sign/transaction", post(sign_transaction_route))
        .route(
            "/sign/eip191-fulfillment",
            post(sign_eip191_fulfillment_route),
        )
        .route("/sign/consensus", post(sign_consensus_route))
        .route("/sign/block", post(sign_block_route))
        .route("/sign/raw", post(sign_raw_route))
        .route("/keys", post(generate_key_route).get(list_keys_route))
        .route("/keys/import", post(import_key_route))
        .route("/keys/import-nep2", post(import_nep2_route))
        .route("/keys/{id}", get(key_info_route).delete(delete_key_route))
        .route("/keys/{id}/state", post(key_state_route))
        .route(
            "/keys/{id}/policy",
            get(read_policy_route).post(save_policy_route),
        )
        .route(
            "/callers",
            post(create_caller_route).get(list_callers_route),
        )
        .route("/callers/workload", post(create_workload_caller_route))
        .route("/callers/{id}/rotate", post(rotate_caller_route))
        .route("/callers/{id}/state", post(caller_state_route))
        .route("/callers/{id}", delete(delete_caller_route))
        .route("/audit", get(audit_route))
        .fallback(route_unknown)
}

// -- plumbing -------------------------------------------------------------

/// Admit one bounded custody request or fail fast before body parsing,
/// authentication, database access, or `spawn_blocking` submission.
async fn shed_when_busy(State(state): State<ApiState>, request: Request, next: Next) -> Response {
    let Ok(_permit) = state.request_slots.clone().try_acquire_owned() else {
        return service_busy();
    };
    next.run(request).await
}

/// Run one custody call off the request thread and answer it.
///
/// `spawn_blocking` rather than calling the service inline because every method
/// here ends in SQLite, and this store opens a connection per call. A handler
/// that ran one inline would hold an async worker for the length of a disk write
/// — and the write is the point of the request, since a signature is not
/// returned until its audit row and its ledger rows are durable. Blocking every
/// worker on that is how a service stops answering the health of a vault that is
/// working correctly.
async fn decide<T, F>(
    state: &ApiState,
    action: SignerAuditAction,
    key_id: Option<String>,
    call: F,
) -> Response
where
    T: Serialize + Send + 'static,
    F: FnOnce(SignerService) -> Result<Outcome<T>> + Send + 'static,
{
    // The sealed window answers here, before any task is spawned: the vault
    // that would decide the call does not exist yet, and there is no audit row
    // to write because the audit trail lives inside that vault (see
    // `provision`'s module docs).
    let Some(service) = state.service_snapshot() else {
        return not_provisioned();
    };
    let Some(blocking_slot) = state.try_blocking_slot() else {
        return service_busy();
    };
    let operation_key_id = key_id.clone();
    // The task only stops reporting if the process is already unhealthy, but the
    // answer still has to be a refusal rather than a hung connection.
    let outcome = tokio::task::spawn_blocking(move || {
        let _blocking_slot = blocking_slot;
        let called_service = service.clone();
        service.execute_observable(action, operation_key_id.as_deref(), move || {
            call(called_service)
        })
    })
    .await;
    match outcome {
        Ok(Ok(Outcome::Allowed(body))) => allowed(body).into_response(),
        Ok(Ok(Outcome::Refused(refusal))) => refused(&refusal).into_response(),
        Ok(Err(error)) => {
            failed(state, action, key_id.as_deref(), &error.to_string()).into_response()
        }
        Err(_) => failed(
            state,
            action,
            key_id.as_deref(),
            "the request task did not finish",
        )
        .into_response(),
    }
}

/// `200` with `allowed: true` and the payload flattened beside it, which is the
/// one success shape §5 specifies and the reason a client never has to look at
/// the status line to know whether it got a witness.
fn allowed<T: Serialize>(body: T) -> Response {
    (
        StatusCode::OK,
        Json(AllowedReply {
            allowed: true,
            body,
        }),
    )
        .into_response()
}

/// A [`Refusal`] as a response: code, sentence, status — and not `detail`.
fn refused(refusal: &Refusal) -> Response {
    (
        status_for(refusal),
        Json(RefusalReply {
            allowed: false,
            code: refusal.code,
            message: refusal.message.clone(),
        }),
    )
        .into_response()
}

/// The status map from §5.
///
/// The code is matched *before* the outcome because the two disagree in both
/// directions. `signer-admin-request-invalid` is a `Denied` refusal that answers
/// `400` — the request was wrong, not the caller — while `signer-key-unknown` and
/// `signer-caller-unknown` are `Failed` refusals that answer `404`, because
/// "nothing is here under that id" is the useful answer and `500` would send an
/// operator to the vault. A map that started from the outcome would get both of
/// those wrong, which is why the vocabulary comes first.
fn status_for(refusal: &Refusal) -> StatusCode {
    match refusal.code {
        "signer-transaction-unparsable"
        | "signer-script-unparsable"
        | "signer-payload-unparsable"
        | "signer-oracle-contract-invalid"
        | "signer-fulfillment-invalid"
        | UNSIGNED_HEX_UNREADABLE
        | REQUEST_UNREADABLE
        | audit::ADMIN_REQUEST_INVALID
        | audit::REQUEST_ID_INVALID => StatusCode::BAD_REQUEST,
        audit::REQUEST_ID_CONFLICT => StatusCode::CONFLICT,
        "signer-key-unknown" | "signer-caller-unknown" => StatusCode::NOT_FOUND,
        _ if refusal.outcome == SignerAuditOutcome::Denied => StatusCode::FORBIDDEN,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

/// The transport's fixed `500` answer. `execute_observable` already wrote any
/// possible failure audit and passed it through the same durable barrier; this
/// function must not create state after that barrier or after a fence.
fn failed(
    _state: &ApiState,
    action: SignerAuditAction,
    key_id: Option<&str>,
    detail: &str,
) -> Response {
    let _ = (action, key_id, detail);
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(RefusalReply {
            allowed: false,
            code: SERVICE_FAILED,
            message: "the service could not complete this request".to_string(),
        }),
    )
        .into_response()
}

/// A `400` for a body the transport could not use. `problem` names the caller's
/// own field — never a vault fact — and `None` yields the bare sentence.
fn unreadable(problem: Option<&str>) -> Response {
    refusal(
        REQUEST_UNREADABLE,
        &format!(
            "the request body could not be read{}",
            problem.map_or_else(String::new, |problem| format!(": {problem}"))
        ),
        StatusCode::BAD_REQUEST,
    )
}

/// A `400` for `unsigned_hex` that is not hexadecimal.
fn unsigned_hex_unreadable() -> Response {
    refusal(
        UNSIGNED_HEX_UNREADABLE,
        "unsigned_hex must hold the SerializeUnsigned bytes as hexadecimal",
        StatusCode::BAD_REQUEST,
    )
}

fn too_large() -> Response {
    refusal(
        REQUEST_TOO_LARGE,
        "the request body is larger than this service accepts",
        StatusCode::PAYLOAD_TOO_LARGE,
    )
}

/// A bounded, refusal-shaped overload response. Counts and route details stay
/// private because this answer can be reached before authentication.
fn service_busy() -> Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        [(header::RETRY_AFTER, BUSY_RETRY_AFTER_SECONDS)],
        Json(RefusalReply {
            allowed: false,
            code: SERVICE_BUSY,
            message: "the signer is temporarily busy; retry later".to_string(),
        }),
    )
        .into_response()
}

/// The `503` for every custody route while the vault is still sealed.
fn not_provisioned() -> Response {
    refusal(
        NOT_PROVISIONED,
        "the vault is sealed; a successful /provision must come first",
        StatusCode::SERVICE_UNAVAILABLE,
    )
}

/// Build a refusal-shaped response for the codes this module owns. A
/// [`Refusal`] is not used because those are decisions the service records, and
/// manufacturing one here would suggest the audit row already exists.
fn refusal(code: &'static str, message: &str, status: StatusCode) -> Response {
    refusal_owned(code, message.to_string(), status)
}

/// [`refusal`] for messages built at runtime — the provision whitelist's errors
/// name the key that tripped them.
fn refusal_owned(code: &'static str, message: String, status: StatusCode) -> Response {
    (
        status,
        Json(RefusalReply {
            allowed: false,
            code,
            message,
        }),
    )
        .into_response()
}

// -- extractors -----------------------------------------------------------

/// Who is asking, read from the headers and from nothing else.
///
/// `X-Forwarded-*` is never consulted: §5 puts the transport on a loopback or an
/// internal network, so a value in a forwarding header is a string a client
/// chose, and an origin an authorizer believed would be one an attacker picked.
pub struct Credentials(CallerCredentials);

impl FromRequestParts<ApiState> for Credentials {
    type Rejection = Infallible;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &ApiState,
    ) -> std::result::Result<Self, Self::Rejection> {
        let request_uri = parts
            .extensions
            .get::<OriginalUri>()
            .map(|original| &original.0)
            .unwrap_or(&parts.uri);
        let route = request_uri
            .path_and_query()
            .map(|value| value.as_str())
            .unwrap_or_else(|| request_uri.path());
        Ok(Credentials(CallerCredentials::request(
            header_value(parts, header::AUTHORIZATION),
            header_value(parts, header::ORIGIN),
            header_value(parts, header::REFERER),
            WorkloadRequestHeaders {
                protocol: text_header(parts, WORKLOAD_PROTOCOL_HEADER),
                audience: text_header(parts, WORKLOAD_AUDIENCE_HEADER),
                caller_id: text_header(parts, WORKLOAD_CALLER_HEADER),
                timestamp: text_header(parts, WORKLOAD_TIMESTAMP_HEADER),
                nonce: text_header(parts, WORKLOAD_NONCE_HEADER),
                signature: text_header(parts, WORKLOAD_SIGNATURE_HEADER),
            },
            &state.workload_auth,
            parts.method.as_str(),
            route,
        )))
    }
}

/// A non-ASCII header value is a value that cannot be a token or an origin, so
/// it reads as absent and the service answers on the facts it has.
fn header_value(parts: &Parts, name: header::HeaderName) -> Option<&str> {
    parts.headers.get(name)?.to_str().ok()
}

fn text_header<'a>(parts: &'a Parts, name: &str) -> Option<&'a str> {
    parts.headers.get(name)?.to_str().ok()
}

/// A JSON request body, already bounded by `ApiState::max_body_bytes`.
///
/// Its rejection is a complete [`Response`] rather than axum's `JsonRejection`
/// so that a malformed body cannot be the one thing on this service that answers
/// with `text/plain`, and so serde's own message — which quotes the input, and
/// the input can be a private key — never reaches a client.
pub struct JsonBody<T>(T, [u8; 32]);

impl<T> JsonBody<T> {
    fn bind(self, credentials: Credentials) -> (T, CallerCredentials) {
        (self.0, credentials.0.with_body_digest(self.1))
    }
}

impl<T> FromRequest<ApiState> for JsonBody<T>
where
    T: DeserializeOwned,
{
    type Rejection = Response;

    async fn from_request(
        request: Request,
        state: &ApiState,
    ) -> std::result::Result<Self, Self::Rejection> {
        let limit = state.max_body_bytes;
        let (parts, body) = request.into_parts();
        if declared_length(&parts).is_some_and(|length| length > limit) {
            return Err(too_large());
        }
        let bytes = to_bytes(body, limit).await.map_err(|_| unreadable(None))?;
        let digest = crate::auth::body_sha256(&bytes);
        serde_json::from_slice::<T>(&bytes)
            .map(|body| JsonBody(body, digest))
            .map_err(|_| unreadable(None))
    }
}

/// The `Content-Length` a client declared, when it declared one it could read.
///
/// Only used to answer `413` early with the right status. A chunked upload gets
/// no declaration and is caught by the limit inside [`to_bytes`], which answers
/// `400` instead — imprecise about the cause, but the ceiling holds either way,
/// and that is what the number is for.
fn declared_length(parts: &Parts) -> Option<usize> {
    parts
        .headers
        .get(header::CONTENT_LENGTH)?
        .to_str()
        .ok()?
        .trim()
        .parse()
        .ok()
}

/// `GET /audit`'s query string, parsed by hand.
///
/// Hand-rolled rather than `axum::extract::Query` so a bad `limit` answers in the
/// refusal shape with the code list in §5, instead of the extractor's own
/// `Invalid URL query:` text.
pub struct AuditQuery {
    key_id: Option<String>,
    limit: usize,
}

impl<S: Send + Sync> FromRequestParts<S> for AuditQuery {
    type Rejection = Response;

    async fn from_request_parts(
        parts: &mut Parts,
        _state: &S,
    ) -> std::result::Result<Self, Self::Rejection> {
        let mut key_id = None;
        let mut limit = None;
        for (name, value) in url::form_urlencoded::parse(parts.uri.query().unwrap_or("").as_bytes())
        {
            match &*name {
                "key_id" => {
                    let value = value.trim();
                    // An empty filter is no filter. Handing `Some("")` to the
                    // grant check instead would refuse a whole-vault admin for
                    // typing nothing into a console search box.
                    if !value.is_empty() {
                        key_id = Some(value.to_string());
                    }
                }
                "limit" => {
                    limit = Some(
                        value
                            .trim()
                            .parse::<usize>()
                            .map_err(|_| unreadable(Some("limit must be a number")))?,
                    )
                }
                // Unknown filters are ignored: a query string is where a client
                // puts the thing the next version will need, and refusing one
                // would make every additive change breaking.
                _ => {}
            }
        }
        Ok(AuditQuery {
            key_id,
            limit: limit.unwrap_or(AUDIT_LIMIT_DEFAULT).min(AUDIT_LIMIT_MAX),
        })
    }
}

// -- caller-facing routes (§5) -------------------------------------------

async fn sign_transaction_route(
    State(state): State<ApiState>,
    credentials: Credentials,
    body: JsonBody<SignCall>,
) -> Response {
    let (request, credentials) = body.bind(credentials);
    let unsigned = match decode_unsigned(&request.unsigned_hex) {
        Ok(unsigned) => unsigned,
        Err(refusal) => return *refusal,
    };
    let chain_family = match ChainFamily::from_str(request.chain_family.trim()) {
        Ok(family) => family,
        Err(_) => return unreadable(Some("chain_family must be 'neo-n3' or 'neox'")),
    };
    if chain_family == ChainFamily::NeoN3 && request.chain_id.is_some() {
        return unreadable(Some("chain_id is valid only when chain_family is 'neox'"));
    }
    if chain_family == ChainFamily::NeoX && request.chain_id.is_none() {
        return unreadable(Some("chain_id is required when chain_family is 'neox'"));
    }
    let key_id = request.key_id;
    let request_id = request.request_id;
    let chain_id = request.chain_id;
    decide(
        &state,
        SignerAuditAction::TransactionSigned,
        Some(key_id.clone()),
        move |service| {
            service
                .sign_transaction_for_chain_with_request_id(
                    &credentials,
                    &key_id,
                    &unsigned,
                    chain_family,
                    chain_id,
                    request_id.as_deref(),
                )
                .map(|outcome| outcome.map(signature_body))
        },
    )
    .await
}

async fn sign_eip191_fulfillment_route(
    State(state): State<ApiState>,
    credentials: Credentials,
    body: JsonBody<Eip191FulfillmentCall>,
) -> Response {
    let (request, credentials) = body.bind(credentials);
    let key_id = request.key_id;
    let request_id = request.request_id;
    let chain_id = request.chain_id;
    let oracle_contract = request.oracle_contract;
    let result_bytes_hex = request.result_bytes_hex;
    let fulfillment = neo_os_chain_evm::Fulfillment {
        request_id: request.fulfillment.request_id,
        app_id: request.fulfillment.app_id,
        module_id: request.fulfillment.module_id,
        operation: request.fulfillment.operation,
        payload: request.fulfillment.payload_hex,
        success: request.fulfillment.success,
        error: request.fulfillment.error,
    };
    decide(
        &state,
        SignerAuditAction::Eip191FulfillmentSigned,
        Some(key_id.clone()),
        move |service| {
            service
                .sign_eip191_fulfillment(
                    &credentials,
                    Eip191FulfillmentRequest {
                        key_id: &key_id,
                        chain_id,
                        oracle_contract: &oracle_contract,
                        fulfillment: &fulfillment,
                        result_bytes_hex: &result_bytes_hex,
                        request_id: &request_id,
                    },
                )
                .map(|outcome| outcome.map(eip191_fulfillment_body))
        },
    )
    .await
}

async fn sign_consensus_route(
    State(state): State<ApiState>,
    credentials: Credentials,
    body: JsonBody<SignCall>,
) -> Response {
    let (request, credentials) = body.bind(credentials);
    let unsigned = match decode_unsigned(&request.unsigned_hex) {
        Ok(unsigned) => unsigned,
        Err(refusal) => return *refusal,
    };
    if request.chain_family != default_chain_family() || request.chain_id.is_some() {
        return unreadable(Some(
            "consensus signing supports only chain_family 'neo-n3'",
        ));
    }
    let key_id = request.key_id;
    let request_id = request.request_id;
    decide(
        &state,
        SignerAuditAction::ConsensusSigned,
        Some(key_id.clone()),
        move |service| {
            service
                .sign_consensus_with_request_id(
                    &credentials,
                    &key_id,
                    &unsigned,
                    request_id.as_deref(),
                )
                .map(|outcome| outcome.map(signature_body))
        },
    )
    .await
}

/// `POST /sign/block` accepts the same structured block material as Neo's
/// SignClient protocol. It validates the Merkle root before entering the
/// service and then uses the dedicated block lane, whose durable reservation
/// prevents a second header at the same key/network/height.
async fn sign_block_route(
    State(state): State<ApiState>,
    credentials: Credentials,
    body: JsonBody<BlockSignCall>,
) -> Response {
    let (request, credentials) = body.bind(credentials);
    let public_key_bytes = match hex::decode(request.public_key.trim()) {
        Ok(bytes) => bytes,
        Err(_) => return unreadable(Some("public_key must be SEC1 hexadecimal")),
    };
    let public_key = match crate::crypto::compress_public_key(&public_key_bytes) {
        Some(public_key) => public_key,
        None => return unreadable(Some("public_key must be a P-256 public key")),
    };
    let prev_hash = match decode_fixed_hex::<32>(&request.block.header.prev_hash, "prev_hash") {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let merkle_root = match decode_fixed_hex::<32>(&request.block.header.merkle_root, "merkle_root")
    {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let next_consensus =
        match decode_fixed_hex::<20>(&request.block.header.next_consensus, "next_consensus") {
            Ok(value) => value,
            Err(response) => return *response,
        };
    let prev_state_root = match request.block.header.prev_state_root.as_deref() {
        Some(value) => match decode_fixed_hex::<32>(value, "prev_state_root") {
            Ok(value) => Some(value),
            Err(response) => return *response,
        },
        None => None,
    };
    let mut tx_hashes = Vec::with_capacity(request.block.tx_hashes.len());
    for hash in &request.block.tx_hashes {
        match decode_fixed_hex::<32>(hash, "transaction hash") {
            Ok(value) => tx_hashes.push(value),
            Err(response) => return *response,
        }
    }
    let header = match NeoBlockHeader::from_wire_with_state_root(
        request.block.header.version,
        prev_hash,
        merkle_root,
        request.block.header.timestamp,
        request.block.header.nonce,
        request.block.header.index,
        request.block.header.primary_index,
        next_consensus,
        prev_state_root,
        request.block.header.state_root_enabled,
    ) {
        Ok(header) => header,
        Err(error) => return unreadable(Some(&error.to_string())),
    };
    let block = match NeoBlock::new(header, tx_hashes) {
        Ok(block) => block,
        Err(error) => return unreadable(Some(&error.to_string())),
    };
    let key_id = request.key_id;
    let request_id = request.request_id;
    let network = request.network;
    decide(
        &state,
        SignerAuditAction::ConsensusSigned,
        Some(key_id.clone()),
        move |service| {
            service
                .sign_block_with_request_id(
                    &credentials,
                    &key_id,
                    &block,
                    network,
                    public_key,
                    request_id.as_deref(),
                )
                .map(|outcome| outcome.map(signature_body))
        },
    )
    .await
}

/// `POST /sign/raw` — sign raw caller bytes under `key_id`. The bytes are not
/// parsed, so the key's `allow_raw` boundary switch is the only gate past the
/// caller's grant, and it defaults to closed. The reply carries the bare
/// 64-byte signature and the public key beside the usual witness fields,
/// because a raw caller (the enclave host's pinned role keys) signs digests
/// and preimages that never become witnesses of this service's own building.
async fn sign_raw_route(
    State(state): State<ApiState>,
    credentials: Credentials,
    body: JsonBody<RawSignCall>,
) -> Response {
    let (request, credentials) = body.bind(credentials);
    let data = match hex::decode(request.data_hex.trim()) {
        Ok(data) if !data.is_empty() => data,
        Ok(_) => return unreadable(Some("data_hex must not be empty")),
        Err(_) => return unreadable(Some("data_hex must be hexadecimal")),
    };
    let key_id = request.key_id;
    let request_id = request.request_id;
    decide(
        &state,
        SignerAuditAction::RawSigned,
        Some(key_id.clone()),
        move |service| {
            service
                .sign_raw_with_request_id(&credentials, &key_id, &data, request_id.as_deref())
                .map(|outcome| outcome.map(raw_signature_body))
        },
    )
    .await
}

/// `GET /keys/{id}`: the caller-facing identity read, guarded by `sign`.
///
/// Not the same route as the boundary read below, and not the same guard. §5.1
/// explains why — two guards on one path is how a route ends up answering
/// whichever check it reaches first.
async fn key_info_route(
    State(state): State<ApiState>,
    credentials: Credentials,
    Path(key_id): Path<String>,
) -> Response {
    let Credentials(credentials) = credentials;
    decide(
        &state,
        SignerAuditAction::KeyViewed,
        Some(key_id.clone()),
        move |service| {
            service
                .key_info(&credentials, &key_id)
                .map(|outcome| outcome.map(key_body))
        },
    )
    .await
}

fn decode_unsigned(unsigned_hex: &str) -> std::result::Result<Vec<u8>, Box<Response>> {
    // Boxed rather than returned whole: the lint's point is that an `Ok` path
    // should not pay for a fat `Err`, and here it would — the success value is a
    // `Vec`, the refusal is a response.
    hex::decode(unsigned_hex.trim()).map_err(|_| Box::new(unsigned_hex_unreadable()))
}

fn decode_fixed_hex<const N: usize>(
    value: &str,
    field: &str,
) -> std::result::Result<[u8; N], Box<Response>> {
    let decoded = hex::decode(value.trim())
        .map_err(|_| Box::new(unreadable(Some(&format!("{field} must be hexadecimal")))))?;
    decoded.try_into().map_err(|bytes: Vec<u8>| {
        Box::new(unreadable(Some(&format!(
            "{field} must be {N} bytes, got {}",
            bytes.len()
        ))))
    })
}

// -- management routes: keys (§5.1) --------------------------------------

async fn generate_key_route(
    State(state): State<ApiState>,
    credentials: Credentials,
    body: JsonBody<KeyKindCall>,
) -> Response {
    let (request, credentials) = body.bind(credentials);
    let network = match parse_network(&request.network) {
        Ok(network) => network,
        Err(refusal) => return *refusal,
    };
    let chain_family = match parse_chain_family(&request.chain_family) {
        Ok(family) => family,
        Err(refusal) => return *refusal,
    };
    let chain_id =
        match requested_key_chain_id(chain_family, request.chain_id, request.network_magic) {
            Ok(chain_id) => chain_id,
            Err(refusal) => return *refusal,
        };
    let label = request.label;
    decide(
        &state,
        SignerAuditAction::KeyGenerated,
        None,
        move |service| {
            service
                .generate_key_for_chain(&credentials, &label, network, chain_family, chain_id)
                .map(|outcome| outcome.map(key_body))
        },
    )
    .await
}

async fn import_key_route(
    State(state): State<ApiState>,
    credentials: Credentials,
    body: JsonBody<ImportCall>,
) -> Response {
    let (request, credentials) = body.bind(credentials);
    let network = match parse_network(&request.network) {
        Ok(network) => network,
        Err(refusal) => return *refusal,
    };
    let chain_family = match parse_chain_family(&request.chain_family) {
        Ok(family) => family,
        Err(refusal) => return *refusal,
    };
    let chain_id =
        match requested_key_chain_id(chain_family, request.chain_id, request.network_magic) {
            Ok(chain_id) => chain_id,
            Err(refusal) => return *refusal,
        };
    let label = request.label;
    let private_key = request.private_key;
    decide(
        &state,
        SignerAuditAction::KeyImported,
        None,
        move |service| {
            service
                .import_key_for_chain(
                    &credentials,
                    &label,
                    network,
                    chain_family,
                    chain_id,
                    private_key.as_str(),
                )
                .map(|outcome| outcome.map(key_body))
        },
    )
    .await
}

async fn import_nep2_route(
    State(state): State<ApiState>,
    credentials: Credentials,
    body: JsonBody<Nep2Call>,
) -> Response {
    let (request, credentials) = body.bind(credentials);
    let network = match parse_network(&request.network) {
        Ok(network) => network,
        Err(refusal) => return *refusal,
    };
    let label = request.label;
    let network_magic = request.network_magic;
    let nep2 = request.nep2;
    let passphrase = request.passphrase;
    decide(
        &state,
        SignerAuditAction::KeyImported,
        None,
        move |service| {
            service
                .import_nep2_key(
                    &credentials,
                    &label,
                    network,
                    network_magic,
                    &nep2,
                    passphrase.as_str(),
                )
                .map(|outcome| outcome.map(key_body))
        },
    )
    .await
}

async fn list_keys_route(State(state): State<ApiState>, credentials: Credentials) -> Response {
    let Credentials(credentials) = credentials;
    decide(&state, SignerAuditAction::KeyViewed, None, move |service| {
        service.list_keys(&credentials).map(|outcome| {
            outcome.map(|keys| KeysBody {
                keys: keys.into_iter().map(key_body).collect(),
            })
        })
    })
    .await
}

async fn key_state_route(
    State(state): State<ApiState>,
    credentials: Credentials,
    Path(key_id): Path<String>,
    body: JsonBody<StateCall>,
) -> Response {
    let (request, credentials) = body.bind(credentials);
    let action = if request.disabled {
        SignerAuditAction::KeyDisabled
    } else {
        SignerAuditAction::KeyEnabled
    };
    let disabled = request.disabled;
    decide(&state, action, Some(key_id.clone()), move |service| {
        service
            .set_key_disabled(&credentials, &key_id, disabled)
            .map(|outcome| outcome.map(key_body))
    })
    .await
}

async fn read_policy_route(
    State(state): State<ApiState>,
    credentials: Credentials,
    Path(key_id): Path<String>,
) -> Response {
    let Credentials(credentials) = credentials;
    decide(
        &state,
        SignerAuditAction::KeyViewed,
        Some(key_id.clone()),
        move |service| {
            service.key_detail(&credentials, &key_id).map(|outcome| {
                outcome.map(|(info, policy)| KeyPolicyBody {
                    key: key_body(info),
                    problems: advice(&policy),
                    policy: PolicyBody::from_policy(&policy),
                })
            })
        },
    )
    .await
}

async fn save_policy_route(
    State(state): State<ApiState>,
    credentials: Credentials,
    Path(key_id): Path<String>,
    body: JsonBody<PolicyBody>,
) -> Response {
    let (request, credentials) = body.bind(credentials);
    let policy = match request.to_policy() {
        Ok(policy) => policy,
        Err(problem) => return unreadable(Some(problem)),
    };
    decide(
        &state,
        SignerAuditAction::PolicySaved,
        Some(key_id.clone()),
        move |service| {
            service
                .save_policy(&credentials, &key_id, &policy)
                .map(|outcome| {
                    outcome.map(|policy| PolicyResponseBody {
                        problems: advice(&policy),
                        policy: PolicyBody::from_policy(&policy),
                    })
                })
        },
    )
    .await
}

async fn delete_key_route(
    State(state): State<ApiState>,
    credentials: Credentials,
    Path(key_id): Path<String>,
) -> Response {
    let Credentials(credentials) = credentials;
    decide(
        &state,
        SignerAuditAction::KeyDeleted,
        Some(key_id.clone()),
        move |service| {
            service.delete_key(&credentials, &key_id).map(|outcome| {
                outcome.map(|()| RemovedKeyBody {
                    key_id: key_id.clone(),
                })
            })
        },
    )
    .await
}

// -- management routes: callers and audit (§5.1) -------------------------

async fn create_caller_route(
    State(state): State<ApiState>,
    credentials: Credentials,
    body: JsonBody<CallerCall>,
) -> Response {
    let (request, credentials) = body.bind(credentials);
    let grant = match request.key_grant.to_grant() {
        Ok(grant) => grant,
        Err(problem) => return unreadable(Some(problem)),
    };
    let capabilities = match parse_capabilities(&request.capabilities) {
        Ok(capabilities) => capabilities,
        Err(problem) => return unreadable(Some(problem)),
    };
    let label = request.label;
    let origins = request.allowed_origins;
    decide(
        &state,
        SignerAuditAction::CallerCreated,
        None,
        move |service| {
            service
                .create_caller(&credentials, &label, grant, &capabilities, &origins)
                .map(|outcome| {
                    outcome.map(|(caller, token)| CreatedCallerBody {
                        caller: caller_body(caller),
                        token,
                    })
                })
        },
    )
    .await
}

async fn create_workload_caller_route(
    State(state): State<ApiState>,
    credentials: Credentials,
    body: JsonBody<WorkloadCallerCall>,
) -> Response {
    let (request, credentials) = body.bind(credentials);
    let grant = match request.caller.key_grant.to_grant() {
        Ok(grant) => grant,
        Err(problem) => return unreadable(Some(problem)),
    };
    let capabilities = match parse_capabilities(&request.caller.capabilities) {
        Ok(capabilities) => capabilities,
        Err(problem) => return unreadable(Some(problem)),
    };
    let public_key = match hex::decode(request.workload_public_key.trim())
        .ok()
        .and_then(|bytes| <[u8; 32]>::try_from(bytes).ok())
    {
        Some(public_key) => public_key,
        None => {
            return unreadable(Some(
                "workload_public_key must be 64 hexadecimal characters",
            ))
        }
    };
    let label = request.caller.label;
    let origins = request.caller.allowed_origins;
    let subject = request.workload_subject;
    decide(
        &state,
        SignerAuditAction::CallerCreated,
        None,
        move |service| {
            service
                .create_workload_caller(
                    &credentials,
                    WorkloadCallerSpec {
                        label: &label,
                        key_grant: grant,
                        capabilities: &capabilities,
                        allowed_origins: &origins,
                        public_key,
                        subject: subject.as_deref(),
                    },
                )
                .map(|outcome| {
                    outcome.map(|caller| CreatedWorkloadCallerBody {
                        caller: caller_body(caller),
                    })
                })
        },
    )
    .await
}

async fn list_callers_route(State(state): State<ApiState>, credentials: Credentials) -> Response {
    let Credentials(credentials) = credentials;
    decide(
        &state,
        SignerAuditAction::CallerViewed,
        None,
        move |service| {
            service.list_callers(&credentials).map(|outcome| {
                outcome.map(|callers| CallersBody {
                    callers: callers.into_iter().map(caller_body).collect(),
                })
            })
        },
    )
    .await
}

async fn rotate_caller_route(
    State(state): State<ApiState>,
    credentials: Credentials,
    Path(caller_id): Path<String>,
) -> Response {
    let Credentials(credentials) = credentials;
    decide(
        &state,
        SignerAuditAction::CallerRotated,
        None,
        move |service| {
            service
                .rotate_caller_token(&credentials, &caller_id)
                .map(|outcome| {
                    outcome.map(|token| RotatedCallerBody {
                        caller_id: caller_id.clone(),
                        token,
                    })
                })
        },
    )
    .await
}

async fn caller_state_route(
    State(state): State<ApiState>,
    credentials: Credentials,
    Path(caller_id): Path<String>,
    body: JsonBody<StateCall>,
) -> Response {
    let (request, credentials) = body.bind(credentials);
    let action = if request.disabled {
        SignerAuditAction::CallerDisabled
    } else {
        SignerAuditAction::CallerEnabled
    };
    let disabled = request.disabled;
    decide(&state, action, None, move |service| {
        service
            .set_caller_disabled(&credentials, &caller_id, disabled)
            .map(|outcome| outcome.map(caller_body))
    })
    .await
}

async fn delete_caller_route(
    State(state): State<ApiState>,
    credentials: Credentials,
    Path(caller_id): Path<String>,
) -> Response {
    let Credentials(credentials) = credentials;
    decide(
        &state,
        SignerAuditAction::CallerDeleted,
        None,
        move |service| {
            service
                .delete_caller(&credentials, &caller_id)
                .map(|outcome| outcome.map(|()| RemovedCallerBody { caller_id }))
        },
    )
    .await
}

/// `GET /audit`. Read-only, records nothing on success, and the one response
/// where [`SignerAuditRecord::detail`] is served — see the module docs and §5.
async fn audit_route(
    State(state): State<ApiState>,
    credentials: Credentials,
    query: AuditQuery,
) -> Response {
    let Credentials(credentials) = credentials;
    let key_id = query.key_id;
    let limit = query.limit;
    decide(
        &state,
        SignerAuditAction::AuditRead,
        key_id.clone(),
        move |service| {
            service
                .list_audit(&credentials, key_id.as_deref(), limit)
                .map(|outcome| {
                    outcome.map(|records| AuditBody {
                        entries: records.into_iter().map(audit_row).collect(),
                    })
                })
        },
    )
    .await
}

async fn route_unknown() -> Response {
    refusal(
        ROUTE_UNKNOWN,
        "no endpoint is registered at this path",
        StatusCode::NOT_FOUND,
    )
}

// -- enclave routes (§6) ---------------------------------------------------
//
// Pre-auth by design, like the merged server they replace: the transport is a
// vsock loopback only the host can reach, and these routes exist to *bootstrap*
// the vault, so they cannot require credentials that live inside it.

/// `GET /health` — is the process up, and is the vault open.
async fn health_route(State(state): State<ApiState>) -> Response {
    let Some(service) = state.service_snapshot() else {
        return (StatusCode::OK, Json(json!({ "status": "unprovisioned" }))).into_response();
    };
    if service.durable_status().is_none() {
        return (StatusCode::OK, Json(json!({ "status": "ok" }))).into_response();
    }
    let verified = tokio::task::spawn_blocking(move || service.verify_durable_lease()).await;
    match verified {
        Ok(Ok(Some(head))) => (
            StatusCode::OK,
            Json(json!({
                "status": "ok",
                "durable": true,
                "generation": head.generation,
                "epoch": head.epoch,
                "lease_expires_at_ms": head.lease_expires_at_ms,
            })),
        )
            .into_response(),
        Ok(Ok(None)) => (StatusCode::OK, Json(json!({ "status": "ok" }))).into_response(),
        Ok(Err(_)) | Err(_) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "status": "fenced", "durable": true })),
        )
            .into_response(),
    }
}

/// `GET /metrics` — Prometheus metrics scrape endpoint.
async fn metrics_route() -> Response {
    use prometheus::{Encoder, TextEncoder};
    let encoder = TextEncoder::new();
    let metric_families = prometheus::gather();
    let mut buffer = Vec::new();
    if let Err(err) = encoder.encode(&metric_families, &mut buffer) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to encode prometheus metrics: {err}"),
        )
            .into_response();
    }
    match String::from_utf8(buffer) {
        Ok(body) => (
            StatusCode::OK,
            [("content-type", "text/plain; version=0.0.4; charset=utf-8")],
            body,
        )
            .into_response(),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("metrics buffer is not valid utf-8: {err}"),
        )
            .into_response(),
    }
}

/// `POST /provision` — the one door the master key comes through, walked once.
///
/// The body is `{"env": {…}}`, validated against the whitelist in
/// [`provision`]; the transport token is read from the `Authorization` header
/// the same way a custody call presents it. Everything blocking — the
/// whitelist's KMS release included — runs off the async workers, because the
/// release is an HTTP call to KMS through the vsock proxy.
async fn provision_route(
    State(state): State<ApiState>,
    credentials: Credentials,
    body: JsonBody<ProvisionBody>,
) -> Response {
    let (body, credentials) = body.bind(credentials);
    let env = match state.parse_provision_body(body) {
        Ok(env) => env,
        Err(error) => {
            let (code, status, message) = error.answer();
            let status = StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_REQUEST);
            return refusal_owned(code, message, status);
        }
    };
    let presented = credentials.token().map(str::to_owned);
    let Some(blocking_slot) = state.try_blocking_slot() else {
        return service_busy();
    };
    let provision_state = state.clone();
    let attempted = tokio::task::spawn_blocking(move || {
        let _blocking_slot = blocking_slot;
        provision_state.provision(&env, presented.as_deref())
    })
    .await;
    match attempted {
        Ok(Ok(service)) => (
            StatusCode::OK,
            Json(json!({
                "status": "ok",
                "vault_fingerprint": service.vault_fingerprint(),
            })),
        )
            .into_response(),
        Ok(Err(provision::ProvisionError::InProgress)) => service_busy(),
        Ok(Err(error)) => {
            let (code, status, message) = error.answer();
            let status = StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_REQUEST);
            refusal_owned(code, message, status)
        }
        Err(_) => failed(
            &state,
            SignerAuditAction::AuditRead,
            None,
            "the provision task did not finish",
        ),
    }
}

/// `GET /attestation?nonce=<hex>` — the enclave proves what it is holding.
///
/// The attestation's `user_data` binds only the two digests (the NSM caps
/// `user_data` at 512 bytes): the vault fingerprint and the SHA-256 of the
/// per-key boundary list. The full boundary list rides in this response as
/// `boundaries_json`, so a verifier recomputes its digest, checks it against
/// the attested one, and only then trusts the boundaries it just read. A
/// `nonce` makes the document single-use; an NSM failure answers `500` and
/// writes no audit row, because nothing about the vault was decided.
async fn attestation_route(State(state): State<ApiState>, uri: Uri) -> Response {
    let Some(service) = state.service_snapshot() else {
        return not_provisioned();
    };
    let nonce = match extract_nonce(uri.query()) {
        Ok(nonce) => nonce,
        Err(response) => return *response,
    };
    let Some(blocking_slot) = state.try_blocking_slot() else {
        return service_busy();
    };
    let built = tokio::task::spawn_blocking(move || {
        let _blocking_slot = blocking_slot;
        build_attestation(&service, &NsmAttestation, nonce.as_deref())
    })
    .await;
    match built {
        Ok(Ok(reply)) => (StatusCode::OK, Json(reply)).into_response(),
        Ok(Err(error)) => refusal(
            SERVICE_FAILED,
            &format!("the attestation could not be produced: {error}"),
            StatusCode::INTERNAL_SERVER_ERROR,
        ),
        Err(_) => refusal(
            SERVICE_FAILED,
            "the request task did not finish",
            StatusCode::INTERNAL_SERVER_ERROR,
        ),
    }
}

/// The optional `?nonce=` hex value, read by hand like [`AuditQuery`] so a bad
/// one answers in the refusal shape.
fn extract_nonce(query: Option<&str>) -> std::result::Result<Option<Vec<u8>>, Box<Response>> {
    let Some(query) = query else {
        return Ok(None);
    };
    for (name, value) in url::form_urlencoded::parse(query.as_bytes()) {
        if &*name == "nonce" {
            let bytes = hex::decode(value.trim())
                .map_err(|_| Box::new(unreadable(Some("nonce must be hexadecimal"))))?;
            if bytes.is_empty() {
                return Err(Box::new(unreadable(Some("nonce must not be empty"))));
            }
            return Ok(Some(bytes));
        }
    }
    Ok(None)
}

/// Everything the attestation binds, built where the database and the NSM both
/// are: boundaries from the rows, digests over them, one fresh document. The
/// source is a parameter so the tests can stand in for the NSM device.
fn build_attestation(
    service: &SignerService,
    source: &dyn AttestationSource,
    nonce: Option<&[u8]>,
) -> std::result::Result<serde_json::Value, String> {
    let keys = service
        .repository()
        .list_signer_keys()
        .map_err(|error| error.to_string())?;
    let mut boundaries = Vec::with_capacity(keys.len());
    for key in &keys {
        let policy = service
            .repository()
            .signer_policy_or_default(&key.id)
            .map_err(|error| error.to_string())?;
        boundaries.push(
            KeyBoundary::new(key, policy).map_err(|error| format!("key {}: {error}", key.id))?,
        );
    }
    let boundaries_json = attested_identity::boundaries_json(&boundaries);
    let boundaries_sha256 = attested_identity::boundaries_sha256(&boundaries);
    let vault_fingerprint = service.vault_fingerprint();
    let user_data =
        attested_identity::attestation_user_data(&vault_fingerprint, &boundaries_sha256);
    let document = source
        .attest(nonce, Some(&user_data), None)
        .map_err(|error| format!("the NSM refused the request: {error}"))?;
    Ok(json!({
        "status": "ok",
        "runtime": attested_identity::RUNTIME_NAME,
        "format": "cose-sign1-cbor-base64",
        "vault_fingerprint": vault_fingerprint,
        "boundaries_sha256": boundaries_sha256,
        "boundaries_json": boundaries_json,
        "nonce": nonce.map(hex::encode),
        "user_data_hex": hex::encode(&user_data),
        "document_len": document.len(),
        "attestation_document": BASE64.encode(&document),
    }))
}

// -- request shapes -------------------------------------------------------

/// `{"key_id": …, "unsigned_hex": …, "chain_family": …}` for both sign routes (§5).
///
/// The `chain_family` field is optional and defaults to "neo-n3" for backward compatibility.
/// Supported values: "neo-n3", "neox".
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SignCall {
    pub key_id: String,
    pub unsigned_hex: String,
    #[serde(default)]
    pub request_id: Option<String>,
    /// Chain family: "neo-n3" (default) or "neox"
    #[serde(default = "default_chain_family")]
    pub chain_family: String,
    /// For NeoX transactions: the chain ID for EIP-155 replay protection
    #[serde(default)]
    pub chain_id: Option<u64>,
}

/// Structured Neo N3 block signing. Hash strings are wire-order bytes, matching
/// the official protobuf `bytes` fields rather than explorer display order.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BlockSignCall {
    pub key_id: String,
    pub network: u32,
    pub public_key: String,
    pub block: BlockFields,
    #[serde(default)]
    pub request_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BlockFields {
    pub header: BlockHeaderFields,
    #[serde(default)]
    pub tx_hashes: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BlockHeaderFields {
    pub version: u32,
    pub prev_hash: String,
    pub merkle_root: String,
    pub timestamp: u64,
    pub nonce: u64,
    pub index: u32,
    pub primary_index: u32,
    pub next_consensus: String,
    #[serde(default)]
    pub prev_state_root: Option<String>,
    #[serde(default)]
    pub state_root_enabled: bool,
}

fn default_chain_family() -> String {
    "neo-n3".to_string()
}

/// `{"key_id": …, "data_hex": …}` for `/sign/raw` — the bytes are signed as
/// they arrive, with no transaction or payload structure around them.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RawSignCall {
    pub key_id: String,
    pub data_hex: String,
    #[serde(default)]
    pub request_id: Option<String>,
}

/// A semantic NeoX oracle-verifier request.  There is deliberately no
/// caller-supplied digest/prehash field: the signer derives both from these
/// exact chain and fulfillment fields.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Eip191FulfillmentCall {
    pub key_id: String,
    pub request_id: String,
    pub chain_id: u64,
    pub oracle_contract: String,
    pub fulfillment: Eip191FulfillmentFields,
    pub result_bytes_hex: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Eip191FulfillmentFields {
    pub request_id: String,
    pub app_id: String,
    pub module_id: String,
    pub operation: String,
    /// Exact request payload bytes, hex encoded with an optional 0x prefix.
    pub payload_hex: String,
    pub success: bool,
    #[serde(default)]
    pub error: String,
}

/// A label and the chain to hold the key for.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct KeyKindCall {
    pub label: String,
    pub network: String,
    #[serde(default = "default_chain_family")]
    pub chain_family: String,
    #[serde(default)]
    pub chain_id: Option<u64>,
    /// The real magic of a private network, when the default does not match the
    /// deployment. Absent — every pre-existing consumer — means the canonical
    /// value for `network`.
    #[serde(default)]
    pub network_magic: Option<u32>,
}

/// A key to take custody of.
///
/// The value is a [`SecretString`] so it is zeroed when the handler returns: a
/// private key that arrives in a body and is dropped normally leaves its bytes
/// in freed memory, which is the same exposure a `core` file or a heap dump
/// gives, and §5.1 promises the plaintext is handled as a secret all the way to
/// the seal. `Debug` is derived because that type redacts: printing this struct
/// is safe, which is what lets a test name a rejected body without putting a key
/// in its output.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ImportCall {
    pub label: String,
    pub network: String,
    #[serde(default = "default_chain_family")]
    pub chain_family: String,
    #[serde(default)]
    pub chain_id: Option<u64>,
    /// The real magic of a private network, when the default does not match the
    /// deployment. Absent — every pre-existing consumer — means the canonical
    /// value for `network`.
    #[serde(default)]
    pub network_magic: Option<u32>,
    pub private_key: SecretString,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Nep2Call {
    pub label: String,
    pub network: String,
    /// The real magic of a private network, when the default does not match the
    /// deployment. Absent — every pre-existing consumer — means the canonical
    /// value for `network`.
    #[serde(default)]
    pub network_magic: Option<u32>,
    /// Already encrypted, and useless without the passphrase — so plain text,
    /// and printable in a diagnostic without a second thought.
    pub nep2: String,
    pub passphrase: SecretString,
}

/// `{"disabled": bool}` for both `state` routes: the switch, in one direction
/// per request.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StateCall {
    pub disabled: bool,
}

/// A caller to provision.
///
/// `capabilities` has no default. A caller that named none would be a credential
/// that answers `admin-capability-missing` forever, and an empty default would be
/// the transport guessing at the one thing §5.1 says is chosen deliberately.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CallerCall {
    pub label: String,
    #[serde(default)]
    pub key_grant: GrantBody,
    pub capabilities: Vec<String>,
    #[serde(default)]
    pub allowed_origins: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkloadCallerCall {
    #[serde(flatten)]
    pub caller: CallerCall,
    pub workload_public_key: String,
    pub workload_subject: Option<String>,
}

/// Which keys a caller may name, on the wire: `{"mode": "any"}` or
/// `{"mode": "only", "key_ids": [...]}`.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields, default)]
pub struct GrantBody {
    pub mode: String,
    pub key_ids: Vec<String>,
}

impl Default for GrantBody {
    fn default() -> Self {
        // `only` with nothing in it, because a grant that arrives by accident has
        // to be the one that lets nothing through.
        GrantBody {
            mode: "only".to_string(),
            key_ids: Vec::new(),
        }
    }
}

impl GrantBody {
    fn to_grant(&self) -> std::result::Result<KeyGrant, &'static str> {
        match self.mode.as_str() {
            "any" if self.key_ids.is_empty() => Ok(KeyGrant::Any),
            "any" => Err("key_grant.mode any takes no key_ids"),
            "only" => Ok(KeyGrant::Only(self.key_ids.clone())),
            _ => Err("key_grant.mode must be any or only"),
        }
    }

    fn from_grant(grant: &KeyGrant) -> Self {
        match grant {
            KeyGrant::Any => GrantBody {
                mode: "any".to_string(),
                key_ids: Vec::new(),
            },
            KeyGrant::Only(ids) => GrantBody {
                mode: "only".to_string(),
                key_ids: ids.clone(),
            },
        }
    }
}

/// A key's boundary, both ways.
///
/// Every field defaults, which is what makes §4.2's "blank means everything
/// closed" true on the wire: a body that names nothing is a boundary that permits
/// nothing, and it is the *stored* result that comes back, so a caller can see
/// what the vault understood rather than what it sent.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields, default)]
pub struct PolicyBody {
    pub allow_consensus: bool,
    pub allow_transfer: bool,
    pub allow_contract_call: bool,
    pub allow_global_scope: bool,
    pub allow_raw: bool,
    pub contract_whitelist: Vec<String>,
    pub contract_blacklist: Vec<String>,
    pub contract_method_whitelist: Vec<ContractMethodBody>,
    pub contract_method_blacklist: Vec<ContractMethodBody>,
    pub asset_whitelist: Vec<String>,
    pub asset_blacklist: Vec<String>,
    pub asset_limits: Vec<AssetLimitBody>,
    pub transfer_to_whitelist: Vec<String>,
    pub transfer_to_blacklist: Vec<String>,
    /// Raw token units as a decimal string. A JSON number cannot carry an `i128`
    /// and a ceiling that silently lost its high digits would be a ceiling an
    /// operator believed in.
    pub max_single_amount: Option<String>,
    pub window_limit: Option<WindowBody>,
    pub max_signers: Option<u16>,
    /// GAS fixed-8 raw units, encoded as text to preserve all `i64` values.
    pub max_system_fee: Option<String>,
    /// GAS fixed-8 raw units, encoded as text to preserve all `i64` values.
    pub max_network_fee: Option<String>,
    /// Key-wide rolling signature ceiling across all three signing routes.
    pub max_signatures: Option<SignatureRateBody>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chain_family: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub evm_max_gas_price: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub evm_max_gas_limit: Option<u64>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub evm_method_whitelist: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub evm_method_blacklist: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub evm_chain_id: Option<u64>,
}

/// One exact contract/method pair in a method-level allow or deny list.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ContractMethodBody {
    pub contract: String,
    pub method: String,
}

/// A rolling window: the ceiling and the span it applies over, always together.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WindowBody {
    pub seconds: u64,
    pub max_amount: String,
}

/// A key-wide rolling signature count and its period.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SignatureRateBody {
    pub seconds: u64,
    pub count: u64,
}

/// Amount ceilings scoped to one token contract.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AssetLimitBody {
    pub asset: String,
    pub max_single_amount: Option<String>,
    pub window_limit: Option<WindowBody>,
}

impl PolicyBody {
    fn to_policy(&self) -> std::result::Result<SignerPolicy, &'static str> {
        Ok(SignerPolicy {
            allow_consensus: self.allow_consensus,
            allow_raw: self.allow_raw,
            allow_transfer: self.allow_transfer,
            allow_contract_call: self.allow_contract_call,
            allow_global_scope: self.allow_global_scope,
            contract_whitelist: parse_hashes(&self.contract_whitelist, "contract_whitelist")?,
            contract_blacklist: parse_hashes(&self.contract_blacklist, "contract_blacklist")?,
            contract_method_whitelist: parse_contract_methods(
                &self.contract_method_whitelist,
                "contract_method_whitelist",
            )?,
            contract_method_blacklist: parse_contract_methods(
                &self.contract_method_blacklist,
                "contract_method_blacklist",
            )?,
            asset_whitelist: parse_hashes(&self.asset_whitelist, "asset_whitelist")?,
            asset_blacklist: parse_hashes(&self.asset_blacklist, "asset_blacklist")?,
            asset_limits: parse_asset_limits(&self.asset_limits)?,
            transfer_to_whitelist: parse_hashes(
                &self.transfer_to_whitelist,
                "transfer_to_whitelist",
            )?,
            transfer_to_blacklist: parse_hashes(
                &self.transfer_to_blacklist,
                "transfer_to_blacklist",
            )?,
            max_single_amount: parse_amount(
                self.max_single_amount.as_deref(),
                "max_single_amount",
            )?,
            window_limit: match &self.window_limit {
                Some(window) => Some(WindowLimit {
                    seconds: window.seconds,
                    max_amount: parse_amount_value(&window.max_amount, "window_limit")?,
                }),
                None => None,
            },
            max_signers: self.max_signers,
            max_system_fee: parse_fee(self.max_system_fee.as_deref(), "max_system_fee")?,
            max_network_fee: parse_fee(self.max_network_fee.as_deref(), "max_network_fee")?,
            max_signatures: self
                .max_signatures
                .as_ref()
                .map(|limit| SignatureRateLimit {
                    seconds: limit.seconds,
                    count: limit.count,
                }),
            chain_family: match self.chain_family.as_deref() {
                Some("neo-n3") | Some("neo_n3") | Some("n3") | Some("NeoN3") => {
                    Some(ChainFamily::NeoN3)
                }
                Some("neox") | Some("NeoX") => Some(ChainFamily::NeoX),
                Some(_) => return Err("invalid chain_family: must be 'neo-n3' or 'neox'"),
                None => None,
            },
            evm_max_gas_price: match &self.evm_max_gas_price {
                Some(s) => Some(s.parse::<u128>().map_err(|_| "invalid evm_max_gas_price")?),
                None => None,
            },
            evm_max_gas_limit: self.evm_max_gas_limit,
            evm_method_whitelist: self.evm_method_whitelist.clone(),
            evm_method_blacklist: self.evm_method_blacklist.clone(),
            evm_chain_id: self.evm_chain_id,
        })
    }

    fn from_policy(policy: &SignerPolicy) -> Self {
        PolicyBody {
            allow_consensus: policy.allow_consensus,
            allow_raw: policy.allow_raw,
            allow_transfer: policy.allow_transfer,
            allow_contract_call: policy.allow_contract_call,
            allow_global_scope: policy.allow_global_scope,
            contract_whitelist: display_hashes(&policy.contract_whitelist),
            contract_blacklist: display_hashes(&policy.contract_blacklist),
            contract_method_whitelist: display_contract_methods(&policy.contract_method_whitelist),
            contract_method_blacklist: display_contract_methods(&policy.contract_method_blacklist),
            asset_whitelist: display_hashes(&policy.asset_whitelist),
            asset_blacklist: display_hashes(&policy.asset_blacklist),
            asset_limits: display_asset_limits(&policy.asset_limits),
            transfer_to_whitelist: display_hashes(&policy.transfer_to_whitelist),
            transfer_to_blacklist: display_hashes(&policy.transfer_to_blacklist),
            max_single_amount: policy.max_single_amount.map(|amount| amount.to_string()),
            window_limit: policy.window_limit.map(|limit| WindowBody {
                seconds: limit.seconds,
                max_amount: limit.max_amount.to_string(),
            }),
            max_signers: policy.max_signers,
            max_system_fee: policy.max_system_fee.map(|fee| fee.to_string()),
            max_network_fee: policy.max_network_fee.map(|fee| fee.to_string()),
            max_signatures: policy.max_signatures.map(|limit| SignatureRateBody {
                seconds: limit.seconds,
                count: limit.count,
            }),
            chain_family: policy.chain_family.map(|cf| match cf {
                ChainFamily::NeoN3 => "neo-n3".to_string(),
                ChainFamily::NeoX => "neox".to_string(),
            }),
            evm_max_gas_price: policy.evm_max_gas_price.map(|p| p.to_string()),
            evm_max_gas_limit: policy.evm_max_gas_limit,
            evm_method_whitelist: policy.evm_method_whitelist.clone(),
            evm_method_blacklist: policy.evm_method_blacklist.clone(),
            evm_chain_id: policy.evm_chain_id,
        }
    }
}

fn parse_hashes(
    values: &[String],
    field: &'static str,
) -> std::result::Result<Vec<ScriptHash>, &'static str> {
    values
        .iter()
        .map(|value| ScriptHash::from_str(value).map_err(|_| field))
        .collect()
}

fn parse_contract_methods(
    values: &[ContractMethodBody],
    field: &'static str,
) -> std::result::Result<Vec<ContractMethod>, &'static str> {
    values
        .iter()
        .map(|value| {
            let method = value.method.trim();
            if method.is_empty() || method.len() > 128 {
                return Err(field);
            }
            Ok(ContractMethod {
                contract: ScriptHash::from_str(&value.contract).map_err(|_| field)?,
                method: method.to_string(),
            })
        })
        .collect()
}

fn parse_asset_limits(
    values: &[AssetLimitBody],
) -> std::result::Result<Vec<AssetLimit>, &'static str> {
    values
        .iter()
        .map(|value| {
            Ok(AssetLimit {
                asset: ScriptHash::from_str(&value.asset).map_err(|_| "asset_limits")?,
                max_single_amount: parse_amount(
                    value.max_single_amount.as_deref(),
                    "asset_limits",
                )?,
                window_limit: match &value.window_limit {
                    Some(window) => Some(WindowLimit {
                        seconds: window.seconds,
                        max_amount: parse_amount_value(&window.max_amount, "asset_limits")?,
                    }),
                    None => None,
                },
            })
        })
        .collect()
}

fn display_asset_limits(values: &[AssetLimit]) -> Vec<AssetLimitBody> {
    values
        .iter()
        .map(|value| AssetLimitBody {
            asset: value.asset.to_display(),
            max_single_amount: value.max_single_amount.map(|amount| amount.to_string()),
            window_limit: value.window_limit.map(|window| WindowBody {
                seconds: window.seconds,
                max_amount: window.max_amount.to_string(),
            }),
        })
        .collect()
}

fn display_contract_methods(values: &[ContractMethod]) -> Vec<ContractMethodBody> {
    values
        .iter()
        .map(|value| ContractMethodBody {
            contract: value.contract.to_display(),
            method: value.method.clone(),
        })
        .collect()
}

fn parse_fee(
    value: Option<&str>,
    field: &'static str,
) -> std::result::Result<Option<i64>, &'static str> {
    value
        .map(|raw| raw.parse::<i64>().ok().filter(|fee| *fee >= 0).ok_or(field))
        .transpose()
}

/// Amounts are accepted as decimal text only: no JSON number, no exponent, no
/// float that rounds `1` down to `0` somewhere in a client's parser.
fn parse_amount(
    value: Option<&str>,
    field: &'static str,
) -> std::result::Result<Option<i128>, &'static str> {
    value.map(|raw| parse_amount_value(raw, field)).transpose()
}

/// The required form: a window ceiling has no meaning without an amount beside
/// its span, so the field is present or the body is wrong.
fn parse_amount_value(value: &str, field: &'static str) -> std::result::Result<i128, &'static str> {
    value.trim().parse::<i128>().map_err(|_| field)
}

fn display_hashes(hashes: &[ScriptHash]) -> Vec<String> {
    hashes.iter().copied().map(ScriptHash::to_display).collect()
}

fn parse_network(value: &str) -> std::result::Result<Network, Box<Response>> {
    Network::from_str(value).map_err(|_| Box::new(unreadable(Some(NETWORK_PROBLEM))))
}

fn parse_chain_family(value: &str) -> std::result::Result<ChainFamily, Box<Response>> {
    ChainFamily::from_str(value.trim())
        .map_err(|_| Box::new(unreadable(Some("chain_family must be 'neo-n3' or 'neox'"))))
}

fn requested_key_chain_id(
    chain_family: ChainFamily,
    chain_id: Option<u64>,
    network_magic: Option<u32>,
) -> std::result::Result<Option<u64>, Box<Response>> {
    match chain_family {
        ChainFamily::NeoN3 if chain_id.is_some() => Err(Box::new(unreadable(Some(
            "chain_id is valid only when chain_family is 'neox'",
        )))),
        ChainFamily::NeoN3 => Ok(network_magic.map(u64::from)),
        ChainFamily::NeoX if network_magic.is_some() => Err(Box::new(unreadable(Some(
            "network_magic is valid only when chain_family is 'neo-n3'",
        )))),
        ChainFamily::NeoX => Ok(chain_id),
    }
}

fn parse_capabilities(
    values: &[String],
) -> std::result::Result<Vec<CallerCapability>, &'static str> {
    values
        .iter()
        .map(|value| CallerCapability::from_str(value).map_err(|_| "capabilities"))
        .collect()
}

// -- response shapes ------------------------------------------------------

#[derive(Serialize)]
struct AllowedReply<T: Serialize> {
    allowed: bool,
    #[serde(flatten)]
    body: T,
}

/// The only body a denial ever has: §5's shape, which is [`Refusal`] with
/// `detail` and `outcome` removed.
#[derive(Serialize)]
struct RefusalReply {
    allowed: bool,
    code: &'static str,
    message: String,
}

/// A witness, flattened exactly as §5 specifies it.
#[derive(Serialize)]
struct SignatureBody {
    key_id: String,
    script_hash: String,
    address: String,
    digest: String,
    invocation_script: String,
    verification_script: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    chain_family: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    signed_transaction: Option<String>,
    /// Deprecated compatibility alias for `signed_transaction`.
    #[serde(skip_serializing_if = "Option::is_none")]
    signature_hex: Option<String>,
}

/// `/sign/raw`'s witness: the §5 fields plus the bare signature and the
/// public key, the two things a raw caller verifies against without ever
/// rebuilding a Neo witness.
#[derive(Serialize)]
struct RawSignatureBody {
    key_id: String,
    script_hash: String,
    address: String,
    digest: String,
    signature: String,
    public_key: String,
    invocation_script: String,
    verification_script: String,
}

#[derive(Serialize)]
struct Eip191FulfillmentBody {
    key_id: String,
    address: String,
    public_key: String,
    digest: String,
    message_hash: String,
    signature: String,
    chain_family: &'static str,
    chain_id: u64,
    oracle_contract: String,
}

#[derive(Serialize)]
struct KeyBody {
    key_id: String,
    label: String,
    network: String,
    chain_family: String,
    chain_id: u64,
    network_magic: u32,
    public_key: String,
    script_hash: String,
    address: String,
    verification_script: String,
    signing_enabled: bool,
}

#[derive(Serialize)]
struct KeysBody {
    keys: Vec<KeyBody>,
}

#[derive(Serialize)]
struct KeyPolicyBody {
    #[serde(flatten)]
    key: KeyBody,
    problems: Vec<PolicyAdvice>,
    policy: PolicyBody,
}

#[derive(Serialize)]
struct PolicyResponseBody {
    problems: Vec<PolicyAdvice>,
    policy: PolicyBody,
}

/// One advisory finding about a stored boundary: a shape that is legal to save and
/// will not enforce what it looks like it enforces.
///
/// Advice, never a refusal — `SignerPolicy::problems` runs on boundaries the
/// service will sign under, because an operator who means "no per-transfer ceiling"
/// must be able to say so. The pair is here so a consumer can branch on `code` and
/// speak in `message` without either half becoming a string it has to parse.
#[derive(Serialize)]
struct PolicyAdvice {
    code: &'static str,
    message: String,
}

#[derive(Serialize)]
struct CallerBody {
    id: String,
    label: String,
    auth_mode: String,
    workload_public_key: Option<String>,
    workload_subject: Option<String>,
    key_grant: GrantBody,
    capabilities: Vec<String>,
    allowed_origins: Vec<String>,
    created_at_unix: u64,
    disabled: bool,
}

#[derive(Serialize)]
struct CallersBody {
    callers: Vec<CallerBody>,
}

/// `POST /callers`' answer: the record and the credential, in the one response
/// either ever appears in.
#[derive(Serialize)]
struct CreatedCallerBody {
    caller: CallerBody,
    token: String,
}

#[derive(Serialize)]
struct CreatedWorkloadCallerBody {
    caller: CallerBody,
}

#[derive(Serialize)]
struct RotatedCallerBody {
    caller_id: String,
    token: String,
}

/// A delete route's answer: which id is gone. Echoed because the caller may have
/// sent an id that was already absent, and `allowed: true` with no id beside it
/// would leave "did my delete land, and on what" unanswered.
#[derive(Serialize)]
struct RemovedKeyBody {
    key_id: String,
}

#[derive(Serialize)]
struct RemovedCallerBody {
    caller_id: String,
}

#[derive(Serialize)]
struct AuditBody {
    entries: Vec<AuditRow>,
}

#[derive(Serialize)]
struct AuditRow {
    id: i64,
    recorded_at_unix: u64,
    action: String,
    outcome: String,
    caller_id: Option<String>,
    key_id: Option<String>,
    tx_id: Option<String>,
    reason: Option<String>,
    detail: Option<String>,
    origin: Option<String>,
}

fn signature_body(witness: SignedWitness) -> SignatureBody {
    let signed_transaction = witness.signed_transaction.clone();
    SignatureBody {
        key_id: witness.key_id.clone(),
        script_hash: witness.script_hash.to_string(),
        address: witness.address.clone(),
        digest: witness.digest.clone(),
        invocation_script: hex::encode(&witness.invocation),
        verification_script: hex::encode(&witness.verification),
        chain_family: witness.chain_family.map(|family| family.to_string()),
        signed_transaction,
        signature_hex: witness.signature_hex.clone(),
    }
}

fn raw_signature_body(witness: SignedWitness) -> RawSignatureBody {
    // The bare signature and public key are sliced back out of the two pinned
    // scripts (`0c40 <64B sig>`, `0c21 <33B pubkey> …`) rather than widening
    // [`SignedWitness`] with fields that duplicate the script bytes a caller
    // already receives.
    RawSignatureBody {
        key_id: witness.key_id.clone(),
        script_hash: witness.script_hash.to_string(),
        address: witness.address.clone(),
        digest: witness.digest.clone(),
        signature: witness
            .invocation
            .get(2..66)
            .map(hex::encode)
            .unwrap_or_default(),
        public_key: witness
            .verification
            .get(2..35)
            .map(hex::encode)
            .unwrap_or_default(),
        invocation_script: hex::encode(&witness.invocation),
        verification_script: hex::encode(&witness.verification),
    }
}

fn eip191_fulfillment_body(signature: SignedEip191Fulfillment) -> Eip191FulfillmentBody {
    Eip191FulfillmentBody {
        key_id: signature.key_id,
        address: signature.address,
        public_key: signature.public_key,
        digest: signature.digest,
        message_hash: signature.message_hash,
        signature: signature.signature,
        chain_family: "neox",
        chain_id: signature.chain_id,
        oracle_contract: signature.oracle_contract,
    }
}

/// The shapes a stored boundary can have that are legal and still weaker than
/// they look.
///
/// [`SignerPolicy::problems`] decides the list, and it is the service's own
/// judgement rather than a check any caller can redo: a consumer that recomputed it
/// from the reply would hold a second copy of the rules, and the two would drift in
/// whichever direction nobody remembered to test. So the advice travels with the
/// boundary it describes, on the read as well as the write — the read is the page
/// that shows an operator what a boundary saved earlier actually means.
fn advice(policy: &SignerPolicy) -> Vec<PolicyAdvice> {
    policy
        .problems()
        .into_iter()
        .map(|problem| PolicyAdvice {
            code: problem.code(),
            message: problem.to_string(),
        })
        .collect()
}

fn key_body(info: KeyPublicInfo) -> KeyBody {
    KeyBody {
        key_id: info.key_id.clone(),
        label: info.label.clone(),
        network: info.network.to_string(),
        chain_family: info.chain_family.to_string(),
        chain_id: info.chain_id,
        network_magic: info.network_magic,
        public_key: hex::encode(info.public_key),
        script_hash: info.script_hash.to_string(),
        address: info.address.clone(),
        verification_script: hex::encode(&info.verification_script),
        signing_enabled: info.signing_enabled,
    }
}

fn caller_body(info: CallerInfo) -> CallerBody {
    CallerBody {
        id: info.id.clone(),
        label: info.label.clone(),
        auth_mode: info.auth_mode.clone(),
        workload_public_key: info.workload_public_key.clone(),
        workload_subject: info.workload_subject.clone(),
        key_grant: GrantBody::from_grant(&info.key_grant),
        capabilities: info
            .capabilities
            .iter()
            .map(|capability| capability.label().to_string())
            .collect(),
        allowed_origins: info.allowed_origins.clone(),
        created_at_unix: info.created_at_unix,
        disabled: info.disabled,
    }
}

fn audit_row(record: SignerAuditRecord) -> AuditRow {
    AuditRow {
        id: record.id,
        recorded_at_unix: record.recorded_at_unix,
        action: record.action.label().to_string(),
        outcome: record.outcome.label().to_string(),
        caller_id: record.caller_id.clone(),
        key_id: record.key_id.clone(),
        tx_id: record.tx_id.clone(),
        reason: record.reason.clone(),
        detail: record.detail.clone(),
        origin: record.origin.clone(),
    }
}

/// A `String` that erases itself.
///
/// `Zeroizing<String>` would be the same thing with one less degree of freedom:
/// `Deserialize` is not implemented for it, so the secret would have to arrive as
/// an ordinary `String` and be moved, and the bytes would be in a buffer the
/// compiler is free to clone. Here the text is decoded straight into the type
/// that owns it, and that type is the only place it exists.
pub struct SecretString(String);

impl std::fmt::Debug for SecretString {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("<redacted>")
    }
}

impl<'de> Deserialize<'de> for SecretString {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        String::deserialize(deserializer).map(SecretString)
    }
}

impl SecretString {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl Drop for SecretString {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

#[cfg(test)]
#[path = "../tests/unit/api.rs"]
mod tests;
