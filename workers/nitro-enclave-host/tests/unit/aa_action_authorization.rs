use super::*;
use std::sync::{Arc, Mutex};

#[derive(Clone)]
struct FakeRpc {
    context: Context,
    request: AaActionAuthorizationRequest,
    mode: &'static str,
    calls: Arc<Mutex<Vec<Value>>>,
}

fn root() -> String {
    format!("0x{}", "ab".repeat(32))
}
fn item_bytes(bytes: &[u8]) -> Value {
    json!({"type":"ByteString","value":STANDARD.encode(bytes)})
}
fn integer(value: &str) -> Value {
    json!({"type":"Integer","value":value})
}
fn fixture() -> (Context, AaActionAuthorizationRequest) {
    let overlay = BTreeMap::from([
        ("MORPHEUS_NETWORK".into(), "mainnet".into()),
        (
            "NEO_MAINNET_RPC_URLS".into(),
            "https://rpc.fixture.invalid".into(),
        ),
    ]);
    let context = Context::from_overlay(&overlay).unwrap();
    let request = AaActionAuthorizationRequest {
        network: " neo_n3 e\u{301} ".into(),
        aa_contract: context.core_raw.clone(),
        account_id_raw: format!("0x{}", "12".repeat(20)),
        verifier_contract: context.verifier_raw.clone(),
        account_id: " account e\u{301} ".into(),
        master_nullifier: format!("0x{}", "34".repeat(32)),
        authorization_epoch: "2".into(),
        session_nonce: "7".into(),
        expires_at: "2000".into(),
    };
    (context, request)
}
fn contract(hash: &str, verifier: bool) -> Value {
    let method = |name: &str, args: &[&str], returns: &str, safe: bool| {
        json!({
            "name":name,"parameters":args.iter().map(|t|json!({"type":t})).collect::<Vec<_>>(),
            "returntype":returns,"safe":safe
        })
    };
    let methods = if verifier {
        vec![
            method(
                "getActionAuthorization",
                &["Hash160", "ByteArray"],
                "Any",
                true,
            ),
            method("getActionProtocolVersion", &[], "Integer", true),
            method(
                "submitActionTicketV4",
                &[
                    "Hash160",
                    "Hash160",
                    "String",
                    "Integer",
                    "ByteArray",
                    "Integer",
                    "ByteArray",
                    "ByteArray",
                ],
                "Void",
                false,
            ),
        ]
    } else {
        vec![method("getVerifier", &["Hash160"], "Hash160", true)]
    };
    json!({"hash":hash,"manifest":{"abi":{"methods":methods}}})
}
impl HttpTransport for FakeRpc {
    fn get(&self, _: &str) -> Result<(u16, String), String> {
        panic!("GET is not a reader operation")
    }
    fn post(&self, endpoint: &str, body: &str) -> Result<(u16, String), String> {
        assert_eq!(endpoint, self.context.endpoint);
        let call: Value = serde_json::from_str(body).unwrap();
        self.calls.lock().unwrap().push(call.clone());
        let params = &call["params"];
        let result = match call["method"].as_str().unwrap() {
            "getversion" => {
                json!({"protocol":{"network":if self.mode=="magic" {0} else {self.context.magic}}})
            }
            "getblockhash" => {
                assert_eq!(params, &json!([0]));
                json!(if self.mode == "genesis" {
                    root()
                } else {
                    self.context.genesis.clone()
                })
            }
            "getcontractstate" => {
                let verifier = params[0] == self.context.verifier_display;
                let mut c = contract(params[0].as_str().unwrap(), verifier);
                if verifier && self.mode == "old-abi" {
                    c["manifest"]["abi"]["methods"] = json!([]);
                }
                c
            }
            "getstateheight" => json!({"localrootindex":42,"validatedrootindex":42}),
            "getstateroot" => {
                assert_eq!(params, &json!([42]));
                json!({"index":if self.mode=="index" {41}else{42},"roothash":if self.mode=="root-shape" {"0x00".to_string()}else{root()}})
            }
            "getblockheader" => {
                assert_eq!(params, &json!([42, 1]));
                json!({"index":if self.mode=="header-index" {41}else{42},
                    "time":match self.mode {"stale-root"=>1,"future-root"=>2000,_=>900}})
            }
            "invokefunctionhistoric" => {
                assert_eq!(params[0], root());
                assert_eq!(
                    params[3][0],
                    json!({"type":"ByteArray","value":STANDARD.encode(hex::decode(&self.request.account_id_raw[2..]).unwrap())})
                );
                if self.mode == "fault" {
                    json!({"state":"FAULT","exception":"synthetic-secret","stack":[]})
                } else if params[2] == "getVerifier" {
                    assert_eq!(params[1], self.context.core_display);
                    let raw = if self.mode == "installation" {
                        vec![0x55; 20]
                    } else {
                        hex::decode(&self.context.verifier_raw[2..]).unwrap()
                    };
                    json!({"state":"HALT","stack":[item_bytes(&raw)]})
                } else {
                    assert_eq!(params[1], self.context.verifier_display);
                    assert_eq!(params[2], "getActionAuthorization");
                    assert_eq!(
                        params[3][1],
                        json!({"type":"ByteArray","value":STANDARD.encode(hex::decode(&self.request.master_nullifier[2..]).unwrap())})
                    );
                    let mut fields = vec![
                        integer("4"),
                        item_bytes(&hex::decode(&self.context.core_raw[2..]).unwrap()),
                        item_bytes(&hex::decode(&self.context.verifier_raw[2..]).unwrap()),
                        item_bytes(&[0x56; 20]),
                        item_bytes(self.request.network.as_bytes()),
                        item_bytes(self.request.account_id.as_bytes()),
                        integer("2"),
                        integer("7"),
                        json!({"type":"Boolean","value":true}),
                    ];
                    if let Some(index) = self.mode.strip_prefix("type-") {
                        fields[index.parse::<usize>().unwrap()] =
                            json!({"type":"Any","value":null});
                    }
                    match self.mode {
                        "owner" => fields[3] = item_bytes(&[0; 20]),
                        "owner-type" => fields[3] = json!({"type":"Integer","value":"1"}),
                        "epoch" => fields[6] = integer("3"),
                        "nonce" => fields[7] = integer("8"),
                        "grant" => fields[8] = json!({"type":"Boolean","value":false}),
                        "grant-type" => fields[8] = json!({"type":"Boolean","value":"true"}),
                        "text" => fields[4] = item_bytes(self.request.network.trim().as_bytes()),
                        "arity" => {
                            fields.pop();
                        }
                        _ => (),
                    }
                    json!({"state":"HALT","stack":[{"type":"Struct","value":fields}]})
                }
            }
            other => panic!("unapproved RPC {other}"),
        };
        let id = if self.mode == "response-id" {
            json!(2)
        } else {
            call["id"].clone()
        };
        Ok((
            200,
            json!({"jsonrpc":"2.0","id":id,"result":result}).to_string(),
        ))
    }
}
fn run(
    mode: &'static str,
    now: u64,
) -> (
    Result<AaActionAuthorizationSnapshot, String>,
    Arc<Mutex<Vec<Value>>>,
) {
    let (context, request) = fixture();
    let calls = Arc::new(Mutex::new(Vec::new()));
    let fake = FakeRpc {
        context: context.clone(),
        request: request.clone(),
        mode,
        calls: calls.clone(),
    };
    let rpc = NeoRpcClient::new(fake, vec![context.endpoint.clone()], false).unwrap();
    (read_with_rpc(&context, &rpc, &request, &|| now), calls)
}
#[test]
fn actual_reader_uses_one_identity_and_explicit_root_for_both_reads() {
    let (result, calls) = run("good", 1000);
    let result = result.unwrap();
    assert_eq!(result.core_state_root, root());
    assert_eq!(result.verifier_state_root, root());
    assert_eq!(result.owner, format!("0x{}", "56".repeat(20)));
    assert_eq!(result.observed_time_ms, "1000");
    assert_eq!(result.network, " neo_n3 e\u{301} ");
    assert_eq!(
        calls
            .lock()
            .unwrap()
            .iter()
            .filter(|c| c["method"] == "invokefunctionhistoric")
            .count(),
        2
    );
}
#[test]
fn identity_old_abi_root_owner_grant_epoch_nonce_and_types_refuse() {
    for mode in [
        "magic",
        "genesis",
        "old-abi",
        "index",
        "root-shape",
        "header-index",
        "future-root",
        "fault",
        "installation",
        "owner",
        "owner-type",
        "epoch",
        "nonce",
        "grant",
        "grant-type",
        "text",
        "arity",
        "response-id",
        "type-0",
        "type-1",
        "type-2",
        "type-3",
        "type-4",
        "type-5",
        "type-6",
        "type-7",
        "type-8",
    ] {
        let (result, _) = run(mode, 1000);
        assert_eq!(result.unwrap_err(), DENIED, "{mode}");
    }
}
#[test]
fn host_clock_expiry_and_wrong_targets_refuse_without_authority_io() {
    let (result, calls) = run("good", 2000);
    assert_eq!(result.unwrap_err(), DENIED);
    assert!(calls.lock().unwrap().is_empty());
    let (context, mut request) = fixture();
    request.aa_contract = format!("0x{}", "77".repeat(20));
    let calls = Arc::new(Mutex::new(Vec::new()));
    let fake = FakeRpc {
        context: context.clone(),
        request: request.clone(),
        mode: "good",
        calls: calls.clone(),
    };
    let rpc = NeoRpcClient::new(fake, vec![context.endpoint.clone()], false).unwrap();
    assert_eq!(
        read_with_rpc(&context, &rpc, &request, &|| 1000).unwrap_err(),
        DENIED
    );
    assert!(calls.lock().unwrap().is_empty());
}
#[test]
fn display_targets_and_raw_ticket_hashes_are_not_silently_interchanged() {
    let (context, mut request) = fixture();
    assert_ne!(context.core_display, context.core_raw);
    request.aa_contract = context.core_display.clone();
    let fake = FakeRpc {
        context: context.clone(),
        request: request.clone(),
        mode: "good",
        calls: Arc::new(Mutex::new(Vec::new())),
    };
    let rpc = NeoRpcClient::new(fake, vec![context.endpoint.clone()], false).unwrap();
    assert!(read_with_rpc(&context, &rpc, &request, &|| 1000).is_err());
}

#[test]
fn stale_root_and_expiry_during_io_refuse_using_host_clock() {
    let (context, mut request) = fixture();
    request.expires_at = "100000".into();
    let fake = FakeRpc {
        context: context.clone(),
        request: request.clone(),
        mode: "stale-root",
        calls: Arc::new(Mutex::new(Vec::new())),
    };
    let rpc = NeoRpcClient::new(fake, vec![context.endpoint.clone()], false).unwrap();
    assert_eq!(
        read_with_rpc(&context, &rpc, &request, &|| 40000).unwrap_err(),
        DENIED
    );
    let (context, request) = fixture();
    let fake = FakeRpc {
        context: context.clone(),
        request: request.clone(),
        mode: "good",
        calls: Arc::new(Mutex::new(Vec::new())),
    };
    let rpc = NeoRpcClient::new(fake, vec![context.endpoint.clone()], false).unwrap();
    let ticks = std::cell::Cell::new(0);
    let clock = || {
        let n = ticks.get();
        ticks.set(n + 1);
        if n < 2 {
            1000
        } else {
            2000
        }
    };
    assert_eq!(
        read_with_rpc(&context, &rpc, &request, &clock).unwrap_err(),
        DENIED
    );
}
