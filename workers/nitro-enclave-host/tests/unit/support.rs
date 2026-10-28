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
    AppState, BridgePlane, BridgeReply, Eip191FulfillmentRequest, JwksFetcher, KmsDiag,
    KmsReleaseParams, KmsReleaser, OracleIo, PriceSource, RoleReport, SignerPlane,
};
use crate::RuntimeError;
use rlp::{Rlp, RlpStream};
use zeroize::Zeroizing;

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

pub type CapturedTransactionCall = (String, String, u64, String, String);
pub type CapturedN3TransactionCall = (String, String, String, String);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapturedEip191Call {
    pub network: String,
    pub role: String,
    pub chain_id: u64,
    pub oracle_contract: String,
    pub fulfillment: neo_os_chain_evm::Fulfillment,
    pub result_bytes_hex: String,
    pub request_id: String,
}

#[derive(Clone)]
pub struct SignerConfig {
    pub healthy: bool,
    pub unhealthy_roles: Vec<String>,
    pub shared_neox_identity: bool,
    pub measured_n3_adapter: bool,
    pub public_key: String,
    pub identity: serde_json::Value,
    pub issues: Vec<String>,
    pub key_source: String,
    pub sign_result: Option<Result<serde_json::Value, RuntimeError>>,
    pub transaction_result: Option<Result<serde_json::Value, RuntimeError>>,
    pub eip191_result: Option<Result<serde_json::Value, RuntimeError>>,
}

impl Default for SignerConfig {
    fn default() -> Self {
        SignerConfig {
            healthy: true,
            unhealthy_roles: Vec::new(),
            shared_neox_identity: false,
            measured_n3_adapter: false,
            public_key: "02f8a5a1e0f3b6c9d2e5f8a1b4c7d0e3f6a9b2c5d8e1f4a7b0c3d6e9f2a5b8c1"
                .to_string(),
            identity: healthy_identity(),
            issues: Vec::new(),
            key_source: "kms_attested".to_string(),
            sign_result: None,
            transaction_result: None,
            eip191_result: None,
        }
    }
}

struct FakeSignerInner {
    config: Mutex<SignerConfig>,
    sign_calls: Mutex<Vec<(String, String, String)>>,
    transaction_calls: Mutex<Vec<CapturedTransactionCall>>,
    n3_transaction_calls: Mutex<Vec<CapturedN3TransactionCall>>,
    eip191_calls: Mutex<Vec<CapturedEip191Call>>,
}

impl FakeSigner {
    pub fn new(config: SignerConfig) -> Self {
        FakeSigner {
            inner: Arc::new(FakeSignerInner {
                config: Mutex::new(config),
                sign_calls: Mutex::new(Vec::new()),
                transaction_calls: Mutex::new(Vec::new()),
                n3_transaction_calls: Mutex::new(Vec::new()),
                eip191_calls: Mutex::new(Vec::new()),
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

    pub fn transaction_calls(&self) -> Vec<CapturedTransactionCall> {
        self.inner
            .transaction_calls
            .lock()
            .expect("transaction calls lock")
            .clone()
    }

    pub fn n3_transaction_calls(&self) -> Vec<CapturedN3TransactionCall> {
        self.inner
            .n3_transaction_calls
            .lock()
            .expect("N3 transaction calls lock")
            .clone()
    }

    pub fn eip191_calls(&self) -> Vec<CapturedEip191Call> {
        self.inner
            .eip191_calls
            .lock()
            .expect("EIP-191 calls lock")
            .clone()
    }
}

impl SignerPlane for FakeSigner {
    fn measured_n3_transaction_adapter(&self) -> bool {
        self.inner
            .config
            .lock()
            .expect("config lock")
            .measured_n3_adapter
    }

    fn role_report(&self, _network: &str, role: &str) -> RoleReport {
        let config = self.inner.config.lock().expect("config lock").clone();
        if config.healthy && !config.unhealthy_roles.iter().any(|value| value == role) {
            let identity = match role {
                "neox_updater" => serde_json::json!({
                    "address": "0x1111111111111111111111111111111111111111",
                    "script_hash": "0x1111111111111111111111111111111111111111",
                    "public_key": config.public_key,
                    "chain_id": 12_227_332,
                    "chain_family": "neox",
                }),
                "neox_verifier" => {
                    let address = if config.shared_neox_identity {
                        "0x1111111111111111111111111111111111111111"
                    } else {
                        "0x2222222222222222222222222222222222222222"
                    };
                    serde_json::json!({
                        "address": address,
                        "script_hash": address,
                        "public_key": config.public_key,
                        "chain_id": 12_227_332,
                        "chain_family": "neox",
                    })
                }
                _ => config.identity,
            };
            RoleReport {
                ok: true,
                materialized: true,
                public_key: config.public_key,
                identity,
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

    fn sign_transaction(
        &self,
        network: &str,
        role: &str,
        chain_id: u64,
        unsigned_hex: &str,
        request_id: &str,
    ) -> Result<serde_json::Value, RuntimeError> {
        self.inner
            .transaction_calls
            .lock()
            .expect("transaction calls lock")
            .push((
                network.to_string(),
                role.to_string(),
                chain_id,
                unsigned_hex.to_string(),
                request_id.to_string(),
            ));
        let result = self
            .inner
            .config
            .lock()
            .expect("config lock")
            .transaction_result
            .clone();
        if let Some(result) = result {
            return result;
        }
        let raw = unsigned_hex
            .strip_prefix("0x")
            .or_else(|| unsigned_hex.strip_prefix("0X"))
            .unwrap_or(unsigned_hex);
        let unsigned = hex::decode(raw).expect("fake receives valid unsigned hex");
        assert_eq!(unsigned.first(), Some(&0x02));
        let rlp = Rlp::new(&unsigned[1..]);
        assert_eq!(rlp.item_count().expect("unsigned list"), 9);
        let mut signed = RlpStream::new_list(12);
        for index in 0..9 {
            signed.append_raw(rlp.at(index).expect("unsigned item").as_raw(), 1);
        }
        signed.append(&0u8);
        signed.append(&[1u8].as_slice());
        signed.append(&[2u8].as_slice());
        let mut signed_bytes = vec![0x02];
        signed_bytes.extend_from_slice(&signed.out());
        let signed_transaction = format!("0x{}", hex::encode(signed_bytes));
        Ok(serde_json::json!({
            "status": "ok",
            "network": network,
            "role": role,
            "chain_family": "neox",
            "chain_id": chain_id,
            "address": "0x1111111111111111111111111111111111111111",
            "signed_transaction": signed_transaction,
            "signature_hex": signed_transaction,
        }))
    }

    fn sign_n3_transaction(
        &self,
        network: &str,
        role: &str,
        unsigned_hex: &str,
        request_id: &str,
    ) -> Result<serde_json::Value, RuntimeError> {
        self.inner
            .n3_transaction_calls
            .lock()
            .expect("N3 transaction calls lock")
            .push((
                network.to_string(),
                role.to_string(),
                unsigned_hex.to_string(),
                request_id.to_string(),
            ));
        Ok(serde_json::json!({
            "status": "ok",
            "network": network,
            "role": role,
            "chain_family": "neo-n3",
            "key_id": "updater-test",
            "signature": "00",
            "signature_hex": "00",
            "public_key": self.inner.config.lock().expect("config lock").public_key.clone(),
            "address": healthy_identity()["address"],
            "script_hash": healthy_identity()["script_hash"],
            "digest": "0x00",
            "invocation_script": "0c4000",
            "verification_script": "0c2100",
            "key_source": "custody",
        }))
    }

    fn sign_eip191_fulfillment(
        &self,
        request: &Eip191FulfillmentRequest<'_>,
    ) -> Result<serde_json::Value, RuntimeError> {
        let network = request.network;
        let role = request.role;
        let chain_id = request.chain_id;
        let oracle_contract = request.oracle_contract;
        let fulfillment = request.fulfillment;
        let result_bytes_hex = request.result_bytes_hex;
        let request_id = request.request_id;
        self.inner
            .eip191_calls
            .lock()
            .expect("EIP-191 calls lock")
            .push(CapturedEip191Call {
                network: network.to_string(),
                role: role.to_string(),
                chain_id,
                oracle_contract: oracle_contract.to_string(),
                fulfillment: fulfillment.clone(),
                result_bytes_hex: result_bytes_hex.to_string(),
                request_id: request_id.to_string(),
            });
        let result = self
            .inner
            .config
            .lock()
            .expect("config lock")
            .eip191_result
            .clone();
        if let Some(result) = result {
            return result;
        }
        let digest = neo_os_chain_evm::build_neox_digest(
            chain_id,
            oracle_contract,
            fulfillment,
            result_bytes_hex,
        )
        .expect("fake receives a valid structured fulfillment");
        let message_hash = neo_os_chain_evm::eip191_message_hash(&digest);
        Ok(serde_json::json!({
            "status": "ok",
            "network": network,
            "role": role,
            "chain_family": "neox",
            "chain_id": chain_id,
            "key_id": "neox-verifier-test",
            "oracle_contract": oracle_contract,
            "address": "0x1111111111111111111111111111111111111111",
            "public_key": self.inner.config.lock().expect("config lock").public_key.clone(),
            "digest": format!("0x{}", hex::encode(digest)),
            "message_hash": format!("0x{}", hex::encode(message_hash)),
            "signature": format!("0x{}", "00".repeat(64)) + "1b",
            "key_source": "custody",
        }))
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
    fn decrypt(&self, params: &KmsReleaseParams) -> Result<Zeroizing<Vec<u8>>, String> {
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
            .map(|result| match result {
                Ok(bytes) => Ok(Zeroizing::new(bytes.clone())),
                Err(error) => Err(error.clone()),
            })
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
    /// A canned provider response body, so a test can express the JSON failures
    /// TwelveData returns for a 401 or a 429.
    provider_body: Mutex<Option<(u16, serde_json::Value)>>,
    /// The same fixture overlay used by the production parser's key boundary.
    provider_overlay: Mutex<Option<Arc<RwLock<EnvOverlay>>>>,
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

    /// Replace the whole quote set, keyed by the TwelveData symbol.
    pub fn set_prices(&self, pairs: &[(&str, f64)]) {
        let mut prices = self.inner.prices.lock().expect("prices lock");
        prices.clear();
        for (symbol, value) in pairs {
            prices.insert((*symbol).to_string(), *value);
        }
    }

    /// Answer with a provider response body, so a test can express what the real
    /// plane sees — including the JSON failure bodies TwelveData returns for a 401
    /// or a 429. The body goes through the production parse and classification, so
    /// these tests exercise the real rules and not a stand-in for them.
    pub fn set_provider_failure(&self, http_status: u16, body: serde_json::Value) {
        *self.inner.provider_body.lock().expect("provider body lock") = Some((http_status, body));
    }

    pub fn clear_provider_failure(&self) {
        *self.inner.provider_body.lock().expect("provider body lock") = None;
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
        let mapped: Vec<Option<&'static str>> = symbols
            .iter()
            .map(|symbol| crate::feed_sign::to_twelve_data_symbol(symbol))
            .collect();

        // A canned body goes through the PRODUCTION parse and classification, so a
        // test can assert the real rules for a provider failure — including the
        // JSON body TwelveData returns for a 401 or a 429.
        //
        // With no canned body the price map is returned as-is, deliberately: the
        // production fetcher drops non-positive quotes, and several tests here use
        // the raw map to exercise the fold's OWN `invalid_price` backstop, which
        // only sees a quote the fetcher would have dropped.
        if let Some((http_status, body)) = self
            .inner
            .provider_body
            .lock()
            .expect("provider body lock")
            .clone()
        {
            let api_key = self
                .inner
                .provider_overlay
                .lock()
                .expect("provider overlay lock")
                .as_ref()
                .map(|overlay| {
                    overlay
                        .read()
                        .expect("overlay lock")
                        .get_trimmed("TD_KEY")
                        .unwrap_or_default()
                })
                .unwrap_or_default();
            return crate::feed_sign::parse_twelvedata_prices_with_key(
                http_status,
                &body,
                symbols,
                &mapped,
                &api_key,
            )
            .map_err(|failure| {
                crate::http_error(502, failure.summary).with_provider_category(failure.category)
            });
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
/// neo-os-compute fetch fixtures use.
#[derive(Clone, Default)]
pub struct FakeOracleIo {
    inner: Arc<FakeOracleIoInner>,
}

#[derive(Default)]
struct FakeOracleIoInner {
    reply: Mutex<Option<Result<neo_os_compute::transport::HttpResponse, String>>>,
    fetches: Mutex<Vec<(String, String)>>,
    addresses: Mutex<Vec<neo_os_compute::ssrf::ResolvedAddress>>,
    now_ms: AtomicU64,
}

impl FakeOracleIo {
    pub fn with_reply(reply: neo_os_compute::transport::HttpResponse) -> Self {
        let io = FakeOracleIo::default();
        io.set_reply(Ok(reply));
        io
    }

    pub fn failing(message: &str) -> Self {
        let io = FakeOracleIo::default();
        io.set_reply(Err(message.to_string()));
        io
    }

    pub fn set_reply(&self, reply: Result<neo_os_compute::transport::HttpResponse, String>) {
        *self.inner.reply.lock().expect("reply lock") = Some(reply);
    }

    pub fn set_addresses(&self, addresses: &[(&str, u8)]) {
        *self.inner.addresses.lock().expect("addresses lock") = addresses
            .iter()
            .map(|(address, family)| neo_os_compute::ssrf::ResolvedAddress {
                address: (*address).to_string(),
                family: *family,
            })
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
        request: &neo_os_compute::transport::HttpRequest,
    ) -> Result<neo_os_compute::transport::HttpResponse, String> {
        self.inner
            .fetches
            .lock()
            .expect("fetches lock")
            .push((request.method.clone(), request.url.clone()));
        match self.inner.reply.lock().expect("reply lock").clone() {
            Some(reply) => reply,
            None => Ok(neo_os_compute::transport::HttpResponse {
                status: 200,
                headers: vec![("content-type".to_string(), "application/json".to_string())],
                body: b"{}".to_vec(),
            }),
        }
    }

    fn dns_lookup(
        &self,
        _host: &str,
    ) -> Result<Vec<neo_os_compute::ssrf::ResolvedAddress>, String> {
        let addresses = self.inner.addresses.lock().expect("addresses lock").clone();
        if addresses.is_empty() {
            return Ok(vec![neo_os_compute::ssrf::ResolvedAddress {
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

#[derive(Clone, Default)]
pub struct FakeJwksFetcher;

impl JwksFetcher for FakeJwksFetcher {
    fn fetch_jwks(&self, _url: &str) -> Result<serde_json::Value, String> {
        Err("unexpected JWKS fetch in this test".to_string())
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
    pub price: FakePrice,
    pub oracle_io: FakeOracleIo,
    pub jwks_fetcher: FakeJwksFetcher,
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
    let overlay = Arc::new(RwLock::new(EnvOverlay::new(
        overlay_pairs.iter().map(|(key, value)| (*key, *value)),
    )));
    *price
        .inner
        .provider_overlay
        .lock()
        .expect("provider overlay lock") = Some(Arc::clone(&overlay));
    let oracle_io = FakeOracleIo::default();
    let jwks_fetcher = FakeJwksFetcher;
    let state = AppState {
        overlay,
        runtime_token_kms_version: AtomicU64::new(0),
        attest: Box::new(attest.clone()),
        signer: Box::new(signer.clone()),
        fulfillment_compute_override: Some(Box::new(bridge.clone())),
        kms: Box::new(kms.clone()),
        price: Box::new(price.clone()),
        oracle_io: Box::new(oracle_io.clone()),
        jwks_fetcher: Box::new(jwks_fetcher.clone()),
        oracle_runtime: Mutex::new(neo_os_compute::oracle::providers::ProviderRuntime::default()),
        kms_diag: Mutex::new(KmsDiag::default()),
        price_plane_status: Arc::new(Mutex::new(crate::feed_status::PricePlaneStatus::default())),
        overload: neo_os_compute::overload::OverloadGuard::new(),
        ephemeral_oracle_key: Mutex::new(None),
        automation_executions: Mutex::new(Default::default()),
        game_sessions: Mutex::new(neo_os_games::session::SessionStore::new()),
        feed_runtime: Default::default(),
    };
    TestState {
        attest,
        signer,
        bridge,
        kms,
        price,
        oracle_io,
        jwks_fetcher,
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
