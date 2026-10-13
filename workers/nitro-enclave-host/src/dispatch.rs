//! The pure dispatch core — `(state, method, raw_url, headers, body) ->
//! (status, json body)`, no socket, the direct port of `dispatch()`
//! (enclave-server.mjs:1917-2019). The HTTP shim in `bin/enclave_host.rs`
//! serializes exactly what this returns; the tests drive it exactly as the
//! Node dispatch fixtures do.

use serde_json::Value;

use crate::attestation::handle_attestation;
use crate::auth::assert_authorized;
use crate::health::handle_health;
use crate::http_error;
use crate::provision::{
    assert_provision_authorized, handle_provision, handle_provision_credentials,
};
use crate::routes::{classify, Target};
use crate::sign::{handle_keys_derived, handle_sign_payload};
use crate::state::AppState;
use crate::{DispatchOutcome, RuntimeError};
use neo_os_compute::overload::{AcquireOutcome, OverloadSlot};

/// `parseBody`: an object passes through (the shim may hand a parsed body);
/// text is trimmed with ECMAScript's whitespace set, empty becomes `{}`, and
/// anything else must parse. A malformed request body is a client error, so it
/// must never be reported as an enclave/runtime failure.
pub fn parse_body(body: &str) -> Result<Value, RuntimeError> {
    let text = neo_os_core::js_value::js_trim(body);
    if text.is_empty() {
        return Ok(serde_json::json!({}));
    }
    serde_json::from_str(text).map_err(|error| http_error(400, error.to_string()))
}

/// `new URL(rawUrl || '/', \`http://${hostHeader}\`)` — absolute raw URLs
/// override the base, relative ones join it; the host header only anchors the
/// parse, never the routing.
fn parse_url(raw_url: &str, host_header: &str) -> Result<url::Url, RuntimeError> {
    let effective = if raw_url.trim().is_empty() {
        "/"
    } else {
        raw_url
    };
    let base = format!("http://{host_header}/");
    url::Url::parse(&base)
        .and_then(|base| base.join(effective))
        .map_err(|_| http_error(500, "Invalid URL"))
}

/// `url.pathname.replace(/\/$/, '') || '/'` — strip ONE trailing slash; a
/// path that collapses to empty is root again.
fn request_path(url: &url::Url) -> String {
    let path = url.path();
    let stripped = path.strip_suffix('/').unwrap_or(path);
    if stripped.is_empty() {
        "/".to_string()
    } else {
        stripped.to_string()
    }
}

/// `Object.fromEntries(url.searchParams)` — every query parameter as a
/// string, later duplicates winning.
fn query_params(url: &url::Url) -> Value {
    let mut map = serde_json::Map::new();
    for (name, value) in url.query_pairs() {
        map.insert(name.to_string(), Value::String(value.to_string()));
    }
    Value::Object(map)
}

/// What an admitted request carries into its handler: the parsed body, and
/// the capacity reservation that must outlive the handler call. The slot is
/// bound (not dropped) by every call site, so it releases when the arm's
/// block ends — including on an early `?`.
type Admitted = (Value, Option<OverloadSlot>);

/// Authenticate, parse, then reserve capacity — in that order, and BEFORE any
/// handler runs (CL-34). Reserving after authentication keeps an unauthorized
/// caller from consuming a slot; reserving before the handler keeps an
/// authenticated one from parking an unbounded number of blocking-pool
/// threads inside a fixed-memory enclave, which on a single node with no
/// reassignment path is a total outage of the confidential lane.
///
/// `Ok(Err(outcome))` is the saturated answer: the guard's own
/// `{error, route, limit, in_flight}` 503, not a generic one, so a caller can
/// tell overload from failure and back off against a named route.
fn authorize_and_admit(
    state: &AppState,
    headers: &http::HeaderMap,
    target: Target,
    body: &str,
) -> Result<Result<Admitted, DispatchOutcome>, RuntimeError> {
    assert_authorized(&state.overlay.read().expect("overlay lock"), headers)?;
    let payload = parse_body(body)?;
    // Key on the route's canonical path, not the request path: the dispatcher
    // accepts an arbitrary single-segment network prefix, and a cap that a
    // prefix walks around is not a cap.
    let Some(route_path) = target.canonical_path() else {
        return Ok(Ok((payload, None)));
    };
    let env = state.overlay.read().expect("overlay lock").merged_map();
    let read_env = |name: &str| env.get(name).cloned();
    match state.overload.acquire(route_path, &payload, &read_env) {
        AcquireOutcome::Granted(slot) => Ok(Ok((payload, Some(slot)))),
        AcquireOutcome::Uncapped { .. } => Ok(Ok((payload, None))),
        AcquireOutcome::Rejected(rejection) => Ok(Err(DispatchOutcome {
            status: rejection.status,
            body: rejection.body,
        })),
    }
}

/// `let (payload, _slot) = admit!(...)` — the two-line prologue every
/// authenticated arm used to repeat, plus admission control.
macro_rules! admit {
    ($state:expr, $headers:expr, $target:expr, $body:expr) => {
        match authorize_and_admit($state, $headers, $target, $body)? {
            Ok(admitted) => admitted,
            Err(rejected) => return Ok(rejected),
        }
    };
}

pub fn dispatch(
    state: &AppState,
    method: &str,
    raw_url: &str,
    headers: &http::HeaderMap,
    body: &str,
) -> DispatchOutcome {
    match run(state, method, raw_url, headers, body) {
        Ok(body) => body,
        Err(error) => DispatchOutcome::error(&error),
    }
}

fn run(
    state: &AppState,
    method: &str,
    raw_url: &str,
    headers: &http::HeaderMap,
    body: &str,
) -> Result<DispatchOutcome, RuntimeError> {
    // `trimString(method || 'GET').toUpperCase()` — an absent method is GET;
    // a whitespace-only one is EMPTY and matches no route (404), because the
    // Node server's trimString collapses it before the uppercase.
    let http_method = if method.is_empty() {
        "GET".to_string()
    } else {
        method.trim().to_ascii_uppercase()
    };
    let host_header = headers
        .get(http::header::HOST)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("127.0.0.1")
        .to_string();
    let url = parse_url(raw_url, &host_header)?;
    let path = request_path(&url);

    match classify(&http_method, &path) {
        Target::Health => {
            let health = handle_health(state);
            let status = if health["ready"] == Value::Bool(true) {
                200
            } else {
                503
            };
            Ok(DispatchOutcome {
                status,
                body: health,
            })
        }

        Target::Attestation => {
            // GET binds via query params; POST via JSON body.
            let payload = if http_method == "GET" {
                query_params(&url)
            } else {
                parse_body(body)?
            };
            Ok(DispatchOutcome::ok(handle_attestation(state, &payload)?))
        }

        Target::Provision => {
            let payload = parse_body(body)?;
            let bootstrap = assert_provision_authorized(state, headers, &payload)?;
            Ok(DispatchOutcome::ok(handle_provision(
                state, &payload, bootstrap,
            )?))
        }

        Target::ProvisionCredentials => {
            assert_authorized(&state.overlay.read().expect("overlay lock"), headers)?;
            let payload = parse_body(body)?;
            Ok(DispatchOutcome::ok(handle_provision_credentials(
                state, &payload,
            )?))
        }

        Target::OracleFulfill => {
            let (payload, _slot) = admit!(state, headers, Target::OracleFulfill, body);
            Ok(DispatchOutcome::ok(crate::fulfill::handle_oracle_fulfill(
                state, &payload,
            )?))
        }

        Target::FeedSign => {
            let (payload, _slot) = admit!(state, headers, Target::FeedSign, body);
            Ok(DispatchOutcome::ok(crate::feed_sign::handle_feed_sign(
                state, &payload,
            )?))
        }

        Target::SignPayload => {
            let (payload, _slot) = admit!(state, headers, Target::SignPayload, body);
            Ok(DispatchOutcome::ok(handle_sign_payload(state, &payload)?))
        }

        Target::KeysDerived => {
            let (payload, _slot) = admit!(state, headers, Target::KeysDerived, body);
            Ok(DispatchOutcome::ok(handle_keys_derived(state, &payload)?))
        }

        Target::ComputeExecute => {
            let (payload, _slot) = admit!(state, headers, Target::ComputeExecute, body);
            Ok(DispatchOutcome::ok(
                crate::compute_execute::handle_compute_execute(state, &payload)?,
            ))
        }

        Target::NeoDidBind => {
            let (payload, _slot) = admit!(state, headers, Target::NeoDidBind, body);
            Ok(DispatchOutcome::ok(crate::neodid::handle_neo_did_bind(
                state, &payload,
            )?))
        }

        Target::NeoDidActionTicket => {
            let (payload, _slot) = admit!(state, headers, Target::NeoDidActionTicket, body);
            Ok(DispatchOutcome::ok(
                crate::neodid::handle_neo_did_action_ticket(state, &payload)?,
            ))
        }

        Target::NeoDidRecoveryTicket => {
            let (payload, _slot) = admit!(state, headers, Target::NeoDidRecoveryTicket, body);
            Ok(DispatchOutcome::ok(
                crate::neodid::handle_neo_did_recovery_ticket(state, &payload)?,
            ))
        }

        Target::NeoDidZkLoginTicket => {
            let (payload, _slot) = admit!(state, headers, Target::NeoDidZkLoginTicket, body);
            Ok(DispatchOutcome::ok(
                crate::neodid::handle_neo_did_zklogin_ticket(state, &payload)?,
            ))
        }

        Target::VrfRandom => {
            let (payload, _slot) = admit!(state, headers, Target::VrfRandom, body);
            Ok(DispatchOutcome::ok(crate::vrf::handle_vrf_random(
                state, &payload,
            )?))
        }

        Target::PaymasterAuthorize => {
            let (payload, _slot) = admit!(state, headers, Target::PaymasterAuthorize, body);
            Ok(DispatchOutcome::ok(
                crate::paymaster::handle_paymaster_authorize(state, &payload)?,
            ))
        }

        Target::SessionStart => {
            let (payload, _slot) = admit!(state, headers, Target::SessionStart, body);
            crate::session::handle_session_start(state, &payload)
        }

        Target::SessionStep => {
            let (payload, _slot) = admit!(state, headers, Target::SessionStep, body);
            crate::session::handle_session_step(state, &payload)
        }

        Target::SessionFinalize => {
            let (payload, _slot) = admit!(state, headers, Target::SessionFinalize, body);
            crate::session::handle_session_finalize(state, &payload)
        }

        Target::SessionSettle => {
            // This route is intentionally absent from the public capability
            // table; only the authenticated relay bearer may reach it.
            let (payload, _slot) = admit!(state, headers, Target::SessionSettle, body);
            crate::session::handle_session_finalize_kernel(state, &payload)
        }

        Target::AutomationExecute => {
            let (payload, _slot) = admit!(state, headers, Target::AutomationExecute, body);
            crate::automation::handle_automation_execute(state, &payload)
        }

        Target::OracleFeed => {
            let (payload, _slot) = admit!(state, headers, Target::OracleFeed, body);
            crate::oracle_feed::handle_oracle_feed(state, &payload)
        }

        Target::OracleQuery => {
            let (payload, _slot) = admit!(state, headers, Target::OracleQuery, body);
            crate::oracle_read::handle_oracle_query(state, &payload)
        }

        Target::OracleSmartFetch => {
            let (payload, _slot) = admit!(state, headers, Target::OracleSmartFetch, body);
            crate::oracle_read::handle_oracle_smart_fetch(state, &payload)
        }

        Target::OracleDecrypt => {
            let (payload, _slot) = admit!(state, headers, Target::OracleDecrypt, body);
            crate::oracle_read::handle_oracle_decrypt(state, &payload)
        }

        Target::OracleMessageReveal => {
            let (payload, _slot) = admit!(state, headers, Target::OracleMessageReveal, body);
            crate::oracle_read::handle_oracle_message_reveal(state, &payload)
        }

        Target::OraclePublicKey => {
            // Public X25519 oracle encryption key — NOT secret: clients
            // encrypt confidential payloads to it. Ungated, like the Node
            // dispatch; the private half never leaves enclave memory. The
            // Phase 9 fold resolves the key in-process — no child required.
            let payload = if http_method == "POST" {
                parse_body(body)?
            } else {
                serde_json::json!({})
            };
            crate::oracle_read::handle_oracle_public_key(state, &payload)
        }

        // The read-only catalog plane (CU-149). Every arm is an authenticated
        // read of a static catalog or of the signing plane's own role report:
        // no handler takes a request body, so nothing a caller sends can change
        // what the answer says. `classify` already refused the write methods.
        Target::FeedsCatalog => {
            let (_payload, _slot) = admit!(state, headers, Target::FeedsCatalog, body);
            Ok(DispatchOutcome::ok(crate::catalog::handle_feeds_catalog(
                state,
            )?))
        }

        Target::Providers => {
            let (_payload, _slot) = admit!(state, headers, Target::Providers, body);
            Ok(DispatchOutcome::ok(crate::catalog::handle_providers(
                state,
            )?))
        }

        Target::NeoDidProviders => {
            let (_payload, _slot) = admit!(state, headers, Target::NeoDidProviders, body);
            Ok(DispatchOutcome::ok(
                crate::catalog::handle_neo_did_providers(state)?,
            ))
        }

        Target::NeoDidRuntime => {
            let (_payload, _slot) = admit!(state, headers, Target::NeoDidRuntime, body);
            Ok(DispatchOutcome::ok(crate::catalog::handle_neo_did_runtime(
                state,
            )?))
        }

        Target::ComputeFunctions => {
            let (_payload, _slot) = admit!(state, headers, Target::ComputeFunctions, body);
            Ok(DispatchOutcome::ok(
                crate::catalog::handle_compute_functions(state)?,
            ))
        }

        Target::NotFound => Ok(DispatchOutcome {
            status: 404,
            body: serde_json::json!({ "error": "not found", "path": path }),
        }),
    }
}

#[cfg(test)]
#[path = "../tests/unit/dispatch.rs"]
mod tests;
