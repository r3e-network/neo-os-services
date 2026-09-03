//! The HTTP surface as a caller meets it: status, shape, and what stays behind.
//!
//! [`crate::service`]'s own tests already prove what a boundary means. These
//! prove the transport does not change the answer on the way out — that a
//! refusal's `detail` does not ride in the body, that §5's status map holds for
//! the codes whose outcome and status disagree, that a caller token is readable
//! exactly once, and that a request never reaches a decision without first
//! passing the checks that can be answered without one.
//!
//! Every case goes through [`router`] with `oneshot`, so the assertions are about
//! the wire: bytes in, bytes out, and no socket in between.

use anyhow::Result;
use axum::{
    body::Body,
    http::{Method, StatusCode},
};
use ed25519_dalek::{Signer as _, SigningKey};
use serde_json::{json, Value};
use tower::ServiceExt;

use super::*;
use crate::{
    auth::AccessRejection,
    policy::{self, DenyReason},
    service::provision_admin_caller,
    store::Store,
    tx,
    vault::MasterKey,
};

/// A recipient, an account that is not the harness key's.
const RECIPIENT: [u8; tx::HASH160_LEN] = [0x22u8; tx::HASH160_LEN];

/// A 32-byte scalar above the curve's order, so no path can turn it into a key:
/// a caller's mistake that must be refused, and one whose text can be looked for
/// in a response without a false alarm.
const NOT_A_SECRET: &str = "ffffffffffffffffffffffffffffffff00112233445566778899aabbccddeeff";

// -- harness --------------------------------------------------------------

/// A vault, a router over it, and the two credentials every request needs.
///
/// The bootstrap is itself a sequence of HTTP calls — generate, set the
/// boundary, create the signing caller — because a harness that seeded the
/// database directly would leave the three most-used management routes untested
/// before the first assertion ran.
struct Api {
    router: Router,
    service: SignerService,
    admin: String,
    signer: String,
    caller_id: String,
    key_id: String,
    account: [u8; tx::HASH160_LEN],
    // Declared last so it outlives everything that reads through it.
    _dir: tempfile::TempDir,
}

struct WorkloadClient {
    caller_id: String,
    subject: Option<String>,
    signing_key: SigningKey,
}

impl Api {
    async fn open() -> Result<Self> {
        let dir = tempfile::tempdir()?;
        let repository = Store::open(dir.path().join("signer.db"))?;
        let service = SignerService::new(repository, MasterKey::from_bytes([9u8; 32]));
        let (bootstrap, admin_token) = provision_admin_caller(service.repository(), "bootstrap")?;
        let mut api = Api {
            router: router(ApiState::new(service.clone())),
            service,
            admin: admin_token,
            signer: String::new(),
            caller_id: bootstrap.id,
            key_id: String::new(),
            account: [0u8; tx::HASH160_LEN],
            _dir: dir,
        };

        let key = api
            .post(
                "/keys",
                Some(&api.admin.clone()),
                json!({"label": "treasury", "network": "testnet"}),
            )
            .await;
        assert_eq!(key.status, StatusCode::OK, "{key:?}");
        api.key_id = key.field("key_id");
        api.account = ScriptHash::from_str(&key.field("script_hash"))
            .expect("the key body's script hash should parse")
            .as_bytes();

        // The default boundary permits nothing (§4.2), so a transfer only signs
        // once the management route has opened it — which is as much the point of
        // the call below as of the tests that use it.
        let policy = api
            .post(
                &format!("/keys/{}/policy", api.key_id.clone()),
                Some(&api.admin.clone()),
                json!({"allow_transfer": true}),
            )
            .await;
        assert_eq!(policy.status, StatusCode::OK, "{policy:?}");

        let caller = api
            .post(
                "/callers",
                Some(&api.admin.clone()),
                json!({
                    "label": "relayer",
                    "capabilities": ["sign"],
                    "key_grant": {"mode": "any"},
                }),
            )
            .await;
        assert_eq!(caller.status, StatusCode::OK, "{caller:?}");
        api.signer = caller.field("token");
        api.caller_id = caller.json()["caller"]["id"]
            .as_str()
            .expect("the caller body should name its id")
            .to_string();
        Ok(api)
    }

    async fn raw_caller_for(&self, key_id: &str) -> (String, String) {
        let caller = self
            .post(
                "/callers",
                Some(&self.admin),
                json!({
                    "label": "raw-lane",
                    "capabilities": ["raw_sign"],
                    "key_grant": {"mode": "only", "key_ids": [key_id]},
                }),
            )
            .await;
        assert_eq!(caller.status, StatusCode::OK, "{caller:?}");
        (
            caller.json()["caller"]["id"]
                .as_str()
                .expect("caller id")
                .to_string(),
            caller.field("token"),
        )
    }

    async fn raw_role(&self) -> (String, String) {
        let key = self
            .post(
                "/keys",
                Some(&self.admin),
                json!({"label": "raw-role", "network": "testnet"}),
            )
            .await;
        assert_eq!(key.status, StatusCode::OK, "{key:?}");
        let key_id = key.field("key_id");
        let policy = self
            .post(
                &format!("/keys/{key_id}/policy"),
                Some(&self.admin),
                json!({"allow_raw": true}),
            )
            .await;
        assert_eq!(policy.status, StatusCode::OK, "{policy:?}");
        let (_, token) = self.raw_caller_for(&key_id).await;
        (key_id, token)
    }

    fn request(
        &self,
        method: Method,
        path: &str,
        token: Option<&str>,
        body: Option<Value>,
    ) -> Request {
        let mut builder = Request::builder()
            .method(method)
            .uri(format!("{API_PREFIX}{path}"))
            .header("content-type", "application/json");
        if let Some(token) = token {
            builder = builder.header("authorization", format!("Bearer {token}"));
        }
        builder
            .body(body.map_or_else(Body::empty, |value| Body::from(value.to_string())))
            .expect("the request should build")
    }

    /// The same vault behind a lower body ceiling, for the case that has to
    /// prove the ceiling is a real number and not documentation.
    async fn send_with_limit(&self, max_body_bytes: usize, request: Request) -> Reply {
        let router = router(ApiState::new(self.service.clone()).with_body_limit(max_body_bytes));
        self.send_on(router, request).await
    }

    async fn get(&self, path: &str, token: Option<&str>) -> Reply {
        self.send(self.request(Method::GET, path, token, None))
            .await
    }

    async fn post(&self, path: &str, token: Option<&str>, body: Value) -> Reply {
        self.send(self.request(Method::POST, path, token, Some(body)))
            .await
    }

    async fn workload_post(
        &self,
        path: &str,
        identity: &WorkloadClient,
        timestamp: u64,
        nonce: &str,
        body: Value,
    ) -> Reply {
        let route = format!("{API_PREFIX}{path}");
        let body = body.to_string();
        let body_digest = crate::auth::body_sha256(body.as_bytes());
        let message = crate::auth::WorkloadMessage {
            caller_id: &identity.caller_id,
            subject: identity.subject.as_deref(),
            timestamp,
            nonce,
            method: "POST",
            route: &route,
            body_digest: &body_digest,
            origin: None,
        }
        .to_bytes();
        let signature = hex::encode(identity.signing_key.sign(&message).to_bytes());
        let request = Request::builder()
            .method(Method::POST)
            .uri(&route)
            .header("content-type", "application/json")
            .header(WORKLOAD_CALLER_HEADER, &identity.caller_id)
            .header(WORKLOAD_TIMESTAMP_HEADER, timestamp.to_string())
            .header(WORKLOAD_NONCE_HEADER, nonce)
            .header(WORKLOAD_SIGNATURE_HEADER, signature)
            .body(Body::from(body))
            .expect("the workload request should build");
        self.send(request).await
    }

    async fn delete(&self, path: &str, token: Option<&str>) -> Reply {
        self.send(self.request(Method::DELETE, path, token, None))
            .await
    }

    async fn send(&self, request: Request) -> Reply {
        self.send_on(self.router.clone(), request).await
    }

    async fn send_on(&self, router: Router, request: Request) -> Reply {
        let response = router
            .oneshot(request)
            .await
            .expect("the router never fails a request outright");
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("the body should be readable");
        Reply {
            status,
            text: String::from_utf8(bytes.to_vec()).expect("every answer is UTF-8"),
        }
    }

    /// Ask for a witness, over HTTP, with whatever token the case is about.
    async fn sign(&self, token: Option<&str>, key_id: &str, unsigned_hex: &str) -> Reply {
        self.post(
            "/sign/transaction",
            token,
            json!({"key_id": key_id, "unsigned_hex": unsigned_hex}),
        )
        .await
    }

    /// A NEO transfer of `amount` from the vault's own key, as `unsigned_hex`.
    fn transfer(&self, amount: i128, nonce: u32) -> String {
        let script = transfer_script(self.account, RECIPIENT, amount, tx::native::NEO);
        hex::encode(transaction(self.account, nonce, &script))
    }

    /// The vault's keys, read as the management route serves them.
    async fn list_keys(&self) -> Vec<Value> {
        let reply = self.get("/keys", Some(&self.admin.clone())).await;
        assert_eq!(reply.status, StatusCode::OK, "{reply:?}");
        reply.json()["keys"].as_array().expect("keys").clone()
    }

    async fn list_callers(&self) -> Vec<Value> {
        let reply = self.get("/callers", Some(&self.admin.clone())).await;
        assert_eq!(reply.status, StatusCode::OK, "{reply:?}");
        reply.json()["callers"].as_array().expect("callers").clone()
    }

    /// The audit trail as the store has it, not as a route rendered it.
    fn audit(&self) -> Vec<SignerAuditRecord> {
        self.service
            .repository()
            .list_signer_audit(None, 500)
            .expect("the audit trail should read")
    }

    /// Rows recorded for `action`, oldest first.
    fn audit_for(&self, action: SignerAuditAction) -> Vec<SignerAuditRecord> {
        self.audit()
            .into_iter()
            .filter(|record| record.action == action)
            .collect()
    }
}

// -- responses ------------------------------------------------------------

/// A reply kept as text, so the raw bytes can be searched as well as parsed.
///
/// Two of the assertions below are about what a body does *not* contain, and
/// those have to run against the bytes: a value that parses to the expected
/// fields can still carry the thing that should not be there.
#[derive(Debug)]
struct Reply {
    status: StatusCode,
    text: String,
}

impl Reply {
    fn json(&self) -> Value {
        serde_json::from_str(&self.text)
            .unwrap_or_else(|error| panic!("expected JSON, got {error}: {}", self.text))
    }

    fn field(&self, name: &str) -> String {
        self.json()[name]
            .as_str()
            .unwrap_or_else(|| panic!("{} has no string field {name}: {}", self.status, self.text))
            .to_string()
    }

    /// The top-level keys, sorted, so a response can be pinned to a shape rather
    /// than checked field by field for the absence of one.
    fn keys(&self) -> Vec<String> {
        let mut keys: Vec<String> = self
            .json()
            .as_object()
            .expect("every answer is a JSON object")
            .keys()
            .cloned()
            .collect();
        keys.sort();
        keys
    }

    /// The refusal code, or an empty string for a body that carries none.
    fn code(&self) -> String {
        self.json()
            .get("code")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    }
}

// -- request builders -----------------------------------------------------
//
// The same shape as `tests/unit/service.rs`'s, written out again rather than
// shared: each of these files compiles as its own module of the library's test
// build, and a hand-written call script is worth reading in the file that uses
// it.

/// `PUSHDATA1`, the only push width a hand-written call script needs here.
fn push_bytes(bytes: &[u8]) -> Vec<u8> {
    let mut out = vec![0x0c, bytes.len() as u8];
    out.extend_from_slice(bytes);
    out
}

/// Fewest little-endian bytes that still read back as `value`.
fn minimal_le_bytes(value: i128) -> Vec<u8> {
    let all = value.to_le_bytes();
    let filler = if value < 0 { 0xffu8 } else { 0u8 };
    let mut length = 1usize;
    loop {
        let top = all[length - 1];
        let sign_honest = if value < 0 {
            top & 0x80 != 0
        } else {
            top & 0x80 == 0
        };
        if sign_honest && all[length..].iter().all(|byte| *byte == filler) {
            break;
        }
        length += 1;
    }
    all[..length].to_vec()
}

/// A `PUSHINT*` of the widths the VM defines (1, 2, 4, 8 bytes).
fn push_integer(value: i128) -> Vec<u8> {
    let bytes = minimal_le_bytes(value);
    let (opcode, width): (u8, usize) = match bytes.len() {
        1 => (0x00, 1),
        2 => (0x01, 2),
        3..=4 => (0x02, 4),
        _ => (0x03, 8),
    };
    let mut out = vec![opcode];
    out.extend_from_slice(&bytes);
    out.resize(1 + width, if value < 0 { 0xff } else { 0x00 });
    out
}

/// A NEP-17 `transfer` call, arguments last-first.
fn transfer_script(
    from: [u8; tx::HASH160_LEN],
    to: [u8; tx::HASH160_LEN],
    amount: i128,
    asset: [u8; tx::HASH160_LEN],
) -> Vec<u8> {
    let mut script = Vec::new();
    script.push(0x0b);
    script.extend(push_integer(amount));
    script.extend(push_bytes(&to));
    script.extend(push_bytes(&from));
    script.extend([0x14, 0xc0]);
    script.push(0x1f);
    script.extend(push_bytes(b"transfer"));
    script.extend(push_bytes(&asset));
    script.push(0x41);
    script.extend(tx::CONTRACT_CALL_INTEROP);
    script
}

/// `SerializeUnsigned` for a transaction signed by exactly `account`.
fn transaction(account: [u8; tx::HASH160_LEN], nonce: u32, script: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    out.push(0u8);
    out.extend_from_slice(&nonce.to_le_bytes());
    out.extend_from_slice(&0i64.to_le_bytes());
    out.extend_from_slice(&0i64.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.push(1);
    out.extend_from_slice(&account);
    out.push(tx::Scope::CALLED_BY_ENTRY);
    out.push(0);
    out.push(script.len() as u8);
    out.extend_from_slice(script);
    out
}

/// `SerializeUnsigned` for an extensible payload — the container dBFT uses.
fn consensus_payload(category: &str, sender: [u8; tx::HASH160_LEN]) -> Vec<u8> {
    let mut out = vec![category.len() as u8];
    out.extend_from_slice(category.as_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&200u32.to_le_bytes());
    out.extend_from_slice(&sender);
    let data = [
        vec![0x40],
        200u32.to_le_bytes().to_vec(),
        vec![0, 0],
        1u64.to_le_bytes().to_vec(),
    ]
    .concat();
    out.push(data.len() as u8);
    out.extend(data);
    out
}

// -- the caller-facing routes (§5) ----------------------------------------

#[tokio::test]
async fn a_signed_transaction_answers_with_a_witness() {
    let api = Api::open().await.expect("vault");
    let reply = api
        .sign(
            Some(&api.signer.clone()),
            &api.key_id.clone(),
            &api.transfer(100, 1),
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{reply:?}");
    assert_eq!(
        reply.keys(),
        [
            "address",
            "allowed",
            "digest",
            "invocation_script",
            "key_id",
            "script_hash",
            "verification_script"
        ],
        "§5's success body, flattened, and nothing beside it"
    );
    assert!(reply.json()["allowed"].as_bool().expect("allowed"));
    assert_eq!(reply.field("key_id"), api.key_id);
    // Two hex conventions on one body, and both are worth pinning: a client that
    // stripped a prefix it did not expect to find would send back bytes that are
    // one character short.
    let digest = reply.field("digest");
    let digest_bytes = hex::decode(digest.strip_prefix("0x").expect("a 0x-prefixed digest"))
        .unwrap_or_else(|error| panic!("digest should be hexadecimal ({digest}): {error}"));
    assert_eq!(digest_bytes.len(), 32, "the digest is the signing hash");
    for field in ["invocation_script", "verification_script"] {
        let hex_text = reply.field(field);
        let bytes = hex::decode(&hex_text)
            .unwrap_or_else(|error| panic!("{field} should be bare hex ({hex_text}): {error}"));
        assert!(!bytes.is_empty(), "{field} must not be an empty hex string");
    }
    assert_eq!(
        reply.field("script_hash"),
        ScriptHash::from(api.account).to_display(),
        "the witness is for the account the key is for, and the route says so"
    );
}

#[tokio::test]
async fn request_id_is_idempotent_and_conflicts_answer_409() {
    let api = Api::open().await.expect("vault");
    let path = "/sign/transaction";
    let body = json!({
        "key_id": api.key_id.clone(),
        "unsigned_hex": api.transfer(10, 61),
        "request_id": "web-job:61",
    });
    let first = api
        .post(path, Some(&api.signer.clone()), body.clone())
        .await;
    assert_eq!(first.status, StatusCode::OK, "{first:?}");
    let repeated = api.post(path, Some(&api.signer.clone()), body).await;
    assert_eq!(repeated.status, StatusCode::OK, "{repeated:?}");
    assert_eq!(repeated.json(), first.json());

    let conflict = api
        .post(
            path,
            Some(&api.signer.clone()),
            json!({
                "key_id": api.key_id.clone(),
                "unsigned_hex": api.transfer(10, 62),
                "request_id": "web-job:61",
            }),
        )
        .await;
    assert_eq!(conflict.status, StatusCode::CONFLICT, "{conflict:?}");
    assert_eq!(conflict.code(), audit::REQUEST_ID_CONFLICT);

    let invalid = api
        .post(
            path,
            Some(&api.signer.clone()),
            json!({
                "key_id": api.key_id.clone(),
                "unsigned_hex": api.transfer(10, 63),
                "request_id": "spaces are not accepted",
            }),
        )
        .await;
    assert_eq!(invalid.status, StatusCode::BAD_REQUEST, "{invalid:?}");
    assert_eq!(invalid.code(), audit::REQUEST_ID_INVALID);
}

#[tokio::test]
async fn a_missing_token_is_refused_and_recorded() {
    let api = Api::open().await.expect("vault");
    let reply = api
        .sign(None, &api.key_id.clone(), &api.transfer(100, 2))
        .await;
    assert_eq!(reply.status, StatusCode::FORBIDDEN, "{reply:?}");
    assert_eq!(reply.code(), "missing-token");
    assert_eq!(reply.keys(), ["allowed", "code", "message"]);
    // The transport cannot answer this one: an extractor that rejected the
    // request for want of a header would leave the denial unlogged.
    let refusals = api.audit_for(SignerAuditAction::TransactionSigned);
    assert_eq!(refusals.len(), 1, "{refusals:#?}");
    assert_eq!(refusals[0].outcome, SignerAuditOutcome::Denied);
    assert_eq!(refusals[0].caller_id, None);
}

#[tokio::test]
async fn a_signing_credential_on_a_management_route_is_refused() {
    let api = Api::open().await.expect("vault");
    let reply = api
        .post(
            "/keys",
            Some(&api.signer.clone()),
            json!({"label": "not-yours", "network": "testnet"}),
        )
        .await;
    assert_eq!(reply.status, StatusCode::FORBIDDEN, "{reply:?}");
    // One code in both directions is the point: the endpoint cannot be used to
    // classify a bearer string as signing or administrative.
    assert_eq!(reply.code(), "admin-capability-missing");
    // The refusal is a row as much as the success was: two KeyGenerated events,
    // one key.
    assert_eq!(api.audit_for(SignerAuditAction::KeyGenerated).len(), 2);
    assert_eq!(
        api.list_keys().await.len(),
        1,
        "the refused request must not have created a key"
    );
}

#[tokio::test]
async fn an_unknown_token_and_an_unknown_key_answer_differently() {
    let api = Api::open().await.expect("vault");
    let token = api
        .sign(
            Some("not-a-token"),
            &api.key_id.clone(),
            &api.transfer(1, 3),
        )
        .await;
    let key = api
        .sign(
            Some(&api.signer.clone()),
            "key-does-not-exist",
            &api.transfer(1, 4),
        )
        .await;
    assert_eq!(token.status, StatusCode::FORBIDDEN, "{token:?}");
    assert_eq!(token.code(), "unknown-token");
    // `Failed` in the outcome, yet `404` on the wire: "nothing is held under
    // that id" is the answer an operator needs, and `500` would send them to the
    // vault. One of the two codes §5's map must match before it looks at the
    // outcome — the other is the unparsable-transaction case below.
    assert_eq!(key.status, StatusCode::NOT_FOUND, "{key:?}");
    assert_eq!(key.code(), "signer-key-unknown");
}

#[tokio::test]
async fn a_policy_denial_keeps_its_specifics_out_of_the_body() {
    let api = Api::open().await.expect("vault");
    let capped = api
        .post(
            &format!("/keys/{}/policy", api.key_id.clone()),
            Some(&api.admin.clone()),
            json!({"allow_transfer": true, "max_single_amount": "1"}),
        )
        .await;
    assert_eq!(capped.status, StatusCode::OK, "{capped:?}");

    let reply = api
        .sign(
            Some(&api.signer.clone()),
            &api.key_id.clone(),
            &api.transfer(1_000, 5),
        )
        .await;
    assert_eq!(reply.status, StatusCode::FORBIDDEN, "{reply:?}");
    assert_eq!(
        reply.code(),
        DenyReason::SingleAmountExceeded.code(),
        "the code is the caller's branch point"
    );
    assert_eq!(
        reply.keys(),
        ["allowed", "code", "message"],
        "no response to a denial may carry the detail"
    );
    assert!(
        !reply.text.contains("1000"),
        "the amount belongs to the audit row: {}",
        reply.text
    );

    // The other half of the rule: the route that reads the trail does serve it,
    // and only to a caller already entitled to read every key and boundary.
    let denial = api
        .audit_for(SignerAuditAction::TransactionSigned)
        .into_iter()
        .find(|record| record.outcome == SignerAuditOutcome::Denied)
        .expect("the denial should be recorded");
    let detail = denial.detail.as_deref().expect("a detail");
    assert!(detail.contains("1000"), "{detail}");

    let served = api
        .get(
            &format!("/audit?key_id={}", api.key_id.clone()),
            Some(&api.admin.clone()),
        )
        .await;
    assert_eq!(served.status, StatusCode::OK, "{served:?}");
    let entries = served.json()["entries"]
        .as_array()
        .expect("entries")
        .clone();
    assert!(
        entries
            .iter()
            .any(|entry| entry["detail"].as_str() == Some(detail)),
        "GET /audit is where the specifics are served: {entries:#?}"
    );
    assert!(entries
        .iter()
        .all(|entry| entry.get("action").is_some() && entry.get("outcome").is_some()));
}

#[tokio::test]
async fn an_unparsable_transaction_is_a_bad_request_not_a_failure() {
    let api = Api::open().await.expect("vault");
    // Well-formed hex, no transaction in it. `Failed` in the outcome, `400` on
    // the wire: the request was wrong, not the service.
    let reply = api
        .sign(Some(&api.signer.clone()), &api.key_id.clone(), "00ffff")
        .await;
    assert_eq!(reply.status, StatusCode::BAD_REQUEST, "{reply:?}");
    assert_eq!(reply.code(), "signer-transaction-unparsable");
    assert_eq!(reply.keys(), ["allowed", "code", "message"]);
    // The specifics of why it could not be read are the audit row's business.
    let row = api
        .audit_for(SignerAuditAction::TransactionSigned)
        .into_iter()
        .next()
        .expect("recorded");
    assert!(!row.detail.as_deref().unwrap_or_default().is_empty());
}

#[tokio::test]
async fn unsigned_hex_that_is_not_hexadecimal_has_its_own_code() {
    let api = Api::open().await.expect("vault");
    let reply = api
        .sign(Some(&api.signer.clone()), &api.key_id.clone(), "zz-not-hex")
        .await;
    assert_eq!(reply.status, StatusCode::BAD_REQUEST, "{reply:?}");
    assert_eq!(reply.code(), "signer-unsigned-hex-unreadable");
    assert!(
        !reply.text.contains("InvalidCharacter"),
        "hex's own error names a byte offset, not the caller's problem: {}",
        reply.text
    );
    assert!(
        api.audit_for(SignerAuditAction::TransactionSigned)
            .is_empty(),
        "the sign path wrote no row for a body that was never a call"
    );
}

#[tokio::test]
async fn a_consensus_payload_is_refused_by_the_default_boundary() {
    let api = Api::open().await.expect("vault");
    let unsigned = hex::encode(consensus_payload(policy::CONSENSUS_CATEGORY, api.account));
    let reply = api
        .post(
            "/sign/consensus",
            Some(&api.signer.clone()),
            json!({"key_id": api.key_id.clone(), "unsigned_hex": unsigned}),
        )
        .await;
    assert_eq!(reply.status, StatusCode::FORBIDDEN, "{reply:?}");
    assert_eq!(
        reply.code(),
        DenyReason::ConsensusForbidden.code(),
        "the route is wired to the consensus decision, not to the transaction one"
    );
    assert_eq!(api.audit_for(SignerAuditAction::ConsensusSigned).len(), 1);
}

#[tokio::test]
async fn a_raw_signature_is_refused_until_the_boundary_opens() {
    let api = Api::open().await.expect("vault");
    let (raw_caller_id, raw_signer) = api.raw_caller_for(&api.key_id).await;
    // The harness opens `allow_transfer` and nothing else: the raw lane has its
    // own switch, and a transfer-capable key must not become raw-signing-capable
    // by accident.
    let reply = api
        .post(
            "/sign/raw",
            Some(&raw_signer),
            json!({"key_id": api.key_id.clone(), "data_hex": hex::encode(b"a digest")}),
        )
        .await;
    assert_eq!(reply.status, StatusCode::FORBIDDEN, "{reply:?}");
    assert_eq!(reply.code(), DenyReason::RawForbidden.code());
    let rows = api.audit_for(SignerAuditAction::RawSigned);
    assert_eq!(rows.len(), 1, "{rows:#?}");
    assert_eq!(rows[0].outcome, SignerAuditOutcome::Denied);
    assert_eq!(rows[0].caller_id.as_deref(), Some(raw_caller_id.as_str()));
}

#[tokio::test]
async fn raw_transaction_collision_cannot_bypass_semantic_policy() {
    let api = Api::open().await.expect("vault");
    let (_, raw_signer) = api.raw_caller_for(&api.key_id).await;
    let unsigned = api.transfer(1, 77);
    let unsigned_bytes = hex::decode(&unsigned).expect("unsigned transaction hex");
    let mut collision = crate::network::network_magic(crate::network::Network::Testnet)
        .to_le_bytes()
        .to_vec();
    collision.extend_from_slice(&crate::crypto::sha256(&unsigned_bytes));

    let refused = api
        .post(
            "/sign/raw",
            Some(&raw_signer),
            json!({"key_id": api.key_id, "data_hex": hex::encode(collision)}),
        )
        .await;
    assert_eq!(refused.status, StatusCode::FORBIDDEN, "{refused:?}");
    assert_eq!(refused.code(), DenyReason::RawForbidden.code());

    let mixed = api
        .post(
            &format!("/keys/{}/policy", api.key_id),
            Some(&api.admin),
            json!({"allow_transfer": true, "allow_raw": true}),
        )
        .await;
    assert_eq!(mixed.status, StatusCode::BAD_REQUEST, "{mixed:?}");
    assert!(mixed
        .text
        .contains("allow_raw requires a dedicated raw-only key"));

    let transaction = api.sign(Some(&api.signer), &api.key_id, &unsigned).await;
    assert_eq!(transaction.status, StatusCode::OK, "{transaction:?}");
}

#[tokio::test]
async fn raw_and_semantic_routes_require_distinct_caller_capabilities() {
    let api = Api::open().await.expect("vault");
    let (raw_key_id, raw_signer) = api.raw_role().await;

    let wrong_raw_caller = api
        .post(
            "/sign/raw",
            Some(&api.signer),
            json!({"key_id": raw_key_id, "data_hex": "0102"}),
        )
        .await;
    assert_eq!(wrong_raw_caller.status, StatusCode::FORBIDDEN);
    assert_eq!(
        wrong_raw_caller.code(),
        AccessRejection::CapabilityMissing.code()
    );

    let wrong_semantic_caller = api
        .post(
            "/sign/transaction",
            Some(&raw_signer),
            json!({"key_id": api.key_id, "unsigned_hex": hex::encode(api.transfer(1, 78))}),
        )
        .await;
    assert_eq!(wrong_semantic_caller.status, StatusCode::FORBIDDEN);
    assert_eq!(
        wrong_semantic_caller.code(),
        AccessRejection::CapabilityMissing.code()
    );
}

#[tokio::test]
async fn a_raw_signature_answers_with_the_bytes_it_covered() {
    let api = Api::open().await.expect("vault");
    let (raw_key_id, raw_signer) = api.raw_role().await;

    let data = b"a fulfillment digest the enclave host wants signed";
    let reply = api
        .post(
            "/sign/raw",
            Some(&raw_signer),
            json!({"key_id": raw_key_id.clone(), "data_hex": hex::encode(data)}),
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{reply:?}");
    assert_eq!(
        reply.keys(),
        [
            "address",
            "allowed",
            "digest",
            "invocation_script",
            "key_id",
            "public_key",
            "script_hash",
            "signature",
            "verification_script"
        ],
        "the raw witness beside `allowed`, and nothing else — the same envelope the §5 routes answer with"
    );
    assert_eq!(reply.field("key_id"), raw_key_id);
    // The digest names what was signed: SHA-256 of the bytes, unframed — not
    // the network-framed hash a transaction signature covers.
    assert_eq!(
        reply.field("digest"),
        format!("0x{}", hex::encode(crate::crypto::sha256(data)))
    );
    // And the signature verifies against those bytes and no framed preimage:
    // the two primitives are not interchangeable (crypto.rs's own test pins
    // the same property off the wire).
    let signature: [u8; 64] = hex::decode(reply.field("signature"))
        .expect("bare hex")
        .try_into()
        .expect("64 bytes");
    let public_key: [u8; 33] = hex::decode(reply.field("public_key"))
        .expect("bare hex")
        .try_into()
        .expect("33 bytes");
    assert!(crate::crypto::verify_signature(
        &public_key,
        data,
        &signature
    ));
    let framed = crate::crypto::sign_data(data, 0);
    assert!(
        !crate::crypto::verify_signature(&public_key, &framed, &signature),
        "a raw signature must not verify against a network-framed preimage"
    );
    let rows = api.audit_for(SignerAuditAction::RawSigned);
    assert_eq!(rows.len(), 1, "{rows:#?}");
    assert_eq!(rows[0].outcome, SignerAuditOutcome::Allowed);
    assert_eq!(rows[0].key_id.as_deref(), Some(raw_key_id.as_str()));
}

#[tokio::test]
async fn data_hex_that_cannot_be_read_is_a_bad_request_with_no_row() {
    let api = Api::open().await.expect("vault");
    let not_hex = api
        .post(
            "/sign/raw",
            Some(&api.signer.clone()),
            json!({"key_id": api.key_id.clone(), "data_hex": "zz-not-hex"}),
        )
        .await;
    assert_eq!(not_hex.status, StatusCode::BAD_REQUEST, "{not_hex:?}");
    assert_eq!(not_hex.code(), "signer-request-unreadable");
    assert!(
        not_hex.text.contains("data_hex must be hexadecimal"),
        "the refusal names the caller's own field: {not_hex:?}"
    );

    let empty = api
        .post(
            "/sign/raw",
            Some(&api.signer.clone()),
            json!({"key_id": api.key_id.clone(), "data_hex": ""}),
        )
        .await;
    assert_eq!(empty.status, StatusCode::BAD_REQUEST, "{empty:?}");
    assert_eq!(empty.code(), "signer-request-unreadable");
    assert!(
        empty.text.contains("data_hex must not be empty"),
        "{empty:?}"
    );

    assert!(
        api.audit_for(SignerAuditAction::RawSigned).is_empty(),
        "the sign path wrote no row for a body that never reached a decision"
    );
}

// -- the transport's own answers ------------------------------------------

#[tokio::test]
async fn a_body_the_transport_cannot_read_is_refused_before_authentication() {
    let api = Api::open().await.expect("vault");
    // No Authorization header at all. The ordering is headers → body → service,
    // and it is only defensible because of what the decoder may say: this answer
    // is about the caller's own bytes and knows nothing about the vault.
    let request = Request::builder()
        .method(Method::POST)
        .uri(format!("{API_PREFIX}/sign/transaction"))
        .header("content-type", "application/json")
        .body(Body::from("{\"key_id\": "))
        .expect("request");
    let reply = api.send(request).await;
    assert_eq!(reply.status, StatusCode::BAD_REQUEST, "{reply:?}");
    assert_eq!(reply.code(), "signer-request-unreadable");
    assert!(
        !reply.text.contains("expected") && !reply.text.contains("at line"),
        "serde's message quotes the input, and the input can be a private key: {}",
        reply.text
    );
    assert!(
        api.audit_for(SignerAuditAction::TransactionSigned)
            .is_empty(),
        "a body that never became a call must not pretend to be one"
    );
}

#[tokio::test]
async fn a_field_that_is_not_what_the_contract_says_is_named() {
    let api = Api::open().await.expect("vault");
    let path = format!("/keys/{}/policy", api.key_id.clone());
    let text = api
        .post(
            &path,
            Some(&api.admin.clone()),
            json!({"allow_transfer": true, "max_single_amount": "1e3"}),
        )
        .await;
    assert_eq!(text.status, StatusCode::BAD_REQUEST, "{text:?}");
    assert_eq!(text.code(), "signer-request-unreadable");
    assert!(
        text.text.contains("max_single_amount"),
        "the caller's own field is the useful thing to name: {}",
        text.text
    );

    // An unknown field is refused rather than ignored: the alternative is a
    // caller that believes it set a ceiling it never sent.
    let typo = api
        .post(
            &path,
            Some(&api.admin.clone()),
            json!({"allow_transfer": true, "max_single_amounts": "1"}),
        )
        .await;
    assert_eq!(typo.status, StatusCode::BAD_REQUEST, "{typo:?}");
    let read = api.get(&path, Some(&api.admin.clone())).await;
    assert_eq!(
        read.json()["policy"]["max_single_amount"],
        Value::Null,
        "neither rejected request may have touched the boundary"
    );
}

/// The advice a stored boundary earns travels with the boundary, both ways.
///
/// `SignerPolicy::problems` used to be reachable only from inside the process
/// that held the engine, so a console called it directly. Now a console asks over
/// HTTP and the answer has to include the judgement, because the alternative is the
/// workbench keeping its own copy of which shapes are legal and still weak — the
/// drift §7 step 2 exists to end.
#[tokio::test]
async fn the_boundary_reply_carries_the_services_own_advice() {
    let api = Api::open().await.expect("vault");
    let path = format!("/keys/{}/policy", api.key_id.clone());

    let written = api
        .post(
            &path,
            Some(&api.admin.clone()),
            json!({"allow_contract_call": true, "allow_transfer": true}),
        )
        .await;
    assert_eq!(written.status, StatusCode::OK, "{written:?}");
    let saved = written.json();
    let codes: Vec<String> = saved["problems"]
        .as_array()
        .expect("the advice is a list, never a bare object")
        .iter()
        .map(|problem| {
            problem["message"]
                .as_str()
                .expect("each piece of advice says it in words as well as by code");
            problem["code"]
                .as_str()
                .expect("each piece of advice is named")
                .to_string()
        })
        .collect();
    assert_eq!(
        codes,
        vec!["contract-calls-unbounded", "transfers-without-asset-list"],
        "{written:?}"
    );

    // The read is the page that shows an operator what a boundary saved earlier
    // means, so it has to say the same thing the write said.
    let read = api.get(&path, Some(&api.admin.clone())).await;
    assert_eq!(read.json()["problems"], saved["problems"]);

    // A boundary needing no advice gets an empty list rather than an absent field:
    // a consumer should never have to tell "nothing wrong" from "unsure".
    let tight = api
        .post(
            &path,
            Some(&api.admin.clone()),
            json!({
                "allow_transfer": true,
                "asset_whitelist": [format!("0x{}", "a".repeat(40))],
                "max_single_amount": "1",
            }),
        )
        .await;
    assert_eq!(tight.status, StatusCode::OK, "{tight:?}");
    assert_eq!(tight.json()["problems"], json!([]), "{tight:?}");
}

#[tokio::test]
async fn a_body_over_the_ceiling_is_refused_before_it_is_buffered() {
    let api = Api::open().await.expect("vault");
    let text =
        json!({"key_id": api.key_id.clone(), "unsigned_hex": "aa".repeat(4_096)}).to_string();
    let length = text.len();
    let request = Request::builder()
        .method(Method::POST)
        .uri(format!("{API_PREFIX}/sign/transaction"))
        .header("authorization", format!("Bearer {}", api.signer))
        .header("content-type", "application/json")
        .header("content-length", length.to_string())
        .body(Body::from(text))
        .expect("request");
    // A declared length is what lets the ceiling answer `413` rather than `400`:
    // the transport refuses to read the body at all, so it says the body was too
    // big rather than unreadable.
    let reply = api.send_with_limit(256, request).await;
    assert_eq!(reply.status, StatusCode::PAYLOAD_TOO_LARGE, "{reply:?}");
    assert_eq!(reply.code(), "signer-request-too-large");
    assert_eq!(reply.keys(), ["allowed", "code", "message"]);

    // The default ceiling is well above it, so the same payload is refused there
    // for what it is, not for how long it is.
    let default_route = api
        .sign(
            Some(&api.signer.clone()),
            &api.key_id.clone(),
            &"aa".repeat(4_096),
        )
        .await;
    assert_ne!(default_route.code(), "signer-request-too-large");
    assert_eq!(default_route.status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn an_unmatched_path_answers_in_the_same_shape() {
    let api = Api::open().await.expect("vault");
    for path in [
        "/nothing-here",
        "/sign",
        "/keys/abc/policy/extra",
        "/audit/extra",
        "/keysabc",
    ] {
        let reply = api.get(path, None).await;
        assert_eq!(reply.status, StatusCode::NOT_FOUND, "{path}: {reply:?}");
        assert_eq!(reply.code(), "signer-route-unknown", "{path}");
        assert_eq!(reply.keys(), ["allowed", "code", "message"], "{path}");
    }
    // Outside the prefix entirely, where the nested router never sees it.
    let outside = api
        .send_on(
            api.router.clone(),
            Request::builder()
                .method(Method::GET)
                .uri("/signer")
                .body(Body::empty())
                .expect("request"),
        )
        .await;
    assert_eq!(outside.status, StatusCode::NOT_FOUND, "{outside:?}");
    assert_eq!(outside.code(), "signer-route-unknown");
}

// -- the management routes (§5.1) -----------------------------------------

#[tokio::test]
async fn a_created_callers_token_appears_exactly_once() {
    let api = Api::open().await.expect("vault");
    let created = api
        .post(
            "/callers",
            Some(&api.admin.clone()),
            json!({
                "label": "explorer",
                "capabilities": ["sign"],
                "key_grant": {"mode": "only", "key_ids": [api.key_id.clone()]},
            }),
        )
        .await;
    assert_eq!(created.status, StatusCode::OK, "{created:?}");
    assert_eq!(created.keys(), ["allowed", "caller", "token"]);
    let token = created.field("token");
    assert!(!token.is_empty());

    let listed = api.get("/callers", Some(&api.admin.clone())).await;
    assert_eq!(listed.status, StatusCode::OK, "{listed:?}");
    assert!(
        !listed.text.contains(&token),
        "the list route must not be a way to read out credentials"
    );
    assert!(
        !listed.text.contains("token"),
        "no field of a listed caller may name a credential: {}",
        listed.text
    );
    let callers = listed.json()["callers"]
        .as_array()
        .expect("callers")
        .clone();
    assert_eq!(callers.len(), 3, "{callers:#?}");
    for caller in &callers {
        assert!(
            caller.get("digest").is_none() && caller.get("token_digest").is_none(),
            "not even a hash of the credential belongs in a response: {caller}"
        );
    }
    // The token the list cannot show is still the one that works, which is what
    // makes the omission a boundary rather than an inconvenience.
    let reply = api
        .sign(Some(&token), &api.key_id.clone(), &api.transfer(1, 6))
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{reply:?}");
}

#[tokio::test]
async fn a_workload_caller_signs_without_a_bearer_secret_and_cannot_replay() {
    let api = Api::open().await.expect("vault");
    let signing_key = SigningKey::from_bytes(&[17u8; 32]);
    let created = api
        .post(
            "/callers/workload",
            Some(&api.admin.clone()),
            json!({
                "label": "neo-nexus",
                "capabilities": ["sign"],
                "key_grant": {"mode": "only", "key_ids": [api.key_id.clone()]},
                "workload_public_key": hex::encode(signing_key.verifying_key().to_bytes()),
                "workload_subject": "neo-nexus:test",
            }),
        )
        .await;
    assert_eq!(created.status, StatusCode::OK, "{created:?}");
    assert_eq!(created.keys(), ["allowed", "caller"]);
    assert!(!created.text.contains("\"token\""));
    assert_eq!(created.json()["caller"]["auth_mode"], "workload-ed25519");

    let identity = WorkloadClient {
        caller_id: created.json()["caller"]["id"]
            .as_str()
            .expect("caller id")
            .to_string(),
        subject: Some("neo-nexus:test".to_string()),
        signing_key,
    };
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_secs();
    let body = json!({
        "key_id": api.key_id.clone(),
        "unsigned_hex": api.transfer(1, 91),
    });
    let allowed = api
        .workload_post(
            "/sign/transaction",
            &identity,
            timestamp,
            "nonce-0000000091",
            body.clone(),
        )
        .await;
    assert_eq!(allowed.status, StatusCode::OK, "{allowed:?}");

    let replay = api
        .workload_post(
            "/sign/transaction",
            &identity,
            timestamp,
            "nonce-0000000091",
            body,
        )
        .await;
    assert_eq!(replay.status, StatusCode::FORBIDDEN, "{replay:?}");
    assert_eq!(replay.code(), AccessRejection::WorkloadReplay.code());
}

#[tokio::test]
async fn capabilities_must_name_exactly_one() {
    let api = Api::open().await.expect("vault");
    let before = api.audit_for(SignerAuditAction::CallerCreated).len();
    // A record holding both would be one string that can ask for a signature and
    // move the boundary that decides it; an empty one is a credential that can
    // never be used. Neither may be created.
    for (index, capabilities) in [json!(["sign", "admin"]), json!([])]
        .into_iter()
        .enumerate()
    {
        let reply = api
            .post(
                "/callers",
                Some(&api.admin.clone()),
                json!({
                    "label": "which-one",
                    "capabilities": capabilities,
                    "key_grant": {"mode": "any"},
                }),
            )
            .await;
        assert_eq!(
            reply.status,
            StatusCode::BAD_REQUEST,
            "{capabilities} accepted: {reply:?}"
        );
        assert_eq!(reply.code(), "signer-admin-request-invalid");
        assert!(
            reply
                .text
                .contains("capabilities must name exactly one of sign, raw_sign or admin"),
            "an admin is told what to fix: {}",
            reply.text
        );
        assert_eq!(
            api.list_callers().await.len(),
            2,
            "case {index} must not have created a caller"
        );
    }
    let rows = api.audit_for(SignerAuditAction::CallerCreated);
    assert_eq!(
        rows.len(),
        before + 2,
        "every rejected request is still an event: {rows:#?}"
    );
    // Newest first, so the two rows this test added are at the front.
    assert!(
        rows[..2]
            .iter()
            .all(|record| record.outcome == SignerAuditOutcome::Denied),
        "{:#?}",
        &rows[..2]
    );
}

#[tokio::test]
async fn a_grant_is_checked_before_the_vault_is_read() {
    let api = Api::open().await.expect("vault");
    let scoped = api
        .post(
            "/callers",
            Some(&api.admin.clone()),
            json!({
                "label": "auditor",
                "capabilities": ["admin"],
                "key_grant": {"mode": "only", "key_ids": [api.key_id.clone()]},
            }),
        )
        .await;
    assert_eq!(scoped.status, StatusCode::OK, "{scoped:?}");
    let token = scoped.field("token");

    // A whole-vault read under a key-scoped admin is refused, not narrowed: an
    // answer that listed the one granted key would be a grant the operator never
    // gave, in a shape a client would trust.
    for path in ["/keys", "/callers", "/audit"] {
        let reply = api.get(path, Some(&token)).await;
        assert_eq!(reply.status, StatusCode::FORBIDDEN, "{path}: {reply:?}");
        assert_eq!(reply.code(), "key-not-granted", "{path}");
    }

    // The two guards on the two key reads, checked against each other: an
    // administrative credential — however narrowly granted — is not a signing
    // one, and §5.1's separate routes are what keep that true rather than a
    // handler that answers whichever check it reaches first.
    let identity = api
        .get(&format!("/keys/{}", api.key_id.clone()), Some(&token))
        .await;
    assert_eq!(identity.status, StatusCode::FORBIDDEN, "{identity:?}");
    assert_eq!(identity.code(), "admin-capability-missing");
    let signed_read = api
        .get(
            &format!("/keys/{}", api.key_id.clone()),
            Some(&api.signer.clone()),
        )
        .await;
    assert_eq!(signed_read.status, StatusCode::OK, "{signed_read:?}");
    assert_eq!(signed_read.field("key_id"), api.key_id);
    assert!(
        signed_read.json().get("policy").is_none(),
        "the identity read is not a boundary read: {}",
        signed_read.text
    );

    // What the granted admin *may* do: read the boundary of the one key it was
    // given, which is what an auditor's page is.
    let boundary = api
        .get(
            &format!("/keys/{}/policy", api.key_id.clone()),
            Some(&token),
        )
        .await;
    assert_eq!(boundary.status, StatusCode::OK, "{boundary:?}");
    assert!(boundary.json().get("policy").is_some());
    let other_key = api
        .post(
            "/keys",
            Some(&api.admin.clone()),
            json!({"label": "another", "network": "testnet"}),
        )
        .await;
    assert_eq!(other_key.status, StatusCode::OK, "{other_key:?}");
    let outside = api
        .get(
            &format!("/keys/{}/policy", other_key.field("key_id")),
            Some(&token),
        )
        .await;
    assert_eq!(outside.status, StatusCode::FORBIDDEN, "{outside:?}");
    assert_eq!(outside.code(), "key-not-granted");
}

#[tokio::test]
async fn a_key_can_be_disabled_and_retired() {
    let api = Api::open().await.expect("vault");
    let id = api.key_id.clone();
    let off = api
        .post(
            &format!("/keys/{id}/state"),
            Some(&api.admin.clone()),
            json!({"disabled": true}),
        )
        .await;
    assert_eq!(off.status, StatusCode::OK, "{off:?}");
    assert_eq!(off.json()["signing_enabled"].as_bool(), Some(false));

    let refusal = api
        .sign(Some(&api.signer.clone()), &id.clone(), &api.transfer(1, 7))
        .await;
    assert_eq!(refusal.status, StatusCode::FORBIDDEN, "{refusal:?}");
    assert_eq!(refusal.code(), "signer-key-disabled");

    let on = api
        .post(
            &format!("/keys/{id}/state"),
            Some(&api.admin.clone()),
            json!({"disabled": false}),
        )
        .await;
    assert_eq!(on.json()["signing_enabled"].as_bool(), Some(true));

    let deleted = api
        .delete(&format!("/keys/{id}"), Some(&api.admin.clone()))
        .await;
    assert_eq!(deleted.status, StatusCode::OK, "{deleted:?}");
    assert_eq!(deleted.field("key_id"), id);
    assert_eq!(deleted.keys(), ["allowed", "key_id"]);
    let gone = api
        .get(&format!("/keys/{id}"), Some(&api.signer.clone()))
        .await;
    assert_eq!(gone.status, StatusCode::NOT_FOUND, "{gone:?}");
    assert_eq!(gone.code(), "signer-key-unknown");
}

#[tokio::test]
async fn a_rotated_token_replaces_the_one_it_came_from() {
    let api = Api::open().await.expect("vault");
    let old = api.signer.clone();
    let caller_id = api.caller_id.clone();
    let rotated = api
        .post(
            &format!("/callers/{caller_id}/rotate"),
            Some(&api.admin.clone()),
            json!({}),
        )
        .await;
    assert_eq!(rotated.status, StatusCode::OK, "{rotated:?}");
    assert_eq!(rotated.keys(), ["allowed", "caller_id", "token"]);
    assert_eq!(rotated.field("caller_id"), caller_id);
    let fresh = rotated.field("token");
    assert_ne!(fresh, old);

    assert_eq!(
        api.sign(Some(&old), &api.key_id.clone(), &api.transfer(1, 8))
            .await
            .code(),
        "unknown-token",
        "the retired credential must stop working at once"
    );
    assert_eq!(
        api.sign(Some(&fresh), &api.key_id.clone(), &api.transfer(1, 9))
            .await
            .status,
        StatusCode::OK,
        "and the new one must work at once"
    );
}

#[tokio::test]
async fn a_boundary_round_trips_through_the_wire_shape() {
    let api = Api::open().await.expect("vault");
    let body = json!({
        "allow_consensus": false,
        "allow_raw": false,
        "allow_transfer": true,
        "allow_contract_call": true,
        "allow_global_scope": false,
        "contract_whitelist": [ScriptHash::from_wire(tx::native::NEO).to_display()],
        "contract_blacklist": [],
        "contract_method_whitelist": [{
            "contract": ScriptHash::from_wire(tx::native::NEO).to_display(),
            "method": "transfer",
        }],
        "contract_method_blacklist": [],
        "asset_whitelist": [ScriptHash::from_wire(tx::native::NEO).to_display()],
        "asset_blacklist": [],
        "asset_limits": [{
            "asset": ScriptHash::from_wire(tx::native::NEO).to_display(),
            "max_single_amount": "50000000",
            "window_limit": {"seconds": 300, "max_amount": "75000000"},
        }],
        "transfer_to_whitelist": [],
        "transfer_to_blacklist": [ScriptHash::from(RECIPIENT).to_display()],
        "max_single_amount": i128::MAX.to_string(),
        "window_limit": {"seconds": 3600, "max_amount": "100000000"},
        "max_signers": 1,
        "max_system_fee": "0",
        "max_network_fee": "0",
        "max_signatures": {"seconds": 60, "count": 10},
    });
    let path = format!("/keys/{}/policy", api.key_id.clone());
    let saved = api
        .post(&path, Some(&api.admin.clone()), body.clone())
        .await;
    assert_eq!(saved.status, StatusCode::OK, "{saved:?}");
    assert_eq!(
        saved.json()["policy"],
        body,
        "what was understood is what comes back"
    );

    let read = api.get(&path, Some(&api.admin.clone())).await;
    assert_eq!(read.status, StatusCode::OK, "{read:?}");
    assert_eq!(read.json()["policy"], body);
    assert_eq!(read.json()["key_id"].as_str(), Some(api.key_id.as_str()));

    // The ceiling survived as text — i128::MAX has no JSON number that can carry
    // it — and the list that does not is the one that bites: this transfer is
    // refused for its recipient, at an amount the per-transfer ceiling permits.
    // A boundary is only proven by the decision it changes.
    let refused = api
        .sign(
            Some(&api.signer.clone()),
            &api.key_id.clone(),
            &api.transfer(1_000_000, 10),
        )
        .await;
    assert_eq!(refused.status, StatusCode::FORBIDDEN, "{refused:?}");
    assert_eq!(refused.code(), DenyReason::RecipientBlacklisted.code());
    let allowed = api
        .sign(
            Some(&api.signer.clone()),
            &api.key_id.clone(),
            &hex::encode(transaction(
                api.account,
                11,
                &transfer_script(
                    api.account,
                    [0x55u8; tx::HASH160_LEN],
                    1_000_000,
                    tx::native::NEO,
                ),
            )),
        )
        .await;
    assert_eq!(allowed.status, StatusCode::OK, "{allowed:?}");
}

#[tokio::test]
async fn a_credential_never_echoes_the_secret_it_was_given() {
    let api = Api::open().await.expect("vault");
    let cases = [
        json!({"label": "past", "network": "testnet", "private_key": NOT_A_SECRET}),
        json!({"label": "past", "network": "testnet", "private_key": "not-a-key"}),
        json!({"label": "past", "network": "testnet", "nep2": "6Pnotanep2", "passphrase": NOT_A_SECRET}),
    ];
    for body in cases {
        let label = body["label"].as_str().expect("label").to_string();
        let route = if body.get("nep2").is_some() {
            "/keys/import-nep2"
        } else {
            "/keys/import"
        };
        let reply = api
            .post(route, Some(&api.admin.clone()), body.clone())
            .await;
        assert_ne!(reply.status, StatusCode::OK, "{body} accepted: {reply:?}");
        assert_eq!(reply.keys(), ["allowed", "code", "message"], "{body}");
        for needle in [NOT_A_SECRET, &NOT_A_SECRET[..32], "not-a-key", "6Pnotanep2"] {
            assert!(
                !reply.text.contains(needle),
                "{route} echoed {needle:?}: {}",
                reply.text
            );
        }
        assert!(api
            .list_keys()
            .await
            .iter()
            .all(|key| key["label"] != json!(label)));
    }
}

#[tokio::test]
async fn a_network_the_service_does_not_know_is_the_callers_mistake() {
    let api = Api::open().await.expect("vault");
    let reply = api
        .post(
            "/keys",
            Some(&api.admin.clone()),
            json!({"label": "somewhere", "network": "regtest"}),
        )
        .await;
    assert_eq!(reply.status, StatusCode::BAD_REQUEST, "{reply:?}");
    assert_eq!(reply.code(), "signer-request-unreadable");
    assert!(reply.text.contains("mainnet"), "{reply:?}");
    assert_eq!(api.audit_for(SignerAuditAction::KeyGenerated).len(), 1);
}

#[tokio::test]
async fn the_audit_query_is_strict_about_its_two_filters() {
    let api = Api::open().await.expect("vault");
    let bad = api.get("/audit?limit=lots", Some(&api.admin.clone())).await;
    assert_eq!(bad.status, StatusCode::BAD_REQUEST, "{bad:?}");
    assert_eq!(bad.code(), "signer-request-unreadable");
    assert!(bad.text.contains("limit must be a number"), "{bad:?}");

    // A ceiling rather than an error: a console asking for more gets the most
    // this service will put in one response.
    let capped = api
        .get("/audit?limit=100000", Some(&api.admin.clone()))
        .await;
    assert_eq!(capped.status, StatusCode::OK, "{capped:?}");
    assert!(capped.json()["entries"].as_array().expect("entries").len() <= 500);

    // An empty filter is no filter, and an unknown one is ignored, so a client
    // adding a parameter is not breaking a service.
    let empty = api
        .get("/audit?key_id=&page=2", Some(&api.admin.clone()))
        .await;
    assert_eq!(empty.status, StatusCode::OK, "{empty:?}");
    assert!(!empty.json()["entries"]
        .as_array()
        .expect("entries")
        .is_empty());

    let refused = api.get("/audit?key_id=", Some(&api.signer.clone())).await;
    assert_eq!(refused.status, StatusCode::FORBIDDEN, "{refused:?}");
    assert_eq!(refused.code(), "admin-capability-missing");
}

#[tokio::test]
async fn a_disabled_caller_is_refused_by_name() {
    let api = Api::open().await.expect("vault");
    let caller_id = api.caller_id.clone();
    let off = api
        .post(
            &format!("/callers/{caller_id}/state"),
            Some(&api.admin.clone()),
            json!({"disabled": true}),
        )
        .await;
    assert_eq!(off.status, StatusCode::OK, "{off:?}");
    assert_eq!(off.json()["id"].as_str(), Some(caller_id.as_str()));
    assert_eq!(off.json()["disabled"].as_bool(), Some(true));

    let reply = api
        .sign(
            Some(&api.signer.clone()),
            &api.key_id.clone(),
            &api.transfer(1, 11),
        )
        .await;
    assert_eq!(reply.status, StatusCode::FORBIDDEN, "{reply:?}");
    assert_eq!(reply.code(), "caller-disabled");

    let deleted = api
        .delete(&format!("/callers/{caller_id}"), Some(&api.admin.clone()))
        .await;
    assert_eq!(deleted.status, StatusCode::OK, "{deleted:?}");
    assert_eq!(deleted.field("caller_id"), caller_id);
    assert_eq!(api.list_callers().await.len(), 1);
    let gone = api
        .post(
            &format!("/callers/{caller_id}/rotate"),
            Some(&api.admin.clone()),
            json!({}),
        )
        .await;
    assert_eq!(gone.status, StatusCode::NOT_FOUND, "{gone:?}");
    assert_eq!(gone.code(), "signer-caller-unknown");
}

// -- the secret type itself -----------------------------------------------

#[test]
fn a_secret_body_redacts_itself_when_printed() {
    let call: ImportCall = serde_json::from_str(
        &json!({"label": "k", "network": "testnet", "private_key": NOT_A_SECRET}).to_string(),
    )
    .expect("the import body should parse");
    let printed = format!("{call:?}");
    assert!(printed.contains("<redacted>"), "{printed}");
    assert!(!printed.contains("ffffffffffff"), "{printed}");
    assert_eq!(call.private_key.as_str(), NOT_A_SECRET);
}

#[test]
fn a_body_refuses_a_field_the_contract_does_not_have() {
    // The passphrased import is the case where silently dropping a field would
    // be a caller believing it set something it never sent.
    let error = serde_json::from_str::<Nep2Call>(
        r#"{"label":"k","network":"testnet","nep2":"6P","passphrase":"x","pin":"y"}"#,
    )
    .expect_err("an unknown field must not be accepted");
    assert!(error.to_string().contains("pin"), "{error}");
}

#[test]
fn a_grant_that_names_keys_under_any_mode_is_refused() {
    // `any` plus a list is a caller that has contradicted itself, and either
    // reading of it would be a grant nobody asked for.
    let call: CallerCall = serde_json::from_str(
        r#"{"label":"x","capabilities":["sign"],"key_grant":{"mode":"any","key_ids":["k"]}}"#,
    )
    .expect("the caller body should parse");
    assert_eq!(
        call.key_grant.to_grant().expect_err("contradictory"),
        "key_grant.mode any takes no key_ids"
    );

    // Omitting the grant entirely is the fail-closed reading: a credential with
    // no keys, not one with all of them.
    let bare: CallerCall =
        serde_json::from_str(r#"{"label":"x","capabilities":["sign"]}"#).expect("parse");
    assert_eq!(
        bare.key_grant.to_grant().expect("grant"),
        KeyGrant::Only(Vec::new())
    );

    let nonsense: CallerCall = serde_json::from_str(
        r#"{"label":"x","capabilities":["sign"],"key_grant":{"mode":"everything"}}"#,
    )
    .expect("parse");
    assert_eq!(
        nonsense.key_grant.to_grant().expect_err("unknown mode"),
        "key_grant.mode must be any or only"
    );
}

// -- enclave routes --------------------------------------------------------
//
// The sealed-window behaviour and the one door that opens it, over the same
// oneshot wire as everything above. The KMS release itself is canned: the
// route's contract is what happens around the release, and the release has
// its own tests in `nitro-attest` and `provision`.

/// The transport token the canned releaser pretends KMS released.
const ENCLAVE_TOKEN: &str = "enclave-transport-token-0002";

/// The canned release answers: the token bytes for the token ciphertext, a
/// 32-byte key for the master ciphertext — branching on the ciphertext, the
/// way the real releaser branches on a KMS response.
fn enclave_releaser() -> provision::EnvelopeReleaser {
    use std::sync::Arc;
    Arc::new(|_env: &ProvisionEnv, ciphertext: &str| {
        if ciphertext == "token-cipher" {
            Ok(ENCLAVE_TOKEN.as_bytes().to_vec())
        } else if ciphertext == "master-cipher" {
            Ok([0x6b; 32].to_vec())
        } else {
            Err(format!("the canned KMS has no envelope for {ciphertext}"))
        }
    })
}

/// The provision body the start script would send: the token ciphertext, the
/// master ciphertext, and the AWS names the release path needs.
fn enclave_provision_body() -> Value {
    json!({"env": {
        (provision::TOKEN_CIPHERTEXT_ENV): "token-cipher",
        (provision::MASTER_KEY_CIPHERTEXT_ENV): "master-cipher",
        (provision::REGION_ENV): "us-east-1",
        "AWS_ACCESS_KEY_ID": "AKIAEXAMPLE",
        "AWS_SECRET_ACCESS_KEY": "secret",
    }})
}

/// A vault sealed behind [`ApiState::attested_pending`], plus its data
/// directory (the enclave-born fallback would write into it).
fn sealed_router() -> (Router, tempfile::TempDir) {
    let dir = tempfile::tempdir().expect("tempdir");
    let repository = Store::open(dir.path().join("signer.db")).expect("store");
    let state =
        ApiState::attested_pending(repository, dir.path().to_path_buf(), enclave_releaser());
    (router(state), dir)
}

/// Send a request to a root-level route — no prefix, these are the transport's
/// own endpoints — and read the reply back as text.
async fn send_raw(router: Router, request: Request) -> Reply {
    let response = router
        .oneshot(request)
        .await
        .expect("the router never fails a request outright");
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("the body should be readable");
    Reply {
        status,
        text: String::from_utf8(bytes.to_vec()).expect("every answer is UTF-8"),
    }
}

fn root_request(method: Method, path: &str, token: Option<&str>, body: Option<Value>) -> Request {
    let mut builder = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json");
    if let Some(token) = token {
        builder = builder.header("authorization", format!("Bearer {token}"));
    }
    builder
        .body(body.map_or_else(Body::empty, |value| Body::from(value.to_string())))
        .expect("the request should build")
}

#[tokio::test]
async fn a_sealed_vault_answers_503_without_touching_the_audit_trail() {
    let (router, _dir) = sealed_router();

    let health = send_raw(
        router.clone(),
        root_request(Method::GET, "/health", None, None),
    )
    .await;
    assert_eq!(health.status, StatusCode::OK, "{health:?}");
    assert_eq!(health.json()["status"], "unprovisioned");

    let attestation = send_raw(
        router.clone(),
        root_request(Method::GET, "/attestation", None, None),
    )
    .await;
    assert_eq!(attestation.status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(attestation.json()["code"], "signer-not-provisioned");

    let sign = send_raw(
        router,
        root_request(
            Method::POST,
            &format!("{API_PREFIX}/sign/transaction"),
            Some(ENCLAVE_TOKEN),
            Some(json!({"key_id": "k", "unsigned_hex": "00"})),
        ),
    )
    .await;
    assert_eq!(sign.status, StatusCode::SERVICE_UNAVAILABLE, "{sign:?}");
    assert_eq!(sign.json()["code"], NOT_PROVISIONED);
}

#[tokio::test]
async fn provision_opens_the_vault_once_and_refuses_the_second_call() {
    let (router, _dir) = sealed_router();

    let first = send_raw(
        router.clone(),
        root_request(
            Method::POST,
            "/provision",
            Some(ENCLAVE_TOKEN),
            Some(enclave_provision_body()),
        ),
    )
    .await;
    assert_eq!(first.status, StatusCode::OK, "{first:?}");
    let fingerprint = first.field("vault_fingerprint");
    let expected = MasterKey::from_bytes([0x6b; 32]).fingerprint();
    assert_eq!(
        fingerprint, expected,
        "the vault opened under the released key"
    );

    let health = send_raw(
        router.clone(),
        root_request(Method::GET, "/health", None, None),
    )
    .await;
    assert_eq!(health.json()["status"], "ok");

    // A management call now reaches authentication instead of the sealed
    // window: the same route answers with the service's missing-token refusal
    // rather than 503.
    let keys = send_raw(
        router.clone(),
        root_request(Method::GET, &format!("{API_PREFIX}/keys"), None, None),
    )
    .await;
    assert_eq!(keys.status, StatusCode::FORBIDDEN, "{keys:?}");
    assert_eq!(keys.json()["code"], "missing-token");

    let second = send_raw(
        router,
        root_request(
            Method::POST,
            "/provision",
            Some(ENCLAVE_TOKEN),
            Some(enclave_provision_body()),
        ),
    )
    .await;
    assert_eq!(second.status, StatusCode::CONFLICT, "{second:?}");
    assert_eq!(second.json()["code"], "signer-provision-already-done");
}

#[tokio::test]
async fn a_plaintext_master_key_in_a_provision_body_is_refused_with_its_own_code() {
    let (router, _dir) = sealed_router();
    let mut body = enclave_provision_body();
    body["env"]["SIGNER_SERVICE_MASTER_KEY"] = json!("64-hex-characters-or-longer-passphrase");

    let reply = send_raw(
        router,
        root_request(Method::POST, "/provision", Some(ENCLAVE_TOKEN), Some(body)),
    )
    .await;
    assert_eq!(reply.status, StatusCode::FORBIDDEN, "{reply:?}");
    assert_eq!(reply.json()["code"], "signer-provision-forbidden");
}

#[tokio::test]
async fn a_provision_token_that_does_not_match_its_envelope_is_refused() {
    let (router, _dir) = sealed_router();
    let reply = send_raw(
        router,
        root_request(
            Method::POST,
            "/provision",
            Some("the-wrong-token"),
            Some(enclave_provision_body()),
        ),
    )
    .await;
    assert_eq!(reply.status, StatusCode::UNAUTHORIZED, "{reply:?}");
    assert_eq!(reply.json()["code"], "signer-provision-unauthorized");
}

#[tokio::test]
async fn a_provision_body_off_the_whitelist_names_the_key() {
    let (router, _dir) = sealed_router();
    let mut body = enclave_provision_body();
    body["env"]["SIGNER_SERVICE_MASTER_KEY_PLAINTEXT"] = json!("smuggled");

    let reply = send_raw(
        router,
        root_request(Method::POST, "/provision", Some(ENCLAVE_TOKEN), Some(body)),
    )
    .await;
    assert_eq!(reply.status, StatusCode::BAD_REQUEST, "{reply:?}");
    assert!(
        reply.text.contains("SIGNER_SERVICE_MASTER_KEY_PLAINTEXT"),
        "{reply:?}"
    );
}

/// The stand-in NSM for the attestation builder: one fixed document, recorded
/// inputs, so the binding can be checked without a device.
struct RecordedAttestation {
    document: Vec<u8>,
    seen_nonce: std::sync::Mutex<Option<Vec<u8>>>,
    seen_user_data: std::sync::Mutex<Option<Vec<u8>>>,
}

impl AttestationSource for RecordedAttestation {
    fn attest(
        &self,
        nonce: Option<&[u8]>,
        user_data: Option<&[u8]>,
        _public_key: Option<&[u8]>,
    ) -> Result<Vec<u8>, String> {
        *self.seen_nonce.lock().unwrap() = nonce.map(|bytes| bytes.to_vec());
        *self.seen_user_data.lock().unwrap() = user_data.map(|bytes| bytes.to_vec());
        Ok(self.document.clone())
    }
}

#[tokio::test]
async fn the_attestation_binds_the_vault_fingerprint_and_the_boundaries() {
    let api = Api::open().await.expect("harness");

    let nonce = [0xa5u8; 16];
    let source = RecordedAttestation {
        document: vec![0xD2, 0x84, 0x40, 0xA0, 0x40, 0x43, 0x01, 0x02, 0x03],
        seen_nonce: std::sync::Mutex::new(None),
        seen_user_data: std::sync::Mutex::new(None),
    };
    let reply = build_attestation(&api.service, &source, Some(&nonce)).expect("binds");

    assert_eq!(reply["status"], "ok");
    assert_eq!(reply["runtime"], "neo-signer-custody");
    assert_eq!(reply["vault_fingerprint"], api.service.vault_fingerprint());
    assert_eq!(reply["nonce"], hex::encode(nonce));

    // The verifier's job, replayed: hash the boundary list the response
    // carries, and require the digest that rode in the user data.
    let boundaries = reply["boundaries_json"].as_str().expect("string");
    let digest = hex::encode(crate::crypto::sha256(boundaries.as_bytes()));
    assert_eq!(reply["boundaries_sha256"], digest);

    let user_data = hex::decode(reply["user_data_hex"].as_str().expect("string")).expect("hex");
    let expected_user_data =
        attested_identity::attestation_user_data(&api.service.vault_fingerprint(), &digest);
    assert_eq!(user_data, expected_user_data);

    assert_eq!(
        source.seen_nonce.lock().unwrap().as_deref(),
        Some(nonce.as_slice()),
        "the caller's nonce makes the document single-use"
    );
    assert_eq!(
        source.seen_user_data.lock().unwrap().as_deref(),
        Some(user_data.as_slice()),
        "the attested bytes are exactly the identity document"
    );
}

#[tokio::test]
async fn a_bad_attestation_nonce_answers_in_the_refusal_shape() {
    let api = Api::open().await.expect("harness");
    let reply = send_raw(
        router(ApiState::new(api.service.clone())),
        root_request(Method::GET, "/attestation?nonce=not-hex", None, None),
    )
    .await;
    assert_eq!(reply.status, StatusCode::BAD_REQUEST, "{reply:?}");
    assert_eq!(reply.json()["code"], REQUEST_UNREADABLE);

    let empty = send_raw(
        router(ApiState::new(api.service.clone())),
        root_request(Method::GET, "/attestation?nonce=", None, None),
    )
    .await;
    assert_eq!(empty.status, StatusCode::BAD_REQUEST, "{empty:?}");
}
