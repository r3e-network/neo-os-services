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
use sha2::{Digest, Sha256};
use std::{
    fs::{File, OpenOptions},
    io::Read,
    path::{Path, PathBuf},
    sync::Arc,
};

pub const DATABASE_FILE: &str = "signer.db";
pub const PROCESS_LOCK_FILE: &str = "signer.lock";

/// Both the fixed path and expected digest belong to the measured build. There
/// is no runtime env, HTTP body, path or expected-hash setter for this loader.
pub const MIGRATION_MANIFEST_FILE: &str = "/opt/neoos/custody/legacy-n3-migration.json";
const IMAGE_MIGRATION_SHA256: Option<&str> = option_env!("NEOOS_LEGACY_N3_MIGRATION_SHA256");

/// Public opaque boot configuration, not an owner-admission credential. The
/// preparation kernel stays crate-private; this facade only loads a pinned
/// image file. The separate coordinator authorizes genesis or exact restore.
pub struct MeasuredMigration {
    core: crate::migration::MeasuredMigration,
}

impl MeasuredMigration {
    /// Missing build-time opt-in preserves existing boot behavior. A dual image
    /// applies this Mainnet-only manifest to Mainnet; Testnet keeps enrollment.
    pub fn from_image_owned(profile: &ValidatedVaultProfile) -> Result<Option<Arc<Self>>> {
        let Some(expected) = IMAGE_MIGRATION_SHA256 else {
            return Ok(None);
        };
        if profile.environment() != Network::Mainnet {
            return Ok(None);
        }
        Self::load_pinned_file(Path::new(MIGRATION_MANIFEST_FILE), expected, profile)
            .map(|migration| Some(Arc::new(migration)))
    }

    fn load_pinned_file(
        path: &Path,
        expected: &str,
        profile: &ValidatedVaultProfile,
    ) -> Result<Self> {
        anyhow::ensure!(
            expected.len() == 64
                && expected
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
            "migration build requires an exact SHA-256 binding"
        );
        let digest: [u8; 32] = hex::decode(expected)?
            .try_into()
            .map_err(|_| anyhow::anyhow!("invalid migration build digest"))?;
        anyhow::ensure!(digest != [0; 32], "zero migration build digest refused");
        let metadata =
            std::fs::symlink_metadata(path).context("image migration manifest unavailable")?;
        anyhow::ensure!(
            metadata.is_file() && metadata.len() <= crate::migration::MAX_MANIFEST_BYTES as u64,
            "image migration manifest must be a bounded regular file"
        );
        let mut bytes = Vec::new();
        File::open(path)
            .context("image migration manifest unavailable")?
            .take(crate::migration::MAX_MANIFEST_BYTES as u64 + 1)
            .read_to_end(&mut bytes)
            .context("image migration manifest unreadable")?;
        let actual: [u8; 32] = Sha256::digest(&bytes).into();
        anyhow::ensure!(
            !bytes.is_empty()
                && bytes.len() <= crate::migration::MAX_MANIFEST_BYTES
                && actual == digest,
            "image migration manifest digest mismatch"
        );
        Ok(Self {
            core: crate::migration::MeasuredMigration::from_measured_bytes(
                &bytes, &digest, profile,
            )?,
        })
    }

    pub(crate) fn validate_profile(&self, profile: &ValidatedVaultProfile) -> Result<()> {
        self.core.validate_profile(profile)
    }

    pub(crate) fn core(&self) -> &crate::migration::MeasuredMigration {
        &self.core
    }
}

/// Required, explicit configuration. Boot validates and consumes this value;
/// no runtime environment setting can rewrite its profile or network binding.
pub struct EmbeddedCustodyConfig {
    pub profile: Arc<ValidatedVaultProfile>,
    pub enrollment: Option<Arc<crate::enrollment::ValidatedGenesisEnrollment>>,
    pub migration: Option<Arc<MeasuredMigration>>,
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
    migration: Option<Arc<MeasuredMigration>>,
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
        anyhow::ensure!(
            config.migration.is_none() || config.enrollment.is_none(),
            "migration and Testnet enrollment are mutually exclusive"
        );
        if let Some(migration) = &config.migration {
            migration.validate_profile(&config.profile)?;
        }
        let workload_auth = WorkloadAuthPolicy::new(&config.workload_audience, false)
            .map_err(anyhow::Error::msg)?;
        refuse_plaintext_master_key(&config.data_dir)?;
        let lease = Arc::new(VaultProcessLease::acquire(&config.data_dir)?);
        let measured_pcr0 = guard
            .verify(source)
            .map_err(|error| anyhow::anyhow!("attested boot refused: {error}"))?;
        let migration = config.migration.clone();
        let state = ApiState::attested_pending(
            config.data_dir.join(DATABASE_FILE),
            config.data_dir,
            config.profile,
        )
        .with_enrollment(config.enrollment)
        .with_migration(config.migration)
        .with_process_lease(lease)
        .with_workload_auth(workload_auth)
        .with_body_limit(config.max_body_bytes)
        .with_max_in_flight_requests(config.max_in_flight_requests);
        Ok(Self {
            state,
            expected_network: config.expected_network,
            measured_pcr0,
            migration,
        })
    }

    /// Native custody routes. State and detached work retain the OS lease even
    /// when this runtime or the requesting router clone is dropped.
    pub fn router(&self) -> Router {
        api::router(self.state.clone())
    }

    /// Private, non-listening raw dispatcher. It exposes no token, key, state
    /// or general router and cannot authorize semantic/admin routes.
    pub fn internal_raw_bridge(&self) -> Option<InternalRawBridge> {
        self.migration.as_ref().map(|migration| InternalRawBridge {
            state: self.state.clone(),
            migration: migration.clone(),
        })
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

/// A measured migration's internal caller, without a public bearer accessor.
/// Requests still enter the canonical API, including policy, audit and durable
/// commit. This object must never be mounted as an external route.
#[derive(Clone)]
pub struct InternalRawBridge {
    state: ApiState,
    migration: Arc<MeasuredMigration>,
}

impl InternalRawBridge {
    #[cfg(test)]
    pub(crate) fn fixture(state: ApiState, core: crate::migration::MeasuredMigration) -> Self {
        Self {
            state,
            migration: Arc::new(MeasuredMigration { core }),
        }
    }

    pub async fn dispatch(
        &self,
        mut request: axum::http::Request<axum::body::Body>,
    ) -> Result<axum::response::Response, &'static str> {
        use axum::http::{header, HeaderValue, Method};
        use tower::ServiceExt;
        let path = request.uri().path();
        let permitted = request.uri().query().is_none()
            && ((request.method() == Method::POST && path == "/signer/api/v1/sign/raw")
                || (request.method() == Method::GET
                    && self
                        .migration
                        .core()
                        .key_ids()
                        .iter()
                        .any(|id| path == format!("/signer/api/v1/keys/{id}"))));
        if !permitted
            || request.headers().contains_key(header::AUTHORIZATION)
            || request.headers().contains_key(header::ORIGIN)
        {
            return Err("internal raw route or credential refused");
        }
        let service = self
            .state
            .service_snapshot()
            .ok_or("internal raw vault not ready")?;
        let migration = self.migration.clone();
        let token = tokio::task::spawn_blocking(move || {
            service.migration_internal_raw_token(migration.core())
        })
        .await
        .map_err(|_| "internal raw admission failed")?
        .map_err(|_| "current internal raw caller is not admitted")?;
        let value = zeroize::Zeroizing::new(format!("Bearer {}", token.as_str()));
        let mut value = HeaderValue::from_str(value.as_str())
            .map_err(|_| "internal raw credential encoding failed")?;
        value.set_sensitive(true);
        request.headers_mut().insert(header::AUTHORIZATION, value);
        Ok(api::router(self.state.clone())
            .oneshot(request)
            .await
            .expect("Router error is Infallible"))
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

#[cfg(test)]
#[path = "../tests/unit/measured_plumbing.rs"]
pub(crate) mod tests;
