use std::{
    fs::{File, OpenOptions},
    path::{Path, PathBuf},
};

use rusqlite::{
    backup::{Backup, StepResult},
    config::DbConfig,
    MAIN_DB,
};
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;

use super::*;
use crate::snapshot::{SnapshotCipher, SnapshotHead, SnapshotPosition, MAX_SNAPSHOT_BYTES};

impl Store {
    /// Authenticate and validate a complete snapshot in an isolated, read-only
    /// in-memory database. This never opens a path, creates a replacement Store,
    /// migrates the supplied database, or installs it as the active vault.
    ///
    /// `expected` is only an exact comparison target here. Its freshness and
    /// authenticity must be established by the future external head verifier.
    /// Only the exact current schema is supported; historical schemas require
    /// a separate, explicit migration rather than an open-or-create fallback.
    pub fn restore_snapshot(
        cipher: &SnapshotCipher,
        envelope: &[u8],
        expected: &SnapshotHead,
    ) -> Result<Connection> {
        let plaintext = cipher.open(envelope, expected)?;
        validate_sqlite_image(&plaintext)?;

        let mut restored = Connection::open_in_memory()?;
        restored.set_db_config(DbConfig::SQLITE_DBCONFIG_DEFENSIVE, true)?;
        restored.set_db_config(DbConfig::SQLITE_DBCONFIG_TRUSTED_SCHEMA, false)?;
        restored.set_db_config(DbConfig::SQLITE_DBCONFIG_ENABLE_TRIGGER, false)?;
        restored.set_db_config(DbConfig::SQLITE_DBCONFIG_ENABLE_VIEW, false)?;
        restored.execute_batch(
            "PRAGMA foreign_keys = ON; PRAGMA query_only = ON; PRAGMA temp_store = MEMORY;",
        )?;
        restored
            .deserialize_read_exact(MAIN_DB, plaintext.as_slice(), plaintext.len(), true)
            .context("custody snapshot could not be deserialized")?;
        drop(plaintext);

        // Generate the reference using the same definitions as Store::open,
        // but never apply these definitions or migrations to the restored data.
        let reference = Connection::open_in_memory()?;
        schema::create_signer_tables(&reference)?;
        schema::migrate_signer_tables(&reference)?;
        schema::create_signer_indexes(&reference)?;
        anyhow::ensure!(
            schema_objects(&restored)? == schema_objects(&reference)?,
            "snapshot schema is not the exact current custody schema; explicit migration is required"
        );
        for pragma in ["application_id", "user_version", "encoding"] {
            let query = format!("PRAGMA {pragma}");
            let actual: rusqlite::types::Value =
                restored.query_row(&query, [], |row| row.get(0))?;
            let supported: rusqlite::types::Value =
                reference.query_row(&query, [], |row| row.get(0))?;
            anyhow::ensure!(actual == supported, "unsupported snapshot {pragma}");
        }

        let mut check = restored.prepare("PRAGMA integrity_check")?;
        let mut rows = check.query([])?;
        let first = rows
            .next()?
            .map(|row| row.get::<_, String>(0))
            .transpose()?;
        anyhow::ensure!(
            first.as_deref() == Some("ok") && rows.next()?.is_none(),
            "custody snapshot failed SQLite integrity validation"
        );
        drop(rows);
        drop(check);
        let mut foreign_keys = restored.prepare("PRAGMA foreign_key_check")?;
        anyhow::ensure!(
            foreign_keys.query([])?.next()?.is_none(),
            "custody snapshot contains broken foreign-key references"
        );
        drop(foreign_keys);
        validate_snapshot_networks(&restored, cipher)?;
        Ok(restored)
    }

    /// Authenticate a remote snapshot and install it as a brand-new active
    /// database without ever opening, creating, migrating, or overwriting the
    /// target first. Attested boot uses this after authenticating remote HEAD.
    pub fn install_snapshot(
        path: impl AsRef<Path>,
        cipher: &SnapshotCipher,
        envelope: &[u8],
        expected: &SnapshotHead,
    ) -> Result<Self> {
        let target = path.as_ref();
        anyhow::ensure!(
            !target.exists(),
            "attested restore target already exists; stale local state is never authoritative"
        );
        for sidecar in sqlite_sidecars(target) {
            anyhow::ensure!(
                !sidecar.exists(),
                "attested restore target has a stale SQLite sidecar"
            );
        }

        // All cryptographic and SQLite checks happen in memory before a target
        // path exists. Invalid remote bytes therefore cannot leave a database
        // that a later boot might mistake for restored state.
        let restored = Self::restore_snapshot(cipher, envelope, expected)?;
        let parent = target
            .parent()
            .context("attested restore target must have a parent directory")?;
        std::fs::create_dir_all(parent)
            .with_context(|| format!("failed to create restore directory {}", parent.display()))?;
        let file_name = target
            .file_name()
            .and_then(|name| name.to_str())
            .context("attested restore target must have a UTF-8 file name")?;
        let staging_path =
            parent.join(format!(".{file_name}.restore-{}.tmp", uuid::Uuid::new_v4()));
        let mut options = OpenOptions::new();
        options.read(true).write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600);
        options.open(&staging_path).with_context(|| {
            format!(
                "failed to create restore staging file {}",
                staging_path.display()
            )
        })?;
        let staging = StagingFile(staging_path.clone());

        let mut destination = Connection::open(&staging_path)?;
        {
            let backup = Backup::new(&restored, &mut destination)?;
            anyhow::ensure!(
                backup.step(-1)? == StepResult::Done,
                "restored custody database could not be installed atomically"
            );
        }
        destination.execute_batch("PRAGMA journal_mode = DELETE; PRAGMA foreign_keys = ON;")?;
        drop(destination);
        File::open(&staging_path)?.sync_all()?;

        // hard_link is the same-filesystem, no-clobber publication primitive:
        // unlike rename on Unix it fails if another target appeared after the
        // check above. The process-wide vault lease excludes a legitimate race.
        std::fs::hard_link(&staging_path, target).with_context(|| {
            format!(
                "failed to publish restored custody database {} without overwrite",
                target.display()
            )
        })?;
        File::open(parent)?.sync_all()?;
        drop(staging);

        let installed = Self {
            db_path: target.to_path_buf(),
        };
        let connection = installed.connection()?;
        validate_snapshot_networks(&connection, cipher)?;
        Ok(installed)
    }

    /// Export a consistent SQLite image, including WAL-resident rows, then
    /// encrypt all tables before any bytes leave the custody process.
    /// The signing commit barrier must hold its mutation lock around this call
    /// and the external CAS; a snapshot alone is not a durability guarantee.
    pub fn sealed_snapshot(
        &self,
        cipher: &SnapshotCipher,
        position: SnapshotPosition,
    ) -> Result<(Vec<u8>, SnapshotHead)> {
        let source = self.connection()?;
        source.execute_batch("BEGIN DEFERRED")?;
        // Establish a read snapshot before checking its size or copying pages.
        source.query_row("SELECT COUNT(*) FROM sqlite_schema", [], |row| {
            row.get::<_, i64>(0)
        })?;
        let pages: u64 = source.query_row("PRAGMA page_count", [], |row| row.get(0))?;
        let page_size: u64 = source.query_row("PRAGMA page_size", [], |row| row.get(0))?;
        anyhow::ensure!(
            pages
                .checked_mul(page_size)
                .is_some_and(|bytes| bytes <= MAX_SNAPSHOT_BYTES as u64),
            "custody database exceeds the snapshot limit"
        );
        let mut destination = Connection::open_in_memory()?;
        {
            let backup = Backup::new(&source, &mut destination)?;
            anyhow::ensure!(
                backup.step(-1)? == StepResult::Done,
                "custody snapshot could not finish without contention"
            );
        }
        // An in-memory backup must not retain WAL mode in its serialized header.
        destination.execute_batch("PRAGMA journal_mode = MEMORY; VACUUM;")?;
        let image = destination.serialize(MAIN_DB)?;
        cipher.seal(&image, position)
    }
}

struct StagingFile(PathBuf);

impl Drop for StagingFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn sqlite_sidecars(path: &Path) -> [PathBuf; 3] {
    ["-wal", "-shm", "-journal"].map(|suffix| {
        let mut value = path.as_os_str().to_os_string();
        value.push(suffix);
        PathBuf::from(value)
    })
}

fn validate_sqlite_image(image: &[u8]) -> Result<()> {
    anyhow::ensure!(
        image.len() >= 512 && image.starts_with(b"SQLite format 3\0"),
        "snapshot plaintext is not a complete SQLite database"
    );
    anyhow::ensure!(
        image[18..20] == [1, 1],
        "snapshot must be a standalone SQLite database without WAL dependencies"
    );
    let encoded_page_size = u16::from_be_bytes(image[16..18].try_into()?);
    let page_size = if encoded_page_size == 1 {
        65_536
    } else {
        usize::from(encoded_page_size)
    };
    anyhow::ensure!(
        page_size >= 512 && page_size.is_power_of_two(),
        "snapshot has an unsupported SQLite page size"
    );
    let pages = usize::try_from(u32::from_be_bytes(image[28..32].try_into()?))?;
    anyhow::ensure!(
        pages.checked_mul(page_size) == Some(image.len()),
        "snapshot SQLite page count does not match its exact image length"
    );
    Ok(())
}

type SchemaObject = (String, String, String, Option<String>);

fn schema_objects(connection: &Connection) -> Result<Vec<SchemaObject>> {
    let mut statement = connection.prepare(
        "SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name, tbl_name",
    )?;
    let objects = statement
        .query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(objects)
}

fn validate_snapshot_networks(connection: &Connection, cipher: &SnapshotCipher) -> Result<()> {
    let binding = cipher.binding();
    let network = if binding.neo_n3_magic
        == crate::network::network_magic(crate::network::Network::Mainnet)
    {
        crate::network::Network::Mainnet
    } else {
        crate::network::Network::Testnet
    };
    let mut keys = connection.prepare(
        "SELECT id, label, network, public_key, nonce, ciphertext, created_at_unix, disabled,
                network_magic, chain_family, chain_id FROM signer_keys",
    )?;
    for key in keys.query_map([], signer_key_from_row)? {
        let key = key.context("custody snapshot contains an unreadable key record")?;
        let chain_id = match key.chain_family {
            crate::network::ChainFamily::NeoN3 => u64::from(binding.neo_n3_magic),
            crate::network::ChainFamily::NeoX => binding.neox_chain_id,
        };
        anyhow::ensure!(
            key.network == network
                && binding.permits_chain(key.chain_family)
                && key.network_magic == binding.neo_n3_magic
                && key.chain_id == chain_id,
            "custody snapshot key does not match its bound network identities"
        );
    }
    let invalid_reservations: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM signer_consensus_reservations WHERE network_magic != ?1)",
        [binding.neo_n3_magic],
        |row| row.get(0),
    )?;
    anyhow::ensure!(
        !invalid_reservations,
        "custody snapshot state does not match its bound network identities"
    );
    Ok(())
}
