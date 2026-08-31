use std::process::Command;

use crate::child::{build_child_env, BridgeChild};
use crate::overlay::EnvOverlay;

fn node_available() -> bool {
    Command::new("node").arg("--version").output().is_ok()
}

#[test]
fn child_env_is_the_merged_overlay_with_the_listener_pinned() {
    let mut overlay = EnvOverlay::new([
        ("MORPHEUS_NETWORK", "testnet"),
        ("PORT", "9999"),
        ("NITROCORE_HOST", "0.0.0.0"),
        ("TWELVEDATA_API_KEY", "stale"),
    ]);
    // A provision shadows the base, exactly as it shadows the image ENV.
    overlay.apply("TWELVEDATA_API_KEY", &serde_json::json!("fresh"));
    overlay.apply("PROVISIONED_KEY", &serde_json::json!("v"));
    overlay.set_runtime_token("tok");

    let env = build_child_env(&overlay, 8090);
    assert_eq!(env.get("PORT").map(String::as_str), Some("8090"));
    assert_eq!(env.get("NITROCORE_PORT").map(String::as_str), Some("8090"));
    assert_eq!(
        env.get("NITROCORE_HOST").map(String::as_str),
        Some("127.0.0.1")
    );
    assert_eq!(env.get("HOST").map(String::as_str), Some("127.0.0.1"));
    assert_eq!(
        env.get("TWELVEDATA_API_KEY").map(String::as_str),
        Some("fresh")
    );
    assert_eq!(env.get("PROVISIONED_KEY").map(String::as_str), Some("v"));
    assert_eq!(
        env.get("MORPHEUS_NETWORK").map(String::as_str),
        Some("testnet")
    );
    // The worker's requireAuth shares the runtime token with the bridge's
    // forward credential — both sides read the same value.
    assert_eq!(
        env.get("MORPHEUS_RUNTIME_TOKEN").map(String::as_str),
        Some("tok")
    );
}

#[test]
fn the_watch_respawns_an_exited_child_and_provision_replaces_a_live_one() {
    if !node_available() {
        eprintln!("skipping: node is not on PATH");
        return;
    }
    let overlay = EnvOverlay::new([("MORPHEUS_RUNTIME_TOKEN", "tok")]);

    let child = BridgeChild::from_parts(
        "node",
        vec!["-e".to_string(), "setInterval(()=>{},1<<30)".to_string()],
        18090,
    );
    child.ensure_running(&overlay);
    assert_eq!(child.generation(), 1, "first start spawns generation 1");
    let first_pid = child.pid().expect("child spawned");
    child.ensure_running(&overlay);
    assert_eq!(child.generation(), 1, "a live child is not respawned");
    assert_eq!(child.pid(), Some(first_pid));

    child.respawn_for_provision(&overlay);
    assert_eq!(child.generation(), 2, "/provision replaces a live child");
    assert!(child.pid().is_some(), "respawn produced a child");

    // Drop must not leave the stub running; killing it here too so a later
    // assertion failure does not leak the process past the panic.
    drop(child);

    let dying = BridgeChild::from_parts(
        "node",
        vec![
            "-e".to_string(),
            "setTimeout(()=>process.exit(0),150)".to_string(),
        ],
        18091,
    );
    dying.ensure_running(&overlay);
    assert_eq!(dying.generation(), 1);
    std::thread::sleep(std::time::Duration::from_millis(600));
    dying.ensure_running(&overlay);
    assert_eq!(dying.generation(), 2, "the watch respawns an exited child");
}

#[test]
fn a_spawn_failure_is_logged_and_left_to_the_watch_loop() {
    let child = BridgeChild::from_parts("definitely-not-a-real-executable", vec![], 18092);
    let overlay = EnvOverlay::new(Vec::<(&str, &str)>::new());
    child.ensure_running(&overlay);
    assert_eq!(child.generation(), 0, "a failed spawn bumps nothing");
    assert_eq!(child.pid(), None);
}
