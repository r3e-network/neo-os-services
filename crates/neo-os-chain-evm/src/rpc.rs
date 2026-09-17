//! EVM JSON-RPC over an injected transport, with the neo-n3 client's failover
//! discipline adapted to the ethers error taxonomy: only TRANSPORT failures
//! fail over to the next URL; a deterministic `CALL_EXCEPTION` / decoded
//! revert is returned immediately (every endpoint would answer identically).
//! Ported from neox.js `withNeoXReadFailover` / `isNeoXTransportError`.

use serde_json::{json, Value};
use std::{thread, time::Duration};

use crate::HttpTransport;

/// A deterministic per-call failure (contract revert / decode error): never
/// failed over.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeterministicError(pub String);

/// A transport/connectivity failure: failed over across the URL list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransportError(pub String);

/// The classification `isNeoXTransportError` makes: transport vs deterministic.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NeoXCallError {
    Transport(TransportError),
    Deterministic(DeterministicError),
}

/// A mined EVM transaction receipt.  A receipt is returned only once the node
/// has assigned a block; `status == 1` is the sole successful terminal state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EvmReceipt {
    pub tx_hash: String,
    pub status: u64,
    pub block_number: u64,
}

/// Injectable clock/sleeper so confirmation polling is deterministic in
/// tests and does not hide a wall-clock dependency inside the RPC adapter.
pub trait EvmWaiter {
    fn now_ms(&self) -> u64;
    fn sleep(&self, duration: Duration);
}

#[derive(Debug, Clone, Copy, Default)]
pub struct SystemEvmWaiter;

impl EvmWaiter for SystemEvmWaiter {
    fn now_ms(&self) -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .try_into()
            .unwrap_or(u64::MAX)
    }

    fn sleep(&self, duration: Duration) {
        thread::sleep(duration);
    }
}

impl std::fmt::Display for NeoXCallError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            NeoXCallError::Transport(e) => f.write_str(&e.0),
            NeoXCallError::Deterministic(e) => f.write_str(&e.0),
        }
    }
}

impl NeoXCallError {
    /// `isNeoXTransportError`: a CALL_EXCEPTION or a revert-carrying error is
    /// deterministic; network/timeout/5xx shapes are transport.
    pub fn is_transport(&self) -> bool {
        matches!(self, NeoXCallError::Transport(_))
    }
}

/// Ordered read-RPC failover client.
pub struct EvmRpcClient<T: HttpTransport> {
    transport: T,
    /// Primary first, then the configured read failovers (deduped).
    urls: Vec<String>,
}

impl<T: HttpTransport> EvmRpcClient<T> {
    /// `resolveNeoXReadRpcUrls`: primary guaranteed first, configured list
    /// deduped order-preservingly after it.
    pub fn new(primary: String, configured: Vec<String>, transport: T) -> Self {
        let mut urls = Vec::new();
        for url in std::iter::once(primary).chain(configured) {
            let trimmed = url.trim().to_string();
            if !trimmed.is_empty() && !urls.contains(&trimmed) {
                urls.push(trimmed);
            }
        }
        Self { transport, urls }
    }

    pub fn urls(&self) -> &[String] {
        &self.urls
    }

    /// `withNeoXReadFailover`: run the raw eth_* call across the URL list,
    /// failing over only on transport errors.
    pub fn call(&self, method: &str, params: Value) -> Result<Value, NeoXCallError> {
        let body = json!({"jsonrpc": "2.0", "id": 1, "method": method, "params": params});
        let mut last_transport_error: Option<TransportError> = None;
        for url in &self.urls {
            let (status, raw) = match self.transport.post(url, &body.to_string()) {
                Ok(res) => res,
                Err(error) => {
                    last_transport_error = Some(TransportError(error));
                    continue;
                }
            };
            // An unhealthy proxy frequently returns HTML. Classify HTTP before
            // JSON so this cannot be mistaken for a deterministic contract error.
            if status != 200 {
                last_transport_error = Some(TransportError(format!("rpc answered {status}")));
                continue;
            }
            let parsed: Value = match serde_json::from_str(&raw) {
                Ok(value) => value,
                Err(error) => {
                    last_transport_error =
                        Some(TransportError(format!("non-JSON response: {error}")));
                    continue;
                }
            };
            if let Some(error) = parsed.get("error") {
                let code = error.get("code").and_then(Value::as_i64).unwrap_or(0);
                let message = error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let lower = message.to_ascii_lowercase();
                if matches!(code, -32603 | -32002 | -32005)
                    || lower.contains("rate limit")
                    || lower.contains("temporarily unavailable")
                    || lower.contains("timeout")
                    || lower.contains("timed out")
                {
                    last_transport_error = Some(TransportError(format!("code {code}: {message}")));
                    continue;
                }
                return Err(NeoXCallError::Deterministic(DeterministicError(format!(
                    "code {code}: {message}"
                ))));
            }
            if let Some(result) = parsed.get("result") {
                return Ok(result.clone());
            }
            last_transport_error = Some(TransportError("RPC omitted result and error".into()));
        }
        Err(NeoXCallError::Transport(
            last_transport_error.unwrap_or_else(|| {
                TransportError("neox read failed: no rpc endpoints configured".into())
            }),
        ))
    }

    /// `eth_blockNumber` — hex quantity.
    pub fn block_number(&self) -> Result<u64, NeoXCallError> {
        let value = self.call("eth_blockNumber", json!([]))?;
        parse_hex_quantity(&value).ok_or_else(|| {
            NeoXCallError::Deterministic(DeterministicError(
                "eth_blockNumber returned a non-quantity".into(),
            ))
        })
    }

    /// Pending nonce for the updater account.
    pub fn transaction_count(&self, address: &str) -> Result<u64, NeoXCallError> {
        let value = self.call("eth_getTransactionCount", json!([address, "pending"]))?;
        parse_hex_quantity(&value).ok_or_else(|| {
            NeoXCallError::Deterministic(DeterministicError(
                "eth_getTransactionCount returned a non-quantity".into(),
            ))
        })
    }

    /// Current legacy gas price, used as the base for a bounded EIP-1559 fee.
    pub fn gas_price(&self) -> Result<u128, NeoXCallError> {
        let value = self.call("eth_gasPrice", json!([]))?;
        parse_hex_quantity_u128(&value).ok_or_else(|| {
            NeoXCallError::Deterministic(DeterministicError(
                "eth_gasPrice returned a non-quantity".into(),
            ))
        })
    }

    /// Node-recommended EIP-1559 priority fee.
    pub fn max_priority_fee_per_gas(&self) -> Result<u128, NeoXCallError> {
        let value = self.call("eth_maxPriorityFeePerGas", json!([]))?;
        parse_hex_quantity_u128(&value).ok_or_else(|| {
            NeoXCallError::Deterministic(DeterministicError(
                "eth_maxPriorityFeePerGas returned a non-quantity".into(),
            ))
        })
    }

    /// Simulate a transaction before asking custody to sign it.
    pub fn estimate_gas(&self, from: &str, to: &str, data: &str) -> Result<u64, NeoXCallError> {
        let value = self.call(
            "eth_estimateGas",
            json!([{ "from": from, "to": to, "data": data }]),
        )?;
        parse_hex_quantity(&value).ok_or_else(|| {
            NeoXCallError::Deterministic(DeterministicError(
                "eth_estimateGas returned a non-quantity".into(),
            ))
        })
    }

    /// Fetch a mined receipt. `null` is a non-terminal pending state.
    pub fn transaction_receipt(&self, tx_hash: &str) -> Result<Option<EvmReceipt>, NeoXCallError> {
        let value = self.call("eth_getTransactionReceipt", json!([tx_hash]))?;
        if value.is_null() {
            return Ok(None);
        }
        let returned_hash = value
            .get("transactionHash")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| {
                NeoXCallError::Deterministic(DeterministicError(
                    "eth_getTransactionReceipt omitted transactionHash".into(),
                ))
            })?;
        if !returned_hash.eq_ignore_ascii_case(tx_hash) {
            return Err(NeoXCallError::Deterministic(DeterministicError(
                "eth_getTransactionReceipt returned a different transaction".into(),
            )));
        }
        let status = value
            .get("status")
            .and_then(parse_hex_quantity)
            .ok_or_else(|| {
                NeoXCallError::Deterministic(DeterministicError(
                    "eth_getTransactionReceipt omitted status".into(),
                ))
            })?;
        let block_number = value
            .get("blockNumber")
            .and_then(parse_hex_quantity)
            .ok_or_else(|| {
                NeoXCallError::Deterministic(DeterministicError(
                    "eth_getTransactionReceipt omitted blockNumber".into(),
                ))
            })?;
        Ok(Some(EvmReceipt {
            tx_hash: returned_hash.to_string(),
            status,
            block_number,
        }))
    }

    /// Poll until a concrete, mined, successful receipt is available. A
    /// reverted receipt is terminal and is never retried against another RPC.
    pub fn wait_for_receipt<W: EvmWaiter>(
        &self,
        waiter: &W,
        tx_hash: &str,
        timeout_ms: u64,
    ) -> Result<EvmReceipt, NeoXCallError> {
        if timeout_ms == 0 {
            return Err(NeoXCallError::Deterministic(DeterministicError(
                "EVM receipt timeout must be positive".into(),
            )));
        }
        let started = waiter.now_ms();
        loop {
            if let Some(receipt) = self.transaction_receipt(tx_hash)? {
                if receipt.status != 1 {
                    return Err(NeoXCallError::Deterministic(DeterministicError(format!(
                        "EVM transaction {tx_hash} reverted in block {} (status {})",
                        receipt.block_number, receipt.status
                    ))));
                }
                return Ok(receipt);
            }
            if waiter.now_ms().saturating_sub(started) >= timeout_ms {
                return Err(NeoXCallError::Transport(TransportError(format!(
                    "timed out waiting for EVM transaction {tx_hash} receipt"
                ))));
            }
            waiter.sleep(Duration::from_millis(1_000));
        }
    }

    /// `eth_call` to a contract method: data is the full calldata hex.
    pub fn eth_call(&self, to: &str, data: &str) -> Result<Vec<u8>, NeoXCallError> {
        let value = self.call("eth_call", json!([{ "to": to, "data": data }, "latest"]))?;
        let hex = value.as_str().ok_or_else(|| {
            NeoXCallError::Deterministic(DeterministicError(
                "eth_call returned a non-string".into(),
            ))
        })?;
        hex_to_bytes(hex).map_err(|error| NeoXCallError::Deterministic(DeterministicError(error)))
    }

    /// `eth_sendRawTransaction` — returns the tx hash.
    pub fn send_raw_transaction(&self, signed_hex: &str) -> Result<String, NeoXCallError> {
        let value = self.call("eth_sendRawTransaction", json!([signed_hex]))?;
        let tx_hash = value.as_str().ok_or_else(|| {
            NeoXCallError::Deterministic(DeterministicError(
                "eth_sendRawTransaction returned a non-string hash".into(),
            ))
        })?;
        let raw = tx_hash.strip_prefix("0x").ok_or_else(|| {
            NeoXCallError::Deterministic(DeterministicError(
                "eth_sendRawTransaction returned a hash without 0x prefix".into(),
            ))
        })?;
        if raw.len() != 64 || !raw.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(NeoXCallError::Deterministic(DeterministicError(
                "eth_sendRawTransaction returned an invalid transaction hash".into(),
            )));
        }
        Ok(tx_hash.to_string())
    }

    /// `totalRequests` on the oracle contract.
    pub fn get_latest_request_id(&self, oracle_contract: &str) -> Result<u64, NeoXCallError> {
        let selector = &crate::keccak256(b"totalRequests()")[..4];
        let calldata = format!("0x{}", neo_os_core::hex_encode(selector));
        let bytes = self.eth_call(oracle_contract, &calldata)?;
        if bytes.len() < 32 {
            return Err(NeoXCallError::Deterministic(DeterministicError(
                "totalRequests returned fewer than 32 bytes".into(),
            )));
        }
        if bytes[..24].iter().any(|byte| *byte != 0) {
            return Err(NeoXCallError::Deterministic(DeterministicError(
                "totalRequests exceeds supported u64 range".into(),
            )));
        }
        let word: [u8; 8] = bytes[24..32].try_into().unwrap();
        Ok(u64::from_be_bytes(word))
    }

    /// `getRequest(uint256)` on the oracle contract.
    pub fn get_request(
        &self,
        oracle_contract: &str,
        request_id: u64,
    ) -> Result<Option<Value>, NeoXCallError> {
        let selector = &crate::keccak256(b"getRequest(uint256)")[..4];
        let mut calldata_bytes = Vec::with_capacity(36);
        calldata_bytes.extend_from_slice(selector);
        let mut id_word = [0u8; 32];
        id_word[24..].copy_from_slice(&request_id.to_be_bytes());
        calldata_bytes.extend_from_slice(&id_word);
        let calldata = format!("0x{}", neo_os_core::hex_encode(&calldata_bytes));
        let res = self.eth_call(oracle_contract, &calldata)?;
        decode_get_request_tuple(&res).map(Some).ok_or_else(|| {
            NeoXCallError::Deterministic(DeterministicError(format!(
                "getRequest({request_id}) returned an unresolved ABI response"
            )))
        })
    }

    /// Scan requests sequentially in [from_id, to_id].
    pub fn scan_requests_by_id(
        &self,
        oracle_contract: &str,
        from_id: u64,
        to_id: u64,
    ) -> Result<Vec<Value>, NeoXCallError> {
        if from_id > to_id {
            return Ok(Vec::new());
        }
        let mut results = Vec::new();
        for id in from_id..=to_id {
            // No error proves absence. Abort the contiguous range so the
            // caller cannot advance its cursor past an unresolved request.
            if let Some(record) = self.get_request(oracle_contract, id)? {
                results.push(record);
            }
        }
        Ok(results)
    }
}

fn decode_get_request_tuple(bytes: &[u8]) -> Option<Value> {
    // getRequest returns one dynamic struct. ABI return values are themselves
    // a tuple, so the first word is the struct's offset, not its request id.
    // Both the historical 13-field and current fee-extended 15-field Request
    // share the fields read below; each dynamic offset is relative to the
    // struct body after this outer head.
    if bytes.len() < 32 || bytes[..31].iter().any(|byte| *byte != 0) || bytes[31] != 32 {
        return None;
    }
    let bytes = bytes.get(32..)?;
    if bytes.len() < 416 {
        return None;
    }
    if bytes[..24].iter().any(|byte| *byte != 0) {
        return None;
    }
    if [256usize, 288]
        .iter()
        .any(|start| bytes[*start..*start + 24].iter().any(|byte| *byte != 0))
        || [160usize, 192]
            .iter()
            .any(|start| bytes[*start..*start + 12].iter().any(|byte| *byte != 0))
        || bytes[224..255].iter().any(|byte| *byte != 0)
        || bytes[255] > 3
        || bytes[320..351].iter().any(|byte| *byte != 0)
        || bytes[351] > 1
    {
        return None;
    }
    let u64_at = |start: usize| -> u64 {
        let mut b = [0u8; 8];
        b.copy_from_slice(&bytes[start + 24..start + 32]);
        u64::from_be_bytes(b)
    };
    let address_at = |start: usize| -> String {
        format!(
            "0x{}",
            neo_os_core::hex_encode(&bytes[start + 12..start + 32])
        )
    };
    let dynamic_bytes = |word_start: usize| -> Option<Vec<u8>> {
        if bytes[word_start..word_start + 24]
            .iter()
            .any(|byte| *byte != 0)
        {
            return None;
        }
        let offset = usize::try_from(u64_at(word_start)).ok()?;
        if offset < 416 || !offset.is_multiple_of(32) {
            return None;
        }
        let start = offset.checked_add(32)?;
        if bytes.len() < start {
            return None;
        }
        if bytes[offset..offset + 24].iter().any(|byte| *byte != 0) {
            return None;
        }
        let len = usize::try_from(u64_at(offset)).ok()?;
        let end = start.checked_add(len)?;
        if bytes.len() < end {
            return None;
        }
        Some(bytes[start..end].to_vec())
    };
    let dynamic_string = |word_start: usize| -> Option<String> {
        let raw = dynamic_bytes(word_start)?;
        String::from_utf8(raw).ok()
    };

    let id = u64_at(0);
    let app_id = dynamic_string(32)?;
    let module_id = dynamic_string(64)?;
    let operation = dynamic_string(96)?;
    let payload = format!("0x{}", neo_os_core::hex_encode(&dynamic_bytes(128)?));
    let requester = address_at(160);
    let callback_contract = address_at(192);
    let status = bytes[224 + 31] as u64;
    let created_at = u64_at(256);
    let fulfilled_at = u64_at(288);
    let success = bytes[320 + 31] != 0;
    let result_bytes = format!("0x{}", neo_os_core::hex_encode(&dynamic_bytes(352)?));
    let error_text = dynamic_string(384)?;

    Some(json!({
        "id": id,
        "appId": app_id,
        "moduleId": module_id,
        "operation": operation,
        "payload": payload,
        "requester": requester,
        "callbackContract": callback_contract,
        "status": status,
        "createdAt": created_at,
        "fulfilledAt": fulfilled_at,
        "success": success,
        "resultBytes": result_bytes,
        "errorText": error_text,
    }))
}

/// Parse a `0x`-prefixed quantity (u64 — block numbers and small counters).
pub fn parse_hex_quantity(value: &Value) -> Option<u64> {
    let text = value.as_str()?;
    let raw = text.strip_prefix("0x").unwrap_or(text);
    u64::from_str_radix(raw, 16).ok()
}

/// Parse a full uint128 JSON-RPC quantity (gas prices routinely exceed u64 in
/// exotic networks, while EIP-1559 fields are uint256 on the wire).
pub fn parse_hex_quantity_u128(value: &Value) -> Option<u128> {
    let text = value.as_str()?;
    let raw = text.strip_prefix("0x").unwrap_or(text);
    if raw.is_empty() {
        return None;
    }
    u128::from_str_radix(raw, 16).ok()
}

fn hex_to_bytes(text: &str) -> Result<Vec<u8>, String> {
    let raw = text
        .strip_prefix("0x")
        .ok_or("RPC bytes omitted 0x prefix")?;
    if !raw.len().is_multiple_of(2) || !raw.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("RPC returned malformed hex bytes".into());
    }
    (0..raw.len())
        .step_by(2)
        .map(|i| {
            u8::from_str_radix(&raw[i..i + 2], 16)
                .map_err(|_| "RPC returned malformed hex bytes".into())
        })
        .collect()
}
