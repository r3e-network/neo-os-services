use super::*;

impl Store {
    /// Which custody row, if any, already holds this public key.
    ///
    /// The unique index on `public_key` is what actually stops a key being held
    /// twice; this exists because an index reports that as a constraint failure,
    /// whereas "this key is already held as `<id>`" is the sentence an operator
    /// acts on. The service asks here so it can answer a duplicate import as a
    /// refusal rather than as a server error.
    pub fn signer_key_id_holding(&self, public_key: &[u8; 33]) -> Result<Option<String>> {
        let connection = self.connection()?;
        connection
            .query_row(
                "SELECT id FROM signer_keys WHERE public_key = ?1",
                params![public_key.to_vec()],
                |row| row.get(0),
            )
            .optional()
            .map_err(Into::into)
    }

    /// Store a newly sealed key.
    pub fn create_signer_key(&self, key: &SignerKey) -> Result<()> {
        let connection = self.connection()?;
        Self::create_signer_key_on(&connection, key)
    }

    pub(super) fn create_signer_key_on(connection: &Connection, key: &SignerKey) -> Result<()> {
        connection.execute(
            "INSERT INTO signer_keys (
                id, label, network, public_key, nonce, ciphertext, created_at_unix, disabled,
                network_magic, chain_family, chain_id
             )
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                &key.id,
                &key.label,
                key.network.to_string(),
                key.public_key.to_vec(),
                key.sealed.nonce.to_vec(),
                &key.sealed.ciphertext,
                key.created_at_unix,
                key.disabled,
                key.network_magic,
                key.chain_family.to_string(),
                i64::try_from(key.chain_id).context("chain id exceeds SQLite integer range")?,
            ],
        )?;
        Ok(())
    }

    pub fn list_signer_keys(&self) -> Result<Vec<SignerKey>> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT id, label, network, public_key, nonce, ciphertext, created_at_unix, disabled,
                    network_magic, chain_family, chain_id
             FROM signer_keys
             ORDER BY label COLLATE NOCASE ASC, id ASC",
        )?;
        let rows = statement.query_map([], signer_key_from_row)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .context("failed to load custody keys")
    }

    pub fn get_signer_key(&self, id: &str) -> Result<SignerKey> {
        self.find_signer_key(id)?
            .ok_or_else(|| anyhow::anyhow!("custody key {id} was not found"))
    }

    /// The row, or `None`.
    ///
    /// The signing path needs this rather than [`Store::get_signer_key`]:
    /// a caller naming a key that is not held is a refusal to answer and to
    /// audit, while a database that failed mid-read is neither, and an error
    /// string is a poor way to tell them apart.
    pub fn find_signer_key(&self, id: &str) -> Result<Option<SignerKey>> {
        let connection = self.connection()?;
        Self::find_signer_key_on(&connection, id)
    }

    pub(super) fn find_signer_key_on(
        connection: &Connection,
        id: &str,
    ) -> Result<Option<SignerKey>> {
        connection
            .query_row(
                "SELECT id, label, network, public_key, nonce, ciphertext, created_at_unix, disabled,
                        network_magic, chain_family, chain_id
                 FROM signer_keys
                 WHERE id = ?1",
                params![id],
                signer_key_from_row,
            )
            .optional()
            .map_err(Into::into)
    }

    /// Flip the operator kill switch. A disabled key is refused before its
    /// policy is read, so this is the one action that does not need an operator
    /// to understand the policy to stop a key signing.
    pub fn set_signer_key_disabled(&self, id: &str, disabled: bool) -> Result<()> {
        let connection = self.connection()?;
        Self::set_signer_key_disabled_on(&connection, id, disabled)
    }

    pub(super) fn set_signer_key_disabled_on(
        connection: &Connection,
        id: &str,
        disabled: bool,
    ) -> Result<()> {
        let changed = connection.execute(
            "UPDATE signer_keys SET disabled = ?1 WHERE id = ?2",
            params![disabled, id],
        )?;
        ensure_affected_rows(changed, "custody key", id)?;
        Ok(())
    }

    /// Drop a key and, by cascade, its policy.
    ///
    /// The audit rows and the value ledger survive deliberately: what a key did
    /// is a fact about the past, and deleting it because the key is gone would
    /// remove the only record of the transfers the window was supposed to bound.
    pub fn delete_signer_key(&self, id: &str) -> Result<()> {
        let connection = self.connection()?;
        Self::delete_signer_key_on(&connection, id)
    }

    pub(super) fn delete_signer_key_on(connection: &Connection, id: &str) -> Result<()> {
        let deleted = connection.execute("DELETE FROM signer_keys WHERE id = ?1", params![id])?;
        ensure_affected_rows(deleted, "custody key", id)?;
        Ok(())
    }
}
