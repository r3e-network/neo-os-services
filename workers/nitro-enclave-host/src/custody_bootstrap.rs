//! Measured, immutable configuration for custody inside the frontier process.
//! No key material is loaded here. Each router starts sealed and keeps the
//! existing signer's attestation, provisioning, authorization and durability.

use std::collections::{BTreeMap, BTreeSet};
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use axum::Router;
use neo_signer::attestation::BootGuard;
use neo_signer::auth::WorkloadAuthPolicy;
use neo_signer::embedded::{EmbeddedCustodyConfig, EmbeddedCustodyRuntime, MeasuredMigration};
use neo_signer::network::Network;
use neo_signer::vault_profile::VaultProfile;
use sha2::{Digest, Sha256};

use crate::embedded_custody::{embedded_base_url, MAX_CUSTODY_BODY_BYTES};
use crate::network_profiles::NetworkProfiles;
use crate::overlay::EnvOverlay;

pub const PROFILE_FILE: &str = "MORPHEUS_CUSTODY_PROFILE_FILE";
pub const PROFILE_HASH: &str = "MORPHEUS_CUSTODY_PROFILE_SHA256";
pub const DATA_DIR: &str = "MORPHEUS_CUSTODY_DATA_DIR";
pub const AUDIENCE: &str = "MORPHEUS_CUSTODY_WORKLOAD_AUDIENCE";
const CONFIG_KEYS: [&str; 4] = [PROFILE_FILE, PROFILE_HASH, DATA_DIR, AUDIENCE];
pub const ENROLLMENT_MODE: &str = "MORPHEUS_CUSTODY_ENROLLMENT_MODE";
pub const ENROLLMENT_FILE: &str = "MORPHEUS_CUSTODY_ENROLLMENT_FILE";
pub const ENROLLMENT_HASH: &str = "MORPHEUS_CUSTODY_ENROLLMENT_SHA256";
const ENROLLMENT_KEYS: [&str; 3] = [ENROLLMENT_MODE, ENROLLMENT_FILE, ENROLLMENT_HASH];
const MIGRATION_OVERRIDE_KEYS: [&str; 4] = [
    "MORPHEUS_CUSTODY_MIGRATION_MODE",
    "MORPHEUS_CUSTODY_MIGRATION_FILE",
    "MORPHEUS_CUSTODY_MIGRATION_SHA256",
    "NEOOS_LEGACY_N3_MIGRATION_SHA256",
];
/// Opaque measured-runtime handle; custody implementation stays in this module.
pub type InternalRawBridge = neo_signer::embedded::InternalRawBridge;
pub type InternalSemanticBridge = neo_signer::embedded::InternalSemanticBridge;

const MAX_PROFILE_BYTES: u64 = 64 * 1024;

fn absolute_path(value: &str) -> Result<PathBuf, &'static str> {
    let path = Path::new(value);
    if !path.is_absolute()
        || !path.components().any(|c| matches!(c, Component::Normal(_)))
        || path
            .components()
            .any(|c| !matches!(c, Component::RootDir | Component::Normal(_)))
    {
        return Err("embedded custody paths must be absolute without traversal");
    }
    Ok(path.to_path_buf())
}

fn plan(network: &str, overlay: &EnvOverlay) -> Result<EmbeddedCustodyConfig, &'static str> {
    // Migration has no runtime overlay mode/path/hash. Its optional opt-in is a
    // compiler input and fixed image file in neo-signer, never provision data.
    for name in MIGRATION_OVERRIDE_KEYS {
        if overlay.get(name).is_some() {
            return Err("migration configuration must be compiled into the measured image");
        }
    }
    let value = |key| {
        overlay
            .get(key)
            .filter(|v| !v.is_empty())
            .ok_or("incomplete embedded custody configuration")
    };
    let expected_network = match network {
        "mainnet" => Network::Mainnet,
        "testnet" => Network::Testnet,
        _ => return Err("invalid embedded custody network"),
    };
    let file = absolute_path(value(PROFILE_FILE)?)?;
    let data_dir = absolute_path(value(DATA_DIR)?)?;
    let expected = value(PROFILE_HASH)?;
    if expected.len() != 64
        || !expected
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err("embedded custody profile requires an exact SHA-256 binding");
    }
    let metadata =
        std::fs::symlink_metadata(&file).map_err(|_| "embedded custody profile is unavailable")?;
    if !metadata.is_file() || metadata.len() > MAX_PROFILE_BYTES {
        return Err("embedded custody profile must be a bounded regular file");
    }
    let mut bytes = Vec::new();
    std::fs::File::open(file)
        .map_err(|_| "embedded custody profile cannot be opened")?
        .take(MAX_PROFILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "embedded custody profile cannot be read")?;
    if bytes.len() as u64 > MAX_PROFILE_BYTES || hex::encode(Sha256::digest(&bytes)) != expected {
        return Err("embedded custody profile digest mismatch");
    }
    let profile =
        VaultProfile::from_json(&bytes).map_err(|_| "invalid embedded custody profile")?;
    if profile.environment() != expected_network {
        return Err("embedded custody profile network mismatch");
    }
    if overlay.get("SIGNER_SERVICE_URL") != Some(embedded_base_url(network)?.as_str()) {
        return Err("embedded custody requires its exact internal service URL");
    }
    let audience = value(AUDIENCE)?;
    let policy = WorkloadAuthPolicy::new(audience, false)
        .map_err(|_| "invalid embedded custody workload audience")?;
    let migration = MeasuredMigration::from_image_owned(&profile)
        .map_err(|_| "image migration manifest/profile binding invalid")?;
    let enrollment = if ENROLLMENT_KEYS.iter().any(|key| overlay.get(key).is_some()) {
        use neo_signer::enrollment::{ValidatedGenesisEnrollment, MAX_MANIFEST_BYTES};
        if expected_network != Network::Testnet
            || value(ENROLLMENT_MODE)? != neo_signer::enrollment::ENROLLMENT_MODE
        {
            return Err("enrollment requires explicit measured TestNet opt-in");
        }
        let file = absolute_path(value(ENROLLMENT_FILE)?)?;
        let expected = value(ENROLLMENT_HASH)?;
        let metadata =
            std::fs::symlink_metadata(&file).map_err(|_| "enrollment manifest unavailable")?;
        if !metadata.is_file() || metadata.len() > MAX_MANIFEST_BYTES as u64 {
            return Err("enrollment manifest must be a bounded regular file");
        }
        let mut bytes = Vec::new();
        std::fs::File::open(file)
            .map_err(|_| "enrollment manifest unavailable")?
            .take(MAX_MANIFEST_BYTES as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "enrollment manifest unreadable")?;
        if bytes.len() > MAX_MANIFEST_BYTES || hex::encode(Sha256::digest(&bytes)) != expected {
            return Err("enrollment manifest digest mismatch");
        }
        Some(Arc::new(
            ValidatedGenesisEnrollment::from_json(&bytes, &profile)
                .map_err(|_| "enrollment manifest/profile binding invalid")?,
        ))
    } else {
        None
    };
    Ok(EmbeddedCustodyConfig {
        profile: Arc::new(profile),
        enrollment,
        migration,
        expected_network,
        data_dir,
        workload_audience: policy.audience().to_string(),
        max_body_bytes: MAX_CUSTODY_BODY_BYTES,
        max_in_flight_requests: 8,
    })
}

/// Validate the complete plan before any vault is created or any NSM request.
/// Development-only unconfigured hosts retain their existing refusal behavior.
pub fn prepare(
    profiles: &NetworkProfiles,
) -> Result<BTreeMap<String, EmbeddedCustodyConfig>, &'static str> {
    let any_config = profiles.overlays.values().any(|o| {
        CONFIG_KEYS
            .iter()
            .chain(ENROLLMENT_KEYS.iter())
            .chain(MIGRATION_OVERRIDE_KEYS.iter())
            .any(|k| o.get(k).is_some())
    });
    let production_dual = profiles.explicit
        && profiles.overlays.values().any(|o| {
            o.get_trimmed("NODE_ENV")
                .is_some_and(|value| value.eq_ignore_ascii_case("production"))
        });
    if !any_config && !production_dual {
        return Ok(BTreeMap::new());
    }
    let mut plans = BTreeMap::new();
    let mut vaults = BTreeSet::new();
    let mut roots = BTreeSet::new();
    let mut directories = BTreeSet::new();
    let mut audiences = BTreeSet::new();
    for (network, overlay) in &profiles.overlays {
        let config = plan(network, overlay)?;
        if !vaults.insert(*config.profile.vault_id())
            || !roots.insert(*config.profile.root_key_commitment())
            || !directories.insert(config.data_dir.clone())
            || !audiences.insert(config.workload_audience.clone())
        {
            return Err("embedded custody networks require distinct vault identities and state");
        }
        plans.insert(network.clone(), config);
    }
    Ok(plans)
}

pub struct BootedCustody {
    pub routers: BTreeMap<String, Router>,
    pub internal_raw: BTreeMap<String, InternalRawBridge>,
    pub internal_semantic: BTreeMap<String, InternalSemanticBridge>,
}

pub fn boot(profiles: &NetworkProfiles) -> Result<BTreeMap<String, Router>, &'static str> {
    Ok(boot_with_internal_raw(profiles)?.routers)
}

pub fn boot_with_internal_raw(profiles: &NetworkProfiles) -> Result<BootedCustody, &'static str> {
    boot_handles_using(profiles, |config, guard| {
        EmbeddedCustodyRuntime::boot(config, guard)
            .map_err(|_| "embedded custody measured boot failed")
    })
}

#[cfg(test)]
fn boot_using(
    profiles: &NetworkProfiles,
    start: impl FnMut(EmbeddedCustodyConfig, BootGuard) -> Result<EmbeddedCustodyRuntime, &'static str>,
) -> Result<BTreeMap<String, Router>, &'static str> {
    Ok(boot_handles_using(profiles, start)?.routers)
}

fn boot_handles_using(
    profiles: &NetworkProfiles,
    mut start: impl FnMut(
        EmbeddedCustodyConfig,
        BootGuard,
    ) -> Result<EmbeddedCustodyRuntime, &'static str>,
) -> Result<BootedCustody, &'static str> {
    let plans = prepare(profiles)?;
    let mut result = BootedCustody {
        routers: BTreeMap::new(),
        internal_raw: BTreeMap::new(),
        internal_semantic: BTreeMap::new(),
    };
    for (network, config) in plans {
        let guard =
            BootGuard::required(None).map_err(|_| "embedded custody boot policy is invalid")?;
        let runtime = start(config, guard)?;
        if let Some(bridge) = runtime.internal_raw_bridge() {
            result.internal_raw.insert(network.clone(), bridge);
        }
        if let Some(bridge) = runtime.internal_semantic_bridge() {
            result.internal_semantic.insert(network.clone(), bridge);
        }
        result.routers.insert(network, runtime.router());
    }
    Ok(result)
}

/// Separate namespace; native router remains the authority for methods/auth.
/// Call only after the shared network selector's canonical-path checks.
pub fn native_path(path: &str) -> Option<&str> {
    let native = path.strip_prefix("/custody")?;
    let base = native.split('?').next()?;
    if matches!(base, "/health" | "/attestation" | "/provision" | "/metrics")
        || base.starts_with("/signer/api/v1/")
    {
        Some(native)
    } else {
        None
    }
}

#[cfg(test)]
#[path = "../tests/unit/custody_bootstrap.rs"]
mod tests;
