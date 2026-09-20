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
    use super::{validate_delivery_operation, DeliveryStatus};
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
