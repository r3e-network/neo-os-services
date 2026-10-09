//! The app state and the seams the pure dispatch sees. Every capability that
//! reaches outside the host process — signing, compute, KMS, NSM — sits behind
//! a trait so the dispatch core stays a pure function of
//! `(state, method, url, headers, body)` and the tests substitute fakes.

use std::collections::BTreeMap;
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex, RwLock};
use zeroize::Zeroizing;

use neo_os_compute::oracle::crypto::{generate_x25519_key_material, OracleKeyMaterial};

use crate::overlay::EnvOverlay;
use crate::RuntimeError;

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

/// One semantic NeoX fulfillment signing call. Grouping the complete policy
/// context prevents implementations from accidentally swapping adjacent
/// string arguments or accepting a partial signing intent.
pub struct Eip191FulfillmentRequest<'a> {
    pub network: &'a str,
    pub role: &'a str,
    pub chain_id: u64,
    pub oracle_contract: &'a str,
    pub fulfillment: &'a neo_os_chain_evm::Fulfillment,
    pub result_bytes_hex: &'a str,
    pub request_id: &'a str,
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

    /// Sign a fully constructed unsigned EIP-1559 transaction with a
    /// chain-bound custody key. The host constructs the transaction and the
    /// custody service enforces the immutable NeoX chain id and policy before
    /// returning the complete serialized transaction.
    fn sign_transaction(
        &self,
        _network: &str,
        role: &str,
        _chain_id: u64,
        _unsigned_hex: &str,
        _request_id: &str,
    ) -> Result<serde_json::Value, crate::RuntimeError> {
        Err(crate::http_error(
            503,
            format!("{role} transaction signer is not configured"),
        ))
    }

    /// Sign a complete Neo N3 unsigned transaction through custody's semantic
    /// transaction route. Unlike `sign_payload`, this lets the signer parse
    /// the invocation and enforce contract, recipient, asset, fee, and rate
    /// policy before the updater witness exists.
    fn sign_n3_transaction(
        &self,
        _network: &str,
        role: &str,
        _unsigned_hex: &str,
        _request_id: &str,
    ) -> Result<serde_json::Value, crate::RuntimeError> {
        Err(crate::http_error(
            503,
            format!("{role} Neo N3 transaction signer is not configured"),
        ))
    }

    /// Sign the canonical, chain-and-contract-bound NeoX fulfillment digest.
    /// The host supplies structured fields, never a caller-selected digest;
    /// custody independently re-encodes them before applying the key policy.
    fn sign_eip191_fulfillment(
        &self,
        request: &Eip191FulfillmentRequest<'_>,
    ) -> Result<serde_json::Value, crate::RuntimeError> {
        Err(crate::http_error(
            503,
            format!(
                "{} EIP-191 fulfillment signer is not configured",
                request.role
            ),
        ))
    }
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

    fn dns_lookup(&self, host: &str) -> Result<Vec<neo_os_compute::ssrf::ResolvedAddress>, String>;

    fn now_ms(&self) -> u64;

    fn sleep_ms(&self, ms: u64);
}

/// Web3Auth trust-anchor transport. The cache and single-flight refresh policy
/// live in `neodid`; this seam performs only one HTTP fetch so tests can prove
/// refresh classification and concurrency without external network access.
pub trait JwksFetcher: Send + Sync {
    fn fetch_jwks(&self, url: &str) -> Result<serde_json::Value, String>;
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
    fn decrypt(&self, params: &KmsReleaseParams) -> Result<Zeroizing<Vec<u8>>, String>;
}

/// What a release call carries — the provision env's projected KMS inputs,
/// plus the three image-owned bindings the untrusted parent cannot restate.
///
/// `region`, `ciphertext_b64` and the credentials are host-supplied by
/// construction: the parent relays them through `/provision`. `purpose`,
/// `network` and `key_arn` are NOT — they come from the measured image and
/// the resolved network, and they are what stops a compromised parent from
/// wrapping its own envelope under its own CMK and having the enclave accept
/// it (CL-10/CL-12). `purpose` and `network` become a KMS encryption context,
/// which KMS itself checks before releasing any plaintext; `key_arn` pins the
/// one CMK whose key policy carries the `kms:RecipientAttestation:*`
/// conditions for this image.
#[derive(Debug, Clone)]
pub struct KmsReleaseParams {
    pub region: String,
    pub ciphertext_b64: String,
    pub access_key_id: String,
    pub secret_access_key: String,
    pub session_token: Option<String>,
    /// The per-secret purpose label, bound into the KMS encryption context.
    pub purpose: String,
    /// The image-resolved network, bound into the KMS encryption context so a
    /// testnet envelope cannot open on a mainnet enclave even before the
    /// in-band envelope fields are read.
    pub network: String,
    /// The pinned CMK ARN. `None` is possible only outside production, where
    /// `FRONTIER_KMS_KEY_ARN` may be unset for a local dry run.
    pub key_arn: Option<String>,
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
    /// NeoDID Web3Auth JWKS egress. Cache ownership remains process-global in
    /// `neodid`, matching the compatibility worker's remote-JWKS set.
    pub jwks_fetcher: Box<dyn JwksFetcher>,
    /// The oracle provider caches (config TTL, response TTL, circuit
    /// breakers) — module-level Maps in the JS worker, shared across
    /// requests here.
    pub oracle_runtime: Mutex<neo_os_compute::oracle::providers::ProviderRuntime>,
    pub kms_diag: Mutex<KmsDiag>,
    /// What the price plane has observed: the last classified provider failure,
    /// this UTC day's write count, and the write timestamps the runway is
    /// measured from. Reported by `/health`; it never gates readiness, because a
    /// provider outage does not stop this host from signing.
    pub price_plane_status: Arc<Mutex<crate::feed_status::PricePlaneStatus>>,
    /// Per-route admission control (CL-34). The Node worker this host
    /// replaces calls the same guard on every request after auth
    /// (`workers/nitro-worker/src/worker.js`); the Rust port shipped the
    /// guard and its tests but never wired it, leaving an authenticated
    /// caller able to park unbounded blocking-pool threads in a fixed-memory
    /// single-node enclave. One guard per process, like the JS module global.
    pub overload: neo_os_compute::overload::OverloadGuard,
    /// The process-lifetime ephemeral oracle key (CU-148). Empty until the
    /// first lane that needs it outside production, then never replaced. See
    /// [`AppState::ephemeral_oracle_key`] for why the lifetime is the process
    /// and not the request.
    pub ephemeral_oracle_key: Mutex<Option<OracleKeyMaterial>>,
}

impl AppState {
    /// The ONE ephemeral oracle key this process serves.
    ///
    /// The key is minted on first use and returned unchanged for the rest of
    /// the process, which is what `docs/ENVIRONMENT.md` already promises:
    /// "a process-lifetime ephemeral oracle key ... decryptability ends with
    /// the process". That promise is what makes the key usable at all —
    /// `/oracle/public-key` advertises the material a caller encrypts to, and
    /// `/compute/execute` (and the other lanes that decrypt with this key)
    /// must resolve that same material. When each lane minted its own key the
    /// advertised public key opened nothing, which is the defect CU-148's
    /// review found.
    ///
    /// What a shared lifetime key costs, stated rather than assumed away: a
    /// per-request key bounds a memory-disclosure to the one request whose key
    /// leaked, while this one key decrypts every ephemeral envelope the
    /// process ever accepted, for as long as the process lives. The exposure
    /// is bounded the same way the feature is: the ephemeral branch is reachable
    /// only when `MORPHEUS_ALLOW_EPHEMERAL_KEY` is set, `NODE_ENV=production`
    /// refuses that flag inside [`crate::compute_execute`]'s resolver and
    /// `neo_os_compute`'s policy check before any key is minted, and the flag is
    /// image ENV — `/provision` materializes a fixed set of KMS-derived names
    /// and cannot set it. The key is memory-only: it is never written to disk,
    /// never leaves the measured boundary, and it is dropped with the process,
    /// so its lifetime is also the enclave's boot, not the calendar.
    pub fn ephemeral_oracle_key(&self) -> OracleKeyMaterial {
        let mut slot = self
            .ephemeral_oracle_key
            .lock()
            .expect("ephemeral oracle key lock");
        if let Some(key) = slot.as_ref() {
            return key.clone();
        }
        let mut os = rand::rngs::OsRng;
        let key = {
            use rand::RngCore;
            generate_x25519_key_material(&mut |buffer: &mut [u8]| os.fill_bytes(buffer))
        };
        *slot = Some(key.clone());
        key
    }

    /// Resolve the live overlay against the reviewed network registry. A
    /// malformed explicit label is a runtime configuration error, never a
    /// request to use TestNet.
    pub fn resolve_network(&self) -> Result<String, RuntimeError> {
        let raw = self
            .overlay
            .read()
            .expect("overlay lock")
            .get_trimmed("MORPHEUS_NETWORK");
        crate::normalize_network(raw.as_deref()).map_err(|message| crate::http_error(503, message))
    }

    /// Resolve and cross-check every measured custody role. In addition to
    /// each key's own immutable policy, the NeoX updater and verifier must
    /// resolve to different on-chain identities. Distinct key ids alone are
    /// insufficient because two records can still wrap the same key.
    pub fn signing_role_reports(&self) -> Result<Vec<(&'static str, RoleReport)>, RuntimeError> {
        let network = self.resolve_network()?;
        let mut reports: Vec<(&'static str, RoleReport)> = Self::SIGNING_ROLES
            .iter()
            .map(|role| (*role, self.signer.role_report(&network, role)))
            .collect();

        let updater_index = reports
            .iter()
            .position(|(role, _)| *role == "neox_updater")
            .expect("NeoX updater is a measured signing role");
        let verifier_index = reports
            .iter()
            .position(|(role, _)| *role == "neox_verifier")
            .expect("NeoX verifier is a measured signing role");
        let (before_verifier, verifier_and_after) = reports.split_at_mut(verifier_index);
        let updater = &mut before_verifier[updater_index].1;
        let verifier = &mut verifier_and_after[0].1;
        let updater_address = evm_identity_address(updater);
        let verifier_address = evm_identity_address(verifier);
        if updater.ok
            && updater.materialized
            && verifier.ok
            && verifier.materialized
            && updater_address.is_some()
            && updater_address == verifier_address
        {
            const ISSUE: &str = "NeoX updater and verifier resolve to the same custody identity";
            updater.ok = false;
            updater.issues.push(format!("neox_updater: {ISSUE}"));
            verifier.ok = false;
            verifier.issues.push(format!("neox_verifier: {ISSUE}"));
        }
        Ok(reports)
    }

    /// Every custody identity pinned into the measured service topology, in
    /// the order `/health` and `/provision` report them. Keeping this list in
    /// one place prevents the image manifest, runtime readiness, and the
    /// signing routes from silently disagreeing about which roles are
    /// required.
    pub const SIGNING_ROLES: [&str; 6] = [
        "updater",
        "oracle_verifier",
        "relayer",
        "worker",
        "neox_updater",
        "neox_verifier",
    ];
}

fn evm_identity_address(report: &RoleReport) -> Option<String> {
    let address = report.identity.get("address")?.as_str()?.trim();
    let raw = address
        .strip_prefix("0x")
        .or_else(|| address.strip_prefix("0X"))?;
    (raw.len() == 40 && raw.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .then(|| raw.to_ascii_lowercase())
}

#[cfg(test)]
#[path = "../tests/unit/state.rs"]
mod tests;
