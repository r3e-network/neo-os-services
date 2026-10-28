//! The signer service process: read the deployment's configuration, open the
//! vault, and serve the HTTP contract of `docs/SIGNER_SERVICE.md` §5 and §5.1.
//!
//! Deliberately thin, because every decision about whether to sign lives behind
//! the guards on [`SignerService`]. Attested standalone and embedded runtimes
//! share their bootstrap and custody boundary. This binary owns its listener
//! and resolves configuration, including one thing the
//! HTTP surface must never offer: the first admin credential.
//!
//! Three rules this file keeps:
//!
//! * It writes at startup and never per request. §5.1 makes "no logging
//!   middleware at all" a contract, because an access log of a signing oracle is
//!   a second, unattributed audit trail. Nothing here installs a subscriber, and
//!   nothing here prints a request.
//! * Diagnostics go to stderr, so the one line the `provision-admin` mode puts on
//!   stdout is the only thing a shell can capture — see the help text.
//! * The data directory has no default. A guessed one lets a deployment start
//!   against an empty database, look healthy, and fail at the first signature.

use std::{
    env,
    net::{IpAddr, SocketAddr},
    path::{Path, PathBuf},
};

use anyhow::{bail, Context, Result};
use neo_signer::{
    api::{self, ApiState, DEFAULT_BODY_LIMIT, DEFAULT_MAX_IN_FLIGHT_REQUESTS},
    attestation::BootGuard,
    auth::WorkloadAuthPolicy,
    embedded::{
        EmbeddedCustodyConfig, EmbeddedCustodyRuntime, VaultProcessLease, DATABASE_FILE,
        PROCESS_LOCK_FILE,
    },
    model::CallerCapability,
    service::{provision_admin_caller, SignerService},
    signclient::{self, SignClientBridge},
    store::Store,
    vault::{MASTER_KEY_ENV, MASTER_KEY_FILE},
    vault_profile::VaultProfile,
};
use tokio::{
    net::TcpListener,
    sync::{watch, Semaphore},
};
use zeroize::Zeroizing;

/// Where the SQLite file, the audit trail and the master key file live.
const DATA_DIR_ENV: &str = "SIGNER_SERVICE_DATA_DIR";
/// Address to bind. Loopback by default, because §5 names loopback or an
/// internal network and a custody service should have to be told to listen
/// beyond the machine.
const HOST_ENV: &str = "SIGNER_SERVICE_HOST";
const PORT_ENV: &str = "SIGNER_SERVICE_PORT";
/// Ceiling on a request body, overriding [`DEFAULT_BODY_LIMIT`].
const BODY_LIMIT_ENV: &str = "SIGNER_SERVICE_MAX_BODY_BYTES";
/// Process-wide custody requests admitted before body parsing, authentication,
/// or blocking work. Health and metrics do not consume this budget.
const MAX_IN_FLIGHT_ENV: &str = "SIGNER_SERVICE_MAX_IN_FLIGHT_REQUESTS";
/// Canonical public origin committed to by every v2 workload assertion.
const WORKLOAD_AUDIENCE_ENV: &str = "SIGNER_SERVICE_WORKLOAD_AUDIENCE";
/// Temporary migration escape hatch for audience-less v1 assertions.
const ALLOW_LEGACY_WORKLOAD_V1_ENV: &str = "SIGNER_SERVICE_ALLOW_LEGACY_WORKLOAD_V1";
/// Optional official Neo SignClient gRPC bridge. The upstream protocol carries
/// no credentials, so this listener is hard-limited to loopback and internally
/// assumes exactly one caller/key binding.
const SIGNCLIENT_HOST_ENV: &str = "SIGNER_SERVICE_SIGNCLIENT_HOST";
const SIGNCLIENT_PORT_ENV: &str = "SIGNER_SERVICE_SIGNCLIENT_PORT";
const SIGNCLIENT_KEY_ID_ENV: &str = "SIGNER_SERVICE_SIGNCLIENT_KEY_ID";
const SIGNCLIENT_CALLER_TOKEN_ENV: &str = "SIGNER_SERVICE_SIGNCLIENT_CALLER_TOKEN";
/// Measured, immutable profile embedded in the enclave image. The host may not
/// supply profile fields through `/provision`.
const VAULT_PROFILE_FILE_ENV: &str = "SIGNER_SERVICE_VAULT_PROFILE_FILE";

const DEFAULT_HOST: &str = "127.0.0.1";
const DEFAULT_PORT: u16 = 8081;

#[tokio::main]
async fn main() -> Result<()> {
    let arguments: Vec<String> = env::args().skip(1).collect();
    match arguments.first().map(String::as_str) {
        Some("validate-vault-profile") => {
            anyhow::ensure!(
                arguments.len() == 3,
                "usage: validate-vault-profile <file> <mainnet|testnet>"
            );
            let identity = validate_vault_profile(Path::new(&arguments[1]), &arguments[2])?;
            println!("{}", serde_json::to_string(&identity)?);
            Ok(())
        }
        Some("provision-admin") => {
            let label = arguments
                .get(1)
                .map(String::as_str)
                .with_context(|| "provision-admin needs a label: `provision-admin <label>`")?;
            if let Some(extra) = arguments.get(2) {
                print_help();
                bail!("unexpected argument `{extra}` after the label");
            }
            provision_admin(label)
        }
        Some("serve") => {
            if let Some(extra) = arguments.get(1) {
                print_help();
                bail!("unexpected argument `{extra}`; configuration is environment-only");
            }
            serve().await
        }
        None => serve().await,
        Some("help") | Some("--help") | Some("-h") => {
            print_help();
            Ok(())
        }
        Some(command) => {
            print_help();
            bail!("unknown command `{command}`")
        }
    }
}

/// Validate public build input without touching the custody runtime.
fn validate_vault_profile(path: &Path, expected_network: &str) -> Result<serde_json::Value> {
    use sha2::{Digest, Sha256};
    anyhow::ensure!(
        matches!(expected_network, "mainnet" | "testnet"),
        "release network must be exactly mainnet or testnet"
    );
    anyhow::ensure!(
        std::fs::metadata(path)?.len() <= 65_536,
        "vault profile exceeds size limit"
    );
    let bytes = std::fs::read(path).context("failed to read public vault profile")?;
    anyhow::ensure!(bytes.len() <= 65_536, "vault profile exceeds size limit");
    let profile = VaultProfile::from_json(&bytes)?;
    anyhow::ensure!(
        profile.environment().to_string() == expected_network,
        "vault profile environment mismatch"
    );
    let coordinator = &profile.document().coordinator;
    let origin = url::Url::parse(&coordinator.origin)?;
    let Some(url::Host::Domain(authority_host)) = origin.host() else {
        bail!("custody egress requires a DNS authority hostname");
    };
    let mut destinations = std::collections::BTreeSet::new();
    destinations.insert((
        authority_host.to_string(),
        origin.port_or_known_default().unwrap_or(443),
    ));
    destinations.insert((format!("kms.{}.amazonaws.com", coordinator.aws_region), 443));
    destinations.insert((format!("s3.{}.amazonaws.com", coordinator.aws_region), 443));
    destinations.insert((
        format!(
            "{}.s3.{}.amazonaws.com",
            coordinator.snapshot_bucket, coordinator.aws_region
        ),
        443,
    ));
    let required_egress: Vec<_> = destinations
        .into_iter()
        .map(|(address, port)| serde_json::json!({ "address": address, "port": port }))
        .collect();
    Ok(serde_json::json!({
        "schema": "neoos/custody-profile-build-identity/v1",
        "environment": expected_network,
        "file_sha256": hex::encode(Sha256::digest(&bytes)),
        "profile_sha256": hex::encode(profile.profile_hash()),
        "network_set_sha256": hex::encode(profile.network_set_hash()),
        "vault_id": profile.document().vault_id,
        "root_key_version": profile.document().root_key_version,
        "root_key_commitment": profile.document().root_key_commitment,
        "required_egress": required_egress,
    }))
}

/// Mint the first admin credential; no master key or listener is opened.
fn provision_admin(label: &str) -> Result<()> {
    let config = Config::from_env()?;
    let _lease = VaultProcessLease::acquire(&config.data_dir)?;
    let repository = Store::open(config.database_path())?;
    let (caller, token) = provision_admin_caller(&repository, label)
        .with_context(|| format!("failed to provision the first admin caller labelled {label}"))?;
    eprintln!(
        "signer service: provisioned {} as caller {} (admin, whole vault) — the token is \
         shown once and stored only as a digest",
        caller.label, caller.id
    );
    println!("{token}");
    Ok(())
}

/// Bind, report what was found, and serve until a signal asks for the traffic to
/// stop.
///
/// Two boots, split by [`BootGuard`]. Host mode opens the vault from local
/// configuration exactly as before. Attested mode —
/// `SIGNER_SERVICE_ATTESTED_BOOT=require`, the enclave deployment's setting —
/// first proves the running image can answer a fresh-nonce NSM attestation
/// (which fails closed on the host, where no NSM device exists), refuses a
/// plaintext master key outright (RC2), and starts with the vault sealed: the
/// master key arrives later, over `/provision`, through the attested KMS path.
/// The authoritative PCR0 pin lives in the KMS key policy, not here — baking it
/// into the image would change the measurement it pins — so the boot guard
/// reports the measured value for the operator to check against the manifest.
async fn serve() -> Result<()> {
    neo_signer::metrics::init_metrics();
    let config = Config::from_env()?;
    let guard = BootGuard::from_env().context("invalid attested-boot configuration")?;
    let listener = TcpListener::bind(config.bind)
        .await
        .with_context(|| format!("failed to bind {}", config.bind))?;
    let bound = listener
        .local_addr()
        .context("the bound address could not be read back")?;
    let workload_auth = config.workload_auth(bound)?;
    let (router, bridge, repository, report_state, _host_lease) = match guard {
        Some(guard) => {
            anyhow::ensure!(
                !workload_auth.allows_legacy_v1(),
                "attested custody requires audience-bound v2 workload assertions"
            );
            let profile_path = config.vault_profile_file.as_deref().with_context(|| {
                format!("{VAULT_PROFILE_FILE_ENV} is required for attested boot")
            })?;
            let profile_bytes = std::fs::read(profile_path).with_context(|| {
                format!("failed to read vault profile {}", profile_path.display())
            })?;
            let profile = std::sync::Arc::new(VaultProfile::from_json(&profile_bytes)?);
            let runtime = EmbeddedCustodyRuntime::boot(
                EmbeddedCustodyConfig {
                    enrollment: None,
                    migration: neo_signer::embedded::MeasuredMigration::from_image_owned(&profile)?,
                    expected_network: profile.environment(),
                    profile,
                    data_dir: config.data_dir.clone(),
                    workload_audience: workload_auth.audience().to_string(),
                    max_body_bytes: config.max_body_bytes,
                    max_in_flight_requests: config.max_in_flight_requests,
                },
                guard,
            )?;
            eprintln!(
                "signer service: attested boot verified; measured PCR0 {} \
                 — pin this in the KMS key policy and the measurements manifest",
                runtime.measured_pcr0()
            );
            let bridge = config.signclient.as_ref().map(|signclient| {
                (
                    signclient.bind,
                    runtime.signclient_bridge(
                        signclient.key_id.clone(),
                        signclient.caller_token.as_str(),
                    ),
                )
            });
            (runtime.router(), bridge, None, None, None)
        }
        None => {
            let lease = VaultProcessLease::acquire(&config.data_dir)?;
            let repository = Store::open(config.database_path())
                .with_context(|| "failed to open the signer database")?;
            let service = SignerService::open(repository.clone(), &config.data_dir)
                .context("failed to open the vault for this data directory")?;
            let state = ApiState::new(service)
                .with_workload_auth(workload_auth.clone())
                .with_body_limit(config.max_body_bytes)
                .with_max_in_flight_requests(config.max_in_flight_requests);
            let bridge = config.signclient.as_ref().map(|signclient| {
                (
                    signclient.bind,
                    SignClientBridge::new(
                        state.clone(),
                        signclient.key_id.clone(),
                        signclient.caller_token.as_str(),
                    ),
                )
            });
            if let Some((_, bridge)) = &bridge {
                bridge
                    .preflight()
                    .await
                    .map_err(anyhow::Error::msg)
                    .context("the SignClient caller/key binding failed startup validation")?;
            }
            (
                api::router(state.clone()),
                bridge,
                Some(repository),
                Some(state),
                Some(lease),
            )
        }
    };
    report(
        repository.as_ref(),
        report_state.as_ref(),
        &config,
        &workload_auth,
        bound,
    )?;
    let (shutdown_sender, shutdown_receiver) = watch::channel(false);
    let signal_task = tokio::spawn(async move {
        shutdown_signal().await;
        let _ = shutdown_sender.send(true);
    });
    let http = async {
        axum::serve(listener, router)
            .with_graceful_shutdown(wait_for_shutdown(shutdown_receiver.clone()))
            .await
            .context("the signer HTTP service stopped serving")
    };
    let result = if let Some((grpc_bind, bridge)) = bridge {
        let grpc_shutdown = shutdown_receiver.clone();
        let grpc = async move {
            signclient::serve(grpc_bind, bridge, wait_for_shutdown(grpc_shutdown))
                .await
                .context("the SignClient gRPC service stopped serving")
        };
        tokio::try_join!(http, grpc).map(|_| ())
    } else {
        http.await
    };
    signal_task.abort();
    result
}

async fn wait_for_shutdown(mut receiver: watch::Receiver<bool>) {
    if *receiver.borrow() {
        return;
    }
    while receiver.changed().await.is_ok() {
        if *receiver.borrow_and_update() {
            return;
        }
    }
}

/// What an operator needs to see once, and what stays invisible: the fingerprint
/// identifies the master key without being derived from anything signable, and
/// the counts say whether this directory is the vault they meant to open. In
/// attested mode the vault is sealed at this point — the fingerprint does not
/// exist yet, and saying so beats printing a placeholder. The measured-PCR0
/// line already went to stderr in `serve`, so nothing about the guard repeats
/// here.
fn report(
    repository: Option<&Store>,
    state: Option<&ApiState>,
    config: &Config,
    workload_auth: &WorkloadAuthPolicy,
    bound: SocketAddr,
) -> Result<()> {
    eprintln!("signer service: listening on {bound}");
    let admins = if let (Some(service), Some(repository)) =
        (state.and_then(ApiState::service_snapshot), repository)
    {
        let keys = repository
            .list_signer_keys()
            .context("failed to read the custody keys at startup")?;
        let callers = repository
            .list_signer_callers()
            .context("failed to read the caller table at startup")?;
        eprintln!(
            "signer service: vault {} keys={} callers={} database={}",
            service.vault_fingerprint(),
            keys.len(),
            callers.len(),
            config.database_path().display()
        );
        callers
            .iter()
            .filter(|caller| caller.has_capability(CallerCapability::Admin))
            .count()
    } else {
        eprintln!(
            "signer service: vault SEALED database={} — waiting for remote HEAD verification, \
             fenced takeover and /provision recovery; local state has not been opened",
            config.database_path().display()
        );
        usize::MAX
    };
    if admins == 0 {
        eprintln!(
            "signer service: no admin caller exists, so the management API has nothing to \
             authenticate against yet — run `provision-admin <label>` against {} once",
            config.data_dir.display()
        );
    }
    if !bound.ip().is_loopback() {
        eprintln!(
            "signer service: note the listener is reachable off this machine; §5 assumes an \
             internal network or a TLS-terminating proxy, and `Origin` pinning on a caller is \
             the only browser-side check in between"
        );
    }
    eprintln!(
        "signer service: workload audience {} (protocol neoos-workload-v2)",
        workload_auth.audience()
    );
    if workload_auth.allows_legacy_v1() {
        eprintln!(
            "signer service: WARNING audience-less neoos-workload-v1 compatibility is enabled; \
             disable {ALLOW_LEGACY_WORKLOAD_V1_ENV} after all callers migrate"
        );
    }
    if let Some(signclient) = &config.signclient {
        eprintln!(
            "signer service: official Neo SignClient bridge on {} for key {} (loopback only)",
            signclient.bind, signclient.key_id
        );
    }
    Ok(())
}

/// Stop accepting connections and let the in-flight requests finish. A signature
/// half-written to a socket is a caller that retries blind, so draining is the
/// only acceptable way to end.
async fn shutdown_signal() {
    let reason = neo_os_service_runtime::shutdown_signal().await;
    eprintln!("signer service: {reason}");
}

/// The deployment configuration resolved before the listener is opened.
struct Config {
    data_dir: PathBuf,
    vault_profile_file: Option<PathBuf>,
    bind: SocketAddr,
    workload_audience: Option<String>,
    allow_legacy_workload_v1: bool,
    max_body_bytes: usize,
    max_in_flight_requests: usize,
    signclient: Option<SignClientConfig>,
}

struct SignClientConfig {
    bind: SocketAddr,
    key_id: String,
    caller_token: Zeroizing<String>,
}

impl Config {
    fn from_env() -> Result<Self> {
        let data_dir = env::var_os(DATA_DIR_ENV)
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .with_context(|| {
                format!(
                    "{DATA_DIR_ENV} must name the directory holding the vault; there is no \
                     default because a guessed one would let a deployment start against an \
                     empty database and find out only at the first signature"
                )
            })?;
        let host: IpAddr = environment_or(HOST_ENV, DEFAULT_HOST)
            .parse()
            .with_context(|| format!("{HOST_ENV} must be an IP literal such as {DEFAULT_HOST}"))?;
        let port: u16 = environment_or(PORT_ENV, &DEFAULT_PORT.to_string())
            .parse()
            .with_context(|| format!("{PORT_ENV} must be a port number"))?;
        let bind = SocketAddr::new(host, port);
        let workload_audience = env::var(WORKLOAD_AUDIENCE_ENV)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let allow_legacy_v1 = parse_strict_bool(
            ALLOW_LEGACY_WORKLOAD_V1_ENV,
            &environment_or(ALLOW_LEGACY_WORKLOAD_V1_ENV, "false"),
        )?;
        let max_body_bytes: usize = environment_or(BODY_LIMIT_ENV, &DEFAULT_BODY_LIMIT.to_string())
            .parse::<usize>()
            .ok()
            .filter(|limit| *limit > 0)
            .with_context(|| format!("{BODY_LIMIT_ENV} must be a positive byte count"))?;
        let max_in_flight_requests = parse_max_in_flight_requests(&environment_or(
            MAX_IN_FLIGHT_ENV,
            &DEFAULT_MAX_IN_FLIGHT_REQUESTS.to_string(),
        ))?;
        let signclient = parse_signclient_config(bind)?;
        let vault_profile_file = env::var_os(VAULT_PROFILE_FILE_ENV)
            .filter(|value| !value.is_empty())
            .map(PathBuf::from);
        Ok(Config {
            data_dir,
            vault_profile_file,
            bind,
            workload_audience,
            allow_legacy_workload_v1: allow_legacy_v1,
            max_body_bytes,
            max_in_flight_requests,
            signclient,
        })
    }

    fn database_path(&self) -> PathBuf {
        self.data_dir.join(DATABASE_FILE)
    }

    fn workload_auth(&self, bound: SocketAddr) -> Result<WorkloadAuthPolicy> {
        let audience = match self.workload_audience.as_deref() {
            Some(audience) => audience.to_string(),
            None if !bound.ip().is_unspecified() => format!("http://{bound}"),
            None => bail!(
                "{WORKLOAD_AUDIENCE_ENV} is required when {HOST_ENV} is an unspecified bind \
                 address; workload proofs must name the public signer origin, not 0.0.0.0 or ::"
            ),
        };
        WorkloadAuthPolicy::new(&audience, self.allow_legacy_workload_v1)
            .map_err(anyhow::Error::msg)
            .with_context(|| {
                format!("{WORKLOAD_AUDIENCE_ENV} must be one canonical HTTP(S) origin with no path")
            })
    }
}

fn parse_signclient_config(http_bind: SocketAddr) -> Result<Option<SignClientConfig>> {
    signclient_config_from_values(
        http_bind,
        configured(SIGNCLIENT_HOST_ENV),
        configured(SIGNCLIENT_PORT_ENV),
        configured(SIGNCLIENT_KEY_ID_ENV),
        configured(SIGNCLIENT_CALLER_TOKEN_ENV),
    )
}

fn signclient_config_from_values(
    http_bind: SocketAddr,
    configured_host: Option<String>,
    configured_port: Option<String>,
    configured_key: Option<String>,
    configured_token: Option<String>,
) -> Result<Option<SignClientConfig>> {
    if configured_host.is_none()
        && configured_port.is_none()
        && configured_key.is_none()
        && configured_token.is_none()
    {
        return Ok(None);
    }
    let port: u16 = configured_port
        .with_context(|| {
            format!(
                "{SIGNCLIENT_PORT_ENV}, {SIGNCLIENT_KEY_ID_ENV} and \
                 {SIGNCLIENT_CALLER_TOKEN_ENV} must be set together"
            )
        })?
        .parse()
        .ok()
        .filter(|port| *port != 0)
        .with_context(|| format!("{SIGNCLIENT_PORT_ENV} must be a non-zero port number"))?;
    let key_id = configured_key.with_context(|| {
        format!(
            "{SIGNCLIENT_PORT_ENV}, {SIGNCLIENT_KEY_ID_ENV} and \
             {SIGNCLIENT_CALLER_TOKEN_ENV} must be set together"
        )
    })?;
    let caller_token = configured_token.with_context(|| {
        format!(
            "{SIGNCLIENT_PORT_ENV}, {SIGNCLIENT_KEY_ID_ENV} and \
             {SIGNCLIENT_CALLER_TOKEN_ENV} must be set together"
        )
    })?;
    let host: IpAddr = configured_host
        .unwrap_or_else(|| DEFAULT_HOST.to_string())
        .parse()
        .with_context(|| {
            format!("{SIGNCLIENT_HOST_ENV} must be a loopback IP such as {DEFAULT_HOST}")
        })?;
    if !host.is_loopback() {
        bail!(
            "{SIGNCLIENT_HOST_ENV} must be loopback because the official SignClient protocol \
             has no transport authentication"
        );
    }
    let bind = SocketAddr::new(host, port);
    if bind == http_bind || (bind.port() == http_bind.port() && http_bind.ip().is_unspecified()) {
        bail!("the SignClient and HTTP listeners cannot use the same address {bind}");
    }
    Ok(Some(SignClientConfig {
        bind,
        key_id,
        caller_token: Zeroizing::new(caller_token),
    }))
}

/// Parse only counts Tokio's semaphore can represent. Keeping this validation
/// in configuration turns an out-of-range operator value into a startup error
/// rather than a panic in `Semaphore::new` after the vault has been opened.
fn parse_max_in_flight_requests(raw: &str) -> Result<usize> {
    raw.parse::<usize>()
        .ok()
        .filter(|limit| (1..=Semaphore::MAX_PERMITS).contains(limit))
        .with_context(|| {
            format!(
                "{MAX_IN_FLIGHT_ENV} must be between 1 and {}",
                Semaphore::MAX_PERMITS
            )
        })
}

fn parse_strict_bool(name: &str, raw: &str) -> Result<bool> {
    match raw {
        "true" => Ok(true),
        "false" => Ok(false),
        _ => bail!("{name} must be exactly `true` or `false`"),
    }
}

/// An environment value, or the default when the name is unset or empty.
fn environment_or(name: &str, default: &str) -> String {
    configured_or(env::var(name).ok(), default)
}

fn configured(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// An empty value counting as unset is what lets a compose file render
/// `SIGNER_SERVICE_HOST=` without the service refusing to start.
fn configured_or(raw: Option<String>, default: &str) -> String {
    raw.map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| default.to_string())
}

fn print_help() {
    eprintln!("{}", help_text());
}

/// The whole operator-facing contract of this process, in one string: the tests
/// check it against the constants the code actually reads, because a help line
/// naming a variable the service never looks at is worse than no help line.
fn help_text() -> String {
    let attested_boot_env = neo_signer::attestation::ATTESTED_BOOT_ENV;
    let expected_pcr0_env = neo_signer::attestation::EXPECTED_PCR0_ENV;
    format!(
        "signer service — Neo N3 and NeoX key custody with per-key signing boundaries

Usage:
  signer_service [serve]                serve the API in docs/SIGNER_SERVICE.md §5, §5.1
  signer_service provision-admin <label>
                                        mint the first admin credential for a data
                                        directory. The token goes to stdout once and
                                        everything else goes to stderr, so it can be
                                        piped straight into a secret manager. There is
                                        no HTTP route for this and there must never be
                                        one.
  signer_service help                   this text
  signer_service validate-vault-profile <file> <mainnet|testnet>
                                        validate public build configuration only;
                                        no NSM, KMS, database or listener access

Environment:
  {DATA_DIR_ENV:<31}required: holds {DATABASE_FILE}, {PROCESS_LOCK_FILE}
                                 and the master key
  {HOST_ENV:<31}bind address, default {DEFAULT_HOST}
  {PORT_ENV:<31}bind port, default {DEFAULT_PORT}
  {BODY_LIMIT_ENV:<31}request body ceiling, default {DEFAULT_BODY_LIMIT}
  {MAX_IN_FLIGHT_ENV:<31}custody request concurrency, default {DEFAULT_MAX_IN_FLIGHT_REQUESTS};
                                 excess requests receive 503 + Retry-After
  {VAULT_PROFILE_FILE_ENV:<31}required for attested boot: measured immutable vault profile
  {WORKLOAD_AUDIENCE_ENV:<31}canonical public signer origin committed to by
                                 neoos-workload-v2; defaults to the concrete bind origin
  {ALLOW_LEGACY_WORKLOAD_V1_ENV:<31}exactly true or false, default false; temporary
                                 compatibility for audience-less v1 assertions
  {SIGNCLIENT_HOST_ENV:<31}optional SignClient gRPC loopback host, default {DEFAULT_HOST}
  {SIGNCLIENT_PORT_ENV:<31}enables the official Neo SignClient gRPC bridge
  {SIGNCLIENT_KEY_ID_ENV:<31}single Neo N3 custody key exposed by that bridge
  {SIGNCLIENT_CALLER_TOKEN_ENV:<31}internal sign-capable caller token; never sent over gRPC
  {MASTER_KEY_ENV:<31}64 hex characters or a passphrase; without it
                                 the vault creates <data_dir>/{MASTER_KEY_FILE}
                                 on first start (see src/vault.rs). Refused at
                                 boot in an attested deployment.
  {attested_boot_env:<31}exactly `require` inside the enclave: answer a
                                 fresh-nonce NSM attestation before serving
                                 (fails closed on the host) and start with the
                                 vault sealed for /provision
  {expected_pcr0_env:<31}optional 96-hex pin; when set the boot guard
                                 refuses a different measured PCR0. The
                                 authoritative pin lives in the KMS key
                                 policy, since baking it into the image
                                 would change the measurement it pins"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_help_text_names_every_configuration_surface() {
        let help = help_text();
        for name in [
            DATA_DIR_ENV,
            HOST_ENV,
            PORT_ENV,
            BODY_LIMIT_ENV,
            MAX_IN_FLIGHT_ENV,
            VAULT_PROFILE_FILE_ENV,
            WORKLOAD_AUDIENCE_ENV,
            ALLOW_LEGACY_WORKLOAD_V1_ENV,
            SIGNCLIENT_HOST_ENV,
            SIGNCLIENT_PORT_ENV,
            SIGNCLIENT_KEY_ID_ENV,
            SIGNCLIENT_CALLER_TOKEN_ENV,
            MASTER_KEY_ENV,
            neo_signer::attestation::ATTESTED_BOOT_ENV,
            neo_signer::attestation::EXPECTED_PCR0_ENV,
        ] {
            assert!(help.contains(name), "{name} is missing from the help text");
        }
        for file in [DATABASE_FILE, MASTER_KEY_FILE, PROCESS_LOCK_FILE] {
            assert!(help.contains(file), "{file} is missing from the help text");
        }
        assert!(help.contains("provision-admin"));
    }

    #[test]
    fn a_blank_environment_value_is_the_default() {
        assert_eq!(configured_or(None, "8081"), "8081");
        assert_eq!(configured_or(Some(String::new()), "8081"), "8081");
        assert_eq!(configured_or(Some("  ".to_string()), "8081"), "8081");
        assert_eq!(configured_or(Some(" 9000 ".to_string()), "8081"), "9000");
    }

    #[test]
    fn the_in_flight_budget_stays_within_tokios_representable_range() {
        assert_eq!(
            parse_max_in_flight_requests(&Semaphore::MAX_PERMITS.to_string())
                .expect("the semaphore maximum is representable"),
            Semaphore::MAX_PERMITS
        );
        let above_maximum = Semaphore::MAX_PERMITS
            .checked_add(1)
            .expect("Tokio's semaphore maximum leaves room in usize");
        assert!(parse_max_in_flight_requests(&above_maximum.to_string()).is_err());
        assert!(parse_max_in_flight_requests("0").is_err());
        assert!(parse_max_in_flight_requests("not-a-number").is_err());
    }

    #[test]
    fn the_legacy_workload_switch_is_explicit() {
        assert!(parse_strict_bool("TEST", "true").unwrap());
        assert!(!parse_strict_bool("TEST", "false").unwrap());
        for value in ["1", "yes", "TRUE", " true ", ""] {
            assert!(parse_strict_bool("TEST", value).is_err(), "{value:?}");
        }
    }

    #[test]
    fn the_credentialless_signclient_protocol_is_loopback_and_all_or_nothing() {
        let http = "127.0.0.1:8081".parse().unwrap();
        assert!(signclient_config_from_values(http, None, None, None, None)
            .unwrap()
            .is_none());
        assert!(signclient_config_from_values(
            http,
            None,
            Some("9991".to_string()),
            Some("key-one".to_string()),
            Some("token-one".to_string()),
        )
        .unwrap()
        .is_some());
        assert!(signclient_config_from_values(
            http,
            Some("0.0.0.0".to_string()),
            Some("9991".to_string()),
            Some("key-one".to_string()),
            Some("token-one".to_string()),
        )
        .is_err());
        assert!(signclient_config_from_values(
            http,
            None,
            Some("9991".to_string()),
            Some("key-one".to_string()),
            None,
        )
        .is_err());
        assert!(signclient_config_from_values(
            http,
            None,
            Some("8081".to_string()),
            Some("key-one".to_string()),
            Some("token-one".to_string()),
        )
        .is_err());
    }

    #[test]
    fn one_data_directory_can_have_only_one_live_process() -> Result<()> {
        let directory = tempfile::tempdir()?;
        let first = VaultProcessLease::acquire(directory.path())?;
        let second = VaultProcessLease::acquire(directory.path());
        assert!(second
            .expect_err("a second lease must be refused")
            .to_string()
            .contains("already in use"));
        drop(first);
        VaultProcessLease::acquire(directory.path())?;
        Ok(())
    }
}
