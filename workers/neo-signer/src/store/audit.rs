use super::*;

impl Store {
    /// Append one audit row and return its id.
    ///
    /// The id is returned because a signature that moved value also produces a
    /// ledger row, and that row names the audit entry that authorised it.
    /// Without the link, a window sum is a list of amounts with no decision
    /// behind them, and the question "why did this spend the limit" has no
    /// answer.
    ///
    /// `record.id` is ignored — the row is always new.
    pub fn record_signer_audit(&self, record: &SignerAuditRecord) -> Result<i64> {
        let connection = self.connection()?;
        connection.execute(
            "INSERT INTO signer_audit (
                recorded_at_unix, action, outcome, caller_id, key_id, tx_id, reason, detail, origin
             )
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                record.recorded_at_unix,
                record.action.to_string(),
                record.outcome.to_string(),
                &record.caller_id,
                &record.key_id,
                &record.tx_id,
                &record.reason,
                &record.detail,
                &record.origin,
            ],
        )?;
        Ok(connection.last_insert_rowid())
    }

    /// Most recent audit rows, newest first, optionally narrowed to one key.
    pub fn list_signer_audit(
        &self,
        key_id: Option<&str>,
        limit: usize,
    ) -> Result<Vec<SignerAuditRecord>> {
        let connection = self.connection()?;
        let limit = i64::try_from(limit).unwrap_or(i64::MAX);
        let mut statement = match key_id {
            Some(_) => connection.prepare(
                "SELECT id, recorded_at_unix, action, outcome, caller_id, key_id, tx_id,
                        reason, detail, origin
                 FROM signer_audit
                 WHERE key_id = ?1
                 ORDER BY recorded_at_unix DESC, id DESC
                 LIMIT ?2",
            )?,
            None => connection.prepare(
                "SELECT id, recorded_at_unix, action, outcome, caller_id, key_id, tx_id,
                        reason, detail, origin
                 FROM signer_audit
                 ORDER BY recorded_at_unix DESC, id DESC
                 LIMIT ?1",
            )?,
        };
        let rows = match key_id {
            Some(key_id) => statement.query_map(params![key_id, limit], signer_audit_from_row)?,
            None => statement.query_map(params![limit], signer_audit_from_row)?,
        };
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .context("failed to load signer audit records")
    }
}
