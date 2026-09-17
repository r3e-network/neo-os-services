//! Where the signer's state lives: one SQLite file and the eight tables that
//! hold custody keys, boundaries, caller grants, the audit trail and the spend
//! ledger plus the durable dBFT anti-equivocation journal and workload nonce
//! reservations.
//!
//! This is the whole persistence surface of the service. It was a set of
//! `impl Repository` blocks in `neo-nexus`; here it is its own store so the
//! signer does not open a node-operations database, and so a custody deployment
//! cannot end up sharing a file with the console that used to host it.
//!
//! Two rules the type enforces by construction:
//!
//! * Every method speaks in terms of the signer's own types ([`SignerKey`],
//!   [`SignerPolicy`], [`SignerCaller`], [`SignerAuditRecord`],
//!   [`SignerValueEvent`]). Nothing outside this module opens a connection, so
//!   nothing outside it can write SQL against these tables by accident.
//! * The connection carries `PRAGMA foreign_keys = ON`, which is what makes the
//!   `ON DELETE CASCADE` on `signer_policies` real — see `Store::connection`.

use std::{
    fs,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};

use crate::{
    model::{
        CallerCapability, ContractMethod, KeyGrant, ScriptHash, SignerAuditRecord, SignerCaller,
        SignerConsensusReservation, SignerKey, SignerPolicy, SignerRequestCompletion,
        SignerValueEvent,
    },
    policy::WindowSpend,
};

mod audit;
mod callers;
mod consensus;
mod keys;
mod management;
mod policies;
mod requests;
mod rows;
mod schema;
mod snapshot;
mod value_events;
mod workload_nonces;

pub(crate) use management::ManagementChange;
use rows::*;

#[derive(Debug, Clone)]
pub struct Store {
    db_path: PathBuf,
}

impl Store {
    /// Open (creating if necessary) the signer database at `path`.
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let db_path = path.as_ref().to_path_buf();
        if let Some(parent) = db_path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("failed to create data directory {}", parent.display()))?;
        }

        let repository = Self { db_path };
        repository.initialize()?;
        Ok(repository)
    }

    pub fn db_path(&self) -> &Path {
        &self.db_path
    }

    /// A fresh connection on every call, with foreign keys enforced.
    fn connection(&self) -> Result<Connection> {
        let connection = Connection::open(&self.db_path)
            .with_context(|| format!("failed to open database {}", self.db_path.display()))?;
        connection
            .execute_batch("PRAGMA foreign_keys = ON;")
            .context("failed to enable SQLite foreign-key enforcement")?;
        Ok(connection)
    }

    /// Create the signer tables and indexes if they are not there yet, then
    /// apply any column-level widening they need.
    ///
    /// [`schema::migrate_signer_tables`] is the whole migration surface today:
    /// one named, guarded `ALTER TABLE` per added column, not a
    /// `add_column_if_missing` loop that accepts whatever string a caller passes.
    /// A change to the *shape* of an existing signer column is still a different
    /// thing — it needs its own reviewed step, because custody data that has been
    /// quietly reinterpreted is worse than custody data that failed to open.
    fn initialize(&self) -> Result<()> {
        let connection = self.connection()?;
        schema::create_signer_tables(&connection)?;
        schema::migrate_signer_tables(&connection)?;
        schema::create_signer_indexes(&connection)?;
        Ok(())
    }
}

/// Separator between the list entries stored in a `TEXT` column.
const ARG_SEPARATOR: char = '\u{1f}';

fn encode_args(args: &[String]) -> String {
    args.join(&ARG_SEPARATOR.to_string())
}

fn decode_args(raw: &str) -> Vec<String> {
    if raw.is_empty() {
        Vec::new()
    } else {
        raw.split(ARG_SEPARATOR).map(ToString::to_string).collect()
    }
}

/// Fails when a write affected no rows, signalling that the targeted record did
/// not exist. Centralizes the `"<entity> {id} was not found"` error used by
/// every delete, update, and mark operation so the phrasing stays consistent.
fn ensure_affected_rows(affected: usize, entity: &str, id: &str) -> Result<()> {
    if affected == 0 {
        anyhow::bail!("{entity} {id} was not found");
    }
    Ok(())
}

#[cfg(test)]
#[path = "../tests/unit/store.rs"]
mod tests;
