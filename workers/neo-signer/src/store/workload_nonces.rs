use super::*;

impl Store {
    /// Atomically consume one workload assertion nonce.
    ///
    /// Expired rows are pruned in the same transaction. `false` means this
    /// caller already used the nonce; a database error is distinct and fails
    /// the request as infrastructure, never as an authentication guess.
    pub fn reserve_workload_nonce(
        &self,
        caller_id: &str,
        nonce: &str,
        expires_at_unix: u64,
        now_unix: u64,
    ) -> Result<bool> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        transaction.execute(
            "DELETE FROM signer_workload_nonces WHERE expires_at_unix < ?1",
            params![now_unix],
        )?;
        let inserted = transaction.execute(
            "INSERT OR IGNORE INTO signer_workload_nonces (
                caller_id, nonce, expires_at_unix
             )
             VALUES (?1, ?2, ?3)",
            params![caller_id, nonce, expires_at_unix],
        )?;
        transaction.commit()?;
        Ok(inserted == 1)
    }
}
