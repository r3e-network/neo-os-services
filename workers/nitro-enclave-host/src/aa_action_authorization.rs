//! Host-owned action-v4 authorization over one fixed, identity-checked RPC.
//! No request supplies an endpoint, expected chain identity, owner or snapshot.
use std::collections::BTreeMap;

use base64::{engine::general_purpose::STANDARD, Engine};
use neo_os_chain_n3::{rpc::NeoRpcClient, HttpTransport};
use neo_os_compute::neodid::{AaActionAuthorizationRequest, AaActionAuthorizationSnapshot};
use neo_os_compute::transport::HttpRequest;
use neo_os_core::config::{resolve_neo_n3_rpc_urls, EnvSource};
use neo_os_core::js_value::JsValue;
use neo_os_core::network_identity::{known_neo_n3_identity, known_network_registry};
use serde_json::{json, Value};

use crate::state::OracleIo;

const DENIED: &str = "trusted AA action authorization unavailable";
const MAX_INTEGER: &str =
    "57896044618658097711785492504343953926634992332820282019728792003956564819967";
fn denied() -> String {
    DENIED.to_string()
}

#[derive(Clone)]
struct Context {
    endpoint: String,
    magic: u32,
    genesis: String,
    core_display: String,
    verifier_display: String,
    core_raw: String,
    verifier_raw: String,
}
impl Context {
    fn from_overlay(overlay: &BTreeMap<String, String>) -> Result<Self, String> {
        let network = overlay
            .get("MORPHEUS_NETWORK")
            .map(String::as_str)
            .ok_or_else(denied)?;
        if !matches!(network, "mainnet" | "testnet") {
            return Err(denied());
        }
        let registry = known_network_registry(network).ok_or_else(denied)?;
        let identity = known_neo_n3_identity(network).ok_or_else(denied)?;
        let display = |path: &str| -> Result<String, String> {
            let text = registry
                .pointer(path)
                .and_then(Value::as_str)
                .ok_or_else(denied)?;
            raw_hash(text, 20)?;
            Ok(text.to_string())
        };
        let core_display = display("/neo_n3/contracts/abstract_account")?;
        let verifier_display = display("/neo_n3/aa_verifiers/social_recovery")?;
        let process = JsValue::from_json(&serde_json::to_value(overlay).map_err(|_| denied())?);
        let runtime: Value = match overlay.get("MORPHEUS_RUNTIME_CONFIG_JSON") {
            Some(text) => serde_json::from_str(text).map_err(|_| denied())?,
            None => json!({}),
        };
        let source = EnvSource::new(
            process.as_object().cloned().ok_or_else(denied)?,
            JsValue::from_json(&runtime)
                .as_object()
                .cloned()
                .ok_or_else(denied)?,
        );
        // Reuse the existing selected-network resolver, then freeze ONE URL.
        // Never fail over between identities during a snapshot read.
        let endpoint = resolve_neo_n3_rpc_urls(network, &source, &JsValue::from_json(registry))
            .map_err(|_| denied())?
            .first()
            .cloned()
            .ok_or_else(denied)?;
        let url = url::Url::parse(&endpoint).map_err(|_| denied())?;
        if url.scheme() != "https"
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
        {
            return Err(denied());
        }
        let to_raw = |display: &str| -> Result<String, String> {
            let mut bytes = raw_hash(display, 20)?;
            bytes.reverse();
            Ok(format!("0x{}", hex::encode(bytes)))
        };
        Ok(Self {
            endpoint,
            magic: identity.magic,
            genesis: identity.genesis_hash.clone(),
            core_raw: to_raw(&core_display)?,
            verifier_raw: to_raw(&verifier_display)?,
            core_display,
            verifier_display,
        })
    }
}

struct HostTransport<'a> {
    io: &'a dyn OracleIo,
    endpoint: &'a str,
}
impl HttpTransport for HostTransport<'_> {
    fn get(&self, _: &str) -> Result<(u16, String), String> {
        Err(denied())
    }
    fn post(&self, endpoint: &str, body: &str) -> Result<(u16, String), String> {
        if endpoint != self.endpoint {
            return Err(denied());
        }
        let response = self
            .io
            .fetch(&HttpRequest {
                url: endpoint.to_string(),
                method: "POST".to_string(),
                headers: vec![("content-type".to_string(), "application/json".to_string())],
                body: Some(body.as_bytes().to_vec()),
                timeout_ms: neo_os_chain_n3::rpc::RPC_TIMEOUT_MS,
                follow_redirects: false,
            })
            .map_err(|_| denied())?;
        if response.body.len() > 512 * 1024 {
            return Err(denied());
        }
        Ok((
            response.status,
            String::from_utf8(response.body).map_err(|_| denied())?,
        ))
    }
}

/// Overlay is captured by dispatch before entering the DID fold. The fold holds
/// its own read guard: taking that lock again here could deadlock behind a writer.
pub(crate) fn read(
    overlay: &BTreeMap<String, String>,
    io: &dyn OracleIo,
    request: &AaActionAuthorizationRequest,
) -> Result<AaActionAuthorizationSnapshot, String> {
    let context = Context::from_overlay(overlay)?;
    validate_request(&context, request, io.now_ms())?;
    let transport = HostTransport {
        io,
        endpoint: &context.endpoint,
    };
    let rpc =
        NeoRpcClient::new(transport, vec![context.endpoint.clone()], true).map_err(|_| denied())?;
    read_with_rpc(&context, &rpc, request, &|| io.now_ms()).map_err(|_| denied())
}

fn raw_hash(value: &str, length: usize) -> Result<Vec<u8>, String> {
    let raw = value.strip_prefix("0x").ok_or_else(denied)?;
    if raw.len() != length * 2
        || !raw
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    {
        return Err(denied());
    }
    let bytes = hex::decode(raw).map_err(|_| denied())?;
    if bytes.iter().all(|b| *b == 0) {
        return Err(denied());
    }
    Ok(bytes)
}
fn decimal(value: &str, positive: bool) -> Result<(), String> {
    if value.is_empty()
        || !value.bytes().all(|c| c.is_ascii_digit())
        || (value.starts_with('0') && value != "0")
        || (positive && value == "0")
        || value.len() > MAX_INTEGER.len()
        || (value.len() == MAX_INTEGER.len() && value > MAX_INTEGER)
    {
        return Err(denied());
    }
    Ok(())
}
fn validate_request(
    context: &Context,
    r: &AaActionAuthorizationRequest,
    now: u64,
) -> Result<(), String> {
    if r.aa_contract != context.core_raw || r.verifier_contract != context.verifier_raw {
        return Err(denied());
    }
    raw_hash(&r.account_id_raw, 20)?;
    raw_hash(&r.master_nullifier, 32)?;
    decimal(&r.authorization_epoch, true)?;
    decimal(&r.session_nonce, false)?;
    decimal(&r.expires_at, true)?;
    for text in [&r.network, &r.account_id] {
        if text.trim().is_empty() || text.len() > 255 {
            return Err(denied());
        }
    }
    if r.expires_at.parse::<u64>().map_err(|_| denied())? <= now {
        return Err(denied());
    }
    Ok(())
}
fn call<T: HttpTransport>(
    rpc: &NeoRpcClient<T>,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    rpc.call(method, params).map_err(|_| denied())
}
fn method(
    contract: &Value,
    name: &str,
    types: &[&str],
    returns: &str,
    safe: bool,
) -> Result<(), String> {
    let methods = contract
        .pointer("/manifest/abi/methods")
        .and_then(Value::as_array)
        .ok_or_else(denied)?;
    let found: Vec<_> = methods
        .iter()
        .filter(|m| m["name"].as_str() == Some(name))
        .collect();
    if found.len() != 1 {
        return Err(denied());
    }
    let m = found[0];
    let params = m["parameters"].as_array().ok_or_else(denied)?;
    if m["returntype"].as_str() != Some(returns)
        || m["safe"].as_bool() != Some(safe)
        || params.len() != types.len()
        || params
            .iter()
            .zip(types)
            .any(|(p, t)| p["type"].as_str() != Some(*t))
    {
        return Err(denied());
    }
    Ok(())
}
fn validated_root<T: HttpTransport>(rpc: &NeoRpcClient<T>) -> Result<(u32, String), String> {
    let heights = call(rpc, "getstateheight", json!([]))?;
    let index = heights["validatedrootindex"].as_u64().ok_or_else(denied)?;
    let local = heights["localrootindex"].as_u64().ok_or_else(denied)?;
    if index == 0 || index > u32::MAX as u64 || index > local {
        return Err(denied());
    }
    let root = call(rpc, "getstateroot", json!([index]))?;
    if root["index"].as_u64() != Some(index) {
        return Err(denied());
    }
    let text = root["roothash"].as_str().ok_or_else(denied)?;
    raw_hash(text, 32)?;
    Ok((index as u32, text.to_string()))
}
fn halt_item(value: &Value) -> Result<&Value, String> {
    if value["state"].as_str() != Some("HALT")
        || value.get("exception").is_some_and(|e| !e.is_null())
    {
        return Err(denied());
    }
    let stack = value["stack"].as_array().ok_or_else(denied)?;
    if stack.len() != 1 {
        return Err(denied());
    }
    Ok(&stack[0])
}
fn item_bytes(item: &Value) -> Result<Vec<u8>, String> {
    if !matches!(item["type"].as_str(), Some("ByteString" | "Buffer")) {
        return Err(denied());
    }
    let text = item["value"].as_str().ok_or_else(denied)?;
    let bytes = STANDARD.decode(text).map_err(|_| denied())?;
    if STANDARD.encode(&bytes) != text {
        return Err(denied());
    }
    Ok(bytes)
}
fn item_hash(item: &Value) -> Result<String, String> {
    let bytes = item_bytes(item)?;
    if bytes.len() != 20 || bytes.iter().all(|b| *b == 0) {
        return Err(denied());
    }
    Ok(format!("0x{}", hex::encode(bytes)))
}
fn item_text(item: &Value) -> Result<String, String> {
    let text = String::from_utf8(item_bytes(item)?).map_err(|_| denied())?;
    if text.trim().is_empty() || text.len() > 255 {
        return Err(denied());
    }
    Ok(text)
}
fn item_integer(item: &Value, positive: bool) -> Result<String, String> {
    if item["type"].as_str() != Some("Integer") {
        return Err(denied());
    }
    let text = item["value"].as_str().ok_or_else(denied)?;
    decimal(text, positive)?;
    Ok(text.to_string())
}
fn historic<T: HttpTransport>(
    rpc: &NeoRpcClient<T>,
    root: &str,
    contract: &str,
    name: &str,
    args: Value,
) -> Result<Value, String> {
    call(
        rpc,
        "invokefunctionhistoric",
        json!([root, contract, name, args]),
    )
}
fn read_with_rpc<T: HttpTransport>(
    context: &Context,
    rpc: &NeoRpcClient<T>,
    r: &AaActionAuthorizationRequest,
    clock: &dyn Fn() -> u64,
) -> Result<AaActionAuthorizationSnapshot, String> {
    let started = clock();
    validate_request(context, r, started)?;
    let version = call(rpc, "getversion", json!([]))?;
    if version.pointer("/protocol/network").and_then(Value::as_u64) != Some(context.magic as u64)
        || call(rpc, "getblockhash", json!([0]))?.as_str() != Some(context.genesis.as_str())
    {
        return Err(denied());
    }
    let core = call(rpc, "getcontractstate", json!([context.core_display]))?;
    let verifier = call(rpc, "getcontractstate", json!([context.verifier_display]))?;
    if core["hash"].as_str() != Some(context.core_display.as_str())
        || verifier["hash"].as_str() != Some(context.verifier_display.as_str())
    {
        return Err(denied());
    }
    method(&core, "getVerifier", &["Hash160"], "Hash160", true)?;
    method(&verifier, "getActionProtocolVersion", &[], "Integer", true)?;
    method(
        &verifier,
        "getActionAuthorization",
        &["Hash160", "ByteArray"],
        "Any",
        true,
    )?;
    method(
        &verifier,
        "submitActionTicketV4",
        &[
            "Hash160",
            "Hash160",
            "String",
            "Integer",
            "ByteArray",
            "Integer",
            "ByteArray",
            "ByteArray",
        ],
        "Void",
        false,
    )?;
    let (root_height, root) = validated_root(rpc)?;
    // Header time is tied to THIS validated index, never a latest header.
    let header = call(rpc, "getblockheader", json!([root_height, 1]))?;
    if header["index"].as_u64() != Some(root_height as u64) {
        return Err(denied());
    }
    let root_time = header["time"]
        .as_u64()
        .filter(|v| *v > 0)
        .ok_or_else(denied)?;
    let anchored = clock();
    if anchored < started
        || anchored
            .checked_sub(root_time)
            .is_none_or(|age| age > neo_os_chain_n3::rpc::RPC_TIMEOUT_MS)
    {
        return Err(denied());
    }
    validate_request(context, r, anchored)?;
    let account =
        json!({"type":"ByteArray","value":STANDARD.encode(raw_hash(&r.account_id_raw,20)?)});
    let installed = historic(
        rpc,
        &root,
        &context.core_display,
        "getVerifier",
        json!([account]),
    )?;
    let installed = item_hash(halt_item(&installed)?)?;
    if installed != context.verifier_raw {
        return Err(denied());
    }
    let result = historic(
        rpc,
        &root,
        &context.verifier_display,
        "getActionAuthorization",
        json!([
            account, {"type":"ByteArray","value":STANDARD.encode(raw_hash(&r.master_nullifier,32)?)}
        ]),
    )?;
    let item = halt_item(&result)?;
    if !matches!(item["type"].as_str(), Some("Array" | "Struct")) {
        return Err(denied());
    }
    let fields = item["value"].as_array().ok_or_else(denied)?;
    if fields.len() != 9 || item_integer(&fields[0], true)? != "4" {
        return Err(denied());
    }
    let core = item_hash(&fields[1])?;
    let verifier = item_hash(&fields[2])?;
    let owner = item_hash(&fields[3])?;
    let network = item_text(&fields[4])?;
    let account_id = item_text(&fields[5])?;
    let epoch = item_integer(&fields[6], true)?;
    let nonce = item_integer(&fields[7], false)?;
    if core != context.core_raw
        || verifier != installed
        || network != r.network
        || account_id != r.account_id
        || epoch != r.authorization_epoch
        || nonce != r.session_nonce
        || fields[8]["type"].as_str() != Some("Boolean")
        || fields[8]["value"].as_bool() != Some(true)
    {
        return Err(denied());
    }
    // Bound staleness by the existing RPC timeout, using only trusted host time.
    // Later revocations are also enforced by AA's epoch/nonce consumption checks.
    let now = clock();
    if now < anchored
        || now
            .checked_sub(root_time)
            .is_none_or(|age| age > neo_os_chain_n3::rpc::RPC_TIMEOUT_MS)
    {
        return Err(denied());
    }
    validate_request(context, r, now)?;
    Ok(AaActionAuthorizationSnapshot {
        protocol_version: 4,
        vm_state: "HALT".into(),
        canonical_core: core,
        installed_verifier: installed,
        core_state_root: root.clone(),
        verifier_state_root: root,
        account_id_raw: r.account_id_raw.clone(),
        network,
        account_id,
        owner,
        master_nullifier: r.master_nullifier.clone(),
        authorization_epoch: epoch,
        session_nonce: nonce,
        observed_time_ms: now.to_string(),
        action_allowed: true,
    })
}

#[cfg(test)]
#[path = "../tests/unit/aa_action_authorization.rs"]
mod tests;
