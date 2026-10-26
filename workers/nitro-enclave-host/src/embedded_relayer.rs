//! One-process relayer ownership. No subprocess, global environment mutation,
//! credential generator, alternate signer or detached shutdown task exists here.
use crate::custody::{CustodyRequest, CustodyTransport};
use crate::embedded_custody::{embedded_base_url, InProcessCustodyTransport};
use crate::overlay::EnvOverlay;
use crate::state::AppState;
use axum::Router;
use neo_os_relayer::config::RelayerConfig;
use neo_os_relayer::transport::RuntimeContext;
use neo_os_service_runtime::ShutdownReason;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::future::Future;
use std::sync::{
    atomic::{AtomicU8, Ordering},
    Arc, Mutex,
};
use std::time::Duration;
use tokio::sync::{watch, Semaphore};
use tokio::task::JoinSet;

const WAITING: u8 = 0;
const RUNNING: u8 = 1;
const DRAINING: u8 = 2;
const CLOSED: u8 = 3;

#[derive(Clone)]
pub struct Controller {
    phase: Arc<AtomicU8>,
    stop: watch::Sender<Option<ShutdownReason>>,
    frontier_closed: watch::Sender<bool>,
    health_configs: Arc<Mutex<BTreeMap<String, RelayerConfig>>>,
    started_ms: f64,
}
impl Controller {
    pub fn new() -> Self {
        let (stop, _) = watch::channel(None);
        let (frontier_closed, _) = watch::channel(false);
        Self {
            phase: Arc::new(AtomicU8::new(WAITING)),
            stop,
            frontier_closed,
            health_configs: Arc::new(Mutex::new(BTreeMap::new())),
            started_ms: neo_os_relayer::relayer::now_ms(),
        }
    }
    pub async fn stop_reason(&self) -> ShutdownReason {
        let mut rx = self.stop.subscribe();
        loop {
            if let Some(reason) = *rx.borrow_and_update() {
                return reason;
            }
            if rx.changed().await.is_err() {
                return ShutdownReason::Terminate;
            }
        }
    }
    pub async fn frontier_shutdown(&self) {
        let mut rx = self.frontier_closed.subscribe();
        loop {
            if *rx.borrow_and_update() {
                return;
            }
            if rx.changed().await.is_err() {
                return;
            }
        }
    }
    fn register(&self, config: &RelayerConfig) {
        let mut view = config.clone();
        view.raw = Value::Null; // Health retains no credential.
        let mut configs = self.health_configs.lock().expect("relayer health lock");
        configs.insert(config.network.clone(), view);
        if configs.len() == 2 {
            let _ =
                self.phase
                    .compare_exchange(WAITING, RUNNING, Ordering::SeqCst, Ordering::SeqCst);
        }
    }
    /// Called on the existing blocking dispatch pool, never on an async worker.
    pub fn health(&self) -> Value {
        let configs = self
            .health_configs
            .lock()
            .expect("relayer health lock")
            .clone();
        let phase = self.phase.load(Ordering::SeqCst);
        let mut healthy = phase == RUNNING && configs.len() == 2;
        let mut lanes = serde_json::Map::new();
        for network in ["mainnet", "testnet"] {
            let ok = configs.get(network).is_some_and(|config| {
                neo_os_relayer::relayer::runtime_health(config).is_ok_and(|h| {
                    h.get("network").and_then(Value::as_str) == Some(network)
                        && h.get("checked_at_ms")
                            .and_then(Value::as_f64)
                            .is_some_and(|n| n >= self.started_ms)
                        && h.get("stopped").and_then(Value::as_bool) != Some(true)
                })
            });
            healthy &= ok;
            lanes.insert(network.into(), json!({"healthy":ok}));
        }
        let phase = self.phase.load(Ordering::SeqCst);
        healthy &= phase == RUNNING;
        json!({"healthy":healthy,"phase":match phase {WAITING=>"awaiting-provision",RUNNING=>"running",DRAINING=>"draining",_=>"closed"},"networks":lanes})
    }
    pub fn is_draining(&self) -> bool {
        self.phase.load(Ordering::SeqCst) >= DRAINING
    }
    pub fn begin_draining(&self, reason: ShutdownReason) {
        self.phase.fetch_max(DRAINING, Ordering::SeqCst);
        self.stop.send_if_modified(|current| {
            if current.is_some() {
                false
            } else {
                *current = Some(reason);
                true
            }
        });
    }
}
impl Default for Controller {
    fn default() -> Self {
        Self::new()
    }
}

/// Both normal shutdown and unexpected task/server termination follow the same
/// dependency order. The caller retains Apps/routers until this returns.
pub async fn supervise<S, F>(
    mut lanes: JoinSet<Result<(), String>>,
    control: Controller,
    server: S,
    shutdown: F,
) -> Result<(), String>
where
    S: Future<Output = Result<(), String>>,
    F: Future<Output = ShutdownReason>,
{
    tokio::pin!(server);
    tokio::pin!(shutdown);
    let (reason, mut failure, server_done) = tokio::select! {
        biased;
        reason=&mut shutdown=>(reason,None,false),
        reason=control.stop_reason()=>(reason,Some("relayer runtime requested shutdown".into()),false),
        result=lanes.join_next()=>{
            let message=match result {Some(Ok(Err(_)))=>"relayer lane failed",Some(Err(_))=>"relayer lane panicked",_=>"relayer lane terminated"};
            (ShutdownReason::Terminate,Some(message.to_string()),false)
        },
        _=&mut server=>(ShutdownReason::Terminate,Some("frontier terminated before relayer shutdown".into()),true),
    };
    control.begin_draining(reason);
    while let Some(result) = lanes.join_next().await {
        if !matches!(result, Ok(Ok(()))) {
            failure.get_or_insert_with(|| "relayer drain failed".into());
        }
    }
    // Never drop/abort a lane to make a deadline appear successful.
    control.frontier_closed.send_replace(true);
    if !server_done && server.await.is_err() {
        failure.get_or_insert_with(|| "frontier drain failed".into());
    }
    control.phase.store(CLOSED, Ordering::SeqCst);
    match failure {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

struct Bridge {
    control: Controller,
    network: String,
    prefix: String,
    app: Arc<AppState>,
    custody: InProcessCustodyTransport,
    base: RelayerConfig,
    slots: Arc<Semaphore>,
    body_cap: usize,
}
impl RuntimeContext for Bridge {
    fn notify_stopping(&self, reason: ShutdownReason) {
        self.control.begin_draining(reason);
    }
    fn refresh_config(&self, base: &RelayerConfig) -> Result<RelayerConfig, String> {
        let child = ["neo_n3", "neox"].into_iter().find(|chain| {
            base.state_file == format!("{}.{chain}.json", self.base.state_file)
                && base.instance_id == format!("{}:{chain}", self.base.instance_id)
                && base.active_chains == vec![chain.to_string()]
        });
        let root = base.state_file == self.base.state_file
            && base.instance_id == self.base.instance_id
            && base.active_chains == self.base.active_chains;
        if base.network != self.network || (!root && child.is_none()) {
            return Err("relayer context identity mismatch".into());
        }
        let overlay = self.app.overlay.read().expect("overlay lock");
        if self.app.runtime_token_kms_version.load(Ordering::SeqCst) == 0 {
            return Err("relayer is awaiting protected provisioning".into());
        }
        let credential = overlay
            .relayer_auth()
            .ok_or("relayer is awaiting its scoped credential")?;
        let semantic = overlay
            .get_trimmed("SIGNER_SERVICE_SEMANTIC_TOKEN")
            .ok_or("semantic signing caller is not provisioned")?;
        if overlay.get("SIGNER_SERVICE_SEMANTIC_TOKEN_SOURCE") != Some("nitro-recipient-kms") {
            return Err("semantic signing caller has no protected source".into());
        }
        let mut config = self.base.clone();
        config.state_file = base.state_file.clone();
        config.instance_id = base.instance_id.clone();
        config.active_chains = base.active_chains.clone();
        if child.is_some() {
            config.raw["heartbeats"] = json!({});
        }
        config.raw["stateFile"] = json!(config.state_file);
        config.raw["instanceId"] = json!(config.instance_id);
        config.raw["storeAuth"] = json!({"mode":"scoped_v2","url":self.base.raw["storeAuth"]["url"],
            "apiKey":self.base.raw["storeAuth"]["apiKey"],"issuer":self.base.raw["storeAuth"]["issuer"],
            "subject":self.base.raw["storeAuth"]["subject"],"bearer":credential.jwt()});
        config.raw["nitro"]["custodyToken"] = json!(semantic);
        // The runtime/provision credential never leaves the closed bridge.
        config.raw["nitro"]["token"] = json!("");
        neo_os_relayer::store_auth::ensure_embedded_ready(
            &config,
            self.app.oracle_io.now_ms() / 1000,
        )?;
        Ok(config)
    }
    fn local_request(
        &self,
        method: &str,
        url: &str,
        bearer: Option<&str>,
        body: Option<&str>,
    ) -> Option<Result<(u16, String), String>> {
        if !url.starts_with("http://127.0.0.1:0/") {
            return None;
        }
        Some((|| {
            let path = url
                .strip_prefix(&self.prefix)
                .filter(|p| p.starts_with('/'))
                .ok_or("embedded request selected another network")?;
            let _permit = self
                .slots
                .try_acquire()
                .map_err(|_| "embedded request capacity is exhausted")?;
            let body = body.unwrap_or("");
            if body.len() > self.body_cap {
                return Err("embedded request body exceeds the measured limit".into());
            }
            if path.starts_with("/signer/api/v1/") {
                let allowed = match method {
                    "POST" => matches!(
                        path,
                        "/signer/api/v1/sign/transaction"
                            | "/signer/api/v1/sign/eip191-fulfillment"
                    ),
                    "GET" => path.strip_prefix("/signer/api/v1/keys/").is_some_and(|id| {
                        self.base
                            .raw
                            .get("embeddedRoleIds")
                            .and_then(Value::as_array)
                            .is_some_and(|ids| ids.iter().any(|v| v.as_str() == Some(id)))
                    }),
                    _ => false,
                };
                if !allowed {
                    return Err("embedded custody capability does not permit this route".into());
                }
                let overlay = self.app.overlay.read().expect("overlay lock");
                let expected = overlay
                    .get_trimmed("SIGNER_SERVICE_SEMANTIC_TOKEN")
                    .ok_or("semantic caller unavailable")?;
                if !bearer
                    .is_some_and(|token| crate::auth::timing_safe_token_match(token, &expected))
                {
                    return Err("embedded custody caller credential mismatch".into());
                }
                drop(overlay);
                let reply = self.custody.send(CustodyRequest {
                    method: if method == "GET" { "GET" } else { "POST" },
                    url: url.into(),
                    token: bearer.map(str::to_string),
                    body: if body.is_empty() {
                        None
                    } else {
                        Some(serde_json::from_str(body).map_err(|_| "invalid custody body")?)
                    },
                })?;
                return Ok((reply.status, reply.body.to_string()));
            }
            let allowed = match method {
                "POST" => matches!(
                    path,
                    "/oracle/fulfill"
                        | "/feed/sign"
                        | "/oracle/decrypt"
                        | "/oracle/message-reveal"
                        | "/keys/derived"
                        | "/attestation"
                ),
                "GET" => matches!(path, "/attestation" | "/oracle/public-key"),
                _ => false,
            };
            if !allowed || bearer.is_some() {
                return Err("embedded frontier capability does not permit this request".into());
            }
            let token = self
                .app
                .overlay
                .read()
                .expect("overlay lock")
                .get_trimmed("MORPHEUS_RUNTIME_TOKEN")
                .ok_or("frontier runtime authorization is not provisioned")?;
            let mut headers = http::HeaderMap::new();
            headers.insert(
                http::header::AUTHORIZATION,
                http::HeaderValue::from_str(&format!("Bearer {token}"))
                    .map_err(|_| "invalid runtime authorization")?,
            );
            let selected = crate::network_profiles::select_request(
                method,
                &format!("/{}{path}", self.network),
                &headers,
                body,
            )
            .map_err(|_| "embedded network request is invalid")?;
            let response =
                crate::dispatch::dispatch(&self.app, method, &selected.raw_url, &headers, body);
            Ok((response.status, response.body.to_string()))
        })())
    }
}

pub struct Prepared {
    pub controller: Controller,
    bridges: Vec<Arc<Bridge>>,
}
impl Prepared {
    pub async fn run<S, F>(self, server: S, shutdown: F) -> Result<(), String>
    where
        S: Future<Output = Result<(), String>>,
        F: Future<Output = ShutdownReason>,
    {
        let mut lanes = JoinSet::new();
        for bridge in self.bridges {
            let control = self.controller.clone();
            lanes.spawn(async move {
                let config=loop {
                    if let Ok(config)=bridge.refresh_config(&bridge.base) {break config;}
                    tokio::select! { _=control.stop_reason()=>return Ok(()),_=tokio::time::sleep(Duration::from_millis(250))=>{} }
                };
                control.register(&config);
                neo_os_relayer::run_embedded_relayer_loop_until(&config,bridge,control.stop_reason()).await
                    .map_err(|_|"embedded relayer lane failed".into())
            });
        }
        supervise(lanes, self.controller, server, shutdown).await
    }
}

fn public_config(network: &str, overlay: &EnvOverlay) -> Result<RelayerConfig, String> {
    let required = |name: &str| {
        overlay
            .get_trimmed(name)
            .ok_or_else(|| format!("embedded relayer requires {name}"))
    };
    let state = required("MORPHEUS_RELAYER_STATE_FILE")?;
    if !state.starts_with(&format!("/var/lib/neoos-relayer/{network}/"))
        || state.split('/').any(|p| p == ".." || p == ".")
        || !state.ends_with(".json")
    {
        return Err("embedded relayer state must use its reviewed network directory".into());
    }
    let mut env = overlay.merged_map();
    // Only measured boot values are captured, before the server/provision exists.
    for name in crate::auth::TOKEN_ENV_KEYS
        .into_iter()
        .chain(crate::provision::PLAINTEXT_KEY_ENV_KEYS)
        .chain([
            "SIGNER_SERVICE_TOKEN",
            "SIGNER_SERVICE_SEMANTIC_TOKEN",
            "SUPABASE_SERVICE_ROLE_KEY",
            "morpheus_SUPABASE_SERVICE_ROLE_KEY",
        ])
    {
        env.remove(name);
    }
    let mut base = neo_os_relayer::create_relayer_config_from_env(&env)?;
    base.ensure_runtime_ready()?;
    if base.network != network || !neo_os_relayer::durable_v2::enabled(&base) {
        return Err("embedded network identity requires delivery v2".into());
    }
    let prefix = embedded_base_url(network).map_err(str::to_string)?;
    base.raw["storeAuth"] = json!({"mode":"scoped_v2","url":required("MORPHEUS_RELAYER_STORE_URL")?,
            "apiKey":required("MORPHEUS_RELAYER_STORE_API_KEY")?,"issuer":required("MORPHEUS_RELAYER_JWT_ISSUER")?,"subject":required("MORPHEUS_RELAYER_CALLER_ID")?});
    base.raw["nitro"]["token"] = json!("");
    for name in [
        "apiUrl",
        "signerUrl",
        "enclaveFulfillUrl",
        "decryptUrl",
        "custodyUrl",
    ] {
        base.raw["nitro"][name] = json!(prefix);
    }
    base.raw["nitro"]["allowFallback"] = json!(false);
    base.raw["nitro"]["enclaveFulfill"] = json!(true);
    base.raw["embeddedRoleIds"] = json!(AppState::SIGNING_ROLES
        .iter()
        .map(|role| required(&crate::custody::role_key_id_env(role)))
        .collect::<Result<Vec<_>, _>>()?);
    if base.active_chains != vec!["neo_n3".to_string(), "neox".to_string()] {
        return Err("embedded relayer requires both explicit active chain families".into());
    }
    required("MORPHEUS_RELAYER_INSTANCE_ID")?;
    neo_os_relayer::store_auth::validate_store_url(
        base.raw["storeAuth"]["url"]
            .as_str()
            .ok_or("store URL missing")?,
    )?;
    neo_os_relayer::store_auth::validate_public_api_key(
        base.raw["storeAuth"]["apiKey"]
            .as_str()
            .ok_or("public store API key missing")?,
    )?;
    Ok(base)
}

/// Read-only planner used by dual_prepare; it never initializes NSM, a key,
/// a caller credential or state. Missing real admission inputs remain closed.
pub fn validate_public_profiles(
    profiles: &crate::network_profiles::NetworkProfiles,
) -> Result<bool, String> {
    let count = profiles
        .overlays
        .values()
        .filter(|o| o.get("MORPHEUS_RELAYER_STATE_FILE").is_some())
        .count();
    if count == 0 {
        return Ok(false);
    }
    if !profiles.explicit || count != 2 {
        return Err("both public relayer profiles are required".into());
    }
    let mut identities = std::collections::BTreeSet::new();
    for network in ["mainnet", "testnet"] {
        let overlay = profiles
            .overlays
            .get(network)
            .ok_or("network profile missing")?;
        public_config(network, overlay)?;
        for name in ["MORPHEUS_RELAYER_INSTANCE_ID", "MORPHEUS_RELAYER_CALLER_ID"] {
            let id = overlay
                .get_trimmed(name)
                .ok_or("relayer identity missing")?;
            if !identities.insert((name, id)) {
                return Err("relayer identities must be independent".into());
            }
        }
    }
    Ok(true)
}

pub fn prepare(
    apps: &BTreeMap<String, Arc<AppState>>,
    custody: &BTreeMap<String, Router>,
    explicit: bool,
    slots: Arc<Semaphore>,
    body_cap: usize,
) -> Result<Option<Prepared>, String> {
    let gates: Vec<_> = apps
        .values()
        .map(|app| crate::relayer_auth::enabled(&app.overlay.read().expect("overlay lock")))
        .collect::<Result<_, _>>()?;
    if gates.iter().all(|v| !*v) {
        return Ok(None);
    }
    if !explicit || gates.len() != 2 || gates.iter().any(|v| !*v) {
        return Err("embedded relayer requires both explicit network profiles".into());
    }
    let control = Controller::new();
    let mut bridges = Vec::new();
    let mut identities = std::collections::BTreeSet::new();
    for network in ["mainnet", "testnet"] {
        let app = apps
            .get(network)
            .ok_or("embedded network is missing")?
            .clone();
        let overlay = app.overlay.read().expect("overlay lock");
        let required = |name: &str| {
            overlay
                .get_trimmed(name)
                .ok_or_else(|| format!("embedded relayer requires {name}"))
        };
        for name in ["MORPHEUS_RELAYER_INSTANCE_ID", "MORPHEUS_RELAYER_CALLER_ID"] {
            if !identities.insert((name, required(name)?)) {
                return Err("embedded networks share a caller or process identity".into());
            }
        }
        let mut base = public_config(network, &overlay)?;
        let prefix = embedded_base_url(network).map_err(str::to_string)?;
        if base.is_production() {
            if overlay.get("MORPHEUS_ATTESTED_BOOT") != Some("require") {
                return Err("embedded production requires measured attested boot".into());
            }
            let pcr = crate::attestation::assert_attested_boot(&app)?
                .ok_or("embedded production measurement is unavailable")?;
            base.raw["nitro"]["expectedPcr0"] = json!(pcr);
            base.raw["nitro"]["verifyEnclaveSignature"] = json!(true);
        }
        drop(overlay);
        let native = custody
            .get(network)
            .ok_or("embedded custody dependency is missing")?
            .clone();
        bridges.push(Arc::new(Bridge {
            control: control.clone(),
            network: network.into(),
            prefix,
            app,
            custody: InProcessCustodyTransport::new(network, native).map_err(str::to_string)?,
            base,
            slots: slots.clone(),
            body_cap: body_cap.min(crate::embedded_custody::MAX_CUSTODY_BODY_BYTES),
        }));
    }
    Ok(Some(Prepared {
        controller: control,
        bridges,
    }))
}

/// Merge readiness only for the exact route identity accepted by dispatch.
pub fn merge_health_outcome(
    method: &str,
    raw_url: &str,
    headers: &http::HeaderMap,
    mut outcome: crate::DispatchOutcome,
    control: &Controller,
) -> crate::DispatchOutcome {
    if matches!(
        crate::dispatch::classify_request(method, raw_url, headers),
        Ok(crate::routes::Target::Health)
    ) {
        let health = control.health();
        if health["healthy"] != Value::Bool(true) {
            outcome.status = 503;
            outcome.body["ready"] = Value::Bool(false);
        }
        outcome.body["embedded_relayer"] = health;
    }
    outcome
}

#[cfg(test)]
#[path = "../tests/unit/embedded_relayer.rs"]
mod tests;
