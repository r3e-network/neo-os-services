use std::str::FromStr;

use super::*;
use crate::model::{SignerAuditAction, SignerRequestCompletion};
use crate::network::ChainFamily;

/// Insert the completed public result through the transaction that owns its
/// allowed audit row and value reservations.
pub(super) fn insert_signer_request(
    connection: &Connection,
    completion: &SignerRequestCompletion,
    audit_id: i64,
) -> Result<()> {
    connection.execute(
        "INSERT INTO signer_requests (
            caller_id, request_id, key_id, action, request_digest, result_digest,
            script_hash, address, invocation, verification, completed_at_unix, audit_id, chain_family
         )
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![
            &completion.caller_id,
            &completion.request_id,
            &completion.key_id,
            completion.action.to_string(),
            completion.request_digest.to_vec(),
            &completion.result_digest,
            completion.script_hash.as_bytes().to_vec(),
            &completion.address,
            &completion.invocation,
            &completion.verification,
            completion.completed_at_unix,
            audit_id,
            completion.chain_family.as_ref().map(|cf| cf.to_string()),
        ],
    )?;
    Ok(())
}

impl Store {
    /// A caller's completed idempotent request, if this id was used before.
    pub fn find_signer_request(
        &self,
        caller_id: &str,
        request_id: &str,
    ) -> Result<Option<SignerRequestCompletion>> {
        let connection = self.connection()?;
        connection
            .query_row(
                "SELECT caller_id, request_id, key_id, action, request_digest,
                        result_digest, script_hash, address, invocation, verification,
                        completed_at_unix, audit_id, chain_family
                 FROM signer_requests
                 WHERE caller_id = ?1 AND request_id = ?2",
                params![caller_id, request_id],
                |row| {
                    let action: String = row.get(3)?;
                    let request_digest = fixed::<32>(4, row.get(4)?, "request digest")?;
                    let script_hash =
                        ScriptHash::from_wire(fixed::<20>(6, row.get(6)?, "script hash")?);
                    let chain_family_str: Option<String> = row.get(12)?;
                    let chain_family = chain_family_str
                        .as_deref()
                        .map(|s| ChainFamily::from_str(s))
                        .transpose()
                        .map_err(|error| {
                            rusqlite::Error::FromSqlConversionFailure(
                                12,
                                rusqlite::types::Type::Text,
                                error.into(),
                            )
                        })?;
                    Ok(SignerRequestCompletion {
                        caller_id: row.get(0)?,
                        request_id: row.get(1)?,
                        key_id: row.get(2)?,
                        action: SignerAuditAction::from_str(&action).map_err(|error| {
                            rusqlite::Error::FromSqlConversionFailure(
                                3,
                                rusqlite::types::Type::Text,
                                error.into(),
                            )
                        })?,
                        request_digest,
                        result_digest: row.get(5)?,
                        script_hash,
                        address: row.get(7)?,
                        invocation: row.get(8)?,
                        verification: row.get(9)?,
                        completed_at_unix: row.get(10)?,
                        audit_id: row.get(11)?,
                        chain_family,
                    })
                },
            )
            .optional()
            .map_err(Into::into)
    }
}

fn fixed<const N: usize>(index: usize, raw: Vec<u8>, name: &str) -> rusqlite::Result<[u8; N]> {
    <[u8; N]>::try_from(raw).map_err(|_| {
        rusqlite::Error::FromSqlConversionFailure(
            index,
            rusqlite::types::Type::Blob,
            Box::new(rusqlite::Error::InvalidColumnName(format!(
                "wrong-length {name}"
            ))),
        )
    })
}
