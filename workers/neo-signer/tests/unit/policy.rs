//! Every rule the custody gate can apply, exercised directly.
//!
//! The engine is pure, so these tests are the whole decision surface: no
//! database, no keys, no network. Each one names the failure it is guarding
//! against, because a policy engine that "agrees with itself" is exactly how a
//! ceiling ends up enforcing nothing.

use std::collections::HashSet;

use super::*;
use crate::model::{AssetLimit, ContractMethod, WindowLimit};
use crate::tx::{Scope, Signer};

const GAS: u8 = 0xa1;
const NEO: u8 = 0xa2;
const TOKEN: u8 = 0xa3;
const VICTIM: u8 = 0xa4;
const RECEIVER: u8 = 0xb1;
const FORBIDDEN: u8 = 0xb2;
const KEY: u8 = 0xc0;

fn account(marker: u8) -> ScriptHash {
    ScriptHash::from_wire([marker; 20])
}

fn signer(marker: u8, scope: u8, allowed: &[u8]) -> Signer {
    Signer {
        account: [marker; 20],
        scope: Scope(scope),
        allowed_contracts: allowed.iter().copied().map(|byte| [byte; 20]).collect(),
        allowed_groups: Vec::new(),
    }
}

fn transaction_with(signers: Vec<Signer>) -> UnsignedTransaction {
    UnsignedTransaction {
        version: 0,
        nonce: 1,
        system_fee: 0,
        network_fee: 0,
        valid_until_block: 1_000,
        signers,
        attributes: Vec::new(),
        script: vec![0x11],
    }
}

fn transfer(asset: u8, from: u8, to: u8, amount: i128) -> Intent {
    Intent::Transfer {
        asset: [asset; 20],
        from: [from; 20],
        to: [to; 20],
        amount,
    }
}

fn call(contract: u8, method: &str) -> Intent {
    Intent::ContractCall {
        contract: [contract; 20],
        method: method.to_string(),
        flags: 15,
    }
}

fn entry(key: u8) -> Vec<Signer> {
    vec![signer(key, Scope::CALLED_BY_ENTRY, &[])]
}

fn transaction(key: u8) -> UnsignedTransaction {
    transaction_with(entry(key))
}

fn check(policy: &SignerPolicy, key: u8, intents: &[Intent], tx: &UnsignedTransaction) -> Verdict {
    evaluate(
        policy,
        account(key),
        &SigningRequest::Transaction {
            transaction: tx,
            intents,
        },
        &WindowSpend::new(),
    )
}

fn consensus(policy: &SignerPolicy, key: u8, category: &str, sender: u8) -> Verdict {
    evaluate(
        policy,
        account(key),
        &SigningRequest::Consensus {
            payload: &ConsensusPayload {
                category: category.to_string(),
                valid_block_start: 100,
                valid_block_end: 102,
                sender: [sender; 20],
                data: vec![0x01],
            },
        },
        &WindowSpend::new(),
    )
}

/// The reason a verdict refused, panicking on an approval so each expectation
/// reads as "this request is denied for exactly this reason".
fn denied(verdict: Verdict) -> (DenyReason, String) {
    match verdict {
        Verdict::Deny { reason, detail } => (reason, detail),
        Verdict::Allow => unreachable!("expected a refusal"),
    }
}

fn policy_allowing(consensus: bool, transfer: bool, call: bool) -> SignerPolicy {
    SignerPolicy {
        allow_consensus: consensus,
        allow_transfer: transfer,
        allow_contract_call: call,
        ..Default::default()
    }
}

#[test]
fn an_unconfigured_policy_signs_nothing() {
    let policy = SignerPolicy::default();
    let tx = transaction(KEY);

    let (reason, _) = denied(check(&policy, KEY, &[transfer(GAS, KEY, RECEIVER, 1)], &tx));
    assert_eq!(reason, DenyReason::TransferForbidden);

    let (reason, _) = denied(check(&policy, KEY, &[call(TOKEN, "swap")], &tx));
    assert_eq!(reason, DenyReason::ContractCallForbidden);

    for category in ["dBFT", "neofs"] {
        let (reason, _) = denied(consensus(&policy, KEY, category, KEY));
        assert_eq!(reason, DenyReason::ConsensusForbidden, "for {category}");
    }
}

#[test]
fn a_key_that_is_not_a_signer_is_refused_however_harmless_the_request_looks() {
    // Signing a transaction this account is not a signer of would pay for
    // somebody else's transfer with this key, and the node would accept it.
    let policy = policy_allowing(false, true, false);
    let tx = transaction(VICTIM);
    let (reason, detail) = denied(check(
        &policy,
        KEY,
        &[transfer(GAS, VICTIM, RECEIVER, 1)],
        &tx,
    ));
    assert_eq!(reason, DenyReason::NotASigner);
    assert!(
        detail.contains(&account(VICTIM).to_string()),
        "the audit has to say whose transaction it was: {detail}"
    );
}

#[test]
fn a_transfer_needs_the_transfer_switch_and_not_the_call_switch() {
    // Every transfer is a contract call on the wire. If the call gate also
    // applied, `allow_transfer` would let nothing through on its own and an
    // operator turning on payments would have to open arbitrary calls too.
    let policy = policy_allowing(false, true, false);
    let tx = transaction(KEY);
    assert!(check(&policy, KEY, &[transfer(GAS, KEY, RECEIVER, 1)], &tx).is_allowed());
}

#[test]
fn a_call_is_refused_without_its_switch_even_when_whitelisted() {
    let policy = SignerPolicy {
        contract_whitelist: vec![account(TOKEN)],
        ..Default::default()
    };
    let tx = transaction(KEY);
    let (reason, _) = denied(check(&policy, KEY, &[call(TOKEN, "swap")], &tx));
    assert_eq!(reason, DenyReason::ContractCallForbidden);
}

#[test]
fn a_whitelist_blocks_everything_it_does_not_name() {
    let policy = SignerPolicy {
        allow_contract_call: true,
        contract_whitelist: vec![account(TOKEN)],
        ..Default::default()
    };
    let tx = transaction(KEY);
    assert!(check(&policy, KEY, &[call(TOKEN, "swap")], &tx).is_allowed());
    let (reason, detail) = denied(check(&policy, KEY, &[call(FORBIDDEN, "swap")], &tx));
    assert_eq!(reason, DenyReason::ContractNotWhitelisted);
    assert!(detail.contains(&account(FORBIDDEN).to_string()), "{detail}");
}

#[test]
fn an_empty_whitelist_means_unrestricted_not_closed() {
    // The reading people disagree on, so it is pinned: no entries means "no
    // list", and the only way nothing is allowed is the operation switch.
    let policy = policy_allowing(false, false, true);
    let tx = transaction(KEY);
    assert!(check(&policy, KEY, &[call(FORBIDDEN, "anything")], &tx).is_allowed());
}

#[test]
fn a_blacklist_wins_over_the_whitelist() {
    let policy = SignerPolicy {
        allow_contract_call: true,
        contract_whitelist: vec![account(FORBIDDEN)],
        contract_blacklist: vec![account(FORBIDDEN)],
        ..Default::default()
    };
    let tx = transaction(KEY);
    let (reason, _) = denied(check(&policy, KEY, &[call(FORBIDDEN, "swap")], &tx));
    assert_eq!(reason, DenyReason::ContractBlacklisted);
}

#[test]
fn method_lists_bind_the_exact_contract_and_method_pair() {
    let allowed = ContractMethod {
        contract: account(TOKEN),
        method: "swap".to_string(),
    };
    let tx = transaction(KEY);
    let policy = SignerPolicy {
        allow_contract_call: true,
        contract_method_whitelist: vec![allowed.clone()],
        ..Default::default()
    };
    assert!(check(&policy, KEY, &[call(TOKEN, "swap")], &tx).is_allowed());
    let (reason, _) = denied(check(&policy, KEY, &[call(TOKEN, "mint")], &tx));
    assert_eq!(reason, DenyReason::ContractMethodNotWhitelisted);
    let (reason, _) = denied(check(&policy, KEY, &[call(FORBIDDEN, "swap")], &tx));
    assert_eq!(reason, DenyReason::ContractMethodNotWhitelisted);

    let denied_pair = SignerPolicy {
        contract_method_blacklist: vec![allowed],
        ..policy
    };
    let (reason, _) = denied(check(&denied_pair, KEY, &[call(TOKEN, "swap")], &tx));
    assert_eq!(reason, DenyReason::ContractMethodBlacklisted);
}

#[test]
fn signer_count_and_fee_ceilings_are_enforced_before_calls() {
    let policy = SignerPolicy {
        allow_contract_call: true,
        max_signers: Some(1),
        max_system_fee: Some(10),
        max_network_fee: Some(20),
        ..Default::default()
    };
    let intents = [call(TOKEN, "swap")];
    let too_many = transaction_with(vec![
        signer(KEY, Scope::CALLED_BY_ENTRY, &[]),
        signer(VICTIM, Scope::CALLED_BY_ENTRY, &[]),
    ]);
    let (reason, _) = denied(check(&policy, KEY, &intents, &too_many));
    assert_eq!(reason, DenyReason::TooManySigners);

    let mut expensive_system = transaction(KEY);
    expensive_system.system_fee = 11;
    let (reason, _) = denied(check(&policy, KEY, &intents, &expensive_system));
    assert_eq!(reason, DenyReason::SystemFeeExceeded);

    let mut expensive_network = transaction(KEY);
    expensive_network.network_fee = 21;
    let (reason, _) = denied(check(&policy, KEY, &intents, &expensive_network));
    assert_eq!(reason, DenyReason::NetworkFeeExceeded);
}

#[test]
fn a_token_contract_is_governed_by_both_the_contract_lists_and_the_asset_lists() {
    let tx = transaction(KEY);

    let blacklisted_asset = SignerPolicy {
        allow_transfer: true,
        asset_blacklist: vec![account(GAS)],
        ..Default::default()
    };
    let (reason, _) = denied(check(
        &blacklisted_asset,
        KEY,
        &[transfer(GAS, KEY, RECEIVER, 1)],
        &tx,
    ));
    assert_eq!(reason, DenyReason::AssetBlacklisted);

    let unlisted_asset = SignerPolicy {
        allow_transfer: true,
        asset_whitelist: vec![account(NEO)],
        ..Default::default()
    };
    let (reason, _) = denied(check(
        &unlisted_asset,
        KEY,
        &[transfer(GAS, KEY, RECEIVER, 1)],
        &tx,
    ));
    assert_eq!(reason, DenyReason::AssetNotWhitelisted);

    // Blacklisting a contract has to reach its transfers: an operator who
    // fenced a contract off cannot have meant "except to move its tokens".
    let blacklisted_contract = SignerPolicy {
        allow_transfer: true,
        contract_blacklist: vec![account(GAS)],
        ..Default::default()
    };
    let (reason, _) = denied(check(
        &blacklisted_contract,
        KEY,
        &[transfer(GAS, KEY, RECEIVER, 1)],
        &tx,
    ));
    assert_eq!(reason, DenyReason::ContractBlacklisted);
}

#[test]
fn recipients_are_gated_in_both_directions() {
    let tx = transaction(KEY);
    let policy = SignerPolicy {
        allow_transfer: true,
        transfer_to_whitelist: vec![account(RECEIVER)],
        transfer_to_blacklist: vec![account(RECEIVER)],
        ..Default::default()
    };
    let (reason, _) = denied(check(&policy, KEY, &[transfer(GAS, KEY, RECEIVER, 1)], &tx));
    assert_eq!(reason, DenyReason::RecipientBlacklisted);

    let policy = SignerPolicy {
        allow_transfer: true,
        transfer_to_whitelist: vec![account(RECEIVER)],
        ..Default::default()
    };
    let (reason, _) = denied(check(
        &policy,
        KEY,
        &[transfer(GAS, KEY, FORBIDDEN, 1)],
        &tx,
    ));
    assert_eq!(reason, DenyReason::RecipientNotWhitelisted);
    assert!(check(&policy, KEY, &[transfer(GAS, KEY, RECEIVER, 1)], &tx).is_allowed());
}

#[test]
fn a_transfer_must_move_this_keys_own_tokens() {
    // `from` is the account whose witness the transfer needs, so a `from` that
    // is not this key means the caller is asking us to pay for somebody else —
    // and any ceiling here was written against the wrong balance.
    let policy = policy_allowing(false, true, false);
    let tx = transaction(KEY);
    let (reason, detail) = denied(check(
        &policy,
        KEY,
        &[transfer(GAS, VICTIM, RECEIVER, 1)],
        &tx,
    ));
    assert_eq!(reason, DenyReason::SourceMismatch);
    assert!(detail.contains(&account(VICTIM).to_string()), "{detail}");
}

#[test]
fn a_negative_amount_is_refused_before_any_ceiling() {
    let policy = SignerPolicy {
        allow_transfer: true,
        max_single_amount: Some(100),
        ..Default::default()
    };
    let tx = transaction(KEY);
    let (reason, _) = denied(check(
        &policy,
        KEY,
        &[transfer(GAS, KEY, RECEIVER, -500)],
        &tx,
    ));
    assert_eq!(
        reason,
        DenyReason::NegativeAmount,
        "a negative transfer would add money back to a window it is supposed to drain"
    );
}

#[test]
fn the_per_transfer_ceiling_binds_one_payment() {
    let policy = SignerPolicy {
        allow_transfer: true,
        max_single_amount: Some(1_000),
        ..Default::default()
    };
    let tx = transaction(KEY);
    assert!(
        check(&policy, KEY, &[transfer(GAS, KEY, RECEIVER, 1_000)], &tx).is_allowed(),
        "the ceiling itself is reachable"
    );
    let (reason, detail) = denied(check(
        &policy,
        KEY,
        &[transfer(GAS, KEY, RECEIVER, 1_001)],
        &tx,
    ));
    assert_eq!(reason, DenyReason::SingleAmountExceeded);
    assert!(
        detail.contains("1001") && detail.contains("1000"),
        "{detail}"
    );
}

#[test]
fn a_batch_is_measured_as_it_accumulates() {
    // Four 25-unit payments inside a 60-unit window must fail on the third:
    // the ceiling is about what leaves the key, not about the largest line in
    // one script.
    let policy = SignerPolicy {
        allow_transfer: true,
        window_limit: Some(WindowLimit {
            seconds: 3_600,
            max_amount: 60,
        }),
        ..Default::default()
    };
    let tx = transaction(KEY);
    let batch: Vec<Intent> = (0..4)
        .map(|index| transfer(GAS, KEY, RECEIVER + index, 25))
        .collect();
    let (reason, detail) = denied(check(&policy, KEY, &batch, &tx));
    assert_eq!(reason, DenyReason::WindowAmountExceeded);
    assert!(
        detail.contains("75"),
        "the total that broke the ceiling: {detail}"
    );

    let within = SignerPolicy {
        allow_transfer: true,
        window_limit: Some(WindowLimit {
            seconds: 3_600,
            max_amount: 75,
        }),
        ..Default::default()
    };
    assert!(check(&within, KEY, &batch[..3], &tx).is_allowed());
}

#[test]
fn the_window_tracks_each_token_on_its_own() {
    // Raw units are not comparable between tokens, so a NEO payment cannot
    // consume a GAS budget — and a shared counter would deny unrelated work.
    let policy = SignerPolicy {
        allow_transfer: true,
        window_limit: Some(WindowLimit {
            seconds: 3_600,
            max_amount: 100,
        }),
        ..Default::default()
    };
    let tx = transaction(KEY);
    let intents = [
        transfer(GAS, KEY, RECEIVER, 90),
        transfer(NEO, KEY, RECEIVER, 90),
    ];
    assert!(
        check(&policy, KEY, &intents, &tx).is_allowed(),
        "different tokens, different budgets"
    );
    let same_token = [
        transfer(GAS, KEY, RECEIVER, 90),
        transfer(GAS, KEY, RECEIVER, 90),
    ];
    assert_eq!(
        denied(check(&policy, KEY, &same_token, &tx)).0,
        DenyReason::WindowAmountExceeded
    );
}

#[test]
fn spend_already_inside_the_window_counts_against_the_ceiling() {
    let policy = SignerPolicy {
        allow_transfer: true,
        window_limit: Some(WindowLimit {
            seconds: 3_600,
            max_amount: 100,
        }),
        ..Default::default()
    };
    let tx = transaction(KEY);
    let request = SigningRequest::Transaction {
        transaction: &tx,
        intents: &[transfer(GAS, KEY, RECEIVER, 40)],
    };
    let mut spent = WindowSpend::new();
    assert!(evaluate(&policy, account(KEY), &request, &spent).is_allowed());
    spent.record(account(GAS), 70);
    let (reason, detail) = denied(evaluate(&policy, account(KEY), &request, &spent));
    assert_eq!(reason, DenyReason::WindowAmountExceeded);
    assert!(detail.contains("110"), "{detail}");
}

#[test]
fn window_accounting_saturates_instead_of_wrapping() {
    // A wrapped total would read as "nothing spent this window" and disarm the
    // ceiling permanently after enough traffic.
    let mut spent = WindowSpend::new();
    spent.record(account(GAS), i128::MAX);
    spent.record(account(GAS), i128::MAX);
    assert_eq!(spent.amount(account(GAS)), i128::MAX);
    assert_eq!(
        spent.amount(account(NEO)),
        0,
        "untracked assets start at zero"
    );
}

#[test]
fn a_global_witness_needs_its_own_permission() {
    let intents = [transfer(GAS, KEY, RECEIVER, 1)];
    let global = transaction_with(vec![signer(KEY, Scope::GLOBAL, &[])]);
    let policy = policy_allowing(false, true, false);
    let (reason, detail) = denied(check(&policy, KEY, &intents, &global));
    assert_eq!(reason, DenyReason::GlobalScopeForbidden);
    assert!(detail.contains("every contract"), "{detail}");

    let allowed = SignerPolicy {
        allow_transfer: true,
        allow_global_scope: true,
        ..Default::default()
    };
    assert!(check(&allowed, KEY, &intents, &global).is_allowed());
}

#[test]
fn a_delegated_scope_must_cover_the_contracts_being_called() {
    let intents = [transfer(GAS, KEY, RECEIVER, 1)];
    let policy = policy_allowing(false, true, false);

    let missing = transaction_with(vec![signer(KEY, Scope::CUSTOM_CONTRACTS, &[TOKEN])]);
    let (reason, detail) = denied(check(&policy, KEY, &intents, &missing));
    assert_eq!(reason, DenyReason::DelegationMissing);
    assert!(detail.contains(&account(GAS).to_string()), "{detail}");

    let covered = transaction_with(vec![signer(KEY, Scope::CUSTOM_CONTRACTS, &[GAS])]);
    assert!(check(&policy, KEY, &intents, &covered).is_allowed());
}

#[test]
fn consensus_is_gated_on_permission_category_and_sender() {
    let allowed = policy_allowing(true, false, false);
    assert!(consensus(&allowed, KEY, CONSENSUS_CATEGORY, KEY).is_allowed());

    let (reason, _) = denied(consensus(&allowed, KEY, "neofs", KEY));
    assert_eq!(
        reason,
        DenyReason::ConsensusCategoryForbidden,
        "signing an arbitrary extensible payload is not consensus work"
    );

    let (reason, _) = denied(consensus(&allowed, KEY, CONSENSUS_CATEGORY, VICTIM));
    assert_eq!(
        reason,
        DenyReason::ConsensusSenderMismatch,
        "a committee member's signature has to be its own"
    );
}

#[test]
fn raw_signing_is_refused_until_its_own_switch_is_opened() {
    // Raw bytes commit to nothing the lists can describe — no transfer, no
    // contract, no sender — so no other switch can open this lane and none of
    // them should: it has its own, and it starts closed.
    let policy = policy_allowing(true, true, true);
    let (reason, detail) = denied(evaluate(
        &policy,
        account(KEY),
        &SigningRequest::Raw,
        &WindowSpend::new(),
    ));
    assert_eq!(reason, DenyReason::RawForbidden);
    assert!(detail.contains("raw"), "{detail}");

    let mut open = policy;
    open.allow_raw = true;
    assert!(evaluate(
        &open,
        account(KEY),
        &SigningRequest::Raw,
        &WindowSpend::new()
    )
    .is_allowed());
}

#[test]
fn one_refusal_in_a_request_refuses_the_whole_request() {
    // Partial approval is not a thing: a signature covers the transaction, so
    // the one benign call cannot be signed while the forbidden one rides with
    // it.
    let policy = SignerPolicy {
        allow_transfer: true,
        allow_contract_call: true,
        contract_blacklist: vec![account(FORBIDDEN)],
        ..Default::default()
    };
    let tx = transaction(KEY);
    let intents = [transfer(GAS, KEY, RECEIVER, 1), call(FORBIDDEN, "swap")];
    assert_eq!(
        denied(check(&policy, KEY, &intents, &tx)).0,
        DenyReason::ContractBlacklisted
    );
}

#[test]
fn every_reason_has_a_unique_code() {
    let reasons = [
        DenyReason::ConsensusForbidden,
        DenyReason::ConsensusCategoryForbidden,
        DenyReason::ConsensusSenderMismatch,
        DenyReason::TransferForbidden,
        DenyReason::ContractCallForbidden,
        DenyReason::RawForbidden,
        DenyReason::NotASigner,
        DenyReason::GlobalScopeForbidden,
        DenyReason::DelegationMissing,
        DenyReason::ContractBlacklisted,
        DenyReason::ContractNotWhitelisted,
        DenyReason::AssetBlacklisted,
        DenyReason::AssetNotWhitelisted,
        DenyReason::RecipientBlacklisted,
        DenyReason::RecipientNotWhitelisted,
        DenyReason::SourceMismatch,
        DenyReason::NegativeAmount,
        DenyReason::SingleAmountExceeded,
        DenyReason::WindowAmountExceeded,
        DenyReason::TooManySigners,
        DenyReason::SystemFeeExceeded,
        DenyReason::NetworkFeeExceeded,
        DenyReason::SignatureRateExceeded,
        DenyReason::AssetSingleAmountExceeded,
        DenyReason::AssetWindowAmountExceeded,
    ];
    let codes: HashSet<&str> = reasons.iter().map(|reason| reason.code()).collect();
    assert_eq!(
        codes.len(),
        reasons.len(),
        "codes are an API; two must not collide"
    );
    for reason in reasons {
        assert!(
            !reason.to_string().is_empty(),
            "{reason:?} needs an operator-facing message"
        );
    }
}

#[test]
fn asset_specific_single_and_multiple_window_ceilings_all_apply() {
    let policy = SignerPolicy {
        asset_limits: vec![
            AssetLimit {
                asset: account(NEO),
                max_single_amount: Some(5),
                window_limit: Some(WindowLimit {
                    seconds: 60,
                    max_amount: 10,
                }),
            },
            AssetLimit {
                asset: account(NEO),
                max_single_amount: None,
                window_limit: Some(WindowLimit {
                    seconds: 3_600,
                    max_amount: 100,
                }),
            },
        ],
        ..Default::default()
    };
    let mut spent = AssetWindowSpend::new();
    spent.record(account(NEO), 60, 7);
    spent.record(account(NEO), 3_600, 90);

    assert_eq!(
        denied(evaluate_asset_limits(
            &policy,
            &[transfer(NEO, KEY, RECEIVER, 6)],
            &spent,
        ))
        .0,
        DenyReason::AssetSingleAmountExceeded
    );
    assert_eq!(
        denied(evaluate_asset_limits(
            &policy,
            &[
                transfer(NEO, KEY, RECEIVER, 2),
                transfer(NEO, KEY, RECEIVER, 2),
            ],
            &spent,
        ))
        .0,
        DenyReason::AssetWindowAmountExceeded,
        "the batch must accumulate against the shorter matching window"
    );
    assert!(
        evaluate_asset_limits(&policy, &[transfer(GAS, KEY, RECEIVER, i128::MAX)], &spent,)
            .is_allowed(),
        "a limit for one token must not change another token"
    );
}

#[test]
fn signature_rate_counts_prior_successes_and_closes_at_the_ceiling() {
    let policy = SignerPolicy {
        max_signatures: Some(crate::model::SignatureRateLimit {
            seconds: 60,
            count: 2,
        }),
        ..Default::default()
    };
    assert_eq!(evaluate_signature_rate(&policy, 0), Verdict::Allow);
    assert_eq!(evaluate_signature_rate(&policy, 1), Verdict::Allow);
    assert_eq!(
        denied(evaluate_signature_rate(&policy, 2)).0,
        DenyReason::SignatureRateExceeded
    );
}
