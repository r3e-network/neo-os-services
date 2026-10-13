//! The read-only catalog plane — `/feeds/catalog`, `/providers`,
//! `/neodid/providers`, `/neodid/runtime` and `/compute/functions` (CU-149).
//!
//! WHY THESE LIVE HERE
//! -------------------
//! The capability registry (`workers/nitro-worker/src/capabilities.js`) has
//! always declared these five lanes, `docs/USER_GUIDE.md` documents three of
//! them as direct runtime calls, and the web app proxies two of them — but no
//! `Target` in [`crate::routes`] classified any of them, so every caller got a
//! 404 and the gaps only showed up in `baselines/capability-route-parity.json`.
//! They are the read half of the plane the measured host already owns the
//! write half of: the feed pairs `/feed/sign` publishes, the providers
//! `/oracle/*` fetches from, the NeoDID providers the ticket lanes accept, and
//! the built-in functions `/compute/execute` runs.
//!
//! READ-ONLY, AND NOTHING ELSE
//! ---------------------------
//! Each handler is `(&AppState) -> Result<Value, RuntimeError>`: it takes no
//! request body and no query parameter, so no caller-supplied field can change
//! what a catalog says. `classify` serves these paths for GET only; a write
//! method falls through to `Target::NotFound` exactly like an unknown path.
//!
//! THE JS MODULES ARE THE ORACLE
//! -----------------------------
//! Every body is the shape `workers/nitro-worker/src/{oracle,compute,neodid}`
//! returns, and every list is read from a catalog that already exists in
//! `neo-os-compute` rather than restated here. Nothing is invented: where the
//! JS oracle has no source for a field, this port emits the same `null` it
//! does (see [`handle_neo_did_runtime`]).

use neo_os_compute::core::EnvReader;
use neo_os_compute::neodid::supported_providers;
use neo_os_compute::oracle::feed_registry::get_default_feed_symbols;
use neo_os_compute::oracle::providers::list_builtin_providers;
use serde_json::{json, Value as Json};

use crate::http_error;
use crate::state::AppState;
use crate::RuntimeError;

/// The roles whose public identity the NeoDID runtime descriptor advertises.
const NEODID_VERIFIER_ROLE: &str = "worker";

/// `handleNeoDidRuntime`'s `supported_routes`: the NeoDID surface a resolver
/// records in a DID document's `#runtime` service endpoint.
const NEODID_SUPPORTED_ROUTES: [&str; 6] = [
    "/neodid/providers",
    "/neodid/runtime",
    "/neodid/bind",
    "/neodid/action-ticket",
    "/neodid/recovery-ticket",
    "/neodid/zklogin-ticket",
];

/// The ticket request types those routes mint.
const NEODID_REQUEST_TYPES: [&str; 4] = [
    "neodid_bind",
    "neodid_action_ticket",
    "neodid_recovery_ticket",
    "neodid_zklogin_ticket",
];

/// `resolveWeb3AuthJwksUrl()` (neodid/index.js:210) — the JWKS URL comes only
/// from server-side env, never from a request, and falls back to the issuer's
/// published document.
const WEB3AUTH_DEFAULT_JWKS_URL: &str = "https://api-auth.web3auth.io/.well-known/jwks.json";

/// The merged env overlay as a reader the compute crate can call. Every
/// handler that reads configuration goes through this, so a test can drive the
/// env branches without touching process state.
fn overlay_env(state: &AppState) -> std::collections::BTreeMap<String, String> {
    state.overlay.read().expect("overlay lock").merged_map()
}

/// `env(name, …)` — the first name with a non-empty trimmed value, which is
/// how the JS platform's `env` helper resolves its aliases.
fn first_present(env: &EnvReader<'_>, names: &[&str]) -> String {
    names
        .iter()
        .find_map(|name| {
            let value = env(name).unwrap_or_default();
            let trimmed = value.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_string())
        })
        .unwrap_or_default()
}

/// `allowUnverifiedProviderUid()` (neodid/index.js:143) — default DENY; only
/// `1` / `true` / `yes` / `on` opt the low-assurance lanes back into the
/// legacy forgeable-uid behaviour. Rendered on the descriptor so a caller can
/// tell the assurance posture apart without probing a ticket lane.
fn allow_unverified_provider_uid(env: &EnvReader<'_>) -> bool {
    let raw = first_present(env, &["MORPHEUS_NEODID_ALLOW_UNVERIFIED_UID"]).to_lowercase();
    raw == "1" || raw == "true" || raw == "yes" || raw == "on"
}

/// `handleFeedsCatalog` (oracle/index.js) — `json(200, { pairs: listFeedSymbols() })`.
/// The pair list is the reviewed default registry, overridable per deployment
/// by `MORPHEUS_FEED_PAIR_REGISTRY_JSON`, exactly as `/oracle/feed` reads it.
pub fn handle_feeds_catalog(state: &AppState) -> Result<Json, RuntimeError> {
    let overlay = overlay_env(state);
    let env: EnvReader<'_> = &|name| overlay.get(name).cloned();
    Ok(json!({ "pairs": get_default_feed_symbols(env) }))
}

/// `handleProvidersList` (oracle/providers.js) — `json(200, { providers: listBuiltinProviders() })`.
/// A fixed, secret-free, network-independent list; it reports which upstreams
/// this build knows how to reach, not which ones are currently healthy
/// (`/health` carries the breaker state).
pub fn handle_providers(_state: &AppState) -> Result<Json, RuntimeError> {
    Ok(json!({ "providers": list_builtin_providers() }))
}

/// `handleNeoDidProviders` (neodid/index.js) — `json(200, { providers: SUPPORTED_PROVIDERS })`.
/// Identity providers this build accepts, with the claim types each mints and
/// whether the enclave derives the provider_uid itself.
pub fn handle_neo_did_providers(_state: &AppState) -> Result<Json, RuntimeError> {
    Ok(json!({ "providers": supported_providers() }))
}

/// `handleNeoDidRuntime` (neodid/index.js:638) — the runtime descriptor a DID
/// resolver records in its `#runtime` service endpoint: which verifier key to
/// pin, on which curve, and which providers the enclave vouches for.
///
/// Field by field against the oracle:
///
/// * `verification_public_key` — the oracle takes it from
///   `signDigestBytes(digest)` (`neodid/index.js:501`), which is
///   `custodySignBytes('worker', …)`; the host resolves the same identity
///   through the signing plane's worker report, the source
///   [`crate::attestation`] already uses for the key an attestation document
///   binds. A host with no materialized worker identity refuses rather than
///   advertising a key it cannot back.
/// * `app_id` / `instance_id` / `compose_hash` — the oracle reads these off
///   `getDstackInfo`, which is an alias for `getNitroInfo`
///   (`platform/nitro-signer.js:198`) and returns only
///   `{ runtime, network, client_kind }`. `info?.app_id` is therefore always
///   `undefined` and the JS body carries `null`. This port emits the same
///   `null` — byte-equal to the oracle, not a placeholder.
/// * everything else is a constant or a server-side env setting, never a
///   caller-supplied one.
pub fn handle_neo_did_runtime(state: &AppState) -> Result<Json, RuntimeError> {
    let overlay = overlay_env(state);
    let env: EnvReader<'_> = &|name| overlay.get(name).cloned();

    let network = state.resolve_network()?;
    let report = state.signer.role_report(&network, NEODID_VERIFIER_ROLE);
    if !report.ok || !report.materialized {
        return Err(http_error(
            503,
            format!(
                "{NEODID_VERIFIER_ROLE} signer is not configured or does not match pinned identity"
            ),
        ));
    }
    let verification_public_key = match report.identity.get("public_key") {
        Some(value) if !value.is_null() => value.clone(),
        _ if report.public_key.is_empty() => Json::Null,
        _ => Json::String(report.public_key.clone()),
    };

    let jwks_url = first_present(&env, &["WEB3AUTH_JWKS_URL"]);
    let jwks_url = if jwks_url.is_empty() {
        WEB3AUTH_DEFAULT_JWKS_URL.to_string()
    } else {
        jwks_url
    };
    let audience_configured = !first_present(
        &env,
        &[
            "WEB3AUTH_CLIENT_ID",
            "NEXT_PUBLIC_WEB3AUTH_CLIENT_ID",
            "VITE_WEB3AUTH_CLIENT_ID",
        ],
    )
    .is_empty();

    let providers = supported_providers();
    let tee_verified_providers: Vec<&str> = providers
        .as_array()
        .map(|catalog| {
            catalog
                .iter()
                .filter(|provider| provider["derives_provider_uid_in_tee"] == Json::Bool(true))
                .filter_map(|provider| provider["id"].as_str())
                .collect()
        })
        .unwrap_or_default();

    Ok(json!({
        "service": "neodid",
        "app_id": Json::Null,
        "instance_id": Json::Null,
        "compose_hash": Json::Null,
        "verification_public_key": verification_public_key,
        "verifier_curve": "secp256r1",
        "supported_routes": NEODID_SUPPORTED_ROUTES,
        "request_types": NEODID_REQUEST_TYPES,
        "web3auth": {
            "jwks_url": jwks_url,
            "audience_configured": audience_configured,
            "derives_provider_uid_in_tee": true,
        },
        "provider_uid_verification": {
            "tee_verified_providers": tee_verified_providers,
            "unverified_provider_uid_allowed": allow_unverified_provider_uid(&env),
        },
        "providers": providers,
    }))
}

/// `handleComputeFunctions` (compute/index.js:848) —
/// `json(200, { functions, names })`. `names` is the flattened index callers
/// switch on; `functions` carries the category and the description.
pub fn handle_compute_functions(_state: &AppState) -> Result<Json, RuntimeError> {
    let functions = neo_os_compute::compute::builtin_compute_catalog();
    let names = functions
        .as_array()
        .map(|catalog| {
            Json::Array(
                catalog
                    .iter()
                    .map(|entry| entry["name"].clone())
                    .collect::<Vec<Json>>(),
            )
        })
        .unwrap_or_else(|| Json::Array(Vec::new()));
    Ok(json!({ "functions": functions, "names": names }))
}

#[cfg(test)]
#[path = "../tests/unit/catalog.rs"]
mod tests;
