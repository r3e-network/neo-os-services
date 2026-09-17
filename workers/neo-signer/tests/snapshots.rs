use anyhow::Result;
use neo_signer::{
    auth::CallerCredentials,
    model::{
        CallerCapability, KeyGrant, ScriptHash, SignerConsensusReservation, SignerPolicy,
        SignerValueEvent,
    },
    network::{self, Network},
    service::{provision_admin_caller, Outcome, SignerService},
    snapshot::{
        SnapshotCipher, SnapshotPosition, MAX_SNAPSHOT_BYTES, MAX_SNAPSHOT_PLAINTEXT_BYTES,
    },
    store::Store,
    vault::MasterKey,
};
use rusqlite::{types::Value, Connection, MAIN_DB};
use sha2::{Digest, Sha256};

fn position() -> SnapshotPosition {
    SnapshotPosition {
        generation: 1,
        fence: 1,
        previous_digest: [0; 32],
    }
}

fn allowed<T>(outcome: Outcome<T>) -> T {
    match outcome {
        Outcome::Allowed(value) => value,
        Outcome::Refused(_) => panic!("valid fixture request was refused"),
    }
}

#[test]
fn snapshot_encryption_is_randomized_and_bound_to_the_whole_head() -> Result<()> {
    let cipher = SnapshotCipher::new(&MasterKey::from_bytes([3; 32]), Network::Testnet)?;
    let secret = b"all policies, callers, limits, requests and private-key envelopes";
    let (encrypted, head) = cipher.seal(secret, position())?;
    let (second, second_head) = cipher.seal(secret, position())?;
    assert_ne!(encrypted, second);
    assert!(!encrypted
        .windows(secret.len())
        .any(|window| window == secret));
    assert_eq!(cipher.open(&encrypted, &head)?.as_slice(), secret);
    assert!(
        cipher.open(&second, &head).is_err(),
        "another fork at the same generation is not the head"
    );
    assert!(cipher.open(&encrypted, &second_head).is_err());
    let mut wrong = head.clone();
    wrong.position.fence += 1;
    assert!(cipher.open(&encrypted, &wrong).is_err());
    wrong = head.clone();
    wrong.position = SnapshotPosition {
        generation: 2,
        fence: 1,
        previous_digest: head.digest,
    };
    assert!(cipher.open(&encrypted, &wrong).is_err());
    let (latest, latest_head) = cipher.seal(b"updated state", wrong.position)?;
    assert!(
        cipher.open(&encrypted, &latest_head).is_err(),
        "a valid older AEAD envelope must fail the latest head"
    );
    assert_eq!(
        cipher.open(&latest, &latest_head)?.as_slice(),
        b"updated state"
    );
    Ok(())
}

#[test]
fn snapshots_cannot_cross_vaults_or_networks() -> Result<()> {
    let master = MasterKey::from_bytes([3; 32]);
    let testnet = SnapshotCipher::new(&master, Network::Testnet)?;
    let mainnet = SnapshotCipher::new(&master, Network::Mainnet)?;
    let other = SnapshotCipher::new(&MasterKey::from_bytes([4; 32]), Network::Testnet)?;
    let (encrypted, head) = testnet.seal(b"testnet state", position())?;
    assert!(mainnet.open(&encrypted, &head).is_err());
    assert!(other.open(&encrypted, &head).is_err());
    assert_ne!(testnet.binding().vault_id, mainnet.binding().vault_id);
    assert_ne!(testnet.binding().vault_id, other.binding().vault_id);
    assert!(SnapshotCipher::new(&master, Network::Private).is_err());
    Ok(())
}

#[test]
fn tampering_is_rejected_even_if_an_attacker_recomputes_the_outer_digest() -> Result<()> {
    let cipher = SnapshotCipher::new(&MasterKey::from_bytes([3; 32]), Network::Testnet)?;
    let (encrypted, head) = cipher.seal(b"snapshot plaintext", position())?;
    for index in 0..encrypted.len() {
        let mut tampered = encrypted.clone();
        tampered[index] ^= 1;
        let mut forged = head.clone();
        forged.digest = Sha256::digest(&tampered).into();
        assert!(
            cipher.open(&tampered, &forged).is_err(),
            "tampering byte {index} was accepted"
        );
    }
    for length in 0..encrypted.len() {
        assert!(cipher.open(&encrypted[..length], &head).is_err());
    }
    assert!(cipher.seal(b"", position()).is_err());
    for invalid in [
        SnapshotPosition {
            generation: 0,
            ..position()
        },
        SnapshotPosition {
            fence: 0,
            ..position()
        },
        SnapshotPosition {
            generation: 2,
            ..position()
        },
        SnapshotPosition {
            previous_digest: [1; 32],
            ..position()
        },
    ] {
        assert!(cipher.seal(b"data", invalid).is_err());
    }
    Ok(())
}

#[test]
fn snapshot_size_limit_is_enforced_before_encryption_or_sqlite_backup() -> Result<()> {
    let cipher = SnapshotCipher::new(&MasterKey::from_bytes([3; 32]), Network::Testnet)?;
    let plaintext = vec![0x55; MAX_SNAPSHOT_PLAINTEXT_BYTES + 1];
    assert!(cipher.seal(&plaintext, position()).is_err());
    let (encrypted, head) = cipher.seal(&plaintext[..MAX_SNAPSHOT_PLAINTEXT_BYTES], position())?;
    assert_eq!(encrypted.len(), MAX_SNAPSHOT_BYTES);
    assert_eq!(
        cipher.open(&encrypted, &head)?.as_slice(),
        &plaintext[..MAX_SNAPSHOT_PLAINTEXT_BYTES]
    );
    let mut oversized = encrypted;
    oversized.push(0);
    assert!(cipher.open(&oversized, &head).is_err());
    drop(oversized);
    drop(plaintext);

    let dir = tempfile::tempdir()?;
    let store = Store::open(dir.path().join("large.db"))?;
    let connection = Connection::open(store.db_path())?;
    connection.execute_batch("CREATE TABLE large_snapshot_fixture (payload BLOB)")?;
    connection.execute(
        "INSERT INTO large_snapshot_fixture VALUES (zeroblob(?1))",
        [MAX_SNAPSHOT_BYTES as i64],
    )?;
    let error = store
        .sealed_snapshot(&cipher, position())
        .expect_err("oversized database must be refused");
    assert!(error.to_string().contains("exceeds the snapshot limit"));
    Ok(())
}

#[test]
fn a_locked_database_produces_no_snapshot_and_can_be_retried_after_rollback() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let store = Store::open(dir.path().join("locked.db"))?;
    let connection = Connection::open(store.db_path())?;
    let cipher = SnapshotCipher::new(&MasterKey::from_bytes([3; 32]), Network::Testnet)?;
    connection.execute_batch("BEGIN EXCLUSIVE;")?;
    assert!(store.sealed_snapshot(&cipher, position()).is_err());
    connection.execute_batch("ROLLBACK;")?;
    let (encrypted, head) = store.sealed_snapshot(&cipher, position())?;
    assert!(cipher
        .open(&encrypted, &head)?
        .starts_with(b"SQLite format 3\0"));
    Ok(())
}

fn rows(connection: &Connection, table: &str) -> Result<Vec<Vec<Value>>> {
    let mut statement = connection.prepare(&format!("SELECT * FROM {table} ORDER BY rowid"))?;
    let count = statement.column_count();
    let rows = statement
        .query_map([], |row| (0..count).map(|index| row.get(index)).collect())?
        .collect::<rusqlite::Result<Vec<Vec<Value>>>>()?;
    Ok(rows)
}

#[test]
fn a_real_sqlite_backup_preserves_every_custody_table_and_committed_wal_rows() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let path = dir.path().join("custody.db");
    let store = Store::open(&path)?;
    let keeper = Connection::open(&path)?;
    keeper.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;")?;
    assert_eq!(
        keeper.query_row("PRAGMA journal_mode", [], |row| row.get::<_, String>(0))?,
        "wal"
    );
    let service = SignerService::new(store.clone(), MasterKey::from_bytes([9; 32]));
    let (_, token) = provision_admin_caller(&store, "bootstrap")?;
    let admin = CallerCredentials::server_to_server(&token);
    let key = allowed(service.generate_key(&admin, "key", Network::Testnet, None)?);
    allowed(service.save_policy(
        &admin,
        &key.key_id,
        &SignerPolicy {
            allow_raw: true,
            ..Default::default()
        },
    )?);
    let (caller, token) = allowed(service.create_caller(
        &admin,
        "snapshot caller",
        KeyGrant::Only(vec![key.key_id.clone()]),
        &[CallerCapability::RawSign],
        &[],
    )?);
    allowed(service.sign_raw_with_request_id(
        &CallerCredentials::server_to_server(&token),
        &key.key_id,
        b"snapshot test",
        Some("snapshot-request"),
    )?);
    store.record_signer_value_events(&[SignerValueEvent {
        id: 0,
        key_id: key.key_id.clone(),
        recorded_at_unix: 1,
        asset: ScriptHash::from_wire([1; 20]),
        amount: i128::MAX,
        audit_id: None,
    }])?;
    store.reserve_signer_consensus(&SignerConsensusReservation {
        public_key: store.get_signer_key(&key.key_id)?.public_key,
        network_magic: network::network_magic(Network::Testnet),
        block_index: 77,
        phase: 0x30,
        validator_index: 0,
        view_number: 0,
        checkpoint: [7; 32],
        recorded_at_unix: 1,
        audit_id: None,
    })?;
    assert!(store.reserve_workload_nonce(&caller.id, "nonce", 100, 1)?);
    keeper.execute(
        "INSERT INTO signer_workload_nonces (caller_id, nonce, expires_at_unix) VALUES (?1, 'wal-resident', 100)",
        [&caller.id],
    )?;
    assert!(std::fs::metadata(dir.path().join("custody.db-wal"))?.len() > 0);
    let tables = [
        "signer_keys",
        "signer_policies",
        "signer_callers",
        "signer_audit",
        "signer_requests",
        "signer_value_events",
        "signer_consensus_reservations",
        "signer_workload_nonces",
        "sqlite_sequence",
    ];
    let expected = tables
        .iter()
        .map(|table| rows(&keeper, table))
        .collect::<Result<Vec<_>>>()?;
    assert!(
        expected.iter().all(|rows| !rows.is_empty()),
        "every state table must be exercised"
    );
    // Uncommitted policy changes may coexist with a snapshot, but must not enter it.
    keeper.execute_batch("BEGIN IMMEDIATE; UPDATE signer_callers SET disabled=1;")?;
    let cipher = SnapshotCipher::new(&MasterKey::from_bytes([9; 32]), Network::Testnet)?;
    let (encrypted, head) = store.sealed_snapshot(&cipher, position())?;
    keeper.execute_batch("ROLLBACK;")?;
    let plaintext = cipher.open(&encrypted, &head)?;
    assert_eq!(&plaintext[..16], b"SQLite format 3\0");
    assert_eq!(
        &plaintext[18..20],
        &[1, 1],
        "standalone image must not require a WAL file"
    );
    keeper.execute("UPDATE signer_callers SET disabled = 1", [])?;
    let restored = Store::restore_snapshot(&cipher, &encrypted, &head)?;
    assert_eq!(
        restored.query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0))?,
        "ok"
    );
    for (table, expected) in tables.iter().zip(expected) {
        assert_eq!(
            rows(&restored, table)?,
            expected,
            "{table} did not survive the snapshot"
        );
    }
    assert!(restored.execute("DELETE FROM signer_callers", []).is_err());
    restored.execute_batch("PRAGMA query_only = OFF")?;
    assert!(
        restored.execute("DELETE FROM signer_callers", []).is_err(),
        "the SQLite image itself must remain read-only"
    );
    assert_eq!(
        keeper.query_row(
            "SELECT COUNT(*) FROM signer_callers WHERE disabled = 1",
            [],
            |row| row.get::<_, usize>(0)
        )?,
        2,
        "restoring a snapshot must not overwrite newer state in the active Store"
    );
    assert_eq!(
        restored.query_row(
            "SELECT file FROM pragma_database_list WHERE name = 'main'",
            [],
            |row| row.get::<_, String>(0)
        )?,
        "",
        "restored plaintext must stay in memory"
    );
    Ok(())
}

#[test]
fn authenticated_snapshot_install_is_exact_atomic_and_never_overwrites_local_state() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let source = Store::open(dir.path().join("source.db"))?;
    let (_admin, _token) = provision_admin_caller(&source, "restored-admin")?;
    let cipher = SnapshotCipher::new(&MasterKey::from_bytes([9; 32]), Network::Testnet)?;
    let (envelope, head) = source.sealed_snapshot(&cipher, position())?;

    let target = dir.path().join("restored/signer.db");
    let installed = Store::install_snapshot(&target, &cipher, &envelope, &head)?;
    assert_eq!(installed.list_signer_callers()?.len(), 1);
    assert_eq!(installed.list_signer_callers()?[0].label, "restored-admin");
    assert!(target.exists());
    for suffix in ["-wal", "-shm", "-journal"] {
        assert!(!dir
            .path()
            .join(format!("restored/signer.db{suffix}"))
            .exists());
    }

    let before = std::fs::read(&target)?;
    let error = Store::install_snapshot(&target, &cipher, &envelope, &head)
        .expect_err("an existing local database must never be replaced");
    assert!(error.to_string().contains("already exists"));
    assert_eq!(std::fs::read(&target)?, before);

    let mut tampered = envelope.clone();
    *tampered.last_mut().expect("encrypted snapshot") ^= 1;
    let rejected = dir.path().join("rejected/signer.db");
    assert!(Store::install_snapshot(&rejected, &cipher, &tampered, &head).is_err());
    assert!(!rejected.exists());

    let sidecar_target = dir.path().join("sidecar/signer.db");
    std::fs::create_dir_all(sidecar_target.parent().expect("parent"))?;
    std::fs::write(dir.path().join("sidecar/signer.db-wal"), b"stale")?;
    assert!(Store::install_snapshot(&sidecar_target, &cipher, &envelope, &head).is_err());
    assert!(!sidecar_target.exists());
    Ok(())
}

#[test]
fn restore_rejects_authenticated_non_sqlite_truncated_and_corrupt_images() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let store = Store::open(dir.path().join("custody.db"))?;
    let cipher = SnapshotCipher::new(&MasterKey::from_bytes([9; 32]), Network::Testnet)?;
    let (encrypted, head) = store.sealed_snapshot(&cipher, position())?;
    let image = cipher.open(&encrypted, &head)?;
    let mut bad_page = image.to_vec();
    bad_page[100] = 0xff;
    let connection = Connection::open(store.db_path())?;
    let root_page: usize = connection.query_row(
        "SELECT rootpage FROM sqlite_schema WHERE name = 'signer_callers'",
        [],
        |row| row.get(0),
    )?;
    let page_size: usize = connection.query_row("PRAGMA page_size", [], |row| row.get(0))?;
    let mut bad_data_page = image.to_vec();
    bad_data_page[(root_page - 1) * page_size] = 0xff;
    let mut wal = image.to_vec();
    wal[18] = 2;
    wal[19] = 2;
    let mut trailing = image.to_vec();
    trailing.push(0);
    for (case, invalid) in [
        ("not-sqlite", b"not a database".to_vec()),
        ("zero-filled", vec![0; 4096]),
        ("truncated-header", image[..99].to_vec()),
        ("truncated-page", image[..image.len() - 1].to_vec()),
        ("corrupt-btree-page", bad_page),
        ("corrupt-data-page", bad_data_page),
        ("wal-dependent", wal),
        ("trailing-data", trailing),
    ] {
        let (envelope, exact_head) = cipher.seal(&invalid, position())?;
        assert!(
            Store::restore_snapshot(&cipher, &envelope, &exact_head).is_err(),
            "{case} must be rejected even after successful AEAD authentication"
        );
    }
    Ok(())
}

#[test]
fn restore_rejects_missing_unknown_or_changed_schema_without_migrating() -> Result<()> {
    let cipher = SnapshotCipher::new(&MasterKey::from_bytes([9; 32]), Network::Testnet)?;
    for change in [
        "DROP TABLE signer_requests",
        "CREATE TABLE unexpected (id INTEGER)",
        "CREATE VIEW unexpected AS SELECT * FROM signer_keys",
        "CREATE TRIGGER unexpected AFTER DELETE ON signer_keys BEGIN DELETE FROM signer_audit; END",
        "ALTER TABLE signer_callers ADD COLUMN unexpected INTEGER",
        "ALTER TABLE signer_callers DROP COLUMN workload_subject",
        "DROP INDEX idx_signer_keys_public_key",
        "DROP INDEX idx_signer_keys_public_key; CREATE INDEX idx_signer_keys_public_key ON signer_keys(public_key)",
        "PRAGMA user_version = 1",
        "PRAGMA application_id = 1",
    ] {
        let dir = tempfile::tempdir()?;
        let store = Store::open(dir.path().join("custody.db"))?;
        let connection = Connection::open(store.db_path())?;
        connection.execute_batch("PRAGMA foreign_keys = OFF")?;
        connection.execute_batch(change)?;
        let (encrypted, head) = store.sealed_snapshot(&cipher, position())?;
        assert!(
            Store::restore_snapshot(&cipher, &encrypted, &head).is_err(),
            "unsupported schema must not be repaired or accepted: {change}"
        );
    }
    let blank = Connection::open_in_memory()?;
    blank.execute_batch("PRAGMA user_version = 0; VACUUM")?;
    let image = blank.serialize(MAIN_DB)?;
    let (encrypted, head) = cipher.seal(&image, position())?;
    assert!(Store::restore_snapshot(&cipher, &encrypted, &head).is_err());
    Ok(())
}

#[test]
fn restore_rejects_broken_foreign_keys_and_mismatched_custody_networks() -> Result<()> {
    let cipher = SnapshotCipher::new(&MasterKey::from_bytes([9; 32]), Network::Testnet)?;
    for change in [
        "INSERT INTO signer_policies (key_id, updated_at_unix) VALUES ('missing-key', 1)",
        "UPDATE signer_keys SET network = 'mainnet'",
        "UPDATE signer_keys SET network_magic = 1",
        "UPDATE signer_keys SET chain_id = 1",
        "UPDATE signer_keys SET chain_family = 'unsupported'",
        "UPDATE signer_keys SET id = NULL",
        "UPDATE signer_keys SET public_key = zeroblob(32)",
        "UPDATE signer_keys SET nonce = zeroblob(11)",
        "UPDATE signer_keys SET created_at_unix = 'not-a-timestamp'",
    ] {
        let dir = tempfile::tempdir()?;
        let store = Store::open(dir.path().join("custody.db"))?;
        let service = SignerService::new(store.clone(), MasterKey::from_bytes([9; 32]));
        let (_, token) = provision_admin_caller(&store, "bootstrap")?;
        allowed(service.generate_key(
            &CallerCredentials::server_to_server(&token),
            "key",
            Network::Testnet,
            None,
        )?);
        let connection = Connection::open(store.db_path())?;
        connection.execute_batch("PRAGMA foreign_keys = OFF")?;
        connection.execute_batch(change)?;
        let (encrypted, head) = store.sealed_snapshot(&cipher, position())?;
        assert!(
            Store::restore_snapshot(&cipher, &encrypted, &head).is_err(),
            "invalid custody state must be refused: {change}"
        );
    }
    Ok(())
}

#[test]
fn restore_accepts_both_supported_chains_and_checks_retained_consensus_networks() -> Result<()> {
    for network in [Network::Mainnet, Network::Testnet] {
        let dir = tempfile::tempdir()?;
        let store = Store::open(dir.path().join("custody.db"))?;
        let service = SignerService::new(store.clone(), MasterKey::from_bytes([9; 32]));
        let (_, token) = provision_admin_caller(&store, "bootstrap")?;
        for family in [network::ChainFamily::NeoN3, network::ChainFamily::NeoX] {
            allowed(service.generate_key_for_chain(
                &CallerCredentials::server_to_server(&token),
                "key",
                network,
                family,
                None,
            )?);
        }
        let cipher = SnapshotCipher::new(&MasterKey::from_bytes([9; 32]), network)?;
        let (encrypted, head) = store.sealed_snapshot(&cipher, position())?;
        let restored = Store::restore_snapshot(&cipher, &encrypted, &head)?;
        assert_eq!(
            restored.query_row("SELECT COUNT(*) FROM signer_keys", [], |row| row
                .get::<_, usize>(0))?,
            2
        );
        store.reserve_signer_consensus(&SignerConsensusReservation {
            public_key: [0; 33],
            network_magic: 1,
            block_index: 77,
            phase: 0x30,
            validator_index: 0,
            view_number: 0,
            checkpoint: [7; 32],
            recorded_at_unix: 1,
            audit_id: None,
        })?;
        let (encrypted, head) = store.sealed_snapshot(&cipher, position())?;
        assert!(Store::restore_snapshot(&cipher, &encrypted, &head).is_err());
    }
    Ok(())
}

#[test]
fn restore_requires_a_matching_authenticated_envelope_before_sqlite() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let store = Store::open(dir.path().join("custody.db"))?;
    let master = MasterKey::from_bytes([9; 32]);
    let cipher = SnapshotCipher::new(&master, Network::Testnet)?;
    let (encrypted, head) = store.sealed_snapshot(&cipher, position())?;
    let wrong_cipher = SnapshotCipher::new(&MasterKey::from_bytes([8; 32]), Network::Testnet)?;
    let mainnet = SnapshotCipher::new(&master, Network::Mainnet)?;
    assert!(Store::restore_snapshot(&wrong_cipher, &encrypted, &head).is_err());
    assert!(Store::restore_snapshot(&mainnet, &encrypted, &head).is_err());
    let mut wrong_head = head.clone();
    wrong_head.position.fence += 1;
    assert!(Store::restore_snapshot(&cipher, &encrypted, &wrong_head).is_err());
    let mut corrupted = encrypted.clone();
    *corrupted.last_mut().expect("ciphertext is nonempty") ^= 1;
    assert!(Store::restore_snapshot(&cipher, &corrupted, &head).is_err());
    wrong_head = head;
    wrong_head.digest = Sha256::digest(&corrupted).into();
    assert!(Store::restore_snapshot(&cipher, &corrupted, &wrong_head).is_err());
    Ok(())
}
