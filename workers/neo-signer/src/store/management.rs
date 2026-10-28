use super::*;

pub(crate) enum ManagementChange<'a> {
    CreateKey(&'a SignerKey),
    DisableKey(&'a str, bool),
    DeleteKey(&'a str),
    SavePolicy(&'a str, &'a SignerPolicy),
    CreateCaller(&'a SignerCaller),
    BootstrapAdmin(&'a SignerCaller),
    RotateCaller(&'a str, &'a [u8; 32]),
    DisableCaller(&'a str, bool),
    DeleteCaller(&'a str),
}

impl Store {
    /// A management change exists only if its attributed audit row commits.
    pub(crate) fn record_signer_management(
        &self,
        change: ManagementChange<'_>,
        record: &SignerAuditRecord,
    ) -> Result<()> {
        let mut connection = self.connection()?;
        // Reserve the writer before checking first-admin existence, including
        // when distinct processes bootstrap the same local vault concurrently.
        let transaction =
            connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        match change {
            ManagementChange::CreateKey(key) => Self::create_signer_key_on(&transaction, key)?,
            ManagementChange::DisableKey(id, disabled) => {
                Self::set_signer_key_disabled_on(&transaction, id, disabled)?;
            }
            ManagementChange::DeleteKey(id) => Self::delete_signer_key_on(&transaction, id)?,
            ManagementChange::SavePolicy(id, policy) => {
                Self::save_signer_policy_on(&transaction, id, policy, record.recorded_at_unix)?;
            }
            ManagementChange::CreateCaller(caller) => {
                Self::create_signer_caller_on(&transaction, caller)?
            }
            ManagementChange::BootstrapAdmin(caller) => {
                if Self::list_signer_callers_on(&transaction)?
                    .iter()
                    .any(|existing| existing.has_capability(CallerCapability::Admin))
                {
                    anyhow::bail!(
                        "this vault already has an admin caller; provision a second one through the \
                         management API so the change is attributed and audited"
                    );
                }
                Self::create_signer_caller_on(&transaction, caller)?;
            }
            ManagementChange::RotateCaller(id, digest) => {
                Self::set_signer_caller_digest_on(&transaction, id, digest)?;
            }
            ManagementChange::DisableCaller(id, disabled) => {
                Self::set_signer_caller_disabled_on(&transaction, id, disabled)?;
            }
            ManagementChange::DeleteCaller(id) => Self::delete_signer_caller_on(&transaction, id)?,
        }
        super::audit::insert_signer_audit(&transaction, record)?;
        transaction.commit()?;
        Ok(())
    }
}

impl Store {
    /// No preseeded application state is permissible, including non-Admin rows.
    pub(crate) fn enroll_genesis(
        &self,
        enrollment: &crate::enrollment::ValidatedGenesisEnrollment,
    ) -> Result<()> {
        let mut connection = self.connection()?;
        let transaction =
            connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        Self::check_enrollment_tables(&transaction, false)?;
        Self::create_signer_caller_on(&transaction, enrollment.caller())?;
        let id = super::audit::insert_signer_audit(&transaction, enrollment.audit())?;
        anyhow::ensure!(id == 1, "enrollment audit sequence is not virgin");
        transaction.commit()?;
        Ok(())
    }

    /// Historical evidence is mandatory on every restore. Only generation one
    /// pins the current caller: later authorized rotation must remain intact.
    pub(crate) fn validate_enrollment(
        &self,
        enrollment: &crate::enrollment::ValidatedGenesisEnrollment,
        generation: u64,
    ) -> Result<()> {
        let connection = self.connection()?;
        let audit = connection.query_row(
            "SELECT id, recorded_at_unix, action, outcome, caller_id, key_id, tx_id, reason, detail, origin FROM signer_audit WHERE id = 1",
            [], signer_audit_from_row)?;
        anyhow::ensure!(
            &audit == enrollment.audit(),
            "historical enrollment receipt mismatch"
        );
        let callers = Self::list_signer_callers_on(&connection)?;
        if generation == 1 {
            Self::check_enrollment_tables(&connection, true)?;
            anyhow::ensure!(
                callers == [enrollment.caller().clone()],
                "initial enrollment caller mismatch"
            );
        }
        anyhow::ensure!(
            callers.iter().any(|c| !c.disabled
                && c.has_capability(CallerCapability::Admin)
                && matches!(c.key_grant, KeyGrant::Any)),
            "committed enrollment has no usable Admin"
        );
        Ok(())
    }

    fn check_enrollment_tables(connection: &Connection, initialized: bool) -> Result<()> {
        let mut statement = connection.prepare(
            "SELECT name FROM sqlite_schema WHERE type = 'table' AND substr(name, 1, 7) != 'sqlite_'",
        )?;
        let tables = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for table in tables {
            let expected = i64::from(
                initialized && matches!(table.as_str(), "signer_callers" | "signer_audit"),
            );
            let query = format!("SELECT COUNT(*) FROM \"{}\"", table.replace('"', "\"\""));
            let count: i64 = connection.query_row(&query, [], |row| row.get(0))?;
            anyhow::ensure!(
                count == expected,
                "enrollment requires exact initial application state"
            );
        }
        Ok(())
    }
}

impl Store {
    /// Read-only validation in the authenticated snapshot's in-memory database,
    /// before installing any path or constructing a usable signer. Generation
    /// one pins the complete initial batch. Later generations check historical
    /// evidence only: no caller/key is recreated, enabled, or overwritten.
    pub(crate) fn validate_migration_snapshot(
        cipher: &crate::snapshot::SnapshotCipher,
        envelope: &[u8],
        expected: &crate::snapshot::SnapshotHead,
        migration: &crate::migration::MeasuredMigration,
        root: &crate::vault::MasterKey,
    ) -> Result<()> {
        let generation = expected.position.generation;
        anyhow::ensure!(generation > 0, "migration restore requires committed state");
        anyhow::ensure!(
            &expected.binding.profile_hash == migration.profile_hash(),
            "migration snapshot profile mismatch"
        );
        let connection = Self::restore_snapshot(cipher, envelope, expected)?;
        let audit = connection.query_row(
            "SELECT id, recorded_at_unix, action, outcome, caller_id, key_id, tx_id, reason, detail, origin FROM signer_audit WHERE id = 1",
            [], signer_audit_from_row)?;
        let imported_at = migration.validate_receipt(&audit)?;
        if generation == 1 {
            Self::check_migration_tables(&connection)?;
            let callers = Self::list_signer_callers_on(&connection)?;
            anyhow::ensure!(
                callers == [migration.initial_caller(root, imported_at)?],
                "initial migration caller mismatch"
            );
            for (index, id) in migration.key_ids().iter().enumerate() {
                let key = Self::find_signer_key_on(&connection, id)?
                    .context("initial migration key missing")?;
                migration.validate_initial_key(index, &key, root, imported_at)?;
                anyhow::ensure!(
                    Self::load_signer_policy_on(&connection, id)?
                        == Some(migration.initial_policy()),
                    "initial migration policy mismatch"
                );
                let updated_at: u64 = connection.query_row(
                    "SELECT updated_at_unix FROM signer_policies WHERE key_id = ?1",
                    params![id],
                    |row| row.get(0),
                )?;
                anyhow::ensure!(
                    updated_at == imported_at,
                    "initial migration policy timestamp mismatch"
                );
            }
        }
        Ok(())
    }

    fn check_migration_tables(connection: &Connection) -> Result<()> {
        let mut statement = connection.prepare(
            "SELECT name FROM sqlite_schema WHERE type = 'table' AND substr(name, 1, 7) != 'sqlite_'",
        )?;
        let tables = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for table in tables {
            let expected: i64 = match table.as_str() {
                "signer_keys" | "signer_policies" => 2,
                "signer_callers" | "signer_audit" => 1,
                _ => 0,
            };
            let query = format!("SELECT COUNT(*) FROM \"{}\"", table.replace('"', "\"\""));
            let count: i64 = connection.query_row(&query, [], |row| row.get(0))?;
            anyhow::ensure!(
                count == expected,
                "migration requires exact initial application state"
            );
        }
        Ok(())
    }

    /// Preparation-only primitive, not wired to any runtime caller. The opaque
    /// permit currently has no production constructor. Coordinator integration
    /// must keep this store private until a complete durable receipt is verified.
    pub(crate) fn stage_legacy_migration(
        &self,
        prepared: &crate::migration::PreparedMigration,
        permit: &crate::migration::MigrationGenesisPermit,
    ) -> Result<()> {
        prepared.check_permit(permit)?;
        let mut connection = self.connection()?;
        let transaction =
            connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        Self::check_enrollment_tables(&transaction, false)?;
        for key in prepared.keys() {
            Self::create_signer_key_on(&transaction, key)?;
            Self::save_signer_policy_on(
                &transaction,
                &key.id,
                prepared.policy(),
                prepared.audit().recorded_at_unix,
            )?;
        }
        Self::create_signer_caller_on(&transaction, prepared.caller())?;
        let id = super::audit::insert_signer_audit(&transaction, prepared.audit())?;
        anyhow::ensure!(id == 1, "migration audit sequence is not virgin");
        transaction.commit()?;
        Ok(())
    }
}
