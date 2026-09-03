mod common;

use common::{canonical, load_family};
use neo_os_core::js_value::{JsObject, JsValue};
use neo_os_core::state::{
    build_event_key, collect_active_request_ids, create_empty_relayer_state,
    enqueue_retry_item, enforce_retry_queue_limit, get_due_retry_items,
    increment_labeled_failure, record_processed_event, schedule_retry, snapshot_metrics,
};

fn event_value(op: &serde_json::Value) -> JsValue {
    // An op whose `event` was JS `undefined` serializes with the key absent;
    // JSON null decodes to JsValue::Null, which build_event_key treats the
    // same (no object -> all fallbacks).
    JsValue::from_json(&op["event"])
}

fn object_field(op: &serde_json::Value, key: &str) -> JsObject {
    match JsValue::from_json(&op[key]) {
        JsValue::Object(obj) => obj,
        JsValue::Null | JsValue::Undefined => JsObject::new(),
        other => panic!("op field {key} is not an object: {other:?}"),
    }
}

#[test]
fn state_machine_ops_match_js_oracle() {
    for case in load_family("state_prune") {
        let name = case["name"].as_str().unwrap_or("?").to_string();
        let mut state = create_empty_relayer_state();
        let ops = case["ops"].as_array().expect("ops");
        let expected_returns = case["expected_returns"].as_array().expect("expected_returns");
        assert_eq!(
            ops.len(),
            expected_returns.len(),
            "case {name} op/return arity"
        );

        for (op, want) in ops.iter().zip(expected_returns.iter()) {
            let kind = op["op"].as_str().expect("op kind").to_string();
            let chain = op
                .get("chain")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let now_ms = op.get("now_ms").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let actual: JsValue = match kind.as_str() {
                "build_key" => JsValue::Str(build_event_key(&event_value(op))),
                "enqueue_retry" => {
                    let options = object_field(op, "options");
                    enqueue_retry_item(
                        &mut state,
                        &chain,
                        &event_value(op),
                        &options,
                        now_ms,
                    )
                }
                "enforce_limit" => {
                    let limits = object_field(op, "limits");
                    JsValue::Number(enforce_retry_queue_limit(
                        &mut state,
                        &chain,
                        &limits,
                        now_ms,
                    ))
                }
                "record_processed" => {
                    let meta = object_field(op, "meta");
                    let limits = object_field(op, "limits");
                    let status = op["status"].as_str().expect("status").to_string();
                    record_processed_event(
                        &mut state,
                        &chain,
                        &event_value(op),
                        &status,
                        &meta,
                        &limits,
                        now_ms,
                    )
                }
                "schedule_retry" => {
                    let config = object_field(op, "config");
                    let error = op
                        .get("error")
                        .and_then(|v| v.as_str())
                        .unwrap_or("boom")
                        .to_string();
                    let rng = op.get("rng").and_then(|v| v.as_f64()).unwrap_or(0.0);
                    schedule_retry(
                        &mut state,
                        &chain,
                        &event_value(op),
                        &error,
                        &config,
                        rng,
                        now_ms,
                    )
                }
                "due_items" => JsValue::Array(get_due_retry_items(&state, &chain, now_ms)),
                "collect_active" => JsValue::Array(
                    collect_active_request_ids(&state, &chain)
                        .into_iter()
                        .map(JsValue::Str)
                        .collect(),
                ),
                "increment_labeled" => {
                    let module = op["module"].as_str().expect("module").to_string();
                    let operation = op["operation"].as_str().expect("operation").to_string();
                    let delta = op.get("delta").and_then(|v| v.as_f64()).unwrap_or(1.0);
                    increment_labeled_failure(&mut state, &chain, &module, &operation, delta);
                    JsValue::Undefined
                }
                "snapshot" => JsValue::Object(snapshot_metrics(&state, now_ms)),
                other => panic!("case {name}: unknown state op {other}"),
            };
            assert_eq!(
                canonical(&actual),
                canonical(&JsValue::from_tagged(want)),
                "case {name} op {kind}"
            );
        }

        assert_eq!(
            canonical(&JsValue::Object(state)),
            canonical(&JsValue::from_tagged(&case["expected_state"])),
            "case {name} final state"
        );
    }
}
