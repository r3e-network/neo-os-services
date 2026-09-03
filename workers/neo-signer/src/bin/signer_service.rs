//! The signer service process: read the deployment's configuration, open the
//! vault, and serve the HTTP contract of `docs/SIGNER_SERVICE.md` §5 and §5.1.
//!
//! Deliberately thin, because every decision about whether to sign lives behind
//! the guards on [`SignerService`] — which is the whole reason custody is a
//! separate process rather than a module. What is here is the two things only a
//! process can do (hold a listener, resolve a data directory) and one thing the
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
    fs::{File, OpenOptions},
    net::{IpAddr, SocketAddr},
    path::{Path, PathBuf},
};

use anyhow::{bail, Context, Result};
use fs2::FileExt;
use neo_signer::{
    api::{self, ApiState, DEFAULT_BODY_LIMIT},
    attestation::BootGuard,
    model::CallerCapability,
    provision,
    service::{provision_admin_caller, SignerService},
    store::Store,
    vault::{MASTER_KEY_ENV, MASTER_KEY_FILE},
};
use nitro_attest::release::NsmAttestation;
use tokio::net::TcpListener;

/// Where the SQLite file, the audit trail and the master key file live.
const DATA_DIR_ENV: &str = "SIGNER_SERVICE_DATA_DIR";
/// Address to bind. Loopback by default, because §5 names loopback or an
/// internal network and a custody service should have to be told to listen
/// beyond the machine.
const HOST_ENV: &str = "SIGNER_SERVICE_HOST";
const PORT_ENV: &str = "SIGNER_SERVICE_PORT";
/// Ceiling on a request body, overriding [`DEFAULT_BODY_LIMIT`].
const BODY_LIMIT_ENV: &str = "SIGNER_SERVICE_MAX_BODY_BYTES";
/// Name of the one database file inside the data directory. Fixed rather than
/// configurable: a deployment that points two signer processes at two names in
/// one directory has two vaults and no error to tell it so.
const DATABASE_FILE: &str = "signer.db";
/// Advisory OS lock held for the whole process lifetime.
const PROCESS_LOCK_FILE: &str = "signer.lock";

const DEFAULT_HOST: &str = "127.0.0.1";
const DEFAULT_PORT: u16 = 8081;

#[tokio::main]
async fn main() -> Result<()> {
    let arguments: Vec<String> = env::args().skip(1).collect();
    match arguments.first().map(String::as_str) {
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

/// Mint the first admin credential against a data directory.
///
/// The argv form of the library call that §5.1 keeps unreachable over HTTP. It
/// opens the database and nothing else: no master key, no listener, and no
/// second one once an `admin` caller exists — `provision_admin_caller` refuses
/// that, so a rerun is a visible error rather than a second superuser.
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
    let _lease = VaultProcessLease::acquire(&config.data_dir)?;
    let guard = BootGuard::from_env().context("invalid attested-boot configuration")?;
    let repository = Store::open(config.database_path())
        .with_context(|| "failed to open the signer database")?;
    let state = match &guard {
        Some(guard) => {
            refuse_plaintext_master_key_at_boot()?;
            let measured_pcr0 = guard
                .verify(&NsmAttestation)
                .map_err(|error| anyhow::anyhow!("attested boot refused: {error}"))?;
            eprintln!(
                "signer service: attested boot verified; measured PCR0 {measured_pcr0} \
                 — pin this in the KMS key policy and the measurements manifest"
            );
            ApiState::attested_pending(
                repository.clone(),
                config.data_dir.clone(),
                std::sync::Arc::new(provision::release_envelope),
            )
            .with_body_limit(config.max_body_bytes)
        }
        None => {
            let service = SignerService::open(repository.clone(), &config.data_dir)
                .context("failed to open the vault for this data directory")?;
            ApiState::new(service).with_body_limit(config.max_body_bytes)
        }
    };

    let listener = TcpListener::bind(config.bind)
        .await
        .with_context(|| format!("failed to bind {}", config.bind))?;
    let bound = listener
        .local_addr()
        .context("the bound address could not be read back")?;

    report(&repository, &state, &config, bound)?;
    axum::serve(listener, api::router(state))
        .with_graceful_shutdown(shutdown_signal())
        .await
        .context("the signer service stopped serving")?;
    Ok(())
}

/// Exclusive operating-system lease for one signer data directory.
///
/// SQLite protects individual transactions, but the rolling-window decision
/// spans policy evaluation, signing and the final transaction. Refusing a
/// second process is therefore part of the policy boundary, not deployment
/// advice. The file remains on disk for diagnostics; the OS releases its lock
/// when the process exits or crashes.
#[derive(Debug)]
struct VaultProcessLease {
    _file: File,
}

impl VaultProcessLease {
    fn acquire(data_dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(data_dir).with_context(|| {
            format!(
                "failed to create signer data directory {}",
                data_dir.display()
            )
        })?;
        let path = data_dir.join(PROCESS_LOCK_FILE);
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&path)
            .with_context(|| format!("failed to open signer process lock {}", path.display()))?;
        file.try_lock_exclusive().with_context(|| {
            format!(
                "signer data directory {} is already in use by another signer process",
                data_dir.display()
            )
        })?;
        Ok(Self { _file: file })
    }
}

/// RC2 at the process boundary: a plaintext master key that made it into an
/// attested deployment's environment is a configuration the enclave refuses to
/// start with. The release path (`/provision`) refuses it too; two locked
/// doors in front of the one downgrade that would put the whole vault back on
/// the host.
fn refuse_plaintext_master_key_at_boot() -> Result<()> {
    let supplied = env::var(MASTER_KEY_ENV)
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false);
    if supplied {
        bail!(
            "{MASTER_KEY_ENV} is set in an attested deployment; the master key is released \
             through /provision by the attested KMS path or it does not exist"
        );
    }
    Ok(())
}

/// What an operator needs to see once, and what stays invisible: the fingerprint
/// identifies the master key without being derived from anything signable, and
/// the counts say whether this directory is the vault they meant to open. In
/// attested mode the vault is sealed at this point — the fingerprint does not
/// exist yet, and saying so beats printing a placeholder. The measured-PCR0
/// line already went to stderr in `serve`, so nothing about the guard repeats
/// here.
fn report(repository: &Store, state: &ApiState, config: &Config, bound: SocketAddr) -> Result<()> {
    let keys = repository
        .list_signer_keys()
        .context("failed to read the custody keys at startup")?;
    let callers = repository
        .list_signer_callers()
        .context("failed to read the caller table at startup")?;
    let admins = callers
        .iter()
        .filter(|caller| caller.has_capability(CallerCapability::Admin))
        .count();
    eprintln!("signer service: listening on {bound}");
    match state.service_snapshot() {
        Some(service) => eprintln!(
            "signer service: vault {} keys={} callers={} database={}",
            service.vault_fingerprint(),
            keys.len(),
            callers.len(),
            config.database_path().display()
        ),
        None => eprintln!(
            "signer service: vault SEALED keys={} callers={} database={} — waiting for \
             /provision; every custody route answers signer-not-provisioned until it succeeds",
            keys.len(),
            callers.len(),
            config.database_path().display()
        ),
    }
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
    Ok(())
}

/// Stop accepting connections and let the in-flight requests finish. A signature
/// half-written to a socket is a caller that retries blind, so draining is the
/// only acceptable way to end.
async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        match signal(SignalKind::terminate()) {
            Ok(mut terminate) => {
                tokio::select! {
                    _ = tokio::signal::ctrl_c() => eprintln!("signer service: interrupted"),
                    _ = terminate.recv() => eprintln!("signer service: terminating"),
                }
                return;
            }
            Err(error) => eprintln!("signer service: no SIGTERM handler ({error}); Ctrl-C only"),
        }
    }
    if tokio::signal::ctrl_c().await.is_err() {
        eprintln!("signer service: the interrupt handler could not be installed");
    } else {
        eprintln!("signer service: interrupted");
    }
}

/// The whole deployment configuration, which is four names in the environment.
struct Config {
    data_dir: PathBuf,
    bind: SocketAddr,
    max_body_bytes: usize,
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
        let max_body_bytes: usize = environment_or(BODY_LIMIT_ENV, &DEFAULT_BODY_LIMIT.to_string())
            .parse::<usize>()
            .ok()
            .filter(|limit| *limit > 0)
            .with_context(|| format!("{BODY_LIMIT_ENV} must be a positive byte count"))?;
        Ok(Config {
            data_dir,
            bind: SocketAddr::new(host, port),
            max_body_bytes,
        })
    }

    fn database_path(&self) -> PathBuf {
        self.data_dir.join(DATABASE_FILE)
    }
}

/// An environment value, or the default when the name is unset or empty.
fn environment_or(name: &str, default: &str) -> String {
    configured_or(env::var(name).ok(), default)
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
        "signer service — Neo N3 key custody with per-key signing boundaries

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

Environment:
  {DATA_DIR_ENV:<31}required: holds {DATABASE_FILE}, {PROCESS_LOCK_FILE}
                                 and the master key
  {HOST_ENV:<31}bind address, default {DEFAULT_HOST}
  {PORT_ENV:<31}bind port, default {DEFAULT_PORT}
  {BODY_LIMIT_ENV:<31}request body ceiling, default {DEFAULT_BODY_LIMIT}
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
