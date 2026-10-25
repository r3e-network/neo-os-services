//! Chain-bound NeoX custody identity client.
//!
//! The client resolves the public account needed for nonce/gas simulation and
//! submits fully constructed EIP-1559 transactions to the custody service. It
//! refuses an N3 key substituted under a NeoX role and never accepts private
//! key material.

use k256::ecdsa::VerifyingKey;
use serde_json::Value;
use sha3::{Digest, Keccak256};

use crate::HttpTransport;

const CUSTODY_API: &str = "/signer/api/v1";
const DEFAULT_TIMEOUT_MS: u64 = 15_000;

#[derive(Debug, Clone)]
pub struct EvmCustodySettings {
    pub url: String,
    pub token: String,
    pub timeout_ms: u64,
}

impl EvmCustodySettings {
    pub fn new(url: &str, token: &str, timeout_ms: Option<u64>) -> Result<Self, String> {
        let url = url.trim().trim_end_matches('/').to_string();
        let token = token.trim().to_string();
        if url.is_empty() || token.is_empty() {
            return Err("NeoX custody URL and token are required".to_string());
        }
        validate_url(&url)?;
        Ok(Self {
            url,
            token,
            timeout_ms: timeout_ms
                .filter(|value| *value > 0)
                .unwrap_or(DEFAULT_TIMEOUT_MS),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EvmCustodyIdentity {
    pub key_id: String,
    pub address: String,
    pub public_key: String,
    pub chain_id: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EvmSignedTransaction {
    pub key_id: String,
    pub address: String,
    pub digest: String,
    pub signed_transaction: String,
}

pub struct EvmCustodyClient<T: HttpTransport> {
    transport: T,
    settings: EvmCustodySettings,
}

impl<T: HttpTransport> EvmCustodyClient<T> {
    pub fn new(transport: T, settings: EvmCustodySettings) -> Self {
        Self {
            transport,
            settings,
        }
    }

    pub fn key_info(&self, key_id: &str) -> Result<EvmCustodyIdentity, String> {
        let key_id = key_id.trim();
        if key_id.is_empty() || matches!(key_id, "." | "..") {
            return Err("NeoX custody key id is invalid".to_string());
        }
        let url = format!(
            "{}{}{}{}",
            self.settings.url,
            CUSTODY_API,
            "/keys/",
            encode_segment(key_id)
        );
        let (status, body) = self
            .transport
            .get_with_bearer(&url, &self.settings.token, self.settings.timeout_ms)
            .map_err(|error| format!("NeoX custody signer is unreachable: {error}"))?;
        let parsed: Value = serde_json::from_str(&body)
            .map_err(|_| format!("NeoX custody signer returned malformed JSON (HTTP {status})"))?;
        if !(200..300).contains(&status) {
            let detail = parsed
                .get("message")
                .or_else(|| parsed.get("code"))
                .and_then(Value::as_str)
                .unwrap_or("custody request refused");
            return Err(format!("NeoX custody signer answered {status}: {detail}"));
        }
        if parsed.get("allowed").and_then(Value::as_bool) != Some(true) {
            return Err("NeoX custody identity response is missing allowed=true".to_string());
        }
        if parsed.get("chain_family").and_then(Value::as_str) != Some("neox") {
            return Err("NeoX custody role resolved to a non-NeoX key".to_string());
        }
        let returned_key_id = nonempty(&parsed, "key_id")?;
        if returned_key_id != key_id {
            return Err("NeoX custody identity key id mismatch".to_string());
        }
        let address = nonempty(&parsed, "address")?;
        validate_address(&address)?;
        let public_key = nonempty(&parsed, "public_key")?;
        let derived_address = address_from_public_key(&public_key)?;
        if !address.eq_ignore_ascii_case(&derived_address) {
            return Err("NeoX custody public key does not match its address".to_string());
        }
        let chain_id = parsed
            .get("chain_id")
            .and_then(|value| {
                value
                    .as_u64()
                    .or_else(|| value.as_str().and_then(|text| text.parse().ok()))
            })
            .ok_or_else(|| "NeoX custody identity response is missing chain_id".to_string())?;
        Ok(EvmCustodyIdentity {
            key_id: returned_key_id,
            address,
            public_key,
            chain_id,
        })
    }

    pub fn sign_transaction(
        &self,
        key_id: &str,
        chain_id: u64,
        unsigned_hex: &str,
        request_id: &str,
    ) -> Result<EvmSignedTransaction, String> {
        if key_id.trim().is_empty() || request_id.trim().is_empty() {
            return Err("NeoX custody key id and request id are required".to_string());
        }
        let url = format!("{}{}/sign/transaction", self.settings.url, CUSTODY_API);
        let body = serde_json::json!({
            "key_id": key_id,
            "unsigned_hex": unsigned_hex,
            "request_id": request_id,
            "chain_family": "neox",
            "chain_id": chain_id,
        })
        .to_string();
        let (status, text) = self
            .transport
            .post_with_bearer(&url, &self.settings.token, self.settings.timeout_ms, &body)
            .map_err(|error| format!("NeoX custody signer is unreachable: {error}"))?;
        let parsed: Value = serde_json::from_str(&text)
            .map_err(|_| format!("NeoX custody signer returned malformed JSON (HTTP {status})"))?;
        if !(200..300).contains(&status) {
            let detail = parsed
                .get("message")
                .or_else(|| parsed.get("code"))
                .and_then(Value::as_str)
                .unwrap_or("custody transaction refused");
            return Err(format!("NeoX custody signer answered {status}: {detail}"));
        }
        if parsed.get("allowed").and_then(Value::as_bool) != Some(true)
            || parsed.get("chain_family").and_then(Value::as_str) != Some("neox")
        {
            return Err(
                "NeoX custody transaction response is not an allowed NeoX signature".to_string(),
            );
        }
        let returned_key_id = nonempty(&parsed, "key_id")?;
        if returned_key_id != key_id {
            return Err("NeoX custody transaction key id mismatch".to_string());
        }
        let signed_transaction = nonempty(&parsed, "signed_transaction")?;
        if parsed
            .get("signature_hex")
            .and_then(Value::as_str)
            .is_some_and(|alias| alias != signed_transaction)
        {
            return Err("NeoX custody signed transaction alias mismatch".to_string());
        }
        Ok(EvmSignedTransaction {
            key_id: returned_key_id,
            address: nonempty(&parsed, "address")?,
            digest: nonempty(&parsed, "digest")?,
            signed_transaction,
        })
    }
}

fn nonempty(value: &Value, field: &str) -> Result<String, String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("NeoX custody identity response is missing {field}"))
}

fn validate_address(address: &str) -> Result<(), String> {
    let raw = address
        .strip_prefix("0x")
        .or_else(|| address.strip_prefix("0X"))
        .unwrap_or(address);
    if raw.len() != 40 || !raw.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("NeoX custody identity returned an invalid address".to_string());
    }
    Ok(())
}

fn address_from_public_key(public_key: &str) -> Result<String, String> {
    let raw = public_key
        .trim()
        .strip_prefix("0x")
        .or_else(|| public_key.trim().strip_prefix("0X"))
        .unwrap_or(public_key.trim());
    if !raw.len().is_multiple_of(2) || !raw.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("NeoX custody public key is not hexadecimal".to_string());
    }
    let bytes = (0..raw.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&raw[index..index + 2], 16).expect("checked hex"))
        .collect::<Vec<_>>();
    let key = VerifyingKey::from_sec1_bytes(&bytes)
        .map_err(|_| "NeoX custody public key is not secp256k1".to_string())?;
    let uncompressed = key.to_sec1_point(false);
    let hash = Keccak256::digest(&uncompressed.as_bytes()[1..]);
    Ok(format!("0x{}", hex_lower(&hash[12..])))
}

fn hex_lower(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn validate_url(raw: &str) -> Result<(), String> {
    let parsed = url::Url::parse(raw)
        .map_err(|_| "NeoX custody URL must be an absolute http(s) URL".to_string())?;
    if !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err("NeoX custody URL must not contain userinfo, query, or fragment".to_string());
    }
    match parsed.scheme() {
        "https" => Ok(()),
        "http" if loopback(&parsed) => Ok(()),
        "http" => Err("NeoX custody URL may use plaintext HTTP only on loopback".to_string()),
        _ => Err("NeoX custody URL must use http or https".to_string()),
    }
}

fn loopback(url: &url::Url) -> bool {
    match url.host() {
        Some(url::Host::Domain(host)) => host.eq_ignore_ascii_case("localhost"),
        Some(url::Host::Ipv4(address)) => address.is_loopback(),
        Some(url::Host::Ipv6(address)) => address.is_loopback(),
        None => false,
    }
}

fn encode_segment(text: &str) -> String {
    let mut output = String::new();
    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                output.push(byte as char)
            }
            _ => output.push_str(&format!("%{byte:02X}")),
        }
    }
    output
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    struct Transport {
        body: String,
        calls: Mutex<Vec<String>>,
    }

    impl HttpTransport for Transport {
        fn post(&self, _url: &str, _body: &str) -> Result<(u16, String), String> {
            unreachable!()
        }
        fn get(&self, _url: &str) -> Result<(u16, String), String> {
            unreachable!()
        }
        fn get_with_bearer(
            &self,
            url: &str,
            _token: &str,
            _timeout_ms: u64,
        ) -> Result<(u16, String), String> {
            self.calls.lock().unwrap().push(url.to_string());
            Ok((200, self.body.clone()))
        }
    }

    #[test]
    fn identity_is_chain_and_key_bound() {
        let key = k256::ecdsa::SigningKey::from_slice(&[3u8; 32]).unwrap();
        let public_key = key.verifying_key().to_sec1_point(true);
        let uncompressed = key.verifying_key().to_sec1_point(false);
        let hash = Keccak256::digest(&uncompressed.as_bytes()[1..]);
        let transport = Transport {
            body: serde_json::json!({
                "allowed": true,
                "key_id": "neo/x updater",
                "chain_family": "neox",
                "chain_id": "12227332",
                "address": format!("0x{}", hex_lower(&hash[12..])),
                "public_key": format!("0x{}", hex_lower(public_key.as_bytes()))
            })
            .to_string(),
            calls: Mutex::new(Vec::new()),
        };
        let client = EvmCustodyClient::new(
            &transport,
            EvmCustodySettings::new("https://signer.example", "token", None).unwrap(),
        );
        let identity = client.key_info("neo/x updater").expect("identity");
        assert_eq!(identity.chain_id, 12_227_332);
        assert!(transport.calls.lock().unwrap()[0].ends_with("/neo%2Fx%20updater"));
    }

    #[test]
    fn n3_substitution_is_refused() {
        let transport = Transport {
            body: serde_json::json!({
                "allowed": true,
                "key_id": "updater",
                "chain_family": "neo-n3",
                "chain_id": 12227332,
                "address": "0x1111111111111111111111111111111111111111",
                "public_key": "03aa"
            })
            .to_string(),
            calls: Mutex::new(Vec::new()),
        };
        let client = EvmCustodyClient::new(
            &transport,
            EvmCustodySettings::new("https://signer.example", "token", None).unwrap(),
        );
        assert!(client.key_info("updater").unwrap_err().contains("non-NeoX"));
    }
}
