//! Authoritative on-chain delivery for prepared oracle fulfillments.
//!
//! The relayer owns the complete commit protocol:
//!
//! 1. ask the measured Rust host to compute and sign one result;
//! 2. recompute the bound fulfillment digest locally;
//! 3. construct the target-chain `fulfillRequest` transaction;
//! 4. ask the updater custody role to policy-check and sign that transaction;
//! 5. broadcast and wait for a concrete Neo N3 HALT or NeoX status-1 receipt.
//!
//! A worker HTTP 200, a custody signature, or a mempool acceptance is never a
//! successful delivery by itself.  Only the final confirmation produces a
//! [`DeliveryReceipt`].  This makes crash retries safe: the kernel settles a
//! request at most once and a repeated transaction is classified as already
//! fulfilled instead of being recorded as a second success.

use neo_os_chain_evm::{
    build_neox_digest, decode_signed_eip1559, eip191_message_hash, encode_fulfill_request_calldata,
    normalize_neox_revert, recover_eip191_address, EvmCustodyClient, EvmCustodySettings,
    EvmRpcClient, EvmWaiter, Fulfillment as EvmFulfillment, HttpTransport as EvmHttpTransport,
    UnsignedEip1559,
};
use neo_os_chain_n3::custody::{CustodyClient, CustodyConnection};
use neo_os_chain_n3::rpc::NeoRpcClient;
use neo_os_chain_n3::tx::{
    build_sign_and_broadcast, confirm_fulfill_execution, resolve_signer, BroadcastOptions,
    NonceSource, Waiter, DEFAULT_FULFILL_CONFIRM_TIMEOUT_MS,
};
use neo_os_chain_n3::HttpTransport as N3HttpTransport;
use neo_os_core::digest::{build_fulfillment_digest_bytes, FulfillmentOptions};
use neo_os_core::js_value::{JsObject, JsValue};
use neo_os_core::n3_tx::{create_invoke_script, ContractParam};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::config::RelayerConfig;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DeliveryReceipt {
    pub request_id: String,
    pub tx_hash: String,
    pub vm_state: String,
    pub target_chain: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exception: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PreparedFulfillment {
    request_id: String,
    request_type: String,
    app_id: String,
    module_id: String,
    operation: String,
    success: bool,
    result: String,
    result_bytes_base64: String,
    result_bytes_hex: String,
    error: String,
    signature: String,
    public_key: String,
}

/// Execute the authoritative delivery for either chain. Neo N3 uses one
/// transaction-signing updater key. NeoX keeps the EIP-191 verifier and the
/// EIP-1559 updater as distinct custody identities and validates both before
/// broadcast.
pub fn deliver_event<T, N, W>(
    config: &RelayerConfig,
    chain: &str,
    event: &JsValue,
    transport: &T,
    nonce_source: &N,
    waiter: &W,
) -> Result<DeliveryReceipt, String>
where
    T: N3HttpTransport + EvmHttpTransport,
    N: NonceSource,
    W: Waiter,
{
    match chain {
        "neo_n3" => deliver_neo_n3(config, event, transport, nonce_source, waiter),
        "neox" => deliver_neox(config, event, transport, nonce_source, waiter),
        other => Err(format!("unsupported delivery chain {other}")),
    }
}

fn deliver_neo_n3<T, N, W>(
    config: &RelayerConfig,
    event: &JsValue,
    transport: &T,
    nonce_source: &N,
    waiter: &W,
) -> Result<DeliveryReceipt, String>
where
    T: N3HttpTransport + EvmHttpTransport,
    N: NonceSource,
    W: Waiter,
{
    let n3 = object_at(&config.raw, "neo_n3")?;
    let nitro = object_at(&config.raw, "nitro")?;

    let oracle_contract = required_string(n3, "oracleContract", "Neo N3 oracle contract")?;
    let contract_hash = decode_hash160(&oracle_contract)
        .ok_or_else(|| "Neo N3 oracle contract must be a 20-byte hex script hash".to_string())?;
    let _network_magic = n3
        .get("networkMagic")
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .ok_or_else(|| "Neo N3 network magic is not configured".to_string())?;
    let rpc_urls = string_array(n3.get("rpcUrls"));
    if rpc_urls.is_empty() {
        return Err("Neo N3 RPC URLs are not configured".to_string());
    }

    let custody_url = required_string(nitro, "custodyUrl", "custody signer service URL")?;
    let custody_token = required_string(nitro, "custodyToken", "custody signer service token")?;
    let custody_timeout = nitro
        .get("timeoutMs")
        .and_then(Value::as_u64)
        .filter(|value| *value > 0);
    let connection = CustodyConnection::new(custody_url, custody_token, custody_timeout)?;
    let updater_key_id = n3
        .get("custodyKeyIds")
        .and_then(Value::as_object)
        .and_then(|keys| keys.get("updater"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            "Neo N3 custody updater key is not configured (SIGNER_ROLE_UPDATER_KEY_ID)".to_string()
        })?;
    let prepared = prepare_in_enclave(config, "neo_n3", event, nitro, transport, nonce_source)?;
    let custody = CustodyClient::new(transport, connection);
    let updater = resolve_signer(&custody, updater_key_id)?;
    let request_id = prepared.request_id.parse::<i64>().map_err(|_| {
        "Neo N3 request id is outside the supported signed 64-bit range".to_string()
    })?;
    let result_hex = if prepared.result_bytes_base64.trim().is_empty() {
        hex::encode(prepared.result.as_bytes())
    } else {
        hex::encode(neo_os_core::base64::decode_lenient(
            &prepared.result_bytes_base64,
        ))
    };
    let signature = strip_hex_prefix(&prepared.signature);
    if signature.is_empty()
        || !signature.len().is_multiple_of(2)
        || !signature.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("enclave fulfillment returned an invalid verification signature".to_string());
    }

    let script = create_invoke_script(
        &contract_hash,
        "fulfillRequest",
        &[
            ContractParam::Integer(request_id),
            ContractParam::Boolean(prepared.success),
            ContractParam::HexBytes(result_hex),
            ContractParam::String(prepared.error.clone()),
            ContractParam::HexBytes(signature.to_string()),
        ],
    )
    .map_err(|error| format!("Neo N3 fulfillRequest script could not be encoded: {error}"))?;

    // Production resolves and classifies every configured RPC address. Unit
    // tests use an injected in-memory transport with `.example` URLs and never
    // perform DNS, so the network-level guard is disabled only in test builds.
    let rpc = NeoRpcClient::new(transport, rpc_urls, !cfg!(test))?;
    let request_for_error = prepared.request_id.clone();
    let options = BroadcastOptions {
        label: "Neo N3 fulfillRequest",
        system_fee_headroom: true,
        build_test_invoke_fault_error: Some(Box::new(move |exception| {
            format!(
                "Neo N3 fulfillRequest test invoke faulted for request {}: {}",
                request_for_error,
                if exception.trim().is_empty() {
                    "unknown error"
                } else {
                    exception
                }
            )
        })),
        ensure_fee_balance: None,
    };
    let broadcast =
        build_sign_and_broadcast(&rpc, &custody, &updater, nonce_source, &script, &options)?;
    let timeout_ms = n3
        .get("fulfillConfirmTimeoutMs")
        .and_then(value_u64)
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_FULFILL_CONFIRM_TIMEOUT_MS);
    let outcome = confirm_fulfill_execution(
        &rpc,
        waiter,
        &prepared.request_id,
        &broadcast.tx_hash,
        "fulfillRequest",
        timeout_ms,
        true,
    )?;

    Ok(DeliveryReceipt {
        request_id: format!("relayer:n3:fulfill:{}", prepared.request_id),
        tx_hash: broadcast.tx_hash,
        vm_state: outcome.vm_state,
        target_chain: "neo_n3".to_string(),
        exception: outcome.exception,
    })
}

struct EvmWaiterBridge<'a, W>(&'a W);

impl<W: neo_os_chain_n3::tx::Waiter> EvmWaiter for EvmWaiterBridge<'_, W> {
    fn now_ms(&self) -> u64 {
        self.0.now_ms()
    }

    fn sleep(&self, duration: std::time::Duration) {
        self.0
            .sleep(duration.as_millis().try_into().unwrap_or(u64::MAX));
    }
}

fn deliver_neox<T, N, W>(
    config: &RelayerConfig,
    event: &JsValue,
    transport: &T,
    nonce_source: &N,
    waiter: &W,
) -> Result<DeliveryReceipt, String>
where
    T: N3HttpTransport + EvmHttpTransport,
    N: NonceSource,
    W: neo_os_chain_n3::tx::Waiter,
{
    let neox = object_at(&config.raw, "neox")?;
    let nitro = object_at(&config.raw, "nitro")?;
    let chain_id = neox
        .get("chainId")
        .and_then(value_u64)
        .filter(|value| *value > 0)
        .ok_or_else(|| "NeoX chain id is not configured".to_string())?;
    let oracle_contract = required_string(neox, "oracleContract", "NeoX oracle contract")?;
    let oracle_address = decode_evm_address(&oracle_contract)
        .ok_or_else(|| "NeoX oracle contract must be a 20-byte EVM address".to_string())?;
    let oracle_contract = format!("0x{}", hex::encode(oracle_address));
    let rpc_url = required_string(neox, "rpcUrl", "NeoX primary RPC URL")?;
    let rpc_urls = string_array(neox.get("rpcUrls"));

    let custody_url = required_string(nitro, "custodyUrl", "custody signer service URL")?;
    let custody_token = required_string(nitro, "custodyToken", "custody signer service token")?;
    let custody_timeout = nitro
        .get("timeoutMs")
        .and_then(value_u64)
        .filter(|value| *value > 0);
    let key_ids = neox
        .get("custodyKeyIds")
        .and_then(Value::as_object)
        .ok_or_else(|| "NeoX custody key ids are not configured".to_string())?;
    let updater_key_id = required_string(key_ids, "updater", "NeoX updater custody key id")?;
    let verifier_key_id = required_string(key_ids, "verifier", "NeoX verifier custody key id")?;
    if updater_key_id == verifier_key_id {
        return Err("NeoX verifier and updater custody roles must use different keys".to_string());
    }
    let custody = EvmCustodyClient::new(
        transport,
        EvmCustodySettings::new(&custody_url, &custody_token, custody_timeout)?,
    );
    let updater = custody.key_info(&updater_key_id)?;
    let verifier = custody.key_info(&verifier_key_id)?;
    let updater_address = decode_evm_address(&updater.address)
        .ok_or_else(|| "NeoX updater custody identity returned an invalid address".to_string())?;
    if updater.chain_id != chain_id || verifier.chain_id != chain_id {
        return Err("NeoX custody updater/verifier key chain id mismatch".to_string());
    }
    if updater.address.eq_ignore_ascii_case(&verifier.address) {
        return Err(
            "NeoX verifier and updater custody roles resolve to the same account".to_string(),
        );
    }

    let prepared = prepare_in_enclave(config, "neox", event, nitro, transport, nonce_source)?;
    let semantic = EvmFulfillment {
        request_id: prepared.request_id.clone(),
        app_id: prepared.app_id.clone(),
        module_id: prepared.module_id.clone(),
        operation: prepared.operation.clone(),
        success: prepared.success,
        error: prepared.error.clone(),
    };
    let digest = build_neox_digest(
        chain_id,
        &oracle_contract,
        &semantic,
        &prepared.result_bytes_hex,
    )
    .map_err(|error| format!("NeoX fulfillment digest could not be recomputed: {error}"))?;
    let message_hash = eip191_message_hash(&digest);
    if !strip_hex_prefix(&prepared.public_key)
        .eq_ignore_ascii_case(strip_hex_prefix(&verifier.public_key))
    {
        return Err("NeoX measured fulfillment returned a different verifier identity".to_string());
    }
    let recovered = recover_eip191_address(&message_hash, &prepared.signature)?;
    if !format!("0x{}", hex::encode(recovered)).eq_ignore_ascii_case(&verifier.address) {
        return Err(
            "NeoX fulfillment verifier signature does not recover to the pinned verifier key"
                .to_string(),
        );
    }
    let calldata = encode_fulfill_request_calldata(
        &prepared.request_id,
        prepared.success,
        &prepared.result_bytes_hex,
        &prepared.error,
        &prepared.signature,
    )
    .map_err(|error| format!("NeoX fulfillRequest calldata could not be encoded: {error}"))?;
    let calldata_hex = format!("0x{}", hex::encode(&calldata));
    let rpc = EvmRpcClient::new(rpc_url, rpc_urls, transport);
    let tx_nonce = rpc
        .transaction_count(&updater.address)
        .map_err(|error| format!("NeoX updater nonce lookup failed: {error}"))?;
    let estimate = rpc
        .estimate_gas(&updater.address, &oracle_contract, &calldata_hex)
        .map_err(|error| normalize_neox_revert("", &error.to_string()))?;
    let gas_limit = estimate
        .checked_mul(2)
        .filter(|value| *value > 0)
        .ok_or_else(|| "NeoX fulfillRequest gas limit overflowed".to_string())?;
    let gas_price = rpc
        .gas_price()
        .map_err(|error| format!("NeoX gas price lookup failed: {error}"))?;
    let priority_fee = rpc
        .max_priority_fee_per_gas()
        .map_err(|error| format!("NeoX priority fee lookup failed: {error}"))?;
    let max_fee = gas_price
        .checked_mul(2)
        .and_then(|value| value.checked_add(priority_fee))
        .ok_or_else(|| "NeoX fulfillRequest fee overflowed".to_string())?;
    let unsigned = UnsignedEip1559 {
        chain_id,
        nonce: tx_nonce,
        max_priority_fee_per_gas: priority_fee,
        max_fee_per_gas: max_fee,
        gas_limit,
        to: oracle_address,
        value: [0u8; 32],
        data: calldata,
    };
    let expected_signing_hash = format!("0x{}", hex::encode(unsigned.signing_hash()));
    let signing_request_id = format!(
        "relayer:neox:fulfill:{}:{}:{}",
        prepared.request_id,
        tx_nonce,
        &expected_signing_hash[2..18]
    );
    let signed = custody.sign_transaction(
        &updater_key_id,
        chain_id,
        &unsigned.encode_hex(),
        &signing_request_id,
    )?;
    if !signed.address.eq_ignore_ascii_case(&updater.address) {
        return Err("NeoX custody transaction response changed updater identity".to_string());
    }
    let decoded = decode_signed_eip1559(&signed.signed_transaction)?;
    if decoded.chain_id != chain_id
        || decoded.nonce != tx_nonce
        || decoded.max_priority_fee_per_gas != priority_fee
        || decoded.max_fee_per_gas != max_fee
        || decoded.gas_limit != gas_limit
        || decoded.to != oracle_address
        || decoded.value.iter().any(|byte| *byte != 0)
        || decoded.data != unsigned.data
        || decoded.signing_hash != unsigned.signing_hash()
        || decoded.from != updater_address
    {
        return Err(
            "custody-signed NeoX fulfillRequest transaction differs from the approved plan"
                .to_string(),
        );
    }
    if !signed.digest.eq_ignore_ascii_case(&decoded.tx_hash) {
        return Err("NeoX custody transaction response changed the signed transaction hash".into());
    }
    let node_hash = rpc
        .send_raw_transaction(&signed.signed_transaction)
        .map_err(|error| format!("NeoX fulfillRequest broadcast failed: {error}"))?;
    if !node_hash.eq_ignore_ascii_case(&decoded.tx_hash) {
        return Err(format!(
            "NeoX RPC returned transaction hash {node_hash}, locally signed hash is {}",
            decoded.tx_hash
        ));
    }
    let timeout_ms = neox
        .get("confirmTimeoutMs")
        .and_then(value_u64)
        .filter(|value| *value > 0)
        .unwrap_or(45_000);
    let receipt = rpc
        .wait_for_receipt(&EvmWaiterBridge(waiter), &decoded.tx_hash, timeout_ms)
        .map_err(|error| format!("NeoX fulfillRequest confirmation failed: {error}"))?;
    Ok(DeliveryReceipt {
        request_id: format!("relayer:neox:fulfill:{}", prepared.request_id),
        tx_hash: receipt.tx_hash,
        vm_state: "HALT".to_string(),
        target_chain: "neox".to_string(),
        exception: None,
    })
}

fn prepare_in_enclave<T, N>(
    config: &RelayerConfig,
    chain: &str,
    event: &JsValue,
    nitro: &serde_json::Map<String, Value>,
    transport: &T,
    nonce_source: &N,
) -> Result<PreparedFulfillment, String>
where
    T: N3HttpTransport + EvmHttpTransport,
    N: NonceSource,
{
    if !nitro
        .get("enclaveFulfill")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Err(
            "authoritative Rust fulfillment requires MORPHEUS_RELAYER_ENCLAVE_FULFILL=true"
                .to_string(),
        );
    }

    let event_object = event
        .as_object()
        .ok_or_else(|| "oracle request event must be an object".to_string())?;
    let request_id = event_field(event_object, "requestId");
    let request_type = event_field(event_object, "requestType");
    let app_id = event_field(event_object, "appId");
    let module_id = event_field(event_object, "moduleId");
    let operation = event_field(event_object, "operation");
    if request_id.trim().is_empty() || request_type.trim().is_empty() {
        return Err("oracle request event is missing requestId or requestType".to_string());
    }
    for (name, value) in [
        ("requestType", request_type.as_str()),
        ("appId", app_id.as_str()),
        ("moduleId", module_id.as_str()),
        ("operation", operation.as_str()),
    ] {
        if value.chars().any(char::is_whitespace) {
            return Err(format!(
                "invalid identifier: request {request_id} field {name} contains whitespace"
            ));
        }
    }

    let payload_text = {
        let direct = event_field(event_object, "payloadText");
        if direct.is_empty() {
            event_field(event_object, "payload")
        } else {
            direct
        }
    };
    let mut payload = serde_json::from_str::<Value>(&payload_text).unwrap_or_else(|_| json!({}));
    if !payload.is_object() {
        payload = json!({});
    }
    if let Value::Object(payload) = &mut payload {
        for (wire, event_name) in [
            ("requester", "requester"),
            ("callback_contract", "callbackContract"),
            ("callback_method", "callbackMethod"),
        ] {
            let value = event_field(event_object, event_name);
            if !value.is_empty() && !payload.contains_key(wire) {
                payload.insert(wire.to_string(), Value::String(value));
            }
        }
    }

    let chain_context = match chain {
        "neo_n3" => {
            let n3 = object_at(&config.raw, "neo_n3")?;
            json!({
                "app_id": app_id,
                "module_id": module_id,
                "operation": operation,
                "contract_script_hash": n3.get("oracleContract").cloned().unwrap_or(Value::Null),
                "network_magic": n3.get("networkMagic").cloned().unwrap_or(Value::Null),
            })
        }
        "neox" => {
            let neox = object_at(&config.raw, "neox")?;
            json!({
                "app_id": app_id,
                "module_id": module_id,
                "operation": operation,
                "oracle_contract": neox.get("oracleContract").cloned().unwrap_or(Value::Null),
                "chain_id": neox.get("chainId").cloned().unwrap_or(Value::Null),
            })
        }
        other => return Err(format!("unsupported measured fulfillment chain {other}")),
    };
    let nonce = format!(
        "{:08x}{:08x}{:08x}{:08x}",
        nonce_source.nonce(),
        nonce_source.nonce(),
        nonce_source.nonce(),
        nonce_source.nonce()
    );
    let body = json!({
        "chain": chain,
        "network": config.network,
        "request_type": request_type,
        "request_id": request_id,
        "payload": payload,
        "payload_text": payload_text,
        "fulfillment_context": chain_context,
        "nonce": nonce,
    });

    let base = nitro
        .get("enclaveFulfillUrl")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| {
            nitro
                .get("apiUrl")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
        })
        .ok_or_else(|| "Rust enclave fulfillment URL is not configured".to_string())?;
    let url = service_endpoint(base, "/oracle/fulfill")?;
    let token = nitro
        .get("token")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let timeout_ms = nitro
        .get("timeoutMs")
        .and_then(Value::as_u64)
        .filter(|value| *value > 0)
        .unwrap_or(10_000);
    let body_text = body.to_string();
    let (status, text) = if token.is_empty() {
        N3HttpTransport::post(transport, &url, &body_text)
    } else {
        N3HttpTransport::post_with_bearer(transport, &url, token, timeout_ms, &body_text)
    }
    .map_err(|error| format!("Rust enclave fulfillment request failed: {error}"))?;
    let response: Value = serde_json::from_str(&text)
        .map_err(|_| format!("Rust enclave fulfillment returned non-JSON (HTTP {status})"))?;
    if !(200..300).contains(&status) {
        let detail = response
            .get("error")
            .or_else(|| response.get("message"))
            .and_then(Value::as_str)
            .unwrap_or("enclave fulfillment failed");
        return Err(format!(
            "Rust enclave fulfillment failed with HTTP {status}: {detail}"
        ));
    }
    if response.get("nonce").and_then(Value::as_str) != Some(nonce.as_str()) {
        return Err("Rust enclave fulfillment nonce binding mismatch".to_string());
    }

    let prepared = PreparedFulfillment {
        request_id: request_id.clone(),
        request_type: request_type.clone(),
        app_id: app_id.clone(),
        module_id: module_id.clone(),
        operation: operation.clone(),
        success: response
            .get("success")
            .and_then(Value::as_bool)
            .ok_or_else(|| "Rust enclave fulfillment response is missing success".to_string())?,
        result: response
            .get("result")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        result_bytes_base64: response
            .get("result_bytes_base64")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        result_bytes_hex: response
            .get("result_bytes_hex")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        error: response
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        signature: required_string_value(&response, "signature", "verification signature")?,
        public_key: response
            .get("public_key")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
    };

    let (expected_digest, returned_digest) = match chain {
        "neo_n3" => {
            let n3 = object_at(&config.raw, "neo_n3")?;
            let options = FulfillmentOptions {
                chain: Some("neo_n3".to_string()),
                app_id: prepared.app_id.clone(),
                module_id: prepared.module_id.clone(),
                operation: prepared.operation.clone(),
                contract_script_hash: n3
                    .get("oracleContract")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                network_magic: n3.get("networkMagic").and_then(Value::as_f64),
            };
            let digest = hex::encode(
                build_fulfillment_digest_bytes(
                    &JsValue::Str(prepared.request_id.clone()),
                    &prepared.request_type,
                    prepared.success,
                    &prepared.result,
                    &prepared.error,
                    &prepared.result_bytes_base64,
                    &options,
                )
                .map_err(|error| format!("fulfillment digest could not be recomputed: {error}"))?,
            );
            let returned = response
                .get("fulfillment_digest_hex")
                .and_then(Value::as_str)
                .map(strip_hex_prefix)
                .unwrap_or("")
                .to_ascii_lowercase();
            (digest, returned)
        }
        "neox" => {
            if response.get("chain").and_then(Value::as_str) != Some("neox") {
                return Err("Rust enclave NeoX fulfillment response changed chain".to_string());
            }
            for (field, expected) in [
                ("request_id", prepared.request_id.as_str()),
                ("app_id", prepared.app_id.as_str()),
                ("module_id", prepared.module_id.as_str()),
                ("operation", prepared.operation.as_str()),
            ] {
                if response.get(field).and_then(Value::as_str) != Some(expected) {
                    return Err(format!(
                        "Rust enclave NeoX fulfillment response changed {field}"
                    ));
                }
            }
            if decode_hex_bytes(&prepared.result_bytes_hex).is_none() {
                return Err(
                    "Rust enclave NeoX fulfillment response has invalid result_bytes_hex"
                        .to_string(),
                );
            }
            if prepared.public_key.trim().is_empty() {
                return Err(
                    "Rust enclave NeoX fulfillment response omitted verifier public key"
                        .to_string(),
                );
            }
            let neox = object_at(&config.raw, "neox")?;
            let chain_id = neox
                .get("chainId")
                .and_then(value_u64)
                .ok_or_else(|| "NeoX chain id is not configured".to_string())?;
            let oracle = required_string(neox, "oracleContract", "NeoX oracle contract")?;
            let fulfillment = EvmFulfillment {
                request_id: prepared.request_id.clone(),
                app_id: prepared.app_id.clone(),
                module_id: prepared.module_id.clone(),
                operation: prepared.operation.clone(),
                success: prepared.success,
                error: prepared.error.clone(),
            };
            let digest = hex::encode(
                build_neox_digest(chain_id, &oracle, &fulfillment, &prepared.result_bytes_hex)
                    .map_err(|error| {
                        format!("NeoX fulfillment digest could not be recomputed: {error}")
                    })?,
            );
            let returned = response
                .get("fulfillment_digest_hex")
                .and_then(Value::as_str)
                .map(strip_hex_prefix)
                .unwrap_or("")
                .to_ascii_lowercase();
            (digest, returned)
        }
        _ => unreachable!("validated chain"),
    };
    if returned_digest != expected_digest {
        return Err(format!(
            "invalid signature: enclave fulfillment digest mismatch (enclave={} relayer={expected_digest})",
            if returned_digest.is_empty() {
                "missing"
            } else {
                &returned_digest
            }
        ));
    }

    Ok(prepared)
}

fn object_at<'a>(
    value: &'a Value,
    field: &str,
) -> Result<&'a serde_json::Map<String, Value>, String> {
    value
        .get(field)
        .and_then(Value::as_object)
        .ok_or_else(|| format!("relayer configuration is missing {field}"))
}

fn required_string(
    object: &serde_json::Map<String, Value>,
    field: &str,
    label: &str,
) -> Result<String, String> {
    object
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("{label} is not configured"))
}

fn required_string_value(value: &Value, field: &str, label: &str) -> Result<String, String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("Rust enclave fulfillment response is missing {label}"))
}

pub(crate) fn string_array(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn event_field(event: &JsObject, field: &str) -> String {
    event
        .get(field)
        .map(|value| match value {
            JsValue::Str(value) | JsValue::BigInt(value) => value.clone(),
            JsValue::Number(value) if value.is_finite() => value.to_string(),
            _ => String::new(),
        })
        .unwrap_or_default()
}

pub(crate) fn decode_hash160(value: &str) -> Option<[u8; 20]> {
    let raw = strip_hex_prefix(value);
    let bytes = hex::decode(raw).ok()?;
    let mut result = [0u8; 20];
    if bytes.len() != result.len() {
        return None;
    }
    result.copy_from_slice(&bytes);
    Some(result)
}

pub(crate) fn decode_evm_address(value: &str) -> Option<[u8; 20]> {
    let bytes = decode_hex_bytes(value)?;
    bytes.try_into().ok()
}

pub(crate) fn decode_hex_bytes(value: &str) -> Option<Vec<u8>> {
    let raw = strip_hex_prefix(value);
    if !raw.len().is_multiple_of(2) || !raw.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    hex::decode(raw).ok()
}

pub(crate) fn strip_hex_prefix(value: &str) -> &str {
    let trimmed = value.trim();
    trimmed
        .strip_prefix("0x")
        .or_else(|| trimmed.strip_prefix("0X"))
        .unwrap_or(trimmed)
}

fn value_u64(value: &Value) -> Option<u64> {
    value
        .as_u64()
        .or_else(|| {
            value
                .as_f64()
                .filter(|value| value.is_finite() && *value >= 0.0)
                .map(|value| value as u64)
        })
        .or_else(|| value.as_str().and_then(|value| value.parse().ok()))
}

fn service_endpoint(base: &str, path: &str) -> Result<String, String> {
    let mut parsed = url::Url::parse(base)
        .map_err(|_| "Rust enclave URL must be an absolute http(s) URL".to_string())?;
    if !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err("Rust enclave URL must not contain userinfo, query, or fragment".to_string());
    }
    match parsed.scheme() {
        "https" => {}
        "http" if url_is_loopback(&parsed) => {}
        "http" => {
            return Err("Rust enclave URL may use plaintext HTTP only on loopback".to_string())
        }
        _ => return Err("Rust enclave URL must use http or https".to_string()),
    }
    if !parsed.path().ends_with(path) {
        let joined = format!("{}{}", parsed.path().trim_end_matches('/'), path);
        parsed.set_path(&joined);
    }
    Ok(parsed.to_string())
}

fn url_is_loopback(url: &url::Url) -> bool {
    match url.host() {
        Some(url::Host::Domain(host)) => host.eq_ignore_ascii_case("localhost"),
        Some(url::Host::Ipv4(address)) => address.is_loopback(),
        Some(url::Host::Ipv6(address)) => address.is_loopback(),
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::Mutex;

    use k256::ecdsa::SigningKey;
    use neo_os_chain_n3::tx::{FixedNonce, Waiter};
    use rlp::RlpStream;

    use super::*;

    struct NoWait;

    impl Waiter for NoWait {
        fn now_ms(&self) -> u64 {
            1_000
        }
        fn sleep(&self, _ms: u64) {}
    }

    struct ScriptedTransport {
        replies: Mutex<VecDeque<(u16, String)>>,
        calls: Mutex<Vec<(String, String)>>,
    }

    impl ScriptedTransport {
        fn new(replies: Vec<(u16, Value)>) -> Self {
            Self {
                replies: Mutex::new(
                    replies
                        .into_iter()
                        .map(|(status, body)| (status, body.to_string()))
                        .collect(),
                ),
                calls: Mutex::new(Vec::new()),
            }
        }

        fn reply(&self, url: &str, body: &str) -> Result<(u16, String), String> {
            self.calls
                .lock()
                .unwrap()
                .push((url.to_string(), body.to_string()));
            self.replies
                .lock()
                .unwrap()
                .pop_front()
                .ok_or_else(|| "unexpected HTTP call".to_string())
        }
    }

    impl N3HttpTransport for ScriptedTransport {
        fn post(&self, url: &str, body: &str) -> Result<(u16, String), String> {
            self.reply(url, body)
        }
        fn get(&self, url: &str) -> Result<(u16, String), String> {
            self.reply(url, "")
        }
        fn post_with_bearer(
            &self,
            url: &str,
            _token: &str,
            _timeout_ms: u64,
            body: &str,
        ) -> Result<(u16, String), String> {
            self.reply(url, body)
        }
        fn get_with_bearer(
            &self,
            url: &str,
            _token: &str,
            _timeout_ms: u64,
        ) -> Result<(u16, String), String> {
            self.reply(url, "")
        }
    }

    impl EvmHttpTransport for ScriptedTransport {
        fn post(&self, url: &str, body: &str) -> Result<(u16, String), String> {
            self.reply(url, body)
        }
        fn get(&self, url: &str) -> Result<(u16, String), String> {
            self.reply(url, "")
        }
        fn post_with_bearer(
            &self,
            url: &str,
            _token: &str,
            _timeout_ms: u64,
            body: &str,
        ) -> Result<(u16, String), String> {
            self.reply(url, body)
        }
        fn get_with_bearer(
            &self,
            url: &str,
            _token: &str,
            _timeout_ms: u64,
        ) -> Result<(u16, String), String> {
            self.reply(url, "")
        }
    }

    fn config() -> RelayerConfig {
        RelayerConfig {
            repo_root: ".".into(),
            instance_id: "test".into(),
            state_file: "unused".into(),
            network: "testnet".into(),
            node_env: "test".into(),
            mode: "requests_only".into(),
            active_chains: vec!["neo_n3".into()],
            poll_interval_ms: 1,
            concurrency: 1,
            max_blocks_per_tick: 1,
            discovery_idle_backoff_ms: 0,
            state_persist_min_interval_ms: 0,
            raw: json!({
                "nitro": {
                    "apiUrl": "https://enclave.example",
                    "enclaveFulfillUrl": "https://enclave.example",
                    "enclaveFulfill": true,
                    "token": "runtime-token",
                    "timeoutMs": 5000,
                    "custodyUrl": "https://custody.example",
                    "custodyToken": "custody-token"
                },
                "neo_n3": {
                    "rpcUrls": ["https://rpc.example"],
                    "networkMagic": 894710606,
                    "oracleContract": "0xf54d8584ef82315c1800373272ab08ae0db2d5ef",
                    "custodyKeyIds": {"updater": "updater-key"}
                },
                "neox": {
                    "rpcUrl": "https://neox-rpc.example",
                    "rpcUrls": ["https://neox-rpc.example"],
                    "chainId": 12227332,
                    "oracleContract": "0x1111111111111111111111111111111111111111",
                    "confirmTimeoutMs": 5000,
                    "custodyKeyIds": {
                        "updater": "neox-updater-key",
                        "verifier": "neox-verifier-key"
                    }
                }
            }),
        }
    }

    fn event() -> JsValue {
        JsValue::from_json(&json!({
            "requestId": "42",
            "requestType": "compute",
            "appId": "morpheus",
            "moduleId": "compute.execute",
            "operation": "compute",
            "payload": "{}"
        }))
    }

    fn enclave_digest(result: &str) -> String {
        let options = FulfillmentOptions {
            chain: Some("neo_n3".into()),
            app_id: "morpheus".into(),
            module_id: "compute.execute".into(),
            operation: "compute".into(),
            contract_script_hash: "0xf54d8584ef82315c1800373272ab08ae0db2d5ef".into(),
            network_magic: Some(894_710_606.0),
        };
        hex::encode(
            build_fulfillment_digest_bytes(
                &JsValue::Str("42".into()),
                "compute",
                true,
                result,
                "",
                "",
                &options,
            )
            .expect("digest"),
        )
    }

    fn evm_address(key: &SigningKey) -> String {
        let public_key = key.verifying_key().to_encoded_point(false);
        let hash = neo_os_chain_evm::keccak256(&public_key.as_bytes()[1..]);
        format!("0x{}", hex::encode(&hash[12..]))
    }

    fn evm_key_reply(key_id: &str, key: &SigningKey) -> Value {
        json!({
            "allowed": true,
            "key_id": key_id,
            "chain_family": "neox",
            "chain_id": 12227332,
            "address": evm_address(key),
            "public_key": format!(
                "0x{}",
                hex::encode(key.verifying_key().to_encoded_point(true).as_bytes())
            )
        })
    }

    fn signed_evm_transaction(unsigned: &UnsignedEip1559, key: &SigningKey) -> String {
        fn minimal(word: &[u8]) -> &[u8] {
            let first = word
                .iter()
                .position(|byte| *byte != 0)
                .unwrap_or(word.len());
            &word[first..]
        }

        let (signature, recovery_id) = key
            .sign_prehash_recoverable(&unsigned.signing_hash())
            .expect("test EVM signature");
        let mut stream = RlpStream::new_list(12);
        stream.append(&unsigned.chain_id);
        stream.append(&unsigned.nonce);
        stream.append(&unsigned.max_priority_fee_per_gas);
        stream.append(&unsigned.max_fee_per_gas);
        stream.append(&unsigned.gas_limit);
        stream.append(&unsigned.to.as_slice());
        stream.append(&minimal(&unsigned.value));
        stream.append(&unsigned.data.as_slice());
        stream.begin_list(0);
        stream.append(&recovery_id.to_byte());
        stream.append(&minimal(signature.r().to_bytes().as_slice()));
        stream.append(&minimal(signature.s().to_bytes().as_slice()));
        let mut bytes = vec![0x02];
        bytes.extend_from_slice(&stream.out());
        format!("0x{}", hex::encode(bytes))
    }

    #[test]
    fn digest_mismatch_stops_before_custody_or_rpc() {
        let transport = ScriptedTransport::new(vec![(
            200,
            json!({
                "nonce": "00000007000000070000000700000007",
                "success": true,
                "result": "ok",
                "error": "",
                "signature": "aa",
                "fulfillment_digest_hex": "00"
            }),
        )]);

        let error = deliver_event(
            &config(),
            "neo_n3",
            &event(),
            &transport,
            &FixedNonce(7),
            &NoWait,
        )
        .expect_err("digest mismatch");

        assert!(error.contains("digest mismatch"));
        assert_eq!(transport.calls.lock().unwrap().len(), 1);
    }

    #[test]
    fn happy_path_requires_compute_custody_broadcast_and_halt_confirmation() {
        const PUBLIC_KEY: &str =
            "0315b41fcf6671b6400237730bc8a261dcb64e25cc17de9878576c78eace1c9146";
        const SCRIPT_HASH: &str = "0x3124a38a74f447b120b551db00f513ec674318c9";
        let key = json!({
            "allowed": true,
            "key_id": "updater-key",
            "chain_family": "neo-n3",
            "public_key": PUBLIC_KEY,
            "script_hash": SCRIPT_HASH,
            "address": "NeFG5A79AJovUz4BStpnmFyQChLvQkuW72"
        });
        let witness = json!({
            "allowed": true,
            "key_id": "updater-key",
            "script_hash": SCRIPT_HASH,
            "address": "NeFG5A79AJovUz4BStpnmFyQChLvQkuW72",
            "digest": "aabb",
            "invocation_script": "40de",
            "verification_script": format!("0c21{PUBLIC_KEY}4156e7b327"),
            "public_key": PUBLIC_KEY
        });
        let transport = ScriptedTransport::new(vec![
            (
                200,
                json!({
                    "nonce": "00000007000000070000000700000007",
                    "success": true,
                    "result": "ok",
                    "error": "",
                    "signature": "aa",
                    "fulfillment_digest_hex": enclave_digest("ok")
                }),
            ),
            (200, key),
            (200, json!({"jsonrpc":"2.0","id":1,"result":1234})),
            (
                200,
                json!({"jsonrpc":"2.0","id":1,"result":{"state":"HALT","gasconsumed":"100000"}}),
            ),
            (200, witness.clone()),
            (
                200,
                json!({"jsonrpc":"2.0","id":1,"result":{"networkfee":"123456"}}),
            ),
            (200, witness),
            (200, json!({"jsonrpc":"2.0","id":1,"result":true})),
            (
                200,
                json!({"jsonrpc":"2.0","id":1,"result":{"executions":[{"vmstate":"HALT"}]}}),
            ),
        ]);

        let receipt = deliver_event(
            &config(),
            "neo_n3",
            &event(),
            &transport,
            &FixedNonce(7),
            &NoWait,
        )
        .expect("confirmed delivery");

        assert_eq!(receipt.vm_state, "HALT");
        assert_eq!(receipt.target_chain, "neo_n3");
        assert_eq!(receipt.tx_hash.len(), 66);
        let calls = transport.calls.lock().unwrap();
        assert_eq!(calls.len(), 9, "every commit phase is observable");
        assert!(calls[0].0.ends_with("/oracle/fulfill"));
        assert!(calls[1].0.contains("/signer/api/v1/keys/updater-key"));
        assert!(calls[2].1.contains("getblockcount"));
        assert!(calls[3].1.contains("invokescript"));
        assert!(calls[4].0.ends_with("/signer/api/v1/sign/transaction"));
        assert!(calls[5].1.contains("calculatenetworkfee"));
        assert!(calls[6].0.ends_with("/signer/api/v1/sign/transaction"));
        assert!(calls[7].1.contains("sendrawtransaction"));
        assert!(calls[8].1.contains("getapplicationlog"));
    }

    #[test]
    fn neox_requires_distinct_semantic_and_updater_keys_then_confirms_receipt() {
        let updater_key = SigningKey::from_slice(&[5u8; 32]).unwrap();
        let verifier_key = SigningKey::from_slice(&[6u8; 32]).unwrap();
        let fulfillment = EvmFulfillment {
            request_id: "42".into(),
            app_id: "morpheus".into(),
            module_id: "compute.execute".into(),
            operation: "compute".into(),
            success: true,
            error: String::new(),
        };
        let digest = build_neox_digest(
            12_227_332,
            "0x1111111111111111111111111111111111111111",
            &fulfillment,
            "0x6869",
        )
        .unwrap();
        let message_hash = eip191_message_hash(&digest);
        let (verifier_signature, verifier_recovery) = verifier_key
            .sign_prehash_recoverable(&message_hash)
            .unwrap();
        let mut signature = verifier_signature.to_bytes().to_vec();
        signature.push(verifier_recovery.to_byte() + 27);
        let signature = format!("0x{}", hex::encode(signature));
        let calldata =
            encode_fulfill_request_calldata("42", true, "0x6869", "", &signature).unwrap();
        let unsigned = UnsignedEip1559 {
            chain_id: 12_227_332,
            nonce: 7,
            max_priority_fee_per_gas: 2,
            max_fee_per_gas: 10,
            gas_limit: 200_000,
            to: [0x11; 20],
            value: [0; 32],
            data: calldata,
        };
        let signed_transaction = signed_evm_transaction(&unsigned, &updater_key);
        let tx_hash = decode_signed_eip1559(&signed_transaction).unwrap().tx_hash;
        let transport = ScriptedTransport::new(vec![
            (200, evm_key_reply("neox-updater-key", &updater_key)),
            (200, evm_key_reply("neox-verifier-key", &verifier_key)),
            (
                200,
                json!({
                    "chain": "neox",
                    "nonce": "00000001000000010000000100000001",
                    "request_id": "42",
                    "app_id": "morpheus",
                    "module_id": "compute.execute",
                    "operation": "compute",
                    "success": true,
                    "result": "hi",
                    "error": "",
                    "result_bytes_hex": "0x6869",
                    "signature": signature,
                    "public_key": format!(
                        "0x{}",
                        hex::encode(verifier_key.verifying_key().to_encoded_point(true).as_bytes())
                    ),
                    "fulfillment_digest_hex": format!("0x{}", hex::encode(digest)),
                    "verification": {"signature_scheme": "eip191"},
                    "trust_tier": "enclave-attested"
                }),
            ),
            (200, json!({"jsonrpc":"2.0","id":1,"result":"0x7"})),
            (200, json!({"jsonrpc":"2.0","id":1,"result":"0x186a0"})),
            (200, json!({"jsonrpc":"2.0","id":1,"result":"0x4"})),
            (200, json!({"jsonrpc":"2.0","id":1,"result":"0x2"})),
            (
                200,
                json!({
                    "allowed": true,
                    "key_id": "neox-updater-key",
                    "chain_family": "neox",
                    "address": evm_address(&updater_key),
                    "digest": tx_hash,
                    "signed_transaction": signed_transaction,
                    "signature_hex": signed_transaction,
                }),
            ),
            (200, json!({"jsonrpc":"2.0","id":1,"result":tx_hash})),
            (
                200,
                json!({
                    "jsonrpc":"2.0",
                    "id":1,
                    "result": {
                        "transactionHash": tx_hash,
                        "status":"0x1",
                        "blockNumber":"0x63"
                    }
                }),
            ),
        ]);
        let receipt = deliver_event(
            &config(),
            "neox",
            &event(),
            &transport,
            &FixedNonce(1),
            &NoWait,
        )
        .expect("NeoX fulfillment must be mined");
        assert_eq!(receipt.target_chain, "neox");
        assert_eq!(receipt.vm_state, "HALT");
        assert_eq!(receipt.tx_hash, tx_hash);
        let calls = transport.calls.lock().unwrap();
        assert_eq!(calls.len(), 10);
        assert!(calls[0].0.ends_with("/keys/neox-updater-key"));
        assert!(calls[1].0.ends_with("/keys/neox-verifier-key"));
        assert!(calls[2].0.ends_with("/oracle/fulfill"));
        assert!(calls[3].1.contains("eth_getTransactionCount"));
        assert!(calls[4].1.contains("eth_estimateGas"));
        assert!(calls[7].0.ends_with("/signer/api/v1/sign/transaction"));
        assert!(calls[8].1.contains("eth_sendRawTransaction"));
        assert!(calls[9].1.contains("eth_getTransactionReceipt"));
    }
}
