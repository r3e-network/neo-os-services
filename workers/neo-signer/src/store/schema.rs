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
            disabled INTEGER NOT NULL DEFAULT 0,
            network_magic INTEGER NOT NULL,
            chain_family TEXT NOT NULL DEFAULT 'neo-n3',
            chain_id INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS signer_policies (
            key_id TEXT PRIMARY KEY,
            allow_consensus INTEGER NOT NULL DEFAULT 0,
            allow_raw INTEGER NOT NULL DEFAULT 0,
            allow_transfer INTEGER NOT NULL DEFAULT 0,
            allow_contract_call INTEGER NOT NULL DEFAULT 0,
            allow_global_scope INTEGER NOT NULL DEFAULT 0,
            contract_whitelist TEXT NOT NULL DEFAULT '',
            contract_blacklist TEXT NOT NULL DEFAULT '',
            contract_method_whitelist TEXT NOT NULL DEFAULT '[]',
            contract_method_blacklist TEXT NOT NULL DEFAULT '[]',
            asset_whitelist TEXT NOT NULL DEFAULT '',
            asset_blacklist TEXT NOT NULL DEFAULT '',
            transfer_to_whitelist TEXT NOT NULL DEFAULT '',
            transfer_to_blacklist TEXT NOT NULL DEFAULT '',
            max_single_amount TEXT,
            window_seconds INTEGER,
            window_max_amount TEXT,
            max_signers INTEGER,
            max_system_fee INTEGER,
            max_network_fee INTEGER,
            signature_window_seconds INTEGER,
            signature_window_count INTEGER,
            asset_limits TEXT NOT NULL DEFAULT '[]',
            chain_family TEXT,
            evm_max_gas_price TEXT,
            evm_max_gas_limit INTEGER,
            evm_method_whitelist TEXT NOT NULL DEFAULT '',
            evm_method_blacklist TEXT NOT NULL DEFAULT '',
            evm_chain_id INTEGER,
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
            capabilities TEXT NOT NULL DEFAULT 'sign',
            workload_public_key BLOB,
            workload_subject TEXT
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
        );
        -- No foreign key to signer_keys: retiring a key must not erase the
        -- durable proof that it already occupied a consensus slot.
        CREATE TABLE IF NOT EXISTS signer_consensus_reservations (
            public_key BLOB NOT NULL,
            network_magic INTEGER NOT NULL,
            block_index INTEGER NOT NULL,
            phase INTEGER NOT NULL,
            validator_index INTEGER NOT NULL,
            view_number INTEGER NOT NULL,
            checkpoint BLOB NOT NULL,
            recorded_at_unix INTEGER NOT NULL,
            audit_id INTEGER,
            PRIMARY KEY (
                public_key, network_magic, block_index, phase,
                view_number
            )
        );
        -- Completed request results outlive key and caller deletion: an
        -- idempotency id must never become reusable for a different operation.
        CREATE TABLE IF NOT EXISTS signer_requests (
            caller_id TEXT NOT NULL,
            request_id TEXT NOT NULL,
            key_id TEXT NOT NULL,
            action TEXT NOT NULL,
            request_digest BLOB NOT NULL,
            result_digest TEXT NOT NULL,
            script_hash BLOB NOT NULL,
            address TEXT NOT NULL,
            invocation BLOB NOT NULL,
            verification BLOB NOT NULL,
            completed_at_unix INTEGER NOT NULL,
            audit_id INTEGER,
            chain_family TEXT,
            signed_transaction TEXT,
            PRIMARY KEY (caller_id, request_id)
        );
        CREATE TABLE IF NOT EXISTS signer_workload_nonces (
            caller_id TEXT NOT NULL,
            nonce TEXT NOT NULL,
            expires_at_unix INTEGER NOT NULL,
            PRIMARY KEY (caller_id, nonce)
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
    if !has_column(connection, "signer_callers", "workload_public_key")? {
        connection.execute(
            "ALTER TABLE signer_callers ADD COLUMN workload_public_key BLOB",
            [],
        )?;
    }
    if !has_column(connection, "signer_callers", "workload_subject")? {
        connection.execute(
            "ALTER TABLE signer_callers ADD COLUMN workload_subject TEXT",
            [],
        )?;
    }
    // `allow_raw` arrived with the raw-sign route. The stored default is `0` —
    // the closed switch — so a database this step migrates keeps refusing raw
    // signatures until an operator opens the boundary deliberately.
    if !has_column(connection, "signer_policies", "allow_raw")? {
        connection.execute(
            "ALTER TABLE signer_policies ADD COLUMN allow_raw INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
    }
    if !has_column(connection, "signer_policies", "contract_method_whitelist")? {
        connection.execute(
            "ALTER TABLE signer_policies
             ADD COLUMN contract_method_whitelist TEXT NOT NULL DEFAULT '[]'",
            [],
        )?;
    }
    if !has_column(connection, "signer_policies", "contract_method_blacklist")? {
        connection.execute(
            "ALTER TABLE signer_policies
             ADD COLUMN contract_method_blacklist TEXT NOT NULL DEFAULT '[]'",
            [],
        )?;
    }
    if !has_column(connection, "signer_policies", "max_signers")? {
        connection.execute(
            "ALTER TABLE signer_policies ADD COLUMN max_signers INTEGER",
            [],
        )?;
    }
    if !has_column(connection, "signer_policies", "max_system_fee")? {
        connection.execute(
            "ALTER TABLE signer_policies ADD COLUMN max_system_fee INTEGER",
            [],
        )?;
    }
    if !has_column(connection, "signer_policies", "max_network_fee")? {
        connection.execute(
            "ALTER TABLE signer_policies ADD COLUMN max_network_fee INTEGER",
            [],
        )?;
    }
    if !has_column(connection, "signer_policies", "signature_window_seconds")? {
        connection.execute(
            "ALTER TABLE signer_policies ADD COLUMN signature_window_seconds INTEGER",
            [],
        )?;
    }
    if !has_column(connection, "signer_policies", "signature_window_count")? {
        connection.execute(
            "ALTER TABLE signer_policies ADD COLUMN signature_window_count INTEGER",
            [],
        )?;
    }
    if !has_column(connection, "signer_policies", "asset_limits")? {
        connection.execute(
            "ALTER TABLE signer_policies
             ADD COLUMN asset_limits TEXT NOT NULL DEFAULT '[]'",
            [],
        )?;
    }
    if !has_column(connection, "signer_policies", "chain_family")? {
        connection.execute(
            "ALTER TABLE signer_policies ADD COLUMN chain_family TEXT",
            [],
        )?;
    }
    if !has_column(connection, "signer_policies", "evm_max_gas_price")? {
        connection.execute(
            "ALTER TABLE signer_policies ADD COLUMN evm_max_gas_price TEXT",
            [],
        )?;
    }
    if !has_column(connection, "signer_policies", "evm_max_gas_limit")? {
        connection.execute(
            "ALTER TABLE signer_policies ADD COLUMN evm_max_gas_limit INTEGER",
            [],
        )?;
    }
    if !has_column(connection, "signer_policies", "evm_method_whitelist")? {
        connection.execute(
            "ALTER TABLE signer_policies
             ADD COLUMN evm_method_whitelist TEXT NOT NULL DEFAULT ''",
            [],
        )?;
    }
    if !has_column(connection, "signer_policies", "evm_method_blacklist")? {
        connection.execute(
            "ALTER TABLE signer_policies
             ADD COLUMN evm_method_blacklist TEXT NOT NULL DEFAULT ''",
            [],
        )?;
    }
    if !has_column(connection, "signer_policies", "evm_chain_id")? {
        connection.execute(
            "ALTER TABLE signer_policies ADD COLUMN evm_chain_id INTEGER",
            [],
        )?;
    }
    // `network_magic` arrived with binding the chain identity to the row instead
    // of deriving it from `network` at signing time. The backfill is the
    // historical truth: every key held before this column existed signed under
    // the enum table — that is literally what `network_magic()` computed — so
    // the CASE reproduces exactly what each row's signatures committed to, and
    // a private-network key keeps the default it had. One transaction, so no
    // crash can leave rows at the `DEFAULT 0` the `ALTER` installs.
    if !has_column(connection, "signer_keys", "network_magic")? {
        connection.execute_batch(
            "BEGIN;
             ALTER TABLE signer_keys ADD COLUMN network_magic INTEGER NOT NULL DEFAULT 0;
             UPDATE signer_keys
             SET network_magic = CASE network
                 WHEN 'mainnet' THEN 860833102
                 WHEN 'testnet' THEN 894710606
                 ELSE 1230000
             END
             WHERE network_magic = 0;
             COMMIT;",
        )?;
    }
    // Curve/chain binding is immutable custody metadata, not a request hint.
    // Every historical key is P-256/N3, so the only truthful backfill is N3.
    if !has_column(connection, "signer_keys", "chain_family")? {
        connection.execute(
            "ALTER TABLE signer_keys
             ADD COLUMN chain_family TEXT NOT NULL DEFAULT 'neo-n3'",
            [],
        )?;
    }
    if !has_column(connection, "signer_keys", "chain_id")? {
        connection.execute_batch(
            "BEGIN;
             ALTER TABLE signer_keys ADD COLUMN chain_id INTEGER NOT NULL DEFAULT 0;
             UPDATE signer_keys SET chain_id = network_magic WHERE chain_id = 0;
             COMMIT;",
        )?;
    }
    // The first reservation schema keyed slots by mutable key id and raw
    // message type/view. Migrate it conservatively: PrepareRequest and
    // PrepareResponse collapse into one phase, Commit drops view, and deleted
    // keys become an all-keys tombstone for that slot rather than silently
    // reopening it.
    if !has_column(connection, "signer_consensus_reservations", "public_key")? {
        connection.execute_batch(
            "BEGIN IMMEDIATE;
             CREATE TABLE signer_consensus_reservations_v2 (
                 public_key BLOB NOT NULL,
                 network_magic INTEGER NOT NULL,
                 block_index INTEGER NOT NULL,
                 phase INTEGER NOT NULL,
                 validator_index INTEGER NOT NULL,
                 view_number INTEGER NOT NULL,
                 checkpoint BLOB NOT NULL,
                 recorded_at_unix INTEGER NOT NULL,
                 audit_id INTEGER,
                 PRIMARY KEY (
                     public_key, network_magic, block_index, phase,
                     view_number
                 )
             );
             INSERT OR IGNORE INTO signer_consensus_reservations_v2 (
                 public_key, network_magic, block_index, phase,
                 validator_index, view_number, checkpoint,
                 recorded_at_unix, audit_id
             )
             SELECT
                 COALESCE(k.public_key, zeroblob(33)),
                 r.network_magic,
                 r.block_index,
                 CASE WHEN r.message_type IN (32, 33) THEN 32 ELSE 48 END,
                 r.validator_index,
                 CASE WHEN r.message_type = 48 THEN 0 ELSE r.view_number END,
                 r.payload_digest,
                 r.recorded_at_unix,
                 r.audit_id
             FROM signer_consensus_reservations r
             LEFT JOIN signer_keys k ON k.id = r.key_id
             WHERE r.message_type IN (32, 33, 48);
             DROP TABLE signer_consensus_reservations;
             ALTER TABLE signer_consensus_reservations_v2
                 RENAME TO signer_consensus_reservations;
             COMMIT;",
        )?;
    }
    if !has_column(connection, "signer_requests", "chain_family")? {
        connection.execute(
            "ALTER TABLE signer_requests ADD COLUMN chain_family TEXT",
            [],
        )?;
    }
    if !has_column(connection, "signer_requests", "signed_transaction")? {
        connection.execute(
            "ALTER TABLE signer_requests ADD COLUMN signed_transaction TEXT",
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

/// The indexes the signer reads through.
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
        "CREATE INDEX IF NOT EXISTS idx_signer_audit_key_signatures
         ON signer_audit (key_id, outcome, action, recorded_at_unix DESC)",
        [],
    )?;
    connection.execute(
        "CREATE INDEX IF NOT EXISTS idx_signer_value_events_key_recent
         ON signer_value_events (key_id, recorded_at_unix DESC, id DESC)",
        [],
    )?;
    connection.execute(
        "CREATE INDEX IF NOT EXISTS idx_signer_consensus_key_height
         ON signer_consensus_reservations (public_key, network_magic, block_index DESC)",
        [],
    )?;
    connection.execute(
        "CREATE INDEX IF NOT EXISTS idx_signer_workload_nonces_expiry
         ON signer_workload_nonces (expires_at_unix)",
        [],
    )?;
    Ok(())
}
