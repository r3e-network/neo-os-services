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

use crate::model::{ScriptHash, SignerPolicy};
use crate::tx::{ConsensusPayload, Intent, Scope, UnsignedTransaction, HASH160_LEN};

/// The dBFT consensus payload category. Anything else is a generic
/// application message wearing a consensus request, and signing it would put
/// this key's committee reputation behind traffic the policy knows nothing
/// about.
pub const CONSENSUS_CATEGORY: &str = "dBFT";

/// What a caller is asking this key to sign, already decoded.
#[derive(Debug, Clone, Copy)]
pub enum SigningRequest<'a> {
    /// A transaction; `intents` must be the intents [`UnsignedTransaction`]
    /// decoded from it, so the policy decides on the same bytes the signature
    /// will cover.
    Transaction {
        /// The decoded, unsigned transaction.
        transaction: &'a UnsignedTransaction,
        /// Its calls, folded into transfers and calls.
        intents: &'a [Intent],
    },
    /// A consensus (extensible) payload.
    Consensus {
        /// The decoded, unsigned payload.
        payload: &'a ConsensusPayload,
    },
}

/// Value that has already left the key inside the policy window.
///
/// The service builds this from the audit log, which is the only place the
/// truth survives a restart.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WindowSpend {
    per_asset: BTreeMap<[u8; HASH160_LEN], i128>,
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
}

impl DenyReason {
    /// Stable identifier for responses and audit rows.
    pub fn code(self) -> &'static str {
        match self {
            DenyReason::ConsensusForbidden => "consensus-forbidden",
            DenyReason::ConsensusCategoryForbidden => "consensus-category-forbidden",
            DenyReason::ConsensusSenderMismatch => "consensus-sender-mismatch",
            DenyReason::TransferForbidden => "transfer-forbidden",
            DenyReason::ContractCallForbidden => "contract-call-forbidden",
            DenyReason::NotASigner => "not-a-signer",
            DenyReason::GlobalScopeForbidden => "global-scope-forbidden",
            DenyReason::DelegationMissing => "delegation-missing",
            DenyReason::ContractBlacklisted => "contract-blacklisted",
            DenyReason::ContractNotWhitelisted => "contract-not-whitelisted",
            DenyReason::AssetBlacklisted => "asset-blacklisted",
            DenyReason::AssetNotWhitelisted => "asset-not-whitelisted",
            DenyReason::RecipientBlacklisted => "recipient-blacklisted",
            DenyReason::RecipientNotWhitelisted => "recipient-not-whitelisted",
            DenyReason::SourceMismatch => "source-mismatch",
            DenyReason::NegativeAmount => "negative-amount",
            DenyReason::SingleAmountExceeded => "single-amount-exceeded",
            DenyReason::WindowAmountExceeded => "window-amount-exceeded",
        }
    }
}

impl fmt::Display for DenyReason {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            DenyReason::ConsensusForbidden => "consensus signatures are not allowed for this key",
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
            DenyReason::AssetBlacklisted => "the token contract is blacklisted",
            DenyReason::AssetNotWhitelisted => "the token contract is not whitelisted",
            DenyReason::RecipientBlacklisted => "the recipient is blacklisted",
            DenyReason::RecipientNotWhitelisted => "the recipient is not whitelisted",
            DenyReason::SourceMismatch => "the transfer moves tokens that are not this key's",
            DenyReason::NegativeAmount => "the transfer moves a negative amount",
            DenyReason::SingleAmountExceeded => "the transfer exceeds the per-transfer ceiling",
            DenyReason::WindowAmountExceeded => "the transfer exceeds the window ceiling",
        };
        f.write_str(message)
    }
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
        SigningRequest::Transaction {
            transaction,
            intents,
        } => evaluate_transaction(policy, key_account, transaction, intents, spent),
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
    None
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
