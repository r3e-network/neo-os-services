//! `executeStandaloneCompute` (compute/index.js:749) — the standalone script
//! and wasm lanes that ride on `resolveScriptSource` /
//! `validateUserScriptSource` / `runScriptWithTimeout` / `runWasmWithTimeout`.
//!
//! The wasm branch is fail-closed: the checks that can fail run in the JS
//! order (opt-in gate, decoded module size, input size), then execution
//! refuses — the offline enclave build has no wasm runtime linked
//! (wasmtime/wasmi are not in the vendored dependency set), and the JS
//! child's `wasm-child.cjs` ABI has no other producer. The entry-point and
//! timeout derivations cannot fail, so dropping them loses no error-ordering
//! parity. The refusal message says what is missing instead of silently
//! mis-executing.
//!
//! `handleComputeExecute`'s envelope composition (`buildSignedResultEnvelope`)
//! and the confidential-payload pre-resolution land with the Phase 6 chain
//! wiring, exactly like the builtin lane's wiring note in [`crate::compute`].

use serde_json::{json, Map, Value as Json};

use crate::core::{
    capped_duration_ms, decode_base64, enforce_serialized_size_limit, read_env, resolve_max_bytes,
    EnvReader,
};
use crate::js::{js_first_truthy, js_trim, js_trim_string};
use crate::script::{
    assert_untrusted_scripts_enabled, resolve_script_source, run_script_with_timeout,
    validate_user_script_source, ScriptMode, ScriptRun, NO_SCRIPT_MESSAGE,
};

pub const COMPUTE_MAX_INPUT_BYTES_VAR: &str = "COMPUTE_MAX_INPUT_BYTES";
pub const COMPUTE_SCRIPT_TIMEOUT_MS_VAR: &str = "COMPUTE_SCRIPT_TIMEOUT_MS";

const DEFAULT_COMPUTE_MAX_INPUT_BYTES: u64 = 64 * 1024;
const MIN_COMPUTE_MAX_INPUT_BYTES: u64 = 1024;

/// `DEFAULT_MAX_WASM_MODULE_BYTES` (platform/core.js) — the decoded size cap
/// for a user-supplied module. No env override exists in the JS lane.
pub const DEFAULT_MAX_WASM_MODULE_BYTES: u64 = 4 * 1024 * 1024;

pub const WASM_DEFERRED_MESSAGE: &str =
    "wasm execution is not served by the Rust enclave host yet; no wasm runtime is linked";

/// `resolveWasmModuleBase64` (platform/core.js) — the first string-valued,
/// non-whitespace module field, trimmed.
pub fn resolve_wasm_module_base64(payload: &Json) -> String {
    for key in ["wasm_base64", "wasm_module_base64", "module_base64"] {
        if let Some(Json::String(value)) = payload.get(key) {
            let trimmed = js_trim(value);
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
    }
    String::new()
}

/// `assertWasmModuleSizeAllowed` (platform/core.js) — bound the DECODED size
/// before any instantiation attempt.
pub fn assert_wasm_module_size_allowed(module_base64: &str) -> Result<(), String> {
    if module_base64.is_empty() {
        return Ok(());
    }
    let decoded = decode_base64(module_base64);
    if decoded.len() as u64 > DEFAULT_MAX_WASM_MODULE_BYTES {
        return Err(format!(
            "wasm module exceeds max size of {DEFAULT_MAX_WASM_MODULE_BYTES} bytes"
        ));
    }
    Ok(())
}

/// `trimString(payload.a || payload.b || 'fallback') || 'fallback'` — JS
/// truthiness runs on the raw values, then one trim, then the final
/// `|| fallback` on the trimmed result.
fn first_truthy_trimmed_or(payload: &Json, keys: &[&str], fallback: &str) -> String {
    let chosen = js_trim_string(js_first_truthy(payload, keys));
    if chosen.is_empty() {
        fallback.to_string()
    } else {
        chosen
    }
}

fn compute_input(payload: &Json, env: EnvReader<'_>) -> Result<Json, String> {
    let max_input_bytes = resolve_max_bytes(
        env(COMPUTE_MAX_INPUT_BYTES_VAR).map(Json::String).as_ref(),
        DEFAULT_COMPUTE_MAX_INPUT_BYTES,
        MIN_COMPUTE_MAX_INPUT_BYTES,
    );
    let empty_input = Json::Object(Map::new());
    let input = match payload.get("input") {
        None | Some(Json::Null) => &empty_input,
        Some(value) => value,
    };
    enforce_serialized_size_limit(input, "compute input", max_input_bytes)?;
    Ok(input.clone())
}

/// `/^[A-Za-z_$][A-Za-z0-9_$]*$/` — the entry-point identifier gate.
static ENTRY_POINT_IDENTIFIER: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
    regex::Regex::new("^[A-Za-z_$][A-Za-z0-9_$]*$").expect("valid pattern")
});

/// `executeStandaloneCompute` — payload in, `{ runtime, entry_point, result }`
/// out; JS throws surface as `Err(String)` and reach the caller as
/// `jsonError(400, ...)` at the Phase 6 wiring.
pub fn execute_standalone_compute(env: EnvReader<'_>, payload: &Json) -> Result<Json, String> {
    let wasm_module_base64 = resolve_wasm_module_base64(payload);
    if !wasm_module_base64.is_empty() {
        // SECURITY (S1): user-supplied code, gated behind the same opt-in
        // switch as scripts, with the same size gates in the same order.
        assert_untrusted_scripts_enabled(env)?;
        assert_wasm_module_size_allowed(&wasm_module_base64)?;
        compute_input(payload, env)?;
        return Err(WASM_DEFERRED_MESSAGE.to_string());
    }

    let script = resolve_script_source(payload)?.ok_or_else(|| NO_SCRIPT_MESSAGE.to_string())?;
    assert_untrusted_scripts_enabled(env)?;
    validate_user_script_source(&script, env)?;
    let input = compute_input(payload, env)?;

    let entry_point = first_truthy_trimmed_or(payload, &["entry_point"], "process");
    if !ENTRY_POINT_IDENTIFIER.is_match(&entry_point) {
        return Err("entry point must be a valid identifier".to_string());
    }
    let timeout_source = js_first_truthy(payload, &["script_timeout_ms", "compute_timeout_ms"])
        .cloned()
        .or_else(|| {
            let value = read_env(env, &[COMPUTE_SCRIPT_TIMEOUT_MS_VAR]);
            (!value.is_empty()).then(|| Json::String(value))
        });
    let timeout_ms = capped_duration_ms(timeout_source.as_ref(), 2_000, 10_000);

    let result = run_script_with_timeout(
        ScriptRun {
            mode: ScriptMode::Compute,
            script: &script,
            entry_point: &entry_point,
            input: &input,
            data: &Json::Null,
            context: &Json::Null,
            timeout_ms,
            fixed_now_ms: None,
        },
        env,
    )?;
    Ok(json!({
        "runtime": "script",
        "entry_point": entry_point,
        "result": result,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn env_none(_: &str) -> Option<String> {
        None
    }

    fn env_with(values: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let values: std::collections::HashMap<String, String> = values
            .iter()
            .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
            .collect();
        move |name: &str| values.get(name).cloned()
    }

    /// A base64 body decoding to exactly `n` zero bytes.
    fn base64_of_n_bytes(n: usize) -> String {
        let full_groups = n / 3;
        let mut out = String::new();
        for _ in 0..full_groups {
            out.push_str("AAAA");
        }
        match n % 3 {
            1 => out.push_str("AA=="),
            2 => out.push_str("AAA="),
            _ => {}
        }
        out
    }

    #[test]
    fn resolves_the_module_fields_in_order() {
        assert_eq!(
            resolve_wasm_module_base64(&json!({ "wasm_base64": "  QUJD  " })),
            "QUJD"
        );
        assert_eq!(
            resolve_wasm_module_base64(&json!({ "wasm_module_base64": "REVG" })),
            "REVG"
        );
        assert_eq!(
            resolve_wasm_module_base64(&json!({ "module_base64": "R0hJ" })),
            "R0hJ"
        );
        assert_eq!(
            resolve_wasm_module_base64(&json!({ "wasm_base64": "   " })),
            ""
        );
        assert_eq!(
            resolve_wasm_module_base64(&json!({ "wasm_base64": 42 })),
            ""
        );
    }

    #[test]
    fn module_size_gate_rejects_oversized_modules() {
        assert!(assert_wasm_module_size_allowed("QUJD").is_ok());
        let oversized = base64_of_n_bytes(DEFAULT_MAX_WASM_MODULE_BYTES as usize + 1);
        let error = assert_wasm_module_size_allowed(&oversized).expect_err("must reject");
        assert_eq!(
            error,
            format!("wasm module exceeds max size of {DEFAULT_MAX_WASM_MODULE_BYTES} bytes")
        );
    }

    fn env_enabled() -> impl Fn(&str) -> Option<String> {
        env_with(&[("MORPHEUS_ENABLE_UNTRUSTED_SCRIPTS", "true")])
    }

    #[test]
    fn script_lane_runs_and_reports_its_shape() {
        let payload = json!({
            "script": "function process(input) { return input.n + 1; }",
            "entry_point": "process",
            "input": { "n": 41 },
        });
        let result = execute_standalone_compute(&env_enabled(), &payload).expect("run");
        assert_eq!(
            result,
            json!({ "runtime": "script", "entry_point": "process", "result": 42 })
        );
    }

    #[test]
    fn script_lane_requires_a_script() {
        let error = execute_standalone_compute(&env_none, &json!({})).expect_err("must reject");
        assert_eq!(error, "script or script_base64 required");
    }

    #[test]
    fn script_lane_is_opt_in() {
        let payload = json!({ "script": "function process() { return 1; }" });
        // env_none never enables MORPHEUS_ENABLE_UNTRUSTED_SCRIPTS.
        let error = execute_standalone_compute(&env_none, &payload).expect_err("must refuse");
        assert_eq!(
            error,
            "user-supplied scripts are disabled; set MORPHEUS_ENABLE_UNTRUSTED_SCRIPTS=true to opt in"
        );
    }

    #[test]
    fn script_lane_validates_the_entry_point_identifier() {
        let payload = json!({
            "script": "function process() { return 1; }",
            "entry_point": "not a name",
        });
        let error = execute_standalone_compute(&env_enabled(), &payload).expect_err("must reject");
        assert_eq!(error, "entry point must be a valid identifier");
    }

    #[test]
    fn script_lane_rejects_policy_violations() {
        let payload = json!({ "script": "function process() { return require('fs'); }" });
        let error = execute_standalone_compute(&env_enabled(), &payload).expect_err("must reject");
        assert_eq!(error, "module system access is not allowed");
    }

    #[test]
    fn script_lane_enforces_the_input_size_gate() {
        let env = env_with(&[
            ("MORPHEUS_ENABLE_UNTRUSTED_SCRIPTS", "true"),
            (COMPUTE_MAX_INPUT_BYTES_VAR, "1030"),
        ]);
        let payload = json!({
            "script": "function process(input) { return 1; }",
            "input": { "blob": "x".repeat(1100) },
        });
        let error = execute_standalone_compute(&env, &payload).expect_err("must reject");
        assert_eq!(error, "compute input exceeds max size of 1030 bytes");
    }

    #[test]
    fn wasm_lane_runs_every_failable_check_then_refuses_to_execute() {
        let env = env_with(&[("MORPHEUS_ENABLE_UNTRUSTED_SCRIPTS", "true")]);
        // 1. Opted-out env refuses first, with the opt-in message.
        let payload = json!({ "wasm_base64": "QUJD" });
        let error = execute_standalone_compute(&env_none, &payload).expect_err("must refuse");
        assert!(
            error.contains("user-supplied scripts are disabled"),
            "{error}"
        );
        // 2. Oversized module reports the size error, not the deferral.
        let oversized = base64_of_n_bytes(DEFAULT_MAX_WASM_MODULE_BYTES as usize + 1);
        let payload = json!({ "wasm_base64": oversized });
        let error = execute_standalone_compute(&env, &payload).expect_err("must reject");
        assert!(error.contains("wasm module exceeds max size"), "{error}");
        // 3. A passing module reaches the explicit execution refusal.
        let payload = json!({ "wasm_base64": "QUJD", "input": { "n": 1 } });
        let error = execute_standalone_compute(&env, &payload).expect_err("must refuse");
        assert_eq!(error, WASM_DEFERRED_MESSAGE);
    }
}
