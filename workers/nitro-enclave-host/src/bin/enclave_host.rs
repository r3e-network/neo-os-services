//! The enclave host binary: axum in front of the pure dispatch core, wiring
//! the production seams — the NSM attestation source, the attestation-gated
//! KMS release, the in-process Rust compute plane, the custody-backed signing
//! plane, and the process-env overlay that /provision mutates.
//!
//! The HTTP layer is a faithful port of `enclave-server.mjs`'s
//! `createServer`: JSON responses with `cache-control: no-store`, the body
//! cap (`ENCLAVE_MAX_BODY_BYTES`, min 1 KiB, default 256 KiB) answering 413
//! before dispatch, and GET/HEAD requests dispatched with an empty body.
//! One deliberate divergence: an unparseable body-cap value falls back to
//! the 256 KiB default instead of JS's NaN disabling the cap entirely.
//!
//! The signing plane is the custody client: the host never holds keys, and
//! until `/provision` connects custody (`SIGNER_SERVICE_URL`) every role
//! reports unconfigured — the same 503 the Node server produced when no key
//! env was provisioned. /health surfaces that state; nothing signs by
//! accident. The oracle read lanes ride the [`ProductionOracleIo`] plane:
//! the enclave egress transport, the SSRF DNS pin, and the wall clock.

use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex, RwLock};

use axum::body::{to_bytes, Body};
use axum::extract::State;
use axum::http::{Method, Request, StatusCode};
use axum::response::Response;
use axum::routing::any;
use axum::Router;
use nitro_attest::release::NsmAttestation;

use nitro_enclave_host::custody::{CustodySigner, ReqwestCustodyTransport};
use nitro_enclave_host::dispatch::dispatch;
use nitro_enclave_host::feed_public_quorum::{PublicSourcePrices, ReqwestPublicQuotes};
use nitro_enclave_host::feed_sign::TwelveDataPrices;
use nitro_enclave_host::feed_status::PricePlaneStatus;
use nitro_enclave_host::kms_release::ProductionKms;
use nitro_enclave_host::neodid::ReqwestJwksFetcher;
use nitro_enclave_host::overlay::EnvOverlay;
use nitro_enclave_host::state::{AppState, KmsDiag, PriceSource};
use nitro_enclave_host::DispatchOutcome;
use nitro_enclave_host::RUNTIME_NAME;

#[derive(Clone)]
struct ShimState {
    app: Arc<AppState>,
    max_body_bytes: usize,
}

/// The oracle lanes' production IO: `reqwest_transport` (the same client the
/// compatibility worker used, sync over the egress proxy), `(host, 0)` →
/// `ToSocketAddrs` for the SSRF pin, `SystemTime`/`thread::sleep` for the
/// fetch timeouts. Tests substitute a fake through the same trait.
struct ProductionOracleIo;

impl nitro_enclave_host::state::OracleIo for ProductionOracleIo {
    fn fetch(
        &self,
        request: &neo_os_compute::transport::HttpRequest,
    ) -> Result<neo_os_compute::transport::HttpResponse, String> {
        neo_os_compute::transport::reqwest_transport()(request)
    }

    fn dns_lookup(&self, host: &str) -> Result<Vec<neo_os_compute::ssrf::ResolvedAddress>, String> {
        use std::net::ToSocketAddrs;
        Ok((host, 0u16)
            .to_socket_addrs()
            .map_err(|error| error.to_string())?
            .map(|socket| {
                let ip = socket.ip();
                neo_os_compute::ssrf::ResolvedAddress {
                    address: ip.to_string(),
                    family: if ip.is_ipv4() { 4 } else { 6 },
                }
            })
            .collect())
    }

    fn now_ms(&self) -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|since| since.as_millis() as u64)
            .unwrap_or(0)
    }

    fn sleep_ms(&self, ms: u64) {
        std::thread::sleep(std::time::Duration::from_millis(ms));
    }
}

fn main() {
    let port = env_port();
    let host = env_host();
    let max_body_bytes = max_body_bytes();

    // Boot is deliberately synchronous — including the custody transport, a
    // `reqwest::blocking::Client` that carries its own internal tokio runtime.
    // Under `#[tokio::main]` that creation (and any drop) happens inside an
    // async context, which panics ("Cannot drop a runtime in a context where
    // blocking is not allowed"); outside one, it is a plain value whose
    // requests run on `spawn_blocking` threads.
    let overlay = Arc::new(RwLock::new(EnvOverlay::from_process()));

    // The price plane and `/health` share one status cell: what the plane
    // classified is what the status reports, by construction rather than by two
    // writers agreeing.
    let price_plane_status = Arc::new(Mutex::new(PricePlaneStatus::default()));

    // Which plane serves `/feed/sign`. DEC-CU-30: built dark and default-off —
    // the keyed TwelveData plane stays in front until an operator names the
    // public-source quorum, and an unknown label refuses to boot instead of
    // silently serving the single-source plane the operator thought they had
    // replaced. Same fail-closed disposition `resolve_network` applies below.
    let price_plane = match nitro_enclave_host::feed_public_quorum::select_price_plane(
        overlay
            .read()
            .expect("overlay lock")
            .get("FEED_PRICE_PLANE"),
    ) {
        Ok(plane) => plane,
        Err(message) => {
            eprintln!("enclave_host: refusing to serve — {message}");
            std::process::exit(1);
        }
    };
    let price_plane_impl: Box<dyn PriceSource> = match price_plane {
        nitro_enclave_host::feed_public_quorum::PricePlane::TwelveData => {
            Box::new(TwelveDataPrices::new(overlay.clone()))
        }
        nitro_enclave_host::feed_public_quorum::PricePlane::PublicQuorum => Box::new(
            PublicSourcePrices::new(Box::new(ReqwestPublicQuotes), overlay.clone()),
        ),
    };

    let app_state = Arc::new(AppState {
        overlay: overlay.clone(),
        runtime_token_kms_version: AtomicU64::new(0),
        attest: Box::new(NsmAttestation),
        signer: Box::new(CustodySigner::new(
            overlay.clone(),
            Box::new(ReqwestCustodyTransport::new()),
        )),
        kms: Box::new(ProductionKms::new()),
        price: price_plane_impl,
        oracle_io: Box::new(ProductionOracleIo),
        jwks_fetcher: Box::new(ReqwestJwksFetcher),
        oracle_runtime: Mutex::new(neo_os_compute::oracle::providers::ProviderRuntime::default()),
        kms_diag: Mutex::new(KmsDiag::default()),
        price_plane_status,
        overload: neo_os_compute::overload::OverloadGuard::new(),
        ephemeral_oracle_key: Mutex::new(None),
    });

    // SVC-D-2 / CL-29: before serving anything, prove this is a measured
    // enclave when the image demands it. A `--debug-mode` enclave boots
    // normally and answers NSM with all-zero PCRs — the KMS policy would then
    // refuse to release keys, but nothing in this process said so, and
    // /attestation is public. Refusing to serve is the honest answer; the
    // exit code and message are the operator's signal.
    match nitro_enclave_host::attestation::assert_attested_boot(&app_state) {
        Ok(None) => {}
        Ok(Some(pcr0)) => {
            eprintln!("enclave_host: attested boot, PCR0={pcr0}");
        }
        Err(message) => {
            eprintln!("enclave_host: refusing to serve — {message}");
            std::process::exit(1);
        }
    }

    // MORPHEUS_NETWORK is fixed at boot (it is not provisionable), and every
    // signing lane resolves its custody identity from it. An unreviewed label
    // stops the process here, before it binds, the same way an unattested
    // boot does, instead of panicking after the listener is up.
    let network = match app_state.resolve_network() {
        Ok(network) => network,
        Err(error) => {
            eprintln!(
                "enclave_host: refusing to serve — invalid runtime network: {}",
                error.message
            );
            std::process::exit(1);
        }
    };

    let router = Router::new().fallback(any(serve)).with_state(ShimState {
        app: app_state.clone(),
        max_body_bytes,
    });

    // Only the serve loop is async, so the runtime is built here, after every
    // runtime-carrying value exists. (If serve ever returned, the future's
    // state would drop on a runtime worker — but the runtime carries no
    // runtime-carrying values of its own at that point, and a server that
    // stops serving is process-exit territory anyway.)
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    runtime.block_on(async move {
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
                "network": network,
                "execution_plane": "rust-in-process",
                "price_plane": nitro_enclave_host::feed_public_quorum::PricePlane::as_str(price_plane),
            })
        );
        axum::serve(listener, router)
            .with_graceful_shutdown(async {
                let reason = neo_os_service_runtime::shutdown_signal().await;
                eprintln!("nitro enclave host: {reason}");
            })
            .await
            .expect("enclave host server");
    });
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
