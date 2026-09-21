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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub onchain_state: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
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

/// Durable stage writes are fenced by the database lease generation. A signed
/// stage is immutable and therefore safe to resend after an uncertain response.
pub trait DeliveryJournal: Send + Sync {
    fn get(&self, stage: &str) -> Option<Value>;
    fn persist(&self, stage: &str, value: Value) -> Result<(), String>;
    fn ensure_lease(&self) -> Result<(), String>;
    fn durable(&self) -> bool {
        true
    }
}
struct VolatileJournal;
impl DeliveryJournal for VolatileJournal {
    fn get(&self, _: &str) -> Option<Value> {
        None
    }
    fn persist(&self, _: &str, _: Value) -> Result<(), String> {
        Ok(())
    }
    fn ensure_lease(&self) -> Result<(), String> {
        Ok(())
    }
    fn durable(&self) -> bool {
        false
    }
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
    deliver_event_journaled(
        config,
        chain,
        event,
        transport,
        nonce_source,
        waiter,
        &VolatileJournal,
    )
}

pub fn deliver_event_journaled<T, N, W>(
    config: &RelayerConfig,
    chain: &str,
    event: &JsValue,
    transport: &T,
    nonce_source: &N,
    waiter: &W,
    journal: &dyn DeliveryJournal,
) -> Result<DeliveryReceipt, String>
where
    T: N3HttpTransport + EvmHttpTransport,
    N: NonceSource,
    W: Waiter,
{
    journal.ensure_lease()?;
    if let Some(signed) = journal.get("signed") {
        return resume_signed(config, chain, transport, journal, &signed);
    }
    if journal.durable() {
        if let Some(evidence) = settled_request(config, chain, event, transport)? {
            return Ok(DeliveryReceipt {
                request_id: event_field(event.as_object().ok_or("invalid event")?, "requestId"),
                tx_hash: String::new(),
                vm_state: "RECONCILED".into(),
                target_chain: chain.into(),
                exception: None,
                onchain_state: Some(evidence),
            });
        }
    }
    match chain {
        "neo_n3" => deliver_neo_n3(config, event, transport, nonce_source, waiter, journal),
        "neox" => deliver_neox(config, event, transport, nonce_source, waiter, journal),
        other => Err(format!("unsupported delivery chain {other}")),
    }
}

fn deliver_neo_n3<T, N, W>(
    config: &RelayerConfig,
    event: &JsValue,
    transport: &T,
    nonce_source: &N,
    waiter: &W,
    journal: &dyn DeliveryJournal,
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
    let prepared = prepare_once(
        config,
        "neo_n3",
        event,
        nitro,
        transport,
        nonce_source,
        journal,
    )?;
    let custody = CustodyClient::new(transport, connection);
    let updater = resolve_signer(&custody, updater_key_id)?;

    // SVC-E-4 (CL-05/CL-14). The NeoX branch pins the verifier identity the
    // enclave answered with; the N3 branch compared only the digest — and the
    // digest binds requestId/appId/moduleId/operation/success/result/error/
    // scriptHash/magic, all of which the relayer recomputes from the same
    // inputs, so a correctly-computed digest signed by SOME OTHER key would
    // pass. Pinning the returned `public_key` to the configured
    // oracle_verifier makes "this came from the measured verifier key" a
    // checked claim on this lane too, using the identity custody already
    // publishes.
    //
    // Not yet closed, and recorded as the follow-on: the digest does not
    // cover the request payload, so faithful execution of substituted inputs
    // still produces a fulfilment nobody can distinguish. Fixing that is a
    // contract ABI change.
    let verifier_key_id = n3
        .get("custodyKeyIds")
        .and_then(Value::as_object)
        .and_then(|keys| keys.get("oracle_verifier"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            "Neo N3 custody oracle_verifier key is not configured \
             (SIGNER_ROLE_ORACLE_VERIFIER_KEY_ID)"
                .to_string()
        })?;
    if verifier_key_id == updater_key_id {
        return Err(
            "Neo N3 verifier and updater custody roles must use different keys".to_string(),
        );
    }
    let verifier = custody.key_info(verifier_key_id)?;
    let returned_public_key = strip_hex_prefix(&prepared.public_key);
    if returned_public_key.is_empty()
        || !returned_public_key.eq_ignore_ascii_case(strip_hex_prefix(&verifier.public_key))
    {
        return Err(
            "Neo N3 measured fulfillment returned a different verifier identity".to_string(),
        );
    }

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
    journal.ensure_lease()?;
    if journal.durable() {
        let signed = neo_os_chain_n3::tx::build_and_sign(
            &rpc,
            &custody,
            &updater,
            nonce_source,
            &script,
            &options,
        )?;
        let stage = json!({"chain":"neo_n3","request_id":prepared.request_id,"tx_hash":signed.tx_hash,"raw":signed.signed_base64,"valid_until_block":signed.valid_until_block});
        return persist_and_publish(config, "neo_n3", transport, journal, &stage);
    }
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
        onchain_state: None,
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
    journal: &dyn DeliveryJournal,
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

    let prepared = prepare_once(
        config,
        "neox",
        event,
        nitro,
        transport,
        nonce_source,
        journal,
    )?;
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
    journal.ensure_lease()?;
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
    if journal.durable() {
        let stage = json!({"chain":"neox","request_id":prepared.request_id,"tx_hash":decoded.tx_hash,"raw":signed.signed_transaction});
        return persist_and_publish(config, "neox", transport, journal, &stage);
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
        onchain_state: None,
    })
}

fn settled_request<T: N3HttpTransport + EvmHttpTransport>(
    config: &RelayerConfig,
    chain: &str,
    event: &JsValue,
    transport: &T,
) -> Result<Option<Value>, String> {
    let id = event_field(
        event.as_object().ok_or("invalid delivery event")?,
        "requestId",
    );
    let lane = object_at(&config.raw, chain)?;
    let contract = required_string(lane, "oracleContract", "oracle contract")?;
    if chain == "neox" {
        let rpc = EvmRpcClient::new(
            required_string(lane, "rpcUrl", "NeoX RPC")?,
            string_array(lane.get("rpcUrls")),
            transport,
        );
        let record = rpc
            .get_request(&contract, id.parse().map_err(|_| "request id overflow")?)
            .map_err(|e| e.to_string())?
            .ok_or("unresolved request")?;
        if record
            .get("id")
            .map(|v| {
                v.as_str()
                    .map(str::to_string)
                    .unwrap_or_else(|| v.to_string())
            })
            .as_deref()
            != Some(id.as_str())
        {
            return Err("request state identity mismatch".into());
        }
        let status = record
            .get("status")
            .and_then(Value::as_u64)
            .ok_or("request state omitted status")?;
        return Ok(matches!(status,2|3).then(||json!({"chain":chain,"contract":contract,"request_id":id,"status":status,"record":record})));
    }
    let rpc = NeoRpcClient::new(transport, string_array(lane.get("rpcUrls")), !cfg!(test))?;
    let result = rpc
        .invoke_function(
            &contract,
            "getRequest",
            json!([{"type":"Integer","value":id}]),
        )
        .map_err(|e| e.to_string())?;
    if result.get("state").and_then(Value::as_str) != Some("HALT") {
        return Err("request state lookup did not HALT".into());
    }
    let first = result
        .pointer("/stack/0")
        .ok_or("request lookup omitted stack")?;
    let decoded =
        neo_os_chain_n3::scan::decode_neo_item(first, neo_os_chain_n3::scan::Encoding::Base64);
    let fields = decoded.as_array().ok_or("request state is not an array")?;
    let fulfilled_index = if fields.len() >= 14 {
        10
    } else if fields.len() >= 12 {
        8
    } else {
        return Err("request state tuple truncated".into());
    };
    let observed_id = fields
        .first()
        .map(|v| {
            v.as_str()
                .map(str::to_string)
                .unwrap_or_else(|| v.to_string())
        })
        .unwrap_or_default();
    if observed_id != id {
        return Err("request state identity mismatch".into());
    }
    let fulfilled = fields[fulfilled_index]
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| fields[fulfilled_index].to_string());
    let settled = fulfilled
        .parse::<u64>()
        .map_err(|_| "invalid fulfilled timestamp")?
        > 0;
    Ok(settled.then(||json!({"chain":chain,"contract":contract,"request_id":id,"fulfilled_at":fulfilled,"record":decoded})))
}

fn prepare_once<T, N>(
    config: &RelayerConfig,
    chain: &str,
    event: &JsValue,
    nitro: &serde_json::Map<String, Value>,
    transport: &T,
    nonce: &N,
    journal: &dyn DeliveryJournal,
) -> Result<PreparedFulfillment, String>
where
    T: N3HttpTransport + EvmHttpTransport,
    N: NonceSource,
{
    if let Some(prepared) = journal.get("prepared") {
        return serde_json::from_value(prepared)
            .map_err(|e| format!("invalid prepared journal: {e}"));
    }
    journal.ensure_lease()?;
    let prepared = prepare_in_enclave(config, chain, event, nitro, transport, nonce)?;
    journal.persist(
        "prepared",
        serde_json::to_value(&prepared).map_err(|e| e.to_string())?,
    )?;
    Ok(prepared)
}

/// One observation per scheduled visit. Pending confirmation leaves the exact
/// signed transaction in the journal and frees the worker's compute slot.
pub fn observe_existing_transaction<T: N3HttpTransport + EvmHttpTransport>(
    config: &RelayerConfig,
    chain: &str,
    hash: &str,
    transport: &T,
) -> Result<DeliveryReceipt, String> {
    let lane = object_at(&config.raw, chain)?;
    let vm_state = if chain == "neox" {
        let rpc = EvmRpcClient::new(
            required_string(lane, "rpcUrl", "NeoX RPC")?,
            string_array(lane.get("rpcUrls")),
            transport,
        );
        let receipt = rpc
            .transaction_receipt(hash)
            .map_err(|e| e.to_string())?
            .ok_or("transaction still unconfirmed")?;
        match receipt.status {
            1 => "HALT",
            0 => "FAULT",
            _ => return Err("unexpected EVM receipt status".into()),
        }
    } else if chain == "neo_n3" {
        let rpc = NeoRpcClient::new(transport, string_array(lane.get("rpcUrls")), !cfg!(test))?;
        let result = rpc.get_application_log(hash).map_err(|e| e.to_string())?;
        match result
            .pointer("/executions/0/vmstate")
            .and_then(Value::as_str)
        {
            Some("HALT") => "HALT",
            Some("FAULT") => "FAULT",
            _ => return Err("transaction execution is not yet observable".into()),
        }
    } else {
        return Err("unsupported reconciliation chain".into());
    };
    Ok(DeliveryReceipt {
        request_id: String::new(),
        tx_hash: hash.into(),
        vm_state: vm_state.into(),
        target_chain: chain.into(),
        exception: None,
        onchain_state: None,
    })
}

/// Expiry is not absence. Require two explicitly configured archive nodes,
/// matching canonical hashes at the expiry height, and the RPC's exact -103
/// unknown-transaction response before authorizing another signed attempt.
pub fn observe_expired_n3<T: N3HttpTransport + EvmHttpTransport>(
    config: &RelayerConfig,
    signed: &Value,
    transport: &T,
) -> Result<DeliveryReceipt, String> {
    use sha2::Digest;
    let lane = object_at(&config.raw, "neo_n3")?;
    let urls = string_array(lane.get("reconciliationArchiveRpcUrls"));
    let unique: std::collections::BTreeSet<_> = urls.into_iter().collect();
    if unique.len() < 2 {
        return Err(
            "expired N3 delivery requires two configured archive RPCs for absence evidence".into(),
        );
    }
    let hash = signed
        .get("tx_hash")
        .and_then(Value::as_str)
        .ok_or("journal hash missing")?;
    let expiry = signed
        .get("valid_until_block")
        .and_then(Value::as_u64)
        .ok_or("journal expiry missing")?;
    let mut checks = vec![];
    let mut canonical = None;
    for url in unique {
        let rpc = NeoRpcClient::new(transport, vec![url.clone()], !cfg!(test))?;
        let tip = rpc.get_block_count().map_err(|e| e.to_string())? as u64;
        if tip <= expiry {
            return Err("archive node has not passed the transaction expiry".into());
        }
        let expiry_hash = rpc
            .call("getblockhash", json!([expiry]))
            .map_err(|e| e.to_string())?
            .as_str()
            .ok_or("archive omitted expiry block hash")?
            .to_owned();
        if expiry_hash.len() != 66 {
            return Err("archive returned malformed block hash".into());
        }
        if canonical.as_ref().is_some_and(|h| h != &expiry_hash) {
            return Err("archive nodes disagree at expiry height".into());
        }
        canonical = Some(expiry_hash.clone());
        let (status, raw) = N3HttpTransport::post(
            transport,
            &url,
            &json!({"jsonrpc":"2.0","id":1,"method":"getrawtransaction","params":[hash,true]})
                .to_string(),
        )?;
        let response: Value = serde_json::from_str(&raw)
            .map_err(|_| "archive returned non-JSON transaction evidence")?;
        if status != 200 || response.pointer("/error/code").and_then(Value::as_i64) != Some(-103) {
            return Err("archive has not proved this expired transaction absent".into());
        }
        checks.push(json!({"rpc_id":hex::encode(sha2::Sha256::digest(url.as_bytes())),"tip":tip,"expiry_hash":expiry_hash}));
    }
    Ok(DeliveryReceipt {
        request_id: signed
            .get("request_id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .into(),
        tx_hash: hash.into(),
        vm_state: "EXPIRED_UNSEEN".into(),
        target_chain: "neo_n3".into(),
        exception: None,
        onchain_state: Some(json!({"valid_until_block":expiry,"archive_checks":checks})),
    })
}

pub(crate) fn persist_and_publish<T: N3HttpTransport + EvmHttpTransport>(
    config: &RelayerConfig,
    chain: &str,
    transport: &T,
    journal: &dyn DeliveryJournal,
    stage: &Value,
) -> Result<DeliveryReceipt, String> {
    journal.persist("signed", stage.clone())?;
    resume_signed(config, chain, transport, journal, stage)
}

pub(crate) fn resume_signed<T: N3HttpTransport + EvmHttpTransport>(
    config: &RelayerConfig,
    chain: &str,
    transport: &T,
    journal: &dyn DeliveryJournal,
    signed: &Value,
) -> Result<DeliveryReceipt, String> {
    if signed.get("chain").and_then(Value::as_str) != Some(chain) {
        return Err("journal target chain mismatch".into());
    }
    let hash = signed
        .get("tx_hash")
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
        .ok_or("journal omitted tx hash")?;
    let raw = signed
        .get("raw")
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
        .ok_or("journal omitted signed bytes")?;
    let id = signed
        .get("request_id")
        .and_then(Value::as_str)
        .unwrap_or("");
    let receipt = || DeliveryReceipt {
        request_id: id.into(),
        tx_hash: hash.into(),
        vm_state: "HALT".into(),
        target_chain: chain.into(),
        exception: None,
        onchain_state: None,
    };
    let broadcast = if chain == "neox" {
        let lane = object_at(&config.raw, "neox")?;
        let decoded = decode_signed_eip1559(raw)?;
        if !decoded.tx_hash.eq_ignore_ascii_case(hash) {
            return Err("journal signed transaction hash mismatch".into());
        }
        let rpc = EvmRpcClient::new(
            required_string(lane, "rpcUrl", "NeoX RPC")?,
            string_array(lane.get("rpcUrls")),
            transport,
        );
        if let Some(found) = rpc.transaction_receipt(hash).map_err(|e| e.to_string())? {
            if found.status == 0 {
                let mut failed = receipt();
                failed.vm_state = "FAULT".into();
                return Ok(failed);
            }
            if found.status != 1 {
                return Err("terminal: unexpected EVM receipt status".into());
            }
            return Ok(receipt());
        }
        journal.ensure_lease()?;
        rpc.send_raw_transaction(raw)
            .map(|_| ())
            .map_err(|e| e.to_string())
    } else if chain == "neo_n3" {
        let lane = object_at(&config.raw, "neo_n3")?;
        let rpc = NeoRpcClient::new(transport, string_array(lane.get("rpcUrls")), !cfg!(test))?;
        if let Ok(log) = rpc.get_application_log(hash) {
            if let Some(execution) = log.pointer("/executions/0") {
                if execution
                    .get("vmstate")
                    .and_then(Value::as_str)
                    .is_some_and(|s| !s.is_empty())
                {
                    if execution
                        .get("vmstate")
                        .and_then(Value::as_str)
                        .is_some_and(|v| v.eq_ignore_ascii_case("FAULT"))
                    {
                        let mut failed = receipt();
                        failed.vm_state = "FAULT".into();
                        failed.exception = execution
                            .get("exception")
                            .and_then(Value::as_str)
                            .map(str::to_owned);
                        return Ok(failed);
                    }
                    neo_os_chain_n3::tx::assert_halt_execution(
                        id,
                        hash,
                        execution,
                        "fulfillRequest",
                    )
                    .map_err(|e| format!("terminal: {e}"))?;
                    return Ok(receipt());
                }
            }
        }
        if let Some(expiry) = signed.get("valid_until_block").and_then(Value::as_u64) {
            if rpc.get_block_count().map_err(|e| e.to_string())? as u64 > expiry {
                // No application log does not prove the old transaction never
                // landed. Preserve the bytes and require evidence to reconcile.
                return observe_expired_n3(config, signed, transport).map_err(|error| {
                    format!("terminal: N3 transaction {hash} expired without confirmation; {error}")
                });
            }
        }
        journal.ensure_lease()?;
        let accepted = rpc.send_raw_transaction(raw).map_err(|e| e.to_string())?;
        if !accepted {
            return Err("Neo N3 RPC rejected the re-broadcast transaction".into());
        }
        Ok(())
    } else {
        return Err("unsupported journal chain".into());
    };
    if let Err(error) = broadcast {
        let lower = error.to_ascii_lowercase();
        if !lower.contains("already") && !lower.contains("duplicate") {
            return Err(error);
        }
    }
    Err(format!("delivery pending confirmation: {hash}"))
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

    struct TestJournal(Mutex<Value>);
    impl DeliveryJournal for TestJournal {
        fn get(&self, stage: &str) -> Option<Value> {
            self.0.lock().unwrap().get(stage).cloned()
        }
        fn persist(&self, stage: &str, value: Value) -> Result<(), String> {
            self.0.lock().unwrap()[stage] = value;
            Ok(())
        }
        fn ensure_lease(&self) -> Result<(), String> {
            Ok(())
        }
    }

    #[test]
    fn resumed_signed_delivery_only_observes_and_resends_identical_bytes() {
        let journal = TestJournal(Mutex::new(
            json!({"signed":{"chain":"neo_n3","request_id":"42","tx_hash":"0xabc","raw":"signed-original"}}),
        ));
        let transport = ScriptedTransport::new(vec![
            (200, json!({"result":{"executions":[]}})),
            (200, json!({"result":true})),
        ]);
        let pending = deliver_event_journaled(
            &config(),
            "neo_n3",
            &event(),
            &transport,
            &FixedNonce(9),
            &NoWait,
            &journal,
        )
        .unwrap_err();
        assert!(pending.contains("pending confirmation"));
        let calls = transport.calls.lock().unwrap();
        assert_eq!(calls.len(), 2);
        assert!(calls[0].1.contains("getapplicationlog"));
        assert!(calls[1].1.contains("signed-original"));
        drop(calls);
        // Re-open the serialized durable record, without any process-local
        // processed cache, compute reply or custody state.
        let restored = TestJournal(Mutex::new(
            serde_json::from_str(&journal.0.lock().unwrap().to_string()).unwrap(),
        ));
        let observed = ScriptedTransport::new(vec![(
            200,
            json!({"result":{"executions":[{"vmstate":"HALT"}]}}),
        )]);
        let receipt = deliver_event_journaled(
            &config(),
            "neo_n3",
            &event(),
            &observed,
            &FixedNonce(999),
            &NoWait,
            &restored,
        )
        .unwrap();
        assert_eq!(receipt.tx_hash, "0xabc");
        assert_eq!(observed.calls.lock().unwrap().len(), 1);
    }

    #[test]
    fn lost_lease_refuses_even_a_previously_signed_broadcast() {
        struct LostLease;
        impl DeliveryJournal for LostLease {
            fn get(&self, _: &str) -> Option<Value> {
                panic!("must check lease before reading stages")
            }
            fn persist(&self, _: &str, _: Value) -> Result<(), String> {
                panic!("no writes after lease lost")
            }
            fn ensure_lease(&self) -> Result<(), String> {
                Err("delivery lease lost".into())
            }
        }
        let transport = ScriptedTransport::new(vec![]);
        assert!(deliver_event_journaled(
            &config(),
            "neo_n3",
            &event(),
            &transport,
            &FixedNonce(9),
            &NoWait,
            &LostLease
        )
        .unwrap_err()
        .contains("lease lost"));
        assert!(transport.calls.lock().unwrap().is_empty());
    }

    #[test]
    fn journal_commit_failure_prevents_all_broadcast_or_confirmation_requests() {
        struct FailedCommit;
        impl DeliveryJournal for FailedCommit {
            fn get(&self, _: &str) -> Option<Value> {
                None
            }
            fn persist(&self, stage: &str, _: Value) -> Result<(), String> {
                assert_eq!(stage, "signed");
                Err("database commit failed".into())
            }
            fn ensure_lease(&self) -> Result<(), String> {
                Ok(())
            }
        }
        let transport = ScriptedTransport::new(vec![]);
        let error = persist_and_publish(
            &config(),
            "neo_n3",
            &transport,
            &FailedCommit,
            &json!({"chain":"neo_n3","raw":"signed","tx_hash":"0xabc"}),
        )
        .unwrap_err();
        assert!(error.contains("commit failed"));
        assert!(transport.calls.lock().unwrap().is_empty());
    }

    impl Waiter for NoWait {
        fn now_ms(&self) -> u64 {
            1_000
        }
        fn sleep(&self, _ms: u64) {}
    }
    impl EvmWaiter for NoWait {
        fn now_ms(&self) -> u64 {
            1000
        }
        fn sleep(&self, _: std::time::Duration) {}
    }

    #[test]
    fn feed_and_xcm_resume_prepared_signed_bytes_without_host_or_custody_calls() {
        let stage =
            json!({"chain":"neo_n3","request_id":"feed","tx_hash":"0xabc","raw":"original-signed"});
        let journal = TestJournal(Mutex::new(
            json!({"prepared":{"signed_delivery":stage,"feed_response":{"rounds":[1]}}}),
        ));
        let transport = ScriptedTransport::new(vec![(
            200,
            json!({"result":{"executions":[{"vmstate":"HALT"}]}}),
        )]);
        let receipt = crate::feed_sync::deliver_feed_journaled(
            &config(),
            "neo_n3",
            &Value::Null,
            &transport,
            &NoWait,
            &FixedNonce(4),
            &journal,
        )
        .unwrap();
        assert_eq!(receipt.tx_hash, "0xabc");
        assert_eq!(transport.calls.lock().unwrap().len(), 1);
        let msg = crate::xcm::CrossChainMessage::new("neox", "neo_n3", 1, vec![1, 2, 3]);
        let event = json!({"source_chain":"neox","dest_chain":"neo_n3","nonce":1,"payload_hex":"010203","commitment":msg.commitment()});
        let journal = TestJournal(Mutex::new(
            json!({"prepared":{"signed_delivery":stage,"message":msg}}),
        ));
        let transport = ScriptedTransport::new(vec![(
            200,
            json!({"result":{"executions":[{"vmstate":"HALT"}]}}),
        )]);
        let receipt = crate::xcm_lane::relay_xcm_journaled(
            &config(),
            &event,
            &transport,
            &FixedNonce(5),
            &NoWait,
            &journal,
        )
        .unwrap();
        assert_eq!(receipt.tx_hash, "0xabc");
        assert_eq!(transport.calls.lock().unwrap().len(), 1);
    }

    #[test]
    fn n3_expiry_needs_two_matching_archive_absence_observations() {
        let mut config = config();
        config.raw["neo_n3"]["reconciliationArchiveRpcUrls"] =
            json!(["https://archive-a.example", "https://archive-b.example"]);
        let signed = json!({"request_id":"42","tx_hash":"0xabc","valid_until_block":100});
        let hash = format!("0x{}", "a".repeat(64));
        let responses = vec![
            (200, json!({"result":102})),
            (200, json!({"result":hash})),
            (
                200,
                json!({"error":{"code":-103,"message":"Unknown transaction"}}),
            ),
            (200, json!({"result":103})),
            (200, json!({"result":hash})),
            (
                200,
                json!({"error":{"code":-103,"message":"Unknown transaction"}}),
            ),
        ];
        let receipt =
            observe_expired_n3(&config, &signed, &ScriptedTransport::new(responses)).unwrap();
        assert_eq!(receipt.vm_state, "EXPIRED_UNSEEN");
        config.raw["neo_n3"]["reconciliationArchiveRpcUrls"] = json!(["https://archive-a.example"]);
        assert!(observe_expired_n3(&config, &signed, &ScriptedTransport::new(vec![])).is_err());
    }

    #[test]
    fn settled_request_reconciles_from_bound_chain_state_without_compute_or_signing() {
        let vector: Value = serde_json::from_str(include_str!(
            "../../../crates/neo-os-chain-evm/tests/vectors/get_request.json"
        ))
        .unwrap();
        let transport = ScriptedTransport::new(vec![(200, json!({"result":vector["encoded"]}))]);
        let journal = TestJournal(Mutex::new(json!({})));
        let receipt = deliver_event_journaled(
            &config(),
            "neox",
            &event(),
            &transport,
            &FixedNonce(4),
            &NoWait,
            &journal,
        )
        .unwrap();
        assert_eq!(receipt.vm_state, "RECONCILED");
        assert!(receipt.tx_hash.is_empty());
        assert_eq!(receipt.onchain_state.as_ref().unwrap()["request_id"], "42");
        assert_eq!(transport.calls.lock().unwrap().len(), 1);
        let mut fields = vec![json!({"type":"Integer","value":"0"}); 14];
        fields[0] = json!({"type":"Integer","value":"42"});
        fields[10] = json!({"type":"Integer","value":"1700000000000"});
        let transport = ScriptedTransport::new(vec![(
            200,
            json!({"result":{"state":"HALT","stack":[{"type":"Array","value":fields}]}}),
        )]);
        let receipt = deliver_event_journaled(
            &config(),
            "neo_n3",
            &event(),
            &transport,
            &FixedNonce(4),
            &NoWait,
            &journal,
        )
        .unwrap();
        assert_eq!(receipt.vm_state, "RECONCILED");
        assert!(receipt.tx_hash.is_empty());
        assert_eq!(transport.calls.lock().unwrap().len(), 1);
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
                        .map(|(status, mut body)| {
                            // Keep scripted fixtures faithful to JSON-RPC 2.0. Older
                            // fixtures supplied only `result`/`error`, which made
                            // otherwise valid delivery paths fail before exercising
                            // their intended assertions.
                            if body.get("jsonrpc").is_none() {
                                body["jsonrpc"] = json!("2.0");
                            }
                            if body.get("id").is_none() {
                                body["id"] = json!(1);
                            }
                            (status, body.to_string())
                        })
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
                    "custodyKeyIds": {
                        "updater": "updater-key",
                        "oracle_verifier": "oracle-verifier-key"
                    }
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
        // A DISTINCT identity from the updater: the two roles must not be the
        // same key (SVC-E-5), and the pin only means something if the lane
        // can tell them apart (SVC-E-4).
        const VERIFIER_PUBLIC_KEY: &str =
            "02911ea2e6a0ae0d3a1a1b1a4d6c0b0f5a2b3c4d5e6f708192a3b4c5d6e7f895cb4";
        let verifier_key = json!({
            "allowed": true,
            "key_id": "oracle-verifier-key",
            "chain_family": "neo-n3",
            "public_key": VERIFIER_PUBLIC_KEY,
            "script_hash": "0x1111111111111111111111111111111111111111",
            "address": "NiUs458jFbTH1DA3b9QyeDhMaD282h3iJg"
        });
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
                    // SVC-E-4: the enclave names the verifier key it signed
                    // with, and the relayer pins it against custody.
                    "public_key": VERIFIER_PUBLIC_KEY,
                    "fulfillment_digest_hex": enclave_digest("ok")
                }),
            ),
            (200, key),
            (200, verifier_key),
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
        assert_eq!(calls.len(), 10, "every commit phase is observable");
        assert!(calls[0].0.ends_with("/oracle/fulfill"));
        assert!(calls[1].0.contains("/signer/api/v1/keys/updater-key"));
        // SVC-E-4: the verifier identity is fetched and compared BEFORE any
        // chain call, so a fulfilment signed by another key never reaches a
        // broadcast.
        assert!(calls[2]
            .0
            .contains("/signer/api/v1/keys/oracle-verifier-key"));
        assert!(calls[3].1.contains("getblockcount"));
        assert!(calls[4].1.contains("invokescript"));
        assert!(calls[5].0.ends_with("/signer/api/v1/sign/transaction"));
        assert!(calls[6].1.contains("calculatenetworkfee"));
        assert!(calls[7].0.ends_with("/signer/api/v1/sign/transaction"));
        assert!(calls[8].1.contains("sendrawtransaction"));
        assert!(calls[9].1.contains("getapplicationlog"));
    }

    /// SVC-E-4 (CL-05/CL-14). The N3 branch used to accept any correctly
    /// computed digest: every field the digest binds is recomputed by the
    /// relayer from its own inputs, so a fulfilment signed by a key that is
    /// not the measured oracle_verifier verified just as well. The NeoX lane
    /// has pinned its verifier identity since it was written; this is the
    /// same check applied to N3.
    #[test]
    fn a_neo_n3_fulfillment_signed_by_another_key_is_refused_before_broadcast() {
        const VERIFIER_PUBLIC_KEY: &str =
            "02911ea2e6a0ae0d3a1a1b1a4d6c0b0f5a2b3c4d5e6f708192a3b4c5d6e7f895cb4";
        const UPDATER_PUBLIC_KEY: &str =
            "0315b41fcf6671b6400237730bc8a261dcb64e25cc17de9878576c78eace1c9146";
        let identity = |key_id: &str, public_key: &str| {
            json!({
                "allowed": true,
                "key_id": key_id,
                "chain_family": "neo-n3",
                "public_key": public_key,
                "script_hash": "0x3124a38a74f447b120b551db00f513ec674318c9",
                "address": "NeFG5A79AJovUz4BStpnmFyQChLvQkuW72"
            })
        };
        // The enclave answers with a perfectly recomputable digest — and the
        // updater's public key instead of the verifier's. That is exactly the
        // shape a compromised host with custody credentials can produce.
        let transport = ScriptedTransport::new(vec![
            (
                200,
                json!({
                    "nonce": "00000007000000070000000700000007",
                    "success": true,
                    "result": "ok",
                    "error": "",
                    "signature": "aa",
                    "public_key": UPDATER_PUBLIC_KEY,
                    "fulfillment_digest_hex": enclave_digest("ok")
                }),
            ),
            (200, identity("updater-key", UPDATER_PUBLIC_KEY)),
            (200, identity("oracle-verifier-key", VERIFIER_PUBLIC_KEY)),
        ]);

        let error = deliver_event(
            &config(),
            "neo_n3",
            &event(),
            &transport,
            &FixedNonce(7),
            &NoWait,
        )
        .expect_err("a foreign verifier identity must not be broadcast");
        assert!(
            error.contains("Neo N3 measured fulfillment returned a different verifier identity"),
            "{error}"
        );
        // Nothing reached the chain: three custody/enclave calls and no RPC.
        let calls = transport.calls.lock().unwrap();
        assert_eq!(calls.len(), 3, "{calls:?}");
        assert!(!calls
            .iter()
            .any(|call| call.1.contains("sendrawtransaction")));
    }

    /// An enclave that names no verifier at all is refused too: an absent
    /// identity is not a matching one.
    #[test]
    fn a_neo_n3_fulfillment_with_no_verifier_identity_is_refused() {
        const VERIFIER_PUBLIC_KEY: &str =
            "02911ea2e6a0ae0d3a1a1b1a4d6c0b0f5a2b3c4d5e6f708192a3b4c5d6e7f895cb4";
        const UPDATER_PUBLIC_KEY: &str =
            "0315b41fcf6671b6400237730bc8a261dcb64e25cc17de9878576c78eace1c9146";
        let identity = |key_id: &str, public_key: &str| {
            json!({
                "allowed": true,
                "key_id": key_id,
                "chain_family": "neo-n3",
                "public_key": public_key,
                "script_hash": "0x3124a38a74f447b120b551db00f513ec674318c9",
                "address": "NeFG5A79AJovUz4BStpnmFyQChLvQkuW72"
            })
        };
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
            (200, identity("updater-key", UPDATER_PUBLIC_KEY)),
            (200, identity("oracle-verifier-key", VERIFIER_PUBLIC_KEY)),
        ]);

        let error = deliver_event(
            &config(),
            "neo_n3",
            &event(),
            &transport,
            &FixedNonce(7),
            &NoWait,
        )
        .expect_err("an absent verifier identity must not be broadcast");
        assert!(
            error.contains("Neo N3 measured fulfillment returned a different verifier identity"),
            "{error}"
        );
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
