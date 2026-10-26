//! The `/neodid/*` fold — the Rust shape of the capability handlers
//! (`workers/nitro-worker/src/neodid/index.js` + `capabilities.js`): the
//! golden-vector-pinned `neo-os-compute::neodid` ticket flows run
//! in-process, the digest is signed custody-side under the worker role, and
//! the D5 signed envelope is composed here instead of forwarded to the
//! keyless Node child.
//!
//! Divergences from the child, all deliberate and shared with the compute
//! fold (`compute_execute.rs`):
//!   - Encrypted-confidential REFS (remote claim over Supabase REST) fail
//!     closed with a 503 — the fold serves only direct ciphertext.
//!   - Every signed response requires a ready, network-matching custody worker
//!     key and complete identity; otherwise the lane is 503.
//!   - The Secrets-Manager salt-derivation path is refused. Production accepts
//!     only `NEODID_SECRET_SALT` materialized from a Nitro Recipient KMS
//!     ciphertext by `/provision`.
//!   - The web3auth id_token verifier reimplements jose's RS256 checks
//!     (signature, kid selection, aud/iss/exp/nbf/iat) with the same
//!     semantics but approximate error strings; the JWKS cache is a
//!     process-global map like the child's `WEB3AUTH_JWKS_CACHE` and
//!     refetches once on an unknown kid.
//!   - Flow error strings pass through the same sanitizer the child's
//!     catch-all uses (`sanitizeErrorMessage`), so request-controlled
//!     provider values cannot smuggle key-material literals into the 400.

use std::collections::HashMap;
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use aws_lc_rs::signature::{
    ParsedPublicKey, RsaPublicKeyComponents, RSA_PKCS1_1024_8192_SHA256_FOR_LEGACY_USE_ONLY,
};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use neo_os_compute::core::{normalize_target_chain, sanitize_error_message, EnvReader};
use neo_os_compute::js::{js_first_truthy, js_trim_string};
use neo_os_compute::neodid::{
    is_aa_action_v3_payload, is_aa_action_v4_payload, is_aa_recovery_v3_payload,
    neodid_action_ticket, neodid_bind, neodid_recovery_ticket, neodid_zklogin_ticket, NeoDidIo,
    ReadAaActionAuthorization, Web3AuthVerifyRequest,
};
use neo_os_compute::stable_stringify::stable_stringify;

use crate::compute_execute::{
    build_tee_attestation, reject_caller_supplied_signing_key, resolve_confidential_payload,
    resolve_payload_network, sign_worker_hex,
};
use crate::http_error;
use crate::state::{AppState, JwksFetcher};
use crate::RuntimeError;

/// `handleNeoDidBind` — the low-assurance binding ticket.
pub fn handle_neo_did_bind(
    state: &AppState,
    body: &serde_json::Value,
) -> Result<serde_json::Value, RuntimeError> {
    handle_ticket(state, body, "neodid_bind", neodid_bind, None)
}

/// `handleNeoDidActionTicket` — the low-assurance action ticket.
pub fn handle_neo_did_action_ticket(
    state: &AppState,
    body: &serde_json::Value,
) -> Result<serde_json::Value, RuntimeError> {
    handle_ticket(
        state,
        body,
        "neodid_action_ticket",
        neodid_action_ticket,
        None,
    )
}

/// Services composes this with a server-owned, canonical-core reader. The
/// callback must never be reconstructed from body proofs, caller RPC or owner.
pub fn handle_neo_did_action_ticket_with_authorization(
    state: &AppState,
    body: &serde_json::Value,
    read: ReadAaActionAuthorization<'_>,
) -> Result<serde_json::Value, RuntimeError> {
    handle_ticket(
        state,
        body,
        "neodid_action_ticket",
        neodid_action_ticket,
        Some(read),
    )
}

/// `handleNeoDidRecoveryTicket` — the high-assurance recovery ticket.
pub fn handle_neo_did_recovery_ticket(
    state: &AppState,
    body: &serde_json::Value,
) -> Result<serde_json::Value, RuntimeError> {
    handle_ticket(
        state,
        body,
        "neodid_recovery_ticket",
        neodid_recovery_ticket,
        None,
    )
}

/// `handleNeoDidZkLoginTicket` — the high-assurance Web3Auth operation
/// ticket. It uses the same confidential-payload, custody-signing and
/// attestation envelope boundary as every other NeoDID route.
pub fn handle_neo_did_zklogin_ticket(
    state: &AppState,
    body: &serde_json::Value,
) -> Result<serde_json::Value, RuntimeError> {
    handle_ticket(
        state,
        body,
        "neodid_zklogin_ticket",
        neodid_zklogin_ticket,
        None,
    )
}

/// One ticket flow end to end: confidential resolution, the ported flow,
/// the custody digest signature (`signDigestBytes`), and the signed envelope
/// (`buildNeoDidResponse` over `buildSignedResultEnvelope`). `flow` returns
/// the ticket result WITHOUT the signer spread; this composes it.
fn handle_ticket(
    state: &AppState,
    body: &serde_json::Value,
    mode: &str,
    flow: fn(&NeoDidIo<'_>, &serde_json::Value) -> Result<serde_json::Value, String>,
    read_aa_action_authorization: Option<ReadAaActionAuthorization<'_>>,
) -> Result<serde_json::Value, RuntimeError> {
    let overlay = state.overlay.read().expect("overlay lock");
    let overlay_map = overlay.merged_map();
    let env_trim = |name: &str| -> String {
        overlay_map
            .get(name)
            .map(|value| value.trim().to_string())
            .unwrap_or_default()
    };
    if env_trim("NODE_ENV").eq_ignore_ascii_case("production")
        && !env_trim("NEODID_SECRET_SALT").is_empty()
        && env_trim("NEODID_SECRET_SALT_SOURCE") != "nitro-recipient-kms"
    {
        return Err(http_error(
            503,
            "plaintext configured NeoDID salt is forbidden in production",
        ));
    }
    let resolved = resolve_confidential_payload(state, body, &overlay_map, &env_trim)?;
    // Preserve the existing primary-label errors before checking every alias.
    let network = resolve_signing_network(state, mode, &resolved)?;
    // Confidential fields are assertions about the already-selected context,
    // never a second selector. Validate before provider verification or signing.
    let route = match mode {
        "neodid_recovery_ticket" => "/neodid/recovery-ticket",
        "neodid_action_ticket" => "/neodid/action-ticket",
        _ => "/neodid",
    };
    crate::network_profiles::assert_payload_network(&state.resolve_network()?, route, &resolved)?;

    let env_reader: EnvReader = &|name: &str| overlay_map.get(name).cloned();
    let verify_id_token = |request: &Web3AuthVerifyRequest<'_>| {
        verify_id_token_web3auth(state.jwks_fetcher.as_ref(), request)
    };
    let io = NeoDidIo {
        env: env_reader,
        verify_id_token: &verify_id_token,
        derive_key_bytes: &refuse_derive_key_bytes,
        read_aa_action_authorization,
    };
    let result = flow(&io, &resolved)
        .map_err(|message| http_error(400, sanitize_error_message(&message)))?;

    // signDigestBytes(digestBytes, resolvedPayload) — the ticket digest is
    // signed custody-side under the worker role; caller-supplied key material
    // is rejected exactly like on every other signing lane.
    reject_caller_supplied_signing_key(&resolved)?;
    let digest_bytes = extract_digest_bytes(&result)?;
    let digest_signed = sign_worker_hex(state, &network, &hex::encode(&digest_bytes))?;
    let mut result = result;
    if let Some(object) = result.as_object_mut() {
        for (key, value) in build_digest_signer_spread(&digest_signed) {
            object.insert(key, value);
        }
    }

    // buildSignedResultEnvelope(result, resolvedPayload) — the envelope signs
    // the stable-stringified result bytes (a SECOND custody call) and binds
    // sha256 of them as output_hash / attestation_hash.
    let payload_bytes = stable_stringify(&result).into_bytes();
    let output_hash = neo_os_core::sha256_hex(&payload_bytes);
    let result_signed = sign_worker_hex(state, &network, &hex::encode(&payload_bytes))?;
    let tee_attestation = build_tee_attestation(state, &resolved, "custody", &output_hash)?;

    // `{...result, mode, callback_encoding: ... || undefined, output_hash,
    // attestation_hash, verification, tee_attestation}` — JSON.stringify drops
    // an undefined callback_encoding, so the key is omitted when empty.
    let callback_encoding = js_trim_string(js_first_truthy(
        &resolved,
        &["callback_encoding", "result_encoding"],
    ));
    let mut response = serde_json::Map::new();
    if let Some(object) = result.as_object() {
        for (key, value) in object {
            response.insert(key.clone(), value.clone());
        }
    }
    response.insert(
        "mode".to_string(),
        serde_json::Value::String(mode.to_string()),
    );
    if !callback_encoding.is_empty() {
        response.insert(
            "callback_encoding".to_string(),
            serde_json::Value::String(callback_encoding),
        );
    }
    response.insert(
        "output_hash".to_string(),
        serde_json::Value::String(output_hash.clone()),
    );
    response.insert(
        "attestation_hash".to_string(),
        serde_json::Value::String(output_hash.clone()),
    );
    response.insert(
        "verification".to_string(),
        build_verification_envelope(&output_hash, &result_signed, &tee_attestation),
    );
    response.insert("tee_attestation".to_string(), tee_attestation);
    Ok(serde_json::Value::Object(response))
}

/// The custody network a ticket is signed under. Recovery chain families and
/// the opaque network text carried by AA v3 callbacks stay in the ticket digest;
/// neither selects the custody deployment. Every deployment alias still goes
/// through the host's strict `resolve_payload_network` assertion.
fn resolve_signing_network(
    state: &AppState,
    mode: &str,
    resolved: &serde_json::Value,
) -> Result<String, RuntimeError> {
    let names_chain_family = mode == "neodid_recovery_ticket"
        && resolved
            .get("network")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|label| {
                !label.trim().is_empty()
                    && normalize_target_chain(&serde_json::Value::String(label.to_string())).is_ok()
            });
    let is_aa_ticket_text = (mode == "neodid_recovery_ticket"
        && is_aa_recovery_v3_payload(resolved))
        || (mode == "neodid_action_ticket"
            && (is_aa_action_v3_payload(resolved) || is_aa_action_v4_payload(resolved)));
    if names_chain_family || is_aa_ticket_text {
        let mut payload = resolved.clone();
        if let Some(object) = payload.as_object_mut() {
            object.remove("network");
        }
        return resolve_payload_network(state, &payload);
    }
    resolve_payload_network(state, resolved)
}

/// The flow result's `digest` field is the exact byte string
/// `signDigestBytes` signs in the child (`Buffer.from(digestBytes)`); the
/// ported flows only surface it as `0x<hex>`, so recover the bytes from it.
fn extract_digest_bytes(result: &serde_json::Value) -> Result<Vec<u8>, RuntimeError> {
    let digest = js_trim_string(result.get("digest"));
    let hex_text = digest
        .strip_prefix("0x")
        .or_else(|| digest.strip_prefix("0X"))
        .unwrap_or(&digest);
    let bytes = hex::decode(hex_text)
        .map_err(|_| http_error(500, "neodid flow returned a malformed digest"))?;
    if bytes.len() != 32 {
        return Err(http_error(500, "neodid flow returned a malformed digest"));
    }
    Ok(bytes)
}

/// `{signature, public_key, signer_address, signer_script_hash:
/// \`0x${strip0x(script_hash)}\`}` — the `signDigestBytes` return, spread
/// over the flow result in exactly this order.
fn build_digest_signer_spread(signed: &serde_json::Value) -> Vec<(String, serde_json::Value)> {
    let field = |key: &str| -> String {
        signed
            .get(key)
            .and_then(|value| value.as_str())
            .unwrap_or_default()
            .to_string()
    };
    let script_hash = field("script_hash");
    let script_hash = script_hash
        .strip_prefix("0x")
        .or_else(|| script_hash.strip_prefix("0X"))
        .unwrap_or(&script_hash)
        .to_string();
    vec![
        ("signature".to_string(), string_or_null(signed, "signature")),
        (
            "public_key".to_string(),
            string_or_null(signed, "public_key"),
        ),
        (
            "signer_address".to_string(),
            string_or_null(signed, "address"),
        ),
        (
            "signer_script_hash".to_string(),
            serde_json::Value::String(format!("0x{script_hash}")),
        ),
    ]
}

/// `buildVerificationEnvelope(signed)` (chain/signing.js:197) over the
/// envelope sign — note the envelope's `signer_script_hash` is the RAW
/// custody `script_hash` (no `0x` prefixing; only the digest spread adds it),
/// and empty `signer_address` reads as null through `|| null`.
fn build_verification_envelope(
    output_hash: &str,
    signed: &serde_json::Value,
    tee_attestation: &serde_json::Value,
) -> serde_json::Value {
    let text = |key: &str| -> Option<String> {
        signed
            .get(key)
            .and_then(|value| value.as_str())
            .map(str::to_string)
            .filter(|value| !value.is_empty())
    };
    serde_json::json!({
        "output_hash": output_hash,
        "attestation_hash": output_hash,
        "signature": string_or_null(signed, "signature"),
        "public_key": string_or_null(signed, "public_key"),
        "signer_address": text("address").map(serde_json::Value::String).unwrap_or(serde_json::Value::Null),
        "signer_script_hash": text("script_hash").map(serde_json::Value::String).unwrap_or(serde_json::Value::Null),
        "tee_attestation": tee_attestation.clone(),
    })
}

fn string_or_null(signed: &serde_json::Value, key: &str) -> serde_json::Value {
    match signed.get(key).and_then(|value| value.as_str()) {
        Some(value) if !value.is_empty() => serde_json::Value::String(value.to_string()),
        _ => serde_json::Value::Null,
    }
}

/// The fold's `deriveKeyBytes` seam: the Secrets-Manager master path stays on
/// the keyless child until the host grows an SM seam. `resolveNeoDidSalt`'s
/// catch converts ANY failure into its fixed message, so this text never
/// surfaces; provisioned `NEODID_SECRET_SALT` env is the fold's salt source.
fn refuse_derive_key_bytes(_path: &str, _purpose: &str) -> Result<Vec<u8>, String> {
    Err("Secrets-Manager salt derivation is not available in the Rust enclave host".to_string())
}

// ---------------------------------------------------------------------------
// web3auth id_token verification (the `jwtVerify` closure)
// ---------------------------------------------------------------------------

const JWKS_NO_MATCHING_KEY: &str = "no applicable key found in the JSON Web Key Set";
const JWKS_CACHE_TTL: Duration = Duration::from_secs(10 * 60);
const JWKS_REFRESH_COOLDOWN: Duration = Duration::from_secs(30);
const JWKS_FAILURE_COOLDOWN: Duration = Duration::from_secs(30);

#[derive(Clone)]
struct JwksSnapshot {
    document: serde_json::Value,
    fetched_at: Instant,
    generation: u64,
    attempt: u64,
}

#[derive(Default)]
struct JwksCacheEntry {
    cached: Option<JwksSnapshot>,
    refreshing: bool,
    attempt: u64,
    last_failure: Option<(Instant, String)>,
}

struct JwksCache {
    entries: Mutex<HashMap<String, JwksCacheEntry>>,
    refreshed: Condvar,
}

/// `getWeb3AuthJwks`'s cache — module-global in the child too
/// (`WEB3AUTH_JWKS_CACHE`), keyed by the resolved JWKS URL. Fetches and forced
/// rotations are single-flight per URL; a failed fetch is cooled down so a
/// burst of unknown-kid tokens cannot turn into an outbound request storm.
static JWKS_CACHE: OnceLock<JwksCache> = OnceLock::new();

fn jwks_cache() -> &'static JwksCache {
    JWKS_CACHE.get_or_init(|| JwksCache {
        entries: Mutex::new(HashMap::new()),
        refreshed: Condvar::new(),
    })
}

fn verify_id_token_web3auth(
    fetcher: &dyn JwksFetcher,
    request: &Web3AuthVerifyRequest<'_>,
) -> Result<serde_json::Value, String> {
    let cached = fetch_jwks(fetcher, request.jwks_url)?;
    match verify_rs256_token(
        request.id_token,
        &cached.document,
        request.audience,
        request.issuer,
    ) {
        Ok(claims) => Ok(claims),
        Err(error) if error == JWKS_NO_MATCHING_KEY => {
            // jose's createRemoteJWKSet refetches once when the token's kid is
            // absent from the cached set (key rotation mid-flight). Signature
            // and claim failures never enter this branch.
            let refreshed = refresh_jwks_after_key_miss(fetcher, request.jwks_url, &cached)?;
            verify_rs256_token(
                request.id_token,
                &refreshed.document,
                request.audience,
                request.issuer,
            )
            .map_err(|refreshed_error| {
                if refreshed_error == JWKS_NO_MATCHING_KEY {
                    error
                } else {
                    refreshed_error
                }
            })
        }
        Err(error) => Err(error),
    }
}

fn fetch_jwks(fetcher: &dyn JwksFetcher, url: &str) -> Result<JwksSnapshot, String> {
    load_jwks(fetcher, url, None)
}

fn refresh_jwks_after_key_miss(
    fetcher: &dyn JwksFetcher,
    url: &str,
    observed: &JwksSnapshot,
) -> Result<JwksSnapshot, String> {
    // A just-fetched set already represents the endpoint's current answer.
    // Fetching it again for every attacker-controlled unknown `kid` would turn
    // otherwise cheap rejected JWTs into an outbound-request storm. This also
    // matches a remote-JWKS cooldown: an older cached set may refresh once,
    // while a cold load or recent rotation is reused until the cooldown ends.
    if Instant::now().duration_since(observed.fetched_at) < JWKS_REFRESH_COOLDOWN {
        return Ok(observed.clone());
    }
    load_jwks(fetcher, url, Some(observed))
}

fn load_jwks(
    fetcher: &dyn JwksFetcher,
    url: &str,
    observed: Option<&JwksSnapshot>,
) -> Result<JwksSnapshot, String> {
    let cache = jwks_cache();
    loop {
        let now = Instant::now();
        let mut entries = cache.entries.lock().expect("jwks cache lock");
        let entry = entries.entry(url.to_string()).or_default();

        if let Some(observed) = observed {
            if let Some(current) = &entry.cached {
                if current.generation > observed.generation {
                    return Ok(current.clone());
                }
            }
            if entry.attempt > observed.attempt {
                if let Some((_, error)) = &entry.last_failure {
                    return Err(error.clone());
                }
            }
        } else if let Some(current) = &entry.cached {
            if now.duration_since(current.fetched_at) < JWKS_CACHE_TTL {
                return Ok(current.clone());
            }
        }

        if let Some((failed_at, error)) = &entry.last_failure {
            if now.duration_since(*failed_at) < JWKS_FAILURE_COOLDOWN {
                return Err(error.clone());
            }
        }

        if entry.refreshing {
            let entries = cache.refreshed.wait(entries).expect("jwks cache wait lock");
            drop(entries);
            continue;
        }
        entry.refreshing = true;
        drop(entries);

        let fetched = fetcher.fetch_jwks(url).and_then(validate_jwks_document);
        let mut entries = cache.entries.lock().expect("jwks cache lock");
        let entry = entries.entry(url.to_string()).or_default();
        entry.refreshing = false;
        entry.attempt = entry.attempt.saturating_add(1);
        let result = match fetched {
            Ok(document) => {
                let generation = entry
                    .cached
                    .as_ref()
                    .map(|cached| cached.generation.saturating_add(1))
                    .unwrap_or(1);
                let snapshot = JwksSnapshot {
                    document,
                    fetched_at: Instant::now(),
                    generation,
                    attempt: entry.attempt,
                };
                entry.cached = Some(snapshot.clone());
                entry.last_failure = None;
                Ok(snapshot)
            }
            Err(error) => {
                entry.last_failure = Some((Instant::now(), error.clone()));
                Err(error)
            }
        };
        cache.refreshed.notify_all();
        return result;
    }
}

fn validate_jwks_document(document: serde_json::Value) -> Result<serde_json::Value, String> {
    if document
        .get("keys")
        .and_then(|keys| keys.as_array())
        .is_none()
    {
        Err("JWKS document has no keys array".to_string())
    } else {
        Ok(document)
    }
}

pub struct ReqwestJwksFetcher;

impl JwksFetcher for ReqwestJwksFetcher {
    fn fetch_jwks(&self, url: &str) -> Result<serde_json::Value, String> {
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .map_err(|error| format!("JWKS client build failed: {error}"))?;
        let response = client
            .get(url)
            .send()
            .map_err(|error| format!("JWKS fetch failed: {error}"))?;
        let status = response.status().as_u16();
        let text = response
            .text()
            .map_err(|error| format!("JWKS fetch failed: {error}"))?;
        if !(200..300).contains(&status) {
            return Err(format!("JWKS fetch failed (HTTP {status})"));
        }
        serde_json::from_str(&text).map_err(|_| "JWKS endpoint returned non-JSON".to_string())
    }
}

/// `jwtVerify(idToken, JWKS, { audience, issuer })` — RS256 signature over
/// the compact JWS signing input, kid-keyed selection from the JWKS, and the
/// registered-claim checks jose performs (audience containment, optional
/// issuer pin, exp/nbf/iat timestamps). Error STRINGS match jose's for the
/// paths these fixtures exercise.
pub fn verify_rs256_token(
    id_token: &str,
    jwks: &serde_json::Value,
    audience: &str,
    issuer: Option<&str>,
) -> Result<serde_json::Value, String> {
    let token = id_token.trim();
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 3 {
        return Err("Invalid Compact JWS".to_string());
    }
    let header = parse_b64url_json(parts[0])?;
    if header.get("alg").and_then(|value| value.as_str()) != Some("RS256") {
        return Err("\"alg\" (Algorithm) Header Parameter value not allowed".to_string());
    }
    let kid = header.get("kid").and_then(|value| value.as_str());

    let verifying_keys = select_signing_keys(jwks, kid)?;
    let signature_bytes = b64url_decode(parts[2])?;
    let signing_input = format!("{}.{}", parts[0], parts[1]);
    let verified = verifying_keys.iter().any(|verifying_key| {
        verifying_key
            .verify_sig(signing_input.as_bytes(), &signature_bytes)
            .is_ok()
    });
    if !verified {
        return Err("signature verification failed".to_string());
    }

    let claims = parse_b64url_json(parts[1])?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0);
    check_timestamp_claim(&claims, "exp", |at, now| now >= at, now)?;
    check_timestamp_claim(&claims, "nbf", |at, now| now < at, now)?;
    check_timestamp_claim(&claims, "iat", |at, now| now < at, now)?;
    check_audience(&claims, audience)?;
    if let Some(issuer) = issuer {
        if js_trim_string(claims.get("iss")) != issuer {
            return Err("\"iss\" claim value check failed".to_string());
        }
    }
    Ok(claims)
}

/// exp: rejected once `now >= exp`; nbf: rejected while `now < nbf`; iat:
/// rejected when `iat > now` (a future-issued token). Absent claims pass —
/// jose validates only what is present.
fn check_timestamp_claim(
    claims: &serde_json::Value,
    claim: &str,
    rejects: fn(u64, u64) -> bool,
    now: u64,
) -> Result<(), String> {
    let Some(value) = claims.get(claim) else {
        return Ok(());
    };
    let at = match value.as_u64() {
        Some(at) => at,
        None => return Err(format!("\"{claim}\" claim must be a number")),
    };
    if rejects(at, now) {
        return Err(format!("\"{claim}\" claim timestamp check failed"));
    }
    Ok(())
}

fn check_audience(claims: &serde_json::Value, audience: &str) -> Result<(), String> {
    let matches = match claims.get("aud") {
        None => return Err("\"aud\" claim is required when \"audience\" is specified".to_string()),
        Some(serde_json::Value::String(value)) => value == audience,
        Some(serde_json::Value::Array(values)) => {
            values.iter().any(|value| value.as_str() == Some(audience))
        }
        Some(_) => return Err("\"aud\" claim value check failed".to_string()),
    };
    if !matches {
        return Err("\"aud\" claim value check failed".to_string());
    }
    Ok(())
}

/// JWKS key selection with jose's `createRemoteJWKSet` semantics: candidates
/// are kty RSA, use `sig` (or absent), alg RS256 (or absent). A token `kid`
/// pins exactly one key — an unknown kid is `JWKSNoMatchingKey` ("no
/// applicable key found in the JSON Web Key Set"). Without a kid jose tries
/// EVERY candidate and fails verification only if none works.
fn select_signing_keys(
    jwks: &serde_json::Value,
    kid: Option<&str>,
) -> Result<Vec<ParsedPublicKey>, String> {
    let keys = jwks
        .get("keys")
        .and_then(|value| value.as_array())
        .ok_or_else(|| "JWKS document has no keys array".to_string())?;
    let candidates: Vec<&serde_json::Value> = keys
        .iter()
        .filter(|key| key.get("kty").and_then(|value| value.as_str()) == Some("RSA"))
        .filter(|key| {
            matches!(
                key.get("use").and_then(|value| value.as_str()),
                None | Some("sig")
            )
        })
        .filter(|key| {
            matches!(
                key.get("alg").and_then(|value| value.as_str()),
                None | Some("RS256")
            )
        })
        .collect();
    let selected = match kid {
        Some(kid) => {
            let pinned = candidates
                .iter()
                .find(|key| key.get("kid").and_then(|value| value.as_str()) == Some(kid))
                .ok_or_else(|| JWKS_NO_MATCHING_KEY.to_string())?;
            std::slice::from_ref(pinned)
        }
        None => &candidates[..],
    };
    selected
        .iter()
        .map(|selected| {
            let n = b64url_decode(
                selected
                    .get("n")
                    .and_then(|value| value.as_str())
                    .ok_or_else(|| "JWK is missing the modulus".to_string())?,
            )?;
            let e = b64url_decode(
                selected
                    .get("e")
                    .and_then(|value| value.as_str())
                    .ok_or_else(|| "JWK is missing the exponent".to_string())?,
            )?;
            let components = RsaPublicKeyComponents { n: &n, e: &e };
            components
                .to_parsed_public_key(&RSA_PKCS1_1024_8192_SHA256_FOR_LEGACY_USE_ONLY)
                .map_err(|_| "JWK modulus/exponent is not a valid RSA key".to_string())
        })
        .collect()
}

fn parse_b64url_json(segment: &str) -> Result<serde_json::Value, String> {
    let bytes = b64url_decode(segment)?;
    serde_json::from_slice(&bytes).map_err(|_| "Invalid Compact JWS".to_string())
}

fn b64url_decode(segment: &str) -> Result<Vec<u8>, String> {
    URL_SAFE_NO_PAD
        .decode(segment)
        .map_err(|_| "Invalid Compact JWS".to_string())
}

/// Test seam: drop every cached JWKS (the child clears the same cache via
/// `__resetNeoDidStateForTests`).
#[doc(hidden)]
pub fn reset_jwks_cache_for_tests() {
    if let Some(cache) = JWKS_CACHE.get() {
        cache.entries.lock().expect("jwks cache lock").clear();
        cache.refreshed.notify_all();
    }
}

#[cfg(test)]
#[path = "../tests/unit/neodid.rs"]
mod tests;
