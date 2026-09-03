//! Kernel intent resolution + worker payload assembly (port of the
//! intent/payload half of workers/morpheus-relayer/src/router.js).
//!
//! `normalize_request_type` is consensus-adjacent: it selects the worker
//! route, derives the moduleId/operation feeding the fulfillment digest and
//! gates the operator-only lane, so divergent copies could route a request to
//! a different worker than the one it signs a digest for.

use crate::js_value::{JsObject, JsValue};

#[derive(Debug, Clone, PartialEq)]
pub struct KernelIntent {
    pub legacy_request_type: String,
    pub module_id: &'static str,
    pub operation: String,
    pub worker_route: &'static str,
    pub operator_only: bool,
}

/// Canonical request-type normalization (port of lib/strings.js
/// `normalizeRequestType`): strict trim, lowercase, then `[\s-]+` → `_`.
pub fn normalize_request_type(value: &str) -> String {
    let trimmed = crate::js_value::js_trim(value);
    let lowered = trimmed.to_lowercase();
    let mut out = String::with_capacity(lowered.len());
    let mut in_run = false;
    for c in lowered.chars() {
        if crate::js_value::is_js_whitespace(c) || c == '-' {
            if !in_run {
                out.push('_');
                in_run = true;
            }
        } else {
            out.push(c);
            in_run = false;
        }
    }
    out
}

/// Resolve the kernel intent for a legacy request type. Branch ORDER is the
/// contract (e.g. anything containing 'feed' wins over the rng/random check).
pub fn resolve_kernel_intent(request_type: &str) -> KernelIntent {
    let normalized = normalize_request_type(request_type);
    let empty_fallback = |module_id: &'static str,
                          default_operation: &'static str,
                          worker_route: &'static str,
                          operator_only: bool| {
        let operation = if normalized.is_empty() {
            default_operation.to_string()
        } else {
            normalized.clone()
        };
        KernelIntent {
            legacy_request_type: normalized.clone(),
            module_id,
            operation,
            worker_route,
            operator_only,
        }
    };

    if normalized.starts_with("session.") || normalized.starts_with("session_") {
        let is_finalize = normalized.contains("finalize");
        return KernelIntent {
            legacy_request_type: normalized.clone(),
            module_id: "game.session",
            operation: normalized,
            worker_route: if is_finalize {
                "/session/finalize"
            } else {
                "/session/step"
            },
            operator_only: false,
        };
    }

    if normalized.contains("paymaster") {
        return empty_fallback(
            "paymaster.authorize",
            "authorize",
            "/paymaster/authorize",
            false,
        );
    }

    if normalized.contains("compute") {
        return empty_fallback("compute.run", "compute", "/compute/execute", false);
    }

    if normalized.contains("feed") {
        return empty_fallback("feed.publish", "feed", "/oracle/feed", true);
    }

    if normalized == "rng" || normalized.contains("vrf") || normalized.contains("random") {
        return empty_fallback("random.generate", "random", "/vrf/random", false);
    }

    if normalized == "decrypt" || normalized.contains("decrypt") || normalized.contains("reveal") {
        return empty_fallback("confidential.decrypt", "decrypt", "/oracle/decrypt", false);
    }

    if normalized.starts_with("neodid") {
        let worker_route = if normalized.contains("zklogin") {
            "/neodid/zklogin-ticket"
        } else if normalized.contains("recovery") {
            "/neodid/recovery-ticket"
        } else if normalized.contains("action") {
            "/neodid/action-ticket"
        } else {
            "/neodid/bind"
        };
        let operation = if worker_route == "/neodid/bind" && normalized.is_empty() {
            "neodid_bind".to_string()
        } else {
            normalized.clone()
        };
        return KernelIntent {
            legacy_request_type: normalized,
            module_id: "identity.verify",
            operation,
            worker_route,
            operator_only: false,
        };
    }

    if normalized.starts_with("automation_") {
        return KernelIntent {
            legacy_request_type: normalized.clone(),
            module_id: "automation.run",
            operation: normalized,
            worker_route: "/automation/execute",
            operator_only: false,
        };
    }

    empty_fallback(
        "oracle.fetch",
        "privacy_oracle",
        "/oracle/smart-fetch",
        false,
    )
}

pub fn is_operator_only_request_type(request_type: &str) -> bool {
    resolve_kernel_intent(request_type).operator_only
}

/// `JSON.parse` the raw payload text, falling back to `{ raw_payload: text }`
/// (port of `decodePayloadText`).
pub fn decode_payload_text(raw_payload: &str) -> JsValue {
    let text = crate::js_value::js_trim(raw_payload);
    if text.is_empty() {
        return JsValue::Object(JsObject::new());
    }
    match serde_json::from_str::<serde_json::Value>(text) {
        Ok(parsed) => JsValue::from_json(&parsed),
        Err(_) => {
            let mut obj = JsObject::new();
            obj.set("raw_payload", JsValue::Str(text.to_string()));
            JsValue::Object(obj)
        }
    }
}

/// Build the worker payload (port of `buildWorkerPayload`). The JS spread
/// `{...payload, ...overrides}` keeps an existing key's position on override —
/// `JsObject::set` mirrors that.
pub fn build_worker_payload(
    chain: &str,
    request_type: &str,
    payload: &JsValue,
    request_id: &JsValue,
    context: &JsValue,
) -> JsObject {
    let intent = resolve_kernel_intent(request_type);
    let mut out = JsObject::new();
    if let JsValue::Object(obj) = payload {
        for (key, value) in obj.iter() {
            out.set(key.to_string(), value.clone());
        }
    }

    let request_id_text = request_id.to_string_js().unwrap_or_default();
    out.set("request_id", JsValue::Str(request_id_text));
    out.set(
        "request_source",
        JsValue::Str(format!("morpheus-relayer:{chain}")),
    );
    let target_chain = payload
        .as_object()
        .and_then(|obj| obj.get("target_chain"))
        .filter(|v| v.truthy())
        .cloned()
        .unwrap_or_else(|| JsValue::Str(chain.to_string()));
    out.set("target_chain", target_chain);
    out.set(
        "legacy_request_type",
        JsValue::Str(intent.legacy_request_type),
    );
    out.set(
        "kernel_module_id",
        JsValue::Str(intent.module_id.to_string()),
    );
    out.set("kernel_operation", JsValue::Str(intent.operation));
    let pick = |key: &str, context_key: &str| -> JsValue {
        let context_value = context
            .as_object()
            .and_then(|obj| obj.get(context_key))
            .filter(|v| v.truthy())
            .cloned();
        let payload_value = payload
            .as_object()
            .and_then(|obj| obj.get(key))
            .filter(|v| v.truthy())
            .cloned();
        context_value
            .or(payload_value)
            .unwrap_or_else(|| JsValue::Str(String::new()))
    };
    out.set("requester", pick("requester", "requester"));
    out.set(
        "callback_contract",
        pick("callback_contract", "callbackContract"),
    );
    out.set("callback_method", pick("callback_method", "callbackMethod"));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalization_matches_js() {
        assert_eq!(normalize_request_type(" Oracle-Query "), "oracle_query");
        assert_eq!(
            normalize_request_type("neodid  recovery\tticket"),
            "neodid_recovery_ticket"
        );
        assert_eq!(normalize_request_type("a--b  c"), "a_b_c");
    }

    #[test]
    fn intent_branch_order() {
        assert_eq!(
            resolve_kernel_intent("feed/publish").module_id,
            "feed.publish"
        );
        assert!(resolve_kernel_intent("feed/publish").operator_only);
        assert_eq!(
            resolve_kernel_intent("neodid_recovery_ticket").worker_route,
            "/neodid/recovery-ticket"
        );
        assert_eq!(
            resolve_kernel_intent("session.finalize").worker_route,
            "/session/finalize"
        );
        assert_eq!(
            resolve_kernel_intent("game/finalize").worker_route,
            "/oracle/smart-fetch"
        );
    }
}
