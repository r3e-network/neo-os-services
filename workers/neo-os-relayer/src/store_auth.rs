//! Scoped store credentials. Decoding here is consistency checking, NOT JWT
//! verification. The gateway verifies the signature and SQL enforces its grant.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::config::RelayerConfig;

pub const ROLE: &str = "neoos_relayer_caller";
pub const SCOPE: &str = "neoos/relayer-delivery/v2";
pub const PROFILE: &str = "neoos_relayer_v2";
pub const RPC_NAMES: [&str; 6] = ["enqueue", "claim", "transition", "checkpoint", "feed_baseline", "account_health"];

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ScopedClaims {
    pub role: String,
    pub aud: String,
    pub iss: String,
    pub sub: String,
    pub neoos_network: String,
    pub scope: String,
    pub neoos_epoch: u64,
    pub exp: u64,
    pub nbf: Option<u64>,
}

pub fn decode_consistent_claims(token: &str, network: &str, issuer: &str, subject: &str, now_seconds: u64) -> Result<ScopedClaims, String> {
    let refused = || "relayer credential claims do not match the boot context".to_string();
    if token.len() > 16384 || !matches!(network,"mainnet"|"testnet") { return Err(refused()); }
    let parts: Vec<_> = token.split('.').collect();
    if parts.len()!=3 || parts.iter().any(|p| p.is_empty() || !p.bytes().all(|b| b.is_ascii_alphanumeric() || b==b'-' || b==b'_')) { return Err(refused()); }
    #[derive(Deserialize)]
    struct Header { alg: String }
    let header: Header = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[0]).map_err(|_| refused())?).map_err(|_| refused())?;
    if header.alg.eq_ignore_ascii_case("none") || header.alg.is_empty() { return Err(refused()); }
    let claims: ScopedClaims = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[1]).map_err(|_| refused())?).map_err(|_| refused())?;
    if claims.role!=ROLE || claims.aud!="authenticated" || claims.scope!=SCOPE
        || claims.neoos_network!=network || claims.iss!=issuer || claims.sub!=subject
        || issuer.is_empty() || subject.is_empty() || subject.len()>128
        || claims.neoos_epoch==0 || claims.neoos_epoch>i64::MAX as u64
        || claims.exp>i64::MAX as u64 || claims.nbf.is_some_and(|n|n>i64::MAX as u64)
        || claims.exp<=now_seconds || claims.nbf.is_some_and(|n| n>now_seconds) {
        return Err(refused());
    }
    Ok(claims)
}

/// A token refresh cannot clear quota/backoff; distinct authorization contexts
/// cannot share it. Token bytes, jti, grant epoch and envelope version are absent.
pub fn backoff_identity(rest_url: &str, claims: &ScopedClaims) -> String {
    format!("scoped-v2:{}",json!([rest_url,claims.neoos_network,claims.iss,claims.sub,claims.role,claims.scope]))
}

pub struct StoreSettings {
    pub url: String,
    pub api_key: String,
    pub bearer: Option<String>,
    pub claims: Option<ScopedClaims>,
}

pub fn validate_public_api_key(key:&str)->Result<(),String> {
    if let Some(value)=key.strip_prefix("sb_publishable_") {
        if (16..=480).contains(&value.len()) && value.bytes().all(|b|b.is_ascii_alphanumeric() || b==b'_' || b==b'-') {return Ok(());}
    }
    #[derive(Deserialize)]struct PublicClaims {role:String}
    let parts:Vec<_>=key.split('.').collect();
    if key.len()<=16384 && parts.len()==3 && parts.iter().all(|p|!p.is_empty() && p.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'_'||b==b'-')) {
        if let Ok(bytes)=URL_SAFE_NO_PAD.decode(parts[1]) {
            if serde_json::from_slice::<PublicClaims>(&bytes).is_ok_and(|c|c.role=="anon") {return Ok(());}
        }
    }
    Err("store API key must be public, never a service/admin credential".into())
}

pub fn validate_store_url(url:&str)->Result<(),String> {
    let parsed=url::Url::parse(url).map_err(|_|"invalid scoped store endpoint")?;
    if parsed.scheme()!="https" || parsed.host_str().is_none() || !parsed.username().is_empty()
        || parsed.password().is_some() || parsed.query().is_some() || parsed.fragment().is_some() {
        return Err("scoped store endpoint must be a pinned HTTPS URL".into());
    }
    Ok(())
}

pub fn is_scoped(config: &RelayerConfig) -> bool {
    config.raw.pointer("/storeAuth/mode").and_then(Value::as_str)==Some("scoped_v2")
}

pub fn settings(config: &RelayerConfig, now_seconds: u64) -> Result<StoreSettings,String> {
    let store=config.raw.get("storeAuth").ok_or("durable store configuration is missing")?;
    let text=|key:&str| store.get(key).and_then(Value::as_str).filter(|v|!v.trim().is_empty()).map(str::to_string);
    let url=text("url").ok_or("durable store endpoint is missing")?;
    let api_key=text("apiKey").ok_or("durable store API key is missing")?;
    if store.get("mode").and_then(Value::as_str)==Some("legacy_admin") { return Ok(StoreSettings{url,api_key,bearer:None,claims:None}); }
    if !is_scoped(config) { return Err("unknown durable store authorization mode".into()); }
    validate_store_url(&url)?;
    validate_public_api_key(&api_key)?;
    let bearer=text("bearer").ok_or("scoped store credential is not provisioned")?;
    let issuer=text("issuer").ok_or("scoped store issuer is missing")?;
    let subject=text("subject").ok_or("scoped store caller is missing")?;
    let claims=decode_consistent_claims(&bearer,&config.network,&issuer,&subject,now_seconds)?;
    Ok(StoreSettings{url,api_key,bearer:Some(bearer),claims:Some(claims)})
}

pub fn ensure_embedded_ready(config: &RelayerConfig, now_seconds: u64) -> Result<(),String> {
    config.ensure_runtime_ready()?;
    if !crate::durable_v2::enabled(config) || !is_scoped(config) {
        return Err("embedded relayers require the scoped v2 caller; no admin or legacy fallback".into());
    }
    settings(config,now_seconds)?;
    Ok(())
}
