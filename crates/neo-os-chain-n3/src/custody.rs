//! The signer-service (custody) client — the Rust port of `custody.js`
//! (docs/SIGNER_SERVICE.md §5). The relayer holds no key material: it names a
//! key_id and the custody enclave returns either a refusal envelope or a
//! signature computed inside the attested boundary.
//!
//! Error strings are parity-critical: ops runbooks and the classifier both
//! match on them.

use serde_json::{json, Value};

use crate::HttpTransport;

const CUSTODY_API: &str = "/signer/api/v1";
const DEFAULT_CUSTODY_TIMEOUT_MS: u64 = 15_000;

/// Connection settings for the custody client (folded from the runtime env at
/// config load: SIGNER_SERVICE_URL / SIGNER_SERVICE_TOKEN).
#[derive(Debug, Clone)]
pub struct CustodyConnection {
    pub url: String,
    pub token: String,
    pub timeout_ms: u64,
}

impl CustodyConnection {
    pub fn new(url: String, token: String, timeout_ms: Option<u64>) -> Result<Self, String> {
        let url = url.trim().trim_end_matches('/').to_string();
        let token = token.trim().to_string();
        if url.is_empty() || token.is_empty() {
            return Err(
                "custody signer service is not configured; provision SIGNER_SERVICE_URL and SIGNER_SERVICE_TOKEN"
                    .to_string(),
            );
        }
        validate_custody_url(&url)?;
        let timeout_ms = match timeout_ms {
            Some(value) if value > 0 => value,
            _ => DEFAULT_CUSTODY_TIMEOUT_MS,
        };
        Ok(Self {
            url,
            token,
            timeout_ms,
        })
    }
}

/// `custodyKeyId(config, role)`: the role's key id or the exact JS error.
pub fn custody_key_id(custody_key_ids: &Value, role: &str) -> Result<String, String> {
    let key_id = custody_key_ids
        .get(role)
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    if key_id.is_empty() {
        return Err(format!(
            "custody key for role {role} is not provisioned (SIGNER_ROLE_{}_KEY_ID)",
            role.to_uppercase()
        ));
    }
    Ok(key_id.to_string())
}

/// The custody key identity a `GET /keys/{id}` returns — public material only
/// (public_key, script_hash, address); never a secret.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CustodyKeyIdentity {
    pub chain_family: String,
    pub public_key: String,
    pub script_hash: String,
    pub address: String,
}

pub struct CustodyClient<T: HttpTransport> {
    transport: T,
    connection: CustodyConnection,
}

impl<T: HttpTransport> CustodyClient<T> {
    pub fn new(transport: T, connection: CustodyConnection) -> Self {
        Self {
            transport,
            connection,
        }
    }

    fn request(&self, method: &str, pathname: &str, body: Option<Value>) -> Result<Value, String> {
        let url = format!("{}{}{}", self.connection.url, CUSTODY_API, pathname);
        let request_body = body.map(|value| value.to_string());
        let reply = if method == "GET" {
            self.transport
                .get_with_bearer(&url, &self.connection.token, self.connection.timeout_ms)
        } else {
            self.transport.post_with_bearer(
                &url,
                &self.connection.token,
                self.connection.timeout_ms,
                &request_body.clone().unwrap_or_default(),
            )
        };
        let (status, text) =
            reply.map_err(|error| format!("custody signer service unreachable: {error}"))?;
        let parsed = if text.is_empty() {
            if (200..300).contains(&status) {
                return Err("custody signer service returned an empty success response".to_string());
            }
            Value::Null
        } else {
            match serde_json::from_str::<Value>(&text) {
                Ok(parsed) => parsed,
                Err(_) if (200..300).contains(&status) => {
                    return Err(
                        "custody signer service returned malformed JSON in a success response"
                            .to_string(),
                    );
                }
                Err(_) => Value::Null,
            }
        };
        if !(200..300).contains(&status) {
            let code = parsed
                .get("code")
                .and_then(Value::as_str)
                .filter(|c| !c.is_empty())
                .unwrap_or("");
            let detail = parsed
                .get("message")
                .and_then(Value::as_str)
                .filter(|m| !m.is_empty())
                .unwrap_or("");
            if !code.is_empty() || !detail.is_empty() {
                let joined = [code, detail]
                    .iter()
                    .filter(|part| !part.is_empty())
                    .cloned()
                    .collect::<Vec<_>>()
                    .join(": ");
                return Err(format!("custody refused ({status}): {joined}"));
            }
            return Err(format!("custody signer service answered {status}"));
        }
        // A 2xx that still says no is a refusal envelope (§5), not a success.
        if parsed.get("allowed").and_then(Value::as_bool) == Some(false) {
            let code = parsed
                .get("code")
                .and_then(Value::as_str)
                .unwrap_or("denied");
            let detail = parsed
                .get("message")
                .and_then(Value::as_str)
                .map(|m| format!(": {m}"))
                .unwrap_or_default();
            return Err(format!("custody refused: {code}{detail}"));
        }
        if !parsed.is_object() {
            return Err(
                "custody signer service returned a non-object success response".to_string(),
            );
        }
        Ok(parsed)
    }

    /// `GET /keys/{keyId}` — the public identity, never a secret. No cache on
    /// purpose: a rotated key must never keep signing under a stale identity.
    pub fn key_info(&self, key_id: &str) -> Result<CustodyKeyIdentity, String> {
        let pathname = format!("/keys/{}", urlencoded(key_id));
        let parsed = self.request("GET", &pathname, None)?;
        require_allowed_success(&parsed, "key identity")?;
        require_nonempty_string_fields(
            &parsed,
            "key identity",
            &[
                "key_id",
                "chain_family",
                "public_key",
                "script_hash",
                "address",
            ],
        )?;
        let chain_family = string_field(&parsed, "chain_family");
        if chain_family != "neo-n3" {
            return Err(format!(
                "custody signer service key identity response has incompatible chain_family {chain_family}; expected neo-n3"
            ));
        }
        Ok(CustodyKeyIdentity {
            chain_family,
            public_key: string_field(&parsed, "public_key"),
            script_hash: string_field(&parsed, "script_hash"),
            address: string_field(&parsed, "address"),
        })
    }

    /// `POST /sign/raw` — digest/preimage signing for allow_raw keys. The
    /// bytes are signed as-is (SHA-256 then ECDSA inside the enclave); policy
    /// lives on the key's allow_raw boundary, not on the request.
    pub fn sign_raw(&self, key_id: &str, data_hex: &str) -> Result<Value, String> {
        let parsed = self.request(
            "POST",
            "/sign/raw",
            Some(json!({ "key_id": key_id, "data_hex": data_hex })),
        )?;
        require_allowed_success(&parsed, "raw signature")?;
        require_nonempty_string_fields(
            &parsed,
            "raw signature",
            &[
                "key_id",
                "script_hash",
                "address",
                "digest",
                "signature",
                "public_key",
                "invocation_script",
                "verification_script",
            ],
        )?;
        Ok(parsed)
    }

    /// `POST /sign/transaction` — the unsigned serialization goes in, the
    /// complete witness scripts come back.
    pub fn sign_transaction(&self, key_id: &str, unsigned_hex: &str) -> Result<Value, String> {
        let parsed = self.request(
            "POST",
            "/sign/transaction",
            Some(json!({ "key_id": key_id, "unsigned_hex": unsigned_hex })),
        )?;
        require_allowed_success(&parsed, "transaction signature")?;
        require_nonempty_string_fields(
            &parsed,
            "transaction signature",
            &[
                "key_id",
                "script_hash",
                "address",
                "digest",
                "invocation_script",
                "verification_script",
            ],
        )?;
        Ok(parsed)
    }
}

fn validate_custody_url(raw: &str) -> Result<(), String> {
    let parsed = url::Url::parse(raw)
        .map_err(|_| "custody signer service URL must be an absolute http(s) URL".to_string())?;
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("custody signer service URL must not contain userinfo".to_string());
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Err("custody signer service URL must not contain a query or fragment".to_string());
    }
    match parsed.scheme() {
        "https" => Ok(()),
        "http" if custody_host_is_loopback(&parsed) => Ok(()),
        "http" => {
            Err("custody signer service URL may use plaintext HTTP only on loopback".to_string())
        }
        _ => Err("custody signer service URL must use http or https".to_string()),
    }
}

fn custody_host_is_loopback(url: &url::Url) -> bool {
    match url.host() {
        Some(url::Host::Domain(host)) => host.eq_ignore_ascii_case("localhost"),
        Some(url::Host::Ipv4(address)) => address.is_loopback(),
        Some(url::Host::Ipv6(address)) => address.is_loopback(),
        None => false,
    }
}

fn require_allowed_success(value: &Value, context: &str) -> Result<(), String> {
    if value.get("allowed").and_then(Value::as_bool) == Some(true) {
        Ok(())
    } else {
        Err(format!(
            "custody signer service {context} response is missing allowed=true"
        ))
    }
}

fn require_nonempty_string_fields(
    value: &Value,
    context: &str,
    fields: &[&str],
) -> Result<(), String> {
    for field in fields {
        let present = value
            .get(*field)
            .and_then(Value::as_str)
            .is_some_and(|field_value| !field_value.trim().is_empty());
        if !present {
            return Err(format!(
                "custody signer service {context} response is missing non-empty {field}"
            ));
        }
    }
    Ok(())
}

fn string_field(value: &Value, field: &str) -> String {
    value
        .get(field)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn urlencoded(text: &str) -> String {
    let mut out = String::new();
    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    struct ScriptedTransport {
        calls: Mutex<Vec<(String, String, String, u64)>>,
        status: u16,
        body: String,
    }

    impl ScriptedTransport {
        fn new(status: u16, body: &str) -> Self {
            Self {
                calls: Mutex::new(Vec::new()),
                status,
                body: body.to_string(),
            }
        }
    }

    impl HttpTransport for ScriptedTransport {
        fn post(&self, url: &str, body: &str) -> Result<(u16, String), String> {
            self.calls
                .lock()
                .unwrap()
                .push((url.to_string(), body.to_string(), String::new(), 0));
            Ok((self.status, self.body.clone()))
        }
        fn get(&self, url: &str) -> Result<(u16, String), String> {
            self.calls
                .lock()
                .unwrap()
                .push((url.to_string(), String::new(), String::new(), 0));
            Ok((self.status, self.body.clone()))
        }

        fn post_with_bearer(
            &self,
            url: &str,
            token: &str,
            timeout_ms: u64,
            body: &str,
        ) -> Result<(u16, String), String> {
            self.calls.lock().unwrap().push((
                url.to_string(),
                body.to_string(),
                token.to_string(),
                timeout_ms,
            ));
            Ok((self.status, self.body.clone()))
        }

        fn get_with_bearer(
            &self,
            url: &str,
            token: &str,
            timeout_ms: u64,
        ) -> Result<(u16, String), String> {
            self.calls.lock().unwrap().push((
                url.to_string(),
                String::new(),
                token.to_string(),
                timeout_ms,
            ));
            Ok((self.status, self.body.clone()))
        }
    }

    fn connection() -> CustodyConnection {
        CustodyConnection::new(
            "https://signer.example/".to_string(),
            "token-1".to_string(),
            Some(5000),
        )
        .expect("valid connection")
    }

    #[test]
    fn key_info_hits_the_identity_endpoint_with_a_bearer_token() {
        let body = serde_json::json!({
            "allowed": true,
            "key_id": "updater-key",
            "chain_family": "neo-n3",
            "public_key": "0315b41f",
            "script_hash": "0x3124a38a",
            "address": "NeFG5A79AJovUz4BStpnmFyQChLvQkuW72"
        });
        let transport = ScriptedTransport::new(200, &body.to_string());
        let client = CustodyClient::new(&transport, connection());
        let identity = client.key_info("updater-key").expect("identity");

        assert_eq!(identity.chain_family, "neo-n3");
        assert_eq!(identity.public_key, "0315b41f");
        let calls = transport.calls.lock().unwrap();
        let (url, _, token, timeout_ms) = &calls[0];
        assert!(url.starts_with("https://signer.example/signer/api/v1/keys/updater-key"));
        assert_eq!(token, "token-1");
        assert_eq!(*timeout_ms, 5000);
    }

    #[test]
    fn refusal_envelopes_fail_even_on_a_2xx() {
        let transport = ScriptedTransport::new(
            200,
            r#"{"allowed": false, "code": "policy_denied", "message": "not allow_raw"}"#,
        );
        let client = CustodyClient::new(&transport, connection());
        let error = client.sign_raw("key", "aabb").expect_err("refused");
        assert_eq!(error, "custody refused: policy_denied: not allow_raw");
    }

    #[test]
    fn http_errors_format_the_code_and_message() {
        let transport = ScriptedTransport::new(403, r#"{"code": "bad_key", "message": "unknown"}"#);
        let client = CustodyClient::new(&transport, connection());
        let error = client.sign_transaction("key", "00").expect_err("refused");
        assert_eq!(error, "custody refused (403): bad_key: unknown");

        let transport = ScriptedTransport::new(500, r#"{}"#);
        let client = CustodyClient::new(&transport, connection());
        let error = client.sign_transaction("key", "00").expect_err("no detail");
        assert_eq!(error, "custody signer service answered 500");
    }

    #[test]
    fn sign_transaction_posts_the_unsigned_hex() {
        let transport = ScriptedTransport::new(
            200,
            r#"{"allowed":true,"key_id":"updater-key","script_hash":"0x3124a38a","address":"NeFG5A79AJovUz4BStpnmFyQChLvQkuW72","digest":"aabb","invocation_script":"40aa","verification_script":"0c2103"}"#,
        );
        let client = CustodyClient::new(&transport, connection());
        let signed = client
            .sign_transaction("updater-key", "00aabb")
            .expect("signed");
        assert_eq!(
            signed.get("invocation_script").and_then(Value::as_str),
            Some("40aa")
        );
        let calls = transport.calls.lock().unwrap();
        assert!(calls[0].1.contains("\"unsigned_hex\":\"00aabb\""));
        assert!(calls[0].1.contains("\"key_id\":\"updater-key\""));
        assert_eq!(calls[0].2, "token-1");
        assert_eq!(calls[0].3, 5000);
    }

    #[test]
    fn malformed_or_incomplete_2xx_responses_fail_closed() {
        for body in ["", "not-json", "[]", "{}"] {
            let transport = ScriptedTransport::new(200, body);
            let client = CustodyClient::new(&transport, connection());
            assert!(client
                .sign_transaction("updater-key", "00aabb")
                .expect_err("invalid success response must fail")
                .contains("custody signer service"));
        }

        let transport = ScriptedTransport::new(
            200,
            r#"{"allowed":true,"key_id":"updater-key","script_hash":"0x3124a38a","address":"Nabc","digest":"aabb","invocation_script":"40aa"}"#,
        );
        let client = CustodyClient::new(&transport, connection());
        let error = client
            .sign_transaction("updater-key", "00aabb")
            .expect_err("missing witness field must fail");
        assert!(error.contains("verification_script"));

        let transport = ScriptedTransport::new(
            200,
            r#"{"allowed":true,"key_id":"updater-key","chain_family":"neo-n3","public_key":"0315b41f","script_hash":"0x3124a38a"}"#,
        );
        let client = CustodyClient::new(&transport, connection());
        let error = client
            .key_info("updater-key")
            .expect_err("missing identity field must fail");
        assert!(error.contains("address"));
    }

    #[test]
    fn key_identity_requires_explicit_allow_and_the_neo_n3_family() {
        let complete_without_allow = r#"{"key_id":"updater-key","chain_family":"neo-n3","public_key":"0315b41f","script_hash":"0x3124a38a","address":"Nabc"}"#;
        let client = CustodyClient::new(
            ScriptedTransport::new(200, complete_without_allow),
            connection(),
        );
        assert!(client
            .key_info("updater-key")
            .expect_err("missing allow must fail")
            .contains("missing allowed=true"));

        let denied = r#"{"allowed":false,"key_id":"updater-key","chain_family":"neo-n3","public_key":"0315b41f","script_hash":"0x3124a38a","address":"Nabc"}"#;
        let client = CustodyClient::new(ScriptedTransport::new(200, denied), connection());
        assert!(client
            .key_info("updater-key")
            .expect_err("denied identity must fail")
            .starts_with("custody refused:"));

        let wrong_family = r#"{"allowed":true,"key_id":"updater-key","chain_family":"neox","public_key":"0315b41f","script_hash":"0x3124a38a","address":"Nabc"}"#;
        let client = CustodyClient::new(ScriptedTransport::new(200, wrong_family), connection());
        let error = client
            .key_info("updater-key")
            .expect_err("wrong family must fail");
        assert!(error.contains("incompatible chain_family neox; expected neo-n3"));
    }

    #[test]
    fn missing_connection_fields_fail_closed() {
        assert!(CustodyConnection::new(String::new(), "token".to_string(), None).is_err());
        assert!(CustodyConnection::new("https://signer".to_string(), String::new(), None).is_err());
    }

    #[test]
    fn custody_url_requires_tls_except_on_loopback() {
        for url in [
            "https://signer.example",
            "http://localhost:8789",
            "http://127.0.0.1:8789",
            "http://127.42.0.9:8789",
            "http://[::1]:8789",
        ] {
            CustodyConnection::new(url.to_string(), "token".to_string(), None)
                .unwrap_or_else(|error| panic!("{url} must be accepted: {error}"));
        }

        for url in [
            "http://signer.example",
            "ftp://signer.example",
            "https://user:pass@signer.example",
            "https://signer.example?token=secret",
            "https://signer.example/#fragment",
        ] {
            assert!(
                CustodyConnection::new(url.to_string(), "token".to_string(), None).is_err(),
                "{url} must be rejected"
            );
        }
    }

    #[test]
    fn custody_key_id_formats_the_env_hint() {
        let ids = serde_json::json!({ "updater": "key-1" });
        assert_eq!(custody_key_id(&ids, "updater").unwrap(), "key-1");
        let error = custody_key_id(&ids, "fee_funder").expect_err("missing");
        assert_eq!(
            error,
            "custody key for role fee_funder is not provisioned (SIGNER_ROLE_FEE_FUNDER_KEY_ID)"
        );
    }
}
