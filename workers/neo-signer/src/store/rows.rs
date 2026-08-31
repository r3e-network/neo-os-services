//! Row mappers for the custody tables, and the two field-decoding helpers they
//! share with the rest of the store.

mod signer;

use std::str::FromStr;

pub(super) use signer::{
    signer_audit_from_row, signer_caller_from_row, signer_key_from_row, signer_policy_from_row,
    signer_value_event_from_row, window_spend_from_events,
};

fn parse_field<T>(raw: &str) -> rusqlite::Result<T>
where
    T: FromStr<Err = anyhow::Error>,
{
    T::from_str(raw).map_err(|error| rusqlite::Error::ToSqlConversionFailure(error.into()))
}

fn decode_args_field(raw: &str) -> Vec<String> {
    super::decode_args(raw)
}
