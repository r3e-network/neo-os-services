//! What the custody tables actually hold, and what happens to a database that
//! predates a column.
//!
//! These are store tests rather than service tests because the failure modes
//! here have no service-level equivalent: a `capabilities` list that comes back
//! different from the one written is not a policy decision the engine could
//! catch, it is the vault silently handing a relayer console authority. The
//! migration matters for the same reason in reverse — an operator upgrading a
//! deployment must not find the signer refusing to start, and must not find
//! every existing credential promoted either.

use super::*;

/// A caller row built the way the store writes one, with the fields this module
/// does not exercise pinned to something inert.
fn caller(id: &str, capabilities: &[CallerCapability], grant: KeyGrant) -> SignerCaller {
    SignerCaller {
        id: id.to_string(),
        label: id.to_string(),
        token_digest: [id.len() as u8; 32],
        workload_identity: None,
        key_grant: grant,
        capabilities: capabilities.to_vec(),
        allowed_origins: vec![],
        created_at_unix: 1_700_000_000,
        disabled: false,
    }
}

#[test]
fn capabilities_and_grants_survive_a_round_trip() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let store = Store::open(dir.path().join("signer.db"))?;
    store.create_signer_caller(&caller(
        "both",
        &[CallerCapability::Sign, CallerCapability::Admin],
        KeyGrant::Any,
    ))?;
    store.create_signer_caller(&caller(
        "scoped",
        &[CallerCapability::Admin],
        KeyGrant::Only(vec!["key-1".to_string(), "key-2".to_string()]),
    ))?;

    let rows = store.list_signer_callers()?;
    let both = rows
        .iter()
        .find(|row| row.id == "both")
        .unwrap_or_else(|| unreachable!("both rows were written"));
    let scoped = rows
        .iter()
        .find(|row| row.id == "scoped")
        .unwrap_or_else(|| unreachable!("both rows were written"));
    assert_eq!(
        both.capabilities,
        vec![CallerCapability::Sign, CallerCapability::Admin]
    );
    assert!(both.key_grant.grants("any key at all"));
    // Order is part of the round trip: the list is what the page renders, and a
    // capability stored reversed reads back as a different grant than the one
    // the operator approved.
    assert_eq!(
        scoped.capabilities,
        vec![CallerCapability::Admin],
        "an admin-only caller stays admin-only"
    );
    assert!(scoped.key_grant.grants("key-1"));
    assert!(!scoped.key_grant.grants("key-3"));
    Ok(())
}

#[test]
fn a_caller_stored_with_no_capabilities_has_none_not_the_column_default() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let store = Store::open(dir.path().join("signer.db"))?;
    store.create_signer_caller(&caller("parked", &[], KeyGrant::Any))?;

    // `capabilities TEXT NOT NULL DEFAULT 'sign'` could have been read as "the
    // column always says sign". It says that about rows the migration touched; a
    // row written with an empty list must stay able to do nothing.
    assert!(store
        .list_signer_callers()?
        .into_iter()
        .next()
        .unwrap_or_else(|| unreachable!("one row was written"))
        .capabilities
        .is_empty());
    Ok(())
}

#[test]
fn an_unknown_capability_breaks_the_read_instead_of_passing_quietly() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let store = Store::open(dir.path().join("signer.db"))?;
    store.create_signer_caller(&caller("relay", &[CallerCapability::Sign], KeyGrant::Any))?;
    let raw = Connection::open(store.db_path())?;
    raw.execute(
        "UPDATE signer_callers SET capabilities = ?1 WHERE id = ?2",
        params!["sign|everything", "relay"],
    )?;

    // Skipping the unknown label would leave this test passing and the vault
    // half-open: the row would load as a signer, and whoever wrote
    // `everything` would believe they had granted something.
    let error = store
        .list_signer_callers()
        .err()
        .unwrap_or_else(|| unreachable!("an unknown capability cannot load"));
    // `{:?}` and not `to_string()`: the store wraps every read failure in the
    // same context, so only the cause chain says whether this row was rejected
    // for its capability or for something else entirely.
    let chain = format!("{error:?}");
    assert!(chain.contains("everything"), "{chain}");
    Ok(())
}

#[test]
fn a_database_predating_capabilities_opens_and_keeps_its_callers_as_sign_only() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let path = dir.path().join("signer.db");
    // The table as it was before the management API: same columns, no
    // `capabilities`, and a relayer's credential already in it.
    let old = Connection::open(&path)?;
    old.execute_batch(
        "CREATE TABLE signer_callers (
            id TEXT PRIMARY KEY,
            label TEXT NOT NULL,
            token_digest BLOB NOT NULL,
            key_grant_mode TEXT NOT NULL DEFAULT 'only',
            key_grants TEXT NOT NULL DEFAULT '',
            allowed_origins TEXT NOT NULL DEFAULT '',
            created_at_unix INTEGER NOT NULL,
            disabled INTEGER NOT NULL DEFAULT 0
         );
         INSERT INTO signer_callers (id, label, token_digest, created_at_unix)
         VALUES ('legacy', 'relayer', randomblob(32), 1700000000);",
    )?;
    drop(old);

    let store = Store::open(&path)?;
    let legacy = store.get_signer_caller("legacy")?;
    assert_eq!(
        legacy.capabilities,
        vec![CallerCapability::Sign],
        "the lesser capability: a token issued before an admin surface existed \
         was never issued to reach one"
    );
    // The widening has to be visible to a plain read of the schema, not only to
    // this crate — an operator inspecting the file should see the column.
    let raw = Connection::open(&path)?;
    let stored: String = raw.query_row(
        "SELECT capabilities FROM signer_callers WHERE id = 'legacy'",
        [],
        |row| row.get(0),
    )?;
    assert_eq!(stored, "sign");
    Ok(())
}

#[test]
fn reopening_a_migrated_database_changes_nothing() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let path = dir.path().join("signer.db");
    let first = Store::open(&path)?;
    first.create_signer_caller(&caller(
        "console",
        &[CallerCapability::Admin],
        KeyGrant::Only(vec!["key-1".to_string()]),
    ))?;

    // A second `initialize()` runs on every start, and the guard around the
    // `ALTER TABLE` is what stops it rebuilding the table from its defaults.
    // Without that guard this row would come back holding `sign`.
    let second = Store::open(&path)?;
    assert_eq!(
        second.get_signer_caller("console")?.capabilities,
        vec![CallerCapability::Admin]
    );
    Ok(())
}

#[test]
fn a_database_predating_network_magic_opens_with_the_magic_each_key_signed_under() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let path = dir.path().join("signer.db");
    // The key table as it was before the magic was bound to the row, holding a
    // testnet key. What that key signed under was derived from `network` at
    // signing time, so the backfill has to reproduce exactly that value — a
    // default that did not would quietly invalidate every signature the key
    // ever produced.
    let old = Connection::open(&path)?;
    old.execute_batch(
        "CREATE TABLE signer_keys (
            id TEXT PRIMARY KEY,
            label TEXT NOT NULL,
            network TEXT NOT NULL,
            public_key BLOB NOT NULL,
            nonce BLOB NOT NULL,
            ciphertext BLOB NOT NULL,
            created_at_unix INTEGER NOT NULL,
            disabled INTEGER NOT NULL DEFAULT 0
         );
         INSERT INTO signer_keys (id, label, network, public_key, nonce, ciphertext, created_at_unix)
         VALUES ('key-old', 'treasury', 'testnet', randomblob(33), randomblob(12), randomblob(96),
                 1700000000);",
    )?;
    drop(old);

    let store = Store::open(&path)?;
    assert_eq!(store.get_signer_key("key-old")?.network_magic, 894_710_606);
    // Visible to a plain read of the schema, not only to this crate — an
    // operator inspecting the file should see the column.
    let raw = Connection::open(&path)?;
    let stored: i64 = raw.query_row(
        "SELECT network_magic FROM signer_keys WHERE id = 'key-old'",
        [],
        |row| row.get(0),
    )?;
    assert_eq!(stored, 894_710_606);
    Ok(())
}

#[test]
fn legacy_consensus_slots_migrate_to_immutable_fail_closed_keys() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let path = dir.path().join("signer.db");
    let old = Connection::open(&path)?;
    old.execute_batch(
        "CREATE TABLE signer_keys (
             id TEXT PRIMARY KEY, label TEXT NOT NULL, network TEXT NOT NULL,
             public_key BLOB NOT NULL, nonce BLOB NOT NULL, ciphertext BLOB NOT NULL,
             created_at_unix INTEGER NOT NULL, disabled INTEGER NOT NULL DEFAULT 0,
             network_magic INTEGER NOT NULL
         );
         CREATE TABLE signer_consensus_reservations (
             key_id TEXT NOT NULL, network_magic INTEGER NOT NULL,
             block_index INTEGER NOT NULL, message_type INTEGER NOT NULL,
             validator_index INTEGER NOT NULL, view_number INTEGER NOT NULL,
             payload_digest BLOB NOT NULL, recorded_at_unix INTEGER NOT NULL,
             audit_id INTEGER,
             PRIMARY KEY (
                 key_id, network_magic, block_index, message_type,
                 validator_index, view_number
             )
         );",
    )?;
    old.execute(
        "INSERT INTO signer_keys
         (id, label, network, public_key, nonce, ciphertext, created_at_unix, network_magic)
         VALUES ('known', 'known', 'testnet', ?1, zeroblob(12), zeroblob(48), 1, 894710606)",
        params![vec![0x02u8; 33]],
    )?;
    old.execute(
        "INSERT INTO signer_consensus_reservations
         VALUES ('known', 894710606, 500, 48, 2, 9, ?1, 1, NULL)",
        params![vec![0x11u8; 32]],
    )?;
    old.execute(
        "INSERT INTO signer_consensus_reservations
         VALUES ('deleted', 894710606, 600, 33, 3, 4, ?1, 1, NULL)",
        params![vec![0x22u8; 32]],
    )?;
    drop(old);

    let store = Store::open(&path)?;
    let known = SignerConsensusReservation {
        public_key: [0x02; 33],
        network_magic: 894_710_606,
        block_index: 500,
        phase: 48,
        validator_index: 2,
        view_number: 0,
        checkpoint: [0x11; 32],
        recorded_at_unix: 1,
        audit_id: None,
    };
    assert_eq!(
        store
            .find_signer_consensus_reservation(&known)?
            .expect("known slot")
            .public_key,
        known.public_key
    );

    let deleted = SignerConsensusReservation {
        public_key: [0x03; 33],
        network_magic: 894_710_606,
        block_index: 600,
        phase: 32,
        validator_index: 3,
        view_number: 4,
        checkpoint: [0x22; 32],
        recorded_at_unix: 1,
        audit_id: None,
    };
    assert_eq!(
        store
            .find_signer_consensus_reservation(&deleted)?
            .expect("deleted-key tombstone")
            .public_key,
        [0u8; 33],
        "a deleted mutable key id becomes an all-keys tombstone for its slot"
    );
    Ok(())
}
