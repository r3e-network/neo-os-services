//! The pure dispatch core — `(state, method, raw_url, headers, body) ->
//! (status, json body)`, no socket, the direct port of `dispatch()`
//! (enclave-server.mjs:1917-2019). The HTTP shim in `bin/enclave_host.rs`
//! serializes exactly what this returns; the tests drive it exactly as the
//! Node dispatch fixtures do.

use serde_json::Value;

use crate::attestation::handle_attestation;
use crate::auth::assert_authorized;
use crate::bridge::resolve_worker_auth_token;
use crate::health::handle_health;
use crate::http_error;
use crate::provision::{assert_provision_authorized, handle_provision};
use crate::routes::{classify, Target};
use crate::sign::{handle_keys_derived, handle_sign_payload};
use crate::state::AppState;
use crate::{DispatchOutcome, RuntimeError};

/// `parseBody`: an object passes through (the shim may hand a parsed body);
/// text is trimmed, empty becomes `{}`, anything else must parse. A malformed
/// body is a dispatch failure like any other — the catch-all renders it 500.
pub fn parse_body(body: &str) -> Result<Value, RuntimeError> {
    let text = body.trim();
    if text.is_empty() {
        return Ok(serde_json::json!({}));
    }
    serde_json::from_str(text).map_err(|error| http_error(500, error.to_string()))
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

        Target::OracleFulfill => {
            assert_authorized(&state.overlay.read().expect("overlay lock"), headers)?;
            let payload = parse_body(body)?;
            Ok(DispatchOutcome::ok(crate::fulfill::handle_oracle_fulfill(
                state, &payload,
            )?))
        }

        Target::FeedSign => {
            assert_authorized(&state.overlay.read().expect("overlay lock"), headers)?;
            // Body-shape errors surface before the refusal, as the mjs's
            // JSON.parse would.
            parse_body(body)?;
            // The merged server's feed lane (price fetch + planFeedUpdate +
            // the updateFeeds tx build + the updater signature) is not ported
            // yet, and the keyless compute child does not serve /feed/sign —
            // forwarding a SIGNING lane to it would 404 it. Fail closed until
            // the feed fold lands.
            Err(http_error(
                503,
                "feed/sign is not served by the Rust enclave host yet (pending the feed lane port)",
            ))
        }

        Target::SignPayload => {
            assert_authorized(&state.overlay.read().expect("overlay lock"), headers)?;
            let payload = parse_body(body)?;
            Ok(DispatchOutcome::ok(handle_sign_payload(state, &payload)?))
        }

        Target::KeysDerived => {
            assert_authorized(&state.overlay.read().expect("overlay lock"), headers)?;
            let payload = parse_body(body)?;
            Ok(DispatchOutcome::ok(handle_keys_derived(state, &payload)?))
        }

        Target::Passthrough(route) => {
            assert_authorized(&state.overlay.read().expect("overlay lock"), headers)?;
            let payload = parse_body(body)?;
            compute_via_worker(state, route, &payload)
        }

        Target::OraclePublicKey => {
            // Public X25519 oracle encryption key — NOT secret: clients
            // encrypt confidential payloads to it. Ungated, like the Node
            // dispatch; the private half never leaves the child's enclave
            // memory.
            let payload = if http_method == "POST" {
                parse_body(body)?
            } else {
                serde_json::json!({})
            };
            compute_via_worker(state, "/oracle/public-key", &payload)
        }

        Target::NotFound => Ok(DispatchOutcome {
            status: 404,
            body: serde_json::json!({ "error": "not found", "path": path }),
        }),
    }
}

/// `computeViaWorker`: resolve the worker-auth token from the overlay, POST
/// the payload to the child, and surface its `{status, body}` verbatim. The
/// compute lanes (and the compute part of fulfillment) live in the keyless
/// child; signing folds in around this call.
fn compute_via_worker(
    state: &AppState,
    route: &str,
    payload: &Value,
) -> Result<DispatchOutcome, RuntimeError> {
    let token = resolve_worker_auth_token(&state.overlay.read().expect("overlay lock"));
    let reply = state.bridge.forward(route, payload, token.as_deref());
    Ok(DispatchOutcome {
        status: reply.status,
        body: reply.body,
    })
}

#[cfg(test)]
#[path = "../tests/unit/dispatch.rs"]
mod tests;
