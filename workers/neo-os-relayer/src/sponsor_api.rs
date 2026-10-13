//! The sponsor HTTP surface: request framing, the status map, and the wiring of
//! the real journal.
//!
//! The route is `POST /sponsor/intent`, optionally behind one network prefix
//! segment (`/testnet/sponsor/intent`), matching the host route convention
//! `workers/nitro-enclave-host/src/routes.rs` defines.
//!
//! Two framing rules are the whole security posture of this surface:
//!
//! * **The body has no principal field.** The principal arrives from the
//!   authenticated hop in front of this service and is handed in as a typed
//!   value. A request without one is refused. Nothing can be declared by a
//!   client and believed here.
//! * **The body has no fee, contract or method field.** Those are read out of
//!   the unsigned transaction envelope, which is the thing that will be signed
//!   and broadcast. Extra JSON fields are ignored rather than honoured.

use std::sync::Arc;

use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use neo_os_relayer_store::delivery::{DeliveryJob, DeliveryStore};
use neo_os_relayer_store::{HttpTransport, SupabaseClient};
use serde_json::{json, Value};

use crate::sponsor::{
    JournalError, Principal, Reservation, SponsorApi, SponsorCode, SponsorIntentRequest,
    SponsorJob, SponsorJournal, SponsorRefusal, SponsorResult, SponsorSettings, SponsorSubmit,
};
use crate::sponsor_submit::ChainSubmit;
use crate::transport::RelayerHttpTransport;

/// The wired surface `serve_configured` builds: a real journal over the
/// blocking transport and a real chain submit over the same transport.
type WiredSponsorApi = SponsorApi<
    DbSponsorJournal<RelayerHttpTransport>,
    ChainSubmit<RelayerHttpTransport, RelayerHttpTransport>,
>;

/// What `prepare` hands back to the async server: the surface, the principal
/// source, and the bind address.
type PreparedSponsor = (Arc<WiredSponsorApi>, Arc<dyn PrincipalSource>, String, u16);

/// What the surface is given. Assembled by whoever authenticates the request;
/// nothing here is read out of the body except `body`.
#[derive(Debug, Clone)]
pub struct SponsorHttpRequest {
    pub principal: Option<Principal>,
    pub idempotency_key: Option<String>,
    /// The raw request body.
    pub body: String,
}

/// One answer, in the two shapes the row names: a journal id and a receipt, or
/// a stable refusal code.
#[derive(Debug, Clone, PartialEq)]
pub struct ApiResponse {
    pub status: u16,
    pub body: Value,
}

/// Where the authenticated principal comes from.
///
/// The gap row for this lane names `ACCESS PrincipalAssertion (web)` as a
/// dependency of the whole sponsor surface, and this repository holds no
/// assertion verifier. Until one exists, the principal is whatever the
/// **authenticating hop in front of this service** established — the edge
/// gateway and control plane authenticate a service key and forward to the
/// execution plane (`deploy/cloudflare/morpheus-control-plane/lib/execution-plane.js`),
/// which is where a client identity becomes a principal. This port is the seam
/// that binding sits behind, so replacing the hop header with a verified
/// assertion is one type and not a rewrite.
pub trait PrincipalSource: Send + Sync {
    fn resolve(&self, headers: &HeaderMap) -> Option<Principal>;
}

/// The hop-header binding. The header is only meaningful behind a hop that
/// overwrites it; exposed directly, this source is not a claim of authentication
/// and must not be deployed without that hop.
#[derive(Debug, Clone)]
pub struct HopPrincipal {
    /// Lowercase header name, e.g. `x-neoos-principal`.
    pub header: String,
}

impl HopPrincipal {
    pub fn new(header: impl Into<String>) -> HopPrincipal {
        HopPrincipal {
            header: header.into().to_ascii_lowercase(),
        }
    }
}

impl PrincipalSource for HopPrincipal {
    fn resolve(&self, headers: &HeaderMap) -> Option<Principal> {
        let value = headers.get(&self.header)?.to_str().ok()?.trim();
        // `Principal::new` refuses anything that is not a UUID, so a malformed
        // hop value is a missing principal rather than a trusted one.
        Principal::new(value).ok()
    }
}

/// A source that never produces a principal. The default for a surface that has
/// not been given an authenticated hop, so the route fails closed.
#[derive(Debug, Clone, Copy, Default)]
pub struct NoPrincipal;

impl PrincipalSource for NoPrincipal {
    fn resolve(&self, _headers: &HeaderMap) -> Option<Principal> {
        None
    }
}

/// The idempotency key the caller sent. `Idempotency-Key` is the conventional
/// spelling; `x-idempotency-key` is accepted because the existing edge guards
/// read both (`workers/nitro-worker/src/platform/request-guards.js`).
pub fn idempotency_key_from_headers<'a>(
    headers: impl IntoIterator<Item = (&'a str, &'a str)>,
) -> Option<String> {
    for (name, value) in headers {
        let name = name.to_ascii_lowercase();
        if name == "idempotency-key" || name == "x-idempotency-key" {
            let value = value.trim();
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}

/// Handle one request. Order is [`SponsorApi::submit`]'s; this only frames it.
pub fn handle<J: SponsorJournal, S: SponsorSubmit>(
    api: &SponsorApi<J, S>,
    request: &SponsorHttpRequest,
) -> ApiResponse {
    let idempotency_key = request
        .idempotency_key
        .as_deref()
        .unwrap_or_default()
        .to_string();
    let body = match parse_body(&request.body) {
        Ok(body) => body,
        Err(refusal) => return respond(SponsorResult::Refused(refusal)),
    };
    respond(api.submit(
        request.principal.as_ref(),
        &SponsorIntentRequest {
            idempotency_key,
            envelope_hex: body,
        },
    ))
}

/// Read the one field this surface honours. Anything else in the object is
/// ignored on purpose: a declared `principal` or `fee_ceiling_units` must not
/// be able to become a fact.
fn parse_body(body: &str) -> Result<String, SponsorRefusal> {
    let invalid = |detail: &str| SponsorRefusal {
        code: SponsorCode::RequestInvalid,
        detail: detail.to_string(),
        intent_code: None,
    };
    let parsed: Value =
        serde_json::from_str(body).map_err(|_| invalid("the body must be a JSON object"))?;
    let object = parsed
        .as_object()
        .ok_or_else(|| invalid("the body must be a JSON object"))?;
    let envelope = object
        .get("envelope_hex")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("the body must carry `envelope_hex` as a string"))?;
    Ok(envelope.to_string())
}

/// Map a result to a status and a body. The body never carries a field the
/// request supplied.
pub fn respond(result: SponsorResult) -> ApiResponse {
    match result {
        SponsorResult::Accepted(accepted) => ApiResponse {
            status: match accepted.code {
                SponsorCode::SubmissionUnknown => 202,
                _ => 200,
            },
            body: json!({
                "code": accepted.code.as_str(),
                "journal_id": accepted.journal_id,
                "tx_hash": accepted.tx_hash,
                "vm_state": accepted.vm_state,
                "transaction_fee_units": accepted.fee.transaction_fee_units,
                "reimbursement_units": accepted.fee.reimbursement_units,
                "sponsor_fee_units": accepted.fee.sponsor_fee_units,
                "replayed": accepted.replayed,
            }),
        },
        SponsorResult::Refused(refused) => {
            let mut body = json!({
                "code": refused.code.as_str(),
                "detail": refused.detail,
            });
            if let Some(intent_code) = refused.intent_code {
                body["intent_code"] = json!(intent_code);
            }
            ApiResponse {
                status: status_for(refused.code),
                body,
            }
        }
    }
}

fn status_for(code: SponsorCode) -> u16 {
    match code {
        SponsorCode::PrincipalRequired => 401,
        SponsorCode::IdempotencyConflict => 409,
        SponsorCode::BudgetExhausted => 429,
        SponsorCode::Disabled => 503,
        SponsorCode::JournalRefused | SponsorCode::ReceiptMismatch => 500,
        SponsorCode::SendRefused => 502,
        // `SPONSOR_REQUEST_INVALID` and `SPONSOR_IDEMPOTENCY_KEY_REQUIRED`
        SponsorCode::RequestInvalid | SponsorCode::IdempotencyKeyRequired => 400,
        // Accepted outcomes never reach here.
        SponsorCode::Confirmed | SponsorCode::Faulted | SponsorCode::SubmissionUnknown => 200,
    }
}

// ---------------------------------------------------------------------------
// The real journal
// ---------------------------------------------------------------------------

/// [`SponsorJournal`] over the delivery schema.
///
/// `morpheus_delivery_sponsor_reserve` is the only writer of a sponsor intent
/// and of every budget counter, and it journals the intent, debits the budgets
/// and enqueues the bound job in one database transaction. That single call is
/// the idempotency key's meaning: an identical retry returns the original job
/// and charges nothing.
///
/// Stage writes go through `morpheus_delivery_transition`, which requires the
/// caller to hold the job's lease. [`DbSponsorJournal`] takes that lease on
/// reservation so a request can finish its own commit protocol, exactly as the
/// relayer's claim loop does.
pub struct DbSponsorJournal<T: HttpTransport> {
    pub client: SupabaseClient<T>,
    pub owner: String,
    pub lease_ms: u64,
    /// The account whose nonce the sponsor key consumes, matching the
    /// reservation's `account_scope`. Claiming is per that account so one
    /// sponsor key has at most one in-flight transaction, which is what keeps
    /// its nonce from racing.
    pub account_scope: String,
}

impl<T: HttpTransport> DbSponsorJournal<T> {
    fn store(&self) -> DeliveryStore<'_, T> {
        DeliveryStore {
            client: &self.client,
        }
    }

    fn now_ms(&self) -> u64 {
        crate::relayer::now_ms() as u64
    }
}

impl<T: HttpTransport> SponsorJournal for DbSponsorJournal<T> {
    fn reserve(&self, reservation: &Reservation) -> Result<SponsorJob, JournalError> {
        let now_ms = self.now_ms();
        let job = self
            .store()
            .sponsor_reserve(reservation, now_ms)
            .map_err(classify)?;
        let claimed = self
            .store()
            .claim(
                "neo_n3",
                &self.account_scope,
                &self.owner,
                self.lease_ms,
                now_ms,
                &["sponsor"],
            )
            .map_err(classify)?
            .filter(|claimed| claimed.job_key == job.job_key)
            .ok_or_else(|| {
                JournalError::Refused(
                    "the reserved sponsor job could not be leased for its own commit".to_string(),
                )
            })?;
        Ok(sponsor_job(claimed, reservation))
    }

    fn stage(&self, job: &SponsorJob, op: &str, data: Value) -> Result<SponsorJob, JournalError> {
        let durable = DeliveryJob {
            job_key: job.job_key.clone(),
            generation: job.generation,
            attempts: 0,
            event: json!({}),
            journal: job.journal.clone(),
            status: neo_os_relayer_store::delivery::DeliveryStatus::Queued,
            kind: "sponsor".to_string(),
            contract: job.contract.clone(),
            chain: "neo_n3".to_string(),
        };
        let updated = self
            .store()
            .sponsor_stage(
                &durable,
                &self.owner,
                op,
                data,
                self.lease_ms,
                self.now_ms(),
            )
            .map_err(classify)?;
        Ok(SponsorJob {
            job_key: updated.job_key,
            generation: updated.generation,
            status: updated.status.as_str().to_string(),
            journal: updated.journal,
            intent: job.intent.clone(),
            contract: job.contract.clone(),
            fee_ceiling_units: job.fee_ceiling_units,
        })
    }
}

fn sponsor_job(job: DeliveryJob, reservation: &Reservation) -> SponsorJob {
    SponsorJob {
        job_key: job.job_key,
        generation: job.generation,
        status: job.status.as_str().to_string(),
        journal: job.journal,
        intent: reservation.intent.clone(),
        contract: reservation.contract.clone(),
        fee_ceiling_units: reservation.fee_ceiling_units,
    }
}

/// The store's refusals are SQLSTATE text. The two the caller can act on are
/// named in CU-91's contract; everything else is a refusal of the durable
/// record and is reported as one.
fn classify(error: String) -> JournalError {
    if error.contains("sponsor idempotency conflict") {
        JournalError::Conflict
    } else if error.contains("budget exceeded") {
        JournalError::BudgetExhausted
    } else {
        JournalError::Refused(error)
    }
}

// ---------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------

/// Shared state for the route handlers. Both fields are `Arc`, so the state is
/// cloneable without requiring the journal or the send port to be.
pub struct SponsorState<J, S> {
    pub api: Arc<SponsorApi<J, S>>,
    pub principals: Arc<dyn PrincipalSource>,
}

impl<J, S> Clone for SponsorState<J, S> {
    fn clone(&self) -> Self {
        SponsorState {
            api: Arc::clone(&self.api),
            principals: Arc::clone(&self.principals),
        }
    }
}

/// The sponsor router. One route, one method, and a single-segment network
/// prefix, matching the host's `matches_route` rule.
pub fn router<J, S>(api: Arc<SponsorApi<J, S>>, principals: Arc<dyn PrincipalSource>) -> Router
where
    J: SponsorJournal + Send + Sync + 'static,
    S: SponsorSubmit + Send + Sync + 'static,
{
    Router::new()
        .route("/sponsor/intent", post(submit_intent))
        .route("/{network}/sponsor/intent", post(submit_intent))
        .with_state(SponsorState { api, principals })
}

async fn submit_intent<J, S>(
    State(state): State<SponsorState<J, S>>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response
where
    J: SponsorJournal + Send + Sync + 'static,
    S: SponsorSubmit + Send + Sync + 'static,
{
    let idempotency_key = idempotency_key_from_headers(
        headers
            .iter()
            .filter_map(|(name, value)| Some((name.as_str(), value.to_str().ok()?))),
    );
    let request = SponsorHttpRequest {
        principal: state.principals.resolve(&headers),
        idempotency_key,
        body: String::from_utf8_lossy(&body).into_owned(),
    };
    // The journal and the send are blocking clients. Running them inside the
    // handler's own poll would block the executor and can panic inside
    // `reqwest::blocking`; the work therefore runs on a blocking task.
    let api = Arc::clone(&state.api);
    let response = match tokio::task::spawn_blocking(move || handle(&api, &request)).await {
        Ok(response) => response,
        Err(error) => ApiResponse {
            status: 500,
            body: json!({
                "code": SponsorCode::JournalRefused.as_str(),
                "detail": format!("the sponsor request task failed: {error}"),
            }),
        },
    };
    (
        StatusCode::from_u16(response.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        [(header::CONTENT_TYPE, "application/json")],
        Json(response.body),
    )
        .into_response()
}

/// Start the sponsor API.
pub async fn serve<J, S>(
    host: &str,
    port: u16,
    api: Arc<SponsorApi<J, S>>,
    principals: Arc<dyn PrincipalSource>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>>
where
    J: SponsorJournal + Send + Sync + 'static,
    S: SponsorSubmit + Send + Sync + 'static,
{
    let addr = format!("{host}:{port}");
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    tracing::info!(
        host,
        port,
        route = "/sponsor/intent",
        "sponsor API listening"
    );
    axum::serve(listener, router(api, principals))
        .with_graceful_shutdown(async {
            let reason = neo_os_service_runtime::shutdown_signal().await;
            tracing::info!(?reason, "Stopping the sponsor API");
        })
        .await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

/// Wire the sponsor API from the relayer configuration and serve it.
///
/// Configuration, all under `sponsor` unless noted:
///
/// | key | meaning |
/// | --- | --- |
/// | `host`, `port` | where the route listens (`127.0.0.1:9465` by default) |
/// | `contract` | the one sponsorable contract, `0x` + 40 hex, display order |
/// | `feeCeilingUnits` | the approved ceiling for one intent, GAS datoshi |
/// | `enabled` | the kill switch, **`false` unless explicitly set** |
/// | `leaseMs` | the delivery lease a request takes for its own commit |
/// | `confirmAttempts`, `confirmWaitMs` | application-log polling |
/// | `principalHeader` | the hop header carrying the principal (`x-neoos-principal`) |
/// | `custodyKeyId` | the sponsor signing key, under `neo_n3.custodyKeyIds` by default |
///
/// The sponsor account the transaction must name is derived from the custody
/// key identity at startup, so there is no second place to configure it.
pub async fn serve_configured(
    config: &crate::config::RelayerConfig,
    transport: &RelayerHttpTransport,
) -> Result<(), String> {
    // Every leg of the wiring below is a blocking HTTP call into the custody
    // service and the delivery store. A blocking client may not be used in the
    // middle of a future's poll, so the whole assembly runs on a thread that is
    // allowed to block and only the server itself stays asynchronous.
    let config = config.clone();
    let transport = transport.clone();
    let prepared = tokio::task::spawn_blocking(move || prepare(&config, &transport))
        .await
        .map_err(|error| format!("sponsor wiring task failed: {error}"))??;
    let (api, principals, host, port) = prepared;
    serve(&host, port, api, principals)
        .await
        .map_err(|error| error.to_string())
}

/// Assemble the sponsor surface. Blocking: custody identity, delivery client
/// and RPC construction all talk HTTP.
fn prepare(
    config: &crate::config::RelayerConfig,
    transport: &RelayerHttpTransport,
) -> Result<PreparedSponsor, String> {
    let settings = settings_from(config)?;
    let sponsor = config
        .raw
        .get("sponsor")
        .cloned()
        .unwrap_or_else(|| json!({}));

    let client = crate::durable_v2::client(config, transport)?;
    let owner = config.instance_id.clone();
    let lease_ms = unsigned(&sponsor, "leaseMs", 60_000).clamp(3_000, 300_000);

    let nitro = config
        .raw
        .get("nitro")
        .and_then(Value::as_object)
        .ok_or("relayer configuration is missing nitro")?;
    let connection = neo_os_chain_n3::custody::CustodyConnection::new(
        required(nitro, "custodyUrl", "custody signer service URL")?,
        required(nitro, "custodyToken", "custody signer service token")?,
        nitro
            .get("timeoutMs")
            .and_then(Value::as_u64)
            .filter(|value| *value > 0),
    )
    .map_err(|error| error.to_string())?;
    let custody = neo_os_chain_n3::custody::CustodyClient::new(transport.clone(), connection);

    let n3 = config
        .raw
        .get("neo_n3")
        .and_then(Value::as_object)
        .ok_or("relayer configuration is missing neo_n3")?;
    let key_id = match n3
        .get("custodyKeyIds")
        .and_then(Value::as_object)
        .and_then(|keys| keys.get("sponsor"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(value) => value.to_string(),
        None => required(nitro, "sponsorCustodyKeyId", "sponsor custody key id")?,
    };
    let signer =
        neo_os_chain_n3::tx::resolve_signer(&custody, &key_id).map_err(|e| e.to_string())?;
    let account_scope = signer.script_hash.trim().to_ascii_lowercase();

    let rpc_urls = crate::delivery::string_array(n3.get("rpcUrls"));
    if rpc_urls.is_empty() {
        return Err("Neo N3 RPC URLs are not configured".to_string());
    }
    let rpc = crate::config::n3_rpc(config, transport.clone(), rpc_urls, !cfg!(test))
        .map_err(|error| error.to_string())?;

    let api = Arc::new(SponsorApi {
        settings,
        journal: DbSponsorJournal {
            client,
            owner,
            lease_ms,
            account_scope: account_scope.clone(),
        },
        submit: ChainSubmit {
            custody,
            signer,
            rpc,
            confirm_attempts: unsigned(&sponsor, "confirmAttempts", 5).clamp(1, 100) as u32,
            confirm_wait_ms: unsigned(&sponsor, "confirmWaitMs", 1_000),
            wait: Box::new(|ms| std::thread::sleep(std::time::Duration::from_millis(ms))),
        },
    });
    let principals: Arc<dyn PrincipalSource> = Arc::new(HopPrincipal::new(
        sponsor
            .get("principalHeader")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("x-neoos-principal"),
    ));

    let host = sponsor
        .get("host")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("127.0.0.1")
        .to_string();
    let port = unsigned(&sponsor, "port", 9_465).clamp(1, u64::from(u16::MAX)) as u16;
    Ok((api, principals, host, port))
}

/// The settings a request is judged against. The kill switch defaults to
/// **halted**: a money lane that is on because nobody said otherwise is the
/// wrong default.
pub fn settings_from(config: &crate::config::RelayerConfig) -> Result<SponsorSettings, String> {
    let sponsor = config
        .raw
        .get("sponsor")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let network = config.network.trim().to_ascii_lowercase();
    if network != "mainnet" && network != "testnet" {
        return Err(format!(
            "the sponsor lane runs on mainnet or testnet, not {network:?}"
        ));
    }
    let contract = required(
        sponsor.as_object().expect("sponsor is an object"),
        "contract",
        "the sponsorable contract",
    )?;
    let contract = decode_hash160(&contract)?;
    let fee_ceiling_units = unsigned(&sponsor, "feeCeilingUnits", 0);
    if fee_ceiling_units == 0 || fee_ceiling_units > 20_000_000 {
        return Err(
            "sponsor.feeCeilingUnits must be a positive amount of GAS datoshi at or below 20000000"
                .to_string(),
        );
    }
    Ok(SponsorSettings {
        network,
        sponsorable_contract: contract,
        fee_ceiling_units,
        enabled: sponsor
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

fn required(
    object: &serde_json::Map<String, Value>,
    field: &str,
    label: &str,
) -> Result<String, String> {
    object
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("{label} is not configured"))
}

fn unsigned(value: &Value, field: &str, default: u64) -> u64 {
    value
        .get(field)
        .and_then(|entry| {
            entry.as_u64().or_else(|| {
                // Resolved settings reach this module through
                // `js_value_to_json`, which stores every JS number as an
                // `f64`; `serde_json` reports `as_u64() == None` for those. A
                // ceiling or a lease read as "absent" would silently become a
                // default, so an integral value is accepted from either
                // representation and a fractional one is refused rather than
                // truncated.
                entry.as_f64().and_then(|number| {
                    (number.is_finite() && number >= 0.0 && number.fract() == 0.0)
                        .then_some(number as u64)
                })
            })
        })
        .unwrap_or(default)
}

fn decode_hash160(value: &str) -> Result<[u8; 20], String> {
    let raw = value.trim();
    let raw = raw.strip_prefix("0x").unwrap_or(raw);
    if raw.len() != 40 || !raw.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(format!("{value:?} is not a display-order script hash"));
    }
    let mut out = [0u8; 20];
    for (index, slot) in out.iter_mut().enumerate() {
        *slot = u8::from_str_radix(&raw[index * 2..index * 2 + 2], 16)
            .map_err(|_| format!("{value:?} is not a display-order script hash"))?;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sponsor::JournalError;

    #[test]
    fn the_two_store_refusals_a_caller_can_act_on_are_named() {
        assert_eq!(
            classify("ERROR: sponsor idempotency conflict".to_string()),
            JournalError::Conflict
        );
        assert_eq!(
            classify("sponsor global budget exceeded".to_string()),
            JournalError::BudgetExhausted
        );
        assert_eq!(
            classify("sponsor lifetime budget exceeded".to_string()),
            JournalError::BudgetExhausted
        );
        assert_eq!(
            classify("sponsor daily action budget exceeded".to_string()),
            JournalError::BudgetExhausted
        );
    }

    #[test]
    fn every_other_store_refusal_stays_a_refusal() {
        // In particular a lost lease is not a conflict and not a budget cap:
        // reporting it as either would invite a caller to do the wrong thing.
        for message in [
            "delivery lease lost",
            "invalid sponsor reservation",
            "sponsor journal cannot be deleted",
            "sponsor prepared journal requires reserved fee ceiling",
        ] {
            match classify(message.to_string()) {
                JournalError::Refused(detail) => assert_eq!(detail, message),
                other => panic!("{message:?} must stay a refusal, got {other:?}"),
            }
        }
    }

    #[test]
    fn the_body_parser_reads_only_the_envelope() {
        let body = r#"{"envelope_hex":"aabb","principal":"x","fee_ceiling_units":99}"#;
        assert_eq!(parse_body(body).expect("valid body"), "aabb");
    }

    #[test]
    fn the_body_parser_refuses_everything_that_is_not_an_envelope() {
        for body in ["", "null", "[]", "{}", r#"{"envelope_hex":1}"#, "nope"] {
            assert!(parse_body(body).is_err(), "{body:?} must be refused");
        }
    }

    #[test]
    fn both_idempotency_key_spellings_are_read() {
        assert_eq!(
            idempotency_key_from_headers([("Idempotency-Key", "abc")]),
            Some("abc".to_string())
        );
        assert_eq!(
            idempotency_key_from_headers([("x-idempotency-key", " abc ")]),
            Some("abc".to_string())
        );
        assert_eq!(
            idempotency_key_from_headers([("content-type", "application/json")]),
            None
        );
    }

    #[test]
    fn a_hop_principal_must_be_a_uuid() {
        let source = HopPrincipal::new("x-neoos-principal");
        let good = HeaderMap::from_iter([(
            header::HeaderName::from_static("x-neoos-principal"),
            header::HeaderValue::from_static("11111111-2222-4333-8444-555555555555"),
        )]);
        assert!(source.resolve(&good).is_some());
        let bad = HeaderMap::from_iter([(
            header::HeaderName::from_static("x-neoos-principal"),
            header::HeaderValue::from_static("not-a-uuid"),
        )]);
        assert!(source.resolve(&bad).is_none());
        assert!(source.resolve(&HeaderMap::new()).is_none());
    }

    #[test]
    fn a_display_order_script_hash_is_required() {
        assert_eq!(
            decode_hash160("0x03013f49c42a14546c8bbe58f9d434c3517fccab")
                .unwrap()
                .len(),
            20
        );
        assert!(decode_hash160("0x0301").is_err());
        assert!(decode_hash160("0xgg013f49c42a14546c8bbe58f9d434c3517fccab").is_err());
    }
}
