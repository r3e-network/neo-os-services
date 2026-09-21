//! The environment the host reads. The enclave boots with only the baked image
//! ENV, so `/provision` is what injects network, worker config and the runtime
//! token at runtime — the Node server writes them into `process.env` and every
//! read site observes them. This overlay is the same thing, but as a value the
//! library owns instead of a process-global: the base half is a snapshot taken
//! at construction (which, inside the enclave, is the image ENV and cannot
//! change), and the provisioned half shadows it. Tests construct one from an
//! iterator instead of mutating `std::env`, which keeps the test suites
//! parallelizable without a global lock.

use std::collections::BTreeMap;

/// The complete `/provision` allowlist. Security mode, network, endpoints,
/// custody routing, policy toggles, and trust anchors are deliberately absent:
/// those values belong to the measured image, not to its untrusted parent.
pub const PROVISIONABLE_NAMES: [&str; 13] = [
    "MORPHEUS_RUNTIME_TOKEN_KMS_CIPHERTEXT_BASE64",
    "SIGNER_SERVICE_TOKEN_KMS_CIPHERTEXT_BASE64",
    "MORPHEUS_ORACLE_KMS_CIPHERTEXT_BASE64",
    "MORPHEUS_NEODID_SALT_KMS_CIPHERTEXT_BASE64",
    "MORPHEUS_GAME_SECRET_KMS_CIPHERTEXT_BASE64",
    "MORPHEUS_ORACLE_KMS_DIAG_CIPHERTEXT",
    "AWS_REGION",
    "NITRO_AWS_REGION",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "TWELVEDATA_API_KEY",
    "TD_KEY",
];

pub const CREDENTIAL_NAMES: [&str; 3] = [
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
];

pub fn is_provisionable_name(name: &str) -> bool {
    PROVISIONABLE_NAMES.contains(&name)
}

#[derive(Debug, Clone, Default)]
pub struct EnvOverlay {
    base: BTreeMap<String, String>,
    overlay: BTreeMap<String, String>,
}

impl EnvOverlay {
    /// The production constructor: snapshot `std::env` once. Inside the
    /// enclave the image ENV is fixed at boot, so the snapshot is the whole
    /// truth; the process-global env is never read again.
    pub fn from_process() -> Self {
        EnvOverlay {
            base: std::env::vars().collect(),
            overlay: BTreeMap::new(),
        }
    }

    /// The test constructor: an explicit base. Provisioned values still shadow
    /// it exactly as they shadow the image ENV in production.
    pub fn new<I, K, V>(base: I) -> Self
    where
        I: IntoIterator<Item = (K, V)>,
        K: Into<String>,
        V: Into<String>,
    {
        EnvOverlay {
            base: base
                .into_iter()
                .map(|(k, v)| (k.into(), v.into()))
                .collect(),
            overlay: BTreeMap::new(),
        }
    }

    /// Overlay-first lookup. Unlike the auth reads this is the raw value —
    /// every call site in the Node server re-trims, so the trim lives at the
    /// read helpers ([`Self::get_trimmed`], [`auth::trusted_tokens`]).
    pub fn get(&self, name: &str) -> Option<&str> {
        self.overlay
            .get(name)
            .or_else(|| self.base.get(name))
            .map(String::as_str)
    }

    /// `trimString(process.env[name])` — the form every read site actually
    /// uses. Non-strings collapse to empty in the Node helper, which here
    /// means an absent or whitespace-only value reads as `None`.
    pub fn get_trimmed(&self, name: &str) -> Option<String> {
        self.get(name)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    }

    /// The provision write: apply a non-empty string under an allowlisted name.
    /// Returns whether the key was applied.
    pub fn apply(&mut self, name: &str, value: &serde_json::Value) -> bool {
        if !is_provisionable_name(name) {
            return false;
        }
        // trimString is string-only: a JSON number or object in the provision
        // body is skipped, not stringified.
        let Some(text) = value.as_str() else {
            return false;
        };
        let text = text.trim();
        if text.is_empty() {
            return false;
        }
        self.overlay.insert(name.to_string(), text.to_string());
        true
    }

    /// The one write that bypasses the provision whitelist: the runtime token
    /// materialized from the KMS envelope. `handleProvision` writes it into
    /// `process.env.MORPHEUS_RUNTIME_TOKEN` directly, and auth reads it from
    /// there on the next request.
    pub fn set_runtime_token(&mut self, token: &str) {
        self.overlay
            .insert("MORPHEUS_RUNTIME_TOKEN".to_string(), token.to_string());
    }

    /// Install the custody caller credentials released from the KMS envelope.
    ///
    /// Two of them, because the custody service enforces that a caller names
    /// EXACTLY ONE capability (`neo-signer/src/service.rs`: "capabilities
    /// must name exactly one of sign, raw_sign or admin") while this host
    /// needs two: `raw_sign` for `/sign/raw` and `sign` for the semantic
    /// transaction and EIP-191 fulfilment routes. With one credential one of
    /// the two fulfilment chains is always refused (SVC-B-2). The semantic
    /// token is optional so an existing single-token deployment keeps working
    /// unchanged — it then falls back to the raw token, which is exactly the
    /// old behaviour, contradiction and all.
    ///
    /// Both arrive only through the attested KMS release, and both get the
    /// `nitro-recipient-kms` source marker production demands, so neither can
    /// be host-supplied plaintext.
    pub(crate) fn set_custody_token(&mut self, token: &str, semantic_token: Option<&str>) {
        self.overlay
            .insert("SIGNER_SERVICE_TOKEN".to_string(), token.to_string());
        self.overlay.insert(
            "SIGNER_SERVICE_TOKEN_SOURCE".to_string(),
            "nitro-recipient-kms".to_string(),
        );
        if let Some(semantic_token) = semantic_token {
            self.overlay.insert(
                "SIGNER_SERVICE_SEMANTIC_TOKEN".to_string(),
                semantic_token.to_string(),
            );
            self.overlay.insert(
                "SIGNER_SERVICE_SEMANTIC_TOKEN_SOURCE".to_string(),
                "nitro-recipient-kms".to_string(),
            );
        }
    }

    /// Install KMS-released X25519 key material. This bypass is intentionally
    /// unavailable to callers: only the provision module can invoke it after
    /// recipient-attested release and envelope validation.
    pub(crate) fn set_oracle_key_material(&mut self, material_json: &str) {
        self.overlay.insert(
            "MORPHEUS_ORACLE_KEY_MATERIAL_JSON".to_string(),
            material_json.to_string(),
        );
        self.overlay.insert(
            "MORPHEUS_ORACLE_KEY_SOURCE".to_string(),
            "nitro-recipient-kms".to_string(),
        );
    }

    /// Install a KMS-released NeoDID salt with an unforgeable-in-provision
    /// source marker. The plaintext remains process memory only.
    pub(crate) fn set_neodid_salt(&mut self, salt: &str) {
        self.overlay
            .insert("NEODID_SECRET_SALT".to_string(), salt.to_string());
        self.overlay.insert(
            "NEODID_SECRET_SALT_SOURCE".to_string(),
            "nitro-recipient-kms".to_string(),
        );
    }

    /// Install the non-signing HMAC root for authenticated game sessions.
    /// Only the recipient-attested KMS provision path can set the source
    /// marker; `/provision` never accepts the plaintext root.
    pub(crate) fn set_game_secret_root(&mut self, secret_root_hex: &str) {
        self.overlay.insert(
            "MORPHEUS_GAME_SECRET_ROOT_HEX".to_string(),
            secret_root_hex.to_string(),
        );
        self.overlay.insert(
            "MORPHEUS_GAME_SECRET_ROOT_SOURCE".to_string(),
            "nitro-recipient-kms".to_string(),
        );
    }

    /// The env names the provision response reports — the applied keys, the
    /// way `Object.entries` saw them. The caller sorts.
    pub fn applied_keys(&self) -> impl Iterator<Item = &str> {
        self.overlay.keys().map(String::as_str)
    }

    /// The full view (base shadowed by provisioned) as an owned map — the
    /// request-stable environment snapshot consumed by in-process compute.
    /// It is the Rust equivalent of the `process.env` the merged server
    /// accumulated.
    pub fn merged_map(&self) -> BTreeMap<String, String> {
        let mut merged = self.base.clone();
        merged.extend(
            self.overlay
                .iter()
                .map(|(key, value)| (key.clone(), value.clone())),
        );
        merged
    }
}

#[cfg(test)]
#[path = "../tests/unit/overlay.rs"]
mod tests;
