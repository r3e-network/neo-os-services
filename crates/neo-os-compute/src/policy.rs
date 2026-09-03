//! `evaluatePolicyDecision` — the port of `platform/policy-engine.js`.
//!
//! The JS reads a dynamic payload with `||` and `??` chains, and the two are
//! NOT the same: `||` skips every falsy value (empty string, 0) and then
//! trims, while `??` only skips `undefined`/`null` (absent or JSON null). The
//! port keeps both (`js_first_truthy` for `||`, `nullish` for `??`) because a
//! payload like `{workflow_id: '', workflowId: 'real'}` resolves differently
//! depending on which operator the original used. Note also that every
//! `trimString` in the JS is `String(value || '').trim()` — falsy values
//! (0, false, null) collapse to `''` before any trim, so `scope: 0` yields
//! the `'workflow'` fallback, not `"0"`.
//!
//! Accepts and returns `serde_json::Value` so callers can pass raw request
//! payloads and render the decision without a second mapping layer. The
//! output object's key order mirrors the JS literal (`workflow_id`, `allow`,
//! `decision`, `reason`, `httpStatus`, `scope`, `scope_id`,
//! `require_attestation`, `metadata`).
//!
//! `buildPolicyDecision` in the JS also accepts overrides for `httpStatus`,
//! `require_attestation` and `metadata`, but NO internal call site passes
//! them (every branch passes only decision/reason/scope/scope_id) — the port
//! implements the observable contract and says so, rather than threading dead
//! parameters through.

use serde_json::{json, Map, Value as Json};

use crate::js::{js_first_truthy, js_stringify, js_trim, js_trim_string};

/// `input.a ?? input.b` — absent or JSON-null falls through; `false`/`0`/`''`
/// do NOT.
fn nullish<'a>(input: &'a Json, keys: &[&str]) -> Option<&'a Json> {
    let Json::Object(map) = input else {
        return None;
    };
    keys.iter()
        .filter_map(|key| map.get(*key))
        .find(|value| !value.is_null())
}

/// `readBoolean(value, fallback)` (policy-engine.js:9-16): booleans pass
/// through; everything else is String()-coerced, trimmed, lowercased and
/// matched against the word lists. The fallback is `null` at the call sites
/// that use one — hence `Option<bool>`.
fn read_boolean(value: Option<&Json>, fallback: Option<bool>) -> Option<bool> {
    let Some(value) = value else {
        return fallback;
    };
    if value.is_null() {
        return fallback;
    }
    if let Json::Bool(b) = value {
        return Some(*b);
    }
    match js_stringify(value)
        .trim_matches(crate::js::is_js_whitespace)
        .to_lowercase()
        .as_str()
    {
        "1" | "true" | "yes" | "on" | "enabled" => Some(true),
        "0" | "false" | "no" | "off" | "disabled" => Some(false),
        _ => fallback,
    }
}

/// `normalizeDecision(value, fallback)`: one of `deny`/`review`/`allow` after
/// trim+lowercase, else the fallback.
fn normalize_decision(value: Option<&Json>, fallback: &str) -> String {
    let normalized = js_trim_string(value).to_lowercase();
    match normalized.as_str() {
        "deny" | "review" | "allow" => normalized,
        _ => fallback.to_string(),
    }
}

/// The trimmed `||`-chain: the JS resolves the first TRUTHY raw value and
/// trims THAT — truthiness is tested before any trim, so `{a: '  ', b: 'x'}`
/// resolves to `''`, never to `'x'`.
fn truthy_string(input: &Json, keys: &[&str]) -> String {
    match js_first_truthy(input, keys) {
        Some(value) => js_trim(&js_stringify(value)).to_string(),
        None => String::new(),
    }
}

/// `trimString(input[key]) || ''` — a direct read with no truthy chain, but
/// trimString itself collapses falsy values to `''` first.
fn direct_string(input: &Json, key: &str) -> String {
    js_trim_string(input.get(key))
}

fn string_or_null(value: &str) -> Json {
    if value.is_empty() {
        Json::Null
    } else {
        Json::String(value.to_string())
    }
}

/// One decision branch's overrides — every JS call site passes at most
/// decision + reason + scope + scope_id. The explicit branch's decision and
/// reason are runtime strings, hence the borrowed lifetime.
struct Overrides<'a> {
    decision: &'a str,
    reason: &'a str,
    scope: Option<&'a str>,
    scope_id: Option<String>,
}

#[allow(clippy::too_many_arguments)]
fn build_policy_decision(
    workflow_id: &str,
    base_scope: &str,
    base_scope_id: &str,
    require_attestation: bool,
    provider_enabled: Option<bool>,
    attestation_available: bool,
    overrides: Overrides<'_>,
) -> Json {
    let decision = normalize_decision(Some(&Json::String(overrides.decision.to_string())), "allow");
    let allow = decision == "allow";
    let http_status = match decision.as_str() {
        "allow" => 200,
        "review" => 409,
        _ => 403,
    };
    // `trimString(overrides.scope) || base.scope || null` — base.scope is
    // always a non-empty literal in the JS, so only the override can be empty.
    let scope = overrides
        .scope
        .filter(|s| !s.is_empty())
        .unwrap_or(base_scope);
    // `trimString(overrides.scope_id || overrides.scopeId) || base.scope_id || null`
    let scope_id = match overrides.scope_id {
        Some(id) if !id.is_empty() => Json::String(id),
        _ => string_or_null(base_scope_id),
    };

    let mut metadata = Map::new();
    metadata.insert(
        "provider_enabled".to_string(),
        match provider_enabled {
            Some(true) => json!(true),
            Some(false) => json!(false),
            None => Json::Null,
        },
    );
    metadata.insert(
        "attestation_available".to_string(),
        json!(attestation_available),
    );

    json!({
        "workflow_id": string_or_null(workflow_id),
        "allow": allow,
        "decision": decision,
        "reason": overrides.reason,
        "httpStatus": http_status,
        "scope": scope,
        "scope_id": scope_id,
        "require_attestation": require_attestation,
        "metadata": metadata,
    })
}

pub fn evaluate_policy_decision(input: &Json) -> Json {
    let workflow_id = truthy_string(input, &["workflow_id", "workflowId"]);
    let provider_id = truthy_string(
        input,
        &[
            "provider",
            "provider_id",
            "providerId",
            "scope_id",
            "scopeId",
        ],
    );
    let require_attestation = read_boolean(
        nullish(input, &["require_attestation", "requireAttestation"]),
        Some(false),
    ) == Some(true);
    let attestation_available = read_boolean(
        nullish(input, &["attestation_available", "attestationAvailable"]),
        Some(true),
    ) == Some(true);
    let risk_action =
        truthy_string(input, &["risk_action", "paused_action", "action"]).to_lowercase();
    let scope_paused = read_boolean(
        nullish(input, &["scope_paused", "scopePaused"]),
        Some(false),
    ) == Some(true)
        || risk_action == "pause_scope"
        || risk_action == "deny";

    let base_scope = if !provider_id.is_empty() {
        "provider".to_string()
    } else {
        let scope = direct_string(input, "scope");
        if scope.is_empty() {
            "workflow".to_string()
        } else {
            scope
        }
    };
    let base_scope_id = if !provider_id.is_empty() {
        provider_id.clone()
    } else {
        truthy_string(input, &["scope_id", "scopeId", "workflow_id", "workflowId"])
    };
    let provider_enabled = read_boolean(
        nullish(input, &["provider_enabled", "providerEnabled"]),
        None,
    );

    // Explicit deny/review: `allow: false` forces the deny branch even when
    // `decision` is absent, and a parsed 'allow' decision combined with
    // `allow: false` still lands as deny (the JS's odd ternary).
    let explicit_allow = read_boolean(input.get("allow"), None);
    let explicit_decision = normalize_decision(
        input.get("decision"),
        if explicit_allow == Some(false) {
            "deny"
        } else {
            "allow"
        },
    );
    let explicit_reason = direct_string(input, "reason");
    if explicit_allow == Some(false) || explicit_decision == "deny" || explicit_decision == "review"
    {
        // `explicitDecision === 'allow' ? 'deny' : explicitDecision` — the
        // only way to enter with 'allow' in hand is `allow: false`.
        let decision = if explicit_decision == "allow" {
            "deny"
        } else {
            explicit_decision.as_str()
        };
        let reason = if !explicit_reason.is_empty() {
            explicit_reason.as_str()
        } else if explicit_decision == "review" {
            "review_required"
        } else {
            "policy_denied"
        };
        return build_policy_decision(
            &workflow_id,
            &base_scope,
            &base_scope_id,
            require_attestation,
            provider_enabled,
            attestation_available,
            Overrides {
                decision,
                reason,
                scope: None,
                scope_id: None,
            },
        );
    }

    if provider_enabled == Some(false) {
        return build_policy_decision(
            &workflow_id,
            &base_scope,
            &base_scope_id,
            require_attestation,
            provider_enabled,
            attestation_available,
            Overrides {
                decision: "deny",
                reason: "provider_disabled",
                scope: Some("provider"),
                scope_id: Some(provider_id.clone()),
            },
        );
    }

    if scope_paused {
        return build_policy_decision(
            &workflow_id,
            &base_scope,
            &base_scope_id,
            require_attestation,
            provider_enabled,
            attestation_available,
            Overrides {
                decision: "deny",
                reason: "scope_paused",
                scope: None,
                scope_id: None,
            },
        );
    }

    if require_attestation && !attestation_available {
        return build_policy_decision(
            &workflow_id,
            &base_scope,
            &base_scope_id,
            require_attestation,
            provider_enabled,
            attestation_available,
            Overrides {
                decision: "review",
                reason: "attestation_required",
                scope: None,
                scope_id: None,
            },
        );
    }

    let human_approval = read_boolean(
        nullish(input, &["require_human_approval", "requireHumanApproval"]),
        Some(false),
    ) == Some(true);
    if human_approval {
        return build_policy_decision(
            &workflow_id,
            &base_scope,
            &base_scope_id,
            require_attestation,
            provider_enabled,
            attestation_available,
            Overrides {
                decision: "review",
                reason: "human_approval_required",
                scope: None,
                scope_id: None,
            },
        );
    }

    build_policy_decision(
        &workflow_id,
        &base_scope,
        &base_scope_id,
        require_attestation,
        provider_enabled,
        attestation_available,
        Overrides {
            decision: "allow",
            reason: "allowed",
            scope: None,
            scope_id: None,
        },
    )
}
