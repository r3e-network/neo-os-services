//! Pure slice of `workers/nitro-worker/src/paymaster/index.js`: the gas
//! sponsorship authorization verdict — env policy resolution, the allow/block
//! list chain, the on-chain AA hook read (`getHook` → `getHooks` →
//! `isWhitelisted` over JSON-RPC `invokefunction`), and the approval digest.
//!
//! Not ported here (Phase 6 wiring): `buildSignedResultEnvelope` /
//! `buildLaneSignedEnvelope` composition. The lane returns the verdict object;
//! the handler signs it and spreads the lane envelope into the 200 response.
//! The `json(400, { error })` branches surface as [`PaymasterEvaluation::Invalid`]
//! because JS still routes that Response through the same envelope call.

use base64::alphabet::STANDARD as BASE64_ALPHABET;
use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
use base64::Engine as _;
use serde_json::{json, Value as Json};
use sha2::{Digest, Sha256};

use crate::core::{
    env_for_network, normalize_boolean, normalize_target_chain, parse_duration_ms, read_env,
    resolve_payload_network, EnvReader,
};
use crate::js::{
    js_first_truthy, js_iso_string_from_ms, js_number, js_number_value, js_stringify, js_to_number,
    js_trim, js_trim_string, js_truthy,
};
use crate::stable_stringify::stable_stringify;
use crate::transport::{HttpRequest, HttpTransport};

/// The two result shapes `evaluatePaymasterAuthorization` returns: the
/// `json(400, { error })` Response body, or a denied/approved verdict object
/// (the object that gets signed).
#[derive(Debug)]
pub enum PaymasterEvaluation {
    /// Body of `json(400, { error })` — the handler passes it through the
    /// same signed-envelope call as a verdict (JS behavior).
    Invalid(Json),
    /// A denied or approved verdict object.
    Verdict(Json),
}

/// The `MORPHEUS_PAYMASTER_{MAINNET|TESTNET}_*` env snapshot.
#[derive(Debug)]
pub struct PaymasterPolicy {
    pub network: String,
    pub enabled: bool,
    pub policy_id: String,
    pub max_gas_units: f64,
    pub allow_targets: Vec<String>,
    pub allow_methods: Vec<String>,
    pub allow_accounts: Vec<String>,
    pub block_accounts: Vec<String>,
    pub allow_dapps: Vec<String>,
    pub aa_core_hash: String,
    pub whitelist_hook_hash: String,
    pub multi_hook_hash: String,
    pub neo_rpc_url: String,
    pub ttl_ms: u64,
}

/// The `normalizeVerdictPayload` projection (trimmed strings + coerced gas).
#[derive(Debug)]
struct NormalizedVerdict {
    account_id: String,
    dapp_id: String,
    target_contract: String,
    method: String,
    userop_target_contract: String,
    userop_method: String,
    estimated_gas_units: f64,
    operation_hash: String,
    target_chain: String,
}

fn parse_csv(value: &str) -> Vec<String> {
    if value.is_empty() {
        return Vec::new();
    }
    value
        .split(',')
        .map(js_trim)
        .filter(|entry| !entry.is_empty())
        .map(String::from)
        .collect()
}

/// `normalizeHexHash` — `trimString(value).toLowerCase()`, one leading `0x`
/// stripped, then exactly 40 lowercase hex digits survive (prefixed back).
fn normalize_hex_hash(value: Option<&Json>) -> String {
    let raw = js_trim_string(value).to_lowercase();
    let stripped = raw.strip_prefix("0x").unwrap_or(&raw);
    let is_hex40 = stripped.len() == 40
        && stripped
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
    if is_hex40 {
        format!("0x{stripped}")
    } else {
        String::new()
    }
}

/// `resolvePaymasterNetwork` — payload network wins, else the
/// `MORPHEUS_NETWORK` env only when it reads `mainnet` (anything else,
/// including unset, means testnet).
pub fn resolve_paymaster_network(payload: &Json, env: EnvReader<'_>) -> String {
    let network_env = read_env(env, &["MORPHEUS_NETWORK"]);
    let fallback = if network_env.to_lowercase() == "mainnet" {
        "mainnet"
    } else {
        "testnet"
    };
    resolve_payload_network(payload, fallback)
}

/// `resolvePaymasterPolicy(network)` — the per-network env set.
pub fn resolve_paymaster_policy(network: &str, env: EnvReader<'_>) -> PaymasterPolicy {
    let upper = if network == "mainnet" {
        "MAINNET"
    } else {
        "TESTNET"
    };
    let name = |suffix: &str| format!("MORPHEUS_PAYMASTER_{upper}_{suffix}");
    let env_value = |suffix: &str| read_env(env, &[&name(suffix)]);

    let enabled = normalize_boolean(Some(&Json::String(env_value("ENABLED"))), false);

    let policy_id_raw = env_value("POLICY_ID");
    let policy_id = if policy_id_raw.is_empty() {
        format!("{network}-default")
    } else {
        policy_id_raw
    };

    let max_gas_raw = env_value("MAX_GAS_UNITS");
    let max_gas_units = if max_gas_raw.is_empty() {
        0.0
    } else {
        js_number(&max_gas_raw)
    };

    let list = |suffix: &str| -> Vec<String> {
        parse_csv(&env_value(suffix))
            .into_iter()
            .map(|entry| entry.to_lowercase())
            .collect()
    };

    let aa_core_raw = env_value("AA_CORE_HASH");
    let aa_core_hash = if aa_core_raw.is_empty() {
        env_for_network(network, &["AA_CORE_HASH"], env)
    } else {
        aa_core_raw
    };

    let neo_rpc_raw = env_value("NEO_RPC_URL");
    let neo_rpc_url = if neo_rpc_raw.is_empty() {
        env_for_network(network, &["NEO_RPC_URL"], env)
    } else {
        neo_rpc_raw
    };

    let ttl_raw = env_value("TTL_MS");
    let ttl_value = if ttl_raw.is_empty() {
        "15m".to_string()
    } else {
        ttl_raw
    };

    PaymasterPolicy {
        network: network.to_string(),
        enabled,
        policy_id: js_trim(&policy_id).to_string(),
        max_gas_units,
        allow_targets: list("ALLOW_TARGETS"),
        allow_methods: list("ALLOW_METHODS"),
        allow_accounts: list("ALLOW_ACCOUNTS"),
        block_accounts: list("BLOCK_ACCOUNTS"),
        allow_dapps: list("ALLOW_DAPPS"),
        aa_core_hash: normalize_hex_hash(Some(&Json::String(aa_core_hash))),
        whitelist_hook_hash: normalize_hex_hash(Some(&Json::String(env_value(
            "WHITELIST_HOOK_HASH",
        )))),
        multi_hook_hash: normalize_hex_hash(Some(&Json::String(env_value("MULTI_HOOK_HASH")))),
        neo_rpc_url,
        ttl_ms: parse_duration_ms(Some(&Json::String(ttl_value)), 15 * 60_000),
    }
}

/// `trimString(a || b || c || '')` chains — first truthy operand wins, the
/// truthiness test runs on the raw value before any trim.
fn truthy_trim(payload: &Json, keys: &[&str]) -> String {
    js_trim_string(js_first_truthy(payload, keys))
}

fn normalize_verdict_payload(payload: &Json) -> Result<NormalizedVerdict, String> {
    // `Number(a ?? b ?? 0)`: the `??` chain collapses only null/undefined, so
    // `0`, `""` and `false` stay; absent collapses to Number(0) = 0.
    let gas_candidate = ["estimated_gas_units", "estimatedGasUnits"]
        .iter()
        .filter_map(|key| payload.get(*key))
        .find(|value| !value.is_null());
    let estimated_gas_units = match gas_candidate {
        Some(value) => js_to_number(value),
        None => 0.0,
    };
    Ok(NormalizedVerdict {
        account_id: truthy_trim(payload, &["account_id", "accountId", "requester"]),
        dapp_id: truthy_trim(payload, &["dapp_id", "dappId"]),
        target_contract: truthy_trim(payload, &["target_contract", "targetContract"]),
        method: truthy_trim(payload, &["method", "target_method", "targetMethod"]),
        userop_target_contract: truthy_trim(
            payload,
            &["userop_target_contract", "userOpTargetContract"],
        ),
        userop_method: truthy_trim(payload, &["userop_method", "userOpMethod"]),
        estimated_gas_units,
        operation_hash: truthy_trim(payload, &["operation_hash", "operationHash"]),
        target_chain: normalize_target_chain(payload.get("target_chain").unwrap_or(&Json::Null))?,
    })
}

fn build_denied_verdict(
    policy: &PaymasterPolicy,
    normalized: &NormalizedVerdict,
    reason: &str,
) -> Json {
    json!({
        "mode": "paymaster_authorize",
        "approved": false,
        "reason": reason,
        "network": policy.network,
        "target_chain": normalized.target_chain,
        "account_id": normalized.account_id,
        "dapp_id": normalized.dapp_id,
        "target_contract": normalized.target_contract,
        "method": normalized.method,
        "userop_target_contract": normalized.userop_target_contract,
        "userop_method": normalized.userop_method,
        "estimated_gas_units": js_number_value(normalized.estimated_gas_units),
        "operation_hash": normalized.operation_hash,
        "policy": {
            "policy_id": policy.policy_id,
            "max_gas_units": js_number_value(policy.max_gas_units),
            "allow_targets": policy.allow_targets,
            "allow_methods": policy.allow_methods,
            "allow_accounts": policy.allow_accounts,
            "block_accounts": policy.block_accounts,
            "allow_dapps": policy.allow_dapps,
        },
    })
}

/// `Buffer.from(str, 'base64')` — Node's decoder is lenient (invalid
/// characters are ignored), so filter to the standard alphabet and decode
/// with optional canonical padding. A structurally broken remainder (e.g. a
/// stray `=`) errs into the JS `catch` path.
fn decode_base64_lenient(source: &str) -> Result<Vec<u8>, ()> {
    let filtered: String = source
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '+' || *c == '/' || *c == '=')
        .collect();
    let engine = GeneralPurpose::new(
        &BASE64_ALPHABET,
        GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent),
    );
    engine.decode(filtered.as_bytes()).map_err(|_| ())
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn sha256_hex(input: &[u8]) -> String {
    hex_encode(&Sha256::digest(input))
}

/// `stackItemToValue` — one Neo RPC stack item into a plain JSON value.
fn stack_item_to_value(item: &Json) -> Json {
    if !item.is_object() {
        return Json::Null;
    }
    let kind = item.get("type").and_then(Json::as_str).unwrap_or("");
    let value = item.get("value").unwrap_or(&Json::Null);
    match kind {
        "Boolean" => Json::Bool(js_truthy(value)),
        "ByteString" => {
            // String(item.value || ''): falsy collapses BEFORE coercion.
            let source = if js_truthy(value) {
                js_stringify(value)
            } else {
                String::new()
            };
            match decode_base64_lenient(&source) {
                Ok(bytes) => Json::String(hex_encode(&bytes)),
                Err(()) => Json::String(source),
            }
        }
        "Hash160" => Json::String(normalize_hex_hash(Some(value))),
        "Array" | "Struct" => match value.as_array() {
            Some(items) => Json::Array(items.iter().map(stack_item_to_value).collect()),
            None => Json::Array(Vec::new()),
        },
        // item.value ?? null — only null/undefined collapse; 0 and '' stay.
        _ => {
            if value.is_null() {
                Json::Null
            } else {
                value.clone()
            }
        }
    }
}

fn hash160_arg(value: &str) -> Json {
    json!({ "type": "Hash160", "value": normalize_hex_hash(Some(&Json::String(value.to_string()))) })
}

/// `invokeNeoRead` — one JSON-RPC `invokefunction` read. The Response body
/// must parse as JSON (JS `response.json()` throws a SyntaxError otherwise)
/// and a truthy `data.error` throws `error.message || invokefunction …`.
fn invoke_neo_read(
    http: HttpTransport<'_>,
    rpc_url: &str,
    contract_hash: &str,
    method: &str,
    args: &[Json],
) -> Result<Json, String> {
    let body = serde_json::to_vec(&json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "invokefunction",
        "params": [contract_hash, method, args],
    }))
    .expect("jsonrpc request body serializes");
    let request = HttpRequest {
        url: rpc_url.to_string(),
        method: "POST".to_string(),
        headers: vec![("content-type".to_string(), "application/json".to_string())],
        body: Some(body),
        timeout_ms: 15_000,
        // Plain fetch: redirects are followed (unlike the oracle-fetch path).
        follow_redirects: true,
    };
    let response = http(&request)?;
    let data: Json = serde_json::from_slice(&response.body)
        .map_err(|_| "response body is not valid JSON".to_string())?;
    let error = data.get("error").unwrap_or(&Json::Null);
    if js_truthy(error) {
        let message = error
            .get("message")
            .map(js_trim_string_noop)
            .filter(|message| !message.is_empty())
            .unwrap_or_else(|| format!("invokefunction {method} failed"));
        return Err(message);
    }
    Ok(data.get("result").cloned().unwrap_or(Json::Null))
}

/// `data.error.message || fallback` — a truthy message wins verbatim; no
/// trimming happens on this path in JS.
fn js_trim_string_noop(value: &Json) -> String {
    match value {
        Json::String(s) => s.clone(),
        other => js_stringify(other),
    }
}

fn stack_first(result: &Json) -> Json {
    result
        .get("stack")
        .and_then(Json::as_array)
        .and_then(|stack| stack.first())
        .cloned()
        .unwrap_or(Json::Null)
}

/// `evaluateOnChainAAPolicy` — walks `getHook` on the AA core, optionally
/// `getHooks` through the multi-hook, then `isWhitelisted` on the active
/// whitelist hook. RPC throws propagate (JS awaits without try/catch).
fn evaluate_on_chain_aa_policy(
    policy: &PaymasterPolicy,
    normalized: &NormalizedVerdict,
    http: HttpTransport<'_>,
) -> Result<Json, String> {
    if policy.neo_rpc_url.is_empty()
        || policy.aa_core_hash.is_empty()
        || normalized.account_id.is_empty()
        || normalized.userop_target_contract.is_empty()
    {
        return Ok(json!({
            "checked": false,
            "approved": null,
            "reason": "aa on-chain policy not configured",
        }));
    }

    let hook_result = invoke_neo_read(
        http,
        &policy.neo_rpc_url,
        &policy.aa_core_hash,
        "getHook",
        &[hash160_arg(&normalized.account_id)],
    )?;
    let hook_hash = normalize_hex_hash(Some(&stack_item_to_value(&stack_first(&hook_result))));
    if hook_hash.is_empty() {
        return Ok(json!({
            "checked": false,
            "approved": null,
            "reason": "aa account has no hook configured",
        }));
    }

    let mut whitelist_hook = String::new();
    if !policy.whitelist_hook_hash.is_empty() && hook_hash == policy.whitelist_hook_hash {
        whitelist_hook = hook_hash.clone();
    } else if !policy.multi_hook_hash.is_empty()
        && hook_hash == policy.multi_hook_hash
        && !policy.whitelist_hook_hash.is_empty()
    {
        let hooks_result = invoke_neo_read(
            http,
            &policy.neo_rpc_url,
            &hook_hash,
            "getHooks",
            &[hash160_arg(&normalized.account_id)],
        )?;
        // hooksResult?.stack?.[0]?.value — the raw value, not stackItemToValue.
        let hooks = stack_first(&hooks_result)
            .get("value")
            .and_then(Json::as_array)
            .map(|entries| {
                entries
                    .iter()
                    .map(|entry| normalize_hex_hash(Some(&stack_item_to_value(entry))))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        if hooks.contains(&policy.whitelist_hook_hash) {
            whitelist_hook = policy.whitelist_hook_hash.clone();
        }
    }

    if whitelist_hook.is_empty() {
        return Ok(json!({
            "checked": false,
            "approved": null,
            "reason": "aa whitelist hook not active for account",
        }));
    }

    let verdict_result = invoke_neo_read(
        http,
        &policy.neo_rpc_url,
        &whitelist_hook,
        "isWhitelisted",
        &[
            hash160_arg(&normalized.account_id),
            hash160_arg(&normalized.userop_target_contract),
        ],
    )?;
    let approved = js_truthy(
        stack_first(&verdict_result)
            .get("value")
            .unwrap_or(&Json::Null),
    );
    Ok(json!({
        "checked": true,
        "approved": approved,
        "reason": if approved {
            ""
        } else {
            "userop_target_contract is not allowlisted by AA hook"
        },
        "hook": whitelist_hook,
    }))
}

/// `evaluatePaymasterAuthorization(payload)` — the validation chain, then the
/// on-chain AA read, then the approval. `Err` models the JS throws
/// (`normalizeTargetChain`, RPC failures) that reach the handler's catch.
pub fn evaluate_paymaster_authorization(
    env: EnvReader<'_>,
    payload: &Json,
    http: HttpTransport<'_>,
    now_ms: i64,
    random_uuid: impl Fn() -> String,
) -> Result<PaymasterEvaluation, String> {
    let network = resolve_paymaster_network(payload, env);
    let policy = resolve_paymaster_policy(&network, env);
    let normalized = normalize_verdict_payload(payload)?;

    // Number(payload.estimated_gas_units) — the direct field only, NOT the
    // ?? chain the normalized verdict uses; absent → NaN (Number(undefined)).
    let gas_units = payload
        .get("estimated_gas_units")
        .map(js_to_number)
        .unwrap_or(f64::NAN);
    if !gas_units.is_finite() || gas_units < 1.0 {
        return Ok(PaymasterEvaluation::Invalid(json!({
            "error": "estimated_gas_units must be a positive number",
        })));
    }

    let denied = |reason: &str| {
        PaymasterEvaluation::Verdict(build_denied_verdict(&policy, &normalized, reason))
    };

    if !policy.enabled {
        return Ok(denied("paymaster disabled for network"));
    }
    if normalized.account_id.is_empty() {
        return Ok(denied("account_id is required"));
    }
    if normalized.target_chain != "neo_n3" {
        return Ok(denied("paymaster currently supports neo_n3 only"));
    }
    if normalized.operation_hash.is_empty() {
        return Ok(denied("operation_hash is required"));
    }
    if normalized.target_contract.is_empty() {
        return Ok(denied("target_contract is required"));
    }
    if normalized.method.is_empty() {
        return Ok(denied("method is required"));
    }
    if policy.max_gas_units > 0.0 && normalized.estimated_gas_units > policy.max_gas_units {
        return Ok(denied("estimated gas exceeds network paymaster limit"));
    }
    if !policy.block_accounts.is_empty()
        && policy
            .block_accounts
            .contains(&normalized.account_id.to_lowercase())
    {
        return Ok(denied("account_id is blocklisted"));
    }
    if !policy.allow_accounts.is_empty()
        && !policy
            .allow_accounts
            .contains(&normalized.account_id.to_lowercase())
    {
        return Ok(denied("account_id is not allowlisted"));
    }
    if !policy.allow_dapps.is_empty() {
        if normalized.dapp_id.is_empty() {
            return Ok(denied("dapp_id is required"));
        }
        if !policy
            .allow_dapps
            .contains(&normalized.dapp_id.to_lowercase())
        {
            return Ok(denied("dapp_id is not allowlisted"));
        }
    }
    if !policy.allow_targets.is_empty()
        && !policy
            .allow_targets
            .contains(&normalized.target_contract.to_lowercase())
    {
        return Ok(denied("target_contract is not allowlisted"));
    }
    if !policy.allow_methods.is_empty()
        && !policy
            .allow_methods
            .contains(&normalized.method.to_lowercase())
    {
        return Ok(denied("method is not allowlisted"));
    }

    let onchain_policy = evaluate_on_chain_aa_policy(&policy, &normalized, http)?;
    let checked = js_truthy(onchain_policy.get("checked").unwrap_or(&Json::Null));
    let approved = js_truthy(onchain_policy.get("approved").unwrap_or(&Json::Null));
    let requires_on_chain_policy = !policy.aa_core_hash.is_empty()
        || !policy.whitelist_hook_hash.is_empty()
        || !policy.multi_hook_hash.is_empty()
        || !normalized.userop_target_contract.is_empty();
    if requires_on_chain_policy && (!checked || !approved) {
        let onchain_reason = onchain_policy
            .get("reason")
            .map(js_trim_string_noop)
            .filter(|reason| !reason.is_empty());
        let reason = if checked {
            onchain_reason.unwrap_or_else(|| "AA hook policy denied sponsorship".to_string())
        } else {
            format!(
                "required AA hook policy was not checked: {}",
                onchain_reason.unwrap_or_else(|| "missing context".to_string())
            )
        };
        return Ok(denied(&reason));
    }

    let digest_input = json!({
        "network": policy.network,
        "policy_id": policy.policy_id,
        "account_id": normalized.account_id,
        "dapp_id": normalized.dapp_id,
        "target_contract": normalized.target_contract,
        "method": normalized.method,
        "estimated_gas_units": js_number_value(normalized.estimated_gas_units),
        "operation_hash": normalized.operation_hash,
    });
    let approval_digest = sha256_hex(stable_stringify(&digest_input).as_bytes());
    let onchain_summary = if checked {
        json!({
            "source": "aa_hook",
            "hook": onchain_policy
                .get("hook")
                .filter(|hook| js_truthy(hook))
                .cloned()
                .unwrap_or(Json::Null),
        })
    } else {
        Json::Null
    };
    Ok(PaymasterEvaluation::Verdict(json!({
        "mode": "paymaster_authorize",
        "approved": true,
        "network": policy.network,
        "target_chain": normalized.target_chain,
        "policy_id": policy.policy_id,
        "sponsorship_id": random_uuid(),
        "account_id": normalized.account_id,
        "dapp_id": normalized.dapp_id,
        "target_contract": normalized.target_contract,
        "method": normalized.method,
        "userop_target_contract": normalized.userop_target_contract,
        "userop_method": normalized.userop_method,
        "estimated_gas_units": js_number_value(normalized.estimated_gas_units),
        "operation_hash": normalized.operation_hash,
        "approval_digest": approval_digest,
        "expires_at": js_iso_string_from_ms(now_ms.saturating_add(policy.ttl_ms as i64)),
        "policy": {
            "policy_id": policy.policy_id,
            "max_gas_units": js_number_value(policy.max_gas_units),
        },
        "onchain_policy": onchain_summary,
    })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::HttpResponse;
    use serde_json::Value as Json;
    use std::collections::HashMap;

    fn env_from(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect();
        move |name| map.get(name).cloned()
    }

    fn no_env(_: &str) -> Option<String> {
        None
    }

    fn no_rpc(_: &HttpRequest) -> Result<HttpResponse, String> {
        Err("no transport in this fixture".to_string())
    }

    fn uuid_sequence(prefix: &str) -> impl Fn() -> String {
        let prefix = prefix.to_string();
        let counter = std::cell::Cell::new(0u32);
        move || {
            counter.set(counter.get() + 1);
            format!("{prefix}-{}", counter.get())
        }
    }

    fn payload(pairs: &[(&str, Json)]) -> Json {
        let mut map = serde_json::Map::new();
        for (key, value) in pairs {
            map.insert(key.to_string(), value.clone());
        }
        Json::Object(map)
    }

    fn verdict(evaluation: PaymasterEvaluation) -> Json {
        match evaluation {
            PaymasterEvaluation::Verdict(value) => value,
            PaymasterEvaluation::Invalid(value) => {
                panic!("expected a verdict, got invalid: {value}")
            }
        }
    }

    fn invalid(evaluation: PaymasterEvaluation) -> Json {
        match evaluation {
            PaymasterEvaluation::Invalid(value) => value,
            PaymasterEvaluation::Verdict(value) => panic!("expected invalid, got verdict: {value}"),
        }
    }

    const NOW_MS: i64 = 1_700_000_000_000; // 2023-11-14T22:13:20.000Z

    fn enabled_env() -> impl Fn(&str) -> Option<String> {
        env_from(&[("MORPHEUS_PAYMASTER_TESTNET_ENABLED", "true")])
    }

    fn base_payload() -> Json {
        payload(&[
            ("account_id", json!("0xacc")),
            ("operation_hash", json!("op")),
            ("target_contract", json!("0xtarget")),
            ("method", json!("transfer")),
            ("estimated_gas_units", json!(5)),
        ])
    }

    #[test]
    fn policy_reads_the_per_network_env_set() {
        let env = env_from(&[
            ("MORPHEUS_PAYMASTER_TESTNET_ENABLED", "yes"),
            ("MORPHEUS_PAYMASTER_TESTNET_POLICY_ID", "  fed-policy "),
            ("MORPHEUS_PAYMASTER_TESTNET_MAX_GAS_UNITS", "1.5e3"),
            (
                "MORPHEUS_PAYMASTER_TESTNET_ALLOW_TARGETS",
                "0xTarget, , 0xtarget2",
            ),
            ("MORPHEUS_PAYMASTER_TESTNET_BLOCK_ACCOUNTS", "0xBad"),
            ("MORPHEUS_PAYMASTER_TESTNET_TTL_MS", "5m"),
            (
                "MORPHEUS_PAYMASTER_TESTNET_WHITELIST_HOOK_HASH",
                "AB".repeat(20).as_str(),
            ),
        ]);
        let policy = resolve_paymaster_policy("testnet", &env);
        assert!(policy.enabled);
        assert_eq!(policy.policy_id, "fed-policy");
        assert_eq!(policy.max_gas_units, 1500.0);
        assert_eq!(policy.allow_targets, vec!["0xtarget", "0xtarget2"]);
        assert_eq!(policy.block_accounts, vec!["0xbad"]);
        assert_eq!(policy.ttl_ms, 300_000);
        assert_eq!(policy.whitelist_hook_hash, format!("0x{}", "ab".repeat(20)));
        assert_eq!(policy.aa_core_hash, "");
    }

    #[test]
    fn policy_defaults_and_network_fallbacks() {
        let policy = resolve_paymaster_policy("testnet", &no_env);
        assert!(!policy.enabled);
        assert_eq!(policy.policy_id, "testnet-default");
        assert_eq!(policy.max_gas_units, 0.0);
        assert!(policy.allow_accounts.is_empty());
        assert_eq!(policy.neo_rpc_url, "");
        assert_eq!(policy.ttl_ms, 15 * 60_000);

        // AA core hash falls back through envForNetwork: scoped name first.
        let env = env_from(&[("AA_CORE_HASH_TESTNET", &"cd".repeat(20))]);
        let policy = resolve_paymaster_policy("testnet", &env);
        assert_eq!(policy.aa_core_hash, format!("0x{}", "cd".repeat(20)));
    }

    #[test]
    fn network_resolution_prefers_the_payload() {
        let env = env_from(&[("MORPHEUS_NETWORK", "MainNet")]);
        assert_eq!(
            resolve_paymaster_network(&payload(&[("network", json!("testnet"))]), &env),
            "testnet"
        );
        assert_eq!(
            resolve_paymaster_network(&payload(&[("network", json!("  "))]), &env),
            "mainnet"
        );
        assert_eq!(
            resolve_paymaster_network(&payload(&[("network", json!("bogus"))]), &no_env),
            "testnet"
        );
    }

    #[test]
    fn verdict_payload_normalizes_the_alias_chain() {
        let value = payload(&[
            ("accountId", json!(" 0xby-alias ")),
            ("requester", json!("ignored")),
            ("dappId", json!("dapp")),
            ("targetContract", json!("0xt")),
            ("targetMethod", json!("m")),
            ("userop_target_contract", json!("0xuop")),
            ("userOpMethod", json!("um")),
            ("estimated_gas_units", json!(null)),
            ("estimatedGasUnits", json!("7")),
        ]);
        let normalized = normalize_verdict_payload(&value).expect("normalizes");
        assert_eq!(normalized.account_id, "0xby-alias");
        assert_eq!(normalized.dapp_id, "dapp");
        assert_eq!(normalized.target_contract, "0xt");
        assert_eq!(normalized.method, "m");
        assert_eq!(normalized.userop_target_contract, "0xuop");
        assert_eq!(normalized.userop_method, "um");
        assert_eq!(normalized.estimated_gas_units, 7.0);
        assert_eq!(normalized.target_chain, "neo_n3");

        // `??` keeps explicit 0 and empty strings; null skips to the alias.
        let zero = normalize_verdict_payload(&payload(&[("estimated_gas_units", json!(0))]))
            .expect("normalizes");
        assert_eq!(zero.estimated_gas_units, 0.0);
        let blank = normalize_verdict_payload(&payload(&[("estimated_gas_units", json!(""))]))
            .expect("normalizes");
        assert_eq!(blank.estimated_gas_units, 0.0);
    }

    #[test]
    fn unsupported_target_chain_throws_like_normalize() {
        let error = normalize_verdict_payload(&payload(&[("target_chain", json!("solana"))]))
            .expect_err("throws");
        assert_eq!(error, "unsupported target_chain: solana");

        // `neox` is a supported chain value but never neo_n3.
        let normalized = normalize_verdict_payload(&payload(&[("target_chain", json!(" NeoX "))]))
            .expect("normalizes");
        assert_eq!(normalized.target_chain, "neox");
    }

    #[test]
    fn gas_units_gate_uses_the_direct_field() {
        let env = enabled_env();
        let evaluation = evaluate_paymaster_authorization(
            &env,
            &payload(&[("estimated_gas_units", json!(0))]),
            &no_rpc,
            NOW_MS,
            uuid_sequence("u"),
        )
        .expect("evaluates");
        assert_eq!(
            invalid(evaluation),
            json!({ "error": "estimated_gas_units must be a positive number" })
        );
        // String numbers pass Number(); garbage is NaN.
        let ok = evaluate_paymaster_authorization(
            &env,
            &payload(&[("estimated_gas_units", json!("5"))]),
            &no_rpc,
            NOW_MS,
            uuid_sequence("u"),
        )
        .expect("evaluates");
        assert_eq!(verdict(ok)["estimated_gas_units"], 5);
        let nan = evaluate_paymaster_authorization(
            &env,
            &payload(&[("estimated_gas_units", json!("abc"))]),
            &no_rpc,
            NOW_MS,
            uuid_sequence("u"),
        )
        .expect("evaluates");
        assert_eq!(
            invalid(nan)["error"],
            "estimated_gas_units must be a positive number"
        );
        // The direct field is not the ?? chain: null → Number(null) = 0.
        let null_direct = evaluate_paymaster_authorization(
            &env,
            &payload(&[
                ("estimated_gas_units", json!(null)),
                ("estimatedGasUnits", json!(9)),
            ]),
            &no_rpc,
            NOW_MS,
            uuid_sequence("u"),
        )
        .expect("evaluates");
        assert_eq!(
            invalid(null_direct)["error"],
            "estimated_gas_units must be a positive number"
        );
        // Absent → Number(undefined) = NaN.
        let absent = evaluate_paymaster_authorization(
            &env,
            &payload(&[]),
            &no_rpc,
            NOW_MS,
            uuid_sequence("u"),
        )
        .expect("evaluates");
        assert_eq!(
            invalid(absent)["error"],
            "estimated_gas_units must be a positive number"
        );
    }

    #[test]
    fn denial_reasons_fire_in_chain_order() {
        let env = env_from(&[
            ("MORPHEUS_PAYMASTER_TESTNET_ENABLED", "false"),
            ("MORPHEUS_PAYMASTER_TESTNET_MAX_GAS_UNITS", "10"),
            ("MORPHEUS_PAYMASTER_TESTNET_BLOCK_ACCOUNTS", "0xacc"),
        ]);
        let denied = |evaluation: PaymasterEvaluation| match evaluation {
            PaymasterEvaluation::Verdict(value) => {
                assert_eq!(value["approved"], false);
                assert_eq!(value["mode"], "paymaster_authorize");
                assert_eq!(value["policy"]["policy_id"], "testnet-default");
                value["reason"].as_str().expect("reason").to_string()
            }
            PaymasterEvaluation::Invalid(value) => panic!("unexpected invalid: {value}"),
        };

        // The gas gate precedes the disabled verdict (JS checks it first).
        assert_eq!(
            invalid(
                evaluate_paymaster_authorization(
                    &env,
                    &payload(&[]),
                    &no_rpc,
                    NOW_MS,
                    uuid_sequence("u")
                )
                .expect("evaluates")
            )["error"],
            "estimated_gas_units must be a positive number"
        );
        // Disabled fires before every field check.
        assert_eq!(
            denied(
                evaluate_paymaster_authorization(
                    &env,
                    &base_payload(),
                    &no_rpc,
                    NOW_MS,
                    uuid_sequence("u")
                )
                .expect("evaluates")
            ),
            "paymaster disabled for network"
        );

        let enabled = env_from(&[
            ("MORPHEUS_PAYMASTER_TESTNET_ENABLED", "1"),
            ("MORPHEUS_PAYMASTER_TESTNET_MAX_GAS_UNITS", "10"),
            ("MORPHEUS_PAYMASTER_TESTNET_BLOCK_ACCOUNTS", "0xacc"),
        ]);
        let evaluate = |env: &dyn Fn(&str) -> Option<String>, payload: &Json| {
            evaluate_paymaster_authorization(env, payload, &no_rpc, NOW_MS, uuid_sequence("u"))
                .expect("evaluates")
        };

        let gas = payload(&[
            ("estimated_gas_units", json!(11)),
            ("account_id", json!("0xa")),
            ("operation_hash", json!("op")),
            ("target_contract", json!("0xt")),
            ("method", json!("m")),
        ]);
        assert_eq!(
            denied(evaluate(&enabled, &gas)),
            "estimated gas exceeds network paymaster limit"
        );

        // Blocklist beats the allowlist chain; both are lowercase compares.
        assert_eq!(
            denied(evaluate(&enabled, &base_payload())),
            "account_id is blocklisted"
        );

        let no_account = payload(&[
            ("estimated_gas_units", json!(1)),
            ("operation_hash", json!("op")),
        ]);
        assert_eq!(
            denied(evaluate(&enabled, &no_account)),
            "account_id is required"
        );

        let neox = payload(&[
            ("estimated_gas_units", json!(1)),
            ("account_id", json!("0xa")),
            ("target_chain", json!("neox")),
        ]);
        assert_eq!(
            denied(evaluate(&enabled, &neox)),
            "paymaster currently supports neo_n3 only"
        );

        let no_op = payload(&[
            ("estimated_gas_units", json!(1)),
            ("account_id", json!("0xa")),
        ]);
        assert_eq!(
            denied(evaluate(&enabled, &no_op)),
            "operation_hash is required"
        );

        let no_target = payload(&[
            ("estimated_gas_units", json!(1)),
            ("account_id", json!("0xa")),
            ("operation_hash", json!("op")),
        ]);
        assert_eq!(
            denied(evaluate(&enabled, &no_target)),
            "target_contract is required"
        );

        let no_method = payload(&[
            ("estimated_gas_units", json!(1)),
            ("account_id", json!("0xa")),
            ("operation_hash", json!("op")),
            ("target_contract", json!("0xt")),
        ]);
        assert_eq!(denied(evaluate(&enabled, &no_method)), "method is required");

        // dapp gate: required only when the allow list is configured.
        let dapp_env = env_from(&[
            ("MORPHEUS_PAYMASTER_TESTNET_ENABLED", "true"),
            ("MORPHEUS_PAYMASTER_TESTNET_ALLOW_DAPPS", "known-dapp"),
        ]);
        let dappless = payload(&[
            ("estimated_gas_units", json!(1)),
            ("account_id", json!("0xa")),
            ("operation_hash", json!("op")),
            ("target_contract", json!("0xt")),
            ("method", json!("m")),
        ]);
        assert_eq!(
            denied(evaluate(&dapp_env, &dappless)),
            "dapp_id is required"
        );
        let wrong_dapp = payload(&[
            ("estimated_gas_units", json!(1)),
            ("account_id", json!("0xa")),
            ("dapp_id", json!("other")),
            ("operation_hash", json!("op")),
            ("target_contract", json!("0xt")),
            ("method", json!("m")),
        ]);
        assert_eq!(
            denied(evaluate(&dapp_env, &wrong_dapp)),
            "dapp_id is not allowlisted"
        );

        let target_env = env_from(&[
            ("MORPHEUS_PAYMASTER_TESTNET_ENABLED", "true"),
            ("MORPHEUS_PAYMASTER_TESTNET_ALLOW_TARGETS", "0xgood"),
        ]);
        assert_eq!(
            denied(evaluate(&target_env, &base_payload())),
            "target_contract is not allowlisted"
        );

        let method_env = env_from(&[
            ("MORPHEUS_PAYMASTER_TESTNET_ENABLED", "true"),
            ("MORPHEUS_PAYMASTER_TESTNET_ALLOW_METHODS", "burn"),
        ]);
        assert_eq!(
            denied(evaluate(&method_env, &base_payload())),
            "method is not allowlisted"
        );

        // allow_accounts non-empty flips to an allowlist check.
        let account_env = env_from(&[
            ("MORPHEUS_PAYMASTER_TESTNET_ENABLED", "true"),
            ("MORPHEUS_PAYMASTER_TESTNET_ALLOW_ACCOUNTS", "0xother"),
        ]);
        assert_eq!(
            denied(evaluate(&account_env, &base_payload())),
            "account_id is not allowlisted"
        );
    }

    #[test]
    fn approval_digest_pins_the_signed_fields() {
        let uuids = uuid_sequence("sp");
        let evaluation = evaluate_paymaster_authorization(
            &enabled_env(),
            &base_payload(),
            &no_rpc,
            NOW_MS,
            uuids,
        )
        .expect("evaluates");
        let value = verdict(evaluation);
        assert_eq!(value["approved"], true);
        assert_eq!(value["sponsorship_id"], "sp-1");
        assert_eq!(value["network"], "testnet");
        assert_eq!(value["policy_id"], "testnet-default");
        assert_eq!(value["expires_at"], "2023-11-14T22:28:20.000Z");
        assert_eq!(value["policy"]["max_gas_units"], 0);
        assert_eq!(value["onchain_policy"], Json::Null);

        // The digest is sha256 over stableStringify of exactly these fields —
        // dapp_id '' is present, estimated_gas_units is the ?? chain value.
        let expected = {
            let digest_input = json!({
                "network": "testnet",
                "policy_id": "testnet-default",
                "account_id": "0xacc",
                "dapp_id": "",
                "target_contract": "0xtarget",
                "method": "transfer",
                "estimated_gas_units": 5,
                "operation_hash": "op",
            });
            sha256_hex(stable_stringify(&digest_input).as_bytes())
        };
        assert_eq!(value["approval_digest"], expected);
        assert_eq!(value["approval_digest"].as_str().expect("hex").len(), 64);
    }

    /// Stub RPC transport: matches (contract, method) and replies from a table.
    fn rpc_fixture(
        handlers: HashMap<(String, String), Json>,
    ) -> impl Fn(&HttpRequest) -> Result<HttpResponse, String> {
        move |request: &HttpRequest| {
            let body: Json =
                serde_json::from_slice(request.body.as_deref().expect("body")).expect("json");
            assert_eq!(body["jsonrpc"], "2.0");
            assert_eq!(body["id"], 1);
            assert_eq!(body["method"], "invokefunction");
            assert_eq!(request.method, "POST");
            assert_eq!(request.timeout_ms, 15_000);
            let params = body["params"].as_array().expect("params");
            let contract = params[0].as_str().expect("contract").to_string();
            let method = params[1].as_str().expect("method").to_string();
            let reply = handlers
                .get(&(contract, method))
                .cloned()
                .expect("fixture handles this call");
            let encoded = serde_json::to_vec(&reply).expect("reply serializes");
            Ok(HttpResponse {
                status: 200,
                headers: Vec::new(),
                body: encoded,
            })
        }
    }

    fn hook_reply(hash_value: &str) -> Json {
        json!({ "result": { "stack": [ { "type": "Hash160", "value": hash_value } ] } })
    }

    fn whitelist_hash() -> String {
        format!("0x{}", "ab".repeat(20))
    }

    fn multi_hash() -> String {
        format!("0x{}", "cd".repeat(20))
    }

    fn aa_env() -> impl Fn(&str) -> Option<String> {
        env_from(&[
            ("MORPHEUS_PAYMASTER_TESTNET_ENABLED", "true"),
            ("MORPHEUS_PAYMASTER_TESTNET_NEO_RPC_URL", "http://rpc.test"),
            ("MORPHEUS_PAYMASTER_TESTNET_AA_CORE_HASH", &"11".repeat(20)),
            (
                "MORPHEUS_PAYMASTER_TESTNET_WHITELIST_HOOK_HASH",
                whitelist_hash().as_str(),
            ),
        ])
    }

    fn uop_payload() -> Json {
        payload(&[
            ("account_id", json!("0xacc")),
            ("operation_hash", json!("op")),
            ("target_contract", json!("0xtarget")),
            ("method", json!("transfer")),
            ("estimated_gas_units", json!(5)),
            ("userop_target_contract", json!("0xuserop")),
        ])
    }

    #[test]
    fn onchain_allow_approves_with_the_hook_summary() {
        let transport = rpc_fixture(HashMap::from([
            (
                (format!("0x{}", "11".repeat(20)), "getHook".to_string()),
                hook_reply(&whitelist_hash()),
            ),
            (
                (whitelist_hash(), "isWhitelisted".to_string()),
                json!({ "result": { "stack": [ { "type": "Boolean", "value": true } ] } }),
            ),
        ]));
        let evaluation = evaluate_paymaster_authorization(
            &aa_env(),
            &uop_payload(),
            &transport,
            NOW_MS,
            uuid_sequence("sp"),
        )
        .expect("evaluates");
        let value = verdict(evaluation);
        assert_eq!(value["onchain_policy"]["source"], "aa_hook");
        assert_eq!(value["onchain_policy"]["hook"], whitelist_hash());
        assert_eq!(value["approved"], true);
    }

    #[test]
    fn onchain_deny_lists_the_hook_verdict() {
        let transport = rpc_fixture(HashMap::from([
            (
                (format!("0x{}", "11".repeat(20)), "getHook".to_string()),
                hook_reply(&whitelist_hash()),
            ),
            (
                (whitelist_hash(), "isWhitelisted".to_string()),
                json!({ "result": { "stack": [ { "type": "Boolean", "value": false } ] } }),
            ),
        ]));
        let evaluation = evaluate_paymaster_authorization(
            &aa_env(),
            &uop_payload(),
            &transport,
            NOW_MS,
            uuid_sequence("sp"),
        )
        .expect("evaluates");
        let value = verdict(evaluation);
        assert_eq!(value["approved"], false);
        assert_eq!(
            value["reason"],
            "userop_target_contract is not allowlisted by AA hook"
        );
    }

    #[test]
    fn multi_hook_walks_gethooks_before_verdict() {
        let env = env_from(&[
            ("MORPHEUS_PAYMASTER_TESTNET_ENABLED", "true"),
            ("MORPHEUS_PAYMASTER_TESTNET_NEO_RPC_URL", "http://rpc.test"),
            ("MORPHEUS_PAYMASTER_TESTNET_AA_CORE_HASH", &"11".repeat(20)),
            (
                "MORPHEUS_PAYMASTER_TESTNET_MULTI_HOOK_HASH",
                multi_hash().as_str(),
            ),
            (
                "MORPHEUS_PAYMASTER_TESTNET_WHITELIST_HOOK_HASH",
                whitelist_hash().as_str(),
            ),
        ]);
        let transport = rpc_fixture(HashMap::from([
            (
                (format!("0x{}", "11".repeat(20)), "getHook".to_string()),
                hook_reply(&multi_hash()),
            ),
            (
                (multi_hash(), "getHooks".to_string()),
                json!({ "result": { "stack": [ { "type": "Array", "value": [
                    { "type": "ByteString", "value": "qq==".to_string() },
                    { "type": "Hash160", "value": whitelist_hash() },
                ] } ] } }),
            ),
            (
                (whitelist_hash(), "isWhitelisted".to_string()),
                json!({ "result": { "stack": [ { "type": "Boolean", "value": 1 } ] } }),
            ),
        ]));
        let evaluation = evaluate_paymaster_authorization(
            &env,
            &uop_payload(),
            &transport,
            NOW_MS,
            uuid_sequence("sp"),
        )
        .expect("evaluates");
        let value = verdict(evaluation);
        assert_eq!(value["onchain_policy"]["hook"], whitelist_hash());
        assert_eq!(value["approved"], true);
    }

    #[test]
    fn onchain_gaps_deny_with_the_contextual_reason() {
        // AA hashes set but no RPC URL: the hook policy was required, not checked.
        let env = env_from(&[
            ("MORPHEUS_PAYMASTER_TESTNET_ENABLED", "true"),
            ("MORPHEUS_PAYMASTER_TESTNET_AA_CORE_HASH", &"11".repeat(20)),
        ]);
        let evaluation = evaluate_paymaster_authorization(
            &env,
            &uop_payload(),
            &no_rpc,
            NOW_MS,
            uuid_sequence("sp"),
        )
        .expect("evaluates");
        assert_eq!(
            verdict(evaluation)["reason"],
            "required AA hook policy was not checked: aa on-chain policy not configured"
        );

        // RPC answers but the account hook is unknown.
        let transport = rpc_fixture(HashMap::from([(
            (format!("0x{}", "11".repeat(20)), "getHook".to_string()),
            hook_reply(&"99".repeat(20)),
        )]));
        let evaluation = evaluate_paymaster_authorization(
            &aa_env(),
            &uop_payload(),
            &transport,
            NOW_MS,
            uuid_sequence("sp"),
        )
        .expect("evaluates");
        assert_eq!(
            verdict(evaluation)["reason"],
            "required AA hook policy was not checked: aa whitelist hook not active for account"
        );

        // getHook returns a non-hash stack item.
        let transport = rpc_fixture(HashMap::from([(
            (format!("0x{}", "11".repeat(20)), "getHook".to_string()),
            json!({ "result": { "stack": [ { "type": "Integer", "value": "0" } ] } }),
        )]));
        let evaluation = evaluate_paymaster_authorization(
            &aa_env(),
            &uop_payload(),
            &transport,
            NOW_MS,
            uuid_sequence("sp"),
        )
        .expect("evaluates");
        assert_eq!(
            verdict(evaluation)["reason"],
            "required AA hook policy was not checked: aa account has no hook configured"
        );
    }

    #[test]
    fn rpc_failures_propagate_as_throws() {
        // data.error with a message throws it verbatim.
        let transport = rpc_fixture(HashMap::from([(
            (format!("0x{}", "11".repeat(20)), "getHook".to_string()),
            json!({ "error": { "message": "boom" }, "result": null }),
        )]));
        let error = evaluate_paymaster_authorization(
            &aa_env(),
            &uop_payload(),
            &transport,
            NOW_MS,
            uuid_sequence("sp"),
        )
        .expect_err("throws");
        assert_eq!(error, "boom");

        // A truthy error without a message falls back to the template.
        let transport = rpc_fixture(HashMap::from([(
            (format!("0x{}", "11".repeat(20)), "getHook".to_string()),
            json!({ "error": { "code": -100 }, "result": null }),
        )]));
        let error = evaluate_paymaster_authorization(
            &aa_env(),
            &uop_payload(),
            &transport,
            NOW_MS,
            uuid_sequence("sp"),
        )
        .expect_err("throws");
        assert_eq!(error, "invokefunction getHook failed");

        // Malformed JSON throws (response.json() SyntaxError).
        let broken = |_request: &HttpRequest| {
            Ok(HttpResponse {
                status: 502,
                headers: Vec::new(),
                body: b"<html>bad gateway</html>".to_vec(),
            })
        };
        let error = evaluate_paymaster_authorization(
            &aa_env(),
            &uop_payload(),
            &broken,
            NOW_MS,
            uuid_sequence("sp"),
        )
        .expect_err("throws");
        assert_eq!(error, "response body is not valid JSON");
    }

    #[test]
    fn stack_items_coerce_like_the_worker() {
        assert_eq!(stack_item_to_value(&Json::Null), Json::Null);
        assert_eq!(stack_item_to_value(&json!([1, 2])), Json::Null);
        // Boolean(item.value): any truthy value — including the string
        // "false" — is true; 0 and absent are false.
        assert_eq!(
            stack_item_to_value(&json!({ "type": "Boolean", "value": true })),
            json!(true)
        );
        assert_eq!(
            stack_item_to_value(&json!({ "type": "Boolean", "value": "false" })),
            json!(true)
        );
        assert_eq!(
            stack_item_to_value(&json!({ "type": "Boolean", "value": 0 })),
            json!(false)
        );
        assert_eq!(
            stack_item_to_value(&json!({ "type": "Boolean" })),
            json!(false)
        );
        // ByteString: base64 → lowercase hex; undecodable falls back to the
        // string source.
        assert_eq!(
            stack_item_to_value(&json!({ "type": "ByteString", "value": "AAEC" })),
            json!("000102")
        );
        assert_eq!(
            stack_item_to_value(&json!({ "type": "ByteString", "value": "not base64!!" })),
            json!("not base64!!")
        );
        assert_eq!(
            stack_item_to_value(&json!({ "type": "ByteString", "value": 0 })),
            json!("")
        );
        // Hash160: normalized, else empty.
        assert_eq!(
            stack_item_to_value(
                &json!({ "type": "Hash160", "value": format!("0x{}", "AB".repeat(20)) })
            ),
            json!(format!("0x{}", "ab".repeat(20)))
        );
        assert_eq!(
            stack_item_to_value(&json!({ "type": "Hash160", "value": "zz" })),
            json!("")
        );
        // Array/Struct recurse; a non-array value collapses to [].
        assert_eq!(
            stack_item_to_value(&json!({ "type": "Array", "value": [
                { "type": "Integer", "value": "42" },
                { "type": "Any" },
            ] })),
            json!(["42", null])
        );
        assert_eq!(
            stack_item_to_value(&json!({ "type": "Struct", "value": "flat" })),
            json!([])
        );
        // Default: value ?? null keeps 0 and ''.
        assert_eq!(
            stack_item_to_value(&json!({ "type": "Integer", "value": "0" })),
            json!("0")
        );
        assert_eq!(stack_item_to_value(&json!({ "type": "Any" })), Json::Null);
    }

    #[test]
    fn hex_hashes_normalize_like_normalize_hex_hash() {
        assert_eq!(
            normalize_hex_hash(Some(&json!(format!("0X{}", "AB".repeat(20))))),
            format!("0x{}", "ab".repeat(20))
        );
        assert_eq!(normalize_hex_hash(Some(&json!("zz"))), "");
        assert_eq!(
            normalize_hex_hash(Some(&json!(format!("0x{}", "ab".repeat(19))))),
            ""
        );
        assert_eq!(normalize_hex_hash(Some(&Json::Null)), "");
        assert_eq!(normalize_hex_hash(None), "");
        assert_eq!(normalize_hex_hash(Some(&json!(0))), "");
    }
}
