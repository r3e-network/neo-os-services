use super::*;

/// Insert one audit row through an existing connection or transaction.
pub(super) fn insert_signer_audit(
    connection: &Connection,
    record: &SignerAuditRecord,
) -> Result<i64> {
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
        insert_signer_audit(&connection, record)
    }

    /// Commit an allowed signing decision and every value it reserved in one
    /// SQLite transaction.
    ///
    /// A signature is not returned until this succeeds. If either the audit
    /// insert or one ledger insert fails, the transaction rolls back and the
    /// caller receives no witness; there is no state where an audit row says
    /// "allowed" while the rolling-window ledger forgot the spend.
    pub fn record_signer_decision(
        &self,
        record: &SignerAuditRecord,
        events: &[SignerValueEvent],
        consensus: Option<&SignerConsensusReservation>,
        request: Option<&SignerRequestCompletion>,
    ) -> Result<i64> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let audit_id = insert_signer_audit(&transaction, record)?;
        for event in events {
            super::value_events::insert_signer_value_event(&transaction, event, Some(audit_id))?;
        }
        if let Some(reservation) = consensus {
            super::consensus::insert_consensus_reservation(&transaction, reservation, audit_id)?;
        }
        if let Some(request) = request {
            super::requests::insert_signer_request(&transaction, request, audit_id)?;
        }
        transaction.commit()?;
        Ok(audit_id)
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

    /// Count successful signature decisions for one key in a rolling period.
    ///
    /// Denials and failed attempts do not consume the ceiling because no
    /// signature left the service. Management audit events are excluded even
    /// when they target the same key.
    pub fn signer_signature_count(&self, key_id: &str, since_unix: u64) -> Result<u64> {
        let connection = self.connection()?;
        let count: i64 = connection.query_row(
            "SELECT COUNT(*)
             FROM signer_audit
             WHERE key_id = ?1
               AND recorded_at_unix >= ?2
               AND outcome = 'allowed'
               AND action IN (
                   'signer-transaction-signed',
                   'signer-consensus-signed',
                   'signer-raw-signed',
                   'signer-eip191-fulfillment-signed'
               )",
            params![key_id, since_unix],
            |row| row.get(0),
        )?;
        u64::try_from(count).context("signature audit count was negative")
    }
}
