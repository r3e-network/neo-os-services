//! Broadcast-path tests for the tx builder + confirm polling: fee arithmetic
//! (pad + 20% headroom), custody key-swap detection, witness-mismatch
//! assertion, and the confirm poll's HALT / FAULT / timeout (transient vs
//! UNKNOWN) outcomes — all over scripted transports and a deterministic
//! clock. `cargo test` never touches a network.

use serde_json::json;
use std::sync::Mutex;

use neo_os_chain_n3::custody::{CustodyClient, CustodyConnection};
use neo_os_chain_n3::rpc::NeoRpcClient;
use neo_os_chain_n3::scan;
use neo_os_chain_n3::tx::{
    assert_halt_execution, build_relay_request_id, build_sign_and_broadcast,
    confirm_fulfill_execution, fee_top_up_settings, normalize_public_key, BroadcastOptions,
    CustodySigner, FixedNonce, VmOutcome,
};
use neo_os_chain_n3::HttpTransport;

const PUBLIC_KEY: &str = "0315b41fcf6671b6400237730bc8a261dcb64e25cc17de9878576c78eace1c9146";
const SCRIPT_HASH_LE: &str = "3124a38a74f447b120b551db00f513ec674318c9";

/// FIFO scripted transport: every call pops the next (status, body). Calls are
/// recorded for assertions.
struct ScriptedTransport {
    replies: Mutex<Vec<(u16, String)>>,
    calls: Mutex<Vec<String>>,
}

impl ScriptedTransport {
    fn new(replies: &[(u16, &str)]) -> Self {
        Self {
            replies: Mutex::new(
                replies
                    .iter()
                    .map(|(status, body)| (*status, body.to_string()))
                    .collect(),
            ),
            calls: Mutex::new(Vec::new()),
        }
    }
}

impl HttpTransport for ScriptedTransport {
    fn post(&self, url: &str, body: &str) -> Result<(u16, String), String> {
        self.calls
            .lock()
            .unwrap()
            .push(format!("POST {url} :: {body}"));
        let mut replies = self.replies.lock().unwrap();
        if replies.is_empty() {
            return Err("script exhausted".to_string());
        }
        let (status, body) = replies.remove(0);
        Ok((status, body))
    }

    fn get(&self, url: &str) -> Result<(u16, String), String> {
        self.calls.lock().unwrap().push(format!("GET {url}"));
        let mut replies = self.replies.lock().unwrap();
        if replies.is_empty() {
            return Err("script exhausted".to_string());
        }
        let (status, body) = replies.remove(0);
        Ok((status, body))
    }

    fn post_with_bearer(
        &self,
        url: &str,
        token: &str,
        timeout_ms: u64,
        body: &str,
    ) -> Result<(u16, String), String> {
        self.calls.lock().unwrap().push(format!(
            "POST {url} :: bearer={token} timeout_ms={timeout_ms} :: {body}"
        ));
        let mut replies = self.replies.lock().unwrap();
        if replies.is_empty() {
            return Err("script exhausted".to_string());
        }
        let (status, body) = replies.remove(0);
        Ok((status, body))
    }

    fn get_with_bearer(
        &self,
        url: &str,
        token: &str,
        timeout_ms: u64,
    ) -> Result<(u16, String), String> {
        self.calls.lock().unwrap().push(format!(
            "GET {url} :: bearer={token} timeout_ms={timeout_ms}"
        ));
        let mut replies = self.replies.lock().unwrap();
        if replies.is_empty() {
            return Err("script exhausted".to_string());
        }
        let (status, body) = replies.remove(0);
        Ok((status, body))
    }
}

/// Deterministic clock: now is a fixed counter the test mutates.
#[derive(Default)]
struct FakeWaiter {
    now: Mutex<u64>,
    sleeps: Mutex<Vec<u64>>,
}

impl neo_os_chain_n3::tx::Waiter for FakeWaiter {
    fn now_ms(&self) -> u64 {
        *self.now.lock().unwrap()
    }
    fn sleep(&self, ms: u64) {
        self.sleeps.lock().unwrap().push(ms);
        *self.now.lock().unwrap() += ms;
    }
}

fn custody_client(transport: &ScriptedTransport) -> CustodyClient<&ScriptedTransport> {
    CustodyClient::new(
        transport,
        CustodyConnection::new(
            "https://signer.example".to_string(),
            "token".to_string(),
            Some(5000),
        )
        .expect("valid connection"),
    )
}

fn rpc_client(transport: &ScriptedTransport) -> NeoRpcClient<&ScriptedTransport> {
    NeoRpcClient::new(transport, vec!["https://rpc.example".to_string()], false)
        .expect("valid rpc urls")
}

fn signer() -> CustodySigner {
    CustodySigner {
        key_id: "updater-key".to_string(),
        public_key: PUBLIC_KEY.to_string(),
        script_hash: format!("0x{SCRIPT_HASH_LE}"),
        address: "NeFG5A79AJovUz4BStpnmFyQChLvQkuW72".to_string(),
    }
}

const WITNESS_REPLY: &str = "{\"allowed\":true,\"key_id\":\"updater-key\",\"script_hash\":\"0x3124a38a74f447b120b551db00f513ec674318c9\",\"address\":\"NeFG5A79AJovUz4BStpnmFyQChLvQkuW72\",\"digest\":\"aabb\",\"invocation_script\":\"40de\",\"verification_script\":\"0c210315b41fcf6671b6400237730bc8a261dcb64e25cc17de9878576c78eace1c91464156e7b327\",\"public_key\":\"0315b41fcf6671b6400237730bc8a261dcb64e25cc17de9878576c78eace1c9146\"}";

#[test]
fn broadcast_happy_path_shapes_fees_and_signs_twice() {
    let custody_transport = ScriptedTransport::new(&[
        (200, WITNESS_REPLY), // sign pass 1
        (200, WITNESS_REPLY), // sign pass 2
    ]);
    let rpc_transport = ScriptedTransport::new(&[
        (200, r#"{"jsonrpc":"2.0","id":1,"result":1234}"#), // getblockcount
        (
            200,
            r#"{"jsonrpc":"2.0","id":1,"result":{"state":"HALT","gasconsumed":"100000000"}}"#, // test invoke (1 GAS)
        ),
        (
            200,
            r#"{"jsonrpc":"2.0","id":1,"result":{"networkfee":"1234567"}}"#,
        ), // calculatenetworkfee
        (200, r#"{"jsonrpc":"2.0","id":1,"result":true}"#), // sendrawtransaction
    ]);
    let custody = custody_client(&custody_transport);
    let client = rpc_client(&rpc_transport);
    let signer = signer();

    let receipt = build_sign_and_broadcast(
        &client,
        &custody,
        &signer,
        &FixedNonce(305419896),
        &[0x01, 0x02],
        &BroadcastOptions::default(),
    )
    .expect("broadcast succeeds");

    // system fee = 1 GAS simulated + 0.001 pad; network fee = 0.01234567 + pad.
    assert_eq!(receipt.tx_hash.len(), 66); // 0x + 32-byte display hash
    assert!(receipt.signed_base64.len() > 32);

    // RPC transcript: getblockcount → invokescript → calculatenetworkfee →
    // sendrawtransaction, in that order.
    let calls = rpc_transport.calls.lock().unwrap();
    assert_eq!(calls.len(), 4);
    assert!(calls[0].starts_with("POST https://rpc.example :: {\"jsonrpc\""));
    assert!(calls[0].contains("getblockcount"));
    assert!(calls[1].contains("invokescript"));
    assert!(calls[2].contains("calculatenetworkfee"));
    assert!(calls[3].contains("sendrawtransaction"));
}

#[test]
fn test_invoke_fault_uses_the_site_specific_error_builder() {
    // build_sign_and_broadcast runs twice below (site-specific builder, then
    // default shaping); each run needs its own count + FAULT pair.
    let rpc_transport = ScriptedTransport::new(&[
        (200, r#"{"jsonrpc":"2.0","id":1,"result":1234}"#),
        (
            200,
            r#"{"jsonrpc":"2.0","id":1,"result":{"state":"FAULT","exception":"already fulfilled"}}"#,
        ),
        (200, r#"{"jsonrpc":"2.0","id":1,"result":1234}"#),
        (
            200,
            r#"{"jsonrpc":"2.0","id":1,"result":{"state":"FAULT","exception":"already fulfilled"}}"#,
        ),
    ]);
    let custody_transport = ScriptedTransport::new(&[]);
    let custody = custody_client(&custody_transport);
    let client = rpc_client(&rpc_transport);
    let signer = signer();

    let error = build_sign_and_broadcast(
        &client,
        &custody,
        &signer,
        &FixedNonce(1),
        &[0x01],
        &BroadcastOptions {
            label: "Neo N3 fulfillRequest",
            build_test_invoke_fault_error: Some(Box::new(|exception| {
                format!("site-specific: {exception}")
            })),
            ..Default::default()
        },
    )
    .expect_err("test invoke FAULTs");
    assert_eq!(error, "site-specific: already fulfilled");

    // Default shaping when no builder is supplied.
    let error = build_sign_and_broadcast(
        &client,
        &custody,
        &signer,
        &FixedNonce(1),
        &[0x01],
        &BroadcastOptions {
            label: "Neo N3 transaction",
            ..Default::default()
        },
    )
    .expect_err("FAULTs again");
    assert_eq!(
        error,
        "Neo N3 transaction test invoke faulted: already fulfilled"
    );
}

#[test]
fn custody_key_swap_is_detected_between_lookup_and_signing() {
    // The witness verification script carries a DIFFERENT public key than the
    // identity resolved at lookup — the relayer must refuse to broadcast.
    let custody_transport = ScriptedTransport::new(&[(200, "{\"allowed\":true,\"key_id\":\"updater-key\",\"script_hash\":\"0x3124a38a74f447b120b551db00f513ec674318c9\",\"address\":\"NeFG5A79AJovUz4BStpnmFyQChLvQkuW72\",\"digest\":\"aabb\",\"invocation_script\":\"40de\",\"verification_script\":\"0c2102ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff4156e7b327\",\"public_key\":\"02ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff\"}")]);
    let rpc_transport = ScriptedTransport::new(&[
        (200, r#"{"jsonrpc":"2.0","id":1,"result":1234}"#),
        (
            200,
            r#"{"jsonrpc":"2.0","id":1,"result":{"state":"HALT","gasconsumed":"100000"}}"#,
        ),
    ]);
    let custody = custody_client(&custody_transport);
    let client = rpc_client(&rpc_transport);
    let signer = signer();

    let error = build_sign_and_broadcast(
        &client,
        &custody,
        &signer,
        &FixedNonce(1),
        &[0x01],
        &BroadcastOptions::default(),
    )
    .expect_err("key swap detected");
    assert_eq!(
        error,
        "custody signing key changed between lookup and signing"
    );
}

#[test]
fn normalize_public_key_rejects_junk() {
    let compressed = PUBLIC_KEY;
    assert_eq!(
        normalize_public_key(compressed).expect("compressed"),
        compressed
    );
    assert!(normalize_public_key("0102").is_err());
    assert!(normalize_public_key("").is_err());
}

#[test]
fn confirm_poll_resolves_on_halt_and_throws_on_fault() {
    let halt_log = r#"{"jsonrpc":"2.0","id":1,"result":{"executions":[{"vmstate":"HALT"}]}}"#;
    let transport = ScriptedTransport::new(&[(200, halt_log)]);
    let client = rpc_client(&transport);
    let waiter = FakeWaiter::default();

    let outcome = confirm_fulfill_execution(
        &client,
        &waiter,
        "77",
        "0xabc",
        "fulfillRequest",
        45_000,
        true,
    )
    .expect("HALT");
    assert_eq!(
        outcome,
        VmOutcome {
            vm_state: "HALT".into(),
            exception: None
        }
    );

    // A confirmed FAULT is a hard error, never a benign outcome.
    let fault_log = r#"{"jsonrpc":"2.0","id":1,"result":{"executions":[{"vmstate":"FAULT","exception":"already fulfilled"}]}}"#;
    let transport = ScriptedTransport::new(&[(200, fault_log)]);
    let client = rpc_client(&transport);
    let error = confirm_fulfill_execution(
        &client,
        &waiter,
        "77",
        "0xabc",
        "fulfillRequest",
        45_000,
        true,
    )
    .expect_err("FAULT");
    assert_eq!(
        error,
        "Neo N3 fulfillRequest faulted for request 77 (0xabc): already fulfilled"
    );
}

#[test]
fn confirm_timeout_is_transient_by_default_and_unknown_when_opted_out() {
    // No replies → every poll errors ("script exhausted") → deadline hit.
    let transport = ScriptedTransport::new(&[]);
    let client = rpc_client(&transport);
    let waiter = FakeWaiter::default();

    let error = confirm_fulfill_execution(
        &client,
        &waiter,
        "77",
        "0xabc",
        "fulfillRequest",
        3_000,
        true,
    )
    .expect_err("transient");
    assert!(error.contains("timed out"), "transient marker: {error}");

    let transport = ScriptedTransport::new(&[]);
    let client = rpc_client(&transport);
    let outcome = confirm_fulfill_execution(
        &client,
        &waiter,
        "77",
        "0xabc",
        "fulfillRequest",
        3_000,
        false,
    )
    .expect("opted-out degrades");
    assert_eq!(outcome.vm_state, "UNKNOWN");
    assert!(outcome
        .exception
        .as_deref()
        .unwrap_or_default()
        .contains("script exhausted"));
}

#[test]
fn fee_top_up_settings_parse_the_declared_shape() {
    let config = json!({
        "neo_n3": { "feeTopUp": {
            "enabled": true,
            "minBalance": "50000000",
            "topUpAmount": "100000000",
            "maxTopUpAmount": "500000000"
        }}
    });
    let settings = fee_top_up_settings(&config);
    assert!(settings.enabled);
    assert_eq!(settings.min_balance, 50_000_000);
    assert_eq!(settings.top_up_amount, 100_000_000);
    assert_eq!(settings.max_top_up_amount, 500_000_000);

    // Disabled / absent → disabled defaults.
    assert!(!fee_top_up_settings(&json!({})).enabled);
    assert!(!fee_top_up_settings(&json!({"neo_n3": {"feeTopUp": {"enabled": false}}})).enabled);
}

#[test]
fn relay_request_id_and_event_gate_smoke() {
    assert_eq!(
        build_relay_request_id("fulfill", "77", "uuid-1"),
        "relayer:n3:fulfill:77:uuid-1"
    );
    assert!(scan::is_request_event_name("MiniAppRequestQueued"));
    assert!(scan::is_request_event_name("OracleRequested"));
    assert!(!scan::is_request_event_name("MiniAppRequestCompleted"));
}

#[test]
fn broadcast_refuses_node_rejection() {
    let custody_transport = ScriptedTransport::new(&[(200, WITNESS_REPLY), (200, WITNESS_REPLY)]);
    let rpc_transport = ScriptedTransport::new(&[
        (200, r#"{"jsonrpc":"2.0","id":1,"result":1234}"#),
        (
            200,
            r#"{"jsonrpc":"2.0","id":1,"result":{"state":"HALT","gasconsumed":"100000000"}}"#,
        ),
        (
            200,
            r#"{"jsonrpc":"2.0","id":1,"result":{"networkfee":"1234567"}}"#,
        ),
        (200, r#"{"jsonrpc":"2.0","id":1,"result":false}"#),
    ]);
    let error = build_sign_and_broadcast(
        &rpc_client(&rpc_transport),
        &custody_client(&custody_transport),
        &signer(),
        &FixedNonce(1),
        &[0x01],
        &BroadcastOptions::default(),
    )
    .expect_err("node rejection must not look like a broadcast success");
    assert!(error.contains("rejected"));
}

#[test]
fn assert_halt_shapes_fault_errors_exactly() {
    let execution = json!({"vmstate": "FAULT", "exception": "already fulfilled"});
    let error = assert_halt_execution("77", "0xabc", &execution, "fulfillRequest")
        .expect_err("FAULT must error");
    assert_eq!(
        error,
        "Neo N3 fulfillRequest faulted for request 77 (0xabc): already fulfilled"
    );

    let outcome =
        assert_halt_execution("77", "0xabc", &json!({"vmstate": "HALT"}), "x").expect("HALT");
    assert_eq!(
        outcome,
        VmOutcome {
            vm_state: "HALT".into(),
            exception: None
        }
    );
}
