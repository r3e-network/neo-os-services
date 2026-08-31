//! The enclave host binary: axum in front of the pure dispatch core, wiring
//! the production seams — the NSM attestation source, the attestation-gated
//! KMS release, the loopback bridge to the keyless compute child, and the
//! process-env overlay that /provision mutates.
//!
//! The HTTP layer is a faithful port of `enclave-server.mjs`'s
//! `createServer`: JSON responses with `cache-control: no-store`, the body
//! cap (`ENCLAVE_MAX_BODY_BYTES`, min 1 KiB, default 256 KiB) answering 413
//! before dispatch, and GET/HEAD requests dispatched with an empty body.
//! One deliberate divergence: an unparseable body-cap value falls back to
//! the 256 KiB default instead of JS's NaN disabling the cap entirely.
//!
//! The signing plane is fail-closed until the custody client lands: the
//! host never holds keys, and with no custody connection every role reports
//! unconfigured — the same 503 the Node server produced when no key env was
//! provisioned. /health surfaces that state; nothing signs by accident.

use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex, RwLock};

use axum::body::{to_bytes, Body};
use axum::extract::State;
use axum::http::{Method, Request, StatusCode};
use axum::response::Response;
use axum::routing::any;
use axum::Router;
use nitro_attest::release::NsmAttestation;

use nitro_enclave_host::bridge::LoopbackBridge;
use nitro_enclave_host::dispatch::dispatch;
use nitro_enclave_host::kms_release::ProductionKms;
use nitro_enclave_host::overlay::EnvOverlay;
use nitro_enclave_host::state::{AppState, KmsDiag, RoleReport, SignerPlane};
use nitro_enclave_host::{http_error, DispatchOutcome, RuntimeError, RUNTIME_NAME};

/// The signing plane of a host whose custody connection is not configured.
/// Every role reads as unconfigured and every sign request fails closed with
/// the exact 503 the Node server produced for an unprovisioned key — there
/// is no path here that could ever touch key material.
struct NoCustodySigner;

impl SignerPlane for NoCustodySigner {
    fn role_report(&self, _network: &str, role: &str) -> RoleReport {
        RoleReport {
            issues: vec![format!("{role}: no custody signing plane is connected")],
            ..RoleReport::not_configured()
        }
    }

    fn sign_payload(
        &self,
        _network: &str,
        role: &str,
        _data_hex: &str,
    ) -> Result<serde_json::Value, RuntimeError> {
        Err(http_error(
            503,
            format!("{role} signer is not configured or does not match pinned identity"),
        ))
    }
}

#[derive(Clone)]
struct ShimState {
    app: Arc<AppState>,
    max_body_bytes: usize,
}

#[tokio::main]
async fn main() {
    let port = env_port();
    let host = env_host();
    let worker_port = env_worker_port();
    let max_body_bytes = max_body_bytes();

    let overlay = EnvOverlay::from_process();
    let bridge_child = nitro_enclave_host::child::BridgeChild::from_env(worker_port).map(Arc::new);
    if let Some(child) = &bridge_child {
        child.ensure_running(&overlay);
    }

    let app_state = Arc::new(AppState {
        overlay: RwLock::new(overlay),
        runtime_token_kms_version: AtomicU64::new(0),
        attest: Box::new(NsmAttestation),
        signer: Box::new(NoCustodySigner),
        bridge: Box::new(LoopbackBridge::new(worker_port)),
        kms: Box::new(ProductionKms::new()),
        kms_diag: Mutex::new(KmsDiag::default()),
        bridge_child: bridge_child.clone(),
    });

    // The child's liveness watch: respawn a crashed child on a 1s cadence with
    // the CURRENT overlay (post-/provision) — the enclave keeps serving
    // through child crashes the way the merged server did.
    if bridge_child.is_some() {
        let watch_state = app_state.clone();
        std::thread::Builder::new()
            .name("bridge-child-watch".to_string())
            .spawn(move || loop {
                std::thread::sleep(std::time::Duration::from_secs(1));
                let snapshot = watch_state.overlay.read().expect("overlay lock").clone();
                if let Some(child) = &watch_state.bridge_child {
                    child.ensure_running(&snapshot);
                }
            })
            .expect("bridge child watch thread");
    }

    let router = Router::new().fallback(any(serve)).with_state(ShimState {
        app: app_state.clone(),
        max_body_bytes,
    });

    let listener = tokio::net::TcpListener::bind((host.as_str(), port))
        .await
        .unwrap_or_else(|error| panic!("cannot bind {host}:{port}: {error}"));
    println!(
        "{}",
        serde_json::json!({
            "level": "info",
            "msg": "morpheus enclave-server listening",
            "host": host,
            "port": port,
            "network": app_state.resolve_network(),
            "bridge_child_pid": bridge_child.as_ref().and_then(|c| c.pid()),
        })
    );
    axum::serve(listener, router)
        .await
        .expect("enclave host server");
}

async fn serve(State(shim): State<ShimState>, request: Request<Body>) -> Response {
    let (parts, body) = request.into_parts();
    let is_head = parts.method == Method::HEAD;
    let skip_body = parts.method == Method::GET || is_head;

    // The mjs only reads (and caps) bodies for methods that carry one; a GET
    // with a body is dispatched with an empty body text.
    let body_text = if skip_body {
        String::new()
    } else {
        match to_bytes(body, shim.max_body_bytes).await {
            Ok(bytes) => String::from_utf8_lossy(&bytes).to_string(),
            Err(_) => {
                // The mjs's readBody catch: `{status, error}` — no runtime key.
                return render(
                    DispatchOutcome {
                        status: 413,
                        body: serde_json::json!({
                            "status": "error",
                            "error": "request body too large",
                        }),
                    },
                    is_head,
                );
            }
        }
    };

    let raw_url = parts
        .uri
        .path_and_query()
        .map(|path_and_query| path_and_query.as_str())
        .unwrap_or("/")
        .to_string();
    let method = parts.method.as_str().to_string();
    let headers = parts.headers;
    let app = shim.app;
    // The dispatch core is synchronous (blocking loopback IO, NSM ioctls);
    // run it off the async workers so concurrent requests keep flowing.
    let outcome = tokio::task::spawn_blocking(move || {
        dispatch(&app, &method, &raw_url, &headers, &body_text)
    })
    .await
    .unwrap_or_else(|error| DispatchOutcome {
        status: 500,
        body: serde_json::json!({
            "status": "error",
            "error": format!("dispatch panicked: {error}"),
            "runtime": RUNTIME_NAME,
        }),
    });
    render(outcome, is_head)
}

fn render(outcome: DispatchOutcome, is_head: bool) -> Response {
    let status = StatusCode::from_u16(outcome.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let body = serde_json::to_string(&outcome.body).unwrap_or_else(|_| {
        format!("{{\"status\":\"error\",\"error\":\"unserializable body\",\"runtime\":\"{RUNTIME_NAME}\"}}")
    });
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .header("cache-control", "no-store")
        .body(Body::from(if is_head { String::new() } else { body }))
        .expect("response with static parts")
}

/// `Number(process.env.X)`: an empty, whitespace or unparseable value is
/// NaN/0 — falsy in JS — and the `||` chain falls through to the next name.
fn env_number(name: &str) -> Option<f64> {
    std::env::var(name)
        .ok()
        .and_then(|value| value.trim().parse::<f64>().ok())
        .filter(|value| value.is_finite() && *value != 0.0)
}

/// `Math.max(Number(PORT || ENCLAVE_PORT || 8787), 1)`.
fn env_port() -> u16 {
    port_from(&["PORT", "ENCLAVE_PORT"], 8787)
}

/// The keyless compute child's loopback port (the plan's split: :8090).
fn env_worker_port() -> u16 {
    port_from(&["ENCLAVE_WORKER_PORT"], 8090)
}

fn port_from(names: &[&str], default: u16) -> u16 {
    for name in names {
        if let Some(value) = env_number(name) {
            let port = value.max(1.0);
            return u16::try_from(port as u64)
                .unwrap_or_else(|_| panic!("{name}={port} is not a valid port"));
        }
    }
    default
}

/// `trimString(ENCLAVE_HOST || HOST || '127.0.0.1')` — S15: loopback unless
/// explicitly overridden.
fn env_host() -> String {
    for name in ["ENCLAVE_HOST", "HOST"] {
        if let Some(value) = std::env::var(name).ok().map(|v| v.trim().to_string()) {
            if !value.is_empty() {
                return value;
            }
        }
    }
    "127.0.0.1".to_string()
}

/// `Math.max(Number(ENCLAVE_MAX_BODY_BYTES || 262144), 1024)`, except an
/// unparseable value falls back to the default rather than JS's NaN
/// silently disabling the cap.
fn max_body_bytes() -> usize {
    let configured = env_number("ENCLAVE_MAX_BODY_BYTES")
        .map(|value| value.max(1.0) as u64)
        .unwrap_or(262_144);
    configured.max(1024) as usize
}
