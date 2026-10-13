//! The sponsor request state machine: what the sponsor pays for, in what order,
//! and what a caller is told.
//!
//! The row this implements (CU-151, `SVC-U02c`) is *sponsor HTTP API with
//! idempotency and journal-before-broadcast*, accepted when *a crash after the
//! journal write replays safely; `SUBMISSION_UNKNOWN` is handled; the kill
//! switch works*. Three rules decide every line below.
//!
//! 1. **Nothing is broadcast before it is journalled.** The reservation is the
//!    journal, it is one database transaction with the budget debits and the
//!    bound delivery job, and the signed bytes are a durable stage before any
//!    of them reach the network. This is the contract
//!    `docs/RELAYER_DURABLE_V2.md` already states: *"Prepared results and signed
//!    transactions are persisted before broadcast. Unknown broadcast/confirmation
//!    resumes the same transaction, not compute."*
//! 2. **A retried request must not pay twice.** Idempotency is the store's, not
//!    this module's: a repeat of the same `(network, principal, idempotency_key)`
//!    returns the original job and charges nothing, and a repeat with a different
//!    intent is a conflict. This module routes every request through that one
//!    primitive and never invents a second spend path.
//! 3. **An unknown outcome is not a failure.** When the send cannot establish
//!    what happened, the answer is [`SponsorCode::SubmissionUnknown`] with the
//!    journal id and the job parked where the same transaction can resume. It is
//!    never rewritten as a retryable error, because "unknown" is exactly the case
//!    in which a second signature would pay twice.
//!
//! Nothing here performs IO. The journal and the send are ports
//! ([`SponsorJournal`], [`SponsorSubmit`]); their production implementations
//! live in [`crate::sponsor_api`] and [`crate::sponsor_submit`].
//!
//! No field of the request is echoed back as if this module had established it.
//! The request carries an unsigned transaction envelope and an idempotency key
//! and nothing else: the fee, the sponsor account, the called contract and the
//! method are all read out of the envelope, and the principal comes from the
//! authenticated hop rather than the body.

use neo_os_core::n3_tx::{parse_unsigned_tx, UnsignedTx, HASH160_LEN};
use neo_os_core::sponsor_intent::{
    validate_sponsorable_intent, SponsorIntentRequest as IntentDecisionRequest, SponsorableIntent,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

/// The response vocabulary. These strings are a compatibility surface from the
/// moment the API answers with them, so they are pinned by a test and must not
/// be renamed without a migration story for every caller.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SponsorCode {
    /// The kill switch is halted; nothing is journalled and nothing is sent.
    Disabled,
    /// The request reached the surface without a principal the hop established.
    PrincipalRequired,
    /// The request body or the envelope could not be understood.
    RequestInvalid,
    /// No usable idempotency key.
    IdempotencyKeyRequired,
    /// The key was already used for a different intent.
    IdempotencyConflict,
    /// The reservation refused on a budget cap.
    BudgetExhausted,
    /// The durable record refused or disagreed; nothing was marked complete.
    JournalRefused,
    /// The signature or the send was refused and nothing is in flight.
    SendRefused,
    /// A receipt came back for a transaction other than the signed one.
    ReceiptMismatch,
    /// A HALT receipt for the signed transaction is journalled and reported.
    Confirmed,
    /// A FAULT receipt for the signed transaction is journalled and reported.
    Faulted,
    /// The outcome of the send could not be established.
    SubmissionUnknown,
}

impl SponsorCode {
    /// Every code, so a test can prove none has been added or renamed behind a
    /// caller that matches on the string.
    pub const ALL: [SponsorCode; 12] = [
        SponsorCode::Disabled,
        SponsorCode::PrincipalRequired,
        SponsorCode::RequestInvalid,
        SponsorCode::IdempotencyKeyRequired,
        SponsorCode::IdempotencyConflict,
        SponsorCode::BudgetExhausted,
        SponsorCode::JournalRefused,
        SponsorCode::SendRefused,
        SponsorCode::ReceiptMismatch,
        SponsorCode::Confirmed,
        SponsorCode::Faulted,
        SponsorCode::SubmissionUnknown,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Disabled => "SPONSOR_DISABLED",
            Self::PrincipalRequired => "SPONSOR_PRINCIPAL_REQUIRED",
            Self::RequestInvalid => "SPONSOR_REQUEST_INVALID",
            Self::IdempotencyKeyRequired => "SPONSOR_IDEMPOTENCY_KEY_REQUIRED",
            Self::IdempotencyConflict => "SPONSOR_IDEMPOTENCY_CONFLICT",
            Self::BudgetExhausted => "SPONSOR_BUDGET_EXHAUSTED",
            Self::JournalRefused => "SPONSOR_JOURNAL_REFUSED",
            Self::SendRefused => "SPONSOR_SEND_REFUSED",
            Self::ReceiptMismatch => "SPONSOR_RECEIPT_MISMATCH",
            Self::Confirmed => "SPONSOR_CONFIRMED",
            Self::Faulted => "SPONSOR_FAULTED",
            Self::SubmissionUnknown => "SUBMISSION_UNKNOWN",
        }
    }

    /// Whether the caller is being refused rather than told an outcome.
    ///
    /// [`SponsorCode::SubmissionUnknown`] is deliberately **not** a refusal: it
    /// is the one answer a caller must not turn into a fresh submission.
    pub fn is_refusal(self) -> bool {
        matches!(
            self,
            Self::Disabled
                | Self::PrincipalRequired
                | Self::RequestInvalid
                | Self::IdempotencyKeyRequired
                | Self::IdempotencyConflict
                | Self::BudgetExhausted
                | Self::JournalRefused
                | Self::SendRefused
                | Self::ReceiptMismatch
        )
    }
}

impl std::fmt::Display for SponsorCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// The authenticated caller. Established by the hop in front of this surface,
/// never read out of the request body.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Principal {
    id: String,
}

impl Principal {
    /// Bind a principal from an already-authenticated assertion. The value must
    /// be a UUID because that is what the reservation schema stores; anything
    /// else is refused rather than coerced.
    pub fn new(id: impl Into<String>) -> Result<Principal, String> {
        let id = id.into();
        if !is_uuid(&id) {
            return Err("the principal must be a UUID".to_string());
        }
        Ok(Principal { id })
    }

    pub fn id(&self) -> &str {
        &self.id
    }
}

fn is_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    bytes.iter().enumerate().all(|(index, byte)| match index {
        8 | 13 | 18 | 23 => *byte == b'-',
        _ => byte.is_ascii_hexdigit(),
    })
}

/// What the sponsor is configured to pay for and how much it will approve.
///
/// Every field is configuration. In particular the fee ceiling is **not** a
/// request field: a submitter that could declare its own ceiling could declare
/// its way to the top of the sponsor's balance.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SponsorSettings {
    /// `mainnet` or `testnet`, matching the reservation schema's check.
    pub network: String,
    /// The one contract whose `registerAccount` / `executeSponsoredUserOp` this
    /// sponsor will pay for, display order.
    pub sponsorable_contract: [u8; HASH160_LEN],
    /// The approved ceiling for one intent, GAS datoshi. The reservation schema
    /// bounds this (`between 1 and 20000000`); that bound is deliberately not
    /// duplicated here.
    pub fee_ceiling_units: u64,
    /// The kill switch. `false` refuses every request and writes nothing.
    pub enabled: bool,
}

/// The request. Two fields, and neither of them is money.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SponsorIntentRequest {
    /// Caller-chosen, 1..=128 characters after trimming, matching the
    /// reservation schema's check.
    pub idempotency_key: String,
    /// The unsigned Neo N3 transaction envelope, lowercase hex without a `0x`
    /// prefix. Everything the sponsor pays for is read out of these bytes.
    pub envelope_hex: String,
}

/// The measured cost of one intent, in integer GAS datoshi.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SponsorFee {
    /// `SystemFee + NetworkFee` read from the envelope.
    pub transaction_fee_units: u64,
    /// The script-carried `reimbursementAmount`. Zero for `registerAccount`.
    pub reimbursement_units: u64,
    /// The whole amount the sponsor approves: the two above.
    pub sponsor_fee_units: u64,
}

/// A chain execution result for the signed transaction.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VmReceipt {
    pub tx_hash: String,
    pub vm_state: String,
    pub exception: Option<String>,
}

/// The signed transaction, before it is sent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignedTx {
    pub tx_hash: String,
    /// The complete signed transaction, base64, as the RPC wants it.
    pub raw_base64: String,
}

/// What the send port learned.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SubmitOutcome {
    /// A concrete application log for the signed transaction.
    Confirmed(VmReceipt),
    /// The outcome could not be established: a timeout, an ambiguous error, or
    /// a send that may or may not have reached the network.
    Unknown,
    /// The network refused the signed bytes outright and nothing is in flight.
    Rejected(String),
}

/// An accepted intent. Every field is derived; none is echoed from the request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SponsorAccepted {
    pub code: SponsorCode,
    /// The durable journal id. Carried on every response, including the unknown
    /// one, so a caller can resume instead of resubmitting.
    pub journal_id: String,
    pub tx_hash: String,
    /// `None` when the outcome is unknown.
    pub vm_state: Option<String>,
    pub fee: SponsorFee,
    /// True when nothing new was reserved, signed or sent for this request.
    pub replayed: bool,
}

/// A refusal. `detail` is for logs and operator messages; a caller that branches
/// must branch on [`SponsorCode`] (and, for an intent refusal, on `intent_code`),
/// never on the text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SponsorRefusal {
    pub code: SponsorCode,
    pub detail: String,
    /// The validator's own code, verbatim, when the refusal came from
    /// [`validate_sponsorable_intent`]. Those strings belong to CU-150 and are
    /// not re-spelled here.
    pub intent_code: Option<String>,
}

/// The answer to one request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SponsorResult {
    Accepted(SponsorAccepted),
    Refused(SponsorRefusal),
}

/// The reservation the journal is asked to hold.
///
/// Defined once, in the delivery schema's crate, and re-exported here: the API
/// builds it and the store sends it, and two field lists for one fact is how a
/// silent drift starts.
pub use neo_os_relayer_store::delivery::SponsorReservation as Reservation;

/// The durable row the journal returns.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SponsorJob {
    pub job_key: String,
    pub generation: u64,
    pub status: String,
    pub journal: Value,
    pub intent: Value,
    pub contract: String,
    pub fee_ceiling_units: u64,
}

impl SponsorJob {
    /// A completed intent already holds its receipt; a replay reports that and
    /// touches nothing else.
    pub fn receipt(&self) -> Option<VmReceipt> {
        let receipt = self.journal.get("receipt")?;
        Some(VmReceipt {
            tx_hash: receipt.get("tx_hash")?.as_str()?.to_string(),
            vm_state: receipt.get("vm_state")?.as_str()?.to_string(),
            exception: receipt
                .get("exception")
                .and_then(Value::as_str)
                .map(str::to_string),
        })
    }

    /// The signed stage, which is immutable once written.
    pub fn signed(&self) -> Option<SignedTx> {
        let signed = self.journal.get("signed")?;
        Some(SignedTx {
            tx_hash: signed.get("tx_hash")?.as_str()?.to_string(),
            raw_base64: signed.get("raw")?.as_str()?.to_string(),
        })
    }
}

/// Why the journal would not do what was asked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JournalError {
    /// The key was already used for a different intent.
    Conflict,
    /// A budget cap refused the reservation.
    BudgetExhausted,
    /// Anything else, including a lost lease or an unreachable store.
    Refused(String),
}

impl std::fmt::Display for JournalError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Conflict => f.write_str("sponsor idempotency conflict"),
            Self::BudgetExhausted => f.write_str("sponsor budget exceeded"),
            Self::Refused(detail) => write!(f, "the delivery store refused the write: {detail}"),
        }
    }
}

/// The durable record. One implementation, over the delivery schema.
pub trait SponsorJournal {
    /// Reserve and journal the intent, idempotently. An identical retry returns
    /// the original job and charges nothing.
    fn reserve(&self, reservation: &Reservation) -> Result<SponsorJob, JournalError>;
    /// Write one journal stage (`prepared`, `signed`, `completed`, `faulted`,
    /// `retry`).
    fn stage(&self, job: &SponsorJob, op: &str, data: Value) -> Result<SponsorJob, JournalError>;
}

/// The send. Split in two so the signed bytes can be journalled **between** the
/// signature and the broadcast — which is the whole point of the row.
pub trait SponsorSubmit {
    /// Produce the witness for the envelope. A refusal here sends nothing and
    /// is safe to retry.
    fn sign(&self, envelope_hex: &str) -> Result<SignedTx, String>;
    /// Send the journalled signed bytes and learn what happened.
    fn broadcast_and_confirm(&self, signed: &SignedTx) -> SubmitOutcome;
}

impl<T: SponsorJournal + ?Sized> SponsorJournal for std::sync::Arc<T> {
    fn reserve(&self, reservation: &Reservation) -> Result<SponsorJob, JournalError> {
        (**self).reserve(reservation)
    }
    fn stage(&self, job: &SponsorJob, op: &str, data: Value) -> Result<SponsorJob, JournalError> {
        (**self).stage(job, op, data)
    }
}

impl<T: SponsorSubmit + ?Sized> SponsorSubmit for std::sync::Arc<T> {
    fn sign(&self, envelope_hex: &str) -> Result<SignedTx, String> {
        (**self).sign(envelope_hex)
    }
    fn broadcast_and_confirm(&self, signed: &SignedTx) -> SubmitOutcome {
        (**self).broadcast_and_confirm(signed)
    }
}

/// The API: one request in, one answer out, in a fixed order.
pub struct SponsorApi<J, S> {
    pub settings: SponsorSettings,
    pub journal: J,
    pub submit: S,
}

/// Why the envelope could not be turned into facts.
fn request_invalid(detail: impl Into<String>) -> SponsorRefusal {
    SponsorRefusal {
        code: SponsorCode::RequestInvalid,
        detail: detail.into(),
        intent_code: None,
    }
}

fn journal_refused(detail: impl Into<String>) -> SponsorRefusal {
    SponsorRefusal {
        code: SponsorCode::JournalRefused,
        detail: detail.into(),
        intent_code: None,
    }
}

impl<J: SponsorJournal, S: SponsorSubmit> SponsorApi<J, S> {
    /// Handle one sponsor request.
    ///
    /// The order is fixed and is part of the contract: the kill switch, then
    /// the principal, then the key, then the envelope, then the intent
    /// decision, and only then a write. Anything that refuses before the
    /// reservation has touched neither the journal nor the network.
    pub fn submit(
        &self,
        principal: Option<&Principal>,
        request: &SponsorIntentRequest,
    ) -> SponsorResult {
        if !self.settings.enabled {
            return SponsorResult::Refused(SponsorRefusal {
                code: SponsorCode::Disabled,
                detail: "the sponsor lane is halted; no intent is accepted".to_string(),
                intent_code: None,
            });
        }
        let Some(principal) = principal else {
            return SponsorResult::Refused(SponsorRefusal {
                code: SponsorCode::PrincipalRequired,
                detail: "no authenticated principal reached the sponsor surface".to_string(),
                intent_code: None,
            });
        };
        let idempotency_key = request.idempotency_key.trim();
        if idempotency_key.is_empty() || idempotency_key.len() > 128 {
            return SponsorResult::Refused(SponsorRefusal {
                code: SponsorCode::IdempotencyKeyRequired,
                detail: "an idempotency key of 1 to 128 characters is required".to_string(),
                intent_code: None,
            });
        }

        let envelope_hex = request.envelope_hex.trim();
        let envelope_bytes = match decode_hex(envelope_hex) {
            Some(bytes) => bytes,
            None => {
                return SponsorResult::Refused(request_invalid(
                    "the envelope must be an even-length hexadecimal string",
                ))
            }
        };
        let envelope = match parse_unsigned_tx(&envelope_bytes) {
            Ok(envelope) => envelope,
            Err(error) => return SponsorResult::Refused(request_invalid(error.to_string())),
        };
        let Some(transaction_fee_units) = envelope.transaction_fee_units() else {
            return SponsorResult::Refused(request_invalid(
                "the envelope's fees leave the datoshi domain",
            ));
        };

        let decision = match validate_sponsorable_intent(&IntentDecisionRequest {
            script: &envelope.script,
            sponsorable_contract: self.settings.sponsorable_contract,
            fee_ceiling_units: self.settings.fee_ceiling_units,
            transaction_fee_units,
        }) {
            Ok(decision) => decision,
            Err(error) => {
                return SponsorResult::Refused(SponsorRefusal {
                    code: SponsorCode::RequestInvalid,
                    detail: error.to_string(),
                    intent_code: Some(error.code.as_str().to_string()),
                })
            }
        };

        let fee = SponsorFee {
            transaction_fee_units,
            reimbursement_units: decision.reimbursement_units,
            sponsor_fee_units: decision.sponsor_fee_units,
        };
        let intent = intent_facts(&decision, &envelope, &fee);
        let reservation = Reservation {
            network: self.settings.network.clone(),
            principal: principal.id().to_string(),
            idempotency_key: idempotency_key.to_string(),
            contract: display_hash(&decision.target),
            account: display_hash(&envelope.signer),
            intent,
            fee_ceiling_units: self.settings.fee_ceiling_units,
        };

        let job = match self.journal.reserve(&reservation) {
            Ok(job) => job,
            Err(JournalError::Conflict) => {
                return SponsorResult::Refused(SponsorRefusal {
                    code: SponsorCode::IdempotencyConflict,
                    detail: "this idempotency key already names a different intent".to_string(),
                    intent_code: None,
                })
            }
            Err(JournalError::BudgetExhausted) => {
                return SponsorResult::Refused(SponsorRefusal {
                    code: SponsorCode::BudgetExhausted,
                    detail: "a sponsor budget cap refused this reservation".to_string(),
                    intent_code: None,
                })
            }
            Err(JournalError::Refused(detail)) => {
                return SponsorResult::Refused(journal_refused(detail))
            }
        };

        self.run(&job, &envelope, &fee, &decision)
    }

    /// Finish the job the reservation produced. Every path here is a resume:
    /// the journal decides what is left to do, and nothing is done twice.
    fn run(
        &self,
        job: &SponsorJob,
        envelope: &UnsignedTx,
        fee: &SponsorFee,
        decision: &SponsorableIntent,
    ) -> SponsorResult {
        let journal_id = job.job_key.clone();

        // A completed intent is replayed from the journal and never re-sent.
        if let Some(receipt) = job.receipt() {
            return SponsorResult::Accepted(SponsorAccepted {
                code: receipt_code(&receipt.vm_state),
                journal_id,
                tx_hash: receipt.tx_hash,
                vm_state: Some(receipt.vm_state),
                fee: fee.clone(),
                replayed: true,
            });
        }

        // The signed bytes, from the journal when they exist and never
        // re-derived: an unknown broadcast resumes the same transaction.
        let signed = match job.signed() {
            Some(signed) => signed,
            None => match self.prepare_and_sign(job, envelope, fee, decision) {
                Ok(signed) => signed,
                Err(refusal) => return SponsorResult::Refused(refusal),
            },
        };
        // `signed` is what goes on the wire; the receipt is checked against it
        // below, so a completion can only ever describe this transaction.

        match self.submit.broadcast_and_confirm(&signed) {
            SubmitOutcome::Confirmed(receipt) => {
                if receipt.tx_hash != signed.tx_hash {
                    // A receipt for a transaction the sponsor did not sign is
                    // an integrity failure, never a completion.
                    return SponsorResult::Refused(SponsorRefusal {
                        code: SponsorCode::ReceiptMismatch,
                        detail: format!(
                            "the send reported {} for the signed transaction {}",
                            receipt.tx_hash, signed.tx_hash
                        ),
                        intent_code: None,
                    });
                }
                if !is_halt(&receipt.vm_state) && !is_fault(&receipt.vm_state) {
                    return self.unknown_outcome(
                        job,
                        fee,
                        "an undecided execution state was observed",
                    );
                }
                let op = if is_halt(&receipt.vm_state) {
                    "completed"
                } else {
                    "faulted"
                };
                match self.journal.stage(job, op, receipt_json(&receipt)) {
                    Ok(_) => SponsorResult::Accepted(SponsorAccepted {
                        code: if is_halt(&receipt.vm_state) {
                            SponsorCode::Confirmed
                        } else {
                            SponsorCode::Faulted
                        },
                        journal_id,
                        tx_hash: receipt.tx_hash.clone(),
                        vm_state: Some(receipt.vm_state.clone()),
                        fee: fee.clone(),
                        replayed: false,
                    }),
                    Err(error) => SponsorResult::Refused(journal_refused(format!(
                        "the {op} stage could not be recorded: {error}"
                    ))),
                }
            }
            SubmitOutcome::Rejected(reason) => {
                // The network refused the signed bytes and nothing is in
                // flight. The signature stays journalled; a retry resends it.
                match self.journal.stage(
                    job,
                    "retry",
                    json!({"error": format!("the send was refused: {reason}")}),
                ) {
                    Ok(_) => SponsorResult::Refused(SponsorRefusal {
                        code: SponsorCode::SendRefused,
                        detail: format!("the network refused the signed transaction: {reason}"),
                        intent_code: None,
                    }),
                    Err(error) => SponsorResult::Refused(journal_refused(format!(
                        "the send was refused and the outcome could not be recorded: {error}"
                    ))),
                }
            }
            SubmitOutcome::Unknown => {
                self.unknown_outcome(job, fee, "the outcome of the send could not be established")
            }
        }
    }

    /// Journal `prepared`, take the signature, journal `signed`. The signature
    /// is taken between the two writes because the second one is what holds the
    /// bytes that will be broadcast.
    fn prepare_and_sign(
        &self,
        job: &SponsorJob,
        envelope: &UnsignedTx,
        fee: &SponsorFee,
        decision: &SponsorableIntent,
    ) -> Result<SignedTx, SponsorRefusal> {
        let prepared = prepared_stage(envelope, fee, decision, self.settings.fee_ceiling_units);
        self.journal
            .stage(job, "prepared", prepared)
            .map_err(|error| {
                journal_refused(format!("the prepared stage could not be recorded: {error}"))
            })?;

        let signed = self
            .submit
            .sign(&hex::encode(envelope.serialize_unsigned()))
            .map_err(|error| SponsorRefusal {
                code: SponsorCode::SendRefused,
                detail: format!("the signature was refused: {error}"),
                intent_code: None,
            })?;
        if signed.tx_hash.trim().is_empty() || signed.raw_base64.trim().is_empty() {
            return Err(SponsorRefusal {
                code: SponsorCode::SendRefused,
                detail: "the signer returned an incomplete transaction".to_string(),
                intent_code: None,
            });
        }

        self.journal
            .stage(
                job,
                "signed",
                json!({
                    "chain": "neo_n3",
                    "tx_hash": signed.tx_hash,
                    "raw": signed.raw_base64,
                    "valid_until_block": envelope.valid_until_block,
                }),
            )
            .map_err(|error| {
                journal_refused(format!("the signed stage could not be recorded: {error}"))
            })?;
        Ok(signed)
    }

    /// The one answer a caller must not convert into a fresh submission.
    ///
    /// The job is parked where the same transaction can resume, and the caller
    /// is given the journal id rather than an invitation to try again with a
    /// fresh signature.
    fn unknown_outcome(&self, job: &SponsorJob, fee: &SponsorFee, reason: &str) -> SponsorResult {
        match self.journal.stage(job, "retry", json!({"error": reason})) {
            Ok(_) => SponsorResult::Accepted(SponsorAccepted {
                code: SponsorCode::SubmissionUnknown,
                journal_id: job.job_key.clone(),
                tx_hash: job
                    .signed()
                    .map(|signed| signed.tx_hash)
                    .unwrap_or_default(),
                vm_state: None,
                fee: fee.clone(),
                replayed: false,
            }),
            Err(error) => SponsorResult::Refused(journal_refused(format!(
                "{reason}, and the uncertainty could not be recorded: {error}"
            ))),
        }
    }
}

fn is_halt(vm_state: &str) -> bool {
    vm_state.eq_ignore_ascii_case("HALT")
}

fn is_fault(vm_state: &str) -> bool {
    vm_state.eq_ignore_ascii_case("FAULT")
}

fn receipt_code(vm_state: &str) -> SponsorCode {
    if is_halt(vm_state) {
        SponsorCode::Confirmed
    } else {
        SponsorCode::Faulted
    }
}

fn receipt_json(receipt: &VmReceipt) -> Value {
    json!({
        "tx_hash": receipt.tx_hash,
        "vm_state": receipt.vm_state,
        "exception": receipt.exception,
    })
}

/// The derived intent. Built in one place with a fixed key order so two
/// submissions of the same request produce byte-identical JSON.
fn intent_facts(decision: &SponsorableIntent, envelope: &UnsignedTx, fee: &SponsorFee) -> Value {
    json!({
        "account_id": display_hash(&decision.account_id),
        "envelope_sha256": sha256_hex(&envelope.serialize_unsigned()),
        "method": decision.method.as_str(),
        "reimbursement_units": fee.reimbursement_units,
        "script_sha256": sha256_hex(&envelope.script),
        "sponsor_account": display_hash(&envelope.signer),
        "sponsor_fee_units": fee.sponsor_fee_units,
        "transaction_fee_units": fee.transaction_fee_units,
        "tx_hash": envelope.hash_display(),
    })
}

/// The `prepared` stage. Carries the reserved fee ceiling because the delivery
/// guard refuses a prepared journal that does not name it.
fn prepared_stage(
    envelope: &UnsignedTx,
    fee: &SponsorFee,
    decision: &SponsorableIntent,
    fee_ceiling_units: u64,
) -> Value {
    json!({
        "account_id": display_hash(&decision.account_id),
        "fee_ceiling_units": fee_ceiling_units,
        "method": decision.method.as_str(),
        "reimbursement_units": fee.reimbursement_units,
        "sponsor_account": display_hash(&envelope.signer),
        "sponsor_fee_units": fee.sponsor_fee_units,
        "transaction_fee_units": fee.transaction_fee_units,
        "tx_hash": envelope.hash_display(),
        "valid_until_block": envelope.valid_until_block,
    })
}

fn display_hash(hash: &[u8; HASH160_LEN]) -> String {
    format!("0x{}", hex::encode(hash))
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn decode_hex(value: &str) -> Option<Vec<u8>> {
    let value = value.strip_prefix("0x").unwrap_or(value);
    if !value.len().is_multiple_of(2) || value.is_empty() {
        return None;
    }
    (0..value.len())
        .step_by(2)
        .map(|at| u8::from_str_radix(value.get(at..at + 2)?, 16).ok())
        .collect()
}
