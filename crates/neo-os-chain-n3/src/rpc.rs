//! The JSON-RPC client: URL failover with known-good promotion and the exact
//! JS error strings. Ported from neo-n3.js `neoRpcCall` / `createNeoRpcError` /
//! `promoteNeoN3RpcUrl` / `getNeoN3RpcUrls`.
//!
//! Behavior parity notes:
//! * URLs are de-duplicated order-preserving at construction;
//! * a successful call moves its URL to the FRONT of the list (a best-effort
//!   health-stickiness heuristic — explicitly not consistency-critical);
//! * each URL failure produces `Neo RPC {method} failed via {url} ({status}): {detail}`;
//! * an empty URL list produces `Neo RPC {method} failed: no RPC endpoint configured`;
//! * after all URLs fail, the LAST error is returned (JS throws lastError).

use serde_json::{json, Value};
use std::sync::Mutex;

use crate::ssrf::{classify_url, SsrfDecision};
use crate::HttpTransport;

pub const RPC_TIMEOUT_MS: u64 = 30_000;
pub const GAS_CONTRACT_HASH: &str = "0xd2a4cff31913016155e38e474a2c06d08be276cf";

/// An RPC failure: the fully formatted message (JS `Error` parity).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NeoRpcError(pub String);

impl std::fmt::Display for NeoRpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for NeoRpcError {}

/// Guarded + failover JSON-RPC client. `T` is the injected transport.
pub struct NeoRpcClient<T: HttpTransport> {
    transport: T,
    /// Current URL order, front = next to try. Mutated by promotion.
    urls: Mutex<Vec<String>>,
    /// Reject URLs that classify as SSRF targets (defense in depth: the
    /// constructor validates too, but per-call re-validation catches a
    /// promotion list that was somehow replaced).
    enforce_ssrf: bool,
}

impl<T: HttpTransport> NeoRpcClient<T> {
    /// Builds a client over the configured URLs (order-preserving dedup).
    /// Every URL passes the SSRF guard — an operator-configured private or
    /// loopback endpoint is a configuration error, not a runtime fallback.
    pub fn new(transport: T, urls: Vec<String>, enforce_ssrf: bool) -> Result<Self, String> {
        let urls = unique_ordered(urls);
        if enforce_ssrf {
            for url in &urls {
                if let SsrfDecision::Rejected(reason) =
                    classify_url(url, &crate::ssrf::SystemResolve)
                {
                    return Err(format!("neo rpc url rejected: {reason} ({url})"));
                }
            }
        }
        Ok(Self {
            transport,
            urls: Mutex::new(urls),
            enforce_ssrf,
        })
    }

    pub fn urls(&self) -> Vec<String> {
        self.urls.lock().expect("urls lock").clone()
    }

    /// `neoRpcCall`: fail over the configured URLs in order; promote the URL
    /// that answered to the front.
    pub fn call(&self, method: &str, params: Value) -> Result<Value, NeoRpcError> {
        let urls = self.urls.lock().expect("urls lock").clone();
        if urls.is_empty() {
            return Err(NeoRpcError(format!(
                "Neo RPC {method} failed: no RPC endpoint configured"
            )));
        }

        let mut last_error: Option<String> = None;
        for rpc_url in &urls {
            if self.enforce_ssrf {
                if let SsrfDecision::Rejected(reason) =
                    classify_url(rpc_url, &crate::ssrf::SystemResolve)
                {
                    last_error = Some(format!(
                        "Neo RPC {method} failed via {rpc_url} (0): {reason}"
                    ));
                    continue;
                }
            }
            let body = json!({"jsonrpc": "2.0", "id": 1, "method": method, "params": params});
            let call = self.transport.post(rpc_url, &body.to_string());
            let (status, raw_body) = match call {
                Ok(pair) => pair,
                Err(transport_error) => {
                    last_error = Some(transport_error);
                    continue;
                }
            };
            let parsed: Value = match serde_json::from_str(&raw_body) {
                Ok(value) => value,
                Err(_) => {
                    last_error = Some(format_neo_rpc_error(
                        method,
                        rpc_url,
                        status,
                        "non-JSON response",
                    ));
                    continue;
                }
            };
            if status != 200 && status != 201 {
                let detail = parsed
                    .pointer("/error/message")
                    .and_then(Value::as_str)
                    .or_else(|| parsed.get("message").and_then(Value::as_str))
                    .unwrap_or("")
                    .to_string();
                last_error = Some(format_neo_rpc_error(method, rpc_url, status, &detail));
                continue;
            }
            if let Some(error) = parsed.get("error") {
                let detail = error
                    .get("message")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("{method} failed"));
                last_error = Some(format_neo_rpc_error(method, rpc_url, 200, &detail));
                continue;
            }
            self.promote(rpc_url);
            return Ok(parsed.get("result").cloned().unwrap_or(Value::Null));
        }
        Err(NeoRpcError(
            last_error.unwrap_or_else(|| format!("Neo RPC {method} failed")),
        ))
    }

    fn promote(&self, rpc_url: &str) {
        let mut urls = self.urls.lock().expect("urls lock");
        let mut next = vec![rpc_url.to_string()];
        for url in urls.iter() {
            if url != rpc_url && !next.contains(url) {
                next.push(url.clone());
            }
        }
        *urls = next;
    }

    // ---- typed wrappers (the relayer's actual surface) ----

    /// `getblockcount` → the latest block index (`Number(blockCount) - 1` is
    /// the caller's concern; this returns the raw count as JS would see it).
    pub fn get_block_count(&self) -> Result<u32, NeoRpcError> {
        let value = self.call("getblockcount", json!([]))?;
        value
            .as_u64()
            .map(|count| count.min(u32::MAX as u64) as u32)
            .ok_or_else(|| NeoRpcError("Neo RPC getblockcount returned a non-number".into()))
    }

    /// `getblock {height, 1}` — verbose: headers + tx bodies (no notifications).
    pub fn get_block(&self, height: u32) -> Result<Value, NeoRpcError> {
        self.call("getblock", json!([height, 1]))
    }

    /// `getapplicationlog {txHash}`.
    pub fn get_application_log(&self, tx_hash: &str) -> Result<Value, NeoRpcError> {
        self.call("getapplicationlog", json!([tx_hash]))
    }

    /// `invokefunction {contract, method, params}`.
    pub fn invoke_function(
        &self,
        contract: &str,
        method: &str,
        params: Value,
    ) -> Result<Value, NeoRpcError> {
        self.call("invokefunction", json!([contract, method, params]))
    }

    /// `sendrawtransaction {base64}` — true when the node accepted it.
    pub fn send_raw_transaction(&self, signed_base64: &str) -> Result<bool, NeoRpcError> {
        let value = self.call("sendrawtransaction", json!([signed_base64]))?;
        value
            .as_bool()
            .ok_or_else(|| NeoRpcError("sendrawtransaction returned a non-boolean result".into()))
    }

    /// `calculatenetworkfee {base64}` — returns the raw `networkfee` field.
    pub fn calculate_network_fee(&self, signed_base64: &str) -> Result<u128, NeoRpcError> {
        let value = self.call("calculatenetworkfee", json!([signed_base64]))?;
        parse_u128_field(&value, "networkfee")
            .ok_or_else(|| NeoRpcError("calculatenetworkfee response had no networkfee".into()))
    }

    /// `getcontractstate {contract}`.
    pub fn get_contract_state(&self, contract: &str) -> Result<Value, NeoRpcError> {
        self.call("getcontractstate", json!([contract]))
    }
}

pub fn parse_u128_field(value: &Value, field: &str) -> Option<u128> {
    match value.get(field) {
        Some(Value::String(text)) => text.parse::<u128>().ok(),
        Some(Value::Number(number)) => number.as_u128(),
        _ => None,
    }
}

fn format_neo_rpc_error(method: &str, rpc_url: &str, status: u16, detail: &str) -> String {
    let suffix = detail.trim();
    if suffix.is_empty() {
        format!("Neo RPC {method} failed via {rpc_url} ({status})")
    } else {
        format!("Neo RPC {method} failed via {rpc_url} ({status}): {suffix}")
    }
}

fn unique_ordered(values: Vec<String>) -> Vec<String> {
    let mut seen = Vec::new();
    for value in values {
        let trimmed = value.trim().to_string();
        if !trimmed.is_empty() && !seen.contains(&trimmed) {
            seen.push(trimmed);
        }
    }
    seen
}

#[cfg(test)]
mod tests {
    use super::*;

    struct OneShotTransport {
        status: u16,
        body: String,
    }
    impl HttpTransport for OneShotTransport {
        fn post(&self, _url: &str, _body: &str) -> Result<(u16, String), String> {
            Ok((self.status, self.body.clone()))
        }
        fn get(&self, _url: &str) -> Result<(u16, String), String> {
            Ok((self.status, "{}".to_string()))
        }
    }

    #[test]
    fn call_unwraps_the_json_rpc_result_envelope() {
        let transport = OneShotTransport {
            status: 200,
            body: r#"{"jsonrpc":"2.0","id":1,"result":1234}"#.to_string(),
        };
        let client = NeoRpcClient::new(transport, vec!["https://rpc.example".to_string()], false)
            .expect("urls pass the guard");
        let count = client.get_block_count().expect("number");
        assert_eq!(count, 1234);
    }
}
