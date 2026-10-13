//! Acceptance for the sponsor HTTP API (CU-151).
//!
//! The row: *expose the sponsor API with idempotency keys, journal-before-broadcast
//! and HALT-confirmed receipts, handling `SUBMISSION_UNKNOWN`*, accepted when
//! *a crash after the journal write replays safely; `SUBMISSION_UNKNOWN` is
//! handled; the kill switch works*.
//!
//! The three acceptance clauses are about **order and durability**, not about a
//! chain, so every test below drives [`SponsorApi`] through injected journal and
//! send ports. The crash is reproduced by putting the journal into the exact state
//! a process death leaves behind, which is stronger than hoping a killed thread
//! happens to stop at the right line.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use neo_os_core::base64::{decode_lenient, encode_standard};
use neo_os_core::n3_tx::{create_invoke_script, ContractParam, FeedSigner, FeedTx};
use neo_os_relayer::sponsor::{
    JournalError, Principal, Reservation, SignedTx, SponsorAccepted, SponsorApi, SponsorCode,
    SponsorFee, SponsorIntentRequest, SponsorJob, SponsorJournal, SponsorRefusal, SponsorResult,
    SponsorSettings, SponsorSubmit, SubmitOutcome, VmReceipt,
};
use neo_os_relayer::sponsor_api::{handle, ApiResponse, SponsorHttpRequest};
use serde_json::{json, Value};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const AA_CONTRACT: [u8; 20] = [
    0x03, 0x01, 0x3f, 0x49, 0xc4, 0x2a, 0x14, 0x54, 0x6c, 0x8b, 0xbe, 0x58, 0xf9, 0xd4, 0x34, 0xc3,
    0x51, 0x7f, 0xcc, 0xab,
];
const ACCOUNT: [u8; 20] = [
    0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11,
    0x11, 0x11, 0x11, 0x11,
];
const VERIFIER: [u8; 20] = [
    0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x22,
    0x22, 0x22, 0x22, 0x22,
];
const HOOK: [u8; 20] = [
    0x33, 0x33, 0x33, 0x33, 0x33, 0x33, 0x33, 0x33, 0x33, 0x33, 0x33, 0x33, 0x33, 0x33, 0x33, 0x33,
    0x33, 0x33, 0x33, 0x33,
];
const BACKUP: [u8; 20] = [
    0x44, 0x44, 0x44, 0x44, 0x44, 0x44, 0x44, 0x44, 0x44, 0x44, 0x44, 0x44, 0x44, 0x44, 0x44, 0x44,
    0x44, 0x44, 0x44, 0x44,
];
/// The fee payer: the sponsor account whose nonce the transaction consumes.
const FEE_PAYER: [u8; 20] = [
    0x88, 0x88, 0x88, 0x88, 0x88, 0x88, 0x88, 0x88, 0x88, 0x88, 0x88, 0x88, 0x88, 0x88, 0x88, 0x88,
    0x88, 0x88, 0x88, 0x88,
];

const PRINCIPAL_ID: &str = "11111111-2222-4333-8444-555555555555";
const OTHER_PRINCIPAL_ID: &str = "99999999-8888-4777-8666-555555555555";
const CEILING: u64 = 10_000_000;

fn hash_param(hash: &[u8; 20]) -> ContractParam {
    ContractParam::Hash160(format!("0x{}", hex::encode(hash)))
}

fn register_account_script() -> Vec<u8> {
    create_invoke_script(
        &AA_CONTRACT,
        "registerAccount",
        &[
            hash_param(&ACCOUNT),
            hash_param(&VERIFIER),
            ContractParam::HexBytes("cafebabe".to_string()),
            hash_param(&HOOK),
            hash_param(&BACKUP),
            ContractParam::Integer(3600),
        ],
    )
    .expect("valid fixture")
}

/// The unsigned envelope the API is asked to pay for. The fee is measured out
/// of these bytes; the request carries no fee field at all.
fn envelope_hex(script: &[u8], system_fee: u64, network_fee: u64) -> String {
    hex::encode(
        FeedTx {
            nonce: 9,
            valid_until_block: 4_242,
            system_fee,
            network_fee,
            signer: FeedSigner {
                script_hash: FEE_PAYER,
            },
            script,
        }
        .serialize_unsigned(),
    )
}

fn standard_envelope_hex() -> String {
    envelope_hex(&register_account_script(), 1_000, 250)
}

fn request(idempotency_key: &str, envelope_hex: &str) -> SponsorIntentRequest {
    SponsorIntentRequest {
        idempotency_key: idempotency_key.to_string(),
        envelope_hex: envelope_hex.to_string(),
    }
}

fn settings(enabled: bool) -> SponsorSettings {
    SponsorSettings {
        network: "testnet".to_string(),
        sponsorable_contract: AA_CONTRACT,
        fee_ceiling_units: CEILING,
        enabled,
    }
}

fn principal() -> Principal {
    Principal::new(PRINCIPAL_ID).expect("valid principal")
}

fn other_principal() -> Principal {
    Principal::new(OTHER_PRINCIPAL_ID).expect("valid principal")
}

fn display(hash: &[u8; 20]) -> String {
    format!("0x{}", hex::encode(hash))
}

// ---------------------------------------------------------------------------
// One ordered event log both ports write to, so a test can assert the commit
// protocol rather than two independent end states.
// ---------------------------------------------------------------------------

type Trace = Arc<Mutex<Vec<String>>>;

fn new_trace() -> Trace {
    Arc::new(Mutex::new(Vec::new()))
}

fn trace_of(trace: &Trace) -> Vec<String> {
    trace.lock().expect("trace lock").clone()
}

fn push(trace: &Trace, event: impl Into<String>) {
    trace.lock().expect("trace lock").push(event.into());
}

// ---------------------------------------------------------------------------
// Journal double
// ---------------------------------------------------------------------------

#[derive(Default)]
struct JournalState {
    reserves: usize,
    jobs: BTreeMap<String, SponsorJob>,
    by_key: BTreeMap<(String, String), String>,
    forced_budget: bool,
}

struct FakeJournal {
    trace: Trace,
    state: Mutex<JournalState>,
}

impl FakeJournal {
    fn new(trace: Trace) -> Self {
        FakeJournal {
            trace,
            state: Mutex::new(JournalState::default()),
        }
    }

    fn reserves(&self) -> usize {
        self.state.lock().expect("journal lock").reserves
    }

    fn job(&self, key: &str) -> SponsorJob {
        self.state
            .lock()
            .expect("journal lock")
            .jobs
            .get(key)
            .cloned()
            .expect("job present")
    }

    /// The only job the fixture created, whichever key produced it.
    fn only_job(&self) -> SponsorJob {
        self.state
            .lock()
            .expect("journal lock")
            .jobs
            .values()
            .next()
            .cloned()
            .expect("one job")
    }

    fn force_budget_exhausted(&self) {
        self.state.lock().expect("journal lock").forced_budget = true;
    }
}

impl SponsorJournal for FakeJournal {
    fn reserve(&self, reservation: &Reservation) -> Result<SponsorJob, JournalError> {
        push(
            &self.trace,
            format!("reserve:{}", reservation.idempotency_key),
        );
        let mut state = self.state.lock().expect("journal lock");
        if state.forced_budget {
            return Err(JournalError::BudgetExhausted);
        }
        let identity = (
            reservation.principal.clone(),
            reservation.idempotency_key.clone(),
        );
        if let Some(existing) = state.by_key.get(&identity) {
            let job = state.jobs.get(existing).cloned().expect("job present");
            if job.intent != reservation.intent
                || job.contract != reservation.contract
                || job.fee_ceiling_units != reservation.fee_ceiling_units
            {
                return Err(JournalError::Conflict);
            }
            return Ok(job);
        }
        state.reserves += 1;
        let job_key = format!(
            "[\"{}\",\"neo_n3\",\"{}\",\"sponsor\",\"{}\"]",
            reservation.network, reservation.contract, state.reserves
        );
        let job = SponsorJob {
            job_key: job_key.clone(),
            generation: 1,
            status: "processing".to_string(),
            journal: json!({}),
            intent: reservation.intent.clone(),
            contract: reservation.contract.clone(),
            fee_ceiling_units: reservation.fee_ceiling_units,
        };
        state.jobs.insert(job_key.clone(), job.clone());
        state.by_key.insert(identity, job_key);
        Ok(job)
    }

    fn stage(&self, job: &SponsorJob, op: &str, data: Value) -> Result<SponsorJob, JournalError> {
        push(&self.trace, format!("stage:{op}"));
        let mut state = self.state.lock().expect("journal lock");
        let mut updated = state.jobs.get(&job.job_key).cloned().expect("job present");
        let mut journal = updated.journal.clone();
        match op {
            "prepared" | "signed" => {
                journal[op] = data;
                updated.status = op.to_string();
            }
            "completed" | "faulted" => {
                journal["receipt"] = data;
                updated.status = if op == "completed" {
                    "completed".to_string()
                } else {
                    "dead_letter".to_string()
                };
            }
            "retry" => updated.status = "broadcast_unknown".to_string(),
            other => return Err(JournalError::Refused(format!("unsupported op {other}"))),
        }
        updated.journal = journal;
        updated.generation += 1;
        state.jobs.insert(job.job_key.clone(), updated.clone());
        Ok(updated)
    }
}

// ---------------------------------------------------------------------------
// Send double
// ---------------------------------------------------------------------------

#[derive(Default)]
struct SubmitState {
    signs: usize,
    broadcasts: usize,
    /// Bytes handed to the last broadcast, so a resume can be shown to resend
    /// the identical transaction rather than a fresh one.
    last_raw: Option<String>,
    /// Scripted result of the next broadcasts, in order.
    plan: Vec<Planned>,
    /// When true `sign` fails the way a custody refusal does: nothing is sent.
    refuse_sign: bool,
}

struct FakeSubmit {
    trace: Trace,
    state: Mutex<SubmitState>,
}

impl FakeSubmit {
    fn new(trace: Trace) -> Self {
        FakeSubmit {
            trace,
            state: Mutex::new(SubmitState::default()),
        }
    }

    fn signs(&self) -> usize {
        self.state.lock().expect("submit lock").signs
    }

    fn broadcasts(&self) -> usize {
        self.state.lock().expect("submit lock").broadcasts
    }

    fn last_raw(&self) -> String {
        self.state
            .lock()
            .expect("submit lock")
            .last_raw
            .clone()
            .expect("a broadcast happened")
    }

    fn plan(&self, outcomes: Vec<Planned>) {
        self.state.lock().expect("submit lock").plan = outcomes;
    }

    fn refuse_sign(&self) {
        self.state.lock().expect("submit lock").refuse_sign = true;
    }

    fn allow_sign(&self) {
        self.state.lock().expect("submit lock").refuse_sign = false;
    }
}

impl SponsorSubmit for FakeSubmit {
    fn sign(&self, envelope_hex: &str) -> Result<SignedTx, String> {
        push(&self.trace, "sign");
        let mut state = self.state.lock().expect("submit lock");
        if state.refuse_sign {
            return Err("custody refused the signature".to_string());
        }
        state.signs += 1;
        let tx_hash = format!("0x{:064x}", state.signs);
        Ok(SignedTx {
            tx_hash,
            raw_base64: encode_standard(format!("signed:{envelope_hex}").as_bytes()),
        })
    }

    fn broadcast_and_confirm(&self, signed: &SignedTx) -> SubmitOutcome {
        push(&self.trace, "broadcast");
        let mut state = self.state.lock().expect("submit lock");
        state.broadcasts += 1;
        state.last_raw = Some(signed.raw_base64.clone());
        match state.plan.first().cloned() {
            None => SubmitOutcome::Unknown,
            Some(Planned::Unknown) => {
                state.plan.remove(0);
                SubmitOutcome::Unknown
            }
            Some(Planned::Receipt { tx_hash, vm_state }) => {
                state.plan.remove(0);
                confirmed(tx_hash.as_deref().unwrap_or(&signed.tx_hash), &vm_state)
            }
        }
    }
}

/// A scripted broadcast result. `tx_hash: None` means "the transaction I was
/// handed", which is what a real send reports; naming a different hash is how
/// the integrity case is exercised.
#[derive(Debug, Clone)]
enum Planned {
    Unknown,
    Receipt {
        tx_hash: Option<String>,
        vm_state: String,
    },
}

/// A receipt for the transaction the send was handed.
fn signed_receipt(vm_state: &str) -> Planned {
    Planned::Receipt {
        tx_hash: None,
        vm_state: vm_state.to_string(),
    }
}

/// A receipt for a transaction the sponsor never signed.
fn foreign_receipt(tx_hash: &str, vm_state: &str) -> Planned {
    Planned::Receipt {
        tx_hash: Some(tx_hash.to_string()),
        vm_state: vm_state.to_string(),
    }
}

fn confirmed(tx_hash: &str, vm_state: &str) -> SubmitOutcome {
    SubmitOutcome::Confirmed(VmReceipt {
        tx_hash: tx_hash.to_string(),
        vm_state: vm_state.to_string(),
        exception: None,
    })
}

fn accepted(result: SponsorResult) -> SponsorAccepted {
    match result {
        SponsorResult::Accepted(ok) => ok,
        SponsorResult::Refused(bad) => panic!("expected acceptance, got {bad:?}"),
    }
}

fn refused(result: SponsorResult) -> SponsorRefusal {
    match result {
        SponsorResult::Refused(bad) => bad,
        SponsorResult::Accepted(ok) => panic!("expected a refusal, got {ok:?}"),
    }
}

/// A running fixture: one trace, one journal, one send port, one API.
struct Rig {
    trace: Trace,
    journal: Arc<FakeJournal>,
    submit: Arc<FakeSubmit>,
}

impl Rig {
    fn new() -> Self {
        let trace = new_trace();
        Rig {
            journal: Arc::new(FakeJournal::new(trace.clone())),
            submit: Arc::new(FakeSubmit::new(trace.clone())),
            trace,
        }
    }

    fn api(&self, enabled: bool) -> SponsorApi<Arc<FakeJournal>, Arc<FakeSubmit>> {
        SponsorApi {
            settings: settings(enabled),
            journal: Arc::clone(&self.journal),
            submit: Arc::clone(&self.submit),
        }
    }

    fn trace(&self) -> Vec<String> {
        trace_of(&self.trace)
    }
}

// ---------------------------------------------------------------------------
// 1. A crash after the journal write replays safely
// ---------------------------------------------------------------------------

#[test]
fn a_repeated_request_reserves_signs_and_broadcasts_exactly_once() {
    let rig = Rig::new();
    let api = rig.api(true);
    rig.submit.plan(vec![signed_receipt("HALT")]);
    let envelope = standard_envelope_hex();

    let first = accepted(api.submit(Some(&principal()), &request("key-1", &envelope)));
    let second = accepted(api.submit(Some(&principal()), &request("key-1", &envelope)));

    assert_eq!(first.code, SponsorCode::Confirmed);
    assert_eq!(second.code, SponsorCode::Confirmed);
    assert!(!first.replayed);
    assert!(second.replayed);
    assert_eq!(first.journal_id, second.journal_id);
    // One reservation, one signature, one broadcast. A retried request must not
    // pay twice.
    assert_eq!(rig.journal.reserves(), 1);
    assert_eq!(rig.submit.signs(), 1);
    assert_eq!(rig.submit.broadcasts(), 1);
}

#[test]
fn a_crash_between_the_journal_write_and_the_signature_finishes_the_same_reservation() {
    // The process died after `reserve` committed and before anything was
    // signed. Nothing left the building, so the retry may sign — but it must
    // sign into the reservation that already exists, not a second one.
    let rig = Rig::new();
    let api = rig.api(true);
    let envelope = standard_envelope_hex();

    rig.submit.refuse_sign();
    let crashed = refused(api.submit(Some(&principal()), &request("key-2", &envelope)));
    assert_eq!(crashed.code, SponsorCode::SendRefused);
    assert_eq!(rig.journal.reserves(), 1);
    assert_eq!(rig.submit.broadcasts(), 0);

    // The retry.
    rig.submit.allow_sign();
    rig.submit.plan(vec![signed_receipt("HALT")]);
    let replayed = accepted(api.submit(Some(&principal()), &request("key-2", &envelope)));

    assert_eq!(replayed.code, SponsorCode::Confirmed);
    assert_eq!(
        rig.journal.reserves(),
        1,
        "the reservation is not taken twice"
    );
    assert_eq!(rig.submit.signs(), 1);
    assert_eq!(rig.submit.broadcasts(), 1);
}

#[test]
fn a_crash_after_the_signed_journal_resends_the_same_bytes_and_never_re_signs() {
    // The process died after `signed` was journalled. The signed bytes are the
    // durable record of what was paid for, so the retry must resend those exact
    // bytes — "unknown broadcast resumes the same transaction, not compute".
    let rig = Rig::new();
    let api = rig.api(true);
    let envelope = standard_envelope_hex();

    rig.submit.plan(vec![Planned::Unknown]);
    let unknown = accepted(api.submit(Some(&principal()), &request("key-3", &envelope)));
    assert_eq!(unknown.code, SponsorCode::SubmissionUnknown);
    let journaled = rig
        .journal
        .job(&unknown.journal_id)
        .journal
        .get("signed")
        .cloned()
        .expect("a signed stage is journalled before the send");
    assert_eq!(journaled["tx_hash"].as_str().unwrap().len(), 66);
    assert_eq!(rig.submit.signs(), 1);
    let raw_after_first = rig.submit.last_raw();

    // The retry: same key, same envelope.
    rig.submit.plan(vec![signed_receipt("HALT")]);
    let replayed = accepted(api.submit(Some(&principal()), &request("key-3", &envelope)));

    assert_eq!(replayed.code, SponsorCode::Confirmed);
    assert_eq!(replayed.journal_id, unknown.journal_id);
    assert_eq!(
        rig.submit.signs(),
        1,
        "the journaled signature is never replaced"
    );
    assert_eq!(rig.submit.broadcasts(), 2);
    assert_eq!(
        rig.submit.last_raw(),
        raw_after_first,
        "the retry resends the journaled signed bytes, not a fresh transaction"
    );
    assert!(
        String::from_utf8(decode_lenient(&rig.submit.last_raw()))
            .expect("utf8")
            .starts_with("signed:"),
        "the bytes on the wire are the ones the signer produced"
    );
}

#[test]
fn a_completed_intent_is_replayed_from_the_journal_without_touching_the_send_port() {
    let rig = Rig::new();
    let api = rig.api(true);
    rig.submit.plan(vec![signed_receipt("HALT")]);
    let envelope = standard_envelope_hex();

    let first = accepted(api.submit(Some(&principal()), &request("key-4", &envelope)));
    let events_after_first = rig.trace();

    let second = accepted(api.submit(Some(&principal()), &request("key-4", &envelope)));

    assert!(second.replayed);
    assert_eq!(second.journal_id, first.journal_id);
    assert_eq!(second.tx_hash, first.tx_hash);
    assert_eq!(second.vm_state.as_deref(), Some("HALT"));
    assert_eq!(rig.submit.signs(), 1);
    assert_eq!(rig.submit.broadcasts(), 1);
    // The replay answers from the journal: the only thing it does is the
    // idempotent lookup that tells it the intent is already complete.
    let added: Vec<String> = rig
        .trace()
        .into_iter()
        .skip(events_after_first.len())
        .collect();
    assert_eq!(added, vec!["reserve:key-4".to_string()]);
}

// ---------------------------------------------------------------------------
// 2. SUBMISSION_UNKNOWN is handled
// ---------------------------------------------------------------------------

#[test]
fn an_unestablished_outcome_is_submission_unknown_and_is_parked_for_resumption() {
    let rig = Rig::new();
    let api = rig.api(true);
    rig.submit.plan(vec![Planned::Unknown]);

    let outcome = accepted(api.submit(
        Some(&principal()),
        &request("key-5", &standard_envelope_hex()),
    ));

    assert_eq!(outcome.code, SponsorCode::SubmissionUnknown);
    assert_eq!(outcome.vm_state, None);
    let job = rig.journal.job(&outcome.journal_id);
    assert_eq!(
        job.status, "broadcast_unknown",
        "an unknown outcome parks the job where the same transaction can resume"
    );
    assert!(job.journal.get("signed").is_some());
    assert!(
        job.journal.get("receipt").is_none(),
        "an unknown outcome never invents a receipt"
    );
}

#[test]
fn a_retry_of_an_unknown_submission_never_pays_a_second_time() {
    let rig = Rig::new();
    let api = rig.api(true);
    let envelope = standard_envelope_hex();
    rig.submit.plan(vec![Planned::Unknown, Planned::Unknown]);

    let first = accepted(api.submit(Some(&principal()), &request("key-6", &envelope)));
    let second = accepted(api.submit(Some(&principal()), &request("key-6", &envelope)));

    assert_eq!(first.code, SponsorCode::SubmissionUnknown);
    assert_eq!(second.code, SponsorCode::SubmissionUnknown);
    assert_eq!(first.journal_id, second.journal_id);
    assert_eq!(rig.journal.reserves(), 1);
    assert_eq!(rig.submit.signs(), 1);
    assert_eq!(rig.submit.broadcasts(), 2);
}

#[test]
fn an_unknown_outcome_is_never_reported_as_a_retryable_failure() {
    // The platform rule: an unknown outcome must not become an ordinary failure
    // a caller is invited to re-sign. It answers with a code outside the refusal
    // vocabulary and with the journal id a caller has to carry.
    let rig = Rig::new();
    let api = rig.api(true);
    rig.submit.plan(vec![Planned::Unknown]);

    let ok = accepted(api.submit(
        Some(&principal()),
        &request("key-7", &standard_envelope_hex()),
    ));

    assert_eq!(ok.code, SponsorCode::SubmissionUnknown);
    assert!(!ok.code.is_refusal());
    assert!(ok.journal_id.len() > 16);
}

#[test]
fn only_the_transaction_that_was_signed_can_complete_the_intent() {
    let rig = Rig::new();
    let api = rig.api(true);
    let envelope = standard_envelope_hex();
    // The send reports a receipt for some other transaction. That is an
    // integrity failure, not a completion, and it is never written as one.
    rig.submit.plan(vec![foreign_receipt("0xdeadbeef", "HALT")]);

    let bad = refused(api.submit(Some(&principal()), &request("key-8", &envelope)));

    assert_eq!(bad.code, SponsorCode::ReceiptMismatch);
    let job = rig.journal.only_job();
    assert!(
        job.journal.get("receipt").is_none(),
        "a receipt for another transaction is never recorded"
    );
    assert_ne!(job.status, "completed");
}

// ---------------------------------------------------------------------------
// 3. The kill switch
// ---------------------------------------------------------------------------

#[test]
fn a_halted_sponsor_refuses_and_writes_nothing() {
    let rig = Rig::new();
    let api = rig.api(false);

    let bad = refused(api.submit(
        Some(&principal()),
        &request("key-9", &standard_envelope_hex()),
    ));

    assert_eq!(bad.code, SponsorCode::Disabled);
    assert_eq!(rig.journal.reserves(), 0);
    assert!(
        rig.trace().is_empty(),
        "a halted sponsor touches nothing at all: {:?}",
        rig.trace()
    );
}

#[test]
fn opening_the_switch_lets_the_identical_request_through() {
    let rig = Rig::new();
    let envelope = standard_envelope_hex();

    let bad = refused(
        rig.api(false)
            .submit(Some(&principal()), &request("key-10", &envelope)),
    );
    assert_eq!(bad.code, SponsorCode::Disabled);
    assert_eq!(rig.journal.reserves(), 0);

    rig.submit.plan(vec![signed_receipt("HALT")]);
    let ok = accepted(
        rig.api(true)
            .submit(Some(&principal()), &request("key-10", &envelope)),
    );
    assert_eq!(ok.code, SponsorCode::Confirmed);
    assert_eq!(rig.journal.reserves(), 1);
}

#[test]
fn the_switch_is_read_before_the_principal_so_a_halt_always_wins() {
    // A kill switch that still evaluated a request is not a kill switch.
    let rig = Rig::new();
    let bad = refused(
        rig.api(false)
            .submit(None, &request("key-11", &standard_envelope_hex())),
    );
    assert_eq!(bad.code, SponsorCode::Disabled);
    assert!(rig.trace().is_empty());
}

// ---------------------------------------------------------------------------
// 4. Idempotency keys
// ---------------------------------------------------------------------------

#[test]
fn a_missing_idempotency_key_is_refused_before_any_write() {
    let rig = Rig::new();
    let api = rig.api(true);
    for key in ["", "   "] {
        let bad = refused(api.submit(Some(&principal()), &request(key, &standard_envelope_hex())));
        assert_eq!(bad.code, SponsorCode::IdempotencyKeyRequired);
    }
    assert_eq!(rig.journal.reserves(), 0);
    assert!(rig.trace().is_empty());
}

#[test]
fn the_same_key_with_a_different_envelope_is_a_conflict() {
    let rig = Rig::new();
    let api = rig.api(true);
    rig.submit.plan(vec![signed_receipt("HALT")]);
    let first_envelope = standard_envelope_hex();
    let second_envelope = envelope_hex(&register_account_script(), 2_000, 250);

    let _ = accepted(api.submit(Some(&principal()), &request("key-12", &first_envelope)));
    let bad = refused(api.submit(Some(&principal()), &request("key-12", &second_envelope)));

    assert_eq!(bad.code, SponsorCode::IdempotencyConflict);
    assert_eq!(rig.journal.reserves(), 1);
    assert_eq!(
        rig.submit.signs(),
        1,
        "a conflicting retry never reaches the signer"
    );
}

#[test]
fn the_same_key_with_the_same_envelope_replays() {
    let rig = Rig::new();
    let api = rig.api(true);
    rig.submit.plan(vec![signed_receipt("HALT")]);
    let envelope = standard_envelope_hex();

    let first = accepted(api.submit(Some(&principal()), &request("key-13", &envelope)));
    let second = accepted(api.submit(Some(&principal()), &request("key-13", &envelope)));
    assert_eq!(first.journal_id, second.journal_id);
    assert!(second.replayed);
}

#[test]
fn one_principals_key_does_not_collide_with_anothers() {
    let rig = Rig::new();
    let api = rig.api(true);
    rig.submit
        .plan(vec![signed_receipt("HALT"), signed_receipt("HALT")]);
    let envelope = standard_envelope_hex();

    let first = accepted(api.submit(Some(&principal()), &request("shared", &envelope)));
    let second = accepted(api.submit(Some(&other_principal()), &request("shared", &envelope)));

    assert_ne!(first.journal_id, second.journal_id);
    assert_eq!(rig.journal.reserves(), 2);
}

// ---------------------------------------------------------------------------
// 5. Journal before broadcast
// ---------------------------------------------------------------------------

#[test]
fn the_commit_protocol_is_reserve_prepared_sign_signed_broadcast_complete() {
    let rig = Rig::new();
    let api = rig.api(true);
    rig.submit.plan(vec![signed_receipt("HALT")]);

    let _ = accepted(api.submit(
        Some(&principal()),
        &request("key-14", &standard_envelope_hex()),
    ));

    // The signed bytes are durable before anything is sent: the signature is
    // taken between `prepared` and `signed`, and the send only after `signed`.
    assert_eq!(
        rig.trace(),
        vec![
            "reserve:key-14".to_string(),
            "stage:prepared".to_string(),
            "sign".to_string(),
            "stage:signed".to_string(),
            "broadcast".to_string(),
            "stage:completed".to_string(),
        ]
    );
}

#[test]
fn a_request_that_fails_before_the_journal_write_sends_nothing() {
    let rig = Rig::new();
    let api = rig.api(true);
    // An envelope whose measured fee is above the ceiling is refused by the
    // validator before any reservation is taken.
    let greedy = envelope_hex(&register_account_script(), CEILING, 1);
    let bad = refused(api.submit(Some(&principal()), &request("key-15", &greedy)));

    assert_eq!(
        bad.intent_code.as_deref(),
        Some("SPONSOR_INTENT_FEE_OVER_CEILING")
    );
    assert_eq!(rig.journal.reserves(), 0);
    assert!(rig.trace().is_empty());
}

// ---------------------------------------------------------------------------
// 6. HALT-confirmed receipts
// ---------------------------------------------------------------------------

#[test]
fn a_halt_receipt_completes_and_reports_the_journal_id() {
    let rig = Rig::new();
    let api = rig.api(true);
    rig.submit.plan(vec![signed_receipt("HALT")]);

    let ok = accepted(api.submit(
        Some(&principal()),
        &request("key-16", &standard_envelope_hex()),
    ));

    assert_eq!(ok.code, SponsorCode::Confirmed);
    assert_eq!(ok.vm_state.as_deref(), Some("HALT"));
    assert!(ok.journal_id.len() > 8);
    let job = rig.journal.job(&ok.journal_id);
    // The reported hash is the signed one, and the receipt the store holds is
    // bound to exactly that hash.
    assert_eq!(ok.tx_hash, job.journal["signed"]["tx_hash"]);
    assert_eq!(job.status, "completed");
    assert_eq!(job.journal["receipt"]["vm_state"], "HALT");
    assert_eq!(
        job.journal["receipt"]["tx_hash"],
        job.journal["signed"]["tx_hash"]
    );
}

#[test]
fn a_fault_receipt_is_a_confirmed_failure_and_never_a_completion() {
    let rig = Rig::new();
    let api = rig.api(true);
    rig.submit.plan(vec![signed_receipt("FAULT")]);

    let ok = accepted(api.submit(
        Some(&principal()),
        &request("key-17", &standard_envelope_hex()),
    ));

    assert_eq!(ok.code, SponsorCode::Faulted);
    assert_eq!(ok.vm_state.as_deref(), Some("FAULT"));
    let job = rig.journal.job(&ok.journal_id);
    assert_eq!(job.status, "dead_letter");
}

// ---------------------------------------------------------------------------
// 7. The fee is measured, never declared
// ---------------------------------------------------------------------------

#[test]
fn the_request_carries_no_fee_and_the_response_reports_the_measured_one() {
    let rig = Rig::new();
    let api = rig.api(true);
    rig.submit.plan(vec![signed_receipt("HALT")]);

    let ok = accepted(api.submit(
        Some(&principal()),
        &request("key-18", &standard_envelope_hex()),
    ));

    assert_eq!(
        ok.fee,
        SponsorFee {
            transaction_fee_units: 1_250,
            reimbursement_units: 0,
            sponsor_fee_units: 1_250,
        }
    );
}

#[test]
fn a_budget_refusal_is_reported_and_sends_nothing() {
    let rig = Rig::new();
    let api = rig.api(true);
    rig.journal.force_budget_exhausted();

    let bad = refused(api.submit(
        Some(&principal()),
        &request("key-19", &standard_envelope_hex()),
    ));
    assert_eq!(bad.code, SponsorCode::BudgetExhausted);
    assert_eq!(rig.submit.signs(), 0);
}

// ---------------------------------------------------------------------------
// 8. Stable codes are frozen
// ---------------------------------------------------------------------------

#[test]
fn the_api_code_table_is_frozen() {
    let codes: Vec<&str> = SponsorCode::ALL.iter().map(|c| c.as_str()).collect();
    assert_eq!(
        codes,
        vec![
            "SPONSOR_DISABLED",
            "SPONSOR_PRINCIPAL_REQUIRED",
            "SPONSOR_REQUEST_INVALID",
            "SPONSOR_IDEMPOTENCY_KEY_REQUIRED",
            "SPONSOR_IDEMPOTENCY_CONFLICT",
            "SPONSOR_BUDGET_EXHAUSTED",
            "SPONSOR_JOURNAL_REFUSED",
            "SPONSOR_SEND_REFUSED",
            "SPONSOR_RECEIPT_MISMATCH",
            "SPONSOR_CONFIRMED",
            "SPONSOR_FAULTED",
            "SUBMISSION_UNKNOWN",
        ]
    );
}

#[test]
fn the_validator_codes_pass_through_unchanged() {
    let rig = Rig::new();
    let api = rig.api(true);
    let wrong_target = create_invoke_script(
        &ACCOUNT,
        "registerAccount",
        &[
            hash_param(&ACCOUNT),
            hash_param(&VERIFIER),
            ContractParam::HexBytes("cafebabe".to_string()),
            hash_param(&HOOK),
            hash_param(&BACKUP),
            ContractParam::Integer(1),
        ],
    )
    .expect("valid fixture");

    let bad = refused(api.submit(
        Some(&principal()),
        &request("key-20", &envelope_hex(&wrong_target, 1, 1)),
    ));

    assert_eq!(
        bad.intent_code.as_deref(),
        Some("SPONSOR_INTENT_WRONG_TARGET")
    );
    // The API does not re-spell the validator's vocabulary.
    assert_eq!(bad.code, SponsorCode::RequestInvalid);
}

// ---------------------------------------------------------------------------
// 9. No client-declared fact reaches the response
// ---------------------------------------------------------------------------

#[test]
fn the_request_body_has_no_principal_and_no_fee_field() {
    let rig = Rig::new();
    let api = rig.api(true);
    rig.submit.plan(vec![signed_receipt("HALT")]);

    // A hostile caller tries to declare both. They must be ignored: the
    // principal comes from the authenticated hop and the fee from the bytes.
    let body = json!({
        "envelope_hex": standard_envelope_hex(),
        "principal": "00000000-0000-4000-8000-000000000000",
        "fee_ceiling_units": 20000000,
        "transaction_fee_units": 1,
        "method": "transfer",
        "target": "0xd2a4cff31913016155e38e474a2c06d08be276cf",
    })
    .to_string();

    let response = handle(
        &api,
        &SponsorHttpRequest {
            principal: Some(principal()),
            idempotency_key: Some("key-21".to_string()),
            body,
        },
    );

    assert_eq!(response.status, 200);
    assert_eq!(response.body["code"], "SPONSOR_CONFIRMED");
    for forbidden in [
        "principal",
        "fee_ceiling_units",
        "method",
        "target",
        "account",
    ] {
        assert!(
            response.body.get(forbidden).is_none(),
            "a client-declared {forbidden} must not appear in the response"
        );
    }
    assert_eq!(response.body["transaction_fee_units"], 1250);
}

#[test]
fn a_request_without_an_authenticated_principal_is_refused() {
    let rig = Rig::new();
    let api = rig.api(true);

    let response = handle(
        &api,
        &SponsorHttpRequest {
            principal: None,
            idempotency_key: Some("key-22".to_string()),
            body: json!({"envelope_hex": standard_envelope_hex()}).to_string(),
        },
    );

    assert_eq!(response.status, 401);
    assert_eq!(response.body["code"], "SPONSOR_PRINCIPAL_REQUIRED");
    assert_eq!(rig.journal.reserves(), 0);
    assert!(rig.trace().is_empty());
}

#[test]
fn the_response_carries_a_journal_id_and_a_receipt_but_no_submitted_amount() {
    let rig = Rig::new();
    let api = rig.api(true);
    rig.submit.plan(vec![signed_receipt("HALT")]);

    let response = handle(
        &api,
        &SponsorHttpRequest {
            principal: Some(principal()),
            idempotency_key: Some("key-23".to_string()),
            body: json!({"envelope_hex": standard_envelope_hex()}).to_string(),
        },
    );

    assert_eq!(response.status, 200);
    assert!(response.body["journal_id"].as_str().unwrap().len() > 8);
    assert_eq!(response.body["vm_state"], "HALT");
    assert_eq!(response.body["replayed"], json!(false));
    let job = rig
        .journal
        .job(response.body["journal_id"].as_str().unwrap());
    assert_eq!(response.body["tx_hash"], job.journal["signed"]["tx_hash"]);
}

#[test]
fn submission_unknown_is_answered_with_202_and_the_journal_id() {
    let rig = Rig::new();
    let api = rig.api(true);
    rig.submit.plan(vec![Planned::Unknown]);

    let response = handle(
        &api,
        &SponsorHttpRequest {
            principal: Some(principal()),
            idempotency_key: Some("key-24".to_string()),
            body: json!({"envelope_hex": standard_envelope_hex()}).to_string(),
        },
    );

    assert_eq!(response.status, 202);
    assert_eq!(response.body["code"], "SUBMISSION_UNKNOWN");
    assert!(response.body["journal_id"].as_str().unwrap().len() > 8);
}

#[test]
fn a_malformed_body_is_refused_without_touching_the_journal() {
    let rig = Rig::new();
    let api = rig.api(true);
    for body in [
        "",
        "not json",
        "{}",
        r#"{"envelope_hex": 7}"#,
        r#"{"envelope_hex": "zz"}"#,
    ] {
        let response = handle(
            &api,
            &SponsorHttpRequest {
                principal: Some(principal()),
                idempotency_key: Some("key-25".to_string()),
                body: body.to_string(),
            },
        );
        assert_eq!(response.status, 400, "body {body:?}");
        assert_eq!(response.body["code"], "SPONSOR_REQUEST_INVALID");
    }
    assert!(rig.trace().is_empty());
}

#[test]
fn the_kill_switch_is_503_over_http() {
    let rig = Rig::new();
    let api = rig.api(false);
    let response = handle(
        &api,
        &SponsorHttpRequest {
            principal: Some(principal()),
            idempotency_key: Some("key-26".to_string()),
            body: json!({"envelope_hex": standard_envelope_hex()}).to_string(),
        },
    );
    assert_eq!(response.status, 503);
    assert_eq!(response.body["code"], "SPONSOR_DISABLED");
}

// ---------------------------------------------------------------------------
// Envelope facts are derived, not echoed
// ---------------------------------------------------------------------------

#[test]
fn the_sponsor_account_is_the_envelope_fee_payer_not_a_request_field() {
    let rig = Rig::new();
    let api = rig.api(true);
    rig.submit.plan(vec![signed_receipt("HALT")]);

    let ok = accepted(api.submit(
        Some(&principal()),
        &request("key-27", &standard_envelope_hex()),
    ));

    // The reservation names the sponsor account the transaction will consume a
    // nonce for, and it is the signer read out of the envelope.
    assert_eq!(
        rig.journal.job(&ok.journal_id).journal["prepared"]["sponsor_account"],
        json!(display(&FEE_PAYER))
    );
}

#[test]
fn the_intent_method_is_derived_from_the_script_inside_the_envelope() {
    let rig = Rig::new();
    let api = rig.api(true);
    rig.submit.plan(vec![signed_receipt("HALT")]);

    let ok = accepted(api.submit(
        Some(&principal()),
        &request("key-28", &standard_envelope_hex()),
    ));

    assert_eq!(
        rig.journal.job(&ok.journal_id).journal["prepared"]["method"],
        "registerAccount"
    );
}

// `ApiResponse` is part of the HTTP surface the tests above assert on; naming
// the type here keeps the import honest.
fn _response_shape(response: ApiResponse) -> (u16, Value) {
    (response.status, response.body)
}
