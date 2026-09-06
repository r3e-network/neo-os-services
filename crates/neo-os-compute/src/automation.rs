//! Pure automation-execution contract shared by the Rust host and its tests.
//!
//! Scheduling and durable claiming remain control-plane responsibilities.  The
//! measured runtime receives one already-claimed upkeep, normalizes the same
//! identifiers as `packages/shared/src/automation-supervisor.js`, and exposes
//! the nested request that must actually run.  There is deliberately no
//! "accepted" result here: the host either executes that request or returns a
//! concrete failure.

use serde_json::{json, Value as Json};

#[derive(Debug, Clone, PartialEq)]
pub struct AutomationExecution {
    pub workflow_id: String,
    pub workflow_version: u64,
    pub automation_id: String,
    pub execution_count: u64,
    pub next_execution_count: u64,
    pub execution_id: String,
    pub request_id: String,
    pub idempotency_key: String,
    pub replay_window: String,
    pub delivery_mode: String,
    pub execution_request_type: String,
    pub execution_payload: Json,
}

impl AutomationExecution {
    pub fn descriptor(&self) -> Json {
        json!({
            "workflow_id": self.workflow_id,
            "workflow_version": self.workflow_version,
            "automation_id": self.automation_id,
            "execution_count": self.execution_count,
            "next_execution_count": self.next_execution_count,
            "execution_id": self.execution_id,
            "request_id": self.request_id,
            "idempotency_key": self.idempotency_key,
            "replay_window": self.replay_window,
            "delivery_mode": self.delivery_mode,
            "execution_request_type": self.execution_request_type,
            "execution_payload": self.execution_payload,
        })
    }
}

/// Normalize a claimed upkeep and extract the nested execution request.
///
/// Identifier strings are intentionally strict: non-string JSON values are
/// treated as absent, matching the shared supervisor and preventing objects or
/// numbers from being string-coerced into cross-lane deduplication keys.
pub fn normalize_automation_execution(input: &Json) -> Result<AutomationExecution, String> {
    let fields = input
        .as_object()
        .ok_or_else(|| "automation execution payload must be a JSON object".to_string())?;
    let nested = fields.get("execution").and_then(Json::as_object);

    let automation_id = first_string(input, &["automation_id", "automationId"]);
    if automation_id.is_empty() {
        return Err("automation_id is required".to_string());
    }

    let workflow_id = nonempty_or(
        first_string(input, &["workflow_id", "workflowId"]),
        "automation.upkeep",
    );
    let workflow_version = positive_integer(
        first_value(input, &["workflow_version", "workflowVersion"]),
        1,
    );
    let execution_count = nonnegative_integer(
        first_value(input, &["execution_count", "executionCount"]),
        0,
    );
    let next_execution_count = execution_count
        .checked_add(1)
        .ok_or_else(|| "execution_count is too large".to_string())?;
    let chain = nonempty_or(first_string(input, &["chain"]), "unknown");
    let execution_id = nonempty_or(
        first_string(input, &["execution_id", "executionId"]),
        &format!("{workflow_id}:{automation_id}:{next_execution_count}"),
    );
    let request_id = nonempty_or(
        first_string(input, &["request_id", "requestId"]),
        &format!("automation:{chain}:{automation_id}:{next_execution_count}"),
    );
    let idempotency_key = nonempty_or(
        first_string(input, &["idempotency_key", "idempotencyKey"]),
        &format!("{workflow_id}:{automation_id}:{next_execution_count}"),
    );
    let replay_window = nonempty_or(
        first_string(input, &["replay_window", "replayWindow"]),
        "strict",
    );
    let delivery_mode = nonempty_or(
        first_string(input, &["delivery_mode", "deliveryMode"]),
        "onchain_callback",
    );

    let request_type = nested
        .map(|object| strict_string(object.get("request_type")))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| {
            first_string(input, &["execution_request_type", "executionRequestType"])
        });
    let execution_request_type = normalize_request_type(&request_type);
    if execution_request_type.is_empty() {
        return Err("execution.request_type is required".to_string());
    }
    if execution_request_type.contains("feed") {
        return Err("automation execution request_type cannot be datafeed".to_string());
    }
    if execution_request_type.starts_with("automation_") {
        return Err(
            "automation execution request_type cannot be an automation control type".to_string(),
        );
    }

    let payload_value = nested
        .and_then(|object| object.get("payload"))
        .or_else(|| fields.get("execution_payload"));
    let mut execution_payload = normalize_execution_payload(payload_value)?;
    let execution_fields = execution_payload
        .as_object_mut()
        .expect("normalizer returns an object");
    execution_fields.insert("automation_id".to_string(), json!(automation_id));
    execution_fields.insert("workflow_id".to_string(), json!(workflow_id));
    execution_fields.insert("workflow_version".to_string(), json!(workflow_version));
    execution_fields.insert("execution_id".to_string(), json!(execution_id));
    execution_fields.insert("idempotency_key".to_string(), json!(idempotency_key));
    execution_fields.insert("replay_window".to_string(), json!(replay_window));
    execution_fields.insert("delivery_mode".to_string(), json!(delivery_mode));

    Ok(AutomationExecution {
        workflow_id,
        workflow_version,
        automation_id,
        execution_count,
        next_execution_count,
        execution_id,
        request_id,
        idempotency_key,
        replay_window,
        delivery_mode,
        execution_request_type,
        execution_payload,
    })
}

fn normalize_execution_payload(value: Option<&Json>) -> Result<Json, String> {
    match value {
        Some(value @ Json::Object(_)) => Ok(value.clone()),
        Some(Json::String(raw)) => match serde_json::from_str::<Json>(raw) {
            Ok(value @ Json::Object(_)) => Ok(value),
            Ok(_) => Err("execution.payload must decode to a JSON object".to_string()),
            Err(_) => Ok(json!({ "raw_payload": raw })),
        },
        None => Err("execution.payload must be a JSON object or string".to_string()),
        _ => Err("execution.payload must be a JSON object or string".to_string()),
    }
}

fn normalize_request_type(value: &str) -> String {
    let mut normalized = String::with_capacity(value.len());
    let mut in_separator = false;
    for character in crate::js::js_trim(value).to_lowercase().chars() {
        if crate::js::is_js_whitespace(character) || character == '-' {
            if !in_separator {
                normalized.push('_');
                in_separator = true;
            }
        } else {
            normalized.push(character);
            in_separator = false;
        }
    }
    normalized
}

fn first_value<'a>(input: &'a Json, names: &[&str]) -> Option<&'a Json> {
    names.iter().find_map(|name| input.get(*name))
}

fn first_string(input: &Json, names: &[&str]) -> String {
    names
        .iter()
        .find_map(|name| {
            let value = strict_string(input.get(*name));
            (!value.is_empty()).then_some(value)
        })
        .unwrap_or_default()
}

fn strict_string(value: Option<&Json>) -> String {
    value
        .and_then(Json::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_string()
}

fn nonempty_or(value: String, fallback: &str) -> String {
    if value.is_empty() {
        fallback.to_string()
    } else {
        value
    }
}

fn finite_number(value: Option<&Json>) -> Option<f64> {
    match value? {
        Json::Number(number) => number.as_f64(),
        Json::String(text) => text.trim().parse::<f64>().ok(),
        Json::Bool(true) => Some(1.0),
        Json::Bool(false) | Json::Null => Some(0.0),
        Json::Array(_) | Json::Object(_) => None,
    }
    .filter(|value| value.is_finite())
}

fn nonnegative_integer(value: Option<&Json>, fallback: u64) -> u64 {
    finite_number(value)
        .filter(|value| *value >= 0.0)
        .map(|value| value.trunc().min(u64::MAX as f64) as u64)
        .unwrap_or(fallback)
}

fn positive_integer(value: Option<&Json>, fallback: u64) -> u64 {
    finite_number(value)
        .filter(|value| *value > 0.0)
        .map(|value| value.trunc().max(1.0).min(u64::MAX as f64) as u64)
        .unwrap_or(fallback)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_the_shared_upkeep_contract() {
        let execution = normalize_automation_execution(&json!({
            "automation_id": " job-1 ",
            "chain": "neo_n3",
            "execution_count": "4.9",
            "execution": {
                "request_type": " Compute-Hash ",
                "payload": { "input": 7 },
            },
        }))
        .expect("valid upkeep");
        assert_eq!(execution.workflow_id, "automation.upkeep");
        assert_eq!(execution.execution_count, 4);
        assert_eq!(execution.next_execution_count, 5);
        assert_eq!(execution.request_id, "automation:neo_n3:job-1:5");
        assert_eq!(execution.idempotency_key, "automation.upkeep:job-1:5");
        assert_eq!(execution.execution_request_type, "compute_hash");
        assert_eq!(execution.execution_payload["input"], 7);
        assert_eq!(execution.execution_payload["automation_id"], "job-1");
    }

    #[test]
    fn strict_identifiers_and_recursion_fail_closed() {
        assert_eq!(
            normalize_automation_execution(&json!({
                "automation_id": 7,
                "execution_request_type": "compute_hash",
                "execution_payload": {},
            }))
            .expect_err("number is not a strict id"),
            "automation_id is required"
        );
        for request_type in ["automation_cancel", "price_feed"] {
            assert!(normalize_automation_execution(&json!({
                "automation_id": "job",
                "execution_request_type": request_type,
                "execution_payload": {},
            }))
            .is_err());
        }
    }

    #[test]
    fn raw_string_payloads_match_the_registration_parser() {
        let parsed = normalize_automation_execution(&json!({
            "automation_id": "job",
            "execution_request_type": "privacy_oracle",
            "execution_payload": "not-json",
        }))
        .expect("raw payload");
        assert_eq!(parsed.execution_payload["raw_payload"], "not-json");
        assert_eq!(parsed.execution_payload["automation_id"], "job");
    }
}
