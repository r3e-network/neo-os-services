//! The app state and the seams the pure dispatch sees. Every capability that
//! reaches outside the host process — signing, compute, KMS, NSM — sits behind
//! a trait so the dispatch core stays a pure function of
//! `(state, method, url, headers, body)` and the tests substitute fakes.

use std::collections::BTreeMap;
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex, RwLock};

use crate::overlay::EnvOverlay;

/// One signing role's pinned-identity report — the Rust shape of
/// `reportPinnedNeoN3Role`'s fields the host actually consumes. The custody
/// service is the authority; the host only relays these into /health,
/// /provision's `roles`, /attestation's public key and the sign shims.
#[derive(Debug, Clone, PartialEq)]
pub struct RoleReport {
    /// The report resolved without contradiction.
    pub ok: bool,
    /// A usable key exists.
    pub materialized: bool,
    /// Hex public key, empty when absent.
    pub public_key: String,
    /// `selected_identity || pinned || null` — the identity fields
    /// (/keys/derived reads address/script_hash/public_key from it).
    pub identity: serde_json::Value,
    /// `report.issues` — joined into /health's `signer_error`.
    pub issues: Vec<String>,
    /// `kms_attested` | `host_plaintext` | `none` — how the key reached the
    /// trust boundary; surfaced so any plaintext reliance is detectable.
    pub key_source: String,
}

impl RoleReport {
    pub fn not_configured() -> Self {
        RoleReport {
            ok: false,
            materialized: false,
            public_key: String::new(),
            identity: serde_json::Value::Null,
            issues: Vec::new(),
            key_source: "none".to_string(),
        }
    }
}

/// The signing plane: loopback custody in production, fakes in tests. The
/// host NEVER holds keys — that is the property `lib.rs` promises — so
/// everything here is a request to the custody service.
pub trait SignerPlane: Send + Sync {
    fn role_report(&self, network: &str, role: &str) -> RoleReport;

    /// Blind-sign `data_hex` with the role's key. Errors become dispatch
    /// RuntimeErrors (the custody 503s pass through).
    fn sign_payload(
        &self,
        network: &str,
        role: &str,
        data_hex: &str,
    ) -> Result<serde_json::Value, crate::RuntimeError>;
}

/// `{ok, status, body}` — the historical `computeViaWorker` response shape
/// retained at the fulfillment boundary while the last request types migrate.
#[derive(Debug, Clone, PartialEq)]
pub struct BridgeReply {
    pub ok: bool,
    pub status: u16,
    pub body: serde_json::Value,
}

/// Temporary fulfillment-compute seam. Production uses the deterministic
/// no-IO refusal implementation; tests inject canned compute outcomes so
/// digest and signature assertions stay independent from lane execution.
pub trait BridgePlane: Send + Sync {
    fn forward(
        &self,
        route: &str,
        payload: &serde_json::Value,
        auth_token: Option<&str>,
    ) -> BridgeReply;
}

/// The feed price plane: one batched TwelveData `/price` call over the
/// enclave egress lane in production, a canned map in tests. The reply is
/// keyed by the ORIGINAL request symbol — unmapped symbols and dropped
/// quotes are simply absent (`missing` to the fold).
pub trait PriceSource: Send + Sync {
    fn fetch_prices(
        &self,
        symbols: &[String],
    ) -> Result<BTreeMap<String, f64>, crate::RuntimeError>;
}

/// The oracle IO plane — the three env effects the folded oracle lanes
/// (`oracle_read.rs`) cannot do themselves: the upstream HTTP transport, the
/// SSRF-pinned DNS resolution, and the clock/sleep pair
/// `perform_oracle_fetch` drives timeouts with. Production wires reqwest +
/// `ToSocketAddrs` + `SystemTime` ([`crate::oracle_read`] docs); tests
/// substitute canned transports, which is also how the JS fixture tests
/// inject fetch.
pub trait OracleIo: Send + Sync {
    fn fetch(
        &self,
        request: &neo_os_compute::transport::HttpRequest,
    ) -> Result<neo_os_compute::transport::HttpResponse, String>;

    fn dns_lookup(
        &self,
        host: &str,
    ) -> Result<Vec<neo_os_compute::ssrf::ResolvedAddress>, String>;

    fn now_ms(&self) -> u64;

    fn sleep_ms(&self, ms: u64);
}

/// The attestation-gated KMS release seam: decrypt a base64 ciphertext from
/// inside the measured boundary. The production impl is
/// `nitro_attest::release::release_bytes` over `NsmAttestation` +
/// `HttpKmsTransport`; the recipient attestation proves the release went to
/// the enclave whose PCRs the key policy pins. Credentials come from the
/// provision body (the start script relays IMDSv2 role credentials), never
/// from the process env — the overlay discipline keeps tests off
/// `std::env`.
pub trait KmsReleaser: Send + Sync {
    /// Errors are the release-flow message strings (`AttestResult`'s error
    /// type); the provision route maps every failure to its 503.
    fn decrypt(&self, params: &KmsReleaseParams) -> Result<Vec<u8>, String>;
}

/// What a release call carries — the provision env's projected KMS inputs.
#[derive(Debug, Clone)]
pub struct KmsReleaseParams {
    pub region: String,
    pub ciphertext_b64: String,
    pub access_key_id: String,
    pub secret_access_key: String,
    pub session_token: Option<String>,
}

/// `/health`'s `kms_diag` — the outcome of the last diagnostic KMS probe,
/// never the plaintext. The host's probe is its own runtime-token
/// materialization; the oracle-key diag probe lives with the custody service
/// in the split.
#[derive(Debug, Clone, PartialEq)]
pub struct KmsDiag {
    pub value: serde_json::Value,
}

impl Default for KmsDiag {
    fn default() -> Self {
        KmsDiag {
            value: serde_json::json!({ "state": "not_run" }),
        }
    }
}

/// Everything the dispatch reads or mutates. Interior mutability only —
/// dispatch takes `&AppState` and stays a pure function of it.
pub struct AppState {
    /// Base = the image ENV snapshot; provisioned values shadow it. Shared
    /// behind an `Arc` so the custody signing plane reads the SAME live
    /// environment the routes see — `/provision` can connect custody
    /// (`SIGNER_SERVICE_URL`) mid-flight, and the plane must observe that on
    /// its next call without the host holding a second env copy.
    pub overlay: Arc<RwLock<EnvOverlay>>,
    /// The KMS envelope version currently authorizing /provision. 0 = no
    /// KMS-materialized token yet (first boot). Monotonic increase enforced.
    pub runtime_token_kms_version: AtomicU64,
    pub attest: Box<dyn nitro_attest::release::AttestationSource>,
    pub signer: Box<dyn SignerPlane>,
    /// Canned fulfillment compute for byte-contract unit tests. Production
    /// has no override and always executes the route match in-process.
    #[cfg(test)]
    pub fulfillment_compute_override: Option<Box<dyn BridgePlane>>,
    pub kms: Box<dyn KmsReleaser>,
    /// The `/feed/sign` price fetcher (`feed_sign.rs`).
    pub price: Box<dyn PriceSource>,
    /// The folded oracle lanes' egress/clock plane (`oracle_read.rs`).
    pub oracle_io: Box<dyn OracleIo>,
    /// The oracle provider caches (config TTL, response TTL, circuit
    /// breakers) — module-level Maps in the JS worker, shared across
    /// requests here.
    pub oracle_runtime: Mutex<neo_os_compute::oracle::providers::ProviderRuntime>,
    pub kms_diag: Mutex<KmsDiag>,
}

impl AppState {
    /// `resolveNetwork()`: `normalizeMorpheusNetwork(MORPHEUS_NETWORK ||
    /// 'testnet')` over the live overlay — /provision can change it.
    pub fn resolve_network(&self) -> String {
        crate::normalize_network(
            self.overlay
                .read()
                .expect("overlay lock")
                .get_trimmed("MORPHEUS_NETWORK")
                .as_deref(),
        )
    }

    /// The two signing roles the enclave holds, in the order
    /// `signerRolesHealth` emits them.
    pub const SIGNING_ROLES: [&str; 2] = ["updater", "oracle_verifier"];
}

#[cfg(test)]
#[path = "../tests/unit/state.rs"]
mod tests;
