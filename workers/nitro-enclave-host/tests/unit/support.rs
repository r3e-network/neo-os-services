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

use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex, RwLock};

use crate::overlay::EnvOverlay;
use crate::state::{
    AppState, BridgePlane, BridgeReply, KmsDiag, KmsReleaseParams, KmsReleaser, OracleIo,
    PriceSource, RoleReport, SignerPlane,
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
    reply: Mutex<BridgeReply>,
    forwards: Mutex<Vec<(String, serde_json::Value, Option<String>)>>,
}

impl FakeBridge {
    pub fn new() -> Self {
        FakeBridge {
            inner: Arc::new(FakeBridgeInner {
                reply: Mutex::new(BridgeReply {
                    ok: true,
                    status: 200,
                    body: serde_json::json!({}),
                }),
                forwards: Mutex::new(Vec::new()),
            }),
        }
    }

    pub fn set_reply(&self, reply: BridgeReply) {
        *self.inner.reply.lock().expect("reply lock") = reply;
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
// Price source double
// ---------------------------------------------------------------------------

/// A canned symbol→price map. Unlike the production fetcher it does NOT drop
/// non-positive quotes — tests use that to exercise the plan's
/// `invalid_price` guard through the fold.
#[derive(Clone, Default)]
pub struct FakePrice {
    inner: Arc<FakePriceInner>,
}

#[derive(Default)]
struct FakePriceInner {
    prices: Mutex<HashMap<String, f64>>,
    error: Mutex<Option<String>>,
    calls: Mutex<Vec<Vec<String>>>,
}

impl FakePrice {
    pub fn with_prices(pairs: &[(&str, f64)]) -> Self {
        let price = FakePrice::default();
        {
            let mut prices = price.inner.prices.lock().expect("prices lock");
            for (symbol, value) in pairs {
                prices.insert((*symbol).to_string(), *value);
            }
        }
        price
    }

    pub fn failing(message: &str) -> Self {
        let price = FakePrice::default();
        *price.inner.error.lock().expect("error lock") = Some(message.to_string());
        price
    }

    pub fn set_error(&self, message: &str) {
        *self.inner.error.lock().expect("error lock") = Some(message.to_string());
    }

    pub fn set_price(&self, symbol: &str, price: f64) {
        self.inner
            .prices
            .lock()
            .expect("prices lock")
            .insert(symbol.to_string(), price);
    }

    pub fn calls(&self) -> Vec<Vec<String>> {
        self.inner.calls.lock().expect("calls lock").clone()
    }
}

impl PriceSource for FakePrice {
    fn fetch_prices(&self, symbols: &[String]) -> Result<BTreeMap<String, f64>, RuntimeError> {
        self.inner
            .calls
            .lock()
            .expect("calls lock")
            .push(symbols.to_vec());
        let error = self.inner.error.lock().expect("error lock").clone();
        if let Some(message) = error {
            return Err(crate::http_error(500, message));
        }
        let prices = self.inner.prices.lock().expect("prices lock");
        Ok(symbols
            .iter()
            .filter_map(|symbol| prices.get(symbol).map(|value| (symbol.clone(), *value)))
            .collect())
    }
}

// ---------------------------------------------------------------------------
// Oracle IO double
// ---------------------------------------------------------------------------

/// The oracle lanes' IO: one scriptable HTTP reply (the last `set_reply`
/// wins), a canned public DNS answer so the SSRF pin passes, a controllable
/// clock, and a no-op sleep. The production impl lives in
/// `bin/enclave_host.rs` (real reqwest + `ToSocketAddrs`); the default canned
/// address `93.184.216.34` is the same public-IP convention the
/// morpheus-compute fetch fixtures use.
#[derive(Clone, Default)]
pub struct FakeOracleIo {
    inner: Arc<FakeOracleIoInner>,
}

#[derive(Default)]
struct FakeOracleIoInner {
    reply: Mutex<Option<Result<morpheus_compute::transport::HttpResponse, String>>>,
    fetches: Mutex<Vec<(String, String)>>,
    addresses: Mutex<Vec<morpheus_compute::ssrf::ResolvedAddress>>,
    now_ms: AtomicU64,
}

impl FakeOracleIo {
    pub fn with_reply(reply: morpheus_compute::transport::HttpResponse) -> Self {
        let io = FakeOracleIo::default();
        io.set_reply(Ok(reply));
        io
    }

    pub fn failing(message: &str) -> Self {
        let io = FakeOracleIo::default();
        io.set_reply(Err(message.to_string()));
        io
    }

    pub fn set_reply(&self, reply: Result<morpheus_compute::transport::HttpResponse, String>) {
        *self.inner.reply.lock().expect("reply lock") = Some(reply);
    }

    pub fn set_addresses(&self, addresses: &[(&str, u8)]) {
        *self.inner.addresses.lock().expect("addresses lock") = addresses
            .iter()
            .map(
                |(address, family)| morpheus_compute::ssrf::ResolvedAddress {
                    address: (*address).to_string(),
                    family: *family,
                },
            )
            .collect();
    }

    pub fn set_now_ms(&self, now_ms: u64) {
        self.inner
            .now_ms
            .store(now_ms, std::sync::atomic::Ordering::SeqCst);
    }

    /// `(method, url)` of every fetch that went through the plane.
    pub fn fetches(&self) -> Vec<(String, String)> {
        self.inner.fetches.lock().expect("fetches lock").clone()
    }
}

impl OracleIo for FakeOracleIo {
    fn fetch(
        &self,
        request: &morpheus_compute::transport::HttpRequest,
    ) -> Result<morpheus_compute::transport::HttpResponse, String> {
        self.inner
            .fetches
            .lock()
            .expect("fetches lock")
            .push((request.method.clone(), request.url.clone()));
        match self.inner.reply.lock().expect("reply lock").clone() {
            Some(reply) => reply,
            None => Ok(morpheus_compute::transport::HttpResponse {
                status: 200,
                headers: vec![("content-type".to_string(), "application/json".to_string())],
                body: b"{}".to_vec(),
            }),
        }
    }

    fn dns_lookup(
        &self,
        _host: &str,
    ) -> Result<Vec<morpheus_compute::ssrf::ResolvedAddress>, String> {
        let addresses = self.inner.addresses.lock().expect("addresses lock").clone();
        if addresses.is_empty() {
            return Ok(vec![morpheus_compute::ssrf::ResolvedAddress {
                address: "93.184.216.34".to_string(),
                family: 4,
            }]);
        }
        Ok(addresses)
    }

    fn now_ms(&self) -> u64 {
        self.inner.now_ms.load(std::sync::atomic::Ordering::SeqCst)
    }

    fn sleep_ms(&self, _ms: u64) {}
}

// ---------------------------------------------------------------------------
// State assembly
// ---------------------------------------------------------------------------

pub struct TestState {
    pub attest: FakeAttest,
    pub signer: FakeSigner,
    pub bridge: FakeBridge,
    pub kms: FakeKms,
    pub price: FakePrice,
    pub oracle_io: FakeOracleIo,
    pub state: AppState,
}

pub fn test_state(
    overlay_pairs: &[(&str, &str)],
    attest: FakeAttest,
    signer: FakeSigner,
    bridge: FakeBridge,
    kms: FakeKms,
) -> TestState {
    let price = FakePrice::default();
    let oracle_io = FakeOracleIo::default();
    let state = AppState {
        overlay: Arc::new(RwLock::new(EnvOverlay::new(
            overlay_pairs.iter().map(|(key, value)| (*key, *value)),
        ))),
        runtime_token_kms_version: AtomicU64::new(0),
        attest: Box::new(attest.clone()),
        signer: Box::new(signer.clone()),
        fulfillment_compute_override: Some(Box::new(bridge.clone())),
        kms: Box::new(kms.clone()),
        price: Box::new(price.clone()),
        oracle_io: Box::new(oracle_io.clone()),
        oracle_runtime: Mutex::new(morpheus_compute::oracle::providers::ProviderRuntime::default()),
        kms_diag: Mutex::new(KmsDiag::default()),
    };
    TestState {
        attest,
        signer,
        bridge,
        kms,
        price,
        oracle_io,
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

/// The healthy-state default overlay: a network and a runtime token.
pub fn healthy_overlay() -> Vec<(&'static str, &'static str)> {
    vec![
        ("MORPHEUS_NETWORK", TEST_NETWORK),
        ("NITRO_API_TOKEN", "s3cret"),
    ]
}
