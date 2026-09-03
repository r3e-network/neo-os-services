//! Untrusted script lane — the port of `platform/script-policy.js`,
//! `platform/script-runner.js`, `platform/script-child.cjs` /
//! `script-worker.cjs` and the inline + `script_base64` half of
//! `platform/script-source.js`.
//!
//! Structural change vs the JS worker: the hardened Node child (fork +
//! `node:vm` + `--permission` execArgv + heap/stack knobs) is replaced by an
//! in-process [boa_engine] context. The JS sandbox boundary was "another
//! process with a realm whose intrinsics never touch the host realm"; here it
//! is "another engine entirely" — there is no host-realm object graph inside
//! the boa context at all, so the realm-escape class the JS comments guard
//! against (cross-realm `constructor.constructor`, host `Buffer` reachability)
//! has no surface. What carries over:
//!
//! * the text-level policy gate (`script-policy.js`), byte-for-byte: same 10
//!   blocked patterns, same messages, same size cap with the same JS
//!   `Math.max(NaN, 1024)` NaN propagation (a non-numeric env value disables
//!   the gate — mirrored, not "fixed");
//! * the payload surface: frozen sandbox-realm `helpers` with exactly
//!   `getCurrentTimestamp` / `base64Decode`, `data`+`context` for oracle mode,
//!   `input` for compute mode, `__result` harvesting, and the wrapper source
//!   strings identical to `script-child.cjs` down to the error messages;
//! * the timeout model: wall clock; and the result size cap
//!   (`SCRIPT_WORKER_MAX_RESULT_BYTES`).
//!
//! Known deviations, all deliberate:
//!
//! * Node's vm timeout SIGKILLs the child; a Rust thread cannot be killed, so
//!   the timed-out sandbox thread is leaked. A loop-iteration backstop
//!   (`LOOP_ITERATION_BACKSTOP`) bounds the leaked thread's CPU burn instead
//!   of letting a runaway script spin forever.
//! * `--frozen-intrinsics` and `codeGeneration: {strings: false}` have no boa
//!   analogue; the policy gate remains the text-level boundary and no host
//!   references exist inside the context to freeze/protect.
//! * `SCRIPT_WORKER_MAX_*_SPACE_MB` / `SCRIPT_WORKER_STACK_SIZE_MB` have no
//!   boa analogue and are not ported.
//! * `result === undefined` is reported as JSON `null` (JS `postMessage`
//!   carried `undefined`).
//! * the `script_ref` on-chain registry branch of `script-source.js` is
//!   deferred to the chain-lane phase; requests carrying a registry contract
//!   fail with an explicit message instead of resolving via RPC.

use std::panic::AssertUnwindSafe;
use std::sync::mpsc::RecvTimeoutError;
use std::sync::LazyLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use boa_engine::object::ObjectInitializer;
use boa_engine::{
    js_string, Context, JsArgs, JsError, JsResult, JsString, JsValue, NativeFunction, Source,
};
use regex::Regex;
use serde_json::Value as Json;

use crate::core::{
    buffer_from_base64, decode_base64, measure_serialized_size_bytes, resolve_max_bytes, EnvReader,
};
use crate::js::{js_to_number, js_trim, js_trim_string};

pub const MAX_SCRIPT_BYTES_VAR: &str = "MORPHEUS_MAX_SCRIPT_BYTES";
const DEFAULT_MAX_SCRIPT_BYTES: u64 = 16 * 1024;
const MIN_SCRIPT_BYTES: u64 = 1024;

pub const MAX_RESULT_BYTES_VAR: &str = "SCRIPT_WORKER_MAX_RESULT_BYTES";
const DEFAULT_MAX_RESULT_BYTES: u64 = 64 * 1024;
const MIN_RESULT_BYTES: u64 = 1024;

/// CPU backstop for the leaked-thread timeout model (see module docs): a
/// runaway script aborts with a loop-boundary error after this many loop
/// back-edges instead of burning a core forever.
const LOOP_ITERATION_BACKSTOP: u64 = 100_000_000;

pub const NO_SCRIPT_MESSAGE: &str = "script or script_base64 required";
const SCRIPT_REF_DEFERRED_MESSAGE: &str =
    "script_ref registry resolution is not implemented in the Rust enclave yet; supply an inline script or script_base64";

const ORACLE_SUFFIX: &str = "\nif (typeof process !== 'function') throw new Error('script must define process(data, context, helpers)');\n__result = process(data, context, helpers);";
const COMPUTE_SUFFIX_TEMPLATE: &str = "\nconst __target = typeof {entry} === 'function' ? {entry} : (typeof process === 'function' ? process : null);\nif (!__target) throw new Error('entry point not found');\n__result = __target(input, helpers);";

/// The `script-policy.js` gate, pattern-for-pattern. `\b` in the `regex`
/// crate matches the same word boundaries as JS for ASCII sources.
static BLOCKED_PATTERNS: LazyLock<Vec<(Regex, &'static str)>> = LazyLock::new(|| {
    vec![
        (
            Regex::new(r"\b(?:globalThis|global)\b").expect("valid pattern"),
            "global object access is not allowed",
        ),
        (
            Regex::new(r"\b(?:require|module|exports)\b").expect("valid pattern"),
            "module system access is not allowed",
        ),
        (
            Regex::new(r#"\b(?:import\s*\(|import\s+[^('"])"#).expect("valid pattern"),
            "dynamic or static import is not allowed",
        ),
        (
            Regex::new(r"\b(?:Function|eval)\b").expect("valid pattern"),
            "dynamic code generation is not allowed",
        ),
        (
            Regex::new(r"\b(?:constructor|__proto__|prototype)\b").expect("valid pattern"),
            "prototype or constructor introspection is not allowed",
        ),
        (
            Regex::new(r"\b(?:WebAssembly|SharedArrayBuffer|Atomics)\b").expect("valid pattern"),
            "advanced runtime primitives are not allowed",
        ),
        (
            Regex::new(r"\b(?:fetch|XMLHttpRequest|WebSocket)\b").expect("valid pattern"),
            "network APIs are not allowed",
        ),
        (
            Regex::new(r"\b(?:setTimeout|setInterval|setImmediate|queueMicrotask)\b")
                .expect("valid pattern"),
            "async scheduling APIs are not allowed",
        ),
        (
            Regex::new(r"\b(?:process\s*\.\s*(?:env|mainModule|binding|constructor|stdin|stdout|stderr|kill|exit))")
                .expect("valid pattern"),
            "process host access is not allowed",
        ),
        (
            Regex::new(r"\b(?:child_process|worker_threads|fs|http|https|net|tls|dgram|dns|vm)\b")
                .expect("valid pattern"),
            "host runtime modules are not allowed",
        ),
    ]
});

/// `assertUntrustedScriptsEnabled` (`platform/core.js`): the script lane is
/// opt-in via `MORPHEUS_ENABLE_UNTRUSTED_SCRIPTS=true`.
pub fn assert_untrusted_scripts_enabled(env: EnvReader) -> Result<(), String> {
    let raw = env("MORPHEUS_ENABLE_UNTRUSTED_SCRIPTS").unwrap_or_default();
    if matches!(
        crate::js::js_trim(&raw).to_lowercase().as_str(),
        "1" | "true" | "yes"
    ) {
        Ok(())
    } else {
        Err("user-supplied scripts are disabled; set MORPHEUS_ENABLE_UNTRUSTED_SCRIPTS=true to opt in".to_string())
    }
}

/// `resolveMaxScriptBytes` — JS `Math.max(Number(env || default), 1024)`. A
/// non-numeric value produces NaN, and `size > NaN` is false, so garbage env
/// silently disables the gate; `f64::max` would "fix" that into 1024, so the
/// NaN is propagated explicitly.
fn resolve_max_script_bytes(env: EnvReader) -> f64 {
    let raw = env(MAX_SCRIPT_BYTES_VAR).filter(|value| !value.is_empty());
    let value = match raw {
        None => DEFAULT_MAX_SCRIPT_BYTES as f64,
        Some(value) => js_to_number(&Json::String(value)),
    };
    if value.is_nan() {
        f64::NAN
    } else {
        value.max(MIN_SCRIPT_BYTES as f64)
    }
}

/// `validateUserScriptSource` — trim, size gate, blocked-pattern gate. The
/// trimmed source is only used for validation/execution of the checks; the
/// runner still receives the original (untrimmed) script, exactly like JS.
pub fn validate_user_script_source(script: &str, env: EnvReader) -> Result<(), String> {
    let source = js_trim(script);
    if source.is_empty() {
        return Err("script required".to_string());
    }

    let max_bytes = resolve_max_script_bytes(env);
    if (source.len() as f64) > max_bytes {
        return Err(format!("script exceeds max size of {max_bytes} bytes"));
    }

    for (pattern, message) in BLOCKED_PATTERNS.iter() {
        if pattern.is_match(source) {
            return Err((*message).to_string());
        }
    }
    Ok(())
}

/// `resolveScriptSource` minus the on-chain `script_ref` branch (deferred to
/// the chain-lane phase — see module docs). Inline scripts are returned
/// untrimmed, `script_base64` is leniently decoded to UTF-8, `None` means the
/// caller reports [`NO_SCRIPT_MESSAGE`].
pub fn resolve_script_source(payload: &Json) -> Result<Option<String>, String> {
    if let Some(script) = payload.get("script") {
        if !js_trim_string(Some(script)).is_empty() {
            if let Json::String(script) = script {
                return Ok(Some(script.clone()));
            }
        }
    }
    if let Some(script_base64) = payload.get("script_base64") {
        if !js_trim_string(Some(script_base64)).is_empty() {
            if let Json::String(script_base64) = script_base64 {
                let decoded = decode_base64(script_base64);
                return Ok(Some(String::from_utf8_lossy(&decoded).into_owned()));
            }
        }
    }

    let explicit_contract = payload
        .get("script_ref")
        .and_then(|reference| reference.get("contract_hash"));
    let registry_contract = payload.get("script_registry_contract");
    if !js_trim_string(explicit_contract).is_empty()
        || !js_trim_string(registry_contract).is_empty()
    {
        return Err(SCRIPT_REF_DEFERRED_MESSAGE.to_string());
    }
    Ok(None)
}

/// Execution mode — `script-child.cjs` dispatches on `workerData.mode`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScriptMode {
    Oracle,
    Compute,
}

/// One `runScriptWithTimeout` invocation. `fixed_now_ms` pins the helper
/// clock for tests; production passes `None` for wall-clock time.
pub struct ScriptRun<'a> {
    pub mode: ScriptMode,
    pub script: &'a str,
    pub entry_point: &'a str,
    pub input: &'a Json,
    pub data: &'a Json,
    pub context: &'a Json,
    pub timeout_ms: u64,
    pub fixed_now_ms: Option<f64>,
}

struct OwnedRun {
    mode: ScriptMode,
    script: String,
    entry_point: String,
    input: Json,
    data: Json,
    context: Json,
    fixed_now_ms: Option<f64>,
}

/// `runScriptWithTimeout` (`script-runner.js`) — runs the script on a
/// dedicated thread with a wall-clock timeout and enforces the result size
/// cap. On timeout the thread is leaked (Rust threads cannot be killed); the
/// loop-iteration backstop bounds its CPU burn.
pub fn run_script_with_timeout(run: ScriptRun<'_>, env: EnvReader) -> Result<Json, String> {
    let owned = OwnedRun {
        mode: run.mode,
        script: run.script.to_string(),
        entry_point: run.entry_point.to_string(),
        input: run.input.clone(),
        data: run.data.clone(),
        context: run.context.clone(),
        fixed_now_ms: run.fixed_now_ms,
    };
    let (sender, receiver) = std::sync::mpsc::channel::<Result<Json, String>>();
    std::thread::Builder::new()
        .name("script-sandbox".to_string())
        .spawn(move || {
            let outcome = std::panic::catch_unwind(AssertUnwindSafe(|| run_sandboxed(&owned)))
                .unwrap_or_else(|panic| {
                    let message = panic
                        .downcast_ref::<String>()
                        .cloned()
                        .or_else(|| panic.downcast_ref::<&str>().map(|s| s.to_string()))
                        .unwrap_or_else(|| "unknown panic".to_string());
                    Err(format!("script worker panicked: {message}"))
                });
            let _ = sender.send(outcome);
        })
        .map_err(|error| format!("failed to spawn script worker: {error}"))?;

    match receiver.recv_timeout(Duration::from_millis(run.timeout_ms)) {
        Ok(Ok(result)) => {
            let max_result_bytes = resolve_max_bytes(
                env(MAX_RESULT_BYTES_VAR).map(Json::String).as_ref(),
                DEFAULT_MAX_RESULT_BYTES,
                MIN_RESULT_BYTES,
            );
            let size = measure_serialized_size_bytes(&result);
            if size > max_result_bytes as usize {
                return Err(format!(
                    "script result exceeds max size of {max_result_bytes} bytes"
                ));
            }
            Ok(result)
        }
        Ok(Err(message)) => Err(message),
        Err(RecvTimeoutError::Timeout) => Err(format!(
            "script execution timed out after {}ms",
            run.timeout_ms
        )),
        Err(RecvTimeoutError::Disconnected) => {
            Err("script worker exited without reporting a result".to_string())
        }
    }
}

fn system_now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

fn js_error(error: JsError) -> String {
    error.to_string()
}

fn run_sandboxed(run: &OwnedRun) -> Result<Json, String> {
    let mut context = Context::default();
    context
        .runtime_limits_mut()
        .set_loop_iteration_limit(LOOP_ITERATION_BACKSTOP);

    context
        .register_global_property(
            js_string!("__result"),
            JsValue::undefined(),
            boa_engine::property::Attribute::all(),
        )
        .map_err(js_error)?;
    match run.mode {
        ScriptMode::Oracle => {
            let data = json_to_js(&mut context, &run.data).map_err(js_error)?;
            let script_context = json_to_js(&mut context, &run.context).map_err(js_error)?;
            context
                .register_global_property(
                    js_string!("data"),
                    data,
                    boa_engine::property::Attribute::all(),
                )
                .map_err(js_error)?;
            context
                .register_global_property(
                    js_string!("context"),
                    script_context,
                    boa_engine::property::Attribute::all(),
                )
                .map_err(js_error)?;
        }
        ScriptMode::Compute => {
            let input = json_to_js(&mut context, &run.input).map_err(js_error)?;
            context
                .register_global_property(
                    js_string!("input"),
                    input,
                    boa_engine::property::Attribute::all(),
                )
                .map_err(js_error)?;
        }
    }
    register_helpers(&mut context, run.fixed_now_ms).map_err(js_error)?;

    let mut source = String::with_capacity(run.script.len() + 256);
    source.push_str(&run.script);
    match run.mode {
        ScriptMode::Oracle => source.push_str(ORACLE_SUFFIX),
        ScriptMode::Compute => {
            source.push_str(&COMPUTE_SUFFIX_TEMPLATE.replace("{entry}", &run.entry_point));
        }
    }
    context
        .eval(Source::from_bytes(source.as_bytes()))
        .map_err(js_error)?;
    context.run_jobs().map_err(js_error)?;

    let result = context
        .global_object()
        .get(js_string!("__result"), &mut context)
        .map_err(js_error)?;
    match result.to_json(&mut context) {
        Ok(Some(mut result)) => {
            normalize_js_numbers(&mut result);
            Ok(result)
        }
        Ok(None) => Ok(Json::Null),
        Err(error) => Err(js_error(error)),
    }
}

/// The JS lane round-trips the result through `JSON.stringify` +
/// `JSON.parse`, which renders integral doubles (`42.0`) as `42`; boa's
/// `to_json` keeps them as f64. Re-apply the crate's js-number convention so
/// results compare equal to the JS lane's.
fn normalize_js_numbers(value: &mut Json) {
    match value {
        Json::Number(number) if !number.is_i64() && !number.is_u64() => {
            if let Some(raw) = number.as_f64() {
                *value = crate::js::js_number_value(raw);
            }
        }
        Json::Array(items) => {
            for item in items {
                normalize_js_numbers(item);
            }
        }
        Json::Object(entries) => {
            for item in entries.values_mut() {
                normalize_js_numbers(item);
            }
        }
        _ => {}
    }
}

fn register_helpers(context: &mut Context, fixed_now_ms: Option<f64>) -> JsResult<()> {
    let get_current_timestamp = NativeFunction::from_copy_closure(move |_this, _args, _context| {
        let now_ms = fixed_now_ms.unwrap_or_else(system_now_ms);
        Ok(JsValue::new((now_ms / 1000.0).floor()))
    });
    let base64_decode = NativeFunction::from_copy_closure(|_this, args, context| {
        let value = args.get_or_undefined(0);
        let text = if value.is_null_or_undefined() {
            String::new()
        } else {
            value.to_string(context)?.to_std_string_escaped()
        };
        let decoded = buffer_from_base64(&text.replace('-', "+").replace('_', "/"));
        Ok(JsValue::from(JsString::from(
            String::from_utf8_lossy(&decoded).as_ref(),
        )))
    });
    let helpers = ObjectInitializer::new(context)
        .function(get_current_timestamp, js_string!("getCurrentTimestamp"), 0)
        .function(base64_decode, js_string!("base64Decode"), 1)
        .build();
    context.register_global_property(
        js_string!("helpers"),
        helpers,
        boa_engine::property::Attribute::all(),
    )?;
    context.eval(Source::from_bytes(b"Object.freeze(helpers);"))?;
    Ok(())
}

fn json_to_js(context: &mut Context, value: &Json) -> JsResult<JsValue> {
    match value {
        Json::Null => Ok(JsValue::null()),
        Json::Bool(value) => Ok(JsValue::from(*value)),
        // f64 conversion mirrors JSON.parse: integral values beyond 2^53 lose
        // precision exactly the way V8's parser does.
        Json::Number(number) => match number.as_f64() {
            Some(value) => Ok(JsValue::new(value)),
            None => Ok(JsValue::nan()),
        },
        Json::String(value) => Ok(JsValue::from(JsString::from(value.as_str()))),
        Json::Array(items) => {
            let array = boa_engine::object::builtins::JsArray::new(context);
            for item in items {
                array.push(json_to_js(context, item)?, context)?;
            }
            Ok(array.into())
        }
        Json::Object(entries) => {
            let object = boa_engine::JsObject::with_object_proto(context.intrinsics());
            for (key, item) in entries {
                object.create_data_property_or_throw(
                    JsString::from(key.as_str()),
                    json_to_js(context, item)?,
                    context,
                )?;
            }
            Ok(object.into())
        }
    }
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

    fn oracle(script: &str, data: Json) -> Result<Json, String> {
        run_script_with_timeout(
            ScriptRun {
                mode: ScriptMode::Oracle,
                script,
                entry_point: "process",
                input: &Json::Null,
                data: &data,
                context: &Json::Null,
                timeout_ms: 2_000,
                fixed_now_ms: None,
            },
            &env_none,
        )
    }

    #[test]
    fn policy_accepts_a_plain_process_function() {
        validate_user_script_source("function process(data) { return data; }", &env_none)
            .expect("plain script passes");
    }

    #[test]
    fn policy_blocks_the_documented_patterns() {
        let cases = [
            ("globalThis.x", "global object access is not allowed"),
            ("var g = global;", "global object access is not allowed"),
            ("require('fs')", "module system access is not allowed"),
            ("module.exports = {}", "module system access is not allowed"),
            ("import('fs')", "dynamic or static import is not allowed"),
            (
                "new Function('return 1')",
                "dynamic code generation is not allowed",
            ),
            ("eval('1')", "dynamic code generation is not allowed"),
            (
                "data.constructor",
                "prototype or constructor introspection is not allowed",
            ),
            (
                "obj.__proto__",
                "prototype or constructor introspection is not allowed",
            ),
            (
                "WebAssembly.compile()",
                "advanced runtime primitives are not allowed",
            ),
            ("fetch('/x')", "network APIs are not allowed"),
            ("setTimeout(f, 0)", "async scheduling APIs are not allowed"),
            ("process.env.HOME", "process host access is not allowed"),
            (
                "require('child_process')",
                "module system access is not allowed",
            ),
            (
                "child_process.spawn",
                "host runtime modules are not allowed",
            ),
            (
                "worker_threads.isMainThread",
                "host runtime modules are not allowed",
            ),
        ];
        for (source, message) in cases {
            let error = validate_user_script_source(source, &env_none)
                .expect_err("script must be rejected");
            assert_eq!(error, message, "unexpected message for {source}");
        }
    }

    #[test]
    fn policy_requires_a_script() {
        assert_eq!(
            validate_user_script_source("   \n\t ", &env_none).expect_err("must reject"),
            "script required"
        );
    }

    #[test]
    fn policy_enforces_the_size_cap() {
        // Values below the 1024 floor clamp up (Math.max semantics).
        let env = env_with(&[(MAX_SCRIPT_BYTES_VAR, "1028")]);
        let error = validate_user_script_source(&"a".repeat(1029), &env).expect_err("must reject");
        assert_eq!(error, "script exceeds max size of 1028 bytes");
        validate_user_script_source(&"a".repeat(1028), &env).expect("fits exactly");
    }

    #[test]
    fn policy_mirrors_the_js_nan_env_quirk() {
        // Number("abc") = NaN, Math.max(NaN, 1024) = NaN, size > NaN = false:
        // the JS gate silently disables itself on garbage env values.
        let env = env_with(&[(MAX_SCRIPT_BYTES_VAR, "abc")]);
        let oversized = "x".repeat(DEFAULT_MAX_SCRIPT_BYTES as usize + 1);
        validate_user_script_source(&oversized, &env).expect("NaN env disables the gate");
    }

    #[test]
    fn resolve_script_source_returns_inline_untrimmed() {
        let payload = json!({ "script": "  process(data); " });
        assert_eq!(
            resolve_script_source(&payload).expect("inline"),
            Some("  process(data); ".to_string())
        );
    }

    #[test]
    fn resolve_script_source_decodes_base64() {
        let payload = json!({ "script_base64": "aGVsbG8=" });
        assert_eq!(
            resolve_script_source(&payload).expect("base64"),
            Some("hello".to_string())
        );
    }

    #[test]
    fn resolve_script_source_reports_missing_script() {
        assert_eq!(resolve_script_source(&json!({})).expect("none"), None);
    }

    #[test]
    fn resolve_script_source_defers_the_registry_branch() {
        let payload = json!({ "script_registry_contract": "0xabc" });
        let error = resolve_script_source(&payload).expect_err("must defer");
        assert!(error.contains("not implemented in the Rust enclave yet"));
    }

    #[test]
    fn untrusted_scripts_are_opt_in() {
        assert!(assert_untrusted_scripts_enabled(&env_none).is_err());
        assert!(assert_untrusted_scripts_enabled(&env_with(&[(
            "MORPHEUS_ENABLE_UNTRUSTED_SCRIPTS",
            "false"
        )]))
        .is_err());
        assert!(assert_untrusted_scripts_enabled(&env_with(&[(
            "MORPHEUS_ENABLE_UNTRUSTED_SCRIPTS",
            "true"
        )]))
        .is_ok());
    }

    #[test]
    fn oracle_runs_process_and_harvests_the_result() {
        let result = oracle(
            "function process(data, context, helpers) { return { x: data.x + 1, flag: data.flag }; }",
            json!({ "x": 41, "flag": true }),
        )
        .expect("oracle run");
        assert_eq!(result, json!({ "x": 42, "flag": true }));
    }

    #[test]
    fn oracle_undefined_result_becomes_null() {
        let result = oracle("function process() {}", json!(null)).expect("run");
        assert_eq!(result, Json::Null);
    }

    #[test]
    fn oracle_requires_a_process_function() {
        let error = oracle("1;", json!(null)).expect_err("must fail");
        assert!(error.contains("script must define process"), "{error}");
    }

    #[test]
    fn helpers_are_frozen_and_helpers_only() {
        let result = oracle(
            "function process() { return [Object.isFrozen(helpers), typeof helpers.getCurrentTimestamp, typeof helpers.base64Decode]; }",
            json!(null),
        )
        .expect("run");
        assert_eq!(result, json!([true, "function", "function"]));
    }

    #[test]
    fn helper_clock_is_pinned_for_tests() {
        let result = run_script_with_timeout(
            ScriptRun {
                mode: ScriptMode::Oracle,
                script: "function process(data, context, helpers) { return helpers.getCurrentTimestamp(); }",
                entry_point: "process",
                input: &Json::Null,
                data: &json!(null),
                context: &Json::Null,
                timeout_ms: 2_000,
                fixed_now_ms: Some(1_700_000_000_123.0),
            },
            &env_none,
        )
        .expect("run");
        assert_eq!(result, Json::from(1_700_000_000_u64));
    }

    #[test]
    fn base64_decode_matches_the_host_primitive() {
        let result = oracle(
            "function process(data, context, helpers) { return [helpers.base64Decode('aGVsbG8='), helpers.base64Decode('aGVs' + 'bG8'), helpers.base64Decode(null), helpers.base64Decode('')]; }",
            json!(null),
        )
        .expect("run");
        assert_eq!(
            result,
            json!(["hello", "hello", "", ""]),
            "lenient unpadded decoding must match Buffer.from"
        );
    }

    #[test]
    fn compute_mode_dispatches_the_entry_point() {
        let result = run_script_with_timeout(
            ScriptRun {
                mode: ScriptMode::Compute,
                script: "function main(input) { return input.n * 2; }",
                entry_point: "main",
                input: &json!({ "n": 21 }),
                data: &Json::Null,
                context: &Json::Null,
                timeout_ms: 2_000,
                fixed_now_ms: None,
            },
            &env_none,
        )
        .expect("run");
        assert_eq!(result, Json::from(42_u64));
    }

    #[test]
    fn compute_mode_falls_back_to_process() {
        let result = run_script_with_timeout(
            ScriptRun {
                mode: ScriptMode::Compute,
                script: "function process(input) { return input.n + 1; }",
                entry_point: "missing",
                input: &json!({ "n": 41 }),
                data: &Json::Null,
                context: &Json::Null,
                timeout_ms: 2_000,
                fixed_now_ms: None,
            },
            &env_none,
        )
        .expect("run");
        assert_eq!(result, Json::from(42_u64));
    }

    #[test]
    fn compute_mode_reports_a_missing_entry_point() {
        let error = run_script_with_timeout(
            ScriptRun {
                mode: ScriptMode::Compute,
                script: "1;",
                entry_point: "missing",
                input: &json!({}),
                data: &Json::Null,
                context: &Json::Null,
                timeout_ms: 2_000,
                fixed_now_ms: None,
            },
            &env_none,
        )
        .expect_err("must fail");
        assert!(error.contains("entry point not found"), "{error}");
    }

    #[test]
    fn script_errors_carry_the_message() {
        let error = oracle(
            "function process() { throw new Error('boom'); }",
            json!(null),
        )
        .expect_err("must fail");
        assert!(error.contains("boom"), "{error}");
    }

    #[test]
    fn timeout_kills_runaway_scripts() {
        let started = std::time::Instant::now();
        let error = run_script_with_timeout(
            ScriptRun {
                mode: ScriptMode::Oracle,
                script: "while (true) {}",
                entry_point: "process",
                input: &Json::Null,
                data: &Json::Null,
                context: &Json::Null,
                timeout_ms: 150,
                fixed_now_ms: None,
            },
            &env_none,
        )
        .expect_err("must time out");
        assert_eq!(error, "script execution timed out after 150ms");
        assert!(started.elapsed() >= Duration::from_millis(150));
    }

    #[test]
    fn result_size_cap_applies() {
        let env = env_with(&[(MAX_RESULT_BYTES_VAR, "1100")]);
        let error = run_script_with_timeout(
            ScriptRun {
                mode: ScriptMode::Oracle,
                script: "function process() { return 'x'.repeat(1200); }",
                entry_point: "process",
                input: &Json::Null,
                data: &Json::Null,
                context: &Json::Null,
                timeout_ms: 2_000,
                fixed_now_ms: None,
            },
            &env,
        )
        .expect_err("must reject the oversized result");
        assert_eq!(error, "script result exceeds max size of 1100 bytes");
    }
}
