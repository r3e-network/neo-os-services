//! The custody-backed signing plane: the host's client for the separate
//! custody enclave. Everything here speaks the custody service's own §5
//! caller contract — a registered caller token, `GET /signer/api/v1/keys/{id}`
//! for a role's identity, `POST /signer/api/v1/sign/raw` for the blind
//! signature — because the plan's line on the split is that the enclave host
//! calls custody as a caller, not as a special insider: grants, the `allow_raw`
//! boundary and the audit trail all apply to the host's calls exactly as they
//! do to any external one.
//!
//! The host never holds a key. What it holds is configuration: which custody
//! base URL to call, the bearer token that identifies it there, and the
//! key id each signing role pins. The URL and role ids are immutable measured
//! image configuration. Only the caller token is released from a
//! purpose/network-bound KMS ciphertext during the one-shot provision
//! ceremony. With no complete configuration the plane reports the same
//! fail-closed unconfigured state.

use std::sync::{Arc, RwLock};

use crate::http_error;
use crate::overlay::EnvOverlay;
use crate::state::{RoleReport, SignerPlane};
use crate::RuntimeError;

/// The custody service's base URL, read per call.
pub const SIGNER_SERVICE_URL: &str = "SIGNER_SERVICE_URL";
/// The bearer token that identifies the host at the custody service, read per
/// call. Production accepts it only with the internal Nitro Recipient KMS
/// source marker; the custody service audits every call the host makes under
/// it.
pub const SIGNER_SERVICE_TOKEN: &str = "SIGNER_SERVICE_TOKEN";

/// `SIGNER_ROLE_{ROLE}_KEY_ID` — the custody key a role pins, uppercased with
/// the role's own casing preserved (`oracle_verifier` →
/// `SIGNER_ROLE_ORACLE_VERIFIER_KEY_ID`).
pub fn role_key_id_env(role: &str) -> String {
    format!("SIGNER_ROLE_{}_KEY_ID", role.to_ascii_uppercase())
}

/// One custody call, resolved. The transport maps this onto HTTP (Bearer
/// header, JSON body) so the tests' fake can see exactly what the plane asked
/// for — URL, credential and all — without standing up a socket.
#[derive(Debug, Clone, PartialEq)]
pub struct CustodyRequest {
    pub method: &'static str,
    pub url: String,
    pub token: Option<String>,
    pub body: Option<serde_json::Value>,
}

/// A custody answer kept raw: status and parsed JSON. A non-2xx is still
/// `Ok` — the caller decides what a refusal means for its own route.
#[derive(Debug, Clone, PartialEq)]
pub struct CustodyReply {
    pub status: u16,
    pub body: serde_json::Value,
}

/// The wire in front of the custody service. Errors are transport failures —
/// connect, timeout, an answer that is not JSON — as strings; custody's own
/// refusals arrive as [`CustodyReply`]s.
pub trait CustodyTransport: Send + Sync {
    fn send(&self, request: CustodyRequest) -> Result<CustodyReply, String>;
}

/// The production transport: blocking reqwest over the loopback/vsock channel.
/// Dispatch runs off the async workers already (see the bin's
/// `spawn_blocking`), so a blocking client is the honest shape — and the same
/// one nitro-attest's KMS transport uses.
#[derive(Debug, Clone)]
pub struct ReqwestCustodyTransport {
    client: reqwest::blocking::Client,
}

impl Default for ReqwestCustodyTransport {
    fn default() -> Self {
        Self::new()
    }
}

impl ReqwestCustodyTransport {
    pub fn new() -> Self {
        ReqwestCustodyTransport {
            client: reqwest::blocking::Client::builder()
                .timeout(std::time::Duration::from_secs(10))
                .build()
                .expect("a loopback HTTP client always builds"),
        }
    }
}

impl CustodyTransport for ReqwestCustodyTransport {
    fn send(&self, request: CustodyRequest) -> Result<CustodyReply, String> {
        let method = reqwest::Method::from_bytes(request.method.as_bytes())
            .map_err(|error| format!("{error}"))?;
        let mut call = self.client.request(method, &request.url);
        if let Some(token) = &request.token {
            call = call.bearer_auth(token);
        }
        if let Some(body) = &request.body {
            call = call
                .header("content-type", "application/json")
                .body(serde_json::to_string(body).map_err(|error| error.to_string())?);
        }
        let response = call.send().map_err(|error| error.to_string())?;
        let status = response.status().as_u16();
        let text = response.text().map_err(|error| error.to_string())?;
        let body: serde_json::Value = serde_json::from_str(&text)
            .map_err(|error| format!("custody answer was not JSON: {error}"))?;
        Ok(CustodyReply { status, body })
    }
}

/// The custody key row a `GET /signer/api/v1/keys/{id}` answers — the fields
/// the plane consumes. Parsed leniently (absent optional fields are null in
/// the JSON) and interpreted strictly (a wrong network or a disabled key is a
/// contradiction, not a default).
#[derive(Debug, Clone, PartialEq)]
struct CustodyKey {
    network: Option<String>,
    network_magic: Option<u32>,
    public_key: Option<String>,
    address: Option<String>,
    script_hash: Option<String>,
    signing_enabled: bool,
}

impl CustodyKey {
    fn from_body(body: &serde_json::Value) -> Self {
        CustodyKey {
            network: body
                .get("network")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string),
            network_magic: body
                .get("network_magic")
                .and_then(serde_json::Value::as_u64)
                .and_then(|value| u32::try_from(value).ok()),
            public_key: body
                .get("public_key")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string),
            address: body
                .get("address")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string),
            script_hash: body
                .get("script_hash")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string),
            signing_enabled: body
                .get("signing_enabled")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false),
        }
    }
}

/// The per-call custody configuration, read from the live overlay.
#[derive(Debug, Clone, PartialEq)]
struct CustodyConfig {
    base_url: String,
    token: Option<String>,
}

/// The signing plane of a host that reaches its keys through the custody
/// service. `role_report` resolves a role's pinned key identity; `sign_payload`
/// blind-signs through `/sign/raw`. Neither touches key material — the
/// signatures leave the custody enclave already made.
pub struct CustodySigner {
    overlay: Arc<RwLock<EnvOverlay>>,
    transport: Box<dyn CustodyTransport>,
}

impl CustodySigner {
    pub fn new(overlay: Arc<RwLock<EnvOverlay>>, transport: Box<dyn CustodyTransport>) -> Self {
        CustodySigner { overlay, transport }
    }

    fn config(&self) -> Option<CustodyConfig> {
        let overlay = self.overlay.read().expect("overlay lock");
        let base_url = overlay.get_trimmed(SIGNER_SERVICE_URL)?;
        let token = overlay.get_trimmed(SIGNER_SERVICE_TOKEN)?;
        if overlay
            .get_trimmed("NODE_ENV")
            .is_some_and(|value| value.eq_ignore_ascii_case("production"))
            && overlay
                .get_trimmed("SIGNER_SERVICE_TOKEN_SOURCE")
                .as_deref()
                != Some("nitro-recipient-kms")
        {
            return None;
        }
        Some(CustodyConfig {
            base_url,
            token: Some(token),
        })
    }

    fn keys_url(base_url: &str, key_id: &str) -> String {
        format!(
            "{}/signer/api/v1/keys/{}",
            base_url.trim_end_matches('/'),
            key_id
        )
    }

    fn sign_raw_url(base_url: &str) -> String {
        format!("{}/signer/api/v1/sign/raw", base_url.trim_end_matches('/'))
    }

    fn report_unreachable(role: &str, message: &str) -> RoleReport {
        RoleReport {
            issues: vec![format!(
                "{role}: the custody service is unreachable: {message}"
            )],
            ..RoleReport::not_configured()
        }
    }
}

impl SignerPlane for CustodySigner {
    fn role_report(&self, network: &str, role: &str) -> RoleReport {
        // No custody connection configured: the fail-closed state every
        // surface already knew how to render.
        let Some(config) = self.config() else {
            return RoleReport {
                issues: vec![format!("{role}: no custody signing plane is connected")],
                ..RoleReport::not_configured()
            };
        };
        let key_id_env = role_key_id_env(role);
        let Some(key_id) = self
            .overlay
            .read()
            .expect("overlay lock")
            .get_trimmed(&key_id_env)
        else {
            return RoleReport {
                issues: vec![format!("{role}: no custody key is pinned ({key_id_env})")],
                ..RoleReport::not_configured()
            };
        };

        let reply = match self.transport.send(CustodyRequest {
            method: "GET",
            url: Self::keys_url(&config.base_url, &key_id),
            token: config.token,
            body: None,
        }) {
            Ok(reply) => reply,
            Err(message) => return Self::report_unreachable(role, &message),
        };
        if reply.status != 200 {
            return RoleReport {
                issues: vec![format!(
                    "{role}: the custody service refused the key read ({} {})",
                    reply.status,
                    reply
                        .body
                        .get("code")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("no code")
                )],
                ..RoleReport::not_configured()
            };
        }
        let key = CustodyKey::from_body(&reply.body);
        let public_key = key.public_key.clone().unwrap_or_default();

        // The key must be this network's key. A custody row for mainnet pinned
        // as the testnet updater would sign testnet payloads with mainnet
        // authority — the registry check exists so that cannot pass silently.
        if key.network.as_deref() != Some(network) {
            return RoleReport {
                issues: vec![format!(
                    "{role}: custody key {key_id} is on {}, not {network}",
                    key.network.as_deref().unwrap_or("no network")
                )],
                ..RoleReport::not_configured()
            };
        }
        let expected_magic = match network {
            "mainnet" => 860_833_102,
            "testnet" => 894_710_606,
            _ => 0,
        };
        if expected_magic == 0 || key.network_magic != Some(expected_magic) {
            return RoleReport {
                issues: vec![format!(
                    "{role}: custody key {key_id} has network magic {}, expected {expected_magic}",
                    key.network_magic
                        .map_or_else(|| "missing".to_string(), |value| value.to_string())
                )],
                ..RoleReport::not_configured()
            };
        }
        if !key.signing_enabled {
            return RoleReport {
                issues: vec![format!("{role}: custody key {key_id} is disabled")],
                ..RoleReport::not_configured()
            };
        }
        let address = key.address.clone().unwrap_or_default();
        let script_hash = key.script_hash.clone().unwrap_or_default();
        if public_key.is_empty() || address.is_empty() || script_hash.is_empty() {
            return RoleReport {
                issues: vec![format!(
                    "{role}: custody key {key_id} has incomplete public identity"
                )],
                ..RoleReport::not_configured()
            };
        }

        RoleReport {
            ok: true,
            materialized: true,
            identity: serde_json::json!({
                "address": address,
                "script_hash": script_hash,
                "public_key": public_key,
                "network_magic": expected_magic,
            }),
            public_key,
            issues: Vec::new(),
            key_source: "custody".to_string(),
        }
    }

    fn sign_payload(
        &self,
        network: &str,
        role: &str,
        data_hex: &str,
    ) -> Result<serde_json::Value, RuntimeError> {
        // The same 503 the shim produced with no plane at all: /sign/payload's
        // callers know exactly one unconfigured answer, and the configured
        // host answers it too when custody is not connected.
        let Some(config) = self.config() else {
            return Err(unconfigured_error(role));
        };
        let key_id_env = role_key_id_env(role);
        let Some(key_id) = self
            .overlay
            .read()
            .expect("overlay lock")
            .get_trimmed(&key_id_env)
        else {
            return Err(unconfigured_error(role));
        };

        let reply = self
            .transport
            .send(CustodyRequest {
                method: "POST",
                url: Self::sign_raw_url(&config.base_url),
                token: config.token,
                body: Some(serde_json::json!({
                    "key_id": key_id,
                    "data_hex": data_hex,
                })),
            })
            .map_err(|message| {
                http_error(
                    503,
                    format!("{role} signer could not reach the custody service: {message}"),
                )
            })?;
        if reply.status != 200 {
            // Custody's refusal codes are curated wire vocabulary (§5) — no
            // key material, bounded sentences — so they surface to the host's
            // caller as the reason, with the custody code named for the log.
            let code = reply
                .body
                .get("code")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("no code");
            let message = reply
                .body
                .get("message")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("the custody service refused the signature");
            return Err(http_error(
                reply.status,
                format!("{role} signer refused by custody ({code}): {message}"),
            ));
        }
        // The merged server's /sign/payload body, with custody's values: the
        // bare signature hex, the public key, the account, and the script hash
        // in the custody service's `0x` explorer form (the same order neon-js
        // derives from the address). `key_id` is additive — it names which
        // pinned key signed, which a cutover consumer checks against the
        // registry.
        Ok(serde_json::json!({
            "status": "ok",
            "network": network,
            "role": role,
            "signature": reply.body["signature"],
            "signature_hex": reply.body["signature"],
            "public_key": reply.body["public_key"],
            "address": reply.body["address"],
            "script_hash": reply.body["script_hash"],
            "key_id": reply.body["key_id"],
            "key_source": "custody",
        }))
    }
}

fn unconfigured_error(role: &str) -> RuntimeError {
    http_error(
        503,
        format!("{role} signer is not configured or does not match pinned identity"),
    )
}

#[cfg(test)]
#[path = "../tests/unit/custody.rs"]
mod tests;
