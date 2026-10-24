//! Durable v2 operations are database transactions, not client-side PATCH
//! sequences. The returned generation fences every subsequent journal write.
use crate::{HttpTransport, RequestOptions, SupabaseClient};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const DELIVERY_OPERATIONS: &[&str] = &[
    "renew",
    "prepared",
    "signed",
    "no_update",
    "faulted",
    "expired",
    "reconciled",
    "completed",
    "retry",
    "terminal",
];

/// The durable delivery state is a separate protocol from transaction outcome.
/// In particular, `completed` means the delivery job reached its terminal
/// store state; chain confirmation still requires an evidence-bound receipt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeliveryStatus {
    Queued,
    Processing,
    Prepared,
    Signed,
    BroadcastUnknown,
    RetryScheduled,
    Completed,
    DeadLetter,
    ReconcileRequired,
}

impl DeliveryStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Processing => "processing",
            Self::Prepared => "prepared",
            Self::Signed => "signed",
            Self::BroadcastUnknown => "broadcast_unknown",
            Self::RetryScheduled => "retry_scheduled",
            Self::Completed => "completed",
            Self::DeadLetter => "dead_letter",
            Self::ReconcileRequired => "reconcile_required",
        }
    }
}

fn validate_delivery_operation(operation: &str) -> Result<(), String> {
    if DELIVERY_OPERATIONS.contains(&operation) {
        Ok(())
    } else {
        Err(format!("unsupported delivery operation: {operation}"))
    }
}

fn pack_event(event: &Value) -> Value {
    let semantics = json!([
        event.get("payload"),
        event.get("payloadHex"),
        event.get("payload_hex"),
        event.get("appId"),
        event.get("moduleId"),
        event.get("operation"),
        event.get("requestType")
    ]);
    json!({"requestId":event.get("requestId"),"kind":event.get("kind").cloned().unwrap_or(json!("request")),"max_attempts":event.get("max_attempts").cloned().unwrap_or(json!(6)),
        "event_base64":neo_os_core::base64::encode_standard(event.to_string().as_bytes()),
        "payload_digest":hex::encode(Sha256::digest(semantics.to_string().as_bytes()))})
}
fn decode_job(value: Value) -> Result<DeliveryJob, String> {
    let mut job: DeliveryJob = serde_json::from_value(value).map_err(|e| e.to_string())?;
    if let Some(body) = job.event.get("event_base64").and_then(Value::as_str) {
        let bytes = neo_os_core::base64::decode_lenient(body);
        if neo_os_core::base64::encode_standard(&bytes) != body {
            return Err("noncanonical delivery event encoding".into());
        }
        job.event =
            serde_json::from_slice(&bytes).map_err(|e| format!("corrupt delivery event: {e}"))?;
    }
    if let Some(body) = job
        .journal
        .pointer("/prepared/content_base64")
        .and_then(Value::as_str)
    {
        let bytes = neo_os_core::base64::decode_lenient(body);
        if neo_os_core::base64::encode_standard(&bytes) != body {
            return Err("noncanonical prepared journal encoding".into());
        }
        serde_json::from_slice::<Value>(&bytes)
            .map_err(|e| format!("corrupt prepared journal: {e}"))?;
    }
    Ok(job)
}

/// The reservation `morpheus_delivery_sponsor_reserve` holds.
///
/// One shape for one fact: the sponsor API builds this and the store sends it,
/// so there is no second field list that could drift from the RPC's arguments.
/// Identity is `(network, principal, idempotency_key)`; everything else must
/// match on a retry or the store raises `sponsor idempotency conflict`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SponsorReservation {
    pub network: String,
    pub principal: String,
    pub idempotency_key: String,
    /// The called contract, display order (`0x` + 40 hex).
    pub contract: String,
    /// The sponsor account the transaction consumes a nonce for, display order.
    pub account: String,
    /// The derived intent facts.
    pub intent: Value,
    /// The approved ceiling for one intent, GAS datoshi.
    pub fee_ceiling_units: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeliveryJob {
    pub job_key: String,
    pub generation: u64,
    pub attempts: u64,
    pub event: Value,
    pub journal: Value,
    pub status: DeliveryStatus,
    pub kind: String,
    pub contract: String,
    pub chain: String,
}

pub struct DeliveryStore<'a, T: HttpTransport> {
    pub client: &'a SupabaseClient<T>,
}
impl<T: HttpTransport> DeliveryStore<'_, T> {
    pub fn seed_feed_baseline(
        &self,
        chain: &str,
        contract: &str,
        snapshot: &Value,
        now_ms: u64,
    ) -> Result<(), String> {
        self.rpc("feed_baseline",json!({"p_network":self.client.config().network,"p_chain":chain,"p_contract":contract,"p_snapshot":snapshot}),now_ms)?;
        Ok(())
    }
    pub fn lookup(&self, key: &str, now_ms: u64) -> Result<DeliveryJob, String> {
        decode_job(self.rpc("lookup", json!({"p_job":key}), now_ms)?)
    }
    pub fn reconcile(
        &self,
        job: &DeliveryJob,
        receipt: Value,
        actor: &str,
        reason: &str,
        now_ms: u64,
    ) -> Result<(), String> {
        self.rpc("reconcile",json!({"p_job":job.job_key,"p_generation":job.generation,"p_receipt":receipt,"p_actor":actor,"p_reason":reason}),now_ms)?;
        Ok(())
    }
    pub fn account_health(&self, chain: &str, account: &str, now_ms: u64) -> Result<Value, String> {
        self.rpc(
            "account_health",
            json!({"p_network":self.client.config().network,"p_chain":chain,"p_account":account}),
            now_ms,
        )
    }
    pub fn replay(
        &self,
        key: &str,
        actor: &str,
        reason: &str,
        resolve_legacy: bool,
        now_ms: u64,
    ) -> Result<(), String> {
        self.rpc(
            if resolve_legacy {
                "resolve_legacy"
            } else {
                "replay"
            },
            json!({"p_job":key,"p_actor":actor,"p_reason":reason}),
            now_ms,
        )?;
        Ok(())
    }
    pub fn import_legacy(
        &self,
        chain: &str,
        contract: &str,
        event: &Value,
        legacy: &Value,
        now_ms: u64,
    ) -> Result<DeliveryJob, String> {
        let id = event
            .get("requestId")
            .and_then(Value::as_str)
            .ok_or("legacy request id missing")?;
        let result=self.rpc("import_legacy",json!({"p_network":self.client.config().network,"p_chain":chain,"p_contract":contract,"p_request_id":id,"p_account":"oracle-updater","p_event":pack_event(event),"p_legacy":legacy}),now_ms)?;
        decode_job(result)
    }
    pub fn feed_baseline(&self, chain: &str, contract: &str, now_ms: u64) -> Result<Value, String> {
        self.rpc(
            "feed_baseline",
            json!({"p_network":self.client.config().network,"p_chain":chain,"p_contract":contract}),
            now_ms,
        )
    }
    fn rpc(&self, name: &str, body: Value, now_ms: u64) -> Result<Value, String> {
        let text = self.client.request(
            &format!("rpc/morpheus_delivery_{name}"),
            "POST",
            Some(&body),
            &RequestOptions::default(),
            now_ms,
        )?;
        serde_json::from_str(&text)
            .map_err(|error| format!("delivery RPC {name} returned invalid JSON: {error}"))
    }
    pub fn enqueue(
        &self,
        chain: &str,
        contract: &str,
        account: &str,
        event: &Value,
        now_ms: u64,
    ) -> Result<DeliveryJob, String> {
        let id = event
            .get("requestId")
            .and_then(Value::as_str)
            .ok_or("delivery requestId must be an exact decimal string")?;
        let result = self.rpc("enqueue", json!({"p_network":self.client.config().network,"p_chain":chain,"p_contract":contract,"p_request_id":id,"p_account":account,"p_event":pack_event(event)}), now_ms)?;
        decode_job(result)
    }
    pub fn claim(
        &self,
        chain: &str,
        account: &str,
        owner: &str,
        lease_ms: u64,
        now_ms: u64,
        kinds: &[&str],
    ) -> Result<Option<DeliveryJob>, String> {
        let result = self.rpc("claim", json!({"p_network":self.client.config().network,"p_chain":chain,"p_account":account,"p_owner":owner,"p_lease_ms":lease_ms,"p_kinds":kinds}), now_ms)?;
        if result.is_null() {
            return Ok(None);
        }
        decode_job(result).map(Some)
    }
    pub fn transition(
        &self,
        job: &DeliveryJob,
        owner: &str,
        op: &str,
        data: Value,
        lease_ms: u64,
        now_ms: u64,
    ) -> Result<DeliveryJob, String> {
        validate_delivery_operation(op)?;
        let data = if op == "prepared" {
            json!({"content_base64":neo_os_core::base64::encode_standard(data.to_string().as_bytes()),"feed_response":data.get("feed_response"),"feed_baseline_patch":data.get("feed_baseline_patch")})
        } else {
            data
        };
        let result = self.rpc("transition", json!({"p_job":job.job_key,"p_owner":owner,"p_generation":job.generation,"p_op":op,"p_data":data,"p_lease_ms":lease_ms}), now_ms)?;
        decode_job(result)
    }
    /// `morpheus_delivery_sponsor_reserve` — the only writer of a sponsor
    /// intent and of every budget counter. One database transaction journals
    /// the intent, debits the three budgets and enqueues the bound delivery
    /// job, so a job can never exist unreserved and a reservation can never
    /// survive a failed enqueue.
    ///
    /// It is also the idempotency primitive: an identical retry returns the
    /// original job and charges nothing, and a retry that reuses the key with a
    /// different intent is SQLSTATE `22023` `sponsor idempotency conflict`.
    /// The caller never decides which of the two happened by inspecting a row.
    pub fn sponsor_reserve(
        &self,
        reservation: &SponsorReservation,
        now_ms: u64,
    ) -> Result<DeliveryJob, String> {
        let result = self.rpc(
            "sponsor_reserve",
            json!({
                "p_network": self.client.config().network,
                "p_principal": reservation.principal,
                "p_idempotency_key": reservation.idempotency_key,
                "p_contract": reservation.contract,
                "p_account": reservation.account,
                "p_intent": reservation.intent,
                "p_fee_ceiling_units": reservation.fee_ceiling_units,
            }),
            now_ms,
        )?;
        decode_job(result)
    }

    /// A delivery transition that passes `data` to the store **verbatim**.
    ///
    /// [`Self::transition`] wraps the `prepared` stage in the feed lane's
    /// `content_base64` envelope. The sponsor guard reads
    /// `journal.prepared.fee_ceiling_units` off the stage object itself, so the
    /// sponsor lane must not go through that wrapper. Every other operation is
    /// byte-identical to [`Self::transition`].
    pub fn sponsor_stage(
        &self,
        job: &DeliveryJob,
        owner: &str,
        op: &str,
        data: Value,
        lease_ms: u64,
        now_ms: u64,
    ) -> Result<DeliveryJob, String> {
        validate_delivery_operation(op)?;
        let result = self.rpc(
            "transition",
            json!({
                "p_job": job.job_key,
                "p_owner": owner,
                "p_generation": job.generation,
                "p_op": op,
                "p_data": data,
                "p_lease_ms": lease_ms,
            }),
            now_ms,
        )?;
        decode_job(result)
    }

    pub fn checkpoint(
        &self,
        chain: &str,
        contract: &str,
        cursor: Option<&str>,
        now_ms: u64,
    ) -> Result<Option<String>, String> {
        let result = self.rpc("checkpoint", json!({"p_network":self.client.config().network,"p_chain":chain,"p_contract":contract,"p_cursor":cursor}), now_ms)?;
        if result.is_null() {
            return Ok(None);
        }
        result
            .as_str()
            .map(|value| Some(value.to_owned()))
            .ok_or_else(|| "invalid delivery checkpoint".into())
    }
}

#[cfg(test)]
mod tests {
    use super::{pack_event, validate_delivery_operation, DeliveryStatus};
    use serde_json::json;

    #[test]
    fn delivery_status_is_closed_and_does_not_alias_transaction_terminals() {
        let completed: DeliveryStatus = serde_json::from_value(json!("completed")).unwrap();
        assert_eq!(completed, DeliveryStatus::Completed);
        assert_eq!(completed.as_str(), "completed");
        assert!(serde_json::from_value::<DeliveryStatus>(json!("confirmed")).is_err());
        assert!(serde_json::from_value::<DeliveryStatus>(json!("unknown")).is_err());
    }

    #[test]
    fn payload_digest_distinguishes_raw_bytes_and_preserves_exact_retry_idempotency() {
        let first = json!({
            "requestId": "7",
            "payload": "{}",
            "payloadHex": "7b7d",
            "appId": "app",
            "operation": "compute"
        });
        let mut second = first.clone();
        second["payloadHex"] = json!("7b20");
        let packed_first = pack_event(&first);
        let packed_retry = pack_event(&first);
        let packed_second = pack_event(&second);
        assert_eq!(packed_first["payload"], packed_second["payload"]);
        assert_eq!(
            packed_first["payload_digest"],
            packed_retry["payload_digest"]
        );
        assert_ne!(
            packed_first["payload_digest"],
            packed_second["payload_digest"]
        );
        assert_ne!(packed_first["event_base64"], packed_second["event_base64"]);
    }

    #[test]
    fn delivery_operations_fail_closed_before_rpc() {
        for operation in [
            "renew",
            "prepared",
            "signed",
            "no_update",
            "faulted",
            "expired",
            "reconciled",
            "completed",
            "retry",
            "terminal",
        ] {
            assert!(
                validate_delivery_operation(operation).is_ok(),
                "{operation}"
            );
        }
        let error = validate_delivery_operation("confirmed").unwrap_err();
        assert!(error.contains("unsupported delivery operation"));
    }
}
