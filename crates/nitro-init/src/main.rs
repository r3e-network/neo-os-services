//! `nitro_init <frontier|custody>` — PID 1 of a Morpheus Nitro enclave.
//!
//! The boot sequence and the fail-stop rule are the ones the enclave images
//! shipped as shell since the split: egress bridge, server, readiness gate,
//! vsock bridge, and the whole enclave comes down when any of the three
//! processes it started goes away or a signal arrives. The lifecycle lives in
//! `launch`/`teardown` here; every decision (argv, env, ports) is made by the
//! tested plan builder in the library.

use std::process::ExitCode;

use nitro_init::{
    build_plan, supervise, teardown, wait_for_ready, BootPlan, Role, Watched, WATCH_INTERVAL,
};

fn main() -> ExitCode {
    let raw = std::env::args().nth(1);
    let role = raw.as_deref().and_then(Role::parse);
    let Some(role) = role else {
        eprintln!(
            "usage: nitro_init <frontier|custody>{}",
            match raw {
                Some(value) => format!(" (unknown role {value:?})"),
                None => String::new(),
            }
        );
        return ExitCode::from(2);
    };

    let mut watch: Vec<Watched> = Vec::new();
    let outcome = boot(role, &mut watch);
    teardown(&mut watch);
    match outcome {
        Ok(()) => ExitCode::SUCCESS,
        Err(reason) => {
            eprintln!("nitro-init: {reason}");
            ExitCode::FAILURE
        }
    }
}

fn boot(role: Role, watch: &mut Vec<Watched>) -> Result<(), String> {
    nitro_init::stop_signal::install();
    let plan = build_plan(role, |key| std::env::var(key).ok())?;

    // A Nitro enclave boots with loopback DOWN, so every localhost bind and
    // bridge needs this first. Warn and continue rather than die: under
    // `docker run` the interface is already up, and `ip` may not even be
    // installed in a debug image.
    if let Err(reason) = plan.loopback.run() {
        eprintln!("nitro-init: WARN {reason}");
    }
    launch(&plan, watch)
}

fn launch(plan: &BootPlan, watch: &mut Vec<Watched>) -> Result<(), String> {
    println!(
        "nitro-init: starting {} {}",
        plan.egress.label, plan.egress.args[0]
    );
    watch.push(Watched {
        label: plan.egress.label,
        child: plan.egress.spawn()?,
    });

    println!(
        "nitro-init: starting {} ({}:{})",
        plan.server.label,
        nitro_init::INTERNAL_HOST,
        plan.readiness.port
    );
    let server_index = watch.len();
    watch.push(Watched {
        label: plan.server.label,
        child: plan.server.spawn()?,
    });

    // The vsock door opens only once the server accepts, so the first inbound
    // request never races the listener coming up.
    wait_for_ready(
        &plan.readiness,
        &mut watch[server_index].child,
        plan.server.label,
    )?;

    println!(
        "nitro-init: {} ready; exposing over vsock :{}",
        plan.server.label, plan.vsock_port
    );
    watch.push(Watched {
        label: plan.vsock.label,
        child: plan.vsock.spawn()?,
    });

    Err(supervise(watch, WATCH_INTERVAL))
}
