//! The send port's production implementation: custody signature, Neo N3
//! broadcast, and application-log confirmation.
//!
//! Two rules come from `docs/RELAYER_DURABLE_V2.md` and decide the outcome
//! classification below.
//!
//! * *A mempool acceptance is never a successful delivery by itself.* Only a
//!   concrete application log with a concrete `vmstate` produces a receipt.
//! * *A timeout or arbitrary RPC error is never treated as transaction
//!   absence.* Anything that does not establish what happened is
//!   [`SubmitOutcome::Unknown`], which the state machine turns into
//!   `SUBMISSION_UNKNOWN` rather than a retryable failure.
//!
//! Signing is a separate step from broadcasting on purpose: the caller journals
//! the signed bytes between the two, which is the whole point of
//! journal-before-broadcast. Nothing here writes to any store.

use neo_os_chain_n3::custody::CustodyClient;
use neo_os_chain_n3::rpc::NeoRpcClient;
use neo_os_chain_n3::tx::{CustodySigner, CustodySignerAdapter};
use neo_os_chain_n3::HttpTransport;
use neo_os_core::base64::encode_standard;
use neo_os_core::n3_tx::parse_unsigned_tx;
use serde_json::Value;

use crate::sponsor::{SignedTx, SponsorSubmit, SubmitOutcome, VmReceipt};

/// Signs one sponsor transaction and puts it on the Neo N3 network.
pub struct ChainSubmit<C: HttpTransport, R: HttpTransport> {
    pub custody: CustodyClient<C>,
    pub signer: CustodySigner,
    pub rpc: NeoRpcClient<R>,
    /// How many application-log observations to make before giving up. Giving
    /// up is `Unknown`, never "absent".
    pub confirm_attempts: u32,
    /// Wait between observations, in milliseconds.
    pub confirm_wait_ms: u64,
    /// How to wait between observations. Injected so the polling is testable
    /// without real time, matching `neo_os_chain_n3::tx::Waiter`.
    pub wait: Box<dyn Fn(u64) + Send + Sync>,
}

impl<C: HttpTransport, R: HttpTransport> ChainSubmit<C, R> {
    /// One observation attempt, then `Unknown`. Nothing here decides that a
    /// missing log means the transaction is absent.
    fn observe(&self, tx_hash: &str) -> SubmitOutcome {
        let attempts = self.confirm_attempts.max(1);
        for attempt in 0..attempts {
            if let Ok(log) = self.rpc.get_application_log(tx_hash) {
                if let Some(receipt) = receipt_from_log(tx_hash, &log) {
                    return SubmitOutcome::Confirmed(receipt);
                }
            }
            if attempt + 1 < attempts {
                (self.wait)(self.confirm_wait_ms);
            }
        }
        SubmitOutcome::Unknown
    }
}

impl<C: HttpTransport, R: HttpTransport> SponsorSubmit for ChainSubmit<C, R> {
    fn sign(&self, envelope_hex: &str) -> Result<SignedTx, String> {
        let bytes = hex::decode(envelope_hex).map_err(|_| "the envelope is not hexadecimal")?;
        let envelope = parse_unsigned_tx(&bytes)
            .map_err(|error| format!("the envelope is unusable: {error}"))?;

        // The sponsor signs a transaction whose fee payer is the sponsor key.
        // Anything else would spend the key's witness on a transaction that
        // settles against another account.
        let declared = format!("0x{}", hex::encode(envelope.signer));
        let configured = self.signer.script_hash.trim().to_ascii_lowercase();
        let configured = configured.strip_prefix("0x").unwrap_or(&configured);
        let declared = declared.trim_start_matches("0x").to_ascii_lowercase();
        if configured != declared {
            return Err(format!(
                "the envelope names fee payer 0x{declared}, not the sponsor key {}",
                self.signer.script_hash
            ));
        }

        let adapter = CustodySignerAdapter {
            client: &self.custody,
            signer: &self.signer,
        };
        let witness = adapter.sign(envelope_hex)?;
        adapter.verify_witness(&witness)?;

        let raw = envelope.serialize_signed(std::slice::from_ref(&witness));
        Ok(SignedTx {
            tx_hash: envelope.hash_display(),
            raw_base64: encode_standard(&raw),
        })
    }

    fn broadcast_and_confirm(&self, signed: &SignedTx) -> SubmitOutcome {
        match self.rpc.send_raw_transaction(&signed.raw_base64) {
            // The node accepted the bytes. Acceptance is not confirmation.
            Ok(true) => self.observe(&signed.tx_hash),
            // The node read the bytes and refused them. Nothing is in flight,
            // so the journalled signature can simply be resent.
            Ok(false) => SubmitOutcome::Rejected(
                "sendrawtransaction refused the signed transaction".to_string(),
            ),
            // A timeout, a connection failure or an ambiguous node error: the
            // transaction may or may not have been taken. Nothing is claimed.
            Err(_) => SubmitOutcome::Unknown,
        }
    }
}

/// `getapplicationlog` → the first execution's `vmstate` and exception.
///
/// A log with no concrete execution state is not a receipt: the observer keeps
/// looking rather than inventing one.
fn receipt_from_log(tx_hash: &str, log: &Value) -> Option<VmReceipt> {
    if log.get("txid").and_then(Value::as_str).is_some_and(|id| {
        !id.eq_ignore_ascii_case(tx_hash)
            && !id.eq_ignore_ascii_case(tx_hash.trim_start_matches("0x"))
    }) {
        return None;
    }
    let execution = log.get("executions")?.as_array()?.first()?;
    let vm_state = execution
        .get("vmstate")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|state| !state.is_empty())?
        .to_ascii_uppercase();
    let exception = execution
        .get("exception")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string);
    Some(VmReceipt {
        tx_hash: tx_hash.to_string(),
        vm_state,
        exception,
    })
}
