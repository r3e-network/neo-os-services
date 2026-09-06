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
        let (signature_window_seconds, signature_window_count) = match policy.max_signatures {
            Some(limit) => (
                Some(i64::try_from(limit.seconds).unwrap_or(i64::MAX)),
                Some(i64::try_from(limit.count).unwrap_or(i64::MAX)),
            ),
            None => (None, None),
        };
        let contract_method_whitelist = encode_contract_methods(&policy.contract_method_whitelist)?;
        let contract_method_blacklist = encode_contract_methods(&policy.contract_method_blacklist)?;
        let asset_limits = encode_asset_limits(&policy.asset_limits)?;
        let evm_method_whitelist = encode_args(&policy.evm_method_whitelist);
        let evm_method_blacklist = encode_args(&policy.evm_method_blacklist);
        let evm_max_gas_limit = policy
            .evm_max_gas_limit
            .map(i64::try_from)
            .transpose()
            .context("EVM gas limit exceeds SQLite integer range")?;
        let evm_chain_id = policy
            .evm_chain_id
            .map(i64::try_from)
            .transpose()
            .context("EVM chain id exceeds SQLite integer range")?;
        connection.execute(
            "INSERT INTO signer_policies (
                key_id, allow_consensus, allow_raw, allow_transfer, allow_contract_call,
                allow_global_scope,
                contract_whitelist, contract_blacklist,
                contract_method_whitelist, contract_method_blacklist,
                asset_whitelist, asset_blacklist,
                transfer_to_whitelist, transfer_to_blacklist, max_single_amount,
                window_seconds, window_max_amount, max_signers, max_system_fee,
                max_network_fee, signature_window_seconds, signature_window_count,
                asset_limits, chain_family, evm_max_gas_price, evm_max_gas_limit,
                evm_method_whitelist, evm_method_blacklist, evm_chain_id, updated_at_unix
             )
             VALUES (
                 ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
                 ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26,
                 ?27, ?28, ?29, ?30
             )
             ON CONFLICT(key_id) DO UPDATE SET
                allow_consensus = excluded.allow_consensus,
                allow_raw = excluded.allow_raw,
                allow_transfer = excluded.allow_transfer,
                allow_contract_call = excluded.allow_contract_call,
                allow_global_scope = excluded.allow_global_scope,
                contract_whitelist = excluded.contract_whitelist,
                contract_blacklist = excluded.contract_blacklist,
                contract_method_whitelist = excluded.contract_method_whitelist,
                contract_method_blacklist = excluded.contract_method_blacklist,
                asset_whitelist = excluded.asset_whitelist,
                asset_blacklist = excluded.asset_blacklist,
                transfer_to_whitelist = excluded.transfer_to_whitelist,
                transfer_to_blacklist = excluded.transfer_to_blacklist,
                max_single_amount = excluded.max_single_amount,
                window_seconds = excluded.window_seconds,
                window_max_amount = excluded.window_max_amount,
                max_signers = excluded.max_signers,
                max_system_fee = excluded.max_system_fee,
                max_network_fee = excluded.max_network_fee,
                signature_window_seconds = excluded.signature_window_seconds,
                signature_window_count = excluded.signature_window_count,
                asset_limits = excluded.asset_limits,
                chain_family = excluded.chain_family,
                evm_max_gas_price = excluded.evm_max_gas_price,
                evm_max_gas_limit = excluded.evm_max_gas_limit,
                evm_method_whitelist = excluded.evm_method_whitelist,
                evm_method_blacklist = excluded.evm_method_blacklist,
                evm_chain_id = excluded.evm_chain_id,
                updated_at_unix = excluded.updated_at_unix",
            params![
                key_id,
                policy.allow_consensus,
                policy.allow_raw,
                policy.allow_transfer,
                policy.allow_contract_call,
                policy.allow_global_scope,
                encode_hashes(&policy.contract_whitelist),
                encode_hashes(&policy.contract_blacklist),
                contract_method_whitelist,
                contract_method_blacklist,
                encode_hashes(&policy.asset_whitelist),
                encode_hashes(&policy.asset_blacklist),
                encode_hashes(&policy.transfer_to_whitelist),
                encode_hashes(&policy.transfer_to_blacklist),
                policy.max_single_amount.map(|amount| amount.to_string()),
                window_seconds,
                window_max_amount,
                policy.max_signers,
                policy.max_system_fee,
                policy.max_network_fee,
                signature_window_seconds,
                signature_window_count,
                asset_limits,
                policy.chain_family.map(|family| family.to_string()),
                policy.evm_max_gas_price.map(|value| value.to_string()),
                evm_max_gas_limit,
                evm_method_whitelist,
                evm_method_blacklist,
                evm_chain_id,
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
                "SELECT allow_consensus, allow_raw, allow_transfer, allow_contract_call,
                        allow_global_scope,
                        contract_whitelist, contract_blacklist,
                        contract_method_whitelist, contract_method_blacklist,
                        asset_whitelist, asset_blacklist,
                        transfer_to_whitelist, transfer_to_blacklist, max_single_amount,
                        window_seconds, window_max_amount, max_signers, max_system_fee,
                        max_network_fee, signature_window_seconds, signature_window_count,
                        asset_limits, chain_family, evm_max_gas_price, evm_max_gas_limit,
                        evm_method_whitelist, evm_method_blacklist, evm_chain_id
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

/// Method pairs are JSON arrays of `[display_hash, method]` tuples. Unlike the
/// legacy separator used by hash-only lists, JSON keeps every UTF-8 method
/// name unambiguous.
fn encode_contract_methods(methods: &[ContractMethod]) -> Result<String> {
    let rows = methods
        .iter()
        .map(|entry| (entry.contract.to_display(), entry.method.as_str()))
        .collect::<Vec<_>>();
    serde_json::to_string(&rows).context("failed to encode contract method policy")
}

/// Asset limits are JSON tuples of display hash, optional single ceiling,
/// optional window seconds, and optional window ceiling. Decimal strings retain
/// the full `i128` range.
fn encode_asset_limits(limits: &[crate::model::AssetLimit]) -> Result<String> {
    let rows = limits
        .iter()
        .map(|entry| {
            (
                entry.asset.to_display(),
                entry.max_single_amount.map(|amount| amount.to_string()),
                entry.window_limit.map(|window| window.seconds),
                entry
                    .window_limit
                    .map(|window| window.max_amount.to_string()),
            )
        })
        .collect::<Vec<_>>();
    serde_json::to_string(&rows).context("failed to encode asset-specific limits")
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
