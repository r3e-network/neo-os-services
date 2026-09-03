use super::*;

/// Insert one value event through an existing connection or transaction.
///
/// `audit_id` is supplied by the transaction that owns the decision. Keeping
/// this primitive below both public write paths prevents the atomic
/// audit-and-ledger path from carrying a second copy of the SQL.
pub(super) fn insert_signer_value_event(
    connection: &Connection,
    event: &SignerValueEvent,
    audit_id: Option<i64>,
) -> Result<()> {
    connection.execute(
        "INSERT INTO signer_value_events (
            key_id, recorded_at_unix, asset, amount, audit_id
         )
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            &event.key_id,
            event.recorded_at_unix,
            event.asset.as_bytes().to_vec(),
            event.amount.to_string(),
            audit_id,
        ],
    )?;
    Ok(())
}

impl Store {
    /// Append the value that a signature moved out of a key.
    ///
    /// One transaction, because a signature whose ledger rows were half written
    /// would under-count the window on the next request — the failure mode the
    /// ledger exists to prevent.
    pub fn record_signer_value_events(&self, events: &[SignerValueEvent]) -> Result<()> {
        if events.is_empty() {
            return Ok(());
        }
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        for event in events {
            insert_signer_value_event(&transaction, event, event.audit_id)?;
        }
        transaction.commit()?;
        Ok(())
    }

    /// Everything that left `key_id` at or after `since_unix`.
    pub fn signer_value_events_since(
        &self,
        key_id: &str,
        since_unix: u64,
    ) -> Result<Vec<SignerValueEvent>> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT id, key_id, recorded_at_unix, asset, amount, audit_id
             FROM signer_value_events
             WHERE key_id = ?1 AND recorded_at_unix >= ?2
             ORDER BY recorded_at_unix ASC, id ASC",
        )?;
        let rows = statement.query_map(params![key_id, since_unix], signer_value_event_from_row)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .context("failed to load signer value events")
    }

    /// What the key has already spent inside the window, per token.
    ///
    /// Summed in Rust rather than with `SUM(amount)` in SQL: the amounts are
    /// `i128`, SQLite arithmetic would evaluate them as 64-bit and wrap, and a
    /// wrapped sum reads as "still inside the limit".
    pub fn signer_window_spend(&self, key_id: &str, since_unix: u64) -> Result<WindowSpend> {
        Ok(window_spend_from_events(
            &self.signer_value_events_since(key_id, since_unix)?,
        ))
    }
}
