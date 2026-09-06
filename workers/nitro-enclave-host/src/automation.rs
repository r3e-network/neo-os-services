//! `/automation/execute` — execute one already-claimed upkeep in-process.
//!
//! The scheduler/database claim remains outside the enclave.  This adapter
//! validates the shared upkeep contract, dispatches the nested request to the
//! same Rust handler used by its direct route, and retains a bounded
//! process-local completion record so immediate retries cannot execute twice.
//! The durable cross-process guard remains the on-chain `request_id` and the
//! control-plane claim; this cache is an additional measured-runtime guard,
//! not a replacement for either one.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use neo_os_compute::automation::{normalize_automation_execution, AutomationExecution};
use neo_os_core::js_value::JsValue;
use neo_os_core::kernel::resolve_kernel_intent;
use neo_os_core::sha256_hex;
use neo_os_core::stable_stringify::stable_stringify;
use serde_json::{json, Value as Json};

use crate::state::AppState;
use crate::{http_error, DispatchOutcome, RuntimeError};

const MAX_EXECUTIONS: usize = 4_096;
const COMPLETE_TTL_MS: u64 = 24 * 60 * 60 * 1_000;
const RUNNING_TTL_MS: u64 = 5 * 60 * 1_000;

static EXECUTIONS: OnceLock<Mutex<ExecutionStore>> = OnceLock::new();

#[derive(Clone)]
enum ExecutionState {
    Running,
    Complete(DispatchOutcome),
}

#[derive(Clone)]
struct ExecutionRecord {
    digest: String,
    updated_at_ms: u64,
    generation: u64,
    state: ExecutionState,
}

#[derive(Default)]
struct ExecutionStore {
    generation: u64,
    records: HashMap<String, ExecutionRecord>,
}

pub fn handle_automation_execute(
    state: &AppState,
    payload: &Json,
) -> Result<DispatchOutcome, RuntimeError> {
    let execution =
        normalize_automation_execution(payload).map_err(|message| http_error(400, message))?;
    let descriptor = execution.descriptor();
    let digest = sha256_hex(stable_stringify(&JsValue::from_json(&descriptor)).as_bytes());
    let now_ms = state.oracle_io.now_ms();

    if let Some(replay) = claim_execution(&execution.idempotency_key, &digest, now_ms)? {
        return Ok(replay);
    }

    let outcome = run_nested(state, &execution);
    finish_execution(&execution.idempotency_key, &digest, now_ms, &outcome)?;
    Ok(outcome)
}

fn claim_execution(
    key: &str,
    digest: &str,
    now_ms: u64,
) -> Result<Option<DispatchOutcome>, RuntimeError> {
    let mut store = execution_store()?;
    store.prune(now_ms);
    if let Some(record) = store.records.get(key) {
        if record.digest != digest {
            return Err(http_error(
                409,
                "idempotency_key was already used for a different automation execution",
            ));
        }
        return match &record.state {
            ExecutionState::Complete(outcome) => Ok(Some(outcome.clone())),
            ExecutionState::Running => Err(http_error(
                409,
                "automation execution with this idempotency_key is already running",
            )),
        };
    }
    store.ensure_capacity()?;
    store.generation = store.generation.saturating_add(1);
    let generation = store.generation;
    store.records.insert(
        key.to_string(),
        ExecutionRecord {
            digest: digest.to_string(),
            updated_at_ms: now_ms,
            generation,
            state: ExecutionState::Running,
        },
    );
    Ok(None)
}

fn finish_execution(
    key: &str,
    digest: &str,
    now_ms: u64,
    outcome: &DispatchOutcome,
) -> Result<(), RuntimeError> {
    let mut store = execution_store()?;
    let transient = matches!(outcome.status, 408 | 425 | 429) || outcome.status >= 500;
    if transient {
        store.records.remove(key);
        return Ok(());
    }
    store.generation = store.generation.saturating_add(1);
    let generation = store.generation;
    store.records.insert(
        key.to_string(),
        ExecutionRecord {
            digest: digest.to_string(),
            updated_at_ms: now_ms,
            generation,
            state: ExecutionState::Complete(outcome.clone()),
        },
    );
    Ok(())
}

fn run_nested(state: &AppState, execution: &AutomationExecution) -> DispatchOutcome {
    let intent = resolve_kernel_intent(&execution.execution_request_type);
    let result = match intent.worker_route {
        "/compute/execute" => value_outcome(crate::compute_execute::handle_compute_execute(
            state,
            &execution.execution_payload,
        )),
        "/oracle/query" => {
            crate::oracle_read::handle_oracle_query(state, &execution.execution_payload)
        }
        "/oracle/smart-fetch" => {
            crate::oracle_read::handle_oracle_smart_fetch(state, &execution.execution_payload)
        }
        "/oracle/decrypt" => {
            crate::oracle_read::handle_oracle_decrypt(state, &execution.execution_payload)
        }
        "/oracle/message-reveal" => {
            crate::oracle_read::handle_oracle_message_reveal(state, &execution.execution_payload)
        }
        "/neodid/bind" => value_outcome(crate::neodid::handle_neo_did_bind(
            state,
            &execution.execution_payload,
        )),
        "/neodid/action-ticket" => value_outcome(crate::neodid::handle_neo_did_action_ticket(
            state,
            &execution.execution_payload,
        )),
        "/neodid/recovery-ticket" => value_outcome(crate::neodid::handle_neo_did_recovery_ticket(
            state,
            &execution.execution_payload,
        )),
        "/neodid/zklogin-ticket" => value_outcome(crate::neodid::handle_neo_did_zklogin_ticket(
            state,
            &execution.execution_payload,
        )),
        "/vrf/random" => value_outcome(crate::vrf::handle_vrf_random(
            state,
            &execution.execution_payload,
        )),
        "/paymaster/authorize" => value_outcome(crate::paymaster::handle_paymaster_authorize(
            state,
            &execution.execution_payload,
        )),
        "/session/step" => crate::session::handle_session_step(state, &execution.execution_payload),
        "/session/finalize" => {
            crate::session::handle_session_finalize(state, &execution.execution_payload)
        }
        route => Err(http_error(
            400,
            format!("automation execution route is not supported: {route}"),
        )),
    };
    let inner = match result {
        Ok(outcome) => outcome,
        Err(error) => DispatchOutcome::error(&error),
    };
    let success = (200..300).contains(&inner.status);
    let mut body = json!({
        "mode": "automation",
        "action": "execute",
        "status": if success { "completed" } else { "failed" },
        "success": success,
        "automation_id": execution.automation_id,
        "workflow_id": execution.workflow_id,
        "workflow_version": execution.workflow_version,
        "execution_id": execution.execution_id,
        "request_id": execution.request_id,
        "idempotency_key": execution.idempotency_key,
        "execution_request_type": execution.execution_request_type,
        "worker_route": intent.worker_route,
        "result": inner.body,
    });
    if !success {
        body["error"] = Json::String(error_message(&body["result"], inner.status));
    }
    DispatchOutcome {
        status: inner.status,
        body,
    }
}

fn value_outcome(value: Result<Json, RuntimeError>) -> Result<DispatchOutcome, RuntimeError> {
    value.map(DispatchOutcome::ok)
}

fn error_message(body: &Json, status: u16) -> String {
    ["error", "message", "code"]
        .iter()
        .find_map(|key| body.get(*key).and_then(Json::as_str))
        .map(str::trim)
        .filter(|message| !message.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("nested execution failed with HTTP {status}"))
}

fn execution_store() -> Result<std::sync::MutexGuard<'static, ExecutionStore>, RuntimeError> {
    EXECUTIONS
        .get_or_init(|| Mutex::new(ExecutionStore::default()))
        .lock()
        .map_err(|_| http_error(500, "automation execution state unavailable"))
}

impl ExecutionStore {
    fn prune(&mut self, now_ms: u64) {
        self.records.retain(|_, record| {
            let ttl = match record.state {
                ExecutionState::Running => RUNNING_TTL_MS,
                ExecutionState::Complete(_) => COMPLETE_TTL_MS,
            };
            now_ms.saturating_sub(record.updated_at_ms) <= ttl
        });
    }

    fn ensure_capacity(&mut self) -> Result<(), RuntimeError> {
        if self.records.len() < MAX_EXECUTIONS {
            return Ok(());
        }
        let oldest_complete = self
            .records
            .iter()
            .filter(|(_, record)| matches!(record.state, ExecutionState::Complete(_)))
            .min_by_key(|(_, record)| record.generation)
            .map(|(key, _)| key.clone());
        if let Some(key) = oldest_complete {
            self.records.remove(&key);
            Ok(())
        } else {
            Err(http_error(
                503,
                "automation execution capacity is temporarily exhausted",
            ))
        }
    }
}

#[cfg(test)]
fn reset_executions_for_tests() {
    if let Some(store) = EXECUTIONS.get() {
        store.lock().expect("automation test lock").records.clear();
    }
}

#[cfg(test)]
#[path = "../tests/unit/automation.rs"]
mod tests;
