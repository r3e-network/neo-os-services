use neo_os_relayer::create_relayer_config_from_env;
use std::collections::BTreeMap;
use std::process::Command;

fn local_env() -> BTreeMap<String, String> {
    [
        ("NODE_ENV", "test"),
        ("MORPHEUS_NETWORK", "testnet"),
        ("MORPHEUS_LOCAL_CHAIN", "true"),
        ("MORPHEUS_LOCAL_CHAIN_RPC_URLS", "http://127.0.0.1:23456"),
        ("MORPHEUS_RELAYER_MODE", "requests_only"),
        ("MORPHEUS_RELAYER_NEO_N3_SCAN_MODE", "block_cursor"),
        ("MORPHEUS_RELAYER_ALLOW_RUNTIME_FALLBACKS", "false"),
        ("MORPHEUS_RUNTIME_URL", "http://127.0.0.1:23457"),
        ("SIGNER_SERVICE_URL", "http://127.0.0.1:23458"),
    ]
    .into_iter()
    .map(|(k, v)| (k.into(), v.into()))
    .collect()
}

#[test]
fn local_chain_replaces_public_rpc_defaults() {
    let config = create_relayer_config_from_env(&local_env()).unwrap();
    assert_eq!(config.raw["localChain"], true);
    assert_eq!(
        config.raw["neo_n3"]["rpcUrls"],
        serde_json::json!(["http://127.0.0.1:23456"])
    );
    assert_eq!(config.raw["neo_n3"]["networkMagic"], 894710606);
}

#[test]
fn local_chain_refusals_exit_before_network_io() {
    for (key, value) in [
        ("NODE_ENV", " PrOdUcTiOn "),
        ("MORPHEUS_NETWORK", "mainnet"),
        ("MORPHEUS_LOCAL_CHAIN_RPC_URLS", ""),
        ("MORPHEUS_LOCAL_CHAIN_RPC_URLS", "https://rpc.example"),
        (
            "MORPHEUS_LOCAL_CHAIN_RPC_URLS",
            "http://127.0.0.1:23456,https://rpc.example",
        ),
        ("MORPHEUS_LOCAL_CHAIN_RPC_URLS", "http://localhost:23456"),
        ("MORPHEUS_LOCAL_CHAIN_RPC_URLS", "http://192.168.1.1:23456"),
        (
            "MORPHEUS_LOCAL_CHAIN_RPC_URLS",
            "http://user@127.0.0.1:23456",
        ),
        (
            "MORPHEUS_LOCAL_CHAIN_RPC_URLS",
            "http://127.0.0.1:23456/#fragment",
        ),
        (
            "MORPHEUS_RUNTIME_URL",
            "https://oracle.meshmini.app/testnet",
        ),
        ("SIGNER_SERVICE_URL", "https://signer.example"),
        ("NEO_TESTNET_RPC_URL", "https://rpc.example"),
        ("MORPHEUS_RELAYER_ALLOW_RUNTIME_FALLBACKS", "true"),
        ("MORPHEUS_ACTIVE_CHAINS", "neo_n3,neox"),
        ("MORPHEUS_RELAYER_NEO_N3_SCAN_MODE", "n3index_notifications"),
        ("MORPHEUS_RELAYER_MODE", "combined"),
        ("NEO_TESTNET_MAGIC", "860833102"),
        (
            "MORPHEUS_RUNTIME_CONFIG_JSON",
            r#"{"NITRO_SIGNER_URL":"https://signer.example"}"#,
        ),
    ] {
        let mut env = local_env();
        env.insert(key.into(), value.into());
        assert!(
            create_relayer_config_from_env(&env).is_err(),
            "accepted {key}"
        );
        let output = Command::new(env!("CARGO_BIN_EXE_neo-os-relayer"))
            .arg("once")
            .env_clear()
            .envs(&env)
            .output()
            .unwrap();
        assert!(!output.status.success(), "CLI accepted {key}");
        assert!(
            String::from_utf8_lossy(&output.stderr).contains("local-chain"),
            "wrong refusal for {key}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

// Include network-suffixed aliases and aliases without a URL suffix. Keep this
// list independent of the refusal implementation so omissions stay observable.
const ENDPOINT_ALIASES: &[&str] = &[
    "NEO_MAINNET_RPC_URLS",
    "MAINNET_RPC_URLS",
    "NEO_RPC_URLS_MAINNET",
    "NEO_MAINNET_RPC_URL",
    "MAINNET_RPC_URL",
    "NEO_RPC_MAINNET",
    "NEO_TESTNET_RPC_URLS",
    "TESTNET_RPC_URLS",
    "NEO_RPC_URLS_TESTNET",
    "NEO_TESTNET_RPC_URL",
    "TESTNET_RPC_URL",
    "NEO_RPC_TESTNET",
    "NEO_RPC_URLS",
    "NEO_RPC_URL",
    "NEOX_RPC",
    "NEOX_RPC_URLS",
    "MORPHEUS_RELAYER_NEOX_RPC_URL",
    "MORPHEUS_RELAYER_NEOX_RPC_URLS",
    "MORPHEUS_MAINNET_RUNTIME_URL",
    "MORPHEUS_TESTNET_RUNTIME_URL",
    "MORPHEUS_RUNTIME_URL",
    "MORPHEUS_MAINNET_NITRO_API_URL",
    "MORPHEUS_TESTNET_NITRO_API_URL",
    "NITRO_API_URL",
    "NITRO_SIGNER_URL",
    "MORPHEUS_SIGNER_URL",
    "SIGNER_SERVICE_URL",
    "SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_URL",
    "morpheus_SUPABASE_URL",
    "MORPHEUS_RELAYER_ENCLAVE_FULFILL_URL",
    "MORPHEUS_RELAYER_ENCLAVE_DECRYPT_URL",
    "MORPHEUS_DECRYPT_URL",
    "MORPHEUS_RELAYER_NEO_N3_INDEXER_URL",
    "MORPHEUS_RELAYER_NEOX_WORKER_URL",
    "NEOX_WORKER_URL",
    "MORPHEUS_BETTERSTACK_RELAYER_HEARTBEAT_URL",
    "MORPHEUS_BETTERSTACK_RELAYER_FEED_HEARTBEAT_URL",
    "MORPHEUS_BETTERSTACK_RELAYER_FAILURE_URL",
    "MORPHEUS_BETTERSTACK_RELAYER_DEADLETTER_URL",
    "MORPHEUS_N3_RECONCILIATION_ARCHIVE_RPC_URLS",
    "MORPHEUS_LOCAL_CHAIN_RPC_URLS",
];

fn endpoint_refusal_cases() -> Vec<(String, BTreeMap<String, String>)> {
    let mut cases = Vec::new();
    for key in ENDPOINT_ALIASES {
        let mut env = local_env();
        env.insert((*key).into(), "https://remote.example".into());
        cases.push((format!("direct {key}"), env));
        for value in [
            serde_json::json!("https://remote.example"),
            serde_json::json!(["http://127.0.0.1:23456", "https://remote.example"]),
        ] {
            let mut env = local_env();
            // Even a local direct value must not conceal a remote packed value.
            env.insert((*key).into(), "http://127.0.0.1:23456".into());
            env.insert(
                "MORPHEUS_RUNTIME_CONFIG_JSON".into(),
                serde_json::json!({*key: value}).to_string(),
            );
            cases.push((format!("packed {key} {value}"), env));
        }
    }
    let mut env = local_env();
    env.remove("MORPHEUS_LOCAL_CHAIN_RPC_URLS");
    env.insert(
        "MORPHEUS_RUNTIME_CONFIG_JSON".into(),
        r#"{"MORPHEUS_LOCAL_CHAIN_RPC_URLS":["https://remote.example"]}"#.into(),
    );
    cases.push(("effective packed RPC array".into(), env));
    let mut env = local_env();
    env.insert(
        "MORPHEUS_RUNTIME_CONFIG_JSON".into(),
        r#"{"NODE_ENV":[" PrOdUcTiOn "]}"#.into(),
    );
    cases.push(("shadowed production array".into(), env));
    cases
}

#[test]
fn local_chain_endpoint_aliases_and_packed_values_are_refused() {
    let accepted: Vec<_> = endpoint_refusal_cases()
        .into_iter()
        .filter_map(|(name, env)| create_relayer_config_from_env(&env).is_ok().then_some(name))
        .collect();
    assert!(accepted.is_empty(), "accepted refusal cases: {accepted:?}");
}

#[test]
fn local_chain_packed_loopback_arrays_are_supported() {
    let mut env = local_env();
    env.remove("MORPHEUS_LOCAL_CHAIN_RPC_URLS");
    env.insert(
        "MORPHEUS_RUNTIME_CONFIG_JSON".into(),
        serde_json::json!({
            "MORPHEUS_LOCAL_CHAIN_RPC_URLS": [" http://127.0.0.1:23456 ", "http://[::1]:23457"],
            "NEOX_RPC": ["https://127.0.0.1:23456"],
            "NITRO_API_URL": ["http://127.0.0.1:23456"],
            "NODE_ENV": ["test"]
        })
        .to_string(),
    );
    let config = create_relayer_config_from_env(&env).unwrap();
    assert_eq!(
        config.raw["neo_n3"]["rpcUrls"],
        serde_json::json!(["http://127.0.0.1:23456", "http://[::1]:23457"])
    );
}

#[test]
fn local_chain_endpoint_refusals_reach_cli_before_rpc() {
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;
    use std::sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    };
    use std::time::Duration;

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    assert!(listener.local_addr().unwrap().port() >= 20000);
    let url = format!("http://{}", listener.local_addr().unwrap());
    listener.set_nonblocking(true).unwrap();
    let stop = Arc::new(AtomicBool::new(false));
    let calls = Arc::new(AtomicUsize::new(0));
    let server_stop = stop.clone();
    let server_calls = calls.clone();
    let server = std::thread::spawn(move || {
        while !server_stop.load(Ordering::SeqCst) {
            let (mut stream, _) = match listener.accept() {
                Ok(connection) => connection,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(1));
                    continue;
                }
                Err(e) => panic!("{e}"),
            };
            stream.set_nonblocking(false).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut reader = BufReader::new(&mut stream);
            let mut length = 0;
            loop {
                let mut line = String::new();
                assert!(reader.read_line(&mut line).unwrap() > 0);
                if line == "\r\n" {
                    break;
                }
                if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                    length = value.trim().parse::<usize>().unwrap();
                }
            }
            let mut body = vec![0; length];
            reader.read_exact(&mut body).unwrap();
            let request: serde_json::Value = serde_json::from_slice(&body).unwrap();
            server_calls.fetch_add(1, Ordering::SeqCst);
            let response =
                serde_json::json!({"jsonrpc":"2.0", "id":request["id"], "result":1}).to_string();
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                response.len(),
                response
            )
            .unwrap();
        }
    });
    let state = std::env::temp_dir().join(format!(
        "local-chain-refusal-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let run = |mut env: BTreeMap<String, String>| {
        // Preserve planted values; replace only the fixture's local defaults.
        for value in env.values_mut() {
            *value = value.replace("http://127.0.0.1:23456", &url);
        }
        env.insert("MORPHEUS_AUTOMATION_ENABLED".into(), "false".into());
        env.insert(
            "MORPHEUS_RELAYER_STATE_FILE".into(),
            state.to_string_lossy().into(),
        );
        let output = Command::new(env!("CARGO_BIN_EXE_neo-os-relayer"))
            .arg("once")
            .env_clear()
            .envs(env)
            .output()
            .unwrap();
        let _ = std::fs::remove_file(&state);
        output
    };
    let control = run(local_env());
    let control_calls = calls.swap(0, Ordering::SeqCst);
    let mut failures = Vec::new();
    for (name, env) in endpoint_refusal_cases() {
        let output = run(env);
        let count = calls.swap(0, Ordering::SeqCst);
        if output.status.success()
            || count != 0
            || !String::from_utf8_lossy(&output.stderr).contains("local-chain")
        {
            failures.push(format!("{name}: exit={}, RPC calls={count}", output.status));
        }
    }
    stop.store(true, Ordering::SeqCst);
    server.join().unwrap();
    assert!(
        control.status.success(),
        "valid CLI control failed: {}",
        String::from_utf8_lossy(&control.stderr)
    );
    assert!(control_calls > 0, "valid control did not reach the fixture");
    assert!(failures.is_empty(), "CLI refusal bypasses: {failures:?}");
}

#[test]
fn default_stays_public_and_refuses_http() {
    let base = BTreeMap::from([("MORPHEUS_NETWORK".into(), "testnet".into())]);
    let config = create_relayer_config_from_env(&base).unwrap();
    assert!(config.raw["neo_n3"]["rpcUrls"]
        .as_array()
        .unwrap()
        .iter()
        .all(|u| u.as_str().unwrap().starts_with("https://")));
    let mut env = base;
    env.insert(
        "NEO_TESTNET_RPC_URL".into(),
        "http://127.0.0.1:23456".into(),
    );
    assert!(create_relayer_config_from_env(&env)
        .unwrap_err()
        .contains("requires HTTPS"));
}

#[test]
fn chain_client_local_policy_and_default_are_distinct() {
    use neo_os_chain_n3::rpc::NeoRpcClient;
    use neo_os_relayer::transport::RelayerHttpTransport;
    let url = "http://127.0.0.1:23456".to_string();
    assert!(NeoRpcClient::new(RelayerHttpTransport::new(), vec![url.clone()], true).is_err());
    for (node_env, magic) in [
        ("production", 894710606),
        (" PrOdUcTiOn ", 894710606),
        ("test", 860833102),
        ("test", 0),
    ] {
        assert!(NeoRpcClient::new_local(
            RelayerHttpTransport::new(),
            vec![url.clone()],
            node_env,
            magic
        )
        .is_err());
    }
    for url in ["http://[::1]:23456", "http://127.0.0.2:23456"] {
        assert!(NeoRpcClient::new_local(
            RelayerHttpTransport::new(),
            vec![url.into()],
            "test",
            894710606
        )
        .is_ok());
    }
    for url in [
        "https://rpc.example",
        "http://localhost",
        "http://10.0.0.1",
        "http://[::ffff:127.0.0.1]",
        "file:///tmp/rpc",
        "http://u@127.0.0.1",
        "http://127.0.0.1/#x",
    ] {
        assert!(NeoRpcClient::new_local(
            RelayerHttpTransport::new(),
            vec![url.into()],
            "test",
            894710606
        )
        .is_err());
    }
}

#[test]
fn local_rpc_does_not_follow_redirects() {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    let server = TcpListener::bind("127.0.0.1:0").unwrap();
    let trap = TcpListener::bind("127.0.0.1:0").unwrap();
    trap.set_nonblocking(true).unwrap();
    let url = format!("http://{}", server.local_addr().unwrap());
    let target = format!("http://{}", trap.local_addr().unwrap());
    let handle = std::thread::spawn(move || {
        let (mut stream, _) = server.accept().unwrap();
        let mut buf = [0; 4096];
        let received = stream.read(&mut buf).unwrap();
        assert!(received > 0);
        write!(stream, "HTTP/1.1 307 Temporary Redirect\r\nLocation: {target}\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}").unwrap();
    });
    let client = neo_os_chain_n3::rpc::NeoRpcClient::new_local(
        neo_os_relayer::transport::RelayerHttpTransport::new(),
        vec![url],
        "test",
        894710606,
    )
    .unwrap();
    assert!(client.get_block_count().is_err());
    handle.join().unwrap();
    assert_eq!(
        trap.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
}

#[test]
#[ignore = "requires the disposable neo-go fixture from scripts/test-relayer-local-chain.py"]
fn private_chain_scan_and_delivery() {
    use neo_os_core::js_value::{JsObject, JsValue};
    use neo_os_relayer::delivery::{deliver_event_journaled, DeliveryJournal};
    use neo_os_relayer::transport::RelayerHttpTransport;
    use serde_json::{json, Value};
    struct Journal(Value);
    impl DeliveryJournal for Journal {
        fn get(&self, stage: &str) -> Option<Value> {
            (stage == "signed").then(|| self.0.clone())
        }
        fn persist(&self, _: &str, _: Value) -> Result<(), String> {
            Ok(())
        }
        fn ensure_lease(&self) -> Result<(), String> {
            Ok(())
        }
    }
    let path = std::env::var("LOCAL_CHAIN_ACCEPTANCE").expect("private-chain fixture required");
    let fixture: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let mut env = local_env();
    env.insert(
        "MORPHEUS_LOCAL_CHAIN_RPC_URLS".into(),
        fixture["url"].as_str().unwrap().into(),
    );
    env.insert("MORPHEUS_RELAYER_NEO_N3_START_BLOCK".into(), "0".into());
    env.insert("MORPHEUS_RELAYER_NEO_N3_CONFIRMATIONS".into(), "0".into());
    let config = create_relayer_config_from_env(&env).unwrap();
    let transport = RelayerHttpTransport::new();
    let client = neo_os_chain_n3::rpc::NeoRpcClient::new_local(
        &transport,
        vec![fixture["url"].as_str().unwrap().into()],
        "test",
        894710606,
    )
    .unwrap();
    assert_eq!(
        client.call("getversion", json!([])).unwrap()["protocol"]["network"],
        894710606
    );
    // No host/custody stand-in is listening: this test resumes an already signed
    // journal entry, the existing crash-recovery delivery path.
    let journal = Journal(fixture["signed"].clone());
    let deliver = || {
        deliver_event_journaled(
            &config,
            "neo_n3",
            &JsValue::Null,
            &transport,
            &neo_os_chain_n3::tx::FixedNonce(1),
            &neo_os_chain_n3::tx::SystemWaiter,
            &journal,
        )
    };
    let first = deliver().unwrap_err();
    assert!(first.contains("pending confirmation"), "{first}");
    let start = std::time::Instant::now();
    while client
        .get_application_log(fixture["signed"]["tx_hash"].as_str().unwrap())
        .is_err()
    {
        assert!(start.elapsed().as_secs() < 20, "confirmation timed out");
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    let receipt = deliver().unwrap();
    assert_eq!(
        receipt.tx_hash,
        fixture["signed"]["tx_hash"].as_str().unwrap()
    );
    assert_eq!(receipt.vm_state, "HALT");
    let mut state = JsObject::new();
    state.set("neo_n3", JsValue::Object(JsObject::new()));
    let scan = neo_os_relayer::scan::process_chain_neo_n3(&config, &mut state, &transport, 1.0);
    assert!(scan.discovery_healthy && !scan.skipped);
    assert!(scan.scanned_blocks.is_some());
    assert!(
        !client.get_application_log(&receipt.tx_hash).unwrap()["executions"][0]["notifications"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn local_broadcast_accepts_neogo_hash_only_in_local_mode() {
    use neo_os_chain_n3::{rpc::NeoRpcClient, HttpTransport};
    use serde_json::{json, Value};
    struct Reply(Value);
    impl HttpTransport for Reply {
        fn post(&self, _: &str, _: &str) -> Result<(u16, String), String> {
            Ok((
                200,
                json!({"jsonrpc":"2.0", "id":1, "result":self.0}).to_string(),
            ))
        }
        fn get(&self, _: &str) -> Result<(u16, String), String> {
            unreachable!()
        }
        fn post_local(&self, url: &str, body: &str) -> Result<(u16, String), String> {
            self.post(url, body)
        }
    }
    for (reply, expected) in [
        (json!({"hash":format!("0x{}", "a".repeat(64))}), Some(true)),
        (json!({"hash":"0x1234"}), None),
        (json!({"hash":format!("0x{}", "z".repeat(64))}), None),
        (json!({}), None),
        (json!(false), Some(false)),
        (json!(true), Some(true)),
    ] {
        let local = NeoRpcClient::new_local(
            Reply(reply.clone()),
            vec!["http://127.0.0.1:23456".into()],
            "test",
            894710606,
        )
        .unwrap();
        assert_eq!(local.send_raw_transaction("fixture").ok(), expected);
        let public = NeoRpcClient::new(
            Reply(reply.clone()),
            vec!["https://rpc.example".into()],
            false,
        )
        .unwrap();
        assert_eq!(public.send_raw_transaction("fixture").ok(), reply.as_bool());
    }
}
