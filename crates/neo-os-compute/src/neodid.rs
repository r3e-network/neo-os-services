//! `workers/nitro-worker/src/neodid/index.js` — the NeoDID ticket lane:
//! provider catalog, nullifier derivation, and the four ticket flows
//! (bind / action-ticket / recovery-ticket / zklogin-ticket).
//!
//! Not ported here (Phase 6 wiring): `handleNeoDidRuntime` (needs
//! `getDstackInfo` + `signDigestBytes`), `resolveNeoDidSignerPrivateKey` /
//! `signDigestBytes` (custody-backed signing), and `buildNeoDidResponse`
//! (signed envelope composition). Each flow returns the ticket result object
//! WITHOUT the `...signer` spread — the Phase 6 handler signs the digest and
//! appends `signature` / `public_key` / `signer_address` / `signer_script_hash`
//! in that order, then spreads `mode` / `callback_encoding` / `output_hash` /
//! `attestation_hash` / `verification` / `tee_attestation` on top.
//!
//! `resolveConfidentialPayload` runs before these flows (the handler composes
//! it and passes the resolved payload), so host I/O here is only the env
//! reader plus two enclave callbacks: `verify_id_token` (web3auth JWT against
//! env-pinned trust anchors — the request body never picks the JWKS URL) and
//! `derive_key_bytes` (TEE salt derivation). The JS `requestLog('warn', …)`
//! in the unverified-uid path is handler-level audit output and has no
//! observable effect on the ticket itself.

use num_traits::Signed;
use serde_json::{json, Value as Json};
use sha2::{Digest, Sha256};

use crate::core::{env_for_network, read_env, resolve_payload_network_strict, EnvReader};
use crate::js::{
    hex_decode_stop_at_invalid, js_bigint_from_string, js_first_truthy, js_number, js_stringify,
    js_trim_string,
};
use crate::stable_stringify::stable_stringify;
use neo_os_core::network_identity::{known_neo_n3_identity, resolve_reviewed_network};

const NEODID_BINDING_DOMAIN: &[u8] = b"neodid-binding-v1";
const NEODID_CLAIM_COMMITMENT_DOMAIN: &[u8] = b"neodid-claim-secret-v1";
const NEODID_BINDING_COMMITMENT_DOMAIN: &[u8] = b"neodid-claim-commitment-v1";
const NEODID_ACTION_DOMAIN: &[u8] = b"neodid-action-v1";
const NEODID_AA_ACTION_DOMAIN: &[u8] = b"neodid-action-v2";
const NEODID_RECOVERY_DOMAIN: &[u8] = b"neodid-recovery-v2";
const NEODID_ZKLOGIN_DOMAIN: &[u8] = b"neodid-zklogin-v1";

const WEB3AUTH_DEFAULT_JWKS_URL: &str = "https://api-auth.web3auth.io/.well-known/jwks.json";
const DEFAULT_SALT_KEY_PATH: &str = "morpheus/neodid/nullifier/v1";

struct ProviderDef {
    id: &'static str,
    category: &'static str,
    aliases: &'static [&'static str],
    auth_modes: &'static [&'static str],
    claim_types: &'static [&'static str],
    derives_provider_uid_in_tee: bool,
}

const SUPPORTED_PROVIDER_TABLE: &[ProviderDef] = &[
    ProviderDef {
        id: "web3auth",
        category: "identity",
        aliases: &["w3a"],
        auth_modes: &["aggregate_oauth", "mfa"],
        claim_types: &[
            "Web3Auth_PrimaryIdentity",
            "Web3Auth_LinkedSocials",
            "Web3Auth_VerifiedUser",
        ],
        derives_provider_uid_in_tee: true,
    },
    ProviderDef {
        id: "twitter",
        category: "social",
        aliases: &[],
        auth_modes: &["oauth"],
        claim_types: &["Twitter_VIP", "Twitter_Verified", "Twitter_Followers"],
        derives_provider_uid_in_tee: false,
    },
    ProviderDef {
        id: "github",
        category: "social",
        aliases: &[],
        auth_modes: &["oauth"],
        claim_types: &[
            "Github_Contributor",
            "Github_OrgMember",
            "Github_VerifiedUser",
        ],
        derives_provider_uid_in_tee: false,
    },
    ProviderDef {
        id: "google",
        category: "social",
        aliases: &["gmail"],
        auth_modes: &["oauth"],
        claim_types: &[
            "Google_Identity",
            "Google_Workspace",
            "Google_VerifiedEmail",
        ],
        derives_provider_uid_in_tee: false,
    },
    ProviderDef {
        id: "discord",
        category: "social",
        aliases: &[],
        auth_modes: &["oauth"],
        claim_types: &["Discord_Member"],
        derives_provider_uid_in_tee: false,
    },
    ProviderDef {
        id: "telegram",
        category: "social",
        aliases: &[],
        auth_modes: &["oauth"],
        claim_types: &["Telegram_Member"],
        derives_provider_uid_in_tee: false,
    },
    ProviderDef {
        id: "binance",
        category: "exchange",
        aliases: &[],
        auth_modes: &["api", "oauth"],
        claim_types: &["Binance_KYC", "Binance_VIP", "Binance_AssetHolder"],
        derives_provider_uid_in_tee: false,
    },
    ProviderDef {
        id: "okx",
        category: "exchange",
        aliases: &["okex"],
        auth_modes: &["api", "oauth"],
        claim_types: &["OKX_KYC", "OKX_VIP", "OKX_AssetHolder"],
        derives_provider_uid_in_tee: false,
    },
    ProviderDef {
        id: "email",
        category: "contact",
        aliases: &["mail"],
        auth_modes: &["otp", "magic_link"],
        claim_types: &["Email_Verified"],
        derives_provider_uid_in_tee: false,
    },
    ProviderDef {
        id: "generic_oauth",
        category: "generic",
        aliases: &[],
        auth_modes: &["oauth"],
        claim_types: &["Generic_Claim"],
        derives_provider_uid_in_tee: false,
    },
];

/// `handleNeoDidProviders` / `handleNeoDidRuntime` render this array verbatim;
/// serde_json's `preserve_order` keeps the JS field order.
pub fn supported_providers() -> Json {
    Json::Array(
        SUPPORTED_PROVIDER_TABLE
            .iter()
            .map(|provider| {
                json!({
                    "id": provider.id,
                    "category": provider.category,
                    "aliases": provider.aliases,
                    "auth_modes": provider.auth_modes,
                    "claim_types": provider.claim_types,
                    "derives_provider_uid_in_tee": provider.derives_provider_uid_in_tee,
                })
            })
            .collect(),
    )
}

/// The JWT trust anchors below come only from server-side env; a caller who
/// could pick the JWKS URL and audience could sign their own id_token for any
/// victim's provider_uid (account takeover), so this closure is where the
/// enclave performs the actual verification.
pub struct Web3AuthVerifyRequest<'a> {
    pub id_token: &'a str,
    pub jwks_url: &'a str,
    pub audience: &'a str,
    pub issuer: Option<&'a str>,
}

/// `jwtVerify(idToken, JWKS, { audience, issuer })` — returns the verified
/// claims payload; the error message propagates verbatim to the caller.
pub type VerifyIdToken<'a> = &'a dyn Fn(&Web3AuthVerifyRequest<'_>) -> Result<Json, String>;

/// `deriveKeyBytes(keyPath, purpose)` from platform/nitro-signer.js.
pub type DeriveKeyBytes<'a> = &'a dyn Fn(&str, &str) -> Result<Vec<u8>, String>;

pub struct NeoDidIo<'a> {
    pub env: EnvReader<'a>,
    pub verify_id_token: VerifyIdToken<'a>,
    pub derive_key_bytes: DeriveKeyBytes<'a>,
}

fn normalize_provider_text(lowercased: &str) -> String {
    for provider in SUPPORTED_PROVIDER_TABLE {
        if provider.id == lowercased || provider.aliases.contains(&lowercased) {
            return provider.id.to_string();
        }
    }
    lowercased.to_string()
}

fn normalize_neo_did_provider_id_text(text: &str) -> String {
    normalize_provider_text(&text.trim().to_lowercase())
}

/// `requireSupportedProvider(resolvedPayload.provider || default)` — the
/// error message embeds the ORIGINAL (pre-normalize) chain value.
fn require_supported_provider(value: Option<&Json>) -> Result<String, String> {
    let normalized = normalize_provider_text(&js_trim_string(value).to_lowercase());
    if !SUPPORTED_PROVIDER_TABLE
        .iter()
        .any(|provider| provider.id == normalized)
    {
        let rendered = match value {
            Some(raw) => js_stringify(raw),
            None => "undefined".to_string(),
        };
        return Err(format!("unsupported neodid provider: {rendered}"));
    }
    Ok(normalized)
}

/// `allowUnverifiedProviderUid()` — default DENY; '1'/'true'/'yes'/'on' opts
/// the low-assurance lanes back into the legacy (forgeable-uid) behavior.
fn allow_unverified_provider_uid(env: EnvReader<'_>) -> bool {
    let raw = read_env(env, &["MORPHEUS_NEODID_ALLOW_UNVERIFIED_UID"]).to_lowercase();
    raw == "1" || raw == "true" || raw == "yes" || raw == "on"
}

/// `isHighAssuranceUnverifiedProviderAllowed(provider)` — recovery/zklogin
/// fail closed unless the provider is on the explicit comma-separated
/// allowlist (entries pass through the alias map).
fn is_high_assurance_unverified_provider_allowed(provider: &str, env: EnvReader<'_>) -> bool {
    read_env(
        env,
        &["MORPHEUS_NEODID_RECOVERY_ALLOW_UNVERIFIED_PROVIDERS"],
    )
    .to_lowercase()
    .split(',')
    .any(|entry| normalize_neo_did_provider_id_text(entry) == provider)
}

fn resolve_provider_uid(payload: &Json) -> Result<String, String> {
    let provider_uid = js_trim_string(js_first_truthy(
        payload,
        &["provider_uid", "social_uid", "user_id", "account_id"],
    ));
    if provider_uid.is_empty() {
        return Err("provider_uid is required".to_string());
    }
    Ok(provider_uid)
}

/// `buildStableWeb3AuthProviderUid(claims)` — the `||` chains run on the RAW
/// claim values (0/false fall through to the next candidate).
fn build_stable_web3auth_provider_uid(claims: &Json) -> String {
    let aggregate_verifier = js_trim_string(claims.get("aggregateVerifier"));
    let aggregate_verifier_id = js_trim_string(claims.get("aggregateVerifierId"));
    if !aggregate_verifier.is_empty() && !aggregate_verifier_id.is_empty() {
        return format!("web3auth:{aggregate_verifier}:{aggregate_verifier_id}");
    }

    let verifier = js_trim_string(claims.get("verifier"));
    let verifier_id = js_trim_string(js_first_truthy(claims, &["verifierId", "email", "sub"]));
    if !verifier.is_empty() && !verifier_id.is_empty() {
        return format!("web3auth:{verifier}:{verifier_id}");
    }

    let fallback = js_trim_string(js_first_truthy(claims, &["sub", "email", "name"]));
    if fallback.is_empty() {
        String::new()
    } else {
        format!("web3auth:user:{fallback}")
    }
}

/// `resolveVerifiedProviderUid(provider, payload, context)` — web3auth derives
/// the uid from a cryptographically verified id_token inside the enclave; every
/// other provider takes it from the (untrusted) request body behind the
/// default-deny env gates described above.
pub fn resolve_verified_provider_uid(
    env: EnvReader<'_>,
    verify_id_token: VerifyIdToken<'_>,
    provider: &str,
    payload: &Json,
    context: &str,
) -> Result<String, String> {
    if provider != "web3auth" {
        let high_assurance = context == "recovery" || context == "zklogin";
        if high_assurance && !is_high_assurance_unverified_provider_allowed(provider, env) {
            return Err(format!(
                "provider {provider} provider_uid is not verified in the enclave; \
                 {context}-ticket requires a TEE-verified provider_uid \
                 (enable per-provider via MORPHEUS_NEODID_RECOVERY_ALLOW_UNVERIFIED_PROVIDERS)"
            ));
        }
        if !high_assurance && !allow_unverified_provider_uid(env) {
            return Err(format!(
                "provider {provider} provider_uid is not verified in the enclave; \
                 unverified provider_uid is disabled (MORPHEUS_NEODID_ALLOW_UNVERIFIED_UID=false)"
            ));
        }
        // requestLog('warn', 'neodid_unverified_provider_uid', …) — audit-trail
        // side effect only; the ticket bytes below never depend on it.
        return resolve_provider_uid(payload);
    }

    let id_token = js_trim_string(js_first_truthy(
        payload,
        &[
            "id_token",
            "idToken",
            "web3auth_id_token",
            "web3authIdToken",
        ],
    ));
    if id_token.is_empty() {
        return Err("web3auth id_token is required".to_string());
    }

    let jwks_url = {
        let configured = read_env(env, &["WEB3AUTH_JWKS_URL"]);
        if configured.is_empty() {
            WEB3AUTH_DEFAULT_JWKS_URL.to_string()
        } else {
            configured
        }
    };
    let client_id = read_env(
        env,
        &[
            "WEB3AUTH_CLIENT_ID",
            "NEXT_PUBLIC_WEB3AUTH_CLIENT_ID",
            "VITE_WEB3AUTH_CLIENT_ID",
        ],
    );
    if client_id.is_empty() {
        return Err("WEB3AUTH_CLIENT_ID is required for web3auth verification".to_string());
    }
    let issuer = read_env(env, &["WEB3AUTH_ISSUER"]);
    let claims = verify_id_token(&Web3AuthVerifyRequest {
        id_token: &id_token,
        jwks_url: &jwks_url,
        audience: &client_id,
        issuer: if issuer.is_empty() {
            None
        } else {
            Some(&issuer)
        },
    })?;

    let derived_provider_uid = build_stable_web3auth_provider_uid(&claims);
    if derived_provider_uid.is_empty() {
        return Err("unable to derive stable Web3Auth provider_uid".to_string());
    }

    let supplied = js_trim_string(js_first_truthy(
        payload,
        &["provider_uid", "social_uid", "user_id"],
    ));
    if !supplied.is_empty() && supplied != derived_provider_uid {
        return Err("web3auth provider_uid does not match verified id_token".to_string());
    }
    Ok(derived_provider_uid)
}

/// `resolveNeoDidSalt()` — the nullifier secret is server-authoritative
/// (never payload): explicit env salt hashes its hex text; the TEE-derived
/// key hashes the hex text of the derived bytes so both paths land on the
/// SAME nullifier for the same master key.
pub fn resolve_neo_did_salt(
    env: EnvReader<'_>,
    derive_key_bytes: DeriveKeyBytes<'_>,
) -> Result<Vec<u8>, String> {
    let explicit = read_env(env, &["NEODID_SECRET_SALT"]);
    if !explicit.is_empty() {
        return Ok(Sha256::digest(explicit.as_bytes()).to_vec());
    }
    let configured_path = read_env(env, &["NITRO_NEODID_SALT_PATH"]);
    let key_path = if configured_path.is_empty() {
        DEFAULT_SALT_KEY_PATH.to_string()
    } else {
        configured_path
    };
    match derive_key_bytes(&key_path, "neodid-nullifier-salt") {
        Ok(derived) => {
            let hex_text = hex_encode(&derived);
            Ok(Sha256::digest(hex_text.as_bytes()).to_vec())
        }
        Err(_) => Err(
            "NeoDID salt unavailable: set NEODID_SECRET_SALT env var or ensure dstack is available"
                .to_string(),
        ),
    }
}

pub fn compute_master_nullifier(provider: &str, provider_uid: &str, salt: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(provider.as_bytes());
    hasher.update([0x1f]);
    hasher.update(provider_uid.as_bytes());
    hasher.update([0x1f]);
    hasher.update(salt);
    hex_encode(&hasher.finalize())
}

pub fn compute_action_nullifier(
    provider: &str,
    provider_uid: &str,
    action_id: &str,
    salt: &[u8],
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(provider.as_bytes());
    hasher.update([0x1f]);
    hasher.update(provider_uid.as_bytes());
    hasher.update([0x1f]);
    hasher.update(action_id.as_bytes());
    hasher.update([0x1f]);
    hasher.update(salt);
    hex_encode(&hasher.finalize())
}

/// `computeMetadataHash(resolvedPayload.metadata || {})` — strings hash their
/// utf8 bytes (`ensureBuffer`), everything else hashes its stableStringify.
pub fn compute_metadata_hash(metadata: Option<&Json>) -> String {
    match metadata {
        Some(Json::String(text)) => sha256_hex(text.as_bytes()),
        Some(other) => sha256_hex(stable_stringify(other).as_bytes()),
        None => sha256_hex(stable_stringify(&Json::Object(Default::default())).as_bytes()),
    }
}

/// Private claim commitment. The claim value is only an input to this digest;
/// it is never part of the on-chain binding authorization preimage.
fn compute_claim_commitment(
    provider: &str,
    provider_uid: &str,
    claim_type: &str,
    claim_value: &str,
    salt: &[u8],
) -> Result<String, String> {
    let mut input = Vec::new();
    input.extend_from_slice(NEODID_CLAIM_COMMITMENT_DOMAIN);
    input.extend_from_slice(&encode_length_prefixed_ascii(provider)?);
    input.extend_from_slice(&encode_length_prefixed_ascii(provider_uid)?);
    input.extend_from_slice(&encode_length_prefixed_ascii(claim_type)?);
    input.extend_from_slice(&encode_length_prefixed_ascii(claim_value)?);
    input.extend_from_slice(salt);
    Ok(hex_encode(&Sha256::digest(&input)))
}

/// `encodeLengthPrefixedAscii` — utf8 body, one length byte; > 255 throws.
fn encode_length_prefixed_ascii(value: &str) -> Result<Vec<u8>, String> {
    let body = value.as_bytes();
    if body.len() > 255 {
        return Err("segment too long".to_string());
    }
    let mut out = Vec::with_capacity(body.len() + 1);
    out.push(body.len() as u8);
    out.extend_from_slice(body);
    Ok(out)
}

fn hex_bytes_0x(text: &str) -> Vec<u8> {
    let stripped = text
        .strip_prefix("0x")
        .or_else(|| text.strip_prefix("0X"))
        .unwrap_or(text);
    hex_decode_stop_at_invalid(stripped)
}

/// `encodeHash160OrZero` — null/empty → 20 zero bytes.
fn encode_hash160_or_zero(value: Option<&str>) -> Vec<u8> {
    match value {
        Some(text) if !text.is_empty() => hex_bytes_0x(text),
        _ => vec![0u8; 20],
    }
}

/// `neoN3NetworkMagicLe4(network)` — env/scoped-config resolution with the
/// mainnet/testnet fallbacks, then the shared 4-byte little-endian encoder
/// (`>>> 0` wrap). No magic-range validation: C# has none either.
fn neo_n3_network_magic_le4(network: &str, env: EnvReader<'_>) -> Result<[u8; 4], String> {
    let reviewed = known_neo_n3_identity(network)
        .ok_or_else(|| format!("unsupported Neo N3 network: {network}"))?
        .magic;
    let raw_env = env_for_network(network, &["NEO_NETWORK_MAGIC"], env)?;
    if !raw_env.is_empty() {
        let raw = js_number(&raw_env);
        if !raw.is_finite() || raw.fract() != 0.0 || raw <= 0.0 || raw > u32::MAX as f64 {
            return Err("Neo N3 network magic must be a positive uint32 integer".to_owned());
        }
        if raw as u32 != reviewed {
            return Err(format!(
                "Neo N3 network magic conflicts with reviewed {network} identity"
            ));
        }
    }
    let magic = reviewed as u64;
    Ok([
        (magic & 0xff) as u8,
        ((magic >> 8) & 0xff) as u8,
        ((magic >> 16) & 0xff) as u8,
        ((magic >> 24) & 0xff) as u8,
    ])
}

/// The network a bind or NeoDIDRegistry v1 action digest is bound to. The host signs the
/// digest with its worker key, which exists only for the host's own network:
/// its reviewed `MORPHEUS_NETWORK`, resolved as the host resolves its custody
/// network (an empty value is the documented TestNet default, an unknown label
/// an error). An absent payload label therefore selects the host network, and
/// an explicit label must name it; any other network would yield a digest that
/// the signature can never match on chain.
fn resolve_ticket_network(env: EnvReader<'_>, resolved_payload: &Json) -> Result<String, String> {
    let host_network = resolve_reviewed_network(env("MORPHEUS_NETWORK").as_deref())
        .map_err(|error| error.to_string())?;
    let network = resolve_payload_network_strict(resolved_payload, &host_network)?;
    if network != host_network {
        return Err(format!(
            "ticket network {network} does not match the host network {host_network}"
        ));
    }
    Ok(network)
}

/// `encodeUint256Word(text, fieldName)` — 32-byte big-endian zero-padded word;
/// rejects negatives and overflow. The text has already passed
/// `resolve_uint256_text`, so the BigInt grammar quirks are unreachable here,
/// but the error messages stay byte-identical to the JS encoder.
fn encode_uint256_word(text: &str, field_name: &str) -> Result<[u8; 32], String> {
    let parsed = js_bigint_from_string(text)
        .ok_or_else(|| format!("{field_name} must be a uint256 string"))?;
    if parsed.is_negative() {
        return Err(format!("{field_name} must be >= 0"));
    }
    let hex_text = parsed.magnitude().to_str_radix(16);
    if hex_text.len() > 64 {
        return Err(format!("{field_name} overflows uint256"));
    }
    let mut padded = String::with_capacity(64);
    for _ in 0..(64 - hex_text.len()) {
        padded.push('0');
    }
    padded.push_str(&hex_text);
    let bytes = hex_decode_stop_at_invalid(&padded);
    let mut word = [0u8; 32];
    word.copy_from_slice(&bytes);
    Ok(word)
}

fn strip_0x_lowercase(text: &str) -> String {
    let stripped = text
        .strip_prefix("0x")
        .or_else(|| text.strip_prefix("0X"))
        .unwrap_or(text);
    stripped.to_lowercase()
}

fn resolve_hash160(value: Option<&Json>, field_name: &str) -> Result<String, String> {
    let normalized = strip_0x_lowercase(&js_trim_string(value));
    let valid = normalized.len() == 40
        && normalized
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'));
    if !valid {
        return Err(format!("{field_name} must be a 20-byte hash160"));
    }
    Ok(format!("0x{normalized}"))
}

fn resolve_aa_hash160(value: Option<&Json>, field_name: &str) -> Result<String, String> {
    let text = js_trim_string(value);
    if text.is_empty() {
        return Err(format!("{field_name} is required"));
    }
    let resolved = resolve_hash160(value, field_name)?;
    if resolved == format!("0x{}", "00".repeat(20)) {
        return Err(format!("{field_name} must be a non-zero 20-byte hash160"));
    }
    Ok(resolved)
}

fn resolve_hash32(value: Option<&Json>, field_name: &str) -> Result<String, String> {
    let normalized = strip_0x_lowercase(&js_trim_string(value));
    let valid = normalized.len() == 64
        && normalized
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'));
    if !valid {
        return Err(format!("{field_name} must be a 32-byte hash"));
    }
    Ok(format!("0x{normalized}"))
}

fn finish_required_text(text: String, field_name: &str) -> Result<String, String> {
    if text.is_empty() {
        return Err(format!("{field_name} is required"));
    }
    if text.len() > 255 {
        return Err(format!("{field_name} is too long"));
    }
    Ok(text)
}

fn resolve_required_text(value: Option<&Json>, field_name: &str) -> Result<String, String> {
    finish_required_text(js_trim_string(value), field_name)
}

fn resolve_decimal_text(value: Option<&Json>, field_name: &str) -> Result<String, String> {
    let text = resolve_required_text(value, field_name)?;
    if !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(format!("{field_name} must be a decimal string"));
    }
    let canonical = text.trim_start_matches('0');
    if canonical.is_empty() {
        Ok("0".to_string())
    } else {
        Ok(canonical.to_string())
    }
}

fn callback_encoding(payload: &Json) -> String {
    js_trim_string(js_first_truthy(
        payload,
        &["callback_encoding", "result_encoding"],
    ))
}

pub fn is_aa_action_v3_payload(payload: &Json) -> bool {
    callback_encoding(payload) == "neo_n3_action_v3"
}

pub fn is_aa_recovery_v3_payload(payload: &Json) -> bool {
    callback_encoding(payload) == "neo_n3_recovery_v3"
}

/// `resolveUint256Text` — validates through the BigInt(string) grammar but
/// returns the (trimmed) text AS-IS: the on-chain decoder re-parses it.
fn resolve_uint256_text(value: Option<&Json>, field_name: &str) -> Result<String, String> {
    let text = resolve_required_text(value, field_name)?;
    let parsed = js_bigint_from_string(&text)
        .ok_or_else(|| format!("{field_name} must be a uint256 string"))?;
    if parsed.is_negative() {
        return Err(format!("{field_name} must be >= 0"));
    }
    Ok(text)
}

fn resolve_recovery_action_id(
    payload: &Json,
    network: &str,
    aa_contract: &str,
    account_id_raw: &str,
    new_owner: &str,
    recovery_nonce: &str,
) -> Result<String, String> {
    let mut material = Vec::new();
    material.extend_from_slice(network.as_bytes());
    material.push(0x1f);
    material.extend_from_slice(&hex_bytes_0x(aa_contract));
    material.push(0x1f);
    material.extend_from_slice(&hex_bytes_0x(account_id_raw));
    material.push(0x1f);
    material.extend_from_slice(&hex_bytes_0x(new_owner));
    material.push(0x1f);
    material.extend_from_slice(recovery_nonce.as_bytes());
    let derived = format!("aa_recovery:{}", sha256_hex(&material));
    let explicit = js_trim_string(js_first_truthy(
        payload,
        &["action_id", "recovery_action_id", "recovery_id", "intent"],
    ));
    if !explicit.is_empty() {
        let explicit = finish_required_text(explicit, "action_id")?;
        if explicit != derived {
            return Err("action_id does not match the derived recovery action".to_string());
        }
    }
    Ok(derived)
}

fn resolve_aa_proxy_action_id(
    payload: &Json,
    network: &str,
    aa_contract: &str,
    account_id_raw: &str,
    disposable_account: &str,
    session_nonce: &str,
    expires_at: &str,
) -> Result<String, String> {
    let mut material = Vec::new();
    material.extend_from_slice(network.as_bytes());
    material.push(0x1f);
    material.extend_from_slice(&hex_bytes_0x(aa_contract));
    material.push(0x1f);
    material.extend_from_slice(&hex_bytes_0x(account_id_raw));
    material.push(0x1f);
    material.extend_from_slice(&hex_bytes_0x(disposable_account));
    material.push(0x1f);
    material.extend_from_slice(session_nonce.as_bytes());
    material.push(0x1f);
    material.extend_from_slice(expires_at.as_bytes());
    let derived = format!("aa_proxy:{}", sha256_hex(&material));
    let explicit = js_trim_string(js_first_truthy(payload, &["action_id"]));
    if !explicit.is_empty() {
        let explicit = finish_required_text(explicit, "action_id")?;
        if explicit != derived {
            return Err("action_id does not match the derived AA action".to_string());
        }
    }
    Ok(derived)
}

fn resolve_zklogin_action_id(payload: &Json, derived_parts: [&str; 7]) -> Result<String, String> {
    let explicit = js_trim_string(js_first_truthy(
        payload,
        &["action_id", "zklogin_action_id", "intent"],
    ));
    if !explicit.is_empty() {
        return finish_required_text(explicit, "action_id");
    }
    let joined = ["aa_zklogin"]
        .into_iter()
        .chain(derived_parts)
        .collect::<Vec<_>>()
        .join("\u{1f}");
    let digest = sha256_hex(joined.as_bytes());
    finish_required_text(format!("aa_zklogin:{digest}"), "action_id")
}

struct BindingTicket {
    vault_account: String,
    provider: String,
    claim_type: String,
    claim_value: String,
    claim_commitment: String,
    master_nullifier: String,
    metadata_hash: String,
    network: String,
}

fn build_binding_digest_bytes(
    ticket: &BindingTicket,
    env: EnvReader<'_>,
) -> Result<[u8; 32], String> {
    let mut input = Vec::new();
    input.extend_from_slice(NEODID_BINDING_DOMAIN);
    input.extend_from_slice(&hex_bytes_0x(&ticket.vault_account));
    input.extend_from_slice(&encode_length_prefixed_ascii(&ticket.provider)?);
    input.extend_from_slice(&encode_length_prefixed_ascii(&ticket.claim_type)?);
    input.extend_from_slice(&encode_length_prefixed_ascii(&ticket.claim_value)?);
    input.extend_from_slice(&hex_decode_stop_at_invalid(&ticket.master_nullifier));
    input.extend_from_slice(&hex_decode_stop_at_invalid(&ticket.metadata_hash));
    input.extend_from_slice(&neo_n3_network_magic_le4(&ticket.network, env)?);
    Ok(Sha256::digest(&input).into())
}

fn build_binding_commitment_digest_bytes(
    ticket: &BindingTicket,
    env: EnvReader<'_>,
) -> Result<[u8; 32], String> {
    let mut input = Vec::new();
    input.extend_from_slice(NEODID_BINDING_COMMITMENT_DOMAIN);
    input.extend_from_slice(&hex_bytes_0x(&ticket.vault_account));
    input.extend_from_slice(&encode_length_prefixed_ascii(&ticket.provider)?);
    input.extend_from_slice(&encode_length_prefixed_ascii(&ticket.claim_type)?);
    input.extend_from_slice(&hex_decode_stop_at_invalid(&ticket.claim_commitment));
    input.extend_from_slice(&hex_decode_stop_at_invalid(&ticket.master_nullifier));
    input.extend_from_slice(&hex_decode_stop_at_invalid(&ticket.metadata_hash));
    input.extend_from_slice(&neo_n3_network_magic_le4(&ticket.network, env)?);
    Ok(Sha256::digest(&input).into())
}

struct ActionTicket {
    disposable_account: String,
    action_id: String,
    action_nullifier: String,
    network: String,
}

fn build_action_digest_bytes(
    ticket: &ActionTicket,
    env: EnvReader<'_>,
) -> Result<[u8; 32], String> {
    let mut input = Vec::new();
    input.extend_from_slice(NEODID_ACTION_DOMAIN);
    input.extend_from_slice(&hex_bytes_0x(&ticket.disposable_account));
    input.extend_from_slice(&encode_length_prefixed_ascii(&ticket.action_id)?);
    input.extend_from_slice(&hex_decode_stop_at_invalid(&ticket.action_nullifier));
    input.extend_from_slice(&neo_n3_network_magic_le4(&ticket.network, env)?);
    Ok(Sha256::digest(&input).into())
}

struct AaActionTicket {
    network: String,
    aa_contract: String,
    account_id_raw: String,
    verifier_contract: String,
    account_id: String,
    disposable_account: String,
    action_id: String,
    expires_at: String,
    action_nullifier: String,
}

fn build_aa_action_digest_bytes(ticket: &AaActionTicket) -> Result<[u8; 32], String> {
    let mut input = Vec::new();
    input.extend_from_slice(NEODID_AA_ACTION_DOMAIN);
    input.extend_from_slice(&encode_length_prefixed_ascii(&ticket.network)?);
    input.extend_from_slice(&hex_bytes_0x(&ticket.aa_contract));
    input.extend_from_slice(&hex_bytes_0x(&ticket.account_id_raw));
    input.extend_from_slice(&hex_bytes_0x(&ticket.verifier_contract));
    input.extend_from_slice(&encode_length_prefixed_ascii(&ticket.account_id)?);
    input.extend_from_slice(&hex_bytes_0x(&ticket.disposable_account));
    input.extend_from_slice(&encode_length_prefixed_ascii(&ticket.action_id)?);
    input.extend_from_slice(&encode_length_prefixed_ascii(&ticket.expires_at)?);
    input.extend_from_slice(&hex_decode_stop_at_invalid(&ticket.action_nullifier));
    Ok(Sha256::digest(&input).into())
}

struct RecoveryTicket {
    network: String,
    aa_contract: String,
    account_id_raw: String,
    verifier_contract: String,
    account_address: String,
    account_id: String,
    new_owner: String,
    recovery_nonce: String,
    expires_at: String,
    action_id: String,
    master_nullifier: String,
    action_nullifier: String,
}

fn build_recovery_digest_bytes(ticket: &RecoveryTicket) -> Result<[u8; 32], String> {
    let mut input = Vec::new();
    input.extend_from_slice(NEODID_RECOVERY_DOMAIN);
    input.extend_from_slice(&encode_length_prefixed_ascii(&ticket.network)?);
    input.extend_from_slice(&hex_bytes_0x(&ticket.aa_contract));
    input.extend_from_slice(&hex_bytes_0x(&ticket.account_id_raw));
    input.extend_from_slice(&hex_bytes_0x(&ticket.verifier_contract));
    input.extend_from_slice(&hex_bytes_0x(&ticket.account_address));
    input.extend_from_slice(&encode_length_prefixed_ascii(&ticket.account_id)?);
    input.extend_from_slice(&hex_bytes_0x(&ticket.new_owner));
    input.extend_from_slice(&encode_length_prefixed_ascii(&ticket.recovery_nonce)?);
    input.extend_from_slice(&encode_length_prefixed_ascii(&ticket.expires_at)?);
    input.extend_from_slice(&encode_length_prefixed_ascii(&ticket.action_id)?);
    input.extend_from_slice(&hex_decode_stop_at_invalid(&ticket.master_nullifier));
    input.extend_from_slice(&hex_decode_stop_at_invalid(&ticket.action_nullifier));
    Ok(Sha256::digest(&input).into())
}

struct ZkLoginTicket {
    verifier_contract: String,
    account_id_hash: String,
    target_contract: String,
    method: String,
    args_hash: String,
    nonce: String,
    deadline: String,
    provider: String,
    master_nullifier: String,
    action_nullifier: String,
}

fn build_zklogin_digest_bytes(ticket: &ZkLoginTicket) -> Result<[u8; 32], String> {
    let mut input = Vec::new();
    input.extend_from_slice(NEODID_ZKLOGIN_DOMAIN);
    input.extend_from_slice(&encode_hash160_or_zero(Some(&ticket.verifier_contract)));
    input.extend_from_slice(&hex_bytes_0x(&ticket.account_id_hash));
    input.extend_from_slice(&hex_bytes_0x(&ticket.target_contract));
    input.extend_from_slice(&encode_length_prefixed_ascii(&ticket.method)?);
    input.extend_from_slice(&hex_bytes_0x(&ticket.args_hash));
    input.extend_from_slice(&encode_uint256_word(&ticket.nonce, "nonce")?);
    input.extend_from_slice(&encode_uint256_word(&ticket.deadline, "deadline")?);
    input.extend_from_slice(&encode_length_prefixed_ascii(&ticket.provider)?);
    input.extend_from_slice(&hex_decode_stop_at_invalid(&ticket.master_nullifier));
    input.extend_from_slice(&hex_decode_stop_at_invalid(&ticket.action_nullifier));
    Ok(Sha256::digest(&input).into())
}

/// `handleNeoDidBind` — ticket assembly and digest; the signer spread and the
/// signed response envelope are Phase 6 wiring.
pub fn neodid_bind(io: &NeoDidIo<'_>, resolved_payload: &Json) -> Result<Json, String> {
    let salt_bytes = resolve_neo_did_salt(io.env, io.derive_key_bytes)?;
    let twitter = json!("twitter");
    let provider = require_supported_provider(
        js_first_truthy(resolved_payload, &["provider"]).or(Some(&twitter)),
    )?;
    let provider_uid = resolve_verified_provider_uid(
        io.env,
        io.verify_id_token,
        &provider,
        resolved_payload,
        "bind",
    )?;

    let vault_account = resolve_hash160(
        js_first_truthy(resolved_payload, &["vault_account", "vault_script_hash"]),
        "vault_account",
    )?;
    let claim_type = {
        let generic = json!("Generic_Claim");
        let chosen =
            js_trim_string(js_first_truthy(resolved_payload, &["claim_type"]).or(Some(&generic)));
        if chosen.is_empty() {
            "Generic_Claim".to_string()
        } else {
            chosen
        }
    };
    let claim_value = js_trim_string(js_first_truthy(resolved_payload, &["claim_value"]));
    let metadata_hash = compute_metadata_hash(js_first_truthy(resolved_payload, &["metadata"]));
    let network = resolve_ticket_network(io.env, resolved_payload)?;
    let master_nullifier = compute_master_nullifier(&provider, &provider_uid, &salt_bytes);

    let ticket = BindingTicket {
        vault_account: vault_account.clone(),
        provider: provider.clone(),
        claim_type: claim_type.clone(),
        claim_value: claim_value.clone(),
        claim_commitment: compute_claim_commitment(
            &provider,
            &provider_uid,
            &claim_type,
            &claim_value,
            &salt_bytes,
        )?,
        master_nullifier: master_nullifier.clone(),
        metadata_hash: metadata_hash.clone(),
        network: network.clone(),
    };
    let digest_bytes = build_binding_digest_bytes(&ticket, io.env)?;
    let commitment_digest_bytes = build_binding_commitment_digest_bytes(&ticket, io.env)?;
    Ok(json!({
        "binding_mode": "commitment-v1",
        "vault_account": ticket.vault_account,
        "provider": ticket.provider,
        "claim_type": ticket.claim_type,
        "claim_value": ticket.claim_value,
        "claim_commitment": format!("0x{}", ticket.claim_commitment),
        "master_nullifier": format!("0x{master_nullifier}"),
        "metadata_hash": format!("0x{metadata_hash}"),
        "digest": format!("0x{}", hex_encode(&digest_bytes)),
        "commitment_digest": format!("0x{}", hex_encode(&commitment_digest_bytes)),
    }))
}

/// `handleNeoDidActionTicket` — note the verification context is the DEFAULT
/// 'bind' (low assurance): only recovery/zklogin fail closed per-provider.
pub fn neodid_action_ticket(io: &NeoDidIo<'_>, resolved_payload: &Json) -> Result<Json, String> {
    let salt_bytes = resolve_neo_did_salt(io.env, io.derive_key_bytes)?;
    let twitter = json!("twitter");
    let provider = require_supported_provider(
        js_first_truthy(resolved_payload, &["provider"]).or(Some(&twitter)),
    )?;
    let provider_uid = resolve_verified_provider_uid(
        io.env,
        io.verify_id_token,
        &provider,
        resolved_payload,
        "bind",
    )?;

    if is_aa_action_v3_payload(resolved_payload) {
        let network = resolve_required_text(resolved_payload.get("network"), "network")?;
        let aa_contract = resolve_aa_hash160(resolved_payload.get("aa_contract"), "aa_contract")?;
        let account_id_raw =
            resolve_aa_hash160(resolved_payload.get("account_id_raw"), "account_id_raw")?;
        let verifier_contract = resolve_aa_hash160(
            resolved_payload.get("verifier_contract"),
            "verifier_contract",
        )?;
        let account_id = resolve_required_text(resolved_payload.get("account_id"), "account_id")?;
        let disposable_account = resolve_aa_hash160(
            js_first_truthy(
                resolved_payload,
                &["disposable_account", "disposable_script_hash"],
            ),
            "disposable_account",
        )?;
        let expires_at = resolve_decimal_text(resolved_payload.get("expires_at"), "expires_at")?;
        let zero = json!("0");
        let session_nonce = resolve_decimal_text(
            Some(
                resolved_payload
                    .get("session_nonce")
                    .filter(|value| !value.is_null())
                    .unwrap_or(&zero),
            ),
            "session_nonce",
        )?;
        let action_id = resolve_aa_proxy_action_id(
            resolved_payload,
            &network,
            &aa_contract,
            &account_id_raw,
            &disposable_account,
            &session_nonce,
            &expires_at,
        )?;
        let action_nullifier =
            compute_action_nullifier(&provider, &provider_uid, &action_id, &salt_bytes);
        let ticket = AaActionTicket {
            network,
            aa_contract,
            account_id_raw,
            verifier_contract,
            account_id,
            disposable_account,
            action_id,
            expires_at,
            action_nullifier: action_nullifier.clone(),
        };
        let digest_bytes = build_aa_action_digest_bytes(&ticket)?;
        return Ok(json!({
            "disposable_account": ticket.disposable_account,
            "action_id": ticket.action_id,
            "action_nullifier": format!("0x{action_nullifier}"),
            "digest": format!("0x{}", hex_encode(&digest_bytes)),
        }));
    }

    let action_id = js_trim_string(js_first_truthy(resolved_payload, &["action_id", "intent"]));
    if action_id.is_empty() {
        return Err("action_id is required".to_string());
    }
    let action_nullifier =
        compute_action_nullifier(&provider, &provider_uid, &action_id, &salt_bytes);
    let disposable_account = resolve_hash160(
        js_first_truthy(
            resolved_payload,
            &["disposable_account", "disposable_script_hash"],
        ),
        "disposable_account",
    )?;
    let network = resolve_ticket_network(io.env, resolved_payload)?;

    let ticket = ActionTicket {
        disposable_account: disposable_account.clone(),
        action_id: action_id.clone(),
        action_nullifier: action_nullifier.clone(),
        network: network.clone(),
    };
    let digest_bytes = build_action_digest_bytes(&ticket, io.env)?;
    Ok(json!({
        "disposable_account": ticket.disposable_account,
        "action_id": ticket.action_id,
        "action_nullifier": format!("0x{action_nullifier}"),
        "digest": format!("0x{}", hex_encode(&digest_bytes)),
    }))
}

/// `handleNeoDidRecoveryTicket` — high-assurance lane: the provider_uid MUST
/// be TEE-verified (web3auth) or explicitly allowlisted per provider.
pub fn neodid_recovery_ticket(io: &NeoDidIo<'_>, resolved_payload: &Json) -> Result<Json, String> {
    let salt_bytes = resolve_neo_did_salt(io.env, io.derive_key_bytes)?;
    let twitter = json!("twitter");
    let provider = require_supported_provider(
        js_first_truthy(resolved_payload, &["provider"]).or(Some(&twitter)),
    )?;
    let provider_uid = resolve_verified_provider_uid(
        io.env,
        io.verify_id_token,
        &provider,
        resolved_payload,
        "recovery",
    )?;

    let neo_n3 = json!("neo_n3");
    let network = resolve_required_text(
        js_first_truthy(resolved_payload, &["network", "target_chain"]).or(Some(&neo_n3)),
        "network",
    )?;
    let aa_contract = resolve_aa_hash160(
        js_first_truthy(
            resolved_payload,
            &["aa_contract", "account_contract", "wallet_contract"],
        ),
        "aa_contract",
    )?;
    let verifier_contract = resolve_aa_hash160(
        js_first_truthy(
            resolved_payload,
            &["verifier_contract", "recovery_verifier_contract"],
        ),
        "verifier_contract",
    )?;
    let account_address = resolve_aa_hash160(
        js_first_truthy(
            resolved_payload,
            &["account_address", "aa_address", "wallet_address"],
        ),
        "account_address",
    )?;
    let account_id_raw = resolve_aa_hash160(
        js_first_truthy(resolved_payload, &["account_id_raw", "accountIdRaw"]),
        "account_id_raw",
    )?;
    let account_id = resolve_required_text(
        js_first_truthy(resolved_payload, &["account_id", "accountId", "wallet_id"]),
        "account_id",
    )?;
    let new_owner = resolve_aa_hash160(
        js_first_truthy(
            resolved_payload,
            &["new_owner", "recovery_address", "target_owner"],
        ),
        "new_owner",
    )?;
    let recovery_nonce = resolve_decimal_text(
        js_first_truthy(resolved_payload, &["recovery_nonce", "nonce"]),
        "recovery_nonce",
    )?;
    let expires_at = resolve_required_text(
        js_first_truthy(
            resolved_payload,
            &["expires_at", "expiry", "ticket_expires_at"],
        ),
        "expires_at",
    )?;
    let master_nullifier = compute_master_nullifier(&provider, &provider_uid, &salt_bytes);
    let action_id = resolve_recovery_action_id(
        resolved_payload,
        &network,
        &aa_contract,
        &account_id_raw,
        &new_owner,
        &recovery_nonce,
    )?;
    let action_nullifier =
        compute_action_nullifier(&provider, &provider_uid, &action_id, &salt_bytes);

    let ticket = RecoveryTicket {
        network: network.clone(),
        aa_contract: aa_contract.clone(),
        account_id_raw: account_id_raw.clone(),
        verifier_contract: verifier_contract.clone(),
        account_address: account_address.clone(),
        account_id: account_id.clone(),
        new_owner: new_owner.clone(),
        recovery_nonce: recovery_nonce.clone(),
        expires_at: expires_at.clone(),
        action_id: action_id.clone(),
        master_nullifier: master_nullifier.clone(),
        action_nullifier: action_nullifier.clone(),
    };
    let digest_bytes = build_recovery_digest_bytes(&ticket)?;
    Ok(json!({
        "network": ticket.network,
        "aa_contract": ticket.aa_contract,
        "account_id_raw": ticket.account_id_raw,
        "verifier_contract": ticket.verifier_contract,
        "account_address": ticket.account_address,
        "account_id": ticket.account_id,
        "new_owner": ticket.new_owner,
        "recovery_nonce": ticket.recovery_nonce,
        "expires_at": ticket.expires_at,
        "provider": provider,
        "action_id": ticket.action_id,
        "master_nullifier": format!("0x{master_nullifier}"),
        "action_nullifier": format!("0x{action_nullifier}"),
        "digest": format!("0x{}", hex_encode(&digest_bytes)),
    }))
}

/// `handleNeoDidZkLoginTicket` — provider is pinned to web3auth and the lane
/// is high-assurance.
pub fn neodid_zklogin_ticket(io: &NeoDidIo<'_>, resolved_payload: &Json) -> Result<Json, String> {
    let salt_bytes = resolve_neo_did_salt(io.env, io.derive_key_bytes)?;
    let web3auth = json!("web3auth");
    let provider = require_supported_provider(
        js_first_truthy(resolved_payload, &["provider"]).or(Some(&web3auth)),
    )?;
    if provider != "web3auth" {
        return Err("zklogin-ticket currently requires provider=web3auth".to_string());
    }
    let provider_uid = resolve_verified_provider_uid(
        io.env,
        io.verify_id_token,
        &provider,
        resolved_payload,
        "zklogin",
    )?;

    let verifier_contract = resolve_hash160(
        js_first_truthy(
            resolved_payload,
            &["verifier_contract", "verifier", "verifier_hash"],
        ),
        "verifier_contract",
    )?;
    let account_id_hash = resolve_hash160(
        js_first_truthy(
            resolved_payload,
            &["account_id_hash", "account_id", "accountIdHash"],
        ),
        "account_id_hash",
    )?;
    let target_contract = resolve_hash160(
        js_first_truthy(resolved_payload, &["target_contract", "contract", "target"]),
        "target_contract",
    )?;
    let method = resolve_required_text(resolved_payload.get("method"), "method")?;
    let args_hash = resolve_hash32(
        js_first_truthy(resolved_payload, &["args_hash", "argsHash", "payload_hash"]),
        "args_hash",
    )?;
    let nonce = resolve_uint256_text(resolved_payload.get("nonce"), "nonce")?;
    let deadline = resolve_uint256_text(resolved_payload.get("deadline"), "deadline")?;
    let action_id = resolve_zklogin_action_id(
        resolved_payload,
        [
            &verifier_contract,
            &account_id_hash,
            &target_contract,
            &method,
            &args_hash,
            &nonce,
            &deadline,
        ],
    )?;
    let master_nullifier = compute_master_nullifier(&provider, &provider_uid, &salt_bytes);
    let action_nullifier =
        compute_action_nullifier(&provider, &provider_uid, &action_id, &salt_bytes);

    let ticket = ZkLoginTicket {
        verifier_contract: verifier_contract.clone(),
        account_id_hash: account_id_hash.clone(),
        target_contract: target_contract.clone(),
        method: method.clone(),
        args_hash: args_hash.clone(),
        nonce: nonce.clone(),
        deadline: deadline.clone(),
        provider: provider.clone(),
        master_nullifier: master_nullifier.clone(),
        action_nullifier: action_nullifier.clone(),
    };
    let digest_bytes = build_zklogin_digest_bytes(&ticket)?;
    Ok(json!({
        "verifier_contract": ticket.verifier_contract,
        "account_id_hash": ticket.account_id_hash,
        "target_contract": ticket.target_contract,
        "method": ticket.method,
        "args_hash": ticket.args_hash,
        "nonce": ticket.nonce,
        "deadline": ticket.deadline,
        "provider": ticket.provider,
        "action_id": action_id,
        "master_nullifier": format!("0x{master_nullifier}"),
        "action_nullifier": format!("0x{action_nullifier}"),
        "digest": format!("0x{}", hex_encode(&digest_bytes)),
    }))
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn sha256_hex(input: &[u8]) -> String {
    hex_encode(&Sha256::digest(input))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn env_from(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        move |name| map.get(name).cloned()
    }

    // Node golden vectors (workers/nitro-worker/src/neodid/index.js replicated
    // inline with node:crypto — same Buffer.concat/sha256 pipeline). Nullifier
    // goldens use salt text 'unit-test-salt-text'; flow goldens use the exact
    // payloads their tests feed through the flows.
    const GOLDEN_SALT_HEX_TEXT: &str =
        "eab55a83ec5f756cca6d2f0755d4963b8fafb21b8c3daea85ed7e38fe000b278";
    const GOLDEN_MASTER_NULLIFIER: &str =
        "66e5240eeadb575b8ce815f4f6a1c090c75db9413b296786d7cc1e7720771761";
    const GOLDEN_ACTION_NULLIFIER: &str =
        "7c375436bcfe6f9698af9e267f46a8eb91d8a1192860d640d743303c9facb4b6";
    const GOLDEN_MASTER_TWITTER: &str =
        "935b03c49e838b13fe3a1d6929c6f2c50e86888507154007922eacc96115bdc9";
    const GOLDEN_MASTER_ZK: &str =
        "e2c24746df23ab2c7fe04ec116c41da81db7966c3e25da2b32aff5c3480ec21b";
    const GOLDEN_BIND_META_HASH: &str =
        "8f46696cf3b5b0f66254160dad2e261758d3728338364a82337b5df7da98ac8b";
    const GOLDEN_BIND_DIGEST: &str =
        "d94474a557325215aca88be499503459b6541e6b6bf6a28ad60517292f7d1694";
    const GOLDEN_ACT_NULL_TW: &str =
        "09991669650a654a54ace219dc7d0958330d2ff772f05117d949548c691a429d";
    const GOLDEN_ACT_DIGEST: &str =
        "f2f70b124e604b7ac3696ba62382d00b4748607e259ab6b56275ecbaa27c6640";
    const GOLDEN_AA_ACTION_ID_DIGEST: &str =
        "ca0d3b5865caf8b07c0a2b2eb7ea05ded9b7f4eb81a657ed64316af587553557";
    const GOLDEN_AA_ACTION_NULL: &str =
        "41a081d59869e15b50c01d3143eeddbcf46c27e804240d83516c9c5325335d05";
    const GOLDEN_AA_ACTION_DIGEST: &str =
        "6997b70a6dd9a8d54c56c9c5792ebec5c780ee884d73464ec4d9eed6b9b405ae";
    const GOLDEN_AA_DEFAULT_NONCE_ACTION_ID_DIGEST: &str =
        "23c9db0c12665b099e7e384173cd2474110a94c7d73b87a27b22b139650d66ae";
    const GOLDEN_AA_DEFAULT_NONCE_DIGEST: &str =
        "7dec99dc9584272e21cd46e5780dd33667e70ff18ad8433cbab6ef1d05e5dadb";
    const GOLDEN_REC_ACTION_ID_DIGEST: &str =
        "a01b356e0ca61b0e9d44433ff86628e8d299bb045ae410a000e0bac5cfef80f8";
    const GOLDEN_REC_NULL: &str =
        "4751923c6caacd2506e954a94a46badfd16b49fbbc49fc56ebab154e4500cd2f";
    const GOLDEN_REC_DIGEST: &str =
        "c6df81ac0312f04224fa3ae534853efd98bd65c94b9f47ff0c75f005fb37415e";
    const GOLDEN_ZK_ACTION_ID_DIGEST: &str =
        "ba9ae2ee36d9ced6d1d848bf8b890a56b658804f48ac15aab21969adbfe1183b";
    const GOLDEN_ZK_NULL: &str = "1d1f3ef311785b4b021f9b4b25ebceffa801478117e25cfcce33812578cb7b7a";
    const GOLDEN_ZK_DIGEST: &str =
        "f49b251a6aa68fd65828c4497f8c622d1281247072c4ef86566a6da30989b0f0";

    fn salt_env() -> impl Fn(&str) -> Option<String> {
        env_from(&[("NEODID_SECRET_SALT", "unit-test-salt-text")])
    }

    fn unreachable_verify() -> VerifyIdToken<'static> {
        &|_request: &Web3AuthVerifyRequest<'_>| unreachable!("web3auth verification not expected")
    }

    fn unreachable_derive() -> DeriveKeyBytes<'static> {
        &|_path: &str, _purpose: &str| unreachable!("TEE salt derivation not expected")
    }

    fn unreachable_salt_env() -> impl Fn(&str) -> Option<String> {
        env_from(&[])
    }

    fn io_with<'a>(
        env: EnvReader<'a>,
        verify: VerifyIdToken<'a>,
        derive: DeriveKeyBytes<'a>,
    ) -> NeoDidIo<'a> {
        NeoDidIo {
            env,
            verify_id_token: verify,
            derive_key_bytes: derive,
        }
    }

    fn assert_keys(object: &Json, expected: &[&str]) {
        let keys: Vec<String> = object
            .as_object()
            .expect("object")
            .keys()
            .cloned()
            .collect();
        let expected: Vec<String> = expected.iter().map(|key| key.to_string()).collect();
        assert_eq!(keys, expected);
    }

    #[test]
    fn provider_catalog_matches_the_js_table() {
        assert_eq!(
            supported_providers(),
            json!([
                {
                    "id": "web3auth",
                    "category": "identity",
                    "aliases": ["w3a"],
                    "auth_modes": ["aggregate_oauth", "mfa"],
                    "claim_types": [
                        "Web3Auth_PrimaryIdentity",
                        "Web3Auth_LinkedSocials",
                        "Web3Auth_VerifiedUser"
                    ],
                    "derives_provider_uid_in_tee": true,
                },
                {
                    "id": "twitter",
                    "category": "social",
                    "aliases": [],
                    "auth_modes": ["oauth"],
                    "claim_types": ["Twitter_VIP", "Twitter_Verified", "Twitter_Followers"],
                    "derives_provider_uid_in_tee": false,
                },
                {
                    "id": "github",
                    "category": "social",
                    "aliases": [],
                    "auth_modes": ["oauth"],
                    "claim_types": ["Github_Contributor", "Github_OrgMember", "Github_VerifiedUser"],
                    "derives_provider_uid_in_tee": false,
                },
                {
                    "id": "google",
                    "category": "social",
                    "aliases": ["gmail"],
                    "auth_modes": ["oauth"],
                    "claim_types": ["Google_Identity", "Google_Workspace", "Google_VerifiedEmail"],
                    "derives_provider_uid_in_tee": false,
                },
                {
                    "id": "discord",
                    "category": "social",
                    "aliases": [],
                    "auth_modes": ["oauth"],
                    "claim_types": ["Discord_Member"],
                    "derives_provider_uid_in_tee": false,
                },
                {
                    "id": "telegram",
                    "category": "social",
                    "aliases": [],
                    "auth_modes": ["oauth"],
                    "claim_types": ["Telegram_Member"],
                    "derives_provider_uid_in_tee": false,
                },
                {
                    "id": "binance",
                    "category": "exchange",
                    "aliases": [],
                    "auth_modes": ["api", "oauth"],
                    "claim_types": ["Binance_KYC", "Binance_VIP", "Binance_AssetHolder"],
                    "derives_provider_uid_in_tee": false,
                },
                {
                    "id": "okx",
                    "category": "exchange",
                    "aliases": ["okex"],
                    "auth_modes": ["api", "oauth"],
                    "claim_types": ["OKX_KYC", "OKX_VIP", "OKX_AssetHolder"],
                    "derives_provider_uid_in_tee": false,
                },
                {
                    "id": "email",
                    "category": "contact",
                    "aliases": ["mail"],
                    "auth_modes": ["otp", "magic_link"],
                    "claim_types": ["Email_Verified"],
                    "derives_provider_uid_in_tee": false,
                },
                {
                    "id": "generic_oauth",
                    "category": "generic",
                    "aliases": [],
                    "auth_modes": ["oauth"],
                    "claim_types": ["Generic_Claim"],
                    "derives_provider_uid_in_tee": false,
                },
            ])
        );
        let catalog = supported_providers();
        let first = catalog[0].as_object().expect("object");
        assert_keys(
            &Json::Object(first.clone()),
            &[
                "id",
                "category",
                "aliases",
                "auth_modes",
                "claim_types",
                "derives_provider_uid_in_tee",
            ],
        );
    }

    #[test]
    fn provider_alias_normalization_matches_js() {
        assert_eq!(
            require_supported_provider(Some(&json!("w3a"))).unwrap(),
            "web3auth"
        );
        assert_eq!(
            require_supported_provider(Some(&json!("OKEX"))).unwrap(),
            "okx"
        );
        assert_eq!(
            require_supported_provider(Some(&json!(" Gmail "))).unwrap(),
            "google"
        );
        assert_eq!(
            require_supported_provider(Some(&json!("mail"))).unwrap(),
            "email"
        );
        // Flows always pass a chain value (provider || default); a bare None
        // is the JS `undefined` coercion in the template.
        assert_eq!(
            require_supported_provider(None).unwrap_err(),
            "unsupported neodid provider: undefined"
        );
        assert_eq!(
            require_supported_provider(Some(&json!("bogus")))
                .unwrap_err()
                .to_string(),
            "unsupported neodid provider: bogus"
        );
        // The message embeds the raw pre-normalize value, String()-coerced.
        assert_eq!(
            require_supported_provider(Some(&json!({})))
                .unwrap_err()
                .to_string(),
            "unsupported neodid provider: [object Object]"
        );
        assert_eq!(
            require_supported_provider(Some(&json!(123)))
                .unwrap_err()
                .to_string(),
            "unsupported neodid provider: 123"
        );
    }

    #[test]
    fn nullifiers_match_node_golden() {
        let salt = resolve_neo_did_salt(&salt_env(), unreachable_derive()).unwrap();
        assert_eq!(hex_encode(&salt), GOLDEN_SALT_HEX_TEXT);
        assert_eq!(
            compute_master_nullifier("web3auth", "user-42", &salt),
            GOLDEN_MASTER_NULLIFIER
        );
        assert_eq!(
            compute_action_nullifier("web3auth", "user-42", "act-1", &salt),
            GOLDEN_ACTION_NULLIFIER
        );
    }

    #[test]
    fn salt_resolution_follows_both_js_paths() {
        // Explicit env: sha256 of the hex TEXT.
        let salt = resolve_neo_did_salt(&salt_env(), unreachable_derive()).unwrap();
        assert_eq!(hex_encode(&salt), GOLDEN_SALT_HEX_TEXT);

        // Derived path: sha256 of the hex text of the TEE-derived bytes.
        let derived_calls = std::cell::RefCell::new(Vec::new());
        let derive: DeriveKeyBytes<'_> = &|path: &str, purpose: &str| {
            derived_calls
                .borrow_mut()
                .push((path.to_string(), purpose.to_string()));
            Ok(vec![0xAA, 0xBB, 0xCC])
        };
        let salt = resolve_neo_did_salt(&unreachable_salt_env(), derive).unwrap();
        assert_eq!(hex_encode(&salt), sha256_hex(b"aabbcc"));
        assert_eq!(
            derived_calls.borrow()[0],
            (
                "morpheus/neodid/nullifier/v1".to_string(),
                "neodid-nullifier-salt".to_string()
            )
        );

        // Custom key path passes through.
        let paths = std::cell::RefCell::new(Vec::new());
        let derive: DeriveKeyBytes<'_> = &|path: &str, _purpose: &str| {
            paths.borrow_mut().push(path.to_string());
            Ok(vec![0x01])
        };
        let env = env_from(&[("NITRO_NEODID_SALT_PATH", "custom/salt/path")]);
        let _ = resolve_neo_did_salt(&env, derive).unwrap();
        assert_eq!(paths.borrow()[0], "custom/salt/path");

        // Derivation failure degrades to the JS catch message.
        let derive: DeriveKeyBytes<'_> =
            &|_path: &str, _purpose: &str| Err("no dstack".to_string());
        assert_eq!(
            resolve_neo_did_salt(&unreachable_salt_env(), derive).unwrap_err(),
            "NeoDID salt unavailable: set NEODID_SECRET_SALT env var or ensure dstack is available"
        );
    }

    #[test]
    fn binding_digest_matches_node_golden() {
        let env = env_from(&[
            ("NEODID_SECRET_SALT", "unit-test-salt-text"),
            ("MORPHEUS_NEODID_ALLOW_UNVERIFIED_UID", "true"),
        ]);
        let payload = json!({
            "provider": "twitter",
            "provider_uid": "user-42",
            "vault_account": format!("0x{}", "11".repeat(20)),
            "claim_type": "Web3Auth_PrimaryIdentity",
            "claim_value": "tier-1",
            "metadata": { "tier": 1 },
        });
        let io = io_with(&env, unreachable_verify(), unreachable_derive());
        let result = neodid_bind(&io, &payload).unwrap();
        assert_keys(
            &result,
            &[
                "binding_mode",
                "vault_account",
                "provider",
                "claim_type",
                "claim_value",
                "claim_commitment",
                "master_nullifier",
                "metadata_hash",
                "digest",
                "commitment_digest",
            ],
        );
        assert_eq!(result["vault_account"], format!("0x{}", "11".repeat(20)));
        assert_eq!(result["provider"], "twitter");
        assert_eq!(result["claim_type"], "Web3Auth_PrimaryIdentity");
        assert_eq!(result["claim_value"], "tier-1");
        assert_eq!(
            result["master_nullifier"],
            format!("0x{GOLDEN_MASTER_TWITTER}")
        );
        // stableStringify({ "tier": 1 }) → sha256 — the same object hash the
        // worker signs (metadata defaults to {} when absent).
        assert_eq!(
            result["metadata_hash"],
            format!("0x{GOLDEN_BIND_META_HASH}")
        );
        // Testnet fallback magic (env unset) rides at the end of the preimage.
        assert_eq!(result["digest"], format!("0x{GOLDEN_BIND_DIGEST}"));
        // Commitment-v1 golden from the Nitro worker implementation. The
        // private claim domain and the on-chain binding domain are distinct.
        assert_eq!(
            result["claim_commitment"],
            "0xbfb2467d287825542532cfb80e20df976eece730fb1fc5f93b50247593226256"
        );
        assert_eq!(
            result["commitment_digest"],
            "0x4ade82db86aeffadd0ef0c603c0e24ecb4d9ac182938710fffebe4b3cd3e7d51"
        );
    }

    #[test]
    fn action_digest_matches_node_golden() {
        // A mainnet ticket is issued by a mainnet host.
        let env = env_from(&[
            ("NEODID_SECRET_SALT", "unit-test-salt-text"),
            ("MORPHEUS_NEODID_ALLOW_UNVERIFIED_UID", "true"),
            ("MORPHEUS_NETWORK", "mainnet"),
        ]);
        let payload = json!({
            "provider": "twitter",
            "provider_uid": "user-42",
            "action_id": "act-1",
            "disposable_account": format!("0x{}", "22".repeat(20)),
            "network": "mainnet",
        });
        let io = io_with(&env, unreachable_verify(), unreachable_derive());
        let result = neodid_action_ticket(&io, &payload).unwrap();
        assert_keys(
            &result,
            &[
                "disposable_account",
                "action_id",
                "action_nullifier",
                "digest",
            ],
        );
        assert_eq!(result["action_id"], "act-1");
        assert_eq!(
            result["action_nullifier"],
            format!("0x{GOLDEN_ACT_NULL_TW}")
        );
        // Mainnet fallback magic rides at the end of the preimage.
        assert_eq!(result["digest"], format!("0x{GOLDEN_ACT_DIGEST}"));
        let mut explicit_v1 = payload.clone();
        explicit_v1["callback_encoding"] = json!("neo_n3_action_v1");
        assert_eq!(result, neodid_action_ticket(&io, &explicit_v1).unwrap());
    }

    fn ticket_payload(network: Option<&str>) -> Json {
        let mut payload = json!({
            "provider": "twitter",
            "provider_uid": "user-42",
            "vault_account": format!("0x{}", "11".repeat(20)),
            "action_id": "act-1",
            "disposable_account": format!("0x{}", "22".repeat(20)),
        });
        if let Some(network) = network {
            payload["network"] = json!(network);
        }
        payload
    }

    fn host_env(network: Option<&'static str>) -> impl Fn(&str) -> Option<String> {
        let mut pairs = vec![
            ("NEODID_SECRET_SALT", "unit-test-salt-text"),
            ("MORPHEUS_NEODID_ALLOW_UNVERIFIED_UID", "true"),
        ];
        if let Some(network) = network {
            pairs.push(("MORPHEUS_NETWORK", network));
        }
        env_from(&pairs)
    }

    fn aa_action_v3_payload() -> Json {
        json!({
            "provider": "twitter",
            "provider_uid": "user-42",
            "network": "neo3-testnet",
            "aa_contract": format!("0x{}", "11".repeat(20)),
            "verifier_contract": format!("0x{}", "33".repeat(20)),
            "account_id_raw": format!("0x{}", "22".repeat(20)),
            "account_id": "acct-1",
            "disposable_account": format!("0x{}", "44".repeat(20)),
            "expires_at": "1735689600",
            "session_nonce": "7",
            "callback_encoding": "neo_n3_action_v3",
        })
    }

    fn recovery_v3_payload() -> Json {
        json!({
            "provider": "twitter",
            "provider_uid": "user-42",
            "network": "neo3-testnet",
            "aa_contract": format!("0x{}", "33".repeat(20)),
            "account_id_raw": format!("0x{}", "66".repeat(20)),
            "verifier_contract": format!("0x{}", "77".repeat(20)),
            "account_address": format!("0x{}", "44".repeat(20)),
            "account_id": "acct-1",
            "new_owner": format!("0x{}", "55".repeat(20)),
            "recovery_nonce": "7",
            "expires_at": "1735689600",
            "callback_encoding": "neo_n3_recovery_v3",
        })
    }

    fn recovery_env() -> impl Fn(&str) -> Option<String> {
        env_from(&[
            ("NEODID_SECRET_SALT", "unit-test-salt-text"),
            (
                "MORPHEUS_NEODID_RECOVERY_ALLOW_UNVERIFIED_PROVIDERS",
                "twitter",
            ),
        ])
    }

    #[test]
    fn aa_action_v2_matches_node_golden_and_binds_the_raw_account() {
        let env = host_env(None);
        let io = io_with(&env, unreachable_verify(), unreachable_derive());
        let payload = aa_action_v3_payload();
        let result = neodid_action_ticket(&io, &payload).unwrap();
        assert_keys(
            &result,
            &[
                "disposable_account",
                "action_id",
                "action_nullifier",
                "digest",
            ],
        );
        assert_eq!(
            result["action_id"],
            format!("aa_proxy:{GOLDEN_AA_ACTION_ID_DIGEST}")
        );
        assert_eq!(
            result["action_nullifier"],
            format!("0x{GOLDEN_AA_ACTION_NULL}")
        );
        assert_eq!(result["digest"], format!("0x{GOLDEN_AA_ACTION_DIGEST}"));

        let mut explicit = payload.clone();
        explicit["action_id"] = result["action_id"].clone();
        assert_eq!(result, neodid_action_ticket(&io, &explicit).unwrap());

        let mut default_nonce = payload.clone();
        default_nonce
            .as_object_mut()
            .expect("payload object")
            .remove("session_nonce");
        let default_nonce = neodid_action_ticket(&io, &default_nonce).unwrap();
        assert_eq!(
            default_nonce["action_id"],
            format!("aa_proxy:{GOLDEN_AA_DEFAULT_NONCE_ACTION_ID_DIGEST}")
        );
        assert_eq!(
            default_nonce["digest"],
            format!("0x{GOLDEN_AA_DEFAULT_NONCE_DIGEST}")
        );

        let mut other_raw = payload.clone();
        other_raw["account_id_raw"] = json!(format!("0x{}", "55".repeat(20)));
        let other_raw = neodid_action_ticket(&io, &other_raw).unwrap();
        assert_ne!(other_raw["action_id"], result["action_id"]);
        assert_ne!(other_raw["digest"], result["digest"]);

        let mut foreign = payload;
        foreign["action_id"] = json!("aa_proxy:foreign");
        assert_eq!(
            neodid_action_ticket(&io, &foreign).unwrap_err(),
            "action_id does not match the derived AA action"
        );
    }

    #[test]
    fn aa_action_v3_rejects_missing_or_zero_context_and_non_decimal_numbers() {
        let env = host_env(None);
        let io = io_with(&env, unreachable_verify(), unreachable_derive());
        for field in [
            "network",
            "aa_contract",
            "verifier_contract",
            "account_id_raw",
            "account_id",
            "disposable_account",
            "expires_at",
        ] {
            let mut payload = aa_action_v3_payload();
            payload
                .as_object_mut()
                .expect("payload object")
                .remove(field);
            let error = neodid_action_ticket(&io, &payload).unwrap_err();
            assert!(error.contains(field), "{field}: {error}");
        }
        for field in [
            "aa_contract",
            "verifier_contract",
            "account_id_raw",
            "disposable_account",
        ] {
            let mut payload = aa_action_v3_payload();
            payload[field] = json!(format!("0x{}", "00".repeat(20)));
            assert_eq!(
                neodid_action_ticket(&io, &payload).unwrap_err(),
                format!("{field} must be a non-zero 20-byte hash160")
            );
        }
        for field in ["session_nonce", "expires_at"] {
            let mut payload = aa_action_v3_payload();
            payload[field] = json!("not-decimal");
            assert_eq!(
                neodid_action_ticket(&io, &payload).unwrap_err(),
                format!("{field} must be a decimal string")
            );
        }
    }

    #[test]
    fn bind_and_action_tickets_default_to_the_host_network() {
        let mainnet = host_env(Some("mainnet"));
        let io = io_with(&mainnet, unreachable_verify(), unreachable_derive());
        // With no label, a mainnet host binds the mainnet magic: the digest an
        // explicit mainnet label produces, and the action golden above.
        let action = neodid_action_ticket(&io, &ticket_payload(None)).unwrap();
        assert_eq!(action["digest"], format!("0x{GOLDEN_ACT_DIGEST}"));
        assert_eq!(
            action,
            neodid_action_ticket(&io, &ticket_payload(Some("mainnet"))).unwrap()
        );
        let bind = neodid_bind(&io, &ticket_payload(None)).unwrap();
        assert_eq!(
            bind,
            neodid_bind(&io, &ticket_payload(Some("MAINNET"))).unwrap()
        );

        // The TestNet default applies only to a host with no MORPHEUS_NETWORK.
        let unset = host_env(None);
        let io_unset = io_with(&unset, unreachable_verify(), unreachable_derive());
        let testnet_bind = neodid_bind(&io_unset, &ticket_payload(None)).unwrap();
        assert_eq!(
            testnet_bind,
            neodid_bind(&io_unset, &ticket_payload(Some("testnet"))).unwrap()
        );
        assert_ne!(bind["digest"], testnet_bind["digest"]);
    }

    #[test]
    fn a_ticket_for_another_network_than_the_host_is_refused() {
        let testnet = host_env(Some("testnet"));
        let io = io_with(&testnet, unreachable_verify(), unreachable_derive());
        assert_eq!(
            neodid_bind(&io, &ticket_payload(Some("mainnet"))).unwrap_err(),
            "ticket network mainnet does not match the host network testnet"
        );
        let mut action = ticket_payload(None);
        action["morpheus_network"] = json!("mainnet");
        assert_eq!(
            neodid_action_ticket(&io, &action).unwrap_err(),
            "ticket network mainnet does not match the host network testnet"
        );
        // An unknown label is refused as such, never mapped to the host network.
        assert_eq!(
            neodid_bind(&io, &ticket_payload(Some("staging"))).unwrap_err(),
            "unsupported Neo network: staging"
        );
        // So is a host whose own network is not a reviewed one.
        let staging = host_env(Some("staging"));
        let io = io_with(&staging, unreachable_verify(), unreachable_derive());
        assert_eq!(
            neodid_action_ticket(&io, &ticket_payload(None)).unwrap_err(),
            "unsupported Neo network: staging"
        );
    }

    #[test]
    fn recovery_digest_matches_node_golden() {
        let env = recovery_env();
        let payload = recovery_v3_payload();
        let io = io_with(&env, unreachable_verify(), unreachable_derive());
        let result = neodid_recovery_ticket(&io, &payload).unwrap();
        assert_keys(
            &result,
            &[
                "network",
                "aa_contract",
                "account_id_raw",
                "verifier_contract",
                "account_address",
                "account_id",
                "new_owner",
                "recovery_nonce",
                "expires_at",
                "provider",
                "action_id",
                "master_nullifier",
                "action_nullifier",
                "digest",
            ],
        );
        // Derived action id binds the raw account and canonical recovery nonce.
        assert_eq!(
            result["action_id"],
            format!("aa_recovery:{GOLDEN_REC_ACTION_ID_DIGEST}")
        );
        assert_eq!(
            result["master_nullifier"],
            format!("0x{GOLDEN_MASTER_TWITTER}")
        );
        assert_eq!(result["action_nullifier"], format!("0x{GOLDEN_REC_NULL}"));
        assert_eq!(
            result["verifier_contract"],
            format!("0x{}", "77".repeat(20))
        );
        assert_eq!(result["digest"], format!("0x{GOLDEN_REC_DIGEST}"));
    }

    #[test]
    fn recovery_rejects_missing_or_zero_aa_hash_context() {
        let env = recovery_env();
        let io = io_with(&env, unreachable_verify(), unreachable_derive());
        for field in [
            "aa_contract",
            "account_id_raw",
            "verifier_contract",
            "account_address",
            "new_owner",
        ] {
            let mut missing = recovery_v3_payload();
            missing
                .as_object_mut()
                .expect("payload object")
                .remove(field);
            assert_eq!(
                neodid_recovery_ticket(&io, &missing).unwrap_err(),
                format!("{field} is required")
            );

            let mut zero = recovery_v3_payload();
            zero[field] = json!(format!("0x{}", "00".repeat(20)));
            assert_eq!(
                neodid_recovery_ticket(&io, &zero).unwrap_err(),
                format!("{field} must be a non-zero 20-byte hash160")
            );
        }
    }

    #[test]
    fn recovery_action_id_rejects_foreign_and_cross_account_bindings() {
        let env = recovery_env();
        let io = io_with(&env, unreachable_verify(), unreachable_derive());
        let payload = recovery_v3_payload();
        let expected = neodid_recovery_ticket(&io, &payload).unwrap();

        let mut explicit = payload.clone();
        explicit["action_id"] = expected["action_id"].clone();
        assert_eq!(expected, neodid_recovery_ticket(&io, &explicit).unwrap());

        let mut other_raw_payload = payload.clone();
        other_raw_payload["account_id_raw"] = json!(format!("0x{}", "67".repeat(20)));
        let other_raw = neodid_recovery_ticket(&io, &other_raw_payload).unwrap();
        assert_eq!(other_raw["account_id"], expected["account_id"]);
        assert_ne!(other_raw["action_id"], expected["action_id"]);
        assert_ne!(other_raw["digest"], expected["digest"]);

        let mut foreign = payload.clone();
        foreign["action_id"] = json!("aa_recovery:foreign");
        assert_eq!(
            neodid_recovery_ticket(&io, &foreign).unwrap_err(),
            "action_id does not match the derived recovery action"
        );

        let mut bad_nonce = payload;
        bad_nonce["recovery_nonce"] = json!("n-1");
        assert_eq!(
            neodid_recovery_ticket(&io, &bad_nonce).unwrap_err(),
            "recovery_nonce must be a decimal string"
        );
    }

    #[test]
    fn zklogin_digest_matches_node_golden() {
        let verify: VerifyIdToken<'_> = &|request: &Web3AuthVerifyRequest<'_>| {
            assert_eq!(request.id_token, "tok-1");
            assert_eq!(
                request.jwks_url,
                "https://api-auth.web3auth.io/.well-known/jwks.json"
            );
            assert_eq!(request.audience, "client-1");
            assert_eq!(request.issuer, None);
            Ok(json!({
                "aggregateVerifier": "agg-v",
                "aggregateVerifierId": "user-42",
            }))
        };
        let payload = json!({
            "id_token": "tok-1",
            "verifier_contract": format!("0x{}", "66".repeat(20)),
            "account_id_hash": format!("0x{}", "77".repeat(20)),
            "target_contract": format!("0x{}", "88".repeat(20)),
            "method": "transfer",
            "args_hash": format!("0x{}", "99".repeat(32)),
            "nonce": "1710001234",
            "deadline": "9999999999",
        });
        let env = env_from(&[
            ("NEODID_SECRET_SALT", "unit-test-salt-text"),
            ("WEB3AUTH_CLIENT_ID", "client-1"),
        ]);
        let io = io_with(&env, verify, unreachable_derive());
        let result = neodid_zklogin_ticket(&io, &payload).unwrap();
        assert_keys(
            &result,
            &[
                "verifier_contract",
                "account_id_hash",
                "target_contract",
                "method",
                "args_hash",
                "nonce",
                "deadline",
                "provider",
                "action_id",
                "master_nullifier",
                "action_nullifier",
                "digest",
            ],
        );
        // The verified uid carries the stable web3auth: prefix into the
        // nullifiers — the golden hashes 'web3auth:agg-v:user-42'.
        assert_eq!(
            result["action_id"],
            format!("aa_zklogin:{GOLDEN_ZK_ACTION_ID_DIGEST}")
        );
        assert_eq!(result["master_nullifier"], format!("0x{GOLDEN_MASTER_ZK}"));
        assert_eq!(result["action_nullifier"], format!("0x{GOLDEN_ZK_NULL}"));
        assert_eq!(result["digest"], format!("0x{GOLDEN_ZK_DIGEST}"));
    }

    #[test]
    fn action_ticket_gates_the_unverified_uid_by_default() {
        let env = env_from(&[("NEODID_SECRET_SALT", "unit-test-salt-text")]);
        let payload = json!({
            "provider": "twitter",
            "provider_uid": "user-42",
            "action_id": "act-1",
            "disposable_account": format!("0x{}", "22".repeat(20)),
        });
        let io = io_with(&env, unreachable_verify(), unreachable_derive());
        let error = neodid_action_ticket(&io, &payload).unwrap_err();
        assert_eq!(
            error,
            "provider twitter provider_uid is not verified in the enclave; \
             unverified provider_uid is disabled (MORPHEUS_NEODID_ALLOW_UNVERIFIED_UID=false)"
        );

        // The allow flag re-opens the low-assurance lane.
        let env_allow = env_from(&[
            ("NEODID_SECRET_SALT", "unit-test-salt-text"),
            ("MORPHEUS_NEODID_ALLOW_UNVERIFIED_UID", "on"),
        ]);
        let io = io_with(&env_allow, unreachable_verify(), unreachable_derive());
        let result = neodid_action_ticket(&io, &payload).unwrap();
        assert_eq!(result["action_id"], "act-1");
    }

    #[test]
    fn recovery_ticket_fails_closed_except_the_per_provider_allowlist() {
        let salt = env_from(&[("NEODID_SECRET_SALT", "unit-test-salt-text")]);
        let payload = json!({
            "provider": "twitter",
            "provider_uid": "user-42",
            "network": "neo_n3",
            "aa_contract": format!("0x{}", "33".repeat(20)),
            "account_id": "acct-1",
            "new_owner": format!("0x{}", "55".repeat(20)),
            "recovery_nonce": "7",
            "expires_at": "2026-01-01T00:00:00Z",
        });
        let io = io_with(&salt, unreachable_verify(), unreachable_derive());
        let error = neodid_recovery_ticket(&io, &payload).unwrap_err();
        assert_eq!(
            error,
            "provider twitter provider_uid is not verified in the enclave; \
             recovery-ticket requires a TEE-verified provider_uid \
             (enable per-provider via MORPHEUS_NEODID_RECOVERY_ALLOW_UNVERIFIED_PROVIDERS)"
        );

        // Allowlist entries normalize through the alias map: 'okex' → 'okx'.
        let env_allow = env_from(&[
            ("NEODID_SECRET_SALT", "unit-test-salt-text"),
            (
                "MORPHEUS_NEODID_RECOVERY_ALLOW_UNVERIFIED_PROVIDERS",
                "okex, twitter",
            ),
        ]);
        let okx_payload = json!({
            "provider": "okx",
            "provider_uid": "user-42",
            "network": "neo_n3",
            "aa_contract": format!("0x{}", "33".repeat(20)),
            "account_id_raw": format!("0x{}", "66".repeat(20)),
            "verifier_contract": format!("0x{}", "77".repeat(20)),
            "account_address": format!("0x{}", "44".repeat(20)),
            "account_id": "acct-1",
            "new_owner": format!("0x{}", "55".repeat(20)),
            "recovery_nonce": "7",
            "expires_at": "2026-01-01T00:00:00Z",
        });
        let io = io_with(&env_allow, unreachable_verify(), unreachable_derive());
        let result = neodid_recovery_ticket(&io, &okx_payload).unwrap();
        assert_eq!(result["provider"], "okx");

        // The allowlist is per-lane: bind does NOT inherit it (twitter stays
        // gated by the global flag there).
        let io = io_with(&env_allow, unreachable_verify(), unreachable_derive());
        assert_eq!(
            neodid_action_ticket(
                &io,
                &json!({
                    "provider": "twitter",
                    "provider_uid": "user-42",
                    "action_id": "act-1",
                    "disposable_account": format!("0x{}", "22".repeat(20)),
                })
            )
            .unwrap_err(),
            "provider twitter provider_uid is not verified in the enclave; \
             unverified provider_uid is disabled (MORPHEUS_NEODID_ALLOW_UNVERIFIED_UID=false)"
        );
    }

    #[test]
    fn web3auth_uid_derivation_covers_all_three_claim_shapes() {
        let env = env_from(&[("WEB3AUTH_CLIENT_ID", "client-1")]);
        let verify: VerifyIdToken<'_> = &|request: &Web3AuthVerifyRequest<'_>| {
            // Trust anchors come from env, never from the payload — a payload
            // cannot point the verifier at its own JWKS.
            assert_eq!(
                request.jwks_url,
                "https://api-auth.web3auth.io/.well-known/jwks.json"
            );
            assert_eq!(request.audience, "client-1");
            Ok(json!({
                "verifier": "v",
                "verifierId": "id-1",
                "email": "fallback@example.com",
                "sub": "sub-1",
            }))
        };
        let payload = json!({
            "id_token": "tok",
            "jwks_url": "https://attacker.example/jwks.json",
            "audience": "attacker",
        });
        assert_eq!(
            resolve_verified_provider_uid(&env, verify, "web3auth", &payload, "bind").unwrap(),
            "web3auth:v:id-1"
        );

        // Aggregate verifier wins over the single-verifier shape.
        let verify: VerifyIdToken<'_> = &|_request| {
            Ok(json!({
                "aggregateVerifier": "agg",
                "aggregateVerifierId": "aid",
                "verifier": "v",
                "verifierId": "vid",
            }))
        };
        assert_eq!(
            resolve_verified_provider_uid(
                &env,
                verify,
                "web3auth",
                &json!({"id_token": "t"}),
                "bind"
            )
            .unwrap(),
            "web3auth:agg:aid"
        );

        // No identity fields at all → empty derivation → hard error.
        let verify: VerifyIdToken<'_> = &|_request| Ok(json!({"aud": "client-1"}));
        assert_eq!(
            resolve_verified_provider_uid(
                &env,
                verify,
                "web3auth",
                &json!({"id_token": "t"}),
                "bind"
            )
            .unwrap_err(),
            "unable to derive stable Web3Auth provider_uid"
        );

        // user: fallback chain is sub → email → name.
        let verify: VerifyIdToken<'_> = &|_request| Ok(json!({"email": "e@x.com", "name": "n"}));
        assert_eq!(
            resolve_verified_provider_uid(
                &env,
                verify,
                "web3auth",
                &json!({"id_token": "t"}),
                "bind"
            )
            .unwrap(),
            "web3auth:user:e@x.com"
        );
    }

    #[test]
    fn web3auth_supplied_uid_must_match_the_verified_claims() {
        let env = env_from(&[("WEB3AUTH_CLIENT_ID", "client-1")]);
        let verify: VerifyIdToken<'_> = &|_request| Ok(json!({"sub": "real-user"}));
        assert_eq!(
            resolve_verified_provider_uid(
                &env,
                verify,
                "web3auth",
                &json!({"id_token": "t", "provider_uid": "someone-else"}),
                "bind"
            )
            .unwrap_err(),
            "web3auth provider_uid does not match verified id_token"
        );
        // Matching supplied uid passes through untouched.
        assert_eq!(
            resolve_verified_provider_uid(
                &env,
                verify,
                "web3auth",
                &json!({"id_token": "t", "social_uid": "web3auth:user:real-user"}),
                "bind"
            )
            .unwrap(),
            "web3auth:user:real-user"
        );
    }

    #[test]
    fn web3auth_env_anchors_and_issuer_reach_the_verifier() {
        let env = env_from(&[
            ("WEB3AUTH_JWKS_URL", "https://custom.example/jwks.json"),
            ("NEXT_PUBLIC_WEB3AUTH_CLIENT_ID", "aliased-client"),
            ("WEB3AUTH_ISSUER", "https://issuer.example"),
        ]);
        let seen = std::cell::RefCell::new(None);
        let verify: VerifyIdToken<'_> = &|request: &Web3AuthVerifyRequest<'_>| {
            *seen.borrow_mut() = Some((
                request.jwks_url.to_string(),
                request.audience.to_string(),
                request.issuer.map(str::to_string),
            ));
            Ok(json!({"sub": "u"}))
        };
        assert_eq!(
            resolve_verified_provider_uid(
                &env,
                verify,
                "web3auth",
                &json!({"id_token": "t"}),
                "bind"
            )
            .unwrap(),
            "web3auth:user:u"
        );
        assert_eq!(
            seen.borrow().as_ref().unwrap(),
            &(
                "https://custom.example/jwks.json".to_string(),
                "aliased-client".to_string(),
                Some("https://issuer.example".to_string())
            )
        );

        // No audience anywhere → hard error before verification.
        let env = env_from(&[]);
        let verify: VerifyIdToken<'_> = &|_request: &Web3AuthVerifyRequest<'_>| {
            unreachable!("must not verify without audience")
        };
        assert_eq!(
            resolve_verified_provider_uid(
                &env,
                verify,
                "web3auth",
                &json!({"id_token": "t"}),
                "bind"
            )
            .unwrap_err(),
            "WEB3AUTH_CLIENT_ID is required for web3auth verification"
        );

        // Missing id_token errors before the audience check.
        assert_eq!(
            resolve_verified_provider_uid(&env, verify, "web3auth", &json!({}), "bind")
                .unwrap_err(),
            "web3auth id_token is required"
        );
    }

    #[test]
    fn text_and_hash_resolvers_match_the_js_messages() {
        assert_eq!(
            resolve_hash160(
                Some(&json!("0XABCDEF0123456789ABCDEF0123456789ABCDEF01")),
                "f"
            )
            .unwrap(),
            "0xabcdef0123456789abcdef0123456789abcdef01"
        );
        assert_eq!(
            resolve_hash160(Some(&json!("nothex")), "vault_account").unwrap_err(),
            "vault_account must be a 20-byte hash160"
        );
        assert_eq!(
            resolve_hash160(Some(&json!("ab")), "x").unwrap_err(),
            "x must be a 20-byte hash160"
        );
        assert_eq!(
            resolve_aa_hash160(Some(&json!("  ")), "x").unwrap_err(),
            "x is required"
        );
        assert_eq!(
            resolve_aa_hash160(Some(&json!("zz")), "x").unwrap_err(),
            "x must be a 20-byte hash160"
        );
        assert_eq!(
            resolve_aa_hash160(Some(&json!(format!("0x{}", "00".repeat(20)))), "x").unwrap_err(),
            "x must be a non-zero 20-byte hash160"
        );
        assert_eq!(
            resolve_hash160(Some(&json!(format!("0x{}", "00".repeat(20)))), "legacy").unwrap(),
            format!("0x{}", "00".repeat(20))
        );
        assert_eq!(
            resolve_hash32(Some(&json!(format!("0x{}", "ab".repeat(32)))), "h").unwrap(),
            format!("0x{}", "ab".repeat(32))
        );
        assert_eq!(
            resolve_hash32(Some(&json!("abcd")), "h").unwrap_err(),
            "h must be a 32-byte hash"
        );
        assert_eq!(
            resolve_required_text(Some(&json!(null)), "network").unwrap_err(),
            "network is required"
        );
        assert_eq!(
            resolve_required_text(Some(&json!("  x ")), "network").unwrap(),
            "x"
        );
        assert_eq!(
            resolve_required_text(Some(&json!("x".repeat(256))), "network").unwrap_err(),
            "network is too long"
        );
        // 255 utf8 bytes is exactly at the cap.
        assert!(resolve_required_text(Some(&json!("é".repeat(127))), "f").is_ok());
        assert_eq!(
            resolve_uint256_text(Some(&json!("9999999999")), "deadline").unwrap(),
            "9999999999"
        );
        assert_eq!(
            resolve_uint256_text(Some(&json!("1_0")), "nonce").unwrap_err(),
            "nonce must be a uint256 string"
        );
        assert_eq!(
            resolve_uint256_text(Some(&json!("-1")), "nonce").unwrap_err(),
            "nonce must be >= 0"
        );
    }

    #[test]
    fn uint256_word_and_magic_encoding_match_the_shared_encoders() {
        assert_eq!(encode_uint256_word("1710001234", "nonce").unwrap(), {
            let mut word = [0u8; 32];
            word[28..].copy_from_slice(&hex_decode_stop_at_invalid("65ec8c52"));
            word
        });
        assert_eq!(encode_uint256_word("0", "v").unwrap(), [0u8; 32]);
        // BigInt(" 5 ") parses fine — trim is part of the grammar.
        assert_eq!(encode_uint256_word(" 5 ", "v").unwrap()[31], 5);
        let overflow = "1".repeat(80);
        assert_eq!(
            encode_uint256_word(&overflow, "v").unwrap_err(),
            "v overflows uint256"
        );

        let env = env_from(&[]);
        // Empty env uses the reviewed registry identity.
        assert_eq!(
            neo_n3_network_magic_le4("testnet", &env).unwrap(),
            [0x4e, 0x33, 0x54, 0x35]
        );
        assert_eq!(
            neo_n3_network_magic_le4("mainnet", &env).unwrap(),
            [0x4e, 0x45, 0x4f, 0x33]
        );
        // A scoped or generic override must match the reviewed identity.
        let scoped = env_from(&[("NEO_NETWORK_MAGIC_MAINNET", "860833102")]);
        assert_eq!(
            neo_n3_network_magic_le4("mainnet", &scoped).unwrap(),
            [0x4e, 0x45, 0x4f, 0x33]
        );
        let wrong = env_from(&[("NEO_NETWORK_MAGIC", "42")]);
        assert!(neo_n3_network_magic_le4("testnet", &wrong).is_err());
        let nonsense = env_from(&[("NEO_NETWORK_MAGIC", "4e454f33")]);
        assert!(neo_n3_network_magic_le4("testnet", &nonsense).is_err());
        assert!(neo_n3_network_magic_le4("neo_n3", &env).is_err());
    }

    #[test]
    fn metadata_hash_hashes_strings_as_bytes_and_objects_stably() {
        assert_eq!(
            compute_metadata_hash(Some(&json!("abc"))),
            sha256_hex(b"abc")
        );
        assert_eq!(
            compute_metadata_hash(Some(&json!({ "b": 1, "a": 2 }))),
            sha256_hex(br#"{"a":2,"b":1}"#)
        );
        assert_eq!(compute_metadata_hash(None), sha256_hex(br#"{}"#));
        // `?? {}` does NOT collapse 0 (only null/undefined) — sha256 of the
        // stable form "0". The flows' `metadata || {}` never hands 0 here.
        assert_eq!(compute_metadata_hash(Some(&json!(0))), sha256_hex(b"0"));
    }

    #[test]
    fn length_prefixed_ascii_segments_throw_beyond_255_bytes() {
        assert_eq!(
            encode_length_prefixed_ascii("abc").unwrap(),
            vec![3, b'a', b'b', b'c']
        );
        let long = "é".repeat(128); // 256 utf8 bytes
        assert_eq!(
            encode_length_prefixed_ascii(&long).unwrap_err(),
            "segment too long"
        );
        // 255 bytes is exactly at the cap.
        assert_eq!(
            encode_length_prefixed_ascii(&"a".repeat(255)).unwrap()[0],
            255
        );
    }

    #[test]
    fn zklogin_action_id_resolver_prefers_the_explicit_payload_field() {
        let payload = json!({ "zklogin_action_id": "z-explicit" });
        assert_eq!(
            resolve_zklogin_action_id(&payload, ["0xa", "0xb", "0xc", "m", "0xd", "1", "2"])
                .unwrap(),
            "z-explicit"
        );
    }
}
