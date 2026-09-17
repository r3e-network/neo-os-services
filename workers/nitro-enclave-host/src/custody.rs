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

use k256::ecdsa::{RecoveryId, Signature as K256Signature, VerifyingKey as K256VerifyingKey};
use neo_os_chain_evm::{build_neox_digest, eip191_message_hash};
use neo_os_core::n3_tx::{
    address_from_script_hash, script_hash_from_public_key, verification_script_single_sig,
};
use p256::ecdsa::{
    signature::Verifier, Signature as P256Signature, VerifyingKey as P256VerifyingKey,
};
use sha2::Sha256;
use sha3::{Digest, Keccak256};

use crate::http_error;
use crate::overlay::EnvOverlay;
use crate::state::{Eip191FulfillmentRequest, RoleReport, SignerPlane};
use crate::RuntimeError;
use url::{Host, Url};

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
                // A custody redirect is never part of the caller contract.
                // Following one would replay the bearer credential to a URL
                // chosen by the response, potentially outside the custody
                // trust boundary.
                .redirect(reqwest::redirect::Policy::none())
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
    allowed: bool,
    key_id: Option<String>,
    network: Option<String>,
    chain_family_present: bool,
    chain_family: Option<String>,
    chain_id: Option<u64>,
    network_magic: Option<u32>,
    public_key: Option<String>,
    address: Option<String>,
    script_hash: Option<String>,
    verification_script: Option<String>,
    signing_enabled: bool,
}

impl CustodyKey {
    fn from_body(body: &serde_json::Value) -> Self {
        CustodyKey {
            allowed: body
                .get("allowed")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false),
            key_id: nonempty_string(body, "key_id"),
            network: body
                .get("network")
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string),
            chain_family_present: body.get("chain_family").is_some(),
            chain_family: body
                .get("chain_family")
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string),
            chain_id: body.get("chain_id").and_then(serde_json::Value::as_u64),
            network_magic: body
                .get("network_magic")
                .and_then(serde_json::Value::as_u64)
                .and_then(|value| u32::try_from(value).ok()),
            public_key: nonempty_string(body, "public_key"),
            address: nonempty_string(body, "address"),
            script_hash: nonempty_string(body, "script_hash"),
            verification_script: nonempty_string(body, "verification_script"),
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
    base_url: Url,
    token: String,
}

impl CustodyConfig {
    /// Build one live custody configuration only after establishing its
    /// transport boundary. HTTPS may address a remote custody service; clear
    /// text HTTP is deliberately limited to the local Nitro/loopback bridge.
    fn new(base_url: &str, token: String) -> Result<Self, &'static str> {
        let parsed = Url::parse(base_url)
            .map_err(|_| "SIGNER_SERVICE_URL must be an absolute HTTP(S) URL")?;
        if !matches!(parsed.scheme(), "http" | "https") {
            return Err("SIGNER_SERVICE_URL must use HTTP or HTTPS");
        }
        if parsed.cannot_be_a_base() || parsed.host().is_none() {
            return Err("SIGNER_SERVICE_URL must name a host");
        }
        if !parsed.username().is_empty()
            || parsed.password().is_some()
            || authority_contains_userinfo(base_url)
        {
            return Err("SIGNER_SERVICE_URL must not contain user information");
        }
        if parsed.fragment().is_some() {
            return Err("SIGNER_SERVICE_URL must not contain a fragment");
        }
        if parsed.query().is_some() {
            return Err("SIGNER_SERVICE_URL must not contain a query");
        }
        if parsed.scheme() == "http" && !parsed.host().is_some_and(is_loopback_host) {
            return Err("clear-text SIGNER_SERVICE_URL is allowed only on loopback");
        }
        Ok(CustodyConfig {
            base_url: parsed,
            token,
        })
    }
}

fn authority_contains_userinfo(raw_url: &str) -> bool {
    let Some(delimiter) = raw_url.find("://") else {
        return false;
    };
    let authority = &raw_url[delimiter + 3..];
    let end = authority.find(['/', '?', '#']).unwrap_or(authority.len());
    authority[..end].contains('@')
}

fn is_loopback_host(host: Host<&str>) -> bool {
    match host {
        Host::Domain(domain) => domain.eq_ignore_ascii_case("localhost"),
        Host::Ipv4(address) => address.is_loopback(),
        Host::Ipv6(address) => {
            address.is_loopback() || address.to_ipv4().is_some_and(|mapped| mapped.is_loopback())
        }
    }
}

fn nonempty_string(body: &serde_json::Value, field: &str) -> Option<String> {
    body.get(field)
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
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

    fn config(&self) -> Result<Option<CustodyConfig>, &'static str> {
        let overlay = self.overlay.read().expect("overlay lock");
        let Some(base_url) = overlay.get_trimmed(SIGNER_SERVICE_URL) else {
            return Ok(None);
        };
        let Some(token) = overlay.get_trimmed(SIGNER_SERVICE_TOKEN) else {
            return Ok(None);
        };
        if overlay
            .get_trimmed("NODE_ENV")
            .is_some_and(|value| value.eq_ignore_ascii_case("production"))
            && overlay
                .get_trimmed("SIGNER_SERVICE_TOKEN_SOURCE")
                .as_deref()
                != Some("nitro-recipient-kms")
        {
            return Ok(None);
        }
        CustodyConfig::new(&base_url, token).map(Some)
    }

    fn endpoint_url(base_url: &Url, path: &[&str]) -> Result<String, &'static str> {
        let mut endpoint = base_url.clone();
        endpoint
            .path_segments_mut()
            .map_err(|()| "SIGNER_SERVICE_URL cannot be used as a base URL")?
            .pop_if_empty()
            .extend(path.iter().copied());
        Ok(endpoint.into())
    }

    fn keys_url(base_url: &Url, key_id: &str) -> Result<String, &'static str> {
        // The URL standard treats these two exact values as navigation rather
        // than data, and `Url::path_segments_mut` therefore drops them. No
        // portable HTTP spelling can guarantee that every proxy preserves a
        // percent-encoded dot segment, so fail closed instead of addressing a
        // different custody route.
        if matches!(key_id, "." | "..") {
            return Err("custody key_id must not be a dot path segment");
        }
        Self::endpoint_url(base_url, &["signer", "api", "v1", "keys", key_id])
    }

    fn sign_raw_url(base_url: &Url) -> Result<String, &'static str> {
        Self::endpoint_url(base_url, &["signer", "api", "v1", "sign", "raw"])
    }

    fn sign_transaction_url(base_url: &Url) -> Result<String, &'static str> {
        Self::endpoint_url(base_url, &["signer", "api", "v1", "sign", "transaction"])
    }

    fn sign_eip191_fulfillment_url(base_url: &Url) -> Result<String, &'static str> {
        Self::endpoint_url(
            base_url,
            &["signer", "api", "v1", "sign", "eip191-fulfillment"],
        )
    }

    fn report_unreachable(role: &str, message: &str) -> RoleReport {
        RoleReport {
            issues: vec![format!(
                "{role}: the custody service is unreachable: {message}"
            )],
            ..RoleReport::not_configured()
        }
    }

    fn report_invalid_config(role: &str, message: &str) -> RoleReport {
        RoleReport {
            issues: vec![format!(
                "{role}: the custody service configuration is invalid: {message}"
            )],
            ..RoleReport::not_configured()
        }
    }

    fn report_invalid_key_response(role: &str, message: &str) -> RoleReport {
        RoleReport {
            issues: vec![format!(
                "{role}: the custody service returned an invalid key response: {message}"
            )],
            ..RoleReport::not_configured()
        }
    }
}

impl SignerPlane for CustodySigner {
    fn role_report(&self, network: &str, role: &str) -> RoleReport {
        // No custody connection configured: the fail-closed state every
        // surface already knew how to render.
        let config = match self.config() {
            Ok(Some(config)) => config,
            Ok(None) => {
                return RoleReport {
                    issues: vec![format!("{role}: no custody signing plane is connected")],
                    ..RoleReport::not_configured()
                }
            }
            Err(message) => return Self::report_invalid_config(role, message),
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

        let url = match Self::keys_url(&config.base_url, &key_id) {
            Ok(url) => url,
            Err(message) => return Self::report_invalid_config(role, message),
        };
        let reply = match self.transport.send(CustodyRequest {
            method: "GET",
            url,
            token: Some(config.token),
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
        if !key.allowed {
            return Self::report_invalid_key_response(role, "allowed was not true");
        }
        if key.key_id.as_deref() != Some(key_id.as_str()) {
            return Self::report_invalid_key_response(role, "key_id was missing or did not match");
        }
        let neox_role = role.starts_with("neox_");
        let expected_family = if neox_role { "neox" } else { "neo-n3" };
        if key.chain_family_present && key.chain_family.as_deref() != Some(expected_family) {
            return Self::report_invalid_key_response(
                role,
                &format!("chain_family was not {expected_family}"),
            );
        }
        let Some(public_key) = key.public_key.clone() else {
            return Self::report_invalid_key_response(role, "public identity was incomplete");
        };

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
        let expected_magic = neo_os_core::network_identity::known_neo_n3_identity(network)
            .map(|identity| identity.magic)
            .unwrap_or(0);
        let expected_chain_id = match network {
            "mainnet" => 47_763,
            "testnet" => 12_227_332,
            _ => 0,
        };
        if neox_role {
            if expected_chain_id == 0 || key.chain_id != Some(expected_chain_id) {
                return RoleReport {
                    issues: vec![format!(
                        "{role}: custody key {key_id} has NeoX chain id {}, expected {expected_chain_id}",
                        key.chain_id
                            .map_or_else(|| "missing".to_string(), |value| value.to_string())
                    )],
                    ..RoleReport::not_configured()
                };
            }
        } else if expected_magic == 0 || key.network_magic != Some(expected_magic) {
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
        let (Some(address), Some(script_hash)) = (key.address.clone(), key.script_hash.clone())
        else {
            return Self::report_invalid_key_response(role, "public identity was incomplete");
        };
        if !neox_role && key.verification_script.as_deref().is_none_or(str::is_empty) {
            return Self::report_invalid_key_response(role, "public identity was incomplete");
        }

        RoleReport {
            ok: true,
            materialized: true,
            identity: serde_json::json!({
                "address": address,
                "script_hash": script_hash,
                "public_key": public_key,
                "network_magic": (!neox_role).then_some(expected_magic),
                "chain_id": neox_role.then_some(expected_chain_id),
                "chain_family": expected_family,
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
        let config = match self.config() {
            Ok(Some(config)) => config,
            Ok(None) => return Err(unconfigured_error(role)),
            Err(message) => {
                return Err(http_error(
                    503,
                    format!("{role} signer custody service configuration is invalid: {message}"),
                ))
            }
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

        let url = Self::sign_raw_url(&config.base_url).map_err(|message| {
            http_error(
                503,
                format!("{role} signer custody service configuration is invalid: {message}"),
            )
        })?;
        let reply = self
            .transport
            .send(CustodyRequest {
                method: "POST",
                url,
                token: Some(config.token),
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
        if reply
            .body
            .get("allowed")
            .and_then(serde_json::Value::as_bool)
            != Some(true)
        {
            return Err(invalid_response_error(role, "allowed was not true"));
        }
        if reply
            .body
            .get("chain_family")
            .is_some_and(|family| family.as_str() != Some("neo-n3"))
        {
            return Err(invalid_response_error(role, "chain_family was not neo-n3"));
        }
        let response_key_id = required_response_field(role, &reply.body, "key_id")?;
        if response_key_id != key_id {
            return Err(invalid_response_error(role, "key_id did not match"));
        }
        let script_hash = required_response_field(role, &reply.body, "script_hash")?;
        let address = required_response_field(role, &reply.body, "address")?;
        let _digest = required_response_field(role, &reply.body, "digest")?;
        let signature = required_response_field(role, &reply.body, "signature")?;
        let public_key = required_response_field(role, &reply.body, "public_key")?;
        let _invocation_script = required_response_field(role, &reply.body, "invocation_script")?;
        let _verification_script =
            required_response_field(role, &reply.body, "verification_script")?;
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
            "signature": signature,
            "signature_hex": signature,
            "public_key": public_key,
            "address": address,
            "script_hash": script_hash,
            "key_id": response_key_id,
            "key_source": "custody",
        }))
    }

    fn sign_transaction(
        &self,
        network: &str,
        role: &str,
        chain_id: u64,
        unsigned_hex: &str,
        request_id: &str,
    ) -> Result<serde_json::Value, RuntimeError> {
        let config = match self.config() {
            Ok(Some(config)) => config,
            Ok(None) => return Err(unconfigured_error(role)),
            Err(message) => {
                return Err(http_error(
                    503,
                    format!("{role} signer custody service configuration is invalid: {message}"),
                ))
            }
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

        let url = Self::sign_transaction_url(&config.base_url).map_err(|message| {
            http_error(
                503,
                format!("{role} signer custody service configuration is invalid: {message}"),
            )
        })?;
        let reply = self
            .transport
            .send(CustodyRequest {
                method: "POST",
                url,
                token: Some(config.token),
                body: Some(serde_json::json!({
                    "key_id": key_id,
                    "unsigned_hex": unsigned_hex,
                    "request_id": request_id,
                    "chain_family": "neox",
                    "chain_id": chain_id,
                })),
            })
            .map_err(|message| {
                http_error(
                    503,
                    format!("{role} signer could not reach the custody service: {message}"),
                )
            })?;
        if reply.status != 200 {
            let code = reply
                .body
                .get("code")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("no code");
            let message = reply
                .body
                .get("message")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("the custody service refused the transaction");
            return Err(http_error(
                reply.status,
                format!("{role} signer refused by custody ({code}): {message}"),
            ));
        }
        if reply
            .body
            .get("allowed")
            .and_then(serde_json::Value::as_bool)
            != Some(true)
        {
            return Err(invalid_response_error(role, "allowed was not true"));
        }
        if reply
            .body
            .get("chain_family")
            .and_then(serde_json::Value::as_str)
            != Some("neox")
        {
            return Err(invalid_response_error(role, "chain_family was not neox"));
        }
        let response_key_id = required_response_field(role, &reply.body, "key_id")?;
        if response_key_id != key_id {
            return Err(invalid_response_error(role, "key_id did not match"));
        }
        let address = required_response_field(role, &reply.body, "address")?;
        let script_hash = required_response_field(role, &reply.body, "script_hash")?;
        let digest = required_response_field(role, &reply.body, "digest")?;
        let signed_transaction = required_response_field(role, &reply.body, "signed_transaction")?;
        if let Some(alias) = nonempty_string(&reply.body, "signature_hex") {
            if alias != signed_transaction {
                return Err(invalid_response_error(
                    role,
                    "signature_hex did not match signed_transaction",
                ));
            }
        }

        Ok(serde_json::json!({
            "status": "ok",
            "network": network,
            "role": role,
            "chain_family": "neox",
            "chain_id": chain_id,
            "key_id": response_key_id,
            "address": address,
            "script_hash": script_hash,
            "digest": digest,
            "signed_transaction": signed_transaction,
            "signature_hex": signed_transaction,
            "key_source": "custody",
        }))
    }

    fn sign_n3_transaction(
        &self,
        network: &str,
        role: &str,
        unsigned_hex: &str,
        request_id: &str,
    ) -> Result<serde_json::Value, RuntimeError> {
        let config = match self.config() {
            Ok(Some(config)) => config,
            Ok(None) => return Err(unconfigured_error(role)),
            Err(message) => {
                return Err(http_error(
                    503,
                    format!("{role} signer custody service configuration is invalid: {message}"),
                ))
            }
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
        let unsigned = decode_hex(unsigned_hex)
            .filter(|bytes| !bytes.is_empty())
            .ok_or_else(|| invalid_response_error(role, "unsigned transaction was invalid hex"))?;
        let url = Self::sign_transaction_url(&config.base_url).map_err(|message| {
            http_error(
                503,
                format!("{role} signer custody service configuration is invalid: {message}"),
            )
        })?;
        let reply = self
            .transport
            .send(CustodyRequest {
                method: "POST",
                url,
                token: Some(config.token),
                body: Some(serde_json::json!({
                    "key_id": key_id,
                    "unsigned_hex": hex::encode(&unsigned),
                    "request_id": request_id,
                    "chain_family": "neo-n3",
                })),
            })
            .map_err(|message| {
                http_error(
                    503,
                    format!("{role} signer could not reach the custody service: {message}"),
                )
            })?;
        if reply.status != 200 {
            let code = reply
                .body
                .get("code")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("no code");
            let message = reply
                .body
                .get("message")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("the custody service refused the transaction");
            return Err(http_error(
                reply.status,
                format!("{role} signer refused by custody ({code}): {message}"),
            ));
        }
        if reply
            .body
            .get("allowed")
            .and_then(serde_json::Value::as_bool)
            != Some(true)
        {
            return Err(invalid_response_error(role, "allowed was not true"));
        }
        if reply
            .body
            .get("chain_family")
            .and_then(serde_json::Value::as_str)
            != Some("neo-n3")
        {
            return Err(invalid_response_error(role, "chain_family was not neo-n3"));
        }
        let response_key_id = required_response_field(role, &reply.body, "key_id")?;
        if response_key_id != key_id {
            return Err(invalid_response_error(role, "key_id did not match"));
        }
        let response_script_hash = required_response_field(role, &reply.body, "script_hash")?;
        let response_address = required_response_field(role, &reply.body, "address")?;
        let response_digest = required_response_field(role, &reply.body, "digest")?;
        let invocation_hex = required_response_field(role, &reply.body, "invocation_script")?;
        let verification_hex = required_response_field(role, &reply.body, "verification_script")?;
        let invocation = decode_hex(&invocation_hex)
            .filter(|script| script.len() == 66 && script[..2] == [0x0c, 0x40])
            .ok_or_else(|| invalid_response_error(role, "invocation_script was malformed"))?;
        let verification = decode_hex(&verification_hex)
            .ok_or_else(|| invalid_response_error(role, "verification_script was malformed"))?;
        let public_key = verification
            .get(2..35)
            .filter(|_| verification.first() == Some(&0x0c) && verification.get(1) == Some(&0x21))
            .ok_or_else(|| invalid_response_error(role, "verification_script was malformed"))?;
        if verification_script_single_sig(public_key).as_deref() != Some(verification.as_slice()) {
            return Err(invalid_response_error(
                role,
                "verification_script was not a single-signature identity",
            ));
        }
        let script_hash = script_hash_from_public_key(public_key)
            .ok_or_else(|| invalid_response_error(role, "public key was malformed"))?;
        if normalize_0x_hex(&response_script_hash) != hex::encode(script_hash) {
            return Err(invalid_response_error(
                role,
                "script_hash did not match the verification key",
            ));
        }
        if response_address != address_from_script_hash(&script_hash) {
            return Err(invalid_response_error(
                role,
                "address did not match the verification key",
            ));
        }
        let mut digest = Sha256::digest(&unsigned).to_vec();
        digest.reverse();
        if normalize_0x_hex(&response_digest) != hex::encode(digest) {
            return Err(invalid_response_error(
                role,
                "digest did not match the unsigned transaction",
            ));
        }
        let verifying_key = P256VerifyingKey::from_sec1_bytes(public_key)
            .map_err(|_| invalid_response_error(role, "public key was malformed"))?;
        let signature = P256Signature::from_slice(&invocation[2..])
            .map_err(|_| invalid_response_error(role, "signature was malformed"))?;
        let magic = match network {
            "mainnet" => 860_833_102_u32,
            "testnet" => 894_710_606_u32,
            _ => return Err(invalid_response_error(role, "network was unsupported")),
        };
        let mut message = magic.to_le_bytes().to_vec();
        message.extend_from_slice(&Sha256::digest(&unsigned));
        verifying_key
            .verify(&message, &signature)
            .map_err(|_| invalid_response_error(role, "signature did not verify"))?;
        let signature_hex = hex::encode(&invocation[2..]);
        Ok(serde_json::json!({
            "status": "ok",
            "network": network,
            "role": role,
            "chain_family": "neo-n3",
            "key_id": response_key_id,
            "address": response_address,
            "script_hash": response_script_hash,
            "digest": response_digest,
            "signature": signature_hex,
            "signature_hex": signature_hex,
            "public_key": hex::encode(public_key),
            "invocation_script": invocation_hex,
            "verification_script": verification_hex,
            "key_source": "custody",
        }))
    }

    fn sign_eip191_fulfillment(
        &self,
        request: &Eip191FulfillmentRequest<'_>,
    ) -> Result<serde_json::Value, RuntimeError> {
        let network = request.network;
        let role = request.role;
        let chain_id = request.chain_id;
        let oracle_contract = request.oracle_contract;
        let fulfillment = request.fulfillment;
        let result_bytes_hex = request.result_bytes_hex;
        let request_id = request.request_id;
        let config = match self.config() {
            Ok(Some(config)) => config,
            Ok(None) => return Err(unconfigured_error(role)),
            Err(message) => {
                return Err(http_error(
                    503,
                    format!("{role} signer custody service configuration is invalid: {message}"),
                ))
            }
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

        let url = Self::sign_eip191_fulfillment_url(&config.base_url).map_err(|message| {
            http_error(
                503,
                format!("{role} signer custody service configuration is invalid: {message}"),
            )
        })?;
        let reply = self
            .transport
            .send(CustodyRequest {
                method: "POST",
                url,
                token: Some(config.token),
                body: Some(serde_json::json!({
                    "key_id": key_id,
                    "request_id": request_id,
                    "chain_id": chain_id,
                    "oracle_contract": oracle_contract,
                    "fulfillment": {
                        "request_id": fulfillment.request_id,
                        "app_id": fulfillment.app_id,
                        "module_id": fulfillment.module_id,
                        "operation": fulfillment.operation,
                        "success": fulfillment.success,
                        "error": fulfillment.error,
                    },
                    "result_bytes_hex": result_bytes_hex,
                })),
            })
            .map_err(|message| {
                http_error(
                    503,
                    format!("{role} signer could not reach the custody service: {message}"),
                )
            })?;
        if reply.status != 200 {
            let code = reply
                .body
                .get("code")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("no code");
            let message = reply
                .body
                .get("message")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("the custody service refused the fulfillment signature");
            return Err(http_error(
                reply.status,
                format!("{role} signer refused by custody ({code}): {message}"),
            ));
        }
        if reply
            .body
            .get("allowed")
            .and_then(serde_json::Value::as_bool)
            != Some(true)
        {
            return Err(invalid_response_error(role, "allowed was not true"));
        }
        if reply
            .body
            .get("chain_family")
            .and_then(serde_json::Value::as_str)
            != Some("neox")
        {
            return Err(invalid_response_error(role, "chain_family was not neox"));
        }
        if reply
            .body
            .get("chain_id")
            .and_then(serde_json::Value::as_u64)
            != Some(chain_id)
        {
            return Err(invalid_response_error(role, "chain_id did not match"));
        }
        let response_key_id = required_response_field(role, &reply.body, "key_id")?;
        if response_key_id != key_id {
            return Err(invalid_response_error(role, "key_id did not match"));
        }

        let expected_digest =
            build_neox_digest(chain_id, oracle_contract, fulfillment, result_bytes_hex)
                .map_err(|error| http_error(400, format!("invalid NeoX fulfillment: {error}")))?;
        let expected_message_hash = eip191_message_hash(&expected_digest);
        let digest = required_response_field(role, &reply.body, "digest")?;
        let message_hash = required_response_field(role, &reply.body, "message_hash")?;
        if decode_fixed_hex::<32>(&digest) != Some(expected_digest) {
            return Err(invalid_response_error(
                role,
                "digest did not match structured fulfillment",
            ));
        }
        if decode_fixed_hex::<32>(&message_hash) != Some(expected_message_hash) {
            return Err(invalid_response_error(
                role,
                "message_hash did not match EIP-191 digest",
            ));
        }

        let expected_contract = parse_evm_address(oracle_contract)
            .ok_or_else(|| http_error(400, "oracle_contract must be a 20-byte EVM address"))?;
        let response_contract = required_response_field(role, &reply.body, "oracle_contract")?;
        if parse_evm_address(&response_contract) != Some(expected_contract) {
            return Err(invalid_response_error(
                role,
                "oracle_contract did not match",
            ));
        }

        let signature = required_response_field(role, &reply.body, "signature")?;
        let signature_bytes = decode_fixed_hex::<65>(&signature)
            .ok_or_else(|| invalid_response_error(role, "signature was not 65-byte hexadecimal"))?;
        let recovery = match signature_bytes[64] {
            27 | 28 => signature_bytes[64] - 27,
            _ => {
                return Err(invalid_response_error(
                    role,
                    "signature recovery byte was not 27 or 28",
                ))
            }
        };
        let recovery = RecoveryId::from_byte(recovery)
            .ok_or_else(|| invalid_response_error(role, "signature recovery id was invalid"))?;
        let compact = K256Signature::from_slice(&signature_bytes[..64])
            .map_err(|_| invalid_response_error(role, "signature scalar was invalid"))?;
        let recovered =
            K256VerifyingKey::recover_from_prehash(&expected_message_hash, &compact, recovery)
                .map_err(|_| invalid_response_error(role, "signature did not recover"))?;
        let recovered_compressed = recovered.to_encoded_point(true);
        let public_key = required_response_field(role, &reply.body, "public_key")?;
        if decode_hex(&public_key).as_deref() != Some(recovered_compressed.as_bytes()) {
            return Err(invalid_response_error(
                role,
                "public_key did not match signature",
            ));
        }
        let recovered_uncompressed = recovered.to_encoded_point(false);
        let address_hash = Keccak256::digest(&recovered_uncompressed.as_bytes()[1..]);
        let recovered_address: [u8; 20] = address_hash[12..]
            .try_into()
            .expect("Keccak address tail is 20 bytes");
        let address = required_response_field(role, &reply.body, "address")?;
        if parse_evm_address(&address) != Some(recovered_address) {
            return Err(invalid_response_error(
                role,
                "address did not match signature",
            ));
        }

        Ok(serde_json::json!({
            "status": "ok",
            "network": network,
            "role": role,
            "chain_family": "neox",
            "chain_id": chain_id,
            "key_id": response_key_id,
            "oracle_contract": format!("0x{}", hex::encode(expected_contract)),
            "address": address,
            "public_key": public_key,
            "digest": format!("0x{}", hex::encode(expected_digest)),
            "message_hash": format!("0x{}", hex::encode(expected_message_hash)),
            "signature": signature,
            "key_source": "custody",
        }))
    }
}

fn decode_hex(value: &str) -> Option<Vec<u8>> {
    let raw = value
        .trim()
        .strip_prefix("0x")
        .or_else(|| value.trim().strip_prefix("0X"))
        .unwrap_or(value.trim());
    if !raw.len().is_multiple_of(2) || !raw.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    hex::decode(raw).ok()
}

fn normalize_0x_hex(value: &str) -> String {
    value
        .trim()
        .strip_prefix("0x")
        .or_else(|| value.trim().strip_prefix("0X"))
        .unwrap_or(value.trim())
        .to_ascii_lowercase()
}

fn decode_fixed_hex<const N: usize>(value: &str) -> Option<[u8; N]> {
    decode_hex(value)?.try_into().ok()
}

fn parse_evm_address(value: &str) -> Option<[u8; 20]> {
    decode_fixed_hex(value)
}

fn required_response_field(
    role: &str,
    body: &serde_json::Value,
    field: &str,
) -> Result<String, RuntimeError> {
    nonempty_string(body, field)
        .ok_or_else(|| invalid_response_error(role, "a required signature field was missing"))
}

fn invalid_response_error(role: &str, message: &str) -> RuntimeError {
    http_error(
        502,
        format!("{role} signer received an invalid custody response: {message}"),
    )
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
