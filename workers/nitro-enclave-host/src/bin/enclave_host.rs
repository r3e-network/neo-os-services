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

use std::collections::BTreeMap;
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex, RwLock};

use axum::body::{to_bytes, Body};
use axum::extract::State;
use axum::http::{Method, Request, StatusCode};
use axum::response::Response;
use axum::routing::any;
use axum::Router;
use nitro_attest::release::NsmAttestation;
use tower::ServiceExt;

use nitro_enclave_host::custody::{CustodySigner, CustodyTransport, ReqwestCustodyTransport};
use nitro_enclave_host::custody_bootstrap;
use nitro_enclave_host::dispatch::dispatch;
use nitro_enclave_host::embedded_custody::InProcessCustodyTransport;
use nitro_enclave_host::feed_public_quorum::{PublicSourcePrices, ReqwestPublicQuotes};
use nitro_enclave_host::feed_sign::TwelveDataPrices;
use nitro_enclave_host::feed_status::PricePlaneStatus;
use nitro_enclave_host::kms_release::ProductionKms;
use nitro_enclave_host::neodid::ReqwestJwksFetcher;
use nitro_enclave_host::network_profiles::{select_request, NetworkProfiles};
use nitro_enclave_host::overlay::EnvOverlay;
use nitro_enclave_host::state::{AppState, KmsDiag, PriceSource};
use nitro_enclave_host::DispatchOutcome;
use nitro_enclave_host::RUNTIME_NAME;

#[derive(Clone)]
struct ShimState {
    apps: Arc<BTreeMap<String, Arc<AppState>>>,
    custody: Arc<BTreeMap<String, Router>>,
    explicit_network: bool,
    max_body_bytes: usize,
    request_slots: Arc<tokio::sync::Semaphore>,
    #[cfg(feature = "embedded-relayer")]
    relayer: Option<nitro_enclave_host::embedded_relayer::Controller>,
}

// The existing enclave has a fixed memory/CPU budget. This process-wide cap
// includes body readers and queued/running blocking dispatches on both networks.
const MAX_INFLIGHT_REQUESTS: usize = 16;
const BODY_READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

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

    let profiles =
        NetworkProfiles::from_overlay(&EnvOverlay::from_process()).unwrap_or_else(|error| {
            eprintln!("enclave_host: refusing to serve — {}", error.message);
            std::process::exit(1);
        });
    let explicit_network = profiles.explicit;
    #[cfg(feature = "embedded-relayer")]
    {
        let gates = profiles
            .overlays
            .values()
            .map(nitro_enclave_host::relayer_auth::enabled)
            .collect::<Result<Vec<_>, _>>()
            .unwrap_or_else(|error| {
                eprintln!("enclave_host: refusing embedded relayer gate — {error}");
                std::process::exit(1)
            });
        if gates.iter().any(|enabled| *enabled)
            && (!profiles.explicit
                || gates.len() != 2
                || gates.iter().any(|enabled| !*enabled)
                || !nitro_enclave_host::embedded_relayer::validate_public_profiles(&profiles)
                    .unwrap_or_else(|error| {
                        eprintln!("enclave_host: refusing embedded public profiles — {error}");
                        std::process::exit(1)
                    }))
        {
            eprintln!("enclave_host: embedded relayer requires both public profiles");
            std::process::exit(1);
        }
    }
    #[cfg(not(feature = "embedded-relayer"))]
    if profiles.overlays.values().any(|overlay| {
        !matches!(
            overlay.get("MORPHEUS_EMBEDDED_RELAYER"),
            None | Some("false")
        )
    }) {
        eprintln!("enclave_host: this image does not include the embedded relayer");
        std::process::exit(1);
    }
    let custody = custody_bootstrap::boot_with_internal_raw(&profiles).unwrap_or_else(|error| {
        eprintln!("enclave_host: refusing to serve — {error}");
        std::process::exit(1);
    });
    let apps = Arc::new(build_apps_with_internal_raw(
        profiles,
        &custody.routers,
        &custody.internal_raw,
    ));
    let custody = Arc::new(custody.routers);
    let request_slots = Arc::new(tokio::sync::Semaphore::new(MAX_INFLIGHT_REQUESTS));
    #[cfg(feature = "embedded-relayer")]
    let prepared = nitro_enclave_host::embedded_relayer::prepare(
        &apps,
        &custody,
        explicit_network,
        request_slots.clone(),
        max_body_bytes,
    )
    .unwrap_or_else(|error| {
        eprintln!("enclave_host: refusing embedded relayer boot — {error}");
        std::process::exit(1)
    });
    let networks: Vec<String> = apps.keys().cloned().collect();
    let network = if explicit_network {
        "dual".to_string()
    } else {
        networks[0].clone()
    };
    let price_planes: BTreeMap<String, String> = apps
        .iter()
        .map(|(network, app)| {
            let overlay = app.overlay.read().expect("overlay lock");
            let plane = nitro_enclave_host::feed_public_quorum::select_price_plane(
                overlay.get("FEED_PRICE_PLANE"),
            )
            .expect("validated at boot");
            (network.clone(), plane.as_str().to_string())
        })
        .collect();
    let router = Router::new().fallback(any(serve)).with_state(ShimState {
        apps: apps.clone(),
        custody: custody.clone(),
        explicit_network,
        max_body_bytes,
        request_slots,
        #[cfg(feature = "embedded-relayer")]
        relayer: prepared.as_ref().map(|p| p.controller.clone()),
    });

    // Only the serve loop is async, so the runtime is built here, after every
    // runtime-carrying value exists. (If serve ever returned, the future's
    // state would drop on a runtime worker — but the runtime carries no
    // runtime-carrying values of its own at that point, and a server that
    // stops serving is process-exit territory anyway.)
    let runtime = host_runtime();
    let result = runtime.block_on(async move {
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
                "networks": networks,
                "price_plane": if explicit_network { None } else { price_planes.values().next() },
                "price_planes": price_planes,
            })
        );
        #[cfg(feature = "embedded-relayer")]
        let close = prepared.as_ref().map(|p| p.controller.clone());
        let server = async move {
            axum::serve(listener, router)
                .with_graceful_shutdown(async move {
                    #[cfg(feature = "embedded-relayer")]
                    if let Some(control) = close {
                        control.frontier_shutdown().await;
                        return;
                    }
                    let reason = neo_os_service_runtime::shutdown_signal().await;
                    eprintln!("nitro enclave host: {reason}");
                })
                .await
                .map_err(|_| "enclave host server failed".to_string())
        };
        #[cfg(feature = "embedded-relayer")]
        if let Some(prepared) = prepared {
            return prepared
                .run(server, neo_os_service_runtime::shutdown_signal())
                .await;
        }
        server.await
    });
    // Keep strong dependency owners outside the async future. Runtime drop
    // joins blocking work before custody/frontier clients and vault leases drop.
    drop(runtime);
    drop(apps);
    drop(custody);
    if let Err(error) = result {
        eprintln!("enclave_host: {error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
fn build_apps(
    profiles: NetworkProfiles,
    custody: &BTreeMap<String, Router>,
) -> BTreeMap<String, Arc<AppState>> {
    build_apps_with_internal_raw(profiles, custody, &BTreeMap::new())
}

fn build_apps_with_internal_raw(
    profiles: NetworkProfiles,
    custody: &BTreeMap<String, Router>,
    bridges: &BTreeMap<String, custody_bootstrap::InternalRawBridge>,
) -> BTreeMap<String, Arc<AppState>> {
    profiles
        .overlays
        .into_iter()
        .map(|(network, overlay)| {
            let transport: Box<dyn CustodyTransport> = match custody.get(&network) {
                Some(router) => {
                    let mut transport = InProcessCustodyTransport::new(&network, router.clone())
                        .expect("validated network");
                    if let Some(bridge) = bridges.get(&network) {
                        transport = transport
                            .with_internal_raw(bridge.clone())
                            .expect("measured mainnet raw bridge");
                    }
                    Box::new(transport)
                }
                None => Box::new(ReqwestCustodyTransport::new()),
            };
            (network, build_app(overlay, transport))
        })
        .collect()
}

fn host_runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_multi_thread()
        // Admitted frontier tasks can synchronously await custody's canonical
        // async router, which itself schedules one blocking policy/commit
        // operation. Reserve that second level without increasing admission.
        .max_blocking_threads(MAX_INFLIGHT_REQUESTS * 2)
        .enable_all()
        .build()
        .expect("tokio runtime")
}

fn build_app(base: EnvOverlay, transport: Box<dyn CustodyTransport>) -> Arc<AppState> {
    // Boot is deliberately synchronous — including the custody transport, a
    // `reqwest::blocking::Client` that carries its own internal tokio runtime.
    // Under `#[tokio::main]` that creation (and any drop) happens inside an
    // async context, which panics ("Cannot drop a runtime in a context where
    // blocking is not allowed"); outside one, it is a plain value whose
    // requests run on `spawn_blocking` threads.
    let overlay = Arc::new(RwLock::new(base));

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
        signer: Box::new(CustodySigner::new(overlay.clone(), transport)),
        kms: Box::new(ProductionKms::new()),
        price: price_plane_impl,
        oracle_io: Box::new(ProductionOracleIo),
        jwks_fetcher: Box::new(ReqwestJwksFetcher),
        oracle_runtime: Mutex::new(neo_os_compute::oracle::providers::ProviderRuntime::default()),
        kms_diag: Mutex::new(KmsDiag::default()),
        price_plane_status,
        overload: neo_os_compute::overload::OverloadGuard::new(),
        ephemeral_oracle_key: Mutex::new(None),
        automation_executions: Mutex::new(Default::default()),
        game_sessions: Mutex::new(neo_os_games::session::SessionStore::new()),
        feed_runtime: Default::default(),
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
    let _network = match app_state.resolve_network() {
        Ok(network) => network,
        Err(error) => {
            eprintln!(
                "enclave_host: refusing to serve — invalid runtime network: {}",
                error.message
            );
            std::process::exit(1);
        }
    };

    app_state
}

async fn serve(State(shim): State<ShimState>, request: Request<Body>) -> Response {
    #[cfg(feature = "embedded-relayer")]
    if shim
        .relayer
        .as_ref()
        .is_some_and(|control| control.is_draining())
    {
        return render(
            DispatchOutcome {
                status: 503,
                body: serde_json::json!({"ready":false,"error":"runtime is draining"}),
            },
            request.method() == Method::HEAD,
        );
    }
    let (parts, body) = request.into_parts();
    let is_head = parts.method == Method::HEAD;
    let skip_body = parts.method == Method::GET || is_head;
    let permit = match shim.request_slots.clone().try_acquire_owned() {
        Ok(permit) => permit,
        Err(_) => {
            let mut response = render(
                DispatchOutcome {
                    status: 503,
                    body: serde_json::json!({"error":"enclave request capacity exhausted"}),
                },
                is_head,
            );
            response
                .headers_mut()
                .insert("retry-after", axum::http::HeaderValue::from_static("1"));
            return response;
        }
    };

    // The mjs only reads (and caps) bodies for methods that carry one; a GET
    // with a body is dispatched with an empty body text.
    let body_text = if skip_body {
        String::new()
    } else {
        match tokio::time::timeout(BODY_READ_TIMEOUT, to_bytes(body, shim.max_body_bytes)).await {
            Ok(Ok(bytes)) => String::from_utf8_lossy(&bytes).to_string(),
            Ok(Err(_)) => {
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
            Err(_) => {
                return render(
                    DispatchOutcome {
                        status: 408,
                        body: serde_json::json!({"error":"request body timed out"}),
                    },
                    is_head,
                )
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
    let (app, raw_url, selected_network) = if shim.explicit_network {
        match select_request(&method, &raw_url, &headers, &body_text) {
            Ok(selected) => (
                shim.apps
                    .get(&selected.network)
                    .expect("validated profile")
                    .clone(),
                selected.raw_url,
                selected.network,
            ),
            Err(error) => {
                return render(
                    DispatchOutcome {
                        status: error.status,
                        body: error.body(),
                    },
                    is_head,
                )
            }
        }
    } else {
        (
            shim.apps.values().next().expect("single profile").clone(),
            raw_url,
            shim.apps.keys().next().expect("single profile").clone(),
        )
    };
    if let Some(path) = custody_bootstrap::native_path(&raw_url) {
        if let Some(router) = shim.custody.get(&selected_network) {
            let mut request = Request::builder()
                .method(method.as_str())
                .uri(path)
                .body(Body::from(body_text))
                .expect("validated native custody request");
            *request.headers_mut() = headers;
            // The native router authenticates independently; the frontier's
            // runtime token never becomes an administrative custody token.
            // Detaching this task on client cancellation keeps the frontier
            // slot until the native router finishes its own blocking work.
            let router = router.clone();
            return tokio::spawn(async move {
                let _permit = permit;
                router.oneshot(request).await.expect("infallible router")
            })
            .await
            .unwrap_or_else(|_| {
                render(
                    DispatchOutcome {
                        status: 500,
                        body: serde_json::json!({"error":"native custody task failed"}),
                    },
                    is_head,
                )
            });
        }
        return render(
            DispatchOutcome {
                status: 503,
                body: serde_json::json!({"error":"embedded custody is not configured"}),
            },
            is_head,
        );
    }
    // The dispatch core is synchronous (blocking loopback IO, NSM ioctls);
    // run it off the async workers so concurrent requests keep flowing.
    #[cfg(feature = "embedded-relayer")]
    let relayer = shim.relayer.clone();
    let outcome = tokio::task::spawn_blocking(move || {
        // A disconnected HTTP client cannot release capacity while its
        // non-cancellable blocking dispatch is still running.
        let _permit = permit;
        let outcome = dispatch(&app, &method, &raw_url, &headers, &body_text);
        #[cfg(feature = "embedded-relayer")]
        let outcome = match relayer {
            Some(control) => nitro_enclave_host::embedded_relayer::merge_health_outcome(
                &method, &raw_url, &headers, outcome, &control,
            ),
            None => outcome,
        };
        outcome
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

#[cfg(test)]
mod runtime_tests {
    use super::*;

    #[test]
    fn app_signing_and_external_custody_dispatch_share_the_selected_router() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let mut overlays = BTreeMap::new();
        let mut routers = BTreeMap::new();
        let mut counters = BTreeMap::new();
        for network in ["mainnet", "testnet"] {
            overlays.insert(
                network.to_string(),
                EnvOverlay::new([
                    ("MORPHEUS_NETWORK", network.to_string()),
                    (
                        "SIGNER_SERVICE_URL",
                        nitro_enclave_host::embedded_custody::embedded_base_url(network).unwrap(),
                    ),
                    ("SIGNER_SERVICE_TOKEN", format!("local-{network}")),
                    ("SIGNER_ROLE_WORKER_KEY_ID", "local-key".to_string()),
                ]),
            );
            let calls = Arc::new(AtomicUsize::new(0));
            counters.insert(network, calls.clone());
            routers.insert(
                network.to_string(),
                Router::new().fallback(any(move |request: Request<Body>| {
                    let calls = calls.clone();
                    async move {
                        calls.fetch_add(1, Ordering::SeqCst);
                        if request.uri().path() != "/health" {
                            assert_eq!(
                                request
                                    .headers()
                                    .get("authorization")
                                    .unwrap()
                                    .to_str()
                                    .unwrap(),
                                format!("Bearer local-{network}")
                            );
                            (
                                StatusCode::SERVICE_UNAVAILABLE,
                                axum::Json(serde_json::json!({"error":"sealed fixture"})),
                            )
                        } else {
                            (
                                StatusCode::OK,
                                axum::Json(serde_json::json!({"network":network})),
                            )
                        }
                    }
                })),
            );
        }
        let apps = Arc::new(build_apps(
            NetworkProfiles {
                overlays,
                explicit: true,
            },
            &routers,
        ));
        let shim = ShimState {
            apps: apps.clone(),
            custody: Arc::new(routers),
            explicit_network: true,
            max_body_bytes: 256 * 1024,
            request_slots: Arc::new(tokio::sync::Semaphore::new(MAX_INFLIGHT_REQUESTS)),
            #[cfg(feature = "embedded-relayer")]
            relayer: None,
        };
        host_runtime().block_on(async {
            for network in ["mainnet", "testnet"] {
                let app = apps[network].clone();
                let report =
                    tokio::task::spawn_blocking(move || app.signer.role_report(network, "worker"))
                        .await
                        .unwrap();
                assert!(!report.ok);
                assert_eq!(
                    counters[network].load(Ordering::SeqCst),
                    1,
                    "signing must reach its in-process router"
                );
                let response = serve(
                    State(shim.clone()),
                    Request::builder()
                        .uri(format!("/{network}/custody/health"))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await;
                assert_eq!(response.status(), StatusCode::OK);
                let body: serde_json::Value =
                    serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap())
                        .unwrap();
                assert_eq!(body["network"], network);
                assert_eq!(counters[network].load(Ordering::SeqCst), 2);
            }
            let refused = serve(
                State(shim.clone()),
                Request::builder()
                    .uri("/mainnet/custody/health")
                    .header("x-morpheus-network", "testnet")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await;
            assert_eq!(refused.status(), StatusCode::BAD_REQUEST);
            assert_eq!(counters["mainnet"].load(Ordering::SeqCst), 2);
            assert_eq!(counters["testnet"].load(Ordering::SeqCst), 2);
        });
    }

    #[test]
    fn admitted_frontier_work_cannot_starve_nested_custody_work() {
        let runtime = host_runtime();
        runtime.block_on(async {
            let release = Arc::new(std::sync::Barrier::new(MAX_INFLIGHT_REQUESTS + 1));
            let (started, count) = std::sync::mpsc::channel();
            let mut frontier = Vec::new();
            for _ in 0..MAX_INFLIGHT_REQUESTS {
                let release = release.clone();
                let started = started.clone();
                frontier.push(tokio::task::spawn_blocking(move || {
                    started.send(()).unwrap();
                    release.wait();
                }));
            }
            drop(started);
            // Establish all frontier workers are occupied before queuing the
            // nested custody operation. Both paths are bounded and every task
            // is released before asserting, including the failing control.
            for _ in 0..MAX_INFLIGHT_REQUESTS {
                count
                    .recv_timeout(std::time::Duration::from_secs(2))
                    .unwrap();
            }
            let (completed, receiver) = tokio::sync::oneshot::channel();
            let custody = tokio::task::spawn_blocking(move || {
                let _ = completed.send(());
            });
            let custody_progressed =
                tokio::time::timeout(std::time::Duration::from_millis(500), receiver)
                    .await
                    .is_ok();
            release.wait();
            for task in frontier {
                task.await.unwrap();
            }
            custody.await.unwrap();
            assert!(
                custody_progressed,
                "nested custody must execute while all admitted frontier workers remain occupied"
            );
        });
    }
}

#[cfg(test)]
#[path = "../../tests/unit/native_admission.rs"]
mod native_admission_tests;
