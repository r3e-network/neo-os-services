//! The app state and the seams the pure dispatch sees. Every capability that
//! reaches outside the host process — signing, compute, KMS, NSM — sits behind
//! a trait so the dispatch core stays a pure function of
//! `(state, method, url, headers, body)` and the tests substitute fakes.

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

/// `{ok, status, body}` — `computeViaWorker`'s return shape, so the
/// fulfillment pipeline consumes the bridge exactly as the merged server
/// consumed the in-process worker.
#[derive(Debug, Clone, PartialEq)]
pub struct BridgeReply {
    pub ok: bool,
    pub status: u16,
    pub body: serde_json::Value,
}

/// The compute plane: the keyless Node child on loopback :8090 in production.
pub trait BridgePlane: Send + Sync {
    /// POST `payload` to the child's worker handler at `route`. The caller
    /// resolves the worker-auth token from the overlay exactly as
    /// `resolveWorkerAuthToken` does (MORPHEUS_RUNTIME_TOKEN, then
    /// NITRO_API_TOKEN, then NITRO_SHARED_SECRET) and hands it over; the
    /// bridge attaches it as both `authorization: Bearer` and
    /// `x-nitro-token` when present.
    fn forward(
        &self,
        route: &str,
        payload: &serde_json::Value,
        auth_token: Option<&str>,
    ) -> BridgeReply;

    /// /health's `checks.compute`: whether the compute lane can serve at all.
    fn ready(&self) -> bool;
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
    /// Base = the image ENV snapshot; provisioned values shadow it.
    pub overlay: RwLock<EnvOverlay>,
    /// The KMS envelope version currently authorizing /provision. 0 = no
    /// KMS-materialized token yet (first boot). Monotonic increase enforced.
    pub runtime_token_kms_version: AtomicU64,
    pub attest: Box<dyn nitro_attest::release::AttestationSource>,
    pub signer: Box<dyn SignerPlane>,
    pub bridge: Box<dyn BridgePlane>,
    pub kms: Box<dyn KmsReleaser>,
    pub kms_diag: Mutex<KmsDiag>,
    /// The keyless compute child's supervisor, when the bin launched one.
    /// `/provision` respawns it with the merged overlay (`child.rs`); the
    /// dispatch core never touches it — the bridge plane forwards over
    /// loopback regardless. `None` in tests and parity runs that drive the
    /// child themselves.
    pub bridge_child: Option<Arc<crate::child::BridgeChild>>,
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
