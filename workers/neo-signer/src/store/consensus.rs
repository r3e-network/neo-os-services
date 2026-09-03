use rusqlite::TransactionBehavior;

use super::*;

fn find_consensus_reservation(
    connection: &Connection,
    candidate: &SignerConsensusReservation,
) -> Result<Option<SignerConsensusReservation>> {
    connection
        .query_row(
            "SELECT public_key, network_magic, block_index, phase,
                    validator_index, view_number, checkpoint,
                    recorded_at_unix, audit_id
             FROM signer_consensus_reservations
             WHERE (public_key = ?1 OR public_key = zeroblob(33))
               AND network_magic = ?2
               AND block_index = ?3
               AND phase = ?4
               AND view_number = ?5
             ORDER BY CASE WHEN public_key = zeroblob(33) THEN 0 ELSE 1 END
             LIMIT 1",
            params![
                candidate.public_key.to_vec(),
                candidate.network_magic,
                candidate.block_index,
                candidate.phase,
                candidate.view_number,
            ],
            reservation_from_row,
        )
        .optional()
        .map_err(Into::into)
}

fn same_checkpoint(
    stored: &SignerConsensusReservation,
    candidate: &SignerConsensusReservation,
) -> bool {
    stored.public_key == candidate.public_key
        && stored.validator_index == candidate.validator_index
        && stored.checkpoint == candidate.checkpoint
}

/// Attach an already-reserved slot to its completed audit decision.
pub(super) fn insert_consensus_reservation(
    connection: &Connection,
    reservation: &SignerConsensusReservation,
    audit_id: i64,
) -> Result<()> {
    if let Some(stored) = find_consensus_reservation(connection, reservation)? {
        if !same_checkpoint(&stored, reservation) {
            anyhow::bail!(
                "consensus slot conflict at height {}, phase 0x{:02x}, validator {}, view {}",
                reservation.block_index,
                reservation.phase,
                reservation.validator_index,
                reservation.view_number
            );
        }
        connection.execute(
            "UPDATE signer_consensus_reservations
             SET audit_id = COALESCE(audit_id, ?6)
             WHERE public_key = ?1
               AND network_magic = ?2
               AND block_index = ?3
               AND phase = ?4
               AND view_number = ?5",
            params![
                reservation.public_key.to_vec(),
                reservation.network_magic,
                reservation.block_index,
                reservation.phase,
                reservation.view_number,
                audit_id,
            ],
        )?;
        return Ok(());
    }
    insert_row(connection, reservation, Some(audit_id))
}

fn insert_row(
    connection: &Connection,
    reservation: &SignerConsensusReservation,
    audit_id: Option<i64>,
) -> Result<()> {
    connection.execute(
        "INSERT INTO signer_consensus_reservations (
            public_key, network_magic, block_index, phase, validator_index,
            view_number, checkpoint, recorded_at_unix, audit_id
         )
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            reservation.public_key.to_vec(),
            reservation.network_magic,
            reservation.block_index,
            reservation.phase,
            reservation.validator_index,
            reservation.view_number,
            reservation.checkpoint.to_vec(),
            reservation.recorded_at_unix,
            audit_id,
        ],
    )?;
    Ok(())
}

impl Store {
    /// Occupy a dBFT safety slot in an immediate transaction before key
    /// material is opened. `Some` means the slot already existed.
    pub fn reserve_signer_consensus(
        &self,
        candidate: &SignerConsensusReservation,
    ) -> Result<Option<SignerConsensusReservation>> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing = find_consensus_reservation(&transaction, candidate)?;
        if existing.is_none() {
            insert_row(&transaction, candidate, None)?;
        }
        transaction.commit()?;
        Ok(existing)
    }

    pub fn find_signer_consensus_reservation(
        &self,
        candidate: &SignerConsensusReservation,
    ) -> Result<Option<SignerConsensusReservation>> {
        find_consensus_reservation(&self.connection()?, candidate)
    }
}

fn reservation_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SignerConsensusReservation> {
    let public_key = fixed_blob::<33>(row, 0, "consensus public key")?;
    let checkpoint = fixed_blob::<32>(row, 6, "consensus checkpoint")?;
    Ok(SignerConsensusReservation {
        public_key,
        network_magic: row.get(1)?,
        block_index: row.get(2)?,
        phase: row.get(3)?,
        validator_index: row.get(4)?,
        view_number: row.get(5)?,
        checkpoint,
        recorded_at_unix: row.get(7)?,
        audit_id: row.get(8)?,
    })
}

fn fixed_blob<const N: usize>(
    row: &rusqlite::Row<'_>,
    index: usize,
    field: &'static str,
) -> rusqlite::Result<[u8; N]> {
    let raw: Vec<u8> = row.get(index)?;
    <[u8; N]>::try_from(raw).map_err(|_| {
        rusqlite::Error::FromSqlConversionFailure(
            index,
            rusqlite::types::Type::Blob,
            Box::new(rusqlite::Error::InvalidColumnName(format!(
                "{field} must be {N} bytes"
            ))),
        )
    })
}
