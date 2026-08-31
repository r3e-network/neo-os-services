use anyhow::Result;
use rusqlite::Connection;

/// Custody, boundary configuration, caller grants, and the record of what was
/// done with all three.
///
/// Two storage choices are deliberate and both are about failure modes that
/// would otherwise be silent:
///
/// * Raw key material is stored as AEAD output only — `nonce` and `ciphertext`,
///   never a plaintext or derived copy of the private key, and no column an
///   operator would read as a secret.
/// * Amounts are `TEXT`, not `INTEGER`. SQLite integers are 64-bit, and Neo
///   token amounts are `int128`; a wide-decimal token's ordinary transfer would
///   overflow and be stored as a smaller number, which would make the window
///   ceiling pass a request it should refuse.
pub(super) fn create_signer_tables(connection: &Connection) -> Result<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS signer_keys (
            id TEXT PRIMARY KEY,
            label TEXT NOT NULL,
            network TEXT NOT NULL,
            public_key BLOB NOT NULL,
            nonce BLOB NOT NULL,
            ciphertext BLOB NOT NULL,
            created_at_unix INTEGER NOT NULL,
            disabled INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS signer_policies (
            key_id TEXT PRIMARY KEY,
            allow_consensus INTEGER NOT NULL DEFAULT 0,
            allow_transfer INTEGER NOT NULL DEFAULT 0,
            allow_contract_call INTEGER NOT NULL DEFAULT 0,
            allow_global_scope INTEGER NOT NULL DEFAULT 0,
            contract_whitelist TEXT NOT NULL DEFAULT '',
            contract_blacklist TEXT NOT NULL DEFAULT '',
            asset_whitelist TEXT NOT NULL DEFAULT '',
            asset_blacklist TEXT NOT NULL DEFAULT '',
            transfer_to_whitelist TEXT NOT NULL DEFAULT '',
            transfer_to_blacklist TEXT NOT NULL DEFAULT '',
            max_single_amount TEXT,
            window_seconds INTEGER,
            window_max_amount TEXT,
            updated_at_unix INTEGER NOT NULL,
            FOREIGN KEY (key_id) REFERENCES signer_keys(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS signer_callers (
            id TEXT PRIMARY KEY,
            label TEXT NOT NULL,
            token_digest BLOB NOT NULL,
            key_grant_mode TEXT NOT NULL DEFAULT 'only',
            key_grants TEXT NOT NULL DEFAULT '',
            allowed_origins TEXT NOT NULL DEFAULT '',
            created_at_unix INTEGER NOT NULL,
            disabled INTEGER NOT NULL DEFAULT 0,
            capabilities TEXT NOT NULL DEFAULT 'sign'
        );
        -- No foreign keys on purpose. An audit row that disappears when a key
        -- or a caller is deleted is not an audit row; custody history has to
        -- outlive the things it describes.
        CREATE TABLE IF NOT EXISTS signer_audit (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            recorded_at_unix INTEGER NOT NULL,
            action TEXT NOT NULL,
            outcome TEXT NOT NULL,
            caller_id TEXT,
            key_id TEXT,
            tx_id TEXT,
            reason TEXT,
            detail TEXT,
            origin TEXT
        );
        CREATE TABLE IF NOT EXISTS signer_value_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            key_id TEXT NOT NULL,
            recorded_at_unix INTEGER NOT NULL,
            asset BLOB NOT NULL,
            amount TEXT NOT NULL,
            audit_id INTEGER
        );",
    )?;
    Ok(())
}

/// Bring an existing database up to the shape this crate reads.
///
/// `capabilities` arrived with the management API (§5.1), so a `signer_callers`
/// table created before it has no such column and every caller `SELECT` would
/// fail — and a signer that cannot read its caller list refuses everything,
/// which presents as an outage rather than as schema drift.
/// [`create_signer_tables`] cannot add it, because `CREATE TABLE IF NOT EXISTS`
/// is a no-op on the old shape.
///
/// The stored default is `'sign'`, the *lesser* of the two capabilities. A row
/// this step touches was created by a deployment that had no admin surface at
/// all, so promoting it to one would hand console authority to a token that was
/// only ever issued to a relayer.
pub(super) fn migrate_signer_tables(connection: &Connection) -> Result<()> {
    if !has_column(connection, "signer_callers", "capabilities")? {
        connection.execute(
            "ALTER TABLE signer_callers ADD COLUMN capabilities TEXT NOT NULL DEFAULT 'sign'",
            [],
        )?;
    }
    Ok(())
}

/// Whether a table already carries a column.
fn has_column(connection: &Connection, table: &str, column: &str) -> Result<bool> {
    let found: i64 = connection.query_row(
        "SELECT COUNT(*) FROM pragma_table_info(?1) WHERE name = ?2",
        rusqlite::params![table, column],
        |row| row.get(0),
    )?;
    Ok(found > 0)
}

/// The three indexes the signer reads through.
pub(super) fn create_signer_indexes(connection: &Connection) -> Result<()> {
    // One key held under two ids would spend its window limit twice: each row
    // accumulates its own transfers, and the policy ceiling is per key id. The
    // only safe place to notice that is the database.
    connection.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_signer_keys_public_key
         ON signer_keys (public_key)",
        [],
    )?;
    connection.execute(
        "CREATE INDEX IF NOT EXISTS idx_signer_audit_recent
         ON signer_audit (recorded_at_unix DESC, id DESC)",
        [],
    )?;
    connection.execute(
        "CREATE INDEX IF NOT EXISTS idx_signer_value_events_key_recent
         ON signer_value_events (key_id, recorded_at_unix DESC, id DESC)",
        [],
    )?;
    Ok(())
}
