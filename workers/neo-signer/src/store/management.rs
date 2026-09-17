use super::*;

pub(crate) enum ManagementChange<'a> {
    CreateKey(&'a SignerKey),
    DisableKey(&'a str, bool),
    DeleteKey(&'a str),
    SavePolicy(&'a str, &'a SignerPolicy),
    CreateCaller(&'a SignerCaller),
    BootstrapAdmin(&'a SignerCaller),
    RotateCaller(&'a str, &'a [u8; 32]),
    DisableCaller(&'a str, bool),
    DeleteCaller(&'a str),
}

impl Store {
    /// A management change exists only if its attributed audit row commits.
    pub(crate) fn record_signer_management(
        &self,
        change: ManagementChange<'_>,
        record: &SignerAuditRecord,
    ) -> Result<()> {
        let mut connection = self.connection()?;
        // Reserve the writer before checking first-admin existence, including
        // when distinct processes bootstrap the same local vault concurrently.
        let transaction =
            connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        match change {
            ManagementChange::CreateKey(key) => Self::create_signer_key_on(&transaction, key)?,
            ManagementChange::DisableKey(id, disabled) => {
                Self::set_signer_key_disabled_on(&transaction, id, disabled)?;
            }
            ManagementChange::DeleteKey(id) => Self::delete_signer_key_on(&transaction, id)?,
            ManagementChange::SavePolicy(id, policy) => {
                Self::save_signer_policy_on(&transaction, id, policy, record.recorded_at_unix)?;
            }
            ManagementChange::CreateCaller(caller) => {
                Self::create_signer_caller_on(&transaction, caller)?
            }
            ManagementChange::BootstrapAdmin(caller) => {
                if Self::list_signer_callers_on(&transaction)?
                    .iter()
                    .any(|existing| existing.has_capability(CallerCapability::Admin))
                {
                    anyhow::bail!(
                        "this vault already has an admin caller; provision a second one through the \
                         management API so the change is attributed and audited"
                    );
                }
                Self::create_signer_caller_on(&transaction, caller)?;
            }
            ManagementChange::RotateCaller(id, digest) => {
                Self::set_signer_caller_digest_on(&transaction, id, digest)?;
            }
            ManagementChange::DisableCaller(id, disabled) => {
                Self::set_signer_caller_disabled_on(&transaction, id, disabled)?;
            }
            ManagementChange::DeleteCaller(id) => Self::delete_signer_caller_on(&transaction, id)?,
        }
        super::audit::insert_signer_audit(&transaction, record)?;
        transaction.commit()?;
        Ok(())
    }
}
