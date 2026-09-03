//! Process-level supervisor tests: real children, a real loopback listener.
//! These are the ones that justify the rewrite — the shell could only be
//! checked by booting an enclave, and the fail-stop rule is the property the
//! whole design rests on.
//!
//! They need `node` on PATH (the repo's other process tests skip the same
//! way) and run everywhere the workspace builds, including this Windows box.

use std::net::TcpListener;
use std::time::{Duration, Instant};

use nitro_init::{supervise, teardown, wait_for_ready, Readiness, SpawnSpec, Watched};

fn node_available() -> bool {
    std::process::Command::new("node")
        .arg("--version")
        .output()
        .is_ok()
}

fn spec(label: &'static str, source: &str) -> SpawnSpec {
    SpawnSpec {
        label,
        program: "node".to_string(),
        args: vec!["-e".to_string(), source.to_string()],
        env: Vec::new(),
    }
}

fn alive(label: &'static str) -> SpawnSpec {
    spec(label, "setInterval(()=>{},1<<30)")
}

fn dead(label: &'static str) -> SpawnSpec {
    spec(label, "process.exit(0)")
}

fn readiness(port: u16) -> Readiness {
    Readiness {
        port,
        attempts: 40,
        interval: Duration::from_millis(50),
        connect_timeout: Duration::from_millis(200),
    }
}

#[test]
fn the_vsock_door_opens_only_once_the_port_accepts() {
    if !node_available() {
        eprintln!("skipping: node is not on PATH");
        return;
    }
    let listener = TcpListener::bind("127.0.0.1:0").expect("loopback listener");
    let port = listener.local_addr().expect("addr").port();
    let mut server = alive("test server").spawn().expect("child");

    let started = Instant::now();
    wait_for_ready(&readiness(port), &mut server, "test server").expect("ready");
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "a listening server is ready immediately, not after the full budget"
    );

    let mut watch = vec![Watched {
        label: "test server",
        child: server,
    }];
    teardown(&mut watch);
}

#[test]
fn a_dead_port_exhausts_the_budget_and_says_so() {
    if !node_available() {
        eprintln!("skipping: node is not on PATH");
        return;
    }
    // Grab a port and release it: nothing listens, so the probe must time out
    // rather than hang or report success.
    let listener = TcpListener::bind("127.0.0.1:0").expect("loopback listener");
    let port = listener.local_addr().expect("addr").port();
    drop(listener);

    let mut server = alive("test server").spawn().expect("child");
    let error = wait_for_ready(
        &Readiness {
            attempts: 3,
            interval: Duration::from_millis(20),
            ..readiness(port)
        },
        &mut server,
        "test server",
    )
    .expect_err("nothing is listening");
    assert!(error.contains("test server"), "{error}");
    assert!(error.contains(&port.to_string()), "{error}");

    let mut watch = vec![Watched {
        label: "test server",
        child: server,
    }];
    teardown(&mut watch);
}

#[test]
fn a_server_that_dies_before_ready_is_reported_as_itself() {
    if !node_available() {
        eprintln!("skipping: node is not on PATH");
        return;
    }
    let mut server = dead("test server").spawn().expect("child");
    let error = wait_for_ready(
        &Readiness {
            attempts: 40,
            ..readiness(1)
        },
        &mut server,
        "test server",
    )
    .expect_err("the server exits");
    assert!(error.contains("exited before becoming ready"), "{error}");
}

#[test]
fn the_watch_ends_on_the_first_death_and_teardown_reaps_the_rest() {
    if !node_available() {
        eprintln!("skipping: node is not on PATH");
        return;
    }
    let mut watch = vec![
        Watched {
            label: "egress bridge",
            child: alive("egress bridge").spawn().expect("child"),
        },
        Watched {
            label: "enclave_host",
            child: alive("enclave_host").spawn().expect("child"),
        },
        Watched {
            label: "vsock bridge",
            child: alive("vsock bridge").spawn().expect("child"),
        },
    ];
    watch[1].child.kill().expect("kill the server");

    let reason = supervise(&mut watch, Duration::from_millis(20));
    assert!(
        reason.starts_with("enclave_host exited"),
        "the report names the process that died: {reason}"
    );

    teardown(&mut watch);
    for entry in watch.iter_mut() {
        assert!(
            entry.child.try_wait().expect("waitable").is_some(),
            "{} outlived the teardown",
            entry.label
        );
    }
}

#[test]
fn a_bridge_that_cannot_start_stops_the_boot() {
    let spec = SpawnSpec {
        label: "egress bridge",
        program: "definitely-not-a-real-executable".to_string(),
        args: vec!["TCP-LISTEN:3128,fork".to_string()],
        env: Vec::new(),
    };
    let error = match spec.spawn() {
        Ok(mut child) => {
            let _ = child.kill();
            let _ = child.wait();
            panic!("the launch should have failed");
        }
        Err(error) => error,
    };
    assert!(error.contains("egress bridge"), "{error}");
    assert!(
        error.contains("definitely-not-a-real-executable"),
        "{error}"
    );
}
