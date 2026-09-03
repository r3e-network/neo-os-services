//! nitro-init — the in-enclave boot supervisor.
//!
//! Both Morpheus EIFs measured the same POSIX shell as PID 1
//! (`entrypoint-enclave.sh`, `entrypoint-custody.sh`, since retired from
//! `deploy/nitro/` and recoverable from git history): bring
//! loopback up, export the egress proxy, start the two socat bridges, wait
//! for the server's loopback listener before opening the vsock door, then
//! fail-stop the enclave if any of the three dies. That shell was the last
//! first-party code inside the TEE, so it is Rust now, which buys three
//! things the shell could not:
//!
//!   * the boot plan is built and validated before anything is spawned — a
//!     malformed port is an error that names itself instead of a socat argv
//!     full of garbage,
//!   * readiness is a real TCP connect with a timeout, not a spawned probe,
//!   * teardown is `kill()` on handles this process holds, not `/proc` polls
//!     on pids it does not own.
//!
//! What stays third-party, deliberately: `socat` (the AF_VSOCK endpoints —
//! binding vsock in-process would mean a Linux-only socket layer here, and the
//! bridges are the digest-pinned distro binary the PCRs already attest) and
//! `ip` from iproute2. Neither is code this repository owns.
//!
//! The role comes from argv, so one binary serves both images:
//! `nitro_init frontier` fronts the enclave host, `nitro_init custody` fronts
//! the custody service.

use std::net::TcpStream;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

/// Loopback is the only thing the bridges and the server speak; it is never
/// published over vsock.
pub const INTERNAL_HOST: &str = "127.0.0.1";

const DEFAULT_VSOCK_PORT: u16 = 8787;
const DEFAULT_INTERNAL_PORT: u16 = 8081;
const DEFAULT_HOST_CID: u32 = 3;
const DEFAULT_EGRESS_VSOCK_PORT: u16 = 8788;
const DEFAULT_PROXY_PORT: u16 = 3128;

/// The shell probed 120 times half a second apart; the budget is kept so a
/// slow-to-bind attested boot still gets the same 60s grace.
pub const READINESS_ATTEMPTS: u32 = 120;
pub const READINESS_INTERVAL: Duration = Duration::from_millis(500);
pub const READINESS_CONNECT_TIMEOUT: Duration = Duration::from_millis(2_000);
/// Fail-stop poll. The shell slept a second; a quarter-second only makes the
/// teardown snappier.
pub const WATCH_INTERVAL: Duration = Duration::from_millis(250);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    /// The oracle frontier: `enclave_host`.
    Frontier,
    /// The custody signing plane: `signer_service serve`.
    Custody,
}

impl Role {
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim() {
            "frontier" => Some(Role::Frontier),
            "custody" => Some(Role::Custody),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Role::Frontier => "frontier",
            Role::Custody => "custody",
        }
    }

    fn server_program(self) -> &'static str {
        match self {
            Role::Frontier => "/app/bin/enclave_host",
            Role::Custody => "/app/bin/signer_service",
        }
    }

    fn server_args(self) -> Vec<String> {
        match self {
            Role::Frontier => Vec::new(),
            Role::Custody => vec!["serve".to_string()],
        }
    }

    fn server_label(self) -> &'static str {
        match self {
            Role::Frontier => "enclave_host",
            Role::Custody => "signer_service",
        }
    }

    /// Which env key the image uses to move the internal listener port.
    fn internal_port_key(self) -> &'static str {
        match self {
            Role::Frontier => "ENCLAVE_INTERNAL_PORT",
            Role::Custody => "SIGNER_SERVICE_PORT",
        }
    }

    /// The server's own extra env. The frontier takes its bind address the way
    /// the entrypoint passed it (`ENCLAVE_HOST`/`PORT`); custody reads
    /// `SIGNER_SERVICE_PORT` from the inherited environment, so it gets
    /// nothing extra — the same split the shell had.
    fn server_env(self, port: u16) -> Vec<(String, String)> {
        match self {
            Role::Frontier => vec![
                ("ENCLAVE_HOST".to_string(), INTERNAL_HOST.to_string()),
                ("PORT".to_string(), port.to_string()),
            ],
            Role::Custody => Vec::new(),
        }
    }
}

/// One child process this supervisor owns.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SpawnSpec {
    pub label: &'static str,
    pub program: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

impl SpawnSpec {
    /// Spawn without capturing stdio: every child's logs are the enclave
    /// console, exactly as under the shell.
    pub fn spawn(&self) -> Result<Child, String> {
        Command::new(&self.program)
            .args(&self.args)
            .envs(self.env.clone())
            .stdin(Stdio::null())
            .spawn()
            .map_err(|error| format!("{} `{}` failed to start: {error}", self.label, self.program))
    }

    /// Run to completion (the `ip link` step). Blocking is right here: it
    /// returns as soon as the interface is up, and nothing may bind loopback
    /// before it.
    pub fn run(&self) -> Result<(), String> {
        let output = Command::new(&self.program)
            .args(&self.args)
            .stdin(Stdio::null())
            .output()
            .map_err(|error| format!("{} `{}` could not run: {error}", self.label, self.program))?;
        if output.status.success() {
            Ok(())
        } else {
            Err(format!("{} exited {}", self.label, output.status))
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Readiness {
    pub port: u16,
    pub attempts: u32,
    pub interval: Duration,
    pub connect_timeout: Duration,
}

impl Readiness {
    fn probe(&self) -> std::io::Result<TcpStream> {
        let host = INTERNAL_HOST
            .parse()
            .expect("the loopback literal is a valid address");
        TcpStream::connect_timeout(
            &std::net::SocketAddr::new(host, self.port),
            self.connect_timeout,
        )
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BootPlan {
    pub loopback: SpawnSpec,
    pub egress: SpawnSpec,
    pub vsock: SpawnSpec,
    pub server: SpawnSpec,
    pub readiness: Readiness,
    pub role: Role,
    pub vsock_port: u16,
}

/// The env seam: `None` for "not set". `std::env::var`'s `Err` and an
/// empty-but-set value are the same thing to a boot plan, so callers pass a
/// lookup and empty strings are treated as unset everywhere below.
fn trimmed<F: Fn(&str) -> Option<String>>(lookup: &F, key: &str) -> String {
    lookup(key)
        .map(|value| value.trim().to_string())
        .unwrap_or_default()
}

fn port<F: Fn(&str) -> Option<String>>(lookup: &F, key: &str, default: u16) -> Result<u16, String> {
    let raw = trimmed(lookup, key);
    if raw.is_empty() {
        return Ok(default);
    }
    raw.parse::<u16>()
        .map_err(|_| format!("{key} is not a port number: {raw}"))
}

fn instance_id<F: Fn(&str) -> Option<String>>(
    lookup: &F,
    key: &str,
    default: u32,
) -> Result<u32, String> {
    let raw = trimmed(lookup, key);
    if raw.is_empty() {
        return Ok(default);
    }
    raw.parse::<u32>()
        .map_err(|_| format!("{key} is not a vsock instance id: {raw}"))
}

/// The egress proxy wiring every child inherits: reqwest (in the frontier and
/// in nitro-attest) reads the standard proxy names, and loopback must be
/// excluded so the bridges' own traffic does not loop through the proxy.
pub fn proxy_env(proxy_port: u16) -> Vec<(String, String)> {
    let url = format!("http://{INTERNAL_HOST}:{proxy_port}");
    let loopback = format!("{INTERNAL_HOST},localhost,::1");
    vec![
        ("HTTPS_PROXY".to_string(), url.clone()),
        ("HTTP_PROXY".to_string(), url.clone()),
        ("https_proxy".to_string(), url.clone()),
        ("http_proxy".to_string(), url.clone()),
        ("NO_PROXY".to_string(), loopback.clone()),
        ("no_proxy".to_string(), loopback),
    ]
}

pub fn build_plan<F>(role: Role, lookup: F) -> Result<BootPlan, String>
where
    F: Fn(&str) -> Option<String>,
{
    let vsock_port = port(&lookup, "NITRO_SIGNER_VSOCK_PORT", DEFAULT_VSOCK_PORT)?;
    let internal_port = port(&lookup, role.internal_port_key(), DEFAULT_INTERNAL_PORT)?;
    let host_cid = instance_id(&lookup, "ENCLAVE_HOST_CID", DEFAULT_HOST_CID)?;
    let egress_vsock_port = port(
        &lookup,
        "ENCLAVE_EGRESS_VSOCK_PORT",
        DEFAULT_EGRESS_VSOCK_PORT,
    )?;
    let proxy_port = port(&lookup, "ENCLAVE_PROXY_PORT", DEFAULT_PROXY_PORT)?;

    let bridge = {
        let raw = trimmed(&lookup, "NITRO_INIT_BRIDGE_BIN");
        if raw.is_empty() {
            "socat".to_string()
        } else {
            raw
        }
    };
    let env = proxy_env(proxy_port);

    let loopback = SpawnSpec {
        label: "loopback bring-up",
        program: {
            let raw = trimmed(&lookup, "NITRO_INIT_IP_BIN");
            if raw.is_empty() {
                "ip".to_string()
            } else {
                raw
            }
        },
        args: vec![
            "link".into(),
            "set".into(),
            "dev".into(),
            "lo".into(),
            "up".into(),
        ],
        env: Vec::new(),
    };

    let egress = SpawnSpec {
        label: "egress bridge",
        program: bridge.clone(),
        args: vec![
            format!("TCP-LISTEN:{proxy_port},fork,reuseaddr,bind={INTERNAL_HOST}"),
            format!("VSOCK-CONNECT:{host_cid}:{egress_vsock_port}"),
        ],
        env: env.clone(),
    };

    let server_program = {
        let raw = trimmed(&lookup, "NITRO_INIT_SERVER_BIN");
        if raw.is_empty() {
            role.server_program().to_string()
        } else {
            raw
        }
    };
    let server_args = match lookup("NITRO_INIT_SERVER_ARGS") {
        Some(raw) => raw
            .split_whitespace()
            .map(|value| value.to_string())
            .collect(),
        None => role.server_args(),
    };
    let server = SpawnSpec {
        label: role.server_label(),
        program: server_program,
        args: server_args,
        env: env
            .clone()
            .into_iter()
            .chain(role.server_env(internal_port))
            .collect(),
    };

    let vsock = SpawnSpec {
        label: "vsock bridge",
        program: bridge,
        args: vec![
            format!("VSOCK-LISTEN:{vsock_port},fork,reuseaddr"),
            format!("TCP-CONNECT:{INTERNAL_HOST}:{internal_port}"),
        ],
        env,
    };

    Ok(BootPlan {
        loopback,
        egress,
        vsock,
        server,
        readiness: Readiness {
            port: internal_port,
            attempts: READINESS_ATTEMPTS,
            interval: READINESS_INTERVAL,
            connect_timeout: READINESS_CONNECT_TIMEOUT,
        },
        role,
        vsock_port,
    })
}

/// A child under the fail-stop watch, named so a death can be reported.
pub struct Watched {
    pub label: &'static str,
    pub child: Child,
}

/// Gate the vsock door on the server's own listener: an inbound request must
/// never race the boot. A server that dies first is reported as itself, so
/// the console says why the enclave came down.
pub fn wait_for_ready(
    readiness: &Readiness,
    server: &mut Child,
    label: &str,
) -> Result<(), String> {
    let deadline_attempts = readiness.attempts.max(1);
    for _ in 0..deadline_attempts {
        match server.try_wait() {
            Ok(Some(status)) => {
                return Err(format!("{label} exited before becoming ready ({status})"))
            }
            Ok(None) => {}
            Err(error) => return Err(format!("{label} could not be watched: {error}")),
        }
        if readiness.probe().is_ok() {
            return Ok(());
        }
        std::thread::sleep(readiness.interval);
    }
    Err(format!(
        "{label} did not become ready on {INTERNAL_HOST}:{} within {} attempts",
        readiness.port, readiness.attempts
    ))
}

/// Poll until something ends the enclave's right to stay up: a signal, or any
/// watched child exiting. Returns the reason for the log line and the exit
/// code the caller must fail-stop with.
pub fn supervise(watch: &mut [Watched], poll: Duration) -> String {
    let started = Instant::now();
    loop {
        if crate::stop_signal::triggered() {
            return format!("shutdown signal after {:?}", started.elapsed());
        }
        for entry in watch.iter_mut() {
            match entry.child.try_wait() {
                Ok(Some(status)) => return format!("{} exited ({status})", entry.label),
                Ok(None) => {}
                Err(error) => return format!("{} could not be watched: {error}", entry.label),
            }
        }
        std::thread::sleep(poll);
    }
}

/// Kill what we started and reap it. Best-effort in reverse order: bridges
/// first so no new request reaches a server that is about to go away.
pub fn teardown(watch: &mut [Watched]) {
    for entry in watch.iter_mut().rev() {
        let _ = entry.child.kill();
        let _ = entry.child.wait();
    }
}

#[cfg(unix)]
pub mod stop_signal {
    //! SIGTERM/SIGINT latch. Nothing inside a running Nitro enclave sends a
    //! signal to PID 1 — `nitro-cli terminate-enclave` destroys the VM — but
    //! `docker stop` does while an operator debugs the image, and the shell
    //! entrypoint trapped it. The handler only stores a flag: the only thing
    //! async-signal-safe about it is an atomic store.

    use std::sync::atomic::{AtomicBool, Ordering};

    static TRIGGERED: AtomicBool = AtomicBool::new(false);

    extern "C" fn latch(_signal: libc::c_int) {
        TRIGGERED.store(true, Ordering::Relaxed);
    }

    pub fn install() {
        for signal in [libc::SIGTERM, libc::SIGINT] {
            unsafe {
                // Cast via a thin pointer: a direct function-item-to-integer cast is
                // what `function_casts_as_integer` rejects, and this path only
                // compiles on Linux — the platform where CI denies the warning.
                libc::signal(signal, latch as *const () as libc::sighandler_t);
            }
        }
    }

    pub fn triggered() -> bool {
        TRIGGERED.load(Ordering::Relaxed)
    }
}

#[cfg(not(unix))]
pub mod stop_signal {
    //! No signal delivery to trap: the supervisor still fail-stops on a child
    //! exit, which is the property that matters.
    pub fn install() {}
    pub fn triggered() -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: std::collections::BTreeMap<String, String> = pairs
            .iter()
            .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
            .collect();
        move |key: &str| map.get(key).cloned()
    }

    /// The image bakes these values, so a plan built from an empty env is the
    /// whole-boot posture of `nitro_init frontier` in the shipped EIF.
    #[test]
    fn the_frontier_plan_is_the_shipped_image_posture() {
        let plan = build_plan(Role::Frontier, env(&[])).expect("plan");
        assert_eq!(plan.role, Role::Frontier);
        assert_eq!(plan.vsock_port, 8787);
        assert_eq!(plan.server.program, "/app/bin/enclave_host");
        assert!(plan.server.args.is_empty(), "the host takes no argv");
        assert_eq!(plan.readiness.port, 8081);
        assert_eq!(
            plan.server
                .env
                .iter()
                .filter(|(key, _)| key == "ENCLAVE_HOST" || key == "PORT")
                .map(|(key, value)| (key.as_str(), value.as_str()))
                .collect::<Vec<_>>(),
            vec![("ENCLAVE_HOST", "127.0.0.1"), ("PORT", "8081")]
        );
    }

    /// The two bridge argvs are the parity contract with the shell: socat is
    /// the only thing that speaks vsock here, so its spelling is load-bearing.
    #[test]
    fn the_bridge_argv_matches_the_shell_line_for_line() {
        let plan = build_plan(
            Role::Frontier,
            env(&[
                ("NITRO_SIGNER_VSOCK_PORT", "9797"),
                ("ENCLAVE_INTERNAL_PORT", "9090"),
                ("ENCLAVE_HOST_CID", "4"),
                ("ENCLAVE_EGRESS_VSOCK_PORT", "9798"),
                ("ENCLAVE_PROXY_PORT", "4321"),
            ]),
        )
        .expect("plan");
        assert_eq!(
            plan.egress.args,
            vec![
                "TCP-LISTEN:4321,fork,reuseaddr,bind=127.0.0.1".to_string(),
                "VSOCK-CONNECT:4:9798".to_string(),
            ]
        );
        assert_eq!(
            plan.vsock.args,
            vec![
                "VSOCK-LISTEN:9797,fork,reuseaddr".to_string(),
                "TCP-CONNECT:127.0.0.1:9090".to_string(),
            ]
        );
        assert_eq!(plan.loopback.args, vec!["link", "set", "dev", "lo", "up"]);
        assert_eq!(plan.readiness.port, 9090);
    }

    #[test]
    fn custody_runs_the_signer_server_and_reads_its_own_port_key() {
        let plan =
            build_plan(Role::Custody, env(&[("SIGNER_SERVICE_PORT", "8085")])).expect("plan");
        assert_eq!(plan.server.program, "/app/bin/signer_service");
        assert_eq!(plan.server.args, vec!["serve".to_string()]);
        assert_eq!(plan.readiness.port, 8085);
        assert_eq!(
            plan.vsock.args[1],
            "TCP-CONNECT:127.0.0.1:8085".to_string(),
            "the vsock bridge follows the port the signer binds"
        );
        assert!(
            !plan.server.env.iter().any(|(key, _)| key == "PORT"),
            "custody inherits SIGNER_SERVICE_PORT rather than being rewritten"
        );
    }

    /// Every child gets the proxy env the shell exported: reqwest reaches the
    /// outside through the egress bridge, and loopback must stay out of it.
    #[test]
    fn the_egress_proxy_env_reaches_every_child_and_excludes_loopback() {
        let plan = build_plan(Role::Frontier, env(&[])).expect("plan");
        for spec in [&plan.egress, &plan.server, &plan.vsock] {
            let value = |key: &str| {
                spec.env
                    .iter()
                    .find(|(name, _)| name == key)
                    .map(|(_, value)| value.as_str())
            };
            assert_eq!(value("HTTPS_PROXY"), Some("http://127.0.0.1:3128"));
            assert_eq!(value("http_proxy"), Some("http://127.0.0.1:3128"));
            assert_eq!(value("NO_PROXY"), Some("127.0.0.1,localhost,::1"));
        }
        assert!(plan.loopback.env.is_empty(), "ip needs no proxy");
    }

    #[test]
    fn a_malformed_port_fails_the_plan_not_the_spawn() {
        for (role, key) in [
            (Role::Frontier, "ENCLAVE_INTERNAL_PORT"),
            (Role::Custody, "SIGNER_SERVICE_PORT"),
            (Role::Frontier, "NITRO_SIGNER_VSOCK_PORT"),
            (Role::Frontier, "ENCLAVE_PROXY_PORT"),
        ] {
            let error = build_plan(role, env(&[(key, "not-a-port")])).expect_err("must fail");
            assert!(error.contains(key), "{error}");
            assert!(error.contains("not-a-port"), "{error}");
        }
        assert!(
            build_plan(Role::Frontier, env(&[("ENCLAVE_HOST_CID", "-1")]))
                .expect_err("must fail")
                .contains("ENCLAVE_HOST_CID")
        );
    }

    #[test]
    fn the_program_overrides_exist_for_dev_boxes_and_tests() {
        let plan = build_plan(
            Role::Frontier,
            env(&[
                ("NITRO_INIT_SERVER_BIN", "/usr/local/bin/host"),
                ("NITRO_INIT_SERVER_ARGS", "  --flag   --other "),
                ("NITRO_INIT_BRIDGE_BIN", "/usr/local/bin/bridge"),
                ("NITRO_INIT_IP_BIN", "/usr/local/bin/link-up"),
            ]),
        )
        .expect("plan");
        assert_eq!(plan.server.program, "/usr/local/bin/host");
        assert_eq!(
            plan.server.args,
            vec!["--flag".to_string(), "--other".to_string()]
        );
        assert_eq!(plan.egress.program, "/usr/local/bin/bridge");
        assert_eq!(plan.vsock.program, "/usr/local/bin/bridge");
        assert_eq!(plan.loopback.program, "/usr/local/bin/link-up");

        // Blank is unset: the role defaults stay in place.
        let plan = build_plan(
            Role::Custody,
            env(&[
                ("NITRO_INIT_SERVER_BIN", "   "),
                ("NITRO_INIT_BRIDGE_BIN", ""),
            ]),
        )
        .expect("plan");
        assert_eq!(plan.server.program, "/app/bin/signer_service");
        assert_eq!(plan.egress.program, "socat");
    }

    #[test]
    fn roles_are_argv_tokens_not_env_guesses() {
        assert_eq!(Role::parse(" frontier "), Some(Role::Frontier));
        assert_eq!(Role::parse("custody"), Some(Role::Custody));
        assert_eq!(Role::parse(""), None);
        assert_eq!(Role::parse("enclave"), None);
        assert_eq!(Role::Frontier.name(), "frontier");
        assert_eq!(Role::Custody.name(), "custody");
    }
}
