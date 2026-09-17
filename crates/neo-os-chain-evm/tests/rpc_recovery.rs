use neo_os_chain_evm::{rpc::EvmRpcClient, HttpTransport};
use std::sync::Mutex;

struct Scripted(Mutex<Vec<(u16, String)>>);
impl HttpTransport for Scripted {
    fn post(&self, _: &str, _: &str) -> Result<(u16, String), String> {
        Ok(self.0.lock().unwrap().remove(0))
    }
    fn get(&self, _: &str) -> Result<(u16, String), String> {
        unreachable!()
    }
}
fn client(replies: Vec<(u16, String)>) -> EvmRpcClient<Scripted> {
    EvmRpcClient::new(
        "https://a.example".into(),
        vec!["https://b.example".into()],
        Scripted(Mutex::new(replies)),
    )
}

#[test]
fn unhealthy_rpc_responses_fail_over_before_json_decoding() {
    for first in [
        (502, "<html>upstream unavailable</html>".into()),
        (429, "rate limited".into()),
        (200, "broken JSON".into()),
        (
            200,
            r#"{"error":{"code":-32002,"message":"resource unavailable"}}"#.into(),
        ),
        (
            200,
            r#"{"error":{"code":-32005,"message":"limit exceeded"}}"#.into(),
        ),
    ] {
        assert_eq!(
            client(vec![first, (200, r#"{"result":"0x2a"}"#.into())])
                .block_number()
                .unwrap(),
            42
        );
    }
}

#[test]
fn scan_never_swallows_unresolved_request_or_bad_abi() {
    for reply in [
        r#"{"error":{"code":3,"message":"execution reverted"}}"#,
        r#"{"result":"0x"}"#,
        r#"{"result":"0x1234"}"#,
        r#"{"result":"0x1"}"#,
        r#"{"result":"0xgg"}"#,
    ] {
        assert!(client(vec![(200, reply.into())])
            .scan_requests_by_id("0xabc", 102, 102)
            .is_err());
    }
}

#[test]
fn get_request_decodes_the_real_solidity_dynamic_struct_envelope() {
    let vector: serde_json::Value =
        serde_json::from_str(include_str!("vectors/get_request.json")).unwrap();
    let record = client(vec![(
        200,
        serde_json::json!({"result":vector["encoded"]}).to_string(),
    )])
    .get_request("0xabc", 42)
    .unwrap()
    .unwrap();
    assert_eq!(record["id"], 42);
    assert_eq!(record["appId"], "app");
    assert_eq!(record["moduleId"], "module");
    assert_eq!(record["status"], 2);
    assert_eq!(record["payload"], "0x010203");
    assert_eq!(record["resultBytes"], "0xaa");
}

#[test]
fn send_raw_transaction_requires_a_valid_hash() {
    for result in [
        r#"{"result":""}"#,
        r#"{"result":"0x1234"}"#,
        r#"{"result":"0xzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"}"#,
        r#"{"result":true}"#,
    ] {
        assert!(client(vec![(200, result.into())])
            .send_raw_transaction("0xdead")
            .is_err());
    }
    let hash = format!("0x{}", "ab".repeat(32));
    let body = serde_json::json!({"result": hash}).to_string();
    assert!(client(vec![(200, body)])
        .send_raw_transaction("0xdead")
        .is_ok());
}
