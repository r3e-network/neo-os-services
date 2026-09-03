//! What the attestation document says this enclave may sign.
//!
//! The Node signer bound role → public key → script hash into `user_data`, so
//! a remote verifier could confirm *which* keys an enclave holds. §6 names the
//! gap: without the key's boundary the promise in §4 is one the enclave cannot
//! prove — a verifier seeing an oracle_verifier key still cannot tell a
//! transfer-only boundary from a whole-vault one. This module closes it.
//!
//! The binding is two layers, because the NSM caps `user_data` at 512 bytes
//! and a vault's boundaries do not fit:
//!
//! * `user_data` is small and immutable inside the document:
//!   `{"runtime":"neo-signer-custody","vault":"<fingerprint>",
//!   "boundaries_sha256":"<64 hex>"}`.
//! * The full boundaries document travels beside the attestation response, and
//!   the verifier checks `sha256(boundaries_json) == boundaries_sha256` before
//!   trusting anything in it.
//!
//! The vault fingerprint joins the document so two deployments with identical
//! key sets are still distinguishable — the fingerprint is derived from the
//! master key (§6's boot report), never from anything signable.
//!
//! The JSON is built by explicit insertion with this workspace's
//! `preserve_order` serde_json, so the canonical form is stable across
//! processes and a hash recomputed elsewhere matches byte for byte.

use serde_json::{json, Value};

use crate::{
    crypto,
    model::{ContractMethod, ScriptHash, SignerKey, SignerPolicy},
};

/// The runtime name the attestation claims, shared between the `user_data`
/// bytes and the `/attestation` response so both name the same thing.
pub const RUNTIME_NAME: &str = "neo-signer-custody";

/// One key's identity and its whole §4 boundary, as the remote verifier sees
/// it.
pub struct KeyBoundary {
    pub key_id: String,
    pub network: String,
    pub network_magic: u32,
    pub address: String,
    pub script_hash: String,
    pub disabled: bool,
    pub policy: SignerPolicy,
}

impl KeyBoundary {
    /// Build from a key row and its effective policy.
    pub fn new(key: &SignerKey, policy: SignerPolicy) -> anyhow::Result<Self> {
        let script_hash = key.account().ok_or_else(|| {
            anyhow::anyhow!(
                "key {} has a public key that is not a curve point; refusing to bind it",
                key.id
            )
        })?;
        Ok(KeyBoundary {
            key_id: key.id.clone(),
            network: key.network.to_string(),
            network_magic: key.network_magic(),
            address: key.address(),
            script_hash: script_hash.to_string(),
            disabled: key.disabled,
            policy,
        })
    }

    /// The canonical JSON for one boundary. Field order is fixed by
    /// construction; changing it changes every deployment's digest, which is
    /// the point.
    pub fn to_json(&self) -> Value {
        let policy = json!({
            "allow_consensus": self.policy.allow_consensus,
            "allow_raw": self.policy.allow_raw,
            "allow_transfer": self.policy.allow_transfer,
            "allow_contract_call": self.policy.allow_contract_call,
            "allow_global_scope": self.policy.allow_global_scope,
            "contract_whitelist": hashes(&self.policy.contract_whitelist),
            "contract_blacklist": hashes(&self.policy.contract_blacklist),
            "contract_method_whitelist": contract_methods(&self.policy.contract_method_whitelist),
            "contract_method_blacklist": contract_methods(&self.policy.contract_method_blacklist),
            "asset_whitelist": hashes(&self.policy.asset_whitelist),
            "asset_blacklist": hashes(&self.policy.asset_blacklist),
            "asset_limits": self.policy.asset_limits.iter().map(|limit| json!({
                "asset": limit.asset.to_display(),
                "max_single_amount": limit.max_single_amount,
                "window_limit": limit.window_limit.map(|window| json!({
                    "seconds": window.seconds,
                    "max_amount": window.max_amount,
                })),
            })).collect::<Vec<_>>(),
            "transfer_to_whitelist": hashes(&self.policy.transfer_to_whitelist),
            "transfer_to_blacklist": hashes(&self.policy.transfer_to_blacklist),
            "max_single_amount": self.policy.max_single_amount,
            "window_limit": self.policy.window_limit.map(|limit| json!({
                "seconds": limit.seconds,
                "max_amount": limit.max_amount,
            })),
            "max_signers": self.policy.max_signers,
            "max_system_fee": self.policy.max_system_fee,
            "max_network_fee": self.policy.max_network_fee,
            "max_signatures": self.policy.max_signatures.map(|limit| json!({
                "seconds": limit.seconds,
                "count": limit.count,
            })),
        });
        json!({
            "key_id": self.key_id,
            "network": self.network,
            "network_magic": self.network_magic,
            "address": self.address,
            "script_hash": self.script_hash,
            "disabled": self.disabled,
            "policy": policy,
        })
    }
}

fn hashes(list: &[ScriptHash]) -> Vec<String> {
    list.iter().map(|hash| hash.to_string()).collect()
}

fn contract_methods(list: &[ContractMethod]) -> Vec<Value> {
    list.iter()
        .map(|entry| {
            json!({
                "contract": entry.contract.to_string(),
                "method": entry.method,
            })
        })
        .collect()
}

/// The full boundaries document, in canonical compact form. This exact byte
/// string is what `boundaries_sha256` commits to — the `/attestation` response
/// returns it so a verifier never has to guess at serialization.
pub fn boundaries_json(keys: &[KeyBoundary]) -> String {
    let list: Vec<Value> = keys.iter().map(|key| key.to_json()).collect();
    serde_json::to_string(&Value::Array(list)).expect("boundaries JSON is always serializable")
}

/// sha256 of [`boundaries_json`], hex-encoded — the digest that rides in
/// `user_data`.
pub fn boundaries_sha256(keys: &[KeyBoundary]) -> String {
    hex::encode(crypto::sha256(boundaries_json(keys).as_bytes()))
}

/// The `user_data` bytes for the NSM attestation request: the vault identity
/// plus the commitment to the boundaries document.
pub fn attestation_user_data(vault_fingerprint: &str, boundaries_digest: &str) -> Vec<u8> {
    let document = json!({
        "runtime": RUNTIME_NAME,
        "vault": vault_fingerprint,
        "boundaries_sha256": boundaries_digest,
    });
    serde_json::to_vec(&document).expect("user data JSON is always serializable")
}

#[cfg(test)]
#[path = "../tests/unit/attested_identity.rs"]
mod tests;
