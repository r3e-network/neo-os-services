//! Row mappers for the custody tables.
//!
//! Every fixed-width byte field here is read through [`fixed`], which refuses a
//! stored value of the wrong length instead of padding or truncating it. That
//! matters more in this module than anywhere else in the repository: a
//! `public_key` one byte short would still build a `SignerKey`, still produce an
//! account, and the account would match nothing — the service would report
//! "this key is not a signer on the transaction" for a database that was simply
//! wrong.

use std::str::FromStr;

use crate::{
    model::{
        CallerCapability, KeyGrant, ScriptHash, SealedPrivateKey, SignerAuditAction,
        SignerAuditOutcome, SignerAuditRecord, SignerCaller, SignerKey, SignerPolicy,
        SignerValueEvent, WindowLimit,
    },
    network::Network,
    policy::WindowSpend,
    tx::HASH160_LEN,
};

use super::{decode_args_field, parse_field};

/// A sealed key, read in the column order the signer queries select.
pub(in crate::store) fn signer_key_from_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<SignerKey> {
    let network_raw: String = row.get(2)?;
    let nonce = fixed::<12>(4, row.get(4)?)?;
    Ok(SignerKey {
        id: row.get(0)?,
        label: row.get(1)?,
        network: parse_field::<Network>(&network_raw)?,
        public_key: fixed::<33>(3, row.get(3)?)?,
        sealed: SealedPrivateKey {
            nonce,
            ciphertext: row.get(5)?,
        },
        created_at_unix: row.get(6)?,
        disabled: row.get(7)?,
    })
}

pub(in crate::store) fn signer_policy_from_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<SignerPolicy> {
    let max_single_amount: Option<String> = row.get(10)?;
    let window_seconds: Option<i64> = row.get(11)?;
    let window_max_amount: Option<String> = row.get(12)?;

    let window_limit = match (window_seconds, window_max_amount) {
        (Some(seconds), Some(max_amount)) => Some(WindowLimit {
            seconds: u64::try_from(seconds).map_err(|_| length_error(11, "window seconds"))?,
            max_amount: parse_i128(12, &max_amount)?,
        }),
        (None, None) => None,
        // One half of a window ceiling cannot mean anything. [`WindowLimit`] is
        // one struct for exactly this reason, so a row that stores half of it is
        // a broken row rather than an unconfigured policy.
        _ => {
            return Err(rusqlite::Error::InvalidColumnType(
                11,
                "window".into(),
                rusqlite::types::Type::Integer,
            ))
        }
    };

    Ok(SignerPolicy {
        allow_consensus: row.get(0)?,
        allow_transfer: row.get(1)?,
        allow_contract_call: row.get(2)?,
        allow_global_scope: row.get(3)?,
        contract_whitelist: hash_list(4, &row.get::<_, String>(4)?)?,
        contract_blacklist: hash_list(5, &row.get::<_, String>(5)?)?,
        asset_whitelist: hash_list(6, &row.get::<_, String>(6)?)?,
        asset_blacklist: hash_list(7, &row.get::<_, String>(7)?)?,
        transfer_to_whitelist: hash_list(8, &row.get::<_, String>(8)?)?,
        transfer_to_blacklist: hash_list(9, &row.get::<_, String>(9)?)?,
        max_single_amount: max_single_amount
            .as_deref()
            .map(|raw| parse_i128(10, raw))
            .transpose()?,
        window_limit,
    })
}

pub(in crate::store) fn signer_caller_from_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<SignerCaller> {
    let mode: String = row.get(3)?;
    let grants_raw: String = row.get(4)?;
    let origins_raw: String = row.get(5)?;
    let capabilities_raw: String = row.get(8)?;
    Ok(SignerCaller {
        id: row.get(0)?,
        label: row.get(1)?,
        token_digest: fixed::<32>(2, row.get(2)?)?,
        key_grant: KeyGrant::from_mode(&mode, decode_args_field(&grants_raw)),
        capabilities: decode_capabilities(8, &capabilities_raw)?,
        allowed_origins: decode_args_field(&origins_raw),
        created_at_unix: row.get(6)?,
        disabled: row.get(7)?,
    })
}

pub(in crate::store) fn signer_audit_from_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<SignerAuditRecord> {
    let action_raw: String = row.get(2)?;
    let outcome_raw: String = row.get(3)?;
    Ok(SignerAuditRecord {
        id: row.get(0)?,
        recorded_at_unix: row.get(1)?,
        action: parse_field::<SignerAuditAction>(&action_raw)?,
        outcome: parse_field::<SignerAuditOutcome>(&outcome_raw)?,
        caller_id: row.get(4)?,
        key_id: row.get(5)?,
        tx_id: row.get(6)?,
        reason: row.get(7)?,
        detail: row.get(8)?,
        origin: row.get(9)?,
    })
}

pub(in crate::store) fn signer_value_event_from_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<SignerValueEvent> {
    let amount_raw: String = row.get(4)?;
    Ok(SignerValueEvent {
        id: row.get(0)?,
        key_id: row.get(1)?,
        recorded_at_unix: row.get(2)?,
        asset: account(3, row.get(3)?)?,
        amount: parse_i128(4, &amount_raw)?,
        audit_id: row.get(5)?,
    })
}

/// Fold ledger rows into the accumulator the policy engine reads.
pub(in crate::store) fn window_spend_from_events(events: &[SignerValueEvent]) -> WindowSpend {
    let mut spend = WindowSpend::new();
    for event in events {
        spend.record(event.asset, event.amount);
    }
    spend
}

fn length_error(index: usize, what: &str) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        index,
        rusqlite::types::Type::Blob,
        Box::new(rusqlite::Error::InvalidColumnName(what.to_string())),
    )
}

/// A stored value that should be exactly `N` bytes.
fn fixed<const N: usize>(index: usize, raw: Vec<u8>) -> rusqlite::Result<[u8; N]> {
    <[u8; N]>::try_from(raw).map_err(|_| length_error(index, "wrong length"))
}

fn account(index: usize, raw: Vec<u8>) -> rusqlite::Result<ScriptHash> {
    Ok(ScriptHash::from_wire(fixed::<HASH160_LEN>(index, raw)?))
}

fn parse_i128(index: usize, raw: &str) -> rusqlite::Result<i128> {
    i128::from_str(raw).map_err(|_| {
        rusqlite::Error::FromSqlConversionFailure(
            index,
            rusqlite::types::Type::Text,
            Box::new(rusqlite::Error::InvalidColumnName("amount".to_string())),
        )
    })
}

/// A separator-joined list of display-order hashes, as an operator configures
/// them and as the page shows them back.
fn hash_list(index: usize, raw: &str) -> rusqlite::Result<Vec<ScriptHash>> {
    decode_args_field(raw)
        .iter()
        .map(|entry| {
            ScriptHash::from_str(entry).map_err(|_| {
                rusqlite::Error::FromSqlConversionFailure(
                    index,
                    rusqlite::types::Type::Text,
                    Box::new(rusqlite::Error::InvalidColumnName(format!(
                        "malformed script hash: {entry}"
                    ))),
                )
            })
        })
        .collect()
}

/// The stored capability labels for one caller.
///
/// An unrecognised label fails the row rather than being skipped. Skipping is
/// the narrower answer — an unknown capability cannot be exercised — but it is
/// also the one that lets a `signer_callers` row written by a newer build keep
/// working here while quietly losing the authority its operator believes it
/// granted. A caller list that will not load is an outage an operator sees
/// immediately; a caller list that loads with invisible holes is not.
fn decode_capabilities(index: usize, raw: &str) -> rusqlite::Result<Vec<CallerCapability>> {
    decode_args_field(raw)
        .iter()
        .map(|entry| {
            parse_field::<CallerCapability>(entry).map_err(|_| {
                rusqlite::Error::FromSqlConversionFailure(
                    index,
                    rusqlite::types::Type::Text,
                    Box::new(rusqlite::Error::InvalidColumnName(format!(
                        "unknown caller capability: {entry}"
                    ))),
                )
            })
        })
        .collect()
}
