use anyhow::Result;
use neo_signer::{
    auth::CallerCredentials,
    model::{CallerCapability, KeyGrant, SignerPolicy},
    network::Network,
    service::{provision_admin_caller, Outcome, SignerService, WorkloadCallerSpec},
    store::Store,
    vault::MasterKey,
};
use rusqlite::{types::Value, Connection};

fn allowed<T>(outcome: Outcome<T>) -> T {
    match outcome {
        Outcome::Allowed(value) => value,
        Outcome::Refused(_) => panic!("valid fixture request was refused"),
    }
}

type Rows = Vec<(String, Vec<Vec<Value>>)>;

fn rows(store: &Store) -> Result<Rows> {
    let connection = Connection::open(store.db_path())?;
    let tables = connection
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")?
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    tables
        .into_iter()
        .map(|name| {
            let mut statement = connection.prepare(&format!(
                "SELECT * FROM \"{}\" ORDER BY rowid",
                name.replace('"', "\"\"")
            ))?;
            let count = statement.column_count();
            let values = statement
                .query_map([], |row| (0..count).map(|index| row.get(index)).collect())?
                .collect::<rusqlite::Result<Vec<Vec<Value>>>>()?;
            Ok((name, values))
        })
        .collect()
}

fn refuse_audit(store: &Store) -> Result<()> {
    Connection::open(store.db_path())?.execute_batch(
        "CREATE TRIGGER reject_management_audit BEFORE INSERT ON signer_audit
         BEGIN SELECT RAISE(ABORT, 'injected audit failure'); END;",
    )?;
    Ok(())
}

#[test]
fn every_management_change_rolls_back_when_its_audit_insert_fails() -> Result<()> {
    for operation in [
        "generate",
        "import",
        "key-disable",
        "key-delete",
        "policy",
        "caller-create",
        "workload-create",
        "caller-rotate",
        "caller-disable",
        "caller-delete",
    ] {
        let dir = tempfile::tempdir()?;
        let store = Store::open(dir.path().join("custody.db"))?;
        let service = SignerService::new(store.clone(), MasterKey::from_bytes([9; 32]));
        let (_, token) = provision_admin_caller(&store, "bootstrap")?;
        let admin = CallerCredentials::server_to_server(&token);
        let key = allowed(service.generate_key(&admin, "key", Network::Testnet, None)?);
        allowed(service.save_policy(&admin, &key.key_id, &SignerPolicy::default())?);
        let (caller, _) = allowed(service.create_caller(
            &admin,
            "caller",
            KeyGrant::Any,
            &[CallerCapability::Sign],
            &[],
        )?);
        let before = rows(&store)?;
        refuse_audit(&store)?;
        let result = match operation {
            "generate" => service
                .generate_key(&admin, "new", Network::Testnet, None)
                .map(|_| ()),
            "import" => service
                .import_key(
                    &admin,
                    "import",
                    Network::Testnet,
                    None,
                    &hex::encode([7; 32]),
                )
                .map(|_| ()),
            "key-disable" => service
                .set_key_disabled(&admin, &key.key_id, true)
                .map(|_| ()),
            "key-delete" => service.delete_key(&admin, &key.key_id).map(|_| ()),
            "policy" => service
                .save_policy(
                    &admin,
                    &key.key_id,
                    &SignerPolicy {
                        allow_transfer: true,
                        ..Default::default()
                    },
                )
                .map(|_| ()),
            "caller-create" => service
                .create_caller(&admin, "new", KeyGrant::Any, &[CallerCapability::Sign], &[])
                .map(|_| ()),
            "workload-create" => service
                .create_workload_caller(
                    &admin,
                    WorkloadCallerSpec {
                        label: "workload",
                        public_key: ed25519_dalek::SigningKey::from_bytes(&[4; 32])
                            .verifying_key()
                            .to_bytes(),
                        subject: None,
                        key_grant: KeyGrant::Any,
                        capabilities: &[CallerCapability::Sign],
                        allowed_origins: &[],
                    },
                )
                .map(|_| ()),
            "caller-rotate" => service.rotate_caller_token(&admin, &caller.id).map(|_| ()),
            "caller-disable" => service
                .set_caller_disabled(&admin, &caller.id, true)
                .map(|_| ()),
            "caller-delete" => service.delete_caller(&admin, &caller.id).map(|_| ()),
            _ => unreachable!(),
        };
        assert!(
            result.is_err(),
            "{operation} must report the storage failure"
        );
        assert_eq!(rows(&store)?, before, "{operation} left unaudited state");
    }
    Ok(())
}

#[test]
fn bootstrap_rolls_back_if_the_audit_cannot_be_written() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let store = Store::open(dir.path().join("custody.db"))?;
    let before = rows(&store)?;
    refuse_audit(&store)?;
    assert!(provision_admin_caller(&store, "bootstrap").is_err());
    assert_eq!(
        rows(&store)?,
        before,
        "bootstrap installed an unaudited admin"
    );
    Ok(())
}

#[test]
fn concurrent_bootstrap_creates_exactly_one_audited_admin() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let store = Store::open(dir.path().join("custody.db"))?;
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(8));
    let threads = (0..8)
        .map(|index| {
            let store = store.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                provision_admin_caller(&store, &format!("admin-{index}")).is_ok()
            })
        })
        .collect::<Vec<_>>();
    let winners = threads
        .into_iter()
        .map(|thread| usize::from(thread.join().unwrap()))
        .sum::<usize>();
    assert_eq!(winners, 1);
    assert_eq!(store.list_signer_callers()?.len(), 1);
    assert_eq!(store.list_signer_audit(None, 100)?.len(), 1);
    Ok(())
}
