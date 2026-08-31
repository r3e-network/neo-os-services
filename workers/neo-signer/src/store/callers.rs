use super::*;

impl Store {
    pub fn create_signer_caller(&self, caller: &SignerCaller) -> Result<()> {
        let connection = self.connection()?;
        connection.execute(
            "INSERT INTO signer_callers (
                id, label, token_digest, key_grant_mode, key_grants, allowed_origins,
                created_at_unix, disabled, capabilities
             )
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                &caller.id,
                &caller.label,
                caller.token_digest.to_vec(),
                caller.key_grant.mode(),
                encode_grants(&caller.key_grant),
                encode_origins(&caller.allowed_origins),
                caller.created_at_unix,
                caller.disabled,
                encode_capabilities(&caller.capabilities),
            ],
        )?;
        Ok(())
    }

    /// Every caller, for the page and for token resolution.
    ///
    /// Deliberately not a `WHERE token_digest = ?1` lookup: the digest
    /// comparison belongs in one constant-time place (`signer::auth`) rather
    /// than inside an index probe, and the row count here is a handful of
    /// integrations, not a user table.
    pub fn list_signer_callers(&self) -> Result<Vec<SignerCaller>> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT id, label, token_digest, key_grant_mode, key_grants, allowed_origins,
                    created_at_unix, disabled, capabilities
             FROM signer_callers
             ORDER BY label COLLATE NOCASE ASC, id ASC",
        )?;
        let rows = statement.query_map([], signer_caller_from_row)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .context("failed to load signer callers")
    }

    pub fn get_signer_caller(&self, id: &str) -> Result<SignerCaller> {
        self.find_signer_caller(id)?
            .ok_or_else(|| anyhow::anyhow!("signer caller {id} was not found"))
    }

    /// The row, or `None`.
    ///
    /// The same reason [`Store::find_signer_key`] exists: a management request
    /// naming a caller that is not held is a refusal to answer and to audit,
    /// while a database that failed mid-read is neither — and the two must not
    /// have to be told apart by matching on an error string.
    pub fn find_signer_caller(&self, id: &str) -> Result<Option<SignerCaller>> {
        let connection = self.connection()?;
        connection
            .query_row(
                "SELECT id, label, token_digest, key_grant_mode, key_grants, allowed_origins,
                        created_at_unix, disabled, capabilities
                 FROM signer_callers
                 WHERE id = ?1",
                params![id],
                signer_caller_from_row,
            )
            .optional()
            .map_err(Into::into)
    }

    /// Replace a caller's credential digest. The plaintext token never reaches
    /// this function's caller twice: rotation mints a new one and returns it
    /// once.
    pub fn set_signer_caller_digest(&self, id: &str, token_digest: &[u8; 32]) -> Result<()> {
        let connection = self.connection()?;
        let changed = connection.execute(
            "UPDATE signer_callers SET token_digest = ?1 WHERE id = ?2",
            params![token_digest.to_vec(), id],
        )?;
        ensure_affected_rows(changed, "signer caller", id)?;
        Ok(())
    }

    pub fn set_signer_caller_disabled(&self, id: &str, disabled: bool) -> Result<()> {
        let connection = self.connection()?;
        let changed = connection.execute(
            "UPDATE signer_callers SET disabled = ?1 WHERE id = ?2",
            params![disabled, id],
        )?;
        ensure_affected_rows(changed, "signer caller", id)?;
        Ok(())
    }

    pub fn delete_signer_caller(&self, id: &str) -> Result<()> {
        let connection = self.connection()?;
        let deleted =
            connection.execute("DELETE FROM signer_callers WHERE id = ?1", params![id])?;
        ensure_affected_rows(deleted, "signer caller", id)?;
        Ok(())
    }
}

fn encode_grants(grant: &KeyGrant) -> String {
    match grant {
        KeyGrant::Any => String::new(),
        KeyGrant::Only(ids) => encode_args(ids),
    }
}

fn encode_origins(origins: &[String]) -> String {
    encode_args(origins)
}

/// Capabilities as their stored labels, joined by the list separator.
///
/// An empty list stores as an empty string, which decodes back to "no
/// capabilities" — a caller that can do nothing. The column's SQL default of
/// `'sign'` applies only to rows added by the migration, never to a row written
/// here.
fn encode_capabilities(capabilities: &[CallerCapability]) -> String {
    encode_args(
        &capabilities
            .iter()
            .map(|capability| capability.label().to_owned())
            .collect::<Vec<_>>(),
    )
}
