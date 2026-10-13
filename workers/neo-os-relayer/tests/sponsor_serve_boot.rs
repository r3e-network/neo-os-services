//! `neo-os-relayer serve:sponsor` must reach its listener, and the sponsor
//! settings it reads must be resolvable.
//!
//! The sponsor HTTP surface is driven in unit tests through injected journal and
//! send ports (`src/sponsor_api.rs`, `tests/sponsor_api.rs`), which never start
//! the CLI path. The CLI path is where the surface actually lives, and it is the
//! one place a `reqwest::blocking` client can be built inside the tokio runtime
//! `main` runs — which does not fail quietly: the process panics while dropping
//! that client's runtime and the route never binds.
//!
//! Independently, `sponsor.*` is documented in `docs/SPONSOR_API.md` but nothing
//! projected it into the resolved configuration, and the numeric reader used
//! `Value::as_u64` on the `f64` shape `js_value_to_json` produces. Both make a
//! correctly configured lane refuse to start.
//!
//! These tests start the real binary against a stub signing endpoint and read
//! the projected configuration through the same settings reader the surface
//! uses. On the base the process panics before binding and the settings reader
//! cannot see a ceiling.

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use neo_os_relayer::config::create_relayer_config_from_env;
use neo_os_relayer::sponsor_api::settings_from;

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .expect("bind an ephemeral port")
        .local_addr()
        .expect("read the ephemeral port")
        .port()
}

/// A custody signing endpoint that answers only key identity lookups: enough for
/// `resolve_signer` to succeed so the process reaches its listener. It holds no
/// key and produces no signature.
fn stub_signer(listen: SocketAddr, stop: Arc<AtomicBool>) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let listener = TcpListener::bind(listen).expect("bind the stub signer");
        listener
            .set_nonblocking(true)
            .expect("make the stub signer nonblocking");
        while !stop.load(Ordering::SeqCst) {
            let Ok((mut stream, _)) = listener.accept() else {
                thread::sleep(Duration::from_millis(20));
                continue;
            };
            let mut buffer = [0u8; 4096];
            let _ = stream.set_nonblocking(false);
            let read = stream.read(&mut buffer).unwrap_or(0);
            let request = String::from_utf8_lossy(&buffer[..read]).to_string();
            let body = if request.starts_with("GET /signer/api/v1/keys/") {
                r#"{"allowed":true,"key_id":"sponsor","chain_family":"neo-n3","public_key":"02aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899","script_hash":"0x1111111111111111111111111111111111111111","address":"Nxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}"#
            } else {
                r#"{"allowed":false,"code":"unsupported","message":"the stub signs nothing"}"#
            };
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = stream.write_all(response.as_bytes());
            let _ = stream.flush();
        }
    })
}

fn accepts(port: u16) -> bool {
    TcpStream::connect(("127.0.0.1", port)).is_ok()
}

fn sponsor_boot_env() -> BTreeMap<String, String> {
    let mut env = BTreeMap::new();
    env.insert("NODE_ENV".to_string(), "test".to_string());
    env.insert("MORPHEUS_NETWORK".to_string(), "testnet".to_string());
    env.insert(
        "MORPHEUS_RELAYER_MODE".to_string(),
        "requests_only".to_string(),
    );
    env.insert(
        "MORPHEUS_RELAYER_ALLOW_RUNTIME_FALLBACKS".to_string(),
        "false".to_string(),
    );
    env.insert("MORPHEUS_ACTIVE_CHAINS".to_string(), "neo_n3".to_string());
    env.insert(
        "MORPHEUS_AUTOMATION_ENABLED".to_string(),
        "false".to_string(),
    );
    env.insert("SUPABASE_URL".to_string(), "http://127.0.0.1:1".to_string());
    env.insert(
        "SUPABASE_SERVICE_ROLE_KEY".to_string(),
        "boot-stub".to_string(),
    );
    env.insert(
        "SIGNER_SERVICE_URL".to_string(),
        "http://127.0.0.1:1".to_string(),
    );
    env.insert("SIGNER_SERVICE_TOKEN".to_string(), "boot-stub".to_string());
    env.insert(
        "SIGNER_ROLE_SPONSOR_KEY_ID".to_string(),
        "sponsor".to_string(),
    );
    env.insert("MORPHEUS_SPONSOR_HOST".to_string(), "127.0.0.1".to_string());
    env.insert("MORPHEUS_SPONSOR_PORT".to_string(), "9465".to_string());
    env.insert(
        "MORPHEUS_SPONSOR_CONTRACT".to_string(),
        "0x2222222222222222222222222222222222222222".to_string(),
    );
    env.insert(
        "MORPHEUS_SPONSOR_FEE_CEILING_UNITS".to_string(),
        "1000000".to_string(),
    );
    env.insert("MORPHEUS_SPONSOR_ENABLED".to_string(), "true".to_string());
    env
}

/// Defect 2: `sponsor.*` must be projected into the resolved configuration, and
/// the numeric reader must accept the `f64` shape `js_value_to_json` produces.
/// A ceiling that reads as absent becomes `0`, which `settings_from` refuses.
#[test]
fn projected_sponsor_settings_resolve_including_the_f64_numbers() {
    let env = sponsor_boot_env();
    let config = create_relayer_config_from_env(&env)
        .expect("a configured testnet lane must resolve its configuration");
    let sponsor = config
        .raw
        .get("sponsor")
        .expect("sponsor.* must be projected into the resolved configuration");
    assert_eq!(
        sponsor.get("contract").and_then(|v| v.as_str()),
        Some("0x2222222222222222222222222222222222222222"),
        "the sponsorable contract must be projected: {sponsor}"
    );
    let ceiling = sponsor
        .get("feeCeilingUnits")
        .expect("feeCeilingUnits must be projected");
    assert!(
        ceiling.as_u64().is_some() || ceiling.as_f64().is_some(),
        "feeCeilingUnits must be a number, got {ceiling}"
    );
    let settings = settings_from(&config).expect("the projected settings must resolve");
    assert_eq!(
        settings.fee_ceiling_units, 1_000_000,
        "a projected ceiling must read back as itself, not as the absent default"
    );
    assert!(
        settings.enabled,
        "the kill switch must follow the projected enabled flag"
    );
}

/// Defect 1: the CLI must construct and drop the blocking transport outside the
/// async context and still bind the sponsor listener.
#[test]
fn serve_sponsor_binds_its_listener_instead_of_panicking_in_the_async_context() {
    let sponsor_port = free_port();
    let signer_port = free_port();
    let rpc_port = free_port();
    let store_port = free_port();
    let stop = Arc::new(AtomicBool::new(false));
    let signer = stub_signer(
        format!("127.0.0.1:{signer_port}").parse().unwrap(),
        Arc::clone(&stop),
    );

    let state_file = std::env::temp_dir().join(format!(
        "neoos-sponsor-boot-{}-{}.json",
        std::process::id(),
        sponsor_port
    ));
    let signer_url = format!("http://127.0.0.1:{signer_port}");

    let mut child = Command::new(env!("CARGO_BIN_EXE_neo-os-relayer"))
        .arg("serve:sponsor")
        .env_clear()
        .env("HOME", std::env::var("HOME").unwrap_or_default())
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .env(
            "RUST_BACKTRACE",
            std::env::var("RUST_BACKTRACE").unwrap_or_else(|_| "0".to_string()),
        )
        .env("NODE_ENV", "test")
        .env("MORPHEUS_NETWORK", "testnet")
        .env("MORPHEUS_LOCAL_CHAIN", "true")
        .env(
            "MORPHEUS_LOCAL_CHAIN_RPC_URLS",
            format!("http://127.0.0.1:{rpc_port}"),
        )
        .env("MORPHEUS_RELAYER_MODE", "requests_only")
        .env("MORPHEUS_RELAYER_NEO_N3_SCAN_MODE", "block_cursor")
        .env("MORPHEUS_RELAYER_ALLOW_RUNTIME_FALLBACKS", "false")
        .env("MORPHEUS_ACTIVE_CHAINS", "neo_n3")
        .env("MORPHEUS_AUTOMATION_ENABLED", "false")
        .env("MORPHEUS_RELAYER_STATE_FILE", &state_file)
        .env("SUPABASE_URL", format!("http://127.0.0.1:{store_port}"))
        .env("SUPABASE_SERVICE_ROLE_KEY", "boot-stub")
        .env("SIGNER_SERVICE_URL", &signer_url)
        .env("SIGNER_SERVICE_TOKEN", "boot-stub")
        .env("SIGNER_ROLE_SPONSOR_KEY_ID", "sponsor")
        .env("MORPHEUS_SPONSOR_HOST", "127.0.0.1")
        .env("MORPHEUS_SPONSOR_PORT", sponsor_port.to_string())
        .env(
            "MORPHEUS_SPONSOR_CONTRACT",
            "0x2222222222222222222222222222222222222222",
        )
        .env("MORPHEUS_SPONSOR_FEE_CEILING_UNITS", "1000000")
        .env("MORPHEUS_SPONSOR_ENABLED", "true")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn neo-os-relayer serve:sponsor");

    let deadline = Instant::now() + Duration::from_secs(30);
    let mut bound = false;
    while Instant::now() < deadline {
        if accepts(sponsor_port) {
            bound = true;
            break;
        }
        if child.try_wait().ok().flatten().is_some() {
            break;
        }
        thread::sleep(Duration::from_millis(100));
    }
    let _ = child.kill();

    let output = child.wait_with_output().expect("reap the sponsor process");
    stop.store(true, Ordering::SeqCst);
    let _ = signer.join();
    let _ = std::fs::remove_file(&state_file);

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let transcript = format!("{stdout}\n{stderr}");

    assert!(
        !transcript.contains("panicked at"),
        "serve:sponsor panicked instead of serving:\n{transcript}"
    );
    assert!(
        bound,
        "serve:sponsor never bound its listener:\n{transcript}"
    );
    assert!(
        transcript.contains("sponsor API listening"),
        "serve:sponsor did not report its listener:\n{transcript}"
    );
}
