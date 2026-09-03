//! The gate between "a caller asked" and "this key may sign".
//!
//! [`evaluate`] is pure: it takes a policy, the account the key controls, what
//! the request turns out to mean, and how much value has already left the key
//! inside the policy's window. Nothing here touches the database, a key, or the
//! network, which is what makes the whole decision surface testable — and the
//! decision surface is the part of a custody service that has to be right.
//!
//! Three rules carry most of the safety, and each exists because the obvious
//! alternative fails in a specific way:
//!
//! * **The key must be a signer on the transaction.** Otherwise a caller could
//!   use a signature bought for one account to pay for another's, and the
//!   node would accept it.
//! * **`Global` scope is refused unless explicitly allowed.** Contract and
//!   asset lists describe the script in front of us; a global witness can be
//!   replayed by any contract that later gets hold of it, so signing one is a
//!   decision about the key, not about this transaction.
//! * **A transfer's `from` must be this key's own account.** Otherwise the
//!   witness we produce is being offered to move somebody else's tokens, and
//!   every amount ceiling in the policy was written against the wrong balance.
//!
//! Rules are checked in the order the design document sets: operation type,
//! then contract and asset scope, then recipients, then the per-transfer
//! ceiling, then the rolling window. The first failure is returned with a
//! reason an operator can act on.

use std::collections::BTreeMap;
use std::fmt;

use crate::evm_tx::{EvmIntent, UnsignedEvmTransaction};
use crate::model::{ContractMethod, ScriptHash, SignerPolicy};
use crate::tx::{ConsensusPayload, Intent, Scope, UnsignedTransaction, HASH160_LEN};

/// The dBFT consensus payload category. Anything else is a generic
/// application message wearing a consensus request, and signing it would put
/// this key's committee reputation behind traffic the policy knows nothing
/// about.
pub const CONSENSUS_CATEGORY: &str = "dBFT";

/// What a caller is asking this key to sign, already decoded.
#[derive(Debug, Clone, Copy)]
pub enum SigningRequest<'a> {
    /// A Neo N3 transaction; `intents` must be the intents [`UnsignedTransaction`]
    /// decoded from it, so the policy decides on the same bytes the signature
    /// will cover.
    Transaction {
        /// The decoded, unsigned transaction.
        transaction: &'a UnsignedTransaction,
        /// Its calls, folded into transfers and calls.
        intents: &'a [Intent],
    },
    /// An EVM (NeoX) transaction.
    EvmTransaction {
        /// The decoded, unsigned EVM transaction.
        transaction: &'a UnsignedEvmTransaction,
        /// What the transaction intends to do.
        intent: &'a EvmIntent,
    },
    /// A consensus (extensible) payload.
    Consensus {
        /// The decoded, unsigned payload.
        payload: &'a ConsensusPayload,
    },
    /// Unstructured caller bytes. There is nothing to decode, which is
    /// exactly why the boundary switch governing it is a separate one: the
    /// lists below describe transactions, and a raw signature lets none of
    /// them speak.
    Raw,
}

/// Value that has already left the key inside the policy window.
///
/// The service builds this from the audit log, which is the only place the
/// truth survives a restart.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WindowSpend {
    per_asset: BTreeMap<[u8; HASH160_LEN], i128>,
}

/// Prior value charged to each asset-specific rolling period.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AssetWindowSpend {
    per_window: BTreeMap<(ScriptHash, u64), i128>,
}

impl AssetWindowSpend {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn record(&mut self, asset: ScriptHash, seconds: u64, amount: i128) {
        let entry = self.per_window.entry((asset, seconds)).or_insert(0);
        *entry = entry.saturating_add(amount);
    }

    pub fn amount(&self, asset: ScriptHash, seconds: u64) -> i128 {
        self.per_window.get(&(asset, seconds)).copied().unwrap_or(0)
    }

    pub fn contains(&self, asset: ScriptHash, seconds: u64) -> bool {
        self.per_window.contains_key(&(asset, seconds))
    }
}

impl WindowSpend {
    /// An empty window.
    pub fn new() -> Self {
        Self::default()
    }

    /// Add `amount` moved of `asset`. Saturates rather than wrapping: a
    /// wrapped total would disarm the ceiling it is supposed to enforce.
    pub fn record(&mut self, asset: ScriptHash, amount: i128) {
        let entry = self.per_asset.entry(asset.as_bytes()).or_insert(0);
        *entry = entry.saturating_add(amount);
    }

    /// How much of `asset` has already been counted.
    pub fn amount(&self, asset: ScriptHash) -> i128 {
        self.per_asset.get(&asset.as_bytes()).copied().unwrap_or(0)
    }
}

/// The outcome, with the detail an operator needs when it is a refusal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    /// Sign it.
    Allow,
    /// Do not sign it, and say why in a form the caller and the audit log can
    /// both use.
    Deny {
        /// Stable machine-readable reason.
        reason: DenyReason,
        /// Human-readable specifics, naming the contract, account and amount.
        detail: String,
    },
}

impl Verdict {
    pub fn is_allowed(&self) -> bool {
        matches!(self, Verdict::Allow)
    }
}

/// Every way a request can be refused, and the only ways the policy engine can
/// answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DenyReason {
    /// `allow_consensus` is off.
    ConsensusForbidden,
    /// `allow_raw` is off — the default, so an unconfigured key refuses raw
    /// signing without any policy row existing.
    RawForbidden,
    /// The payload is not a dBFT round.
    ConsensusCategoryForbidden,
    /// The payload is from a different committee member than this key.
    ConsensusSenderMismatch,
    /// `allow_transfer` is off.
    TransferForbidden,
    /// `allow_contract_call` is off.
    ContractCallForbidden,
    /// This key's account is not among the transaction's signers.
    NotASigner,
    /// The signer entry carries `Global` scope and `allow_global_scope` is off.
    GlobalScopeForbidden,
    /// The signer entry delegates by contract list, and the contract being
    /// called is not in it — the witness would not validate, so signing is
    /// pointless as well as unbounded.
    DelegationMissing,
    /// The called contract is blacklisted.
    ContractBlacklisted,
    /// A whitelist exists and the called contract is not in it.
    ContractNotWhitelisted,
    /// The exact contract and method pair is blacklisted.
    ContractMethodBlacklisted,
    /// A method whitelist exists and the exact pair is not in it.
    ContractMethodNotWhitelisted,
    /// The token contract is blacklisted.
    AssetBlacklisted,
    /// An asset whitelist exists and the token is not in it.
    AssetNotWhitelisted,
    /// The recipient is blacklisted.
    RecipientBlacklisted,
    /// A recipient whitelist exists and the recipient is not in it.
    RecipientNotWhitelisted,
    /// The transfer's `from` is not this key's account.
    SourceMismatch,
    /// The script moves a negative amount.
    NegativeAmount,
    /// The transfer is larger than `max_single_amount`.
    SingleAmountExceeded,
    /// This transfer, on top of the window so far, passes `window_limit`.
    WindowAmountExceeded,
    /// The transaction carries more signer entries than this key permits.
    TooManySigners,
    /// The transaction's system fee is above the configured ceiling.
    SystemFeeExceeded,
    /// The transaction's network fee is above the configured ceiling.
    NetworkFeeExceeded,
    /// The key already produced its allowed signatures inside the rolling
    /// period.
    SignatureRateExceeded,
    /// One transfer exceeds a ceiling scoped to its token contract.
    AssetSingleAmountExceeded,
    /// The token contract has exhausted one of its rolling value periods.
    AssetWindowAmountExceeded,
    /// EVM transaction gas price exceeds policy limit.
    EvmGasPriceExceeded,
    /// EVM transaction gas limit exceeds policy limit.
    EvmGasLimitExceeded,
    /// EVM contract method selector is blacklisted.
    EvmMethodBlacklisted,
    /// EVM contract method selector not in whitelist.
    EvmMethodNotWhitelisted,
    /// EVM chain ID doesn't match expected value.
    EvmInvalidChainId,
}

impl DenyReason {
    /// Stable identifier for responses and audit rows.
    pub fn code(self) -> &'static str {
        match self {
            DenyReason::ConsensusForbidden => "consensus-forbidden",
            DenyReason::RawForbidden => "raw-forbidden",
            DenyReason::ConsensusCategoryForbidden => "consensus-category-forbidden",
            DenyReason::ConsensusSenderMismatch => "consensus-sender-mismatch",
            DenyReason::TransferForbidden => "transfer-forbidden",
            DenyReason::ContractCallForbidden => "contract-call-forbidden",
            DenyReason::NotASigner => "not-a-signer",
            DenyReason::GlobalScopeForbidden => "global-scope-forbidden",
            DenyReason::DelegationMissing => "delegation-missing",
            DenyReason::ContractBlacklisted => "contract-blacklisted",
            DenyReason::ContractNotWhitelisted => "contract-not-whitelisted",
            DenyReason::ContractMethodBlacklisted => "contract-method-blacklisted",
            DenyReason::ContractMethodNotWhitelisted => "contract-method-not-whitelisted",
            DenyReason::AssetBlacklisted => "asset-blacklisted",
            DenyReason::AssetNotWhitelisted => "asset-not-whitelisted",
            DenyReason::RecipientBlacklisted => "recipient-blacklisted",
            DenyReason::RecipientNotWhitelisted => "recipient-not-whitelisted",
            DenyReason::SourceMismatch => "source-mismatch",
            DenyReason::NegativeAmount => "negative-amount",
            DenyReason::SingleAmountExceeded => "single-amount-exceeded",
            DenyReason::WindowAmountExceeded => "window-amount-exceeded",
            DenyReason::TooManySigners => "too-many-signers",
            DenyReason::SystemFeeExceeded => "system-fee-exceeded",
            DenyReason::NetworkFeeExceeded => "network-fee-exceeded",
            DenyReason::SignatureRateExceeded => "signature-rate-exceeded",
            DenyReason::AssetSingleAmountExceeded => "asset-single-amount-exceeded",
            DenyReason::AssetWindowAmountExceeded => "asset-window-amount-exceeded",
            DenyReason::EvmGasPriceExceeded => "evm-gas-price-exceeded",
            DenyReason::EvmGasLimitExceeded => "evm-gas-limit-exceeded",
            DenyReason::EvmMethodBlacklisted => "evm-method-blacklisted",
            DenyReason::EvmMethodNotWhitelisted => "evm-method-not-whitelisted",
            DenyReason::EvmInvalidChainId => "evm-invalid-chain-id",
        }
    }
}

impl fmt::Display for DenyReason {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            DenyReason::ConsensusForbidden => "consensus signatures are not allowed for this key",
            DenyReason::RawForbidden => "raw signatures are not allowed for this key",
            DenyReason::ConsensusCategoryForbidden => {
                "only dBFT consensus payloads can be signed as consensus"
            }
            DenyReason::ConsensusSenderMismatch => {
                "the consensus payload is from another committee member"
            }
            DenyReason::TransferForbidden => "transfers are not allowed for this key",
            DenyReason::ContractCallForbidden => "contract calls are not allowed for this key",
            DenyReason::NotASigner => "this key is not a signer on the transaction",
            DenyReason::GlobalScopeForbidden => {
                "the transaction asks for a global-scope witness from this key"
            }
            DenyReason::DelegationMissing => {
                "the witness scope for this key does not delegate to the contract being called"
            }
            DenyReason::ContractBlacklisted => "the contract is blacklisted",
            DenyReason::ContractNotWhitelisted => "the contract is not whitelisted",
            DenyReason::ContractMethodBlacklisted => "the contract method is blacklisted",
            DenyReason::ContractMethodNotWhitelisted => "the contract method is not whitelisted",
            DenyReason::AssetBlacklisted => "the token contract is blacklisted",
            DenyReason::AssetNotWhitelisted => "the token contract is not whitelisted",
            DenyReason::RecipientBlacklisted => "the recipient is blacklisted",
            DenyReason::RecipientNotWhitelisted => "the recipient is not whitelisted",
            DenyReason::SourceMismatch => "the transfer moves tokens that are not this key's",
            DenyReason::NegativeAmount => "the transfer moves a negative amount",
            DenyReason::SingleAmountExceeded => "the transfer exceeds the per-transfer ceiling",
            DenyReason::WindowAmountExceeded => "the transfer exceeds the window ceiling",
            DenyReason::TooManySigners => "the transaction has more signers than this key permits",
            DenyReason::SystemFeeExceeded => "the transaction exceeds the system-fee ceiling",
            DenyReason::NetworkFeeExceeded => "the transaction exceeds the network-fee ceiling",
            DenyReason::SignatureRateExceeded => {
                "the key has reached its rolling signature-rate ceiling"
            }
            DenyReason::AssetSingleAmountExceeded => {
                "the transfer exceeds its asset-specific per-transfer ceiling"
            }
            DenyReason::AssetWindowAmountExceeded => {
                "the transfer exceeds an asset-specific rolling ceiling"
            }
            DenyReason::EvmGasPriceExceeded => "the EVM transaction gas price exceeds the ceiling",
            DenyReason::EvmGasLimitExceeded => "the EVM transaction gas limit exceeds the ceiling",
            DenyReason::EvmMethodBlacklisted => "the EVM contract method selector is blacklisted",
            DenyReason::EvmMethodNotWhitelisted => {
                "the EVM contract method selector is not whitelisted"
            }
            DenyReason::EvmInvalidChainId => "the EVM transaction chain ID doesn't match expected value",
        };
        f.write_str(message)
    }
}

/// Apply the key-wide signature-rate gate after the request's operation policy
/// has passed and before private key material is opened.
pub fn evaluate_signature_rate(policy: &SignerPolicy, signatures_in_window: u64) -> Verdict {
    let Some(limit) = policy.max_signatures else {
        return Verdict::Allow;
    };
    if signatures_in_window >= limit.count {
        return deny(
            DenyReason::SignatureRateExceeded,
            format!(
                "key produced {signatures_in_window} signature(s) in the last {} second(s), reaching the ceiling of {}",
                limit.seconds, limit.count
            ),
        );
    }
    Verdict::Allow
}

/// Apply every ceiling scoped to the token contract after the shared transfer
/// rules have accepted the complete request.
pub fn evaluate_asset_limits(
    policy: &SignerPolicy,
    intents: &[Intent],
    spent: &AssetWindowSpend,
) -> Verdict {
    let mut accepted = BTreeMap::<ScriptHash, i128>::new();
    for intent in intents {
        let Intent::Transfer { asset, amount, .. } = intent else {
            continue;
        };
        let asset = ScriptHash(*asset);
        for limit in policy
            .asset_limits
            .iter()
            .filter(|limit| limit.asset == asset)
        {
            if let Some(ceiling) = limit.max_single_amount {
                if *amount > ceiling {
                    return deny(
                        DenyReason::AssetSingleAmountExceeded,
                        format!(
                            "transfer of {amount} {asset} exceeds its asset-specific per-transfer ceiling of {ceiling}"
                        ),
                    );
                }
            }
            if let Some(window) = limit.window_limit {
                let before_request = spent.amount(asset, window.seconds);
                let inside_request = accepted.get(&asset).copied().unwrap_or(0);
                let after = before_request
                    .saturating_add(inside_request)
                    .saturating_add(*amount);
                if after > window.max_amount {
                    return deny(
                        DenyReason::AssetWindowAmountExceeded,
                        format!(
                            "transfer would bring {asset} to {after} in {} seconds, above its asset-specific ceiling of {}",
                            window.seconds, window.max_amount
                        ),
                    );
                }
            }
        }
        let entry = accepted.entry(asset).or_insert(0);
        *entry = entry.saturating_add(*amount);
    }
    Verdict::Allow
}

/// Decide whether `policy` lets `key_account` sign `request`.
///
/// `spent` carries what has already left the key within the policy's window;
/// transfers inside this one request are added to it as they are checked, so a
/// batch of four payments is measured as four payments rather than one.
pub fn evaluate(
    policy: &SignerPolicy,
    key_account: ScriptHash,
    request: &SigningRequest<'_>,
    spent: &WindowSpend,
) -> Verdict {
    match request {
        SigningRequest::Consensus { payload } => evaluate_consensus(policy, key_account, payload),
        SigningRequest::Raw => {
            if policy.allow_raw {
                Verdict::Allow
            } else {
                deny(
                    DenyReason::RawForbidden,
                    format!("{key_account} asked to sign raw bytes"),
                )
            }
        }
        SigningRequest::Transaction {
            transaction,
            intents,
        } => evaluate_transaction(policy, key_account, transaction, intents, spent),
        SigningRequest::EvmTransaction {
            transaction,
            intent,
        } => evaluate_evm_transaction(policy, key_account, transaction, intent, spent),
    }
}

fn evaluate_consensus(
    policy: &SignerPolicy,
    key_account: ScriptHash,
    payload: &ConsensusPayload,
) -> Verdict {
    if !policy.allow_consensus {
        return deny(
            DenyReason::ConsensusForbidden,
            format!(
                "{} asked to sign a {} consensus payload",
                key_account, payload.category
            ),
        );
    }
    if payload.category != CONSENSUS_CATEGORY {
        return deny(
            DenyReason::ConsensusCategoryForbidden,
            format!(
                "payload category {:?} is not {:?}",
                payload.category, CONSENSUS_CATEGORY
            ),
        );
    }
    if ScriptHash(payload.sender) != key_account {
        return deny(
            DenyReason::ConsensusSenderMismatch,
            format!(
                "payload sender {} is not this key {}",
                ScriptHash(payload.sender),
                key_account
            ),
        );
    }
    Verdict::Allow
}

fn evaluate_transaction(
    policy: &SignerPolicy,
    key_account: ScriptHash,
    transaction: &UnsignedTransaction,
    intents: &[Intent],
    spent: &WindowSpend,
) -> Verdict {
    let Some(signer) = transaction
        .signers
        .iter()
        .find(|signer| ScriptHash(signer.account) == key_account)
    else {
        let signers: Vec<String> = transaction
            .signers
            .iter()
            .map(|signer| ScriptHash(signer.account).to_string())
            .collect();
        return deny(
            DenyReason::NotASigner,
            format!(
                "key {key_account} is not among the signers [{}]",
                signers.join(", ")
            ),
        );
    };

    if signer.scope.is_global() {
        if !policy.allow_global_scope {
            return deny(
                DenyReason::GlobalScopeForbidden,
                format!(
                    "the witness for {key_account} would be valid for every contract, not only the {} called here",
                    intents.len()
                ),
            );
        }
    } else {
        // A `CalledByEntry` witness is bounded by the entry script, which is
        // what the intents describe. A `CustomContracts` witness is bounded by
        // its own list, and that list has to cover every contract used below
        // or the node will reject the witness we produce.
        if signer.scope.has(Scope::CUSTOM_CONTRACTS) {
            if let Some(contract) = undelegated_contract(&signer.allowed_contracts, intents) {
                return deny(
                    DenyReason::DelegationMissing,
                    format!(
                        "the witness for {key_account} delegates to {} contract(s), which do not include {contract}",
                        signer.allowed_contracts.len()
                    ),
                );
            }
        }
    }

    if let Some(max_signers) = policy.max_signers {
        if transaction.signers.len() > usize::from(max_signers) {
            return deny(
                DenyReason::TooManySigners,
                format!(
                    "transaction has {} signer(s), over the ceiling of {max_signers}",
                    transaction.signers.len()
                ),
            );
        }
    }
    if let Some(ceiling) = policy.max_system_fee {
        if transaction.system_fee > ceiling {
            return deny(
                DenyReason::SystemFeeExceeded,
                format!(
                    "system fee {} exceeds the ceiling of {ceiling}",
                    transaction.system_fee
                ),
            );
        }
    }
    if let Some(ceiling) = policy.max_network_fee {
        if transaction.network_fee > ceiling {
            return deny(
                DenyReason::NetworkFeeExceeded,
                format!(
                    "network fee {} exceeds the ceiling of {ceiling}",
                    transaction.network_fee
                ),
            );
        }
    }

    let mut counted = spent.clone();
    for intent in intents {
        let verdict = match intent {
            Intent::Transfer {
                asset,
                from,
                to,
                amount,
            } => evaluate_transfer(
                policy,
                key_account,
                ScriptHash(*asset),
                ScriptHash(*from),
                ScriptHash(*to),
                *amount,
                &mut counted,
            ),
            Intent::ContractCall {
                contract, method, ..
            } => evaluate_call(policy, ScriptHash(*contract), method),
        };
        if !verdict.is_allowed() {
            return verdict;
        }
    }
    Verdict::Allow
}

/// The first contract the intents use that `allowed` does not delegate to.
fn undelegated_contract(allowed: &[[u8; HASH160_LEN]], intents: &[Intent]) -> Option<ScriptHash> {
    intents.iter().find_map(|intent| {
        let contract = match intent {
            Intent::Transfer { asset, .. } => *asset,
            Intent::ContractCall { contract, .. } => *contract,
        };
        (!allowed.contains(&contract)).then_some(ScriptHash(contract))
    })
}

fn evaluate_call(policy: &SignerPolicy, contract: ScriptHash, method: &str) -> Verdict {
    if !policy.allow_contract_call {
        return deny(
            DenyReason::ContractCallForbidden,
            format!("call {contract}.{method} is not allowed for this key"),
        );
    }
    if let Some(verdict) = check_contract(policy, contract, method) {
        return verdict;
    }
    Verdict::Allow
}

fn evaluate_transfer(
    policy: &SignerPolicy,
    key_account: ScriptHash,
    asset: ScriptHash,
    from: ScriptHash,
    to: ScriptHash,
    amount: i128,
    counted: &mut WindowSpend,
) -> Verdict {
    if !policy.allow_transfer {
        return deny(
            DenyReason::TransferForbidden,
            format!("transfer of {amount} {asset} from {from} to {to} is not allowed for this key"),
        );
    }
    // The token contract is a contract call like any other, so the contract
    // lists bound it too: an operator who blacklists a contract means it, even
    // when the request looks like a plain payment.
    if let Some(verdict) = check_contract(policy, asset, "transfer") {
        return verdict;
    }
    if policy.asset_blacklist.contains(&asset) {
        return deny(
            DenyReason::AssetBlacklisted,
            format!("token {asset} is blacklisted"),
        );
    }
    if !policy.asset_whitelist.is_empty() && !policy.asset_whitelist.contains(&asset) {
        return deny(
            DenyReason::AssetNotWhitelisted,
            format!("token {asset} is not in the asset whitelist"),
        );
    }
    if from != key_account {
        return deny(
            DenyReason::SourceMismatch,
            format!("transfer names {from} as the source, but this key is {key_account}"),
        );
    }
    if amount < 0 {
        return deny(
            DenyReason::NegativeAmount,
            format!("transfer of {amount} {asset} to {to} is negative"),
        );
    }
    if policy.transfer_to_blacklist.contains(&to) {
        return deny(
            DenyReason::RecipientBlacklisted,
            format!("recipient {to} is blacklisted"),
        );
    }
    if !policy.transfer_to_whitelist.is_empty() && !policy.transfer_to_whitelist.contains(&to) {
        return deny(
            DenyReason::RecipientNotWhitelisted,
            format!("recipient {to} is not in the recipient whitelist"),
        );
    }
    if let Some(ceiling) = policy.max_single_amount {
        if amount > ceiling {
            return deny(
                DenyReason::SingleAmountExceeded,
                format!(
                    "transfer of {amount} {asset} exceeds the per-transfer ceiling of {ceiling}"
                ),
            );
        }
    }
    if let Some(limit) = policy.window_limit {
        let already = counted.amount(asset);
        let total = already.saturating_add(amount);
        if total > limit.max_amount {
            return deny(
                DenyReason::WindowAmountExceeded,
                format!(
                    "transfer of {amount} {asset} would move {total} within {}s, over the ceiling of {}",
                    limit.seconds, limit.max_amount
                ),
            );
        }
    }
    counted.record(asset, amount);
    Verdict::Allow
}

/// Contract list checks shared by calls and by token transfers.
fn check_contract(policy: &SignerPolicy, contract: ScriptHash, method: &str) -> Option<Verdict> {
    if policy.contract_blacklist.contains(&contract) {
        return Some(deny(
            DenyReason::ContractBlacklisted,
            format!("contract {contract} ({method}) is blacklisted"),
        ));
    }
    if !policy.contract_whitelist.is_empty() && !policy.contract_whitelist.contains(&contract) {
        return Some(deny(
            DenyReason::ContractNotWhitelisted,
            format!("contract {contract} ({method}) is not in the contract whitelist"),
        ));
    }
    let exact = ContractMethod {
        contract,
        method: method.to_string(),
    };
    if policy.contract_method_blacklist.contains(&exact) {
        return Some(deny(
            DenyReason::ContractMethodBlacklisted,
            format!("contract method {contract}.{method} is blacklisted"),
        ));
    }
    if !policy.contract_method_whitelist.is_empty()
        && !policy.contract_method_whitelist.contains(&exact)
    {
        return Some(deny(
            DenyReason::ContractMethodNotWhitelisted,
            format!("contract method {contract}.{method} is not in the method whitelist"),
        ));
    }
    None
}

fn evaluate_evm_transaction(
    policy: &SignerPolicy,
    _key_account: ScriptHash,
    transaction: &UnsignedEvmTransaction,
    intent: &EvmIntent,
    spent: &WindowSpend,
) -> Verdict {
    // Check gas price limit
    if let Some(max_gas_price) = policy.evm_max_gas_price {
        if transaction.max_fee_per_gas > max_gas_price {
            return deny(
                DenyReason::EvmGasPriceExceeded,
                format!(
                    "gas price {} exceeds limit {}",
                    transaction.max_fee_per_gas, max_gas_price
                ),
            );
        }
    }

    // Check gas limit
    if let Some(max_gas_limit) = policy.evm_max_gas_limit {
        if transaction.gas_limit > max_gas_limit {
            return deny(
                DenyReason::EvmGasLimitExceeded,
                format!(
                    "gas limit {} exceeds limit {}",
                    transaction.gas_limit, max_gas_limit
                ),
            );
        }
    }

    // Evaluate intent-specific checks
    match intent {
        EvmIntent::NativeTransfer { to, value } => {
            if !policy.allow_transfer {
                return deny(
                    DenyReason::TransferForbidden,
                    "EVM native transfers are not allowed".to_string(),
                );
            }
            // Check recipient whitelist/blacklist
            let to_hash = ScriptHash(*to);
            if let Some(verdict) = check_recipient(policy, to_hash) {
                return verdict;
            }
            // Check amount limits
            let amount = u256_to_i128(value);
            if let Some(verdict) = check_transfer_amount(policy, amount, spent, to_hash) {
                return verdict;
            }
            Verdict::Allow
        }
        EvmIntent::Erc20Transfer { token, to, amount } => {
            if !policy.allow_transfer {
                return deny(
                    DenyReason::TransferForbidden,
                    "ERC-20 transfers are not allowed".to_string(),
                );
            }
            // Check token contract whitelist/blacklist
            let token_hash = ScriptHash(*token);
            if policy.asset_blacklist.contains(&token_hash) {
                return deny(
                    DenyReason::AssetBlacklisted,
                    format!("ERC-20 token contract {} is blacklisted", token_hash),
                );
            }
            if !policy.asset_whitelist.is_empty()
                && !policy.asset_whitelist.contains(&token_hash)
            {
                return deny(
                    DenyReason::AssetNotWhitelisted,
                    format!(
                        "ERC-20 token contract {} is not in the asset whitelist",
                        token_hash
                    ),
                );
            }
            // Check recipient
            let to_hash = ScriptHash(*to);
            if let Some(verdict) = check_recipient(policy, to_hash) {
                return verdict;
            }
            // Check amount limits
            let transfer_amount = u256_to_i128(amount);
            if let Some(verdict) = check_transfer_amount(policy, transfer_amount, spent, to_hash) {
                return verdict;
            }
            Verdict::Allow
        }
        EvmIntent::ContractCall { to, data, .. } => {
            if !policy.allow_contract_call {
                return deny(
                    DenyReason::ContractCallForbidden,
                    "EVM contract calls are not allowed".to_string(),
                );
            }
            // Check contract whitelist/blacklist
            let contract_hash = ScriptHash(*to);
            if policy.contract_blacklist.contains(&contract_hash) {
                return deny(
                    DenyReason::ContractBlacklisted,
                    format!("EVM contract {} is blacklisted", contract_hash),
                );
            }
            if !policy.contract_whitelist.is_empty()
                && !policy.contract_whitelist.contains(&contract_hash)
            {
                return deny(
                    DenyReason::ContractNotWhitelisted,
                    format!("EVM contract {} is not in the contract whitelist", contract_hash),
                );
            }
            // Check method selector (first 4 bytes) if data exists
            if data.len() >= 4 {
                let method_selector = hex::encode(&data[0..4]);
                if policy.evm_method_blacklist.contains(&method_selector) {
                    return deny(
                        DenyReason::EvmMethodBlacklisted,
                        format!("EVM method selector 0x{} is blacklisted", method_selector),
                    );
                }
                if !policy.evm_method_whitelist.is_empty()
                    && !policy.evm_method_whitelist.contains(&method_selector)
                {
                    return deny(
                        DenyReason::EvmMethodNotWhitelisted,
                        format!(
                            "EVM method selector 0x{} is not in the method whitelist",
                            method_selector
                        ),
                    );
                }
            }
            Verdict::Allow
        }
    }
}

fn check_recipient(policy: &SignerPolicy, recipient: ScriptHash) -> Option<Verdict> {
    if policy.transfer_to_blacklist.contains(&recipient) {
        return Some(deny(
            DenyReason::RecipientBlacklisted,
            format!("recipient {} is blacklisted", recipient),
        ));
    }
    if !policy.transfer_to_whitelist.is_empty() && !policy.transfer_to_whitelist.contains(&recipient) {
        return Some(deny(
            DenyReason::RecipientNotWhitelisted,
            format!("recipient {} is not in the recipient whitelist", recipient),
        ));
    }
    None
}

fn check_transfer_amount(
    policy: &SignerPolicy,
    amount: i128,
    spent: &WindowSpend,
    _recipient: ScriptHash,
) -> Option<Verdict> {
    if amount < 0 {
        return Some(deny(
            DenyReason::NegativeAmount,
            format!("transfer amount {} is negative", amount),
        ));
    }
    // Check single transfer limit
    if let Some(max_single) = policy.max_single_amount {
        if amount > max_single {
            return Some(deny(
                DenyReason::SingleAmountExceeded,
                format!("transfer amount {} exceeds single limit {}", amount, max_single),
            ));
        }
    }
    // Check window limit (simplified - would need asset-specific tracking)
    if let Some(window_limit) = &policy.window_limit {
        // For EVM native transfers, we use a fixed "native" asset identifier
        let native_asset = ScriptHash([0u8; 20]);
        let already_spent = spent.amount(native_asset);
        let new_total = already_spent.saturating_add(amount);
        if new_total > window_limit.max_amount {
            return Some(deny(
                DenyReason::WindowAmountExceeded,
                format!(
                    "transfer {} + prior {} = {} exceeds window limit {}",
                    amount, already_spent, new_total, window_limit.max_amount
                ),
            ));
        }
    }
    None
}

fn u256_to_i128(bytes: &[u8; 32]) -> i128 {
    // Convert u256 to i128, taking the lower 16 bytes
    let mut buf = [0u8; 16];
    buf.copy_from_slice(&bytes[16..32]);
    i128::from_be_bytes(buf)
}

fn deny(reason: DenyReason, detail: impl Into<String>) -> Verdict {
    Verdict::Deny {
        reason,
        detail: detail.into(),
    }
}

#[cfg(test)]
#[path = "../tests/unit/policy.rs"]
mod tests;
