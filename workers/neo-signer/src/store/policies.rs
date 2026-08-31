use super::*;

impl Store {
    /// Store a key's boundary, replacing any previous one.
    ///
    /// `normalized()` runs before the write so the row that lands in the
    /// database is the row that a later read compares against — otherwise a
    /// policy edited twice would stop matching its own audit history on a
    /// whitespace or ordering difference.
    pub fn save_signer_policy(
        &self,
        key_id: &str,
        policy: &SignerPolicy,
        updated_at_unix: u64,
    ) -> Result<()> {
        let connection = self.connection()?;
        ensure_signer_key_exists(&connection, key_id)?;
        let policy = policy.clone().normalized();
        let (window_seconds, window_max_amount) = match policy.window_limit {
            Some(limit) => (
                Some(i64::try_from(limit.seconds).unwrap_or(i64::MAX)),
                Some(limit.max_amount.to_string()),
            ),
            None => (None, None),
        };
        connection.execute(
            "INSERT INTO signer_policies (
                key_id, allow_consensus, allow_transfer, allow_contract_call, allow_global_scope,
                contract_whitelist, contract_blacklist, asset_whitelist, asset_blacklist,
                transfer_to_whitelist, transfer_to_blacklist, max_single_amount,
                window_seconds, window_max_amount, updated_at_unix
             )
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
             ON CONFLICT(key_id) DO UPDATE SET
                allow_consensus = excluded.allow_consensus,
                allow_transfer = excluded.allow_transfer,
                allow_contract_call = excluded.allow_contract_call,
                allow_global_scope = excluded.allow_global_scope,
                contract_whitelist = excluded.contract_whitelist,
                contract_blacklist = excluded.contract_blacklist,
                asset_whitelist = excluded.asset_whitelist,
                asset_blacklist = excluded.asset_blacklist,
                transfer_to_whitelist = excluded.transfer_to_whitelist,
                transfer_to_blacklist = excluded.transfer_to_blacklist,
                max_single_amount = excluded.max_single_amount,
                window_seconds = excluded.window_seconds,
                window_max_amount = excluded.window_max_amount,
                updated_at_unix = excluded.updated_at_unix",
            params![
                key_id,
                policy.allow_consensus,
                policy.allow_transfer,
                policy.allow_contract_call,
                policy.allow_global_scope,
                encode_hashes(&policy.contract_whitelist),
                encode_hashes(&policy.contract_blacklist),
                encode_hashes(&policy.asset_whitelist),
                encode_hashes(&policy.asset_blacklist),
                encode_hashes(&policy.transfer_to_whitelist),
                encode_hashes(&policy.transfer_to_blacklist),
                policy.max_single_amount.map(|amount| amount.to_string()),
                window_seconds,
                window_max_amount,
                updated_at_unix,
            ],
        )?;
        Ok(())
    }

    /// The boundary attached to a key, or `None` when none was ever saved.
    ///
    /// `None` is not a policy that allows nothing by being empty — it is the
    /// absence of a row, and the caller has to say which it means. The service
    /// treats it as the all-switches-off default, which is the fail-closed
    /// reading and the one that matches a freshly created key.
    pub fn load_signer_policy(&self, key_id: &str) -> Result<Option<SignerPolicy>> {
        let connection = self.connection()?;
        connection
            .query_row(
                "SELECT allow_consensus, allow_transfer, allow_contract_call, allow_global_scope,
                        contract_whitelist, contract_blacklist, asset_whitelist, asset_blacklist,
                        transfer_to_whitelist, transfer_to_blacklist, max_single_amount,
                        window_seconds, window_max_amount
                 FROM signer_policies
                 WHERE key_id = ?1",
                params![key_id],
                signer_policy_from_row,
            )
            .optional()
            .map_err(Into::into)
    }

    /// The boundary or the default, for callers that only ever need one.
    pub fn signer_policy_or_default(&self, key_id: &str) -> Result<SignerPolicy> {
        Ok(self.load_signer_policy(key_id)?.unwrap_or_default())
    }
}

/// Policy lists are stored as the operator writes them: display-order hashes
/// joined by the repository's usual separator. Keeping them as text means a
/// database browser shows a whitelist a human can read, and the byte order is
/// fixed by [`ScriptHash`]'s parser rather than by a blob nobody can check.
fn encode_hashes(hashes: &[ScriptHash]) -> String {
    encode_args(
        &hashes
            .iter()
            .map(|hash| hash.to_display())
            .collect::<Vec<_>>(),
    )
}

fn ensure_signer_key_exists(connection: &Connection, key_id: &str) -> Result<()> {
    let found: Option<String> = connection
        .query_row(
            "SELECT id FROM signer_keys WHERE id = ?1",
            params![key_id],
            |row| row.get(0),
        )
        .optional()?;
    if found.is_none() {
        anyhow::bail!("custody key {key_id} was not found");
    }
    Ok(())
}
