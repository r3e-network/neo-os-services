//! Shared test doubles for the host's pure core. Each test module includes
//! this file via `#[path = "support.rs"] mod support;` — the same pattern the
//! custody service's unit suites use. The doubles are all clone-able handles
//! over `Arc<Mutex<..>>` so a test can build the `AppState`, drive
//! `dispatch`, and then read what the fakes recorded.
//!
//! Each inclusion is a distinct module, so a test module that uses only some
//! of the doubles dead-codes the rest of its private copy; the file-level
//! allow keeps those copies quiet without weakening any production lint.
#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex, RwLock};

use crate::overlay::EnvOverlay;
use crate::state::{
    AppState, BridgePlane, BridgeReply, KmsDiag, KmsReleaseParams, KmsReleaser, RoleReport,
    SignerPlane,
};
use crate::RuntimeError;

pub const TEST_NETWORK: &str = "testnet";

/// A healthy role's identity, shaped like the custody plane's report.
pub fn healthy_identity() -> serde_json::Value {
    serde_json::json!({
        "address": "Nd5tGBUrXa3YylLBYbwZSp8BhRd1vcaFqm",
        "script_hash": "0x5c2047b1c6b4b6e4b3a1c9d5e7f0a2b4c6d8e0f1",
        "public_key": "02f8a5a1e0f3b6c9d2e5f8a1b4c7d0e3f6a9b2c5d8e1f4a7b0c3d6e9f2a5b8c1",
    })
}

// ---------------------------------------------------------------------------
// Attestation double
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct FakeAttest {
    inner: Arc<FakeAttestInner>,
}

struct FakeAttestInner {
    document: Mutex<Vec<u8>>,
    error: Mutex<Option<String>>,
    calls: Mutex<Vec<CapturedAttestCall>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapturedAttestCall {
    pub nonce: Option<Vec<u8>>,
    pub user_data: Option<Vec<u8>>,
    pub public_key: Option<Vec<u8>>,
}

impl FakeAttest {
    pub fn with_document(document: &[u8]) -> Self {
        FakeAttest {
            inner: Arc::new(FakeAttestInner {
                document: Mutex::new(document.to_vec()),
                error: Mutex::new(None),
                calls: Mutex::new(Vec::new()),
            }),
        }
    }

    pub fn failing(message: &str) -> Self {
        FakeAttest {
            inner: Arc::new(FakeAttestInner {
                document: Mutex::new(Vec::new()),
                error: Mutex::new(Some(message.to_string())),
                calls: Mutex::new(Vec::new()),
            }),
        }
    }

    pub fn calls(&self) -> Vec<CapturedAttestCall> {
        self.inner.calls.lock().expect("calls lock").clone()
    }
}

impl nitro_attest::release::AttestationSource for FakeAttest {
    fn attest(
        &self,
        nonce: Option<&[u8]>,
        user_data: Option<&[u8]>,
        public_key: Option<&[u8]>,
    ) -> Result<Vec<u8>, String> {
        self.inner
            .calls
            .lock()
            .expect("calls lock")
            .push(CapturedAttestCall {
                nonce: nonce.map(<[u8]>::to_vec),
                user_data: user_data.map(<[u8]>::to_vec),
                public_key: public_key.map(<[u8]>::to_vec),
            });
        let error = self.inner.error.lock().expect("error lock").clone();
        match error {
            Some(message) => Err(message),
            None => Ok(self.inner.document.lock().expect("document lock").clone()),
        }
    }
}

// ---------------------------------------------------------------------------
// Signer plane double
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct FakeSigner {
    inner: Arc<FakeSignerInner>,
}

#[derive(Clone)]
pub struct SignerConfig {
    pub healthy: bool,
    pub public_key: String,
    pub identity: serde_json::Value,
    pub issues: Vec<String>,
    pub key_source: String,
    pub sign_result: Option<Result<serde_json::Value, RuntimeError>>,
}

impl Default for SignerConfig {
    fn default() -> Self {
        SignerConfig {
            healthy: true,
            public_key: "02f8a5a1e0f3b6c9d2e5f8a1b4c7d0e3f6a9b2c5d8e1f4a7b0c3d6e9f2a5b8c1"
                .to_string(),
            identity: healthy_identity(),
            issues: Vec::new(),
            key_source: "kms_attested".to_string(),
            sign_result: None,
        }
    }
}

struct FakeSignerInner {
    config: Mutex<SignerConfig>,
    sign_calls: Mutex<Vec<(String, String, String)>>,
}

impl FakeSigner {
    pub fn new(config: SignerConfig) -> Self {
        FakeSigner {
            inner: Arc::new(FakeSignerInner {
                config: Mutex::new(config),
                sign_calls: Mutex::new(Vec::new()),
            }),
        }
    }

    pub fn healthy() -> Self {
        FakeSigner::new(SignerConfig::default())
    }

    pub fn unconfigured() -> Self {
        FakeSigner::new(SignerConfig {
            healthy: false,
            ..SignerConfig::default()
        })
    }

    pub fn set_config(&self, config: SignerConfig) {
        *self.inner.config.lock().expect("config lock") = config;
    }

    pub fn sign_calls(&self) -> Vec<(String, String, String)> {
        self.inner
            .sign_calls
            .lock()
            .expect("sign calls lock")
            .clone()
    }
}

impl SignerPlane for FakeSigner {
    fn role_report(&self, _network: &str, _role: &str) -> RoleReport {
        let config = self.inner.config.lock().expect("config lock").clone();
        if config.healthy {
            RoleReport {
                ok: true,
                materialized: true,
                public_key: config.public_key,
                identity: config.identity,
                issues: config.issues,
                key_source: config.key_source,
            }
        } else {
            RoleReport {
                ok: false,
                materialized: false,
                public_key: String::new(),
                identity: serde_json::Value::Null,
                issues: config.issues,
                key_source: "none".to_string(),
            }
        }
    }

    fn sign_payload(
        &self,
        network: &str,
        role: &str,
        data_hex: &str,
    ) -> Result<serde_json::Value, RuntimeError> {
        self.inner
            .sign_calls
            .lock()
            .expect("sign calls lock")
            .push((network.to_string(), role.to_string(), data_hex.to_string()));
        let (result, public_key) = {
            let config = self.inner.config.lock().expect("config lock");
            (config.sign_result.clone(), config.public_key.clone())
        };
        match result {
            Some(result) => result,
            None => Ok(serde_json::json!({
                "status": "ok",
                "network": network,
                "role": role,
                "signature": "00",
                "signature_hex": "00",
                "public_key": public_key,
                "address": healthy_identity()["address"],
                "script_hash": healthy_identity()["script_hash"],
                "key_source": "vault_sealed",
            })),
        }
    }
}

// ---------------------------------------------------------------------------
// Bridge double
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct FakeBridge {
    inner: Arc<FakeBridgeInner>,
}

struct FakeBridgeInner {
    reachable: Mutex<bool>,
    reply: Mutex<BridgeReply>,
    forwards: Mutex<Vec<(String, serde_json::Value, Option<String>)>>,
}

impl FakeBridge {
    pub fn new() -> Self {
        FakeBridge {
            inner: Arc::new(FakeBridgeInner {
                reachable: Mutex::new(true),
                reply: Mutex::new(BridgeReply {
                    ok: true,
                    status: 200,
                    body: serde_json::json!({}),
                }),
                forwards: Mutex::new(Vec::new()),
            }),
        }
    }

    pub fn unreachable() -> Self {
        let bridge = FakeBridge::new();
        bridge.set_reachable(false);
        bridge
    }

    pub fn set_reply(&self, reply: BridgeReply) {
        *self.inner.reply.lock().expect("reply lock") = reply;
    }

    pub fn set_reachable(&self, reachable: bool) {
        *self.inner.reachable.lock().expect("reachable lock") = reachable;
    }

    pub fn forwards(&self) -> Vec<(String, serde_json::Value, Option<String>)> {
        self.inner.forwards.lock().expect("forwards lock").clone()
    }
}

impl Default for FakeBridge {
    fn default() -> Self {
        FakeBridge::new()
    }
}

impl BridgePlane for FakeBridge {
    fn forward(
        &self,
        route: &str,
        payload: &serde_json::Value,
        auth_token: Option<&str>,
    ) -> BridgeReply {
        self.inner.forwards.lock().expect("forwards lock").push((
            route.to_string(),
            payload.clone(),
            auth_token.map(String::from),
        ));
        self.inner.reply.lock().expect("reply lock").clone()
    }

    fn ready(&self) -> bool {
        *self.inner.reachable.lock().expect("reachable lock")
    }
}

// ---------------------------------------------------------------------------
// KMS double
// ---------------------------------------------------------------------------

#[derive(Clone, Default)]
pub struct FakeKms {
    inner: Arc<FakeKmsInner>,
}

#[derive(Default)]
struct FakeKmsInner {
    results: Mutex<HashMap<String, Result<Vec<u8>, String>>>,
    calls: Mutex<Vec<KmsReleaseParams>>,
}

impl FakeKms {
    pub fn releasing(ciphertext: &str, plaintext: Vec<u8>) -> Self {
        let kms = FakeKms::default();
        kms.set_result(ciphertext, Ok(plaintext));
        kms
    }

    pub fn failing(ciphertext: &str, message: &str) -> Self {
        let kms = FakeKms::default();
        kms.set_result(ciphertext, Err(message.to_string()));
        kms
    }

    pub fn set_result(&self, ciphertext: &str, result: Result<Vec<u8>, String>) {
        self.inner
            .results
            .lock()
            .expect("results lock")
            .insert(ciphertext.to_string(), result);
    }

    pub fn calls(&self) -> Vec<KmsReleaseParams> {
        self.inner.calls.lock().expect("calls lock").clone()
    }
}

impl KmsReleaser for FakeKms {
    fn decrypt(&self, params: &KmsReleaseParams) -> Result<Vec<u8>, String> {
        self.inner
            .calls
            .lock()
            .expect("calls lock")
            .push(params.clone());
        self.inner
            .results
            .lock()
            .expect("results lock")
            .get(&params.ciphertext_b64)
            .cloned()
            .unwrap_or_else(|| Err("no canned release for this ciphertext".to_string()))
    }
}

// ---------------------------------------------------------------------------
// State assembly
// ---------------------------------------------------------------------------

pub struct TestState {
    pub attest: FakeAttest,
    pub signer: FakeSigner,
    pub bridge: FakeBridge,
    pub kms: FakeKms,
    pub state: AppState,
}

pub fn test_state(
    overlay_pairs: &[(&str, &str)],
    attest: FakeAttest,
    signer: FakeSigner,
    bridge: FakeBridge,
    kms: FakeKms,
) -> TestState {
    let state = AppState {
        overlay: RwLock::new(EnvOverlay::new(
            overlay_pairs.iter().map(|(key, value)| (*key, *value)),
        )),
        runtime_token_kms_version: AtomicU64::new(0),
        attest: Box::new(attest.clone()),
        signer: Box::new(signer.clone()),
        bridge: Box::new(bridge.clone()),
        kms: Box::new(kms.clone()),
        kms_diag: Mutex::new(KmsDiag::default()),
        bridge_child: None,
    };
    TestState {
        attest,
        signer,
        bridge,
        kms,
        state,
    }
}

pub fn bearer(token: &str) -> http::HeaderMap {
    let mut headers = http::HeaderMap::new();
    headers.insert(
        http::header::AUTHORIZATION,
        http::HeaderValue::from_str(&format!("Bearer {token}")).expect("bearer header"),
    );
    headers
}

pub fn header(name: &str, value: &str) -> http::HeaderMap {
    let mut headers = http::HeaderMap::new();
    headers.insert(
        http::HeaderName::from_lowercase(name.as_bytes()).expect("header name"),
        http::HeaderValue::from_str(value).expect("header value"),
    );
    headers
}

pub fn body_json(payload: &serde_json::Value) -> String {
    serde_json::to_string(payload).expect("payload serializes")
}

/// The healthy-state default overlay: a network and a runtime token. The
/// token rides NITRO_API_TOKEN so BOTH the trusted set and the
/// worker-auth resolution (`MORPHEUS_RUNTIME_TOKEN || NITRO_API_TOKEN ||
/// NITRO_SHARED_SECRET`) see it — the passthrough tests assert the forward
/// carries it.
pub fn healthy_overlay() -> Vec<(&'static str, &'static str)> {
    vec![
        ("MORPHEUS_NETWORK", TEST_NETWORK),
        ("NITRO_API_TOKEN", "s3cret"),
    ]
}
