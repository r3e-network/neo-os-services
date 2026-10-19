//! Attested custody bootstrap shared by embedded and standalone runtimes.
//!
//! Dispatch handles own their vault lifetime. See `docs/EMBEDDED_CUSTODY.md`.

use crate::{
    api::{self, ApiState},
    attestation::BootGuard,
    auth::WorkloadAuthPolicy,
    network::Network,
    signclient::SignClientBridge,
    vault::{MASTER_KEY_ENV, MASTER_KEY_FILE},
    vault_profile::ValidatedVaultProfile,
};
use anyhow::{Context, Result};
use axum::Router;
use fs2::FileExt;
use nitro_attest::release::{AttestationSource, NsmAttestation};
use std::{
    fs::{File, OpenOptions},
    path::{Path, PathBuf},
    sync::Arc,
};

pub const DATABASE_FILE: &str = "signer.db";
pub const PROCESS_LOCK_FILE: &str = "signer.lock";

/// Required, explicit configuration. Boot validates and consumes this value;
/// no runtime environment setting can rewrite its profile or network binding.
pub struct EmbeddedCustodyConfig {
    pub profile: Arc<ValidatedVaultProfile>,
    pub enrollment: Option<Arc<crate::enrollment::ValidatedGenesisEnrollment>>,
    pub expected_network: Network,
    pub data_dir: PathBuf,
    pub workload_audience: String,
    pub max_body_bytes: usize,
    pub max_in_flight_requests: usize,
}

/// A sealed attested vault with lifetime-safe dispatch handles. No key material
/// or `ApiState` is exposed. Clones share the same admission budgets and lease.
#[derive(Clone)]
pub struct EmbeddedCustodyRuntime {
    state: ApiState,
    expected_network: Network,
    measured_pcr0: String,
}

impl EmbeddedCustodyRuntime {
    /// Production bootstrap. NSM must answer this boot's fresh challenge before
    /// a router can exist. Root release remains exclusively in `/provision`.
    pub fn boot(config: EmbeddedCustodyConfig, guard: BootGuard) -> Result<Self> {
        Self::boot_with_attestation_source(config, guard, &NsmAttestation)
    }

    /// The same bootstrap with an explicit attestation source. Synthetic
    /// sources are for testing; production callers use [`Self::boot`].
    pub fn boot_with_attestation_source(
        config: EmbeddedCustodyConfig,
        guard: BootGuard,
        source: &dyn AttestationSource,
    ) -> Result<Self> {
        anyhow::ensure!(
            matches!(config.expected_network, Network::Mainnet | Network::Testnet),
            "embedded custody requires a public expected network"
        );
        anyhow::ensure!(
            config.profile.environment() == config.expected_network,
            "vault profile environment mismatch"
        );
        anyhow::ensure!(
            !config.data_dir.as_os_str().is_empty(),
            "custody data directory is required"
        );
        anyhow::ensure!(
            config.max_body_bytes > 0 && config.max_body_bytes <= isize::MAX as usize,
            "custody body limit must be a positive representable byte count"
        );
        anyhow::ensure!(
            config.max_in_flight_requests > 0
                && config.max_in_flight_requests <= tokio::sync::Semaphore::MAX_PERMITS,
            "custody in-flight limit must be a positive semaphore capacity"
        );
        anyhow::ensure!(
            config
                .max_body_bytes
                .checked_mul(config.max_in_flight_requests)
                .is_some_and(|bytes| bytes <= isize::MAX as usize),
            "custody aggregate body budget exceeds addressable memory"
        );
        if let Some(enrollment) = &config.enrollment {
            enrollment.validate_profile(&config.profile)?;
        }
        let workload_auth = WorkloadAuthPolicy::new(&config.workload_audience, false)
            .map_err(anyhow::Error::msg)?;
        refuse_plaintext_master_key(&config.data_dir)?;
        let lease = Arc::new(VaultProcessLease::acquire(&config.data_dir)?);
        let measured_pcr0 = guard
            .verify(source)
            .map_err(|error| anyhow::anyhow!("attested boot refused: {error}"))?;
        let state = ApiState::attested_pending(
            config.data_dir.join(DATABASE_FILE),
            config.data_dir,
            config.profile,
        )
        .with_enrollment(config.enrollment)
        .with_process_lease(lease)
        .with_workload_auth(workload_auth)
        .with_body_limit(config.max_body_bytes)
        .with_max_in_flight_requests(config.max_in_flight_requests);
        Ok(Self {
            state,
            expected_network: config.expected_network,
            measured_pcr0,
        })
    }

    /// Native custody routes. State and detached work retain the OS lease even
    /// when this runtime or the requesting router clone is dropped.
    pub fn router(&self) -> Router {
        api::router(self.state.clone())
    }

    pub fn expected_network(&self) -> Network {
        self.expected_network
    }

    pub fn measured_pcr0(&self) -> &str {
        &self.measured_pcr0
    }

    /// Preserve the standalone binary's existing optional adapter without
    /// exposing its underlying state or starting a listener.
    pub fn signclient_bridge(
        &self,
        key_id: impl Into<String>,
        caller_token: &str,
    ) -> SignClientBridge {
        SignClientBridge::new(self.state.clone(), key_id, caller_token)
    }
}

/// Exclusive OS lease for one data directory. Used by standalone admin boot
/// and retained in embedded pending state and recovered service clones.
#[derive(Debug)]
pub struct VaultProcessLease {
    _file: File,
}

impl VaultProcessLease {
    pub fn acquire(data_dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(data_dir).with_context(|| {
            format!(
                "failed to create signer data directory {}",
                data_dir.display()
            )
        })?;
        let path = data_dir.join(PROCESS_LOCK_FILE);
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&path)
            .with_context(|| format!("failed to open signer process lock {}", path.display()))?;
        file.try_lock_exclusive().with_context(|| {
            format!(
                "signer data directory {} is already in use by another signer process",
                data_dir.display()
            )
        })?;
        Ok(Self { _file: file })
    }
}

fn refuse_plaintext_master_key(data_dir: &Path) -> Result<()> {
    anyhow::ensure!(
        std::env::var_os(MASTER_KEY_ENV).is_none_or(|value| value.is_empty()),
        "{MASTER_KEY_ENV} is set in an attested deployment; use attested /provision"
    );
    match std::fs::symlink_metadata(data_dir.join(MASTER_KEY_FILE)) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).context("failed to inspect plaintext master key path"),
        Ok(_) => {
            anyhow::bail!("plaintext {MASTER_KEY_FILE} is forbidden in an attested deployment")
        }
    }
}
